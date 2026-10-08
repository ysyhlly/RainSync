import { afterEach, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { readFileSync } from "node:fs";
import { parse } from "@vue/compiler-sfc";
import { mountSetup } from "./helpers/mount-setup";
import { useAction } from "../apps/web/src/shared/use-action";
import { createRoomSubmission } from "../apps/web/src/features/rooms/room-creation";
import {
  filterRooms,
  lifecycleLabels,
} from "../apps/web/src/features/rooms/room-lifecycle";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));
const room = {
  id: "created-room",
  name: "Submitted room",
  owner_id: "fixture",
};
async function panel(create: ReturnType<typeof vi.fn>) {
  const list = vi.fn().mockResolvedValue([room]);
  const enter = vi.fn().mockResolvedValue(undefined);
  const push = vi.fn().mockResolvedValue(undefined);
  const p = mountSetup(
    new URL("../apps/web/src/features/rooms/RoomsPage.vue", import.meta.url),
    {
      useSession: () => ({ user: { id: "fixture" } }),
      useRoomRuntime: () => ({ room: null, enter }),
      roomsApi: () => ({ list, create }),
      createRoomSubmission,
      useRouter: () => ({ push }),
      useAction,
      filterRooms,
      lifecycleLabels,
      AppDialog: {},
      AppIcon: {},
      AppSelect: {},
      Notice: {},
      PendingMediaSelection: {},
    },
  );
  cleanup.push(p.unmount);
  await vi.waitFor(() => expect(p.controls.loading.value).toBe(false));
  p.controls.createOpen.value = true;
  p.controls.name.value = "Submitted room";
  await nextTick();
  return { c: p.controls, list, enter, push };
}

it("preserves a newer room draft after an older creation completes", async () => {
  let finish!: (value: { id: string }) => void;
  const create = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { c, enter, push } = await panel(create);
  const pending = c.submitCreate();
  c.name.value = "New room draft";
  finish({ id: room.id });
  await pending;
  expect(create.mock.calls[0][0]).toBe("Submitted room");
  expect(c.name.value).toBe("New room draft");
  expect(c.createOpen.value).toBe(true);
  expect(enter).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

it("blocks duplicate room creation and keeps the normal enter redirect", async () => {
  let finish!: (value: { id: string }) => void;
  const create = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { c, enter, push } = await panel(create);
  const pending = c.submitCreate();
  await c.submitCreate();
  expect(create).toHaveBeenCalledTimes(1);
  expect(c.busy.value).toBe(true);
  finish({ id: room.id });
  await pending;
  expect(c.name.value).toBe("");
  expect(c.createOpen.value).toBe(false);
  expect(enter).toHaveBeenCalledExactlyOnceWith(room);
  expect(push).toHaveBeenCalledExactlyOnceWith("/rooms/" + room.id);
  expect(c.busy.value).toBe(false);
});

it("preserves a failed room draft and reuses its existing retry key", async () => {
  const create = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce({ id: room.id });
  const { c, enter } = await panel(create);
  await c.submitCreate();
  expect(c.name.value).toBe("Submitted room");
  expect(c.createOpen.value).toBe(true);
  expect(c.error.value).toBe("offline");
  expect(c.busy.value).toBe(false);
  expect(enter).not.toHaveBeenCalled();
  await c.submitCreate();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  expect(enter).toHaveBeenCalledOnce();
});

it("does not navigate away from a newer draft opened during post-create list reload", async () => {
  const { c, list, push } = await panel(
    vi.fn().mockResolvedValue({ id: room.id }),
  );
  let finish!: (value: (typeof room)[]) => void;
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = c.submitCreate();
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  c.createOpen.value = true;
  c.name.value = "A newer draft";
  finish([room]);
  await pending;
  expect(c.name.value).toBe("A newer draft");
  expect(c.createOpen.value).toBe(true);
  expect(push).not.toHaveBeenCalled();
});

it.each([
  ["list reload", "joinOpen", false],
  ["list reload", "joinOpen", true],
  ["runtime entry", "joinOpen", false],
  ["runtime entry", "joinOpen", true],
  ["runtime entry", "createOpen", false],
  ["runtime entry", "createOpen", true],
])(
  "does not revive create navigation after a newer %s / %s intent (dismissed: %s)",
  async (phase, dialog, dismissed) => {
    const { c, list, enter, push } = await panel(
      vi.fn().mockResolvedValue({ id: room.id }),
    );
    let finish!: () => void;
    if (phase === "list reload") {
      list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve([room]);
          }),
      );
    } else {
      enter.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    }
    const pending = c.submitCreate();
    await vi.waitFor(() =>
      expect(phase === "list reload" ? list : enter).toHaveBeenCalledTimes(
        phase === "list reload" ? 2 : 1,
      ),
    );
    c[dialog].value = true;
    if (dialog === "joinOpen") c.pasted.value = "New invitation draft";
    else c.name.value = "New room draft";
    if (dismissed) c[dialog].value = false;
    await nextTick();
    finish();
    await pending;
    expect(push).not.toHaveBeenCalled();
    expect(c[dialog].value).toBe(!dismissed);
    if (!dismissed)
      expect(dialog === "joinOpen" ? c.pasted.value : c.name.value).toBe(
        dialog === "joinOpen" ? "New invitation draft" : "New room draft",
      );
    if (phase === "list reload") expect(enter).not.toHaveBeenCalled();
  },
);

it("keeps post-create list failures separate without submitting the room again", async () => {
  const create = vi.fn().mockResolvedValue({ id: room.id });
  const { c, list, push } = await panel(create);
  list.mockRejectedValueOnce(Error("列表加载失败"));
  await c.submitCreate();
  expect(c.createOpen.value).toBe(false);
  expect(c.name.value).toBe("");
  expect(c.loadError.value).toBe("列表加载失败");
  expect(c.error.value).toBe("");
  expect(push).not.toHaveBeenCalled();
  await c.reload();
  expect(create).toHaveBeenCalledOnce();
  expect(c.loadError.value).toBe("");
});

it("keeps room validation local and preserves the invalid draft", async () => {
  const create = vi.fn();
  const { c } = await panel(create);
  c.name.value = "   ";
  await c.submitCreate();
  expect(create).not.toHaveBeenCalled();
  expect(c.name.value).toBe("   ");
  expect(c.createOpen.value).toBe(true);
  expect(c.error.value).toBe("房间名称须为1–120个字符");
  expect(c.busy.value).toBe(false);
});

it("binds the room name to pending state and submits through the guard", () => {
  const template = parse(
    readFileSync(
      new URL("../apps/web/src/features/rooms/RoomsPage.vue", import.meta.url),
      "utf8",
    ),
  ).descriptor.template!;
  const elements: any[] = [];
  function visit(node: any) {
    if (node.type === 1) elements.push(node);
    node.children?.forEach(visit);
  }
  visit(template.ast);
  const input = elements.find(
    (node) =>
      node.tag === "input" &&
      node.props.some(
        (prop: any) => prop.name === "model" && prop.exp?.content === "name",
      ),
  );
  expect(
    input.props.find(
      (prop: any) => prop.name === "bind" && prop.arg?.content === "disabled",
    )?.exp?.content,
  ).toBe("busy");
  const form = elements.find((node) => node.tag === "form");
  expect(
    form.props.find(
      (prop: any) => prop.name === "on" && prop.arg?.content === "submit",
    )?.exp?.content,
  ).toBe("submitCreate");
});
