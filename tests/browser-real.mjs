import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer as netServer } from "node:net";
import { createWriteStream } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer as viteServer } from "vite";
import { isolatedServer, delay } from "./fixtures/server.mjs";

// Real isolated Server/PostgreSQL/Worker + Vue browser. No HTTP/WS route mocks.
const entry = process.env.RAINSYNC_TEST_ENTRY ?? "";
async function unusedPort() {
  const s = netServer();
  await new Promise((done, reject) =>
    s.once("error", reject).listen(0, "127.0.0.1", done),
  );
  const port = s.address().port;
  await new Promise((done) => s.close(done));
  return port;
}
const vitePort = await unusedPort(),
  workerPort = await unusedPort(),
  origin = `http://127.0.0.1:${vitePort}`,
  workerOrigin = `http://127.0.0.1:${workerPort}`;
async function ready(url, child) {
  for (let i = 0; i < 150; i++) {
    if (child?.exitCode !== null && child)
      throw Error("Worker exited before readiness");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {}
    await delay(100);
  }
  throw Error("Service readiness timed out");
}
async function json(context, path) {
  const r = await context.request.get(origin + "/api/v1" + path, {
    timeout: 15000,
  });
  assert.equal(r.status(), 200, `GET ${path} status`);
  return r.json();
}
async function nav(page, label) {
  await page
    .getByRole("link", { name: label, exact: true })
    .filter({ visible: true })
    .click();
}
async function login(page, username, password) {
  await page.goto(origin + entry + "/login");
  await page.getByLabel("登录账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "放映室", exact: true }),
  ).toBeVisible();
}
function observe(page) {
  const stats = {
    sockets: 0,
    prepares: 0,
    errors: [],
    commands: [],
    plans: [],
    metrics: [],
  };
  page.on("pageerror", (e) => stats.errors.push(e.message));
  page.on("websocket", (ws) => {
    if (new URL(ws.url()).pathname !== "/api/v1/ws") return;
    stats.sockets++;
    ws.on("framesent", (frame) => {
      try {
        const v = JSON.parse(String(frame.payload));
        if (v.command_id) stats.commands.push(v.type);
      } catch {}
    });
  });
  page.on("request", (r) => {
    if (
      new URL(r.url()).pathname === "/api/v1/playback-sessions" &&
      r.method() === "POST"
    )
      stats.prepares++;
  });
  page.on("response", async (r) => {
    const metricSession = new URL(r.url()).pathname.match(
      /^\/api\/v1\/playback-sessions\/([0-9a-f-]{36})\/metrics$/,
    );
    if (metricSession && r.request().method() === "POST") {
      try {
        stats.metrics.push({
          session: metricSession[1],
          status: r.status(),
          sample: r.request().postDataJSON(),
          receipt: await r.json(),
        });
      } catch (error) {
        stats.errors.push(`metrics response: ${error.message}`);
      }
    }
    if (
      new URL(r.url()).pathname === "/api/v1/playback-sessions" &&
      r.request().method() === "POST" &&
      r.ok()
    ) {
      try {
        const v = await r.json();
        stats.plans.push({
          session_id: v.session_id,
          delivery_mode: v.delivery_mode,
          transport: v.transport,
        });
      } catch {}
    }
  });
  return stats;
}
async function imageSource(page, tall) {
  return Buffer.from(
    await page.evaluate((tall) => {
      const canvas = document.createElement("canvas");
      canvas.width = tall ? 900 : 1800;
      canvas.height = tall ? 1800 : 900;
      const c = canvas.getContext("2d");
      c.fillStyle = "#ff0000";
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.fillStyle = "#0000ff";
      if (tall) c.fillRect(0, 900, 900, 900);
      else c.fillRect(900, 0, 900, 900);
      return canvas.toDataURL("image/png").split(",")[1];
    }, tall),
    "base64",
  );
}
async function storedAvatar(page, context, root, name) {
  const profile = await json(context, "/users/me/profile");
  assert.ok(profile.avatar_url);
  const response = await context.request.get(origin + profile.avatar_url);
  assert.equal(response.status(), 200);
  assert.match(response.headers()["content-type"], /image\/webp/);
  const bytes = await response.body();
  assert.ok(bytes.length <= 256 * 1024);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
  await writeFile(resolve(root, name + ".webp"), bytes);
  const pixels = await page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(
      new Blob([new Uint8Array(bytes)], { type: "image/webp" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const pixel = Array.from(ctx.getImageData(256, 256, 1, 1).data);
    bitmap.close();
    return { width: canvas.width, height: canvas.height, pixel };
  }, Array.from(bytes));
  assert.equal(pixels.width, 512);
  assert.equal(pixels.height, 512);
  return { version: profile.avatar_version, bytes: bytes.length, ...pixels };
}
await isolatedServer(
  "browser-real",
  async (fixture) => {
    let worker, dev, browser;
    const workerLog = createWriteStream(resolve(fixture.root, "worker.log"));
    const evidence = {
      started: new Date().toISOString(),
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      entry,
      stages: [],
      avatars: [],
      continuous: [],
    };
    function stage(value) {
      evidence.stages.push(value);
      console.log(value);
    }
    try {
      execFileSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x180:rate=24",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000",
          "-t",
          "180",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "64k",
          "-movflags",
          "+faststart",
          resolve(fixture.root, "acceptance-a.mp4"),
        ],
        {
          timeout: 90000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      await copyFile(
        resolve(fixture.root, "acceptance-a.mp4"),
        resolve(fixture.root, "acceptance-b.mp4"),
      );
      worker = spawn(
        resolve(
          fixture.target,
          `rainsync-media-worker${process.platform === "win32" ? ".exe" : ""}`,
        ),
        [],
        {
          env: { ...fixture.env, WORKER_BIND: `127.0.0.1:${workerPort}` },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      worker.stdout.pipe(workerLog, { end: false });
      worker.stderr.pipe(workerLog, { end: false });
      await ready(workerOrigin + "/health", worker);
      process.env.RAINSYNC_SERVER_PROXY_URL = fixture.origin;
      process.env.RAINSYNC_WORKER_PROXY_URL = workerOrigin;
      dev = await viteServer({
        root: resolve("apps/web"),
        configFile: resolve("apps/web/vite.config.ts"),
        server: { host: "127.0.0.1", port: vitePort, strictPort: true },
        logLevel: "warn",
      });
      await dev.listen();
      browser = await chromium.launch({
        executablePath: process.env.RAINSYNC_CHROMIUM_EXECUTABLE || undefined,
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required"],
      });
      const adminContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        locale: "zh-CN",
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const viewerContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        locale: "zh-CN",
      });
      const admin = await adminContext.newPage(),
        viewer = await viewerContext.newPage(),
        as = observe(admin),
        vs = observe(viewer);
      admin.setDefaultTimeout(15000);
      viewer.setDefaultTimeout(15000);
      await login(admin, "admin", fixture.password);
      await nav(admin, "片源管理");
      await admin
        .getByRole("button", { name: "添加片源", exact: true })
        .click();
      await admin.getByLabel("名称", { exact: true }).fill("验收合成媒体");
      await admin.getByLabel("容器内路径").fill(fixture.root);
      await admin.getByRole("button", { name: "保存片源" }).click();
      await expect(admin.getByRole("dialog")).not.toBeVisible();
      await admin.getByRole("button", { name: "检测并扫描" }).click();
      await expect(admin.getByText("本次扫描发现 2 部影片")).toBeVisible({
        timeout: 30000,
      });
      stage("real source create and FFprobe scan: two actual H264/AAC files");
      await nav(admin, "账号与注册");
      await admin
        .getByRole("button", { name: "生成邀请码", exact: true })
        .click();
      await admin.getByLabel("数量", { exact: true }).fill("2");
      await admin.getByRole("button", { name: "生成 2 个邀请码" }).click();
      const codes = await admin
        .getByLabel("全部邀请码", { exact: true })
        .inputValue();
      assert.equal(codes.split("\n").length, 2);
      await admin.getByRole("button", { name: "复制全部邀请码" }).click();
      await expect(admin.getByText("已复制", { exact: true })).toBeVisible();
      await admin.getByRole("button", { name: "关闭弹窗" }).click();
      await viewer.goto(origin + entry + "/register");
      await viewer
        .getByLabel("注册邀请码", { exact: true })
        .fill(codes.split("\n")[0]);
      await viewer.getByRole("button", { name: "验证并继续" }).click();
      const username = "real.viewer",
        password = " viewer pass ";
      await viewer.getByLabel("登录账号", { exact: true }).fill(username);
      await viewer.getByLabel("昵称（可选）").fill("验收观众🙂");
      await viewer.getByLabel("密码", { exact: true }).fill(password);
      await viewer.getByLabel("确认密码", { exact: true }).fill(password);
      await viewer.getByRole("button", { name: "注册并登录" }).click();
      await expect(
        viewer.getByRole("heading", { name: "放映室", exact: true }),
      ).toBeVisible();
      await expect(viewer.getByText("还没有加入放映室")).toBeVisible();
      const identity = await json(viewerContext, "/auth/me");
      assert.equal(identity.admin, false);
      assert.equal(identity.username, username);
      assert.equal(
        fixture.sql(
          "SELECT count(*) FROM registration_invites WHERE used_by IS NOT NULL",
        ),
        "1",
      );
      stage(
        "admin batch → anonymous validation → invited registration → Cookie/CSRF auto login; no automatic room membership",
      );
      await nav(viewer, "个人资料");
      await viewer.getByLabel("昵称", { exact: true }).fill("独立昵称草稿🙂");
      for (const [name, tall, direction, channel] of [
        ["wide-left", false, "ArrowLeft", 0],
        ["wide-right", false, "ArrowRight", 2],
        ["tall-top", true, "ArrowUp", 0],
        ["tall-bottom", true, "ArrowDown", 2],
      ]) {
        await viewer.getByLabel("选择头像图片").setInputFiles({
          name: name + ".png",
          mimeType: "image/png",
          buffer: await imageSource(viewer, tall),
        });
        await expect(
          viewer.getByRole("dialog", { name: "调整头像" }),
        ).toBeVisible();
        await viewer.getByLabel("缩放", { exact: true }).fill("2");
        const crop = viewer.getByLabel("头像取景区域，方向键移动取景");
        await crop.focus();
        for (let i = 0; i < 10; i++)
          await viewer.keyboard.press("Shift+" + direction);
        await viewer
          .getByRole("button", { name: "保存头像", exact: true })
          .click();
        await expect(
          viewer.getByText("头像已保存", { exact: true }),
        ).toBeVisible({ timeout: 20000 });
        const result = await storedAvatar(
          viewer,
          viewerContext,
          fixture.root,
          name,
        );
        assert.ok(result.pixel[channel] > 230);
        assert.ok(result.pixel[channel === 0 ? 2 : 0] < 25);
        evidence.avatars.push({ name, ...result });
        await expect(viewer.getByLabel("昵称", { exact: true })).toHaveValue(
          "独立昵称草稿🙂",
        );
        assert.equal(
          (await json(viewerContext, "/users/me/profile")).display_name,
          "验收观众🙂",
        );
      }
      const finalVersion = evidence.avatars.at(-1).version;
      await viewer
        .getByRole("button", { name: "保存昵称", exact: true })
        .click();
      await expect(
        viewer.getByText("昵称已保存", { exact: true }),
      ).toBeVisible();
      const savedProfile = await json(viewerContext, "/users/me/profile");
      assert.equal(savedProfile.avatar_version, finalVersion);
      assert.equal(savedProfile.username, username);
      await viewer.reload();
      await expect(viewer.getByLabel("昵称", { exact: true })).toHaveValue(
        "独立昵称草稿🙂",
      );
      await expect(viewer.getByLabel("登录账号")).toHaveValue(username);
      await viewer
        .getByRole("button", { name: "退出登录", exact: true })
        .filter({ visible: true })
        .click();
      await login(viewer, username, password);
      stage(
        "wide/tall original pixels cropped in opposite directions; real 512×512 WebP stored; nickname/avatar saves independent; immutable login still works",
      );
      await nav(admin, "放映室");
      await admin
        .getByRole("button", { name: "创建房间", exact: true })
        .click();
      await admin.getByLabel("房间名称").fill("真实联调放映室");
      await admin.getByRole("button", { name: "创建并进入" }).click();
      await expect(
        admin.getByRole("heading", {
          name: "真实联调放映室",
          level: 1,
          exact: true,
        }),
      ).toBeVisible();
      await expect(admin.locator(".connection-status")).toHaveText("房间连接正常");
      await admin
        .getByRole("button", { name: "邀请", exact: true })
        .click();
      await admin
        .getByRole("button", { name: "生成邀请", exact: true })
        .click();
      const roomInvitation = JSON.parse(
        await admin.getByLabel("完整房间邀请").inputValue(),
      );
      await admin.getByRole("button", { name: "关闭弹窗" }).click();
      await viewer.getByRole("button", { name: "通过邀请加入" }).click();
      await viewer
        .getByLabel("粘贴完整房间邀请")
        .fill(JSON.stringify(roomInvitation));
      await viewer.getByRole("button", { name: "解析邀请" }).click();
      await viewer
        .getByRole("button", { name: "加入房间", exact: true })
        .click();
      await expect(
        viewer.getByRole("heading", {
          name: "真实联调放映室",
          level: 1,
          exact: true,
        }),
      ).toBeVisible();
      await nav(admin, "媒体库");
      const media = await json(adminContext, "/media");
      assert.equal(media.length, 2);
      for (const item of media)
        await admin
          .getByRole("button", { name: "加入待播 " + item.title, exact: true })
          .click();
      await admin
        .getByRole("button", { name: "播放 " + media[0].title, exact: true })
        .click();
      await expect(admin.locator("video")).toHaveAttribute(
        "src",
        /\/media-delivery\//,
        { timeout: 30000 },
      );
      await expect(viewer.locator("video")).toHaveAttribute(
        "src",
        /\/media-delivery\//,
        { timeout: 30000 },
      );
      await expect(admin.locator(".queue-row")).toHaveCount(2);
      await admin.locator("video").hover();
      await expect(
        admin.getByRole("button", { name: "暂停房间播放", exact: true }),
      ).toBeEnabled();
      await expect
        .poll(() => admin.locator("video").evaluate((el) => el.currentTime), {
          timeout: 20000,
        })
        .toBeGreaterThan(2);
      await expect
        .poll(() => viewer.locator("video").evaluate((el) => el.currentTime), {
          timeout: 20000,
        })
        .toBeGreaterThan(2);
      evidence.clientReportedMetrics = [];
      for (const [label, stats] of [
        ["owner", as],
        ["viewer", vs],
      ]) {
        await expect
          .poll(
            () =>
              stats.metrics.some(
                (m) => m.status === 200 && m.sample.first_frame,
              ),
            { timeout: 15000 },
          )
          .toBe(true);
        const measurement = stats.metrics.find(
          (m) => m.status === 200 && m.sample.first_frame,
        );
        const { sample, receipt, session } = measurement;
        assert.equal(sample.version, 2);
        assert.equal(Object.keys(sample.totals).length, 8);
        assert.ok(
          Object.values(sample.totals).every(
            (v) => Number.isInteger(v) && v >= 0,
          ),
        );
        assert.equal(
          Object.values(sample.totals).reduce((sum, v) => sum + v, 0),
          sample.elapsed_ms,
        );
        assert.ok(
          sample.first_frame.elapsed_ms <=
            sample.first_frame.confirmed_elapsed_ms,
        );
        assert.ok(sample.first_frame.confirmed_elapsed_ms <= sample.elapsed_ms);
        assert.ok(
          ["video_frame_callback", "playing_time_advance"].includes(
            sample.first_frame.evidence,
          ),
        );
        assert.deepEqual(Object.keys(sample.startup_phases).sort(), [
          "loading_ms",
          "preparation_ms",
          "unobserved_ms",
        ]);
        assert.ok(
          Object.values(sample.startup_phases).every(
            (v) => Number.isInteger(v) && v >= 0 && v <= 604800000,
          ),
        );
        assert.equal(
          Object.values(sample.startup_phases).reduce((sum, v) => sum + v, 0),
          sample.first_frame.confirmed_elapsed_ms,
        );
        assert.ok(Number.isInteger(sample.first_frame_plan_generation));
        assert.ok(
          sample.first_frame_plan_generation >= sample.meter_start_generation &&
            sample.first_frame_plan_generation <= sample.plan_generation,
        );
        assert.deepEqual(receipt, {
          session_id: session,
          meter_start_generation: sample.meter_start_generation,
          metrics_seq: sample.seq,
          closed: sample.final,
        });
        const persisted = JSON.parse(
          fixture.sql(
            `SELECT g.metrics_payload::text FROM playback_sessions p JOIN playback_viewer_plans g ON g.user_id=p.user_id AND g.room_id=p.room_id AND g.viewer_id=p.viewer_id WHERE p.id='${session}'`,
          ),
        );
        assert.ok(persisted.seq >= sample.seq);
        assert.equal(persisted.version, 2);
        assert.deepEqual(persisted.first_frame, sample.first_frame);
        assert.deepEqual(persisted.startup_phases, sample.startup_phases);
        assert.equal(
          persisted.first_frame_plan_generation,
          sample.first_frame_plan_generation,
        );
        evidence.clientReportedMetrics.push({ user: label, sample, receipt });
      }
      stage(
        "actual browser presentation callbacks produce conserved v2 metrics, startup phases, and originating grants accepted and persisted by the real receiver for both users",
      );
      await expect(
        viewer.getByRole("button", { name: "暂停房间播放", exact: true }),
      ).toBeDisabled();
      await viewer.getByLabel("聊天消息").fill("真实用户昵称聊天");
      await viewer.getByRole("button", { name: "发送消息" }).click();
      await expect(
        admin.getByText("真实用户昵称聊天", { exact: true }),
      ).toBeVisible();
      await expect(admin.locator(".chat-message b")).toHaveText(
        "独立昵称草稿🙂",
      );
      await admin.getByRole("button", { name: "暂停房间播放", exact: true }).click();
      await expect
        .poll(() => viewer.locator("video").evaluate((el) => el.paused))
        .toBe(true);
      await admin.getByLabel("播放进度").fill("20");
      await admin.getByLabel("播放进度").dispatchEvent("change");
      await expect
        .poll(() => viewer.locator("video").evaluate((el) => el.currentTime), {
          timeout: 15000,
        })
        .toBeGreaterThan(19);
      await admin.getByRole("button", { name: "播放房间", exact: true }).click();
      await expect
        .poll(() => viewer.locator("video").evaluate((el) => el.paused))
        .toBe(false);
      const skew = Math.abs(
        (await admin.locator("video").evaluate((el) => el.currentTime)) -
          (await viewer.locator("video").evaluate((el) => el.currentTime)),
      );
      assert.ok(skew < 1.5, `real browsers drift ${skew}`);
      evidence.syncSkewSeconds = skew;
      stage(
        "actual Worker video decodes and advances in two users; owner play/pause/seek sync, viewer cannot control; nickname chat and playlist accepted",
      );
      await admin.evaluate(() => {
        window.__acceptanceVideo = document.querySelector("video");
      });
      const before = {
        sockets: as.sockets,
        prepares: as.prepares,
        sessions: fixture.sql("SELECT count(*) FROM playback_sessions"),
      };
      for (const label of [
        "媒体库",
        "片源管理",
        "NAS 设备",
        "账号与注册",
        "个人资料",
      ]) {
        const time = await admin
          .locator("video")
          .evaluate((el) => el.currentTime);
        await nav(admin, label);
        await expect(admin.locator(".mini-player")).toBeVisible();
        await expect
          .poll(() => admin.locator("video").evaluate((el) => el.currentTime), {
            timeout: 10000,
          })
          .toBeGreaterThan(time + 0.3);
        assert.equal(
          await admin.evaluate(
            () => window.__acceptanceVideo === document.querySelector("video"),
          ),
          true,
        );
        await expect(admin.locator("video")).toHaveCount(1);
        evidence.continuous.push({
          route: label,
          time: await admin.locator("video").evaluate((el) => el.currentTime),
        });
      }
      await admin.getByRole("link", { name: "返回房间" }).click();
      assert.equal(
        await admin.evaluate(
          () => window.__acceptanceVideo === document.querySelector("video"),
        ),
        true,
      );
      assert.equal(as.sockets, before.sockets);
      assert.equal(as.prepares, before.prepares);
      assert.equal(
        fixture.sql("SELECT count(*) FROM playback_sessions"),
        before.sessions,
      );
      evidence.playback = {
        before,
        after: {
          sockets: as.sockets,
          prepares: as.prepares,
          sessions: fixture.sql("SELECT count(*) FROM playback_sessions"),
        },
        plans: as.plans,
      };
      await admin
        .getByRole("button", { name: "移除 " + media[1].title, exact: true })
        .click();
      await expect(admin.locator(".queue-row")).toHaveCount(1);
      stage(
        "watch → library → sources → NAS → invitation admin → profile → same room: one DOM video, unchanged WebSocket and playback/session counts, advancing time",
      );
      await viewer.goto(origin + entry + "/admin/sources");
      await expect(viewer.getByRole("alert")).toContainText("仅管理员");
      assert.equal(
        (
          await viewerContext.request.get(
            origin + "/api/v1/admin/registration-invites",
          )
        ).status(),
        403,
      );
      await nav(admin, "管理");
      await nav(admin, "账号与注册");
      await admin
        .getByRole("link", { name: "手动创建账号", exact: true })
        .click();
      await admin.getByLabel("登录账号", { exact: true }).fill("manual.viewer");
      await admin.getByLabel("昵称（可选）").fill("手动普通账号");
      await admin.getByLabel("密码", { exact: true }).fill(" manual pass ");
      await admin.getByRole("button", { name: "创建普通账号" }).click();
      await expect(
        admin.getByText("普通账号 manual.viewer 已创建"),
      ).toBeVisible();
      assert.equal(
        fixture.sql("SELECT admin FROM users WHERE username='manual.viewer'"),
        "f",
      );
      await nav(admin, "NAS 设备");
      await admin.getByRole("button", { name: "添加设备" }).click();
      await admin.getByLabel("设备名称").fill("联调未配对设备");
      await admin.getByRole("button", { name: "生成配对码" }).click();
      await expect(admin.getByLabel("配对码", { exact: true })).not.toHaveValue(
        "",
      );
      await admin.getByRole("button", { name: "关闭弹窗" }).click();
      await admin
        .getByRole("button", { name: "撤销设备", exact: true })
        .click();
      await admin.getByRole("button", { name: "确认撤销设备" }).click();
      await expect(admin.getByRole("dialog")).not.toBeVisible();
      const revokedAgent = admin.getByRole("article").filter({
        has: admin.getByRole("heading", {
          name: "联调未配对设备",
          exact: true,
        }),
      });
      await expect(revokedAgent).toHaveCount(1);
      await expect(
        revokedAgent.getByText(/^已撤销\s*· 最后联系：/),
      ).toBeVisible();
      await expect(
        revokedAgent.getByText("设备凭据已失效，无法继续读取片源", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        revokedAgent.getByRole("button", { name: "撤销设备", exact: true }),
      ).toBeDisabled();
      stage(
        "ordinary route/API denied, admin manual account ordinary-only, real NAS creation/revoke interface",
      );
      await fixture.stopServer();
      await fixture.startServer();
      await nav(viewer, "个人资料");
      await expect(viewer.getByLabel("昵称", { exact: true })).toHaveValue(
        "独立昵称草稿🙂",
      );
      const afterRestart = await storedAvatar(
        viewer,
        viewerContext,
        fixture.root,
        "after-restart",
      );
      assert.equal(afterRestart.version, finalVersion);
      assert.deepEqual(afterRestart.pixel, evidence.avatars.at(-1).pixel);
      assert.equal((await json(viewerContext, "/auth/me")).username, username);
      assert.equal(
        fixture.sql(
          "SELECT count(*) FROM registration_invites WHERE used_by IS NOT NULL",
        ),
        "1",
      );
      stage(
        "Server restart retains session, account/nickname, invitation consumption and final avatar bytes",
      );
      assert.deepEqual(as.errors, []);
      assert.deepEqual(vs.errors, []);
      evidence.finished = new Date().toISOString();
      evidence.result = "passed";
      await writeFile(
        resolve(fixture.root, "evidence.json"),
        JSON.stringify(evidence, null, 2),
      );
      console.log(
        "Real browser evidence: " + resolve(fixture.root, "evidence.json"),
      );
    } catch (error) {
      if (browser) {
        let i = 0;
        for (const context of browser.contexts())
          for (const page of context.pages()) {
            await page
              .screenshot({
                path: resolve(fixture.root, `failure-${i++}.png`),
                fullPage: true,
              })
              .catch(() => {});
            await writeFile(
              resolve(fixture.root, `failure-${i}.txt`),
              await page
                .locator("body")
                .innerText()
                .catch(() => "unavailable"),
            );
          }
      }
      throw error;
    } finally {
      await browser?.close();
      await dev?.close();
      if (worker && worker.exitCode === null) {
        const closed = new Promise((done) => worker.once("close", done));
        worker.kill();
        await closed;
      }
      await new Promise((done) => workerLog.end(done));
    }
  },
  {
    env: {
      PUBLIC_ORIGIN: origin,
      WORKER_URL: workerOrigin,
      WORKER_BIND: `127.0.0.1:${workerPort}`,
      PLAYBACK_SESSION_LIMIT: "4",
    },
  },
);
