import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer as netServer } from "node:net";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

// Real services, DB, encoder and browser. Only encoder input pacing and browser
// transport selection are controlled; no readiness/media/API response is mocked.
const tag = process.env.WORKER_TEST_IMAGE ?? "rainsync-worker-validation:local";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const name = `rainsync-slow-${randomUUID().slice(0, 8)}`;
const root = resolve(".runtime/slow-playback", name);
const db = `${name}-db`,
  server = `${name}-server`,
  worker = `${name}-worker`;
const password = randomBytes(24).toString("hex"),
  key = randomBytes(32).toString("base64");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, description, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`deadline: ${description}`);
}
const sql = (query) =>
  docker(
    "exec",
    db,
    "psql",
    "-U",
    "rainsync",
    "-d",
    "rainsync",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    query,
  );
async function port() {
  const s = netServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const origin = `http://127.0.0.1:${await port()}`;
const report = {
  image: docker("image", "inspect", "--format", "{{.Id}}", tag),
  cases: [],
};
let vite, browser, page;
await mkdir(resolve(root, "bin"), { recursive: true });
await mkdir(resolve(root, "media"));
await writeFile(
  resolve(root, "bin/ffmpeg"),
  `#!/bin/sh
for last do :; done
case "$last" in
  */index.m3u8) exec /usr/bin/ffmpeg -readrate 0.5 "$@" ;;
  *) exec /usr/bin/ffmpeg "$@" ;;
esac
`,
  { mode: 0o755 },
);
const env = [
  "-e",
  `DATABASE_URL=postgres://rainsync:${password}@db/rainsync`,
  "-e",
  `SOURCE_ENCRYPTION_KEY=${key}`,
  "-e",
  `ADMIN_PASSWORD=${password}`,
  "-e",
  `PUBLIC_ORIGIN=${origin}`,
];
try {
  docker(
    "run",
    "--rm",
    "--mount",
    `type=bind,source=${resolve(root, "media")},target=/media`,
    tag,
    "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=25",
    "-t",
    "40",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "/media/slow.mp4",
  );
  report.source_sha256 = createHash("sha256")
    .update(await readFile(resolve(root, "media/slow.mp4")))
    .digest("hex");
  report.app_sha256 = createHash("sha256")
    .update(await readFile("apps/web/src/App.vue"))
    .digest("hex");
  docker("network", "create", name);
  docker(
    "run",
    "-d",
    "--name",
    db,
    "--network",
    name,
    "--network-alias",
    "db",
    "-e",
    "POSTGRES_USER=rainsync",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "postgres:17",
  );
  await until(() => {
    try {
      return docker("exec", db, "pg_isready", "-U", "rainsync").includes(
        "accepting connections",
      );
    } catch {
      return false;
    }
  }, "DB ready");
  docker(
    "run",
    "-d",
    "--name",
    server,
    "--network",
    name,
    "-p",
    "127.0.0.1::8080",
    ...env,
    "--mount",
    `type=bind,source=${resolve(root, "media")},target=/media,readonly`,
    tag,
    "rainsync-server",
  );
  const apiBase = `http://${docker("port", server, "8080/tcp")}`;
  await until(async () => {
    try {
      return (await fetch(`${apiBase}/health`)).ok;
    } catch {
      return false;
    }
  }, "Server ready");
  docker(
    "run",
    "-d",
    "--name",
    worker,
    "--network",
    name,
    "-p",
    "127.0.0.1::8081",
    ...env,
    "-e",
    "PATH=/fixture:/usr/local/bin:/usr/bin:/bin",
    "--mount",
    `type=bind,source=${resolve(root, "bin")},target=/fixture,readonly`,
    "--mount",
    `type=bind,source=${resolve(root, "media")},target=/media,readonly`,
    tag,
    "rainsync-media-worker",
  );
  const workerBase = `http://${docker("port", worker, "8081/tcp")}`;
  const csp = (await readFile("deploy/Caddyfile", "utf8")).match(
    /Content-Security-Policy "([^"]+)"/,
  )[1];
  vite = await createServer({
    root: resolve("apps/web"),
    configFile: resolve("apps/web/vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: Number(new URL(origin).port),
      strictPort: true,
      headers: { "Content-Security-Policy": csp },
      proxy: {
        "/api": { target: apiBase, ws: true },
        "/media-delivery": workerBase,
      },
    },
  });
  await vite.listen();
  let cookie = "",
    csrf = "";
  async function api(path, method = "GET", body) {
    const r = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "x-csrf-token": csrf,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    if (r.headers.has("set-cookie"))
      cookie = r.headers.get("set-cookie").split(";")[0];
    const value = await r.json();
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(value)}`);
    return value;
  }
  csrf = (await api("/auth/login", "POST", { username: "admin", password }))
    .csrf;
  const source = await api("/sources", "POST", {
    name: "Slow encoding fixture",
    kind: "local",
    config: { root: "/media" },
  });
  await api(`/sources/${source.id}/test`, "POST");
  browser = await chromium.launch();
  report.browser = browser.version();
  for (const transport of process.env.SLOW_TRANSPORT
    ? [process.env.SLOW_TRANSPORT]
    : ["mse", "native"]) {
    const room = await api("/rooms", "POST", { name: `Slow ${transport}` });
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: cookie.split("=")[0],
        value: cookie.slice(cookie.indexOf("=") + 1),
        url: origin,
      },
    ]);
    page = await context.newPage();
    if (transport === "mse")
      await page.addInitScript(() => {
        const original = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function (type) {
          return type.toLowerCase().includes("mpegurl")
            ? ""
            : original.call(this, type);
        };
      });
    const evidence = { transport, readiness: [], plans: [], errors: [] };
    report.cases.push(evidence);
    const began = Date.now();
    const cdp = await context.newCDPSession(page);
    evidence.media = [];
    for (const event of [
      "playerErrorsRaised",
      "playerEventsAdded",
      "playerMessagesLogged",
    ])
      cdp.on(`Media.${event}`, (data) => evidence.media.push({ event, data }));
    await cdp.send("Media.enable");
    evidence.delivery = [];
    page.on("pageerror", (e) => evidence.errors.push(e.message));
    page.on("response", async (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/media-delivery/"))
        evidence.delivery.push({
          elapsed_ms: Date.now() - began,
          path: url.pathname,
          status: response.status(),
        });
      try {
        if (
          url.pathname === "/api/v1/playback-sessions" &&
          response.request().method() === "POST"
        ) {
          const p = await response.json();
          evidence.plans.push({
            session_id: p.session_id,
            timeline_origin_ms: p.timeline_origin_ms,
          });
        } else if (
          /\/api\/v1\/playback-sessions\/[^/]+$/.test(url.pathname) &&
          response.request().method() === "GET"
        ) {
          evidence.readiness.push({
            elapsed_ms: Date.now() - began,
            requested_ms: Number(url.searchParams.get("relative_position_ms")),
            ...(await response.json()),
          });
        }
      } catch (e) {
        evidence.errors.push(String(e));
      }
    });
    await page.goto(origin);
    await page.getByLabel("选择房间").selectOption(room.id);
    await page.getByLabel("播放方式").selectOption("transcode");
    await page.locator("video").evaluate((v) => {
      v.muted = true;
    });
    await page.locator(".poster").click();
    await page.waitForFunction(
      () => document.querySelector("video")?.readyState >= 2,
      undefined,
      { timeout: 60000 },
    );
    assert.equal(evidence.plans.length, 1);
    const sample = () =>
      page.locator("video").evaluate((v) => ({
        time: v.currentTime,
        paused: v.paused,
        frames: v.getVideoPlaybackQuality().totalVideoFrames,
        source: v.currentSrc,
        readyState: v.readyState,
        buffering: !!document.querySelector(".buffering"),
      }));
    evidence.initial = await sample();
    assert.equal(
      evidence.initial.source.startsWith("blob:"),
      transport === "mse",
    );
    await page.getByRole("button", { name: "▷ 播放", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector("video")?.currentTime > 1,
      undefined,
      { timeout: 15000 },
    );
    evidence.played = await sample();
    const count = evidence.readiness.length;
    await until(
      () =>
        evidence.readiness
          .slice(count)
          .some(
            (r) =>
              r.status === "preparing" &&
              r.requested_ms > r.available_until_ms &&
              r.available_until_ms > 0,
          ),
      "playback catches the encoder",
      55000,
    );
    evidence.waiting = await sample();
    assert.ok(
      evidence.waiting.paused && evidence.waiting.buffering,
      "out-of-range playback pauses and shows preparation",
    );
    assert.equal(evidence.plans.length, 1, "waiting must preserve the session");
    assert.equal(
      sql(
        `SELECT count(*) FROM media_jobs WHERE session_id='${evidence.plans[0].session_id}' AND status='running' AND attempt=1`,
      ),
      "1",
    );
    await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
    const afterPause = evidence.readiness.length;
    await until(
      () =>
        evidence.readiness.slice(afterPause).some((r) => r.status === "ready"),
      "encoder catches the paused room",
      55000,
    );
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return (
          v?.readyState >= 2 &&
          !v.seeking &&
          !document.querySelector(".buffering")
        );
      },
      undefined,
      { timeout: 20000 },
    );
    evidence.caught_up = await sample();
    evidence.paused_room_ms = Number(
      sql(
        `SELECT state->>'anchor_position_ms' FROM room_snapshots WHERE room_id='${room.id}'`,
      ),
    );
    assert.ok(
      Math.abs(
        evidence.caught_up.time * 1000 +
          evidence.plans[0].timeline_origin_ms -
          evidence.paused_room_ms,
      ) < 200,
      "recovery lands at the authoritative paused room position",
    );
    const available = evidence.readiness.filter(
      (r) => r.available_until_ms > 0,
    );
    const first = available[0],
      last = available.at(-1);
    evidence.observed_generation_rate =
      (last.available_until_ms - first.available_until_ms) /
      (last.elapsed_ms - first.elapsed_ms);
    assert.ok(
      evidence.observed_generation_rate > 0 &&
        evidence.observed_generation_rate < 0.8,
      "published output really grows slower than room playback",
    );
    assert.ok(
      evidence.caught_up.time > evidence.played.time,
      "recovery seeks to the newer room position",
    );
    await page.getByRole("button", { name: "▷ 播放", exact: true }).click();
    await page.waitForFunction(
      (before) => document.querySelector("video")?.currentTime > before + 0.6,
      evidence.caught_up.time,
      { timeout: 15000 },
    );
    evidence.resumed = await sample();
    assert.ok(
      evidence.resumed.frames > evidence.caught_up.frames,
      "recovery decodes new frames",
    );
    assert.equal(
      evidence.plans.length,
      1,
      "recovery must not prepare another session",
    );
    assert.deepEqual(evidence.errors, []);
    assert.equal(await page.getByRole("alert").count(), 0);
    evidence.final_transport = evidence.resumed.source.startsWith("blob:")
      ? "mse"
      : "native";
    if (transport === "native" && evidence.final_transport === "mse") {
      assert.ok(
        evidence.media.some((e) => e.event === "playerErrorsRaised"),
        "native failure precedes finite MSE fallback",
      );
    }
    evidence.job = JSON.parse(
      sql(
        `SELECT json_build_object('attempt',attempt,'status',status) FROM media_jobs WHERE session_id='${evidence.plans[0].session_id}'`,
      ),
    );
    await page.screenshot({
      path: resolve(root, `${transport}.png`),
      fullPage: true,
    });
    await api(`/playback-sessions/${evidence.plans[0].session_id}`, "DELETE");
    await context.close();
    page = undefined;
    console.log(
      `PASS: ${transport} slow real encoder, wait without replanning, paused-room catch-up and decoded recovery`,
    );
  }
  assert.equal(
    createHash("sha256")
      .update(await readFile("apps/web/src/App.vue"))
      .digest("hex"),
    report.app_sha256,
    "application source must not change during the run",
  );
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`Evidence: ${resolve(root, "report.json")}`);
} catch (e) {
  report.failure = String(e?.stack ?? e);
  if (page)
    report.video = await page
      .locator("video")
      .evaluate((v) => ({
        time: v.currentTime,
        paused: v.paused,
        seeking: v.seeking,
        duration: v.duration,
        width: v.videoWidth,
        readyState: v.readyState,
        error: v.error?.message,
        buffered: Array.from({ length: v.buffered.length }, (_, i) => [
          v.buffered.start(i),
          v.buffered.end(i),
        ]),
        seekable: Array.from({ length: v.seekable.length }, (_, i) => [
          v.seekable.start(i),
          v.seekable.end(i),
        ]),
      }))
      .catch(() => null);
  if (page)
    await page
      .screenshot({ path: resolve(root, "failure.png"), fullPage: true })
      .catch(() => {});
  for (const [label, container] of [
    ["server", server],
    ["worker", worker],
  ]) {
    try {
      await writeFile(resolve(root, `${label}.log`), docker("logs", container));
    } catch {}
  }
  await writeFile(
    resolve(root, "failed-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  throw e;
} finally {
  await browser?.close();
  await vite?.close();
  for (const container of [worker, server, db]) {
    try {
      docker("rm", "-f", "-v", container);
    } catch {}
  }
  try {
    docker("network", "rm", name);
  } catch {}
}
