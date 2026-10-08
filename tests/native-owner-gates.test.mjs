import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  assertOwnerRun, backendSnapshot, loadOwnerBinding, nativeOwnerCases,
  nativeOwnerTest, ownerTestArtifact, sha256,
} from "../scripts/native-owner-binding.mjs";
import {
  staticHlsConfiguration, validateStaticImage,
} from "../scripts/check-static-hls-prerequisites.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imageId = `sha256:${"a".repeat(64)}`;
const cargoArtifact = (executable, test = true) => JSON.stringify({
  reason: "compiler-artifact", profile: { test },
  target: { name: "rainsync-server", kind: ["bin"] }, executable,
});

test("Cargo identifies one exact test artifact; ordinary/stale/ambiguous artifacts cannot be selected", () => {
  const target = resolve(tmpdir(), "owned-target");
  const binary = resolve(target, "debug/deps/rainsync_server-1234");
  assert.equal(ownerTestArtifact([
    cargoArtifact(resolve(target, "debug/rainsync-server"), false),
    cargoArtifact(binary), cargoArtifact(binary),
    JSON.stringify({ reason: "build-finished", success: true }),
  ].join("\n"), target), binary);
  assert.throws(() => ownerTestArtifact("", target), /exactly one/);
  assert.throws(() => ownerTestArtifact(cargoArtifact(binary, false), target), /exactly one/);
  assert.throws(() => ownerTestArtifact([
    cargoArtifact(binary), cargoArtifact(binary + "-other"),
  ].join("\n"), target), /exactly one/);
  assert.throws(() => ownerTestArtifact(cargoArtifact(resolve(tmpdir(), "unbound")), target), /target directory/);
});

test("success requires the ignored Rust fixture and every owner behavior, never zero tests", () => {
  const cases = nativeOwnerCases.map((name) => `PASS: native owned real-HTTP lifecycle case ${name}`).join("\n");
  const summary = "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 300 filtered out;";
  assertOwnerRun(cases + "\n" + summary);
  assertOwnerRun((cases + "\n" + summary).replaceAll("\n", "\r\n"));
  assert.throws(() => assertOwnerRun(cases + "\ntest result: ok. 0 passed; 0 failed; 0 ignored;"), /exact ignored/);
  for (const missing of nativeOwnerCases)
    assert.throws(() => assertOwnerRun(cases.replace(`PASS: native owned real-HTTP lifecycle case ${missing}`, "") + "\n" + summary), /did not complete/);
});

async function ownedBindingFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "rainsync-owner-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = resolve(root, "target");
  for (const path of ["crates", "apps/server", "apps/media-worker", "apps/nas-agent", "migrations", "scripts", "target/debug/deps", "target/debug/examples"])
    await mkdir(resolve(root, path), { recursive: true });
  for (const path of ["Cargo.toml", "Cargo.lock", "apps/server/main.rs", "scripts/bind-native-backend.mjs", "scripts/native-owner-binding.mjs"])
    await writeFile(resolve(root, path), "owned synthetic input\n");
  const suffix = process.platform === "win32" ? ".exe" : "";
  const binary = async (name, path) => {
    await writeFile(path, `owned synthetic ${name}`);
    return { name, path, sha256: sha256(await readFile(path)) };
  };
  const source = await backendSnapshot(root);
  const binding = {
    schema_version: 1, result: "passed", platform: process.platform,
    source, source_digest: sha256(JSON.stringify(source)),
    producers: await Promise.all(["scripts/bind-native-backend.mjs", "scripts/native-owner-binding.mjs"].map(async (path) => ({ path, sha256: sha256(await readFile(resolve(root, path))) }))),
    binaries: [await binary("rainsync-server", resolve(target, `debug/rainsync-server${suffix}`))],
    test_helpers: [await binary("fixture_password", resolve(target, `debug/examples/fixture_password${suffix}`))],
    owner_fixtures: [{
      ...await binary("rainsync-server-owner-tests", resolve(target, `debug/deps/rainsync_server-1234${suffix}`)),
      test_name: nativeOwnerTest,
      build: { exit_code: 0, command: ["cargo", "test", "-p", "rainsync-server", "--bin", "rainsync-server", "--no-run", "--locked"] },
    }],
    build: { exit_code: 0, rustc: "synthetic", cargo: "synthetic" },
  };
  const path = resolve(root, "binding.json");
  const save = () => writeFile(path, JSON.stringify(binding));
  await save();
  return { root, target, path, binding, save };
}

test("native owner binding rejects stale/new source, altered executable and changed evidence", async (t) => {
  const f = await ownedBindingFixture(t);
  const bound = await loadOwnerBinding({ ...f, requireTest: true });
  assert.equal(bound.owner.path, f.binding.owner_fixtures[0].path);
  await bound.verify();
  const added = resolve(f.root, "apps/server/new.rs");
  await writeFile(added, "new input");
  await assert.rejects(bound.verify(), /Backend inputs changed/);
  await rm(added);
  const artifact = f.binding.owner_fixtures[0].path;
  const original = await readFile(artifact);
  await writeFile(artifact, "replaced test runner");
  await assert.rejects(bound.verify(), /Bound executable changed/);
  await writeFile(artifact, original);
  await writeFile(f.path, JSON.stringify({ ...f.binding, result: "failed" }));
  await assert.rejects(bound.verify(), /Build binding changed/);
});

