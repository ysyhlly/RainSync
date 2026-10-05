import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resourceTrends } from "./acceptance-measurements.mjs";
import {
  systemClock,
  boundedCall,
  createJournal,
  bindRun,
  assertArtifactIdentity,
} from "./acceptance-runtime.mjs";

export const SOAK_ACTIONS = Object.freeze([
  "loop-playback",
  "slice",
  "seek",
  "join",
  "leave",
  "cache-evict",
  "fault",
]);
const defaultCadence = {
  "loop-playback": 60,
  slice: 90,
  seek: 120,
  join: 180,
  leave: 180,
  "cache-evict": 300,
  fault: 900,
};
export function soakSchedule(config = {}) {
  assert.ok(
    config.scope === undefined ||
      ["formal", "smoke", "synthetic"].includes(config.scope),
    "native qualification requires its dedicated entry point",
  );
  if (config.actions !== undefined)
    assert.deepEqual(
      [...config.actions].sort(),
      [...SOAK_ACTIONS].sort(),
      "standard soak cannot reduce its action matrix",
    );
  if (config.scope === "formal")
    assert.equal(
      config.native_binding_path,
      undefined,
      "formal soak requires final candidate image binding",
    );
  const {
    duration_seconds = 259200,
    warmup_seconds = 1800,
    sample_seconds = 60,
    identity_seconds = 300,
    phase_seconds = 600,
    phases = [
      { id: "direct-1", mode: "direct", concurrency: 1 },
      { id: "direct-2", mode: "direct", concurrency: 2 },
      { id: "direct-5", mode: "direct", concurrency: 5 },
      { id: "direct-10", mode: "direct", concurrency: 10 },
    ],
    faults = ["F1", "F2", "F3", "F4"],
  } = config;
  for (const [name, value] of Object.entries({
    duration_seconds,
    sample_seconds,
    identity_seconds,
    phase_seconds,
  }))
    assert.ok(Number.isFinite(value) && value > 0, `invalid ${name}`);
  assert.ok(
    Number.isFinite(warmup_seconds) &&
      warmup_seconds >= 0 &&
      warmup_seconds < duration_seconds,
  );
  assert.ok(
    phases.length &&
      new Set(phases.map((phase) => phase.id)).size === phases.length,
  );
  for (const phase of phases)
    assert.ok(
      /^[a-z0-9-]+$/.test(phase.id) &&
        ["direct", "transcode"].includes(phase.mode) &&
        Number.isInteger(phase.concurrency) &&
        phase.concurrency > 0 &&
        phase.concurrency <= 100,
      "invalid load phase",
    );
  assert.ok(
    faults.length &&
      new Set(faults).size === faults.length &&
      faults.every((fault) => ["F1", "F2", "F3", "F4"].includes(fault)),
    "invalid fault matrix",
  );
  const cadence_seconds = { ...defaultCadence, ...config.cadence_seconds };
  assert.deepEqual(
    Object.keys(cadence_seconds).sort(),
    [...SOAK_ACTIONS].sort(),
    "unknown soak action",
  );
  for (const value of Object.values(cadence_seconds))
    assert.ok(Number.isFinite(value) && value > 0);
  if (config.scope === "formal") {
    assert.ok(
      duration_seconds >= 259200,
      "formal soak requires an uninterrupted 72h window",
    );
    assert.ok(
      sample_seconds <= 60 &&
        identity_seconds <= 300 &&
        phase_seconds >= 300 &&
        faults.length === 4,
      "formal soak requires bounded sampling, identity checks and F1–F4",
    );
    assert.ok(
      [1, 2, 5, 10].every((count) =>
        phases.some(
          (phase) => phase.mode === "direct" && phase.concurrency === count,
        ),
      ),
      "direct 1/2/5/10 capacity stages required",
    );
  }
  const events = [];
  const add = (kind, every, start = 0) => {
    for (
      let at = start, ordinal = 0;
      at < duration_seconds;
      at += every, ordinal++
    ) {
      assert.ok(events.length < 500000, "schedule exceeds bounded event limit");
      events.push({ kind, at_ms: Math.round(at * 1000), ordinal });
    }
  };
  add("phase", phase_seconds);
  for (const action of SOAK_ACTIONS)
    add(
      action,
      cadence_seconds[action],
      action === "leave"
        ? cadence_seconds[action] / 2
        : Math.min(cadence_seconds[action], duration_seconds / 2),
    );
  add("sample-resources", sample_seconds);
  add("verify-identity", identity_seconds);
  const priority = [
    "verify-identity",
    "phase",
    "loop-playback",
    "slice",
    "seek",
    "join",
    "leave",
    "cache-evict",
    "fault",
    "sample-resources",
  ];
  events.sort(
    (a, b) =>
      a.at_ms - b.at_ms || priority.indexOf(a.kind) - priority.indexOf(b.kind),
  );
  if (config.scope === "formal") {
    assert.ok(
      SOAK_ACTIONS.every((kind) => events.some((event) => event.kind === kind)),
      "formal schedule must actually include every workload action",
    );
    assert.ok(
      events.filter((event) => event.kind === "fault").length >= faults.length,
      "formal schedule must actually include F1–F4 starts",
    );
    assert.ok(
      events.filter((event) => event.kind === "phase").length >= phases.length,
      "formal schedule must actually include every capacity phase",
    );
  }
  return {
    duration_ms: duration_seconds * 1000,
    warmup_ms: warmup_seconds * 1000,
    phases,
    faults,
    cadence_seconds,
    sample_ms: sample_seconds * 1000,
    events,
  };
}

