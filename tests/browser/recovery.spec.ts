import {mediaExtraResponse} from "./fixtures/media";
import { readFileSync } from "node:fs";
import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { navigate, chooseRoom, showOptions } from "./fixtures/navigation";

test("library navigation requests bounded pages and searches beyond the current page", async ({
  page,
}) => {
  await setup(page, { validMedia: true });
  const queries: URLSearchParams[] = [];
  await page.route("**/api/v1/media?*", (r) => {
    const q = new URL(r.request().url()).searchParams;
    queries.push(q);
    const start = q.get("after")
      ? Number(q.get("after")!.split("-")[1]) + 1
      : 0;
    const count =
      q.get("search") === "needle"
        ? 1
        : Math.min(Number(q.get("limit")), 150 - start);
    return r.fulfill({
      json: Array.from({ length: count }, (_, n) => ({
        id: `item-${start + n}`,
        title: q.get("search") === "needle" ? "needle" : `entry-${start + n}`,
        kind: "http",
      })),
    });
  });
  await navigate(page, "媒体库");
  await page.getByLabel("搜索影片").fill("entry");
  await page.getByLabel("搜索影片").press("Enter");
  await expect(page.locator(".media-card")).toHaveCount(24);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("第 2 页 · 本页 24 部")).toBeVisible();
  await expect(page.locator(".media-card")).toHaveCount(24);
  expect(queries.at(-1)!.get("after")).toBe("item-23");
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page.getByText("第 1 页 · 本页 24 部")).toBeVisible();
  await expect(page.locator(".media-card")).toHaveCount(24);
  await page.getByLabel("搜索影片").fill("needle");
  await expect(page.locator(".media-card")).toHaveCount(1);
  expect(queries.at(-1)!.get("search")).toBe("needle");
  expect(queries.at(-1)!.has("after")).toBe(false);
  expect(queries.every((q) => q.get("limit") === "25")).toBe(true);
});

