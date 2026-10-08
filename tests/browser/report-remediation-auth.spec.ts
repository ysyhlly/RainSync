import { test, expect, type Page } from "@playwright/test";
import { appFixture } from "./fixtures/application";

const roomId = "11111111-1111-4111-8111-111111111111";
const token = "a".repeat(64);
const invitePath = `/invite/${roomId}#token=${token}`;
async function invitationFixture(
  page: Page,
  mode: "valid" | "revoked" | "expired" = "valid",
  loggedIn = false,
) {
  const app = await appFixture(page, { loggedIn, admin: false });
  Object.assign(app.room, { id: roomId, name: "邀请验收放映室" });
  Object.assign(app.state, {
    room_id: roomId,
    media_id: null,
    media_generation: 0,
  });
  const guest = {
    ...app.identity,
    id: "guest",
    username: "guest",
    admin: false,
    csrf: "guest-csrf",
    guest: true,
    guest_room_id: roomId,
    guest_expires_at: Date.now() + 7200000,
  };
  let isGuest = false;
  const joins: unknown[] = [],
    guestPosts: unknown[] = [],
    requestURLs: string[] = [],
    referrers: string[] = [];
  page.on("request", (request) => {
    requestURLs.push(request.url());
    referrers.push(request.headers().referer ?? "");
  });
  await page.route("**/api/v1/auth/registration-policy", (route) =>
    route.fulfill({
      json: { registration_mode: "open", guests_enabled: true },
    }),
  );
  await page.route("**/api/v1/auth/me", (route) =>
    isGuest ? route.fulfill({ json: guest }) : route.fallback(),
  );
  const deny = (route: import("@playwright/test").Route) =>
    route.fulfill({
      status: 403,
      json: {
        error: {
          code: "INVALID_INVITE",
          message: mode === "revoked" ? "邀请已撤销" : "邀请已过期",
        },
      },
    });
  await page.route(`**/api/v1/rooms/${roomId}/guest-session`, (route) => {
    guestPosts.push(route.request().postDataJSON());
    if (mode !== "valid") return deny(route);
    isGuest = true;
    return route.fulfill({ status: 201, json: guest });
  });
  await page.route(`**/api/v1/rooms/${roomId}/join`, (route) => {
    joins.push(route.request().postDataJSON());
    return mode === "valid"
      ? route.fulfill({ json: { ok: true } })
      : deny(route);
  });
  return { ...app, joins, guestPosts, requestURLs, referrers };
}
function themeControl(page: Page) {
  return page
    .getByRole("combobox", { name: "界面主题", exact: true })
    .filter({ visible: true })
    .first();
}

