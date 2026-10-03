import { expect, test, vi } from "vitest";
import type { PlaybackPlan } from "../packages/protocol";
import { bindPlaybackObservations } from "../apps/web/src/features/playback/observation-binding";
import { bindPlaybackMetricEvents } from "../apps/web/src/features/playback/metrics-binding";

class Media {
  currentTime = 3;
  playbackRate = 1;
  paused = false;
  seeking = false;
  readyState = 4;
  private listeners = new Map<string, Set<EventListener>>();
  registered = 0;
  removed = 0;
  failRegistration = 0;
  failRemoval = "";
  addEventListener(name: string, callback: EventListener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(callback);
    if (++this.registered === this.failRegistration)
      throw new Error("listener registration failed after attachment");
  }
  removeEventListener(name: string, callback: EventListener) {
    ++this.removed;
    if (name === this.failRemoval) throw new Error("listener removal failed");
    this.listeners.get(name)?.delete(callback);
  }
  fire(name: string) {
    for (const callback of [...(this.listeners.get(name) ?? [])])
      callback(new Event(name));
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce(
      (total, set) => total + set.size,
      0,
    );
  }
}
const grant = { media_generation: 1, observation_seq: 0 } as PlaybackPlan;
const state = () => ({
  foreground: true,
  expectedPlaying: true,
  autoplayBlocked: false,
  buffering: false,
});

