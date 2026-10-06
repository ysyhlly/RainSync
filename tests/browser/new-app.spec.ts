import { test, expect } from "@playwright/test";
import { appFixture, appBase } from "./fixtures/application";

test("new entry keeps one video and connection through library navigation and same-room return", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  await page.goto(appBase + "/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.evaluate(() => {
    (window as any).__originalVideo = document.querySelector("video");
  });
  const before = app.preparations();
  await page
    .getByRole("link", { name: "媒体库", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.locator(".mini-player")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "媒体库", exact: true }),
  ).toBeVisible();
  await page.getByLabel("搜索影片").fill("不存在");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByText("没有找到匹配影片")).toBeVisible();
  await expect(page.locator(".mini-player h2")).toHaveText("真实合成测试视频");
  await page.getByRole("link", { name: "返回房间" }).click();
  expect(
    await page.evaluate(
      () => (window as any).__originalVideo === document.querySelector("video"),
    ),
  ).toBe(true);
  expect(app.connections()).toBe(1);
  expect(app.preparations()).toBe(before);
  await expect(page.locator("video")).toHaveCount(1);
  await page.getByLabel("聊天消息").fill("昵称消息");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("昵称消息", { exact: true })).toBeVisible();
  await expect(page.locator(".chat-message b")).toHaveText("放映用户");
  expect(app.errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("new-room.png"),
    fullPage: true,
  });
});

test("library pages use bounded cursors and server search without invented metadata", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.goto(appBase + "/library");
  await expect(page.locator(".media-card")).toHaveCount(24);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".media-card")).toHaveCount(6);
  expect(app.searches.some((s) => s.includes("after=movie-23"))).toBe(true);
  await page.getByLabel("搜索影片").fill("测试影片 29");
  await page.getByLabel("搜索影片").press("Enter");
  await expect(page.locator(".media-card")).toHaveCount(1);
  await expect(page.getByText("第 1 页 · 本页 1 部")).toBeVisible();
  expect(app.searches.at(-1)).not.toContain("after=");
  await expect(page.locator(".media-card .media-thumbnail")).toHaveCount(1);
  expect(app.errors).toEqual([]);
});

test("login restores safe local navigation and ordinary accounts cannot open admin pages", async ({
  page,
}) => {
  await appFixture(page, { admin: false, loggedIn: false });
  await page.goto(appBase + "/library");
  await expect(
    page.getByRole("heading", { name: "登录", exact: true }),
  ).toBeVisible();
  await page.getByLabel("登录账号", { exact: true }).fill("owner");
  await page.getByLabel("密码", { exact: true }).fill(" old legacy ");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "媒体库", exact: true }),
  ).toBeVisible();
  await page.goto(appBase + "/admin/sources");
  await expect(page.getByRole("alert")).toContainText("仅管理员");
  await expect(
    page.getByRole("link", { name: "片源管理", exact: true }),
  ).toHaveCount(0);
});

test("beige tokens, media ratio, dialogs and required widths remain usable", async ({
  page,
}, info) => {
  await appFixture(page);
  await page.goto(appBase + "/rooms");
  await page.getByRole("button", { name: "创建房间", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "创建房间", exact: true }),
  ).toBeFocused();
  await page.goto(appBase + "/library");
  for (const width of [360, 390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const ratio = await page
      .locator(".media-thumbnail")
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.width / r.height;
      });
    expect(ratio).toBeCloseTo(16 / 9, 1);
  }
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--surface-canvas")
        .trim()
        .toUpperCase(),
    ),
  ).toBe("#F5F0E6");
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim()
        .toUpperCase(),
    ),
  ).toBe("#D7BDA5");
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
  ).toBe("light");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: info.outputPath("new-library.png"),
    fullPage: true,
  });
});

test("a late room lookup after navigating away cannot open a room in the background", async ({
  page,
}) => {
  const app = await appFixture(page);
  let release!: () => void;
  await page.route("**/api/v1/rooms", async (route) => {
    await new Promise<void>((r) => (release = r));
    await route.fulfill({ json: [app.room] });
  });
  await page.goto(appBase + "/rooms/room");
  await expect.poll(() => typeof release).toBe("function");
  await page
    .getByRole("link", { name: "媒体库", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "媒体库", exact: true }),
  ).toBeVisible();
  release();
  await expect(page.locator(".mini-player")).not.toBeVisible();
  await page.waitForTimeout(250);
  expect(app.connections()).toBe(0);
  expect(app.preparations()).toBe(0);
  expect(app.errors).toEqual([]);
});

test("chat missing acknowledgement exposes explicit same-id retry without automatic duplication", async ({
  page,
}) => {
  await page.clock.install();
  const app = await appFixture(page),
    sent: any[] = [];
  await page.routeWebSocket("**/api/v1/ws", (ws) => {
    ws.onMessage((data) => {
      const value = JSON.parse(String(data));
      if (value.type === "CHAT") sent.push(value);
    });
  });
  await page.goto(appBase + "/rooms/room");
  await page.getByLabel("聊天消息").fill("等待确认");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.clock.fastForward(11000);
  await expect(
    page.getByRole("button", { name: "重试发送", exact: true }),
  ).toBeEnabled();
  expect(sent).toHaveLength(1);
  await expect(page.getByLabel("聊天消息")).toHaveValue("等待确认");
  await page.getByRole("button", { name: "重试发送", exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].client_message_id).toBe(sent[0].client_message_id);
  expect(app.errors).toEqual([]);
});

test("returning to the library refreshes scanned media while retaining the search", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.goto(appBase + "/library");
  await page.getByLabel("搜索影片").fill("新扫描");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByText("没有找到匹配影片")).toBeVisible();
  await page
    .getByRole("link", { name: /^(片源管理|管理)$/ })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "片源管理", exact: true }),
  ).toBeVisible();
  app.media.push({
    id: "new-scan",
    title: "新扫描影片",
    kind: "local",
    duration_ms: 30000,
  });
  await page
    .getByRole("link", { name: "媒体库", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByLabel("搜索影片")).toHaveValue("新扫描");
  await expect(
    page.getByRole("heading", { name: "新扫描影片", exact: true }),
  ).toBeVisible();
  expect(app.errors).toEqual([]);
});
