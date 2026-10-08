import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, reactive, ref } from "vue";
import { mountSetup } from "./helpers/mount-setup";
import * as platformImport from "../apps/web/src/features/rooms/platform-import";
import {
  preparationFailure,
  type PlaybackPreparationState,
} from "../apps/web/src/features/playback/playback-preparation";
import { useRoomNotice } from "../apps/web/src/features/playback/room-notice";

const dispose: (() => void)[] = [];
afterEach(() => {
  for (const stop of dispose.splice(0)) stop();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const item: platformImport.PlatformImportPreviewItem = {
  key: "a".repeat(64),
  provider: "douyin",
  url: "https://www.douyin.com/video/123",
  part: 1,
  title: "Fixture video",
};
const preview: platformImport.PlatformImportPreview = {
  items: [item],
  failures: [],
  truncated: true,
  limit: 20,
  next: "fixture-next-page",
};

function importPanel() {
  const room = reactive({
    roomActive: true,
    connected: true,
    room: { id: "fixture-room" },
    can: () => true,
  });
  const session = reactive({ epoch: 1, api: vi.fn() });
  const api = {
    previewPlatform: vi.fn().mockResolvedValue(preview),
    importPlatformBatch: vi.fn().mockResolvedValue({ outcomes: [] }),
  };
  const account = {
    refresh: vi.fn(),
    refreshYoutube: vi.fn(),
    refreshShort: vi.fn(),
  };
  const catalog = { rememberRoom: vi.fn() };
  const panel = mountSetup(
    new URL(
      "../apps/web/src/features/rooms/PlatformMediaImport.vue",
      import.meta.url,
    ),
    {
      ...platformImport,
      useRoomRuntime: () => room,
      useSession: () => session,
      usePlatformAccount: () => account,
      useMediaCatalog: () => catalog,
      roomsApi: () => api,
      Notice: {},
      AppSelect: {},
    },
  );
  dispose.push(panel.unmount);
  panel.controls.url.value = item.url;
  return { ...panel, api, account, catalog, room, session };
}

describe("platform import feedback follows the active request stage", () => {
  it("stopping an initial preview does not imply any import was submitted", async () => {
    const p = importPanel();
    const pending = deferred<platformImport.PlatformImportPreview>();
    p.api.previewPlatform.mockReturnValue(pending.promise);
    const running = p.controls.previewVideos();
    expect(p.controls.workLabel.value).toBe("正在预览…");
    p.controls.cancelWork();
    expect(p.controls.error.value).toBe("已停止等待预览，可重新预览");
    expect(p.controls.busy.value).toBe(false);
    expect(p.api.previewPlatform.mock.calls[0][4].aborted).toBe(true);
    expect(p.api.importPlatformBatch).not.toHaveBeenCalled();
    pending.resolve(preview);
    await running;
    expect(p.controls.preview.value).toBeUndefined();
  });

  it("stopping the next preview page preserves candidates, selections and prior outcomes", async () => {
    const p = importPanel();
    await p.controls.previewVideos();
    const candidates = p.controls.preview.value;
    const outcomes = [{ key: "prior-item", media: { id: "prior-media" } }];
    p.controls.outcomes.value = outcomes;
    const pending = deferred<platformImport.PlatformImportPreview>();
    p.api.previewPlatform.mockReturnValue(pending.promise);
    const running = p.controls.previewVideos(preview.next);
    expect(p.controls.workLabel.value).toBe("正在预览下一页…");
    p.controls.cancelWork();
    expect(p.controls.error.value).toBe(
      "已停止等待本页预览，已显示的候选和选择保留",
    );
    expect(p.controls.preview.value).toBe(candidates);
    expect(p.controls.selected.value).toEqual([item.key]);
    expect(p.controls.outcomes.value).toEqual(outcomes);
    pending.resolve({ ...preview, items: [] });
    await running;
    expect(p.controls.preview.value).toBe(candidates);
    expect(p.api.importPlatformBatch).not.toHaveBeenCalled();
  });

  it("stopping account checks states that this import has not been submitted", async () => {
    const p = importPanel();
    p.controls.credentialMode.value = "own_or_anonymous";
    await p.controls.previewVideos();
    const pending = deferred<undefined>();
    p.account.refreshShort.mockReturnValue(pending.promise);
    const running = p.controls.importSelected();
    expect(p.controls.workLabel.value).toBe("正在检查导入条件…");
    p.controls.cancelWork();
    expect(p.controls.error.value).toContain("本次尚未提交导入");
    expect(p.controls.error.value).not.toContain("可能已导入");
    expect(p.controls.selected.value).toEqual([item.key]);
    pending.resolve(undefined);
    await running;
    expect(p.api.importPlatformBatch).not.toHaveBeenCalled();
    expect(p.catalog.rememberRoom).not.toHaveBeenCalled();
  });

  it("only stopping a submitted batch warns about possible success and ignores late results", async () => {
    const p = importPanel();
    await p.controls.previewVideos();
    const pending = deferred<unknown>();
    p.api.importPlatformBatch.mockReturnValue(pending.promise);
    const running = p.controls.importSelected();
    expect(p.controls.workLabel.value).toBe("正在等待导入结果…");
    expect(p.api.importPlatformBatch).toHaveBeenCalledOnce();
    p.controls.cancelWork();
    expect(p.controls.error.value).toContain("服务端可能已导入部分条目");
    expect(p.controls.error.value).toContain("可重试同一批所选条目");
    expect(p.controls.selected.value).toEqual([item.key]);
    expect(p.api.importPlatformBatch.mock.calls[0][2].aborted).toBe(true);
    pending.resolve({
      outcomes: [{ key: item.key, media: { id: "imported" } }],
    });
    await running;
    expect(p.controls.outcomes.value).toEqual([]);
    expect(p.catalog.rememberRoom).not.toHaveBeenCalled();
  });

  it("revoked control resets the phase and fences an in-flight account check", async () => {
    const p = importPanel();
    p.controls.credentialMode.value = "own_or_anonymous";
    await p.controls.previewVideos();
    const pending = deferred<undefined>();
    p.account.refreshShort.mockReturnValue(pending.promise);
    const running = p.controls.importSelected();
    p.room.connected = false;
    expect(p.controls.phase.value).toBe("idle");
    expect(p.controls.preview.value).toBeUndefined();
    expect(p.controls.selected.value).toEqual([]);
    pending.resolve(undefined);
    await running;
    expect(p.api.importPlatformBatch).not.toHaveBeenCalled();
    expect(p.controls.error.value).toBe("");
  });

  it("a second stop after completion does not invent a cancellation result", async () => {
    const p = importPanel();
    await p.controls.previewVideos();
    p.controls.cancelWork();
    expect(p.controls.error.value).toBe("");
    expect(p.controls.preview.value.items).toEqual([item]);
  });

  it("a failed pre-import check does not claim an unconfirmed batch", async () => {
    const p = importPanel();
    p.controls.credentialMode.value = "own_or_anonymous";
    await p.controls.previewVideos();
    p.account.refreshShort.mockRejectedValue(
      Error("Fixture account unavailable"),
    );
    await p.controls.importSelected();
    expect(p.controls.error.value).toContain("本次尚未提交导入");
    expect(p.controls.error.value).not.toContain("结果未确认");
    expect(p.controls.busy.value).toBe(false);
    expect(p.api.importPlatformBatch).not.toHaveBeenCalled();
  });

  it("late completion of a cancelled request cannot reset a newer request's phase", async () => {
    const p = importPanel();
    const old = deferred<platformImport.PlatformImportPreview>();
    const current = deferred<platformImport.PlatformImportPreview>();
    p.api.previewPlatform
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const first = p.controls.previewVideos();
    p.controls.cancelWork();
    const second = p.controls.previewVideos();
    old.resolve(preview);
    await first;
    expect(p.controls.busy.value).toBe(true);
    expect(p.controls.workLabel.value).toBe("正在预览…");
    current.resolve(preview);
    await second;
    expect(p.controls.busy.value).toBe(false);
    expect(p.controls.error.value).toBe("");
  });
});

function notices() {
  const runtime = reactive({
    error: "",
    preparation: { phase: "idle" } as PlaybackPreparationState,
  });
  const action = ref("");
  const scope = effectScope();
  const [shell, fullscreen] = scope.run(() => [
    useRoomNotice(runtime, action),
    useRoomNotice(runtime),
  ])!;
  dispose.push(() => scope.stop());
  return { runtime, action, shell, fullscreen };
}

describe("ordinary and fullscreen notices share source-specific ownership", () => {
  it("deduplicates only the current playback failure and retains unrelated room errors", () => {
    const n = notices();
    n.runtime.preparation = {
      phase: "failed",
      failure: preparationFailure(new TypeError("Fixture playback failure")),
    };
    n.runtime.error = "Fixture playback failure";
    expect(n.shell.value).toBeUndefined();
    expect(n.fullscreen.value).toBeUndefined();
    n.runtime.error = "Fixture room disconnected";
    expect(n.shell.value?.message).toBe("Fixture room disconnected");
    expect(n.fullscreen.value?.message).toBe("Fixture room disconnected");
    n.fullscreen.value!.dismiss();
    expect(n.runtime.error).toBe("");
    expect(n.runtime.preparation.phase).toBe("failed");
  });

  it("closing a shell action leaves the hidden runtime source intact, even with equal text", () => {
    const n = notices();
    n.action.value = "Fixture error";
    n.runtime.error = "Fixture error";
    expect(n.shell.value?.source).toBe("action");
    n.shell.value!.dismiss();
    expect(n.action.value).toBe("");
    expect(n.runtime.error).toBe("Fixture error");
    expect(n.shell.value?.source).toBe("runtime");
  });

  it("a stale close cannot dismiss a newer source revision, including a repeated message", () => {
    const n = notices();
    n.action.value = "First action failure";
    const oldAction = n.shell.value!;
    n.action.value = "New action failure";
    oldAction.dismiss();
    expect(n.action.value).toBe("New action failure");
    n.runtime.error = "First runtime failure";
    const oldRuntime = n.fullscreen.value!;
    n.runtime.error = "";
    n.runtime.error = "First runtime failure";
    oldRuntime.dismiss();
    expect(n.runtime.error).toBe("First runtime failure");
    expect(n.fullscreen.value!.key).not.toBe(oldRuntime.key);
  });

  it("a non-failed preparation does not suppress an existing runtime error", () => {
    const n = notices();
    const failure = preparationFailure(new Error("Fixture error"));
    n.runtime.preparation = { phase: "preparing", failure };
    n.runtime.error = "Fixture error";
    expect(n.shell.value?.message).toBe("Fixture error");
    expect(n.fullscreen.value?.message).toBe("Fixture error");
  });
});
