import { expect, test } from "vitest";
import {
  createPlaybackMetrics,
  PLAYBACK_METRICS_MAX_GAP_MS,
  PLAYBACK_METRICS_SAMPLE_MS,
  type PlaybackMetricsFence,
  type PlaybackMetricsObservation,
  type PlaybackMetricsSnapshot,
} from "../apps/web/src/features/playback/playback-metrics";

const playing: PlaybackMetricsObservation = {
  foreground: true,
  expectedPlaying: true,
  paused: false,
  buffering: false,
  seeking: false,
  autoplayBlocked: false,
};
function setup(t0 = 0, created = t0) {
  let now = created;
  let live: PlaybackMetricsFence | undefined = { identity: {}, generation: 1 };
  const fence = live;
  const meter = createPlaybackMetrics({
    t0,
    startupOrigin: "user_intent",
    fence,
    current: () => live,
    initial: playing,
    now: () => now,
  });
  return {
    meter,
    fence,
    at: (value: number) => (now = value),
    live: (value: PlaybackMetricsFence | undefined) => (live = value),
    next: (generation = 2) => {
      const next = { identity: fence.identity, generation };
      live = next;
      return next;
    },
  };
}
function conserved(snapshot: PlaybackMetricsSnapshot) {
  expect(Object.values(snapshot.totals).reduce((a, b) => a + b, 0)).toBe(
    snapshot.elapsed_ms,
  );
  expect(snapshot.observed_ms + snapshot.totals.unobserved_ms).toBe(
    snapshot.elapsed_ms,
  );
  expect(snapshot.expected_playback_ms).toBe(
    snapshot.totals.playing_ms +
      snapshot.totals.seeking_ms +
      snapshot.totals.rebuffer_ms,
  );
  for (const value of Object.values(snapshot.totals))
    expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
}

test("5s snapshots are cumulative and absent first-frame evidence is never zero", () => {
  const { meter, fence, at } = setup();
  at(4_999);
  expect(meter.sample(fence, playing)).toBeUndefined();
  at(5_000);
  const a = meter.sample(fence, playing)!;
  expect(a).toMatchObject({
    source: "client_reported",
    seq: 1,
    elapsed_ms: 5_000,
    startup_origin: "user_intent",
    totals: { startup_ms: 5_000 },
  });
  expect(a).not.toHaveProperty("first_frame");
  expect(meter.sample(fence, playing)).toBeUndefined();
  at(10_000);
  const b = meter.sample(fence, playing)!;
  expect(b.seq).toBe(2);
  expect(b.totals.startup_ms).toBe(10_000);
  expect(a.totals.startup_ms).toBe(5_000);
  expect(Object.isFrozen(a) && Object.isFrozen(a.totals)).toBe(true);
  conserved(a);
  conserved(b);
});

test("all states use mutually exclusive intervals, even with overlapping flags", () => {
  const { meter, fence, at } = setup();
  const steps: [number, PlaybackMetricsObservation][] = [
    [
      1_000,
      { ...playing, autoplayBlocked: true, seeking: true, buffering: true },
    ],
    [
      2_000,
      {
        ...playing,
        foreground: false,
        autoplayBlocked: true,
        seeking: true,
        buffering: true,
      },
    ],
    [3_000, playing],
  ];
  for (const [time, state] of steps) {
    at(time);
    expect(meter.observe(fence, state)).toBe(true);
  }
  expect(
    meter.firstFrame(
      fence,
      { presentedAtMs: 3_000, evidence: "video_frame_callback" },
      playing,
    ),
  ).toBe(true);
  at(4_000);
  meter.observe(fence, {
    ...playing,
    expectedPlaying: false,
    paused: true,
    seeking: true,
    buffering: true,
  });
  at(5_000);
  meter.observe(fence, { ...playing, seeking: true, buffering: true });
  at(6_000);
  meter.observe(fence, { ...playing, buffering: true, paused: true });
  at(7_000);
  meter.observe(fence, { ...playing, paused: true });
  at(8_000);
  const snapshot = meter.dispose(fence, playing)!;
  expect(snapshot.totals).toEqual({
    startup_ms: 1_000,
    autoplay_blocked_ms: 1_000,
    background_ms: 1_000,
    playing_ms: 1_000,
    paused_ms: 1_000,
    seeking_ms: 1_000,
    rebuffer_ms: 1_000,
    unobserved_ms: 1_000,
  });
  expect(snapshot.expected_playback_ms).toBe(3_000);
  conserved(snapshot);
});

