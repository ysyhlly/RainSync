import { afterEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { readFileSync } from "node:fs";
import { parse } from "@vue/compiler-sfc";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { privateLibraryApi } from "../apps/web/src/features/private-library/private-library.api";
import { mountSetup } from "./helpers/mount-setup";

const disposals: (() => void)[] = [];
afterEach(() => {
  disposals
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const room = { id: "room", name: "Room", owner_id: "owner" };
const rows = (ids: string[]) =>
  ids.map((id) => ({ id, media_id: id, title: id }));
function fixture() {
  vi.useFakeTimers();
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
  const runtime = useRoomRuntime();
  runtime.room = { ...room };
  const api = vi.fn(
    async (path: string, _method = "GET", _body?: unknown): Promise<any> =>
      path.endsWith("/permissions")
        ? { self_permissions: [], members: [] }
        : path.endsWith("/playlist")
          ? []
          : { id: path.split("/").at(-1), title: "Film", kind: "local" },
  );
  session.api = api as any;
  return { runtime, session, api, sockets };
}

it("keeps all concurrent actions busy and rejects an older same-room playlist response", async () => {
  const { runtime: r, api } = fixture();
  const posts = [deferred(), deferred()],
    gets = [deferred(), deferred()];
  let post = 0,
    get = 0;
  api.mockImplementation(async (path, method = "GET") =>
    path.endsWith("/playlist")
      ? method === "POST"
        ? posts[post++].promise
        : gets[get++].promise
      : {},
  );
  const first = r.run(() => r.addQueue("one"));
  const second = r.run(() => r.addQueue("two"));
  expect(post).toBe(2);
  expect(r.queuePendingCount).toBe(2);
  posts[0].resolve({});
  await nextTick();
  await nextTick();
  posts[1].resolve({});
  await nextTick();
  await nextTick();
  expect(get).toBe(2);
  gets[1].resolve(rows(["one", "two"]));
  await second;
  expect(r.playlist).toEqual(rows(["one", "two"]));
  expect(r.busy).toBe(true);
  expect(r.queuePending("add", "one")).toBe(true);
  expect(r.queuePending("add", "two")).toBe(false);
  gets[0].resolve(rows(["one"]));
  await first;
  expect(r.playlist).toEqual(rows(["one", "two"]));
  expect(r.busy).toBe(false);
  expect(r.queuePendingCount).toBe(0);
});

it("a superseded refresh cannot clear loading or replace a newer refresh warning", async () => {
  const { runtime: r, api } = fixture();
  const first = deferred(),
    second = deferred();
  api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const old = r.refreshPlaylist();
  const current = r.refreshPlaylist();
  first.resolve(rows(["old"]));
  await old;
  expect(r.playlistLoading).toBe(true);
  expect(r.playlist).toEqual([]);
  second.reject(Error("latest read failed"));
  await expect(current).rejects.toThrow("latest read failed");
  expect(r.playlistError).toBe("latest read failed");
  expect(r.playlistLoaded).toBe(false);
});

it("a late failed read cannot replace a newer successful result or report a false failure", async () => {
  const { runtime: r, api } = fixture();
  const first = deferred(),
    second = deferred();
  api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const old = r.refreshPlaylist(),
    current = r.refreshPlaylist();
  second.resolve(rows(["latest"]));
  await current;
  first.reject(Error("stale failure"));
  await old;
  expect(r.playlist).toEqual(rows(["latest"]));
  expect(r.playlistError).toBe("");
});

it.each(["add", "remove"] as const)(
  "preserves a committed %s receipt when refresh fails; reload only repeats GET",
  async (kind) => {
    const { runtime: r, api } = fixture();
    const mutation = deferred(),
      refresh = deferred();
    r.playlist = rows(["previous"]);
    api.mockImplementation(async (path, method = "GET") =>
      path.includes("/playlist")
        ? method === "GET"
          ? refresh.promise
          : mutation.promise
        : {},
    );
    const action = r.run(() =>
      kind === "add" ? r.addQueue("film") : r.removeQueue("previous"),
    );
    expect(r.queueNotice).toBe("");
    mutation.resolve({});
    await nextTick();
    await nextTick();
    await vi.waitFor(() =>
      expect(r.queueNotice).toBe(
        kind === "add" ? "已加入当前房间待播" : "已从当前房间待播移除",
      ),
    );
    refresh.reject(Error("read temporarily unavailable"));
    await action;
    expect(r.error).toBe("");
    expect(r.playlist).toEqual(rows(["previous"]));
    expect(r.playlistError).toBe("read temporarily unavailable");
    const receipt = r.queueNotice;
    const panel = mountSetup(
      new URL(
        "../apps/web/src/features/rooms/QueueFeedback.vue",
        import.meta.url,
      ),
      {
        useRoomRuntime: () => r,
        Notice: {},
      },
    );
    disposals.push(panel.unmount);
    api.mockRejectedValueOnce(Error("still unavailable"));
    await panel.controls.reload();
    expect(r.playlistError).toBe("still unavailable");
    expect(r.queueNotice).toBe(receipt);
    api.mockImplementation(async (path, method = "GET") =>
      path.endsWith("/playlist") && method === "GET" ? rows(["fresh"]) : {},
    );
    await panel.controls.reload();
    expect(r.playlist).toEqual(rows(["fresh"]));
    expect(r.playlistError).toBe("");
    expect(r.queueNotice).toBe(receipt);
    expect(
      api.mock.calls.filter(([, method = "GET"]) => method !== "GET"),
    ).toHaveLength(1);
  },
);

it("an unsuccessful mutation gets no receipt and may be retried without a global action lock", async () => {
  const { runtime: r, api } = fixture();
  const failed = deferred(),
    unrelated = deferred();
  api.mockReturnValueOnce(failed.promise);
  const other = r.run(() => unrelated.promise);
  const first = r.run(() => r.addQueue("film"));
  expect(api).toHaveBeenCalledOnce();
  failed.reject(Error("queue denied"));
  await first;
  expect(r.error).toBe("queue denied");
  expect(r.queueNotice).toBe("");
  expect(r.queuePendingCount).toBe(0);
  expect(r.busy).toBe(true);
  await r.run(() => r.addQueue("film"));
  expect(r.queueNotice).toBe("已加入当前房间待播");
  expect(r.busy).toBe(true);
  unrelated.resolve({});
  await other;
  expect(r.busy).toBe(false);
});

it("deduplicates only an in-flight same-item add while independent adds can proceed", async () => {
  const { runtime: r, api } = fixture();
  const mutation = deferred();
  api.mockImplementation(async (_path, method = "GET") =>
    method === "POST" ? mutation.promise : [],
  );
  const first = r.addQueue("one"),
    repeat = r.addQueue("one"),
    independent = r.addQueue("two");
  expect(api.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(
    2,
  );
  expect(r.queuePendingCount).toBe(2);
  mutation.resolve({});
  await Promise.all([first, repeat, independent]);
  expect(r.queuePendingCount).toBe(0);
  await r.addQueue("one");
  expect(api.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(
    3,
  );
});

it("retries a failed initial playlist fetch in the same room without replacing its socket or playback state", async () => {
  const { runtime: r, api, sockets } = fixture();
  r.room = null;
  let reads = 0;
  api.mockImplementation(async (path) =>
    path.endsWith("/playlist")
      ? ++reads === 1
        ? Promise.reject(Error("initial read failed"))
        : rows(["existing"])
      : { self_permissions: [], members: [] },
  );
  await expect(r.enter(room)).rejects.toThrow("initial read failed");
  expect(r.room?.id).toBe(room.id);
  expect(r.playlistLoaded).toBe(false);
  r.state = {
    room_id: room.id,
    media_id: null,
    media_generation: 7,
    revision: 3,
  } as any;
  const before = r.state;
  await r.enter(room);
  expect(reads).toBe(2);
  expect(r.playlist).toEqual(rows(["existing"]));
  expect(r.playlistError).toBe("");
  expect(r.state).toBe(before);
  expect(sockets).toHaveLength(1);
  expect(sockets[0].close).not.toHaveBeenCalled();
  await r.enter(room);
  expect(reads).toBe(2);
});

it("same-room entry shares its pending initial read", async () => {
  const { runtime: r, api, sockets } = fixture();
  r.room = null;
  const pending = deferred();
  api.mockImplementation(async (path) =>
    path.endsWith("/playlist")
      ? pending.promise
      : { self_permissions: [], members: [] },
  );
  const first = r.enter(room);
  await nextTick();
  await nextTick();
  const second = r.enter(room);
  pending.resolve(rows(["existing"]));
  await Promise.all([first, second]);
  expect(
    api.mock.calls.filter(([path]) => path.endsWith("/playlist")),
  ).toHaveLength(1);
  expect(sockets).toHaveLength(1);
});

it("late queue reads and mutation receipts are fenced after leaving and re-entering the same room", async () => {
  const { runtime: r, api } = fixture();
  const read = deferred(),
    mutation = deferred();
  api.mockReturnValueOnce(read.promise).mockReturnValueOnce(mutation.promise);
  const oldRead = r.refreshPlaylist(),
    oldAdd = r.run(() => r.addQueue("old"));
  await r.leave();
  await r.enter(room);
  const current = deferred();
  const newAction = r.run(() => current.promise);
  const calls = api.mock.calls.length;
  read.resolve(rows(["stale"]));
  mutation.resolve({});
  await Promise.all([oldRead, oldAdd]);
  expect(api.mock.calls).toHaveLength(calls); // No old-room follow-up read.
  expect(r.playlist).toEqual([]);
  expect(r.queueNotice).toBe("");
  expect(r.error).toBe("");
  expect(r.busy).toBe(true);
  current.resolve({});
  await newAction;
  expect(r.busy).toBe(false);
});

it("changing rooms fences both stale success and failure without disturbing the new queue", async () => {
  const { runtime: r, api } = fixture();
  const read = deferred(),
    mutation = deferred();
  api.mockReturnValueOnce(read.promise).mockReturnValueOnce(mutation.promise);
  const oldRead = r.refreshPlaylist(),
    oldAdd = r.run(() => r.addQueue("old"));
  await r.enter({ ...room, id: "new-room" });
  r.playlist = rows(["new-room-film"]);
  read.reject(Error("stale read"));
  mutation.reject(Error("stale mutation"));
  await Promise.all([oldRead, oldAdd]);
  expect(r.room?.id).toBe("new-room");
  expect(r.playlist).toEqual(rows(["new-room-film"]));
  expect(r.error).toBe("");
  expect(r.playlistError).toBe("");
  expect(r.queueNotice).toBe("");
});

it("account changes fence results before the watcher runs and reset queue feedback", async () => {
  const { runtime: r, session, api } = fixture();
  const read = deferred(),
    mutation = deferred();
  api.mockReturnValueOnce(read.promise).mockReturnValueOnce(mutation.promise);
  const oldRead = r.refreshPlaylist(),
    oldAdd = r.run(() => r.addQueue("old"));
  session.clear();
  read.resolve(rows(["private-old-account"]));
  mutation.resolve({});
  await Promise.all([oldRead, oldAdd]);
  await nextTick();
  expect(r.room).toBeNull();
  expect(r.playlist).toEqual([]);
  expect(r.queueNotice).toBe("");
  expect(r.playlistError).toBe("");
  expect(r.queuePendingCount).toBe(0);
  expect(r.queueReceipt("add", "old")).toBe("");
  expect(r.busy).toBe(false);
  expect(
    api.mock.calls.filter(([path]) => path.endsWith("/playlist")),
  ).toHaveLength(2);
});

it("the actual private-library queue guard accepts a delegated queue permission and rejects revoked permission", async () => {
  const { runtime: r, session, api } = fixture();
  r.room = { ...room, owner_id: "another-owner" };
  r.state = {
    room_id: room.id,
    controller_user_id: "another-owner",
    media_id: null,
  } as any;
  api.mockResolvedValueOnce({ self_permissions: ["queue"], members: [] });
  await r.refreshPermissions();
  expect(r.owner).toBe(false);
  expect(r.can("queue")).toBe(true);
  const library = {
    id: "library",
    name: "Library",
    permissions: { browse: true, manage: true },
    sources: [],
    grants: [],
    room_shares: [],
    audit: [],
  };
  api.mockImplementation(async (path) =>
    path === "/libraries"
      ? { items: [library], enabled: true }
      : path.includes("/media?") || path.endsWith("/playlist")
        ? []
        : library,
  );
  const url = new URL(
    "../apps/web/src/features/private-library/PrivateLibrariesPage.vue",
    import.meta.url,
  );
  const page = mountSetup(url, {
    useSession: () => session,
    useRoomRuntime: () => r,
    useRoute: () => ({ query: {} }),
    privateLibraryApi,
    LibraryBrowser: {},
    SourceSettingsDialog: {},
    Notice: {},
    QueueFeedback: {},
    AppDialog: {},
    AppIcon: {},
  });
  disposals.push(page.unmount);
  const ast = parse(readFileSync(url, "utf8")).descriptor.template!.ast!;
  let disabled = "";
  function findQueueButton(node: any) {
    if (
      node.tag === "button" &&
      node.props?.some(
        (prop: any) =>
          prop.name === "on" && prop.exp?.content === "choose(item.id)",
      )
    )
      disabled = node.props.find(
        (prop: any) => prop.name === "bind" && prop.arg?.content === "disabled",
      ).exp.content;
    node.children?.forEach(findQueueButton);
  }
  findQueueButton(ast);
  expect(disabled).not.toBe("");
  const isDisabled = () =>
    new Function(
      "busy",
      "canQueue",
      "runtime",
      "item",
      `return (${disabled});`,
    )(page.controls.busy.value, page.controls.canQueue.value, r, {
      id: "film",
    });
  expect(page.controls.canQueue.value).toBe(true);
  expect(isDisabled()).toBe(false);
  await page.controls.choose("film");
  expect(
    api.mock.calls.filter(
      ([path, method]) => path.endsWith("/playlist") && method === "POST",
    ),
  ).toHaveLength(1);
  api.mockResolvedValueOnce({ self_permissions: [], members: [] });
  await r.refreshPermissions();
  expect(page.controls.canQueue.value).toBe(false);
  expect(isDisabled()).toBe(true);
  await page.controls.choose("denied-film");
  expect(
    api.mock.calls.filter(
      ([path, method]) => path.endsWith("/playlist") && method === "POST",
    ),
  ).toHaveLength(1);
});

it("inline receipts belong to their actual card even when other queue actions overlap", async () => {
  const { runtime: r, api } = fixture();
  const posts = { one: deferred(), two: deferred() };
  api.mockImplementation(async (path, method = "GET", body) => {
    if (path.endsWith("/playlist") && method === "POST")
      return posts[(body as { media_id: "one" | "two" }).media_id].promise;
    if (path.endsWith("/playlist")) throw Error("read unavailable");
    return {};
  });
  const panel = (mediaId: string) => {
    const p = mountSetup(
      new URL(
        "../apps/web/src/features/rooms/QueueFeedback.vue",
        import.meta.url,
      ),
      {
        useRoomRuntime: () => r,
        Notice: {},
      },
      { mediaId },
    );
    disposals.push(p.unmount);
    return p.controls;
  };
  const one = panel("one"),
    two = panel("two"),
    untouched = panel("untouched");
  const first = r.addQueue("one"),
    second = r.addQueue("two");
  expect(one.pending.value).toBe(true);
  expect(two.pending.value).toBe(true);
  expect(one.receipt.value).toBe("");
  expect(two.receipt.value).toBe("");
  posts.one.resolve({});
  await first;
  expect(one.receipt.value).toBe("已加入当前房间待播");
  expect(one.pending.value).toBe(false);
  expect(two.receipt.value).toBe("");
  expect(two.pending.value).toBe(true);
  expect(untouched.visible.value).toBe(false);
  posts.two.resolve({});
  await second;
  expect(one.receipt.value).toBe("已加入当前房间待播");
  expect(two.receipt.value).toBe("已加入当前房间待播");
  await one.reload();
  expect(r.playlistError).toBe("read unavailable");
  expect(one.receipt.value).toBe("已加入当前房间待播");
  expect(api.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(
    2,
  );
  await r.leave();
  expect(one.visible.value).toBe(false);
  expect(one.receipt.value).toBe("");
  expect(two.receipt.value).toBe("");
});

it("each library card places scoped queue feedback immediately before its primary controls", () => {
  const source = readFileSync(
    new URL(
      "../apps/web/src/features/library/LibraryPage.vue",
      import.meta.url,
    ),
    "utf8",
  );
  const ast = parse(source).descriptor.template!.ast!;
  let card: any;
  function findCard(node: any) {
    if (
      node.tag === "article" &&
      node.props?.some(
        (prop: any) =>
          prop.name === "bind" && prop.arg?.content === "data-media-id",
      )
    )
      card = node;
    node.children?.forEach(findCard);
  }
  findCard(ast);
  expect(card).toBeDefined();
  const children = card.children.filter((node: any) => node.type === 1);
  const feedbackIndex = children.findIndex(
    (node: any) => node.tag === "QueueFeedback",
  );
  expect(feedbackIndex).toBeGreaterThan(0);
  expect(
    children[feedbackIndex].props.some(
      (prop: any) =>
        prop.arg?.content === "media-id" && prop.exp?.content === "item.id",
    ),
  ).toBe(true);
  expect(
    children[feedbackIndex + 1].props.some(
      (prop: any) =>
        prop.name === "class" && prop.value?.content === "media-actions",
    ),
  ).toBe(true);
  expect(source).not.toContain("<QueueFeedback />");
});
