import { mediaExtraResponse } from "./fixtures/media";
import { test, expect, type Route } from "@playwright/test";

for (const predecessor of ["login", "register"]) {
  test(`abandoned ${predecessor} cannot overwrite a later login cookie`, async ({
    page,
    context,
  }) => {
    let delayed: Route | undefined;
    const identity = (name: string) => ({
      id: name,
      username: name,
      display_name: name,
      custom_display_name: null,
      admin: false,
      csrf: `csrf-${name}`,
      avatar_url: null,
      avatar_version: null,
    });
    const response = (name: string, register = false) => ({
      status: register ? 201 : 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": `probe_session=${name}; Path=/; HttpOnly; SameSite=Lax`,
      },
      body: JSON.stringify(
        register ? identity(name) : { csrf: `csrf-${name}` },
      ),
    });
    await page.route("**/api/v1/**", async (route) => {
      const extra = mediaExtraResponse(route);
      if (extra) return extra;
      const request = route.request(),
        path = new URL(request.url()).pathname.replace("/api/v1", "");
      const name = (await request.allHeaders()).cookie?.match(
        /(?:^|; )probe_session=([^;]+)/,
      )?.[1];
      if (path === "/auth/registration-policy")
        return route.fulfill({
          json: { registration_mode: "invite_only", guests_enabled: false },
        });
      if (path === "/auth/login" || path === "/auth/register") {
        const submitted = request.postDataJSON().username;
        if (submitted === "alice") {
          delayed = route;
          return;
        }
        return route.fulfill(response(submitted));
      }
      if (path === "/auth/registration-invites/validate")
        return route.fulfill({ json: { expires_at: Date.now() + 86400000 } });
      if (path === "/auth/me" || path === "/users/me/profile")
        return route.fulfill({
          status: name ? 200 : 401,
          json: name
            ? identity(name)
            : { error: { code: "LOGIN_REQUIRED", message: "请登录" } },
        });
      return route.fulfill({ json: [] });
    });
    await page.goto(`/${predecessor}`);
    if (predecessor === "register") {
      await page
        .getByLabel("注册邀请码", { exact: true })
        .fill("synthetic-invite");
      await page.getByRole("button", { name: "验证并继续" }).click();
      await page.getByLabel("确认密码", { exact: true }).fill("password-a");
    }
    await page.getByLabel("登录账号", { exact: true }).fill("alice");
    await page.getByLabel("密码", { exact: true }).fill("password-a");
    await page
      .getByRole("button", {
        name: predecessor === "login" ? "登录" : "注册并登录",
        exact: true,
      })
      .click();
    await expect.poll(() => !!delayed).toBe(true);
    if (predecessor === "login")
      await page.getByRole("link", { name: "使用邀请码注册" }).click();
    await page.getByRole("link", { name: "返回登录" }).click();
    await page.getByLabel("登录账号", { exact: true }).fill("bob");
    await page.getByLabel("密码", { exact: true }).fill("password-b");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "放映室", exact: true }),
    ).toBeVisible();
    expect(
      (await context.cookies()).find((c) => c.name === "probe_session")?.value,
    ).toBe("bob");
    await delayed!.fulfill(response("alice", predecessor === "register"));
    // The later profile read crosses another network boundary and must use Bob.
    await page
      .getByRole("link", { name: "个人资料", exact: true })
      .filter({ visible: true })
      .click();
    await expect(page.getByLabel("登录账号", { exact: true })).toHaveValue(
      "bob",
    );
    expect(
      (await context.cookies()).find((c) => c.name === "probe_session")?.value,
    ).toBe("bob");
    await expect(page.locator(".sidebar-account b")).toHaveText("bob");
  });
}
