import { afterEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { effectScope, nextTick, ref } from "vue";
import { RequestFailure } from "../apps/web/src/errors";
import { useSession } from "../apps/web/src/features/auth/session.store";
import {
  createLibraryState,
  useLibrary,
} from "../apps/web/src/features/library/library.store";
import type { BrowsePage } from "../apps/web/src/features/library/media.api";
let pinia: ReturnType<typeof createPinia>;
const scopes: ReturnType<typeof effectScope>[] = [];
const result = (
  node: string | null,
  next: string | null = null,
): BrowsePage => ({
  node,
  next_cursor: next,
  total_media: 150,
  breadcrumbs: [
    { id: null, name: "全部片源" },
    ...(node ? [{ id: node, name: node }] : []),
  ],
  entries: [
    {
      type: "folder",
      id: `${node ?? "root"}-child`,
      name: "第二层",
      media_count: 150,
    },
  ],
});
function setup() {
  pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.accept({ id: "alice", username: "alice", csrf: "x", admin: false });
  return { session, library: useLibrary() };
}
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  if (pinia) disposePinia(pinia);
});

it("uses the paginated backend hierarchy rather than grouping the media search page", async () => {
  const { session, library } = setup();
  session.api = vi
    .fn()
    .mockResolvedValueOnce(result(null, "root-cursor"))
    .mockResolvedValueOnce(result("source", "source-cursor"))
    .mockResolvedValueOnce(result("source")) as any;
  await library.browse(null);
  expect(library.totalMedia).toBe(150);
  expect(library.folders).toHaveLength(1);
  expect(library.items).toEqual([]);
  expect(vi.mocked(session.api).mock.calls[0][0]).toBe(
    "/media/browse?limit=24",
  );
  await library.browse("source");
  expect(vi.mocked(session.api).mock.calls[1][0]).not.toContain("after=");
  await library.loadPage(1);
  expect(vi.mocked(session.api).mock.calls[2][0]).toContain(
    "after=source-cursor",
  );
  expect(library.node).toBe("source");
  expect(library.page).toBe(1);
});

it("a failed directory transition preserves breadcrumbs and its complete page cursor snapshot", async () => {
  const { session, library } = setup();
  session.api = vi
    .fn()
    .mockResolvedValueOnce(result("A", "A-next"))
    .mockRejectedValueOnce(Error("B unavailable"))
    .mockResolvedValueOnce(result("A")) as any;
  await library.browse("A");
  await library.browse("B");
  expect(library.node).toBe("A");
  expect(library.breadcrumbs.at(-1)?.name).toBe("A");
  expect(library.requestedNode).toBe("B");
  await library.loadPage(1);
  expect(vi.mocked(session.api).mock.calls[2][0]).toContain(
    "node=A&after=A-next",
  );
});

it("retries a failed directory from its own first page and rejects unavailable cursors", async () => {
  const { session, library } = setup();
  session.api = vi
    .fn()
    .mockResolvedValueOnce(result("A", "A-next"))
    .mockRejectedValueOnce(Error("B failed"))
    .mockResolvedValueOnce(result("B"))
    .mockResolvedValueOnce(result("B")) as any;
  await library.browse("A");
  await library.browse("B", 9);
  await library.retry();
  expect(vi.mocked(session.api).mock.calls[2][0]).toContain("node=B");
  expect(vi.mocked(session.api).mock.calls[2][0]).not.toContain("after=");
  await library.loadPage(9);
  expect(library.page).toBe(0);
});

it("global title search crosses folders, and clearing it can return to the prior node", async () => {
  const { session, library } = setup();
  session.api = vi
    .fn()
    .mockResolvedValueOnce(result("deep-folder"))
    .mockResolvedValueOnce([
      { id: "elsewhere", title: "跨目录影片", kind: "local" },
    ])
    .mockResolvedValueOnce(result("deep-folder")) as any;
  await library.browse("deep-folder");
  await library.load(0, "影片");
  expect(library.mode).toBe("flat");
  expect(library.folders).toEqual([]);
  expect(vi.mocked(session.api).mock.calls[1][0]).toMatch(
    /^\/media\?limit=25&search=/,
  );
  expect(vi.mocked(session.api).mock.calls[1][0]).not.toContain("node=");
  await library.browse();
  expect(library.node).toBe("deep-folder");
});

