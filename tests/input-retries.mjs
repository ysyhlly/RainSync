import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createHash,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
const nas = process.argv.includes("--nas");
assert.ok(process.argv.slice(2).every((arg) => arg === "--nas"));
const tag =
  process.env.WORKER_TEST_IMAGE ?? "rainsync-input-retry-validation:local";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const name = `rainsync-input-${randomUUID().slice(0, 8)}`,
  db = `${name}-db`,
  server = `${name}-server`,
  worker = `${name}-worker`;
const root = resolve(".runtime/input-retries", name);
const password = randomBytes(20).toString("hex"),
  key = randomBytes(32);
const report = {
  transport: nas ? "NAS data WebSocket fixture" : "HTTP",
  image: docker("image", "inspect", "--format", "{{.Id}}", tag),
  cases: [],
};
const sql = (q) =>
  docker(
    "exec",
    db,
    "psql",
    "-U",
    "rainsync",
    "-d",
    "rainsync",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    q,
  );
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, desc, ms = 45000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(150);
  }
  throw Error(`deadline: ${desc}`);
}
function encrypt(value) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([
    nonce,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
let fixture, active, transferPoll;
const agentId = randomUUID();
const dataSockets = new Set();
const offered = new Set();
async function transfer(request, attempt, workerBase) {
  const original = new URL(request.data_url);
  const socket = new WebSocket(
    workerBase.replace("http:", "ws:") + original.pathname + original.search,
  );
  dataSockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => dataSockets.delete(socket));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  if (active.kind === "nas_reset" && attempt === 1) {
    socket.terminate();
    return;
  }
  const keepPinging = () => {
    const timer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 250);
    socket.once("close", () => clearInterval(timer));
  };
  if (active.kind === "nas_timeout" && attempt === 1) {
    keepPinging();
    return;
  }
  const send = (data) =>
    new Promise((resolve, reject) =>
      socket.send(data, (error) => (error ? reject(error) : resolve())),
    );
  if (active.kind === "nas_denied" || active.kind === "nas_exhausted") {
    await send(
      JSON.stringify({
        status: active.kind === "nas_denied" ? 401 : 503,
        "content-length": "0",
      }),
    );
    socket.close();
    return;
  }
  if (active.kind === "nas_malformed") {
    await send('{"status":99999,"content-length":"0"}');
    socket.close();
    return;
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2]
    ? Math.min(Number(range[2]), fixture.length - 1)
    : fixture.length - 1;
  if (start > end) {
    await send(JSON.stringify({ status: 416, "content-length": "0" }));
    socket.close();
    return;
  }
  if (active.kind === "nas_ping") socket.ping();
  const excess = active.kind === "nas_excess";
  await send(
    JSON.stringify({
      status: range ? 206 : 200,
      "content-length": String(excess ? 1 : end - start + 1),
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
      ...(range
        ? { "content-range": `bytes ${start}-${end}/${fixture.length}` }
        : {}),
    }),
  );
  if (excess) {
    await send(Buffer.from([1, 2]));
    socket.close();
    return;
  }
  if (active.kind === "nas_stalled" && attempt === 1) {
    await send(fixture.subarray(start, Math.min(end + 1, start + 32768)));
    keepPinging();
    return;
  }
  const truncated = active.kind === "nas_truncated" && attempt === 1;
  const stop = truncated
    ? Math.min(end + 1, start + Math.floor(fixture.length / 2))
    : end + 1;
  for (let offset = start; !request.head && offset < stop; offset += 32768) {
    if (active.kind === "nas_ping") socket.ping();
    await send(fixture.subarray(offset, Math.min(stop, offset + 32768)));
  }
  if (truncated) socket.terminate();
  else socket.close();
}
const hlsFiles = new Map();
const upstream = createServer((req, res) => {
  if (!active || req.headers["x-test-source"] !== password) {
    res.writeHead(401).end();
    return;
  }
  const attempt = Number(
    sql(`SELECT attempt FROM media_jobs WHERE id='${active.id}'`),
  );
  active.requests.push({
    attempt,
    elapsed_ms: Date.now() - active.began,
    path: req.url,
    range: req.headers.range,
  });
  if (active.kind === "hls_unavailable") {
    const path = new URL(req.url, "http://fixture").pathname.slice(1);
    if (path === "hls0.m4s" && attempt === 1) {
      res.writeHead(503).end();
      return;
    }
    const body = hlsFiles.get(path);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(Number(range[2]), body.length - 1)
      : body.length - 1;
    if (start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${body.length}` }).end();
      return;
    }
    res
      .writeHead(range ? 206 : 200, {
        "Content-Type": path.endsWith("m3u8")
          ? "application/vnd.apple.mpegurl"
          : "video/mp4",
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
        ...(range
          ? { "Content-Range": `bytes ${start}-${end}/${body.length}` }
          : {}),
      })
      .end(body.subarray(start, end + 1));
    return;
  }
  if (active.kind === "denied") {
    res.writeHead(401).end("private upstream diagnostic");
    return;
  }
  if (
    active.kind === "exhausted" ||
    (active.kind === "unavailable" && attempt === 1)
  ) {
    res.writeHead(503).end("private transient diagnostic");
    return;
  }
  if (active.kind === "reset" && attempt === 1) {
    req.socket.destroy();
    return;
  }
  if (active.kind === "malformed") {
    res.writeHead(200, { "Content-Type": "video/mp4" }).end("not a movie");
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  const start = match ? Number(match[1]) : 0,
    end = match?.[2]
      ? Math.min(Number(match[2]), fixture.length - 1)
      : fixture.length - 1;
  if (start > end) {
    res.writeHead(416, { "Content-Range": `bytes */${fixture.length}` }).end();
    return;
  }
  res.writeHead(match ? 206 : 200, {
    "Content-Type": "video/mp4",
    "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
    ...(match
      ? { "Content-Range": `bytes ${start}-${end}/${fixture.length}` }
      : {}),
  });
  if (active.kind === "truncated" && attempt === 1) {
    res.write(
      fixture.subarray(
        start,
        Math.min(end + 1, start + Math.floor(fixture.length / 2)),
      ),
    );
    setTimeout(() => res.destroy(), 30);
    return;
  }
  res.end(fixture.subarray(start, end + 1));
});
await mkdir(root, { recursive: true });
await mkdir(resolve(root, "bin"));
await writeFile(
  resolve(root, "bin/ffmpeg"),
  '#!/bin/sh\nexec /usr/bin/ffmpeg "$@" 2>>/tmp/fixture-ffmpeg.log\n',
  { mode: 0o755 },
);
try {
  docker(
    "run",
    "--rm",
    "--mount",
    `type=bind,source=${root},target=/media`,
    tag,
    "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=25",
    "-t",
    "12",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-movflags",
    "+faststart",
    "/media/input.mp4",
  );
  fixture = await readFile(resolve(root, "input.mp4"));
  docker(
    "run",
    "--rm",
    "--mount",
    `type=bind,source=${root},target=/media`,
    tag,
    "ffmpeg",
    "-v",
    "error",
    "-i",
    "/media/input.mp4",
    "-c",
    "copy",
    "-hls_segment_type",
    "fmp4",
    "-hls_time",
    "4",
    "-hls_playlist_type",
    "vod",
    "/media/hls.m3u8",
  );
  const manifest = await readFile(resolve(root, "hls.m3u8"));
  hlsFiles.set("hls_unavailable.m3u8", manifest);
  for (const file of [
    "init.mp4",
    ...manifest
      .toString()
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#")),
  ])
    hlsFiles.set(file, await readFile(resolve(root, file)));
  report.source_sha256 = createHash("sha256").update(fixture).digest("hex");
  await new Promise((r) => upstream.listen(0, "0.0.0.0", r));
  const upstreamBase = `http://host.docker.internal:${upstream.address().port}`;
  docker("network", "create", name);
  docker(
    "run",
    "-d",
    "--name",
    db,
    "--network",
    name,
    "--network-alias",
    "db",
    "-e",
    "POSTGRES_USER=rainsync",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "postgres:17",
  );
  await until(() => {
    try {
      return docker("exec", db, "pg_isready", "-U", "rainsync").includes(
        "accepting connections",
      );
    } catch {
      return false;
    }
  }, "DB ready");
  const env = [
    "-e",
    `DATABASE_URL=postgres://rainsync:${password}@db/rainsync`,
    "-e",
    `SOURCE_ENCRYPTION_KEY=${key.toString("base64")}`,
    "-e",
    `ADMIN_PASSWORD=${password}`,
    "-e",
    "PUBLIC_ORIGIN=http://input.test",
  ];
  docker(
    "run",
    "-d",
    "--name",
    server,
    "--network",
    name,
    "-p",
    "127.0.0.1::8080",
    ...env,
    tag,
    "rainsync-server",
  );
  const base = `http://${docker("port", server, "8080/tcp")}`;
  await until(async () => {
    try {
      return (await fetch(base + "/health")).ok;
    } catch {
      return false;
    }
  }, "Server ready");
  let cookie = "",
    csrf = "";
  async function api(path, body) {
    const r = await fetch(base + "/api/v1" + path, {
      method: "POST",
      headers: {
        Origin: "http://input.test",
        Cookie: cookie,
        "x-csrf-token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (r.headers.has("set-cookie"))
      cookie = r.headers.get("set-cookie").split(";")[0];
    const v = await r.json();
    assert.equal(r.status, 200, JSON.stringify(v));
    return v;
  }
  const user = await api("/auth/login", { username: "admin", password });
  csrf = user.csrf;
  const room = await api("/rooms", { name: "Input retries" });
  const userId = sql(
    `SELECT user_id FROM room_members WHERE room_id='${room.id}'`,
  );
  assert.match(userId, /^[0-9a-f-]{36}$/);
  if (nas)
    sql(
      `INSERT INTO agents(id,name,last_seen) VALUES('${agentId}','fault fixture',now())`,
    );
  docker(
    "run",
    "-d",
    "--name",
    worker,
    "-e",
    "PATH=/fixture:/usr/local/bin:/usr/bin:/bin",
    "--mount",
    `type=bind,source=${resolve(root, "bin")},target=/fixture,readonly`,
    "--network",
    name,
    "-p",
    "127.0.0.1::8081",
    ...env,
    tag,
    "rainsync-media-worker",
  );
  const workerBase = `http://${docker("port", worker, "8081/tcp")}`;
  if (nas)
    transferPoll = setInterval(() => {
      if (!active) return;
      try {
        // The fixture controls only the data peer; production Worker authenticates
        // and consumes each real one-time transfer ticket.
        const rows = JSON.parse(
          sql(
            `SELECT COALESCE(json_agg(json_build_object('id',t.id,'request',t.request,'attempt',j.attempt)),'[]'::json) FROM agent_transfers t CROSS JOIN media_jobs j WHERE t.agent_id='${agentId}' AND j.id='${active.id}'`,
          ),
        );
        for (const row of rows) {
          if (offered.has(row.id)) continue;
          offered.add(row.id);
          active.requests.push({
            attempt: row.attempt,
            elapsed_ms: Date.now() - active.began,
            range: row.request.range,
          });
          void transfer(row.request, row.attempt, workerBase).catch(() => {});
        }
        if (
          active.kind !== "nas_offline" ||
          sql(
            `SELECT (attempt>1 OR (attempt=1 AND status='queued'))::text FROM media_jobs WHERE id='${active.id}'`,
          ) === "true"
        ) {
          sql(`UPDATE agents SET last_seen=now() WHERE id='${agentId}'`);
        }
      } catch (error) {
        report.poll_error = String(error);
      }
    }, 200);
  for (const kind of process.env.INPUT_CASE
    ? [process.env.INPUT_CASE]
    : nas
      ? [
          "nas_truncated",
          "nas_reset",
          "nas_timeout",
          "nas_stalled",
          "nas_offline",
          "nas_exhausted",
          "nas_denied",
          "nas_excess",
          "nas_malformed",
          "nas_revoked",
          "nas_ping",
        ]
      : [
          "unavailable",
          "truncated",
          "reset",
          "hls_unavailable",
          "exhausted",
          "denied",
          "malformed",
        ]) {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex");
    active = { kind, id, began: Date.now(), requests: [] };
    if (nas)
      sql(
        `UPDATE agents SET revoked=${kind === "nas_revoked"},last_seen=${kind === "nas_offline" ? "now()-interval '1 minute'" : "now()"} WHERE id='${agentId}'`,
      );
    const resource = encrypt(
      nas
        ? {
            kind: "agent",
            job_id: id,
            agent_id: agentId,
            resource: "input.mp4",
          }
        : {
            kind: "http",
            job_id: id,
            url:
              upstreamBase +
              `/${kind}.${kind === "hls_unavailable" ? "m3u8" : "mp4"}`,
            headers: { "x-test-source": password },
          },
    );
    const ticket = encrypt({ token });
    sql(
      `INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}','${userId}','${room.id}',0,'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${resource}"}',now()+interval '1 hour'); INSERT INTO media_jobs(id,session_id,status,spec) VALUES('${id}','${id}','queued','{"input_ticket":"${ticket}","transcode":true,"estimated_output_bytes":1048576}')`,
    );
    await until(
      () =>
        /^(succeeded|failed)$/.test(
          sql(`SELECT status FROM media_jobs WHERE id='${id}'`),
        ),
      kind,
    );
    const state = JSON.parse(
      sql(
        `SELECT json_build_object('status',status,'attempt',attempt,'error',error) FROM media_jobs WHERE id='${id}'`,
      ),
    );
    const outputs = JSON.parse(
      sql(
        `SELECT json_agg(json_build_object('attempt',attempt,'status',status) ORDER BY attempt) FROM media_outputs WHERE job_id='${id}'`,
      ),
    );
    active.state = state;
    active.outputs = outputs;
    const expected = [
      "nas_truncated",
      "nas_reset",
      "nas_timeout",
      "nas_stalled",
      "nas_offline",
      "nas_ping",
      "unavailable",
      "truncated",
      "reset",
      "hls_unavailable",
    ].includes(kind)
      ? "succeeded"
      : "failed";
    assert.equal(state.status, expected, kind);
    assert.equal(
      state.attempt,
      expected === "succeeded"
        ? kind === "nas_ping"
          ? 1
          : 2
        : kind.endsWith("exhausted")
          ? 3
          : 1,
      kind,
    );
    assert.ok(
      outputs
        .filter((o) => o.attempt < state.attempt)
        .every((o) => o.status === "abandoned"),
      "old output never published",
    );
    if (kind.endsWith("exhausted"))
      assert.equal(state.error, "upstream_transport_retry_exhausted");
    if (expected === "failed" && !kind.endsWith("exhausted"))
      assert.equal(state.error, "media_job_failed");
    const entry =
      workerBase + `/media-delivery/${id}/index.m3u8?token=${token}`;
    const response = await fetch(entry);
    if (expected === "succeeded") {
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(text.includes("#EXT-X-ENDLIST"));
      assert.ok(text.includes(`attempt=${state.attempt}`));
      // Decode through the authorized Worker output, not directly from its cache.
      const decoded = docker(
        "run",
        "--rm",
        tag,
        "ffmpeg",
        "-v",
        "error",
        "-i",
        entry.replace("127.0.0.1", "host.docker.internal"),
        "-t",
        "1",
        "-progress",
        "pipe:1",
        "-f",
        "null",
        "-",
      );
      assert.ok(
        [...decoded.matchAll(/^frame=(\d+)$/gm)].some((m) => Number(m[1]) > 0),
        "published output actually decodes video frames",
      );
    } else {
      const error = await response.json();
      assert.equal(
        error.error.code,
        kind.endsWith("exhausted")
          ? "MEDIA_JOB_RETRY_EXHAUSTED"
          : "MEDIA_JOB_FAILED",
      );
      assert.equal(error.error.retryable, false);
    }
    assert.equal(
      sql(`SELECT count(*) FROM cache_write_reservations WHERE job_id='${id}'`),
      "0",
    );
    const firstByAttempt = Object.values(
      Object.fromEntries(
        [...active.requests].reverse().map((r) => [r.attempt, r]),
      ),
    );
    if (state.attempt > 1 && kind !== "nas_offline")
      assert.ok(
        firstByAttempt[1].elapsed_ms - firstByAttempt[0].elapsed_ms >= 1900,
        "first retry respects backoff",
      );
    if (state.attempt > 2)
      assert.ok(
        firstByAttempt[2].elapsed_ms - firstByAttempt[1].elapsed_ms >= 4900,
        "second retry respects backoff",
      );
    if (kind === "nas_timeout" || kind === "nas_stalled") {
      assert.ok(
        firstByAttempt[1].elapsed_ms - firstByAttempt[0].elapsed_ms >=
          (kind === "nas_timeout" ? 10000 : 30000),
        "Ping does not finish the stream or extend the no-progress deadline",
      );
    }
    report.cases.push({ kind, ...state, outputs, requests: active.requests });
    sql(`UPDATE playback_sessions SET stopped=true WHERE id='${id}'`);
    console.log(
      `PASS: ${kind}: ${state.status}, ${state.attempt} attempt(s), isolated outputs and released reservation`,
    );
  }
  assert.equal(
    report.poll_error,
    undefined,
    "fixture SQL polling remained healthy",
  );
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`Evidence: ${resolve(root, "report.json")}`);
} catch (e) {
  report.failure = String(e?.stack ?? e);
  try {
    await writeFile(
      resolve(root, "ffmpeg.log"),
      docker("exec", worker, "tail", "-c", "65536", "/tmp/fixture-ffmpeg.log"),
    );
  } catch {}
  report.active = active;
  await writeFile(
    resolve(root, "failed-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  throw e;
} finally {
  clearInterval(transferPoll);
  for (const socket of dataSockets) socket.terminate();
  for (const c of [worker, server, db]) {
    try {
      docker("rm", "-f", "-v", c);
    } catch {}
  }
  try {
    docker("network", "rm", name);
  } catch {}
  await new Promise((r) => upstream.close(r));
}
