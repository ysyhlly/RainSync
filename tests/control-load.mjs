import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  randomBytes,
  randomUUID,
  createHash,
  createCipheriv,
} from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { cpus, totalmem, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";

const args = new Map(
  process.argv.slice(2).map((v) => {
    const m = /^--(duration-seconds|topology)=(.+)$/.exec(v);
    assert.ok(m, "unknown argument");
    return [m[1], m[2]];
  }),
);
const duration = Number(args.get("duration-seconds") ?? 3600);
assert.ok(Number.isInteger(duration) && duration >= 25 && duration <= 86400);
const topologies = args.has("topology")
  ? [args.get("topology")]
  : ["10x10", "50x2"];
assert.ok(topologies.every((t) => ["10x10", "50x2"].includes(t)));
const tag =
  process.env.WORKER_TEST_IMAGE ?? "rainsync-source-errors-validation:local";
const candidatePath = resolve(
  process.env.VALIDATION_CANDIDATE ?? "../candidate.json",
);
let candidate;
try {
  candidate = JSON.parse(await readFile(candidatePath, "utf8"));
} catch (error) {
  if (process.env.VALIDATION_CANDIDATE || error.code !== "ENOENT") throw error;
}
assert.ok(
  duration < 3600 || candidate?.status === "built",
  "sustained validation requires a built frozen candidate",
);
if (candidate) {
  assert.equal(
    resolve(dirname(candidatePath), candidate.source_directory),
    process.cwd(),
    "run from frozen candidate source directory",
  );
  assert.equal(candidate.schema_version, 1);
}
const name = "rainsync-load-" + randomUUID().slice(0, 8);
const root = resolve(".runtime/control-load", name);
await mkdir(root, { recursive: true });
const run = promisify(execFile);
async function docker(...args) {
  const { stdout } = await run("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const password = randomBytes(24).toString("hex");
const key = randomBytes(32);
const db = name + "-db",
  server = name + "-server";
let base,
  failure,
  interruptedBy,
  abort = false;
const stopRequested = (signal) => {
  interruptedBy = signal;
  failure ??= Error("measurement interrupted by " + signal);
  process.exitCode = 1;
  for (const socket of sockets) socket.terminate();
};
const onSigint = () => stopRequested("SIGINT"),
  onSigterm = () => stopRequested("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
const clients = [],
  sockets = new Set(),
  commands = new Map();
const report = {
  started_at: new Date().toISOString(),
  duration_seconds_per_topology: duration,
  sustained_gate_requested: duration >= 3600,
  scope:
    "100 distinct authenticated users; control plane only; SQL media fixture; no video capacity claim",
  hardware: {
    os: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    logical_cpus: cpus().length,
    memory_bytes: totalmem(),
  },
  image: await docker("image", "inspect", "--format", "{{.Id}}", tag),
  git_head:
    candidate?.git.head ??
    (
      await run("git", ["rev-parse", "HEAD"], { windowsHide: true })
    ).stdout.trim(),
  source_sha256: {},
  phases: [],
};
const sourceFiles = candidate
  ? candidate.source_manifest
      .filter((entry) => !entry.deleted)
      .map((entry) => entry.path)
  : [
      "Cargo.lock",
      "apps/server/src/main.rs",
      "apps/server/src/rooms.rs",
      "apps/server/src/metrics.rs",
      "tests/control-load.mjs",
    ];
for (const file of sourceFiles) {
  const actual = sha(await readFile(file));
  if (candidate)
    assert.equal(
      actual,
      candidate.source_manifest.find((entry) => entry.path === file).sha256,
      "frozen source integrity: " + file,
    );
  report.source_sha256[file] = actual;
}
if (candidate) {
  assert.equal(
    sha(JSON.stringify(candidate.source_manifest)),
    candidate.source_manifest_sha256,
  );
  assert.equal(
    sha(JSON.stringify(candidate.production_manifest)),
    candidate.production_manifest_sha256,
  );
  assert.equal(
    report.image,
    candidate.image.id,
    "tested image matches built candidate",
  );
  const labels = JSON.parse(
    await docker(
      "image",
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      report.image,
    ),
  );
  assert.equal(
    labels["org.rainsync.source-manifest"],
    candidate.production_manifest_sha256,
  );
  assert.equal(
    labels["org.rainsync.full-source-manifest"],
    candidate.source_manifest_sha256,
  );
  report.candidate = {
    id: candidate.id,
    manifest: candidatePath,
    source_manifest_sha256: candidate.source_manifest_sha256,
    production_manifest_sha256: candidate.production_manifest_sha256,
    git: candidate.git,
  };
}
const record = (value) =>
  appendFile(resolve(root, "samples.jsonl"), JSON.stringify(value) + "\n");
const sql = (q) =>
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
    q,
  );
async function until(check, label, timeout = 45000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (failure && !abort) throw failure;
    if (await check()) return;
    await delay(100);
  }
  throw Error("deadline: " + label);
}
function encrypt(value) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([
    nonce,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) =>
    sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return {
    count: values.length,
    p50_ms: at(0.5),
    p95_ms: at(0.95),
    p99_ms: at(0.99),
    max_ms: sorted.at(-1) ?? null,
  };
}
class Client {
  cookie = "";
  csrf = "";
  async request(path, method = "GET", body) {
    if (failure && !abort) throw failure;
    const response = await fetch(base + "/api/v1" + path, {
      method,
      signal: AbortSignal.timeout(15000),
      headers: {
        Origin: "http://load.test",
        Cookie: this.cookie,
        "x-csrf-token": this.csrf,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.headers.has("set-cookie"))
      this.cookie = response.headers.get("set-cookie").split(";")[0];
    const text = await response.text();
    assert.equal(response.status, 200, path + ": " + response.status);
    return path === "/metrics" ? text : JSON.parse(text);
  }
  async login(username) {
    const value = await this.request("/auth/login", "POST", {
      username,
      password,
    });
    this.csrf = value.csrf;
    const identity = await this.request("/auth/me");
    assert.equal(identity.username, username);
    this.userId = identity.id;
  }
}
class Peer {
  constructor(client, room, index) {
    this.client = client;
    this.room = room;
    this.index = index;
    this.ws = undefined;
    this.waiters = new Map();
  }
  receive(value) {
    if (value.state)
      assert.equal(
        value.state.room_id,
        this.room.id,
        "state belongs to joined room",
      );
    if (value.type === "SNAPSHOT" && !this.authenticatedSnapshot) {
      assert.match(
        value.control_epoch?.id ?? "",
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
        "new connection receives fresh control epoch",
      );
      this.authenticatedSnapshot = true;
    }
    if (value.type === "CLOCK_SYNC_REPLY" && Number.isFinite(value.t1)) {
      this.roundTrips ??= [];
      this.roundTrips.push(performance.now() - value.t1);
    }
    if (value.control_epoch) this.epoch = value.control_epoch.id;
    if (
      value.state &&
      (!this.state || value.state.revision >= this.state.revision)
    )
      this.state = value.state;
    if (value.type === "EVENT") {
      const entry = commands.get(this.room.id + ":" + value.state.revision);
      if (entry) {
        assert.deepEqual(
          value.action,
          entry.action,
          "EVENT action matches sent operation",
        );
        if (entry.state)
          assert.deepEqual(value.state, entry.state, "EVENT state matches ACK");
        assert.ok(
          !entry.observed.has(this.index),
          "one control EVENT per recipient and revision",
        );
        entry.observed.add(this.index);
        entry.eventStates.push(value.state);
        entry.propagation.push(performance.now() - entry.sent_at);
      }
    }
    if (value.command_id && this.waiters.has(value.command_id)) {
      const pending = this.waiters.get(value.command_id);
      this.waiters.delete(value.command_id);
      clearTimeout(pending.timer);
      value.type === "ACK"
        ? pending.resolve(value)
        : pending.reject(Error("command rejected: " + value.error?.code));
    } else if (value.type === "ERROR")
      failure ??= Error("unsolicited WS error: " + value.error?.code);
  }
  async connect() {
    this.state = undefined;
    this.epoch = undefined;
    this.authenticatedSnapshot = false;
    const ws = new WebSocket(base.replace("http:", "ws:") + "/api/v1/ws", {
      headers: { Origin: "http://load.test", Cookie: this.client.cookie },
    });
    this.ws = ws;
    sockets.add(ws);
    ws.on("message", (data) => {
      try {
        this.receive(JSON.parse(data.toString()));
      } catch (error) {
        failure ??= error;
      }
    });
    ws.on("error", (error) => {
      if (!this.closing && !abort)
        failure ??= Error("WebSocket transport failure: " + error.code);
    });
    ws.on("close", () => {
      sockets.delete(ws);
      if (!this.closing && !abort)
        failure ??= Error("unexpected WebSocket close");
      for (const pending of this.waiters.values()) {
        clearTimeout(pending.timer);
        pending.reject(Error("closed before ACK"));
      }
      this.waiters.clear();
    });
    await new Promise((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    this.closing = false;
    ws.send(JSON.stringify({ type: "JOIN", room_id: this.room.id }));
    await until(
      () => this.state && this.epoch && this.authenticatedSnapshot,
      "authenticated snapshot",
      5000,
    );
  }
  send(value) {
    assert.equal(this.ws?.readyState, WebSocket.OPEN);
    this.ws.send(JSON.stringify(value));
  }
  async close() {
    this.closing = true;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    ws.close();
    await until(
      () => ws.readyState === WebSocket.CLOSED,
      "WS close",
      3000,
    ).catch(() => ws.terminate());
  }
  async command(type, extra = {}, expectedRevision = this.state.revision) {
    const id = randomUUID(),
      sentAt = performance.now();
    const command = {
      protocol_version: 1,
      room_id: this.room.id,
      command_id: id,
      control_epoch: this.epoch,
      expected_revision: expectedRevision,
      media_generation: this.state.media_generation,
      type,
      ...extra,
    };
    const event = {
      id,
      room_id: this.room.id,
      revision: expectedRevision + 1,
      sent_at: sentAt,
      observed: new Set(),
      propagation: [],
      action: { type, ...extra },
      eventStates: [],
    };
    commands.set(this.room.id + ":" + event.revision, event);
    const ack = new Promise((resolve, reject) => {
      this.waiters.set(id, {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(id);
          reject(Error("legal command ACK missing"));
        }, 5000),
      });
    });
    this.send(command);
    const value = await ack;
    assert.equal(value.command_id, id);
    assert.equal(value.state.revision, event.revision);
    assert.deepEqual(
      value.action,
      event.action,
      "ACK action matches sent operation",
    );
    if (type === "PLAY" || type === "PAUSE")
      assert.equal(
        value.state.playback_status,
        type === "PLAY" ? "playing" : "paused",
      );
    if (type === "CHANGE_MEDIA")
      assert.equal(value.state.media_id, extra.payload.media_id);
    event.state = value.state;
    for (const state of event.eventStates)
      assert.deepEqual(state, event.state, "early EVENT state matches ACK");
    event.ack_ms = performance.now() - sentAt;
    return event;
  }
}

async function metricSample(admin, peers, phase, started) {
  const text = await admin.request("/metrics");
  const gauges = {};
  for (const line of text.split("\n")) {
    const m =
      /^(rainsync_(?:control_|db_pool_|room_actors)\w*)\s+([0-9.e+-]+)$/.exec(
        line,
      );
    if (m) gauges[m[1]] = Number(m[2]);
  }
  for (const name of [
    "rainsync_control_queue_depth",
    "rainsync_control_queue_max_depth",
    "rainsync_control_connections",
    "rainsync_db_pool_connections",
  ])
    assert.ok(Number.isFinite(gauges[name]), "missing metric: " + name);
  const pg = JSON.parse(
    await sql(
      "SELECT json_build_object('total',count(*),'active',count(*) FILTER (WHERE state='active'),'waiting',count(*) FILTER (WHERE wait_event IS NOT NULL)) FROM pg_stat_activity WHERE datname='rainsync'",
    ),
  );
  const proc = await docker(
    "exec",
    server,
    "sh",
    "-c",
    "grep '^VmRSS:' /proc/1/status; ls /proc/1/fd | wc -l",
  );
  const sample = {
    phase,
    elapsed_ms: performance.now() - started,
    open_clients: peers.filter((p) => p.ws?.readyState === WebSocket.OPEN)
      .length,
    gauges,
    database_connections: pg,
    server_rss_kib: Number(/VmRSS:\s+(\d+)/.exec(proc)?.[1]),
    server_fd_count: Number(proc.trim().split("\n").at(-1)),
  };
  await record({ kind: "resource-sample", ...sample });
  return sample;
}
async function queueProof(admin, owner, peers, room) {
  const second = new Peer(owner.client, room, 100);
  await second.connect();
  await docker(
    "exec",
    "-d",
    db,
    "psql",
    "-U",
    "rainsync",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "SET application_name='queue_proof'; BEGIN; SELECT room_id FROM room_snapshots WHERE room_id='" +
      room.id +
      "' FOR UPDATE; SELECT pg_sleep(3); COMMIT",
  );
  await until(
    async () =>
      Number(
        await sql(
          "SELECT count(*) FROM pg_stat_activity WHERE application_name='queue_proof' AND wait_event='PgSleep'",
        ),
      ) === 1,
    "row lock active",
    3000,
  );
  const revision = owner.state.revision;
  const firstAck = owner.command("PLAY", {}, revision);
  firstAck.catch((error) => {
    failure ??= error;
  });
  await delay(150);
  const secondAck = second.command("PAUSE", {}, revision + 1);
  secondAck.catch((error) => {
    failure ??= error;
  });
  let snapshot;
  await until(
    async () => {
      snapshot = await metricSample(
        admin,
        [...peers, second],
        "queue-proof",
        performance.now(),
      );
      return snapshot.gauges.rainsync_control_queue_depth >= 1;
    },
    "pending command visible in queue metric",
    2000,
  );
  await Promise.all([firstAck, secondAck]);
  await until(
    () =>
      peers
        .filter((peer) => peer.room.id === room.id)
        .every((peer) => peer.state.revision === revision + 2),
    "queue proof state delivered",
  );
  await second.close();
  report.queue_proof = {
    observed_depth: snapshot.gauges.rainsync_control_queue_depth,
    observed_connections: snapshot.gauges.rainsync_control_connections,
  };
  console.log(
    "PASS: blocked real command exposes queued request and connected receivers",
  );
}
try {
  await docker("network", "create", name);
  await docker(
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
    "POSTGRES_PASSWORD=" + password,
    "postgres:17",
  );
  await until(async () => {
    try {
      return (
        await docker(
          "exec",
          db,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "rainsync",
        )
      ).includes("accepting connections");
    } catch {
      return false;
    }
  }, "PostgreSQL");
  await docker(
    "run",
    "-d",
    "--name",
    server,
    "--network",
    name,
    "-p",
    "127.0.0.1::8080",
    "-e",
    "DATABASE_URL=postgres://rainsync:" + password + "@db/rainsync",
    "-e",
    "SOURCE_ENCRYPTION_KEY=" + key.toString("base64"),
    "-e",
    "ADMIN_PASSWORD=" + password,
    "-e",
    "PUBLIC_ORIGIN=http://load.test",
    report.image,
    "rainsync-server",
  );
  base = "http://" + (await docker("port", server, "8080/tcp"));
  await until(async () => {
    try {
      return (
        await fetch(base + "/health", { signal: AbortSignal.timeout(2000) })
      ).ok;
    } catch {
      return false;
    }
  }, "Server");
  if (candidate) {
    const actual = await docker(
      "exec",
      server,
      "sha256sum",
      ...Object.keys(candidate.image.binary_sha256).map(
        (binary) => "/usr/local/bin/" + binary,
      ),
    );
    const binaryProof = {};
    for (const line of actual.split("\n")) {
      const [digest, path] = line.trim().split(/\s+/);
      const binary = path.split("/").at(-1);
      assert.equal(
        digest,
        candidate.image.binary_sha256[binary],
        "running container binary matches candidate",
      );
      binaryProof[binary] = digest;
    }
    report.running_binary_sha256 = binaryProof;
  }
  const admin = new Client();
  await admin.login("admin");
  // Account creation and login share the server's bounded password-hash budget.
  // Prepare identities sequentially, before starting any measured load phase.
  report.setup_identity_concurrency = 1;
  for (let index = 0; index < 100; index++) {
    await admin.request("/users", "POST", {
      username: "load-" + index,
      password,
    });
    const client = new Client();
    await client.login("load-" + index);
    clients[index] = client;
    if ((index + 1) % 20 === 0)
      console.log("Setup: " + (index + 1) + " distinct users");
  }
  assert.equal(
    new Set(clients.map((client) => client.userId)).size,
    100,
    "100 separate authenticated identities",
  );
  report.distinct_authenticated_users = 100;
  const sourceId = randomUUID(),
    mediaId = randomUUID();
  await sql(
    "INSERT INTO sources(id,name,kind,config_encrypted) VALUES('" +
      sourceId +
      "','control-only fixture','http','" +
      encrypt({ url: "http://fixture.invalid/control.mp4", headers: {} }) +
      "'); INSERT INTO media_items(id,source_id,title,resource,duration_ms) VALUES('" +
      mediaId +
      "','" +
      sourceId +
      "','control clock fixture','control.mp4',86400000)",
  );
  for (const topology of topologies) {
    const [roomCount, members] = topology.split("x").map(Number);
    const rooms = [],
      peers = [],
      owned = [];
    for (let r = 0; r < roomCount; r++) {
      const owner = clients[r * members];
      const room = await owner.request("/rooms", "POST", {
        name: "Load " + topology + " " + r,
      });
      rooms.push(room);
      const invitation = await owner.request(
        "/rooms/" + room.id + "/invites",
        "POST",
      );
      for (let m = 0; m < members; m++) {
        const client = clients[r * members + m];
        if (m)
          await client.request("/rooms/" + room.id + "/join", "POST", {
            token: invitation.token,
          });
        const peer = new Peer(client, room, r * members + m);
        await peer.connect();
        peers.push(peer);
      }
      const controller = peers[r * members];
      await controller.command("CHANGE_MEDIA", {
        payload: { media_id: mediaId },
      });
      owned.push(controller);
    }
    for (let r = 0; r < rooms.length; r++) {
      const membership = JSON.parse(
        await sql(
          "SELECT json_build_object('owner',r.owner_id,'members',(SELECT json_agg(user_id::text ORDER BY user_id::text) FROM room_members WHERE room_id=r.id)) FROM rooms r WHERE id='" +
            rooms[r].id +
            "'",
        ),
      );
      assert.equal(membership.owner, clients[r * members].userId);
      assert.deepEqual(
        membership.members,
        clients
          .slice(r * members, (r + 1) * members)
          .map((client) => client.userId)
          .sort(),
        "exact membership and owner per declared topology",
      );
    }
    await until(
      () => peers.every((p) => p.state.media_id === mediaId),
      "media command broadcast",
    );
    if (!report.queue_proof) await queueProof(admin, owned[0], peers, rooms[0]);
    commands.clear();
    for (const peer of peers) peer.roundTrips = [];
    const start = performance.now(),
      phaseCommands = [],
      reconnects = [],
      samples = [];
    const phase = {
      topology,
      started_at: new Date().toISOString(),
      requested_seconds: duration,
      room_count: roomCount,
      members_per_room: members,
      status_messages: 0,
      chat_messages: 0,
      legal_commands: 0,
      reconnects: 0,
      samples: 0,
      membership_verified: true,
      cadence: {},
    };
    report.phases.push(phase);
    let statusAt = start,
      commandAt = start + 1000,
      chatAt = start + 2500,
      sampleAt = start,
      reconnectAt = start + 15000;
    let rounds = 0,
      chatRound = 0,
      reconnectRound = 0,
      progressAt = start;
    const expected = (first, interval) =>
      Math.max(0, Math.ceil((duration * 1000 - first) / interval));
    phase.expected_cadence = {
      status: expected(0, 5000),
      commands: expected(1000, 10000),
      chat: expected(2500, 10000),
      samples: expected(0, 5000),
      reconnect: expected(15000, 60000),
    };
    const cadence = async (kind, scheduled) => {
      const actual = performance.now(),
        lateness = actual - scheduled;
      const summary = (phase.cadence[kind] ??= {
        count: 0,
        max_lateness_ms: 0,
      });
      summary.count++;
      summary.max_lateness_ms = Math.max(summary.max_lateness_ms, lateness);
      await record({
        kind: "cadence",
        topology,
        operation: kind,
        scheduled_ms: scheduled - start,
        actual_ms: actual - start,
        lateness_ms: lateness,
      });
      assert.ok(
        lateness <= 2000,
        "load generator missed scheduled " + kind + " by more than 2 seconds",
      );
    };
    while (performance.now() - start < duration * 1000) {
      if (failure) throw failure;
      const now = performance.now();
      if (now >= statusAt) {
        await cadence("status", statusAt);
        for (const peer of peers) {
          peer.send({
            type: "CLIENT_STATUS",
            status: {
              buffering: false,
              drift_ms: 0,
              position_ms: peer.state.anchor_position_ms,
              playback_rate: 1,
            },
          });
          peer.send({ type: "CLOCK_SYNC", t1: performance.now() });
          phase.status_messages++;
        }
        statusAt += 5000;
      }
      if (now >= commandAt) {
        await cadence("commands", commandAt);
        const entries = await Promise.all(
          owned.map((peer) => peer.command(rounds % 2 ? "PAUSE" : "PLAY")),
        );
        for (const entry of entries) {
          entry.expected_observers = members;
          phaseCommands.push(entry);
        }
        await until(
          () => entries.every((entry) => entry.observed.size === members),
          "all room recipients receive control revision",
          5000,
        );
        for (const entry of entries)
          await record({
            kind: "command",
            topology,
            command_id: entry.id,
            room_id: entry.room_id,
            revision: entry.revision,
            ack_ms: entry.ack_ms,
            propagation_ms: entry.propagation,
            observed: entry.observed.size,
            expected: members,
            action: entry.action,
            state: entry.state,
          });
        rounds++;
        phase.legal_commands += entries.length;
        commandAt += 10000;
      }
      if (now >= chatAt) {
        await cadence("chat", chatAt);
        peers[(chatRound * 7) % peers.length].send({
          type: "CHAT",
          body: "bounded load " + chatRound,
          client_message_id: randomUUID(),
        });
        chatRound++;
        phase.chat_messages++;
        chatAt += 10000;
      }
      if (now >= reconnectAt) {
        await cadence("reconnect", reconnectAt);
        const peer = peers[(reconnectRound % roomCount) * members + 1];
        const before = performance.now();
        await peer.close();
        await peer.connect();
        assert.deepEqual(
          peer.state,
          owned[reconnectRound % roomCount].state,
          "reconnect snapshot restores current full authoritative room state",
        );
        const recovered = performance.now() - before;
        assert.ok(
          recovered <= 5000,
          "planned reconnect gets valid snapshot within 5 seconds",
        );
        reconnects.push(recovered);
        phase.reconnects++;
        reconnectRound++;
        reconnectAt += 60000;
      }
      if (now >= sampleAt) {
        await cadence("samples", sampleAt);
        samples.push(await metricSample(admin, peers, topology, start));
        phase.samples++;
        sampleAt += 5000;
      }
      if (now >= progressAt) {
        phase.elapsed_ms = now - start;
        await writeFile(
          resolve(root, "progress.json"),
          JSON.stringify({ status: "running", ...report }, null, 2) + "\n",
        );
        console.log(
          topology +
            ": " +
            Math.floor(phase.elapsed_ms / 1000) +
            "s, " +
            phase.legal_commands +
            " ACKs, " +
            phase.reconnects +
            " reconnects",
        );
        progressAt += 30000;
      }
      await delay(50);
    }
    if (failure) throw failure;
    phase.elapsed_ms = performance.now() - start;
    phase.ack = stats(phaseCommands.map((v) => v.ack_ms));
    phase.event_propagation = stats(
      phaseCommands.flatMap((v) => v.propagation),
    );
    phase.round_trip = stats(peers.flatMap((peer) => peer.roundTrips ?? []));
    phase.rooms = rooms.map((room) => {
      const entries = phaseCommands.filter(
        (entry) => entry.room_id === room.id,
      );
      return {
        room_id: room.id,
        legal_commands: entries.length,
        ack: stats(entries.map((entry) => entry.ack_ms)),
        event_propagation: stats(entries.flatMap((entry) => entry.propagation)),
      };
    });
    phase.control_recovery = stats(reconnects);
    phase.max_command_queue = Math.max(
      ...samples.map((v) => v.gauges.rainsync_control_queue_max_depth),
    );
    phase.max_database_connections = Math.max(
      ...samples.map((v) => v.database_connections.total),
    );
    phase.min_open_clients = Math.min(...samples.map((v) => v.open_clients));
    for (const room of rooms) {
      const entries = phaseCommands.filter((v) => v.room_id === room.id);
      const stored = new Map(
        (
          await sql(
            "SELECT json_build_object('id',command_id,'state',state,'request',request_payload) FROM command_results WHERE room_id='" +
              room.id +
              "'",
          )
        )
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const row = JSON.parse(line);
            return [row.id, row];
          }),
      );
      const events = new Map(
        (
          await sql(
            "SELECT json_build_object('revision',revision,'state',state) FROM room_events WHERE room_id='" +
              room.id +
              "'",
          )
        )
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const row = JSON.parse(line);
            return [row.revision, row.state];
          }),
      );
      for (const entry of entries) {
        assert.deepEqual(
          stored.get(entry.id)?.state,
          entry.state,
          "full durable command state matches ACK",
        );
        const request = stored.get(entry.id).request;
        assert.equal(
          request.type,
          entry.action.type,
          "persisted request action matches command",
        );
        assert.equal(request.command_id, entry.id);
        assert.equal(request.room_id, room.id);
        assert.deepEqual(
          events.get(entry.revision),
          entry.state,
          "full durable event state matches ACK",
        );
        assert.equal(
          entry.observed.size,
          entry.expected_observers,
          "no legal control event lost",
        );
        for (const state of entry.eventStates)
          assert.deepEqual(state, entry.state);
      }
      assert.deepEqual(
        JSON.parse(
          await sql(
            "SELECT state FROM room_snapshots WHERE room_id='" + room.id + "'",
          ),
        ),
        entries.at(-1).state,
        "final room snapshot matches last ACK",
      );
      const proofCount =
        topology === topologies[0] && room.id === rooms[0].id ? 2 : 0;
      assert.equal(
        events.size,
        entries.length + 1 + proofCount,
        "one committed event per legal operation",
      );
      assert.equal(
        entries.length,
        phase.expected_cadence.commands,
        "every room receives each planned command",
      );
    }
    for (const [kind, count] of Object.entries(phase.expected_cadence))
      assert.equal(
        phase.cadence[kind]?.count ?? 0,
        count,
        "complete planned cadence for " + kind,
      );
    assert.equal(phase.status_messages, 100 * phase.expected_cadence.status);
    assert.equal(phase.chat_messages, phase.expected_cadence.chat);
    assert.equal(phase.reconnects, phase.expected_cadence.reconnect);
    assert.equal(phase.samples, phase.expected_cadence.samples);
    const chatCount = Number(
      await sql(
        "SELECT count(*) FROM chat_messages WHERE room_id IN (" +
          rooms.map((r) => "'" + r.id + "'").join(",") +
          ")",
      ),
    );
    assert.equal(
      chatCount,
      phase.chat_messages,
      "all scheduled chat messages committed",
    );
    await until(
      () =>
        peers.every(
          (peer) => peer.roundTrips.length === phase.expected_cadence.status,
        ),
      "all scheduled clock replies returned",
      5000,
    );
    phase.persisted_commands_verified = phaseCommands.length;
    assert.ok(
      phase.ack.p95_ms <= 300,
      "normal-link control ACK p95 exceeds 300ms",
    );
    assert.equal(phase.min_open_clients, 100);
    phase.status =
      duration >= 3600 && phase.elapsed_ms >= 3600000
        ? "sustained-passed"
        : "short-smoke-passed";
    console.log(
      "PASS: " +
        topology +
        ", ACK p95 " +
        phase.ack.p95_ms.toFixed(1) +
        "ms, durable commands " +
        phase.persisted_commands_verified,
    );
    for (const peer of peers) await peer.close();
    commands.clear();
  }
  for (const [file, digest] of Object.entries(report.source_sha256))
    assert.equal(
      sha(await readFile(file)),
      digest,
      "source changed during measured run: " + file,
    );
  report.status = report.phases.every((p) => p.status === "sustained-passed")
    ? "sustained-passed"
    : "short-smoke-passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack ?? error);
  throw error;
} finally {
  abort = true;
  for (const socket of sockets) socket.terminate();
  report.finished_at = new Date().toISOString();
  if (interruptedBy) report.interrupted_by = interruptedBy;
  try {
    await writeFile(
      resolve(
        root,
        report.status === "failed" ? "failed-report.json" : "report.json",
      ),
      JSON.stringify(report, null, 2) + "\n",
    );
  } finally {
    const cleanup = [];
    for (const container of [server, db]) {
      try {
        await docker("rm", "-f", "-v", container);
      } catch (error) {
        cleanup.push(String(error));
      }
    }
    try {
      await docker("network", "rm", name);
    } catch (error) {
      cleanup.push(String(error));
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (cleanup.length) {
      report.status = "failed";
      report.cleanup_errors = cleanup;
      process.exitCode = 1;
      await writeFile(
        resolve(root, "failed-report.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
    }
  }
  console.log("Evidence: " + root);
}
