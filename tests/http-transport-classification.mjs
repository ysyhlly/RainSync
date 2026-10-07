// Real Server/Worker/PostgreSQL classification; no media decoder is required.
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
const checks = [], requests = [];
const playlist = Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,fixture title\nsegment.ts\n#EXT-X-ENDLIST\n");
const mp4 = Buffer.from(await readFile(new URL("./fixtures/browser-video.base64", import.meta.url), "utf8"), "base64");
let result = "failed";
try {
  await isolatedMediaStack("http-transport-classification", async (f) => {
    owned = f;
    upstream = createServer((request, response) => {
      const path = new URL(request.url, "http://fixture").pathname;
      requests.push({ path, method: request.method, range: request.headers.range ?? null });
      const body = path === "/movie.mp4" || path === "/segment.ts" ? mp4 : playlist;
      assert.equal(request.headers.authorization, "Bearer owned-transport-fixture");
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("ETag", `"${createHash("sha256").update(body).digest("hex")}"`);
      const range = request.method !== "HEAD" && /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
      let start = 0, end = body.length - 1;
      if (range) {
        start = Number(range[1]); end = Math.min(range[2] ? Number(range[2]) : end, end);
        if (start > end) { response.writeHead(416, { "Content-Range": `bytes */${body.length}` }); response.end(); return; }
        response.statusCode = 206;
        response.setHeader("Content-Range", `bytes ${start}-${end}/${body.length}`);
      }
      response.setHeader("Content-Length", end - start + 1);
      response.end(request.method === "HEAD" ? undefined : body.subarray(start, end + 1));
    });
    await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
    upstreamPort = upstream.address().port;
    const origin = `http://127.0.0.1:${upstreamPort}`;
    // An empty Worker PATH makes ffprobe/ffmpeg unavailable. Direct transport
    // must be decided by the real authorized HTTP relay, not a decoder probe.
    const emptyPath = resolve(f.root, "empty-worker-path"); await mkdir(emptyPath);
    await f.startWorker({ PATH: emptyPath });
    await f.startServer({ WORKER_URL: f.workerOrigin });
    const admin = f.client(); await admin.login();
    const room = await admin.request("/rooms", "POST", { name: "HTTP transport fixtures" });
    const ws = new WebSocket(f.origin.replace("http", "ws") + "/api/v1/ws", { headers: { Cookie: admin.cookie, Origin: f.origin } });
    const frames = [];
    ws.on("message", (data) => frames.push(JSON.parse(data)));
    const next = async (type) => {
      for (let i = 0; i < 500; i++) {
        const index = frames.findIndex((frame) => frame.type === type || frame.type === "ERROR");
        if (index >= 0) { const frame = frames.splice(index, 1)[0]; assert.equal(frame.type, type, JSON.stringify(frame.error)); return frame; }
        await delay(10);
      }
      throw Error(`Expected ${type} was not observed`);
    };
    await new Promise((done, reject) => { ws.once("open", done); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    const joined = await next("SNAPSHOT");
    let state = joined.state;
    try {
      for (const [path, expected] of [
        ["/manifest-no-extension", "hls"],
        ["/LIST.M3U8", "hls"],
        ["/fragment.m3u8#fixture-fragment", "hls"],
        ["/movie.mp4?cache=fixture", "progressive"],
      ]) {
        const source = await admin.request("/sources", "POST", { name: path, kind: "http", config: { url: origin + path, headers: { Authorization: "Bearer owned-transport-fixture" } } });
        await admin.request(`/sources/${source.id}/test`, "POST");
        const media = f.sql(`SELECT id FROM media_items WHERE source_id='${source.id}'`);
        ws.send(JSON.stringify({ protocol_version: 1, room_id: room.id, command_id: randomUUID(), control_epoch: joined.control_epoch.id,
          expected_revision: state.revision, media_generation: state.media_generation, type: "CHANGE_MEDIA", payload: { media_id: media } }));
        state = (await next("ACK")).state;
        const plan = await admin.request("/playback-sessions", "POST", { room_id: room.id, media_generation: state.media_generation, idempotency_key: randomUUID(), mode: "direct" });
        assert.equal(plan.delivery_mode, "direct"); assert.equal(plan.transport, expected, path);
        const delivered = await fetch(new URL(plan.playback_url, f.workerOrigin), { headers: { Cookie: admin.cookie, Origin: f.origin }, signal: AbortSignal.timeout(10000) });
        assert.equal(delivered.status, 200, path);
        if (expected === "hls") {
          assert.equal(delivered.headers.get("content-type"), "application/vnd.apple.mpegurl");
          assert.ok((await delivered.text()).startsWith("#EXTM3U"));
        } else assert.deepEqual(Buffer.from(await delivered.arrayBuffer()), mp4);
        await admin.request(`/playback-sessions/${plan.session_id}`, "DELETE");
        checks.push({ path, transport: expected, mode: plan.delivery_mode, result: "passed" });
      }
      assert.equal(f.sql("SELECT count(*) FROM media_jobs"), "0", "direct classification never schedules decoder jobs");
      assert.ok(requests.some((request) => request.path === "/manifest-no-extension" && request.method === "GET"));
      assert.ok(requests.every((request) => !request.path.includes("#")));
      result = "passed";
    } finally { ws.terminate(); }
  });
} finally {
  if (upstream) { upstream.closeAllConnections(); await new Promise((done) => upstream.close(done)); }
  if (owned) {
    const cleanup = await owned.verifyStopped();
    const workerPidAbsent = verifyPidAbsent(owned.workerPid);
    const workerPortClosed = await verifyClosedPort(Number(new URL(owned.workerOrigin).port));
    const upstreamPortClosed = upstreamPort === undefined || await verifyClosedPort(upstreamPort);
    assert.ok(workerPidAbsent && workerPortClosed && upstreamPortClosed);
    const report = { schema_version: 1, result, checks, requests, cleanup: { ...cleanup, worker_pid_absent: workerPidAbsent, worker_port_closed: workerPortClosed, upstream_port_closed: upstreamPortClosed }, limitations: ["transport and authorized HTTP relay only; no browser decoding or playback synchronization proof"] };
    await writeFile(resolve(owned.root, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`Evidence: ${resolve(owned.root, "report.json")}`);
  }
}
console.log("PASS: real Server/Worker direct HTTP extensionless, uppercase and fragment HLS; MP4 progressive; decoder-free operation and owned cleanup");
