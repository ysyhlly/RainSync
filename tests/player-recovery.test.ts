vi.mock("../apps/web/src/features/playback/browser-mse", async () => {
  const { default: Hls } = await import("hls.js");
  return {
    getPlaybackMediaSource: () => Hls.getMediaSource(),
    hasPlaybackMseApi: () => Hls.isMSESupported(),
    supportsHlsPlayback: () => Hls.isSupported(),
  };
});
import { afterEach, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";
import { createPlaybackRuntime } from "../apps/web/src/features/playback/playback-runtime";
import { RequestFailure } from "../apps/web/src/errors";
import { PLAYBACK_METRICS_MAX_ELAPSED_MS } from "../apps/web/src/features/playback/playback-metrics";

const isPlaybackPost = (path: string) =>
  path === "/playback-sessions" ||
  path === "/playback-sessions/http-file-continuation";

const faults = vi.hoisted(() => ({
  construct: false,
  observe: false,
  dispose: false,
}));
const meterStarts = vi.hoisted(() => [] as number[]);
const hls = vi.hoisted(() => ({
  supported: false,
  start: vi.fn(),
  load: vi.fn(),
  errorHandler: undefined as ((event: unknown, data: any) => void) | undefined,
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
    on(_event: unknown, handler: (event: unknown, data: any) => void) {
      hls.errorHandler = handler;
    }
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
        if (faults.construct) throw new Error("telemetry construction");
        meterStarts.push(args[0].t0);
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
  faults.construct = faults.observe = faults.dispose = false;
  meterStarts.length = 0;
  hls.supported = false;
  hls.start.mockClear();
  hls.load.mockReset();
  hls.errorHandler = undefined;
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
    fileFallback?: boolean;
    captureErrors?: boolean;
    candidateId?: string;
    deferAttach?: boolean;
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
      if (isPlaybackPost(path) && method === "POST")
        return {
          session_id: `session-${body.plan_generation}`,
          plan_generation: body.plan_generation,
          media_id: state.value.media_id,
          media_generation: body.media_generation,
          transport:
            options.hls || body.http_file_fallback ? "hls" : "progressive",
          delivery_mode: body.http_file_fallback ? "transcode" : "direct",
          selected_candidate_id: options.candidateId,
          ...(options.fileFallback && !body.http_file_fallback
            ? {
                http_file_fallback_version: 1,
                decoder_fallback_modes: ["transcode"],
              }
            : {}),
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
    error = ref(""),
    active = ref(true);
  const clock = { ready: true, revision: 0, time: 0, now: () => clock.time };
  const checkClock = vi.fn();
  const scope = effectScope();
  const runtime = scope.run(() =>
    createPlaybackRuntime({
      session: session as any,
      state: state as any,
      connected,
      active,
      clock: clock as any,
      checkClock,
      error,
      run: async (action) => {
        if (options.clearsError) error.value = "";
        try {
          await action();
        } catch (failure) {
          if (!options.captureErrors) throw failure;
          error.value =
            failure instanceof Error ? failure.message : String(failure);
        }
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
  if (!options.deferAttach) runtime.attach(el);
  return {
    runtime,
    session,
    el,
    clock,
    state,
    connected,
    active,
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

const mediaDataTimeout = "媒体数据加载超时，请检查连接或重新加载播放";
const playInterrupted = "媒体播放被中断，请重试或重新加载播放";
const playbackPosts = (s: ReturnType<typeof setup>) =>
  s.api.mock.calls.filter(
    ([path, method]) => isPlaybackPost(path) && method === "POST",
  );

it("replays the original deferred generation when the host attaches after the room snapshot", async () => {
  const s = setup({ deferAttach: true });
  try {
    await s.runtime.loadMedia();
    expect(playbackPosts(s)).toHaveLength(0);
    s.runtime.attach(s.el);
    await vi.advanceTimersByTimeAsync(0);
    expect(playbackPosts(s)).toHaveLength(1);
    expect(playbackPosts(s)[0][2].plan_generation).toBe(1);
    expect(s.el.src).toBe("/authorized.mp4");
    expect(meterStarts).toHaveLength(1);
    s.runtime.attach(s.el);
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it("keeps a late host's original load deferred until its clock is ready", async () => {
  const s = setup({ deferAttach: true });
  try {
    s.clock.ready = false;
    await s.runtime.loadMedia();
    s.runtime.attach(s.el);
    await vi.advanceTimersByTimeAsync(0);
    expect(playbackPosts(s)).toHaveLength(0);
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(playbackPosts(s)).toHaveLength(1);
    expect(playbackPosts(s)[0][2].plan_generation).toBe(1);
  } finally {
    s.cleanup();
  }
});

it("does not replay a late host's deferred load after its identity changes", async () => {
  const s = setup({ deferAttach: true });
  try {
    await s.runtime.loadMedia();
    ++s.session.epoch;
    s.runtime.attach(s.el);
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(playbackPosts(s)).toHaveLength(0);
    expect(s.el.src).toBe("");
  } finally {
    s.cleanup();
  }
});

it("exposes queue, confirmed transcode and ready from one existing request", async () => {
  const s = setup({ rebuild: true });
  const original = s.api.getMockImplementation()!;
  const statuses = ["queued", "preparing", "ready"];
  s.api.mockImplementation(async (path, method, body) => {
    const result = await original(path, method, body);
    if (isPlaybackPost(path) && method === "POST")
      return { ...result, delivery_mode: "transcode" };
    if (method === "GET" && path.startsWith("/playback-sessions/"))
      return { ...result, status: statuses.shift() ?? "ready" };
    return result;
  });
  try {
    const loading = s.runtime.loadMedia();
    expect(s.runtime.preparation.value.phase).toBe("preparing");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runtime.preparation.value.phase).toBe("queued");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.runtime.preparation.value.phase).toBe("transcoding");
    await vi.advanceTimersByTimeAsync(1000);
    await loading;
    expect(s.runtime.preparation.value.phase).toBe("ready");
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it("waits for cancellation acknowledgement, ignores late readiness, and retries with a fresh identity", async () => {
  const s = setup({ rebuild: true });
  const original = s.api.getMockImplementation()!;
  let releaseRead!: () => void, releaseDelete!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let hold = true;
  s.api.mockImplementation(async (path, method, body) => {
    if (hold && method === "GET" && path.startsWith("/playback-sessions/"))
      await readGate;
    if (hold && method === "DELETE" && path.startsWith("/playback-requests/"))
      await deleteGate;
    return original(path, method, body);
  });
  try {
    const loading = s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    const first = playbackPosts(s)[0][2];
    const cancellation = s.runtime.cancelPreparation();
    expect(s.runtime.preparation.value.phase).toBe("cancelling");
    releaseRead();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runtime.preparation.value.phase).toBe("cancelling");
    releaseDelete();
    await Promise.all([loading, cancellation]);
    expect(s.runtime.preparation.value.phase).toBe("cancelled");
    hold = false;
    await s.runtime.loadMedia();
    const second = playbackPosts(s)[1][2];
    expect(second.plan_generation).toBeGreaterThan(first.plan_generation);
    expect(second.idempotency_key).not.toBe(first.idempotency_key);
    expect(s.runtime.preparation.value.phase).toBe("ready");
  } finally {
    releaseRead();
    releaseDelete();
    s.cleanup();
  }
});

it("shows failed cancellation without falsely confirming server cleanup", async () => {
  const s = setup({ rebuild: true });
  const original = s.api.getMockImplementation()!;
  s.api.mockImplementation(async (path, method, body) => {
    if (method === "DELETE" && path.startsWith("/playback-requests/"))
      throw new TypeError("offline");
    const result = await original(path, method, body);
    return method === "GET" && path.startsWith("/playback-sessions/")
      ? { ...result, status: "queued" }
      : result;
  });
  try {
    const loading = s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    await expect(s.runtime.cancelPreparation()).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(1000);
    await loading;
    expect(s.runtime.preparation.value).toMatchObject({
      phase: "failed",
      failure: { message: "取消尚未确认，恢复连接后重试撤销请求。" },
    });
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it("cancels a clock-deferred preparation and does not restart it on clock recovery", async () => {
  const s = setup();
  try {
    s.clock.ready = false;
    await s.runtime.loadMedia();
    expect(s.runtime.preparation.value.phase).toBe("preparing");
    await s.runtime.cancelPreparation();
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.runtime.preparation.value.phase).toBe("cancelled");
    expect(playbackPosts(s)).toHaveLength(0);
  } finally {
    s.cleanup();
  }
});

it("an explicit unsupported HLS timeline is visible and cannot authorize a decoder fallback", async () => {
  const s = setup({ hls: true, fileFallback: true });
  try {
    hls.supported = true;
    s.el.canPlayType = () => "";
    await s.runtime.loadMedia();
    hls.errorHandler!(undefined, {
      fatal: true,
      type: "mediaError",
      response: { code: 422 },
      networkDetails: {
        responseText: JSON.stringify({
          error: {
            code: "UNSUPPORTED_TIMELINE",
            message: "private upstream body",
          },
        }),
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.error.value).toContain("时间轴无法安全映射");
    expect(s.error.value).not.toContain("private upstream body");
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it.each([
  { timeline_origin_ms: NaN },
  { timeline_origin_ms: -1 },
  { timeline_origin_ms: 120001 },
  { timeline_origin_ms: 1000 }, // A progressive route cannot be a cropped job.
  {
    timeline_origin_ms: 1000,
    delivery_mode: "remux",
    transport: "hls",
    rebuild_on_seek: true,
  },
])(
  "rejects unsafe timeline before readiness, attachment and observations: %j",
  async (fields) => {
    const s = setup({ observationSeq: 0 });
    try {
      const original = s.api.getMockImplementation()!;
      s.api.mockImplementation(async (...args) => {
        const result = await original(...args);
        return isPlaybackPost(args[0]) && args[1] === "POST"
          ? { ...result, ...fields }
          : result;
      });
      await expect(s.runtime.loadMedia()).rejects.toMatchObject({
        code: "UNSUPPORTED_TIMELINE",
      });
      expect(playbackPosts(s)).toHaveLength(1);
      expect(s.el.src).toBe("");
      expect(s.runtime.sessionId.value).toBeNull();
      expect(
        s.api.mock.calls.some(
          ([path, method]) =>
            path.startsWith("/playback-sessions/") && method === "GET",
        ),
      ).toBe(false);
      expect(
        s.api.mock.calls.some(
          ([path, method]) =>
            path.startsWith("/playback-requests/") && method === "DELETE",
        ),
      ).toBe(true);
      expect(
        s.api.mock.calls.some(([path]) => path.endsWith("/observations")),
      ).toBe(false);
    } finally {
      s.cleanup();
    }
  },
);

it.each([false, true])(
  "bounds unpresented ready media independently of telemetry (telemetry fails=%s)",
  async (brokenTelemetry) => {
    const s = setup({ fileFallback: true });
    try {
      faults.construct = brokenTelemetry;
      s.state.value.playback_status = "playing";
      await s.runtime.loadMedia();
      s.el.onloadedmetadata();
      s.el.onloadeddata();
      s.el.dispatchEvent(new Event("canplay"));
      s.el.dispatchEvent(new Event("playing"));
      await vi.advanceTimersByTimeAsync(19_999);
      expect(s.error.value).toBe("");
      await vi.advanceTimersByTimeAsync(1);
      expect(s.error.value).toContain("首帧等待超时");
      expect(playbackPosts(s)).toHaveLength(1);
      // Timeout is not a decoder diagnosis or permission for a new route.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(playbackPosts(s)).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  },
);

it.each(["callback", "approximation"])(
  "only %s presentation finishes the route deadline",
  async (evidence) => {
    const s = setup();
    try {
      let frame!: (at: number, metadata: any) => void;
      if (evidence === "callback") {
        s.el.requestVideoFrameCallback = (callback: typeof frame) => {
          frame = callback;
          return 1;
        };
        s.el.cancelVideoFrameCallback = vi.fn();
      }
      s.state.value.playback_status = "playing";
      await s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(1000);
      if (evidence === "callback") frame(1000, { presentationTime: 950 });
      else {
        s.el.paused = false;
        s.el.dispatchEvent(new Event("playing"));
        s.el.currentTime += 0.1;
        s.el.dispatchEvent(new Event("timeupdate"));
      }
      await vi.advanceTimersByTimeAsync(30_000);
      expect(s.error.value).toBe("");
      expect(playbackPosts(s)).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  },
);

it("preparing and a paused room do not consume the presentation budget", async () => {
  const s = setup();
  try {
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (...args) => {
      if (isPlaybackPost(args[0]) && args[1] === "POST")
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      return original(...args);
    });
    s.state.value.playback_status = "playing";
    const preparing = s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(30_000);
    await preparing;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(s.error.value).toBe("");
    s.state.value.playback_status = "paused";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.error.value).toBe("");
    s.state.value.playback_status = "playing";
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.error.value).toContain("首帧等待超时");
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it("new route ignores an old presentation callback and same-route recovery retains budget", async () => {
  const s = setup({ hls: true });
  try {
    const callbacks: ((at: number, metadata: any) => void)[] = [];
    s.el.requestVideoFrameCallback = (callback: (typeof callbacks)[number]) =>
      callbacks.push(callback);
    s.el.cancelVideoFrameCallback = vi.fn();
    s.state.value.playback_status = "playing";
    await s.runtime.loadMedia();
    const first = callbacks[0];
    await vi.advanceTimersByTimeAsync(15_000);
    hls.supported = true;
    s.el.error = { code: 3 };
    s.el.onerror();
    first(15_000, { presentationTime: 15_000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.error.value).toContain("首帧等待超时");
    s.error.value = "";
    await s.runtime.loadMedia();
    first(20_000, { presentationTime: 20_000 });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(s.error.value).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.error.value).toContain("首帧等待超时");
    expect(playbackPosts(s)).toHaveLength(2);
  } finally {
    s.cleanup();
  }
});

it.each([
  { name: "HTTP progressive", hls: false, mse: false },
  { name: "legacy/upstream native HLS", hls: true, mse: false },
  { name: "legacy/upstream MSE HLS", hls: true, mse: true },
  {
    name: "candidate-bound progressive",
    hls: false,
    mse: false,
    candidateId: "direct",
  },
])(
  "bounds initial usable data for $name without decoding fallback",
  async (options) => {
    const s = setup({ ...options, fileFallback: true });
    try {
      hls.supported = options.mse;
      if (options.mse) s.el.canPlayType = () => "";
      s.el.readyState = 1;
      await s.runtime.loadMedia();
      expect(s.runtime.waiting.value).toBe(true);
      s.el.onloadedmetadata();
      await vi.advanceTimersByTimeAsync(19999);
      expect(s.error.value).toBe("");
      // Ordinary waiting/buffering and a stalled network do not pause this bound.
      expect(s.runtime.waiting.value).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.error.value).toBe(mediaDataTimeout);
      expect(s.runtime.waiting.value).toBe(false);
      expect(playbackPosts(s)).toHaveLength(1);
      expect(s.runtime.sessionId.value).toBe("session-1");
    } finally {
      s.cleanup();
    }
  },
);

it.each(["loadeddata", "readyState"] as const)(
  "usable %s completes the data bound without claiming a presented frame",
  async (completion) => {
    const s = setup();
    try {
      s.el.readyState = 1;
      await s.runtime.loadMedia();
      s.el.onloadeddata();
      await vi.advanceTimersByTimeAsync(10000);
      expect(s.error.value).toBe("");
      s.el.readyState = 2;
      if (completion === "loadeddata") s.el.onloadeddata();
      else await vi.advanceTimersByTimeAsync(10000);
      s.el.readyState = 1;
      await vi.advanceTimersByTimeAsync(25000);
      expect(s.error.value).toBe("");
      expect(playbackPosts(s)).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  },
);

it.each(["explicit authorization failure", "media network failure"])(
  "a media-data timeout preserves an existing %s",
  async (failure) => {
    const s = setup({ fileFallback: true });
    try {
      s.el.readyState = 1;
      await s.runtime.loadMedia();
      const queuedLoadedData = s.el.onloadeddata;
      if (failure === "media network failure") {
        s.el.error = { code: 2 };
        s.el.onerror();
      } else s.error.value = "播放会话已失效，请重新加载";
      const explicitError = s.error.value;
      await vi.advanceTimersByTimeAsync(25000);
      expect(s.error.value).toBe(explicitError);
      expect(s.runtime.waiting.value).toBe(false);
      s.el.readyState = 2;
      queuedLoadedData();
      expect(s.error.value).toBe(explicitError);
      expect(playbackPosts(s)).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  },
);

it("reload owns a fresh budget and an older loadeddata callback cannot finish it", async () => {
  const s = setup();
  try {
    s.el.readyState = 1;
    await s.runtime.loadMedia();
    const oldData = s.el.onloadeddata;
    await vi.advanceTimersByTimeAsync(10000);
    await s.runtime.loadMedia();
    s.el.readyState = 2;
    oldData();
    s.el.readyState = 1;
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.error.value).toBe("");
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.error.value).toBe(mediaDataTimeout);
    expect(playbackPosts(s)).toHaveLength(2);
  } finally {
    s.cleanup();
  }
});

it.each([
  "reset",
  "inactive",
  "identity",
  "user",
  "media",
  "media id",
  "room",
  "dispose",
] as const)(
  "%s invalidates the old data deadline and callback",
  async (interruption) => {
    const s = setup();
    try {
      s.el.readyState = 1;
      await s.runtime.loadMedia();
      const oldData = s.el.onloadeddata;
      await vi.advanceTimersByTimeAsync(10000);
      switch (interruption) {
        case "reset":
          await s.runtime.reset();
          break;
        case "inactive":
          s.active.value = false;
          break;
        case "identity":
          s.session.epoch++;
          break;
        case "user":
          s.session.user.id = "other-user";
          break;
        case "media":
          s.state.value.media_generation++;
          break;
        case "media id":
          s.state.value.media_id = "other-media";
          break;
        case "room":
          s.state.value.room_id = "other-room";
          break;
        case "dispose":
          s.cleanup();
          break;
      }
      await vi.advanceTimersByTimeAsync(25000);
      expect(s.error.value).toBe("");
      // Reusing a room or identity does not make its old source callback valid.
      s.active.value = true;
      s.session.epoch = 1;
      s.session.user.id = "user";
      s.state.value.media_generation = 1;
      s.state.value.media_id = "media";
      s.state.value.room_id = "room";
      s.error.value = mediaDataTimeout;
      s.el.readyState = 2;
      oldData();
      expect(s.error.value).toBe(mediaDataTimeout);
      expect(playbackPosts(s)).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  },
);

it.each([false, true])(
  "same-plan native recovery keeps the original data budget (MSE=%s)",
  async (mse) => {
    const s = setup({ hls: true });
    try {
      hls.supported = mse;
      s.el.readyState = 1;
      await s.runtime.loadMedia();
      const oldData = s.el.onloadeddata;
      await vi.advanceTimersByTimeAsync(15000);
      s.el.load.mockImplementation(() => {
        // Reentrant delivery during source replacement still owns the old load.
        s.el.readyState = 2;
        oldData();
        s.el.readyState = 1;
      });
      s.el.error = { code: mse ? 3 : 2 };
      s.el.onerror();
      expect(playbackPosts(s)).toHaveLength(1);
      expect(s.el.onloadeddata).not.toBe(oldData);
      s.el.readyState = 2;
      oldData();
      s.el.readyState = 1;
      await vi.advanceTimersByTimeAsync(4999);
      expect(s.error.value).toBe("");
      await vi.advanceTimersByTimeAsync(1);
      expect(s.error.value).toBe(mediaDataTimeout);
      expect(playbackPosts(s)).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  },
);

it("same-plan recovery after usable data does not restart the initial data deadline", async () => {
  const s = setup({ hls: true });
  try {
    hls.supported = true;
    s.el.readyState = 1;
    await s.runtime.loadMedia();
    s.el.readyState = 2;
    s.el.onloadeddata();
    s.el.readyState = 1;
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(25000);
    expect(s.error.value).toBe("");
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

for (const path of ["native reload", "native to MSE", "MSE reload"] as const) {
  it.each(["AbortError", "NotAllowedError", "success"] as const)(
    `${path} fences a causal old play() %s and keeps the remaining data budget`,
    async (outcome) => {
      const s = setup({ hls: true });
      try {
        hls.supported = path !== "native reload";
        if (path === "MSE reload") s.el.canPlayType = () => "";
        s.el.readyState = 1;
        await s.runtime.loadMedia();
        await vi.advanceTimersByTimeAsync(15000);
        let settle!: () => void;
        s.el.play.mockImplementationOnce(() => {
          s.el.paused = false;
          return new Promise<void>((resolve, reject) => {
            settle = () => {
              if (outcome === "success") resolve();
              else reject(new DOMException("old source interrupted", outcome));
            };
          });
        });
        s.el.play.mockImplementation(() => new Promise<void>(() => {}));
        s.state.value.playback_status = "playing";
        const oldPlay = s.runtime.applyState();
        let interruptions = 0;
        const interrupt = () => {
          s.el.paused = true;
          s.el.readyState = 1;
          interruptions++;
          settle();
        };
        s.el.load.mockImplementation(interrupt);
        if (path === "native to MSE") s.el.pause.mockImplementation(interrupt);
        if (path === "MSE reload") {
          hls.load.mockImplementation(interrupt);
          hls.errorHandler?.(undefined, {
            fatal: true,
            response: { code: 409 },
          });
        } else {
          s.el.error = { code: path === "native to MSE" ? 3 : 2 };
          s.el.onerror();
        }
        await oldPlay;
        expect(interruptions).toBeGreaterThan(0);
        expect(s.runtime.blocked.value).toBe(false);
        expect(s.error.value).toBe("");
        expect(playbackPosts(s)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(4999);
        expect(s.error.value).toBe("");
        await vi.advanceTimersByTimeAsync(1);
        expect(s.error.value).toBe(mediaDataTimeout);
        expect(s.runtime.waiting.value).toBe(false);
        expect(playbackPosts(s)).toHaveLength(1);
      } finally {
        s.cleanup();
      }
    },
  );
}

it.each(["success", "NotAllowedError", "NotSupportedError"] as const)(
  "old same-plan play %s preserves a newer room PAUSE, gesture gate, and explicit error",
  async (outcome) => {
    const s = setup({ hls: true });
    try {
      s.el.readyState = 1;
      await s.runtime.loadMedia();
      let settle!: () => void;
      s.el.play.mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            settle = () =>
              outcome === "success"
                ? resolve()
                : reject(new DOMException("old source result", outcome));
          }),
      );
      s.state.value.playback_status = "playing";
      const oldPlay = s.runtime.applyState();
      s.el.load.mockImplementation(() => {
        s.el.paused = false;
        settle();
      });
      s.el.error = { code: 2 };
      s.el.onerror();
      s.state.value.playback_status = "paused";
      s.runtime.blocked.value = true;
      s.error.value = "replacement authorization failure";
      await oldPlay;
      expect(s.el.paused).toBe(true);
      expect(s.runtime.blocked.value).toBe(true);
      expect(s.error.value).toBe("replacement authorization failure");
      expect(playbackPosts(s)).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  },
);

it.each(["source recovery", "explicit gesture", "reload"] as const)(
  "%s clears a current-source play failure without automatic preparation",
  async (retry) => {
    const s = setup({ hls: true });
    try {
      s.el.readyState = 1;
      await s.runtime.loadMedia();
      s.state.value.playback_status = "playing";
      s.el.play.mockRejectedValueOnce(
        new DOMException("source unsupported", "NotSupportedError"),
      );
      await expect(s.runtime.applyState()).rejects.toMatchObject({
        name: "NotSupportedError",
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.el.play).toHaveBeenCalledTimes(1);
      expect(s.runtime.blocked.value).toBe(false);
      s.el.play.mockImplementation(async () => {
        s.el.paused = false;
      });
      if (retry === "source recovery") {
        s.el.error = { code: 2 };
        s.el.onerror();
      } else if (retry === "explicit gesture") await s.runtime.enablePlayback();
      else await s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(500);
      expect(s.el.play).toHaveBeenCalledTimes(2);
      expect(playbackPosts(s)).toHaveLength(retry === "reload" ? 2 : 1);
    } finally {
      s.cleanup();
    }
  },
);

it.each([false, true])(
  "generated recovery pause fences the old play promise and retains the data budget (MSE=%s)",
  async (mse) => {
    const s = setup({ hls: true, rebuild: true });
    try {
      hls.supported = mse;
      if (mse) s.el.canPlayType = () => "";
      s.el.readyState = 1;
      await s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(15000);
      let reject!: (failure: Error) => void;
      s.el.play.mockImplementationOnce(() => {
        s.el.paused = false;
        return new Promise<void>((_resolve, fail) => {
          reject = fail;
        });
      });
      s.el.play.mockImplementation(() => new Promise<void>(() => {}));
      s.state.value.playback_status = "playing";
      const oldPlay = s.runtime.applyState();
      s.el.pause.mockImplementation(() => {
        s.el.paused = true;
        reject(
          new DOMException("generated wait interrupted play", "AbortError"),
        );
      });
      s.el.seekable = s.el.buffered = intervals([]);
      await s.runtime.applyState(true);
      await oldPlay;
      expect(s.runtime.blocked.value).toBe(false);
      await vi.advanceTimersByTimeAsync(4999);
      expect(s.error.value).toBe("");
      await vi.advanceTimersByTimeAsync(1);
      expect(s.error.value).toBe(mediaDataTimeout);
      expect(playbackPosts(s)).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  },
);

for (const action of ["applyState", "enablePlayback"] as const) {
  it.each([
    "AbortError",
    "NotAllowedError",
    "NotSupportedError",
    "Error",
  ] as const)(
    `${action} suspends the data budget only for an actual %s autoplay denial`,
    async (name) => {
      const s = setup();
      try {
        s.el.readyState = 1;
        await s.runtime.loadMedia();
        await vi.advanceTimersByTimeAsync(5000);
        s.state.value.playback_status = "playing";
        const failure = new DOMException("current play failure", name);
        s.el.play.mockRejectedValueOnce(failure);
        s.el.play.mockImplementation(() => new Promise<void>(() => {}));
        const playing = s.runtime[action]();
        if (
          name === "AbortError" ||
          (action === "applyState" && name === "NotAllowedError")
        )
          await expect(playing).resolves.toBeUndefined();
        else await expect(playing).rejects.toBe(failure);
        expect(s.runtime.blocked.value).toBe(name === "NotAllowedError");
        await vi.advanceTimersByTimeAsync(15000);
        expect(s.error.value).toBe(
          name === "NotAllowedError"
            ? ""
            : name === "AbortError"
              ? playInterrupted
              : mediaDataTimeout,
        );
        expect(s.el.play).toHaveBeenCalledTimes(1);
        expect(playbackPosts(s)).toHaveLength(1);
      } finally {
        s.cleanup();
      }
    },
  );
}

it.each(["", "authorization failure"])(
  "a current AbortError after usable data has a visible recoverable outcome and preserves %s",
  async (priorError) => {
    const s = setup();
    try {
      s.el.readyState = 2;
      await s.runtime.loadMedia();
      s.state.value.playback_status = "playing";
      s.error.value = priorError;
      s.el.play.mockRejectedValueOnce(
        new DOMException("current playback interrupted", "AbortError"),
      );
      await s.runtime.applyState();
      await vi.advanceTimersByTimeAsync(25000);
      expect(s.runtime.blocked.value).toBe(false);
      expect(s.error.value).toBe(priorError || playInterrupted);
      expect(s.el.play).toHaveBeenCalledTimes(1);
      await s.runtime.enablePlayback();
      expect(s.el.play).toHaveBeenCalledTimes(2);
      expect(s.error.value).toBe(priorError);
      expect(playbackPosts(s)).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  },
);

it("an explicit gesture resumes the remaining budget while its play() is still waiting for data", async () => {
  const s = setup();
  try {
    s.el.readyState = 1;
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(5000);
    s.state.value.playback_status = "playing";
    s.el.play.mockRejectedValueOnce(
      new DOMException("gesture required", "NotAllowedError"),
    );
    await s.runtime.applyState();
    await vi.advanceTimersByTimeAsync(30000);
    let interrupt!: () => void;
    s.el.play.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          interrupt = () =>
            reject(new DOMException("gesture play interrupted", "AbortError"));
        }),
    );
    const gesture = s.runtime.enablePlayback();
    expect(s.runtime.blocked.value).toBe(false);
    await vi.advanceTimersByTimeAsync(14999);
    expect(s.error.value).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.error.value).toBe(mediaDataTimeout);
    interrupt();
    await gesture;
    expect(s.runtime.blocked.value).toBe(false);
    expect(s.error.value).toBe(mediaDataTimeout);
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it.each([NaN, Infinity, -1])(
  "a broken monotonic clock (%s) cannot extend a source transition's budget",
  async (now) => {
    const s = setup({ hls: true });
    try {
      s.el.readyState = 1;
      await s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(15000);
      const clock = vi.spyOn(performance, "now").mockReturnValue(now);
      s.el.error = { code: 2 };
      s.el.onerror();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.error.value).toBe(mediaDataTimeout);
      expect(playbackPosts(s)).toHaveLength(1);
      clock.mockRestore();
    } finally {
      s.cleanup();
    }
  },
);

it.each(["construction", "observation"] as const)(
  "telemetry %s failure does not disable the media-data deadline",
  async (failure) => {
    const s = setup();
    try {
      if (failure === "construction") faults.construct = true;
      else faults.observe = true;
      s.el.readyState = 1;
      await s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(20000);
      expect(s.error.value).toBe(mediaDataTimeout);
      expect(playbackPosts(s)).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  },
);

it("the telemetry elapsed limit does not disable the core data deadline", async () => {
  const s = setup();
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    s.el.readyState = 1;
    await s.runtime.loadMedia();
    // Advance only telemetry's sampled timestamp; avoid millions of fake ticks.
    clock = vi
      .spyOn(performance, "now")
      .mockReturnValue(PLAYBACK_METRICS_MAX_ELAPSED_MS + 1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(s.error.value).toBe(mediaDataTimeout);
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    clock?.mockRestore();
    s.cleanup();
  }
});

it("confirmed autoplay blocking pauses the data budget and a gesture resumes it", async () => {
  const s = setup();
  try {
    s.el.readyState = 1;
    s.el.play.mockRejectedValueOnce(
      new DOMException("gesture required", "NotAllowedError"),
    );
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(5000);
    s.state.value.playback_status = "playing";
    await s.runtime.applyState();
    expect(s.runtime.blocked.value).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(s.error.value).toBe("");
    expect(s.runtime.recoveryState.value).toBe("blocked");
    await s.runtime.enablePlayback();
    expect(s.runtime.blocked.value).toBe(false);
    await vi.advanceTimersByTimeAsync(14999);
    expect(s.error.value).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.error.value).toBe(mediaDataTimeout);
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it("an unresolved play promise cannot hide a data stall and a late gesture rejection takes priority", async () => {
  const s = setup();
  let reject!: (failure: Error) => void;
  try {
    s.el.readyState = 1;
    s.state.value.playback_status = "playing";
    s.el.play.mockImplementation(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    await s.runtime.loadMedia();
    const playing = s.runtime.applyState();
    await vi.advanceTimersByTimeAsync(20000);
    expect(s.error.value).toBe(mediaDataTimeout);
    reject(new DOMException("gesture required", "NotAllowedError"));
    await playing;
    expect(s.runtime.blocked.value).toBe(true);
    expect(s.error.value).toBe("");
    expect(s.runtime.recoveryState.value).toBe("blocked");
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it("hidden visibility pauses the data budget and foreground calibration keeps the remaining budget", async () => {
  const s = setup();
  try {
    s.el.readyState = 1;
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(5000);
    s.document.visibilityState = "hidden";
    s.document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(s.error.value).toBe("");
    expect(s.runtime.recoveryState.value).toBe("background");
    s.clock.ready = false;
    s.document.visibilityState = "visible";
    s.document.dispatchEvent(new Event("visibilitychange"));
    expect(s.runtime.recoveryState.value).toBe("calibrating");
    await vi.advanceTimersByTimeAsync(14999);
    expect(s.error.value).toBe("");
    expect(s.runtime.recoveryState.value).toBe("calibrating");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.error.value).toBe(mediaDataTimeout);
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it("queue preparation and generated readiness have separate waits from usable-data loading", async () => {
  const s = setup({ rebuild: true, hls: true, ranges: [] });
  let ready = false;
  const original = s.api.getMockImplementation()!;
  s.api.mockImplementation(async (path, method, body) => {
    if (method === "GET" && path.startsWith("/playback-sessions/"))
      return {
        session_id: "session-1",
        plan_generation: 1,
        status: ready ? "ready" : "queued",
        complete: false,
        available_until_ms: 30000,
      };
    return original(path, method, body);
  });
  try {
    s.el.readyState = 1;
    const loading = s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(30000);
    expect(s.el.src).toBe("");
    expect(s.error.value).toBe("");
    ready = true;
    await vi.advanceTimersByTimeAsync(1000);
    await loading;
    await vi.advanceTimersByTimeAsync(5000);
    ready = false;
    const generating = s.runtime.applyState(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(s.error.value).toBe("");
    expect(s.runtime.waiting.value).toBe(true);
    ready = true;
    await vi.advanceTimersByTimeAsync(1000);
    await generating;
    await vi.advanceTimersByTimeAsync(14999);
    expect(s.error.value).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.error.value).toBe(mediaDataTimeout);
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it("continues an opted-in HTTP decoder failure once with the old final sample before DELETE", async () => {
  const s = setup({ fileFallback: true, observationSeq: 0 });
  try {
    await s.prepare();
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(0);
    const posts = s.api.mock.calls.filter(
      ([path, method]) => isPlaybackPost(path) && method === "POST",
    );
    expect(posts).toHaveLength(2);
    const body = posts[1][2];
    expect(body.mode).toBe("transcode");
    expect(body.http_file_fallback_version).toBe(1);
    expect(body.http_file_fallback.parent_session_id).toBe("session-1");
    expect(body.http_file_fallback.final_observation.seq).toBe(1);
    expect(body.playback_metrics).toEqual(posts[0][2].playback_metrics);
    const finalDelete = s.api.mock.calls.findIndex(
      ([path, method]) =>
        path === "/playback-sessions/session-1" && method === "DELETE",
    );
    expect(finalDelete).toBeGreaterThan(s.api.mock.calls.indexOf(posts[1]));
    expect(s.api.mock.calls[finalDelete][2]).toEqual(
      body.http_file_fallback.final_observation,
    );
    expect(s.runtime.sessionId.value).toBe("session-2");
    // The successor's fatal media error may use same-plan native recovery, but
    // it must never allocate a third continuation or a fresh unbound plan.
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      s.api.mock.calls.filter(
        ([path, method]) => isPlaybackPost(path) && method === "POST",
      ),
    ).toHaveLength(2);
  } finally {
    s.cleanup();
  }
});

it.each([false, true])(
  "never uses file continuation for a network error (marker=%s)",
  async (fileFallback) => {
    const s = setup({ fileFallback });
    try {
      await s.prepare();
      s.el.error = { code: 2 };
      s.el.onerror();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        s.api.mock.calls.filter(
          ([path, method]) => isPlaybackPost(path) && method === "POST",
        ),
      ).toHaveLength(1);
      expect(s.error.value).toContain("检查连接");
    } finally {
      s.cleanup();
    }
  },
);

it("keeps old-server playback usable without inventing file continuation eligibility", async () => {
  const s = setup();
  try {
    await s.prepare();
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      s.api.mock.calls.filter(
        ([path, method]) => isPlaybackPost(path) && method === "POST",
      ),
    ).toHaveLength(1);
    await s.runtime.loadMedia();
    const posts = s.api.mock.calls.filter(
      ([path, method]) => isPlaybackPost(path) && method === "POST",
    );
    expect(posts).toHaveLength(2);
    expect(posts[1][2].http_file_fallback).toBeUndefined();
  } finally {
    s.cleanup();
  }
});

it.each(["NOT_FOUND", "METHOD_NOT_ALLOWED"] as const)(
  "a cached marker after rollback fails closed on %s without ordinary prepare fallback",
  async (code) => {
    const s = setup({
      fileFallback: true,
      observationSeq: 0,
      captureErrors: true,
    });
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (path, method, body) => {
      if (path === "/playback-sessions/http-file-continuation")
        throw new RequestFailure({ error: { code } });
      return original(path, method, body);
    });
    try {
      await s.prepare();
      s.el.error = { code: 3 };
      s.el.onerror();
      await vi.advanceTimersByTimeAsync(2000);
      expect(
        s.api.mock.calls.filter(
          ([path]) => path === "/playback-sessions/http-file-continuation",
        ),
      ).toHaveLength(1);
      expect(
        s.api.mock.calls.filter(
          ([path, method]) =>
            path === "/playback-sessions" && method === "POST",
        ),
      ).toHaveLength(1);
      expect(s.runtime.sessionId.value).toBeNull();
      expect(s.error.value).toContain("不支持安全续接");
      expect(
        s.api.mock.calls.some(
          ([path, method, body]) =>
            path === "/playback-sessions/session-1" &&
            method === "DELETE" &&
            body.seq === 1,
        ),
      ).toBe(true);
      s.invalidate();
      s.clock.ready = true;
      s.runtime.onClockReady();
      await vi.advanceTimersByTimeAsync(2000);
      expect(
        s.api.mock.calls.filter(
          ([path, method]) => isPlaybackPost(path) && method === "POST",
        ),
      ).toHaveLength(2);
      // Explicit reload is a fresh user intent and uses the ordinary route.
      await s.runtime.loadMedia();
      const ordinary = s.api.mock.calls.filter(
        ([path, method]) => path === "/playback-sessions" && method === "POST",
      );
      expect(ordinary).toHaveLength(2);
      expect(ordinary[1][2].http_file_fallback).toBeUndefined();
    } finally {
      s.cleanup();
    }
  },
);

it("clock invalidation during a claimed file continuation preserves its key and waits for calibration", async () => {
  const s = setup({ fileFallback: true, observationSeq: 0 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = s.api.getMockImplementation()!;
  s.api.mockImplementation(async (path, method, body) => {
    if (isPlaybackPost(path) && body?.http_file_fallback) await held;
    return original(path, method, body);
  });
  try {
    await s.prepare();
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(0);
    s.invalidate();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runtime.sessionId.value).toBe("session-2");
    expect(s.runtime.recoveryState.value).toBe("calibrating");
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      s.api.mock.calls.filter(
        ([path, method]) => isPlaybackPost(path) && method === "POST",
      ),
    ).toHaveLength(2);
  } finally {
    release();
    s.cleanup();
  }
});

it("defers file continuation before claim until a fresh clock while preserving the logical t0", async () => {
  const s = setup({ fileFallback: true, observationSeq: 0 });
  try {
    await s.prepare();
    const t0 = meterStarts[0];
    await vi.advanceTimersByTimeAsync(2500);
    s.invalidate();
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      s.api.mock.calls.filter(
        ([path, method]) => isPlaybackPost(path) && method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      s.api.mock.calls.some(
        ([path, method]) =>
          path === "/playback-sessions/session-1" && method === "DELETE",
      ),
    ).toBe(false);
    expect(meterStarts).toEqual([t0]);
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    const posts = s.api.mock.calls.filter(
      ([path, method]) => isPlaybackPost(path) && method === "POST",
    );
    expect(posts).toHaveLength(2);
    expect(posts[1][0]).toBe("/playback-sessions/http-file-continuation");
    expect(posts[1][2].playback_metrics).toEqual(posts[0][2].playback_metrics);
    expect(meterStarts).toEqual([t0]);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(7500);
    expect(s.runtime.sessionId.value).toBe("session-2");
  } finally {
    s.cleanup();
  }
});

it("an identity replacement cannot resume a deferred old file continuation", async () => {
  const s = setup({
    fileFallback: true,
    observationSeq: 0,
    captureErrors: true,
  });
  try {
    await s.prepare();
    s.invalidate();
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(0);
    s.session.user = { id: "different-user" };
    s.session.epoch++;
    await s.runtime.reset();
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      s.api.mock.calls.filter(
        ([path, method]) => isPlaybackPost(path) && method === "POST",
      ),
    ).toHaveLength(1);
    expect(s.runtime.sessionId.value).toBeNull();
    expect(s.el.src).toBe("");
  } finally {
    s.cleanup();
  }
});

it("a newer media intent cancels a claimed file continuation and ignores its late response", async () => {
  const s = setup({
    fileFallback: true,
    observationSeq: 0,
    captureErrors: true,
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = s.api.getMockImplementation()!;
  s.api.mockImplementation(async (path, method, body) => {
    if (path === "/playback-sessions/http-file-continuation") await held;
    return original(path, method, body);
  });
  try {
    await s.prepare();
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(0);
    const old = s.api.mock.calls.find(
      ([path]) => path === "/playback-sessions/http-file-continuation",
    )![2];
    s.state.value.media_id = "other-media";
    s.state.value.media_generation = 2;
    s.runtime.mediaChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runtime.sessionId.value).toBe("session-3");
    expect(
      s.api.mock.calls.some(
        ([path, method]) =>
          path === `/playback-requests/${old.idempotency_key}` &&
          method === "DELETE",
      ),
    ).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runtime.sessionId.value).toBe("session-3");
    const posts = s.api.mock.calls.filter(
      ([path, method]) => isPlaybackPost(path) && method === "POST",
    );
    expect(posts).toHaveLength(3);
    expect(posts[2][2].http_file_fallback).toBeUndefined();
    expect(posts[2][2].media_generation).toBe(2);
    expect(meterStarts).toHaveLength(2);
  } finally {
    release();
    s.cleanup();
  }
});

it("Stop during the file continuation cancels both identities and ignores a late plan", async () => {
  const s = setup({ fileFallback: true, observationSeq: 0 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = s.api.getMockImplementation()!;
  s.api.mockImplementation(async (path, method, body) => {
    if (isPlaybackPost(path) && body?.http_file_fallback) await held;
    return original(path, method, body);
  });
  try {
    await s.prepare();
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(0);
    const body = s.api.mock.calls.find(
      ([path, method, body]) =>
        isPlaybackPost(path) && method === "POST" && body.http_file_fallback,
    )![2];
    await s.runtime.reset();
    expect(
      s.api.mock.calls.some(
        ([path, method]) =>
          path === `/playback-requests/${body.idempotency_key}` &&
          method === "DELETE",
      ),
    ).toBe(true);
    const oldDelete = s.api.mock.calls.findIndex(
      ([path, method]) =>
        path === "/playback-sessions/session-1" && method === "DELETE",
    );
    expect(oldDelete).toBeGreaterThan(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runtime.sessionId.value).toBeNull();
    expect(s.el.src).toBe("");
  } finally {
    release();
    s.cleanup();
  }
});

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
      ([path, method]) => isPlaybackPost(path) && method === "POST",
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

it("generated prefix readiness must still have forward headroom when its delayed response arrives", async () => {
  hls.supported = true;
  const s = setup({ hls: true, rebuild: true, ranges: [[0, 10]] });
  let recovery: Promise<void> | undefined;
  try {
    s.el.canPlayType = () => "";
    await s.prepare();
    s.playing();
    s.state.value.anchor_position_ms = 15000;
    let release!: (value: unknown) => void;
    let reads = 0;
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation((path, method, body) => {
      if (method !== "GET") return original(path, method, body);
      reads++;
      if (reads === 1)
        return new Promise((resolve) => {
          release = resolve;
        });
      return Promise.resolve({
        session_id: "session-1",
        plan_generation: 1,
        status: "ready",
        complete: false,
        available_until_ms: 24000,
      });
    });
    recovery = s.runtime.applyState(true);
    expect(reads).toBe(1);
    // The prefix had 5s lead when requested, but only 2s when returned.
    s.clock.time = 3000;
    release({
      session_id: "session-1",
      plan_generation: 1,
      status: "ready",
      complete: false,
      available_until_ms: 20000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(hls.start).not.toHaveBeenCalled();
    expect(s.runtime.waiting.value).toBe(true);
    expect(s.el.paused).toBe(true);
    s.clock.time = 4000;
    await vi.advanceTimersByTimeAsync(1000);
    await recovery;
    expect(reads).toBe(2);
    expect(hls.start).toHaveBeenCalledExactlyOnceWith(19);
    expect(hls.load).toHaveBeenCalledTimes(1);
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    await s.runtime.reset();
    await recovery?.catch(() => {});
    s.cleanup();
  }
});

it.each([
  {
    name: "complete prefix ahead",
    complete: true,
    until: 20000,
    time: 3000,
    position: 18,
  },
  {
    name: "complete prefix behind",
    complete: true,
    until: 20000,
    time: 8000,
    position: 20,
  },
  {
    name: "legacy unknown prefix",
    complete: undefined,
    until: undefined,
    time: 8000,
    position: 23,
  },
  {
    name: "paused room",
    complete: false,
    until: 16000,
    time: 3000,
    position: 15,
    paused: true,
  },
  {
    name: "target moved behind request",
    complete: false,
    until: 17000,
    time: 0,
    position: 12,
    anchor: 12000,
  },
])("delayed readiness preserves $name semantics", async (input) => {
  hls.supported = true;
  const s = setup({ hls: true, rebuild: true, ranges: [[0, 10]] });
  let recovery: Promise<void> | undefined;
  try {
    s.el.canPlayType = () => "";
    await s.prepare();
    s.playing();
    s.state.value.anchor_position_ms = 15000;
    let release!: (value: unknown) => void;
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation((path, method, body) =>
      method === "GET"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : original(path, method, body),
    );
    recovery = s.runtime.applyState(true);
    s.clock.time = input.time;
    if (input.paused) s.state.value.playback_status = "paused";
    if (input.anchor) s.state.value.anchor_position_ms = input.anchor;
    release({
      session_id: "session-1",
      plan_generation: 1,
      status: "ready",
      complete: input.complete,
      available_until_ms: input.until,
    });
    await recovery;
    expect(hls.start).toHaveBeenCalledExactlyOnceWith(input.position);
    expect(hls.load).toHaveBeenCalledTimes(1);
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    await s.runtime.reset();
    await recovery?.catch(() => {});
    s.cleanup();
  }
});

it("initial preparation also rechecks headroom after a delayed readiness response", async () => {
  hls.supported = true;
  const s = setup({ hls: true, rebuild: true, ranges: [[0, 20]] });
  let preparation: Promise<void> | undefined;
  try {
    s.el.canPlayType = () => "";
    s.playing();
    let release!: (value: unknown) => void;
    let reads = 0;
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation((path, method, body) => {
      if (method !== "GET") return original(path, method, body);
      reads++;
      if (reads === 1)
        return new Promise((resolve) => {
          release = resolve;
        });
      return Promise.resolve({
        session_id: "session-1",
        plan_generation: 1,
        status: "ready",
        complete: false,
        available_until_ms: 20000,
      });
    });
    preparation = s.prepare();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    s.clock.time = 3000;
    release({
      session_id: "session-1",
      plan_generation: 1,
      status: "ready",
      complete: false,
      available_until_ms: 15000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(hls.load).not.toHaveBeenCalled();
    s.clock.time = 4000;
    await vi.advanceTimersByTimeAsync(1000);
    await preparation;
    expect(reads).toBe(2);
    expect(hls.load).toHaveBeenCalledTimes(1);
    expect(playbackPosts(s)).toHaveLength(1);
  } finally {
    await s.runtime.reset();
    await preparation?.catch(() => {});
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
    await expect(recovering).resolves.toBeUndefined();
    expect(s.error.value).toBe("");
    expect(s.runtime.preparation.value.phase).toBe("ready");
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
    s.el.play.mockRejectedValue(
      new DOMException("gesture required", "NotAllowedError"),
    );
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
    s.el.play.mockRejectedValue(
      new DOMException("gesture required", "NotAllowedError"),
    );
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

it("media replacement detaches the previous grant immediately while calibration is pending", async () => {
  const s = setup();
  try {
    await s.prepare();
    s.playing();
    s.invalidate();
    s.state.value = { ...s.state.value, media_id: "next", media_generation: 2 };
    s.runtime.mediaChanged();
    expect(s.el.paused).toBe(true);
    expect(s.el.src).toBe("");
    expect(s.runtime.sessionId.value).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.api).toHaveBeenCalledWith(
      "/playback-sessions/session-1",
      "DELETE",
      undefined,
      expect.any(AbortSignal),
    );
    expect(playbackPosts(s)).toHaveLength(1);
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(playbackPosts(s)).toHaveLength(2);
    expect(playbackPosts(s)[1][2]).toMatchObject({ media_generation: 2 });
    expect(s.error.value).toBe("");
  } finally {
    s.cleanup();
  }
});

it("clearing the current media closes the old session without requiring clock calibration", async () => {
  const s = setup();
  try {
    await s.prepare();
    s.invalidate();
    s.state.value = {
      ...s.state.value,
      media_id: null as any,
      media_generation: 2,
    };
    s.runtime.mediaChanged();
    expect(s.el.src).toBe("");
    expect(s.runtime.sessionId.value).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      s.api.mock.calls.some(
        ([path, method]) =>
          path === "/playback-sessions/session-1" && method === "DELETE",
      ),
    ).toBe(true);
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(playbackPosts(s)).toHaveLength(1);
    expect(s.runtime.preparation.value.phase).toBe("idle");
  } finally {
    s.cleanup();
  }
});
