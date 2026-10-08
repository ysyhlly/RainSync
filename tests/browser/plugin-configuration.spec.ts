import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";

const id = "metadata.duration-badge";
const catalog = [
  {
    id,
    name: "时长标签",
    description: "合成测试插件",
    versions: [{ version: "1.0.0", artifact_digest: "a".repeat(64) }],
  },
  {
    id: "metadata.title-label",
    name: "影片说明标签",
    description: "合成测试插件",
    versions: [{ version: "1.0.0", artifact_digest: "b".repeat(64) }],
  },
];
const saved = {
  id,
  version: "1.0.0",
  enabled: true,
  config: { format: "clock" },
  granted_permissions: ["metadata:read"],
  revision: "7",
  can_rollback: true,
};

test("plugin removal confirms impact, supports cancellation and preserves revision fencing for reinstall", async ({
  page,
}, testInfo) => {
  const app = await appFixture(page);
  let installed = true,
    revision = "7";
  const deletes: unknown[] = [],
    puts: any[] = [];
  await page.route("**/api/v1/admin/plugins**", async (route) => {
    const method = route.request().method();
    if (method === "DELETE") {
      deletes.push(route.request().postDataJSON());
      installed = false;
      revision = "8";
      return route.fulfill({ json: { id, removed: true, revision } });
    }
    if (method === "PUT") {
      puts.push(route.request().postDataJSON());
      installed = true;
      revision = "9";
      return route.fulfill({
        json: { ...saved, ...puts.at(-1), revision, can_rollback: false },
      });
    }
    return route.fulfill({
      json: {
        catalog,
        installed: installed ? [{ ...saved, revision }] : [],
        configuration_revisions: { [id]: revision },
      },
    });
  });
  await page.goto("/admin/plugins");
  const card = page
    .locator(".plugin-card")
    .filter({
      has: page.getByRole("heading", { name: "时长标签", exact: true }),
    });
  const trigger = card.getByRole("button", {
    name: "删除配置并停用",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "删除插件配置" });
  await expect(dialog).toContainText("时长标签");
  await expect(dialog).toContainText("修订 7");
  await expect(dialog).toContainText("上一次可回退的配置");
  await expect(dialog).toContainText("原媒体与播放不受影响");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(deletes).toEqual([]);
  await trigger.click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  expect(deletes).toEqual([]);
  await trigger.click();
  await dialog
    .getByRole("button", { name: "确认删除配置并停用", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(deletes).toEqual([{ expected_revision: "7" }]);
  await expect(card.getByText("未安装", { exact: true })).toBeVisible();
  await expect(trigger).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "安装插件", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("插件配置和上一次配置已删除", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("plugin-configuration-removed.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "刷新目录与状态" }).click();
  await card.getByRole("checkbox", { name: /授予 metadata:read/ }).check();
  await card.getByRole("button", { name: "安装插件", exact: true }).click();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toMatchObject({
    expected_revision: "8",
    enabled: false,
    config: { format: "minutes" },
    granted_permissions: ["metadata:read"],
  });
  expect(app.errors).toEqual([]);
});

test("plugin remove conflicts remain visible inside the modal and can be cancelled", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.route("**/api/v1/admin/plugins**", async (route) => {
    if (route.request().method() === "DELETE")
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "PLUGIN_REVISION_CONFLICT",
            message: "配置修订已更新",
          },
        },
      });
    return route.fulfill({
      json: {
        catalog,
        installed: [saved],
        configuration_revisions: { [id]: "7" },
      },
    });
  });
  await page.goto("/admin/plugins");
  await page
    .getByRole("button", { name: "删除配置并停用", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "删除插件配置" });
  await dialog
    .getByRole("button", { name: "确认删除配置并停用", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("配置修订已更新");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "保存配置与版本", exact: true }),
  ).toBeVisible();
  expect(app.errors).toEqual([]);
});
