// Controlled Windows-native NAS Agent lifecycle checks; no deployed services or .env.
// Run: node tests/agent-native.mjs (builds current source with cargo --locked).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";

assert.equal(process.platform, "win32", "This harness requires native Windows");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = resolve(repo, "tests/fixtures/agent-native.ps1");
const root = resolve(repo, ".runtime/agent-native", `run-${randomUUID()}`);
const media = resolve(root, "media");
const executable = resolve(repo, "target/debug/rainsync-nas-agent.exe");
const manifest = resolve(root, "files.json");
const files = Array.from({ length: 16 }, (_, i) => `load-${i}.mp4`);
files.push("edited.mp4", "replaced.mp4", "shortened.mp4");
const allPaths = files.map((file) => resolve(media, file));
const runFile = promisify(execFile);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {
  platform: process.platform,
  started_at: new Date().toISOString(),
  cases: [],
  memory_samples: [],
  limitations: [
    "Controlled local HTTP/WS fixture, not deployed Server/Worker/browser acceptance",
    "Native Windows only; no Linux or arm64 validation",
    "Short lifecycle and repeated-cycle measurements, not a two-hour viewing or memory-trend test",
    "Local sparse regular files; no uninterruptible kernel I/O, network shares or all filesystems",
    "FileShare.None probes prove open-file release, not an exact enumeration of OS file handles",
  ],
};
const peers = new Map();
const raw = new Set();
const http = createServer((request, response) => {
  response.writeHead(404).end();
});
const ws = new WebSocketServer({ noServer: true });
let control,
  connections = 0,
  indexPages = 0,
  agent,
  agentExit,
  logs = "";
let timedOut = false;
const deadline = setTimeout(() => {
  timedOut = true;
  agent?.kill();
  for (const socket of raw) socket.destroy();
}, 240000);

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
        if (value.type === "INDEX") {
          indexPages++;
          peer.send(
            JSON.stringify({ type: "INDEX_ACK", sequence: value.sequence }),
          );
        }
      });
      return;
    }
    const state = peers.get(path);
    if (!state) return peer.terminate();
    state.socket = peer;
    peer.on("close", (code) => {
      state.closed = true;
      state.closeCode = code;
    });
    peer.on("message", (data, binary) => {
      if (!binary) {
        state.headers.push(JSON.parse(data.toString()));
        return;
      }
      state.bytes += data.length;
      if (state.capture && state.bytes <= 65536)
        state.chunks.push(Buffer.from(data));
      if (state.pause) peer.pause();
    });
  });
});

