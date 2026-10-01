import assert from "node:assert/strict";
import { createServer as viteServer } from "vite";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
const listener = createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const origin = `http://127.0.0.1:${port}`;
await isolatedMediaStack(
  "library-player-real",
  async (f) => {
    let dev, browser;
    const evidence = { stages: [], errors: [] };
    try {
      const admin = f.client();
      await admin.login();
      await admin.request("/users", "POST", {
        username: "viewer",
        password: "Fixture-pass-123",
      });
      const viewer = f.client();
      await viewer.login("viewer", "Fixture-pass-123");
      await f.makeClip("continuity.mp4", { pictureSeconds: 180 });
      const source = await admin.request("/sources", "POST", {
        name: "owned fixture",
        kind: "local",
        config: { root: f.root },
      });
      await admin.request(`/sources/${source.id}/test`, "POST");
      const media = (await admin.request("/media"))[0];
      await f.startWorker();
      await admin.request("/media/previews", "POST", { media_ids: [media.id] });
      await f.waitForPreview(media.id);
      assert.equal(f.sql("SELECT count(*) FROM playback_sessions"), "0");
      evidence.stages.push(
        "cover generated before room: zero playback sessions",
      );
      const room = await admin.request("/rooms", "POST", {
        name: "Continuity room",
      });
      const invite = await admin.request(`/rooms/${room.id}/invites`, "POST");
      await viewer.request(`/rooms/${room.id}/join`, "POST", {
        token: invite.token,
      });
      await viewer.request(`/media/${media.id}/personal-title`, "PUT", {
        title: "Viewer private",
        expected_revision: "0",
      });
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
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required"],
      });
      const ownerPage = await browser.newPage({
          viewport: { width: 1440, height: 1000 },
        }),
        viewerPage = await browser.newPage({
          viewport: { width: 1440, height: 1000 },
        });
      const stats = { sockets: 0, prepares: 0 };
      ownerPage.on("websocket", () => stats.sockets++);
      ownerPage.on("request", (r) => {
        if (r.url().endsWith("/playback-sessions") && r.method() === "POST")
          stats.prepares++;
      });
      for (const page of [ownerPage, viewerPage]) {
        page.on("pageerror", (e) => evidence.errors.push(e.message));
        page.setDefaultTimeout(15000);
      }
      async function login(page, name, password) {
        await page.goto(origin + "/login");
        await page.getByLabel("登录账号", { exact: true }).fill(name);
        await page.getByLabel("密码", { exact: true }).fill(password);
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await expect(page.locator(".page h1")).toHaveText("放映室");
        await page
          .getByRole("button", { name: "进入房间", exact: true })
          .click();
        await expect(page.locator(".room-information")).toContainText("房间连接正常");
      }
      await login(ownerPage, "admin", f.password);
      await login(viewerPage, "viewer", "Fixture-pass-123");
      async function nav(page, name) {
        await page
          .getByRole("link", { name, exact: true })
          .filter({ visible: true })
          .click();
      }
      await nav(ownerPage, "媒体库");
      await expect(
        ownerPage.locator(".media-thumbnail img").first(),
      ).toBeVisible();
      await ownerPage
        .getByRole("button", { name: "播放 continuity", exact: true })
        .click();
      await expect(ownerPage.locator(".room-information h2")).toHaveText(
        "continuity",
      );
      await expect(viewerPage.locator(".room-information h2")).toHaveText(
        "Viewer private",
      );
      await ownerPage.locator("video").hover();
      await expect(ownerPage.getByRole("button", { name: "暂停", exact: true })).toBeEnabled();
      for (const page of [ownerPage, viewerPage])
        await expect
          .poll(() => page.locator("video").evaluate((v) => v.currentTime), {
            timeout: 20000,
          })
          .toBeGreaterThan(1);
      await viewerPage.getByLabel("聊天消息").fill("two real users");
      await viewerPage.getByRole("button", { name: "发送消息" }).click();
      await expect(
        ownerPage.getByText("two real users", { exact: true }),
      ).toBeVisible();
      await ownerPage.evaluate(
        () => (window.__video = document.querySelector("video")),
      );
      const baseline = {
        ...stats,
        sessions: f.sql("SELECT count(*) FROM playback_sessions"),
      };
      for (const route of ["媒体库", "片源管理", "个人资料"]) {
        const before = await ownerPage
          .locator("video")
          .evaluate((v) => v.currentTime);
        await nav(ownerPage, route);
        if (route === "媒体库") {
          await ownerPage
            .getByRole("button", { name: "重命名 continuity", exact: true })
            .click();
          await ownerPage.getByLabel("仅我看到的名称").fill("Owner private");
          await ownerPage
            .getByRole("button", { name: "保存个人名称", exact: true })
            .click();
          await expect(
            ownerPage.getByText("名称已保存", { exact: true }),
          ).toBeVisible();
          await ownerPage.getByRole("button", { name: "关闭弹窗" }).click();
          await expect(ownerPage.locator(".mini-player h2")).toHaveText(
            "Owner private",
          );
        }
        await expect
          .poll(() => ownerPage.locator("video").evaluate((v) => v.currentTime))
          .toBeGreaterThan(before);
        assert.ok(
          await ownerPage.evaluate(
            () => window.__video === document.querySelector("video"),
          ),
        );
      }
      await ownerPage.getByRole("link", { name: "返回房间" }).click();
      await expect(ownerPage.locator(".room-information h2")).toHaveText(
        "Owner private",
      );
      await expect(viewerPage.locator(".room-information h2")).toHaveText(
        "Viewer private",
      );
      await ownerPage.locator("video").hover();
      await ownerPage
        .getByRole("button", { name: "全屏", exact: true })
        .click();
      await expect
        .poll(() =>
          ownerPage.evaluate(() =>
            document.fullscreenElement?.classList.contains("playback-host"),
          ),
        )
        .toBe(true);
      await ownerPage.getByRole("combobox", { name: "房间倍速" }).click();
      await ownerPage
        .getByRole("option", { name: "1.5×", exact: true })
        .click();
      await expect
        .poll(() => viewerPage.locator("video").evaluate((v) => v.playbackRate))
        .toBeCloseTo(1.5, 1);
      await ownerPage.getByText("播放选项", { exact: true }).click();
      await expect(
        ownerPage.getByRole("combobox", { name: "播放方式", exact: true }),
      ).toBeVisible();
      await ownerPage.getByText("播放选项", { exact: true }).click();
      await ownerPage.evaluate(() => document.exitFullscreen());
      assert.ok(
        await ownerPage.evaluate(
          () => window.__video === document.querySelector("video"),
        ),
      );
      assert.deepEqual(
        { ...stats, sessions: f.sql("SELECT count(*) FROM playback_sessions") },
        baseline,
      );
      assert.deepEqual(evidence.errors, []);
      evidence.baseline = baseline;
      evidence.stages.push(
        "two users: distinct names, synchronized video and chat; route/rename/fullscreen preserve DOM, WebSocket, preparations and DB session count",
      );
      await writeFile(
        resolve(f.root, "evidence.json"),
        JSON.stringify(evidence, null, 2),
      );
      console.log(
        "PASS: real library/player continuity; evidence " +
          resolve(f.root, "evidence.json"),
      );
    } finally {
      await browser?.close();
      await dev?.close();
    }
  },
  { env: { PUBLIC_ORIGIN: origin } },
);
