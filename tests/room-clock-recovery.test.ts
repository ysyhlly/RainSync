import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { RequestFailure } from "../apps/web/src/errors";
import type { RoomTimelinePort } from "../apps/web/src/features/playback/playback-runtime-types";

const playback = vi.hoisted(() => ({
  ctx: undefined as any,
  ready: vi.fn(),
  invalidated: vi.fn(),
  apply: vi.fn(async () => {}),
  reset: vi.fn(async () => {}),
  changed: vi.fn(),
}));
vi.mock("../apps/web/src/features/playback/playback-runtime", () => ({
  createPlaybackRuntime: (ctx: any) => {
    playback.ctx = ctx;
    return {
      // Host action registration requires these unused capabilities.
      attach: () => { throw Error("Unexpected attach in room-clock-recovery.test.ts"); },
      enablePlayback: () => { throw Error("Unexpected enablePlayback in room-clock-recovery.test.ts"); },
      cancelPreparation: () => { throw Error("Unexpected cancelPreparation in room-clock-recovery.test.ts"); },
      playbackError: ref(""),
      playbackBusy: ref(false),
      // Existing Settings actions are required by composition, but this room
      // fixture must never execute them. Keep unexpected calls observable.
      applySubtitles: () => { throw Error("Unexpected applySubtitles in room-clock-recovery.test.ts"); },
      selectNativeQuality: () => { throw Error("Unexpected selectNativeQuality in room-clock-recovery.test.ts"); },
      selectLadderQuality: () => { throw Error("Unexpected selectLadderQuality in room-clock-recovery.test.ts"); },
      selectPlatformSubtitle: () => { throw Error("Unexpected selectPlatformSubtitle in room-clock-recovery.test.ts"); },
      setPlatformDanmaku: () => { throw Error("Unexpected setPlatformDanmaku in room-clock-recovery.test.ts"); },
      setPlatformLiveDanmaku: () => { throw Error("Unexpected setPlatformLiveDanmaku in room-clock-recovery.test.ts"); },
      runPlayback: async (action: () => Promise<unknown>) => { await action(); },
      video: ref(),
      position: ref(0),
      waiting: ref(false),
      blocked: ref(false),
      dragging: ref(false),
      applyState: playback.apply,
      applyRoomState: (...args: Parameters<typeof playback.apply>) => playback.apply(...args),
      loadMedia: vi.fn(),
      reset: playback.reset,
      mediaChanged: playback.changed,
      onClockReady: playback.ready,
      onClockInvalidated: playback.invalidated,
    };
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function setup() {
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
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json([])),
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
  await runtime.enter({ id: "room", name: "Room", owner_id: "user" });
  const state = {
    room_id: "room",
    revision: 1,
    media_id: null,
    media_generation: 0,
    playback_status: "playing",
    anchor_position_ms: 0,
    anchor_server_time_ms: 0,
    playback_rate: 1,
    controller_user_id: "user",
    duration_ms: null,
    clock_epoch: "epoch",
  };
  const frame = (socket: any, value: unknown) =>
    socket.onmessage({ data: JSON.stringify(value) });
  const requests = (socket = sockets.at(-1)) =>
    socket.send.mock.calls
      .map(([value]: [string]) => JSON.parse(value))
      .filter((v: any) => v.type === "CLOCK_SYNC");
  const snapshot = (socket = sockets.at(-1), epoch = "epoch", revision = 1) =>
    frame(socket, {
      type: "SNAPSHOT",
      state: { ...state, revision, clock_epoch: epoch },
      control_epoch: { id: "control" },
    });
  const reply = (socket: any, request: any, epoch = "epoch") =>
    frame(socket, {
      type: "CLOCK_SYNC_REPLY",
      t1: request.t1,
      t2: 100,
      t3: 100,
      clock_epoch: epoch,
    });
  const visible = (value: string) => {
    document.visibilityState = value;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const pageshow = (persisted: boolean) =>
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
  const clock: RoomTimelinePort["clock"] = playback.ctx.timeline.clock;
  return {
    runtime,
    session,
    state,
    sockets,
    clock,
    frame,
    requests,
    snapshot,
    reply,
    visible,
    pageshow,
    document,
    check: playback.ctx.timeline.checkClock,
  };
}

it("ignores unregistered replies before this connection's snapshot", async () => {
  const s = await setup();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    s.frame(socket, {
      type: "CLOCK_SYNC_REPLY",
      t1: 0,
      t2: 100,
      t3: 100,
      clock_epoch: "epoch",
    });
    expect(s.clock.ready).toBe(false);
    expect(s.requests()).toHaveLength(0);
    s.snapshot();
    s.reply(socket, s.requests()[0]);
    expect(s.clock.ready).toBe(true);
    expect(playback.ready).toHaveBeenCalledOnce();
  } finally {
    s.runtime.$dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("fences each hidden-to-visible round and leaves harmless visibility events alone", async () => {
  const s = await setup();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    s.snapshot();
    const old = s.requests()[0];
    s.reply(socket, old);
    const revision = s.clock.revision,
      invalidations = playback.invalidated.mock.calls.length;
    const count = s.requests().length,
      applies = playback.apply.mock.calls.length;
    s.visible("visible");
    expect(s.clock.revision).toBe(revision);
    expect(s.requests()).toHaveLength(count);
    expect(playback.invalidated).toHaveBeenCalledTimes(invalidations);
    expect(playback.apply).toHaveBeenCalledTimes(applies);
    s.visible("hidden");
    await vi.advanceTimersByTimeAsync(20);
    s.visible("visible");
    const firstWake = s.requests().at(-1);
    expect(s.clock.ready).toBe(false);
    expect(s.clock.now()).toBe(performance.now());
    s.reply(socket, old);
    expect(s.clock.ready).toBe(false);
    s.visible("hidden");
    await vi.advanceTimersByTimeAsync(20);
    s.visible("visible");
    s.reply(socket, firstWake);
    expect(s.clock.ready).toBe(false);
    const current = s.requests().at(-1);
    s.reply(socket, current);
    expect(s.clock.ready).toBe(true);
    expect(playback.ready).toHaveBeenCalledTimes(2);
    expect(s.sockets).toHaveLength(1);
    expect(playback.reset).toHaveBeenCalledTimes(1);
  } finally {
    s.runtime.$dispose();
  }
});

it("only persisted pageshow invalidates calibration and old replies", async () => {
  const s = await setup();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    s.snapshot();
    const old = s.requests()[0];
    s.reply(socket, old);
    const revision = s.clock.revision;
    s.pageshow(false);
    expect(s.clock.revision).toBe(revision);
    await vi.advanceTimersByTimeAsync(10);
    s.pageshow(true);
    expect(s.clock.revision).toBe(revision + 1);
    expect(s.clock.ready).toBe(false);
    s.reply(socket, old);
    expect(s.clock.ready).toBe(false);
    s.reply(socket, s.requests().at(-1));
    expect(s.clock.ready).toBe(true);
  } finally {
    s.runtime.$dispose();
  }
});

it("clears pending on disconnect, and requires the reconnect socket's snapshot and epoch", async () => {
  const s = await setup();
  try {
    const first = s.sockets[0];
    first.onopen();
    s.snapshot();
    const old = s.requests()[0];
    s.reply(first, old);
    // Connection loss invalidates synchronously, before asynchronous session checking.
    first.onclose();
    expect(s.clock.ready).toBe(false);
    s.reply(first, old);
    expect(s.clock.ready).toBe(false);
    s.runtime.connect();
    const second = s.sockets[1];
    second.onopen();
    s.reply(second, old);
    expect(s.clock.ready).toBe(false);
    s.snapshot(second, "next");
    const request = s.requests(second).at(-1);
    s.reply(first, request, "next");
    expect(s.clock.ready).toBe(false);
    s.reply(second, request, "epoch");
    expect(s.clock.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    s.reply(second, s.requests(second).at(-1), "next");
    expect(s.clock.ready).toBe(true);
  } finally {
    s.runtime.$dispose();
  }
});

it("normal periodic samples update calibration without queuing a forced recovery", async () => {
  const s = await setup();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    s.snapshot();
    s.reply(socket, s.requests()[0]);
    const revision = s.clock.revision,
      invalidations = playback.invalidated.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(s.clock.revision).toBe(revision);
    expect(playback.invalidated).toHaveBeenCalledTimes(invalidations);
    s.reply(socket, s.requests().at(-1));
    expect(s.clock.ready).toBe(true);
    expect(s.sockets).toHaveLength(1);
    expect(playback.reset).toHaveBeenCalledTimes(1);
  } finally {
    s.runtime.$dispose();
  }
});

it("resamples on evidence of suspension before the next correction and survives a backwards clock", async () => {
  const s = await setup();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    s.snapshot();
    s.reply(socket, s.requests()[0]);
    const now = vi.spyOn(performance, "now").mockReturnValue(12000);
    s.check();
    expect(s.clock.ready).toBe(false);
    const old = s.requests().at(-1);
    s.reply(socket, old);
    expect(s.clock.ready).toBe(true);
    now.mockReturnValue(10);
    s.check();
    expect(s.clock.ready).toBe(false);
    s.reply(socket, old);
    expect(s.clock.ready).toBe(false);
    s.reply(socket, s.requests().at(-1));
    expect(s.clock.ready).toBe(true);
    now.mockRestore();
  } finally {
    s.runtime.$dispose();
  }
});

it("fences a newer HTTP clock epoch until RESUME confirms it", async () => {
  const s = await setup();
  try {
    const first = s.sockets[0];
    first.onopen();
    s.snapshot();
    s.reply(first, s.requests()[0]);
    vi.spyOn(s.session, "api").mockResolvedValueOnce({
      owner_id: "user",
      state: { ...s.state, revision: 2, clock_epoch: "next" },
    });
    await s.runtime.transferOwnership("user");
    expect(s.clock.ready).toBe(false);
    expect(s.sockets).toHaveLength(2);
    const second = s.sockets[1];
    second.onopen();
    expect(s.requests(second)).toHaveLength(0);
    s.snapshot(second, "next", 2);
    s.reply(second, s.requests(second).at(-1), "next");
    expect(s.clock.ready).toBe(true);
  } finally {
    s.runtime.$dispose();
  }
});

it("does not let a continuous EVENT bypass the reconnect snapshot", async () => {
  const s = await setup();
  try {
    const first = s.sockets[0];
    first.onopen();
    s.snapshot();
    s.runtime.connect();
    const second = s.sockets[1];
    second.onopen();
    s.frame(second, { type: "EVENT", state: { ...s.state, revision: 2 } });
    expect(s.sockets).toHaveLength(3);
    expect(s.clock.ready).toBe(false);
    expect(s.runtime.state?.revision).toBe(1);
    expect(s.requests(second)).toHaveLength(0);
  } finally {
    s.runtime.$dispose();
  }
});

it("detects a wall-time suspension with a stalled monotonic clock", async () => {
  const s = await setup();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    s.snapshot();
    s.reply(socket, s.requests()[0]);
    const previous = s.requests()[0];
    vi.setSystemTime(Date.now() + 20000);
    s.check();
    expect(s.clock.ready).toBe(false);
    s.reply(socket, previous);
    expect(s.clock.ready).toBe(false);
    s.reply(socket, s.requests().at(-1));
    expect(s.clock.ready).toBe(true);
  } finally {
    s.runtime.$dispose();
  }
});

it("accepts a new HTTP epoch even when its revision restarted lower", async () => {
  const s = await setup();
  try {
    const first = s.sockets[0];
    first.onopen();
    s.snapshot(first, "epoch", 20);
    s.reply(first, s.requests()[0]);
    vi.spyOn(s.session, "api").mockResolvedValueOnce({
      owner_id: "next",
      state: { ...s.state, revision: 1, clock_epoch: "next" },
    });
    await s.runtime.transferOwnership("next");
    expect(s.runtime.state?.clock_epoch).toBe("next");
    expect(s.runtime.state?.revision).toBe(1);
    expect(s.runtime.room?.owner_id).toBe("next");
    expect(s.clock.ready).toBe(false);
    expect(s.sockets).toHaveLength(2);
  } finally {
    s.runtime.$dispose();
  }
});

it("remote seek preserves an existing authentication error", async () => {
  const s = await setup();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    s.snapshot();
    s.runtime.error = "登录已失效，请重新登录";
    s.frame(socket, {
      type: "EVENT",
      action: { type: "SEEK" },
      state: { ...s.state, revision: 2 },
    });
    expect(s.runtime.error).toBe("登录已失效，请重新登录");
    expect(playback.apply).toHaveBeenLastCalledWith(true, true);
  } finally {
    s.runtime.$dispose();
  }
});

it.each([["ACK", "EVENT"], ["EVENT", "ACK"]])("applies a committed seek once for %s then %s", async (first, second) => {
  const s = await setup();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    s.snapshot();
    playback.apply.mockClear();
    const event = { action: { type: "SEEK" }, state: { ...s.state, revision: 2, anchor_position_ms: 30000 } };
    s.frame(socket, { ...event, type: first });
    s.frame(socket, { ...event, type: second });
    expect(playback.apply).toHaveBeenCalledOnce();
    expect(playback.apply).toHaveBeenLastCalledWith(true, true);
    s.frame(socket, { ...event, type: "EVENT", state: { ...event.state, revision: 3 } });
    expect(playback.apply).toHaveBeenCalledTimes(2);
  } finally {
    s.runtime.$dispose();
  }
});

