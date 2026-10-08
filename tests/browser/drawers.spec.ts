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

test("mobile drawer spans the viewport while desktop keeps its bounded width", async ({
  page,
}, info) => {
  await appFixture(page);
  await page.goto("/admin/sources");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "添加片源", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "添加片源", exact: true });
    await expect(drawer).toBeVisible();
    await expect
      .poll(async () => {
        const rect = await drawer.boundingBox();
        return rect ? Math.round(rect.width) : 0;
      })
      .toBe(width === 390 ? 390 : 440);
    await expect
      .poll(async () => {
        const rect = await drawer.boundingBox();
        return rect ? Math.round(rect.x + rect.width) : 0;
      })
      .toBe(width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: info.outputPath(`drawer-bounds-${width}.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(
      page.getByRole("button", { name: "添加片源", exact: true }),
    ).toBeFocused();
  }
});
