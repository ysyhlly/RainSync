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
import threading
from uuid import uuid4
import zlib

MAX_IMAGE_BYTES = 1536 * 1024 * 1024
TAR_OVERHEAD_BYTES = 32 * 1024 * 1024
ARCHIVE_NAME = "runtime-images.tar.gz"
ROLES = ("backend", "web", "postgres")
PLATFORMS = ("linux/amd64", "linux/arm64")
SOURCE_LABEL = "org.rainsync.runtime-source-binding"
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


def architecture(platform):
    require(platform in PLATFORMS, "unsupported platform/architecture")
    return platform.split("/")[1]


def tags(source, platform="linux/amd64"):
    suffix = "" if architecture(platform) == "amd64" else "-arm64"
    return {"backend": "rainsync-backend:" + source + suffix, "web": "rainsync-web:" + source + suffix,
            "postgres": "rainsync-postgres:17-" + source + suffix}


def binding_digest(binding):
    return hashlib.sha256(json.dumps(binding, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def source_binding(source):
    """Bind a clean exact checkout, lockfiles and the recipes actually used."""
    require(COMMIT.fullmatch(source or ""), "invalid source commit")
    def git(*args):
        return subprocess.check_output(["git", *args], text=True, timeout=30).strip()
    require(git("rev-parse", "HEAD") == source, "checkout differs from exact source commit")
    require(not git("status", "--porcelain", "--untracked-files=normal"), "source changes cannot produce a source-bound bundle")
    paths = ("Cargo.lock", "package-lock.json", "deploy/Dockerfile", "deploy/Dockerfile.web", ".dockerignore")
    files = {}
    for name in paths:
        require(not Path(name).is_symlink() and Path(name).is_file(), "missing/linked build input")
        files[name] = sha_file(Path(name))
    return {"source_commit": source, "git_tree": git("rev-parse", "HEAD^{tree}"), "files_sha256": files,
            "build_kind": "development-measured", "runtime_acceptance": False}


def validate_binding(binding, source):
    require(isinstance(binding, dict) and binding.get("source_commit") == source, "source binding mismatch")
    require(COMMIT.fullmatch(binding.get("git_tree", "")), "invalid source tree identity")
    files = binding.get("files_sha256", {})
    require(set(files) == {"Cargo.lock", "package-lock.json", "deploy/Dockerfile", "deploy/Dockerfile.web", ".dockerignore"}
            and all(SHA.fullmatch(value or "") for value in files.values()), "missing build/lockfile hashes")
    require(binding.get("build_kind") == "development-measured" and binding.get("runtime_acceptance") is False,
            "bounded runtime bundle cannot claim pinned release or real-device acceptance")


def integer(value):
    return type(value) is int and value > 0


def validate_manifest(manifest, source, platform="linux/amd64"):
    require(COMMIT.fullmatch(source or ""), "expected source must be an exact 40-character Git SHA")
    arch = architecture(platform)
    schema = manifest.get("schema_version")
    require(type(schema) is int and schema in (1, 2), "unsupported manifest schema")
    require(manifest.get("source_commit") == source, "source commit mismatch")
    require(manifest.get("platform") == platform and (schema == 2 or platform == "linux/amd64"), "wrong platform/architecture")
    if schema == 2:
        binding = manifest.get("build_binding")
        validate_binding(binding, source)
    images = manifest.get("images", {})
    require(set(images) == set(ROLES), "exactly backend, web and postgres runtime images required")
    identities = []
    for role in ROLES:
        image = images[role]
        require(image.get("tag") == tags(source, platform)[role], "source-bound image tag mismatch: " + role)
        image_id = image.get("image_id", "")
        require(image_id.startswith("sha256:") and SHA.fullmatch(image_id[7:]), "invalid image ID: " + role)
        identities.append(image_id)
        require(image.get("os") == "linux" and image.get("architecture") == arch, "wrong image architecture: " + role)
        require(integer(image.get("size_bytes")), "invalid image size: " + role)
        require(isinstance(image.get("repo_tags"), list) and image["tag"] in image["repo_tags"], "missing measured image tag")
        digests = image.get("repo_digests")
        require(isinstance(digests, list) and all(isinstance(d, str) and re.fullmatch(r"[^\s@]+@sha256:[0-9a-f]{64}", d) for d in digests), "invalid recorded RepoDigests")
        if role == "postgres":
            require(any(d.startswith("postgres@sha256:") or d.startswith("docker.io/library/postgres@sha256:") for d in digests), "PostgreSQL requires measured official pull RepoDigest")
        require(image.get("source_revision") == (source if role != "postgres" else None), "wrong image source revision: " + role)
        if schema == 2 and role != "postgres":
            require(image.get("source_binding_sha256") == binding_digest(binding), "image/build input binding mismatch: " + role)
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
    if schema == 2:
        ffmpeg = evidence.get("ffmpeg_build", {})
        require(isinstance(ffmpeg.get("package_version"), str) and re.fullmatch(r"[0-9][A-Za-z0-9.+:~_-]{0,100}", ffmpeg["package_version"]), "missing measured FFmpeg package version")
        proof = ffmpeg.get("proof", "")
        require(isinstance(proof, str) and len(proof) <= 65536 and "ffmpeg version " in proof and "ffprobe version " in proof
                and proof.splitlines()[0] == ffmpeg["package_version"]
                and hashlib.sha256(proof.encode()).hexdigest() == ffmpeg.get("proof_sha256"), "missing measured FFmpeg build proof")
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


def scan_tar(stream):
    """Read bounded save output; hash raw and uncompressed layer content."""
    records, small, buffered = {}, {}, 0
    expanded_layers = 0
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
            digest, diff_digest, chunks = hashlib.sha256(), hashlib.sha256(), []
            compression, decoder = None, None
            retain = member.size <= 1024 * 1024
            if retain:
                buffered += member.size
                require(buffered <= 8 * 1024 * 1024, "excessive archive metadata")
            with saved.extractfile(member) as handle:
                for block in iter(lambda: handle.read(64 * 1024), b""):
                    if compression is None:
                        compression = "gzip" if block.startswith(b"\x1f\x8b") else ("unsupported" if block.startswith(b"\x28\xb5\x2f\xfd") else "none")
                        if compression == "gzip":
                            decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
                    digest.update(block)
                    if retain:
                        chunks.append(block)
                    if decoder:
                        pending = block
                        while pending:
                            output = decoder.decompress(pending, 64 * 1024)
                            pending = decoder.unconsumed_tail
                            diff_digest.update(output)
                            expanded_layers += len(output)
                            require(expanded_layers <= MAX_IMAGE_BYTES + TAR_OVERHEAD_BYTES, "layer expansion exceeds runtime budget")
                        require(not decoder.unused_data, "unexpected trailing compressed layer content")
                    else:
                        diff_digest.update(block)
            if decoder:
                require(decoder.eof, "truncated gzip layer")
            records[name] = {"sha256": digest.hexdigest(), "diff_sha256": diff_digest.hexdigest(), "compression": compression or "none", "size": member.size}
            if retain:
                small[name] = b"".join(chunks)
    while stream.read(64 * 1024):
        pass
    return records, small


def verify_archive(path, manifest, *, content=None):
    archive = manifest["archive"]
    require(path.stat().st_size == archive["size_bytes"], "archive byte size mismatch")
    require(sha_file(path) == archive["sha256"], "archive SHA256 mismatch")
    with gzip.open(path, "rb") as compressed:
        stream = BoundedReader(compressed, archive["uncompressed_size_bytes"])
        records, small = scan_tar(stream)
        # Consume padding/trailers too; gzip CRC and the full expansion bound matter.
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
        require(config.get("os") == "linux" and config.get("architecture") == architecture(manifest["platform"]), "archive architecture mismatch")
        revision = (config.get("config") or {}).get("Labels", {}) or {}
        require(revision.get("org.opencontainers.image.revision") == expected["source_revision"], "archive source revision mismatch")
        if manifest["schema_version"] == 2 and role != "postgres":
            require(revision.get(SOURCE_LABEL) == expected["source_binding_sha256"], "archive build input binding mismatch")
        diff_ids = config.get("rootfs", {}).get("diff_ids")
        layers = entry.get("Layers")
        require(config.get("rootfs", {}).get("type") == "layers" and isinstance(diff_ids, list) and isinstance(layers, list) and len(diff_ids) == len(layers), "archive layer/config count mismatch")
        for layer, diff_id in zip(layers, diff_ids):
            require(layer in records and records[layer]["compression"] != "unsupported" and diff_id == "sha256:" + records[layer]["diff_sha256"], "archive ordered layer content mismatch")
        if content is not None:
            content[role] = {"config_id": expected["image_id"], "diff_ids": diff_ids}
    require(selected == set(ROLES), "missing runtime image")
    # SHA256 binds every byte to the exact Actions artifact. Do not implement an
    # alternate OCI/layer importer here; Docker owns loading its own save format.
    return {"result": "passed", "archive_sha256": archive["sha256"], "source_commit": manifest["source_commit"], "platform": manifest["platform"], "images": {r: manifest["images"][r]["image_id"] for r in ROLES}}


def docker(args, timeout=60):
    # Never inherit a remote Docker context or a credential/config directory.
    env = {k: v for k, v in os.environ.items() if not k.startswith("DOCKER_")}
    return subprocess.check_output(["docker", "--host", "unix:///var/run/docker.sock", *args], env=env, timeout=timeout, text=True)


def inspect(reference):
    values = read_json(docker(["image", "inspect", reference]))
    require(len(values) == 1, "ambiguous daemon image")
    return values[0]


def read_daemon_tar(image_ids, limit):
    """Stream a read-only local export; never write an additional image tar."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("DOCKER_")}
    command = ["docker", "--host", "unix:///var/run/docker.sock", "image", "save", *image_ids]
    with subprocess.Popen(command, stdout=subprocess.PIPE, env=env) as process:
        expired = threading.Event()
        def expire():
            expired.set()
            if process.poll() is None:
                process.kill()
        timer = threading.Timer(180, expire)
        timer.start()
        try:
            records, small = scan_tar(BoundedReader(process.stdout, limit))
            status = process.wait(timeout=5)
            require(not expired.is_set(), "bounded target image export timed out")
            require(status == 0, "read-only target image export failed")
            return records, small
        except BaseException:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            raise
        finally:
            timer.cancel()


def verify_oci_image(observed, expected, proof, records, small):
    """Bind native descriptor ID -> exact config -> ordered physical layers."""
    index_types = {"application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"}
    manifest_types = {"application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"}
    config_types = {"application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"}
    raw_types = {"application/vnd.oci.image.layer.v1.tar", "application/vnd.docker.image.rootfs.diff.tar"}
    gzip_types = {"application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.docker.image.rootfs.diff.tar.gzip"}
    def blob(descriptor):
        require(isinstance(descriptor, dict), "invalid OCI descriptor object")
        digest = descriptor.get("digest", "")
        require(digest.startswith("sha256:") and SHA.fullmatch(digest[7:]), "invalid OCI content digest")
        path = "blobs/sha256/" + digest[7:]
        require(path in records and records[path]["sha256"] == digest[7:] and integer(descriptor.get("size")) and records[path]["size"] == descriptor["size"], "OCI descriptor content/size mismatch")
        return path
    descriptor = observed.get("Descriptor") or {}
    require(descriptor.get("digest") == observed["Id"], "daemon native ID is not its OCI descriptor digest")
    packed_size = descriptor.get("size", 0)
    path = blob(descriptor)
    require(path in small, "oversized OCI identity metadata")
    node = read_json(small[path])
    require(isinstance(node, dict) and node.get("schemaVersion") == 2, "unsupported OCI identity schema")
    require(node.get("mediaType", descriptor.get("mediaType")) == descriptor.get("mediaType"), "OCI identity media type mismatch")
    if descriptor.get("mediaType") in index_types:
        children = node.get("manifests")
        require(isinstance(children, list) and len(children) == 1, "only the shipped single-platform OCI wrapper is supported")
        descriptor = children[0]
        platform = descriptor.get("platform")
        require(platform is None or platform.get("os") == expected["os"] and platform.get("architecture") == expected["architecture"], "OCI wrapper architecture mismatch")
        path = blob(descriptor)
        packed_size += descriptor["size"]
        require(path in small, "oversized OCI manifest")
        node = read_json(small[path])
        require(isinstance(node, dict) and node.get("schemaVersion") == 2, "unsupported OCI manifest schema")
        require(node.get("mediaType", descriptor.get("mediaType")) == descriptor.get("mediaType"), "OCI manifest media type mismatch")
    require(descriptor.get("mediaType") in manifest_types, "unsupported native OCI descriptor format")
    config = node.get("config", {})
    require(config.get("mediaType") in config_types and config.get("digest") == expected["image_id"] == proof["config_id"], "daemon OCI config digest differs from the exact packaged config")
    config_path = blob(config)
    require(config_path in small and read_json(small[config_path]).get("rootfs", {}).get("diff_ids") == proof["diff_ids"], "daemon OCI config rootfs mismatch")
    packed_size += config["size"]
    layers = node.get("layers")
    require(isinstance(layers, list) and len(layers) == len(proof["diff_ids"]), "daemon OCI layer count mismatch")
    for descriptor, diff_id in zip(layers, proof["diff_ids"]):
        path = blob(descriptor)
        compression = records[path]["compression"]
        require(descriptor.get("mediaType") in (gzip_types if compression == "gzip" else raw_types) and compression != "unsupported", "unsupported OCI layer compression; content qualification required")
        require("sha256:" + records[path]["diff_sha256"] == diff_id, "daemon ordered physical layer content mismatch")
        packed_size += descriptor["size"]
    require(observed["Size"] == packed_size, "daemon packed descriptor size mismatch")


def verify_daemon(manifest, *, content=None):
    observed_images, native_ids, translated = {}, {}, []
    for role in ROLES:
        expected = manifest["images"][role]
        # Tags select candidates only. The classic ID or full OCI content graph
        # must prove identity; labels or a mutable tag alone never suffice.
        observed = inspect(expected["tag"])
        native_id = observed.get("Id", "")
        require(native_id.startswith("sha256:") and SHA.fullmatch(native_id[7:]), "invalid daemon image ID")
        require(observed["Os"] == expected["os"] and observed["Architecture"] == expected["architecture"], "daemon architecture mismatch")
        require(integer(observed.get("Size")), "invalid daemon image size")
        labels = observed.get("Config", {}).get("Labels", {}) or {}
        require(labels.get("org.opencontainers.image.revision") == expected["source_revision"], "daemon source revision mismatch")
        if manifest["schema_version"] == 2 and role != "postgres":
            require(labels.get(SOURCE_LABEL) == expected["source_binding_sha256"], "daemon build input binding mismatch")
        if content is not None:
            require(observed.get("RootFS", {}).get("Type") == "layers" and observed.get("RootFS", {}).get("Layers") == content[role]["diff_ids"], "daemon ordered rootfs digest mismatch")
        if native_id == expected["image_id"]:
            require(observed["Size"] == expected["size_bytes"], "daemon image size mismatch")
        else:
            require(content is not None and role in content, "daemon image ID mismatch: exact verified archive content is required for containerd")
            translated.append(role)
        observed_images[role], native_ids[role] = observed, native_id
    require(len(set(native_ids.values())) == 3, "daemon runtime images must remain distinct")
    require(sum(value["Size"] for value in observed_images.values()) <= MAX_IMAGE_BYTES, "loaded runtime sizes exceed 1.5 GiB budget")
    if translated:
        records, small = read_daemon_tar([native_ids[r] for r in translated], manifest["total_image_size_bytes"] + TAR_OVERHEAD_BYTES)
        for role in translated:
            verify_oci_image(observed_images[role], manifest["images"][role], content[role], records, small)
    for role in ROLES:
        require(inspect(manifest["images"][role]["tag"])["Id"] == native_ids[role], "daemon image tag changed during content verification")
    return native_ids


def validate_web_image(web, restrictions, platform="linux/amd64"):
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
            docker(["build", "--builder", "default", "--platform", platform, "--network", "none", "--pull=false", "--file", str(recipe), "--tag", validation_tag, context], timeout=120)
        owned_tags.append(validation_tag)
        derived = inspect(validation_tag)
        require(inspect(base_tag)["Id"] == web and inspect(web)["Id"] == web, "production image identity changed")
        require(derived["Os"] == "linux" and derived["Architecture"] == architecture(platform), "validation image architecture mismatch")
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


def runtime_checks(backend, web, platform="linux/amd64"):
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
    proof = docker([*common, "--entrypoint", "sh", backend, "-eu", "-c", "dpkg-query -W -f='${Version}\\n' ffmpeg; ffmpeg -version; ffprobe -version"], timeout=30)
    checks["ffmpeg_build"] = {"package_version": proof.splitlines()[0], "proof": proof,
                              "proof_sha256": hashlib.sha256(proof.encode()).hexdigest()}
    validate_web_image(web, common, platform)
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


def package(directory, source, platform="linux/amd64"):
    require(COMMIT.fullmatch(source or ""), "invalid source commit")
    require(not directory.exists(), "output directory already exists")
    binding = source_binding(source)
    images = {}
    for role, tag in tags(source, platform).items():
        value = inspect(tag)
        images[role] = {"tag": tag, "image_id": value["Id"], "repo_tags": value.get("RepoTags") or [],
                        "repo_digests": value.get("RepoDigests") or [], "os": value["Os"], "architecture": value["Architecture"],
                        "size_bytes": value["Size"], "source_revision": (value.get("Config", {}).get("Labels", {}) or {}).get("org.opencontainers.image.revision")}
        if role != "postgres":
            images[role]["source_binding_sha256"] = (value.get("Config", {}).get("Labels", {}) or {}).get(SOURCE_LABEL)
            require(images[role]["source_binding_sha256"] == binding_digest(binding), "built image lacks exact checkout/lockfile binding")
    total = sum(i["size_bytes"] for i in images.values())
    require(total <= MAX_IMAGE_BYTES, "runtime image sizes exceed 1.5 GiB budget; no artifact exported")
    for role in ROLES:
        require(images[role]["os"] == "linux" and images[role]["architecture"] == architecture(platform), "wrong runtime image architecture")
        require(images[role]["source_revision"] == (source if role != "postgres" else None), "wrong runtime image source revision")
    checks = runtime_checks(images["backend"]["image_id"], images["web"]["image_id"], platform)
    require(source_binding(source) == binding, "source inputs changed while measuring images")
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
    command = ["docker", "--host", "unix:///var/run/docker.sock", "image", "save", *tags(source, platform).values()]
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
    manifest = {"schema_version": 2, "source_commit": source, "platform": platform, "images": images, "build_binding": binding,
                "total_image_size_bytes": total, "runtime_checks": checks,
                "archive": {"file": ARCHIVE_NAME, "sha256": sha_file(path), "size_bytes": path.stat().st_size, "uncompressed_size_bytes": count}}
    validate_manifest(manifest, source, platform)
    verify_archive(path, manifest)
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (directory / "SHA256SUMS").write_text(f"{sha_file(path)}  {ARCHIVE_NAME}\n{sha_file(directory / 'manifest.json')}  manifest.json\n")
    print(json.dumps({"result": "passed", "source_commit": source, "total_image_size_bytes": total}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["verify", "package", "source"])
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--platform", choices=PLATFORMS, default="linux/amd64", help="expected architecture; defaults to legacy amd64")
    parser.add_argument("--daemon", action="store_true", help="also inspect already-loaded local images, read-only")
    args = parser.parse_args()
    if args.mode == "source":
        require(not args.daemon and args.directory is None, "source mode does not inspect Docker or use an output directory")
        binding = source_binding(args.source)
        print(json.dumps({"binding": binding, "label_sha256": binding_digest(binding)}, sort_keys=True))
        return
    require(args.directory is not None, "--directory is required for package/verify")
    if args.mode == "package":
        require(not args.daemon, "--daemon applies only to verify")
        package(args.directory, args.source, args.platform)
        return
    manifest_path = args.directory / "manifest.json"
    require(manifest_path.stat().st_size <= 1024 * 1024, "oversized artifact manifest")
    manifest = validate_manifest(read_json(manifest_path.read_bytes()), args.source, args.platform)
    checksums = (args.directory / "SHA256SUMS").read_text()
    require(checksums == f"{manifest['archive']['sha256']}  {ARCHIVE_NAME}\n{sha_file(manifest_path)}  manifest.json\n", "SHA256SUMS mismatch")
    content = {}
    result = verify_archive(args.directory / ARCHIVE_NAME, manifest, content=content)
    if args.daemon:
        result["daemon_image_ids"] = verify_daemon(manifest, content=content)
        result["loaded_local_images"] = "passed"
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, EOFError, zlib.error, tarfile.TarError, subprocess.SubprocessError) as error:
        print("Runtime artifact verification failed: " + str(error), file=sys.stderr)
        sys.exit(1)
