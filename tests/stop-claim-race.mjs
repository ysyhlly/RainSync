// Real production media_jobs::claim and authenticated HTTP Stop against an
// owned PostgreSQL cluster. SQL only seeds rows and controls lock boundaries.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";

assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "external evidence root required");
const driver = resolve(
  process.env.CARGO_TARGET_DIR ?? "target",
  "debug/examples/stop_claim_fixture",
);
const binary = process.env.RAINSYNC_STOP_CLAIM_SERVER;
const report = {
  result: "running",
  started_at: new Date().toISOString(),
  cases: [],
};
let fixture;
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
async function until(probe, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await probe();
    if (result) return result;
    await delay(20);
  }
  throw Error(`Deadline: ${label}`);
}
// Match the actual owned-session mutation, including its timing aggregate CTE.
// The blocker relationship below remains the proof; query text only identifies
// which authenticated Stop is waiting, not an assumption that it completed.
const isStopCancellation = (query) => {
  const text = query.trimStart();
  return (
    text.startsWith(
      "UPDATE media_jobs SET status='cancelled' WHERE session_id IN",
    ) ||
    (text.startsWith("/* media_job_cancel_jobs */") &&
      text.includes("AND p.id=$1 AND p.user_id=$2"))
  );
};
const sample = (seq = 1) => ({
  media_generation: 1,
  seq,
  event: "progress",
  media_time_ms: 500,
  paused: true,
  seeking: false,
  buffering: false,
  playback_rate: 1,
  has_played: true,
});
try {
  await isolatedServer(
    "stop-claim-race",
    async (f) => {
      fixture = f;
      const admin = f.client();
      const identity = await admin.login();
      await admin.request("/users", "POST", {
        username: "claim-outsider",
        password: f.password,
      });
      const outsider = f.client();
      await outsider.login("claim-outsider");
      const room = await admin.request("/rooms", "POST", {
        name: "Stop claim race",
      });
      const source = randomUUID(),
        media = randomUUID();
      f.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','claim fixture','local','fixture');
      INSERT INTO media_items(id,source_id,title,resource,duration_ms) VALUES('${media}','${source}','claim fixture','fixture',10000);
      UPDATE room_snapshots SET state=state||'{"media_id":"${media}","media_generation":1}'::jsonb WHERE room_id='${room.id}'`);
      report.binaries = {
        server: {
          path: binary ?? resolve(f.target, "rainsync-server"),
          sha256: await digest(binary ?? resolve(f.target, "rainsync-server")),
        },
        driver: { path: driver, sha256: await digest(driver) },
      };
      report.postgres = f.postgresDiagnostics();
      const save = () =>
        writeFile(
          resolve(f.root, "report.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
      const waitGraph = () =>
        JSON.parse(
          f.sql(
            `SELECT COALESCE(json_agg(json_build_object('pid',pid,'application_name',application_name,'wait_event_type',wait_event_type,'wait_event',wait_event,'blockers',pg_blocking_pids(pid),'query',query)), '[]') FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`,
          ),
        );
      async function race(
        name,
        {
          final,
          concurrentObservation = false,
          missingMembership = false,
          expected = 200,
        } = {},
      ) {
        const id = randomUUID();
        const result = { name, session_id: id, result: "running" };
        report.cases.push(result);
        result.deadlocks_before = Number(
          f.sql(
            "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()",
          ),
        );
        withPlaybackAdmission(f, { client: admin, user: identity.id, room: room.id, session: id }, `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at)
        VALUES('${id}','${identity.id}','${room.id}','${media}',1,'${id}','{"upstream_closed":true}',now()+interval '1 hour');
        INSERT INTO playback_observations(session_id,user_id,room_id,media_id,generation,timeline_origin_ms,duration_ms)
        VALUES('${id}','${identity.id}','${room.id}','${media}',1,1000,10000);
        INSERT INTO media_jobs(id,session_id,status,spec) VALUES('${id}','${id}','queued','{}')`);
        const executionGateKey = 73564921;
        // A table lock also blocks output guards and prior-output cleanup.
        // Hold only this claim's actual receipt insert after it owns the job.
        f.sql(`CREATE FUNCTION hold_test_claim_execution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.job_id='${id}' THEN PERFORM pg_advisory_xact_lock(${executionGateKey}); END IF;
          RETURN NEW; END $$;
          CREATE TRIGGER hold_test_claim_execution BEFORE INSERT ON media_executions FOR EACH ROW EXECUTE FUNCTION hold_test_claim_execution()`);
        const gateName = `stop-claim-gate-${id}`;
        const gate = f.sqlProcess(undefined, { interactive: true });
        let child, childDone, stopDone, observationDone;
        const stdout = [],
          stderr = [];
        try {
          gate.stdin.write(
            `SET application_name='${gateName}'; BEGIN; SELECT pg_advisory_xact_lock(${executionGateKey});\n`,
          );
          await until(
            () =>
              f.sql(
                `SELECT count(*) FROM pg_stat_activity WHERE application_name='${gateName}' AND state='idle in transaction'`,
              ) === "1",
            "execution insert gate is held",
          );
          child = spawn(driver, [], {
            env: { ...f.env, RAINSYNC_ISOLATED_TEST: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          child.stdout.on("data", (data) => stdout.push(data));
          child.stderr.on("data", (data) => stderr.push(data));
          childDone = new Promise((done, reject) => {
            child.once("error", reject);
            child.once("close", (code) => done(code));
          });
          await until(
            () =>
              f.sql(
                `SELECT count(*) FROM pg_stat_activity WHERE application_name='rainsync-stop-claim-fixture' AND wait_event_type='Lock' AND query LIKE 'INSERT INTO media_executions%'`,
              ) === "1",
            "production claim owns job and waits at execution insert",
          );
          result.claim_wait = waitGraph();
          await outsider.request(`/playback-sessions/${id}`, "DELETE");
          const wrongOwner = await outsider.request(
            `/playback-sessions/${id}`,
            "DELETE",
            sample(),
            410,
          );
          assert.equal(wrongOwner.error.code, "INVALID_PLAYBACK_SESSION");
          assert.equal(
            f.sql(`SELECT stopped FROM playback_sessions WHERE id='${id}'`),
            "f",
            "another user cannot retire the owned grant",
          );
          if (missingMembership)
            f.sql(
              `DELETE FROM room_members WHERE room_id='${room.id}' AND user_id='${identity.id}'`,
            );
          stopDone = admin
            .raw(`/playback-sessions/${id}`, { method: "DELETE", body: final })
            .then(async (response) => ({
              status: response.status,
              body: await response.json(),
            }));
          await until(
            () =>
              f.sql(
                `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND (query LIKE 'UPDATE media_jobs SET status=''cancelled'' WHERE session_id IN%' OR (query LIKE '/* media_job_cancel_jobs */%' AND query LIKE '%AND p.id=$1 AND p.user_id=$2%'))`,
              ) === "1",
            "HTTP Stop owns session and waits for claimed job",
          );
          result.stop_wait = waitGraph();
          const claimPid = result.stop_wait.find(
            (v) => v.application_name === "rainsync-stop-claim-fixture",
          ).pid;
          assert.ok(
            result.stop_wait.some(
              (v) =>
                isStopCancellation(v.query) && v.blockers.includes(claimPid),
            ),
            "Stop is blocked by the actual production claim transaction",
          );
          if (concurrentObservation) {
            observationDone = admin
              .raw(`/playback-sessions/${id}/observations`, {
                method: "POST",
                body: sample(2),
              })
              .then(async (response) => ({
                status: response.status,
                body: await response.json(),
              }));
            await until(
              () =>
                f.sql(
                  `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT lifecycle,lifecycle_epoch FROM rooms%'`,
                ) === "1",
              "observation serializes behind Stop room lock",
            );
          }
          gate.stdin.end("COMMIT;\n");
          await gate.done;
          result.stop = await stopDone;
          result.claim_exit = await childDone;
          result.claim_stdout = Buffer.concat(stdout).toString().trim();
          result.claim_stderr = Buffer.concat(stderr).toString().trim();
          result.database = JSON.parse(
            f.sql(
              `SELECT json_build_object('stopped',p.stopped,'job_status',j.status,'attempt',j.attempt,'observation_seq',o.seq,'position_ms',o.position_ms,'executions',(SELECT count(*) FROM media_executions e WHERE e.session_id=p.id)) FROM playback_sessions p JOIN media_jobs j ON j.session_id=p.id JOIN playback_observations o ON o.session_id=p.id WHERE p.id='${id}'`,
            ),
          );
          result.deadlocks_after = Number(
            f.sql(
              "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()",
            ),
          );
          if (observationDone) result.observation = await observationDone;
          await save();
          assert.equal(
            result.stop.status,
            expected,
            `HTTP Stop must finish after production claim: ${JSON.stringify(result.stop)}`,
          );
          assert.equal(result.claim_exit, 0, result.claim_stderr);
          assert.equal(
            result.deadlocks_after,
            result.deadlocks_before,
            "the forced claim/Stop overlap must not deadlock",
          );
          assert.equal(JSON.parse(result.claim_stdout).id, id);
          assert.equal(result.database.stopped, true);
          assert.equal(result.database.job_status, "cancelled");
          assert.equal(result.database.attempt, 1);
          assert.equal(
            result.database.executions,
            1,
            "claimed attempt retains its independent drain receipt",
          );
          if (final && expected === 200) {
            assert.equal(result.database.observation_seq, 1);
            assert.equal(result.database.position_ms, 1500);
            await admin.request(`/playback-sessions/${id}`, "DELETE", final);
            assert.equal(
              f.sql(
                `SELECT seq FROM playback_observations WHERE session_id='${id}'`,
              ),
              "1",
              "same final sample is idempotent",
            );
          } else assert.equal(result.database.observation_seq, 0);
          if (result.observation) {
            assert.equal(result.observation.status, 410);
            assert.equal(
              result.observation.body.error.code,
              "INVALID_PLAYBACK_SESSION",
            );
          }
          result.result = "passed";
          await save();
          console.log(`PASS: ${name}`);
        } finally {
          if (!gate.stdin.destroyed) gate.stdin.end("ROLLBACK;\n");
          if (child?.exitCode === null) child.kill();
          await Promise.allSettled(
            [gate.done, childDone, stopDone, observationDone].filter(Boolean),
          );
          f.sql("DROP TRIGGER hold_test_claim_execution ON media_executions; DROP FUNCTION hold_test_claim_execution()");
          if (missingMembership)
            f.sql(
              `INSERT INTO room_members(room_id,user_id) VALUES('${room.id}','${identity.id}') ON CONFLICT DO NOTHING`,
            );
        }
      }
      await race("Stop during production claim");
      await race(
        "final observation and concurrent sample serialize during claim",
        { final: sample(), concurrentObservation: true },
      );
      await race("invalid final observation still cancels claimed work", {
        final: { ...sample(), playback_rate: 0 },
        expected: 400,
      });
      await race("stale final generation still cancels claimed work", {
        final: { ...sample(), media_generation: 2 },
        expected: 409,
      });
      await race(
        "revoked membership rejects final sample and cancels owned work",
        { final: sample(), missingMembership: true, expected: 403 },
      );
      report.result = "passed";
      await save();
    },
    { binary },
  );
} catch (error) {
  report.result = "failed";
  report.error = String(error);
  throw error;
} finally {
  if (fixture) {
    report.cleanup = await fixture.verifyStopped();
    report.finished_at = new Date().toISOString();
    await writeFile(
      resolve(fixture.root, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(`Evidence: ${fixture.root}`);
  }
}
