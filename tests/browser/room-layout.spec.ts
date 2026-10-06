import { test, expect } from "@playwright/test";
import {
  button,
  canvas,
  dragBy,
  enterLayoutRoom,
  expectNoHorizontalOverflow,
  expectPlaybackUnchanged,
  expectPlayerAligned,
  expectReachable,
  geometry,
  layoutKey,
  rememberPlayback,
  roomLayoutFixture,
  visibleLayout,
  widget,
  widgetTypes,
} from "./fixtures/room-layout";

const hide = (
  page: import("@playwright/test").Page,
  type: Parameters<typeof widget>[1],
) => widget(page, type).getByRole("button", { name: /^隐藏/ });
const move = (
  page: import("@playwright/test").Page,
  type: Parameters<typeof widget>[1],
) => widget(page, type).getByRole("button", { name: /^移动/ });
const resize = (
  page: import("@playwright/test").Page,
  type: Parameters<typeof widget>[1],
) =>
  widget(page, type).getByRole("button", { name: /^调整(?!.*位置和).*大小$/ });

async function addHiddenChat(page: import("@playwright/test").Page) {
  await button(page, "添加组件").click();
  const catalog = page.getByRole("dialog", { name: "添加组件", exact: true });
  await expect(catalog).toBeVisible();
  await catalog.getByRole("button", { name: /^添加.*聊天/ }).click();
  // The catalog may remain open to add several different widgets.
  if (await catalog.isVisible()) await page.keyboard.press("Escape");
  await expect(widget(page, "chat")).toBeVisible();
}

test("default room has six real widgets in the approved wide composition", async ({
  page,
}, info) => {
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  for (const type of widgetTypes)
    await expect(widget(page, type)).toBeVisible();
  expect(await visibleLayout(page)).toHaveLength(6);
  await expect(widget(page, "room-info")).toContainText("周末放映室");
  await expect(widget(page, "media-info")).toContainText("真实合成测试视频");
  await expect(widget(page, "chat")).toContainText("暂无消息");
  const room = await geometry(widget(page, "room-info"));
  const player = await geometry(widget(page, "player"));
  const media = await geometry(widget(page, "media-info"));
  const chat = await geometry(widget(page, "chat"));
  const queue = await geometry(widget(page, "queue"));
  const members = await geometry(widget(page, "members"));
  expect(room.y + room.h).toBeLessThanOrEqual(player.y);
  expect(media.y).toBeGreaterThanOrEqual(player.y + player.h);
  expect(chat.x).toBeGreaterThanOrEqual(player.x + player.w);
  expect(queue.y).toBeGreaterThanOrEqual(media.y + media.h);
  expect(queue.x + queue.w).toBeLessThanOrEqual(members.x);
  await expect(button(page, "编辑布局")).toBeVisible();
  await expect(hide(page, "chat")).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await rememberPlayback(page, app);
  expect(app.errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("room-layout-default-wide.png"),
    fullPage: true,
  });
});

test("populated queue and reported members stay useful in the compact default layout", async ({
  page,
}, info) => {
  const app = await roomLayoutFixture(page, { history: 3 });
  const next = app.media[1];
  await page.route("**/api/v1/rooms/room/playlist", (route) =>
    route.fulfill({
      json: [
        {
          id: "next-queue-item",
          media_id: next.id,
          title: next.title,
          cover: next.cover,
        },
      ],
    }),
  );
  await enterLayoutRoom(page);
  app.socket()!.send(
    JSON.stringify({
      type: "SNAPSHOT",
      state: app.state,
      control_epoch: { id: "control", expires_at_ms: Date.now() + 3600000 },
      presence_connection_id: "layout-presence-connection",
      presence: {
        room_id: "room",
        presence_epoch: "layout-presence",
        presence_seq: 1,
        members: [{ user_id: "owner", connection_count: 1 }],
      },
    }),
  );
  await expect(widget(page, "members")).toContainText("放映用户");
  await expect(widget(page, "members")).toContainText("1 位成员已上报在线状态");
  const queue = widget(page, "queue");
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(canvas(page)).toHaveAttribute(
      "data-layout-breakpoint",
      "wide",
    );
    await queue.scrollIntoViewIfNeeded();
    await expect(
      queue.getByRole("heading", { name: next.title, exact: true }),
    ).toBeVisible();
    const play = queue.getByRole("button", {
      name: `播放 ${next.title}`,
      exact: true,
    });
    await page.screenshot({
      path: info.outputPath(`room-layout-populated-${width}.png`),
      fullPage: true,
    });
    for (const content of [
      queue.locator(".queue-row .media-thumbnail"),
      queue.locator(".queue-row h3"),
      play,
    ]) {
      expect(
        await content.evaluate((element) => {
          const body = element
            .closest(".room-widget__body")!
            .getBoundingClientRect();
          const rect = element.getBoundingClientRect();
          return rect.top >= body.top - 1 && rect.bottom <= body.bottom + 1;
        }),
      ).toBe(true);
    }
    await expectReachable(play);
    expect(
      await queue
        .locator(".room-widget__body")
        .evaluate((element) => element.scrollTop),
    ).toBe(0);
  }
  expect(app.errors).toEqual([]);
});