test("automatic fallback retains user t0 and rejects old generation frame/cleanup", () => {
  const { meter, fence, at, next } = setup(100);
  at(1_100);
  const fallback = next(7);
  expect(meter.observe(fence, playing)).toBe(false);
  expect(meter.beginAttempt(fallback, playing)).toBe(true);
  expect(
    meter.firstFrame(
      fence,
      { presentedAtMs: 1_100, evidence: "video_frame_callback" },
      playing,
    ),
  ).toBe(false);
  expect(meter.dispose(fence, playing)).toBeUndefined();
  at(3_100);
  expect(
    meter.firstFrame(
      fallback,
      { presentedAtMs: 3_050, evidence: "video_frame_callback" },
      playing,
    ),
  ).toBe(true);
  at(5_100);
  const snapshot = meter.sample(fallback, playing)!;
  expect(snapshot.generation).toBe(7);
  expect(snapshot.first_frame).toEqual({
    elapsed_ms: 2_950,
    confirmed_elapsed_ms: 3_000,
    evidence: "video_frame_callback",
  });
  expect(snapshot.totals.startup_ms).toBe(3_000);
  expect(snapshot.totals.playing_ms).toBe(2_000);
  conserved(snapshot);
});

test("fallback after first presentation adds rebuffer time without rewriting first frame", () => {
  const { meter, fence, at, next } = setup();
  at(1_000);
  meter.firstFrame(
    fence,
    { presentedAtMs: 1_000, evidence: "playing_time_advance" },
    playing,
  );
  at(3_000);
  const fallback = next();
  meter.beginAttempt(fallback, playing);
  at(4_000);
  meter.firstFrame(
    fallback,
    { presentedAtMs: 4_000, evidence: "video_frame_callback" },
    playing,
  );
  at(5_000);
  const snapshot = meter.sample(fallback, playing)!;
  expect(snapshot.first_frame).toEqual({
    elapsed_ms: 1_000,
    confirmed_elapsed_ms: 1_000,
    evidence: "playing_time_advance",
  });
  expect(snapshot.totals).toMatchObject({
    startup_ms: 1_000,
    playing_ms: 3_000,
    rebuffer_ms: 1_000,
  });
  conserved(snapshot);
});

test("repeated first-frame capture is idempotent and cannot serve as a new coverage witness", () => {
  const { meter, fence, at } = setup();
  at(1_000);
  const frame = {
    presentedAtMs: 900,
    evidence: "video_frame_callback" as const,
  };
  expect(meter.firstFrame(fence, frame, playing)).toBe(true);
  at(10_000);
  expect(meter.firstFrame(fence, frame, playing)).toBe(true);
  expect(
    meter.firstFrame(fence, { ...frame, presentedAtMs: 950 }, playing),
  ).toBe(false);
  at(20_000);
  const snapshot = meter.sample(fence, playing)!;
  expect(snapshot.first_frame?.elapsed_ms).toBe(900);
  expect(snapshot.totals).toMatchObject({
    startup_ms: 1_000,
    playing_ms: 0,
    unobserved_ms: 19_000,
  });
  conserved(snapshot);
});

test("greater than 15s reliable-observation gaps are entirely unobserved", () => {
  for (const gap of [15_001, 60_000, 3_600_000]) {
    const { meter, fence, at } = setup();
    at(gap);
    const snapshot = meter.sample(fence, { ...playing, foreground: false })!;
    expect(snapshot.totals.unobserved_ms).toBe(gap);
    expect(snapshot.totals.background_ms).toBe(0);
    expect(snapshot.totals.startup_ms).toBe(0);
    conserved(snapshot);
    at(gap + 5_000);
    expect(meter.sample(fence, playing)!.totals.background_ms).toBe(5_000);
  }
});

test("exactly 15s stays observed; fresh sub-cadence reads bridge known intervals", () => {
  expect(PLAYBACK_METRICS_SAMPLE_MS).toBe(5_000);
  expect(PLAYBACK_METRICS_MAX_GAP_MS).toBe(15_000);
  const { meter, fence, at } = setup();
  at(15_000);
  expect(meter.sample(fence, playing)!.totals.startup_ms).toBe(15_000);
  at(19_999);
  expect(meter.sample(fence, playing)).toBeUndefined();
  at(20_000);
  const snapshot = meter.sample(fence, playing)!;
  expect(snapshot.totals.startup_ms).toBe(20_000);
  expect(snapshot.totals.unobserved_ms).toBe(0);
  conserved(snapshot);
});

test("backdated origin retains startup latency but earlier state is unknown", () => {
  const { meter, fence, at } = setup(100, 2_000);
  at(3_000);
  meter.firstFrame(
    fence,
    { presentedAtMs: 2_950, evidence: "video_frame_callback" },
    playing,
  );
  at(7_000);
  const snapshot = meter.sample(fence, playing)!;
  expect(snapshot.first_frame?.elapsed_ms).toBe(2_850);
  expect(snapshot.totals).toMatchObject({
    unobserved_ms: 1_900,
    startup_ms: 1_000,
    playing_ms: 4_000,
  });
  conserved(snapshot);
});

