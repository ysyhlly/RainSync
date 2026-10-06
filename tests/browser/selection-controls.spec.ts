import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";
test("custom source menu keeps the drawer open and Escape closes only the menu", async ({
  page,
}) => {
  await appFixture(page);
  await page.goto("/admin/sources");
  await page.getByRole("button", { name: "添加片源", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "添加片源" });
  const select = drawer.getByRole("combobox", { name: "类型", exact: true });
  await select.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page
    .getByRole("option", { name: "HTTP MP4 / HLS", exact: true })
    .click();
  await expect(drawer).toBeVisible();
  await expect(select).toContainText("HTTP MP4 / HLS");
  await select.click();
  await expect(
    page.getByRole("option", { selected: true }).locator("svg"),
  ).toBeVisible();
  await expect(page.getByRole("listbox")).toHaveCSS(
    "background-color",
    "rgb(252, 249, 242)",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(drawer).toBeVisible();
  await select.press("ArrowDown");
  await select.press("End");
  await select.press("Enter");
  await expect(select).toContainText("Emby");
  await select.press("Home");
  await select.press("Enter");
  await expect(select).toContainText("本地挂载目录");
  await select.press("Escape");
  await expect(drawer).toBeHidden();
});
