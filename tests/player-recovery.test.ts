import { afterEach, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";
import { createPlaybackRuntime } from "../apps/web/src/features/playback/playback-runtime";

const faults = vi.hoisted(() => ({ observe: false, dispose: false }));
const hls = vi.hoisted(() => ({
  supported: false,
  start: vi.fn(),
  load: vi.fn(),
}));
vi.mock("hls.js", () => ({
  default: class {
    static Events = { ERROR: "error" };
    static isSupported = () => hls.supported;
    static getMediaSource = () =>
      hls.supported ? { isTypeSupported: () => true } : undefined;
    config = {};
    loadSource(url: string) {
      hls.load(url);
    }
    startLoad(position: number) {
      hls.start(position);
    }
    stopLoad() {}
    attachMedia() {}
    on() {}
    destroy() {}
  },
}));
vi.mock(
  "../apps/web/src/features/playback/playback-metrics",
  async (original) => {
    const actual = await original<any>();
    return {
      ...actual,
      createPlaybackMetrics: (...args: any[]) => {
        const meter = actual.createPlaybackMetrics(...args);
        const observe = meter.observe,
          dispose = meter.dispose;
        meter.observe = (...input: any[]) => {
          if (faults.observe) throw new Error("telemetry observe");
          return observe(...input);
        };
        meter.dispose = (...input: any[]) => {
          if (faults.dispose) throw new Error("telemetry dispose");
          return dispose(...input);
        };
        return meter;
      },
    };
  },
);
afterEach(() => {
  faults.observe = faults.dispose = false;
  hls.supported = false;
  hls.start.mockClear();
  hls.load.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function intervals(values: [number, number][]) {
  return {
    length: values.length,
    start: (i: number) => values[i][0],
    end: (i: number) => values[i][1],
  };
}
function setup(
  options: {
    rate?: number;
    acceptRate?: (requested: number, actual: number) => number;
    ranges?: [number, number][];
    rebuild?: boolean;
    observationSeq?: number;
    clearsError?: boolean;
    hls?: boolean;
  } = {},
) {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("location", { href: "http://localhost/rooms/room" });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  vi.stubGlobal("document", document);
  const state = ref({
    room_id: "room",
    media_id: "media",
    media_generation: 1,
    revision: 1,
    playback_status: "paused",
    playback_rate: options.rate ?? 1,
    anchor_position_ms: 10000,
    anchor_server_time_ms: 0,
    duration_ms: 120000,
  });
  const api = vi.fn(
    async (path: string, method?: string, body?: any): Promise<any> => {
      if (path === "/playback-candidates") return {};
      if (path === "/playback-sessions" && method === "POST")
        return {
          session_id: `session-${body.plan_generation}`,
          plan_generation: body.plan_generation,
          media_id: "media",
          media_generation: 1,
          transport: options.hls ? "hls" : "progressive",
          delivery_mode: "direct",
          playback_url: "/authorized.mp4",
          timeline_origin_ms: 0,
          duration_ms: 120000,
          rebuild_on_seek: options.rebuild ?? false,
          audio_tracks: [],
          subtitle_tracks: [],
          ...(options.observationSeq !== undefined
            ? {
                observation_version: 1,
                observation_seq: options.observationSeq,
              }
            : {}),
        };
      if (method === "GET" && path.startsWith("/playback-sessions/"))
        return {
          session_id: path.split("/")[2].split("?")[0],
          plan_generation: Number(
            new URL(path, "http://localhost").searchParams.get(
              "plan_generation",
            ),
          ),
          status: "ready",
          complete: true,
          available_until_ms: 120000,
        };
      return {};
    },
  );
  const session = { user: { id: "user" }, epoch: 1, api };
  const connected = ref(true),
    error = ref("");
  const clock = { ready: true, revision: 0, time: 0, now: () => clock.time };
  const checkClock = vi.fn();
  const scope = effectScope();
  const runtime = scope.run(() =>
    createPlaybackRuntime({
      session: session as any,
      state: state as any,
      connected,
      clock: clock as any,
      checkClock,
      error,
      run: async (action) => {
        if (options.clearsError) error.value = "";
        await action();
      },
    }),
  )!;
  const ranges = intervals(options.ranges ?? [[0, 120]]);
  const el: any = Object.assign(new EventTarget(), {
    src: "",
    readyState: 4,
    paused: true,
    seeking: false,
    ended: false,
    duration: 120,
    seekable: ranges,
    buffered: ranges,
    currentTime: 10,
    canPlayType: () => "probably",
    querySelectorAll: () => [],
    load: vi.fn(),
    getAttribute: (name: string) => (name === "src" ? el.src : null),
    removeAttribute: (name: string) => {
      if (name === "src") el.src = "";
    },
    pause: vi.fn(() => {
      el.paused = true;
    }),
    play: vi.fn(async () => {
      el.paused = false;
    }),
  });
  let actualRate = 1,
    position = 10;
  const writes = vi.fn((rate: number) => {
    actualRate = options.acceptRate?.(rate, actualRate) ?? rate;
  });
  const seeks = vi.fn((next: number) => {
    position = next;
  });
  Object.defineProperty(el, "playbackRate", {
    get: () => actualRate,
    set: writes,
  });
  Object.defineProperty(el, "currentTime", { get: () => position, set: seeks });
  runtime.attach(el);
  return {
    runtime,
    el,
    clock,
    state,
    connected,
    error,
    document,
    api,
    writes,
    seeks,
    checkClock,
    prepare: async () => {
      await runtime.loadMedia();
      runtime.waiting.value = false;
    },
    playing: () => {
      state.value.playback_status = "playing";
      el.paused = false;
    },
    invalidate: () => {
      clock.ready = false;
      ++clock.revision;
      runtime.onClockInvalidated();
    },
    cleanup: () => scope.stop(),
  };
}

it("keeps a supported non-unit room rate and verifies fine behavior over later ticks", async () => {
  const s = setup({ rate: 1.5 });
  try {
    await s.prepare();
    s.playing();
    s.state.value.anchor_position_ms = 10500;
    await vi.advanceTimersByTimeAsync(1500);
    expect(s.el.playbackRate).toBeCloseTo(1.575);
    s.state.value.playback_status = "paused";
    await s.runtime.applyState();
    expect(s.el.playbackRate).toBe(1.5);
    expect(s.state.value.playback_rate).toBe(1.5);
  } finally {
    s.cleanup();
  }
});

it.each(["throws", "ignored", "clamped"])(
  "uses finite seek fallback after a %s fine rate",
  async (behavior) => {
    const s = setup({
      acceptRate: (rate, actual) => {
        if (rate === 1) return 1;
        if (behavior === "throws") throw new Error("unsupported");
        return behavior === "ignored" ? actual : 1.02;
      },
    });
    try {
      await s.prepare();
      s.playing();
      s.state.value.anchor_position_ms = 11000;
      await vi.advanceTimersByTimeAsync(500);
      expect(s.el.playbackRate).toBe(1);
      const attempts = s.writes.mock.calls.length;
      await vi.advanceTimersByTimeAsync(15000);
      expect(s.writes).toHaveBeenCalledTimes(attempts);
      expect(s.seeks.mock.calls.map(([position]) => position)).toEqual([11]);
      s.state.value.anchor_position_ms = 15000;
      await vi.advanceTimersByTimeAsync(500);
      expect(s.seeks).toHaveBeenCalledTimes(1);
      await s.runtime.applyState(true, true);
      expect(s.el.currentTime).toBe(15); // Explicit seek bypasses correction cooldown.
    } finally {
      s.cleanup();
    }
  },
);

it("widens only fine-rate fallback tolerance while normal rate is usable", async () => {
  const s = setup({ acceptRate: (rate, actual) => (rate === 1 ? 1 : actual) });
  try {
    await s.prepare();
    s.playing();
    s.state.value.anchor_position_ms = 10400;
    await vi.advanceTimersByTimeAsync(20000);
    expect(s.writes).toHaveBeenCalledTimes(1);
    expect(s.seeks).not.toHaveBeenCalled();
    expect(s.error.value).not.toContain("不支持此速率");
  } finally {
    s.cleanup();
  }
});

it.each(["throws", "ignored", "clamped"])(
  "halts convergence when the room base is %s",
  async (behavior) => {
    const s = setup({
      rate: 1.5,
      acceptRate: (rate, actual) => {
        if (rate === 1) return 1;
        if (behavior === "throws") throw new Error("unsupported");
        return behavior === "ignored" ? actual : 1.25;
      },
    });
    try {
      await s.prepare();
      s.playing();
      s.state.value.anchor_position_ms = 30000;
      await vi.advanceTimersByTimeAsync(20000);
      expect(s.writes).toHaveBeenCalledTimes(1);
      expect(s.seeks).not.toHaveBeenCalled();
      expect(s.error.value).toContain("不支持此速率");
      expect(s.runtime.recoveryState.value).toBe("unsupported_rate");
      expect(s.runtime.recoveryLabel.value).toBe("本地播放器不支持此速率");
      s.invalidate();
      s.clock.ready = true;
      s.runtime.onClockReady();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.writes).toHaveBeenCalledTimes(1);
      expect(s.runtime.recoveryState.value).toBe("unsupported_rate");
      s.state.value.playback_rate = 1;
      await vi.advanceTimersByTimeAsync(500);
      expect(s.el.currentTime).toBe(30);
      expect(s.error.value).toBe("");
    } finally {
      s.cleanup();
    }
  },
);

it("never seeks into an interval hole or substitutes finite duration for ranges", async () => {
  const s = setup({
    ranges: [
      [0, 10],
      [20, 30],
    ],
  });
  try {
    await s.prepare();
    s.state.value.anchor_position_ms = 15000;
    await s.runtime.applyState(true, true);
    expect(s.seeks).not.toHaveBeenCalled();
    expect(s.error.value).toContain("尚不可定位");
    s.playing();
    await vi.advanceTimersByTimeAsync(20000);
    expect(s.seeks).not.toHaveBeenCalled();
    s.state.value.anchor_position_ms = 25000;
    await s.runtime.applyState(true, true);
    expect(s.el.currentTime).toBe(25);
    s.el.seekable = s.el.buffered = intervals([]);
    s.state.value.anchor_position_ms = 60000;
    await s.runtime.applyState(true, true);
    expect(s.el.currentTime).toBe(25);
  } finally {
    s.cleanup();
  }
});

it("generated holes use a new generation for explicit seeks", async () => {
  const s = setup({
    rebuild: true,
    ranges: [
      [0, 10],
      [20, 30],
    ],
  });
  try {
    await s.prepare();
    s.state.value.anchor_position_ms = 15000;
    await s.runtime.applyState(true, true);
    const posts = s.api.mock.calls.filter(
      ([path, method]) => path === "/playback-sessions" && method === "POST",
    );
    expect(posts.map((call) => call[2].plan_generation)).toEqual([1, 2]);
    expect(s.seeks).not.toHaveBeenCalled();
  } finally {
    s.cleanup();
  }
});

it("initial empty ranges permit play, then apply the pending metadata seek when ranges appear", async () => {
  const s = setup({ ranges: [] });
  try {
    await s.prepare();
    s.state.value.playback_status = "playing";
    s.state.value.anchor_position_ms = 20000;
    await s.runtime.applyState(true);
    expect(s.el.play).toHaveBeenCalledTimes(1);
    expect(s.seeks).not.toHaveBeenCalled();
    s.el.seekable = s.el.buffered = intervals([[0, 40]]);
    await vi.advanceTimersByTimeAsync(500);
    expect(s.el.currentTime).toBe(20);
    expect(s.error.value).toBe("");
  } finally {
    s.cleanup();
  }
});

it.each([false, true])(
  "%s MSE recovery rejects finite-duration internal holes",
  async (mse) => {
    hls.supported = mse;
    const s = setup({
      hls: true,
      ranges: [
        [0, 10],
        [20, 30],
      ],
    });
    try {
      await s.prepare();
      s.playing();
      s.state.value.anchor_position_ms = 15000;
      s.el.error = { code: mse ? 3 : 2 };
      s.el.onerror();
      const loads = s.el.load.mock.calls.length,
        hlsLoads = hls.load.mock.calls.length;
      await s.runtime.applyState(true);
      expect(s.seeks).not.toHaveBeenCalled();
      expect(s.error.value).toContain("尚不可定位");
      expect(s.runtime.waiting.value).toBe(false);
      await vi.advanceTimersByTimeAsync(1500);
      expect(s.el.load).toHaveBeenCalledTimes(loads);
      expect(hls.load).toHaveBeenCalledTimes(hlsLoads);
    } finally {
      s.cleanup();
    }
  },
);

it("generated prefix recovery cannot use finite duration to cross unavailable media", async () => {
  const s = setup({ rebuild: true, ranges: [[0, 10]] });
  try {
    await s.prepare();
    s.state.value.anchor_position_ms = 15000;
    await s.runtime.applyState(true);
    const plays = s.el.play.mock.calls.length;
    await s.runtime.applyState(true);
    expect(s.seeks).not.toHaveBeenCalled();
    expect(s.el.play).toHaveBeenCalledTimes(plays);
    s.el.seekable = s.el.buffered = intervals([[0, 20]]);
    await s.runtime.applyState(true);
    expect(s.el.currentTime).toBe(15);
  } finally {
    s.cleanup();
  }
});

it("generation readiness from an invalidated clock cannot replace or restart the source", async () => {
  const s = setup({ rebuild: true, ranges: [[0, 10]] });
  try {
    await s.prepare();
    s.state.value.anchor_position_ms = 30000;
    let complete!: (value: unknown) => void;
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation((path, method, body) =>
      method === "GET"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : original(path, method, body),
    );
    const recovering = s.runtime.applyState(true);
    s.invalidate();
    const loads = s.el.load.mock.calls.length,
      source = s.el.src;
    complete({
      session_id: "session-1",
      plan_generation: 1,
      status: "ready",
      complete: true,
      available_until_ms: 120000,
    });
    await expect(recovering).rejects.toThrow("播放准备已取消");
    expect(s.el.load).toHaveBeenCalledTimes(loads);
    expect(s.el.src).toBe(source);
    expect(s.seeks).not.toHaveBeenCalled();
  } finally {
    s.cleanup();
  }
});

it("clock invalidation restores base without pause/reload, defers explicit seek and resumes fresh", async () => {
  const s = setup();
  try {
    await s.prepare();
    s.playing();
    s.state.value.anchor_position_ms = 10500;
    await vi.advanceTimersByTimeAsync(500);
    expect(s.el.playbackRate).toBeGreaterThan(1);
    const pauses = s.el.pause.mock.calls.length,
      loads = s.el.load.mock.calls.length;
    s.invalidate();
    expect(s.el.playbackRate).toBe(1);
    expect(s.el.pause).toHaveBeenCalledTimes(pauses);
    expect(s.el.load).toHaveBeenCalledTimes(loads);
    s.state.value.anchor_position_ms = 20000;
    await s.runtime.applyState(true, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.el.currentTime).toBe(10);
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.el.currentTime).toBe(20);
    expect(s.runtime.sessionId.value).toBe("session-1");
    s.seeks.mockClear();
    s.runtime.onClockReady();
    expect(s.seeks).not.toHaveBeenCalled();
  } finally {
    s.cleanup();
  }
});

it("does not fine-correct while hidden or disconnected and checks suspend before acting", async () => {
  const s = setup();
  try {
    await s.prepare();
    s.playing();
    s.state.value.anchor_position_ms = 10500;
    s.document.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(500);
    s.document.visibilityState = "visible";
    s.connected.value = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(s.writes).not.toHaveBeenCalled();
    s.connected.value = true;
    s.checkClock.mockImplementationOnce(() => s.invalidate());
    await vi.advanceTimersByTimeAsync(500);
    expect(s.seeks).not.toHaveBeenCalled();
    expect(s.writes).not.toHaveBeenCalled();
  } finally {
    s.cleanup();
  }
});

it("a slow play is not retried every tick and cannot overtake a later PAUSE", async () => {
  const s = setup();
  try {
    await s.prepare();
    s.state.value.playback_status = "playing";
    let resolve!: () => void;
    s.el.play.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = () => {
            s.el.paused = false;
            done();
          };
        }),
    );
    const playing = s.runtime.applyState();
    await vi.advanceTimersByTimeAsync(1500);
    expect(s.el.play).toHaveBeenCalledTimes(1);
    s.state.value.playback_status = "paused";
    await s.runtime.applyState();
    resolve();
    await playing;
    expect(s.el.paused).toBe(true);
    expect(s.runtime.blocked.value).toBe(false);
  } finally {
    s.cleanup();
  }
});

