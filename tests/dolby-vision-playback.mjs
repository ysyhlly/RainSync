// Actual shipping images, PostgreSQL, HTTP/WS and Chromium; no route mocks.
// All services, users and media belong to this disposable test namespace.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  chown,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";
import WebSocket from "ws";
import { Client, delay } from "./fixtures/server.mjs";

const image = process.env.RAINSYNC_DOLBY_TEST_IMAGE;
const webImage = process.env.RAINSYNC_DOLBY_TEST_WEB_IMAGE;
const inputRoot = process.env.RAINSYNC_DOLBY_FIXTURE_ROOT;
assert.ok(
  image && webImage && inputRoot,
  "Set owned fixture root and tested backend/web image IDs",
);
const owner = randomUUID();
const root = await mkdtemp(
  resolve(process.env.RAINSYNC_ARTIFACT_DIR ?? tmpdir(), "dolby-playback-"),
);
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 60000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const network = `rainsync-dolby-${owner}`;
const names = ["db", "server", "worker", "web"].map(
  (role) => `${network}-${role}`,
);
const password = randomBytes(24).toString("hex");
let browser;
const sockets = [];
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const origin = `http://127.0.0.1:${port}`;
const fixture = { origin, password, env: { PUBLIC_ORIGIN: origin } };
const report = {
  schema_version: 1,
  owner,
  backend_image: image,
  web_image: webImage,
  native_display_acceptance: "not performed",
  checks: [],
  result: "running",
};
async function until(fn, label, milliseconds = 120000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw Error(`Deadline: ${label}`);
}
async function join(client, room) {
  const socket = new WebSocket(origin.replace("http:", "ws:") + "/api/v1/ws", {
    headers: { Origin: origin, Cookie: client.cookie },
  });
  sockets.push(socket);
  const frames = [];
  socket.on("message", (bytes) => frames.push(JSON.parse(bytes)));
  socket.on("error", () => {});
  await new Promise((done, reject) => {
    socket.once("open", done);
    socket.once("error", reject);
  });
  const next = (predicate) =>
    until(
      () => {
        const index = frames.findIndex(predicate);
        return index >= 0 ? frames.splice(index, 1)[0] : undefined;
      },
      "owned room frame",
      10000,
    );
  socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  return {
    socket,
    next,
    snapshot: await next((frame) => frame.type === "SNAPSHOT"),
  };
}
try {
  const media = resolve(root, "media"),
    cache = resolve(root, "cache");
  await mkdir(media);
  await mkdir(cache);
  await chown(cache, 10001, 10001);
  const file = resolve(media, "owned-dovi84.mp4");
  await copyFile(resolve(inputRoot, "dv84.mp4"), file);
  const original = await readFile(file);
  const envFile = resolve(root, "backend.private.env");
  await writeFile(
    envFile,
    [
      `DATABASE_URL=postgres://rainsync:${password}@db/rainsync`,
      `SOURCE_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
      "ADMIN_USERNAME=admin",
      `ADMIN_PASSWORD=${password}`,
      `PUBLIC_ORIGIN=${origin}`,
      `MEDIA_ORIGIN=${origin}`,
      `AGENT_DATA_ORIGIN=${origin}`,
      "WORKER_URL=http://worker:8081",
      "SERVER_INTERNAL_URL=http://server:8080",
      "MEDIA_ROOT=/media",
      "CACHE_ROOT=/cache",
      "PLAYBACK_SESSION_LIMIT=8",
      "CACHE_MAX_BYTES=536870912",
      "CACHE_UNKNOWN_OUTPUT_BYTES=33554432",
      "RUST_LOG=warn",
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  const dbEnv = resolve(root, "database.private.env");
  await writeFile(
    dbEnv,
    `POSTGRES_USER=rainsync\nPOSTGRES_DB=rainsync\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  docker([
    "network",
    "create",
    "--label",
    `codex.dolby.owner=${owner}`,
    network,
  ]);
  const common = [
    "--detach",
    "--network",
    network,
    "--label",
    `codex.dolby.owner=${owner}`,
    "--security-opt",
    "no-new-privileges",
  ];
  docker([
    "run",
    ...common,
    "--name",
    names[0],
    "--network-alias",
    "db",
    "--env-file",
    dbEnv,
    "postgres:17",
  ]);
  await until(() => {
    try {
      docker(["exec", names[0], "pg_isready", "-U", "rainsync"]);
      return true;
    } catch {
      return false;
    }
  }, "owned database");
  for (const [index, role] of [
    [1, "server"],
    [2, "worker"],
  ]) {
    docker([
      "run",
      ...common,
      "--cap-drop",
      "ALL",
      "--name",
      names[index],
      "--network-alias",
      role,
      "--env-file",
      envFile,
      "--mount",
      `type=bind,src=${media},dst=/media,readonly`,
      "--mount",
      `type=bind,src=${cache},dst=/cache`,
      image,
      `rainsync-${role === "server" ? "server" : "media-worker"}`,
    ]);
    if (role === "server") {
      const address = docker([
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        names[index],
      ]);
      // The worker claims jobs immediately. Complete the empty test database's
      // migrations before starting that independent consumer.
      await until(async () => {
        try {
          return (await fetch(`http://${address}:8080/health`)).status === 200;
        } catch {
          return false;
        }
      }, "owned server migrations");
    }
  }
  docker([
    "run",
    ...common,
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_BIND_SERVICE",
    "--name",
    names[3],
    "--network-alias",
    "web",
    "--publish",
    `127.0.0.1:${port}:80`,
    "--env",
    "SITE_ADDRESS=:80",
    webImage,
  ]);
  await until(async () => {
    try {
      return [200, 401].includes(
        (await fetch(origin + "/api/v1/auth/me")).status,
      );
    } catch {
      return false;
    }
  }, "owned application");
  const admin = new Client(fixture);
  await admin.login();
  const source = await admin.request("/sources", "POST", {
    name: "owned Dolby source",
    kind: "local",
    config: { root: "/media" },
  });
  assert.equal(
    (await admin.request(`/sources/${source.id}/test`, "POST")).count,
    1,
  );
  const item = (await admin.request("/media"))[0];
  assert.ok(item);
  const room = await admin.request("/rooms", "POST", {
    name: "owned Dolby qualification",
  });
  const control = await join(admin, room);
  const command = {
    protocol_version: 1,
    room_id: room.id,
    command_id: randomUUID(),
    control_epoch: control.snapshot.control_epoch.id,
    expected_revision: control.snapshot.state.revision,
    media_generation: control.snapshot.state.media_generation,
    type: "CHANGE_MEDIA",
    payload: { media_id: item.id },
  };
  control.socket.send(JSON.stringify(command));
  let ack = await control.next(
    (frame) => frame.command_id === command.command_id,
  );
  assert.equal(ack.type, "ACK");
  // The public fixture is only four seconds long. Keep the room at its first
  // frame while qualifying independent viewers and their conversion routes.
  for (const [type, payload] of [
    ["PAUSE", {}],
    ["SEEK", { position_ms: 0 }],
  ]) {
    const update = {
      ...command,
      command_id: randomUUID(),
      expected_revision: ack.state.revision,
      media_generation: ack.state.media_generation,
      type,
      payload,
    };
    if (type === "PAUSE") delete update.payload;
    control.socket.send(JSON.stringify(update));
    ack = await control.next((frame) => frame.command_id === update.command_id);
    assert.equal(ack.type, "ACK", JSON.stringify(ack));
  }
  const request = {
    room_id: room.id,
    media_generation: ack.state.media_generation,
    position_ms: 0,
    audio_index: null,
    mode: "auto",
    idempotency_key: randomUUID(),
    capabilities: {
      progressive_h264_aac: false,
      native_hls: false,
      mse_h264_aac: false,
    },
  };
  const set = await admin.request("/playback-candidates", "POST", {
    room_id: room.id,
    media_generation: ack.state.media_generation,
    position_ms: 0,
    audio_index: null,
    advanced_playback_capabilities_version: 1,
  });
  assert.equal(set.candidates.length, 1);
  assert.equal(set.candidates[0].id, "direct");
  assert.equal(set.candidates[0].video.dolby_vision.profile, 8);
  assert.equal(set.advanced_playback.tone_map_hdr, true);
  const result = {
    candidate_id: "direct",
    progressive: "probably",
    file_decoding: { supported: true, smooth: true, power_efficient: false },
  };
  const refused = await admin.request(
    "/playback-sessions",
    "POST",
    {
      ...request,
      candidate_report: {
        binding: set.binding,
        results: [result],
        excluded_candidates: [],
      },
    },
    422,
  );
  assert.equal(
    refused.error.code,
    "DEVICE_HAS_NO_COMPATIBLE_PLAYBACK_TRANSPORT",
  );
  const native = await admin.request("/playback-sessions", "POST", {
    ...request,
    idempotency_key: randomUUID(),
    candidate_report: {
      binding: set.binding,
      results: [{ ...result, dolby_vision_supported: true }],
      excluded_candidates: [],
    },
  });
  assert.equal(native.delivery_mode, "direct");
  const delivered = await fetch(new URL(native.playback_url, origin), {
    headers: { Cookie: admin.cookie, Range: "bytes=0-" },
  });
  assert.equal(delivered.status, 206);
  const received = Buffer.from(await delivered.arrayBuffer());
  assert.equal(received.length, original.length);
  assert.equal(hash(received), hash(original));
  report.checks.push({
    name: "native declared-capability route and full ranged byte identity",
    source_sha256: hash(original),
    bytes: original.length,
    range_status: 206,
    codec: set.candidates[0].video.dolby_vision.codec,
  });
  await admin.request(`/playback-sessions/${native.session_id}`, "DELETE");
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.RAINSYNC_CHROMIUM_EXECUTABLE,
  });
  for (let index = 0; index < 2; index++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    const client = new Client(fixture);
    await client.login();
    const [cookieName, cookieValue] = client.cookie.split("=");
    await context.addCookies([
      { name: cookieName, value: cookieValue, url: origin },
    ]);
    const page = await context.newPage();
    const posts = [];
    page.on("request", (request) => {
      if (
        request.url().includes("/playback-sessions") &&
        request.method() === "POST"
      )
        posts.push({ url: request.url(), body: request.postDataJSON() });
    });
    await page.goto(`${origin}/rooms/${room.id}`);
    await page.waitForFunction(
      () => {
        const video = document.querySelector("video");
        return (
          video?.videoWidth === 1280 &&
          video.videoHeight === 720 &&
          video.readyState >= 2 &&
          video.getVideoPlaybackQuality().totalVideoFrames > 0
        );
      },
      null,
      { timeout: 120000 },
    );
    assert.ok(
      posts.some((post) => post.body?.advanced_playback?.tone_map_hdr === true),
    );
    const facts = await page.locator("video").evaluate((video) => ({
      width: video.videoWidth,
      height: video.videoHeight,
      current_time: video.currentTime,
      decoded_frames: video.getVideoPlaybackQuality().totalVideoFrames,
      ready_state: video.readyState,
    }));
    await page.screenshot({
      path: resolve(root, `sdr-client-${index + 1}.png`),
    });
    report.checks.push({
      name: `actual independent Chromium SDR client ${index + 1}`,
      ...facts,
    });
  }
  const observer = new Client(fixture);
  await observer.login();
  const after = (await join(observer, room)).snapshot.state;
  for (const key of [
    "media_generation",
    "anchor_position_ms",
    "anchor_server_time_ms",
    "playback_status",
    "playback_rate",
    "revision",
  ])
    assert.equal(
      after[key],
      ack.state[key],
      `viewer negotiation preserves room ${key}`,
    );
  assert.equal(hash(await readFile(file)), hash(original));
  report.checks.push({ name: "room timeline and source bytes unchanged" });
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = error.message;
  if (browser) {
    for (const [index, context] of browser.contexts().entries()) {
      for (const page of context.pages()) {
        await page.screenshot({ path: resolve(root, `failure-${index}.png`) });
        await writeFile(
          resolve(root, `failure-${index}.json`),
          JSON.stringify(
            await page.evaluate(() => ({
              text: document.body.innerText,
              video: [...document.querySelectorAll("video")].map((video) => ({
                ready_state: video.readyState,
                error: video.error?.code,
                width: video.videoWidth,
                decoded_frames:
                  video.getVideoPlaybackQuality().totalVideoFrames,
              })),
            })),
            null,
            2,
          ) + "\n",
          { mode: 0o600 },
        );
      }
    }
  }
  try {
    const jobs = docker([
      "exec",
      names[0],
      "psql",
      "-U",
      "rainsync",
      "-d",
      "rainsync",
      "-Atc",
      "SELECT jsonb_build_object('status',status,'error',error,'spec',spec) FROM media_jobs",
    ]);
    await writeFile(resolve(root, "failed-jobs.private.jsonl"), jobs + "\n", {
      mode: 0o600,
    });
  } catch {}
  throw error;
} finally {
  for (const socket of sockets) socket.terminate();
  await browser?.close();
  for (const name of [...names].reverse()) {
    try {
      const label = docker([
        "inspect",
        "--format",
        '{{index .Config.Labels "codex.dolby.owner"}}',
        name,
      ]);
      if (label === owner) docker(["rm", "--force", "--volumes", name]);
    } catch {}
  }
  try {
    docker(["network", "rm", network]);
  } catch {}
  report.owned_containers_remaining = docker([
    "ps",
    "-aq",
    "--filter",
    `label=codex.dolby.owner=${owner}`,
  ]);
  assert.equal(report.owned_containers_remaining, "");
  await writeFile(
    resolve(root, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      result: report.result,
      evidence: resolve(root, "result.json"),
      checks: report.checks.length,
    }),
  );
}
