#!/usr/bin/env python3
"""Bounded Docker-save bundle producer and read-only, stdlib-only verifier.

Verification never pulls, loads, starts a service or writes configuration.
Image IDs are local content IDs; RepoDigests are recorded, never invented.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
from uuid import uuid4

MAX_IMAGE_BYTES = 1536 * 1024 * 1024
TAR_OVERHEAD_BYTES = 32 * 1024 * 1024
ARCHIVE_NAME = "runtime-images.tar.gz"
ROLES = ("backend", "web", "postgres")
SHA = re.compile(r"[0-9a-f]{64}\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
LOGIN_CONTRACT = {"schema_version": 1, "contract": "media-login-binding-v1",
                  "migration": 41, "legacy": "fixed-expiry", "caller": "exact-login"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def source_contract(role):
    return {"schema_version": 1, "contract": "controlled-media-redirects-v1",
            "identity": "final-target-sha256-v1", "credential_origin": "configured-origin",
            "methods": ["GET", "HEAD"], "default": "no-follow", "role": role}


def tags(source):
    return {"backend": "rainsync-backend:" + source, "web": "rainsync-web:" + source,
            "postgres": "rainsync-postgres:17-" + source}


def integer(value):
    return type(value) is int and value > 0


def validate_manifest(manifest, source):
    require(COMMIT.fullmatch(source or ""), "expected source must be an exact 40-character Git SHA")
    require(manifest.get("schema_version") == 1, "unsupported manifest schema")
    require(manifest.get("source_commit") == source, "source commit mismatch")
    require(manifest.get("platform") == "linux/amd64", "wrong platform/architecture")
    images = manifest.get("images", {})
    require(set(images) == set(ROLES), "exactly backend, web and postgres runtime images required")
    identities = []
    for role in ROLES:
        image = images[role]
        require(image.get("tag") == tags(source)[role], "source-bound image tag mismatch: " + role)
        image_id = image.get("image_id", "")
        require(image_id.startswith("sha256:") and SHA.fullmatch(image_id[7:]), "invalid image ID: " + role)
        identities.append(image_id)
        require(image.get("os") == "linux" and image.get("architecture") == "amd64", "wrong image architecture: " + role)
        require(integer(image.get("size_bytes")), "invalid image size: " + role)
        require(isinstance(image.get("repo_tags"), list) and image["tag"] in image["repo_tags"], "missing measured image tag")
        digests = image.get("repo_digests")
        require(isinstance(digests, list) and all(isinstance(d, str) and re.fullmatch(r"[^\s@]+@sha256:[0-9a-f]{64}", d) for d in digests), "invalid recorded RepoDigests")
        if role == "postgres":
            require(any(d.startswith("postgres@sha256:") or d.startswith("docker.io/library/postgres@sha256:") for d in digests), "PostgreSQL requires measured official pull RepoDigest")
        require(image.get("source_revision") == (source if role != "postgres" else None), "wrong image source revision: " + role)
    require(len(set(identities)) == 3, "runtime image IDs must be distinct")
    total = sum(images[r]["size_bytes"] for r in ROLES)
    require(manifest.get("total_image_size_bytes") == total, "image size sum mismatch")
    require(total <= MAX_IMAGE_BYTES, "runtime image sizes exceed 1.5 GiB budget")
    archive = manifest.get("archive", {})
    require(archive.get("file") == ARCHIVE_NAME, "unexpected archive filename")
    require(SHA.fullmatch(archive.get("sha256", "")), "invalid archive digest")
    require(integer(archive.get("size_bytes")) and archive["size_bytes"] <= total + TAR_OVERHEAD_BYTES, "invalid compressed archive size")
    require(integer(archive.get("uncompressed_size_bytes")) and archive["uncompressed_size_bytes"] <= total + TAR_OVERHEAD_BYTES, "invalid uncompressed archive size")
    evidence = manifest.get("runtime_checks", {})
    require(evidence.get("server_login") == LOGIN_CONTRACT, "missing offline Server login contract")
    require(evidence.get("server_source") == source_contract("server"), "missing offline Server source contract")
    require(evidence.get("worker_source") == source_contract("worker"), "missing offline Worker source contract")
    require(evidence.get("ffmpeg") == {"encode": "passed", "probe": "passed", "decode": "passed", "codec": "h264", "width": 64, "height": 64}, "missing actual FFmpeg runtime evidence")
    require(evidence.get("web_config") == "passed", "missing web configuration check")
    return manifest


def sha_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)


class BoundedReader:
    def __init__(self, stream, limit):
        self.stream, self.limit, self.count = stream, limit, 0

    def read(self, size=-1):
        require(0 <= size <= 1024 * 1024, "unbounded archive read")
        data = self.stream.read(size)
        self.count += len(data)
        require(self.count <= self.limit, "archive expands beyond declared size")
        return data


def verify_archive(path, manifest):
    archive = manifest["archive"]
    require(path.stat().st_size == archive["size_bytes"], "archive byte size mismatch")
    require(sha_file(path) == archive["sha256"], "archive SHA256 mismatch")
    records, small, buffered = {}, {}, 0
    with gzip.open(path, "rb") as compressed:
        stream = BoundedReader(compressed, archive["uncompressed_size_bytes"])
        with tarfile.open(fileobj=stream, mode="r|") as saved:
            for member in saved:
                name = member.name
                parts = PurePosixPath(name).parts
                require(name and not name.startswith("/") and ".." not in parts and "\\" not in name, "unsafe archive path")
                require(not member.issym() and not member.islnk(), "archive links are forbidden")
                if member.isdir():
                    continue
                require(member.isfile(), "unsupported archive entry")
                require(name not in records and len(records) < 10000, "duplicate or excessive archive entries")
                require(member.size <= stream.limit, "oversized archive entry")
                digest, chunks = hashlib.sha256(), []
                retain = member.size <= 1024 * 1024
                if retain:
                    buffered += member.size
                    require(buffered <= 8 * 1024 * 1024, "excessive archive metadata")
                with saved.extractfile(member) as handle:
                    for block in iter(lambda: handle.read(64 * 1024), b""):
                        digest.update(block)
                        if retain:
                            chunks.append(block)
                records[name] = {"sha256": digest.hexdigest(), "size": member.size}
                if retain:
                    small[name] = b"".join(chunks)
        # Consume padding/trailers too; gzip CRC and the full expansion bound matter.
        while stream.read(64 * 1024):
            pass
        require(stream.count == archive["uncompressed_size_bytes"], "uncompressed archive byte size mismatch")
    require("manifest.json" in small, "missing Docker-save manifest")
    entries = read_json(small["manifest.json"])
    require(isinstance(entries, list) and len(entries) == 3, "archive must contain exactly three runtime images")
    selected = set()
    for entry in entries:
        matches = [r for r in ROLES if entry.get("RepoTags") == [manifest["images"][r]["tag"]]]
        require(len(matches) == 1 and matches[0] not in selected, "unexpected/duplicate exported image tags")
        role = matches[0]
        selected.add(role)
        expected = manifest["images"][role]
        config_path = entry.get("Config")
        require(config_path in small, "unsupported Docker-save layout: missing/big image config; qualify actual CI output")
        require(records[config_path]["sha256"] == expected["image_id"][7:], "archive image ID mismatch: " + role)
        config = read_json(small[config_path])
        require(config.get("os") == "linux" and config.get("architecture") == "amd64", "archive architecture mismatch")
        revision = (config.get("config") or {}).get("Labels", {}) or {}
        require(revision.get("org.opencontainers.image.revision") == expected["source_revision"], "archive source revision mismatch")
    require(selected == set(ROLES), "missing runtime image")
    # SHA256 binds every byte to the exact Actions artifact. Do not implement an
    # alternate OCI/layer importer here; Docker owns loading its own save format.
    return {"result": "passed", "archive_sha256": archive["sha256"], "source_commit": manifest["source_commit"], "platform": "linux/amd64", "images": {r: manifest["images"][r]["image_id"] for r in ROLES}}


def docker(args, timeout=60):
    # Never inherit a remote Docker context or a credential/config directory.
    env = {k: v for k, v in os.environ.items() if not k.startswith("DOCKER_")}
    return subprocess.check_output(["docker", "--host", "unix:///var/run/docker.sock", *args], env=env, timeout=timeout, text=True)


def inspect(reference):
    values = read_json(docker(["image", "inspect", reference]))
    require(len(values) == 1, "ambiguous daemon image")
    return values[0]


def verify_daemon(manifest):
    for role in ROLES:
        expected = manifest["images"][role]
        observed = inspect(expected["image_id"])
        require(observed["Id"] == expected["image_id"], "daemon image ID mismatch")
        require(observed["Os"] == expected["os"] and observed["Architecture"] == expected["architecture"], "daemon architecture mismatch")
        require(observed["Size"] == expected["size_bytes"], "daemon image size mismatch")
        labels = observed.get("Config", {}).get("Labels", {}) or {}
        require(labels.get("org.opencontainers.image.revision") == expected["source_revision"], "daemon source revision mismatch")


def validate_web_image(web, restrictions):
    # Official Caddy's file capability cannot execute with an empty bounding
    # set. Docker tmpfs is noexec by default. Keep both restrictions: prepare
    # only a byte-identical, capability-free validation copy in a runner-only
    # derived image layer. The production image and save list stay unchanged.
    base = inspect(web)
    require(base["Id"] == web and web.startswith("sha256:"), "validation base must be the exact production image ID")
    nonce = uuid4().hex
    base_tag, validation_tag = "rainsync-web-validation-base:" + nonce, "rainsync-web-validation-only:" + nonce
    probe_name = "rainsync-web-validation-probe-" + nonce
    owned_tags = []
    probe_attempted = False
    try:
        builder = docker(["buildx", "inspect", "default"])
        require(re.search(r"^Driver:\s+docker\s*$", builder, re.MULTILINE), "validation requires the default docker driver and local daemon image store; no registry fallback")
        docker(["image", "tag", web, base_tag])
        owned_tags.append(base_tag)
        require(inspect(base_tag)["Id"] == web, "validation base alias changed")
        with tempfile.TemporaryDirectory(prefix="rainsync-web-validation-") as context:
            recipe = Path(context) / "Dockerfile"
            recipe.write_text(f"FROM {base_tag}\nRUN --network=none cp /usr/bin/caddy /usr/bin/rainsync-caddy-validate && cmp /usr/bin/caddy /usr/bin/rainsync-caddy-validate && test -z \"$(getcap /usr/bin/rainsync-caddy-validate)\"\n")
            docker(["build", "--builder", "default", "--platform", "linux/amd64", "--network", "none", "--pull=false", "--file", str(recipe), "--tag", validation_tag, context], timeout=120)
        owned_tags.append(validation_tag)
        derived = inspect(validation_tag)
        require(inspect(base_tag)["Id"] == web and inspect(web)["Id"] == web, "production image identity changed")
        require(derived["Os"] == "linux" and derived["Architecture"] == "amd64", "validation image architecture mismatch")
        require(derived["RootFS"]["Layers"][:-1] == base["RootFS"]["Layers"], "validation image is not exactly the production layers plus one copy layer")
        caddy = """getcap /usr/bin/caddy >&2
