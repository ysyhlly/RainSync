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
import { summarizePlaybackPlan } from "../apps/web/src/features/playback/playback-summary";
import { RequestFailure } from "../apps/web/src/errors";
import {
  detectUpstreamProfileReport,
  isUpstreamProfileEnvelope,
  matchesUpstreamProfilePlan,
} from "../packages/player-core";

const hls = vi.hoisted(() => ({
  supported: true,
  apiSupported: true,
  apiThrows: false,
  typeSupported: true,
  typeThrows: false,
  typeCalls: 0,
  source: undefined as (() => any) | undefined,
  decoderRecoveryEnabled: false,
  recovered: vi.fn(),
  loaded: vi.fn(),
  started: vi.fn(),
  handlers: [] as ((event: unknown, data: any) => void)[],
}));
vi.mock("hls.js", () => ({
  default: class {
    static Events = { ERROR: "error" };
    static isSupported = () => hls.supported;
    static isMSESupported = () => {
      if (hls.apiThrows) throw new Error("MSE API access failed");
      return hls.apiSupported;
    };
    static getMediaSource = () =>
      hls.source
        ? hls.source()
        : {
            isTypeSupported: () => {
              ++hls.typeCalls;
              if (hls.typeThrows) throw new Error("MSE sample probe failed");
              return hls.typeSupported;
            },
          };
    config = {};
    loadSource(url: string) {
      hls.loaded(url);
    }
    attachMedia() {}
    startLoad(position: number) {
      hls.started(position);
    }
    recoverMediaError() {
      if (!hls.decoderRecoveryEnabled) throw new Error("SDK recovery unavailable");
      hls.recovered();
    }
    stopLoad() {}
    destroy() {}
    on(_event: unknown, handler: (event: unknown, data: any) => void) {
      hls.handlers.push(handler);
    }
  },
}));
const positive = { supported: true, smooth: false, powerEfficient: false };
function profile(audio = true): any {
  return {
    profile_version: 1,
    profile_id: "avc_sdr_720p_v1",
    configuration_semantics: "upstream_transcode_profile_envelope",
    transport: "hls",
    container: "ts",
    requested_video: {
      codec: "h264",
      profile: "main",
      max_level: "3.1",
      max_width: 1280,
      max_height: 720,
      max_framerate: 30,
      max_bitrate: 4_000_000,
      requested_bit_depth: 8,
      requested_range: "SDR",
    },
    requested_audio: audio
      ? {
          codec: "aac",
          max_channels: 2,
          requested_sample_rate: 48000,
          max_bitrate: 128000,
        }
      : null,
    mse_sample: {
      video: {
        content_type: 'video/mp4; codecs="avc1.4d001f"',
        width: 1280,
        height: 720,
        bitrate: 4_000_000,
        framerate: 30,
      },
      audio: audio
        ? {
            content_type: 'audio/mp4; codecs="mp4a.40.2"',
            channels: "2",
            bitrate: 128000,
            samplerate: 48000,
          }
        : null,
    },
  };
}
const candidateSet = () => ({
  profile_version: 1,
  binding: "original-profile-binding",
  profile: profile(),
  decision_reason: "observed_metadata_and_requested_upstream_profile_envelope",
});
function embyProfile(audio = true, sourceRate = 44100): any {
  return {
    ...profile(audio),
    profile_version: 2,
    profile_id: "emby_avc_sdr_720p_rates_v2",
    ...(audio
      ? {
          audio_rate_contract: {
            allowed_sample_rates: [44100, 48000],
            source_sample_rate: sourceRate,
            mse_samples: [44100, 48000].map((samplerate) => ({
              ...profile().mse_sample.audio,
              samplerate,
            })),
          },
        }
      : {}),
  };
}
const embyCandidates = (audio = true, sourceRate = 44100): any => ({
  ...candidateSet(),
  profile_version: 2,
  profile: embyProfile(audio, sourceRate),
});
const legacy = () => ({
  schema_version: 1,
  binding: null,
  candidates: [],
  decision_reason: "provider_requires_legacy_negotiation",
});
const gate = <T = any>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function setup(
  options: {
    profileCandidates?: any;
    decodingInfo?: any;
    mode?: string;
    generic?: any;
    readyState?: number;
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
  const decodingInfo =
    options.decodingInfo ?? vi.fn().mockResolvedValue(positive);
  vi.stubGlobal("navigator", { mediaCapabilities: { decodingInfo } });
  vi.stubGlobal("location", { href: "http://localhost/rooms/room" });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  vi.stubGlobal("document", document);
  const candidates = options.profileCandidates ?? candidateSet();
  const frozenProfile = structuredClone(candidates.profile);
  const el: any = Object.assign(new EventTarget(), {
    src: "",
    error: null,
    readyState: options.readyState ?? 4,
    paused: true,
    seeking: false,
    currentTime: 0,
    playbackRate: 1,
    buffered: { length: 1, start: () => 0, end: () => 100 },
    seekable: { length: 1, start: () => 0, end: () => 100 },
    canPlayType: vi.fn(() => "probably"),
    querySelectorAll: () => [],
    load: vi.fn(),
    getAttribute: (name: string) => (name === "src" ? el.src : null),
    removeAttribute: (name: string) => {
      if (name === "src") el.src = "";
    },
    pause: () => {
      el.paused = true;
      el.dispatchEvent(new Event("pause"));
    },
    play: async () => {
      el.paused = false;
      el.dispatchEvent(new Event("playing"));
    },
  });
  const state = ref({
    room_id: "room",
    media_id: "media",
    media_generation: 1,
    revision: 1,
    playback_status: "paused",
    anchor_position_ms: 0,
    anchor_server_time_ms: 0,
    playback_rate: 1,
  });
  const api = vi.fn(
    async (path: string, method?: string, body?: any): Promise<any> => {
      if (path === "/playback-candidates") return options.generic ?? legacy();
      if (path === "/upstream-profile-candidates") return candidates;
      if (
        ["/playback-sessions", "/playback-sessions/upstream-profile"].includes(
          path,
        ) &&
        method === "POST"
      )
        return {
          session_id: `session-${body.plan_generation}`,
          plan_generation: body.plan_generation,
          media_id: state.value.media_id,
          media_generation: state.value.media_generation,
          delivery_mode: body.upstream_profile_report ? "transcode" : "direct",
          transport: body.upstream_profile_report ? "hls" : "progressive",
          playback_url: "/authorized",
          upstream_profile: body.upstream_profile_report
            ? structuredClone(frozenProfile)
            : undefined,
          timeline_origin_ms: 0,
          duration_ms: 100000,
          expires_in_seconds: 1800,
          rebuild_on_seek: false,
          audio_tracks: [],
          subtitle_tracks: [],
          observation_version: 1,
          observation_seq: 0,
          playback_metrics_version: 1,
          playback_metrics: {
            ...body.playback_metrics,
            metrics_seq: 0,
            closed: false,
          },
        };
      if (path.endsWith("/metrics"))
        return {
          session_id: path.split("/")[2],
          meter_start_generation: body.meter_start_generation,
          metrics_seq: body.seq,
          closed: body.final,
        };
      return {};
    },
  );
  const session = reactive({ user: { id: "user" }, epoch: 1, api });
  const connected = ref(true),
    active = ref(true);
  const clock = { ready: true, revision: 1, now: () => 0 };
  const scope = effectScope();
  const runtime = scope.run(() =>
    createPlaybackRuntime(
      playbackTestContext({
        session: session as any,
        state: state as any,
        connected,
        active,
        clock: clock as any,
      }),
    ),
  )!;
  const error = runtime.playbackError;
  runtime.attach(el);
  runtime.mode.value = options.mode ?? "transcode";
  const calls = (path: string) => api.mock.calls.filter(([p]) => p === path);
  return {
    api,
    candidates,
    session,
    state,
    connected,
    active,
    error,
    clock,
    document,
    decodingInfo,
    el,
    runtime,
    preflights: () => calls("/upstream-profile-candidates"),
    prepares: () => calls("/playback-sessions/upstream-profile"),
    ordinary: () =>
      calls("/playback-sessions").filter(([, method]) => method === "POST"),
    cleanup: () => scope.stop(),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  hls.supported = hls.typeSupported = true;
  hls.typeThrows = false;
  hls.apiSupported = true;
  hls.apiThrows = false;
  hls.typeCalls = 0;
  hls.source = undefined;
  hls.handlers.length = 0;
  hls.decoderRecoveryEnabled = false;
});

it("probes the exact factory advisory sample only through MSE, including known no-audio", async () => {
  const s = setup();
  try {
    await s.runtime.loadMedia();
    expect(s.preflights()[0][2]).toEqual({
      profile_version: 2,
      room_id: "room",
      media_generation: 1,
      audio_index: null,
      position_ms: 0,
    });
    expect(s.decodingInfo).toHaveBeenCalledTimes(1);
    expect(s.decodingInfo).toHaveBeenCalledWith({
      type: "media-source",
      video: {
        contentType: 'video/mp4; codecs="avc1.4d001f"',
        width: 1280,
        height: 720,
        bitrate: 4_000_000,
        framerate: 30,
      },
      audio: {
        contentType: 'audio/mp4; codecs="mp4a.40.2"',
        channels: "2",
        bitrate: 128000,
        samplerate: 48000,
      },
    });
    expect(s.prepares()[0][2].upstream_profile_report).toEqual({
      profile_version: 1,
      binding: "original-profile-binding",
      profile_id: "avc_sdr_720p_v1",
      mse_supported: true,
      mse_decoding: { supported: true, smooth: false, power_efficient: false },
    });
    expect(s.prepares()[0][2].candidate_report).toBeUndefined();
    expect(s.ordinary()).toHaveLength(0);
    expect(hls.loaded).toHaveBeenCalledWith("/authorized");
    expect(s.el.src).toBe(""); // Native HLS was positive, yet marked plans use MSE.
    expect(s.runtime.playbackSummary.value?.reason).toContain(
      "请求上游转码：最高720p SDR，H.264 / AAC；设备兼容性为估计",
    );
    const noAudio = { ...candidateSet(), profile: profile(false) };
    const decoder = vi.fn().mockResolvedValue(positive);
    expect(
      await detectUpstreamProfileReport(
        noAudio,
        { isTypeSupported: () => true },
        { decodingInfo: decoder },
      ),
    ).toBeDefined();
    expect(decoder.mock.calls[0][0].audio).toBeUndefined();
  } finally {
    s.cleanup();
  }
});

for (const mode of ["auto", "direct", "remux"]) {
  it(`keeps ${mode} on its existing negotiation path`, async () => {
    const s = setup({ mode });
    try {
      await s.runtime.loadMedia();
      expect(s.preflights()).toHaveLength(0);
      expect(s.ordinary()).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  });
}

it("keeps explicit local exact candidates on ordinary prepare", async () => {
  const s = setup({
    generic: {
      schema_version: 1,
      binding: "exact-binding",
      candidates: [
        {
          id: "transcode",
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
        },
      ],
    },
  });
  try {
    await s.runtime.loadMedia();
    expect(s.preflights()).toHaveLength(0);
    expect(s.ordinary()[0][2].candidate_report.binding).toBe("exact-binding");
  } finally {
    s.cleanup();
  }
});

for (const unmarked of ["absent", "404"]) {
  it(`allows legacy negotiation when profile preflight is ${unmarked}`, async () => {
    const s = setup({
      profileCandidates: {
        profile_version: 1,
        binding: null,
        profile: null,
        decision_reason: "legacy",
      },
    });
    try {
      if (unmarked === "404") {
        const original = s.api.getMockImplementation()!;
        s.api.mockImplementation(async (path, method, body) => {
          if (path === "/upstream-profile-candidates")
            throw new RequestFailure({ error: { code: "NOT_FOUND" } });
          return original(path, method, body);
        });
      }
      await s.runtime.loadMedia();
      expect(s.prepares()).toHaveLength(0);
      expect(s.ordinary()).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  });
}

for (const fault of [
  "version",
  "binding",
  "missing profile",
  "profile version",
  "AVC sample",
  "unknown field",
  "missing audio",
  "sample bounds",
]) {
  it(`fails marked ${fault} closed without a fresh preflight`, async () => {
    const candidates: any = candidateSet();
    if (fault === "version") candidates.profile_version = 2;
    if (fault === "binding") candidates.binding = null;
    if (fault === "missing profile") delete candidates.profile;
    if (fault === "profile version") candidates.profile.profile_version = 2;
    if (fault === "AVC sample")
      candidates.profile.mse_sample.video.content_type =
        'video/mp4; codecs="avc1.4d401f"';
    if (fault === "unknown field") candidates.profile.measured_output = true;
    if (fault === "missing audio") delete candidates.profile.requested_audio;
    if (fault === "sample bounds")
      candidates.profile.mse_sample.video.width = 640;
    const s = setup({ profileCandidates: candidates });
    try {
      await expect(s.runtime.loadMedia()).rejects.toThrow("候选无法安全使用");
      s.runtime.onClockReady();
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()).toHaveLength(0);
      expect(s.ordinary()).toHaveLength(0);
    } finally {
      s.cleanup();
    }
  });
}

for (const fault of [
  "MSE",
  "MSE throws",
  "negative",
  "throws",
  "malformed",
  "timeout",
]) {
  it(`requires positive MSE and media-source decoding evidence for ${fault}`, async () => {
    const pending = gate();
    const decodingInfo =
      fault === "timeout"
        ? vi.fn(() => pending.promise)
        : fault === "throws"
          ? vi.fn().mockRejectedValue(new Error("probe failed"))
          : vi
              .fn()
              .mockResolvedValue(
                fault === "negative"
                  ? { ...positive, supported: false }
                  : fault === "malformed"
                    ? { supported: true }
                    : positive,
              );
    const s = setup({ decodingInfo });
    try {
      if (fault === "MSE") hls.typeSupported = false;
      if (fault === "MSE throws") hls.typeThrows = true;
      const loading = s.runtime.loadMedia();
      const rejected = expect(loading).rejects.toThrow("候选无法安全使用");
      if (fault === "timeout") await vi.advanceTimersByTimeAsync(500);
      await rejected;
      if (fault === "timeout") {
        pending.resolve(positive);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(s.prepares()).toHaveLength(0);
      expect(s.ordinary()).toHaveLength(0);
      expect(s.preflights()).toHaveLength(1);
      expect(
        s.decodingInfo.mock.calls.every(
          ([config]: any[]) => config.type === "media-source",
        ),
      ).toBe(true);
    } finally {
      s.cleanup();
    }
  });
}

for (const fault of [
  "missing",
  "version",
  "id",
  "transport",
  "mode",
  "audio",
]) {
  it(`rejects ${fault} plan echo before attachment and cancels its key`, async () => {
    const s = setup();
    try {
      const original = s.api.getMockImplementation()!;
      s.api.mockImplementation(async (path, method, body) => {
        const plan = await original(path, method, body);
        if (path === "/playback-sessions/upstream-profile") {
          if (fault === "missing") delete plan.upstream_profile;
          if (fault === "version") plan.upstream_profile.profile_version = 2;
          if (fault === "id") plan.upstream_profile.profile_id = "different";
          if (fault === "transport") plan.transport = "progressive";
          if (fault === "mode") plan.delivery_mode = "direct";
          if (fault === "audio") plan.upstream_profile = profile(false);
        }
        return plan;
      });
      await expect(s.runtime.loadMedia()).rejects.toThrow();
      expect(s.prepares()).toHaveLength(1);
      expect(s.ordinary()).toHaveLength(0);
      expect(hls.loaded).not.toHaveBeenCalled();
      expect(s.runtime.sessionId.value).toBeNull();
      expect(
        s.api.mock.calls.some(
          ([path, method]) =>
            path ===
              `/playback-requests/${s.prepares()[0][2].idempotency_key}` &&
            method === "DELETE",
        ),
      ).toBe(true);
    } finally {
      s.cleanup();
    }
  });
}

for (const code of [
  "NOT_FOUND",
  "STALE_CAPABILITY_REPORT",
  "SOURCE_CHANGED",
  "SOURCE_ACCESS_REVOKED",
]) {
  it(`treats dedicated prepare ${code} as terminal`, async () => {
    const s = setup();
    try {
      const original = s.api.getMockImplementation()!;
      s.api.mockImplementation(async (path, method, body) => {
        if (path === "/playback-sessions/upstream-profile")
          throw new RequestFailure({
            error: { code, message: "reload required" },
          });
        return original(path, method, body);
      });
      await expect(s.runtime.loadMedia()).rejects.toThrow("reload required");
      s.runtime.onClockReady();
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()).toHaveLength(1);
      expect(s.ordinary()).toHaveLength(0);
    } finally {
      s.cleanup();
    }
  });
}

it("keeps original evidence and request identity across an uncertain dedicated POST", async () => {
  const s = setup();
  try {
    const original = s.api.getMockImplementation()!;
    const sent: any[] = [];
    s.api.mockImplementation(async (path, method, body) => {
      if (path === "/playback-sessions/upstream-profile") {
        sent.push(structuredClone(body));
        if (sent.length === 1) {
          body.upstream_profile_report.binding = "mutated-first-request";
          s.candidates.binding = "changed-source-binding";
          s.candidates.profile.mse_sample.video.width = 640;
          throw new TypeError("uncertain result");
        }
      }
      return original(path, method, body);
    });
    const loading = s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    await loading;
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(s.preflights()).toHaveLength(1);
    expect(s.decodingInfo).toHaveBeenCalledTimes(1);
    expect(s.ordinary()).toHaveLength(0);
  } finally {
    s.cleanup();
  }
});

it("retains same-plan HLS recovery and prevents decoder new grants or HTTP continuation", async () => {
  const s = setup();
  try {
    await s.runtime.loadMedia();
    const handler = hls.handlers[0];
    handler(null, {
      fatal: true,
      response: { code: 409 },
      type: "networkError",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runtime.sessionId.value).toBe("session-1");
    expect(hls.loaded).toHaveBeenCalledTimes(2);
    handler(null, {
      fatal: true,
      type: "mediaError",
      details: "decode failure",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.prepares()).toHaveLength(1);
    expect(s.preflights()).toHaveLength(1);
    expect(s.ordinary()).toHaveLength(0);
    expect(
      s.api.mock.calls.some(([path]) =>
        path.endsWith("http-file-continuation"),
      ),
    ).toBe(false);
    expect(s.error.value).toContain("decode failure");
    // A queued callback from the retired source cannot touch a replacement.
    await s.runtime.loadMedia();
    const count = hls.loaded.mock.calls.length;
    handler(null, { fatal: true, response: { code: 409 } });
    expect(hls.loaded).toHaveBeenCalledTimes(count);
  } finally {
    s.cleanup();
  }
});

it("rebuilds a clock-corrected target before the profile origin as a fresh seek intent", async () => {
  const s = setup();
  try {
    s.state.value.playback_status = "playing";
    s.clock.now = () => 10000;
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (path, method, body) => {
      if (method === "GET" && path.startsWith("/playback-sessions/session-")) {
        const generation = Number(/session-(\d+)/.exec(path)![1]);
        return {
          session_id: `session-${generation}`,
          plan_generation: generation,
          status: "ready",
          complete: true,
        };
      }
      const response = await original(path, method, body);
      if (path === "/upstream-profile-candidates")
        return {
          ...response,
          binding: `profile-binding-${s.preflights().length}`,
        };
      if (path === "/playback-sessions/upstream-profile")
        return {
          ...response,
          timeline_origin_ms: body.position_ms,
          rebuild_on_seek: true,
        };
      return response;
    });
    await s.runtime.loadMedia();
    const first = s.prepares()[0][2];
    expect(first.position_ms).toBe(10000);
    const oldHandler = hls.handlers[0];
    s.clock.ready = false;
    s.clock.revision++;
    s.runtime.onClockInvalidated();
    await s.runtime.applyState(true);
    s.clock.now = () => 0;
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.preflights()).toHaveLength(2);
    expect(s.prepares()).toHaveLength(2);
    const next = s.prepares()[1][2];
    expect(next.position_ms).toBe(0);
    expect(next.idempotency_key).not.toBe(first.idempotency_key);
    expect(next.plan_generation).toBe(first.plan_generation + 1);
    expect(next.upstream_profile_report.binding).toBe("profile-binding-2");
    expect(next.playback_metrics.meter_start_generation).toBe(
      next.plan_generation,
    );
    const calls = s.api.mock.calls;
    const stop = calls.findIndex(
      ([path, method]) =>
        path === "/playback-sessions/session-1" && method === "DELETE",
    );
    const prepare = calls.findIndex(
      ([path, method, body]) =>
        path === "/playback-sessions/upstream-profile" &&
        method === "POST" &&
        body.plan_generation === next.plan_generation,
    );
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(prepare);
    expect(s.runtime.sessionId.value).toBe("session-2");
    expect(s.ordinary()).toHaveLength(0);
    oldHandler(null, {
      fatal: true,
      type: "mediaError",
      details: "old decode",
    });
    hls.handlers.at(-1)!(null, {
      fatal: true,
      type: "mediaError",
      details: "current decode",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.prepares()).toHaveLength(2);
    expect(s.preflights()).toHaveLength(2);
    expect(s.error.value).toContain("current decode");
  } finally {
    s.cleanup();
  }
});

it("cannot extend the original discovery bound during preflight or retry", async () => {
  const s = setup();
  try {
    const pending = gate();
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (path, method, body) =>
      path === "/upstream-profile-candidates"
        ? pending.promise
        : original(path, method, body),
    );
    const loading = s.runtime.loadMedia();
    const rejected = expect(loading).rejects.toThrow("候选已失效");
    await vi.advanceTimersByTimeAsync(300000);
    pending.resolve(candidateSet());
    await rejected;
    expect(s.prepares()).toHaveLength(0);
    expect(s.ordinary()).toHaveLength(0);
    expect(s.preflights()).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it("cancels a pending profile probe when identity changes, including its late result", async () => {
  const pending = gate();
  const s = setup({ decodingInfo: vi.fn(() => pending.promise) });
  try {
    const loading = s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    s.session.epoch++;
    pending.resolve(positive);
    await loading;
    expect(s.prepares()).toHaveLength(0);
    expect(s.ordinary()).toHaveLength(0);
    expect(hls.loaded).not.toHaveBeenCalled();
  } finally {
    s.cleanup();
  }
});

it("keeps estimates separate from measured output in the summary", () => {
  expect(isUpstreamProfileEnvelope(profile())).toBe(true);
  const summary = summarizePlaybackPlan({
    delivery_mode: "transcode",
    upstream_profile: profile(),
  });
  expect(summary?.reason).toContain("请求");
  expect(summary?.reason).toContain("估计");
  expect(summary?.reason).not.toContain("已测量");
});

for (const response of [
  undefined,
  { schema_version: 2, binding: "unknown", candidates: [{}] },
]) {
  it("never treats a missing or unknown successful DTO as old-server absence", async () => {
    const s = setup();
    try {
      const original = s.api.getMockImplementation()!;
      s.api.mockImplementation(async (path, method, body) => {
        if (response === undefined && path === "/upstream-profile-candidates")
          return undefined;
        if (response && path === "/playback-candidates") return response;
        return original(path, method, body);
      });
      await expect(s.runtime.loadMedia()).rejects.toThrow("候选无法安全使用");
      expect(s.prepares()).toHaveLength(0);
      expect(s.ordinary()).toHaveLength(0);
    } finally {
      s.cleanup();
    }
  });
}

it("fails a preflight 405 closed", async () => {
  const s = setup();
  try {
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (path, method, body) => {
      if (path === "/upstream-profile-candidates")
        throw new RequestFailure({ error: { code: "METHOD_NOT_ALLOWED" } });
      return original(path, method, body);
    });
    await expect(s.runtime.loadMedia()).rejects.toThrow();
    expect(s.prepares()).toHaveLength(0);
    expect(s.ordinary()).toHaveLength(0);
  } finally {
    s.cleanup();
  }
});

it("ignores old HLS callbacks after authentication changes", async () => {
  const s = setup();
  try {
    await s.runtime.loadMedia();
    const handler = hls.handlers[0],
      loaded = hls.loaded.mock.calls.length;
    const metadata = s.el.onloadedmetadata;
    const ended = s.el.onended;
    s.session.epoch++;
    handler(null, {
      fatal: true,
      response: { code: 409 },
      type: "networkError",
    });
    handler(null, { fatal: true, type: "mediaError", details: "old failure" });
    metadata();
    s.el.ended = true;
    s.state.value.playback_status = "playing";
    ended();
    await vi.advanceTimersByTimeAsync(0);
    expect(hls.loaded).toHaveBeenCalledTimes(loaded);
    expect(s.error.value).toBe("");
    expect(s.prepares()).toHaveLength(1);
    expect(s.ordinary()).toHaveLength(0);
  } finally {
    s.cleanup();
  }
});

it("checks expiry before a repeated uncertain POST without a new preflight", async () => {
  const s = setup();
  try {
    const pending = gate(),
      original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (path, method, body) => {
      if (path === "/playback-sessions/upstream-profile") {
        await pending.promise;
        throw new TypeError("uncertain result");
      }
      return original(path, method, body);
    });
    const loading = s.runtime.loadMedia();
    const rejected = expect(loading).rejects.toThrow("候选已失效");
    await vi.advanceTimersByTimeAsync(0);
    // Simulate an elapsed monotonic interval after the original response was
    // claimed, before retrying. This does not change the authority-clock TTL.
    const now = vi.spyOn(performance, "now").mockReturnValue(300000);
    pending.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    now.mockRestore();
    expect(s.prepares()).toHaveLength(1);
    expect(s.preflights()).toHaveLength(1);
    expect(s.ordinary()).toHaveLength(0);
  } finally {
    s.cleanup();
  }
});

for (const fault of [
  "MSE API incomplete",
  "MSE API check throws",
  "MSE absent",
  "MSE method absent",
  "MSE access throws",
  "MSE method access throws",
  "navigator absent",
  "decoder absent",
  "decoder method absent",
  "decoder access throws",
  "decoder method access throws",
]) {
  it(`preserves unmarked legacy transcode/native HLS when availability is ${fault}`, async () => {
    const s = setup();
    try {
      const unreadable = (key: string) =>
        Object.defineProperty({}, key, {
          get: () => {
            throw new Error("API access failed");
          },
        });
      if (fault === "MSE absent") hls.source = () => undefined;
      if (fault === "MSE API incomplete") hls.apiSupported = false;
      if (fault === "MSE API check throws") hls.apiThrows = true;
      if (fault === "MSE method absent") hls.source = () => ({});
      if (fault === "MSE access throws")
        hls.source = () => {
          throw new Error("API access failed");
        };
      if (fault === "MSE method access throws")
        hls.source = () => unreadable("isTypeSupported");
      if (fault === "navigator absent") vi.stubGlobal("navigator", undefined);
      if (fault === "decoder absent") vi.stubGlobal("navigator", {});
      if (fault === "decoder method absent")
        vi.stubGlobal("navigator", { mediaCapabilities: {} });
      if (fault === "decoder access throws")
        vi.stubGlobal("navigator", unreadable("mediaCapabilities"));
      if (fault === "decoder method access throws")
        vi.stubGlobal("navigator", {
          mediaCapabilities: unreadable("decodingInfo"),
        });
      const original = s.api.getMockImplementation()!;
      s.api.mockImplementation(async (path, method, body) => {
        const response = await original(path, method, body);
        if (path === "/playback-sessions" && method === "POST") {
          response.delivery_mode = "transcode";
          response.transport = "hls";
        }
        return response;
      });
      await s.runtime.loadMedia();
      expect(s.preflights()).toHaveLength(0);
      expect(s.prepares()).toHaveLength(0);
      expect(s.ordinary()).toHaveLength(1);
      expect(s.ordinary()[0][2].mode).toBe("transcode");
      expect(s.ordinary()[0][2].upstream_profile_report).toBeUndefined();
      expect(s.el.src).toBe("/authorized");
      expect(hls.loaded).not.toHaveBeenCalled();
      expect(s.runtime.sessionId.value).toBe("session-1");
      expect(s.error.value).toBe("");
    } finally {
      s.cleanup();
    }
  });
}

it("checks availability without running a sample before the profile response", async () => {
  const s = setup();
  try {
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (path, method, body) => {
      if (path === "/upstream-profile-candidates") {
        expect(hls.typeCalls).toBe(0);
        expect(s.decodingInfo).not.toHaveBeenCalled();
      }
      return original(path, method, body);
    });
    await s.runtime.loadMedia();
    expect(s.preflights()).toHaveLength(1);
    expect(s.prepares()).toHaveLength(1);
    expect(s.decodingInfo).toHaveBeenCalledTimes(1);
  } finally {
    s.cleanup();
  }
});

for (const fault of [
  "MSE method missing",
  "MSE method access throws",
  "decoder method missing",
  "decoder method access throws",
]) {
  it(`fails ${fault} after profile negotiation without downgrading`, async () => {
    const s = setup();
    try {
      const mse: any = { isTypeSupported: () => true };
      const decoder: any = { decodingInfo: s.decodingInfo };
      hls.source = () => mse;
      vi.stubGlobal("navigator", { mediaCapabilities: decoder });
      const original = s.api.getMockImplementation()!;
      s.api.mockImplementation(async (path, method, body) => {
        if (path === "/upstream-profile-candidates") {
          const object = fault.startsWith("MSE") ? mse : decoder;
          const key = fault.startsWith("MSE")
            ? "isTypeSupported"
            : "decodingInfo";
          if (fault.endsWith("missing")) delete object[key];
          else
            Object.defineProperty(object, key, {
              get: () => {
                throw new Error("probe access failed");
              },
            });
        }
        return original(path, method, body);
      });
      await expect(s.runtime.loadMedia()).rejects.toThrow("候选无法安全使用");
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()).toHaveLength(0);
      expect(s.ordinary()).toHaveLength(0);
      expect(s.runtime.sessionId.value).toBeNull();
    } finally {
      s.cleanup();
    }
  });
}

it("cleans the legacy intent before a fresh user intent can opt into available APIs", async () => {
  const s = setup();
  try {
    vi.stubGlobal("navigator", {});
    await s.runtime.loadMedia();
    const previousKey = s.ordinary()[0][2].idempotency_key;
    await s.runtime.reset();
    expect(s.runtime.sessionId.value).toBeNull();
    expect(
      s.api.mock.calls.some(
        ([path, method]) =>
          path === `/playback-requests/${previousKey}` && method === "DELETE",
      ),
    ).toBe(true);
    vi.stubGlobal("navigator", {
      mediaCapabilities: { decodingInfo: s.decodingInfo },
    });
    await s.runtime.loadMedia();
    expect(s.ordinary()).toHaveLength(1);
    expect(s.preflights()).toHaveLength(1);
    expect(s.prepares()).toHaveLength(1);
    expect(s.prepares()[0][2].idempotency_key).not.toBe(previousKey);
    expect(s.runtime.sessionId.value).toBe("session-2");
  } finally {
    s.cleanup();
  }
});

for (const sourceRate of [44100, 48000]) {
  it(`requires both full AV rate estimates for an Emby ${sourceRate} Hz source`, async () => {
    const s = setup({ profileCandidates: embyCandidates(true, sourceRate) });
    try {
      await s.runtime.loadMedia();
      expect(s.preflights()[0][2].profile_version).toBe(2);
      expect(s.decodingInfo).toHaveBeenCalledTimes(2);
      for (const [index, samplerate] of [44100, 48000].entries()) {
        expect(s.decodingInfo.mock.calls[index][0]).toEqual({
          type: "media-source",
          video: {
            contentType: 'video/mp4; codecs="avc1.4d001f"',
            width: 1280,
            height: 720,
            bitrate: 4_000_000,
            framerate: 30,
          },
          audio: {
            contentType: 'audio/mp4; codecs="mp4a.40.2"',
            channels: "2",
            bitrate: 128000,
            samplerate,
          },
        });
      }
      const decoding = {
        supported: true,
        smooth: false,
        power_efficient: false,
      };
      expect(s.prepares()[0][2].upstream_profile_report).toEqual({
        profile_version: 2,
        binding: "original-profile-binding",
        profile_id: "emby_avc_sdr_720p_rates_v2",
        mse_supported: true,
        mse_decoding: decoding,
        audio_rate_reports: [44100, 48000].map((sample_rate) => ({
          sample_rate,
          mse_supported: true,
          mse_decoding: decoding,
        })),
      });
      expect(s.ordinary()).toHaveLength(0);
      expect(hls.loaded).toHaveBeenCalledWith("/authorized");
      expect(s.runtime.playbackSummary.value?.reason).toContain(
        "AAC（44.1或48 kHz）",
      );
      expect(s.runtime.playbackSummary.value?.reason).toContain("估计");
    } finally {
      s.cleanup();
    }
  });
}

it("probes silent v2 as video-only and requires an explicit empty rate report", async () => {
  const candidates = embyCandidates(false);
  const decodingInfo = vi.fn().mockResolvedValue(positive);
  const report = await detectUpstreamProfileReport(
    candidates,
    { isTypeSupported: () => true },
    { decodingInfo },
  );
  expect(isUpstreamProfileEnvelope(candidates.profile)).toBe(true);
  expect(decodingInfo).toHaveBeenCalledTimes(1);
  expect(decodingInfo.mock.calls[0][0].audio).toBeUndefined();
  expect(report?.audio_rate_reports).toEqual([]);
  expect(
    matchesUpstreamProfilePlan(report, candidates.profile, "transcode", "hls"),
  ).toBe(true);
  expect(
    matchesUpstreamProfilePlan(
      { ...report, audio_rate_reports: undefined } as any,
      candidates.profile,
      "transcode",
      "hls",
    ),
  ).toBe(false);
  expect(
    summarizePlaybackPlan({
      delivery_mode: "transcode",
      upstream_profile: candidates.profile,
    })?.reason,
  ).not.toMatch(/AAC|kHz/);
});

const malformedEmbyProfiles: [string, (profile: any) => void][] = [
  [
    "v1 discriminator",
    (p) => {
      p.profile_version = 1;
    },
  ],
  [
    "v1 identifier",
    (p) => {
      p.profile_id = "avc_sdr_720p_v1";
    },
  ],
  [
    "unknown version",
    (p) => {
      p.profile_version = 3;
    },
  ],
  [
    "unknown identifier",
    (p) => {
      p.profile_id += "_unknown";
    },
  ],
  [
    "missing contract",
    (p) => {
      delete p.audio_rate_contract;
    },
  ],
  [
    "null contract",
    (p) => {
      p.audio_rate_contract = null;
    },
  ],
  [
    "extra contract key",
    (p) => {
      p.audio_rate_contract.observed = true;
    },
  ],
  [
    "missing allowed rates",
    (p) => {
      delete p.audio_rate_contract.allowed_sample_rates;
    },
  ],
  [
    "single allowed rate",
    (p) => {
      p.audio_rate_contract.allowed_sample_rates = [48000];
    },
  ],
  [
    "extra allowed rate",
    (p) => {
      p.audio_rate_contract.allowed_sample_rates.push(96000);
    },
  ],
  [
    "duplicate allowed rate",
    (p) => {
      p.audio_rate_contract.allowed_sample_rates = [48000, 48000];
    },
  ],
  [
    "unsorted allowed rates",
    (p) => {
      p.audio_rate_contract.allowed_sample_rates.reverse();
    },
  ],
  [
    "negative allowed rate",
    (p) => {
      p.audio_rate_contract.allowed_sample_rates[0] = -44100;
    },
  ],
  [
    "string allowed rate",
    (p) => {
      p.audio_rate_contract.allowed_sample_rates[0] = "44100";
    },
  ],
  [
    "missing source rate",
    (p) => {
      delete p.audio_rate_contract.source_sample_rate;
    },
  ],
  [
    "unknown source rate",
    (p) => {
      p.audio_rate_contract.source_sample_rate = null;
    },
  ],
  [
    "out-of-contract source rate",
    (p) => {
      p.audio_rate_contract.source_sample_rate = 32000;
    },
  ],
  [
    "negative source rate",
    (p) => {
      p.audio_rate_contract.source_sample_rate = -48000;
    },
  ],
  [
    "fractional source rate",
    (p) => {
      p.audio_rate_contract.source_sample_rate = 44100.5;
    },
  ],
  [
    "missing samples",
    (p) => {
      delete p.audio_rate_contract.mse_samples;
    },
  ],
  [
    "single sample",
    (p) => {
      p.audio_rate_contract.mse_samples.pop();
    },
  ],
  [
    "extra sample",
    (p) => {
      p.audio_rate_contract.mse_samples.push({
        ...p.mse_sample.audio,
        samplerate: 96000,
      });
    },
  ],
  [
    "duplicate sample",
    (p) => {
      p.audio_rate_contract.mse_samples[0] =
        p.audio_rate_contract.mse_samples[1];
    },
  ],
  [
    "unsorted samples",
    (p) => {
      p.audio_rate_contract.mse_samples.reverse();
    },
  ],
  [
    "negative sample rate",
    (p) => {
      p.audio_rate_contract.mse_samples[0].samplerate = -44100;
    },
  ],
  [
    "wrong sample channels",
    (p) => {
      p.audio_rate_contract.mse_samples[0].channels = "6";
    },
  ],
  [
    "wrong sample codec",
    (p) => {
      p.audio_rate_contract.mse_samples[0].content_type =
        'audio/mp4; codecs="ac-3"';
    },
  ],
  [
    "wrong sample bitrate",
    (p) => {
      p.audio_rate_contract.mse_samples[0].bitrate = 192000;
    },
  ],
  [
    "extra sample key",
    (p) => {
      p.audio_rate_contract.mse_samples[0].measured = true;
    },
  ],
  [
    "missing sample key",
    (p) => {
      delete p.audio_rate_contract.mse_samples[0].channels;
    },
  ],
  [
    "conflicting advisory rate",
    (p) => {
      p.mse_sample.audio.samplerate = 44100;
    },
  ],
  [
    "conflicting requested rate",
    (p) => {
      p.requested_audio.requested_sample_rate = 44100;
    },
  ],
  [
    "contract on silent profile",
    (p) => {
      p.requested_audio = p.mse_sample.audio = null;
    },
  ],
];
for (const [fault, mutate] of malformedEmbyProfiles) {
  it(`rejects Emby ${fault} before probing or granting a session`, async () => {
    const candidates = embyCandidates();
    mutate(candidates.profile);
    expect(isUpstreamProfileEnvelope(candidates.profile)).toBe(false);
    const s = setup({ profileCandidates: candidates });
    try {
      await expect(s.runtime.loadMedia()).rejects.toThrow("候选无法安全使用");
      s.runtime.onClockReady();
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.decodingInfo).not.toHaveBeenCalled();
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()).toHaveLength(0);
      expect(s.ordinary()).toHaveLength(0);
    } finally {
      s.cleanup();
    }
  });
}

