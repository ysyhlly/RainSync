import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("failed entry cleanup keeps the room inactive so the same room can be retried", async () => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  const saved = new Map([["rainsync:playback:user", '["old-request"]']]);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  const sockets: any[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    close = vi.fn();
    send = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValueOnce(new TypeError("temporary cleanup failure"))
      .mockImplementation(async () => Response.json([])),
  );
  const session = useSession();
  session.accept({ id: "user", username: "user", admin: false, csrf: "csrf" });
  const runtime = useRoomRuntime();
  const room = { id: "a", name: "A", owner_id: "user" };
  try {
    await expect(runtime.enter(room)).rejects.toThrow(
      "temporary cleanup failure",
    );
    expect(runtime.room).toBeNull();
    expect(sockets).toHaveLength(0);
    expect(saved.get("rainsync:playback:user")).toBe('["old-request"]');
    await runtime.enter(room);
    expect(runtime.room?.id).toBe("a");
    expect(sockets).toHaveLength(1);
    sockets[0].onopen();
    expect(runtime.connected).toBe(true);
    await runtime.enter(room);
    expect(sockets).toHaveLength(1);
    expect(saved.get("rainsync:playback:user")).toBe("[]");
  } finally {
    runtime.$dispose();
  }
});
it("same room entry retains its socket and stale playlist cannot overwrite a newer room", async () => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  const sockets: any[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    close = vi.fn();
    send = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  let resolveFirst!: (v: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url.includes("/a/playlist")
        ? new Promise((r) => (resolveFirst = r))
        : Promise.resolve(
            Response.json([{ id: "new", media_id: "m", title: "new" }]),
          ),
    ),
  );
  const session = useSession();
  session.accept({ id: "user", username: "user", admin: false, csrf: "csrf" });
  const runtime = useRoomRuntime();
  const first = runtime.enter({ id: "a", name: "A", owner_id: "user" });
  await vi.waitFor(() => expect(resolveFirst).toBeTypeOf("function"));
  await runtime.enter({ id: "b", name: "B", owner_id: "user" });
  const socket = sockets.at(-1);
  await runtime.enter({ id: "b", name: "B", owner_id: "user" });
  expect(sockets).toHaveLength(2);
  expect(socket.close).not.toHaveBeenCalled();
  resolveFirst(Response.json([{ id: "old", media_id: "m", title: "old" }]));
  await first;
  expect(runtime.playlist[0].id).toBe("new");
  expect(runtime.room?.id).toBe("b");
  session.clear();
  await nextTick();
  expect(runtime.room).toBeNull();
  expect(socket.close).toHaveBeenCalled();
  runtime.$dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("ownership events update management permissions and reject stale ownership snapshots", async () => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", new EventTarget());
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
    close = vi.fn();
    send = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const session = useSession();
  session.accept({ id: "user", username: "user", admin: false, csrf: "csrf" });
  const runtime = useRoomRuntime();
  try {
    await runtime.enter({ id: "a", name: "A", owner_id: "user" });
    const socket = sockets[0];
    socket.onopen();
    const state = {
      room_id: "a",
      revision: 1,
      media_id: null,
      media_generation: 0,
      playback_status: "paused",
      anchor_position_ms: 0,
      anchor_server_time_ms: 0,
      playback_rate: 1,
      controller_user_id: "user",
      duration_ms: null,
      clock_epoch: "clock",
    };
    const frame = (value: unknown) =>
      socket.onmessage({ data: JSON.stringify(value) });
    frame({
      type: "SNAPSHOT",
      state,
      owner_id: "user",
      control_epoch: { id: "old" },
    });
    expect(runtime.owner).toBe(true);
    expect(runtime.canManageRoom).toBe(true);
    frame({
      type: "EVENT",
      state: { ...state, revision: 2, controller_user_id: "next" },
      owner_id: "next",
      control_epoch: { id: "new" },
      action: { type: "TRANSFER_OWNERSHIP" },
    });
    expect(runtime.owner).toBe(false);
    expect(runtime.canManageRoom).toBe(false);
    expect(runtime.room?.owner_id).toBe("next");
    const sent = socket.send.mock.calls.length;
    runtime.send("PLAY");
    expect(socket.send).toHaveBeenCalledTimes(sent);
    frame({ type: "SNAPSHOT", state, owner_id: "user" });
    expect(runtime.room?.owner_id).toBe("next");
    expect(runtime.state?.revision).toBe(2);
    expect(sockets).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
  } finally {
    runtime.$dispose();
  }
});

