import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedServer } from "./fixtures/server.mjs";

const owner = randomUUID(), oldRoom = randomUUID(), agent = randomUUID();
const oldRuns = Array.from({ length: 3 }, () => randomUUID());
const cases = [];
let fixture;
const report = { result: "running", cases, failures: [] };
function passed(name) { cases.push(name); console.log(`PASS: ${name}`); }
const roomSql = (id) => `INSERT INTO rooms(id,name,owner_id) VALUES('${id}','scope fixture','${owner}')`;
const runSql = (id, extra = "", values = "") => `INSERT INTO agent_transfer_runs(id,agent_id,resource_hash,head,status,finished_at${extra}) VALUES('${id}','${agent}','scope-${id}',false,'cancelled',now()-interval '3 days'${values})`;
function interactive(f) {
  const child = f.sqlProcess(undefined, { interactive: true });
  child.errors = "";
  child.stderr.on("data", bytes => { child.errors += bytes.toString(); });
  child.command = async sql => {
    const marker = `scope-ready-${randomUUID()}`;
    await new Promise((done, reject) => {
      let output = "";
      const data = bytes => { output += bytes.toString(); if (output.includes(marker)) { child.stdout.off("data", data); done(); } };
      child.stdout.on("data", data);
      child.done.catch(reject);
      child.stdin.write(`${sql}; SELECT '${marker}';\n`);
    });
  };
  child.finish = async (action = "COMMIT") => { child.stdin.end(`${action};\n\\q\n`); await child.done; };
  return child;
}
async function waiting(f, name) {
  await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${name}' AND wait_event_type='Lock'`, "1");
}
try {
  await isolatedServer("legacy-nas-scope", async f => {
    fixture = f;
    report.postgres = f.postgresDiagnostics();
    assert.equal(f.sql("SELECT count(*) FROM _sqlx_migrations WHERE version=30 AND success"), "1");
    assert.equal(f.sql("SELECT ordinal FROM room_cleanup_birth_counter"), "1");
    assert.equal(f.sql(`SELECT count(*) FROM agent_transfer_runs WHERE id IN('${oldRuns.join("','")}') AND legacy_unconfirmed AND possible_room_cutoff=1 AND agent_drained_at IS NULL`), "3");
    const admin = f.client(); await admin.login();
    const close = async id => {
      const value = await admin.request(`/rooms/${id}/lifecycle`);
      await admin.request(`/rooms/${id}/close`, "POST", { expected_revision: value.state.revision });
    };
    await close(oldRoom);
    await f.waitForSql(`SELECT last_error FROM room_cleanup_tasks WHERE room_id='${oldRoom}'`, "legacy_agent_drain_unconfirmed");
    passed("actual 1–29→30 migration scopes every preexisting legacy status to all preexisting rooms without ACKs");
    const fresh = await admin.request("/rooms", "POST", { name: "causally later room" });
    f.sql(`UPDATE rooms SET created_at='1900-01-01' WHERE id='${fresh.id}'`);
    await close(fresh.id);
    await f.waitForSql(`SELECT lifecycle FROM rooms WHERE id='${fresh.id}'`, "closed");
    assert.equal(f.sql(`SELECT lifecycle FROM rooms WHERE id='${oldRoom}'`), "closing");
    passed("a causally later empty room closes while the old room remains blocked");

    const latest = await admin.request("/rooms", "POST", { name: "late old Worker candidate" });
    const late = randomUUID(); f.sql(runSql(late));
    assert.equal(f.sql(`SELECT t.possible_room_cutoff>=r.cleanup_birth_ordinal FROM agent_transfer_runs t,rooms r WHERE t.id='${late}' AND r.id='${latest.id}'`), "t");
    await close(latest.id);
    await f.waitForSql(`SELECT last_error FROM room_cleanup_tasks WHERE room_id='${latest.id}'`, "legacy_agent_drain_unconfirmed");
    passed("an old Worker INSERT after migration captures the latest committed room and blocks its close");

    // Legacy first holds the counter until commit; a later room cannot acquire
    // its birth ordinal early and sneak into the already-captured uncertainty.
    const legacyFirst = interactive(f), firstRun = randomUUID(), after = randomUUID();
    await legacyFirst.command(`BEGIN; ${runSql(firstRun)}`);
    const afterProcess = f.sqlProcess(`SET application_name='scope-legacy-first'; ${roomSql(after)}`);
    await waiting(f, "scope-legacy-first");
    await legacyFirst.finish(); await afterProcess.done;
    assert.equal(f.sql(`SELECT r.cleanup_birth_ordinal>t.possible_room_cutoff FROM rooms r,agent_transfer_runs t WHERE r.id='${after}' AND t.id='${firstRun}'`), "t");
    passed("legacy-first concurrent commit orders a waiting room strictly after the cutoff");

    const roomFirst = interactive(f), before = randomUUID(), afterRun = randomUUID();
    await roomFirst.command(`BEGIN; ${roomSql(before)}`);
    const runProcess = f.sqlProcess(`SET application_name='scope-room-first'; ${runSql(afterRun)}`);
    await waiting(f, "scope-room-first");
    await roomFirst.finish(); await runProcess.done;
    assert.equal(f.sql(`SELECT r.cleanup_birth_ordinal<=t.possible_room_cutoff FROM rooms r,agent_transfer_runs t WHERE r.id='${before}' AND t.id='${afterRun}'`), "t");
    passed("room-first concurrent commit forces the waiting legacy cutoff to include that room");

    const rollbackRoom = interactive(f), rolledRoom = randomUUID(), afterRollback = randomUUID();
    const previous = f.sql("SELECT ordinal FROM room_cleanup_birth_counter");
    await rollbackRoom.command(`BEGIN; ${roomSql(rolledRoom)}`);
    const rollbackWait = f.sqlProcess(`SET application_name='scope-room-rollback'; ${runSql(afterRollback)}`);
    await waiting(f, "scope-room-rollback");
    await rollbackRoom.finish("ROLLBACK"); await rollbackWait.done;
    assert.equal(f.sql(`SELECT count(*) FROM rooms WHERE id='${rolledRoom}'`), "0");
    assert.equal(f.sql(`SELECT possible_room_cutoff FROM agent_transfer_runs WHERE id='${afterRollback}'`), previous);
    const reused = randomUUID(); f.sql(roomSql(reused));
    assert.equal(f.sql(`SELECT cleanup_birth_ordinal FROM rooms WHERE id='${reused}'`), String(BigInt(previous) + 1n));
    passed("room rollback releases the counter with no visible room and safely permits ordinal reuse");

    const rollbackLegacy = interactive(f), rolledRun = randomUUID(), afterRolledRun = randomUUID();
    await rollbackLegacy.command(`BEGIN; ${runSql(rolledRun)}`);
    const rollbackRoomWait = f.sqlProcess(`SET application_name='scope-legacy-rollback'; ${roomSql(afterRolledRun)}`);
    await waiting(f, "scope-legacy-rollback");
    await rollbackLegacy.finish("ROLLBACK"); await rollbackRoomWait.done;
    assert.equal(f.sql(`SELECT count(*) FROM agent_transfer_runs WHERE id='${rolledRun}'`), "0");
    passed("legacy rollback releases a waiting room without inventing a transfer or receipt");

    const stale = interactive(f), staleRun = randomUUID();
    await stale.command("\\set VERBOSITY verbose\nBEGIN ISOLATION LEVEL REPEATABLE READ; SELECT ordinal FROM room_cleanup_birth_counter");
    f.sql(roomSql(randomUUID()));
    stale.stdin.end(`${runSql(staleRun)}; COMMIT;\n`);
    await assert.rejects(stale.done);
    assert.match(stale.errors, /40001|could not serialize access/);
    assert.equal(f.sql(`SELECT count(*) FROM agent_transfer_runs WHERE id='${staleRun}'`), "0");
    passed("a stale REPEATABLE READ snapshot aborts rather than committing a low cutoff");

    const held = interactive(f), modern = randomUUID();
    await held.command(`BEGIN; ${roomSql(randomUUID())}`);
    const modernProcess = f.sqlProcess(runSql(modern, ",legacy_unconfirmed", ",false"));
    await Promise.race([modernProcess.done, new Promise((_, reject) => setTimeout(() => reject(new Error("modern offer waited for birth counter")), 3000))]);
    assert.equal(f.sql(`SELECT possible_room_cutoff IS NULL FROM agent_transfer_runs WHERE id='${modern}'`), "t");
    await held.finish("ROLLBACK");
    passed("current tracked INSERTs bypass the birth counter and retain NULL cutoff");

    for (const sql of [
      `INSERT INTO rooms(id,name,owner_id,cleanup_birth_ordinal) VALUES('${randomUUID()}','forged','${owner}',999999)`,
      runSql(randomUUID(), ",possible_room_cutoff", ",0"),
      `UPDATE rooms SET cleanup_birth_ordinal=999999 WHERE id='${oldRoom}'`,
      `UPDATE rooms SET id='${randomUUID()}' WHERE id='${after}'`,
      `UPDATE agent_transfer_runs SET possible_room_cutoff=0 WHERE id='${late}'`,
      `UPDATE agent_transfer_runs SET legacy_unconfirmed=false,possible_room_cutoff=NULL WHERE id='${late}'`,
      `UPDATE agent_transfer_runs SET legacy_unconfirmed=true WHERE id='${modern}'`,
      "UPDATE room_cleanup_birth_counter SET ordinal=0", "DELETE FROM room_cleanup_birth_counter", "TRUNCATE room_cleanup_birth_counter",
      "INSERT INTO room_cleanup_birth_counter(singleton,ordinal) VALUES(true,0)",
    ]) assert.throws(() => f.sql(sql), /database_assigned|immutable|counter_managed/);
    const session = randomUUID(), orphan = randomUUID();
    f.sql(`INSERT INTO playback_sessions(id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${session}','${oldRoom}',0,'${session}','{}',now()),('${orphan}',NULL,0,'${orphan}','{}',now())`);
    for (const sql of [
      `UPDATE playback_sessions SET room_id='${fresh.id}' WHERE id='${session}'`,
      `UPDATE playback_sessions SET room_id='${fresh.id}' WHERE id='${orphan}'`,
      `UPDATE playback_sessions SET id='${randomUUID()}' WHERE id='${session}'`,
    ]) assert.throws(() => f.sql(sql), /playback_room_identity_immutable/);
    passed("forged ordinals/cutoffs, scope rewrites, grant relocation and counter mutation fail closed");

    const retained = f.sql("SELECT count(*) FROM agent_transfer_runs WHERE legacy_unconfirmed");
    const main = await readFile("apps/server/src/main.rs", "utf8");
    const sweep = [...main.matchAll(/"((?:UPDATE agent_transfer_runs SET status='failed'|DELETE FROM agent_transfer_runs)[^"\n]*)"/g)].map(match => match[1]);
    assert.equal(sweep.length, 2);
    for (const sql of sweep) f.sql(sql);
    f.sql("DELETE FROM agent_transfer_runs WHERE finished_at<now()-interval '24 hours'");
    assert.equal(f.sql("SELECT count(*) FROM agent_transfer_runs WHERE legacy_unconfirmed"), retained);
    assert.equal(f.sql("SELECT count(*) FROM agent_transfer_runs WHERE legacy_unconfirmed AND agent_drained_at IS NOT NULL"), "0");
    f.sql(`UPDATE agent_transfer_runs SET agent_drained_at=now() WHERE id='${late}'`);
    assert.equal(f.sql(`SELECT legacy_unconfirmed FROM agent_transfer_runs WHERE id='${late}'`), "t");
    passed("current and old retention preserve every legacy scope; an ordinary receipt never clears it");

    const mapped = await admin.request("/rooms", "POST", { name: "current mapped receipt remains mandatory" });
    const mappedSession=randomUUID(), mappedRun=randomUUID();
    f.sql(`INSERT INTO playback_sessions(id,room_id,generation,delivery_token_hash,resource,expires_at,stopped) VALUES('${mappedSession}','${mapped.id}',0,'${mappedSession}','{"upstream_closed":true}',now(),true); ${runSql(mappedRun, ",legacy_unconfirmed,session_id,dispatched_at", `,false,'${mappedSession}',now()`)}`);
    await close(mapped.id);
    await f.waitForSql(`SELECT last_error FROM room_cleanup_tasks WHERE room_id='${mapped.id}'`, "agent_transfer_drain_unconfirmed");
    assert.equal(f.sql(`SELECT possible_room_cutoff IS NULL AND agent_drained_at IS NULL FROM agent_transfer_runs WHERE id='${mappedRun}'`), "t");
    // Synthetic positive receipt tests the unchanged predicate. Real authenticated
    // Agent disposal/replay is exercised by the existing receipt integration suite.
    f.sql(`UPDATE agent_transfer_runs SET agent_drained_at=now() WHERE id='${mappedRun}'; UPDATE room_cleanup_tasks SET next_attempt_at=now() WHERE room_id='${mapped.id}'`);
    await f.waitForSql(`SELECT lifecycle FROM rooms WHERE id='${mapped.id}'`, "closed");
    passed("current mapped transfers still block their own later room until a positive receipt exists");

    await f.startServer();
    assert.equal(f.sql(`SELECT lifecycle FROM rooms WHERE id='${oldRoom}'`), "closing");
    const final = await admin.request("/rooms", "POST", { name: "future after restart" });
    await close(final.id);
    await f.waitForSql(`SELECT lifecycle FROM rooms WHERE id='${final.id}'`, "closed");
    passed("restart preserves old uncertainty and later-room availability");
    report.result = "passed";
  }, { beforeStart: async f => {
    fixture = f;
    f.sql("CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY,description TEXT NOT NULL,installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),success BOOLEAN NOT NULL,checksum BYTEA NOT NULL,execution_time BIGINT NOT NULL)");
    for (const name of (await readdir("migrations")).filter(name => name.endsWith(".sql") && Number(name.split("_")[0]) <= 29).sort()) {
      const bytes = await readFile(`migrations/${name}`), version = Number(name.split("_")[0]);
      const description = name.replace(/^\d+_/, "").replace(/\.sql$/, "").replaceAll("_", " ");
      f.sql(`BEGIN; ${bytes}; INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(${version},'${description}',true,decode('${createHash("sha384").update(bytes).digest("hex")}','hex'),0); COMMIT`);
    }
    const state = { room_id: oldRoom, revision: 0, media_id: null, media_generation: 0, playback_status: "paused", anchor_position_ms: 0, anchor_server_time_ms: 0, playback_rate: 1, controller_user_id: owner, duration_ms: null, clock_epoch: randomUUID() };
    f.sql(`INSERT INTO users(id,username,password_hash,admin) VALUES('${owner}','admin','${f.legacyPasswordHash(f.password)}',true); ${roomSql(oldRoom)}; UPDATE rooms SET created_at='2099-01-01' WHERE id='${oldRoom}'; INSERT INTO room_members VALUES('${oldRoom}','${owner}'); INSERT INTO room_snapshots VALUES('${oldRoom}','${JSON.stringify(state)}'); INSERT INTO agents(id,name) VALUES('${agent}','legacy scope fixture')`);
    for (const [i, id] of oldRuns.entries()) {
      const status = ["offered", "completed", "cancelled"][i];
      f.sql(`INSERT INTO agent_transfer_runs(id,agent_id,resource_hash,head,status,finished_at) VALUES('${id}','${agent}','legacy-${status}',false,'${status}',${i ? "now()-interval '3 days'" : "NULL"})`);
    }
  } });
} catch (error) {
  report.result = "failed"; report.failures.push(error.stack ?? String(error)); throw error;
} finally {
  if (fixture) {
    report.cleanup = await fixture.verifyStopped();
    await writeFile(resolve(fixture.root, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Evidence: ${resolve(fixture.root, "report.json")}`);
  }
}
