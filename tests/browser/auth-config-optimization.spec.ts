import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";

test("authentication links preserve the original path, query and hash", async ({
  page,
}) => {
  const app = await appFixture(page, { loggedIn: false });
  const target = "/account/profile?from=fixture#bilibili-account";
  await page.goto(target);
  await expect(
    page.getByRole("heading", { name: "登录", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("redirect")).toBe(target);
  await page.getByRole("link", { name: "使用邀请码注册" }).click();
  expect(new URL(page.url()).searchParams.get("redirect")).toBe(target);
  await page.getByRole("link", { name: "返回登录" }).click();
  expect(new URL(page.url()).searchParams.get("redirect")).toBe(target);
  await page.getByLabel("登录账号", { exact: true }).fill("owner");
  await page.getByLabel("密码", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "个人资料", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"),
  );
  expect(app.errors).toEqual([]);
});

test("registration returns to the explicit room destination without sending a join", async ({
  page,
}) => {
  const app = await appFixture(page, { loggedIn: false });
  const target = "/rooms/unjoined?invite=fixture#confirmation";
  let joins = 0;
  page.on("request", (request) => {
    if (request.url().includes("/join")) joins++;
  });
  await page.route("**/auth/registration-invites/validate", (route) =>
    route.fulfill({ json: { expires_at: Date.now() + 86400000 } }),
  );
  await page.route("**/auth/register", async (route) => {
    const input = route.request().postDataJSON();
    app.signIn({ username: input.username, admin: false });
    await route.fulfill({ status: 201, json: app.identity });
  });
  await page.goto("/login?redirect=" + encodeURIComponent(target));
  await page.getByRole("link", { name: "使用邀请码注册" }).click();
  await page.getByLabel("注册邀请码", { exact: true }).fill("RS-SYNTHETIC");
  await page.getByRole("button", { name: "验证并继续" }).click();
  await page.getByLabel("登录账号", { exact: true }).fill("new.user");
  await page.getByLabel("密码", { exact: true }).fill("synthetic-password");
  await page.getByLabel("确认密码", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "注册并登录", exact: true }).click();
  await expect(page).toHaveURL(
    /\/rooms\/unjoined\?invite=fixture#confirmation$/,
  );
  await expect(
    page
      .getByText("你尚未加入此放映室，请通过房间邀请加入。", { exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
  expect(joins).toBe(0);
  expect(app.errors).toEqual([]);
});

for (const loggedIn of [true, false]) {
  test(`startup retry preserves the initial target when authenticated=${loggedIn}`, async ({
    page,
  }) => {
    const app = await appFixture(page, { loggedIn });
    let attempts = 0;
    await page.route("**/auth/me", async (route) => {
      if (++attempts === 1) await route.abort("connectionfailed");
      else await route.fallback();
    });
    const target = "/account/profile?from=retry#bilibili-account";
    await page.goto(target);
    await expect(
      page.getByRole("heading", { name: "暂时无法连接" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "重试连接" }).click();
    if (loggedIn) {
      await expect(
        page.getByRole("heading", { name: "个人资料", exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(
        /\/account\/profile\?from=retry#bilibili-account$/,
      );
    } else {
      await expect(
        page.getByRole("heading", { name: "登录", exact: true }),
      ).toBeVisible();
      expect(new URL(page.url()).searchParams.get("redirect")).toBe(target);
    }
    expect(app.errors).toEqual([]);
  });
}

test("source advanced validation, guarded dismissal and confirmed-write recovery", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  let reads = 0,
    writes = 0,
    submitted: any;
  await page.route("**/api/v1/sources", async (route) => {
    if (route.request().method() === "POST") {
      writes++;
      submitted = route.request().postDataJSON();
      return route.fulfill({ json: { id: "fixture-source" } });
    }
    if (++reads === 2) return route.abort("connectionfailed");
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin/sources");
  await page.getByRole("button", { name: "添加片源", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加片源", exact: true });
  await dialog.getByLabel("名称", { exact: true }).fill("HTTP fixture");
  await dialog.getByRole("combobox", { name: "类型", exact: true }).click();
  await page
    .getByRole("option", { name: "HTTP MP4 / HLS", exact: true })
    .click();
  await dialog
    .getByLabel("媒体或服务 URL")
    .fill("https://fixture.test/video.mp4");
  await expect(dialog.getByLabel("请求头 JSON（可选）")).not.toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "保存片源" }),
  ).toBeInViewport();
  await page.screenshot({ path: info.outputPath("http-source-basic.png") });
  const summary = dialog.locator("summary");
  await summary.click();
  await dialog.getByLabel("请求头 JSON（可选）").fill('{"Authorization":3}');
  await summary.click();
  await dialog.getByRole("button", { name: "保存片源" }).click();
  await expect(dialog.getByLabel("请求头 JSON（可选）")).toBeFocused();
  await expect(dialog.getByLabel("请求头 JSON（可选）")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(writes).toBe(0);
  await dialog
    .getByLabel("请求头 JSON（可选）")
    .fill('{"X-Fixture":"synthetic"}');
  await expect(dialog.getByLabel("请求头 JSON（可选）")).toHaveAttribute(
    "aria-invalid",
    "false",
  );
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("button", { name: "继续编辑" })).toBeFocused();
  await dialog.getByRole("button", { name: "继续编辑" }).click();
  await expect(dialog.getByLabel("请求头 JSON（可选）")).toHaveValue(
    '{"X-Fixture":"synthetic"}',
  );
  await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  await dialog.getByRole("button", { name: "继续编辑" }).click();
  const bounds = await dialog.boundingBox();
  if (bounds && bounds.x > 16) {
    // Desktop exposes the backdrop. The narrow drawer fills the viewport,
    // so the same coordinate is inside the editor and must not dismiss it.
    await page.mouse.click(bounds.x - 8, 120);
    await expect(
      dialog.getByRole("button", { name: "继续编辑" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "继续编辑" }).click();
  } else {
    await page.mouse.click(10, 120);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("名称", { exact: true })).toHaveValue(
      "HTTP fixture",
    );
  }
  await dialog.getByRole("button", { name: "保存片源" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("片源已添加，可检测并扫描影片", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "片源已添加，但列表暂未更新",
  );
  await page.getByRole("button", { name: "重新加载列表", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(writes).toBe(1);
  expect(submitted.config.headers).toEqual({ "X-Fixture": "synthetic" });
  await page.getByRole("button", { name: "添加片源", exact: true }).click();
  await expect(dialog.getByLabel("名称", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  await expect(dialog).not.toBeVisible();
  expect(app.errors).toEqual([]);
});

test("Bilibili revocation replaces old enabled renewal text without a manual refresh", async ({
  page,
}) => {
  await appFixture(page);
  let account = {
    id: "00000000-0000-0000-0000-000000000001",
    provider: "bilibili",
    revision: "1",
    state: "connected",
  };
  await page.route("**/platform-accounts/bilibili", async (route) => {
    if (route.request().method() === "DELETE")
      account = { ...account, revision: "2", state: "revoked" };
    return route.fulfill({ json: account });
  });
  await page.route("**/platform-accounts/bilibili/renewal", (route) =>
    route.fulfill({
      json: {
        account,
        method: "web_cookie_refresh",
        supported: true,
        enabled: account.state === "connected",
        state: account.state === "connected" ? "scheduled" : "disabled",
        next_refresh_at:
          account.state === "connected" ? Date.now() + 10000 : null,
        enable_requires: "new_consented_qr_login",
      },
    }),
  );
  await page.goto("/account/profile");
  const panel = page.locator("#bilibili-account");
  await expect(
    panel.getByRole("button", { name: "停止自动续期" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "解除连接", exact: true }).click();
  await page
    .getByRole("dialog", { name: "解除 Bilibili 连接" })
    .getByRole("button", { name: "确认解除连接", exact: true })
    .click();
  await expect(
    panel.getByText("此服务器已解除连接，自动续期已停止", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "停止自动续期" })).toHaveCount(
    0,
  );
  await expect(panel).not.toContainText("已同意后台自动续期");
});
