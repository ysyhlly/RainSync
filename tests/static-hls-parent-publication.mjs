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
const evidence = join(root, ".runtime", "0045-parent-publication", runId);
mkdirSync(evidence, { recursive: true });
const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(),
  scope: "isolated-parent-publication-postgres-sql-only", checks: [], commands: [], cleanup: {},
  limitations: ["No Rust consuming-transaction acceptance", "No physical HLS disposal proof",
    "No Stage B activation", "Historical F2/HLS unknown responsibilities remain unchanged"] };
let container;
let commandNumber = 0;
const checkpoint = () => writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inputs = [...readdirSync(join(root, "migrations")).filter((f) => /^00\d\d_.*\.sql$/.test(f))
  .sort().map((f) => `migrations/${f}`), "tests/sql/static_hls_pending_custody.sql",
  "tests/sql/static_hls_stage_a_upgrade_seed.sql", "tests/static-hls-parent-publication.mjs"];
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

const migration45 = readFileSync(join(root, "migrations/0045_static_hls_parent_publication.sql"), "utf8");
const sid = "f1000000-0000-0000-0000-000000000042";
const captureId = "f1000000-0000-0000-0000-000000000044";
const fence = "SELECT set_config('rainsync.static_hls_reader','2',true),set_config('rainsync.static_hls_pending_recipe','1',true);";
function migrate45(db, expected) {
  const result = sql(db, migration45, { transaction: true, allowFailure: !!expected });
  if (expected) {
    assert.notEqual(result.status, 0); assert.match(result.stderr, expected);
    assert.equal(scalar(db,"SELECT to_regprocedure('static_hls_published_parent_authority_allowed(uuid)') IS NULL;"),"t");
    assert.equal(scalar(db,"SELECT count(*) FROM information_schema.columns WHERE table_name='static_hls_captures' AND column_name='published_resource';"),"0");
  }
}
function seed(name) {
  const db=database(name,"base45");
  const first=pendingFixture.indexOf("SET CONSTRAINTS ALL IMMEDIATE;");
  const start=pendingFixture.indexOf("INSERT INTO static_hls_captures(id");
  const end=pendingFixture.indexOf("SET CONSTRAINTS ALL IMMEDIATE;",start);
  assert.ok(first>0 && start>first && end>start);
  sql(db,pendingFixture.slice(0,first)+pendingFixture.slice(start,end)+
    `UPDATE static_hls_captures SET state='verified',inventory_encrypted='synthetic-root-ciphertext',root_digest=repeat('d',64); COMMIT;`);
  return db;
}
const envelope = `jsonb_build_object('encrypted','synthetic-delivery-ciphertext',
  'source_policy_revision',r.static_hls_source_revision,'account_policy_generation',NULL,
  'auth_context',jsonb_build_object('version',1,'user_id',r.user_id,'room_id',r.room_id,'membership_epoch',r.auth_membership_epoch,'login_hash',r.auth_login_hash),
  'static_hls_input',jsonb_build_object('input_version',1,'reader_version',2,'recipe_version',1,'source_id',r.static_hls_source_id,
    'media_source_generation',r.static_hls_source_generation,'input_sha256',r.static_hls_input_sha256,'worker_instance',r.static_hls_worker_instance,
    'root_hard_expires_at_ms',floor(extract(epoch FROM r.static_hls_root_expires_at)*1000)::bigint))`;
function sessionInsert(resource = envelope) {
  return `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation,static_hls_capture_id)
    SELECT r.session_id,r.user_id,r.room_id,r.static_hls_media_id,r.static_hls_media_generation,repeat('f',64),
      (${resource})||jsonb_build_object('static_hls_capture_id',r.static_hls_operation_id),r.static_hls_root_expires_at,
      r.lifecycle_epoch,r.viewer_id,r.plan_generation,r.static_hls_operation_id FROM playback_requests r WHERE r.session_id='${sid}';`;
}
const publishCapture = `UPDATE static_hls_captures c SET publication_phase='published_parent',published_resource=p.resource-'static_hls_capture_id',published_at=clock_timestamp()
  FROM playback_sessions p WHERE c.id='${captureId}' AND p.id=c.session_id;`;
