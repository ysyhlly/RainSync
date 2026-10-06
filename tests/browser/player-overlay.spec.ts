import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";

test("independent room widgets remain visible and preserve chat drafts across resize", async ({
  page,
}) => {
  await appFixture(page);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/rooms/room");
  await expect(page.locator("#room-chat")).toBeVisible();
  await page
    .getByRole("textbox", { name: "聊天消息", exact: true })
    .fill("保留的聊天草稿");
  await expect(page.locator("#room-queue")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#room-chat")).toBeVisible();
  await expect(page.locator("#room-chat")).toBeVisible();
  await expect(page.locator("#room-queue")).toBeVisible();
  await page.setViewportSize({ width: 1366, height: 900 });
  await expect(page.locator("#room-chat")).toBeVisible();
  await expect(page.locator("#room-queue")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#room-chat")).toBeVisible();
  await expect(page.locator("#room-queue")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "聊天消息", exact: true }),
  ).toHaveValue("保留的聊天草稿");
});

test("compact controls fit narrow videos and retain volume and rate interactions", async ({
  page,
  isMobile,
}, testInfo) => {
  const app = await appFixture(page);
  await page.goto("/rooms/room");
  for (const width of [320, 390, 768, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    if (isMobile)
      await page.locator("video").tap({ position: { x: 20, y: 20 } });
    else await page.locator("video").hover({ position: { x: 20, y: 20 } });
    // A surface tap can toggle an already-visible touch overlay off.
    await page
      .locator("video")
      .dispatchEvent("pointermove", { pointerType: "mouse" });
    const video = await page.locator(".video-frame").boundingBox();
    const controls = await page.locator(".player-chrome").boundingBox();
    expect(controls!.height).toBeLessThanOrEqual(100);
    for (const label of ["播放选项", "进入全屏"]) {
      const box = await page
        .getByRole("button", { name: label, exact: true })
        .boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(video!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(video!.x + video!.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        video!.y + video!.height,
      );
    }
    await page.screenshot({
      path: testInfo.outputPath(`overlay-${width}.png`),
    });
  }
  const mute = page.getByRole("button", { name: "本机静音", exact: true });
  if (isMobile) await mute.focus();
  else await mute.hover();
  const volume = page.getByRole("slider", { name: "本机音量", exact: true });
  await expect(volume).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("overlay-volume.png") });
  await volume.focus();
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.volume),
    )
    .toBeCloseTo(0.95);
  const rate = page.getByRole("combobox", { name: "房间倍速", exact: true });
  const chevron = rate.locator("svg");
  await expect(chevron).toHaveAttribute("width", "20");
  await rate.click();
  await page.getByRole("option", { name: "1.5×", exact: true }).click();
  await expect
    .poll(() =>
      app.commands.some(
        (c) => c.type === "SET_RATE" && c.payload?.rate === 1.5,
      ),
    )
    .toBe(true);
  // Visual worst-case surfaces, not a substitute for playback/decoder tests.
  await page.locator(".video-frame").hover({ position: { x: 20, y: 20 } });
  await expect(page.locator(".player-chrome")).toHaveCSS("opacity", "1");
  const light = await page.addStyleTag({
    content:
      ".video-frame video{opacity:0!important}.video-frame.has-media{background:#fff!important}",
  });
  await page.screenshot({
    path: testInfo.outputPath("overlay-light-surface.png"),
  });
  await page.locator(".video-frame").hover({ position: { x: 20, y: 20 } });
  await expect(page.locator(".player-chrome")).toHaveCSS("opacity", "1");
  await page.getByRole("button", { name: "播放选项", exact: true }).click();
  await expect(page.locator(".settings-panel")).toBeVisible();
  const panel = await page.locator(".settings-panel").boundingBox();
  const frame = await page.locator(".video-frame").boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(frame!.x);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(frame!.x + frame!.width);
  await page.screenshot({ path: testInfo.outputPath("overlay-settings.png") });
  await light.evaluate((el) => el.remove());
});

test("video controls leave the picture transparent and fit a compact bottom strip", async ({
  page,
  isMobile,
}) => {
  await appFixture(page);
  await page.goto("/rooms/room");
  if (isMobile) await page.locator("video").tap({ position: { x: 20, y: 20 } });
  else await page.locator("video").hover();
  const chrome = page.locator(".player-chrome");
  await expect(chrome).toHaveCSS("opacity", "1");
  await expect(page.locator(".playback-controls")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  const controls = await chrome.boundingBox();
  expect(controls!.height).toBeLessThanOrEqual(100);
  const seek = await page
    .getByRole("slider", { name: "房间播放进度" })
    .boundingBox();
  const play = await page.locator(".control-play").boundingBox();
  expect(seek!.y + seek!.height).toBeLessThanOrEqual(play!.y + 1);
  await page.getByRole("button", { name: "播放选项", exact: true }).click();
  await expect(page.locator(".settings-panel")).toBeVisible();
  await page.getByRole("combobox", { name: "播放方式", exact: true }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
});
