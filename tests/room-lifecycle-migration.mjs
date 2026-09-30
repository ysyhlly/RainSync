import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isolatedServer } from "./fixtures/server.mjs";

const owner = randomUUID(), room = randomUUID(), session = randomUUID(), key = randomUUID();
const legacy = {
  room_id: room, revision: 6, media_id: null, media_generation: 3,
  playback_status: "paused", anchor_position_ms: 2500, anchor_server_time_ms: 0,
  playback_rate: 1.5, controller_user_id: owner, duration_ms: null, clock_epoch: randomUUID(),
};
await isolatedServer("room-lifecycle-migration", async (f) => {
  assert.equal(f.sql("SELECT count(*) FROM _sqlx_migrations WHERE version=28 AND success"), "1");
  assert.equal(f.sql(`SELECT owner_id FROM rooms WHERE id='${room}'`), owner);
  assert.equal(f.sql(`SELECT count(*) FROM room_members WHERE room_id='${room}' AND user_id='${owner}'`), "1");
  assert.equal(f.sql(`SELECT revoked FROM invites WHERE room_id='${room}'`), "f");
  assert.equal(f.sql(`SELECT count(*) FROM room_ownership_events`), "0");
  assert.equal(f.sql(`SELECT lifecycle || ':' || lifecycle_epoch FROM rooms WHERE id='${room}'`), "active:0");
  assert.equal(f.sql(`SELECT lifecycle_epoch FROM playback_sessions WHERE id='${session}'`), "0");
  assert.equal(f.sql(`SELECT room_id || ':' || lifecycle_epoch FROM playback_requests WHERE idempotency_key='${key}'`), `${room}:0`);
  assert.equal(f.sql(`SELECT count(*) FROM room_lifecycle_events`), "0");
  assert.equal(f.sql(`SELECT count(*) FROM room_cleanup_tasks`), "0");
  const check = () => {
    const state = JSON.parse(f.sql(`SELECT state FROM room_snapshots WHERE room_id='${room}'`));
    for (const field of ["room_id", "controller_user_id", "media_generation", "media_id", "anchor_position_ms", "playback_rate"]) assert.equal(state[field], legacy[field]);
  };
  check();
  await f.startServer();
  check();
  console.log("PASS: actual migrations 1–27 plus legacy room/member/invite/playback grant/request upgraded to 28/29 with active epoch zero and no permissions widened; restart preserved data");
}, {
  beforeStart: async (f) => {
    f.sql("CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY,description TEXT NOT NULL,installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),success BOOLEAN NOT NULL,checksum BYTEA NOT NULL,execution_time BIGINT NOT NULL)");
    for (const name of (await readdir("migrations")).filter(name => name.endsWith(".sql") && Number(name.split("_")[0]) <= 27).sort()) {
      const bytes = await readFile("migrations/" + name);
      const version = Number(name.split("_")[0]);
      const description = name.replace(/^\d+_/, "").replace(/\.sql$/, "").replaceAll("_", " ");
      const checksum = createHash("sha384").update(bytes).digest("hex");
      f.sql(`BEGIN; ${bytes}; INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(${version},'${description}',true,decode('${checksum}','hex'),0); COMMIT;`);
    }
    f.sql(`INSERT INTO users(id,username,password_hash) VALUES('${owner}','legacy-owner','fixture-not-for-login'); INSERT INTO rooms(id,name,owner_id) VALUES('${room}','legacy room','${owner}'); INSERT INTO room_members VALUES('${room}','${owner}'); INSERT INTO room_snapshots VALUES('${room}','${JSON.stringify(legacy)}'::jsonb); INSERT INTO invites VALUES('legacy-invitation','${room}',now()+interval '1 day',false); INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${session}','${owner}','${room}',3,'legacy-playback-grant','{}',now()+interval '1 hour'); INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,response_encrypted,lease_until,expires_at) VALUES('${owner}','${key}','legacy','${session}','${randomUUID()}','completed','fixture',now()+interval '1 minute',now()+interval '1 day')`);
  },
});
