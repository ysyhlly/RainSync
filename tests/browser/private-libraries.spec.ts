import { test, expect, type Page } from "@playwright/test";
import { appFixture } from "./fixtures/application";
async function fixture(page: Page, enabled = true) {
  const app = await appFixture(page, { admin: false });
  let revision = "1",
    name = "私人合成片库",
    fail = false;
  const updates: any[] = [];
  const detail = () => ({
    id: "private",
    name,
    owner_id: "owner",
    visibility: "private",
    revision,
    permission_epoch: "1",
    permissions: {
      browse: true,
      play: true,
      share_to_room: true,
      manage: true,
    },
    sources: [],
    grants: [],
    room_shares: [],
    audit: [],
  });
  await page.route("**/api/v1/media/browse?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("library_id") !== "private")
      return route.fallback();
    return route.fulfill({
      json: {
        entries: [{ type: "media", media: app.media[0] }],
        breadcrumbs: [{ id: null, name: "当前媒体库" }],
        node: null,
        next_cursor: null,
        total_media: 1,
      },
    });
  });
  await page.route("**/api/v1/libraries**", async (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    if (path === "/api/v1/libraries")
      return route.fulfill({ json: { enabled, items: [detail()] } });
    if (path === "/api/v1/libraries/private/media")
      return route.fulfill({ json: [app.media[0]] });
    if (path === "/api/v1/libraries/private" && method === "PUT") {
      const body = route.request().postDataJSON();
      updates.push(body);
      if (fail) {
        fail = false;
        revision = "2";
        name = "并发名称";
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "LIBRARY_CONFLICT",
              message: "媒体库已变化，请核对最新版本",
            },
          },
        });
      }
      name = body.name;
      revision = String(Number(revision) + 1);
    }
    return route.fulfill({ json: detail() });
  });
  return {
    ...app,
    updates,
    conflict: () => {
      fail = true;
    },
  };
}
test("private library rename conflict keeps draft and uses new revision only on explicit retry", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/libraries");
  const field = page.getByLabel("媒体库名称", { exact: true });
  await expect(field).toHaveValue("私人合成片库");
  await field.fill("我的保留草稿");
  f.conflict();
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(
    page.getByText("媒体库已被其他操作修改。请核对最新内容后重新操作。"),
  ).toBeVisible();
  await expect(field).toHaveValue("我的保留草稿");
  expect(f.updates).toHaveLength(1);
  expect(f.updates[0].expected_revision).toBe("1");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.getByText("名称已保存", { exact: true })).toBeVisible();
  expect(f.updates).toHaveLength(2);
  expect(f.updates[1]).toEqual({
    name: "我的保留草稿",
    expected_revision: "2",
  });
  expect(f.errors).toEqual([]);
});
test("disabled private library feature has no creation control", async ({
  page,
}) => {
  const f = await fixture(page, false);
  await page.goto("/libraries");
  await expect(page.getByText(/私人库创建与分享未开启/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "创建", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "确认分享指定影片" }),
  ).toHaveCount(0);
  expect(f.errors).toEqual([]);
});
test("library authorization page keeps original playing video and session", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.evaluate(() => {
    (window as any).__video = document.querySelector("video");
  });
  await page.getByRole("link", { name: "媒体库", exact: true }).first().click();
  await page
    .getByRole("link", { name: "我的媒体库与共享授权", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "我的媒体库与授权" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).__video === document.querySelector("video"),
    ),
  ).toBe(true);
  expect(f.preparations()).toBe(1);
  expect(f.connections()).toBe(1);
  expect(f.errors).toEqual([]);
});
