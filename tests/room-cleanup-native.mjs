// Production lifecycle/cleanup handlers with a fresh owned PostgreSQL fixture.
// Synthetic owner records model receipts; no real remote state is altered.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";

const quote = value => `'${String(value).replaceAll("'", "''")}'`;
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
  throw Error(`deadline: ${label}`);
}

await isolatedServer("room-cleanup-native", async f => {
  const client = f.client(), user = await client.login();
  const view = id => client.request(`/rooms/${id}/lifecycle`);
  const close = async id => client.request(`/rooms/${id}/close`, "POST", {
    expected_revision: (await view(id)).state.revision,
  });
  const retry = async (id, expectedRevision) => client.request(`/rooms/${id}/cleanup/retry`, "POST", {
    expected_revision: expectedRevision ?? (await view(id)).state.revision,
  });
  const makeNative = async name => {
    const room = await client.request("/rooms", "POST", { name }), session = randomUUID(), media = randomUUID();
    f.sql(`INSERT INTO media_items(id,title,resource) VALUES('${media}','平台影片','platform:${media}');
      INSERT INTO room_platform_media(media_id,room_id,provider,content_id,part,cid,title,created_by) VALUES('${media}','${room.id}','bilibili','BV1GJ411x7h7',1,12345,'owned native fixture','${user.id}')`);
    const nativeContext = {version:1,provider:"bilibili",media_id:media,room_id:room.id,user_id:user.id,entry_revision:"1",credential_mode:"anonymous",account_id:null,account_revision:null};
    withPlaybackAdmission(f, {client, user:user.id, room:room.id, session}, `
      INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at)
      VALUES('${session}','${user.id}','${room.id}','${media}',0,'${session}',${quote(JSON.stringify({encrypted:"owned-native-fixture",native_platform_context:nativeContext}))},clock_timestamp()+interval '1 hour');
    `);
    return {room,session};
  };

  const settled = await makeNative("native DASH session has no legacy upstream owner");
  // The old legacy-upstream predicate sees this legitimate native session;
  // its actual owner is excluded from the legacy upstream reconciler by design.
  assert.equal(f.sql(`SELECT count(*) FROM playback_sessions p WHERE p.id='${settled.session}'
    AND NOT(p.resource @> '{"upstream_closed":true}'::jsonb)
    AND NOT EXISTS(SELECT 1 FROM upstream_reservations u WHERE u.id=p.id)
    AND NOT EXISTS(SELECT 1 FROM playback_observations o WHERE o.session_id=p.id)`), "1");
  await close(settled.room.id);
  await until(async () => (await view(settled.room.id)).lifecycle === "closed", "native DASH close after actual owner obligations drain");
  assert.equal(f.sql(`SELECT count(*) FROM room_lifecycle_events WHERE room_id='${settled.room.id}' AND lifecycle='closed'`), "1");
  assert.equal(f.sql(`SELECT resource ? 'upstream_closed' FROM playback_sessions WHERE id='${settled.session}'`), "f", "completion must not fabricate an irrelevant receipt");
  console.log("PASS: native DASH no longer waits permanently for a legacy owner that never handles it");

  const pending = await makeNative("native close retains real preparation and delivery barriers");
  const owner = randomUUID(), execution = randomUUID();
  f.sql(`INSERT INTO playback_preparations(session_id,user_id,room_id,lifecycle_epoch,owner_epoch) VALUES('${pending.session}','${user.id}','${pending.room.id}',0,'${owner}');
    INSERT INTO media_executions(id,session_id,kind,owner_id) VALUES('${execution}','${pending.session}','delivery','${owner}');`);
  await close(pending.room.id);
  await until(async () => (await view(pending.room.id)).cleanup?.last_error === "playback_preparation_drain_unconfirmed", "preparation barrier is observed");
  let status = await view(pending.room.id);
  assert.equal(status.lifecycle, "closing");
  assert.ok(status.cleanup.blockers.includes("playback_preparation_drain_unconfirmed"));
  assert.ok(status.cleanup.blockers.includes("media_execution_drain_unconfirmed"));
  assert.ok(!status.cleanup.blockers.includes("legacy_upstream_cleanup_unconfirmed"));
  assert.equal(status.cleanup.retryable, true);
  assert.equal(typeof status.cleanup.elapsed_ms, "number");
  assert.equal(typeof status.cleanup.next_attempt_at_ms, "number");
  assert.ok(["waiting", "running"].includes(status.cleanup.phase));
  const revision = status.state.revision, activeOwner = randomUUID();
  // Model an active cleanup owner. An explicit retry may not steal its claim.
  f.sql(`UPDATE room_cleanup_tasks SET lease_owner='${activeOwner}',lease_until=clock_timestamp()+interval '1 hour',next_attempt_at=clock_timestamp()+interval '1 hour' WHERE room_id='${pending.room.id}'`);
  assert.equal((await retry(pending.room.id, revision)).cleanup.scheduled, false);
  assert.equal(f.sql(`SELECT lease_owner::text FROM room_cleanup_tasks WHERE room_id='${pending.room.id}'`), activeOwner);
  assert.equal((await view(pending.room.id)).cleanup.lease_active, true);
  await client.request(`/rooms/${pending.room.id}/cleanup/retry`, "POST", {expected_revision:revision-1}, 409);
  // Expiring that synthetic lease is scheduling evidence, never disposal proof.
  f.sql(`UPDATE room_cleanup_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE room_id='${pending.room.id}'`);
  assert.equal((await retry(pending.room.id, revision)).cleanup.scheduled, true);
  await retry(pending.room.id, revision);
  assert.equal(f.sql(`SELECT count(*) FROM room_cleanup_tasks WHERE room_id='${pending.room.id}'`), "1");
  assert.equal((await view(pending.room.id)).lifecycle, "closing");
  f.sql(`UPDATE playback_preparations SET drained_at=clock_timestamp() WHERE session_id='${pending.session}'`);
  await retry(pending.room.id, revision);
  await until(async () => (await view(pending.room.id)).cleanup?.blockers.join(",") === "media_execution_drain_unconfirmed", "late preparation receipt leaves delivery unresolved");
  assert.equal((await view(pending.room.id)).lifecycle, "closing");
  f.sql(`UPDATE media_executions SET reaped_at=clock_timestamp() WHERE id='${execution}'`);
  await retry(pending.room.id, revision);
  await until(async () => (await view(pending.room.id)).lifecycle === "closed", "late execution receipt permits one close");
  assert.equal(f.sql(`SELECT count(*) FROM room_lifecycle_events WHERE room_id='${pending.room.id}' AND lifecycle='closed'`), "1");
  await client.request(`/rooms/${pending.room.id}/cleanup/retry`, "POST", {expected_revision:(await view(pending.room.id)).state.revision}, 409);
  console.log("PASS: cleanup progress lists real blockers; retry is revision-fenced, lease-preserving and idempotent; late owner receipts close exactly once");

  const unknown = await client.request("/rooms", "POST", {name:"unknown legacy session still requires actual release evidence"}), session = randomUUID();
  withPlaybackAdmission(f, {client, user:user.id, room:unknown.id, session}, `INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${session}','${user.id}','${unknown.id}',0,'${session}','{}',clock_timestamp()-interval '1 second')`);
  await close(unknown.id);
  await until(async () => (await view(unknown.id)).cleanup?.blockers.includes("legacy_upstream_cleanup_unconfirmed"), "unknown legacy release remains blocked");
  await retry(unknown.id);
  await delay(1200);
  assert.equal((await view(unknown.id)).lifecycle, "closing");
  assert.equal(f.sql(`SELECT count(*) FROM room_lifecycle_events WHERE room_id='${unknown.id}' AND lifecycle='closed'`), "0");
  console.log("PASS: expiry and retry never turn unknown legacy ownership into a false disposal receipt");
});
