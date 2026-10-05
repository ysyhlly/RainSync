import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  createHash,
  createCipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer, request } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { withPlaybackAdmission } from "./fixtures/playback-admission.mjs";
import { sourceMedia } from "./fixtures/source-grant.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyPidAbsent } from "./fixtures/postgres.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(
  process.env.W03_BACKEND_BINDING,
  "Use a successfully frozen backend binding",
);
const binding = JSON.parse(await readFile(process.env.W03_BACKEND_BINDING));
assert.equal(binding.result, "passed");
const coordinatorSha = hash(await readFile(fileURLToPath(import.meta.url)));
async function verifyBinding() {
  for (const item of binding.source)
    assert.equal(
      hash(await readFile(resolve(repo, item.path))),
      item.sha256,
      item.path,
    );
  for (const item of binding.binaries)
    assert.equal(await hashFile(item.path), item.sha256, item.name);
  assert.equal(
    hash(await readFile(fileURLToPath(import.meta.url))),
    coordinatorSha,
  );
}
async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(30);
  }
  throw Error(`Timed out: ${label}`);
}

await verifyBinding();
let fixture;
const checks = [];
const agentProcesses = [];
await isolatedMediaStack("nas-missing-root-receipts", async (f) => {
  fixture = f;
  const admin = f.client(),
    identity = await admin.login();
  const mediaRoot = resolve(f.root, "media-mount"),
    credentials = resolve(f.root, "agent-token");
  const receiptPath = `${credentials}.drained.json`;
  const filePath = resolve(mediaRoot, "long.mp4");
  await mkdir(mediaRoot);
  const file = await open(filePath, "w");
  await file.truncate(128 * 1024 * 1024);
  await file.close();
  const owner = await admin.request("/agents", "POST", {
    name: "missing mount receipt owner",
  });
  const children = new Set(),
    sockets = new Set(),
    logs = [],
    requests = new Set();
  let launch = 0,
    agent,
    releaseLock;
  const binary = resolve(
    f.target,
    `rainsync-nas-agent${process.platform === "win32" ? ".exe" : ""}`,
  );
  async function startAgent(extra = {}) {
    const log = createWriteStream(
      resolve(f.root, `receipt-agent-${++launch}.log`),
    );
    logs.push(log);
    const child = spawn(binary, [], {
      env: {
        ...f.env,
        SERVER_URL: f.origin,
        AGENT_DATA_ORIGIN: f.workerOrigin,
        PAIR_CODE: owner.pair_code,
        AGENT_TOKEN: undefined,
        MEDIA_ROOT: mediaRoot,
        AGENT_CREDENTIAL_FILE: credentials,
        ...extra,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const record = { pid: child.pid ?? null, closed: false, exit_code: null };
    agentProcesses.push(record);
    child.done = new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        children.delete(child);
        Object.assign(record, { closed: true, exit_code: code });
        done(code);
      });
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    return child;
  }
  async function stop(child) {
    if (child && child.exitCode === null) {
      child.kill();
      assert.equal(await child.done, 0, "Agent shuts down cleanly");
    }
  }
  const agentView = async (id) =>
    (await admin.request("/agents")).find((a) => a.id === id);
  async function openFiles() {
    let count = 0;
    for (const fd of await readdir(`/proc/${agent.pid}/fd`)) {
      try {
        if ((await readlink(`/proc/${agent.pid}/fd/${fd}`)) === filePath)
          count++;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return count;
  }
  async function drainSocket(token) {
    const ws = new WebSocket(
      f.origin.replace("http", "ws") + "/api/v1/agents/drain-ws",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    sockets.add(ws);
    const frames = [];
    let closed = false;
    ws.on("message", (bytes) => frames.push(JSON.parse(bytes)));
    ws.on("error", () => {});
    ws.on("close", () => {
      closed = true;
    });
    await new Promise((done, reject) => {
      ws.once("open", done);
      ws.once("error", reject);
    });
    return {
      ws,
      frames,
      isClosed: () => closed,
      send: (value) => ws.send(JSON.stringify(value)),
      ack: async (id) => {
        let found;
        await until(() => {
          const index = frames.findIndex(
            (v) => v.type === "TRANSFER_DRAINED_ACK" && v.id === id,
          );
          if (index < 0) return false;
          found = frames.splice(index, 1)[0];
          return true;
        }, `drain ACK ${id}`);
        return found;
      },
    };
  }
  async function pair(name) {
    const created = await admin.request("/agents", "POST", { name });
    return {
      id: created.id,
      ...(await admin.request("/agents/pair", "POST", {
        code: created.pair_code,
      })),
    };
  }
  const encrypt = (value) => {
    const nonce = randomBytes(12),
      cipher = createCipheriv(
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
  async function makeSession(label) {
    const room = await admin.request("/rooms", "POST", { name: label });
    const session = randomUUID(),
      token = randomBytes(32).toString("hex");
    const sourceVersion = f.sql(
      `SELECT source_version FROM media_items WHERE source_id='${owner.id}' AND resource='long.mp4'`,
    );
    const resource = {
      kind: "agent",
      agent_id: owner.id,
      resource: "long.mp4",
      source_version: sourceVersion,
    };
    withPlaybackAdmission(
      f,
      { client: admin, user: identity.id, room: room.id, session },
      `INSERT INTO playback_sessions(media_id,id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${sourceMedia(f, resource)}','${session}','${identity.id}','${room.id}',0,'${hash(token)}','{"encrypted":"${encrypt(resource)}"}',now()+interval '1 hour')`,
    );
    return { room, session, token };
  }
  async function closeRoom(room) {
    const view = await admin.request(`/rooms/${room.id}/lifecycle`);
    await admin.request(`/rooms/${room.id}/close`, "POST", {
      expected_revision: view.state.revision,
    });
  }
  try {
    await f.startWorker();
    agent = await startAgent();
    await until(
      () =>
        f.sql(
          `SELECT count(*) FROM media_items WHERE source_id='${owner.id}' AND resource='long.mp4' AND source_version IS NOT NULL`,
        ) === "1",
      "ordinary root index",
    );
    const initialCredentials = await readFile(credentials);
    const ownerToken = JSON.parse(initialCredentials).token;
    const mapped = await makeSession(
      "persisted NAS receipt with missing mount",
    );
    const stream = { response: null, aborted: false };
    const req = request(
      `${f.workerOrigin}/media-delivery/${mapped.session}/source?token=${mapped.token}`,
      (response) => {
        stream.response = response;
        response.on("error", () => {});
        response.on("aborted", () => {
          stream.aborted = true;
        });
        response.pause();
      },
    );
    req.on("error", () => {});
    requests.add(req);
    req.end();
    await until(() => stream.response, "real NAS response");
    assert.equal(stream.response.statusCode, 200);
    await until(
      async () => (await openFiles()) > 0,
      "real NAS descriptor retained",
    );
    const transfer = f.sql(
      `SELECT id FROM agent_transfer_runs WHERE session_id='${mapped.session}'`,
    );
    assert.match(transfer, /^[a-f\d-]{36}$/);
    const lockTag = `missing-mount-receipt-${randomUUID()}`;
    const holder = f.sqlProcess(
      `BEGIN; SELECT id FROM agent_transfer_runs WHERE id='${transfer}' FOR UPDATE; SELECT pg_sleep(90) /* ${lockTag} */; COMMIT`,
    );
    holder.done.catch(() => {});
    await f.waitForSql(
      `SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${lockTag}%'`,
      "1",
    );
    releaseLock = async () => {
      f.sql(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${lockTag}%'`,
      );
      await holder.done.catch(() => {});
    };
    await closeRoom(mapped.room);
    await until(
      async () => (await openFiles()) === 0,
      "resource disposal while DB ACK held",
    );
    await until(async () => {
      try {
        return JSON.parse(await readFile(receiptPath, "utf8")).includes(
          transfer,
        );
      } catch (e) {
        if (e.code === "ENOENT") return false;
        throw e;
      }
    }, "real completed receipt durable before stopping");
    assert.equal(
      f.sql(
        `SELECT agent_drained_at IS NULL FROM agent_transfer_runs WHERE id='${transfer}'`,
      ),
      "t",
    );
    await stop(agent);
    // The ordinary route predates cancellation-aware DB handling. Terminate
    // only this isolated fixture's blocked receipt query, keeping its row lock.
    f.sql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE agent_transfer_runs SET agent_drained_at%'`,
    );
    await until(
      async () => !(await agentView(owner.id)).connected,
      "old ordinary control disconnected",
    );
    await rm(mediaRoot, { recursive: true });
    const lastSeen = f.sql(
      `SELECT last_seen::text FROM agents WHERE id='${owner.id}'`,
    );
    const indexedBefore = f.sql(
      `SELECT md5(string_agg(resource||':'||source_version||':'||available::text,',' ORDER BY resource)) FROM media_items WHERE source_id='${owner.id}'`,
    );
    const queued = randomUUID();
    f.sql(
      `INSERT INTO agent_transfers(id,agent_id,token_hash,request,expires_at) VALUES('${queued}','${owner.id}','${hash(randomBytes(32))}','{}',now()+interval '1 hour')`,
    );
    agent = await startAgent();
    await until(
      () =>
        f.sql(
          "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE agent_transfer_runs SET agent_drained_at%'",
        ) === "1",
      "receipt-only route attempts persisted receipt under bounded DB wait",
    );
    await delay(3500);
    assert.equal(agent.exitCode, null);
    assert.deepEqual(
      await readFile(credentials),
      initialCredentials,
      "missing root leaves existing credentials unchanged",
    );
    assert.equal(
      f.sql(`SELECT last_seen::text FROM agents WHERE id='${owner.id}'`),
      lastSeen,
    );
    const absentView = await agentView(owner.id);
    assert.equal(absentView.connected, false);
    assert.equal(absentView.manual_scan, false);
    assert.equal(absentView.source_versions, null);
    assert.equal(absentView.drain_receipts, null);
    assert.equal(
      (await admin.request(`/agents/${owner.id}/scan`, "POST")).status,
      "offline",
    );
    assert.equal(
      f.sql(`SELECT claimed FROM agent_transfers WHERE id='${queued}'`),
      "f",
    );
    assert.equal(
      f.sql(
        `SELECT md5(string_agg(resource||':'||source_version||':'||available::text,',' ORDER BY resource)) FROM media_items WHERE source_id='${owner.id}'`,
      ),
      indexedBefore,
    );
    assert.equal(
      f.sql(
        `SELECT agent_drained_at IS NULL FROM agent_transfer_runs WHERE id='${transfer}'`,
      ),
      "t",
    );
    await releaseLock();
    releaseLock = undefined;
    await f.waitForSql(
      `SELECT count(*) FROM agent_transfer_runs WHERE id='${transfer}' AND agent_drained_at IS NOT NULL`,
      "1",
      20000,
    );
    await f.waitForSql(
      `SELECT lifecycle FROM rooms WHERE id='${mapped.room.id}'`,
      "closed",
      20000,
    );
    await until(
      async () =>
        !JSON.parse(await readFile(receiptPath, "utf8")).includes(transfer),
      "accepted replay removes durable receipt",
    );
    assert.equal(
      f.sql(
        `SELECT t.agent_drained_at<=e.created_at FROM agent_transfer_runs t JOIN playback_sessions p ON p.id=t.session_id JOIN room_lifecycle_events e ON e.room_id=p.room_id AND e.lifecycle='closed' WHERE t.id='${transfer}'`,
      ),
      "t",
    );
    checks.push(
      "real file owner disposal, durable receipt under held DB ACK, stop, missing-root restart, bounded lock retry, replay and mapped closure",
    );
    checks.push(
      "unchanged credentials, no ordinary connected/manual-scan/readiness/last_seen, no queued transfer dispatch or index change",
    );
    req.destroy();

    const drain = await drainSocket(ownerToken);
    const timestamp = f.sql(
      `SELECT agent_drained_at FROM agent_transfer_runs WHERE id='${transfer}'`,
    );
    drain.send({ type: "TRANSFER_DRAINED", id: transfer });
    assert.equal((await drain.ack(transfer)).accepted, true);
    drain.send({ type: "TRANSFER_DRAINED", id: transfer });
    assert.equal((await drain.ack(transfer)).accepted, true);
    assert.equal(
      f.sql(
        `SELECT agent_drained_at FROM agent_transfer_runs WHERE id='${transfer}'`,
      ),
      timestamp,
    );
    const outsider = await pair("foreign drain owner");
    const foreign = randomUUID(),
      unexposed = randomUUID(),
      legacy = randomUUID();
    f.sql(
      `INSERT INTO agent_transfer_runs(id,agent_id,resource_hash,head,dispatched_at,legacy_unconfirmed) VALUES('${foreign}','${outsider.id}','foreign',true,now(),false),('${unexposed}','${owner.id}','undispatched',true,NULL,false),('${legacy}','${owner.id}','legacy',true,now(),true)`,
    );
    for (const id of [foreign, unexposed, legacy, randomUUID()]) {
      drain.send({ type: "TRANSFER_DRAINED", id });
      const ack = await drain.ack(id);
      assert.equal(ack.accepted, false);
      assert.equal(ack.rejected_permanently, true);
    }
    assert.equal(
      f.sql(
        `SELECT count(*) FROM agent_transfer_runs WHERE id IN('${foreign}','${unexposed}','${legacy}') AND agent_drained_at IS NOT NULL`,
      ),
      "0",
    );
    checks.push(
      "duplicate timestamp preserved; foreign, undispatched, legacy and unknown UUIDs rejected",
    );
    // Keep this pre-upgrade row unresolved; its historical scope predates the
    // following room and cannot become a receipt through this recovery route.
    const missing = await makeSession("no durable receipt remains unknown");
    const unknown = randomUUID();
    f.sql(
      `UPDATE playback_sessions SET resource='{"upstream_closed":true}' WHERE id='${missing.session}'; INSERT INTO agent_transfer_runs(id,agent_id,resource_hash,head,session_id,dispatched_at,legacy_unconfirmed) VALUES('${unknown}','${owner.id}','missing-receipt',true,'${missing.session}',now(),false)`,
    );
    await closeRoom(missing.room);
    await f.waitForSql(
      `SELECT last_error FROM room_cleanup_tasks WHERE room_id='${missing.room.id}'`,
      "agent_transfer_drain_unconfirmed",
    );
    assert.equal(
      f.sql(`SELECT lifecycle FROM rooms WHERE id='${missing.room.id}'`),
      "closing",
    );
    assert.equal(
      f.sql(
        `SELECT agent_drained_at IS NULL FROM agent_transfer_runs WHERE id='${unknown}'`,
      ),
      "t",
    );
    checks.push(
      "missing durable receipt leaves mapped room closing with an explicit drain blocker",
    );

    const revoked = await drainSocket(outsider.token);
    await admin.request(`/agents/${outsider.id}`, "DELETE");
    revoked.send({ type: "TRANSFER_DRAINED", id: foreign });
    await until(revoked.isClosed, "live receipt socket denied after revoke");
    assert.equal(
      revoked.frames.some(
        (v) => v.type === "TRANSFER_DRAINED_ACK" && v.accepted,
      ),
      false,
    );
    assert.equal(
      f.sql(
        `SELECT agent_drained_at IS NULL FROM agent_transfer_runs WHERE id='${foreign}'`,
      ),
      "t",
    );
    const deniedStatus = await new Promise((done, fail) => {
      const denied = new WebSocket(
        f.origin.replace("http", "ws") + "/api/v1/agents/drain-ws",
        {
          headers: { Authorization: `Bearer ${outsider.token}` },
          handshakeTimeout: 5000,
        },
      );
      sockets.add(denied);
      denied.once("open", () =>
        fail(Error("revoked recovery connection unexpectedly opened")),
      );
      denied.once("error", fail);
      denied.once("unexpected-response", (_request, response) => {
        response.resume();
        done(response.statusCode);
      });
    });
    assert.equal(deniedStatus, 401);
    checks.push(
      "revocation rechecked per receipt; revoked live and new connections denied",
    );

    const wrong = await drainSocket(ownerToken);
    const sourceCount = f.sql("SELECT count(*) FROM sources");
    wrong.send({
      type: "INDEX",
      sequence: 0,
      final: true,
      items: [{ title: "must not index", resource: "must-not.mp4" }],
    });
    await until(wrong.isClosed, "unknown receipt-route message closes");
    assert.equal(f.sql("SELECT count(*) FROM sources"), sourceCount);
    assert.equal(
      f.sql("SELECT count(*) FROM media_items WHERE resource='must-not.mp4'"),
      "0",
    );
    checks.push(
      "receipt route rejects indexing messages without creating sources or media",
    );

    const unpaired = await admin.request("/agents", "POST", {
      name: "no token on missing mount",
    });
    const unpairedCredentials = resolve(f.root, "must-not-create-credentials");
    const restoredCredentialRoot = resolve(f.root, "restored-credential-root");
    const waiting = await startAgent({
      PAIR_CODE: unpaired.pair_code,
      AGENT_CREDENTIAL_FILE: unpairedCredentials,
      MEDIA_ROOT: restoredCredentialRoot,
    });
    await delay(2500);
    assert.equal(
      f.sql(
        `SELECT token_hash IS NULL AND pair_hash IS NOT NULL FROM agents WHERE id='${unpaired.id}'`,
      ),
      "t",
    );
    await assert.rejects(access(unpairedCredentials), { code: "ENOENT" });
    // Existing credentials can reappear with restored storage. They must take
    // precedence over a still-configured pairing code, without replacement.
    await writeFile(unpairedCredentials, initialCredentials, { mode: 0o600 });
    await mkdir(restoredCredentialRoot);
    await until(
      async () => (await agentView(owner.id)).connected,
      "restored existing credential is reused",
    );
    assert.equal(
      f.sql(
        `SELECT token_hash IS NULL AND pair_hash IS NOT NULL FROM agents WHERE id='${unpaired.id}'`,
      ),
      "t",
    );
    assert.deepEqual(await readFile(unpairedCredentials), initialCredentials);
    await stop(waiting);
    await until(
      async () => !(await agentView(owner.id)).connected,
      "restored credential fixture disconnects",
    );
    checks.push(
      "missing root does not pair; reappearing existing credentials take precedence over pairing after restoration",
    );

    // Restoration is checked first as a non-directory, then as a fresh real
    // mount. The ordinary connection is admitted only after the latter check.
    await writeFile(mediaRoot, "not a mounted media directory");
    await delay(5500);
    assert.equal((await agentView(owner.id)).connected, false);
    await rm(mediaRoot);
    await mkdir(mediaRoot);
    await writeFile(resolve(mediaRoot, "restored.mp4"), "restored fixture");
    await until(
      async () => (await agentView(owner.id)).connected,
      "fresh ordinary connection after valid root restoration",
      15000,
    );
    await f.waitForSql(
      `SELECT count(*) FROM media_items WHERE source_id='${owner.id}' AND resource='restored.mp4' AND source_version IS NOT NULL`,
      "1",
    );
    assert.notEqual(
      f.sql(`SELECT last_seen::text FROM agents WHERE id='${owner.id}'`),
      lastSeen,
    );
    checks.push(
      "root that is a file stays receipt-only; restored directory requires fresh ordinary validated connection and index",
    );
    await stop(agent);

    // Old servers returning 404 must not cause fallback to the unsafe ordinary
    // route. Also inject an ordinary dispatch into the recovery socket: the
    // Agent must neither create a receipt nor open the offered data endpoint.
    const oldCredential = resolve(f.root, "old-server-token"),
      oldReceipt = `${oldCredential}.drained.json`;
    const existing = randomUUID(),
      unsolicited = randomUUID();
    await writeFile(oldReceipt, JSON.stringify([existing]), { mode: 0o600 });
    const http = createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    const websocket = new WebSocketServer({ noServer: true });
    let permitUpgrade = false,
      ordinary = 0,
      pairRequests = 0,
      dataRequests = 0,
      injected = false;
    http.on("request", (req) => {
      if (req.url.includes("/pair")) pairRequests++;
    });
    http.on("upgrade", (req, socket, head) => {
      if (req.url === "/api/v1/agents/ws") ordinary++;
      else if (req.url !== "/api/v1/agents/drain-ws") dataRequests++;
      if (!permitUpgrade || req.url !== "/api/v1/agents/drain-ws") {
        socket.end(
          "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
      }
      websocket.handleUpgrade(req, socket, head, (peer) => {
        sockets.add(peer);
        peer.on("error", () => {});
        peer.send(
          JSON.stringify({
            type: "TRANSFER",
            id: unsolicited,
            request: {
              drain_receipt_required: true,
              data_url: `ws://127.0.0.1:${http.address().port}/must-not-open`,
              resource: "restored.mp4",
            },
          }),
        );
        injected = true;
      });
    });
    await new Promise((done) => http.listen(0, "127.0.0.1", done));
    const oldAgent = await startAgent({
      SERVER_URL: `http://127.0.0.1:${http.address().port}`,
      AGENT_TOKEN: ownerToken,
      MEDIA_ROOT: resolve(f.root, "still-missing"),
      AGENT_CREDENTIAL_FILE: oldCredential,
    });
    try {
      await delay(2500);
      assert.equal(ordinary, 0);
      assert.equal(pairRequests, 0);
      assert.deepEqual(JSON.parse(await readFile(oldReceipt, "utf8")), [
        existing,
      ]);
      permitUpgrade = true;
      await until(
        () => injected,
        "unsolicited transfer on receipt-only socket",
      );
      await delay(250);
      assert.equal(dataRequests, 0);
      assert.equal(ordinary, 0);
      assert.deepEqual(JSON.parse(await readFile(oldReceipt, "utf8")), [
        existing,
      ]);
      checks.push(
        "old-server 404 fails closed; unsolicited TRANSFER opens no media/data connection and fabricates no receipt",
      );
    } finally {
      await stop(oldAgent);
      for (const peer of websocket.clients) peer.terminate();
      await new Promise((done) => websocket.close(done));
      http.closeAllConnections();
      await new Promise((done) => http.close(done));
    }
    console.log(`PASS: ${checks.join("; ")}`);
  } finally {
    if (releaseLock) await releaseLock();
    for (const socket of sockets) socket.terminate();
    for (const req of requests) req.destroy();
    for (const child of children) child.kill();
    await Promise.all([...children].map((child) => child.done));
    for (const log of logs) await new Promise((done) => log.end(done));
  }
});
const cleanup = await fixture.verifyStopped();
await verifyBinding();
for (const record of agentProcesses) {
  record.pid_absent = record.pid !== null && verifyPidAbsent(record.pid);
  assert.equal(
    record.closed && record.pid_absent,
    true,
    "owned receipt-mode Agent process closed and reaped",
  );
}
const sourceFiles = [
  "apps/nas-agent/src/main.rs",
  "apps/nas-agent/src/receipt_mode.rs",
  "apps/server/src/agent_drain.rs",
  "tests/nas-missing-root-receipts.mjs",
];
const evidence = {
  schema_version: 1,
  completed_at: new Date().toISOString(),
  result: "passed",
  source_digest: binding.source_digest,
  coordinator_sha256: coordinatorSha,
  source_head: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  source_sha256: Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [path, hash(await readFile(path))]),
    ),
  ),
  binary_sha256: Object.fromEntries(
    await Promise.all(
      ["rainsync-server", "rainsync-media-worker", "rainsync-nas-agent"].map(
        async (name) => [name, await hashFile(resolve(fixture.target, name))],
      ),
    ),
  ),
  checks,
  agent_processes: agentProcesses,
  postgres: fixture.postgresDiagnostics(),
  cleanup,
};
const report = resolve(fixture.root, "report.json");
await writeFile(report, JSON.stringify(evidence, null, 2));
console.log(`Evidence: ${report}`);
