// Real Worker queue/FFmpeg and HTTP responses in an owned database. Explicit
// legacy task fixtures isolate failure handling from earlier preparation gates.
import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(process.env.W03_BACKEND_BINDING, "Use a frozen native backend");
const binding = JSON.parse(await readFile(process.env.W03_BACKEND_BINDING));
assert.equal(binding.result, "passed");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const coordinator = fileURLToPath(import.meta.url);
const coordinatorSha = sha(await readFile(coordinator));
async function verifyBinding() {
  for (const item of binding.source)
    assert.equal(
      sha(await readFile(resolve(repo, item.path))),
      item.sha256,
      item.path,
    );
  for (const item of binding.binaries)
    assert.equal(sha(await readFile(item.path)), item.sha256, item.name);
  assert.equal(sha(await readFile(coordinator)), coordinatorSha);
}
await verifyBinding();
const report = {
  schema_version: 1,
  source_digest: binding.source_digest,
  coordinator_sha256: coordinatorSha,
  scope:
    "Owned legacy job fixtures, real Worker/FFmpeg and PostgreSQL; no device or long-run acceptance",
  result: "running",
  checks: [],
};
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;
const json = (v) => `${quote(JSON.stringify(v))}::jsonb`;
let fixture, origin, originPort, workerPid, roomSocket;
const connections = new Set();
const secret = randomBytes(24).toString("hex");
try {
  origin = createServer((req, res) => {
    const status = Number(
      new URL(req.url, "http://fixture.invalid").pathname.slice(1),
    );
    assert.ok([401, 403, 404, 503].includes(status));
    res.writeHead(status, { "Content-Length": secret.length });
    res.end(secret);
  });
  origin.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  await new Promise((done) => origin.listen(0, "127.0.0.1", done));
  originPort = origin.address().port;
  await isolatedMediaStack("worker-error-classification", async (f) => {
    fixture = f;
    const admin = f.client(),
      identity = await admin.login();
    const room = await admin.request("/rooms", "POST", {
      name: "owned worker error fixture",
    });
    await writeFile(resolve(f.root, "invalid.mp4"), "not a media file");
    await f.makeClip("valid.mp4", { pictureSeconds: 2 });
    const encrypt = (value) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"),
        nonce,
      );
      return Buffer.concat([
        nonce,
        cipher.update(JSON.stringify(value)),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64");
    };
    await f.startWorker();
    workerPid = f.workerPid;
    for (const [name, status, reason, httpStatus, attempts] of [
      ["invalid.mp4", null, "media_input_invalid", 422, 1],
      ["denied-401", 401, "media_input_denied", 502, 1],
      ["denied-403", 403, "media_input_denied", 502, 1],
      ["missing", 404, "media_job_failed", 502, 1],
      ["unavailable", 503, "upstream_transport_retry_exhausted", 502, 3],
      ["valid.mp4", null, null, 200, 1],
    ]) {
      const id = randomUUID(),
        token = randomBytes(32).toString("hex");
      const resource = status
        ? {
            kind: "http",
            job_id: id,
            url: `http://127.0.0.1:${originPort}/${status}?fixture=${secret}`,
            headers: {},
          }
        : { kind: "local", job_id: id, root: f.root, resource: name };
      const media = sourceMedia(f, resource);
      const spec = {
        ...(status
          ? { input_ticket: encrypt({ token }), source_kind: "http" }
          : { root: f.root, resource: name }),
        transcode: true,
        estimated_output_bytes: 1048576,
      };
      f.sql(
        `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${quote(id)},${quote(identity.id)},${quote(room.id)},${quote(media)},0,${quote(sha(token))},${json({ encrypted: encrypt(resource) })},clock_timestamp()+interval '1 hour'); INSERT INTO media_jobs(id,session_id,status,spec) VALUES(${quote(id)},${quote(id)},'queued',${json(spec)})`,
      );
      await f.waitForSql(
        `SELECT status IN ('failed','succeeded') FROM media_jobs WHERE id=${quote(id)}`,
        "t",
        25000,
      );
      const state = JSON.parse(
        f.sql(
          `SELECT json_build_object('status',status,'attempt',attempt,'error',error) FROM media_jobs WHERE id=${quote(id)}`,
        ),
      );
      assert.deepEqual(state, {
        status: reason ? "failed" : "succeeded",
        attempt: attempts,
        error: reason,
      });
      const delivery = await fetch(
        `${f.workerOrigin}/media-delivery/${id}/index.m3u8?token=${token}`,
      );
      assert.equal(delivery.status, httpStatus);
      const readiness = await admin.raw(`/playback-sessions/${id}`);
      assert.equal(readiness.status, httpStatus);
      if (reason) {
        const code =
          reason === "upstream_transport_retry_exhausted"
            ? "MEDIA_JOB_RETRY_EXHAUSTED"
            : reason.toUpperCase();
        for (const response of [delivery, readiness]) {
          const error = await response.json();
          assert.equal(error.error.code, code);
          assert.equal(error.error.retryable, false);
          assert.equal(error.error.retry_after_ms, undefined);
          const wire = JSON.stringify(error);
          assert.ok(
            !wire.includes(secret) &&
              !wire.includes(token) &&
              !wire.includes(f.root),
          );
        }
        assert.equal(
          f.sql(
            `SELECT count(*) FROM media_outputs WHERE job_id=${quote(id)} AND status='published'`,
          ),
          "0",
        );
      } else {
        assert.ok((await delivery.text()).includes("#EXT-X-ENDLIST"));
        assert.equal((await readiness.json()).status, "ready");
      }
      await f.waitForSql(
        `SELECT count(*) FROM media_executions WHERE job_id=${quote(id)} AND reaped_at IS NULL`,
        "0",
      );
      await f.waitForSql(
        `SELECT count(*) FROM cache_write_reservations WHERE job_id=${quote(id)}`,
        "0",
      );
      await delay(250);
      assert.equal(
        f.sql(`SELECT attempt FROM media_jobs WHERE id=${quote(id)}`),
        String(attempts),
      );
      report.checks.push({
        name,
        ...state,
        http_status: httpStatus,
        no_unreaped_execution: true,
        reservation_released: true,
      });
      await admin.request(`/playback-sessions/${id}`, "DELETE");
      console.log(
        `PASS: ${name} -> ${reason ?? "succeeded"}; attempt ${attempts}; matching HTTP/readiness; drained`,
      );
    }
    await f.startServer({ WORKER_URL: f.workerOrigin });
    roomSocket = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
      headers: { Origin: f.origin, Cookie: admin.cookie },
    });
    const frames = [];
    roomSocket.on("message", (data) => frames.push(JSON.parse(data)));
    roomSocket.on("error", () => {});
    await new Promise((done, fail) => {
      roomSocket.once("open", done);
      roomSocket.once("error", fail);
    });
    const next = async (type, commandId) => {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const index = frames.findIndex(
          (v) => v.type === type && (!commandId || v.command_id === commandId),
        );
        if (index >= 0) return frames.splice(index, 1)[0];
        await delay(10);
      }
      throw Error(`Missing fixture ${type}`);
    };
    roomSocket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    const snapshot = await next("SNAPSHOT");
    let state = snapshot.state;
    for (const status of [401, 403]) {
      const media = sourceMedia(f, {
        kind: "http",
        url: `http://127.0.0.1:${originPort}/${status}?fixture=${secret}`,
      });
      const commandId = randomUUID();
      roomSocket.send(
        JSON.stringify({
          protocol_version: 1,
          room_id: room.id,
          command_id: commandId,
          control_epoch: snapshot.control_epoch.id,
          expected_revision: state.revision,
          media_generation: state.media_generation,
          type: "CHANGE_MEDIA",
          payload: { media_id: media },
        }),
      );
      state = (await next("ACK", commandId)).state;
      const response = await admin.raw("/playback-sessions", {
        method: "POST",
        body: {
          room_id: room.id,
          media_generation: state.media_generation,
          position_ms: 0,
          mode: "transcode",
          idempotency_key: randomUUID(),
        },
      });
      assert.equal(response.status, 502);
      const failure = await response.json();
      assert.equal(failure.error.code, "MEDIA_INPUT_DENIED");
      assert.equal(failure.error.retryable, false);
      assert.ok(!JSON.stringify(failure).includes(secret));
      assert.equal(
        f.sql(
          `SELECT count(*) FROM playback_sessions WHERE media_id=${quote(media)} AND NOT stopped`,
        ),
        "0",
      );
      assert.equal(
        f.sql(
          `SELECT count(*) FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id WHERE p.media_id=${quote(media)}`,
        ),
        "0",
      );
      report.checks.push({
        name: `public-prepare-denied-${status}`,
        public_code: failure.error.code,
        no_job: true,
        preparation_grant_retired: true,
      });
      console.log(
        `PASS: public preparation preserves ${status} input denial and retires its probe grant`,
      );
    }
    roomSocket.terminate();
    roomSocket = undefined;
    await verifyBinding();
  });
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failure = String(error.stack ?? error).replaceAll(
    secret,
    "[redacted]",
  );
  process.exitCode = 1;
} finally {
  roomSocket?.terminate();
  for (const socket of connections) socket.destroy();
  if (origin?.listening) await new Promise((done) => origin.close(done));
  if (fixture) {
    try {
      report.cleanup = await fixture.verifyStopped();
      report.cleanup.worker_pid_absent =
        !workerPid || verifyPidAbsent(workerPid);
      report.cleanup.origin_closed =
        !originPort || (await verifyClosedPort(originPort));
      assert.equal(report.cleanup.worker_pid_absent, true);
      assert.equal(report.cleanup.origin_closed, true);
    } catch (error) {
      report.result = "failed";
      report.cleanup_failure = String(error.message);
      process.exitCode = 1;
    }
    const path = resolve(fixture.root, "report.json");
    await writeFile(path, JSON.stringify(report, null, 2));
    console.log(`${report.result}: ${path}`);
  }
}
