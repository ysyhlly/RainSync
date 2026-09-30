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

it("same-generation close and reopen destroys old URL, requires a fresh plan, and stays paused", async () => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("location", {
    protocol: "http:",
    host: "localhost",
    href: "http://localhost/rooms/room",
  });
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  let plans = 0;
  const fetcher = vi.fn(async (url: string, request: RequestInit) => {
    if (url.endsWith("/playback-candidates"))
      return Response.json({
        schema_version: 1,
        binding: null,
        candidates: [],
        decision_reason: "legacy_transport_fallback",
      });
    if (url.endsWith("/playback-sessions") && request.method === "POST") {
      plans++;
      return Response.json({
        session_id: `session-${plans}`,
        media_id: "media",
        media_generation: 1,
        delivery_mode: "direct",
        transport: "progressive",
        playback_url: `/authorized-${plans}.mp4`,
        timeline_origin_ms: 0,
        duration_ms: 10000,
        expires_in_seconds: 1800,
        rebuild_on_seek: false,
        audio_tracks: [],
        subtitle_tracks: [],
      });
    }
    return Response.json(
      url.includes("/media/") ? { id: "media", title: "media" } : [],
    );
  });
  vi.stubGlobal("fetch", fetcher);
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
  const element: any = {
    canPlayType: () => "probably",
    pause: vi.fn(),
    play: vi.fn(async () => {}),
    load: vi.fn(),
    removeAttribute: vi.fn((name: string) => {
      if (name === "src") element.src = "";
    }),
    getAttribute: (name: string) => (name === "src" ? element.src : null),
    querySelectorAll: () => [],
    src: "",
    readyState: 1,
    currentTime: 0,
    duration: 10,
    buffered: { length: 0 },
    seekable: { length: 0 },
    paused: true,
  };
  try {
    runtime.attach(element);
    await runtime.enter({
      id: "room",
      name: "Room",
      owner_id: "user",
      lifecycle: "active",
      lifecycle_epoch: 0,
    });
    const socket = sockets[0];
    socket.onopen();
    const frame = (value: unknown) =>
      socket.onmessage({ data: JSON.stringify(value) });
    frame({ type: "CLOCK_SYNC_REPLY", t1: 0, t2: 0, t3: 0 });
    const state = {
      room_id: "room",
      revision: 1,
      media_id: "media",
      media_generation: 1,
      playback_status: "paused",
      anchor_position_ms: 0,
      anchor_server_time_ms: 0,
      playback_rate: 1,
      controller_user_id: "user",
      duration_ms: 10000,
      clock_epoch: "clock",
    };
    frame({
      type: "SNAPSHOT",
      state,
      lifecycle: "active",
      lifecycle_epoch: 0,
      control_epoch: { id: "old" },
    });
    await vi.waitFor(() => expect(element.src).toBe("/authorized-1.mp4"));
    const staleMetadata = element.onloadedmetadata;
    frame({
      type: "EVENT",
      state: { ...state, revision: 2 },
      lifecycle: "closing",
      lifecycle_epoch: 1,
      control_epoch: null,
    });
    expect(element.src).toBe("");
    expect(runtime.sessionId).toBeNull();
    expect(element.pause).toHaveBeenCalled();
    staleMetadata();
    await runtime.loadMedia();
    await vi.advanceTimersByTimeAsync(100);
    expect(plans).toBe(1);
    expect(element.src).toBe("");
    expect(element.play).not.toHaveBeenCalled();
    const posts = fetcher.mock.calls.filter(
      ([url, request]) =>
        url.endsWith("/playback-sessions") && request.method === "POST",
    );
    const firstKey = JSON.parse(String(posts[0][1].body)).idempotency_key;
    expect(
      fetcher.mock.calls.some(
        ([url, request]) =>
          url.endsWith(`/playback-requests/${firstKey}`) &&
          request.method === "DELETE",
      ),
    ).toBe(true);
    frame({
      type: "EVENT",
      state: { ...state, revision: 3 },
      lifecycle: "closed",
      lifecycle_epoch: 1,
      control_epoch: null,
    });
    frame({
      type: "EVENT",
      state: { ...state, revision: 4 },
      lifecycle: "active",
      lifecycle_epoch: 2,
      control_epoch: { id: "fresh" },
    });
    await vi.waitFor(() => expect(element.src).toBe("/authorized-2.mp4"));
    element.onloadedmetadata();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.state?.media_generation).toBe(1);
    expect(runtime.state?.playback_status).toBe("paused");
    expect(runtime.sessionId).toBe("session-2");
    expect(element.play).not.toHaveBeenCalled();
    runtime.send("PLAY");
    expect(JSON.parse(socket.send.mock.calls.at(-1)[0]).control_epoch).toBe(
      "fresh",
    );
  } finally {
    runtime.$dispose();
  }
});
