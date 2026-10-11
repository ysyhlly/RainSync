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
import { privateFailureDetails } from "./short-platform-account-response.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const commonInputs = [
  "scripts/native-owner-binding.mjs", "tests/fixtures/native-owner-gate.mjs",
  "tests/fixtures/server.mjs", "tests/fixtures/postgres.mjs",
  "tests/fixtures/unused-port.mjs", "tests/fixtures/playback-admission.mjs",
  "deploy/owned-process.mjs", "tests/fixtures/short-platform-account-response.mjs",
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
    checks: [], cleanup: { completed: false }, failures: [],
  };
  let fixture, binding, coordinatorCaptured = false, stage = "prerequisites";
  const failures = [];
  const fail = (error, code, at = stage) => {
    failures.push(error);
    report.failures.push({ stage: at, code });
    report.failure ??= { stage: at, code };
  };
  async function privateFailures(label) {
    let bytes;
    try {
      bytes = JSON.stringify(privateFailureDetails(new AggregateError(
        [...failures], "owner_gate_original_and_following_failures",
      ))) + "\n";
    } catch (error) {
      fail(error, "private_failure_serialization_failed", "evidence");
      bytes = '{"code":"private_failure_serialization_failed","details":"raw failure details unavailable"}\n';
    }
    try {
      await writeFile(resolve(directory, label + ".private.json"), bytes, { flag: "wx", mode: 0o600 });
    } catch (error) { fail(error, "private_failure_write_failed", "evidence"); }
  }
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  try {
    await save();
    assert.ok(!process.env.DATABASE_URL,
      "Owner gates reject caller-supplied DATABASE_URL; the fixture owns its database");
    assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
      "Set RAINSYNC_NATIVE_POSTGRES_BIN; mandatory owner gates require native PostgreSQL");
    binding = await loadOwnerBinding({
      root, target: process.env.CARGO_TARGET_DIR,
      path: process.env.W03_BACKEND_BINDING, requireTest,
    });
    report.backend_binding = binding.summary;
    report.coordinator = [];
    for (const path of [...commonInputs, `tests/${name}.mjs`])
      report.coordinator.push({ path, sha256: sha256(await readFile(resolve(root, path))) });
    coordinatorCaptured = true;
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
  } catch (error) {
    // Never serialize exception messages into the public report.
    fail(error, "owner_gate_failed");
  } finally {
    // Independent rechecks still run after runtime or earlier recheck failure.
    let inputsUnchanged = Boolean(binding && coordinatorCaptured);
    if (binding) {
      try { await binding.verify(); }
      catch (error) {
        inputsUnchanged = false;
        fail(error, "backend_binding_recheck_failed", "binding_recheck");
      }
    }
    for (const input of report.coordinator ?? []) {
      try {
        assert.equal(sha256(await readFile(resolve(root, input.path))), input.sha256,
          "Owner coordinator source changed during validation");
      } catch (error) {
        inputsUnchanged = false;
        fail(error, "coordinator_recheck_failed", "binding_recheck");
      }
    }
    report.inputs_unchanged = inputsUnchanged;
    if (fixture) {
      try {
        report.cleanup = await fixture.verifyStopped();
      } catch (error) {
        fail(error, "owned_cleanup_unconfirmed", "cleanup");
        report.cleanup = { completed: false, code: "owned_cleanup_unconfirmed" };
      }
    } else {
      report.cleanup = stage === "prerequisites"
        ? { completed: true, resources_started: false }
        : { completed: false, code: "fixture_startup_cleanup_unconfirmed" };
    }
    if (failures.length) await privateFailures("original-and-following-failures");
    report.result = failures.length ? "failed" : "passed";
    report.finished_at = new Date().toISOString();
    try { await save(); }
    catch (error) {
      fail(error, "final_report_write_failed", "report");
      report.result = "failed";
      await privateFailures("final-report-failure");
    }
    console.log(`Owner gate evidence: ${reportPath}`);
  }
  if (failures.length) {
    // Node prints cause/errors even when non-enumerable. Keep the
    // terminal error safe while retaining exact ordered objects for callers and
    // the explicit private serializer above, even when disk receipts fail.
    console.error("owner_gate_failed; see the private local failure receipts");
    const error = Error(`${name} failed; see the owner-gate report and local fixture logs`);
    Object.defineProperty(error, "privateErrors", { value: [...failures] });
    throw error;
  }
  return report;
}
