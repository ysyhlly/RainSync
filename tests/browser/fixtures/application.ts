import type { Page, WebSocketRoute } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mediaRecord, missingCover } from "./media";
export const appBase = "";
export async function appFixture(
  page: Page,
  options: { admin?: boolean; loggedIn?: boolean } = {},
) {
  const clip = Buffer.from(
    readFileSync("tests/fixtures/browser-video.base64", "utf8").trim(),
    "base64",
  );
  let authenticated = options.loggedIn ?? true,
    connections = 0,
    preparations = 0;
  const commands: any[] = [],
    searches: string[] = [],
    errors: string[] = [];
  let socket: WebSocketRoute | undefined;
  const identity = {
    id: "owner",
    username: "owner",
    display_name: "放映用户",
    custom_display_name: "放映用户",
    admin: options.admin ?? true,
    csrf: "test",
    avatar_url: null,
    avatar_version: null,
  };
  const room = { id: "room", name: "周末放映室", owner_id: "owner" };
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
    duration_ms: 30000,
    clock_epoch: "test-clock",
  };
  const media = Array.from({ length: 30 }, (_, i) =>
    mediaRecord({
      id: i === 0 ? "movie" : "movie-" + i,
      title: i === 0 ? "真实合成测试视频" : "测试影片 " + i,
      kind: "local",
      duration_ms: 30000,
    }),
  );
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/fixture-video.mp4", (route) =>
    route.fulfill({ contentType: "video/mp4", body: clip }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace("/api/v1", "");
    let value: unknown = { ok: true };
    if (path === "/auth/me")
      return route.fulfill({
        status: authenticated ? 200 : 401,
        json: authenticated
          ? identity
          : { error: { code: "LOGIN_REQUIRED", message: "请登录" } },
      });
    if (path === "/auth/login") {
      authenticated = true;
      value = { csrf: "test" };
    } else if (path === "/auth/logout") {
      authenticated = false;
    } else if (path === "/rooms")
      value = request.method() === "POST" ? { id: "room" } : [room];
    else if (path === "/media") {
      searches.push(url.search);
      const query = url.searchParams.get("search") ?? "";
      const filtered = media.filter((x) => x.title.includes(query));
      const after = url.searchParams.get("after");
      const offset = after ? filtered.findIndex((x) => x.id === after) + 1 : 0;
      value = filtered.slice(
        offset,
        offset + Number(url.searchParams.get("limit") ?? 100),
      );
    } else if (path === "/media/previews") {
      const ids =
        request.method() === "POST"
          ? request.postDataJSON().media_ids
          : (url.searchParams.get("ids") ?? "").split(",");
      value = {
        items: ids
          .filter((id: string) => media.some((m) => m.id === id))
          .map((media_id: string) => ({
            media_id,
            cover: {
              ...missingCover,
              status: "unavailable",
              retry_after_ms: 60000,
            },
          })),
      };
    } else if (
      /^\/(admin\/)?media\/[^/]+\/(personal|shared)-title$/.test(path)
    ) {
      const id = path.split("/").at(-2),
        item = media.find((m) => m.id === id)!;
      const scope = path.endsWith("personal-title") ? "personal" : "shared",
        body = request.postDataJSON();
      if (scope === "shared" && !identity.admin)
        return route.fulfill({
          status: 403,
          json: {
            error: { code: "ADMIN_REQUIRED", message: "仅管理员可操作" },
          },
        });
      if (body.expected_revision !== item[`${scope}_title_revision`])
        return route.fulfill({
          status: 409,
          json: {
            error: { code: "MEDIA_TITLE_CONFLICT", message: "名称冲突" },
          },
        });
      Object.assign(item, {
        [`${scope}_title`]: body.title,
        [`${scope}_title_revision`]: String(Number(body.expected_revision) + 1),
      });
      item.title = String(
        item.personal_title ?? item.shared_title ?? item.original_title,
      );
      value = item;
    } else if (path.startsWith("/media/")) {
      const item = media.find(
        (m) => m.id === decodeURIComponent(path.split("/")[2]),
      );
      if (!item)
        return route.fulfill({
          status: 404,
          json: { error: { code: "MEDIA_NOT_FOUND", message: "未找到影片" } },
        });
      value = item;
    } else if (path.endsWith("/playlist")) value = [];
    else if (path.endsWith("/messages")) value = [];
    else if (path.endsWith("/invites"))
      value = { room_id: "room", token: "room-invitation" };
    else if (path === "/playback-sessions") {
      preparations++;
      value = {
        session_id: "playback",
        plan_generation: route.request().postDataJSON().plan_generation,
        media_id: "movie",
        media_generation: 1,
        delivery_mode: "direct",
        transport: "progressive",
        playback_url: "/fixture-video.mp4",
        timeline_origin_ms: 0,
        duration_ms: 30000,
        expires_in_seconds: 1800,
        rebuild_on_seek: false,
        audio_tracks: [],
        subtitle_tracks: [],
      };
    } else if (path === "/sources" || path === "/agents") value = [];
    await route.fulfill({ json: value });
  });
  await page.routeWebSocket("**/api/v1/ws", (ws) => {
    socket = ws;
    connections++;
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type === "RESUME")
        ws.send(
          JSON.stringify({
            type: "SNAPSHOT",
            state,
            control_epoch: {
              id: "control",
              expires_at_ms: Date.now() + 3600000,
            },
          }),
        );
      else if (frame.type === "CLOCK_SYNC")
        ws.send(
          JSON.stringify({
            type: "CLOCK_SYNC_REPLY",
            t1: frame.t1,
            t2: frame.t1,
            t3: frame.t1,
            clock_epoch: state.clock_epoch,
          }),
        );
      else if (frame.type === "CHAT")
        ws.send(
          JSON.stringify({
            type: "CHAT",
            id: frame.client_message_id,
            client_message_id: frame.client_message_id,
            username: identity.username,
            display_name: identity.display_name,
            body: frame.body,
          }),
        );
      else if (frame.command_id) {
        commands.push(frame);
        if (frame.type === "PLAY" || frame.type === "PAUSE")
          state.playback_status = frame.type === "PLAY" ? "playing" : "paused";
        state.revision++;
        ws.send(
          JSON.stringify({
            type: "EVENT",
            state,
            action: { type: frame.type },
          }),
        );
      }
    });
  });
  return {
    signIn: (value: Partial<typeof identity>) => {
      Object.assign(identity, value);
      authenticated = true;
    },
    identity,
    room,
    media,
    state,
    commands,
    searches,
    errors,
    connections: () => connections,
    preparations: () => preparations,
    socket: () => socket,
  };
}