test("empty room still offers every component and essential room actions", async ({
  page,
}, info) => {
  const app = await roomLayoutFixture(page, { empty: true });
  await enterLayoutRoom(page);
  for (const type of widgetTypes)
    await expect(widget(page, type)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "开始一起观看" }),
  ).toBeVisible();
  await expectReachable(button(page, "离开观看"));
  await expectReachable(button(page, "房间管理"));
  await expect(
    page.getByRole("link", { name: "选择影片", exact: true }),
  ).toBeVisible();
  await button(page, "编辑布局").click();
  for (const type of widgetTypes.filter((type) => type !== "player"))
    await hide(page, type).click();
  await button(page, "完成").click();
  await expectReachable(button(page, "离开观看"));
  await expectReachable(button(page, "房间管理"));
  await button(page, "房间管理").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "关闭房间", exact: true }),
  ).toBeVisible();
  expect(app.preparations()).toBe(0);
  expect(app.commands).toEqual([]);
  expect(app.errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("room-layout-empty-management.png"),
    fullPage: true,
  });
});

test("hide, add, undo, redo and cancel are a local reversible draft", async ({
  page,
}) => {
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  const baseline = await visibleLayout(page);
  const playback = await rememberPlayback(page, app);
  await button(page, "编辑布局").click();
  await expect(button(page, "撤销")).toBeDisabled();
  await expect(button(page, "重做")).toBeDisabled();
  const playerHide = hide(page, "player");
  if (await playerHide.count()) await expect(playerHide).toBeDisabled();
  await hide(page, "chat").click();
  await expect(widget(page, "chat")).toBeHidden();
  await button(page, "撤销").click();
  await expect(widget(page, "chat")).toBeVisible();
  await button(page, "重做").click();
  await expect(widget(page, "chat")).toBeHidden();
  await addHiddenChat(page);
  await expect(canvas(page).locator('[data-widget-type="chat"]')).toHaveCount(
    1,
  );
  await hide(page, "queue").click();
  await button(page, "取消").click();
  await expect(button(page, "编辑布局")).toBeVisible();
  expect(await visibleLayout(page)).toEqual(baseline);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), layoutKey()),
  ).toBeNull();
  await expectPlaybackUnchanged(page, app, playback);
});

test("viewers can personalize locally without gaining room control permissions", async ({
  page,
}) => {
  const app = await roomLayoutFixture(page, { admin: false });
  app.room.owner_id = "another-owner";
  app.state.controller_user_id = "another-owner";
  await enterLayoutRoom(page);
  const playback = await rememberPlayback(page, app);
  const writes = [...app.writes];
  await button(page, "编辑布局").click();
  await hide(page, "chat").click();
  await button(page, "完成").click();
  await expect(widget(page, "chat")).toBeHidden();
  await expect(button(page, "邀请")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "选择影片", exact: true }),
  ).toHaveCount(0);
  expect(app.writes).toEqual(writes);
  await expectPlaybackUnchanged(page, app, playback);
});

