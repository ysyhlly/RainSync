import {mediaExtraResponse} from "./fixtures/media";
import { test, expect, type WebSocketRoute } from "@playwright/test";
import { readFileSync } from "node:fs";
import { navigate, roomPanel, showOptions } from "./fixtures/navigation";
const csp = readFileSync("deploy/Caddyfile", "utf8").match(
  /Content-Security-Policy "([^"]+)"/,
)![1];
test.beforeEach(async ({ page, baseURL }) => {
  await page.route(new URL("/**", baseURL).href, async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
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
  const commands: Record<string, unknown>[] = [];
  const firstEpoch = "11111111-1111-4111-8111-111111111111";
  const nextEpoch = "22222222-2222-4222-8222-222222222222";
  await page.clock.install();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/v1/**", async (route) => {
    const extra=mediaExtraResponse(route);if(extra)return extra;
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
            control_epoch: {
              id: firstEpoch,
              expires_at_ms: Date.now() + 86400000,
            },
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
      if (v.command_id) {
        commands.push(v);
        if (commands.length === 1)
          ws.send(
            JSON.stringify({
              type: "ERROR",
              command_id: v.command_id,
              error: {
                code: "CONTROL_EPOCH_EXPIRED",
                message: "控制凭据已更新，请重新操作",
                retryable: false,
              },
              control_epoch: {
                id: nextEpoch,
                expires_at_ms: Date.now() + 86400000,
              },
            }),
          );
      }
      if (v.type === "CHAT")
        ws.send(
          JSON.stringify({
            type: "CHAT",
            id: v.client_message_id,
            username: "雨声",
            body: v.body,
            client_message_id: v.client_message_id,
          }),
        );
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "放映室", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "进入房间", exact: true }).click();
  await expect(page.locator(".connection-status")).toHaveText("已连接");
  await navigate(page, "媒体库");
  await page
    .getByRole("button", { name: "播放 山海之间", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("控制凭据已更新");
  await page.clock.fastForward(3000);
  expect(commands.length).toBe(1);
  expect(commands[0].control_epoch).toBe(firstEpoch);
  await page.getByRole("button", { name: "关闭提示" }).click();
  await navigate(page, "媒体库");
  await page
    .getByRole("button", { name: "播放 山海之间", exact: true })
    .click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1].control_epoch).toBe(nextEpoch);
  expect(commands[1].command_id).not.toBe(commands[0].command_id);
  await page.getByLabel("聊天消息").fill("今晚一起看");
  await page.getByLabel("聊天消息").press("Enter");
  await expect(page.getByText("今晚一起看")).toBeVisible();
  await roomPanel(page, "待播");
  await page.getByRole("button", { name: "房间邀请", exact: true }).click();
  await expect(page.getByLabel("完整房间邀请")).toHaveValue(
    /invitation-test-token/,
  );
  await page.screenshot({
    path: info.outputPath(`${info.project.name}-room.png`),
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  expect(overflow).toBe(false);
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page
    .getByRole("link", { name: /^(片源管理|管理)$/ })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "添加片源", exact: true }).click();
  await expect(page.getByRole("heading", { name: "添加片源" })).toBeVisible();
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await page.getByRole("link", { name: "返回房间", exact: true }).click();
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
  await roomPanel(page, "待播");
  await page.getByRole("button", { name: "房间邀请", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("服务资源正忙");
  await expect(page.getByRole("alert")).toContainText(diagnostic);
  await navigate(page, "媒体库");
  await page.getByRole("link", { name: "返回房间", exact: true }).click();
  await roomPanel(page, "聊天");
  for (const code of ["CONTROLLER_REQUIRED", "FORBIDDEN"]) {
    controlSocket!.send(
      JSON.stringify({
        type: "ERROR",
        error: { code, message: "当前没有控制权限", retryable: false },
      }),
    );
    await expect(page.getByRole("alert")).toContainText("当前没有控制权限");
    await expect(page.locator(".connection-status")).toHaveText("已连接");
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
  await expect(page.locator(".connection-status")).toHaveText("正在重连");
  await page.clock.fastForward(10000);
  await expect.poll(() => connectionCount).toBe(2);
  await expect(page.locator(".connection-status")).toHaveText("已连接");
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
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
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
    const extra=mediaExtraResponse(route);if(extra)return extra;
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
  await page.goto("/rooms/room");
  await expect(page.getByRole("alert")).toContainText("登录已过期");
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
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
    const extra=mediaExtraResponse(route);if(extra)return extra;
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
      const sample = JSON.parse(String(message));
      if (sample.type === "CLOCK_SYNC")
        ws.send(
          JSON.stringify({
            type: "CLOCK_SYNC_REPLY",
            t1: sample.t1,
            t2: sample.t1,
            t3: sample.t1,
          }),
        );
      if (sample.type === "RESUME")
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
  await page.goto("/rooms/room");
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
  await showOptions(page);
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
  await showOptions(page);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("清理暂不可用");
  expect(requests.length).toBe(7);
  loseResponses = false;
  cleanupOffline = false;
  await showOptions(page);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect.poll(() => requests.length).toBe(8);
  expect(revoked).toContain(abandoned);
  expect(requests[7].idempotency_key).not.toBe(abandoned);
  await expect(page.locator("video")).toHaveAttribute("src", "/test-media");
  holdNext = true;
  await showOptions(page);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect.poll(() => requests.length).toBe(9);
  await showOptions(page);
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

test("rapid audio switches preserve the newest plan while an old DELETE is delayed", async ({
  page,
}) => {
  const requests: any[] = [];
  const revoked: string[] = [];
  const commands: any[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let releaseDelete: (() => void) | undefined;
  let held = false;
  await page.route("**/audio-test-media/**", (route) =>
    route.fulfill({ contentType: "video/mp4", body: "" }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const extra=mediaExtraResponse(route);if(extra)return extra;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/me"))
      return route.fulfill({
        json: { id: "owner", username: "test", admin: false, csrf: "test" },
      });
    if (path.endsWith("/rooms"))
      return route.fulfill({
        json: [{ id: "room", name: "room", owner_id: "owner" }],
      });
    if (path.endsWith("/media"))
      return route.fulfill({
        json: [{ id: "movie", title: "movie", kind: "local" }],
      });
    if (path.includes("/playback-requests/")) {
      revoked.push(path.split("/").at(-1)!);
      return route.fulfill({ json: { ok: true } });
    }
    if (
      path.endsWith("/playback-sessions/initial") &&
      route.request().method() === "DELETE"
    ) {
      held = true;
      await new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/playback-sessions")) {
      const body = route.request().postDataJSON();
      requests.push(body);
      const id =
        requests.length === 1 ? "initial" : `track-${body.audio_index}`;
      return route.fulfill({
        json: {
          session_id: id,
          media_id: "movie",
          media_generation: 1,
          delivery_mode: "direct",
          transport: "progressive",
          playback_url: `/audio-test-media/${id}`,
          timeline_origin_ms: 0,
          duration_ms: 30000,
          expires_in_seconds: 1800,
          rebuild_on_seek: false,
          audio_tracks: [
            { index: 1, label: "English", language: "eng" },
            { index: 2, label: "Japanese", language: "jpn" },
          ],
          subtitle_tracks: [],
        },
      });
    }
    return route.fulfill({ json: [] });
  });
  await page.routeWebSocket("**/api/v1/ws", (ws) =>
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type === "CLOCK_SYNC")
        ws.send(
          JSON.stringify({
            type: "CLOCK_SYNC_REPLY",
            t1: frame.t1,
            t2: frame.t1,
            t3: frame.t1,
          }),
        );
      if (frame.type === "RESUME")
        ws.send(
          JSON.stringify({
            type: "SNAPSHOT",
            control_epoch: {
              id: "audio-control",
              expires_at_ms: Date.now() + 3600000,
            },
            state: {
              room_id: "room",
              revision: 7,
              media_id: "movie",
              media_generation: 1,
              playback_status: "paused",
              anchor_position_ms: 1250,
              anchor_server_time_ms: 0,
              playback_rate: 1,
              controller_user_id: "owner",
              duration_ms: 30000,
              clock_epoch: "epoch",
            },
          }),
        );
      else if (!["CLOCK_SYNC", "CLIENT_STATUS"].includes(frame.type))
        commands.push(frame);
    }),
  );
  await page.goto("/rooms/room");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/audio-test-media/initial",
  );
  await showOptions(page);
  await page.getByRole("combobox", { name: "音轨", exact: true }).click();
  await page
    .getByRole("option", { name: "Japanese · jpn", exact: true })
    .click();
  await expect.poll(() => held).toBe(true);
  await page.getByRole("combobox", { name: "音轨", exact: true }).click();
  await page
    .getByRole("option", { name: "English · eng", exact: true })
    .click();
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/audio-test-media/track-1",
  );
  expect(requests).toHaveLength(2);
  expect(requests[1].audio_index).toBe(1);
  await expect(
    page.getByRole("combobox", { name: "音轨", exact: true }),
  ).toContainText("English · eng");
  expect(requests[1].position_ms).toBe(1250);
  expect(requests[1].idempotency_key).not.toBe(requests[0].idempotency_key);
  releaseDelete!();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/audio-test-media/track-1",
  );
  expect(revoked).toContain(requests[0].idempotency_key);
  expect(revoked).not.toContain(requests[1].idempotency_key);
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("rainsync:playback:owner") ?? "[]"),
    ),
  ).toEqual([requests[1].idempotency_key]);
  expect(commands).toEqual([]);
  expect(errors).toEqual([]);
});

