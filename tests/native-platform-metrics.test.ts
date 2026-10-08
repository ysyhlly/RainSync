import { afterEach, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { PlaybackPlan } from "../packages/protocol";
import { nativePlatformRequest } from "../apps/web/src/features/playback/native-platform-intent";
import { createPlaybackMetrics } from "../apps/web/src/features/playback/playback-metrics";
import {
  createPlaybackMetricRuntime,
  type PlaybackObservationScope,
} from "../apps/web/src/features/playback/playback-metric-runtime";

afterEach(() => vi.useRealTimers());
const request = {
  viewer_id: "12345678-1234-1234-1234-123456789abc",
  plan_generation: 2,
  idempotency_key: "request",
  room_id: "room",
  media_generation: 7,
  position_ms: 36_000,
  credential_mode: "anonymous" as const,
  mse_h264_aac: true,
  playback_metrics: Object.freeze({
    meter_start_generation: 1,
    startup_origin: "user_intent" as const,
  }),
};
it.each([false, true])(
  "finite Bilibili compatibility=%s uses existing optional negotiation without changing platform authorization",
  (compatibility) => {
    const body = nativePlatformRequest({ ...request, compatibility });
    expect(body).toMatchObject({
      viewer_id: request.viewer_id,
      plan_generation: 2,
      room_id: "room",
      media_generation: 7,
      playback_metrics_version: 1,
      playback_metrics_supported_versions: [1, 2],
      playback_metrics: {
        meter_start_generation: 1,
        startup_origin: "user_intent",
      },
      native_platform: { version: 1, credential_mode: "anonymous" },
    });
    expect(body.native_platform!.compatibility).toEqual(
      compatibility ? { version: 1, mode: "hls_avc_aac" } : undefined,
    );
    expect(body).not.toHaveProperty("observation_version");
    expect(body.playback_metrics).not.toBe(request.playback_metrics);
  },
);
it.each([
  { live: true },
  { course: true },
  { provider: "youtube" as const },
  { provider: "douyin" as const },
  { playback_metrics: undefined },
])(
  "does not extend metrics negotiation to an unrequested platform/mode: %j",
  (change) => {
    const body = nativePlatformRequest({ ...request, ...change });
    expect(body).not.toHaveProperty("playback_metrics_version");
    expect(body).not.toHaveProperty("playback_metrics_supported_versions");
    expect(body).not.toHaveProperty("playback_metrics");
  },
);
it("a stale publication cannot downgrade or disable the current Bilibili meter before its actual v2 sender", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  const owner = Object.freeze({ kind: "playback-owner" as const }),
    fence = { identity: owner, generation: 1 };
  const attempt: PlaybackObservationScope = {
    t0: 0,
    owner,
    fence,
    startGeneration: 1,
    origin: "user_intent",
    disabled: false,
  };
  const state = {
    foreground: true,
    expectedPlaying: true,
    autoplayBlocked: false,
    buffering: false,
  };
  attempt.meter = createPlaybackMetrics({
    t0: 0,
    startupOrigin: "user_intent",
    fence,
    current: () => attempt.fence,
    initial: { ...state, paused: false, seeking: false },
  });
  let frame!: (now: number, metadata: VideoFrameCallbackMetadata) => void;
  const element = Object.assign(new EventTarget(), {
    readyState: 4,
    paused: false,
    seeking: false,
    currentTime: 36,
    requestVideoFrameCallback: vi.fn((callback: typeof frame) => {
      frame = callback;
      return 1;
    }),
    cancelVideoFrameCallback: vi.fn(),
  }) as unknown as HTMLVideoElement;
  const current = {
    session_id: "current-native-session",
    plan_generation: 2,
    media_generation: 7,
    playback_metrics_version: 2,
    playback_metrics: {
      meter_start_generation: 1,
      startup_origin: "user_intent",
      metrics_seq: 0,
      closed: false,
    },
  } as PlaybackPlan;
  const stale = {
    ...current,
    session_id: "old-native-session",
    plan_generation: 1,
    playback_metrics_version: 1,
    playback_metrics: { ...current.playback_metrics!, closed: true },
  } as PlaybackPlan;
  const send = vi.fn(async (binding, body) => ({
    session_id: binding.sessionId,
    meter_start_generation: body.meter_start_generation,
    metrics_seq: body.seq,
    closed: body.final,
  }));
  const runtime = createPlaybackMetricRuntime({
    scope: () => attempt,
    currentScope: (value) => value === attempt,
    currentPlan: (value) => value === current,
    video: ref(element),
    state: () => state,
    send,
  });
  try {
    runtime.bindMetricSource(stale, element);
    expect(element.requestVideoFrameCallback).not.toHaveBeenCalled();
    runtime.bindMetricGrant(current);
    runtime.bindMetricGrant(stale);
    expect(attempt.disabled).toBe(false);
    expect(attempt.metricsVersion).toBe(2);
    runtime.bindMetricSource(current, element);
    runtime.attachMetricSource();
    expect(attempt.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    frame(performance.now(), {
      presentationTime: 950,
    } as VideoFrameCallbackMetadata);
    await vi.advanceTimersByTimeAsync(4000);
    runtime.sampleMetrics();
    await Promise.resolve();
    expect(attempt.last).toMatchObject({
      first_frame: { evidence: "video_frame_callback" },
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].sessionId).toBe("current-native-session");
    expect(send.mock.calls[0][1]).toMatchObject({
      version: 2,
      plan_generation: 2,
      media_generation: 7,
      meter_start_generation: 1,
      first_frame_plan_generation: 2,
      startup_phases: { preparation_ms: 0, loading_ms: 1000, unobserved_ms: 0 },
      first_frame: {
        elapsed_ms: 950,
        confirmed_elapsed_ms: 1000,
        evidence: "video_frame_callback",
      },
    });
  } finally {
    runtime.stopSource();
    runtime.sender.stop();
  }
});
