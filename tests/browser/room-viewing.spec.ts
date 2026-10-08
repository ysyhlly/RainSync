import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  roomLayoutFixture,
  enterLayoutRoom,
  rememberPlayback,
  expectPlaybackUnchanged,
  expectPlayerAligned,
  expectNoHorizontalOverflow,
  visibleLayout,
  layoutKey,
  widget,
} from "./fixtures/room-layout";

// The baseline playback fixture is intentionally black. Pixel/occlusion checks
// need a decoded colored frame rather than mistaking a black fixture for a bug.
// Generated locally: ffmpeg lavfi smptebars, 160x90, 10 fps, 3s, H.264 baseline.
const colorBars = Buffer.from(
  readFileSync("tests/fixtures/browser-color-bars.base64", "utf8").trim(),
  "base64",
);
async function viewingFixture(
  page: Page,
  options: Parameters<typeof roomLayoutFixture>[1] = {},
) {
  const app = await roomLayoutFixture(page, options);
  await page.route("**/fixture-video.mp4", (route) =>
    route.fulfill({ contentType: "video/mp4", body: colorBars }),
  );
  return app;
}

const mode = (page: import("@playwright/test").Page) =>
  page.locator(".room-modular-page");

for (const width of [1280, 1440, 1920]) {
  for (const kind of ["webpage", "browser"]) {
    test(`${kind} fullscreen at ${width}px retains player, chat and custom layout`, async ({
      page,
    }, info) => {
      test.skip(
        info.project.name === "mobile",
        "Desktop fullscreen acceptance",
      );
      const app = await viewingFixture(page, { history: 80 });
      await enterLayoutRoom(page, width);
      const saved = await visibleLayout(page);
      await page
        .getByLabel("聊天消息", { exact: true })
        .fill("尚未发送的聊天草稿");
      await page.evaluate(() => {
        (window as any).__viewingChat = document.querySelector("#room-chat");
        (window as any).__viewingDraft = document.querySelector("#chat-body");
      });
      const playback = await rememberPlayback(page, app);
      await page.getByTestId(`room-${kind}-fullscreen`).click();
      await expect(mode(page)).toHaveAttribute("data-viewing-mode", kind);
      expect(
        await page.evaluate(
          () => document.fullscreenElement === document.documentElement,
        ),
      ).toBe(kind === "browser");
      await expectPlayerAligned(page);
      await expectNoHorizontalOverflow(page);
      const chatBox = (await widget(page, "chat").boundingBox())!;
      expect(chatBox.width).toBeGreaterThanOrEqual(300);
      expect(chatBox.width).toBeLessThanOrEqual(400);
      expect(chatBox.x + chatBox.width).toBeGreaterThanOrEqual(width - 24);
      expect(chatBox.x + chatBox.width).toBeLessThanOrEqual(width);
      const videoBox = (await page.locator("video").boundingBox())!;
      expect(videoBox.width).toBeGreaterThan(
        (width - chatBox.width - 52) * 0.95,
      );
      expect(chatBox.y + chatBox.height).toBeLessThanOrEqual(1001);
      await expect
        .poll(() =>
          page
            .locator("video")
            .evaluate((video: HTMLVideoElement) => video.readyState),
        )
        .toBeGreaterThanOrEqual(2);
      // A retained but covered video would still pass identity-only checks.
      expect(
        await page.locator("video").evaluate((video: HTMLVideoElement) => {
          const box = video.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(video, 0, 0, 1, 1);
          const pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data);
          return {
            visible: hit === video || !!hit?.closest(".playback-host"),
            colored: pixel.slice(0, 3).some((value) => value > 20),
          };
        }),
      ).toEqual({ visible: true, colored: true });
      await page.getByTestId("room-toggle-chat").click();
      await expect(widget(page, "chat")).toBeHidden();
      await expectPlayerAligned(page);
      await page.getByTestId("room-toggle-chat").click();
      await expect(widget(page, "chat")).toBeVisible();
      await expect(page.getByLabel("聊天消息", { exact: true })).toHaveValue(
        "尚未发送的聊天草稿",
      );
      expect(
        await page.evaluate(
          () =>
            (window as any).__viewingChat ===
              document.querySelector("#room-chat") &&
            (window as any).__viewingDraft ===
              document.querySelector("#chat-body"),
        ),
      ).toBe(true);
      await page.getByTestId(`room-${kind}-fullscreen`).click();
      await expect(mode(page)).toHaveAttribute("data-viewing-mode", "normal");
      expect(await visibleLayout(page)).toEqual(saved);
      await expectPlayerAligned(page);
      await expectPlaybackUnchanged(page, app, playback);
      expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
      expect(
        await page.evaluate(() => getComputedStyle(document.body).overflow),
      ).not.toBe("hidden");
    });
  }
}