test("done persists geometry only and reset is cancelable before saving", async ({
  page,
}) => {
  await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  const baseline = await visibleLayout(page);
  await page
    .getByLabel("聊天消息", { exact: true })
    .fill("PRIVATE_DRAFT_NOT_LAYOUT_DATA");
  await button(page, "编辑布局").click();
  await hide(page, "chat").click();
  await button(page, "完成").click();
  const raw = await page.evaluate(
    (key) => localStorage.getItem(key),
    layoutKey(),
  );
  expect(raw).not.toBeNull();
  const saved = JSON.parse(raw!);
  expect(Object.keys(saved).sort()).toEqual(["breakpoint", "items", "version"]);
  expect(saved.breakpoint).toBe("wide");
  expect(saved.items).toHaveLength(5);
  for (const item of saved.items)
    expect(Object.keys(item).sort()).toEqual([
      "h",
      "id",
      "type",
      "w",
      "x",
      "y",
    ]);
  expect(raw).not.toMatch(
    /PRIVATE_DRAFT|fixture-video|csrf|token|media_id|messages/,
  );
  await page.reload();
  await expect(widget(page, "chat")).toBeHidden();
  await button(page, "编辑布局").click();
  await button(page, "恢复默认").click();
  await expect(widget(page, "chat")).toBeVisible();
  await button(page, "取消").click();
  await expect(widget(page, "chat")).toBeHidden();
  await button(page, "编辑布局").click();
  await button(page, "恢复默认").click();
  await button(page, "完成").click();
  await page.reload();
  await expect(widget(page, "chat")).toBeVisible();
  expect(await visibleLayout(page)).toEqual(baseline);
});

test("keyboard movement and player resizing remain undoable without playback work", async ({
  page,
}) => {
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  const playback = await rememberPlayback(page, app);
  await button(page, "编辑布局").click();
  const originalMember = await geometry(widget(page, "members"));
  await move(page, "members").focus();
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => geometry(widget(page, "members")))
    .not.toEqual(originalMember);
  await button(page, "撤销").click();
  expect(await geometry(widget(page, "members"))).toEqual(originalMember);
  const originalPlayer = await geometry(widget(page, "player"));
  await resize(page, "player").focus();
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => (await geometry(widget(page, "player"))).w)
    .toBeLessThan(originalPlayer.w);
  const video = await page.locator("video").boundingBox();
  expect(video).not.toBeNull();
  expect(video!.width / video!.height).toBeCloseTo(16 / 9, 1);
  await expectPlayerAligned(page);
  await button(page, "撤销").click();
  expect(await geometry(widget(page, "player"))).toEqual(originalPlayer);
  await button(page, "完成").click();
  await expectPlaybackUnchanged(page, app, playback);
});

test("every narrower player width keeps an exact inner frame while outer rows round", async ({
  page,
}) => {
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  const playback = await rememberPlayback(page, app);
  await button(page, "编辑布局").click();
  await resize(page, "player").focus();
  for (let width = 17; width >= 8; width--) {
    await test.step(`player width ${width}`, async () => {
      await page.keyboard.press("ArrowLeft");
      await expect
        .poll(async () => (await geometry(widget(page, "player"))).w)
        .toBe(width);
      await expectPlayerAligned(page);
      const outer = (await widget(page, "player").boundingBox())!;
      const inner = (await page.locator(".room-player-anchor").boundingBox())!;
      expect(inner.height).toBeLessThanOrEqual(outer.height + 1);
    });
  }
  await button(page, "取消").click();
  await expectPlaybackUnchanged(page, app, playback);
});

test("explicit adjustment controls work without dragging and reject overlapping moves", async ({
  page,
}) => {
  await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  await button(page, "编辑布局").click();
  const member = widget(page, "members");
  const before = await geometry(member);
  await member
    .getByRole("button", { name: "调整在线成员位置和大小", exact: true })
    .click();
  await member.getByRole("button", { name: "下移", exact: true }).click();
  await expect
    .poll(async () => (await geometry(member)).y)
    .toBeGreaterThan(before.y);
  await member.getByRole("button", { name: "增加高度", exact: true }).click();
  await expect
    .poll(async () => (await geometry(member)).h)
    .toBeGreaterThan(before.h);
  await button(page, "取消").click();
  await button(page, "编辑布局").click();
  const original = await geometry(widget(page, "player"));
  await move(page, "player").focus();
  await page.keyboard.press("ArrowRight");
  expect(await geometry(widget(page, "player"))).toEqual(original);
  await expect(canvas(page).locator("[data-widget-type]")).toHaveCount(6);
  await expect(
    page.getByRole("status").filter({ hasText: "空间不足或与其他组件重叠" }),
  ).toBeAttached();
  await expect(button(page, "撤销")).toBeDisabled();
  await button(page, "取消").click();
});