export const NATIVE_QUALIFICATION_ACTIONS = Object.freeze([
  "slice",
  "join",
  "leave",
  "stop-stream",
  "fault",
]);
export const NATIVE_REMAINING_GATES = Object.freeze([
  "final-candidate-image-identity",
  "presented-timecode-frames",
  "safe-cache-eviction",
  "F1",
  "F2",
  "F3",
  "F4",
  "full-capacity-matrix",
  "phase-matched-resource-trends",
  "uninterrupted-72-hours",
]);
export function nativeQualificationSchedule(config) {
  assert.equal(
    config.scope,
    "native-qualification",
    "explicit native-qualification scope required",
  );
  assert.ok(
    Array.isArray(config.actions),
    "explicit qualification action subset required",
  );
  const actions = [...config.actions];
  assert.ok(
    new Set(actions).size === actions.length &&
      actions.every((kind) => NATIVE_QUALIFICATION_ACTIONS.includes(kind)),
    "unsupported native qualification action",
  );
  assert.equal(
    actions.includes("join"),
    actions.includes("leave"),
    "join/leave must be scheduled together",
  );
  const faults = config.faults ?? [];
  assert.deepEqual(
    faults,
    actions.includes("fault") ? ["F4"] : [],
    "native qualification supports explicit F4 only",
  );
  assert.ok(
    Array.isArray(config.phases) &&
      config.phases.length > 0 &&
      config.phases.every(
        (phase) => phase.mode === "direct" && phase.concurrency <= 10,
      ),
    "explicit bounded direct phases required",
  );
  const duration_seconds = config.duration_seconds ?? 180;
  assert.ok(
    duration_seconds > 0 && duration_seconds <= 180,
    "native qualification is bounded to 180 seconds",
  );
  assert.ok(
    Number.isFinite(config.adapter_timeout_ms ?? 30000) &&
      (config.adapter_timeout_ms ?? 30000) > 0,
    "positive adapter call deadline required",
  );
  assert.ok(
    Number.isFinite(config.maximum_lateness_ms ?? 5000) &&
      (config.maximum_lateness_ms ?? 5000) >= 0,
    "nonnegative start lateness bound required",
  );
  const cadence = config.cadence_seconds ?? {};
  assert.ok(
    Object.keys(cadence).every((kind) => actions.includes(kind)),
    "qualification cadence outside selected subset",
  );
  const starts = config.action_start_seconds ?? {};
  assert.ok(
    Object.keys(starts).every((kind) => actions.includes(kind)),
    "qualification start outside selected subset",
  );
  const schedule = soakSchedule({
    ...config,
    scope: "smoke",
    actions: undefined,
    duration_seconds,
    warmup_seconds: config.warmup_seconds ?? 0,
    phase_seconds: config.phase_seconds ?? 60,
    sample_seconds: config.sample_seconds ?? 30,
    identity_seconds: config.identity_seconds ?? 30,
    faults: ["F4"],
    cadence_seconds: undefined,
  });
  schedule.events = schedule.events.filter((event) =>
    ["phase", "sample-resources", "verify-identity"].includes(event.kind),
  );
  schedule.faults = [...faults];
  schedule.cadence_seconds = {};
  const offsets = {
    leave: 0.1,
    join: 0.2,
    slice: 0.3,
    "stop-stream": 0.5,
    fault: 0.7,
  };
  for (const kind of actions) {
    const every = cadence[kind] ?? duration_seconds;
    const start = starts[kind] ?? duration_seconds * offsets[kind];
    assert.ok(
      Number.isFinite(every) &&
        every > 0 &&
        Number.isFinite(start) &&
        start > 0 &&
        start < duration_seconds,
      "invalid qualification action timing",
    );
    schedule.cadence_seconds[kind] = every;
    for (
      let at = start, ordinal = 0;
      at < duration_seconds;
      at += every, ordinal++
    ) {
      assert.ok(
        schedule.events.length < 500000,
        "schedule exceeds bounded event limit",
      );
      schedule.events.push({ kind, at_ms: Math.round(at * 1000), ordinal });
    }
  }
  const priority = [
    "verify-identity",
    "phase",
    "leave",
    "join",
    "slice",
    "stop-stream",
    "fault",
    "sample-resources",
  ];
  schedule.events.sort(
    (a, b) =>
      a.at_ms - b.at_ms || priority.indexOf(a.kind) - priority.indexOf(b.kind),
  );
  return schedule;
}

