// Real non-root Linux Agent; controlled data peers stop consuming binary data
// while sending the exact Worker backpressure Ping, generic Ping or Pong.
// Follow with nas-soak.mjs against the same fresh image to verify real Worker.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

const tag = process.env.WORKER_TEST_IMAGE ?? "rainsync-worker-validation:local";
const name = `rainsync-agent-backpressure-${randomUUID().slice(0, 8)}`;
const volume = `${name}-media`;
const root = resolve(".runtime/agent-backpressure", name);
const heartbeat = Buffer.from("rainsync-backpressure-v1");
const rangeBytes = 64 * 1024 * 1024;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 5000) {
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
    "Real Linux non-root Agent with controlled peers; separate NAS soak proves real Worker/browser behavior",
    "Local sparse file, not arbitrary uninterruptible kernel I/O",
  ],
};
const peers = new Map(),
  raw = new Set();
let control,
  connections = 0;
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
      control = peer;
      connections++;
      peer.on("message", (message) => {
        const value = JSON.parse(message.toString());
        if (value.type === "INDEX")
          peer.send(
            JSON.stringify({
              type: "INDEX_ACK",
              snapshot: value.snapshot,
              sequence: value.sequence,
            }),
          );
      });
      return;
    }
    const state = peers.get(path);
    if (!state) return peer.terminate();
    state.socket = peer;
    peer.on("close", () => {
      state.closed = true;
      clearInterval(state.timer);
    });
    peer.on("message", (message, binary) => {
      if (!binary) return state.headers.push(JSON.parse(message.toString()));
      state.bytes += message.length;
      if (!state.pause) return;
      peer.pause();
      if (!state.timer && state.signal) {
        state.timer = setInterval(() => {
          if (peer.readyState !== WebSocket.OPEN) return;
          if (state.signal === "healthy") peer.ping(heartbeat);
          if (state.signal === "generic") peer.ping("ordinary-ping");
          if (state.signal === "pong") peer.pong(heartbeat);
          state.signals++;
        }, 2000);
      }
    });
  });
});
function offer(signal) {
  const path = `/data/${randomUUID()}`;
  const state = {
    signal,
    pause: true,
    signals: 0,
    bytes: 0,
    headers: [],
    closed: false,
    began: Date.now(),
  };
  peers.set(path, state);
  control.send(
    JSON.stringify({
      type: "TRANSFER",
      request: {
        resource: "large.mp4",
        data_url: `http://unused${path}`,
        range: `bytes=0-${rangeBytes - 1}`,
      },
    }),
  );
  return state;
}
function handles() {
  return Number(
    docker(
      "exec",
      name,
      "sh",
      "-c",
      'n=0; for f in /proc/1/fd/*; do p=$(readlink "$f" 2>/dev/null || true); if [ "$p" = /media/large.mp4 ]; then n=$((n+1)); fi; done; echo "$n"',
    ),
  );
}
function closePeer(state) {
  clearInterval(state.timer);
  state.timer = undefined;
  state.pause = false;
  state.socket.resume();
  state.socket.close();
}
await mkdir(root, { recursive: true });
try {
  await new Promise((r) => http.listen(0, "0.0.0.0", r));
  const origin = `http://host.docker.internal:${http.address().port}`;
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
    "truncate -s 17179869184 /media/large.mp4; chmod 755 /media; chmod 644 /media/large.mp4",
  );
  docker(
    "run",
    "-d",
    "--name",
    name,
    "-v",
    `${volume}:/media`,
    "-e",
    `SERVER_URL=${origin}`,
    "-e",
    `AGENT_DATA_ORIGIN=${origin}`,
    "-e",
    "AGENT_TOKEN=isolated-backpressure-fixture",
    "-e",
    "MEDIA_ROOT=/media",
    tag,
    "rainsync-nas-agent",
  );
  assert.equal(docker("exec", name, "id", "-u"), "10001");
  await until(
    () => control?.readyState === WebSocket.OPEN,
    "Agent control",
    10000,
  );
  const healthy = offer("healthy"),
    generic = offer("generic"),
    pong = offer("pong");
  await until(
    () =>
      [healthy, generic, pong].every(
        (state) => state.bytes > 0 && state.headers[0]?.status === 206,
      ),
    "three paused data peers",
  );
  await until(() => handles() === 3, "three source handles");
  await delay(43000);
  assert.ok(
    healthy.signals >= 20,
    "healthy backpressure signals were actually sent",
  );
  assert.equal(
    handles(),
    1,
    "only the healthy backpressure transfer survives over 40 seconds",
  );
  await until(
    () => handles() === 1,
    "generic Ping/Pong cannot extend blocked writes",
    5000,
  );
  generic.pause = false;
  pong.pause = false;
  generic.socket.resume();
  pong.socket.resume();
  await until(
    () => generic.closed && pong.closed,
    "non-health peers closed",
    5000,
  );
  assert.equal(healthy.closed, false);
  assert.equal(connections, 1);
  assert.ok(generic.signals >= 10 && pong.signals >= 10);
  report.cases.push({
    scenario:
      "healthy-backpressure-survives-over-30s-but-generic-Ping-and-Pong-do-not",
    elapsed_ms: Date.now() - healthy.began,
    healthy_signals: healthy.signals,
    held_source_handles: 1,
  });

  // Resume the original pinned write. Complete the entire authorized range,
  // checking that changing the deadline never restarts a partially sent frame.
  healthy.pause = false;
  healthy.socket.resume();
  await until(
    () => healthy.closed,
    "healthy backpressure resumes and completes",
    10000,
  );
  assert.equal(healthy.headers.length, 1);
  assert.equal(healthy.bytes, rangeBytes);
  assert.equal(healthy.bytes, Number(healthy.headers[0]["content-length"]));
  await until(() => handles() === 0, "completed healthy file is released");
  report.cases.push({
    scenario: "pinned-write-resumes-and-completes-exact-range-once",
    bytes: healthy.bytes,
  });

  const lost = offer("healthy");
  await until(() => lost.bytes > 0 && handles() === 1, "health-loss fixture");
  await delay(6500);
  assert.ok(
    lost.signals >= 3,
    "health-loss fixture first received real health signals",
  );

  const close = offer("healthy");
  await until(
    () => close.bytes > 0 && handles() === 2,
    "healthy Close fixture",
  );
  await until(
    () => close.signals >= 1,
    "Close fixture sent a healthy backpressure Ping",
  );
  let began = Date.now();
  closePeer(close);
  await until(
    () => handles() === 1,
    "Close cancels healthy blocked transfer within five seconds",
    5000,
  );
  report.cases.push({
    scenario: "Close-cancels-healthy-backpressured-send",
    released_ms: Date.now() - began,
    healthy_signals_before_close: close.signals,
  });

  clearInterval(lost.timer);
  lost.timer = undefined;
  began = Date.now();
  await until(
    () => handles() === 0,
    "lost healthy signal reaches bounded write deadline",
    35000,
  );
  lost.pause = false;
  lost.socket.resume();
  await until(() => lost.closed, "lost-signal socket closes", 5000);
  assert.ok(
    Date.now() - began <= 35000,
    "no indefinite blocked write without health",
  );
  report.cases.push({
    scenario: "stopped-health-signal-times-out-within-35s",
    released_ms: Date.now() - began,
  });

  const revoked = offer("healthy");
  await until(
    () => revoked.bytes > 0 && handles() === 1,
    "healthy control-loss fixture",
  );
  await until(
    () => revoked.signals >= 1,
    "control-loss fixture sent a healthy backpressure Ping",
  );
  began = Date.now();
  control.terminate();
  await until(
    () => handles() === 0,
    "control loss cancels healthy blocked transfer within five seconds",
    5000,
  );
  const released = Date.now() - began;
  closePeer(revoked);
  await until(
    () => connections === 2 && control.readyState === WebSocket.OPEN,
    "fresh authorized control",
    10000,
  );
  report.cases.push({
    scenario: "control-loss-cancels-health-extended-transfer",
    released_ms: released,
    reconnect_ms: Date.now() - began,
    healthy_signals_before_control_loss: revoked.signals,
  });
  report.completed_at = new Date().toISOString();
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`Evidence: ${resolve(root, "report.json")}`);
} catch (error) {
  report.failure = String(error.stack ?? error);
  try {
    report.agent_logs = docker("logs", "--tail", "30", name);
  } catch {}
  await writeFile(
    resolve(root, "failed-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  throw error;
} finally {
  for (const state of peers.values()) clearInterval(state.timer);
  try {
    docker("rm", "-f", name);
  } catch {}
  try {
    docker("volume", "rm", volume);
  } catch {}
  for (const peer of ws.clients) peer.terminate();
  for (const socket of raw) socket.destroy();
  if (http.listening) await new Promise((r) => http.close(r));
  ws.close();
}
