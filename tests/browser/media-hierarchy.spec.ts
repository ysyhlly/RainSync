import { test, expect, type Page } from "@playwright/test";
import { appFixture } from "./fixtures/application";

async function hierarchy(page: Page) {
  const app = await appFixture(page);
  const calls: URL[] = [];
  let fail = false;
  await page.route("**/api/v1/media/browse?**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const node = url.searchParams.get("node");
    if (fail)
      return route.fulfill({
        status: 503,
        json: { error: { code: "UNAVAILABLE", message: "目录暂不可用" } },
      });
    const breadcrumbs = [
      { id: null, name: "全部片源" },
      ...(node ? [{ id: "source", name: "家庭片源" }] : []),
      ...(node === "folder" ? [{ id: "folder", name: "纪录片" }] : []),
    ];
    if (!node)
      return route.fulfill({
        json: {
          node: null,
          breadcrumbs,
          entries: [
            {
              type: "source",
              id: "source",
              name: "家庭片源",
              kind: "local",
              media_count: 30,
            },
          ],
          total_media: 30,
          next_cursor: null,
        },
      });
    if (node === "source")
      return route.fulfill({
        json: {
          node,
          breadcrumbs,
          entries: [
            { type: "folder", id: "folder", name: "纪录片", media_count: 30 },
          ],
          total_media: 30,
          next_cursor: null,
        },
      });
    const offset = url.searchParams.has("after") ? 24 : 0;
    return route.fulfill({
      json: {
        node,
        breadcrumbs,
        entries: app.media
          .slice(offset, offset + 24)
          .map((media) => ({ type: "media", media })),
        total_media: 30,
        next_cursor: offset ? null : "folder-next",
      },
    });
  });
  return {
    ...app,
    calls,
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}

test("real source and directory browsing keeps card actions and bounded pagination", async ({
  page,
}) => {
  const app = await hierarchy(page);
  await page.goto("/library");
  await expect(
    page.getByRole("button", { name: "打开片源 家庭片源" }),
  ).toBeVisible();
  await expect(page.locator(".media-card")).toHaveCount(0);
  await page.getByRole("button", { name: "打开片源 家庭片源" }).click();
  await page.getByRole("button", { name: "打开目录 纪录片" }).click();
  await expect(page.locator(".media-card")).toHaveCount(24);
  await expect(
    page.getByRole("navigation", { name: "媒体库目录" }).getByRole("button"),
  ).toHaveText(["全部片源", "家庭片源", "纪录片"]);
  await expect(
    page.getByRole("button", { name: "重命名 真实合成测试视频", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".media-card")).toHaveCount(6);
  expect(app.calls.at(-1)?.searchParams.get("after")).toBe("folder-next");
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page.locator(".media-card")).toHaveCount(24);
  await page.getByRole("button", { name: "全部片源", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "打开片源 家庭片源" }),
  ).toBeVisible();
  expect(app.errors).toEqual([]);
});

test("global search crosses directories, clearing returns to the current directory, and failure retries", async ({
  page,
}) => {
  const app = await hierarchy(page);
  await page.goto("/library");
  await page.getByRole("button", { name: "打开片源 家庭片源" }).click();
  await page.getByRole("button", { name: "打开目录 纪录片" }).click();
  await page.getByLabel("搜索影片").fill("真实合成测试视频");
  await expect(page.locator(".media-card")).toHaveCount(1);
  expect(app.searches.at(-1)).toContain("search=");
  await page.getByRole("button", { name: "返回目录浏览" }).click();
  await expect(page.locator(".media-card")).toHaveCount(24);
  await expect(
    page.getByRole("navigation", { name: "媒体库目录" }),
  ).toContainText("纪录片");
  app.setFail(true);
  await page.getByRole("button", { name: "全部片源", exact: true }).click();
  await expect(page.getByText("目录暂不可用", { exact: true })).toBeVisible();
  await expect(page.locator(".media-card")).toHaveCount(24);
  app.setFail(false);
  await page.getByRole("button", { name: "重试本次加载" }).click();
  await expect(
    page.getByRole("button", { name: "打开片源 家庭片源" }),
  ).toBeVisible();
  expect(app.errors).toEqual([]);
});