it("rejects a valid v2 envelope inside a v1 candidate-set discriminator", async () => {
  const candidates = { ...embyCandidates(), profile_version: 1 };
  const s = setup({ profileCandidates: candidates });
  try {
    await expect(s.runtime.loadMedia()).rejects.toThrow("候选无法安全使用");
    expect(s.decodingInfo).not.toHaveBeenCalled();
    expect(s.prepares()).toHaveLength(0);
    expect(s.ordinary()).toHaveLength(0);
  } finally {
    s.cleanup();
  }
});

for (const unsupportedRate of [44100, 48000]) {
  for (const fault of [
    "negative",
    "rejects",
    "throws",
    "malformed",
    "timeout",
  ]) {
    it(`fails closed when only the ${unsupportedRate} Hz AV estimate ${fault}`, async () => {
      const pending = gate();
      const decodingInfo = vi.fn((config: MediaDecodingConfiguration) => {
        if (config.audio?.samplerate !== unsupportedRate)
          return Promise.resolve(positive);
        if (fault === "throws") throw new Error("failed configuration");
        if (fault === "rejects")
          return Promise.reject(new Error("failed configuration"));
        if (fault === "timeout") return pending.promise;
        return Promise.resolve(
          fault === "negative"
            ? { ...positive, supported: false }
            : { supported: true },
        );
      });
      const s = setup({ profileCandidates: embyCandidates(), decodingInfo });
      try {
        const rejected = expect(s.runtime.loadMedia()).rejects.toThrow(
          "候选无法安全使用",
        );
        if (fault === "timeout") await vi.advanceTimersByTimeAsync(500);
        await rejected;
        pending.resolve(positive);
        s.runtime.onClockReady();
        await vi.advanceTimersByTimeAsync(1000);
        expect(decodingInfo).toHaveBeenCalledTimes(2);
        expect(s.preflights()).toHaveLength(1);
        expect(s.prepares()).toHaveLength(0);
        expect(s.ordinary()).toHaveLength(0);
        expect(hls.loaded).not.toHaveBeenCalled();
      } finally {
        s.cleanup();
      }
    });
  }
}

