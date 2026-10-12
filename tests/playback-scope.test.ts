import { afterEach, expect, it, vi } from "vitest";
import { ref } from "vue";
import {
  createPlaybackScope,
  type PlaybackObservationScope,
} from "../apps/web/src/features/playback/playback-scope";
import { createPlaybackMetricRuntime } from "../apps/web/src/features/playback/playback-metric-runtime";
import { createPlaybackMetrics } from "../apps/web/src/features/playback/playback-metrics";
import type { PlaybackIntent } from "../apps/web/src/features/playback/playback-runtime-types";
import type { PlaybackPlan } from "../packages/protocol";

afterEach(() => vi.useRealTimers());
function pair() {
  return createPlaybackScope(
    { failedCandidates: [] as string[], originRecoveryUsed: false },
    { t0: 0, startGeneration: 7, origin: "user_intent" },
  );
}
function metricFixture() {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  let active = pair();
  const state = {
    foreground: true,
    expectedPlaying: true,
    autoplayBlocked: false,
    buffering: false,
  };
  const video = ref(
    Object.assign(new EventTarget(), {
      readyState: 4,
      paused: false,
      seeking: false,
      currentTime: 0,
      requestVideoFrameCallback: vi.fn(() => 1),
      cancelVideoFrameCallback: vi.fn(),
    }) as unknown as HTMLVideoElement,
  );
  const current = (value: PlaybackObservationScope) =>
    active.observation === value;
  const addMeter = (value: ReturnType<typeof pair>) => {
    value.observation.meter = createPlaybackMetrics({
      t0: value.observation.t0,
      startupOrigin: value.observation.origin,
      fence: value.observation.fence,
      current: () =>
        current(value.observation) ? value.observation.fence : undefined,
      initial: { ...state, paused: false, seeking: false },
    });
    return value;
  };
  addMeter(active);
  const snapshot = vi.fn();
  const runtime = createPlaybackMetricRuntime({
    scope: () => active.observation,
    currentScope: current,
    currentPlan: () => true,
    video,
    state: () => state,
    send: vi.fn(),
    snapshot,
  });
  return {
    runtime,
    video,
    snapshot,
    active: () => active,
    replace: () => {
      runtime.stopSource();
      active = addMeter(pair());
      return active;
    },
    stop: () => {
      runtime.stopMetrics();
      runtime.stopSource();
      runtime.sender.stop();
    },
  };
}

// Compiled, never called: measurement cannot hold business retry authority and
// business intent cannot own observation flags or local callback generations.
function separatedTypes(
  intent: PlaybackIntent,
  scope: PlaybackObservationScope,
) {
  // @ts-expect-error Observation failure does not invalidate a business intent.
  intent.disabled = true;
  // @ts-expect-error Meter state belongs to observation only.
  intent.meter;
  // @ts-expect-error Local callback generations are not business plan generations.
  intent.fence;
  // @ts-expect-error Observation has no decoder/candidate retry authority.
  scope.failedCandidates.push("next");
  // @ts-expect-error Observation has no origin-recovery budget.
  scope.originRecoveryUsed = true;
  // @ts-expect-error Exact login identity stays in business ownership.
  scope.epoch;
  // @ts-expect-error The original measurement t0 cannot be restarted by a source switch.
  scope.t0 = performance.now();
  // @ts-expect-error The logical owner token is immutable.
  scope.owner.kind = "new-owner";
  // @ts-expect-error Initial server plan identity does not become a source counter.
  intent.initialPlanGeneration++;
}
void separatedTypes;

it("creates separate intent and observation with one frozen owner and original timing", () => {
  const value = pair();
  expect(value.intent).not.toBe(value.observation);
  expect(value.intent.owner).toBe(value.observation.owner);
  expect(Object.isFrozen(value.intent.owner)).toBe(true);
  expect(Object.isFrozen(value.observation.fence)).toBe(true);
  expect(value.observation).toMatchObject({
    t0: 0,
    startGeneration: 7,
    origin: "user_intent",
    fence: { generation: 1 },
  });
  expect(value.intent.initialPlanGeneration).toBe(7);
  expect(value.intent).not.toHaveProperty("meter");
  expect(value.intent).not.toHaveProperty("disabled");
  expect(value.observation).not.toHaveProperty("failedCandidates");
});

it("equal identity facts and server generations do not let a new intent reuse an old owner", () => {
  const first = pair(),
    next = pair();
  expect(first.intent.initialPlanGeneration).toBe(
    next.intent.initialPlanGeneration,
  );
  expect(first.intent.owner).not.toBe(next.intent.owner);
  expect(first.observation.fence.identity).not.toBe(
    next.observation.fence.identity,
  );
});

it("observation negotiation/failure cannot consume business fallback or origin-recovery state", () => {
  const value = pair();
  value.intent.failedCandidates.push("first-route");
  value.observation.disabled = true;
  value.observation.metricsVersion = 2;
  expect(value.intent.failedCandidates).toEqual(["first-route"]);
  expect(value.intent.originRecoveryUsed).toBe(false);
  expect(value.intent.initialPlanGeneration).toBe(7);
});

it("source callback fences advance independently without restarting the original sampling cadence", async () => {
  const f = metricFixture(),
    original = f.active();
  try {
    f.runtime.startMetrics();
    await vi.advanceTimersByTimeAsync(4_000);
    f.runtime.advanceObservationSource(original.observation);
    f.runtime.startMetrics();
    expect(original.observation.fence.generation).toBe(2);
    expect(original.intent.initialPlanGeneration).toBe(7);
    expect(original.observation.startGeneration).toBe(7);
    expect(original.observation.t0).toBe(0);
    expect(original.observation.fence.identity).toBe(original.intent.owner);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(f.snapshot.mock.calls[0][0]).toMatchObject({
      seq: 1,
      elapsed_ms: 5_000,
    });
  } finally {
    f.stop();
  }
});

it("a retired source advance cannot stop or rewrite the successor observation", () => {
  const f = metricFixture(),
    old = f.active();
  const plan = { plan_generation: 8 } as PlaybackPlan;
  try {
    f.runtime.bindMetricSource(plan, f.video.value);
    f.runtime.attachMetricSource();
    const next = f.replace();
    f.runtime.bindMetricSource(plan, f.video.value);
    f.runtime.attachMetricSource();
    const fence = next.observation.fence;
    const cancelled = vi.mocked(f.video.value.cancelVideoFrameCallback).mock
      .calls.length;
    f.runtime.advanceObservationSource(old.observation);
    expect(next.observation.fence).toBe(fence);
    expect(old.observation.fence.generation).toBe(1);
    expect(f.video.value.cancelVideoFrameCallback).toHaveBeenCalledTimes(
      cancelled,
    );
    expect(next.intent.originRecoveryUsed).toBe(false);
  } finally {
    f.stop();
  }
});

it("lost optional source observation disables only its own measurement", () => {
  const f = metricFixture();
  try {
    // No source was bound: optional source-edge evidence cannot be fabricated.
    f.runtime.attachMetricSource();
    expect(f.active().observation.disabled).toBe(true);
    expect(f.active().intent.originRecoveryUsed).toBe(false);
    expect(f.active().intent.failedCandidates).toEqual([]);
    expect(f.active().intent.initialPlanGeneration).toBe(7);
  } finally {
    f.stop();
  }
});
