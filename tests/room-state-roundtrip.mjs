import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";

// Real PostgreSQL, authenticated HTTP, and Server WebSockets. SQL deliberately
// seeds exact decimal room state; Node parses database text independently of Rust.
// This control-plane fixture does not decode media or simulate Server messages.
const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--server-binary=(.+)$/.exec(arg);
  assert.ok(match && !args.has("server-binary"), "unknown/duplicate argument");
  args.set("server-binary", match[1]);
}
const binarySource = resolve(
  args.get("server-binary") ??
    resolve(
      process.env.CARGO_TARGET_DIR ?? "target",
      "debug",
      `rainsync-server${process.platform === "win32" ? ".exe" : ""}`,
    ),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const doubleFields = [
  "anchor_position_ms",
  "anchor_server_time_ms",
  "playback_rate",
  "duration_ms",
];
const bits = (value) => {
  if (value === null) return null;
  assert.equal(typeof value, "number");
  assert.ok(Number.isFinite(value));
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value);
  return buffer.toString("hex");
};
const report = {
  started_at: new Date().toISOString(),
  result: "running",
  scope:
    "native Server; exact PostgreSQL JSON text to authenticated JOIN/RESUME, ACK/EVENT, snapshot/events/replay persistence; GET /rooms checks membership only because it has no RoomState fields",
  entry_sha256: sha(await readFile(new URL(import.meta.url))),
  fixture_entry_sha256: sha(
    await readFile(new URL("./fixtures/server.mjs", import.meta.url)),
  ),
  postgres_fixture_entry_sha256: sha(
    await readFile(new URL("./fixtures/postgres.mjs", import.meta.url)),
  ),
  cases: [],
  failures: [],
  cleanup: { completed: false },
};
let artifactRoot, fixture, binary, failure;
const sockets = new Set();
const docker = (...args) =>
  execFileSync("docker", args, {
    timeout: 30000,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function compareState(actual, expected, path, proof) {
  const stateDigest = (value) =>
    sha(
      JSON.stringify(
        Object.keys(value ?? {})
          .sort()
          .map((key) => [key, value[key]]),
      ),
    );
  const checked = {
    path,
    expected_state_sha256: stateDigest(expected),
    actual_state_sha256: stateDigest(actual),
    expected_float_bits: {},
    actual_float_bits: {},
    passed: true,
  };
  for (const field of doubleFields) {
    checked.expected_float_bits[field] = bits(expected[field]);
    try {
      checked.actual_float_bits[field] = bits(actual?.[field]);
    } catch {
      checked.actual_float_bits[field] = "invalid";
    }
  }
  try {
    assert.deepEqual(actual, expected);
    assert.deepEqual(checked.actual_float_bits, checked.expected_float_bits);
  } catch {
    checked.passed = false;
    report.failures.push({ path, expected, actual, ...checked });
  }
  proof.checks.push(checked);
}

async function connect(client, room, join) {
  const ws = new WebSocket(
    fixture.origin.replace(/^http/, "ws") + "/api/v1/ws",
    {
      headers: { Origin: fixture.origin, Cookie: client.cookie },
      handshakeTimeout: 5000,
    },
  );
  sockets.add(ws);
  const inbox = [];
  const peer = { ws, epoch: null, eventCount: 0, terminal: null };
  ws.on("message", (bytes) => {
    try {
      const value = JSON.parse(bytes.toString());
      if (value.control_epoch) peer.epoch = value.control_epoch;
      if (value.type === "EVENT") peer.eventCount++;
      inbox.push(value);
    } catch (error) {
      peer.terminal = error;
    }
  });
  ws.on("error", (error) => (peer.terminal = error));
  ws.on("close", () => {
    peer.terminal ??= Error("WebSocket closed");
    sockets.delete(ws);
  });
  await new Promise((ok, no) => {
    const timeout = setTimeout(() => no(Error("WebSocket open timeout")), 6000);
    ws.once("open", () => {
      clearTimeout(timeout);
      ok();
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      no(error);
    });
  });
  peer.send = (value) => ws.send(JSON.stringify(value));
  peer.next = async (type, predicate = () => true) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = inbox.findIndex(
        (value) => value.type === type && predicate(value),
      );
      if (index >= 0) return inbox.splice(index, 1)[0];
      const rejected = inbox.find(
        (value) => value.type === "ERROR" && predicate(value),
      );
      if (rejected) throw Error(`Server rejected: ${rejected.error?.code}`);
      if (peer.terminal) throw peer.terminal;
      await delay(10);
    }
    throw Error(`Timed out waiting for ${type}`);
  };
  peer.close = async () => {
    if (ws.readyState === WebSocket.CLOSED) return;
    const done = new Promise((ok) => ws.once("close", ok));
    const timeout = setTimeout(() => ws.terminate(), 1000);
    ws.close();
    try {
      await done;
    } finally {
      clearTimeout(timeout);
    }
  };
  peer.send({ ...join, room_id: room });
  peer.snapshot = await peer.next("SNAPSHOT");
  assert.ok(peer.epoch?.id && Number.isSafeInteger(peer.epoch.expires_at_ms));
  return peer;
}

