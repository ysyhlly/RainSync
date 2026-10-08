// C/W04 isolated native HTTP/HLS preview checks. No external services or DB URLs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

assert.ok(process.env.W03_BACKEND_BINDING ?? process.env.RAINSYNC_C_BINDING_FILE, "Set a frozen native backend binding");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bindingFile = process.env.W03_BACKEND_BINDING ?? process.env.RAINSYNC_C_BINDING_FILE;
const binding = JSON.parse(await readFile(bindingFile, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inputs = binding.source ? Object.fromEntries(binding.source.map(v => [v.path, v.sha256])) : binding.inputs;
assert.ok(inputs && Object.keys(inputs).length > 0, "binding must contain source inputs");
assert.equal(binding.binaries.length, 3, "binding must contain the actual three service binaries");
if (binding.source) {
  assert.equal(binding.result, "passed");
  assert.equal(digest(Buffer.from(JSON.stringify(binding.source))), binding.source_digest);
}
const testPath = fileURLToPath(import.meta.url);
const testDigest = digest(await readFile(testPath));
async function verifyBinding() {
  assert.equal(digest(await readFile(testPath)), testDigest, "HTTP/HLS coordinator changed during validation");
  for (const [name, hash] of Object.entries(inputs)) {
    assert.equal(digest(await readFile(resolve(repo, name))), hash, `source changed: ${name}`);
  }
  for (const binary of binding.binaries) {
    assert.equal(digest(await readFile(binary.path)), binary.sha256, "binary changed during HTTP/HLS validation");
  }
}
await verifyBinding();
const tests = [];
const upstreamFailures = [];
let owned;
let result = "failed";
let reportRoot;
try {
  await isolatedMediaStack("c-http-hls-preview", async (fixture) => {
    owned = fixture;
    reportRoot = fixture.root;
    const admin = fixture.client();
    await admin.login();
    await fixture.makeClip("movie.mp4", { pictureSeconds: 2 });
    // Relative HLS paths share one owned cwd, including FFmpeg's implicit init.mp4.
    execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-i", "movie.mp4", "-c", "copy", "-hls_segment_type", "fmp4", "-hls_time", "1", "-hls_segment_filename", "segment%d.m4s", "variant.m3u8"], { cwd: fixture.root, timeout: 10000, windowsHide: true });
    await readFile(resolve(fixture.root, "init.mp4"));
    const playlist = await readFile(resolve(fixture.root, "variant.m3u8"));
    const video = await readFile(resolve(fixture.root, "movie.mp4"));
    const requests = [];
    let foreignHits = 0;
    const foreign = createServer((request, response) => {
      foreignHits++;
      response.end(video);
    });
    await new Promise((done) => foreign.listen(0, "127.0.0.1", done));
    const foreignOrigin = `http://127.0.0.1:${foreign.address().port}`;
    const mpd = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" minBufferTime="PT1S" mediaPresentationDuration="PT2S"><Period duration="PT2S"><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="100000" codecs="avc1.64001e" width="640" height="360"><BaseURL>${foreignOrigin}/video.mp4</BaseURL><SegmentBase><Initialization range="0-100"/></SegmentBase></Representation></AdaptationSet></Period></MPD>`;
    const upstream = createServer((request, response) => {
      void respondUpstream(request, response).catch((error) => {
        upstreamFailures.push(error);
        if (!response.headersSent) response.statusCode = 500;
        response.end();
      });
    });
    async function respondUpstream(request, response) {
      const path = new URL(request.url, "http://fixture").pathname;
      requests.push({ path, method: request.method, range: request.headers.range ?? null });
      assert.equal(request.headers.authorization, "Bearer c-fixture");
      response.setHeader("Content-Type", "application/octet-stream");
      if (path === "/redirect.m3u8") {
        response.writeHead(302, { Location: `${foreignOrigin}/video.mp4` });
        response.end();
      } else if (path === "/master.m3u8") {
        response.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nnested/variant\n");
      } else if (path === "/nested/variant") {
        response.end(playlist);
      } else if (path === "/bad-master.m3u8") {
        response.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nbad/variant\n");
      } else if (path === "/bad/variant" || path === "/hidden.mp4") {
        response.end(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${foreignOrigin}/video.mp4\n#EXT-X-ENDLIST\n`);
      } else if (path === "/dash.mp4") {
        response.end(`<?xml version="1.0"?>${mpd}`);
      } else if (path === "/latin1-dash.mp4") {
        response.end(Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?><!--é-->${mpd}`, "latin1"));
      } else if (path === "/padded-dash.mp4") {
        response.write(" ".repeat(700));
        setTimeout(() => response.end(`${" ".repeat(700)}${mpd}`), 10);
      } else if (path.startsWith("/nested/")) {
        response.end(await readFile(resolve(fixture.root, path.slice("/nested/".length))));
      } else {
        response.statusCode = 404;
        response.end();
      }
    }
    await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${upstream.address().port}`;
    try {
      await fixture.startWorker();
      for (const [path, status] of [
        ["/master.m3u8", "ready"],
        ["/bad-master.m3u8", "unavailable"],
        ["/hidden.mp4", "unavailable"],
        ["/dash.mp4", "unavailable"],
        ["/latin1-dash.mp4", "unavailable"],
        ["/padded-dash.mp4", "unavailable"],
        ["/redirect.m3u8", "unavailable"],
      ]) {
        const source = await admin.request("/sources", "POST", { name: `c-${path}`, kind: "http", config: { url: origin + path, headers: { Authorization: "Bearer c-fixture" } } });
        await admin.request(`/sources/${source.id}/test`, "POST");
        const id = fixture.sql(`SELECT id FROM media_items WHERE source_id='${source.id}'`);
        await admin.request("/media/previews", "POST", { media_ids: [id] });
        try { await fixture.waitForPreview(id, status, 60000); }
        catch (error) { throw upstreamFailures[0] ?? error; }
        if (upstreamFailures.length) throw upstreamFailures[0];
        assert.equal(foreignHits, 0, "decoder or proxy requested an ungranted origin");
        tests.push({ path, expected: status, result: "passed" });
        console.log(`PASS ${path}: ${status}; foreign requests=0`);
      }
      assert.ok(requests.some((record) => record.path === "/nested/variant"));
      assert.ok(requests.some((record) => record.path === "/nested/init.mp4"));
      assert.ok(requests.some((record) => record.path.startsWith("/nested/segment")));
      assert.equal(fixture.sql("SELECT count(*) FROM playback_sessions"), "0");
    } finally {
      upstream.closeAllConnections();
      foreign.closeAllConnections();
      await Promise.all([new Promise((done) => upstream.close(done)), new Promise((done) => foreign.close(done))]);
    }
  }, { env: { MEDIA_PREVIEW_TIMEOUT_SECONDS: "5" } });
  await verifyBinding();
  result = "passed";
} finally {
  if (owned && reportRoot) {
    const cleanup = await owned.verifyStopped();
    const workerClosed = await verifyClosedPort(Number(new URL(owned.workerOrigin).port));
    assert.equal(verifyPidAbsent(owned.workerPid), true, "owned Worker stopped");
    assert.equal(workerClosed, true, "owned Worker listener closed");
    await writeFile(resolve(reportRoot, "report.json"), JSON.stringify({ schema_version: 1, result, binding_file: bindingFile, binding_sha256: digest(await readFile(bindingFile)), test_sha256: testDigest, tests, upstream_failures: upstreamFailures.map(error => ({ name: error.name, message: error.message })), cleanup: { ...cleanup, worker_pid_absent: true, worker_port_closed: workerClosed }, limitations: ["isolated native FFmpeg HTTP fixtures, not product/device or final long-run acceptance", "shared delivery policy/DNS/decoder sandbox are outside this lane's authorized wiring"] }, null, 2) + "\n");
    console.log(`Evidence: ${resolve(reportRoot, "report.json")}`);
  }
}
