import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { appFixture } from "./fixtures/application";
import { roomPanel } from "./fixtures/navigation";

async function reportedFixture(page: Page) {
  const app = await appFixture(page);
  await page.route("**/api/v1/rooms/room/members", (route) =>
    route.fulfill({
      json: [
        { id: "owner", username: "owner", display_name: "放映用户" },
        { id: "viewer", username: "viewer", display_name: "观看成员" },
        { id: "unknown", username: "unknown", display_name: "未上报成员" },
      ],
    }),
  );
  const sockets: WebSocketRoute[] = [],
    resumes: any[] = [];
  const presence = (epoch = "process-a", sequence = 1, count = 2) => ({
    room_id: "room",
    presence_epoch: epoch,
    presence_seq: sequence,
    members: [{ user_id: "owner", connection_count: count }],
  });
  await page.routeWebSocket("**/api/v1/ws", (ws) => {
    sockets.push(ws);
    const index = sockets.length;
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type === "RESUME") {
        resumes.push(frame);
        ws.send(
          JSON.stringify({
            type: "SNAPSHOT",
            state: app.state,
            presence_connection_id: `connection-${index}`,
            presence: presence(
              index === 1 ? "process-a" : "process-b",
              1,
              index === 1 ? 2 : 3,
            ),
            control_epoch: {
              id: "control",
              expires_at_ms: Date.now() + 3600000,
            },
          }),
        );
      } else if (frame.type === "CLOCK_SYNC") {
        ws.send(
          JSON.stringify({
            type: "CLOCK_SYNC_REPLY",
            t1: frame.t1,
            t2: frame.t1,
            t3: frame.t1,
            clock_epoch: app.state.clock_epoch,
          }),
        );
      } else if (frame.command_id) app.commands.push(frame);
    });
  });
  const send = (value: unknown) => sockets.at(-1)!.send(JSON.stringify(value));
  return { app, sockets, resumes, presence, send };
}

test("reported connections have explicit coverage and sequence gaps leave playback intact", async ({
  page,
}, info) => {
  const f = await reportedFixture(page);
  await page.goto("/rooms/room");
  const panel = page.getByRole("region", { name: "已上报在线状态的连接" });
  await expect(panel.getByText("2 个连接")).toBeVisible();
  await expect(panel.getByText("放映用户（你）")).toBeVisible();
  await expect(panel).toContainText("其他成员的状态未知");
  await expect(panel).not.toContainText("未上报成员");
  expect(f.resumes[0].presence_version).toBe(1);
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  const preparations = f.app.preparations(),
    revision = f.app.state.revision;
  await page.evaluate(() => {
    (window as any).__presenceVideo = document.querySelector("video");
  });
  f.send({
    type: "PRESENCE_SNAPSHOT",
    ...f.presence("process-a", 100, 1),
    members: [
      { user_id: "owner", connection_count: 1 },
      { user_id: "viewer", connection_count: 2 },
    ],
  });
  await expect(panel).toContainText("2 位成员已上报在线状态");
  await expect(panel).toContainText("观看成员");
  f.send({ type: "PRESENCE_SNAPSHOT", ...f.presence("process-a", 101, 1) });
  await expect(panel).toContainText("1 位成员已上报在线状态");
  await expect(panel).not.toContainText("观看成员");
  f.send({ type: "PRESENCE_SNAPSHOT", ...f.presence("process-a", 99, 8) });
  f.send({ type: "PRESENCE_SNAPSHOT", ...f.presence("process-a", 101, 8) });
  await expect(panel.getByText("1 个连接")).toBeVisible();
  expect(f.app.state.revision).toBe(revision);
  expect(f.app.commands).toEqual([]);
  expect(f.app.preparations()).toBe(preparations);
  expect(f.sockets).toHaveLength(1);
  expect(
    await page.evaluate(
      () => (window as any).__presenceVideo === document.querySelector("video"),
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("reported-presence.png"),
    fullPage: true,
  });
  await roomPanel(page, "待播");
  await page.getByRole("button", { name: "离开观看", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(panel).toHaveCount(0);
  expect(f.app.errors).toEqual([]);
});

test("unknown epoch reconnects, retired epoch cannot overwrite, revoked membership clears claims", async ({
  page,
}) => {
  const f = await reportedFixture(page);
  await page.goto("/rooms/room");
  const panel = page.getByRole("region", { name: "已上报在线状态的连接" });
  await expect(panel.getByText("2 个连接")).toBeVisible();
  f.send({ type: "PRESENCE_SNAPSHOT", ...f.presence("process-b", 999, 8) });
  await expect(panel.getByText("3 个连接")).toBeVisible();
  expect(f.sockets).toHaveLength(2);
  f.send({ type: "PRESENCE_SNAPSHOT", ...f.presence("process-a", 1000, 8) });
  f.send({ type: "PRESENCE_SNAPSHOT", ...f.presence("process-b", 2, 4) });
  await expect(panel.getByText("4 个连接")).toBeVisible();
  f.send({
    type: "ERROR",
    error: {
      code: "NOT_A_MEMBER",
      message: "你尚未加入此房间",
      request_id: "test",
    },
  });
  await expect(panel).toHaveCount(0);
  await expect(page.locator("video")).not.toHaveAttribute(
    "src",
    "/fixture-video.mp4",
  );
  expect(f.app.errors).toEqual([]);
});

test("server without negotiated fields is unavailable and never inferred offline", async ({
  page,
}) => {
  const app = await appFixture(page);
  await page.goto("/rooms/room");
  const panel = page.getByRole("region", { name: "已上报在线状态的连接" });
  await expect(panel).toContainText("在线状态不可用");
  app.socket()!.send(
    JSON.stringify({
      type: "PRESENCE_SNAPSHOT",
      room_id: "room",
      presence_epoch: "unbound",
      presence_seq: 1,
      members: [],
    }),
  );
  await expect(panel).toContainText("在线状态不可用");
  await expect(panel).not.toContainText("离线");
  expect(app.errors).toEqual([]);
});
