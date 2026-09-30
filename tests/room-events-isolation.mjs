import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";

let ownedFixture;
await isolatedServer("room-events-isolation", async (f) => {
  ownedFixture = f;
  const admin = f.client();
  await admin.login();
  for (const username of ["owner", "viewer"])
    await admin.request("/users", "POST", { username, password: f.password });
  const owner = f.client(),
    viewer = f.client();
  await owner.login("owner", f.password);
  const viewerIdentity = await viewer.login("viewer", f.password);
  const room = await owner.request("/rooms", "POST", {
    name: "event isolation",
  });
  const invitation = await owner.request(`/rooms/${room.id}/invites`, "POST");
  await viewer.request(`/rooms/${room.id}/join`, "POST", {
    token: invitation.token,
  });
  const source = randomUUID(),
    media = randomUUID();
  f.sql(
    `INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','event fixture','local','fixture'); INSERT INTO media_items(id,source_id,title,resource,duration_ms) VALUES('${media}','${source}','event fixture','fixture',30000)`,
  );
  const sockets = new Set();
  async function connect(client, resume, initialType = "SNAPSHOT") {
    const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
      headers: { Origin: f.origin, Cookie: client.cookie },
    });
    sockets.add(ws);
    const frames = [];
    const statusMarkers = [];
    ws.on("message", (bytes) => {
      const value = JSON.parse(bytes);
      // Telemetry payloads are deliberately large; retain only control/chat
      // evidence so the test client is not itself an unbounded queue.
      if (value.type !== "CLIENT_STATUS") frames.push(value);
      else if (value.status.revoked_marker)
        statusMarkers.push(value.status.revoked_marker);
    });
    ws.on("error", () => {});
    await new Promise((done, reject) => {
      ws.once("open", done);
      ws.once("error", reject);
    });
    const send = (value) => ws.send(JSON.stringify(value));
    const next = async (type, predicate = () => true, timeout = 10000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const index = frames.findIndex(
          (value) => value.type === type && predicate(value),
        );
        if (index >= 0) return frames.splice(index, 1)[0];
        await delay(10);
      }
      throw new Error(`Missing ${type}: ${JSON.stringify(frames)}`);
    };
    send(resume ?? { type: "JOIN", room_id: room.id });
    const initial = await next(initialType);
    return {
      ws,
      send,
      next,
      frames,
      statusMarkers,
      initial,
      snapshot: initial,
    };
  }
  const persisted = () =>
    JSON.parse(
      f.sql(`SELECT state FROM room_snapshots WHERE room_id='${room.id}'`),
    );
  try {
    const controller = await connect(owner);
    const witness = await connect(viewer);
    let state = controller.snapshot.state;
    const submit = async (type, payload) => {
      const command = {
        protocol_version: 1,
        room_id: room.id,
        command_id: randomUUID(),
        control_epoch: controller.snapshot.control_epoch.id,
        expected_revision: state.revision,
        media_generation: state.media_generation,
        type,
        payload,
      };
      controller.send(command);
      state = (
        await controller.next("ACK", (v) => v.command_id === command.command_id)
      ).state;
      return command;
    };
    await submit("CHANGE_MEDIA", { media_id: media });
    const checkpoint = state;
    const slow = await connect(viewer);
    // Only this test-owned connection is paused. Several devices of the same
    // member fill its TCP/application delivery path while healthy peers proceed.
    slow.ws._socket.pause();
    const devices = await Promise.all(
      Array.from({ length: 6 }, () => connect(viewer)),
    );
    const body = "x".repeat(30000);
    for (let sequence = 0; sequence < 20; sequence++) {
      for (const device of devices)
        device.send({
          type: "CLIENT_STATUS",
          status: { fixture_payload: body, sequence },
        });
    }
    const began = Date.now();
    await submit("PAUSE");
    await witness.next("EVENT", (v) => v.state.revision === state.revision);
    const healthyControlMs = Date.now() - began;
    assert.ok(
      healthyControlMs < 5000,
      "healthy control must not wait for the slow peer's send deadline",
    );
    for (const device of devices) device.ws.terminate();
    slow.ws.terminate();
    await submit("SEEK", { position_ms: 2345.5 });
    const finalCommand = await submit("PLAY");
    const resume = {
      type: "RESUME",
      room_id: room.id,
      revision: checkpoint.revision,
      clock_epoch: checkpoint.clock_epoch,
    };
    const delta = await connect(viewer, resume);
    assert.equal(delta.snapshot.recovery, "delta");
    assert.deepEqual(
      delta.snapshot.events.map((event) => event.revision),
      [
        checkpoint.revision + 1,
        checkpoint.revision + 2,
        checkpoint.revision + 3,
      ],
    );
    assert.deepEqual(delta.snapshot.state, persisted());
    delta.ws.terminate();
    // Model the supported control-event retention gap only in this disposable
    // database. No cleanup, NAS, transfer or physical receipt history is touched.
    f.sql(
      `DELETE FROM room_events WHERE room_id='${room.id}' AND revision=${checkpoint.revision + 1}`,
    );
    const gap = await connect(viewer, resume);
    assert.equal(gap.snapshot.recovery, "snapshot");
    assert.deepEqual(gap.snapshot.events, []);
    assert.deepEqual(gap.snapshot.state, persisted());
    gap.ws.terminate();
    f.sql(
      `UPDATE control_epochs SET expires_at=now()-interval '1 second' WHERE id='${controller.snapshot.control_epoch.id}'`,
    );
    controller.send(finalCommand);
    const expired = await controller.next(
      "ERROR",
      (v) => v.command_id === finalCommand.command_id,
    );
    assert.equal(expired.error.code, "CONTROL_EPOCH_EXPIRED");
    controller.snapshot.control_epoch = expired.control_epoch;
    assert.equal(
      persisted().revision,
      state.revision,
      "an expired successful command cannot execute again",
    );
    const revoked = await connect(viewer);
    const statusDevice = await connect(viewer);
    const idleDevice = await connect(viewer);
    const lockTag = `event-member-lock-${randomUUID()}`;
    const removing = f.sqlProcess(
      `BEGIN; SELECT user_id FROM room_members WHERE room_id='${room.id}' AND user_id='${viewerIdentity.id}' FOR UPDATE; SELECT pg_sleep(2) /* ${lockTag} */; DELETE FROM room_members WHERE room_id='${room.id}' AND user_id='${viewerIdentity.id}'; COMMIT;`,
    );
    await f.waitForSql(
      `SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${lockTag}%'`,
      "1",
    );
    const chatId = randomUUID();
    revoked.send({
      type: "CHAT",
      body: "must not persist after member removal",
      client_message_id: chatId,
    });
    await f.waitForSql(
      "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT user_id FROM room_members%FOR KEY SHARE%'",
      "1",
    );
    await removing.done;
    assert.equal((await revoked.next("ERROR")).error.code, "NOT_A_MEMBER");
    assert.equal(
      f.sql(
        `SELECT count(*) FROM chat_messages WHERE client_message_id='${chatId}'`,
      ),
      "0",
    );
    const marker = randomUUID();
    statusDevice.send({
      type: "CLIENT_STATUS",
      status: { revoked_marker: marker },
    });
    assert.equal((await statusDevice.next("ERROR")).error.code, "NOT_A_MEMBER");
    const ownerChatId = randomUUID();
    controller.send({
      type: "CHAT",
      body: "not for the removed member",
      client_message_id: ownerChatId,
    });
    await controller.next("CHAT", (v) => v.client_message_id === ownerChatId);
    assert.equal(
      (await idleDevice.next("ERROR")).error.code,
      "NOT_A_MEMBER",
      "new owner chat is refused at outbound admission before the next heartbeat",
    );
    assert.ok(
      !idleDevice.frames.some(
        (v) => v.type === "CHAT" && v.client_message_id === ownerChatId,
      ),
    );
    assert.ok(
      !controller.statusMarkers.includes(marker),
      "removed member status cannot reach the owner",
    );
    await viewer.request(`/rooms/${room.id}/join`, "POST", {
      token: invitation.token,
    });
    const eventDevice = await connect(viewer);
    f.sql(
      `DELETE FROM room_members WHERE room_id='${room.id}' AND user_id='${viewerIdentity.id}'`,
    );
    await submit("PAUSE");
    assert.equal((await eventDevice.next("ERROR")).error.code, "NOT_A_MEMBER");
    assert.ok(
      !eventDevice.frames.some(
        (v) => v.type === "EVENT" && v.state.revision === state.revision,
      ),
    );
    await viewer.request(`/rooms/${room.id}/join`, "POST", {
      token: invitation.token,
    });
    const beforeEpochs = f.sql(
      `SELECT count(*) FROM control_epochs WHERE room_id='${room.id}' AND user_id='${viewerIdentity.id}'`,
    );
    const joinTag = `event-join-lock-${randomUUID()}`;
    const roomLock = f.sqlProcess(
      `BEGIN; SELECT id FROM rooms WHERE id='${room.id}' FOR UPDATE; SELECT pg_sleep(2) /* ${joinTag} */; COMMIT;`,
    );
    await f.waitForSql(
      `SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${joinTag}%'`,
      "1",
    );
    const joining = connect(viewer, undefined, "ERROR");
    await f.waitForSql(
      "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT owner_id,lifecycle,lifecycle_epoch FROM rooms%FOR NO KEY UPDATE%'",
      "1",
    );
    f.sql(
      `DELETE FROM room_members WHERE room_id='${room.id}' AND user_id='${viewerIdentity.id}'`,
    );
    await roomLock.done;
    const rejectedJoin = await joining;
    assert.equal(rejectedJoin.initial.error.code, "NOT_A_MEMBER");
    assert.ok(!rejectedJoin.frames.some((v) => v.type === "SNAPSHOT"));
    assert.equal(
      f.sql(
        `SELECT count(*) FROM control_epochs WHERE room_id='${room.id}' AND user_id='${viewerIdentity.id}'`,
      ),
      beforeEpochs,
      "a raced JOIN cannot issue a new control credential",
    );
    await viewer.request(`/rooms/${room.id}/join`, "POST", {
      token: invitation.token,
    });
    const fresh = await connect(viewer, resume);
    assert.deepEqual(fresh.snapshot.state, persisted());
    console.log(
      `PASS: slow test connection + 6-device telemetry flood, healthy control ${healthyControlMs}ms; contiguous delta and retention-gap snapshot end-state; old epoch refused; transactional chat/member removal race; revoked CLIENT_STATUS/CHAT/EVENT admission; JOIN/member removal race without snapshot or credential; fresh reconnect`,
    );
  } finally {
    for (const socket of sockets) socket.terminate();
  }
});
await ownedFixture.verifyStopped();
console.log(
  "PASS: owned Server/PostgreSQL processes stopped and loopback ports closed",
);
