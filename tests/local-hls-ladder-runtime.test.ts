vi.mock("../apps/web/src/features/playback/browser-mse", async () => {
  const { default: Hls } = await import("hls.js");
  return {
    getPlaybackMediaSource: () => Hls.getMediaSource(),
    hasPlaybackMseApi: () => Hls.isMSESupported(),
    supportsHlsPlayback: () => Hls.isSupported(),
  };
});
import { afterEach, expect, it, vi } from "vitest";
import { effectScope, reactive, ref } from "vue";
import { createPlaybackRuntime } from "../apps/web/src/features/playback/playback-runtime";

const instances = vi.hoisted(() => [] as any[]);
vi.mock("hls.js", () => ({
  default: class {
    static Events = {
      ERROR: "error",
      MANIFEST_PARSED: "manifest",
      LEVEL_SWITCHED: "level",
    };
    static isSupported = () => true;
    static getMediaSource = () => ({ isTypeSupported: () => true });
    static isMSESupported = () => true;
    handlers = new Map<string, Function>();
    levels: any[] = [];
    loadLevel = -1;
    config: any = {};
    destroyed = false;
    constructor() {
      instances.push(this);
    }
    loadSource(url: string) {
      this.levels = caps.renditions.map((r) => ({
        width: r.width,
        height: r.height,
        bitrate: r.bandwidth,
        videoCodec: r.codecs,
        url: [url.replace("master.m3u8", `${r.id}/index.m3u8`) + "&attempt=1"],
      }));
    }
    attachMedia() {}
    startLoad() {}
    stopLoad() {}
    destroy() {
      this.destroyed = true;
    }
    on(event: string, handler: Function) {
      this.handlers.set(event, handler);
    }
    emit(event: string, data: any = {}) {
      this.handlers.get(event)?.(event, data);
    }
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  instances.length = 0;
});
const caps = {
  schema_version: 1,
  worker_runtime_required: true,
  renditions: [
    {
      id: "low",
      width: 640,
      height: 360,
      bandwidth: 1250000,
      codecs: "avc1.64001F",
    },
    {
      id: "medium",
      width: 1280,
      height: 720,
      bandwidth: 3750000,
      codecs: "avc1.64001F",
    },
  ],
};
const candidates = caps.renditions.map((r) => ({
  id: `hls_ladder_${r.id}`,
  delivery_mode: "transcode",
  transport: "hls",
  content_type: `video/mp4; codecs="${r.codecs}"`,
  video: {
    content_type: `video/mp4; codecs="${r.codecs}"`,
    width: r.width,
    height: r.height,
    bitrate: r.id === "low" ? 800000 : 2500000,
    framerate: 30,
  },
  audio: null,
}));
function setup(
  options: {
    lost?: boolean;
    dropEcho?: boolean;
    defer?: boolean;
    deferProbe?: boolean;
    native?: boolean;
  } = {},
) {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", {
    mediaCapabilities: {
      decodingInfo: async () => ({
        supported: true,
        smooth: true,
        powerEfficient: false,
      }),
    },
  });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("location", {
    origin: "http://localhost",
    href: "http://localhost/rooms/room",
  });
  let posts = 0,
    resolve!: (plan: any) => void,
    resolveProbe!: (set: any) => void;
  const api = vi.fn(async (path: string, method: string, body?: any) => {
    if (path === "/playback-candidates") {
      const set = {
        schema_version: 1,
        binding: body.local_hls_ladder ? "ladder-binding" : null,
        candidates: body.local_hls_ladder ? candidates : [],
        local_hls_ladder: caps,
        decision_reason: "actual_source",
      };
      if (options.deferProbe && body.local_hls_ladder)
        return new Promise((r) => {
          resolveProbe = r;
        });
      return set;
    }
    if (
      (path === "/playback-sessions" ||
        path === "/playback-sessions/local-hls-ladder") &&
      method === "POST"
    ) {
      const advanced = path.endsWith("local-hls-ladder");
      if (advanced && options.lost && ++posts === 1)
        throw new TypeError("lost result");
      const plan = makePlan(body, advanced && !options.dropEcho);
      if (advanced && options.defer)
        return new Promise((r) => {
          resolve = () => r(plan);
        });
      return plan;
    }
    if (method === "GET" && path.startsWith("/playback-sessions/session-")) {
      const id = path.split("/")[2].split("?")[0];
      return {
        session_id: id,
        plan_generation: Number(id.split("-")[1]),
        status: "ready",
        complete: true,
        available_until_ms: 100000,
      };
    }
    return {};
  });
  const session = reactive({ user: { id: "user" }, epoch: 1, api });
  const state = ref({
    room_id: "room",
    media_id: "media",
    media_generation: 1,
    playback_status: "paused",
    anchor_position_ms: 5000,
    anchor_server_time_ms: 0,
    playback_rate: 1,
  });
  const scope = effectScope(),
    error = ref("");
  const runtime = scope.run(() =>
    createPlaybackRuntime({
      session: session as any,
      state: state as any,
      connected: ref(true),
      active: ref(true),
      clock: { ready: true, now: () => 10000 } as any,
      error,
      run: async (action) => action(),
    }),
  )!;
  const element: any = Object.assign(new EventTarget(), {
    canPlayType: (type: string) =>
      type === "application/vnd.apple.mpegurl"
        ? options.native
          ? "maybe"
          : ""
        : "maybe",
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
    seekable: { length: 0 },
    currentTime: 0,
    playbackRate: 1,
    paused: true,
    seeking: false,
    readyState: 4,
  });
  runtime.attach(element);
  return {
    api,
    runtime,
    session,
    state,
    element,
    error,
    resolve: () => resolve(undefined),
    resolveProbe: (set: any) => resolveProbe(set),
    cleanup: () => scope.stop(),
    ladderPosts: () =>
      api.mock.calls.filter(
        ([path, method]) =>
          path === "/playback-sessions/local-hls-ladder" && method === "POST",
      ),
  };
}
function makePlan(body: any, advanced: boolean) {
  return {
    session_id: `session-${body.plan_generation}`,
    media_id: "media",
    media_generation: 1,
    plan_generation: body.plan_generation,
    delivery_mode: advanced ? "transcode" : "direct",
    transport: advanced ? "hls" : "progressive",
    playback_url: `/media-delivery/session-${body.plan_generation}/${advanced ? "ladder/master.m3u8?token=secret" : "file"}`,
    timeline_origin_ms: advanced ? body.position_ms : 0,
    duration_ms: 100000,
    rebuild_on_seek: advanced,
    audio_tracks: [],
    subtitle_tracks: [],
    ...(advanced
      ? {
          local_hls_ladder: {
            request: structuredClone(body.local_hls_ladder),
            renditions: structuredClone(caps.renditions),
            video_basis: "constrained_encoder_recipe",
          },
        }
      : {}),
  };
}
async function selectLadder(ctx: ReturnType<typeof setup>) {
  await ctx.runtime.loadMedia();
  expect(ctx.runtime.ladderCapabilities.value).toEqual(caps);
  ctx.runtime.localHlsLadderEnabled.value = true;
}
it("uses bound reports for all rungs and dedicated admission, with real SDK auto/manual switching", async () => {
  const ctx = setup();
  try {
    await selectLadder(ctx);
    await ctx.runtime.loadMedia();
    const body = ctx.ladderPosts()[0][2];
    expect(body.local_hls_ladder).toEqual({ schema_version: 1 });
    expect(body.candidate_report.binding).toBe("ladder-binding");
    expect(body.candidate_report.results).toHaveLength(2);
    expect(body.http_file_fallback_version).toBeUndefined();
    const sdk = instances.at(-1);
    sdk.levels.reverse();
    sdk.emit("manifest");
    expect(ctx.runtime.ladderManual.value).toBe(true);
    expect(sdk.loadLevel).toBe(-1);
    ctx.runtime.selectLadderQuality("low");
    expect(sdk.loadLevel).toBe(1);
    sdk.emit("level", { level: 1 });
    expect(ctx.runtime.ladderSelected.value).toBe("low");
    ctx.runtime.selectLadderQuality("auto");
    expect(sdk.loadLevel).toBe(-1);
    await ctx.runtime.reset();
    sdk.emit("manifest");
    sdk.emit("level", { level: 0 });
    expect(ctx.runtime.ladderManual.value).toBe(false);
    expect(ctx.runtime.ladderSelected.value).toBeUndefined();
  } finally {
    ctx.cleanup();
  }
});
it("does not promise manual switching or decoded level for native HLS", async () => {
  const ctx = setup({ native: true });
  try {
    await selectLadder(ctx);
    await ctx.runtime.loadMedia();
    expect(ctx.runtime.ladderFacts.value).toBeDefined();
    expect(ctx.runtime.ladderManual.value).toBe(false);
    ctx.runtime.selectLadderQuality("low");
    expect(ctx.runtime.ladderSelected.value).toBeUndefined();
    expect(instances).toHaveLength(0);
  } finally {
    ctx.cleanup();
  }
});
it("preserves key/generation across uncertain retry", async () => {
  const ctx = setup({ lost: true });
  try {
    await selectLadder(ctx);
    const loading = ctx.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1500);
    await loading;
    expect(ctx.ladderPosts()).toHaveLength(2);
    expect(JSON.stringify(ctx.ladderPosts()[0][2])).toBe(
      JSON.stringify(ctx.ladderPosts()[1][2]),
    );
  } finally {
    ctx.cleanup();
  }
});
it("rejects old-server intent loss before player binding", async () => {
  const ctx = setup({ dropEcho: true });
  try {
    await selectLadder(ctx);
    await expect(ctx.runtime.loadMedia()).rejects.toMatchObject({
      code: "STALE_CAPABILITY_REPORT",
    });
    expect(ctx.runtime.ladderFacts.value).toBeUndefined();
    expect(ctx.element.src).not.toContain("session-2");
  } finally {
    ctx.cleanup();
  }
});
it("fences late plan and discovery after changed source/login/intent", async () => {
  const ctx = setup({ defer: true });
  try {
    await selectLadder(ctx);
    const loading = ctx.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    ctx.runtime.localHlsLadderEnabled.value = false;
    ctx.resolve();
    await loading;
    expect(ctx.runtime.ladderFacts.value).toBeUndefined();
    ctx.session.epoch++;
    expect(ctx.runtime.ladderCapabilities.value).toBeUndefined();
  } finally {
    ctx.cleanup();
  }
});
it("refuses master SDK mismatch before exposing controls", async () => {
  const ctx = setup();
  try {
    await selectLadder(ctx);
    await ctx.runtime.loadMedia();
    const sdk = instances.at(-1);
    sdk.levels[1].bitrate = 1;
    sdk.emit("manifest");
    expect(sdk.destroyed).toBe(true);
    expect(ctx.runtime.ladderManual.value).toBe(false);
    expect(ctx.error.value).toContain("不一致");
  } finally {
    ctx.cleanup();
  }
});

it("does not mint single-rendition decoder fallback after ladder playback fails", async () => {
  const ctx = setup();
  try {
    await selectLadder(ctx);
    await ctx.runtime.loadMedia();
    const sdk = instances.at(-1);
    sdk.emit("manifest");
    sdk.emit("error", {
      fatal: true,
      type: "mediaError",
      details: "fragParsingError",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.ladderPosts()).toHaveLength(1);
    expect(
      ctx.api.mock.calls.filter(
        ([path, method]) => path === "/playback-sessions" && method === "POST",
      ),
    ).toHaveLength(1);
  } finally {
    ctx.cleanup();
  }
});
it("keeps deferred discovery from admitting a canceled ladder intent", async () => {
  const ctx = setup({ deferProbe: true });
  try {
    await selectLadder(ctx);
    const loading = ctx.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    ctx.runtime.localHlsLadderEnabled.value = false;
    ctx.resolveProbe({
      schema_version: 1,
      binding: "ladder-binding",
      candidates,
      local_hls_ladder: caps,
    });
    await loading;
    expect(ctx.ladderPosts()).toHaveLength(0);
  } finally {
    ctx.cleanup();
  }
});