cmp /usr/bin/caddy /usr/bin/rainsync-caddy-validate
test -z "$(getcap /usr/bin/rainsync-caddy-validate)"
awk '$2 == "/tmp" { print }' /proc/mounts >&2
exec /usr/bin/rainsync-caddy-validate validate --config /etc/caddy/Caddyfile --adapter caddyfile"""
        probe_attempted = True
        docker([*restrictions, "--name", probe_name, "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--env", "SITE_ADDRESS=:80", "--entrypoint", "sh", derived["Id"], "-eu", "-c", caddy], timeout=30)
    finally:
        if probe_attempted:
            listing = ["container", "ls", "--all", "--filter", "name=^/" + probe_name + "$", "--format", "{{.Names}}"]
            present = docker(listing).strip().splitlines()
            require(present in ([], [probe_name]), "ambiguous validation probe ownership; preserve validation images")
            if present:
                try:
                    # A killed/timed-out CLI does not stop its daemon container.
                    # Only this fresh nonce-owned disposable probe may be killed.
                    docker(["container", "rm", "--force", probe_name], timeout=15)
                except subprocess.CalledProcessError:
                    # --rm can complete between listing and removal. Accept that
                    # race only after the following positive absence query.
                    pass
                require(not docker(listing).strip(), "validation probe is not confirmed absent; preserve validation images")
        # Remove only fresh nonce-named validation aliases/images, never a
        # runtime image or another builder's cache. The daemon confirms the
        # attempted probe is absent before any image cleanup, even on timeout.
        if owned_tags:
            docker(["image", "rm", "--no-prune", *reversed(owned_tags)])


def runtime_checks(backend, web):
    common = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]
    def probe(binary, flag):
        return read_json(docker([*common, "--entrypoint", binary, backend, flag], timeout=30))
    checks = {"server_login": probe("rainsync-server", "--media-authorization-contract"),
              "server_source": probe("rainsync-server", "--source-access-contract"),
              "worker_source": probe("rainsync-media-worker", "--source-access-contract")}
    ffmpeg = """ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=blue:s=64x64:r=5 -t 1 -c:v libx264 -threads 1 -pix_fmt yuv420p /tmp/probe.mp4
