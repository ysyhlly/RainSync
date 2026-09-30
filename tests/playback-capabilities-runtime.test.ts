import { afterEach, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";
import { createPlaybackRuntime } from "../apps/web/src/features/playback/playback-runtime";

const hls = vi.hoisted(() => ({
  supported: true,
  source: { isTypeSupported: vi.fn(() => true) },
  attached: vi.fn(),
  created: vi.fn(),
  loaded: vi.fn(),
  started: vi.fn(),
  stopped: vi.fn(),
  errorHandler: undefined as ((event: unknown, data: any) => void) | undefined,
}));
vi.mock("hls.js", () => ({
  default: class {
    static Events = { ERROR: "error" };
    static isSupported = () => hls.supported;
    static getMediaSource = () => hls.source;
    constructor() {
      hls.created();
    }
    config = {};
    loadSource(url: string) {
      hls.loaded(url);
    }
    startLoad(position: number) {
      hls.started(position);
    }
    stopLoad() {
      hls.stopped();
    }
    attachMedia(element: unknown) {
      hls.attached(element);
    }
    on(_event: unknown, handler: (event: unknown, data: any) => void) {
      hls.errorHandler = handler;
    }
    destroy() {}
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  hls.errorHandler = undefined;
});

function setup(
  decodingInfo?: ReturnType<typeof vi.fn>,
  candidates?: any,
  observe = false,
) {
  vi.useFakeTimers();
  hls.supported = true;
  vi.stubGlobal("navigator", {
    mediaCapabilities: decodingInfo ? { decodingInfo } : undefined,
  });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: vi.fn(),
  });
  vi.stubGlobal("location", { href: "http://localhost/rooms/room" });
  let grants = 0;
  const api = vi.fn(async (path: string, method: string, body?: any) => {
    if (path === "/playback-candidates") return candidates ?? {};
    const candidate = candidates?.candidates.find(
      (c: any) => !body?.candidate_report?.excluded_candidates?.includes(c.id),
    );
    if (path === "/playback-sessions" && method === "POST")
      return {
        session_id: observe ? `session-${++grants}` : "session",
        ...(observe ? { observation_version: 1, observation_seq: 0 } : {}),
        media_id: "media",
        media_generation: 1,
        delivery_mode: candidate?.delivery_mode ?? "remux",
        transport: candidate?.transport ?? "hls",
        selected_candidate_id: candidate?.id,
        playback_url: "/media-delivery/session/index.m3u8",
        timeline_origin_ms: 0,
        duration_ms: 100000,
        rebuild_on_seek: false,
        audio_tracks: [],
        subtitle_tracks: [],
      };
    return {};
  });
  const session = { user: { id: "user" }, epoch: 1, api };
  const state = ref({
    room_id: "room",
    media_id: "media",
    media_generation: 1,
    playback_status: "paused",
    anchor_position_ms: 5000,
    anchor_server_time_ms: 0,
    playback_rate: 1,
  });
  const scope = effectScope();
  const active = ref(true);
  const runtime = scope.run(() =>
    createPlaybackRuntime({
      session: session as any,
      state: state as any,
      connected: ref(true),
      active,
      clock: { ready: true, now: () => 10000 } as any,
      error: ref(""),
      run: async (action) => action(),
    }),
  )!;
  const element: any = Object.assign(new EventTarget(), {
    canPlayType: () => "maybe",
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn((name) => {
      if (name === "src") element.src = "";
    }),
    getAttribute: (name: string) => (name === "src" ? element.src : null),
    querySelectorAll: () => [],
    src: "",
    error: null,
    buffered: { length: 0 },
    currentTime: 0,
    playbackRate: 1,
    paused: true,
    seeking: false,
    readyState: 4,
  });
  runtime.attach(element);
  return {
    api,
    session,
    state,
    active,
    runtime,
    element,
    cleanup: () => scope.stop(),
    posts: () =>
      api.mock.calls.filter(
        ([path, method]) => path === "/playback-sessions" && method === "POST",
      ),
  };
}

it("submits concrete capabilities using the MSE implementation selected by hls.js", async () => {
  const ctx = setup();
  try {
    await ctx.runtime.loadMedia();
    expect(ctx.posts()).toHaveLength(1);
    const body = (ctx.posts()[0] as any)[2];
    expect(body.capabilities.report.schema_version).toBe(1);
    expect(body.capabilities.report.candidates).toHaveLength(5);
    expect(body.capabilities.mse_h264_aac).toBe(true);
    expect(hls.source.isTypeSupported).toHaveBeenCalled();
    expect(ctx.element.src).toBe("/media-delivery/session/index.m3u8");
    expect(hls.created).not.toHaveBeenCalled();
    // The new report must preserve the existing native decoder → MSE fallback.
    ctx.element.error = { code: 3 };
    ctx.element.onerror();
    expect(hls.created).toHaveBeenCalledTimes(1);
    expect(hls.attached).toHaveBeenCalledWith(ctx.element);
    ctx.element.onerror();
    expect(hls.created).toHaveBeenCalledTimes(1);
    expect(ctx.posts()).toHaveLength(1);
  } finally {
    ctx.cleanup();
  }
});

const exactCandidates = {
  schema_version: 1,
  binding: "source-binding",
  decision_reason: "actual_source",
  candidates: ["direct", "remux", "transcode_720p"].map((id) => ({
    id,
    delivery_mode: id === "transcode_720p" ? "transcode" : id,
    transport: id === "direct" ? "progressive" : "hls",
    content_type: 'video/mp4; codecs="avc1.64001F"',
    video: {
      content_type: 'video/mp4; codecs="avc1.64001F"',
      width: 1280,
      height: 720,
      framerate: 30,
      bitrate: 4000000,
    },
    audio: null,
  })),
};
it("echoes server binding and retries only decoder failures within a three-route bound", async () => {
  const ctx = setup(
    vi.fn().mockResolvedValue({
      supported: true,
      smooth: true,
      powerEfficient: false,
    }),
    exactCandidates,
  );
  try {
    await ctx.runtime.loadMedia();
    expect(ctx.posts()[0][2].candidate_report.binding).toBe("source-binding");
    ctx.element.error = { code: 3 };
    const fail = ctx.element.onerror;
    fail();
    fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.posts()).toHaveLength(2);
    expect(ctx.posts()[1][2].candidate_report.excluded_candidates).toEqual([
      "direct",
    ]);
    ctx.element.error = { code: 3 };
    ctx.element.onerror(); // Native → MSE before another route.
    expect(hls.created).toHaveBeenCalledTimes(1);
    hls.errorHandler?.(undefined, {
      fatal: true,
      type: "networkError",
      response: { code: 401 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.posts()).toHaveLength(2);
    hls.errorHandler?.(undefined, { fatal: true, type: "mediaError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.posts()).toHaveLength(3);
    expect(ctx.posts()[2][2].candidate_report.excluded_candidates).toEqual([
      "direct",
      "remux",
    ]);
    ctx.element.error = { code: 3 };
    ctx.element.onerror();
    hls.errorHandler?.(undefined, { fatal: true, type: "mediaError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.posts()).toHaveLength(3);
  } finally {
    ctx.cleanup();
  }
});

it("an inactive room blocks new discovery and late probe publication", async () => {
  const ctx = setup(
    vi.fn(() => new Promise(() => {})),
    exactCandidates,
  );
  try {
    ctx.active.value = false;
    await ctx.runtime.loadMedia();
    expect(ctx.api).not.toHaveBeenCalled();
    ctx.active.value = true;
    const loading = ctx.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    ctx.active.value = false;
    await ctx.runtime.reset();
    await vi.advanceTimersByTimeAsync(500);
    await loading;
    expect(ctx.posts()).toHaveLength(0);
  } finally {
    ctx.cleanup();
  }
});

it("does not advertise MSE when hls.js cannot use it", async () => {
  const ctx = setup();
  hls.supported = false;
  try {
    await ctx.runtime.loadMedia();
    const body = (ctx.posts()[0] as any)[2];
    expect(body.capabilities.mse_h264_aac).toBe(false);
    expect(
      body.capabilities.report.candidates[0].mse_supported,
    ).toBeUndefined();
    expect(hls.source.isTypeSupported).not.toHaveBeenCalled();
  } finally {
    ctx.cleanup();
  }
});

it("a reset during optional capability detection cannot create a stale session", async () => {
  const decodingInfo = vi.fn(() => new Promise(() => {}));
  const ctx = setup(decodingInfo);
  try {
    const loading = ctx.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    expect(decodingInfo).toHaveBeenCalled();
    await ctx.runtime.reset();
    await vi.advanceTimersByTimeAsync(500);
    await loading;
    expect(ctx.posts()).toHaveLength(0);
    expect(ctx.runtime.waiting.value).toBe(false);
  } finally {
    ctx.cleanup();
  }
});

it("an identity change while probing never submits the old room's playback request", async () => {
  const ctx = setup(vi.fn(() => new Promise(() => {})));
  try {
    const loading = ctx.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    ctx.session.epoch++;
    await vi.advanceTimersByTimeAsync(500);
    await loading;
    expect(ctx.posts()).toHaveLength(0);
  } finally {
    ctx.cleanup();
  }
});

it("decoder fallback commits the old actual final sample before cancelling its key or publishing another grant", async () => {
  const ctx = setup(undefined, exactCandidates, true);
  try {
    await ctx.runtime.loadMedia();
    expect(ctx.posts()[0][2].observation_version).toBe(1);
    ctx.element.currentTime = 12.25;
    ctx.element.paused = false;
    ctx.element.dispatchEvent(new Event("playing"));
    await vi.advanceTimersByTimeAsync(0);
    let release!: () => void;
    const stopped = new Promise<void>((done) => (release = done));
    const original = ctx.api.getMockImplementation()!;
    ctx.api.mockImplementation(async (path, method, body) => {
      if (path === "/playback-sessions/session-1" && method === "DELETE")
        await stopped;
      return original(path, method, body);
    });
    ctx.element.error = { code: 3 };
    ctx.element.onerror();
    await vi.advanceTimersByTimeAsync(0);
    const final = ctx.api.mock.calls.find(
      ([path, method]) =>
        path === "/playback-sessions/session-1" && method === "DELETE",
    );
    expect(final?.[2]).toMatchObject({
      media_time_ms: 12250,
      has_played: true,
      seq: 2,
    });
    expect(ctx.posts()).toHaveLength(1);
    expect(
      ctx.api.mock.calls.some(([path]) =>
        path.startsWith("/playback-requests/"),
      ),
    ).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.posts()).toHaveLength(2);
    const finalIndex = ctx.api.mock.calls.indexOf(final!);
    const cancelIndex = ctx.api.mock.calls.findIndex(([path]) =>
      path.startsWith("/playback-requests/"),
    );
    const nextIndex = ctx.api.mock.calls.indexOf(ctx.posts()[1]);
    expect(cancelIndex).toBeGreaterThan(finalIndex);
    expect(nextIndex).toBeGreaterThan(cancelIndex);
    expect(ctx.posts()[1][2].candidate_report.excluded_candidates).toEqual([
      "direct",
    ]);
  } finally {
    ctx.cleanup();
  }
});

it("native to MSE recovery keeps one observation binding and inactive rooms still capture an owned final Stop", async () => {
  const ctx = setup(undefined, undefined, true);
  try {
    await ctx.runtime.loadMedia();
    ctx.element.currentTime = 7.5;
    ctx.element.paused = false;
    ctx.element.dispatchEvent(new Event("playing"));
    await vi.advanceTimersByTimeAsync(0);
    ctx.element.error = { code: 3 };
    ctx.element.onerror();
    ctx.element.currentTime = 8.25;
    ctx.element.dispatchEvent(new Event("playing"));
    await vi.advanceTimersByTimeAsync(0);
    const observations = () =>
      ctx.api.mock.calls.filter(([path]) => path.endsWith("/observations"));
    expect(observations().map((call) => call[2].seq)).toEqual([1, 2]);
    expect(ctx.posts()).toHaveLength(1);
    ctx.active.value = false;
    ctx.element.dispatchEvent(new Event("pause"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(observations()).toHaveLength(2);
    await ctx.runtime.reset();
    const final = ctx.api.mock.calls.find(
      ([path, method]) =>
        path === "/playback-sessions/session-1" && method === "DELETE",
    );
    expect(final?.[2]).toMatchObject({
      media_time_ms: 8250,
      has_played: true,
      seq: 3,
    });
  } finally {
    ctx.cleanup();
  }
});

it("same-attempt generated growth resumes one Hls without reloading its source", async () => {
  const ctx = setup();
  try {
    ctx.element.canPlayType = (type: string) =>
      type === "application/vnd.apple.mpegurl" ? "" : "maybe";
    let end = 2;
    ctx.element.duration = Infinity;
    ctx.element.seekable = ctx.element.buffered = {
      length: 1,
      start: () => 0,
      end: () => end,
    };
    const original = ctx.api.getMockImplementation()!;
    ctx.api.mockImplementation(async (path, method, body) => {
      if (method === "GET" && path.startsWith("/playback-sessions/"))
        return {
          session_id: "session",
          status: "ready",
          complete: false,
          available_until_ms: 30000,
        };
      const result = await original(path, method, body);
      return path === "/playback-sessions" && method === "POST"
        ? { ...result, rebuild_on_seek: true }
        : result;
    });
    await ctx.runtime.loadMedia();
    for (const position of [5000, 10000, 15000]) {
      ctx.state.value.anchor_position_ms = position;
      await ctx.runtime.applyState(true);
      end = position / 1000 + 4;
      await ctx.runtime.applyState(true);
    }
    expect(ctx.posts()).toHaveLength(1);
    expect(hls.created).toHaveBeenCalledTimes(1);
    expect(hls.loaded).toHaveBeenCalledTimes(1);
    expect(hls.started.mock.calls.map(([position]) => position)).toEqual([
      5, 10, 15,
    ]);
    expect(hls.stopped).not.toHaveBeenCalled();
  } finally {
    ctx.cleanup();
  }
});
