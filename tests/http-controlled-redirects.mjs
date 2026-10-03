// Public API mutations only: owned HTTP/CDN, Server/Worker and fresh PostgreSQL.
// SQL is read-only evidence; there are no synthetic grants, pins or room writes.
// This runner never builds and never starts an Agent or an Agent WebSocket.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const bindingPath =
  process.env.RAINSYNC_REDIRECT_BINDING_FILE ?? process.env.W03_BACKEND_BINDING;
assert.ok(
  bindingPath,
  "Provide a successful source-bound Server/Worker build; runner never builds",
);
assert.ok(
  process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  "Owned native PostgreSQL required",
);
const bindingBytes = await readFile(bindingPath),
  binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
for (const required of [
  "apps/server/src/http_file_fallback.rs",
  "apps/media-worker/src/http_identity.rs",
  "crates/providers/src/media_request.rs",
])
  assert.ok(binding.source.some((value) => value.path === required));
for (const name of ["rainsync-server", "rainsync-media-worker"])
  assert.ok(
    binding.binaries.some(
      (value) =>
        resolve(value.path) ===
        resolve(process.env.CARGO_TARGET_DIR, "debug", name),
    ),
  );
const coordinator = await Promise.all(
  [
    "tests/http-controlled-redirects.mjs",
    "tests/fixtures/media-stack.mjs",
    "tests/fixtures/server.mjs",
    "tests/fixtures/postgres.mjs",
  ].map(async (path) => ({
    path,
    sha256: digest(await readFile(resolve(repo, path))),
  })),
);
async function verifyBinding() {
  assert.equal(digest(await readFile(bindingPath)), digest(bindingBytes));
  for (const input of [...binding.source, ...coordinator])
    assert.equal(
      digest(await readFile(resolve(repo, input.path))),
      input.sha256,
      input.path,
    );
  for (const binary of binding.binaries)
    assert.equal(
      digest(await readFile(binary.path)),
      binary.sha256,
      binary.name,
    );
}
await verifyBinding();
for (const role of ["server", "worker"]) {
  const path = resolve(
    process.env.CARGO_TARGET_DIR,
    "debug",
    role === "server" ? "rainsync-server" : "rainsync-media-worker",
  );
  const expected =
    JSON.stringify({
      schema_version: 1,
      contract: "controlled-media-redirects-v1",
      identity: "final-target-sha256-v1",
      credential_origin: "configured-origin",
      methods: ["GET", "HEAD"],
      default: "no-follow",
      role,
    }) + "\n";
  assert.equal(
    execFileSync(path, ["--source-access-contract"], {
      env: {},
      encoding: "utf8",
      timeout: 3000,
    }),
    expected,
    "Exact offline declaration without configuration or key environment",
  );
}
const report = {
  schema_version: 1,
  result: "running",
  checks: [],
  scope:
    "Public HTTP APIs and public room control only; read-only SQL evidence; owned Server/Worker/PostgreSQL and generated silent H264 bytes. No Agent/NAS, external CDN/TLS, browser/device or release acceptance.",
  backend_binding: {
    path: resolve(bindingPath),
    source_digest: binding.source_digest,
    sha256: digest(bindingBytes),
  },
  coordinator,
};
const sockets = new Set(),
  servers = [],
  secrets = [],
  originErrors = [];
