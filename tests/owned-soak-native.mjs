// Explicit short integration harness, not the formal soak scheduler or 72h.
import assert from "node:assert/strict";
import { withOwnedNativeSoak } from "./fixtures/owned-native-soak.mjs";
import { installInterrupts } from "../scripts/acceptance-runtime.mjs";
assert.ok(
  process.env.RAINSYNC_OWNED_SOAK_BINDING,
  "Require a frozen native backend binding; never builds",
);
const interrupts = installInterrupts(),
  deadline = AbortSignal.timeout(180000);
try {
  const report = await withOwnedNativeSoak(
    {
      binding_path: process.env.RAINSYNC_OWNED_SOAK_BINDING,
      signal: AbortSignal.any([interrupts.signal, deadline]),
    },
    async (adapter, report) => {
      let ordinal = 0,
        phase = { id: "direct-1", mode: "direct", concurrency: 1 };
      const perform = async (kind, extra = {}) => {
        const receipt = await adapter.perform({
          run_id: adapter.run_id,
          owned_resource_ids: adapter.owned_resource_ids,
          phase,
          kind,
          ordinal: ordinal++,
          ...extra,
        });
        report.checks.push(receipt);
        console.log(`PASS: ${kind}`);
      };
      await perform("phase");
      report.resources = [await adapter.sampleResources({ phase })];
      await assert.rejects(
        adapter.sampleResources({ phase: { ...phase, id: "wrong-phase" } }),
        /resource phase must equal/,
      );
      await perform("leave");
      await perform("join");
      phase = { id: "direct-2", mode: "direct", concurrency: 2 };
      await perform("phase");
      await perform("slice");
      report.stop_stream = await adapter.checkStopStream();
      await perform("fault", { fault: "F4" });
      report.resources.push(await adapter.sampleResources({ phase }));
      await assert.rejects(
        adapter.perform({
          run_id: adapter.run_id,
          owned_resource_ids: adapter.owned_resource_ids,
          kind: "loop-playback",
        }),
        { code: "PRESENTATION_REQUIRED" },
      );
      await assert.rejects(
        adapter.perform({
          run_id: adapter.run_id,
          owned_resource_ids: adapter.owned_resource_ids,
          kind: "cache-evict",
        }),
        { code: "CACHE_EVICTION_UNSUPPORTED" },
      );
      report.remaining_gates = [
        "native-image-identity",
        "presented-timecode-frames",
        "safe-cache-eviction",
        "F1",
        "F2",
        "F3",
        "full-capacity-matrix",
        "phase-matched-resource-trends",
        "72-hours",
      ];
    },
  );
  console.log(report.report_path);
  if (process.env.RAINSYNC_OWNED_SOAK_NEGATIVE === "1") {
    const lifetime = new AbortController(),
      primary = Error("intentional owned lifetime cancellation");
    let rejected;
    try {
      await withOwnedNativeSoak(
        {
          binding_path: process.env.RAINSYNC_OWNED_SOAK_BINDING,
          signal: lifetime.signal,
        },
        async (adapter) => {
          await adapter.perform({
            run_id: adapter.run_id,
            owned_resource_ids: adapter.owned_resource_ids,
            kind: "phase",
            phase: { id: "direct-1", mode: "direct", concurrency: 1 },
            ordinal: 0,
          });
          lifetime.abort(primary);
          throw primary;
        },
      );
    } catch (error) {
      rejected = error;
    }
    assert.ok(rejected, "intentional cancellation must reject");
    assert.equal(rejected, rejected.report.error, "primary error retained");
    assert.equal(rejected.message, primary.message);
    assert.equal(rejected.report.result, "failed");
    assert.equal(rejected.report.cleanup.confirmed, true);
    assert.equal(rejected.report.cleanup.workload.confirmed, true);
    assert.equal(rejected.report.cleanup.processes.confirmed, true);
    assert.equal(rejected.report.final_binding_verified, true);
    console.log(
      "PASS: deliberate aborted lifetime preserves primary failure and confirms independent cleanup",
    );
    console.log(rejected.report_path);
  }
} finally {
  interrupts.remove();
}
