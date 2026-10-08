import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Required local fixture configuration; no machine-specific defaults.
const runtime = (() => {
  const required = (name, pattern, description) => {
    const value = process.env[name];
    assert.ok(
      typeof value === "string" && value.length <= 4096 &&
        !/[\x00-\x1f\x7f]/.test(value) && pattern.test(value),
      `Set ${name} to ${description}`,
    );
    return value;
  };
  const absolutePath = (name) => required(
    name,
    /^(?:\/[^\x00-\x1f\x7f:]+|[A-Za-z]:[\\/][^\x00-\x1f\x7f:]+)$/,
    "an absolute local fixture path without control characters",
  );
  const imageReference = (name) => required(
    name,
    /^(?:sha256:[0-9a-f]{64}|(?=.{1,255}$)(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?)$/,
    "a valid local Docker image reference",
  );
  return Object.freeze({
    image: imageReference("RAINSYNC_OWNER_TEST_IMAGE"),
    registry: absolutePath("RAINSYNC_OWNER_TEST_REGISTRY"),
    cargoConfig: absolutePath("RAINSYNC_OWNER_TEST_CARGO_CONFIG"),
  });
})();
// End required fixture configuration.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runId = randomUUID();
const evidence = join(root, ".runtime", "0044-owner-linux", runId);
const target = join(root, ".runtime", "0044-owner-linux-target");
mkdirSync(evidence, { recursive: true });
mkdirSync(target, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  scope: "isolated-linux-owner-and-provider-regression",
  commands: [],
  cleanup: {},
  limitations: [
    "No Server/Worker RPC integration or public HLS activation",
    "No actual client playback",
    "Historical unknown responsibilities unchanged",
  ],
};
const save = () =>
  writeFileSync(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
let number = 0,
  container;
async function command(
  program,
  args,
  { live = false, allowFailure = false } = {},
) {
  const child = spawn(program, args, {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
    if (live) process.stdout.write(bytes);
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
    if (live) process.stderr.write(bytes);
  });
  const result = await new Promise((done) => {
    child.once("error", (error) => done({ error: error.message }));
    child.once("close", (status, signal) => done({ status, signal }));
  });
  const record = { program, args, ...result, stdout, stderr };
  const path = `${String(++number).padStart(3, "0")}.json`;
  writeFileSync(join(evidence, path), JSON.stringify(record, null, 2) + "\n");
  report.commands.push({
    path,
    sha256: hash(readFileSync(join(evidence, path))),
  });
  save();
  if (!allowFailure && result.status !== 0)
    throw new Error(
      `${program} failed (${result.status}): ${stderr || result.error}`,
    );
  return record;
}
try {
  report.baseCommit = (
    await command("git", ["rev-parse", "HEAD"])
  ).stdout.trim();
  const files = (
    await command("git", [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
    ])
  ).stdout
    .trim()
    .split(/\r?\n/);
  const inputs = [
    ...new Set(
      files.filter(
        (path) =>
          /^(apps|crates)\/.*(\.rs|Cargo\.toml|\.json)$/.test(path) ||
          [
            "Cargo.toml",
            "Cargo.lock",
            "tests/static-hls-owner-linux.mjs",
            "tests/fixtures/Dockerfile.static-hls-owner",
            "tests/fixtures/Dockerfile.static-hls-owner-clippy",
          ].includes(path),
      ),
    ),
  ].sort();
  report.inputs = inputs.map((path) => ({
    path,
    sha256: hash(readFileSync(join(root, path))),
  }));
  const image = JSON.parse(
    (
      await command("docker", [
        "image",
        "inspect",
        runtime.image,
      ])
    ).stdout,
  )[0];
  assert.equal(image.Os, "linux");
  report.imageId = image.Id;
  const registry = runtime.registry;
  const config = runtime.cargoConfig;
  report.cargoConfigSha256 = hash(readFileSync(config));
  const script = [
    "set -eu",
    "rustc -vV",
    "ffprobe -version",
    "ffmpeg -version",
    "cargo test --offline --locked -p media-core static_hls:: -- --nocapture",
    "cargo test --offline --locked -p media-core static_hls_probe:: -- --nocapture",
    "cargo test --offline --locked -p providers --test static_hls_capture -- --nocapture --test-threads=1",
    "cargo clippy --offline --locked -p media-core -p persistence -p providers --all-targets -- -D warnings",
    "cargo clippy --offline --locked -p rainsync-server --all-targets -- -D warnings",
  ].join("\n");
  container = (
    await command("docker", [
      "create",
      "--name",
      `rainsync-owner-${runId}`,
      "--label",
      `io.rainsync.owner-run=${runId}`,
      "--network",
      "none",
      "--memory",
      "4g",
      "--pids-limit",
      "256",
      "--workdir",
      "/workspace",
      "--mount",
      `type=bind,source=${root},target=/workspace,readonly`,
      "--mount",
      `type=bind,source=${registry},target=/usr/local/cargo/registry,readonly`,
      "--mount",
      `type=bind,source=${config},target=/usr/local/cargo/config.toml,readonly`,
      "--mount",
      `type=bind,source=${target},target=/target`,
      "--env",
      "CARGO_TARGET_DIR=/target",
      "--env",
      "CARGO_BUILD_JOBS=4",
      "--env",
      "CARGO_INCREMENTAL=0",
      "--env",
      "CARGO_PROFILE_DEV_DEBUG=0",
      "--env",
      "CARGO_PROFILE_TEST_DEBUG=0",
      "--env",
      "RAINSYNC_HLS_CAPTURE_ARTIFACT_ROOT=/tmp/rainsync-provider-artifacts",
      image.Id,
      "/bin/sh",
      "-c",
      script,
    ])
  ).stdout.trim();
  assert.match(container, /^[0-9a-f]{64}$/);
  report.containerId = container;
  save();
  await command("docker", ["start", "-a", container], { live: true });
  report.inputsUnchanged = report.inputs.every(
    ({ path, sha256 }) => hash(readFileSync(join(root, path))) === sha256,
  );
  assert.ok(report.inputsUnchanged, "source changed during the checks");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (container) {
    try {
      const stopped = JSON.parse(
        (await command("docker", ["inspect", container])).stdout,
      )[0];
      assert.equal(stopped.Id, container);
      assert.equal(stopped.Config.Labels["io.rainsync.owner-run"], runId);
      report.cleanup = {
        id: container,
        state: stopped.State,
        mounts: stopped.Mounts,
      };
      const artifacts = join(evidence, "artifacts");
      mkdirSync(artifacts, { recursive: true });
      const copied = await command(
        "docker",
        ["cp", `${container}:/tmp/rainsync-provider-artifacts/.`, artifacts],
        { allowFailure: true },
      );
      report.artifactsCopied = copied.status === 0;
      assert.equal(stopped.State.Running, false);
      assert.equal(stopped.State.Pid, 0);
      assert.equal(stopped.State.ExitCode, 0);
      assert.equal(stopped.State.OOMKilled, false);
      assert.equal(stopped.HostConfig.NetworkMode, "none");
      await command("docker", ["rm", container]);
      report.cleanup.removed = true;
    } catch (error) {
      report.cleanup.error = error.message;
      report.passed = false;
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log(`Evidence: ${join(evidence, "report.json")}`);
}
