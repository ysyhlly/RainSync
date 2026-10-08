import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedPostgres } from "./fixtures/postgres.mjs";
assert.ok(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "Owned fixture artifact directory required",
);
const root = resolve(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "scoped-guests-migration",
  randomUUID(),
);
await mkdir(root, { recursive: true });
const db = isolatedPostgres({ root, name: "scoped-guests" });
const owner = randomUUID(),
  room = randomUUID(),
  other = randomUUID(),
  source = randomUUID(),
  media = randomUUID(),
  hidden = randomUUID();
const checks = [];
const sql = (q) => db.sql(q);
const truth = (q, expected = "t") => assert.equal(sql(q), expected, q);
const refused = (q) =>
  assert.throws(() => sql(q), /guest_restricted|guest_credentials_absent/);
const state = (id) =>
  JSON.stringify({
    room_id: id,
    revision: 0,
    media_id: media,
    media_generation: 1,
    playback_status: "paused",
    anchor_position_ms: 0,
    anchor_server_time_ms: 0,
    playback_rate: 1,
    controller_user_id: owner,
    duration_ms: 30000,
    live: null,
    clock_epoch: randomUUID(),
  });
function guest(id = randomUUID(), selected = room) {
  const hash = createHash("sha256").update(id).digest("hex");
  sql(
    `BEGIN; INSERT INTO users(id,username,password_hash,principal_kind) VALUES('${id}','guest_${id}','!','guest'); WITH t AS MATERIALIZED (SELECT clock_timestamp() AS at) INSERT INTO guest_principals(user_id,room_id,login_hash,display_name,created_at,expires_at) SELECT '${id}','${selected}','${hash}','Test guest',at,at+interval '2 hours' FROM t; INSERT INTO room_members(room_id,user_id) VALUES('${selected}','${id}'); INSERT INTO sessions(token_hash,user_id,csrf,expires_at) SELECT login_hash,user_id,'fixture-csrf',expires_at FROM guest_principals WHERE user_id='${id}'; COMMIT`,
  );
  return { id, hash };
}
try {
  await db.start();
  for (const name of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    sql(await readFile(`migrations/${name}`, "utf8"));
  }
  checks.push("all migrations through0088 applied to fresh owned PostgreSQL");
  sql(
    `INSERT INTO users(id,username,password_hash,admin) VALUES('${owner}','fixture-owner','fixture-no-login',true); INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','fixture source','local','not-used'); INSERT INTO media_items(id,source_id,title,resource,available) VALUES('${media}','${source}','Current','current',true),('${hidden}','${source}','Hidden','hidden',true); INSERT INTO rooms(id,name,owner_id) VALUES('${room}','Guest room','${owner}'),('${other}','Other room','${owner}'); INSERT INTO room_members(room_id,user_id) VALUES('${room}','${owner}'),('${other}','${owner}'); INSERT INTO room_snapshots(room_id,state) VALUES('${room}','${state(room)}'),('${other}','${state(other)}'); INSERT INTO room_guest_access(room_id,enabled,updated_by) VALUES('${room}',false,'${owner}'),('${other}',true,'${owner}');`,
  );
  truth(
    "SELECT NOT COALESCE(guests_enabled,false) FROM admin_settings WHERE singleton",
  );
  refused(
    `BEGIN; INSERT INTO users(id,username,password_hash,principal_kind) VALUES('${randomUUID()}','bad-guest','hash','guest'); COMMIT`,
  );
  assert.throws(
    () => guest(randomUUID(), other),
    /guest_restricted/,
    "global default is independently closed",
  );
  sql("UPDATE admin_settings SET guests_enabled=true WHERE singleton");
  const disabled = randomUUID();
  refused(
    `BEGIN; INSERT INTO users(id,username,password_hash,principal_kind) VALUES('${disabled}','guest_${disabled}','!','guest'); INSERT INTO guest_principals(user_id,room_id,login_hash,display_name,expires_at) VALUES('${disabled}','${room}','${"d".repeat(64)}','Guest',clock_timestamp()+interval '1 hour'); INSERT INTO room_members(room_id,user_id) VALUES('${room}','${disabled}'); COMMIT`,
  );
  sql(`UPDATE room_guest_access SET enabled=true WHERE room_id='${room}'`);
  const g = guest();
  truth(
    `SELECT guest_active('${g.id}') AND guest_room_allowed('${g.id}','${room}') AND playback_login_allowed('${g.id}','${g.hash}')`,
  );
  truth(
    `SELECT extract(epoch FROM(expires_at-created_at))=7200 FROM guest_principals WHERE user_id='${g.id}'`,
  );
  truth(`SELECT guest_room_allowed('${g.id}','${other}')`, "f");
  truth(
    `SELECT library_allowed('${g.id}','00000000-0000-0000-0000-000000000001','browse')`,
    "f",
  );
  truth(`SELECT library_media_allowed('${g.id}','${media}','play','${room}')`);
  truth(
    `SELECT library_media_allowed('${g.id}','${hidden}','play','${room}')`,
    "f",
  );
  truth(
    `SELECT library_media_allowed('${g.id}','${media}','browse','${room}')`,
    "f",
  );
  for (const q of [
    `UPDATE users SET principal_kind='account' WHERE id='${g.id}'`,
    `UPDATE users SET admin=true WHERE id='${g.id}'`,
    `UPDATE users SET password_hash='new-password' WHERE id='${g.id}'`,
    `DELETE FROM guest_principals WHERE user_id='${g.id}'`,
    `INSERT INTO room_members(room_id,user_id) VALUES('${other}','${g.id}')`,
    `UPDATE room_members SET chat_moderator=true WHERE user_id='${g.id}'`,
    `UPDATE rooms SET owner_id='${g.id}' WHERE id='${room}'`,
    `UPDATE room_snapshots SET state=jsonb_set(state,'{controller_user_id}','"${g.id}"') WHERE room_id='${room}'`,
    `INSERT INTO control_epochs(id,user_id,room_id) VALUES(gen_random_uuid(),'${g.id}','${room}')`,
    `INSERT INTO room_member_permissions(room_id,user_id,role,permissions,granted_by) VALUES('${room}','${g.id}','moderator','{play}','${owner}')`,
    `INSERT INTO user_profiles(user_id,display_name) VALUES('${g.id}','Persistent profile')`,
    `INSERT INTO private_libraries(id,name,owner_id,visibility) VALUES(gen_random_uuid(),'Guest library','${g.id}','private')`,
    `INSERT INTO library_grants(library_id,user_id,browse,expires_at,created_by) VALUES('00000000-0000-0000-0000-000000000001','${g.id}',true,clock_timestamp()+interval '1 hour','${owner}')`,
    `INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES('${"e".repeat(64)}','${g.id}','new',clock_timestamp()+interval '1 hour')`,
    `UPDATE guest_principals SET expires_at=expires_at+interval '1 second' WHERE user_id='${g.id}'`,
  ])
    refused(q);
  const library = randomUUID(),
    privateSource = randomUUID(),
    privateMedia = randomUUID(),
    grant = randomUUID();
  sql(
    `INSERT INTO private_libraries(id,name,owner_id,visibility) VALUES('${library}','Private','${owner}','private'); INSERT INTO sources(id,name,kind,config_encrypted,library_id) VALUES('${privateSource}','Private source','local','unused','${library}'); INSERT INTO media_items(id,source_id,title,resource,available) VALUES('${privateMedia}','${privateSource}','Private current','private',true); UPDATE room_snapshots SET state=jsonb_set(state,'{media_id}','"${privateMedia}"') WHERE room_id='${room}'`,
  );
  truth(
    `SELECT library_media_allowed('${g.id}','${privateMedia}','play','${room}')`,
    "f",
  );
  sql(
    `INSERT INTO room_media_grants(id,library_id,media_id,source_generation,room_id,grantor_id,mode,permission_epoch,expires_at) SELECT '${grant}','${library}','${privateMedia}',m.library_source_generation,'${room}','${owner}','room_members',l.permission_epoch,clock_timestamp()+interval '1 hour' FROM media_items m,private_libraries l WHERE m.id='${privateMedia}' AND l.id='${library}'`,
  );
  truth(
    `SELECT library_media_allowed('${g.id}','${privateMedia}','play','${room}')`,
  );
  truth(
    `SELECT library_media_allowed('${g.id}','${privateMedia}','browse','${room}')`,
    "f",
  );
  sql(
    `UPDATE room_media_grants SET mode='library_members' WHERE id='${grant}'`,
  );
  truth(
    `SELECT library_media_allowed('${g.id}','${privateMedia}','play','${room}')`,
    "f",
  );
  sql(
    `UPDATE room_snapshots SET state=jsonb_set(state,'{media_id}','"${media}"') WHERE room_id='${room}'`,
  );
  checks.push(
    "private media requires explicit room-members grant even for current item; library-members and browse stay denied",
  );
  checks.push(
    "immutable credentialless identity; no cross-room, owner, controller, delegation, library grant, profile or replacement session",
  );
  // Test the same exact signed-media authority used by Worker without cookies.
  const resource = JSON.stringify({
    source_policy_revision: 0,
    auth_context: {
      version: 1,
      user_id: g.id,
      room_id: room,
      login_hash: g.hash,
      membership_epoch: sql(
        `SELECT membership_epoch FROM room_members WHERE room_id='${room}' AND user_id='${g.id}'`,
      ),
    },
  });
  truth(`SELECT playback_source_allowed('${media}','${resource}')`);
  truth(`SELECT playback_source_allowed('${hidden}','${resource}')`, "f");
  sql("UPDATE admin_settings SET guests_enabled=false WHERE singleton");
  truth(
    `SELECT guest_active('${g.id}') OR playback_login_allowed('${g.id}','${g.hash}') OR playback_source_allowed('${media}','${resource}')`,
    "f",
  );
  sql("UPDATE admin_settings SET guests_enabled=true WHERE singleton");
  truth(
    `SELECT guest_active('${g.id}') OR playback_source_allowed('${media}','${resource}')`,
    "f",
  );
  truth(`SELECT count(*)=0 FROM sessions WHERE user_id='${g.id}'`);
  checks.push(
    "signed media global disable revokes exact login and cannot resurrect after re-enable",
  );
  const h = guest();
  sql(
    `UPDATE room_guest_access SET enabled=false WHERE room_id='${room}'; UPDATE room_guest_access SET enabled=true WHERE room_id='${room}'`,
  );
  truth(`SELECT guest_active('${h.id}')`, "f");
  const j = guest();
  sql(`DELETE FROM room_members WHERE room_id='${room}' AND user_id='${j.id}'`);
  truth(`SELECT playback_login_allowed('${j.id}','${j.hash}')`, "f");
  const k = guest();
  sql(`DELETE FROM sessions WHERE token_hash='${k.hash}'`);
  truth(`SELECT guest_active('${k.id}')`, "f");
  const e = guest();
  sql(
    `UPDATE guest_principals SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id='${e.id}'`,
  );
  truth(
    `SELECT guest_active('${e.id}') OR playback_login_allowed('${e.id}','${e.hash}')`,
    "f",
  );
  const c = guest();
  sql(`UPDATE rooms SET lifecycle='closing' WHERE id='${room}'`);
  truth(`SELECT guest_active('${c.id}')`, "f");
  checks.push(
    "room disable, kick, logout, natural expiry and room closure fence access",
  );
  const d = guest(undefined, other);
  sql(`DELETE FROM rooms WHERE id='${other}'`);
  truth(
    `SELECT guest_is_account('${d.id}') OR guest_active('${d.id}') OR playback_login_allowed('${d.id}','${d.hash}')`,
    "f",
  );
  sql("DELETE FROM admin_settings WHERE singleton");
  truth(`SELECT guest_active('${g.id}')`, "f");
  checks.push(
    "room deletion and missing global singleton fail closed; guest tombstone survives",
  );
  console.log(checks.map((c) => `PASS: ${c}`).join("\n"));
} finally {
  await db.stop();
  const cleanup = await db.verifyStopped();
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify({ checks, cleanup }, null, 2),
  );
  console.log(`Owned PostgreSQL cleanup verified: ${root}`);
}
