import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";
test("drawer dismisses only an outside primary press and release", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "full width drawer has explicit close button");
  await appFixture(page);
  await page.goto("/admin/sources");
  const trigger = page.getByRole("button", { name: "添加片源", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "添加片源" });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + 90);
  await expect(dialog).toBeVisible();
  await page.mouse.move(box.x + 4, box.y + 90);
  await page.mouse.down();
  await page.mouse.move(20, 150);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.mouse.click(20, 150);
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
