// Finite actual Server/Worker/NAS verification against a frozen native binding.
// Generated owned H264 + a legal MP4 free box; no seeded playback grant or build.
// Agent handoff reports, relay-received frames and HTTP bytes are distinct evidence.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { open, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const bindingFile =
  process.env.RAINSYNC_NAS_UPLINK_METRICS_BINDING_FILE ??
  process.env.RAINSYNC_RUNTIME_METRICS_BINDING_FILE ??
  process.env.W03_BACKEND_BINDING;
assert.ok(
  bindingFile,
  "Set a successful frozen native backend binding; this test never builds",
);
assert.ok(
  process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  "Use owned native PostgreSQL",
);
assert.ok(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "Use an external artifact directory",
);
assert.equal(
  process.platform,
  "linux",
  "Actual NAS descriptor witnesses require Linux",
);
const bindingBytes = await readFile(bindingFile),
  binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.ok(Array.isArray(binding.source) && binding.source.length > 0);
assert.ok(Array.isArray(binding.binaries) && binding.binaries.length > 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
for (const path of [
  "apps/server/src/agent_metrics.rs",
  "apps/server/src/agents.rs",
  "apps/nas-agent/src/main.rs",
  "apps/nas-agent/src/uplink_metrics.rs",
  "apps/nas-agent/src/uplink_reporter.rs",
  "apps/media-worker/src/relay.rs",
  "crates/media-core/src/runtime_metrics.rs",
  "crates/protocol/src/transport_metrics.rs",
])
  assert.ok(
    binding.source.some((item) => item.path === path),
    `Binding includes ${path}`,
  );
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
for (const name of [
  "rainsync-server",
  "rainsync-media-worker",
  "rainsync-nas-agent",
])
  assert.equal(
    resolve(
      binding.binaries.find((item) => item.name === name)?.path ?? "missing",
    ),
    resolve(target, name),
    `Binding identifies executed ${name}`,
  );
const coordinatorInputs = await Promise.all(
  [
    "tests/nas-uplink-metrics.mjs",
    "tests/fixtures/server.mjs",
    "tests/fixtures/media-stack.mjs",
    "tests/fixtures/postgres.mjs",
    "docs/TRANSPORT_METRICS_CONTRACT.md",
  ].map(async (path) => ({
    path,
    sha256: digest(await readFile(resolve(repo, path))),
  })),
);
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
async function verifyBinding() {
  assert.equal(
    digest(await readFile(bindingFile)),
    digest(bindingBytes),
    "Binding remained frozen",
  );
  for (const input of [...binding.source, ...coordinatorInputs])
    assert.equal(
      await hashFile(resolve(repo, input.path)),
      input.sha256,
      `Frozen input ${input.path}`,
    );
  for (const binary of binding.binaries)
    assert.equal(
      await hashFile(binary.path),
      binary.sha256,
      `Frozen binary ${binary.name}`,
    );
}
await verifyBinding();
const report = {
  schema_version: 1,
  result: "failed",
  started_at: new Date().toISOString(),
  checks: [],
  scope:
    "Finite owned PostgreSQL/Server/Worker/Agent, generated legal H264, transparent loopback WebSocket relay, public playback grants. Raw self-report fixtures are explicitly synthetic; no browser decode, production, installation or long-run acceptance.",
  binding: {
    file: resolve(bindingFile),
    sha256: digest(bindingBytes),
    source_digest: binding.source_digest,
    binaries: binding.binaries,
    coordinator_inputs: coordinatorInputs,
  },
};
const sockets = new Set(),
  requests = new Set();
let fixture, proxy, agent, agentDone, agentLog, workerPid, workerPort, failure;
let agentExit;
let captureFailure;
const prefix = "rainsync_agent_reported_nas_";
const bounds = [
  "0.01",
  "0.05",
  "0.1",
  "0.5",
  "1",
  "5",
  "30",
  "120",
  "600",
  "+Inf",
];
const outcomes = ["complete", "failed", "cancelled"];
const reasons = [
  "invalid",
  "stale",
  "rate_limited",
  "capacity",
  "unavailable",
  "unauthorized",
  "overflow",
];
const names = new Set(
  [
    "samples_total",
    "admissions_total",
    "measurements_dropped_total",
    "body_bytes_total",
    "transfer_bytes_total",
    "transfer_duration_seconds_bucket",
    "transfer_duration_seconds_count",
    "transfer_duration_seconds_sum",
    "dropped_total",
  ].map((name) => prefix + name),
);
function parseMetrics(text, processLabel) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^(\w+)(?:\{([^}]*)\})? ([^ ]+)$/.exec(line);
    assert.ok(match, `Valid exposition ${line}`);
    const labels = {};
    for (const label of match[2]?.split(",") ?? []) {
      const pair = /^(\w+)="([^"]*)"$/.exec(label);
      assert.ok(pair, "Simple fixed labels");
      assert.equal(labels[pair[1]], undefined, "No duplicate label");
      labels[pair[1]] = pair[2];
    }
    const value = Number(match[3]);
    assert.ok(
      Number.isFinite(value) && value >= 0,
      "Finite nonnegative exposition",
    );
    if (match[1].startsWith(prefix)) {
      assert.equal(
        processLabel,
        "server",
        "Self-report family never imported into Worker",
      );
      assert.ok(names.has(match[1]), "Closed NAS metric names");
      assert.equal(labels.process, "server");
      const expected = ["process"];
      if (match[1].includes("transfer_")) {
        expected.push("outcome");
        assert.ok(outcomes.includes(labels.outcome));
      }
      if (match[1].endsWith("_bucket")) {
        expected.push("le");
        assert.ok(bounds.includes(labels.le));
      }
      if (match[1] === prefix + "dropped_total") {
        expected.push("reason");
        assert.ok(reasons.includes(labels.reason));
      }
      assert.deepEqual(
        Object.keys(labels).sort(),
        expected.sort(),
        "No identity, credential or arbitrary NAS labels",
      );
      if (!match[1].endsWith("_sum")) assert.ok(Number.isSafeInteger(value));
    }
    if (match[1].startsWith("rainsync_transfer_"))
      assert.notEqual(
        labels.layer,
        "nas_uplink",
        "Agent reports never enter process-observed transfer namespace",
      );
    rows.push({ name: match[1], labels, value });
  }
  assert.equal(
    new Set(rows.map((row) => JSON.stringify([row.name, row.labels]))).size,
    rows.length,
  );
  assert.ok(
    rows.filter((row) => row.name.startsWith(prefix)).length <= 50,
    "Fixed NAS series bound",
  );
  for (const outcome of outcomes) {
    const ended = metric(rows, "transfer_duration_seconds_count", { outcome });
    if (!ended) continue;
    let previous = 0;
    for (const le of bounds) {
      const value = metric(rows, "transfer_duration_seconds_bucket", {
        outcome,
        le,
      });
      assert.ok(
        value >= previous && value <= ended,
        "Ordered bounded duration histogram",
      );
      previous = value;
    }
    assert.equal(
      previous,
      ended,
      "Infinite bucket equals terminal observations",
    );
  }
  return rows;
}
function value(rows, name, labels = {}) {
  return rows
    .filter(
      (row) =>
        row.name === name &&
        Object.entries(labels).every(([key, val]) => row.labels[key] === val),
    )
    .reduce((sum, row) => sum + row.value, 0);
}
const metric = (rows, name, labels) => value(rows, prefix + name, labels);
const credited = (rows) =>
  rows.filter(
    (row) =>
      row.name.startsWith(prefix) && row.name !== prefix + "dropped_total",
  );