const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
async function bindNativeQualification(config, adapter) {
  assert.equal(
    adapter?.mode,
    "real",
    "qualification requires the real native adapter contract",
  );
  assert.ok(config.native_binding_path, "native_binding_path required");
  assert.ok(
    Array.isArray(config.command) && config.command.length,
    "execution command required",
  );
  const { verifyOwnedNativeBinding } =
    await import("../tests/fixtures/owned-native-soak.mjs");
  const verified = await verifyOwnedNativeBinding({
    binding_path: config.native_binding_path,
  });
  return {
    binding: verified.binding,
    check: verified.check,
    metadata: {
      run_id: randomUUID(),
      started_at: new Date().toISOString(),
      scope: "native-qualification",
      command: config.command,
      adapter: {
        id: adapter.id,
        mode: adapter.mode,
        source_sha256: adapter.source_sha256 ?? null,
      },
      native_binding: verified.metadata,
      coordinator: verified.coordinator,
    },
  };
}
function nativeIdentitySnapshot(actual, binding, resources, run_id) {
  assert.ok(
    actual?.observation_id && actual.fixture_id,
    "observed native identity provenance required",
  );
  assert.equal(
    actual.image_id,
    null,
    "native identity cannot claim a container image",
  );
  assert.ok(
    actual.database?.name &&
      Number.isInteger(actual.database.port) &&
      actual.database.port > 0 &&
      actual.database.data_directory?.startsWith("/"),
    "owned native database identity required",
  );
  assert.ok(
    Array.isArray(actual.processes) && actual.processes.length === 3,
    "server/worker/postgres identity required",
  );
  assert.equal(
    new Set(actual.processes.map((row) => row.pid)).size,
    3,
    "distinct native process roots required",
  );
  for (const [index, row] of actual.processes.entries()) {
    assert.ok(
      Number.isSafeInteger(row.pid) &&
        row.pid > 1 &&
        Number.isSafeInteger(row.parent_pid) &&
        /^\d+$/.test(row.start_ticks) &&
        row.exe?.startsWith("/"),
      "stable native process identity required",
    );
    assert.match(row.binary_sha256 ?? "", /^[a-f0-9]{64}$/);
    if (index < 2)
      assert.equal(
        row.binary_sha256,
        binding.binaries.find(
          (binary) =>
            binary.name === ["rainsync-server", "rainsync-media-worker"][index],
        ).sha256,
        "running native binary differs from frozen build",
      );
  }
  assert.deepEqual(
    resources,
    ["server", "worker", "postgres"].map((role) => `${run_id}:${role}`),
    "native owned resource population mismatch",
  );
  return freeze(
    structuredClone({
      fixture_id: actual.fixture_id,
      database: actual.database,
      processes: actual.processes,
      image_id: actual.image_id,
    }),
  );
}
const formalPolicy = Object.freeze({
  schedule: soakSchedule,
  bind: (config, adapter) => bindRun({ ...config, adapter }),
  identity_method: "artifactIdentity",
  identity_kind: "artifact-identity",
  checkIdentity: (actual, binding) => assertArtifactIdentity(actual, binding),
});
const nativePolicy = Object.freeze({
  schedule: nativeQualificationSchedule,
  bind: bindNativeQualification,
  identity_method: "nativeIdentity",
  identity_kind: "native-identity",
  native: true,
});