test("H3: a shared invitation supports account login, explicit join, and cleans the URL without leaking its capability", async ({
  page,
}, info) => {
  const app = await invitationFixture(page);
  await page.goto(invitePath);
  await expect(
    page.getByRole("heading", { name: "加入受邀房间", exact: true }),
  ).toBeVisible();
  await expect(page.locator("details.guest-entry")).toHaveAttribute("open", "");
  expect(app.joins).toHaveLength(0);
  await page.getByLabel("登录账号", { exact: true }).fill("owner");
  await page.getByLabel("密码", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认加入房间", exact: true }),
  ).toBeVisible();
  expect(app.joins).toHaveLength(0);
  await expect(
    page.locator(".page-enter-active, .page-leave-active"),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("invite-account-confirm.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "确认加入房间", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${roomId}$`));
  await expect(
    page.getByRole("heading", { name: "邀请验收放映室", exact: true }),
  ).toBeVisible();
  expect(app.joins).toEqual([{ token }]);
  expect(app.guestPosts).toEqual([]);
  expect(app.requestURLs.some((url) => url.includes(token))).toBe(false);
  expect(app.referrers.some((value) => value.includes(token))).toBe(false);
  expect(app.errors).toEqual([]);
});

test("H3: a valid invitation enters through the guest flow and removes the token", async ({
  page,
}) => {
  const app = await invitationFixture(page);
  await page.goto(invitePath);
  await page.getByLabel("访客昵称（可选）", { exact: true }).fill("验收访客");
  await page
    .getByRole("button", { name: "作为受限访客进入", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${roomId}$`));
  await expect(
    page.getByRole("heading", { name: "邀请验收放映室", exact: true }),
  ).toBeVisible();
  expect(app.guestPosts).toEqual([{ token, display_name: "验收访客" }]);
  expect(app.joins).toEqual([]);
  expect(app.requestURLs.some((url) => url.includes(token))).toBe(false);
  expect(app.referrers.some((value) => value.includes(token))).toBe(false);
  await expect(
    page.getByRole("link", { name: "媒体库", exact: true }),
  ).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

for (const mode of ["revoked", "expired"] as const)
  test(`H3/M1: ${mode} guest invitations retain a local error and the expanded guest section`, async ({
    page,
  }, info) => {
    const app = await invitationFixture(page, mode);
    await page.goto(invitePath);
    await page
      .getByRole("button", { name: "作为受限访客进入", exact: true })
      .click();
    const details = page.locator("details.guest-entry");
    await expect(details).toHaveAttribute("open", "");
    await expect(details.getByRole("alert")).toContainText(
      "暂时无法通过此邀请进入",
    );
    await expect(page.locator("#login-error")).toHaveCount(0);
    expect(app.guestPosts).toHaveLength(1);
    expect(app.joins).toHaveLength(0);
    await expect(page).toHaveURL(
      new RegExp(`/invite/${roomId}#token=${token}$`),
    );
    await page.screenshot({
      path: info.outputPath(`invite-${mode}-guest-error.png`),
      fullPage: true,
    });
    expect(app.errors).toEqual([]);
  });

test("H3: a revoked account invitation cannot create an old room intent", async ({
  page,
}) => {
  const app = await invitationFixture(page, "revoked", true);
  await page.goto(invitePath);
  await page.getByRole("button", { name: "确认加入房间", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("邀请已撤销");
  expect(app.joins).toEqual([{ token }]);
  await expect(page).toHaveURL(new RegExp(`/invite/${roomId}#token=${token}$`));
  await expect(
    page.getByRole("heading", { name: "邀请验收放映室", exact: true }),
  ).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test("H3: signup from an invitation keeps the capability out of the redirect query and resumes confirmation", async ({
  page,
}) => {
  const app = await invitationFixture(page);
  let registrations = 0;
  await page.route("**/api/v1/auth/register", (route) => {
    registrations++;
    const input = route.request().postDataJSON();
    app.signIn({ username: input.username, admin: false });
    return route.fulfill({ status: 201, json: app.identity });
  });
  await page.goto(invitePath);
  await page.getByRole("link", { name: "创建账号", exact: true }).click();
  await expect(page).toHaveURL(/\/register\?redirect=/);
  await expect(
    page.getByRole("heading", { name: "创建账号", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("redirect")).toBe(
    `/invite/${roomId}`,
  );
  expect(page.url()).not.toContain(token);
  await page.getByLabel("登录账号", { exact: true }).fill("new.viewer");
  await page.getByLabel("密码", { exact: true }).fill("synthetic-password");
  await page.getByLabel("确认密码", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "注册并登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认加入房间", exact: true }),
  ).toBeVisible();
  expect(registrations).toBe(1);
  expect(app.joins).toHaveLength(0);
  await page.getByRole("button", { name: "确认加入房间", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${roomId}$`));
  expect(app.joins).toEqual([{ token }]);
  expect(app.requestURLs.some((url) => url.includes(token))).toBe(false);
  expect(app.errors).toEqual([]);
});

test("M4/L1/L2: empty auth forms use Chinese local errors, preserve logo position and balanced registration", async ({
  page,
}, info) => {
  const app = await appFixture(page, { loggedIn: false, admin: false });
  await page.route("**/api/v1/auth/registration-policy", (route) =>
    route.fulfill({
      json: { registration_mode: "open", guests_enabled: true },
    }),
  );
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/(login|register|guest-session)$/.test(new URL(request.url()).pathname)
    )
      mutations.push(request.url());
  });
  await page.goto("/login");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator("#login-username-error")).toHaveText(
    "请填写登录账号。",
  );
  await expect(page.getByLabel("登录账号", { exact: true })).toBeFocused();
  const logoBefore = await page
    .getByRole("link", { name: "RainSync", exact: true })
    .boundingBox();
  await page.locator("details.guest-entry summary").click();
  const logoAfter = await page
    .getByRole("link", { name: "RainSync", exact: true })
    .boundingBox();
  expect(Math.abs(logoBefore!.y - logoAfter!.y)).toBeLessThan(1);
  await expect(page.locator(".guest-chevron")).toBeVisible();
  await page
    .getByRole("button", { name: "作为受限访客进入", exact: true })
    .click();
  await expect(page.locator("details.guest-entry #guest-error")).toContainText(
    "请粘贴",
  );
  await page.goto("/register");
  await page.getByRole("button", { name: "注册并登录", exact: true }).click();
  await expect(page.locator(".form-field #register-error")).toHaveText(
    "请填写登录账号。",
  );
  const steps = await page.locator(".registration-steps").boundingBox(),
    form = await page.locator(".registration-form").boundingBox();
  expect(Math.abs(steps!.x - form!.x)).toBeLessThan(1);
  expect(Math.abs(steps!.width - form!.width)).toBeLessThan(1);
  expect(form!.y).toBeGreaterThanOrEqual(steps!.y + steps!.height - 1);
  expect(mutations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("registration-open-validation.png"),
    fullPage: true,
  });
  expect(app.errors).toEqual([]);
});

test("M3: a cold library route displays its title and skeleton while its module is still pending", async ({
  page,
}, info) => {
  const app = await appFixture(page, { admin: false });
  let release!: () => void,
    intercepted = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    /\/src\/features\/library\/LibraryPage\.vue(?:\?|$)/,
    async (route) => {
      intercepted = true;
      await gate;
      await route.fallback();
    },
  );
  await page.goto("/rooms");
  await expect(
    page.getByRole("heading", { name: "放映室", exact: true }),
  ).toBeVisible();
  try {
    await page
      .getByRole("link", { name: "媒体库", exact: true })
      .filter({ visible: true })
      .click();
    await expect.poll(() => intercepted).toBe(true);
    await expect(page.locator(".route-loading")).toBeVisible({ timeout: 1000 });
    await expect(page.locator(".route-loading")).toContainText("媒体库");
    await expect(page.locator(".route-loading-skeleton")).toBeVisible();
    await expect(page.locator("#main-content")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await page.screenshot({
      path: info.outputPath("library-cold-route-loading.png"),
      fullPage: true,
    });
  } finally {
    release();
  }
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator(".route-loading")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "媒体库", exact: true }),
  ).toBeVisible();
  expect(app.errors).toEqual([]);
});

test("M10: an anonymous unknown route displays a public 404", async ({
  page,
}) => {
  const app = await appFixture(page, { loggedIn: false });
  await page.goto("/nonexistent-xyz");
  await expect(
    page.getByRole("heading", { name: "页面不存在", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/nonexistent-xyz$/);
  await expect(
    page.getByRole("heading", { name: "登录", exact: true }),
  ).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

async function contrastOfAuth(page: Page) {
  return page.evaluate(() => {
    const luminance = (value: string) => {
      const rgb = value
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((value) => value / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
    };
    const contrast = (a: string, b: string) => {
      const x = luminance(a),
        y = luminance(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const button = getComputedStyle(
      document.querySelector<HTMLButtonElement>(".auth-panel button.primary")!,
    );
    const eyebrow = getComputedStyle(document.querySelector(".page-eyebrow")!);
    const panel = getComputedStyle(document.querySelector(".auth-panel")!);
    return {
      button: contrast(button.color, button.backgroundColor),
      secondary: contrast(eyebrow.color, panel.backgroundColor),
    };
  });
}
test("M9/L4: actual light and dark button contrast meets AA, choices persist and system mode follows the OS", async ({
  page,
}, info) => {
  const app = await appFixture(page, { loggedIn: false });
  await page.goto("/login");
  for (const theme of ["light", "dark"] as const) {
    await themeControl(page).selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const ratios = await contrastOfAuth(page);
    expect(ratios.button).toBeGreaterThanOrEqual(4.5);
    expect(ratios.secondary).toBeGreaterThanOrEqual(4.5);
    await page.getByRole("button", { name: "登录", exact: true }).hover();
    expect((await contrastOfAuth(page)).button).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({
      path: info.outputPath(`login-${theme}-theme.png`),
      fullPage: true,
    });
  }
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(themeControl(page)).toHaveValue("dark");
  await themeControl(page).selectOption("system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(app.errors).toEqual([]);
});

for (const width of [560, 600, 630, 880])
  test(`L2/L12: ${width}px pages use full-width content and an accessible compact navigation`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const app = await appFixture(page, { admin: false });
    await page.goto("/rooms");
    await expect(
      page.getByRole("heading", { name: "放映室", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".sidebar")).not.toBeVisible();
    await expect(page.locator(".mobile-header")).toBeVisible();
    await expect(page.locator(".bottom-nav")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page
      .getByRole("link", { name: "媒体库", exact: true })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.locator(".route-loading")).toHaveCount(0);
    await expect(
      page
        .locator(".library-page")
        .getByRole("heading", { name: "媒体库", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(".page-enter-active, .page-leave-active"),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await themeControl(page).selectOption(width === 880 ? "dark" : "light");
    await page.evaluate(async () => {
      const finite = document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        );
      await Promise.all(
        finite.map((animation) => animation.finished.catch(() => {})),
      );
    });
    await page.screenshot({
      path: info.outputPath(`library-width-${width}.png`),
      fullPage: true,
    });
    expect(app.errors).toEqual([]);
  });

test("L6/M8: a long profile keeps its sidebar full-height and an unconnected Bilibili status has one consistent conclusion", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const app = await appFixture(page, { admin: false });
  await page.goto("/account/profile");
  await expect(
    page.getByRole("heading", { name: "个人资料", exact: true }),
  ).toBeVisible();
  const bili = page.locator("#bilibili-account");
  await expect(bili.getByText("未连接", { exact: true })).toBeVisible();
  await expect(bili).not.toContainText("此服务器已解除连接");
  await expect(bili).toContainText("扫码连接后");
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const side = await page.locator(".sidebar").boundingBox();
  expect(side!.y).toBe(0);
  expect(side!.height).toBe(900);
  await page.screenshot({
    path: info.outputPath("profile-scrolled-sidebar.png"),
    fullPage: false,
  });
  expect(app.errors).toEqual([]);
});
