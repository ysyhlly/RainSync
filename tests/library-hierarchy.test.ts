import { afterEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { effectScope, nextTick, ref } from "vue";
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
