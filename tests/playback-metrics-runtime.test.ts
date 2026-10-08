vi.mock("../apps/web/src/features/playback/browser-mse", async () => {
  const { default: Hls } = await import("hls.js");
  return {
    getPlaybackMediaSource: () => Hls.getMediaSource(),
    hasPlaybackMseApi: () => Hls.isMSESupported(),
    supportsHlsPlayback: () => Hls.isSupported(),
  };
});
import { afterEach, expect, test, vi } from "vitest";
import { effectScope, ref } from "vue";
import { createPlaybackRuntime } from "../apps/web/src/features/playback/playback-runtime";
import { RequestFailure } from "../apps/web/src/errors";
import * as playbackMetrics from "../apps/web/src/features/playback/playback-metrics";

vi.mock("hls.js", () => ({
  default: class {
    static Events = { ERROR: "error" };
    static isSupported = () => true;
    static getMediaSource = () => ({ isTypeSupported: () => true });
    config = {};
    loadSource() {}
    attachMedia() {}
    startLoad() {}
    stopLoad() {}
    destroy() {}
    on() {}
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(
  options: {
    marker?: boolean;
    versions?: number[];
    prepareFailures?: number;
    prepareCodes?: (string | null)[];
    renewal?: "legacy" | "bound" | "zero";
    prepareDelay?: number;
    closed?: boolean;
    restoredSeq?: number;
    hls?: boolean;
    clockReady?: boolean;
    slowFinal?: boolean;
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
  const callbacks: ((at: number, metadata: any) => void)[] = [];
  const pendingFrames = new Set<number>();
  const cancel = vi.fn((id: number) => pendingFrames.delete(id));
  const el: any = Object.assign(new EventTarget(), {
    src: "",
    readyState: 4,
    paused: true,
    seeking: false,
    currentTime: 0,
    playbackRate: 1,
    buffered: { length: 0 },
    seekable: { length: 0 },
    querySelectorAll: () => [],
    canPlayType: () => "probably",
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
    requestVideoFrameCallback: (cb: (typeof callbacks)[number]) => {
      callbacks.push(cb);
      pendingFrames.add(callbacks.length);
      return callbacks.length;
    },
    cancelVideoFrameCallback: cancel,
  });
  let grants = 0;
  let prepareAttempts = 0;
  let fixtureExpiry = 1800000;
  let prepareFailures = options.prepareFailures ?? 0;
  const candidates = {
    schema_version: 1,
    binding: "source-binding",
    decision_reason: "observed_source",
    candidates: ["direct", "remux"].map((id) => ({
      id,
      delivery_mode: id,
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
  const api = vi.fn(
    async (
      path: string,
      method?: string,
      body?: any,
      signal?: AbortSignal,
    ): Promise<any> => {
      if (path === "/playback-candidates") return candidates;
      if (path === "/playback-sessions" && method === "POST") {
        const code = options.prepareCodes?.[prepareAttempts++];
        if (code) throw new RequestFailure({ error: { code } });
        if (prepareFailures-- > 0) throw new TypeError("lost grant ACK");
        if (options.prepareDelay)
          await new Promise((resolve) =>
            setTimeout(resolve, options.prepareDelay),
          );
        const candidate = candidates.candidates.find(
          (c) => !body.candidate_report.excluded_candidates.includes(c.id),
        )!;
        return {
          session_id: `session-${++grants}`,
          plan_generation: body.plan_generation,
          media_id: "media",
          media_generation: 1,
          transport: options.hls ? "hls" : "progressive",
          delivery_mode: candidate.delivery_mode,
          selected_candidate_id: candidate.id,
          playback_url: `/authorized-${grants}`,
          timeline_origin_ms: 0,
          duration_ms: 100000,
          expires_in_seconds: 1800,
          rebuild_on_seek: false,
          audio_tracks: [],
          subtitle_tracks: [],
          observation_version: 1,
          observation_seq: 0,
          ...(options.marker === false
            ? {}
            : {
                playback_metrics_version: options.versions?.[grants - 1] ?? 1,
                playback_metrics: {
                  ...body.playback_metrics,
                  metrics_seq: options.restoredSeq ?? 0,
                  closed: options.closed ?? false,
                },
              }),
        };
      }
      if (
        options.renewal &&
        /^\/playback-sessions\/session-\d+$/.test(path) &&
        method === "POST"
      ) {
        if (options.renewal !== "zero" && performance.now() >= fixtureExpiry)
          throw new RequestFailure({
            error: { code: "INVALID_PLAYBACK_SESSION" },
          });
        if (options.renewal === "bound") {
          fixtureExpiry = performance.now() + 1800000;
          return { ok: true };
        }
        return {
          ok: true,
          expires_in_seconds:
            options.renewal === "zero"
              ? 0
              : Math.ceil((fixtureExpiry - performance.now()) / 1000),
          legacy_expiry_unchanged: true,
        };
      }
      if (path.endsWith("/metrics")) {
        if (body.final && options.slowFinal)
          return new Promise((_resolve, reject) =>
            signal!.addEventListener("abort", () =>
              reject(new DOMException("cancelled", "AbortError")),
            ),
          );
        return {
          session_id: path.split("/")[2],
          meter_start_generation: body.meter_start_generation,
          metrics_seq: body.seq,
          closed: body.final,
        };
      }
      return {};
    },
  );
  const session = { user: { id: "user" }, epoch: 1, api };
  const state = ref({
    room_id: "room",
    media_id: "media",
    media_generation: 1,
    revision: 1,
    playback_status: "playing",
    anchor_position_ms: 0,
    anchor_server_time_ms: 0,
    playback_rate: 1,
  });
  const clock = { ready: options.clockReady !== false, now: () => 0 };
  const scope = effectScope();
  const runtime = scope.run(() =>
    createPlaybackRuntime({
      session: session as any,
      state: state as any,
      clock: clock as any,
      connected: ref(true),
      active: ref(true),
      error: ref(""),
      run: async (action) => action(),
    }),
  )!;
  runtime.attach(el);
  return {
    api,
    runtime,
    session,
    state,
    clock,
    el,
    callbacks,
    cancel,
    document,
    metrics: () => api.mock.calls.filter(([path]) => path.endsWith("/metrics")),
    prepares: () =>
      api.mock.calls.filter(
        ([path, method]) => path === "/playback-sessions" && method === "POST",
      ),
    frame: (time = performance.now()) => {
      el.paused = false;
      // Browsers deliver every registered observer for this presentation.
      for (const id of [...pendingFrames]) {
        pendingFrames.delete(id);
        callbacks[id - 1](performance.now(), { presentationTime: time });
      }
    },
    cleanup: () => scope.stop(),
  };
}

test("paired request opts in, but absent/closed/incoherent grant marker never sends", async () => {
  for (const options of [
    { marker: false },
    { closed: true },
    { restoredSeq: 4 },
  ]) {
    const s = setup(options);
    try {
      await s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(10000);
      expect(s.prepares()[0][2]).toMatchObject({
        playback_metrics_version: 1,
        playback_metrics_supported_versions: [1, 2],
        playback_metrics: {
          meter_start_generation: 1,
          startup_origin: "user_intent",
        },
        observation_version: 1,
      });
      expect(s.metrics()).toHaveLength(0);
      // Presentation safety remains active without an optional metrics grant.
      expect(s.callbacks).toHaveLength(options.marker === false ? 2 : 1);
      expect(s.el.src).toBe("/authorized-1");
    } finally {
      s.cleanup();
    }
  }
});

test("first frame and cumulative snapshot map only negotiated DTO fields", async () => {
  const s = setup();
  try {
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    s.frame(950);
    await vi.advanceTimersByTimeAsync(4000);
    const body = s.metrics()[0][2];
    expect(body).toMatchObject({
      version: 1,
      plan_generation: 1,
      meter_start_generation: 1,
      elapsed_ms: 5000,
      first_frame: {
        elapsed_ms: 950,
        confirmed_elapsed_ms: 1000,
        evidence: "video_frame_callback",
      },
      totals: { startup_ms: 1000, playing_ms: 4000 },
    });
    expect(body).not.toHaveProperty("source");
    expect(body).not.toHaveProperty("generation");
    expect(body).not.toHaveProperty("observed_ms");
  } finally {
    s.cleanup();
  }
});

test("decoder fallback retains t0/start generation, advances grant, and ignores old source callback", async () => {
  const s = setup();
  try {
    await s.runtime.loadMedia();
    const old = s.callbacks[0];
    await vi.advanceTimersByTimeAsync(1000);
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.prepares()).toHaveLength(2);
    expect(s.prepares().map((c) => c[2].plan_generation)).toEqual([1, 2]);
    expect(
      s.prepares().map((c) => c[2].playback_metrics.meter_start_generation),
    ).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(2000);
    old(3000, { presentationTime: 2900 });
    s.frame(2950);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.metrics()[0][2]).toMatchObject({
      plan_generation: 2,
      meter_start_generation: 1,
      elapsed_ms: 5000,
      first_frame: { elapsed_ms: 2950 },
    });
    expect(s.metrics().some((c) => c[2].final)).toBe(false);
  } finally {
    s.cleanup();
  }
});

test("same-grant native to MSE replacement fences old callbacks without advancing wire generation", async () => {
  const s = setup({ hls: true });
  try {
    await s.runtime.loadMedia();
    const old = s.callbacks[0];
    await vi.advanceTimersByTimeAsync(1000);
    s.el.error = { code: 3 };
    s.el.onerror();
    expect(s.prepares()).toHaveLength(1);
    expect(s.cancel).toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(1000);
    old(2000, { presentationTime: 1900 });
    s.frame(1950);
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.metrics()[0][2]).toMatchObject({
      plan_generation: 1,
      first_frame: { elapsed_ms: 1950 },
    });
  } finally {
    s.cleanup();
  }
});

test("clock deferral retains original intent t0 and reserved start generation", async () => {
  const s = setup({ clockReady: false });
  try {
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.prepares()).toHaveLength(0);
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.prepares()[0][2]).toMatchObject({
      plan_generation: 1,
      playback_metrics: { meter_start_generation: 1 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    s.frame(10950);
    await vi.advanceTimersByTimeAsync(4000);
    expect(s.metrics()[0][2]).toMatchObject({
      elapsed_ms: 15000,
      first_frame: { elapsed_ms: 10950 },
    });
  } finally {
    s.cleanup();
  }
});

test("new explicit intent replaces meter; pause and autoplay enable keep the existing meter", async () => {
  const s = setup();
  try {
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    s.frame();
    s.state.value.playback_status = "paused";
    await s.runtime.applyState();
    await s.runtime.enablePlayback();
    expect(s.prepares()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await s.runtime.loadMedia();
    expect(s.prepares()[1][2].playback_metrics.meter_start_generation).toBe(2);
    await vi.advanceTimersByTimeAsync(8000);
    const current = s.metrics().find((c) => c[2].meter_start_generation === 2)!;
    expect(current[2].elapsed_ms).toBe(5000);
  } finally {
    s.cleanup();
  }
});

test.each([1, 123, 2000])(
  "a logical meter begun %i ms after construction samples at its first eligible 5s",
  async (offset) => {
    const s = setup({ versions: [2] });
    try {
      await vi.advanceTimersByTimeAsync(offset);
      await s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(4999);
      expect(s.metrics()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.metrics()[0][2]).toMatchObject({
        elapsed_ms: 5000,
        seq: 1,
        meter_start_generation: 1,
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(s.metrics()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.metrics()[1][2]).toMatchObject({ elapsed_ms: 10000, seq: 2 });
    } finally {
      s.cleanup();
    }
  },
);
test("same-meter fallback/plan replacement does not restart its intent-aligned sampling timer", async () => {
  const s = setup({ versions: [2, 2] });
  try {
    await vi.advanceTimersByTimeAsync(333);
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    s.frame();
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.prepares()[1][2].playback_metrics.meter_start_generation).toBe(1);
    await vi.advanceTimersByTimeAsync(3999);
    expect(s.metrics()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.metrics()[0][2]).toMatchObject({
      elapsed_ms: 5000,
      seq: 1,
      plan_generation: 2,
      meter_start_generation: 1,
      first_frame_plan_generation: 1,
    });
  } finally {
    s.cleanup();
  }
});
test("pause/background observations keep the same 5s cadence without fabricated first frames or duplicate seq", async () => {
  const s = setup({ versions: [2] });
  try {
    await vi.advanceTimersByTimeAsync(900);
    await s.runtime.loadMedia();
    s.state.value.playback_status = "paused";
    s.el.pause();
    s.document.visibilityState = "hidden";
    s.document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.metrics()[0][2]).toMatchObject({
      elapsed_ms: 5000,
      seq: 1,
      totals: { background_ms: 5000 },
    });
    expect(s.metrics()[0][2]).not.toHaveProperty("first_frame");
    s.document.visibilityState = "visible";
    s.document.dispatchEvent(new Event("visibilitychange"));
    s.frame(); // An actual observed frame ends startup; pause then owns its time.
    s.el.pause();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.metrics()).toHaveLength(2);
    expect(s.metrics()[1][2]).toMatchObject({
      elapsed_ms: 10000,
      seq: 2,
      totals: { background_ms: 5000, paused_ms: 5000 },
    });
    expect(s.prepares()).toHaveLength(1);
  } finally {
    s.cleanup();
  }
});

test("optional sample failure keeps a bounded cadence and intent teardown clears its timer", async () => {
  const original = playbackMetrics.createPlaybackMetrics;
  const sample = vi.fn(() => undefined);
  const factory = vi
    .spyOn(playbackMetrics, "createPlaybackMetrics")
    .mockImplementation((config) => ({ ...original(config), sample }));
  const s = setup({ versions: [2] });
  try {
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(5000);
    const callsAtDeadline = sample.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sample).toHaveBeenCalledTimes(callsAtDeadline);
    expect(s.metrics()).toHaveLength(0);
    await s.runtime.reset();
    const callsAfterReset = sample.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(sample).toHaveBeenCalledTimes(callsAfterReset);
  } finally {
    factory.mockRestore();
    s.cleanup();
  }
});
test("slow final metrics POST cannot delay exact observation-v1 Stop and key cleanup", async () => {
  const s = setup({ slowFinal: true });
  try {
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    s.frame();
    await s.runtime.reset();
    const final = s.metrics()[0];
    expect(final[2].final).toBe(true);
    const stopped = s.api.mock.calls.find(
      (c) => c[0] === "/playback-sessions/session-1" && c[1] === "DELETE",
    )!;
    expect(stopped[2]).toMatchObject({
      seq: 1,
      event: "progress",
      has_played: false,
    });
    expect(stopped[2]).not.toHaveProperty("totals");
    expect(s.api.mock.calls.indexOf(final)).toBeLessThan(
      s.api.mock.calls.indexOf(stopped),
    );
    const revoked = s.api.mock.calls.find(
      (c) => c[0].startsWith("/playback-requests/") && c[1] === "DELETE",
    )!;
    expect(s.api.mock.calls.indexOf(stopped)).toBeLessThan(
      s.api.mock.calls.indexOf(revoked),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(final[3]!.aborted).toBe(true);
  } finally {
    s.cleanup();
  }
});

test("suspended observation gap is wholly unobserved, and seven-day expiry never resets reporting", async () => {
  const s = setup();
  try {
    await s.runtime.loadMedia();
    s.frame();
    await vi.advanceTimersByTimeAsync(5000);
    const clock = vi.spyOn(performance, "now").mockReturnValue(25001);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.metrics()[1][2]).toMatchObject({
      elapsed_ms: 25001,
      totals: { unobserved_ms: 20001, playing_ms: 5000 },
    });
    clock.mockReturnValue(604800001);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.metrics()).toHaveLength(2);
    expect(s.prepares()).toHaveLength(1);
    await s.runtime.reset();
    expect(s.metrics()).toHaveLength(2);
    clock.mockRestore();
  } finally {
    s.cleanup();
  }
});

test("auth replacement ignores old frame and stops further metrics", async () => {
  const s = setup();
  try {
    await s.runtime.loadMedia();
    const old = s.callbacks[0];
    s.session.epoch++;
    old(0, { presentationTime: 0 });
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.metrics()).toHaveLength(0);
  } finally {
    s.cleanup();
  }
});

test("v2 separates clock/preparation delay from attachment loading and confirmation delay", async () => {
  const s = setup({ versions: [2], clockReady: false, prepareDelay: 1000 });
  try {
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(6000);
    s.clock.ready = true;
    s.runtime.onClockReady();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.el.src).toBe("/authorized-1");
    await vi.advanceTimersByTimeAsync(1000);
    s.frame(7950);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.metrics()[0][2]).toMatchObject({
      version: 2,
      plan_generation: 1,
      first_frame_plan_generation: 1,
      startup_phases: {
        preparation_ms: 7000,
        loading_ms: 1000,
        unobserved_ms: 0,
      },
      first_frame: { elapsed_ms: 7950, confirmed_elapsed_ms: 8000 },
    });
  } finally {
    s.cleanup();
  }
});

test("v2 pre-first-sample fallback retains first frame's originating grant", async () => {
  const s = setup({ versions: [2, 2] });
  try {
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    s.frame(950);
    await vi.advanceTimersByTimeAsync(1000);
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.metrics()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    s.frame(2950);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.metrics()[0][2]).toMatchObject({
      version: 2,
      plan_generation: 2,
      first_frame_plan_generation: 1,
      first_frame: { elapsed_ms: 950, confirmed_elapsed_ms: 1000 },
      startup_phases: { preparation_ms: 0, loading_ms: 1000, unobserved_ms: 0 },
    });
  } finally {
    s.cleanup();
  }
});

test("v2 same-grant source replacement never labels its local callback generation as a plan", async () => {
  const s = setup({ versions: [2], hls: true });
  try {
    await s.runtime.loadMedia();
    const stale = s.callbacks[0];
    await vi.advanceTimersByTimeAsync(1000);
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(1000);
    stale(2000, { presentationTime: 1950 });
    s.frame(1950);
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.metrics()[0][2]).toMatchObject({
      version: 2,
      plan_generation: 1,
      first_frame_plan_generation: 1,
      first_frame: { elapsed_ms: 1950 },
      startup_phases: { preparation_ms: 0, loading_ms: 2000, unobserved_ms: 0 },
    });
  } finally {
    s.cleanup();
  }
});

