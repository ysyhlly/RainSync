// Filesystem descriptors, fake clock and in-memory workload only. Importing the
// fixture verifier does not call its runtime entry or inspect/control /proc.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import {
  nativeQualificationSchedule,
  runNativeSoakQualification,
  soakSchedule,
  runSoak,
  NATIVE_REMAINING_GATES,
} from "../scripts/acceptance-soak.mjs";
import { createOwnedNativeSchedulerAdapter } from "../scripts/acceptance-owned-soak.mjs";
import {
  verifyOwnedNativeBinding,
  finalizeOwnedNativeResult,
} from "./fixtures/owned-native-soak.mjs";
import { boundedCall } from "../scripts/acceptance-runtime.mjs";
const repo = fileURLToPath(new URL("..", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
async function fixture(t, hooks = {}) {
  const root = await mkdtemp(resolve(repo, ".qualification-test-"));
  const oldTarget = process.env.CARGO_TARGET_DIR;
  const target = resolve(root, "target");
  process.env.CARGO_TARGET_DIR = target;
  t.after(async () => {
    if (oldTarget === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = oldTarget;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(resolve(target, "debug"), { recursive: true });
  const sourcePath = resolve(root, "backend-source");
  await writeFile(sourcePath, "frozen backend fixture");
  const binaries = [];
  for (const name of [
    "rainsync-server",
    "rainsync-media-worker",
    "rainsync-nas-agent",
  ]) {
    const path = resolve(target, "debug", name);
    await writeFile(path, `inert bytes: ${name}`);
    binaries.push({ name, path, sha256: sha(await readFile(path)) });
  }
  const source = [
    {
      path: relative(repo, sourcePath),
      sha256: sha(await readFile(sourcePath)),
    },
  ];
  const binding = {
    schema_version: 1,
    result: "passed",
    source,
    source_digest: sha(JSON.stringify(source)),
    binaries,
    build: { exit_code: 0 },
  };
  const bindingPath = resolve(root, "binding.json");
  await writeFile(bindingPath, JSON.stringify(binding));
  const log = [];
  let currentPhase,
    now = 10000,
    workload,
    finalReport;
  const clock = {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    async sleep(ms, signal) {
      signal?.throwIfAborted();
      await hooks.beforeSleep?.(ms, now);
      now += Math.max(0, ms);
      await hooks.sleep?.(now);
      // Let outstanding filesystem verification settle; virtual schedule time
      // remains entirely independent of these short in-memory event-loop turns.
      await pause(10);
      signal?.throwIfAborted();
    },
  };
  const config = {
    scope: "native-qualification",
    native_binding_path: bindingPath,
    command: ["node", "in-memory-qualification-test"],
    faults_approved: true,
    duration_seconds: 6,
    warmup_seconds: 0,
    phase_seconds: 6,
    sample_seconds: 1,
    identity_seconds: 1,
    phases: [{ id: "direct-1", mode: "direct", concurrency: 1 }],
    actions: ["slice", "join", "leave", "stop-stream", "fault"],
    faults: ["F4"],
    adapter_timeout_ms: 1000,
  };
  const fixtureRunner = async ({ run_id, signal }, run) => {
    log.push("fixture-start");
    const id = randomUUID();
    const resources = ["server", "worker", "postgres"].map(
      (role) => `${run_id}:${role}`,
    );
    const identity = {
      fixture_id: id,
      image_id: null,
      database: {
        name: `rainsync_${id.replaceAll("-", "")}`,
        port: 54321,
        data_directory: resolve(root, "postgres"),
      },
      processes: [0, 1, 2].map((index) => ({
        pid: 100 + index,
        parent_pid: 90,
        start_ticks: String(1000 + index),
        exe: index < 2 ? binaries[index].path : resolve(root, "inert-postgres"),
        binary_sha256:
          index < 2 ? binaries[index].sha256 : sha("inert-postgres"),
      })),
    };
    workload = {
      run_id,
      owned_resource_ids: resources,
      async nativeIdentity(input = {}, { signal: localSignal } = {}) {
        if (!input.diagnostic) signal.throwIfAborted();
        localSignal?.throwIfAborted();
        log.push(input.diagnostic ? "final-live-identity" : "identity");
        const observed = {
          ...structuredClone(identity),
          observation_id: randomUUID(),
        };
        await hooks.identity?.(observed, log);
        return observed;
      },
      async perform(event, { signal: localSignal } = {}) {
        signal.throwIfAborted();
        localSignal?.throwIfAborted();
        log.push(`start:${event.kind}:${event.phase.id}`);
        await hooks.perform?.(event, localSignal, log);
        localSignal?.throwIfAborted();
        if (event.kind === "phase") currentPhase = event.phase;
        let evidence;
        if (event.kind === "phase")
          evidence = {
            mode: event.phase.mode,
            requested_concurrency: event.phase.concurrency,
            active_concurrency: event.phase.concurrency,
            controlled_rejections: 0,
          };
        if (event.kind === "slice")
          evidence = { completed_segments: 2, failed_segments: 0 };
        if (["join", "leave"].includes(event.kind))
          evidence = {
            members_before: 3,
            members_after: event.kind === "join" ? 4 : 2,
            authority_snapshot_verified: true,
          };
        if (["stop-stream", "fault"].includes(event.kind))
          evidence = {
            ...(event.kind === "fault"
              ? {
                  fault: "F4",
                  revocation: "owned-membership-sql-fault",
                  membership_epoch_before: "old",
                  membership_epoch_after: "new",
                  old_grant_denied_after_rejoin: true,
                }
              : { check: "stop-stream", revocation: "session-delete" }),
            injected_at_ms: now,
            recovered_at_ms: now + 100,
            new_requests_denied: 2,
            long_stream_close_ms: 100,
            normal_eof: false,
            unaffected_viewer_verified: true,
          };
        const receipt = {
          mode: "real",
          run_id,
          owned_resource_ids: [...resources],
          phase: event.phase,
          action: event.kind,
          observation_id: randomUUID(),
          completed: true,
          evidence,
        };
        await hooks.receipt?.(event, receipt);
        log.push(`end:${event.kind}:${event.phase.id}`);
        return receipt;
      },
      async sampleResources({ phase }) {
        log.push(`sample:${phase.id}`);
        assert.deepEqual(phase, currentPhase);
        const rows = resources.map((entity, index) => ({
          entity,
          phase: phase.id,
          instance_id: `${identity.processes[index].pid}:${identity.processes[index].start_ticks}`,
          observation_id: randomUUID(),
          rss_bytes: 1000,
          fd_count: 2,
          socket_count: 1,
          process_count: 1,
          cache_bytes: 100,
          cache_quota_bytes: 1000,
        }));
        return (await hooks.sample?.(rows)) ?? rows;
      },
    };
    let primary;
    const result = {
      schema_version: 1,
      scope: "owned-native-bounded-workload",
      accepted: false,
      release_ready: false,
      initial_identity: await workload.nativeIdentity(),
      cleanup: { confirmed: true },
      checks: [],
    };
    try {
      await hooks.prepare?.(signal);
      await run(workload, result);
    } catch (error) {
      primary = error;
    } finally {
      result.final_identity = await workload.nativeIdentity({
        diagnostic: true,
      });
      log.push("dispose-workload");
      await hooks.dispose?.(signal, result);
      log.push("dispose-services");
      if (hooks.cleanupUnknown) result.cleanup.confirmed = false;
      finalReport = result;
    }
    return finalizeOwnedNativeResult(result, { primary, sink: hooks.sink });
  };
  const adapter = createOwnedNativeSchedulerAdapter(config, { fixtureRunner });
  const collect = adapter.collectArtifacts;
  adapter.collectArtifacts = async (...args) => {
    log.push("collect-finalized");
    return collect(...args);
  };
  return {
    root,
    sourcePath,
    binding,
    bindingPath,
    config,
    adapter,
    clock,
    log,
    workload: () => workload,
    finalReport: () => finalReport,
  };
}
const run = (f, config = {}, extra = {}) =>
  runNativeSoakQualification({
    config: { ...f.config, ...config },
    adapter: f.adapter,
    clock: f.clock,
    output: resolve(f.root, `run-${randomUUID()}`),
    ...extra,
  });

test("formal rejects native/reduced schedules before prepare and cannot select native identity from JSON", async () => {
  let starts = 0;
  await assert.rejects(
    runSoak({
      config: { scope: "native-qualification", actions: ["slice"] },
      adapter: {
        prepare() {
          starts++;
        },
      },
    }),
    /dedicated entry/,
  );
  await assert.rejects(
    runSoak({
      config: { scope: "formal", actions: ["slice"] },
      adapter: {
        prepare() {
          starts++;
        },
      },
    }),
    /reduce/,
  );
  assert.throws(
    () => soakSchedule({ scope: "formal", native_binding_path: "native.json" }),
    /image binding/,
  );
  const adapter = createOwnedNativeSchedulerAdapter(
    { scope: "formal" },
    {
      fixtureRunner: () => {
        starts++;
      },
    },
  );
  await assert.rejects(
    adapter.prepare({ schedule: soakSchedule({ scope: "formal" }) }),
    { code: "OWNED_SOAK_PREFLIGHT" },
  );
  assert.throws(
    () => soakSchedule({ scope: "formal", cadence_seconds: { fault: 259200 } }),
    /actually include F1/,
  );
  assert.throws(
    () => soakSchedule({ scope: "formal", phase_seconds: 259200 }),
    /every capacity phase/,
  );
  assert.throws(
    () => soakSchedule({ scope: "formal", cadence_seconds: { leave: 518400 } }),
    /every workload action/,
  );
  assert.equal(starts, 0);
});

test("qualification schedule allows only explicit supported subset and direct bounded phases", () => {
  const base = {
    scope: "native-qualification",
    actions: ["slice"],
    faults: [],
    duration_seconds: 6,
    phases: [{ id: "direct-1", mode: "direct", concurrency: 1 }],
  };
  assert.deepEqual(
    new Set(
      nativeQualificationSchedule(base).events.map((event) => event.kind),
    ),
    new Set(["phase", "slice", "sample-resources", "verify-identity"]),
  );
  for (const kind of ["seek", "loop-playback", "cache-evict", "unknown"])
    assert.throws(
      () => nativeQualificationSchedule({ ...base, actions: [kind] }),
      /unsupported/,
    );
  assert.throws(
    () =>
      nativeQualificationSchedule({
        ...base,
        actions: ["fault"],
        faults: ["F1"],
      }),
    /F4/,
  );
  assert.throws(
    () => nativeQualificationSchedule({ ...base, duration_seconds: 181 }),
    /180/,
  );
  assert.throws(
    () =>
      nativeQualificationSchedule({
        ...base,
        phases: [{ id: "transcode-1", mode: "transcode", concurrency: 1 }],
      }),
    /direct/,
  );
});

test("filesystem verifier freezes expected native binding and detects descriptor/source/binary tampering", async (t) => {
  const f = await fixture(t);
  const verified = await verifyOwnedNativeBinding({
    binding_path: f.bindingPath,
  });
  assert.ok(Object.isFrozen(verified.binding.binaries[0]));
  assert.throws(() => {
    verified.binding.source.pop();
  }, TypeError);
  await writeFile(
    f.bindingPath,
    JSON.stringify({ ...f.binding, ignored: true }),
  );
  await assert.rejects(verified.check(), /native binding changed/);
  await writeFile(f.bindingPath, JSON.stringify(f.binding));
  await writeFile(f.sourcePath, "changed source");
  await assert.rejects(verified.check(), /source changed/);
  await writeFile(f.sourcePath, "frozen backend fixture");
  await writeFile(f.binding.binaries[0].path, "changed binary");
  await assert.rejects(verified.check(), /binary changed/);
  assert.equal(f.log.length, 0);
});

test("selected real-contract actions qualify, retain separate Stop/F4, and collect only finalized reports", async (t) => {
  const f = await fixture(t);
  const report = await run(f);
  assert.equal(report.result, "passed", report.failure?.message);
  assert.equal(report.qualification_only, true);
  assert.equal(report.formal_gates_fulfilled, false);
  assert.equal(report.accepted, false);
  assert.equal(report.release_ready, false);
  assert.deepEqual(report.remaining_gates, [...NATIVE_REMAINING_GATES]);
  assert.equal(report.completed_counts["stop-stream"], 1);
  assert.equal(report.completed_counts.fault, 1);
  assert.equal(report.native_identity_unchanged, true);
  assert.equal(report.membership_sql_f4_completed, true);
  assert.equal(report.formal_gates.F4, "unfulfilled");
  assert.equal(report.artifact_unchanged, undefined);
  assert.equal(report.cleanup_confirmed, true);
  assert.equal(report.finalized_native_report, f.finalReport());
  assert.ok(
    f.log.lastIndexOf("final-live-identity") <
      f.log.indexOf("dispose-workload"),
  );
  assert.ok(
    f.log.indexOf("dispose-services") < f.log.indexOf("collect-finalized"),
  );
});

test("Stop cannot satisfy scheduled real membership-SQL F4", async (t) => {
  const f = await fixture(t, {
    receipt(event, receipt) {
      if (event.kind === "fault")
        receipt.evidence.revocation = "session-delete";
    },
  });
  const report = await run(f);
  assert.equal(report.result, "failed");
  assert.match(report.failure.message, /actual membership SQL/);
  assert.equal(report.cleanup_confirmed, true);
});

test("fixed resource population cannot shrink after prepare or omit a later sample", async (t) => {
  let samples = 0;
  const f = await fixture(t, {
    sample(rows) {
      if (++samples === 2) return rows.slice(0, 2);
    },
  });
  const report = await run(f, { actions: [], faults: [] });
  assert.equal(report.result, "failed");
  assert.match(report.failure.message, /each expected resource exactly once/);
  assert.equal(report.membership_sql_f4_completed, false);
  assert.equal(report.formal_gates.F4, "unfulfilled");
  assert.equal(report.failure_samples[0].coverage.missing.length, 1);
  assert.equal(
    report.failure_samples[0].coverage.expected_resource_ids.length,
    3,
  );
  assert.equal(report.cleanup_confirmed, true);
});

test("live PID generation and resource instance tampering are rejected", async (t) => {
  let observations = 0;
  const f = await fixture(t, {
    identity(actual) {
      if (++observations > 2) actual.processes[0].start_ticks = "9999";
    },
  });
  const report = await run(f, { actions: [], faults: [] });
  assert.equal(report.result, "failed");
  assert.match(report.failure.message, /native identity changed/);
});

test("native source is checked around every receipt, including a mid-action mutation", async (t) => {
  let f;
  f = await fixture(t, {
    perform: async (event) => {
      if (event.kind === "slice")
        await writeFile(f.sourcePath, "changed during action");
    },
  });
  const report = await run(f, { actions: ["slice"], faults: [] });
  assert.equal(report.result, "failed");
  assert.match(report.failure.message, /source changed/);
  assert.equal(report.cleanup_confirmed, true);
  assert.ok(report.final_live_identity.observation_id);
  assert.equal(report.source_unchanged, false);
  assert.match(report.final_source_binding_failure.message, /source changed/);
  assert.ok(
    f.log.indexOf("final-live-identity") < f.log.indexOf("dispose-workload"),
  );
});

test("shared Stop/F4 long-stream actor explicitly rejects overlap and drains cancellation", async (t) => {
  const f = await fixture(t, {
    perform(event, signal) {
      if (event.kind === "stop-stream")
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
    },
  });
  const report = await run(f, {
    actions: ["stop-stream", "fault"],
    faults: ["F4"],
    action_start_seconds: { "stop-stream": 1, fault: 1 },
  });
  assert.equal(report.result, "failed");
  assert.match(report.failure.message, /long-stream-actor.*overlapping/);
  assert.equal(
    f.log.filter((item) => item.startsWith("start:fault:")).length,
    0,
  );
  assert.equal(report.cleanup_confirmed, true);
});

test("phase transition remains a barrier for outstanding workload and binds each completed phase", async (t) => {
  const gate = deferred();
  const f = await fixture(t, {
    perform(event) {
      if (event.kind === "slice") return gate.promise;
    },
    sleep(now) {
      if (now >= 12000) gate.resolve();
    },
  });
  const report = await run(f, {
    actions: ["slice"],
    faults: [],
    phase_seconds: 2,
    phases: [
      { id: "direct-1", mode: "direct", concurrency: 1 },
      { id: "direct-2", mode: "direct", concurrency: 2 },
    ],
    action_start_seconds: { slice: 1 },
  });
  assert.equal(report.result, "passed", report.failure?.message);
  assert.ok(
    f.log.indexOf("end:slice:direct-1") < f.log.indexOf("start:phase:direct-2"),
  );
});

test("distinct lifetime signal stays linked after successful bounded preparation", async (t) => {
  const lifetime = new AbortController(),
    primary = Error("cancel after prepare");
  const f = await fixture(t);
  await boundedCall(f.adapter, "prepare", {
    run_id: randomUUID(),
    schedule: nativeQualificationSchedule(f.config),
    lifetime_signal: lifetime.signal,
  });
  lifetime.abort(primary);
  await assert.rejects(
    f.adapter.perform({ kind: "slice" }),
    (error) => error === primary,
  );
  await assert.rejects(
    f.adapter.cleanup({ failure: primary }),
    (error) =>
      error.report?.error === primary && error.report?.cleanup.confirmed,
  );
  const artifacts = await f.adapter.collectArtifacts();
  assert.equal(artifacts.completed, true);
  assert.equal(artifacts.report.error, primary);
});

test("prepare timeout rejects late adoption and independently awaits disposal", async (t) => {
  const gate = deferred();
  const f = await fixture(t, { prepare: () => gate.promise });
  await assert.rejects(
    boundedCall(
      f.adapter,
      "prepare",
      { run_id: randomUUID(), schedule: nativeQualificationSchedule(f.config) },
      { timeout_ms: 5 },
    ),
    /prepare timed out/,
  );
  gate.resolve();
  await assert.rejects(f.adapter.cleanup(), /prepare timed out/);
  const artifacts = await f.adapter.collectArtifacts();
  assert.equal(artifacts.completed, true);
  assert.equal(artifacts.report.cleanup.confirmed, true);
  assert.ok(f.log.includes("dispose-services"));
});

test("primary scheduler failure survives finalized native sink errors and cleanup evidence remains", async (t) => {
  const primary = Error("primary scheduled slice failure"),
    sink = Error("native report sink failure");
  const f = await fixture(t, {
    perform(event) {
      if (event.kind === "slice") throw primary;
    },
    sink() {
      throw sink;
    },
  });
  const report = await run(f, { actions: ["slice"], faults: [] });
  assert.equal(report.failure, primary);
  assert.equal(report.result, "failed");
  assert.equal(report.cleanup_confirmed, true);
  assert.equal(report.finalized_native_report.error, primary);
  assert.equal(report.finalized_native_report.report_write_error, sink);
  assert.ok(f.log.includes("collect-finalized"));
});

test("unconfirmed fixture cleanup remains failed with retained finalized report", async (t) => {
  const f = await fixture(t, { cleanupUnknown: true });
  const report = await run(f, { actions: [], faults: [] });
  assert.equal(report.result, "failed");
  assert.equal(report.cleanup_confirmed, false);
  assert.equal(report.finalized_native_report.cleanup.confirmed, false);
  assert.ok(f.log.includes("collect-finalized"));
});

test("resource rows remain pinned to captured native process instances", async (t) => {
  const f = await fixture(t, {
    sample(rows) {
      rows[0].instance_id = "foreign:instance";
      return rows;
    },
  });
  const report = await run(f, { actions: [], faults: [] });
  assert.equal(report.result, "failed");
  assert.match(report.failure.message, /native process generation mismatch/);
  assert.equal(report.cleanup_confirmed, true);
});

test("receipt cannot substitute another run or reduced resource population", async (t) => {
  const f = await fixture(t, {
    receipt(event, receipt) {
      if (event.kind === "slice") receipt.owned_resource_ids.pop();
    },
  });
  const report = await run(f, { actions: ["slice"], faults: [] });
  assert.equal(report.result, "failed");
  assert.match(report.failure.message, /receipt resource population/);
});

test("F4 approval marker is required before starting any fixture", async (t) => {
  const f = await fixture(t);
  const report = await run(f, { faults_approved: false });
  assert.equal(report.result, "failed");
  assert.match(report.failure.message, /explicit fault-injection approval/);
  assert.equal(f.log.includes("fixture-start"), false);
});

test("cancelled work uses independent cleanup and collection continues when cleanup throws", async (t) => {
  const primary = Error("scheduled Stop failure"),
    cleanup = Error("cleanup witness unavailable");
  const f = await fixture(t, {
    perform(event) {
      if (event.kind === "stop-stream") throw primary;
    },
  });
  const original = f.adapter.cleanup;
  f.adapter.cleanup = async (input, options) => {
    assert.equal(options.signal.aborted, false);
    await assert.rejects(
      original(input, options),
      (error) => error.report?.cleanup.confirmed === true,
    );
    throw cleanup;
  };
  const report = await run(f, { actions: ["stop-stream"], faults: [] });
  assert.equal(report.failure, primary);
  assert.equal(report.cleanup_failure, cleanup);
  assert.equal(report.cleanup_confirmed, false);
  assert.equal(report.finalized_native_report.cleanup.confirmed, true);
  assert.ok(f.log.includes("collect-finalized"));
});

test("final scheduler report sink cannot replace primary error or prevent independent disposal", async (t) => {
  const primary = Error("scheduled slice failure before scheduler sink");
  let output;
  const f = await fixture(t, {
    async perform(event) {
      if (event.kind === "slice") {
        await writeFile(
          resolve(output, "failed-report.json"),
          "reserved by test",
          { flag: "wx" },
        );
        throw primary;
      }
    },
  });
  output = resolve(f.root, "scheduler-sink-negative");
  await assert.rejects(
    run(f, { actions: ["slice"], faults: [] }, { output }),
    (error) => {
      assert.equal(error, primary);
      assert.equal(error.report.failure, primary);
      assert.equal(error.report.cleanup_confirmed, true);
      assert.equal(error.report.report_write_failure.code, "EEXIST");
      return true;
    },
  );
  assert.ok(
    f.log.indexOf("dispose-services") < f.log.indexOf("collect-finalized"),
  );
});

test("scheduler action timeout preserves its primary failure and disposes independently", async (t) => {
  const f = await fixture(t, {
    perform(event, signal) {
      if (event.kind === "stop-stream")
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
    },
  });
  const report = await run(f, {
    actions: ["stop-stream"],
    faults: [],
    adapter_timeout_ms: 10,
  });
  assert.equal(report.result, "failed");
  assert.match(report.failure.message, /perform timed out/);
  assert.equal(report.cleanup_confirmed, true);
  assert.equal(report.finalized_native_report.error, report.failure);
});

test("scheduler cancellation after prepare still captures live identity before disposal", async (t) => {
  const lifetime = new AbortController(),
    primary = Error("cancel qualified workload lifetime");
  const f = await fixture(t, {
    perform(event) {
      if (event.kind === "slice") lifetime.abort(primary);
    },
  });
  const report = await run(
    f,
    { actions: ["slice"], faults: [] },
    { signal: lifetime.signal },
  );
  assert.equal(report.result, "interrupted");
  assert.equal(report.failure, primary);
  assert.ok(report.final_live_identity.observation_id);
  assert.equal(report.cleanup_confirmed, true);
  assert.equal(report.finalized_native_report.error, primary);
  assert.equal(report.secondary_errors, undefined);
});

test("native dry run plans explicit subset without a binding read or adapter preparation", async (t) => {
  const f = await fixture(t);
  const report = await run(
    f,
    { native_binding_path: "missing-binding-is-never-opened" },
    { dry_run: true, adapter: undefined },
  );
  assert.equal(report.result, "dry-run");
  assert.equal(report.accepted, false);
  assert.equal(report.release_ready, false);
  assert.equal(report.formal_gates_fulfilled, false);
  assert.equal(f.log.length, 0);
});

test("slice-only qualification leaves the full formal F4 gate explicitly unfulfilled", async (t) => {
  const f = await fixture(t);
  const report = await run(f, { actions: ["slice"], faults: [] });
  assert.equal(report.result, "passed", report.failure?.message);
  assert.equal(report.membership_sql_f4_completed, false);
  assert.equal(report.formal_gates.F4, "unfulfilled");
  assert.ok(report.remaining_gates.includes("F4"));
  const artifacts = await f.adapter.collectArtifacts();
  assert.ok(artifacts.remaining_gates.includes("F4"));
});

test("workload timestamps distinguish barrier start delay from action duration", async (t) => {
  const gate = deferred();
  let f;
  f = await fixture(t, {
    async perform(event) {
      if (event.kind === "slice") {
        await gate.promise;
        f.clock.advance(100);
      }
      if (event.kind === "phase" && event.phase.id === "direct-2")
        f.clock.advance(1000);
    },
    sleep(now) {
      if (now === 12000) setTimeout(() => gate.resolve(), 20);
    },
  });
  const output = resolve(f.root, "timestamp-check");
  const report = await run(
    f,
    {
      actions: ["slice"],
      faults: [],
      phase_seconds: 2,
      sample_seconds: 2,
      identity_seconds: 6,
      phases: [
        { id: "direct-1", mode: "direct", concurrency: 1 },
        { id: "direct-2", mode: "direct", concurrency: 2 },
      ],
      action_start_seconds: { slice: 1 },
    },
    { output },
  );
  assert.equal(report.result, "passed", report.failure?.message);
  const records = (
    await readFile(resolve(output, "observations.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  const phase = records.find(
    (row) =>
      row.kind === "workload" &&
      row.value.event.kind === "phase" &&
      row.value.event.phase.id === "direct-2",
  ).value;
  assert.equal(phase.started_ms, 12100);
  assert.equal(phase.finished_ms, 13100);
  assert.equal(phase.lateness_ms, 100);
  assert.equal(phase.completion_lateness_ms, 1100);
});

test("workload invocation checks lateness after a delayed phase barrier", async (t) => {
  const gate = deferred(),
    started = deferred();
  let f;
  f = await fixture(t, {
    async perform(event) {
      if (event.kind === "slice") {
        started.resolve();
        await gate.promise;
        f.clock.advance(100);
      }
    },
    async beforeSleep(ms, now) {
      if (now < 12000 && now + Math.max(0, ms) === 12000) await started.promise;
    },
    sleep(now) {
      if (now === 12000) setTimeout(() => gate.resolve(), 20);
    },
  });
  const report = await run(f, {
    actions: ["slice"],
    faults: [],
    phase_seconds: 2,
    sample_seconds: 2,
    identity_seconds: 6,
    maximum_lateness_ms: 50,
    phases: [
      { id: "direct-1", mode: "direct", concurrency: 1 },
      { id: "direct-2", mode: "direct", concurrency: 2 },
    ],
    action_start_seconds: { slice: 1 },
  });
  assert.equal(report.result, "failed");
  assert.match(report.failure.message, /phase barrier missed planned cadence/);
  assert.equal(
    f.log.filter((item) => item === "start:phase:direct-2").length,
    0,
  );
  assert.equal(report.cleanup_confirmed, true);
});

test("qualification budgets distinguish scheduling window from adapter deadlines and unknown ownership drain", async (t) => {
  const f = await fixture(t);
  const report = await run(f, {
    actions: ["slice"],
    faults: [],
    adapter_timeout_ms: 1000,
    maximum_lateness_ms: 5000,
  });
  assert.equal(report.result, "passed", report.failure?.message);
  const budgets = report.timing_budgets;
  assert.equal(budgets.scheduled_workload_window_ms, 6000);
  for (const field of [
    "prepare_call_ms",
    "action_call_ms",
    "final_identity_call_ms",
    "cleanup_wait_ms",
    "final_artifact_collection_call_ms",
  ])
    assert.equal(budgets[field], 1000);
  assert.equal(budgets.latest_scheduled_workload_start_ms, 1800);
  assert.equal(budgets.latest_scheduled_adapter_call_deadline_ms, 7800);
  assert.equal(budgets.total_wall_clock_cap_ms, null);
  assert.equal(budgets.full_scheduled_work_drain_bound_ms, null);
  assert.equal(budgets.cleanup_ownership_ends_on_timeout, false);
});
