import { test, expect, type Page } from "@playwright/test";
import { appFixture, openFixtureSource } from "./fixtures/application";

async function privateLibraryFixture(page: Page) {
  const app = await appFixture(page);
  const mutations: { path: string; method: string; body: any }[] = [];
  const detail = {
    id: "private",
    name: "家庭影片",
    owner_id: "owner",
    visibility: "private",
    revision: "7",
    permission_epoch: "3",
    permissions: {
      browse: true,
      play: true,
      share_to_room: true,
      manage: true,
    },
    sources: [
      {
        id: "source",
        name: "家庭片源",
        kind: "http",
        access_policy_revision: 1,
      },
    ],
    grants: [
      {
        user_id: "viewer",
        username: "friend",
        expires_at: 2_000_000_000_000,
        browse: true,
        play: true,
        share_to_room: false,
        manage: false,
      },
    ],
    room_shares: [
      {
        id: "share",
        media_id: "movie",
        room_id: "room",
        title: "家庭短片",
        mode: "room_members",
        expires_at: 2_000_000_000_000,
        active: true,
      },
    ],
    audit: [],
  };
  await page.route("**/api/v1/libraries**", (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET")
      mutations.push({
        path,
        method: request.method(),
        body: request.postDataJSON(),
      });
    if (path === "/api/v1/libraries/issued-shares")
      return route.fulfill({ json: { items: [], has_more: false } });
    if (path === "/api/v1/libraries")
      return route.fulfill({ json: { enabled: true, items: [detail] } });
    if (path.endsWith("/media")) return route.fulfill({ json: [app.media[0]] });
    return route.fulfill({ json: detail });
  });
  return { ...app, mutations };
}

test("room filters combine search and lifecycle and recover from no matches", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.route("**/api/v1/rooms", (route) =>
    route.fulfill({
      json: [
        { ...app.room, name: "周末放映室", lifecycle: "active" },
        {
          id: "history",
          name: "去年的放映室",
          owner_id: "owner",
          lifecycle: "closed",
        },
      ],
    }),
  );
  await page.goto("/rooms");
  await expect(page.locator(".room-card")).toHaveCount(2);
  await page.getByLabel("搜索放映室").fill("没有这个房间");
  await expect(
    page.getByRole("heading", { name: "没有匹配的放映室" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看全部房间" }).click();
  await page.getByRole("combobox", { name: "房间状态" }).click();
  await page.getByRole("option", { name: "已关闭", exact: true }).click();
  await expect(page.locator(".room-card")).toHaveCount(1);
  await expect(page.locator(".room-card")).toContainText("去年的放映室");
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page.locator(".room-card")).toHaveCount(2);
  expect(app.errors).toEqual([]);
});

test("failed room loading survives opening and cancelling either dialog, then retries", async ({
  page,
}) => {
  const app = await appFixture(page);
  let fail = true;
  await page.route("**/api/v1/rooms", (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: {
            error: { code: "UNAVAILABLE", message: "放映室列表暂时不可用" },
          },
        })
      : route.fulfill({ json: [app.room] }),
  );
  await page.goto("/rooms");
  await expect(page.getByRole("alert")).toContainText("放映室列表暂时不可用");
  for (const title of ["通过邀请加入", "创建房间"]) {
    await page.getByRole("button", { name: title, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("alert")).toContainText("放映室列表暂时不可用");
    await expect(
      page.getByRole("button", { name: "重新加载", exact: true }),
    ).toBeEnabled();
  }
  fail = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.locator(".room-card")).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(app.commands).toEqual([]);
  expect(app.errors).toEqual([]);
});

