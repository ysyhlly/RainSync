import { expect, test } from "@playwright/test";
import { appFixture } from "./fixtures/application";

test("browser submits concrete hints without claiming universal codec support", async ({
  page,
}) => {
  const app = await appFixture(page);
  const request = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith("/api/v1/playback-sessions"),
  );
  await page.goto("/rooms/room");
  const caps = (await request).postDataJSON().capabilities;
  expect(caps.report.schema_version).toBe(1);
  expect(caps.report.candidates).toHaveLength(5);
  const high = caps.report.candidates[0];
  expect(high.content_type).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
  expect(high.video).toMatchObject({
    width: 1920,
    height: 1080,
    framerate: 30,
  });
  expect(high.audio).toMatchObject({ channels: "2", samplerate: 48000 });
  expect(caps.progressive_h264_aac).toBe(
    ["maybe", "probably"].includes(high.progressive),
  );
  expect(caps.mse_h264_aac).toBe(high.mse_supported === true);
  for (const candidate of caps.report.candidates) {
    expect(["unknown", "unsupported", "maybe", "probably"]).toContain(
      candidate.progressive,
    );
    if (candidate.file_decoding) {
      expect(typeof candidate.file_decoding.supported).toBe("boolean");
      expect(typeof candidate.file_decoding.smooth).toBe("boolean");
      expect(typeof candidate.file_decoding.power_efficient).toBe("boolean");
    }
  }
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  expect(app.preparations()).toBe(1);
  expect(app.errors).toEqual([]);
});

test("a hung optional decoding estimate does not block playback preparation", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaCapabilities", {
      configurable: true,
      value: { decodingInfo: () => new Promise(() => {}) },
    });
  });
  await page.goto("/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  expect(app.preparations()).toBe(1);
  expect(app.errors).toEqual([]);
});

test("NAS readiness separates live connection from indexed versions and refreshes", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  let reads = 0;
  await page.route("**/api/v1/agents", (route) => {
    reads++;
    return route.fulfill({
      json: [
        {
          id: "old",
          name: "旧版设备",
          revoked: false,
          last_seen: null,
          connected: true,
          source_version_status: "upgrade_required",
          indexed_count: 3,
          unversioned_count: 3,
        },
        {
          id: "ready",
          name: "索引设备",
          revoked: false,
          last_seen: null,
          connected: reads > 1,
          source_version_status: "ready",
          indexed_count: 12,
          unversioned_count: 0,
        },
        {
          id: "empty",
          name: "空设备",
          revoked: false,
          last_seen: null,
          connected: true,
          source_version_status: "empty",
          indexed_count: 0,
          unversioned_count: 0,
        },
      ],
    });
  });
  await page.goto("/admin/agents");
  const old = page.locator(".admin-row").filter({ hasText: "旧版设备" });
  const ready = page.locator(".admin-row").filter({ hasText: "索引设备" });
  const empty = page.locator(".admin-row").filter({ hasText: "空设备" });
  await expect(old).toContainText("在线");
  await expect(old).toContainText("请升级 NAS Agent 并重新扫描");
  await expect(old).toContainText("3 部影片缺少版本");
  await expect(ready).toContainText("离线");
  await expect(ready).toContainText("文件版本索引已就绪（12 部影片）");
  await expect(empty).toContainText("尚无可用影片索引");
  await expect(empty).not.toContainText("已就绪");
  await page.screenshot({
    path: info.outputPath("nas-readiness.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "刷新设备状态" }).click();
  await expect(ready).toContainText("在线");
  await expect(ready).not.toContainText("离线");
  expect(reads).toBe(2);
  expect(app.errors).toEqual([]);
});
