import { sourceMedia } from "./fixtures/source-grant.mjs";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { open, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";

async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw Error(`Timed out: ${label}`);
}

await isolatedMediaStack("agent-drain-receipts", async f => {
  const sockets = new Set(), requests = new Set();
  const admin = f.client(), identity = await admin.login();
  const filePath = resolve(f.root, "long.mp4"), size = 1024 * 1024 * 1024;
  const file = await open(filePath, "w"); await file.truncate(size); await file.close();
  const encrypt = value => {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"), nonce);
    return Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("base64");
  };
  async function connectAgent(token) {
    const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/agents/ws", { headers: { Authorization: `Bearer ${token}` } });
    sockets.add(ws); const frames = [];
    ws.on("message", bytes => frames.push(JSON.parse(bytes))); ws.on("error", () => {});
    await new Promise((done, reject) => { ws.once("open", done); ws.once("error", reject); });
    return { ws, send: value => ws.send(JSON.stringify(value)), next: async (type, id) => {
      let found;
      await until(() => { const index = frames.findIndex(frame => frame.type === type && (!id || frame.id === id)); if (index < 0) return false; found = frames.splice(index, 1)[0]; return true; }, type);
      return found;
    } };
  }
  async function pair(name) {
    const created = await admin.request("/agents", "POST", { name });
    return { id: created.id, ...(await admin.request("/agents/pair", "POST", { code: created.pair_code })) };
  }
  async function agentOpenFiles() {
    const paths = await readdir(`/proc/${f.agentPid}/fd`);
    let count = 0;
    for (const path of paths) {
      try { if (await readlink(`/proc/${f.agentPid}/fd/${path}`) === filePath) count++; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return count;
  }
  function startStream(url) {
    const state = { response: null, aborted: false, ended: false, bytes: 0 };
    const req = request(url, res => {
      state.response = res;
      res.on("error", () => {}); res.on("aborted", () => { state.aborted = true; });
      res.on("end", () => { state.ended = true; }); res.on("data", bytes => { state.bytes += bytes.length; });
      res.pause();
    });
    requests.add(req); req.on("error", () => {}); req.on("close", () => requests.delete(req)); req.end();
    state.request = req; return state;
  }
  try {
    const a = await pair("receipt test owner"), b = await pair("receipt test outsider");
    const sender = await connectAgent(a.token), outsider = await connectAgent(b.token);
    const transfer = randomUUID(), unexposed = randomUUID();
    f.sql(`INSERT INTO agent_transfer_runs(id,agent_id,resource_hash,head,dispatched_at,legacy_unconfirmed) VALUES('${transfer}','${a.id}','receipt-auth',true,now(),false),('${unexposed}','${a.id}','receipt-never-dispatched',true,NULL,false)`);
    outsider.send({ type: "TRANSFER_DRAINED", id: transfer });
    const foreignAck = await outsider.next("TRANSFER_DRAINED_ACK", transfer);
    assert.equal(foreignAck.accepted, false);
    assert.equal(foreignAck.rejected_permanently, true);
    assert.equal(f.sql(`SELECT agent_drained_at IS NULL FROM agent_transfer_runs WHERE id='${transfer}'`), "t");
    sender.send({ type: "TRANSFER_DRAINED", id: unexposed });
    const unexposedAck = await sender.next("TRANSFER_DRAINED_ACK", unexposed);
    assert.equal(unexposedAck.accepted, false);
    assert.equal(unexposedAck.rejected_permanently, true);
    sender.send({ type: "TRANSFER_DRAINED", id: transfer });
    assert.equal((await sender.next("TRANSFER_DRAINED_ACK", transfer)).accepted, true);
    const acknowledgedAt = f.sql(`SELECT agent_drained_at FROM agent_transfer_runs WHERE id='${transfer}'`);
    sender.send({ type: "TRANSFER_DRAINED", id: transfer });
    assert.equal((await sender.next("TRANSFER_DRAINED_ACK", transfer)).accepted, true);
    assert.equal(f.sql(`SELECT agent_drained_at FROM agent_transfer_runs WHERE id='${transfer}'`), acknowledgedAt);
    sender.ws.terminate(); outsider.ws.terminate();
    console.log("PASS: authenticated receipt ownership, undispatched rejection and duplicate acknowledgement preserves timestamp");

    await f.startWorker();
    const { agentId } = await f.startAgent();
    await until(() => f.sql(`SELECT count(*) FROM media_items WHERE source_id='${agentId}' AND resource='long.mp4' AND source_version IS NOT NULL`) === "1", "real Agent versioned index");
    const sourceVersion = f.sql(`SELECT source_version FROM media_items WHERE source_id='${agentId}' AND resource='long.mp4'`);
    async function prepare(label) {
      const room = await admin.request("/rooms", "POST", { name: label });
      const session = randomUUID(), token = randomBytes(32).toString("hex");
      const resource = { kind: "agent", agent_id: agentId, resource: "long.mp4", source_version: sourceVersion };
      f.sql(`INSERT INTO playback_sessions(media_id,id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${sourceMedia(f,resource)}','${session}','${identity.id}','${room.id}',0,'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${encrypt(resource)}"}',now()+interval '1 hour')`);
      const stream = startStream(`${f.workerOrigin}/media-delivery/${session}/source?token=${token}`);
      await until(() => stream.response, "real NAS response headers");
      assert.equal(stream.response.statusCode, 200);
      assert.equal(Number(stream.response.headers["content-length"]), size);
      await until(async () => (await agentOpenFiles()) > 0, "real NAS open source descriptor");
      const transfer = f.sql(`SELECT id FROM agent_transfer_runs WHERE session_id='${session}'`);
      assert.match(transfer, /^[a-f\d-]{36}$/);
      assert.equal(f.sql(`SELECT dispatched_at IS NOT NULL AND agent_drained_at IS NULL FROM agent_transfer_runs WHERE id='${transfer}'`), "t");
      return { room, session, stream, transfer };
    }
    const live = await prepare("NAS close waits for receipt");
    // Preserve main399's explicit backpressure-health contract. A paused real
    // Worker consumer must keep its NAS file alive beyond the 30s write-idle
    // timeout; generic Ping/Pong would not extend this deadline.
    await delay(35000);
    assert.ok((await agentOpenFiles()) > 0, "healthy Worker backpressure retains NAS transfer beyond30s");
    assert.equal(f.sql(`SELECT agent_drained_at IS NULL FROM agent_transfer_runs WHERE id='${live.transfer}'`), "t");
    console.log("PASS: main399 explicit real-Worker backpressure health preserves paused NAS source beyond30s");
    const before = await admin.request(`/rooms/${live.room.id}/lifecycle`);
    const closing = await admin.request(`/rooms/${live.room.id}/close`, "POST", { expected_revision: before.state.revision });
    assert.equal(closing.lifecycle, "closing");
    await until(async () => (await agentOpenFiles()) === 0, "NAS file descriptor released", 10000);
    await f.waitForSql(`SELECT count(*) FROM agent_transfer_runs WHERE id='${live.transfer}' AND agent_drained_at IS NOT NULL`, "1", 15000);
    await f.waitForSql(`SELECT lifecycle FROM rooms WHERE id='${live.room.id}'`, "closed", 15000);
    assert.equal(f.sql(`SELECT t.agent_drained_at<=e.created_at FROM agent_transfer_runs t JOIN playback_sessions p ON p.id=t.session_id JOIN room_lifecycle_events e ON e.room_id=p.room_id AND e.lifecycle='closed' WHERE t.id='${live.transfer}'`), "t", "closed must follow positive NAS receipt");
    live.stream.response.resume();
    await until(() => live.stream.aborted, "paused NAS consumer aborted");
    assert.equal(live.stream.ended, false);
    assert.ok(live.stream.bytes < size);
    live.stream.request.destroy();
    console.log("PASS: paused real NAS stream closes file, receipt precedes closed, old downstream response aborts");

    const reconnect = await prepare("NAS receipt reconnect retry");
    const lockTag = `receipt-lock-${randomUUID()}`;
    const lock = f.sqlProcess(`BEGIN; SELECT id FROM agent_transfer_runs WHERE id='${reconnect.transfer}' FOR UPDATE; SELECT pg_sleep(12) /* ${lockTag} */; COMMIT;`);
    lock.done.catch(() => {});
    await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${lockTag}%'`, "1");
    const current = await admin.request(`/rooms/${reconnect.room.id}/lifecycle`);
    await admin.request(`/rooms/${reconnect.room.id}/close`, "POST", { expected_revision: current.state.revision });
    await until(async () => (await agentOpenFiles()) === 0, "source disposal before delayed ACK", 10000);
    const receiptPath = resolve(f.root, "agent-token.drained.json");
    await until(async () => {
      try { return JSON.parse(await readFile(receiptPath, "utf8")).includes(reconnect.transfer); }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }, "completed receipt persisted before reconnect", 10000);
    assert.equal(f.sql(`SELECT agent_drained_at IS NULL FROM agent_transfer_runs WHERE id='${reconnect.transfer}'`), "t");
    assert.equal((await admin.request(`/rooms/${reconnect.room.id}/lifecycle`)).lifecycle, "closing");
    for (const socket of sockets) socket.terminate();
    await f.startServer();
    await lock.done;
    await f.waitForSql(`SELECT count(*) FROM agent_transfer_runs WHERE id='${reconnect.transfer}' AND agent_drained_at IS NOT NULL`, "1", 20000);
    await f.waitForSql(`SELECT lifecycle FROM rooms WHERE id='${reconnect.room.id}'`, "closed", 20000);
    await until(async () => !JSON.parse(await readFile(receiptPath, "utf8")).includes(reconnect.transfer), "accepted replay removes durable receipt", 10000);
    assert.equal(f.sql(`SELECT t.agent_drained_at<=e.created_at FROM agent_transfer_runs t JOIN playback_sessions p ON p.id=t.session_id JOIN room_lifecycle_events e ON e.room_id=p.room_id AND e.lifecycle='closed' WHERE t.id='${reconnect.transfer}'`), "t");
    reconnect.stream.request.destroy();
    console.log("PASS: delayed ACK survives Server restart/control reconnect, persisted drained receipt is retried and confirmed before closed");

    const controlLoss = await prepare("NAS active transfer control disconnect");
    await f.stopServer();
    // The grant remains active in PostgreSQL. Only loss of the NAS control
    // connection caused this data operation to cooperatively release its file.
    assert.equal(f.sql(`SELECT stopped FROM playback_sessions WHERE id='${controlLoss.session}'`), "f");
    await until(async () => (await agentOpenFiles()) === 0, "control loss drains active NAS file", 10000);
    await until(async () => JSON.parse(await readFile(receiptPath, "utf8")).includes(controlLoss.transfer), "control-loss disposal persisted before reconnect", 10000);
    controlLoss.stream.response.resume();
    await until(() => controlLoss.stream.aborted, "control loss aborts data response");
    await f.startServer();
    await f.waitForSql(`SELECT count(*) FROM agent_transfer_runs WHERE id='${controlLoss.transfer}' AND agent_drained_at IS NOT NULL`, "1", 20000);
    const controlView = await admin.request(`/rooms/${controlLoss.room.id}/lifecycle`);
    assert.equal(controlView.lifecycle, "active");
    await admin.request(`/rooms/${controlLoss.room.id}/close`, "POST", { expected_revision: controlView.state.revision });
    await f.waitForSql(`SELECT lifecycle FROM rooms WHERE id='${controlLoss.room.id}'`, "closed", 15000);
    controlLoss.stream.request.destroy();
    console.log("PASS: control disconnect alone cooperatively drains active data/file ownership and retries its persisted receipt on reconnect");

    // A mocked unresponsive control owner is intentional here: it never ACKs
    // the preloaded full backlog, then exposes one more transfer. No data/file
    // work may start, but that received UUID must get a no-resource receipt.
    const backlogCredential = resolve(f.root, "backlog-agent-token");
    const backlogPath = `${backlogCredential}.drained.json`;
    const pending = Array.from({ length: 4096 }, () => randomUUID());
    const overflow = randomUUID();
    await writeFile(backlogPath, JSON.stringify(pending), { mode: 0o600 });
    const mock = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise(done => mock.once("listening", done));
    const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
    const peers = new Set(); let dataOpens = 0;
    mock.on("connection", (peer, req) => {
      peers.add(peer); peer.on("error", () => {}); peer.on("close", () => peers.delete(peer));
      if (req.url !== "/api/v1/agents/ws") { dataOpens++; return; }
      peer.on("message", bytes => {
        const value = JSON.parse(bytes);
        if (value.type === "HELLO") peer.send(JSON.stringify({ type: "TRANSFER", id: overflow, request: { drain_receipt_required: true, data_url: `${mockOrigin.replace("http", "ws")}/must-not-open`, resource: "long.mp4" } }));
        if (value.type === "INDEX") peer.send(JSON.stringify({ type: "INDEX_ACK", sequence: value.sequence }));
      });
    });
    const backlogAgent = spawn(resolve(f.target, `rainsync-nas-agent${process.platform === "win32" ? ".exe" : ""}`), [], { env: { ...f.env, SERVER_URL: mockOrigin, AGENT_TOKEN: "isolated-backlog-fixture", MEDIA_ROOT: f.root, AGENT_CREDENTIAL_FILE: backlogCredential }, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    const stopped = new Promise(done => backlogAgent.once("close", done));
    try {
      await until(async () => JSON.parse(await readFile(backlogPath, "utf8")).includes(overflow), "full backlog preserves newly dispatched no-resource receipt");
      assert.equal(dataOpens, 0);
      assert.equal(JSON.parse(await readFile(backlogPath, "utf8")).length, 4097);
      console.log("PASS: full4096 receipt backlog persists incoming dispatched UUID before rejecting work and never opens its data connection");
    } finally {
      backlogAgent.kill(); await stopped;
      for (const peer of peers) peer.terminate();
      await new Promise(done => mock.close(done));
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const req of requests) req.destroy();
  }
});
