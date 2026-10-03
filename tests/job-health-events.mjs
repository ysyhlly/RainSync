// Finite real PostgreSQL, Server API and Worker producer evidence. This driver
// consumes a successful frozen native build and never builds or installs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const childReapOnly = process.argv[2] === "--child-reap-only";
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && childReapOnly), "Only the explicit finite child-reap-only mode is supported");
const childReapCheckName = "logical API cancellation is followed by separately witnessed actual child reap";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const bindingPath = process.env.RAINSYNC_JOB_HEALTH_BINDING_FILE ?? process.env.W03_BACKEND_BINDING;
assert.ok(bindingPath, "Use the central successful native binding; this fixture never builds");
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, "Use an owned native PostgreSQL cluster");
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Use an external artifact directory");
assert.equal(process.platform, "linux", "Positive owned child PID evidence requires Linux");
const bindingBytes = await readFile(bindingPath), binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
for (const name of ["rainsync-server", "rainsync-media-worker"])
  assert.equal(resolve(binding.binaries.find((item) => item.name === name)?.path ?? "missing"), resolve(target, name));
const helper = binding.test_helpers?.find((item) => item.name === "verify_job_health_events");
assert.ok(helper, "Central binding freezes the actual new helper executable");
assert.equal(resolve(helper.path), resolve(target, "examples", "verify_job_health_events"));
for (const path of ["crates/media-core/src/job_health.rs", "crates/persistence/src/media_jobs.rs",
  "crates/persistence/examples/verify_job_health_events.rs", "apps/server/src/playback_requests.rs",
  "apps/server/src/media.rs", "apps/server/src/room_lifecycle.rs", "crates/persistence/src/lib.rs"])
  assert.ok(binding.source.some((item) => item.path === path), `Bound producer/helper source ${path}`);
const coordinator = await Promise.all(["tests/job-health-events.mjs", "tests/fixtures/server.mjs",
  "tests/fixtures/media-stack.mjs", "tests/fixtures/postgres.mjs", "tests/fixtures/source-grant.mjs", "tests/fixtures/playback-admission.mjs"]
  .map(async (path) => ({ path, sha256: digest(await readFile(resolve(repo, path))) })));
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
async function verifyBinding() {
  assert.equal(digest(await readFile(bindingPath)), digest(bindingBytes), "Binding remains frozen");
  for (const item of [...binding.source, ...coordinator])
    assert.equal(await hashFile(resolve(repo, item.path)), item.sha256, `Frozen source ${item.path}`);
  for (const item of [...binding.binaries, ...(binding.test_helpers ?? [])])
    assert.equal(await hashFile(item.path), item.sha256, `Frozen executable ${item.name}`);
}
await verifyBinding();
const report = {
  schema_version: 1, result: "failed", started_at: new Date().toISOString(), checks: [],
  selection: childReapOnly ? "child-reap-only" : "complete", skipped_checks: [],
  scope: "Finite owned native PostgreSQL, actual Server cancellation APIs and actual Worker normalization/transport producers. SQL fixtures and request-ledger fault injection are labeled. Logical counters are acknowledged process-local transition observations, reset on restart; they are not durable history, OS drain or long-run acceptance.",
  limitations: ["The helper renders its own collector and is distinct from actual Worker API evidence",
    "Cancellation during a witnessed database wait has an unknown acknowledgement; the quality flag records a possible gap without asserting that PostgreSQL committed",
    "Server source-policy, upstream-policy and continuation callsites are covered by source review outside this fixture; this finite API matrix exercises Stop, cancellation key, viewer supersession, control retirement, room close and admission early-commit/rollback branches"],
  binding: { path: resolve(bindingPath), sha256: digest(bindingBytes), source_digest: binding.source_digest,
    binaries: binding.binaries, test_helpers: binding.test_helpers, coordinator },
};
let fixture, failure, upstream, upstreamPort;
const workerPids = [], helperProcesses = [], mediaChildren = new Set(), sockets = new Set(), upstreamSockets = new Set();
async function until(probe, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await delay(20); }
  throw Error(`Deadline: ${label}`);
}
async function check(name, run) {
  if (childReapOnly && name !== childReapCheckName) { report.skipped_checks.push(name); return; }
  const entry = { name, result: "failed" }, began = Date.now(); report.checks.push(entry);
  try { Object.assign(entry, await run(), { result: "passed" }); console.log(`PASS: ${name}`); }
  catch (error) { entry.error = error.message; throw error; }
  finally { entry.elapsed_ms = Date.now() - began; }
}
const eventNames = ["rainsync_media_job_retry_schedules_total", "rainsync_media_job_cancellations_total",
  "rainsync_media_job_lease_expiry_normalizations_total", "rainsync_media_job_observation_available",
  "rainsync_media_job_observation_incomplete"];
