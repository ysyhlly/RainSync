// Owned room REST/WebSocket authorization fixtures only. No Agent or receipts.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.ok(
  process.env.W03_BACKEND_BINDING,
  "A successful source-bound backend build is required",
);
const binding = JSON.parse(await readFile(process.env.W03_BACKEND_BINDING));
assert.equal(binding.result, "passed");
const coordinatorSha = digest(await readFile(fileURLToPath(import.meta.url)));
async function unchanged() {
  for (const entry of binding.source)
    assert.equal(
      digest(await readFile(resolve(root, entry.path))),
      entry.sha256,
      entry.path,
    );
  for (const entry of binding.binaries)
    assert.equal(digest(await readFile(entry.path)), entry.sha256, entry.name);
  assert.equal(
    digest(await readFile(fileURLToPath(import.meta.url))),
    coordinatorSha,
  );
}
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;
const report = {
  schema_version: 1,
  result: "running",
  source_digest: binding.source_digest,
  coordinator_sha256: coordinatorSha,
  checks: [],
  scope:
    "Owned PostgreSQL/REST/room-WebSocket authority only; no Agent task, physical browser, or live account",
};
let fixture;
await unchanged();
try {
  await isolatedServer("room-authority-consistency", async (f) => {
    fixture = f;
    const admin = f.client();
    await admin.login();
    let serial = 0;
    async function subject() {
      const username = `authority-${++serial}`;
      await admin.request("/users", "POST", { username, password: f.password });
      const client = f.client();
      const user = await client.login(username, f.password);
      const room = await client.request("/rooms", "POST", {
        name: "owned authority fixture",
      });
      return { client, user, room, username };
    }
    async function lock(sql) {
      const child = f.sqlProcess(undefined, { interactive: true });
      child.stdout.resume();
      child.stderr.resume();
      const marker = `authority-lock-${randomUUID()}`;
      child.stdin.write(`BEGIN; ${sql}; SELECT '${marker}';\n`);
      await f.waitForSql(
        `SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction' AND query LIKE '%${marker}%'`,
        "1",
      );
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const closed = new Promise((done) => child.once("close", done));
        child.stdin.end("ROLLBACK;\n\\q\n");
        await closed;
      };
    }
    const counts = (room) =>
      f.sql(`SELECT jsonb_build_array(
      (SELECT count(*) FROM invites WHERE room_id=${quote(room)}),
      (SELECT count(*) FROM invites WHERE room_id=${quote(room)} AND revoked),
      (SELECT count(*) FROM playlist_items WHERE room_id=${quote(room)}))`);
    async function operation(kind, s) {
      const prefix = `/rooms/${s.room.id}`;
      if (kind === "invite_create")
        return () => s.client.raw(`${prefix}/invites`, { method: "POST" });
      if (kind === "invite_revoke") {
        const invite = await s.client.request(`${prefix}/invites`, "POST");
        return () =>
          s.client.raw(`${prefix}/invites/${invite.token}`, {
            method: "DELETE",
          });
      }
      const media = sourceMedia(f, {
        kind: "local",
        root: f.root,
        resource: `owned-${randomUUID()}`,
      });
      if (kind === "playlist_add")
        return () =>
          s.client.raw(`${prefix}/playlist`, {
            method: "POST",
            body: { media_id: media },
          });
      const entry = await s.client.request(`${prefix}/playlist`, "POST", {
        media_id: media,
      });
      return () =>
        s.client.raw(`${prefix}/playlist/${entry.id}`, { method: "DELETE" });
    }
    for (const kind of [
      "invite_create",
      "invite_revoke",
      "playlist_add",
      "playlist_remove",
    ]) {
      for (const change of ["membership", "logout", "expiry", "demotion"]) {
        const s = await subject();
        if (change === "demotion") {
          // The acting administrator is a member but not the room owner.
          const controller = await subject();
          const invite = await controller.client.request(
            `/rooms/${controller.room.id}/invites`,
            "POST",
          );
          await s.client.request(`/rooms/${controller.room.id}/join`, "POST", {
            token: invite.token,
          });
          s.room = controller.room;
          f.sql(`UPDATE users SET admin=true WHERE id=${quote(s.user.id)}`);
        }
        const act = await operation(kind, s),
          before = counts(s.room.id);
        const release = await lock(
          `SELECT state FROM room_snapshots WHERE room_id=${quote(s.room.id)} FOR UPDATE`,
        );
        try {
          const response = act();
          await f.waitForSql(
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT state FROM room_snapshots%FOR UPDATE%'",
            "1",
          );
          if (change === "membership")
            f.sql(
              `DELETE FROM room_members WHERE room_id=${quote(s.room.id)} AND user_id=${quote(s.user.id)}`,
            );
          if (change === "logout")
            await s.client.request("/auth/logout", "POST");
          if (change === "expiry")
            f.sql(
              `UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=${quote(s.user.id)}`,
            );
          if (change === "demotion")
            f.sql(`UPDATE users SET admin=false WHERE id=${quote(s.user.id)}`);
          await release();
          const result = await response;
          const body = await result.json();
          assert.equal(
            result.status,
            ["logout", "expiry"].includes(change) ? 401 : 403,
            `${kind}/${change}: ${JSON.stringify(body)}`,
          );
          assert.equal(
            counts(s.room.id),
            before,
            "denial must roll back all mutation state",
          );
          report.checks.push({
            name: `${kind}/${change} during snapshot lock wait`,
            passed: true,
          });
        } finally {
          await release();
        }
      }
    }
    // Time can expire naturally after authority locks are acquired, while a
    // later write waits. The final commit gate must reject and roll back it.
    for (const kind of ["invite_create", "playlist_add"]) {
      const s = await subject();
      const act = await operation(kind, s),
        before = counts(s.room.id);
      f.sql(
        `UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE user_id=${quote(s.user.id)}`,
      );
      const table = kind === "invite_create" ? "invites" : "playlist_items";
      const release = await lock(`LOCK TABLE ${table} IN SHARE MODE`);
      try {
        const response = act();
        await f.waitForSql(
          `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO ${table}%'`,
          "1",
        );
        await f.waitForSql(
          `SELECT count(*) FROM sessions WHERE user_id=${quote(s.user.id)} AND expires_at<=clock_timestamp()`,
          "1",
        );
        await release();
        const result = await response;
        await result.arrayBuffer();
        assert.equal(result.status, 401);
        assert.equal(counts(s.room.id), before);
        report.checks.push({
          name: `${kind}/natural expiry during final write`,
          passed: true,
        });
      } finally {
        await release();
      }
    }
    const sockets = new Set();
    async function connect(client, room, type, presence) {
      const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
        headers: { Origin: f.origin, Cookie: client.cookie },
      });
      sockets.add(ws);
      const frames = [];
      let pinged = false;
      ws.on("message", (bytes) => {
        if (frames.length < 128) frames.push(JSON.parse(bytes));
      });
      ws.on("ping", () => {
        pinged = true;
      });
      ws.on("error", () => {});
      await new Promise((done, reject) => {
        ws.once("open", done);
        ws.once("error", reject);
      });
      const state = JSON.parse(
        f.sql(`SELECT state FROM room_snapshots WHERE room_id=${quote(room)}`),
      );
      ws.send(
        JSON.stringify({
          type,
          room_id: room,
          revision: state.revision,
          clock_epoch: state.clock_epoch,
          ...(presence ? { presence_version: 1 } : {}),
        }),
      );
      const next = async (type, timeout = 4000) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
          const index = frames.findIndex((frame) => frame.type === type);
          if (index >= 0) return frames.splice(index, 1)[0];
          await delay(10);
        }
        throw new Error(`Missing ${type}`);
      };
      await next("SNAPSHOT");
      const end = Date.now() + 3000;
      while (!pinged && Date.now() < end) await delay(10);
      assert.equal(
        pinged,
        true,
        "initial heartbeat completed before revocation",
      );
      return {
        ws,
        frames,
        next,
        send: (value) => ws.send(JSON.stringify(value)),
      };
    }
    try {
      for (const type of ["JOIN", "RESUME"])
        for (const presence of [false, true])
          for (const flow of ["inbound", "outbound"]) {
            const s = await subject();
            const other = f.client();
            await other.login(s.username, f.password);
            const a = await connect(s.client, s.room.id, type, presence);
            const b = await connect(other, s.room.id, "JOIN", false);
            await s.client.request("/auth/logout", "POST");
            const started = Date.now();
            if (flow === "inbound") a.send({ type: "CLOCK_SYNC", t1: 1 });
            else
              b.send({
                type: "CHAT",
                body: "owned surviving login",
                client_message_id: randomUUID(),
              });
            const denied = await a.next("ERROR");
            assert.equal(denied.error.code, "SESSION_EXPIRED");
            assert.ok(
              Date.now() - started < 5000,
              "revocation is checked before the next 15s heartbeat",
            );
            assert.equal(
              a.frames.some((frame) =>
                ["CLOCK_SYNC_REPLY", "CHAT"].includes(frame.type),
              ),
              false,
            );
            b.send({ type: "CLOCK_SYNC", t1: 2 });
            await b.next("CLOCK_SYNC_REPLY");
            a.ws.terminate();
            b.ws.terminate();
            report.checks.push({
              name: `${type}/${presence ? "presence" : "legacy"}/${flow} exact-login logout`,
              passed: true,
            });
          }
    } finally {
      for (const ws of sockets) ws.terminate();
    }
  });
  await unchanged();
  report.binding_unchanged = true;
  report.result = "passed";
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
  }
}
