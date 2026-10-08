import assert from "node:assert/strict";
import { test } from "node:test";
import {
  distribution,
  startup,
  playbackWindow,
  throughput,
  reconnect,
  syncErrors,
} from "../scripts/acceptance-measurements.mjs";

test("first frame includes preparation queue and requires presentation evidence", () => {
  assert.deepEqual(
    startup({
      requested_ms: 100,
      prepared_ms: 1100,
      loaded_ms: 1200,
      presented_ms: 1500,
      evidence: "video-frame-callback",
    }),
    {
      total_ms: 1400,
      prepare_ms: 1000,
      load_ms: 100,
      present_ms: 300,
      evidence: "video-frame-callback",
    },
  );
  assert.throws(() =>
    startup({ requested_ms: 0, presented_ms: 1, evidence: "loadedmetadata" }),
  );
  assert.throws(() =>
    startup({
      requested_ms: 10,
      presented_ms: 1,
      evidence: "video-frame-callback",
    }),
  );
});

test("buffering uses duration rather than sample counts and preserves excluded periods", () => {
  let start = 0;
  const intervals = [
    ["startup", 2000, true],
    ["autoplay-blocked", 1000, true],
    ["playing", 9000, true],
    ["rebuffering", 1000, true],
    ["playing", 100000, false],
  ].map(([state, duration, foreground]) => {
    const interval = {
      state,
      start_ms: start,
      end_ms: start + duration,
      foreground,
      expected_playing: true,
    };
    start += duration;
    return interval;
  });
  const measured = playbackWindow(intervals);
  assert.equal(measured.rebuffer_ratio, 0.1);
  assert.equal(measured.observed_ms, 113000);
  assert.equal(measured.background_ms, 100000);
  assert.throws(
    () => playbackWindow([intervals[0], intervals[2]]),
    /omitted time/,
  );
});

test("concurrent throughput uses active wall time and retains failed transfer time", () => {
  const layer = "worker-egress";
  const transfers = [
    {
      layer,
      start_ms: 0,
      end_ms: 1000,
      delivered_bytes: 1000,
      completed: true,
    },
    {
      layer,
      start_ms: 0,
      end_ms: 1000,
      delivered_bytes: 2000,
      completed: true,
    },
    {
      layer,
      start_ms: 1000,
      end_ms: 2000,
      delivered_bytes: 400,
      completed: false,
    },
  ];
  assert.equal(throughput(transfers, layer).bytes_per_second, 1500);
  assert.equal(throughput(transfers, layer).failed_bytes, 400);
  assert.throws(() => throughput(transfers, "nas-uplink"), /transport layers/);
});

test("control and media reconnect recovery have distinct endpoints", () => {
  assert.deepEqual(
    reconnect({
      network_restored_ms: 1000,
      snapshot_applied_ms: 1500,
      media_caught_up_ms: 4000,
    }),
    { control_ms: 500, media_ms: 3000 },
  );
  assert.equal(
    reconnect({ network_restored_ms: 0, snapshot_applied_ms: 20 }).media_ms,
    null,
  );
});

test("sync aligns independent monotonic clocks and reports coverage and authority separately", () => {
  const left = {
    monotonic_ms: 100,
    reference_offset_ms: 900,
    original_position_ms: 5000,
    playback_rate: 1,
    playing: true,
    clock_uncertainty_ms: 5,
  };
  const right = {
    ...left,
    monotonic_ms: 1000,
    reference_offset_ms: 100,
    original_position_ms: 5120,
  };
  const attempts = [
    {
      room: "r1",
      reference_ms: 1200,
      left,
      right,
      authority_position_ms: 5200,
    },
    { room: "r1", reference_ms: 1200, left: { ...left, seeking: true }, right },
    { room: "r1", reference_ms: 5000, left, right },
  ];
  const [summary] = syncErrors(attempts);
  assert.equal(summary.peer_error_ms.p95, 20);
  assert.equal(summary.authority_error_ms.p95, 20);
  assert.equal(summary.valid_ratio, 1 / 3);
  assert.equal(summary.pair_clock_uncertainty_ms.max, 10);
  assert.throws(
    () =>
      syncErrors([
        { ...attempts[0], left: { ...left, reference_offset_ms: undefined } },
      ]),
    /calibration/,
  );
});

test("empty distributions remain missing evidence and reject invalid numbers", () => {
  assert.equal(distribution([]).p95, null);
  assert.throws(() => distribution([NaN]));
  assert.equal(throughput([], "worker-egress").bytes_per_second, null);
});
