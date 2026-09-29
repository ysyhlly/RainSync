import { it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { useMediaCatalog } from "../apps/web/src/features/library/media-catalog.store";
const media = (overrides = {}) => ({
  id: "m",
  title: "original",
  original_title: "original",
  shared_title: null,
  shared_title_revision: "0",
  personal_title: null,
  personal_title_revision: "0",
  duration_ms: 1000,
  kind: "local",
  cover: {
    status: "missing" as const,
    revision: null,
    url: null,
    retry_after_ms: null,
  },
  ...overrides,
});
function setup() {
  setActivePinia(createPinia());
  const s = useSession();
  s.accept({ id: "alice", username: "alice", csrf: "x", admin: false });
  return { s, c: useMediaCatalog() };
}
it("late list cannot replace newer personal name and shared versions merge independently", () => {
  const { c } = setup();
  c.remember([media({ personal_title: "mine", personal_title_revision: "2" })]);
  c.remember([media({ shared_title: "shared", shared_title_revision: "3" })]);
  expect(c.records.m.title).toBe("mine");
  expect(c.records.m.shared_title).toBe("shared");
  c.remember([
    media({
      personal_title: null,
      personal_title_revision: "3",
      shared_title: "shared",
      shared_title_revision: "3",
    }),
  ]);
  expect(c.records.m.title).toBe("shared");
});
it("identity changes clear aliases synchronously and reject a late detail", async () => {
  const { s, c } = setup();
  let resolve!: (v: any) => void;
  s.api = vi.fn(() => new Promise((r) => (resolve = r))) as any;
  const pending = c.ensure("m");
  c.remember([
    media({ personal_title: "Alice private", personal_title_revision: "1" }),
  ]);
  s.accept({ id: "bob", username: "bob", csrf: "b", admin: false });
  expect(c.records.m).toBeUndefined();
  resolve(
    media({ personal_title: "Alice private", personal_title_revision: "1" }),
  );
  await expect(pending).rejects.toThrow();
  expect(c.records.m).toBeUndefined();
});
it("same media detail is deduplicated", async () => {
  const { s, c } = setup();
  let resolve!: (v: any) => void;
  s.api = vi.fn(() => new Promise((r) => (resolve = r))) as any;
  const a = c.ensure("m"),
    b = c.ensure("m");
  expect(s.api).toHaveBeenCalledTimes(1);
  resolve(media());
  await Promise.all([a, b]);
  expect(c.records.m.title).toBe("original");
});
it("old preview status cannot overwrite a later source generation detail", async () => {
  const { s, c } = setup();
  c.remember([media()]);
  const replies: ((v: any) => void)[] = [];
  s.api = vi.fn(() => new Promise((r) => replies.push(r))) as any;
  const old = c.refreshPreviewStatuses(["m"]),
    fresh = c.ensure("m", true);
  replies[1](
    media({
      cover: {
        status: "ready",
        revision: "new",
        url: "/new",
        retry_after_ms: null,
      },
    }),
  );
  await fresh;
  replies[0]({
    items: [
      {
        media_id: "m",
        cover: {
          status: "ready",
          revision: "old",
          url: "/old",
          retry_after_ms: null,
        },
      },
    ],
  });
  await old;
  expect(c.records.m.cover.revision).toBe("new");
});

it("rename returns its own revision even when a later read has reached the catalog", async () => {
  const { s, c } = setup();
  let reply!: (value: any) => void;
  s.api = vi.fn(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  ) as any;
  c.remember([media()]);
  const save = c.renamePersonal("m", "my draft", "0");
  c.remember([
    media({ personal_title: "later writer", personal_title_revision: "2" }),
  ]);
  reply(
    media({
      title: "my draft",
      personal_title: "my draft",
      personal_title_revision: "1",
    }),
  );
  const saved = await save;
  expect(saved.personal_title).toBe("my draft");
  expect(saved.personal_title_revision).toBe("1");
  expect(c.records.m.personal_title).toBe("later writer");
  expect(c.records.m.personal_title_revision).toBe("2");
});
