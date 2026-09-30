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
