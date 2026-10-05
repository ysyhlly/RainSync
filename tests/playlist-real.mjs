import assert from "node:assert/strict";
import { createServer as viteServer } from "vite";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
const listener = createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const origin = `http://127.0.0.1:${port}`;
await isolatedMediaStack(
  "playlist-real",
  async (f) => {
    let browser, dev;
    try {
      const admin = f.client();
      await admin.login();
      await f.makeClip("first.mp4", { pictureSeconds: 4, color: "red" });
      await f.makeClip("second.mp4", { pictureSeconds: 4, color: "blue" });
      const source = await admin.request("/sources", "POST", {
        name: "loop fixture",
        kind: "local",
        config: { root: f.root },
      });
      await admin.request(`/sources/${source.id}/test`, "POST");
      const media = await admin.request("/media");
      const first = media.find((m) => m.title === "first"),
        second = media.find((m) => m.title === "second");
      const room = await admin.request("/rooms", "POST", {
        name: "Automatic loop",
      });
      await admin.request(`/rooms/${room.id}/playlist`, "POST", {
        media_id: first.id,
      });
      await admin.request(`/rooms/${room.id}/playlist`, "POST", {
        media_id: second.id,
      });
      await f.startWorker();
      process.env.RAINSYNC_SERVER_PROXY_URL = f.origin;
      process.env.RAINSYNC_WORKER_PROXY_URL = f.workerOrigin;
      dev = await viteServer({
        root: resolve("apps/web"),
        configFile: resolve("apps/web/vite.config.ts"),
        server: { host: "127.0.0.1", port, strictPort: true },
        logLevel: "warn",
      });
      await dev.listen();
      browser = await chromium.launch({
        executablePath: process.env.RAINSYNC_CHROMIUM_EXECUTABLE || undefined,
        args: ["--autoplay-policy=no-user-gesture-required"],
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 960 },
      });
      const states = [],
        errors = [];
      let connections = 0;
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("websocket", (ws) => {
        if (!ws.url().endsWith("/api/v1/ws")) return;
        connections++;
        ws.on("framereceived", ({ payload }) => {
          const frame = JSON.parse(payload.toString());
          if (frame.type === "EVENT" && frame.state) states.push(frame.state);
        });
      });
      await page.goto(origin + "/login");
      await page.getByLabel("登录账号", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(f.password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByRole("button", { name: "进入房间", exact: true }).click();
      await expect(page.locator(".room-information")).toContainText("房间连接正常");
      await page
        .locator(".sidebar")
        .getByRole("link", { name: "媒体库", exact: true })
        .click();
      await page
        .getByRole("button", { name: "播放 first", exact: true })
        .click();
      await expect
        .poll(() => states.filter((s) => s.media_generation > 0).length, {
          timeout: 30000,
        })
        .toBeGreaterThanOrEqual(3);
      const changes = states.filter(
        (s, i) =>
          i === 0 || states[i - 1].media_generation !== s.media_generation,
      );
      assert.deepEqual(
        changes.slice(0, 3).map((s) => s.media_id),
        [first.id, second.id, first.id],
      );
      assert.ok(
        changes.slice(0, 3).every((s) => s.playback_status === "playing"),
      );
      assert.equal(
        (await admin.request(`/rooms/${room.id}/playlist`)).length,
        2,
      );
      await page.evaluate(
        () => (window.__video = document.querySelector("video")),
      );
      await page
        .locator(".sidebar")
        .getByRole("link", { name: "媒体库", exact: true })
        .click();
      for (const item of await admin.request(`/rooms/${room.id}/playlist`))
        await admin.request(`/rooms/${room.id}/playlist/${item.id}`, "DELETE");
      const last = states.at(-1);
      await expect
        .poll(() => states.at(-1).media_generation, { timeout: 15000 })
        .toBeGreaterThan(last.media_generation);
      assert.equal(states.at(-1).media_id, last.media_id);
      assert.equal(
        await page.evaluate(
          () => window.__video === document.querySelector("video"),
        ),
        true,
      );
      assert.equal(connections, 1);
      assert.deepEqual(errors, []);
      console.log(
        "PASS: real Chromium video naturally ends, automatically plays next, wraps, and repeats with empty playlist in mini player; persistent video and one WS",
      );
    } finally {
      await browser?.close();
      await dev?.close();
    }
  },
  { env: { PUBLIC_ORIGIN: origin } },
);
