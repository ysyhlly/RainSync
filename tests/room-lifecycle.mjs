import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";

await isolatedServer("room-lifecycle", async f => {
  const admin = f.client();
  await admin.login();
  const users = [];
  for (const name of ["owner", "viewer", "outsider"]) {
    await admin.request("/users", "POST", { username: name, password: f.password });
    const client = f.client(), identity = await client.login(name, f.password);
    users.push({ client, identity });
  }
  const [owner, viewer, outsider] = users;
  const room = await owner.client.request("/rooms", "POST", { name: "lifecycle fixture" });
  const invite = await owner.client.request(`/rooms/${room.id}/invites`, "POST");
  await viewer.client.request(`/rooms/${room.id}/join`, "POST", { token: invite.token });
  const media = sourceMedia(f, { kind: "local", root: f.root, resource: "fixture" }), playback = randomUUID(), execution = randomUUID(), key = randomUUID();
  f.sql(`UPDATE media_items SET duration_ms=1 WHERE id='${media}'`);
  const sockets = new Set();
  async function connect(client) {
    const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", { headers: { Origin: f.origin, Cookie: client.cookie } });
    sockets.add(ws);
    const frames = [];
    ws.on("message", bytes => frames.push(JSON.parse(bytes)));
    ws.on("error", () => {});
    await new Promise((done, reject) => { ws.once("open", done); ws.once("error", reject); });
    const send = value => ws.send(JSON.stringify(value));
    const next = async (type, predicate = () => true) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const index = frames.findIndex(value => value.type === type && predicate(value));
        if (index >= 0) return frames.splice(index, 1)[0];
        await delay(10);
      }
      throw new Error(`Missing ${type}: ${JSON.stringify(frames)}`);
    };
    send({ type: "JOIN", room_id: room.id });
    return { ws, send, next, snapshot: await next("SNAPSHOT") };
  }
  const status = () => owner.client.request(`/rooms/${room.id}/lifecycle`);
  const mutation = (client, action, revision, expected = 200) => client.request(`/rooms/${room.id}/${action}`, "POST", { expected_revision: revision }, expected);
  const transfer = (client, owner_id, revision, expected = 200) => client.request(`/rooms/${room.id}/owner`, "POST", { owner_id, expected_revision: revision }, expected);
  const command = (state, epoch, type = "PLAY", payload) => ({ protocol_version: 1, room_id: room.id, command_id: randomUUID(), control_epoch: epoch, expected_revision: state.revision, media_generation: state.media_generation, type, payload });
  try {
    const a = await connect(owner.client), b = await connect(owner.client);
    assert.equal(a.snapshot.lifecycle, "active");
    assert.equal(a.snapshot.lifecycle_epoch, 0);
    let change = command(a.snapshot.state, a.snapshot.control_epoch.id, "CHANGE_MEDIA", { media_id: media });
    a.send(change);
    let state = (await a.next("ACK", value => value.command_id === change.command_id)).state;
    const end = command(state, a.snapshot.control_epoch.id, "END_MEDIA", { position_ms: 1 });
    a.send(end);
    state = (await a.next("ACK", value => value.command_id === end.command_id)).state;
    assert.equal((await status()).lifecycle, "active", "natural media completion cannot close a room");
    a.send({ type: "CHAT", body: "retained history", client_message_id: randomUUID() });
    await a.next("CHAT");
    assert.equal((await mutation(viewer.client, "close", state.revision, 403)).error.code, "FORBIDDEN");
    assert.equal((await mutation(outsider.client, "close", state.revision, 403)).error.code, "NOT_A_MEMBER");
    assert.equal((await mutation(owner.client, "close", state.revision - 1, 409)).error.code, "REVISION_CONFLICT");
    // Reverse ordering: PLAY commits before management takes the room lock.
    // Its newer revision must turn the stale close into a visible conflict.
    const winningTag = `lifecycle-play-first-${randomUUID()}`;
    // FOR SHARE lets the new replay membership gate finish, then blocks the
    // final FOR UPDATE commit. Observe that exact boundary before racing close.
    const winningLock = f.sqlProcess(`BEGIN; SELECT room_id FROM room_snapshots WHERE room_id='${room.id}' FOR SHARE; SELECT pg_sleep(2) /* ${winningTag} */; COMMIT;`);
    await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${winningTag}%'`, "1");
    const winningPlay = command(state, a.snapshot.control_epoch.id);
    a.send(winningPlay);
    await f.waitForSql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT state FROM room_snapshots%FOR UPDATE%'", "1");
    const staleClose = mutation(owner.client, "close", state.revision, 409);
    await winningLock.done;
    state = (await a.next("ACK", value => value.command_id === winningPlay.command_id)).state;
    assert.equal((await staleClose).error.code, "REVISION_CONFLICT");
    assert.equal((await status()).lifecycle, "active");
    withPlaybackAdmission(f, { client: viewer.client, user: viewer.identity.id, room: room.id, session: playback, key }, `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES('${playback}','${viewer.identity.id}','${room.id}','${media}',${state.media_generation},'lifecycle-grant','{"upstream_closed":true}',now()+interval '1 hour'); INSERT INTO media_executions(id,session_id,kind,owner_id) VALUES('${execution}','${playback}','delivery','${randomUUID()}')`);
    // The close owns the room lock and is waiting for the snapshot. An already
    // connected controller queues behind it and must not PLAY after revocation.
    const lockTag = `lifecycle-lock-${randomUUID()}`;
    const lock = f.sqlProcess(`BEGIN; SELECT room_id FROM room_snapshots WHERE room_id='${room.id}' FOR UPDATE; SELECT pg_sleep(2) /* ${lockTag} */; COMMIT;`);
    await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${lockTag}%'`, "1");
    const closing = mutation(owner.client, "close", state.revision);
    await f.waitForSql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT state FROM room_snapshots%FOR UPDATE%'", "1");
    // A transfer admitted before close commits must observe the lifecycle
    // after waiting for the same room lock, even with the new revision.
    const queuedTransfer = transfer(owner.client, viewer.identity.id, state.revision + 1, 409);
    await f.waitForSql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT owner_id FROM rooms%FOR NO KEY UPDATE%'", "1");
    const play = command(state, a.snapshot.control_epoch.id);
    a.send(play);
    await lock.done;
    const closedRequest = await closing;
    assert.equal(closedRequest.lifecycle, "closing");
    assert.equal(closedRequest.lifecycle_epoch, 1);
    assert.equal(closedRequest.state.playback_status, "paused");
    assert.equal((await queuedTransfer).error.code, "ROOM_NOT_ACTIVE");
    assert.equal((await a.next("ERROR", value => value.command_id === play.command_id)).error.code, "ROOM_NOT_ACTIVE");
    for (const socket of [a, b]) {
      const changed = await socket.next("EVENT", value => value.event_id === closedRequest.event_id);
      assert.equal(changed.lifecycle, "closing");
      assert.equal(changed.control_epoch, null);
      assert.equal(f.sql(`SELECT count(*) FROM control_epochs WHERE id='${socket.snapshot.control_epoch.id}'`), "0");
    }
    assert.equal(f.sql(`SELECT stopped FROM playback_sessions WHERE id='${playback}'`), "t");
    assert.equal(f.sql(`SELECT status || ':' || error_code FROM playback_requests WHERE idempotency_key='${key}'`), "failed:room_not_active");
    assert.equal(f.sql(`SELECT revoked FROM invites WHERE room_id='${room.id}'`), "t");
    assert.equal((await owner.client.request(`/rooms/${room.id}/invites`, "POST", undefined, 409)).error.code, "ROOM_NOT_ACTIVE");
    assert.equal((await outsider.client.request(`/rooms/${room.id}/join`, "POST", { token: invite.token }, 409)).error.code, "ROOM_NOT_ACTIVE");
    assert.equal((await owner.client.request(`/rooms/${room.id}/playlist`, "POST", { media_id: media }, 409)).error.code, "ROOM_NOT_ACTIVE");
    assert.equal((await owner.client.request(`/rooms/${room.id}/owner`, "POST", { owner_id: viewer.identity.id, expected_revision: closedRequest.state.revision }, 409)).error.code, "ROOM_NOT_ACTIVE");
    assert.equal((await transfer(admin, viewer.identity.id, closedRequest.state.revision, 409)).error.code, "ROOM_NOT_ACTIVE");
    const afterRejectedTransfers = await status();
    assert.equal(afterRejectedTransfers.owner_id, owner.identity.id);
    assert.deepEqual(afterRejectedTransfers.state, closedRequest.state, "closing transfer rejection cannot change the snapshot");
    assert.equal(f.sql(`SELECT count(*) FROM room_ownership_events WHERE room_id='${room.id}'`), "0");
    a.send({ type: "CHAT", body: "forbidden while closing" });
    assert.equal((await a.next("ERROR", value => !value.command_id)).error.code, "ROOM_NOT_ACTIVE");
    assert.equal((await viewer.client.request(`/rooms/${room.id}/messages`))[0].body, "retained history");
    assert.equal((await viewer.client.request(`/rooms/${room.id}/playlist`)).length, 1);
    await outsider.client.request(`/rooms/${room.id}/messages`, "GET", undefined, 403);
    const readonly = await connect(viewer.client);
    assert.equal(readonly.snapshot.lifecycle, "closing");
    assert.equal(readonly.snapshot.control_epoch, null);
    await f.waitForSql(`SELECT count(*) FROM room_cleanup_tasks WHERE room_id='${room.id}' AND attempts>0 AND last_error='media_execution_drain_unconfirmed'`, "1");
    assert.equal((await status()).lifecycle, "closing", "an unconfirmed resource cannot be assumed closed");
    for (const socket of sockets) socket.terminate();
    await f.startServer();
    const afterRestart = await connect(owner.client);
    assert.equal(afterRestart.snapshot.lifecycle, "closing");
    assert.equal(afterRestart.snapshot.control_epoch, null);
    // Model the actual owner acknowledgement after its resource has drained.
    f.sql(`UPDATE media_executions SET reaped_at=now() WHERE id='${execution}'; UPDATE room_cleanup_tasks SET next_attempt_at=now() WHERE room_id='${room.id}'`);
    await f.waitForSql(`SELECT lifecycle FROM rooms WHERE id='${room.id}'`, "closed", 15000);
    const settled = await status();
    assert.equal(settled.cleanup.completed, true);
    // Closing is transitional: once cleanup settles, ownership can move
    // without reopening the room or issuing fresh control credentials.
    const closedTransfer = await transfer(owner.client, viewer.identity.id, settled.state.revision);
    assert.deepEqual(closedTransfer.state, { ...settled.state, revision: settled.state.revision + 1, controller_user_id: viewer.identity.id });
    const afterClosedTransfer = await status();
    assert.equal(afterClosedTransfer.owner_id, viewer.identity.id);
    assert.equal(afterClosedTransfer.lifecycle, "closed");
    assert.equal(afterClosedTransfer.lifecycle_epoch, settled.lifecycle_epoch);
    assert.equal(f.sql(`SELECT count(*) FROM control_epochs WHERE room_id='${room.id}'`), "0");
    const restoredOwner = await transfer(viewer.client, owner.identity.id, closedTransfer.state.revision);
    const reopened = await mutation(owner.client, "reopen", restoredOwner.state.revision);
    assert.equal(reopened.lifecycle, "active");
    assert.equal(reopened.lifecycle_epoch, 2);
    assert.equal(reopened.state.playback_status, "paused");
    assert.equal((await outsider.client.request(`/rooms/${room.id}/join`, "POST", { token: invite.token }, 403)).error.code, "INVALID_INVITE");
    const fresh = await connect(owner.client);
    assert.ok(fresh.snapshot.control_epoch.id);
    const oldCommand = command(fresh.snapshot.state, a.snapshot.control_epoch.id);
    fresh.send(oldCommand);
    assert.equal((await fresh.next("ERROR", value => value.command_id === oldCommand.command_id)).error.code, "CONTROL_EPOCH_EXPIRED");
    assert.equal(f.sql(`SELECT stopped || ':' || lifecycle_epoch FROM playback_sessions WHERE id='${playback}'`), "true:0");
    await viewer.client.request(`/playback-sessions/${playback}`, "GET", undefined, 410);
    await viewer.client.request(`/playback-sessions/${playback}`, "POST", undefined, 410);
    const nextInvite = await owner.client.request(`/rooms/${room.id}/invites`, "POST");
    await outsider.client.request(`/rooms/${room.id}/join`, "POST", { token: nextInvite.token });
    await mutation(admin, "close", fresh.snapshot.state.revision);
    await f.waitForSql(`SELECT lifecycle FROM rooms WHERE id='${room.id}'`, "closed", 15000);
    const beforeArchive = await status();
    const archived = await mutation(owner.client, "archive", beforeArchive.state.revision);
    assert.equal(archived.lifecycle, "archived");
    assert.equal((await mutation(owner.client, "reopen", archived.state.revision, 409)).error.code, "ROOM_LIFECYCLE_CONFLICT");
    const archiveSocket = await connect(viewer.client);
    assert.equal(archiveSocket.snapshot.lifecycle, "archived");
    assert.equal(archiveSocket.snapshot.control_epoch, null);
    assert.equal((await viewer.client.request(`/rooms/${room.id}/messages`)).length, 1);
    assert.equal((await viewer.client.request(`/rooms/${room.id}/playlist`)).length, 1);
    assert.equal(f.sql(`SELECT count(*) FROM room_lifecycle_events WHERE room_id='${room.id}'`), "6");
    const archivedTransfer = await transfer(admin, viewer.identity.id, archived.state.revision);
    assert.deepEqual(archivedTransfer.state, { ...archived.state, revision: archived.state.revision + 1, controller_user_id: viewer.identity.id });
    const afterArchivedTransfer = await status();
    assert.equal(afterArchivedTransfer.owner_id, viewer.identity.id);
    assert.equal(afterArchivedTransfer.lifecycle, "archived");
    assert.equal(afterArchivedTransfer.lifecycle_epoch, archived.lifecycle_epoch);
    assert.equal(f.sql(`SELECT count(*) FROM control_epochs WHERE room_id='${room.id}'`), "0");
    assert.equal(f.sql(`SELECT count(*) FROM room_ownership_events WHERE room_id='${room.id}'`), "3");
    console.log("PASS: close/PLAY/ownership races, closing owner/admin transfer rejection without side effects, closed/archived transfer preservation, owner/admin/revision checks, natural END_MEDIA remains active, revoked multi-device controls/invites/grants, closing restart and owner receipt, paused new-epoch reopen, archived authorized readonly history");
  } finally {
    for (const socket of sockets) socket.terminate();
  }
});