test.each([
  [1, 2],
  [2, 1],
])(
  "selected metrics version cannot change across fallback %j",
  async (first, second) => {
    const s = setup({ versions: [first, second] });
    try {
      await s.runtime.loadMedia();
      await vi.advanceTimersByTimeAsync(1000);
      s.frame();
      await vi.advanceTimersByTimeAsync(4000);
      expect(s.metrics()[0][2].version).toBe(first);
      s.el.error = { code: 3 };
      s.el.onerror();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.el.src).toBe("/authorized-2");
      await vi.advanceTimersByTimeAsync(10000);
      expect(s.metrics()).toHaveLength(1);
      expect(s.prepares()[1][2].playback_metrics_supported_versions).toEqual([
        1, 2,
      ]);
    } finally {
      s.cleanup();
    }
  },
);

test("new client old-server v1 negotiation keeps exact v1 packets", async () => {
  const s = setup();
  try {
    await s.runtime.loadMedia();
    s.frame();
    await vi.advanceTimersByTimeAsync(5000);
    const request = s.prepares()[0][2];
    expect(request.playback_metrics_version).toBe(1);
    expect(request.playback_metrics_supported_versions).toEqual([1, 2]);
    expect(Object.isFrozen(request.playback_metrics_supported_versions)).toBe(
      true,
    );
    const packet = s.metrics()[0][2];
    expect(packet.version).toBe(1);
    expect(packet).not.toHaveProperty("startup_phases");
    expect(packet).not.toHaveProperty("first_frame_plan_generation");
  } finally {
    s.cleanup();
  }
});

