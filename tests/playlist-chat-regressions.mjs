// Real owned PostgreSQL/Server/WS regressions; no media decoding or live accounts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";

let fixture;
const checks = [];
await isolatedServer("playlist-chat-regressions", async (f) => {
  fixture = f;
  const client = f.client();
  const identity = await client.login();
  const room = await client.request("/rooms", "POST", { name: "queue regression" });
  const prefix = `/rooms/${room.id}`;
  const media = Array.from({ length: 3 }, () => sourceMedia(f, {
    kind: "local", root: f.root, resource: `owned-${randomUUID()}`,
  }));
  f.sql(`UPDATE media_items SET duration_ms=1000 WHERE id IN (${media.map(id => `'${id}'`).join(",")})`);
  const socket = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
    headers: { Origin: f.origin, Cookie: client.cookie },
  });
  const frames = [];
  socket.on("error", () => {});
  socket.on("message", data => {
    assert.ok(frames.length < 200, "bounded socket fixture");
    frames.push(JSON.parse(data));
  });
  async function next(type, predicate = () => true) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const at = frames.findIndex(frame => frame.type === type && predicate(frame));
      if (at >= 0) return frames.splice(at, 1)[0];
      await delay(10);
    }
    throw Error(`Missing ${type}`);
  }
  const send = value => socket.send(JSON.stringify(value));
  try {
    await new Promise((done, fail) => { socket.once("open", done); socket.once("error", fail); });
    send({ type: "JOIN", room_id: room.id });
    const initial = await next("SNAPSHOT");
    let state = initial.state;
    function command(type, payload) {
      return { protocol_version: 1, room_id: room.id, command_id: randomUUID(),
        control_epoch: initial.control_epoch.id, expected_revision: state.revision,
        media_generation: state.media_generation, type, payload };
    }
    async function apply(type, payload) {
      const cmd = command(type, payload);
      send(cmd);
      const ack = await next("ACK", frame => frame.command_id === cmd.command_id);
      state = ack.state;
      return ack;
    }
    await apply("CHANGE_MEDIA", { media_id: media[0] });
    await next("EVENT", frame => frame.action?.type === "CHANGE_MEDIA");
    assert.ok((await client.request(`${prefix}/playlist`)).some(item => item.media_id === media[0]));
    const b = await client.request(`${prefix}/playlist`, "POST", { media_id: media[1] });
    await next("PLAYLIST_CHANGED");
    checks.push("play-and-enqueue uses its media EVENT; REST insertion broadcasts playlist changes");

    // The same room/snapshot lock used by REST mutations remains held while
    // an END_MEDIA queues. Replace B with C before releasing that transaction.
    const blocker = f.sqlProcess(undefined, { interactive: true });
    blocker.stdout.resume(); blocker.stderr.resume();
    const marker = `queue-lock-${randomUUID()}`;
    blocker.stdin.write(`BEGIN; SELECT id FROM rooms WHERE id='${room.id}' FOR NO KEY UPDATE; SELECT room_id FROM room_snapshots WHERE room_id='${room.id}' FOR UPDATE; SELECT '${marker}';\n`);
    await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction' AND query LIKE '%${marker}%'`, "1");
    let released = false;
    try {
      const end = command("END_MEDIA", { position_ms: 1000 });
      send(end);
      await f.waitForSql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT lifecycle,lifecycle_epoch FROM rooms%'", "1");
      const closed = new Promise(done => blocker.once("close", done));
      blocker.stdin.end(`DELETE FROM playlist_items WHERE id='${b.id}'; INSERT INTO playlist_items(id,room_id,media_id,sort_order) VALUES('${randomUUID()}','${room.id}','${media[2]}',2); COMMIT;\n\\q\n`);
      await closed; released = true;
      assert.equal(blocker.exitCode, 0);
      const ack = await next("ACK", frame => frame.command_id === end.command_id);
      state = ack.state;
      assert.equal(state.media_id, media[2], "resolve the queue after transaction lock admission");
      const diagnostic = JSON.parse(f.sql(`SELECT diagnostic FROM room_events WHERE room_id='${room.id}' AND revision=${state.revision}`));
      assert.equal(diagnostic.operation.resolved_media.media_id, media[2]);
      checks.push("queued END_MEDIA and diagnostic use the committed queue after replacement");
    } finally {
      if (!released) { const closed = new Promise(done => blocker.once("close", done)); blocker.stdin.end("ROLLBACK;\n\\q\n"); await closed; }
    }
    const current = (await client.request(`${prefix}/playlist`)).find(item => item.media_id === state.media_id);
    await client.request(`${prefix}/playlist/${current.id}`, "DELETE");
    await next("PLAYLIST_CHANGED");
    const orphaned = command("END_MEDIA", { position_ms: 1000 });
    const before = f.sql(`SELECT state FROM room_snapshots WHERE room_id='${room.id}'`);
    send(orphaned);
    const denied = await next("ERROR", frame => frame.command_id === orphaned.command_id);
    assert.equal(denied.error.code, "NO_MEDIA");
    assert.equal(f.sql(`SELECT state FROM room_snapshots WHERE room_id='${room.id}'`), before);
    checks.push("a deleted current queue anchor never jumps to the first entry");

    const ids = Array.from({ length: 120 }, () => randomUUID());
    f.sql(`INSERT INTO chat_messages(id,room_id,user_id,body,created_at) VALUES ${ids.map((id, index) => `('${id}','${room.id}','${identity.id}','message-${index}',clock_timestamp()+${index}*interval '1 second')`).join(",")}`);
    const missing = await client.request(`${prefix}/messages?after=${randomUUID()}`, "GET", undefined, 400);
    assert.equal(missing.error.code, "CHAT_CURSOR_NOT_FOUND");
    const recent = await client.request(`${prefix}/messages`);
    assert.equal(recent.length, 100);
    assert.equal(recent[0].body, "message-20");
    const after = await client.request(`${prefix}/messages?after=${ids[115]}`);
    assert.deepEqual(after.map(item => item.body), ["message-116", "message-117", "message-118", "message-119"]);
    checks.push("unknown cursor is explicit; latest history and valid catch-up stay ordered");
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise(done => socket.once("close", done));
      socket.close(); await closed;
    }
  }
});
const cleanup = await fixture.verifyStopped();
await writeFile(resolve(fixture.root, "report.json"), JSON.stringify({ result: "passed", checks, cleanup }, null, 2));
console.log(`PASS ${checks.length} owned playlist/chat regressions; cleanup verified: ${fixture.root}`);