function events(text, processLabel) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!eventNames.some((name) => line.startsWith(name + "{"))) continue;
    const match = /^(\w+)\{([^}]*)\} (\d+)$/.exec(line); assert.ok(match, "Fixed integer event sample");
    const labels = {};
    for (const label of match[2].split(",")) {
      const pair = /^(\w+)="([^"]*)"$/.exec(label); assert.ok(pair);
      assert.equal(labels[pair[1]], undefined, "No duplicate labels"); labels[pair[1]] = pair[2];
    }
    assert.equal(labels.process, processLabel);
    if (match[1] === eventNames[0]) {
      assert.deepEqual(Object.keys(labels), ["process", "reason"]);
      assert.ok(["upstream_transport", "worker_shutdown", "lease_expired"].includes(labels.reason));
    } else if (match[1] === eventNames[2]) {
      assert.deepEqual(Object.keys(labels), ["process", "result"]);
      assert.ok(["requeued", "exhausted"].includes(labels.result));
    } else assert.deepEqual(labels, { process: processLabel });
    const value = Number(match[3]); assert.ok(Number.isSafeInteger(value)); rows.push({ name: match[1], labels, value });
  }
  assert.equal(rows.length, 8, "Exactly eight available fixed job-health series");
  const sample = (name, extra = {}) => {
    const found = rows.filter((row) => row.name === name && JSON.stringify(row.labels) === JSON.stringify({ process: processLabel, ...extra }));
    assert.equal(found.length, 1, `One ${name} sample`); return found[0].value;
  };
  assert.equal(sample(eventNames[3]), 1); assert.equal(sample(eventNames[4]), 0, "No observation gap in actual API runs");
  return [sample(eventNames[0], { reason: "upstream_transport" }), sample(eventNames[0], { reason: "worker_shutdown" }),
    sample(eventNames[0], { reason: "lease_expired" }), sample(eventNames[1]),
    sample(eventNames[2], { result: "requeued" }), sample(eventNames[2], { result: "exhausted" })];
}
const difference = (after, before) => after.map((value, index) => value - before[index]);
async function childrenOf(parent, jobId) {
  const children = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try { const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) !== parent) continue;
      // Keep the raw command line only in memory. The current job's UUID must
      // occur as a path component, excluding unrelated readiness -version tools.
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (command.split("\0").some((argument) => argument.includes(`/${jobId}/`))) children.push(Number(pid)); } catch {}
  }
  return children;
}
try {
  await isolatedMediaStack("job-health-events", async (f) => {
    fixture = f;
    await f.stopServer();
    await check("real persistence transition races rollback prefix and unknown acknowledgement", async () => {
      const child = spawn(helper.path, [], { env: { ...f.env, RAINSYNC_ISOLATED_TEST: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      const record = { pid: child.pid, binary: helper.path, closed: false }; helperProcesses.push(record);
      let output = "", errors = "";
      child.stdout.on("data", (bytes) => output += bytes); child.stderr.on("data", (bytes) => errors += bytes);
      const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
      let code;
      try { code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", (value) => { record.closed = true; done(value); }); }); }
      finally { clearTimeout(timer); }
      await writeFile(resolve(f.root, "persistence-helper.stdout"), output);
      await writeFile(resolve(f.root, "persistence-helper.stderr"), errors);
      const result = JSON.parse(output.trim().split("\n").at(-1));
      await writeFile(resolve(f.root, "persistence-helper-report.json"), JSON.stringify(result, null, 2) + "\n");
      assert.equal(code, 0, result.failure ?? errors); assert.equal(result.result, "passed");
      assert.equal(verifyPidAbsent(child.pid), true);
      assert.equal(f.sql("SELECT count(*) FROM media_jobs"), "0", "Only owned helper rows existed and were removed");
      return { helper_checks: result.checks, unknown_acknowledgement_may_have_committed: true,
        cleanup: result.cleanup, helper_process_closed: true };
    });
    await f.startServer({ PLAYBACK_SESSION_LIMIT: "10" });
    const admin = f.client(), identity = await admin.login();
    const scrape = async (processLabel = "server") => {
      const url = processLabel === "server" ? f.origin + "/api/v1/metrics" : f.workerOrigin + "/metrics";
      const response = await fetch(url, { headers: { Cookie: admin.cookie }, signal: AbortSignal.timeout(6000) });
      assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-type"), /text\/plain; version=0\.0\.4/);
      return events(await response.text(), processLabel);
    };
    await check("actual authenticated Server exposes fixed known-zero event series", async () => {
      assert.deepEqual(await scrape(), [0, 0, 0, 0, 0, 0]);
      const denial = await fetch(f.origin + "/api/v1/metrics"); assert.equal(denial.status, 401);
      assert.equal((await denial.text()).includes("rainsync_media_job_"), false);
      return { process: "server", event_series: 8, missing_session_status: 401 };
    });
    await f.makeClip("job-events.mp4", { pictureSeconds: 2 });
    const source = await admin.request("/sources", "POST", { name: "owned job events", kind: "local", config: { root: f.root } });
    await admin.request(`/sources/${source.id}/test`, "POST");
    const mediaId = f.sql(`SELECT id FROM media_items WHERE source_id=${quote(source.id)} AND resource='job-events.mp4'`);
    const media = (await admin.request("/media")).find((item) => item.id === mediaId); assert.ok(media);
    const room = async (name) => {
      const value = await admin.request("/rooms", "POST", { name });
      // Setup only. Actual retirement evidence below uses authenticated API/WS.
      f.sql(`UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}',${quote(JSON.stringify(media.id))}::jsonb),'{media_generation}','1') WHERE room_id=${quote(value.id)}`);
      return value;
    };
    const prepare = async (where, extra = {}, expected = 200) => {
      const input = { room_id: where.id, media_generation: 1, mode: "transcode", position_ms: 0, idempotency_key: randomUUID(), ...extra };
      const plan = await admin.request("/playback-sessions", "POST", input, expected);
      if (expected === 200) assert.equal(f.sql(`SELECT status FROM media_jobs WHERE session_id=${quote(plan.session_id)}`), "queued", "Actual API enqueued one job; Worker remains stopped");
      return { input, plan };
    };
    const status = (session) => f.sql(`SELECT status FROM media_jobs WHERE session_id=${quote(session)}`);
    const stop = (session, client = admin) => client.request(`/playback-sessions/${session}`, "DELETE");
    const assertDelta = async (before, expected, label) => {
      const after = await scrape(); assert.deepEqual(difference(after, before), expected, label); return { before, after, delta: expected };
    };
    await check("Stop duplicate and foreign owner only credit the actual owned cancellation", async () => {
      const where = await room("owned Stop events"), { plan } = await prepare(where), before = await scrape();
      await admin.request("/users", "POST", { username: "event-outsider", password: f.password });
      const other = f.client(); await other.login("event-outsider");
      await stop(plan.session_id, other); assert.equal(status(plan.session_id), "queued");
      assert.deepEqual(await scrape(), before);
      await Promise.all([stop(plan.session_id), stop(plan.session_id)]); await stop(plan.session_id);
      assert.equal(status(plan.session_id), "cancelled");
      return { ...(await assertDelta(before, [0, 0, 0, 1, 0, 0])), foreign_owner_affected_rows: 0, stop_requests: 3 };
    });
    await check("cancel key duplicate and cancel-before-POST have no replay credit", async () => {
      const where = await room("owned cancel key events"), { input, plan } = await prepare(where), before = await scrape();
      await Promise.all([admin.request(`/playback-requests/${input.idempotency_key}`, "DELETE"), admin.request(`/playback-requests/${input.idempotency_key}`, "DELETE")]);
      assert.equal(status(plan.session_id), "cancelled");
      const unused = randomUUID(); await admin.request(`/playback-requests/${unused}`, "DELETE");
      const rejected = await admin.request("/playback-sessions", "POST", { ...input, idempotency_key: unused }, 410);
      assert.equal(rejected.error.code, "PLAYBACK_REQUEST_CANCELLED");
      return { ...(await assertDelta(before, [0, 0, 0, 1, 0, 0])), cancel_before_post_job_rows: 0 };
    });
    await check("viewer supersession commits one cancellation while exact-key replay credits none", async () => {
      const where = await room("owned viewer supersession"), viewer = randomUUID();
      const first = await prepare(where, { viewer_id: viewer, plan_generation: 1 }), before = await scrape();
      const replay = await admin.request("/playback-sessions", "POST", first.input); assert.equal(replay.session_id, first.plan.session_id);
      assert.deepEqual(await scrape(), before);
      const second = await prepare(where, { viewer_id: viewer, plan_generation: 2 });
      assert.equal(status(first.plan.session_id), "cancelled");
      const result = await assertDelta(before, [0, 0, 0, 1, 0, 0]); await stop(second.plan.session_id);
      return result;
    });
    await check("actual ChangeMedia and EndMedia retire jobs once and command replay credits none", async () => {
      const where = await room("owned control retirement"), frames = [];
      const ws = new WebSocket(f.origin.replace(/^http/, "ws") + "/api/v1/ws", { headers: { Origin: f.origin, Cookie: admin.cookie }, handshakeTimeout: 5000 });
      sockets.add(ws); ws.on("message", (bytes) => frames.push(JSON.parse(bytes))); ws.on("error", () => {});
      await new Promise((done, reject) => { ws.once("open", done); ws.once("error", reject); });
      const next = (type, id) => until(() => { const index = frames.findIndex((frame) => frame.type === type && (!id || frame.command_id === id));
        if (index < 0) return null; return frames.splice(index, 1)[0]; }, `Actual control ${type}`);
      ws.send(JSON.stringify({ type: "JOIN", room_id: where.id })); let snapshot = await next("SNAPSHOT");
      let state = snapshot.state; const epoch = snapshot.control_epoch.id;
      const command = async (type, payload) => {
        const body = { protocol_version: 1, room_id: where.id, command_id: randomUUID(), control_epoch: epoch,
          expected_revision: state.revision, media_generation: state.media_generation, type, payload };
        ws.send(JSON.stringify(body)); state = (await next("ACK", body.command_id)).state; return body;
      };
      const a = await prepare(where), before = await scrape();
      const changed = await command("CHANGE_MEDIA", { media_id: media.id });
      assert.equal(status(a.plan.session_id), "cancelled");
      const once = await scrape(); ws.send(JSON.stringify(changed)); await next("ACK", changed.command_id); assert.deepEqual(await scrape(), once);
      const b = await prepare(where, { media_generation: state.media_generation });
      await command("SEEK", { position_ms: media.duration_ms });
      await command("END_MEDIA", { position_ms: media.duration_ms }); assert.equal(status(b.plan.session_id), "cancelled");
      const result = await assertDelta(before, [0, 0, 0, 2, 0, 0]);
      const closed = new Promise((done) => ws.once("close", done)); ws.close(); await closed; sockets.delete(ws);
      return { ...result, retirement_commands: 2, position_setup_commands: 1, replay_cancellations: 0 };
    });
    await check("room close commits job cancellation and repeat close has no credit", async () => {
      const where = await room("owned lifecycle event"), { plan } = await prepare(where), before = await scrape();
      const current = await admin.request(`/rooms/${where.id}/lifecycle`);
      await admin.request(`/rooms/${where.id}/close`, "POST", { expected_revision: current.state.revision });
      assert.equal(status(plan.session_id), "cancelled");
      const latest = await admin.request(`/rooms/${where.id}/lifecycle`);
      const response = await admin.raw(`/rooms/${where.id}/close`, { method: "POST", body: { expected_revision: latest.state.revision } });
      assert.ok([200, 409].includes(response.status)); await response.arrayBuffer();
      return { ...(await assertDelta(before, [0, 0, 0, 1, 0, 0])), lifecycle_drain_is_separate: true };
    });

    async function admissionCase(name, viewer, attempt, quota) {
      await f.startServer({ PLAYBACK_SESSION_LIMIT: "10" });
      const where = await room(name), first = await prepare(where, viewer ? { viewer_id: randomUUID(), plan_generation: 1 } : {});
      const extras = [];
      if (quota) for (let i = 0; i < 3; i++) extras.push((await prepare(where)).plan.session_id);
      // Fault injection changes only this owned request ledger. Jobs remain
      // API-created queued rows; begin() performs their actual transition.
      f.sql(`UPDATE playback_requests SET status='failed',error_status=503,error_code='source_probe_failed',attempt=${attempt},response_encrypted=NULL WHERE idempotency_key=${quote(first.input.idempotency_key)}`);
      await f.startServer({ PLAYBACK_SESSION_LIMIT: quota ? "3" : "10" });
      const before = await scrape(); assert.deepEqual(before, [0, 0, 0, 0, 0, 0], "Counters reset on process restart");
      const result = await admin.request("/playback-sessions", "POST", first.input, quota ? 429 : 409);
      assert.equal(result.error.code, quota ? "TOO_MANY_PLAYBACK_SESSIONS" : "PLAYBACK_REQUEST_RETRY_EXHAUSTED");
      assert.equal(status(first.plan.session_id), viewer ? "queued" : "cancelled");
      const observed = await assertDelta(before, [0, 0, 0, viewer ? 0 : 1, 0, 0]);
      for (const session of [first.plan.session_id, ...extras]) await stop(session);
      return { ...observed, request_ledger_fault_injection: true, returned_error: result.error.code,
        old_job_after_rejection: viewer ? "queued" : "cancelled" };
    }
    // No live earlier sessions remain when the cap is reduced.
    await check("non-viewer quota early commit retains and observes stale attempt cleanup", () => admissionCase("non-viewer quota events", false, 1, true));
    await check("viewer quota rollback publishes no cancellation or new high-water", () => admissionCase("viewer quota rollback", true, 1, true));
    await check("request retry exhaustion early commit observes retirement despite error response", () => admissionCase("request retry exhausted", false, 3, false));

    let upstreamRequests = 0, blockedRequests = 0;
    upstream = createServer((request, response) => {
      request.resume(); upstreamRequests++;
      if (request.url === "/blocked") { blockedRequests++; response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": 1048576 }); response.flushHeaders(); }
      else response.writeHead(503, { "Content-Length": 0 }).end();
    });
    upstream.on("connection", (socket) => { upstreamSockets.add(socket); socket.on("close", () => upstreamSockets.delete(socket)); });
    await new Promise((done) => upstream.listen(0, "127.0.0.1", done)); upstreamPort = upstream.address().port;
    const encrypt = (value) => {
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"), nonce);
      return Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("base64");
    };
    // Synthetic job state bypasses preparation, never current login provenance.
    const legacy = (where, path, maximum = 2) => {
      const id = randomUUID(), token = randomBytes(24).toString("hex");
      const resource = { kind: "http", job_id: id, url: `http://127.0.0.1:${upstreamPort}${path}`, headers: {} };
      const mediaId = sourceMedia(f, resource);
      withPlaybackAdmission(f, { client: admin, user: identity.id, room: where.id, session: id }, `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${quote(id)},${quote(identity.id)},${quote(where.id)},${quote(mediaId)},1,${quote(digest(token))},${quote(JSON.stringify({ encrypted: encrypt(resource) }))}::jsonb,clock_timestamp()+interval '1 hour'); INSERT INTO media_jobs(id,session_id,status,spec,max_attempts) VALUES(${quote(id)},${quote(id)},'queued',${quote(JSON.stringify({ input_ticket: encrypt({ token }), source_kind: "http", transcode: true, start_seconds: 0, estimated_output_bytes: 65536 }))}::jsonb,${maximum})`);
      return id;
    };
    await check("actual Worker expiry normalization and transport retry expose committed fixed counts", async () => {
      const where = await room("owned Worker events"), expired = legacy(where, "/unavailable");
      // Synthetic initial expired-running inventory, not a claimed execution.
      f.sql(`UPDATE media_jobs SET status='running',attempt=1,lease_until=clock_timestamp()-interval '1 second',owner_id=${quote(randomUUID())} WHERE id=${quote(expired)}`);
      await f.startWorker(); workerPids.push(f.workerPid);
      await until(async () => (await scrape("worker"))[4] === 1, "Actual Worker normalizes expired lease");
      assert.deepEqual(await scrape("worker"), [0, 0, 1, 0, 1, 0]);
      await f.waitForSql(`SELECT status FROM media_jobs WHERE id=${quote(expired)}`, "failed", 12000);
      const transport = legacy(where, "/unavailable"), before = await scrape("worker");
      await until(async () => (await scrape("worker"))[0] === before[0] + 1, "Actual Worker transport finish schedules one retry");
      await f.waitForSql(`SELECT status FROM media_jobs WHERE id=${quote(transport)}`, "failed", 12000);
      const after = await scrape("worker"); assert.deepEqual(difference(after, before), [1, 0, 0, 0, 0, 0]);
      assert.equal(f.sql(`SELECT attempt FROM media_jobs WHERE id=${quote(transport)}`), "2");
      return { initial_running_row_explicitly_synthetic: true, expiry_counters: [0, 0, 1, 0, 1, 0],
        transport_before: before, transport_after: after, terminal_attempt: 2, loopback_source_requests: upstreamRequests };
    });
    if (childReapOnly) { await f.startWorker(); workerPids.push(f.workerPid); }
    await check(childReapCheckName, async () => {
      const where = await room("owned actual child cancellation"), id = legacy(where, "/blocked", 3), before = await scrape();
      await until(() => f.sql(`SELECT status FROM media_jobs WHERE id=${quote(id)}`) === "running", "Actual Worker claim");
      await until(() => blockedRequests > 0, "Current media execution reaches the real controlled HTTP source");
      const children = await until(async () => { const children = await childrenOf(f.workerPid, id); return children.length ? children : null; }, "Positive live media child bound to current job UUID");
      for (const pid of children) mediaChildren.add(pid);
      assert.equal(f.sql(`SELECT count(*) FROM media_executions WHERE job_id=${quote(id)} AND reaped_at IS NULL`), "1");
      await stop(id); assert.equal(status(id), "cancelled");
      const observed = await assertDelta(before, [0, 0, 0, 1, 0, 0]);
      await until(() => children.every(verifyPidAbsent), "Every witnessed actual media child gone", 12000);
      await f.waitForSql(`SELECT count(*) FROM media_executions WHERE job_id=${quote(id)} AND reaped_at IS NULL`, "0", 12000);
      return { ...observed, job_id: id, positive_live_child_pids: children, child_pids_absent: true,
        current_job_uuid_path_component_matched_in_memory: true, actual_source_request_witness: true,
        separate_durable_reap_receipt: true, counter_alone_is_not_os_drain_proof: true };
    });
    await f.stopWorker();
    assert.equal(await verifyClosedPort(Number(new URL(f.workerOrigin).port)), true);
    await check("actual Worker restart resets observed transition counters", async () => {
      await f.startWorker(); workerPids.push(f.workerPid);
      assert.deepEqual(await scrape("worker"), [0, 0, 0, 0, 0, 0]);
      return { prior_process_closed: true, restarted_process: f.workerPid, reset_counts: [0, 0, 0, 0, 0, 0] };
    });
  });
  await verifyBinding(); report.result = "passed";
} catch (error) { failure = error; report.failure = { message: error.message }; }
finally {
  const cleanupErrors = [];
  for (const socket of sockets) socket.terminate();
  if (upstream) {
    try { for (const socket of upstreamSockets) socket.destroy(); await new Promise((done) => upstream.close(done));
      assert.equal(await verifyClosedPort(upstreamPort), true); } catch (error) { cleanupErrors.push(error.message); failure ??= error; }
  }
  if (fixture) {
    try { report.cleanup = { ...(await fixture.verifyStopped()), worker_pids: workerPids, worker_pids_absent: true,
      worker_port_closed: await verifyClosedPort(Number(new URL(fixture.workerOrigin).port)),
      media_child_pids: [...mediaChildren], media_child_pids_absent: true, helper_processes: helperProcesses,
      controlled_upstream_port: upstreamPort ?? null, controlled_upstream_port_closed: !upstreamPort || await verifyClosedPort(upstreamPort) };
      assert.equal(report.cleanup.worker_port_closed, true);
      for (const pid of [...workerPids, ...mediaChildren, ...helperProcesses.map((item) => item.pid)]) assert.equal(verifyPidAbsent(pid), true);
      for (const record of helperProcesses) assert.equal(record.closed, true);
    } catch (error) { cleanupErrors.push(error.message); failure ??= error; }
  }
  try { await verifyBinding(); report.frozen_inputs_verified_after_cleanup = true; }
  catch (error) { cleanupErrors.push(error.message); failure ??= error; }
  if (cleanupErrors.length) { report.cleanup_errors = cleanupErrors; report.result = "failed"; }
  report.finished_at = new Date().toISOString();
  if (fixture) { const path = resolve(fixture.root, "report.json");
    await writeFile(path, JSON.stringify(report, null, 2) + "\n"); console.log(`Evidence: ${path}`); }
}
if (failure) throw failure;
