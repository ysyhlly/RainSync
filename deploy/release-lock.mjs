// Validate supplied immutable release inputs and measure actual built images.
// No example SHA values, architecture claims, or FFmpeg versions are fabricated.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { verifyCandidate } from "../scripts/release-evidence.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");
export function validateLock(lock) {
  assert.equal(lock.schema_version, 1, "unsupported release lock");
  assert.match(
    lock.source_manifest_sha256 ?? "",
    /^[a-f0-9]{64}$/,
    "frozen source manifest SHA-256 required",
  );
  assert.match(
    lock.production_manifest_sha256 ?? "",
    /^[a-f0-9]{64}$/,
    "frozen production manifest SHA-256 required",
  );
  assert.match(
    lock.debian_snapshot ?? "",
    /^\d{8}T\d{6}Z$/,
    "exact signed Debian snapshot timestamp required",
  );
  for (const key of ["ffmpeg_version", "ca_certificates_version"])
    assert.match(
      lock[key] ?? "",
      /^[0-9][A-Za-z0-9.+:~_-]{0,100}$/,
      `exact ${key} required`,
    );
  for (const arch of ["amd64", "arm64"]) {
    const platform = lock.platforms?.[arch];
    assert.ok(
      platform,
      `explicit ${arch} image set required; do not claim an unmeasured platform`,
    );
    for (const role of ["rust", "debian", "node", "caddy", "postgres"])
      assert.match(
        platform[role] ?? "",
        /^[A-Za-z0-9][A-Za-z0-9._/:+-]*@sha256:[a-f0-9]{64}$/,
        `${arch}/${role} needs an actual registry digest reference`,
      );
  }
  return lock;
}
export function buildArguments(lock, architecture, target = "backend") {
  validateLock(lock);
  assert.ok(["amd64", "arm64"].includes(architecture));
  assert.ok(["backend", "web"].includes(target));
  const images = lock.platforms[architecture];
  const inputs =
    target === "backend"
      ? {
          RUST_IMAGE: images.rust,
          DEBIAN_IMAGE: images.debian,
          DEBIAN_SNAPSHOT: lock.debian_snapshot,
          FFMPEG_VERSION: lock.ffmpeg_version,
          CA_CERTIFICATES_VERSION: lock.ca_certificates_version,
          SOURCE_MANIFEST_SHA256: lock.source_manifest_sha256,
          PRODUCTION_MANIFEST_SHA256: lock.production_manifest_sha256,
        }
      : {
          NODE_IMAGE: images.node,
          CADDY_IMAGE: images.caddy,
          SOURCE_MANIFEST_SHA256: lock.source_manifest_sha256,
          PRODUCTION_MANIFEST_SHA256: lock.production_manifest_sha256,
        };
  return [
    "build",
    "--platform=linux/" + architecture,
    "--file",
    `deploy/Dockerfile${target === "web" ? ".web" : ""}.release`,
    ...Object.entries(inputs).flatMap(([name, value]) => [
      "--build-arg",
      name + "=" + value,
    ]),
  ];
}
async function docker(args, timeout = 60000) {
  const env = { ...process.env };
  // Only the local daemon is used; never inherit a remote production context.
  for (const name of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ])
    delete env[name];
  try {
    return (
      await exec("docker", ["--host=unix:///var/run/docker.sock", ...args], {
        env,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      })
    ).stdout.trim();
  } catch {
    throw Error("local Docker operation failed; no release evidence accepted");
  }
}
export async function verifyInputs(lock, architecture, command = docker) {
  validateLock(lock);
  assert.ok(["amd64", "arm64"].includes(architecture));
  const verified = {};
  for (const [role, ref] of Object.entries(lock.platforms[architecture])) {
    assert.ok(
      ["rust", "debian", "node", "caddy", "postgres"].includes(role),
      "unknown release image role",
    );
    const image = JSON.parse(
      await command(["image", "inspect", "--format", "{{json .}}", ref]),
    );
    assert.equal(image.Os, "linux");
    assert.equal(
      image.Architecture,
      architecture,
      `${role} architecture mismatch`,
    );
    assert.ok(
      image.RepoDigests?.includes(ref),
      `${role} digest absent from local daemon evidence`,
    );
    assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
    verified[role] = { reference: ref, image_id: image.Id };
  }
  return verified;
}
export async function measureRuntime(
  imageReference,
  architecture,
  command = docker,
) {
  assert.match(
    imageReference,
    /^(?:[A-Za-z0-9][A-Za-z0-9._/:+-]*@)?sha256:[a-f0-9]{64}$/,
  );
  const metadata = JSON.parse(
    await command([
      "image",
      "inspect",
      "--format",
      "{{json .}}",
      imageReference,
    ]),
  );
  assert.equal(metadata.Os, "linux");
  assert.equal(metadata.Architecture, architecture);
  assert.match(metadata.Id, /^sha256:[a-f0-9]{64}$/);
  if (imageReference.startsWith("sha256:"))
    assert.equal(metadata.Id, imageReference);
  else
    assert.ok(
      metadata.RepoDigests?.includes(imageReference),
      "runtime registry digest mismatch",
    );
  const proof = await command([
    "run",
    "--rm",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--entrypoint=sh",
    metadata.Id,
    "-c",
    "dpkg-query -W -f='${Version}\\n' ffmpeg; ffmpeg -version; ffprobe -version; sha256sum /usr/local/bin/rainsync-server /usr/local/bin/rainsync-media-worker /usr/local/bin/rainsync-nas-agent",
  ]);
  const binaries = {};
  for (const line of proof.split("\n")) {
    const match =
      /^([a-f0-9]{64})\s+\/usr\/local\/bin\/(rainsync-(?:server|media-worker|nas-agent))$/.exec(
        line,
      );
    if (match) binaries[match[2]] = match[1];
  }
  assert.equal(
    Object.keys(binaries).length,
    3,
    "actual binary measurements missing",
  );
  assert.match(proof, /(?:^|\n)ffmpeg version /);
  assert.match(proof, /(?:^|\n)ffprobe version /);
  return {
    architecture,
    image_id: metadata.Id,
    repo_digests: metadata.RepoDigests ?? [],
    image_source_manifest_sha256:
      metadata.Config?.Labels?.["org.rainsync.full-source-manifest"] ?? null,
    image_production_manifest_sha256:
      metadata.Config?.Labels?.["org.rainsync.source-manifest"] ?? null,
    ffmpeg_package_version: proof.split("\n")[0],
    runtime_proof: proof,
    runtime_proof_sha256: sha(proof),
    binary_sha256: binaries,
  };
}
export function validateRuntimeEvidence(lock, runtime, binding) {
  validateLock(lock);
  assert.equal(
    runtime.image_source_manifest_sha256,
    lock.source_manifest_sha256,
    "measured image source label differs from frozen candidate",
  );
  assert.equal(
    runtime.image_production_manifest_sha256,
    lock.production_manifest_sha256,
    "measured image production source label differs from candidate",
  );
  assert.equal(
    runtime.ffmpeg_package_version,
    lock.ffmpeg_version,
    "built FFmpeg package differs from lock",
  );
  if (binding !== undefined) {
    assert.equal(binding.schema_version, 1, "unsupported build binding");
    assert.equal(
      binding.binding_kind,
      "frozen-source-build",
      "measurement requires original frozen-source build evidence",
    );
    assert.equal(
      binding.lock_sha256,
      sha(JSON.stringify(lock)),
      "build binding lock differs",
    );
    assert.equal(
      binding.source_manifest_sha256,
      lock.source_manifest_sha256,
      "build binding source differs",
    );
    assert.equal(
      binding.production_manifest_sha256,
      lock.production_manifest_sha256,
      "build binding production source differs",
    );
    assert.equal(
      binding.image_id,
      runtime.image_id,
      "measured image differs from bound candidate image",
    );
    assert.equal(
      binding.architecture,
      runtime.architecture,
      "measured architecture differs from bound candidate",
    );
    assert.deepEqual(
      binding.binary_sha256,
      runtime.binary_sha256,
      "measured binaries differ from bound candidate",
    );
    assert.equal(
      binding.runtime_proof_sha256,
      runtime.runtime_proof_sha256,
      "measured FFmpeg/build proof differs from candidate",
    );
  }
}

