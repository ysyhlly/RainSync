import { sourceMedia } from "./fixtures/source-grant.mjs";
import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer, request } from "node:http";
import { open, readdir, readlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";

const LIMIT_MS = 10000;
const SIZE = 1024 * 1024 * 1024;
const selected = process.env.RAINSYNC_STREAM_CASE;
const cases = [];
async function until(check, label, timeout = LIMIT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw Error(`deadline: ${label}`);
}

await isolatedMediaStack("stream-revocation", async (f) => {
  const admin = f.client();
  const user = await admin.login();
  const userId = user.id;
  const localPath = resolve(f.root, "long.mp4");
  const file = await open(localPath, "w");
  await file.truncate(SIZE);
  await file.close();
  const requests = new Set();
  const upstreams = new Map();
  const upstream = createServer((req, res) => {
    const key = new URL(req.url, "http://fixture").pathname.slice(1);
    const state = { closed: false, bytes: 0 };
    upstreams.set(key, state);
    let timer;
    res.on("close", () => {
      state.closed = true;
      clearTimeout(timer);
    });
    if (key.startsWith("prepare-")) {
      const mode = key.split("/")[0].slice("prepare-".length);
      // Keep the origin connection live without downstream headers. For the
      // buffered formats, send often enough to avoid the upstream read timeout.
      if (mode === "headers") return;
      res.writeHead(200, {
        "Content-Type":
          mode === "manifest" ? "application/vnd.apple.mpegurl" : "text/vtt",
      });
      res.write(mode === "manifest" ? "#EXTM3U\n" : "WEBVTT\n\n");
      const send = () => {
        if (res.destroyed) return;
        const chunk = mode === "manifest" ? "# waiting\n" : "NOTE waiting\n\n";
        state.bytes += Buffer.byteLength(chunk);
        res.write(chunk);
        timer = setTimeout(send, 100);
      };
      send();
      return;
    }
    const ranged = Boolean(req.headers.range);
    res.writeHead(ranged ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": SIZE,
      "Accept-Ranges": "bytes",
      ...(ranged ? { "Content-Range": `bytes 0-${SIZE - 1}/${SIZE}` } : {}),
    });
    const send = () => {
      if (res.destroyed) return;
      state.bytes += 65536;
      const ready = res.write(Buffer.alloc(65536));
      // A genuinely slow remote source also tests pending .next(), not only
      // a source that always has a chunk ready. Stop before declaring EOF.
      if (ready) timer = setTimeout(send, 20);
      else
        res.once("drain", () => {
          timer = setTimeout(send, 20);
        });
    };
    send();
  });
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
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
  async function openHandles() {
    if (process.platform !== "linux") return undefined;
    const paths = await readdir(`/proc/${f.workerPid}/fd`);
    let count = 0;
    for (const path of paths) {
      try {
        if ((await readlink(`/proc/${f.workerPid}/fd/${path}`)) === localPath)
          count++;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return count;
  }
  function start(url, range) {
    const state = { bytes: 0, aborted: false, ended: false };
    const req = request(
      url,
      { headers: range ? { Range: `bytes=0-${SIZE - 1}` } : {} },
      (res) => {
        state.response = res;
        res.on("error", () => {});
        res.on("aborted", () => {
          state.aborted = true;
        });
        res.on("end", () => {
          state.ended = true;
        });
        res.on("data", (chunk) => {
          state.bytes += chunk.length;
        });
        res.pause();
      },
    );
    req.on("error", () => {});
    requests.add(req);
    req.on("close", () => requests.delete(req));
    req.end();
    state.request = req;
    return state;
  }
  try {
    const databaseUrl = new URL(f.env.DATABASE_URL);
    const workerApplication = `stream-revocation-${f.id}`;
    databaseUrl.searchParams.set("application_name", workerApplication);
    await f.startWorker({ DATABASE_URL: databaseUrl.toString() });
    // A separate room for each case avoids persisted room actor state and does
    // not restore revoked grants: tests never pretend a revoked token is safe.
    for (const kind of ["local", "http"]) {
      for (const revoke of [
        "stop",
        "membership",
        "generation",
        "expiry",
        "database-stall",
        "consumer-drop",
      ]) {
        const label = `${kind}-${revoke}`;
        if (selected && selected !== label) continue;
        const room = await admin.request("/rooms", "POST", { name: label });
        const id = randomUUID(),
          token = randomBytes(32).toString("hex");
        const resource =
          kind === "local"
            ? { kind, root: f.root, resource: "long.mp4" }
            : { kind, url: `${upstreamOrigin}/${id}.mp4`, headers: {} };
        f.sql(
          `INSERT INTO playback_sessions(media_id,id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${sourceMedia(f,resource)}','${id}','${userId}','${room.id}',0,'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${encrypt(resource)}"}',now()+interval '1 hour')`,
        );
        const url = `${f.workerOrigin}/media-delivery/${id}/source?token=${token}`;
        const ranged = revoke === "membership" || revoke === "expiry";
        const state = start(url, ranged);
        await until(() => state.response, `${label}: initial headers`);
        assert.equal(state.response.statusCode, ranged ? 206 : 200);
        if (ranged)
          assert.equal(
            state.response.headers["content-range"],
            `bytes 0-${SIZE - 1}/${SIZE}`,
          );
        assert.equal(Number(state.response.headers["content-length"]), SIZE);
        await delay(250); // Fill downstream buffers before revoking.
        if (kind === "local" && process.platform === "linux")
          assert.ok((await openHandles()) > 0);
        let lock;
        const began = Date.now();
        if (revoke === "stop")
          f.sql(`UPDATE playback_sessions SET stopped=true WHERE id='${id}'`);
        if (revoke === "membership")
          f.sql(
            `DELETE FROM room_members WHERE room_id='${room.id}' AND user_id='${userId}'`,
          );
        if (revoke === "generation")
          f.sql(
            `UPDATE room_snapshots SET state=jsonb_set(state,'{media_generation}','1') WHERE room_id='${room.id}'`,
          );
        if (revoke === "expiry")
          f.sql(
            `UPDATE playback_sessions SET expires_at=now()-interval '1 second' WHERE id='${id}'`,
          );
        if (revoke === "database-stall") {
          lock = f.sqlProcess(
            "BEGIN; LOCK TABLE playback_sessions IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(8); ROLLBACK",
          );
          await f.waitForSql(
            "SELECT count(*) FROM pg_locks WHERE relation='playback_sessions'::regclass AND mode='AccessExclusiveLock' AND granted",
            "1",
          );
        }
        if (revoke === "consumer-drop") state.request.destroy();
        // Resource closure is observed before resuming the slow consumer. A
        // per-chunk-only check would fail this assertion under backpressure.
        if (kind === "local" && process.platform === "linux")
          await until(
            async () => (await openHandles()) === 0,
            `${label}: local descriptor released`,
          );
        if (kind === "http")
          await until(
            () => upstreams.get(`${id}.mp4`)?.closed,
            `${label}: upstream released`,
          );
        const releasedMs = Date.now() - began;
        if (revoke !== "consumer-drop") {
          state.response.resume();
          await until(
            () => state.aborted,
            `${label}: existing response aborted`,
            Math.max(1, LIMIT_MS - (Date.now() - began)),
          );
          assert.equal(state.ended, false);
          assert.ok(
            state.bytes < SIZE,
            "never deliver declared complete body after revocation",
          );
        }
        assert.ok(
          Date.now() - began < LIMIT_MS,
          `${label}: 10-second revocation bound`,
        );
        const abortedMs = Date.now() - began;
        if (lock) await lock.done;
        if (!["database-stall", "consumer-drop"].includes(revoke)) {
          const next = await fetch(url, { signal: AbortSignal.timeout(5000) });
          assert.equal(next.status, 401, "new request rejected too");
          await next.arrayBuffer();
        }
        state.request.destroy();
        cases.push({
          scenario: label,
          ranged,
          source_released_ms: releasedMs,
          response_aborted_ms: abortedMs,
          received_bytes: state.bytes,
          descriptor_checked: kind === "local" && process.platform === "linux",
        });
        console.log(
          `PASS ${label}: released=${releasedMs}ms; aborted=${state.aborted}; bytes=${state.bytes}`,
        );
      }
    }
    for (const [mode, revoke] of [
      ["headers", "stop"],
      ["manifest", "stop"],
      ["subtitle", "stop"],
      ["manifest", "database-stall"],
    ]) {
      const label = `http-prepare-${mode}-${revoke}`;
      if (selected && selected !== label) continue;
      const room = await admin.request("/rooms", "POST", { name: label });
      const id = randomUUID(),
        token = randomBytes(32).toString("hex");
      const key = `prepare-${mode}/${id}`;
      const resource = {
        kind: "http",
        url: `${upstreamOrigin}/${key}`,
        headers: {},
        ...(mode === "subtitle"
          ? {
              subtitle_indices: [0],
              subtitle_urls: { 0: `${upstreamOrigin}/${key}` },
              upstream_base: upstreamOrigin,
            }
          : {}),
      };
      f.sql(
        `INSERT INTO playback_sessions(media_id,id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${sourceMedia(f,resource)}','${id}','${userId}','${room.id}',0,'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${encrypt(resource)}"}',now()+interval '1 hour')`,
      );
      const path = mode === "subtitle" ? "subtitle-0.vtt" : "source";
      const url = `${f.workerOrigin}/media-delivery/${id}/${path}?token=${token}`;
      const state = start(url, false);
      await until(() => upstreams.has(key), `${label}: upstream admitted`);
      await delay(250);
      assert.equal(
        state.response,
        undefined,
        "preparation has not sent headers",
      );
      let lock;
      const began = Date.now();
      if (revoke === "database-stall") {
        lock = f.sqlProcess(
          "BEGIN; LOCK TABLE playback_sessions IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(8); ROLLBACK",
        );
        await f.waitForSql(
          "SELECT count(*) FROM pg_locks WHERE relation='playback_sessions'::regclass AND mode='AccessExclusiveLock' AND granted",
          "1",
        );
      } else {
        f.sql(`UPDATE playback_sessions SET stopped=true WHERE id='${id}'`);
      }
      await until(
        () => upstreams.get(key).closed,
        `${label}: upstream released`,
      );
      const releasedMs = Date.now() - began;
      await until(
        () => state.response,
        `${label}: rejected before success headers`,
        Math.max(1, LIMIT_MS - (Date.now() - began)),
      );
      assert.equal(
        state.response.statusCode,
        revoke === "database-stall" ? 503 : 401,
      );
      state.response.resume();
      await until(
        () => state.ended,
        `${label}: complete error response`,
        Math.max(1, LIMIT_MS - (Date.now() - began)),
      );
      assert.equal(
        state.aborted,
        false,
        "pre-header denial is a complete response",
      );
      const finishedMs = Date.now() - began;
      assert.ok(finishedMs < LIMIT_MS, `${label}: 10-second revocation bound`);
      if (lock) await lock.done;
      state.request.destroy();
      cases.push({
        scenario: label,
        source_released_ms: releasedMs,
        response_finished_ms: finishedMs,
        response_status: state.response.statusCode,
        received_bytes: state.bytes,
      });
      console.log(
        `PASS ${label}: released=${releasedMs}ms; status=${state.response.statusCode}`,
      );
    }
    const poolLabel = "local-pool-recovery-database-stall";
    if (!selected || selected === poolLabel) {
      const room = await admin.request("/rooms", "POST", { name: poolLabel });
      const streams = [];
      for (let i = 0; i < 12; i++) {
        const id = randomUUID(),
          token = randomBytes(32).toString("hex");
        const resource = { kind: "local", root: f.root, resource: "long.mp4" };
        f.sql(
          `INSERT INTO playback_sessions(media_id,id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${sourceMedia(f,resource)}','${id}','${userId}','${room.id}',0,'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${encrypt(resource)}"}',now()+interval '1 hour')`,
        );
        streams.push(
          start(
            `${f.workerOrigin}/media-delivery/${id}/source?token=${token}`,
            false,
          ),
        );
      }
      await until(
        () => streams.every((state) => state.response),
        `${poolLabel}: all headers`,
      );
      for (const state of streams) assert.equal(state.response.statusCode, 200);
      await delay(250);
      const began = Date.now();
      const lock = f.sqlProcess(
        "BEGIN; LOCK TABLE playback_sessions IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(14); ROLLBACK",
      );
      // Keep fixture cleanup failures handled even if a regression assertion fails.
      lock.done.catch(() => {});
      await f.waitForSql(
        `SELECT count(*) FROM pg_stat_activity WHERE application_name='${workerApplication}' AND wait_event_type='Lock'`,
        "12",
        5000,
      );
      const blockedChecks = Number(
        f.sql(
          `SELECT count(*) FROM pg_stat_activity WHERE application_name='${workerApplication}' AND wait_event_type='Lock' AND query LIKE 'SELECT src.id AS source_id,%' AND query LIKE '%p.delivery_token_hash=$2%' AND query LIKE '%playback_source_allowed(p.media_id,p.resource)%'`,
        ),
      );
      assert.ok(
        blockedChecks >= 10,
        "authorization checks occupy the saturated pool alongside background jobs",
      );
      if (process.platform === "linux")
        await until(
          async () => (await openHandles()) === 0,
          `${poolLabel}: paused sources released`,
          Math.max(1, LIMIT_MS - (Date.now() - began)),
        );
      for (const state of streams) state.response.resume();
      await until(
        () => streams.every((state) => state.aborted),
        `${poolLabel}: all streams aborted`,
      );
      const abortedMs = Date.now() - began;
      assert.ok(
        abortedMs < LIMIT_MS,
        `${poolLabel}: 10-second cancellation bound`,
      );
      if (process.platform === "linux") assert.equal(await openHandles(), 0);
      // This route checks unrelated agent tables using the same 12-connection
      // worker pool. A cancelled auth query must not pin every slot until the
      // playback table lock expires. No real Agent or valid ticket is involved.
      const handshakeBegan = Date.now();
      const socket = new WebSocket(
        `${f.workerOrigin.replace("http:", "ws:")}/agent-data/${randomUUID()}?token=unissued-test-token`,
      );
      try {
        const status = await new Promise((done, reject) => {
          const deadline = setTimeout(
            () =>
              reject(Error(`${poolLabel}: cancelled checks pinned pool slots`)),
            2000,
          );
          socket.once("unexpected-response", (_, response) => {
            clearTimeout(deadline);
            response.resume();
            done(response.statusCode);
          });
          socket.once("open", () => {
            clearTimeout(deadline);
            reject(Error(`${poolLabel}: invalid transfer admitted`));
          });
          socket.on("error", () => {});
        });
        assert.equal(status, 401);
      } finally {
        socket.terminate();
      }
      const recoveryMs = Date.now() - handshakeBegan;
      assert.equal(
        f.sql(
          "SELECT count(*) FROM pg_locks WHERE relation='playback_sessions'::regclass AND mode='AccessExclusiveLock' AND granted",
        ),
        "1",
        "unrelated pool request completes before the playback lock releases",
      );
      for (const state of streams) state.request.destroy();
      await lock.done;
      cases.push({
        scenario: poolLabel,
        stream_count: streams.length,
        blocked_authorization_checks: blockedChecks,
        response_aborted_ms: abortedMs,
        unrelated_pool_request_ms: recoveryMs,
      });
      console.log(
        `PASS ${poolLabel}: aborted=${abortedMs}ms; pool request=${recoveryMs}ms`,
      );
    }
    await writeFile(
      resolve(f.root, "stream-revocation.json"),
      JSON.stringify(
        {
          cases,
          limit_ms: LIMIT_MS,
          caveat:
            "Application source/stream cancellation only. Bytes already buffered in network or browser cannot be recalled.",
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `PASS: ${cases.length} isolated long-response cancellation cases`,
    );
  } finally {
    for (const req of requests) req.destroy();
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
  }
});
