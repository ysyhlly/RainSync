// Offline measurement contract. These functions consume evidence, not live
// protocol messages; player/relay instrumentation must be integrated by owners.
import assert from "node:assert/strict";

export const MEASUREMENT_SCHEMA = 1;
const finite = (value, name, minimum = 0) => {
  assert.ok(Number.isFinite(value) && value >= minimum, `invalid ${name}`);
  return value;
};
const elapsed = (start, end) => {
  finite(start, "monotonic start");
  finite(end, "monotonic end");
  assert.ok(end >= start, "monotonic interval reversed");
  return end - start;
};

export function distribution(values) {
  const sorted = values
    .map((v) => finite(v, "measurement"))
    .sort((a, b) => a - b);
  const percentile = (p) =>
    sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  };
}

export function startup({
  requested_ms,
  presented_ms,
  evidence,
  prepared_ms,
  loaded_ms,
}) {
  assert.ok(
    ["video-frame-callback", "playing-and-time-advance"].includes(evidence),
    "first frame needs presentation evidence",
  );
  const total_ms = elapsed(requested_ms, presented_ms);
  if (prepared_ms === undefined && loaded_ms === undefined)
    return { total_ms, evidence };
  assert.ok(
    prepared_ms !== undefined && loaded_ms !== undefined,
    "partial startup breakdown",
  );
  return {
    total_ms,
    // Preparation includes queueing and probing. No omitted queue denominator.
    prepare_ms: elapsed(requested_ms, prepared_ms),
    load_ms: elapsed(prepared_ms, loaded_ms),
    present_ms: elapsed(loaded_ms, presented_ms),
    evidence,
  };
}

export function playbackWindow(intervals) {
  const summary = {
    observed_ms: 0,
    expected_playback_ms: 0,
    rebuffer_ms: 0,
    startup_ms: 0,
    autoplay_blocked_ms: 0,
    background_ms: 0,
    seeking_ms: 0,
    rebuffer_ratio: null,
  };
  let end;
  for (const interval of intervals) {
    assert.ok(
      [
        "startup",
        "autoplay-blocked",
        "playing",
        "rebuffering",
        "seeking",
        "paused",
      ].includes(interval.state),
      "unknown playback state",
    );
    assert.equal(
      typeof interval.foreground,
      "boolean",
      "foreground must be observed",
    );
    assert.equal(
      typeof interval.expected_playing,
      "boolean",
      "play intent must be observed",
    );
    const duration = elapsed(interval.start_ms, interval.end_ms);
    assert.ok(
      end === undefined || interval.start_ms === end,
      "playback window must be contiguous with no omitted time",
    );
    end = interval.end_ms;
    summary.observed_ms += duration;
    if (!interval.foreground) {
      summary.background_ms += duration;
      continue;
    }
    if (interval.state === "startup") {
      summary.startup_ms += duration;
      continue;
    }
    if (interval.state === "autoplay-blocked") {
      summary.autoplay_blocked_ms += duration;
      continue;
    }
    if (!interval.expected_playing) continue;
    assert.notEqual(
      interval.state,
      "paused",
      "paused state conflicts with observed play intent",
    );
    summary.expected_playback_ms += duration;
    if (interval.state === "rebuffering") summary.rebuffer_ms += duration;
    if (interval.state === "seeking") summary.seeking_ms += duration;
  }
  if (summary.expected_playback_ms > 0)
    summary.rebuffer_ratio = summary.rebuffer_ms / summary.expected_playback_ms;
  return summary;
}

function unionDuration(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start_ms - b.start_ms);
  let total = 0,
    start,
    end;
  for (const item of sorted) {
    elapsed(item.start_ms, item.end_ms);
    if (start === undefined) {
      start = item.start_ms;
      end = item.end_ms;
    } else if (item.start_ms > end) {
      total += end - start;
      start = item.start_ms;
      end = item.end_ms;
    } else end = Math.max(end, item.end_ms);
  }
  return total + (start === undefined ? 0 : end - start);
}

export function throughput(transfers, layer) {
  assert.ok(
    ["worker-egress", "nas-uplink", "upstream-read"].includes(layer),
    "unknown transfer layer",
  );
  let successful_bytes = 0,
    failed_bytes = 0;
  for (const transfer of transfers) {
    assert.equal(
      transfer.layer,
      layer,
      "do not sum bytes across transport layers",
    );
    assert.equal(
      typeof transfer.completed,
      "boolean",
      "transfer outcome is required",
    );
    assert.ok(
      Number.isSafeInteger(transfer.delivered_bytes),
      "invalid delivered byte count",
    );
    finite(transfer.delivered_bytes, "delivered bytes");
    assert.ok(
      elapsed(transfer.start_ms, transfer.end_ms) > 0,
      "zero duration transfer",
    );
    if (transfer.completed) successful_bytes += transfer.delivered_bytes;
    else failed_bytes += transfer.delivered_bytes;
    assert.ok(
      Number.isSafeInteger(successful_bytes + failed_bytes),
      "byte aggregate exceeds precision",
    );
  }
  // Union avoids double counting overlapping transfers. Failed transfer time
  // remains in the denominator, so failures cannot inflate successful goodput.
  const active_wall_ms = unionDuration(transfers);
  return {
    layer,
    successful_bytes,
    failed_bytes,
    active_wall_ms,
    bytes_per_second: active_wall_ms
      ? (successful_bytes * 1000) / active_wall_ms
      : null,
  };
}

