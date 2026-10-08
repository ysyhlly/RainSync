import { effectScope, ref } from "vue";
import { createPlaybackRuntime } from "../../../apps/web/src/features/playback/playback-runtime";
import type { PlaybackRuntimeContext } from "../../../apps/web/src/features/playback/playback-runtime-types";
import type { PlaybackMetricsSnapshot } from "../../../apps/web/src/features/playback/playback-metrics";

export type NativeMetricsEvidence = {
  local?: PlaybackMetricsSnapshot;
  stage: string;
  session: string | null;
  error: string;
  frames: (VideoFrameCallbackMetadata & { now: number })[];
  responseReceipts: unknown[];
  video: {
    readyState: number;
    currentTime: number;
    width: number;
    height: number;
    paused: boolean;
  };
};
export type NativeMetricsFixture = {
  snapshot: () => NativeMetricsEvidence;
  stop: () => void;
};

// Browser-only entry: Vite resolves Vue and the production runtime using the
// configured cache, including RAINSYNC_ARTIFACT_DIR outside the checkout.
export async function startNativeMetricsFixture(ids: {
  room: string;
  media: string;
  user: string;
}): Promise<NativeMetricsFixture> {
  const error = ref("");
  const state = ref({
    room_id: ids.room,
    media_id: ids.media,
    media_generation: 7,
    revision: 1,
    playback_status: "playing",
    anchor_position_ms: 0,
    anchor_server_time_ms: 0,
    playback_rate: 1,
  });
  const responseReceipts: unknown[] = [];
  const session = {
    user: { id: ids.user },
    epoch: 1,
    async api(
      path: string,
      method = "GET",
      body?: unknown,
      signal?: AbortSignal,
    ) {
      const response = await fetch("/api/v1" + path, {
        method,
        signal,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) throw new Error(`Fixture HTTP ${response.status}`);
      const result = await response.json();
      if (path.endsWith("/metrics")) responseReceipts.push(result);
      return result;
    },
  };
  // These HTTP identity and timeline fixtures supply only the runtime's
  // consumed fields; SDK, fetch, video and frame observation stay real.
  const scope = effectScope();
  const runtime = scope.run(() =>
    createPlaybackRuntime({
      session,
      state,
      connected: ref(true),
      active: ref(true),
      clock: { ready: true, revision: 1, now: () => 0 },
      error,
      resolveMedia: async () => ({
        id: ids.media,
        kind: "native_platform",
        title: "Clear local Bilibili route fixture",
        platform: {
          version: 1,
          provider: "bilibili",
          content_id: "BV1xx411c7mD",
          part: 1,
        },
      }),
      run: async (action: () => Promise<void>) => action(),
    } as unknown as PlaybackRuntimeContext),
  )!;
  const element = document.createElement("video");
  element.muted = true;
  element.playsInline = true;
  element.style.width = "320px";
  document.body.append(element);
  const callbacks: NativeMetricsEvidence["frames"] = [],
    requestFrame = element.requestVideoFrameCallback.bind(element);
  // Observe the real browser callback consumed by the production meter.
  // No synthetic media events, metadata, timers or SDK factories are used.
  element.requestVideoFrameCallback = (callback) =>
    requestFrame((now, metadata) => {
      callbacks.push({ now, ...metadata });
      callback(now, metadata);
    });
  runtime.attach(element);
  const fixture: NativeMetricsFixture = {
    snapshot: () => ({
      local: runtime.startupDiagnostics.value,
      stage: runtime.loadingStage.value,
      session: runtime.sessionId.value,
      error: error.value,
      frames: callbacks,
      responseReceipts,
      video: {
        readyState: element.readyState,
        currentTime: element.currentTime,
        width: element.videoWidth,
        height: element.videoHeight,
        paused: element.paused,
      },
    }),
    stop: () => scope.stop(),
  };
  try {
    await runtime.loadMedia();
    await runtime.enablePlayback();
    return fixture;
  } catch (failure) {
    fixture.stop();
    throw failure;
  }
}
