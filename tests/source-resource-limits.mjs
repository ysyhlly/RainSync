// Ordinary owned catalog and heartbeat fixtures only. No live upstream, large
// payload, blackholed route, credential attack, or OS network modification.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";

const checks = [];
let mode = "complete";
let fixture;
const upstream = createServer((request, response) => {
  const start = Number(
    new URL(request.url, "http://fixture").searchParams.get("StartIndex"),
  );
  let body;
  if (mode === "item-limit") body = '{"Items":[],"TotalRecordCount":20001}';
  else if (mode === "duplicate-json")
    body = '{"Items":[],"TotalRecordCount":0,"TotalRecordCount":0}';
  else if (mode === "partial")
    body = JSON.stringify({
      Items: [{ Id: "new-partial", Name: "Uncommitted" }],
      TotalRecordCount: 2,
    });
  else if (mode === "incomplete")
    body = JSON.stringify({
      Items: start ? [] : [{ Id: "new-partial", Name: "Uncommitted" }],
      TotalRecordCount: 2,
    });
  else
    body = JSON.stringify({
      Items: [{ Id: "retained", Name: "Retained catalog" }],
      TotalRecordCount: 1,
    });
  response.writeHead(200, { "Content-Type": "application/json" }).end(body);
});
await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${upstream.address().port}`;
const sockets = [];
let heartbeats;
async function until(check, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw Error(`Deadline: ${label}`);
}
async function connect(f, token) {
  const socket = new WebSocket(
    f.origin.replace("http", "ws") + "/api/v1/agents/ws",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  sockets.push(socket);
  socket.on("error", () => {});
  await new Promise((done, reject) => {
    socket.once("open", done);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({ type: "HELLO", manual_scan: true, source_versions: true }),
  );
  return socket;
}
try {
  await isolatedServer("source-resource-limits", async (f) => {
    fixture = f;
    const admin = f.client();
    await admin.login();
    for (const kind of ["jellyfin", "emby"]) {
      const source = await admin.request("/sources", "POST", {
        name: `Owned ${kind}`,
        kind,
        config: {
          url: origin,
          user_id: "viewer",
          token: "owned-fixture-token",
          access_policy: {
            schema_version: 1,
            origins: [{ origin, cidrs: ["127.0.0.1/32"] }],
          },
        },
      });
      mode = "complete";
      assert.equal(
        (await admin.request(`/sources/${source.id}/test`, "POST")).count,
        1,
      );
      const catalog = () =>
        f.sql(
          `SELECT jsonb_agg(jsonb_build_object('id',id,'resource',resource,'available',available,'title',title) ORDER BY resource)::text FROM media_items WHERE source_id='${source.id}'`,
        );
      const before = catalog();
      for (mode of ["item-limit", "duplicate-json", "partial", "incomplete"]) {
        const error = await admin.request(
          `/sources/${source.id}/test`,
          "POST",
          undefined,
          502,
        );
        assert.equal(error.error.code, "SOURCE_SCAN_FAILED");
        assert.equal(
          catalog(),
          before,
          `${kind} ${mode} must preserve the previous complete snapshot`,
        );
      }
      checks.push(
        `${kind}: small declared item-limit, duplicate-field, duplicate-page and incomplete-page fixtures preserve the previous snapshot without inserting partial items or tombstoning retained media`,
      );
    }

    async function paired(name) {
      const agent = await admin.request("/agents", "POST", { name });
      return {
        id: agent.id,
        ...(await admin.request("/agents/pair", "POST", {
          code: agent.pair_code,
        })),
      };
    }
    const idle = await paired("Owned silent control");
    const active = await paired("Owned active control");
    const idleSocket = await connect(f, idle.token);
    const firstActive = await connect(f, active.token);
    await until(
      async () =>
        (await admin.request("/agents"))
          .filter((agent) => [idle.id, active.id].includes(agent.id))
          .every((agent) => agent.connected),
      "controls connected",
    );
    const replacement = await connect(f, active.token);
    await until(
      () => firstActive.readyState === WebSocket.CLOSED,
      "old control retired without retiring its replacement",
    );
    heartbeats = setInterval(() => {
      if (replacement.readyState === WebSocket.OPEN)
        replacement.send(JSON.stringify({ type: "HEARTBEAT" }));
    }, 5000);
    const indexed = new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(Error("index acknowledgement missing")),
        5000,
      );
      idleSocket.on("message", (bytes) => {
        if (JSON.parse(bytes).type === "INDEX_ACK") {
          clearTimeout(timer);
          done();
        }
      });
    });
    idleSocket.send(
      JSON.stringify({
        type: "INDEX",
        snapshot: "owned-idle-snapshot",
        sequence: 0,
        final: true,
        items: [
          {
            resource: "fixture.mp4",
            title: "Indexed readiness remains",
            source_version: `stat-v1:${"a".repeat(64)}`,
          },
        ],
      }),
    );
    await indexed;
    const seen = () =>
      f.sql(`SELECT last_seen::text FROM agents WHERE id='${idle.id}'`);
    const receivedAt = seen();
    await delay(1100);
    assert.equal(seen(), receivedAt, "server ticks never advance last_seen");
    const pendingScan = admin.raw(`/agents/${idle.id}/scan`, {
      method: "POST",
      signal: AbortSignal.timeout(40000),
    });
    await until(
      async () =>
        !(await admin.request("/agents")).find((agent) => agent.id === idle.id)
          .connected,
      "silent control expires after thirty seconds",
      35000,
    );
    const scanResponse = await pendingScan;
    assert.equal(scanResponse.status, 200);
    assert.equal((await scanResponse.json()).status, "disconnected");
    assert.equal(
      seen(),
      receivedAt,
      "outgoing scans and silence never count as contact",
    );
    const agents = await admin.request("/agents");
    const idleState = agents.find((agent) => agent.id === idle.id);
    const activeState = agents.find((agent) => agent.id === active.id);
    assert.equal(idleState.connected, false);
    assert.equal(idleState.indexed_count, 1);
    assert.equal(idleState.source_version_status, "ready");
    assert.equal(activeState.connected, true);
    assert.equal(
      (await admin.request(`/agents/${idle.id}/scan`, "POST")).status,
      "offline",
    );
    assert.equal(replacement.readyState, WebSocket.OPEN);
    checks.push(
      "silent open control expires in thirty seconds; last_seen advances only on received activity; pending scan reports disconnection; offline scan returns immediately; healthy replacement and indexed readiness are preserved",
    );
    clearInterval(heartbeats);
    for (const socket of sockets) socket.close();
  });
  const report = {
    result: "passed",
    checks,
    cleanup: await fixture.verifyStopped(),
    scope:
      "small owned loopback fixtures; no real NAS/provider, oversized body or network-failure injection",
  };
  await writeFile(
    resolve(fixture.root, "resource-limits-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ ...report, artifact: fixture.root }, null, 2));
} finally {
  clearInterval(heartbeats);
  for (const socket of sockets) socket.terminate();
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
}
