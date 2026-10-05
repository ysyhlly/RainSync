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

it("a missing control revision fences commands and resumes before applying lifecycle metadata", async () => {
  const { runtime, sockets, state } = lifecycleFixture();
  try {
    await runtime.enter({ id: "a", name: "A", owner_id: "user" });
    const first = sockets[0];
    first.onopen();
    const frame = (socket: any, value: unknown) =>
      socket.onmessage({ data: JSON.stringify(value) });
    frame(first, {
      type: "SNAPSHOT",
      state,
      owner_id: "user",
      lifecycle: "active",
      lifecycle_epoch: 0,
      control_epoch: { id: "old" },
    });
    frame(first, {
      type: "EVENT",
      state: { ...state, revision: 3, controller_user_id: "next" },
      owner_id: "next",
      lifecycle: "closing",
      lifecycle_epoch: 1,
      control_epoch: null,
    });
    expect(first.close).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(2);
    expect(runtime.state?.revision).toBe(1);
    expect(runtime.room?.owner_id).toBe("user");
    expect(runtime.roomActive).toBe(true);
    expect(runtime.connected).toBe(false);
    const previousSends = first.send.mock.calls.length;
    runtime.send("PLAY");
    expect(first.send).toHaveBeenCalledTimes(previousSends);
    // A buffered frame on the superseded physical connection cannot restore
    // control or overwrite the recovery baseline.
    frame(first, {
      type: "SNAPSHOT",
      state: { ...state, revision: 99 },
      owner_id: "wrong",
      control_epoch: { id: "late" },
    });
    expect(runtime.state?.revision).toBe(1);
    const second = sockets[1];
    second.onopen();
    expect(JSON.parse(second.send.mock.calls[0][0])).toEqual({
      type: "RESUME",
      room_id: "a",
      revision: 1,
      clock_epoch: "clock",
      presence_version: 1,
      control_recovery_metrics_version: 1,
    });
    frame(second, {
      type: "SNAPSHOT",
      recovery: "snapshot",
      state: { ...state, revision: 3, controller_user_id: "next" },
      owner_id: "next",
      lifecycle: "closing",
      lifecycle_epoch: 1,
      control_epoch: null,
    });
    expect(runtime.state?.revision).toBe(3);
    expect(runtime.room?.owner_id).toBe("next");
    expect(runtime.roomActive).toBe(false);
    expect(runtime.canManageRoom).toBe(false);
  } finally {
    runtime.$dispose();
  }
});

async function recoveryFixture() {
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
  const identity = { id: "user", username: "user", admin: false, csrf: "csrf" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(url.endsWith("/auth/me") ? identity : []),
    ),
  );
  const sockets: any[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const session = useSession();
  session.accept(identity);
  const runtime = useRoomRuntime();
  await runtime.enter({ id: "a", name: "A", owner_id: "user" });
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
  const frame = (socket: any, value: unknown) =>
    socket.onmessage({ data: JSON.stringify(value) });
  const snapshot = (socket = sockets.at(-1), extra: any = {}) =>
    frame(socket, {
      type: "SNAPSHOT",
      state,
      owner_id: "user",
      lifecycle: "active",
      lifecycle_epoch: 0,
      control_epoch: { id: "control" },
      control_recovery_metrics_version: 1,
      ...extra,
    });
  const packets = (socket = sockets.at(-1)) =>
    socket.send.mock.calls
      .map(([value]: [string]) => JSON.parse(value))
      .filter((v: any) => v.type === "CONTROL_RECOVERY_METRICS");
  return {
    runtime,
    session,
    sockets,
    state,
    frame,
    snapshot,
    packets,
    document,
    window,
  };
}

