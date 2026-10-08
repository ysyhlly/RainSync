// Source-bound, synthetic local/HTTP-only API verification. No Agent or browser.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bindingPath = process.env.RAINSYNC_CAPABILITY_FACTS_BINDING_FILE;
assert.ok(
  bindingPath,
  "Set RAINSYNC_CAPABILITY_FACTS_BINDING_FILE; this fixture never builds",
);
assert.ok(
  process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  "Owned native PostgreSQL required",
);
const bindingBytes = await readFile(bindingPath),
  binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.equal(sha(JSON.stringify(binding.source)), binding.source_digest);
const coordinator = await Promise.all(
  [
    "tests/capability-route-facts.mjs",
    "tests/fixtures/media-stack.mjs",
    "tests/fixtures/server.mjs",
    "tests/fixtures/postgres.mjs",
    "deploy/owned-process.mjs",
  ].map(async (path) => ({
    path,
    sha256: sha(await readFile(resolve(repo, path))),
  })),
);
async function verifyBinding() {
  assert.equal(sha(await readFile(bindingPath)), sha(bindingBytes));
  for (const item of [...binding.source, ...coordinator])
    assert.equal(
      sha(await readFile(resolve(repo, item.path))),
      item.sha256,
      item.path,
    );
  for (const name of ["rainsync-server", "rainsync-media-worker"]) {
    const item = binding.binaries.find((v) => v.name === name);
    assert.ok(item);
    assert.equal(
      resolve(item.path),
      resolve(process.env.CARGO_TARGET_DIR, "debug", name),
    );
    assert.equal(sha(await readFile(item.path)), item.sha256);
  }
}
await verifyBinding();
const report = {
  schema_version: 1,
  result: "running",
  started_at: new Date().toISOString(),
  scope:
    "Owned local and ranged HTTP sources; current probe, plan/grant/job and replay facts. No Agent, browser, device or release acceptance.",
  backend_binding: {
    path: resolve(bindingPath),
    sha256: sha(bindingBytes),
    source_digest: binding.source_digest,
  },
  coordinator,
  checks: [],
};
let fixture, originServer, originPort, workerPid, failure;
function check(name, facts = {}) {
  report.checks.push({ name, result: "passed", ...facts });
  console.log(`PASS: ${name}`);
}
async function until(fn, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(80);
  }
  throw Error(`Deadline: ${label}`);
}
function decrypted(f, encoded) {
  const bytes = Buffer.from(encoded, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]),
  );
}
function device(set, selected, concrete = true) {
  return {
    binding: set.binding,
    excluded_candidates: [],
    results: set.candidates.map((c) => ({
      candidate_id: c.id,
      progressive: selected.includes(c.id) ? "probably" : "unsupported",
      mse_supported: selected.includes(c.id),
      ...(concrete
        ? {
            file_decoding: {
              supported: selected.includes(c.id),
              smooth: true,
              power_efficient: false,
            },
            mse_decoding: {
              supported: selected.includes(c.id),
              smooth: true,
              power_efficient: false,
            },
          }
        : {}),
    })),
  };
}
try {
  await isolatedMediaStack("capability-route-facts", async (f) => {
    fixture = f;
    const root = resolve(f.root, "owned-media");
    await mkdir(root);
    const avc = resolve(root, "owned-avc.mp4"),
      avc3 = resolve(root, "owned-avc3.mp4"),
      mov = resolve(root, "owned-quicktime.mov"),
      hevc = resolve(root, "owned-hevc.mp4"),
      hdr = resolve(root, "owned-hdr.mp4");
    const ffmpeg = (args) =>
      execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], {
        env: f.env,
        timeout: 20000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=red:s=320x180:r=25:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=sample_rate=48000:duration=1",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-b:a",
      "128k",
      avc,
    ]);
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=red:s=128x72:r=25:d=0.5",
      "-c:v",
      "libx265",
      "-x265-params",
      "pools=none:frame-threads=1:log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p10le",
      "-tag:v",
      "hvc1",
      hevc,
    ]);
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=red:s=128x72:r=25:d=0.5",
      "-c:v",
      "libx264",
      "-x264-params",
      "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      hdr,
    ]);
    ffmpeg(["-i", avc, "-c", "copy", "-tag:v", "avc3", avc3]);
    ffmpeg(["-i", avc, "-c", "copy", mov]);
    await writeFile(
      resolve(root, "owned-avc.srt"),
      "1\n00:00:00,000 --> 00:00:00,800\nOwned subtitle\n",
    );
    await f.startWorker();
    workerPid = f.workerPid;
    await f.startServer({ WORKER_URL: f.workerOrigin });
    const client = f.client();
    await client.login();
    const source = await client.request("/sources", "POST", {
      name: "owned capability facts",
      kind: "local",
      config: { root },
    });
    await client.request(`/sources/${source.id}/test`, "POST");
    const room = await client.request("/rooms", "POST", {
      name: "owned configuration facts",
    });
    let generation = 0;
    const choose = (media) => {
      generation++;
      // Labeled synthetic room-selection setup; not evidence of control events.
      f.sql(
        `UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media}"'),'{media_generation}','${generation}') WHERE room_id='${room.id}'`,
      );
      return {
        room_id: room.id,
        media_generation: generation,
        audio_index: null,
        position_ms: 0,
      };
    };
    const localId = (name) =>
      f.sql(
        `SELECT id FROM media_items WHERE source_id='${source.id}' AND resource='${name}'`,
      );
    let request = choose(localId("owned-avc.mp4"));
    const candidates = await client.request(
      "/playback-candidates",
      "POST",
      request,
    );
    assert.deepEqual(
      candidates.candidates.map((c) => c.id),
      ["direct", "remux", "audio_transcode", "transcode_720p"],
    );
    assert.equal(candidates.route_decisions.length, 4);
    assert.ok(candidates.route_decisions.every((v) => v.offered === true));
    check(
      "local offered-route explanations match the exact four candidate configurations",
    );
    const body = (set, selected, extra = {}) => ({
      ...request,
      mode: "auto",
      idempotency_key: randomUUID(),
      capabilities: {
        progressive_h264_aac: true,
        native_hls: false,
        mse_h264_aac: true,
      },
      candidate_report: device(set, selected),
      ...extra,
    });
    const input = body(candidates, ["direct"]),
      direct = await client.request("/playback-sessions", "POST", input);
    assert.deepEqual(
      direct.selected_output.configuration,
      candidates.candidates[0],
    );
    assert.equal(direct.selected_output.video_basis, "source_probe");
    assert.equal(direct.selected_output.audio_basis, "source_probe");
    assert.equal(direct.selected_audio_track, 1);
    assert.equal(direct.subtitle_mode, "external_vtt");
    const resource = (id) =>
      decrypted(
        f,
        JSON.parse(
          f.sql(`SELECT resource FROM playback_sessions WHERE id='${id}'`),
        ).encrypted,
      );
    const grant = resource(direct.session_id);
    assert.match(grant.source_version, /^stat-v1:/);
    assert.deepEqual(grant.selected_output, direct.selected_output);
    assert.deepEqual(
      (await client.request("/playback-sessions", "POST", input))
        .selected_output,
      direct.selected_output,
    );
    check(
      "direct plan, encrypted grant and idempotent replay retain identical source-probe configuration and track/subtitle facts",
      {
        source_version: grant.source_version,
        source_sha256: sha(await readFile(avc)),
        selected_output: direct.selected_output,
      },
    );
    await client.request(`/playback-sessions/${direct.session_id}`, "DELETE");
    const shifted = await client.request("/playback-candidates", "POST", {
      ...request,
      position_ms: 100,
    });
    assert.equal(
      shifted.route_decisions.find((v) => v.candidate_id === "remux").reason,
      "nonzero_copy_origin",
    );
    assert.equal(
      shifted.route_decisions.find((v) => v.candidate_id === "audio_transcode")
        .offered,
      false,
    );
    check(
      "nonzero copy origins are explained without changing zero-origin audio-only eligibility",
    );
    const audio = await client.request(
      "/playback-sessions",
      "POST",
      body(candidates, ["audio_transcode"]),
    );
    const spec = JSON.parse(
      f.sql(
        `SELECT spec FROM media_jobs WHERE session_id='${audio.session_id}'`,
      ),
    );
    assert.equal(
      spec.source_version,
      resource(audio.session_id).source_version,
    );
    assert.equal(spec.negotiated_mode, "audio_transcode");
    assert.equal(audio.timeline_origin_ms, 0);
    assert.equal(audio.selected_output.video_basis, "source_probe");
    assert.equal(
      audio.selected_output.audio_basis,
      "constrained_encoder_recipe",
    );
    await until(
      async () =>
        (await client.request(`/playback-sessions/${audio.session_id}`))
          .complete,
      "audio-only output publication",
    );
    const outputPath = resolve(
      f.env.CACHE_ROOT,
      f.sql(
        `SELECT o.relative_dir FROM media_outputs o JOIN media_jobs j ON j.id=o.job_id AND j.attempt=o.attempt WHERE j.session_id='${audio.session_id}'`,
      ),
      "index.m3u8",
    );
    const output = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-of", "json", outputPath],
        { encoding: "utf8", timeout: 10000 },
      ),
    );
    const video = output.streams.find((s) => s.codec_type === "video"),
      track = output.streams.find((s) => s.codec_type === "audio");
    assert.equal(video.width, 320);
    assert.equal(video.r_frame_rate, "25/1");
    assert.equal(track.channels, 2);
    assert.equal(track.sample_rate, "48000");
    assert.equal(track.profile, "LC");
    check(
      "zero-origin audio-only job copies proved video and encodes actual stereo AAC output under the same grant version",
      {
        source_version: spec.source_version,
        selected_output: audio.selected_output,
        observed_output: {
          width: video.width,
          frame_rate: video.r_frame_rate,
          audio_channels: track.channels,
          sample_rate: track.sample_rate,
        },
      },
    );
    await client.request(`/playback-sessions/${audio.session_id}`, "DELETE");
    const legacy = await client.request("/playback-sessions", "POST", {
      ...request,
      mode: "direct",
      idempotency_key: randomUUID(),
    });
    assert.equal(legacy.selected_output, undefined);
    await client.request(`/playback-sessions/${legacy.session_id}`, "DELETE");
    check("legacy requests retain absent selected-output facts");
    request = choose(localId("owned-avc3.mp4"));
    const avc3Set = await client.request(
      "/playback-candidates",
      "POST",
      request,
    );
    assert.deepEqual(
      avc3Set.candidates.map((candidate) => candidate.id),
      ["transcode_720p"],
    );
    assert.ok(
      avc3Set.route_decisions
        .slice(0, 3)
        .every(
          (decision) =>
            !decision.offered && decision.reason === "sample_entry_unsupported",
        ),
    );
    const avc3Plan = await client.request(
      "/playback-sessions",
      "POST",
      body(avc3Set, ["transcode_720p"]),
    );
    assert.equal(
      avc3Plan.selected_output.video_basis,
      "constrained_encoder_recipe",
    );
    assert.equal(avc3Plan.selected_output.configuration.id, "transcode_720p");
    assert.equal(avc3Plan.selected_candidate_id, "transcode_720p");
    await client.request(`/playback-sessions/${avc3Plan.session_id}`, "DELETE");
    check(
      "actual AVC3 source never acquires AVC1 direct/copy facts and uses only the explicit encode recipe",
    );
    request = choose(localId("owned-quicktime.mov"));
    const movSet = await client.request(
      "/playback-candidates",
      "POST",
      request,
    );
    assert.equal(movSet.route_decisions[0].offered, false);
    assert.equal(movSet.route_decisions[0].reason, "container_unsupported");
    assert.equal(movSet.candidates[0].id, "remux");
    const movPlan = await client.request(
      "/playback-sessions",
      "POST",
      body(movSet, ["remux"]),
    );
    assert.equal(movPlan.selected_candidate_id, "remux");
    assert.equal(movPlan.selected_output.video_basis, "source_probe");
    await client.request(`/playback-sessions/${movPlan.session_id}`, "DELETE");
    check(
      "actual QuickTime container does not masquerade as MP4 direct and retains a proved AVC remux configuration",
    );
    request = choose(localId("owned-hevc.mp4"));
    const hset = await client.request("/playback-candidates", "POST", request);
    assert.deepEqual(
      hset.candidates.map((c) => c.id),
      ["direct", "transcode_720p"],
    );
    assert.match(hset.candidates[0].video.content_type, /hvc1\.2\./);
    assert.equal(hset.candidates[0].audio, null);
    assert.equal(
      hset.route_decisions.find((v) => v.candidate_id === "remux").reason,
      "video_copy_unsupported",
    );
    const hplan = await client.request(
      "/playback-sessions",
      "POST",
      body(hset, ["direct"]),
    );
    assert.deepEqual(hplan.selected_output.configuration, hset.candidates[0]);
    assert.equal(hplan.selected_output.audio_basis, null);
    await client.request(`/playback-sessions/${hplan.session_id}`, "DELETE");
    const rejected = await client.request(
      "/playback-sessions",
      "POST",
      body(hset, ["direct"], {
        candidate_report: device(hset, ["direct"], false),
      }),
      422,
    );
    assert.equal(
      rejected.error.code,
      "DEVICE_HAS_NO_COMPATIBLE_PLAYBACK_TRANSPORT",
    );
    check(
      "actual Main10 SDR source supports bound direct/no-audio facts only with concrete positive file capability",
      {
        source_sha256: sha(await readFile(hevc)),
        configuration: hset.candidates[0],
      },
    );
    request = choose(localId("owned-hdr.mp4"));
    const hdrError = await client.request(
      "/playback-candidates",
      "POST",
      request,
      422,
    );
    assert.equal(hdrError.error.code, "HDR_UNSUPPORTED");
    assert.equal(hdrError.error.retryable, false);
    const hdrDirect = await client.request(
      "/playback-sessions",
      "POST",
      { ...request, mode: "direct", idempotency_key: randomUUID() },
      422,
    );
    assert.equal(hdrDirect.error.code, "HDR_UNSUPPORTED");
    check(
      "actual PQ source returns a safe terminal HDR boundary for candidates and explicit local direct playback",
    );
    let httpVersion = '"owned-v1"';
    const bytes = await readFile(avc);
    originServer = createServer((req, res) => {
      if (req.url !== "/owned.mp4" || !["GET", "HEAD"].includes(req.method)) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.headers["if-match"] && req.headers["if-match"] !== httpVersion) {
        res.writeHead(412);
        res.end();
        return;
      }
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      const start = match ? Number(match[1]) : 0,
        end =
          match && match[2]
            ? Math.min(Number(match[2]), bytes.length - 1)
            : bytes.length - 1;
      if (start >= bytes.length || end < start) {
        res.writeHead(416, { "content-range": `bytes */${bytes.length}` });
        res.end();
        return;
      }
      res.writeHead(match ? 206 : 200, {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        etag: httpVersion,
        "content-length": end - start + 1,
        ...(match
          ? { "content-range": `bytes ${start}-${end}/${bytes.length}` }
          : {}),
      });
      res.end(
        req.method === "HEAD" ? undefined : bytes.subarray(start, end + 1),
      );
    });
    await new Promise((done) => originServer.listen(0, "127.0.0.1", done));
    originPort = originServer.address().port;
    const origin = `http://127.0.0.1:${originPort}`;
    const httpSource = await client.request("/sources", "POST", {
      name: "owned HTTP configuration",
      kind: "http",
      config: {
        url: origin + "/owned.mp4",
        access_policy: {
          schema_version: 1,
          origins: [{ origin, cidrs: ["127.0.0.1/32"] }],
        },
      },
    });
    await client.request(`/sources/${httpSource.id}/test`, "POST");
    request = choose(
      f.sql(`SELECT id FROM media_items WHERE source_id='${httpSource.id}'`),
    );
    const httpSet = await client.request("/playback-candidates", "POST", {
      ...request,
      http_file_capabilities_version: 1,
    });
    assert.equal(httpSet.http_file_capabilities_version, 1);
    const httpBody = body(httpSet, ["direct"], {
      http_file_fallback_version: 1,
    });
    const httpPlan = await client.request(
      "/playback-sessions",
      "POST",
      httpBody,
    );
    assert.deepEqual(
      httpPlan.selected_output.configuration,
      httpSet.candidates[0],
    );
    assert.deepEqual(
      resource(httpPlan.session_id).selected_output,
      httpPlan.selected_output,
    );
    assert.deepEqual(
      (await client.request("/playback-sessions", "POST", httpBody))
        .selected_output,
      httpPlan.selected_output,
    );
    check(
      "reliable pinned HTTP preparation and replay carry the same proved selected configuration",
    );
    await client.request(`/playback-sessions/${httpPlan.session_id}`, "DELETE");
    httpVersion = '"owned-v2"';
    const staleHttp = await client.request(
      "/playback-sessions",
      "POST",
      body(httpSet, ["direct"], { http_file_fallback_version: 1 }),
      409,
    );
    assert.equal(staleHttp.error.code, "SOURCE_CHANGED");
    check(
      "HTTP representation change rejects old selected configuration before publication",
    );
    request = choose(localId("owned-avc.mp4"));
    const localSet = await client.request(
      "/playback-candidates",
      "POST",
      request,
    );
    await appendFile(avc, Buffer.from([0]));
    const staleLocal = await client.request(
      "/playback-sessions",
      "POST",
      body(localSet, ["direct"]),
      409,
    );
    assert.equal(staleLocal.error.code, "SOURCE_CHANGED");
    check(
      "local file-version change cannot reuse the prior candidate or selected-output facts",
    );
    await verifyBinding();
    report.result = "passed";
  });
} catch (error) {
  failure = error;
  report.result = "failed";
  report.failure = String(error.stack ?? error);
} finally {
  if (originServer) {
    originServer.closeAllConnections();
    await new Promise((done) => originServer.close(done));
  }
  if (fixture) {
    report.cleanup = {
      ...(await fixture.verifyStopped()),
      worker_pid_absent: !workerPid || verifyPidAbsent(workerPid),
      worker_port_closed: await verifyClosedPort(
        Number(new URL(fixture.workerOrigin).port),
      ),
      origin_port_closed: !originPort || (await verifyClosedPort(originPort)),
    };
    assert.ok(
      report.cleanup.worker_pid_absent &&
        report.cleanup.worker_port_closed &&
        report.cleanup.origin_port_closed,
    );
    report.finished_at = new Date().toISOString();
    const path = resolve(fixture.root, "report.json");
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
    console.log(`Evidence: ${path}`);
  }
}
if (failure) throw failure;
