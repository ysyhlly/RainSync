import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";
test("information is outside clean video and hover or touch reveals controls", async ({
  page,
  isMobile,
}) => {
  await appFixture(page);
  await page.goto("/rooms/room");
  const info = page.locator(".room-information");
  await expect(info).toContainText("真实合成测试视频");
  const chrome = page.locator(".player-chrome");
  await expect(chrome).toHaveCSS("opacity", "0");
  if (isMobile) await page.locator("video").tap({ position: { x: 20, y: 20 } });
  else await page.locator("video").hover();
  await expect(chrome).toHaveCSS("opacity", "1");
  await page.getByRole("button", { name: "播放选项", exact: true }).click();
  await page.getByRole("combobox", { name: "播放方式", exact: true }).click();
  await page.mouse.move(0, 0);
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(chrome).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "播放选项", exact: true }).click();
  if (!isMobile) {
    await page.mouse.move(0, 0);
    await expect(chrome).toHaveCSS("opacity", "0");
  }
});
test("real fullscreen has exactly two idle seconds, locked menus and persistent video", async ({
  page,
  isMobile,
}) => {
  test.skip(
    isMobile,
    "Fullscreen desktop API; mobile touch covered separately",
  );
  const app = await appFixture(page);
  await page.goto("/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.evaluate(() => {
    (window as any).__video = document.querySelector("video");
  });
  await page.locator("video").hover();
  await page.getByRole("button", { name: "全屏", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.fullscreenElement?.classList.contains("playback-host"),
      ),
    )
    .toBe(true);
  await expect(page.locator(".playback-host")).toHaveCSS("padding", "0px");
  await page.clock.install({ time: new Date("2026-09-29T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-29T00:00:01Z"));
  await page
    .locator("video")
    .dispatchEvent("pointermove", { pointerType: "mouse" });
  await page.clock.runFor(1999);
  await expect(page.locator(".player-chrome")).toHaveCSS("opacity", "1");
  await page.clock.runFor(151);
  await expect(page.locator(".player-chrome")).toHaveCSS("opacity", "0");
  await expect(page.locator(".playback-host")).toHaveCSS("cursor", "none");
  await page
    .locator("video")
    .dispatchEvent("pointermove", { pointerType: "mouse" });
  await page.clock.runFor(160);
  await page.getByRole("combobox", { name: "房间倍速" }).click();
  await page.clock.runFor(6000);
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: "1.5×", exact: true }).click();
  await expect
    .poll(() =>
      app.commands.some(
        (c) => c.type === "SET_RATE" && c.payload?.rate === 1.5,
      ),
    )
    .toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.locator(".playback-host")).not.toHaveCSS("cursor", "none");
  expect(
    await page.evaluate(
      () => (window as any).__video === document.querySelector("video"),
    ),
  ).toBe(true);
  expect(app.preparations()).toBe(1);
  expect(app.connections()).toBe(1);
});

test("unsupported fullscreen reports the limitation without replacing the video", async ({
  page,
  isMobile,
}) => {
  await appFixture(page);
  await page.goto("/rooms/room");
  await page.evaluate(() =>
    Object.defineProperty(document, "fullscreenEnabled", {
      value: false,
      configurable: true,
    }),
  );
  if (isMobile) await page.locator("video").tap({ position: { x: 20, y: 20 } });
  else await page.locator("video").hover();
  await page.getByRole("button", { name: "全屏", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "此设备不支持标准播放器全屏",
  );
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.locator("video")).toHaveCount(1);
});