async function cli() {
  const [action, ...args] = process.argv.slice(2),
    options = new Map();
  for (const arg of args) {
    const match = /^--(lock|arch|image|output|target|tag|binding)=(.+)$/.exec(
      arg,
    );
    assert.ok(match && !options.has(match[1]), "unsupported/duplicate option");
    options.set(match[1], match[2]);
  }
  const lock = validateLock(
      JSON.parse(await readFile(options.get("lock"), "utf8")),
    ),
    architecture = options.get("arch");
  const inputs = await verifyInputs(lock, architecture);
  if (action === "verify-inputs") {
    console.log(
      JSON.stringify(
        {
          inputs,
          scope: "local base-image digest and architecture verification only",
        },
        null,
        2,
      ),
    );
    return;
  }
  assert.ok(options.get("output"), "new --output report file required");
  let reference = options.get("image");
  if (action === "build") {
    const tag = options.get("tag");
    assert.match(
      tag ?? "",
      /^rainsync-[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/,
    );
    const target = options.get("target") ?? "backend";
    // source-manifest field must be bound by validation-candidate; this command
    // is run from that verified frozen source, never a mutable working tree.
    const validateFrozen = async () => {
      const { candidate: manifest, source } = await verifyCandidate(
        resolve("..", "candidate.json"),
      );
      assert.equal(
        source,
        resolve("."),
        "build must run inside verified frozen source",
      );
      assert.equal(
        manifest.source_manifest_sha256,
        lock.source_manifest_sha256,
        "lock/candidate source mismatch",
      );
      const production = manifest.source_manifest.filter(
        (item) =>
          ["Cargo.toml", "Cargo.lock"].includes(item.path) ||
          /^(?:crates|migrations)\//.test(item.path) ||
          /^apps\/(?:server|media-worker|nas-agent)\//.test(item.path),
      );
      assert.deepEqual(
        manifest.production_manifest,
        production,
        "candidate production inputs differ from full source",
      );
      assert.equal(
        sha(JSON.stringify(production)),
        lock.production_manifest_sha256,
        "lock/production source mismatch",
      );
      assert.equal(
        manifest.production_manifest_sha256,
        lock.production_manifest_sha256,
        "candidate production digest mismatch",
      );
      const actual = [];
      const walk = async (directory, prefix = "") => {
        for (const item of await readdir(directory, { withFileTypes: true })) {
          const path = prefix + item.name;
          assert.ok(!item.isSymbolicLink(), "linked frozen input rejected");
          if (item.isDirectory())
            await walk(resolve(directory, item.name), path + "/");
          else {
            assert.ok(item.isFile(), "nonregular frozen input rejected");
            actual.push(path);
          }
        }
      };
      await walk(source);
      assert.deepEqual(
        actual.sort(),
        manifest.source_manifest
          .filter((item) => !item.deleted)
          .map((item) => item.path)
          .sort(),
        "unexpected frozen source input",
      );
    };
    await validateFrozen();
    await docker(
      [...buildArguments(lock, architecture, target), "--tag", tag, "."],
      3600000,
    );
    await validateFrozen();
    const built = JSON.parse(
      await docker(["image", "inspect", "--format", "{{json .}}", tag]),
    );
    assert.equal(built.Os, "linux");
    assert.equal(built.Architecture, architecture);
    assert.equal(
      built.Config?.Labels?.["org.rainsync.full-source-manifest"],
      lock.source_manifest_sha256,
      "built image source label differs from frozen candidate",
    );
    assert.equal(
      built.Config?.Labels?.["org.rainsync.source-manifest"],
      lock.production_manifest_sha256,
      "built image production source label differs",
    );
    reference = built.Id;
    if (target === "web") {
      await writeFile(
        options.get("output"),
        JSON.stringify(
          {
            schema_version: 1,
            target,
            architecture,
            image_id: reference,
            inputs,
            lock_sha256: sha(JSON.stringify(lock)),
            source_manifest_sha256: lock.source_manifest_sha256,
            production_manifest_sha256: lock.production_manifest_sha256,
            runtime_acceptance: false,
          },
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      );
      return;
    }
  } else assert.equal(action, "measure", "use verify-inputs, build or measure");
  let priorBytes, priorBinding;
  if (action === "measure") {
    assert.ok(
      options.get("binding"),
      "measure requires --binding=<original frozen-source build report>",
    );
    priorBytes = await readFile(options.get("binding"));
    priorBinding = JSON.parse(priorBytes);
  }
  const runtime = await measureRuntime(reference, architecture);
  validateRuntimeEvidence(lock, runtime, priorBinding);
  await writeFile(
    options.get("output"),
    JSON.stringify(
      {
        schema_version: 1,
        ...runtime,
        binding_kind:
          action === "build" ? "frozen-source-build" : "remeasured-bound-image",
        ...(priorBytes
          ? { original_build_binding_sha256: sha(priorBytes) }
          : {}),
        inputs,
        lock_sha256: sha(JSON.stringify(lock)),
        source_manifest_sha256: lock.source_manifest_sha256,
        production_manifest_sha256: lock.production_manifest_sha256,
        runtime_acceptance: false,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "PASS: actual image/runtime identity measured; media and hardware acceptance remain separate",
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  cli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
