// Owned PostgreSQL 1–38 -> 39 upgrade and a separate fresh 1–39 install.
// Generated SQL fixtures only: no real historical database or service build.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedPostgres } from "./fixtures/postgres.mjs";

assert.ok(
  process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  "Owned native PostgreSQL required",
);
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Set RAINSYNC_ARTIFACT_DIR");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const id = randomUUID();
const root = resolve(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "job-timing-migration",
  id,
);
await mkdir(root, { recursive: true });
const historicalReference = "d7cb0ed6309bbb555773c9b61f27ac83a4a8a570";
const migrationName = "0039_media_job_timing.sql";
const fields = [
  "timing_version",
  "timing_attempt",
  "queue_entered_at",
  "run_started_at",
];
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const hash = (bytes, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");
const git = (args) => execFileSync("git", args, { cwd: repo, timeout: 10000 });
const priorPgOptions = process.env.PGOPTIONS;
process.env.PGOPTIONS =
  "-c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000";
const report = {
  schema_version: 1,
  result: "running",
  fixture_id: id,
  started_at: new Date().toISOString(),
  scope:
    "Generated rows in two explicitly fresh owned native PostgreSQL databases; SQL migration and rollback evidence, not production upgrade or runtime duration evidence",
  deadlines: {
    statement_ms: 5000,
    lock_ms: 1000,
    idle_transaction_ms: 10000,
    fixture_sql_process_ms: 30000,
  },
  historical_reference: historicalReference,
  source_head: git(["rev-parse", "HEAD"]).toString().trim(),
  inputs: [],
  checks: [],
  rejected_tuples: [],
  fixtures: [],
};
const check = (name, run) => {
  run();
  report.checks.push(name);
  console.log("PASS: " + name);
};
const sqlxTable =
  "CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), success BOOLEAN NOT NULL, checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL)";
const apply = (db, input, ending = "COMMIT") => {
  const version = Number(input.name.split("_")[0]);
  const description = input.name
    .replace(/^\d+_/, "")
    .replace(/\.sql$/, "")
    .replaceAll("_", " ");
  db.sql(
    `BEGIN; ${input.bytes}; INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(${version},${quote(description)},true,decode(${quote(input.sha384)},'hex'),0); ${ending};`,
  );
};
const ledger = (db, upper = 39) =>
  db.sql(
    `SELECT jsonb_agg(jsonb_build_object('version',version,'checksum',encode(checksum,'hex'),'success',success) ORDER BY version) FROM _sqlx_migrations WHERE version<=${upper}`,
  );
const snapshot = (db, withoutTiming = false) =>
  db.sql(
    `SELECT jsonb_agg(${withoutTiming ? `to_jsonb(j)-ARRAY[${fields.map(quote).join(",")}]` : "to_jsonb(j)"} ORDER BY id) FROM media_jobs j`,
  );
const row = (db, job) =>
  db.sql(`SELECT row_to_json(j) FROM media_jobs j WHERE id=${quote(job)}`);
const tuple = (db, job) =>
  db.sql(
    `SELECT jsonb_build_array(${fields.join(",")}) FROM media_jobs WHERE id=${quote(job)}`,
  );
const columns = (db) =>
  JSON.parse(
    db.sql(
      `SELECT COALESCE(jsonb_agg(jsonb_build_object('name',column_name,'type',data_type,'nullable',is_nullable,'default',column_default) ORDER BY ordinal_position),'[]') FROM information_schema.columns WHERE table_schema='public' AND table_name='media_jobs' AND column_name IN (${fields.map(quote).join(",")})`,
    ),
  );
const matchesCurrentPhase = (db, job) =>
  db.sql(
    `SELECT COALESCE(timing_version=1 AND timing_attempt=attempt AND ((status='queued' AND queue_entered_at IS NOT NULL AND run_started_at IS NULL) OR (status='running' AND run_started_at IS NOT NULL AND queue_entered_at IS NULL)),false) FROM media_jobs WHERE id=${quote(job)}`,
  );
const reject = (db, job, name, values) => {
  const before = row(db, job);
  let error;
  try {
    db.sql(
      `UPDATE media_jobs SET ${fields.map((field, i) => `${field}=${values[i]}`).join(",")} WHERE id=${quote(job)}`,
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "expected PostgreSQL rejection: " + name);
  assert.equal(error.status, 1, "psql rejects " + name);
  assert.match(
    String(error.stderr),
    /violates check constraint "media_jobs_timing_shape"/,
  );
  assert.equal(row(db, job), before, "rejected tuple preserves complete row");
  report.rejected_tuples.push({
    name,
    constraint: "media_jobs_timing_shape",
    psql_exit_code: error.status,
  });
};

let failure;
const fixtures = [];
try {
  const names = (await readdir(resolve(repo, "migrations")))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  assert.deepEqual(
    names.map((name) => Number(name.split("_")[0])),
    Array.from({ length: 39 }, (_, index) => index + 1),
    "current branch has exactly migrations 1–39",
  );
  const inputs = [];
  for (const name of names) {
    const bytes = await readFile(resolve(repo, "migrations", name));
    const input = {
      name,
      bytes,
      sha256: hash(bytes),
      sha384: hash(bytes, "sha384"),
    };
    if (Number(name.split("_")[0]) <= 38)
      assert.equal(
        hash(git(["show", `${historicalReference}:migrations/${name}`])),
        input.sha256,
        "historical migration unchanged: " + name,
      );
    inputs.push(input);
    report.inputs.push({
      name: "migrations/" + name,
      sha256: input.sha256,
      sha384: input.sha384,
    });
  }
  for (const name of [
    "tests/job-timing-migration.mjs",
    "tests/fixtures/postgres.mjs",
  ])
    report.inputs.push({
      name,
      sha256: hash(await readFile(resolve(repo, name))),
    });
  const migration = inputs.find((input) => input.name === migrationName);
  check("all 38 historical migration bytes match the pre-0039 commit", () =>
    assert.equal(inputs.length, 39),
  );
  const db = isolatedPostgres({
    root: resolve(root, "upgrade"),
    name: "job-timing-upgrade",
    id,
  });
  fixtures.push(db);
  await db.start();
  report.fixtures.push({ name: "upgrade", postgres: db.diagnostics() });
  check("SQL work is bounded by configured PostgreSQL deadlines", () => {
    assert.equal(db.sql("SHOW statement_timeout"), "5s");
    assert.equal(db.sql("SHOW lock_timeout"), "1s");
    assert.equal(db.sql("SHOW idle_in_transaction_session_timeout"), "10s");
  });
  db.sql(sqlxTable);
  for (const input of inputs.slice(0, 38)) apply(db, input);
  const statuses = ["queued", "running", "succeeded", "failed", "cancelled"];
  const jobs = statuses.map(() => randomUUID());
  for (const [index, status] of statuses.entries())
    db.sql(
      `INSERT INTO media_jobs(id,status,spec,attempt,max_attempts,owner_id,lease_until,error,created_at,available_at) VALUES(${quote(jobs[index])},${quote(status)},${quote(JSON.stringify({ fixture: "old-" + status }))}::jsonb,${[0, 4, 1, 3, 2][index]},7,${status === "running" ? quote(randomUUID()) : "NULL"},${status === "running" ? "'2030-01-01T00:00:00Z'" : "NULL"},${status === "failed" ? "'retained failure'" : "NULL"},'2001-01-01T00:00:00Z','2002-01-01T00:00:00Z')`,
    );
  const before = snapshot(db),
    historicalLedger = ledger(db, 38);
  check(
    "migration rollback preserves the prior schema, ledger and old rows",
    () => {
      apply(db, migration, "ROLLBACK");
      assert.deepEqual(columns(db), []);
      assert.equal(
        db.sql(
          "SELECT count(*) FROM pg_constraint WHERE conname='media_jobs_timing_shape'",
        ),
        "0",
      );
      assert.equal(snapshot(db), before);
      assert.equal(ledger(db), historicalLedger);
    },
  );
  apply(db, migration);
  check(
    "1–38 to 39 upgrade preserves queued, running and terminal rows with entirely absent timing",
    () => {
      assert.equal(snapshot(db, true), before);
      assert.equal(
        db.sql(
          `SELECT count(*) FROM media_jobs WHERE ${fields.map((field) => `${field} IS NULL`).join(" AND ")}`,
        ),
        "5",
      );
      assert.equal(ledger(db, 38), historicalLedger);
      assert.equal(
        db.sql("SELECT max(version) FROM _sqlx_migrations WHERE success"),
        "39",
      );
    },
  );
  check(
    "four added columns are nullable with no defaults or timestamp backfill",
    () =>
      assert.deepEqual(
        columns(db),
        fields.map((name, index) => ({
          name,
          type: [
            "smallint",
            "bigint",
            "timestamp with time zone",
            "timestamp with time zone",
          ][index],
          nullable: "YES",
          default: null,
        })),
      ),
  );
  const queueJob = randomUUID(),
    runJob = randomUUID(),
    unknownJob = randomUUID();
  check(
    "correct new queue and run tuples and all-null old-writer inserts are accepted",
    () => {
      db.sql(
        `INSERT INTO media_jobs(id,status,spec,attempt,timing_version,timing_attempt,queue_entered_at,run_started_at) VALUES(${quote(queueJob)},'queued','{}',0,1,0,'2026-01-01T00:00:00Z',NULL),(${quote(runJob)},'running','{}',6,1,6,NULL,'2026-01-02T00:00:00Z'); INSERT INTO media_jobs(id,status,spec) VALUES(${quote(unknownJob)},'queued','{}')`,
      );
      assert.equal(matchesCurrentPhase(db, queueJob), "t");
      assert.equal(matchesCurrentPhase(db, runJob), "t");
      assert.equal(tuple(db, unknownJob), "[null, null, null, null]");
      db.sql(
        `UPDATE media_jobs SET timing_attempt=9223372036854775807 WHERE id=${quote(runJob)}`,
      );
      assert.equal(
        db.sql(
          `SELECT timing_attempt FROM media_jobs WHERE id=${quote(runJob)}`,
        ),
        "9223372036854775807",
      );
    },
  );
  check(
    "every partial/null shape, both/neither phases, unsupported version, negative attempt and infinite timestamp is rejected atomically",
    () => {
      for (let mask = 1; mask < 16; mask++) {
        if (mask === 7 || mask === 11) continue;
        const values = [
          "1",
          "0",
          "'2026-01-01T00:00:00Z'::timestamptz",
          "'2026-01-02T00:00:00Z'::timestamptz",
        ].map((value, index) => (mask & (1 << index) ? value : "NULL"));
        reject(
          db,
          queueJob,
          `null-shape-${mask.toString(2).padStart(4, "0")}`,
          values,
        );
      }
      for (const version of ["0", "2", "-1"])
        reject(db, queueJob, "unsupported-version-" + version, [
          version,
          "0",
          "'2026-01-01T00:00:00Z'",
          "NULL",
        ]);
      reject(db, queueJob, "negative-attempt", [
        "1",
        "-1",
        "'2026-01-01T00:00:00Z'",
        "NULL",
      ]);
      for (const phase of [2, 3])
        for (const infinity of ["infinity", "-infinity"]) {
          const values = ["1", "0", "NULL", "NULL"];
          values[phase] = quote(infinity) + "::timestamptz";
          reject(db, queueJob, fields[phase] + "-" + infinity, values);
        }
      assert.equal(report.rejected_tuples.length, 21);
    },
  );
  check(
    "old writers can change status and attempt while stale tuple shapes remain representable",
    () => {
      const previousTuple = tuple(db, queueJob);
      db.sql(
        `UPDATE media_jobs SET status='running' WHERE id=${quote(queueJob)}`,
      );
      assert.equal(tuple(db, queueJob), previousTuple);
      assert.equal(
        matchesCurrentPhase(db, queueJob),
        "f",
        "phase mismatch is not matching timing evidence",
      );
      db.sql(
        `UPDATE media_jobs SET status='queued',attempt=attempt+1 WHERE id=${quote(queueJob)}`,
      );
      assert.equal(tuple(db, queueJob), previousTuple);
      assert.equal(
        matchesCurrentPhase(db, queueJob),
        "f",
        "attempt mismatch is not matching timing evidence",
      );
      db.sql(
        `UPDATE media_jobs SET status='cancelled',attempt=attempt+1 WHERE id=${quote(queueJob)}`,
      );
      assert.equal(tuple(db, queueJob), previousTuple);
      assert.equal(matchesCurrentPhase(db, queueJob), "f");
      db.sql(
        `UPDATE media_jobs SET status='running',attempt=attempt+1 WHERE id=${quote(unknownJob)}`,
      );
      assert.equal(tuple(db, unknownJob), "[null, null, null, null]");
      assert.equal(matchesCurrentPhase(db, unknownJob), "f");
    },
  );
  check(
    "rolled-back state and tuple transition preserves every prior row value",
    () => {
      const previous = row(db, queueJob);
      db.sql(
        `BEGIN; SELECT id FROM media_jobs WHERE id=${quote(queueJob)} FOR UPDATE; UPDATE media_jobs SET status='running',attempt=attempt+1,timing_version=1,timing_attempt=attempt+1,queue_entered_at=NULL,run_started_at='2026-01-03T00:00:00Z' WHERE id=${quote(queueJob)}; ROLLBACK;`,
      );
      assert.equal(row(db, queueJob), previous);
    },
  );
  check(
    "a failed transaction after updating state and tuple rolls both back",
    () => {
      const previous = row(db, queueJob);
      assert.throws(
        () =>
          db.sql(
            `BEGIN; UPDATE media_jobs SET status='running',attempt=attempt+1,timing_version=1,timing_attempt=attempt+1,queue_entered_at=NULL,run_started_at='2026-01-03T00:00:00Z' WHERE id=${quote(queueJob)}; SELECT 1/0; COMMIT;`,
          ),
        (error) =>
          error.status === 1 && /division by zero/.test(String(error.stderr)),
      );
      assert.equal(row(db, queueJob), previous);
    },
  );
  check(
    "complete committed replacement restores a matching tuple and all-null clearing remains valid",
    () => {
      db.sql(
        `BEGIN; UPDATE media_jobs SET status='running',attempt=attempt+1,timing_version=1,timing_attempt=attempt+1,queue_entered_at=NULL,run_started_at='2026-01-03T00:00:00Z' WHERE id=${quote(queueJob)}; COMMIT;`,
      );
      assert.equal(matchesCurrentPhase(db, queueJob), "t");
      db.sql(
        `UPDATE media_jobs SET ${fields.map((field) => `${field}=NULL`).join(",")} WHERE id=${quote(queueJob)}`,
      );
      assert.equal(tuple(db, queueJob), "[null, null, null, null]");
    },
  );
  report.upgrade_final_ledger = JSON.parse(ledger(db));
  const upgradedColumns = columns(db);
  await db.stop();
  report.fixtures[0].cleanup = await db.verifyStopped();
  report.fixtures[0].postgres = db.diagnostics();
  const fresh = isolatedPostgres({
    root: resolve(root, "fresh"),
    name: "job-timing-fresh",
  });
  fixtures.push(fresh);
  await fresh.start();
  report.fixtures.push({ name: "fresh", postgres: fresh.diagnostics() });
  fresh.sql(sqlxTable);
  for (const input of inputs) apply(fresh, input);
  check(
    "separate fresh owned database installs all 39 current migration sources and accepts unknown legacy-style rows",
    () => {
      assert.equal(
        fresh.sql("SELECT count(*) FROM _sqlx_migrations WHERE success"),
        "39",
      );
      assert.deepEqual(JSON.parse(ledger(fresh)), report.upgrade_final_ledger);
      assert.deepEqual(columns(fresh), upgradedColumns);
      fresh.sql(
        `INSERT INTO media_jobs(id,status,spec) VALUES(${quote(randomUUID())},'queued','{}')`,
      );
      assert.equal(
        fresh.sql(
          `SELECT count(*) FROM media_jobs WHERE ${fields.map((field) => `${field} IS NULL`).join(" AND ")}`,
        ),
        "1",
      );
    },
  );
  check(
    "all migration and fixture source hashes remain unchanged after SQL work",
    () => {
      for (const input of report.inputs)
        assert.equal(
          hash(readFileSync(resolve(repo, input.name))),
          input.sha256,
          input.name,
        );
    },
  );
  report.result = "passed";
} catch (error) {
  failure = error;
  report.result = "failed";
  report.failure = String(error.stack ?? error);
} finally {
  for (const [index, fixture] of fixtures.entries()) {
    try {
      await fixture.stop();
      const cleanup = await fixture.verifyStopped();
      report.fixtures[index] ??= { name: index === 0 ? "upgrade" : "fresh" };
      Object.assign(report.fixtures[index], {
        cleanup,
        postgres: fixture.diagnostics(),
      });
    } catch (error) {
      report.cleanup_failure = String(error.stack ?? error);
      report.result = "failed";
      failure ??= error;
    }
  }
  if (priorPgOptions === undefined) delete process.env.PGOPTIONS;
  else process.env.PGOPTIONS = priorPgOptions;
  report.finished_at = new Date().toISOString();
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `${report.result}: ${report.checks.length} checks, ${report.rejected_tuples.length} PostgreSQL tuple rejections; ${resolve(root, "report.json")}`,
  );
}
if (failure) throw failure;
