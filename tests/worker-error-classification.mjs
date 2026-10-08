// Real Worker queue/FFmpeg and HTTP responses in an owned database. Explicit
// login-bound synthetic jobs isolate failure handling from preparation gates.
import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer } from "node:http";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";
import { safeFailure } from "./fixtures/safe-failure.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(process.env.W03_BACKEND_BINDING, "Use a frozen native backend");
const binding = JSON.parse(await readFile(process.env.W03_BACKEND_BINDING));
assert.equal(binding.result, "passed");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const coordinator = await Promise.all(
  [
    "tests/worker-error-classification.mjs",
    "tests/fixtures/playback-admission.mjs",
    "tests/fixtures/safe-failure.mjs",
  ].map(async (path) => ({
    path,
    sha256: sha(await readFile(resolve(repo, path))),
  })),
);
const coordinatorSha = coordinator[0].sha256;
async function verifyBinding() {
  for (const item of binding.source)
    assert.equal(
      sha(await readFile(resolve(repo, item.path))),
      item.sha256,
      item.path,
    );
  for (const item of binding.binaries)
    assert.equal(sha(await readFile(item.path)), item.sha256, item.name);
  for (const item of coordinator)
    assert.equal(
      sha(await readFile(resolve(repo, item.path))),
      item.sha256,
      item.path,
    );
}
await verifyBinding();
const report = {
  schema_version: 1,
  source_digest: binding.source_digest,
  coordinator_sha256: coordinatorSha,
  coordinator,
  scope:
    "Owned login-bound synthetic job fixtures, real Worker/FFmpeg and PostgreSQL; no device or long-run acceptance",
  result: "running",
  checks: [],
};
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;
const json = (v) => `${quote(JSON.stringify(v))}::jsonb`;
let fixture, origin, originPort, workerPid, roomSocket;
let originRequests = 0;
const connections = new Set();
const secret = randomBytes(24).toString("hex");
try {
  origin = createServer((req, res) => {
    originRequests += 1;
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
    for (const [
      name,
      status,
      reason,
      httpStatus,
      attempts,
      kind,
      label = name,
    ] of [
      ["invalid.mp4", null, "media_input_invalid", 422, 1],
      ["denied-401", 401, "media_input_denied", 502, 1],
      ["denied-403", 403, "media_input_denied", 502, 1],
      ["missing", 404, "media_job_failed", 502, 1],
      ["unavailable", 503, "upstream_transport_retry_exhausted", 502, 3],
      ["valid.mp4", null, null, 200, 1],
      ["valid.mp4", null, null, 200, 1, null, "legacy-null-kind"],
      ["unknown-kind", 503, "media_job_failed", 502, 1, "future_recipe_v2"],
      ["numeric-kind", 503, "media_job_failed", 502, 1, 7],
      ["boolean-kind", 503, "media_job_failed", 502, 1, true],
      ["array-kind", 503, "media_job_failed", 502, 1, []],
      ["object-kind", 503, "media_job_failed", 502, 1, { private: secret }],
    ]) {
      report.active_check = label;
      const requestsBefore = originRequests;
      const refusedKind = kind !== undefined && kind !== null;
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
      if (kind !== undefined) spec.kind = kind;
      withPlaybackAdmission(
        f,
        { client: admin, user: identity.id, room: room.id, session: id },
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
      if (refusedKind) {
        assert.equal(
          originRequests,
          requestsBefore,
          "invalid kind cannot start an input request",
        );
        await assert.rejects(
          lstat(resolve(f.env.CACHE_ROOT, id)),
          { code: "ENOENT" },
          "invalid kind cannot create its encoder output directory",
        );
        assert.equal(
          f.sql(
            `SELECT count(*) FROM media_executions WHERE job_id=${quote(id)} AND kind='job' AND attempt=1 AND owner_id IS NOT NULL AND reaped_at IS NOT NULL`,
          ),
          "1",
          "the original claim still receives exactly one drained-attempt receipt",
        );
        const logs = (await readdir(f.root)).filter((file) =>
          /^child-\d+\.log$/.test(file),
        );
        for (const file of logs) {
          const log = await readFile(resolve(f.root, file), "utf8");
          assert.ok(
            !log.includes(secret) &&
              !log.includes(token) &&
              !log.includes(spec.input_ticket),
            "worker diagnostics must not expose private spec values",
          );
        }
      }
      await delay(250);
      assert.equal(
        f.sql(`SELECT attempt FROM media_jobs WHERE id=${quote(id)}`),
        String(attempts),
      );
      report.checks.push({
        name: label,
        ...state,
        http_status: httpStatus,
        no_unreaped_execution: true,
        reservation_released: true,
        ...(refusedKind
          ? {
              no_input_requested: true,
              no_attempt_directory: true,
              original_attempt_receipt: true,
              private_diagnostics_redacted: true,
            }
          : {}),
      });
      await admin.request(`/playback-sessions/${id}`, "DELETE");
      console.log(
        `PASS: ${label} -> ${reason ?? "succeeded"}; attempt ${attempts}; matching HTTP/readiness; drained`,
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
      report.active_check = `public-prepare-denied-${status}`;
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
    report.active_check = "verify_binding";
    await verifyBinding();
  });
  delete report.active_check;
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failure = safeFailure(error);
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
      report.cleanup_failure = safeFailure(error);
      process.exitCode = 1;
    }
    const path = resolve(fixture.root, "report.json");
    await writeFile(path, JSON.stringify(report, null, 2));
    console.log(`${report.result}: ${path}`);
  }
}