it("an autoplay rejection waits for the explicit gesture instead of periodic play retries", async () => {
  const s = setup();
  try {
    await s.prepare();
    s.state.value.playback_status = "playing";
    s.el.play.mockRejectedValue(new Error("gesture required"));
    await s.runtime.applyState();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.el.play).toHaveBeenCalledTimes(1);
    expect(s.runtime.blocked.value).toBe(true);
    s.el.play.mockImplementation(async () => {
      s.el.paused = false;
    });
    await s.runtime.enablePlayback();
    expect(s.runtime.blocked.value).toBe(false);
  } finally {
    s.cleanup();
  }
});

it("late play settlements from an old clock revision cannot publish blocked state", async () => {
  const s = setup();
  try {
    await s.prepare();
    s.state.value.playback_status = "playing";
    let reject!: (reason: Error) => void;
    s.el.play.mockImplementation(
      () =>
        new Promise<void>((_done, fail) => {
          reject = fail;
        }),
    );
    const playing = s.runtime.applyState();
    s.invalidate();
    reject(new Error("old autoplay result"));
    await playing;
    expect(s.runtime.blocked.value).toBe(false);
    expect(s.runtime.sessionId.value).toBe("session-1");
  } finally {
    s.cleanup();
  }
});

it("telemetry failures cannot block apply, Stop session deletion or key cancellation", async () => {
  const s = setup({ observationSeq: Number.MAX_SAFE_INTEGER });
  try {
    await s.prepare();
    faults.observe = faults.dispose = true;
    s.state.value.anchor_position_ms = 20000;
    await expect(s.runtime.applyState(true, true)).resolves.toBeUndefined();
    expect(s.el.currentTime).toBe(20);
    await expect(s.runtime.reset()).resolves.toBeUndefined();
    expect(s.el.src).toBe("");
    expect(
      s.api.mock.calls.some(
        ([path, method]) =>
          path === "/playback-sessions/session-1" && method === "DELETE",
      ),
    ).toBe(true);
    expect(
      s.api.mock.calls.some(
        ([path, method]) =>
          path.startsWith("/playback-requests/") && method === "DELETE",
      ),
    ).toBe(true);
  } finally {
    s.cleanup();
  }
});