function checkActionReceipt(event, receipt, mode) {
  assert.equal(receipt?.mode, mode, "workload observation mode mismatch");
  assert.equal(receipt?.action, event.kind, "workload receipt action mismatch");
  assert.ok(receipt.observation_id, "workload observation provenance required");
  assert.equal(receipt.completed, true, "scheduled workload did not complete");
  assert.ok(
    receipt.evidence && typeof receipt.evidence === "object",
    "observed workload evidence required",
  );
  const evidence = receipt.evidence;
  if (event.kind === "phase") {
    assert.equal(evidence.mode, event.phase.mode);
    assert.equal(evidence.requested_concurrency, event.phase.concurrency);
    assert.ok(
      Number.isInteger(evidence.active_concurrency) &&
        evidence.active_concurrency >= 0 &&
        evidence.active_concurrency <= evidence.requested_concurrency,
    );
    assert.equal(
      evidence.active_concurrency + evidence.controlled_rejections,
      evidence.requested_concurrency,
      "all attempted streams need active or controlled-rejection evidence",
    );
  } else if (event.kind === "loop-playback")
    assert.ok(
      evidence.presented_frames > 0 && evidence.original_advanced_ms > 0,
      "playback loop requires rendered frames and advancing media",
    );
  else if (event.kind === "slice")
    assert.ok(
      evidence.completed_segments > 0 && evidence.failed_segments === 0,
      "slice production not proven",
    );
  else if (event.kind === "seek")
    assert.ok(
      evidence.requested_original_ms >= 0 &&
        evidence.presented_original_ms >= 0 &&
        Math.abs(
          evidence.requested_original_ms - evidence.presented_original_ms,
        ) <= 1000 &&
        evidence.presented_frames > 0,
      "seek requires presented destination evidence",
    );
  else if (event.kind === "join" || event.kind === "leave")
    assert.ok(
      evidence.members_before >= 0 &&
        evidence.members_after ===
          evidence.members_before + (event.kind === "join" ? 1 : -1) &&
        evidence.authority_snapshot_verified === true,
      "membership workload not proven",
    );
  else if (event.kind === "cache-evict")
    assert.ok(
      evidence.evicted_bytes > 0 &&
        evidence.cache_bytes <= evidence.cache_quota_bytes &&
        evidence.active_files_removed === 0,
      "safe cache eviction not proven",
    );
  else if (event.kind === "stop-stream") {
    assert.equal(evidence.check, "stop-stream");
    assert.equal(evidence.fault, undefined, "Stop cannot be labeled F4");
    assert.equal(evidence.revocation, "session-delete");
    assert.ok(
      evidence.injected_at_ms >= 0 &&
        evidence.recovered_at_ms >= evidence.injected_at_ms &&
        evidence.new_requests_denied > 0 &&
        evidence.long_stream_close_ms >= 0 &&
        evidence.long_stream_close_ms <= 10000 &&
        evidence.normal_eof === false &&
        evidence.unaffected_viewer_verified === true,
      "Stop stream closure not proven",
    );
  } else if (event.kind === "fault") {
    assert.equal(evidence.fault, event.fault);
    assert.ok(
      evidence.injected_at_ms >= 0 &&
        evidence.recovered_at_ms >= evidence.injected_at_ms,
      "fault/recovery timing required",
    );
    if (event.fault === "F1")
      assert.ok(
        evidence.signal === "SIGKILL" &&
          evidence.old_attempt_writes === 0 &&
          evidence.generation_drain_verified === true &&
          evidence.external_supervisor_verified === true,
        "F1 must prove forced-kill fencing and supervised generation drain",
      );
    if (event.fault === "F2")
      assert.ok(
        evidence.false_acks === 0 && evidence.writes_after_lock_loss === 0,
        "F2 false ACK/lock fencing failed",
      );
    if (event.fault === "F3")
      assert.ok(
        evidence.isolated_volume === true &&
          evidence.explained_failures > 0 &&
          evidence.corrupt_successes === 0 &&
          evidence.orphan_processes === 0,
        "F3 disk containment invariant failed",
      );
    if (event.fault === "F4")
      assert.ok(
        evidence.new_requests_denied > 0 &&
          evidence.long_stream_close_ms >= 0 &&
          evidence.long_stream_close_ms <= 10000,
        "F4 revocation window failed",
      );
  }
}

