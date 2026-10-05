import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

// Independent PostgreSQL SQL acceptance. No existing backend, host port,
// bind-mounted data or persistent volume is used. Rust consuming transactions,
// opaque runtime permits and public HLS activation are outside this runner.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runId = randomUUID();
const evidence = join(root, ".runtime", "0044-postgres", runId);
mkdirSync(evidence, { recursive: true });
const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(),
  scope: "isolated-postgres-sql-only", checks: [], commands: [], cleanup: {},
  limitations: ["No Rust consuming-transaction acceptance", "No physical HLS disposal proof",
    "No Stage B activation", "Historical F2/HLS unknown responsibilities remain unchanged"] };
let container;
let commandNumber = 0;
const checkpoint = () => writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inputs = [...readdirSync(join(root, "migrations")).filter((f) => /^00\d\d_.*\.sql$/.test(f))
  .sort().map((f) => `migrations/${f}`), "tests/sql/static_hls_pending_custody.sql",
  "tests/sql/static_hls_stage_a_upgrade_seed.sql", "tests/static-hls-pending-postgres.mjs"];
report.inputs = inputs.map((path) => ({ path, sha256: hash(readFileSync(join(root, path))) }));

function command(program, args, { input, timeout = 30000, allowFailure = false } = {}) {
  const started = performance.now();
  const result = spawnSync(program, args, { cwd: root, input, encoding: "utf8",
    timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const record = { program, args, elapsedMs: Math.round(performance.now() - started),
    status: result.status, signal: result.signal, error: result.error?.message,
    inputSha256: input === undefined ? undefined : hash(input), stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  const path = `${String(++commandNumber).padStart(3, "0")}.json`;
  writeFileSync(join(evidence, path), JSON.stringify(record, null, 2) + "\n");
  report.commands.push({ path, sha256: hash(readFileSync(join(evidence, path))) });
  if (!allowFailure && (result.error || result.status !== 0))
    throw new Error(`${program} failed (${result.status}): ${record.stderr || record.error}`);
  return record;
}
function psqlArgs(db) {
  return ["exec", "-i", container, "psql", "-X", "-h", "127.0.0.1", "-U", "postgres", "-d", db,
    "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-A", "-t"];
}
function sql(db, input, options = {}) {
  return command("docker", [...psqlArgs(db), ...(options.transaction ? ["--single-transaction"] : []), "-f", "-"],
    { ...options, input });
}
function scalar(db, input) { return sql(db, input).stdout.trim(); }
async function check(name, fn) {
  const row = { name, startedAt: new Date().toISOString() };
  report.checks.push(row);
  checkpoint();
  try { await fn(); row.passed = true; checkpoint(); console.log(`PASS ${name}`); }
  catch (error) { row.passed = false; row.error = error.message; checkpoint(); throw error; }
}
const migration44 = readFileSync(join(root, "migrations/0044_static_hls_pending_custody.sql"), "utf8");
const pendingFixture = readFileSync(join(root, "tests/sql/static_hls_pending_custody.sql"), "utf8");
function fixturePrefix(marker) {
  const boundary = pendingFixture.indexOf(marker);
  assert.ok(boundary > 0, `missing fixture boundary: ${marker}`);
  return pendingFixture.slice(0, boundary);
}
function database(name, template = "base43") {
  sql("postgres", `CREATE DATABASE ${name} TEMPLATE ${template};`);
  return name;
}
function migrate44(db, expected) {
  const result = sql(db, migration44, { transaction: true, allowFailure: !!expected });
  if (expected) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    // Both table DDL and function/trigger creation must have rolled back.
    assert.equal(scalar(db, "SELECT count(*) FROM information_schema.columns WHERE table_name='playback_requests' AND column_name='static_hls_input_version';"), "0");
    assert.equal(scalar(db, "SELECT to_regprocedure('static_hls_pending_reader_supported()') IS NULL;"), "t");
    assert.equal(scalar(db, "SELECT count(*) FROM pg_constraint WHERE conname='static_hls_captures_session_id_fkey';"), "1");
  }
}
async function withLock(db, table, fn, { budget = false } = {}) {
  // The observed PostgreSQL backend and application_name identify this exact
  // fixture connection. Cancel only its sleep query; no numeric OS PID control.
  const application = `rs0044_${randomUUID().replaceAll("-", "")}`;
  const mode = budget ? "SHARE" : "ROW EXCLUSIVE";
  const observedMode = budget ? "ShareLock" : "RowExclusiveLock";
  const args = [...psqlArgs(db), "-c", `SET application_name='${application}'; BEGIN; LOCK TABLE ${table} IN ${mode} MODE; ${budget ? "SELECT revision FROM cache_budget WHERE singleton FOR UPDATE;" : ""} SELECT pg_sleep(45); ROLLBACK;`];
  const child = spawn("docker", args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes; });
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const done = new Promise((resolveDone) => {
    child.once("error", (error) => resolveDone({ error: error.message }));
    child.once("close", (status, signal) => resolveDone({ status, signal }));
  });
  try {
    const deadline = performance.now() + 10000;
    let locked = false;
    while (performance.now() < deadline) {
      locked = scalar(db, `SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.application_name='${application}' AND a.datname=current_database() AND l.relation='${table}'::regclass AND l.mode='${observedMode}' AND l.granted AND a.wait_event='PgSleep');`) === "t";
      if (locked) break;
      await delay(100);
    }
    assert.ok(locked, `original ${table} holder never acquired its lock`);
    await fn();
  } finally {
    sql(db, `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='${application}' AND datname=current_database();`);
    let closeTimer;
    const result = await Promise.race([done, new Promise((resolveDeadline) => {
      closeTimer = setTimeout(() => resolveDeadline({ error: "lock holder did not close" }), 10000);
    })]);
    clearTimeout(closeTimer);
    const path = `${String(++commandNumber).padStart(3, "0")}-holder.json`;
    writeFileSync(join(evidence, path), JSON.stringify({ program: "docker", args, ...result, stdout, stderr }, null, 2) + "\n");
    report.commands.push({ path, sha256: hash(readFileSync(join(evidence, path))) });
    assert.ok(!result.error, result.error);
    assert.equal(scalar(db, `SELECT count(*) FROM pg_stat_activity WHERE application_name='${application}';`), "0");
  }
}

try {
  report.sourceCommit = command("git", ["rev-parse", "HEAD"]).stdout.trim();
  report.sourceTree = command("git", ["rev-parse", "HEAD^{tree}"]).stdout.trim();
  report.worktreeStatus = command("git", ["status", "--short"]).stdout;
  const image = JSON.parse(command("docker", ["image", "inspect", process.env.RAINSYNC_SQL_POSTGRES_IMAGE || "postgres:17"]).stdout)[0];
  assert.equal(image.Os, "linux");
  assert.equal(image.Config.StopSignal, "SIGINT");
  report.image = { id: image.Id, repoDigests: image.RepoDigests, stopSignal: image.Config.StopSignal };
  container = command("docker", ["create", "--name", `rainsync-0044-${runId}`, "--label", `io.rainsync.sql-run=${runId}`,
    "--network", "none", "--memory", "1536m", "--pids-limit", "128",
    "--tmpfs", "/var/lib/postgresql/data:rw,size=1073741824", "--tmpfs", "/var/run/postgresql", "--tmpfs", "/tmp",
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust", image.Id]).stdout.trim();
  assert.match(container, /^[0-9a-f]{64}$/);
  report.containerId = container;
  checkpoint();
  command("docker", ["start", container]);
  const readinessDeadline = performance.now() + 30000;
  let ready = false;
  while (performance.now() < readinessDeadline) {
    const result = sql("postgres", "SELECT 1;", { allowFailure: true, timeout: 3000 });
    if (result.status === 0 && result.stdout.trim() === "1") { ready = true; break; }
    await delay(200);
  }
  assert.ok(ready, "final PostgreSQL TCP listener did not become ready");
  report.postgresVersion = scalar("postgres", "SHOW server_version;");
  await check("migrations_0001_through_0043", () => {
    sql("postgres", "CREATE DATABASE base43;");
    for (const path of inputs.filter((p) => p.startsWith("migrations/") && Number(p.split("/").at(-1).slice(0, 4)) <= 43))
      sql("base43", readFileSync(join(root, path), "utf8"), { transaction: true });
  });
  await check("0044_empty_upgrade_and_pending_sql_assertions", () => {
    const db = database("empty44"); migrate44(db);
    sql(db, pendingFixture);
    assert.equal(scalar(db, "SELECT count(*) FROM users;"), "0", "fixture must roll back its data");
  });
  sql("postgres", "CREATE DATABASE stage43 TEMPLATE base43;");
  sql("stage43", readFileSync(join(root, "tests/sql/static_hls_stage_a_upgrade_seed.sql"), "utf8"));
  await check("0044_stage_a_upgrade_preserves_original_sessions_and_requests", () => {
    const db = database("stage44", "stage43"); migrate44(db);
    assert.equal(scalar(db, "SELECT count(*) FROM static_hls_captures WHERE publication_phase='stage_a' AND input_sha256 IS NULL;"), "2");
    for (const id of ["e1000000-0000-0000-0000-000000000142", "e1000000-0000-0000-0000-000000000242"]) {
      for (const [statement, expected] of [[`DELETE FROM playback_sessions WHERE id='${id}';`, /static_hls_stage_a_session_retained/],
        [`UPDATE playback_sessions SET id=gen_random_uuid() WHERE id='${id}';`, /playback_room_identity_immutable/]]) {
        const rejection = sql(db, statement, { allowFailure: true });
        assert.notEqual(rejection.status, 0); assert.match(rejection.stderr, expected);
      }
      assert.equal(scalar(db, `WITH removed AS (DELETE FROM playback_requests WHERE session_id='${id}' RETURNING 1) SELECT count(*) FROM removed;`), "0");
    }
    assert.equal(scalar(db, "SELECT count(*) FROM playback_sessions;"), "2");
  });
  await check("0044_missing_historical_request_aborts_atomically", () => {
    const db = database("missing43", "stage43");
    assert.equal(scalar(db, "WITH removed AS (DELETE FROM playback_requests WHERE session_id='e1000000-0000-0000-0000-000000000142' RETURNING 1) SELECT count(*) FROM removed;"), "1");
    migrate44(db, /static_hls_historical_request_required/);
    assert.equal(scalar(db, "SELECT count(*) FROM static_hls_captures;"), "2");
  });
  await check("0044_conflicting_historical_owner_aborts_atomically", () => {
    const db = database("conflicting43", "stage43");
    sql(db, "UPDATE playback_requests SET owner_epoch=gen_random_uuid() WHERE session_id='e1000000-0000-0000-0000-000000000142';");
    migrate44(db, /static_hls_historical_request_required/);
    assert.equal(scalar(db, "SELECT count(*) FROM static_hls_captures;"), "2");
  });
  for (const [index, table] of ["playback_requests", "static_hls_captures", "playback_sessions", "media_jobs", "cache_write_reservations", "playback_preparations"].entries()) {
    await check(`0044_nowait_${table}_rolls_back_and_retry_succeeds`, async () => {
      const db = database(`busy${index}`);
      await withLock(db, table, () => migrate44(db, /55P03:.*could not obtain lock/));
      migrate44(db);
      assert.equal(scalar(db, "SELECT static_hls_pending_reader_supported();"), "f");
    });
  }
  await check("pending_request_without_preparation_rolls_back_at_commit", () => {
    const db = database("no_prep44", "empty44");
    const result = sql(db, fixturePrefix("INSERT INTO playback_preparations(session_id") + "COMMIT;", { allowFailure: true });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /static_hls_pending_preparation_required/);
    assert.equal(scalar(db, "SELECT count(*) FROM playback_requests;"), "0");
    assert.equal(scalar(db, "SELECT count(*) FROM playback_viewer_plans;"), "0");
  });
  await check("pending_capture_without_reservation_rolls_back_at_commit", () => {
    const db = database("no_reserve44", "empty44");
    sql(db, fixturePrefix("-- Same explicit suffix as admission.") + "COMMIT;");
    const captureStart = pendingFixture.indexOf("INSERT INTO static_hls_captures(id");
    const captureEnd = pendingFixture.indexOf("INSERT INTO cache_write_reservations(job_id", captureStart);
    assert.ok(captureStart > 0 && captureEnd > captureStart);
    const result = sql(db, "BEGIN; SELECT set_config('rainsync.static_hls_reader','2',true),set_config('rainsync.static_hls_pending_recipe','1',true);\n" +
      pendingFixture.slice(captureStart, captureEnd) + "COMMIT;", { allowFailure: true });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /static_hls_pending_reservation_required/);
    assert.equal(scalar(db, "SELECT count(*) FROM static_hls_captures;"), "0");
    assert.equal(scalar(db, "SELECT count(*) FROM cache_write_reservations;"), "0");
    assert.equal(scalar(db, "SELECT count(*) FROM playback_requests;"), "1");
  });
  await check("pending_disposal_without_reservation_release_rolls_back", () => {
    const db = database("dispose44", "empty44");
    sql(db, fixturePrefix("SELECT pg_temp.rejects($q$UPDATE static_hls_captures SET input_sha256") + "COMMIT;");
    const result = sql(db, `BEGIN;
      SELECT set_config('rainsync.static_hls_reader','2',true),set_config('rainsync.static_hls_pending_recipe','1',true);
      SELECT revision FROM cache_budget WHERE singleton FOR UPDATE;
      UPDATE static_hls_captures SET state='disposed',streams_closed_at=clock_timestamp(),process_closed_at=clock_timestamp(),
        process_disposition='never_started',files_removed_at=clock_timestamp(),disposed_at=clock_timestamp();
      COMMIT;`, { allowFailure: true });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /static_hls_pending_reservation_required/);
    assert.equal(scalar(db, "SELECT state FROM static_hls_captures;"), "capturing");
    assert.equal(scalar(db, "SELECT count(*) FROM cache_write_reservations;"), "1");
  });
  await check("pending_verify_and_cancel_do_not_wait_for_budget", async () => {
    const db = database("budget44", "empty44");
    sql(db, fixturePrefix("SELECT pg_temp.rejects($q$UPDATE static_hls_captures SET input_sha256") + "COMMIT;");
    await withLock(db, "cache_budget", () => {
      // A table-level SHARE lock is needed to conflict with RowExclusiveLock
      // from any attempted budget UPDATE. The holder below also takes its row
      // lock, so both SELECT FOR UPDATE and UPDATE would be blocked.
      sql(db, `BEGIN; SET LOCAL lock_timeout='500ms';
        SELECT set_config('rainsync.static_hls_reader','2',true),set_config('rainsync.static_hls_pending_recipe','1',true);
        UPDATE static_hls_captures SET state='verified',inventory_encrypted='synthetic-root-ciphertext',root_digest=repeat('d',64);
        COMMIT;`);
      assert.equal(scalar(db, "SELECT state FROM static_hls_captures;"), "verified");
      sql(db, `BEGIN; SET LOCAL lock_timeout='500ms'; SELECT set_config('rainsync.static_hls_reader','1',true);
        UPDATE playback_requests SET status='failed',error_status=502,error_code='upstream_failed';
        UPDATE static_hls_captures SET state='cancelled'; COMMIT;`);
      assert.equal(scalar(db, "SELECT count(*) FROM cache_write_reservations;"), "1");
    }, { budget: true });
  });
  report.finalInputsUnchanged = report.inputs.every(({ path, sha256 }) => hash(readFileSync(join(root, path))) === sha256);
  assert.ok(report.finalInputsUnchanged, "acceptance inputs changed during execution");
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; console.error(error.message);
  process.exitCode = 1;
} finally {
  if (container) {
    try {
      const before = JSON.parse(command("docker", ["inspect", container]).stdout)[0];
      assert.equal(before.Config.Labels["io.rainsync.sql-run"], runId);
      assert.equal(before.Id, container);
      command("docker", ["stop", "--time", "10", container]);
      const stopped = JSON.parse(command("docker", ["inspect", container]).stdout)[0];
      report.cleanup = { id: stopped.Id, state: stopped.State, mounts: stopped.Mounts, tmpfs: stopped.HostConfig.Tmpfs };
      const logs = command("docker", ["logs", container]);
      assert.equal(stopped.State.Running, false);
      assert.equal(stopped.State.ExitCode, 0);
      assert.equal(stopped.State.OOMKilled, false);
      assert.ok(stopped.Mounts.every((mount) => mount.Type === "tmpfs"));
      assert.equal(stopped.HostConfig.NetworkMode, "none");
      assert.equal(stopped.HostConfig.Tmpfs["/var/lib/postgresql/data"], "rw,size=1073741824");
      assert.match(logs.stdout + logs.stderr, /database system is shut down/);
      assert.doesNotMatch(logs.stdout + logs.stderr, /abnormal database system shutdown/);
      command("docker", ["rm", container]);
      report.cleanup.removed = true;
    } catch (error) {
      report.cleanup.error = error.message; report.passed = false; process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  checkpoint();
  console.log(`Evidence: ${join(evidence, "report.json")}`);
}
