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
  crashWorker,
  holdTransfer,
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
    const resourceHash = createHash("sha256")
      .update(
        JSON.stringify({ agent_id: agentId, kind: "agent", resource: id }),
      )
      .digest("hex");
    const state = { id, resourceHash, body: [], ended: false };
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
  function run(state) {
    const value = sql(
      `SELECT row_to_json(r) FROM agent_transfer_runs r WHERE resource_hash='${state.resourceHash}'`,
    );
    return value ? JSON.parse(value) : undefined;
  }
  async function terminal(state, status, reason) {
    await until(
      () => run(state)?.status === status,
      `${status} transfer recorded`,
    );
    const row = run(state);
    assert.ok(row.finished_at);
    if (reason) assert.equal(row.reason, reason);
    return row;
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
    assert.equal(run(state).status, "offered");
    assert.equal(run(state).head, row.request.head);
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
    await terminal(state, "cancelled", "consumer_cancelled");
  }
  try {
    sql(
      "CREATE FUNCTION relay_test_reject_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled lifecycle insert failure'; END $$; CREATE TRIGGER relay_test_reject_state BEFORE INSERT ON agent_transfer_runs FOR EACH ROW EXECUTE FUNCTION relay_test_reject_state()",
    );
    const rejected = start();
    await until(() => rejected.ended, "failed lifecycle insert response");
    assert.equal(rejected.response.statusCode, 502);
    assert.ok(noTicket(rejected.id), "lifecycle failure rolls back its ticket");
    assert.equal(run(rejected), undefined);
    sql(
      "DROP TRIGGER relay_test_reject_state ON agent_transfer_runs; DROP FUNCTION relay_test_reject_state()",
    );
    cases.push({ scenario: "offer-and-state-atomic-rollback" });
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
    await terminal(delayed, "cancelled", "consumer_cancelled");
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
    assert.equal(run(headers).status, "connected");
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
    assert.equal(run(body).status, "streaming");
    await cancelled(body, bodyRow, bodySocket, "cancel-during-body");
    assert.equal(run(body).bytes_delivered, 32768);

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
    assert.equal((await terminal(head, "completed")).bytes_delivered, 0);
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
    assert.equal((await terminal(complete, "completed")).bytes_delivered, 3);
    cases.push({ scenario: "body-complete" });

    const raced = start(),
      racedRow = await offered(raced);
    const contenders = await Promise.all(
      [0, 1].map(
        () =>
          new Promise((resolve) => {
            const ws = new WebSocket(url(racedRow));
            sockets.add(ws);
            ws.once("open", () => resolve({ ws, status: 101 }));
            ws.once("unexpected-response", (_, res) => {
              res.resume();
              resolve({ ws, status: res.statusCode });
              ws.terminate();
            });
            ws.on("error", () => {});
            ws.on("close", () => sockets.delete(ws));
          }),
      ),
    );
    assert.deepEqual(contenders.map((r) => r.status).sort(), [101, 401]);
    assert.equal(run(raced).status, "connected");
    await cancelled(
      raced,
      racedRow,
      contenders.find((r) => r.status === 101).ws,
      "atomic-ticket-claim",
    );

    for (const kind of ["malformed", "truncated", "denied"]) {
      const failed = start(),
        row = await offered(failed),
        ws = await connect(row);
      if (kind === "malformed") ws.send("not-json");
      else {
        ws.send(
          JSON.stringify({
            status: kind === "denied" ? 401 : 200,
            "content-length": kind === "denied" ? "0" : "100000",
          }),
        );
        if (kind === "truncated") ws.send(Buffer.from("short"));
        ws.close();
      }
      const expected = {
        malformed: "invalid_agent_headers",
        truncated: "truncated_agent_data",
        denied: "agent_http_error",
      }[kind];
      await terminal(failed, "failed", expected);
      cases.push({ scenario: `${kind}-failure-recorded` });
    }

    for (const target of ["ticket", "lease"]) {
      const blocked = start(),
        row = await offered(blocked);
      holdTransfer(row.id, target);
      await until(
        () =>
          sql(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name='relay_lock_fixture' AND wait_event='PgSleep'",
          ) === "1",
        "expiry row locked",
      );
      const ws = new WebSocket(url(row));
      ws.on("error", () => {});
      const result = new Promise((resolve, reject) => {
        ws.once("unexpected-response", (_, response) => {
          response.resume();
          resolve(response.statusCode);
          ws.terminate();
        });
        ws.once("open", () => {
          ws.terminate();
          reject(Error("expired transfer revived after row lock wait"));
        });
      });
      void result.catch(() => {});
      await until(
        () =>
          sql(
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%agent_transfer%'",
          ) === "1",
        "claim waits for locked expiry",
      );
      assert.equal(await result, target === "ticket" ? 401 : 410);
      assert.equal(run(blocked).status, "offered");
      blocked.request.destroy();
      cases.push({ scenario: `${target}-expiry-rechecked-after-lock` });
    }

    const live = start(),
      liveRow = await offered(live),
      liveSocket = await connect(liveRow);
    liveSocket.send(
      JSON.stringify({ status: 200, "content-length": "10485760" }),
    );
    const firstLease = run(live).lease_until;
    const keepAlive = setInterval(() => {
      if (liveSocket.readyState === WebSocket.OPEN)
        liveSocket.send(Buffer.alloc(512));
    }, 250);
    try {
      await delay(35000);
      assert.equal(run(live).status, "streaming");
      assert.ok(Date.parse(run(live).lease_until) > Date.parse(firstLease));
      assert.ok(!live.ended && live.body.length > 0);
      sql(
        `UPDATE agent_transfer_runs SET lease_until=now()-interval '1 second' WHERE id='${liveRow.id}'`,
      );
      await until(
        () => liveSocket.readyState === WebSocket.CLOSED,
        "lost transfer lease aborts data connection",
        15000,
      );
      // A terminal state after expiry is written by the Server sweeper, never
      // by the late former owner. Bound this by one real cleanup interval.
      await until(
        () => run(live)?.status === "failed",
        "expired transfer reconciled",
        70000,
      );
      assert.equal(run(live).reason, "transfer_owner_lost");
      assert.equal(live.ended, false);
      cases.push({ scenario: "long-stream-renews-and-lost-lease-aborts" });
    } finally {
      clearInterval(keepAlive);
    }

    const crashed = start(),
      crashRow = await offered(crashed),
      crashSocket = await connect(crashRow);
    crashSocket.send(
      JSON.stringify({ status: 200, "content-length": "10485760" }),
    );
    crashSocket.send(Buffer.alloc(1024));
    await until(() => crashed.body.length > 0, "stream before Worker crash");
    assert.equal(run(crashed).status, "streaming");
    // Also exercise retention without waiting 24 hours: only the terminal test
    // record's timestamp is shifted; active expiry still uses the real clock.
    sql(
      `UPDATE agent_transfer_runs SET finished_at=now()-interval '25 hours' WHERE id='${run(head).id}'`,
    );
    crashWorker();
    await until(
      () => crashSocket.readyState === WebSocket.CLOSED,
      "crashed Worker connection closed",
    );
    await until(
      () => run(crashed)?.status === "failed",
      "crashed owner reconciled",
      100000,
    );
    assert.equal(run(crashed).reason, "transfer_owner_lost");
    assert.ok(noTicket(crashed.id));
    assert.equal(run(head), undefined);
    assert.equal(run(complete).status, "completed");
    assert.equal(crashed.ended, false);
    cases.push({ scenario: "worker-crash-and-terminal-retention" });
    return cases;
  } finally {
    for (const req of requests) req.destroy();
    for (const ws of sockets) ws.terminate();
    sql(
      "DROP TRIGGER IF EXISTS relay_test_delay ON agent_transfers; DROP FUNCTION IF EXISTS relay_test_delay()",
    );
    sql(
      "DROP TRIGGER IF EXISTS relay_test_reject_state ON agent_transfer_runs; DROP FUNCTION IF EXISTS relay_test_reject_state()",
    );
  }
}
