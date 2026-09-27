import assert from "node:assert/strict";
import { request } from "node:http";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import WebSocket from "ws";

export async function relayCancellation({
  workerBase,
  sql,
  encrypt,
  userId,
  roomId,
  agentId,
}) {
  const cases = [];
  const sockets = new Set();
  const requests = new Set();
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(check, label, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(50);
    }
    throw Error(`deadline: ${label}`);
  }
  function start(method = "GET") {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex");
    const resource = encrypt({
      kind: "agent",
      agent_id: agentId,
      resource: id,
    });
    sql(
      `UPDATE agents SET last_seen=now() WHERE id='${agentId}'; INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}','${userId}','${roomId}',0,'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${resource}"}',now()+interval '1 hour')`,
    );
    const state = { id, body: [], ended: false };
    const req = request(
      `${workerBase}/media-delivery/${id}/source?token=${token}`,
      { method },
      (res) => {
        state.response = res;
        res.on("data", (chunk) => state.body.push(chunk));
        res.on("end", () => {
          state.ended = true;
        });
        res.on("error", () => {});
      },
    );
    requests.add(req);
    req.on("error", () => {});
    req.on("close", () => requests.delete(req));
    req.end();
    state.request = req;
    return state;
  }
  async function offered(state) {
    let row;
    await until(() => {
      const value = sql(
        `SELECT json_build_object('id',id,'request',request) FROM agent_transfers WHERE agent_id='${agentId}' AND request->>'resource'='${state.id}'`,
      );
      if (value) row = JSON.parse(value);
      return row;
    }, "offered ticket");
    return row;
  }
  function url(row) {
    const path = new URL(row.request.data_url);
    return workerBase.replace("http:", "ws:") + path.pathname + path.search;
  }
  async function connect(row) {
    const ws = new WebSocket(url(row));
    sockets.add(ws);
    ws.on("error", () => {});
    ws.on("close", () => sockets.delete(ws));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return ws;
  }
  const noTicket = (id) =>
    sql(
      `SELECT count(*) FROM agent_transfers WHERE request->>'resource'='${id}'`,
    ) === "0";
  async function cancelled(state, row, ws, label) {
    const began = Date.now();
    state.request.destroy();
    await until(
      () => noTicket(state.id) && (!ws || ws.readyState === WebSocket.CLOSED),
      label,
    );
    if (row) {
      const late = new WebSocket(url(row));
      const status = await new Promise((resolve, reject) => {
        late.once("unexpected-response", (_, res) => {
          res.resume();
          resolve(res.statusCode);
          late.terminate();
        });
        late.once("open", () => {
          late.terminate();
          reject(Error("cancelled transfer accepted"));
        });
        late.on("error", () => {});
      });
      assert.ok(status === 401 || status === 410);
    }
    cases.push({ scenario: label, released_ms: Date.now() - began });
  }
  try {
    // The INSERT continues after the HTTP future disappears. Cleanup must be
    // ordered after that INSERT, not race it with an early DELETE.
    sql(
      `CREATE FUNCTION relay_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$; CREATE TRIGGER relay_test_delay BEFORE INSERT ON agent_transfers FOR EACH ROW EXECUTE FUNCTION relay_test_delay()`,
    );
    const delayed = start();
    await until(
      () =>
        sql(
          "SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE 'INSERT INTO agent_transfers%'",
        ) === "1",
      "insert suspended",
    );
    const began = Date.now();
    delayed.request.destroy();
    await until(
      () =>
        sql(
          "SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE 'INSERT INTO agent_transfers%'",
        ) === "0",
      "insert settles",
    );
    await delay(300);
    assert.ok(
      noTicket(delayed.id),
      "late INSERT did not recreate a cancelled offer",
    );
    assert.ok(Date.now() - began < 5000);
    cases.push({
      scenario: "cancel-during-insert",
      released_ms: Date.now() - began,
    });
    sql(
      "DROP TRIGGER relay_test_delay ON agent_transfers; DROP FUNCTION relay_test_delay()",
    );

    for (let i = 0; i < 5; i++) {
      const state = start(),
        row = await offered(state);
      await cancelled(state, row, null, `cancel-before-connect-${i}`);
    }
    const headers = start(),
      headerRow = await offered(headers),
      headerSocket = await connect(headerRow);
    await cancelled(headers, headerRow, headerSocket, "cancel-before-headers");

    const body = start(),
      bodyRow = await offered(body),
      bodySocket = await connect(bodyRow);
    bodySocket.send(
      JSON.stringify({
        status: 200,
        "content-length": "10485760",
        "content-type": "video/mp4",
      }),
    );
    bodySocket.send(Buffer.alloc(32768, 1));
    await until(() => body.body.length > 0, "HTTP body streaming");
    await cancelled(body, bodyRow, bodySocket, "cancel-during-body");

    const head = start("HEAD"),
      headRow = await offered(head),
      headSocket = await connect(headRow);
    headSocket.send(
      JSON.stringify({ status: 200, "content-length": "10485760" }),
    );
    await until(
      () =>
        head.ended &&
        headSocket.readyState === WebSocket.CLOSED &&
        noTicket(head.id),
      "HEAD releases relay",
    );
    assert.equal(Buffer.concat(head.body).length, 0);
    cases.push({ scenario: "HEAD-complete" });

    const complete = start(),
      completeRow = await offered(complete),
      completeSocket = await connect(completeRow);
    completeSocket.send(JSON.stringify({ status: 200, "content-length": "3" }));
    completeSocket.send(Buffer.from("abc"));
    completeSocket.close();
    await until(
      () => complete.ended && noTicket(complete.id),
      "normal completion",
    );
    assert.equal(Buffer.concat(complete.body).toString(), "abc");
    cases.push({ scenario: "body-complete" });
    return cases;
  } finally {
    for (const req of requests) req.destroy();
    for (const ws of sockets) ws.terminate();
    sql(
      "DROP TRIGGER IF EXISTS relay_test_delay ON agent_transfers; DROP FUNCTION IF EXISTS relay_test_delay()",
    );
  }
}
