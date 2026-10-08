// Execute production retention SQL on a fresh, minimal owned retention schema.
// This is a database/FK regression, not a playback or authorization simulation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isolatedPostgres } from './fixtures/postgres.mjs';
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, 'Set an external owned artifact directory');
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, 'compute-retention', randomUUID());
await mkdir(root, { recursive: true });
const db = isolatedPostgres({ root, name: 'compute-retention' });
const report = { result: 'running', checks: [] };
try {
  const source = await readFile('apps/server/src/distributed_compute.rs', 'utf8');
  const queries = [...source.matchAll(/sqlx::query\(\s*"(DELETE FROM (?:distributed_compute_attempts|distributed_compute_jobs|room_p2p_signals)[^"]+)"/g)].map(match => match[1]);
  const find = table => { const matches = queries.filter(sql => sql.startsWith(`DELETE FROM ${table} `)); assert.equal(matches.length, 1); return matches[0]; };
  const attempts = find('distributed_compute_attempts'), jobs = find('distributed_compute_jobs'), signals = find('room_p2p_signals');
  assert.ok(source.indexOf(signals) < source.indexOf('tokio::fs::read_dir(&root)'), 'signaling cleanup precedes filesystem failures');
  await db.start();
  // The binding FK deliberately uses the production NO ACTION deletion mode.
  db.sql(`CREATE TABLE distributed_compute_jobs(id integer PRIMARY KEY, expires_at timestamptz NOT NULL);
    CREATE TABLE distributed_playback_bindings(session_id integer PRIMARY KEY, job_id integer NOT NULL REFERENCES distributed_compute_jobs(id));
    CREATE TABLE distributed_compute_attempts(job_id integer PRIMARY KEY REFERENCES distributed_compute_jobs(id), room_id integer NOT NULL, process_reaped_at timestamptz, files_removed_at timestamptz, server_verification_started_at timestamptz, server_verification_reaped_at timestamptz);
    CREATE TABLE room_cleanup_tasks(room_id integer PRIMARY KEY, completed_at timestamptz);
    CREATE TABLE room_p2p_signals(sequence integer PRIMARY KEY, expires_at timestamptz NOT NULL);
    INSERT INTO distributed_compute_jobs VALUES(1,clock_timestamp()-interval '3 days'),(2,clock_timestamp()-interval '2 hours'),(3,clock_timestamp()-interval '3 days'),(4,clock_timestamp()-interval '3 days'),(5,clock_timestamp()-interval '3 days'),(6,clock_timestamp()-interval '3 days'),(7,clock_timestamp()+interval '1 hour');
    INSERT INTO distributed_playback_bindings VALUES(10,1);
    INSERT INTO distributed_compute_attempts VALUES
      (1,1,clock_timestamp(),clock_timestamp(),clock_timestamp(),clock_timestamp()),
      (3,3,NULL,NULL,NULL,NULL),
      (4,4,clock_timestamp(),clock_timestamp(),clock_timestamp(),NULL),
      (5,5,clock_timestamp(),clock_timestamp(),NULL,NULL),
      (6,6,clock_timestamp(),clock_timestamp(),clock_timestamp(),clock_timestamp());
    INSERT INTO room_cleanup_tasks VALUES(5,NULL);
    INSERT INTO room_p2p_signals VALUES(1,clock_timestamp()-interval '1 minute'),(2,clock_timestamp()+interval '1 minute');`);
  for (let pass = 0; pass < 2; pass++) {
    db.sql(signals); db.sql(attempts); db.sql(jobs);
    assert.equal(db.sql('SELECT string_agg(id::text,\',\' ORDER BY id) FROM distributed_compute_jobs'), '1,3,4,5,7');
    assert.equal(db.sql('SELECT string_agg(job_id::text,\',\' ORDER BY job_id) FROM distributed_compute_attempts'), '3,4,5');
    assert.equal(db.sql('SELECT job_id FROM distributed_playback_bindings WHERE session_id=10'), '1');
    assert.equal(db.sql('SELECT sequence FROM room_p2p_signals'), '2');
  }
  report.checks = ['expired unreferenced jobs prune without FK failure', 'immutable playback bindings retain their job history', 'unconfirmed NAS and Server process receipts survive retention', 'pending room cleanup retains its attempt', 'fresh jobs and fresh signals retained', 'expired signaling pruned before file/history failures', 'repeat cleanup is idempotent'];
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = String(error); process.exitCode = 1; }
finally { await db.stop(); report.cleanup = await db.verifyStopped(); await writeFile(resolve(root, 'evidence.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