function observations(
  el: Media,
  options: {
    seq?: number;
    current?: () => boolean;
    finalCurrent?: () => boolean;
    send?: (body: unknown, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  return bindPlaybackObservations({
    element: el as unknown as HTMLVideoElement,
    plan: { ...grant, observation_seq: options.seq ?? 0 },
    current: options.current ?? (() => true),
    finalCurrent: options.finalCurrent ?? (() => true),
    send: options.send ?? (async () => {}),
    storage: { getItem: () => null, setItem: () => {} },
    storageKey: "seq",
  });
}
function metrics(
  el: Media,
  options: { current?: () => boolean; state?: typeof state; meter?: any } = {},
) {
  const meter = options.meter ?? {
    observe: vi.fn(),
    firstFrame: vi.fn(() => false),
  };
  const binding = bindPlaybackMetricEvents({
    element: el as unknown as HTMLVideoElement,
    meter,
    fence: { identity: {}, generation: 1 },
    planGeneration: 9,
    current: options.current ?? (() => true),
    state: options.state ?? state,
  });
  return { meter, binding };
}

test("observation Stop sequence exhaustion still detaches listeners and aborts in-flight work", async () => {
  const el = new Media();
  let signal: AbortSignal | undefined, release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const binding = observations(el, {
    seq: Number.MAX_SAFE_INTEGER - 1,
    send: async (_body, requestSignal) => {
      signal = requestSignal;
      await gate;
    },
  });
  try {
    binding.progress();
    expect(signal?.aborted).toBe(false);
    expect(() => binding.stop()).not.toThrow();
    expect(signal?.aborted).toBe(true);
    expect(el.listenerCount).toBe(0);
    expect(binding.stop()).toBeUndefined();
    expect(() => el.fire("playing")).not.toThrow();
  } finally {
    release();
  }
  await binding.flush();
});

test("observation Stop getter failure still cancels work before discarding the handle", async () => {
  const el = new Media();
  let fail = false,
    signal: AbortSignal | undefined,
    release!: () => void;
  Object.defineProperty(el, "currentTime", {
    get: () => {
      if (fail) throw new Error("media read failed");
      return 3;
    },
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const binding = observations(el, {
    send: async (_body, requestSignal) => {
      signal = requestSignal;
      await gate;
    },
  });
  try {
    binding.progress();
    fail = true;
    expect(() => binding.stop()).not.toThrow();
    expect(signal?.aborted).toBe(true);
    expect(el.listenerCount).toBe(0);
  } finally {
    release();
  }
  await binding.flush();
});

test("observation event capture errors fail closed without escaping media callbacks", () => {
  const el = new Media();
  const binding = observations(el, { seq: Number.MAX_SAFE_INTEGER });
  expect(() => el.fire("playing")).not.toThrow();
  expect(el.listenerCount).toBe(0);
  expect(() => binding.progress()).not.toThrow();
  expect(binding.stop()).toBeUndefined();
});

test("partial observation listener registration is rolled back", () => {
  const el = new Media();
  el.failRegistration = 3;
  try {
    observations(el);
  } catch {
    /* A factory may fail after cleaning up. */
  }
  expect(el.listenerCount).toBe(0);
});

test("initial frame request failure rolls back metric listeners", () => {
  const el = new Media();
  Object.assign(el, {
    requestVideoFrameCallback: () => {
      throw new Error("frame registration failed");
    },
  });
  try {
    metrics(el);
  } catch {
    /* A factory may fail after cleaning up. */
  }
  expect(el.listenerCount).toBe(0);
});

test("a failed frame cancellation still removes listeners and fences late callbacks", () => {
  const el = new Media();
  let frame!: (time: number, metadata: any) => void;
  const cancel = vi.fn(() => {
    throw new Error("frame cancellation failed");
  });
  const request = vi.fn((callback) => {
    frame = callback;
    return 7;
  });
  Object.assign(el, {
    requestVideoFrameCallback: request,
    cancelVideoFrameCallback: cancel,
  });
  const { meter, binding } = metrics(el);
  expect(() => binding.stop()).not.toThrow();
  expect(el.listenerCount).toBe(0);
  expect(() => frame(10, { presentationTime: 10 })).not.toThrow();
  expect(meter.firstFrame).not.toHaveBeenCalled();
  binding.stop();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
});

test("a throwing metric event observer closes its listeners without escaping the event", () => {
  const el = new Media();
  const meter = {
    observe: vi.fn(() => {
      throw new Error("meter observation failed");
    }),
    firstFrame: vi.fn(),
  };
  const { binding } = metrics(el, { meter });
  expect(() => el.fire("playing")).not.toThrow();
  expect(el.listenerCount).toBe(0);
  expect(() => binding.progress()).not.toThrow();
  expect(meter.observe).toHaveBeenCalledTimes(1);
});

test("a throwing frame meter closes metric listeners and never rearms the callback", () => {
  const el = new Media();
  let frame!: (time: number, metadata: any) => void;
  const request = vi.fn((callback) => {
    frame = callback;
    return 7;
  });
  Object.assign(el, {
    requestVideoFrameCallback: request,
    cancelVideoFrameCallback: vi.fn(),
  });
  const meter = {
    observe: vi.fn(),
    firstFrame: vi.fn(() => {
      throw new Error("first frame failed");
    }),
  };
  const { binding } = metrics(el, { meter });
  expect(() => frame(10, { presentationTime: 10 })).not.toThrow();
  expect(el.listenerCount).toBe(0);
  expect(request).toHaveBeenCalledTimes(1);
  expect(() => binding.stop()).not.toThrow();
});

test("partial metric listener registration is rolled back", () => {
  const el = new Media();
  el.failRegistration = 3;
  try {
    metrics(el);
  } catch {
    /* A factory may fail after cleaning up. */
  }
  expect(el.listenerCount).toBe(0);
});

test.each(["observation", "metric"])(
  "%s listener removal failure does not block other cleanup or late callback fencing",
  (kind) => {
    const el = new Media();
    el.failRemoval = "playing";
    const current = vi.fn(() => true);
    const binding =
      kind === "observation"
        ? observations(el, { current })
        : metrics(el, { current }).binding;
    expect(() => binding.stop()).not.toThrow();
    expect(el.removed).toBe(el.registered);
    expect(el.listenerCount).toBe(1);
    const checks = current.mock.calls.length,
      removals = el.removed;
    expect(() => el.fire("playing")).not.toThrow();
    expect(() => binding.progress()).not.toThrow();
    binding.stop();
    expect(current).toHaveBeenCalledTimes(checks);
    expect(el.removed).toBe(removals);
  },
);

test("metric frame registration failure after a normal first-frame retry closes the source", () => {
  const el = new Media();
  let frame!: (time: number, metadata: any) => void;
  const request = vi.fn((callback) => {
    frame = callback;
    return 7;
  });
  Object.assign(el, {
    requestVideoFrameCallback: request,
    cancelVideoFrameCallback: vi.fn(),
  });
  const { meter } = metrics(el);
  request.mockImplementationOnce(() => {
    throw new Error("rearm failed");
  });
  expect(() => frame(10, { presentationTime: 10 })).not.toThrow();
  expect(meter.firstFrame).toHaveBeenCalledTimes(1);
  expect(el.listenerCount).toBe(0);
  expect(request).toHaveBeenCalledTimes(2);
  expect(() => frame(20, { presentationTime: 20 })).not.toThrow();
  expect(meter.firstFrame).toHaveBeenCalledTimes(1);
});

test("metric read failure closes the source but does not fabricate an observation", () => {
  const el = new Media();
  let fail = false;
  const s = metrics(el, {
    state: () => {
      if (fail) throw new Error("state read failed");
      return state();
    },
  });
  fail = true;
  expect(() => s.binding.read()).toThrow("state read failed");
  expect(el.listenerCount).toBe(0);
  expect(() => s.binding.progress()).not.toThrow();
  fail = false;
  expect(s.binding.read()).toMatchObject({
    expectedPlaying: true,
    paused: false,
  });
});

test("observation Stop finalCurrent failure closes the source and reentrant Stop cannot reserve twice", () => {
  const el = new Media();
  const failing = observations(el, {
    finalCurrent: () => {
      throw new Error("final fence failed");
    },
  });
  expect(() => failing.stop()).not.toThrow();
  expect(el.listenerCount).toBe(0);
  let reentrant: ReturnType<typeof observations>;
  const reserve = vi.fn();
  reentrant = bindPlaybackObservations({
    element: el as unknown as HTMLVideoElement,
    plan: grant,
    current: () => true,
    finalCurrent: () => {
      expect(reentrant.stop()).toBeUndefined();
      el.fire("playing");
      return true;
    },
    send: async () => {},
    storage: { getItem: () => null, setItem: reserve },
    storageKey: "seq",
  });
  expect(reentrant.stop()).toMatchObject({ seq: 1, has_played: false });
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(el.listenerCount).toBe(0);
});

test("an observation fence error closes the source, while network rejection keeps its bounded retries", async () => {
  const el = new Media();
  const send = vi.fn(async () => {
    throw new Error("network unavailable");
  });
  const binding = observations(el, { send });
  binding.progress();
  await binding.flush();
  expect(send).toHaveBeenCalledTimes(2);
  expect(el.listenerCount).toBe(8);
  binding.stop();
  let checks = 0;
  const failing = observations(el, {
    current: () => {
      if (++checks === 2) throw new Error("send fence failed");
      return true;
    },
  });
  expect(() => failing.progress()).not.toThrow();
  await failing.flush();
  expect(el.listenerCount).toBe(0);
  expect(failing.stop()).toBeUndefined();
});

test("a healthy metric first-frame miss rearms once and later presentation succeeds", () => {
  const el = new Media();
  let frame!: (time: number, metadata: any) => void;
  const request = vi.fn((callback) => {
    frame = callback;
    return 7;
  });
  Object.assign(el, {
    requestVideoFrameCallback: request,
    cancelVideoFrameCallback: vi.fn(),
  });
  const { meter, binding } = metrics(el);
  frame(10, { presentationTime: 10 });
  expect(request).toHaveBeenCalledTimes(2);
  expect(el.listenerCount).toBe(9);
  meter.firstFrame.mockReturnValueOnce(true);
  frame(20, { presentationTime: 20 });
  expect(request).toHaveBeenCalledTimes(2);
  expect(meter.firstFrame).toHaveBeenCalledTimes(2);
  binding.stop();
  expect(el.listenerCount).toBe(0);
});

test("a throwing optional source-phase capture does not escape media attachment", () => {
  const el = new Media();
  const meter = {
    attachSource: vi.fn(() => {
      throw new Error("source phase unavailable");
    }),
    observe: vi.fn(),
    firstFrame: vi.fn(),
  };
  const { binding } = metrics(el, { meter });
  expect(() => binding.attachSource()).not.toThrow();
  expect(el.listenerCount).toBe(0);
  expect(() => binding.stop()).not.toThrow();
  expect(meter.attachSource).toHaveBeenCalledTimes(1);
});
