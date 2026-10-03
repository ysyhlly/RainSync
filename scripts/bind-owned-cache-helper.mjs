// Build only the owned cache example in the coordinator-granted mutable target,
// then copy and bind it. Never builds inside a frozen backend/helper directory.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(
  process.env.CARGO_TARGET_DIR &&
    !process.env.CARGO_TARGET_DIR.includes("frozen"),
  "coordinator-granted mutable target required",
);
assert.ok(
  process.env.RAINSYNC_ARTIFACT_DIR && process.env.RAINSYNC_OWNED_SOAK_BINDING,
);
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const binding = JSON.parse(
  await readFile(process.env.RAINSYNC_OWNED_SOAK_BINDING),
);
assert.equal(binding.result, "passed");
const extra = [
  "apps/media-worker/examples/owned_cache_pressure.rs",
  "scripts/bind-owned-cache-helper.mjs",
  "scripts/acceptance-cache-pressure.mjs",
  "tests/cache-pressure-native.mjs",
  "tests/acceptance-cache-pressure.test.mjs",
];
const paths = [
  ...new Set([...binding.source.map((s) => s.path), ...extra]),
].sort();
const source = await Promise.all(
  paths.map(async (path) => ({
    path,
    sha256: await hash(resolve(repo, path)),
  })),
);
for (const row of binding.source)
  assert.equal(await hash(resolve(repo, row.path)), row.sha256);
const root = resolve(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "cache-pressure-build",
  randomUUID(),
);
await mkdir(root, { recursive: true, mode: 0o700 });
const args = [
  "build",
  "--locked",
  "-p",
  "rainsync-media-worker",
  "--example",
  "owned_cache_pressure",
  "-j1",
  "--message-format=json",
];
const started = new Date().toISOString();
let stdout = "",
  stderr = "";
const child = spawn("cargo", args, {
  cwd: repo,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (bytes) => (stdout += bytes));
child.stderr.on("data", (bytes) => (stderr += bytes));
const code = await new Promise((done, reject) => {
  child.once("error", reject);
  child.once("close", done);
});
await writeFile(resolve(root, "build.jsonl"), stdout);
await writeFile(resolve(root, "build.stderr"), stderr);
assert.equal(code, 0, "helper build failed; retained build output");
const messages = stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .map((v) => JSON.parse(v));
assert.equal(
  messages.findLast((v) => v.reason === "build-finished")?.success,
  true,
);
const artifact = messages.findLast(
  (v) =>
    v.reason === "compiler-artifact" &&
    v.target?.name === "owned_cache_pressure" &&
    v.target.kind.includes("example") &&
    v.executable,
);
assert.ok(artifact, "exact completed-build artifact required");
for (const row of source)
  assert.equal(
    await hash(resolve(repo, row.path)),
    row.sha256,
    `source changed during build: ${row.path}`,
  );
const path = resolve(root, "owned_cache_pressure");
await copyFile(artifact.executable, path);
const descriptor = {
  schema_version: 1,
  result: "passed",
  name: "owned_cache_pressure",
  path,
  sha256: await hash(path),
  source,
  source_digest: createHash("sha256")
    .update(JSON.stringify(source))
    .digest("hex"),
  backend_source_digest: binding.source_digest,
  baseline: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim(),
  build: {
    command: ["cargo", ...args],
    exit_code: code,
    started_at: started,
    finished_at: new Date().toISOString(),
    log_path: resolve(root, "build.jsonl"),
    log_sha256: await hash(resolve(root, "build.jsonl")),
    profile_environment: {
      CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL,
      CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG,
      CARGO_PROFILE_TEST_DEBUG: process.env.CARGO_PROFILE_TEST_DEBUG,
    },
  },
};
const descriptorPath = resolve(root, "helper-binding.json");
await writeFile(descriptorPath, JSON.stringify(descriptor, null, 2));
console.log(descriptorPath);
