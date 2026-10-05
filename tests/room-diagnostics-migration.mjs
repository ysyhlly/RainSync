// Owned 1-37 -> 38 upgrade. Never connects to an existing database.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedPostgres } from "./fixtures/postgres.mjs";
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN);
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
const id = randomUUID(),
  root = resolve(
    process.env.RAINSYNC_ARTIFACT_DIR,
    "room-diagnostics-migration",
    id,
  );
await mkdir(root, { recursive: true });
const db = isolatedPostgres({ root, name: "room-diagnostics-migration", id });
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;
const report = {
  schema_version: 1,
  result: "running",
  checks: [],
  migrations: [],
  scope:
    "Owned native PostgreSQL 1-37 to38 with explicit historical fixtures; not production migration evidence",
};
try {
  await db.start();
  for (const name of (await readdir("migrations"))
    .filter((n) => /^\d+_.+\.sql$/.test(n) && Number(n.split("_")[0]) <= 37)
    .sort()) {
    const bytes = await readFile(resolve("migrations", name));
    db.sql(`BEGIN; ${bytes}; COMMIT;`);
    report.migrations.push({
      name,
      sha384: createHash("sha384").update(bytes).digest("hex"),
    });
  }
  assert.equal(report.migrations.length, 37);
  const user = randomUUID(),
    room = randomUUID();
  const state = {
    room_id: room,
    revision: 1,
    media_id: null,
    media_generation: 0,
    playback_status: "paused",
    anchor_position_ms: 0,
    anchor_server_time_ms: 0,
    playback_rate: 1,
    controller_user_id: user,
    duration_ms: null,
    clock_epoch: randomUUID(),
  };
  db.sql(
    `INSERT INTO users(id,username,password_hash) VALUES(${quote(user)},'owned-legacy','not-a-login'); INSERT INTO rooms(id,name,owner_id) VALUES(${quote(room)},'owned legacy room',${quote(user)}); INSERT INTO room_snapshots(room_id,state) VALUES(${quote(room)},${quote(JSON.stringify(state))}::jsonb); INSERT INTO room_events(room_id,revision,state) VALUES(${quote(room)},1,${quote(JSON.stringify(state))}::jsonb);`,
  );
  const before = db.sql(
    "SELECT jsonb_agg(to_jsonb(e) ORDER BY revision)::text FROM room_events e",
  );
  const migration = await readFile("migrations/0038_room_diagnostics.sql");
  db.sql(`BEGIN; ${migration}; COMMIT;`);
  assert.equal(
    db.sql(
      "SELECT jsonb_agg(to_jsonb(e)-'diagnostic' ORDER BY revision)::text FROM room_events e",
    ),
    before,
  );
  assert.equal(
    db.sql("SELECT count(*) FROM room_events WHERE diagnostic IS NOT NULL"),
    "0",
  );
  report.checks.push(
    "all prior event values preserved and diagnostic facts remain absent rather than invented",
  );
  for (const expression of [
    "'null'::jsonb",
    "'[]'::jsonb",
    "jsonb_build_object('v',repeat('x',8192))",
  ]) {
    assert.throws(() =>
      db.sql(`UPDATE room_events SET diagnostic=${expression}`),
    );
    assert.equal(
      db.sql("SELECT count(*) FROM room_events WHERE diagnostic IS NOT NULL"),
      "0",
    );
  }
  report.checks.push(
    "explicit JSON null, non-object and oversized envelope writes are rejected atomically",
  );
  db.sql("UPDATE room_events SET diagnostic='{}'::jsonb");
  assert.equal(db.sql("SELECT diagnostic::text FROM room_events"), "{}");
  report.checks.push(
    "bounded unknown objects remain representable for exporter to mark malformed, not backfilled as valid",
  );
  report.migrations.push({
    name: "0038_room_diagnostics.sql",
    sha384: createHash("sha384").update(migration).digest("hex"),
  });
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await db.stop();
  report.cleanup = await db.verifyStopped();
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`${report.result}: ${resolve(root, "report.json")}`);
}
