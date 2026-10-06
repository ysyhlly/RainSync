import { test, expect } from "@playwright/test";
import { appFixture, appBase } from "./fixtures/application";

test("room owner reviews transfer, loses controls and retains the current player", async ({
  page,
}, info) => {
  const app = await appFixture(page, { admin: false });
  await page.route("**/api/v1/rooms/room/members", (route) =>
    route.fulfill({
      json: [
        { id: "owner", username: "owner", display_name: "放映用户" },
        { id: "next", username: "next-owner", display_name: "下一位房主" },
      ],
    }),
  );
  const transfers: unknown[] = [];
  await page.route("**/api/v1/rooms/room/owner", async (route) => {
    const body = route.request().postDataJSON();
    transfers.push(body);
    expect(body).toEqual({
      owner_id: "next",
      expected_revision: app.state.revision,
    });
    app.room.owner_id = "next";
    app.state.controller_user_id = "next";
    app.state.revision++;
    app.socket()?.send(
      JSON.stringify({
        type: "EVENT",
        state: app.state,
        owner_id: "next",
        action: { type: "TRANSFER_OWNERSHIP" },
        control_epoch: { id: "new-control" },
      }),
    );
    await route.fulfill({ json: { owner_id: "next", state: app.state } });
  });
  await page.goto(appBase + "/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.evaluate(() => {
    (window as any).__ownershipVideo = document.querySelector("video");
  });
  await page.getByRole("button", { name: "房间管理", exact: true }).click();
  await page.getByRole("button", { name: "转让房间", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "转让房间" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认转让" })).toBeDisabled();
  await page.getByRole("combobox", { name: "新房主" }).click();
  await page.getByRole("option", { name: "下一位房主 (@next-owner)" }).click();
  expect(transfers).toHaveLength(0);
  await page.screenshot({
    path: info.outputPath("ownership-confirmation.png"),
    fullPage: true,
  });
  const prepared = app.preparations();
  await page.getByRole("button", { name: "确认转让" }).click();
  await expect(page.getByRole("dialog", { name: "转让房间" })).toBeHidden();
  // Closed dialogs remain mounted, so match the single accessible notice,
  // not the hidden invitation dialog's copy of the shared message.
  const transferred = page.getByRole("status").filter({
    hasText: "房间已转让，当前影片继续播放",
  });
  await expect(transferred).toHaveCount(1);
  await expect(transferred).toBeVisible();
  await expect(
    page.getByRole("button", { name: "转让房间", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "邀请", exact: true }),
  ).toHaveCount(0);
  expect(transfers).toHaveLength(1);
  expect(app.preparations()).toBe(prepared);
  expect(app.connections()).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as any).__ownershipVideo === document.querySelector("video"),
    ),
  ).toBe(true);
  expect(app.errors).toEqual([]);
});