test("fractional boundaries conserve integer time and raw clock rollback is rejected", () => {
  const { meter, fence, at } = setup(0.9);
  at(1.8);
  meter.observe(fence, { ...playing, foreground: false });
  at(2.6);
  meter.observe(fence, playing);
  at(2.5);
  expect(meter.observe(fence, playing)).toBe(false);
  at(5_001.1);
  const snapshot = meter.sample(fence, playing)!;
  expect(snapshot.elapsed_ms).toBe(5_001);
  expect(snapshot.totals.background_ms).toBe(1);
  conserved(snapshot);
});

test.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "invalid clock %s leaves counters and cadence untouched",
  (bad) => {
    const { meter, fence, at } = setup();
    at(bad);
    expect(meter.observe(fence, playing)).toBe(false);
    expect(meter.sample(fence, playing)).toBeUndefined();
    expect(meter.dispose(fence, playing)).toBeUndefined();
    at(5_000);
    const snapshot = meter.sample(fence, playing)!;
    expect(snapshot.seq).toBe(1);
    expect(snapshot.totals.startup_ms).toBe(5_000);
    conserved(snapshot);
  },
);

test("frame timestamps/evidence are validated without changing coverage", () => {
  const { meter, fence, at, next } = setup();
  at(1_000);
  const fallback = next();
  meter.beginAttempt(fallback, playing);
  at(2_000);
  for (const presentedAtMs of [-1, NaN, Infinity, 999, 2_001])
    expect(
      meter.firstFrame(
        fallback,
        { presentedAtMs, evidence: "video_frame_callback" },
        playing,
      ),
    ).toBe(false);
  expect(
    meter.firstFrame(
      fallback,
      { presentedAtMs: 2_000, evidence: "loadeddata" as never },
      playing,
    ),
  ).toBe(false);
  expect(
    meter.firstFrame(
      fence,
      { presentedAtMs: 2_000, evidence: "video_frame_callback" },
      playing,
    ),
  ).toBe(false);
  at(5_000);
  const snapshot = meter.sample(fallback, playing)!;
  expect(snapshot).not.toHaveProperty("first_frame");
  expect(snapshot.totals.startup_ms).toBe(5_000);
});

test("identity/auth/room replacement fences every operation even with a stored old fence", () => {
  const { meter, fence, at, live } = setup();
  live({ identity: {}, generation: 1 });
  at(5_000);
  expect(meter.observe(fence, playing)).toBe(false);
  expect(
    meter.beginAttempt({ identity: fence.identity, generation: 2 }, playing),
  ).toBe(false);
  expect(
    meter.firstFrame(
      fence,
      { presentedAtMs: 5_000, evidence: "video_frame_callback" },
      playing,
    ),
  ).toBe(false);
  expect(meter.sample(fence, playing)).toBeUndefined();
  expect(meter.dispose(fence, playing)).toBeUndefined();
  live(undefined);
  expect(meter.sample(fence, playing)).toBeUndefined();
});

test("generation duplicates/regressions/invalid values never reset an attempt", () => {
  const { meter, fence, at, live, next } = setup();
  at(1_000);
  meter.firstFrame(
    fence,
    { presentedAtMs: 1_000, evidence: "video_frame_callback" },
    playing,
  );
  expect(meter.beginAttempt(fence, playing)).toBe(false);
  for (const generation of [0, -1, 1.5, NaN, Infinity, 0x1_0000_0000]) {
    const bad = { identity: fence.identity, generation };
    live(bad);
    expect(meter.beginAttempt(bad, playing)).toBe(false);
  }
  const nextFence = next(3);
  at(2_000);
  expect(meter.beginAttempt(nextFence, playing)).toBe(true);
  live(fence);
  expect(meter.beginAttempt(fence, playing)).toBe(false);
  live(nextFence);
  at(5_000);
  const snapshot = meter.sample(nextFence, playing)!;
  expect(snapshot.first_frame?.elapsed_ms).toBe(1_000);
  expect(snapshot.totals.rebuffer_ms).toBe(3_000);
});

test("final capture bypasses cadence, closes once, and snapshots contain no identity", () => {
  const { meter, fence, at } = setup();
  at(50);
  const snapshot = meter.dispose(fence, playing)!;
  expect(snapshot).toMatchObject({ final: true, seq: 1, elapsed_ms: 50 });
  expect(snapshot).not.toHaveProperty("identity");
  expect(meter.dispose(fence, playing)).toBeUndefined();
  expect(meter.observe(fence, playing)).toBe(false);
  expect(meter.sample(fence, playing)).toBeUndefined();
  expect(
    meter.firstFrame(
      fence,
      { presentedAtMs: 50, evidence: "video_frame_callback" },
      playing,
    ),
  ).toBe(false);
  conserved(snapshot);
});

