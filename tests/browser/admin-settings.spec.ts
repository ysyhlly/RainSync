import {
  expect,
  test,
  type Page,
  type Route,
  type Locator,
} from "@playwright/test";
import { appFixture } from "./fixtures/application";

test.beforeEach(({ isMobile }) => {
  test.skip(
    isMobile,
    "Desktop-first administrator audit; authentication policy and guest entry have dedicated mobile cases",
  );
});

const fields = [
  ["playback_session_limit", "同时播放会话上限"],
  ["media_queue_limit", "全局媒体准备队列上限"],
  ["registration_validate_per_minute", "邀请码校验频率"],
  ["registration_per_ten_minutes", "注册提交频率"],
] as const;
type Key = (typeof fields)[number][0];
const defaults: Record<Key, number> = {
  playback_session_limit: 4,
  media_queue_limit: 24,
  registration_validate_per_minute: 60,
  registration_per_ten_minutes: 10,
};
const overrides: Record<Key, number | null> = {
  playback_session_limit: 6,
  media_queue_limit: 40,
  registration_validate_per_minute: 70,
  registration_per_ten_minutes: 12,
};
function snapshot(revision = "7", custom: any = { ...overrides }) {
  const deploy: any = {
    ...defaults,
    registration_mode: "invite_only",
    guests_enabled: false,
  };
  const actualOverrides: any = {
    ...overrides,
    registration_mode: null,
    guests_enabled: null,
    ...custom,
  };
  return {
    revision,
    defaults: deploy,
    overrides: actualOverrides,
    values: Object.fromEntries(
      Object.keys(deploy).map((key) => [
        key,
        actualOverrides[key] ?? deploy[key],
      ]),
    ),
    origins: Object.fromEntries(
      Object.keys(deploy).map((key) => [
        key,
        actualOverrides[key] === null ? "deployment" : "override",
      ]),
    ),
    bounds: { min: 1, max: 10000 },
    deployment: {
      private_libraries_enabled: true,
      nas_compute_enabled: false,
      p2p_enabled: false,
      other_live_enabled: false,
      preview: {
        concurrency: 2,
        timeout_seconds: 30,
        cache_bytes: 104857600,
        queue_limit: 128,
        input_bytes: 10485760,
      },
    },
    updated_at: null,
  };
}
async function fixture(
  page: Page,
  options: { admin?: boolean; defaultsOnly?: boolean } = {},
) {
  const app = await appFixture(page, { admin: options.admin ?? true });
  let detail = snapshot(
    "7",
    options.defaultsOnly
      ? (Object.fromEntries(fields.map(([k]) => [k, null])) as Record<
          Key,
          null
        >)
      : { ...overrides },
  );
  let writeMode = "success",
    readMode = "success",
    pending: Route | undefined,
    pendingRead: Route | undefined;
  const writes: any[] = [],
    reads: string[] = [];
  const respondError = (route: Route, status: number, code: string) =>
    route.fulfill({
      status,
      json: {
        error: {
          code,
          message:
            "synthetic fixture: /private/sentinel-path secret-sentinel-value",
        },
      },
    });
  const commit = (body: any) => {
    detail = snapshot(String(Number(detail.revision) + 1), {
      ...detail.overrides,
      ...body.changes,
    });
    return detail;
  };
  await page.route("**/api/v1/auth/registration-policy", (route) =>
    route.fulfill({
      json: {
        registration_mode: detail.values.registration_mode,
        guests_enabled: detail.values.guests_enabled,
      },
    }),
  );
  await page.route("**/api/v1/admin/settings", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      reads.push(req.url());
      if (readMode === "busy") {
        pendingRead = route;
        return;
      }
      if (readMode === "error") return respondError(route, 503, "INTERNAL");
      if (readMode === "forbidden")
        return respondError(route, 403, "ADMIN_REQUIRED");
      if (readMode === "unauthorized")
        return respondError(route, 401, "SESSION_EXPIRED");
      if (readMode === "older") return route.fulfill({ json: snapshot() });
      return route.fulfill({ json: detail });
    }
    const body = req.postDataJSON();
    writes.push({ method: req.method(), body });
    if (writeMode === "busy") {
      pending = route;
      return;
    }
    if (writeMode === "conflict")
      return respondError(route, 409, "SETTINGS_REVISION_CONFLICT");
    if (writeMode === "forbidden")
      return respondError(route, 403, "ADMIN_REQUIRED");
    if (writeMode === "unauthorized")
      return respondError(route, 401, "SESSION_EXPIRED");
    if (writeMode === "invalid")
      return respondError(route, 400, "INVALID_ADMIN_SETTINGS");
    if (writeMode === "malformed") return route.fulfill({ json: { ok: true } });
    return route.fulfill({ json: commit(body) });
  });
  return {
    ...app,
    writes,
    reads,
    writeMode: (mode: string) => (writeMode = mode),
    readMode: (mode: string) => (readMode = mode),
    update: (revision: string, custom: any) =>
      (detail = snapshot(revision, custom)),
    hasPending: () => !!pending,
    hasPendingRead: () => !!pendingRead,
    finish: async () => {
      expect(pending).toBeTruthy();
      const r = pending!;
      pending = undefined;
      await r.fulfill({ json: commit(r.request().postDataJSON()) });
    },
    finishRead: async () => {
      expect(pendingRead).toBeTruthy();
      const r = pendingRead!;
      pendingRead = undefined;
      await r.fulfill({ json: detail });
    },
  };
}
const panel = (page: Page) => page.locator(".admin-settings-page");
const save = (page: Page) =>
  page.getByRole("button", { name: "保存修改", exact: true });
