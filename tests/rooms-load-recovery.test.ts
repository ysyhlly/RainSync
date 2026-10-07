import { mountSetup } from "./helpers/mount-setup";
import * as Vue from "vue";
import { expect, it, vi } from "vitest";
import { useAction } from "../apps/web/src/shared/use-action";
import {
  filterRooms,
  lifecycleLabels,
} from "../apps/web/src/features/rooms/room-lifecycle";

async function page() {
  const list = vi
    .fn<() => Promise<unknown>>()
    .mockRejectedValue(new Error("首次加载失败"));
  const imports = {
    useRouter: () => ({ push: vi.fn() }),
    useSession: () => ({ user: { id: "owner" } }),
    useRoomRuntime: () => ({ room: null, enter: vi.fn() }),
    roomsApi: () => ({ list }),
    createRoomSubmission: () => vi.fn(),
    useAction,
    filterRooms,
    lifecycleLabels,
    AppDialog: {},
    AppIcon: {},
    AppSelect: {},
    Notice: {},
    PendingMediaSelection: {},
  };
  const { controls, unmount } = mountSetup(
    new URL("../apps/web/src/features/rooms/RoomsPage.vue", import.meta.url),
    imports,
  );
  await vi.waitFor(() => expect(controls.loadError.value).toBe("首次加载失败"));
  return { controls, list, unmount };
}

it.each(["joinOpen", "createOpen"])(
  "preserves room-load errors after opening and cancelling %s, then recovers",
  async (dialog) => {
    const p = await page();
    expect(p.controls.error.value).toBe("");
    p.controls[dialog].value = true;
    await Vue.nextTick();
    expect(p.controls.loadError.value).toBe("首次加载失败");
    expect(p.controls.error.value).toBe("");
    p.controls[dialog].value = false;
    await Vue.nextTick();
    expect(p.controls.loadError.value).toBe("首次加载失败");
    expect(p.controls.loaded.value).toBe(false);
    p.list.mockResolvedValue([
      { id: "room", name: "周末放映室", owner_id: "owner" },
    ]);
    await p.controls.reload();
    expect(p.controls.loaded.value).toBe(true);
    expect(p.controls.rooms.value).toHaveLength(1);
    expect(p.controls.loadError.value).toBe("");
    expect(p.controls.error.value).toBe("");
    p.unmount();
  },
);

it("keeps the latest list failure independent from a newer invitation validation error", async () => {
  const p = await page();
  p.controls.joinOpen.value = true;
  await Vue.nextTick();
  p.controls.pasted.value = "invalid JSON";
  p.controls.parse();
  const validation = p.controls.error.value;
  expect(validation).toContain("请粘贴完整房间邀请JSON");
  p.list.mockRejectedValue(new Error("重试加载失败"));
  await p.controls.reload();
  expect(p.controls.loadError.value).toBe("重试加载失败");
  expect(p.controls.error.value).toBe(validation);
  p.controls.joinOpen.value = false;
  await Vue.nextTick();
  expect(p.controls.loadError.value).toBe("重试加载失败");
  p.unmount();
});
