import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";

async function sameVideo(page: import("@playwright/test").Page) {
  expect(
    await page.evaluate(
      () =>
        (window as any).__firstRoundVideo === document.querySelector("video"),
    ),
  ).toBe(true);
}

test("empty rooms keep common actions and independent widgets visible at every width", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  app.state.media_id = null as any;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/rooms/room");
  await expect(
    page.getByRole("heading", { name: "开始一起观看" }),
  ).toBeVisible();
  const actions = page.locator(".room-permanent-actions");
  await expect(
    actions.getByRole("button", { name: "邀请", exact: true }),
  ).toBeInViewport();
  const opening = await page.locator(".room-command-bar").boundingBox();
  expect(opening?.y).toBeLessThan(350);
  await page.evaluate(() => {
    (window as any).__firstRoundVideo = document.querySelector("video");
  });
  // Independent widgets replace the former mutually exclusive chat/queue tabs.
  for (const width of [768, 1024, 1279]) {
    await page.setViewportSize({ width, height: 768 });
    await expect(page.locator("#room-chat")).toBeVisible();
    await expect(page.locator("#room-queue")).toBeVisible();
    await expect(
      actions.getByRole("button", { name: "邀请", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".room-platform-import")).toBeHidden();
  }
  await actions.getByRole("button", { name: "粘贴平台链接" }).click();
  await expect(
    page.getByRole("dialog", { name: "添加平台视频" }),
  ).toBeVisible();
  await expect(page.getByLabel("视频链接或分享文字")).toBeFocused();
  await expect(page.locator("#room-queue")).toBeVisible();
  await expect(page.locator(".room-platform-import")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "添加平台视频" })).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("#room-chat")).toBeVisible();
  await expect(page.locator("#room-queue")).toBeVisible();
  await sameVideo(page);
  expect(app.connections()).toBe(1);
  expect(app.preparations()).toBe(0);
  expect(app.commands).toEqual([]);
  expect(app.errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("empty-room-desktop.png"),
    fullPage: true,
  });
});

test("viewers in an empty room receive the waiting explanation without selection or invitation actions", async ({
  page,
}) => {
  const app = await appFixture(page, { admin: false });
  app.room.owner_id = "another-owner";
  app.state.controller_user_id = "another-owner";
  app.state.media_id = null as any;
  await page.goto("/rooms/room");
  await expect(
    page.getByText("等待有控制权限的成员选择影片，你可以先在聊天中交流。"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "选择影片", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "粘贴平台链接", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "邀请", exact: true }),
  ).toHaveCount(0);
  expect(app.preparations()).toBe(0);
  expect(app.errors).toEqual([]);
});

test("empty room return entry stays in document flow on short NAS views and preserves the player", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  app.state.media_id = null as any;
  await page.setViewportSize({ width: 590, height: 378 });
  await page.goto("/rooms/room");
  await expect(page.locator(".playback-host")).toHaveClass(/empty-room/);
  await page.evaluate(() => {
    (window as any).__firstRoundVideo = document.querySelector("video");
  });
  await page.getByRole("link", { name: "管理", exact: true }).click();
  await page
    .getByRole("navigation", { name: "管理导航" })
    .getByRole("link", { name: "NAS 设备", exact: true })
    .click();
  const host = page.locator(".playback-host");
  await expect(host).toHaveClass(/empty-room/);
  await expect(host).toHaveCSS("position", "static");
  await expect(
    page.getByRole("link", { name: "返回房间", exact: true }),
  ).toBeVisible();
  const add = page.getByRole("button", { name: "添加设备", exact: true });
  await add.scrollIntoViewIfNeeded();
  expect(
    await add.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      return hit === element || element.contains(hit);
    }),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("empty-room-nas-short.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "返回房间", exact: true }).click();
  await sameVideo(page);
  expect(app.connections()).toBe(1);
  expect(app.preparations()).toBe(0);
  expect(app.errors).toEqual([]);
});

test("editing or failing invitation parsing cannot submit credentials from an earlier invite", async ({
  page,
}) => {
  await appFixture(page);
  const joins: unknown[] = [];
  await page.route("**/rooms/*/join", async (route) => {
    joins.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/rooms");
  await page.getByRole("button", { name: "通过邀请加入", exact: true }).click();
  const pasted = page.getByLabel("粘贴完整房间邀请");
  await pasted.fill(
    JSON.stringify({ room_id: "old-room", token: "old-token" }),
  );
  await page.getByRole("button", { name: "解析邀请", exact: true }).click();
  await expect(page.getByLabel("房间 ID")).toHaveValue("old-room");
  await expect(page.getByLabel("邀请 token")).toHaveValue("old-token");
  await pasted.fill('{"room_id":');
  await expect(page.getByLabel("房间 ID")).toHaveValue("");
  await expect(page.getByLabel("邀请 token")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "加入房间", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "解析邀请", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("请粘贴完整房间邀请JSON");
  expect(joins).toEqual([]);
  await pasted.fill("null");
  await page.getByRole("button", { name: "解析邀请", exact: true }).click();
  await expect(page.getByLabel("邀请 token")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "加入房间", exact: true }),
  ).toBeDisabled();
});

test("a collapsed player retains local mute and full-screen controls name their next action", async ({
  page,
  isMobile,
}) => {
  const app = await appFixture(page);
  await page.setViewportSize({ width: 1024, height: 480 });
  await page.goto("/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.evaluate(() => {
    (window as any).__firstRoundVideo = document.querySelector("video");
  });
  await page
    .getByRole("link", { name: "媒体库", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.locator(".playback-host")).toHaveClass(/mini-collapsed/);
  const mute = page.getByRole("button", { name: "本机静音", exact: true });
  await expect(mute).toBeVisible();
  await mute.click();
  expect(
    await page
      .locator("video")
      .evaluate((video: HTMLVideoElement) => video.muted),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "取消本机静音", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "播放房间", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "返回房间", exact: true }).click();
  if (!isMobile) {
    await page.locator("video").hover();
    await page.getByRole("button", { name: "进入全屏", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "退出全屏", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
  }
  await sameVideo(page);
  expect(app.connections()).toBe(1);
  expect(app.preparations()).toBe(1);
  expect(app.errors).toEqual([]);
});
