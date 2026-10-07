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
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";
import { delay } from "./fixtures/server.mjs";

const LIMIT_MS = 10000;
const SIZE = 1024 * 1024 * 1024;
const ETAG = '"stream-revocation-v1"';
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
    const state = { closed: false, bytes: 0, range: req.headers.range };
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
    // Initial ranged delivery first classifies bytes 0-1023. The origin must
    // honor that probe and pin the same representation for the long stream.
    const range = ranged ? /^bytes=(\d+)-(\d+)$/.exec(req.headers.range) : null;
    if (ranged) assert.ok(range, "fixture expects a single bounded byte range");
    const start = ranged ? Number(range[1]) : 0;
    const end = ranged ? Math.min(Number(range[2]), SIZE - 1) : SIZE - 1;
    assert.ok(start <= end && start < SIZE, "fixture range is satisfiable");
    if (req.headers["if-match"]) assert.equal(req.headers["if-match"], ETAG);
    if (req.headers["if-range"]) assert.equal(req.headers["if-range"], ETAG);
    let remaining = end - start + 1;
    res.writeHead(ranged ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": remaining,
      "Accept-Ranges": "bytes",
      ETag: ETAG,
      ...(ranged ? { "Content-Range": `bytes ${start}-${end}/${SIZE}` } : {}),
    });
    if (req.method === "HEAD") return res.end();
    const send = () => {
      if (res.destroyed) return;
      const length = Math.min(65536, remaining);
      state.bytes += length;
      remaining -= length;
      const ready = res.write(Buffer.alloc(length));
      if (!remaining) return res.end();
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
        withPlaybackAdmission(
          f,
          { client: admin, user: userId, room: room.id, session: id },
          `INSERT INTO playback_sessions(media_id,id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${sourceMedia(f, resource)}','${id}','${userId}','${room.id}',0,'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${encrypt(resource)}"}',now()+interval '1 hour')`,
        );
        const url = `${f.workerOrigin}/media-delivery/${id}/source?token=${token}`;
        const ranged = revoke === "membership" || revoke === "expiry";
        const initialRequestAt = Date.now();
        const state = start(url, ranged);
        await until(() => state.response, `${label}: initial headers`);
        if (state.response.statusCode !== (ranged ? 206 : 200)) {
          // Failure-only authorization evidence never prints credentials/resources.
          const diagnostic = { case: label, status: state.response.statusCode, error_code: "UNPARSEABLE" };
          diagnostic.initial_headers_ms = Date.now() - initialRequestAt;
          const failedUpstream = upstreams.get(`${id}.mp4`);
          diagnostic.upstream = {
            observed: Boolean(failedUpstream),
            closed: failedUpstream?.closed ?? null,
            bytes: failedUpstream?.bytes ?? null,
          };
          try {
            let body = "";
            await new Promise(done => {
              const response = state.response;
              const finish = () => { clearTimeout(timer); done(); };
              const timer = setTimeout(() => { response.destroy(); finish(); }, 1000);
              response.on("data", chunk => {
                if (body.length < 8192) body += chunk.toString();
              });
              response.once("end", finish);
              response.once("close", finish);
              response.resume();
            });
            const value = JSON.parse(body);
            diagnostic.error_code = /^[A-Z_]{1,80}$/.test(value?.error?.code ?? "")
              ? value.error.code : "UNPARSEABLE";
          } catch {
            diagnostic.response_evidence_unavailable = true;
          }
          try {
            const deliveryHash = createHash("sha256").update(token).digest("hex");
            diagnostic.grant_predicates = JSON.parse(f.sql(
              `SET statement_timeout='500ms'; SELECT json_build_object('token_matches',p.delivery_token_hash='${deliveryHash}','unexpired',p.expires_at>clock_timestamp(),'stopped',p.stopped,'source_allowed',COALESCE(playback_source_allowed(p.media_id,p.resource,p.id),false),'room_active',r.lifecycle='active','epoch_matches',r.lifecycle_epoch=p.lifecycle_epoch,'generation_matches',(snap.state->>'media_generation')::bigint=p.generation,'member_present',EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id),'origin_allowed',COALESCE(playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch),false),'media_present',mi.id IS NOT NULL,'media_available',COALESCE(mi.available,false),'source_present',src.id IS NOT NULL,'source_kind_matches',src.kind='${kind}','source_revision_matches',COALESCE((p.resource->>'source_policy_revision')::bigint,0)=src.access_policy_revision,'library_allowed',COALESCE(playback_library_session_allowed(p.id),false),'delivery_registered',EXISTS(SELECT 1 FROM media_executions e WHERE e.session_id=p.id AND e.kind='delivery'),'delivery_unreaped',EXISTS(SELECT 1 FROM media_executions e WHERE e.session_id=p.id AND e.kind='delivery' AND e.reaped_at IS NULL)) FROM playback_sessions p JOIN room_snapshots snap ON snap.room_id=p.room_id JOIN rooms r ON r.id=p.room_id LEFT JOIN media_items mi ON mi.id=p.media_id LEFT JOIN sources src ON src.id=mi.source_id WHERE p.id='${id}'`,
            ).split("\n").at(-1) || "null");
          } catch {
            diagnostic.grant_evidence_unavailable = true;
          }
          console.error("Initial delivery authorization failure: " + JSON.stringify(diagnostic));
        }
        assert.equal(state.response.statusCode, ranged ? 206 : 200);
        if (ranged)
          assert.equal(
            state.response.headers["content-range"],
            `bytes 0-${SIZE - 1}/${SIZE}`,
          );
        assert.equal(Number(state.response.headers["content-length"]), SIZE);
        await delay(250); // Fill downstream buffers before revoking.
        const source = kind === "http" ? upstreams.get(`${id}.mp4`) : undefined;
        if (kind === "http") {
          assert.ok(source, `${label}: long upstream request admitted`);
          assert.equal(
            source.range,
            ranged ? `bytes=0-${SIZE - 1}` : undefined,
            "observe the delivery request rather than its classification probe",
          );
          assert.equal(
            source.closed,
            false,
            "source is live before revocation",
          );
          assert.ok(source.bytes > 0 && source.bytes < SIZE);
          assert.equal(state.response.headers.etag, ETAG);
        }
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
          await until(() => source.closed, `${label}: upstream released`);
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
      withPlaybackAdmission(
        f,
        { client: admin, user: userId, room: room.id, session: id },
        `INSERT INTO playback_sessions(media_id,id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${sourceMedia(f, resource)}','${id}','${userId}','${room.id}',0,'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${encrypt(resource)}"}',now()+interval '1 hour')`,
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
      const sessions = [];
      for (let i = 0; i < 12; i++) {
        const id = randomUUID(),
          token = randomBytes(32).toString("hex");
        sessions.push(id);
        const resource = { kind: "local", root: f.root, resource: "long.mp4" };
        withPlaybackAdmission(
          f,
          { client: admin, user: userId, room: room.id, session: id },
          `INSERT INTO playback_sessions(media_id,id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${sourceMedia(f, resource)}','${id}','${userId}','${room.id}',0,'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${encrypt(resource)}"}',now()+interval '1 hour')`,
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
      const sessionList = sessions.map((id) => `'${id}'`).join(",");
      const receiptOwners = () => f.sql(`SELECT COALESCE(jsonb_agg(jsonb_build_array(id,owner_id) ORDER BY id),'[]'::jsonb) FROM media_executions WHERE kind='delivery' AND session_id IN (${sessionList})`);
      const originalOwners = receiptOwners();
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
          `SELECT count(*) FROM pg_stat_activity WHERE application_name='${workerApplication}' AND wait_event_type='Lock' AND query LIKE 'SELECT src.id AS source_id,%' AND query LIKE '%p.delivery_token_hash=$2%' AND query LIKE '%playback_source_allowed(p.media_id,p.resource,p.id)%'`,
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
      assert.equal(
        f.sql(`SELECT count(*) FROM media_executions WHERE kind='delivery' AND session_id IN (${sessionList}) AND reaped_at IS NULL`),
        String(streams.length),
        "blocked receipts retain unresolved ownership while pool slots recover",
      );
      for (const state of streams) state.request.destroy();
      await lock.done;
      await until(
        () => f.sql(`SELECT count(*) FROM media_executions WHERE kind='delivery' AND session_id IN (${sessionList}) AND reaped_at>=created_at AND reaped_at<=clock_timestamp()`) === String(streams.length),
        `${poolLabel}: original owners retry and positively acknowledge`,
      );
      assert.equal(receiptOwners(), originalOwners, "receipt retries retain the same original owners");
      cases.push({
        scenario: poolLabel,
        stream_count: streams.length,
        blocked_authorization_checks: blockedChecks,
        response_aborted_ms: abortedMs,
        unrelated_pool_request_ms: recoveryMs,
        positively_acknowledged_original_receipts: streams.length,
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
