import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";

test("subtitle style-loss labels remain visible plain text and retain provider indices", async ({
  page,
  isMobile,
}) => {
  const app = await appFixture(page);
  const label =
    "中文 <img src=x onerror=alert(1)>（ASS/SSA 转为 WebVTT 普通文本：样式、字体、定位和动画无法完整保留）";
  let preparations = 0;
  await page.route("**/api/v1/playback-sessions", async (route) => {
    preparations++;
    await route.fulfill({
      json: {
        session_id: "playback",
        plan_generation: route.request().postDataJSON().plan_generation,
        media_id: "movie",
        media_generation: 1,
        delivery_mode: "direct",
        transport: "progressive",
        playback_url: "/fixture-video.mp4",
        timeline_origin_ms: 0,
        duration_ms: 30000,
        expires_in_seconds: 1800,
        rebuild_on_seek: false,
        audio_tracks: [],
        subtitle_tracks: [
          {
            index: 17,
            label,
            language: "zho",
            url: "/fixture-subtitle.vtt",
          },
          {
            index: 31,
            label: "English",
            language: "eng",
            url: "/fixture-subtitle.vtt",
          },
        ],
      },
    });
  });
  await page.route("**/fixture-subtitle.vtt", (route) =>
    route.fulfill({
      contentType: "text/vtt",
      body: "WEBVTT\n\n00:00.000 --> 00:02.000\nSubtitle\n",
    }),
  );
  await page.goto("/rooms/room");
  const tracks = page.locator("video track");
  await expect(tracks).toHaveCount(2);
  await expect(tracks.nth(0)).toHaveAttribute("data-index", "17");
  await expect(tracks.nth(0)).toHaveAttribute("label", label);
  await expect(tracks.nth(0)).toHaveAttribute("src", "/fixture-subtitle.vtt");
  await expect(tracks.nth(1)).toHaveAttribute("data-index", "31");
  await expect(tracks.nth(1)).toHaveAttribute("label", "English");
  if (isMobile) await page.locator("video").tap({ position: { x: 20, y: 20 } });
  else await page.locator("video").hover();
  await page.getByRole("button", { name: "播放选项", exact: true }).click();
  const select = page.getByRole("combobox", { name: "字幕", exact: true });
  await select.click();
  const option = page.getByRole("option", {
    name: label + " · zho",
    exact: true,
  });
  await expect(option).toBeVisible();
  await expect(option.locator("img")).toHaveCount(0);
  const commands = app.commands.length;
  await option.click();
  await expect(select).toContainText(label);
  await expect(select.locator("img")).toHaveCount(0);
  await expect
    .poll(() => tracks.nth(0).evaluate((t: HTMLTrackElement) => t.track.mode))
    .toBe("showing");
  await select.click();
  await page
    .getByRole("option", { name: "English · eng", exact: true })
    .click();
  await expect
    .poll(() => tracks.nth(1).evaluate((t: HTMLTrackElement) => t.track.mode))
    .toBe("showing");
  await expect
    .poll(() => tracks.nth(0).evaluate((t: HTMLTrackElement) => t.track.mode))
    .toBe("disabled");
  await select.click();
  await page.getByRole("option", { name: "关闭", exact: true }).click();
  await expect(select).toContainText("关闭");
  await expect
    .poll(() => tracks.nth(1).evaluate((t: HTMLTrackElement) => t.track.mode))
    .toBe("disabled");
  expect(app.commands.length).toBe(commands);
  expect(preparations).toBe(1);
  expect(app.errors).toEqual([]);
});
