import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";

const agentId = randomUUID(),
  mediaId = randomUUID(),
  token = randomBytes(32).toString("hex");
let oldChecksums;
const encrypt = (value, key) => {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce);
  return Buffer.concat([
    nonce,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
};

await isolatedMediaStack(
  "nas-upgrade",
  async (f) => {
    const admin = f.client();
    await admin.login();
    const sockets = new Set();
    let agent, agentDone, agentLog;
    async function until(check, label) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await delay(30);
      }
      throw Error(`Timed out: ${label}`);
    }
    const readiness = async () =>
      (await admin.request("/agents")).find((a) => a.id === agentId);
    async function connect(path, headers) {
      const ws = new WebSocket(
        f.origin.replace("http", "ws") + "/api/v1" + path,
        { headers },
      );
      sockets.add(ws);
      const frames = [];
      ws.on("message", (bytes) => frames.push(JSON.parse(bytes)));
      ws.on("error", () => {});
      await new Promise((done, reject) => {
        ws.once("open", done);
        ws.once("error", reject);
      });
      return {
        ws,
        send: (v) => ws.send(JSON.stringify(v)),
        next: async (type) => {
          let frame;
          await until(() => {
            const index = frames.findIndex((v) => v.type === type);
            if (index < 0) return false;
            frame = frames.splice(index, 1)[0];
            return true;
          }, type);
          return frame;
        },
      };
    }
    try {
      assert.equal(
        f.sql(
          "SELECT string_agg(version||':'||encode(checksum,'hex'),',' ORDER BY version) FROM _sqlx_migrations WHERE version<=18",
        ),
        oldChecksums,
      );
      assert.equal(
        f.sql("SELECT success FROM _sqlx_migrations WHERE version=19"),
        "t",
      );
      assert.equal(
        f.sql(
          `SELECT source_version IS NULL AND available AND duration_ms=9999 AND metadata->>'fixture'='legacy' FROM media_items WHERE id='${mediaId}'`,
        ),
        "t",
      );
      assert.equal(
        (await admin.request(`/media/${mediaId}`)).title,
        "legacy movie",
      );
      let status = await readiness();
      assert.equal(status.connected, false);
      assert.equal(status.indexed_count, 1);
      assert.equal(status.unversioned_count, 1);
      assert.equal(status.source_versions, null);
      assert.equal(status.source_version_status, "rescan_required");

      const room = await admin.request("/rooms", "POST", {
        name: "NAS upgrade",
      });
      await admin.request(`/rooms/${room.id}/playlist`, "POST", {
        media_id: mediaId,
      });
      await admin.request(`/media/${mediaId}/personal-title`, "PUT", {
        title: "preserved NAS alias",
        expected_revision: "0",
      });
      const peer = await connect("/ws", {
        Origin: f.origin,
        Cookie: admin.cookie,
      });
      peer.send({ type: "JOIN", room_id: room.id });
      const snapshot = await peer.next("SNAPSHOT");
      peer.send({
        protocol_version: 1,
        room_id: room.id,
        command_id: randomUUID(),
        control_epoch: snapshot.control_epoch.id,
        expected_revision: snapshot.state.revision,
        media_generation: snapshot.state.media_generation,
        type: "CHANGE_MEDIA",
        payload: { media_id: mediaId },
      });
      const state = (await peer.next("ACK")).state;
      const blockedRequest = {
        room_id: room.id,
        media_generation: state.media_generation,
        position_ms: 0,
        mode: "direct",
        idempotency_key: randomUUID(),
      };
      const expectBlocked = async (
        request = { ...blockedRequest, idempotency_key: randomUUID() },
      ) => {
        const value = await admin.request(
          "/playback-sessions",
          "POST",
          request,
          409,
        );
        assert.equal(value.error.code, "SOURCE_VERSION_REQUIRED");
        assert.equal(value.error.retryable, false);
        assert.match(value.error.message, /扫描/);
        assert.match(value.error.message, /重新发起播放/);
      };
      await expectBlocked(blockedRequest);
      assert.equal(f.sql("SELECT count(*) FROM playback_sessions"), "0");
      console.log(
        "PASS: actual migration 0018→latest preserves NAS identity and metadata, leaves unknown versions NULL, and grants no playback",
      );

      const legacy = await connect("/agents/ws", {
        Authorization: `Bearer ${token}`,
      });
      legacy.send({ type: "HELLO", manual_scan: true });
      await until(
        async () => (await readiness()).manual_scan,
        "legacy scan capability",
      );
      const scanning = admin.request(`/agents/${agentId}/scan`, "POST");
      const request = await legacy.next("SCAN");
      legacy.send({
        type: "INDEX",
        snapshot: request.snapshot,
        sequence: 0,
        final: true,
        items: [{ resource: "legacy.mp4", title: "legacy movie" }],
      });
      await legacy.next("INDEX_ACK");
      const result = await scanning;
      assert.equal(result.status, "upgrade_required");
      assert.equal(result.count, 1);
      assert.equal(result.unversioned_count, 1);
      status = await readiness();
      assert.equal(status.source_versions, false);
      assert.equal(status.source_version_status, "upgrade_required");
      await expectBlocked();

      // A capability claim and a partial snapshot do not make an old row safe.
      legacy.send({ type: "HELLO", manual_scan: true, source_versions: true });
      legacy.send({
        type: "INDEX",
        snapshot: randomUUID(),
        sequence: 0,
        final: false,
        items: [
          {
            resource: "legacy.mp4",
            title: "uncommitted",
            source_version: `stat-v1:${"0".repeat(64)}`,
          },
        ],
      });
      await legacy.next("INDEX_ACK");
      assert.equal(
        (await readiness()).source_version_status,
        "rescan_required",
      );
      assert.equal(
        f.sql(
          `SELECT source_version IS NULL AND title='legacy movie' FROM media_items WHERE id='${mediaId}'`,
        ),
        "t",
      );
      await expectBlocked();
      legacy.ws.close();
      await until(
        async () => !(await readiness()).connected,
        "legacy disconnect",
      );
      console.log(
        "PASS: legacy rescan reports upgrade_required; capability claims and incomplete snapshots cannot bypass version safety",
      );

      const file = await f.makeClip("legacy.mp4", { pictureSeconds: 1 });
      const originalBytes = await readFile(file);
      agentLog = createWriteStream(resolve(f.root, "upgrade-agent.log"));
      agent = spawn(
        resolve(
          f.target,
          `rainsync-nas-agent${process.platform === "win32" ? ".exe" : ""}`,
        ),
        [],
        {
          env: {
            ...f.env,
            SERVER_URL: f.origin,
            AGENT_DATA_ORIGIN: f.workerOrigin,
            AGENT_TOKEN: token,
            AGENT_CREDENTIAL_FILE: resolve(f.root, "upgraded-agent-token"),
            MEDIA_ROOT: f.root,
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      agent.stdout.pipe(agentLog, { end: false });
      agent.stderr.pipe(agentLog, { end: false });
      agentDone = new Promise((done, reject) => {
        agent.once("close", done);
        agent.once("error", reject);
      });
      await until(
        async () => (await readiness()).source_version_status === "ready",
        "real Agent complete versioned startup snapshot",
      );
      status = await readiness();
      assert.equal(status.connected, true);
      assert.equal(status.source_versions, true);
      assert.equal(status.unversioned_count, 0);
      assert.equal(
        f.sql(
          `SELECT count(*) FROM media_items WHERE id='${mediaId}' AND source_id='${agentId}' AND available AND duration_ms IS NULL AND metadata='{}'::jsonb`,
        ),
        "1",
      );
      const recoveredMedia = await admin.request(`/media/${mediaId}`);
      assert.equal(recoveredMedia.title, "preserved NAS alias");
      assert.equal(recoveredMedia.original_title, "legacy");
      assert.equal(
        (await admin.request(`/rooms/${room.id}/playlist`))[0].media_id,
        mediaId,
      );
      const version = f.sql(
        `SELECT source_version FROM media_items WHERE id='${mediaId}'`,
      );
      assert.match(version, /^stat-v1:[0-9a-f]{64}$/);
      // Previously rejected idempotency keys remain rejected after remediation.
      await expectBlocked(blockedRequest);
      await f.startWorker();
      const makePlan = () =>
        admin.request("/playback-sessions", "POST", {
          ...blockedRequest,
          idempotency_key: randomUUID(),
        });
      const delivery = (plan, options = {}) => {
        const url = new URL(plan.playback_url, f.workerOrigin);
        return fetch(f.workerOrigin + url.pathname + url.search, {
          signal: AbortSignal.timeout(10000),
          ...options,
        });
      };
      const plan = await makePlan();
      let response = await delivery(plan);
      assert.equal(response.status, 200);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        originalBytes,
      );
      response = await delivery(plan, { headers: { Range: "bytes=0-31" } });
      assert.equal(response.status, 206);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        originalBytes.subarray(0, 32),
      );
      response = await delivery(plan, { method: "HEAD" });
      assert.equal(response.status, 200);
      assert.equal(
        Number(response.headers.get("content-length")),
        originalBytes.length,
      );
      assert.equal((await response.arrayBuffer()).byteLength, 0);
      console.log(
        "PASS: real upgraded Agent fills versions in place, invalidates old probe metadata, and serves pinned full/Range/HEAD bytes",
      );

      // In-place same-size edits must still invalidate the old grant.
      await delay(20);
      const changedBytes = Buffer.from(originalBytes);
      changedBytes[changedBytes.length - 1] ^= 1;
      await writeFile(file, changedBytes);
      response = await delivery(plan);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, "SOURCE_CHANGED");
      const rescanned = await admin.request(`/agents/${agentId}/scan`, "POST");
      assert.equal(rescanned.status, "complete");
      assert.equal(rescanned.count, 1);
      assert.equal(rescanned.unversioned_count, 0);
      assert.notEqual(
        f.sql(`SELECT source_version FROM media_items WHERE id='${mediaId}'`),
        version,
      );
      response = await delivery(await makePlan());
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), changedBytes);
      console.log(
        "PASS: same-size source edits reject the old grant; explicit rescan and a new playback request recover safely",
      );
    } finally {
      for (const ws of sockets) ws.terminate();
      if (agent && agent.exitCode === null) agent.kill();
      if (agentDone) await agentDone;
      if (agentLog) await new Promise((done) => agentLog.end(done));
    }
  },
  {
    beforeStart: async (f) => {
      f.sql(
        "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY,description TEXT NOT NULL,installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),success BOOLEAN NOT NULL,checksum BYTEA NOT NULL,execution_time BIGINT NOT NULL)",
      );
      for (const name of (await readdir("migrations"))
        .filter((n) => n.endsWith(".sql") && Number(n.split("_")[0]) <= 18)
        .sort()) {
        const bytes = await readFile("migrations/" + name),
          version = Number(name.split("_")[0]);
        const description = name
          .replace(/^\d+_/, "")
          .replace(/\.sql$/, "")
          .replaceAll("_", " ");
        const checksum = createHash("sha384").update(bytes).digest("hex");
        f.sql(
          `BEGIN;${bytes};INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(${version},'${description}',true,decode('${checksum}','hex'),0);COMMIT;`,
        );
      }
      oldChecksums = f.sql(
        "SELECT string_agg(version||':'||encode(checksum,'hex'),',' ORDER BY version) FROM _sqlx_migrations",
      );
      const config = encrypt(
        {
          root: "",
          url: "",
          token: "",
          user_id: "",
          agent_id: agentId,
          headers: {},
        },
        f.env.SOURCE_ENCRYPTION_KEY,
      );
      f.sql(
        `INSERT INTO agents(id,name,token_hash) VALUES('${agentId}','legacy NAS','${createHash("sha256").update(token).digest("hex")}');INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${agentId}','legacy NAS','agent','${config}');INSERT INTO media_items(id,source_id,title,resource,duration_ms,metadata) VALUES('${mediaId}','${agentId}','legacy movie','legacy.mp4',9999,'{"fixture":"legacy"}');`,
      );
    },
  },
);
