// Public-API regression against a frozen native Server/Worker/PostgreSQL build.
// Uses generated, owned H264 media and a controlled HTTP origin. No fake grants.
// No builds, installations, Docker, remote writes or long-media acceptance.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const bindingFile =
  process.env.RAINSYNC_HTTP_PLAYBACK_BINDING_FILE ??
  process.env.W03_BACKEND_BINDING;
assert.ok(bindingFile, "Set a successful frozen native backend binding");
assert.ok(
  process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  "Use the owned native PostgreSQL fixture; Docker is not used",
);
const bindingBytes = await readFile(bindingFile);
const binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.ok(
  binding.source?.length > 0,
  "Binding must contain backend source inputs",
);
assert.equal(
  digest(Buffer.from(JSON.stringify(binding.source))),
  binding.source_digest,
);
assert.ok(
  binding.source.some(
    (v) => v.path === "migrations/0034_http_representations.sql",
  ),
);
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
for (const name of [
  "rainsync-server",
  "rainsync-media-worker",
  "rainsync-nas-agent",
]) {
  assert.ok(
    binding.binaries?.some(
      (v) =>
        resolve(v.path) ===
        resolve(target, name + (process.platform === "win32" ? ".exe" : "")),
    ),
    `Binding must describe the executed ${name}`,
  );
}
const coordinatorInputs = await Promise.all(
  [
    "tests/http-representation-playback.mjs",
    "tests/fixtures/server.mjs",
    "tests/fixtures/media-stack.mjs",
    "tests/fixtures/postgres.mjs",
  ].map(async (path) => ({
    path,
    sha256: digest(await readFile(resolve(repo, path))),
  })),
);
async function verifyBinding() {
  assert.equal(
    digest(await readFile(bindingFile)),
    digest(bindingBytes),
    "Build binding remained frozen",
  );
  for (const input of [...binding.source, ...coordinatorInputs]) {
    assert.equal(
      digest(await readFile(resolve(repo, input.path))),
      input.sha256,
      `Source/test remained frozen: ${input.path}`,
    );
  }
  for (const binary of binding.binaries) {
    assert.equal(
      digest(await readFile(binary.path)),
      binary.sha256,
      "Executed service binary remained frozen",
    );
  }
}
await verifyBinding();

const report = {
  schema_version: 1,
  started_at: new Date().toISOString(),
  result: "failed",
  tests: [],
  requests: [],
};
let fixture, upstream, upstreamPort, peer, failure;
const workerPids = [],
  timers = new Set();