for (const failedCall of [1, 2, 3, 4]) {
  it(`requires positive MSE for each rate's AV sample (probe ${failedCall})`, async () => {
    const decodingInfo = vi.fn().mockResolvedValue(positive);
    let count = 0;
    const report = await detectUpstreamProfileReport(
      embyCandidates(),
      {
        isTypeSupported: () => ++count !== failedCall,
      },
      { decodingInfo },
    );
    expect(report).toBeUndefined();
    expect(decodingInfo).not.toHaveBeenCalled();
  });
}

it("keeps canonical rate order when 48 kHz resolves before 44.1 kHz", async () => {
  const pending = gate();
  const decodingInfo = vi.fn((config: MediaDecodingConfiguration) =>
    config.audio?.samplerate === 44100
      ? pending.promise
      : Promise.resolve({ ...positive, smooth: true }),
  );
  const result = detectUpstreamProfileReport(
    embyCandidates(),
    { isTypeSupported: () => true },
    { decodingInfo },
  );
  await Promise.resolve();
  pending.resolve(positive);
  const report = await result;
  expect(report?.audio_rate_reports?.map((rate) => rate.sample_rate)).toEqual([
    44100, 48000,
  ]);
  expect(
    report?.audio_rate_reports?.map((rate) => rate.mse_decoding?.smooth),
  ).toEqual([false, true]);
  expect(report?.mse_decoding?.smooth).toBe(true);
});

