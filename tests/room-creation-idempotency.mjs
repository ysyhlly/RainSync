import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { isolatedServer, delay } from "./fixtures/server.mjs";

let fixture;
const report = { schema_version: 1, result: "running", checks: [] };
async function check(name, run) {
  const record = { name, passed: false };
  report.checks.push(record);
  await run();
  record.passed = true;
  console.log(`PASS ${name}`);
}

try {
  await isolatedServer("room-creation-idempotency", async (f) => {
    fixture = f;
    const admin = f.client();
    const identity = await admin.login();
    const post = (client, name, key, expected = 200) =>
      client.request(
        "/rooms",
        "POST",
        { name },
        expected,
        key === undefined ? {} : { "Idempotency-Key": key },
      );
    const count = (name) =>
      f.sql(`SELECT count(*) FROM rooms WHERE name='${name}'`);

    async function withCreationLock(run) {
      const marker = `room_creation_${randomUUID().replaceAll("-", "")}`;
      const holder = f.sqlProcess(
        `SET application_name='${marker}'; BEGIN; LOCK TABLE room_creation_requests IN SHARE MODE; SELECT pg_sleep(30); COMMIT;`,
      );
      await f.waitForSql(
        `SELECT count(*) FROM pg_stat_activity WHERE application_name='${marker}' AND wait_event='PgSleep'`,
        "1",
      );
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        assert.equal(
          f.sql(
            `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='${marker}'`,
          ),
          "t",
        );
        // Canceling this fixture-owned sleep rolls back its lock transaction.
        await holder.done.catch(() => {});
        await f.waitForSql(
          `SELECT count(*) FROM pg_stat_activity WHERE application_name='${marker}'`,
          "0",
        );
      };
      try {
        await run(release);
      } finally {
        await release();
      }
    }

    const stableKey = randomUUID();
    let original;
    await check(
      "same account and key replay the original result across sessions",
      async () => {
        original = await post(admin, "stable original", stableKey);
        assert.deepEqual(
          await post(admin, "stable original", stableKey),
          original,
        );
        const secondSession = f.client();
        await secondSession.login();
        assert.deepEqual(
          await post(secondSession, "stable original", stableKey),
          original,
        );
        assert.equal(count("stable original"), "1");
        assert.equal(
          f.sql(
            `SELECT count(*) FROM room_members WHERE room_id='${original.id}'`,
          ),
          "1",
        );
        assert.equal(
          f.sql(
            `SELECT count(*) FROM room_snapshots WHERE room_id='${original.id}'`,
          ),
          "1",
        );
      },
    );

    await check(
      "12 concurrent API requests blocked in PostgreSQL create one room",
      async () => {
        const key = randomUUID();
        await withCreationLock(async (release) => {
          const requests = Array.from({ length: 12 }, () =>
            post(admin, "concurrent original", key),
          );
          const completed = Promise.all(requests);
          completed.catch(() => {});
          // Observe real overlapping Server transactions, not only a JS race.
          await f.waitForSql(
            "SELECT count(*)>=3 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO room_creation_requests%'",
            "t",
          );
          await release();
          const results = await completed;
          assert.equal(new Set(results.map((r) => r.id)).size, 1);
          assert.equal(count("concurrent original"), "1");
          assert.equal(
            f.sql(
              `SELECT count(*) FROM room_creation_requests WHERE user_id='${identity.id}' AND request_key='${key}'`,
            ),
            "1",
          );
        });
      },
    );

    await check(
      "concurrent changed payloads cannot both claim the key",
      async () => {
        const key = randomUUID();
        const responses = await Promise.all(
          ["conflict left", "conflict right"].map((name) =>
            admin.raw("/rooms", {
              method: "POST",
              body: { name },
              headers: { "Idempotency-Key": key },
            }),
          ),
        );
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
        assert.equal(
          f.sql(
            "SELECT count(*) FROM rooms WHERE name IN ('conflict left','conflict right')",
          ),
          "1",
        );
        assert.equal(
          f.sql(
            `SELECT count(*) FROM room_creation_requests WHERE user_id='${identity.id}' AND request_key='${key}'`,
          ),
          "1",
        );
      },
    );

    await check(
      "same key with a changed payload is refused without mutation",
      async () => {
        const conflict = await post(admin, "changed payload", stableKey, 409);
        assert.equal(conflict.error.code, "INVALID_REQUEST");
        assert.equal(conflict.error.retryable, false);
        const unsupported = await admin.raw("/rooms", {
          method: "POST",
          body: { name: "stable original", visibility: "public" },
          headers: { "Idempotency-Key": stableKey },
        });
        assert.equal(unsupported.status, 422);
        assert.equal(count("changed payload"), "0");
        assert.deepEqual(
          await post(admin, "stable original", stableKey),
          original,
        );
        f.sql(
          `UPDATE rooms SET name='renamed after creation' WHERE id='${original.id}'`,
        );
        assert.deepEqual(
          await post(admin, "stable original", stableKey),
          original,
        );
        await post(admin, "renamed after creation", stableKey, 409);
        assert.equal(
          f.sql(`SELECT name FROM rooms WHERE id='${original.id}'`),
          "renamed after creation",
        );
      },
    );

    await check(
      "a committed response dropped by the proxy retries to the same room",
      async () => {
        const key = randomUUID();
        let committed;
        const proxy = createServer(async (_request, response) => {
          try {
            committed = await post(admin, "lost response original", key);
            response.destroy();
          } catch (error) {
            response.destroy(error);
          }
        });
        await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
        try {
          await assert.rejects(
            fetch(`http://127.0.0.1:${proxy.address().port}/rooms`, {
              method: "POST",
              body: "{}",
              signal: AbortSignal.timeout(10000),
            }),
          );
          assert.ok(committed?.id);
          assert.deepEqual(
            await post(admin, "lost response original", key),
            committed,
          );
          assert.equal(count("lost response original"), "1");
        } finally {
          proxy.closeAllConnections();
          await new Promise((done) => proxy.close(done));
        }
      },
    );

    await check(
      "different accounts may independently use the same key",
      async () => {
        await admin.request("/users", "POST", {
          username: "room-creator",
          password: f.password,
        });
        const viewer = f.client();
        await viewer.login("room-creator", f.password);
        const independent = await post(viewer, "stable original", stableKey);
        assert.notEqual(independent.id, original.id);
        assert.equal(
          f.sql(
            `SELECT count(*) FROM room_creation_requests WHERE request_key='${stableKey}'`,
          ),
          "2",
        );
      },
    );

    await check(
      "invalid keys and rejected CSRF never reserve a result",
      async () => {
        for (const key of ["", "has space", "a,b", "x".repeat(129)])
          await post(admin, "invalid key room", key, 400);
        const key = randomUUID();
        await admin.request(
          "/rooms",
          "POST",
          { name: "invalid csrf room" },
          403,
          { "Idempotency-Key": key, "x-csrf-token": "wrong" },
        );
        assert.equal(count("invalid key room"), "0");
        assert.equal(
          f.sql(
            `SELECT count(*) FROM room_creation_requests WHERE request_key='${key}'`,
          ),
          "0",
        );
      },
    );

    await check(
      "snapshot failure rolls back both the room and the request key",
      async () => {
        const key = randomUUID();
        f.sql(`CREATE FUNCTION room_creation_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF EXISTS(SELECT 1 FROM room_creation_requests WHERE room_id=NEW.room_id AND name='rollback original') THEN
          RAISE EXCEPTION 'owned fixture snapshot failure';
        END IF; RETURN NEW; END $$;
        CREATE TRIGGER room_creation_fixture_failure BEFORE INSERT ON room_snapshots FOR EACH ROW EXECUTE FUNCTION room_creation_fixture_failure();`);
        try {
          await post(admin, "rollback original", key, 500);
          assert.equal(count("rollback original"), "0");
          assert.equal(
            f.sql(
              `SELECT count(*) FROM room_creation_requests WHERE request_key='${key}'`,
            ),
            "0",
          );
        } finally {
          f.sql(
            "DROP TRIGGER room_creation_fixture_failure ON room_snapshots; DROP FUNCTION room_creation_fixture_failure();",
          );
        }
        await post(admin, "rollback original", key);
        assert.equal(count("rollback original"), "1");
      },
    );

    await check(
      "session expiration while queued rejects and rolls back creation",
      async () => {
        const expiring = f.client();
        await expiring.login();
        const key = randomUUID();
        const token = expiring.cookie.slice(expiring.cookie.indexOf("=") + 1);
        const sessionHash = createHash("sha256").update(token).digest("hex");
        f.sql(
          `UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash='${sessionHash}'`,
        );
        await withCreationLock(async (release) => {
          const queued = post(expiring, "expired original", key, 401);
          queued.catch(() => {});
          await f.waitForSql(
            "SELECT count(*)>=1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO room_creation_requests%'",
            "t",
          );
          while (
            f.sql(
              `SELECT expires_at<=clock_timestamp() FROM sessions WHERE token_hash='${sessionHash}'`,
            ) !== "t"
          )
            await delay(100);
          await release();
          await queued;
        });
        assert.equal(count("expired original"), "0");
        assert.equal(
          f.sql(
            `SELECT count(*) FROM room_creation_requests WHERE request_key='${key}'`,
          ),
          "0",
        );
      },
    );

    await check("Server restart replays the persisted result", async () => {
      await f.startServer();
      assert.deepEqual(
        await post(admin, "stable original", stableKey),
        original,
      );
    });

    await check(
      "physical room removal retains a tombstone instead of recreating",
      async () => {
        const key = randomUUID();
        const removed = await post(admin, "removed original", key);
        f.sql(`DELETE FROM rooms WHERE id='${removed.id}'`);
        assert.deepEqual(await post(admin, "removed original", key), removed);
        assert.equal(count("removed original"), "0");
      },
    );

    await check(
      "legacy clients without request keys retain independent creation",
      async () => {
        const first = await post(admin, "legacy original");
        const second = await post(admin, "legacy original");
        assert.notEqual(first.id, second.id);
        assert.equal(count("legacy original"), "2");
      },
    );
    report.result = "passed";
  });
} catch (error) {
  report.result = "failed";
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (fixture) {
    report.cleanup = await fixture.verifyStopped();
    report.postgres = fixture.postgresDiagnostics();
    report.inputs = await Promise.all(
      [
        "migrations/0079_room_creation_idempotency.sql",
        "apps/server/src/rooms.rs",
        "apps/web/src/features/rooms/room-creation.ts",
        "tests/room-creation-idempotency.mjs",
      ].map(async (path) => ({
        path,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      })),
    );
    const path = resolve(fixture.root, "report.json");
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
    console.log(`${report.result}: ${path}`);
  }
}