it("a delayed ownership response cannot replace another room", async () => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  class Socket {
    static OPEN = 1;
    readyState = 1;
    close = vi.fn();
    send = vi.fn();
  }
  vi.stubGlobal("WebSocket", Socket);
  let resolveTransfer!: (value: Response) => void;
  const fetch = vi.fn((url: string) =>
    url.endsWith("/owner")
      ? new Promise<Response>((resolve) => {
          resolveTransfer = resolve;
        })
      : Promise.resolve(Response.json([])),
  );
  vi.stubGlobal("fetch", fetch);
  const session = useSession();
  session.accept({ id: "user", username: "user", admin: false, csrf: "csrf" });
  const runtime = useRoomRuntime();
  try {
    await runtime.enter({ id: "a", name: "A", owner_id: "user" });
    runtime.state = {
      room_id: "a",
      revision: 7,
      media_id: null,
      media_generation: 0,
      playback_status: "paused",
      anchor_position_ms: 0,
      anchor_server_time_ms: 0,
      playback_rate: 1,
      controller_user_id: "user",
      duration_ms: null,
      clock_epoch: "clock",
    };
    const transferredState = {
      ...runtime.state,
      revision: 8,
      controller_user_id: "next",
    };
    const pending = runtime.transferOwnership("next");
    const request = fetch.mock.calls.find(([url]) => url.endsWith("/owner"));
    expect(JSON.parse((request as any)[1].body)).toEqual({
      owner_id: "next",
      expected_revision: 7,
    });
    await runtime.enter({ id: "b", name: "B", owner_id: "user" });
    resolveTransfer(
      Response.json({ owner_id: "next", state: transferredState }),
    );
    await pending;
    expect(runtime.room?.id).toBe("b");
    expect(runtime.room?.owner_id).toBe("user");
    expect(runtime.state).toBeNull();
  } finally {
    runtime.$dispose();
  }
});

function lifecycleFixture(fetcher = vi.fn(async () => Response.json([]))) {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("fetch", fetcher);
  const sockets: any[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    close = vi.fn();
    send = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const session = useSession();
  session.accept({ id: "user", username: "user", admin: false, csrf: "csrf" });
  const runtime = useRoomRuntime();
  const state = {
    room_id: "a",
    revision: 1,
    media_id: null,
    media_generation: 0,
    playback_status: "paused" as const,
    anchor_position_ms: 0,
    anchor_server_time_ms: 0,
    playback_rate: 1,
    controller_user_id: "user",
    duration_ms: null,
    clock_epoch: "clock",
  };
  return { runtime, sockets, state };
}

it("lifecycle events keep history connected while fencing controls, chat and old snapshots", async () => {
  const { runtime, sockets, state } = lifecycleFixture();
  try {
    await runtime.enter({
      id: "a",
      name: "A",
      owner_id: "user",
      lifecycle: "active",
      lifecycle_epoch: 0,
    });
    const socket = sockets[0];
    socket.onopen();
    const frame = (value: unknown) =>
      socket.onmessage({ data: JSON.stringify(value) });
    frame({
      type: "SNAPSHOT",
      state,
      lifecycle: "active",
      lifecycle_epoch: 0,
      control_epoch: { id: "old" },
    });
    runtime.chat = "unsent";
    frame({
      type: "EVENT",
      state: { ...state, revision: 2 },
      lifecycle: "closing",
      lifecycle_epoch: 1,
      control_epoch: null,
    });
    expect(runtime.connected).toBe(true);
    expect(runtime.owner).toBe(false);
    expect(runtime.canManageRoom).toBe(true);
    expect(runtime.roomActive).toBe(false);
    const count = socket.send.mock.calls.length;
    runtime.send("PLAY");
    runtime.sendChat();
    expect(socket.send).toHaveBeenCalledTimes(count);
    await expect(runtime.makeInvite()).rejects.toThrow("房间当前未开放");
    await expect(runtime.addQueue("media")).rejects.toThrow("房间当前未开放");
    frame({
      type: "SNAPSHOT",
      state,
      lifecycle: "active",
      lifecycle_epoch: 0,
      control_epoch: { id: "old" },
    });
    expect(runtime.room?.lifecycle).toBe("closing");
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
      control_epoch: { id: "new" },
    });
    expect(runtime.roomActive).toBe(true);
    runtime.send("PLAY");
    expect(JSON.parse(socket.send.mock.calls.at(-1)[0]).control_epoch).toBe(
      "new",
    );
    expect(socket.close).not.toHaveBeenCalled();
  } finally {
    runtime.$dispose();
  }
});

it("a delayed lifecycle response cannot replace a newer room or lifecycle revision", async () => {
  let resolveClose!: (value: Response) => void;
  const fetcher = vi.fn((url: string) =>
    url.endsWith("/close")
      ? new Promise<Response>((resolve) => {
          resolveClose = resolve;
        })
      : Promise.resolve(Response.json([])),
  );
  const { runtime, state } = lifecycleFixture(fetcher);
  try {
    await runtime.enter({ id: "a", name: "A", owner_id: "user" });
    runtime.state = state;
    const pending = runtime.changeLifecycle("close");
    const request = fetcher.mock.calls.find(([url]) => url.endsWith("/close"));
    expect(JSON.parse((request as any)[1].body)).toEqual({
      expected_revision: 1,
    });
    await runtime.enter({ id: "b", name: "B", owner_id: "user" });
    resolveClose(
      Response.json({
        lifecycle: "closing",
        lifecycle_epoch: 1,
        owner_id: "user",
        state: { ...state, revision: 2 },
      }),
    );
    await pending;
    expect(runtime.room?.id).toBe("b");
    expect(runtime.roomActive).toBe(true);
    expect(runtime.state).toBeNull();
  } finally {
    runtime.$dispose();
  }
});
