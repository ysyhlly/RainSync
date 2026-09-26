import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import http from "node:http";

// Isolated, disposable test database and processes; never targets user databases.
const root = resolve(".runtime/integration");
await mkdir(root, { recursive: true });
const password = randomBytes(24).toString("hex"),
  container = `rainsync-test-${randomUUID().slice(0, 8)}`;
const children = [];
const origin = "http://127.0.0.1:18080";
const worker = "http://127.0.0.1:18081";
const bytes = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256));
await writeFile(resolve(root, "fixture.mp4"), bytes);
const env = {
  ...process.env,
  DATABASE_URL: `postgres://rainsync:${password}@127.0.0.1:15439/rainsync?sslmode=disable`,
  ADMIN_PASSWORD: password,
  SOURCE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  PUBLIC_ORIGIN: origin,
  BIND: "127.0.0.1:18080",
  WORKER_BIND: "127.0.0.1:18081",
  MEDIA_ROOT: root,
  CACHE_ROOT: resolve(root, "cache"),
  RUST_LOG: "warn",
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function launch(name, extra = {}) {
  const child = spawn(
    resolve(
      "target/debug",
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
    assert.equal(r.status, expected, `${method} ${path}: ${text}`);
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
  const ws = new WS(origin.replace("http", "ws") + "/api/v1/ws", {
    headers: { Origin: origin, Cookie: client.cookie },
  });
  const inbox = [];
  const waiters = [];
  ws.on("message", (data) => {
    const v = JSON.parse(data);
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
  const wait = (p) => {
    const i = inbox.findIndex(p);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
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
                inbox.map((v) => v.type + ":" + (v.error ?? "")).join(","),
            ),
          );
        }, 5000),
      };
      waiters.push(w);
    });
  };
  return { ws, wait };
}
let mock;
try {
  execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      container,
      "-p",
      "127.0.0.1:15439:5432",
      "-e",
      "POSTGRES_USER=rainsync",
      "-e",
      "POSTGRES_DB=rainsync",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "postgres:17",
    ],
    { stdio: "pipe" },
  );
  for (let i = 0; i < 60; i++) {
    try {
      execFileSync(
        "docker",
        ["exec", container, "pg_isready", "-U", "rainsync"],
        { stdio: "pipe" },
      );
      break;
    } catch {
      await delay(500);
    }
  }
  await delay(2000);
  let server = launch("rainsync-server");
  await ready(origin + "/health");
  launch("rainsync-media-worker", { PUBLIC_ORIGIN: worker });
  await ready(worker + "/health");
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
  const source = await admin.request("/sources", "POST", {
    name: "Fixtures",
    kind: "local",
    config: { root },
  });
  await admin.request(`/sources/${source.id}/test`, "POST");
  const media = await admin.request("/media");
  assert.equal(media.length, 1);
  const inv = await admin.request(`/rooms/${room.id}/invites`, "POST");
  await friend.request(`/rooms/${room.id}/join`, "POST", { token: inv.token });
  const a = await connect(admin, room.id),
    b = await connect(friend, room.id);
  let state = (await a.wait((v) => v.type === "SNAPSHOT")).state;
  await b.wait((v) => v.type === "SNAPSHOT");
  const command = {
    protocol_version: 1,
    room_id: room.id,
    command_id: randomUUID(),
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
  b.ws.send(
    JSON.stringify({
      ...command,
      command_id: randomUUID(),
      expected_revision: state.revision,
      media_generation: state.media_generation,
      type: "PLAY",
      payload: undefined,
    }),
  );
  assert.equal((await b.wait((v) => v.type === "ERROR")).error, "forbidden");
  a.ws.send(
    JSON.stringify({
      ...command,
      command_id: randomUUID(),
      type: "PLAY",
      payload: undefined,
    }),
  );
  assert.equal(
    (await a.wait((v) => v.type === "ERROR")).error,
    "revision_conflict",
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
  const plan = await friend.request("/playback-sessions", "POST", {
    room_id: room.id,
    media_generation: state.media_generation,
    mode: "direct",
  });
  let r = await fetch(worker + plan.playback_url, {
    headers: { Range: "bytes=7-18" },
  });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(7, 19));
  r = await fetch(worker + plan.playback_url, {
    headers: { Range: "bytes=9999-" },
  });
  assert.equal(r.status, 416);
  r = await fetch(worker + plan.playback_url, { method: "HEAD" });
  assert.equal(r.headers.get("content-length"), "2048");
  await friend.request(`/playback-sessions/${plan.session_id}`, "DELETE");
  assert.equal((await fetch(worker + plan.playback_url)).status, 401);
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
      (m) => m.kind === "agent",
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
  await admin.request(`/agents/${pair.id}`, "DELETE");
  assert.equal((await fetch(worker + agentPlan.playback_url)).status, 503);
  const upstreamReports = [];
  mock = http
    .createServer((req, res) => {
      if (req.url.startsWith("/Users/test-user/Items")) {
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
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            MediaSources: [{ Id: "source-1", SupportsDirectPlay: true }],
            PlaySessionId: "mock-session",
          }),
        );
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
    const p = await admin.request("/playback-sessions", "POST", {
      room_id: room.id,
      media_generation: state.media_generation,
    });
    assert.ok(!JSON.stringify(p).includes("mock-token"));
    assert.deepEqual(
      Buffer.from(await (await fetch(worker + p.playback_url)).arrayBuffer()),
      bytes,
    );
    await admin.request(`/playback-sessions/${p.session_id}`, "DELETE");
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
  execFileSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-U",
      "rainsync",
      "-d",
      "rainsync",
      "-c",
      "ALTER TABLE room_events ADD CONSTRAINT test_reject CHECK (revision < 0) NOT VALID",
    ],
    { stdio: "pipe" },
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
  const rejected = await a.wait((v) => v.type === "ERROR");
  assert.equal(rejected.error, "commit_failed");
  assert.equal(rejected.state.revision, state.revision);
  execFileSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-U",
      "rainsync",
      "-d",
      "rainsync",
      "-c",
      "ALTER TABLE room_events DROP CONSTRAINT test_reject",
    ],
    { stdio: "pipe" },
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
  const oldEpoch = state.clock_epoch;
  a.ws.close();
  b.ws.close();
  server.kill();
  await new Promise((r) => server.once("exit", r));
  server = launch("rainsync-server");
  await ready(origin + "/health");
  const recovered = await connect(admin, room.id);
  const recoveredState = (await recovered.wait((v) => v.type === "SNAPSHOT"))
    .state;
  assert.equal(recoveredState.playback_status, "paused");
  assert.notEqual(recoveredState.clock_epoch, oldEpoch);
  assert.ok(recoveredState.revision > state.revision);
  recovered.ws.close();
  const started = performance.now();
  const clients = await Promise.all(
    Array.from({ length: 100 }, () => connect(admin, room.id)),
  );
  await Promise.all(clients.map((c) => c.wait((v) => v.type === "SNAPSHOT")));
  const connectionMs = performance.now() - started;
  for (const c of clients) c.ws.close();
  for (const args of [
    ["pg_dump", "-U", "rainsync", "-Fc", "-f", "/tmp/backup.dump", "rainsync"],
    ["createdb", "-U", "rainsync", "rainsync_restore"],
    [
      "pg_restore",
      "-U",
      "rainsync",
      "-d",
      "rainsync_restore",
      "/tmp/backup.dump",
    ],
  ])
    execFileSync("docker", ["exec", container, ...args], { stdio: "pipe" });
  launch("rainsync-server", {
    DATABASE_URL: env.DATABASE_URL.replace("/rainsync?", "/rainsync_restore?"),
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
  execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" });
}
