import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export async function reviewRegressions({
  admin,
  friend,
  sql,
  connect,
  origin,
  sqlProcess,
}) {
  const room = await admin.request("/rooms", "POST", {
    name: "雨".repeat(120),
  });
  assert.equal(
    (await admin.request("/rooms", "POST", { name: "😀".repeat(121) }, 400))
      .error.code,
    "INVALID_NAME",
  );
  const viewer = await connect(admin, room.id);
  await viewer.wait((v) => v.type === "SNAPSHOT");
  const messageId = randomUUID();
  viewer.ws.send(
    JSON.stringify({
      type: "CHAT",
      body: "😀".repeat(2000),
      client_message_id: messageId,
    }),
  );
  const accepted = await viewer.wait((v) => v.type === "CHAT");
  assert.equal(accepted.body.length, 4000);
  assert.equal(accepted.client_message_id, messageId);
  viewer.ws.send(JSON.stringify({ type: "CHAT", body: "雨".repeat(2001) }));
  assert.equal(
    (await viewer.wait((v) => v.type === "ERROR")).error.code,
    "INVALID_REQUEST",
  );
  sql(
    `INSERT INTO chat_messages(id,room_id,user_id,body,created_at) SELECT gen_random_uuid(),'${room.id}',owner_id,'missed-'||n,now()+n*interval '1 millisecond' FROM rooms CROSS JOIN generate_series(1,105) n WHERE rooms.id='${room.id}'`,
  );
  const first = await admin.request(
    `/rooms/${room.id}/messages?after=${accepted.id}`,
  );
  const rest = await admin.request(
    `/rooms/${room.id}/messages?after=${first.at(-1).id}`,
  );
  assert.equal(first.length, 100);
  assert.equal(rest.length, 5);
  assert.equal(new Set([...first, ...rest].map((m) => m.id)).size, 105);
  viewer.ws.close();
  const invitation = await admin.request(`/rooms/${room.id}/invites`, "POST");
  const locker = sqlProcess(
    `BEGIN; SELECT id FROM rooms WHERE id='${room.id}' FOR UPDATE; SELECT pg_sleep(3); COMMIT;`,
  );
  const unlocked = new Promise((r, j) => {
    locker.once("exit", (code) =>
      code === 0 ? r() : j(Error("lock fixture failed")),
    );
    locker.once("error", j);
  });
  for (let i = 0; i < 30; i++) {
    if (
      sql(
        `SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${room.id}%'`,
      ) === "1"
    )
      break;
    await delay(30);
  }
  let revoked = false;
  const revoking = admin
    .request(`/rooms/${room.id}/invites/${invitation.token}`, "DELETE")
    .then(() => (revoked = true));
  await delay(200);
  assert.equal(
    revoked,
    false,
    "revocation waits for the same room lock as joining",
  );
  await unlocked;
  await revoking;
  assert.equal(
    (
      await friend.request(
        `/rooms/${room.id}/join`,
        "POST",
        { token: invitation.token },
        403,
      )
    ).error.code,
    "INVALID_INVITE",
  );

  console.log(
    "PASS: Unicode scalar limits, chat acknowledgement and paginated reconnect history",
  );

  const created = await admin.request("/agents", "POST", {
    name: "paged-index-regression",
  });
  const paired = await admin.request("/agents/pair", "POST", {
    code: created.pair_code,
  });
  async function agentSocket() {
    const ws = new WebSocket(
      origin.replace("http", "ws") + "/api/v1/agents/ws",
      { headers: { Authorization: `Bearer ${paired.token}` } },
    );
    const inbox = [];
    ws.on("message", (b) => inbox.push(JSON.parse(b)));
    await new Promise((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    async function wait(type) {
      for (let i = 0; i < 3000; i++) {
        const n = inbox.findIndex((v) => v.type === type);
        if (n >= 0) return inbox.splice(n, 1)[0];
        if (ws.readyState !== 1) throw Error("agent closed");
        await delay(10);
      }
      throw Error(
        "agent message timeout: " +
          type +
          " " +
          JSON.stringify(inbox) +
          " " +
          sql(
            "SELECT state,wait_event_type,wait_event,left(query,200) FROM pg_stat_activity WHERE datname=current_database()",
          ),
      );
    }
    return { ws, wait };
  }
  let agent = await agentSocket();
  let indexHeartbeat, releasePublish;
  try {
    const pong = new Promise((r, j) => {
      const t = setTimeout(() => j(Error("missing pong")), 3000);
      agent.ws.once("pong", () => {
        clearTimeout(t);
        r();
      });
    });
    agent.ws.ping();
    await pong;
    // Real production Agents keep sending heartbeat while publishing a large
    // index. The receive timestamp predates bulk commit, so an ACK by itself
    // cannot prove that incoming traffic stayed responsive during publication.
    indexHeartbeat = setInterval(() => {
      if (agent.ws.readyState === WebSocket.OPEN)
        agent.ws.send(JSON.stringify({ type: "HEARTBEAT" }));
    }, 1000);
    for (let i = 0; i < 100; i++) {
      if (
        sql(`SELECT EXISTS(SELECT 1 FROM sources WHERE id='${created.id}')`) ===
        "t"
      )
        break;
      await delay(25);
    }
    const lockedResource = `${"长路径/".repeat(20)}0.mp4`;
    sql(
      `INSERT INTO media_items(id,source_id,title,resource) VALUES(gen_random_uuid(),'${created.id}','previous committed item','${lockedResource}')`,
    );
    const locker = sqlProcess(undefined, { interactive: true });
    locker.stdout.resume();
    locker.stderr.resume();
    let released = false;
    releasePublish = async () => {
      if (released) return;
      released = true;
      locker.stdin.end("ROLLBACK;\n\\q\n");
      await locker.done;
      assert.equal(
        locker.exitCode,
        0,
        "owned final-publication blocker released",
      );
    };
    const marker = `index-publication-${randomUUID()}`;
    locker.stdin.write(
      `BEGIN; SELECT id FROM media_items WHERE source_id='${created.id}' AND resource='${lockedResource}' FOR UPDATE; SELECT '${marker}';\n`,
    );
    let blockerPid;
    for (let i = 0; i < 100; i++) {
      const pid = sql(
        `SELECT pid FROM pg_stat_activity WHERE state='idle in transaction' AND query LIKE '%${marker}%'`,
      );
      if (/^[1-9]\d*$/.test(pid)) {
        blockerPid = Number(pid);
        break;
      }
      await delay(25);
    }
    assert.ok(
      Number.isSafeInteger(blockerPid),
      "owned media-row lock was not observed",
    );
    const snapshot = randomUUID();
    let encoded = 0;
    for (
      let offset = 0, sequence = 0;
      offset < 10001;
      offset += 128, sequence++
    ) {
      const items = Array.from(
        { length: Math.min(128, 10001 - offset) },
        (_, i) => ({
          title: `item-${offset + i}`,
          resource: `${"长路径/".repeat(20)}${offset + i}.mp4`,
        }),
      );
      const frame = JSON.stringify({
        type: "INDEX",
        snapshot,
        sequence,
        final: offset + 128 >= 10001,
        items,
      });
      encoded += Buffer.byteLength(frame);
      assert.ok(Buffer.byteLength(frame) < 1024 * 1024);
      agent.ws.send(frame);
      if (offset + 128 >= 10001) {
        // Hold a media row, never the Agent row: publication must wait while
        // authenticated receive-loop heartbeats remain able to advance last_seen.
        let blocked = false;
        for (let i = 0; i < 200; i++) {
          if (
            sql(
              `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND ${blockerPid}=ANY(pg_blocking_pids(pid)))`,
            ) === "t"
          ) {
            blocked = true;
            break;
          }
          await delay(25);
        }
        assert.ok(
          blocked,
          "final index publication did not wait on the owned media lock",
        );
        const received = sql(
          `SELECT last_seen::text FROM agents WHERE id='${created.id}'`,
        ).replaceAll("'", "''");
        assert.ok(received, "current connection has a receive timestamp");
        let renewed = false;
        for (let i = 0; i < 100; i++) {
          if (
            sql(
              `SELECT last_seen>'${received}'::timestamptz AND clock_timestamp()-last_seen<interval '3 seconds' FROM agents WHERE id='${created.id}'`,
            ) === "t"
          ) {
            renewed = true;
            break;
          }
          await delay(25);
        }
        assert.ok(
          renewed,
          "incoming heartbeat must advance the current connection while final publish waits",
        );
        assert.equal(
          sql(
            `SELECT count(*) FROM media_items WHERE source_id='${created.id}' AND available`,
          ),
          "1",
          "the previous catalog remains atomic before final commit",
        );
        await releasePublish();
        releasePublish = undefined;
      }
      assert.equal((await agent.wait("INDEX_ACK")).sequence, sequence);
    }
    assert.ok(encoded > 1024 * 1024);
    assert.equal(
      sql(
        `SELECT count(*) FROM media_items WHERE source_id='${created.id}' AND available`,
      ),
      "10001",
    );
    assert.equal(
      sql(
        `SELECT now()-last_seen < interval '3 seconds' FROM agents WHERE id='${created.id}'`,
      ),
      "t",
    );
    clearInterval(indexHeartbeat);
    indexHeartbeat = undefined;
    agent.ws.send(
      JSON.stringify({
        type: "INDEX",
        snapshot: randomUUID(),
        sequence: 0,
        final: false,
        items: [{ title: "partial", resource: "partial.mp4" }],
      }),
    );
    await agent.wait("INDEX_ACK");
    agent.ws.terminate();
    agent = await agentSocket();
    agent.ws.send(
      JSON.stringify({
        type: "INDEX",
        snapshot: randomUUID(),
        sequence: 0,
        final: true,
        items: [{ title: "only", resource: "only.mp4" }],
      }),
    );
    await agent.wait("INDEX_ACK");
    assert.equal(
      sql(
        `SELECT count(*) FROM media_items WHERE source_id='${created.id}' AND available`,
      ),
      "1",
    );
    assert.equal(
      sql(
        `SELECT count(*) FROM media_items WHERE source_id='${created.id}' AND resource='partial.mp4'`,
      ),
      "0",
    );
    // Slow each pre-send claim to expose whether a transfer backlog monopolizes
    // the control loop. Only real incoming traffic may advance last_seen.
    sql(`CREATE FUNCTION test_slow_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.agent_id='${created.id}' AND NEW.claimed THEN PERFORM pg_sleep(1.2); END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_slow_claim BEFORE UPDATE ON agent_transfers FOR EACH ROW EXECUTE FUNCTION test_slow_claim();
      INSERT INTO agent_transfers(id,token_hash,agent_id,request,expires_at) SELECT gen_random_uuid(),gen_random_uuid()::text,'${created.id}','{}',now()+interval '1 minute' FROM generate_series(1,16)`);
    // Use a faster cadence than the production Agent so the unchanged five-second
    // bound measures receive-loop responsiveness, not the heartbeat interval.
    const heartbeat = setInterval(() => {
      if (agent.ws.readyState === WebSocket.OPEN)
        agent.ws.send(JSON.stringify({ type: "HEARTBEAT" }));
    }, 1000);
    try {
      for (let n = 0; n < 16; n++) {
        await agent.wait("TRANSFER");
        assert.equal(
          sql(
            `SELECT now()-last_seen < interval '5 seconds' FROM agents WHERE id='${created.id}'`,
          ),
          "t",
          "transfer backlog must not starve heartbeat",
        );
      }
    } finally {
      clearInterval(heartbeat);
      sql(
        "DROP TRIGGER test_slow_claim ON agent_transfers; DROP FUNCTION test_slow_claim()",
      );
    }
    agent.ws.terminate();
    const closed = new Promise((r) => agent.ws.once("close", r));
    await closed;
    sql(
      `INSERT INTO agent_transfers(id,token_hash,agent_id,request,expires_at) SELECT gen_random_uuid(),gen_random_uuid()::text,'${created.id}','{}',now()+interval '1 minute' FROM generate_series(1,100)`,
    );
    agent = await agentSocket();
    await agent.wait("TRANSFER");
    agent.ws.terminate();
    await delay(350);
    assert.ok(
      Number(
        sql(
          `SELECT count(*) FROM agent_transfers WHERE agent_id='${created.id}' AND NOT claimed`,
        ),
      ) > 0,
      "unsent transfers remain deliverable",
    );
    console.log(
      "PASS: 10001-item multi-MiB paged index, Ping/Pong, live heartbeat, partial rollback, removal reconciliation and unsent transfers",
    );
  } finally {
    clearInterval(indexHeartbeat);
    if (releasePublish) await releasePublish();
    agent.ws.terminate();
    await admin.request(`/agents/${created.id}`, "DELETE");
  }
}
