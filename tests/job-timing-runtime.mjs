// Finite native PostgreSQL and actual Server/Worker timing evidence.
// The central successful binding freezes source, services, helper and driver.
// This driver never compiles, installs, or reuses the old frozen event batch.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.argv.length, 2, "Only the complete finite timing matrix is supported");
const bindingPath = process.env.RAINSYNC_JOB_TIMING_BINDING_FILE ?? process.env.W03_BACKEND_BINDING;
assert.ok(bindingPath, "Use the central final timing binding; required new timing source and helper reject old event bindings");
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, "Use an owned native PostgreSQL cluster");
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Use external evidence storage");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const bindingBytes = await readFile(bindingPath), binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed"); assert.equal(binding.build.exit_code, 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
for (const name of ["rainsync-server", "rainsync-media-worker"])
  assert.equal(resolve(binding.binaries.find(item => item.name === name)?.path ?? "missing"), resolve(target, name));
const helper = binding.test_helpers?.find(item => item.name === "verify_job_phase_timings");
assert.ok(helper, "New timing helper is frozen in final binding");
assert.equal(resolve(helper.path), resolve(target, "examples", "verify_job_phase_timings"));
const required = ["crates/media-core/src/job_health.rs", "crates/media-core/src/job_health_timing.rs",
  "crates/persistence/src/media_job_timing.rs", "crates/persistence/src/media_jobs.rs", "crates/persistence/src/media_queue.rs",
  "crates/persistence/src/media_outputs.rs", "crates/persistence/examples/verify_job_phase_timings.rs",
  "apps/server/src/media.rs", "migrations/0039_media_job_timing.sql"];
for (const path of required) assert.ok(binding.source.some(item => item.path === path), `Bound timing producer/driver ${path}`);
const coordinator = await Promise.all(["tests/job-timing-runtime.mjs", "tests/fixtures/server.mjs", "tests/fixtures/media-stack.mjs",
  "tests/fixtures/postgres.mjs", "tests/fixtures/source-grant.mjs", "tests/fixtures/playback-admission.mjs"].map(async path => ({ path, sha256: digest(await readFile(resolve(repo, path))) })));
async function hashFile(path) { const hash = createHash("sha256"); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest("hex"); }
async function verifyBinding() {
  assert.equal(digest(await readFile(bindingPath)), digest(bindingBytes));
  for (const item of [...binding.source, ...coordinator]) assert.equal(await hashFile(resolve(repo, item.path)), item.sha256, `Frozen source ${item.path}`);
  for (const item of [...binding.binaries, ...(binding.test_helpers ?? [])]) assert.equal(await hashFile(item.path), item.sha256, `Frozen executable ${item.name}`);
}
await verifyBinding();
const bounds = ["0.01", "0.05", "0.1", "0.5", "1", "5", "30", "120", "600", "3600", "21600", "86400", "+Inf"];
const slots = [["queue", "started"], ["queue", "failed"], ["queue", "cancelled"], ["run", "succeeded"], ["run", "failed"], ["run", "cancelled"], ["run", "retry"]];
function timings(text, processLabel) {
  const lines = text.split("\n").filter(line => /^rainsync_media_job_(queue_duration_seconds_|run_duration_seconds_|timing_unknown_total\{)/.test(line));
  assert.equal(lines.length, 112, "Exactly seven fixed histograms and seven typed unknown series");
  const rows = lines.map(line => {
    const match = /^(\w+)\{([^}]*)\} ([0-9.eE+-]+)$/.exec(line); assert.ok(match, `Finite numeric timing sample: ${line}`);
    const labels = {};
    for (const raw of match[2].split(",")) { const pair = /^(\w+)="([^"]*)"$/.exec(raw); assert.ok(pair); assert.equal(labels[pair[1]], undefined); labels[pair[1]] = pair[2]; }
    assert.equal(labels.process, processLabel); const value = Number(match[3]); assert.ok(Number.isFinite(value) && value >= 0);
    if (match[1].endsWith("_bucket")) { assert.deepEqual(Object.keys(labels), ["process", "outcome", "le"]); assert.ok(bounds.includes(labels.le)); }
    else if (match[1].endsWith("unknown_total")) assert.deepEqual(Object.keys(labels), ["process", "phase", "outcome"]);
    else assert.deepEqual(Object.keys(labels), ["process", "outcome"]);
    if (!match[1].endsWith("_sum")) assert.ok(Number.isSafeInteger(value));
    return { name: match[1], labels, value };
  });
  const sample = (name, labels) => { const found = rows.filter(row => row.name === name && JSON.stringify(row.labels) === JSON.stringify(labels)); assert.equal(found.length, 1, `One fixed ${name} ${JSON.stringify(labels)}`); return found[0].value; };
  const result = slots.map(([phase, outcome]) => {
    const family = `rainsync_media_job_${phase}_duration_seconds`, labels = { process: processLabel, outcome };
    const buckets = bounds.map(le => sample(family + "_bucket", { ...labels, le }));
    const known = sample(family + "_count", labels), sum = sample(family + "_sum", labels);
    assert.equal(buckets.at(-1), known); assert.ok(buckets.every((value, index) => value <= known && (!index || value >= buckets[index - 1])));
    const unknown = sample("rainsync_media_job_timing_unknown_total", { process: processLabel, phase, outcome });
    if (!known) { assert.equal(sum, 0); assert.deepEqual(buckets, bounds.map(() => 0)); }
    return { known, unknown, sum, buckets };
  });
  assert.match(text, new RegExp(`rainsync_media_job_observation_available\\{process="${processLabel}"\\} 1`));
  assert.match(text, new RegExp(`rainsync_media_job_observation_incomplete\\{process="${processLabel}"\\} 0`));
  return result;
}
const zero = () => slots.map(() => ({ known: 0, unknown: 0, sum: 0, buckets: bounds.map(() => 0) }));
function changes(after, before) { return after.map((item, i) => ({ known: item.known - before[i].known, unknown: item.unknown - before[i].unknown, sum: item.sum - before[i].sum, buckets: item.buckets.map((value, j) => value - before[i].buckets[j]) })); }
function counts(delta) { return delta.map(({ known, unknown }) => [known, unknown]); }
function expected(slot, known = 1, unknown = 0) { const value = slots.map(() => [0, 0]); value[slot] = [known, unknown]; return value; }
const report = { schema_version: 1, result: "failed", started_at: new Date().toISOString(), checks: [],
  scope: "Finite owned PostgreSQL production helper and actual authenticated Server/Worker HTTP metrics. Histograms measure acknowledged logical phase ends; helper-labelled metrics are explicitly separate. No physical-drain or long-duration acceptance claim.",
  binding: { path: resolve(bindingPath), sha256: digest(bindingBytes), source_digest: binding.source_digest, binaries: binding.binaries, test_helpers: binding.test_helpers, coordinator } };
