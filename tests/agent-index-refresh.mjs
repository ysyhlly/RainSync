// Real Linux non-root Agent + Server/PostgreSQL. The WS proxy only observes
// traffic, delays one ACK or breaks the control connection; it never indexes.
// Run with an image freshly built from deploy/Dockerfile:
// WORKER_TEST_IMAGE=<tag> node tests/agent-index-refresh.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

const tag = process.env.WORKER_TEST_IMAGE ?? "rainsync-worker-validation:local";
const name = `rainsync-index-refresh-${randomUUID().slice(0, 8)}`;
const db = `${name}-db`,
  server = `${name}-server`,
  agent = `${name}-agent`;
const volume = `${name}-media`;
const root = resolve(".runtime/agent-index-refresh", name);
const password = randomBytes(20).toString("hex");
const token = randomBytes(32).toString("hex"),
  agentId = randomUUID();
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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
const mutate = (script) =>
  docker("exec", "--user", "0", agent, "sh", "-c", script);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(100);
  }
  throw Error(`deadline: ${label}`);
}
const report = {
  started_at: new Date().toISOString(),
  image: docker("image", "inspect", "--format", "{{.Id}}", tag),
  cases: [],
  limitations: [
    "Real Server ingestion and PostgreSQL; data consumers and transfer grants are controlled fixtures, not Worker/browser playback",
    "Periodic 5-second refresh accelerated for validation; default is 60 seconds",
    "Local Linux volume only; does not force a filesystem syscall into uninterruptible kernel I/O",
    "Short lifecycle verification, not a two-hour viewing or total memory bound test",
  ],
};
const raw = new Set(),
  upstreams = new Set(),
  data = new Map();
const snapshots = new Map();
let serverBase, origin, control, controlUpstream;
let connections = 0,
  heartbeats = 0,
  finalAcks = 0,
  abortAcks = 0;
let holdNext = false,
  held,
  gateSnapshot;
const http = createServer((req, res) => res.writeHead(404).end());
const ws = new WebSocketServer({ noServer: true });
http.on("connection", (socket) => {
  raw.add(socket);
  socket.on("close", () => raw.delete(socket));
});
http.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url, "http://fixture").pathname;
  ws.handleUpgrade(request, socket, head, (peer) => {
    peer.on("error", () => {});
    if (path === "/api/v1/agents/ws") {
      connections++;
      control = peer;
      const upstream = new WebSocket(
        serverBase.replace("http:", "ws:") + path,
        { headers: { Authorization: request.headers.authorization } },
      );
      controlUpstream = upstream;
      upstreams.add(upstream);
      const pending = [];
      let activeSnapshot;
      upstream.on("open", () => {
        for (const message of pending)
          upstream.send(message, { binary: false });
      });
      upstream.on("error", () => {});
      upstream.on("close", () => {
        upstreams.delete(upstream);
        peer.terminate();
      });
      peer.on("close", () => upstream.terminate());
      peer.on("message", (message) => {
        const value = JSON.parse(message.toString());
        if (value.type === "HEARTBEAT") heartbeats++;
        if (value.type === "INDEX") {
          assert.ok(value.items.length <= 128, "bounded item pages");
          assert.ok(message.length < 129 * 1024, "bounded encoded page");
          if (holdNext && value.sequence === 0 && !value.final) {
            holdNext = false;
            gateSnapshot = value.snapshot;
          }
          if (value.sequence === 0) {
            assert.equal(
              activeSnapshot,
              undefined,
              "no overlapping snapshots on one control connection",
            );
            activeSnapshot = value.snapshot;
          }
          assert.equal(
            activeSnapshot,
            value.snapshot,
            "only the admitted snapshot can send pages",
          );
          const state = snapshots.get(value.snapshot) ?? {
            pages: 0,
            final: false,
          };
          assert.equal(value.sequence, state.pages, "ordered pages");
          state.pages++;
          state.final = value.final;
          snapshots.set(value.snapshot, state);
        }
        if (upstream.readyState === WebSocket.OPEN)
          upstream.send(message, { binary: false });
        else pending.push(message);
      });
      upstream.on("message", (message) => {
        const value = JSON.parse(message.toString());
        if (value.type === "INDEX_ACK" && value.final) finalAcks++;
        if (value.type === "INDEX_ABORT_ACK") abortAcks++;
        if (
          (value.type === "INDEX_ACK" && value.final) ||
          value.type === "INDEX_ABORT_ACK"
        )
          activeSnapshot = undefined;
        if (
          value.type === "INDEX_ACK" &&
          value.snapshot === gateSnapshot &&
          value.sequence === 0
        ) {
          assert.ok(!held, "only one pending ACK");
          held = { peer, message };
        } else if (peer.readyState === WebSocket.OPEN)
          peer.send(message, { binary: false });
      });
      return;
    }
    const state = data.get(path);
    if (!state) return peer.terminate();
    state.socket = peer;
    peer.on("close", () => {
      state.closed = true;
      clearTimeout(state.resumeTimer);
    });
    peer.on("message", (message, binary) => {
      if (!binary) return state.headers.push(JSON.parse(message.toString()));
      state.bytes += message.length;
      if (state.throttle) {
        peer.pause();
        clearTimeout(state.resumeTimer);
        state.resumeTimer = setTimeout(() => peer.resume(), 150);
      }
    });
  });
});