it("rate rejection and renewed support preserve unrelated visible errors", async () => {
  const s = setup({
    rate: 1.5,
    clearsError: true,
    acceptRate: (rate, actual) => (rate === 1 ? 1 : actual),
  });
  try {
    await s.prepare();
    s.playing();
    s.error.value = "登录已失效，请重新登录";
    s.el.onloadedmetadata();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.error.value).toBe("登录已失效，请重新登录");
    expect(s.runtime.recoveryState.value).toBe("unsupported_rate");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.error.value).toBe("登录已失效，请重新登录");
    const writes = s.writes.mock.calls.length;
    s.invalidate();
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.error.value).toBe("登录已失效，请重新登录");
    expect(s.writes).toHaveBeenCalledTimes(writes);
    s.state.value.playback_rate = 1;
    await vi.advanceTimersByTimeAsync(500);
    expect(s.error.value).toBe("登录已失效，请重新登录");
    s.error.value = "媒体加载失败";
    await s.runtime.applyState();
    expect(s.error.value).toBe("媒体加载失败");
    s.state.value.playback_rate = 1.5;
    await vi.advanceTimersByTimeAsync(500);
    expect(s.error.value).toBe("媒体加载失败");
    s.error.value = "";
    await vi.advanceTimersByTimeAsync(500);
    expect(s.error.value).toContain("不支持此速率");
    expect(s.runtime.recoveryState.value).toBe("unsupported_rate");
    s.state.value.playback_rate = 1;
    await vi.advanceTimersByTimeAsync(500);
    expect(s.error.value).toBe("");
  } finally {
    s.cleanup();
  }
});