let fixture, failure, upstream, upstreamPort; const helperProcesses = [], workerPids = [], upstreamSockets = new Set();
async function check(name, run) { const entry = { name, result: "failed" }, began = Date.now(); report.checks.push(entry);
  try { Object.assign(entry, await run(), { result: "passed" }); console.log(`PASS: ${name}`); } catch (error) { entry.error = error.message; throw error; } finally { entry.elapsed_ms = Date.now() - began; } }
async function until(probe, label, timeout = 12000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await probe(); if (value) return value; await delay(30); } throw Error(`Deadline: ${label}`); }

try {
  await isolatedMediaStack("job-timing-runtime", async f => {
    fixture = f; await f.stopServer();
    await check("real production helper covers phase mutation locking rollback bounded aggregates and missing acknowledgement", async () => {
      const child = spawn(helper.path, [], { env: { ...f.env, RAINSYNC_ISOLATED_TEST: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      const record = { pid: child.pid, binary: helper.path, closed: false }; helperProcesses.push(record);
      let output = "", errors = ""; child.stdout.on("data", bytes => output += bytes); child.stderr.on("data", bytes => errors += bytes);
      const timer = setTimeout(() => child.kill("SIGTERM"), 60000); let code;
      try { code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", value => { record.closed = true; done(value); }); }); } finally { clearTimeout(timer); }
      await writeFile(resolve(f.root, "phase-helper.stdout"), output); await writeFile(resolve(f.root, "phase-helper.stderr"), errors);
      let result; try { result = JSON.parse(output.trim().split("\n").at(-1)); } catch { throw Error(`Phase helper exit ${code}: ${errors.slice(-5000)}`); }
      await writeFile(resolve(f.root, "phase-helper-report.json"), JSON.stringify(result, null, 2) + "\n");
      assert.equal(code, 0, result.failure ?? errors); assert.equal(result.result, "passed"); assert.equal(verifyPidAbsent(child.pid), true);
      assert.equal(f.sql("SELECT count(*) FROM media_jobs"), "0");
      return { helper_checks: result.checks, helper_process_closed: true, cleanup: result.cleanup, process_labels_belong_to_helper: true };
    });
    await f.startServer({ PLAYBACK_SESSION_LIMIT: "10" });
    const admin = f.client(), identity = await admin.login();
    const scrape = async (processLabel = "server") => {
      const response = await fetch(processLabel === "server" ? f.origin + "/api/v1/metrics" : f.workerOrigin + "/metrics", { headers: { Cookie: admin.cookie }, signal: AbortSignal.timeout(6000) });
      assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); assert.match(response.headers.get("content-type"), /text\/plain; version=0\.0\.4/);
      const text = await response.text(); await writeFile(resolve(f.root, `${processLabel}-metrics-latest.txt`), text); return timings(text, processLabel);
    };
    await check("actual authenticated Server exposes exact fixed timing series with auth boundary", async () => {
      assert.deepEqual(await scrape(), zero()); const denied = await fetch(f.origin + "/api/v1/metrics"); assert.equal(denied.status, 401);
      assert.equal((await denied.text()).includes("rainsync_media_job_"), false);
      await admin.request("/users", "POST", { username: "timing-outsider", password: f.password }); const other = f.client(); await other.login("timing-outsider");
      const forbidden = await other.raw("/metrics"); assert.equal(forbidden.status, 403); assert.equal((await forbidden.text()).includes("rainsync_media_job_"), false);
      return { timing_series: 112, unauthenticated_status: 401, non_admin_status: 403 };
    });
    await f.makeClip("timing.mp4", { pictureSeconds: 1 });
    const source = await admin.request("/sources", "POST", { name: "owned timing", kind: "local", config: { root: f.root } }); await admin.request(`/sources/${source.id}/test`, "POST");
    const mediaId = f.sql(`SELECT id FROM media_items WHERE source_id=${quote(source.id)} AND resource='timing.mp4'`);
    const room = async name => { const value = await admin.request("/rooms", "POST", { name }); f.sql(`UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}',${quote(JSON.stringify(mediaId))}::jsonb),'{media_generation}','1') WHERE room_id=${quote(value.id)}`); return value; };
    const prepare = async where => admin.request("/playback-sessions", "POST", { room_id: where.id, media_generation: 1, mode: "transcode", position_ms: 0, idempotency_key: randomUUID() });
    const stop = async (id, client = admin) => client.request(`/playback-sessions/${id}`, "DELETE");
    await check("actual Server Stop credits known queue cancellation once and enforces current owner", async () => {
      const where = await room("timing Stop"), plan = await prepare(where), before = await scrape();
      assert.equal(f.sql(`SELECT timing_version=1 AND timing_attempt=0 AND queue_entered_at IS NOT NULL AND run_started_at IS NULL FROM media_jobs WHERE id=${quote(plan.session_id)}`), "t");
      const other = f.client(); await other.login("timing-outsider"); await stop(plan.session_id, other); assert.deepEqual(await scrape(), before);
      await Promise.all([stop(plan.session_id), stop(plan.session_id)]); await stop(plan.session_id);
      const after = await scrape(), delta = changes(after, before); assert.deepEqual(counts(delta), expected(2));
      assert.equal(f.sql(`SELECT status FROM media_jobs WHERE id=${quote(plan.session_id)}`), "cancelled");
      return { process: "server", before, after, delta, duplicate_requests: 3, foreign_owner_affected_rows: 0 };
    });
    await check("actual Server legacy queue cancellation increments unknown and adds no zero sample", async () => {
      const where = await room("timing legacy Stop"), plan = await prepare(where);
      f.sql(`UPDATE media_jobs SET timing_version=NULL,timing_attempt=NULL,queue_entered_at=NULL,run_started_at=NULL WHERE id=${quote(plan.session_id)}`);
      const before = await scrape(); await stop(plan.session_id); const after = await scrape(), delta = changes(after, before);
      assert.deepEqual(counts(delta), expected(2, 0, 1)); assert.equal(delta[2].sum, 0); assert.deepEqual(delta[2].buckets, bounds.map(() => 0));
      return { process: "server", explicitly_injected_legacy_timing: true, delta };
    });

    let requests = 0;
    upstream = createServer((request, response) => { request.resume(); requests++; response.writeHead(503, { "Content-Length": 0 }).end(); });
    upstream.on("connection", socket => { upstreamSockets.add(socket); socket.on("close", () => upstreamSockets.delete(socket)); });
    await new Promise(done => upstream.listen(0, "127.0.0.1", done)); upstreamPort = upstream.address().port;
    const encrypt = value => { const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"), nonce);
      return Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("base64"); };
    // Only job timing is legacy/unknown; grants have exact current login origin.
    const legacy = (where, maximum = 2) => { const id = randomUUID(), token = randomBytes(24).toString("hex");
      const resource = { kind: "http", job_id: id, url: `http://127.0.0.1:${upstreamPort}/unavailable`, headers: {} }, media = sourceMedia(f, resource);
      withPlaybackAdmission(f, { client: admin, user: identity.id, room: where.id, session: id }, `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${quote(id)},${quote(identity.id)},${quote(where.id)},${quote(media)},1,${quote(digest(token))},${quote(JSON.stringify({encrypted:encrypt(resource)}))}::jsonb,clock_timestamp()+interval '1 hour'); INSERT INTO media_jobs(id,session_id,status,spec,max_attempts) VALUES(${quote(id)},${quote(id)},'queued',${quote(JSON.stringify({input_ticket:encrypt({token}),source_kind:'http',transcode:true,start_seconds:0,estimated_output_bytes:65536}))}::jsonb,${maximum})`); return id; };
    await check("actual Worker fixed timing metrics require authenticated administrator", async () => {
      await f.startWorker(); workerPids.push(f.workerPid); assert.deepEqual(await scrape("worker"), zero());
      const denied = await fetch(f.workerOrigin + "/metrics"); assert.equal(denied.status, 401); assert.equal((await denied.text()).includes("rainsync_media_job_"), false);
      const other = f.client(); await other.login("timing-outsider"); const forbidden = await fetch(f.workerOrigin + "/metrics", { headers: { Cookie: other.cookie } });
      assert.equal(forbidden.status, 403); assert.equal((await forbidden.text()).includes("rainsync_media_job_"), false);
      await f.stopWorker(); return { timing_series:112, unauthenticated_status:401, non_admin_status:403 };
    });
    await check("actual Worker claims legacy queue then reports known retry backoff and terminal running phases", async () => {
      const where = await room("timing Worker"), id = legacy(where); await f.startWorker(); workerPids.push(f.workerPid);
      const before = zero(); await f.waitForSql(`SELECT status FROM media_jobs WHERE id=${quote(id)}`, "failed", 15000);
      const after = await until(async () => { const value = await scrape("worker"); return value[4].known === 1 ? value : null; }, "Acknowledged Worker terminal timing");
      const delta = changes(after, before), wanted = expected(0, 1, 1); wanted[4] = [1,0]; wanted[6] = [1,0]; assert.deepEqual(counts(delta), wanted);
      assert.ok(delta[0].sum >= 2, "new queue timing includes transport retry backoff"); assert.equal(f.sql(`SELECT attempt FROM media_jobs WHERE id=${quote(id)}`), "2"); assert.ok(requests > 0);
      await f.stopWorker(); return { process:"worker", initial_row_explicitly_legacy:true, delta, controlled_upstream_requests:requests, terminal_attempt:2 };
    });
    await check("actual Worker expired legacy run is unknown then enters known queued and run phases", async () => {
      const where = await room("timing Worker expiry"), id = legacy(where);
      f.sql(`UPDATE media_jobs SET status='running',attempt=1,lease_until=clock_timestamp()-interval '1 second',owner_id=${quote(randomUUID())} WHERE id=${quote(id)}`);
      await f.startWorker(); workerPids.push(f.workerPid); await f.waitForSql(`SELECT status FROM media_jobs WHERE id=${quote(id)}`, "failed", 15000);
      const after = await until(async () => { const value = await scrape("worker"); return value[4].known === 1 ? value : null; }, "Acknowledged expiry terminal timing");
      const wanted = expected(0); wanted[4]=[1,0]; wanted[6]=[0,1]; assert.deepEqual(counts(after), wanted); assert.ok(after[0].sum >= 2);
      await f.stopWorker(); assert.equal(await verifyClosedPort(Number(new URL(f.workerOrigin).port)), true);
      return {process:"worker",initial_expired_running_row_explicitly_synthetic:true,after};
    });
    await check("actual Worker restart resets timing observations", async () => { await f.startWorker(); workerPids.push(f.workerPid); assert.deepEqual(await scrape("worker"), zero()); await f.stopWorker(); return {reset:true}; });
  });
  await verifyBinding(); report.result = "passed";
} catch (error) { failure = error; report.failure = { message:error.message }; }
finally {
  const errors = [];
  if (upstream) try { for (const socket of upstreamSockets) socket.destroy(); await new Promise(done => upstream.close(done)); assert.equal(await verifyClosedPort(upstreamPort), true); } catch (error) { errors.push(error.message); failure ??= error; }
  if (fixture) try { report.cleanup = { ...(await fixture.verifyStopped()), worker_pids:workerPids, helper_processes:helperProcesses,
    worker_pids_absent:true,worker_port_closed:await verifyClosedPort(Number(new URL(fixture.workerOrigin).port)),controlled_upstream_port:upstreamPort ?? null,controlled_upstream_port_closed:!upstreamPort || await verifyClosedPort(upstreamPort) };
    assert.equal(report.cleanup.worker_port_closed,true); for (const pid of [...workerPids,...helperProcesses.map(item=>item.pid)]) assert.equal(verifyPidAbsent(pid),true);
    for (const record of helperProcesses) assert.equal(record.closed,true);
  } catch(error) { errors.push(error.message); failure ??= error; }
  try { await verifyBinding(); report.frozen_inputs_verified_after_cleanup=true; } catch(error) { errors.push(error.message); failure ??= error; }
  if(errors.length) { report.cleanup_errors=errors; report.result="failed"; } report.finished_at=new Date().toISOString();
  if(fixture) { const path=resolve(fixture.root,"report.json"); await writeFile(path,JSON.stringify(report,null,2)+"\n"); console.log(`Evidence: ${path}`); }
}
if(failure) throw failure;
