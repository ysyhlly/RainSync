import { expect, type Page } from "@playwright/test";

/** Real router navigation; never reload a page when testing runtime continuity. */
export async function navigate(page: Page, name: string) {
  await page
    .getByRole("link", { name, exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.locator(".page h1")).toHaveText(name);
}
export async function roomPanel(page: Page, name: "聊天" | "待播") {
  const tab = page.getByRole("tab", { name, exact: true });
  if (await page.evaluate(() => innerWidth < 768)) {
    await expect(tab).toBeVisible();
    await tab.click();
  }
}
export async function chooseRoom(page: Page, id: string) {
  await navigate(page, "放映室");
  const card = page
    .locator(".room-card")
    .filter({ has: page.getByRole("heading", { name: id, exact: true }) });
  await card.getByRole("button").click();
  await expect(page.locator(".room-information h1")).toHaveText(id);
}
export async function showOptions(page: Page) {
  await page
    .locator("video")
    .dispatchEvent("pointerenter", { pointerType: "mouse" });
  await page
    .locator("video")
    .dispatchEvent("pointermove", { pointerType: "mouse" });
  // Keyboard focus also reveals chrome on touch devices.
  await page.locator(".playback-options summary").focus();
  await expect(page.locator(".playback-options")).toBeVisible();
  if (
    !(await page
      .locator(".playback-options")
      .evaluate((el) => (el as HTMLDetailsElement).open))
  )
    await page.getByText("播放选项", { exact: true }).click();
}