export function reconnect({
  network_restored_ms,
  snapshot_applied_ms,
  media_caught_up_ms,
}) {
  return {
    control_ms: elapsed(network_restored_ms, snapshot_applied_ms),
    media_ms:
      media_caught_up_ms === undefined
        ? null
        : elapsed(network_restored_ms, media_caught_up_ms),
  };
}

function alignedPosition(sample, reference_ms, max_age_ms, max_uncertainty_ms) {
  if (!sample || sample.buffering || sample.seeking || !sample.playing)
    return null;
  for (const key of [
    "monotonic_ms",
    "original_position_ms",
    "clock_uncertainty_ms",
  ])
    finite(sample[key], key);
  assert.ok(
    Number.isFinite(sample.reference_offset_ms),
    "independent clock calibration required",
  );
  finite(sample.playback_rate, "playback rate");
  const captured = sample.monotonic_ms + sample.reference_offset_ms;
  const age = reference_ms - captured;
  if (
    age < 0 ||
    age > max_age_ms ||
    sample.clock_uncertainty_ms > max_uncertainty_ms
  )
    return null;
  return sample.original_position_ms + age * sample.playback_rate;
}

export function syncErrors(
  attempts,
  { max_age_ms = 1000, max_uncertainty_ms = 50 } = {},
) {
  finite(max_age_ms, "maximum sample age");
  finite(max_uncertainty_ms, "maximum clock uncertainty");
  const rooms = new Map();
  for (const attempt of attempts) {
    assert.ok(
      typeof attempt.room === "string" && attempt.room.length > 0,
      "room measurement grouping required",
    );
    finite(attempt.reference_ms, "reference instant");
    const room = rooms.get(attempt.room) ?? {
      attempted: 0,
      peer: [],
      authority: [],
      uncertainties: [],
    };
    rooms.set(attempt.room, room);
    room.attempted++;
    const left = alignedPosition(
      attempt.left,
      attempt.reference_ms,
      max_age_ms,
      max_uncertainty_ms,
    );
    const right = alignedPosition(
      attempt.right,
      attempt.reference_ms,
      max_age_ms,
      max_uncertainty_ms,
    );
    if (left === null || right === null) continue;
    room.peer.push(Math.abs(left - right));
    room.uncertainties.push(
      attempt.left.clock_uncertainty_ms + attempt.right.clock_uncertainty_ms,
    );
    if (attempt.authority_position_ms !== undefined) {
      finite(attempt.authority_position_ms, "authoritative original position");
      room.authority.push(
        Math.abs(left - attempt.authority_position_ms),
        Math.abs(right - attempt.authority_position_ms),
      );
    }
  }
  return [...rooms].map(([room, samples]) => ({
    room,
    attempted: samples.attempted,
    valid: samples.peer.length,
    valid_ratio: samples.peer.length / samples.attempted,
    peer_error_ms: distribution(samples.peer),
    authority_error_ms: distribution(samples.authority),
    pair_clock_uncertainty_ms: distribution(samples.uncertainties),
  }));
}

// Four-timestamp exchanges are made by the test controller, independently of
// RainSync's synchronizer. offset maps a client monotonic clock to the controller.
// The interval is conservative even on an asymmetric link; it does not assume
// the forward and return delays are equal.
export function calibrateClock(
  exchanges,
  { client_id, clock_id, drift_ppm = 100, max_age_ms = 60000 } = {},
) {
  assert.ok(
    typeof client_id === "string" && client_id,
    "client identity required",
  );
  assert.ok(typeof clock_id === "string" && clock_id, "clock epoch required");
  finite(drift_ppm, "clock drift bound");
  finite(max_age_ms, "calibration lifetime");
  assert.ok(
    exchanges.length >= 3,
    "at least three independent clock exchanges required",
  );
  let lower = -Infinity,
    upper = Infinity,
    newest = 0;
  const observations = exchanges.map((exchange) => {
    assert.equal(exchange.client_id, client_id, "cross-client calibration");
    assert.equal(exchange.clock_id, clock_id, "client clock epoch changed");
    const {
      reference_send_ms: a,
      client_receive_ms: b,
      client_send_ms: c,
      reference_receive_ms: d,
    } = exchange;
    const referenceDuration = elapsed(a, d),
      clientDuration = elapsed(b, c);
    assert.ok(
      referenceDuration >= clientDuration,
      "invalid clock exchange duration",
    );
    newest = Math.max(newest, c);
    return {
      lower: a - b,
      upper: d - c,
      client_ms: c,
      rtt_ms: referenceDuration - clientDuration,
    };
  });
  for (const observation of observations) {
    const drift = ((newest - observation.client_ms) * drift_ppm) / 1e6;
    lower = Math.max(lower, observation.lower - drift);
    upper = Math.min(upper, observation.upper + drift);
  }
  assert.ok(
    lower <= upper,
    "clock exchanges disagree: reset or drift bound exceeded",
  );
  return {
    client_id,
    clock_id,
    method: "independent-four-timestamp",
    reference_offset_ms: (lower + upper) / 2,
    clock_uncertainty_ms: (upper - lower) / 2,
    calibrated_client_ms: newest,
    max_age_ms,
    drift_ppm,
    exchanges: exchanges.length,
    round_trip_ms: distribution(
      observations.map((observation) => observation.rtt_ms),
    ),
  };
}

