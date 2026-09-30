import assert from "node:assert/strict";
import { readFile,readdir } from "node:fs/promises";
import { createHash,randomUUID } from "node:crypto";
import { isolatedServer } from "./fixtures/server.mjs";

const jobs=Array.from({length:6},()=>randomUUID()), owner=randomUUID(), legacyRoom=randomUUID();
const legacyAgent=randomUUID(), legacyTransfers=Array.from({length:3},()=>randomUUID());
await isolatedServer("room-cleanup-migration",async f=>{
  assert.equal(f.sql("SELECT count(*) FROM _sqlx_migrations WHERE version=29 AND success"),"1");
  assert.equal(f.sql("SELECT count(*) FROM _sqlx_migrations WHERE version=30 AND success"),"1");
  assert.equal(f.sql("SELECT count(*) FROM media_executions"),"5");
  assert.equal(f.sql("SELECT count(*) FROM media_executions WHERE owner_id IS NULL"),"0");
  for(const [index,job] of jobs.entries()) {
    const row=f.sql(`SELECT reaped_at IS NOT NULL FROM media_executions WHERE job_id='${job}'`);
    assert.equal(row,index===1?"t":index===5?"":"f");
  }
  assert.equal(f.sql("SELECT count(*) FROM agent_transfer_runs WHERE legacy_unconfirmed AND session_id IS NULL"),"3");
  assert.equal(f.sql("SELECT count(*) FROM agent_transfer_runs WHERE legacy_unconfirmed AND agent_drained_at IS NOT NULL"),"0");
  const lateLegacy=randomUUID(), modern=randomUUID();
  // Simulate an old Worker still inserting after a mixed/failed upgrade. The
  // safe default must gate this record too, while a new instrumented owner
  // explicitly marks its fully tracked record as non-legacy.
  f.sql(`INSERT INTO agent_transfer_runs(id,agent_id,resource_hash,head,status,finished_at) VALUES('${lateLegacy}','${legacyAgent}','late-old-worker',false,'cancelled',now()-interval '2 days'); INSERT INTO agent_transfer_runs(id,agent_id,resource_hash,head,status,finished_at,agent_drained_at,legacy_unconfirmed) VALUES('${modern}','${legacyAgent}','modern-owner',false,'completed',now()-interval '2 days',now(),false)`);
  assert.equal(f.sql(`SELECT legacy_unconfirmed FROM agent_transfer_runs WHERE id='${lateLegacy}'`),"t");
  assert.equal(f.sql(`SELECT legacy_unconfirmed FROM agent_transfer_runs WHERE id='${modern}'`),"f");
  const admin=f.client(); await admin.login();
  const empty={id:legacyRoom};
  const state=await admin.request(`/rooms/${empty.id}/lifecycle`);
  await admin.request(`/rooms/${empty.id}/close`,"POST",{expected_revision:state.state.revision});
  await f.waitForSql(`SELECT last_error FROM room_cleanup_tasks WHERE room_id='${empty.id}'`,"legacy_agent_drain_unconfirmed");
  assert.equal((await admin.request(`/rooms/${empty.id}/lifecycle`)).lifecycle,"closing");
  // Execute the exact production sweep statements against old terminal and
  // expired active records; age/status cannot create a receipt or erase gate.
  const main=await readFile("apps/server/src/main.rs","utf8");
  const sweep=[...main.matchAll(/"((?:UPDATE agent_transfer_runs SET status='failed'|DELETE FROM agent_transfer_runs)[^"\n]*)"/g)].map(match=>match[1]);
  assert.equal(sweep.length,2);
  for(const query of sweep) f.sql(query);
  assert.equal(f.sql("SELECT count(*) FROM agent_transfer_runs WHERE legacy_unconfirmed"),"4");
  assert.equal(f.sql("SELECT count(*) FROM agent_transfer_runs WHERE legacy_unconfirmed AND agent_drained_at IS NOT NULL"),"0");
  assert.equal(f.sql(`SELECT count(*) FROM agent_transfer_runs WHERE id='${modern}'`),"0");
  assert.equal(f.sql(`SELECT status FROM agent_transfer_runs WHERE id='${legacyTransfers[0]}'`),"failed");
  // A pre-upgrade Server can still execute its old, unaware history delete.
  // The database guard must retain evidence even when that SQL omits the flag.
  f.sql("DELETE FROM agent_transfer_runs WHERE finished_at<now()-interval '24 hours'");
  assert.equal(f.sql("SELECT count(*) FROM agent_transfer_runs WHERE legacy_unconfirmed"),"4");
  // Even an ordinary later receipt cannot supply the missing room association
  // or silently clear the separate legacy reconciliation requirement.
  f.sql(`UPDATE agent_transfer_runs SET agent_drained_at=now() WHERE id='${legacyTransfers[1]}'`);
  for(const query of sweep) f.sql(query);
  assert.equal(f.sql("SELECT count(*) FROM agent_transfer_runs WHERE legacy_unconfirmed"),"4");
  await f.startServer();
  assert.equal(f.sql("SELECT count(*) FROM media_executions WHERE reaped_at IS NOT NULL"),"1");
  assert.equal((await admin.request(`/rooms/${empty.id}/lifecycle`)).lifecycle,"closing");
  assert.equal(f.sql("SELECT count(*) FROM agent_transfer_runs WHERE legacy_unconfirmed"),"4");
  const second=await admin.request("/rooms","POST",{name:"later room is outside historical legacy scope"});
  const secondState=await admin.request(`/rooms/${second.id}/lifecycle`);
  await admin.request(`/rooms/${second.id}/close`,"POST",{expected_revision:secondState.state.revision});
  await f.waitForSql(`SELECT lifecycle FROM rooms WHERE id='${second.id}'`,"closed");
  const receiptRoom=await admin.request("/rooms","POST",{name:"positive receipt retention"});
  const receiptSession=randomUUID(), heldSession=randomUUID(), oldReceipt=randomUUID(), unknownReceipt=randomUUID(), newReceipt=randomUUID(), heldReceipt=randomUUID();
  f.sql(`INSERT INTO playback_sessions(id,room_id,generation,delivery_token_hash,resource,expires_at,stopped) VALUES('${receiptSession}','${receiptRoom.id}',0,'${receiptSession}','{"upstream_closed":true}',now(),true),('${heldSession}','${empty.id}',0,'${heldSession}','{"upstream_closed":true}',now(),true); INSERT INTO media_executions(id,session_id,kind,owner_id,created_at,reaped_at) VALUES('${oldReceipt}','${receiptSession}','delivery','${owner}',now()-interval '3 days',now()-interval '3 days'),('${unknownReceipt}','${receiptSession}','delivery','${owner}',now()-interval '3 days',NULL),('${newReceipt}','${receiptSession}','delivery','${owner}',now(),now()),('${heldReceipt}','${heldSession}','delivery','${owner}',now()-interval '3 days',now()-interval '3 days')`);
  const oldPrep=randomUUID(), unknownPrep=randomUUID(), newPrep=randomUUID(), heldPrep=randomUUID();
  f.sql(`INSERT INTO playback_preparations(session_id,room_id,lifecycle_epoch,owner_epoch,created_at,drained_at) VALUES('${oldPrep}','${receiptRoom.id}',0,'${owner}',now()-interval '3 days',now()-interval '3 days'),('${unknownPrep}','${receiptRoom.id}',0,'${owner}',now()-interval '3 days',NULL),('${newPrep}','${receiptRoom.id}',0,'${owner}',now(),now()),('${heldPrep}','${empty.id}',0,'${owner}',now()-interval '3 days',now()-interval '3 days')`);
  const retention=await readFile("crates/persistence/src/room_cleanup.rs","utf8");
  const prune=[...retention.matchAll(/"(DELETE FROM (?:media_executions|playback_preparations)[^"\n]*)"/g)].map(match=>match[1]);
  assert.equal(prune.length,2);
  for(const query of prune) f.sql(query);
  assert.equal(f.sql(`SELECT count(*) FROM media_executions WHERE id='${oldReceipt}'`),"0");
  assert.equal(f.sql(`SELECT count(*) FROM media_executions WHERE id IN('${unknownReceipt}','${newReceipt}','${heldReceipt}')`),"3");
  assert.equal(f.sql(`SELECT count(*) FROM playback_preparations WHERE session_id='${oldPrep}'`),"0");
  assert.equal(f.sql(`SELECT count(*) FROM playback_preparations WHERE session_id IN('${unknownPrep}','${newPrep}','${heldPrep}')`),"3");
  console.log("PASS: only positive receipts older48h are pruned; unknown/recent receipts and evidence for pending room cleanup remain");
  console.log("PASS: legacy offered/completed/cancelled NAS rows and post-migration old-Worker INSERTs block all causally eligible rooms; current sweep cannot ACK/delete them and database guard rejects old sweep deletion; later rooms can close across restart; current tracked rows retain normal history cleanup");
  console.log("PASS: actual migrations1–28→29/30 accept legacy NULL owners; only validated terminal success has reaping evidence; failed/cancelled/missing-output attempts stay unknown; never-claimed queue needs no receipt; restart stable");
},{beforeStart:async f=>{
  f.sql("CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY,description TEXT NOT NULL,installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),success BOOLEAN NOT NULL,checksum BYTEA NOT NULL,execution_time BIGINT NOT NULL)");
  for(const name of (await readdir("migrations")).filter(name=>name.endsWith(".sql")&&Number(name.split("_")[0])<=28).sort()) {
    const bytes=await readFile(`migrations/${name}`), version=Number(name.split("_")[0]);
    const description=name.replace(/^\d+_/,"").replace(/\.sql$/,"").replaceAll("_"," ");
    f.sql(`BEGIN; ${bytes}; INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(${version},'${description}',true,decode('${createHash("sha384").update(bytes).digest("hex")}','hex'),0); COMMIT`);
  }
  const legacyState={room_id:legacyRoom,revision:0,media_id:null,media_generation:0,playback_status:"paused",anchor_position_ms:0,anchor_server_time_ms:0,playback_rate:1,controller_user_id:owner,duration_ms:null,clock_epoch:randomUUID()};
  f.sql(`INSERT INTO users(id,username,password_hash,admin) VALUES('${owner}','admin','${f.legacyPasswordHash(f.password)}',true); INSERT INTO rooms(id,name,owner_id) VALUES('${legacyRoom}','pre-migration room','${owner}'); INSERT INTO room_members VALUES('${legacyRoom}','${owner}'); INSERT INTO room_snapshots VALUES('${legacyRoom}','${JSON.stringify(legacyState)}'); INSERT INTO agents(id,name) VALUES('${legacyAgent}','legacy unassociated NAS')`);
  for(const [index,id] of legacyTransfers.entries()) {
    const status=["offered","cancelled","completed"][index];
    f.sql(`INSERT INTO agent_transfer_runs(id,agent_id,resource_hash,head,status,finished_at,lease_until) VALUES('${id}','${legacyAgent}','legacy-${status}',false,'${status}',${index===0?"NULL":"now()-interval '2 days'"},now()-interval '2 days')`);
  }
  for(const [index,job] of jobs.entries()) {
    const status=["succeeded","succeeded","failed","cancelled","running","queued"][index];
    const attempt=index===0||index===5?0:index===4?2:1;
    f.sql(`INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES('${job}',0,'${job}','{}',now()+interval '1 day'); INSERT INTO media_jobs(id,session_id,status,spec,attempt,owner_id) VALUES('${job}','${job}','${status}','{}',${attempt},${index===0||index===5?"NULL":`'${owner}'`})`);
    if(index<4) {
      const state=["legacy","published","failed","abandoned"][index];
      f.sql(`INSERT INTO media_outputs(job_id,attempt,owner_id,status,relative_dir,validation_version,manifest_sha256,segment_count,published_at) VALUES('${job}',${attempt},${index===0?"NULL":`'${owner}'`},'${state}','${job}',${index===0?0:2},${index===1?`'${"a".repeat(64)}'`:"NULL"},${index===1?1:"NULL"},${index===1?"now()":"NULL"})`);
    }
  }
}});
