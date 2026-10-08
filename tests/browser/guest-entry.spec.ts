import { test, expect, type Page } from "@playwright/test";
import { appFixture } from "./fixtures/application";

const guestRoom = "00000000-0000-4000-8000-000000000001";
const invitation = { room_id: guestRoom, token: "a".repeat(64) };
async function guestFixture(page: Page, mode: "success" | "lost" = "success") {
  const app = await appFixture(page, { loggedIn: false, admin: false });
  Object.assign(app.room, { id: guestRoom, name: "访客测试房间" });
  Object.assign(app.state, {
    room_id: guestRoom,
    media_id: null,
    media_generation: 0,
  });
  const identity = {
    id: "guest-one",
    username: "guest_one",
    display_name: "受限访客",
    custom_display_name: null,
    admin: false,
    csrf: "guest-csrf",
    avatar_url: null,
    avatar_version: null,
    guest: true,
    guest_room_id: guestRoom,
    guest_expires_at: Date.now() + 7200000,
  };
  const log: string[] = [],
    posts: any[] = [];
  let committed = 0,
    logouts = 0;
  const cookie = async (request: any) =>
    (await request.allHeaders()).cookie ?? "";
  await page.route("**/api/v1/auth/registration-policy", (route) =>
    route.fulfill({
      json: { registration_mode: "invite_only", guests_enabled: true },
    }),
  );
  await page.route("**/api/v1/auth/me", async (route) => {
    const value = await cookie(route.request());
    log.push(
      "me:" +
        (value.includes("fixture_guest=new")
          ? "new"
          : value.includes("fixture_guest=old")
            ? "old"
            : value.includes("fixture_guest=normal")
              ? "normal"
              : "none"),
    );
    if (value.includes("fixture_guest=new"))
      return route.fulfill({ json: identity });
    if (value.includes("fixture_guest=normal"))
      return route.fulfill({ json: { ...app.identity, guest: false } });
    return route.fulfill({
      status: 401,
      json: {
        error: {
          code: value.includes("fixture_guest=old")
            ? "SESSION_EXPIRED"
            : "LOGIN_REQUIRED",
          message: "请重新登录",
        },
      },
    });
  });
  await page.route(
    `**/api/v1/rooms/${guestRoom}/guest-session`,
    async (route) => {
      posts.push(route.request().postDataJSON());
      const value = await cookie(route.request());
      log.push(
        "create:" + (value.includes("fixture_guest=") ? "existing" : "empty"),
      );
      if (value.includes("fixture_guest="))
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "ALREADY_AUTHENTICATED",
              message: "请先退出已有会话",
            },
          },
        });
      committed++;
      const headers = {
        "Set-Cookie": "fixture_guest=new; Path=/; HttpOnly; SameSite=Strict",
      };
      if (mode === "lost")
        return route.fulfill({
          status: 201,
          headers,
          contentType: "application/json",
          body: '{"id":',
        });
      return route.fulfill({ status: 201, headers, json: identity });
    },
  );
  await page.route("**/api/v1/auth/logout", async (route) => {
    logouts++;
    log.push("logout");
    return route.fulfill({
      json: { ok: true },
      headers: {
        "Set-Cookie":
          "fixture_guest=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
      },
    });
  });
  return {
    ...app,
    posts,
    log,
    committed: () => committed,
    logouts: () => logouts,
  };
}
async function fillGuest(page: Page) {
  await page.goto("/login");
  await page
    .locator("summary")
    .filter({ hasText: "使用房间邀请作为访客进入" })
    .click();
  await page
    .getByLabel("房间邀请 JSON 或本站邀请链接", { exact: true })
    .fill(JSON.stringify(invitation));
  await page.getByLabel("访客昵称（可选）", { exact: true }).fill("受限访客");
}

