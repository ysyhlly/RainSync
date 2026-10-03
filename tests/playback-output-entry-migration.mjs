// Owned PostgreSQL, exact observational trigger and receipt pruning SQL.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedPostgres } from "./fixtures/postgres.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
const id = randomUUID(),
  root = resolve(
    process.env.RAINSYNC_ARTIFACT_DIR,
    "playback-output-entry-migration",
    id,
  );
await mkdir(root, { recursive: true });
const db = isolatedPostgres({ root, name: "entry-metrics-upgrade", id });
const owner = randomUUID(),
  room = randomUUID(),
  viewer = randomUUID(),
  session = randomUUID(),
  expiredSession = randomUUID();
const report = { result: "running", checks: [], migrations: [] };
const sha = (v) => createHash("sha256").update(v).digest("hex");
const check = async (name, fn) => {
  await fn();
  report.checks.push(name);
  console.log(`PASS: ${name}`);
};
const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
const prefix = (job) =>
  JSON.parse(
    db.sql(
      `SELECT jsonb_build_array(metrics_queue_ms,metrics_queue_complete,metrics_queue_accounted_attempt) FROM media_jobs WHERE id=${q(job)}`,
    ),
  );
const job = (fields = "") => {
  const job = randomUUID();
  db.sql(
    `INSERT INTO media_jobs(id,session_id,status,spec,timing_version,timing_attempt,queue_entered_at,run_started_at${fields ? ",metrics_queue_ms,metrics_queue_complete,metrics_queue_accounted_attempt" : ""}) VALUES('${job}','${session}','queued','{}',1,0,clock_timestamp()-interval '2 seconds',NULL${fields ? "," + fields : ""})`,
  );
  return job;
};
const claim = (job, seconds = 1) =>
  db.sql(
    `UPDATE media_jobs SET status='running',attempt=attempt+1,timing_version=1,timing_attempt=attempt+1,run_started_at=queue_entered_at+interval '${seconds} seconds',queue_entered_at=NULL WHERE id='${job}'`,
  );
const phaseClear =
  "timing_version=NULL,timing_attempt=NULL,queue_entered_at=NULL,run_started_at=NULL";
