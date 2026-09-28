import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";
import { navigate } from "./fixtures/navigation";
test("rename updates library and playing metadata without another media session", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.goto("/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.evaluate(() => {
    (window as any).__video = document.querySelector("video");
  });
  await navigate(page, "媒体库");
  await page
    .getByRole("button", { name: "重命名 真实合成测试视频", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "重命名影片" });
  await expect(dialog.getByLabel("仅我看到的名称")).toBeEnabled();
  await dialog.getByLabel("仅我看到的名称").fill("我的片名");
  await dialog
    .getByRole("button", { name: "保存个人名称", exact: true })
    .click();
  await expect(dialog.getByText("名称已保存")).toBeVisible();
  await dialog.getByLabel("所有人的默认名称").fill("共享片名");
  await dialog
    .getByRole("button", { name: "保存全站名称", exact: true })
    .click();
  await expect.poll(() => app.media[0].shared_title).toBe("共享片名");
  await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  await expect(page.locator(".media-card h2").first()).toHaveText("我的片名");
  await page.getByRole("link", { name: "返回房间" }).click();
  await expect(page.locator(".room-information h2")).toBeVisible();
  expect(app.preparations()).toBe(1);
  expect(app.connections()).toBe(1);
  expect(
    await page.evaluate(
      () => (window as any).__video === document.querySelector("video"),
    ),
  ).toBe(true);
  expect(app.errors).toEqual([]);
});
test("ordinary viewer sees only personal rename and preview batches contain visible cards only", async ({
  page,
}) => {
  const app = await appFixture(page, { admin: false });
  const batches: string[][] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/media/previews") && r.method() === "POST")
      batches.push(r.postDataJSON().media_ids);
  });
  await page.goto("/library");
  await page
    .getByRole("button", { name: "重命名 真实合成测试视频", exact: true })
    .click();
  await expect(page.getByLabel("仅我看到的名称")).toBeVisible();
  await expect(page.getByLabel("所有人的默认名称")).toHaveCount(0);
  await expect.poll(() => batches.length).toBeGreaterThan(0);
  expect(
    batches.every((ids) => ids.length <= 24 && !ids.includes("movie-24")),
  ).toBe(true);
  expect(app.errors).toEqual([]);
});