test("empty media search offers a working reset without changing room selection", async ({
  page,
}) => {
  const app = await appFixture(page, { admin: false });
  await page.goto("/library");
  await openFixtureSource(page);
  await expect(page.locator(".media-card")).toHaveCount(24);
  await page.getByLabel("搜索影片").fill("未收录的影片");
  await page.getByLabel("搜索影片").press("Enter");
  await expect(
    page.getByRole("heading", { name: "没有找到匹配影片" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除搜索" }).click();
  await expect(page.getByLabel("搜索影片")).toHaveValue("");
  await expect(page.locator(".media-card")).toHaveCount(24);
  expect(app.commands).toEqual([]);
  expect(app.errors).toEqual([]);
});

for (const action of [
  {
    name: "账户撤销",
    trigger: "撤销",
    dialog: "撤销账户授权",
    confirm: "确认撤销授权",
    path: "/grants/viewer",
    method: "DELETE",
  },
  {
    name: "分享撤销",
    trigger: "撤销分享",
    dialog: "撤销房间分享",
    confirm: "确认撤销分享",
    path: "/room-shares/share",
    method: "DELETE",
  },
  {
    name: "所有权转移",
    trigger: "转移所有权",
    dialog: "转移媒体库所有权",
    confirm: "确认转移所有权",
    path: "/transfer",
    method: "POST",
    summary: "转移媒体库所有权",
    field: "新所有者的固定登录账号",
    value: "next-owner",
  },
  {
    name: "片源迁移",
    trigger: "迁入当前库",
    dialog: "迁移片源归属",
    confirm: "确认迁入当前库",
    path: "/attach-source",
    method: "POST",
    summary: "迁移已有片源（管理员）",
    field: "片源 ID",
    value: "existing-source",
  },
]) {
  test(`${action.name} requires confirmation and cancel preserves the draft`, async ({
    page,
  }, info) => {
    const app = await privateLibraryFixture(page);
    await page.goto("/libraries");
    await expect(page.getByLabel("媒体库名称", { exact: true })).toHaveValue(
      "家庭影片",
    );
    if (action.summary)
      await page.locator("summary").filter({ hasText: action.summary }).click();
    if (action.field)
      await page.getByLabel(action.field, { exact: true }).fill(action.value!);
    const trigger = page.getByRole("button", {
      name: action.trigger,
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: action.dialog,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("家庭影片");
    expect(app.mutations).toEqual([]);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(app.mutations).toEqual([]);
    if (action.field)
      await expect(page.getByLabel(action.field, { exact: true })).toHaveValue(
        action.value!,
      );
    await trigger.click();
    await dialog
      .getByRole("button", { name: action.confirm, exact: true })
      .click();
    await expect(dialog).toBeHidden();
    expect(app.mutations).toHaveLength(1);
    expect(app.mutations[0]).toMatchObject({
      path: `/api/v1/libraries/private${action.path}`,
      method: action.method,
      body: { expected_revision: "7" },
    });
    expect(app.errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath("private-library-confirmed.png"),
      fullPage: true,
    });
  });
}

test("private library loading failure is recoverable and an empty list is explained", async ({
  page,
}) => {
  const app = await appFixture(page, { admin: false });
  let fail = true;
  await page.route("**/api/v1/libraries", (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: { error: { code: "UNAVAILABLE", message: "媒体库暂时不可用" } },
        })
      : route.fulfill({ json: { enabled: true, items: [] } }),
  );
  await page.goto("/libraries");
  await expect(page.getByRole("alert")).toContainText("媒体库暂时不可用");
  fail = false;
  await page.getByRole("button", { name: "重新加载媒体库" }).click();
  await expect(
    page.getByRole("heading", { name: "还没有可访问的媒体库" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "创建", exact: true }),
  ).toBeDisabled();
  expect(app.errors).toEqual([]);
});

test("successful ownership transfer closes confirmation even when the list refresh fails", async ({
  page,
}) => {
  const app = await privateLibraryFixture(page);
  let transferCount = 0,
    failRefresh = false;
  await page.route("**/api/v1/libraries", (route) =>
    failRefresh
      ? route.fulfill({
          status: 503,
          json: {
            error: { code: "UNAVAILABLE", message: "转移后的列表刷新失败" },
          },
        })
      : route.fallback(),
  );
  await page.route("**/api/v1/libraries/private/transfer", (route) => {
    transferCount++;
    failRefresh = true;
    return route.fulfill({ json: { transferred: true } });
  });
  await page.goto("/libraries");
  await page.locator("summary").filter({ hasText: "转移媒体库所有权" }).click();
  await page
    .getByLabel("新所有者的固定登录账号", { exact: true })
    .fill("next-owner");
  await page.getByRole("button", { name: "转移所有权", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "转移媒体库所有权",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "确认转移所有权", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("所有权已转移，原所有者不保留默认权限", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("转移后的列表刷新失败");
  await expect(
    page.getByRole("button", { name: "重新加载媒体库", exact: true }),
  ).toBeEnabled();
  expect(transferCount).toBe(1);
  failRefresh = false;
  await page
    .getByRole("button", { name: "重新加载媒体库", exact: true })
    .click();
  await expect(page.getByLabel("媒体库名称", { exact: true })).toHaveValue(
    "家庭影片",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(transferCount).toBe(1);
  expect(app.errors).toEqual([]);
});
