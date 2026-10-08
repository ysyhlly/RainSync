import assert from "node:assert/strict";
import {
  calibrateClock,
  applyCalibration,
  syncSummary,
  distribution,
  playbackWindow,
} from "./acceptance-measurements.mjs";
import {
  systemClock,
  boundedCall,
  createJournal,
  bindRun,
  assertArtifactIdentity,
} from "./acceptance-runtime.mjs";

export const NETWORK_SCENARIOS = Object.freeze([
  { id: "N1", description: "normal", rtt_max_ms: 100, peer_p95_max_ms: 300 },
  {
    id: "N2",
    description: "weak",
    requested_rtt_ms: 300,
    requested_jitter_ms: 100,
    requested_loss_ratio: 0.02,
    peer_p95_max_ms: 800,
  },
  {
    id: "N3",
    description: "10-second disconnection",
    disconnect_ms: 10000,
    control_recovery_max_ms: 5000,
  },
  { id: "N4", description: "70% of video demand", bandwidth_demand_ratio: 0.7 },
  { id: "N5", description: "asymmetric uplink delay", asymmetric: true },
  { id: "N6", description: "one slow member", restricted_members: 1 },
]);

export function networkSchedule(config = {}) {
  const {
    duration_seconds = 1800,
    warmup_seconds = 60,
    repeats = 3,
    sample_ms = 1000,
    calibration_ms = 30000,
    scopes = ["control", "media", "shared"],
    scenarios = NETWORK_SCENARIOS.map((item) => item.id),
  } = config;
  for (const [name, value] of Object.entries({
    duration_seconds,
    sample_ms,
    calibration_ms,
  }))
    assert.ok(Number.isFinite(value) && value > 0, `invalid ${name}`);
  assert.ok(Number.isFinite(warmup_seconds) && warmup_seconds >= 0);
  assert.ok(Number.isInteger(repeats) && repeats > 0 && repeats <= 100);
  assert.ok(
    sample_ms <= 1000 && calibration_ms >= sample_ms && calibration_ms <= 60000,
  );
  assert.ok(
    scopes.length &&
      new Set(scopes).size === scopes.length &&
      scopes.every((scope) => ["control", "media", "shared"].includes(scope)),
    "invalid network scopes",
  );
  assert.ok(
    scenarios.length &&
      new Set(scenarios).size === scenarios.length &&
      scenarios.every((id) => NETWORK_SCENARIOS.some((item) => item.id === id)),
    "invalid scenario selection",
  );
  if (config.scope === "formal") {
    assert.ok(
      duration_seconds >= 1800 &&
        repeats >= 3 &&
        scopes.length === 3 &&
        scenarios.length === 6,
      "formal network matrix needs all N1–N6, all scopes, >=30 minutes and >=3 repetitions",
    );
  }
  return {
    duration_ms: duration_seconds * 1000,
    warmup_ms: warmup_seconds * 1000,
    sample_ms,
    calibration_ms,
    runs: scenarios.flatMap((id) =>
      scopes.flatMap((scope) =>
        Array.from({ length: repeats }, (_, repeat) => ({
          ...NETWORK_SCENARIOS.find((scenario) => scenario.id === id),
          scope,
          repeat: repeat + 1,
        })),
      ),
    ),
  };
}

function validateProbe(probe, mode) {
  assert.equal(
    probe?.mode,
    mode,
    "probe mode must match adapter; synthetic is never applied-network evidence",
  );
  assert.ok(
    probe.observation_id && probe.method,
    "network observation source required",
  );
  assert.ok(
    Number.isSafeInteger(probe.sent_packets) &&
      probe.sent_packets > 0 &&
      Number.isSafeInteger(probe.lost_packets) &&
      probe.lost_packets >= 0 &&
      probe.lost_packets <= probe.sent_packets,
    "measured packet denominator required",
  );
  for (const key of [
    "rtt_ms",
    "jitter_ms",
    "uplink_bps",
    "downlink_bps",
    "uplink_delay_ms",
    "downlink_delay_ms",
    "video_demand_bps",
  ])
    assert.ok(
      Number.isFinite(probe[key]) && probe[key] >= 0,
      `invalid observed ${key}`,
    );
  assert.ok(probe.video_demand_bps > 0, "measured media demand required");
  assert.ok(
    Number.isFinite(probe.start_ms) &&
      probe.start_ms >= 0 &&
      probe.end_ms > probe.start_ms,
    "network measurement window required",
  );
}

