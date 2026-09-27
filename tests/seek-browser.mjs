import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { createHash } from "node:crypto";

const manifestPath = resolve(process.argv[2] ?? "");
assert.ok(
  process.argv[2],
  "Usage: node tests/seek-browser.mjs .runtime/fixtures/seek-<id>/report.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.ok(
  Array.isArray(manifest.cases) && manifest.cases.length > 0,
  "empty seek manifest",
);
const root = dirname(manifestPath);
assert.equal(
  createHash("sha256")
    .update(await readFile(resolve(root, "source.mp4")))
    .digest("hex"),
  manifest.source_sha256,
);
const csp = (await readFile("deploy/Caddyfile", "utf8")).match(
  /Content-Security-Policy "([^"]+)"/,
)[1];
const server = await createServer({
  root: resolve("apps/web"),
  configFile: resolve("apps/web/vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: 0,
    headers: { "Content-Security-Policy": csp },
  },
});
let browser;
const evidence = {
  source_sha256: manifest.source_sha256,
  image_id: manifest.image_id,
  source_kind: manifest.source_kind ?? "cfr",
  source_frame_intervals_ms: manifest.source_frame_intervals_ms,
  generated_at: new Date().toISOString(),
  app_sha256: createHash("sha256")
    .update(await readFile("apps/web/src/App.vue"))
    .digest("hex"),
  package_lock_sha256: createHash("sha256")
    .update(await readFile("package-lock.json"))
    .digest("hex"),
  cases: [],
};
try {
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
  evidence.browser = browser.version();
  for (const item of manifest.cases.flatMap((c) =>
    ["native", "mse"].map((browser_transport) => ({ ...c, browser_transport })),
  )) {
    const page = await browser.newPage();
    if (item.browser_transport === "mse") {
      // Force only transport selection; decoding, MSE and hls.js remain real.
      await page.addInitScript(() => {
        const original = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function (type) {
          return type.toLowerCase().includes("mpegurl")
            ? ""
            : original.call(this, type);
        };
      });
    }
    assert.ok(["remux", "transcode"].includes(item.requested_mode));
    assert.ok(
      Number.isFinite(item.start_seconds) &&
        item.start_seconds >= 0 &&
        item.start_seconds < 12,
    );
    const delivered = new Map();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let socket;
    const state = {
      room_id: "room",
      revision: 1,
      media_id: "movie",
      media_generation: 1,
      playback_status: "paused",
      anchor_position_ms: item.start_seconds * 1000,
      anchor_server_time_ms: 0,
      playback_rate: 1,
      controller_user_id: "owner",
      duration_ms: 12000,
      clock_epoch: "test",
    };
    await page.route("**/seek-output/*", async (route) => {
      const name = basename(new URL(route.request().url()).pathname);
      assert.match(name, /^(index\.m3u8|init\.mp4|index\d+\.m4s)$/);
      const body = await readFile(
        resolve(root, `${item.requested_mode}-${item.start_seconds}`, name),
      );
      delivered.set(name, createHash("sha256").update(body).digest("hex"));
      return route.fulfill({
        contentType: name.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "video/mp4",
        body,
      });
    });
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/auth/me"))
        return route.fulfill({
          json: { id: "owner", username: "test", csrf: "test", admin: false },
        });
      if (path.endsWith("/rooms"))
        return route.fulfill({
          json: [{ id: "room", name: "seek", owner_id: "owner" }],
        });
      if (path.endsWith("/media"))
        return route.fulfill({
          json: [{ id: "movie", title: "seek fixture", kind: "local" }],
        });
      if (path.endsWith("/playback-sessions")) {
        assert.equal(
          route.request().postDataJSON().position_ms,
          item.start_seconds * 1000,
        );
        return route.fulfill({
          json: {
            session_id: "seek",
            media_id: "movie",
            media_generation: 1,
            delivery_mode: item.selected_mode,
            transport: "hls",
            playback_url: "/seek-output/index.m3u8",
            timeline_origin_ms: item.start_seconds * 1000,
            duration_ms: 12000,
            expires_in_seconds: 1800,
            rebuild_on_seek: true,
            audio_tracks: [],
            subtitle_tracks: [],
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
          ws.send(JSON.stringify({ type: "SNAPSHOT", state }));
      });
    });
    await page.goto(base);
    await page.getByLabel("选择房间").selectOption("room");
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return v?.readyState >= 2 && v.videoWidth === 160;
      },
      undefined,
      { timeout: 15000 },
    );
    const first = await page.locator("video").evaluate((v) => ({
      source: v.currentSrc,
      time: v.currentTime,
      duration: v.duration,
      frames: v.getVideoPlaybackQuality().totalVideoFrames,
    }));
    assert.equal(
      first.source.startsWith("blob:"),
      item.browser_transport === "mse",
      `unexpected ${item.browser_transport} source ${first.source}`,
    );
    assert.ok(
      first.time < 0.06,
      `unexpected initial browser time ${first.time}`,
    );
    assert.ok(Math.abs(first.duration - (12 - item.start_seconds)) < 0.1);
    await page.locator("video").evaluate((v) => {
      v.muted = true;
    });
    state.playback_status = "playing";
    state.anchor_server_time_ms = await page.evaluate(() => performance.now());
    state.revision++;
    socket.send(JSON.stringify({ type: "SNAPSHOT", state }));
    await page.waitForFunction(
      () => document.querySelector("video")?.currentTime > 0.6,
      undefined,
      { timeout: 15000 },
    );
    const played = await page.locator("video").evaluate((v) => ({
      time: v.currentTime,
      frames: v.getVideoPlaybackQuality().totalVideoFrames,
    }));
    assert.ok(played.frames > first.frames);
    state.playback_status = "paused";
    state.anchor_position_ms = item.start_seconds * 1000 + 1500;
    state.revision++;
    socket.send(
      JSON.stringify({ type: "SNAPSHOT", state, action: { type: "SEEK" } }),
    );
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return v?.paused && !v.seeking && Math.abs(v.currentTime - 1.5) < 0.06;
      },
      undefined,
      { timeout: 15000 },
    );
    assert.deepEqual(errors, []);
    evidence.cases.push({
      browser_transport: item.browser_transport,
      start_seconds: item.start_seconds,
      requested_mode: item.requested_mode,
      selected_mode: item.selected_mode,
      media_sha256: Object.fromEntries(delivered),
      first,
      played,
      seek_player_seconds: 1.5,
      seek_media_seconds: item.start_seconds + 1.5,
    });
    console.log(
      `PASS: App/${item.browser_transport} ${item.requested_mode} ${item.start_seconds}s: decoded startup, advancing frames, room seek mapping`,
    );
    await page.close();
  }
  await writeFile(
    resolve(root, "browser-report.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(`Evidence: ${resolve(root, "browser-report.json")}`);
} finally {
  await browser?.close();
  await server.close();
}