function verifyEpoch(peer, room, user) {
  assert.equal(
    fixture.sql(
      `SELECT count(*) FROM control_epochs WHERE id='${peer.epoch.id}' AND room_id='${room}' AND user_id='${user}' AND expires_at>clock_timestamp() AND expires_at<=issued_at+interval '24 hours'`,
    ),
    "1",
    "Server-issued control epoch belongs to this authenticated user and room",
  );
}

async function clock(peer) {
  const t1 = Date.now();
  peer.send({ type: "CLOCK_SYNC", t1 });
  return peer.next("CLOCK_SYNC_REPLY", (value) => value.t1 === t1);
}

try {
  const options = {
    async beforeStart(f) {
      fixture = f;
      artifactRoot = f.root;
      binary = resolve(
        f.root,
        `server-under-test${process.platform === "win32" ? ".exe" : ""}`,
      );
      const before = await readFile(binarySource);
      await copyFile(binarySource, binary);
      assert.equal(sha(await readFile(binarySource)), sha(before));
      assert.equal(sha(await readFile(binary)), sha(before));
      options.binary = binary;
      report.binary = {
        source: binarySource,
        tested_copy: binary,
        sha256: sha(before),
        bytes: before.length,
        source_build_manifest: "not inferred from mutable checkout",
      };
      report.fixture = {
        id: f.id,
        database_kind: f.databaseKind,
        container: f.container,
      };
      const diagnostic = f.postgresDiagnostics();
      assert.equal(diagnostic.ready, true);
      report.postgresql = {
        ...diagnostic,
        version: diagnostic.server_version,
        image_id: diagnostic.docker?.image_id ?? null,
      };
      if (f.databaseKind === "docker") {
        report.cleanup.anonymous_volumes = JSON.parse(
          docker("inspect", "--format", "{{json .Mounts}}", f.container),
        )
          .filter((mount) => mount.Type === "volume")
          .map((mount) => mount.Name);
      }
      console.log(`Evidence: ${resolve(f.root, "report.json")}`);
    },
  };
  await isolatedServer(
    "room-state-roundtrip",
    async (f) => {
      const admin = f.client();
      const owner = await admin.login();
      const guestPassword = "roundtrip-fixture-" + randomUUID();
      await admin.request("/users", "POST", {
        username: "roundtrip-observer",
        password: guestPassword,
      });
      const guest = f.client();
      const observer = await guest.login("roundtrip-observer", guestPassword);
      assert.notEqual(owner.id, observer.id);
      const anonymous = f.client();
      await anonymous.request("/rooms", "GET", undefined, 401);
      await writeFile(resolve(f.root, "fixture.mp4"), "control-plane fixture");
      const source = await admin.request("/sources", "POST", {
        name: "roundtrip local fixture",
        kind: "local",
        config: { root: f.root },
      });
      await admin.request(`/sources/${source.id}/test`, "POST");
      const media = await admin.request("/media");
      assert.equal(media.length, 1);
      assert.equal(
        f.sql(
          `SELECT source_id::text FROM media_items WHERE id='${media[0].id}'`,
        ),
        source.id,
      );
      const positions = [32546.403021000006, 51.248178375505404, 98713.698932];
      for (const position of positions) {
        const proof = {
          position,
          checks: [],
          commands: [],
          result: "running",
        };
        report.cases.push(proof);
        const room = await admin.request("/rooms", "POST", {
          name: `exact-f64-${position}`,
        });
        const invite = await admin.request(`/rooms/${room.id}/invites`, "POST");
        await guest.request(`/rooms/${room.id}/join`, "POST", {
          token: invite.token,
        });
        for (const client of [admin, guest]) {
          const listed = (await client.request("/rooms")).find(
            (value) => value.id === room.id,
          );
          assert.deepEqual(listed, {
            id: room.id,
            name: `exact-f64-${position}`,
            owner_id: owner.id,
            ...("lifecycle" in listed
              ? { lifecycle: "active", lifecycle_epoch: 0 }
              : {}),
          });
        }
        const snapshotText = () =>
          f.sql(
            `SELECT state::text FROM room_snapshots WHERE room_id='${room.id}'`,
          );
        const created = JSON.parse(snapshotText());
        const seed = {
          ...created,
          revision: 3,
          media_id: media[0].id,
          media_generation: 1,
          playback_status: "paused",
          anchor_position_ms: position,
          anchor_server_time_ms: position,
          playback_rate: 1.0000000000000002,
          duration_ms: 86400000.00000001,
        };
        const seedText = JSON.stringify(seed);
        f.sql(
          `UPDATE room_snapshots SET state='${seedText}'::jsonb WHERE room_id='${room.id}'`,
        );
        let expected = JSON.parse(snapshotText());
        compareState(expected, seed, "seed PostgreSQL JSON text", proof);
        proof.seed_database_text = snapshotText();
        proof.seed_database_text_sha256 = sha(proof.seed_database_text);
        let controller = await connect(admin, room.id, { type: "JOIN" });
        let watcher = await connect(guest, room.id, { type: "JOIN" });
        verifyEpoch(controller, room.id, owner.id);
        verifyEpoch(watcher, room.id, observer.id);
        compareState(controller.snapshot.state, expected, "owner JOIN", proof);
        compareState(watcher.snapshot.state, expected, "observer JOIN", proof);
        await controller.close();
        controller = await connect(admin, room.id, {
          type: "RESUME",
          revision: expected.revision,
          clock_epoch: expected.clock_epoch,
        });
        assert.equal(controller.snapshot.recovery, "delta");
        assert.deepEqual(controller.snapshot.events, []);
        verifyEpoch(controller, room.id, owner.id);
        compareState(controller.snapshot.state, expected, "seed RESUME", proof);
        const previousRevision = expected.revision;
        const saved = [];
        for (const [type, payload] of [
          ["SEEK", { position_ms: position }],
          ["SET_RATE", { rate: 1.0000000000000004 }],
        ]) {
          const command = {
            protocol_version: 1,
            room_id: room.id,
            command_id: randomUUID(),
            control_epoch: controller.epoch.id,
            expected_revision: expected.revision,
            media_generation: expected.media_generation,
            type,
            payload,
          };
          const beforeClock = await clock(controller);
          controller.send(command);
          const ack = await controller.next(
            "ACK",
            (value) => value.command_id === command.command_id,
          );
          const event = await watcher.next(
            "EVENT",
            (value) => value.state.revision === expected.revision + 1,
          );
          const afterClock = await clock(controller);
          const persisted = JSON.parse(snapshotText());
          assert.ok(
            persisted.anchor_server_time_ms >= beforeClock.t2 &&
              persisted.anchor_server_time_ms <= afterClock.t3,
            "Server clock bounds generated transition time",
          );
          const next = {
            ...expected,
            revision: expected.revision + 1,
            anchor_server_time_ms: persisted.anchor_server_time_ms,
            ...(type === "SEEK"
              ? { anchor_position_ms: payload.position_ms }
              : { playback_rate: payload.rate }),
          };
          compareState(persisted, next, `${type} persisted snapshot`, proof);
          compareState(ack.state, next, `${type} ACK`, proof);
          compareState(event.state, next, `${type} observer EVENT`, proof);
          assert.deepEqual(ack.action, { type, payload });
          assert.deepEqual(event.action, { type, payload });
          const durableEvent = JSON.parse(
            f.sql(
              `SELECT state::text FROM room_events WHERE room_id='${room.id}' AND revision=${next.revision}`,
            ),
          );
          compareState(durableEvent, next, `${type} persisted event`, proof);
          const result = JSON.parse(
            f.sql(
              `SELECT json_build_object('user_id',user_id,'state',state,'request_payload',request_payload)::text FROM command_results WHERE room_id='${room.id}' AND command_id='${command.command_id}'`,
            ),
          );
          assert.equal(result.user_id, owner.id);
          assert.deepEqual(result.request_payload, command);
          compareState(
            result.state,
            next,
            `${type} persisted replay result`,
            proof,
          );
          saved.push({ command, state: next });
          proof.commands.push({ command_id: command.command_id, type });
          expected = next;
        }
        await watcher.close();
        watcher = await connect(guest, room.id, {
          type: "RESUME",
          revision: previousRevision,
          clock_epoch: expected.clock_epoch,
        });
        assert.equal(watcher.snapshot.recovery, "delta");
        assert.equal(watcher.snapshot.events.length, saved.length);
        verifyEpoch(watcher, room.id, observer.id);
        compareState(
          watcher.snapshot.state,
          expected,
          "observer delta RESUME",
          proof,
        );
        watcher.snapshot.events.forEach((state, index) =>
          compareState(
            state,
            saved[index].state,
            `delta event ${index}`,
            proof,
          ),
        );
        await controller.close();
        controller = await connect(admin, room.id, { type: "JOIN" });
        verifyEpoch(controller, room.id, owner.id);
        compareState(
          controller.snapshot.state,
          expected,
          "post-command JOIN",
          proof,
        );
        const eventCount = watcher.eventCount;
        for (const entry of saved) {
          controller.send(entry.command);
          const replay = await controller.next(
            "ACK",
            (value) => value.command_id === entry.command.command_id,
          );
          compareState(
            replay.state,
            entry.state,
            `${entry.command.type} replay ACK`,
            proof,
          );
          compareState(
            JSON.parse(snapshotText()),
            expected,
            `${entry.command.type} replay leaves current snapshot`,
            proof,
          );
        }
        await delay(200);
        assert.equal(
          watcher.eventCount,
          eventCount,
          "replay emits no duplicate EVENT",
        );
        assert.equal(
          f.sql(`SELECT count(*) FROM room_events WHERE room_id='${room.id}'`),
          "2",
        );
        assert.equal(
          f.sql(
            `SELECT count(*) FROM command_results WHERE room_id='${room.id}'`,
          ),
          "2",
        );
        await controller.close();
        await watcher.close();
        proof.result = proof.checks.every((value) => value.passed)
          ? "passed"
          : "failed";
      }
      assert.equal(
        report.failures.length,
        0,
        "every full state and f64 bit pattern is exact",
      );
    },
    options,
  );
  report.result = "passed";
} catch (error) {
  failure = error;
  report.result = "failed";
  report.error = { name: error.name, message: error.message };
} finally {
  for (const ws of sockets) ws.terminate();
  if (binary) {
    report.binary.final_sha256 = sha(await readFile(binary));
    if (report.binary.final_sha256 !== report.binary.sha256) {
      failure ??= Error("Tested binary changed during execution");
      report.result = "failed";
    }
  }
  report.final_entry_sha256 = sha(await readFile(new URL(import.meta.url)));
  report.final_fixture_entry_sha256 = sha(
    await readFile(new URL("./fixtures/server.mjs", import.meta.url)),
  );
  report.final_postgres_fixture_entry_sha256 = sha(
    await readFile(new URL("./fixtures/postgres.mjs", import.meta.url)),
  );
  if (
    report.postgres_fixture_entry_sha256 !==
      report.final_postgres_fixture_entry_sha256 ||
    report.entry_sha256 !== report.final_entry_sha256 ||
    report.fixture_entry_sha256 !== report.final_fixture_entry_sha256
  ) {
    failure ??= Error("Test source changed during execution");
    report.result = "failed";
  }
  if (fixture) {
    try {
      if (fixture.databaseKind === "docker") {
        assert.equal(
          docker("ps", "-aq", "--filter", `name=^/${fixture.container}$`),
          "",
          "isolated PostgreSQL container removed",
        );
        for (const volume of report.cleanup.anonymous_volumes ?? []) {
          // The shared native fixture removes its container without --volumes.
          // These names came only from that isolated container's own Mounts.
          if (docker("volume", "ls", "-q", "--filter", `name=^${volume}$`)) {
            docker("volume", "rm", volume);
          }
          assert.equal(
            docker("volume", "ls", "-q", "--filter", `name=^${volume}$`),
            "",
          );
        }
      }
      report.cleanup.evidence = await fixture.verifyStopped();
      report.cleanup.completed = report.cleanup.evidence.completed;
    } catch (error) {
      report.cleanup.error = error.message;
      failure ??= error;
      report.result = "failed";
    }
  }
  report.finished_at = new Date().toISOString();
  if (artifactRoot) {
    await writeFile(
      resolve(artifactRoot, "report.json"),
      JSON.stringify(report, null, 2),
    );
  }
}
if (failure) throw failure;
console.log(
  `PASS: ${report.cases.length} exact-f64 native DB/WS roundtrip matrices; cleanup completed`,
);
