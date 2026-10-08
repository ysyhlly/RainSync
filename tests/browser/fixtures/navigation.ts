import { expect, type Page } from "@playwright/test";

/** Real router navigation; never reload a page when testing runtime continuity. */
export async function navigate(page: Page, name: string) {
  await page
    .getByRole("link", { name, exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.locator(".page h1")).toHaveText(name);
}
/** Both widgets remain visible in the modular room, including narrow screens. */
export async function roomPanel(page: Page, name: "聊天" | "待播") {
  const panel = page.locator(name === "聊天" ? "#room-chat" : "#room-queue");
  await expect(panel).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
}
export async function chooseRoom(page: Page, id: string) {
  await navigate(page, "放映室");
  const card = page
    .locator(".room-card")
    .filter({ has: page.getByRole("heading", { name: id, exact: true }) });
  await card.getByRole("button").click();
  await expect(page.locator(".room-information-widget h1")).toHaveText(id);
}
export async function showOptions(page: Page) {
  await page
    .locator("video")
    .dispatchEvent("pointerenter", { pointerType: "mouse" });
  await page
    .locator("video")
    .dispatchEvent("pointermove", { pointerType: "mouse" });
  // Keyboard focus also reveals chrome on touch devices. The direct child
  // is the options disclosure; startup timing is a nested summary.
  await page.locator(".playback-options > summary").focus();
  await expect(page.locator(".playback-options")).toBeVisible();
  if (
    !(await page
      .locator(".playback-options")
      .evaluate((el) => (el as HTMLDetailsElement).open))
  )
    await page.getByRole("button", { name: "播放选项", exact: true }).click();
}
