// Real native Server/Worker/Agent and an intentionally paused HTTP consumer.
// The only injected fault is a row lock in this fixture's disposable database.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { open, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

assert.equal(process.platform, "linux", "This evidence measures Linux /proc descriptors");
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, "Use a disposable native PostgreSQL cluster");
const sha256 = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const report = { schema_version: 1, started_at: new Date().toISOString(), result: "running", cases: [], limitations: ["Short local sparse-file transfer; no decode, throughput capacity, NAS filesystem or two-hour acceptance"] };
let fixture;
async function until(check, label, timeout = 20000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (await check()) return; await delay(25); }
  throw Error(`deadline: ${label}`);
}
try {
  await isolatedMediaStack("relay-lease-health", async f => {
    fixture = f;
    const files = execFileSync("git", ["ls-files", "apps/server", "apps/media-worker", "apps/nas-agent", "crates", "migrations", "Cargo.toml", "Cargo.lock"], { encoding: "utf8" }).trim().split(/\r?\n/).sort();
    files.push("tests/relay-lease-health.mjs", "tests/fixtures/media-stack.mjs", "tests/fixtures/server.mjs", "tests/fixtures/postgres.mjs");
    report.source = await Promise.all(files.map(async path => ({ path, sha256: await sha256(path) })));
    report.binaries = await Promise.all(["rainsync-server", "rainsync-media-worker", "rainsync-nas-agent"].map(async name => ({ name, sha256: await sha256(resolve(f.target, name)) })));
    const admin = f.client(), identity = await admin.login();
    const size = 1024 * 1024 * 1024;
    const mediaPath = resolve(f.root, "long.mp4");
    const file = await open(mediaPath, "w"); await file.truncate(size); await file.close();
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"), nonce);
    const encrypt = value => Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("base64");
    await f.startWorker();
    const { agentId } = await f.startAgent();
    await f.waitForSql(`SELECT count(*) FROM media_items WHERE source_id='${agentId}' AND resource='long.mp4' AND source_version IS NOT NULL`, "1", 20000);
    const sourceVersion = f.sql(`SELECT source_version FROM media_items WHERE source_id='${agentId}' AND resource='long.mp4'`);
    const room = await admin.request("/rooms", "POST", { name: "isolated relay unknown renewal" });
    const session = randomUUID(), token = randomBytes(32).toString("hex");
    const encrypted = encrypt({ kind: "agent", agent_id: agentId, resource: "long.mp4", source_version: sourceVersion });
    f.sql(`INSERT INTO playback_sessions(media_id,id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES((SELECT id FROM media_items WHERE source_id='${agentId}' AND resource='long.mp4'),'${session}','${identity.id}','${room.id}',0,'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${encrypted}"}',now()+interval '1 hour')`);
    const stream = { response: null, aborted: false, ended: false };
    const req = request(`${f.workerOrigin}/media-delivery/${session}/source?token=${token}`, res => {
      stream.response = res;
      res.on("error", () => {}); res.on("aborted", () => { stream.aborted = true; });
      res.on("end", () => { stream.ended = true; });
      res.pause();
    });
    req.on("error", () => {}); req.end();
    async function handles() {
      let count = 0;
      for (const fd of await readdir(`/proc/${f.agentPid}/fd`)) {
        try { if (await readlink(`/proc/${f.agentPid}/fd/${fd}`) === mediaPath) count++; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return count;
    }
    try {
      await until(() => stream.response, "real NAS headers");
      assert.equal(stream.response.statusCode, 200);
      assert.equal(Number(stream.response.headers["content-length"]), size);
      await until(async () => (await handles()) > 0, "real NAS source handle");
      const transfer = f.sql(`SELECT id FROM agent_transfer_runs WHERE session_id='${session}'`);
      assert.match(transfer, /^[a-f\d-]{36}$/);
      const lockTag = `owned-relay-lock-${randomUUID()}`;
      const began = performance.now();
      const locked = f.sqlProcess(`BEGIN; SELECT id FROM agent_transfer_runs WHERE id='${transfer}' FOR UPDATE; SELECT pg_sleep(14.5) /* ${lockTag} */; COMMIT;`);
      await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${lockTag}%'`, "1");
      await delay(13500);
      assert.equal(stream.aborted, false, "a 3s unknown result must not abort the retained HTTP body");
      assert.ok((await handles()) > 0, "Agent still owns the source during the unknown query");
      assert.equal(f.sql(`SELECT agent_drained_at IS NULL AND finished_at IS NULL FROM agent_transfer_runs WHERE id='${transfer}'`), "t");
      await locked.done;
      await until(() => f.sql(`SELECT lease_until>created_at+interval '35 seconds' FROM agent_transfer_runs WHERE id='${transfer}'`) === "t", "same transfer renews after row-lock release");
      assert.equal(stream.aborted, false);
      assert.ok((await handles()) > 0);
      report.cases.push({ case: "real-paused-nas-stream-survives-unknown-renewal", transfer, elapsed_seconds: (performance.now() - began) / 1000, source_handles: await handles(), drain_unconfirmed: true });
      const view = await admin.request(`/rooms/${room.id}/lifecycle`);
      const stoppedAt = performance.now();
      await admin.request(`/rooms/${room.id}/close`, "POST", { expected_revision: view.state.revision });
      await until(async () => (await handles()) === 0, "real NAS source handle release", 10000);
      await f.waitForSql(`SELECT count(*) FROM agent_transfer_runs WHERE id='${transfer}' AND agent_drained_at IS NOT NULL`, "1", 15000);
      await f.waitForSql(`SELECT lifecycle FROM rooms WHERE id='${room.id}'`, "closed", 15000);
      assert.equal(f.sql(`SELECT t.agent_drained_at<=e.created_at FROM agent_transfer_runs t JOIN playback_sessions p ON p.id=t.session_id JOIN room_lifecycle_events e ON e.room_id=p.room_id AND e.lifecycle='closed' WHERE t.id='${transfer}'`), "t");
      stream.response.resume();
      await until(() => stream.aborted, "old paused consumer aborted");
      assert.equal(stream.ended, false);
      report.cases.push({ case: "authorization-stop-drains-real-nas-before-room-closed", stop_seconds: (performance.now() - stoppedAt) / 1000, source_handles: await handles(), authenticated_drain_before_closed: true, http_aborted: true });
      for (const entry of report.source) assert.equal(await sha256(entry.path), entry.sha256, `source stayed unchanged: ${entry.path}`);
      for (const entry of report.binaries) assert.equal(await sha256(resolve(f.target, entry.name)), entry.sha256, `binary stayed unchanged: ${entry.name}`);
      report.result = "passed";
    } finally { req.destroy(); }
  });
} catch (error) {
  report.result = "failed";
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (fixture) {
    try {
      report.cleanup = await fixture.verifyStopped();
      report.cleanup.worker_pid_absent = verifyPidAbsent(fixture.workerPid);
      report.cleanup.agent_pid_absent = verifyPidAbsent(fixture.agentPid);
      report.cleanup.worker_port_closed = await verifyClosedPort(Number(new URL(fixture.workerOrigin).port));
      assert.equal(report.cleanup.worker_pid_absent && report.cleanup.agent_pid_absent && report.cleanup.worker_port_closed, true);
    } catch (error) { report.result = "failed"; report.cleanup_error = String(error.message); process.exitCode = 1; }
    report.finished_at = new Date().toISOString();
    await writeFile(resolve(fixture.root, "report.json"), JSON.stringify(report, null, 2));
    console.log(`${report.result.toUpperCase()}: real relay lease health; ${resolve(fixture.root, "report.json")}`);
  }
}
