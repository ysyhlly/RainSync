import { expect, test } from "@playwright/test";
import { appFixture, openFixtureSource } from "./fixtures/application";

test("a failed film rename read cannot show or submit the preceding film draft", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  let fail = true;
  const writes: { id: string; title: string }[] = [];
  await page.route("**/api/v1/media/movie-1", (route) => {
    if (fail)
      return route.fulfill({
        status: 503,
        json: {
          error: { code: "REVIEW_READ_FAILED", message: "读取影片名称失败" },
        },
      });
    return route.fallback();
  });
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/personal-title"))
      writes.push({
        id: new URL(request.url()).pathname.split("/").at(-2)!,
        title: request.postDataJSON().title,
      });
  });
  await page.goto("/library");
  await openFixtureSource(page);
  await page
    .getByRole("button", { name: "重命名 真实合成测试视频", exact: true })
    .click();
  await page
    .getByLabel("仅我看到的名称", { exact: true })
    .fill("第一部影片未提交的名称");
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page
    .getByRole("button", { name: "重命名 测试影片 1", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "重命名影片", exact: true });
  await expect(dialog).toContainText("读取影片名称失败");
  await expect(
    dialog.getByLabel("仅我看到的名称", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "保存个人名称", exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.screenshot({
    path: info.outputPath("rename-read-failed-safe.png"),
    animations: "disabled",
  });
  fail = false;
  await dialog
    .getByRole("button", { name: "重新读取名称", exact: true })
    .click();
  await expect(
    dialog.getByLabel("仅我看到的名称", { exact: true }),
  ).toHaveValue("");
  await dialog
    .getByLabel("仅我看到的名称", { exact: true })
    .fill("第二部影片的新名称");
  await dialog
    .getByRole("button", { name: "保存个人名称", exact: true })
    .click();
  await expect(dialog).toContainText("名称已保存");
  expect(writes).toEqual([{ id: "movie-1", title: "第二部影片的新名称" }]);
  expect(app.errors).toEqual([]);
});

test("a recovered timeline poll clears its read error without leaving a stale alert", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  let reads = 0;
  await page.route("**/api/v1/rooms/room/timeline/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/current")) {
      reads++;
      if (reads === 1)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "REVIEW_READ_FAILED",
              message: "时间轴暂时无法读取",
            },
          },
        });
      return route.fulfill({
        json: {
          activity: null,
          can_moderate: false,
          can_assign_moderator: false,
        },
      });
    }
    if (path.endsWith("/activities"))
      return route.fulfill({ json: { items: [] } });
    return route.fallback();
  });
  await page.goto("/rooms/room");
  await page
    .getByRole("button", { name: "时间轴评论与表情", exact: true })
    .click();
  const timeline = page.getByRole("region", {
    name: "时间轴评论",
    exact: true,
  });
  await expect(timeline).toContainText("时间轴暂时无法读取");
  await expect.poll(() => reads, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expect(timeline.getByRole("alert")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("timeline-read-recovered.png"),
    animations: "disabled",
  });
  expect(app.errors).toEqual([]);
});