const bodyCredit = (rows) =>
  credited(rows).filter((row) => row.name !== prefix + "samples_total");
async function until(probe, label, timeout = 10000, interval = 25) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(interval);
  }
  throw Error(`Deadline: ${label}`);
}
async function check(name, run) {
  const row = { name, result: "failed" },
    began = Date.now();
  report.checks.push(row);
  report.active_stage = {
    check: name,
    stage: "started",
    at: new Date().toISOString(),
  };
  try {
    Object.assign(row, await run(), { result: "passed" });
    console.log(`PASS: ${name}`);
  } catch (error) {
    row.error = error.stack ?? String(error);
    row.failed_stage = report.active_stage;
    const running = row.transfers?.find((entry) => entry.result === "running");
    if (running) running.result = "failed";
    if (captureFailure && !report.failure_snapshot) await captureFailure();
    throw error;
  } finally {
    row.elapsed_ms = Date.now() - began;
  }
}
function track(ws) {
  const record = { closed: false };
  sockets.add(ws);
  ws.on("error", () => {});
  ws.once("close", () => {
    record.closed = true;
    sockets.delete(ws);
  });
  return record;
}
async function connect(url, headers = {}) {
  const ws = new WebSocket(url, { headers, handshakeTimeout: 5000 });
  const record = track(ws),
    frames = [];
  ws.on("message", (bytes, binary) => {
    if (!binary) frames.push(JSON.parse(bytes));
  });
  await new Promise((done, reject) => {
    ws.once("open", done);
    ws.once("error", reject);
  });
  return {
    ws,
    frames,
    record,
    send: (packet) =>
      ws.send(typeof packet === "string" ? packet : JSON.stringify(packet)),
    next: (type) =>
      until(() => {
        const index = frames.findIndex((frame) => frame.type === type);
        return index < 0 ? null : frames.splice(index, 1)[0];
      }, `WebSocket ${type}`),
    async close() {
      if (ws.readyState < WebSocket.CLOSING) ws.close();
      await until(() => record.closed, "WebSocket closed");
    },
  };
}
async function makeProxy(f) {
  const http = createServer((_request, response) =>
    response.writeHead(404).end(),
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const connections = [],
    data = [];
  http.on("upgrade", (req, socket, head) => {
    const control = req.url === "/api/v1/agents/ws";
    if (!control && !req.url.startsWith("/agent-data/"))
      return socket.destroy();
    wss.handleUpgrade(req, socket, head, (peer) => {
      const observed = {
        control,
        ordinal: connections.length + 1,
        hellos: [],
        heartbeats: [],
        ready: [],
        heartbeat_received_at: [],
        ready_received_at: [],
        closed: false,
        peer_closed: false,
        upstream_closed: false,
      };
      connections.push(observed);
      track(peer);
      // The Agent may send a small body and Close before the upstream upgrade
      // finishes. Keep its reads paused from admission until both legs are OPEN
      // so that an early Close cannot discard queued metadata/body forwards.
      peer.pause();
      const upstream = new WebSocket(
        (control ? f.origin : f.workerOrigin).replace("http:", "ws:") + req.url,
        {
          headers: control ? { Authorization: req.headers.authorization } : {},
          handshakeTimeout: 5000,
        },
      );
      track(upstream);
      const offer = control
        ? null
        : {
            ordinal: data.length + 1,
            metadata: null,
            binary_frames: 0,
            binary_bytes_received: 0,
            bytes_forwarded_by_proxy: 0,
            closed: false,
          };
      if (offer) data.push(offer);
      // Public ws pause/resume keeps forwarding bounded during actual backpressure.
      const pending = [];
      peer.on("message", (bytes, binary) => {
        if (control && !binary) {
          const packet = JSON.parse(bytes);
          if (packet.type === "HELLO") observed.hellos.push(packet);
          if (packet.type === "HEARTBEAT") {
            observed.heartbeats.push(packet);
            observed.heartbeat_received_at.push(Date.now());
            if (packet.uplink_metrics) {
              assert.ok(
                observed.ready.length > 0,
                "Actual report follows Server READY",
              );
              assert.equal(
                packet.uplink_metrics.connection_id,
                observed.ready[0].connection_id,
              );
              assert.equal(packet.uplink_metrics.version, 1);
              assert.ok(
                bytes.length <= 4096,
                "Actual metrics heartbeat stays bounded",
              );
            }
          }
        } else if (offer) {
          if (binary) {
            offer.binary_frames++;
            offer.binary_bytes_received += bytes.length;
          } else offer.metadata = JSON.parse(bytes);
        }
        peer.pause();
        const forward = () =>
          upstream.send(bytes, { binary }, (error) => {
            if (!error && binary && offer)
              offer.bytes_forwarded_by_proxy += bytes.length;
            if (error) peer.close();
            else peer.resume();
          });
        if (upstream.readyState === WebSocket.OPEN) forward();
        else pending.push(forward);
      });
      upstream.on("open", () => {
        for (const forward of pending.splice(0)) forward();
        if (pending.length === 0) peer.resume();
      });
      upstream.on("message", (bytes, binary) => {
        if (control && !binary) {
          const packet = JSON.parse(bytes);
          if (packet.type === "NAS_METRICS_READY") {
            observed.ready.push(packet);
            observed.ready_received_at.push(Date.now());
          }
        }
        if (peer.readyState !== WebSocket.OPEN) return;
        upstream.pause();
        peer.send(bytes, { binary }, (error) => {
          if (error) upstream.close();
          else upstream.resume();
        });
      });
      peer.on("ping", (bytes) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.ping(bytes);
      });
      upstream.on("ping", (bytes) => {
        if (peer.readyState === WebSocket.OPEN) peer.ping(bytes);
      });
      peer.once("close", () => {
        observed.peer_closed = true;
        if (upstream.readyState < WebSocket.CLOSING) upstream.close();
      });
      upstream.once("close", () => {
        observed.upstream_closed = true;
        if (offer) offer.closed = true;
        if (peer.readyState < WebSocket.CLOSING) peer.close();
      });
      upstream.on("error", () => {
        if (peer.readyState < WebSocket.CLOSING) peer.close();
      });
      observed.close = () => {
        peer.close();
        upstream.close();
      };
      observed.done = () => observed.peer_closed && observed.upstream_closed;
      observed.snapshot = () => ({
        control,
        ordinal: observed.ordinal,
        peer_state: peer.readyState,
        upstream_state: upstream.readyState,
        peer_paused: peer.isPaused,
        upstream_paused: upstream.isPaused,
        peer_closed: observed.peer_closed,
        upstream_closed: observed.upstream_closed,
        hello_count: observed.hellos.length,
        ready_count: observed.ready.length,
        heartbeat_count: observed.heartbeats.length,
        last_sample: observed.heartbeats.at(-1)?.uplink_metrics,
      });
    });
  });
  await new Promise((done, reject) =>
    http.once("error", reject).listen(0, "127.0.0.1", done),
  );
  const port = http.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    connections,
    data,
    controls: () => connections.filter((entry) => entry.control),
    async close() {
      for (const entry of connections) entry.close();
      await until(
        () => connections.every((entry) => entry.done()),
        "All proxy WebSocket peers closed",
      );
      await new Promise((done) => wss.close(done));
      http.closeAllConnections();
      await new Promise((done) => http.close(done));
      assert.equal(await verifyClosedPort(port), true);
    },
  };
}
function emptyOutcome() {
  return {
    transfers: 0,
    bytes: 0,
    duration_us: 0,
    duration_buckets: Array(9).fill(0),
  };
}
function zeroTotals() {
  return {
    admitted: 0,
    dropped: 0,
    active: 0,
    body_seen: false,
    body_bytes: 0,
    complete: emptyOutcome(),
    failed: emptyOutcome(),
    cancelled: emptyOutcome(),
  };
}
function completedTotals(bytes, transfers = 1) {
  return {
    ...zeroTotals(),
    admitted: transfers,
    body_seen: true,
    body_bytes: bytes,
    complete: {
      transfers,
      bytes,
      duration_us: transfers * 1000,
      duration_buckets: Array(9).fill(transfers),
    },
  };
}
const packet = (connection, seq, totals) => ({
  type: "HEARTBEAT",
  uplink_metrics: {
    version: 1,
    connection_id: connection,
    seq,
    totals,
  },
});
async function lock(f, statement) {
  const marker = `nas_metrics_lock_${randomUUID().replaceAll("-", "")}`;
  const child = f.sqlProcess(undefined, { interactive: true });
  let output = "";
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  const query = async (statement, timeout = 250) => {
    const complete = `nas_metrics_step_${randomUUID().replaceAll("-", "")}`;
    const start = output.length;
    child.stdin.write(
      `SELECT pg_stat_clear_snapshot(); ${statement}; SELECT ${quote(complete)};\n`,
    );
    await until(
      () => output.slice(start).includes(complete),
      "Owned lock session statement",
      timeout,
      5,
    );
    return output.slice(start).split(complete)[0].trim().split("\n").at(-1);
  };
  await query(
    `BEGIN; SET application_name=${quote(marker)}; ${statement}`,
    10000,
  );
  return {
    marker,
    query,
    async finish(commit = true) {
      if (child.exitCode !== null) return child.done;
      child.stdin.end(`${commit ? "COMMIT" : "ROLLBACK"};\n`);
      await child.done;
    },
  };
}

