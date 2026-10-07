import { test, expect } from "@playwright/test";
import { appFixture, openFixtureSource } from "./fixtures/application";

test("bulk scans include offline NAS and preserve successful source results", async ({
  page,
}) => {
  const app = await appFixture(page);
  const calls: string[] = [];
  await page.route("**/api/v1/sources", (route) =>
    route.fulfill({ json: [{ id: "local", name: "本地目录", kind: "local" }] }),
  );
  await page.route("**/api/v1/agents", (route) =>
    route.fulfill({
      json: [
        { id: "nas", name: "家庭 NAS", revoked: false },
        { id: "revoked", name: "已撤销", revoked: true },
      ],
    }),
  );
  await page.route("**/api/v1/sources/local/test", async (route) => {
    calls.push("local");
    await route.fulfill({ json: { count: 3 } });
  });
  await page.route("**/api/v1/agents/nas/scan", async (route) => {
    calls.push("nas");
    await route.fulfill({ json: { status: "offline" } });
  });
  await page.goto("/library");
  await openFixtureSource(page);
  await page.getByRole("button", { name: "扫描所有片源" }).click();
  await expect(page.locator(".scan-results")).toContainText(
    "本次扫描发现 3 部影片",
  );
  await expect(page.locator(".scan-results")).toContainText("NAS 设备离线");
  expect(calls.sort()).toEqual(["local", "nas"]);
  expect(app.searches.length).toBeGreaterThan(1);
  expect(app.errors).toEqual([]);
});

test("viewer cannot see scan-all and library retains queue button", async ({
  page,
}) => {
  await appFixture(page, { admin: false });
  await page.goto("/library");
  await openFixtureSource(page);
  await expect(page.getByRole("button", { name: "扫描所有片源" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /加入待播/ }).first(),
  ).toBeVisible();
});

test("drawer stays modal during closing then restores focus", async ({
  page,
}) => {
  await appFixture(page);
  await page.goto("/admin/sources");
  const trigger = page.getByRole("button", { name: "添加片源", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "添加片源" });
  await expect(dialog).toBeVisible();
  const closing = await page.evaluate(async () => {
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
    (dialog.querySelector("button") as HTMLButtonElement).click();
    // Sample both facts after Vue's update, in one browser turn. Separate
    // protocol round trips can outlive the short closing animation.
    await Promise.resolve();
    return {
      closing: dialog.classList.contains("closing"),
      modal: dialog.open,
    };
  });
  expect(closing).toEqual({ closing: true, modal: true });
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(dialog).not.toHaveClass(/closing/);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("navigation hover is a light block and mini player uses thin custom track", async ({
  page,
  isMobile,
}) => {
  await appFixture(page);
  await page.goto("/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  const nav = page.locator(isMobile ? ".bottom-nav" : ".sidebar");
  const library = nav.getByRole("link", { name: "媒体库", exact: true });
  if (!isMobile) {
    await library.hover();
    await expect(library).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(library.locator(".navigation-beam")).toHaveCount(0);
  }
  await library.click();
  const range = page.locator(".mini-player .seek-control");
  await expect(range).toBeVisible();
  await expect(range).toHaveCSS("appearance", "none");
  await expect(range).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(
    await range.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--track-height"),
    ),
  ).toBe("3px");
  await page.screenshot({ path: test.info().outputPath("mini-player.png") });
});
