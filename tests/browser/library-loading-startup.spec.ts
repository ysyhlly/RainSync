import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";
const previewPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWHsAAAAASUVORK5CYII=";

test("library immediately shows its heading and skeleton, then distinguishes source and video counts", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/media/browse?**", async (route) => {
    await pending;
    await route.fulfill({
      json: {
        node: null,
        breadcrumbs: [{ id: null, name: "全部片源" }],
        entries: [
          { type: "source", id: "one", name: "单一片源", media_count: 25 },
        ],
        total_media: 25,
        next_cursor: null,
      },
    });
  });
  try {
    await page.goto("/library", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "媒体库", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".library-loading")).toBeVisible();
    await expect(page.locator(".library-loading-card")).toHaveCount(6);
    await page.screenshot({
      path: info.outputPath("library-loading.png"),
      fullPage: true,
    });
    release();
    await expect(
      page.getByRole("button", { name: "打开片源 单一片源", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("所有可访问片源共 25 部影片")).toBeVisible();
    await expect(page.getByText("第 1 页 · 本页 1 个片源")).toBeVisible();
    await expect(page.locator(".library-loading")).toHaveCount(0);
    expect(app.errors).toEqual([]);
  } finally {
    release();
  }
});

test("platform preview has an inline checkbox, concise defaults and an actual bounded raster cover", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  await page.route("**/api/v1/rooms/room/platform-media/preview", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            key: "a".repeat(64),
            provider: "bilibili",
            url: "https://www.bilibili.com/video/BV1xx411c7mD",
            part: 1,
            title: "真实的视频标题",
            cover_data_url:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWHsAAAAASUVORK5CYII=",
          },
        ],
        failures: [],
        truncated: false,
        limit: 20,
      },
    }),
  );
  await page.goto("/rooms/room", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "平台链接", exact: true }).click();
  const drawer = page.getByRole("dialog", {
    name: "添加平台视频",
    exact: true,
  });
  await expect(
    drawer.getByRole("heading", { name: "导入平台视频" }),
  ).toBeVisible();
  await expect(drawer.locator("details").first()).not.toHaveAttribute("open");
  const collection = drawer.getByLabel("预览合集、播放列表或视频分 P");
  expect(
    await collection.evaluate(
      (input) => getComputedStyle(input.parentElement!).flexDirection,
    ),
  ).toBe("row");
  await drawer
    .getByLabel("视频链接或分享文字")
    .fill("https://www.bilibili.com/video/BV1xx411c7mD");
  await drawer.getByRole("button", { name: "预览可导入条目" }).click();
  await expect(drawer.getByText("真实的视频标题")).toBeVisible();
  const cover = drawer.getByRole("img", { name: "真实的视频标题" });
  await expect(cover).toBeVisible();
  await expect
    .poll(() =>
      cover.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  expect(app.errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("platform-preview-cover.png"),
    fullPage: true,
  });
});

test("real provider episode numbering and available same-origin media covers are shown", async ({
  page,
}) => {
  const app = await appFixture(page);
  const media = {
    ...app.media[0],
    title: "源提供的节目",
    original_title: "源提供的节目",
    kind: "jellyfin",
    series: { season_number: 1, episode_number: 3, series_title: "真实剧集" },
    cover: {
      status: "ready",
      url: "/fixture-cover.png",
      revision: "one",
      retry_after_ms: null,
    },
  };
  await page.route("**/api/v1/media/movie", (route) =>
    route.fulfill({ json: media }),
  );
  await page.route("**/fixture-cover.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(previewPng, "base64"),
    }),
  );
  await page.route("**/api/v1/media/previews**", (route) =>
    route.fulfill({
      json: { items: [{ media_id: media.id, cover: media.cover }] },
    }),
  );
  await page.route("**/api/v1/media/browse?**", (route) =>
    route.fulfill({
      json: {
        node: "season-one",
        breadcrumbs: [
          { id: null, name: "全部片源" },
          { id: "season-one", name: "第一季" },
        ],
        entries: [{ type: "media", media }],
        total_media: 25,
        next_cursor: null,
      },
    }),
  );
  await page.goto("/library", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("第 1 季 · 第 3 集", { exact: true }),
  ).toBeVisible();
  const cover = page.getByRole("img", { name: "源提供的节目", exact: true });
  await expect
    .poll(() =>
      cover.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(page.getByText("此目录及子目录共 25 部影片")).toBeVisible();
  await expect(page.getByText("第 1 页 · 本页 1 部影片")).toBeVisible();
  expect(app.errors).toEqual([]);
});

test("disabled private libraries show a user-facing explanation and a stacked heading", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.route("**/api/v1/libraries**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("issued-shares")
        ? { items: [], has_more: false }
        : { enabled: false, items: [] },
    }),
  );
  await page.goto("/libraries", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("私人媒体库功能尚未开启，请联系管理员。"),
  ).toBeVisible();
  await expect(page.getByText("PRIVATE_LIBRARIES_ENABLED")).toHaveCount(0);
  const heading = await page
    .getByRole("heading", { name: "我的媒体库与授权", exact: true })
    .boundingBox();
  const copy = await page
    .getByText("管理可访问的影片、片源和共享范围。房间分享只授权指定影片。")
    .boundingBox();
  expect(copy!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height);
  expect(app.errors).toEqual([]);
});