it("fresh calibration starts catch-up and actual convergence ends it without ordinary drift announcements", async () => {
  const s = setup();
  try {
    await s.prepare();
    await s.runtime.applyState();
    s.playing();
    expect(s.runtime.recoveryState.value).toBe("idle");
    s.state.value.anchor_position_ms = 10500;
    await vi.advanceTimersByTimeAsync(500);
    expect(s.runtime.recoveryState.value).toBe("idle");
    s.invalidate();
    expect(s.runtime.recoveryState.value).toBe("calibrating");
    s.runtime.onClockReady(); // No fresh evidence yet.
    expect(s.runtime.recoveryState.value).toBe("calibrating");
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runtime.recoveryState.value).toBe("catching_up");
    expect(s.runtime.recoveryLabel.value).toContain("追赶");
    expect(s.seeks).not.toHaveBeenCalled();
    s.el.currentTime = 10.5;
    await vi.advanceTimersByTimeAsync(500);
    expect(s.runtime.recoveryState.value).toBe("idle");
    const writes = s.writes.mock.calls.length,
      checks = s.checkClock.mock.calls.length;
    expect(s.runtime.recoveryLabel.value).toBe("");
    expect(s.runtime.recoveryState.value).toBe("idle");
    expect(s.writes).toHaveBeenCalledTimes(writes);
    expect(s.checkClock).toHaveBeenCalledTimes(checks);
    s.state.value.anchor_position_ms = 11000;
    s.runtime.onClockReady(); // Routine fresh samples are not new recovery.
    await vi.advanceTimersByTimeAsync(500);
    expect(s.runtime.recoveryState.value).toBe("idle");
  } finally {
    s.cleanup();
  }
});

