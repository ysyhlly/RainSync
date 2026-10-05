// Short actual native fixture, never the formal soak scheduler.
import assert from "node:assert/strict";
import { withOwnedCachePressure } from "../scripts/acceptance-cache-pressure.mjs";
import { installInterrupts } from "../scripts/acceptance-runtime.mjs";
assert.ok(
  process.env.RAINSYNC_OWNED_SOAK_BINDING,
  "frozen native backend binding required",
);
assert.ok(
  process.env.RAINSYNC_OWNED_CACHE_HELPER,
  "copied source-bound helper descriptor required; never builds",
);
const interrupts = installInterrupts();
try {
  const report = await withOwnedCachePressure(
    {
      binding_path: process.env.RAINSYNC_OWNED_SOAK_BINDING,
      helper_binding_path: process.env.RAINSYNC_OWNED_CACHE_HELPER,
      signal: AbortSignal.any([interrupts.signal, AbortSignal.timeout(120000)]),
    },
    async (adapter) => {
      await assert.rejects(
        adapter.perform({
          run_id: "wrong",
          owned_resource_ids: adapter.owned_resource_ids,
          kind: "cache-evict",
        }),
        /owned run mismatch/,
      );
      await adapter.perform({
        run_id: adapter.run_id,
        owned_resource_ids: adapter.owned_resource_ids,
        kind: "cache-evict",
      });
      await assert.rejects(
        adapter.perform({
          run_id: adapter.run_id,
          owned_resource_ids: adapter.owned_resource_ids,
          kind: "cache-evict",
        }),
        /one bounded cycle/,
      );
    },
  );
  console.log(
    `PASS: owned application-quota eviction, actual reader/writer protection and unknown obligations; ${report.report_path}`,
  );
  if (process.env.RAINSYNC_OWNED_CACHE_NEGATIVE === "1") {
    const lifetime = new AbortController(),
      primary = Error("intentional owned live-writer cache cancellation");
    let rejected;
    try {
      await withOwnedCachePressure(
        {
          binding_path: process.env.RAINSYNC_OWNED_SOAK_BINDING,
          helper_binding_path: process.env.RAINSYNC_OWNED_CACHE_HELPER,
          signal: AbortSignal.any([
            lifetime.signal,
            interrupts.signal,
            AbortSignal.timeout(120000),
          ]),
        },
        async (adapter) => {
          const pending = adapter.perform({
            run_id: adapter.run_id,
            owned_resource_ids: adapter.owned_resource_ids,
            kind: "cache-evict",
          });
          pending.catch(() => {});
          try {
            await adapter.waitForWriter();
            lifetime.abort(primary);
            await pending;
          } catch (error) {
            lifetime.abort(error);
            await pending.catch(() => {});
            throw error;
          }
        },
      );
    } catch (error) {
      rejected = error;
    }
    assert.ok(rejected, "intentional cancellation must reject");
    assert.equal(rejected.message, primary.message);
    assert.equal(rejected.report.result, "failed");
    assert.equal(rejected.report.helper_receipt.result, "failed");
    assert.equal(rejected.report.cleanup.confirmed, true);
    assert.equal(rejected.report.failed_writer.unresolved_receipt, true);
    assert.equal(rejected.report.final_binding_verified, true);
    console.log(
      `PASS: deterministic live-writer cancellation preserves failure, drains owned processes and leaves unfinished receipt unresolved; ${rejected.report_path}`,
    );
    const callbackFailure = Error("intentional owned cache callback failure");
    let callbackRejected;
    try {
      await withOwnedCachePressure(
        {
          binding_path: process.env.RAINSYNC_OWNED_SOAK_BINDING,
          helper_binding_path: process.env.RAINSYNC_OWNED_CACHE_HELPER,
          signal: AbortSignal.any([
            interrupts.signal,
            AbortSignal.timeout(120000),
          ]),
        },
        async (adapter) => {
          // Deliberately leave the perform Promise unattended; the concrete
          // factory must own and drain that exact Promise before database teardown.
          adapter.perform({
            run_id: adapter.run_id,
            owned_resource_ids: adapter.owned_resource_ids,
            kind: "cache-evict",
          });
          await adapter.waitForWriter();
          throw callbackFailure;
        },
      );
    } catch (error) {
      callbackRejected = error;
    }
    assert.equal(callbackRejected, callbackFailure);
    assert.equal(callbackRejected.report.result, "failed");
    assert.equal(callbackRejected.report.cleanup.confirmed, true);
    assert.equal(
      callbackRejected.report.failed_writer.unresolved_receipt,
      true,
    );
    assert.equal(callbackRejected.report.final_binding_verified, true);
    console.log(
      `PASS: thrown callback preserves original failure and drains unattended owned operation before PostgreSQL teardown; ${callbackRejected.report_path}`,
    );
  }
} catch (error) {
  console.error(`${error.message}; ${error.report_path ?? "no report"}`);
  process.exitCode = 1;
} finally {
  interrupts.remove();
}
