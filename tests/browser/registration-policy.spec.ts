import { test, expect, type Page, type Route } from "@playwright/test";
import { appFixture } from "./fixtures/application";

type Mode = "closed" | "invite_only" | "open";
async function policyFixture(page: Page, initial: Mode = "invite_only") {
  const app = await appFixture(page, { loggedIn: false, admin: false });
  let mode = initial;
  const requests: { method: string; path: string; body: unknown }[] = [];
  await page.route("**/api/v1/auth/registration-policy", (route) =>
    route.fulfill({
      json: { registration_mode: mode, guests_enabled: false },
    }),
  );
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path.startsWith("/api/v1/"))
      requests.push({
        method: request.method(),
        path,
        body: request.postData() ? request.postDataJSON() : undefined,
      });
  });
  return {
    ...app,
    requests,
    setMode: (next: Mode) => {
      mode = next;
    },
  };
}
async function credentials(page: Page) {
  await page.getByLabel("登录账号", { exact: true }).fill("new.viewer");
  await page.getByLabel("密码", { exact: true }).fill("fixture-password");
  await page.getByLabel("确认密码", { exact: true }).fill("fixture-password");
}

test("open registration skips invitation and submits a normal account without an invite field", async ({
  page,
}, info) => {
  const app = await policyFixture(page, "open");
  await page.route("**/api/v1/auth/register", async (route) => {
    const body = route.request().postDataJSON();
    app.signIn({ username: body.username, admin: false });
    await route.fulfill({ status: 201, json: app.identity });
  });
  await page.goto("/login");
  await page.getByRole("link", { name: "创建账号", exact: true }).click();
  await expect(page.getByLabel("注册邀请码", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "设置账号", exact: true }),
  ).toBeVisible();
  await credentials(page);
  await page.screenshot({
    path: info.outputPath("open-registration.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "注册并登录", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  const registrations = app.requests.filter((request) =>
    request.path.endsWith("/auth/register"),
  );
  expect(registrations).toHaveLength(1);
  expect(registrations[0].body).toEqual({
    username: "new.viewer",
    password: "fixture-password",
    display_name: "",
  });
  expect(
    app.requests.some(
      (request) =>
        request.path.includes("registration-invites") ||
        request.path.endsWith("/join"),
    ),
  ).toBe(false);
  expect(app.errors).toEqual([]);
});

test("closed registration hides the login signup link and deep-linked register cannot submit", async ({
  page,
}, info) => {
  const app = await policyFixture(page, "closed");
  await page.goto("/login");
  await expect(
    page.getByText("当前已关闭新账号注册。已有账号可继续登录。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "创建账号", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "使用邀请码注册", exact: true }),
  ).toHaveCount(0);
  await page.goto(
    "/register?redirect=" + encodeURIComponent("/rooms/room?invite=test"),
  );
  await expect(
    page.getByRole("heading", { name: "当前暂停新账号注册", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "注册并登录", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("密码", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("closed-registration.png"),
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "返回登录", exact: true })
    .last()
    .click();
  expect(new URL(page.url()).searchParams.get("redirect")).toBe(
    "/rooms/room?invite=test",
  );
  expect(app.requests).toEqual([]);
  expect(app.errors).toEqual([]);
});

test("unavailable registration policy fails closed and a deliberate retry restores the current mode", async ({
  page,
}) => {
  const app = await policyFixture(page, "open");
  let unavailable = true;
  await page.route("**/api/v1/auth/registration-policy", async (route) =>
    unavailable
      ? route.fulfill({
          json: { registration_mode: "untrusted-mode", guests_enabled: true },
        })
      : route.fallback(),
  );
  await page.goto("/register");
  await expect(page.getByRole("alert")).toContainText(
    "暂时无法读取注册与访客入口状态",
  );
  await expect(page.getByLabel("登录账号", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "注册并登录", exact: true }),
  ).toHaveCount(0);
  unavailable = false;
  await page
    .getByRole("button", { name: "重试读取注册方式", exact: true })
    .click();
  await expect(page.getByLabel("登录账号", { exact: true })).toBeVisible();
  await expect(page.getByLabel("注册邀请码", { exact: true })).toHaveCount(0);
  expect(app.requests).toEqual([]);
  expect(app.errors).toEqual([]);
});

test("policy loading cannot grant signup while normal account login remains usable", async ({
  page,
}) => {
  const app = await policyFixture(page, "open");
  let pending: Route | undefined;
  await page.route("**/api/v1/auth/registration-policy", (route) => {
    pending = route;
  });
  await page.goto("/login");
  await expect.poll(() => !!pending).toBe(true);
  await expect(
    page.getByRole("link", { name: "创建账号", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("登录账号", { exact: true }).fill("owner");
  await page.getByLabel("密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await pending!.fulfill({
    json: { registration_mode: "open", guests_enabled: false },
  });
  await expect(page).toHaveURL(/\/rooms$/);
  expect(
    app.requests.filter((request) => request.path.endsWith("/auth/login")),
  ).toHaveLength(1);
  expect(
    app.requests.filter((request) => request.path.endsWith("/auth/register")),
  ).toHaveLength(0);
  expect(app.errors).toEqual([]);
});

test("open registration becoming closed at submit removes the form and cannot repeat submission", async ({
  page,
}) => {
  const app = await policyFixture(page, "open");
  await page.route("**/api/v1/auth/register", async (route) => {
    app.setMode("closed");
    await route.fulfill({
      status: 403,
      json: {
        error: { code: "REGISTRATION_CLOSED", message: "新账号注册已关闭" },
      },
    });
  });
  await page.goto("/register");
  await credentials(page);
  await page.getByRole("button", { name: "注册并登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "当前暂停新账号注册", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "注册并登录", exact: true }),
  ).toHaveCount(0);
  expect(
    app.requests.filter((request) => request.path.endsWith("/auth/register")),
  ).toHaveLength(1);
  expect(app.errors).toEqual([]);
});

test("open registration becoming invite-only requires fresh invitation validation", async ({
  page,
}) => {
  const app = await policyFixture(page, "open");
  await page.route("**/api/v1/auth/register", async (route) => {
    app.setMode("invite_only");
    await route.fulfill({
      status: 400,
      json: {
        error: {
          code: "REGISTRATION_INVITE_INVALID",
          message: "需要有效注册邀请码",
        },
      },
    });
  });
  await page.goto("/register");
  await credentials(page);
  await page.getByRole("button", { name: "注册并登录", exact: true }).click();
  await expect(page.getByLabel("注册邀请码", { exact: true })).toBeVisible();
  await expect(page.getByLabel("注册邀请码", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("密码", { exact: true })).toHaveCount(0);
  expect(
    app.requests.filter((request) => request.path.endsWith("/auth/register")),
  ).toHaveLength(1);
  expect(app.errors).toEqual([]);
});