it.each(["buffering", "seeking", "ranges", "readiness"])(
  "fresh aligned media still waits for %s before ending recovery",
  async (condition) => {
    const s = setup();
    try {
      await s.prepare();
      await s.runtime.applyState();
      s.playing();
      s.invalidate();
      if (condition === "buffering") s.runtime.waiting.value = true;
      if (condition === "seeking") s.el.seeking = true;
      if (condition === "ranges") s.el.seekable = s.el.buffered = intervals([]);
      if (condition === "readiness") s.el.readyState = 1;
      s.clock.ready = true;
      s.runtime.onClockReady();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.runtime.recoveryState.value).toBe("waiting");
      s.runtime.waiting.value = false;
      s.el.seeking = false;
      s.el.readyState = 4;
      s.el.seekable = s.el.buffered = intervals([[0, 120]]);
      await vi.advanceTimersByTimeAsync(500);
      expect(s.runtime.recoveryState.value).toBe("idle");
    } finally {
      s.cleanup();
    }
  },
);

it("autoplay recovery keeps the gesture button and completes only after successful playback", async () => {
  const s = setup();
  try {
    await s.prepare();
    await s.runtime.applyState();
    s.state.value.playback_status = "playing";
    s.invalidate();
    s.el.play.mockRejectedValue(new Error("gesture required"));
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runtime.blocked.value).toBe(true);
    expect(s.runtime.recoveryState.value).toBe("blocked");
    expect(s.runtime.recoveryLabel.value).toContain("点击加入播放");
    await vi.advanceTimersByTimeAsync(1500);
    expect(s.el.play).toHaveBeenCalledTimes(1);
    s.el.play.mockImplementation(async () => {
      s.el.paused = false;
    });
    await s.runtime.enablePlayback();
    expect(s.runtime.blocked.value).toBe(false);
    expect(s.runtime.recoveryState.value).toBe("idle");
  } finally {
    s.cleanup();
  }
});

