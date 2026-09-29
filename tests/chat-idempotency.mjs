import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";

await isolatedServer("chat-idempotency", async (f) => {
  const admin = f.client(); const adminIdentity = await admin.login();
  await admin.request("/users", "POST", { username: "chat-viewer", password: f.password });
  const viewer = f.client(); await viewer.login("chat-viewer", f.password);
  const room = await admin.request("/rooms", "POST", { name: "deduplicated chat" });
  const otherRoom = await admin.request("/rooms", "POST", { name: "separate chat" });
  const invite = await admin.request(`/rooms/${room.id}/invites`, "POST");
  await viewer.request(`/rooms/${room.id}/join`, "POST", { token: invite.token });
  const sockets = new Set();
  const connect = async (client, roomId = room.id) => {
    const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", { headers: { Origin: f.origin, Cookie: client.cookie } });
    sockets.add(ws);
    const frames = [];
    ws.on("message", (bytes) => frames.push(JSON.parse(bytes)));
    ws.on("error", () => {});
    await new Promise((done, reject) => { ws.once("open", done); ws.once("error", reject); });
    const next = async (type, predicate = () => true) => {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const index = frames.findIndex(v => v.type === type && predicate(v));
        if (index >= 0) return frames.splice(index, 1)[0];
        await delay(10);
      }
      throw new Error(`Missing ${type} frame`);
    };
    const send = (value) => ws.send(JSON.stringify(value));
    send({ type: "JOIN", room_id: roomId }); await next("SNAPSHOT");
    return { ws, next, send, frames };
  };
  try {
    const a = await connect(admin);
    const key = randomUUID();
    const message = { type: "CHAT", body: "persist once", client_message_id: key };
    a.send(message); const first = await a.next("CHAT");
    a.send(message); const replay = await a.next("CHAT");
    assert.equal(replay.id, first.id, "acknowledgement replay must retain the persisted message identity");
    assert.equal(f.sql(`SELECT count(*) FROM chat_messages WHERE room_id='${room.id}' AND body='persist once'`), "1");
    a.send({ ...message, body: "different payload" });
    assert.equal((await a.next("ERROR")).error.code, "INVALID_REQUEST");
    assert.equal(f.sql(`SELECT body FROM chat_messages WHERE id='${first.id}'`), "persist once");
    const b = await connect(admin);
    const raceKey = randomUUID();
    for (const socket of [a, b]) {
      socket.send({ type: "CHAT", body: "concurrent once", client_message_id: raceKey });
      socket.send({ type: "CLOCK_SYNC", t1: 111 });
    }
    await Promise.all([a.next("CLOCK_SYNC_REPLY"), b.next("CLOCK_SYNC_REPLY")]);
    assert.equal(f.sql(`SELECT count(*) FROM chat_messages WHERE room_id='${room.id}' AND body='concurrent once'`), "1");
    const raceFrames = [...a.frames, ...b.frames].filter(v => v.type === "CHAT" && v.client_message_id === raceKey);
    assert.ok(raceFrames.length > 0);
    assert.equal(new Set(raceFrames.map(v => v.id)).size, 1);
    const otherUser = await connect(viewer);
    otherUser.send(message); const fromViewer = await otherUser.next("CHAT");
    assert.notEqual(fromViewer.id, first.id, "deduplication is scoped to sender");
    const other = await connect(admin, otherRoom.id);
    other.send(message); assert.notEqual((await other.next("CHAT")).id, first.id, "deduplication is scoped to room");
    const legacy = await connect(admin);
    legacy.send({ type: "CHAT", body: "legacy without key" }); const oldOne = await legacy.next("CHAT");
    legacy.send({ type: "CHAT", body: "legacy without key" }); const oldTwo = await legacy.next("CHAT");
    assert.notEqual(oldOne.id, oldTwo.id, "legacy frames without a key remain compatible");
    for (const ws of sockets) ws.terminate();
    await f.startServer();
    const restarted = await connect(admin);
    restarted.send(message); const afterRestart = await restarted.next("CHAT");
    assert.equal(afterRestart.id, first.id, "deduplication survives reconnection and Server restart");
    assert.equal(afterRestart.user_id, adminIdentity.id);
    const history = await admin.request(`/rooms/${room.id}/messages`);
    assert.equal(history.filter(v => v.id === first.id).length, 1);
    assert.equal(f.sql(`SELECT count(*) FROM chat_messages WHERE room_id='${room.id}' AND user_id='${adminIdentity.id}' AND body='persist once'`), "1");
    console.log("PASS: real CHAT repeat and concurrent sockets persist once, reject changed payload, scope by room/user, keep legacy frames, and survive Server restart");
  } finally { for (const ws of sockets) ws.terminate(); }
});