async function setup(
  page: Page,
  opts: {
    holdClock?: boolean;
    holdRoom?: boolean;
    validMedia?: boolean;
    nativeHls?: boolean;
    holdReady?: boolean;
  } = {},
) {
  await page.clock.install();
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
      get: () => 4,
    });
    Object.defineProperty(HTMLMediaElement.prototype, "duration", {
      get: () => 3600,
    });
    HTMLMediaElement.prototype.play = async function () {};
    HTMLMediaElement.prototype.pause = function () {};
  });
  const frames: any[] = [],
    preparations: any[] = [],
    sockets: WebSocketRoute[] = [];
  let replyClock = !opts.holdClock,
    clockFrame: any;
  let releaseHistory: (() => void) | undefined,
    releasePlaylist: (() => void) | undefined;
  let renewal: (() => void) | undefined,
    rejectRenew = false;
  const history: any[] = [];
  let mediaReady = !opts.holdReady;
  let readinessReads = 0;
  await page.route("**/empty-video*", (r) =>
    r.fulfill({
      contentType: "video/mp4",
      body: opts.validMedia
        ? Buffer.from(
            readFileSync("tests/fixtures/browser-video.base64", "utf8"),
            "base64",
          )
        : "",
    }),
  );
  await page.route("**/api/v1/**", async (r) => {
    const extra=mediaExtraResponse(r);if(extra)return extra;
    const url = new URL(r.request().url()),
      path = url.pathname;
    if (path.endsWith("/auth/me"))
      return r.fulfill({
        json: { id: "owner", username: "owner", csrf: "csrf", admin: false },
      });
    if (path.endsWith("/rooms"))
      return r.fulfill({
        json: ["a", "b", "c"].map((id) => ({
          id,
          name: id,
          owner_id: "owner",
        })),
      });
    if (path.endsWith("/media"))
      return r.fulfill({
        json: [{ id: "movie", title: "movie", kind: "local" }],
      });
    if (path.endsWith("/playlist")) {
      if (opts.holdRoom && path.includes("/a/"))
        await new Promise<void>((res) => (releasePlaylist = res));
      return r.fulfill({ json: [] });
    }
    if (path.endsWith("/messages")) {
      if (opts.holdRoom && path.includes("/a/"))
        await new Promise<void>((res) => (releaseHistory = res));
      return r.fulfill({
        json: path.includes("/a/")
          ? [{ id: "a-msg", username: "old", body: "old-room" }, ...history]
          : [{ id: "c-msg", username: "new", body: "current-room" }],
      });
    }
    if (path.endsWith("/playback-sessions")) {
      preparations.push(r.request().postDataJSON());
      return r.fulfill({
        json: {
          session_id: `session-${preparations.length}`,
          media_id: "movie",
          media_generation: 1,
          delivery_mode: "direct",
          transport: opts.nativeHls ? "hls" : "progressive",
          playback_url: `/empty-video?n=${preparations.length}`,
          timeline_origin_ms: 0,
          duration_ms: 3600000,
          expires_in_seconds: 1800,
          rebuild_on_seek: !!opts.nativeHls || !!opts.holdReady,
          audio_tracks: [],
          subtitle_tracks: [],
        },
      });
    }
    if (
      path.includes("/playback-sessions/") &&
      r.request().method() === "GET"
    ) {
      readinessReads++;
      return r.fulfill({
        json: {
          session_id: path.split("/").at(-1),
          status: mediaReady ? "ready" : "preparing",
          complete: false,
        },
      });
    }
    if (
      path.includes("/playback-sessions/") &&
      r.request().method() === "POST"
    ) {
      if (rejectRenew) await new Promise<void>((res) => (renewal = res));
      return r.fulfill({
        status: 410,
        json: {
          error: {
            code: "INVALID_PLAYBACK_SESSION",
            message: "old playback expired",
            retryable: false,
          },
        },
      });
    }
    return r.fulfill({ json: { ok: true } });
  });
  await page.routeWebSocket("**/api/v1/ws", (ws) => {
    sockets.push(ws);
    ws.onMessage((data) => {
      const v = JSON.parse(String(data));
      frames.push(v);
      if (v.type === "RESUME")
        ws.send(
          JSON.stringify({
            type: "SNAPSHOT",
            control_epoch: { id: "control" },
            state: {
              room_id: v.room_id,
              revision: 1,
              media_id: "movie",
              media_generation: 1,
              playback_status: "playing",
              anchor_position_ms: 0,
              anchor_server_time_ms: 200000,
              playback_rate: 1,
              controller_user_id: "owner",
              duration_ms: 3600000,
              clock_epoch: "epoch",
            },
          }),
        );
      if (v.type === "CLOCK_SYNC") {
        clockFrame = v;
        if (replyClock)
          ws.send(
            JSON.stringify({
              type: "CLOCK_SYNC_REPLY",
              t1: v.t1,
              t2: 2000000,
              t3: 2000000,
            }),
          );
      }
    });
  });
  await page.goto("/rooms/a");
  await expect(page.locator(".connection-status")).toHaveText("已连接");
  await expect.poll(() => clockFrame?.type).toBe("CLOCK_SYNC");
  return {
    frames,
    preparations,
    sockets,
    history,
    readinessReads: () => readinessReads,
    releaseReady() {
      mediaReady = true;
    },
    releaseClock() {
      replyClock = true;
      sockets.at(-1)!.send(
        JSON.stringify({
          type: "CLOCK_SYNC_REPLY",
          t1: clockFrame.t1,
          t2: 2000000,
          t3: 2000000,
        }),
      );
    },
    releaseRoom() {
      releaseHistory?.();
      releasePlaylist?.();
    },
    holdRenew() {
      rejectRenew = true;
    },
    hasRenew() {
      return !!renewal;
    },
    releaseRenew() {
      renewal?.();
    },
  };
}

