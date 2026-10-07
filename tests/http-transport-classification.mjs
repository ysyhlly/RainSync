// Real Server/Worker/PostgreSQL classification. Auto uses the actual FFprobe;
// a separate restarted Worker with empty PATH proves direct needs no decoder.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

let owned, upstream, upstreamPort;
const checks = [],
  requests = [],
  phases = [];
const playlist = Buffer.from(
  "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,fixture title\nsegment.ts\n#EXT-X-ENDLIST\n",
);
const mp4 = Buffer.from(
  await readFile(
    new URL("./fixtures/browser-video.base64", import.meta.url),
    "utf8",
  ),
  "base64",
);
let result = "failed";
const cases = [
  { path: "/manifest-no-extension", expected: "hls", body: playlist },
  { path: "/LIST.M3U8", expected: "hls", body: playlist },
  { path: "/fragment.m3u8#fixture-fragment", expected: "hls", body: playlist },
  { path: "/movie.mp4?cache=fixture", expected: "progressive", body: mp4 },
  {
    path: "/plain.mp4",
    expected: "progressive",
    body: mp4,
    mime: "video/mp4",
    unversioned: true,
  },
  {
    path: "/plain-hls",
    expected: "hls",
    body: playlist,
    mime: "audio/x-mpegurl; charset=utf-8",
    unversioned: true,
  },
  {
    path: "/wrong-video-mime",
    expected: "hls",
    body: playlist,
    mime: "video/mp4",
  },
  { path: "/no-head", expected: "hls", body: playlist, rejectHead: true },
  {
    path: "/opaque-no-version",
    expected: "required",
    body: playlist,
    unversioned: true,
  },
];
const resources = new Map(
  cases.map((value) => [new URL(value.path, "http://fixture").pathname, value]),
);
let holdHead = false;
const heldHeads = [];
// Source discovery succeeds first; only the subsequent preparation rejects HEAD.
const rejectHeadDuringPreparation = new Set();
try {
  await isolatedMediaStack("http-transport-classification", async (f) => {
    owned = f;
    upstream = createServer((request, response) => {
      const path = new URL(request.url, "http://fixture").pathname;
      const observation = {
        path,
        method: request.method,
        range: request.headers.range ?? null,
        status: null,
      };
      requests.push(observation);
      const item = resources.get(path);
      const body =
        item?.body ??
        (["/segment.ts", "/held-head"].includes(path) ? mp4 : undefined);
      assert.equal(
        request.headers.authorization,
        "Bearer owned-transport-fixture",
      );
      if (!body) {
        observation.status = 404;
        response.writeHead(404, { "Content-Length": 0 });
        response.end();
        return;
      }
      if (
        item?.rejectHead &&
        rejectHeadDuringPreparation.has(path) &&
        request.method === "HEAD"
      ) {
        observation.status = 405;
        response.writeHead(405, { "Content-Length": 0 });
        response.end();
        return;
      }
      const send = () => {
        if (response.destroyed) return;
        response.setHeader(
          "Content-Type",
          item?.mime ??
            (path === "/held-head" ? "video/mp4" : "application/octet-stream"),
        );
        response.setHeader("Accept-Ranges", "bytes");
        if (!item?.unversioned && path !== "/held-head")
          response.setHeader(
            "ETag",
            `"${createHash("sha256").update(body).digest("hex")}"`,
          );
        const range =
          request.method !== "HEAD" &&
          /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        let start = 0,
          end = body.length - 1;
        if (range) {
          start = Number(range[1]);
          end = Math.min(range[2] ? Number(range[2]) : end, end);
          if (start > end) {
            observation.status = 416;
            response.writeHead(416, {
              "Content-Range": `bytes */${body.length}`,
            });
            response.end();
            return;
          }
          response.statusCode = 206;
          response.setHeader(
            "Content-Range",
            `bytes ${start}-${end}/${body.length}`,
          );
        }
        response.setHeader("Content-Length", end - start + 1);
        observation.status = response.statusCode;
        response.end(
          request.method === "HEAD" ? undefined : body.subarray(start, end + 1),
        );
      };
      if (holdHead && path === "/held-head" && request.method === "HEAD")
        heldHeads.push(send);
      else send();
    });
    await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
    upstreamPort = upstream.address().port;
    const origin = `http://127.0.0.1:${upstreamPort}`;
    const emptyPath = resolve(f.root, "empty-worker-path");
    await mkdir(emptyPath);
    // Ordinary auto negotiation actually launches FFprobe. Keep its real PATH
    // until this independent negative/replay phase has reached the source gate.
    await f.startWorker();
    await f.startServer({ WORKER_URL: f.workerOrigin });
    const admin = f.client();
    const user = await admin.login();
    const room = await admin.request("/rooms", "POST", {
      name: "HTTP transport fixtures",
    });
    const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", {
      headers: { Cookie: admin.cookie, Origin: f.origin },
    });
    const frames = [];
    ws.on("message", (data) => frames.push(JSON.parse(data)));
    const next = async (type) => {
      for (let i = 0; i < 500; i++) {
        const index = frames.findIndex(
          (frame) => frame.type === type || frame.type === "ERROR",
        );
        if (index >= 0) {
          const frame = frames.splice(index, 1)[0];
          assert.equal(frame.type, type, JSON.stringify(frame.error));
          return frame;
        }
        await delay(10);
      }
      throw Error(`Expected ${type} was not observed`);
    };
    await new Promise((done, reject) => {
      ws.once("open", done);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    const joined = await next("SNAPSHOT");
    let state = joined.state;
    try {
      const pins = (id) =>
        JSON.parse(
          f.sql(
            `SELECT COALESCE(json_agg(identity),'[]'::json) FROM playback_http_representations WHERE session_id='${id}'`,
          ),
        );
      const error = async (response, code) => {
        const value = await response.json();
        assert.equal(response.status, 409, JSON.stringify(value));
        assert.equal(value.error.code, code);
      };
      const plain = await admin.request("/sources", "POST", {
        name: "auto no-validator phase",
        kind: "http",
        config: {
          url: origin + "/plain.mp4",
          headers: { Authorization: "Bearer owned-transport-fixture" },
        },
      });
      await admin.request(`/sources/${plain.id}/test`, "POST");
      const plainMedia = f.sql(
        `SELECT id FROM media_items WHERE source_id='${plain.id}'`,
      );
      ws.send(
        JSON.stringify({
          protocol_version: 1,
          room_id: room.id,
          command_id: randomUUID(),
          control_epoch: joined.control_epoch.id,
          expected_revision: state.revision,
          media_generation: state.media_generation,
          type: "CHANGE_MEDIA",
          payload: { media_id: plainMedia },
        }),
      );
      state = (await next("ACK")).state;
      const automatic = {
        room_id: room.id,
        media_generation: state.media_generation,
        idempotency_key: randomUUID(),
        mode: "auto",
      };
      const beforeAuto = requests.length;
      await error(
        await admin.raw("/playback-sessions", {
          method: "POST",
          body: automatic,
        }),
        "SOURCE_VERSION_REQUIRED",
      );
      assert.ok(
        requests
          .slice(beforeAuto)
          .some(
            (request) =>
              request.path === "/plain.mp4" && request.method === "GET",
          ),
        "real FFprobe must reach the authorized source version gate",
      );
      const beforeReplay = requests.length;
      await error(
        await admin.raw("/playback-sessions", {
          method: "POST",
          body: automatic,
        }),
        "SOURCE_VERSION_REQUIRED",
      );
      assert.equal(
        requests.length,
        beforeReplay,
        "nonretryable auto replay cannot re-probe",
      );
      const stopped = await f.stopWorker();
      assert.ok(
        stopped?.observed_close && Number.isInteger(stopped.pid),
        "the owned auto-phase Worker must actually close before replacement",
      );
      const autoPidAbsent = verifyPidAbsent(stopped.pid);
      const oldPortClosed = await verifyClosedPort(
        Number(new URL(f.workerOrigin).port),
      );
      assert.ok(
        autoPidAbsent && oldPortClosed,
        "the exact owned auto Worker PID and port must be gone",
      );
      phases.push({
        name: "real-ffprobe-auto",
        result: "passed",
        error: "SOURCE_VERSION_REQUIRED",
        replay_origin_requests: 0,
        worker: {
          ...stopped,
          pid_absent: autoPidAbsent,
          port_closed: oldPortClosed,
        },
      });
      // Preserve every original direct case and added one-body/cancellation
      // assertion under a new owned process with both decoders unavailable.
      await f.startWorker({ PATH: emptyPath });
      assert.notEqual(
        f.workerPid,
        stopped.pid,
        "direct phase uses a new owned Worker process",
      );
      phases.push({
        name: "decoder-free-direct",
        worker_pid: f.workerPid,
        decoder_path_empty: true,
      });
      for (const item of cases) {
        const { path, expected } = item;
        const source = await admin.request("/sources", "POST", {
          name: path,
          kind: "http",
          config: {
            url: origin + path,
            headers: { Authorization: "Bearer owned-transport-fixture" },
          },
        });
        await admin.request(`/sources/${source.id}/test`, "POST");
        if (item.rejectHead)
          rejectHeadDuringPreparation.add(new URL(path, origin).pathname);
        const media = f.sql(
          `SELECT id FROM media_items WHERE source_id='${source.id}'`,
        );
        ws.send(
          JSON.stringify({
            protocol_version: 1,
            room_id: room.id,
            command_id: randomUUID(),
            control_epoch: joined.control_epoch.id,
            expected_revision: state.revision,
            media_generation: state.media_generation,
            type: "CHANGE_MEDIA",
            payload: { media_id: media },
          }),
        );
        state = (await next("ACK")).state;
        const input = {
          room_id: room.id,
          media_generation: state.media_generation,
          idempotency_key: randomUUID(),
          mode: "direct",
        };
        const beforePreparation = requests.length;
        if (expected === "required") {
          await error(
            await admin.raw("/playback-sessions", {
              method: "POST",
              body: input,
            }),
            "SOURCE_VERSION_REQUIRED",
          );
          const before = requests.length;
          await error(
            await admin.raw("/playback-sessions", {
              method: "POST",
              body: input,
            }),
            "SOURCE_VERSION_REQUIRED",
          );
          assert.equal(
            requests.length,
            before,
            "opaque unversioned direct denial is nonretryable",
          );
          checks.push({
            path,
            transport: "unproven",
            result: "passed",
            error: "SOURCE_VERSION_REQUIRED",
          });
          continue;
        }
        const plan = await admin.request("/playback-sessions", "POST", input);
        assert.equal(plan.delivery_mode, "direct");
        assert.equal(plan.transport, expected, path);
        const preparation = requests.slice(beforePreparation);
        if (item.rejectHead) {
          assert.equal(
            preparation.filter(
              (request) => request.method === "HEAD" && request.status === 405,
            ).length,
            1,
            "the actual classification HEAD must receive 405",
          );
          assert.ok(
            preparation.some(
              (request) =>
                request.method === "GET" &&
                request.range === "bytes=0-1023" &&
                request.status === 206,
            ),
            "HEAD rejection must reach the original guarded Range preflight",
          );
        }
        if (item.unversioned) {
          assert.equal(
            pins(plan.session_id).length,
            0,
            "header-only no-validator classification has no durable pin",
          );
          assert.ok(
            preparation.every(
              (request) => request.method === "HEAD" && request.range === null,
            ),
            "classification reads no body of the final one-body grant",
          );
        } else {
          assert.ok(
            preparation.some((request) => request.method === "GET"),
            "typed reliable HEAD pins retain real body sniffing",
          );
        }
        const delivered = await fetch(
          new URL(plan.playback_url, f.workerOrigin),
          {
            headers: { Cookie: admin.cookie, Origin: f.origin },
            signal: AbortSignal.timeout(10000),
          },
        );
        assert.equal(delivered.status, 200, path);
        if (expected === "hls") {
          assert.equal(
            delivered.headers.get("content-type"),
            "application/vnd.apple.mpegurl",
          );
          assert.ok((await delivered.text()).startsWith("#EXTM3U"));
        } else
          assert.deepEqual(Buffer.from(await delivered.arrayBuffer()), mp4);
        if (item.unversioned) {
          assert.equal(pins(plan.session_id)[0].consumed, true);
          assert.equal(pins(plan.session_id)[0].metadata.etag, null);
          await error(
            await fetch(new URL(plan.playback_url, f.workerOrigin)),
            "SOURCE_VERSION_REQUIRED",
          );
          await error(
            await fetch(new URL(plan.playback_url, f.workerOrigin), {
              headers: { Range: "bytes=1-127" },
            }),
            "SOURCE_VERSION_REQUIRED",
          );
        }
        await admin.request(`/playback-sessions/${plan.session_id}`, "DELETE");
        checks.push({
          path,
          transport: expected,
          mode: plan.delivery_mode,
          result: "passed",
        });
      }
      // A delayed HEAD remains an owned provisional request, never a published
      // viewer grant. Exercise the normal 20s client timeout and revoke its key.
      const held = await admin.request("/sources", "POST", {
        name: "held HEAD",
        kind: "http",
        config: {
          url: origin + "/held-head",
          headers: { Authorization: "Bearer owned-transport-fixture" },
        },
      });
      await admin.request(`/sources/${held.id}/test`, "POST");
      const media = f.sql(
        `SELECT id FROM media_items WHERE source_id='${held.id}'`,
      );
      ws.send(
        JSON.stringify({
          protocol_version: 1,
          room_id: room.id,
          command_id: randomUUID(),
          control_epoch: joined.control_epoch.id,
          expected_revision: state.revision,
          media_generation: state.media_generation,
          type: "CHANGE_MEDIA",
          payload: { media_id: media },
        }),
      );
      state = (await next("ACK")).state;
      holdHead = true;
      const pending = {
        room_id: room.id,
        media_generation: state.media_generation,
        idempotency_key: randomUUID(),
        mode: "direct",
      };
      const started = Date.now();
      const outcome = admin
        .raw("/playback-sessions", { method: "POST", body: pending })
        .then(
          (response) => ({ response }),
          (failure) => ({ failure }),
        );
      for (let i = 0; i < 200 && !heldHeads.length; i++) await delay(10);
      assert.ok(
        heldHeads.length,
        "real authorized Worker HEAD reached the owned origin",
      );
      const observed = await outcome;
      assert.ok(
        observed.failure &&
          ["TimeoutError", "AbortError"].includes(observed.failure.name),
        "the real client deadline must expire while HEAD is held",
      );
      assert.ok(
        Date.now() - started >= 19000 && Date.now() - started < 25000,
        "the client uses its original bounded 20s deadline",
      );
      await admin.request(
        `/playback-requests/${pending.idempotency_key}`,
        "DELETE",
      );
      holdHead = false;
      for (const release of heldHeads.splice(0)) release();
      for (let i = 0; i < 200; i++) {
        const state = f.sql(
          `SELECT status FROM playback_requests WHERE user_id='${user.id}' AND idempotency_key='${pending.idempotency_key}'`,
        );
        if (state === "failed") break;
        await delay(10);
      }
      const retired = JSON.parse(
        f.sql(
          `SELECT json_build_object('status',r.status,'error',r.error_code,'unpublished',r.response_encrypted IS NULL,'stopped',p.stopped,'pins',(SELECT count(*) FROM playback_http_representations h WHERE h.session_id=p.id)) FROM playback_requests r JOIN playback_sessions p ON p.id=r.session_id WHERE r.user_id='${user.id}' AND r.idempotency_key='${pending.idempotency_key}'`,
        ),
      );
      assert.equal(retired.status, "failed");
      assert.equal(retired.error, "playback_request_cancelled");
      assert.equal(retired.unpublished, true);
      assert.equal(retired.stopped, true);
      assert.equal(retired.pins, 0);
      checks.push({
        path: "/held-head",
        result: "passed",
        timeout_ms: 20000,
        original_key_revoked: true,
        final_grant_unpublished: true,
        pin_count: 0,
      });
      assert.equal(
        f.sql("SELECT count(*) FROM media_jobs"),
        "0",
        "direct classification never schedules decoder jobs",
      );
      assert.ok(
        requests.some(
          (request) =>
            request.path === "/manifest-no-extension" &&
            request.method === "GET",
        ),
      );
      assert.ok(requests.every((request) => !request.path.includes("#")));
      phases[1].result = "passed";
      result = "passed";
    } finally {
      ws.terminate();
    }
  });
} finally {
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
  }
  if (owned) {
    const cleanup = await owned.verifyStopped();
    const workerPidAbsent = verifyPidAbsent(owned.workerPid);
    const workerPortClosed = await verifyClosedPort(
      Number(new URL(owned.workerOrigin).port),
    );
    const upstreamPortClosed =
      upstreamPort === undefined || (await verifyClosedPort(upstreamPort));
    assert.ok(workerPidAbsent && workerPortClosed && upstreamPortClosed);
    const report = {
      schema_version: 1,
      result,
      checks,
      requests,
      phases,
      cleanup: {
        ...cleanup,
        worker_pid_absent: workerPidAbsent,
        worker_port_closed: workerPortClosed,
        upstream_port_closed: upstreamPortClosed,
      },
      limitations: [
        "transport and authorized HTTP relay only; no browser decoding or playback synchronization proof",
        "opaque HTTP bodies without reliable validators remain unclassifiable and require SOURCE_VERSION_REQUIRED",
      ],
    };
    await writeFile(
      resolve(owned.root, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(`Evidence: ${resolve(owned.root, "report.json")}`);
  }
}
console.log(
  "PASS: real Server/Worker HTTP transport, header-only no-validator one-body admission, reliable content sniffing, HEAD fallback, timeout/revocation and owned cleanup",
);
