import { test, expect } from "@playwright/test";
import { appFixture, appBase } from "./fixtures/application";

test("close requires confirmation, preserves readonly history, and explicit reopen stays paused", async ({
  page,
}, info) => {
  const app = await appFixture(page, { admin: false });
  let lifecycle = "active",
    lifecycle_epoch = 0;
  const changes: string[] = [];
  const view = () => ({
    lifecycle,
    lifecycle_epoch,
    owner_id: app.room.owner_id,
    state: app.state,
    cleanup: null,
  });
  await page.route("**/api/v1/rooms/room/lifecycle", (route) =>
    route.fulfill({ json: view() }),
  );
  await page.route("**/api/v1/rooms/room/messages*", (route) =>
    route.fulfill({
      json: [{ id: "retained", username: "owner", body: "保留的聊天记录" }],
    }),
  );
  for (const action of ["close", "reopen", "archive"]) {
    await page.route(`**/api/v1/rooms/room/${action}`, async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        expected_revision: app.state.revision,
      });
      changes.push(action);
      lifecycle =
        action === "close"
          ? "closing"
          : action === "reopen"
            ? "active"
            : "archived";
      if (action !== "archive") lifecycle_epoch++;
      Object.assign(app.room, { lifecycle, lifecycle_epoch });
      app.state.playback_status = "paused";
      app.state.revision++;
      app.socket()?.send(
        JSON.stringify({
          type: "EVENT",
          ...view(),
          action: { type: "ROOM_LIFECYCLE" },
          control_epoch: lifecycle === "active" ? { id: "new-control" } : null,
        }),
      );
      await route.fulfill({ json: view() });
    });
  }
  await page.goto(appBase + "/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await page.getByRole("button", { name: "房间管理", exact: true }).click();
  await page.getByRole("button", { name: "关闭房间", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "关闭房间" })).toBeVisible();
  expect(changes).toEqual([]);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(changes).toEqual([]);
  await page.getByRole("button", { name: "关闭房间", exact: true }).click();
  await page.screenshot({
    path: info.outputPath("room-close-confirmation.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "确认关闭房间", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "房间管理", exact: true }),
  ).toContainText("房间正在关闭");
  await expect(page.locator("video")).not.toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  await expect(
    page.getByRole("button", { name: "重新开放", exact: true }),
  ).toHaveCount(0);
  const count = app.preparations();
  await page
    .getByRole("dialog", { name: "房间管理", exact: true })
    .getByRole("button", { name: "关闭弹窗" })
    .click();
  await expect(page.getByText("保留的聊天记录", { exact: true })).toBeVisible();
  await expect(page.getByLabel("聊天消息", { exact: true })).toBeDisabled();
  expect(app.preparations()).toBe(count);
  lifecycle = "closed";
  app.state.revision++;
  app
    .socket()
    ?.send(JSON.stringify({ type: "EVENT", ...view(), control_epoch: null }));
  await page.getByRole("button", { name: "房间管理", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重新开放", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重新开放", exact: true }).click();
  await page
    .getByRole("button", { name: "确认重新开放房间", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "房间管理", exact: true }),
  ).toContainText("房间开放中");
  expect(app.state.playback_status).toBe("paused");
  expect(changes).toEqual(["close", "reopen"]);
  expect(app.commands.filter((command) => command.type === "PLAY")).toEqual([]);
  expect(app.errors).toEqual([]);
});