test("does not load unpublished media or allocate a second session while waiting", async ({
  page,
}) => {
  const h = await setup(page, { holdReady: true, validMedia: true });
  await expect.poll(h.readinessReads).toBe(1);
  await expect(page.locator("video")).not.toHaveAttribute("src");
  expect(h.preparations).toHaveLength(1);
  h.releaseReady();
  await page.clock.runFor(1000);
  await expect(page.locator("video")).toHaveAttribute("src", /empty-video/);
  expect(h.preparations).toHaveLength(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("playing snapshot waits for clock; visibility preserves offset and dragging survives ticks", async ({
  page,
}) => {
  const h = await setup(page, { holdClock: true });
  await page.clock.fastForward(1000);
  expect(h.preparations).toHaveLength(0);
  h.releaseClock();
  await expect.poll(() => h.preparations.length).toBe(1);
  expect(h.preparations[0].position_ms).toBeGreaterThan(1799000);
  await page
    .locator("video")
    .evaluate((el) => el.dispatchEvent(new Event("loadedmetadata")));
  const before = await page
    .locator("video")
    .evaluate((el: any) => el.currentTime);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  expect(
    await page.locator("video").evaluate((el: any) => el.currentTime),
  ).toBeGreaterThan(before - 1);
  const slider = page.getByLabel("播放进度");
  await slider.evaluate((el: HTMLInputElement) => {
    el.dispatchEvent(new PointerEvent("pointerdown"));
    el.value = "2400";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.clock.fastForward(1200);
  await expect(slider).toHaveValue("2400");
  await slider.dispatchEvent("change");
  await expect
    .poll(
      () =>
        h.frames.filter((v) => v.type === "SEEK").at(-1)?.payload.position_ms,
    )
    .toBe(2400000);
});

test("slow previous-room history cannot overwrite the new room", async ({
  page,
}) => {
  const h = await setup(page, { holdRoom: true });
  await expect.poll(() => h.preparations.length).toBe(1);
  await chooseRoom(page, "b");
  await chooseRoom(page, "c");
  await expect(page.getByText("current-room", { exact: true })).toBeVisible();
  h.releaseRoom();
  await expect(page.getByText("old-room", { exact: true })).toHaveCount(0);
  await expect.poll(() => h.preparations.at(-1)?.room_id).toBe("c");
});

test("reconnect merges missed chat and an old renewal cannot fail the new plan", async ({
  page,
}) => {
  const h = await setup(page);
  await expect.poll(() => h.preparations.length).toBe(1);
  h.history.push({
    id: "missed",
    username: "friend",
    body: "while-disconnected",
  });
  h.sockets[0].close();
  await page.clock.fastForward(2000);
  await expect(
    page.getByText("while-disconnected", { exact: true }),
  ).toBeVisible();
  h.holdRenew();
  await page.clock.fastForward(600000);
  await expect.poll(() => h.hasRenew()).toBe(true);
  await showOptions(page);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect.poll(() => h.preparations.length).toBe(2);
  h.releaseRenew();
  await expect(page.getByRole("alert")).not.toContainText("播放会话已失效");
  await expect(page.locator(".room-information h1")).toHaveText("a");
});

test("rejected chat retains input until its own acknowledgement", async ({
  page,
}) => {
  const h = await setup(page);
  const input = page.getByLabel("聊天消息");
  await input.fill("中文消息😀");
  await input.press("Enter");
  await expect(input).toHaveValue("中文消息😀");
  h.sockets[0].send(
    JSON.stringify({
      type: "ERROR",
      error: { code: "INVALID_REQUEST", message: "rejected", retryable: false },
    }),
  );
  await expect(input).toHaveValue("中文消息😀");
  await input.press("Enter");
  await expect
    .poll(() => h.frames.filter((v) => v.type === "CHAT").length)
    .toBe(2);
  const sent = h.frames.filter((v) => v.type === "CHAT").at(-1);
  h.sockets[0].send(
    JSON.stringify({
      type: "CHAT",
      id: "accepted",
      username: "owner",
      body: sent.body,
      client_message_id: sent.client_message_id,
    }),
  );
  await expect(input).toHaveValue("");
});

test("stale HLS attempt refetches entry manifest without a new playback session", async ({
  page,
}) => {
  // Vite's dependency cache can live outside node_modules for isolated runs.
  await page.route(/\/deps\/hls__js\.js(?:\?|$)/, (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `
    export default class Hls {
      static Events={ERROR:'error'}; static isSupported(){return true}
      constructor(config){this.config=config;window.hlsTest=this;window.hlsSources=[];window.hlsStarts=[]}
      loadSource(url){window.hlsSources.push(url)} attachMedia(){} stopLoad(){} startLoad(position){window.hlsStarts.push(position)} destroy(){}
      on(name,callback){this.error=callback}
    }`,
    }),
  );
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.canPlayType = () => "";
  });
  const h = await setup(page);
  await expect.poll(() => h.preparations.length).toBe(1);
  // Change only the transport on a subsequent plan response.
  await page.route("**/api/v1/playback-sessions", async (r) =>
    r.fulfill({
      json: {
        session_id: "hls",
        media_id: "movie",
        media_generation: 1,
        delivery_mode: "transcode",
        transport: "hls",
        playback_url: "/media-delivery/hls/index.m3u8?token=test",
        timeline_origin_ms: 0,
        duration_ms: 3600000,
        expires_in_seconds: 1800,
        rebuild_on_seek: true,
        audio_tracks: [],
        subtitle_tracks: [],
      },
    }),
  );
  await expect.poll(() => h.preparations.length).toBe(1);
  await showOptions(page);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).hlsSources?.length))
    .toBe(1);
  await page.evaluate(() =>
    (window as any).hlsTest.error("error", {
      fatal: true,
      response: { code: 409 },
      details: "fragLoadError",
    }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).hlsSources.length))
    .toBe(2);
  expect(await page.evaluate(() => (window as any).hlsSources)).toEqual(
    Array(2).fill("/media-delivery/hls/index.m3u8?token=test"),
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).hlsStarts[0]),
  ).toBeGreaterThan(1700);
  for (let i = 0; i < 3; i++)
    await page.evaluate(() =>
      (window as any).hlsTest.error("error", {
        fatal: true,
        response: { code: 409 },
        details: "fragLoadError",
      }),
    );
  expect(await page.evaluate(() => (window as any).hlsSources.length)).toBe(4);
  await expect(page.getByRole("alert")).toContainText("媒体加载失败");
  expect(h.preparations).toHaveLength(1);
});

