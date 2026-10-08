import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedPostgres } from "./fixtures/postgres.mjs";

assert.ok(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "Set an owned fixture artifact directory",
);
const root = resolve(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "plugin-configuration-migration",
  randomUUID(),
);
await mkdir(root, { recursive: true });
const db = isolatedPostgres({ root, name: "plugin-configuration-migration" });
try {
  await db.start();
  const actor = randomUUID(),
    audit = randomUUID(),
    id = "metadata.title-label";
  db.sql(
    `CREATE TABLE users(id uuid PRIMARY KEY); INSERT INTO users VALUES('${actor}'); ${await readFile("migrations/0073_declarative_plugins.sql", "utf8")}`,
  );
  db.sql(
    `INSERT INTO rainsync_plugins(id,version,enabled,config,granted_permissions,revision,artifact_digest,previous_state,updated_by) VALUES('${id}','1.0.0',true,'{"label":"existing text"}','["metadata:read"]',7,repeat('a',64),'{"config":{"label":"older text"}}','${actor}'); INSERT INTO rainsync_plugin_audit(id,plugin_id,actor_id,revision,action,artifact_digest) VALUES('${audit}','${id}','${actor}',7,'configure',repeat('a',64));`,
  );
  const before = db.sql("SELECT row_to_json(p) FROM rainsync_plugins p");
  db.sql(
    await readFile("migrations/0084_declarative_plugin_removal.sql", "utf8"),
  );
  assert.deepEqual(
    JSON.parse(db.sql("SELECT row_to_json(p) FROM rainsync_plugins p")),
    { ...JSON.parse(before), removed: false },
  );
  assert.equal(db.sql("SELECT count(*) FROM rainsync_plugin_audit"), "1");
  assert.throws(
    () => db.sql(`UPDATE rainsync_plugins SET removed=true WHERE id='${id}'`),
    /rainsync_plugin_state_valid/,
  );
  db.sql(
    `BEGIN; UPDATE rainsync_plugins SET removed=true,enabled=false,config='{}',granted_permissions='[]',previous_state=NULL,revision=8 WHERE id='${id}'; INSERT INTO rainsync_plugin_audit(id,plugin_id,actor_id,revision,action,artifact_digest) VALUES('${randomUUID()}','${id}','${actor}',8,'remove',repeat('a',64)); COMMIT;`,
  );
  assert.equal(
    db.sql(
      `SELECT revision||'/'||config::text||'/'||granted_permissions::text FROM rainsync_plugins WHERE id='${id}'`,
    ),
    "8/{}/[]",
  );
  assert.equal(db.sql("SELECT count(*) FROM rainsync_plugin_audit"), "2");
  for (const patch of [
    "enabled=true",
    'config=\'{"label":"restored"}\'',
    "granted_permissions='[\"metadata:read\"]'",
    "previous_state='{}'",
  ]) {
    assert.throws(
      () => db.sql(`UPDATE rainsync_plugins SET ${patch} WHERE id='${id}'`),
      /rainsync_plugin_state_valid/,
    );
  }
  db.sql(
    `UPDATE rainsync_plugins SET removed=false,config='{"label":"new text"}',granted_permissions='["metadata:read"]',revision=9 WHERE id='${id}'`,
  );
  assert.equal(
    db.sql(
      `SELECT revision||'/'||enabled FROM rainsync_plugins WHERE id='${id}'`,
    ),
    "9/false",
  );
  assert.equal(db.sql("SELECT count(*) FROM rainsync_plugin_audit"), "2");
  console.log(
    "Plugin 0073→0084 migration preserves existing records and audit; erased tombstones and reinstall constraints passed",
  );
} finally {
  await db.stop();
  await db.verifyStopped();
}
