// SQL-only tombstone/authority regression on a new disposable native cluster.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedPostgres } from "./fixtures/postgres.mjs";
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Set owned artifact directory");
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, `private-lifecycle-sql-${randomUUID()}`);
await mkdir(root, { recursive: true });
const db = isolatedPostgres({ root, name: "private-lifecycle-sql" });
try {
  await db.start();
  for (const file of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort())
    db.sql(await readFile(`migrations/${file}`, "utf8"));
  const owner = randomUUID(), library = randomUUID(), source = randomUUID(), media = randomUUID();
  db.sql(`INSERT INTO users(id,username,password_hash) VALUES('${owner}','library-migration-owner','synthetic'); INSERT INTO private_libraries(id,name,owner_id,visibility) VALUES('${library}','Fixture','${owner}','private'); INSERT INTO sources(id,name,kind,config_encrypted,library_id) VALUES('${source}','Fixture HTTP','http','synthetic-encrypted-config','${library}'); INSERT INTO media_items(id,source_id,title,resource) VALUES('${media}','${source}','Fixture','https://fixture.invalid/file.mp4')`);
  assert.equal(db.sql(`SELECT library_allowed('${owner}','${library}','manage')`), "t");
  assert.equal(db.sql(`SELECT library_media_allowed('${owner}','${media}','play',NULL)`), "t");
  db.sql(`BEGIN; UPDATE sources SET deleted_at=clock_timestamp(),config_encrypted='synthetic-empty-config' WHERE id='${source}'; UPDATE media_items SET available=false WHERE id='${media}'; UPDATE private_libraries SET deleted_at=clock_timestamp(),revision=revision+1,permission_epoch=permission_epoch+1 WHERE id='${library}'; INSERT INTO library_permission_audit(library_id,actor_id,action,permission_epoch) SELECT id,'${owner}','library_deleted',permission_epoch FROM private_libraries WHERE id='${library}'; COMMIT`);
  assert.equal(db.sql(`SELECT library_allowed('${owner}','${library}','manage')`), "f");
  assert.equal(db.sql(`SELECT library_media_allowed('${owner}','${media}','play',NULL)`), "f");
  assert.equal(db.sql(`SELECT source_id::text FROM media_items WHERE id='${media}'`), source);
  assert.equal(db.sql(`SELECT library_id::text FROM sources WHERE id='${source}'`), library);
  assert.equal(db.sql(`SELECT count(*) FROM library_permission_audit WHERE library_id='${library}'`), "1");
  assert.throws(() => db.sql(`UPDATE media_items SET available=true WHERE id='${media}'`), /source_deleted/);
  assert.throws(() => db.sql(`UPDATE sources SET library_id='00000000-0000-0000-0000-000000000001' WHERE id='${source}'`), /source_deleted/);
  assert.throws(() => db.sql(`UPDATE private_libraries SET deleted_at=NULL WHERE id='${library}'`), /library_deleted/);
  assert.throws(() => db.sql(`INSERT INTO sources(id,name,kind,config_encrypted,library_id) VALUES('${randomUUID()}','Blocked','http','synthetic','${library}')`), /library_deleted/);
  assert.throws(() => db.sql("UPDATE private_libraries SET deleted_at=clock_timestamp() WHERE id='00000000-0000-0000-0000-000000000001'"), /shared_library_not_deleted/);
  console.log("PASS all migrations plus private library/source authority tombstones, protected shared library, retained scope/audit and no-resurrection guards");
} finally { await db.stop(); }
