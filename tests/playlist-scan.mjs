import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";

const report = {
  started_at: new Date().toISOString(),
  result: "running",
  cases: [],
};
let artifactRoot;
try {
  await isolatedMediaStack("playlist-scan", async (f) => {
    artifactRoot = f.root;
    report.fixture = { id: f.id, container: f.container };
    report.binaries = {};
    for (const binary of ["rainsync-server", "rainsync-nas-agent"]) {
      const bytes = await readFile(
        resolve(
          f.target,
          binary + (process.platform === "win32" ? ".exe" : ""),
        ),
      );
      report.binaries[binary] = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      };
    }
    const admin = f.client();
    await admin.login();
    const sockets = [];
    const connect = async (path, headers) => {
      const ws = new WebSocket(
        f.origin.replace("http", "ws") + "/api/v1" + path,
        { headers },
      );
      sockets.push(ws);
      const frames = [];
      ws.on("message", (bytes) => frames.push(JSON.parse(bytes)));
      await new Promise((ok, no) => {
        ws.once("open", ok);
        ws.once("error", no);
      });
      const next = async (type, predicate = () => true) => {
        const until = Date.now() + 8000;
        while (Date.now() < until) {
          const index = frames.findIndex(
            (v) => v.type === type && predicate(v),
          );
          if (index >= 0) return frames.splice(index, 1)[0];
          await delay(10);
        }
        throw Error(`Missing ${type}`);
      };
      return { ws, next, send: (v) => ws.send(JSON.stringify(v)) };
    };
    try {
      await writeFile(resolve(f.root, "first.mp4"), "synthetic");
      await writeFile(resolve(f.root, "second.mp4"), "synthetic");
      const source = await admin.request("/sources", "POST", {
        name: "loop fixture",
        kind: "local",
        config: { root: f.root },
      });
      await admin.request(`/sources/${source.id}/test`, "POST");
      const media = await admin.request("/media");
      assert.equal(media.length, 2);
      f.sql(
        `UPDATE media_items SET duration_ms=10000 WHERE source_id='${source.id}'`,
      );
      const room = await admin.request("/rooms", "POST", { name: "loop" });
      const peer = await connect("/ws", {
        Origin: f.origin,
        Cookie: admin.cookie,
      });
      peer.send({ type: "JOIN", room_id: room.id });
      const snap = await peer.next("SNAPSHOT");
      let state = snap.state;
      const make = (type, payload) => ({
        protocol_version: 1,
        room_id: room.id,
        command_id: randomUUID(),
        control_epoch: snap.control_epoch.id,
        expected_revision: state.revision,
        media_generation: state.media_generation,
        type,
        payload,
      });
      const command = async (type, payload) => {
        const c = make(type, payload);
        peer.send(c);
        const v = await peer.next("ACK", (v) => v.command_id === c.command_id);
        state = v.state;
        return c;
      };
      await command("CHANGE_MEDIA", { media_id: media[0].id });
      assert.equal(state.playback_status, "playing");
      await Promise.all(
        Array.from({ length: 3 }, () =>
          admin.request(`/rooms/${room.id}/playlist`, "POST", {
            media_id: media[0].id,
          }),
        ),
      );
      await admin.request(`/rooms/${room.id}/playlist`, "POST", {
        media_id: media[1].id,
      });
      assert.equal(
        (await admin.request(`/rooms/${room.id}/playlist`)).length,
        2,
      );
      f.sql(
        `INSERT INTO playlist_items VALUES('${randomUUID()}','${room.id}','${media[0].id}',1)`,
      );
      const early = make("END_MEDIA", { position_ms: 10000 });
      peer.send(early);
      await peer.next("ERROR", (v) => v.command_id === early.command_id);
      await command("SEEK", { position_ms: 10000 });
      const ended = await command("END_MEDIA", { position_ms: 10000 });
      assert.equal(state.media_id, media[1].id);
      assert.equal(state.anchor_position_ms, 0);
      const revision = state.revision;
      peer.send(ended);
      assert.equal(
        (await peer.next("ACK", (v) => v.command_id === ended.command_id)).state
          .revision,
        revision,
      );
      peer.send({ ...ended, command_id: randomUUID() });
      await peer.next("ERROR");
      await command("SEEK", { position_ms: 10000 });
      await command("END_MEDIA", { position_ms: 10000 });
      assert.equal(state.media_id, media[0].id);
      for (const item of await admin.request(`/rooms/${room.id}/playlist`))
        await admin.request(`/rooms/${room.id}/playlist/${item.id}`, "DELETE");
      await command("SEEK", { position_ms: 10000 });
      await command("END_MEDIA", { position_ms: 10000 });
      assert.equal(state.media_id, media[0].id);
      assert.equal(state.anchor_position_ms, 0);
      await command("SEEK", { position_ms: 10000 });
      await command("PLAY");
      assert.equal(state.anchor_position_ms, 0);
      console.log(
        "PASS: play/enqueue atomic uniqueness, next, wrap, empty repeat, replay, stale/early completion",
      );
      report.cases.push({
        name: "playlist_state_and_replay",
        result: "passed",
      });

      const { agentId } = await f.startAgent();
      await f.waitForSql(
        `SELECT count(*) FROM media_items WHERE source_id='${agentId}' AND available`,
        "2",
      );
      await delay(200);
      await writeFile(resolve(f.root, "third.mp4"), "synthetic");
      await unlink(resolve(f.root, "first.mp4"));
      const scanned = await admin.request(`/agents/${agentId}/scan`, "POST");
      assert.equal(scanned.status, "complete");
      assert.equal(scanned.count, 2);
      assert.equal(
        f.sql(
          `SELECT count(*) FROM media_items WHERE source_id='${agentId}' AND title='third' AND available`,
        ),
        "1",
      );
      report.cases.push({
        name: "real_agent_manual_scan_add_remove",
        result: "passed",
        count: scanned.count,
      });
      await f.stopAgent();
      await delay(200);
      assert.equal(
        (await admin.request(`/agents/${agentId}/scan`, "POST")).status,
        "offline",
      );
      const old = await admin.request("/agents", "POST", { name: "old agent" });
      const paired = await admin.request("/agents/pair", "POST", {
        code: old.pair_code,
      });
      const legacy = await connect("/agents/ws", {
        Authorization: `Bearer ${paired.token}`,
      });
      assert.equal(
        (await admin.request(`/agents/${old.id}/scan`, "POST")).status,
        "unsupported",
      );
      legacy.send({ type: "HELLO", manual_scan: true });
      await delay(100);
      const scanning = admin.request(`/agents/${old.id}/scan`, "POST");
      const request = await legacy.next("SCAN");
      assert.equal(
        (await admin.request(`/agents/${old.id}/scan`, "POST")).status,
        "busy",
      );
      legacy.send({ type: "SCAN_BUSY", snapshot: request.snapshot });
      assert.equal((await scanning).status, "busy");
      // A controlled control socket injects a mid-snapshot scan error. This
      // checks Server rollback and the manual-scan API, not Windows chmod behavior.
      const item = (resource) => ({
        resource,
        title: resource.slice(0, -4),
        source_version: null,
      });
      const initial = admin.request(`/agents/${old.id}/scan`, "POST");
      const initialOutcome = initial.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const initialRequest = await legacy.next("SCAN");
      legacy.send({
        type: "INDEX",
        snapshot: initialRequest.snapshot,
        sequence: 0,
        final: true,
        items: [item("baseline.mp4")],
      });
      await legacy.next(
        "INDEX_ACK",
        (v) => v.snapshot === initialRequest.snapshot && v.final === true,
      );
      const seeded = await initialOutcome;
      if (seeded.error) throw seeded.error;
      assert.equal(seeded.value.status, "complete");
      assert.equal(seeded.value.count, 1);
      const interrupted = admin.request(`/agents/${old.id}/scan`, "POST");
      const interruptedOutcome = interrupted.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const interruptedRequest = await legacy.next("SCAN");
      legacy.send({
        type: "INDEX",
        snapshot: interruptedRequest.snapshot,
        sequence: 0,
        final: false,
        items: [item("partial.mp4")],
      });
      await legacy.next(
        "INDEX_ACK",
        (v) =>
          v.snapshot === interruptedRequest.snapshot &&
          v.sequence === 0 &&
          v.final === false,
      );
      const abortAt = performance.now();
      legacy.send({
        type: "INDEX_ABORT",
        snapshot: interruptedRequest.snapshot,
        sequence: 1,
      });
      await legacy.next(
        "INDEX_ABORT_ACK",
        (v) => v.snapshot === interruptedRequest.snapshot && v.sequence === 1,
      );
      const aborted = await Promise.race([
        interruptedOutcome,
        delay(5000).then(() => {
          throw Error(
            "Manual scan API did not complete after matching abort ACK",
          );
        }),
      ]);
      if (aborted.error) throw aborted.error;
      const abortElapsed = performance.now() - abortAt;
      assert.equal(aborted.value.status, "failed");
      assert.equal(aborted.value.count, 0);
      assert.ok(
        abortElapsed < 5000,
        "aborted manual scan resolves within five seconds",
      );
      assert.equal(legacy.ws.readyState, WebSocket.OPEN);
      assert.equal(
        f.sql(
          `SELECT count(*) FROM media_items WHERE source_id='${old.id}' AND resource='baseline.mp4' AND available`,
        ),
        "1",
      );
      assert.equal(
        f.sql(
          `SELECT count(*) FROM media_items WHERE source_id='${old.id}' AND resource='partial.mp4'`,
        ),
        "0",
      );
      report.cases.push({
        name: "controlled_mid_snapshot_abort_rolls_back_and_completes_api",
        result: "passed",
        elapsed_ms: abortElapsed,
        snapshot: interruptedRequest.snapshot,
      });
      const recovery = admin.request(`/agents/${old.id}/scan`, "POST");
      const recoveryOutcome = recovery.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const recoveryRequest = await legacy.next("SCAN");
      legacy.send({
        type: "INDEX",
        snapshot: recoveryRequest.snapshot,
        sequence: 0,
        final: true,
        items: [item("baseline.mp4"), item("recovered.mp4")],
      });
      await legacy.next(
        "INDEX_ACK",
        (v) => v.snapshot === recoveryRequest.snapshot && v.final === true,
      );
      const recovered = await recoveryOutcome;
      if (recovered.error) throw recovered.error;
      assert.equal(recovered.value.status, "complete");
      assert.equal(recovered.value.count, 2);
      assert.equal(
        f.sql(
          `SELECT count(*) FROM media_items WHERE source_id='${old.id}' AND resource='recovered.mp4' AND available`,
        ),
        "1",
      );
      report.cases.push({
        name: "controlled_manual_scan_recovers_after_abort",
        result: "passed",
        count: recovered.value.count,
        snapshot: recoveryRequest.snapshot,
      });
      console.log(
        "PASS: controlled mid-snapshot abort preserves committed index, API returns failed promptly, next scan recovers",
      );
      const disconnecting = admin.request(`/agents/${old.id}/scan`, "POST");
      await legacy.next("SCAN");
      legacy.ws.close();
      assert.equal((await disconnecting).status, "disconnected");
      report.cases.push({
        name: "offline_unsupported_busy_disconnect",
        result: "passed",
      });
      console.log(
        "PASS: real Agent rescan inserts/removes, offline, old Agent unsupported, concurrent busy, disconnect",
      );
    } finally {
      for (const ws of sockets) ws.terminate();
    }
  });
  report.cleanup = {
    remaining_fixture_containers: execFileSync(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `name=${report.fixture.container}`,
        "--format",
        "{{.Names}}",
      ],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    ).trim(),
  };
  assert.equal(report.cleanup.remaining_fixture_containers, "");
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = { name: error.name, message: error.message };
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  if (artifactRoot) {
    const path = resolve(artifactRoot, "report.json");
    await writeFile(path, JSON.stringify(report, null, 2));
    console.log(`Report: ${path}`);
  }
}