test("browser fullscreen keeps picker and player selectors usable above video, with distinct video-only mode", async ({
  page,
}, info) => {
  test.skip(info.project.name === "mobile", "Desktop fullscreen acceptance");
  const app = await viewingFixture(page);
  await enterLayoutRoom(page);
  const playback = await rememberPlayback(page, app);
  await page.getByTestId("room-webpage-fullscreen").click();
  await page.getByTestId("room-toggle-chat").click();
  await page.getByTestId("room-browser-fullscreen").click();
  await expect(mode(page)).toHaveAttribute("data-viewing-mode", "browser");
  await page.getByRole("button", { name: "选择影片", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择影片", exact: true });
  await expect(picker).toBeVisible();
  expect(
    await picker.evaluate(
      (element) => !!document.fullscreenElement?.contains(element),
    ),
  ).toBe(true);
  await picker
    .getByRole("button", { name: "打开片源 测试片源", exact: true })
    .click();
  await picker.getByLabel("搜索影片", { exact: true }).fill("测试影片 29");
  await expect(picker.locator(".picker-media-row")).toHaveCount(1);
  await picker.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await expect(picker).toBeHidden();
  await page.locator("video").hover();
  await page.getByRole("combobox", { name: "房间倍速", exact: true }).click();
  await expect(
    page.getByRole("listbox", { name: "房间倍速", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "仅视频全屏", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.fullscreenElement?.classList.contains("playback-host"),
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "退出仅视频全屏", exact: true })
    .click();
  // Browsers may exit the whole fullscreen stack or return to the root.
  const rootStillFullscreen = await page.evaluate(
    () => document.fullscreenElement === document.documentElement,
  );
  if (rootStillFullscreen)
    await page.getByTestId("room-browser-fullscreen").click();
  await expect(mode(page)).toHaveAttribute("data-viewing-mode", "webpage");
  await expect(widget(page, "chat")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveAttribute("data-viewing-mode", "normal");
  await expectPlaybackUnchanged(page, app, playback);
});

test("unsupported and denied fullscreen preserve webpage mode and chat without fake success", async ({
  page,
}, info) => {
  test.skip(info.project.name === "mobile", "Desktop fullscreen acceptance");
  const app = await viewingFixture(page);
  await enterLayoutRoom(page);
  const playback = await rememberPlayback(page, app);
  await page.evaluate(() =>
    Object.defineProperty(document, "fullscreenEnabled", {
      configurable: true,
      value: false,
    }),
  );
  await page.getByTestId("room-browser-fullscreen").click();
  await expect(
    page.getByText("此浏览器不支持浏览器全屏，可使用网页全屏。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(mode(page)).toHaveAttribute("data-viewing-mode", "normal");
  await page.getByTestId("room-webpage-fullscreen").click();
  await page.getByTestId("room-toggle-chat").click();
  await page.evaluate(() => {
    Object.defineProperty(document, "fullscreenEnabled", {
      configurable: true,
      value: true,
    });
    document.documentElement.requestFullscreen = () =>
      Promise.reject(new DOMException("Test denial", "NotAllowedError"));
  });
  await page.getByTestId("room-browser-fullscreen").click();
  await expect(
    page.getByText("无法进入浏览器全屏，请检查浏览器权限或使用网页全屏。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(mode(page)).toHaveAttribute("data-viewing-mode", "webpage");
  await expect(widget(page, "chat")).toBeHidden();
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expectPlaybackUnchanged(page, app, playback);
});

test("removed chat is temporarily available without changing stored layout; editing blocks mode switches", async ({
  page,
}, info) => {
  test.skip(info.project.name === "mobile", "Desktop fullscreen acceptance");
  const app = await viewingFixture(page);
  await enterLayoutRoom(page);
  await page.getByRole("button", { name: "编辑布局", exact: true }).click();
  await expect(page.getByTestId("room-webpage-fullscreen")).toBeDisabled();
  await expect(page.getByTestId("room-browser-fullscreen")).toBeDisabled();
  await page.getByRole("button", { name: "隐藏聊天", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  const stored = await page.evaluate(
    (key) => localStorage.getItem(key),
    layoutKey(),
  );
  await expect(widget(page, "chat")).toBeHidden();
  await page.getByTestId("room-webpage-fullscreen").click();
  await expect(widget(page, "chat")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(widget(page, "chat")).toBeHidden();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), layoutKey()),
  ).toBe(stored);
  expect(app.errors).toEqual([]);
});

test("SPA Back exits room fullscreen and removes its scroll lock", async ({
  page,
}, info) => {
  test.skip(info.project.name === "mobile", "Desktop fullscreen acceptance");
  const app = await viewingFixture(page);
  await page.goto("/rooms");
  await page.getByRole("button", { name: "进入房间", exact: true }).click();
  await expect(mode(page)).toBeVisible();
  await page.getByTestId("room-browser-fullscreen").click();
  await expect(mode(page)).toHaveAttribute("data-viewing-mode", "browser");
  await page.goBack();
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(mode(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  expect(
    await page.evaluate(() => getComputedStyle(document.body).overflow),
  ).not.toBe("hidden");
  await expect(page.locator(".sidebar")).toBeVisible();
  expect(app.errors).toEqual([]);
});
