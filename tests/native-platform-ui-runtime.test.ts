import { playbackTestContext } from "./helpers/playback-context";
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
import type { NativePlatformProvider } from "../packages/protocol";
const dashboards = vi.hoisted(() => [] as any[]);
const hlsPlayers = vi.hoisted(() => [] as any[]);
const browserCapabilities = vi.hoisted(() => ({ mse: true }));
const dashPreload = vi.hoisted(() => vi.fn(async () => ({})));
const dashDriverLoad = vi.hoisted(() => ({
  before: undefined as (() => Promise<void>) | undefined,
  calls: 0,
}));
vi.mock("../apps/web/src/features/playback/dash-driver-loader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../apps/web/src/features/playback/dash-driver-loader")>();
  return { loadDashDriver: async () => {
    ++dashDriverLoad.calls;
    await dashDriverLoad.before?.();
    return actual.loadDashDriver();
  } };
});

vi.mock("../packages/player-core/dash/loader", () => ({ loadDashJs: dashPreload }));
vi.mock("../packages/player-core/dash", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  createDashPlayback: (options: any) => {
    const controller = {
      options,
      load: vi.fn(async () => {
        options.onStatus?.({
          status: "loading",
          readyState: options.video.readyState,
        });
        await dashPreload();
        options.onSourceAttached?.();
        options.onStatus?.({
          status: "loading_media",
          readyState: options.video.readyState,
        });
        return true;
      }),
      destroy: vi.fn(),
    };
    dashboards.push(controller);
    return controller;
  },
}));
vi.mock("hls.js", () => ({
  default: class {
    static Events = { ERROR: "error" };
    static getMediaSource = () => ({
      isTypeSupported: () => browserCapabilities.mse,
    });
    static isSupported = () => true;
    handlers = new Map<string, Function>();
    constructor(public config: any) {
      hlsPlayers.push(this);
    }
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    stopLoad = vi.fn();
    startLoad = vi.fn();
    on(event: string, handler: Function) {
      this.handlers.set(event, handler);
    }
  },
}));
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const media: any = {
  id: id(3),
  kind: "native_platform",
  title: "Bili",
  platform: {
    version: 1,
    provider: "bilibili",
    content_id: "BV1xx411c7mD",
    part: 1,
  },
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  dashboards.length = 0;
  hlsPlayers.length = 0;
  dashPreload.mockReset();
  dashPreload.mockResolvedValue({});
  dashDriverLoad.before = undefined;
  dashDriverLoad.calls = 0;
});
function nativePlan(
  body: any,
  provider: NativePlatformProvider = "bilibili",
  selectedTransport?: "dash" | "progressive",
) {
  const transport =
    selectedTransport ??
    (provider === "bilibili" ||
    (provider === "youtube" && body.capabilities.mse_h264_aac)
      ? "dash"
      : "progressive");
  return {
    session_id: id(20 + body.plan_generation),
    media_id: id(3),
    media_generation: 7,
    plan_generation: body.plan_generation,
    delivery_mode: "direct",
    transport,
    playback_url: `/api/v1/platform-delivery/${id(20 + body.plan_generation)}/${transport === "dash" ? "manifest.mpd" : "tracks/progressive"}?token=abcdefghijklmnop`,
    timeline_origin_ms: 0,
    duration_ms: 100000,
    expires_in_seconds: 120,
    rebuild_on_seek: false,
    audio_tracks: [],
    subtitle_tracks: [],
    native_platform: {
      version: 1,
      provider,
      credential_mode: "anonymous",
      refresh_after_seconds: 30,
    },
  };
}
function setup(
  options: {
    lost?: boolean;
    defer?: boolean;
    provider?: NativePlatformProvider;
    deferMedia?: boolean;
    ownAccount?: boolean;
    transport?: "dash" | "progressive";
    mse?: boolean;
    progressive?: boolean;
    quality?: boolean;
    live?: boolean;
    nativeHls?: boolean;
    compatibilityFailure?: boolean;
    metricClock?: boolean;
    metricFrame?: boolean;
    metricsVersion?: 1 | 2 | false;
    badMetricsReceipt?: boolean;
  } = {},
) {
  vi.useFakeTimers(
    options.metricClock
      ? {
          toFake: [
            "setTimeout",
            "clearTimeout",
            "setInterval",
            "clearInterval",
            "performance",
          ],
        }
      : undefined,
  );
  browserCapabilities.mse = options.mse ?? true;
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("location", {
    origin: "https://rain.test",
    href: "https://rain.test/rooms/x",
  });
  const storage = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
  });
  const events: string[] = [],
    bodies: string[] = [];
  let resolve!: (v: any) => void;
  let resolveMedia!: (v: any) => void;
  const provider = options.provider ?? "bilibili";
  const selectedMedia: any = {
    ...media,
    platform: { ...media.platform, provider },
  };
  const live = {
    version: 1,
    broadcast_id: "12:34:1700000000",
    sync_mode: "live_edge_control",
  };
  if (options.live)
    selectedMedia.platform = {
      version: 3,
      provider: "bilibili",
      part: 1,
      content_id: `live:12:${live.broadcast_id}`,
      resource: {
        kind: "bilibili_live",
        room_id: "12",
        uid: "34",
        broadcast_id: live.broadcast_id,
      },
    };
  const api = vi.fn(async (path: string, method: string, body?: any) => {
    if (
      path === "/playback-sessions/native-platform-compatibility" &&
      method === "POST"
    ) {
      events.push("compatibility-post");
      bodies.push(JSON.stringify(body));
      const plan: any = nativePlan(body, provider);
      const pending =
        bodies.filter(
          (value) => JSON.parse(value).idempotency_key === body.idempotency_key,
        ).length === 1;
      Object.assign(plan, {
        transport: pending ? "pending_hls" : "hls",
        delivery_mode: "transcode",
        rebuild_on_seek: true,
        timeline_origin_ms: body.position_ms,
        playback_url: `/api/v1/platform-delivery/${plan.session_id}/compatibility/index.m3u8?token=${"a".repeat(64)}${pending ? "" : "&attempt=7"}`,
        subtitle_mode: "none",
        pending_job_id: pending ? plan.session_id : null,
        seekable_media_ranges_ms: pending
          ? []
          : [{ start_ms: body.position_ms, end_ms: 100000 }],
      });
      plan.native_platform.compatibility = {
        version: 1,
        mode: "hls_avc_aac",
        ...(pending
          ? {}
          : {
              output: {
                attempt: 7,
                complete: false,
                codecs: "avc1.64001F,mp4a.40.2",
                width: 1280,
                height: 720,
              },
            }),
      };
      if (options.quality)
        plan.native_platform.quality = {
          version: 1,
          requested_max_height: "auto",
          selected_height: 1080,
          options: [{ max_height: "p1080", height: 1080 }],
        };
      if (options.metricsVersion && body.playback_metrics)
        Object.assign(plan, {
          playback_metrics_version: options.metricsVersion,
          playback_metrics: {
            ...body.playback_metrics,
            metrics_seq: 0,
            closed: false,
          },
        });
      return plan;
    }
    if (
      path.startsWith("/playback-sessions/") &&
      method === "GET" &&
      bodies.length
    ) {
      if (options.compatibilityFailure)
        throw new Error("NATIVE_PLATFORM_URL_EXPIRED");
      const request = JSON.parse(bodies.at(-1)!);
      return {
        session_id: id(20 + request.plan_generation),
        plan_generation: request.plan_generation,
        status: "ready",
        complete: false,
        available_until_ms: 95000,
      };
    }
    if (path === "/playback-sessions/native-platform" && method === "POST") {
      events.push("native-post");
      bodies.push(JSON.stringify(body));
      if (options.lost && bodies.length === 1) throw TypeError("lost");
      const plan = options.defer
        ? await new Promise<any>((r) => (resolve = r))
        : nativePlan(body, provider, options.transport);
      if (options.live)
        Object.assign(plan, {
          transport: "hls",
          duration_ms: null,
          seekable_media_ranges_ms: [],
          playback_url: `/api/v1/platform-live-delivery/${plan.session_id}/playlist.m3u8?token=${"a".repeat(64)}`,
          native_platform: { ...plan.native_platform, live },
        });
      if (options.quality) {
        Object.assign(plan.native_platform, {
          quality: {
            version: 1,
            requested_max_height:
              body.native_platform.quality?.max_height ?? "auto",
            selected_height:
              body.native_platform.quality?.max_height === "p720" ? 704 : 1080,
            options: [
              { max_height: "p360", height: 360 },
              { max_height: "p720", height: 704 },
              { max_height: "p1080", height: 1080 },
            ],
          },
        });
      }
      if (options.ownAccount)
        plan.native_platform.credential_mode = "own_account";
      if (options.metricsVersion && body.playback_metrics)
        Object.assign(plan, {
          playback_metrics_version: options.metricsVersion,
          playback_metrics: {
            ...body.playback_metrics,
            metrics_seq: 0,
            closed: false,
          },
        });
      return plan;
    }
    if (path.endsWith("/metrics") && method === "POST")
      return {
        session_id: path.split("/")[2],
        meter_start_generation:
          body.meter_start_generation + (options.badMetricsReceipt ? 1 : 0),
        metrics_seq: body.seq,
        closed: body.final,
      };
    if (method === "DELETE") events.push(path);
    return {};
  });
  const session = { user: { id: id(6) }, epoch: 1, api },
    state = ref<any>({
      room_id: id(5),
      media_id: id(3),
      media_generation: 7,
      playback_status: "paused",
      anchor_position_ms: 5000,
      anchor_server_time_ms: 0,
      playback_rate: 1,
      ...(options.live
        ? { live, anchor_position_ms: 0, duration_ms: null }
        : {}),
    }),
    connected = ref(true),
    active = ref(true),
    account = ref(0),
    shortAccounts = ref({ douyin: 0, tiktok: 0 }),
    youtubeAccount = ref(0),
    shortIds = ref({ douyin: id(9), tiktok: id(10) });
  const clock = { ready: true, revision: 1, now: () => 10000 };
  const ended = vi.fn();
  const scope = effectScope();
  const runtime = scope.run(() =>
    createPlaybackRuntime(
      playbackTestContext({
        session: session as any,
        ended,
        state,
        connected,
        active,
        clock: clock as any,
        resolveMedia: async () =>
          options.deferMedia
            ? new Promise((r) => (resolveMedia = r))
            : selectedMedia,
        platformAccountChange: account,
        shortPlatformAccountChanges: shortAccounts,
        shortPlatformAccountIds: options.ownAccount ? shortIds : undefined,
        youtubePlatformAccountChange: youtubeAccount,
        youtubePlatformAccountId: options.ownAccount ? ref(id(11)) : undefined,
      }),
    ),
  )!;
  const error = runtime.playbackError;
  const element: any = Object.assign(new EventTarget(), {
    canPlayType: (type: string) =>
      type.includes("mpegurl") && options.nativeHls !== undefined
        ? options.nativeHls
          ? "probably"
          : ""
        : options.progressive === false
          ? ""
          : "probably",
    pause: vi.fn(),
    play: vi.fn(async () => {}),
    load: vi.fn(),
    removeAttribute: vi.fn((key: string) => {
      if (key === "src") element.src = "";
    }),
    getAttribute: (key: string) => (key === "src" ? element.src || null : null),
    querySelectorAll: () => [],
    src: "",
    error: null,
    buffered: { length: 0 },
    seekable: { length: 0 },
    currentTime: 0,
    playbackRate: 1,
    paused: true,
    seeking: false,
    readyState: 0,
  });
  const frameCallbacks: ((at: number, metadata: any) => void)[] = [];
  const pendingFrames = new Set<number>();
  if (options.metricFrame)
    Object.assign(element, {
      requestVideoFrameCallback: (
        callback: (typeof frameCallbacks)[number],
      ) => {
        frameCallbacks.push(callback);
        pendingFrames.add(frameCallbacks.length);
        return frameCallbacks.length;
      },
      cancelVideoFrameCallback: (id: number) => pendingFrames.delete(id),
    });
  runtime.attach(element);
  return {
    runtime,
    element,
    selectedMedia,
    session,
    state,
    active,
    connected,
    clock,
    account,
    shortAccounts,
    youtubeAccount,
    api,
    error,
    events,
    bodies,
    ended,
    resolve: (value: any) => resolve(value),
    resolveMedia: () => resolveMedia(selectedMedia),
    frame: (presentationTime = performance.now()) => {
      element.paused = false;
      element.readyState = 4;
      for (const frame of [...pendingFrames]) {
        pendingFrames.delete(frame);
        frameCallbacks[frame - 1](performance.now(), { presentationTime });
      }
    },
    frameCallbacks,
    metrics: () =>
      api.mock.calls.filter(
        ([path, method]) => path.endsWith("/metrics") && method === "POST",
      ),
    cleanup: () => scope.stop(),
  };
}
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
it("Bilibili negotiates the existing v2 protocol and sends the same local meter's phases and presented-frame receipt", async () => {
  const f = setup({
    defer: true,
    metricClock: true,
    metricFrame: true,
    metricsVersion: 2,
  });
  try {
    f.state.value.playback_status = "playing";
    const loading = f.runtime.loadMedia();
    await settle();
    const request = JSON.parse(f.bodies[0]);
    expect(request).toMatchObject({
      playback_metrics_version: 1,
      playback_metrics_supported_versions: [1, 2],
      playback_metrics: {
        meter_start_generation: 1,
        startup_origin: "user_intent",
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    f.resolve(nativePlan(request));
    await loading;
    dashboards[0].options.onReady?.();
    expect(f.runtime.startupDiagnostics.value?.first_frame).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    f.frame(1950);
    await vi.advanceTimersByTimeAsync(3000);
    const [path, method, packet] = f.metrics()[0];
    expect(path).toBe(`/playback-sessions/${id(21)}/metrics`);
    expect(method).toBe("POST");
    expect(packet).toMatchObject({
      version: 2,
      plan_generation: 1,
      media_generation: 7,
      meter_start_generation: 1,
      first_frame_plan_generation: 1,
      startup_origin: "user_intent",
      seq: 1,
      startup_phases: {
        preparation_ms: 1000,
        loading_ms: 1000,
        unobserved_ms: 0,
      },
      first_frame: {
        elapsed_ms: 1950,
        confirmed_elapsed_ms: 2000,
        evidence: "video_frame_callback",
      },
    });
    expect(packet.startup_phases).toEqual(
      f.runtime.startupDiagnostics.value!.startup_phases,
    );
    expect(packet.first_frame).toEqual(
      f.runtime.startupDiagnostics.value!.first_frame,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.metrics()[1][2]).toMatchObject({
      seq: 2,
      startup_phases: packet.startup_phases,
      first_frame: packet.first_frame,
    });
  } finally {
    f.cleanup();
  }
});
it("Bilibili compatibility reuses preparation negotiation and sends its actual attached-source meter", async () => {
  const f = setup({
    metricClock: true,
    metricFrame: true,
    metricsVersion: 2,
    mse: false,
    nativeHls: true,
  });
  try {
    f.state.value.playback_status = "playing";
    f.runtime.nativePlaybackMode.value = "compatibility";
    await f.runtime.loadMedia();
    const requests = f.bodies.map((body) => JSON.parse(body));
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[0].native_platform.compatibility).toEqual({
      version: 1,
      mode: "hls_avc_aac",
    });
    expect(
      requests.every(
        (request) =>
          request.playback_metrics_supported_versions?.join() === "1,2",
      ),
    ).toBe(true);
    expect(
      new Set(
        requests.map(
          (request) => request.playback_metrics.meter_start_generation,
        ),
      ),
    ).toEqual(new Set([1]));
    await vi.advanceTimersByTimeAsync(1000);
    f.frame(950);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.metrics()[0][2]).toMatchObject({
      version: 2,
      plan_generation: 1,
      meter_start_generation: 1,
      first_frame_plan_generation: 1,
      startup_phases: { preparation_ms: 0, loading_ms: 1000, unobserved_ms: 0 },
      first_frame: {
        evidence: "video_frame_callback",
        elapsed_ms: 950,
        confirmed_elapsed_ms: 1000,
      },
    });
    expect(f.metrics()[0][2].startup_phases).toEqual(
      f.runtime.startupDiagnostics.value!.startup_phases,
    );
  } finally {
    f.cleanup();
  }
});
it("an older Bilibili response without a grant keeps local startup evidence and sends no metrics", async () => {
  const f = setup({
    metricClock: true,
    metricFrame: true,
    metricsVersion: false,
  });
  try {
    f.state.value.playback_status = "playing";
    await f.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    f.frame(950);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.runtime.startupDiagnostics.value).toMatchObject({
      startup_phases: { preparation_ms: 0, loading_ms: 1000, unobserved_ms: 0 },
      first_frame: { evidence: "video_frame_callback" },
    });
    expect(f.metrics()).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
it("a negotiated v1 Bilibili grant keeps its legacy wire shape while retaining local startup phases", async () => {
  const f = setup({ metricClock: true, metricFrame: true, metricsVersion: 1 });
  try {
    f.state.value.playback_status = "playing";
    await f.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    f.frame(950);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.metrics()[0][2]).toMatchObject({
      version: 1,
      first_frame: { evidence: "video_frame_callback" },
    });
    expect(f.metrics()[0][2]).not.toHaveProperty("startup_phases");
    expect(f.metrics()[0][2]).not.toHaveProperty("first_frame_plan_generation");
    expect(f.runtime.startupDiagnostics.value!.startup_phases.loading_ms).toBe(
      1000,
    );
  } finally {
    f.cleanup();
  }
});
it.each([
  "user",
  "epoch",
  "room",
  "media_generation",
  "media_id",
  "reset",
] as const)(
  "Bilibili %s replacement rejects stale frame/grant evidence before the API sender",
  async (cause) => {
    const f = setup({
      metricClock: true,
      metricFrame: true,
      metricsVersion: 2,
    });
    try {
      f.state.value.playback_status = "playing";
      await f.runtime.loadMedia();
      const staleFrame = f.frameCallbacks[0];
      f.clock.ready = false;
      if (cause === "user") f.session.user = { id: id(7) };
      else if (cause === "epoch") f.session.epoch++;
      else if (cause === "room")
        f.state.value = { ...f.state.value, room_id: id(8) };
      else if (cause === "media_generation")
        f.state.value = { ...f.state.value, media_generation: 8 };
      else if (cause === "media_id")
        f.state.value = { ...f.state.value, media_id: id(8) };
      else await f.runtime.reset();
      const beforeStaleCallback = f.metrics().length;
      if (cause === "reset")
        expect(f.metrics()[0][2]).toMatchObject({ final: true });
      await vi.advanceTimersByTimeAsync(1000);
      staleFrame(performance.now(), { presentationTime: 950 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.metrics()).toHaveLength(beforeStaleCallback);
      if (cause !== "reset") expect(beforeStaleCallback).toBe(0);
    } finally {
      f.cleanup();
    }
  },
);
it("an invalid Bilibili metrics receipt stops optional sending while keeping local playback evidence", async () => {
  const f = setup({
    metricClock: true,
    metricFrame: true,
    metricsVersion: 2,
    badMetricsReceipt: true,
  });
  try {
    f.state.value.playback_status = "playing";
    await f.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    f.frame(950);
    await vi.advanceTimersByTimeAsync(9000);
    expect(f.metrics()).toHaveLength(1);
    expect(f.runtime.startupDiagnostics.value?.first_frame?.evidence).toBe(
      "video_frame_callback",
    );
    expect(f.runtime.preparation.value.phase).toBe("ready");
  } finally {
    f.cleanup();
  }
});
it("downloads the DASH library during Bilibili server preparation without mounting a player", async () => {
  const f = setup({ defer: true });
  try {
    const loading = f.runtime.loadMedia();
    await settle();
    expect(f.events).toContain("native-post");
    expect(dashPreload).toHaveBeenCalledOnce();
    expect(dashboards).toHaveLength(0);
    expect(f.runtime.loadingStage.value).toBe("preparing");
    f.resolve(nativePlan(JSON.parse(f.bodies[0])));
    await loading;
    expect(dashboards).toHaveLength(1);
    expect(f.runtime.loadingStage.value).toBe("loading_media");
  } finally {
    f.cleanup();
  }
});
it.each([
  { provider: "douyin" as const },
  {
    provider: "youtube" as const,
    mse: false,
    transport: "progressive" as const,
  },
  { mse: false, nativeHls: true },
  { live: true, nativeHls: true },
])("does not preload DASH for a non-DASH native branch %j", async (options) => {
  const f = setup(options);
  try {
    await f.runtime.loadMedia();
    expect(dashPreload).not.toHaveBeenCalled();
    expect(dashboards).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
it("a rejected background preload remains retryable and never replaces the playback error", async () => {
  dashPreload.mockRejectedValueOnce(
    new Error("SDK chunk temporarily unavailable"),
  );
  const f = setup();
  try {
    await f.runtime.loadMedia();
    expect(dashPreload).toHaveBeenCalledTimes(2);
    expect(f.runtime.preparation.value.phase).toBe("ready");
    expect(f.error.value).toBe("");
  } finally {
    f.cleanup();
  }
});
it.each(["reset", "identity", "media", "account"])(
  "late SDK resolution cannot revive a retired %s attachment",
  async (cause) => {
    let release!: (value: {}) => void;
    const pending = new Promise<{}>((resolve) => {
      release = resolve;
    });
    dashPreload.mockReturnValue(pending);
    const f = setup();
    try {
      const loading = f.runtime.loadMedia();
      await settle();
      expect(f.runtime.loadingStage.value).toBe("initializing");
      if (cause === "reset") await f.runtime.reset();
      else if (cause === "identity") f.session.epoch++;
      else if (cause === "media")
        f.state.value = { ...f.state.value, media_generation: 8 };
      else {
        f.clock.ready = false;
        f.account.value++;
      }
      const stage = f.runtime.loadingStage.value;
      release({});
      await loading;
      expect(f.runtime.loadingStage.value).toBe(stage);
      expect(f.runtime.startupDiagnostics.value).toBeUndefined();
      if (cause === "reset") expect(f.runtime.sessionId.value).toBeNull();
    } finally {
      release({});
      f.cleanup();
    }
  },
);
it("DASH readiness is not presentation and a late same-source frame clears only its timeout", async () => {
  const f = setup({ metricClock: true });
  try {
    f.state.value.playback_status = "playing";
    await f.runtime.loadMedia();
    f.element.readyState = 4;
    f.element.dispatchEvent(new Event("loadeddata"));
    dashboards[0].options.onStatus({ status: "ready", readyState: 4 });
    expect(f.runtime.loadingStage.value).toBe("waiting_frame");
    expect(f.runtime.startupDiagnostics.value?.first_frame).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "FIRST_FRAME_TIMEOUT",
    );
    expect(f.error.value).toContain("播放首帧等待超时");
    expect(f.runtime.loadingStage.value).toBe("failed");
    f.element.paused = false;
    f.element.dispatchEvent(new Event("playing"));
    f.element.currentTime = 0.1;
    f.element.dispatchEvent(new Event("timeupdate"));
    expect(f.runtime.preparation.value.phase).toBe("ready");
    expect(f.error.value).toBe("");
    expect(f.runtime.loadingStage.value).toBe("playing");
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.runtime.startupDiagnostics.value?.first_frame?.evidence).toBe(
      "playing_time_advance",
    );
    expect(
      f.runtime.startupDiagnostics.value?.startup_phases.loading_ms,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(f.runtime.startupDiagnostics.value)).not.toContain(
      "token",
    );
  } finally {
    f.cleanup();
  }
});
it("a real media failure after startup timeout remains terminal despite late progress", async () => {
  const f = setup({ metricClock: true });
  try {
    f.state.value.playback_status = "playing";
    await f.runtime.loadMedia();
    f.element.readyState = 4;
    f.element.dispatchEvent(new Event("loadeddata"));
    await vi.advanceTimersByTimeAsync(20_000);
    dashboards[0].options.onError({
      message: "媒体加载失败",
      code: "DASH_PLAYBACK_ERROR",
    });
    f.element.paused = false;
    f.element.dispatchEvent(new Event("playing"));
    f.element.currentTime = 1;
    f.element.dispatchEvent(new Event("timeupdate"));
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "DASH_PLAYBACK_ERROR",
    );
    expect(f.error.value).toBe("媒体加载失败");
    expect(f.runtime.loadingStage.value).toBe("failed");
  } finally {
    f.cleanup();
  }
});
it("late presentation clears the first-frame timeout while preserving another notice", async () => {
  const f = setup({ metricClock: true });
  try {
    f.state.value.playback_status = "playing";
    await f.runtime.loadMedia();
    f.element.readyState = 4;
    f.element.dispatchEvent(new Event("loadeddata"));
    await vi.advanceTimersByTimeAsync(20_000);
    f.error.value = "另一个房间操作失败";
    f.element.paused = false;
    f.element.dispatchEvent(new Event("playing"));
    f.element.currentTime = 1;
    f.element.dispatchEvent(new Event("timeupdate"));
    expect(f.runtime.preparation.value.failure).toBeUndefined();
    expect(f.error.value).toBe("另一个房间操作失败");
  } finally {
    f.cleanup();
  }
});
it("a presented frame cannot leave local synchronization waiting indefinitely", async () => {
  const f = setup({ metricClock: true });
  try {
    await f.runtime.loadMedia();
    f.element.readyState = 4;
    f.element.dispatchEvent(new Event("loadeddata"));
    f.element.paused = false;
    f.element.dispatchEvent(new Event("playing"));
    f.element.currentTime = 1;
    f.element.dispatchEvent(new Event("timeupdate"));
    expect(f.runtime.loadingStage.value).toBe("playing");
    await vi.advanceTimersByTimeAsync(20_500);
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "PLAYBACK_RECOVERY_TIMEOUT",
    );
    expect(f.runtime.recoveryState.value).toBe("failed");
    expect(f.state.value.playback_status).toBe("paused");
  } finally {
    f.cleanup();
  }
});
it("confirmed convergence retires only the local synchronization timeout", async () => {
  const f = setup({ metricClock: true });
  try {
    await f.runtime.loadMedia();
    f.element.readyState = 4;
    f.element.dispatchEvent(new Event("loadeddata"));
    f.element.paused = false;
    f.element.dispatchEvent(new Event("playing"));
    f.element.currentTime = 1;
    f.element.dispatchEvent(new Event("timeupdate"));
    await vi.advanceTimersByTimeAsync(20_500);
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "PLAYBACK_RECOVERY_TIMEOUT",
    );
    const ranges = { length: 1, start: () => 0, end: () => 100 };
    f.element.seekable = f.element.buffered = ranges;
    f.element.paused = true;
    f.element.currentTime = 5;
    await f.runtime.applyState(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.runtime.recoveryState.value).toBe("idle");
    expect(f.runtime.preparation.value.failure).toBeUndefined();
    expect(f.runtime.loadingStage.value).toBe("playing");
    expect(f.error.value).toBe("");
  } finally {
    f.cleanup();
  }
});
it("HLS-only Bilibili browser uses the dedicated pending compatibility route and actual attempt", async () => {
  const f = setup({ mse: false, nativeHls: true, quality: true });
  try {
    await f.runtime.loadMedia();
    expect(f.events.filter((event) => event.endsWith("post"))).toEqual([
      "compatibility-post",
      "compatibility-post",
    ]);
    expect(f.bodies[0]).toBe(f.bodies[1]);
    expect(dashboards).toHaveLength(0);
    expect(f.element.src).toContain("/compatibility/index.m3u8?");
    expect(f.element.src).toContain("&attempt=7");
    expect(f.runtime.nativeQualitySelectedHeight.value).toBe(1080);
    expect(f.runtime.nativeEncodedHeight.value).toBe(720);
    expect(f.runtime.playbackSummary.value?.mode).toContain("兼容转码");
  } finally {
    f.cleanup();
  }
});
it("a progressive transport gap falls back through HLS with exact resource fencing", async () => {
  const f = setup({
    provider: "douyin",
    mse: true,
    progressive: false,
    nativeHls: false,
  });
  try {
    await f.runtime.loadMedia();
    expect(f.events.filter((event) => event.endsWith("post"))).toEqual([
      "compatibility-post",
      "compatibility-post",
    ]);
    expect(hlsPlayers).toHaveLength(1);
    const hls = hlsPlayers[0],
      url = hls.loadSource.mock.calls[0][0];
    expect(url).toContain("&attempt=7");
    expect(() => hls.config.xhrSetup({}, url)).not.toThrow();
    expect(() =>
      hls.config.xhrSetup({}, url.replace("attempt=7", "attempt=1")),
    ).toThrow();
    expect(f.element.src).toBe("");
  } finally {
    f.cleanup();
  }
});
it("explicit compatibility survives a decode failure without native restart or query mutation", async () => {
  const f = setup({ provider: "youtube", mse: true, nativeHls: false });
  try {
    f.runtime.nativePlaybackMode.value = "compatibility";
    await f.runtime.loadMedia();
    const hls = hlsPlayers[0];
    hls.handlers.get("error")!(null, {
      fatal: true,
      type: "mediaError",
      details: "decode-failed",
    });
    await settle();
    expect(f.runtime.nativePlaybackMode.value).toBe("compatibility");
    expect(f.runtime.preparation.value.phase).toBe("failed");
    expect(f.bodies).toHaveLength(2);
    expect(dashboards).toHaveLength(0);
    expect(hls.loadSource).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31000);
    expect(f.bodies).toHaveLength(2);
  } finally {
    f.cleanup();
  }
});
it("revoked compatibility input fails before any HLS or native decoder attachment", async () => {
  const f = setup({ mse: false, nativeHls: true, compatibilityFailure: true });
  try {
    await expect(f.runtime.loadMedia()).rejects.toThrow(
      "NATIVE_PLATFORM_URL_EXPIRED",
    );
    expect(f.bodies).toHaveLength(1);
    expect(f.runtime.preparation.value.phase).toBe("failed");
    expect(f.element.src).toBe("");
    expect(hlsPlayers).toHaveLength(0);
    expect(dashboards).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
it("compatibility seek rebuilds preserve mode and original-media time with a fresh viewer generation", async () => {
  const f = setup({ mse: false, nativeHls: true });
  try {
    f.runtime.nativePlaybackMode.value = "compatibility";
    await f.runtime.loadMedia();
    f.element.readyState = 1;
    f.state.value.anchor_position_ms = 2000;
    await f.runtime.applyState(true, true);
    expect(f.bodies).toHaveLength(4);
    const old = JSON.parse(f.bodies[0]),
      current = JSON.parse(f.bodies[2]);
    expect(current.native_platform.compatibility).toEqual(
      old.native_platform.compatibility,
    );
    expect(current.position_ms).toBe(2000);
    expect(current.plan_generation).toBe(old.plan_generation + 1);
    expect(f.element.src).toContain("&attempt=7");
    expect(dashboards).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
it("finite compatibility preference cannot enter or block a subsequent Live source", async () => {
  const f = setup({ live: true, nativeHls: true });
  try {
    f.runtime.nativePlaybackMode.value = "compatibility";
    await f.runtime.loadMedia();
    const body = JSON.parse(f.bodies[0]);
    expect(body.native_platform.live_version).toBe(1);
    expect(body.native_platform.compatibility).toBeUndefined();
    expect(f.events).toContain("native-post");
    expect(f.events).not.toContain("compatibility-post");
  } finally {
    f.cleanup();
  }
});
it.each(["bilibili", "youtube"] as const)(
  "%s manual quality retires the old decoder and uses a new target-bound generation",
  async (provider) => {
    const f = setup({ provider, quality: true });
    try {
      await f.runtime.loadMedia();
      expect(f.runtime.nativeQualitySelectedHeight.value).toBe(1080);
      expect(f.runtime.nativeQualityOptions.value[1].height).toBe(704);
      const first = JSON.parse(f.bodies[0]);
      await f.runtime.selectNativeQuality("p2160");
      expect(f.bodies).toHaveLength(1);
      await f.runtime.selectNativeQuality("p720");
      const second = JSON.parse(f.bodies[1]);
      expect(second.native_platform.quality).toEqual({
        version: 1,
        provider,
        media_id: id(3),
        max_height: "p720",
      });
      expect(second.plan_generation).toBeGreaterThan(first.plan_generation);
      expect(second.viewer_id).toBe(first.viewer_id);
      expect(second.position_ms).toBe(first.position_ms);
      expect(dashboards[0].destroy).toHaveBeenCalled();
      expect(f.runtime.nativeQualitySelectedHeight.value).toBe(704);
      await f.runtime.selectNativeQuality("p720");
      expect(f.bodies).toHaveLength(2);
      await f.runtime.selectNativeQuality("auto");
      expect(JSON.parse(f.bodies[2]).native_platform.quality).toBeUndefined();
      expect(f.runtime.nativeQualityMaxHeight.value).toBe("auto");
    } finally {
      f.cleanup();
    }
  },
);
it("quality selection and options reset across identity, media and credential boundaries", async () => {
  const f = setup({ quality: true });
  try {
    await f.runtime.loadMedia();
    await f.runtime.selectNativeQuality("p720");
    f.session.epoch = 2;
    // The mocked session object is not reactive, so reload checks the exact
    // scope independently instead of depending only on the Vue watcher.
    await f.runtime.loadMedia();
    expect(
      JSON.parse(f.bodies.at(-1)!).native_platform.quality,
    ).toBeUndefined();
    await f.runtime.selectNativeQuality("p720");
    f.state.value = { ...f.state.value, media_generation: 8 };
    expect(f.runtime.nativeQualityMaxHeight.value).toBe("auto");
    expect(f.runtime.nativeQualityOptions.value).toEqual([]);
    await f.runtime.selectNativeQuality("p720");
    expect(f.bodies).toHaveLength(4);
  } finally {
    f.cleanup();
  }
});
it.each(["bilibili", "youtube"] as const)(
  "%s uses only dedicated native route and same element, without claiming SDK ready is a first frame",
  async (provider) => {
    const f = setup({ provider });
    try {
      await f.runtime.loadMedia();
      expect(dashboards).toHaveLength(1);
      expect(dashboards[0].options.video).toBe(f.element);
      expect(f.runtime.waiting.value).toBe(true);
      expect(f.element.play).not.toHaveBeenCalled();
      const body = JSON.parse(f.bodies[0]);
      expect(body.native_platform).toEqual({
        version: 1,
        credential_mode: "own_or_anonymous",
      });
      expect(body.capabilities.mse_h264_aac).toBe(true);
      for (const field of [
        "candidate_report",
        "http_file_fallback_version",
        "static_hls_fallback_version",
        "upstream_profile_report",
      ])
        expect(body).not.toHaveProperty(field);
      if (provider === "bilibili")
        expect(body).toMatchObject({
          playback_metrics_version: 1,
          playback_metrics_supported_versions: [1, 2],
          playback_metrics: {
            meter_start_generation: body.plan_generation,
            startup_origin: "user_intent",
          },
        });
      else expect(body).not.toHaveProperty("playback_metrics_version");
      expect(f.api.mock.calls.some(([p]) => p === "/playback-candidates")).toBe(
        false,
      );
      expect(f.runtime.tracks.value).toEqual([]);
      expect(f.runtime.subtitles.value).toEqual([]);
      await f.runtime.reset();
      expect(dashboards[0].destroy).toHaveBeenCalledTimes(1);
    } finally {
      f.cleanup();
    }
  },
);
it.each(["bilibili", "youtube"] as const)(
  "%s refresh retires old DASH before next request with newer generation and current position",
  async (provider) => {
    const f = setup({ provider });
    try {
      await f.runtime.loadMedia();
      f.state.value.anchor_position_ms = 13000;
      await vi.advanceTimersByTimeAsync(30000);
      await settle();
      expect(f.bodies).toHaveLength(2);
      expect(JSON.parse(f.bodies[1])).toMatchObject({
        plan_generation: 2,
        position_ms: 13000,
      });
      expect(dashboards[0].destroy).toHaveBeenCalledTimes(1);
      expect(dashboards[0].options.current()).toBe(false);
      expect(f.events.indexOf(`/playback-sessions/${id(21)}`)).toBeLessThan(
        f.events.lastIndexOf("native-post"),
      );
      expect(
        f.api.mock.calls.some(
          ([p, m]) => p === `/playback-sessions/${id(21)}` && m === "POST",
        ),
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  },
);
it("account revision and source changes fence callbacks and destroy while clock is unusable", async () => {
  const f = setup();
  try {
    await f.runtime.loadMedia();
    f.clock.ready = false;
    f.account.value++;
    expect(dashboards[0].destroy).toHaveBeenCalledTimes(1);
    expect(dashboards[0].options.current()).toBe(false);
    dashboards[0].options.onError({ message: "stale", code: "old" });
    expect(f.error.value).not.toBe("stale");
    await f.runtime.reset();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.bodies).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
it.each(["bilibili", "youtube"] as const)(
  "%s lost native POST retries exactly the same body/key despite room seek",
  async (provider) => {
    const f = setup({ lost: true, provider });
    try {
      const loading = f.runtime.loadMedia();
      await settle();
      expect(f.bodies).toHaveLength(1);
      f.state.value.anchor_position_ms = 99000;
      await vi.advanceTimersByTimeAsync(1000);
      await loading;
      expect(f.bodies).toHaveLength(2);
      expect(f.bodies[1]).toBe(f.bodies[0]);
    } finally {
      f.cleanup();
    }
  },
);
it.each(["douyin", "tiktok", "youtube"] as NativePlatformProvider[])(
  "%s uses anonymous native progressive on the same video and ignores Bilibili account changes",
  async (provider) => {
    const f = setup({ provider, transport: "progressive" });
    try {
      f.runtime.nativeCredentialMode.value = "anonymous";
      await f.runtime.loadMedia();
      expect(dashboards).toHaveLength(0);
      expect(f.runtime.nativeProvider.value).toBe(provider);
      const body = JSON.parse(f.bodies[0]);
      expect(body.native_platform).toEqual({
        version: 1,
        credential_mode: "anonymous",
      });
      expect(body.capabilities).toEqual({
        progressive_h264_aac: true,
        native_hls: false,
        mse_h264_aac: provider === "youtube",
      });
      expect(f.element.src).toBe(
        nativePlan(body, provider, "progressive").playback_url,
      );
      expect(f.runtime.waiting.value).toBe(true);
      expect(f.element.play).not.toHaveBeenCalled();
      expect(f.runtime.tracks.value).toEqual([]);
      expect(f.runtime.subtitles.value).toEqual([]);
      const source = f.element.src;
      const pauseCount = f.element.pause.mock.calls.length;
      f.account.value++;
      await settle();
      expect(f.bodies).toHaveLength(1);
      expect(f.element.src).toBe(source);
      expect(f.element.pause).toHaveBeenCalledTimes(pauseCount);
      f.element.onloadedmetadata();
      expect(f.runtime.duration.value).toBe(100);
      expect(
        f.api.mock.calls.some(
          ([p]) => p === "/playback-candidates" || p === "/playback-sessions",
        ),
      ).toBe(false);
      await f.runtime.reset();
      expect(f.element.src).toBe("");
      expect(f.runtime.nativeProvider.value).toBeUndefined();
    } finally {
      f.cleanup();
    }
  },
);
it("progressive refresh retires the old grant, uses a new generation and current room position", async () => {
  const f = setup({ provider: "douyin" });
  try {
    await f.runtime.loadMedia();
    const previousError = f.element.onerror;
    f.element.readyState = 2;
    f.element.onloadeddata();
    f.state.value.anchor_position_ms = 13000;
    await vi.advanceTimersByTimeAsync(30000);
    await settle();
    expect(f.bodies).toHaveLength(2);
    expect(JSON.parse(f.bodies[1])).toMatchObject({
      plan_generation: 2,
      position_ms: 13000,
    });
    expect(f.element.src).toBe(
      nativePlan(JSON.parse(f.bodies[1]), "douyin").playback_url,
    );
    expect(f.events.indexOf(`/playback-sessions/${id(21)}`)).toBeLessThan(
      f.events.lastIndexOf("native-post"),
    );
    f.element.error = { code: 3 };
    previousError();
    expect(f.error.value).toBe("");
    expect(
      f.api.mock.calls.some(
        ([p, m]) => p === `/playback-sessions/${id(21)}` && m === "POST",
      ),
    ).toBe(false);
  } finally {
    f.cleanup();
  }
});
it("native progressive decode failure does not invoke generic decoder or Worker fallback", async () => {
  const f = setup({ provider: "tiktok" });
  try {
    await f.runtime.loadMedia();
    const source = f.element.src;
    f.element.error = { code: 3 };
    f.element.onerror();
    await settle();
    expect(f.error.value).toContain("浏览器无法播放");
    expect(f.error.value).not.toContain("转码");
    expect(f.runtime.preparation.value.phase).toBe("failed");
    expect(f.element.src).toBe(source);
    expect(f.bodies).toHaveLength(1);
    expect(
      f.api.mock.calls.some(
        ([p]) => p === "/playback-sessions/http-file-continuation",
      ),
    ).toBe(false);
  } finally {
    f.cleanup();
  }
});
it("progressive source change tears down synchronously while clock is unusable and fences old callbacks", async () => {
  const f = setup({ provider: "youtube", transport: "progressive" });
  try {
    await f.runtime.loadMedia();
    const oldMetadata = f.element.onloadedmetadata;
    const oldError = f.element.onerror;
    f.clock.ready = false;
    f.state.value.media_id = id(8);
    f.state.value.media_generation++;
    f.runtime.mediaChanged();
    expect(f.element.src).toBe("");
    expect(f.element.onerror).toBeNull();
    f.element.error = { code: 3 };
    oldError();
    oldMetadata();
    expect(f.error.value).toBe("");
    expect(f.runtime.duration.value).toBe(0);
    await f.runtime.reset();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.bodies).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
it("Bilibili revision does not cancel another provider while its media metadata is still pending", async () => {
  const f = setup({ provider: "douyin", deferMedia: true });
  try {
    f.runtime.nativeCredentialMode.value = "anonymous";
    const loading = f.runtime.loadMedia();
    await settle();
    f.account.value++;
    f.resolveMedia();
    await loading;
    expect(f.bodies).toHaveLength(1);
    expect(f.element.src).toContain("/tracks/progressive?");
    expect(JSON.parse(f.bodies[0]).native_platform.credential_mode).toBe(
      "anonymous",
    );
  } finally {
    f.cleanup();
  }
});
it("a wrong-provider native response cannot attach to the current room video", async () => {
  const f = setup({ provider: "youtube", defer: true });
  try {
    const loading = f.runtime.loadMedia();
    await settle();
    f.resolve(nativePlan(JSON.parse(f.bodies[0]), "douyin"));
    await expect(loading).rejects.toThrow();
    expect(f.element.src).toBe("");
    expect(dashboards).toHaveLength(0);
    expect(f.runtime.preparation.value.phase).toBe("failed");
  } finally {
    f.cleanup();
  }
});
it.each([
  { mse: true, progressive: true, transport: "dash" },
  { mse: true, progressive: false, transport: "dash" },
  { mse: false, progressive: true, transport: "progressive" },
] as const)(
  "YouTube reports actual MSE=$mse and progressive=$progressive support",
  async ({ mse, progressive, transport }) => {
    const f = setup({ provider: "youtube", mse, progressive });
    try {
      await f.runtime.loadMedia();
      const body = JSON.parse(f.bodies[0]);
      expect(body.capabilities).toEqual({
        progressive_h264_aac: progressive,
        native_hls: false,
        mse_h264_aac: mse,
      });
      expect(body.native_platform).toEqual({
        version: 1,
        credential_mode: "own_or_anonymous",
      });
      expect(f.runtime.playbackSummary.value?.mode).toBe("YouTube 原生播放");
      expect(dashboards).toHaveLength(transport === "dash" ? 1 : 0);
      if (transport === "dash")
        expect(dashboards[0].options.playbackUrl).toBe(
          nativePlan(body, "youtube").playback_url,
        );
      else expect(f.element.src).toBe(nativePlan(body, "youtube").playback_url);
    } finally {
      f.cleanup();
    }
  },
);
it.each([
  { mse: false, progressive: true, transport: "dash" },
  { mse: true, progressive: false, transport: "progressive" },
  { mse: false, progressive: false, transport: "progressive" },
] as const)(
  "YouTube rejects selected $transport when its capability was not reported",
  async ({ mse, progressive, transport }) => {
    const f = setup({ provider: "youtube", mse, progressive, transport });
    try {
      await expect(f.runtime.loadMedia()).rejects.toThrow();
      expect(dashboards).toHaveLength(0);
      expect(f.element.src).toBe("");
      expect(f.bodies).toHaveLength(1);
      expect(f.runtime.preparation.value.phase).toBe("failed");
      expect(
        f.api.mock.calls.some(
          ([path]) =>
            path === "/playback-sessions" ||
            path === "/playback-sessions/http-file-continuation",
        ),
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  },
);
it.each([
  [
    "progressive route with DASH transport",
    (p: any) => ({
      ...p,
      playback_url: p.playback_url.replace(
        "manifest.mpd",
        "tracks/progressive",
      ),
    }),
  ],
  [
    "manifest route with progressive transport",
    (p: any) => ({ ...p, transport: "progressive" }),
  ],
  [
    "other session manifest",
    (p: any) => ({
      ...p,
      playback_url: p.playback_url.replace(p.session_id, id(99)),
    }),
  ],
  [
    "upstream manifest",
    (p: any) => ({ ...p, playback_url: "https://youtube.com/manifest.mpd" }),
  ],
  ["HLS transport", (p: any) => ({ ...p, transport: "hls" })],
  [
    "saved account binding",
    (p: any) => ({
      ...p,
      native_platform: { ...p.native_platform, credential_mode: "own_account" },
    }),
  ],
] as const)(
  "YouTube fails closed for %s without decoder or progressive fallback",
  async (_name, change) => {
    const f = setup({ provider: "youtube", defer: true });
    try {
      if (_name === "saved account binding")
        f.runtime.nativeCredentialMode.value = "anonymous";
      const loading = f.runtime.loadMedia();
      await settle();
      f.resolve(change(nativePlan(JSON.parse(f.bodies[0]), "youtube")));
      await expect(loading).rejects.toThrow();
      expect(dashboards).toHaveLength(0);
      expect(f.element.src).toBe("");
      expect(f.bodies).toHaveLength(1);
      expect(f.runtime.preparation.value.phase).toBe("failed");
      expect(
        f.api.mock.calls.some(
          ([path]) =>
            path === "/playback-sessions" ||
            path === "/playback-candidates" ||
            path === "/playback-sessions/http-file-continuation",
        ),
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  },
);
it("YouTube DASH ignores every saved-account revision and fences old callbacks on source change", async () => {
  const f = setup({ provider: "youtube" });
  try {
    await f.runtime.loadMedia();
    const old = dashboards[0];
    f.account.value++;
    f.shortAccounts.value = { douyin: 1, tiktok: 1 };
    await settle();
    expect(f.bodies).toHaveLength(1);
    expect(old.destroy).not.toHaveBeenCalled();
    expect(old.options.current()).toBe(true);
    f.clock.ready = false;
    f.state.value.media_id = id(8);
    f.state.value.media_generation++;
    f.runtime.mediaChanged();
    expect(old.destroy).toHaveBeenCalledTimes(1);
    expect(old.options.current()).toBe(false);
    old.options.onError({
      message: "stale YouTube failure",
      code: "DASH_PLAYBACK_ERROR",
    });
    expect(f.error.value).toBe("");
    await f.runtime.reset();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.bodies).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
it("a late YouTube DASH response cannot attach after reset", async () => {
  const f = setup({ provider: "youtube", defer: true });
  try {
    const loading = f.runtime.loadMedia();
    await settle();
    const body = JSON.parse(f.bodies[0]);
    await f.runtime.reset();
    f.resolve(nativePlan(body, "youtube"));
    await loading;
    expect(dashboards).toHaveLength(0);
    expect(f.element.src).toBe("");
    expect(f.runtime.sessionId.value).toBeNull();
    expect(f.runtime.preparation.value.phase).toBe("idle");
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.bodies).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
it("YouTube DASH preserves room-owned seek, pause, play and rate on the same element", async () => {
  const f = setup({ provider: "youtube" });
  try {
    await f.runtime.loadMedia();
    f.element.readyState = 2;
    f.element.seekable = { length: 1, start: () => 0, end: () => 100 };
    f.element.pause.mockImplementation(() => {
      f.element.paused = true;
    });
    f.element.play.mockImplementation(async () => {
      f.element.paused = false;
    });
    f.state.value.anchor_position_ms = 23000;
    f.state.value.playback_rate = 1.5;
    await f.runtime.applyState(true, true);
    expect(f.element.currentTime).toBe(23);
    expect(f.element.playbackRate).toBe(1.5);
    expect(f.element.paused).toBe(true);
    f.state.value.anchor_server_time_ms = f.clock.now();
    f.state.value.playback_status = "playing";
    await f.runtime.applyState(true);
    expect(f.element.play).toHaveBeenCalledTimes(1);
    expect(f.element.paused).toBe(false);
    f.state.value.anchor_position_ms = 37000;
    f.state.value.playback_status = "paused";
    await f.runtime.applyState(true, true);
    expect(f.element.currentTime).toBe(37);
    expect(f.element.paused).toBe(true);
    expect(f.bodies).toHaveLength(1);
    expect(dashboards).toHaveLength(1);
    expect(dashboards[0].options.video).toBe(f.element);
    expect(dashboards[0].destroy).not.toHaveBeenCalled();
    expect(f.api.mock.calls.some(([path]) => path.includes("/control"))).toBe(
      false,
    );
  } finally {
    f.cleanup();
  }
});
it("YouTube DASH decode failure stays on the dedicated session without generic fallback", async () => {
  const f = setup({ provider: "youtube" });
  try {
    await f.runtime.loadMedia();
    dashboards[0].options.onError({
      message: "DASH 媒体加载或解码失败，请重新加载",
      code: "DASH_PLAYBACK_ERROR",
    });
    await settle();
    expect(f.error.value).toContain("DASH 媒体加载或解码失败");
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "DASH_PLAYBACK_ERROR",
    );
    expect(f.runtime.waiting.value).toBe(false);
    expect(f.bodies).toHaveLength(1);
    expect(f.element.src).toBe("");
    expect(
      f.api.mock.calls.some(
        ([path]) =>
          path === "/playback-sessions" ||
          path === "/playback-sessions/http-file-continuation",
      ),
    ).toBe(false);
  } finally {
    f.cleanup();
  }
});
it.each(["bilibili", "youtube"] as const)(
  "%s DASH failure is not replaced by a later media or first-frame deadline",
  async (provider) => {
    const f = setup({ provider });
    try {
      f.state.value.playback_status = "playing";
      await f.runtime.loadMedia();
      dashboards[0].options.onError({
        message: "DASH 媒体加载或解码失败，请重新加载",
        code: "DASH_PLAYBACK_ERROR",
      });
      await vi.advanceTimersByTimeAsync(21000);
      expect(f.runtime.preparation.value.failure?.code).toBe(
        "DASH_PLAYBACK_ERROR",
      );
      expect(f.error.value).toBe("DASH 媒体加载或解码失败，请重新加载");
      expect(f.runtime.waiting.value).toBe(false);
      expect(f.bodies).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  },
);
it.each(["douyin", "tiktok"] as const)(
  "%s own-session replacement retires progressive callbacks immediately and ignores the other platform",
  async (provider) => {
    const f = setup({ provider, ownAccount: true });
    try {
      await f.runtime.loadMedia();
      expect(JSON.parse(f.bodies[0]).native_platform).toEqual({
        version: 1,
        credential_mode: "own_or_anonymous",
        account_id: provider === "douyin" ? id(9) : id(10),
      });
      expect(f.runtime.playbackSummary.value?.reason).toContain(
        "自己的平台账号",
      );
      const other = provider === "douyin" ? "tiktok" : "douyin";
      const source = f.element.src;
      f.shortAccounts.value = { ...f.shortAccounts.value, [other]: 1 };
      await settle();
      expect(f.bodies).toHaveLength(1);
      expect(f.element.src).toBe(source);
      const oldError = f.element.onerror,
        oldMetadata = f.element.onloadedmetadata;
      f.clock.ready = false;
      f.shortAccounts.value = { ...f.shortAccounts.value, [provider]: 1 };
      expect(f.element.src).toBe("");
      expect(f.element.onerror).toBeNull();
      f.element.error = { code: 3 };
      oldError();
      oldMetadata();
      expect(f.error.value).toBe("");
      await f.runtime.reset();
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.bodies).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  },
);
it.each(["douyin", "tiktok"] as const)(
  "%s explicit anonymous playback is independent of saved-session revisions",
  async (provider) => {
    const f = setup({ provider });
    try {
      f.runtime.nativeCredentialMode.value = "anonymous";
      await f.runtime.loadMedia();
      const source = f.element.src;
      f.shortAccounts.value = { ...f.shortAccounts.value, [provider]: 1 };
      await settle();
      expect(f.bodies).toHaveLength(1);
      expect(f.element.src).toBe(source);
      expect(JSON.parse(f.bodies[0]).native_platform).toEqual({
        version: 1,
        credential_mode: "anonymous",
      });
    } finally {
      f.cleanup();
    }
  },
);

it("YouTube own-session request carries its exact account and clears late SDK callbacks on revision change", async () => {
  const f = setup({ provider: "youtube", ownAccount: true });
  try {
    await f.runtime.loadMedia();
    expect(JSON.parse(f.bodies[0]).native_platform).toEqual({
      version: 1,
      credential_mode: "own_or_anonymous",
      account_id: id(11),
    });
    const old = dashboards[0];
    f.shortAccounts.value = { douyin: 1, tiktok: 1 };
    f.account.value++;
    await settle();
    expect(f.bodies).toHaveLength(1);
    expect(old.options.current()).toBe(true);
    f.clock.ready = false;
    f.youtubeAccount.value++;
    expect(old.options.current()).toBe(false);
    expect(old.destroy).toHaveBeenCalled();
    await f.runtime.reset();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.bodies).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

it("YouTube explicit anonymous playback is independent of saved-session revisions", async () => {
  const f = setup({ provider: "youtube" });
  try {
    f.runtime.nativeCredentialMode.value = "anonymous";
    await f.runtime.loadMedia();
    const old = dashboards[0];
    f.youtubeAccount.value++;
    await settle();
    expect(f.bodies).toHaveLength(1);
    expect(old.options.current()).toBe(true);
  } finally {
    f.cleanup();
  }
});

it("live HLS uses edge-on-resume without a calibrated VOD clock and never ends/autonexts", async () => {
  const f = setup({ live: true });
  try {
    f.clock.ready = false;
    await f.runtime.loadMedia();
    const body = JSON.parse(f.bodies[0]);
    expect(body.native_platform.live_version).toBe(1);
    expect(body.position_ms).toBe(0);
    expect(f.runtime.live.value).toBe(true);
    expect(f.element.src).toContain("/platform-live-delivery/");
    f.element.readyState = 2;
    f.element.seekable = { length: 1, start: () => 100, end: () => 130 };
    f.element.currentTime = 102;
    await f.runtime.applyState();
    expect(f.element.currentTime).toBe(102);
    f.state.value.playback_status = "playing";
    await f.runtime.applyState();
    expect(f.element.currentTime).toBe(127);
    expect(f.element.play).toHaveBeenCalled();
    f.state.value.playback_status = "paused";
    await f.runtime.applyState();
    f.element.seekable = { length: 1, start: () => 150, end: () => 180 };
    f.state.value.playback_status = "playing";
    await f.runtime.applyState();
    expect(f.element.currentTime).toBe(177);
    // A browser-local pause does not change the room, but resuming still jumps edge.
    f.element.paused = true;
    f.element.seekable = { length: 1, start: () => 200, end: () => 230 };
    await f.runtime.applyState();
    expect(f.element.currentTime).toBe(227);
    f.element.seekable = { length: 1, start: () => 250, end: () => 280 };
    await f.runtime.enablePlayback();
    expect(f.element.currentTime).toBe(277);
    f.element.ended = true;
    f.element.onended();
    await settle();
    expect(f.ended).not.toHaveBeenCalled();
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "NATIVE_LIVE_NOT_BROADCASTING",
    );
    expect(f.element.pause).toHaveBeenCalled();
    expect(f.runtime.duration.value).toBe(0);
  } finally {
    f.cleanup();
  }
});
it("live callbacks and decoder are retired across newer generations and broadcast identities", async () => {
  const f = setup({ live: true });
  try {
    await f.runtime.loadMedia();
    const oldEnded = f.element.onended;
    f.state.value.media_generation += 1;
    f.state.value.live = {
      ...f.state.value.live,
      broadcast_id: "12:34:1700000001",
    };
    await f.runtime.applyState();
    expect(f.element.pause).toHaveBeenCalled();
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "NATIVE_LIVE_STATE_CHANGED",
    );
    await f.runtime.reset();
    f.error.value = "";
    f.element.ended = true;
    oldEnded();
    await settle();
    expect(f.error.value).toBe("");
    expect(f.runtime.sessionId.value).toBeNull();
    expect(f.ended).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});

const liveWindowError = (code = "NATIVE_LIVE_WINDOW_EXPIRED") => ({
  fatal: false,
  response: { code: 409 },
  networkDetails: { responseText: JSON.stringify({ error: { code } }) },
});
const liveWindowResponse = (
  status = 409,
  code = "NATIVE_LIVE_WINDOW_EXPIRED",
) =>
  new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: { "content-type": "application/json" },
  });

it("a validated live window gap rejoins once with a fresh generation and never loops before resumed progress", async () => {
  const f = setup({ live: true, nativeHls: false });
  try {
    await f.runtime.loadMedia();
    const old = hlsPlayers[0],
      oldError = old.handlers.get("error")!;
    oldError({}, liveWindowError());
    // Repeated callbacks from the old grant are retired synchronously.
    oldError({}, liveWindowError());
    await settle();
    expect(f.bodies).toHaveLength(2);
    expect(old.destroy).toHaveBeenCalled();
    const [first, second] = f.bodies.map((value) => JSON.parse(value));
    expect(second.plan_generation).toBe(first.plan_generation + 1);
    expect(second.viewer_id).toBe(first.viewer_id);
    expect(second.idempotency_key).not.toBe(first.idempotency_key);
    expect(second.room_id).toBe(first.room_id);
    expect(second.media_generation).toBe(first.media_generation);
    expect(second.native_platform).toEqual(first.native_platform);
    expect(second.position_ms).toBe(0);
    expect(f.state.value.live.broadcast_id).toBe("12:34:1700000000");
    hlsPlayers[1].handlers.get("error")!({}, liveWindowError());
    await settle();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.bodies).toHaveLength(2);
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "NATIVE_LIVE_WINDOW_EXPIRED",
    );
    expect(f.ended).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});

it("verified resumed playing/progress allows a later legitimate pause window to rejoin", async () => {
  const f = setup({ live: true, nativeHls: false });
  const now = vi.spyOn(performance, "now");
  try {
    await f.runtime.loadMedia();
    hlsPlayers[0].handlers.get("error")!({}, liveWindowError());
    await settle();
    expect(f.bodies).toHaveLength(2);
    f.state.value.playback_status = "playing";
    f.element.readyState = 2;
    f.element.paused = false;
    f.element.currentTime = 100;
    now.mockReturnValue(1000);
    f.element.dispatchEvent(new Event("playing"));
    // A seek/jump isn't progress evidence and cannot reset the budget.
    now.mockReturnValue(2500);
    f.element.currentTime = 130;
    f.element.dispatchEvent(new Event("timeupdate"));
    f.element.currentTime = 101;
    f.element.dispatchEvent(new Event("timeupdate"));
    f.state.value.playback_status = "paused";
    hlsPlayers[1].handlers.get("error")!({}, liveWindowError());
    await settle();
    expect(f.bodies).toHaveLength(3);
    expect(JSON.parse(f.bodies[2]).plan_generation).toBe(3);
    expect(f.state.value.live.broadcast_id).toBe("12:34:1700000000");
  } finally {
    now.mockRestore();
    f.cleanup();
  }
});

it.each([
  "NATIVE_LIVE_BROADCAST_CHANGED",
  "NATIVE_LIVE_PLAYLIST_CHANGED",
  "NATIVE_LIVE_NOT_BROADCASTING",
])("%s remains terminal and never imports or rejoins", async (code) => {
  const f = setup({ live: true, nativeHls: false });
  try {
    await f.runtime.loadMedia();
    hlsPlayers[0].handlers.get("error")!({}, liveWindowError(code));
    await settle();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.bodies).toHaveLength(1);
    expect(f.runtime.preparation.value.failure?.code).toBe(code);
    expect(
      f.api.mock.calls.some((call) =>
        String(call[0]).includes("platform-media"),
      ),
    ).toBe(false);
  } finally {
    f.cleanup();
  }
});

it("native HLS probes only the validated same-session error and rejoins once", async () => {
  const f = setup({ live: true, nativeHls: true });
  const fetcher = vi.fn(async () => liveWindowResponse());
  vi.stubGlobal("fetch", fetcher);
  try {
    await f.runtime.loadMedia();
    const original = f.element.src;
    f.element.error = { code: 2 };
    f.element.onerror();
    f.element.onerror();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(original);
    expect(options).toMatchObject({
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(f.bodies).toHaveLength(2);
    f.element.onerror();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.bodies).toHaveLength(2);
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "NATIVE_PLATFORM_DELIVERY_INVALID",
    );
  } finally {
    f.cleanup();
  }
});

it.each([200, 401, 403, 410])(
  "native HLS status %s cannot justify a fresh live grant",
  async (status) => {
    const f = setup({ live: true, nativeHls: true });
    const fetcher = vi.fn(async () => liveWindowResponse(status));
    vi.stubGlobal("fetch", fetcher);
    try {
      await f.runtime.loadMedia();
      f.element.error = { code: 2 };
      f.element.onerror();
      await settle();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(f.bodies).toHaveLength(1);
      expect(f.runtime.preparation.value.failure?.code).toBe(
        "NATIVE_PLATFORM_DELIVERY_INVALID",
      );
    } finally {
      f.cleanup();
    }
  },
);

it.each([
  "NATIVE_LIVE_BROADCAST_CHANGED",
  "NATIVE_LIVE_PLAYLIST_CHANGED",
  "UNKNOWN",
])("native probe %s is a hard failure", async (code) => {
  const f = setup({ live: true, nativeHls: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => liveWindowResponse(409, code)),
  );
  try {
    await f.runtime.loadMedia();
    f.element.error = { code: 2 };
    f.element.onerror();
    await settle();
    expect(f.bodies).toHaveLength(1);
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "NATIVE_PLATFORM_DELIVERY_INVALID",
    );
  } finally {
    f.cleanup();
  }
});

it("native probe has one absolute deadline and rejects oversized error bodies", async () => {
  const f = setup({ live: true, nativeHls: true });
  const fetcher = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) =>
        options.signal!.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    await f.runtime.loadMedia();
    f.element.error = { code: 2 };
    f.element.onerror();
    await vi.advanceTimersByTimeAsync(2500);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.bodies).toHaveLength(1);
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "NATIVE_PLATFORM_DELIVERY_INVALID",
    );
    await f.runtime.loadMedia();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x".repeat(16385), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    f.element.error = { code: 2 };
    f.element.onerror();
    await settle();
    expect(f.bodies).toHaveLength(2);
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "NATIVE_PLATFORM_DELIVERY_INVALID",
    );
  } finally {
    f.cleanup();
  }
});

it.each(["media", "broadcast", "logout", "cancel"])(
  "late native live probe is fenced after %s",
  async (change) => {
    const f = setup({ live: true, nativeHls: true });
    let release!: (value: Response) => void;
    const fetcher = vi.fn(
      (_url: string, _options: RequestInit) =>
        new Promise<Response>((resolve) => (release = resolve)),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      await f.runtime.loadMedia();
      f.element.error = { code: 2 };
      f.element.onerror();
      await settle();
      if (change === "media") f.state.value.media_generation++;
      if (change === "broadcast")
        f.state.value.live = {
          ...f.state.value.live,
          broadcast_id: "12:34:1700000001",
        };
      if (change === "logout") f.session.epoch++;
      if (change === "cancel") await f.runtime.reset();
      release(liveWindowResponse());
      await settle();
      expect(f.bodies).toHaveLength(1);
      expect(f.ended).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  },
);

it("native live probe deadline includes a stalled response body", async () => {
  const f = setup({ live: true, nativeHls: true });
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  try {
    await f.runtime.loadMedia();
    f.element.error = { code: 2 };
    f.element.onerror();
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    await settle();
    expect(cancel).toHaveBeenCalled();
    expect(f.bodies).toHaveLength(1);
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "NATIVE_PLATFORM_DELIVERY_INVALID",
    );
  } finally {
    f.cleanup();
  }
});

it("a late native probe cannot cross an own-account revision change", async () => {
  const f = setup({ live: true, nativeHls: true, ownAccount: true });
  let release!: (value: Response) => void;
  const fetcher = vi.fn(
    (_url: string, _options: RequestInit) =>
      new Promise<Response>((resolve) => (release = resolve)),
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    await f.runtime.loadMedia();
    f.element.error = { code: 2 };
    f.element.onerror();
    await settle();
    f.account.value++;
    await settle();
    expect((fetcher.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(
      true,
    );
    const before = f.bodies.length;
    release(liveWindowResponse());
    await settle();
    expect(f.bodies).toHaveLength(before);
    expect(f.ended).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});

it("native HLS permits a second healthy pause episode only after playing and timed progress", async () => {
  const f = setup({ live: true, nativeHls: true });
  const fetcher = vi.fn(async () => liveWindowResponse());
  vi.stubGlobal("fetch", fetcher);
  const now = vi.spyOn(performance, "now");
  try {
    await f.runtime.loadMedia();
    f.element.error = { code: 2 };
    f.element.onerror();
    await settle();
    expect(f.bodies).toHaveLength(2);
    f.state.value.playback_status = "playing";
    f.element.paused = false;
    f.element.readyState = 2;
    f.element.currentTime = 100;
    now.mockReturnValue(1000);
    f.element.dispatchEvent(new Event("playing"));
    now.mockReturnValue(2500);
    f.element.currentTime = 101;
    f.element.dispatchEvent(new Event("timeupdate"));
    f.state.value.playback_status = "paused";
    f.element.error = { code: 2 };
    f.element.onerror();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.bodies).toHaveLength(3);
    expect(JSON.parse(f.bodies[2]).position_ms).toBe(0);
    expect(f.state.value.live.broadcast_id).toBe("12:34:1700000000");
  } finally {
    now.mockRestore();
    f.cleanup();
  }
});

it("a live window gap waits for reconnection without allocating duplicate generations", async () => {
  const f = setup({ live: true, nativeHls: false });
  try {
    await f.runtime.loadMedia();
    const oldError = hlsPlayers[0].handlers.get("error")!;
    f.connected.value = false;
    oldError({}, liveWindowError());
    await settle();
    expect(f.bodies).toHaveLength(1);
    oldError({}, liveWindowError());
    f.connected.value = true;
    f.runtime.onClockReady();
    await settle();
    expect(f.bodies).toHaveLength(2);
    expect(JSON.parse(f.bodies[1]).plan_generation).toBe(2);
  } finally {
    f.cleanup();
  }
});

it("native probe rejects a response past its absolute deadline even before a delayed timer fires", async () => {
  const f = setup({ live: true, nativeHls: true });
  let release!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
  );
  const wall = vi.spyOn(Date, "now");
  try {
    wall.mockReturnValue(10000);
    await f.runtime.loadMedia();
    f.element.error = { code: 2 };
    f.element.onerror();
    await settle();
    wall.mockReturnValue(12501);
    release(liveWindowResponse());
    await settle();
    expect(f.bodies).toHaveLength(1);
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "NATIVE_PLATFORM_DELIVERY_INVALID",
    );
  } finally {
    wall.mockRestore();
    f.cleanup();
  }
});


it.each(["reset", "identity", "media", "dispose"])(
  "late DASH driver-module resolution cannot create an adapter after %s",
  async (cause) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    dashDriverLoad.before = () => pending;
    const f = setup();
    try {
      const loading = f.runtime.loadMedia();
      await settle();
      expect(dashDriverLoad.calls).toBe(1);
      expect(dashboards).toHaveLength(0);
      if (cause === "reset") await f.runtime.reset();
      else if (cause === "identity") ++f.session.epoch;
      else if (cause === "media") f.state.value.media_generation++;
      else f.cleanup();
      release();
      await loading;
      expect(dashboards).toHaveLength(0);
      expect(f.element.src).toBe("");
    } finally {
      release();
      f.cleanup();
    }
  },
);
it.each(["data", "frame"])(
  "the DASH driver-module wait consumes the original %s budget",
  async (kind) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    dashDriverLoad.before = () => pending;
    const f = setup({ metricClock: true });
    try {
      if (kind === "frame") {
        f.state.value.playback_status = "playing";
        f.element.readyState = 4;
      }
      const loading = f.runtime.loadMedia();
      await settle();
      expect(dashDriverLoad.calls).toBe(1);
      expect(dashboards).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(19000);
      expect(f.runtime.preparation.value.failure).toBeUndefined();
      release();
      await loading;
      expect(dashboards).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.runtime.preparation.value.failure?.code).toBe(
        kind === "frame" ? "FIRST_FRAME_TIMEOUT" : "MEDIA_DATA_TIMEOUT",
      );
    } finally {
      release();
      f.cleanup();
    }
  },
);
it("a failed DASH driver import keeps the safe library failure category and an explicit retry", async () => {
  dashDriverLoad.before = async () => { throw Error("private module URL"); };
  const f = setup();
  try {
    await f.runtime.loadMedia();
    expect(dashboards).toHaveLength(0);
    expect(f.runtime.preparation.value.failure?.code).toBe("DASH_LIBRARY_LOAD_FAILED");
    expect(f.error.value).toBe("DASH 播放器加载失败，请重试");
    expect(f.error.value).not.toContain("private module URL");
    dashDriverLoad.before = undefined;
    await f.runtime.runPlayback(() => f.runtime.loadMedia());
    expect(dashboards).toHaveLength(1);
    expect(f.bodies).toHaveLength(2);
    expect(f.error.value).toBe("");
  } finally { f.cleanup(); }
});
it("staged settings during the DASH module wait preserve the already granted attachment", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  dashDriverLoad.before = () => pending;
  const f = setup();
  try {
    const loading = f.runtime.loadMedia();
    await settle();
    expect(dashDriverLoad.calls).toBe(1);
    f.runtime.nativePlaybackMode.value = "compatibility";
    release();
    await loading;
    expect(dashboards).toHaveLength(1);
    expect(dashboards[0].options.video).toBe(f.element);
    expect(f.bodies).toHaveLength(1);
    expect(f.error.value).toBe("");
  } finally {
    release();
    f.cleanup();
  }
});


it.each([
  [false, "resolve"],
  [false, "reject"],
  [true, "resolve"],
  [true, "reject"],
] as const)(
  "a retired %s live play %s cannot release or block the successor policy's play",
  async (fromLive, settlement) => {
    const options = { live: fromLive };
    const f = setup(options);
    const call = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (path, method, body) => {
      const result = await call(path, method, body);
      return path === "/playback-sessions/native-platform" && method === "POST"
        ? { ...result, media_generation: body.media_generation }
        : result;
    });
    const live = {
      version: 1,
      broadcast_id: "12:34:1700000000",
      sync_mode: "live_edge_control",
    };
    let settleOld!: () => void, rejectNew!: (failure: Error) => void;
    try {
      f.state.value.playback_rate = fromLive ? 1 : 1.25;
      await f.runtime.loadMedia();
      f.element.readyState = 4;
      f.element.seekable = { length: 1, start: () => 0, end: () => 120 };
      f.element.play
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve, reject) => {
              settleOld = () =>
                settlement === "reject"
                  ? reject(
                      new DOMException("retired autoplay", "NotAllowedError"),
                    )
                  : resolve();
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectNew = reject;
            }),
        );
      f.state.value.playback_status = "playing";
      const oldPlaying = f.runtime.applyState();
      expect(f.element.play).toHaveBeenCalledTimes(1);
      const oldSession = f.runtime.sessionId.value;

      options.live = !fromLive;
      f.selectedMedia.platform = options.live
        ? {
            version: 3,
            provider: "bilibili",
            part: 1,
            content_id: `live:12:${live.broadcast_id}`,
            resource: {
              kind: "bilibili_live",
              room_id: "12",
              uid: "34",
              broadcast_id: live.broadcast_id,
            },
          }
        : { ...media.platform };
      f.state.value = {
        ...f.state.value,
        media_generation: f.state.value.media_generation + 1,
        playback_status: "paused",
        playback_rate: options.live ? 1 : 1.5,
        live: options.live ? live : undefined,
        anchor_position_ms: options.live ? 0 : 5000,
        duration_ms: options.live ? null : 100000,
      };
      await f.runtime.loadMedia();
      expect(f.runtime.sessionId.value).not.toBe(oldSession);
      expect(f.runtime.live.value).toBe(!fromLive);
      expect(f.runtime.video.value).toBe(f.element);
      f.state.value.playback_status = "playing";
      const newPlaying = f.runtime.applyState();
      expect(f.element.play).toHaveBeenCalledTimes(2);
      expect(f.element.playbackRate).toBe(options.live ? 1 : 1.5);
      f.element.pause.mockClear();
      settleOld();
      await oldPlaying;
      expect(f.element.pause).not.toHaveBeenCalled();
      expect(f.runtime.blocked.value).toBe(false);
      expect(f.error.value).toBe("");
      // An old finally must not free the successor's in-flight claim, including
      // the explicit gesture entry point shared by both policies.
      await f.runtime.enablePlayback();
      expect(f.element.play).toHaveBeenCalledTimes(2);
      rejectNew(new DOMException("current autoplay", "NotAllowedError"));
      await newPlaying;
      expect(f.runtime.blocked.value).toBe(true);
      expect(f.bodies).toHaveLength(2);
    } finally {
      f.cleanup();
    }
  },
);

it("live periodic convergence keeps paused time local and resumes only at the decoder edge", async () => {
  const f = setup({ live: true });
  try {
    f.clock.ready = false;
    await f.runtime.loadMedia();
    f.element.readyState = 2;
    f.element.seekable = { length: 1, start: () => 100, end: () => 130 };
    f.element.currentTime = 102;
    f.runtime.position.value = 999;
    f.runtime.duration.value = 999;
    f.element.pause.mockClear();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.runtime.position.value).toBe(0);
    expect(f.runtime.duration.value).toBe(0);
    expect(f.element.currentTime).toBe(102);
    expect(f.element.pause).toHaveBeenCalledOnce();
    expect(f.element.play).not.toHaveBeenCalled();
    f.state.value.playback_status = "playing";
    await vi.advanceTimersByTimeAsync(500);
    expect(f.element.currentTime).toBe(127);
    expect(f.element.play).toHaveBeenCalledOnce();
    expect(f.clock.ready).toBe(false);
    expect(f.runtime.video.value).toBe(f.element);
    expect(f.bodies).toHaveLength(1);
    expect(f.ended).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});

it.each(["broadcast", "media"] as const)(
  "live periodic convergence rejects a changed %s identity before classifying ended media",
  async (identity) => {
    const f = setup({ live: true });
    try {
      await f.runtime.loadMedia();
      f.element.readyState = 2;
      f.element.ended = true;
      if (identity === "broadcast")
        f.state.value.live = {
          ...f.state.value.live,
          broadcast_id: "12:34:1700000001",
        };
      else f.state.value.media_generation++;
      await vi.advanceTimersByTimeAsync(500);
      expect(f.runtime.preparation.value.failure?.code).toBe(
        "NATIVE_LIVE_STATE_CHANGED",
      );
      expect(f.element.play).not.toHaveBeenCalled();
      expect(f.bodies).toHaveLength(1);
      expect(f.ended).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  },
);

it("live periodic convergence preserves a terminal episode without repeating its failure", async () => {
  const f = setup({ live: true });
  try {
    await f.runtime.loadMedia();
    f.element.readyState = 2;
    f.element.ended = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "NATIVE_LIVE_NOT_BROADCASTING",
    );
    f.error.value = "independent current notice";
    f.element.pause.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.error.value).toBe("independent current notice");
    expect(f.element.pause).not.toHaveBeenCalled();
    expect(f.element.play).not.toHaveBeenCalled();
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "NATIVE_LIVE_NOT_BROADCASTING",
    );
    expect(f.bodies).toHaveLength(1);
    expect(f.ended).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});

it("gesture port characterization: live room status is read after a synchronous rate effect", async () => {
  const f = setup({ live: true });
  try {
    f.clock.ready = false;
    await f.runtime.loadMedia();
    f.element.readyState = 2;
    f.element.seekable = { length: 1, start: () => 100, end: () => 130 };
    f.element.currentTime = 102;
    f.state.value.playback_status = "playing";
    f.state.value.playback_rate = 1.25;
    let rate = 1,
      pauseOnce = true;
    Object.defineProperty(f.element, "playbackRate", {
      configurable: true,
      get: () => rate,
      set: (value: number) => {
        rate = value;
        if (pauseOnce) {
          pauseOnce = false;
          f.state.value.playback_status = "paused";
        }
      },
    });
    f.element.play.mockClear();
    f.element.play.mockImplementation(async () => {
      f.element.paused = false;
    });
    await f.runtime.enablePlayback();
    expect(rate).toBe(1.25);
    expect(f.state.value.playback_status).toBe("paused");
    expect(f.element.currentTime).toBe(102);
    expect(f.element.play).not.toHaveBeenCalled();
    f.state.value.playback_status = "playing";
    await f.runtime.enablePlayback();
    expect(f.element.currentTime).toBe(127);
    expect(f.element.play).toHaveBeenCalledOnce();
    expect(f.runtime.video.value).toBe(f.element);
    expect(f.bodies).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

it("gesture port characterization: live edge assignment precedes the late play-property lookup", async () => {
  const f = setup({ live: true });
  const effects: string[] = [];
  try {
    await f.runtime.loadMedia();
    f.element.readyState = 2;
    f.element.seekable = { length: 1, start: () => 100, end: () => 130 };
    f.state.value.playback_status = "playing";
    f.runtime.blocked.value = true;
    let position = 102;
    Object.defineProperty(f.element, "currentTime", {
      configurable: true,
      get: () => position,
      set: function (this: unknown, value: number) {
        expect(this).toBe(f.element);
        effects.push(`seek ${value}`);
        position = value;
      },
    });
    f.element.play.mockImplementation(async () => {
      f.element.paused = false;
    });
    const original = f.element.play;
    Object.defineProperty(f.element, "play", {
      configurable: true,
      get: () => {
        effects.push("play lookup");
        expect(f.runtime.blocked.value).toBe(false);
        expect(position).toBe(127);
        return original;
      },
    });
    const gesture = f.runtime.enablePlayback();
    effects.push("caller returned");
    expect(effects.slice(0, 3)).toEqual([
      "seek 127",
      "play lookup",
      "caller returned",
    ]);
    await gesture;
    expect(effects).toEqual([
      "seek 127",
      "play lookup",
      "caller returned",
      "seek 127",
    ]);
    expect(original).toHaveBeenCalledOnce();
    expect(f.runtime.video.value).toBe(f.element);
    expect(f.bodies).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

it("gesture port characterization: a changed live broadcast retires a late gesture denial", async () => {
  const f = setup({ live: true });
  let reject!: (failure: Error) => void;
  try {
    await f.runtime.loadMedia();
    f.element.readyState = 2;
    f.element.seekable = { length: 1, start: () => 100, end: () => 130 };
    f.state.value.playback_status = "playing";
    f.runtime.blocked.value = true;
    f.element.play.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, no) => {
          reject = no;
        }),
    );
    const gesture = f.runtime.enablePlayback();
    expect(f.element.play).toHaveBeenCalledOnce();
    f.state.value.live = {
      ...f.state.value.live,
      broadcast_id: "12:34:1700000001",
    };
    const notice = f.error.value;
    f.element.pause.mockClear();
    reject(new DOMException("old live gesture", "NotAllowedError"));
    await gesture;
    expect(f.runtime.blocked.value).toBe(false);
    expect(f.error.value).toBe(notice);
    expect(f.element.pause).not.toHaveBeenCalled();
    expect(f.bodies).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

it("gesture port characterization: an absent element does not move failed-plan admission after clock evaluation", async () => {
  const f = setup({ provider: "youtube", mse: true, nativeHls: false });
  try {
    f.runtime.nativePlaybackMode.value = "compatibility";
    await f.runtime.loadMedia();
    hlsPlayers[0].handlers.get("error")!(null, {
      fatal: true,
      type: "mediaError",
      details: "decode-failed",
    });
    await settle();
    expect(f.runtime.preparation.value.phase).toBe("failed");
    const notice = f.error.value;
    // Fixture-only absence isolates the failed-plan versus clock read order.
    f.runtime.video.value = undefined;
    const clockRead = vi.fn(() => false);
    Object.defineProperty(f.clock, "ready", {
      configurable: true,
      get: clockRead,
    });
    await expect(f.runtime.enablePlayback()).resolves.toBeUndefined();
    expect(clockRead).not.toHaveBeenCalled();
    expect(f.error.value).toBe(notice);
    expect(f.element.play).not.toHaveBeenCalled();
  } finally {
    f.runtime.video.value = f.element;
    f.cleanup();
  }
});

it("gesture port characterization: terminal live state short-circuits the physical ended getter", async () => {
  const f = setup({ live: true });
  try {
    await f.runtime.loadMedia();
    f.element.ended = true;
    f.element.onended();
    await settle();
    expect(f.runtime.preparation.value.failure?.code).toBe(
      "NATIVE_LIVE_NOT_BROADCASTING",
    );
    const notice = f.error.value;
    const endedRead = vi.fn(() => {
      throw new Error("terminal episode must short-circuit ended");
    });
    Object.defineProperty(f.element, "ended", {
      configurable: true,
      get: endedRead,
    });
    await expect(f.runtime.enablePlayback()).resolves.toBeUndefined();
    expect(endedRead).not.toHaveBeenCalled();
    expect(f.error.value).toBe(notice);
    expect(f.element.play).not.toHaveBeenCalled();
    expect(f.bodies).toHaveLength(1);
  } finally {
    Object.defineProperty(f.element, "ended", {
      configurable: true,
      writable: true,
      value: true,
    });
    f.cleanup();
  }
});
