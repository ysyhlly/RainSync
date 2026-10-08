import { afterEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { useLibrary } from "../apps/web/src/features/library/library.store";
import { usePendingMedia } from "../apps/web/src/features/library/pending-media.store";
import { keyboardViewportOpen } from "../apps/web/src/shared/keyboard-viewport";
import type { Media } from "../apps/web/src/shared/api/types";
const rows = (prefix: string, start = 0, size = 25) =>
  Array.from(
    { length: size },
    (_, i) =>
      ({
        id: `${prefix}-${start + i}`,
        title: `${prefix} ${start + i}`,
        kind: "local",
      }) as Media,
  );
let pinia: ReturnType<typeof createPinia>;
function setup() {
  pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.accept({ id: "alice", username: "alice", csrf: "x", admin: false });
  return { session, library: useLibrary() };
}
afterEach(() => {
  if (pinia) disposePinia(pinia);
  vi.useRealTimers();
});

it("a failed B search preserves A's complete second page and its next cursor", async () => {
  const { session, library } = setup();
  const api = vi
    .fn()
    .mockResolvedValueOnce(rows("A"))
    .mockResolvedValueOnce(rows("A", 24))
    .mockRejectedValueOnce(Error("B failed"))
    .mockResolvedValueOnce(rows("A", 48, 3));
  session.api = api as any;
  await library.load(0, "A");
  await library.load(1);
  await library.load(0, "B");
  expect([library.query, library.page, library.hasMore]).toEqual([
    "A",
    1,
    true,
  ]);
  expect(library.items[0].id).toBe("A-24");
  expect(library.requestedQuery).toBe("B");
  expect(library.error).toBe("B failed");
  await library.load(2);
  const params = new URL(api.mock.calls[3][0], "http://fixture").searchParams;
  expect(params.get("search")).toBe("A");
  expect(params.get("after")).toBe("A-47");
  expect(library.page).toBe(2);
});

it("retrying a failed new search starts at page one and cannot reuse A's cursor", async () => {
  const { session, library } = setup();
  const api = vi
    .fn()
    .mockResolvedValueOnce(rows("A"))
    .mockResolvedValueOnce(rows("A", 24))
    .mockRejectedValueOnce(Error("B failed"))
    .mockResolvedValueOnce(rows("B"))
    .mockResolvedValueOnce(rows("B", 24, 2));
  session.api = api as any;
  await library.load(0, "A");
  await library.load(1);
  await library.load(7, "B");
  await library.retry();
  expect(api.mock.calls[3][0]).not.toContain("after=");
  expect([library.query, library.page]).toEqual(["B", 0]);
  await library.load(1);
  expect(api.mock.calls[4][0]).toContain("after=B-23");
  expect(library.items[0].id).toBe("B-24");
});

it("late responses and a previous account cannot replace the successful snapshot", async () => {
  const { session, library } = setup();
  const replies: ((value: Media[]) => void)[] = [];
  session.api = vi.fn(
    () => new Promise((resolve) => replies.push(resolve)),
  ) as any;
  const a = library.load(0, "A"),
    b = library.load(0, "B");
  replies[1](rows("B"));
  await b;
  replies[0](rows("A"));
  await a;
  expect(library.query).toBe("B");
  const c = library.load(0, "C");
  session.accept({ id: "bob", username: "bob", csrf: "b", admin: false });
  replies[2](rows("C"));
  await c;
  expect(library.items).toEqual([]);
  expect(library.loaded).toBe(false);
  expect(library.query).toBe("");
});

it("an unavailable cursor restarts the query instead of labelling first-page rows as page ten", async () => {
  const { session, library } = setup();
  session.api = vi.fn().mockResolvedValue(rows("A")) as any;
  await library.load(0, "A");
  await library.load(9);
  expect(library.page).toBe(0);
  expect(vi.mocked(session.api).mock.calls[1][0]).not.toContain("after=");
});

it("pending selections expire, are replaceable, and clear synchronously with identity", () => {
  vi.useFakeTimers();
  const { session } = setup(),
    pending = usePendingMedia();
  pending.select("A", "影片 A");
  pending.select("B", "影片 B");
  expect(pending.selection?.mediaId).toBe("B");
  session.accept({ id: "bob", username: "bob", csrf: "b", admin: false });
  expect(pending.selection).toBeNull();
  pending.select("C", "影片 C");
  vi.advanceTimersByTime(600000);
  expect(pending.selection).toBeNull();
  session.clear();
  pending.select("D", "影片 D");
  expect(pending.selection).toBeNull();
});

it("zoom cannot hide navigation as a keyboard, while a focused keyboard after zoom can", () => {
  expect(
    keyboardViewportOpen({
      layoutHeight: 800,
      viewportHeight: 500,
      scale: 1,
      editable: false,
    }),
  ).toBe(false);
  expect(
    keyboardViewportOpen({
      layoutHeight: 800,
      viewportHeight: 400,
      scale: 2,
      editable: true,
    }),
  ).toBe(false);
  expect(
    keyboardViewportOpen({
      layoutHeight: 800,
      viewportHeight: 230,
      scale: 2,
      editable: true,
    }),
  ).toBe(true);
  expect(
    keyboardViewportOpen({
      layoutHeight: 800,
      viewportHeight: 500,
      scale: 1,
      editable: true,
    }),
  ).toBe(true);
});
