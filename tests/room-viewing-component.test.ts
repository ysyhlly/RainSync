import { afterEach, expect, it } from "vitest";
import { nextTick, shallowRef, useId } from "vue";
import { readFileSync } from "node:fs";
import { parse } from "@vue/compiler-sfc";
import { mountSetup } from "./helpers/mount-setup";
import * as model from "../apps/web/src/features/room-layout/layout-model";
import * as geometry from "../apps/web/src/features/room-layout/layout-geometry";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
it("presents existing player/chat frames without changing custom geometry or frame identity", async () => {
  const layout = model.createDefaultLayout("wide");
  layout.items = layout.items.filter((item) => item.type !== "chat");
  const original = JSON.stringify(layout);
  const p = mountSetup(
    new URL(
      "../apps/web/src/features/room-layout/RoomLayoutCanvas.vue",
      import.meta.url,
    ),
    {
      ...model,
      ...geometry,
      shallowRef,
      useId,
      RoomWidgetFrame: {},
      window: { removeEventListener() {} },
    },
    { layout, editing: false, viewing: false, chatVisible: true },
  );
  cleanup.push(p.unmount);
  const c = p.controls;
  const frames = c.frames.value;
  const player = frames.find((item: any) => item.type === "player");
  const chat = frames.find((item: any) => item.type === "chat");
  expect(c.frameVisible(chat)).toBe(false);
  const playerStyle = c.frameStyle(player);
  p.setProps({ viewing: true });
  await nextTick();
  expect(c.frames.value).toBe(frames);
  expect(c.frameVisible(player)).toBe(true);
  expect(c.frameVisible(chat)).toBe(true);
  expect(frames.filter((item: any) => c.frameVisible(item))).toHaveLength(2);
  expect(c.frameStyle(player)).toEqual({});
  expect(c.canvasStyle.value).toEqual({});
  p.setProps({ chatVisible: false });
  await nextTick();
  expect(c.frameVisible(chat)).toBe(false);
  p.setProps({ viewing: false });
  await nextTick();
  expect(c.frames.value).toBe(frames);
  expect(c.frameStyle(player)).toEqual(playerStyle);
  expect(JSON.stringify(layout)).toBe(original);
});
it("keeps one retained chat and anchor; hides frames through v-show with effective visibility", () => {
  const source = readFileSync(
    new URL(
      "../apps/web/src/features/room-layout/RoomLayoutCanvas.vue",
      import.meta.url,
    ),
    "utf8",
  );
  const template = parse(source).descriptor.template!.content;
  expect(template).toContain('v-show="frameVisible(item)"');
  expect(template).toContain(':visible="frameVisible(item)"');
  expect(template).toContain(':key="item.id"');
  const page = readFileSync(
    new URL("../apps/web/src/features/rooms/RoomPage.vue", import.meta.url),
    "utf8",
  );
  expect(page.match(/<ChatPanel /g)).toHaveLength(1);
  expect(page.match(/<RoomPlayerAnchor/g)).toHaveLength(1);
  expect(page).toContain('document.querySelector("dialog[open]")');
});
