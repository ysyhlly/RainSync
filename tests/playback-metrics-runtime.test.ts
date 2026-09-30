import { afterEach, expect, test, vi } from "vitest";
import { effectScope, ref } from "vue";
import { createPlaybackRuntime } from "../apps/web/src/features/playback/playback-runtime";

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
  const cancel = vi.fn();
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
      return callbacks.length;
    },
    cancelVideoFrameCallback: cancel,
  });
  let grants = 0;
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
                playback_metrics_version: 1,
                playback_metrics: {
                  ...body.playback_metrics,
                  metrics_seq: options.restoredSeq ?? 0,
                  closed: options.closed ?? false,
                },
              }),
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
      callbacks.at(-1)!(performance.now(), { presentationTime: time });
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
        playback_metrics: {
          meter_start_generation: 1,
          startup_origin: "user_intent",
        },
        observation_version: 1,
      });
      expect(s.metrics()).toHaveLength(0);
      expect(s.callbacks).toHaveLength(0);
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
    expect(current[2].elapsed_ms).toBe(8000);
  } finally {
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