test("expired guest recovery button really logs out the old cookie before another entry", async ({
  page,
}, info) => {
  const app = await guestFixture(page);
  await page.context().addCookies([
    {
      name: "fixture_guest",
      value: "old",
      url: "http://127.0.0.1",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  await fillGuest(page);
  await page
    .getByRole("button", { name: "作为受限访客进入", exact: true })
    .click();
  const clear = page.getByRole("button", {
    name: "退出旧访客会话",
    exact: true,
  });
  await expect(clear).toBeVisible();
  expect(app.posts).toHaveLength(1);
  expect(app.committed()).toBe(0);
  expect(app.logouts()).toBe(0);
  await page.screenshot({
    path: info.outputPath("expired-guest-recovery.png"),
    fullPage: true,
  });
  await clear.click();
  await expect(
    page.getByText("旧会话已退出，请确认邀请仍有效后再点击进入。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "作为受限访客进入", exact: true }),
  ).toBeEnabled();
  expect(app.logouts()).toBe(1);
  expect(
    (await page.context().cookies()).find(
      (cookie) => cookie.name === "fixture_guest",
    ),
  ).toBeUndefined();
  expect(app.posts).toHaveLength(1);
  await page
    .getByRole("button", { name: "作为受限访客进入", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${guestRoom}$`));
  await expect(
    page.getByRole("heading", { name: "访客测试房间", exact: true }),
  ).toBeVisible();
  expect(app.posts).toEqual([
    { token: invitation.token, display_name: "受限访客" },
    { token: invitation.token, display_name: "受限访客" },
  ]);
  expect(app.committed()).toBe(1);
  expect(app.log.indexOf("logout")).toBeLessThan(
    app.log.lastIndexOf("create:empty"),
  );
  await expect(
    page.getByRole("link", { name: "媒体库", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "管理员设置", exact: true }),
  ).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test("lost guest creation response reconciles the accepted cookie through me without another creation", async ({
  page,
}, info) => {
  const app = await guestFixture(page, "lost");
  await fillGuest(page);
  await page
    .getByRole("button", { name: "作为受限访客进入", exact: true })
    .click();
  const recover = page.getByRole("button", {
    name: "确认当前访客会话",
    exact: true,
  });
  await expect(recover).toBeVisible();
  await expect(
    page.getByRole("button", { name: "作为受限访客进入", exact: true }),
  ).toHaveCount(0);
  expect(app.posts).toHaveLength(1);
  expect(app.committed()).toBe(1);
  await page.screenshot({
    path: info.outputPath("lost-guest-response.png"),
    fullPage: true,
  });
  await recover.click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${guestRoom}$`));
  await expect(
    page.getByRole("heading", { name: "访客测试房间", exact: true }),
  ).toBeVisible();
  expect(app.posts).toHaveLength(1);
  expect(app.log).toContain("me:new");
  expect(app.logouts()).toBe(0);
  await expect(
    page.getByRole("link", { name: "个人资料", exact: true }),
  ).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test("guest cleanup protects a registered account that appeared in another tab", async ({
  page,
}) => {
  const app = await guestFixture(page);
  await page.context().addCookies([
    {
      name: "fixture_guest",
      value: "old",
      url: "http://127.0.0.1",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  await fillGuest(page);
  await page
    .getByRole("button", { name: "作为受限访客进入", exact: true })
    .click();
  const clear = page.getByRole("button", {
    name: "退出旧访客会话",
    exact: true,
  });
  await expect(clear).toBeVisible();
  await page.context().addCookies([
    {
      name: "fixture_guest",
      value: "normal",
      url: "http://127.0.0.1",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  await clear.click();
  await expect(page).toHaveURL(/\/rooms$/);
  expect(app.logouts()).toBe(0);
  expect(app.posts).toHaveLength(1);
  expect(app.log).toContain("me:normal");
  expect(app.errors).toEqual([]);
});

test("pasted off-site guest invitations are rejected locally without sharing the invitation", async ({
  page,
}) => {
  const app = await guestFixture(page);
  const external: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "outside.example.test")
      external.push(request.url());
  });
  await fillGuest(page);
  await page
    .getByLabel("房间邀请 JSON 或本站邀请链接", { exact: true })
    .fill(
      `https://outside.example.test/rooms/${guestRoom}?invite=${invitation.token}`,
    );
  await page
    .getByRole("button", { name: "作为受限访客进入", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("房间邀请格式无效");
  await expect(page).toHaveURL(/\/login$/);
  expect(external).toEqual([]);
  expect(app.posts).toEqual([]);
  expect(app.logouts()).toBe(0);
  expect(app.errors).toEqual([]);
});