const malformedRateReports: [string, (report: any) => void][] = [
  [
    "absent",
    (r) => {
      delete r.audio_rate_reports;
    },
  ],
  [
    "null",
    (r) => {
      r.audio_rate_reports = null;
    },
  ],
  [
    "empty",
    (r) => {
      r.audio_rate_reports = [];
    },
  ],
  [
    "single",
    (r) => {
      r.audio_rate_reports.pop();
    },
  ],
  [
    "extra",
    (r) => {
      r.audio_rate_reports.push({
        ...r.audio_rate_reports[1],
        sample_rate: 96000,
      });
    },
  ],
  [
    "duplicate",
    (r) => {
      r.audio_rate_reports[0] = r.audio_rate_reports[1];
    },
  ],
  [
    "unsorted",
    (r) => {
      r.audio_rate_reports.reverse();
    },
  ],
  [
    "unknown rate",
    (r) => {
      r.audio_rate_reports[0].sample_rate = 32000;
    },
  ],
  [
    "negative rate",
    (r) => {
      r.audio_rate_reports[0].sample_rate = -44100;
    },
  ],
  [
    "missing rate",
    (r) => {
      delete r.audio_rate_reports[0].sample_rate;
    },
  ],
  [
    "extra entry field",
    (r) => {
      r.audio_rate_reports[0].file_decoding = r.mse_decoding;
    },
  ],
  [
    "negative MSE",
    (r) => {
      r.audio_rate_reports[0].mse_supported = false;
    },
  ],
  [
    "missing MSE",
    (r) => {
      delete r.audio_rate_reports[0].mse_supported;
    },
  ],
  [
    "missing estimate",
    (r) => {
      delete r.audio_rate_reports[0].mse_decoding;
    },
  ],
  [
    "negative estimate",
    (r) => {
      r.audio_rate_reports[0].mse_decoding.supported = false;
    },
  ],
  [
    "malformed estimate",
    (r) => {
      delete r.audio_rate_reports[0].mse_decoding.smooth;
    },
  ],
  [
    "extra estimate field",
    (r) => {
      r.audio_rate_reports[0].mse_decoding.observed = true;
    },
  ],
  [
    "unknown top field",
    (r) => {
      r.measured_output = true;
    },
  ],
  [
    "v1 version",
    (r) => {
      r.profile_version = 1;
    },
  ],
  [
    "v1 identifier",
    (r) => {
      r.profile_id = "avc_sdr_720p_v1";
    },
  ],
];
for (const [fault, mutate] of malformedRateReports) {
  it(`rejects ${fault} rate evidence even when the top-level 48 kHz estimate is positive`, async () => {
    const candidates = embyCandidates();
    const report = await detectUpstreamProfileReport(
      candidates,
      { isTypeSupported: () => true },
      { decodingInfo: async () => positive },
    );
    expect(
      matchesUpstreamProfilePlan(
        report,
        candidates.profile,
        "transcode",
        "hls",
      ),
    ).toBe(true);
    mutate(report);
    expect(
      matchesUpstreamProfilePlan(
        report,
        candidates.profile,
        "transcode",
        "hls",
      ),
    ).toBe(false);
  });
}

