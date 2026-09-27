import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

const tag =
  process.env.WORKER_TEST_IMAGE ?? "rainsync-agent-lifecycle-validation:local";
const name = `rainsync-agent-life-${randomUUID().slice(0, 8)}`;
const volume = `${name}-media`;
const root = resolve(".runtime/agent-lifecycle", name);
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const report = {
  image: docker("image", "inspect", "--format", "{{.Id}}", tag),
  cases: [],
};
const peers = new Map(),
  raw = new Set();
let control,
  connections = 0;
const http = createServer();
const ws = new WebSocketServer({ noServer: true });
http.on("connection", (socket) => {
  raw.add(socket);
  socket.on("close", () => raw.delete(socket));
});
http.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url, "http://fixture").pathname;
  if (path.startsWith("/hang/")) return;
  ws.handleUpgrade(request, socket, head, (peer) => {
    peer.on("error", () => {});
    if (path === "/api/v1/agents/ws") {
      control = peer;
      connections++;
      peer.on("message", (data) => {
        const value = JSON.parse(data.toString());
        if (value.type === "INDEX")
          peer.send(
            JSON.stringify({ type: "INDEX_ACK", sequence: value.sequence }),
          );
      });
      return;
    }
    const state = peers.get(path);
    if (!state) {
      peer.terminate();
      return;
    }
    state.socket = peer;
    peer.on("close", () => {
      state.closed = true;
    });
    peer.on("message", (data, binary) => {
      if (!binary) {
        state.headers.push(JSON.parse(data.toString()));
        return;
      }
      state.bytes += data.length;
      if (state.pause) peer.pause();
    });
  });
});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw Error(`deadline: ${label}`);
}
function offer(options = {}) {
  const path = `/${options.hang ? "hang" : "data"}/${randomUUID()}`;
  const state = {
    headers: [],
    bytes: 0,
    pause: Boolean(options.pause),
    closed: false,
  };
  peers.set(path, state);
  control.send(
    JSON.stringify({
      type: "TRANSFER",
      request: {
        data_url: `http://unused${path}`,
        resource: "large.mp4",
        ...options,
      },
    }),
  );
  return state;
}
function handles() {
  // Count only the fixture media file, not unrelated paths or descriptors.
  return Number(
    docker(
      "exec",
      name,
      "sh",
      "-c",
      'n=0; for f in /proc/[0-9]*/fd/*; do p=$(readlink "$f" 2>/dev/null || true); if [ "$p" = /media/large.mp4 ]; then n=$((n+1)); fi; done; echo "$n"',
    ),
  );
}
function rssKiB() {
  return Number(
    /VmRSS:\s+(\d+)/.exec(docker("exec", name, "cat", "/proc/1/status"))[1],
  );
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
    "truncate -s 1073741824 /media/large.mp4; chmod 644 /media/large.mp4",
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
    "AGENT_TOKEN=isolated-fixture",
    "-e",
    "MEDIA_ROOT=/media",
    tag,
    "rainsync-nas-agent",
  );
  await until(
    () => control?.readyState === WebSocket.OPEN,
    "Agent control",
    10000,
  );
  report.agent_executable = docker("exec", name, "readlink", "/proc/1/exe");
  assert.ok(report.agent_executable.endsWith("/rainsync-nas-agent"));
  report.baseline_rss_kib = rssKiB();
  const active = [];
  for (let i = 0; i < 16; i++) {
    const state = offer({ pause: true });
    await until(
      () => state.headers[0]?.status === 200 && state.bytes > 0,
      `transfer ${i}`,
    );
    active.push(state);
  }
  await until(() => handles() === 16, "sixteen open source handles");
  const busy = offer();
  await until(() => busy.closed, "seventeenth response");
  assert.equal(busy.headers[0]?.status, 503);
  assert.equal(handles(), 16);
  report.cases.push({
    scenario: "16-active-17th-rejected",
    handles: 16,
    rss_kib: rssKiB(),
  });

  let began = Date.now();
  for (let i = 0; i < 16; i += 2) {
    if (i % 4 === 0) active[i].socket.close();
    else active[i].socket.terminate();
  }
  await until(() => handles() === 8, "cancel eight handles");
  report.cases.push({
    scenario: "cancel-eight-backpressured",
    released_ms: Date.now() - began,
    handles: 8,
  });
  for (let i = 0; i < 8; i++) {
    await until(async () => {
      const state = offer({ pause: true });
      await until(() => state.headers.length > 0, "replacement response");
      if (state.headers[0].status === 503) return false;
      assert.equal(state.headers[0].status, 200);
      await until(() => state.bytes > 0, "replacement body");
      active.push(state);
      return true;
    }, "reused slot");
  }
  await until(() => handles() === 16, "reused sixteen slots");
  assert.ok(
    Date.now() - began < 5000,
    "cancelled admission slots reusable within five seconds",
  );
  const previous = connections;
  began = Date.now();
  control.terminate();
  await until(() => handles() === 0, "control disconnect releases all files");
  report.cases.push({
    scenario: "control-disconnect",
    released_ms: Date.now() - began,
    handles: 0,
    rss_kib: rssKiB(),
  });
  // Paused fixture sockets may not read FIN, so resume to observe their closure.
  for (const state of active) {
    state.pause = false;
    state.socket?.resume();
  }
  await until(
    () => active.every((s) => s.closed),
    "all old data sockets closed",
  );
  await until(
    () => connections > previous && control?.readyState === WebSocket.OPEN,
    "Agent reconnect",
    10000,
  );

  const range = offer({ range: "bytes=10-99" });
  await until(() => range.closed, "Range complete");
  assert.equal(range.headers.length, 1);
  assert.equal(range.headers[0].status, 206);
  assert.equal(range.bytes, 90);
  const head = offer({ head: true });
  await until(() => head.closed, "HEAD complete");
  assert.equal(head.bytes, 0);
  assert.equal(head.headers[0].status, 200);
  const missing = offer({ resource: "missing.mp4" });
  await until(() => missing.closed, "missing file");
  assert.equal(missing.headers[0].status, 404);
  await until(() => handles() === 0, "completed files closed");
  report.cases.push({
    scenario: "reconnect-range-head-missing",
    range_bytes: range.bytes,
  });

  // Stalled handshakes hold admission but cannot occupy slots indefinitely.
  for (let i = 0; i < 16; i++) offer({ hang: true });
  await delay(300);
  const overloaded = offer();
  await until(() => overloaded.closed, "handshake overload rejection");
  assert.equal(overloaded.headers[0].status, 503);
  await delay(10500);
  const recovered = offer({ head: true });
  await until(() => recovered.closed, "handshake deadline frees slots");
  assert.equal(recovered.headers[0].status, 200);
  report.cases.push({ scenario: "handshake-deadline-releases-slots" });

  const short = offer({ pause: true });
  await until(() => short.bytes > 0, "source read started");
  docker(
    "exec",
    "--user",
    "0",
    name,
    "truncate",
    "-s",
    "0",
    "/media/large.mp4",
  );
  short.pause = false;
  short.socket.resume();
  await until(() => short.closed, "shortened source closes", 10000);
  assert.equal(
    short.headers.length,
    1,
    "never sends a second metadata response after headers",
  );
  assert.ok(short.bytes < Number(short.headers[0]["content-length"]));
  await until(() => handles() === 0, "truncated source released");
  report.cases.push({
    scenario: "source-shortened",
    received_bytes: short.bytes,
    declared_bytes: Number(short.headers[0]["content-length"]),
  });
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`Evidence: ${resolve(root, "report.json")}`);
} catch (error) {
  report.failure = String(error.stack ?? error);
  await writeFile(
    resolve(root, "failed-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  throw error;
} finally {
  try {
    docker("rm", "-f", name);
  } catch {}
  try {
    docker("volume", "rm", volume);
  } catch {}
  for (const socket of raw) socket.destroy();
  for (const peer of ws.clients) peer.terminate();
  await new Promise((r) => http.close(r));
  ws.close();
}