const completeRequest = `UPDATE playback_requests SET status='completed',response_encrypted='synthetic-parent-response' WHERE session_id='${sid}';`;
const complete = sessionInsert()+publishCapture+completeRequest;
function reject(db, statement, expected) {
  const result=sql(db,`BEGIN; ${fence} ${statement} COMMIT;`,{allowFailure:true});
  assert.notEqual(result.status,0); assert.match(result.stderr,expected);
  return result;
}
function assertUnpublished(db) {
  assert.equal(scalar(db,"SELECT count(*) FROM playback_sessions;"),"0");
  assert.equal(scalar(db,"SELECT status FROM playback_requests;"),"pending");
  assert.equal(scalar(db,"SELECT publication_phase FROM static_hls_captures;"),"pending_parent");
  assert.equal(scalar(db,"SELECT bytes FROM cache_write_reservations;"),"134217728");
}

async function phaseSnapshotRace(db, protectedRead) {
  const readerName=`rs_phase_read_${randomUUID().replaceAll("-","")}`;
  const writerName=`rs_phase_write_${randomUUID().replaceAll("-","")}`;
  const start=(application,text)=>{
    const args=[...psqlArgs(db),"-c",`SET application_name='${application}'; ${text}`];
    const child=spawn("docker",args,{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";
    child.stdout.on("data",bytes=>{stdout+=bytes;});child.stderr.on("data",bytes=>{stderr+=bytes;});
    const done=new Promise(resolve=>{
      child.once("error",error=>resolve({error:error.message}));
      child.once("close",(status,signal)=>resolve({status,signal}));
    }).then(result=>{
      const path=`${String(++commandNumber).padStart(3,"0")}-phase.json`;
      writeFileSync(join(evidence,path),JSON.stringify({program:"docker",args,...result,stdout,stderr},null,2)+"\n");
      report.commands.push({path,sha256:hash(readFileSync(join(evidence,path)))});
      return {...result,stdout,stderr};
    });
    return {done};
  };
  const reader=start(readerName,`BEGIN; ${fence}
    ${protectedRead?`SELECT id FROM static_hls_captures WHERE id='${captureId}' FOR SHARE;`:""}
    WITH original AS MATERIALIZED(SELECT id,publication_phase,pg_sleep(2) FROM static_hls_captures WHERE id='${captureId}')
    SELECT publication_phase||'|'||(CASE WHEN publication_phase='pending_parent' THEN static_hls_pending_capture_authority_allowed(id)
      ELSE static_hls_published_parent_authority_allowed(id) END)::text FROM original; COMMIT;`);
  let writer;
  try {
    const until=performance.now()+10000;
    while(scalar(db,`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='${readerName}' AND wait_event='PgSleep');`)!=="t") {
      assert.ok(performance.now()<until,"owned reader did not reach phase barrier");await delay(50);
    }
    writer=start(writerName,`BEGIN; ${fence} ${complete} COMMIT;`);
    if(protectedRead) {
      const locked=scalar(db,`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='${writerName}' AND wait_event_type='Lock');`);
      // If the launcher has not reached its transaction yet, observe it again.
      if(locked!=="t") {
        await delay(100);
        assert.equal(scalar(db,`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='${writerName}' AND wait_event_type='Lock');`),"t");
      }
    }
    const [readResult,writeResult]=await Promise.all([reader.done,writer.done]);
    assert.equal(readResult.status,0,readResult.stderr);assert.equal(writeResult.status,0,writeResult.stderr);
    assert.ok(readResult.stdout.includes(protectedRead?"pending_parent|true":"pending_parent|false"),readResult.stdout);
    assert.equal(scalar(db,`SELECT static_hls_published_parent_authority_allowed('${captureId}');`),"t");
  } finally {
    sql(db,`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name IN('${readerName}','${writerName}');`);
    await reader.done;if(writer) await writer.done;
    assert.equal(scalar(db,`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name IN('${readerName}','${writerName}');`),"0");
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
  container = command("docker", ["create", "--name", `rainsync-0045-${runId}`, "--label", `io.rainsync.sql-run=${runId}`,
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

  await check("migrations_0001_through_0044",()=>{
    sql("postgres","CREATE DATABASE base44;");
    for(const path of inputs.filter(p=>p.startsWith("migrations/") && !p.startsWith("migrations/0045_")))
      sql("base44",readFileSync(join(root,path),"utf8"),{transaction:true});
  });
  await check("0045_empty_upgrade_keeps_default_reader1_fence",()=>{
    const db=database("base45","base44"); migrate45(db);
    assert.equal(scalar(db,"BEGIN; SELECT set_config('rainsync.static_hls_reader','1',true); SELECT static_hls_reader_supported() AND NOT static_hls_pending_reader_supported(); ROLLBACK;" ).split("\n").at(-2),"t");
  });
  for(const [index,table] of ["playback_requests","static_hls_captures","playback_sessions","media_jobs","cache_write_reservations","playback_preparations","media_executions"].entries()) {
    await check(`0045_nowait_${table}_rolls_back_and_retry_succeeds`,async()=>{
      const db=database(`busy45_${index}`,"base44");
      await withLock(db,table,()=>migrate45(db,/55P03:.*could not obtain lock/));
      migrate45(db);
    });
  }
  for(const [name,statement,expected] of [
    ["session_without_completed_publication",sessionInsert(),/static_hls_parent_atomic_publication_required/],
    ["session_and_capture_without_completed_response",sessionInsert()+publishCapture,/static_hls_parent_atomic_publication_required/],
    ["completed_response_without_session",completeRequest,/static_hls_parent_publication_required/],
    ["published_phase_without_session",`UPDATE static_hls_captures SET publication_phase='published_parent',published_at=clock_timestamp(),published_resource='{}';`,/static_hls_parent_publication_required/],
    ["resource_unknown_field",sessionInsert(`(${envelope})||'{"unexpected":true}'::jsonb`),/static_hls_parent_publication_required/],
    ["resource_foreign_worker",sessionInsert(`jsonb_set((${envelope}),'{static_hls_input,worker_instance}',to_jsonb(gen_random_uuid()))`),/static_hls_parent_publication_required/],
    ["source_revision_changed_before_commit",complete+"UPDATE sources SET config_encrypted='changed-current-config';",/static_hls_parent_publication_authority_required/],
    ["login_limit_shortened_before_commit",complete+"UPDATE sessions SET expires_at=clock_timestamp()+interval '10 seconds';",/static_hls_parent_publication_authority_required/]
  ]) {
    await check(`publication_${name}_rolls_back`,()=>{
      const db=seed(`reject45_${report.checks.length}`); reject(db,statement,expected); assertUnpublished(db);
    });
  }
  for(const reader of [1,3]) {
    await check(`reader${reader}_cannot_publish_parent`,()=>{
      const db=seed(`reader45_${reader}`);
      reject(db,`SELECT set_config('rainsync.static_hls_reader','${reader}',true); ${complete}`,/static_hls_parent_publication_required/);
      assertUnpublished(db);
    });
  }
  await check("volatile_predicate_can_mix_old_pending_phase_with_committed_parent",()=>phaseSnapshotRace(seed("mixed_phase45"),false));
  await check("capture_share_lock_keeps_phase_and_authority_coherent_across_publication",()=>phaseSnapshotRace(seed("locked_phase45"),true));
  const published=seed("published45");
  await check("exact_atomic_parent_preserves_admission_and_reservation",()=>{
    const original=scalar(published,"SELECT resource_authority::text FROM static_hls_captures;");
    sql(published,`BEGIN; ${fence} ${complete} COMMIT;`);
    assert.equal(scalar(published,"SELECT resource_authority::text FROM static_hls_captures;"),original);
    assert.equal(scalar(published,"SELECT status FROM playback_requests;"),"completed");
    assert.equal(scalar(published,"SELECT publication_phase FROM static_hls_captures;"),"published_parent");
    assert.equal(scalar(published,"SELECT bytes FROM cache_write_reservations;"),"134217728");
    assert.equal(scalar(published,`BEGIN; ${fence} SELECT static_hls_session_allowed('${sid}'); ROLLBACK;`).split("\n").at(-2),"t");
  });
  await check("reader1_compatibility_is_not_authority_revocation",()=>{
    const result=scalar(published,`BEGIN; SELECT set_config('rainsync.static_hls_reader','1',true);
      SELECT static_hls_session_authority_allowed('${sid}'),static_hls_session_allowed('${sid}'),playback_source_allowed(media_id,resource) FROM playback_sessions;
      WITH changed AS(UPDATE playback_sessions SET stopped=true RETURNING 1) SELECT count(*) FROM changed; ROLLBACK;`);
    assert.ok(result.includes("t|f|f")); assert.ok(result.includes("\n0\n"));
    assert.equal(scalar(published,"SELECT stopped FROM playback_sessions;"),"f");
  });
  for(const [name,statement,expected] of [
    ["completed_cipher", "UPDATE playback_requests SET response_encrypted='another-cipher';",/static_hls_pending_request_immutable/],
    ["published_wrapper", "UPDATE static_hls_captures SET published_resource=published_resource||'{\"encrypted\":\"another-cipher\"}';",/static_hls_published_capture_immutable/],
    ["phase_regression", "UPDATE static_hls_captures SET publication_phase='pending_parent',published_resource=NULL,published_at=NULL;",/static_hls_published_capture_immutable/],
    ["root_mutation", "UPDATE static_hls_captures SET root_digest=repeat('e',64);",/static_hls_published_capture_immutable/],
    ["session_marker_erasure", "UPDATE playback_sessions SET static_hls_capture_id=NULL,resource=resource-'static_hls_capture_id';",/static_hls_parent_publication_required/]
  ]) await check(`immutable_${name}`,()=>reject(published,statement,expected));
  const executionId=randomUUID(), deliveryOwner=randomUUID();
  const deliveryInsert=`INSERT INTO media_executions(id,session_id,kind,owner_id) VALUES('${executionId}','${sid}','delivery','${deliveryOwner}');`;
  await check("parent_delivery_requires_exact_reader2_recipe1",()=>{
    for(const [reader,recipe] of [[1,1],[3,1],[2,2]]) {
      sql(published,`BEGIN; SELECT set_config('rainsync.static_hls_reader','${reader}',true),set_config('rainsync.static_hls_pending_recipe','${recipe}',true); ${deliveryInsert} COMMIT;`);
      assert.equal(scalar(published,"SELECT count(*) FROM media_executions;"),"0");
    }
  });
  await check("parent_delivery_registers_original_reader2_receipt",()=>{
    sql(published,`BEGIN; ${fence} ${deliveryInsert} COMMIT;`);
    assert.equal(scalar(published,"SELECT count(*) FROM media_executions WHERE reaped_at IS NULL;"),"1");
  });
  for(const [name,statement] of [
    ["owner",`UPDATE media_executions SET owner_id=gen_random_uuid();`],
    ["session",`UPDATE media_executions SET session_id=gen_random_uuid();`],
    ["kind",`UPDATE media_executions SET kind='job';`],
  ]) await check(`parent_delivery_immutable_${name}`,()=>reject(published,statement,/static_hls_parent_delivery_immutable/));
  await check("parent_delivery_rejects_old_reader_ack_and_retains_history",()=>{
    const result=scalar(published,`BEGIN; SELECT set_config('rainsync.static_hls_reader','1',true);
      WITH changed AS(UPDATE media_executions SET reaped_at=clock_timestamp() RETURNING 1) SELECT count(*) FROM changed; ROLLBACK;`);
    assert.ok(result.includes("\n0\n"));
    assert.equal(scalar(published,`BEGIN; ${fence} WITH removed AS(DELETE FROM media_executions RETURNING 1) SELECT count(*) FROM removed; ROLLBACK;`).split("\n").at(-2),"0");
  });
  await check("published_verify_and_cancel_do_not_acquire_budget",async()=>{
    await withLock(published,"cache_budget",()=>{
      sql(published,`BEGIN; SET LOCAL lock_timeout='500ms'; SELECT set_config('rainsync.static_hls_reader','1',true);
        UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=410,error_code='static_hls_operation_cancelled';
        UPDATE playback_sessions SET stopped=true; UPDATE static_hls_captures SET state='cancelled'; COMMIT;`);
    },{budget:true});
    assert.equal(scalar(published,"SELECT bytes FROM cache_write_reservations;"),"134217728");
    assert.equal(scalar(published,`SELECT static_hls_session_authority_allowed('${sid}');`),"f");
  });
  await check("parent_delivery_original_receipt_ack_survives_revocation_and_retry",()=>{
    sql(published,`BEGIN; ${fence} UPDATE media_executions SET reaped_at=COALESCE(reaped_at,clock_timestamp()) WHERE id='${executionId}' AND owner_id='${deliveryOwner}'; COMMIT;`);
    const reaped=scalar(published,"SELECT reaped_at::text FROM media_executions;");
    assert.ok(reaped.length>0);
    sql(published,`BEGIN; ${fence} UPDATE media_executions SET reaped_at=COALESCE(reaped_at,clock_timestamp()) WHERE id='${executionId}' AND owner_id='${deliveryOwner}'; COMMIT;`);
    assert.equal(scalar(published,"SELECT reaped_at::text FROM media_executions;"),reaped);
  });
  await check("publication_cannot_delete_or_release_unconfirmed_owner",()=>{
    assert.equal(scalar(published,"WITH removed AS(DELETE FROM cache_write_reservations RETURNING 1) SELECT count(*) FROM removed;"),"0");
    assert.equal(scalar(published,"WITH removed AS(DELETE FROM static_hls_captures RETURNING 1) SELECT count(*) FROM removed;"),"0");
  });
  await check("published_positive_sql_closure_and_release_are_one_transaction",()=>{
    reject(published,`UPDATE static_hls_captures SET state='disposed',streams_closed_at=clock_timestamp(),process_closed_at=clock_timestamp(),
      process_disposition='reaped',files_removed_at=clock_timestamp(),disposed_at=clock_timestamp();`,/static_hls_pending_reservation_required/);
    sql(published,`BEGIN; ${fence} SELECT revision FROM cache_budget WHERE singleton FOR UPDATE;
      UPDATE static_hls_captures SET state='disposed',streams_closed_at=clock_timestamp(),process_closed_at=clock_timestamp(),
      process_disposition='reaped',files_removed_at=clock_timestamp(),disposed_at=clock_timestamp();
      DELETE FROM cache_write_reservations; UPDATE cache_budget SET revision=revision+1; COMMIT;`);
    assert.equal(scalar(published,"SELECT count(*) FROM cache_write_reservations;"),"0");
    assert.equal(scalar(published,"SELECT state FROM static_hls_captures;"),"disposed");
  });
  report.finalInputsUnchanged=report.inputs.every(({path,sha256})=>hash(readFileSync(join(root,path)))===sha256);
  assert.ok(report.finalInputsUnchanged);
  report.passed=true;
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