const input = (page: Page, key: Key) => page.locator("#setting-" + key);
const visibleLink = (page: Page, name: string) =>
  page
    .getByRole("link", { name, exact: true })
    .filter({ visible: true })
    .first();
async function open(page: Page) {
  await page.goto("/admin/settings");
  await expect(input(page, "playback_session_limit")).toHaveValue("6");
}
async function setCustom(page: Page, key: Key, value: string) {
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const label = fields.find(([k]) => k === key)![1];
  if (await input(page, key).isDisabled()) {
    await page
      .getByRole("combobox", { name: label + "的配置方式", exact: true })
      .click();
    await page
      .getByRole("option", { name: "自定义设置", exact: true })
      .filter({ visible: true })
      .click();
  }
  await input(page, key).fill(value);
  await expect(input(page, key)).toHaveValue(value);
}
async function noLeak(page: Page) {
  await expect(page.locator("body")).not.toContainText("secret-sentinel-value");
  await expect(page.locator("body")).not.toContainText(
    "/private/sentinel-path",
  );
}
async function accessibleBox(locator: Locator, page: Page) {
  await expect(locator).toBeInViewport({ ratio: 1 });
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const v = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(v.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(v.height + 1);
  expect(
    await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return !!hit && (el === hit || el.contains(hit));
    }),
  ).toBe(true);
}
async function demote(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/features/auth/session.store.ts";
    const { useSession } = await import(/* @vite-ignore */ path);
    const session = useSession();
    session.accept({ ...session.user, admin: false });
  });
}
for (const [width, height] of [
  [1280, 800],
  [1440, 900],
  [1920, 1080],
  [1280, 600],
]) {
  test(`desktop ${width}x${height}: navigation controls deployment and visible decisions`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    const f = await fixture(page);
    await page.goto("/rooms");
    await visibleLink(page, "管理员设置").click();
    await expect(page).toHaveURL(/\/admin\/settings$/);
    await expect(
      page.getByRole("heading", { name: "管理员设置", exact: true }),
    ).toBeVisible();
    await expect(panel(page).getByRole("spinbutton")).toHaveCount(4);
    await expect(save(page)).toBeDisabled();
    await expect(panel(page)).toContainText("后续请求");
    await expect(panel(page)).toContainText("已有会话");
    await page.screenshot({
      path: info.outputPath(`01-settings-top-${width}x${height}.png`),
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    for (const [key, label] of fields) {
      await expect(input(page, key)).toHaveValue(String(overrides[key]));
      await expect(input(page, key)).toHaveAttribute("aria-label", label);
      const mode = page.getByRole("combobox", {
        name: label + "的配置方式",
        exact: true,
      });
      await mode.scrollIntoViewIfNeeded();
      await mode.click();
      const option = page
        .getByRole("option", { name: "继承部署默认", exact: true })
        .filter({ visible: true });
      await accessibleBox(option, page);
      await page.keyboard.press("Escape");
      await expect(mode).toBeFocused();
      if (key === "media_queue_limit")
        await page.screenshot({
          path: info.outputPath(`02a-playback-controls-${width}x${height}.png`),
          animations: "disabled",
        });
    }
    await input(page, "registration_per_ten_minutes").scrollIntoViewIfNeeded();
    await input(page, "registration_per_ten_minutes").focus();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "恢复部署默认…", exact: true }),
    ).toBeFocused();
    await accessibleBox(
      page.getByRole("button", { name: "恢复部署默认…", exact: true }),
      page,
    );
    await page.screenshot({
      path: info.outputPath(`02-settings-actions-${width}x${height}.png`),
      animations: "disabled",
    });
    await setCustom(page, "playback_session_limit", "8");
    await page.getByRole("button", { name: "取消修改", exact: true }).click();
    const d = page.getByRole("dialog", {
      name: "放弃未保存的修改？",
      exact: true,
    });
    await expect(d).toBeVisible();
    for (const label of ["继续编辑", "放弃修改"])
      await accessibleBox(
        d.getByRole("button", { name: label, exact: true }),
        page,
      );
    await page.screenshot({
      path: info.outputPath(`03-settings-discard-${width}x${height}.png`),
      animations: "disabled",
    });
    await d.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(input(page, "playback_session_limit")).toHaveValue("8");
    await page.getByRole("button", { name: "取消修改", exact: true }).click();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(input(page, "playback_session_limit")).toHaveValue("6");
    expect(f.writes).toEqual([]);
    await page.locator("#settings-deployment").scrollIntoViewIfNeeded();
    await expect(page.locator("#settings-deployment")).toContainText("只读");
    await expect(page.locator("#settings-deployment")).toContainText(
      "不代表运行健康检查",
    );
    await expect(
      page.locator("#settings-deployment").getByRole("spinbutton"),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`04-settings-deployment-${width}x${height}.png`),
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await noLeak(page);
    expect(f.errors).toEqual([]);
  });
}