it("keeps v2 contract and report fields absent from v1", async () => {
  const candidates = candidateSet();
  const report = await detectUpstreamProfileReport(
    candidates,
    { isTypeSupported: () => true },
    { decodingInfo: async () => positive },
  );
  expect(report).not.toHaveProperty("audio_rate_reports");
  expect(
    matchesUpstreamProfilePlan(report, candidates.profile, "transcode", "hls"),
  ).toBe(true);
  expect(
    matchesUpstreamProfilePlan(
      { ...report, audio_rate_reports: [] } as any,
      candidates.profile,
      "transcode",
      "hls",
    ),
  ).toBe(false);
  candidates.profile.audio_rate_contract = embyProfile().audio_rate_contract;
  expect(isUpstreamProfileEnvelope(candidates.profile)).toBe(false);
});

for (const fault of [
  "source rate",
  "downgrade",
  "missing contract",
  "extra field",
  "no audio",
]) {
  it(`rejects v2 ${fault} plan changes without attaching, rediscovery or ordinary fallback`, async () => {
    const s = setup({ profileCandidates: embyCandidates() });
    try {
      const original = s.api.getMockImplementation()!;
      s.api.mockImplementation(async (path, method, body) => {
        const plan = await original(path, method, body);
        if (path === "/playback-sessions/upstream-profile") {
          if (fault === "source rate")
            plan.upstream_profile.audio_rate_contract.source_sample_rate = 48000;
          if (fault === "downgrade") plan.upstream_profile = profile();
          if (fault === "missing contract")
            delete plan.upstream_profile.audio_rate_contract;
          if (fault === "extra field")
            plan.upstream_profile.audio_rate_contract.output_confirmed = true;
          if (fault === "no audio") plan.upstream_profile = embyProfile(false);
        }
        return plan;
      });
      await expect(s.runtime.loadMedia()).rejects.toThrow();
      s.runtime.onClockReady();
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()).toHaveLength(1);
      expect(s.ordinary()).toHaveLength(0);
      expect(hls.loaded).not.toHaveBeenCalled();
      expect(s.runtime.sessionId.value).toBeNull();
    } finally {
      s.cleanup();
    }
  });
}

