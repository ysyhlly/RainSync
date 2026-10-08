import { test, expect } from "@playwright/test";
import {
  roomLayoutFixture,
  rememberPlayback,
  expectPlaybackUnchanged,
  expectPlayerAligned,
} from "./fixtures/room-layout";

test("the global player loads after the first room snapshot and persists across mini navigation", async ({
  page,
}) => {
  const app = await roomLayoutFixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  let release!: () => void;
  let loading = false;
  const delayed = new Promise<void>((done) => {
    release = done;
  });
  await page.route(
    "**/src/features/playback/PlaybackHost.vue",
    async (route) => {
      loading = true;
      await delayed;
      await route.continue();
    },
  );
  try {
    await page.goto("/rooms");
    await expect(
      page.getByRole("heading", { name: "放映室", exact: true }),
    ).toBeVisible();
    await expect(page.locator("video")).toHaveCount(0);
    expect(loading).toBe(false);
    await page
      .getByRole("button", { name: "进入房间", exact: true })
      .first()
      .click();
    await expect.poll(() => loading).toBe(true);
    await expect.poll(() => app.connections()).toBe(1);
    await expect(page.getByLabel("聊天消息", { exact: true })).toBeEnabled();
    await expect(page.locator("video")).toHaveCount(0);
    release();
    const before = await rememberPlayback(page, app);
    await expect(page.locator("video")).toBeVisible();
    await expectPlayerAligned(page);
    const size = await page.locator("video").boundingBox();
    expect(size?.width).toBeGreaterThan(100);
    expect(size?.height).toBeGreaterThan(50);
    await page
      .getByRole("link", { name: "媒体库", exact: true })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(/\/library$/);
    await expectPlaybackUnchanged(page, app, before);
    await expect(page.locator("video")).toBeVisible();
    await page.getByRole("link", { name: "返回房间", exact: true }).click();
    await expect(page).toHaveURL(/\/rooms\/room$/);
    await expectPlaybackUnchanged(page, app, before);
    await expect(page.locator("video")).toBeVisible();
    await expectPlayerAligned(page);
    await expect(page.locator(".frontend-notice")).toHaveCount(0);
    expect(app.errors).toEqual([]);
  } finally {
    release();
  }
});