test("pointer drag and resize commit once, with Escape canceling a pending gesture", async ({
  page,
  isMobile,
}) => {
  test.skip(
    isMobile,
    "Desktop pointer sequence; mobile has the keyboard and explicit adjustment controls",
  );
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  const playback = await rememberPlayback(page, app);
  await button(page, "编辑布局").click();
  const baseline = await visibleLayout(page);
  const members = await geometry(widget(page, "members"));
  await dragBy(page, move(page, "members"), 0, 100);
  await expect
    .poll(() => geometry(widget(page, "members")))
    .not.toEqual(members);
  await button(page, "撤销").click();
  expect(await visibleLayout(page)).toEqual(baseline);
  await expect(button(page, "撤销")).toBeDisabled();
  const player = await geometry(widget(page, "player"));
  await dragBy(page, resize(page, "player"), -100, 0);
  await expect
    .poll(async () => (await geometry(widget(page, "player"))).w)
    .toBeLessThan(player.w);
  await button(page, "撤销").click();
  expect(await geometry(widget(page, "player"))).toEqual(player);
  const handle = move(page, "members");
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120, {
    steps: 4,
  });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await visibleLayout(page)).toEqual(baseline);
  await button(page, "取消").click();
  await expectPlaybackUnchanged(page, app, playback);
});

test("chat DOM, unsent text, history and scroll survive hiding and layout operations", async ({
  page,
}) => {
  const app = await roomLayoutFixture(page, { history: 70 });
  await enterLayoutRoom(page);
  const playback = await rememberPlayback(page, app);
  const input = page.getByLabel("聊天消息", { exact: true });
  await expect(
    page.getByRole("log", { name: "聊天记录" }).locator(".chat-message"),
  ).toHaveCount(70);
  await input.fill("这条草稿还没有发送");
  await page.getByRole("log", { name: "聊天记录" }).evaluate((element) => {
    element.scrollTop = 150;
    element.dispatchEvent(new Event("scroll"));
    (window as any).__roomLayoutChat = { element, top: element.scrollTop };
  });
  await button(page, "编辑布局").click();
  await hide(page, "chat").click();
  await expect(widget(page, "chat")).toBeHidden();
  await button(page, "撤销").click();
  await expect(input).toHaveValue("这条草稿还没有发送");
  await hide(page, "chat").click();
  await addHiddenChat(page);
  await button(page, "取消").click();
  await expect(input).toHaveValue("这条草稿还没有发送");
  expect(
    await page.getByRole("log", { name: "聊天记录" }).evaluate((element) => ({
      same: element === (window as any).__roomLayoutChat.element,
      top: element.scrollTop,
      saved: (window as any).__roomLayoutChat.top,
    })),
  ).toMatchObject({ same: true, top: 150, saved: 150 });
  expect(app.history).toHaveLength(70);
  await expectPlaybackUnchanged(page, app, playback);
});

test("saved layouts are independent for users and wide versus narrow screens", async ({
  page,
}) => {
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  await button(page, "编辑布局").click();
  await hide(page, "chat").click();
  await button(page, "完成").click();
  const wide = await page.evaluate(
    (key) => localStorage.getItem(key),
    layoutKey(),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(widget(page, "chat")).toBeVisible();
  await button(page, "编辑布局").click();
  await hide(page, "members").click();
  await button(page, "完成").click();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), layoutKey()),
  ).toBe(wide);
  const narrow = await page.evaluate(
    (key) => localStorage.getItem(key),
    layoutKey("owner", "narrow"),
  );
  expect(
    JSON.parse(narrow!).items.some(
      (item: { type: string }) => item.type === "chat",
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(widget(page, "chat")).toBeHidden();
  await expect(widget(page, "members")).toBeVisible();
  app.signIn({ id: "second-user", username: "second-user" });
  await page.reload();
  await expect(widget(page, "chat")).toBeVisible();
  await button(page, "编辑布局").click();
  await hide(page, "queue").click();
  await button(page, "完成").click();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), layoutKey()),
  ).toBe(wide);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      layoutKey("second-user"),
    ),
  ).not.toBeNull();
  app.signIn({ id: "owner", username: "owner" });
  await page.reload();
  await expect(widget(page, "chat")).toBeHidden();
  await expect(widget(page, "queue")).toBeVisible();
  expect(app.errors).toEqual([]);
});

