// Finite actual Server/Worker/NAS Range regression against frozen native binaries.
// Public login, pair, index, room and prepare grant every source request. The
// preview input is a real leased grant consumed by actual FFmpeg decode.
// Explicitly labeled legacy mutations exercise the actual Agent, not a mock body.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const bindingFile = process.env.RAINSYNC_NAS_RANGE_BINDING_FILE ??
  process.env.RAINSYNC_RUNTIME_METRICS_BINDING_FILE ?? process.env.W03_BACKEND_BINDING;
assert.ok(bindingFile, "Set a passed frozen native binding; this fixture never builds");
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, "Use owned native PostgreSQL");
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Use an external artifact directory");
assert.equal(process.platform, "linux", "Owned native tool PID witnesses require Linux");
const bindingBytes = await readFile(bindingFile), binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.ok(Array.isArray(binding.source) && binding.source.length > 0);
assert.ok(Array.isArray(binding.binaries) && binding.binaries.length > 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
for (const path of [
  "crates/media-core/src/http_range.rs", "crates/media-core/src/lib.rs",
  "apps/media-worker/src/main.rs", "apps/media-worker/src/relay.rs",
  "apps/media-worker/src/preview_input.rs", "apps/nas-agent/src/main.rs",
]) assert.ok(binding.source.some((item) => item.path === path), `Binding includes ${path}`);
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
for (const name of ["rainsync-server", "rainsync-media-worker", "rainsync-nas-agent"])
  assert.equal(resolve(binding.binaries.find((item) => item.name === name)?.path ?? "missing"),
    resolve(target, name), `Binding identifies executed ${name}`);
const coordinatorInputs = await Promise.all([
  "tests/nas-range-semantics.mjs", "tests/fixtures/server.mjs",
  "tests/fixtures/media-stack.mjs", "tests/fixtures/postgres.mjs",
].map(async (path) => ({ path, sha256: digest(await readFile(resolve(repo, path))) })));
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
async function verifyBinding() {
  assert.equal(digest(await readFile(bindingFile)), digest(bindingBytes), "Binding remains frozen");
  for (const input of [...binding.source, ...coordinatorInputs])
    assert.equal(await hashFile(resolve(repo, input.path)), input.sha256, `Frozen input ${input.path}`);
  for (const binary of binding.binaries)
    assert.equal(await hashFile(binary.path), binary.sha256, `Frozen binary ${binary.name}`);
}
await verifyBinding();

const report = {
  schema_version: 1, result: "failed", started_at: new Date().toISOString(), checks: [],
  scope: "Finite owned native PostgreSQL, Server, Worker and actual Agent; generated H264 and empty file; public grants; exact NAS HTTP bytes and dispatch metadata; actual ffprobe and preview FFmpeg. Legacy request mutations are explicitly synthetic control inputs to the actual Agent. No build, browser/device decode, production or long-run acceptance.",
  binding: { file: resolve(bindingFile), sha256: digest(bindingBytes), source_digest: binding.source_digest,
    binaries: binding.binaries, coordinator_inputs: coordinatorInputs },
};
const websockets = new Set(), tcpSockets = new Set(), requests = new Set();
const ownedChildren = [], streams = [];
let fixture, proxy, agent, workerPid, workerPort, failure, toolWitness;
async function until(probe, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(25);
  }
  throw Error(`Deadline: ${label}`);
}
async function check(name, run) {
  const row = { name, result: "failed" }, began = Date.now();
  report.checks.push(row);
  report.active_check = name;
  try {
    Object.assign(row, await run(), { result: "passed" });
    console.log(`PASS: ${name}`);
  } catch (error) {
    row.error = error.stack ?? String(error);
    throw error;
  } finally { row.elapsed_ms = Date.now() - began; }
}
function trackTcp(socket) {
  tcpSockets.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => tcpSockets.delete(socket));
}
function trackWs(socket) {
  websockets.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => websockets.delete(socket));
}
async function roomPeer(f, client) {
  const ws = new WebSocket(f.origin.replace("http:", "ws:") + "/api/v1/ws",
    { headers: { Origin: f.origin, Cookie: client.cookie }, handshakeTimeout: 5000 });
  const frames = [];
  trackWs(ws);
  ws.on("message", (bytes, binary) => { if (!binary) frames.push(JSON.parse(bytes)); });
  await new Promise((done, reject) => { ws.once("open", done); ws.once("error", reject); });
  return {
    send: (packet) => ws.send(JSON.stringify(packet)),
    next: (type) => until(() => {
      const index = frames.findIndex((frame) => frame.type === type);
      return index < 0 ? null : frames.splice(index, 1)[0];
    }, `Room ${type}`),
    async close() {
      if (ws.readyState < WebSocket.CLOSING) ws.close();
      await until(() => ws.readyState === WebSocket.CLOSED, "Room socket close");
    },
  };
}
function launch(file, args, env, { capture = false } = {}) {
  const log = createWriteStream(resolve(fixture.root, `owned-child-${ownedChildren.length + 1}.log`));
  streams.push(log);
  const child = spawn(file, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const record = { pid: child.pid, binary: file, closed: false, child }, chunks = [];
  ownedChildren.push(record);
  if (capture) child.stdout.on("data", (chunk) => chunks.push(chunk));
  else child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  record.done = new Promise((done) => {
    child.once("error", (error) => { record.error = error.message; });
    child.once("close", (code, signal) => {
      Object.assign(record, { closed: true, exit_code: code, signal });
      done({ code, signal, bytes: Buffer.concat(chunks) });
    });
  });
  return record;
}
async function command(file, args, { capture = false, timeout = 15000 } = {}) {
  const record = launch(file, args, fixture.env, { capture });
  const timer = setTimeout(() => record.child.kill("SIGKILL"), timeout);
  try {
    const result = await record.done;
    assert.equal(result.code, 0, `Owned ${file} completed; inspect its child log`);
    assert.equal(record.error, undefined);
    return result.bytes;
  } finally { clearTimeout(timer); }
}
async function httpBytes(url, { method = "GET", headers = {} } = {}) {
  return new Promise((done, reject) => {
    const req = request(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (bytes) => chunks.push(bytes));
      res.once("aborted", () => reject(Error("Owned HTTP response aborted")));
      res.once("error", reject);
      res.once("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    requests.add(req);
    req.once("socket", trackTcp);
    req.once("close", () => requests.delete(req));
    req.once("error", reject);
    req.setTimeout(15000, () => req.destroy(Error("Owned HTTP deadline")));
    req.end();
  });
}

// The only mutation is an armed, named legacy test: replace the next actual
// TRANSFER's Range before the actual Agent receives it. All identity, grant,
// data ticket and drain-receipt fields continue through the real services.
async function makeProxy(f) {
  const http = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const connections = [], dispatches = [], data = [];
  let legacy = null, proxyError;
  http.on("connection", trackTcp);
  http.on("upgrade", (req, socket, head) => {
    const control = req.url === "/api/v1/agents/ws";
    if (!control && !req.url.startsWith("/agent-data/")) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (peer) => {
      trackWs(peer);
      peer.pause();
      const upstream = new WebSocket((control ? f.origin : f.workerOrigin).replace("http:", "ws:") + req.url,
        { headers: control ? { Authorization: req.headers.authorization } : {}, handshakeTimeout: 5000 });
      trackWs(upstream);
      const record = { peer, upstream, control, peer_closed: false, upstream_closed: false };
      connections.push(record);
      const offer = control ? null : { id: new URL(req.url, f.workerOrigin).pathname.split("/").at(-1),
        metadata: [], binary_frames: 0, binary_bytes: 0, record };
      if (offer) data.push(offer);
      peer.on("message", (bytes, binary) => {
        if (offer) {
          if (binary) { offer.binary_frames++; offer.binary_bytes += bytes.length; }
          else offer.metadata.push(JSON.parse(bytes));
        }
        peer.pause();
        upstream.send(bytes, { binary }, (error) => {
          if (error) peer.close();
          else peer.resume();
        });
      });
      upstream.once("open", () => peer.resume());
      upstream.on("message", (bytes, binary) => {
        try {
          if (control && !binary) {
            const packet = JSON.parse(bytes);
            if (packet.type === "TRANSFER") {
              const safeRequest = (value) => ({ range: value.range ?? null, head: value.head,
                resource: value.resource, source_version: value.source_version,
                drain_receipt_required: value.drain_receipt_required });
              const observed = { id: packet.id, original: safeRequest(packet.request), legacy: null };
              if (legacy) {
                assert.equal(packet.request.resource, legacy.resource, "Legacy injection has its exact owned target");
                observed.legacy = legacy.name;
                packet.request.range = legacy.range;
                legacy = null;
                bytes = Buffer.from(JSON.stringify(packet));
              }
              observed.forwarded = safeRequest(packet.request);
              dispatches.push(observed);
            }
          }
          if (peer.readyState !== WebSocket.OPEN) return;
          upstream.pause();
          peer.send(bytes, { binary }, (error) => {
            if (error) upstream.close();
            else upstream.resume();
          });
        } catch (error) { proxyError ??= error; peer.terminate(); upstream.terminate(); }
      });
      peer.on("ping", (bytes) => { if (upstream.readyState === WebSocket.OPEN) upstream.ping(bytes); });
      upstream.on("ping", (bytes) => { if (peer.readyState === WebSocket.OPEN) peer.ping(bytes); });
      peer.once("close", () => { record.peer_closed = true; if (upstream.readyState < WebSocket.CLOSING) upstream.close(); });
      upstream.once("close", () => { record.upstream_closed = true; if (peer.readyState < WebSocket.CLOSING) peer.close(); });
      upstream.on("error", () => { if (peer.readyState < WebSocket.CLOSING) peer.close(); });
    });
  });
  await new Promise((done, reject) => http.once("error", reject).listen(0, "127.0.0.1", done));
  const port = http.address().port;
  return {
    origin: `http://127.0.0.1:${port}`, port, connections, dispatches, data,
    arm(value) { assert.equal(legacy, null, "No pending legacy mutation"); legacy = value; },
    healthy() { assert.equal(proxyError, undefined); },
    async close() {
      for (const connection of connections) { connection.peer.terminate(); connection.upstream.terminate(); }
      await until(() => connections.every((entry) => entry.peer_closed && entry.upstream_closed), "Proxy peers closed");
      await new Promise((done) => wss.close(done));
      http.closeAllConnections();
      await new Promise((done) => http.close(done));
      assert.equal(await verifyClosedPort(port), true);
    },
  };
}
function cases(size) {
  const full = (name, headers, extra = {}) => ({ name, headers, status: 200, start: 0, end: size - 1, dispatch: null, ...extra });
  const partial = (name, range, start, end) => ({ name, headers: { Range: range }, status: 206, start, end, dispatch: range });
  const empty = (name, range) => ({ name, headers: { Range: range }, status: 416, dispatch: range });
  return [
    full("full", {}),
    partial("bounded", "bytes=17-143", 17, 143),
    partial("open", "bytes=17-", 17, size - 1),
    partial("suffix", "bytes=-127", size - 127, size - 1),
    partial("tail", `bytes=${size - 1}-`, size - 1, size - 1),
    empty("empty suffix", "bytes=-0"),
    empty("start at size", `bytes=${size}-`),
    full("unsupported unit", { Range: "items=0-3" }),
    full("malformed digits", { Range: "bytes=wat-143" }),
    full("reversed", { Range: "bytes=143-17" }),
    full("start overflow", { Range: "bytes=18446744073709551616-" }),
    full("end overflow", { Range: "bytes=0-18446744073709551616" }),
    full("suffix overflow", { Range: "bytes=-18446744073709551616" }),
    full("multiple", { Range: "bytes=0-3,17-143" }),
    full("duplicate", { Range: ["bytes=0-3", "bytes=17-143"] }),
    full("If-Range strong", { Range: "bytes=17-143", "If-Range": '"owned-v1"' }),
    full("If-Range date", { Range: "bytes=17-143", "If-Range": "Wed, 21 Oct 2015 07:28:00 GMT" }),
    full("HEAD bounded", { Range: "bytes=17-143" }, { method: "HEAD" }),
    full("HEAD unsatisfiable", { Range: `bytes=${size}-` }, { method: "HEAD" }),
    full("HEAD duplicate", { Range: ["bytes=0-3", "bytes=17-143"] }, { method: "HEAD" }),
  ];
}
function emptyCases() {
  return [
    { name: "empty full", headers: {}, status: 200, dispatch: null },
    { name: "empty open", headers: { Range: "bytes=0-" }, status: 416, dispatch: "bytes=0-" },
    { name: "empty malformed", headers: { Range: "garbage" }, status: 200, dispatch: null },
    { name: "empty multiple", headers: { Range: "bytes=0-3,17-143" }, status: 200, dispatch: null },
    { name: "empty HEAD", method: "HEAD", headers: { Range: "bytes=0-" }, status: 200, dispatch: null },
  ];
}
async function exactResponse({ url, bytes, sourceVersion, resource, row, legacy = false }) {
  const before = proxy.dispatches.length, method = row.method ?? "GET";
  if (legacy) proxy.arm({ name: row.name, resource, range: row.headers.Range ?? null });
  const response = await httpBytes(url, { method, headers: legacy ? {} : row.headers });
  proxy.healthy();
  assert.equal(response.status, row.status, row.name);
  const expected = row.status === 416 || method === "HEAD" ? Buffer.alloc(0) :
    bytes.subarray(row.start ?? 0, row.end === undefined ? bytes.length : row.end + 1);
  const agentDeclaredLength = row.status === 416 ? 0 : method === "HEAD" ? bytes.length : expected.length;
  const publicDeclaredLength = row.status === 416 ? response.body.length : agentDeclaredLength;
  assert.equal(response.headers["content-length"], String(publicDeclaredLength), `${row.name}: exact public Content-Length`);
  const contentRange = row.status === 416 ? `bytes */${bytes.length}` :
    row.status === 206 ? `bytes ${row.start}-${row.end}/${bytes.length}` : undefined;
  assert.equal(response.headers["content-range"], contentRange, `${row.name}: exact Content-Range`);
  let publicError = null;
  if (row.status === 416) {
    assert.ok(response.body.length > 0 && response.body.length <= 4096, "Public 416 has a bounded JSON error body");
    assert.equal(response.headers["content-type"], "application/json");
    assert.equal(response.headers["cache-control"], "no-store");
    const envelope = JSON.parse(response.body);
    assert.deepEqual(Object.keys(envelope), ["error"], "Public body contains only its error envelope");
    assert.equal(envelope.error.code, "RANGE_NOT_SATISFIABLE");
    assert.match(envelope.error.request_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    assert.equal(envelope.error.request_id, response.headers["x-request-id"]);
    assert.equal(typeof envelope.error.message, "string");
    assert.equal(typeof envelope.error.retryable, "boolean");
    publicError = { code: envelope.error.code, request_id: envelope.error.request_id };
  } else assert.deepEqual(response.body, expected, `${row.name}: exact media body`);
  if (row.status < 400) {
    assert.equal(response.headers["accept-ranges"], "bytes");
    assert.equal(response.headers["content-type"], "video/mp4");
  }
  await until(() => proxy.dispatches.length === before + 1, `${row.name}: one dispatch`);
  const dispatch = proxy.dispatches[before];
  assert.equal(dispatch.original.resource, resource);
  assert.equal(dispatch.original.source_version, sourceVersion);
  assert.equal(dispatch.original.head, method === "HEAD");
  assert.equal(dispatch.original.drain_receipt_required, true, "Public source retains independent NAS disposal receipts");
  assert.equal(dispatch.original.range, legacy ? null : row.dispatch, `${row.name}: normalized before Agent dispatch`);
  if (legacy) {
    assert.equal(dispatch.legacy, row.name);
    assert.equal(dispatch.forwarded.range, row.headers.Range ?? null);
  } else assert.equal(dispatch.legacy, null);
  const transfer = await until(() => proxy.data.find((entry) => entry.id === dispatch.id), `${row.name}: data peer`);
  await until(() => transfer.record.peer_closed && transfer.record.upstream_closed, `${row.name}: both data peers closed`);
  assert.equal(transfer.metadata.length, 1, "Exactly one actual Agent metadata frame");
  assert.equal(transfer.metadata[0].status, row.status);
  assert.equal(transfer.metadata[0]["content-length"], String(agentDeclaredLength));
  assert.equal(transfer.metadata[0]["content-range"], contentRange);
  if (row.status < 400) assert.equal(transfer.metadata[0].source_version, sourceVersion);
  assert.equal(transfer.binary_bytes, expected.length, `${row.name}: actual Agent binary bytes`);
  if (row.status === 416) assert.equal(transfer.binary_frames, 0, "Unsatisfiable selection sends no NAS media frame");
  return { name: row.name, route: new URL(url).pathname.split("/").at(-1), method,
    status: response.status, content_length: publicDeclaredLength, agent_content_length: agentDeclaredLength,
    content_range: contentRange ?? null, public_body_bytes: response.body.length,
    public_error_body_bytes: row.status === 416 ? response.body.length : 0, public_error: publicError,
    media_body_bytes: expected.length, public_body_sha256: digest(response.body), media_body_sha256: digest(expected),
    dispatch_range: dispatch.original.range, legacy_agent_range: legacy ? dispatch.forwarded.range : null,
    agent_binary_frames: transfer.binary_frames, agent_binary_bytes: transfer.binary_bytes,
    data_peers_closed: true, synthetic_legacy_input: legacy };
}

// Record each actual Worker FFmpeg/ffprobe PID before exec, including probes.
// These bounded wrappers neither alter the command nor log its ticket arguments.
async function instrumentTools(f) {
  const tools = resolve(f.root, "owned-tools"), pids = resolve(f.root, "owned-tool-pids");
  await mkdir(tools);
  const toolBindings = [];
  for (const name of ["ffmpeg", "ffprobe"]) {
    const actual = execFileSync("which", [name], { encoding: "utf8", timeout: 5000 }).trim();
    const body = `#!/bin/sh\nprintf '%s\\n' "$$" >> ${shellQuote(pids)}\nexec ${shellQuote(actual)} "$@"\n`;
    await writeFile(resolve(tools, name), body, { mode: 0o700 });
    toolBindings.push({ name, actual, actual_sha256: await hashFile(actual), wrapper_sha256: digest(body) });
  }
  return { tools, pids, toolBindings };
}

try {
  await isolatedMediaStack("nas-range-semantics", async (f) => {
    fixture = f;
    report.fixture = { id: f.id, root: f.root, postgres: f.databaseKind };
    assert.equal(f.databaseKind, "native");
    const admin = f.client();
    await admin.login();
    const clipPath = resolve(f.root, "owned-range.mp4"), emptyPath = resolve(f.root, "owned-empty.mp4");
    await command("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
      "color=red:s=640x360:r=25:d=2", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", clipPath]);
    const clip = await readFile(clipPath), empty = Buffer.alloc(0);
    assert.ok(clip.length > 144);
    await writeFile(emptyPath, empty);
    report.media = { generated_owned_h264: true, clip_bytes: clip.length, clip_sha256: digest(clip), empty_bytes: 0 };
    toolWitness = await instrumentTools(f);
    report.tool_bindings = toolWitness.toolBindings;
    await f.startWorker({ PATH: toolWitness.tools + delimiter + process.env.PATH,
      MEDIA_PREVIEW_TIMEOUT_SECONDS: "60" });
    workerPid = f.workerPid;
    workerPort = Number(new URL(f.workerOrigin).port);
    await f.startServer({ WORKER_URL: f.workerOrigin });
    proxy = await makeProxy(f);
    const owner = await admin.request("/agents", "POST", { name: "owned finite NAS Range" });
    const paired = await admin.request("/agents/pair", "POST", { code: owner.pair_code });
    agent = launch(resolve(f.target, "rainsync-nas-agent"), [], {
      ...f.env, SERVER_URL: proxy.origin, AGENT_DATA_ORIGIN: proxy.origin,
      AGENT_TOKEN: paired.token, AGENT_CREDENTIAL_FILE: resolve(f.root, "owned-agent-token"),
      MEDIA_ROOT: f.root,
    });
    await until(() => f.sql(`SELECT count(*) FROM media_items WHERE source_id=${quote(owner.id)} AND
      resource IN ('owned-range.mp4','owned-empty.mp4') AND source_version IS NOT NULL`) === "2", "Actual versioned index");
    const indexed = JSON.parse(f.sql(`SELECT json_agg(json_build_object('id',id,'resource',resource,'source_version',source_version))
      FROM media_items WHERE source_id=${quote(owner.id)} AND resource IN ('owned-range.mp4','owned-empty.mp4')`));
    for (const item of indexed) assert.match(item.source_version, /^stat-v1:[a-f0-9]{64}$/);
    const plans = [], peers = [];
    const prepare = async (resource) => {
      const item = indexed.find((entry) => entry.resource === resource);
      const room = await admin.request("/rooms", "POST", { name: `NAS Range ${resource}` });
      const peer = await roomPeer(f, admin); peers.push(peer);
      peer.send({ type: "JOIN", room_id: room.id });
      const snapshot = await peer.next("SNAPSHOT");
      const change = { protocol_version: 1, room_id: room.id, command_id: randomUUID(),
        control_epoch: snapshot.control_epoch.id, expected_revision: snapshot.state.revision,
        media_generation: snapshot.state.media_generation, type: "CHANGE_MEDIA", payload: { media_id: item.id } };
      peer.send(change);
      const ack = await peer.next("ACK");
      assert.equal(ack.command_id, change.command_id);
      const plan = await admin.request("/playback-sessions", "POST", { room_id: room.id,
        media_generation: ack.state.media_generation, mode: "direct", position_ms: 0, idempotency_key: randomUUID() });
      assert.equal(plan.delivery_mode, "direct");
      const offered = new URL(plan.playback_url, f.workerOrigin);
      assert.match(offered.pathname, /^\/media-delivery\/[a-f0-9-]+\/file$/,
        "Public direct plan advertises its actual file route");
      const url = f.workerOrigin + offered.pathname + offered.search;
      const source = new URL(url), probe = new URL(url);
      source.pathname = source.pathname.replace(/\/file$/, "/source");
      probe.pathname = probe.pathname.replace(/\/file$/, "/probe");
      assert.equal(source.search, offered.search, "Source derives the same public session/token");
      assert.equal(probe.search, offered.search, "Probe derives the same public session/token");
      const result = { item, plan, url, sourceUrl: source.href, probeUrl: probe.href, resource };
      plans.push(result);
      return result;
    };
    const normal = await prepare("owned-range.mp4"), zero = await prepare("owned-empty.mp4");
    await check("public advertised file and source Range matrix on actual NAS bytes", async () => {
      const rows = [];
      for (const row of cases(clip.length)) rows.push(await exactResponse({ ...normal,
        url: row.name === "full" ? normal.url : normal.sourceUrl, bytes: clip,
        sourceVersion: normal.item.source_version, row }));
      return { cases: rows, count: rows.length };
    });
    await check("public empty-file Range matrix on actual NAS bytes", async () => {
      const rows = [];
      for (const row of emptyCases()) rows.push(await exactResponse({ ...zero, bytes: empty,
        sourceVersion: zero.item.source_version, row }));
      return { cases: rows, count: rows.length };
    });
    await check("actual Agent independently normalizes legacy Worker Range input", async () => {
      const names = new Set(["malformed digits", "reversed", "HEAD bounded"]);
      const rows = [];
      for (const row of cases(clip.length).filter((entry) => names.has(entry.name)))
        rows.push(await exactResponse({ ...normal, url: normal.sourceUrl, bytes: clip,
          sourceVersion: normal.item.source_version, row, legacy: true }));
      return { synthetic_control_mutations: true, actual_agent_body: true, cases: rows, count: rows.length };
    });
    await check("actual ffprobe reads the public NAS source relay", async () => {
      const before = proxy.dispatches.length;
      const response = await httpBytes(normal.probeUrl);
      assert.equal(response.status, 200);
      const meta = JSON.parse(response.body);
      assert.ok(meta.format.format_name.includes("mp4"));
      assert.ok(meta.streams.some((stream) => stream.codec_type === "video" && stream.codec_name === "h264" && stream.width === 640));
      assert.ok(proxy.dispatches.length > before, "Actual ffprobe made NAS source requests");
      const observed = proxy.dispatches.slice(before);
      assert.ok(observed.every((entry) => entry.original.resource === normal.resource &&
        entry.original.source_version === normal.item.source_version && entry.original.drain_receipt_required === true));
      return { format: meta.format.format_name, video_codec: "h264", source_dispatches: observed.length };
    });
    await check("actual preview decodes NAS input through the shared relay", async () => {
      const before = proxy.dispatches.length;
      await admin.request("/media/previews", "POST", { media_ids: [normal.item.id] });
      const cover = await f.waitForPreview(normal.item.id, "ready", 30000);
      const response = await admin.raw(cover.url.replace("/api/v1", ""));
      assert.equal(response.status, 200);
      const webp = Buffer.from(await response.arrayBuffer());
      assert.equal(webp.toString("ascii", 0, 4), "RIFF");
      assert.equal(webp.readUInt32LE(4) + 8, webp.length);
      assert.equal(webp.toString("ascii", 8, 12), "WEBP");
      const previewPath = resolve(f.root, "owned-range-preview.webp");
      await writeFile(previewPath, webp);
      const rgb = await command("ffmpeg", ["-v", "error", "-i", previewPath, "-frames:v", "1",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { capture: true });
      assert.equal(rgb.length, 640 * 360 * 3);
      const center = [...rgb.subarray((180 * 640 + 320) * 3, (180 * 640 + 320) * 3 + 3)];
      assert.ok(center[0] > 180 && center[1] < 50 && center[2] < 50, "Actual preview decoded the owned red source");
      const observed = proxy.dispatches.slice(before);
      assert.ok(observed.length > 0, "Actual preview made NAS input requests");
      assert.ok(observed.every((entry) => entry.original.resource === normal.resource &&
        entry.original.source_version === normal.item.source_version && entry.original.drain_receipt_required === false));
      return { decoded_preview_bytes: webp.length, preview_sha256: digest(webp), center_rgb: center,
        preview_input_dispatches: observed.length };
    });
    await check("source authorization and independent NAS disposal survive Range changes", async () => {
      const before = proxy.dispatches.length;
      const denied = new URL(normal.url); denied.searchParams.set("token", "owned-invalid-token");
      const response = await httpBytes(denied.href, { headers: { Range: "bytes=17-143" } });
      assert.equal(response.status, 401);
      assert.equal(proxy.dispatches.length, before, "Invalid playback grant never dispatched to NAS");
      for (const prepared of plans) await admin.request(`/playback-sessions/${prepared.plan.session_id}`, "DELETE");
      for (const peer of peers) await peer.close();
      await until(() => f.sql(`SELECT count(*) FROM agent_transfer_runs WHERE agent_id=${quote(owner.id)} AND finished_at IS NULL`) === "0",
        "All actual NAS transfers have durable terminal states");
      await until(() => f.sql(`SELECT count(*) FROM agent_transfer_runs WHERE agent_id=${quote(owner.id)} AND dispatched_at IS NOT NULL AND
        session_id IS NOT NULL AND agent_drained_at IS NULL`) === "0", "Independent actual Agent disposal receipts", 15000);
      assert.equal(f.sql(`SELECT count(*) FROM agent_transfers WHERE agent_id=${quote(owner.id)}`), "0");
      const ledger = JSON.parse(f.sql(`SELECT json_build_object('total',count(*),'finished',count(finished_at),
        'session_scoped',count(session_id),'session_scoped_drained',count(*) FILTER (WHERE session_id IS NOT NULL AND agent_drained_at IS NOT NULL),
        'preview_input',count(*) FILTER (WHERE session_id IS NULL)) FROM agent_transfer_runs WHERE agent_id=${quote(owner.id)}`));
      assert.equal(ledger.total, proxy.dispatches.length);
      assert.equal(ledger.finished, ledger.total);
      assert.equal(ledger.session_scoped_drained, ledger.session_scoped);
      assert.ok(ledger.preview_input > 0);
      return { invalid_grant_status: 401, invalid_grant_dispatches: 0, active_transfer_tickets: 0, ledger };
    });
    proxy.healthy();
    await verifyBinding();
    report.http_range_cases = report.checks.filter((entry) => entry.cases).reduce((sum, entry) => sum + entry.count, 0);
    report.actual_agent_dispatches = proxy.dispatches.length;
    report.result = "passed";
  });
} catch (error) {
  failure = error;
  report.error = error.stack ?? String(error);
} finally {
  const cleanupErrors = [];
  const attempt = async (run) => {
    try { await run(); } catch (error) { cleanupErrors.push(error.stack ?? String(error)); failure ??= error; report.result = "failed"; }
  };
  for (const req of requests) req.destroy();
  for (const record of ownedChildren) if (!record.closed) record.child.kill("SIGTERM");
  await attempt(async () => {
    await until(() => ownedChildren.every((record) => record.closed), "All directly owned children close", 15000);
    await Promise.all(ownedChildren.map((record) => record.done));
  });
  for (const ws of websockets) ws.terminate();
  if (proxy) await attempt(() => proxy.close());
  for (const socket of tcpSockets) socket.destroy();
  for (const stream of streams) await attempt(() => new Promise((done) => stream.end(done)));
  if (fixture) {
    report.cleanup = {};
    await attempt(async () => Object.assign(report.cleanup, await fixture.verifyStopped()));
    report.cleanup.worker = { pid: workerPid ?? null, pid_absent: !workerPid || verifyPidAbsent(workerPid),
      port: workerPort ?? null, port_closed: !workerPort || await verifyClosedPort(workerPort) };
    report.cleanup.direct_children = ownedChildren.map(({ pid, binary, closed, exit_code, signal }) =>
      ({ pid: pid ?? null, binary, closed, exit_code, signal, pid_absent: !pid || verifyPidAbsent(pid) }));
    let toolPids = [];
    if (toolWitness) await attempt(async () => {
      try { toolPids = [...new Set((await readFile(toolWitness.pids, "utf8")).trim().split(/\s+/).filter(Boolean).map(Number))]; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      assert.ok(toolPids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
    });
    report.cleanup.worker_tool_children = toolPids.map((pid) => ({ pid, pid_absent: verifyPidAbsent(pid) }));
    report.cleanup.proxy = { port: proxy?.port ?? null, port_closed: !proxy || await verifyClosedPort(proxy.port),
      all_websocket_peers_closed: proxy?.connections.every((entry) => entry.peer_closed && entry.upstream_closed) ?? true };
    await attempt(async () => {
      assert.equal(report.cleanup.worker.pid_absent, true);
      assert.equal(report.cleanup.worker.port_closed, true);
      assert.ok(report.cleanup.direct_children.every((record) => record.closed && record.pid_absent));
      assert.ok(report.cleanup.worker_tool_children.every((record) => record.pid_absent));
      assert.equal(report.cleanup.proxy.port_closed, true);
      assert.equal(report.cleanup.proxy.all_websocket_peers_closed, true);
      await until(() => websockets.size === 0 && tcpSockets.size === 0 && requests.size === 0, "All owned sockets and HTTP requests emitted close");
    });
    report.cleanup.websocket_count = websockets.size;
    report.cleanup.tcp_socket_count = tcpSockets.size;
    report.cleanup.http_request_count = requests.size;
    // Child stderr can mention FFmpeg's input on a failure. Keep the diagnostic
    // while retiring every owned URL/ticket before these logs become evidence.
    await attempt(async () => {
      for (const name of (await readdir(fixture.root)).filter((path) => path.endsWith(".log"))) {
        const path = resolve(fixture.root, name), text = await readFile(path, "utf8");
        const clean = text.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, "[owned URL redacted]")
          .replace(/\b(?:token|execution)=[^\s&"'<>]+/g, "[owned ticket redacted]");
        if (clean !== text) await writeFile(path, clean);
      }
      report.cleanup.child_logs_redacted = true;
    });
    report.postgres = fixture.postgresDiagnostics();
    report.cleanup_errors = cleanupErrors;
    report.finished_at = new Date().toISOString();
    const path = resolve(fixture.root, "report.json");
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
    console.log(`Evidence: ${path}`);
  }
}
if (failure) throw failure;
