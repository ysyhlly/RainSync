import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile, readFile, mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { verifyPidAbsent } from "./fixtures/postgres.mjs";

const expectStranded = process.argv.includes("--expect-stranded");
let fixture;
await isolatedServer(
  "server-preparation-drain",
  async (f) => {
    fixture = f;
    const client = f.client();
    await client.login();
    const source = await client.request("/sources", "POST", {
      name: "owned local probe",
      kind: "local",
      config: { root: f.root },
    });
    const media = randomUUID();
    f.sql(
      `INSERT INTO media_items(id,source_id,title,resource,metadata) VALUES('${media}','${source.id}','stalled local file','fixture.mp4','{}')`,
    );
    const room = await client.request("/rooms", "POST", {
      name: "graceful preparation owner",
    });
    f.sql(
      `UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media}"'),'{media_generation}','1') WHERE room_id='${room.id}'`,
    );
    const request = client
      .raw("/playback-candidates", {
        method: "POST",
        body: { room_id: room.id, media_generation: 1, position_ms: 0 },
        signal: AbortSignal.timeout(60000),
      })
      .catch(() => null);
    let pids;
    for (let i = 0; i < 100; i++) {
      try {
        pids = (await readFile(resolve(f.root, "probe.pids"), "utf8"))
          .trim()
          .split(/\s+/)
          .map(Number);
        break;
      } catch {}
      await delay(30);
    }
    assert.equal(pids?.length, 2, "real stalled probe tree started");
    assert.equal(
      f.sql(
        `SELECT count(*) FROM playback_preparations WHERE room_id='${room.id}' AND drained_at IS NULL`,
      ),
      "1",
    );
    const started = Date.now();
    await f.stopServer();
    await request;
    for (const pid of pids)
      assert.equal(
        verifyPidAbsent(pid),
        true,
        "probe tree positively reaped before process exit",
      );
    const drained = f.sql(
      `SELECT count(*) FROM playback_preparations WHERE room_id='${room.id}' AND drained_at IS NOT NULL`,
    );
    await f.startServer();
    const status = await client.request(`/rooms/${room.id}/lifecycle`);
    await client.request(`/rooms/${room.id}/close`, "POST", {
      expected_revision: status.state.revision,
    });
    if (expectStranded) {
      assert.equal(
        drained,
        "0",
        "baseline leaves durable preparation unacknowledged despite OS reaping",
      );
      await f.waitForSql(
        `SELECT last_error FROM room_cleanup_tasks WHERE room_id='${room.id}'`,
        "playback_preparation_drain_unconfirmed",
      );
      assert.equal(
        f.sql(`SELECT lifecycle FROM rooms WHERE id='${room.id}'`),
        "closing",
      );
      console.log(
        `REPRODUCED: normal SIGTERM reaped probe tree but stranded preparation receipt after ${Date.now() - started}ms; restart then close remains closing`,
      );
    } else {
      assert.equal(
        drained,
        "1",
        "graceful stop persisted positive drain receipt before exit",
      );
      await f.waitForSql(
        `SELECT lifecycle FROM rooms WHERE id='${room.id}'`,
        "closed",
        15000,
      );
      console.log(
        "PASS: stalled local candidate probe cancelled, tree reaped, durable receipt persisted before graceful exit; restart then room close completes",
      );
      async function makeRoom(label) {
        const next = await client.request("/rooms", "POST", { name: label });
        f.sql(
          `UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media}"'),'{media_generation}','1') WHERE room_id='${next.id}'`,
        );
        return next;
      }
      const begin = (room) =>
        client
          .raw("/playback-candidates", {
            method: "POST",
            body: { room_id: room.id, media_generation: 1, position_ms: 0 },
            signal: AbortSignal.timeout(60000),
          })
          .catch(() => null);
      async function closeRoom(room) {
        const state = await client.request(`/rooms/${room.id}/lifecycle`);
        await client.request(`/rooms/${room.id}/close`, "POST", {
          expected_revision: state.state.revision,
        });
        await f.waitForSql(
          `SELECT lifecycle FROM rooms WHERE id='${room.id}'`,
          "closed",
          15000,
        );
      }
      async function hold(query) {
        const tag = `preparation-drain-${randomUUID()}`;
        const holder = f.sqlProcess(
          `BEGIN; ${query}; SELECT pg_sleep(120) /* ${tag} */; COMMIT`,
        );
        await f.waitForSql(
          `SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${tag}%'`,
          "1",
        );
        return async () => {
          f.sql(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${tag}%'`,
          );
          await holder.done.catch(() => {});
        };
      }

      // A reservation admitted synchronously before SIGTERM can still be waiting
      // to acquire its durable room lock. Shutdown must not abort its commit or
      // start a source after that lock becomes available.
      const lateRoom = await makeRoom("late durable reservation");
      await unlink(resolve(f.root, "probe.pids"));
      const releaseAdmission = await hold(
        `SELECT id FROM rooms WHERE id='${lateRoom.id}' FOR NO KEY UPDATE`,
      );
      const lateRequest = begin(lateRoom);
      await f.waitForSql(
        "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT lifecycle,lifecycle_epoch FROM rooms%'",
        "1",
      );
      let lateExited = false;
      const lateStop = f.stopServer().then(() => {
        lateExited = true;
      });
      try {
        await delay(11000);
        assert.equal(
          lateExited,
          false,
          "shutdown retains an admitted but uncommitted reservation beyond HTTP grace",
        );
      } finally {
        await releaseAdmission();
      }
      await lateStop;
      await lateRequest;
      assert.equal(
        f.sql(
          `SELECT count(*) FROM playback_preparations WHERE room_id='${lateRoom.id}' AND drained_at IS NOT NULL`,
        ),
        "1",
      );
      await assert.rejects(readFile(resolve(f.root, "probe.pids")), {
        code: "ENOENT",
      });
      await f.startServer();
      await closeRoom(lateRoom);
      console.log(
        "PASS: pre-signal admission waits for its DB commit beyond HTTP grace, observes already-raised cancellation, starts no probe, and persists its receipt",
      );

      // Force one transient ACK failure, then hold the exact receipt row through
      // shutdown. A detached retry must retain registry ownership until COMMIT.
      const ackRoom = await makeRoom("delayed durable acknowledgement");
      const ackRequest = begin(ackRoom);
      await f.waitForSql(
        `SELECT count(*) FROM playback_preparations WHERE room_id='${ackRoom.id}'`,
        "1",
      );
      let ackPids;
      for (let i = 0; i < 100; i++) {
        try {
          ackPids = (await readFile(resolve(f.root, "probe.pids"), "utf8"))
            .trim()
            .split(/\s+/)
            .map(Number);
          break;
        } catch {}
        await delay(30);
      }
      assert.equal(ackPids?.length, 2);
      f.sql(
        `CREATE SEQUENCE fixture_ack_attempts; CREATE FUNCTION fixture_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('fixture_ack_attempts')=1 THEN RAISE EXCEPTION 'fixture transient ACK failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_ack_failure BEFORE UPDATE ON playback_preparations FOR EACH ROW EXECUTE FUNCTION fixture_ack_failure()`,
      );
      const releaseAck = await hold(
        `SELECT session_id FROM playback_preparations WHERE room_id='${ackRoom.id}' FOR UPDATE`,
      );
      let ackExited = false;
      const ackStop = f.stopServer().then(() => {
        ackExited = true;
      });
      try {
        await f.waitForSql(
          "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE playback_preparations SET drained_at%'",
          "1",
        );
        for (const pid of ackPids)
          assert.equal(
            verifyPidAbsent(pid),
            true,
            "receipt only starts after real process-tree drain",
          );
        await delay(11000);
        assert.equal(
          ackExited,
          false,
          "shutdown retains detached receipt through DB contention beyond HTTP grace",
        );
        assert.equal(
          f.sql(
            `SELECT drained_at IS NULL FROM playback_preparations WHERE room_id='${ackRoom.id}'`,
          ),
          "t",
        );
      } finally {
        await releaseAck();
      }
      await ackStop;
      await ackRequest;
      assert.equal(
        f.sql("SELECT last_value FROM fixture_ack_attempts"),
        "2",
        "transient ACK failure was retried",
      );
      assert.equal(
        f.sql(
          `SELECT count(*) FROM playback_preparations WHERE room_id='${ackRoom.id}' AND drained_at IS NOT NULL`,
        ),
        "1",
      );
      f.sql(
        "DROP TRIGGER fixture_ack_failure ON playback_preparations; DROP FUNCTION fixture_ack_failure(); DROP SEQUENCE fixture_ack_attempts",
      );
      await f.startServer();
      await closeRoom(ackRoom);
      console.log(
        "PASS: scoped process tree is positively reaped before ACK; graceful exit waits through row lock and transient ACK failure until durable receipt commits",
      );
      // This real stalled HTTP peer owns no external media resource. Its socket
      // closure is a local observation, never a forged Worker/Agent receipt.
      const offers = [];
      const peer = createServer((request, response) => {
        const offer = {
          path: new URL(request.url, "http://fixture").pathname,
          closed: false,
        };
        offers.push(offer);
        response.on("close", () => {
          offer.closed = true;
        });
      });
      await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
      const peerOrigin = `http://127.0.0.1:${peer.address().port}`;
      try {
        await f.startServer({ WORKER_URL: peerOrigin });
        const httpSource = await client.request("/sources", "POST", {
          name: "owned stalled HTTP source",
          kind: "http",
          config: { url: peerOrigin + "/media.mp4" },
        });
        const httpMedia = randomUUID();
        f.sql(
          `INSERT INTO media_items(id,source_id,title,resource,metadata) VALUES('${httpMedia}','${httpSource.id}','stalled HTTP file','media.mp4','{}')`,
        );
        for (const crash of [false, true]) {
          const httpRoom = await makeRoom(
            crash ? "crash is unknown" : "graceful HTTP owner",
          );
          f.sql(
            `UPDATE room_snapshots SET state=jsonb_set(state,'{media_id}','"${httpMedia}"') WHERE room_id='${httpRoom.id}'`,
          );
          const count = offers.length;
          const playback = client
            .raw("/playback-sessions", {
              method: "POST",
              body: {
                room_id: httpRoom.id,
                media_generation: 1,
                position_ms: 0,
                mode: "auto",
                idempotency_key: randomUUID(),
              },
              signal: AbortSignal.timeout(60000),
            })
            .catch(() => null);
          for (let i = 0; i < 100 && offers.length === count; i++)
            await delay(30);
          assert.equal(
            offers.length,
            count + 1,
            "Server dispatched real HTTP probe request",
          );
          await f.stopServer({ signal: crash ? "SIGKILL" : "SIGTERM" });
          await playback;
          for (let i = 0; i < 100 && !offers[count].closed; i++)
            await delay(30);
          assert.equal(
            offers[count].closed,
            true,
            "stalled probe response socket closed",
          );
          assert.equal(
            f.sql(
              `SELECT drained_at IS NOT NULL FROM playback_preparations WHERE room_id='${httpRoom.id}'`,
            ),
            crash ? "f" : "t",
          );
          await f.startServer({ WORKER_URL: peerOrigin });
          if (crash) {
            const state = await client.request(
              `/rooms/${httpRoom.id}/lifecycle`,
            );
            await client.request(`/rooms/${httpRoom.id}/close`, "POST", {
              expected_revision: state.state.revision,
            });
            await f.waitForSql(
              `SELECT last_error FROM room_cleanup_tasks WHERE room_id='${httpRoom.id}'`,
              "playback_preparation_drain_unconfirmed",
            );
            assert.equal(
              f.sql(`SELECT lifecycle FROM rooms WHERE id='${httpRoom.id}'`),
              "closing",
            );
            console.log(
              "PASS: genuine SIGKILL leaves preparation unknown across restart and room close; socket closure alone cannot forge an owner receipt",
            );
          } else {
            await closeRoom(httpRoom);
            console.log(
              "PASS: stalled HTTP playback preparation cancels its socket, commits drain receipt before graceful exit, and closes after restart",
            );
          }
        }
      } finally {
        peer.closeAllConnections();
        await new Promise((resolve) => peer.close(resolve));
      }
    }
  },
  {
    beforeStart: async (f) => {
      const bin = resolve(f.root, "bin");
      await mkdir(bin);
      await writeFile(resolve(f.root, "fixture.mp4"), "probe input fixture");
      await writeFile(
        resolve(bin, "ffprobe"),
        `#!/bin/sh\nsleep 120 &\nleaf=$!\nprintf '%s\\n%s\\n' "$$" "$leaf" > '${f.root}/probe.pids'\nwait "$leaf"\n`,
        { mode: 0o755 },
      );
      f.env.PATH = bin + ":" + f.env.PATH;
    },
  },
);
const cleanup = await fixture.verifyStopped();
assert.equal(cleanup.completed, true);
const report = resolve(fixture.root, "report.json");
await writeFile(
  report,
  JSON.stringify(
    {
      schema_version: 1,
      baseline_reproduction: expectStranded,
      completed_at: new Date().toISOString(),
      postgres: fixture.postgresDiagnostics(),
      cleanup,
    },
    null,
    2,
  ),
);
console.log(`Evidence: ${report}`);