for (const [kind, value] of [
  ["invalid JSON", '{"version":'],
  ["oversized document", "x".repeat(17000)],
  [
    "unsupported version",
    JSON.stringify({ version: 999, breakpoint: "wide", items: [] }),
  ],
] as const) {
  test(`${kind} falls back visibly without silently overwriting stored data`, async ({
    page,
  }) => {
    const app = await roomLayoutFixture(page);
    await enterLayoutRoom(page);
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: layoutKey(),
      value,
    });
    await page.reload();
    for (const type of widgetTypes)
      await expect(widget(page, type)).toBeVisible();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(
      await page.evaluate((key) => localStorage.getItem(key), layoutKey()),
    ).toBe(value);
    await button(page, "编辑布局").click();
    if (kind === "unsupported version") {
      await hide(page, "chat").click();
      await button(page, "完成").click();
      await expect(button(page, "取消")).toBeVisible();
      expect(
        await page.evaluate((key) => localStorage.getItem(key), layoutKey()),
      ).toBe(value);
    }
    await button(page, "恢复默认").click();
    await button(page, "完成").click();
    await page.reload();
    await expect(widget(page, "chat")).toBeVisible();
    expect(
      JSON.parse(
        (await page.evaluate((key) => localStorage.getItem(key), layoutKey()))!,
      ).version,
    ).toBe(1);
    expect(app.errors).toEqual([]);
  });
}

test("storage failures retain draft and let the user cancel safely", async ({
  page,
}) => {
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  const baseline = await visibleLayout(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("rainsync:room-layout:"))
        throw new DOMException("Quota full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await button(page, "编辑布局").click();
  await hide(page, "chat").click();
  await button(page, "完成").click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(button(page, "取消")).toBeVisible();
  await expect(widget(page, "chat")).toBeHidden();
  await button(page, "取消").click();
  expect(await visibleLayout(page)).toEqual(baseline);
  expect(app.errors).toEqual([]);
});

test("six viewport widths and 200 percent equivalent reflow preserve playback and controls", async ({
  page,
}, info) => {
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  const playback = await rememberPlayback(page, app);
  // 720 CSS pixels also exercises 1440px desktop at 200% browser zoom reflow.
  for (const width of [360, 390, 720, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const type of widgetTypes)
      await expect(widget(page, type)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectPlayerAligned(page);
    await expectReachable(button(page, "编辑布局"));
    await expectReachable(button(page, "离开观看"));
    await expectPlaybackUnchanged(page, app, playback);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await button(page, "编辑布局").click();
  await expectReachable(button(page, "完成"));
  await expectReachable(button(page, "取消"));
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: info.outputPath("room-layout-narrow-edit.png"),
    fullPage: true,
  });
});

test("narrow reordering is keyboard accessible and independent of wide geometry", async ({
  page,
}) => {
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page, 390);
  const playback = await rememberPlayback(page, app);
  await button(page, "编辑布局").click();
  const before = await geometry(widget(page, "chat"));
  await move(page, "chat").focus();
  await page.keyboard.press("ArrowUp");
  await expect
    .poll(async () => (await geometry(widget(page, "chat"))).y)
    .toBeLessThan(before.y);
  await button(page, "撤销").click();
  expect(await geometry(widget(page, "chat"))).toEqual(before);
  await button(page, "取消").click();
  await expectPlaybackUnchanged(page, app, playback);
});

test("narrow edit headers leave room and media content readable", async ({
  page,
}, info) => {
  await roomLayoutFixture(page);
  await enterLayoutRoom(page, 390);
  await button(page, "编辑布局").click();
  for (const [type, heading, detail] of [
    ["room-info", ".room-information-widget h1", ".room-presence-summary"],
    ["media-info", ".room-media-widget h2", ".room-media-widget .helper"],
  ] as const) {
    const frame = widget(page, type);
    for (const selector of [heading, detail]) {
      const content = frame.locator(selector);
      await content.scrollIntoViewIfNeeded();
      const bounds = await content.evaluate((element) => {
        const body = element.closest(".room-widget__body")!;
        const header = element
          .closest(".room-widget")
          ?.querySelector(".room-widget__header");
        const rect = element.getBoundingClientRect(),
          clip = body.getBoundingClientRect();
        return {
          readableHeight: body.clientHeight >= 36,
          inBody: rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1,
          belowHeader:
            !header || rect.top >= header.getBoundingClientRect().bottom - 1,
        };
      });
      expect(bounds).toEqual({
        readableHeight: true,
        inBody: true,
        belowHeader: true,
      });
    }
  }
  await expectPlayerAligned(page);
  await page.screenshot({
    path: info.outputPath("room-layout-narrow-readable-edit.png"),
    fullPage: true,
  });
});

