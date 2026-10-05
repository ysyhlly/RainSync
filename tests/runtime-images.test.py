#!/usr/bin/env python3
"""Offline deployment artifact checks; no Docker, network or application mutation."""
import copy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("runtime_images", ROOT / "deploy/runtime-images.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)
SOURCE = "a" * 40


def fixture(directory, config_path_style="classic"):
    images, saved, contents = {}, [], {}
    for role, tag in runtime.tags(SOURCE).items():
        labels = {"org.opencontainers.image.revision": SOURCE} if role != "postgres" else {}
        config = json.dumps({"os": "linux", "architecture": "amd64", "config": {"Labels": labels}, "rootfs": {"type": "layers", "diff_ids": []}}).encode()
        digest = hashlib.sha256(config).hexdigest()
        name = digest + ".json" if config_path_style == "classic" else "blobs/sha256/" + digest
        contents[name] = config
        images[role] = {"tag": tag, "image_id": "sha256:" + digest, "repo_tags": [tag],
                        "repo_digests": ["postgres@sha256:" + "b" * 64] if role == "postgres" else [],
                        "os": "linux", "architecture": "amd64", "size_bytes": 1024 * 1024,
                        "source_revision": SOURCE if role != "postgres" else None}
        # Give backend and web distinct measured content IDs.
        if role == "web":
            config = json.dumps({"os": "linux", "architecture": "amd64", "config": {"Labels": labels}, "role": "web"}).encode()
            digest = hashlib.sha256(config).hexdigest()
            name = digest + ".json" if config_path_style == "classic" else "blobs/sha256/" + digest
            contents[name] = config
            images[role]["image_id"] = "sha256:" + digest
        saved.append({"Config": name, "RepoTags": [tag], "Layers": []})
    contents["manifest.json"] = json.dumps(saved).encode()
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as archive:
        for name, value in contents.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(value)
            archive.addfile(entry, io.BytesIO(value))
    path = directory / runtime.ARCHIVE_NAME
    path.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
    manifest = {"schema_version": 1, "source_commit": SOURCE, "platform": "linux/amd64", "images": images,
                "total_image_size_bytes": 3 * 1024 * 1024,
                "runtime_checks": {"server_login": runtime.LOGIN_CONTRACT, "server_source": runtime.source_contract("server"),
                                   "worker_source": runtime.source_contract("worker"), "web_config": "passed",
                                   "ffmpeg": {"encode": "passed", "probe": "passed", "decode": "passed", "codec": "h264", "width": 64, "height": 64}},
                "archive": {"file": runtime.ARCHIVE_NAME, "sha256": runtime.sha_file(path), "size_bytes": path.stat().st_size,
                            "uncompressed_size_bytes": len(raw.getvalue())}}
    return manifest


class RuntimeArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.manifest = fixture(self.directory)

    def tearDown(self):
        self.temp.cleanup()

    def reject(self, edit, message):
        value = copy.deepcopy(self.manifest)
        edit(value)
        with self.assertRaisesRegex(ValueError, message):
            runtime.validate_manifest(value, SOURCE)

    def test_exact_manifest_and_both_docker_config_path_layouts(self):
        for layout in ("classic", "oci"):
            value = fixture(self.directory, layout)
            runtime.validate_manifest(value, SOURCE)
            result = runtime.verify_archive(self.directory / runtime.ARCHIVE_NAME, value)
            self.assertEqual(result["result"], "passed")
            self.assertEqual(result["source_commit"], SOURCE)

    def test_wrong_source_and_unbound_tag_fail_closed(self):
        self.reject(lambda m: m.update(source_commit="c" * 40), "source commit")
        self.reject(lambda m: m["images"]["backend"].update(tag="rainsync-backend:latest"), "tag mismatch")
        self.reject(lambda m: m["images"]["web"].update(source_revision="c" * 40), "source revision")

    def test_wrong_architecture_fails_closed(self):
        self.reject(lambda m: m.update(platform="linux/arm64"), "architecture")
        self.reject(lambda m: m["images"]["postgres"].update(architecture="arm64"), "architecture")

    def test_wrong_image_identity_fails_closed(self):
        self.reject(lambda m: m["images"]["backend"].update(image_id="rainsync:dev"), "image ID")
        value = copy.deepcopy(self.manifest)
        value["images"]["backend"]["image_id"] = "sha256:" + "d" * 64
        runtime.validate_manifest(value, SOURCE)
        with self.assertRaisesRegex(ValueError, "image ID mismatch"):
            runtime.verify_archive(self.directory / runtime.ARCHIVE_NAME, value)

    def test_sizes_budget_and_archive_expansion_fail_closed(self):
        self.reject(lambda m: m.update(total_image_size_bytes=1), "size sum")
        self.reject(lambda m: m["images"]["backend"].update(size_bytes=-1), "image size")
        value = copy.deepcopy(self.manifest)
        value["images"]["backend"]["size_bytes"] = runtime.MAX_IMAGE_BYTES
        value["total_image_size_bytes"] = sum(i["size_bytes"] for i in value["images"].values())
        with self.assertRaisesRegex(ValueError, "1.5 GiB"):
            runtime.validate_manifest(value, SOURCE)
        value = copy.deepcopy(self.manifest)
        value["archive"]["uncompressed_size_bytes"] = 1
        with self.assertRaisesRegex(ValueError, "expands"):
            runtime.verify_archive(self.directory / runtime.ARCHIVE_NAME, value)

    def test_digest_and_missing_contracts_fail_closed(self):
        value = copy.deepcopy(self.manifest)
        value["archive"]["sha256"] = "d" * 64
        with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
            runtime.verify_archive(self.directory / runtime.ARCHIVE_NAME, value)
        self.reject(lambda m: m["runtime_checks"].pop("worker_source"), "Worker")
        self.reject(lambda m: m["runtime_checks"].update(ffmpeg={}), "FFmpeg")

    def test_caddy_validation_preserves_hardening_and_compares_image_binary(self):
        calls, recipes = [], []
        web_id, derived_id = "sha256:" + "e" * 64, "sha256:" + "f" * 64
        base = {"Id": web_id, "Os": "linux", "Architecture": "amd64", "RootFS": {"Layers": ["base-layer"]}}
        derived = {"Id": derived_id, "Os": "linux", "Architecture": "amd64", "RootFS": {"Layers": ["base-layer", "validation-copy-layer"]}}
        def inspect(reference):
            return copy.deepcopy(derived if reference.startswith("rainsync-web-validation-only:") else base)
        def run(args, timeout=60):
            calls.append(args)
            if args[0] == "buildx":
                return "Name: default\nDriver: docker\n"
            if args[:2] == ["container", "ls"]:
                return ""
            if args[0] == "build":
                recipes.append(Path(args[args.index("--file") + 1]).read_text())
            return "Valid configuration\n"
        restrictions = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]
        with patch.object(runtime, "docker", side_effect=run), patch.object(runtime, "inspect", side_effect=inspect):
            runtime.validate_web_image(web_id, restrictions)
        self.assertEqual(len(calls), 6)
        self.assertEqual(calls[0], ["buildx", "inspect", "default"])
        self.assertEqual(calls[1][:3], ["image", "tag", web_id])
        base_tag = calls[1][-1]
        build = calls[2]
        self.assertEqual(build[0], "build")
        self.assertEqual(build[build.index("--builder") + 1], "default")
        self.assertEqual(build[build.index("--network") + 1], "none")
        self.assertIn("--pull=false", build)
        self.assertTrue(recipes[0].startswith("FROM " + base_tag + "\n"))
        self.assertIn("RUN --network=none cp /usr/bin/caddy /usr/bin/rainsync-caddy-validate && cmp /usr/bin/caddy /usr/bin/rainsync-caddy-validate", recipes[0])
        self.assertIn('test -z "$(getcap /usr/bin/rainsync-caddy-validate)"', recipes[0])
        web = calls[3]
        for option, value in (("--network", "none"), ("--cap-drop", "ALL"), ("--security-opt", "no-new-privileges"),
                              ("--tmpfs", "/tmp:rw,nosuid,nodev,size=128m"), ("--entrypoint", "sh")):
            self.assertEqual(web[web.index(option) + 1], value)
        self.assertIn("--read-only", web)
        self.assertNotIn("--cap-add", web)
        self.assertNotIn("--privileged", web)
        self.assertIn(derived_id, web)
        self.assertNotIn("exec", web[web.index("--tmpfs") + 1].split(","))
        self.assertIn("getcap /usr/bin/caddy", web[-1])
        self.assertIn("cmp /usr/bin/caddy /usr/bin/rainsync-caddy-validate", web[-1])
        self.assertIn('test -z "$(getcap /usr/bin/rainsync-caddy-validate)"', web[-1])
        self.assertIn("exec /usr/bin/rainsync-caddy-validate validate --config /etc/caddy/Caddyfile --adapter caddyfile", web[-1])
        probe_name = web[web.index("--name") + 1]
        self.assertTrue(probe_name.startswith("rainsync-web-validation-probe-"))
        self.assertEqual(calls[4], ["container", "ls", "--all", "--filter", "name=^/" + probe_name + "$", "--format", "{{.Names}}"])
        self.assertEqual(calls[5], ["image", "rm", "--no-prune", build[build.index("--tag") + 1], base_tag])
        def fail_web(args, timeout=60):
            if args[0] == "run":
                raise subprocess.CalledProcessError(126, args)
            return run(args, timeout)
        with patch.object(runtime, "docker", side_effect=fail_web), patch.object(runtime, "inspect", side_effect=inspect), self.assertRaises(subprocess.CalledProcessError):
            runtime.validate_web_image(web_id, restrictions)
        self.assertEqual(calls[-1][:3], ["image", "rm", "--no-prune"])

    def test_web_validation_refuses_unbound_base_or_derived_filesystem(self):
        web_id = "sha256:" + "e" * 64
        with patch.object(runtime, "inspect", return_value={"Id": "sha256:" + "f" * 64}), self.assertRaisesRegex(ValueError, "exact production image ID"):
            runtime.validate_web_image(web_id, [])
        base = {"Id": web_id, "Os": "linux", "Architecture": "amd64", "RootFS": {"Layers": ["base-layer"]}}
        derived = {**base, "Id": "sha256:" + "f" * 64, "RootFS": {"Layers": ["unrelated-base", "copy"]}}
        def inspect(reference):
            return derived if reference.startswith("rainsync-web-validation-only:") else base
        def run(args, timeout=60):
            return "Driver: docker\n" if args[0] == "buildx" else ""
        with patch.object(runtime, "docker", side_effect=run) as docker, patch.object(runtime, "inspect", side_effect=inspect), self.assertRaisesRegex(ValueError, "production layers"):
            runtime.validate_web_image(web_id, [])
        self.assertFalse(any(call.args[0][0] == "run" for call in docker.call_args_list))
        self.assertEqual(docker.call_args_list[-1].args[0][:3], ["image", "rm", "--no-prune"])

    def test_web_probe_timeout_removes_only_owned_container_before_images(self):
        web_id = "sha256:" + "e" * 64
        base = {"Id": web_id, "Os": "linux", "Architecture": "amd64", "RootFS": {"Layers": ["base-layer"]}}
        derived = {**base, "Id": "sha256:" + "f" * 64, "RootFS": {"Layers": ["base-layer", "copy-layer"]}}
        def inspect(reference):
            return derived if reference.startswith("rainsync-web-validation-only:") else base
        for removable in (True, False):
            calls, state = [], {"probe": None, "present": False}
            def run(args, timeout=60):
                calls.append(args)
                if args[0] == "buildx":
                    return "Driver: docker\n"
                if args[0] == "run":
                    state["probe"] = args[args.index("--name") + 1]
                    state["present"] = True
                    raise subprocess.TimeoutExpired(args, timeout)
                if args[:2] == ["container", "ls"]:
                    return state["probe"] + "\n" if state["present"] else ""
                if args[:2] == ["container", "rm"]:
                    self.assertEqual(args, ["container", "rm", "--force", state["probe"]])
                    if not removable:
                        raise subprocess.CalledProcessError(1, args)
                    state["present"] = False
                return ""
            with patch.object(runtime, "docker", side_effect=run), patch.object(runtime, "inspect", side_effect=inspect):
                with self.assertRaises(subprocess.TimeoutExpired if removable else ValueError):
                    runtime.validate_web_image(web_id, ["run", "--rm"])
            image_cleanup = [args for args in calls if args[:2] == ["image", "rm"]]
            self.assertEqual(len(image_cleanup), 1 if removable else 0)
            if removable:
                self.assertFalse(state["present"])
                self.assertEqual(calls[-2][:2], ["container", "ls"])

    def test_validation_refuses_nonlocal_builder_without_registry_fallback(self):
        with patch.object(runtime, "inspect", return_value={"Id": "sha256:" + "e" * 64}), patch.object(runtime, "docker", return_value="Driver: docker-container\n") as docker:
            with self.assertRaisesRegex(ValueError, "no registry fallback"):
                runtime.validate_web_image("sha256:" + "e" * 64, [])
        self.assertEqual(docker.call_args_list[0].args[0], ["buildx", "inspect", "default"])
        self.assertEqual(len(docker.call_args_list), 1)

    def test_daemon_checks_ids_architecture_size_and_source(self):
        def observed(reference):
            expected = next(i for i in self.manifest["images"].values() if i["image_id"] == reference)
            return {"Id": reference, "Os": expected["os"], "Architecture": expected["architecture"], "Size": expected["size_bytes"],
                    "Config": {"Labels": {"org.opencontainers.image.revision": expected["source_revision"]}}}
        with patch.object(runtime, "inspect", side_effect=observed):
            runtime.verify_daemon(self.manifest)
        for field, replacement, message in (("Id", "sha256:" + "d" * 64, "ID"), ("Architecture", "arm64", "architecture"), ("Size", 1, "size"), ("Config", {"Labels": {}}, "source")):
            def mismatch(reference, field=field, replacement=replacement):
                value = observed(reference)
                value[field] = replacement
                return value
            with patch.object(runtime, "inspect", side_effect=mismatch), self.assertRaisesRegex(ValueError, message):
                runtime.verify_daemon(self.manifest)

    def test_cli_verify_is_read_only_and_requires_exact_checksums(self):
        path = self.directory / "manifest.json"
        path.write_text(json.dumps(self.manifest))
        sums = self.directory / "SHA256SUMS"
        sums.write_text(f"{self.manifest['archive']['sha256']}  {runtime.ARCHIVE_NAME}\n{runtime.sha_file(path)}  manifest.json\n")
        before = {p.name: p.read_bytes() for p in self.directory.iterdir()}
        command = [sys.executable, str(ROOT / "deploy/runtime-images.py"), "verify", "--source", SOURCE, "--directory", str(self.directory)]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.directory.iterdir()})
        sums.write_text("wrong")
        completed = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("SHA256SUMS mismatch", completed.stderr)

    def test_compose_is_no_build_private_and_uses_rootfs_binds(self):
        ids = {r: i["image_id"] for r, i in self.manifest["images"].items()}
        mount = lambda path, target: {"type": "bind", "source": path, "target": target, "bind": {"create_host_path": False}}
        services = {s: {"image": ids[r], "pull_policy": "never", "volumes": []} for s, r in (("db", "postgres"), ("server", "backend"), ("worker", "backend"), ("web", "web"))}
        services["db"]["volumes"] = [mount("/opt/rainsync/database", "/var/lib/postgresql/data")]
        for s in ("server", "worker"):
            services[s]["volumes"] = [mount("/opt/rainsync/cache", "/cache")]
        services["web"]["ports"] = [{"host_ip": "127.0.0.1", "published": "3080", "target": 80}]
        runtime.validate_compose({"services": services}, ids)
        for edit, message in ((lambda c: c["server"].update(build={"context": "."}), "not build"),
                              (lambda c: c["db"].update(ports=[{"published": "5432"}]), "published"),
                              (lambda c: c["worker"].update(ports=[{"published": "8081"}]), "published"),
                              (lambda c: c["web"]["ports"][0].update(host_ip="0.0.0.0"), "127.0.0.1"),
                              (lambda c: c["db"]["volumes"][0].update(source="/var/lib/docker/database"), "bind mounts")):
            changed = copy.deepcopy(services)
            edit(changed)
            with self.assertRaisesRegex(ValueError, message):
                runtime.validate_compose({"services": changed}, ids)
        override = (ROOT / "deploy/imported-images.override.yaml").read_text()
        self.assertEqual(override.count("build: !reset null"), 3)
        self.assertEqual(override.count("pull_policy: never"), 4)
        self.assertNotIn("ports:", override)
        workflow = (ROOT / ".github/workflows/runtime-images.yml").read_text()
        for expected in ("branches: ['codex/rainsync-deploy-*']", "contents: read", "actions/checkout@v4", "actions/upload-artifact@v4", "compression-level: 0", "retention-days: 7"):
            self.assertIn(expected, workflow)
        self.assertNotIn("packages: write", workflow)
        self.assertNotIn("docker login", workflow)


if __name__ == "__main__":
    unittest.main(verbosity=2)
