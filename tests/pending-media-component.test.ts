import { afterEach, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { mountSetup } from "./helpers/mount-setup";
import { RequestFailure } from "../apps/web/src/errors";

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const work = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { work, resolve, reject };
}

function panel() {
  const session = reactive({ epoch: 1, user: { id: "alice" } });
  const pending = reactive({
    selection: { mediaId: "movie", title: "所选影片", epoch: 1 } as {
      mediaId: string;
      title: string;
      epoch: number;
    } | null,
    clear: vi.fn(() => {
      pending.selection = null;
    }),
  });
  const runtime = reactive({
    room: { id: "room-a", name: "放映室 A" } as {
      id: string;
      name: string;
    } | null,
    state: { media_id: "current-movie" } as object | null,
    connected: true,
    permitted: true,
    can: vi.fn(() => runtime.permitted),
    choose: vi.fn(async (_id: string) => true),
  });
  const detail = deferred();
  const catalog = { ensure: vi.fn(() => detail.work) };
  const instance = mountSetup(
    new URL(
      "../apps/web/src/features/library/PendingMediaSelection.vue",
      import.meta.url,
    ),
    {
      useSession: () => session,
      usePendingMedia: () => pending,
      useRoomRuntime: () => runtime,
      useMediaCatalog: () => catalog,
      RequestFailure,
      Notice: {},
    },
  );
  mounted.push(instance.unmount);
  return { ...instance, session, pending, runtime, catalog, detail };
}

it("cancelling while media visibility is checked never sends the cancelled selection", async () => {
  const p = panel();
  const confirming = p.controls.confirm();
  expect(p.controls.busy.value).toBe(true);
  p.pending.clear();
  p.detail.resolve({ id: "movie" });
  await confirming;
  expect(p.catalog.ensure).toHaveBeenCalledWith("movie", true);
  expect(p.runtime.choose).not.toHaveBeenCalled();
  expect(p.pending.selection).toBeNull();
  expect(p.controls.busy.value).toBe(false);
});

it("changing accounts during the detail request cannot send an old account's selection", async () => {
  const p = panel();
  const confirming = p.controls.confirm();
  p.session.epoch++;
  p.session.user = { id: "bob" };
  p.detail.resolve({ id: "movie" });
  await confirming;
  expect(p.runtime.choose).not.toHaveBeenCalled();
  expect(p.controls.busy.value).toBe(false);
});

it("replacing the selected film cannot send either film from the old confirmation", async () => {
  const p = panel();
  const confirming = p.controls.confirm();
  p.pending.selection = {
    mediaId: "another-movie",
    title: "另一部影片",
    epoch: 1,
  };
  p.detail.resolve({ id: "movie" });
  await confirming;
  expect(p.runtime.choose).not.toHaveBeenCalled();
  expect(p.pending.selection?.mediaId).toBe("another-movie");
  expect(p.controls.busy.value).toBe(false);
});

it("switching rooms during the detail request never sends the selection to the new room", async () => {
  const p = panel();
  const confirming = p.controls.confirm();
  p.runtime.room = { id: "room-b", name: "放映室 B" };
  p.detail.resolve({ id: "movie" });
  await confirming;
  expect(p.runtime.choose).not.toHaveBeenCalled();
  expect(p.pending.selection?.mediaId).toBe("movie");
  expect(p.controls.busy.value).toBe(false);
});

it("returning to the original room cannot revive an earlier confirmation", async () => {
  const p = panel();
  const confirming = p.controls.confirm();
  p.runtime.room = { id: "room-b", name: "放映室 B" };
  p.runtime.room = { id: "room-a", name: "放映室 A" };
  p.detail.resolve({ id: "movie" });
  await confirming;
  expect(p.runtime.choose).not.toHaveBeenCalled();
  expect(p.pending.selection?.mediaId).toBe("movie");
  expect(p.controls.busy.value).toBe(false);
});

it("reconnecting during the detail request requires a fresh confirmation", async () => {
  const p = panel();
  const confirming = p.controls.confirm();
  p.runtime.connected = false;
  p.runtime.connected = true;
  p.detail.resolve({ id: "movie" });
  await confirming;
  expect(p.runtime.choose).not.toHaveBeenCalled();
  expect(p.pending.selection?.mediaId).toBe("movie");
  await p.controls.confirm();
  expect(p.runtime.choose).toHaveBeenCalledExactlyOnceWith("movie");
  expect(p.pending.selection).toBeNull();
});

it("revoked media visibility clears the stale selection and never sends it", async () => {
  const p = panel();
  const confirming = p.controls.confirm();
  p.detail.reject(
    new RequestFailure({
      error: { code: "MEDIA_NOT_FOUND", message: "影片已不可访问" },
    }),
  );
  await confirming;
  expect(p.runtime.choose).not.toHaveBeenCalled();
  expect(p.pending.selection).toBeNull();
  expect(p.controls.error.value).toContain("影片已不可访问");
  expect(p.controls.busy.value).toBe(false);
});

it("permission loss during media visibility checking keeps the selection without sending it", async () => {
  const p = panel();
  const confirming = p.controls.confirm();
  p.runtime.permitted = false;
  p.detail.resolve({ id: "movie" });
  await confirming;
  expect(p.runtime.choose).not.toHaveBeenCalled();
  expect(p.pending.selection?.mediaId).toBe("movie");
  expect(p.controls.busy.value).toBe(false);
});

it("a control channel that cannot send keeps the selected film and reports that continuation is needed", async () => {
  const p = panel();
  p.runtime.choose.mockResolvedValue(false);
  const confirming = p.controls.confirm();
  p.detail.resolve({ id: "movie" });
  await confirming;
  expect(p.runtime.choose).toHaveBeenCalledTimes(1);
  expect(p.pending.selection?.mediaId).toBe("movie");
  expect(p.pending.clear).not.toHaveBeenCalled();
  expect(p.controls.error.value).not.toBe("");
  expect(p.controls.busy.value).toBe(false);
  p.runtime.choose.mockResolvedValue(true);
  await p.controls.confirm();
  expect(p.runtime.choose).toHaveBeenCalledTimes(2);
  expect(p.pending.selection).toBeNull();
});

it("rapid confirmations check visibility once and send only one change-media command", async () => {
  const p = panel();
  const first = p.controls.confirm(),
    second = p.controls.confirm();
  expect(p.catalog.ensure).toHaveBeenCalledTimes(1);
  expect(p.runtime.choose).not.toHaveBeenCalled();
  p.detail.resolve({ id: "movie" });
  await Promise.all([first, second]);
  expect(p.runtime.choose).toHaveBeenCalledExactlyOnceWith("movie");
  expect(p.pending.clear).toHaveBeenCalledTimes(1);
  expect(p.pending.selection).toBeNull();
  expect(p.controls.busy.value).toBe(false);
});

it("leaving the component during the detail request cannot issue a command later", async () => {
  const p = panel();
  const confirming = p.controls.confirm();
  p.unmount();
  p.detail.resolve({ id: "movie" });
  await confirming;
  expect(p.runtime.choose).not.toHaveBeenCalled();
});