it("equal revisions still apply refreshed control metadata and closing lifecycle", async () => {
  const s = await setup();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    s.snapshot();
    playback.apply.mockClear();
    s.frame(socket, { type: "ACK", state: s.state, control_epoch: { id: "new-control" } });
    expect(playback.apply).not.toHaveBeenCalled();
    s.runtime.send("PLAY");
    expect(JSON.parse(socket.send.mock.calls.at(-1)[0])).toMatchObject({ type: "PLAY", control_epoch: "new-control" });
    playback.reset.mockClear();
    s.frame(socket, { type: "EVENT", state: s.state, lifecycle: "closed", lifecycle_epoch: 2, control_epoch: null });
    expect(s.runtime.room?.lifecycle).toBe("closed");
    expect(playback.reset).toHaveBeenCalledOnce();
    expect(playback.apply).not.toHaveBeenCalled();
  } finally {
    s.runtime.$dispose();
  }
});

it("equal revisions in a new clock epoch still apply snapshot metadata and recalibrate", async () => {
  const s = await setup();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    s.snapshot();
    s.reply(socket, s.requests()[0]);
    expect(s.clock.ready).toBe(true);
    s.frame(socket, {
      type: "SNAPSHOT", state: { ...s.state, clock_epoch: "next-clock" },
      owner_id: "next-owner", control_epoch: { id: "next-control" },
    });
    expect(s.runtime.state?.clock_epoch).toBe("next-clock");
    expect(s.runtime.room?.owner_id).toBe("next-owner");
    expect(s.clock.ready).toBe(false);
    s.reply(socket, s.requests().at(-1), "next-clock");
    expect(s.clock.ready).toBe(true);
  } finally {
    s.runtime.$dispose();
  }
});


