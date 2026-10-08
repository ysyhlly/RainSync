import { test, expect, type Route } from "@playwright/test";
import { appFixture } from "./fixtures/application";

test("room guest permission requires explicit save and explains global gate and revocation", async ({
  page,
}, info) => {
  const app = await appFixture(page);
  let enabled = false;
  const writes: unknown[] = [];
  await page.route("**/api/v1/rooms/room/guest-access", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      writes.push(body);
      enabled = body.enabled;
    }
    await route.fulfill({ json: { enabled, guests_enabled: false } });
  });
  await page.goto("/rooms/room");
  await page.getByRole("button", { name: "房间管理", exact: true }).click();
  await page.getByRole("button", { name: "游客访问", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "游客访问", exact: true });
  const toggle = dialog.getByRole("checkbox", {
    name: "允许游客凭邀请进入此房间",
    exact: true,
  });
  await expect(toggle).not.toBeChecked();
  await expect(dialog).toContainText("实例的游客模式尚未开启");
  await expect(dialog).toContainText("重新开启不会恢复旧会话");
  await toggle.check();
  await dialog
    .getByRole("button", { name: "关闭游客访问", exact: true })
    .click();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "游客访问", exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.screenshot({
    path: info.outputPath("room-guest-permission.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "保存游客设置", exact: true })
    .click();
  await expect(dialog).toContainText("此房间已允许游客凭有效观看邀请进入");
  expect(writes).toEqual([{ enabled: true }]);
  await toggle.uncheck();
  await dialog
    .getByRole("button", { name: "保存游客设置", exact: true })
    .click();
  await expect(dialog).toContainText("游客入口已关闭，现有游客会话已撤销");
  expect(writes).toEqual([{ enabled: true }, { enabled: false }]);
  expect(app.errors).toEqual([]);
});

test("room guest read failure cannot save and pending writes lock the rendered controls", async ({
  page,
}) => {
  const app = await appFixture(page);
  let failRead = true,
    pending: Route | undefined;
  const writes: unknown[] = [];
  await page.route("**/api/v1/rooms/room/guest-access", async (route) => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON());
      pending = route;
      return;
    }
    if (failRead)
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "游客设置暂时无法读取",
          },
        },
      });
    return route.fulfill({ json: { enabled: false, guests_enabled: true } });
  });
  await page.goto("/rooms/room");
  await page.getByRole("button", { name: "房间管理", exact: true }).click();
  await page.getByRole("button", { name: "游客访问", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "游客访问", exact: true });
  const toggle = dialog.getByRole("checkbox", {
    name: "允许游客凭邀请进入此房间",
    exact: true,
  });
  const save = dialog.getByRole("button", {
    name: "保存游客设置",
    exact: true,
  });
  await expect(dialog.getByRole("alert")).toContainText("游客设置暂时无法读取");
  await expect(toggle).toBeDisabled();
  await expect(save).toBeDisabled();
  await dialog
    .getByRole("button", { name: "关闭游客访问", exact: true })
    .click();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  failRead = false;
  await page.getByRole("button", { name: "游客访问", exact: true }).click();
  await toggle.check();
  await save.click();
  await expect.poll(() => !!pending).toBe(true);
  await expect(toggle).toBeDisabled();
  await expect(save).toBeDisabled();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(writes).toEqual([{ enabled: true }]);
  await pending!.fulfill({ json: { enabled: true, guests_enabled: true } });
  await expect(dialog).toContainText("此房间已允许游客凭有效观看邀请进入");
  expect(writes).toHaveLength(1);
  expect(app.errors).toEqual([]);
});
