import { afterEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { nextTick, ref, watch } from "vue";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { RequestFailure } from "../apps/web/src/errors";

const playback = vi.hoisted(() => ({
  apply: vi.fn(async () => {}),
  changed: vi.fn(),
  reset: vi.fn(async () => {}),
}));
vi.mock("../apps/web/src/features/playback/playback-runtime", () => ({
  createPlaybackRuntime: () => ({
    playbackError: ref(""),
    playbackBusy: ref(false),
    // Existing Settings actions are required by composition, but this room
    // fixture must never execute them. Keep unexpected calls observable.
    runPlayback: () => { throw Error("Unexpected runPlayback in room-request-scopes.test.ts"); },
    loadMedia: () => { throw Error("Unexpected loadMedia in room-request-scopes.test.ts"); },
    applySubtitles: () => { throw Error("Unexpected applySubtitles in room-request-scopes.test.ts"); },
    selectNativeQuality: () => { throw Error("Unexpected selectNativeQuality in room-request-scopes.test.ts"); },
    selectLadderQuality: () => { throw Error("Unexpected selectLadderQuality in room-request-scopes.test.ts"); },
    selectPlatformSubtitle: () => { throw Error("Unexpected selectPlatformSubtitle in room-request-scopes.test.ts"); },
    setPlatformDanmaku: () => { throw Error("Unexpected setPlatformDanmaku in room-request-scopes.test.ts"); },
    setPlatformLiveDanmaku: () => { throw Error("Unexpected setPlatformLiveDanmaku in room-request-scopes.test.ts"); },
    video: ref(),
    position: ref(0),
    waiting: ref(false),
    blocked: ref(false),
    dragging: ref(false),
    applyRoomState: playback.apply,
    mediaChanged: playback.changed,
    reset: playback.reset,
    onClockReady: vi.fn(),
    onClockInvalidated: vi.fn(),
  }),
}));
const disposals: (() => void)[] = [];
afterEach(() => {
  disposals
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (failure: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 8; i++) await nextTick();
}
async function fixture() {
  vi.useFakeTimers();
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
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
  const pinia = createPinia();
  setActivePinia(pinia);
  disposals.push(() => disposePinia(pinia));
  const session = useSession();
  session.accept({
    id: "owner",
    username: "owner",
    admin: false,
    csrf: "fixture",
  });
  const api = vi.fn(
    async (_path: string, _method = "GET", _body?: unknown): Promise<any> => [],
  );
  session.api = api as any;
  const runtime = useRoomRuntime();
  await runtime.enter({
    id: "room",
    name: "Room",
    owner_id: "owner",
    lifecycle: "active",
    lifecycle_epoch: 0,
  });
  const state = {
    room_id: "room",
    revision: 1,
    media_id: null,
    media_generation: 0,
    playback_status: "paused" as const,
    anchor_position_ms: 0,
    anchor_server_time_ms: 0,
    playback_rate: 1,
    controller_user_id: "owner",
    duration_ms: null,
    clock_epoch: "clock",
  };
  const frame = (value: unknown, socket = sockets.at(-1)) =>
    socket.onmessage({ data: JSON.stringify(value) });
  const snapshot = (extra: any = {}) =>
    frame({
      type: "SNAPSHOT",
      state,
      owner_id: "owner",
      lifecycle: "active",
      lifecycle_epoch: 0,
      control_epoch: { id: "control" },
      ...extra,
    });
  sockets[0].onopen();
  snapshot();
  await settle();
  api.mockClear();
  return { runtime, session, api, sockets, state, frame, snapshot };
}

it("a pre-reconnect lifecycle read cannot revert the resumed epoch or metadata", async () => {
  const s = await fixture(),
    old = deferred();
  s.api.mockImplementation(async (path) =>
    path.endsWith("/lifecycle") ? old.promise : [],
  );
  const read = s.runtime.refreshLifecycle();
  s.runtime.connect();
  s.sockets.at(-1).onopen();
  s.snapshot({
    state: { ...s.state, clock_epoch: "resumed", revision: 2 },
    owner_id: "new-owner",
  });
  old.resolve({
    state: { ...s.state, revision: 100 },
    owner_id: "old-owner",
    lifecycle: "closed",
    lifecycle_epoch: 99,
  });
  await read;
  expect(s.runtime.state?.clock_epoch).toBe("resumed");
  expect(s.runtime.room?.owner_id).toBe("new-owner");
  expect(s.runtime.room?.lifecycle).toBe("active");
  expect(s.sockets).toHaveLength(2);
});

it("an ownership command settles successfully but its old connection cannot overwrite a resumed snapshot", async () => {
  const s = await fixture(),
    commit = deferred();
  s.api.mockImplementation(async (path) =>
    path.endsWith("/owner") ? commit.promise : [],
  );
  const command = s.runtime.transferOwnership("recipient");
  s.runtime.connect();
  s.sockets.at(-1).onopen();
  s.snapshot({
    state: { ...s.state, clock_epoch: "resumed" },
    owner_id: "current-owner",
  });
  commit.resolve({ owner_id: "recipient", state: { ...s.state, revision: 2 } });
  await expect(command).resolves.toBeUndefined();
  expect(s.runtime.room?.owner_id).toBe("current-owner");
  expect(s.runtime.state?.clock_epoch).toBe("resumed");
  expect(
    s.api.mock.calls.filter(
      ([path, method]) => path.endsWith("/owner") && method === "POST",
    ),
  ).toHaveLength(1);
});

it("reconnect starts a fresh queue read without waiting for an obsolete connection's reply", async () => {
  const s = await fixture(),
    old = deferred(),
    fresh = deferred();
  let reads = 0;
  s.api.mockImplementation(async (path) =>
    path.endsWith("/playlist")
      ? ++reads === 1
        ? old.promise
        : fresh.promise
      : [],
  );
  const obsolete = s.runtime.refreshPlaylist();
  s.runtime.connect();
  s.sockets.at(-1).onopen();
  s.snapshot();
  await settle();
  expect(reads).toBe(2);
  fresh.resolve([{ id: "fresh", media_id: "fresh" }]);
  await settle();
  old.resolve([{ id: "old", media_id: "old" }]);
  await obsolete;
  expect(s.runtime.playlist.map((item) => item.id)).toEqual(["fresh"]);
  expect(s.runtime.playlistLoading).toBe(false);
});

it("reconnect keeps the original queue dedup operation and committed receipt when its refresh fails", async () => {
  const s = await fixture(),
    commit = deferred();
  let committed = false;
  s.api.mockImplementation(async (path, method = "GET") => {
    if (path.endsWith("/playlist") && method === "POST") return commit.promise;
    if (path.endsWith("/playlist") && committed) throw Error("refresh failed");
    return [];
  });
  const first = s.runtime.addQueue("film");
  s.runtime.connect();
  s.sockets.at(-1).onopen();
  s.snapshot();
  await settle();
  const repeated = s.runtime.addQueue("film");
  expect(s.runtime.queuePending("add", "film")).toBe(true);
  committed = true;
  commit.resolve({});
  await expect(first).resolves.toBeUndefined();
  await expect(repeated).resolves.toBeUndefined();
  expect(s.runtime.queueReceipt("add", "film")).toBe("已加入当前房间待播");
  expect(s.runtime.playlistError).toBe("refresh failed");
  expect(s.runtime.queuePending("add", "film")).toBe(false);
  expect(
    s.api.mock.calls.filter(([, method]) => method === "POST"),
  ).toHaveLength(1);
});

it("a stale cursor failure cannot launch fallback history on the superseded connection", async () => {
  const s = await fixture(),
    old = deferred();
  s.runtime.messages = [{ id: "cursor", body: "old" } as any];
  let cursors = 0,
    fallbackReads = 0;
  s.api.mockImplementation(async (path) => {
    if (path.endsWith("?after=cursor"))
      return ++cursors === 1 ? old.promise : [];
    if (path.endsWith("/messages")) {
      fallbackReads++;
      return [];
    }
    return [];
  });
  s.runtime.connect();
  s.sockets.at(-1).onopen();
  s.runtime.connect();
  s.sockets.at(-1).onopen();
  await settle();
  old.reject(new RequestFailure({ error: { code: "CHAT_CURSOR_NOT_FOUND" } }));
  await settle();
  expect(fallbackReads).toBe(0);
  expect(s.runtime.messages.map((message) => message.id)).toEqual(["cursor"]);
  expect(s.runtime.error).toBe("");
});

it("late history and queue replies from a retired exact login cannot affect a new login in the same room", async () => {
  const s = await fixture(),
    oldHistory = deferred(),
    oldQueue = deferred();
  s.api.mockImplementation(async (path) =>
    path.endsWith("/messages")
      ? oldHistory.promise
      : path.endsWith("/playlist")
        ? oldQueue.promise
        : [],
  );
  s.runtime.connect();
  s.sockets.at(-1).onopen();
  const oldRead = s.runtime.refreshPlaylist();
  s.session.clear();
  s.session.accept({
    id: "new-user",
    username: "new-user",
    admin: false,
    csrf: "new",
  });
  s.api.mockImplementation(async () => []);
  await s.runtime.enter({ id: "room", name: "Room", owner_id: "new-user" });
  oldHistory.resolve([{ id: "private", body: "private" }]);
  oldQueue.resolve([{ id: "private", media_id: "private" }]);
  await oldRead;
  await settle();
  expect(s.runtime.messages).toEqual([]);
  expect(s.runtime.playlist).toEqual([]);
  expect(s.runtime.room?.owner_id).toBe("new-user");
});

it("synchronous watchers see owner, controller, lifecycle and revision from the same projection", async () => {
  const s = await fixture();
  const observations: unknown[] = [];
  const stop = watch(
    () => [
      s.runtime.room?.owner_id,
      s.runtime.state?.controller_user_id,
      s.runtime.room?.lifecycle,
      s.runtime.state?.revision,
    ],
    (value) => observations.push(value),
    { flush: "sync" },
  );
  disposals.push(stop);
  s.frame({
    type: "EVENT",
    state: { ...s.state, revision: 2, controller_user_id: "next" },
    owner_id: "next",
    lifecycle: "closed",
    lifecycle_epoch: 2,
    control_epoch: null,
  });
  expect(observations.length).toBeGreaterThan(0);
  expect(
    observations.every(
      (value) =>
        JSON.stringify(value) === JSON.stringify(["next", "next", "closed", 2]),
    ),
  ).toBe(true);
});

it("the page facade does not expose projection/clock owner callbacks or playback error writers", async () => {
  const { runtime } = await fixture();
  for (const key of [
    "applyState",
    "applyRoomState",
    "mediaChanged",
    "reset",
    "onClockReady",
    "onClockInvalidated",
    "resetClockAction",
    "playbackError",
    "playbackBusy",
    "distributedIntent",
  ])
    expect(key in runtime).toBe(false);
});

it("late queue failure cannot clear a successor read's loading or replace its error", async () => {
  const s = await fixture(),
    old = deferred(),
    fresh = deferred();
  let reads = 0;
  s.api.mockImplementation(async (path) =>
    path.endsWith("/playlist")
      ? ++reads === 1
        ? old.promise
        : fresh.promise
      : [],
  );
  const obsolete = s.runtime.refreshPlaylist();
  s.runtime.connect();
  s.sockets.at(-1).onopen();
  s.snapshot();
  await settle();
  old.reject(Error("old connection failure"));
  await expect(obsolete).resolves.toBeUndefined();
  expect(s.runtime.playlistLoading).toBe(true);
  expect(s.runtime.playlistError).toBe("");
  fresh.reject(Error("current connection failure"));
  await settle();
  expect(s.runtime.playlistLoading).toBe(false);
  expect(s.runtime.playlistError).toBe("current connection failure");
});

it("same-login leave/reenter retires a queue commit without settling its successor operation", async () => {
  const s = await fixture(),
    old = deferred(),
    fresh = deferred();
  let posts = 0;
  s.api.mockImplementation(async (path, method = "GET") =>
    path.endsWith("/playlist") && method === "POST"
      ? ++posts === 1
        ? old.promise
        : fresh.promise
      : [],
  );
  const previous = s.runtime.addQueue("film");
  await s.runtime.leave();
  await s.runtime.enter({ id: "room", name: "Room", owner_id: "owner" });
  const current = s.runtime.addQueue("film");
  old.resolve({});
  await previous;
  expect(s.runtime.queuePending("add", "film")).toBe(true);
  expect(s.runtime.queueReceipt("add", "film")).toBe("");
  fresh.resolve({});
  await current;
  expect(s.runtime.queuePending("add", "film")).toBe(false);
  expect(s.runtime.queueReceipt("add", "film")).toBe("已加入当前房间待播");
  expect(posts).toBe(2);
});

it("a committed chat echo after reconnect preserves a newer draft and uses the original message ID", async () => {
  const s = await fixture();
  s.runtime.chat = "original draft";
  s.runtime.sendChat();
  const original = s.sockets[0].send.mock.calls
    .map(([value]: [string]) => JSON.parse(value))
    .find((value: any) => value.type === "CHAT");
  s.runtime.connect();
  s.sockets.at(-1).onopen();
  s.snapshot();
  s.runtime.chat = "newer draft";
  s.frame({
    type: "CHAT",
    id: "committed",
    body: "original draft",
    client_message_id: original.client_message_id,
  });
  expect(s.runtime.chat).toBe("newer draft");
  expect(s.runtime.chatPending).toBe(false);
  expect(s.runtime.chatFailed).toBe(false);
  expect(
    s.runtime.messages.filter((message) => message.id === "committed"),
  ).toHaveLength(1);
  expect(
    s.sockets
      .flatMap((socket) =>
        socket.send.mock.calls.map(([value]: [string]) => JSON.parse(value)),
      )
      .filter((value) => value.type === "CHAT"),
  ).toHaveLength(1);
});

it("composer disposal closes the current socket and clears sampling, retry and chat timers", async () => {
  const s = await fixture();
  s.runtime.chat = "pending";
  s.runtime.sendChat();
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  const socket = s.sockets.at(-1);
  s.runtime.$dispose();
  expect(socket.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  const before = s.api.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(s.api.mock.calls).toHaveLength(before);
});
