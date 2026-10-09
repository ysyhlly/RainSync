// One coordinator owns each catalog HTTP/DB fixture and its final evidence.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isolatedServer } from "./server.mjs";
import { safeFailure } from "./safe-failure.mjs";
import { loadOwnerBinding } from "../../scripts/native-owner-binding.mjs";
import { withTerminationSignal } from "../../deploy/owned-process.mjs";

const repo = resolve(import.meta.dirname, "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const helpers = ["tests/fixtures/catalog-evidence.mjs", "tests/fixtures/server.mjs", "tests/fixtures/postgres.mjs", "tests/fixtures/unused-port.mjs", "tests/fixtures/playback-admission.mjs", "tests/fixtures/safe-failure.mjs", "scripts/native-owner-binding.mjs", "deploy/owned-process.mjs"];

export async function catalogFixture({ name, coordinator, baseline, baselineResult, timeout, env = {}, limitations = [] }, run) {
  let fixture, binding, reportPath, failed = false;
  const report = { schema_version: 1, mode: baseline ? "before" : "acceptance", result: "running", started_at: new Date().toISOString(), checks: [], failures: [], limitations };
  try {
    assert.equal(process.env.DATABASE_URL, undefined, "owned fixture refuses an inherited database");
    const artifacts = process.env.RAINSYNC_ARTIFACT_DIR;
    assert.ok(artifacts && isAbsolute(artifacts));
    const rel = relative(repo, artifacts);
    assert.ok(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
    const evidenceRoot = resolve(artifacts, `${name}-evidence`, randomUUID());
    await mkdir(evidenceRoot, { recursive: true });
    reportPath = resolve(evidenceRoot, "report.json");
    const files = [...new Set([coordinator, ...helpers])];
    report.coordinator = await Promise.all(files.map(async (path) => ({ path, sha256: hash(await readFile(resolve(repo, path))) })));
    binding = await loadOwnerBinding({ root: repo, target: process.env.CARGO_TARGET_DIR, path: process.env.W03_BACKEND_BINDING });
    report.backend_binding = { path: process.env.W03_BACKEND_BINDING, ...binding.summary };
    // This standard fixture mode saves cleanup evidence even on startup failure.
    process.env.RAINSYNC_FIXTURE_CLEANUP_REPORT = "1";
    await withTerminationSignal(async (termination) => {
      const signal = AbortSignal.any([termination, AbortSignal.timeout(timeout)]);
      await isolatedServer(name, async (f) => { await run(f, report, signal); signal.throwIfAborted(); }, {
        env, signal,
        beforeStart: async (f) => { fixture = f; report.fixture_id = f.id; report.fixture_root = f.root; report.postgres = f.postgresDiagnostics(); },
      });
    });
  } catch (error) {
    failed = true; report.failures.push(safeFailure(error) ?? "verification_failed");
  } finally {
    if (fixture) {
      try { report.cleanup = await fixture.verifyStopped(); }
      catch { failed = true; report.failures.push("cleanup_verification_failed"); report.cleanup = { completed: false }; }
    } else if (binding) {
      failed = true; report.failures.push("fixture_startup_unconfirmed");
    }
    // A report can become passed only after final source/binary/helper binding.
    try {
      if (binding) await binding.verify();
      for (const input of report.coordinator ?? []) assert.equal(hash(await readFile(resolve(repo, input.path))), input.sha256);
    } catch { failed = true; report.failures.push("final_binding_failed"); }
    report.finished_at = new Date().toISOString();
    report.result = failed ? "failed" : baseline ? baselineResult : "passed";
    if (reportPath) {
      try { await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n"); }
      catch { failed = true; }
    }
  }
  // Never expose assertion diffs, SQL, row projections, credentials or causes.
  if (failed) throw new Error("catalog owned fixture failed; inspect its safe evidence report");
  console.log(`${report.result}: ${report.checks.length} checks; ${reportPath}`);
}

async function holdCatalogSql(f, statement, signal) {
  const marker = `catalog_source_${randomUUID().replaceAll("-", "")}`;
  const child = f.sqlProcess(undefined, { interactive: true });
  let output = "", released = false;
  const ready = new Promise((done, reject) => {
    child.stdout.on("data", (bytes) => { output += bytes; if (output.includes(marker)) done(); });
    child.once("error", reject);
    child.done.then(() => reject(new Error("owned blocker exited before admission")), reject);
  });
  const bounded = async (work) => {
    let timer;
    try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned blocker deadline")), 12000); })]); }
    finally { clearTimeout(timer); }
  };
  async function release() {
    if (released) return;
    released = true;
    child.stdin.end("COMMIT;\n\\q\n");
    await bounded(child.done);
  }
  child.stdin.write(`BEGIN; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${statement};\n\\echo ${marker}\n`);
  try { await bounded(ready); signal.throwIfAborted(); }
  catch (error) { await release(); throw error; }
  return release;
}

export function holdSource(f, source, signal) {
  // Only a synthetic UUID from this owned fixture enters the fixed statement.
  assert.match(source, /^[0-9a-f-]{36}$/i);
  return holdCatalogSql(f, `SELECT id FROM sources WHERE id='${source}' FOR UPDATE`, signal);
}

export function holdLibraryDetailProjection(f, signal) {
  // New receipt reads meet this lock after their mutation and audit write.
  return holdCatalogSql(f, "LOCK TABLE sources IN ACCESS EXCLUSIVE MODE", signal);
}
