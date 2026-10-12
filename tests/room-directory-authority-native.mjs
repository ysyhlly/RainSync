// Finite original/candidate qualification. This file does not run on import by
// the unit suite: it needs an explicitly bound Server and owned native Postgres.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { request as httpRequest } from "node:http";
import WebSocket from "ws";
import { nativeOwnerGate } from "./fixtures/native-owner-gate.mjs";
import { testLoginHash } from "./fixtures/playback-admission.mjs";
import { verifyPidAbsent } from "./fixtures/postgres.mjs";
import { sha256 } from "../scripts/native-owner-binding.mjs";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const uuid = (value) => {
  assert.match(
    value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  return quote(value);
};
const keyInsert =
  "INSERT INTO room_creation_requests(user_id,request_key,name,room_id) VALUES($1,$2,$3,$4) ON CONFLICT (user_id,request_key) DO NOTHING RETURNING room_id";
const snapshotInsert = "INSERT INTO room_snapshots VALUES($1,$2)";
const memberSelect =
  "SELECT r.id,r.name,r.owner_id,r.lifecycle,r.lifecycle_epoch FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.user_id=$1 ORDER BY r.created_at DESC";

// This fixed set is independent of dynamic case lists: missing, duplicate, or unknown checks fail.
const requiredChecks = [
  "directory_ingress_and_shared_name_contract",
  "create_new_after_key_rollback_samples_monotonic_time",
  "create_new_exact_login_expiry_snapshot_insert_wait",
  "create_replay_exact_login_expiry_key_commit_wait",
  "create_payload_conflict_after_login_expiry_key_commit_wait",
  "list_registered_exact_login_expiry_member_select_wait"
];
await nativeOwnerGate(
  "room-directory-authority-native",
  async (f, { report, check, signal }) => {
    report.scope =
      "Directory HTTP ingress/shared Name DTO; real unique-key rollback/commit and snapshot INSERT/list SELECT waits; exact-login natural expiry, untrimmed payload precedence, tombstones and transactional birth counter. Finite single-node qualification, no distributed lease, physical drain, P08/P09 or soak claim.";
    report.boundary_cases = [];
    const progress = resolve(f.root, "room-directory-authority-progress.json");
    let serial = 0;
    const pause = (ms) => new Promise((done) => setTimeout(done, ms));
    async function bounded(work, ms = 10000, observeAbort = true) {
      let timer, abort;
      try {
        return await Promise.race([
          Promise.resolve(work),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error("directory_boundary_deadline")),
              ms,
            );
            if (observeAbort) {
              abort = () => reject(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            }
          }),
        ]);
      } finally {
        clearTimeout(timer);
        if (abort) signal.removeEventListener("abort", abort);
      }
    }
    async function waitSql(sql) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (f.sql(sql) === "t") return;
        await pause(25);
      }
      throw Error("directory_boundary_witness_deadline");
    }
    async function privateFile(label, suffix, bytes) {
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const path = resolve(f.root, `${label}.${suffix}`);
      await writeFile(path, body, { flag: "wx", mode: 0o600 });
      // Private filenames contain only fixed labels; rows/SQL/credentials never
      // enter the uploadable owner-gate report.
      return { path, bytes: body.length, sha256: sha256(body) };
    }
    async function phase(active, value) {
      active.phase = value;
      await writeFile(
        progress,
        JSON.stringify({ boundary_cases: report.boundary_cases }, null, 2) +
          "\n",
      );
    }
    const responseBodies = new WeakMap();
    function readResponseBody(response) {
      let record = responseBodies.get(response);
      if (!record) {
        record = { drained: false, promise: response.text() };
        responseBodies.set(response, record);
        record.promise.then(
          () => {
            record.drained = true;
          },
          () => {},
        );
      }
      return record;
    }
    async function observe(label, pending) {
      let response, bodyPromise, bytes, failure;
      try {
        response = await bounded(pending);
        // Keep the original body read even if our observation deadline fires.
        bodyPromise = readResponseBody(response).promise;
        bytes = Buffer.from(await bounded(bodyPromise));
      } catch (error) {
        failure = error;
      } finally {
        if (failure) {
          try {
            response ??= await bounded(pending, 12000, false);
            bodyPromise ??= readResponseBody(response).promise;
            await bounded(bodyPromise, 12000, false);
          } catch (cleanupError) {
            if (cleanupError !== failure)
              failure = new AggregateError(
                [failure, cleanupError],
                "directory_http_observation_and_cleanup_failed",
              );
          }
        }
      }
      if (failure) throw failure;
      const value = JSON.parse(bytes);
      const receipt = {
        status: response.status,
        code: value?.error?.code ?? null,
        body_sha256: sha256(bytes),
        raw: await privateFile(
          label,
          "http.private.json",
          JSON.stringify(
            {
              status: response.status,
              headers: [...response.headers],
              body: value,
            },
            null,
            2,
          ) + "\n",
        ),
        body: await privateFile(label, "body.private.json", bytes),
      };
      return { response, value, receipt };
    }
    async function duplicateKeyRequest(client, active) {
      const body = JSON.stringify({ name: "duplicate rejected" });
      let request, response, pending, bodyPromise, socket, wire, failure;
      let requestClosed = false,
        socketClosed = false;
      let closeRequest, closeSocket;
      const requestClose = new Promise((done) => {
        closeRequest = done;
      });
      const socketClose = new Promise((done) => {
        closeSocket = done;
      });
      try {
        pending = new Promise((done, reject) => {
          request = httpRequest(
            f.origin + "/api/v1/rooms",
            {
              method: "POST",
              agent: false,
              // node:http emits these as two fields, unlike Fetch Headers, which
              // combines them into one comma-containing invalid value.
              headers: [
                "Host",
                new URL(f.origin).host,
                "Content-Type",
                "application/json",
                "Origin",
                f.origin,
                "Cookie",
                client.cookie,
                "x-csrf-token",
                client.csrf,
                "Content-Length",
                String(Buffer.byteLength(body)),
                "Connection",
                "close",
                "Idempotency-Key",
                "duplicate-a",
                "Idempotency-Key",
                "duplicate-b",
              ],
              signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
            },
            (incoming) => {
              const chunks = [];
              bodyPromise = new Promise((resolveBody, rejectBody) => {
                incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                incoming.once("end", () => resolveBody(Buffer.concat(chunks)));
                incoming.once("error", rejectBody);
                incoming.once("aborted", () =>
                  rejectBody(Error("directory_duplicate_body_aborted")),
                );
              });
              bodyPromise
                .then(
                  (bytes) =>
                    done(
                      new Response(bytes, {
                        status: incoming.statusCode,
                        headers: incoming.headers,
                      }),
                    ),
                  reject,
                )
                .catch(reject);
            },
          );
          request.once("error", reject);
          request.once("close", () => {
            requestClosed = true;
            closeRequest();
          });
          request.once("socket", (actual) => {
            socket = actual;
            socket.once("close", () => {
              socketClosed = true;
              closeSocket();
            });
          });
          request.end(body);
          // Save Node's serialized HTTP/1 header block, not a Headers object
          // that would hide whether duplicate fields reached the wire writer.
          wire = request._header;
        });
        response = await bounded(pending);
        assert.equal(typeof wire, "string");
        assert.equal(
          wire
            .split("\r\n")
            .filter((line) => line.toLowerCase().startsWith("host:")).length,
          1,
        );
        assert.ok(
          wire.split("\r\n").includes(`Host: ${new URL(f.origin).host}`),
        );
        assert.equal((wire.match(/^Idempotency-Key:/gim) ?? []).length, 2);
        assert.match(wire, /^Idempotency-Key: duplicate-a\r$/m);
        assert.match(wire, /^Idempotency-Key: duplicate-b\r$/m);
        active.duplicate_key_wire = await privateFile(
          active.name,
          "duplicate-headers.private.txt",
          wire,
        );
      } catch (error) {
        failure = error;
      } finally {
        const errors = [];
        if (failure) request?.destroy();
        if (bodyPromise)
          try {
            await bounded(bodyPromise, 12000, false);
          } catch (error) {
            if (error !== failure) errors.push(error);
          }
        if (request)
          try {
            await bounded(requestClose, 12000, false);
            assert.equal(requestClosed, true);
            if (socket) {
              await bounded(socketClose, 12000, false);
              assert.equal(socketClosed, true);
              assert.equal(socket.destroyed, true);
            }
            active.duplicate_key_cleanup = {
              request_close_observed: true,
              socket_close_observed: socket ? socketClosed : null,
              socket_destroyed: socket?.destroyed ?? null,
            };
          } catch (error) {
            errors.push(error);
          }
        if (pending)
          try {
            await bounded(pending, 12000, false);
          } catch (error) {
            if (error !== failure) errors.push(error);
          }
        if (errors.length)
          failure = new AggregateError(
            [...(failure ? [failure] : []), ...errors],
            "directory_duplicate_request_cleanup_failed",
          );
      }
      if (failure) throw failure;
      return response;
    }
    async function expect(label, pending, status, code) {
      const observed = await observe(label, pending);
      assert.equal(observed.response.status, status);
      if (code) {
        assert.equal(observed.value.error.code, code);
        assert.equal(observed.value.error.retryable, false);
      }
      return observed;
    }
    const post = (client, name, key, headers = {}) =>
      client.raw("/rooms", {
        method: "POST",
        body: { name },
        headers: {
          ...(key === undefined ? {} : { "Idempotency-Key": key }),
          ...headers,
        },
      });
    const get = (client, headers = {}) =>
      client.raw("/rooms", {
        headers: { Origin: "", "x-csrf-token": "", ...headers },
      });
    const admin = f.client();
    await admin.login();
    assert.equal(
      f.sql("SELECT count(*) FROM control_cluster_activation"),
      "0",
      "Single-node qualification must not disable an existing cluster setting",
    );
    async function person() {
      const username = `directory-boundary-${++serial}`;
      await admin.request("/users", "POST", { username, password: f.password });
      const client = f.client(),
        live = f.client();
      const id = (await client.login(username)).id;
      await live.login(username);
      return { id, client, live };
    }
    function snapshotSql(actor) {
      const user = uuid(actor.id);
      const scoped = `SELECT id FROM rooms WHERE owner_id=${user} UNION SELECT room_id FROM room_members WHERE user_id=${user}`;
      const array = (table, predicate, order) =>
        `COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY ${order}) FROM ${table} t WHERE ${predicate}),'[]'::jsonb)`;
      return `WITH scoped_rooms AS (${scoped}) SELECT jsonb_build_object(
      'users',${array("users", `id=${user}`, "id")},
      'sessions',${array("sessions", `user_id=${user}`, "token_hash")},
      'profiles',${array("user_profiles", `user_id=${user}`, "user_id")},
      'account_exits',${array("account_exits", `user_id=${user}`, "user_id")},
      'requests',${array("room_creation_requests", `user_id=${user}`, "request_key")},
      'rooms',${array("rooms", "id IN(SELECT id FROM scoped_rooms)", "id")},
      'members',${array("room_members", "room_id IN(SELECT id FROM scoped_rooms)", "room_id,user_id")},
      'snapshots',${array("room_snapshots", "room_id IN(SELECT id FROM scoped_rooms)", "room_id")},
      'leases',${array("room_leases", "room_id IN(SELECT id FROM scoped_rooms)", "room_id")},
      'events',${array("room_events", "room_id IN(SELECT id FROM scoped_rooms)", "room_id,revision")},
      'epochs',${array("control_epochs", "room_id IN(SELECT id FROM scoped_rooms)", "id")},
      'birth_counter',${array("room_cleanup_birth_counter", "true", "singleton")})::text`;
    }
    async function snapshot(actor, label) {
      const raw = f.sql(snapshotSql(actor));
      return {
        raw,
        value: JSON.parse(raw),
        receipt: await privateFile(label, "rows.private.json", raw + "\n"),
      };
    }
    function projection(actor) {
      return JSON.parse(
        f.sql(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY created_at DESC),'[]'::jsonb)::text FROM
      (SELECT r.id,r.name,r.owner_id,r.lifecycle,r.lifecycle_epoch,r.created_at FROM rooms r
      JOIN room_members m ON m.room_id=r.id WHERE m.user_id=${uuid(actor.id)}) r`),
      ).map(({ created_at, ...room }) => room);
    }
    function expectCreated(before, after, actor, result, name, key) {
      assert.deepEqual(Object.keys(result), ["id"]);
      uuid(result.id);
      const room = after.rooms.find((row) => row.id === result.id);
      const member = after.members.filter((row) => row.room_id === result.id);
      const snapshots = after.snapshots.filter(
        (row) => row.room_id === result.id,
      );
      const request = after.requests.find((row) => row.request_key === key);
      assert.ok(room);
      assert.equal(room.name, name);
      assert.equal(room.owner_id, actor.id);
      assert.equal(room.lifecycle, "active");
      assert.equal(room.lifecycle_epoch, 0);
      assert.equal(member.length, 1);
      assert.equal(member[0].user_id, actor.id);
      assert.equal(snapshots.length, 1);
      const state = snapshots[0].state;
      assert.ok(
        Number.isFinite(state.anchor_server_time_ms) &&
          state.anchor_server_time_ms >= 0,
      );
      uuid(state.clock_epoch);
      assert.deepEqual(state, {
        room_id: result.id,
        revision: 0,
        media_id: null,
        media_generation: 0,
        playback_status: "paused",
        anchor_position_ms: 0,
        anchor_server_time_ms: state.anchor_server_time_ms,
        playback_rate: 1,
        controller_user_id: actor.id,
        duration_ms: null,
        clock_epoch: state.clock_epoch,
      });
      assert.equal(before.birth_counter.length, 1);
      assert.deepEqual(after.birth_counter, [
        {
          ...before.birth_counter[0],
          ordinal: before.birth_counter[0].ordinal + 1,
        },
      ]);
      assert.equal(
        room.cleanup_birth_ordinal,
        before.birth_counter[0].ordinal + 1,
      );
      assert.ok(request);
      assert.equal(request.user_id, actor.id);
      assert.equal(request.name, name);
      assert.equal(request.room_id, result.id);
      // Compare the complete untouched remainder, rather than count-only rollback.
      const unchanged = structuredClone(after);
      unchanged.rooms = unchanged.rooms.filter((row) => row.id !== result.id);
      unchanged.members = unchanged.members.filter(
        (row) => row.room_id !== result.id,
      );
      unchanged.snapshots = unchanged.snapshots.filter(
        (row) => row.room_id !== result.id,
      );
      unchanged.requests = unchanged.requests.filter(
        (row) => row.request_key !== key,
      );
      unchanged.birth_counter = before.birth_counter;
      assert.deepEqual(unchanged, before);
      return state;
    }

    // GROUP 1: HTTP extraction/identity priorities and the shared agents Name DTO.
    {
      const name = "directory_ingress_and_shared_name_contract";
      const active = { name, result: "running", observations: [] };
      report.boundary_cases.push(active);
      await phase(active, "setup");
      const actor = await person();
      const rawName = "  原样房间  ";
      const key = randomUUID();
      const room = (
        await expect(
          `${name}.registered_create`,
          post(actor.client, rawName, key),
          200,
        )
      ).value;
      const second = (
        await expect(
          `${name}.unicode_120`,
          post(actor.client, "界".repeat(120), "A".repeat(128)),
          200,
        )
      ).value;
      assert.notEqual(room.id, second.id);
      assert.equal(
        JSON.parse(
          f.sql(
            `SELECT to_jsonb(name)::text FROM rooms WHERE id=${uuid(room.id)}`,
          ),
        ),
        rawName,
      );
      assert.deepEqual(
        (await expect(`${name}.cookie_only`, get(actor.client), 200)).value,
        projection(actor),
      );
      assert.deepEqual(
        (await expect(`${name}.admin_members_only`, get(admin), 200)).value,
        [],
        "Administrator status does not grant directory-wide membership",
      );
      const settings = await admin.request("/admin/settings");
      await admin.request("/admin/settings", "PATCH", {
        expected_revision: settings.revision,
        changes: { guests_enabled: true },
      });
      await actor.client.request(`/rooms/${room.id}/guest-access`, "PUT", {
        enabled: true,
      });
      const invitation = await actor.client.request(
        `/rooms/${room.id}/invites`,
        "POST",
        {},
      );
      const guest = f.client();
      const guestIdentity = await guest.request(
        `/rooms/${room.id}/guest-session`,
        "POST",
        {
          token: invitation.token,
          display_name: "Directory guest",
        },
        201,
      );
      guest.csrf = guestIdentity.csrf;
      assert.deepEqual(
        (await expect(`${name}.guest_scope`, get(guest), 200)).value,
        projection({ id: guestIdentity.id }),
      );
      assert.deepEqual(
        projection({ id: guestIdentity.id }).map((r) => r.id),
        [room.id],
      );
      const before = await snapshot(actor, `${name}.before`);
      const guestBefore = await snapshot(
        { id: guestIdentity.id },
        `${name}.guest_before`,
      );
      const agentsBefore = f.sql(
        "SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb)::text FROM agents a",
      );
      for (const [label, run, status, code] of [
        [
          "list_missing_cookie",
          () => get(actor.client, { Cookie: "" }),
          401,
          "LOGIN_REQUIRED",
        ],
        [
          "missing_cookie",
          () =>
            post(actor.client, "", "bad key", {
              Cookie: "",
              Origin: "",
              "x-csrf-token": "",
            }),
          401,
          "LOGIN_REQUIRED",
        ],
        [
          "origin_first",
          () =>
            post(actor.client, "", "bad key", {
              Origin: "http://127.0.0.1:1",
              "x-csrf-token": "wrong",
            }),
          403,
          "ORIGIN_REJECTED",
        ],
        [
          "csrf_first",
          () => post(actor.client, "", "bad key", { "x-csrf-token": "wrong" }),
          403,
          "CSRF_REJECTED",
        ],
        // guest_restricted has no public enum variant in the original mapper.
        [
          "guest_create",
          () => post(guest, "guest forbidden", randomUUID()),
          403,
          "FORBIDDEN",
        ],
        [
          "blank_name",
          () => post(actor.client, " \n\t ", randomUUID()),
          400,
          "INVALID_NAME",
        ],
        [
          "unicode_121",
          () => post(actor.client, "界".repeat(121), randomUUID()),
          400,
          "INVALID_NAME",
        ],
        [
          "untrimmed_payload_conflict",
          () => post(actor.client, rawName.trim(), key),
          409,
          "INVALID_REQUEST",
        ],
        [
          "duplicate_key_fields",
          () => duplicateKeyRequest(actor.client, active),
          400,
          "INVALID_REQUEST",
        ],
        [
          "unknown_room_field_before_auth",
          () =>
            actor.client.raw("/rooms", {
              method: "POST",
              body: { name: "room", extra: true },
              headers: { Cookie: "" },
            }),
          422,
          "INVALID_REQUEST",
        ],
        [
          "unknown_agent_field_before_auth",
          () =>
            admin.raw("/agents", {
              method: "POST",
              body: { name: "agent", extra: true },
              headers: { Cookie: "" },
            }),
          422,
          "INVALID_REQUEST",
        ],
        [
          "agent_control_name",
          () =>
            admin.raw("/agents", {
              method: "POST",
              body: { name: "bad\nname" },
            }),
          400,
          "INVALID_AGENT_NAME",
        ],
      ]) {
        const observed = await expect(`${name}.${label}`, run(), status, code);
        active.observations.push({ name: label, ...observed.receipt });
      }
      for (const [i, invalid] of [
        "",
        "has space",
        "x,y",
        "é",
        "x".repeat(129),
      ].entries()) {
        const observed = await expect(
          `${name}.invalid_key_${i}`,
          post(actor.client, "invalid key", invalid),
          400,
          "INVALID_REQUEST",
        );
        active.observations.push({
          name: `invalid_key_${i}`,
          ...observed.receipt,
        });
      }
      assert.deepEqual(
        (
          await expect(
            `${name}.raw_replay`,
            post(actor.live, rawName, key),
            200,
          )
        ).value,
        room,
      );
      const after = await snapshot(actor, `${name}.after`);
      assert.equal(after.raw, before.raw);
      const guestAfter = await snapshot(
        { id: guestIdentity.id },
        `${name}.guest_after`,
      );
      assert.equal(guestAfter.raw, guestBefore.raw);
      active.guest_selected_rows = {
        before: guestBefore.receipt,
        after: guestAfter.receipt,
        byte_equal: true,
      };
      assert.equal(
        f.sql(
          "SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb)::text FROM agents a",
        ),
        agentsBefore,
      );
      const paired = (
        await expect(
          `${name}.shared_agent_name`,
          admin.raw("/agents", {
            method: "POST",
            body: { name: "  Directory agent  " },
          }),
          200,
        )
      ).value;
      assert.equal(
        f.sql(`SELECT name FROM agents WHERE id=${uuid(paired.id)}`),
        "Directory agent",
      );
      active.selected_rows = {
        before: before.receipt,
        after: after.receipt,
        byte_equal: true,
      };
      active.result = "passed";
      check(name);
      await phase(active, "complete");
    }

    async function holder(spec, actor, key, roomId) {
      const marker = `directory_holder_${randomUUID().replaceAll("-", "")}`;
      const child = f.sqlProcess(undefined, { interactive: true });
      assert.ok(Number.isInteger(child.pid) && child.pid > 0);
      const stdout = [],
        stderr = [];
      let output = "",
        releasePromise,
        backend;
      const record = {
        child_pid: child.pid,
        backend_pid: null,
        backend_start: null,
        close_observed: false,
        exit_code: null,
        signal: null,
        pid_absent: false,
        backend_absent: false,
      };
      child.once("close", (code, endedSignal) =>
        Object.assign(record, {
          close_observed: true,
          exit_code: code,
          signal: endedSignal,
        }),
      );
      child.stdin.on("error", () => {});
      child.stderr.on("data", (bytes) => stderr.push(Buffer.from(bytes)));
      const ready = new Promise((done, reject) => {
        child.stdout.on("data", (bytes) => {
          stdout.push(Buffer.from(bytes));
          output += bytes.toString();
          if (output.includes(`${marker}_ready`)) done();
        });
        child.once("error", reject);
        child.done.then(
          () => reject(Error("directory_holder_closed_before_ready")),
          reject,
        );
      });
      let heldRow;
      const lock =
        spec.boundary === "snapshot"
          ? "LOCK TABLE room_snapshots IN SHARE MODE"
          : spec.boundary === "list"
            ? "LOCK TABLE room_members IN ACCESS EXCLUSIVE MODE"
            : `WITH inserted AS (INSERT INTO room_creation_requests(user_id,request_key,name,room_id)
           VALUES(${uuid(actor.id)},${quote(key)},${quote(spec.heldName)},${uuid(roomId)}) RETURNING *)
           SELECT ${quote(marker + "_row=")}||to_jsonb(inserted)::text FROM inserted`;
      child.stdin.write(`BEGIN; SET LOCAL application_name=${quote(marker)};
      SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s';
      ${lock};\n\\echo ${marker}_ready\n`);
      async function release() {
        if (!releasePromise)
          releasePromise = (async () => {
            const errors = [];
            try {
              child.stdin.end(
                `${spec.rollback ? "ROLLBACK" : "COMMIT"};\n\\q\n`,
              );
              await bounded(child.done, 12000, false);
              assert.equal(record.close_observed, true);
              assert.equal(record.exit_code, 0);
              assert.equal(record.signal, null);
              assert.equal(child.exitCode, 0);
              record.pid_absent = verifyPidAbsent(child.pid);
              assert.equal(record.pid_absent, true);
              if (backend) {
                record.backend_absent =
                  f.sql(
                    `SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${backend.pid})`,
                  ) === "t";
                assert.equal(record.backend_absent, true);
              }
            } catch (error) {
              errors.push(error);
            } finally {
              try {
                record.stdout = await privateFile(
                  spec.name,
                  "holder.stdout.private.log",
                  Buffer.concat(stdout),
                );
                record.stderr = await privateFile(
                  spec.name,
                  "holder.stderr.private.log",
                  Buffer.concat(stderr),
                );
              } catch (error) {
                errors.push(error);
              }
            }
            if (errors.length)
              throw new AggregateError(
                errors,
                "directory_holder_cleanup_failed",
              );
            return record;
          })();
        return releasePromise;
      }
      try {
        await bounded(ready);
        const identities = JSON.parse(
          f.sql(`SELECT COALESCE(jsonb_agg(jsonb_build_object('pid',pid,'backend_start',backend_start)),'[]'::jsonb)::text
        FROM pg_stat_activity WHERE application_name=${quote(marker)}`),
        );
        assert.equal(identities.length, 1);
        backend = identities[0];
        assert.ok(Number.isInteger(backend.pid) && backend.pid > 0);
        assert.ok(backend.backend_start);
        record.backend_pid = backend.pid;
        record.backend_start = backend.backend_start;
        if (spec.boundary === "key") {
          const lines = output
            .split("\n")
            .filter((line) => line.startsWith(marker + "_row="));
          assert.equal(lines.length, 1);
          heldRow = JSON.parse(lines[0].slice((marker + "_row=").length));
          assert.deepEqual(Object.keys(heldRow).sort(), [
            "created_at",
            "name",
            "request_key",
            "room_id",
            "user_id",
          ]);
          assert.equal(heldRow.user_id, actor.id);
          assert.equal(heldRow.request_key, key);
          assert.equal(heldRow.room_id, roomId);
          assert.equal(heldRow.name, spec.heldName);
        }
      } catch (error) {
        try {
          await release();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "directory_holder_setup_and_cleanup_failed",
          );
        }
        throw error;
      }
      const query =
        spec.boundary === "snapshot"
          ? snapshotInsert
          : spec.boundary === "list"
            ? memberSelect
            : keyInsert;
      const where = `blocked.wait_event_type='Lock' AND blocked.query=${quote(query)}
      AND ${backend.pid}=ANY(pg_blocking_pids(blocked.pid)) AND EXISTS(SELECT 1 FROM pg_stat_activity held
        WHERE held.pid=${backend.pid} AND held.backend_start=${quote(backend.backend_start)}::timestamptz
        AND held.application_name=${quote(marker)})`;
      const blockedRows = () =>
        JSON.parse(
          f.sql(`SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'pid',blocked.pid,'backend_start',blocked.backend_start) ORDER BY blocked.pid),'[]'::jsonb)::text
      FROM pg_stat_activity blocked WHERE ${where}`),
        );
      return {
        release,
        record,
        heldRow,
        query,
        where,
        blockedRows,
        witness: `SELECT EXISTS(SELECT 1 FROM pg_stat_activity blocked WHERE ${where})`,
      };
    }

    async function observer(actor, room, label) {
      const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
        headers: { Origin: f.origin, Cookie: actor.live.cookie },
      });
      const frames = [];
      let closed, closePromise, frameFailure;
      const actualClose = new Promise((done) =>
        ws.once("close", (code, reason) => {
          closed = { close_observed: true, code, reason_bytes: reason.length };
          done(closed);
        }),
      );
      ws.on("error", (error) => { frameFailure ??= error; });
      ws.on("message", (bytes) => {
        try {
          frames.push(JSON.parse(bytes.toString()));
        } catch (error) {
          frameFailure ??= error;
        }
      });
      async function next(predicate) {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          if (frameFailure) throw frameFailure;
          const index = frames.findIndex(predicate);
          if (index >= 0) return frames.splice(index, 1)[0];
          assert.equal(
            closed,
            undefined,
            "Observer closed before expected frame",
          );
          await pause(20);
        }
        throw Error("directory_clock_frame_deadline");
      }
      async function close() {
        if (!closePromise)
          closePromise = (async () => {
            let cleanupFailure;
            try {
              if (ws.readyState !== WebSocket.CLOSED) ws.close(1000);
              try {
                await bounded(actualClose, 12000, false);
              } catch (error) {
                try {
                  ws.terminate();
                  await bounded(actualClose, 12000, false);
                } catch (forcedError) {
                  throw new AggregateError([error, forcedError], "directory_observer_forced_close_failed");
                }
                throw error; // Forced close is cleanup, not a successful normal receipt.
              }
              assert.equal(ws.readyState, WebSocket.CLOSED);
              assert.equal(closed.code, 1000);
            } catch (error) { cleanupFailure = error; }
            // A terminal malformed frame or transport error must not become a pass.
            if (frameFailure && cleanupFailure)
              throw new AggregateError([frameFailure, cleanupFailure], "directory_observer_frame_and_cleanup_failed");
            if (cleanupFailure) throw cleanupFailure;
            if (frameFailure) throw frameFailure;
            return closed;
          })();
        return closePromise;
      }
      try {
        await bounded(
          new Promise((done, reject) => {
            ws.once("open", done);
            ws.once("error", reject);
          }),
        );
        ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
        const joined = await next((frame) => frame.type === "SNAPSHOT");
        assert.equal(joined.state.room_id, room.id);
        let sequence = 0;
        async function clock() {
          const t1 = 1000000 + ++sequence;
          ws.send(JSON.stringify({ type: "CLOCK_SYNC", t1 }));
          const reply = await next(
            (frame) => frame.type === "CLOCK_SYNC_REPLY" && frame.t1 === t1,
          );
          assert.equal(reply.clock_epoch, joined.state.clock_epoch);
          assert.ok(
            Number.isFinite(reply.t2) &&
              Number.isFinite(reply.t3) &&
              reply.t3 >= reply.t2,
          );
          return {
            value: reply,
            receipt: await privateFile(
              `${label}.clock_${sequence}`,
              "ws.private.json",
              JSON.stringify(reply) + "\n",
            ),
          };
        }
        return { clock, close };
      } catch (error) {
        try {
          await close();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "directory_observer_setup_and_cleanup_failed",
          );
        }
        throw error;
      }
    }

    const cases = [
      {
        name: "create_new_after_key_rollback_samples_monotonic_time",
        boundary: "key",
        rollback: true,
        expires: false,
        status: 200,
        nameValue: "late sampled room",
        heldName: "late sampled room",
      },
      {
        name: "create_new_exact_login_expiry_snapshot_insert_wait",
        boundary: "snapshot",
        expires: true,
        status: 401,
        code: "SESSION_EXPIRED",
        nameValue: "rolled back new room",
      },
      {
        name: "create_replay_exact_login_expiry_key_commit_wait",
        boundary: "key",
        expires: true,
        status: 401,
        code: "SESSION_EXPIRED",
        nameValue: "tombstone replay",
        heldName: "tombstone replay",
      },
      {
        name: "create_payload_conflict_after_login_expiry_key_commit_wait",
        boundary: "key",
        expires: true,
        status: 409,
        code: "INVALID_REQUEST",
        nameValue: "payload changed",
        heldName: "  original payload  ",
      },
      {
        name: "list_registered_exact_login_expiry_member_select_wait",
        boundary: "list",
        expires: true,
        status: 200,
      },
    ];
    for (const spec of cases) {
      signal.throwIfAborted();
      const actor = await person(),
        key = randomUUID();
      const active = { name: spec.name, result: "running", actor_id: actor.id };
      report.boundary_cases.push(active);
      await phase(active, "setup");
      let block,
        socket,
        pending,
        responseObserved = false,
        requestSettled = false,
        failure;
      try {
        let originalId = randomUUID();
        if (spec.boundary === "key" && !spec.rollback) {
          // Start with a genuinely created then removed room. New key holder row
          // remains a valid original-result tombstone, with no room FK by design.
          const removed = await actor.live.request("/rooms", "POST", {
            name: "real tombstone source",
          });
          originalId = removed.id;
          f.sql(`DELETE FROM rooms WHERE id=${uuid(originalId)}`);
          assert.equal(
            f.sql(`SELECT count(*) FROM rooms WHERE id=${uuid(originalId)}`),
            "0",
          );
        }
        let firstClock;
        if (spec.rollback) {
          const room = await actor.live.request("/rooms", "POST", {
            name: "clock observer room",
          });
          socket = await observer(actor, room, spec.name);
          firstClock = await socket.clock();
        }
        if (spec.boundary === "list") {
          await actor.live.request("/rooms", "POST", {
            name: "older list room",
          });
          await actor.live.request("/rooms", "POST", {
            name: "newer list room",
          });
        }
        const expectedList =
          spec.boundary === "list" ? projection(actor) : null;
        const login = testLoginHash(f, actor.client);
        const sessionWhere = `user_id=${uuid(actor.id)} AND token_hash=${quote(login)}`;
        let exactExpiry;
        if (spec.expires) {
          f.sql(
            `UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE ${sessionWhere}`,
          );
          exactExpiry = f.sql(
            `SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM sessions WHERE ${sessionWhere}`,
          );
          assert.match(
            exactExpiry,
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
          );
        }
        // Capture before the ACCESS EXCLUSIVE member table lock; no SELECT from
        // this connection is allowed to deadlock behind our own list blocker.
        const before = await snapshot(actor, `${spec.name}.before`);
        active.before = before.receipt;
        block = await holder(spec, actor, key, originalId);
        if (spec.expires)
          assert.equal(
            f.sql(`SELECT expires_at=${quote(exactExpiry)}::timestamptz
        AND clock_timestamp()<expires_at FROM sessions WHERE ${sessionWhere}`),
            "t",
          );
        pending =
          spec.boundary === "list"
            ? get(actor.client)
            : post(actor.client, spec.nameValue, key);
        pending.then(
          () => {
            requestSettled = true;
          },
          () => {
            requestSettled = true;
          },
        );
        await phase(active, "http_pending");
        await waitSql(block.witness);
        const blocked = block.blockedRows();
        assert.equal(blocked.length, 1);
        assert.ok(Number.isInteger(blocked[0].pid));
        assert.notEqual(blocked[0].pid, block.record.backend_pid);
        active.blocked_backend_pid = blocked[0].pid;
        active.blocked_backend_start = blocked[0].backend_start;
        active.holder_backend_pid = block.record.backend_pid;
        active.holder_backend_start = block.record.backend_start;
        async function witness(label) {
          assert.deepEqual(
            block.blockedRows(),
            blocked,
            "Exact same blocked and holder backend incarnations",
          );
          assert.equal(requestSettled, false);
          const raw = f.sql(`SELECT jsonb_build_object(
          'database_clock_utc',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'holder',(SELECT to_jsonb(h) FROM (SELECT pid,backend_start,state,wait_event_type,wait_event,query FROM pg_stat_activity WHERE pid=${block.record.backend_pid}) h),
          'blocked',(SELECT to_jsonb(b) FROM (SELECT pid,backend_start,state,wait_event_type,wait_event,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=${blocked[0].pid}) b))::text`);
          const value = JSON.parse(raw);
          assert.equal(value.holder.backend_start, block.record.backend_start);
          assert.equal(value.blocked.backend_start, blocked[0].backend_start);
          assert.equal(value.blocked.query, block.query);
          assert.equal(value.blocked.wait_event_type, "Lock");
          assert.ok(value.blocked.blockers.includes(block.record.backend_pid));
          return {
            database_clock_utc: value.database_clock_utc,
            receipt: await privateFile(
              label,
              "pg-witness.private.json",
              raw + "\n",
            ),
          };
        }
        active.initial_witness = await witness(`${spec.name}.initial`);
        if (spec.expires) {
          assert.equal(
            f.sql(
              `SELECT clock_timestamp()<${quote(exactExpiry)}::timestamptz`,
            ),
            "t",
            "Qualify initial actual wait while original login is still live",
          );
          await waitSql(
            `SELECT clock_timestamp()>=${quote(exactExpiry)}::timestamptz`,
          );
          assert.equal(
            f.sql(`SELECT expires_at=${quote(exactExpiry)}::timestamptz
          AND clock_timestamp()>=expires_at FROM sessions WHERE ${sessionWhere}`),
            "t",
          );
          active.expiry_unchanged = true;
          active.exact_expiry_utc = exactExpiry;
        }
        let lateClock;
        if (socket) {
          lateClock = await socket.clock();
          assert.equal(
            lateClock.value.clock_epoch,
            firstClock.value.clock_epoch,
          );
          assert.ok(lateClock.value.t3 > firstClock.value.t3);
          active.clock = {
            first: firstClock.receipt,
            while_key_blocked: lateClock.receipt,
          };
        }
        active.pre_release_witness = await witness(`${spec.name}.pre-release`);
        await phase(active, "same_actual_edge_before_release");
        active.holder_cleanup = await block.release();
        const observed = await expect(
          spec.name,
          pending,
          spec.status,
          spec.code,
        );
        responseObserved = true;
        active.response = observed.receipt;
        const after = await snapshot(actor, `${spec.name}.after`);
        active.after = after.receipt;
        if (spec.rollback) {
          const state = expectCreated(
            before.value,
            after.value,
            actor,
            observed.value,
            spec.nameValue,
            key,
          );
          assert.notEqual(observed.value.id, originalId);
          assert.equal(state.clock_epoch, lateClock.value.clock_epoch);
          assert.ok(
            state.anchor_server_time_ms >= lateClock.value.t3,
            "Real snapshot anchor must be sampled after the still-blocked WS clock reply",
          );
          active.late_boot_clock_and_exact_birth_increment = true;
        } else if (spec.boundary === "key") {
          const expected = structuredClone(before.value);
          expected.requests.push(block.heldRow);
          expected.requests.sort((a, b) =>
            a.request_key.localeCompare(b.request_key),
          );
          assert.deepEqual(
            after.value,
            expected,
            "Only the actual holder committed row changed",
          );
          active.only_actual_holder_key_row_changed = true;
        } else {
          assert.equal(
            after.raw,
            before.raw,
            "Complete selected rows and birth counter rolled back or remained read-only",
          );
          if (spec.boundary === "list")
            assert.deepEqual(observed.value, expectedList);
          active.full_selected_rows_byte_equal = true;
        }
        if (spec.expires) {
          active.new_expired_cookie = (
            await expect(
              `${spec.name}.expired_next`,
              get(actor.client),
              401,
              "SESSION_EXPIRED",
            )
          ).receipt;
          assert.deepEqual(
            (await expect(`${spec.name}.live_list`, get(actor.live), 200))
              .value,
            projection(actor),
          );
        }
        if (spec.boundary === "snapshot") {
          const created = await expect(
            `${spec.name}.live_same_key`,
            post(actor.live, spec.nameValue, key),
            200,
          );
          const committed = await snapshot(actor, `${spec.name}.committed`);
          expectCreated(
            before.value,
            committed.value,
            actor,
            created.value,
            spec.nameValue,
            key,
          );
          active.live_reclaim = {
            response: created.receipt,
            rows: committed.receipt,
          };
        } else if (spec.boundary === "key" && !spec.rollback) {
          const replay = await expect(
            `${spec.name}.live_replay`,
            post(actor.live, spec.heldName, key),
            200,
          );
          assert.deepEqual(replay.value, { id: originalId });
          const replayed = await snapshot(actor, `${spec.name}.replayed`);
          assert.equal(
            replayed.raw,
            after.raw,
            "Tombstone replay recreates no room and advances no counter",
          );
          active.live_tombstone_replay = {
            response: replay.receipt,
            rows: replayed.receipt,
          };
        }
        active.result = "passed";
        check(spec.name);
        await phase(active, "complete");
      } catch (error) {
        failure = error;
        active.result = "failed";
        active.failure = {
          code: "directory_boundary_failed",
          phase: active.phase,
        };
      } finally {
        const errors = [];
        if (block)
          try {
            active.holder_cleanup = await block.release();
          } catch (error) {
            errors.push(error);
            active.holder_cleanup = { ...block.record, completed: false };
          }
        if (pending) {
          try {
            const response = await bounded(pending, 12000, false);
            const bodyRead = readResponseBody(response);
            const bytes = Buffer.from(
              await bounded(bodyRead.promise, 12000, false),
            );
            assert.equal(bodyRead.drained, true);
            active.http_body_drained = true;
            if (!responseObserved) {
              active.cleanup_http = {
                status: response.status,
                body: await privateFile(
                  `${spec.name}.cleanup`,
                  "body.private.json",
                  bytes,
                ),
              };
            }
          } catch (error) {
            errors.push(error);
            active.cleanup_http_transport_failed = true;
          }
        }
        if (socket)
          try {
            active.observer_cleanup = await socket.close();
          } catch (error) {
            errors.push(error);
            active.observer_cleanup = { completed: false };
          }
        try {
          await phase(active, active.phase);
        } catch (error) {
          errors.push(error);
        }
        if (errors.length)
          throw new AggregateError(
            [...(failure ? [failure] : []), ...errors],
            "directory_boundary_run_and_cleanup_failed",
          );
      }
      if (failure) throw failure;
    }
    assert.deepEqual(report.checks, requiredChecks.map((name) => ({ name, result: "passed" })),
    "Every frozen native check must complete exactly once");
  },
);
