import { describe, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";
import {
  createDefaultLayout,
  validateLayout,
  type LayoutBreakpoint,
  type LayoutDocument,
} from "../apps/web/src/features/room-layout/layout-model";
import {
  MAX_LAYOUT_STORAGE_BYTES,
  loadRoomLayout,
  roomLayoutStorageKey,
  saveRoomLayout,
  type LayoutStorage,
} from "../apps/web/src/features/room-layout/layout-storage";
import {
  MAX_LAYOUT_HISTORY,
  useRoomLayout,
} from "../apps/web/src/features/room-layout/layout-controller";

function memoryStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  } satisfies LayoutStorage;
  return { data, storage };
}

function fixture(initialBreakpoint: LayoutBreakpoint = "wide") {
  const userId = ref<string | null>("user-a");
  const breakpoint = ref<LayoutBreakpoint>(initialBreakpoint);
  const store = memoryStorage();
  const scope = effectScope();
  const controller = scope.run(() =>
    useRoomLayout({
      userId,
      breakpoint,
      storage: store.storage,
    }),
  )!;
  return { ...store, userId, breakpoint, controller, stop: () => scope.stop() };
}

function withoutChat(breakpoint: LayoutBreakpoint = "wide"): LayoutDocument {
  const document = createDefaultLayout(breakpoint);
  document.items = document.items.filter((item) => item.type !== "chat");
  return document;
}

const key = (user = "user-a", breakpoint: LayoutBreakpoint = "wide") =>
  roomLayoutStorageKey(user, breakpoint)!;

