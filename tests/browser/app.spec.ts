import { test, expect } from "@playwright/test";
test("room, library, invitation and settings are usable", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = [];
    if (path.endsWith("/auth/me"))
      body = { id: "owner", username: "雨声", admin: true, csrf: "test" };
    else if (path === "/api/v1/rooms")
      body = [{ id: "room", name: "周末放映室", owner_id: "owner" }];
    else if (path === "/api/v1/media")
      body = [
        { id: "movie", title: "山海之间", kind: "local", duration_ms: 5400000 },
        {
          id: "movie2",
          title: "午夜列车",
          kind: "jellyfin",
          duration_ms: 6000000,
        },
        { id: "movie3", title: "夏日来信", kind: "http", duration_ms: 4800000 },
        {
          id: "movie4",
          title: "云端漫步",
          kind: "agent",
          duration_ms: 4200000,
        },
      ];
    else if (path.endsWith("/invites"))
      body = { room_id: "room", token: "invitation-test-token" };
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket("**/api/v1/ws", (ws) => {
    ws.onMessage((message) => {
      const v = JSON.parse(String(message));
      if (v.type === "RESUME")
        ws.send(
          JSON.stringify({
            type: "SNAPSHOT",
            state: {
              room_id: "room",
              revision: 0,
              media_id: null,
              media_generation: 0,
              playback_status: "paused",
              anchor_position_ms: 0,
              anchor_server_time_ms: 0,
              playback_rate: 1,
              controller_user_id: "owner",
              duration_ms: null,
              clock_epoch: "epoch",
            },
          }),
        );
      if (v.type === "CLOCK_SYNC")
        ws.send(
          JSON.stringify({
            type: "CLOCK_SYNC_REPLY",
            t1: v.t1,
            t2: v.t1,
            t3: v.t1,
            clock_epoch: "epoch",
          }),
        );
      if (v.type === "CHAT")
        ws.send(
          JSON.stringify({
            type: "CHAT",
            id: "chat",
            username: "雨声",
            body: v.body,
          }),
        );
    });
  });
  await page.goto("/");
  await expect(page.getByText("今晚，一起看什么？")).toBeVisible();
  await page.getByLabel("选择房间").selectOption("room");
  await expect(page.getByText("已连接", { exact: false })).toBeVisible();
  await page.getByLabel("聊天消息").fill("今晚一起看");
  await page.getByLabel("聊天消息").press("Enter");
  await expect(page.getByText("今晚一起看")).toBeVisible();
  await page.getByRole("button", { name: "邀请朋友" }).click();
  await expect(page.locator("input[readonly]")).toHaveValue(
    /invitation-test-token/,
  );
  await page.screenshot({
    path: `.runtime/${info.project.name}-room.png`,
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  expect(overflow).toBe(false);
  await page.getByRole("button", { name: "片源管理" }).click();
  await expect(page.getByRole("heading", { name: "添加片源" })).toBeVisible();
  expect(errors).toEqual([]);
});