it("late navigation, late search and a prior account cannot overwrite newer context", async () => {
  const { session, library } = setup();
  const replies: ((value: unknown) => void)[] = [];
  session.api = vi.fn(
    () => new Promise((resolve) => replies.push(resolve)),
  ) as any;
  const a = library.browse("A"),
    b = library.browse("B");
  replies[1](result("B"));
  await b;
  replies[0](result("A"));
  await a;
  expect(library.node).toBe("B");
  const search = library.load(0, "old"),
    c = library.browse("C");
  replies[3](result("C"));
  await c;
  replies[2]([{ id: "old", title: "old" }]);
  await search;
  expect(library.node).toBe("C");
  expect(library.mode).toBe("browse");
  const d = library.browse("D");
  session.accept({ id: "bob", username: "bob", csrf: "b", admin: false });
  replies[4](result("D"));
  await d;
  expect(library.folders).toEqual([]);
  expect(library.node).toBeNull();
  expect(library.loaded).toBe(false);
});

it("private-library changes synchronously clear the scope and fence old replies", async () => {
  const { session } = setup(),
    scope = effectScope();
  scopes.push(scope);
  const id = ref("private-A");
  const browser = scope.run(() => createLibraryState(() => id.value))!;
  const replies: ((value: unknown) => void)[] = [];
  session.api = vi.fn(
    () => new Promise((resolve) => replies.push(resolve)),
  ) as any;
  const old = browser.browse();
  id.value = "private-B";
  await nextTick();
  replies[0](result("A"));
  await old;
  expect(browser.loaded.value).toBe(false);
  const current = browser.browse();
  replies[1](result("B"));
  await current;
  expect(vi.mocked(session.api).mock.calls[0][0]).toContain(
    "library_id=private-A",
  );
  expect(vi.mocked(session.api).mock.calls[1][0]).toContain(
    "library_id=private-B",
  );
  expect(browser.node.value).toBe("B");
});

const unavailable = (code: string) =>
  new RequestFailure({
    error: { code, message: "目录已不可用" },
  });

it("removes a revoked current directory immediately and recovers from the accessible root", async () => {
  const { session, library } = setup();
  let rootReply!: (value: BrowsePage) => void;
  session.api = vi
    .fn()
    .mockResolvedValueOnce({
      ...result("private-folder", "old-cursor"),
      entries: [
        {
          type: "media",
          media: { id: "private-film", title: "Private film", kind: "local" },
        },
      ],
    })
    .mockRejectedValueOnce(unavailable("MEDIA_NOT_FOUND"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          rootReply = resolve;
        }),
    ) as any;
  await library.browse("private-folder");
  const refresh = library.refresh();
  await vi.waitFor(() => expect(session.api).toHaveBeenCalledTimes(3));
  expect(library.items).toEqual([]);
  expect(library.folders).toEqual([]);
  expect(library.breadcrumbs).toEqual([{ id: null, name: "全部片源" }]);
  expect([
    library.node,
    library.totalMedia,
    library.page,
    library.hasMore,
  ]).toEqual([null, 0, 0, false]);
  expect(library.busy).toBe(true);
  expect(vi.mocked(session.api).mock.calls[2][0]).toBe(
    "/media/browse?limit=24",
  );
  rootReply({ ...result(null), total_media: 0, entries: [] });
  await refresh;
  expect([
    library.node,
    library.totalMedia,
    library.loaded,
    library.error,
    library.busy,
  ]).toEqual([null, 0, true, "", false]);
});

it("a missing different directory does not invalidate the successful current snapshot", async () => {
  const { session, library } = setup();
  session.api = vi
    .fn()
    .mockResolvedValueOnce(result("A", "A-next"))
    .mockRejectedValueOnce(unavailable("MEDIA_NOT_FOUND"))
    .mockResolvedValueOnce(result("A")) as any;
  await library.browse("A");
  await library.browse("missing-B");
  expect(library.node).toBe("A");
  expect(library.folders).toHaveLength(1);
  expect(library.requestedNode).toBe("missing-B");
  await library.loadPage(1);
  expect(vi.mocked(session.api).mock.calls[2][0]).toContain(
    "node=A&after=A-next",
  );
});

it("a denied private library clears its whole snapshot and retries only that private root", async () => {
  const { session } = setup(),
    scope = effectScope();
  scopes.push(scope);
  const browser = scope.run(() => createLibraryState(() => "private-A"))!;
  session.api = vi
    .fn()
    .mockResolvedValueOnce(result("private-folder", "private-next"))
    .mockRejectedValueOnce(unavailable("LIBRARY_NOT_FOUND"))
    .mockResolvedValueOnce({
      ...result(null),
      entries: [],
      total_media: 0,
    }) as any;
  await browser.browse("private-folder");
  await browser.browse("another-folder");
  expect(browser.items.value).toEqual([]);
  expect(browser.folders.value).toEqual([]);
  expect(browser.breadcrumbs.value).toEqual([{ id: null, name: "全部片源" }]);
  expect([
    browser.node.value,
    browser.totalMedia.value,
    browser.loaded.value,
    browser.busy.value,
  ]).toEqual([null, 0, false, false]);
  expect(browser.error.value).toBe("目录已不可用");
  await browser.retry();
  expect(vi.mocked(session.api).mock.calls[2][0]).toBe(
    "/media/browse?limit=24&library_id=private-A",
  );
});

