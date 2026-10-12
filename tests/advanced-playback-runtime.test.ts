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
import { effectScope, reactive, ref } from "vue";
import { createPlaybackRuntime } from "../apps/web/src/features/playback/playback-runtime";

vi.mock("hls.js", () => ({
  default: class {
    static Events = { ERROR: "error" };
    static isSupported = () => true;
    static getMediaSource = () => ({ isTypeSupported: () => true });
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const caps = {
  schema_version: 1,
  tone_map_hdr: true,
  subtitle_streams: [
    { index: 0, codec: "ass", label: "Styled", language: "eng" },
  ],
  worker_runtime_required: true,
};
const candidate = {
  id: "transcode_720p",
  delivery_mode: "transcode",
  transport: "hls",
  content_type: 'video/mp4; codecs="avc1.64001F"',
  video: {
    content_type: 'video/mp4; codecs="avc1.64001F"',
    width: 1280,
    height: 720,
    bitrate: 4000000,
    framerate: 30,
  },
  audio: null,
};
function setup(
  options: {
    lost?: boolean;
    dropEcho?: boolean;
    defer?: boolean;
    deferProbe?: boolean;
    dolby?: boolean;
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
        binding: body.advanced_playback ? "advanced-binding" : null,
        candidates: body.advanced_playback ? [candidate] : [],
        advanced_playback: options.dolby
          ? {
              ...caps,
              dolby_vision: {
                profile: 8,
                level: 4,
                compatibility_id: 4,
                codec: "dvh1.08.04",
              },
            }
          : caps,
        decision_reason: "actual_source",
      };
      if (options.deferProbe && body.advanced_playback)
        return new Promise((r) => {
          resolveProbe = r;
        });
      return set;
    }
    if (
      (path === "/playback-sessions" ||
        path === "/playback-sessions/advanced-local") &&
      method === "POST"
    ) {
      const advanced = path.endsWith("advanced-local");
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
  const scope = effectScope();
  const runtime = scope.run(() =>
    createPlaybackRuntime(
      playbackTestContext({
        session: session as any,
        state: state as any,
        connected: ref(true),
        active: ref(true),
        clock: { ready: true, now: () => 10000 } as any,
      }),
    ),
  )!;
  const error = runtime.playbackError;
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
    advancedPosts: () =>
      api.mock.calls.filter(
        ([path, method]) =>
          path === "/playback-sessions/advanced-local" && method === "POST",
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
    playback_url: `/media-delivery/session-${body.plan_generation}/${advanced ? "index.m3u8" : "file"}`,
    timeline_origin_ms: advanced ? body.position_ms : 0,
    duration_ms: 100000,
    rebuild_on_seek: advanced,
    audio_tracks: [],
    subtitle_tracks: [],
    ...(advanced
      ? {
          selected_candidate_id: "transcode_720p",
          subtitle_mode:
            body.advanced_playback.subtitle_stream_index === null
              ? "none"
              : "burned_in",
          advanced_playback: {
            request: structuredClone(body.advanced_playback),
            subtitle_codec:
              body.advanced_playback.subtitle_stream_index === null
                ? null
                : "ass",
            video_basis: "constrained_encoder_recipe",
          },
        }
      : {}),
  };
}
async function selectAdvanced(ctx: ReturnType<typeof setup>) {
  await ctx.runtime.loadMedia();
  expect(ctx.runtime.advancedCapabilities.value).toEqual(caps);
  ctx.runtime.toneMapHdr.value = true;
  ctx.runtime.burnInSubtitleIndex.value = 0;
}

it("automatically creates one bound SDR intent for Dolby without changing room timing", async () => {
  const ctx = setup({ dolby: true });
  const before = { ...ctx.state.value };
  try {
    await ctx.runtime.loadMedia();
    expect(ctx.advancedPosts()).toHaveLength(1);
    const body = ctx.advancedPosts()[0][2];
    expect(body.advanced_playback).toEqual({
      schema_version: 1,
      tone_map_hdr: true,
      subtitle_stream_index: null,
    });
    expect(body.candidate_report.binding).toBe("advanced-binding");
    expect(body.position_ms).toBe(5000);
    expect(ctx.state.value).toEqual(before);
    expect(ctx.runtime.toneMapHdr.value).toBe(true);
  } finally {
    ctx.cleanup();
  }
});

it("uses actual source controls, bound candidates and the dedicated advanced admission", async () => {
  const ctx = setup();
  try {
    await selectAdvanced(ctx);
    await ctx.runtime.loadMedia();
    const body = ctx.advancedPosts()[0][2];
    expect(body.advanced_playback).toEqual({
      schema_version: 1,
      tone_map_hdr: true,
      subtitle_stream_index: 0,
    });
    expect(body.mode).toBe("transcode");
    expect(body.candidate_report.binding).toBe("advanced-binding");
    expect(body.static_hls_fallback_version).toBeUndefined();
    expect(body.http_file_fallback_version).toBeUndefined();
    expect(
      ctx.api.mock.calls.some(
        ([path]) => path === "/upstream-profile-candidates",
      ),
    ).toBe(false);
    expect(ctx.runtime.advancedFacts.value?.request).toEqual(
      body.advanced_playback,
    );
    expect(ctx.element.src).toContain("index.m3u8");
    const discovery = ctx.api.mock.calls.filter(
      ([path]) => path === "/playback-candidates",
    )[1][2];
    expect(discovery.advanced_playback).toEqual(body.advanced_playback);
    expect(discovery.http_file_capabilities_version).toBeUndefined();
  } finally {
    ctx.cleanup();
  }
});
it("keeps exact advanced request, key and generation across a lost response", async () => {
  const ctx = setup({ lost: true });
  try {
    await selectAdvanced(ctx);
    const loading = ctx.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1500);
    await loading;
    expect(ctx.advancedPosts()).toHaveLength(2);
    expect(JSON.stringify(ctx.advancedPosts()[0][2])).toBe(
      JSON.stringify(ctx.advancedPosts()[1][2]),
    );
  } finally {
    ctx.cleanup();
  }
});
it("rejects an old server dropping advanced intent before media binding", async () => {
  const ctx = setup({ dropEcho: true });
  try {
    await selectAdvanced(ctx);
    await expect(ctx.runtime.loadMedia()).rejects.toMatchObject({
      code: "STALE_CAPABILITY_REPORT",
    });
    expect(ctx.runtime.advancedFacts.value).toBeUndefined();
    expect(ctx.element.src).not.toContain("session-2");
  } finally {
    ctx.cleanup();
  }
});
it("never consumes a late plan after advanced input changes", async () => {
  const ctx = setup({ defer: true });
  try {
    await selectAdvanced(ctx);
    const loading = ctx.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.advancedPosts()).toHaveLength(1);
    ctx.runtime.burnInSubtitleIndex.value = undefined;
    ctx.resolve();
    await loading;
    expect(ctx.runtime.advancedFacts.value).toBeUndefined();
    expect(ctx.element.src).not.toContain("session-2");
  } finally {
    ctx.cleanup();
  }
});
it("clears transform preferences and discovery facts on source or login change", async () => {
  const ctx = setup();
  try {
    await selectAdvanced(ctx);
    ctx.state.value.media_generation++;
    expect(ctx.runtime.advancedCapabilities.value).toBeUndefined();
    expect(ctx.runtime.toneMapHdr.value).toBe(false);
    expect(ctx.runtime.burnInSubtitleIndex.value).toBeUndefined();
    await ctx.runtime.loadMedia();
    ctx.session.epoch++;
    expect(ctx.runtime.advancedCapabilities.value).toBeUndefined();
  } finally {
    ctx.cleanup();
  }
});
it("stops before advanced admission when a deferred discovery loses its current intent", async () => {
  const ctx = setup({ deferProbe: true });
  try {
    await selectAdvanced(ctx);
    const loading = ctx.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    ctx.runtime.toneMapHdr.value = false;
    ctx.runtime.burnInSubtitleIndex.value = undefined;
    ctx.resolveProbe({
      schema_version: 1,
      binding: "advanced-binding",
      candidates: [candidate],
      advanced_playback: caps,
    });
    await loading;
    expect(ctx.advancedPosts()).toHaveLength(0);
  } finally {
    ctx.cleanup();
  }
});