function verifyTimecodes(checks, clients) {
  assert.ok(
    Array.isArray(checks),
    "independent visible timecode checks required",
  );
  for (const client of clients) {
    const check = checks.find((item) => item.client_id === client.client_id);
    assert.ok(
      check &&
        check.method === "visible-frame-timecode" &&
        check.observation_id,
      "every client needs independent visible-frame verification",
    );
    assert.match(
      check.frame_sha256 ?? "",
      /^[a-f0-9]{64}$/,
      "timecode frame artifact hash required",
    );
    for (const key of [
      "visible_original_position_ms",
      "sample_original_position_ms",
      "tolerance_ms",
    ])
      assert.ok(
        Number.isFinite(check[key]) && check[key] >= 0,
        "invalid frame-timecode observation",
      );
    assert.ok(
      check.tolerance_ms <= 100 &&
        Math.abs(
          check.visible_original_position_ms -
            check.sample_original_position_ms,
        ) <= check.tolerance_ms,
      "frame-timecode mapping differs from measurement",
    );
  }
}

export async function collectCalibrations(clients, call, clock = systemClock) {
  return new Map(
    await Promise.all(
      clients.map(async (client) => {
        const exchanges = [];
        for (let i = 0; i < 5; i++) {
          const reference_send_ms = clock.now();
          const reply = await call("clockExchange", {
            client_id: client.client_id,
            clock_id: client.clock_id,
          });
          const reference_receive_ms = clock.now();
          exchanges.push({ ...reply, reference_send_ms, reference_receive_ms });
        }
        return [
          client.client_id,
          { calibration: calibrateClock(exchanges, client), exchanges },
        ];
      }),
    ),
  );
}

export function assessNetworkRun(scenario, summary, observations) {
  const reasons = [];
  const require = (condition, text) => {
    if (!condition) reasons.push(text);
  };
  require(summary.pooled?.valid_ratio >=
    0.95, "valid steady-state sample coverage below 95%");
  require(summary.rooms.length > 0 &&
    summary.rooms.every((room) => room.valid > 0), "room observations missing");
  require(summary.rooms.every(
    (room) => room.authority_error_ms.count > 0,
  ), "separate authority-target error observations missing");
  if (scenario.peer_p95_max_ms)
    require(summary.rooms.every(
      (room) =>
        room.peer_error_ms.p95 !== null &&
        room.peer_error_ms.p95 <= scenario.peer_p95_max_ms,
    ), "worst-room sync p95 exceeds scenario limit");
  const probes = observations.probes;
  const last = probes.at(-1);
  if (scenario.id === "N1")
    require(probes.every(
      (probe) =>
        probe.rtt_ms <= 100 && probe.downlink_bps >= probe.video_demand_bps,
    ), "N1 observed link is not normal/adequate");
  if (scenario.id === "N2")
    require(probes.every(
      (probe) =>
        probe.rtt_ms >= 200 &&
        probe.rtt_ms <= 400 &&
        probe.jitter_ms >= 50 &&
        probe.jitter_ms <= 150 &&
        probe.lost_packets / probe.sent_packets >= 0.005 &&
        probe.lost_packets / probe.sent_packets <= 0.05 &&
        probe.downlink_bps >= probe.video_demand_bps,
    ), "N2 actual RTT/jitter/loss/bandwidth outside declared scenario");
  if (scenario.id === "N3") {
    const recoveries = observations.recoveries;
    require(recoveries.length >
      0, "N3 independently observed disconnect/recovery missing");
    require(recoveries.every(
      (entry) =>
        entry.disconnected_ms >= 10000 &&
        entry.control_ms >= 0 &&
        entry.control_ms <= 5000 &&
        Number.isFinite(entry.media_ms) &&
        entry.media_ms >= 0,
    ), "N3 outage or control/media recovery invalid");
  }
  if (scenario.id === "N4") {
    require(probes.every(
      (probe) =>
        probe.downlink_bps / probe.video_demand_bps >= 0.6 &&
        probe.downlink_bps / probe.video_demand_bps <= 0.8,
    ), "N4 actual bandwidth is not approximately 70% demand");
    require(observations.invariants.some(
      (item) =>
        item.kind === "bandwidth-response" &&
        (item.buffering_ms > 0 || item.existing_quality_reductions > 0) &&
        item.unrequested_seeks === 0,
    ), "N4 buffering/quality response and no-seek-storm evidence missing");
  }
  if (scenario.id === "N5")
    require(probes.every(
      (probe) => probe.uplink_delay_ms >= probe.downlink_delay_ms + 100,
    ), "N5 measured asymmetry missing");
  if (scenario.id === "N6")
    require(observations.invariants.some(
      (item) =>
        item.kind === "single-member-isolation" &&
        item.restricted_client_ids?.length === 1 &&
        item.authority_before_sha256 === item.authority_after_sha256 &&
        /^[a-f0-9]{64}$/.test(item.authority_before_sha256 ?? "") &&
        item.healthy_connections_lost === 0 &&
        item.healthy_peer_p95_ms >= 0 &&
        item.healthy_peer_p95_ms <= 300,
    ), "N6 authority/healthy-peer isolation evidence missing");
  require(Boolean(last), "actual network probes missing");
  return { passed: reasons.length === 0, reasons };
}