test("all four numeric controls save only explicit changed values and original revision", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await open(page);
  const values = ["8", "48", "90", "20"];
  for (let i = 0; i < fields.length; i++)
    await setCustom(page, fields[i][0], values[i]);
  await expect(panel(page)).toContainText("4 项修改待保存");
  await save(page).click();
  await expect(panel(page)).toContainText("设置已保存");
  await expect(save(page)).toBeDisabled();
  expect(f.writes).toEqual([
    {
      method: "PATCH",
      body: {
        expected_revision: "7",
        changes: {
          playback_session_limit: 8,
          media_queue_limit: 48,
          registration_validate_per_minute: 90,
          registration_per_ten_minutes: 20,
        },
      },
    },
  ]);
  for (let i = 0; i < fields.length; i++)
    await expect(input(page, fields[i][0])).toHaveValue(values[i]);
  await page.screenshot({
    path: info.outputPath("05-settings-saved.png"),
    animations: "disabled",
  });
  expect(f.reads).toHaveLength(2);
  expect(f.errors).toEqual([]);
});

test("deployment default reset is cancelable draft and requires explicit save", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await open(page);
  const reset = page.getByRole("button", {
    name: "恢复部署默认…",
    exact: true,
  });
  await reset.click();
  const d = page.getByRole("dialog", { name: "恢复部署默认值？", exact: true });
  await expect(d).toContainText("仍需点击");
  await page.screenshot({
    path: info.outputPath("06-reset-confirmation.png"),
    animations: "disabled",
  });
  await d.getByRole("button", { name: "取消", exact: true }).click();
  await expect(input(page, "playback_session_limit")).toHaveValue("6");
  expect(f.writes).toEqual([]);
  await reset.click();
  await d.getByRole("button", { name: "使用部署默认值", exact: true }).click();
  for (const [key] of fields) {
    await expect(input(page, key)).toHaveValue(String(defaults[key]));
    await expect(input(page, key)).toBeDisabled();
  }
  expect(f.writes).toEqual([]);
  await expect(save(page)).toBeEnabled();
  await page.getByRole("button", { name: "取消修改", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(input(page, "playback_session_limit")).toHaveValue("6");
  await reset.click();
  await d.getByRole("button", { name: "使用部署默认值", exact: true }).click();
  await save(page).click();
  await expect(panel(page)).toContainText("设置已保存");
  expect(f.writes).toEqual([
    {
      method: "PATCH",
      body: {
        expected_revision: "7",
        changes: Object.fromEntries(fields.map(([k]) => [k, null])),
      },
    },
  ]);
  await expect(reset).toBeDisabled();
  await expect(save(page)).toBeDisabled();
  await page.reload();
  await expect(input(page, "playback_session_limit")).toHaveValue("4");
  expect(f.errors).toEqual([]);
});

test("inherited values become custom through accessible selector and same-value override is real change", async ({
  page,
}) => {
  const f = await fixture(page, { defaultsOnly: true });
  await page.goto("/admin/settings");
  await expect(input(page, "playback_session_limit")).toHaveValue("4");
  await expect(input(page, "playback_session_limit")).toBeDisabled();
  await setCustom(page, "playback_session_limit", "4");
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(panel(page)).toContainText("设置已保存");
  expect(f.writes).toEqual([
    {
      method: "PATCH",
      body: { expected_revision: "7", changes: { playback_session_limit: 4 } },
    },
  ]);
  expect(f.errors).toEqual([]);
});

test("invalid blank zero decimal and oversized inputs are focused and cannot submit", async ({
  page,
}) => {
  const f = await fixture(page);
  await open(page);
  for (const value of ["", "0", "1.5", "10001"]) {
    await input(page, "playback_session_limit").fill(value);
    await save(page).click();
    await expect(input(page, "playback_session_limit")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(input(page, "playback_session_limit")).toBeFocused();
    await expect(panel(page)).toContainText("范围内的整数");
    expect(f.writes).toEqual([]);
  }
  await input(page, "playback_session_limit").fill("10000");
  await save(page).click();
  await expect(panel(page)).toContainText("设置已保存");
  expect(f.writes).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

test("dirty sidebar navigation continues editing or deliberately discards without writes", async ({
  page,
}) => {
  const f = await fixture(page);
  await open(page);
  await setCustom(page, "playback_session_limit", "8");
  await visibleLink(page, "放映室").click();
  const d = page.getByRole("dialog", { name: "离开管理员设置？", exact: true });
  await expect(d).toBeVisible();
  await d.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(input(page, "playback_session_limit")).toHaveValue("8");
  await visibleLink(page, "放映室").click();
  await d.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await visibleLink(page, "管理员设置").click();
  await expect(input(page, "playback_session_limit")).toHaveValue("6");
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("dirty browser Back keeps correct history after cancel then discard and Forward", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.goto("/rooms");
  await visibleLink(page, "管理员设置").click();
  await expect(input(page, "playback_session_limit")).toHaveValue("6");
  await setCustom(page, "playback_session_limit", "8");
  await page.evaluate(() => history.back());
  const d = page.getByRole("dialog", { name: "离开管理员设置？", exact: true });
  await expect(d).toBeVisible();
  await page.screenshot({
    path: info.outputPath("07-browser-back-dirty.png"),
    animations: "disabled",
  });
  await d.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(input(page, "playback_session_limit")).toHaveValue("8");
  await page.evaluate(() => history.back());
  await expect(d).toBeVisible();
  await d.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(input(page, "playback_session_limit")).toHaveValue("6");
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("pending save locks controls navigation Back and repeated keyboard submit to one write", async ({
  page,
}, info) => {
  const f = await fixture(page);
  f.writeMode("busy");
  await page.goto("/rooms");
  await visibleLink(page, "管理员设置").click();
  await setCustom(page, "playback_session_limit", "8");
  await save(page).click();
  await expect.poll(f.hasPending).toBe(true);
  for (const [key] of fields) await expect(input(page, key)).toBeDisabled();
  for (const label of [
    "注册方式的配置方式",
    "访客访问的配置方式",
    "注册方式",
    "访客访问",
  ])
    await expect(
      page.getByRole("combobox", { name: label, exact: true }),
    ).toBeDisabled();
  for (const name of ["正在保存…", "取消修改", "恢复部署默认…", "刷新设置"])
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await page.keyboard.press("Enter");
  await visibleLink(page, "放映室").click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(panel(page)).toContainText("正在保存设置，请等待结果后再离开");
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.writes).toHaveLength(1);
  await page.screenshot({
    path: info.outputPath("08-save-pending.png"),
    animations: "disabled",
  });
  await f.finish();
  await expect(panel(page)).toContainText("设置已保存");
  await expect(input(page, "playback_session_limit")).toHaveValue("8");
  await expect(save(page)).toBeDisabled();
  expect(f.writes).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

test("stale conflict preserves draft and requires deliberate successful reload before new revision save", async ({
  page,
}, info) => {
  const f = await fixture(page);
  f.writeMode("conflict");
  await open(page);
  await setCustom(page, "playback_session_limit", "8");
  await save(page).click();
  await expect(panel(page)).toContainText("设置已被其他管理员修改");
  await expect(input(page, "playback_session_limit")).toHaveValue("8");
  await expect(save(page)).toBeDisabled();
  await noLeak(page);
  await page.screenshot({
    path: info.outputPath("09-conflict.png"),
    animations: "disabled",
  });
  const reload = page.getByRole("button", {
    name: "重新载入最新设置…",
    exact: true,
  });
  await reload.click();
  const d = page.getByRole("dialog", {
    name: "重新载入最新设置？",
    exact: true,
  });
  await d.getByRole("button", { name: "继续编辑", exact: true }).click();
  expect(f.reads).toHaveLength(1);
  f.readMode("error");
  await reload.click();
  await d
    .getByRole("button", { name: "放弃输入并重新载入", exact: true })
    .click();
  await expect(panel(page)).toContainText("当前输入已保留");
  await expect(input(page, "playback_session_limit")).toHaveValue("8");
  await expect(save(page)).toBeDisabled();
  f.readMode("success");
  f.writeMode("success");
  f.update("9", { ...overrides, playback_session_limit: 9 });
  await reload.click();
  await d
    .getByRole("button", { name: "放弃输入并重新载入", exact: true })
    .click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(input(page, "playback_session_limit")).toBeEnabled();
  await expect(input(page, "playback_session_limit")).toHaveValue("9");
  await setCustom(page, "playback_session_limit", "10");
  await save(page).click();
  await expect(panel(page)).toContainText("设置已保存");
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1].body).toEqual({
    expected_revision: "9",
    changes: { playback_session_limit: 10 },
  });
  expect(f.errors).toEqual([]);
});

for (const [width, height] of [
  [1440, 900],
  [1280, 600],
])
  test(`confirmed save with refresh failure is visible at ${width}x${height} and never repeats write`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    const f = await fixture(page);
    await open(page);
    f.readMode("error");
    await setCustom(page, "playback_session_limit", "8");
    await save(page).click();
    await expect(panel(page)).toContainText(
      "已确认的修改已保存，但状态刷新失败",
    );
    await expect(input(page, "playback_session_limit")).toHaveValue("8");
    await expect(save(page)).toBeDisabled();
    await noLeak(page);
    await expect(page.locator(".settings-savebar")).toContainText(
      "已保存，状态待刷新",
    );
    await accessibleBox(
      page.getByRole("button", { name: "重试刷新状态", exact: true }),
      page,
    );
    await page.screenshot({
      path: info.outputPath("10-saved-refresh-failed.png"),
      animations: "disabled",
    });
    f.readMode("success");
    await page
      .getByRole("button", { name: "重试刷新状态", exact: true })
      .click();
    await expect(panel(page)).not.toContainText("状态刷新失败");
    await expect(save(page)).toBeDisabled();
    expect(f.writes).toHaveLength(1);
    expect(f.reads).toHaveLength(3);
    expect(f.errors).toEqual([]);
  });

test("lagging refresh cannot overwrite a newer confirmed receipt", async ({
  page,
}) => {
  const f = await fixture(page);
  await open(page);
  f.readMode("older");
  await setCustom(page, "playback_session_limit", "8");
  await save(page).click();
  await expect(panel(page)).toContainText("服务器读到了较早版本");
  await expect(input(page, "playback_session_limit")).toHaveValue("8");
  await expect(save(page)).toBeDisabled();
  expect(f.writes).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

test("unconfirmed malformed save response disables retry until explicit reload", async ({
  page,
}) => {
  const f = await fixture(page);
  await open(page);
  f.writeMode("malformed");
  await setCustom(page, "playback_session_limit", "8");
  await save(page).click();
  await expect(panel(page)).toContainText("保存响应不完整");
  await expect(save(page)).toBeDisabled();
  await expect(input(page, "playback_session_limit")).toHaveValue("8");
  expect(f.writes).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

for (const mode of ["forbidden", "unauthorized"])
  test(`${mode} response removes admin draft and cannot leak backend paths`, async ({
    page,
  }, info) => {
    const f = await fixture(page);
    await open(page);
    f.writeMode(mode);
    await setCustom(page, "playback_session_limit", "8");
    await save(page).click();
    await expect(input(page, "playback_session_limit")).toHaveCount(0);
    await noLeak(page);
    expect(f.writes).toHaveLength(1);
    if (mode === "forbidden")
      await expect(panel(page)).toContainText("管理员权限已失效");
    else await expect(page).toHaveURL(/\/login/);
    await page.screenshot({
      path: info.outputPath(`11-permission-${mode}.png`),
      animations: "disabled",
    });
    expect(f.errors).toEqual([]);
  });

test("non-admin direct route and navigation never fetch admin settings", async ({
  page,
}) => {
  const f = await fixture(page, { admin: false });
  await page.goto("/admin/settings");
  await expect(page).toHaveURL(/\/rooms(?:\?|$)/);
  await expect(
    page.getByRole("link", { name: "管理员设置", exact: true }),
  ).toHaveCount(0);
  expect(f.reads).toEqual([]);
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("forbidden initial read shows bounded access message without protected values", async ({
  page,
}) => {
  const f = await fixture(page);
  f.readMode("forbidden");
  await page.goto("/admin/settings");
  await expect(panel(page)).toContainText("管理员权限已失效");
  await expect(input(page, "playback_session_limit")).toHaveCount(0);
  await noLeak(page);
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("same-user demotion while save is pending clears page and late receipt cannot resurrect it", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await open(page);
  f.writeMode("busy");
  await setCustom(page, "playback_session_limit", "8");
  await save(page).click();
  await expect.poll(f.hasPending).toBe(true);
  await demote(page);
  await expect(input(page, "playback_session_limit")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "管理员设置", exact: true }),
  ).toHaveCount(0);
  await f.finish();
  await expect(input(page, "playback_session_limit")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("设置已保存");
  expect(f.writes).toHaveLength(1);
  await page.screenshot({
    path: info.outputPath("12-demoted-late-save.png"),
    animations: "disabled",
  });
  expect(f.errors).toEqual([]);
});

test("same-user demotion while read is pending fences late configuration", async ({
  page,
}) => {
  const f = await fixture(page);
  f.readMode("busy");
  await page.goto("/admin/settings");
  await expect.poll(f.hasPendingRead).toBe(true);
  await demote(page);
  await f.finishRead();
  await expect(input(page, "playback_session_limit")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "管理员设置", exact: true }),
  ).toHaveCount(0);
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("logout during save fences late receipt and returns to login", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await open(page);
  f.writeMode("busy");
  await setCustom(page, "playback_session_limit", "8");
  await save(page).click();
  await expect.poll(f.hasPending).toBe(true);
  await page
    .getByRole("button", { name: "退出登录", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/login/);
  await f.finish();
  await expect(page).toHaveURL(/\/login/);
  await expect(input(page, "playback_session_limit")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("设置已保存");
  expect(f.writes).toHaveLength(1);
  await page.screenshot({
    path: info.outputPath("13-logout-late-save.png"),
    animations: "disabled",
  });
  expect(f.errors).toEqual([]);
});

test("administration landing redirects to settings and manager links navigate to object settings", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(input(page, "playback_session_limit")).toHaveValue("6");
  await panel(page)
    .getByRole("link", { name: /片源管理 编辑片源/ })
    .click();
  await expect(page).toHaveURL(/\/admin\/sources$/);
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

async function selectOption(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page
    .getByRole("option", { name: option, exact: true })
    .filter({ visible: true })
    .click();
}
async function setAccess(page: Page, registration: string, guests: string) {
  await selectOption(page, "注册方式的配置方式", "自定义设置");
  await selectOption(page, "注册方式", registration);
  await selectOption(page, "访客访问的配置方式", "自定义设置");
  await selectOption(page, "访客访问", guests);
}
test("opening registration and restricted guest access needs explicit disclosure and can be canceled", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await open(page);
  await setAccess(page, "开放自行注册", "允许受限访客");
  await save(page).click();
  const d = page.getByRole("dialog", {
    name: "确认开放访问入口？",
    exact: true,
  });
  await expect(d).toBeVisible();
  await expect(d).toContainText("访客");
  await expect(d).toContainText("注册");
  expect(f.writes).toEqual([]);
  await page.screenshot({
    path: info.outputPath("14-access-open-confirmation.png"),
    animations: "disabled",
  });
  await d.getByRole("button", { name: "取消", exact: true }).click();
  await expect(save(page)).toBeEnabled();
  expect(f.writes).toEqual([]);
  await save(page).click();
  await d.getByRole("button", { name: "确认开放并保存", exact: true }).click();
  await expect(panel(page)).toContainText("设置已保存");
  expect(f.writes).toEqual([
    {
      method: "PATCH",
      body: {
        expected_revision: "7",
        changes: { registration_mode: "open", guests_enabled: true },
      },
    },
  ]);
  await expect(
    page.getByRole("combobox", { name: "注册方式", exact: true }),
  ).toContainText("开放自行注册");
  await expect(
    page.getByRole("combobox", { name: "访客访问", exact: true }),
  ).toContainText("允许受限访客");
  await expect(save(page)).toBeDisabled();
  expect(f.errors).toEqual([]);
});

test("closing registration and disabling guests saves authoritative boolean false without open warning", async ({
  page,
}) => {
  const f = await fixture(page);
  f.update("7", {
    ...overrides,
    registration_mode: "open",
    guests_enabled: true,
  });
  await open(page);
  await selectOption(page, "注册方式", "关闭注册");
  await selectOption(page, "访客访问", "禁用访客");
  await save(page).click();
  await expect(panel(page)).toContainText("设置已保存");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.writes).toEqual([
    {
      method: "PATCH",
      body: {
        expected_revision: "7",
        changes: { registration_mode: "closed", guests_enabled: false },
      },
    },
  ]);
  expect(f.errors).toEqual([]);
});

test("resetting open registration and guests restores all six deployment defaults only after save", async ({
  page,
}, info) => {
  const f = await fixture(page);
  f.update("7", {
    ...overrides,
    registration_mode: "open",
    guests_enabled: true,
  });
  await open(page);
  await page
    .getByRole("button", { name: "恢复部署默认…", exact: true })
    .click();
  await page
    .getByRole("button", { name: "使用部署默认值", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "注册方式", exact: true }),
  ).toContainText("仅邀请码注册");
  await expect(
    page.getByRole("combobox", { name: "访客访问", exact: true }),
  ).toContainText("禁用访客");
  await expect(
    page.getByRole("combobox", { name: "注册方式", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "访客访问", exact: true }),
  ).toBeDisabled();
  expect(f.writes).toEqual([]);
  await page.screenshot({
    path: info.outputPath("15-six-defaults-draft.png"),
    animations: "disabled",
  });
  await save(page).click();
  await expect(panel(page)).toContainText("设置已保存");
  expect(f.writes).toEqual([
    {
      method: "PATCH",
      body: {
        expected_revision: "7",
        changes: {
          ...Object.fromEntries(fields.map(([k]) => [k, null])),
          registration_mode: null,
          guests_enabled: null,
        },
      },
    },
  ]);
  expect(f.errors).toEqual([]);
});
