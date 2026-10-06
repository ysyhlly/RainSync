import { test, expect, type Page, type Locator } from "@playwright/test";
import { appFixture, appBase } from "./fixtures/application";
const widths = [360, 390, 768, 1024, 1440, 1920];
async function setup(page: Page, loggedIn = true) {
  const app = await appFixture(page, { loggedIn });
  await page.route("**/users/me/profile", (r) =>
    r.fulfill({ json: app.identity }),
  );
  await page.route("**/api/v1/admin/registration-invites**", (r) =>
    r.fulfill({
      json: { items: [], next_cursor: null, server_time: Date.now() },
    }),
  );
  return app;
}
async function fits(page: Page, expectedWidth: number) {
  // Mobile visual/layout viewports can settle on different frames after resize.
  // Read both values atomically and require the actual requested CSS width,
  // rather than accidentally accepting a zoom-expanded viewport.
  await expect
    .poll(() =>
      page.evaluate(() => ({
        content: document.documentElement.scrollWidth,
        viewport: innerWidth,
      })),
    )
    .toEqual({ content: expectedWidth, viewport: expectedWidth });
  const overflow = await page
    .locator(
      "main button:visible, main input:visible, main select:visible, main textarea:visible",
    )
    .evaluateAll((els) =>
      els
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
        })
        .map((el) => el.getAttribute("aria-label") || el.textContent),
    );
  expect(overflow).toEqual([]);
}
async function reachable(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport();
  expect(
    await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return hit === el || el.contains(hit);
    }),
  ).toBe(true);
}

test("all authenticated pages fit six required widths with accessible primary controls", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const app = await setup(page);
  for (const [path, title] of [
    ["/rooms", "放映室"],
    ["/rooms/room", "周末放映室"],
    ["/library", "媒体库"],
    ["/account/profile", "个人资料"],
    ["/admin/sources", "片源管理"],
    ["/admin/agents", "NAS 设备"],
    ["/admin/registration-invites", "账号与注册"],
    ["/admin/users", "账号与注册"],
  ]) {
    await page.goto(appBase + path);
    await expect(
      page.getByRole("heading", { name: title, exact: true }).first(),
    ).toBeVisible();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      await fits(page, width);
    }
  }
  await page.setViewportSize({ width: 360, height: 720 });
  await reachable(page.getByRole("button", { name: "创建普通账号" }));
  await page.screenshot({
    path: info.outputPath("admin-360.png"),
    fullPage: true,
  });
  expect(app.errors).toEqual([]);
});

test("anonymous forms and admin drawers keep actions reachable at mobile and desktop widths", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await setup(page, false);
  await page.route("**/auth/registration-invites/validate", (r) =>
    r.fulfill({ json: { expires_at: Date.now() + 86400000 } }),
  );
  for (const path of ["/login", "/register"]) {
    await page.goto(appBase + path);
    await expect(page.locator(".auth-page")).toBeVisible();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 740 });
      await fits(page, width);
    }
  }
  await page.getByLabel("注册邀请码", { exact: true }).fill("RS-SYNTHETIC");
  await page.getByRole("button", { name: "验证并继续" }).click();
  await expect(page.getByLabel("登录账号", { exact: true })).toBeFocused();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 740 });
    await fits(page, width);
    await reachable(page.getByRole("button", { name: "注册并登录" }));
  }
  await setup(page, true);
  for (const [path, action, submit] of [
    ["/admin/sources", "添加片源", "保存片源"],
    ["/admin/agents", "添加设备", "生成配对码"],
    ["/admin/registration-invites", "生成邀请码", "生成 1 个邀请码"],
  ]) {
    await page.goto(appBase + path);
    await page.getByRole("button", { name: action, exact: true }).click();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 740 });
      await fits(page, width);
      await reachable(page.getByRole("button", { name: submit, exact: true }));
    }
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: action, exact: true }),
    ).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: info.outputPath("admin-1440.png"),
    fullPage: true,
  });
});

test("beige semantic text contrast, keyboard focus and reduced motion are measurable", async ({
  page,
}) => {
  await setup(page);
  await page.goto(appBase + "/rooms");
  await expect(
    page.getByRole("heading", { name: "放映室", exact: true }),
  ).toBeVisible();
  const contrasts = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement),
      value = (key: string) => css.getPropertyValue(key).trim();
    const luminance = (hex: string) => {
      const rgb = hex
        .replace("#", "")
        .match(/../g)!
        .map((v) => parseInt(v, 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const ratio = (a: string, b: string) => {
      const l = [luminance(value(a)), luminance(value(b))].sort(
        (x, y) => y - x,
      );
      return (l[0] + 0.05) / (l[1] + 0.05);
    };
    return [
      ratio("--text-primary", "--surface-canvas"),
      ratio("--text-secondary", "--surface-panel"),
      ratio("--text-secondary", "--surface-muted"),
      ratio("--text-on-accent", "--accent"),
      ratio("--danger", "--surface-panel"),
    ];
  });
  for (const ratio of contrasts) expect(ratio).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator(".brand:visible svg")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "跳转到内容" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await page.getByRole("button", { name: "创建房间", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("dialog")),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "创建房间", exact: true }),
  ).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.getByRole("button", { name: "创建房间", exact: true }).click();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => parseFloat(getComputedStyle(el).animationDuration)),
  ).toBeLessThan(0.001);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
  ).toBe("light");
});

test("soft keyboard viewport hides overlays without removing video or reconnecting", async ({
  page,
}) => {
  const app = await setup(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(appBase + "/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.evaluate(() => {
    (window as any).__keyboardVideo = document.querySelector("video");
  });
  await page
    .getByRole("link", { name: "媒体库", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.locator(".mini-player")).toBeVisible();
  await page.getByLabel("搜索影片").focus();
  await page.evaluate(() => {
    Object.defineProperty(visualViewport!, "height", {
      configurable: true,
      get: () => innerHeight - 300,
    });
    visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator(".mini-player")).not.toBeVisible();
  await expect(page.locator(".bottom-nav")).not.toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).__keyboardVideo === document.querySelector("video"),
    ),
  ).toBe(true);
  await page.evaluate(() => {
    delete (visualViewport as any).height;
    visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator(".mini-player")).toBeVisible();
  expect(app.connections()).toBe(1);
  expect(app.preparations()).toBe(1);
  expect(app.errors).toEqual([]);
});
test("empty player uses the cream panel while video letterboxing is neutral", async ({
  page,
}) => {
  const app = await appFixture(page);
  app.state.media_id = null as any;
  await page.goto("/rooms/room");
  await expect(page.getByText("尚未选择影片").first()).toBeVisible();
  await expect(page.locator(".video-frame")).toHaveCSS(
    "background-color",
    "rgb(252, 249, 242)",
  );
  await expect(page.locator("video")).toHaveCSS(
    "background-color",
    "rgb(252, 249, 242)",
  );
});
