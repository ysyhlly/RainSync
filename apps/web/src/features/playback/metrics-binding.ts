import {
  type PlaybackMetrics,
  type PlaybackMetricsFence,
  type PlaybackMetricsObservation,
} from "./playback-metrics";

/** One source attachment. These client observations do not alter observations v1. */
export function bindPlaybackMetricEvents(ctx: {
  element: HTMLVideoElement;
  meter: PlaybackMetrics;
  fence: PlaybackMetricsFence;
  planGeneration: number;
  current: () => boolean;
  state: () => Omit<
    PlaybackMetricsObservation,
    "paused" | "seeking" | "buffering"
  > & { buffering: boolean };
  now?: () => number;
}) {
  const { element: el, meter, fence, planGeneration } = ctx;
  const now = ctx.now ?? (() => performance.now());
  let active = true;
  const attached: [string, EventListener][] = [];
  let waiting = false;
  let played = false;
  let first = false;
  let lastTime = el.currentTime;
  let frameId: number | undefined;
  const current = () => active && ctx.current();
  function close() {
    if (!active) return;
    active = false;
    const pendingFrame = frameId;
    frameId = undefined;
    try {
      if (pendingFrame !== undefined) el.cancelVideoFrameCallback(pendingFrame);
    } catch {
      // The late callback remains inert even if the browser cannot cancel it.
    }
    for (const [event, listener] of attached.splice(0)) {
      try {
        el.removeEventListener(event, listener);
      } catch {
        // Continue removing the other listeners; active fences any remainder.
      }
    }
  }
  function guard(action: () => void) {
    if (!active) return;
    try {
      action();
    } catch {
      close();
    }
  }
  const read = (): PlaybackMetricsObservation => {
    try {
      return readObservation();
    } catch (failure) {
      close();
      // Preserve the API's real observation contract. Runtime read callers
      // already isolate errors; do not invent substitute metrics evidence.
      throw failure;
    }
  };
  const readObservation = (): PlaybackMetricsObservation => {
    const state = ctx.state();
    return {
      ...state,
      paused: el.paused,
      seeking: el.seeking,
      buffering: state.buffering || waiting || el.readyState < 2,
    };
  };
  function observe() {
    if (current()) meter.observe(fence, read());
  }
  function progress() {
    if (!current()) return;
    const time = el.currentTime;
    const advances =
      Number.isFinite(time) && Number.isFinite(lastTime) && time > lastTime;
    lastTime = time;
    if (advances && played && !el.paused && !el.seeking && el.readyState >= 2) {
      waiting = false;
      if (!first && typeof el.requestVideoFrameCallback !== "function") {
        first = meter.firstFrame(
          fence,
          {
            presentedAtMs: now(),
            evidence: "playing_time_advance",
            planGeneration,
          },
          read(),
        );
      }
    }
    observe();
  }
  const listeners: [string, EventListener][] = [
    [
      "playing",
      () => {
        if (!current() || el.paused || el.seeking || el.readyState < 2) return;
        played = true;
        waiting = false;
        // Establish a post-playing baseline so an initial seek/attachment jump
        // cannot masquerade as actual playback advancement.
        lastTime = el.currentTime;
        observe();
      },
    ],
    [
      "waiting",
      () => {
        if (current()) {
          waiting = true;
          observe();
        }
      },
    ],
    // A stalled fetch can coexist with continuously advancing decoded media.
    ["stalled", observe],
    ["pause", observe],
    [
      "seeking",
      () => {
        lastTime = el.currentTime;
        observe();
      },
    ],
    [
      "seeked",
      () => {
        lastTime = el.currentTime;
        observe();
      },
    ],
    ["timeupdate", progress],
    ["canplay", observe],
    ["ratechange", observe],
  ];
  function frame(_at: number, metadata: VideoFrameCallbackMetadata) {
    guard(() => observeFrame(metadata));
  }
  function observeFrame(metadata: VideoFrameCallbackMetadata) {
    frameId = undefined;
    if (!current()) return;
    if (
      meter.firstFrame(
        fence,
        {
          presentedAtMs: metadata.presentationTime,
          evidence: "video_frame_callback",
          planGeneration,
        },
        read(),
      )
    ) {
      first = true;
    } else if (current()) frameId = el.requestVideoFrameCallback(frame);
  }
  try {
    for (const [event, listener] of listeners) {
      if (!active) break;
      const guarded: EventListener = (value) => guard(() => listener(value));
      attached.push([event, guarded]);
      el.addEventListener(event, guarded);
    }
    if (active && typeof el.requestVideoFrameCallback === "function")
      frameId = el.requestVideoFrameCallback(frame);
  } catch {
    close();
  }
  return {
    attachSource: () => {
      let attached = false;
      guard(() => {
        if (current()) attached = meter.attachSource(fence, read());
      });
      return attached;
    },
    read,
    progress: () => guard(progress),
    stop: close,
  };
}