it("negotiates and reports once after all authoritative snapshot fields are applied, before clock sampling", async () => {
  const s = await recoveryFixture();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    expect(
      JSON.parse(socket.send.mock.calls[0][0]).control_recovery_metrics_version,
    ).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    socket.send.mockImplementation((payload: string) => {
      if (JSON.parse(payload).type === "CONTROL_RECOVERY_METRICS") {
        expect(s.runtime.state?.revision).toBe(1);
        expect(s.runtime.room?.owner_id).toBe("user");
        expect(s.runtime.room?.lifecycle).toBe("active");
      }
    });
    s.snapshot(socket);
    expect(s.packets(socket)).toEqual([
      {
        type: "CONTROL_RECOVERY_METRICS",
        version: 1,
        socket_open_to_state_applied_ms: 25,
        background: false,
      },
    ]);
    const types = socket.send.mock.calls.map(
      ([value]: [string]) => JSON.parse(value).type,
    );
    expect(types.indexOf("CONTROL_RECOVERY_METRICS")).toBeLessThan(
      types.indexOf("CLOCK_SYNC"),
    );
    s.snapshot(socket);
    s.frame(socket, { type: "EVENT", state: { ...s.state, revision: 2 } });
    expect(s.packets(socket)).toHaveLength(1);
  } finally {
    s.runtime.$dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each([undefined, 0, 2, "1"])(
  "a server marker %j preserves control recovery without telemetry",
  async (marker) => {
    const s = await recoveryFixture();
    try {
      const socket = s.sockets[0];
      socket.onopen();
      s.snapshot(socket, { control_recovery_metrics_version: marker });
      expect(s.runtime.state?.revision).toBe(1);
      expect(s.packets(socket)).toHaveLength(0);
      s.snapshot(socket);
      expect(s.packets(socket)).toHaveLength(0);
    } finally {
      s.runtime.$dispose();
    }
  },
);

it("reconnect reports the observed close separately and ignores stale callbacks and browser online hints", async () => {
  const s = await recoveryFixture();
  try {
    const first = s.sockets[0];
    first.onopen();
    s.snapshot(first);
    await vi.advanceTimersByTimeAsync(10);
    await first.onclose();
    await vi.advanceTimersByTimeAsync(100);
    s.runtime.connect();
    const second = s.sockets.at(-1);
    second.onopen();
    s.window.dispatchEvent(new Event("online"));
    s.snapshot(first, { state: { ...s.state, revision: 100 } });
    await vi.advanceTimersByTimeAsync(20);
    s.snapshot(second, { recovery: "delta", events: [] });
    expect(s.packets(second)).toEqual([
      {
        type: "CONTROL_RECOVERY_METRICS",
        version: 1,
        socket_open_to_state_applied_ms: 20,
        disconnect_observed_to_state_applied_ms: 120,
        background: false,
      },
    ]);
    expect(s.runtime.state?.revision).toBe(1);
  } finally {
    s.runtime.$dispose();
  }
});

it("a rejected EVENT resync measures its new snapshot without inventing a disconnect", async () => {
  const s = await recoveryFixture();
  try {
    const first = s.sockets[0];
    first.onopen();
    s.snapshot(first);
    s.frame(first, {
      type: "EVENT",
      state: { ...s.state, revision: 5 },
      control_recovery_metrics_version: 1,
    });
    const second = s.sockets[1];
    second.onopen();
    s.frame(second, { type: "PRESENCE_SNAPSHOT" });
    s.frame(second, {
      type: "CLOCK_SYNC_REPLY",
      t1: 0,
      t2: 0,
      t3: 0,
      clock_epoch: "clock",
    });
    expect(s.packets(second)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    s.snapshot(second, {
      state: { ...s.state, revision: 5, clock_epoch: "restarted" },
    });
    expect(s.packets(second)).toEqual([
      {
        type: "CONTROL_RECOVERY_METRICS",
        version: 1,
        socket_open_to_state_applied_ms: 10,
        background: false,
      },
    ]);
  } finally {
    s.runtime.$dispose();
  }
});

it("paused control recovery retains hidden time and persisted pageshow discards timing", async () => {
  const s = await recoveryFixture();
  try {
    const first = s.sockets[0];
    first.onopen();
    await vi.advanceTimersByTimeAsync(10);
    s.document.visibilityState = "hidden";
    s.document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(50);
    s.document.visibilityState = "visible";
    s.document.dispatchEvent(new Event("visibilitychange"));
    s.snapshot(first);
    expect(s.packets(first)[0]).toMatchObject({
      socket_open_to_state_applied_ms: 60,
      background: true,
    });
    s.runtime.connect();
    const second = s.sockets[1];
    second.onopen();
    s.window.dispatchEvent(
      Object.assign(new Event("pageshow"), { persisted: true }),
    );
    s.snapshot(second);
    expect(s.packets(second)).toHaveLength(0);
    expect(s.runtime.state?.revision).toBe(1);
  } finally {
    s.runtime.$dispose();
  }
});

it.each([65_536, Infinity, -1])(
  "a socket buffer %j drops telemetry without changing recovery",
  async (buffered) => {
    const s = await recoveryFixture();
    try {
      const socket = s.sockets[0];
      socket.onopen();
      socket.bufferedAmount = buffered;
      s.snapshot(socket);
      expect(s.packets(socket)).toHaveLength(0);
      expect(s.runtime.state?.revision).toBe(1);
      socket.bufferedAmount = 0;
      s.snapshot(socket);
      expect(s.packets(socket)).toHaveLength(0);
    } finally {
      s.runtime.$dispose();
    }
  },
);

it("a telemetry send failure cannot escape, alter state, or suppress calibration", async () => {
  const s = await recoveryFixture();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    socket.send.mockImplementation((value: string) => {
      if (JSON.parse(value).type === "CONTROL_RECOVERY_METRICS")
        throw Error("closed during send");
    });
    expect(() => s.snapshot(socket)).not.toThrow();
    expect(s.runtime.state?.revision).toBe(1);
    expect(s.runtime.error).toBe("");
    expect(
      socket.send.mock.calls.some(
        ([value]: [string]) => JSON.parse(value).type === "CLOCK_SYNC",
      ),
    ).toBe(true);
  } finally {
    s.runtime.$dispose();
  }
});

it("a closed authoritative snapshot reports applied state without restoring commands or clock sampling", async () => {
  const s = await recoveryFixture();
  try {
    const socket = s.sockets[0];
    socket.onopen();
    s.snapshot(socket, {
      lifecycle: "closed",
      lifecycle_epoch: 1,
      control_epoch: null,
    });
    expect(s.packets(socket)).toHaveLength(1);
    expect(s.runtime.roomActive).toBe(false);
    expect(s.runtime.owner).toBe(false);
    const sent = socket.send.mock.calls.length;
    s.runtime.send("PLAY");
    expect(socket.send).toHaveBeenCalledTimes(sent);
    expect(
      socket.send.mock.calls.some(
        ([value]: [string]) => JSON.parse(value).type === "CLOCK_SYNC",
      ),
    ).toBe(false);
  } finally {
    s.runtime.$dispose();
  }
});

it("fatal membership loss and auth changes discard current telemetry before stale snapshots", async () => {
  const s = await recoveryFixture();
  try {
    const first = s.sockets[0];
    first.onopen();
    s.frame(first, {
      type: "ERROR",
      error: {
        code: "NOT_A_MEMBER",
        message: "revoked",
        retryable: false,
        request_id: "r",
      },
    });
    s.snapshot(first);
    expect(s.packets(first)).toHaveLength(0);
    expect(s.runtime.room).toBeNull();
    await s.runtime.enter({ id: "b", name: "B", owner_id: "user" });
    const second = s.sockets.at(-1);
    second.onopen();
    s.session.clear();
    s.snapshot(second, { state: { ...s.state, room_id: "b" } });
    expect(s.packets(second)).toHaveLength(0);
  } finally {
    s.runtime.$dispose();
  }
});

it("an ACK with a revision gap uses the same snapshot recovery as a missed EVENT", async () => {
  const { runtime, sockets, state } = lifecycleFixture();
  try {
    await runtime.enter({ id: "a", name: "A", owner_id: "user" });
    const socket = sockets[0];
    socket.onopen();
    socket.onmessage({ data: JSON.stringify({ type: "SNAPSHOT", state }) });
    socket.onmessage({
      data: JSON.stringify({
        type: "ACK",
        state: { ...state, revision: 4 },
        control_epoch: { id: "gapped" },
      }),
    });
    expect(runtime.state?.revision).toBe(1);
    expect(sockets).toHaveLength(2);
    sockets[1].onopen();
    runtime.send("PLAY");
    expect(sockets[1].send).toHaveBeenCalledTimes(1);
  } finally {
    runtime.$dispose();
  }
});

it("a control event from another server clock requires a snapshot and does not replay its action", async () => {
  const { runtime, sockets, state } = lifecycleFixture();
  try {
    await runtime.enter({ id: "a", name: "A", owner_id: "user" });
    const socket = sockets[0];
    socket.onopen();
    socket.onmessage({ data: JSON.stringify({ type: "SNAPSHOT", state }) });
    socket.onmessage({
      data: JSON.stringify({
        type: "EVENT",
        state: { ...state, revision: 2, clock_epoch: "restarted" },
        action: { type: "SEEK" },
      }),
    });
    expect(runtime.state).toEqual(state);
    expect(sockets).toHaveLength(2);
    const next = sockets[1];
    next.onopen();
    next.onmessage({
      data: JSON.stringify({
        type: "SNAPSHOT",
        state: { ...state, revision: 2, clock_epoch: "restarted" },
        control_epoch: { id: "fresh" },
      }),
    });
    expect(runtime.state?.clock_epoch).toBe("restarted");
    expect(runtime.state?.revision).toBe(2);
  } finally {
    runtime.$dispose();
  }
});
