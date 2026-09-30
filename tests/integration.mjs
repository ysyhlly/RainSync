import { isolatedPostgres } from "./fixtures/postgres.mjs";
import { reviewRegressions } from "./review-regressions.mjs";
import { libraryScans } from "./library-scans.mjs";
import { queueCapacity } from "./queue-capacity.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import http from "node:http";
import { controlEpochs } from "./control-epochs.mjs";
import { audioRouting } from "./audio-routing.mjs";
import { subtitleDelivery } from "./subtitle-delivery.mjs";
import { workerAttempts } from "./worker-attempts.mjs";
import {
  playbackIdempotency,
  preparePlaybackRestart,
  verifyPlaybackRestart,
} from "./playback-idempotency.mjs";

// Isolated, disposable test database and processes; never targets user databases.
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR ?? ".runtime", "integration", randomUUID());
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
await mkdir(root, { recursive: true });
const password = randomBytes(24).toString("hex");
const database = isolatedPostgres({ root, name: "integration", password });
const children = [];
const origin = "http://127.0.0.1:18080";
const worker = "http://127.0.0.1:18081";
const bytes = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256));
await writeFile(resolve(root, "fixture.mp4"), bytes);
const env = {
  ...process.env,
  PLAYBACK_SESSION_LIMIT: "8",
  MEDIA_QUEUE_LIMIT: "20",
  ADMIN_PASSWORD: password,
  SOURCE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  PUBLIC_ORIGIN: origin,
  BIND: "127.0.0.1:18080",
  WORKER_BIND: "127.0.0.1:18081",
  // Controlled probe response below; delivery tests still use the real worker.
  WORKER_URL: "http://127.0.0.1:18082",
  MEDIA_ROOT: root,
  CACHE_ROOT: resolve(root, "cache"),
  RUST_LOG: "warn",
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = database.sql;
const sqlProcess = database.sqlProcess;
function assertError(value, code, response) {
  assert.equal(value.error.code, code);
  assert.equal(typeof value.error.message, "string");
  assert.ok(value.error.message.length > 0);
  assert.equal(typeof value.error.retryable, "boolean");
  assert.match(
    value.error.request_id,
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    value.error.retry_after_ms,
    undefined,
    "must not invent retry timing",
  );
  if (response) {
    assert.equal(response.headers.get("x-request-id"), value.error.request_id);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
}
function launch(name, extra = {}) {
  const child = spawn(
    resolve(
      target,
      name + (process.platform === "win32" ? ".exe" : ""),
    ),
    [],
    {
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  children.push(child);
  // Drain structured logs even when tests only inspect HTTP/WS results. An
  // unread stdout pipe can block error reporting after many fault injections.
  child.stdout.resume();
  child.stderr.on("data", (b) => process.stderr.write(b));
  return child;
}
async function ready(url) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error("service not ready: " + url);
}
class Client {
  cookie = "";
  csrf = "";
  async request(path, method = "GET", body, expected = 200) {
    const r = await fetch(origin + "/api/v1" + path, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: this.cookie,
        "x-csrf-token": this.csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const c = r.headers.get("set-cookie");
    if (c) this.cookie = c.split(";")[0];
    const text = await r.text();
    if (Array.isArray(expected))
      assert.ok(
        expected.includes(r.status),
        `${method} ${path}: ${r.status} ${text}`,
      );
    else assert.equal(r.status, expected, `${method} ${path}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  async login(username = "admin", pw = password) {
    const r = await this.request("/auth/login", "POST", {
      username,
      password: pw,
    });
    this.csrf = r.csrf;
  }
  async socket(room) {
    const ws = new WebSocket(origin.replace("http", "ws") + "/api/v1/ws", {
      headers: { Origin: origin, Cookie: this.cookie },
    });
    return ws;
  }
}
// Node's native WebSocket cannot set headers: ws package comes from Playwright.
const { default: WS } = await import("ws");
async function connect(client, room) {
  let controlEpoch;
  const ws = new WS(origin.replace("http", "ws") + "/api/v1/ws", {
    headers: { Origin: origin, Cookie: client.cookie },
  });
  const inbox = [];
  const waiters = [];
  ws.on("message", (data) => {
    const v = JSON.parse(data);
    if (v.control_epoch) controlEpoch = v.control_epoch.id;
    const w = waiters.find((w) => w.p(v));
    if (w) {
      waiters.splice(waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(v);
    } else inbox.push(v);
  });
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  ws.send(JSON.stringify({ type: "JOIN", room_id: room }));
  const wait = (p, timeoutMs = 5000) => {
    const i = inbox.findIndex(p);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    const requestedAt = new Error("WebSocket wait requested here");
    return new Promise((resolve, reject) => {
      const w = {
        p,
        resolve,
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(
            new Error(
              "websocket message timeout: " +
                p.toString() +
                " queued=" +
                inbox.map((v) => v.type + ":" + (v.error ?? "")).join(",") +
                " readyState=" +
                ws.readyState,
              { cause: requestedAt },
            ),
          );
        }, timeoutMs),
      };
      waiters.push(w);
    });
  };
  return {
    ws,
    wait,
    get controlEpoch() {
      return controlEpoch;
    },
  };
}
let mock;
try {
  await database.start();
  env.DATABASE_URL = database.url;
  let server = launch("rainsync-server");
  await ready(origin + "/health");
  execFileSync(
    resolve(
      target + "/examples/verify_queue_fairness" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
    [],
    {
      env: { ...env, RAINSYNC_ISOLATED_TEST: "1" },
      stdio: "inherit",
    },
  );
  execFileSync(
    resolve(
      target + "/examples/verify_media_queue" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
    [],
    {
      env: { ...env, RAINSYNC_ISOLATED_TEST: "1" },
      stdio: "inherit",
    },
  );
  execFileSync(
    resolve(
      target + "/examples/verify_output_snapshots" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
    [],
    {
      env: { ...env, RAINSYNC_ISOLATED_TEST: "1" },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  execFileSync(
    resolve(
      target + "/examples/verify_cache_budget" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
    [],
    {
      env: { ...env, RAINSYNC_ISOLATED_TEST: "1" },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  execFileSync(
    resolve(
      target + "/examples/verify_cache_leases" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
    [],
    {
      env: { ...env, RAINSYNC_ISOLATED_TEST: "1" },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  execFileSync(
    resolve(
      target + "/examples/verify_job_attempts" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
    [],
    {
      env: { ...env, RAINSYNC_ISOLATED_TEST: "1" },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  execFileSync(
    resolve(target + "/examples/verify_output_cleanup" + (process.platform === "win32" ? ".exe" : "")),
    [],
    { env: { ...env, RAINSYNC_ISOLATED_TEST: "1" }, stdio: "inherit", windowsHide: true },
  );
  launch("rainsync-media-worker", { PUBLIC_ORIGIN: worker });
  await ready(worker + "/health");
  for (const [base, path, options, status, code] of [
    [origin, "/api/v1/auth/me", {}, 401, "LOGIN_REQUIRED"],
    [origin, "/api/v1/missing", {}, 404, "NOT_FOUND"],
    [worker, "/missing", {}, 404, "NOT_FOUND"],
    [origin, "/api/v1/auth/me", { method: "PUT" }, 405, "METHOD_NOT_ALLOWED"],
    [
      origin,
      "/api/v1/rooms",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"name":secret-location',
      },
      400,
      "INVALID_REQUEST",
    ],
    [
      origin,
      "/api/v1/rooms",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x".repeat(66000) }),
      },
      413,
      "PAYLOAD_TOO_LARGE",
    ],
    [
      worker,
      "/media-delivery/not-a-uuid/file?token=private-token",
      {},
      400,
      "INVALID_REQUEST",
    ],
  ]) {
    const response = await fetch(base + path, {
      ...options,
      headers: {
        ...options.headers,
        "x-request-id": "untrusted-request-id",
      },
    });
    assert.equal(response.status, status, path);
    const value = await response.json();
    assertError(value, code, response);
    assert.ok(!JSON.stringify(value).includes("private-token"));
    assert.ok(!JSON.stringify(value).includes("secret-location"));
  }
  const admin = new Client();
  await admin.login();
  await admin.request("/users", "POST", {
    username: "friend",
    password: "friend-test-password",
  });
  const friend = new Client();
  await friend.login("friend", "friend-test-password");
  const room = await admin.request("/rooms", "POST", {
    name: "Integration room",
  });
  const deniedSocket = await connect(friend, room.id);
  assertError(
    await deniedSocket.wait((v) => v.type === "ERROR"),
    "NOT_A_MEMBER",
  );
  deniedSocket.ws.close();
  const faultSocket = await connect(admin, room.id);
  await faultSocket.wait((v) => v.type === "SNAPSHOT");
  sql("ALTER TABLE sessions RENAME COLUMN expires_at TO test_expires_at");
  try {
    const failure = await faultSocket.wait((v) => v.type === "ERROR", 20000);
    assertError(failure, "SERVICE_UNAVAILABLE");
    assert.equal(failure.error.retryable, true);
  } finally {
    sql("ALTER TABLE sessions RENAME COLUMN test_expires_at TO expires_at");
    faultSocket.ws.close();
  }
  await admin.request("/auth/me");
  const restoredSocket = await connect(admin, room.id);
  await restoredSocket.wait((v) => v.type === "SNAPSHOT");
  restoredSocket.ws.close();
  console.log(
    "PASS: heartbeat database failure is transient; valid login and reconnect survive",
  );
  const source = await admin.request("/sources", "POST", {
    name: "Fixtures",
    kind: "local",
    config: { root },
  });
  await admin.request(`/sources/${source.id}/test`, "POST");
  const media = await admin.request("/media");
  assert.equal(media.length, 1);
  await libraryScans({ admin, sql });
  const inv = await admin.request(`/rooms/${room.id}/invites`, "POST");
  await friend.request(`/rooms/${room.id}/join`, "POST", { token: inv.token });
  const lock = sqlProcess(undefined, { interactive: true });
  children.push(lock);
  const locked = new Promise((resolve, reject) => {
    lock.stdout.on("data", (data) => {
      if (data.toString().includes("snapshot-locked")) resolve();
    });
    lock.once("error", reject);
    lock.once("exit", (code) => {
      if (code) reject(new Error("snapshot lock helper failed"));
    });
  });
  lock.stdin.write(
    `BEGIN; SELECT state FROM room_snapshots WHERE room_id='${room.id}' FOR UPDATE; SELECT 'snapshot-locked';\n`,
  );
  await locked;
  const rejectedInvite = friend.request(
    `/rooms/${room.id}/invites`,
    "POST",
    undefined,
    403,
  );
  try {
    let waiting = "0";
    for (let i = 0; i < 30 && waiting === "0"; i++) {
      waiting = sql(
        "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT state FROM room_snapshots%FOR UPDATE%'",
      );
      if (waiting === "0") await delay(25);
    }
    assert.notEqual(
      waiting,
      "0",
      "controller authorization must wait for the snapshot lock",
    );
  } finally {
    const released = new Promise((resolve) => lock.once("exit", resolve));
    lock.stdin.end("COMMIT;\n");
    await released;
  }
  assertError(await rejectedInvite, "CONTROLLER_REQUIRED");
  const playlistEntries = await Promise.all(
    Array.from({ length: 5 }, () =>
      admin.request(`/rooms/${room.id}/playlist`, "POST", {
        media_id: media[0].id,
      }),
    ),
  );
  assert.equal(
    sql(
      `SELECT count(DISTINCT sort_order) FROM playlist_items WHERE room_id='${room.id}'`,
    ),
    "1",
  );
  assert.equal(new Set(playlistEntries.map(item => item.id)).size, 1, "concurrent additions return the same playlist entry");
  for (const item of playlistEntries)
    await admin.request(`/rooms/${room.id}/playlist/${item.id}`, "DELETE");
  const a = await connect(admin, room.id),
    b = await connect(friend, room.id);
  let state = (await a.wait((v) => v.type === "SNAPSHOT")).state;
  await b.wait((v) => v.type === "SNAPSHOT");
  a.ws.send("not JSON: private-token");
  assertError(await a.wait((v) => v.type === "ERROR"), "INVALID_REQUEST");
  const malformedId = randomUUID();
  a.ws.send(JSON.stringify({ type: "SEEK", command_id: malformedId }));
  const malformed = await a.wait((v) => v.type === "ERROR");
  assertError(malformed, "INVALID_REQUEST");
  assert.equal(malformed.command_id, malformedId);
  const command = {
    protocol_version: 1,
    room_id: room.id,
    command_id: randomUUID(),
    control_epoch: a.controlEpoch,
    expected_revision: state.revision,
    media_generation: state.media_generation,
    type: "CHANGE_MEDIA",
    payload: { media_id: media[0].id },
  };
  a.ws.send(JSON.stringify(command));
  state = (await a.wait((v) => v.type === "ACK")).state;
  assert.equal(
    (await b.wait((v) => v.type === "EVENT")).state.revision,
    state.revision,
  );
  a.ws.send(JSON.stringify(command));
  assert.equal(
    (await a.wait((v) => v.type === "ACK")).state.revision,
    state.revision,
    "duplicate must not increment",
  );
  for (const changed of [
    { type: "PLAY", payload: undefined },
    { payload: { media_id: randomUUID() } },
    { expected_revision: state.revision },
    { media_generation: state.media_generation },
    { protocol_version: 2 },
  ]) {
    a.ws.send(JSON.stringify({ ...command, ...changed }));
    const rejected = await a.wait((v) => v.type === "ERROR");
    assertError(rejected, "COMMAND_PAYLOAD_CONFLICT");
    assert.equal(rejected.state.revision, state.revision);
  }
  a.ws.send(JSON.stringify({ ...command, room_id: randomUUID() }));
  assert.equal(
    (await a.wait((v) => v.type === "ERROR")).error.code,
    "ROOM_MISMATCH",
  );
  b.ws.send(JSON.stringify({ ...command, control_epoch: b.controlEpoch }));
  assert.equal(
    (await b.wait((v) => v.type === "ERROR")).error.code,
    "COMMAND_OWNED_BY_ANOTHER_USER",
  );
  b.ws.send(
    JSON.stringify({
      ...command,
      control_epoch: b.controlEpoch,
      command_id: randomUUID(),
      expected_revision: state.revision,
      media_generation: state.media_generation,
      type: "PLAY",
      payload: undefined,
    }),
  );
  assertError(await b.wait((v) => v.type === "ERROR"), "CONTROLLER_REQUIRED");
  b.ws.send(JSON.stringify({ type: "CLOCK_SYNC", t1: 12345 }));
  assert.equal((await b.wait((v) => v.type === "CLOCK_SYNC_REPLY")).t1, 12345);
  a.ws.send(
    JSON.stringify({
      ...command,
      command_id: randomUUID(),
      type: "PLAY",
      payload: undefined,
    }),
  );
  assert.equal(
    (await a.wait((v) => v.type === "ERROR")).error.code,
    "REVISION_CONFLICT",
  );
  a.ws.send(
    JSON.stringify({
      ...command,
      command_id: randomUUID(),
      expected_revision: state.revision,
      media_generation: state.media_generation,
      type: "PLAY",
      payload: undefined,
    }),
  );
  state = (await a.wait((v) => v.type === "ACK")).state;
  assert.equal(state.playback_status, "playing");
  a.ws.send(JSON.stringify({ type: "CHAT", body: "Together!" }));
  assert.equal((await b.wait((v) => v.type === "CHAT")).body, "Together!");
  await playbackIdempotency({ admin, friend, room, state, sql });
  await queueCapacity({ admin, room, state, sql });
  await audioRouting({ admin, room, state, sql });
  const originalMetadata = sql(
    `SELECT metadata FROM media_items WHERE id='${state.media_id}'`,
  );
  const rotatedMetadata = {
    format: { format_name: "mov,mp4" },
    streams: [
      {
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        pix_fmt: "yuv420p",
        side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }],
      },
    ],
  };
  sql(
    `UPDATE media_items SET metadata='${JSON.stringify(rotatedMetadata)}'::jsonb WHERE id='${state.media_id}'`,
  );
  try {
    for (const [mode, capabilities, expected] of [
      ["auto", null, "direct"],
      ["remux", null, "transcode"],
      [
        "auto",
        { progressive_h264_aac: false, native_hls: true, mse_h264_aac: false },
        "transcode",
      ],
    ]) {
      const rotationPlan = await admin.request("/playback-sessions", "POST", {
        room_id: room.id,
        media_generation: state.media_generation,
        mode,
        capabilities,
      });
      assert.equal(rotationPlan.delivery_mode, expected);
      if (expected === "transcode")
        assert.equal(
          sql(
            `SELECT spec->>'transcode' FROM media_jobs WHERE session_id='${rotationPlan.session_id}'`,
          ),
          "true",
        );
      await admin.request(
        `/playback-sessions/${rotationPlan.session_id}`,
        "DELETE",
      );
    }
  } finally {
    sql(
      `UPDATE media_items SET metadata='${originalMetadata.replaceAll("'", "''")}'::jsonb WHERE id='${state.media_id}'`,
    );
  }
  console.log(
    "PASS: rotated direct source stays direct; requested or negotiated local HLS transcodes orientation",
  );
  const plan = await friend.request("/playback-sessions", "POST", {
    room_id: room.id,
    media_generation: state.media_generation,
    mode: "direct",
  });
  assert.deepEqual(
    await friend.request(`/playback-sessions/${plan.session_id}`),
    {
      session_id: plan.session_id,
      status: "ready",
      complete: true,
      available_until_ms: null,
    },
  );
  assert.equal(
    (
      await admin.request(
        `/playback-sessions/${plan.session_id}`,
        "GET",
        undefined,
        410,
      )
    ).error.code,
    "INVALID_PLAYBACK_SESSION",
  );
  let r = await fetch(worker + plan.playback_url, {
    headers: { Range: "bytes=7-18" },
  });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(7, 19));
  r = await fetch(worker + plan.playback_url, {
    headers: { Range: "bytes=-0" },
  });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get("content-range"), "bytes */2048");
  r = await fetch(worker + plan.playback_url, {
    headers: { Range: "bytes=9999-" },
  });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get("content-range"), "bytes */2048");
  assertError(await r.json(), "RANGE_NOT_SATISFIABLE", r);
  r = await fetch(worker + plan.playback_url, {
    method: "HEAD",
    headers: { Range: "bytes=9999-" },
  });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get("content-range"), "bytes */2048");
  assert.equal(await r.text(), "");
  r = await fetch(worker + plan.playback_url, { method: "HEAD" });
  assert.equal(r.headers.get("content-length"), "2048");
  await workerAttempts({
    readiness: (status = 200, position) =>
      friend.request(
        `/playback-sessions/${plan.session_id}${position === undefined ? "" : `?relative_position_ms=${position}`}`,
        "GET",
        undefined,
        status,
      ),
    plan,
    worker,
    sql,
    key: env.SOURCE_ENCRYPTION_KEY,
    cache: env.CACHE_ROOT,
  });
  await friend.request(`/playback-sessions/${plan.session_id}`, "DELETE");
  assert.equal(
    (
      await friend.request(
        `/playback-sessions/${plan.session_id}`,
        "GET",
        undefined,
        410,
      )
    ).error.code,
    "INVALID_PLAYBACK_SESSION",
  );
  const revoked = await fetch(worker + plan.playback_url);
  assert.equal(revoked.status, 401);
  assertError(await revoked.json(), "INVALID_PLAYBACK_SESSION", revoked);
  const csrf = await fetch(origin + "/api/v1/rooms", {
    method: "POST",
    headers: {
      Cookie: admin.cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "bad" }),
  });
  assert.equal(csrf.status, 403);
  assertError(await csrf.json(), "CSRF_REJECTED", csrf);
  const pair = await admin.request("/agents", "POST", { name: "Test NAS" });
  launch("rainsync-nas-agent", {
    SERVER_URL: origin,
    AGENT_DATA_ORIGIN: worker,
    PAIR_CODE: pair.pair_code,
    AGENT_CREDENTIAL_FILE: resolve(root, "agent-" + randomUUID() + ".json"),
  });
  let agentMedia;
  for (let i = 0; i < 40; i++) {
    agentMedia = (await admin.request("/media")).find(
      (m) => m.kind === "agent" && m.title === "fixture",
    );
    if (agentMedia) break;
    await delay(250);
  }
  assert.ok(agentMedia, "agent indexes NAS");
  a.ws.send(
    JSON.stringify({
      ...command,
      command_id: randomUUID(),
      expected_revision: state.revision,
      media_generation: state.media_generation,
      type: "CHANGE_MEDIA",
      payload: { media_id: agentMedia.id },
    }),
  );
  state = (await a.wait((v) => v.type === "ACK")).state;
  const agentPlan = await friend.request("/playback-sessions", "POST", {
    mode: "direct", // Transport fixture contains arbitrary bytes, not encoded media.
    room_id: room.id,
    media_generation: state.media_generation,
  });
  r = await fetch(worker + agentPlan.playback_url, {
    headers: { Range: "bytes=-16" },
  });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(-16));
  r = await fetch(worker + agentPlan.playback_url, {
    headers: { Range: "bytes=-0" },
  });
  assert.equal(r.status, 416);
  await admin.request(`/agents/${pair.id}`, "DELETE");
  assert.equal((await fetch(worker + agentPlan.playback_url)).status, 503);
  const upstreamReports = [];
  const subtitleFixture =
    "\ufeffWEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\n已结束\r\n\r\n00:01.000 --> 00:05.000\r\n中文跨越起点\r\n";
  let subtitleBody = subtitleFixture;
  let negotiations = 0;
  let failNegotiations = 0;
  let probeResponse;
  let probeMetadata;
  let probeCalls = 0;
  mock = http
    .createServer((req, res) => {
      if (
        req.url.startsWith("/media-delivery/") &&
        req.url.includes("/probe?")
      ) {
        probeCalls++;
        if (probeMetadata) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(probeMetadata));
        } else probeResponse = res;
      } else if (req.url.startsWith("/Users/test-user/Items")) {
        const kind = req.headers["x-emby-token"] ? "emby" : "jellyfin";
        assert.ok(
          req.headers["x-emby-token"] === "mock-token" ||
            req.headers.authorization?.includes("mock-token"),
        );
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            Items: [
              {
                Id: kind + "-item",
                Name: kind + " fixture",
                RunTimeTicks: 200000000,
              },
            ],
            TotalRecordCount: 1,
          }),
        );
      } else if (req.url.includes("/PlaybackInfo")) {
        negotiations++;
        if (failNegotiations > 0) {
          failNegotiations--;
          setTimeout(() => res.writeHead(502).end(), 1000);
          return;
        }
        res.setHeader("Content-Type", "application/json");
        setTimeout(
          () =>
            res.end(
              JSON.stringify({
                MediaSources: [
                  {
                    Id: "source-1",
                    SupportsDirectPlay: true,
                    MediaStreams: [
                      {
                        Type: "Subtitle",
                        Index: 7,
                        IsTextSubtitleStream: true,
                        DisplayTitle: "中文",
                        Language: "zho",
                      },
                    ],
                  },
                ],
                PlaySessionId: "mock-session",
              }),
            ),
          1000,
        );
      } else if (req.url.includes("/Subtitles/7/Stream.vtt")) {
        assert.ok(
          req.headers["x-emby-token"] === "mock-token" ||
            req.headers.authorization?.includes("mock-token"),
        );
        res.setHeader("Content-Type", "text/vtt");
        res.end(subtitleBody);
      } else if (req.url.startsWith("/Sessions/Playing")) {
        upstreamReports.push(req.url);
        res.setHeader("Content-Type", "application/json");
        res.end("{}");
      } else if (req.url === "/index.m3u8") {
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.end(
          "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n",
        );
      } else {
        res.end(bytes);
      }
    })
    .listen(18082, "127.0.0.1");
  const httpSource = await admin.request("/sources", "POST", {
    name: "HTTP",
    kind: "http",
    config: { url: "http://127.0.0.1:18082/index.m3u8" },
  });
  await admin.request(`/sources/${httpSource.id}/test`, "POST");
  const httpMedia = (await admin.request("/media")).find(
    (m) => m.kind === "http",
  );
  a.ws.send(
    JSON.stringify({
      ...command,
      command_id: randomUUID(),
      expected_revision: state.revision,
      media_generation: state.media_generation,
      type: "CHANGE_MEDIA",
      payload: { media_id: httpMedia.id },
    }),
  );
  state = (await a.wait((v) => v.type === "ACK")).state;
  const hlsPlan = await admin.request("/playback-sessions", "POST", {
    mode: "direct", // Manifest rewrite contract; real decoding is tested separately.
    room_id: room.id,
    media_generation: state.media_generation,
  });
  const manifest = await (await fetch(worker + hlsPlan.playback_url)).text();
  const segment = manifest
    .split("\n")
    .find((l) => l.startsWith("/media-delivery"));
  assert.ok(segment);
  assert.deepEqual(
    Buffer.from(await (await fetch(worker + segment)).arrayBuffer()),
    bytes,
  );
  const forged = new URL(worker + segment);
  forged.searchParams.set(
    "url",
    Buffer.from("http://127.0.0.1:18082/private").toString("base64url"),
  );
  assert.equal((await fetch(forged)).status, 403);
  const probeRequest = {
    idempotency_key: randomUUID(),
    room_id: room.id,
    media_generation: state.media_generation,
    mode: "auto",
  };
  const abortProbe = new AbortController();
  const probeFetch = fetch(origin + "/api/v1/playback-sessions", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: admin.cookie,
      "x-csrf-token": admin.csrf,
    },
    body: JSON.stringify(probeRequest),
    signal: abortProbe.signal,
  });
  const probeRejected = assert.rejects(probeFetch, { name: "AbortError" });
  for (let i = 0; i < 100 && !probeResponse; i++) await delay(10);
  assert.ok(probeResponse, "probe grant must be committed before disconnect");
  const probeSession = sql(
    `SELECT session_id FROM playback_requests WHERE idempotency_key='${probeRequest.idempotency_key}'`,
  );
  assert.equal(
    sql(`SELECT stopped FROM playback_sessions WHERE id='${probeSession}'`),
    "f",
  );
  abortProbe.abort();
  await probeRejected;
  probeResponse.writeHead(502).end();
  let probeStatus;
  for (let i = 0; i < 30; i++) {
    probeStatus = sql(
      `SELECT status FROM playback_requests WHERE session_id='${probeSession}'`,
    );
    if (probeStatus === "failed") break;
    await delay(100);
  }
  assert.equal(probeStatus, "failed");
  assert.equal(
    sql(`SELECT stopped FROM playback_sessions WHERE id='${probeSession}'`),
    "t",
  );
  console.log(
    "PASS: disconnected probe records failure and releases committed grant before lease expiry",
  );
  // Controlled probe metadata exercises the real API decision and grant cleanup.
  for (const [format, codec, expected] of [
    ["mov,mp4", "h264", "direct"],
    ["matroska,webm", "h264", "remux"],
    ["matroska,webm", "mpeg4", "transcode"],
  ]) {
    probeMetadata = {
      format: { format_name: format, duration: "20" },
      streams: [
        { codec_type: "video", codec_name: codec, pix_fmt: "yuv420p" },
        { codec_type: "audio", codec_name: "aac" },
      ],
    };
    const before = probeCalls;
    const automatic = await admin.request("/playback-sessions", "POST", {
      room_id: room.id,
      media_generation: state.media_generation,
      mode: "auto",
    });
    assert.equal(probeCalls, before + 1);
    assert.equal(automatic.delivery_mode, expected);
    await admin.request(`/playback-sessions/${automatic.session_id}`, "DELETE");
  }
  probeMetadata = undefined;
  console.log("PASS: remote auto probes and selects direct/remux/transcode");
  for (const kind of ["jellyfin", "emby"]) {
    const source = await admin.request("/sources", "POST", {
      name: kind,
      kind,
      config: {
        url: "http://127.0.0.1:18082",
        token: "mock-token",
        user_id: "test-user",
      },
    });
    await admin.request(`/sources/${source.id}/test`, "POST");
    const item = (await admin.request("/media")).find((m) => m.kind === kind);
    assert.ok(item);
    a.ws.send(
      JSON.stringify({
        ...command,
        command_id: randomUUID(),
        expected_revision: state.revision,
        media_generation: state.media_generation,
        type: "CHANGE_MEDIA",
        payload: { media_id: item.id },
      }),
    );
    state = (await a.wait((v) => v.type === "ACK")).state;
    const playbackRequest = {
      idempotency_key: randomUUID(),
      room_id: room.id,
      media_generation: state.media_generation,
    };
    const before = negotiations;
    const inFlight = admin.request(
      "/playback-sessions",
      "POST",
      playbackRequest,
    );
    for (let i = 0; i < 100 && negotiations === before; i++) await delay(10);
    const during = await admin.request(
      "/playback-sessions",
      "POST",
      playbackRequest,
      409,
    );
    assert.equal(during.error.code, "PLAYBACK_REQUEST_IN_PROGRESS");
    assert.equal(during.error.retryable, true);
    const p = await inFlight;
    const replay = await admin.request(
      "/playback-sessions",
      "POST",
      playbackRequest,
    );
    assert.equal(replay.session_id, p.session_id);
    assert.equal(
      negotiations,
      before + 1,
      "duplicate request must not negotiate a second upstream session",
    );
    assert.ok(!JSON.stringify(p).includes("mock-token"));
    await subtitleDelivery({
      plan: p,
      worker,
      sql,
      key: env.SOURCE_ENCRYPTION_KEY,
      setBody: (body = subtitleFixture) => {
        subtitleBody = body;
      },
    });
    assert.deepEqual(
      Buffer.from(await (await fetch(worker + p.playback_url)).arrayBuffer()),
      bytes,
    );
    await admin.request(`/playback-sessions/${p.session_id}`, "DELETE");
    // Observe settlement after disconnect, without another POST or lease expiry.
    for (const failure of [false, true]) {
      const disconnected = {
        ...playbackRequest,
        idempotency_key: randomUUID(),
      };
      const count = negotiations;
      failNegotiations = failure ? 1 : 0;
      const abort = new AbortController();
      const response = fetch(origin + "/api/v1/playback-sessions", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Cookie: admin.cookie,
          "x-csrf-token": admin.csrf,
        },
        body: JSON.stringify(disconnected),
        signal: abort.signal,
      });
      const rejected = assert.rejects(response, { name: "AbortError" });
      for (let i = 0; i < 100 && negotiations === count; i++) await delay(10);
      assert.equal(negotiations, count + 1);
      abort.abort();
      await rejected;
      const where = `idempotency_key='${disconnected.idempotency_key}'`;
      const session = sql(
        `SELECT session_id FROM playback_requests WHERE ${where}`,
      );
      const expected = failure ? "failed" : "completed";
      let settled;
      for (let i = 0; i < 30; i++) {
        settled = sql(`SELECT status FROM playback_requests WHERE ${where}`);
        if (settled === expected) break;
        await delay(100);
      }
      assert.equal(
        settled,
        expected,
        "disconnected owner must settle before lease expiry",
      );
      if (failure)
        assert.equal(
          sql(
            `SELECT count(*) FROM playback_sessions WHERE id='${session}' AND NOT stopped`,
          ),
          "0",
        );
      const resumed = await admin.request(
        "/playback-sessions",
        "POST",
        disconnected,
      );
      assert.equal(
        sql(`SELECT attempt FROM playback_requests WHERE ${where}`),
        failure ? "2" : "1",
      );
      assert.equal(negotiations, count + (failure ? 2 : 1));
      if (!failure) assert.equal(resumed.session_id, session);
      await admin.request(`/playback-sessions/${resumed.session_id}`, "DELETE");
    }
    const retry = { ...playbackRequest, idempotency_key: randomUUID() };
    failNegotiations = 1;
    const transient = await admin.request(
      "/playback-sessions",
      "POST",
      retry,
      502,
    );
    assert.equal(transient.error.code, "UPSTREAM_PLAYBACK_FAILED");
    assert.equal(transient.error.retryable, true);
    const fixed = await admin.request("/playback-sessions", "POST", retry);
    assert.equal(
      sql(
        `SELECT attempt FROM playback_requests WHERE session_id='${fixed.session_id}'`,
      ),
      "2",
    );
    await admin.request(`/playback-sessions/${fixed.session_id}`, "DELETE");
    const exhausted = { ...playbackRequest, idempotency_key: randomUUID() };
    failNegotiations = 3;
    for (let attempt = 0; attempt < 2; attempt++)
      await admin.request("/playback-sessions", "POST", exhausted, 502);
    const terminal = await admin.request(
      "/playback-sessions",
      "POST",
      exhausted,
      409,
    );
    assert.equal(terminal.error.code, "PLAYBACK_REQUEST_RETRY_EXHAUSTED");
    assert.equal(terminal.error.retryable, false);
    assert.equal(
      (await admin.request("/playback-sessions", "POST", exhausted, 409)).error
        .code,
      "PLAYBACK_REQUEST_RETRY_EXHAUSTED",
    );
    assert.equal(
      sql(
        `SELECT status FROM playback_requests WHERE idempotency_key='${exhausted.idempotency_key}'`,
      ),
      "failed",
    );
    for (const expire of [
      "lease_until=now()-interval '1 second'",
      `owner_epoch='${randomUUID()}'`,
    ]) {
      const race = { ...playbackRequest, idempotency_key: randomUUID() };
      const count = negotiations;
      const obsolete = admin.request("/playback-sessions", "POST", race, 409);
      for (let i = 0; i < 100 && negotiations === count; i++) await delay(10);
      assert.equal(negotiations, count + 1);
      const old = sql(
        `SELECT session_id FROM playback_requests WHERE idempotency_key='${race.idempotency_key}'`,
      );
      sql(
        `UPDATE playback_requests SET ${expire} WHERE idempotency_key='${race.idempotency_key}'`,
      );
      const successor = admin.request("/playback-sessions", "POST", race);
      assert.equal((await obsolete).error.code, "PLAYBACK_REQUEST_INTERRUPTED");
      const recovered = await successor;
      assert.notEqual(recovered.session_id, old);
      assert.equal(
        sql(
          `SELECT status FROM playback_requests WHERE session_id='${recovered.session_id}'`,
        ),
        "completed",
      );
      assert.equal(
        sql(
          `SELECT count(*) FROM playback_sessions WHERE id='${old}' AND NOT stopped`,
        ),
        "0",
      );
      await admin.request(
        `/playback-sessions/${recovered.session_id}`,
        "DELETE",
      );
    }
    const abandoned = { ...playbackRequest, idempotency_key: randomUUID() };
    const beforeCancel = negotiations;
    const late = admin.request("/playback-sessions", "POST", abandoned, 409);
    for (let i = 0; i < 100 && negotiations === beforeCancel; i++)
      await delay(10);
    assert.equal(negotiations, beforeCancel + 1);
    const cancelledSession = sql(
      `SELECT session_id FROM playback_requests WHERE idempotency_key='${abandoned.idempotency_key}'`,
    );
    await admin.request(
      `/playback-requests/${abandoned.idempotency_key}`,
      "DELETE",
    );
    assert.equal((await late).error.code, "PLAYBACK_REQUEST_INTERRUPTED");
    assert.equal(
      sql(
        `SELECT count(*) FROM playback_sessions WHERE id='${cancelledSession}' AND NOT stopped`,
      ),
      "0",
    );
    assert.equal(
      (await admin.request("/playback-sessions", "POST", abandoned, 410)).error
        .code,
      "PLAYBACK_REQUEST_CANCELLED",
    );
  }
  for (
    let i = 0;
    i < 60 && !upstreamReports.includes("/Sessions/Playing/Stopped");
    i++
  )
    await delay(250);
  assert.ok(upstreamReports.includes("/Sessions/Playing"));
  assert.ok(upstreamReports.includes("/Sessions/Playing/Stopped"));
  console.log(
    "PASS: Jellyfin/Emby mock contract, credential isolation, start/stop report (not real server compatibility)",
  );
  // Force a real database transaction failure and prove the state cannot advance.
  sql("ALTER TABLE room_events ADD CONSTRAINT test_reject CHECK (revision < 0) NOT VALID");
  a.ws.send(
    JSON.stringify({
      ...command,
      command_id: randomUUID(),
      expected_revision: state.revision,
      media_generation: state.media_generation,
      type: "PLAY",
      payload: undefined,
    }),
  );
  const rejected = await a.wait((v) => v.type === "ERROR");
  assertError(rejected, "COMMIT_FAILED");
  assert.equal(rejected.state.revision, state.revision);
  sql("ALTER TABLE room_events DROP CONSTRAINT test_reject");
  a.ws.send(
    JSON.stringify({
      ...command,
      command_id: randomUUID(),
      expected_revision: state.revision,
      media_generation: state.media_generation,
      type: "PLAY",
      payload: undefined,
    }),
  );
  state = (await a.wait((v) => v.type === "ACK")).state;
  const oldEpoch = state.clock_epoch;
  const playbackRestart = await preparePlaybackRestart({
    admin,
    room,
    state,
    sql,
  });
  a.ws.close();
  b.ws.close();
  const loginBody = { username: "restart-limit-fixture", password: "wrong" };
  const loginResults = await Promise.all(
    Array.from({ length: 12 }, () =>
      admin.request("/auth/login", "POST", loginBody, [401, 429]),
    ),
  );
  assert.equal(
    loginResults.filter((v) => v.error.code === "INVALID_CREDENTIALS").length,
    10,
  );
  assert.equal(
    loginResults.filter((v) => v.error.code === "RATE_LIMITED").length,
    2,
  );
  server.kill();
  await new Promise((r) => server.once("exit", r));
  server = launch("rainsync-server");
  await ready(origin + "/health");
  assertError(
    await admin.request("/auth/login", "POST", loginBody, 429),
    "RATE_LIMITED",
  );
  const loginHash = createHash("sha256")
    .update(loginBody.username)
    .digest("hex");
  sql(
    `UPDATE login_attempts SET window_started=now()-interval '61 seconds' WHERE username_hash='${loginHash}'`,
  );
  assertError(
    await admin.request("/auth/login", "POST", loginBody, 401),
    "INVALID_CREDENTIALS",
  );
  console.log(
    "PASS: persistent atomic login rate limit survives restart and resets after expiry",
  );
  const recovered = await connect(admin, room.id);
  const recoveredState = (await recovered.wait((v) => v.type === "SNAPSHOT"))
    .state;
  assert.equal(recoveredState.playback_status, "paused");
  assert.notEqual(recoveredState.clock_epoch, oldEpoch);
  assert.ok(recoveredState.revision > state.revision);
  await verifyPlaybackRestart({ admin, sql }, playbackRestart);
  recovered.ws.send(JSON.stringify(command));
  assert.deepEqual(
    (await recovered.wait((v) => v.type === "ACK")).state,
    recoveredState,
    "valid retry after restart returns current epoch without executing again",
  );
  sql(`UPDATE command_results SET request_payload=NULL WHERE command_id='${command.command_id}'`);
  recovered.ws.send(JSON.stringify(command));
  const legacyReplay = await recovered.wait((v) => v.type === "ERROR");
  assertError(legacyReplay, "COMMAND_REPLAY_UNVERIFIABLE");
  assert.deepEqual(legacyReplay.state, recoveredState);
  await controlEpochs({
    socket: recovered,
    command,
    state: recoveredState,
    room,
    admin,
    friend,
    sql,
    sqlProcess,
    env,
  });
  recovered.ws.close();
  for (let round = 0; round < 3; round++) {
    const limited = await connect(admin, room.id);
    await limited.wait((v) => v.type === "SNAPSHOT");
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("rate-limited socket did not close")),
        5000,
      );
      limited.ws.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    // A 35-frame burst can straddle the fixed one-second window under load.
    // Exceed two windows and leave unread frames after the rejection.
    for (let i = 0; i < 65; i++)
      limited.ws.send(JSON.stringify({ type: "CLOCK_SYNC", t1: i }));
    const [quotaError, closeCode] = await Promise.all([
      limited.wait((v) => v.type === "ERROR"),
      closed,
    ]);
    assertError(quotaError, "RATE_LIMITED");
    assert.equal(quotaError.error.retryable, true);
    assert.notEqual(
      closeCode,
      1006,
      "terminal error must precede a clean WebSocket close",
    );
  }
  console.log(
    "PASS: fixed-window WebSocket rate limit delivers ERROR and closes gracefully under unread bursts",
  );
  await reviewRegressions({ admin, friend, sql, sqlProcess, connect, origin });
  const started = performance.now();
  const clients = await Promise.all(
    Array.from({ length: 100 }, () => connect(admin, room.id)),
  );
  await Promise.all(clients.map((c) => c.wait((v) => v.type === "SNAPSHOT")));
  const connectionMs = performance.now() - started;
  for (const c of clients) c.ws.close();
  const restoredDatabaseUrl = database.backupRestore();
  launch("rainsync-server", {
    DATABASE_URL: restoredDatabaseUrl,
    BIND: "127.0.0.1:18084",
  });
  await ready("http://127.0.0.1:18084/health");
  const restored = await fetch(
    "http://127.0.0.1:18084/api/v1/sources/" + source.id + "/test",
    {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: admin.cookie,
        "x-csrf-token": admin.csrf,
      },
    },
  );
  assert.equal(
    restored.status,
    200,
    "restored database and original key can access encrypted source",
  );
  console.log(
    "PASS: pg_dump/pg_restore into a separate database; restored sessions and encrypted source usable",
  );
  console.log(
    `PASS: 100 control connections received snapshots in ${Math.round(connectionMs)}ms (local smoke, not sustained load)`,
  );
  console.log(
    "PASS: authentication, CSRF, invitations, two-client broadcast, idempotency, conflict, permissions, chat, Range/HEAD/416, session revocation, NAS pairing/index/relay/revoke, HLS rewrite, forged-resource rejection, transaction rollback and restart recovery",
  );
} finally {
  mock?.close();
  for (const child of children) child.kill();
  await delay(400);
  await database.stop();
}
