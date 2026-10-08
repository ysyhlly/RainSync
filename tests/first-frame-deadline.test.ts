import { afterEach, expect, test, vi } from "vitest";
import { createFirstFrameDeadline } from "../apps/web/src/features/playback/first-frame-deadline";

afterEach(() => vi.useRealTimers());

function setup(rvfc = false) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const state = {
    current: true,
    hidden: false,
    blocked: false,
    preparing: false,
    playing: true,
  };
  const el: any = Object.assign(new EventTarget(), {
    readyState: 4,
    paused: true,
    seeking: false,
    currentTime: 0,
  });
  const frames: ((at: number, metadata: any) => void)[] = [];
  const cancel = vi.fn();
  if (rvfc) {
    el.requestVideoFrameCallback = (cb: (typeof frames)[number]) =>
      frames.push(cb);
    el.cancelVideoFrameCallback = cancel;
  }
  const timeout = vi.fn(),
    presented = vi.fn();
  const deadline = createFirstFrameDeadline({
    element: el,
    current: () => state.current,
    suspended: () =>
      state.hidden || state.blocked || state.preparing || !state.playing,
    eligible: () => !state.hidden && !state.blocked && !state.preparing,
    timeout,
    presented,
  });
  deadline.attachSource();
  return {
    el,
    state,
    frames,
    cancel,
    deadline,
    timeout,
    presented,
    event: (name: string) => el.dispatchEvent(new Event(name)),
    frame: (at = performance.now()) =>
      frames.at(-1)!(performance.now(), { presentationTime: at }),
  };
}

test.each([false, true])(
  "usable data and playing alone never finish the route deadline (RVFC=%s)",
  async (rvfc) => {
    const s = setup(rvfc);
    s.event("loadeddata");
    s.event("canplay");
    s.el.paused = false;
    s.event("playing");
    s.event("timeupdate");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(s.timeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.timeout).toHaveBeenCalledOnce();
    expect(s.presented).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.timeout).toHaveBeenCalledOnce();
  },
);

test("RVFC has explicit compositor evidence; fallback needs actual post-playing advancement", async () => {
  const s = setup(true);
  await vi.advanceTimersByTimeAsync(1000);
  s.frame(950);
  expect(s.presented).toHaveBeenCalledWith({
    presentedAtMs: 950,
    evidence: "video_frame_callback",
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(s.timeout).not.toHaveBeenCalled();

  const fallback = setup();
  fallback.el.currentTime = 10;
  fallback.event("timeupdate");
  fallback.el.paused = false;
  fallback.event("playing");
  fallback.el.seeking = true;
  fallback.el.currentTime = 90;
  fallback.event("seeking");
  fallback.el.seeking = false;
  fallback.event("seeked");
  fallback.event("timeupdate");
  expect(fallback.presented).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  fallback.el.currentTime = 90.1;
  fallback.event("timeupdate");
  expect(fallback.presented).toHaveBeenCalledWith({
    presentedAtMs: 1000,
    evidence: "playing_time_advance",
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fallback.timeout).not.toHaveBeenCalled();
});

test.each(["hidden", "blocked", "preparing", "paused"])(
  "%s suspends remaining time without converting it into presentation",
  async (cause) => {
    const s = setup(true);
    await vi.advanceTimersByTimeAsync(15_000);
    if (cause === "paused") s.state.playing = false;
    else s.state[cause as "hidden" | "blocked" | "preparing"] = true;
    s.deadline.sync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.timeout).not.toHaveBeenCalled();
    if (cause !== "paused") {
      s.frame();
      expect(s.presented).not.toHaveBeenCalled();
    }
    s.state.playing = true;
    s.state.hidden = s.state.blocked = s.state.preparing = false;
    s.deadline.sync();
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.timeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.timeout).toHaveBeenCalledOnce();
  },
);

test("native/MSE source replacement retains budget and fences late old callbacks", async () => {
  const s = setup(true);
  const old = s.frames[0];
  await vi.advanceTimersByTimeAsync(15_000);
  s.deadline.detachSource();
  old(performance.now(), { presentationTime: performance.now() });
  s.deadline.attachSource();
  expect(s.cancel).toHaveBeenCalledWith(1);
  old(performance.now(), { presentationTime: performance.now() });
  s.frame(14_999); // A queued composition before this source was attached.
  s.frame(50_000); // A timestamp from another time origin.
  expect(s.presented).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.timeout).toHaveBeenCalledOnce();
});

test("cancellation is irreversible even if the identity is later reused", async () => {
  const s = setup(true);
  const old = s.frames[0];
  s.state.current = false;
  s.deadline.sync();
  s.state.current = true;
  s.deadline.attachSource();
  old(0, { presentationTime: 0 });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(s.timeout).not.toHaveBeenCalled();
  expect(s.presented).not.toHaveBeenCalled();
});

test("a broken RVFC does not silently fall back to weaker evidence or remove the deadline", async () => {
  const s = setup(true);
  s.deadline.detachSource();
  s.el.requestVideoFrameCallback = () => {
    throw new Error("browser registration failed");
  };
  s.deadline.attachSource();
  s.el.paused = false;
  s.event("playing");
  s.el.currentTime = 1;
  s.event("timeupdate");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(s.timeout).toHaveBeenCalledOnce();
  expect(s.presented).not.toHaveBeenCalled();
});

test("a backwards or nonfinite local clock cannot extend the route budget", async () => {
  for (const value of [-1, NaN, Infinity]) {
    const s = setup();
    await vi.advanceTimersByTimeAsync(5000);
    const clock = vi.spyOn(performance, "now").mockReturnValue(value);
    s.state.blocked = true;
    s.deadline.sync();
    clock.mockRestore();
    s.state.blocked = false;
    s.deadline.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.timeout).toHaveBeenCalledOnce();
  }
});
