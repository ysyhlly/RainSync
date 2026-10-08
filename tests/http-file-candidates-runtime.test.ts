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
import { RequestFailure } from "../apps/web/src/errors";
import {
  detectCandidateReport,
  detectCapabilitiesAsync,
} from "../packages/player-core";

const reportFault = vi.hoisted(() => ({ value: "" }));
vi.mock("../packages/player-core", async (original) => {
  const actual = await original<any>();
  return {
    ...actual,
    detectCandidateReport: vi.fn((...args) => {
      if (reportFault.value === "missing") return Promise.resolve(undefined);
      if (reportFault.value === "throw")
        throw new Error("device report failed");
      return actual.detectCandidateReport(...args);
    }),
    detectCapabilitiesAsync: vi.fn(actual.detectCapabilitiesAsync),
  };
});
const hls = vi.hoisted(() => ({
  supported: true,
  handlers: [] as ((event: unknown, data: any) => void)[],
  loaded: vi.fn(),
  started: vi.fn(),
  destroyed: vi.fn(),
}));
vi.mock("hls.js", () => ({
  default: class {
    static Events = { ERROR: "error" };
    static isSupported = () => hls.supported;
    static isMSESupported = () => hls.supported;
    static getMediaSource = () => ({ isTypeSupported: () => true });
    config = {};
    loadSource(url: string) {
      hls.loaded(url);
    }
    attachMedia() {}
    startLoad(position: number) {
      hls.started(position);
    }
    stopLoad() {}
    destroy() {
      hls.destroyed();
    }
    on(_event: unknown, handler: (event: unknown, data: any) => void) {
      hls.handlers.push(handler);
    }
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  reportFault.value = "";
  hls.handlers.length = 0;
  hls.supported = true;
});
const gate = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (failure: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const supported = { supported: true, smooth: true, powerEfficient: false };
function candidateSet(binding = "original-http-binding", useHls = false): any {
  return {
    http_file_capabilities_version: 1,
    schema_version: 1,
    binding,
    decision_reason: "observed_http_binary",
    candidates: ["direct", "remux", "transcode"].map((id) => ({
      id,
      delivery_mode: id,
      transport: useHls && id !== "direct" ? "hls" : "progressive",
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
}
function setup(
  options: {
    candidates?: any;
    decodingInfo?: ReturnType<typeof vi.fn>;
    readyState?: number;
    directFallback?: boolean;
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
    options.decodingInfo ?? vi.fn().mockResolvedValue(supported);
  vi.stubGlobal("navigator", { mediaCapabilities: { decodingInfo } });
  vi.stubGlobal("location", { href: "http://localhost/rooms/room" });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  vi.stubGlobal("document", document);
  const candidates = options.candidates ?? candidateSet();
  const originalCandidates = structuredClone(candidates.candidates ?? []);
  const frames: ((time: number, metadata: any) => void)[] = [];
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
    requestVideoFrameCallback: (cb: (typeof frames)[number]) => {
      frames.push(cb);
      return frames.length;
    },
    cancelVideoFrameCallback: vi.fn(),
  });
  const api = vi.fn(
    async (path: string, method?: string, body?: any): Promise<any> => {
      if (path === "/playback-candidates") return candidates;
      if (path === "/playback-sessions" && method === "POST") {
        const candidate = originalCandidates.find(
          (c: any) =>
            !body.candidate_report?.excluded_candidates.includes(c.id),
        );
        return {
          session_id: `session-${body.plan_generation}`,
          plan_generation: body.plan_generation,
          media_id: state.value.media_id,
          media_generation: state.value.media_generation,
          delivery_mode: candidate?.delivery_mode ?? "direct",
          selected_candidate_id: candidate?.id,
          transport: candidate?.transport ?? "progressive",
          playback_url: `/authorized-${body.plan_generation}`,
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
          ...(options.directFallback && candidate?.id === "direct"
            ? {
                http_file_fallback_version: 1,
                decoder_fallback_modes: ["transcode"],
              }
            : {}),
        };
      }
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

  const active = ref(true),
    connected = ref(true);
  const clock = { ready: true, revision: 1, now: () => 0 };
  const scope = effectScope();
  const runtime = scope.run(() =>
    createPlaybackRuntime(
      playbackTestContext({
        session: session as any,
        state: state as any,
        clock: clock as any,
        connected,
        active,
      }),
    ),
  )!;
  const error = runtime.playbackError;
  runtime.attach(el);
  return {
    api,
    session,
    state,
    error,
    runtime,
    el,
    frames,
    active,
    connected,
    clock,
    candidates,
    decodingInfo,
    document,
    preflights: () =>
      api.mock.calls.filter(([path]) => path === "/playback-candidates"),
    prepares: () =>
      api.mock.calls.filter(
        ([path, method]) => path === "/playback-sessions" && method === "POST",
      ),
    metrics: () => api.mock.calls.filter(([path]) => path.endsWith("/metrics")),
    decode: async () => {
      el.error = { code: 3 };
      el.onerror?.();
      await vi.advanceTimersByTimeAsync(0);
    },
    cleanup: () => scope.stop(),
  };
}

it("retains one immutable HTTP preflight/report through finite independent decoder grants", async () => {
  const s = setup({ directFallback: true });
  try {
    await s.runtime.loadMedia();
    const original = structuredClone(s.prepares()[0][2].candidate_report);
    const probes = s.decodingInfo.mock.calls.length;
    expect(s.preflights()[0][2].http_file_capabilities_version).toBe(1);
    // Neither a later server response object nor a previously sent request may
    // mutate the original set or device report used by automatic recovery.
    s.candidates.binding = "changed-source-binding";
    s.candidates.candidates[0].id = "changed-source-route";
    s.prepares()[0][2].candidate_report.results[0].progressive = "unsupported";
    await s.decode();
    await s.decode();
    await s.decode();
    expect(s.preflights()).toHaveLength(1);
    expect(detectCandidateReport).toHaveBeenCalledTimes(1);
    expect(s.decodingInfo).toHaveBeenCalledTimes(probes);
    expect(s.prepares()).toHaveLength(3);
    expect(
      s
        .prepares()
        .slice(1)
        .map((call) => call[2].candidate_report),
    ).toEqual([
      { ...original, excluded_candidates: ["direct"] },
      { ...original, excluded_candidates: ["direct", "remux"] },
    ]);
    expect(s.prepares().map((call) => call[2].plan_generation)).toEqual([
      1, 2, 3,
    ]);
    expect(new Set(s.prepares().map((call) => call[2].viewer_id)).size).toBe(1);
    expect(
      s.api.mock.calls.some(([path]) =>
        path.endsWith("http-file-continuation"),
      ),
    ).toBe(false);
  } finally {
    s.cleanup();
  }
});

for (const code of [
  "SOURCE_CHANGED",
  "STALE_CAPABILITY_REPORT",
  "PLAYBACK_REQUEST_EXPIRED",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
]) {
  it(`fails ${code} closed with the original report, then permits an explicit fresh reload`, async () => {
    const s = setup();
    try {
      await s.runtime.loadMedia();
      const original = s.api.getMockImplementation()!;
      let rejectBound = true;
      s.api.mockImplementation(async (path, method, body) => {
        if (path === "/playback-candidates")
          return candidateSet("new-source-binding");
        if (path === "/playback-sessions" && method === "POST" && rejectBound)
          throw new RequestFailure({
            error: { code, message: "reload required" },
          });
        return original(path, method, body);
      });
      await s.decode();
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()).toHaveLength(2);
      expect(s.prepares()[1][2].candidate_report.binding).toBe(
        "original-http-binding",
      );
      expect(s.prepares()[1][2].candidate_report.excluded_candidates).toEqual([
        "direct",
      ]);
      expect(s.error.value).toBe("reload required");
      expect(s.runtime.sessionId.value).toBeNull();
      s.runtime.onClockReady();
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.prepares()).toHaveLength(2);
      rejectBound = false;
      await s.runtime.loadMedia();
      expect(s.preflights()).toHaveLength(2);
      expect(s.prepares()[2][2].candidate_report.binding).toBe(
        "new-source-binding",
      );
      expect(s.prepares()[2][2].candidate_report.excluded_candidates).toEqual(
        [],
      );
    } finally {
      s.cleanup();
    }
  });
}

it("retries an uncertain prepare with the same key and frozen report", async () => {
  const s = setup();
  try {
    const original = s.api.getMockImplementation()!;
    let failed = false;
    s.api.mockImplementation(async (path, method, body) => {
      if (path === "/playback-sessions" && method === "POST" && !failed) {
        failed = true;
        throw new TypeError("uncertain transport result");
      }
      return original(path, method, body);
    });
    const loading = s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    await loading;
    expect(s.preflights()).toHaveLength(1);
    expect(s.prepares()).toHaveLength(2);
    expect(s.prepares()[1][2]).toEqual(s.prepares()[0][2]);
  } finally {
    s.cleanup();
  }
});

it("the original five-minute bound ends new recovery without shortening a published grant", async () => {
  const s = setup();
  try {
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(300001);
    expect(s.runtime.sessionId.value).toBe("session-1");
    expect(s.el.src).toBe("/authorized-1");
    await s.decode();
    expect(s.preflights()).toHaveLength(1);
    expect(s.prepares()).toHaveLength(1);
    expect(s.error.value).toContain("候选已失效");
    await s.runtime.loadMedia();
    expect(s.preflights()).toHaveLength(2);
    expect(s.prepares()).toHaveLength(2);
  } finally {
    s.cleanup();
  }
});

it("preflight time cannot extend the five-minute recovery budget", async () => {
  const s = setup();
  try {
    const pending = gate<any>();
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (path, method, body) =>
      path === "/playback-candidates"
        ? pending.promise
        : original(path, method, body),
    );
    const loading = s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300001);
    pending.resolve(candidateSet());
    await expect(loading).rejects.toThrow("候选已失效");
    expect(s.prepares()).toHaveLength(0);
  } finally {
    s.cleanup();
  }
});

for (const [name, patch] of [
  ["unknown marker", { http_file_capabilities_version: 2 }],
  ["zero marker", { http_file_capabilities_version: 0 }],
  ["null marker", { http_file_capabilities_version: null }],
  ["unknown schema", { schema_version: 2 }],
  ["empty binding", { binding: "" }],
  ["whitespace binding", { binding: "  " }],
  ["missing binding", { binding: null }],
  ["empty candidates", { candidates: [] }],
  ["invalid candidates", { candidates: null }],
] as const) {
  it(`rejects a marked ${name} before a legacy device probe or ordinary prepare`, async () => {
    const s = setup({ candidates: { ...candidateSet(), ...patch } });
    try {
      await expect(s.runtime.loadMedia()).rejects.toThrow("候选无法安全使用");
      expect(s.prepares()).toHaveLength(0);
      expect(detectCandidateReport).not.toHaveBeenCalled();
      expect(detectCapabilitiesAsync).not.toHaveBeenCalled();
      expect(s.decodingInfo).not.toHaveBeenCalled();
    } finally {
      s.cleanup();
    }
  });
}

for (const failure of ["missing", "throw"]) {
  it(`fails closed when marked report production is ${failure}`, async () => {
    const s = setup();
    reportFault.value = failure;
    try {
      await expect(s.runtime.loadMedia()).rejects.toThrow();
      expect(s.prepares()).toHaveLength(0);
      expect(detectCapabilitiesAsync).not.toHaveBeenCalled();
      expect(s.preflights()).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  });
}

it("manual direct omits HTTP opt-in, and an old-server 404 keeps ordinary preparation", async () => {
  const legacy = candidateSet();
  delete legacy.http_file_capabilities_version;
  const s = setup({ candidates: legacy });
  try {
    s.runtime.mode.value = "direct";
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (path, method, body) => {
      if (path === "/playback-candidates")
        throw new RequestFailure({ error: { code: "NOT_FOUND" } });
      return original(path, method, body);
    });
    await s.runtime.loadMedia();
    expect(s.preflights()[0][2]).not.toHaveProperty(
      "http_file_capabilities_version",
    );
    expect(s.prepares()[0][2].mode).toBe("direct");
    expect(s.prepares()[0][2]).not.toHaveProperty("candidate_report");
    await s.decode();
    expect(s.prepares()).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it("manual direct refuses an unexpected HTTP binding before preparing it", async () => {
  const s = setup();
  try {
    s.runtime.mode.value = "direct";
    await expect(s.runtime.loadMedia()).rejects.toThrow("候选无法安全使用");
    expect(s.preflights()[0][2]).not.toHaveProperty(
      "http_file_capabilities_version",
    );
    expect(s.prepares()).toHaveLength(0);
    expect(detectCandidateReport).not.toHaveBeenCalled();
  } finally {
    s.cleanup();
  }
});

for (const mode of ["auto", "remux", "transcode"]) {
  it(`${mode} opts in while an old-server candidate 404 retains legacy preparation`, async () => {
    const s = setup();
    try {
      s.runtime.mode.value = mode;
      const original = s.api.getMockImplementation()!;
      s.api.mockImplementation(async (path, method, body) => {
        if (
          ["/playback-candidates", "/upstream-profile-candidates"].includes(
            path,
          )
        )
          throw new RequestFailure({ error: { code: "NOT_FOUND" } });
        return original(path, method, body);
      });
      await s.runtime.loadMedia();
      expect(s.preflights()[0][2].http_file_capabilities_version).toBe(1);
      expect(s.prepares()[0][2].mode).toBe(mode);
      expect(s.prepares()[0][2]).not.toHaveProperty("candidate_report");
      expect(detectCapabilitiesAsync).toHaveBeenCalledTimes(1);
      expect(
        s.api.mock.calls.filter(
          ([path]) => path === "/upstream-profile-candidates",
        ),
      ).toHaveLength(mode === "transcode" ? 1 : 0);
    } finally {
      s.cleanup();
    }
  });
}

for (const field of ["mode", "audio"]) {
  it(`a published ${field} change cannot reuse the old HTTP snapshot after switching back`, async () => {
    const s = setup();
    try {
      await s.runtime.loadMedia();
      if (field === "mode") {
        s.runtime.mode.value = "direct";
        s.runtime.mode.value = "auto";
      } else {
        s.runtime.audioIndex.value = 1;
        s.runtime.audioIndex.value = undefined;
      }
      await s.decode();
      expect(s.prepares()).toHaveLength(1);
      await s.runtime.loadMedia();
      expect(s.preflights()).toHaveLength(2);
      expect(s.prepares()).toHaveLength(2);
      expect(s.prepares()[1][2].candidate_report.excluded_candidates).toEqual(
        [],
      );
    } finally {
      s.cleanup();
    }
  });
}

it("unmarked local/Agent responses retain the original concrete discovery", async () => {
  const legacy = candidateSet("local-stat-binding");
  delete legacy.http_file_capabilities_version;
  const s = setup({ candidates: legacy });
  try {
    await s.runtime.loadMedia();
    await s.decode();
    expect(s.preflights()).toHaveLength(1);
    expect(s.prepares()[1][2].candidate_report.binding).toBe(
      "local-stat-binding",
    );
    expect(s.prepares()[1][2].candidate_report.excluded_candidates).toEqual([
      "direct",
    ]);
  } finally {
    s.cleanup();
  }
});

it("marked HTTP MediaError 4 alone does not create a decoder grant or preflight", async () => {
  const s = setup();
  try {
    await s.runtime.loadMedia();
    s.el.error = { code: 4 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.preflights()).toHaveLength(1);
    expect(s.prepares()).toHaveLength(1);
    expect(s.error.value).toContain("媒体加载或格式支持状态未知");
    await s.decode();
    expect(s.prepares()).toHaveLength(2);
    expect(s.prepares()[1][2].candidate_report.excluded_candidates).toEqual([
      "direct",
    ]);
  } finally {
    s.cleanup();
  }
});

for (const phase of ["preflight", "device"]) {
  it(`clock deferral during ${phase} shares one in-flight HTTP discovery`, async () => {
    const pending = gate<any>();
    const decoder = vi.fn(() =>
      phase === "device" ? pending.promise : Promise.resolve(supported),
    );
    const s = setup({ decodingInfo: decoder });
    try {
      const original = s.api.getMockImplementation()!;
      if (phase === "preflight")
        s.api.mockImplementation(async (path, method, body) =>
          path === "/playback-candidates"
            ? pending.promise
            : original(path, method, body),
        );
      const loading = s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(0);
      s.clock.ready = false;
      s.clock.revision++;
      s.runtime.onClockInvalidated();
      s.clock.ready = true;
      s.runtime.onClockReady();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.preflights()).toHaveLength(1);
      pending.resolve(phase === "preflight" ? candidateSet() : supported);
      await loading;
      await vi.advanceTimersByTimeAsync(0);
      expect(s.preflights()).toHaveLength(1);
      expect(detectCandidateReport).toHaveBeenCalledTimes(1);
      expect(s.prepares()).toHaveLength(1);
      expect(s.prepares()[0][2].playback_metrics.meter_start_generation).toBe(
        1,
      );
    } finally {
      s.cleanup();
    }
  });
}

for (const readyBeforeReply of [false, true]) {
  it(`clock recalibration ${readyBeforeReply ? "before" : "after"} a claimed reply retains its admitted key/generation`, async () => {
    const s = setup();
    const pending = gate();
    try {
      const original = s.api.getMockImplementation()!;
      const highWater = new Map<number, string>();
      s.api.mockImplementation(async (path, method, body) => {
        if (path === "/playback-sessions" && method === "POST") {
          const key = highWater.get(body.plan_generation);
          if (key && key !== body.idempotency_key)
            throw new RequestFailure({
              error: { code: "STALE_PLAYBACK_PLAN" },
            });
          highWater.set(body.plan_generation, body.idempotency_key);
          const plan = await original(path, method, body);
          await pending.promise;
          return { ...plan, rebuild_on_seek: true };
        }
        if (
          path.startsWith("/playback-sessions/session-1?") &&
          method === "GET"
        )
          return {
            session_id: "session-1",
            plan_generation: 1,
            status: "ready",
            complete: true,
          };
        return original(path, method, body);
      });
      const loading = s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.prepares()).toHaveLength(1);
      s.clock.ready = false;
      s.clock.revision++;
      s.runtime.onClockInvalidated();
      if (readyBeforeReply) {
        s.clock.ready = true;
        s.runtime.onClockReady();
        await vi.advanceTimersByTimeAsync(0);
      }
      pending.resolve();
      await loading;
      if (!readyBeforeReply) {
        s.clock.ready = true;
        s.runtime.onClockReady();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()).toHaveLength(1);
      expect(s.runtime.sessionId.value).toBe("session-1");
      expect(s.error.value).toBe("");
      expect(s.prepares()[0][2].playback_metrics.meter_start_generation).toBe(
        1,
      );
      expect(
        s.api.mock.calls.some(([path]) =>
          path.startsWith("/playback-requests/"),
        ),
      ).toBe(false);
    } finally {
      s.cleanup();
    }
  });
}

for (const phase of ["preflight", "device"]) {
  it(`a late old ${phase} cannot replace a newer intent's HTTP snapshot or grant`, async () => {
    const pending = gate<any>();
    const decoder = vi.fn().mockResolvedValue(supported);
    if (phase === "device")
      decoder.mockImplementationOnce(() => pending.promise);
    const s = setup({ decodingInfo: decoder });
    try {
      const original = s.api.getMockImplementation()!;
      let calls = 0;
      s.api.mockImplementation(async (path, method, body) => {
        if (path === "/playback-candidates") {
          if (++calls === 1 && phase === "preflight") return pending.promise;
          return candidateSet(calls === 1 ? "old-binding" : "new-binding");
        }
        return original(path, method, body);
      });
      const old = s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(0);
      await s.runtime.loadMedia();
      pending.resolve(
        phase === "preflight" ? candidateSet("old-binding") : supported,
      );
      await old;
      expect(s.prepares()).toHaveLength(1);
      expect(s.prepares()[0][2].candidate_report.binding).toBe("new-binding");
      expect(s.el.src).toBe("/authorized-2");
      await s.decode();
      expect(s.preflights()).toHaveLength(2);
      expect(s.prepares()[1][2].candidate_report.binding).toBe("new-binding");
    } finally {
      s.cleanup();
    }
  });
}

for (const fence of [
  "mode",
  "audio",
  "media",
  "generation",
  "room",
  "lifecycle",
  "login",
  "epoch",
  "stop",
  "dispose",
]) {
  it(`${fence} invalidation prevents a held HTTP preflight from creating a grant`, async () => {
    const s = setup();
    const pending = gate<any>();
    try {
      const original = s.api.getMockImplementation()!;
      s.api.mockImplementation(async (path, method, body) =>
        path === "/playback-candidates"
          ? pending.promise
          : original(path, method, body),
      );
      const loading = s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(0);
      switch (fence) {
        case "mode":
          s.runtime.mode.value = "direct";
          s.runtime.mode.value = "auto";
          break;
        case "audio":
          s.runtime.audioIndex.value = 1;
          s.runtime.audioIndex.value = undefined;
          break;
        case "media":
          s.state.value.media_id = "other";
          break;
        case "generation":
          s.state.value.media_generation++;
          break;
        case "room":
          s.state.value.room_id = "other";
          break;
        case "lifecycle":
          s.active.value = false;
          s.active.value = true;
          break;
        case "login":
          s.session.user.id = "other";
          break;
        case "epoch":
          s.session.epoch++;
          break;
        case "stop":
          await s.runtime.reset();
          break;
        case "dispose":
          s.cleanup();
          break;
      }
      pending.resolve(candidateSet());
      await loading;
      s.runtime.onClockReady();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.prepares()).toHaveLength(0);
      expect(detectCandidateReport).not.toHaveBeenCalled();
    } finally {
      s.cleanup();
    }
  });
}

it("an aborted old mode probe cannot surface a late failure on the current intent", async () => {
  const s = setup();
  const pending = gate<any>();
  try {
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (path, method, body) =>
      path === "/playback-candidates"
        ? pending.promise
        : original(path, method, body),
    );
    const loading = s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(0);
    s.runtime.mode.value = "direct";
    pending.reject(new DOMException("old probe aborted", "AbortError"));
    await expect(loading).resolves.toBeUndefined();
    expect(s.error.value).toBe("");
    expect(s.prepares()).toHaveLength(0);
  } finally {
    s.cleanup();
  }
});

it("native→MSE and same-plan range recovery retain the snapshot and finite route history", async () => {
  const s = setup({ candidates: candidateSet("original-http-binding", true) });
  try {
    await s.runtime.loadMedia();
    await s.decode();
    expect(s.prepares()[1][2].candidate_report.excluded_candidates).toEqual([
      "direct",
    ]);
    s.el.error = { code: 4 };
    s.el.onerror(); // Ambiguous native → MSE retains grant 2.
    await vi.advanceTimersByTimeAsync(0);
    expect(s.prepares()).toHaveLength(2);
    const oldError = hls.handlers.at(-1)!;
    oldError(undefined, {
      fatal: true,
      type: "networkError",
      response: { code: 409 },
    });
    expect(s.prepares()).toHaveLength(2);
    expect(hls.started).toHaveBeenCalled();
    oldError(undefined, {
      fatal: true,
      type: "networkError",
      response: { code: 401 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.prepares()).toHaveLength(2);
    expect(s.preflights()).toHaveLength(1);
    oldError(undefined, { fatal: true, type: "mediaError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.prepares()).toHaveLength(3);
    oldError(undefined, { fatal: true, type: "mediaError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.prepares()).toHaveLength(3);
    expect(s.preflights()).toHaveLength(1);
    expect(s.prepares()[2][2].candidate_report.excluded_candidates).toEqual([
      "direct",
      "remux",
    ]);
  } finally {
    s.cleanup();
  }
});

it("a newly authorized decoder grant gets its own loading budget and fences old data callbacks", async () => {
  const s = setup({ readyState: 0 });
  try {
    await s.runtime.loadMedia();
    const oldLoaded = s.el.onloadeddata;
    await vi.advanceTimersByTimeAsync(12000);
    await s.decode();
    s.el.readyState = 2;
    oldLoaded();
    s.el.readyState = 0;
    await vi.advanceTimersByTimeAsync(19999);
    expect(s.error.value).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.error.value).toContain("媒体数据加载超时");
    expect(s.preflights()).toHaveLength(1);
    expect(s.prepares()).toHaveLength(2);
  } finally {
    s.cleanup();
  }
});

it("native→MSE and same-plan range recovery retain the attached plan's cumulative loading budget", async () => {
  const candidates = candidateSet("original-http-binding", true);
  candidates.candidates.shift();
  const s = setup({ readyState: 0, candidates });
  try {
    await s.runtime.loadMedia();
    const oldLoaded = s.el.onloadeddata;
    await vi.advanceTimersByTimeAsync(12000);
    await s.decode(); // Same-grant native → MSE.
    await vi.advanceTimersByTimeAsync(4000);
    hls.handlers.at(-1)!(undefined, {
      fatal: true,
      type: "networkError",
      response: { code: 409 },
    });
    s.el.readyState = 2;
    oldLoaded();
    s.el.readyState = 0;
    await vi.advanceTimersByTimeAsync(3999);
    expect(s.error.value).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.error.value).toContain("媒体数据加载超时");
    expect(s.preflights()).toHaveLength(1);
    expect(s.prepares()).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

it("HTTP fallback preserves final observation→Stop→key cancel ordering and one metric intent", async () => {
  const s = setup();
  try {
    await s.runtime.loadMedia();
    s.el.currentTime = 12.25;
    s.el.paused = false;
    s.el.dispatchEvent(new Event("playing"));
    await vi.advanceTimersByTimeAsync(5000);
    const frame = s.frames.at(-1)!;
    frame(performance.now(), { presentationTime: performance.now() });
    const stop = gate();
    const original = s.api.getMockImplementation()!;
    s.api.mockImplementation(async (path, method, body) => {
      if (path === "/playback-sessions/session-1" && method === "DELETE")
        await stop.promise;
      return original(path, method, body);
    });
    await s.decode();
    const final = s.api.mock.calls.find(
      ([path, method]) =>
        path === "/playback-sessions/session-1" && method === "DELETE",
    )!;
    expect(final[2]).toMatchObject({
      media_time_ms: 12250,
      has_played: true,
      seq: 3,
    });
    expect(s.prepares()).toHaveLength(1);
    expect(
      s.api.mock.calls.some(([path]) => path.startsWith("/playback-requests/")),
    ).toBe(false);
    stop.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const cancel = s.api.mock.calls.find(([path]) =>
      path.startsWith("/playback-requests/"),
    )!;
    expect(s.api.mock.calls.indexOf(cancel)).toBeGreaterThan(
      s.api.mock.calls.indexOf(final),
    );
    expect(s.api.mock.calls.indexOf(s.prepares()[1])).toBeGreaterThan(
      s.api.mock.calls.indexOf(cancel),
    );
    expect(s.prepares().map((call) => call[2].playback_metrics)).toEqual([
      { meter_start_generation: 1, startup_origin: "user_intent" },
      { meter_start_generation: 1, startup_origin: "user_intent" },
    ]);
    const seq = s.metrics().at(-1)![2].seq;
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.metrics().at(-1)![2]).toMatchObject({
      elapsed_ms: 10000,
      final: false,
    });
    expect(s.metrics().at(-1)![2].seq).toBeGreaterThan(seq);
    expect(s.preflights()).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

for (const source of ["local", "Agent"]) {
  const concreteSet = (binding = `${source}-binding`, useHls = false) => {
    const result = candidateSet(binding, useHls);
    delete result.http_file_capabilities_version;
    result.decision_reason = `observed_${source}`;
    return result;
  };

  it(`${source} retains immutable binding, reports, capabilities and cumulative finite exclusions`, async () => {
    const s = setup({ candidates: concreteSet(), directFallback: true });
    try {
      await s.runtime.loadMedia();
      const report = structuredClone(s.prepares()[0][2].candidate_report);
      const capabilities = structuredClone(s.prepares()[0][2].capabilities);
      const probes = s.decodingInfo.mock.calls.length;
      s.candidates.binding = "replacement-source";
      s.candidates.candidates[0].id = "replacement-route";
      s.candidates.candidates[0].video.width = 3840;
      s.prepares()[0][2].candidate_report.results[0].progressive =
        "unsupported";
      s.prepares()[0][2].capabilities.native_hls = false;
      s.prepares()[0][2].capabilities.report.candidates[0].video.width = 3840;
      s.el.canPlayType.mockReturnValue("");
      await s.decode();
      await s.decode();
      await s.decode();
      expect(s.preflights()).toHaveLength(1);
      expect(detectCandidateReport).toHaveBeenCalledTimes(1);
      expect(s.decodingInfo).toHaveBeenCalledTimes(probes);
      expect(s.prepares()).toHaveLength(3);
      expect(
        s
          .prepares()
          .slice(1)
          .map((call) => call[2].candidate_report),
      ).toEqual([
        { ...report, excluded_candidates: ["direct"] },
        { ...report, excluded_candidates: ["direct", "remux"] },
      ]);
      expect(
        s
          .prepares()
          .slice(1)
          .map((call) => call[2].capabilities),
      ).toEqual([capabilities, capabilities]);
      expect(
        s.api.mock.calls.some(([path]) =>
          path.endsWith("http-file-continuation"),
        ),
      ).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  for (const code of [
    "SOURCE_CHANGED",
    "STALE_CAPABILITY_REPORT",
    "PLAYBACK_REQUEST_EXPIRED",
  ]) {
    it(`${source} ${code} cannot rediscover or submit an unbound recovery, but explicit reload can`, async () => {
      const s = setup({ candidates: concreteSet() });
      try {
        await s.runtime.loadMedia();
        const original = s.api.getMockImplementation()!;
        let rejectBound = true;
        s.api.mockImplementation(async (path, method, body) => {
          if (path === "/playback-candidates")
            return concreteSet("fresh-source");
          if (path === "/playback-sessions" && method === "POST" && rejectBound)
            throw new RequestFailure({
              error: { code, message: "reload required" },
            });
          return original(path, method, body);
        });
        await s.decode();
        expect(s.preflights()).toHaveLength(1);
        expect(s.prepares()).toHaveLength(2);
        expect(s.prepares()[1][2].candidate_report).toMatchObject({
          binding: `${source}-binding`,
          excluded_candidates: ["direct"],
        });
        expect(s.error.value).toBe("reload required");
        s.runtime.onClockReady();
        await vi.advanceTimersByTimeAsync(1000);
        expect(s.prepares()).toHaveLength(2);
        rejectBound = false;
        await s.runtime.loadMedia();
        expect(s.preflights()).toHaveLength(2);
        expect(s.prepares()[2][2].candidate_report).toMatchObject({
          binding: "fresh-source",
          excluded_candidates: [],
        });
      } finally {
        s.cleanup();
      }
    });
  }

  for (const failure of ["missing", "throw"]) {
    it(`${source} report ${failure} fails closed without generic capability admission`, async () => {
      const s = setup({ candidates: concreteSet() });
      reportFault.value = failure;
      try {
        await expect(s.runtime.loadMedia()).rejects.toThrow();
        expect(s.prepares()).toHaveLength(0);
        expect(detectCapabilitiesAsync).not.toHaveBeenCalled();
        s.runtime.onClockReady();
        await vi.advanceTimersByTimeAsync(1000);
        expect(s.preflights()).toHaveLength(1);
        reportFault.value = "";
        await s.runtime.loadMedia();
        expect(s.preflights()).toHaveLength(2);
        expect(s.prepares()[0][2].candidate_report.binding).toBe(
          `${source}-binding`,
        );
      } finally {
        s.cleanup();
      }
    });
  }

  it(`${source} measures five minutes from the original discovery, including clock deferral`, async () => {
    const s = setup({ candidates: concreteSet() });
    try {
      await s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(299999);
      s.clock.ready = false;
      s.clock.revision++;
      s.runtime.onClockInvalidated();
      await s.decode();
      expect(s.prepares()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      s.clock.ready = true;
      s.runtime.onClockReady();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()).toHaveLength(1);
      expect(s.error.value).toContain("候选已失效");
      await s.runtime.loadMedia();
      expect(s.preflights()).toHaveLength(2);
      expect(s.prepares()).toHaveLength(2);
    } finally {
      s.cleanup();
    }
  });

  it(`${source} discovery latency cannot restart the five-minute concrete bound`, async () => {
    const s = setup({ candidates: concreteSet() });
    const pending = gate<any>();
    try {
      const original = s.api.getMockImplementation()!;
      s.api.mockImplementation(async (path, method, body) =>
        path === "/playback-candidates"
          ? pending.promise
          : original(path, method, body),
      );
      const loading = s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(300000);
      pending.resolve(concreteSet());
      await expect(loading).rejects.toThrow("候选已失效");
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()).toHaveLength(0);
    } finally {
      s.cleanup();
    }
  });

  for (const elapsed of [-1, NaN, Infinity]) {
    it(`${source} rejects invalid monotonic elapsed time ${elapsed} before a new prepare`, async () => {
      const s = setup({ candidates: concreteSet() });
      let now: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await s.runtime.loadMedia();
        now = vi.spyOn(performance, "now").mockReturnValue(elapsed);
        await s.decode();
        expect(s.preflights()).toHaveLength(1);
        expect(s.prepares()).toHaveLength(1);
        expect(s.error.value).toContain("候选已失效");
      } finally {
        now?.mockRestore();
        s.cleanup();
      }
    });
  }

  for (const phase of ["preflight", "device"]) {
    it(`${source} clock deferral during ${phase} retains one in-flight concrete discovery`, async () => {
      const pending = gate<any>();
      const decoder = vi.fn(() =>
        phase === "device" ? pending.promise : Promise.resolve(supported),
      );
      const s = setup({ candidates: concreteSet(), decodingInfo: decoder });
      try {
        const original = s.api.getMockImplementation()!;
        if (phase === "preflight")
          s.api.mockImplementation(async (path, method, body) =>
            path === "/playback-candidates"
              ? pending.promise
              : original(path, method, body),
          );
        const loading = s.runtime.loadMedia();
        await vi.advanceTimersByTimeAsync(0);
        s.clock.ready = false;
        s.clock.revision++;
        s.runtime.onClockInvalidated();
        s.clock.ready = true;
        s.runtime.onClockReady();
        await vi.advanceTimersByTimeAsync(0);
        pending.resolve(phase === "preflight" ? concreteSet() : supported);
        await loading;
        await vi.advanceTimersByTimeAsync(0);
        expect(s.preflights()).toHaveLength(1);
        expect(detectCandidateReport).toHaveBeenCalledTimes(1);
        expect(s.prepares()).toHaveLength(1);
        expect(s.prepares()[0][2].candidate_report.binding).toBe(
          `${source}-binding`,
        );
        expect(s.prepares()[0][2].playback_metrics.meter_start_generation).toBe(
          1,
        );
      } finally {
        s.cleanup();
      }
    });
  }

  for (const readyBeforeReply of [false, true]) {
    it(`${source} clock readiness ${readyBeforeReply ? "before" : "after"} a claimed reply retains the same key and high-water generation`, async () => {
      const s = setup({ candidates: concreteSet() });
      const pending = gate();
      try {
        const original = s.api.getMockImplementation()!;
        const highWater = new Map<number, string>();
        s.api.mockImplementation(async (path, method, body) => {
          if (path === "/playback-sessions" && method === "POST") {
            const key = highWater.get(body.plan_generation);
            if (key && key !== body.idempotency_key)
              throw new RequestFailure({
                error: { code: "STALE_PLAYBACK_PLAN" },
              });
            highWater.set(body.plan_generation, body.idempotency_key);
            const plan = await original(path, method, body);
            await pending.promise;
            return { ...plan, rebuild_on_seek: true };
          }
          if (
            path.startsWith("/playback-sessions/session-1?") &&
            method === "GET"
          )
            return {
              session_id: "session-1",
              plan_generation: 1,
              status: "ready",
              complete: true,
            };
          return original(path, method, body);
        });
        const loading = s.runtime.loadMedia();
        await vi.advanceTimersByTimeAsync(0);
        s.clock.ready = false;
        s.clock.revision++;
        s.runtime.onClockInvalidated();
        if (readyBeforeReply) {
          s.clock.ready = true;
          s.runtime.onClockReady();
          await vi.advanceTimersByTimeAsync(0);
        }
        pending.resolve();
        await loading;
        if (!readyBeforeReply) {
          s.clock.ready = true;
          s.runtime.onClockReady();
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(s.preflights()).toHaveLength(1);
        expect(s.prepares()).toHaveLength(1);
        expect(s.runtime.sessionId.value).toBe("session-1");
        expect(s.error.value).toBe("");
        expect(s.prepares()[0][2].playback_metrics.meter_start_generation).toBe(
          1,
        );
        expect(
          s.api.mock.calls.some(([path]) =>
            path.startsWith("/playback-requests/"),
          ),
        ).toBe(false);
      } finally {
        s.cleanup();
      }
    });
  }

  for (const fence of [
    "mode",
    "audio",
    "media",
    "generation",
    "room",
    "lifecycle",
    "login",
    "epoch",
    "stop",
    "dispose",
  ]) {
    it(`${source} ${fence} reset fences a held discovery and old callbacks`, async () => {
      const s = setup({ candidates: concreteSet() });
      const pending = gate<any>();
      try {
        const original = s.api.getMockImplementation()!;
        s.api.mockImplementation(async (path, method, body) =>
          path === "/playback-candidates"
            ? pending.promise
            : original(path, method, body),
        );
        const loading = s.runtime.loadMedia();
        await vi.advanceTimersByTimeAsync(0);
        switch (fence) {
          case "mode":
            s.runtime.mode.value = "direct";
            s.runtime.mode.value = "auto";
            break;
          case "audio":
            s.runtime.audioIndex.value = 1;
            s.runtime.audioIndex.value = undefined;
            break;
          case "media":
            s.state.value.media_id = "other";
            break;
          case "generation":
            s.state.value.media_generation++;
            break;
          case "room":
            s.state.value.room_id = "other";
            break;
          case "lifecycle":
            s.active.value = false;
            s.active.value = true;
            break;
          case "login":
            s.session.user.id = "other";
            break;
          case "epoch":
            s.session.epoch++;
            break;
          case "stop":
            await s.runtime.reset();
            break;
          case "dispose":
            s.cleanup();
            break;
        }
        pending.resolve(concreteSet());
        await loading;
        s.runtime.onClockReady();
        await vi.advanceTimersByTimeAsync(0);
        expect(s.prepares()).toHaveLength(0);
        expect(detectCandidateReport).not.toHaveBeenCalled();
      } finally {
        s.cleanup();
      }
    });
  }

  it(`${source} HTML code 4 stays neutral while confirmed decode still selects the next bound route`, async () => {
    const s = setup({ candidates: concreteSet(), directFallback: true });
    try {
      await s.runtime.loadMedia();
      s.el.error = { code: 4 };
      s.el.onerror();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()).toHaveLength(1);
      expect(s.error.value).toContain("媒体加载或格式支持状态未知");
      expect(
        s.api.mock.calls.some(([path]) =>
          path.endsWith("http-file-continuation"),
        ),
      ).toBe(false);
      await s.decode();
      expect(s.prepares()[1][2].candidate_report).toMatchObject({
        binding: `${source}-binding`,
        excluded_candidates: ["direct"],
      });
    } finally {
      s.cleanup();
    }
  });

  it(`${source} decoder fallback retains metric t0 and final-observation→Stop→cancel order while giving the new plan 20 seconds`, async () => {
    const s = setup({ candidates: concreteSet(), readyState: 0 });
    try {
      await s.runtime.loadMedia();
      const oldLoaded = s.el.onloadeddata;
      const oldError = s.el.onerror;
      s.el.currentTime = 12.25;
      s.el.paused = false;
      s.el.dispatchEvent(new Event("playing"));
      await vi.advanceTimersByTimeAsync(12000);
      const stop = gate();
      const original = s.api.getMockImplementation()!;
      s.api.mockImplementation(async (path, method, body) => {
        if (path === "/playback-sessions/session-1" && method === "DELETE")
          await stop.promise;
        return original(path, method, body);
      });
      await s.decode();
      const final = s.api.mock.calls.find(
        ([path, method]) =>
          path === "/playback-sessions/session-1" && method === "DELETE",
      )!;
      expect(final[2]).toMatchObject({
        media_time_ms: 12250,
        has_played: false,
        buffering: true,
      });
      expect(s.prepares()).toHaveLength(1);
      expect(
        s.api.mock.calls.some(([path]) =>
          path.startsWith("/playback-requests/"),
        ),
      ).toBe(false);
      oldError();
      stop.resolve();
      await vi.advanceTimersByTimeAsync(0);
      const cancel = s.api.mock.calls.find(([path]) =>
        path.startsWith("/playback-requests/"),
      )!;
      expect(s.api.mock.calls.indexOf(cancel)).toBeGreaterThan(
        s.api.mock.calls.indexOf(final),
      );
      expect(s.api.mock.calls.indexOf(s.prepares()[1])).toBeGreaterThan(
        s.api.mock.calls.indexOf(cancel),
      );
      expect(s.prepares().map((call) => call[2].playback_metrics)).toEqual([
        { meter_start_generation: 1, startup_origin: "user_intent" },
        { meter_start_generation: 1, startup_origin: "user_intent" },
      ]);
      s.el.readyState = 2;
      oldLoaded();
      s.el.readyState = 0;
      await vi.advanceTimersByTimeAsync(19999);
      expect(s.error.value).toBe("");
      expect(s.metrics().at(-1)![2].elapsed_ms).toBe(30000);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.error.value).toContain("媒体数据加载超时");
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()).toHaveLength(2);
    } finally {
      s.cleanup();
    }
  });

  it(`${source} native→MSE and range retries keep one plan's original 20-second loading budget`, async () => {
    const candidates = concreteSet(`${source}-binding`, true);
    candidates.candidates.shift();
    const s = setup({ candidates, readyState: 0 });
    try {
      await s.runtime.loadMedia();
      const oldLoaded = s.el.onloadeddata;
      await vi.advanceTimersByTimeAsync(12000);
      await s.decode();
      await vi.advanceTimersByTimeAsync(4000);
      hls.handlers.at(-1)!(undefined, {
        fatal: true,
        type: "networkError",
        response: { code: 409 },
      });
      s.el.readyState = 2;
      oldLoaded();
      s.el.readyState = 0;
      await vi.advanceTimersByTimeAsync(3999);
      expect(s.error.value).toBe("");
      await vi.advanceTimersByTimeAsync(1);
      expect(s.error.value).toContain("媒体数据加载超时");
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  });

  it(`${source} same-grant native→MSE and range recovery preserve the snapshot and Hls.js decoder branch`, async () => {
    const s = setup({ candidates: concreteSet(`${source}-binding`, true) });
    try {
      await s.runtime.loadMedia();
      await s.decode();
      s.el.error = { code: 4 };
      s.el.onerror();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.prepares()).toHaveLength(2);
      const oldError = hls.handlers.at(-1)!;
      oldError(undefined, {
        fatal: true,
        type: "networkError",
        response: { code: 409 },
      });
      expect(hls.started).toHaveBeenCalled();
      oldError(undefined, {
        fatal: true,
        type: "networkError",
        response: { code: 401 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(s.prepares()).toHaveLength(2);
      // Hls.js identifies decoder failure independently of HTML MediaError 4.
      oldError(undefined, { fatal: true, type: "mediaError" });
      await vi.advanceTimersByTimeAsync(0);
      expect(s.prepares()).toHaveLength(3);
      oldError(undefined, { fatal: true, type: "mediaError" });
      await vi.advanceTimersByTimeAsync(0);
      expect(s.prepares()).toHaveLength(3);
      expect(s.preflights()).toHaveLength(1);
      expect(s.prepares()[2][2].candidate_report).toMatchObject({
        binding: `${source}-binding`,
        excluded_candidates: ["direct", "remux"],
      });
    } finally {
      s.cleanup();
    }
  });
}

for (const legacy of ["empty", "404"]) {
  it(`legacy ${legacy} initial admission and code-3 one-hop remain compatible, but code 4 cannot create a grant`, async () => {
    const s = setup({ directFallback: true });
    try {
      const original = s.api.getMockImplementation()!;
      s.api.mockImplementation(async (path, method, body) => {
        if (path === "/playback-candidates") {
          if (legacy === "404")
            throw new RequestFailure({ error: { code: "NOT_FOUND" } });
          return {
            schema_version: 1,
            binding: null,
            candidates: [],
            decision_reason: "provider_requires_legacy_negotiation",
          };
        }
        if (path === "/playback-sessions/http-file-continuation") {
          const plan = await original("/playback-sessions", "POST", body);
          return {
            ...plan,
            delivery_mode: "transcode",
            selected_candidate_id: undefined,
            http_file_fallback_version: undefined,
          };
        }
        return original(path, method, body);
      });
      await s.runtime.loadMedia();
      expect(s.prepares()).toHaveLength(1);
      expect(s.prepares()[0][2]).not.toHaveProperty("candidate_report");
      expect(s.prepares()[0][2]).not.toHaveProperty(
        "upstream_playback_profile",
      );
      expect(detectCapabilitiesAsync).toHaveBeenCalledTimes(1);
      s.el.error = { code: 4 };
      s.el.onerror();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.error.value).toContain("媒体加载或格式支持状态未知");
      expect(
        s.api.mock.calls.filter(([path]) =>
          path.endsWith("http-file-continuation"),
        ),
      ).toHaveLength(0);
      await s.decode();
      const continuation = s.api.mock.calls.filter(([path]) =>
        path.endsWith("http-file-continuation"),
      );
      expect(continuation).toHaveLength(1);
      expect(continuation[0][2].http_file_fallback.parent_session_id).toBe(
        "session-1",
      );
      expect(continuation[0][2].mode).toBe("transcode");
      expect(s.preflights()).toHaveLength(1);
      expect(s.runtime.sessionId.value).toBe("session-2");
    } finally {
      s.cleanup();
    }
  });
}
