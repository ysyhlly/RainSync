// Owned local writer + disposable PostgreSQL. No Agent or existing service.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedPostgres, verifyPidAbsent } from "./fixtures/postgres.mjs";

assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Set an external evidence directory");
const id = `cache_writer_${randomUUID().replaceAll("-", "")}`;
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, "cache-writer-safety", id);
await mkdir(root, { recursive: true });
const password = randomBytes(24).toString("hex");
const db = isolatedPostgres({ root, id, password, name: "cache-writer" });
const redact = value => String(value).replaceAll(password, "[redacted]");
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const report = {
  schema_version: 1,
  run_id: id,
  baseline: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  started_at: new Date().toISOString(),
  result: "running",
  scope: "short owned writer and persisted cache invariants; no FFmpeg, Agent, real ENOSPC or 72-hour acceptance",
  source: [],
  commands: [],
  cleanup: [],
};
const save = () => writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2));
async function execute(command, args, name, env = process.env, timeoutMs = 180000) {
  const record = { command, args, started_at: new Date().toISOString() };
  report.commands.push(record);
  await save();
  let stdout = "", stderr = "";
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  record.pid = child.pid ?? null;
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  const timer = setTimeout(() => {
    record.timed_out = true;
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGKILL");
  }, timeoutMs);
  try {
    record.exit_code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => { record.signal = signal; record.close_observed = true; done(code); });
    });
  } finally { clearTimeout(timer); }
  record.finished_at = new Date().toISOString();
  record.pid_absent = !child.pid || verifyPidAbsent(child.pid);
  await writeFile(resolve(root, `${name}.stdout`), redact(stdout));
  await writeFile(resolve(root, `${name}.stderr`), redact(stderr));
  await save();
  assert.equal(record.pid_absent, true, "owned command exited");
  assert.equal(record.exit_code, 0, `${name} failed; inspect preserved output`);
  assert.notEqual(record.timed_out, true);
  return stdout;
}
try {
  const tracked = execFileSync("git", ["ls-files", "crates", "migrations", "Cargo.toml", "Cargo.lock", "tests/fixtures/postgres.mjs"], { encoding: "utf8" }).trim().split(/\r?\n/);
  const paths = [...new Set([...tracked, "crates/persistence/src/cache_writers.rs", "crates/persistence/examples/verify_cache_writer_safety.rs", "tests/cache-writer-safety.mjs"])].sort();
  report.source = await Promise.all(paths.map(async path => ({ path, sha256: await hash(path) })));
  const names = ["verify_cache_budget", "verify_cache_leases", "verify_output_cleanup", "verify_cache_writer_safety"];
  const output = await execute("cargo", ["build", "--locked", "-p", "persistence", "-j1", "--message-format=json", ...names.flatMap(name => ["--example", name])], "build", process.env, 300000);
  const artifacts = output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(item => item.reason === "compiler-artifact" && item.executable && names.includes(item.target?.name));
  report.binaries = await Promise.all(names.map(async name => {
    const artifact = artifacts.find(item => item.target.name === name);
    assert.ok(artifact, `${name} artifact belongs to the completed build`);
    const path = resolve(root, name + (process.platform === "win32" ? ".exe" : ""));
    await copyFile(artifact.executable, path);
    return { name, path, sha256: await hash(path) };
  }));
  await db.start();
  report.postgresql = db.diagnostics();
  const env = { ...process.env, RAINSYNC_ISOLATED_TEST: "1", DATABASE_URL: db.url };
  const regression = report.binaries.find(item => item.name === "verify_cache_writer_safety");
  await execute(regression.path, ["--migrate-only"], "migrate", env);
  for (const binary of report.binaries) {
    await execute(binary.path, [], binary.name, env);
    assert.equal(await hash(binary.path), binary.sha256, "executed binary stayed unchanged");
  }
  for (const source of report.source) assert.equal(await hash(source.path), source.sha256, `source stayed unchanged: ${source.path}`);
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
  console.log(`${report.result.toUpperCase()}: cache writer safety; ${resolve(root, "report.json")}`);
}
