#!/usr/bin/env python3
"""Explicitly installed daily recovery sets; retention is preview-only without --apply.

Only complete, hash-checked pairs owned by this scheduler may be pruned. The
driver never installs a scheduler, restores a database, or changes services.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
NAME = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{32}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def private_path(value, *, directory=False):
    path = Path(value)
    require(path.is_absolute() and not path.is_symlink(), "absolute, nonlinked private path required")
    info = path.stat()
    require(info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0, "backup paths must be owned by the scheduler user and private")
    require(path.is_dir() if directory else path.is_file(), "backup path has the wrong type")
    return path.resolve(strict=True)


def settings(env):
    roots = {role: private_path(env["RAINSYNC_BACKUP_" + role.upper() + "_ROOT"], directory=True)
             for role in ("database", "material", "state")}
    for first in roots.values():
        for second in roots.values():
            if first != second:
                require(first not in second.parents, "backup roots must be separate, nonnested directories")
    require(len(set(roots.values())) == 3, "backup roots must be distinct")
    days = int(env.get("RAINSYNC_BACKUP_RETENTION_DAYS", "14"))
    require(7 <= days <= 366, "retention must be between 7 and 366 days")
    return {**roots, "retention_days": days}


@contextmanager
def locked(config):
    descriptor = os.open(config["state"] / "scheduler.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def read_json(path):
    require(path.stat().st_size <= 65536, "oversized scheduler metadata")
    return json.loads(path.read_text())


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def pair(config, name):
    require(NAME.fullmatch(name), "invalid scheduler backup identity")
    directories = {role: private_path(str(config[role] / name), directory=True)
                   for role in ("database", "material")}
    database = read_json(private_path(str(directories["database"] / "backup.json")))
    material = read_json(private_path(str(directories["material"] / "materials.json")))
    require(database.get("schema_version") == material.get("schema_version") == 1, "unsupported recovery manifest")
    require(database.get("encryption") == "AES-256-GCM" and database.get("archive") == "database.dump.aesgcm"
            and material.get("archive") == "materials.aesgcm", "unexpected recovery archive")
    require(database.get("id") and material.get("database_backup_id") == database["id"], "database/material pair mismatch")
    for role, manifest in (("database", database), ("material", material)):
        require(set(item.name for item in directories[role].iterdir()) == {manifest["archive"], "backup.json" if role == "database" else "materials.json"},
                "backup directory contains unexpected files; preserve it")
        expected = manifest.get("archive_sha256", "")
        require(SHA.fullmatch(expected) and digest(private_path(str(directories[role] / manifest["archive"]))) == expected,
                "backup content changed; preserve it")
    return {"database_backup_id": database["id"], "database_sha256": database["archive_sha256"],
            "material_sha256": material["archive_sha256"]}


def receipts(config):
    result = []
    for entry in sorted(config["state"].iterdir()):
        if not entry.name.endswith(".json") or not NAME.fullmatch(entry.stem):
            continue
        receipt = read_json(private_path(str(entry)))
        require(receipt.get("schema_version") == 1 and receipt.get("name") == entry.stem and receipt.get("result") == "passed",
                "invalid complete scheduler receipt; preserve all backups")
        require(receipt.get("archives") == pair(config, entry.stem), "scheduler receipt/content mismatch")
        instant(receipt["recovery_point"])
        result.append(receipt)
    return sorted(result, key=lambda item: instant(item["recovery_point"]), reverse=True)


def instant(value):
    date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(date.tzinfo is not None, "recovery time must include its time zone")
    return date


def run_backup(config, env, *, runner=subprocess.run, now=None):
    now = now or datetime.now(timezone.utc)
    require(re.fullmatch(r"[0-9a-f]{40}", env.get("RAINSYNC_BACKUP_SOURCE_COMMIT", "")), "exact installed source commit is required")
    for key in ("RAINSYNC_BACKUP_KEY_FILE", "RAINSYNC_MATERIAL_KEY_FILE", "RAINSYNC_RECOVERY_INPUT_FILE"):
        private_path(env[key])
    name = now.strftime("%Y%m%dT%H%M%SZ-") + uuid4().hex
    command = ["node", str(ROOT / "recovery-set.mjs"), "backup",
               "--database=" + str(config["database"] / name), "--materials=" + str(config["material"] / name)]
    # The underlying tool holds libpq credentials in environment variables.
    # Never relay child output, a DSN, keys, or application materials to logs.
    completed = runner(command, env=dict(env), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3900)
    require(completed.returncode == 0, "daily recovery-set backup failed; no complete receipt or retention applied")
    receipt = {"schema_version": 1, "name": name, "result": "passed", "archives": pair(config, name),
               "source_commit": env["RAINSYNC_BACKUP_SOURCE_COMMIT"], "recovery_point": now.isoformat(),
               "finished_at": datetime.now(timezone.utc).isoformat(), "production_recovery_accepted": False}
    with os.fdopen(os.open(config["state"] / (name + ".json"), os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600), "w") as handle:
        json.dump(receipt, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    return {"result": "passed", "name": name, "recovery_point": receipt["recovery_point"], "production_recovery_accepted": False}


def prune(config, *, apply=False, now=None):
    now = now or datetime.now(timezone.utc)
    complete = receipts(config)
    cutoff = now - timedelta(days=config["retention_days"])
    # Retain at least the two newest successful sets, even if all are old.
    selected = [item for item in complete[2:] if instant(item["recovery_point"]) < cutoff]
    if apply:
        for item in selected:
            name = item["name"]
            require(item["archives"] == pair(config, name), "backup changed during retention review")
            # No recursive remover: only the four exact verified owned files.
            for role, files in (("database", ("database.dump.aesgcm", "backup.json")), ("material", ("materials.aesgcm", "materials.json"))):
                directory = config[role] / name
                for filename in files:
                    (directory / filename).unlink()
                directory.rmdir()
            (config["state"] / (name + ".json")).unlink()
    return {"result": "passed", "apply": apply, "retention_days": config["retention_days"], "sets": [item["name"] for item in selected]}


def status(config, *, now=None):
    now = now or datetime.now(timezone.utc)
    complete = receipts(config)
    age = (now - instant(complete[0]["recovery_point"])).total_seconds() if complete else None
    return {"result": "passed" if age is not None and 0 <= age <= 24 * 3600 else "overdue", "recovery_point_age_seconds": age,
            "complete_sets": len(complete), "production_recovery_accepted": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("run", "prune", "status"))
    parser.add_argument("--apply", action="store_true", help="explicitly delete owned complete sets selected by prune")
    args = parser.parse_args()
    require(not args.apply or args.mode == "prune", "--apply is only valid for prune")
    os.umask(0o077)
    config = settings(os.environ)
    with locked(config):
        result = run_backup(config, os.environ) if args.mode == "run" else prune(config, apply=args.apply) if args.mode == "prune" else status(config)
    print(json.dumps(result, indent=2))
    return 0 if result["result"] == "passed" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        print("Backup scheduling failed; inspect private configuration, backup roots and PostgreSQL access. No successful recovery claim accepted.", file=sys.stderr)
        sys.exit(1)