it("paused recovery aligns the static room target without starting playback", async () => {
  const s = setup();
  try {
    await s.prepare();
    await s.runtime.applyState();
    s.state.value.anchor_position_ms = 12000;
    s.invalidate();
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.el.currentTime).toBe(12);
    expect(s.el.play).not.toHaveBeenCalled();
    expect(s.runtime.recoveryState.value).toBe("idle");
  } finally {
    s.cleanup();
  }
});

it("fine-rate rejection ends recovery inside the existing wider stable window", async () => {
  const s = setup({ acceptRate: (rate, actual) => (rate === 1 ? 1 : actual) });
  try {
    await s.prepare();
    await s.runtime.applyState();
    s.playing();
    s.state.value.anchor_position_ms = 10400;
    await vi.advanceTimersByTimeAsync(500);
    s.invalidate();
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runtime.recoveryState.value).toBe("idle");
    expect(s.runtime.recoveryLabel.value).toBe("");
    expect(s.seeks).not.toHaveBeenCalled();
  } finally {
    s.cleanup();
  }
});

it("Stop clears recovery synchronously and late clock callbacks cannot revive it", async () => {
  const s = setup();
  try {
    await s.prepare();
    s.invalidate();
    expect(s.runtime.recoveryState.value).toBe("calibrating");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (path, method, body) => {
      if (method === "DELETE") await gate;
      return original(path, method, body);
    });
    const stopped = s.runtime.reset();
    expect(s.runtime.recoveryState.value).toBe("idle");
    expect(s.runtime.recoveryLabel.value).toBe("");
    s.clock.ready = true;
    s.runtime.onClockReady();
    s.invalidate(); // A later wake after local Stop owns no plan or load.
    expect(s.runtime.recoveryState.value).toBe("idle");
    release();
    await stopped;
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.runtime.recoveryState.value).toBe("idle");
  } finally {
    s.cleanup();
  }
});

