// Run only source-extracted diagnostics with memory-only mocks. Never import the
// native fixture entrypoint or start a process, database, or network connection.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("./room-presence.mjs", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function extract(start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `Actual source marker exists: ${start}`);
  assert.equal(source.indexOf(start, from + start.length), -1, `Unique source marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `Actual source endpoint exists: ${end}`);
  return source.slice(from, to);
}

const connectDefinition = extract("    const connect = async (", "\n    const stop = async");
const finalizerStart = source.lastIndexOf("} finally {");
assert.notEqual(finalizerStart, -1, "Actual outer finalizer exists");
const finalizer = source.slice(finalizerStart + "} finally {".length, source.lastIndexOf("}"));

async function witness(initial = { type: "SNAPSHOT" }, options = {}) {
  let now = 1000, delayCalls = 0;
  const report = { socket_observations: [] };
  class MemorySocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit("open"));
    }
    send(bytes) {
      if (JSON.parse(bytes).type === "RESUME")
        this.emit("message", JSON.stringify(initial));
    }
  }
  const connect = runInNewContext(`(() => { ${connectDefinition}; return connect; })()`, {
    WebSocket: MemorySocket,
    f: { origin: "http://memory.invalid" },
    room: { id: "PRIVATE_ROOM_ID" },
    sockets: new Set(), report, beganAt: 1000,
    Date: { now: () => now },
    delay: async milliseconds => { delayCalls++; now += milliseconds; },
  });
  const socket = await connect({ cookie: "PRIVATE_SESSION_TOKEN" }, options);
  return { socket, report, delayCalls: () => delayCalls,
    emit: frame => socket.ws.emit("message", JSON.stringify(frame)),
  };
}

test("presence witness fails immediately on unexpected ERROR without consuming it", async () => {
  const f = await witness();
  f.emit({ type: "SNAPSHOT" });
  f.emit({ type: "ERROR", error: { code: "SERVICE_UNAVAILABLE" } });
  await assert.rejects(f.socket.next("SNAPSHOT"), /Unexpected witness ERROR:SERVICE_UNAVAILABLE/);
  assert.equal(f.delayCalls(), 0);
  assert.equal(f.socket.frames.length, 2);
});

test("expected initial, request, and revocation ERROR frames remain consumable", async () => {
  const denied = await witness({ type: "ERROR", error: { code: "RATE_LIMITED" } }, { initialType: "ERROR" });
  assert.equal(denied.socket.initial.error.code, "RATE_LIMITED");
  assert.equal(denied.socket.frames.length, 0);
  for (const code of ["INVALID_REQUEST", "SESSION_EXPIRED", "NOT_A_MEMBER"]) {
    const f = await witness();
    f.emit({ type: "ERROR", error: { code } });
    f.socket.ws.emit("close", 1008);
    assert.equal((await f.socket.next("ERROR")).error.code, code);
    assert.equal(f.delayCalls(), 0);
  }
});

test("closed witnesses fail promptly but preserve a matching buffered response", async () => {
  const f = await witness();
  f.emit({ type: "CLOCK_SYNC_REPLY", t1: "matching" });
  f.socket.ws.emit("close", 1000);
  assert.equal((await f.socket.next("CLOCK_SYNC_REPLY", frame => frame.t1 === "matching")).t1, "matching");
  await assert.rejects(f.socket.next("PRESENCE_SNAPSHOT"), /Witness closed \(1000\)/);
  assert.equal(f.delayCalls(), 0);
});

test("socket diagnostic events are bounded and omit identities, tokens, and error messages", async () => {
  const f = await witness();
  for (let index = 0; index < 150; index++) {
    f.emit({ type: "PRESENCE_SNAPSHOT", room_id: "PRIVATE_ROOM_ID", presence_epoch: "PRIVATE_EPOCH",
      presence_seq: index, members: [{ user_id: "PRIVATE_USER_ID", connection_count: 2 }] });
  }
  f.emit({ type: "ERROR", error: { code: "SERVICE_UNAVAILABLE", message: "PRIVATE_SQL_STACK" } });
  f.socket.ws.emit("ping", "PRIVATE_PING_PAYLOAD");
  f.socket.ws.emit("close", 1000, "PRIVATE_CLOSE_REASON");
  const observation = plain(f.report.socket_observations[0]);
  assert.equal(observation.events.length, 128);
  assert.equal(observation.ping_count, 1);
  assert.deepEqual(observation.close, { elapsed_ms: 0, code: 1000 });
  assert.deepEqual(observation.events.at(-4).connection_counts, [2]);
  assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_/);
});

test("malformed presence diagnostics cannot copy raw values or unbounded member lists", async () => {
  const f = await witness();
  f.emit({ type: "PRESENCE_SNAPSHOT", presence_seq: "PRIVATE_SEQUENCE",
    members: [null, { connection_count: "PRIVATE_COUNT" }, { connection_count: -1 }, { connection_count: 1.5 }] });
  f.emit({ type: "PRESENCE_SNAPSHOT", presence_seq: -1, members: { raw: "PRIVATE_MEMBERS" } });
  f.emit({ type: "PRESENCE_SNAPSHOT", presence_seq: 12,
    members: Array.from({ length: 1000 }, () => ({ user_id: "PRIVATE_USER_ID", connection_count: 2 })) });
  const events = plain(f.report.socket_observations[0].events);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
  for (const event of events) {
    if (event.presence_seq !== undefined && event.presence_seq !== null)
      assert.ok(Number.isSafeInteger(event.presence_seq) && event.presence_seq >= 0);
    if (event.connection_counts) {
      assert.ok(event.connection_counts.length <= 64, "One event must retain only bounded counts");
      for (const count of event.connection_counts)
        assert.ok(count === null || (Number.isSafeInteger(count) && count >= 0));
    }
  }
});

async function finish({ logs = [], missingLogs = false } = {}) {
  const root = "/memory/artifacts", files = new Map(), directories = [];
  const report = { schema_version: 1, result: "failed", checks: ["fixed acceptance check"],
    socket_observations: [], authorization_failures: [], failure: "PRIVATE_SQL_STACK_TOKEN" };
  await runInNewContext(`(async () => { ${finalizer} })()`, {
    report,
    fixture: { root: `${root}/room-presence/private`,
      verifyStopped: async () => ({ completed: true, fixture_paths: { artifacts: "PRIVATE_FILESYSTEM_PATH" } }),
      postgresDiagnostics: () => ({ password: "PRIVATE_POSTGRES_SECRET" }),
    },
    serverLogs: ["/memory/server.log"], resolve,
    randomUUID: () => "public-report", process: { env: { RAINSYNC_ARTIFACT_DIR: root } },
    mkdir: async path => { directories.push(path); },
    readFile: async path => {
      assert.equal(path, "/memory/server.log");
      if (missingLogs) throw Error("PRIVATE_LOG_READ_ERROR");
      return logs.join("\n");
    },
    writeFile: async (path, text) => { files.set(path, JSON.parse(text)); },
    console: { log() {}, error() {} },
  });
  return { root, files, directories, report };
}

test("authorization log extraction keeps only bounded stage, kind, SQLSTATE, and duration", async () => {
  const logs = ["PRIVATE_RAW_LINE SQL SELECT token FROM sessions"];
  for (let index = 0; index < 70; index++)
    logs.push(`\x1b[33mWARN room authorization check failed check_stage="membership" failure_kind="database" sqlstate="57014" elapsed_ms=${index} PRIVATE_SQL_TOKEN\x1b[0m`);
  logs.push('WARN check_stage="presence_decode" PRIVATE_DECODE_STACK');
  const f = await finish({ logs });
  const failures = plain(f.report.authorization_failures);
  assert.equal(failures.length, 64);
  assert.deepEqual(failures[0], { stage: "membership", kind: "database", sqlstate: "57014", elapsed_ms: 7 });
  assert.deepEqual(failures.at(-1), { stage: "presence_decode", kind: null, sqlstate: null, elapsed_ms: 0 });
  assert.doesNotMatch(JSON.stringify(failures), /PRIVATE_|SELECT|sessions/);
});

test("the CI report glob selects safe output only, never the private fixture report", async () => {
  const f = await finish({ logs: ['WARN check_stage="login" failure_kind="pool_timeout" sqlstate="none" elapsed_ms=2000'] });
  const uploadStep = workflow.match(/- name: Retain bounded room presence diagnostics\n([\s\S]*?)(?=\n  #|\n  [A-Za-z][\w-]*:|$)/)?.[1];
  assert.ok(uploadStep, "CI retains the actual bounded room-presence report");
  const suffix = uploadStep.match(/path: \$\{\{ runner\.temp \}\}\/rainsync-validation\/(\S+)/)?.[1];
  assert.ok(suffix, "Explicit safe report path is present");
  const pattern = `${f.root}/${suffix}`;
  const pathMatcher = new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
  const uploaded = [...f.files].filter(([path]) => pathMatcher.test(path));
  assert.equal(uploaded.length, 1, "Upload exactly one safe report, not the raw fixture report");
  const report = uploaded[0][1];
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|"failure":|postgres|fixture_paths|stack|token/i);
  assert.equal(report.authorization_failures.length, 1);
  assert.equal(report.authorization_failures[0].kind, "pool_timeout");
  assert.equal(report.cleanup_completed, true);
});

test("the saved local report includes parsed authorization evidence", async () => {
  const f = await finish({ logs: ['WARN check_stage="presence_snapshot" failure_kind="database" sqlstate="57014" elapsed_ms=1500'] });
  const local = f.files.get(`${f.root}/room-presence/private/report.json`);
  assert.ok(local, "The diagnostic path printed to the user is saved");
  assert.equal(local.authorization_failures.length, 1);
  assert.equal(local.authorization_failures[0].stage, "presence_snapshot");
});

test("unavailable server logs record a safe category instead of exception text", async () => {
  const f = await finish({ missingLogs: true });
  assert.equal(f.report.authorization_log_unavailable, true);
  const publicReports = [...f.files.values()].filter(report => Object.hasOwn(report, "cleanup_completed"));
  assert.equal(publicReports.length, 1);
  assert.equal(publicReports[0].authorization_log_unavailable, true);
  assert.doesNotMatch(JSON.stringify(publicReports[0]), /PRIVATE_/);
});