export async function runNetwork({
  config,
  adapter,
  output,
  dry_run = false,
  clock = systemClock,
  signal,
}) {
  const schedule = networkSchedule(config);
  const journal = await createJournal(output, {
    secrets: config.redaction_values ?? [],
  });
  const report = {
    schema_version: 1,
    gate: "weak-network",
    scope: dry_run ? "dry-run" : config.scope,
    result: "failed",
    release_ready: false,
    accepted: false,
    schedule,
    runs: [],
    cleanup_confirmed: false,
    segments: [],
  };
  await journal.write("schedule.json", schedule);
  if (dry_run) {
    report.result = "dry-run";
    await journal.finish(report);
    return report;
  }
  let binding;
  const call = (method, input, cleanup = false) =>
    boundedCall(adapter, method, input, {
      signal: cleanup ? undefined : signal,
      timeout_ms: config.adapter_timeout_ms ?? 30000,
    });
  try {
    binding = await bindRun({ ...config, adapter });
    Object.assign(report, binding.metadata);
    await journal.write("metadata.json", binding.metadata);
    await call("prepare", {
      run_id: report.run_id,
      binding: binding.binding,
      schedule,
    });
    const artifact = await call("artifactIdentity", {});
    assertArtifactIdentity(artifact, binding.binding);
    await journal.record("artifact-identity", artifact);
    const start = clock.now();
    report.segments.push({ monotonic_start_ms: start });
    for (const scenario of schedule.runs) {
      signal?.throwIfAborted();
      await binding.check();
      const scenarioStart = clock.now();
      const run = {
        scenario,
        started_ms: scenarioStart,
        status: "running",
        attempted: 0,
        exclusions: {},
        recoveries: [],
        invariants: [],
        probes: [],
      };
      report.runs.push(run);
      // Ownership is verified before calling the effectful adapter method.
      const isolation = await call("inspectIsolation", {
        run_id: report.run_id,
        scenario,
      });
      assert.equal(
        isolation.run_id,
        report.run_id,
        "network isolation is not owned by this run",
      );
      assert.equal(
        isolation.host_network,
        false,
        "host network shaping is prohibited",
      );
      assert.ok(
        isolation.namespace_id && isolation.interfaces?.length,
        "dedicated namespace/interfaces required",
      );
      if (adapter.mode === "real")
        assert.equal(
          config.network_change_approved,
          true,
          "network changes require separate action-time approval before execution",
        );
      await journal.record("isolation", isolation);
      try {
        const applied = await call("applyNetwork", {
          scenario,
          isolation,
          run_id: report.run_id,
        });
        assert.equal(applied.mode, adapter.mode);
        assert.equal(applied.namespace_id, isolation.namespace_id);
        assert.ok(
          applied.observation_id && applied.settings,
          "network application receipt/settings required",
        );
        await journal.record("network-application", { scenario, applied });
        const clients = await call("clients", { scenario });
        assert.ok(
          Array.isArray(clients) &&
            clients.length >= 2 &&
            new Set(clients.map((client) => client.client_id)).size ===
              clients.length,
          "distinct clients required",
        );
        const rooms = new Map();
        for (const client of clients) {
          assert.ok(client.client_id && client.room && client.clock_id);
          const members = rooms.get(client.room) ?? [];
          members.push(client);
          rooms.set(client.room, members);
        }
        assert.ok(
          [...rooms.values()].every((members) => members.length >= 2),
          "each room needs two independent clients",
        );
        const checks = await call("timecodeChecks", { clients });
        verifyTimecodes(checks, clients);
        await journal.record("timecode-checks", checks);
        let calibrations,
          nextCalibration = 0;
        const attempts = [],
          uncertainties = [];
        const playback = new Map(
          clients.map((client) => [client.client_id, []]),
        );
        const sampleStart = clock.now(),
          end = sampleStart + schedule.warmup_ms + schedule.duration_ms;
        let tick = 0;
        while (true) {
          const due = Math.min(end, sampleStart + tick++ * schedule.sample_ms);
          await clock.sleep(due - clock.now(), signal);
          const lateness = clock.now() - due;
          assert.ok(
            lateness <= (config.maximum_lateness_ms ?? 2000),
            "network sampler missed its cadence",
          );
          if (clock.now() >= nextCalibration) {
            calibrations = await collectCalibrations(clients, call, clock);
            await journal.record("calibration", [...calibrations.values()]);
            nextCalibration = clock.now() + schedule.calibration_ms;
            const probe = await call("probeNetwork", { scenario, isolation });
            validateProbe(probe, adapter.mode);
            run.probes.push(probe);
            await journal.record("network-probe", { scenario, probe });
          }
          const observed = await call("sample", {
            clients,
            scenario,
            due_ms: due,
          });
          const reference_ms = clock.now();
          assert.ok(
            Array.isArray(observed.clients) &&
              observed.clients.length === clients.length,
            "all attempted clients must be reported, including unavailable clients",
          );
          const byId = new Map(
            observed.clients.map((sample) => [sample.client_id, sample]),
          );
          assert.equal(
            byId.size,
            clients.length,
            "duplicate/missing sampled client",
          );
          const warmup = reference_ms < sampleStart + schedule.warmup_ms;
          const exclusions = [];
          const mapped = new Map();
          for (const client of clients) {
            const sample = byId.get(client.client_id);
            assert.ok(sample, "sample changed client identity");
            if (!sample.unavailable) {
              assert.ok(
                Array.isArray(sample.playback_intervals),
                "explicit playback intervals required, not inferred duration from sample counts",
              );
              playback.get(client.client_id).push(...sample.playback_intervals);
            }
            let reason = warmup
              ? "warmup"
              : sample.unavailable
                ? "unavailable"
                : !sample.foreground
                  ? "background"
                  : sample.seeking
                    ? "seeking"
                    : sample.buffering
                      ? "buffering"
                      : !sample.playing
                        ? "not-playing"
                        : null;
            let aligned = null;
            if (!reason) {
              try {
                aligned = applyCalibration(
                  sample,
                  calibrations.get(client.client_id).calibration,
                );
                if (
                  aligned.clock_uncertainty_ms >
                  (config.max_uncertainty_ms ?? 50)
                )
                  reason = "clock-uncertainty";
                const age =
                  reference_ms -
                  (aligned.monotonic_ms + aligned.reference_offset_ms);
                if (age < 0 || age > (config.max_sample_age_ms ?? 1000))
                  reason = "sample-future-or-stale";
              } catch (error) {
                reason = "invalid-calibration";
                exclusions.push({
                  client_id: client.client_id,
                  error: error.message,
                });
              }
            }
            if (reason) {
              run.exclusions[reason] = (run.exclusions[reason] ?? 0) + 1;
              exclusions.push({ client_id: client.client_id, reason });
            } else uncertainties.push(aligned.clock_uncertainty_ms);
            mapped.set(client.client_id, reason ? null : aligned);
          }
          for (const [room, members] of rooms)
            for (let left = 0; left < members.length; left++)
              for (let right = left + 1; right < members.length; right++) {
                run.attempted++;
                if (!warmup) {
                  const authority = observed.authority?.[room];
                  let authority_position_ms;
                  if (authority) {
                    assert.ok(
                      Number.isFinite(authority.reference_ms) &&
                        authority.reference_ms <= reference_ms &&
                        reference_ms - authority.reference_ms <=
                          (config.max_sample_age_ms ?? 1000),
                      "authority observation reference time missing or stale",
                    );
                    assert.ok(
                      Number.isFinite(authority.original_position_ms) &&
                        authority.original_position_ms >= 0 &&
                        Number.isFinite(authority.playback_rate) &&
                        authority.playback_rate >= 0 &&
                        typeof authority.playing === "boolean",
                      "authority observation incomplete",
                    );
                    authority_position_ms =
                      authority.original_position_ms +
                      (authority.playing
                        ? (reference_ms - authority.reference_ms) *
                          authority.playback_rate
                        : 0);
                  }
                  attempts.push({
                    room,
                    reference_ms,
                    left: mapped.get(members[left].client_id),
                    right: mapped.get(members[right].client_id),
                    authority_position_ms,
                  });
                }
              }
          if (observed.recoveries) run.recoveries.push(...observed.recoveries);
          if (observed.invariants) run.invariants.push(...observed.invariants);
          await journal.record("sync-attempt", {
            scenario,
            due_ms: due,
            reference_ms,
            lateness_ms: lateness,
            warmup,
            observed,
            exclusions,
          });
          if (due === end) break;
        }
        await clock.sleep(end - clock.now(), signal);
        run.finished_ms = clock.now();
        const finalProbe = await call("probeNetwork", { scenario, isolation });
        validateProbe(finalProbe, adapter.mode);
        run.probes.push(finalProbe);
        await journal.record("network-probe-final", {
          scenario,
          probe: finalProbe,
        });
        const finalTimecodes = await call("timecodeChecks", { clients });
        verifyTimecodes(finalTimecodes, clients);
        await journal.record("timecode-checks-final", finalTimecodes);
        run.summary = syncSummary(attempts, {
          max_uncertainty_ms: config.max_uncertainty_ms ?? 50,
          max_age_ms: config.max_sample_age_ms ?? 1000,
        });
        run.clock_uncertainty_ms = distribution(uncertainties);
        run.all_attempt_valid_ratio = run.attempted
          ? (run.summary.pooled?.valid ?? 0) / run.attempted
          : 0;
        run.playback = [...playback].map(([client_id, intervals]) => ({
          client_id,
          ...playbackWindow(intervals),
        }));
        assert.ok(
          run.playback.every(
            (item) =>
              item.observed_ms >=
              schedule.duration_ms +
                schedule.warmup_ms -
                2 * (config.max_uncertainty_ms ?? 50),
          ),
          "complete playback duration denominator missing",
        );
        run.assessment = assessNetworkRun(scenario, run.summary, run);
        run.status = run.assessment.passed ? "passed" : "failed";
      } finally {
        const restored = await call(
          "restoreNetwork",
          { run_id: report.run_id, scenario, isolation },
          true,
        );
        assert.equal(restored.restored, true, "network restore unconfirmed");
        await journal.record("network-restored", restored);
      }
    }
    report.segments[0].monotonic_end_ms = clock.now();
    await binding.check();
    const finalIdentity = await call("artifactIdentity", {});
    assertArtifactIdentity(finalIdentity, binding.binding);
    await journal.record("artifact-identity", finalIdentity);
    report.source_unchanged = report.artifact_unchanged = true;
    assert.ok(
      report.runs.every((run) => run.status === "passed"),
      "one or more network scenarios failed their observed invariants",
    );
    report.result = "passed";
  } catch (error) {
    report.result = signal?.aborted ? "interrupted" : "failed";
    report.failure = error;
    await journal.record("failure", error);
  } finally {
    if (report.segments.length && !report.segments[0].monotonic_end_ms)
      report.segments[0].monotonic_end_ms = clock.now();
    try {
      const artifacts = await call(
        "collectArtifacts",
        { failed: report.result !== "passed" },
        true,
      );
      await journal.write("adapter-artifacts.json", artifacts);
    } catch (error) {
      report.artifact_collection_failure = error;
      report.result = "failed";
    }
    try {
      const cleanup = await call("cleanup", {}, true);
      report.cleanup_confirmed = cleanup?.confirmed === true;
      await journal.record("cleanup", cleanup);
      if (!report.cleanup_confirmed) report.result = "failed";
    } catch (error) {
      report.cleanup_failure = error;
      report.result = "failed";
    }
    report.finished_at = new Date().toISOString();
    await journal.finish(report);
  }
  return report;
}