async function check(name, run) {
  const row = { name, result: "failed" };
  report.tests.push(row);
  const start = Date.now();
  Object.assign(row, await run(), {
    result: "passed",
    elapsed_ms: Date.now() - start,
  });
  console.log(`PASS: ${name}`);
}
async function errorResponse(response, status, code) {
  const body = await response.json();
  assert.equal(
    response.status,
    status,
    `Expected ${status}; actual error=${body?.error?.code}`,
  );
  if (code) assert.equal(body.error.code, code);
  return body;
}
async function roomPeer(f, client, room) {
  const ws = new WebSocket(f.origin.replace("http:", "ws:") + "/api/v1/ws", {
    headers: { Origin: f.origin, Cookie: client.cookie },
  });
  peer = ws;
  const frames = [];
  ws.on("message", (bytes) => frames.push(JSON.parse(bytes)));
  const next = async (type, predicate = () => true) => {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const index = frames.findIndex(
        (frame) => frame.type === type && predicate(frame),
      );
      if (index >= 0) return frames.splice(index, 1)[0];
      await delay(10);
    }
    throw Error(`Missing public room ${type}`);
  };
  await new Promise((done, reject) => {
    ws.once("open", done);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  const snapshot = await next("SNAPSHOT");
  let state = snapshot.state;
  return {
    select: async (media) => {
      const command = {
        protocol_version: 1,
        room_id: room.id,
        command_id: randomUUID(),
        control_epoch: snapshot.control_epoch.id,
        expected_revision: state.revision,
        media_generation: state.media_generation,
        type: "CHANGE_MEDIA",
        payload: { media_id: media.id },
      };
      ws.send(JSON.stringify(command));
      const answer = await next(
        "ACK",
        (frame) => frame.command_id === command.command_id,
      );
      state = answer.state;
      assert.equal(state.media_id, media.id);
      return state.media_generation;
    },
  };
}

try {
  await isolatedMediaStack("http-representation-playback", async (f) => {
    fixture = f;
    report.fixture = { id: f.id, postgres: f.postgresDiagnostics() };
    const clip = await readFile(
      await f.makeClip("owned-http.mp4", { pictureSeconds: 2 }),
    );
    report.clip = {
      codec: "H264",
      generated_owned_media: true,
      length: clip.length,
      sha256: digest(clip),
    };
    const changedClip = Buffer.from(clip);
    // Change the MP4 movie creation time while preserving the generated H264
    // stream and exact length. This is a second legal representation.
    const movieHeader = changedClip.indexOf(Buffer.from("mvhd"));
    assert.ok(movieHeader > 0 && changedClip[movieHeader + 4] === 0);
    changedClip[movieHeader + 11] ^= 1;
    report.clip.replacement_sha256 = digest(changedClip);
    assert.notEqual(report.clip.replacement_sha256, report.clip.sha256);
    let version = "a";
    const auth = "Bearer owned-http-playback-fixture";
    upstream = createServer((request, response) => {
      const path = new URL(request.url, "http://owned").pathname;
      const bytes = version === "a" ? clip : changedClip;
      const etag = path === "/versioned.mp4" ? `"owned-${version}"` : null;
      const row = {
        path,
        method: request.method,
        range: request.headers.range ?? null,
        if_range: request.headers["if-range"] ?? null,
        if_match: request.headers["if-match"] ?? null,
        accept_encoding: request.headers["accept-encoding"] ?? null,
        authorization_matches: request.headers.authorization === auth,
        representation: version,
        status: null,
        body_bytes: 0,
      };
      report.requests.push(row);
      response.setHeader("Content-Type", "video/mp4");
      response.setHeader("Accept-Ranges", "bytes");
      if (etag) response.setHeader("ETag", etag);
      if (
        !row.authorization_matches ||
        !["/versioned.mp4", "/plain.mp4"].includes(path)
      ) {
        row.status = 403;
        response.writeHead(403, { "Content-Length": 0 });
        response.end();
        return;
      }
      if (request.headers["if-match"] && request.headers["if-match"] !== etag) {
        row.status = 412;
        response.writeHead(412, { "Content-Length": 0 });
        response.end();
        return;
      }
      let start = 0,
        end = bytes.length - 1;
      const matched = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
      const ranged =
        matched &&
        (!request.headers["if-range"] || request.headers["if-range"] === etag);
      if (ranged) {
        start = Number(matched[1]);
        end = matched[2] ? Math.min(Number(matched[2]), end) : end;
        if (start > end) {
          row.status = 416;
          response.writeHead(416, {
            "Content-Range": `bytes */${bytes.length}`,
            "Content-Length": 0,
          });
          response.end();
          return;
        }
        response.setHeader(
          "Content-Range",
          `bytes ${start}-${end}/${bytes.length}`,
        );
      }
      row.status = ranged ? 206 : 200;
      response.writeHead(row.status, { "Content-Length": end - start + 1 });
      response.flushHeaders();
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      // Keep provisional header admission visible long enough for the public
      // preparation test to observe its durable pin before final publication.
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.destroyed) {
          row.body_bytes = end - start + 1;
          response.end(bytes.subarray(start, end + 1));
        }
      }, 80);
      timers.add(timer);
      response.once("close", () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
    });
    await new Promise((done, reject) =>
      upstream.once("error", reject).listen(0, "127.0.0.1", done),
    );
    upstreamPort = upstream.address().port;
    const origin = `http://127.0.0.1:${upstreamPort}`;
    const policy = {
      schema_version: 1,
      origins: [{ origin, cidrs: ["127.0.0.1/32"] }],
    };
    await f.startWorker();
    workerPids.push(f.workerPid);
    await f.startServer({ WORKER_URL: f.workerOrigin });
    const admin = f.client();
    const user = await admin.login();
    const createSource = async (path) => {
      const previousMedia = new Set(
        (await admin.request("/media")).map((v) => v.id),
      );
      const source = await admin.request("/sources", "POST", {
        name: `owned ${path}`,
        kind: "http",
        config: {
          url: origin + path,
          headers: { Authorization: auth },
          access_policy: policy,
        },
      });
      const scan = await admin.request(`/sources/${source.id}/test`, "POST");
      assert.equal(scan.count, 1);
      const media = (await admin.request("/media")).find(
        (v) => !previousMedia.has(v.id),
      );
      assert.ok(media, "Public source scan produces a real media item");
      assert.equal(
        f.sql(`SELECT source_id FROM media_items WHERE id=${quote(media.id)}`),
        source.id,
      );
      return { source, media };
    };
    const versioned = await createSource("/versioned.mp4");
    const plain = await createSource("/plain.mp4");
    const room = await admin.request("/rooms", "POST", {
      name: "owned HTTP identity",
    });
    const roomControl = await roomPeer(f, admin, room);
    let generation = await roomControl.select(versioned.media);
    const input = (mode, key = randomUUID()) => ({
      room_id: room.id,
      media_generation: generation,
      mode,
      position_ms: 0,
      idempotency_key: key,
    });
    const pin = (id) =>
      JSON.parse(
        f.sql(
          `SELECT COALESCE(json_agg(json_build_object('session_id',session_id,'target_sha256',target_sha256,'identity',identity)),'[]'::json) FROM playback_http_representations WHERE session_id=${quote(id)}`,
        ),
      );
    const delivery = (plan) => new URL(plan.playback_url, f.workerOrigin);
    const sourceDelivery = (plan) => {
      const url = delivery(plan);
      url.pathname = `/media-delivery/${plan.session_id}/source`;
      return url;
    };
    let plan, firstPin, provisionalPin;
    const oldInput = input("auto");
    await check(
      "real auto probe retains the same grant and durable representation through final publication",
      async () => {
        const requestStart = report.requests.length;
        const pending = admin.raw("/playback-sessions", {
          method: "POST",
          body: oldInput,
        });
        const until = Date.now() + 15000;
        while (Date.now() < until) {
          const observed = f.sql(
            `SELECT json_build_object('session_id',p.id,'stopped',p.stopped,'identity',h.identity,'target_sha256',h.target_sha256) FROM playback_requests r JOIN playback_sessions p ON p.id=r.session_id JOIN playback_http_representations h ON h.session_id=p.id WHERE r.user_id=${quote(user.id)} AND r.idempotency_key=${quote(oldInput.idempotency_key)} AND r.status='pending' LIMIT 1`,
          );
          if (observed) {
            provisionalPin = JSON.parse(observed);
            break;
          }
          await delay(10);
        }
        assert.ok(
          provisionalPin,
          "Actual ffprobe establishes durable identity on the provisional public grant",
        );
        assert.equal(provisionalPin.stopped, false);
        const response = await pending;
        assert.equal(
          response.status,
          200,
          `Auto preparation returns 200; received ${response.status}`,
        );
        plan = await response.json();
        assert.equal(
          plan.session_id,
          provisionalPin.session_id,
          "Probe and final plan share the actual session ID",
        );
        assert.equal(plan.delivery_mode, "direct");
        firstPin = pin(plan.session_id);
        assert.equal(firstPin.length, 1);
        assert.equal(firstPin[0].target_sha256, provisionalPin.target_sha256);
        assert.deepEqual(
          firstPin[0].identity.metadata,
          provisionalPin.identity.metadata,
          "Final publication keeps probe metadata",
        );
        assert.equal(firstPin[0].identity.metadata.etag, '"owned-a"');
        assert.equal(firstPin[0].identity.metadata.size, clip.length);
        assert.equal(firstPin[0].identity.changed, false);
        assert.equal(firstPin[0].identity.consumed, true);
        assert.equal(
          f.sql(
            `SELECT stopped FROM playback_sessions WHERE id=${quote(plan.session_id)}`,
          ),
          "f",
        );
        assert.equal(
          f.sql(
            `SELECT access_policy_revision FROM sources WHERE id=${quote(versioned.source.id)}`,
          ),
          "1",
        );
        assert.equal(
          (await admin.request(`/playback-sessions/${plan.session_id}`)).status,
          "ready",
        );
        assert.ok(
          report.requests
            .slice(requestStart)
            .some((v) => v.method === "GET" && v.body_bytes > 0),
          "Actual probe consumed owned media through HTTP",
        );
        return {
          session_id: plan.session_id,
          provisional_pin: provisionalPin,
          final_pin: firstPin,
          origin_requests: report.requests.length - requestStart,
        };
      },
    );
    await check(
      "Worker restart keeps the durable pin and serves exact partial media with conditional headers",
      async () => {
        await f.stopWorker();
        await f.startWorker();
        workerPids.push(f.workerPid);
        const before = report.requests.length;
        const response = await fetch(delivery(plan), {
          headers: { Range: "bytes=128-511", "If-Range": '"owned-a"' },
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get("etag"), '"owned-a"');
        assert.equal(
          response.headers.get("content-range"),
          `bytes 128-511/${clip.length}`,
        );
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          clip.subarray(128, 512),
        );
        assert.equal(
          report.requests.length - before,
          1,
          "Pinned binary needs one delivery origin request",
        );
        const request = report.requests.at(-1);
        assert.equal(request.range, "bytes=128-511");
        assert.equal(request.if_match, '"owned-a"');
        assert.equal(request.if_range, '"owned-a"');
        assert.equal(request.accept_encoding, "identity");
        assert.deepEqual(pin(plan.session_id), firstPin);
        return {
          origin_requests: 1,
          delivered_bytes: 384,
          worker_restart: true,
        };
      },
    );
    await check(
      "authentication and source policy remain authoritative before origin access",
      async () => {
        const before = report.requests.length;
        const invalid = delivery(plan);
        invalid.searchParams.set("token", "invalid-owned-token");
        await errorResponse(
          await fetch(invalid),
          401,
          "INVALID_PLAYBACK_SESSION",
        );
        await errorResponse(
          await f.client().raw(`/playback-sessions/${plan.session_id}`),
          401,
        );
        assert.equal(report.requests.length, before);
        assert.equal(
          f.sql(
            `SELECT resource->>'source_policy_revision' FROM playback_sessions WHERE id=${quote(plan.session_id)}`,
          ),
          "1",
        );
        return { denied_origin_requests: 0, source_policy_revision: 1 };
      },
    );
    await check(
      "same-length ETag replacement fails before media bytes and invalidates old readiness renewal and replay",
      async () => {
        version = "b";
        const before = report.requests.length;
        const response = await fetch(delivery(plan), {
          headers: { Range: "bytes=128-511" },
          signal: AbortSignal.timeout(10000),
        });
        const body = await errorResponse(response, 409, "SOURCE_CHANGED");
        assert.equal(body.error.retryable, false);
        assert.equal(
          response.headers.get("content-range"),
          null,
          "Changed source never exposes media range headers",
        );
        assert.equal(report.requests.length - before, 1);
        assert.equal(report.requests.at(-1).status, 412);
        assert.equal(
          report.requests.at(-1).body_bytes,
          0,
          "The origin sends no replacement bytes for the stale conditional request",
        );
        const tombstone = pin(plan.session_id);
        assert.equal(tombstone[0].identity.changed, true);
        assert.equal(
          tombstone[0].identity.metadata.etag,
          '"owned-a"',
          "Old identity is never rebound to replacement bytes",
        );
        const after = report.requests.length;
        for (const method of ["GET", "POST"])
          await errorResponse(
            await admin.raw(`/playback-sessions/${plan.session_id}`, {
              method,
            }),
            410,
            "INVALID_PLAYBACK_SESSION",
          );
        await errorResponse(
          await admin.raw("/playback-sessions", {
            method: "POST",
            body: oldInput,
          }),
          410,
          "PLAYBACK_REQUEST_EXPIRED",
        );
        await errorResponse(
          await fetch(delivery(plan), { headers: { Range: "bytes=128-511" } }),
          401,
          "INVALID_PLAYBACK_SESSION",
        );
        assert.equal(
          report.requests.length,
          after,
          "Durably invalidated grants make no more origin requests",
        );
        return {
          same_length: changedClip.length === clip.length,
          stale_origin_requests: 1,
          replacement_media_bytes: 0,
          tombstone,
        };
      },
    );
    await check(
      "a fresh public plan binds the replacement identity and source policy revision still retires it",
      async () => {
        const replacement = await admin.request(
          "/playback-sessions",
          "POST",
          input("direct"),
        );
        assert.notEqual(replacement.session_id, plan.session_id);
        const response = await fetch(delivery(replacement), {
          headers: { Range: "bytes=128-511" },
        });
        assert.equal(response.status, 206);
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          changedClip.subarray(128, 512),
        );
        assert.equal(
          pin(replacement.session_id)[0].identity.metadata.etag,
          '"owned-b"',
        );
        const before = report.requests.length;
        const revised = await admin.request(
          `/sources/${versioned.source.id}/access-policy`,
          "POST",
          { expected_revision: 1, policy },
        );
        assert.equal(revised.access_policy_revision, 2);
        await errorResponse(
          await fetch(delivery(replacement)),
          401,
          "INVALID_PLAYBACK_SESSION",
        );
        await errorResponse(
          await admin.raw(`/playback-sessions/${replacement.session_id}`),
          410,
          "INVALID_PLAYBACK_SESSION",
        );
        assert.equal(
          report.requests.length,
          before,
          "Source revision retirement still denies before HTTP identity work",
        );
        return {
          fresh_session_id: replacement.session_id,
          etag: '"owned-b"',
          retired_source_revision: 1,
          new_source_revision: 2,
          denied_origin_requests: 0,
        };
      },
    );
    generation = await roomControl.select(plain.media);
    await check(
      "validator-free auto probe clearly requires a source version and explicit direct allows one full body",
      async () => {
        const absentInput = input("auto");
        await errorResponse(
          await admin.raw("/playback-sessions", {
            method: "POST",
            body: absentInput,
          }),
          409,
          "SOURCE_VERSION_REQUIRED",
        );
        const failed = JSON.parse(
          f.sql(
            `SELECT json_build_object('status',r.status,'error',r.error_code,'stopped',p.stopped,'media_id',p.media_id) FROM playback_requests r JOIN playback_sessions p ON p.id=r.session_id WHERE r.user_id=${quote(user.id)} AND r.idempotency_key=${quote(absentInput.idempotency_key)}`,
          ),
        );
        assert.equal(failed.status, "failed");
        assert.equal(failed.error, "source_version_required");
        assert.equal(failed.stopped, true);
        assert.equal(failed.media_id, plain.media.id);
        const beforeReplay = report.requests.length;
        await errorResponse(
          await admin.raw("/playback-sessions", {
            method: "POST",
            body: absentInput,
          }),
          409,
          "SOURCE_VERSION_REQUIRED",
        );
        assert.equal(
          report.requests.length,
          beforeReplay,
          "Nonretryable no-validator auto replay never probes again",
        );
        const direct = await admin.request(
          "/playback-sessions",
          "POST",
          input("direct"),
        );
        assert.equal(
          pin(direct.session_id).length,
          0,
          "Explicit direct skips probing",
        );
        const response = await fetch(sourceDelivery(direct));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("etag"), null);
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          changedClip,
        );
        const identity = pin(direct.session_id)[0].identity;
        assert.equal(identity.metadata.etag, null);
        assert.equal(identity.metadata.reliable_modified, false);
        assert.equal(identity.consumed, true);
        await errorResponse(
          await fetch(sourceDelivery(direct)),
          409,
          "SOURCE_VERSION_REQUIRED",
        );
        await errorResponse(
          await fetch(sourceDelivery(direct), {
            headers: { Range: "bytes=128-511" },
          }),
          409,
          "SOURCE_VERSION_REQUIRED",
        );
        await admin.request(
          `/playback-sessions/${direct.session_id}`,
          "DELETE",
        );
        return {
          auto_error: "SOURCE_VERSION_REQUIRED",
          failed_real_grant: failed,
          first_full_body_bytes: clip.length,
          second_body_and_range_error: "SOURCE_VERSION_REQUIRED",
        };
      },
    );
    assert.ok(
      report.requests.every((v) => v.authorization_matches),
      "Source authentication is retained for every actual HTTP request",
    );
    assert.equal(
      f.sql(
        "SELECT count(*) FROM playback_sessions p LEFT JOIN media_items m ON m.id=p.media_id LEFT JOIN sources s ON s.id=m.source_id WHERE m.id IS NULL OR s.id IS NULL",
      ),
      "0",
      "No missing/NULL source fake grants",
    );
    await admin.request(`/playback-sessions/${plan.session_id}`, "DELETE");
    peer.terminate();
    peer = undefined;
  });
  await verifyBinding();
  report.result = "passed";
} catch (error) {
  failure = error;
  report.failure = { message: error.message };
} finally {
  peer?.terminate();
  for (const timer of timers) clearTimeout(timer);
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
  }
  if (fixture) {
    const stack = await fixture.verifyStopped();
    const workerPortClosed = await verifyClosedPort(
      Number(new URL(fixture.workerOrigin).port),
    );
    const upstreamPortClosed =
      upstreamPort === undefined || (await verifyClosedPort(upstreamPort));
    const workerPidsAbsent = workerPids.every((pid) => verifyPidAbsent(pid));
    assert.equal(workerPortClosed, true);
    assert.equal(upstreamPortClosed, true);
    assert.equal(workerPidsAbsent, true);
    report.cleanup = {
      ...stack,
      worker_pids: workerPids,
      worker_pids_absent: workerPidsAbsent,
      worker_port_closed: workerPortClosed,
      origin_port: upstreamPort,
      origin_port_closed: upstreamPortClosed,
    };
    report.finished_at = new Date().toISOString();
    report.binding = {
      file: bindingFile,
      sha256: digest(bindingBytes),
      source_digest: binding.source_digest,
      binaries: binding.binaries,
      coordinator_inputs: coordinatorInputs,
    };
    report.limitations = [
      "Focused public Server/Worker API regression with owned H264 and native PostgreSQL; no browser, real upstream product, device or long-run acceptance",
      "The source-account policy compatibility suite remains separate; generic HTTP has no upstream account policy",
    ];
    const reportPath = resolve(fixture.root, "report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`Evidence: ${reportPath}`);
  }
}
if (failure) throw failure;