it("a deleted chat cursor falls back once to latest history and deduplicates live messages", async () => {
  const s = await setup();
  try {
    s.runtime.messages = [{ id: "deleted", body: "previous" } as any];
    let latest!: (value: any) => void;
    const api = vi.spyOn(s.session, "api").mockImplementation(async (path: string) => {
      if (path.endsWith("?after=deleted")) throw new RequestFailure({ error: { code: "CHAT_CURSOR_NOT_FOUND" } });
      if (path.endsWith("/messages")) return new Promise(resolve => latest = resolve);
      return [] as any;
    });
    const socket = s.sockets[0];
    socket.onopen();
    await vi.advanceTimersByTimeAsync(0);
    s.frame(socket, { type: "CHAT", id: "latest-99", body: "arrived live" });
    latest(Array.from({ length: 100 }, (_, i) => ({ id: `latest-${i}`, body: "latest" })));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.mock.calls.filter(([path]) => path.includes("/messages") && !path.includes("check_ids="))).toHaveLength(2);
    expect(s.runtime.messages).toHaveLength(101);
    expect(s.runtime.messages.filter(m => m.id === "latest-99")).toHaveLength(1);
    expect(s.runtime.messages.at(-1)?.body).toBe("arrived live");
    expect(s.runtime.error).toBe("");
  } finally {
    s.runtime.$dispose();
  }
});

it("a repeated full chat page cannot produce an infinite cursor cycle", async () => {
  const s = await setup();
  try {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `message-${i}`, body: "message" }));
    const api = vi.spyOn(s.session, "api").mockImplementation(async (path: string) => path.includes("/messages") && !path.includes("check_ids=") ? page : [] as any);
    s.sockets[0].onopen();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.mock.calls.filter(([path]) => path.includes("/messages") && !path.includes("check_ids="))).toHaveLength(2);
    expect(s.runtime.messages).toHaveLength(100);
  } finally {
    s.runtime.$dispose();
  }
});
