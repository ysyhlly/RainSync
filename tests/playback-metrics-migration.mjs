// Fresh generated data only: real PostgreSQL 1–34 -> 35 -> 36 and constraints.
// Direct SQL migration execution deliberately does not claim SQLx runner coverage.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isolatedPostgres,
  verifyClosedPort,
  verifyPidAbsent,
} from "./fixtures/postgres.mjs";

assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Set RAINSYNC_ARTIFACT_DIR");
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const id = randomUUID();
const root = resolve(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "playback-metrics-migration",
  id,
);
await mkdir(root, { recursive: true });
const db = isolatedPostgres({ root, name: "metrics-migration", id });
const owner = randomUUID(),
  room = randomUUID(),
  viewer = randomUUID();
const initialRoom = randomUUID(),
  initialViewer = randomUUID();
const legacySession = randomUUID(),
  boundSession = randomUUID();
const legacyKey = randomUUID(),
  boundKey = randomUUID();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const metricsColumns = [
  "metrics_meter_start_generation",
  "metrics_media_generation",
  "metrics_lifecycle_epoch",
  "metrics_startup_origin",
  "metrics_seq",
  "metrics_payload",
  "metrics_closed",
  "metrics_admitted_at",
  "metrics_anchor_elapsed_ms",
  "metrics_anchor_received_at",
];
const scope = `user_id='${owner}' AND room_id='${room}' AND viewer_id='${viewer}'`;
const initialScope = `user_id='${owner}' AND room_id='${initialRoom}' AND viewer_id='${initialViewer}'`;
const report = {
  schema_version: 1,
  result: "running",
  migration_runner: "direct SQL in transactions",
  migrations: [],
  checks: [],
  rejections: [],
  limitation:
    "Preserved 1,024 counted viewer identities; backend admission enforcement is tested separately.",
};
const check = (name, fn) => {
  fn();
  report.checks.push(name);
};
const reject = (label, sql, constraint) => {
  assert.throws(
    () => db.sql(sql),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(
        String(error.stderr),
        new RegExp(`violates check constraint "${constraint}"`),
      );
      return true;
    },
    label,
  );
  report.rejections.push({ label, constraint });
};
const rejectNull = (column, where = scope) => {
  assert.throws(
    () =>
      db.sql(`UPDATE playback_viewer_plans SET ${column}=NULL WHERE ${where}`),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(
        String(error.stderr),
        new RegExp(
          `null value in column "${column}".*violates not-null constraint`,
        ),
      );
      return true;
    },
  );
  report.rejections.push({
    label: `slot rejects NULL ${column}`,
    constraint: `${column} NOT NULL`,
  });
};
const snapshot = (table, omitted = []) =>
  hash(
    db.sql(
      `SELECT coalesce(jsonb_agg(to_jsonb(t)${omitted.length ? `-ARRAY[${omitted.map((c) => `'${c}'`).join(",")}]` : ""} ORDER BY to_jsonb(t)->>'id',to_jsonb(t)->>'viewer_id',to_jsonb(t)->>'idempotency_key')::text,'[]') FROM ${table} t`,
    ),
  );