it("media replacement and ending discard an earlier recovery", async () => {
  const s = setup();
  try {
    await s.prepare();
    s.invalidate();
    s.state.value.media_generation = 2;
    expect(s.runtime.recoveryState.value).toBe("idle");
    expect(s.runtime.recoveryLabel.value).toBe("");
    s.state.value.media_generation = 1;
    await s.runtime.loadMedia();
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    s.el.ended = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(s.runtime.recoveryState.value).toBe("idle");
  } finally {
    s.cleanup();
  }
});

it("an incomplete generated prefix ending keeps the recovery waiting", async () => {
  const s = setup({ rebuild: true, ranges: [[0, 10]] });
  try {
    await s.prepare();
    await s.runtime.applyState();
    s.playing();
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (path, method, body) =>
      method === "GET"
        ? {
            session_id: "session-1",
            plan_generation: 1,
            status: "preparing",
            complete: false,
            available_until_ms: 10000,
          }
        : original(path, method, body),
    );
    s.el.ended = true;
    s.invalidate();
    expect(s.runtime.recoveryState.value).toBe("calibrating");
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runtime.recoveryState.value).toBe("waiting");
    expect(s.runtime.recoveryLabel.value).toContain("等待播放就绪");
    await s.runtime.reset();
    expect(s.runtime.recoveryState.value).toBe("idle");
  } finally {
    s.cleanup();
  }
});

it("halts convergence after an initially accepted base is later clamped", async () => {
  let accept = true;
  const s = setup({ rate: 1.5, acceptRate: (rate) => (accept ? rate : 1) });
  try {
    await s.prepare();
    await s.runtime.applyState();
    s.playing();
    expect(s.el.playbackRate).toBe(1.5);
    accept = false;
    s.el.playbackRate = 1;
    s.state.value.anchor_position_ms = 30000;
    const writes = s.writes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(s.writes).toHaveBeenCalledTimes(writes);
    expect(s.seeks).not.toHaveBeenCalled();
    expect(s.error.value).toContain("不支持此速率");
    s.state.value.playback_rate = 1;
    await vi.advanceTimersByTimeAsync(500);
    expect(s.error.value).toBe("");
    expect(s.el.currentTime).toBe(30);
  } finally {
    s.cleanup();
  }
});
