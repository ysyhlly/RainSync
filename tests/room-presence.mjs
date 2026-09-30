import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";

let fixture;
const report = {
  schema_version: 1,
  result: "running",
  checks: [],
  scope:
    "Reported presence v1 on real isolated PostgreSQL and WebSockets; no sustained/device acceptance claim",
};
try {
  await isolatedServer("room-presence", async (f) => {
    fixture = f;
    const admin = f.client();
    const owner = await admin.login();
    await admin.request("/users", "POST", {
      username: "presence-viewer",
      password: f.password,
    });
    const viewerA = f.client(),
      viewerB = f.client();
    const viewer = await viewerA.login("presence-viewer", f.password);
    await viewerB.login("presence-viewer", f.password);
    const room = await admin.request("/rooms", "POST", {
      name: "reported presence",
    });
    const invite = await admin.request(`/rooms/${room.id}/invites`, "POST");
    await viewerA.request(`/rooms/${room.id}/join`, "POST", {
      token: invite.token,
    });
    const sockets = new Set();
    const revision = () =>
      Number(
        f.sql(
          `SELECT (state->>'revision')::bigint FROM room_snapshots WHERE room_id='${room.id}'`,
        ),
      );
    const online = (snapshot, user) =>
      snapshot.members.find((member) => member.user_id === user)
        ?.connection_count ?? 0;
    const connect = async (
      client,
      {
        version = 1,
        autoPong = true,
        initialType = "SNAPSHOT",
        connectionId,
      } = {},
    ) => {
      const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
        headers: { Origin: f.origin, Cookie: client.cookie },
        autoPong,
      });
      sockets.add(ws);
      const frames = [];
      ws.on("message", (bytes) => {
        const frame = JSON.parse(bytes);
        if (frames.length >= 256) frames.shift();
        frames.push(frame);
      });
      ws.on("error", () => {});
      await new Promise((done, reject) => {
        ws.once("open", done);
        ws.once("error", reject);
      });
      const send = (frame) => ws.send(JSON.stringify(frame));
      const next = async (type, predicate = () => true, timeout = 10000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const index = frames.findIndex(
            (frame) => frame.type === type && predicate(frame),
          );
          if (index >= 0) return frames.splice(index, 1)[0];
          await delay(10);
        }
        throw Error(
          `Missing ${type}; observed=${frames.map((frame) => frame.type + (frame.error ? ":" + frame.error.code : "")).join(",")}`,
        );
      };
      send({
        type: "RESUME",
        room_id: room.id,
        revision: 0,
        ...(version === undefined || version === null
          ? {}
          : { presence_version: version }),
        presence_connection_id: connectionId,
      });
      const initial = await next(initialType);
      return { ws, frames, send, next, initial };
    };
    const stop = async (socket) => {
      if (socket.ws.readyState === WebSocket.CLOSED) return;
      const closed = new Promise((done) => socket.ws.once("close", done));
      socket.ws.close();
      await closed;
    };
    try {
      const monitor = await connect(admin);
      const initialRevision = revision();
      assert.equal(online(monitor.initial.presence, owner.id), 1);
      assert.match(monitor.initial.presence_connection_id, /^[0-9a-f-]{36}$/);
      assert.deepEqual(Object.keys(monitor.initial.presence).sort(), [
        "members",
        "presence_epoch",
        "presence_seq",
        "room_id",
      ]);
      const legacy = [];
      for (let index = 0; index < 100; index++) {
        const socket = await connect(admin, { version: null });
        assert.equal(socket.initial.presence, undefined);
        assert.equal(socket.initial.presence_connection_id, undefined);
        legacy.push(socket);
      }
      const unsupported = await connect(admin, { version: 2 });
      assert.equal(unsupported.initial.presence, undefined);
      const same = await connect(admin, {
        connectionId: monitor.initial.presence_connection_id,
      });
      assert.notEqual(
        same.initial.presence_connection_id,
        monitor.initial.presence_connection_id,
      );
      assert.equal(online(same.initial.presence, owner.id), 2);
      await monitor.next(
        "PRESENCE_SNAPSHOT",
        (frame) => online(frame, owner.id) === 2,
      );
      assert.equal(revision(), initialRevision);
      assert.ok(
        legacy.every(
          (socket) =>
            !socket.frames.some((frame) => frame.type === "PRESENCE_SNAPSHOT"),
        ),
      );
      const legacyClock = randomUUID();
      legacy[0].send({ type: "CLOCK_SYNC", t1: legacyClock });
      await legacy[0].next(
        "CLOCK_SYNC_REPLY",
        (frame) => frame.t1 === legacyClock,
      );
      report.checks.push(
        "100 legacy control connections remain admitted, receive no presence, and do not consume v1 quota; unsupported version remains legacy; forged connection ID is not reused",
      );

      const capped = [monitor, same];
      for (let index = capped.length; index < 8; index++)
        capped.push(await connect(admin));
      const denied = await connect(admin, { initialType: "ERROR" });
      assert.equal(denied.initial.error.code, "RATE_LIMITED");
      assert.ok(!denied.frames.some((frame) => frame.type === "SNAPSHOT"));
      assert.equal(revision(), initialRevision);
      await stop(capped.pop());
      const reclaimed = await connect(admin);
      assert.equal(online(reclaimed.initial.presence, owner.id), 8);
      capped.push(reclaimed);
      for (const socket of [...capped.slice(1), ...legacy, unsupported])
        await stop(socket);
      await monitor.next(
        "PRESENCE_SNAPSHOT",
        (frame) =>
          frame.presence_seq > reclaimed.initial.presence.presence_seq &&
          online(frame, owner.id) === 1,
      );
      report.checks.push(
        "v1 per-user cap is bounded and explicit; normal disconnect releases quota; admission/join/leave does not change control revision",
      );

      const a = await connect(viewerA),
        b = await connect(viewerB);
      const two = await monitor.next(
        "PRESENCE_SNAPSHOT",
        (frame) =>
          frame.presence_seq >= b.initial.presence.presence_seq &&
          online(frame, viewer.id) === 2,
      );
      a.send({
        type: "CLIENT_STATUS",
        status: { buffering: false, drift_ms: 0 },
      });
      await monitor.next(
        "CLIENT_STATUS",
        (frame) => frame.user_id === viewer.id,
      );
      const marker = randomUUID();
      a.send({
        type: "PRESENCE_SNAPSHOT",
        room_id: room.id,
        presence_epoch: two.presence_epoch,
        presence_seq: 999999,
        members: [{ user_id: marker, connection_count: 8 }],
      });
      assert.equal((await a.next("ERROR")).error.code, "INVALID_REQUEST");
      await stop(a);
      const one = await monitor.next(
        "PRESENCE_SNAPSHOT",
        (frame) =>
          frame.presence_seq > two.presence_seq &&
          online(frame, viewer.id) === 1,
      );
      assert.ok(one.presence_seq > two.presence_seq);
      const again = await connect(viewerA);
      assert.notEqual(
        again.initial.presence_connection_id,
        a.initial.presence_connection_id,
      );
      assert.equal(online(again.initial.presence, viewer.id), 2);
      assert.equal(
        f.sql(
          `SELECT count(*) FROM room_members WHERE room_id='${room.id}' AND user_id='${viewer.id}'`,
        ),
        "1",
      );
      assert.equal(revision(), initialRevision);
      assert.ok(
        !monitor.frames.some((frame) =>
          frame.members?.some((member) => member.user_id === marker),
        ),
      );
      report.checks.push(
        "multiple login sessions aggregate by user, disconnect is per connection, resume assigns a new ID, permanent membership is retained, CLIENT_STATUS and forged snapshots cannot establish presence",
      );

      await viewerA.request("/auth/logout", "POST");
      const expiredMarker = randomUUID();
      again.send({ type: "CLOCK_SYNC", t1: expiredMarker });
      assert.equal((await again.next("ERROR")).error.code, "SESSION_EXPIRED");
      assert.ok(
        !again.frames.some(
          (frame) =>
            frame.type === "CLOCK_SYNC_REPLY" && frame.t1 === expiredMarker,
        ),
      );
      await monitor.next(
        "PRESENCE_SNAPSHOT",
        (frame) =>
          frame.presence_seq > again.initial.presence.presence_seq &&
          online(frame, viewer.id) === 1,
      );
      report.checks.push(
        "one revoked login session is removed before response admission; another session for the same member remains online",
      );

      await viewerA.login("presence-viewer", f.password);
      const a2 = await connect(viewerA);
      await monitor.next(
        "PRESENCE_SNAPSHOT",
        (frame) =>
          frame.presence_seq >= a2.initial.presence.presence_seq &&
          online(frame, viewer.id) === 2,
      );
      const tag = `presence-member-race-${randomUUID()}`;
      const removing = f.sqlProcess(
        `BEGIN; SELECT user_id FROM room_members WHERE room_id='${room.id}' AND user_id='${viewer.id}' FOR UPDATE; SELECT pg_sleep(0.8) /* ${tag} */; DELETE FROM room_members WHERE room_id='${room.id}' AND user_id='${viewer.id}'; COMMIT;`,
      );
      await f.waitForSql(
        `SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${tag}%'`,
        "1",
      );
      const joining = connect(admin);
      await f.waitForSql(
        "SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%admitted_presence%') THEN 1 ELSE 0 END",
        "1",
      );
      await removing.done;
      const trigger = await joining;
      const afterRemoval = await monitor.next(
        "PRESENCE_SNAPSHOT",
        (frame) =>
          frame.presence_seq > a2.initial.presence.presence_seq &&
          online(frame, viewer.id) === 0,
      );
      assert.equal(online(trigger.initial.presence, viewer.id), 0);
      for (const socket of [a2, b]) {
        const revokedMarker = randomUUID();
        if (socket.ws.readyState === WebSocket.OPEN)
          socket.send({ type: "CLOCK_SYNC", t1: revokedMarker });
        assert.equal((await socket.next("ERROR")).error.code, "NOT_A_MEMBER");
        assert.ok(
          !socket.frames.some(
            (frame) =>
              frame.type === "CLOCK_SYNC_REPLY" && frame.t1 === revokedMarker,
          ),
        );
      }
      assert.ok(afterRemoval.presence_seq > one.presence_seq);
      assert.equal(revision(), initialRevision);
      report.checks.push(
        "snapshot subject admission waits behind an actual membership deletion; after commit both sessions are excluded and revoked recipients receive no new state",
      );
      await stop(trigger);
      await viewerA.request(`/rooms/${room.id}/join`, "POST", {
        token: invite.token,
      });

      const unresponsive = await connect(viewerA, { autoPong: false });
      const started = Date.now();
      const chatter = setInterval(() => {
        if (unresponsive.ws.readyState === WebSocket.OPEN) {
          unresponsive.send({
            type: "CLIENT_STATUS",
            status: { buffering: false },
          });
          unresponsive.ws.pong("unsolicited-stale-probe");
        }
      }, 5000);
      try {
        await monitor.next(
          "PRESENCE_SNAPSHOT",
          (frame) =>
            frame.presence_seq >= unresponsive.initial.presence.presence_seq &&
            online(frame, viewer.id) === 1,
        );
        await monitor.next(
          "PRESENCE_SNAPSHOT",
          (frame) =>
            frame.presence_seq > unresponsive.initial.presence.presence_seq &&
            online(frame, viewer.id) === 0,
          50000,
        );
      } finally {
        clearInterval(chatter);
      }
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed >= 44000 && elapsed < 49000,
        `45-second lease expired after ${elapsed}ms`,
      );
      assert.equal(revision(), initialRevision);
      assert.equal(
        monitor.ws.readyState,
        WebSocket.OPEN,
        "valid Ping/Pong keeps the no-video witness online",
      );
      report.expiry_ms = elapsed;
      report.checks.push(
        "real 45-second lease expires despite CLIENT_STATUS and unsolicited Pong; independent valid Ping/Pong keeps another socket online without playback telemetry",
      );
      const epoch = monitor.initial.presence.presence_epoch;
      for (const ws of sockets) ws.terminate();
      await f.startServer();
      // Existing startup rotates the playback clock and increments revision
      // once. Capture that before any presence admission to isolate our effect.
      const restartRevision = revision();
      assert.equal(restartRevision, initialRevision + 1);
      const restarted = await connect(admin);
      assert.notEqual(restarted.initial.presence.presence_epoch, epoch);
      assert.equal(online(restarted.initial.presence, owner.id), 1);
      assert.equal(online(restarted.initial.presence, viewer.id), 0);
      assert.equal(revision(), restartRevision);
      report.checks.push(
        "process restart establishes a fresh epoch and empty prior presence; admission adds no revision beyond the existing playback-clock startup update",
      );
      report.result = "passed";
    } finally {
      for (const ws of sockets) ws.terminate();
    }
  });
} catch (error) {
  report.result = "failed";
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (fixture) {
    report.cleanup = await fixture.verifyStopped();
    report.postgres = fixture.postgresDiagnostics();
    await writeFile(
      resolve(fixture.root, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(`${report.result}: ${resolve(fixture.root, "report.json")}`);
    if (report.failure) console.error(report.failure);
  }
}