it("keeps v2 rate evidence and request identity across an uncertain dedicated POST", async () => {
  const s = setup({ profileCandidates: embyCandidates() });
  try {
    const original = s.api.getMockImplementation()!;
    const sent: any[] = [];
    s.api.mockImplementation(async (path, method, body) => {
      if (path === "/playback-sessions/upstream-profile") {
        sent.push(structuredClone(body));
        if (sent.length === 1) {
          body.upstream_profile_report.audio_rate_reports.reverse();
          s.candidates.profile.audio_rate_contract.source_sample_rate = 48000;
          throw new TypeError("uncertain result");
        }
      }
      return original(path, method, body);
    });
    const loading = s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    await loading;
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(s.decodingInfo).toHaveBeenCalledTimes(2);
    expect(s.preflights()).toHaveLength(1);
    expect(s.ordinary()).toHaveLength(0);
  } finally {
    s.cleanup();
  }
});

it("never turns a v2 decoder failure into a new grant or HTTP continuation", async () => {
  const s = setup({ profileCandidates: embyCandidates() });
  try {
    await s.runtime.loadMedia();
    hls.handlers[0](null, {
      fatal: true,
      type: "mediaError",
      details: "v2 decode failure",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.error.value).toContain("v2 decode failure");
    expect(s.preflights()).toHaveLength(1);
    expect(s.prepares()).toHaveLength(1);
    expect(s.ordinary()).toHaveLength(0);
    expect(
      s.api.mock.calls.some(([path]) =>
        path.endsWith("http-file-continuation"),
      ),
    ).toBe(false);
  } finally {
    s.cleanup();
  }
});

it("cancels both v2 estimates when identity changes without accepting a late second rate", async () => {
  const pending = gate();
  const decodingInfo = vi.fn((configuration: MediaDecodingConfiguration) =>
    configuration.audio?.samplerate === 44100
      ? Promise.resolve(positive)
      : pending.promise,
  );
  const s = setup({ profileCandidates: embyCandidates(), decodingInfo });
  try {
    const loading = s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    s.session.epoch++;
    pending.resolve(positive);
    await loading;
    expect(s.prepares()).toHaveLength(0);
    expect(s.ordinary()).toHaveLength(0);
    expect(hls.loaded).not.toHaveBeenCalled();
  } finally {
    s.cleanup();
  }
});

it("spends only two decoder recoveries on the same upstream grant without re-negotiating", async () => {
  hls.decoderRecoveryEnabled = true;
  const s = setup();
  try {
    await s.runtime.loadMedia();
    const handler = hls.handlers[0];
    const fatal = { fatal: true, type: "mediaError", details: "bounded decoder failure" };
    handler(null, fatal); handler(null, fatal);
    expect(hls.recovered).toHaveBeenCalledTimes(2);
    expect(s.prepares()).toHaveLength(1);
    expect(s.preflights()).toHaveLength(1);
    handler(null, fatal);
    await vi.advanceTimersByTimeAsync(0);
    expect(hls.recovered).toHaveBeenCalledTimes(2);
    expect(s.prepares()).toHaveLength(1);
    expect(s.ordinary()).toHaveLength(0);
    expect(s.error.value).toContain("bounded decoder failure");
  } finally { s.cleanup(); }
});