test("subtitle identity survives reload and resets on media change", async ({
  page,
}) => {
  const clip = Buffer.from(
    readFileSync("tests/fixtures/browser-video.base64", "utf8").trim(),
    "base64",
  );
  let plans = 0;
  let socket: WebSocketRoute | undefined;
  const commands: string[] = [];
  const state = {
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
  };
  await page.route("**/subtitle-video.mp4*", (route) =>
    route.fulfill({ contentType: "video/mp4", body: clip }),
  );
  await page.route("**/subtitle-fixture-*.vtt*", (route) =>
    route.fulfill({
      contentType: "text/vtt; charset=utf-8",
      body: "WEBVTT\n\n00:00.000 --> 00:02.500\n字幕验证\n",
    }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const extra=mediaExtraResponse(route);if(extra)return extra;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/me"))
      return route.fulfill({
        json: { id: "owner", username: "test", admin: false, csrf: "test" },
      });
    if (path.endsWith("/rooms"))
      return route.fulfill({
        json: [{ id: "room", name: "room", owner_id: "owner" }],
      });
    if (path.endsWith("/media"))
      return route.fulfill({
        json: [{ id: "movie", title: "movie", kind: "local" }],
      });
    if (path.endsWith("/playback-sessions")) {
      plans++;
      const tracks = [
        {
          index: 11,
          label: "English",
          language: "eng",
          url: `/subtitle-fixture-11.vtt?plan=${plans}`,
        },
        {
          index: 42,
          label: "中文",
          language: "zho",
          url: `/subtitle-fixture-42.vtt?plan=${plans}`,
        },
      ];
      if (plans % 2 === 0) tracks.reverse();
      return route.fulfill({
        json: {
          session_id: `subtitle-${plans}`,
          media_id: state.media_id,
          media_generation: state.media_generation,
          delivery_mode: "direct",
          transport: "progressive",
          playback_url: `/subtitle-video.mp4?plan=${plans}`,
          timeline_origin_ms: 0,
          duration_ms: 3000,
          expires_in_seconds: 1800,
          rebuild_on_seek: false,
          audio_tracks: [],
          subtitle_tracks: tracks,
        },
      });
    }
    return route.fulfill({ json: [] });
  });
  await page.routeWebSocket("**/api/v1/ws", (ws) => {
    socket = ws;
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type === "CLOCK_SYNC")
        ws.send(
          JSON.stringify({
            type: "CLOCK_SYNC_REPLY",
            t1: frame.t1,
            t2: frame.t1,
            t3: frame.t1,
          }),
        );
      if (frame.type === "RESUME")
        ws.send(
          JSON.stringify({
            type: "SNAPSHOT",
            state,
            control_epoch: {
              id: "subtitles",
              expires_at_ms: Date.now() + 3600000,
            },
          }),
        );
      else if (!["CLOCK_SYNC", "CLIENT_STATUS"].includes(frame.type))
        commands.push(frame.type);
    });
  });
  await page.goto("/rooms/room");
  const video = page.locator("video");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await showOptions(page);
  await page.getByRole("combobox", { name: "字幕", exact: true }).click();
  await page.getByRole("option", { name: "中文 · zho", exact: true }).click();
  const showing = () =>
    video.evaluate((v: HTMLVideoElement) =>
      Array.from(v.querySelectorAll("track"))
        .filter((t) => t.track.mode === "showing")
        .map((t) => ({ label: t.label, cues: t.track.cues?.length ?? 0 })),
    );
  await expect.poll(showing).toEqual([{ label: "中文", cues: 1 }]);
  await showOptions(page);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect.poll(() => plans).toBe(2);
  await expect(
    page.getByRole("combobox", { name: "字幕", exact: true }),
  ).toContainText("中文");
  await expect.poll(showing).toEqual([{ label: "中文", cues: 1 }]);
  await page.getByRole("combobox", { name: "字幕", exact: true }).click();
  await page.getByRole("option", { name: "关闭", exact: true }).click();
  await showOptions(page);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect.poll(() => plans).toBe(3);
  await expect(
    page.getByRole("combobox", { name: "字幕", exact: true }),
  ).toContainText("关闭");
  await expect.poll(showing).toEqual([]);
  await showOptions(page);
  await page.getByRole("combobox", { name: "字幕", exact: true }).click();
  await page.getByRole("option", { name: "中文 · zho", exact: true }).click();
  await expect.poll(showing).toEqual([{ label: "中文", cues: 1 }]);
  state.media_generation = 2;
  state.media_id = "next-movie";
  state.revision++;
  socket!.send(JSON.stringify({ type: "SNAPSHOT", state }));
  await expect.poll(() => plans).toBe(4);
  await expect(
    page.getByRole("combobox", { name: "字幕", exact: true }),
  ).toContainText("关闭");
  await expect.poll(showing).toEqual([]);
  expect(commands).toEqual([]);
});