test("malformed observations do not create a reliable witness", () => {
  const { meter, fence, at } = setup();
  at(10_000);
  expect(meter.observe(fence, { ...playing, buffering: 1 as never })).toBe(
    false,
  );
  at(20_000);
  expect(meter.sample(fence, playing)!.totals.unobserved_ms).toBe(20_000);
});

test("throwing clock/current suppliers fail closed without changing coverage or cadence", () => {
  let now = 0;
  let clockThrows = false;
  let currentThrows = false;
  const fence = { identity: {}, generation: 1 };
  const meter = createPlaybackMetrics({
    t0: 0,
    startupOrigin: "automatic_load",
    fence,
    current: () => {
      if (currentThrows) throw new Error("disposed owner");
      return fence;
    },
    initial: playing,
    now: () => {
      if (clockThrows) throw new Error("clock unavailable");
      return now;
    },
  });
  now = 10_000;
  for (const supplier of ["clock", "current"]) {
    clockThrows = supplier === "clock";
    currentThrows = supplier === "current";
    expect(meter.observe(fence, playing)).toBe(false);
    expect(meter.sample(fence, playing)).toBeUndefined();
    expect(meter.dispose(fence, playing)).toBeUndefined();
    expect(
      meter.firstFrame(
        fence,
        { presentedAtMs: now, evidence: "video_frame_callback" },
        playing,
      ),
    ).toBe(false);
  }
  clockThrows = currentThrows = false;
  now = 20_000;
  const snapshot = meter.sample(fence, playing)!;
  expect(snapshot.seq).toBe(1);
  expect(snapshot.startup_origin).toBe("automatic_load");
  expect(snapshot.totals.unobserved_ms).toBe(20_000);
  expect(snapshot).not.toHaveProperty("first_frame");
  conserved(snapshot);
});

test("maximum accepted time retains exact bounded totals and rejects overflow", () => {
  const { meter, fence, at } = setup();
  at(Number.MAX_SAFE_INTEGER);
  const snapshot = meter.sample(fence, playing)!;
  expect(snapshot.totals.unobserved_ms).toBe(Number.MAX_SAFE_INTEGER);
  conserved(snapshot);
  at(Number.MAX_SAFE_INTEGER + 1);
  expect(meter.dispose(fence, playing)).toBeUndefined();
  at(Number.MAX_SAFE_INTEGER);
  conserved(meter.dispose(fence, playing)!);
});

test("one meter retains finite state across many events without identity/sample history", () => {
  const { meter, fence, at } = setup();
  for (let i = 1; i <= 100_000; i++) {
    at(i);
    expect(meter.observe(fence, { ...playing, foreground: i % 2 === 0 })).toBe(
      true,
    );
  }
  const snapshot = meter.dispose(fence, playing)!;
  expect(Object.keys(meter).sort()).toEqual([
    "beginAttempt",
    "dispose",
    "firstFrame",
    "observe",
    "sample",
  ]);
  expect(Object.keys(snapshot.totals)).toHaveLength(8);
  expect(JSON.stringify(snapshot).length).toBeLessThan(700);
  conserved(snapshot);
});

test("invalid origin/state/fence is rejected before a meter is created", () => {
  for (const t0 of [-1, NaN, Infinity, 2])
    expect(() =>
      createPlaybackMetrics({
        t0,
        startupOrigin: "user_intent",
        fence: { identity: {}, generation: 1 },
        current: () => undefined,
        initial: playing,
        now: () => 1,
      }),
    ).toThrow(RangeError);
  expect(() =>
    createPlaybackMetrics({
      t0: 0,
      startupOrigin: "other" as never,
      fence: { identity: {}, generation: 1 },
      current: () => undefined,
      initial: playing,
      now: () => 1,
    }),
  ).toThrow(RangeError);
  expect(() =>
    createPlaybackMetrics({
      t0: 0,
      startupOrigin: "user_intent",
      fence: { identity: {}, generation: 0 },
      current: () => undefined,
      initial: playing,
      now: () => 1,
    }),
  ).toThrow(RangeError);
  expect(() =>
    createPlaybackMetrics({
      t0: 0,
      startupOrigin: "user_intent",
      fence: { identity: {}, generation: 1 },
      current: () => undefined,
      initial: { ...playing, foreground: 1 as never },
      now: () => 1,
    }),
  ).toThrow(RangeError);
});