// These tests call the real model, geometry, Vue refs and persistence functions.
describe("room layout storage", () => {
  it("isolates account and viewport profiles, with no anonymous persistent key", () => {
    expect(key("user:a")).not.toBe(key("user%3Aa"));
    expect(key("user-a", "wide")).not.toBe(key("user-a", "narrow"));
    expect(roomLayoutStorageKey(null, "wide")).toBeNull();
    expect(roomLayoutStorageKey("", "wide")).toBeNull();
  });

  it("round-trips only versioned geometry, without disturbing unrelated data", () => {
    const { data, storage } = memoryStorage();
    data.set("unrelated-room-data", "keep me");
    const document = withoutChat();
    expect(saveRoomLayout("user-a", document, storage)).toEqual({
      ok: true,
      persisted: true,
    });
    expect(loadRoomLayout("user-a", "wide", storage)).toEqual({
      layout: document,
      status: "saved",
      error: null,
    });
    const saved = JSON.parse(data.get(key())!);
    expect(Object.keys(saved).sort()).toEqual([
      "breakpoint",
      "items",
      "version",
    ]);
    for (const item of saved.items) {
      expect(Object.keys(item).sort()).toEqual([
        "h",
        "id",
        "type",
        "w",
        "x",
        "y",
      ]);
    }
    expect(data.get("unrelated-room-data")).toBe("keep me");
  });

  it("never serializes room contents, tokens or media accidentally attached to geometry", () => {
    const { data, storage } = memoryStorage();
    const document = Object.assign(createDefaultLayout("wide"), {
      sessionToken: "not-for-storage",
      messages: ["private chat"],
    });
    Object.assign(document.items[0], { mediaUrl: "private-media-address" });
    expect(saveRoomLayout("user-a", document, storage).ok).toBe(true);
    const raw = data.get(key()) ?? "";
    expect(raw).not.toContain("not-for-storage");
    expect(raw).not.toContain("private chat");
    expect(raw).not.toContain("private-media-address");
  });

  it.each([
    ["bad JSON", "{oops"],
    ["null", "null"],
    ["non-object", "[]"],
    ["wrong breakpoint", JSON.stringify(createDefaultLayout("narrow"))],
    [
      "missing player",
      JSON.stringify({ version: 1, breakpoint: "wide", items: [] }),
    ],
    [
      "out-of-range geometry",
      JSON.stringify({
        ...createDefaultLayout("wide"),
        items: createDefaultLayout("wide").items.map((item) => ({
          ...item,
          x: -1,
        })),
      }),
    ],
  ])(
    "uses a valid default for %s and leaves corrupt bytes untouched",
    (_, raw) => {
      const { data, storage } = memoryStorage();
      data.set(key(), raw);
      const loaded = loadRoomLayout("user-a", "wide", storage);
      expect(loaded.status).toBe("corrupt");
      expect(loaded.error).toBeTruthy();
      expect(loaded.layout).toEqual(createDefaultLayout("wide"));
      expect(validateLayout(loaded.layout).valid).toBe(true);
      expect(data.get(key())).toBe(raw);
      expect(storage.setItem).not.toHaveBeenCalled();
    },
  );

  it("rejects oversized bytes before parsing and accounts for UTF-8 size", () => {
    const { data, storage } = memoryStorage();
    for (const raw of [
      " ".repeat(MAX_LAYOUT_STORAGE_BYTES + 1),
      "界".repeat(6000),
    ]) {
      data.set(key(), raw);
      const loaded = loadRoomLayout("user-a", "wide", storage);
      expect(loaded.status).toBe("corrupt");
      expect(loaded.error).toContain("大小限制");
      expect(data.get(key())).toBe(raw);
    }
  });

  it("preserves unknown versions and refuses to downgrade without an explicit reset", () => {
    const { data, storage } = memoryStorage();
    const futureVersion = JSON.stringify({
      version: 2,
      breakpoint: "wide",
      items: [],
    });
    data.set(key(), futureVersion);
    expect(loadRoomLayout("user-a", "wide", storage).status).toBe(
      "unsupported-version",
    );
    expect(
      saveRoomLayout("user-a", createDefaultLayout("wide"), storage).ok,
    ).toBe(false);
    expect(data.get(key())).toBe(futureVersion);
    expect(
      saveRoomLayout("user-a", createDefaultLayout("wide"), storage, {
        replaceUnsupportedVersion: true,
      }).ok,
    ).toBe(true);
    expect(JSON.parse(data.get(key())!).version).toBe(1);
  });

  it("handles denied reads and writes without throwing or deleting data", () => {
    const storage: LayoutStorage = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
    };
    expect(loadRoomLayout("user-a", "wide", storage).status).toBe(
      "unavailable",
    );
    expect(
      saveRoomLayout("user-a", createDefaultLayout("wide"), storage).ok,
    ).toBe(false);
    expect(loadRoomLayout("user-a", "wide", null).status).toBe("unavailable");
    expect(saveRoomLayout("user-a", createDefaultLayout("wide"), null).ok).toBe(
      false,
    );
  });

  it("keeps anonymous layout edits in memory without touching persistent storage", () => {
    const { storage } = memoryStorage();
    expect(loadRoomLayout(null, "wide", storage).status).toBe("memory-only");
    expect(saveRoomLayout(null, withoutChat(), storage)).toEqual({
      ok: true,
      persisted: false,
    });
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("rejects invalid saves atomically", () => {
    const { data, storage } = memoryStorage();
    const original = JSON.stringify(createDefaultLayout("wide"));
    data.set(key(), original);
    const invalid = createDefaultLayout("wide");
    invalid.items[0].w = Number.NaN;
    expect(saveRoomLayout("user-a", invalid, storage).ok).toBe(false);
    expect(data.get(key())).toBe(original);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

describe("room layout controller", () => {
  it("requires edit mode and makes cancel a complete rollback without any write", () => {
    const f = fixture();
    const original = f.controller.committed.value;
    expect(f.controller.remove("chat")).toBe(false);
    expect(f.controller.begin()).toBe(true);
    expect(f.controller.begin()).toBe(false);
    expect(f.controller.remove("chat")).toBe(true);
    expect(f.controller.dirty.value).toBe(true);
    expect(f.controller.committed.value).toBe(original);
    expect(
      f.controller.layout.value.items.some((item) => item.id === "chat"),
    ).toBe(false);
    expect(f.controller.cancel()).toBe(true);
    expect(f.controller.layout.value).toBe(original);
    expect(f.controller.draft.value).toBeNull();
    expect(f.controller.editing.value).toBe(false);
    expect(f.controller.canUndo.value).toBe(false);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    f.stop();
  });

  it("commits the whole transaction once and a new controller restores it", () => {
    const f = fixture();
    f.controller.begin();
    f.controller.remove("chat");
    f.controller.remove("members");
    const draft = f.controller.layout.value;
    expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.controller.commit()).toBe(true);
    expect(f.controller.committed.value).toEqual(draft);
    expect(f.controller.editing.value).toBe(false);
    expect(f.storage.setItem).toHaveBeenCalledTimes(1);
    const restored = useRoomLayout({
      userId: "user-a",
      breakpoint: "wide",
      storage: f.storage,
    });
    expect(restored.layout.value).toEqual(draft);
    restored.dispose();
    f.stop();
  });

  it("keeps read-only geometry snapshots safe from accidental caller mutation", () => {
    const f = fixture();
    expect(Object.isFrozen(f.controller.layout.value)).toBe(true);
    expect(Object.isFrozen(f.controller.layout.value.items)).toBe(true);
    expect(Object.isFrozen(f.controller.layout.value.items[0])).toBe(true);
    expect(() => {
      f.controller.layout.value.items[0].x = 100;
    }).toThrow();
    expect(validateLayout(f.controller.layout.value).valid).toBe(true);
    f.stop();
  });

  it("supports undo, redo, add, hide, and drops the redo branch after another edit", () => {
    const f = fixture();
    f.controller.begin();
    expect(f.controller.remove("chat")).toBe(true);
    const hidden = f.controller.layout.value;
    expect(f.controller.undo()).toBe(true);
    expect(
      f.controller.layout.value.items.some((item) => item.id === "chat"),
    ).toBe(true);
    expect(f.controller.canRedo.value).toBe(true);
    expect(f.controller.redo()).toBe(true);
    expect(f.controller.layout.value).toEqual(hidden);
    expect(f.controller.add("chat")).toBe(true);
    expect(f.controller.undo()).toBe(true);
    expect(f.controller.remove("members")).toBe(true);
    expect(f.controller.canRedo.value).toBe(false);
    expect(f.controller.redo()).toBe(false);
    expect(validateLayout(f.controller.layout.value).valid).toBe(true);
    f.stop();
  });

  it("never hides the essential player or publishes invalid geometry", () => {
    const f = fixture();
    f.controller.begin();
    const initial = f.controller.layout.value;
    expect(f.controller.remove("player")).toBe(false);
    expect(f.controller.move("player", 18, 0)).toBe(false);
    expect(f.controller.resize("player", 24, 54)).toBe(false);
    expect(f.controller.move("unknown", 0, 0)).toBe(false);
    expect(f.controller.layout.value).toBe(initial);
    expect(f.controller.canUndo.value).toBe(false);
    expect(f.controller.error.value).toBeTruthy();
    expect(f.controller.move("queue", 0, 100)).toBe(true);
    expect(f.controller.error.value).toBeNull();
    const queue = f.controller.layout.value.items.find(
      (item) => item.id === "queue",
    )!;
    expect(f.controller.resize("queue", queue.w - 1, queue.h)).toBe(true);
    expect(validateLayout(f.controller.layout.value).valid).toBe(true);
    f.stop();
  });

  it("bounds undo history and can undo every retained step", () => {
    const f = fixture();
    f.controller.begin();
    for (let i = 0; i < MAX_LAYOUT_HISTORY + 20; i++) {
      expect(f.controller.move("chat", 18, 100 + i)).toBe(true);
    }
    let undone = 0;
    while (f.controller.undo()) undone++;
    expect(undone).toBe(MAX_LAYOUT_HISTORY);
    expect(f.controller.canUndo.value).toBe(false);
    expect(validateLayout(f.controller.layout.value).valid).toBe(true);
    f.stop();
  });

  it("reset is an undoable draft edit and writes no unrelated data", () => {
    const f = fixture();
    f.data.set("chat-messages", "unchanged");
    f.controller.begin();
    f.controller.remove("chat");
    f.controller.commit();
    const custom = f.controller.committed.value;
    f.storage.setItem.mockClear();
    f.controller.begin();
    expect(f.controller.reset()).toBe(true);
    expect(f.controller.layout.value).toEqual(createDefaultLayout("wide"));
    expect(f.controller.committed.value).toBe(custom);
    expect(f.controller.undo()).toBe(true);
    expect(f.controller.layout.value).toEqual(custom);
    expect(f.controller.redo()).toBe(true);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.controller.commit()).toBe(true);
    expect(f.controller.committed.value).toEqual(createDefaultLayout("wide"));
    expect(f.data.get("chat-messages")).toBe("unchanged");
    f.stop();
  });

  it("preserves the full draft, history and committed layout on quota failure, then retries", () => {
    const f = fixture();
    f.controller.begin();
    f.controller.remove("chat");
    const original = f.controller.committed.value;
    const edited = f.controller.draft.value;
    f.storage.setItem.mockImplementationOnce(() => {
      throw new Error("QuotaExceededError");
    });
    expect(f.controller.commit()).toBe(false);
    expect(f.controller.error.value).toContain("保存失败");
    expect(f.controller.editing.value).toBe(true);
    expect(f.controller.draft.value).toBe(edited);
    expect(f.controller.committed.value).toBe(original);
    expect(f.controller.canUndo.value).toBe(true);
    expect(f.data.has(key())).toBe(false);
    expect(f.controller.remove("members")).toBe(true);
    expect(f.controller.error.value).toContain("保存失败");
    expect(f.controller.commit()).toBe(true);
    expect(f.controller.editing.value).toBe(false);
    expect(f.controller.error.value).toBeNull();
    expect(
      f.controller.layout.value.items.some((item) => item.id === "chat"),
    ).toBe(false);
    f.stop();
  });

  it("can cancel after save failure without replacing the committed layout", () => {
    const f = fixture();
    const original = f.controller.layout.value;
    f.controller.begin();
    f.controller.remove("chat");
    f.storage.setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    f.controller.commit();
    expect(f.controller.cancel()).toBe(true);
    expect(f.controller.layout.value).toBe(original);
    expect(f.controller.error.value).toBeNull();
    expect(f.data.size).toBe(0);
    f.stop();
  });

  it("synchronously clears drafts and history when accounts change, without cross-account writes", () => {
    const f = fixture();
    f.data.set(key("user-b"), JSON.stringify(withoutChat()));
    f.controller.begin();
    f.controller.remove("members");
    f.userId.value = "user-b";
    expect(f.controller.editing.value).toBe(false);
    expect(f.controller.canUndo.value).toBe(false);
    expect(f.controller.layout.value).toEqual(withoutChat());
    expect(f.controller.commit()).toBe(false);
    expect(f.data.has(key("user-a"))).toBe(false);
    f.userId.value = "user-a";
    expect(f.controller.layout.value).toEqual(createDefaultLayout("wide"));
    expect(f.storage.setItem).not.toHaveBeenCalled();
    f.stop();
  });

  it("never falls back to the previous user's layout if the new account storage read fails", () => {
    const f = fixture();
    f.controller.begin();
    f.controller.remove("chat");
    f.controller.commit();
    f.storage.getItem.mockImplementation(() => {
      throw new Error("SecurityError");
    });
    f.userId.value = "user-b";
    expect(f.controller.layout.value).toEqual(createDefaultLayout("wide"));
    expect(f.controller.error.value).toBeTruthy();
    expect(f.controller.editing.value).toBe(false);
    f.stop();
  });

  it("maintains independent wide/narrow saved profiles and clears pending viewport edits", () => {
    const f = fixture();
    f.controller.begin();
    f.controller.remove("chat");
    f.controller.commit();
    const wide = f.controller.committed.value;
    f.breakpoint.value = "narrow";
    expect(f.controller.layout.value).toEqual(createDefaultLayout("narrow"));
    f.controller.begin();
    f.controller.remove("queue");
    f.controller.commit();
    const narrow = f.controller.committed.value;
    f.controller.begin();
    f.controller.remove("members");
    f.breakpoint.value = "wide";
    expect(f.controller.editing.value).toBe(false);
    expect(f.controller.layout.value).toEqual(wide);
    f.breakpoint.value = "narrow";
    expect(f.controller.layout.value).toEqual(narrow);
    expect(f.data.has(key("user-a", "wide"))).toBe(true);
    expect(f.data.has(key("user-a", "narrow"))).toBe(true);
    f.stop();
  });

  it("makes narrow movement and resize real undoable geometry edits", () => {
    const f = fixture("narrow");
    f.controller.begin();
    const initial = f.controller.layout.value;
    const chat = initial.items.find((item) => item.id === "chat")!;
    expect(f.controller.move("chat", 0, chat.y - 1)).toBe(true);
    expect(validateLayout(f.controller.layout.value).valid).toBe(true);
    expect(f.controller.undo()).toBe(true);
    expect(f.controller.layout.value).toEqual(initial);
    expect(f.controller.resize("chat", 1, chat.h + 2)).toBe(true);
    expect(validateLayout(f.controller.layout.value).valid).toBe(true);
    f.stop();
  });

  it("discards signed-in layout on logout and keeps anonymous commits memory-only", () => {
    const f = fixture();
    f.controller.begin();
    f.controller.remove("chat");
    f.controller.commit();
    f.userId.value = null;
    expect(f.controller.layout.value).toEqual(createDefaultLayout("wide"));
    f.storage.setItem.mockClear();
    f.controller.begin();
    f.controller.remove("members");
    expect(f.controller.commit()).toBe(true);
    expect(f.controller.status.value).toContain("本次访问");
    expect(f.storage.setItem).not.toHaveBeenCalled();
    f.userId.value = "user-b";
    expect(f.controller.layout.value).toEqual(createDefaultLayout("wide"));
    f.stop();
  });

  it("detects newer stored versions at save time and allows only explicit reset to replace them", () => {
    const f = fixture();
    f.controller.begin();
    f.controller.remove("chat");
    const unknown = JSON.stringify({
      version: 20,
      breakpoint: "wide",
      items: [],
    });
    f.data.set(key(), unknown);
    expect(f.controller.commit()).toBe(false);
    expect(f.data.get(key())).toBe(unknown);
    expect(f.controller.reset()).toBe(true);
    expect(f.controller.commit()).toBe(true);
    expect(JSON.parse(f.data.get(key())!)).toEqual(createDefaultLayout("wide"));
    f.stop();
  });

  it("undoing reset also revokes the pending unknown-version replacement", () => {
    const f = fixture();
    f.controller.begin();
    f.controller.remove("chat");
    f.controller.reset();
    expect(f.controller.undo()).toBe(true);
    const unknown = JSON.stringify({
      version: 20,
      breakpoint: "wide",
      items: [],
    });
    f.data.set(key(), unknown);
    expect(f.controller.commit()).toBe(false);
    expect(f.data.get(key())).toBe(unknown);
    f.stop();
  });

  it("completes an unchanged edit without writing and stops watching on disposal", () => {
    const f = fixture();
    f.controller.begin();
    expect(f.controller.commit()).toBe(true);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    const final = f.controller.layout.value;
    f.stop();
    f.userId.value = "user-b";
    expect(f.controller.layout.value).toBe(final);
    expect(f.controller.begin()).toBe(false);
    expect(f.controller.commit()).toBe(false);
  });
});
