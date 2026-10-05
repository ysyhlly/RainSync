import { sourceMedia } from "./fixtures/source-grant.mjs";
import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer, request } from "node:http";
import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";

if (process.platform === "win32") {
  console.log(
    "SKIP: SIGTERM graceful delivery shutdown requires POSIX signals",
  );
  process.exit(0);
}
const SIZE = 1024 * 1024 * 1024;
async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(25);
  }
  throw Error(`deadline: ${label}`);
}
await isolatedMediaStack("worker-delivery-shutdown", async (f) => {
  const client = f.client(),
    user = await client.login();
  const path = resolve(f.root, "long.mp4");
  const file = await open(path, "w");
  await file.truncate(SIZE);
  await file.close();
  const sources = new Map(),
    requests = new Set(),
    cases = [];
  const upstream = createServer((req, res) => {
    const state = { closed: false };
    sources.set(req.url, state);
    res.writeHead(200, { "Content-Length": SIZE, "Content-Type": "video/mp4" });
    let timer;
    const send = () => {
      if (res.destroyed) return;
      if (res.write(Buffer.alloc(65536))) timer = setTimeout(send, 20);
      else
        res.once("drain", () => {
          timer = setTimeout(send, 20);
        });
    };
    res.on("close", () => {
      state.closed = true;
      clearTimeout(timer);
    });
    send();
  });
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
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
  const seed = async (kind) => {
    const room = await client.request("/rooms", "POST", {
      name: `shutdown-${kind}`,
    });
    const id = randomUUID(),
      token = randomBytes(32).toString("hex");
    const resource =
      kind === "local"
        ? { kind, root: f.root, resource: "long.mp4" }
        : {
            kind,
            url: `http://127.0.0.1:${upstream.address().port}/${id}`,
            headers: {},
          };
    withPlaybackAdmission(
      f,
      { client, user: user.id, room: room.id, session: id },
      `INSERT INTO playback_sessions(media_id,id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${sourceMedia(f,resource)}','${id}','${user.id}','${room.id}',0,'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${encrypt(resource)}","upstream_closed":true}',now()+interval '1 hour')`,
    );
    return {
      kind,
      room: room.id,
      id,
      url: `${f.workerOrigin}/media-delivery/${id}/source?token=${token}`,
    };
  };
  const start = (session) => {
    const state = { session, response: undefined, aborted: false };
    const req = request(session.url, (res) => {
      state.response = res;
      res.on("error", () => {});
      res.on("aborted", () => {
        state.aborted = true;
      });
      res.pause();
    });
    requests.add(req);
    req.on("close", () => requests.delete(req));
    req.on("error", () => {});
    req.end();
    return state;
  };
  const lifecycle = (room) => client.request(`/rooms/${room}/lifecycle`);
  const close = async (room) => {
    const current = await lifecycle(room);
    await client.request(`/rooms/${room}/close`, "POST", {
      expected_revision: current.state.revision,
    });
  };
  try {
    await f.startWorker();
    const states = [];
    for (const kind of ["local", "http"]) states.push(start(await seed(kind)));
    await until(() => states.every((s) => s.response), "both source headers");
    for (const state of states) assert.equal(state.response.statusCode, 200);
    await until(
      () =>
        f.sql(
          "SELECT count(*) FROM media_executions WHERE kind='delivery' AND reaped_at IS NULL",
        ) === "2",
      "two owned deliveries",
    );
    await delay(250);
    const began = Date.now();
    await f.stopWorker(); // Fixture-owned child receives SIGTERM.
    const stoppedMs = Date.now() - began;
    assert.ok(stoppedMs < 15000, "healthy shutdown remains bounded");
    await until(
      () => sources.get(`/${states[1].session.id}`)?.closed,
      "HTTP source closes with its Worker",
    );
    for (const state of states) state.response.resume();
    await until(
      () => states.every((s) => s.aborted),
      "paused responses abort after shutdown",
    );
    await f.startWorker();
    for (const state of states) await close(state.session.room);
    await delay(4000);
    for (const state of states) {
      const status = await lifecycle(state.session.room);
      const pending = Number(
        f.sql(
          `SELECT count(*) FROM media_executions WHERE session_id='${state.session.id}' AND reaped_at IS NULL`,
        ),
      );
      cases.push({
        kind: state.session.kind,
        shutdown_ms: stoppedMs,
        undrained_deliveries: pending,
        lifecycle: status.lifecycle,
        cleanup_error: status.cleanup?.last_error,
      });
    }
    await writeFile(
      resolve(f.root, "worker-delivery-shutdown.json"),
      JSON.stringify({ cases }, null, 2) + "\n",
    );
    console.log(JSON.stringify(cases));
    for (const result of cases) {
      assert.equal(
        result.undrained_deliveries,
        0,
        `${result.kind}: graceful shutdown persists disposal receipt`,
      );
      assert.equal(
        result.lifecycle,
        "closed",
        `${result.kind}: restart and room close finish`,
      );
    }
    console.log(
      "PASS: paused local/HTTP SIGTERM drains receipts; restart and room close complete",
    );

    // Admission is detached from HTTP cancellation so a delayed INSERT/COMMIT
    // must settle and receive its disposal ACK before the Worker can exit.
    const late = await seed("http");
    const lock = f.sqlProcess(
      "BEGIN; LOCK TABLE media_executions IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(3); COMMIT",
    );
    lock.done.catch(() => {});
    await f.waitForSql(
      "SELECT count(*) FROM pg_locks WHERE relation='media_executions'::regclass AND mode='AccessExclusiveLock' AND granted",
      "1",
    );
    const pending = start(late);
    await until(
      () =>
        Number(
          f.sql(
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO media_executions%'",
          ),
        ) > 0,
      "delivery admission blocked before commit",
    );
    const lateBegan = Date.now();
    let exited = false;
    const stopped = f.stopWorker().then(() => {
      exited = true;
    });
    await delay(100);
    assert.equal(exited, false, "shutdown retains late admission ownership");
    await lock.done;
    await stopped;
    const lateStoppedMs = Date.now() - lateBegan;
    await until(() => pending.response, "shutdown rejects late preparation");
    assert.equal(pending.response.statusCode, 503);
    pending.response.resume();
    assert.equal(
      sources.has(`/${late.id}`),
      false,
      "late admission never opens its source after shutdown",
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM media_executions WHERE session_id='${late.id}' AND reaped_at IS NOT NULL`,
      ),
      "1",
    );
    await f.startWorker();
    await close(late.room);
    await until(
      async () => (await lifecycle(late.room)).lifecycle === "closed",
      "late admission room closes after restart",
    );
    cases.push({
      kind: "late-http-admission",
      shutdown_ms: lateStoppedMs,
      response_status: pending.response.statusCode,
      source_opened: false,
      undrained_deliveries: 0,
      lifecycle: "closed",
    });
    await writeFile(
      resolve(f.root, "worker-delivery-shutdown.json"),
      JSON.stringify({ cases }, null, 2) + "\n",
    );
    console.log(
      "PASS: SIGTERM waits for delayed delivery admission; no late source opens and its receipt survives restart",
    );
  } finally {
    for (const req of requests) req.destroy();
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
  }
});