ffmpeg -hide_banner -loglevel error -i /tmp/probe.mp4 -f null -
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of json /tmp/probe.mp4"""
    result = read_json(docker([*common, "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m", "--entrypoint", "sh", backend, "-eu", "-c", ffmpeg], timeout=60))
    require(result.get("streams") == [{"codec_name": "h264", "width": 64, "height": 64}], "actual FFmpeg encode/probe/decode failed")
    checks["ffmpeg"] = {"encode": "passed", "probe": "passed", "decode": "passed", "codec": "h264", "width": 64, "height": 64}
    validate_web_image(web, common)
    checks["web_config"] = "passed"
    return checks


def validate_compose(config, image_ids, *, compose_version=None):
    services = config["services"]
    require(set(services) == {"db", "server", "worker", "web"}, "unexpected Compose services")
    for service, role in (("db", "postgres"), ("server", "backend"), ("worker", "backend"), ("web", "web")):
        value = services[service]
        require(not value.get("build"), "imported Compose must not build")
        require(value["image"] == image_ids[role] and value.get("pull_policy") == "never", "Compose image/pull policy mismatch")
        require(not value.get("ports") if service != "web" else len(value["ports"]) == 1, "unexpected published service port")
    port = services["web"]["ports"][0]
    require(port.get("host_ip") == "127.0.0.1" and str(port["published"]) == "3080" and port["target"] == 80 and port.get("protocol", "tcp") == "tcp", "web must publish only 127.0.0.1:3080:80")
    # Compose 2.38.2 uses compose-go 2.7.1's bool/json:omitempty model:
    # explicit create_host_path:false serializes as bind:{}. Its runtime
    # CreateMountpoint remains false. New OptOut models omit true instead,
    # so unknown versions must retain the explicit-false requirement.
    legacy_false_omitted = compose_version in ("2.38.2", "v2.38.2")
    def no_host_creation(mount):
        bind = mount.get("bind")
        return isinstance(bind, dict) and bind.get("create_host_path", False if legacy_false_omitted else None) is False
    for service, target in (("db", "/var/lib/postgresql/data"), ("server", "/cache"), ("worker", "/cache")):
        mounts = [v for v in services[service]["volumes"] if v["target"] == target]
        require(len(mounts) == 1 and mounts[0]["type"] == "bind" and mounts[0]["source"].startswith("/opt/rainsync/") and ".." not in PurePosixPath(mounts[0]["source"]).parts and mounts[0].get("read_only", False) is False and no_host_creation(mounts[0]), "database/cache must use prepared writable /opt/rainsync bind mounts without host creation: " + service)
    for service in ("server", "worker"):
        mounts = [v for v in services[service]["volumes"] if v["target"] == "/media"]
        require(len(mounts) == 1 and mounts[0]["type"] == "bind" and PurePosixPath(mounts[0]["source"]).is_absolute() and ".." not in PurePosixPath(mounts[0]["source"]).parts and mounts[0].get("read_only") is True and no_host_creation(mounts[0]), "media must use prepared read-only bind mounts without host creation: " + service)
    require(next(v["source"] for v in services["server"]["volumes"] if v["target"] == "/cache") == next(v["source"] for v in services["worker"]["volumes"] if v["target"] == "/cache"), "Server/Worker cache must match")


def package(directory, source):
    require(COMMIT.fullmatch(source or ""), "invalid source commit")
    require(not directory.exists(), "output directory already exists")
    images = {}
    for role, tag in tags(source).items():
        value = inspect(tag)
        images[role] = {"tag": tag, "image_id": value["Id"], "repo_tags": value.get("RepoTags") or [],
                        "repo_digests": value.get("RepoDigests") or [], "os": value["Os"], "architecture": value["Architecture"],
                        "size_bytes": value["Size"], "source_revision": (value.get("Config", {}).get("Labels", {}) or {}).get("org.opencontainers.image.revision")}
    total = sum(i["size_bytes"] for i in images.values())
    require(total <= MAX_IMAGE_BYTES, "runtime image sizes exceed 1.5 GiB budget; no artifact exported")
    for role in ROLES:
        require(images[role]["os"] == "linux" and images[role]["architecture"] == "amd64", "wrong runtime image architecture")
        require(images[role]["source_revision"] == (source if role != "postgres" else None), "wrong runtime image source revision")
    checks = runtime_checks(images["backend"]["image_id"], images["web"]["image_id"])
    ids = {r: images[r]["image_id"] for r in ROLES}
    env = dict(os.environ, RAINSYNC_BACKEND_IMAGE=ids["backend"], RAINSYNC_WEB_IMAGE=ids["web"], RAINSYNC_POSTGRES_IMAGE=ids["postgres"],
               RAINSYNC_DATABASE_PATH="/opt/rainsync/database", RAINSYNC_CACHE_PATH="/opt/rainsync/cache", MEDIA_PATH="/opt/rainsync/media",
               POSTGRES_PASSWORD="synthetic-compose-validation-only", SOURCE_ENCRYPTION_KEY="synthetic-not-a-runtime-key", RAINSYNC_LOOPBACK_PORT="3080")
    # config is read-only, with no real environment file or credentials.
    env = {k: v for k, v in env.items() if not k.startswith("DOCKER_")}
    config = subprocess.check_output(["docker", "--host", "unix:///var/run/docker.sock", "compose", "-p", "rainsync-artifact-validation", "-f", "compose.yaml", "-f", "deploy/imported-images.override.yaml", "-f", "deploy/loopback.override.yaml", "config", "--format", "json"], env=env, text=True, timeout=30)
    compose_version = docker(["compose", "version", "--short"]).strip()
    print("Qualifying Compose bind normalization for version " + compose_version, file=sys.stderr)
    validate_compose(read_json(config), ids, compose_version=compose_version)
    directory.mkdir(parents=True)
    path, count = directory / ARCHIVE_NAME, 0
    command = ["docker", "--host", "unix:///var/run/docker.sock", "image", "save", *tags(source).values()]
    with subprocess.Popen(command, stdout=subprocess.PIPE, env=env) as process:
        try:
            with open(path, "xb") as output, gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0, compresslevel=1) as compressed:
                for block in iter(lambda: process.stdout.read(1024 * 1024), b""):
                    count += len(block)
                    require(count <= total + TAR_OVERHEAD_BYTES, "Docker-save archive exceeds conservative expansion budget")
                    compressed.write(block)
            require(process.wait(timeout=60) == 0, "Docker-save failed")
        except BaseException:
            process.kill()
            process.wait()
            raise
    manifest = {"schema_version": 1, "source_commit": source, "platform": "linux/amd64", "images": images,
                "total_image_size_bytes": total, "runtime_checks": checks,
                "archive": {"file": ARCHIVE_NAME, "sha256": sha_file(path), "size_bytes": path.stat().st_size, "uncompressed_size_bytes": count}}
    validate_manifest(manifest, source)
    verify_archive(path, manifest)
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (directory / "SHA256SUMS").write_text(f"{sha_file(path)}  {ARCHIVE_NAME}\n{sha_file(directory / 'manifest.json')}  manifest.json\n")
    print(json.dumps({"result": "passed", "source_commit": source, "total_image_size_bytes": total}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["verify", "package"])
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--daemon", action="store_true", help="also inspect already-loaded local images, read-only")
    args = parser.parse_args()
    if args.mode == "package":
        require(not args.daemon, "--daemon applies only to verify")
        package(args.directory, args.source)
        return
    manifest_path = args.directory / "manifest.json"
    require(manifest_path.stat().st_size <= 1024 * 1024, "oversized artifact manifest")
    manifest = validate_manifest(read_json(manifest_path.read_bytes()), args.source)
    checksums = (args.directory / "SHA256SUMS").read_text()
    require(checksums == f"{manifest['archive']['sha256']}  {ARCHIVE_NAME}\n{sha_file(manifest_path)}  manifest.json\n", "SHA256SUMS mismatch")
    result = verify_archive(args.directory / ARCHIVE_NAME, manifest)
    if args.daemon:
        verify_daemon(manifest)
        result["loaded_local_images"] = "passed"
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, EOFError, tarfile.TarError, subprocess.SubprocessError) as error:
        print("Runtime artifact verification failed: " + str(error), file=sys.stderr)
        sys.exit(1)
