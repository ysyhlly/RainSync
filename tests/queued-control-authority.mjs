// Disposable Server/PostgreSQL room-control authority regressions only.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
assert.ok(process.env.W03_BACKEND_BINDING, "Source-bound build required");
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
async function until(check, name, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(10);
  }
  throw Error(`Timed out: ${name}`);
}
const report = {
  schema_version: 1,
  result: "running",
  source_digest: binding.source_digest,
  coordinator_sha256: coordinatorSha,
  checks: [],
  scope:
    "Owned real Server/PostgreSQL room commands, current roles and exact A/B logins; no media-ticket compatibility, Agent channel, browser or resource-drain claim",
};
let fixture;
await unchanged();
try {
  await isolatedServer("queued-control-authority", async (f) => {
    fixture = f;
    const admin = f.client();
    await admin.login();
    const sockets = new Set();
    let serial = 0;
    async function account() {
      const username = `queued-authority-${++serial}`;
      await admin.request("/users", "POST", { username, password: f.password });
      const a = f.client(),
        b = f.client();
      const user = await a.login(username, f.password);
      await b.login(username, f.password);
      const hash = digest(a.cookie.slice(a.cookie.indexOf("=") + 1));
      const bHash = digest(b.cookie.slice(b.cookie.indexOf("=") + 1));
      return { a, b, user, hash, bHash };
    }
    async function setup(owner = true, initialAdmin = true) {
      const s = await account();
      const controller = owner ? s : await account();
      s.room = (
        await controller.a.request("/rooms", "POST", {
          name: "owned queued control",
        })
      ).id;
      const invite = await controller.a.request(
        `/rooms/${s.room}/invites`,
        "POST",
      );
      if (!owner)
        await s.a.request(`/rooms/${s.room}/join`, "POST", {
          token: invite.token,
        });
      await admin.request(`/rooms/${s.room}/join`, "POST", {
        token: invite.token,
      });
      f.sql(
        `UPDATE users SET admin=${initialAdmin} WHERE id=${quote(s.user.id)}`,
      );
      s.media = sourceMedia(f, {
        kind: "local",
        root: f.root,
        resource: `owned-${randomUUID()}`,
      });
      // Explicit owned timeline seed, before any socket/actor is started.
      f.sql(
        `UPDATE room_snapshots SET state=jsonb_set(state,'{media_id}',to_jsonb(${quote(s.media)}::text)) WHERE room_id=${quote(s.room)}`,
      );
      return s;
    }
    async function connect(client, room, presence = false) {
      const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
        headers: { Origin: f.origin, Cookie: client.cookie },
      });
      sockets.add(ws);
      const frames = [];
      ws.on("error", () => {});
      ws.on("message", (data) => {
        assert.ok(frames.length < 128, "bounded owned socket frames");
        frames.push(JSON.parse(data));
      });
      await new Promise((done, fail) => {
        ws.once("open", done);
        ws.once("error", fail);
      });
      const next = (type, predicate = () => true) =>
        until(() => {
          const index = frames.findIndex(
            (v) => v.type === type && predicate(v),
          );
          return index < 0 ? undefined : frames.splice(index, 1)[0];
        }, `socket ${type}`);
      const send = (value) => ws.send(JSON.stringify(value));
      send({
        type: "JOIN",
        room_id: room,
        ...(presence ? { presence_version: 1 } : {}),
      });
      return { ws, frames, next, send, initial: await next("SNAPSHOT") };
    }
    async function lock(sql) {
      const child = f.sqlProcess(undefined, { interactive: true });
      child.stdout.resume();
      child.stderr.resume();
      const marker = `queued-authority-${randomUUID()}`;
      child.stdin.write(`BEGIN; ${sql}; SELECT '${marker}';\n`);
      await f.waitForSql(
        `SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction' AND query LIKE '%${marker}%'`,
        "1",
      );
      let released = false;
      return async (change = "") => {
        if (released) return;
        released = true;
        const closed = new Promise((done) => child.once("close", done));
        child.stdin.end(`${change ? `${change}; COMMIT` : "ROLLBACK"};\n\\q\n`);
        await closed;
        assert.equal(child.exitCode, 0, "owned lock transaction released");
      };
    }
    const waitBlocked = (prefix) =>
      f.waitForSql(
        `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE ${quote(prefix + "%")}`,
        "1",
      );
    const snapshot = (s) =>
      JSON.parse(
        f.sql(
          `SELECT state FROM room_snapshots WHERE room_id=${quote(s.room)}`,
        ),
      );
    const durable = (s) =>
      f.sql(`SELECT jsonb_build_array(
      (SELECT state FROM room_snapshots WHERE room_id=${quote(s.room)}),
      (SELECT count(*) FROM command_results WHERE room_id=${quote(s.room)}),
      (SELECT count(*) FROM room_events WHERE room_id=${quote(s.room)}),
      (SELECT count(*) FROM playlist_items WHERE room_id=${quote(s.room)}))`);
    const command = (
      socket,
      s,
      state = snapshot(s),
      type = "SET_RATE",
      payload = { rate: 1.25 },
    ) => ({
      protocol_version: 1,
      room_id: s.room,
      command_id: randomUUID(),
      control_epoch: socket.initial.control_epoch.id,
      expected_revision: state.revision,
      media_generation: state.media_generation,
      type,
      ...(["PAUSE", "PLAY"].includes(type) ? {} : { payload }),
    });
    function recorded(s, cmd, expectedAdmin) {
      const event = JSON.parse(
        f.sql(
          `SELECT diagnostic FROM room_events WHERE room_id=${quote(s.room)} AND revision=${cmd.expected_revision + 1}`,
        ),
      );
      assert.equal(event.actor_id, s.user.id);
      assert.equal(event.actor_is_admin, expectedAdmin);
      assert.equal(event.operation.command.command_id, cmd.command_id);
      const saved = JSON.parse(
        f.sql(
          `SELECT state FROM command_results WHERE room_id=${quote(s.room)} AND command_id=${quote(cmd.command_id)}`,
        ),
      );
      assert.deepEqual(
        saved,
        snapshot(s),
        "ACK result, diagnostic and committed snapshot agree",
      );
    }
    async function denied(s, socket, cmd, code, before) {
      const frame = await socket.next("ERROR", (v) => v.error.code === code);
      assert.equal(frame.error.code, code);
      assert.equal(
        durable(s),
        before,
        "rejected command leaves no durable transition",
      );
      assert.equal(
        f.sql(
          `SELECT count(*) FROM command_results WHERE command_id=${quote(cmd.command_id)}`,
        ),
        "0",
      );
      assert.equal(
        socket.frames.some(
          (v) => v.type === "ACK" && v.command_id === cmd.command_id,
        ),
        false,
      );
    }
    async function survived(s, socket) {
      assert.equal(
        f.sql(
          `SELECT count(*) FROM sessions WHERE token_hash=${quote(s.bHash)} AND expires_at>clock_timestamp()`,
        ),
        "1",
      );
      const cmd = command(socket, s);
      socket.send(cmd);
      await socket.next("ACK", (v) => v.command_id === cmd.command_id);
      recorded(s, cmd, false);
    }
    const changeSql = (s, change) =>
      change === "logout"
        ? `DELETE FROM sessions WHERE token_hash=${quote(s.hash)}`
        : change === "expiry"
          ? `UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=${quote(s.hash)}`
          : `UPDATE users SET admin=${change === "promotion"} WHERE id=${quote(s.user.id)}`;
    try {
      // A command demonstrably queued behind another user's admitted transition
      // must use fresh role/login authority once it leaves the actor queue.
      for (const presence of [false, true]) {
        for (const change of [
          "demotion",
          "owner_demotion",
          "promotion",
          "logout",
          "expiry",
        ]) {
          const owner = change !== "demotion" && change !== "promotion";
          const s = await setup(
            owner,
            !["promotion", "logout", "expiry"].includes(change),
          );
          const a = await connect(s.a, s.room, presence),
            b = await connect(s.b, s.room);
          const blocker = await connect(admin, s.room);
          const release = await lock("LOCK TABLE room_events IN SHARE MODE");
          try {
            const head = command(blocker, s, snapshot(s), "PAUSE", undefined);
            blocker.send(head);
            await waitBlocked("INSERT INTO room_events");
            const initial = snapshot(s);
            const cmd = command(a, s, {
              ...initial,
              revision: initial.revision + 1,
            });
            a.send(cmd);
            await until(async () => {
              const response = await admin.raw("/metrics");
              assert.equal(response.status, 200);
              return /^rainsync_control_queue_depth 1$/m.test(
                await response.text(),
              );
            }, "exactly one actor-queued command");
            if (change === "logout") await s.a.request("/auth/logout", "POST");
            else f.sql(changeSql(s, change));
            await release();
            await blocker.next("ACK", (v) => v.command_id === head.command_id);
            const accepted = ["owner_demotion", "promotion"].includes(change);
            if (accepted) {
              await a.next("ACK", (v) => v.command_id === cmd.command_id);
              assert.equal(snapshot(s).revision, initial.revision + 2);
              recorded(s, cmd, change === "promotion");
            } else {
              await a.next(
                "ERROR",
                (v) =>
                  v.error.code ===
                  (change === "demotion"
                    ? "CONTROLLER_REQUIRED"
                    : "SESSION_EXPIRED"),
              );
              assert.equal(snapshot(s).revision, initial.revision + 1);
              assert.equal(
                f.sql(
                  `SELECT count(*) FROM command_results WHERE command_id=${quote(cmd.command_id)}`,
                ),
                "0",
              );
              assert.equal(
                f.sql(
                  `SELECT count(*) FROM room_events WHERE room_id=${quote(s.room)}`,
                ),
                "1",
              );
              if (["logout", "expiry"].includes(change)) await survived(s, b);
            }
            report.checks.push({
              name: `actor queue/${presence ? "presence" : "legacy"}/${change}`,
              passed: true,
            });
          } finally {
            await release();
            a.ws.terminate();
            b.ws.terminate();
            blocker.ws.terminate();
          }
        }
      }
      // Both the shared snapshot/replay wait and the final commit's own
      // role/session waits must reject authorization changed during the wait.
      for (const [gate, change] of [
        ["snapshot", "demotion"],
        ["snapshot", "owner_demotion"],
        ["snapshot", "logout"],
        ["snapshot", "expiry"],
        ["role", "demotion"],
        ["role", "owner_demotion"],
        ["role", "promotion"],
        ["session", "logout"],
        ["session", "expiry"],
      ]) {
        const s = await setup(
          change !== "demotion" && change !== "promotion",
          !["promotion", "logout", "expiry"].includes(change),
        );
        const a = await connect(s.a, s.room),
          b = await connect(s.b, s.room, true);
        const sql =
          gate === "snapshot"
            ? `SELECT state FROM room_snapshots WHERE room_id=${quote(s.room)} FOR UPDATE`
            : gate === "role"
              ? `SELECT admin FROM users WHERE id=${quote(s.user.id)} FOR UPDATE`
              : `SELECT user_id FROM sessions WHERE token_hash=${quote(s.hash)} FOR UPDATE`;
        const release = await lock(sql);
        const before = durable(s),
          cmd = command(a, s);
        try {
          a.send(cmd);
          await waitBlocked(
            gate === "snapshot"
              ? "SELECT room_id FROM room_snapshots"
              : gate === "role"
                ? "SELECT admin FROM users"
                : "SELECT user_id FROM sessions",
          );
          if (gate === "snapshot") {
            if (change === "logout") await s.a.request("/auth/logout", "POST");
            else f.sql(changeSql(s, change));
            await release();
          } else await release(changeSql(s, change));
          if (["owner_demotion", "promotion"].includes(change)) {
            await a.next("ACK", (v) => v.command_id === cmd.command_id);
            recorded(s, cmd, change === "promotion");
          } else {
            await denied(
              s,
              a,
              cmd,
              change === "demotion" ? "CONTROLLER_REQUIRED" : "SESSION_EXPIRED",
              before,
            );
            if (["logout", "expiry"].includes(change)) await survived(s, b);
          }
          report.checks.push({
            name: `${gate} lock wait/${change}`,
            passed: true,
          });
        } finally {
          await release();
          a.ws.terminate();
          b.ws.terminate();
        }
      }
      // Wall-clock expiry can cross a later write despite locked session rows.
      for (const table of [
        "playlist_items",
        "room_events",
        "command_results",
      ]) {
        const s = await setup(true, false);
        const a = await connect(s.a, s.room),
          b = await connect(s.b, s.room, true);
        const media = sourceMedia(f, {
          kind: "local",
          root: f.root,
          resource: `owned-${randomUUID()}`,
        });
        const before = durable(s),
          cmd = command(a, s, snapshot(s), "CHANGE_MEDIA", { media_id: media });
        f.sql(
          `UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=${quote(s.hash)}`,
        );
        const release = await lock(`LOCK TABLE ${table} IN SHARE MODE`);
        try {
          a.send(cmd);
          await waitBlocked(`INSERT INTO ${table}`);
          await f.waitForSql(
            `SELECT count(*) FROM sessions WHERE token_hash=${quote(s.hash)} AND expires_at<=clock_timestamp()`,
            "1",
          );
          await release();
          await denied(s, a, cmd, "SESSION_EXPIRED", before);
          await survived(s, b);
          report.checks.push({
            name: `natural expiry during ${table} write rolls back`,
            passed: true,
          });
        } finally {
          await release();
          a.ws.terminate();
          b.ws.terminate();
        }
      }
      // Already-admitted commands keep their role/login rows locked through
      // final writes: mutation waits, then the next command sees the new role.
      for (const change of ["demotion", "logout", "expiry"]) {
        const s = await setup(true, true);
        const a = await connect(s.a, s.room),
          b = await connect(s.b, s.room);
        const release = await lock("LOCK TABLE room_events IN SHARE MODE");
        let mutator;
        try {
          const cmd = command(a, s);
          a.send(cmd);
          await waitBlocked("INSERT INTO room_events");
          mutator = f.sqlProcess(changeSql(s, change));
          mutator.stdout.resume();
          mutator.stderr.resume();
          const done = new Promise((resolve) => mutator.once("close", resolve));
          await waitBlocked(
            change === "demotion"
              ? "UPDATE users SET admin="
              : change === "logout"
                ? "DELETE FROM sessions"
                : "UPDATE sessions SET expires_at=",
          );
          assert.equal(
            mutator.exitCode,
            null,
            "role/login mutation waits for admitted commit",
          );
          await release();
          await done;
          assert.equal(mutator.exitCode, 0);
          await until(
            () =>
              f.sql(
                `SELECT count(*) FROM command_results WHERE command_id=${quote(cmd.command_id)}`,
              ) === "1",
            "admitted commit durable",
          );
          recorded(s, cmd, true);
          if (change === "demotion") await survived(s, b);
          else {
            assert.equal(
              f.sql(
                `SELECT count(*) FROM sessions WHERE token_hash=${quote(s.bHash)} AND expires_at>clock_timestamp()`,
              ),
              "1",
            );
            const next = command(b, s);
            b.send(next);
            await b.next("ACK", (v) => v.command_id === next.command_id);
            recorded(s, next, true);
          }
          report.checks.push({
            name: `admission holds current authority against ${change}`,
            passed: true,
          });
        } finally {
          await release();
          if (mutator?.exitCode === null) mutator.kill();
          a.ws.terminate();
          b.ws.terminate();
        }
      }
    } finally {
      for (const socket of sockets) socket.terminate();
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