let fixtureStopped = false,
  restarted,
  restartDone,
  restartLog;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function restartOwnedCluster() {
  const diagnostic = db.diagnostics();
  if (db.kind === "docker") {
    execFileSync("docker", ["restart", diagnostic.container], {
      timeout: 30000,
      stdio: "pipe",
    });
    report.restart = { kind: "docker", container: diagnostic.container };
  } else {
    await db.stop();
    fixtureStopped = true;
    report.cleanup_before_restart = await db.verifyStopped();
    const { binary, data_directory: data, binary_sha256 } = diagnostic.native;
    assert.equal(hash(await readFile(binary)), binary_sha256);
    restartLog = createWriteStream(resolve(root, "postgres-restart.log"));
    restarted = spawn(
      binary,
      ["-D", data, "-h", "127.0.0.1", "-p", String(diagnostic.port), "-k", ""],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    report.restart = {
      kind: "native",
      binary_sha256,
      data_directory: data,
      port: diagnostic.port,
      pid: restarted.pid,
      started_at: new Date().toISOString(),
    };
    restartDone = new Promise((done) =>
      restarted.once("close", (code, signal) => {
        Object.assign(report.restart, {
          closed_at: new Date().toISOString(),
          exit_code: code,
          signal,
        });
        done();
      }),
    );
    restarted.once("error", (error) => {
      report.restart.spawn_error = String(error);
    });
    restarted.stdout.pipe(restartLog, { end: false });
    restarted.stderr.pipe(restartLog, { end: false });
    assert.notEqual(restarted.pid, diagnostic.native.pid);
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      assert.equal(db.sql("SELECT 1"), "1");
      return;
    } catch (error) {
      if (
        attempt === 99 ||
        restarted?.exitCode != null ||
        report.restart.spawn_error
      )
        throw error;
      await delay(100);
    }
  }
}

