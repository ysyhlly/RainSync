// Public API + actual owned native PostgreSQL/Server/Worker and generated media.
// No existing database, account, platform recording or source credentials.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";
assert.ok(
  process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  "Owned native PostgreSQL required",
);
assert.ok(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "Owned artifact directory required",
);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const report = {
  schema_version: 1,
  scope:
    "owned generated finite HLS public API, PostgreSQL and actual FFmpeg; no browser/platform/production",
  result: "failed",
  tests: [],
  started_at: new Date().toISOString(),
};
let fixture, upstream, upstreamPort, peer, failure;
const sourcePaths = [
  "crates/media-core/src/finite_hls/mod.rs",
  "crates/media-core/src/finite_hls/manifest.rs",
  "crates/media-core/src/finite_hls/probe.rs",
  "crates/media-core/src/finite_hls/transport_stream.rs",
  "crates/media-core/src/finite_hls/fmp4.rs",
  "crates/media-core/src/finite_hls/recipe.rs",
  "crates/media-core/src/static_hls/timeline.rs",
  "crates/media-core/src/static_hls/timeline_finite.rs",
  "apps/media-worker/src/owned_http.rs",
  "apps/media-worker/src/owned_http/finite_hls.rs",
  "apps/media-worker/src/owned_http/probe_owner.rs",
  "apps/media-worker/src/main.rs",
  "apps/server/src/finite_hls.rs",
  "apps/server/src/owned_http.rs",
  "apps/server/src/media.rs",
  "apps/server/src/http_file_fallback.rs",
  "migrations/0078_finite_hls_normalization.sql",
  "tests/finite-hls-native.mjs",
  "tests/fixtures/server.mjs",
  "tests/fixtures/media-stack.mjs",
  "tests/fixtures/postgres.mjs",
];
report.source_inputs = await Promise.all(
  sourcePaths.map(async (path) => ({
    path,
    sha256: sha(await readFile(path)),
  })),
);
report.binaries = await Promise.all(
  ["rainsync-server", "rainsync-media-worker"].map(async (name) => {
    const path = resolve(
      process.env.CARGO_TARGET_DIR ?? "target",
      "debug",
      name,
    );
    return { name, path, sha256: sha(await readFile(path)) };
  }),
);
async function unchanged() {
  for (const input of report.source_inputs)
    assert.equal(
      sha(await readFile(input.path)),
      input.sha256,
      "Exact relevant source stayed frozen: " + input.path,
    );
  for (const binary of report.binaries)
    assert.equal(
      sha(await readFile(binary.path)),
      binary.sha256,
      "Exact executed binary stayed frozen: " + binary.name,
    );
}
const toolsEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  OPENBLAS_NUM_THREADS: "1",
  OMP_NUM_THREADS: "1",
};
async function roomControl(f, client, room) {
  const ws = new WebSocket(f.origin.replace("http:", "ws:") + "/api/v1/ws", {
    headers: { Origin: f.origin, Cookie: client.cookie },
  });
  peer = ws;
  const frames = [];
  ws.on("message", (b) => frames.push(JSON.parse(b)));
  await new Promise((done, reject) => {
    ws.once("open", done);
    ws.once("error", reject);
  });
  async function next(type, predicate = () => true) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const at = frames.findIndex((f) => f.type === type && predicate(f));
      if (at >= 0) return frames.splice(at, 1)[0];
      await delay(10);
    }
    throw Error("Missing owned room " + type);
  }
  ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  const snapshot = await next("SNAPSHOT");
  let state = snapshot.state;
  return {
    async select(media) {
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
        (f) => f.command_id === command.command_id,
      );
      state = answer.state;
      assert.equal(state.media_id, media.id);
      return state.media_generation;
    },
  };
}
function ffmpeg(args) {
  execFileSync("/usr/bin/ffmpeg", ["-v", "error", "-nostdin", ...args], {
    env: toolsEnv,
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function decode(bytes, format) {
  const output = execFileSync(
    "/usr/bin/ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "pipe",
      "-format_whitelist",
      format,
      "-f",
      format,
      "-count_frames",
      "-show_streams",
      "-of",
      "json",
      "-i",
      "pipe:0",
    ],
    { input: bytes, env: toolsEnv, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(output).streams;
}
try {
  await isolatedMediaStack("finite-hls-runtime", async (f) => {
    fixture = f;
    report.fixture = { id: f.id, postgres: f.postgresDiagnostics() };
    const tsFile = resolve(f.root, "original.ts");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=30",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-bf",
      "0",
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-sc_threshold",
      "0",
      "-an",
      "-f",
      "mpegts",
      tsFile,
    ]);
    const ts = await readFile(tsFile);
    const fmp4Dir = resolve(f.root, "fmp4");
    await mkdir(fmp4Dir);
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=30",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-bf",
      "0",
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-sc_threshold",
      "0",
      "-an",
      "-avoid_negative_ts",
      "disabled",
      "-f",
      "hls",
      "-hls_time",
      "2",
      "-hls_segment_type",
      "fmp4",
      "-hls_playlist_type",
      "vod",
      resolve(fmp4Dir, "index.m3u8"),
    ]);
    const generated = await readFile(resolve(fmp4Dir, "index.m3u8"), "utf8");
    const segment = generated.split("\n").find((l) => l && !l.startsWith("#"));
    const fragment = await readFile(resolve(fmp4Dir, segment));
    const init = await readFile(resolve(fmp4Dir, "init.mp4"));
    const vod = (fmp4, boundary) =>
      `#EXTM3U\n#EXT-X-VERSION:${fmp4 ? 7 : 3}\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n${fmp4 ? '#EXT-X-MAP:URI="init.mp4"\n' : ""}#EXTINF:2,\na.${fmp4 ? "m4s" : "ts"}\n${boundary ? "#EXT-X-DISCONTINUITY\n" : ""}#EXTINF:2,\nb.${fmp4 ? "m4s" : "ts"}\n#EXT-X-ENDLIST\n`;
    const master =
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=160x90,FRAME-RATE=30.000,CODECS="avc1.64000a"\nselected.m3u8\n';
    const resources = new Map([
      ["/ts/master.m3u8", Buffer.from(master)],
      ["/ts/selected.m3u8", Buffer.from(vod(false, true))],
      ["/ts/a.ts", ts],
      ["/ts/b.ts", ts],
      ["/unmarked/index.m3u8", Buffer.from(vod(false, false))],
      ["/unmarked/a.ts", ts],
      ["/unmarked/b.ts", ts],
      ["/mp4/master.m3u8", Buffer.from(master)],
      ["/mp4/selected.m3u8", Buffer.from(vod(true, true))],
      ["/mp4/init.mp4", init],
      ["/mp4/a.m4s", fragment],
      ["/mp4/b.m4s", fragment],
      ["/weak/index.m3u8", Buffer.from(vod(false, true))],
      ["/weak/a.ts", ts],
      ["/weak/b.ts", ts],
    ]);
    const requests = [];
    upstream = createServer((req, res) => {
      const path = new URL(req.url, "http://owned").pathname;
      requests.push({
        path,
        method: req.method,
        identity: req.headers["accept-encoding"],
        authorized: req.headers.authorization === "Bearer owned-finite-fixture",
      });
      const bytes = resources.get(path);
      if (
        !bytes ||
        req.headers.authorization !== "Bearer owned-finite-fixture"
      ) {
        res.writeHead(403, { "Content-Length": 0 });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Length": bytes.length,
        "Content-Type": path.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "application/octet-stream",
        ETag: (path.startsWith("/weak") ? "W/" : "") + '"' + sha(bytes) + '"',
      });
      res.end(req.method === "HEAD" ? undefined : bytes);
    });
    await new Promise((done, reject) =>
      upstream.once("error", reject).listen(0, "127.0.0.1", done),
    );
    upstreamPort = upstream.address().port;
    const origin = `http://127.0.0.1:${upstreamPort}`;
    await f.startWorker();
    await f.startServer({ WORKER_URL: f.workerOrigin });
    const admin = f.client();
    await admin.login();
    const source = async (path) => {
      const before = new Set((await admin.request("/media")).map((v) => v.id));
      const s = await admin.request("/sources", "POST", {
        name: "owned finite " + path,
        kind: "http",
        config: {
          url: origin + path,
          headers: { Authorization: "Bearer owned-finite-fixture" },
          access_policy: {
            schema_version: 1,
            origins: [{ origin, cidrs: ["127.0.0.1/32"] }],
          },
        },
      });
      await admin.request(`/sources/${s.id}/test`, "POST");
      const media = (await admin.request("/media")).find(
        (v) => !before.has(v.id),
      );
      assert.ok(media);
      return { s, media };
    };
    const candidates = [];
    for (const path of [
      "/ts/master.m3u8",
      "/mp4/master.m3u8",
      "/unmarked/index.m3u8",
      "/weak/index.m3u8",
    ])
      candidates.push(await source(path));
    const room = await admin.request("/rooms", "POST", {
      name: "owned finite HLS",
    });
    const control = await roomControl(f, admin, room);
    for (const [index, format] of [
      [0, "mpegts"],
      [1, "mov"],
    ]) {
      const generation = await control.select(candidates[index].media);
      const plan = await admin
        .request("/playback-sessions", "POST", {
          room_id: room.id,
          media_generation: generation,
          position_ms: 0,
          mode: "transcode",
          finite_hls_version: 1,
          idempotency_key: randomUUID(),
        })
        .catch((error) => {
          report.failure_snapshot = JSON.parse(
            f.sql(
              "SELECT COALESCE(json_agg(json_build_object('state',state,'bytes',bytes,'finite_version',finite_hls_version,'proof',finite_hls_evidence,'disposed',disposed_at IS NOT NULL)),'[]'::json) FROM owned_http_representations",
            ),
          );
          report.upstream_requests = requests;
          throw error;
        });
      assert.ok(plan.session_id);
      assert.equal(plan.delivery_mode, "transcode");
      const held = JSON.parse(
        f.sql(
          `SELECT row_to_json(h) FROM owned_http_representations h WHERE session_id=${q(plan.session_id)}`,
        ),
      );
      assert.equal(held.finite_hls_version, 1);
      assert.equal(held.state, "ready");
      assert.ok(held.finite_hls_evidence);
      const evidence = held.finite_hls_evidence;
      assert.equal(evidence.segments.length, 2);
      assert.equal(evidence.segments[1].discontinuity, true);
      assert.equal(
        evidence.source_inventory.at(-1).sha256,
        sha(format === "mpegts" ? ts : fragment),
      );
      assert.notEqual(
        evidence.segments[1].original_sha256,
        evidence.segments[1].normalized_sha256,
      );
      assert.equal(
        f.sql(
          `SELECT finite_hls_evidence_valid(finite_hls_evidence,bytes,sha256) FROM owned_http_representations WHERE session_id=${q(plan.session_id)}`,
        ),
        "t",
      );
      assert.equal(
        f.sql(
          `SELECT finite_hls_evidence_valid(jsonb_set(finite_hls_evidence,'{segments,0,index}','null'::jsonb),bytes,sha256) FROM owned_http_representations WHERE session_id=${q(plan.session_id)}`,
        ),
        "f",
      );
      assert.equal(
        f.sql(
          `SELECT finite_hls_evidence_valid(finite_hls_evidence||'{"unknown":true}'::jsonb,bytes,sha256) FROM owned_http_representations WHERE session_id=${q(plan.session_id)}`,
        ),
        "f",
      );
      const gated = f.sql(
        `BEGIN;SET LOCAL rainsync.finite_hls_reader='';SELECT owned_http_representation_authority_allowed(${q(plan.session_id)})::text||':'||owned_http_job_allowed(${q(plan.session_id)})::text;ROLLBACK;`,
      );
      assert.ok(
        gated.includes("false:false"),
        "old reader cannot claim same logical queue",
      );
      const url = new URL(plan.playback_url, f.workerOrigin);
      const input = new URL(url);
      input.pathname = `/media-delivery/${plan.session_id}/source`;
      const response = await fetch(input);
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, Number(held.bytes));
      assert.equal(sha(bytes), held.sha256);
      const streams = decode(bytes, format);
      assert.equal(
        Number(streams.find((s) => s.codec_type === "video").nb_read_frames),
        120,
      );
      let body;
      const until = Date.now() + 25000;
      while (Date.now() < until) {
        const manifest = await fetch(url);
        if (manifest.ok) {
          body = await manifest.text();
          if (body.includes("#EXT-X-ENDLIST")) break;
        }
        await delay(100);
      }
      assert.ok(
        body?.includes("#EXT-X-ENDLIST"),
        "actual existing HLS job reaches EOF",
      );
      assert.ok(!body.includes(origin), "no upstream private URI in output");
      const urls = [];
      for (const line of body.split("\n")) {
        if (line.startsWith("#EXT-X-MAP:"))
          urls.push(new URL(/URI="([^"]+)"/.exec(line)[1], url));
        else if (line && !line.startsWith("#")) urls.push(new URL(line, url));
      }
      const pieces = [];
      for (const child of urls) {
        const read = await fetch(child);
        assert.equal(read.status, 200);
        pieces.push(Buffer.from(await read.arrayBuffer()));
      }
      const output = decode(Buffer.concat(pieces), "mov");
      assert.equal(
        Number(output.find((s) => s.codec_type === "video").nb_read_frames),
        120,
      );
      const owner = held.owner_id;
      await admin.request(`/playback-sessions/${plan.session_id}`, "DELETE");
      const disposedUntil = Date.now() + 10000;
      let disposed;
      while (Date.now() < disposedUntil) {
        disposed = f.sql(
          `SELECT state FROM owned_http_representations WHERE session_id=${q(plan.session_id)}`,
        );
        if (disposed === "disposed") break;
        await delay(100);
      }
      assert.equal(disposed, "disposed");
      assert.equal(
        f.sql(
          `SELECT count(*) FROM cache_write_reservations WHERE job_id=${q(owner)}`,
        ),
        "0",
      );
      report.tests.push({
        name:
          format === "mpegts"
            ? "master_TS_actual_reset_original_identity_normalized_source_existing_output_positive_cleanup"
            : "master_fMP4_actual_reset_sample_table_full_decode_existing_output_positive_cleanup",
        result: "passed",
        source_bytes: Number(held.bytes),
        source_sha256: held.sha256,
        inventory_resources: evidence.source_inventory.length,
        decoded_frames: 120,
      });
    }
    for (const index of [2, 3]) {
      const generation = await control.select(candidates[index].media);
      const requestStart = requests.length;
      const response = await admin.raw("/playback-sessions", {
        method: "POST",
        body: {
          room_id: room.id,
          media_generation: generation,
          position_ms: 0,
          mode: "transcode",
          finite_hls_version: 1,
          idempotency_key: randomUUID(),
        },
        headers: { "Content-Type": "application/json" },
      });
      const text = await response.text();
      assert.equal(response.status, 502, text);
      assert.ok(
        requests
          .slice(requestStart)
          .some(
            (r) =>
              r.path ===
              (index === 2 ? "/unmarked/index.m3u8" : "/weak/index.m3u8"),
          ),
        "A well-formed request reached the actual owned source reader before refusal",
      );
      const refused = JSON.parse(
        f.sql(
          `SELECT COALESCE(json_agg(json_build_object('state',state,'qualified',finite_hls_evidence IS NOT NULL)),'[]'::json) FROM owned_http_representations WHERE media_id=${q(candidates[index].media.id)}`,
        ),
      );
      assert.ok(
        refused.length > 0 &&
          refused.every((r) => r.state !== "ready" && !r.qualified),
      );
      report.tests.push({
        name:
          index === 2
            ? "undeclared_reset_refused"
            : "weak_source_identity_refused",
        result: "passed",
        status: response.status,
      });
    }
    assert.ok(requests.every((v) => v.authorized));
    report.upstream_requests = requests;
    peer.terminate();
    peer = undefined;
  });
  await unchanged();
  report.result = "passed";
} catch (error) {
  failure = error;
  report.failure = { message: error.message };
} finally {
  peer?.terminate();
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  }
  if (fixture) {
    report.cleanup = {
      ...(await fixture.verifyStopped()),
      worker_port_closed: await verifyClosedPort(
        Number(new URL(fixture.workerOrigin).port),
      ),
      worker_pid_absent: verifyPidAbsent(fixture.workerPid),
      origin_port_closed: await verifyClosedPort(upstreamPort),
    };
    assert.equal(report.cleanup.worker_port_closed, true);
    assert.equal(report.cleanup.worker_pid_absent, true);
    assert.equal(report.cleanup.origin_port_closed, true);
    report.finished_at = new Date().toISOString();
    const path = resolve(fixture.root, "finite-hls-report.json");
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
    console.log("Evidence: " + path);
  }
}
if (failure) throw failure;
console.log(
  "PASS: actual owned finite HLS public API, original identity, physical TS/fMP4 reset mapping, existing generated output, mixed reader and positive disposal",
);
