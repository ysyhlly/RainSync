import { mediaExtraResponse } from "./fixtures/media";
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
    deterministicClock?: boolean;
    holdRoom?: boolean;
    validMedia?: boolean;
    nativeHls?: boolean;
    holdReady?: boolean;
    playbackUrl?: string;
    anchorServerTimeMs?: number;
    playbackStatus?: "playing" | "paused";
  } = {},
) {
  if (opts.deterministicClock) {
    const start = new Date("2026-10-05T12:00:00Z");
    await page.clock.install({ time: start });
    await page.clock.pauseAt(new Date(start.getTime() + 1000));
  } else await page.clock.install();
  await page.addInitScript(
    ({ validMedia }) => {
      const playing = new WeakSet<HTMLMediaElement>();
      // These component fixtures already simulate readiness, duration and play.
      // Keep their time ranges and frame callbacks consistent with that model;
      // real decode and presentation are verified by the separate NAS/browser soak.
      Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
        get: () => 4,
      });
      Object.defineProperty(HTMLMediaElement.prototype, "duration", {
        get: () => 3600,
      });
      HTMLMediaElement.prototype.play = async function () {
        playing.add(this);
      };
      HTMLMediaElement.prototype.pause = function () {
        playing.delete(this);
      };
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (
        callback,
      ) {
        const element = this;
        const frame = () => {
          if (playing.has(element) || !element.paused) {
            timers.delete(id);
            callback(performance.now(), {
              presentationTime: performance.now(),
              mediaTime: element.currentTime,
            } as VideoFrameCallbackMetadata);
          } else timers.set(id, setTimeout(frame, 100));
        };
        const id = ++serial;
        timers.set(id, setTimeout(frame, 100));
        return id;
      };
      let serial = 0;
      const timers = new Map<number, ReturnType<typeof setTimeout>>();
      HTMLVideoElement.prototype.cancelVideoFrameCallback = (id) => {
        clearTimeout(timers.get(id));
        timers.delete(id);
      };
      if (validMedia) {
        const positions = new WeakMap<HTMLMediaElement, number>();
        Object.defineProperties(HTMLMediaElement.prototype, {
          currentTime: {
            configurable: true,
            get() {
              return positions.get(this) ?? 0;
            },
            set(value) {
              positions.set(this, value);
            },
          },
          seekable: {
            configurable: true,
            get: () => ({ length: 1, start: () => 0, end: () => 3600 }),
          },
          buffered: {
            configurable: true,
            get: () => ({ length: 1, start: () => 0, end: () => 3600 }),
          },
        });
      }
    },
    { validMedia: opts.validMedia === true },
  );
  const frames: any[] = [],
    preparations: any[] = [],
    planGenerations = new Map<string, number>(),
    sockets: WebSocketRoute[] = [];
  let replyClock = !opts.holdClock,
    clockFrame: any;
  const clockEpoch = "epoch";
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
    const extra = mediaExtraResponse(r);
    if (extra) return extra;
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
      planGenerations.set(
        `session-${preparations.length}`,
        preparations.at(-1).plan_generation,
      );
      return r.fulfill({
        json: {
          session_id: `session-${preparations.length}`,
          plan_generation: preparations.at(-1).plan_generation,
          media_id: "movie",
          media_generation: 1,
          delivery_mode: "direct",
          transport: opts.nativeHls ? "hls" : "progressive",
          playback_url:
            opts.playbackUrl ?? `/empty-video?n=${preparations.length}`,
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
          plan_generation: planGenerations.get(path.split("/").at(-1)!),
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
              playback_status: opts.playbackStatus ?? "playing",
              anchor_position_ms: 0,
              anchor_server_time_ms: opts.anchorServerTimeMs ?? 200000,
              playback_rate: 1,
              controller_user_id: "owner",
              duration_ms: 3600000,
              clock_epoch: clockEpoch,
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
              clock_epoch: clockEpoch,
            }),
          );
      }
    });
  });
  await page.goto("/rooms/a");
  await expect(page.locator(".connection-status")).toHaveText("房间连接正常");
  await expect.poll(() => clockFrame?.type).toBe("CLOCK_SYNC");
  const heldClockFrame = clockFrame;
  return {
    frames,
    preparations,
    planGenerations,
    sockets,
    history,
    readinessReads: () => readinessReads,
    releaseReady() {
      mediaReady = true;
    },
    replyHeldClock() {
      sockets.at(-1)!.send(
        JSON.stringify({
          type: "CLOCK_SYNC_REPLY",
          t1: heldClockFrame.t1,
          t2: 2000000,
          t3: 2000000,
          clock_epoch: clockEpoch,
        }),
      );
    },
    async releaseClock() {
      replyClock = true;
      // Solicit a fresh round through the real bfcache wake path. A held reply
      // can expire while fixture setup runs and must not bypass the pending TTL.
      await page.evaluate(() =>
        window.dispatchEvent(
          new PageTransitionEvent("pageshow", { persisted: true }),
        ),
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

test("playing snapshot rejects expired clock replies; a fresh wake unlocks playback and visible-only events preserve it", async ({
  page,
}) => {
  const h = await setup(page, { holdClock: true });
  await page.clock.runFor(6000);
  expect(h.preparations).toHaveLength(0);
  await expect(page.locator(".playback-host [role=status]")).toHaveText(
    "正在重新校准房间时间…",
  );
  h.replyHeldClock();
  await page.clock.runFor(100);
  expect(h.preparations).toHaveLength(0);
  await expect(page.locator(".playback-host [role=status]")).toHaveText(
    "正在重新校准房间时间…",
  );
  await h.releaseClock();
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
  await expect(page.locator(".room-information-widget h1")).toHaveText("a");
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
      static Events={ERROR:'error'}; static isSupported(){return true} static getMediaSource(){return MediaSource}
      constructor(config){this.config=config;this.mediaSource=new MediaSource();window.hlsTest=this;window.hlsInitialSource=this.mediaSource;window.hlsSources=[];window.hlsStarts=[];window.hlsDetaches=0;window.hlsAttachments=0}
      loadSource(url){if(this.media&&this.url){const media=this.media;this.detachMedia();this.mediaSource=new MediaSource();this.attachMedia(media)}this.url=url;window.hlsSources.push(url)}
      attachMedia(media){this.media=media;window.hlsAttachments++} detachMedia(){this.media=null;window.hlsDetaches++}
      stopLoad(){} startLoad(position){window.hlsStarts.push(position)} destroy(){}
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
  let hlsPlans = 0;
  await page.route("**/api/v1/playback-sessions", async (r) => {
    hlsPlans++;
    h.planGenerations.set("hls", r.request().postDataJSON().plan_generation);
    return r.fulfill({
      json: {
        session_id: "hls",
        plan_generation: r.request().postDataJSON().plan_generation,
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
    });
  });
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
  expect(
    await page.evaluate(() => ({
      detaches: (window as any).hlsDetaches,
      attachments: (window as any).hlsAttachments,
      replaced:
        (window as any).hlsTest.mediaSource !==
        (window as any).hlsInitialSource,
    })),
  ).toEqual({ detaches: 3, attachments: 4, replaced: true });
  await expect(page.getByRole("alert")).toContainText("媒体加载失败");
  expect(h.preparations).toHaveLength(1);
  expect(hlsPlans).toBe(1);
});

test("same-attempt EVENT growth keeps its Hls and MediaSource while waiting for forward headroom", async ({
  page,
}) => {
  // This component fixture parses a real growing EVENT manifest, but does not
  // decode segments. The NAS soak separately verifies real Hls/MSE presentation.
  await page.route(/\/deps\/hls__js\.js(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
        export default class Hls {
          static Events = { ERROR: 'error' };
          static isSupported() { return true }
          static getMediaSource() { return MediaSource }
          constructor(config) {
            this.config = config;
            this.mediaSource = new MediaSource();
            this.end = 0;
            window.eventHls = this;
            window.eventHlsInitial ??= this;
            window.eventMediaSourceInitial ??= this.mediaSource;
            window.eventHlsStats ??= { instances: 0, loads: [], detaches: 0, attaches: 0, starts: [], manifests: [], plays: 0, errors: [], recoverySequence: [] };
            window.eventHlsStats.instances++;
            this.timer = setInterval(() => { void this.refresh() }, 250);
          }
          async refresh() {
            if (!this.url || this.refreshing) return;
            this.refreshing = true;
            try {
              const response = await fetch(this.url);
              if (!response.ok) {
                window.eventHlsStats.errors.push(response.status);
                window.eventHlsStats.recoverySequence.push("error:" + response.status);
                this.error?.(Hls.Events.ERROR, { fatal: true, response: { code: response.status }, details: 'manifestLoadError' });
                return;
              }
              const text = await response.text();
              const durations = [...text.matchAll(/#EXTINF:([\\d.]+)/g)].map(match => Number(match[1]));
              const end = durations.reduce((sum, value) => sum + value, 0);
              if (end !== this.end) {
                this.end = end;
                window.eventHlsStats.manifests.push({ end, event: text.includes('#EXT-X-PLAYLIST-TYPE:EVENT'), complete: text.includes('#EXT-X-ENDLIST') });
                if (!this.metadata && this.media) {
                  this.metadata = true;
                  this.media.dispatchEvent(new Event('loadedmetadata'));
                }
              }
            } finally { this.refreshing = false }
          }
          loadSource(url) {
            if (this.media && this.url) {
              window.eventHlsStats.recoverySequence.push('recovery');
              const media = this.media;
              this.detachMedia();
              this.mediaSource = new MediaSource();
              this.attachMedia(media);
            }
            this.url = url;
            window.eventHlsStats.loads.push(url);
            void this.refresh();
          }
          attachMedia(media) {
            this.media = media;
            window.eventHlsStats.attaches++;
            let current = 0, paused = true, previous = performance.now();
            Object.defineProperties(media, {
              duration: { configurable: true, get: () => this.end },
              seekable: { configurable: true, get: () => ({ length: this.end ? 1 : 0, start: () => 0, end: () => this.end }) },
              buffered: { configurable: true, get: () => ({ length: this.end ? 1 : 0, start: () => 0, end: () => this.end }) },
              currentTime: { configurable: true, get: () => current, set: value => { current = value } },
              paused: { configurable: true, get: () => paused },
            });
            media.play = async () => { paused = false; window.eventHlsStats.plays++ };
            media.pause = () => { paused = true };
            this.playTimer = setInterval(() => {
              const now = performance.now();
              if (!paused) current = Math.min(this.end, current + (now - previous) / 1000 * media.playbackRate);
              previous = now;
            }, 100);
          }
          detachMedia() { clearInterval(this.playTimer); this.media = null; window.eventHlsStats.detaches++ }
          stopLoad() {}
          startLoad(position) { window.eventHlsStats.starts.push(position); void this.refresh() }
          on(name, callback) { this.error = callback }
          destroy() { clearInterval(this.timer); clearInterval(this.playTimer) }
        }
      `,
    }),
  );
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.canPlayType = () => "";
  });
  const h = await setup(page, {
    holdClock: true,
    nativeHls: true,
    // A four-second headroom window must advance only through runFor; real
    // elapsed time during network assertions can otherwise cause extra resumes.
    deterministicClock: true,
    playbackUrl: "/media-delivery/session-1/attempt-1/index.m3u8?token=test",
  });
  let publishedUntil = 1802000;
  let manifestFailures = 0;
  const reads: { position: number; until: number; complete: boolean }[] = [];
  await page.route("**/api/v1/playback-sessions/session-1?*", (route) => {
    const position = Number(
      new URL(route.request().url()).searchParams.get("relative_position_ms"),
    );
    reads.push({ position, until: publishedUntil, complete: false });
    return route.fulfill({
      json: {
        session_id: "session-1",
        plan_generation: h.planGenerations.get("session-1"),
        status: position < publishedUntil ? "ready" : "preparing",
        available_until_ms: publishedUntil,
        complete: false,
      },
    });
  });
  await page.route(
    "**/media-delivery/session-1/attempt-1/index.m3u8?*",
    (route) => {
      if (manifestFailures > 0) {
        manifestFailures--;
        return route.fulfill({
          status: 409,
          json: { error: { code: "STALE_MEDIA_ATTEMPT" } },
        });
      }
      return route.fulfill({
        contentType: "application/vnd.apple.mpegurl",
        body: [
          "#EXTM3U",
          "#EXT-X-VERSION:7",
          "#EXT-X-TARGETDURATION:4",
          "#EXT-X-PLAYLIST-TYPE:EVENT",
          "#EXT-X-MEDIA-SEQUENCE:0",
          ...Array.from(
            { length: publishedUntil / 4000 },
            (_, index) => `#EXTINF:4.000,\nsegment-${index}.m4s`,
          ),
          "",
        ].join("\n"),
      });
    },
  );
  const stats = () =>
    page.evaluate(() => {
      const w = window as any;
      return {
        ...w.eventHlsStats,
        sameHls: w.eventHls === w.eventHlsInitial,
        sameMediaSource: w.eventHls?.mediaSource === w.eventMediaSourceInitial,
        current: document.querySelector("video")!.currentTime,
        paused: document.querySelector("video")!.paused,
      };
    });
  await h.releaseClock();
  await expect.poll(() => reads.length).toBe(1);
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => (window as any).eventHls)).toBeUndefined();
  expect(h.preparations).toHaveLength(1);
  expect(reads.every((read) => read.until - read.position < 4000)).toBe(true);
  publishedUntil = 1812000;
  await page.clock.runFor(1000);
  await expect.poll(async () => (await stats()).loads?.length).toBe(1);
  await expect.poll(async () => (await stats()).plays).toBeGreaterThan(0);
  let resumes = 0;
  for (let cycle = 0; cycle < 3; cycle++) {
    const initialReads = reads.length;
    // Advance the authoritative room clock naturally past this published prefix.
    const untilSeconds = publishedUntil / 1000;
    const current = (await stats()).current;
    await page.clock.runFor(Math.ceil((untilSeconds - current + 1) * 1000));
    await expect.poll(() => reads.length).toBeGreaterThan(initialReads);
    const waitingRead = reads.at(-1)!;
    expect(waitingRead.position).toBeGreaterThan(waitingRead.until);
    const beforeResume = (await stats()).starts.length;
    publishedUntil += 4000;
    await page.clock.runFor(1000);
    // A newly visible segment can contain the target while lacking a whole
    // forward segment. That server-side ready result must not resume playback.
    expect(reads.at(-1)!.position).toBeLessThan(publishedUntil);
    expect(publishedUntil - reads.at(-1)!.position).toBeLessThan(4000);
    expect((await stats()).starts).toHaveLength(beforeResume);
    publishedUntil += 4000;
    await page.clock.runFor(1000);
    resumes++;
    await expect.poll(async () => (await stats()).starts.length).toBe(resumes);
    // startLoad requests the refreshed EVENT manifest asynchronously. A paused
    // browser clock must not advance playback against the previous short range
    // before the real fetch has completed and the fixture has exposed its end.
    await expect
      .poll(async () => (await stats()).manifests.at(-1)?.end)
      .toBe(publishedUntil / 1000);
    await page.clock.runFor(300);
    await expect
      .poll(async () => {
        const value = await stats();
        if (value.paused || value.current <= waitingRead.position / 1000)
          await page.clock.runFor(100);
        const progressed = await stats();
        return (
          !progressed.paused && progressed.current > waitingRead.position / 1000
        );
      })
      .toBe(true);
    const after = await stats();
    expect(after.current).toBeGreaterThan(waitingRead.position / 1000);
    expect(after.paused).toBe(false);
    expect(after.sameHls).toBe(true);
    expect(after.sameMediaSource).toBe(true);
    expect(after.loads).toEqual([
      "/media-delivery/session-1/attempt-1/index.m3u8?token=test",
    ]);
    expect(after.detaches).toBe(0);
    expect(after.attaches).toBe(1);
    expect(after.instances).toBe(1);
    expect(h.preparations).toHaveLength(1);
  }
  const after = await stats();
  expect(after.manifests.length).toBeGreaterThanOrEqual(4);
  expect(after.manifests.every((m: any) => m.event && !m.complete)).toBe(true);
  expect(reads.every((read) => !read.complete)).toBe(true);
  expect(h.frames.filter((frame) => frame.type === "END_MEDIA")).toHaveLength(
    0,
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  // A real HTTP 409 remains a distinct stale-attempt recovery. Unlike ordinary
  // EVENT growth it must re-create MediaSource, within the existing three tries.
  manifestFailures = 1;
  await page.clock.runFor(250);
  await expect.poll(async () => (await stats()).loads.length).toBe(2);
  expect((await stats()).detaches).toBe(1);
  expect((await stats()).sameMediaSource).toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0);
  manifestFailures = 3;
  // The installed clock also advances while route responses and polling await.
  // Consecutive errors can therefore cross an intermediate count between polls.
  // Keep the burst and exact final sequence/budget assertions; do not require
  // observing every transient count as if fetch completion were synchronous.
  await page.clock.runFor(750);
  await expect
    .poll(async () => {
      // HTTP completion can occur after runFor returns. Advance the paused
      // clock until the next refresh runs, while retaining the exact retry budget.
      if ((await stats()).errors.length < 4) await page.clock.runFor(250);
      return (await stats()).errors;
    })
    .toEqual([409, 409, 409, 409]);
  const failed = await stats();
  expect(failed.errors).toEqual([409, 409, 409, 409]);
  expect(failed.recoverySequence).toEqual([
    "error:409",
    "recovery",
    "error:409",
    "recovery",
    "error:409",
    "recovery",
    "error:409",
  ]);
  expect(failed.loads).toHaveLength(4);
  expect(failed.detaches).toBe(3);
  expect(failed.attaches).toBe(4);
  expect(failed.instances).toBe(1);
  expect(h.preparations).toHaveLength(1);
  await expect(page.getByRole("alert")).toContainText("媒体加载失败");
});

