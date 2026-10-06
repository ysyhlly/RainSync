import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";

test("HTTP source summary preserves native keyboard order and dialog focus boundaries", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop keyboard navigation regression");
  const app = await appFixture(page);
  await page.goto("/admin/sources");
  const trigger = page.getByRole("button", { name: "添加片源", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "添加片源", exact: true });
  const type = dialog.getByRole("combobox", { name: "类型", exact: true });
  await type.click();
  await page
    .getByRole("option", { name: "HTTP MP4 / HLS", exact: true })
    .click();

  const url = dialog.getByLabel("媒体或服务 URL", { exact: true });
  const summary = dialog.locator("details > summary");
  const headers = dialog.getByLabel("请求头 JSON（可选）", { exact: true });
  const assets = dialog.getByLabel("外部字幕/字体关联 JSON（可选）", {
    exact: true,
  });
  const cancel = dialog.getByRole("button", { name: "取消", exact: true });
  const save = dialog.getByRole("button", { name: "保存片源", exact: true });
  const close = dialog.getByRole("button", { name: "关闭弹窗", exact: true });

  await expect(headers).toBeHidden();
  await expect(assets).toBeHidden();
  await url.focus();
  await page.keyboard.press("Tab");
  await expect(summary).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(url).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(summary).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(headers).toBeVisible();
  await expect(assets).toBeVisible();
  for (const next of [headers, assets, cancel, save]) {
    await page.keyboard.press("Tab");
    await expect(next).toBeFocused();
  }
  for (const previous of [cancel, assets, headers, summary, url]) {
    await page.keyboard.press("Shift+Tab");
    await expect(previous).toBeFocused();
  }

  await summary.focus();
  await page.keyboard.press("Space");
  await expect(headers).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(save).toBeFocused();

  await type.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(type).toBeFocused();
  // Restore the initial type so dismissal does not require discarding a draft.
  await type.press("Home");
  await type.press("Enter");
  await expect(type).toContainText("本地挂载目录");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(app.errors).toEqual([]);
});