try {
  report.inputs = {
    test_sha256: hash(await readFile(fileURLToPath(import.meta.url))),
    postgres_fixture_sha256: hash(
      await readFile(resolve(checkout, "tests/fixtures/postgres.mjs")),
    ),
  };
  await db.start();
  report.postgres = db.diagnostics();
  const files = (await readdir(resolve(checkout, "migrations")))
    .filter(
      (name) => /^\d+_.+\.sql$/.test(name) && Number(name.split("_")[0]) <= 36,
    )
    .sort();
  assert.deepEqual(
    files.map((name) => Number(name.split("_")[0])),
    Array.from({ length: 36 }, (_, i) => i + 1),
  );
  const historical = files.filter((name) => Number(name.split("_")[0]) <= 34);
  for (const name of historical) {
    const bytes = await readFile(resolve(checkout, "migrations", name));
    db.sql(`BEGIN; ${bytes}; COMMIT;`);
    report.migrations.push({ name, sha256: hash(bytes) });
  }
  db.sql(`
    INSERT INTO users(id,username,password_hash) VALUES('${owner}','generated-metrics-upgrade-owner','not-for-login');
    INSERT INTO rooms(id,name,owner_id,lifecycle_epoch) VALUES('${room}','generated metrics upgrade room','${owner}',5);
    INSERT INTO rooms(id,name,owner_id) VALUES('${initialRoom}','generated initial epoch room','${owner}');
    INSERT INTO room_members(room_id,user_id) VALUES('${room}','${owner}');
    INSERT INTO room_members(room_id,user_id) VALUES('${initialRoom}','${owner}');
    INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation)
      SELECT '${owner}','${room}',CASE WHEN g=1 THEN '${viewer}'::uuid ELSE md5('${id}:'||g)::uuid END,
        CASE WHEN g=1 THEN 9 ELSE g END FROM generate_series(1,1024) g;
    INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation)
      VALUES('${owner}','${initialRoom}','${initialViewer}',1);
    INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at)
      VALUES('${legacySession}','${owner}','${room}',3,'generated-legacy-metrics-token','{"generated":"legacy"}',now()+interval '1 hour');
    INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation)
      VALUES('${boundSession}','${owner}','${room}',4,'generated-bound-metrics-token','{"generated":"bound"}',now()+interval '1 hour',5,'${viewer}',9);
    INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,response_encrypted,lease_until,expires_at)
      VALUES('${owner}','${legacyKey}','generated-legacy-hash','${legacySession}','${randomUUID()}','completed','generated-legacy-encrypted',now()+interval '1 minute',now()+interval '1 day');
    INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,response_encrypted,lease_until,expires_at,room_id,lifecycle_epoch,viewer_id,plan_generation)
      VALUES('${owner}','${boundKey}','generated-bound-hash','${boundSession}','${randomUUID()}','completed','generated-bound-encrypted',now()+interval '1 minute',now()+interval '1 day','${room}',5,'${viewer}',9);
  `);
  const before = {
    viewers: snapshot("playback_viewer_plans"),
    sessions: snapshot("playback_sessions"),
    requests: snapshot("playback_requests"),
    users: snapshot("users"),
    rooms: snapshot("rooms"),
  };
  report.before = {
    row_hashes: before,
    viewer_count: Number(
      db.sql(
        `SELECT count(*) FROM playback_viewer_plans WHERE user_id='${owner}' AND room_id='${room}'`,
      ),
    ),
  };
  const name = "0035_playback_metrics.sql",
    bytes = await readFile(resolve(checkout, "migrations", name));
  db.sql(`BEGIN; ${bytes}; COMMIT;`);
  report.migrations.push({ name, sha256: hash(bytes) });
  check("populated 1–34 -> 35 preserves every legacy row value", () => {
    assert.equal(
      snapshot("playback_viewer_plans", metricsColumns),
      before.viewers,
    );
    assert.equal(
      snapshot("playback_sessions", [
        "playback_metrics_version",
        "metrics_meter_start_generation",
      ]),
      before.sessions,
    );
    for (const table of ["playback_requests", "users", "rooms"])
      assert.equal(
        snapshot(table),
        before[
          { playback_requests: "requests", users: "users", rooms: "rooms" }[
            table
          ]
        ],
      );
  });
  check("legacy and fenced grants remain unnegotiated NULL pairs", () =>
    assert.equal(
      db.sql(
        "SELECT bool_and(playback_metrics_version IS NULL AND metrics_meter_start_generation IS NULL) FROM playback_sessions",
      ),
      "t",
    ),
  );
  const empty = `metrics_meter_start_generation IS NULL AND metrics_media_generation IS NULL AND metrics_lifecycle_epoch IS NULL
    AND metrics_startup_origin IS NULL AND metrics_seq=0 AND metrics_payload IS NULL AND NOT metrics_closed
    AND metrics_admitted_at IS NULL AND metrics_anchor_elapsed_ms IS NULL AND metrics_anchor_received_at IS NULL`;
  check("all 1,024 existing high-water rows gain an empty optional slot", () =>
    assert.equal(
      db.sql(
        `SELECT count(*)=1024 AND bool_and(${empty}) FROM playback_viewer_plans WHERE user_id='${owner}' AND room_id='${room}'`,
      ),
      "t",
    ),
  );
  const grantCases = [
    ["version alone", "playback_metrics_version=1"],
    ["generation alone", "metrics_meter_start_generation=1"],
    [
      "unknown version",
      "playback_metrics_version=2,metrics_meter_start_generation=1",
    ],
    [
      "zero generation",
      "playback_metrics_version=1,metrics_meter_start_generation=0",
    ],
    [
      "negative generation",
      "playback_metrics_version=1,metrics_meter_start_generation=-1",
    ],
    [
      "future generation",
      "playback_metrics_version=1,metrics_meter_start_generation=10",
    ],
    [
      "NULL user",
      "playback_metrics_version=1,metrics_meter_start_generation=1,user_id=NULL",
    ],
    [
      "NULL viewer and plan",
      "playback_metrics_version=1,metrics_meter_start_generation=1,viewer_id=NULL,plan_generation=NULL",
    ],
  ];
  for (const [label, fields] of grantCases)
    reject(
      `grant rejects ${label}`,
      `UPDATE playback_sessions SET ${fields} WHERE id='${boundSession}'`,
      "playback_session_metrics_pair",
    );
  // Room identity is immutable on UPDATE since migration30; INSERT isolates
  // the new pair's NULL-room guard rather than tripping that existing trigger.
  reject(
    "grant rejects NULL room",
    `INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at,viewer_id,plan_generation,playback_metrics_version,metrics_meter_start_generation)
    VALUES('${randomUUID()}','${owner}',NULL,4,'generated-missing-room-token','{}',now()+interval '1 hour','${viewer}',9,1,1)`,
    "playback_session_metrics_pair",
  );
  check(
    "legacy grant cannot attach metrics with unknown viewer authority",
    () =>
      reject(
        "legacy grant missing viewer authority",
        `UPDATE playback_sessions SET playback_metrics_version=1,metrics_meter_start_generation=1 WHERE id='${legacySession}'`,
        "playback_session_metrics_pair",
      ),
  );
  check("fenced grants accept generation endpoints", () => {
    db.sql(
      `UPDATE playback_sessions SET playback_metrics_version=1,metrics_meter_start_generation=1 WHERE id='${boundSession}'`,
    );
    db.sql(
      `UPDATE playback_sessions SET metrics_meter_start_generation=9 WHERE id='${boundSession}'`,
    );
    assert.equal(
      db.sql(
        `SELECT playback_metrics_version=1 AND metrics_meter_start_generation=plan_generation FROM playback_sessions WHERE id='${boundSession}'`,
      ),
      "t",
    );
  });
  const emptyCases = [
    ["start only", "metrics_meter_start_generation=1"],
    ["media only", "metrics_media_generation=0"],
    ["epoch only", "metrics_lifecycle_epoch=1"],
    ["origin only", "metrics_startup_origin='user_intent'"],
    ["sequence only", "metrics_seq=1"],
    ["payload only", "metrics_payload='{}'"],
    ["closed empty slot", "metrics_closed=true"],
    ["admitted time only", "metrics_admitted_at=clock_timestamp()"],
    ["elapsed anchor only", "metrics_anchor_elapsed_ms=0"],
    ["received anchor only", "metrics_anchor_received_at=clock_timestamp()"],
  ];
  for (const [label, fields] of emptyCases)
    reject(
      `empty slot rejects ${label}`,
      `UPDATE playback_viewer_plans SET ${fields} WHERE ${scope}`,
      "playback_viewer_metrics_slot",
    );
  for (const column of ["metrics_seq", "metrics_closed"]) rejectNull(column);
  const admitted = `metrics_meter_start_generation=1,metrics_media_generation=0,metrics_lifecycle_epoch=1,
    metrics_startup_origin='user_intent',metrics_admitted_at=clock_timestamp()`;
  check(
    "admitted slot accepts zero samples and independent generation clocks",
    () => {
      db.sql(`UPDATE playback_viewer_plans SET ${admitted} WHERE ${scope}`);
      assert.equal(
        db.sql(
          `SELECT metrics_seq=0 AND metrics_payload IS NULL AND metrics_anchor_elapsed_ms IS NULL AND metrics_anchor_received_at IS NULL FROM playback_viewer_plans WHERE ${scope}`,
        ),
        "t",
      );
    },
  );
  for (const column of [
    "metrics_meter_start_generation",
    "metrics_media_generation",
    "metrics_lifecycle_epoch",
    "metrics_startup_origin",
    "metrics_admitted_at",
  ])
    reject(
      `admitted slot rejects NULL ${column}`,
      `UPDATE playback_viewer_plans SET ${column}=NULL WHERE ${scope}`,
      "playback_viewer_metrics_slot",
    );
  const admittedCases = [
    ["zero start", "metrics_meter_start_generation=0"],
    ["future start", "metrics_meter_start_generation=10"],
    ["negative media", "metrics_media_generation=-1"],
    ["overflow media", "metrics_media_generation=4294967296"],
    ["zero epoch", "metrics_lifecycle_epoch=0"],
    ["negative epoch", "metrics_lifecycle_epoch=-1"],
    ["unknown origin", "metrics_startup_origin='server_clock'"],
    ["negative sequence", "metrics_seq=-1"],
    ["overflow sequence", "metrics_seq=9007199254740992"],
    ["zero sequence with payload", "metrics_payload='{}'"],
    ["zero sequence with elapsed anchor", "metrics_anchor_elapsed_ms=0"],
    [
      "zero sequence with received anchor",
      "metrics_anchor_received_at=clock_timestamp()",
    ],
  ];
  for (const [label, fields] of admittedCases)
    reject(
      `admitted slot rejects ${label}`,
      `UPDATE playback_viewer_plans SET ${fields} WHERE ${scope}`,
      "playback_viewer_metrics_slot",
    );
  check(
    "sample accepts bounded endpoints and object payload of exactly 4,096 bytes",
    () => {
      db.sql(`UPDATE playback_viewer_plans SET metrics_meter_start_generation=9,metrics_media_generation=4294967295,
      metrics_lifecycle_epoch=9223372036854775807,metrics_startup_origin='automatic_load',metrics_seq=9007199254740991,
      metrics_payload=jsonb_build_object('p',repeat('x',4087)),metrics_anchor_elapsed_ms=604800000,
      metrics_anchor_received_at=clock_timestamp() WHERE ${scope}`);
      assert.equal(
        db.sql(
          `SELECT octet_length(metrics_payload::text)=4096 AND metrics_seq=9007199254740991 AND metrics_anchor_elapsed_ms=604800000 FROM playback_viewer_plans WHERE ${scope}`,
        ),
        "t",
      );
    },
  );
  const sampleCases = [
    ["overflow sequence with full sample", "metrics_seq=9007199254740992"],
    ["NULL payload", "metrics_payload=NULL"],
    ["JSON null payload", "metrics_payload='null'"],
    ["array payload", "metrics_payload='[]'"],
    ["scalar payload", "metrics_payload='1'"],
    [
      "4,097 byte payload",
      "metrics_payload=jsonb_build_object('p',repeat('x',4088))",
    ],
    ["NULL elapsed anchor", "metrics_anchor_elapsed_ms=NULL"],
    ["negative elapsed", "metrics_anchor_elapsed_ms=-1"],
    ["overflow elapsed", "metrics_anchor_elapsed_ms=604800001"],
    ["NULL received anchor", "metrics_anchor_received_at=NULL"],
    ["zero sequence with retained sample", "metrics_seq=0"],
  ];
  for (const [label, fields] of sampleCases)
    reject(
      `sample rejects ${label}`,
      `UPDATE playback_viewer_plans SET ${fields} WHERE ${scope}`,
      "playback_viewer_metrics_slot",
    );
  check(
    "serialized UTF-8 bytes, including multibyte text, enforce the payload budget",
    () => {
      db.sql(
        `UPDATE playback_viewer_plans SET metrics_payload=jsonb_build_object('p',repeat('界',1362)),metrics_anchor_elapsed_ms=0 WHERE ${scope}`,
      );
      assert.equal(
        db.sql(
          `SELECT octet_length(metrics_payload::text) FROM playback_viewer_plans WHERE ${scope}`,
        ),
        "4095",
      );
      reject(
        "UTF-8 payload exceeds 4,096 bytes",
        `UPDATE playback_viewer_plans SET metrics_payload=jsonb_build_object('p',repeat('界',1363)) WHERE ${scope}`,
        "playback_viewer_metrics_slot",
      );
    },
  );
  check(
    "a rejected metrics row rolls back earlier writes in its transaction",
    () => {
      const baseline = snapshot("playback_viewer_plans"),
        roomBaseline = snapshot("rooms");
      reject(
        "whole transaction on rejected slot",
        `BEGIN; UPDATE rooms SET name='must roll back' WHERE id='${room}';
      UPDATE playback_viewer_plans SET plan_generation=10 WHERE ${scope};
      UPDATE playback_viewer_plans SET metrics_seq=-1 WHERE ${scope}; COMMIT;`,
        "playback_viewer_metrics_slot",
      );
      assert.equal(snapshot("playback_viewer_plans"), baseline);
      assert.equal(snapshot("rooms"), roomBaseline);
    },
  );
  check(
    "closing telemetry and retiring a grant retain every counted viewer high-water",
    () => {
      db.sql(`UPDATE playback_viewer_plans SET metrics_closed=true WHERE ${scope};
      UPDATE playback_sessions SET stopped=true WHERE id='${boundSession}';
      UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=410,error_code='playback_request_cancelled' WHERE idempotency_key='${boundKey}'`);
      assert.equal(
        snapshot("playback_viewer_plans", metricsColumns),
        before.viewers,
      );
      assert.equal(
        db.sql(
          `SELECT count(*) FROM playback_viewer_plans WHERE user_id='${owner}' AND room_id='${room}'`,
        ),
        "1024",
      );
      assert.equal(
        db.sql(
          `SELECT plan_generation=9 AND metrics_closed AND metrics_meter_start_generation=9 FROM playback_viewer_plans WHERE ${scope}`,
        ),
        "t",
      );
    },
  );
  check("published35 rejects epoch0 in an existing default-epoch room", () => {
    assert.equal(
      db.sql(`SELECT lifecycle_epoch FROM rooms WHERE id='${initialRoom}'`),
      "0",
    );
    assert.equal(
      db.sql(
        `SELECT ${empty} FROM playback_viewer_plans WHERE ${initialScope}`,
      ),
      "t",
    );
    reject(
      "schema35 initial room epoch0",
      `UPDATE playback_viewer_plans SET
      metrics_meter_start_generation=1,metrics_media_generation=0,metrics_lifecycle_epoch=0,
      metrics_startup_origin='automatic_load',metrics_admitted_at=clock_timestamp() WHERE ${initialScope}`,
      "playback_viewer_metrics_slot",
    );
  });
  const retainedTables = [
    "playback_viewer_plans",
    "playback_sessions",
    "playback_requests",
    "users",
    "rooms",
  ];
  const before36 = Object.fromEntries(
    retainedTables.map((table) => [table, snapshot(table)]),
  );
  report.before36 = {
    row_hashes: before36,
    empty_initial_epoch_slot: true,
    bounded_viewer_count: 1024,
  };
  const slotDefinition = () =>
    db.sql(`SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid='playback_viewer_plans'::regclass AND conname='playback_viewer_metrics_slot'`);
  const definition35 = slotDefinition();
  const correctionName = "0036_playback_metrics_initial_epoch.sql";
  const correctionBytes = await readFile(
    resolve(checkout, "migrations", correctionName),
  );
  db.sql(`BEGIN; ${correctionBytes}; COMMIT;`);
  report.migrations.push({
    name: correctionName,
    sha256: hash(correctionBytes),
  });
  const definition36 = slotDefinition();
  check(
    "populated35 -> 36 preserves closed samples, empty slots, grants and every high-water",
    () => {
      for (const table of retainedTables)
        assert.equal(snapshot(table), before36[table]);
      assert.equal(
        db.sql(
          `SELECT ${empty} FROM playback_viewer_plans WHERE ${initialScope}`,
        ),
        "t",
      );
      assert.equal(
        db.sql(
          `SELECT count(*) FROM playback_viewer_plans WHERE user_id='${owner}' AND room_id='${room}'`,
        ),
        "1024",
      );
    },
  );
  check("36 changes only the real CHECK's minimum lifecycle epoch", () => {
    assert.match(definition35, /metrics_lifecycle_epoch >= 1/);
    assert.equal(
      definition36,
      definition35.replace(
        "metrics_lifecycle_epoch >= 1",
        "metrics_lifecycle_epoch >= 0",
      ),
    );
  });
  report.constraints = { schema35: definition35, schema36: definition36 };
  db.sql(
    `UPDATE playback_sessions SET playback_metrics_version=NULL,metrics_meter_start_generation=NULL WHERE id='${boundSession}'`,
  );
  for (const [label, fields] of grantCases)
    reject(
      `schema36 grant rejects ${label}`,
      `UPDATE playback_sessions SET ${fields} WHERE id='${boundSession}'`,
      "playback_session_metrics_pair",
    );
  db.sql(
    `UPDATE playback_sessions SET playback_metrics_version=1,metrics_meter_start_generation=9 WHERE id='${boundSession}'`,
  );
  for (const [label, fields] of emptyCases)
    reject(
      `schema36 empty slot rejects ${label}`,
      `UPDATE playback_viewer_plans SET ${fields} WHERE ${initialScope}`,
      "playback_viewer_metrics_slot",
    );
  for (const column of ["metrics_seq", "metrics_closed"])
    rejectNull(column, initialScope);
  check(
    "36 admits epoch0 from the existing room while preserving an empty sample",
    () => {
      db.sql(`UPDATE playback_viewer_plans SET metrics_meter_start_generation=1,metrics_media_generation=0,
      metrics_lifecycle_epoch=0,metrics_startup_origin='automatic_load',metrics_admitted_at=clock_timestamp() WHERE ${initialScope}`);
      assert.equal(
        db.sql(`SELECT metrics_lifecycle_epoch=0 AND metrics_seq=0 AND metrics_payload IS NULL
      AND metrics_anchor_elapsed_ms IS NULL AND metrics_anchor_received_at IS NULL FROM playback_viewer_plans WHERE ${initialScope}`),
        "t",
      );
    },
  );
  for (const column of [
    "metrics_meter_start_generation",
    "metrics_media_generation",
    "metrics_lifecycle_epoch",
    "metrics_startup_origin",
    "metrics_admitted_at",
  ])
    reject(
      `schema36 admitted slot rejects NULL ${column}`,
      `UPDATE playback_viewer_plans SET ${column}=NULL WHERE ${initialScope}`,
      "playback_viewer_metrics_slot",
    );
  for (const [label, fields] of admittedCases.filter(
    ([label]) => label !== "zero epoch",
  ))
    reject(
      `schema36 admitted slot rejects ${label}`,
      `UPDATE playback_viewer_plans SET ${fields} WHERE ${initialScope}`,
      "playback_viewer_metrics_slot",
    );
  check("36 accepts a full boundary sample in epoch0", () => {
    db.sql(`UPDATE playback_viewer_plans SET metrics_seq=9007199254740991,metrics_media_generation=4294967295,
      metrics_payload=jsonb_build_object('p',repeat('x',4087)),metrics_anchor_elapsed_ms=604800000,
      metrics_anchor_received_at=clock_timestamp() WHERE ${initialScope}`);
    assert.equal(
      db.sql(`SELECT metrics_lifecycle_epoch=0 AND octet_length(metrics_payload::text)=4096
      AND metrics_seq=9007199254740991 AND metrics_anchor_elapsed_ms=604800000 FROM playback_viewer_plans WHERE ${initialScope}`),
      "t",
    );
  });
  for (const [label, fields] of sampleCases)
    reject(
      `schema36 sample rejects ${label}`,
      `UPDATE playback_viewer_plans SET ${fields} WHERE ${initialScope}`,
      "playback_viewer_metrics_slot",
    );
  check(
    "a rejected epoch0-room row rolls back the whole transaction after36",
    () => {
      const baseline = snapshot("playback_viewer_plans"),
        roomBaseline = snapshot("rooms");
      reject(
        "schema36 transaction with negative epoch",
        `BEGIN;
      UPDATE rooms SET name='must roll back after36' WHERE id='${initialRoom}';
      UPDATE playback_viewer_plans SET plan_generation=2 WHERE ${initialScope};
      UPDATE playback_viewer_plans SET metrics_lifecycle_epoch=-1 WHERE ${initialScope}; COMMIT;`,
        "playback_viewer_metrics_slot",
      );
      assert.equal(snapshot("playback_viewer_plans"), baseline);
      assert.equal(snapshot("rooms"), roomBaseline);
    },
  );
  const durable = {
    viewers: snapshot("playback_viewer_plans"),
    sessions: snapshot("playback_sessions"),
    requests: snapshot("playback_requests"),
  };
  await restartOwnedCluster();
  check(
    "actual PostgreSQL restart after36 preserves epoch0 samples, closed telemetry and all high-waters",
    () => {
      assert.equal(snapshot("playback_viewer_plans"), durable.viewers);
      assert.equal(snapshot("playback_sessions"), durable.sessions);
      assert.equal(snapshot("playback_requests"), durable.requests);
      assert.equal(
        db.sql(
          `SELECT count(*) FROM playback_viewer_plans WHERE user_id='${owner}' AND room_id='${room}'`,
        ),
        "1024",
      );
      assert.equal(
        db.sql(
          `SELECT plan_generation=9 AND metrics_closed FROM playback_viewer_plans WHERE ${scope}`,
        ),
        "t",
      );
      assert.equal(
        db.sql(`SELECT plan_generation=1 AND metrics_lifecycle_epoch=0 AND metrics_seq=9007199254740991
        AND NOT metrics_closed FROM playback_viewer_plans WHERE ${initialScope}`),
        "t",
      );
    },
  );
  check("post-restart constraint remains effective", () =>
    reject(
      "post-restart partial grant",
      `UPDATE playback_sessions SET playback_metrics_version=NULL WHERE id='${boundSession}'`,
      "playback_session_metrics_pair",
    ),
  );
  reject(
    "post-restart schema36 NULL epoch",
    `UPDATE playback_viewer_plans SET metrics_lifecycle_epoch=NULL WHERE ${initialScope}`,
    "playback_viewer_metrics_slot",
  );
  reject(
    "post-restart schema36 negative epoch",
    `UPDATE playback_viewer_plans SET metrics_lifecycle_epoch=-1 WHERE ${initialScope}`,
    "playback_viewer_metrics_slot",
  );
  check(
    "clearing an optional slot never lowers or deletes the durable high-water",
    () => {
      db.sql(
        `UPDATE playback_viewer_plans SET ${metricsColumns.map((column) => `${column}=${column === "metrics_seq" ? "0" : column === "metrics_closed" ? "false" : "NULL"}`).join(",")} WHERE ${scope}`,
      );
      assert.equal(
        snapshot("playback_viewer_plans", metricsColumns),
        before.viewers,
      );
      assert.equal(
        db.sql(
          `SELECT ${empty} AND plan_generation=9 FROM playback_viewer_plans WHERE ${scope}`,
        ),
        "t",
      );
    },
  );
  for (const migration of report.migrations)
    assert.equal(
      hash(await readFile(resolve(checkout, "migrations", migration.name))),
      migration.sha256,
      `input changed during run: ${migration.name}`,
    );
  assert.equal(
    hash(await readFile(fileURLToPath(import.meta.url))),
    report.inputs.test_sha256,
    "test input changed during run",
  );
  assert.equal(
    hash(await readFile(resolve(checkout, "tests/fixtures/postgres.mjs"))),
    report.inputs.postgres_fixture_sha256,
    "fixture input changed during run",
  );
  report.checks.push(
    "all 36 migration input checksums remain unchanged across both upgrades and restart",
  );
  report.after = {
    historical_migration_sha256: report.migrations.slice(0, 35),
    viewer_count: 1024,
    high_water_row_sha256: snapshot("playback_viewer_plans", metricsColumns),
  };
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  try {
    if (restarted) {
      if (restarted.exitCode === null) restarted.kill("SIGINT");
      await restartDone;
      await new Promise((done) => restartLog.end(done));
      assert.equal(
        verifyPidAbsent(restarted.pid),
        true,
        "restarted owned PostgreSQL PID is absent",
      );
      assert.equal(
        await verifyClosedPort(report.postgres.port),
        true,
        "restarted owned PostgreSQL listener is closed",
      );
      Object.assign(report.restart, { pid_absent: true, port_closed: true });
    }
    if (!fixtureStopped) await db.stop();
    report.cleanup = await db.verifyStopped();
    report.postgres = db.diagnostics();
  } catch (error) {
    report.result = "failed";
    report.cleanup_failure = String(error.stack ?? error);
    process.exitCode = 1;
  }
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `${report.result}: ${report.checks.length} PostgreSQL upgrade/persistence checks and ${report.rejections.length} actual constraint rejections; ${resolve(root, "report.json")}`,
  );
}