test("room chooser without a selection preserves the current viewing connection", async ({
  page,
}) => {
  const h = await setup(page, { validMedia: true });
  await expect.poll(() => h.preparations.length).toBe(1);
  await navigate(page, "放映室");
  await expect(page.locator(".mini-player")).toBeVisible();
  await page.getByRole("link", { name: "返回房间", exact: true }).click();
  await expect(page.locator(".room-information h1")).toHaveText("a");
  await page.clock.fastForward(1000);
  expect(h.sockets).toHaveLength(1);
  expect(h.preparations).toHaveLength(1);
  await expect(page.locator("video")).toHaveAttribute("src", /empty-video/);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("native HLS recovery keeps room time and waits for a growing replacement playlist", async ({
  page,
}) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.canPlayType = () => "probably";
  });
  const h = await setup(page, { validMedia: true, nativeHls: true });
  await expect.poll(() => h.preparations.length).toBe(1);
  await expect(page.locator("video")).toHaveAttribute("src", /empty-video/);
  await page.evaluate(() => {
    const el = document.querySelector("video")!;
    el.load = () => {};
    Object.defineProperty(el, "duration", {
      configurable: true,
      get: () => 10,
    });
    Object.defineProperty(el, "error", {
      configurable: true,
      get: () => ({ code: 2 }),
    });
    el.dispatchEvent(new Event("error"));
  });
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    /recovery=1#t=18\d\d/,
  );
  await page.evaluate(() =>
    document.querySelector("video")!.dispatchEvent(new Event("loadedmetadata")),
  );
  await page.clock.fastForward(2000);
  expect(h.preparations).toHaveLength(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("native recovery can play buffered data before seekable is exposed", async ({
  page,
}) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.canPlayType = () => "probably";
  });
  const h = await setup(page, { validMedia: true, nativeHls: true });
  await expect(page.locator("video")).toHaveAttribute("src", /empty-video/);
  await page.evaluate(() => {
    const el = document.querySelector("video")!;
    el.load = () => {};
    el.play = async () => {
      el.dataset.recoveryPlays = String(
        Number(el.dataset.recoveryPlays ?? 0) + 1,
      );
    };
    Object.defineProperty(el, "paused", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(el, "duration", {
      configurable: true,
      get: () => Infinity,
    });
    Object.defineProperty(el, "seekable", {
      configurable: true,
      get: () => ({ length: 0 }),
    });
    Object.defineProperty(el, "buffered", {
      configurable: true,
      get: () => ({ length: 1, start: () => 0, end: () => 3600 }),
    });
    Object.defineProperty(el, "error", {
      configurable: true,
      get: () => ({ code: 2 }),
    });
    el.dispatchEvent(new Event("error"));
    el.dispatchEvent(new Event("loadedmetadata"));
  });
  await page.clock.runFor(1000);
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((v) => Number(v.dataset.recoveryPlays ?? 0)),
    )
    .toBeGreaterThan(0);
  expect(h.preparations).toHaveLength(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a growing output waits for the room position and resumes the same native session", async ({
  page,
}) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.canPlayType = () => "probably";
    Object.defineProperty(HTMLMediaElement.prototype, "seekable", {
      configurable: true,
      get: () => ({ length: 1, start: () => 0, end: () => 3600 }),
    });
  });
  const h = await setup(page, { validMedia: true, nativeHls: true });
  await expect(page.locator("video")).toHaveAttribute("src", /empty-video/);
  let ready = false;
  const positions: number[] = [];
  await page.route("**/api/v1/playback-sessions/session-1?*", (r) => {
    positions.push(
      Number(
        new URL(r.request().url()).searchParams.get("relative_position_ms"),
      ),
    );
    return r.fulfill({
      json: {
        session_id: "session-1",
        status: ready ? "ready" : "preparing",
        complete: false,
        available_until_ms: ready ? 1900000 : 10000,
      },
    });
  });
  await page.evaluate(() => {
    const el = document.querySelector("video")!;
    el.load = () => {};
    Object.defineProperty(el, "duration", {
      configurable: true,
      get: () => 10,
    });
    Object.defineProperty(el, "seekable", {
      configurable: true,
      get: () => ({ length: 1, start: () => 0, end: () => 10 }),
    });
    el.dispatchEvent(new Event("loadedmetadata"));
  });
  await expect.poll(() => positions.length).toBeGreaterThan(0);
  await page.clock.runFor(1000);
  expect(h.preparations).toHaveLength(1);
  expect(positions.every((p) => p >= 1800000)).toBe(true);
  ready = true;
  await page.evaluate(() => {
    const el = document.querySelector("video")!;
    Object.defineProperty(el, "duration", {
      configurable: true,
      get: () => 3600,
    });
    Object.defineProperty(el, "seekable", {
      configurable: true,
      get: () => ({ length: 1, start: () => 0, end: () => 3600 }),
    });
  });
  await page.clock.runFor(1000);
  await expect(page.locator("video")).toHaveAttribute("src", /#t=18\d\d/);
  expect(h.preparations).toHaveLength(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

for (const action of [
  "switching rooms",
  "seeking beyond the generated range",
]) {
  test(`${action} aborts a pending generated-range read and ignores its late response`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      HTMLMediaElement.prototype.canPlayType = () => "probably";
      Object.defineProperty(HTMLMediaElement.prototype, "seekable", {
        configurable: true,
        get: () => ({ length: 1, start: () => 0, end: () => 3600 }),
      });
    });
    const unhandled: string[] = [];
    page.on("pageerror", (e) => unhandled.push(e.message));
    const h = await setup(page, { validMedia: true, nativeHls: true });
    await expect(page.locator("video")).toHaveAttribute(
      "src",
      /empty-video\?n=1/,
    );
    let release: (() => void) | undefined;
    let reads = 0;
    let aborted = false;
    page.on("requestfailed", (request) => {
      if (request.url().includes("playback-sessions/session-1?"))
        aborted = true;
    });
    await page.route(
      "**/api/v1/playback-sessions/session-1?*",
      async (route) => {
        reads++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await route.fulfill({
          json: {
            session_id: "session-1",
            status: "ready",
            complete: false,
            available_until_ms: 3600000,
          },
        });
      },
    );
    await page.evaluate(() => {
      const el = document.querySelector("video")!;
      Object.defineProperty(el, "seekable", {
        configurable: true,
        get: () => ({ length: 1, start: () => 0, end: () => 10 }),
      });
      el.dispatchEvent(new Event("loadedmetadata"));
    });
    await expect.poll(() => reads).toBe(1);
    if (action === "switching rooms") {
      await page.evaluate(() => {
        Reflect.deleteProperty(document.querySelector("video")!, "seekable");
      });
      await chooseRoom(page, "c");
    } else {
      h.sockets.at(-1)!.send(
        JSON.stringify({
          type: "STATE",
          action: { type: "SEEK" },
          state: {
            room_id: "a",
            revision: 2,
            media_id: "movie",
            media_generation: 1,
            playback_status: "playing",
            anchor_position_ms: 120000,
            anchor_server_time_ms: 2000000,
            playback_rate: 1,
            controller_user_id: "owner",
            duration_ms: 3600000,
            clock_epoch: "epoch",
          },
        }),
      );
      await expect.poll(() => h.preparations.length).toBe(2);
      await page.evaluate(() => {
        Reflect.deleteProperty(document.querySelector("video")!, "seekable");
      });
      expect(h.preparations[1].position_ms).toBeGreaterThanOrEqual(120000);
      expect(h.preparations[1].position_ms).toBeLessThan(130000);
    }
    await expect(page.locator("video")).toHaveAttribute(
      "src",
      /empty-video\?n=2/,
    );
    await expect.poll(() => aborted).toBe(true);
    release!();
    await page.clock.runFor(3000);
    await expect(page.locator("video")).toHaveAttribute(
      "src",
      /empty-video\?n=2/,
    );
    expect(h.preparations).toHaveLength(2);
    expect(reads).toBe(1);
    expect(unhandled).toEqual([]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("teardown media errors are silent while an active unsupported resource is reported", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const load = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function () {
      const empty = !this.getAttribute("src");
      load.call(this);
      if (empty) queueMicrotask(() => this.dispatchEvent(new Event("error")));
    };
  });
  const h = await setup(page, { validMedia: true });
  await expect.poll(() => h.preparations.length).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await showOptions(page);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect.poll(() => h.preparations.length).toBe(2);
  await page.clock.fastForward(500);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await chooseRoom(page, "c");
  await expect.poll(() => h.preparations.length).toBe(3);
  await page.clock.fastForward(500);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.locator("video").evaluate((el) => {
    Object.defineProperty(el, "error", { get: () => ({ code: 4 }) });
    el.dispatchEvent(new Event("error"));
  });
  await expect(page.getByRole("alert")).toContainText("无法播放此格式");
});
