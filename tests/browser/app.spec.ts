import { test, expect, type WebSocketRoute } from "@playwright/test";
import { readFileSync } from "node:fs";
const csp = readFileSync("deploy/Caddyfile", "utf8").match(
  /Content-Security-Policy "([^"]+)"/,
)![1];
test.beforeEach(async ({ page }) => {
  await page.route("http://127.0.0.1:5173/", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": csp },
    });
  });
});
test("room, library, invitation and settings are usable", async ({
  page,
}, info) => {
  const errors: string[] = [];
  let controlSocket: WebSocketRoute;
  let connectionCount = 0;
  await page.clock.install();
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
    controlSocket = ws;
    connectionCount++;
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
  await page.getByRole("button", { name: "一起看", exact: true }).click();
  const diagnostic = "11111111-1111-4111-8111-111111111111";
  await page.route("**/invites", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "服务资源正忙",
          retryable: true,
          request_id: diagnostic,
        },
      },
    }),
  );
  await page.getByRole("button", { name: "邀请朋友" }).click();
  await expect(page.getByRole("alert")).toContainText("服务资源正忙");
  await expect(page.getByRole("alert")).toContainText(diagnostic);
  for (const code of ["CONTROLLER_REQUIRED", "FORBIDDEN"]) {
    controlSocket!.send(
      JSON.stringify({
        type: "ERROR",
        error: { code, message: "当前没有控制权限", retryable: false },
      }),
    );
    await expect(page.getByRole("alert")).toContainText("当前没有控制权限");
    await expect(page.getByText("已连接", { exact: false })).toBeVisible();
    await page.getByLabel("聊天消息").fill(code);
    await page.getByLabel("聊天消息").press("Enter");
    await expect(page.getByText(code, { exact: true })).toBeVisible();
  }
  expect(connectionCount).toBe(1);
  controlSocket!.send(
    JSON.stringify({
      type: "ERROR",
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "服务资源正忙",
        retryable: true,
      },
    }),
  );
  controlSocket!.close({ code: 1011 });
  await expect(page.getByText("○ 正在重连")).toBeVisible();
  await page.clock.fastForward(10000);
  await expect.poll(() => connectionCount).toBe(2);
  await expect(page.getByText("已连接", { exact: false })).toBeVisible();
  controlSocket!.send(
    JSON.stringify({
      type: "ERROR",
      error: {
        code: "SESSION_EXPIRED",
        message: "请重新登录",
        retryable: false,
        request_id: diagnostic,
      },
    }),
  );
  await expect(page.getByRole("alert")).toContainText("请重新登录");
  await expect(page.getByText("○ 连接已停止")).toBeVisible();
  await page.clock.fastForward(20000);
  expect(connectionCount).toBe(2);
  expect(errors).toEqual([]);
});

test("rejected WebSocket upgrade rechecks login and stops retrying", async ({
  page,
}) => {
  await page.clock.install();
  let expired = false;
  let connections = 0;
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/me")) {
      return route.fulfill(
        expired
          ? {
              status: 401,
              json: {
                error: {
                  code: "SESSION_EXPIRED",
                  message: "登录已过期",
                  retryable: false,
                  request_id: "22222222-2222-4222-8222-222222222222",
                },
              },
            }
          : {
              json: {
                id: "owner",
                username: "测试",
                admin: false,
                csrf: "test",
              },
            },
      );
    }
    return route.fulfill({
      json: path.endsWith("/rooms")
        ? [{ id: "room", name: "测试房间", owner_id: "owner" }]
        : [],
    });
  });
  await page.routeWebSocket("**/api/v1/ws", (ws) => {
    connections++;
    expired = true;
    ws.onMessage(() => ws.close({ code: 1008 }));
  });
  await page.goto("/");
  await page.getByLabel("选择房间").selectOption("room");
  await expect(page.getByRole("alert")).toContainText("登录已过期");
  await expect(page.getByText("○ 连接已停止")).toBeVisible();
  await page.clock.fastForward(30000);
  expect(connections).toBe(1);
});

