// D lane: real PostgreSQL faults in the native Worker test executable.
// Every run owns a new database, random port and external evidence directory.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isolatedPostgres, verifyPidAbsent } from "./fixtures/postgres.mjs";

assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Set an external evidence directory");
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, "This entry requires native PostgreSQL 17");
const id = `d_reliability_${randomUUID().replaceAll("-", "")}`;
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, "worker-reliability", id);
await mkdir(root, { recursive: true });
const password = randomBytes(24).toString("hex");
const db = isolatedPostgres({ root, id, password, name: "d-reliability" });
const redact = value => String(value).replaceAll(password, "[redacted]");
const sha256 = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const report = {
  schema_version: 1,
  run_id: id,
  baseline: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  started_at: new Date().toISOString(),
  result: "running",
  source: [],
  commands: [],
  cleanup: [],
  scope: "short isolated faults; no two-hour or production acceptance",
  profile: Object.fromEntries(["CARGO_BUILD_JOBS", "CARGO_PROFILE_DEV_DEBUG", "CARGO_PROFILE_TEST_DEBUG", "CARGO_INCREMENTAL"].map(k => [k, process.env[k] ?? null])),
};
const save = () => writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2));
async function execute(command, args, name, env = process.env, deadline = 150000) {
  let stdout = "", stderr = "";
  const began = performance.now();
  const record = { command, args, started_at: new Date().toISOString() };
  report.commands.push(record);
  await save();
  const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  record.pid = child.pid ?? null;
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const timer = setTimeout(() => {
    record.timed_out = true;
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGKILL");
  }, deadline);
  try {
    record.exit_code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => { record.signal = signal; record.close_observed = true; done(code); });
    });
  } finally { clearTimeout(timer); }
  record.elapsed_seconds = (performance.now() - began) / 1000;
  record.finished_at = new Date().toISOString();
  record.pid_absent = !child.pid || verifyPidAbsent(child.pid);
  await writeFile(resolve(root, `${name}.stdout`), redact(stdout));
  await writeFile(resolve(root, `${name}.stderr`), redact(stderr));
  await save();
  assert.equal(record.pid_absent, true, "owned test process exited");
  assert.equal(record.exit_code, 0, `${name} failed; inspect its preserved output`);
  assert.notEqual(record.timed_out, true, `${name} reached its deadline`);
  return stdout;
}
try {
  const files = execFileSync("git", ["ls-files", "apps/media-worker", "crates", "migrations", "Cargo.toml", "Cargo.lock"], { encoding: "utf8" }).trim().split(/\r?\n/).sort();
  // Include the harness itself, which may be untracked before handoff.
  files.push("tests/worker-reliability.mjs", "tests/fixtures/postgres.mjs");
  report.source = await Promise.all(files.map(async path => ({ path, sha256: await sha256(path) })));
  const output = await execute("cargo", ["test", "--locked", "-p", "rainsync-media-worker", "-j1", "--no-run", "--message-format=json"], "build", process.env, 300000);
  const artifact = output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(item => item.reason === "compiler-artifact" && item.target?.name === "rainsync-media-worker" && item.profile?.test && item.executable);
  assert.ok(artifact, "locked Worker test executable was built");
  const binary = resolve(root, `worker-under-test${process.platform === "win32" ? ".exe" : ""}`);
  await copyFile(artifact.executable, binary);
  report.binary = { path: binary, sha256: await sha256(binary) };
  const exampleNames = ["verify_job_attempts", "verify_cache_budget", "verify_cache_leases", "verify_media_queue", "verify_queue_fairness", "verify_output_snapshots", "verify_output_cleanup"];
  await execute("cargo", ["build", "--locked", "-p", "persistence", "-j1", "--examples"], "storage-build", process.env, 300000);
  report.storage_binaries = await Promise.all(exampleNames.map(async name => {
    const path = resolve(root, `${name}${process.platform === "win32" ? ".exe" : ""}`);
    await copyFile(resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug/examples", `${name}${process.platform === "win32" ? ".exe" : ""}`), path);
    return { name, path, sha256: await sha256(path) };
  }));
  // Package-scoped tests can relink the non-test Worker with a narrower
  // dependency feature set. Keep the owned test/example copies, then restore
  // the workspace services before later fixtures verify their build binding.
  await execute("cargo", ["build", "--workspace", "--bins", "--examples", "--locked", "-j1"], "workspace-build", process.env, 300000);
  await db.start();
  report.postgresql = db.diagnostics();
  assert.equal(db.database, `rainsync_${id}`);
  await execute(binary, ["--ignored", "--exact", "transfer_state::tests::postgres_transfer_health", "--nocapture"], "relay-health", {
    ...process.env,
    RAINSYNC_ISOLATED_TEST: "1",
    WORKER_RELIABILITY_DATABASE_URL: db.url,
    WORKER_RELIABILITY_REPORT: resolve(root, "relay-cases.json"),
  });
  report.relay_cases = JSON.parse(await readFile(resolve(root, "relay-cases.json"), "utf8"));
  assert.equal(report.relay_cases.length, 6);
  // These existing examples use synthetic publication bytes to isolate real
  // PostgreSQL fencing/budget/queue contracts; they do not prove media decode.
  for (const example of report.storage_binaries) {
    await execute(example.path, [], example.name, { ...process.env, RAINSYNC_ISOLATED_TEST: "1", DATABASE_URL: db.url });
    assert.equal(await sha256(example.path), example.sha256, "executed storage binary stayed unchanged");
  }
  await execute(binary, ["--skip", "postgres_transfer_health", "--skip", "postgres_worker_health"], "worker-unit", process.env);
  assert.equal(await sha256(binary), report.binary.sha256, "executed binary stayed unchanged");
  for (const entry of report.source) assert.equal(await sha256(entry.path), entry.sha256, `source stayed unchanged: ${entry.path}`);
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failure = redact(error.stack ?? error);
  process.exitCode = 1;
} finally {
  try { await db.stop(); report.cleanup.push(await db.verifyStopped()); }
  catch (error) { report.result = "failed"; report.cleanup.push({ stopped: false, error: redact(error.message) }); process.exitCode = 1; }
  report.finished_at = new Date().toISOString();
  await save();
  console.log(`${report.result.toUpperCase()}: D Worker reliability; ${resolve(root, "report.json")}`);
}