it("failed root recovery never restores a revoked snapshot and retry remains at root", async () => {
  const { session, library } = setup();
  session.api = vi
    .fn()
    .mockResolvedValueOnce(result("deleted-folder", "old-next"))
    .mockRejectedValueOnce(unavailable("MEDIA_NOT_FOUND"))
    .mockRejectedValueOnce(Error("temporary outage"))
    .mockResolvedValueOnce(result(null)) as any;
  await library.browse("deleted-folder");
  await library.refresh();
  expect(library.node).toBeNull();
  expect(library.folders).toEqual([]);
  expect(library.loaded).toBe(false);
  expect(library.error).toBe("temporary outage");
  await library.retry();
  expect(vi.mocked(session.api).mock.calls[3][0]).toBe(
    "/media/browse?limit=24",
  );
  expect(library.node).toBeNull();
});

it("a late denial for the old directory cannot clear a newer successful navigation", async () => {
  const { session, library } = setup();
  let rejectOld!: (error: Error) => void;
  session.api = vi
    .fn()
    .mockResolvedValueOnce(result("old"))
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOld = reject;
        }),
    )
    .mockResolvedValueOnce(result("new")) as any;
  await library.browse("old");
  const old = library.refresh();
  await library.browse("new");
  rejectOld(unavailable("MEDIA_NOT_FOUND"));
  await old;
  expect([library.node, library.error, library.loaded]).toEqual([
    "new",
    "",
    true,
  ]);
  expect(library.folders).toHaveLength(1);
  expect(session.api).toHaveBeenCalledTimes(3);
});

it("a transient current-directory failure preserves cards, counts, and cursor history", async () => {
  const { session, library } = setup();
  session.api = vi
    .fn()
    .mockResolvedValueOnce(result("A", "A-next"))
    .mockRejectedValueOnce(unavailable("UNAVAILABLE"))
    .mockResolvedValueOnce(result("A")) as any;
  await library.browse("A");
  await library.refresh();
  expect([
    library.node,
    library.totalMedia,
    library.loaded,
    library.hasMore,
  ]).toEqual(["A", 150, true, true]);
  expect(library.folders).toHaveLength(1);
  await library.loadPage(1);
  expect(vi.mocked(session.api).mock.calls[2][0]).toContain(
    "node=A&after=A-next",
  );
});

it("a missing private directory recovers inside its library rather than the global catalog", async () => {
  const { session } = setup(),
    scope = effectScope();
  scopes.push(scope);
  const browser = scope.run(() => createLibraryState(() => "private-A"))!;
  session.api = vi
    .fn()
    .mockResolvedValueOnce(result("folder", "private-next"))
    .mockRejectedValueOnce(unavailable("MEDIA_NOT_FOUND"))
    .mockResolvedValueOnce({
      ...result(null),
      entries: [],
      total_media: 0,
    }) as any;
  await browser.browse("folder");
  await browser.refresh();
  expect(vi.mocked(session.api).mock.calls[2][0]).toBe(
    "/media/browse?limit=24&library_id=private-A",
  );
  expect([
    browser.node.value,
    browser.totalMedia.value,
    browser.loaded.value,
  ]).toEqual([null, 0, true]);
});

it("root recovery is fenced when a newer account replaces the revoked snapshot", async () => {
  const { session, library } = setup();
  let rootReply!: (value: BrowsePage) => void;
  session.api = vi
    .fn()
    .mockResolvedValueOnce(result("folder"))
    .mockRejectedValueOnce(unavailable("MEDIA_NOT_FOUND"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          rootReply = resolve;
        }),
    ) as any;
  await library.browse("folder");
  const recovery = library.refresh();
  await vi.waitFor(() => expect(session.api).toHaveBeenCalledTimes(3));
  session.accept({ id: "bob", username: "bob", csrf: "b", admin: false });
  rootReply(result(null, "old-account-cursor"));
  await recovery;
  expect(library.items).toEqual([]);
  expect(library.folders).toEqual([]);
  expect([
    library.loaded,
    library.busy,
    library.hasMore,
    library.error,
  ]).toEqual([false, false, false, ""]);
});