try {
  await db.start();
  report.postgres = db.diagnostics();
  const migrations = (await readdir(resolve(repo, "migrations")))
    .filter((n) => /^\d+_.*\.sql$/.test(n) && Number(n.split("_")[0]) <= 43)
    .sort();
  assert.equal(migrations.length, 43);
  for (const name of migrations.slice(0, 40)) {
    const bytes = await readFile(resolve(repo, "migrations", name));
    db.sql(`BEGIN;${bytes};COMMIT;`);
    report.migrations.push({ name, sha256: sha(bytes) });
  }
  // Seed only generated legacy authority before0041; the upgrade must not invent
  // a login owner or allow the observation trigger to alter that authority.
  db.sql(`INSERT INTO users(id,username,password_hash) VALUES('${owner}','entry-metrics-upgrade','not-for-login');
 INSERT INTO rooms(id,name,owner_id) VALUES('${room}','entry upgrade','${owner}');
 INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at,viewer_id,plan_generation,playback_metrics_version,metrics_meter_start_generation)
 VALUES('${session}','${owner}','${room}',1,'generated-entry-upgrade','{}',now()+interval '1 hour','${viewer}',1,2,1),('${expiredSession}','${owner}','${room}',1,'generated-expired-upgrade','{}',now()+interval '1 hour','${randomUUID()}',1,2,1);
 INSERT INTO media_jobs(id,session_id,status,spec) VALUES('${randomUUID()}','${session}','queued','{}');`);
  await check("otherwise complete v2 grant rejects missing room before login cutover", () => {
    // Isolate the existing0040 shape constraint before0041 also rejects a new
    // user-owned row lacking an admitted request. No constraint is disabled.
    const invalid = randomUUID();
    assert.throws(() => db.sql(`INSERT INTO playback_sessions(id,user_id,generation,delivery_token_hash,resource,expires_at,viewer_id,plan_generation,playback_metrics_version,metrics_meter_start_generation) VALUES('${invalid}','${owner}',0,'owned-invalid-room-v2','{}',clock_timestamp()+interval '1 hour','${randomUUID()}',1,2,1)`), /playback_session_metrics_pair/);
    assert.equal(db.sql(`SELECT count(*) FROM playback_sessions WHERE id='${invalid}'`), "0");
  });
  for (const name of migrations.slice(40)) {
    const bytes = await readFile(resolve(repo, "migrations", name));
    db.sql(`BEGIN;${bytes};COMMIT;`);
    report.migrations.push({ name, sha256: sha(bytes) });
  }
  await check("historical queue prefixes remain entirely unknown", () =>
    assert.equal(
      db.sql(
        "SELECT bool_and(metrics_queue_ms IS NULL AND metrics_queue_complete IS NULL AND metrics_queue_accounted_attempt IS NULL) FROM media_jobs",
      ),
      "t",
    ),
  );
  await check(
    "queued claim records one exact phase and heartbeat repeats do not double count",
    () => {
      const j = job("0,true,0");
      claim(j);
      assert.deepEqual(prefix(j), [1000, true, 1]);
      db.sql(
        `UPDATE media_jobs SET lease_until=clock_timestamp()+interval '30 seconds' WHERE id='${j}'; UPDATE media_jobs SET spec=spec||'{"heartbeat":true}' WHERE id='${j}'`,
      );
      assert.deepEqual(prefix(j), [1000, true, 1]);
      db.sql(
        `UPDATE media_jobs SET status='succeeded',${phaseClear} WHERE id='${j}'`,
      );
      assert.deepEqual(prefix(j), [1000, true, 1]);
      db.sql(`UPDATE media_jobs SET status='succeeded' WHERE id='${j}'`);
      assert.deepEqual(prefix(j), [1000, true, 1]);
    },
  );
  await check(
    "queue claim rollback restores both business state and accumulated prefix",
    () => {
      const j = job("0,true,0");
      const inside = JSON.parse(
        db
          .sql(
            `BEGIN;UPDATE media_jobs SET status='running',attempt=1,timing_version=1,timing_attempt=1,run_started_at=queue_entered_at+interval '1 second',queue_entered_at=NULL WHERE id='${j}';SELECT jsonb_build_array(metrics_queue_ms,metrics_queue_complete,metrics_queue_accounted_attempt) FROM media_jobs WHERE id='${j}';ROLLBACK;`,
          )
          .split("\n")
          .find((line) => line.trim().startsWith("[")),
      );
      assert.deepEqual(inside, [1000, true, 1]);
      assert.deepEqual(prefix(j), [0, true, 0]);
      assert.equal(
        db.sql(`SELECT status||':'||attempt FROM media_jobs WHERE id='${j}'`),
        "queued:0",
      );
      claim(j);
      assert.deepEqual(prefix(j), [1000, true, 1]);
    },
  );
  await check(
    "requeue and retry retain full witnessed queue prefix while running is excluded",
    () => {
      const j = job("0,true,0");
      claim(j);
      db.sql(
        `UPDATE media_jobs SET status='queued',timing_version=1,timing_attempt=attempt,queue_entered_at=run_started_at+interval '10 seconds',run_started_at=NULL WHERE id='${j}'`,
      );
      assert.deepEqual(prefix(j), [1000, true, 1]);
      claim(j, 2);
      assert.deepEqual(prefix(j), [3000, true, 2]);
    },
  );
  await check(
    "queued cancellation closes observed queue; running cancellation cannot add queue",
    () => {
      const j = job("0,true,0");
      db.sql(
        `UPDATE media_jobs SET status='cancelled',${phaseClear} WHERE id='${j}'`,
      );
      const [ms, complete] = prefix(j);
      assert.ok(ms >= 2000 && ms < 5000);
      assert.equal(complete, true);
      const running = job("0,true,0");
      claim(running);
      db.sql(
        `UPDATE media_jobs SET status='cancelled',${phaseClear} WHERE id='${running}'`,
      );
      assert.deepEqual(prefix(running), [1000, true, 1]);
    },
  );
  await check(
    "old-writer phase gap and corrupted tuples permanently withhold completeness",
    () => {
      const j = job("0,true,0");
      db.sql(
        `UPDATE media_jobs SET status='running',attempt=1 WHERE id='${j}'`,
      );
      assert.equal(prefix(j)[1], false);
      db.sql(
        `UPDATE media_jobs SET timing_version=1,timing_attempt=1,run_started_at=clock_timestamp(),queue_entered_at=NULL WHERE id='${j}'`,
      );
      assert.equal(prefix(j)[1], false);
      const corrupt = job("0,true,0");
      db.sql(`UPDATE media_jobs SET timing_attempt=99 WHERE id='${corrupt}'`);
      claim(corrupt);
      assert.equal(prefix(corrupt)[1], false);
      const unknown = job();
      claim(unknown);
      assert.deepEqual(prefix(unknown), [null, null, null]);
      db.sql(
        `UPDATE media_jobs SET metrics_queue_ms=0,metrics_queue_complete=true,metrics_queue_accounted_attempt=1 WHERE id='${unknown}'`,
      );
      assert.deepEqual(prefix(unknown), [null, null, null]);
    },
  );
  await check(
    "overflow and clock regression do not fail scheduling or fabricate complete queue",
    () => {
      const overflow = job("604800000,true,0");
      claim(overflow);
      assert.deepEqual(prefix(overflow), [604800000, false, 0]);
      const backwards = job("0,true,0");
      claim(backwards, -1);
      assert.deepEqual(prefix(backwards), [0, false, 0]);
      assert.equal(
        db.sql(`SELECT status FROM media_jobs WHERE id='${backwards}'`),
        "running",
      );
    },
  );
  const source = await readFile(
    resolve(repo, "crates/persistence/src/room_cleanup.rs"),
    "utf8",
  );
  const lockRoomsSql = source.match(
    /pub const LOCK_PRUNE_ROOMS_SQL: &str = r#"([\s\S]+?)"#;/,
  )[1];
  const deleteSql = source.match(
    /pub const PRUNE_EXECUTIONS_SQL: &str = r#"([\s\S]+?)"#;/,
  )[1];
  const prune = `BEGIN ISOLATION LEVEL READ COMMITTED;CREATE TEMP TABLE owned_prune_rooms ON COMMIT DROP AS ${lockRoomsSql};${deleteSql.replaceAll("$1", "ARRAY(SELECT id FROM owned_prune_rooms)")};COMMIT;`;
  report.pruner_sha256 = sha(prune);
  await check("room-null legacy delivery receipts prune; v2 is excluded by exact pruning predicate", () => {
    const unscoped = randomUUID(), receipt = randomUUID();
    db.sql(`INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES('${unscoped}',0,'owned-unscoped-prune','{}',clock_timestamp()+interval '1 hour');
      INSERT INTO media_executions(id,session_id,kind,owner_id,reaped_at) VALUES('${receipt}','${unscoped}','delivery','${owner}',clock_timestamp()-interval '3 days');`);
    db.sql(prune);
    assert.equal(db.sql(`SELECT count(*) FROM media_executions WHERE id='${receipt}'`), "0");
    const where = deleteSql.indexOf("WHERE ") + 6, end = deleteSql.indexOf(" AND p.id=e.session_id");
    assert.ok(where >= 6 && end > where);
    const eligibility = deleteSql.slice(where, end).replaceAll("$1", `ARRAY['${room}']::uuid[]`);
    assert.equal(db.sql(`SELECT (${eligibility}) IS TRUE FROM (SELECT NULL::uuid AS room_id,2::integer AS playback_metrics_version) p`), "f");
  });
  await check(
    "bulk pruning retains one deterministic true-or-unknown witness and deletes HEAD/segment rows",
    () => {
      for (let n = 0; n < 30; n++)
        db.sql(
          `INSERT INTO media_executions(id,session_id,kind,owner_id,reaped_at,metrics_entry_candidate) VALUES('${randomUUID()}','${session}','delivery','${owner}',clock_timestamp()-interval '3 days',${n % 3 === 0 ? "NULL" : n % 3 === 1 ? "true" : "false"})`,
        );
      const witness = db.sql(
        `SELECT id FROM media_executions WHERE session_id='${session}' AND metrics_entry_candidate IS DISTINCT FROM false ORDER BY id LIMIT 1`,
      );
      db.sql(prune);
      assert.equal(
        db.sql(
          `SELECT count(*) FROM media_executions WHERE session_id='${session}'`,
        ),
        "1",
      );
      assert.equal(
        db.sql(`SELECT id FROM media_executions WHERE session_id='${session}'`),
        witness,
      );
      db.sql(prune);
      assert.equal(
        db.sql(
          `SELECT count(*) FROM media_executions WHERE session_id='${session}'`,
        ),
        "1",
      );
    },
  );
  await check(
    "concurrent insertion and repeated pruning cannot recreate first-entry eligibility",
    async () => {
      const inserted = randomUUID();
      const pending = db.sqlProcess(
        `BEGIN; INSERT INTO media_executions(id,session_id,kind,owner_id,reaped_at,metrics_entry_candidate) VALUES('${inserted}','${session}','delivery','${owner}',clock_timestamp()-interval '3 days',true); SELECT pg_sleep(0.2); COMMIT;`,
      );
      db.sql(prune);
      await pending.done;
      db.sql(prune);
      assert.equal(
        db.sql(
          `SELECT count(*) FROM media_executions WHERE session_id='${session}' AND metrics_entry_candidate IS DISTINCT FROM false`,
        ),
        "1",
      );
      assert.equal(
        db.sql(
          `SELECT NOT EXISTS(SELECT 1 FROM media_executions WHERE session_id='${session}' AND kind='delivery' AND metrics_entry_candidate IS DISTINCT FROM false)`,
        ),
        "f",
      );
    },
  );
  await check(
    "fresh DELETE snapshot observes renewal committed after lock-statement snapshot began",
    async () => {
      const renewed = randomUUID(),
        requestKey = randomUUID(),
        login = sha(randomUUID());
      const frameViewer = randomUUID(),
        receipt = randomUUID();
      db.sql(`INSERT INTO room_members(room_id,user_id) VALUES('${room}','${owner}') ON CONFLICT DO NOTHING;
      INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES('${login}','${owner}','owned-renewal-csrf',clock_timestamp()+interval '1 hour');
      INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,lifecycle_epoch,auth_login_hash,auth_membership_epoch)
      SELECT '${owner}','${requestKey}','owned-renewal-race','${renewed}',gen_random_uuid(),'pending',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 hour',r.id,r.lifecycle_epoch,'${login}',m.membership_epoch FROM rooms r JOIN room_members m ON m.room_id=r.id AND m.user_id='${owner}' WHERE r.id='${room}';
      INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at,viewer_id,plan_generation,playback_metrics_version,metrics_meter_start_generation)
      VALUES('${renewed}','${owner}','${room}',1,'owned-renewal-token-${renewed}','{}',clock_timestamp()+interval '2 seconds','${frameViewer}',1,2,1);
      INSERT INTO media_executions(id,session_id,kind,owner_id,reaped_at,metrics_entry_candidate) VALUES('${receipt}','${renewed}','delivery','${owner}',clock_timestamp()-interval '3 days',NULL);
      CREATE FUNCTION owned_prune_snapshot_gate() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM pg_advisory_xact_lock(27451863);RETURN true;END $$;`);
      const opened = [];
      const interactive = () => {
        const child = db.sqlProcess(undefined, { interactive: true });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.done.catch(() => {});
        opened.push(child);
        return { child, output: () => output };
      };
      const wait = async (probe, label) => {
        const end = Date.now() + 8000;
        while (Date.now() < end) {
          if (probe()) return;
          await new Promise((done) => setTimeout(done, 5));
        }
        throw Error("Deadline: " + label);
      };
      const send = async (process, sql, marker) => {
        process.child.stdin.write(sql + `;SELECT '${marker}';\n`);
        await wait(() => process.output().includes(marker), marker);
      };
      const gate = interactive(),
        pruner = interactive(),
        renew = interactive();
      const app = "owned_prune_snapshot_" + randomUUID().replaceAll("-", "");
      try {
        await send(
          gate,
          "BEGIN;SELECT pg_advisory_xact_lock(27451863)",
          "gate_owned",
        );
        const gated = lockRoomsSql.replace(
          "WHERE",
          "WHERE owned_prune_snapshot_gate() AND",
        );
        pruner.child.stdin.write(
          `BEGIN ISOLATION LEVEL READ COMMITTED;SET LOCAL application_name='${app}';CREATE TEMP TABLE owned_prune_rooms ON COMMIT DROP AS ${gated};SELECT 'rooms_locked';\n`,
        );
        await wait(
          () =>
            db.sql(
              `SELECT count(*) FROM pg_stat_activity WHERE application_name='${app}' AND wait_event_type='Lock' AND wait_event='advisory'`,
            ) === "1",
          "old snapshot paused before room lock",
        );
        await send(
          renew,
          `BEGIN;SELECT id FROM rooms WHERE id='${room}' FOR NO KEY UPDATE;UPDATE playback_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id='${renewed}' AND NOT stopped AND expires_at>clock_timestamp() RETURNING id`,
          "renewal_written",
        );
        assert.ok(
          renew.output().includes(renewed),
          "renewal was admitted before original expiry",
        );
        await wait(
          () =>
            db.sql(
              `SELECT expires_at<=clock_timestamp() FROM playback_sessions WHERE id='${renewed}'`,
            ) === "t",
          "original committed expiry elapsed",
        );
        renew.child.stdin.end("COMMIT;\n");
        await renew.child.done;
        gate.child.stdin.end("COMMIT;\n");
        await gate.child.done;
        await wait(
          () => pruner.output().includes("rooms_locked"),
          "lock statement fully consumed",
        );
        pruner.child.stdin.end(
          deleteSql.replaceAll(
            "$1",
            "ARRAY(SELECT id FROM owned_prune_rooms)",
          ) + ";COMMIT;\n",
        );
        await pruner.child.done;
        assert.equal(
          db.sql(`SELECT count(*) FROM media_executions WHERE id='${receipt}'`),
          "1",
        );
        assert.equal(
          db.sql(
            `SELECT expires_at>clock_timestamp() AND metrics_output_entry_availability IS NULL FROM playback_sessions WHERE id='${renewed}'`,
          ),
          "t",
        );
      } finally {
        for (const child of opened)
          if (!child.stdin.writableEnded) child.stdin.end("ROLLBACK;\n");
        await Promise.allSettled(opened.map((child) => child.done));
        db.sql("DROP FUNCTION owned_prune_snapshot_gate();");
      }
    },
  );
  await check(
    "stopped grants release the sentinel without converting historical unknown",
    () => {
      db.sql(
        `UPDATE playback_sessions SET stopped=true WHERE id='${session}';${prune}`,
      );
      assert.equal(
        db.sql(
          `SELECT count(*) FROM media_executions WHERE session_id='${session}' AND kind='delivery'`,
        ),
        "0",
      );
      assert.equal(
        db.sql(
          `SELECT metrics_output_entry_availability IS NULL FROM playback_sessions WHERE id='${session}'`,
        ),
        "t",
      );
    },
  );
  await check(
    "expired grants prune only after contended room admission is released",
    async () => {
      db.sql(
        `INSERT INTO media_executions(id,session_id,kind,owner_id,reaped_at,metrics_entry_candidate) VALUES('${randomUUID()}','${expiredSession}','delivery','${owner}',clock_timestamp()-interval '3 days',true);UPDATE playback_sessions SET expires_at=clock_timestamp()+interval '0.2 seconds' WHERE id='${expiredSession}'`,
      );
      const marker = "owned_prune_room_" + randomUUID().replaceAll("-", "");
      const held = db.sqlProcess(undefined, { interactive: true });
      let output = "";
      held.stdout.on("data", (chunk) => (output += chunk));
      held.stdin.write(
        `BEGIN;SELECT id FROM rooms WHERE id='${room}' FOR NO KEY UPDATE;SELECT '${marker}';\n`,
      );
      while (!output.includes(marker))
        await new Promise((done) => setTimeout(done, 5));
      try {
        await new Promise((done) => setTimeout(done, 250));
        db.sql(prune);
        assert.equal(
          db.sql(
            `SELECT count(*) FROM media_executions WHERE session_id='${expiredSession}'`,
          ),
          "1",
        );
      } finally {
        held.stdin.end("COMMIT;\n");
        await held.done;
      }
      db.sql(prune);
      assert.equal(
        db.sql(
          `SELECT count(*) FROM media_executions WHERE session_id='${expiredSession}'`,
        ),
        "0",
      );
      assert.equal(
        db.sql(
          `SELECT NOT stopped AND expires_at<=clock_timestamp() AND metrics_output_entry_availability IS NULL FROM playback_sessions WHERE id='${expiredSession}'`,
        ),
        "t",
      );
    },
  );
  await check(
    "queue and receipt observation never edits legacy authority or original expiry",
    () => {
      assert.equal(
        db.sql(
          `SELECT auth_login_hash IS NULL AND resource='{}'::jsonb AND expires_at>clock_timestamp() FROM playback_sessions WHERE id='${session}'`,
        ),
        "t",
      );
    },
  );
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = error.stack;
  throw error;
} finally {
  await db.stop();
  report.cleanup = await db.verifyStopped();
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`Evidence: ${root}/report.json`);
}