test("fullscreen exit restores the anchor rectangle without replacing or reloading media", async ({
  page,
  isMobile,
}) => {
  test.skip(
    isMobile,
    "Standard desktop fullscreen API; mobile reflow and media identity are tested separately",
  );
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  const playback = await rememberPlayback(page, app);
  await expectPlayerAligned(page);
  await page.locator("video").hover();
  await button(page, "进入全屏").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.fullscreenElement?.classList.contains("playback-host"),
      ),
    )
    .toBe(true);
  await expect(page.locator("video")).toHaveCSS("object-fit", "contain");
  await button(page, "退出全屏").click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
  await expectPlayerAligned(page);
  await expectPlaybackUnchanged(page, app, playback);
});

test("fullscreen keeps unrelated room errors and dismissal reachable", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Standard desktop fullscreen API");
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  const playback = await rememberPlayback(page, app);
  await page.locator("video").hover();
  await button(page, "进入全屏").click();
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  app.socket()!.send(
    JSON.stringify({
      type: "ERROR",
      error: {
        code: "FORBIDDEN",
        message: "测试播放控制权限已失效",
        retryable: false,
      },
    }),
  );
  const host = page.locator(".playback-host");
  const notice = host
    .getByRole("alert")
    .filter({ hasText: "测试播放控制权限已失效" });
  await expect(notice).toBeVisible();
  await expect(notice).toBeInViewport();
  await expectReachable(
    notice.getByRole("button", { name: "关闭提示", exact: true }),
  );
  await notice.getByRole("button", { name: "关闭提示", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await page.locator("video").hover();
  await button(page, "退出全屏").click();
  await expectPlayerAligned(page);
  await expectPlaybackUnchanged(page, app, playback);
});

test("layout editing makes playback controls inert to pointer and keyboard input", async ({
  page,
}) => {
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  const playback = await rememberPlayback(page, app);
  await button(page, "编辑布局").click();
  const host = page.locator(".playback-host");
  await expect(host).toHaveAttribute("inert", "");
  const video = (await page.locator("video").boundingBox())!;
  await page.mouse.click(video.x + video.width / 2, video.y + video.height / 2);
  await button(page, "添加组件").focus();
  for (let index = 0; index < 25; index++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () => !!document.activeElement?.closest(".playback-host"),
      ),
    ).toBe(false);
  }
  await move(page, "player").focus();
  await page.keyboard.press("Space");
  await button(page, "取消").click();
  await expect(host).not.toHaveAttribute("inert", "");
  await expectPlaybackUnchanged(page, app, playback);
});

test("management request failures are readable inside the open management drawer", async ({
  page,
}) => {
  const app = await roomLayoutFixture(page);
  await enterLayoutRoom(page);
  await page.route("**/api/v1/rooms/room/members", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "FIXTURE_MEMBER_UNAVAILABLE",
          message: "测试成员列表暂时不可用",
        },
      },
    }),
  );
  await button(page, "房间管理").click();
  const dialog = page.getByRole("dialog", { name: "房间管理", exact: true });
  await dialog.getByRole("button", { name: "转让房间", exact: true }).click();
  const error = dialog.getByRole("alert");
  await expect(error).toContainText("测试成员列表暂时不可用");
  await expect(error).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expectReachable(button(page, "离开观看"));
  expect(app.commands).toEqual([]);
  expect(app.errors).toEqual([]);
});

for (const motion of ["no-preference", "reduce"] as const) {
  test(`router return preserves media and final geometry with ${motion} motion`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: motion });
    const app = await roomLayoutFixture(page);
    await enterLayoutRoom(page);
    const playback = await rememberPlayback(page, app);
    await button(page, "编辑布局").click();
    await hide(page, "members").click();
    await button(page, "完成").click();
    await page
      .getByRole("link", { name: "媒体库", exact: true })
      .filter({ visible: true })
      .click();
    await expect(page.locator(".playback-host")).toHaveClass(/mini/);
    await button(page, "返回房间")
      .or(page.getByRole("link", { name: "返回房间", exact: true }))
      .click();
    await expect(widget(page, "members")).toBeHidden();
    await expectPlayerAligned(page);
    await expectPlaybackUnchanged(page, app, playback);
  });
}
