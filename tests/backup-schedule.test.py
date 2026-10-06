#!/usr/bin/env python3
"""Scheduler ownership, paired retention and failure checks; no real database."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("backup_schedule", ROOT / "deploy/backup-schedule.py")
schedule = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(schedule)
NOW = datetime(2026, 10, 6, 2, tzinfo=timezone.utc)


def fake_pair(config, name):
    for role in ("database", "material"):
        (config[role] / name).mkdir(mode=0o700)
    for role, filename in (("database", "database.dump.aesgcm"), ("material", "materials.aesgcm")):
        path = config[role] / name / filename
        path.write_bytes((role + ":synthetic-owned-encrypted-fixture").encode())
        path.chmod(0o600)
        manifest = {"schema_version": 1, "archive": filename, "archive_sha256": schedule.digest(path),
                    "id": name, "encryption": "AES-256-GCM", "database_backup_id": name}
        path = config[role] / name / ("backup.json" if role == "database" else "materials.json")
        path.write_text(json.dumps(manifest))
        path.chmod(0o600)


class BackupScheduleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = {"RAINSYNC_BACKUP_SOURCE_COMMIT": "a" * 40}
        for role in ("database", "material", "state"):
            path = self.root / role
            path.mkdir(mode=0o700)
            self.env["RAINSYNC_BACKUP_" + role.upper() + "_ROOT"] = str(path)
        for key in ("RAINSYNC_BACKUP_KEY_FILE", "RAINSYNC_MATERIAL_KEY_FILE", "RAINSYNC_RECOVERY_INPUT_FILE"):
            path = self.root / key
            path.write_bytes(b"synthetic-private-fixture")
            path.chmod(0o600)
            self.env[key] = str(path)
        self.config = schedule.settings(self.env)

    def tearDown(self):
        self.temp.cleanup()

    def backup(self, now):
        def runner(command, **options):
            self.assertEqual(command[:3], ["node", str(schedule.ROOT / "recovery-set.mjs"), "backup"])
            name = Path(command[3].split("=", 1)[1]).name
            fake_pair(self.config, name)
            return SimpleNamespace(returncode=0)
        return schedule.run_backup(self.config, self.env, runner=runner, now=now)

    def test_roots_refuse_nested_linked_or_public_destinations(self):
        env = dict(self.env, RAINSYNC_BACKUP_MATERIAL_ROOT=str(self.config["database"]))
        with self.assertRaisesRegex(ValueError, "distinct"):
            schedule.settings(env)
        nested = self.config["database"] / "child"
        nested.mkdir(mode=0o700)
        env["RAINSYNC_BACKUP_MATERIAL_ROOT"] = str(nested)
        with self.assertRaisesRegex(ValueError, "nonnested"):
            schedule.settings(env)
        link = self.root / "linked"
        link.symlink_to(self.config["material"], target_is_directory=True)
        env["RAINSYNC_BACKUP_MATERIAL_ROOT"] = str(link)
        with self.assertRaisesRegex(ValueError, "nonlinked"):
            schedule.settings(env)
        self.config["state"].chmod(0o755)
        with self.assertRaisesRegex(ValueError, "private"):
            schedule.settings(self.env)

    def test_failed_backup_never_records_success_or_prunes_old_sets(self):
        existing = self.backup(NOW - timedelta(days=30))
        with self.assertRaisesRegex(ValueError, "failed"):
            schedule.run_backup(self.config, self.env, now=NOW, runner=lambda *a, **kw: SimpleNamespace(returncode=1))
        self.assertTrue((self.config["database"] / existing["name"]).is_dir())
        self.assertEqual(len(schedule.receipts(self.config)), 1)

    def test_status_uses_conservative_snapshot_start_and_reports_overdue(self):
        self.assertEqual(schedule.status(self.config, now=NOW)["result"], "overdue")
        self.backup(NOW - timedelta(hours=23))
        status = schedule.status(self.config, now=NOW)
        self.assertEqual(status["result"], "passed")
        self.assertEqual(status["recovery_point_age_seconds"], 23 * 3600)
        self.assertFalse(status["production_recovery_accepted"])
        self.assertEqual(schedule.status(self.config, now=NOW + timedelta(hours=2))["result"], "overdue")

    def test_retention_previews_preserves_two_newest_and_ignores_unowned_sets(self):
        old = self.backup(NOW - timedelta(days=40))
        self.backup(NOW - timedelta(days=30))
        self.backup(NOW - timedelta(days=20))
        foreign = self.config["database"] / "operator-owned"
        foreign.mkdir(mode=0o700)
        preview = schedule.prune(self.config, now=NOW)
        self.assertEqual(preview["sets"], [old["name"]])
        self.assertTrue((self.config["database"] / old["name"]).exists())
        applied = schedule.prune(self.config, apply=True, now=NOW)
        self.assertEqual(applied["sets"], preview["sets"])
        self.assertFalse((self.config["material"] / old["name"]).exists())
        self.assertTrue(foreign.is_dir())
        self.assertEqual(len(schedule.receipts(self.config)), 2)

    def test_corrupt_or_linked_archive_cannot_be_deleted_by_retention(self):
        old = self.backup(NOW - timedelta(days=40))
        self.backup(NOW - timedelta(days=30))
        self.backup(NOW - timedelta(days=20))
        path = self.config["material"] / old["name"] / "materials.aesgcm"
        original = path.read_bytes()
        path.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "content changed"):
            schedule.prune(self.config, apply=True, now=NOW)
        self.assertTrue((self.config["database"] / old["name"]).exists())
        path.unlink()
        target = self.root / "private-unrelated"
        target.write_bytes(original)
        target.chmod(0o600)
        path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "nonlinked"):
            schedule.prune(self.config, apply=True, now=NOW)
        self.assertTrue(target.exists())

    def test_lock_rejects_concurrent_backup_and_retention(self):
        with schedule.locked(self.config):
            with self.assertRaises(BlockingIOError):
                with schedule.locked(self.config):
                    self.fail("concurrent scheduler admitted")


if __name__ == "__main__":
    unittest.main(verbosity=2)
