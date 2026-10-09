vi.mock("../apps/web/src/features/playback/browser-mse", async () => {
  const { default: Hls } = await import("hls.js");
  return {
    getPlaybackMediaSource: () => Hls.getMediaSource(),
    hasPlaybackMseApi: () => Hls.isMSESupported(),
    supportsHlsPlayback: () => Hls.isSupported(),
  };
});
import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";

vi.mock("hls.js", () => ({
  default: class {
    static isSupported = () => false;
    static getMediaSource = () => undefined;
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("real room wake clears stale correction, waits for a correlated sample, and retains the grant", async () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
      "Date",
    ],
  });
  setActivePinia(createPinia());
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  const window = new EventTarget();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("location", {
    protocol: "http:",
    host: "localhost",
    href: "http://localhost/rooms/room",
  });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  let grants = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, request: RequestInit = {}) => {
      if (url.endsWith("/playback-candidates"))
        return Response.json({
          schema_version: 1,
          binding: null,
          candidates: [],
          decision_reason: "legacy_transport_fallback",
        });
      if (url.endsWith("/playback-sessions") && request.method === "POST")
        return Response.json({
          session_id: `session-${++grants}`,
          media_id: "media",
          media_generation: 1,
          plan_generation: JSON.parse(String(request.body)).plan_generation,
          transport: "progressive",
          delivery_mode: "direct",
          playback_url: "/authorized.mp4",
          timeline_origin_ms: 0,
          duration_ms: 120000,
          rebuild_on_seek: false,
          expires_in_seconds: 1800,
          audio_tracks: [],
          subtitle_tracks: [],
        });
      return Response.json(
        url.includes("/media/") ? { id: "media", title: "Media" } : [],
      );
    }),
  );
  const sockets: any[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const session = useSession();
  session.accept({ id: "user", username: "user", admin: false, csrf: "csrf" });
  const runtime = useRoomRuntime();
  const ranges = { length: 1, start: () => 0, end: () => 120 };
  const el: any = Object.assign(new EventTarget(), {
    src: "",
    readyState: 4,
    currentTime: 0,
    duration: 120,
    paused: true,
    seeking: false,
    ended: false,
    playbackRate: 1,
    buffered: ranges,
    seekable: ranges,
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
  try {
    runtime.attach(el);
    await runtime.enter({ id: "room", name: "Room", owner_id: "user" });
    const socket = sockets[0];
    socket.onopen();
    const frame = (value: unknown) =>
      socket.onmessage({ data: JSON.stringify(value) });
    const requests = () =>
      socket.send.mock.calls
        .map(([data]: [string]) => JSON.parse(data))
        .filter((v: any) => v.type === "CLOCK_SYNC");
    const reply = (request: any, serverTime: number) =>
      frame({
        type: "CLOCK_SYNC_REPLY",
        t1: request.t1,
        t2: serverTime,
        t3: serverTime,
        clock_epoch: "epoch",
      });
    frame({
      type: "SNAPSHOT",
      control_epoch: { id: "control" },
      state: {
        room_id: "room",
        revision: 1,
        media_id: "media",
        media_generation: 1,
        playback_status: "playing",
        anchor_position_ms: 10000,
        anchor_server_time_ms: 100,
        playback_rate: 1,
        controller_user_id: "user",
        duration_ms: 120000,
        clock_epoch: "epoch",
      },
    });
    expect(runtime.playbackHost.recoveryState).toBe("calibrating");
    reply(requests()[0], 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(el.src).toBe("/authorized.mp4");
    expect(grants).toBe(1);
    await el.onloadedmetadata();
    await vi.advanceTimersByTimeAsync(0);
    expect(el.currentTime).toBe(10);
    expect(el.paused).toBe(false);
    // The actual room composition exposes finite controls, never the raw video.
    expect(runtime).not.toHaveProperty("video");
    expect(runtime.$state).not.toHaveProperty("playbackControls");
    const controls = runtime.playbackControls;
    expect(controls.state?.playback_status).toBe("playing");
    controls.setLocalVolume(0.6);
    controls.setLocalMuted(true);
    expect(el.volume).toBe(0.6);
    expect(el.muted).toBe(true);
    expect(controls.togglePlayback()).toBe(true);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual(
      expect.objectContaining({
        type: "PAUSE", room_id: "room", control_epoch: "control",
        expected_revision: 1, media_generation: 1,
      }),
    );
    expect(el.paused).toBe(false);
    expect(grants).toBe(1);
    // PlaybackHost's canplay/playing event clears its local buffering flag.
    runtime.playbackHost.setWaiting(false);
    expect(runtime.playbackHost.recoveryState).toBe("idle");
    await vi.advanceTimersByTimeAsync(500);
    expect(el.playbackRate).toBeGreaterThan(1);
    const oldPending = requests().at(-1),
      before = el.currentTime;
    const pauses = el.pause.mock.calls.length,
      loads = el.load.mock.calls.length;
    const visible = (value: string) => {
      document.visibilityState = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
    visible("hidden");
    visible("visible");
    expect(el.playbackRate).toBe(1);
    expect(runtime.playbackHost.recoveryState).toBe("calibrating");
    expect(runtime.playbackHost.information.recoveryLabel).toContain("重新校准");
    const firstWake = requests().at(-1);
    reply(oldPending, 9999999);
    await vi.advanceTimersByTimeAsync(0);
    expect(el.currentTime).toBe(before);
    expect(el.paused).toBe(false);
    expect(runtime.playbackHost.recoveryState).toBe("calibrating");
    visible("hidden");
    visible("visible");
    reply(firstWake, 9999999);
    await vi.advanceTimersByTimeAsync(0);
    expect(el.currentTime).toBe(before);
    expect(runtime.playbackHost.recoveryState).toBe("calibrating");
    // Fresh epoch sample advances the true target to 10.5s. Resume through
    // normal convergence, preserving the 2s automatic hard-seek threshold.
    reply(requests().at(-1), 600);
    await vi.advanceTimersByTimeAsync(0);
    expect(el.currentTime).toBe(before);
    expect(el.paused).toBe(false);
    expect(runtime.playbackHost.recoveryState).toBe("catching_up");
    await vi.advanceTimersByTimeAsync(500);
    expect(el.playbackRate).toBeGreaterThan(1);
    expect(el.currentTime).toBe(before);
    expect(el.pause).toHaveBeenCalledTimes(pauses);
    expect(el.load).toHaveBeenCalledTimes(loads);
    expect(runtime.playbackHost.sessionId).toBe("session-1");
    expect(grants).toBe(1);
    const sends = requests().length;
    visible("visible");
    window.dispatchEvent(
      Object.assign(new Event("pageshow"), { persisted: false }),
    );
    expect(requests()).toHaveLength(sends);
    expect(runtime.playbackHost.recoveryState).toBe("catching_up");
    // Advancing the actual media into the current stable window completes the
    // recovery. A later ordinary drift must not reopen the live announcement.
    el.currentTime = 11.5;
    await vi.advanceTimersByTimeAsync(500);
    expect(runtime.playbackHost.recoveryState).toBe("idle");
    expect(runtime.playbackHost.information.recoveryLabel).toBe("");
    await vi.advanceTimersByTimeAsync(500);
    expect(runtime.playbackHost.recoveryState).toBe("idle");
    window.dispatchEvent(
      Object.assign(new Event("pageshow"), { persisted: true }),
    );
    expect(runtime.playbackHost.recoveryState).toBe("calibrating");
    await runtime.leave();
    expect(runtime.playbackHost.recoveryState).toBe("idle");
    expect(runtime.playbackHost.information.recoveryLabel).toBe("");
  } finally {
    runtime.$dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});