function releaseAck() {
  assert.ok(held, "a real Server ACK was delayed");
  const pending = held;
  held = undefined;
  gateSnapshot = undefined;
  pending.peer.send(pending.message, { binary: false });
}
function library() {
  return JSON.parse(
    sql(
      `SELECT COALESCE(json_object_agg(resource,json_build_object('available',available,'version',source_version,'metadata',metadata,'duration',duration_ms)),'{}'::json) FROM media_items WHERE source_id='${agentId}'`,
    ),
  );
}
function offer(resource, options = {}) {
  const path = `/data/${randomUUID()}`;
  const state = {
    headers: [],
    bytes: 0,
    closed: false,
    throttle: Boolean(options.throttle),
  };
  data.set(path, state);
  const request = { resource, data_url: `http://unused${path}`, ...options };
  delete request.throttle;
  const transferId = randomUUID();
  sql(
    `INSERT INTO agent_transfers(id,agent_id,token_hash,request,expires_at) VALUES('${transferId}','${agentId}','${createHash("sha256").update(transferId).digest("hex")}','${JSON.stringify(request)}',now()+interval '30 seconds')`,
  );
  return state;
}
function mediaHandles() {
  return Number(
    docker(
      "exec",
      agent,
      "sh",
      "-c",
      'n=0; for f in /proc/1/fd/*; do p=$(readlink "$f" 2>/dev/null || true); if [ "$p" = /media/large.mp4 ]; then n=$((n+1)); fi; done; echo "$n"',
    ),
  );
}
async function range(resource = "large.mp4", sourceVersion) {
  const state = offer(resource, {
    range: "bytes=10-99",
    ...(sourceVersion ? { source_version: sourceVersion } : {}),
  });
  await until(() => state.closed, "concurrent Range completes", 5000);
  return state;
}

