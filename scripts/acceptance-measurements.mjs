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
