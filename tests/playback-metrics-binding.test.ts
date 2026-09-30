import { expect, test } from "vitest";
import {
  createPlaybackMetrics,
  type PlaybackMetricsFence,
} from "../apps/web/src/features/playback/playback-metrics";
import { bindPlaybackMetricEvents } from "../apps/web/src/features/playback/metrics-binding";

function setup(rvfc = false) {
  let now = 0;
  let live = true;
  let fence: PlaybackMetricsFence = { identity: {}, generation: 1 };
  const el: any = Object.assign(new EventTarget(), {
    paused: false,
    seeking: false,
    readyState: 4,
    currentTime: 0,
  });
  let callback: ((at: number, metadata: any) => void) | undefined;
  const cancelled: number[] = [];
  if (rvfc) {
    el.requestVideoFrameCallback = (cb: typeof callback) => {
      callback = cb;
      return 1;
    };
    el.cancelVideoFrameCallback = (id: number) => cancelled.push(id);
  }
  const state = {
    foreground: true,
    expectedPlaying: true,
    autoplayBlocked: false,
    buffering: false,
  };
  const meter = createPlaybackMetrics({
    t0: 0,
    startupOrigin: "user_intent",
    fence,
    current: () => (live ? fence : undefined),
    initial: { ...state, paused: false, seeking: false },
    now: () => now,
  });
  const bind = () => {
    const saved = fence;
    return bindPlaybackMetricEvents({
      element: el,
      meter,
      fence: saved,
      current: () => live && saved === fence,
      state: () => state,
      now: () => now,
    });
  };
  const binding = bind();
  return {
    el,
    meter,
    binding,
    state,
    cancelled,
    frame: () => callback!,
    at: (value: number) => (now = value),
    event: (name: string) => el.dispatchEvent(new Event(name)),
    snapshot: () => meter.dispose(fence, binding.read())!,
    replace: () => {
      binding.stop();
      fence = { identity: fence.identity, generation: fence.generation + 1 };
      meter.beginAttempt(fence, binding.read());
      return bind();
    },
    stale: () => (live = false),
  };
}

test("loadeddata/canplay/playing alone cannot fabricate first frame; seek jumps do not qualify", () => {
  const s = setup();
  s.at(1000);
  s.event("loadeddata");
  s.event("canplay");
  s.event("playing");
  s.el.seeking = true;
  s.el.currentTime = 90;
  s.event("seeking");
  s.el.seeking = false;
  s.event("seeked");
  s.event("timeupdate");
  s.at(2000);
  s.el.currentTime = 90.1;
  s.event("timeupdate");
  s.at(5000);
  const snapshot = s.snapshot();
  expect(snapshot.first_frame).toEqual({
    elapsed_ms: 2000,
    confirmed_elapsed_ms: 2000,
    evidence: "playing_time_advance",
  });
  expect(snapshot.totals.startup_ms).toBe(2000);
  s.binding.stop();
});

test("RVFC uses presentation timestamp and rejects callbacks from a disposed old source", () => {
  const s = setup(true);
  const oldFrame = s.frame();
  s.at(1000);
  const next = s.replace();
  oldFrame(1000, { presentationTime: 1000 });
  s.at(2000);
  s.frame()(2000, { presentationTime: 1900 });
  s.at(5000);
  expect(s.snapshot().first_frame).toEqual({
    elapsed_ms: 1900,
    confirmed_elapsed_ms: 2000,
    evidence: "video_frame_callback",
  });
  expect(s.cancelled).toEqual([1]);
  next.stop();
});

test("stalled network fetch stays playing; waiting and seek intervals do not overlap", () => {
  const s = setup(true);
  s.frame()(0, { presentationTime: 0 });
  s.at(1000);
  s.event("stalled");
  s.at(2000);
  s.event("waiting");
  s.at(3000);
  s.el.seeking = true;
  s.event("seeking");
  s.at(4000);
  s.el.seeking = false;
  s.event("seeked");
  s.event("playing");
  s.at(5000);
  expect(s.snapshot().totals).toMatchObject({
    playing_ms: 3000,
    rebuffer_ms: 1000,
    seeking_ms: 1000,
  });
  s.binding.stop();
});

test("stale identity events and frame callbacks cannot change coverage", () => {
  const s = setup(true);
  s.stale();
  s.at(1000);
  s.event("playing");
  s.frame()(1000, { presentationTime: 1000 });
  s.binding.stop();
  expect(
    s.meter.sample({ identity: {}, generation: 1 }, s.binding.read()),
  ).toBeUndefined();
});