await mkdir(root, { recursive: true });
try {
  docker("network", "create", name);
  docker("volume", "create", volume);
  docker(
    "run",
    "--rm",
    "--user",
    "0",
    "-v",
    `${volume}:/media`,
    tag,
    "sh",
    "-c",
    "mkdir /media/late; i=0; while [ $i -lt 1400 ]; do printf x > /media/item-$i.mp4; i=$((i+1)); done; truncate -s 1024 /media/versioned.mp4; printf deleted > /media/deleted.mp4; printf unreadable > /media/unreadable.mp4; printf missing > /media/late/disappears.mp4; printf keep > /media/late/keep.mp4; truncate -s 17179869184 /media/large.mp4; chmod 755 /media /media/late; chmod 644 /media/*.mp4 /media/late/*.mp4; chmod 000 /media/unreadable.mp4",
  );
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
  await until(
    () => {
      try {
        return docker("exec", db, "pg_isready", "-U", "rainsync").includes(
          "accepting connections",
        );
      } catch {
        return false;
      }
    },
    "PostgreSQL ready",
    45000,
  );
  docker(
    "run",
    "-d",
    "--name",
    server,
    "--network",
    name,
    "-p",
    "127.0.0.1::8080",
    "-e",
    `DATABASE_URL=postgres://rainsync:${password}@db/rainsync`,
    "-e",
    `SOURCE_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    "-e",
    `ADMIN_PASSWORD=${password}`,
    "-e",
    "PUBLIC_ORIGIN=http://index.test",
    "-e",
    "WORKER_URL=http://unused:8081",
    tag,
    "rainsync-server",
  );
  serverBase = `http://${docker("port", server, "8080/tcp")}`;
  await until(
    async () => {
      try {
        return (await fetch(`${serverBase}/health`)).ok;
      } catch {
        return false;
      }
    },
    "Server ready",
    45000,
  );
  sql(
    `INSERT INTO agents(id,name,token_hash) VALUES('${agentId}','index refresh fixture','${createHash("sha256").update(token).digest("hex")}')`,
  );
  await new Promise((r) => http.listen(0, "0.0.0.0", r));
  origin = `http://host.docker.internal:${http.address().port}`;
  docker(
    "run",
    "-d",
    "--name",
    agent,
    "--network",
    name,
    "-v",
    `${volume}:/media`,
    "-e",
    `SERVER_URL=${origin}`,
    "-e",
    `AGENT_DATA_ORIGIN=${origin}`,
    "-e",
    `AGENT_TOKEN=${token}`,
    "-e",
    "MEDIA_ROOT=/media",
    "-e",
    "AGENT_INDEX_INTERVAL_SECS=5",
    tag,
    "rainsync-nas-agent",
  );
  assert.equal(
    docker("exec", agent, "id", "-u"),
    "10001",
    "real non-root Agent",
  );
  report.agent_sha256 = docker(
    "exec",
    agent,
    "sha256sum",
    "/usr/local/bin/rainsync-nas-agent",
  ).split(" ")[0];
  await until(() => finalAcks >= 1, "complete initial paginated index");
  let rows = library();
  assert.equal(Object.keys(rows).length, 1406);
  assert.equal(rows["unreadable.mp4"].available, false);
  assert.equal(rows["unreadable.mp4"].version, null);
  assert.equal(rows["late/keep.mp4"].available, true);
  assert.equal(connections, 1);
  assert.ok([...snapshots.values()][0].pages > 1);
  report.cases.push({
    scenario: "chmod000-initial-file-does-not-reconnect-or-truncate-index",
    indexed: Object.keys(rows).length,
    uid: 10001,
  });

  const active = [
    offer("large.mp4", { throttle: true }),
    offer("large.mp4", { throttle: true }),
  ];
  await until(
    () =>
      active.every(
        (state) => state.bytes > 0 && state.headers[0]?.status === 200,
      ),
    "two continuous transfers",
  );
  await until(() => mediaHandles() === 2, "two held source files");
  const connected = connections;
  const oldVersion = rows["versioned.mp4"].version;
  sql(
    `UPDATE media_items SET metadata='{"old":true}',duration_ms=123 WHERE source_id='${agentId}' AND resource='versioned.mp4'`,
  );
  mutate(
    "chmod 644 /media/unreadable.mp4; touch -m -d '2026-01-02 03:04:05 UTC' /media/versioned.mp4; printf added > /media/added.mp4; chmod 644 /media/added.mp4",
  );
  await until(() => {
    rows = library();
    return (
      rows["unreadable.mp4"]?.available &&
      rows["added.mp4"]?.available &&
      rows["versioned.mp4"]?.version !== oldVersion
    );
  }, "periodic restore, addition and same-size mtime refresh");
  assert.deepEqual(rows["versioned.mp4"].metadata, {});
  assert.equal(rows["versioned.mp4"].duration, null);
  assert.equal(connections, connected);
  assert.ok(active.every((state) => !state.closed));
  const oldGrant = await range("versioned.mp4", oldVersion);
  assert.equal(oldGrant.headers[0]?.status, 409);
  const newGrant = await range("versioned.mp4", rows["versioned.mp4"].version);
  assert.equal(newGrant.headers[0]?.status, 206);
  assert.equal(newGrant.bytes, 90);
  report.cases.push({
    scenario:
      "periodic-refresh-restores-chmod-and-invalidates-same-size-mtime-metadata",
    reconnected: false,
    transfers_alive: 2,
  });

  // Pause after a real non-final ACK. The blocking producer can buffer at
  // most two pages, so the late directory cannot have been entered yet.
  holdNext = true;
  await until(() => held, "gate next real snapshot");
  const gate = gateSnapshot,
    hb = heartbeats,
    acknowledgements = finalAcks;
  const before = library();
  mutate(
    "rm /media/deleted.mp4; printf pending > /media/pending.mp4; chmod 644 /media/pending.mp4; chmod 000 /media/late",
  );
  const bytesBefore = active.map((state) => state.bytes);
  await delay(11500);
  assert.equal(snapshots.get(gate).pages, 1, "no page sent before ACK");
  assert.equal(finalAcks, acknowledgements);
  assert.equal(connections, connected, "delayed ACK does not reconnect");
  assert.ok(heartbeats >= hb + 2, "heartbeats while ACK is pending");
  assert.ok(
    active.every((state, i) => !state.closed && state.bytes > bytesBefore[i]),
    "transfer bytes continue while index waits",
  );
  const concurrent = await range();
  assert.equal(concurrent.headers[0]?.status, 206);
  assert.equal(concurrent.bytes, 90);
  assert.deepEqual(library(), before, "partial snapshot invisible in DB");
  releaseAck();
  await until(() => abortAcks >= 1, "directory failure rolls back scan");
  assert.deepEqual(
    library(),
    before,
    "failed partial snapshot preserves full old library",
  );
  assert.equal(connections, connected);
  assert.ok(active.every((state) => !state.closed));
  report.cases.push({
    scenario: "delayed-ACK-heartbeat-transfer-and-directory-abort",
    delayed_ms: 11500,
    heartbeat_delta: heartbeats - hb,
    partial_index_rolled_back: true,
    reconnects: 0,
  });

  mutate("chmod 755 /media/late");
  await until(() => {
    rows = library();
    return (
      rows["deleted.mp4"]?.available === false && rows["pending.mp4"]?.available
    );
  }, "complete recovered snapshot adds and removes entries");
  assert.equal(rows["late/keep.mp4"].available, true);
  assert.equal(connections, connected);
  assert.equal(mediaHandles(), 2);
  report.cases.push({
    scenario:
      "directory-recovery-commits-additions-and-deletions-without-restart",
    transfers_alive: 2,
  });

  holdNext = true;
  await until(() => held, "gate disappearance scan");
  mutate("rm /media/late/disappears.mp4");
  releaseAck();
  await until(
    () => library()["late/disappears.mp4"]?.available === false,
    "late video disappears during scan without abort",
  );
  assert.equal(connections, connected);
  assert.ok(active.every((state) => !state.closed));
  report.cases.push({
    scenario: "single-video-disappears-during-paginated-scan",
    reconnected: false,
    transfers_alive: 2,
  });

  mutate("chmod 000 /media/unreadable.mp4");
  await until(
    () => library()["unreadable.mp4"]?.available === false,
    "connected file permission loss",
  );
  const hbUnreadable = heartbeats,
    ackUnreadable = finalAcks;
  await until(
    () => finalAcks >= ackUnreadable + 2,
    "repeated unreadable-file snapshots",
  );
  assert.equal(connections, connected);
  assert.ok(
    heartbeats > hbUnreadable && active.every((state) => !state.closed),
  );
  assert.equal(library()["late/keep.mp4"].available, true);
  mutate("chmod 644 /media/unreadable.mp4");
  await until(
    () => library()["unreadable.mp4"]?.available === true,
    "second chmod recovery",
  );
  report.cases.push({
    scenario: "repeated-unreadable-file-scans-keep-control-and-transfers",
    recovered: true,
  });

  holdNext = true;
  await until(() => held, "gate disconnection snapshot");
  const beforeDisconnect = library();
  mutate(
    "rm /media/added.mp4; printf reconnected > /media/after-reconnect.mp4; chmod 644 /media/after-reconnect.mp4",
  );
  // Drop both directions before the snapshot can reach final; the old source
  // rows must remain until the new control connection commits a complete scan.
  held = undefined;
  gateSnapshot = undefined;
  controlUpstream.terminate();
  control.terminate();
  await until(
    () => mediaHandles() === 0,
    "control loss closes old transfer files",
    5000,
  );
  assert.deepEqual(
    library(),
    beforeDisconnect,
    "disconnected snapshot rolled back",
  );
  for (const state of active) {
    state.throttle = false;
    clearTimeout(state.resumeTimer);
    state.socket.resume();
  }
  await until(
    () => active.every((state) => state.closed),
    "old data tasks cancelled",
    5000,
  );
  await until(
    () => {
      rows = library();
      return (
        connections === connected + 1 &&
        rows["added.mp4"]?.available === false &&
        rows["after-reconnect.mp4"]?.available
      );
    },
    "reconnected complete index",
    15000,
  );
  const recovered = await range();
  assert.equal(recovered.headers[0]?.status, 206);
  assert.equal(recovered.bytes, 90);
  report.cases.push({
    scenario:
      "control-loss-rolls-back-partial-index-and-cancels-only-that-connection-transfers",
    recovered_connections: 1,
    old_media_handles: 0,
  });
  report.completed_at = new Date().toISOString();
  report.heartbeats = heartbeats;
  report.final_snapshots = finalAcks;
  report.aborted_snapshots = abortAcks;
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`Evidence: ${resolve(root, "report.json")}`);
} catch (error) {
  report.failure = String(error.stack ?? error);
  report.control_connections = connections;
  report.heartbeats = heartbeats;
  report.final_snapshots = finalAcks;
  report.aborted_snapshots = abortAcks;
  report.snapshot_pages = [...snapshots.values()];
  for (const [label, container] of [
    ["server", server],
    ["agent", agent],
  ]) {
    try {
      report[`${label}_logs`] = docker("logs", "--tail", "50", container);
    } catch {}
  }
  await writeFile(
    resolve(root, "failed-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  throw error;
} finally {
  for (const state of data.values()) clearTimeout(state.resumeTimer);
  for (const container of [agent, server, db]) {
    try {
      docker("rm", "-f", container);
    } catch {}
  }
  try {
    docker("volume", "rm", volume);
  } catch {}
  try {
    docker("network", "rm", name);
  } catch {}
  for (const upstream of upstreams) upstream.terminate();
  for (const peer of ws.clients) peer.terminate();
  for (const socket of raw) socket.destroy();
  if (http.listening) await new Promise((r) => http.close(r));
  ws.close();
}