test("owner test must be separately built and bound to the executed target", async (t) => {
  const f = await ownedBindingFixture(t);
  await assert.rejects(loadOwnerBinding({ ...f, target: resolve(f.root, "other"), requireTest: true }), /Server actually executed/);
  delete f.binding.owner_fixtures;
  await f.save();
  await assert.rejects(loadOwnerBinding({ ...f, requireTest: true }), /--owner-fixtures/);
  await loadOwnerBinding(f); // The API-only cleanup fixture needs no Rust test driver.
});

test("missing/unsafe native prerequisites fail with a credential-free report and no resource claim", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rainsync-owner-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, ["tests/room-cleanup-native.mjs"], {
    cwd: repo, encoding: "utf8", timeout: 10000,
    env: { ...process.env, RAINSYNC_ARTIFACT_DIR: directory,
      DATABASE_URL: "postgres://SECRET:PRIVATE@production.invalid/data" },
  });
  assert.equal(run.status, 1);
  const parent = resolve(directory, "owner-gates/room-cleanup-native");
  const [id] = await readdir(parent);
  const text = await readFile(resolve(parent, id, "report.json"), "utf8");
  const report = JSON.parse(text);
  assert.equal(report.result, "failed");
  assert.equal(report.failure.stage, "prerequisites");
  assert.deepEqual(report.cleanup, { completed: true, resources_started: false });
  assert.doesNotMatch(text, /SECRET|PRIVATE|production\.invalid|postgres:\/\/|stack/i);
});

test("static HLS preflight requires pinned local Linux images and explicit offline paths", () => {
  const env = {
    RAINSYNC_OWNER_TEST_IMAGE: imageId,
    RAINSYNC_NATIVE_TEST_IMAGE: `registry.invalid/fixture@${imageId}`,
    RAINSYNC_SQL_POSTGRES_IMAGE: imageId,
    RAINSYNC_OWNER_TEST_REGISTRY: resolve(tmpdir(), "registry"),
    RAINSYNC_OWNER_TEST_CARGO_CONFIG: resolve(tmpdir(), "config.toml"),
  };
  assert.equal(staticHlsConfiguration(env).image, imageId);
  assert.equal(staticHlsConfiguration(env, { postgres: true }).postgresImage, imageId);
  assert.throws(() => staticHlsConfiguration({}), /RAINSYNC_OWNER_TEST_IMAGE/);
  assert.throws(() => staticHlsConfiguration({ ...env, RAINSYNC_OWNER_TEST_IMAGE: "fixture:latest" }), /immutable/);
  assert.throws(() => staticHlsConfiguration({ ...env, RAINSYNC_OWNER_TEST_REGISTRY: "relative" }), /absolute/);
  assert.throws(() => staticHlsConfiguration({ ...env, RAINSYNC_OWNER_TEST_REGISTRY: resolve(tmpdir(), "registry,readonly") }), /commas/);
  const image = { Id: imageId, Os: "linux", Config: { StopSignal: "SIGINT", Env: ["PG_MAJOR=17"] } };
  assert.equal(validateStaticImage(image, { postgres: true }), imageId);
  assert.throws(() => validateStaticImage({ ...image, Os: "windows" }), /Linux/);
  assert.throws(() => validateStaticImage({ ...image, Config: { StopSignal: "SIGINT", Env: ["PG_MAJOR=16"] } }, { postgres: true }), /PostgreSQL 17/);
});

test("CI keeps owner/cleanup gates mandatory and retains only safe summaries", async () => {
  const workflow = await readFile(resolve(repo, ".github/workflows/ci.yml"), "utf8");
  const ownerJob = workflow.slice(workflow.indexOf("  owner-gates:"));
  assert.ok(ownerJob.startsWith("  owner-gates:"));
  const jobEnvironment = ownerJob.slice(ownerJob.indexOf("    env:"), ownerJob.indexOf("    steps:"));
  assert.doesNotMatch(jobEnvironment, /\$\{\{\s*runner\./,
    "runner context is unavailable in jobs.<job_id>.env");
  for (const name of ["RAINSYNC_ARTIFACT_DIR", "RAINSYNC_RUNTIME_ROOT", "CARGO_TARGET_DIR"])
    assert.ok(ownerJob.includes(`echo "${name}=$RUNNER_TEMP/`),
      "Runner-local output paths must be assigned by a step through GITHUB_ENV");
  for (const command of ["--owner-fixtures", "test:native-delivery-owner", "test:room-cleanup-native", "test:room-command-transactions", "test:owner-gate-contracts"])
    assert.ok(ownerJob.includes(command), command);
  for (const gate of ["test:native-delivery-owner", "test:room-cleanup-native", "test:room-command-transactions"]) {
    const step = ownerJob.split(/(?=      - name:)/).find((text) => text.includes(`npm run ${gate}`));
    assert.match(step, /if: \$\{\{ !cancelled\(\) && steps\.binding\.outcome == 'success' \}\}/,
      "Independent gates must run after another gate fails, but never with an unbound backend");
  }
  assert.doesNotMatch(ownerJob, /continue-on-error|paths-ignore|if-no-files-found: ignore/);
  assert.match(ownerJob, /if: always\(\)/);
  assert.match(ownerJob, /owner-gates\/\*\*\/report\.json/);
  assert.doesNotMatch(ownerJob, /path:.*(?:\.log|request\.json)/);
  assert.ok(workflow.includes("npm run test:lifecycle-capabilities"));
  assert.ok(workflow.includes("npm run test:parallel-integration"));
});