let fixture, workerPid, failure;
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(25);
  }
  throw Error("Deadline: " + label);
}
async function check(name, run) {
  const row = { name, result: "running" };
  report.checks.push(row);
  try {
    Object.assign(row, await run(), { result: "passed" });
    console.log("PASS: " + name);
  } catch (error) {
    row.result = "failed";
    throw error;
  }
}
async function listener(handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  servers.push({ server, port });
  return `http://127.0.0.1:${port}`;
}
async function selectMedia(f, client, room, media) {
  // Ordinary authenticated room control, never an Agent channel.
  const socket = new WebSocket(
    f.origin.replace("http:", "ws:") + "/api/v1/ws",
    { headers: { Origin: f.origin, Cookie: client.cookie } },
  );
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  const frames = [];
  socket.on("message", (bytes) => frames.push(JSON.parse(bytes)));
  await new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
  });
  const next = (predicate) =>
    until(() => {
      const index = frames.findIndex(predicate);
      return index < 0 ? null : frames.splice(index, 1)[0];
    }, "public room control");
  socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  const snapshot = await next((frame) => frame.type === "SNAPSHOT");
  const input = {
    protocol_version: 1,
    room_id: room.id,
    command_id: randomUUID(),
    control_epoch: snapshot.control_epoch.id,
    expected_revision: snapshot.state.revision,
    media_generation: snapshot.state.media_generation,
    type: "CHANGE_MEDIA",
    payload: { media_id: media.id },
  };
  socket.send(JSON.stringify(input));
  let response = await next((frame) => frame.command_id === input.command_id);
  if (
    response.type === "ERROR" &&
    response.control_epoch &&
    ["CONTROL_EPOCH_EXPIRED", "CONTROL_EPOCH_REQUIRED"].includes(
      response.error?.code,
    )
  ) {
    socket.send(
      JSON.stringify({ ...input, control_epoch: response.control_epoch.id }),
    );
    response = await next((frame) => frame.command_id === input.command_id);
  }
  assert.equal(
    response.type,
    "ACK",
    response.error?.code ?? "room command rejected",
  );
  return {
    generation: response.state.media_generation,
    close: () => socket.terminate(),
  };
}
try {
  await isolatedMediaStack("http-controlled-redirects", async (f) => {
    fixture = f;
    const mediaBytes = await readFile(
      await f.makeClip("owned-redirect.mp4", {
        pictureSeconds: 2,
        width: 320,
        height: 180,
      }),
    );
    const entries = new Map();
    const credential = "Bearer owned-source-" + randomUUID(),
      cookie = "owned=" + randomUUID(),
      custom = "owned-custom-" + randomUUID();
    secrets.push(credential, cookie, custom);
    const cdn = await listener((request, response) => {
      try {
        const url = new URL(request.url, "http://fixture.invalid");
        const entry = entries.get(url.pathname);
        assert.ok(entry, "registered CDN resource only");
        for (const name of [
          "authorization",
          "cookie",
          "x-source-secret",
          "referer",
        ])
          assert.equal(request.headers[name], undefined, "CDN is anonymous");
        entry.cdnReads++;
        entry.headers.push({
          method: request.method,
          ranged: request.headers.range !== undefined,
          conditional: request.headers["if-match"] !== undefined,
          anonymous: true,
        });
        const headers = {
          "content-type": "video/mp4",
          etag: '"same-owned-validator"',
          "accept-ranges": "bytes",
        };
        let start = 0,
          end = mediaBytes.length - 1,
          status = 200;
        const range =
          request.method === "HEAD"
            ? null
            : /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        if (range) {
          start = Number(range[1]);
          end = range[2] ? Math.min(Number(range[2]), end) : end;
          if (start >= mediaBytes.length || end < start) {
            response.writeHead(416, {
              ...headers,
              "content-range": `bytes */${mediaBytes.length}`,
              "content-length": "0",
            });
            response.end();
            return;
          }
          status = 206;
          headers["content-range"] =
            `bytes ${start}-${end}/${mediaBytes.length}`;
        }
        headers["content-length"] = String(end - start + 1);
        response.writeHead(status, headers);
        response.end(
          request.method === "HEAD"
            ? undefined
            : mediaBytes.subarray(start, end + 1),
        );
      } catch (error) {
        originErrors.push(error.message);
        response.destroy();
      }
    });
    const source = await listener((request, response) => {
      try {
        const entry = entries.get(
          new URL(request.url, "http://fixture.invalid").pathname,
        );
        assert.ok(entry, "registered source resource only");
        assert.equal(request.headers.authorization, credential);
        assert.equal(request.headers.cookie, cookie);
        assert.equal(request.headers["x-source-secret"], custom);
        entry.sourceReads++;
        response.writeHead(302, { location: entry.finalUrl });
        response.end();
      } catch (error) {
        originErrors.push(error.message);
        response.destroy();
      }
    });
    await f.startWorker();
    workerPid = f.workerPid;
    await f.startServer({ WORKER_URL: f.workerOrigin });
    const admin = f.client();
    await admin.login();
    const setup = async (label) => {
      const existing = new Set(
        (await admin.request("/media")).map((item) => item.id),
      );
      const id = randomUUID(),
        signature = "owned-signature-" + randomUUID(),
        entry = {
          sourceReads: 0,
          cdnReads: 0,
          headers: [],
          finalUrl: `${cdn}/edge/${id}?signature=${signature}`,
        };
      secrets.push(signature);
      entries.set(`/root/${id}`, entry);
      entries.set(`/edge/${id}`, entry);
      const url = `${source}/root/${id}`;
      const created = await admin.request("/sources", "POST", {
        name: "owned " + label,
        kind: "http",
        config: {
          url,
          headers: {
            Authorization: credential,
            Cookie: cookie,
            "X-Source-Secret": custom,
          },
          access_policy: {
            schema_version: 1,
            origins: [
              { origin: source, cidrs: ["127.0.0.1/32"] },
              { origin: cdn, cidrs: ["127.0.0.1/32"] },
            ],
            redirects: { max_hops: 5 },
          },
        },
      });
      await admin.request(`/sources/${created.id}/test`, "POST");
      const newlyListed = (await admin.request("/media")).filter(
        (item) => !existing.has(item.id),
      );
      assert.equal(newlyListed.length, 1);
      const room = await admin.request("/rooms", "POST", {
        name: "owned " + label,
      });
      const control = await selectMedia(f, admin, room, newlyListed[0]);
      const input = {
        room_id: room.id,
        media_generation: control.generation,
        audio_index: null,
        position_ms: 0,
        idempotency_key: randomUUID(),
        viewer_id: randomUUID(),
        plan_generation: 1,
        observation_version: 1,
        http_file_fallback_version: 1,
        mode: "auto",
        capabilities: {
          progressive_h264_aac: true,
          native_hls: false,
          mse_h264_aac: true,
        },
      };
      return { entry, source: created, room, control, input, url };
    };
    const pins = (id) =>
      JSON.parse(
        f.sql(
          `SELECT COALESCE(json_agg(json_build_object('target',target_sha256,'identity',identity)),'[]'::json) FROM playback_http_representations WHERE session_id=${quote(id)}`,
        ),
      );
    const assertPin = (id, g) => {
      const rows = pins(id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].target, digest(g.url));
      assert.equal(
        rows[0].identity.metadata.final_target_sha256,
        digest(g.entry.finalUrl),
      );
      assert.equal(rows[0].identity.metadata.etag, '"same-owned-validator"');
      return rows[0];
    };
    const assertPlan = async (response) => {
      const value = await response.json();
      assert.equal(response.status, 200, value.error?.code ?? "prepare failed");
      return value;
    };
    const post = (g, body = g.input) =>
      admin.raw(
        body.http_file_fallback
          ? "/playback-sessions/http-file-continuation"
          : "/playback-sessions",
        { method: "POST", body, signal: AbortSignal.timeout(45000) },
      );
    const candidates = async (g) => {
      const response = await admin.raw("/playback-candidates", {
        method: "POST",
        body: {
          room_id: g.room.id,
          media_generation: g.input.media_generation,
          audio_index: null,
          position_ms: 0,
          http_file_capabilities_version: 1,
        },
        signal: AbortSignal.timeout(45000),
      });
      const value = await response.json();
      assert.equal(
        response.status,
        200,
        value.error?.code ?? "candidate probe failed",
      );
      assert.ok(value.binding);
      assert.ok(
        value.candidates.some((candidate) => candidate.id === "direct"),
      );
      return value;
    };
    const reportFor = (set) => ({
      binding: set.binding,
      excluded_candidates: [],
      results: set.candidates.map((candidate) => ({
        candidate_id: candidate.id,
        progressive: "probably",
        mse_supported: true,
        file_decoding: {
          supported: true,
          smooth: true,
          power_efficient: false,
        },
        mse_decoding: { supported: true, smooth: true, power_efficient: false },
      })),
    });
    const stop = async (g, plan) => {
      await admin.request(`/playback-sessions/${plan.session_id}`, "DELETE");
      g.control.close();
    };
    const continuation = (g, parent) => ({
      ...g.input,
      idempotency_key: randomUUID(),
      plan_generation: 2,
      mode: "transcode",
      position_ms: 400,
      http_file_fallback: {
        parent_session_id: parent.session_id,
        final_observation: {
          media_generation: g.input.media_generation,
          seq: 1,
          event: "progress",
          media_time_ms: 400,
          paused: true,
          seeking: false,
          buffering: false,
          playback_rate: 1,
          has_played: true,
        },
      },
    });
    await check(
      "redirected candidate probe, independent grant and replay preserve the full final digest",
      async () => {
        const g = await setup("redirect candidate"),
          set = await candidates(g);
        const body = { ...g.input, candidate_report: reportFor(set) };
        const plan = await assertPlan(await post(g, body));
        assert.equal(plan.selected_candidate_id, "direct");
        const pin = assertPin(plan.session_id, g);
        const response = await fetch(
          new URL(plan.playback_url, f.workerOrigin),
          { signal: AbortSignal.timeout(10000) },
        );
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), mediaBytes);
        const replay = await assertPlan(await post(g, body));
        assert.equal(replay.session_id, plan.session_id);
        assert.deepEqual(assertPin(replay.session_id, g), pin);
        await stop(g, plan);
        return {
          selected: "direct",
          replay_same_session: true,
          bytes: mediaBytes.length,
          destination_digest_preserved: true,
          cdn_anonymous: true,
        };
      },
    );
    await check(
      "candidate seed rejects a changed signed final URL despite equal validators",
      async () => {
        const g = await setup("candidate destination change"),
          set = await candidates(g);
        const body = { ...g.input, candidate_report: reportFor(set) };
        g.entry.finalUrl += "&rotation=two";
        const response = await post(g, body),
          value = await response.json();
        assert.equal(response.status, 409);
        assert.equal(value.error.code, "SOURCE_CHANGED");
        const replay = await post(g, body),
          again = await replay.json();
        assert.equal(replay.status, 409);
        assert.equal(again.error.code, "SOURCE_CHANGED");
        g.control.close();
        return {
          rejection: "SOURCE_CHANGED",
          equal_etag_and_bytes: true,
          replay_rejected: true,
        };
      },
    );
    await check(
      "redirected ordinary root, continuation seed and completed replay preserve final identity",
      async () => {
        const g = await setup("redirect continuation"),
          parent = await assertPlan(await post(g));
        assert.equal(parent.http_file_fallback_version, 1);
        const parentPin = assertPin(parent.session_id, g);
        const body = continuation(g, parent),
          child = await assertPlan(await post(g, body));
        assert.equal(child.delivery_mode, "transcode");
        assert.notEqual(child.session_id, parent.session_id);
        const childPin = assertPin(child.session_id, g);
        assert.deepEqual(
          childPin.identity.metadata,
          parentPin.identity.metadata,
        );
        assert.equal(
          f.sql(
            `SELECT stopped FROM playback_sessions WHERE id=${quote(parent.session_id)}`,
          ),
          "t",
        );
        await f.waitForSql(
          `SELECT status FROM media_jobs WHERE session_id=${quote(child.session_id)}`,
          "succeeded",
          30000,
        );
        const output = await fetch(
          new URL(child.playback_url, f.workerOrigin),
          { signal: AbortSignal.timeout(10000) },
        );
        assert.equal(output.status, 200);
        const manifest = await output.text();
        assert.ok(manifest.startsWith("#EXTM3U"));
        const segment = manifest
          .split(/\r?\n/)
          .find((line) => line && !line.startsWith("#"));
        assert.ok(segment);
        const segmentResponse = await fetch(
          new URL(segment, new URL(child.playback_url, f.workerOrigin)),
          { signal: AbortSignal.timeout(10000) },
        );
        assert.equal(segmentResponse.status, 200);
        assert.ok((await segmentResponse.arrayBuffer()).byteLength > 0);
        const replay = await assertPlan(await post(g, body));
        assert.equal(replay.session_id, child.session_id);
        assert.deepEqual(
          assertPin(replay.session_id, g).identity.metadata,
          parentPin.identity.metadata,
        );
        await stop(g, child);
        return {
          parent_retired: true,
          continuation_transcode_succeeded: true,
          output_segment_read: true,
          replay_same_session: true,
          destination_digest_preserved: true,
        };
      },
    );
    await check(
      "continuation keeps its frozen destination and refuses equal-ETag query rotation",
      async () => {
        const g = await setup("continuation destination change"),
          parent = await assertPlan(await post(g));
        assert.equal(parent.http_file_fallback_version, 1);
        assertPin(parent.session_id, g);
        const body = continuation(g, parent);
        g.entry.finalUrl += "&rotation=two";
        const response = await post(g, body),
          value = await response.json();
        assert.equal(response.status, 409);
        assert.equal(value.error.code, "SOURCE_CHANGED");
        assert.equal(
          f.sql(
            `SELECT stopped FROM playback_sessions WHERE id=${quote(parent.session_id)}`,
          ),
          "t",
        );
        g.control.close();
        return {
          rejection: "SOURCE_CHANGED",
          parent_retired: true,
          no_rebinding: true,
        };
      },
    );
    assert.deepEqual(originErrors, []);
    for (const entry of new Set(entries.values())) {
      assert.ok(entry.sourceReads > 0 && entry.cdnReads > 0);
      assert.ok(entry.headers.every((value) => value.anonymous));
    }
    await f.waitForSql(
      "SELECT count(*) FROM playback_preparations WHERE drained_at IS NULL",
      "0",
      15000,
    );
    await f.waitForSql(
      "SELECT count(*) FROM media_executions WHERE reaped_at IS NULL",
      "0",
      15000,
    );
    for (const path of (await readdir(f.root)).filter((path) =>
      /^(server-|child-).*\.log$/.test(path),
    )) {
      const text = await readFile(resolve(f.root, path), "utf8");
      for (const secret of secrets)
        assert.ok(
          !text.includes(secret),
          "Process logs contain no source secrets or signed queries",
        );
    }
    await verifyBinding();
    report.result = "passed";
  });
} catch (error) {
  failure = error;
  report.result = "failed";
  report.failure = String(error.stack ?? error);
} finally {
  for (const socket of sockets) socket.terminate();
  await until(() => sockets.size === 0, "public room sockets closed", 3000);
  for (const { server } of servers) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  if (fixture) {
    report.cleanup = {
      ...(await fixture.verifyStopped()),
      worker_pid_absent: !workerPid || verifyPidAbsent(workerPid),
      worker_port_closed: await verifyClosedPort(
        Number(new URL(fixture.workerOrigin).port),
      ),
      origin_ports_closed: await Promise.all(
        servers.map(({ port }) => verifyClosedPort(port)),
      ),
      public_room_sockets_closed: sockets.size === 0,
    };
    assert.ok(
      report.cleanup.worker_pid_absent &&
        report.cleanup.worker_port_closed &&
        report.cleanup.origin_ports_closed.every(Boolean),
    );
    const output = resolve(fixture.root, "report.json");
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log("Evidence: " + output);
  }
}
if (failure) throw failure;