test("playback retries a lost HTTP response with the same operation key", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const requests: Record<string, unknown>[] = [];
  const revoked: string[] = [];
  let loseResponses = false;
  let cleanupOffline = false;
  let holdNext = false;
  let releaseHeld: (() => void) | undefined;
  await page.addInitScript(() => {
    (window as any).unhandledPlayback = [];
    window.addEventListener("unhandledrejection", (event) =>
      (window as any).unhandledPlayback.push(String(event.reason)),
    );
  });
  await page.route("**/test-media", (route) =>
    route.fulfill({ contentType: "video/mp4", body: "" }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/me"))
      return route.fulfill({
        json: { id: "owner", username: "测试", admin: false, csrf: "test" },
      });
    if (path.endsWith("/rooms"))
      return route.fulfill({
        json: [{ id: "room", name: "测试房间", owner_id: "owner" }],
      });
    if (path.endsWith("/media"))
      return route.fulfill({
        json: [{ id: "movie", title: "测试影片", kind: "local" }],
      });
    if (path.includes("/playback-requests/")) {
      if (cleanupOffline)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "清理暂不可用",
              retryable: true,
            },
          },
        });
      revoked.push(path.split("/").at(-1)!);
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/playback-sessions")) {
      requests.push(route.request().postDataJSON());
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => {
          releaseHeld = resolve;
        });
        await route.abort("failed").catch(() => {});
        return;
      }
      if (loseResponses) return route.abort("failed");
      if (requests.length === 1) return route.abort("failed");
      if (requests.length === 2)
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"session_id":',
        });
      if (requests.length === 3)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "PLAYBACK_REQUEST_IN_PROGRESS",
              message: "准备中",
              retryable: true,
            },
          },
        });
      return route.fulfill({
        json: {
          session_id: "one-session",
          media_id: "movie",
          media_generation: 1,
          delivery_mode: "direct",
          transport: "progressive",
          playback_url: "/test-media",
          timeline_origin_ms: 0,
          duration_ms: 3000,
          expires_in_seconds: 1800,
          rebuild_on_seek: false,
          audio_tracks: [],
          subtitle_tracks: [],
        },
      });
    }
    return route.fulfill({ json: [] });
  });
  await page.routeWebSocket("**/api/v1/ws", (ws) =>
    ws.onMessage((message) => {
      if (JSON.parse(String(message)).type === "RESUME")
        ws.send(
          JSON.stringify({
            type: "SNAPSHOT",
            state: {
              room_id: "room",
              revision: 1,
              media_id: "movie",
              media_generation: 1,
              playback_status: "paused",
              anchor_position_ms: 0,
              anchor_server_time_ms: 0,
              playback_rate: 1,
              controller_user_id: "owner",
              duration_ms: 3000,
              clock_epoch: "epoch",
            },
          }),
        );
    }),
  );
  await page.goto("/");
  await page.getByLabel("选择房间").selectOption("room");
  await expect.poll(() => requests.length).toBe(1);
  await expect.poll(() => requests.length).toBe(2);
  await expect.poll(() => requests.length).toBe(3);
  await expect.poll(() => requests.length).toBe(4);
  expect(requests[0].idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[2]).toEqual(requests[0]);
  expect(requests[3]).toEqual(requests[0]);
  // This is a request-lifecycle test. The empty media response intentionally
  // does not claim decoder/playback coverage; verify the accepted plan binding.
  await expect(page.locator("video")).toHaveAttribute("src", "/test-media");
  loseResponses = true;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect.poll(() => requests.length).toBe(5);
  // Stopping the old accepted plan has succeeded. Lose cleanup of the next one.
  cleanupOffline = true;
  await expect.poll(() => requests.length).toBe(7);
  await expect(page.getByRole("alert")).toBeVisible();
  const abandoned = requests[4].idempotency_key;
  expect(requests[5]).toEqual(requests[4]);
  expect(requests[6]).toEqual(requests[4]);
  expect(revoked).toContain(requests[0].idempotency_key);
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(sessionStorage.getItem("rainsync:playback:owner") ?? "[]"),
      ),
    )
    .toEqual([abandoned]);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("清理暂不可用");
  expect(requests.length).toBe(7);
  loseResponses = false;
  cleanupOffline = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect.poll(() => requests.length).toBe(8);
  expect(revoked).toContain(abandoned);
  expect(requests[7].idempotency_key).not.toBe(abandoned);
  await expect(page.locator("video")).toHaveAttribute("src", "/test-media");
  holdNext = true;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect.poll(() => requests.length).toBe(9);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect.poll(() => requests.length).toBe(10);
  await expect(page.locator("video")).toHaveAttribute("src", "/test-media");
  releaseHeld!();
  await expect(page.getByRole("alert")).not.toContainText("播放准备超时");
  await expect(page.getByRole("alert")).not.toContainText("播放准备已取消");
  expect(await page.evaluate(() => (window as any).unhandledPlayback)).toEqual(
    [],
  );
  expect(pageErrors).toEqual([]);
});