async function powershell(mode, options = {}) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helper,
    "-Mode",
    mode,
  ];
  if (mode === "create" || mode === "probe") args.push("-Manifest", manifest);
  if (options.target) args.push("-Target", options.target);
  if (mode === "metrics") args.push("-AgentProcessId", String(agent.pid));
  const { stdout } = await runFile("powershell.exe", args, {
    cwd: repo,
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}
async function until(check, label, timeout = 8000) {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) {
    assert.ok(!timedOut, "global test deadline");
    if (agent && agent.exitCode !== null)
      throw Error(`Agent exited (${agent.exitCode}) during ${label}`);
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw Error(`deadline: ${label}`);
}
function offer(options = {}) {
  assert.equal(
    control?.readyState,
    WebSocket.OPEN,
    "control connection available",
  );
  const path = `/${options.hang ? "hang" : "data"}/${randomUUID()}`;
  const state = {
    headers: [],
    bytes: 0,
    pause: Boolean(options.pause),
    capture: Boolean(options.capture),
    closed: false,
    chunks: [],
    resource: options.resource ?? "load-0.mp4",
  };
  peers.set(path, state);
  const { pause, capture, hang, ...request } = options;
  control.send(
    JSON.stringify({
      type: "TRANSFER",
      request: {
        data_url: `http://unused${path}`,
        resource: state.resource,
        ...request,
      },
    }),
  );
  return state;
}
async function complete(options, expected = 200) {
  const state = offer(options);
  await until(
    () => state.closed,
    `${options.resource ?? "file"} response completed`,
  );
  assert.equal(state.headers.length, 1, "exactly one metadata response");
  assert.equal(state.headers[0].status, expected);
  return state;
}
async function probeLocked(expected, label, timeout = 8000) {
  return until(
    async () => {
      const result = await powershell("probe");
      const locked = result
        .filter((entry) => !entry.exclusive)
        .map((entry) => entry.file)
        .sort();
      return (
        JSON.stringify(locked) === JSON.stringify([...expected].sort()) &&
        result
      );
    },
    label,
    timeout,
  );
}
async function metrics(phase) {
  const sample = {
    phase,
    elapsed_ms: Date.now() - began,
    ...(await powershell("metrics")),
  };
  report.memory_samples.push(sample);
  return sample;
}
function record(scenario, evidence = {}) {
  report.cases.push({ scenario, ...evidence });
  console.log(`PASS ${scenario}`);
}
function requestCancel(state, abrupt) {
  if (abrupt) state.socket.terminate();
  else state.socket.close();
}
async function observeCancellation(states) {
  // Check file release first, while Close consumers are still backpressured.
  // Then resume the fixture reader so it can observe the agent's FIN/Close.
  for (const state of states) {
    state.pause = false;
    state.socket.resume();
  }
  await until(
    () => states.every((state) => state.closed),
    "cancelled sockets closed",
  );
}
const began = Date.now();
await mkdir(media, { recursive: true });
await writeFile(manifest, JSON.stringify(allPaths));
try {
  const build = await runFile(
    "cargo",
    ["build", "-p", "rainsync-nas-agent", "--locked"],
    {
      cwd: repo,
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  await writeFile(resolve(root, "build.log"), build.stdout + build.stderr);
  report.executable = executable;
  report.executable_sha256 = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  report.source_revision = (
    await runFile("git", ["rev-parse", "HEAD"], { cwd: repo })
  ).stdout.trim();
  report.source_sha256 = {};
  for (const path of [
    "Cargo.lock",
    "apps/nas-agent/src/main.rs",
    "crates/media-core/src/file_version.rs",
    "tests/agent-native.mjs",
    "tests/fixtures/agent-native.ps1",
  ]) {
    report.source_sha256[path] = createHash("sha256")
      .update(await readFile(resolve(repo, path)))
      .digest("hex");
  }
  report.fixture = await powershell("create");
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${http.address().port}`;
  agent = spawn(executable, [], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SERVER_URL: origin,
      AGENT_DATA_ORIGIN: origin,
      MEDIA_ROOT: media,
      AGENT_TOKEN: randomUUID(),
      AGENT_CREDENTIAL_FILE: resolve(root, "unused-credentials.json"),
    },
  });
  agentExit = new Promise((r) => {
    agent.once("error", (error) => r({ error: String(error) }));
    agent.once("exit", (code, signal) => r({ code, signal }));
  });
  for (const stream of [agent.stdout, agent.stderr])
    stream.on("data", (chunk) => {
      if (logs.length < 1024 * 1024) logs += chunk.toString();
    });
  await until(
    () => control?.readyState === WebSocket.OPEN && indexPages > 0,
    "Agent control and index",
    15000,
  );
  report.initial_exclusive_probes = await probeLocked(
    [],
    "initial files released",
  );
  await metrics("idle");

  const active = [];
  for (let i = 0; i < 16; i++) {
    const state = offer({ resource: files[i], pause: true });
    await until(
      () => state.headers[0]?.status === 200 && state.bytes > 0,
      `transfer ${i}`,
    );
    active.push(state);
  }
  const sixteen = await probeLocked(
    files.slice(0, 16),
    "sixteen distinct source files open",
  );
  const busy = await complete({ head: true }, 503);
  assert.equal(busy.bytes, 0);
  await probeLocked(
    files.slice(0, 16),
    "seventeenth rejection leaves active files held",
  );
  await metrics("sixteen-backpressured");
  record("16-active-17th-rejected", {
    active_sources: 16,
    exclusive_probes: sixteen,
    rejected_status: busy.headers[0].status,
  });

  const cancelled = active.filter((_, i) => i % 2 === 0);
  const cancellationStart = Date.now();
  cancelled.forEach((state, i) => requestCancel(state, i % 2 === 1));
  const remaining = files.slice(0, 16).filter((_, i) => i % 2 === 1);
  const eight = await probeLocked(
    remaining,
    "eight files released after Close/TCP cancellation",
  );
  const cancelMs = Date.now() - cancellationStart;
  assert.ok(
    cancelMs < 5000,
    "mixed cancellation releases sources in five seconds",
  );
  await observeCancellation(cancelled);
  record("close-and-tcp-disconnect-cancel-eight", {
    released_ms: cancelMs,
    exclusive_probes: eight,
  });

  for (let i = 0; i < 16; i += 2) {
    const state = offer({ resource: files[i], pause: true });
    await until(
      () => state.headers[0]?.status === 200 && state.bytes > 0,
      `reuse ${i}`,
    );
    active.push(state);
  }
  await probeLocked(files.slice(0, 16), "all sixteen admission slots reused");
  record("cancelled-slots-reused", { reused_slots: 8 });
  const previousConnections = connections;
  const controlStart = Date.now();
  control.terminate();
  const released = await probeLocked(
    [],
    "control disconnect releases all files",
  );
  const controlMs = Date.now() - controlStart;
  assert.ok(
    controlMs < 5000,
    "control disconnect releases sources in five seconds",
  );
  for (const state of active) {
    state.pause = false;
    state.socket.resume();
  }
  await until(
    () => active.every((state) => state.closed),
    "all old data sockets closed",
  );
  await metrics("control-disconnected");
  await until(
    () =>
      connections > previousConnections &&
      control?.readyState === WebSocket.OPEN,
    "control reconnected",
    10000,
  );
  record("control-loss-closes-old-transfers-and-reconnects", {
    released_ms: controlMs,
    exclusive_probes: released,
    control_connections: connections,
  });

  const range = await complete({ range: "bytes=10-99", capture: true }, 206);
  assert.equal(range.bytes, 90);
  assert.equal(range.headers[0]["content-length"], "90");
  assert.equal(range.headers[0]["content-range"], "bytes 10-99/1073741824");
  assert.deepEqual(
    Buffer.concat(range.chunks),
    Buffer.from(Array.from({ length: 90 }, (_, i) => (i + 10) % 251)),
  );
  const head = await complete({ head: true });
  assert.equal(head.bytes, 0);
  assert.equal(head.headers[0]["content-length"], "1073741824");
  const headRange = await complete({ head: true, range: "bytes=10-99" }, 200);
  assert.equal(headRange.bytes, 0);
  assert.equal(headRange.headers[0]["content-length"], "1073741824");
  assert.equal(headRange.headers[0]["content-range"], undefined);
  await complete({ resource: "missing.mp4" }, 404);
  await complete({ range: "bytes=1073741824-" }, 416);
  await probeLocked([], "Range/HEAD/error source files released");
  record("reconnect-range-head-missing-and-invalid-range", {
    range_bytes: range.bytes,
    head_bytes: head.bytes,
  });

  const edited = offer({ resource: "edited.mp4", pause: true });
  await until(() => edited.bytes > 0, "in-place edit source streaming");
  await probeLocked(["edited.mp4"], "in-place edit source held");
  const oldEditVersion = edited.headers[0].source_version;
  const edit = await powershell("edit", {
    target: resolve(media, "edited.mp4"),
  });
  assert.equal(edit.restored_modified_exactly, true);
  assert.equal(edit.before_length, edit.after_length);
  const changedEdit = await complete(
    { resource: "edited.mp4", head: true, source_version: oldEditVersion },
    409,
  );
  assert.equal(changedEdit.headers[0].error, "source_changed");
  assert.equal(changedEdit.bytes, 0);
  edited.pause = false;
  edited.socket.resume();
  await until(
    () => edited.closed,
    "in-place edit truncates already-started response",
    15000,
  );
  assert.equal(
    edited.headers.length,
    1,
    "no second metadata after source edit",
  );
  assert.ok(edited.bytes < Number(edited.headers[0]["content-length"]));
  await probeLocked([], "in-place edited file released");
  const refreshedEdit = await complete({ resource: "edited.mp4", head: true });
  assert.notEqual(refreshedEdit.headers[0].source_version, oldEditVersion);
  record("same-size-restored-mtime-in-place-edit-detected", {
    ...edit,
    received_bytes: edited.bytes,
    declared_bytes: Number(edited.headers[0]["content-length"]),
    stale_status: 409,
    headers: edited.headers.length,
  });

  const beforeReplacement = await complete({
    resource: "replaced.mp4",
    head: true,
  });
  const oldReplaceVersion = beforeReplacement.headers[0].source_version;
  const replacement = await powershell("replace", {
    target: resolve(media, "replaced.mp4"),
  });
  assert.equal(replacement.restored_modified_exactly, true);
  assert.equal(replacement.before_length, replacement.after_length);
  const staleReplacement = await complete(
    { resource: "replaced.mp4", source_version: oldReplaceVersion },
    409,
  );
  assert.equal(staleReplacement.headers[0].error, "source_changed");
  assert.equal(staleReplacement.bytes, 0);
  const currentReplacement = await complete(
    { resource: "replaced.mp4", range: "bytes=10-99", capture: true },
    206,
  );
  assert.notEqual(
    currentReplacement.headers[0].source_version,
    oldReplaceVersion,
  );
  assert.deepEqual(
    Buffer.concat(currentReplacement.chunks),
    Buffer.from(Array.from({ length: 90 }, (_, i) => (i + 10) % 127)),
  );
  await probeLocked([], "replaced source released");
  record("same-size-restored-mtime-replacement-detected", {
    ...replacement,
    stale_status: 409,
    replacement_range_bytes: currentReplacement.bytes,
  });

  const shortened = offer({ resource: "shortened.mp4", pause: true });
  await until(() => shortened.bytes > 0, "truncate source streaming");
  await powershell("truncate", { target: resolve(media, "shortened.mp4") });
  shortened.pause = false;
  shortened.socket.resume();
  await until(() => shortened.closed, "truncated source closes", 15000);
  assert.equal(shortened.headers.length, 1);
  assert.ok(shortened.bytes < Number(shortened.headers[0]["content-length"]));
  await probeLocked([], "truncated source released");
  record("source-shortened-after-headers", {
    received_bytes: shortened.bytes,
    declared_bytes: Number(shortened.headers[0]["content-length"]),
  });

  for (let i = 0; i < 16; i++) offer({ hang: true });
  await delay(300);
  await complete({ head: true }, 503);
  await delay(10500);
  await complete({ head: true });
  await probeLocked([], "expired stalled handshakes retain no files");
  record("handshake-deadline-releases-admission-slots");

  const cycleEvidence = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const batch = files
      .slice(0, 16)
      .map((resource) => offer({ resource, pause: true }));
    await until(
      () =>
        batch.every(
          (state) => state.bytes > 0 && state.headers[0]?.status === 200,
        ),
      `cycle ${cycle} streams active`,
    );
    await probeLocked(files.slice(0, 16), `cycle ${cycle} handles held`);
    await metrics(`cycle-${cycle}-active`);
    const cancellationStart = Date.now();
    batch.forEach((state, i) => requestCancel(state, i % 2 === 1));
    const probes = await probeLocked([], `cycle ${cycle} all files released`);
    const releasedMs = Date.now() - cancellationStart;
    assert.ok(
      releasedMs < 5000,
      `cycle ${cycle} releases all sources within five seconds`,
    );
    cycleEvidence.push({
      cycle,
      released_ms: releasedMs,
      all_exclusive: probes.every((entry) => entry.exclusive),
    });
    await observeCancellation(batch);
    await metrics(`cycle-${cycle}-released`);
  }
  record("three-repeated-16-transfer-cancel-cycles", {
    cycles: 3,
    cycle_evidence: cycleEvidence,
  });
  await delay(500);
  await metrics("final-idle");
  const idle = report.memory_samples[0];
  const final = report.memory_samples.at(-1);
  report.memory_growth_bytes = {
    working_set: final.working_set_bytes - idle.working_set_bytes,
    private: final.private_bytes - idle.private_bytes,
  };
  assert.ok(
    final.private_bytes - idle.private_bytes < 64 * 1024 * 1024,
    "short-cycle retained private-memory growth below 64 MiB",
  );
  record("short-cycle-memory-growth-below-64mib", report.memory_growth_bytes);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  for (const peer of ws.clients) peer.terminate();
  for (const socket of raw) socket.destroy();
  if (agent && agent.exitCode === null) agent.kill();
  if (agentExit)
    report.process_exit = await Promise.race([
      agentExit,
      delay(5000).then(() => ({ timeout: true })),
    ]);
  if (report.process_exit?.timeout) {
    process.exitCode = 1;
    report.status = "failed";
    report.cleanup_failure = "Agent did not exit within five seconds";
  }
  await new Promise((r) => http.close(r));
  ws.close();
  try {
    assert.ok(
      media.startsWith(`${resolve(repo, ".runtime/agent-native")}\\`),
      "recursive cleanup stays inside the dedicated fixture directory",
    );
    await rm(media, { recursive: true, force: true });
    report.fixture_cleanup = "removed";
  } catch (error) {
    report.fixture_cleanup = String(error);
    report.status = "failed";
    process.exitCode = 1;
  }
  report.elapsed_ms = Date.now() - began;
  report.finished_at = new Date().toISOString();
  await writeFile(resolve(root, "agent.log"), logs);
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`Evidence: ${resolve(root, "report.json")}`);
  if (report.failure) console.error(report.failure);
}
