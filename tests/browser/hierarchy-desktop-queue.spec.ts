import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";
for (const width of [1280, 1440, 1920])
  test(`hierarchy and original-scroll queue feedback remain usable at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({
      width,
      height: width === 1280 ? 800 : width === 1440 ? 900 : 1080,
    });
    const app = await appFixture(page);
    let pending: any,
      committed = false,
      failRefresh = true,
      posts = 0,
      reads = 0;
    await page.route("**/api/v1/media/browse?**", (r) => {
      const url = new URL(r.request().url()),
        node = url.searchParams.get("node"),
        after = url.searchParams.get("after");
      return r.fulfill({
        json: {
          node,
          breadcrumbs: [
            { id: null, name: "全部片源" },
            ...(node ? [{ id: "source", name: "家庭 NAS 高清电影归档" }] : []),
            ...(node === "folder"
              ? [{ id: "folder", name: "自然与科学纪录片合集" }]
              : []),
          ],
          entries: !node
            ? [
                {
                  type: "source",
                  id: "source",
                  name: "家庭 NAS 高清电影归档",
                  kind: "agent",
                  media_count: 30,
                },
                {
                  type: "source",
                  id: "other",
                  name: "Family_Media_NAS_Archive_2026_UHD_Remux_Complete_Collection",
                  kind: "local",
                  media_count: 30,
                },
              ]
            : node === "source"
              ? [
                  {
                    type: "folder",
                    id: "folder",
                    name: "自然与科学纪录片合集",
                    media_count: 30,
                  },
                ]
              : app.media
                  .slice(after ? 24 : 0, after ? 30 : 24)
                  .map((media) => ({ type: "media", media })),
          next_cursor: node === "folder" && !after ? "next" : null,
          total_media: 30,
        },
      });
    });
    await page.route("**/api/v1/rooms/room/playlist", (r) => {
      if (r.request().method() === "POST") {
        posts++;
        pending = r;
        return;
      }
      reads++;
      return committed && failRefresh
        ? r.fulfill({
            status: 503,
            json: {
              error: { code: "FIXTURE_STALE", message: "暂时无法刷新待播列表" },
            },
          })
        : r.fulfill({ json: [] });
    });
    await page.goto("/rooms/room");
    await expect(page.locator("video")).toHaveAttribute(
      "src",
      "/fixture-video.mp4",
    );
    await page
      .getByRole("link", { name: "媒体库", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("button", {
        name: "打开片源 家庭 NAS 高清电影归档",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`hierarchy-root-${width}.png`),
      animations: "disabled",
    });
    await page
      .getByRole("button", {
        name: "打开片源 家庭 NAS 高清电影归档",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: "打开目录 自然与科学纪录片合集",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`hierarchy-folder-${width}.png`),
      animations: "disabled",
    });
    await page
      .getByRole("button", {
        name: "打开目录 自然与科学纪录片合集",
        exact: true,
      })
      .click();
    await expect(page.locator(".media-card")).toHaveCount(24);
    await expect(
      page.getByRole("navigation", { name: "媒体库目录" }),
    ).toContainText("自然与科学纪录片合集");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`hierarchy-media-${width}.png`),
      animations: "disabled",
    });
    const card = page.locator(".media-card").nth(8),
      add = card.getByRole("button", { name: /^加入待播 / });
    await add.scrollIntoViewIfNeeded();
    await add.evaluate((e) =>
      scrollBy(0, e.getBoundingClientRect().top - innerHeight * 0.4),
    );
    const before = await page.evaluate(() => scrollY);
    await add.click();
    const feedback = card.locator(".media-queue-feedback");
    await expect(feedback.getByRole("status")).toContainText("正在加入");
    await expect(feedback.getByRole("status")).toBeInViewport();
    committed = true;
    await pending.fulfill({ json: { ok: true } });
    const receipt = feedback.getByRole("alert"),
      retry = feedback.getByRole("button", {
        name: "重新加载待播列表",
        exact: true,
      });
    await expect(receipt).toContainText("已加入");
    await expect(receipt).toBeInViewport();
    await expect(retry).toBeInViewport();
    expect(
      Math.abs(before - (await page.evaluate(() => scrollY))),
    ).toBeLessThanOrEqual(2);
    const retryBox = await retry.boundingBox(),
      playerBox = await page.locator(".playback-host").boundingBox();
    expect(retryBox!.y + retryBox!.height).toBeLessThan(playerBox!.y);
    await page.screenshot({
      path: info.outputPath(`hierarchy-queue-feedback-${width}.png`),
      animations: "disabled",
    });
    failRefresh = false;
    const priorReads = reads;
    await retry.click();
    await expect(feedback.getByRole("status")).toHaveText("已加入");
    expect(reads).toBe(priorReads + 1);
    expect(posts).toBe(1);
    expect(app.errors).toEqual([]);
  });

// This audit deliberately sets desktop widths; shared mobile flows are covered elsewhere.
test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "Desktop settings and hierarchy geometry");
});