test("preparation retries retain exact negotiation body and idempotency key", async () => {
  const s = setup({ versions: [2], prepareFailures: 1 });
  try {
    const loading = s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    await loading;
    const calls = s.prepares();
    expect(calls).toHaveLength(2);
    expect(calls[0][2]).toBe(calls[1][2]);
    expect(calls[0][2].idempotency_key).toBe(calls[1][2].idempotency_key);
    expect(calls[0][2].playback_metrics_supported_versions).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1000);
    s.frame(1950);
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.metrics()[0][2].startup_phases).toEqual({
      preparation_ms: 1000,
      loading_ms: 1000,
      unobserved_ms: 0,
    });
  } finally {
    s.cleanup();
  }
});

test("first valid grant selects v2 without losing an earlier source's local evidence", async () => {
  const s = setup({ versions: [99, 2] });
  try {
    await s.runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(1000);
    s.frame(950);
    await vi.advanceTimersByTimeAsync(1000);
    s.el.error = { code: 3 };
    s.el.onerror();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.metrics()[0][2]).toMatchObject({
      version: 2,
      plan_generation: 2,
      first_frame_plan_generation: 1,
      first_frame: { elapsed_ms: 950, confirmed_elapsed_ms: 1000 },
      startup_phases: { preparation_ms: 0, loading_ms: 1000, unobserved_ms: 0 },
    });
  } finally {
    s.cleanup();
  }
});

