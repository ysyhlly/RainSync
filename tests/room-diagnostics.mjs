// Real isolated Server/PostgreSQL and pure CLI; fixture rows/locks are owned.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";

let fixture;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(
  process.env.W03_BACKEND_BINDING,
  "Use a successfully frozen backend binding",
);
const binding = JSON.parse(await readFile(process.env.W03_BACKEND_BINDING));
assert.equal(binding.result, "passed");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const example = resolve(
  process.env.CARGO_TARGET_DIR,
  "debug/examples/verify_diagnostics",
);
const exampleSha = sha(await readFile(example));
const coordinatorSha = sha(await readFile(fileURLToPath(import.meta.url)));
async function verifyBinding() {
  for (const item of binding.source)
    assert.equal(
      sha(await readFile(resolve(repo, item.path))),
      item.sha256,
      item.path,
    );
  for (const item of binding.binaries)
    assert.equal(sha(await readFile(item.path)), item.sha256, item.name);
  assert.equal(sha(await readFile(example)), exampleSha);
  assert.equal(
    sha(await readFile(fileURLToPath(import.meta.url))),
    coordinatorSha,
  );
}
await verifyBinding();
const report = {
  schema_version: 1,
  result: "running",
  checks: [],
  scope:
    "Owned PostgreSQL/Server diagnostic export and pure offline replay; seeded media and SQL faults are explicit fixtures, not production-history or device evidence",
  source_digest: binding.source_digest,
  verifier_sha256: exampleSha,
  coordinator_sha256: coordinatorSha,
};
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;
const json = (v) => `${quote(JSON.stringify(v))}::jsonb`;
const until = async (check, label, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await delay(10);
  }
  throw Error(label);
};
try {
  await isolatedServer("room-diagnostics", async (f) => {
    fixture = f;
    const admin = f.client(),
      identity = await admin.login();
    await admin.request("/users", "POST", {
      username: "diagnostic-member",
      password: f.password,
    });
    const viewer = f.client(),
      viewerIdentity = await viewer.login("diagnostic-member", f.password);
    const room = await admin.request("/rooms", "POST", {
      name: "private diagnostic fixture",
    });
    const invitation = await admin.request(`/rooms/${room.id}/invites`, "POST");
    await viewer.request(`/rooms/${room.id}/join`, "POST", {
      token: invitation.token,
    });
    const media = sourceMedia(f, {
      kind: "local",
      root: f.root,
      resource: "SECRET_MEDIA_RESOURCE",
    });
    f.sql(
      `UPDATE sources SET name='SECRET_SOURCE_NAME' WHERE id=(SELECT source_id FROM media_items WHERE id=${quote(media)}); UPDATE media_items SET title='SECRET_MEDIA_TITLE',duration_ms=30000 WHERE id=${quote(media)}`,
    );
    const sockets = new Set();
    const connect = async (client) => {
      const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
        headers: { Origin: f.origin, Cookie: client.cookie },
      });
      sockets.add(ws);
      const frames = [];
      ws.on("message", (b) => {
        if (frames.length < 100) frames.push(JSON.parse(b));
      });
      ws.on("error", () => {});
      await new Promise((done, fail) => {
        ws.once("open", done);
        ws.once("error", fail);
      });
      const next = async (type, predicate = () => true) =>
        until(() => {
          const i = frames.findIndex((v) => v.type === type && predicate(v));
          return i < 0 ? undefined : frames.splice(i, 1)[0];
        }, `missing ${type}`);
      ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
      const initial = await next("SNAPSHOT");
      return { ws, initial, next };
    };
    let socket = await connect(admin),
      current = socket.initial.state;
    const command = async (type, payload) => {
      const value = {
        protocol_version: 1,
        room_id: room.id,
        command_id: randomUUID(),
        control_epoch: socket.initial.control_epoch.id,
        expected_revision: current.revision,
        media_generation: current.media_generation,
        type,
        ...(payload ? { payload } : {}),
      };
      socket.ws.send(JSON.stringify(value));
      current = (
        await socket.next("ACK", (v) => v.command_id === value.command_id)
      ).state;
      return value;
    };
    const path = `/admin/rooms/${room.id}/diagnostics`;
    const download = async (client = admin, query = "", expected = 200) => {
      const response = await client.raw(path + query);
      assert.equal(response.status, expected);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const text = await response.text();
      if (expected === 200) {
        assert.match(
          response.headers.get("content-disposition"),
          /filename="rainsync-room-diagnostics.json"/,
        );
        assert.ok(Buffer.byteLength(text) <= 512 * 1024);
      }
      return { value: JSON.parse(text), text };
    };
    const replay = async (value, success = true) => {
      const file = resolve(f.root, `export-${randomUUID()}.json`);
      await writeFile(file, JSON.stringify(value));
      const process = spawnSync(
        resolve(f.target, "examples", "verify_diagnostics"),
        [file],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(process.status, success ? 0 : 1, process.stderr);
      const result = JSON.parse(process.stdout);
      return result;
    };
    const sideEffects = () =>
      f.sql(
        "SELECT jsonb_build_array((SELECT count(*) FROM control_epochs),(SELECT count(*) FROM command_results),(SELECT count(*) FROM playback_sessions),(SELECT count(*) FROM media_jobs),(SELECT count(*) FROM media_executions),(SELECT count(*) FROM chat_messages))",
      );
    const check = async (name, fn) => {
      const evidence = await fn();
      report.checks.push({
        name,
        passed: true,
        ...(evidence ? { evidence } : {}),
      });
      console.log("PASS: " + name);
    };
    try {
      await command("CHANGE_MEDIA", { media_id: media });
      const afterMedia = current.revision;
      await command("PAUSE");
      await command("SEEK", { position_ms: 1234.25 });
      await command("SET_RATE", { rate: 1.25 });
      const last = await command("PLAY");
      await check(
        "actual controls persist strict redacted facts and offline reducer matches the committed snapshot",
        async () => {
          const counts = sideEffects();
          const { value, text } = await download();
          const result = await replay(value);
          assert.equal(result.verified_steps, 5);
          assert.equal(result.checkpoint_steps, 0);
          assert.equal(result.unverifiable_steps, 0);
          assert.equal(result.continuous, true);
          assert.equal(result.reaches_snapshot, true);
          assert.equal(result.all_transitions_verified, true);
          assert.deepEqual(value.snapshot, current);
          assert.equal(value.events.length, 5);
          for (const secret of [
            "control_epoch",
            socket.initial.control_epoch.id,
            admin.cookie.split("=")[1],
            admin.csrf,
            "SECRET_SOURCE",
            "SECRET_MEDIA",
            "secret.invalid",
          ]) {
            assert.ok(!text.includes(secret), secret);
          }
          assert.equal(
            sideEffects(),
            counts,
            "export and pure CLI produce no application side effects",
          );
          const purely = await download(admin, `?after_revision=${afterMedia}`);
          assert.equal(
            (await replay(purely.value)).all_transitions_verified,
            true,
          );
          return {
            verified_steps: result.verified_steps,
            checkpoint_steps: result.checkpoint_steps,
          };
        },
      );
      await check("command replay does not add diagnostic events", async () => {
        const count = f.sql(
          `SELECT count(*) FROM room_events WHERE room_id=${quote(room.id)}`,
        );
        socket.ws.send(JSON.stringify(last));
        await socket.next("ACK", (v) => v.command_id === last.command_id);
        assert.equal(
          f.sql(
            `SELECT count(*) FROM room_events WHERE room_id=${quote(room.id)}`,
          ),
          count,
        );
      });
      await check(
        "only current administrators can export and malformed query/cookie bounds fail closed",
        async () => {
          await download(viewer, "", 403);
          await download(f.client(), "", 401);
          await download(admin, "?limit=257", 400);
          await download(admin, "?limit=0", 400);
          await download(admin, `?after_revision=${current.revision + 1}`, 400);
          const r = await admin.raw(path, {
            headers: { Cookie: `${admin.cookie}; ${admin.cookie}` },
          });
          assert.equal(r.status, 401);
        },
      );
      await check(
        "actual playlist advancement captures resolved media inputs and replays exactly",
        async () => {
          const selected = sourceMedia(f, {
            kind: "local",
            root: f.root,
            resource: "SECRET_NEXT_MEDIA",
          });
          f.sql(
            `UPDATE media_items SET duration_ms=45000 WHERE id=${quote(selected)}; INSERT INTO playlist_items(id,room_id,media_id,sort_order) VALUES(${quote(randomUUID())},${quote(room.id)},${quote(selected)},2)`,
          );
          await command("SEEK", { position_ms: 30000 });
          await command("END_MEDIA", { position_ms: 30000 });
          assert.equal(current.media_id, selected);
          assert.equal(current.duration_ms, 45000);
          const value = (await download()).value;
          const operation = value.events.at(-1).envelope.operation;
          assert.equal(operation.kind, "media_control");
          assert.deepEqual(operation.resolved_media, {
            media_id: selected,
            duration_ms: 45000,
          });
          assert.equal((await replay(value)).all_transitions_verified, true);
          const tampered = structuredClone(value);
          tampered.events.at(-1).envelope.operation.resolved_media.duration_ms =
            45001;
          assert.equal(
            (await replay(tampered, false)).all_transitions_verified,
            false,
          );
        },
      );
      await check(
        "bounded windows explicitly retain incomplete coverage",
        async () => {
          const value = (await download(admin, "?limit=2")).value;
          assert.equal(value.events.length, 2);
          assert.equal(value.truncated, true);
          const result = await replay(value, false);
          assert.equal(result.reaches_snapshot, false);
          assert.equal(result.all_transitions_verified, false);
        },
      );
      await check(
        "ownership and lifecycle transitions replay atomically without credential issuance",
        async () => {
          const transfer = await admin.request(
            `/rooms/${room.id}/owner`,
            "POST",
            {
              owner_id: viewerIdentity.id,
              expected_revision: current.revision,
            },
          );
          current = transfer.state;
          let value = (await download()).value;
          assert.equal(
            value.events.at(-1).envelope.operation.kind,
            "ownership",
          );
          assert.equal(
            (await replay(value)).verified_steps,
            value.events.length,
          );
          await admin.request(`/rooms/${room.id}/close`, "POST", {
            expected_revision: current.revision,
          });
          await f.waitForSql(
            `SELECT lifecycle FROM rooms WHERE id=${quote(room.id)}`,
            "closed",
            15000,
          );
          let status = await admin.request(`/rooms/${room.id}/lifecycle`);
          await admin.request(`/rooms/${room.id}/reopen`, "POST", {
            expected_revision: status.state.revision,
          });
          status = await admin.request(`/rooms/${room.id}/lifecycle`);
          await admin.request(`/rooms/${room.id}/close`, "POST", {
            expected_revision: status.state.revision,
          });
          await f.waitForSql(
            `SELECT lifecycle FROM rooms WHERE id=${quote(room.id)}`,
            "closed",
            15000,
          );
          status = await admin.request(`/rooms/${room.id}/lifecycle`);
          const oldClock = status.state.clock_epoch;
          for (const s of sockets) s.terminate();
          await f.startServer();
          status = await admin.request(`/rooms/${room.id}/lifecycle`);
          assert.notEqual(status.state.clock_epoch, oldClock);
          await admin.request(`/rooms/${room.id}/reopen`, "POST", {
            expected_revision: status.state.revision,
          });
          status = await admin.request(`/rooms/${room.id}/lifecycle`);
          await admin.request(`/rooms/${room.id}/close`, "POST", {
            expected_revision: status.state.revision,
          });
          await f.waitForSql(
            `SELECT lifecycle FROM rooms WHERE id=${quote(room.id)}`,
            "closed",
            15000,
          );
          status = await admin.request(`/rooms/${room.id}/lifecycle`);
          assert.equal(
            (await replay((await download()).value)).all_transitions_verified,
            true,
          );
          await admin.request(`/rooms/${room.id}/archive`, "POST", {
            expected_revision: status.state.revision,
          });
          value = (await download()).value;
          const reasons = value.events
            .filter((e) => e.envelope.operation.kind === "lifecycle")
            .map((e) => e.envelope.operation.transition);
          for (const reason of ["closing", "closed", "reopened", "archived"])
            assert.ok(reasons.includes(reason));
          assert.equal((await replay(value)).continuous, true);
          assert.equal(value.lifecycle.state, "archived");
        },
      );
      await check(
        "restart records a replayable clock input while preserving conservative pause and old history",
        async () => {
          const before = (await download()).value;
          for (const s of sockets) s.terminate();
          await f.startServer();
          const value = (await download()).value;
          assert.equal(value.events.length, before.events.length + 1);
          assert.notEqual(
            value.snapshot.clock_epoch,
            before.snapshot.clock_epoch,
          );
          assert.equal(value.snapshot.playback_status, "paused");
          assert.equal(
            value.events.at(-1).envelope.operation.kind,
            "server_restart",
          );
          assert.equal(
            (await replay(value)).verified_steps,
            (await replay(before)).verified_steps + 1,
          );
        },
      );
      await check(
        "legacy, unsupported, malformed, oversized and gaps remain explicitly unverified",
        async () => {
          const original = JSON.parse(
            f.sql(
              `SELECT jsonb_agg(to_jsonb(e) ORDER BY revision) FROM room_events e WHERE room_id=${quote(room.id)}`,
            ),
          );
          const row = original[1];
          const restore = () =>
            f.sql(
              `UPDATE room_events SET state=${json(row.state)},diagnostic=${json(row.diagnostic)} WHERE room_id=${quote(room.id)} AND revision=${row.revision}`,
            );
          try {
            for (const [diagnostic, expected] of [
              [null, "legacy"],
              [
                { ...row.diagnostic, schema_version: 99 },
                "unsupported_version",
              ],
              [
                { ...row.diagnostic, reducer_version: "future/reducer" },
                "unsupported_version",
              ],
              [
                {
                  ...row.diagnostic,
                  secret_url: "https://private.invalid/?token=SECRET_INJECTION",
                },
                "malformed_envelope",
              ],
            ]) {
              f.sql(
                `UPDATE room_events SET diagnostic=${diagnostic === null ? "NULL" : json(diagnostic)} WHERE room_id=${quote(room.id)} AND revision=${row.revision}`,
              );
              const { value, text } = await download();
              assert.equal(value.events[1].unavailable, expected);
              assert.ok(!text.includes("SECRET_INJECTION"));
              assert.equal(
                (await replay(value, false)).all_transitions_verified,
                false,
              );
              restore();
            }
            let deep = "SECRET_DEEP";
            for (let depth = 0; depth < 150; depth++) deep = { nested: deep };
            f.sql(
              `UPDATE room_events SET diagnostic=${json({ ...row.diagnostic, deep })} WHERE room_id=${quote(room.id)} AND revision=${row.revision}`,
            );
            let deepResult = await download();
            assert.equal(
              deepResult.value.events[1].unavailable,
              "malformed_envelope",
            );
            assert.ok(!deepResult.text.includes("SECRET_DEEP"));
            await replay(deepResult.value, false);
            restore();
            f.sql(
              `UPDATE room_events SET state=${json({ ...row.state, deep })} WHERE room_id=${quote(room.id)} AND revision=${row.revision}`,
            );
            deepResult = await download();
            assert.equal(
              deepResult.value.events[1].unavailable,
              "invalid_state",
            );
            assert.ok(!deepResult.text.includes("SECRET_DEEP"));
            await replay(deepResult.value, false);
            restore();
            f.sql(
              `UPDATE room_events SET state=state || jsonb_build_object('private_url',repeat('SECRET_LARGE',1000)) WHERE room_id=${quote(room.id)} AND revision=${row.revision}`,
            );
            let result = await download();
            assert.equal(result.value.events[1].unavailable, "oversized_row");
            assert.ok(!result.text.includes("SECRET_LARGE"));
            await replay(result.value, false);
            restore();
            f.sql(
              `DELETE FROM room_events WHERE room_id=${quote(room.id)} AND revision=${row.revision}`,
            );
            result = await download();
            const replayed = await replay(result.value, false);
            assert.equal(replayed.continuous, false);
          } finally {
            f.sql(
              `INSERT INTO room_events(room_id,revision,state,diagnostic,created_at) VALUES(${quote(room.id)},${row.revision},${json(row.state)},${json(row.diagnostic)},${quote(row.created_at)}) ON CONFLICT(room_id,revision) DO UPDATE SET state=EXCLUDED.state,diagnostic=EXCLUDED.diagnostic`,
            );
          }
        },
      );
      await check(
        "real database lock deadlines and concurrency cap do not strand shared pool slots",
        async () => {
          const lock = f.sqlProcess(undefined, { interactive: true });
          lock.stdout.resume();
          const marker = randomUUID();
          lock.stdin.write(
            `BEGIN; LOCK TABLE room_events IN ACCESS EXCLUSIVE MODE; SELECT '${marker}';\n`,
          );
          await f.waitForSql(
            "SELECT count(*) FROM pg_locks WHERE relation='room_events'::regclass AND mode='AccessExclusiveLock' AND granted",
            "1",
          );
          try {
            const start = Date.now();
            const responses = await Promise.all(
              Array.from({ length: 20 }, () => admin.raw(path)),
            );
            assert.ok(Date.now() - start < 3500);
            assert.ok(responses.every((r) => r.status === 503));
            await Promise.all(responses.map((r) => r.arrayBuffer()));
            await admin.request("/auth/me");
            const ready = await fetch(f.origin + "/ready", {
              signal: AbortSignal.timeout(1000),
            });
            assert.equal(ready.status, 200);
            assert.equal(
              f.sql(
                "SELECT count(*) FROM pg_locks WHERE relation='room_events'::regclass AND mode='AccessExclusiveLock' AND granted",
              ),
              "1",
            );
            return {
              requests: responses.length,
              elapsed_ms: Date.now() - start,
              pool_available_before_unlock: true,
            };
          } finally {
            lock.stdin.end("ROLLBACK;\n");
            await lock.done;
          }
        },
      );
      await check(
        "logout while an export waits cannot release a stale private window",
        async () => {
          const login = f.client();
          await login.login();
          const lock = f.sqlProcess(undefined, { interactive: true });
          lock.stdout.resume();
          lock.stdin.write(
            "BEGIN; LOCK TABLE room_events IN ACCESS EXCLUSIVE MODE; SELECT 1;\n",
          );
          await f.waitForSql(
            "SELECT count(*) FROM pg_locks WHERE relation='room_events'::regclass AND mode='AccessExclusiveLock' AND granted",
            "1",
          );
          try {
            const response = login.raw(path);
            await f.waitForSql(
              "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%selected_events AS MATERIALIZED%'",
              "1",
              2000,
            );
            await login.request("/auth/logout", "POST");
            lock.stdin.end("ROLLBACK;\n");
            await lock.done;
            const result = await response;
            assert.ok([401, 403].includes(result.status));
            const text = await result.text();
            assert.ok(!text.includes('"events"'));
            return { status: result.status };
          } finally {
            if (lock.exitCode === null) {
              lock.kill("SIGTERM");
              await lock.done.catch(() => {});
            }
          }
        },
      );
      await check(
        "the outer deadline bounds shared-pool acquisition without leaving queued export work",
        async () => {
          const lock = f.sqlProcess(undefined, { interactive: true });
          lock.stdout.resume();
          lock.stdin.write(
            "BEGIN; LOCK TABLE users IN ACCESS EXCLUSIVE MODE; SELECT 1;\n",
          );
          await f.waitForSql(
            "SELECT count(*) FROM pg_locks WHERE relation='users'::regclass AND mode='AccessExclusiveLock' AND granted",
            "1",
          );
          let occupied = [];
          try {
            occupied = Array.from({ length: 12 }, () => admin.raw("/auth/me"));
            await f.waitForSql(
              "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT u.id,u.admin,s.csrf%'",
              "11",
              3000,
            );
            const began = Date.now();
            const denied = await Promise.all(
              Array.from({ length: 8 }, () => admin.raw(path)),
            );
            const elapsed = Date.now() - began;
            assert.ok(elapsed >= 1800 && elapsed < 3500);
            assert.ok(denied.every((r) => r.status === 503));
            await Promise.all(denied.map((r) => r.arrayBuffer()));
            lock.stdin.end("ROLLBACK;\n");
            await lock.done;
            const released = await Promise.all(occupied);
            assert.ok(released.every((r) => r.status === 200));
            await Promise.all(released.map((r) => r.arrayBuffer()));
            await download();
            await until(
              async () =>
                (
                  await fetch(f.origin + "/ready", {
                    signal: AbortSignal.timeout(1000),
                  })
                ).status === 200,
              "cached readiness observes recovered shared pool",
              4000,
            );
            return {
              pool_slots_deliberately_occupied: 11,
              instance_lock_connection: 1,
              export_requests: 8,
              elapsed_ms: elapsed,
              pool_recovered: true,
            };
          } finally {
            if (lock.exitCode === null) {
              lock.kill("SIGTERM");
              await lock.done.catch(() => {});
            }
            await Promise.allSettled(occupied);
          }
        },
      );
      await check(
        "fresh final admission rejects logout, expiry, demotion and room deletion after the captured view",
        async () => {
          // Explicit fixture-only view barrier delays row evaluation after SQL's
          // statement snapshot, unlike a planning-time ACCESS EXCLUSIVE lock.
          // No application hook, test credential or schema change is deployed.
          const key = 171234567;
          const deletableRoom = await admin.request("/rooms", "POST", {
            name: "owned delete admission fixture",
          });
          // A disposable room with no cleanup/resource obligations. Its one
          // explicitly seeded legacy row only supplies the read barrier.
          f.sql(
            `INSERT INTO room_events(room_id,revision,state) SELECT room_id,0,state FROM room_snapshots WHERE room_id=${quote(deletableRoom.id)}`,
          );
          f.sql(`ALTER TABLE room_events RENAME TO owned_diagnostic_events;
          CREATE FUNCTION owned_diagnostic_gate() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN true; END $$;
          CREATE VIEW room_events AS SELECT e.* FROM owned_diagnostic_events e WHERE owned_diagnostic_gate();`);
          const cases = [];
          try {
            for (const reason of [
              "logout",
              "expiry",
              "demotion",
              "room_delete",
            ]) {
              const client = f.client();
              await client.login();
              const lock = f.sqlProcess(undefined, { interactive: true });
              lock.stdout.resume();
              lock.stdin.write(`SELECT pg_advisory_lock(${key});\n`);
              await f.waitForSql(
                `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=${key} AND granted`,
                "1",
              );
              let pending;
              try {
                pending = client.raw(
                  reason === "room_delete"
                    ? `/admin/rooms/${deletableRoom.id}/diagnostics`
                    : path,
                );
                await f.waitForSql(
                  `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=${key} AND NOT granted`,
                  "1",
                  2000,
                );
                if (reason === "logout")
                  await client.request("/auth/logout", "POST");
                else if (reason === "expiry")
                  f.sql(
                    `UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=${quote(sha(client.cookie.split("=")[1]))}`,
                  );
                else if (reason === "demotion")
                  f.sql(
                    `UPDATE users SET admin=false WHERE id=${quote(identity.id)}`,
                  );
                else
                  f.sql(
                    `DELETE FROM rooms WHERE id=${quote(deletableRoom.id)}`,
                  );
                lock.stdin.end(`SELECT pg_advisory_unlock(${key});\n`);
                await lock.done;
                const response = await pending;
                assert.equal(
                  response.status,
                  403,
                  "the previously authorized snapshot must fail the final gate",
                );
                const text = await response.text();
                assert.ok(!text.includes('"events"'));
                cases.push({ reason, status: response.status });
              } finally {
                if (lock.exitCode === null) {
                  lock.kill("SIGTERM");
                  await lock.done.catch(() => {});
                }
                if (reason === "demotion")
                  f.sql(
                    `UPDATE users SET admin=true WHERE id=${quote(identity.id)}`,
                  );
                if (pending) await pending.catch(() => {});
              }
            }
          } finally {
            f.sql(
              "DROP VIEW room_events; ALTER TABLE owned_diagnostic_events RENAME TO room_events; DROP FUNCTION owned_diagnostic_gate();",
            );
          }
          return { fixture: "owned row-evaluation view barrier", cases };
        },
      );
      report.result = "passed";
    } finally {
      for (const s of sockets) s.terminate();
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
    try {
      await verifyBinding();
      report.binding_unchanged = true;
    } catch (error) {
      report.result = "failed";
      report.failure = String(error.stack ?? error);
      process.exitCode = 1;
    }
    await writeFile(
      resolve(fixture.root, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(`${report.result}: ${resolve(fixture.root, "report.json")}`);
  }
}
