import { nextTick, reactive } from "vue";
import { expect, it, vi } from "vitest";
import { mountSetup } from "./helpers/mount-setup";
import { useAction } from "../apps/web/src/shared/use-action";

function panel(
  api = vi.fn(async () => ({ enabled: false, guests_enabled: true })),
) {
  const room = reactive({
    room: { id: "room-a" },
    canManageRoom: true,
    roomActive: true,
  });
  const session = reactive({ epoch: 1, api });
  const mounted = mountSetup(
    new URL(
      "../apps/web/src/features/rooms/RoomGuestAccess.vue",
      import.meta.url,
    ),
    {
      useRoomRuntime: () => room,
      useSession: () => session,
      useAction,
      AppDialog: {},
      Notice: {},
    },
  );
  return { ...mounted, room, session, api };
}
it("loads explicit room policy and only saves the opted-in boolean", async () => {
  const p = panel();
  await p.controls.show();
  expect(p.controls.loaded.value).toBe(true);
  expect(p.controls.enabled.value).toBe(false);
  p.controls.enabled.value = true;
  await p.controls.save();
  expect(p.api).toHaveBeenLastCalledWith("/rooms/room-a/guest-access", "PUT", {
    enabled: true,
  });
  expect(p.controls.message.value).toContain("有效观看邀请");
  p.unmount();
});
it("keeps a failed or dismissed load from enabling save", async () => {
  const p = panel(
    vi.fn(async () => {
      throw Error("offline");
    }),
  );
  await p.controls.run(p.controls.show);
  expect(p.controls.loaded.value).toBe(false);
  await p.controls.save();
  expect(p.api).toHaveBeenCalledTimes(1);
  expect(p.controls.error.value).toBe("offline");
  p.unmount();
});
it("discards late responses after closing or switching rooms", async () => {
  let resolve!: (value: any) => void;
  const p = panel(vi.fn(() => new Promise<any>((done) => (resolve = done))));
  const load = p.controls.show();
  p.controls.cancel();
  resolve({ enabled: true, guests_enabled: true });
  await load;
  expect(p.controls.loaded.value).toBe(false);
  expect(p.controls.open.value).toBe(false);
  const second = p.controls.show();
  p.room.room = { id: "room-b" };
  await nextTick();
  resolve({ enabled: true, guests_enabled: true });
  await second;
  expect(p.controls.loaded.value).toBe(false);
  await p.controls.save();
  expect(p.api).toHaveBeenCalledTimes(2);
  p.unmount();
});
it("never writes after account switch or loss of room management", async () => {
  const p = panel();
  await p.controls.show();
  p.room.canManageRoom = false;
  await p.controls.save();
  expect(p.api).toHaveBeenCalledTimes(1);
  p.unmount();
});
it("closes stale settings on account switch before a write", async () => {
  const p = panel();
  await p.controls.show();
  p.session.epoch++;
  await nextTick();
  await p.controls.save();
  expect(p.controls.open.value).toBe(false);
  expect(p.api).toHaveBeenCalledTimes(1);
  p.unmount();
});
it("does not claim success from a save after navigation", async () => {
  let finish!: (value: any) => void;
  const api = vi
    .fn()
    .mockResolvedValueOnce({ enabled: false, guests_enabled: false })
    .mockImplementationOnce(() => new Promise((done) => (finish = done)));
  const p = panel(api);
  await p.controls.show();
  expect(p.controls.globalEnabled.value).toBe(false);
  p.controls.enabled.value = true;
  const saving = p.controls.save();
  p.room.room = { id: "room-b" };
  await nextTick();
  finish({ enabled: true });
  await saving;
  expect(p.controls.message.value).toBe("");
  p.unmount();
});