test("lost source-phase observation disables optional telemetry without stopping playback", async () => {
  const original = playbackMetrics.createPlaybackMetrics;
  const factory = vi
    .spyOn(playbackMetrics, "createPlaybackMetrics")
    .mockImplementation((config) => ({
      ...original(config),
      attachSource: () => false,
    }));
  const s = setup({ versions: [2] });
  try {
    await s.runtime.loadMedia();
    expect(s.el.src).toBe("/authorized-1");
    s.frame();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.metrics()).toHaveLength(0);
    await s.runtime.reset();
    expect(
      s.api.mock.calls.some(
        ([path, method]) =>
          path === "/playback-sessions/session-1" && method === "DELETE",
      ),
    ).toBe(true);
  } finally {
    s.cleanup();
    factory.mockRestore();
  }
});

test("dedicated unmapped legacy viewer rejection rotates once into a fresh logical metrics intent", async () => {
  const s = setup({
    versions: [2],
    prepareCodes: ["PLAYBACK_VIEWER_ORIGIN_REQUIRED", null],
  });
  try {
    await s.runtime.loadMedia();
    const [first, next] = s.prepares().map((call) => call[2]);
    expect(s.prepares()).toHaveLength(2);
    expect(next.viewer_id).not.toBe(first.viewer_id);
    expect(next.idempotency_key).not.toBe(first.idempotency_key);
    expect(next.plan_generation).toBe(1);
    expect(next.playback_metrics.meter_start_generation).toBe(1);
    expect(
      s.api.mock.calls.filter(
        ([path, method]) =>
          method === "DELETE" && path.includes(first.idempotency_key),
      ),
    ).toHaveLength(0);
    s.frame();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.metrics()[0][2]).toMatchObject({
      version: 2,
      plan_generation: 1,
      meter_start_generation: 1,
      first_frame_plan_generation: 1,
    });
  } finally {
    s.cleanup();
  }
});
test("repeated dedicated origin rejection stops after exactly one viewer rotation", async () => {
  const s = setup({
    prepareCodes: [
      "PLAYBACK_VIEWER_ORIGIN_REQUIRED",
      "PLAYBACK_VIEWER_ORIGIN_REQUIRED",
      null,
    ],
  });
  try {
    await expect(s.runtime.loadMedia()).rejects.toMatchObject({
      name: "PlaybackViewerOriginRequired",
    });
    expect(s.prepares()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30000);
    expect(s.prepares()).toHaveLength(2);
    expect(s.metrics()).toHaveLength(0);
  } finally {
    s.cleanup();
  }
});
test.each(["FORBIDDEN", "STALE_PLAYBACK_PLAN", "ORIGIN_REJECTED"])(
  "generic %s never rotates the viewer",
  async (code) => {
    const s = setup({ prepareCodes: [code, null] });
    try {
      await expect(s.runtime.loadMedia()).rejects.toMatchObject({ code });
      expect(s.prepares()).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  },
);
test.each(["legacy", "bound", "zero"] as const)(
  "%s renewal keeps fixed cadence and honors actual original expiry",
  async (renewal) => {
    const s = setup({
      renewal,
      prepareCodes: [null, "PLAYBACK_VIEWER_ORIGIN_REQUIRED", null],
    });
    try {
      await s.runtime.loadMedia();
      s.frame();
      s.document.visibilityState = "hidden";
      await vi.advanceTimersByTimeAsync(1200000);
      const renews = () =>
        s.api.mock.calls.filter(
          ([path, method]) =>
            /^\/playback-sessions\/session-\d+$/.test(path) &&
            method === "POST",
        );
      expect(renews()).toHaveLength(2);
      expect(s.prepares()).toHaveLength(1);
      s.document.visibilityState = "visible";
      await vi.advanceTimersByTimeAsync(600000);
      expect(renews()).toHaveLength(3);
      expect(s.prepares()).toHaveLength(renewal === "legacy" ? 3 : 1);
      if (renewal === "legacy") {
        const inputs = s.prepares().map((call) => call[2]);
        expect(inputs[2].viewer_id).not.toBe(inputs[0].viewer_id);
        expect(inputs[2].plan_generation).toBe(1);
      }
    } finally {
      s.cleanup();
    }
  },
);