export function applyCalibration(sample, calibration) {
  assert.equal(
    sample.client_id,
    calibration.client_id,
    "cross-client calibration",
  );
  assert.equal(
    sample.clock_id,
    calibration.clock_id,
    "client clock epoch changed",
  );
  finite(sample.monotonic_ms, "client sample time");
  const age = sample.monotonic_ms - calibration.calibrated_client_ms;
  assert.ok(Math.abs(age) <= calibration.max_age_ms, "stale clock calibration");
  // Never accept offsets supplied by the player under test.
  return {
    ...sample,
    reference_offset_ms: calibration.reference_offset_ms,
    clock_uncertainty_ms:
      calibration.clock_uncertainty_ms +
      (Math.abs(age) * calibration.drift_ppm) / 1e6,
  };
}

export function syncSummary(attempts, options = {}) {
  const rooms = syncErrors(attempts, options);
  const pooled =
    syncErrors(
      attempts.map((attempt) => ({ ...attempt, room: "all-observations" })),
      options,
    )[0] ?? null;
  return {
    rooms,
    // Pooled distribution is computed from observations, never averaged p95s.
    pooled,
    worst_room:
      rooms
        .filter((room) => room.valid > 0)
        .sort((a, b) => b.peer_error_ms.p95 - a.peer_error_ms.p95)[0]?.room ??
      null,
  };
}

// Phase-matched time series, not just first/last RSS. Slopes are descriptive;
// thresholds are explicit run configuration, not invented universal leak limits.
export function resourceTrends(
  samples,
  { warmup_ms = 0, minimum_samples = 6 } = {},
) {
  finite(warmup_ms, "resource warmup");
  assert.ok(Number.isInteger(minimum_samples) && minimum_samples >= 4);
  const keys = [
    "rss_bytes",
    "fd_count",
    "socket_count",
    "process_count",
    "cache_bytes",
  ];
  const groups = new Map();
  for (const sample of samples) {
    finite(sample.elapsed_ms, "resource sample time");
    if (sample.elapsed_ms < warmup_ms) continue;
    assert.ok(
      sample.entity && sample.phase && sample.instance_id,
      "resource entity, phase and instance required",
    );
    const group = JSON.stringify([
      sample.entity,
      sample.phase,
      sample.instance_id,
    ]);
    const values = groups.get(group) ?? [];
    assert.ok(
      !values.length || sample.elapsed_ms > values.at(-1).elapsed_ms,
      "resource times must increase within a phase",
    );
    for (const key of keys) finite(sample[key], key);
    finite(sample.cache_quota_bytes, "cache quota");
    assert.ok(
      sample.cache_bytes <= sample.cache_quota_bytes,
      "cache exceeds quota",
    );
    values.push(sample);
    groups.set(group, values);
  }
  return [...groups.values()].map((values) => {
    const result = {
      entity: values[0].entity,
      phase: values[0].phase,
      instance_id: values[0].instance_id,
      count: values.length,
      sufficient: values.length >= minimum_samples,
      metrics: {},
    };
    const n = values.length,
      third = Math.max(1, Math.floor(n / 3));
    const mean = (array) => array.reduce((a, b) => a + b, 0) / array.length;
    const xs = values.map(
      (sample) => (sample.elapsed_ms - values[0].elapsed_ms) / 3600000,
    );
    const xm = mean(xs),
      variance = xs.reduce((sum, x) => sum + (x - xm) ** 2, 0);
    for (const key of keys) {
      const ys = values.map((sample) => sample[key]),
        ym = mean(ys);
      result.metrics[key] = {
        ...distribution(ys),
        early_mean: mean(ys.slice(0, third)),
        late_mean: mean(ys.slice(-third)),
        slope_per_hour: variance
          ? xs.reduce((sum, x, i) => sum + (x - xm) * (ys[i] - ym), 0) /
            variance
          : null,
      };
    }
    return result;
  });
}
