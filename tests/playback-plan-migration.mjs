// Real isolated PostgreSQL upgrade and constraint checks, not a production DB.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedPostgres } from "./fixtures/postgres.mjs";

assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Set RAINSYNC_ARTIFACT_DIR");
const id = randomUUID();
const root = resolve(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "playback-plan-migration",
  id,
);
await mkdir(root, { recursive: true });
const db = isolatedPostgres({ root, name: "plan-migration", id });
const owner = randomUUID(),
  room = randomUUID(),
  session = randomUUID(),
  key = randomUUID();
const viewer = randomUUID();
const evidence = {
  schema_version: 1,
  checks: [],
  migrations: [],
  completed: false,
};
const check = (name, fn) => {
  fn();
  evidence.checks.push(name);
};
try {
  await db.start();
  evidence.postgres = db.diagnostics();
  const files = (await readdir("migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files.filter((name) => Number(name.split("_")[0]) <= 30)) {
    const bytes = await readFile("migrations/" + name);
    db.sql(`BEGIN; ${bytes}; COMMIT;`);
    evidence.migrations.push({
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  db.sql(`INSERT INTO users(id,username,password_hash) VALUES('${owner}','legacy-plan-owner','not-for-login');
    INSERT INTO rooms(id,name,owner_id) VALUES('${room}','legacy plan room','${owner}');
    INSERT INTO room_members VALUES('${room}','${owner}');
    INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at)
      VALUES('${session}','${owner}','${room}',3,'legacy-plan-token','{}',now()+interval '1 hour');
    INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,response_encrypted,lease_until,expires_at,room_id,lifecycle_epoch)
      VALUES('${owner}','${key}','legacy-hash','${session}','${randomUUID()}','completed','legacy-encrypted',now()+interval '1 minute',now()+interval '1 day','${room}',0);`);
  const migration = await readFile(
    "migrations/0031_playback_plan_generations.sql",
  );
  db.sql(`BEGIN; ${migration}; COMMIT;`);
  evidence.migrations.push({
    name: "0031_playback_plan_generations.sql",
    sha256: createHash("sha256").update(migration).digest("hex"),
  });
  check("legacy sessions are unchanged and generation remains unknown", () =>
    assert.equal(
      db.sql(
        `SELECT viewer_id IS NULL AND plan_generation IS NULL AND NOT stopped AND generation=3 AND lifecycle_epoch=0 FROM playback_sessions WHERE id='${session}'`,
      ),
      "t",
    ),
  );
  check("legacy replay payload/hash remain untouched", () =>
    assert.equal(
      db.sql(
        `SELECT viewer_id IS NULL AND plan_generation IS NULL AND request_hash='legacy-hash' AND response_encrypted='legacy-encrypted' AND status='completed' FROM playback_requests WHERE idempotency_key='${key}'`,
      ),
      "t",
    ),
  );
  check("migration does not invent viewer high-water marks", () =>
    assert.equal(db.sql("SELECT count(*) FROM playback_viewer_plans"), "0"),
  );
  for (const table of ["playback_sessions", "playback_requests"]) {
    const where =
      table === "playback_sessions"
        ? `id='${session}'`
        : `idempotency_key='${key}'`;
    for (const fields of [
      `viewer_id='${viewer}'`,
      "plan_generation=1",
      `viewer_id='${viewer}',plan_generation=0`,
      `viewer_id='${viewer}',plan_generation=-1`,
      `viewer_id='${viewer}',plan_generation=4294967296`,
    ]) {
      check(
        `${table} rejects invalid pair ${fields.includes("4294967296") ? "overflow" : fields.includes("-1") ? "negative" : fields.includes("=0") ? "zero" : "unpaired"}`,
        () =>
          assert.throws(() =>
            db.sql(`UPDATE ${table} SET ${fields} WHERE ${where}`),
          ),
      );
    }
    check(`${table} accepts and stores full u32 range`, () => {
      db.sql(
        `UPDATE ${table} SET viewer_id='${viewer}',plan_generation=4294967295 WHERE ${where}`,
      );
      assert.equal(
        db.sql(`SELECT plan_generation FROM ${table} WHERE ${where}`),
        "4294967295",
      );
    });
  }
  check("high-water requires an existing user and room", () =>
    assert.throws(() =>
      db.sql(
        `INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation) VALUES('${randomUUID()}','${room}','${viewer}',1)`,
      ),
    ),
  );
  check("high-water is scoped independently per viewer", () => {
    db.sql(
      `INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation) VALUES('${owner}','${room}','${viewer}',9),('${owner}','${room}','${randomUUID()}',1)`,
    );
    assert.equal(
      db.sql(
        "SELECT string_agg(plan_generation::text,',' ORDER BY plan_generation) FROM playback_viewer_plans",
      ),
      "1,9",
    );
  });
  check("duplicate scope cannot create a second high-water", () =>
    assert.throws(() =>
      db.sql(
        `INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation) VALUES('${owner}','${room}','${viewer}',10)`,
      ),
    ),
  );
  check("logical cancellation does not lower or remove high-water", () => {
    db.sql(
      `UPDATE playback_sessions SET stopped=true WHERE id='${session}'; UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=410,error_code='playback_request_cancelled' WHERE idempotency_key='${key}'`,
    );
    assert.equal(
      db.sql(
        `SELECT plan_generation FROM playback_viewer_plans WHERE viewer_id='${viewer}'`,
      ),
      "9",
    );
  });
  evidence.completed = true;
} catch (error) {
  evidence.failure = String(error);
  throw error;
} finally {
  await db.stop();
  evidence.cleanup = await db.verifyStopped();
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(`Playback plan migration evidence: ${root}/report.json`);
}
console.log(
  `PASS: ${evidence.checks.length} actual PostgreSQL 1–30→31 checks; legacy rows preserved and owned resources closed`,
);
