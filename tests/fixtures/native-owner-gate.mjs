// Owner-gate reports contain only digests, named checks and positive cleanup
// receipts. Credentials, request documents, SQL and raw logs stay local.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withTerminationSignal } from "../../deploy/owned-process.mjs";
import { loadOwnerBinding, sha256 } from "../../scripts/native-owner-binding.mjs";
import { isolatedServer } from "./server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const commonInputs = [
  "scripts/native-owner-binding.mjs", "tests/fixtures/native-owner-gate.mjs",
  "tests/fixtures/server.mjs", "tests/fixtures/postgres.mjs",
  "tests/fixtures/unused-port.mjs", "tests/fixtures/playback-admission.mjs",
  "deploy/owned-process.mjs",
];

export async function nativeOwnerGate(name, run, { requireTest = false } = {}) {
  assert.ok(isAbsolute(process.env.RAINSYNC_ARTIFACT_DIR ?? ""),
    "Set an absolute owned RAINSYNC_ARTIFACT_DIR");
  const directory = resolve(process.env.RAINSYNC_ARTIFACT_DIR,
    "owner-gates", name, randomUUID());
  await mkdir(directory, { recursive: true });
  const reportPath = resolve(directory, "report.json");
  const report = {
    schema_version: 1, gate: name, result: "running",
    started_at: new Date().toISOString(),
    scope: "Owned synthetic PostgreSQL and loopback HTTP; no provider credentials or production data",
    checks: [], cleanup: { completed: false },
  };
  let fixture, binding, failure, stage = "prerequisites";
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await save();
  try {
    assert.ok(!process.env.DATABASE_URL,
      "Owner gates reject caller-supplied DATABASE_URL; the fixture owns its database");
    assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
      "Set RAINSYNC_NATIVE_POSTGRES_BIN; mandatory owner gates require native PostgreSQL");
    binding = await loadOwnerBinding({
      root, target: process.env.CARGO_TARGET_DIR,
      path: process.env.W03_BACKEND_BINDING, requireTest,
    });
    report.backend_binding = binding.summary;
    report.coordinator = await Promise.all([
      ...commonInputs, `tests/${name}.mjs`,
    ].map(async (path) => ({ path, sha256: sha256(await readFile(resolve(root, path))) })));
    stage = "fixture";
    await withTerminationSignal(async (termination) => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(Error("owner_gate_timeout")), 180000);
      const signal = AbortSignal.any([termination, deadline.signal]);
      try {
        await isolatedServer(name, async (f) => {
          fixture = f;
          report.fixture_id = f.id;
          report.postgres = f.postgresDiagnostics();
          await save();
          await run(f, {
            report, binding, signal,
            check: (name) => report.checks.push({ name, result: "passed" }),
          });
          signal.throwIfAborted();
        }, {
          signal, binary: binding.server,
          beforeStart: (f) => { fixture = f; },
        });
      } finally {
        clearTimeout(timer);
      }
    });
    stage = "binding_recheck";
    await binding.verify();
    for (const input of report.coordinator)
      assert.equal(sha256(await readFile(resolve(root, input.path))), input.sha256,
        "Owner coordinator source changed during validation");
    report.inputs_unchanged = true;
  } catch (error) {
    failure = error;
    // Never serialize exception messages: driver/SQL errors can contain secrets.
    report.failure = { stage, code: "owner_gate_failed" };
  } finally {
    if (fixture) {
      try {
        report.cleanup = await fixture.verifyStopped();
      } catch (error) {
        failure ??= error;
        report.cleanup = { completed: false, code: "owned_cleanup_unconfirmed" };
      }
    } else {
      report.cleanup = stage === "prerequisites"
        ? { completed: true, resources_started: false }
        : { completed: false, code: "fixture_startup_cleanup_unconfirmed" };
    }
    report.result = failure ? "failed" : "passed";
    report.finished_at = new Date().toISOString();
    await save();
    console.log(`Owner gate evidence: ${reportPath}`);
  }
  if (failure) {
    // Detailed failures are useful on the local console, but only the safe JSON
    // above is eligible for CI upload. Keep paths/credentials out of the report.
    console.error(failure);
    throw Error(`${name} failed; see the owner-gate report and local fixture logs`);
  }
  return report;
}
