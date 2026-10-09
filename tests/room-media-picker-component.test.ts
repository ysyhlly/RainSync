import { afterEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { nextTick, reactive } from "vue";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";
import {
  createLibraryState,
  useLibrary,
} from "../apps/web/src/features/library/library.store";
import { useMediaCatalog } from "../apps/web/src/features/library/media-catalog.store";
import { formatTime } from "../apps/web/src/shared/use-action";
import { libraryPageSummary } from "../apps/web/src/features/library/library-summary";
import { mediaEpisodeLabel } from "../apps/web/src/features/library/media-label";
import { prewarmNativeDash } from "../apps/web/src/features/playback/dash-prewarm";
import { readFileSync } from "node:fs";
import { parse } from "@vue/compiler-sfc";

let pinia: ReturnType<typeof createPinia>;
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  if (pinia) disposePinia(pinia);
  vi.useRealTimers();
});
const film = { id: "new-film", title: "下一部影片", kind: "local" };
const page = (node: string | null = null) => ({
  node,
  breadcrumbs: [
    { id: null, name: "全部片源" },
    ...(node ? [{ id: node, name: node }] : []),
  ],
  entries: [{ type: "media", media: film }],
  next_cursor: null,
  total_media: 1,
});
async function picker(api = vi.fn().mockResolvedValue(page())) {
  pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.accept({ id: "alice", username: "alice", csrf: "x", admin: false });
  session.api = api as any;
  const rights = reactive({ change_media: true, queue: true });
  const runtime = reactive({
    room: { id: "room-a", owner_id: "alice", name: "Room A" },
    state: { media_id: "current-film", controller_user_id: "alice" },
    roomActive: true,
    connected: true,
    playbackRoom: { nativePlaybackMode: undefined },
    error: "",
    playlist: [] as { media_id: string }[],
    playlistError: "",
    can: (permission: string) => rights[permission as keyof typeof rights],
    choose: vi.fn().mockResolvedValue(true),
    addQueue: vi.fn().mockResolvedValue(undefined),
    queuePending: vi.fn().mockReturnValue(false),
    queueReceipt: vi.fn().mockReturnValue(""),
    queuePendingCount: 0,
  });
  const closed = vi.fn();
  const p = mountSetup(
    new URL(
      "../apps/web/src/features/rooms/RoomMediaPicker.vue",
      import.meta.url,
    ),
    {
      reactive,
      useSession: () => session,
      useRoomRuntime: () => runtime,
      createLibraryState,
      useMediaCatalog,
      formatTime,
      libraryPageSummary,
      mediaEpisodeLabel,
      prewarmNativeDash,
      LibraryHierarchy: {},
      MediaThumbnail: {},
      QueueFeedback: {},
      AppDialog: {},
      AppIcon: {},
      Notice: {},
    },
    { modelValue: true, "onUpdate:modelValue": closed },
  );
  cleanup.push(p.unmount);
  await nextTick();
  return { ...p, c: p.controls, session, runtime, rights, api, closed };
}
it("uses an isolated browser snapshot and leaves the library page's query and cursor untouched", async () => {
  const p = await picker();
  const library = useLibrary();
  p.api.mockResolvedValueOnce(
    Array.from({ length: 25 }, (_, i) => ({ ...film, id: `library-${i}` })),
  );
  await library.load(0, "independent query");
  p.api.mockResolvedValueOnce(page("picker-directory"));
  p.c.navigate("picker-directory");
  await nextTick();
  expect(p.c.browser.node).toBe("picker-directory");
  expect(library.query).toBe("independent query");
  expect(library.items[0].id).toBe("library-0");
  expect(library.hasMore).toBe(true);
  p.setProps({ modelValue: false });
  await nextTick();
  expect(p.c.browser.loaded).toBe(false);
  expect(library.query).toBe("independent query");
  expect(library.hasMore).toBe(true);
});
it("searches across directories through bounded GETs and returns to the picker directory", async () => {
  const p = await picker();
  p.api.mockResolvedValueOnce(page("deep"));
  p.c.navigate("deep");
  await nextTick();
  p.api.mockResolvedValueOnce([film]);
  p.c.search.value = "跨目录";
  p.c.submit();
  await nextTick();
  expect(p.api.mock.calls.at(-1)?.slice(0, 3)).toEqual([
    "/media?limit=25&search=%E8%B7%A8%E7%9B%AE%E5%BD%95",
    "GET",
    undefined,
  ]);
  p.api.mockResolvedValueOnce(page("deep"));
  p.c.clearSearch();
  await nextTick();
  expect(p.api.mock.calls.at(-1)?.[0]).toBe("/media/browse?limit=24&node=deep");
});
it("dismissal aborts an in-flight read and stale results cannot appear on reopen", async () => {
  let finish!: (value: unknown) => void;
  const p = await picker(
    vi
      .fn()
      .mockImplementationOnce(() => new Promise((done) => (finish = done)))
      .mockResolvedValue(page("fresh")),
  );
  const signal = p.api.mock.calls[0][3];
  p.setProps({ modelValue: false });
  await nextTick();
  expect(signal.aborted).toBe(true);
  p.setProps({ modelValue: true });
  await nextTick();
  finish(page("stale"));
  await nextTick();
  expect(p.c.browser.node).toBe("fresh");
  expect(p.c.browser.error).toBe("");
});
it.each(["account", "room", "role", "guest"])(
  "%s change discards reads and blocks stale writes",
  async (change) => {
    let finish!: (value: unknown) => void;
    const p = await picker();
    p.api.mockImplementationOnce(() => new Promise((done) => (finish = done)));
    p.c.navigate("pending");
    if (change === "account")
      p.session.accept({ id: "bob", username: "bob", csrf: "b", admin: false });
    else if (change === "room") p.runtime.room.id = "room-b";
    else if (change === "guest") p.session.user!.guest = true;
    else p.rights.change_media = p.rights.queue = false;
    finish(page("stale"));
    await nextTick();
    await p.c.play(film.id);
    await p.c.add(film.id);
    expect(p.c.browser.items).toEqual([]);
    expect(p.runtime.choose).not.toHaveBeenCalled();
    expect(p.runtime.addQueue).not.toHaveBeenCalled();
  },
);
it("does not browse at all when opened with a guest identity", async () => {
  const p = await picker();
  p.setProps({ modelValue: false });
  await nextTick();
  p.session.user!.guest = true;
  const count = p.api.mock.calls.length;
  p.setProps({ modelValue: true });
  await nextTick();
  expect(p.c.visible.value).toBe(false);
  expect(p.api).toHaveBeenCalledTimes(count);
});
it("guards separate play and queue permissions at dispatch", async () => {
  const p = await picker();
  p.rights.change_media = false;
  await nextTick();
  // An authorized queue-only reopening gets its own fresh directory snapshot.
  p.setProps({ modelValue: false });
  await nextTick();
  p.setProps({ modelValue: true });
  await nextTick();
  await p.c.play(film.id);
  await p.c.add(film.id);
  expect(p.runtime.choose).not.toHaveBeenCalled();
  expect(p.runtime.addQueue).toHaveBeenCalledExactlyOnceWith(film.id);
  p.rights.change_media = true;
  p.rights.queue = false;
  p.setProps({ modelValue: false });
  await nextTick();
  p.setProps({ modelValue: true });
  await nextTick();
  await p.c.add(film.id);
  await p.c.play(film.id);
  expect(p.runtime.addQueue).toHaveBeenCalledTimes(1);
  expect(p.runtime.choose).toHaveBeenCalledExactlyOnceWith(film.id);
});
it("prevents duplicate playback while waiting, including close/reopen, and waits for real room confirmation", async () => {
  const p = await picker();
  await p.c.play(film.id);
  await p.c.play(film.id);
  expect(p.runtime.choose).toHaveBeenCalledTimes(1);
  expect(p.c.playReceipts.value[film.id].message).toContain("等待房间确认");
  p.setProps({ modelValue: false });
  await nextTick();
  p.setProps({ modelValue: true });
  await nextTick();
  await p.c.play(film.id);
  expect(p.runtime.choose).toHaveBeenCalledTimes(1);
  p.runtime.state.media_id = film.id;
  expect(p.c.pendingPlay.value).toBe("");
  expect(p.c.playReceipts.value[film.id].message).toBe("已切换为当前影片");
  await p.c.play(film.id);
  expect(p.runtime.choose).toHaveBeenCalledTimes(1);
});
it("reports unconfirmed play without replaying a command on timeout", async () => {
  vi.useFakeTimers();
  const p = await picker();
  await p.c.play(film.id);
  vi.advanceTimersByTime(10000);
  expect(p.c.pendingPlay.value).toBe("");
  expect(p.c.playReceipts.value[film.id]).toMatchObject({ error: true });
  expect(p.runtime.choose).toHaveBeenCalledTimes(1);
});
it("closes immediately on current room confirmation and stays open on an unconfirmed send", async () => {
  const p = await picker();
  await p.c.play(film.id);
  expect(p.closed).not.toHaveBeenCalled();
  p.runtime.state.media_id = film.id;
  expect(p.closed).toHaveBeenCalledExactlyOnceWith(false);
});
it("a previous drawer's late play confirmation cannot close a reopened drawer", async () => {
  const p = await picker();
  let confirm!: (sent: boolean) => void;
  p.runtime.choose.mockReturnValueOnce(
    new Promise((resolve) => {
      confirm = resolve;
    }),
  );
  const old = p.c.play(film.id);
  p.setProps({ modelValue: false });
  await nextTick();
  p.setProps({ modelValue: true });
  await nextTick();
  p.runtime.state.media_id = film.id;
  confirm(true);
  await old;
  expect(p.closed).not.toHaveBeenCalled();
});
it("a rejected play request keeps its drawer open with a local error", async () => {
  const p = await picker();
  p.runtime.choose.mockRejectedValueOnce(new Error("请求失败"));
  await p.c.play(film.id);
  expect(p.closed).not.toHaveBeenCalled();
  expect(p.c.playReceipts.value[film.id]).toEqual({
    message: "请求失败",
    error: true,
  });
});
it("does not claim a failed send succeeded or act while disconnected", async () => {
  const p = await picker();
  p.runtime.choose.mockResolvedValue(false);
  await p.c.play(film.id);
  expect(p.c.playReceipts.value[film.id].message).toContain("未发送");
  expect(p.c.pendingPlay.value).toBe("");
  p.runtime.connected = false;
  await p.c.play(film.id);
  await p.c.add(film.id);
  expect(p.runtime.choose).toHaveBeenCalledTimes(1);
  expect(p.runtime.addQueue).not.toHaveBeenCalled();
});
it("queue errors stay per item, successful receipts guard repeat adds, and stale failures are discarded", async () => {
  const p = await picker();
  p.runtime.addQueue.mockRejectedValueOnce(Error("待播失败"));
  await p.c.add(film.id);
  expect(p.c.queueErrors.value[film.id]).toBe("待播失败");
  p.runtime.queuePending.mockReturnValue(true);
  await p.c.add(film.id);
  p.runtime.queuePending.mockReturnValue(false);
  p.runtime.queueReceipt.mockReturnValue("已加入");
  p.runtime.playlist = [{ media_id: film.id }];
  await p.c.add(film.id);
  expect(p.runtime.addQueue).toHaveBeenCalledTimes(1);
  p.runtime.queueReceipt.mockReturnValue("");
  p.runtime.playlist = [];
  let reject!: (error: Error) => void;
  p.runtime.addQueue.mockImplementationOnce(
    () => new Promise((_, no) => (reject = no)),
  );
  const old = p.c.add(film.id);
  p.runtime.room.id = "room-b";
  reject(Error("旧房间失败"));
  await old;
  expect(p.c.queueErrors.value).toEqual({});
});
it("failed directory load retains rows and read retry never dispatches media mutations", async () => {
  const p = await picker();
  p.api.mockRejectedValueOnce(Error("目录暂不可用"));
  p.c.navigate("failed");
  await nextTick();
  await nextTick();
  expect(p.c.browser.items).toHaveLength(1);
  expect(p.c.browser.error).toBe("目录暂不可用");
  p.api.mockResolvedValueOnce(page("failed"));
  await p.c.browser.retry();
  expect(p.api.mock.calls.at(-1)?.slice(0, 2)).toEqual([
    "/media/browse?limit=24&node=failed",
    "GET",
  ]);
  expect(p.runtime.choose).not.toHaveBeenCalled();
  expect(p.runtime.addQueue).not.toHaveBeenCalled();
});
it("room chooser and queue entry are in-place buttons, with guards for Back dismissal", () => {
  const source = readFileSync(
    new URL("../apps/web/src/features/rooms/RoomPage.vue", import.meta.url),
    "utf8",
  );
  const template = parse(source).descriptor.template!.content;
  expect(template).not.toContain('to="/library"');
  expect(template).toContain('<RoomMediaPicker v-model="mediaPickerOpen"');
  expect(template.match(/@click="mediaPickerOpen = true"/g)).toHaveLength(3);
  expect(source).toContain("onBeforeRouteLeave(dismissMediaPicker)");
  expect(source).toContain("onBeforeRouteUpdate(dismissMediaPicker)");
});

it("routes search Escape through the dialog's guarded close instead of native search clearing", () => {
  const source = readFileSync(
    new URL(
      "../apps/web/src/features/rooms/RoomMediaPicker.vue",
      import.meta.url,
    ),
    "utf8",
  );
  expect(source).toContain('@keydown.esc.prevent.stop="pickerDialog?.close()"');
  const dialog = readFileSync(
    new URL("../apps/web/src/shared/ui/AppDialog.vue", import.meta.url),
    "utf8",
  );
  expect(dialog).toContain("defineExpose({ close })");
});
