import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";

let fixture;
const report = { schema_version: 1, result: "running", checks: [] };
try {
  await isolatedServer("room-presence-timeout", async (f) => {
    fixture = f;
    const admin = f.client();
    const owner = await admin.login();
    const room = await admin.request("/rooms", "POST", {
      name: "presence fail closed",
    });
    const sockets = [];
    const until = async (check, label, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await check()) return;
        await delay(20);
      }
      throw Error(label);
    };
    const connect = async () => {
      const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
        headers: { Origin: f.origin, Cookie: admin.cookie },
      });
      const frames = [];
      sockets.push(ws);
      ws.on("message", (bytes) => frames.push(JSON.parse(bytes)));
      ws.on("error", () => {});
      await new Promise((done, reject) => {
        ws.once("open", done);
        ws.once("error", reject);
      });
      ws.send(
        JSON.stringify({ type: "JOIN", room_id: room.id, presence_version: 1 }),
      );
      await until(
        () => frames.some((v) => v.type === "SNAPSHOT"),
        "negotiated handshake",
      );
      return { ws, frames };
    };
    try {
      const clients = [];
      for (let index = 0; index < 3; index++) clients.push(await connect());
      const blocker = f.sqlProcess(
        "BEGIN; LOCK TABLE room_members IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(7) /* presence-permission-timeout */; COMMIT;",
      );
      await f.waitForSql(
        "SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%presence-permission-timeout%'",
        "1",
      );
      const began = Date.now();
      for (const client of clients)
        client.ws.send(JSON.stringify({ type: "CLOCK_SYNC", t1: began }));
      await until(
        () =>
          clients.every((client) =>
            client.frames.some(
              (v) =>
                v.type === "ERROR" && v.error.code === "SERVICE_UNAVAILABLE",
            ),
          ),
        "negotiated checks fail closed",
      );
      assert.ok(Date.now() - began < 5000);
      assert.ok(
        clients.every(
          (client) =>
            !client.frames.some(
              (v) => v.type === "CLOCK_SYNC_REPLY" && v.t1 === began,
            ),
        ),
      );
      await admin.request("/auth/me");
      await until(
        async () =>
          (
            await fetch(f.origin + "/ready", {
              signal: AbortSignal.timeout(1000),
            })
          ).status === 200,
        "same pool recovers while lock is held",
      );
      assert.equal(
        f.sql(
          "SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%presence-permission-timeout%'",
        ),
        "1",
      );
      await blocker.done;
      const fresh = await connect();
      const initial = fresh.frames.find((v) => v.type === "SNAPSHOT");
      assert.deepEqual(initial.presence.members, [
        { user_id: owner.id, connection_count: 1 },
      ]);
      assert.equal(
        f.sql(
          `SELECT (state->>'revision')::bigint FROM room_snapshots WHERE room_id='${room.id}'`,
        ),
        "0",
      );
      report.checks.push(
        "negotiated sockets fail closed under real permission-table contention without admitting control replies; cancellation releases the shared pool before unlock; fresh handshake contains no abandoned leases and does not change revision",
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