try {
  await isolatedMediaStack("nas-uplink-metrics", async (f) => {
    fixture = f;
    report.fixture = { id: f.id, root: f.root };
    captureFailure = async () => {
      report.failure_snapshot = {
        captured_before_fixture_unwind: true,
        captured_at: new Date().toISOString(),
        stage: report.active_stage,
        proxy_connections:
          proxy?.connections.map((entry) => entry.snapshot()) ?? [],
        proxy_data:
          proxy?.data.map((entry) => ({
            ordinal: entry.ordinal,
            metadata_status: entry.metadata?.status,
            declared_bytes: entry.metadata?.["content-length"],
            binary_frames: entry.binary_frames,
            binary_bytes_received: entry.binary_bytes_received,
            bytes_forwarded_by_proxy: entry.bytes_forwarded_by_proxy,
            closed: entry.closed,
          })) ?? [],
      };
      try {
        report.failure_snapshot.transfer_ledger = JSON.parse(
          f
            .sql(
              "SET statement_timeout='500ms'; SELECT COALESCE(json_agg(json_build_object('id',id,'head',head,'status',status,'dispatched',dispatched_at IS NOT NULL,'agent_drained',agent_drained_at IS NOT NULL) ORDER BY id),'[]'::json) FROM agent_transfer_runs",
            )
            .split("\n")
            .at(-1),
        );
      } catch (error) {
        report.failure_snapshot.ledger_unavailable = error.name ?? "Error";
      }
    };
    const admin = f.client();
    await admin.login();
    const clipPath = await f.makeClip("owned-uplink.mp4", {
      pictureSeconds: 2,
    });
    const clip = await readFile(clipPath),
      paddedPath = resolve(f.root, "owned-uplink-padded.mp4");
    const paddingBytes = 32 * 1024 * 1024;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(paddingBytes + 8);
    header.write("free", 4, "ascii");
    await writeFile(paddedPath, clip);
    const padded = await open(paddedPath, "a");
    try {
      await padded.write(header);
      await padded.write(Buffer.alloc(paddingBytes));
    } finally {
      await padded.close();
    }
    const paddedLength = clip.length + paddingBytes + 8;
    report.media = {
      generated_owned_h264: true,
      clip_bytes: clip.length,
      clip_sha256: digest(clip),
      padded_bytes: paddedLength,
      mp4_free_box_bytes: paddingBytes + 8,
    };
    await f.startWorker();
    workerPid = f.workerPid;
    workerPort = Number(new URL(f.workerOrigin).port);
    await f.startServer({ WORKER_URL: f.workerOrigin });
    const scrape = async (processLabel = "server", client = admin) => {
      const response = await fetch(
        processLabel === "worker"
          ? f.workerOrigin + "/metrics"
          : f.origin + "/api/v1/metrics",
        {
          headers: { Cookie: client.cookie },
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(
        response.headers.get("content-type"),
        /text\/plain; version=0\.0\.4/,
      );
      const rows = parseMetrics(await response.text(), processLabel);
      (report.latest_scrapes ??= {})[processLabel] = rows;
      return rows;
    };
    await check("admin-gated metrics omit unobserved NAS reports", async () => {
      for (const origin of [
        f.origin + "/api/v1/metrics",
        f.workerOrigin + "/metrics",
      ])
        for (const headers of [
          {},
          { Authorization: "Bearer isolated-fixture" },
        ]) {
          const denied = await fetch(origin, {
            headers,
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(denied.status, 401);
          assert.equal(denied.headers.get("cache-control"), "no-store");
          assert.ok(!(await denied.text()).includes(prefix));
        }
      const username = `uplink-viewer-${randomUUID().slice(0, 8)}`;
      await admin.request("/users", "POST", { username, password: f.password });
      const viewer = f.client();
      await viewer.login(username);
      for (const origin of [
        f.origin + "/api/v1/metrics",
        f.workerOrigin + "/metrics",
      ]) {
        const denied = await fetch(origin, {
          headers: { Cookie: viewer.cookie },
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(denied.status, 403);
        assert.ok(!(await denied.text()).includes(prefix));
      }
      assert.equal(credited(await scrape()).length, 0);
      assert.equal(credited(await scrape("worker")).length, 0);
      return {
        unauthenticated: 401,
        ordinary_user: 403,
        absent_report_series: true,
      };
    });
    await check(
      "synthetic unchanged nonzero baseline contributes no body family",
      async () => {
        const owner = await admin.request("/agents", "POST", {
          name: "synthetic prefix-only owner",
        });
        const identity = await admin.request("/agents/pair", "POST", {
          code: owner.pair_code,
        });
        const peer = await connect(
          f.origin.replace("http:", "ws:") + "/api/v1/agents/ws",
          { Authorization: `Bearer ${identity.token}` },
        );
        const baseline = completedTotals(100);
        peer.send({
          type: "HELLO",
          uplink_metrics_version: 1,
          uplink_metrics_baseline: baseline,
        });
        const ready = await peer.next("NAS_METRICS_READY");
        await delay(1050);
        const before = await scrape();
        peer.send(packet(ready.connection_id, 1, baseline));
        const after = await until(async () => {
          const rows = await scrape();
          return metric(rows, "samples_total") ===
            metric(before, "samples_total") + 1
            ? rows
            : null;
        }, "Unchanged baseline report received");
        assert.ok(
          !after.some((row) => row.name === prefix + "body_bytes_total"),
          "Unobserved live bytes remain absent",
        );
        assert.equal(metric(after, "admissions_total"), 0);
        assert.equal(metric(after, "transfer_duration_seconds_count"), 0);
        await peer.close();
        return {
          synthetic: true,
          uncredited_prefix: 100,
          accepted_sample_delta: 1,
          body_bytes_family_absent: true,
        };
      },
    );
    proxy = await makeProxy(f);
    const owner = await admin.request("/agents", "POST", {
      name: "owned measured NAS",
    });
    const paired = await admin.request("/agents/pair", "POST", {
      code: owner.pair_code,
    });
    agentLog = createWriteStream(resolve(f.root, "measured-agent.log"));
    agent = spawn(resolve(f.target, "rainsync-nas-agent"), [], {
      env: {
        ...f.env,
        SERVER_URL: proxy.origin,
        AGENT_DATA_ORIGIN: proxy.origin,
        AGENT_TOKEN: paired.token,
        AGENT_CREDENTIAL_FILE: resolve(f.root, "agent-token"),
        MEDIA_ROOT: f.root,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    agent.stdout.pipe(agentLog, { end: false });
    agent.stderr.pipe(agentLog, { end: false });
    agentDone = new Promise((done, reject) => {
      agent.once("error", reject);
      agent.once("close", (code, signal) => {
        agentExit = { code, signal };
        done(agentExit);
      });
    });
    agentDone.catch(() => {});
    report.agent_pid = agent.pid;
    await until(
      () =>
        f.sql(
          `SELECT count(*) FROM media_items WHERE source_id=${quote(owner.id)} AND resource IN ('owned-uplink.mp4','owned-uplink-padded.mp4') AND source_version IS NOT NULL`,
        ) === "2",
      "Actual Agent versioned index",
    );
    const control = await until(
      () =>
        proxy
          .controls()
          .find(
            (entry) =>
              entry.ready.length &&
              entry.heartbeats.some((h) => h.uplink_metrics),
          ),
      "Actual Agent READY and ordinary heartbeat",
      12000,
    );
    assert.equal(control.hellos[0].uplink_metrics_version, 1);
    assert.deepEqual(control.hellos[0].uplink_metrics_baseline, zeroTotals());
    const actualHeartbeat = async (predicate) =>
      until(
        () => {
          const last = proxy
            .controls()
            .at(-1)
            ?.heartbeats.at(-1)?.uplink_metrics;
          return last && predicate(last) ? last : null;
        },
        "Actual cumulative Agent heartbeat",
        12000,
      );
    const awaitCredit = async (sample, before, expectedBytes) =>
      until(async () => {
        const rows = await scrape();
        return metric(rows, "body_bytes_total") -
          metric(before, "body_bytes_total") ===
          expectedBytes
          ? rows
          : null;
      }, `Server aggregate catches actual Agent seq ${sample.seq}`);
    const media = (await admin.request("/media")).filter(
      (item) =>
        f.sql(
          `SELECT source_id FROM media_items WHERE id=${quote(item.id)}`,
        ) === owner.id,
    );
    const makePlan = async (resource) => {
      const selected = media.find(
        (item) =>
          f.sql(
            `SELECT resource FROM media_items WHERE id=${quote(item.id)}`,
          ) === resource,
      );
      assert.ok(selected, "Actual indexed Agent media");
      const room = await admin.request("/rooms", "POST", {
        name: `NAS measured ${resource}`,
      });
      const peer = await connect(
        f.origin.replace("http:", "ws:") + "/api/v1/ws",
        { Origin: f.origin, Cookie: admin.cookie },
      );
      peer.send({ type: "JOIN", room_id: room.id });
      const snapshot = await peer.next("SNAPSHOT");
      const command = {
        protocol_version: 1,
        room_id: room.id,
        command_id: randomUUID(),
        control_epoch: snapshot.control_epoch.id,
        expected_revision: snapshot.state.revision,
        media_generation: snapshot.state.media_generation,
        type: "CHANGE_MEDIA",
        payload: { media_id: selected.id },
      };
      peer.send(command);
      const ack = await peer.next("ACK");
      assert.equal(ack.command_id, command.command_id);
      const plan = await admin.request("/playback-sessions", "POST", {
        room_id: room.id,
        media_generation: ack.state.media_generation,
        mode: "direct",
        position_ms: 0,
        idempotency_key: randomUUID(),
      });
      const url = new URL(plan.playback_url, f.workerOrigin);
      assert.equal(plan.delivery_mode, "direct");
      return {
        room,
        peer,
        plan,
        url: f.workerOrigin + url.pathname + url.search,
      };
    };
    const normal = await makePlan("owned-uplink.mp4");
    const lastActual = () =>
      proxy.controls().at(-1).heartbeats.at(-1).uplink_metrics;
    const drainSince = async (ids) => {
      await until(
        () =>
          f.sql(
            `SELECT count(*) FROM agent_transfer_runs WHERE agent_id=${quote(owner.id)} AND dispatched_at IS NOT NULL AND agent_drained_at IS NULL`,
          ) === "0",
        "Actual independent NAS disposal receipts",
        12000,
      );
      return f.sql(
        `SELECT COALESCE(json_agg(json_build_object('id',id,'head',head,'status',status,'agent_drained',agent_drained_at IS NOT NULL) ORDER BY id),'[]'::json) FROM agent_transfer_runs WHERE agent_id=${quote(owner.id)}${ids.length ? ` AND id NOT IN (${ids.map(quote).join(",")})` : ""}`,
      );
    };
    const knownTransfers = () =>
      JSON.parse(
        f.sql(
          `SELECT COALESCE(json_agg(id),'[]'::json) FROM agent_transfer_runs WHERE agent_id=${quote(owner.id)}`,
        ),
      );
    await drainSince([]);
    const preparationSequence = lastActual().seq;
    const settledSample = await actualHeartbeat(
      (sample) =>
        sample.seq > preparationSequence && sample.totals.active === 0,
    );
    await until(
      async () =>
        metric(await scrape(), "body_bytes_total") ===
        settledSample.totals.body_bytes,
      "Preparation baseline measured",
    );
    await check(
      "real full and Range bodies finish at exact Binary handoff length",
      async () => {
        const results = [];
        report.checks.at(-1).transfers = results;
        for (const range of [null, "bytes=17-143"]) {
          const subcase = { range, result: "running" };
          results.push(subcase);
          const stage = (name) => {
            subcase.stage = name;
            report.active_stage = {
              check: "full_and_range",
              range,
              stage: name,
              at: new Date().toISOString(),
            };
          };
          stage("before_scrapes");
          const before = await scrape(),
            workerBefore = await scrape("worker"),
            sampleBefore = lastActual(),
            dataStart = proxy.data.length,
            ids = knownTransfers();
          stage("waiting_http_headers");
          const response = await fetch(normal.url, {
            headers: range ? { Range: range } : {},
            signal: AbortSignal.timeout(15000),
          });
          stage("http_headers_received");
          subcase.http_status = response.status;
          assert.equal(response.status, range ? 206 : 200);
          const expected = range ? clip.subarray(17, 144) : clip;
          assert.equal(
            Number(response.headers.get("content-length")),
            expected.length,
          );
          if (range)
            assert.equal(
              response.headers.get("content-range"),
              `bytes 17-143/${clip.length}`,
            );
          assert.deepEqual(
            Buffer.from(await response.arrayBuffer()),
            expected,
            "Downloaded bytes match owned source exactly",
          );
          subcase.downloaded_bytes = expected.length;
          stage("waiting_actual_heartbeat");
          const sample = await actualHeartbeat(
            (s) =>
              s.seq > sampleBefore.seq &&
              s.totals.complete.transfers ===
                sampleBefore.totals.complete.transfers + 1 &&
              s.totals.active === 0,
          );
          assert.equal(
            sample.totals.body_bytes - sampleBefore.totals.body_bytes,
            expected.length,
          );
          assert.equal(
            sample.totals.complete.bytes - sampleBefore.totals.complete.bytes,
            expected.length,
          );
          stage("waiting_server_credit");
          const after = await awaitCredit(sample, before, expected.length),
            workerAfter = await scrape("worker");
          assert.equal(
            metric(after, "transfer_bytes_total", { outcome: "complete" }) -
              metric(before, "transfer_bytes_total", { outcome: "complete" }),
            expected.length,
          );
          assert.equal(
            metric(after, "transfer_duration_seconds_count", {
              outcome: "complete",
            }) -
              metric(before, "transfer_duration_seconds_count", {
                outcome: "complete",
              }),
            1,
          );
          assert.equal(
            value(workerAfter, "rainsync_transfer_body_bytes_total", {
              layer: "worker_egress",
            }) -
              value(workerBefore, "rainsync_transfer_body_bytes_total", {
                layer: "worker_egress",
              }),
            expected.length,
          );
          const offered = proxy.data.slice(dataStart);
          assert.equal(offered.length, 1);
          assert.equal(offered[0].binary_bytes_received, expected.length);
          assert.equal(offered[0].bytes_forwarded_by_proxy, expected.length);
          assert.equal(
            Number(offered[0].metadata["content-length"]),
            expected.length,
          );
          Object.assign(subcase, {
            relay_received_binary_bytes: offered[0].binary_bytes_received,
            agent_reported_successful_binary_handoff_bytes: expected.length,
          });
          stage("waiting_independent_drain_receipts");
          subcase.drain_receipts = JSON.parse(await drainSince(ids));
          subcase.result = "passed";
          stage("passed");
        }
        return { transfers: results };
      },
    );
    await check(
      "real HEAD and rejected Range never create NAS body observations",
      async () => {
        const before = await scrape(),
          sampleBefore = lastActual(),
          dataStart = proxy.data.length,
          ids = knownTransfers();
        const head = await fetch(normal.url, {
          method: "HEAD",
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(head.status, 200);
        assert.equal(Number(head.headers.get("content-length")), clip.length);
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        const rejected = await fetch(normal.url, {
          headers: { Range: `bytes=${clip.length + 1}-` },
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(rejected.status, 416);
        await rejected.arrayBuffer();
        const sample = await actualHeartbeat((s) => s.seq > sampleBefore.seq);
        assert.deepEqual(sample.totals, sampleBefore.totals);
        const after = await until(async () => {
          const rows = await scrape();
          return metric(rows, "samples_total") > metric(before, "samples_total")
            ? rows
            : null;
        }, "HEAD/rejection heartbeat received");
        assert.deepEqual(bodyCredit(after), bodyCredit(before));
        const offered = proxy.data.slice(dataStart);
        assert.equal(offered.length, 2);
        assert.ok(offered.every((row) => row.binary_frames === 0));
        return {
          head_status: 200,
          rejected_status: 416,
          binary_frames: 0,
          body_observation_delta: 0,
          drain_receipts: JSON.parse(await drainSince(ids)),
        };
      },
    );
    const large = await makePlan("owned-uplink-padded.mp4");
    await drainSince([]);
    const paddedPreparationSequence = lastActual().seq;
    const preparation = await actualHeartbeat(
      (s) => s.seq > paddedPreparationSequence && s.totals.active === 0,
    );
    await until(
      async () =>
        metric(await scrape(), "body_bytes_total") ===
        preparation.totals.body_bytes,
      "Padded preparation baseline credited",
    );
    await check(
      "midbody HTTP cancellation preserves partial handoff and independent file-drain proof",
      async () => {
        const before = await scrape(),
          sampleBefore = lastActual(),
          dataStart = proxy.data.length,
          ids = knownTransfers();
        let response;
        const req = request(large.url, (res) => {
          response = res;
          res.on("error", () => {});
          res.pause();
        });
        requests.add(req);
        req.on("error", () => {});
        req.once("close", () => requests.delete(req));
        req.end();
        await until(() => response, "Paused owned HTTP response");
        assert.equal(response.statusCode, 200);
        assert.equal(Number(response.headers["content-length"]), paddedLength);
        const openFiles = async () => {
          let count = 0;
          for (const fd of await readdir(`/proc/${agent.pid}/fd`)) {
            try {
              if (
                (await readlink(`/proc/${agent.pid}/fd/${fd}`)) === paddedPath
              )
                count++;
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          return count;
        };
        await until(
          async () => (await openFiles()) > 0,
          "Agent retains actual source descriptor",
        );
        const held = await actualHeartbeat(
          (s) =>
            s.seq > sampleBefore.seq &&
            s.totals.active === 1 &&
            s.totals.body_bytes > sampleBefore.totals.body_bytes,
        );
        assert.ok(
          held.totals.body_bytes - sampleBefore.totals.body_bytes <
            paddedLength,
          "Paused transfer remains partial",
        );
        const liveIds = knownTransfers().filter((id) => !ids.includes(id));
        assert.equal(liveIds.length, 1);
        assert.equal(
          f.sql(
            `SELECT agent_drained_at IS NULL FROM agent_transfer_runs WHERE id=${quote(liveIds[0])}`,
          ),
          "t",
          "Byte observation is not disposal receipt",
        );
        req.destroy();
        response.destroy();
        await until(
          async () => (await openFiles()) === 0,
          "Cancelled Agent descriptor released",
        );
        const terminal = await actualHeartbeat(
          (s) =>
            s.seq > held.seq &&
            s.totals.active === 0 &&
            s.totals.cancelled.transfers ===
              sampleBefore.totals.cancelled.transfers + 1,
        );
        const handed =
          terminal.totals.body_bytes - sampleBefore.totals.body_bytes;
        assert.ok(handed > 0 && handed < paddedLength);
        assert.equal(
          terminal.totals.cancelled.bytes - sampleBefore.totals.cancelled.bytes,
          handed,
        );
        const after = await awaitCredit(terminal, before, handed);
        assert.equal(
          metric(after, "transfer_bytes_total", { outcome: "cancelled" }) -
            metric(before, "transfer_bytes_total", { outcome: "cancelled" }),
          handed,
        );
        assert.equal(
          metric(after, "transfer_duration_seconds_count", {
            outcome: "cancelled",
          }) -
            metric(before, "transfer_duration_seconds_count", {
              outcome: "cancelled",
            }),
          1,
        );
        assert.equal(
          metric(after, "transfer_duration_seconds_count", {
            outcome: "complete",
          }),
          metric(before, "transfer_duration_seconds_count", {
            outcome: "complete",
          }),
        );
        const offered = proxy.data.slice(dataStart);
        assert.equal(offered.length, 1);
        assert.ok(
          offered[0].binary_bytes_received > 0 &&
            offered[0].binary_bytes_received <= handed,
          "Proxy-received frames cannot exceed Agent-reported successful handoffs",
        );
        const receipts = JSON.parse(await drainSince(ids));
        assert.equal(receipts[0].agent_drained, true);
        return {
          declared_bytes: paddedLength,
          agent_reported_successful_binary_handoff_bytes: handed,
          relay_received_binary_bytes: offered[0].binary_bytes_received,
          held_active: 1,
          terminal: "cancelled",
          descriptor_released: true,
          drain_receipts: receipts,
        };
      },
    );
    await check(
      "actual control reconnect baselines old cumulative prefix without recounting",
      async () => {
        const before = await scrape(),
          old = proxy.controls().at(-1),
          sampleBefore = lastActual();
        assert.equal(sampleBefore.totals.active, 0);
        old.close();
        const fresh = await until(
          () =>
            proxy
              .controls()
              .find(
                (entry) =>
                  entry.ordinal > old.ordinal &&
                  entry.ready.length &&
                  entry.heartbeats.some((h) => h.uplink_metrics),
              ),
          "Actual Agent reconnect negotiation",
          15000,
        );
        assert.deepEqual(
          fresh.hellos[0].uplink_metrics_baseline,
          sampleBefore.totals,
        );
        const first = fresh.heartbeats.find(
          (h) => h.uplink_metrics,
        ).uplink_metrics;
        assert.equal(first.seq, 1);
        assert.notEqual(first.connection_id, sampleBefore.connection_id);
        assert.equal(first.connection_id, fresh.ready[0].connection_id);
        assert.deepEqual(first.totals, sampleBefore.totals);
        const after = await until(async () => {
          const rows = await scrape();
          return metric(rows, "samples_total") > metric(before, "samples_total")
            ? rows
            : null;
        }, "Reconnect report aggregated");
        assert.deepEqual(bodyCredit(after), bodyCredit(before));
        return {
          new_sequence: 1,
          frozen_prefix_bytes: first.totals.body_bytes,
          credited_prefix_bytes: 0,
        };
      },
    );
    agent.kill("SIGTERM");
    await until(() => agentExit, "Actual Agent graceful process exit", 15000);
    const stopped = await agentDone;
    assert.equal(stopped.code, 0);
    assert.equal(stopped.signal, null);
    report.agent_exit = stopped;
    await drainSince([]);
    for (const room of [normal, large]) {
      const view = await admin.request(`/rooms/${room.room.id}/lifecycle`);
      await admin.request(`/rooms/${room.room.id}/close`, "POST", {
        expected_revision: view.state.revision,
      });
      await f.waitForSql(
        `SELECT lifecycle FROM rooms WHERE id=${quote(room.room.id)}`,
        "closed",
        12000,
      );
      await room.peer.close();
    }
    report.actual_agent_control = proxy.controls().map((entry) => ({
      ordinal: entry.ordinal,
      hello_baseline: entry.hellos[0]?.uplink_metrics_baseline,
      ready: entry.ready,
      heartbeat_received_at: entry.heartbeat_received_at,
      ready_received_at: entry.ready_received_at,
      samples: entry.heartbeats
        .filter((h) => h.uplink_metrics)
        .map((h) => h.uplink_metrics),
    }));
    report.actual_relay_data = proxy.data;
    report.actual_measured_server = credited(await scrape());
    assert.equal(credited(await scrape("worker")).length, 0);

    // From here totals are intentionally fabricated, testing untrusted receipt
    // aggregation/fencing only; these are never described as measured I/O.
    const pair = async (name) => {
      const created = await admin.request("/agents", "POST", { name });
      return {
        id: created.id,
        ...(await admin.request("/agents/pair", "POST", {
          code: created.pair_code,
        })),
      };
    };
    const raw = async (
      identity,
      baseline = zeroTotals(),
      path = "/api/v1/agents/ws",
    ) => {
      const peer = await connect(f.origin.replace("http:", "ws:") + path, {
        Authorization: `Bearer ${identity.token}`,
      });
      if (path.endsWith("/ws")) {
        peer.send({
          type: "HELLO",
          uplink_metrics_version: 1,
          uplink_metrics_baseline: baseline,
        });
        const ready = await peer.next("NAS_METRICS_READY");
        assert.equal(ready.version, 1);
        assert.match(ready.connection_id, /^[a-f\d-]{36}$/);
        assert.notEqual(
          ready.connection_id,
          "00000000-0000-0000-0000-000000000000",
        );
        peer.connection = ready.connection_id;
      }
      return peer;
    };
    const stable = async (before, duration = 200) => {
      const deadline = Date.now() + duration;
      do {
        assert.deepEqual(
          credited(await scrape()),
          credited(before),
          "No accepted aggregate mutation",
        );
        await delay(25);
      } while (Date.now() < deadline);
    };
    const accept = async (peer, seq, totals, expectedBytes) => {
      await delay(1050);
      const before = await scrape();
      peer.send(packet(peer.connection, seq, totals));
      const after = await until(async () => {
        const rows = await scrape();
        return metric(rows, "samples_total") ===
          metric(before, "samples_total") + 1
          ? rows
          : null;
      }, "Synthetic report accepted");
      assert.equal(
        metric(after, "body_bytes_total") - metric(before, "body_bytes_total"),
        expectedBytes,
      );
      return after;
    };
    await check(
      "synthetic baseline, exact replay, conflicts, regressions and gap catch-up",
      async () => {
        const identity = await pair("synthetic cumulative owner"),
          before = await scrape();
        const peer = await raw(identity, completedTotals(100));
        await stable(before);
        let after = await accept(peer, 1, completedTotals(107, 2), 7);
        peer.send(packet(peer.connection, 1, completedTotals(107, 2)));
        await stable(after, 1100);
        peer.send(packet(peer.connection, 1, completedTotals(108, 2)));
        await stable(after, 1100);
        peer.send(packet(peer.connection, 2, completedTotals(106, 2)));
        await stable(after, 1100);
        after = await accept(peer, 4, completedTotals(120, 3), 13);
        const previous = peer.connection;
        await peer.close();
        const reconnected = await raw(identity, completedTotals(125, 4));
        await stable(after);
        assert.notEqual(reconnected.connection, previous);
        reconnected.send(packet(previous, 1, completedTotals(130, 5)));
        await stable(after, 1100);
        await accept(reconnected, 1, completedTotals(130, 5), 5);
        await reconnected.close();
        return {
          synthetic: true,
          uncredited_initial_prefix: 100,
          accepted_deltas: [7, 13, 5],
          exact_replay_credit: 0,
          conflicting_replay_credit: 0,
          regression_credit: 0,
          reconnect_uncredited_unsent_tail: 5,
          old_connection_id_credit: 0,
        };
      },
    );
    await check(
      "synthetic malformed and unnegotiated reports cannot consume an accepted cursor",
      async () => {
        const identity = await pair("synthetic strict owner"),
          peer = await raw(identity),
          before = await scrape();
        const good = packet(peer.connection, 1, completedTotals(9));
        const malformed = [
          {
            name: "unknown nested field",
            packet: {
              ...good,
              uplink_metrics: { ...good.uplink_metrics, agent_id: identity.id },
            },
          },
          {
            name: "zero sequence",
            packet: {
              ...good,
              uplink_metrics: { ...good.uplink_metrics, seq: 0 },
            },
          },
          {
            name: "counter outside exact integer bound",
            packet: {
              ...good,
              uplink_metrics: {
                ...good.uplink_metrics,
                totals: {
                  ...good.uplink_metrics.totals,
                  body_bytes: 9007199254740992,
                },
              },
            },
          },
          {
            name: "bad histogram order",
            packet: {
              ...good,
              uplink_metrics: {
                ...good.uplink_metrics,
                totals: {
                  ...good.uplink_metrics.totals,
                  complete: {
                    ...good.uplink_metrics.totals.complete,
                    duration_buckets: [1, 0, 1, 1, 1, 1, 1, 1, 1],
                  },
                },
              },
            },
          },
          {
            name: "duplicate nested sequence",
            packet: JSON.stringify(good).replace('"seq":1', '"seq":1,"seq":1'),
          },
          {
            name: "overlong envelope",
            packet:
              JSON.stringify(good).slice(0, -1) +
              ',"padding":"' +
              "x".repeat(4096) +
              '"}',
          },
        ];
        for (const item of malformed) {
          await delay(1050);
          peer.send(item.packet);
          await stable(before);
        }
        await accept(peer, 1, completedTotals(9), 9);
        await peer.close();
        const unnegotiated = await connect(
          f.origin.replace("http:", "ws:") + "/api/v1/agents/ws",
          { Authorization: `Bearer ${identity.token}` },
        );
        const unnegotiatedBefore = await scrape();
        unnegotiated.send({ type: "HELLO" });
        unnegotiated.send(packet(randomUUID(), 1, completedTotals(10)));
        await stable(unnegotiatedBefore, 1100);
        assert.ok(
          !unnegotiated.frames.some(
            (frame) => frame.type === "NAS_METRICS_READY",
          ),
        );
        await unnegotiated.close();
        const drain = await raw(
            identity,
            zeroTotals(),
            "/api/v1/agents/drain-ws",
          ),
          drainBefore = await scrape();
        drain.send(packet(randomUUID(), 1, completedTotals(12)));
        await until(
          () => drain.record.closed,
          "Receipt-only route rejects heartbeat",
        );
        await stable(drainBefore);
        return {
          synthetic: true,
          rejected_shapes: malformed.map((item) => item.name),
          valid_same_sequence_after_rejections: 1,
          unnegotiated_credit: 0,
          receipt_only_credit: 0,
        };
      },
    );
    await check(
      "synthetic receipt rate is bounded while later cumulative data recovers",
      async () => {
        const identity = await pair("synthetic rate owner"),
          peer = await raw(identity);
        const after = await accept(peer, 1, completedTotals(1), 1);
        // Give the completed socket-owned task a chance to leave its one pending
        // slot, then span a short burst so capacity loss cannot hide rate loss.
        await delay(80);
        for (let seq = 2; seq <= 10; seq++) {
          peer.send(packet(peer.connection, seq, completedTotals(seq, seq)));
          await delay(15);
        }
        await stable(after, 500);
        assert.ok(
          metric(await scrape(), "dropped_total", { reason: "rate_limited" }) >
            metric(after, "dropped_total", { reason: "rate_limited" }),
        );
        await accept(peer, 11, completedTotals(11, 11), 10);
        await peer.close();
        return {
          synthetic: true,
          rapid_burst_packets: 9,
          burst_credit: 0,
          later_cumulative_delta: 10,
        };
      },
    );
    await check(
      "token change and connection replacement invalidate queued reports without timeout",
      async () => {
        const variants = [];
        for (const mode of ["connection", "token"]) {
          const identity = await pair(`synthetic locked ${mode}`),
            peer = await raw(identity),
            before = await scrape();
          await delay(1050);
          const replacement = randomBytes(32).toString("hex");
          // Start owned SQL sessions before the ordinary liveness window.
          const held = await lock(f, "SELECT 1");
          let handoff, handoffReady, newer, invalidation;
          try {
            const blockerPid = Number(
              await held.query("SELECT pg_backend_pid()"),
            );
            assert.ok(Number.isSafeInteger(blockerPid) && blockerPid > 0);
            if (mode === "connection")
              handoff = await lock(
                f,
                "LOCK TABLE agent_transfer_runs IN SHARE MODE; SAVEPOINT connection_handoff",
              );
            const seen = await held.query(
              `SELECT last_seen::text FROM agents WHERE id=${quote(identity.id)}`,
            );
            peer.send({ type: "HEARTBEAT" });
            await until(
              async () =>
                (await held.query(
                  `SELECT last_seen::text FROM agents WHERE id=${quote(identity.id)}`,
                )) !== seen,
              "Authenticated incoming heartbeat refreshes Agent activity before receiver dispatch",
              2000,
              5,
            );
            await held.query(
              mode === "token"
                ? `UPDATE agents SET token_hash=${quote(digest(replacement))} WHERE id=${quote(identity.id)}`
                : `SELECT id FROM agents WHERE id=${quote(identity.id)} FOR UPDATE`,
            );
            if (mode === "connection") {
              newer = await connect(
                f.origin.replace("http:", "ws:") + "/api/v1/agents/ws",
                { Authorization: `Bearer ${identity.token}` },
              );
              // The heartbeat finished before the owned Agent row lock, and
              // neither the handoff row query nor queued reports have been sent.
              // Replacement initialization must be its sole blocked activity.
              await until(
                async () =>
                  Number(
                    await held.query(
                      `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ${blockerPid}=ANY(pg_blocking_pids(pid))`,
                    ),
                  ) === 1,
                "Replacement initialization is the sole waiter on the owned Agent lock before handoff",
                250,
                5,
              );
              handoffReady = handoff.query(
                `SELECT id FROM agents WHERE id=${quote(identity.id)} FOR UPDATE`,
                10000,
              );
              handoffReady.catch(() => {});
              await until(
                async () =>
                  Number(
                    await held.query(
                      `SELECT count(*) FROM pg_stat_activity WHERE application_name=${quote(handoff.marker)} AND wait_event_type='Lock'`,
                    ),
                  ) === 1,
                "Owned row handoff queued second",
                250,
                5,
              );
            }
            peer.send(packet(peer.connection, 1, completedTotals(77)));
            if (mode === "connection")
              peer.send({ type: "TRANSFER_DRAINED", id: randomUUID() });
            await until(
              async () =>
                Number(
                  await held.query(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT id FROM agents WHERE id=$1 AND token_hash=$2 AND NOT revoked FOR SHARE'",
                  ),
                ) > 0,
              "Actual receiver Agent authorization lock wait",
              250,
              5,
            );
            if (mode === "connection")
              await until(
                async () =>
                  Number(
                    await held.query(
                      "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='UPDATE agent_transfer_runs SET agent_drained_at=COALESCE(agent_drained_at,clock_timestamp()) WHERE id=$1 AND agent_id=$2 AND dispatched_at IS NOT NULL'",
                    ),
                  ) === 1,
                "Old socket task owns its queued receiver",
                250,
                5,
              );
            await held.finish();
            if (mode === "connection") {
              await handoffReady;
              await until(
                async () => {
                  const row = (await admin.request("/agents")).find(
                    (row) => row.id === identity.id,
                  );
                  return row?.connected === true && row.drain_receipts === null;
                },
                "Replacement registry positively installed",
                250,
                5,
              );
              assert.equal(
                peer.record.closed,
                false,
                "Old receiver remains owned through post-wait identity check",
              );
              await handoff.query("ROLLBACK TO SAVEPOINT connection_handoff");
            }
            await until(async () => {
              const rows = await scrape();
              assert.equal(
                metric(rows, "dropped_total", { reason: "unavailable" }),
                metric(before, "dropped_total", { reason: "unavailable" }),
                "Authorization timeout cannot substitute for identity invalidation",
              );
              if (mode === "token") {
                if (
                  metric(rows, "dropped_total", { reason: "unauthorized" }) ===
                  metric(before, "dropped_total", { reason: "unauthorized" }) +
                    1
                ) {
                  invalidation = "post_wait_token_rejected";
                  return true;
                }
              } else if (
                metric(rows, "dropped_total", { reason: "stale" }) ===
                metric(before, "dropped_total", { reason: "stale" }) + 1
              ) {
                invalidation = "post_wait_connection_rejected";
                return true;
              }
              return false;
            }, "Explicit queued-report invalidation rather than timeout");
            if (mode === "connection")
              assert.equal(
                peer.record.closed,
                false,
                "Stale identity rejected before old socket cancellation",
              );
            await stable(before, 1200);
            assert.equal(
              metric(await scrape(), "dropped_total", {
                reason: "unavailable",
              }),
              metric(before, "dropped_total", { reason: "unavailable" }),
            );
          } finally {
            await Promise.all([held.finish(false), handoff?.finish(false)]);
          }
          if (newer) await newer.close();
          if (!peer.record.closed) await peer.close();
          const recovered = await raw({
            ...identity,
            token: mode === "token" ? replacement : identity.token,
          });
          await accept(recovered, 1, completedTotals(3), 3);
          await recovered.close();
          variants.push({
            mode,
            contended_agent_row: true,
            invalidation,
            authorization_timeouts: 0,
            stale_report_credit: 0,
            fresh_authorized_delta: 3,
          });
        }
        return { synthetic: true, variants };
      },
    );
    await check(
      "public revocation denies live and new synthetic metric producers",
      async () => {
        const identity = await pair("synthetic revoked owner"),
          peer = await raw(identity),
          before = await scrape();
        await admin.request(`/agents/${identity.id}`, "DELETE");
        if (peer.ws.readyState === WebSocket.OPEN)
          peer.send(packet(peer.connection, 1, completedTotals(81)));
        await until(() => peer.record.closed, "Revoked ordinary socket closes");
        await stable(before);
        const status = await new Promise((done, reject) => {
          const denied = new WebSocket(
            f.origin.replace("http:", "ws:") + "/api/v1/agents/ws",
            {
              headers: { Authorization: `Bearer ${identity.token}` },
              handshakeTimeout: 5000,
            },
          );
          track(denied);
          denied.once("open", () =>
            reject(Error("Revoked socket unexpectedly opened")),
          );
          denied.once("error", reject);
          denied.once("unexpected-response", (_request, response) => {
            response.resume();
            denied.terminate();
            done(response.statusCode);
          });
        });
        assert.equal(status, 401);
        await stable(before);
        return {
          synthetic: true,
          live_credit: 0,
          new_connection_status: status,
        };
      },
    );
    await until(
      () =>
        f.sql(
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
        ) === "0",
      "No fixture authorization transaction survives socket close",
    );
    report.final_server = credited(await scrape());
    report.final_worker = await scrape("worker");
    await verifyBinding();
    report.result = "passed";
  });
} catch (error) {
  failure = error;
  report.error = error.stack ?? String(error);
} finally {
  for (const req of requests) req.destroy();
  if (agent && agent.exitCode === null && agent.signalCode === null)
    agent.kill("SIGTERM");
  if (agentDone) {
    try {
      await until(() => agentExit, "Owned Agent cleanup process exit", 15000);
    } catch (error) {
      agent.kill("SIGKILL");
      failure ??= error;
      report.result = "failed";
      report.error ??= error.stack ?? String(error);
    }
    await agentDone;
  }
  for (const ws of sockets) ws.terminate();
  if (proxy) await proxy.close();
  if (agentLog) await new Promise((done) => agentLog.end(done));
  if (fixture) {
    report.cleanup = await fixture.verifyStopped();
    report.cleanup.worker = workerPid
      ? {
          pid: workerPid,
          pid_absent: verifyPidAbsent(workerPid),
          port: workerPort,
          port_closed: await verifyClosedPort(workerPort),
        }
      : { not_started: true, pid_absent: true, port_closed: true };
    report.cleanup.agent = agent?.pid
      ? { pid: agent.pid, pid_absent: verifyPidAbsent(agent.pid) }
      : { not_started: true, pid_absent: true };
    report.cleanup.proxy = {
      port: proxy?.port,
      port_closed: proxy ? await verifyClosedPort(proxy.port) : true,
      all_websocket_peers_closed:
        proxy?.connections.every((entry) => entry.done()) ?? true,
    };
    for (const owned of [report.cleanup.worker, report.cleanup.agent])
      assert.equal(owned.pid_absent, true);
    assert.equal(report.cleanup.worker.port_closed, true);
    assert.equal(report.cleanup.proxy.port_closed, true);
    assert.equal(report.cleanup.proxy.all_websocket_peers_closed, true);
    await until(
      () => sockets.size === 0,
      "All raw/room/proxy sockets emitted close",
    );
    await until(
      () => requests.size === 0,
      "All owned HTTP requests emitted close",
    );
    report.cleanup.raw_room_socket_count = sockets.size;
    report.cleanup.http_request_count = requests.size;
    report.postgres = fixture.postgresDiagnostics();
    report.finished_at = new Date().toISOString();
    report.limitations = [
      "Agent counters describe successful Binary transport handoff; no remote acknowledgement, playback or resource-disposal inference",
      "Transparent proxy received Binary frames and downloaded body equality are separate finite evidence; cancellation may leave handed-off frames unread",
      "Synthetic raw cumulative reports can be falsified and test aggregation/fencing only; no billing or permission decisions",
    ];
    const path = resolve(fixture.root, "report.json");
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
    console.log(`Evidence: ${path}`);
  }
}
if (failure) throw failure;
