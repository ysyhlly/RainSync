import { test, expect } from "@playwright/test";
import { appFixture } from "./fixtures/application";

for (const failure of ["network failure", "hanging cleanup"]) {
  test(`logout revokes authentication despite ${failure}`, async ({ page }) => {
    const app = await appFixture(page);
    await page.goto("/rooms/room");
    await expect(page.locator("video")).toHaveAttribute(
      "src",
      "/fixture-video.mp4",
    );
    const pending = await page.evaluate(() =>
      sessionStorage.getItem("rainsync:playback:owner"),
    );
    expect(JSON.parse(pending!)).toHaveLength(1);
    await page.route("**/api/v1/playback-requests/*", (route) =>
      failure === "network failure"
        ? route.abort("connectionfailed")
        : undefined,
    );
    // A session DELETE has no bearing on authentication either.
    await page.route("**/api/v1/playback-sessions/playback", () => {});
    const logoutMethods: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/auth/logout")) logoutMethods.push(r.method());
    });
    await page
      .getByRole("button", { name: "退出登录" })
      .filter({ visible: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "登录", exact: true }),
    ).toBeVisible({ timeout: 2500 });
    expect(logoutMethods).toEqual(["POST"]);
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("rainsync:playback:owner"),
      ),
    ).toBe(pending);
    expect(
      await page
        .locator("video")
        .evaluate((v: HTMLVideoElement) => v.paused && !v.getAttribute("src")),
    ).toBe(true);
    expect(app.errors).toEqual([]);
  });
}

test("failed logout is reported even when playback cancellation also fails", async ({
  page,
}) => {
  await appFixture(page);
  await page.goto("/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.route("**/api/v1/playback-requests/*", (r) =>
    r.abort("connectionfailed"),
  );
  let attempts = 0;
  await page.route("**/api/v1/auth/logout", (r) => {
    attempts++;
    return r.fulfill({
      status: 503,
      json: { error: { code: "SERVICE_UNAVAILABLE", message: "注销暂不可用" } },
    });
  });
  await page
    .getByRole("button", { name: "退出登录" })
    .filter({ visible: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("注销暂不可用");
  expect(attempts).toBe(1);
  await expect(
    page.getByRole("button", { name: "退出登录" }).filter({ visible: true }),
  ).toBeVisible();
  expect(
    await page
      .locator("video")
      .evaluate((v: HTMLVideoElement) => v.paused && !v.getAttribute("src")),
  ).toBe(true);
});