test("room chooser without a selection preserves the current viewing connection", async ({
  page,
}) => {
  const h = await setup(page, {
    validMedia: true,
    anchorServerTimeMs: 2000000,
  });
  await expect.poll(() => h.preparations.length).toBe(1);
  await navigate(page, "放映室");
  await expect(page.locator(".mini-player")).toBeVisible();
  await page.getByRole("link", { name: "返回房间", exact: true }).click();
  await expect(page.locator(".room-information-widget h1")).toHaveText("a");
  await page.clock.fastForward(1000);
  expect(h.sockets).toHaveLength(1);
  expect(h.preparations).toHaveLength(1);
  await expect(page.locator("video")).toHaveAttribute("src", /empty-video/);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("mini player keeps calibration visible until a fresh clock reply arrives", async ({
  page,
}, info) => {
  const h = await setup(page, {
    holdClock: true,
    validMedia: true,
    anchorServerTimeMs: 2000000,
  });
  await navigate(page, "放映室");
  const mini = page.locator(".mini-player");
  await expect(mini).toBeVisible();
  const status = mini.getByRole("status");
  await expect(status).toBeVisible();
  await expect(status).toHaveText("正在重新校准房间时间…");
  expect(h.preparations).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("mini-calibration.png") });
  await h.releaseClock();
  await expect.poll(() => h.preparations.length).toBe(1);
  await expect(mini.locator("video")).toHaveAttribute("src", /empty-video/);
  expect(h.sockets).toHaveLength(1);
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

test("ending an incomplete generated prefix waits without advancing the room", async ({
  page,
}) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.canPlayType = () => "probably";
  });
  const h = await setup(page, { validMedia: true, nativeHls: true });
  await expect(page.locator("video")).toHaveAttribute("src", /empty-video/);
  let reads = 0;
  await page.route("**/api/v1/playback-sessions/session-1?*", (r) => {
    reads++;
    return r.fulfill({
      json: {
        session_id: "session-1",
        plan_generation: h.planGenerations.get("session-1"),
        status: reads === 1 ? "ready" : "preparing",
        complete: false,
        available_until_ms: 10000,
      },
    });
  });
  await page.evaluate(() => {
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "ended", {
      configurable: true,
      get: () => true,
    });
    video.dispatchEvent(new Event("ended"));
  });
  await expect.poll(() => reads).toBeGreaterThan(1);
  await page.clock.runFor(6000);
  expect(h.frames.filter((f) => f.type === "END_MEDIA")).toHaveLength(0);
  expect(h.preparations).toHaveLength(1);
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
        plan_generation: h.planGenerations.get("session-1"),
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
            plan_generation: h.planGenerations.get("session-1"),
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

test("teardown media errors are silent while active ambiguous media support is reported", async ({
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
  const h = await setup(page, {
    validMedia: true,
    playbackStatus: "paused",
  });
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
  await expect(page.getByRole("alert")).toContainText(
    "媒体加载或格式支持状态未知，请检查连接后重新加载",
  );
  await page.clock.fastForward(500);
  expect(h.preparations).toHaveLength(3);
});
