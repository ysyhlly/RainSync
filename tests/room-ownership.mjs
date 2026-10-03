import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";

await isolatedServer("room-ownership", async (f) => {
  const admin = f.client();
  const adminIdentity = await admin.login();
  const users = [];
  for (const name of ["owner", "successor", "member", "outsider"]) {
    await admin.request("/users", "POST", { username: name, password: f.password });
    const client = f.client();
    const identity = await client.login(name, f.password);
    users.push({ client, identity });
  }
  const [owner, successor, member, outsider] = users;
  const room = await owner.client.request("/rooms", "POST", { name: "ownership fixture" });
  const invite = await owner.client.request(`/rooms/${room.id}/invites`, "POST");
  for (const user of [successor, member]) {
    await user.client.request(`/rooms/${room.id}/join`, "POST", { token: invite.token });
  }
  const media = sourceMedia(f, { kind: "local", root: f.root, resource: "fixture" }), playback = randomUUID();
  f.sql(`UPDATE media_items SET duration_ms=30000 WHERE id='${media}'`);
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
  const snapshot = () => JSON.parse(f.sql(`SELECT state FROM room_snapshots WHERE room_id='${room.id}'`));
  const transfer = (client, owner_id, expected_revision, status = 200) => client.request(`/rooms/${room.id}/owner`, "POST", { owner_id, expected_revision }, status);
  const command = (state, epoch, type = "PAUSE", payload) => ({ protocol_version: 1, room_id: room.id, command_id: randomUUID(), control_epoch: epoch, expected_revision: state.revision, media_generation: state.media_generation, type, payload });
  try {
    const a = await connect(owner.client), b = await connect(owner.client), c = await connect(successor.client);
    const start = command(a.snapshot.state, a.snapshot.control_epoch.id, "CHANGE_MEDIA", { media_id: media });
    a.send(start);
    let state = (await a.next("ACK", value => value.command_id === start.command_id)).state;
    withPlaybackAdmission(f, { client: member.client, user: member.identity.id, room: room.id, session: playback }, `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES('${playback}','${member.identity.id}','${room.id}','${media}',${state.media_generation},'ownership-fixture','{}',now()+interval '1 hour')`);
    assert.equal((await owner.client.request(`/rooms/${room.id}/members`)).length, 3);
    assert.equal((await outsider.client.request(`/rooms/${room.id}/members`, "GET", undefined, 403)).error.code, "NOT_A_MEMBER");
    assert.equal((await transfer(member.client, successor.identity.id, state.revision, 403)).error.code, "FORBIDDEN");
    assert.equal((await transfer(outsider.client, successor.identity.id, state.revision, 403)).error.code, "NOT_A_MEMBER");
    assert.equal((await transfer(owner.client, outsider.identity.id, state.revision, 403)).error.code, "NOT_A_MEMBER");
    assert.equal((await transfer(owner.client, successor.identity.id, state.revision - 1, 409)).error.code, "REVISION_CONFLICT");
    await transfer(owner.client, owner.identity.id, state.revision, 400);
    const before = state;
    const moved = await transfer(owner.client, successor.identity.id, state.revision);
    state = moved.state;
    assert.deepEqual(state, { ...before, revision: before.revision + 1, controller_user_id: successor.identity.id }, "transfer must not change current media, clock, generation, position or playback status");
    const changes = await Promise.all([a, b, c].map(socket => socket.next("EVENT", value => value.event_id === moved.event_id)));
    for (const event of changes) {
      assert.equal(event.owner_id, successor.identity.id);
      assert.ok(event.control_epoch.id);
    }
    for (const socket of [a, b, c]) assert.equal(f.sql(`SELECT count(*) FROM control_epochs WHERE id='${socket.snapshot.control_epoch.id}'`), "0");
    assert.equal(f.sql(`SELECT owner_id FROM rooms WHERE id='${room.id}'`), successor.identity.id);
    assert.equal(f.sql(`SELECT actor_id || ':' || previous_owner_id || ':' || owner_id FROM room_ownership_events WHERE id='${moved.event_id}'`), `${owner.identity.id}:${owner.identity.id}:${successor.identity.id}`);
    assert.equal(f.sql(`SELECT stopped FROM playback_sessions WHERE id='${playback}'`), "f");
    assert.equal(f.sql(`SELECT revoked FROM invites WHERE token_hash IS NOT NULL AND room_id='${room.id}'`), "f");
    a.send(start);
    assert.equal((await a.next("ERROR", value => value.command_id === start.command_id)).error.code, "CONTROL_EPOCH_EXPIRED", "successful old commands cannot replay across ownership changes");
    for (const [index, socket] of [a, b].entries()) {
      const stale = command(state, changes[index].control_epoch.id);
      socket.send(stale);
      assert.equal((await socket.next("ERROR", value => value.command_id === stale.command_id)).error.code, "CONTROLLER_REQUIRED");
    }
    await owner.client.request(`/rooms/${room.id}/invites`, "POST", undefined, 403);
    await successor.client.request(`/rooms/${room.id}/invites`, "POST");
    const fresh = command(state, changes[2].control_epoch.id);
    c.send(fresh);
    state = (await c.next("ACK", value => value.command_id === fresh.command_id)).state;
    const reconnected = await connect(owner.client);
    assert.equal(reconnected.snapshot.owner_id, successor.identity.id);
    assert.equal(reconnected.snapshot.state.controller_user_id, successor.identity.id);

    // The transfer waits first for the snapshot lock; a previously reduced
    // playback command queues behind it and must fail at its final commit.
    const lockTag = `ownership-lock-${randomUUID()}`;
    const lock = f.sqlProcess(`BEGIN; SELECT room_id FROM room_snapshots WHERE room_id='${room.id}' FOR UPDATE; SELECT pg_sleep(2) /* ${lockTag} */; COMMIT;`);
    await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${lockTag}%'`, "1");
    const moving = transfer(successor.client, owner.identity.id, state.revision);
    await f.waitForSql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT state FROM room_snapshots%FOR UPDATE%'", "1");
    const oldCommand = command(state, changes[2].control_epoch.id, "PLAY");
    c.send(oldCommand);
    await lock.done;
    const back = await moving;
    const denied = await c.next("ERROR", value => value.command_id === oldCommand.command_id);
    assert.equal(denied.error.code, "CONTROL_EPOCH_EXPIRED");
    assert.equal(denied.state.controller_user_id, owner.identity.id);
    assert.equal(snapshot().revision, back.state.revision);
    state = back.state;

    // Membership disappears while the transfer is waiting for its key-share lock.
    const memberTag = `ownership-member-${randomUUID()}`;
    const removing = f.sqlProcess(`BEGIN; SELECT user_id FROM room_members WHERE room_id='${room.id}' AND user_id='${member.identity.id}' FOR UPDATE; SELECT pg_sleep(2) /* ${memberTag} */; DELETE FROM room_members WHERE room_id='${room.id}' AND user_id='${member.identity.id}'; COMMIT;`);
    await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${memberTag}%'`, "1");
    const invalidTarget = transfer(owner.client, member.identity.id, state.revision, 403);
    await removing.done;
    assert.equal((await invalidTarget).error.code, "NOT_A_MEMBER");
    assert.deepEqual(snapshot(), state);
    await member.client.request(`/rooms/${room.id}/join`, "POST", { token: invite.token });

    // An instance administrator can intervene without joining the room. Exactly
    // one same-revision transfer wins; the other is an explicit conflict.
    const racing = await Promise.all([successor, member].map(user => admin.raw(`/rooms/${room.id}/owner`, { method: "POST", body: { owner_id: user.identity.id, expected_revision: state.revision } })));
    assert.deepEqual(racing.map(response => response.status).sort(), [200, 409]);
    const final = snapshot();
    assert.equal(final.revision, state.revision + 1);
    assert.equal(f.sql(`SELECT count(*) FROM room_ownership_events WHERE room_id='${room.id}'`), "3");
    assert.equal(f.sql(`SELECT actor_id FROM room_ownership_events WHERE room_id='${room.id}' ORDER BY revision DESC LIMIT 1`), adminIdentity.id);
    for (const socket of sockets) socket.terminate();
    await f.startServer();
    const afterRestart = await connect(owner.client);
    assert.equal(afterRestart.snapshot.owner_id, final.controller_user_id);
    assert.equal(afterRestart.snapshot.state.controller_user_id, final.controller_user_id);
    assert.equal(f.sql(`SELECT count(*) FROM room_ownership_events WHERE room_id='${room.id}'`), "3");
    console.log("PASS: ownership permissions, target membership race, revision race, durable audit/restart, multi-device revocation, stale actor commit and playback preservation");
  } finally {
    for (const socket of sockets) socket.terminate();
  }
});
