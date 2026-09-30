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
  current: () => boolean;
  state: () => Omit<
    PlaybackMetricsObservation,
    "paused" | "seeking" | "buffering"
  > & { buffering: boolean };
  now?: () => number;
}) {
  const { element: el, meter, fence } = ctx;
  const now = ctx.now ?? (() => performance.now());
  let active = true;
  let waiting = false;
  let played = false;
  let first = false;
  let lastTime = el.currentTime;
  let frameId: number | undefined;
  const current = () => active && ctx.current();
  const read = (): PlaybackMetricsObservation => {
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
          { presentedAtMs: now(), evidence: "playing_time_advance" },
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
  for (const [event, listener] of listeners)
    el.addEventListener(event, listener);
  function frame(_at: number, metadata: VideoFrameCallbackMetadata) {
    frameId = undefined;
    if (!current()) return;
    if (
      meter.firstFrame(
        fence,
        {
          presentedAtMs: metadata.presentationTime,
          evidence: "video_frame_callback",
        },
        read(),
      )
    ) {
      first = true;
    } else if (current()) frameId = el.requestVideoFrameCallback(frame);
  }
  if (typeof el.requestVideoFrameCallback === "function")
    frameId = el.requestVideoFrameCallback(frame);
  return {
    read,
    progress,
    stop() {
      active = false;
      if (frameId !== undefined) el.cancelVideoFrameCallback(frameId);
      frameId = undefined;
      for (const [event, listener] of listeners)
        el.removeEventListener(event, listener);
    },
  };
}
