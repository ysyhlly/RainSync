// Concrete cache-evict operation for a new native fixture. It never builds,
// accepts a production DB/target URL, modifies disk limits, or fills a volume.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import {
  isolatedPostgres,
  verifyPidAbsent,
} from "../tests/fixtures/postgres.mjs";
import { ownedProcess } from "../deploy/owned-process.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
export function validateCachePressureReceipt(receipt, runId) {
  assert.equal(receipt.schema_version, 1);
  assert.equal(receipt.run_id, runId);
  assert.equal(receipt.kind, "cache-evict");
  assert.equal(receipt.result, "passed");
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.release_ready, false);
  assert.equal(receipt.no_f3_claim, true);
  assert.equal(receipt.process_scope_cleanup, true);
  const e = receipt.evidence;
  const measuredBytes = (value, minimum = 0) =>
    assert.ok(
      Number.isSafeInteger(value) && value >= minimum,
      "measured byte counts must be nonnegative safe integers",
    );
  measuredBytes(e.quota_bytes, 1);
  measuredBytes(e.observed_pressure_bytes, 1);
  assert.ok(e.observed_pressure_bytes >= e.quota_bytes);
  assert.ok(e.deleted_inactive_outputs.length > 0);
  assert.equal(e.sweeps.length, 2);
  for (const sweep of e.sweeps) {
    measuredBytes(sweep.before_bytes);
    measuredBytes(sweep.after_bytes);
    assert.equal(sweep.quota_bytes, e.quota_bytes);
    assert.ok(sweep.after_bytes < sweep.quota_bytes);
    assert.ok(sweep.disk_headroom_fraction > 0.1);
    assert.equal(sweep.error, null);
  }
  assert.ok(e.sweeps[0].after_bytes < e.sweeps[0].before_bytes);
  assert.equal(e.reader.survived, true);
  assert.equal(e.reader.lease_observed_live, true);
  measuredBytes(e.reader.file_bytes, 1);
  assert.match(e.reader.sha256, /^[a-f0-9]{64}$/);
  assert.ok(e.reader.scope.includes("not HTTP backpressure"));
  assert.equal(e.writer.live_after_sweeps, true);
  measuredBytes(e.writer.before_bytes);
  measuredBytes(e.writer.after_bytes, 1);
  measuredBytes(e.writer.reserved_bytes, 1);
  assert.ok(e.writer.after_bytes > e.writer.before_bytes);
  assert.equal(e.writer.unreaped_budget_release_refused, true);
  assert.equal(e.writer.scope_drain_confirmed, true);
  assert.equal(e.writer.receipt_after_drain, true);
  assert.equal(e.released_reader_writer_sweep.after_bytes, 0);
  measuredBytes(e.unknown_obligations.effective_reserved_bytes, 1);
  measuredBytes(e.unknown_obligations.capacity_error.before_bytes, 1);
  measuredBytes(e.unknown_obligations.capacity_error.after_bytes, 1);
  assert.equal(
    e.unknown_obligations.capacity_error.before_bytes,
    e.unknown_obligations.capacity_error.after_bytes,
    "unknown directory must remain unchanged",
  );
  assert.equal(e.unknown_obligations.missing_receipt_blocks, true);
  assert.equal(e.unknown_obligations.missing_job_blocks, true);
  assert.equal(e.unknown_obligations.new_reservation_rejected, true);
  assert.equal(e.unknown_obligations.receipt_fabricated, false);
  assert.equal(e.unknown_obligations.recovery_attempted, false);
  assert.equal(
    e.unknown_obligations.capacity_error.error,
    "cache_capacity_exceeded",
  );
  assert.equal(e.outputs.length, 4);
  for (const output of e.outputs) {
    assert.equal(output.published, true);
    assert.equal(output.encoder_wait_success, true);
    assert.equal(output.first_fragment_decode, true);
    assert.equal(output.scope_drain_confirmed, true);
    measuredBytes(output.bytes, 1);
    assert.ok(output.files.length >= 2);
    for (const proof of output.files) {
      measuredBytes(proof.bytes, 1);
      assert.match(proof.sha256, /^[a-f0-9]{64}$/);
    }
  }
  return receipt;
}
// Public factory owns every resource; no external DB, fixture or arbitrary
// perform callback is accepted. Each instance runs one complete owned cycle.
export async function withOwnedCachePressure(
  { binding_path, helper_binding_path, signal },
  run,
) {
  assert.equal(process.platform, "linux");
  assert.ok(
    process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
    "native PostgreSQL required; no Docker fallback",
  );
  assert.ok(
    process.env.RAINSYNC_ARTIFACT_DIR,
    "private artifact directory required",
  );
  const bindingBytes = await readFile(binding_path),
    binding = JSON.parse(bindingBytes);
  const helperBytes = await readFile(helper_binding_path),
    helper = JSON.parse(helperBytes);
  assert.equal(binding.result, "passed");
  assert.equal(binding.build.exit_code, 0);
  assert.equal(sha(JSON.stringify(binding.source)), binding.source_digest);
  assert.equal(helper.result, "passed");
  assert.equal(helper.build.exit_code, 0);
  assert.equal(helper.name, "owned_cache_pressure");
  assert.equal(sha(JSON.stringify(helper.source)), helper.source_digest);
  assert.equal(helper.backend_source_digest, binding.source_digest);
  const coordinator = await Promise.all(
    [
      "scripts/acceptance-cache-pressure.mjs",
      "tests/cache-pressure-native.mjs",
      "tests/fixtures/postgres.mjs",
      "deploy/owned-process.mjs",
    ].map(async (path) => ({
      path,
      sha256: await hashFile(resolve(repo, path)),
    })),
  );
  const verify = async () => {
    assert.equal(sha(await readFile(binding_path)), sha(bindingBytes));
    assert.equal(sha(await readFile(helper_binding_path)), sha(helperBytes));
    for (const row of [...binding.source, ...helper.source, ...coordinator]) {
      assert.ok(
        !row.path.startsWith("/") && !row.path.split("/").includes(".."),
      );
      assert.equal(
        await hashFile(resolve(repo, row.path)),
        row.sha256,
        `source changed: ${row.path}`,
      );
    }
    for (const binary of binding.binaries)
      assert.equal(await hashFile(binary.path), binary.sha256);
    assert.equal(await hashFile(helper.path), helper.sha256);
  };
  await verify();
  const runId = randomUUID(),
    id = `cache_pressure_${runId.replaceAll("-", "")}`;
  const root = resolve(
    process.env.RAINSYNC_ARTIFACT_DIR,
    "cache-pressure",
    runId,
  );
  const previousUmask = process.umask(0o077);
  try {
    await mkdir(resolve(process.env.RAINSYNC_ARTIFACT_DIR, "cache-pressure"), {
      recursive: true,
    });
    await mkdir(root); // Fresh ownership boundary; never follow an existing run root
    await mkdir(resolve(root, "cache"));
    await writeFile(resolve(root, "cache-owner"), runId + "\n", { flag: "wx" });
  } catch (error) {
    process.umask(previousUmask);
    throw error;
  }
  const password = randomBytes(24).toString("hex"),
    db = isolatedPostgres({ root, id, password, name: "owned-cache-pressure" });
  const redact = (value) => String(value).replaceAll(password, "[redacted]");
  const report = {
    schema_version: 1,
    run_id: runId,
    result: "running",
    accepted: false,
    release_ready: false,
    scope:
      "bounded production cache-evict driver; production API reader lease/open handle, actual owned FFmpeg writer; no HTTP/backpressure, F3, image or 72h acceptance",
    baseline: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim(),
    native_binding: {
      path: resolve(binding_path),
      sha256: sha(bindingBytes),
      source_digest: binding.source_digest,
    },
    helper_binding: {
      path: resolve(helper_binding_path),
      sha256: sha(helperBytes),
      binary_sha256: helper.sha256,
      source_digest: helper.source_digest,
    },
    coordinator,
    started_at: new Date().toISOString(),
    checks: [],
    cleanup: { confirmed: false },
    remaining_gates: [
      "HTTP-backpressure reader integration",
      "standard-soak scheduler wiring",
      "final-image identity",
      "full-capacity/resource trends",
      "F3 isolated volume",
      "uninterrupted 72 hours",
    ],
  };
  const reportPath = resolve(root, "report.json");
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
  let primary,
    activeOperation,
    helperStarted = false;
  const actionLifetime = new AbortController();
  try {
    await db.start();
    report.postgresql = db.diagnostics();
    await save();
    const ownedIds = [
      `postgres:${id}`,
      `cache:${runId}`,
      `helper:${helper.sha256}`,
    ];
    let executed = false;
    const adapter = {
      run_id: runId,
      owned_resource_ids: ownedIds,
      async waitForWriter({ signal: actionSignal } = {}) {
        const waitSignal = AbortSignal.any([
          AbortSignal.timeout(30000),
          actionLifetime.signal,
          ...(signal ? [signal] : []),
          ...(actionSignal ? [actionSignal] : []),
        ]);
        while (true) {
          waitSignal.throwIfAborted();
          try {
            const witness = JSON.parse(
              await readFile(resolve(root, "writer-live.json"), "utf8"),
            );
            assert.equal(witness.run_id, runId);
            assert.equal(witness.phase, "writer-live");
            assert.match(
              witness.job_id,
              /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
            );
            assert.ok(witness.bytes > 0);
            return witness;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await delay(25, undefined, { signal: waitSignal });
        }
      },
      perform(event) {
        try {
          assert.equal(event.run_id, runId, "owned run mismatch");
          assert.deepEqual(
            event.owned_resource_ids,
            ownedIds,
            "owned resource population mismatch",
          );
          assert.equal(
            event.kind,
            "cache-evict",
            "only concrete cache-evict operation supported",
          );
          assert.equal(
            executed,
            false,
            "a driver owns one bounded cycle; create a new fixture to run again",
          );
          event.signal?.throwIfAborted();
          signal?.throwIfAborted();
          executed = true;
          const operation = (async () => {
            await verify();
            const combined = AbortSignal.any([
              AbortSignal.timeout(60000),
              actionLifetime.signal,
              ...(signal ? [signal] : []),
              ...(event.signal ? [event.signal] : []),
            ]);
            try {
              combined.throwIfAborted();
              helperStarted = true;
              report.helper_process = await ownedProcess(
                helper.path,
                ["--cycle", resolve(root, "cache"), runId],
                {
                  env: {
                    ...process.env,
                    RAINSYNC_ISOLATED_TEST: "1",
                    DATABASE_URL: db.url,
                    CACHE_MAX_BYTES: String(16 * 1024 * 1024),
                  },
                  signal: combined,
                  timeoutMs: 65000,
                  graceMs: 10000,
                },
              );
              assert.equal(
                report.helper_process.exit_code,
                0,
                "owned cache helper failed",
              );
              assert.equal(verifyPidAbsent(report.helper_process.pid), true);
              const receipt = JSON.parse(
                await readFile(resolve(root, "cache-pressure.json"), "utf8"),
              );
              validateCachePressureReceipt(receipt, runId);
              await verify();
              report.checks.push(receipt);
              await save();
              return receipt;
            } catch (error) {
              if (error.cleanup) report.helper_process = error.cleanup;
              if (
                error.message === "owned_child_interrupted" &&
                combined.aborted &&
                combined.reason instanceof Error
              ) {
                combined.reason.cleanup = error.cleanup;
                throw combined.reason;
              }
              throw error;
            } finally {
              try {
                report.helper_receipt = JSON.parse(
                  await readFile(resolve(root, "cache-pressure.json"), "utf8"),
                );
              } catch {}
              if (report.helper_process?.output) {
                await writeFile(
                  resolve(root, "helper.log"),
                  redact(report.helper_process.output),
                );
                delete report.helper_process.output;
              }
            }
          })();
          activeOperation = operation;
          operation.catch(() => {});
          return operation;
        } catch (error) {
          const rejected = Promise.reject(error);
          rejected.catch(() => {});
          return rejected;
        }
      },
    };
    await run(adapter, report);
    if (activeOperation) await activeOperation;
    assert.equal(report.checks.length, 1, "owned operation must execute");
    await verify();
    report.final_binding_verified = true;
  } catch (error) {
    primary = error;
    report.failure = redact(error.stack ?? error);
  } finally {
    actionLifetime.abort(primary ?? Error("owned cache fixture disposing"));
    if (activeOperation) {
      try {
        await activeOperation;
      } catch (error) {
        primary ??= error;
        if (error !== primary)
          report.operation_cleanup_error = redact(error.message);
      }
    }
    try {
      if (helperStarted && report.helper_receipt?.result === "failed") {
        try {
          const witness = JSON.parse(
            await readFile(resolve(root, "writer-live.json"), "utf8"),
          );
          assert.match(
            witness.job_id,
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
          );
          report.failed_writer = {
            job_id: witness.job_id,
            phase: witness.phase,
            unresolved_receipt:
              db.sql(
                `SELECT EXISTS(SELECT 1 FROM media_executions WHERE job_id='${witness.job_id}' AND reaped_at IS NULL)`,
              ) === "t",
          };
        } catch (error) {
          report.failed_writer_observation_error = redact(error.message);
        }
      }
      await db.stop();
      report.cleanup.postgresql = await db.verifyStopped();
      report.cleanup.helper = {
        started: helperStarted,
        process_close_observed:
          report.helper_process?.observed_close ?? !helperStarted,
        pid_absent: report.helper_process?.pid
          ? verifyPidAbsent(report.helper_process.pid)
          : !helperStarted,
        process_scope_cleanup:
          report.helper_receipt?.process_scope_cleanup ?? !helperStarted,
      };
      report.cleanup.confirmed =
        report.cleanup.helper.process_close_observed &&
        report.cleanup.helper.pid_absent &&
        report.cleanup.helper.process_scope_cleanup;
      if (!report.cleanup.confirmed)
        primary ??= Error("owned helper cleanup unconfirmed");
    } catch (error) {
      report.cleanup.failure = redact(error.stack ?? error);
      primary ??= error;
    }
    try {
      await verify();
      report.final_binding_verified = true;
    } catch (error) {
      primary ??= error;
      report.binding_failure = redact(error.message);
    }
    report.result = primary ? "failed" : "passed";
    report.finished_at = new Date().toISOString();
    try {
      await save();
    } catch (error) {
      primary ??= error;
    }
    process.umask(previousUmask);
  }
  if (primary) {
    primary.report = report;
    primary.report_path = reportPath;
    throw primary;
  }
  return { ...report, report_path: reportPath };
}