export function assessResourceTrends(trends, limits) {
  const failures = [];
  if (!trends.length) failures.push("no phase-matched resources");
  for (const trend of trends) {
    if (!trend.sufficient)
      failures.push(
        `${trend.entity}/${trend.phase}/${trend.instance_id}: insufficient post-warmup samples`,
      );
    for (const [metric, values] of Object.entries(trend.metrics)) {
      const bound = limits?.[metric];
      if (
        !bound ||
        !Number.isFinite(bound.maximum_slope_per_hour) ||
        !Number.isFinite(bound.maximum_late_growth) ||
        bound.maximum_slope_per_hour < 0 ||
        bound.maximum_late_growth < 0
      )
        failures.push(
          `explicit nonnegative resource trend limits missing: ${metric}`,
        );
      else if (
        values.slope_per_hour === null ||
        values.slope_per_hour > bound.maximum_slope_per_hour ||
        values.late_mean - values.early_mean > bound.maximum_late_growth
      )
        failures.push(
          `${trend.entity}/${trend.phase}/${metric}: resource growth exceeds declared limit`,
        );
    }
  }
  return { passed: failures.length === 0, failures };
}

// Verifier selection is fixed by these entry points, never by configuration.
export function runSoak(options) {
  return runScheduledSoak(options, formalPolicy);
}
export function runNativeSoakQualification(options) {
  return runScheduledSoak(options, nativePolicy);
}
async function runScheduledSoak(
  { config, adapter, output, dry_run = false, clock = systemClock, signal },
  policy,
) {
  const schedule = freeze(policy.schedule(config)),
    journal = await createJournal(output, {
      secrets: config.redaction_values ?? [],
    });
  const latestScheduledWorkloadStart = schedule.events.reduce(
    (latest, event) =>
      ["verify-identity", "sample-resources"].includes(event.kind)
        ? latest
        : Math.max(latest, event.at_ms),
    0,
  );
  const report = {
    schema_version: 1,
    gate: policy.native ? "native-soak-qualification" : "soak-72-hours",
    ...(policy.native
      ? {
          qualification_only: true,
          membership_sql_f4_completed: false,
          timing_budgets: {
            scheduled_workload_window_ms: schedule.duration_ms,
            prepare_call_ms: config.adapter_timeout_ms ?? 30000,
            action_call_ms: config.adapter_timeout_ms ?? 30000,
            final_identity_call_ms: config.adapter_timeout_ms ?? 30000,
            cleanup_wait_ms: config.adapter_timeout_ms ?? 30000,
            final_artifact_collection_call_ms:
              config.adapter_timeout_ms ?? 30000,
            fixture_resource_cleanup_each_ms: 5000,
            latest_scheduled_workload_start_ms: latestScheduledWorkloadStart,
            latest_scheduled_adapter_call_deadline_ms:
              latestScheduledWorkloadStart +
              (config.maximum_lateness_ms ?? 5000) +
              (config.adapter_timeout_ms ?? 30000),
            total_wall_clock_cap_ms: null,
            full_scheduled_work_drain_bound_ms: null,
            source_and_journal_io_deadline_ms: null,
            cleanup_ownership_ends_on_timeout: false,
          },
          remaining_gates: [...NATIVE_REMAINING_GATES],
          formal_gates: Object.fromEntries(
            NATIVE_REMAINING_GATES.map((gate) => [gate, "unfulfilled"]),
          ),
          formal_gates_fulfilled: false,
        }
      : {}),
    scope: dry_run ? "dry-run" : config.scope,
    result: "failed",
    accepted: false,
    release_ready: false,
    segments: [],
    cleanup_confirmed: false,
    counts: {},
    completed_counts: {},
    failure_samples: [],
  };
  await journal.write("schedule.json", schedule);
  if (dry_run) {
    report.result = "dry-run";
    report.planned_events = schedule.events.length;
    await journal.finish(report);
    return report;
  }
  const samples = [];
  const workController = new AbortController();
  const abortWork = () => workController.abort(signal.reason);
  if (signal?.aborted) abortWork();
  else signal?.addEventListener("abort", abortWork, { once: true });
  const pending = new Set(),
    activeKinds = new Set(),
    activeSlots = new Set();
  let workloadFailure;
  const call = (method, input, cleanup = false) =>
    boundedCall(adapter, method, input, {
      signal: cleanup ? undefined : workController.signal,
      timeout_ms: config.adapter_timeout_ms ?? 30000,
    });
  let binding, phase, expectedNativeIdentity, expectedResourceIds;
  let primary, finalIdentity;
  const secondary = [];
  const noteSecondary = (error, field) => {
    secondary.push(error);
    if (field) report[field] = error;
    report.secondary_errors = secondary;
    report.result = "failed";
  };
  const recordSafely = async (kind, value) => {
    try {
      await journal.record(kind, value);
    } catch (error) {
      noteSecondary(error, "journal_failure");
    }
  };
  try {
    if (adapter.mode === "real" && schedule.faults.length)
      assert.equal(
        config.faults_approved,
        true,
        "explicit fault-injection approval required before execution",
      );
    binding = await policy.bind(config, adapter);
    Object.assign(report, binding.metadata);
    await journal.write("metadata.json", binding.metadata);
    const prepared = await call("prepare", {
      run_id: report.run_id,
      binding: binding.binding,
      schedule,
      lifetime_signal: signal,
    });
    assert.ok(
      Array.isArray(prepared?.owned_resource_ids) &&
        prepared.owned_resource_ids.length > 0 &&
        prepared.owned_resource_ids.every(
          (entity) => typeof entity === "string" && entity.length > 0,
        ) &&
        new Set(prepared.owned_resource_ids).size ===
          prepared.owned_resource_ids.length,
      "adapter must report distinct nonempty owned resource identities",
    );
    // Keep our own immutable expected population. An adapter must not be able
    // to shrink it after prepare or after receiving a workload request.
    expectedResourceIds = Object.freeze([...prepared.owned_resource_ids]);
    const expectedResources = new Set(expectedResourceIds);
    assert.equal(
      prepared.host_mutations,
      false,
      "host/network-wide mutations prohibited",
    );
    assert.equal(
      prepared.isolated_fault_targets,
      true,
      "fault targets must be isolated and owned",
    );

    if (config.scope === "formal")
      assert.ok(
        schedule.phases.some((item) => item.mode === "transcode") ||
          prepared.transcode_unsupported_evidence,
        "include supported transcode capacity or measured unsupported evidence",
      );
    if (policy.native)
      expectedNativeIdentity = nativeIdentitySnapshot(
        prepared.native_identity,
        binding.binding,
        expectedResourceIds,
        report.run_id,
      );
    await journal.record("prepared", prepared);
    const start = clock.now();
    report.segments.push({ monotonic_start_ms: start });
    const identity = async (checkpoint, final = false) => {
      try {
        await binding.check();
      } catch (error) {
        if (!final) throw error;
        if (policy.native || report.source_unchanged === true)
          report.source_unchanged = false;
        noteSecondary(error, "final_source_binding_failure");
      }
      const actual = await call(
        policy.identity_method,
        {
          owned_resource_ids: [...expectedResourceIds],
          diagnostic: final,
        },
        final,
      );
      if (final) report.final_live_identity = actual;
      if (policy.native)
        assert.deepEqual(
          nativeIdentitySnapshot(
            actual,
            binding.binding,
            expectedResourceIds,
            report.run_id,
          ),
          expectedNativeIdentity,
          "native identity changed during qualification",
        );
      else policy.checkIdentity(actual, binding.binding);
      await journal.record(policy.identity_kind, { checkpoint, actual });
      return actual;
    };
    finalIdentity = () => identity("final-live", true);
    await identity("prepared");
    for (const event of schedule.events) {
      workController.signal.throwIfAborted();
      if (workloadFailure) throw workloadFailure;
      const due = start + event.at_ms;
      await clock.sleep(due - clock.now(), workController.signal);
      const lateness = clock.now() - due;
      assert.ok(
        lateness <= (config.maximum_lateness_ms ?? 5000),
        "soak workload missed planned cadence; no compressed catch-up",
      );
      report.counts[event.kind] = (report.counts[event.kind] ?? 0) + 1;
      if (event.kind === "verify-identity") await identity("scheduled");
      else if (event.kind === "sample-resources") {
        const observed = await call("sampleResources", {
          phase,
          elapsed_ms: clock.now() - start,
        });
        const elapsed_ms = clock.now() - start;
        const rows = Array.isArray(observed) ? observed : [];
        const counts = new Map();
        const invalidRows = [];
        for (const [index, row] of rows.entries()) {
          if (!row || typeof row.entity !== "string" || !row.entity) {
            invalidRows.push(index);
            continue;
          }
          counts.set(row.entity, (counts.get(row.entity) ?? 0) + 1);
        }
        const coverage = {
          expected_resource_ids: [...expectedResourceIds],
          observed_resource_ids: [...counts.keys()],
          missing: expectedResourceIds.filter((entity) => !counts.has(entity)),
          duplicates: [...counts]
            .filter(([, count]) => count > 1)
            .map(([entity]) => entity),
          unexpected: [...counts.keys()].filter(
            (entity) => !expectedResources.has(entity),
          ),
          unavailable: rows
            .filter(
              (row) => row?.unavailable === true || row?.available === false,
            )
            .map((row) => row.entity),
          invalid_rows: invalidRows,
        };
        const complete =
          Array.isArray(observed) &&
          rows.length === expectedResourceIds.length &&
          [
            coverage.missing,
            coverage.duplicates,
            coverage.unexpected,
            coverage.unavailable,
            coverage.invalid_rows,
          ].every((items) => items.length === 0);
        await journal.record("resource-coverage", {
          elapsed_ms,
          phase: phase.id,
          complete,
          ...coverage,
        });
        if (!complete) {
          for (const entity of coverage.missing)
            await journal.record("resource-unavailable", {
              entity,
              phase: phase.id,
              elapsed_ms,
              unavailable: true,
              reason: "missing-from-sample",
            });
          const failureSample = {
            event,
            elapsed_ms,
            phase: phase.id,
            coverage,
            observed,
          };
          report.failure_samples.push(failureSample);
          await journal.record("failed-resource-sample", failureSample);
          throw Error(
            "resource sample must contain each expected resource exactly once and available",
          );
        }
        for (const row of rows) {
          assert.equal(row.phase, phase.id, "resource phase mismatch");
          assert.ok(
            row.observation_id,
            "resource observation provenance required",
          );
          if (policy.native) {
            const index = expectedResourceIds.indexOf(row.entity),
              root = expectedNativeIdentity.processes[index];
            assert.equal(
              row.instance_id,
              `${root.pid}:${root.start_ticks}`,
              "sample native process generation mismatch",
            );
          }
          const sample = { ...row, elapsed_ms };
          samples.push(sample);
          await journal.record("resource-sample", sample);
        }
      } else {
        if (event.kind === "phase")
          phase = schedule.phases[event.ordinal % schedule.phases.length];
        const request = {
          ...event,
          phase,
          run_id: report.run_id,
          owned_resource_ids: [...expectedResourceIds],
          ...(event.kind === "fault"
            ? { fault: schedule.faults[event.ordinal % schedule.faults.length] }
            : {}),
        };
        assert.ok(
          !activeKinds.has(event.kind),
          `prior ${event.kind} still running at its next scheduled start`,
        );
        const slot =
          policy.native &&
          (["stop-stream", "fault"].includes(event.kind)
            ? "long-stream-actor"
            : ["join", "leave"].includes(event.kind)
              ? "membership-actor"
              : null);
        if (slot)
          assert.ok(
            !activeSlots.has(slot),
            `prior ${slot} still running; overlapping actions rejected`,
          );
        const perform = async () => {
          let receipt, started_ms;
          try {
            if (policy.native) await binding.check();
            started_ms = clock.now();
            assert.ok(
              started_ms - due <= (config.maximum_lateness_ms ?? 5000),
              "workload invocation missed planned cadence",
            );
            receipt = await call("perform", request);
            const finished_ms = clock.now();
            if (policy.native) await binding.check();
            checkActionReceipt(request, receipt, adapter.mode);
            if (policy.native) {
              assert.equal(
                receipt.run_id,
                report.run_id,
                "receipt run mismatch",
              );
              assert.deepEqual(
                receipt.owned_resource_ids,
                expectedResourceIds,
                "receipt resource population mismatch",
              );
              assert.deepEqual(
                receipt.phase,
                request.phase,
                "receipt phase mismatch",
              );
              if (request.kind === "fault") {
                assert.equal(
                  receipt.evidence.revocation,
                  "owned-membership-sql-fault",
                  "F4 requires actual membership SQL revocation",
                );
                assert.equal(
                  receipt.evidence.old_grant_denied_after_rejoin,
                  true,
                );
                assert.equal(receipt.evidence.unaffected_viewer_verified, true);
                assert.equal(receipt.evidence.normal_eof, false);
                assert.notEqual(
                  receipt.evidence.membership_epoch_before,
                  receipt.evidence.membership_epoch_after,
                );
                report.membership_sql_f4_completed = true;
              }
            }
            await journal.record("workload", {
              event: request,
              receipt,
              started_ms,
              finished_ms,
              lateness_ms: started_ms - due,
              completion_lateness_ms: finished_ms - due,
              source_binding: policy.native
                ? report.native_binding
                : binding.binding.source_sha256,
            });
            report.completed_counts[event.kind] =
              (report.completed_counts[event.kind] ?? 0) + 1;
          } catch (error) {
            report.failure_samples.push({ event: request, receipt, error });
            await recordSafely("failed-workload", {
              event: request,
              receipt,
              error,
            });
            throw error;
          }
        };
        // Changing load phase is a barrier. Other workloads may stay in flight
        // while resource observations keep their fixed cadence (notably F1/F2).
        if (event.kind === "phase") {
          await Promise.all(pending);
          if (workloadFailure) throw workloadFailure;
          assert.ok(
            clock.now() - due <= (config.maximum_lateness_ms ?? 5000),
            "phase barrier missed planned cadence",
          );
          await identity({ kind: "phase", phase });
          await perform();
          await identity({ kind: "phase-completed", phase });
        } else {
          activeKinds.add(event.kind);
          if (slot) activeSlots.add(slot);
          const task = perform()
            .catch((error) => {
              workloadFailure ??= error;
              workController.abort(error);
            })
            .finally(() => {
              activeKinds.delete(event.kind);
              if (slot) activeSlots.delete(slot);
              pending.delete(task);
            });
          pending.add(task);
        }
      }
      if (["verify-identity", "sample-resources"].includes(event.kind))
        report.completed_counts[event.kind] =
          (report.completed_counts[event.kind] ?? 0) + 1;
    }
    await clock.sleep(
      start + schedule.duration_ms - clock.now(),
      workController.signal,
    );
    await Promise.all(pending);
    if (workloadFailure) throw workloadFailure;
    report.segments[0].monotonic_end_ms = clock.now();
    await identity("completed");
    for (const kind of new Set(schedule.events.map((event) => event.kind)))
      assert.equal(
        report.completed_counts[kind],
        schedule.events.filter((event) => event.kind === kind).length,
        `planned ${kind} was omitted`,
      );
    report.resource_trends = resourceTrends(samples, {
      warmup_ms: schedule.warmup_ms,
    });
    report.resource_assessment = assessResourceTrends(
      report.resource_trends,
      config.resource_limits,
    );
    if (!policy.native)
      assert.ok(
        report.resource_assessment.passed,
        "phase-matched resource evidence incomplete or exceeds configured limits",
      );
    report.source_unchanged = true;
    if (policy.native) report.native_identity_unchanged = true;
    else report.artifact_unchanged = true;
    report.result = "passed";
  } catch (error) {
    primary = workloadFailure ?? error;
    report.result = signal?.aborted ? "interrupted" : "failed";
    report.failure = primary;
    await recordSafely("failure", primary);
  } finally {
    workController.abort(primary ?? Error("run finalized"));
    await Promise.allSettled(pending);
    if (report.segments.length && !report.segments[0].monotonic_end_ms)
      report.segments[0].monotonic_end_ms = clock.now();
    // Drained work, then independent live diagnostics, then release/disposal.
    // Every stage runs even if an earlier observation or sink fails.
    if (finalIdentity) {
      try {
        report.final_live_identity = await finalIdentity();
      } catch (error) {
        if (policy.native) report.native_identity_unchanged = false;
        else report.artifact_unchanged = false;
        noteSecondary(error, "final_identity_failure");
      }
    }
    try {
      const cleanup = await call("cleanup", { failure: primary }, true);
      report.cleanup_confirmed = cleanup?.confirmed === true;
      await recordSafely("cleanup", cleanup);
      if (!report.cleanup_confirmed)
        noteSecondary(Error("adapter cleanup unconfirmed"));
    } catch (error) {
      report.cleanup_confirmed = error.report?.cleanup?.confirmed === true;
      if (error.report) report.finalized_native_report = error.report;
      if (error.report?.error === primary && report.cleanup_confirmed) {
        for (const secondaryError of error.report.secondary_errors ?? [])
          noteSecondary(secondaryError);
      } else noteSecondary(error, "cleanup_failure");
    }
    try {
      const artifacts = await call(
        "collectArtifacts",
        { failed: report.result !== "passed" },
        true,
      );
      if (policy.native) {
        assert.equal(
          artifacts?.completed,
          true,
          "native fixture report must be finalized before collection",
        );
        assert.ok(
          artifacts.report && artifacts.report.schema_version === 1,
          "finalized native fixture report unavailable",
        );
        if (artifacts.report) report.finalized_native_report = artifacts.report;
      }
      await journal.write("adapter-artifacts.json", artifacts);
    } catch (error) {
      noteSecondary(error, "artifact_collection_failure");
    }
    signal?.removeEventListener("abort", abortWork);
    report.finished_at = new Date().toISOString();
    try {
      await journal.finish(report);
    } catch (error) {
      noteSecondary(error, "report_write_failure");
      // Existing scheduler callers receive reports for workload errors. If the
      // final sink itself fails, retain that same primary error and full report.
      const failure = primary ?? error;
      failure.report = report;
      throw failure;
    }
  }
  return report;
}
