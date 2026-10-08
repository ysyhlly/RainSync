import { mountSetup } from "./helpers/mount-setup";
import * as Vue from "vue";
import { expect, it, vi } from "vitest";
import * as imports from "../apps/web/src/features/rooms/platform-import";
import { roomsApi } from "../apps/web/src/features/rooms/rooms.api";

const room = "00000000-0000-0000-0000-000000000001";
const first = {
  key: "a".repeat(64),
  provider: "bilibili",
  url: "https://www.bilibili.com/video/BV1xx411c7mD",
  part: 1,
  title: "First item",
};
const second = {
  ...first,
  key: "b".repeat(64),
  url: `${first.url}?p=2`,
  part: 2,
  title: "Second item",
};
const page = (items = [first], next: string | null = "original_cursor") => ({
  items,
  failures: [],
  truncated: next !== null,
  limit: 20,
  next,
  omitted: 2,
});
const failedPage = (retryable: boolean) => ({
  items: [],
  failures: [
    {
      index: 0,
      error: {
        code: retryable
          ? "platform_import_unavailable"
          : "platform_collection_changed",
        retryable,
      },
    },
  ],
  truncated: false,
  limit: 20,
  next: null,
  omitted: 0,
});

/** Exercise the real SFC setup and watches with an in-memory Vue renderer.
 * The API and stores are local fixtures; no provider or account is contacted. */
function mountImport(api: ReturnType<typeof vi.fn>) {
  const runtime = Vue.reactive({
    roomActive: true,
    connected: true,
    room: { id: room },
    can: () => true,
  });
  const session = Vue.reactive({ epoch: 1, api });
  const catalog = { rememberRoom: vi.fn() };
  const dependencies = {
    useRoomRuntime: () => runtime,
    useSession: () => session,
    usePlatformAccount: () => ({}),
    useMediaCatalog: () => catalog,
    roomsApi,
    ...imports,
    Notice: {},
    AppSelect: {},
  };
  const { controls, unmount } = mountSetup(
    new URL(
      "../apps/web/src/features/rooms/PlatformMediaImport.vue",
      import.meta.url,
    ),
    dependencies,
  );
  controls.url.value = first.url;
  controls.collection.value = true;
  return { controls, session, runtime, unmount };
}

it("retains the exact continuation and choices after a retryable page failure", async () => {
  const api = vi
    .fn()
    .mockResolvedValueOnce(page())
    .mockResolvedValueOnce(failedPage(true))
    .mockResolvedValueOnce(page([second], "next_cursor"));
  const panel = mountImport(api);
  try {
    const c = panel.controls;
    await c.previewVideos();
    c.selected.value = [first.key];
    await c.previewVideos(c.preview.value.next);
    expect(c.preview.value).toMatchObject({
      items: [first],
      next: "original_cursor",
      truncated: true,
      omitted: 2,
      failures: failedPage(true).failures,
    });
    expect(c.selected.value).toEqual([first.key]);
    expect(c.phase.value).toBe("idle");
    expect(api).toHaveBeenCalledTimes(2);
    await c.previewVideos(c.preview.value.next);
    expect(api.mock.calls[2][2].continuation).toBe("original_cursor");
    expect(c.preview.value).toMatchObject({
      items: [first, second],
      next: "next_cursor",
      failures: [],
    });
    expect(c.selected.value).toEqual([first.key]);
  } finally {
    panel.unmount();
  }
});

it("does not revive the continuation after a non-retryable page response", async () => {
  const api = vi
    .fn()
    .mockResolvedValueOnce(page())
    .mockResolvedValueOnce(failedPage(false));
  const panel = mountImport(api);
  try {
    const c = panel.controls;
    await c.previewVideos();
    c.selected.value = [first.key];
    await c.previewVideos(c.preview.value.next);
    expect(c.preview.value.next).toBeNull();
    expect(c.preview.value.items).toEqual([first]);
    expect(c.selected.value).toEqual([first.key]);
  } finally {
    panel.unmount();
  }
});

it("finishes a successful final page without keeping the consumed cursor", async () => {
  const api = vi
    .fn()
    .mockResolvedValueOnce(page())
    .mockResolvedValueOnce(page([second], null));
  const panel = mountImport(api);
  try {
    const c = panel.controls;
    await c.previewVideos();
    await c.previewVideos(c.preview.value.next);
    expect(c.preview.value.next).toBeNull();
    expect(c.preview.value.truncated).toBe(false);
    expect(c.preview.value.items).toEqual([first, second]);
  } finally {
    panel.unmount();
  }
});

it("preserves the cursor on transport loss without automatically requesting again", async () => {
  const api = vi
    .fn()
    .mockResolvedValueOnce(page())
    .mockRejectedValueOnce(Error("Network unavailable"));
  const panel = mountImport(api);
  try {
    const c = panel.controls;
    await c.previewVideos();
    await c.previewVideos(c.preview.value.next);
    expect(c.preview.value.next).toBe("original_cursor");
    expect(c.error.value).toBe("Network unavailable");
    expect(c.phase.value).toBe("idle");
    expect(api).toHaveBeenCalledTimes(2);
  } finally {
    panel.unmount();
  }
});

it.each(["cancel", "room", "login"])(
  "ignores a late page after %s invalidation",
  async (change) => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });
    const api = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockReturnValueOnce(pending);
    const panel = mountImport(api);
    try {
      const c = panel.controls;
      await c.previewVideos();
      const loading = c.previewVideos(c.preview.value.next);
      if (change === "cancel") c.cancelWork();
      else if (change === "room")
        panel.runtime.room.id = "00000000-0000-0000-0000-000000000002";
      else panel.session.epoch++;
      resolve(failedPage(true));
      await loading;
      if (change === "cancel") {
        expect(c.preview.value.next).toBe("original_cursor");
        expect(c.preview.value.failures).toEqual([]);
      } else expect(c.preview.value).toBeUndefined();
      expect(c.phase.value).toBe("idle");
    } finally {
      panel.unmount();
    }
  },
);
