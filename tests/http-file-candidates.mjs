// Focused public-API regression with actual native Server/Worker/PostgreSQL,
// owned generated silent H264 media and one controlled loopback HTTP origin. Never builds.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const bindingPath =
  process.env.RAINSYNC_HTTP_CANDIDATES_BINDING_FILE ??
  process.env.W03_BACKEND_BINDING;
assert.ok(
  bindingPath,
  "Set a successful frozen native backend binding; this suite never builds",
);
assert.ok(
  process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  "Owned native PostgreSQL is required; Docker is not used",
);
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Set RAINSYNC_ARTIFACT_DIR");
const bindingBytes = await readFile(bindingPath),
  binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
assert.ok(
  binding.source.some(
    (input) => input.path === "migrations/0037_http_file_fallback.sql",
  ),
);
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
for (const name of ["rainsync-server", "rainsync-media-worker"]) {
  assert.ok(
    binding.binaries.some(
      (binary) =>
        resolve(binary.path) ===
        resolve(target, name + (process.platform === "win32" ? ".exe" : "")),
    ),
    `Binding describes executed ${name}`,
  );
}
const coordinator = await Promise.all(
  [
    "tests/http-file-candidates.mjs",
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
    digest(await readFile(bindingPath)),
    digest(bindingBytes),
    "Build binding remained frozen",
  );
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
      "Executed binary remained frozen",
    );
}
await verifyBinding();
const report = {
  schema_version: 1,
  result: "running",
  started_at: new Date().toISOString(),
  checks: [],
  requests: [],
  unexpected_origin_requests: 0,
  scope:
    "Actual owned native PostgreSQL/Server/Worker APIs and generated silent H264 media; controlled origin barriers, explicitly seeded room state and owned membership/expiry SQL fault injection; no browser, device, production or long-run acceptance",
  backend_binding: {
    path: resolve(bindingPath),
    sha256: digest(bindingBytes),
    source_digest: binding.source_digest,
    binaries: binding.binaries,
  },
  coordinator,
};
const holds = new Set(),
  timers = new Set(),
  decoders = new Set(),
  decoderPids = [];
let fixture, originServer, originPort, workerPid, failure;
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw Error("Deadline: " + label);
}
function gate() {
  let release;
  const promise = new Promise((done) => {
    release = done;
  });
  const hold = {
    promise,
    released: false,
    release() {
      if (!hold.released) {
        hold.released = true;
        hold.released_at = new Date().toISOString();
        release();
      }
    },
  };
  holds.add(hold);
  return hold;
}
async function check(name, run) {
  const row = { name, result: "running", started_at: new Date().toISOString() };
  report.checks.push(row);
  try {
    Object.assign(row, await run(), {
      result: "passed",
      finished_at: new Date().toISOString(),
    });
    console.log("PASS: " + name);
  } catch (error) {
    row.result = "failed";
    row.failure = String(error.stack ?? error);
    throw error;
  }
}
async function answer(response) {
  return { status: response.status, body: await response.json() };
}
async function reject(response, code) {
  const value = await answer(response);
  assert.ok(
    [400, 401, 403, 409, 410, 422].includes(value.status),
    `Expected bounded admission rejection; received ${value.status}, code=${value.body?.error?.code ?? "none"}`,
  );
  assert.ok(value.body.error?.code);
  if (code) assert.equal(value.body.error.code, code);
  return value;
}
async function decodeOutput(url) {
  const child = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-protocol_whitelist",
      "http,tcp",
      "-allowed_extensions",
      "ALL",
      "-i",
      url.toString(),
      "-map",
      "0:v:0",
      "-frames:v",
      "8",
      "-f",
      "framemd5",
      "pipe:1",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  decoders.add(child);
  if (child.pid) decoderPids.push(child.pid);
  const output = [],
    errors = [];
  let total = 0,
    launchError,
    timedOut = false;
  child.once("error", (error) => {
    launchError = error;
  });
  child.stdout.on("data", (bytes) => {
    total += bytes.length;
    if (total > 1024 * 1024) child.kill("SIGKILL");
    else output.push(bytes);
  });
  let errorBytes = 0;
  child.stderr.on("data", (bytes) => {
    errorBytes += bytes.length;
    if (errorBytes <= 1024 * 1024) errors.push(bytes);
    else child.kill("SIGKILL");
  });
  child.done = new Promise((done) =>
    child.once("close", (code) => {
      decoders.delete(child);
      done(code);
    }),
  );
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 20000);
  timers.add(timer);
  let code;
  try {
    code = await child.done;
  } finally {
    clearTimeout(timer);
    timers.delete(timer);
  }
  if (launchError) throw launchError;
  assert.equal(timedOut, false, "Output decode completed within deadline");
  // FFmpeg failures may contain playback bearer URLs; retain only stderr hash.
  assert.equal(
    code,
    0,
    "Actual child decode failed; stderr SHA-256=" +
      digest(Buffer.concat(errors)),
  );
  const bytes = Buffer.concat(output),
    frames = bytes
      .toString()
      .split(/\r?\n/)
      .filter((line) => /^\s*0,/.test(line));
  assert.equal(
    frames.length,
    8,
    "Actual FFmpeg decoded eight child video frames",
  );
  return { decoded_frames: frames.length, framemd5_sha256: digest(bytes) };
}
try {
  await isolatedMediaStack("http-file-candidates", async (f) => {
    fixture = f;
    report.fixture = { id: f.id, postgres: f.postgresDiagnostics() };
    const original = await readFile(
      await f.makeClip("owned-capability.mp4", {
        pictureSeconds: 2,
        width: 320,
        height: 180,
      }),
    );
    const entries = new Map(),
      originErrors = [];
    const authorization = "Bearer owned-test-" + randomUUID();
    originServer = createServer(async (request, response) => {
      try {
        const path = new URL(request.url, "http://fixture.invalid").pathname;
        const entry = entries.get(path);
        if (!entry) {
          report.unexpected_origin_requests++;
          response.writeHead(404);
          response.end();
          return;
        }
        const record = {
          entry: entry.label,
          method: request.method,
          range: request.headers.range ?? null,
          status: null,
          served_body_length: 0,
          conditional: request.headers["if-match"] !== undefined,
          phase: entry.phase,
          authorization_matches:
            request.headers.authorization === authorization,
        };
        report.requests.push(record);
        record.closed = false;
        response.once("close", () => {
          record.closed = true;
        });
        assert.equal(
          record.authorization_matches,
          true,
          "Configured generated origin credential matches",
        );
        if (entry.expectedSeed) {
          const seeded = Number(
            f.sql(
              `SELECT count(*) FROM playback_http_representations h JOIN playback_sessions p ON p.id=h.session_id WHERE p.media_id=${quote(entry.mediaId)} AND NOT p.stopped AND p.resource ? 'http_file_context' AND h.identity->'metadata'->>'etag'=${quote(entry.expectedSeed)}`,
            ),
          );
          assert.ok(
            seeded > 0,
            "Independent restricted representation pin committed before origin I/O",
          );
          record.committed_seed = true;
          record.conditional_matches_frozen_identity =
            request.headers["if-match"] === entry.expectedSeed;
          assert.equal(
            record.conditional_matches_frozen_identity,
            true,
            "Origin request uses the frozen strong validator",
          );
        }
        entry.seen++;
        if (entry.hold) await entry.hold.promise;
        if (request.destroyed || response.destroyed) return;
        if (entry.failureStatus) {
          record.status = entry.failureStatus;
          response.writeHead(entry.failureStatus);
          response.end();
          return;
        }
        if (entry.failure) {
          record.status = 503;
          response.writeHead(503);
          response.end();
          return;
        }
        const bytes =
          entry.type === "playlist"
            ? Buffer.from(
                "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nchild.ts\n#EXT-X-ENDLIST\n",
              )
            : entry.bytes;
        const etag =
          entry.validator === "missing"
            ? null
            : (entry.validator === "weak" ? "W/" : "") +
              '"' +
              entry.version +
              '"';
        const headers = {
          "content-type":
            entry.type === "playlist"
              ? "application/vnd.apple.mpegurl"
              : "video/mp4",
          "accept-ranges": "bytes",
        };
        if (etag) headers.etag = etag;
        if (entry.validator === "date") {
          delete headers.etag;
          headers["last-modified"] = "Wed, 01 Jan 2020 00:00:00 GMT";
          headers.date = "Wed, 01 Jan 2020 00:02:00 GMT";
        }
        if (
          !entry.ignoreConditional &&
          request.headers["if-match"] &&
          request.headers["if-match"] !== etag
        ) {
          record.status = 412;
          response.writeHead(412, headers);
          response.end();
          return;
        }
        let start = 0,
          end = bytes.length - 1,
          status = 200;
        const range =
          request.method === "HEAD" || entry.unknownLength
            ? null
            : /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        if (range) {
          start = Number(range[1]);
          end = range[2] ? Math.min(Number(range[2]), end) : end;
          if (start >= bytes.length || end < start) {
            record.status = 416;
            response.writeHead(416, {
              ...headers,
              "content-range": `bytes */${bytes.length}`,
              "content-length": "0",
            });
            response.end();
            return;
          }
          status = 206;
          headers["content-range"] = `bytes ${start}-${end}/${bytes.length}`;
        }
        if (!entry.unknownLength)
          headers["content-length"] = String(end - start + 1);
        record.status = status;
        record.served_body_length =
          request.method === "HEAD" ? 0 : end - start + 1;
        response.writeHead(status, headers);
        response.end(
          request.method === "HEAD"
            ? undefined
            : bytes.subarray(start, end + 1),
        );
      } catch (error) {
        originErrors.push(String(error.message));
        response.destroy(error);
      }
    });
    await new Promise((done) => originServer.listen(0, "127.0.0.1", done));
    originPort = originServer.address().port;
    const origin = `http://127.0.0.1:${originPort}`;
    const policy = {
      schema_version: 1,
      origins: [{ origin, cidrs: ["127.0.0.1/32"] }],
    };
    await f.startWorker();
    workerPid = f.workerPid;
    await f.startServer({ WORKER_URL: f.workerOrigin });
    const admin = f.client(),
      adminUser = await admin.login();
    const seed = async (label, options = {}) => {
      const path = `/${randomUUID()}/${options.knownPlaylist ? "movie.m3u8" : "movie.mp4"}`;
      const entry = {
        label,
        bytes: original,
        version: "a",
        validator: "etag",
        type: "binary",
        phase: "setup",
        seen: 0,
        ...options,
      };
      entries.set(path, entry);
      const source = await admin.request("/sources", "POST", {
        name: "owned " + label,
        kind: "http",
        config: {
          url: origin + path,
          headers: { Authorization: authorization },
          access_policy: policy,
        },
      });
      await admin.request(`/sources/${source.id}/test`, "POST");
      entry.mediaId = f.sql(
        `SELECT id FROM media_items WHERE source_id=${quote(source.id)}`,
      );
      assert.ok(entry.mediaId);
      const room = await admin.request("/rooms", "POST", {
        name: "owned " + label,
      });
      // Setup only: explicitly synthetic persisted room selection, not a control-event claim.
      f.sql(
        `UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}',${quote(JSON.stringify(entry.mediaId))}::jsonb),'{media_generation}','1') WHERE room_id=${quote(room.id)}`,
      );
      const request = {
        room_id: room.id,
        media_generation: 1,
        audio_index: null,
        position_ms: 0,
      };
      return { entry, source, room, request, client: admin };
    };
    const preflight = (g, extra = {}) => {
      g.entry.phase = "preflight";
      return g.client.raw("/playback-candidates", {
        method: "POST",
        body: { ...g.request, http_file_capabilities_version: 1, ...extra },
        signal: AbortSignal.timeout(45000),
      });
    };
    const candidates = async (g) => {
      g.entry.phase = "preflight";
      const response = await preflight(g),
        value = await response.json();
      assert.equal(response.status, 200, value.error?.code);
      assert.equal(value.http_file_capabilities_version, 1);
      assert.ok(value.binding && value.binding.length <= 32768);
      assert.ok(value.candidates.length > 0 && value.candidates.length <= 4);
      return value;
    };
    const deviceReport = (set, excluded = []) => ({
      binding: set.binding,
      excluded_candidates: [...excluded],
      results: set.candidates.map((v) => ({
        candidate_id: v.id,
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
    const input = (g, set, extra = {}) => ({
      ...g.request,
      idempotency_key: randomUUID(),
      viewer_id: randomUUID(),
      plan_generation: 1,
      mode: "auto",
      observation_version: 1,
      http_file_fallback_version: 1,
      capabilities: {
        progressive_h264_aac: true,
        native_hls: false,
        mse_h264_aac: true,
      },
      candidate_report: deviceReport(set),
      ...extra,
    });
    const post = (g, body) => {
      g.entry.phase = "prepare";
      return g.client.raw("/playback-sessions", {
        method: "POST",
        body,
        signal: AbortSignal.timeout(45000),
      });
    };
    const stop = (g, plan) =>
      g.client.request(`/playback-sessions/${plan.session_id}`, "DELETE");
    const drained = async (g) => {
      await f.waitForSql(
        `SELECT count(*) FROM playback_requests r LEFT JOIN playback_preparations p ON p.session_id=r.session_id WHERE r.room_id=${quote(g.room.id)} AND (r.status='pending' OR p.drained_at IS NULL)`,
        "0",
        12000,
      );
      assert.equal(
        f.sql(
          `SELECT count(*) FROM playback_sessions WHERE room_id=${quote(g.room.id)} AND NOT stopped`,
        ),
        "0",
      );
      await f.waitForSql(
        `SELECT count(*) FROM media_executions e JOIN playback_sessions p ON p.id=e.session_id WHERE p.room_id=${quote(g.room.id)} AND e.reaped_at IS NULL`,
        "0",
        12000,
      );
    };
    const pin = (session) =>
      JSON.parse(
        f.sql(
          `SELECT jsonb_agg(jsonb_build_object('target',target_sha256,'identity',identity)) FROM playback_http_representations WHERE session_id=${quote(session)}`,
        ),
      );
    await check(
      "legacy candidates avoid origin I/O and explicit direct performs bounded transport classification without codec jobs",
      async () => {
        const g = await seed("legacy direct"),
          before = g.entry.seen;
        const legacy = await g.client.request(
          "/playback-candidates",
          "POST",
          g.request,
        );
        assert.equal(legacy.binding, null);
        assert.equal(legacy.http_file_capabilities_version, undefined);
        assert.equal(g.entry.seen, before);
        const beforeClassification = report.requests.length;
        const p = await g.client.request("/playback-sessions", "POST", {
          ...g.request,
          idempotency_key: randomUUID(),
          mode: "direct",
        });
        assert.equal(g.entry.seen - before, 3);
        assert.deepEqual(
          report.requests.slice(beforeClassification).map((record) => ({
            method: record.method,
            range: record.range,
            status: record.status,
            served_body_length: record.served_body_length,
            conditional: record.conditional,
            authorization_matches: record.authorization_matches,
            phase: record.phase,
          })),
          [
            {
              method: "HEAD",
              range: null,
              status: 200,
              served_body_length: 0,
              conditional: false,
              authorization_matches: true,
              phase: "setup",
            },
            {
              method: "GET",
              range: "bytes=0-1023",
              status: 206,
              served_body_length: 1024,
              conditional: true,
              authorization_matches: true,
              phase: "setup",
            },
            {
              method: "GET",
              range: "bytes=0-511",
              status: 206,
              served_body_length: 512,
              conditional: true,
              authorization_matches: true,
              phase: "setup",
            },
          ],
          "Only ordered authorized HEAD and bounded conditional prefix reads classify this representation",
        );
        assert.equal(p.delivery_mode, "direct");
        assert.equal(p.transport, "progressive");
        assert.equal(
          p.decision_reason,
          "http_requested_direct_legacy_transport_policy",
          "Transport classification cannot become authorized codec probe evidence",
        );
        assert.equal(
          f.sql(
            `SELECT count(*) FROM media_jobs WHERE session_id=${quote(p.session_id)}`,
          ),
          "0",
        );
        assert.equal(
          f.sql(
            `SELECT count(*) FROM media_executions WHERE session_id=${quote(p.session_id)} AND kind='job'`,
          ),
          "0",
        );
        assert.equal(report.unexpected_origin_requests, 0);
        await stop(g, p);
        await drained(g);
        return {
          legacy_candidates_origin_requests: 0,
          direct_transport_classification_requests: 3,
          direct_transport_classification_body_bytes: 1536,
          codec_probe_evidence: false,
          media_jobs: 0,
          job_executions: 0,
        };
      },
    );
    await check(
      "unknown HTTP candidate version rejects before origin I/O",
      async () => {
        const g = await seed("unsupported version"),
          before = g.entry.seen;
        const response = await preflight(g, {
          http_file_capabilities_version: 2,
        });
        assert.equal(response.status, 400);
        const value = await response.json();
        assert.equal(value.error.code, "INVALID_REQUEST");
        assert.equal(g.entry.seen, before);
        await drained(g);
        return { new_origin_requests: 0 };
      },
    );
    await check(
      "reliable HTTP preflight retires its probe and auto selects actual direct bytes",
      async () => {
        const g = await seed("direct candidates"),
          set = await candidates(g);
        assert.ok(set.candidates.some((v) => v.id === "direct"));
        await drained(g);
        assert.equal(
          f.sql(
            `SELECT count(*) FROM playback_observations o JOIN playback_sessions p ON p.id=o.session_id WHERE p.room_id=${quote(g.room.id)}`,
          ),
          "0",
        );
        g.entry.expectedSeed = '"a"';
        g.entry.phase = "prepare";
        const body = input(g, set),
          response = await post(g, body),
          p = await response.json();
        assert.equal(response.status, 200, p.error?.code);
        assert.equal(p.selected_candidate_id, "direct");
        assert.equal(p.delivery_mode, "direct");
        assert.equal(p.selected_audio_track, undefined);
        assert.deepEqual(
          p.audio_tracks,
          [],
          "Actual complete probe proves no audio; absence is not track zero",
        );
        assert.equal(pin(p.session_id).length, 1);
        assert.equal(pin(p.session_id)[0].identity.class, "binary");
        assert.equal(
          f.sql(
            `SELECT http_file_parent IS NULL FROM playback_requests WHERE session_id=${quote(p.session_id)}`,
          ),
          "t",
        );
        const bytes = await fetch(new URL(p.playback_url, f.workerOrigin), {
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(bytes.status, 200);
        assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), original);
        const replay = await post(g, body);
        assert.equal(replay.status, 200);
        assert.equal(
          (await replay.json()).session_id,
          p.session_id,
          "Completed response replay preserves session",
        );
        await stop(g, p);
        await drained(g);
        return {
          candidates: set.candidates.map((v) => v.id),
          exact_bytes: original.length,
          same_key_replay: true,
        };
      },
    );
    await check(
      "retained HTTP binding selects a new independent transcode after old Stop",
      async () => {
        const g = await seed("retained fallback"),
          set = await candidates(g);
        await drained(g);
        g.entry.expectedSeed = '"a"';
        const firstBody = input(g, set),
          firstResponse = await post(g, firstBody),
          first = await firstResponse.json();
        assert.equal(firstResponse.status, 200);
        await stop(g, first);
        const excluded = set.candidates
          .filter((v) => v.id !== "transcode_720p")
          .map((v) => v.id);
        assert.ok(excluded.length <= 3);
        const secondBody = input(g, set, {
          viewer_id: firstBody.viewer_id,
          plan_generation: 2,
          candidate_report: deviceReport(set, excluded),
        });
        const nextResponse = await post(g, secondBody),
          next = await nextResponse.json();
        assert.equal(nextResponse.status, 200, next.error?.code);
        assert.equal(next.selected_candidate_id, "transcode_720p");
        assert.notEqual(next.session_id, first.session_id);
        assert.equal(
          f.sql(
            `SELECT http_file_parent IS NULL FROM playback_requests WHERE session_id=${quote(next.session_id)}`,
          ),
          "t",
        );
        await f.waitForSql(
          `SELECT status FROM media_jobs WHERE session_id=${quote(next.session_id)}`,
          "succeeded",
          30000,
        );
        const decoded = await decodeOutput(
          new URL(next.playback_url, f.workerOrigin),
        );
        await stop(g, next);
        await drained(g);
        return {
          original_binding_reused: true,
          independent_grants: 2,
          ...decoded,
        };
      },
    );
    for (const change of ["etag", "length", "playlist"])
      await check(
        `frozen identity rejects changed ${change} even when origin ignores conditionals`,
        async () => {
          const g = await seed("changed " + change),
            set = await candidates(g);
          await drained(g);
          g.entry.expectedSeed = '"a"';
          g.entry.ignoreConditional = true;
          if (change === "etag") g.entry.version = "b";
          if (change === "length")
            g.entry.bytes = Buffer.concat([original, Buffer.from([0])]);
          if (change === "playlist") g.entry.type = "playlist";
          const response = await post(g, input(g, set));
          const rejected = await reject(response, "SOURCE_CHANGED");
          await drained(g);
          assert.ok(
            report.requests.filter(
              (v) => v.entry === g.entry.label && v.phase === "preflight",
            ).length > 0,
          );
          return { rejection: rejected.body.error.code, accepted_plans: 0 };
        },
      );
    for (const status of [401, 403])
      await check(
        `upstream ${status} remains classified input denial without invalidating RainSync login`,
        async () => {
          const g = await seed("input denied " + status);
          g.entry.failureStatus = status;
          const response = await preflight(g),
            value = await response.json();
          assert.equal(response.status, 502);
          assert.equal(value.error.code, "MEDIA_INPUT_DENIED");
          assert.equal(value.http_file_capabilities_version, undefined);
          assert.equal((await g.client.request("/auth/me")).id, adminUser.id);
          await drained(g);
          return {
            upstream_status: status,
            public_status: 502,
            login_still_valid: true,
          };
        },
      );
    await check(
      "candidate report cannot force a probe through explicit direct",
      async () => {
        const g = await seed("report direct reject"),
          set = await candidates(g);
        await drained(g);
        const before = g.entry.seen;
        await reject(await post(g, input(g, set, { mode: "direct" })));
        assert.equal(g.entry.seen, before);
        await drained(g);
        return { rejected_before_origin: true };
      },
    );
    for (const kind of [
      "weak",
      "missing",
      "unknown-length",
      "known-playlist",
      "hidden-playlist",
    ])
      await check(
        `unproven ${kind} cannot issue a concrete HTTP binding`,
        async () => {
          const options =
            kind === "weak" || kind === "missing"
              ? { validator: kind }
              : kind === "unknown-length"
                ? { unknownLength: true }
                : {
                    type: "playlist",
                    knownPlaylist: kind === "known-playlist",
                  };
          const g = await seed("unproven " + kind, options),
            response = await preflight(g),
            value = await response.json();
          assert.equal(response.status, 200, value.error?.code);
          assert.equal(value.http_file_capabilities_version, undefined);
          assert.ok(!value.binding);
          await drained(g);
          return {
            response_status: response.status,
            response_code: value.error?.code ?? null,
            binding_issued: false,
          };
        },
      );
    await check(
      "reliable Last-Modified input carries its independent pin to direct delivery",
      async () => {
        const g = await seed("date identity", { validator: "date" }),
          set = await candidates(g);
        await drained(g);
        const response = await post(g, input(g, set)),
          plan = await response.json();
        assert.equal(response.status, 200, plan.error?.code);
        const identity = pin(plan.session_id)[0].identity;
        assert.equal(identity.metadata.reliable_modified, true);
        assert.equal(
          identity.metadata.modified,
          "Wed, 01 Jan 2020 00:00:00 GMT",
        );
        assert.equal(identity.metadata.size, original.length);
        const delivery = await fetch(
          new URL(plan.playback_url, f.workerOrigin),
          { signal: AbortSignal.timeout(10000) },
        );
        assert.equal(delivery.status, 200);
        assert.deepEqual(Buffer.from(await delivery.arrayBuffer()), original);
        await stop(g, plan);
        await drained(g);
        return { reliable_date: true, exact_bytes: original.length };
      },
    );
    await check(
      "retryable source failure preserves the same encrypted expectation for a new attempt",
      async () => {
        const g = await seed("retry expectation"),
          set = await candidates(g);
        await drained(g);
        const body = input(g, set);
        g.entry.expectedSeed = '"a"';
        g.entry.failure = true;
        const response = await post(g, body);
        assert.ok([502, 503, 504].includes(response.status));
        await response.arrayBuffer();
        const first = JSON.parse(
          f.sql(
            `SELECT row_to_json(r) FROM (SELECT session_id,attempt,http_file_context_encrypted,http_file_parent FROM playback_requests WHERE idempotency_key=${quote(body.idempotency_key)}) r`,
          ),
        );
        assert.ok(first.http_file_context_encrypted);
        assert.equal(first.http_file_parent, null);
        g.entry.failure = false;
        const retried = await post(g, body),
          plan = await retried.json();
        assert.equal(retried.status, 200, plan.error?.code);
        const second = JSON.parse(
          f.sql(
            `SELECT row_to_json(r) FROM (SELECT session_id,attempt,http_file_context_encrypted,http_file_parent FROM playback_requests WHERE idempotency_key=${quote(body.idempotency_key)}) r`,
          ),
        );
        assert.equal(
          second.http_file_context_encrypted,
          first.http_file_context_encrypted,
        );
        assert.equal(second.attempt, first.attempt + 1);
        assert.notEqual(second.session_id, first.session_id);
        assert.equal(
          f.sql(
            `SELECT stopped FROM playback_sessions WHERE id=${quote(first.session_id)}`,
          ),
          "t",
        );
        await stop(g, plan);
        await drained(g);
        return {
          retry_attempt: second.attempt,
          frozen_context_unchanged: true,
        };
      },
    );
    await check(
      "cancelled key rejects a late candidate prepare without source I/O",
      async () => {
        const g = await seed("cancel candidate"),
          set = await candidates(g);
        await drained(g);
        const body = input(g, set),
          before = g.entry.seen;
        await g.client.request(
          `/playback-requests/${body.idempotency_key}`,
          "DELETE",
        );
        await reject(await post(g, body), "PLAYBACK_REQUEST_CANCELLED");
        assert.equal(g.entry.seen, before);
        await drained(g);
        return { cancelled_before_post: true, new_origin_requests: 0 };
      },
    );
    await check(
      "same user's other live login cannot consume the frozen HTTP context",
      async () => {
        const g = await seed("second login"),
          set = await candidates(g);
        await drained(g);
        const second = f.client();
        await second.login();
        const before = g.entry.seen;
        await reject(await post({ ...g, client: second }, input(g, set)));
        assert.equal(g.entry.seen, before);
        await drained(g);
        return { both_logins_live: true, foreign_login_origin_requests: 0 };
      },
    );
    await check(
      "near-expiry candidate clamps real pending lease and probe input before held origin is released",
      async () => {
        const g = await seed("near expiry"),
          set = await candidates(g);
        await drained(g);
        // Explicit fault injection using this isolated fixture's generated key:
        // preserve all genuine binding facts, shorten only its signed expiry.
        const key = Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64");
        const encoded = Buffer.from(set.binding, "base64");
        const decoder = createDecipheriv(
          "aes-256-gcm",
          key,
          encoded.subarray(0, 12),
        );
        decoder.setAuthTag(encoded.subarray(-16));
        const frozen = JSON.parse(
          Buffer.concat([
            decoder.update(encoded.subarray(12, -16)),
            decoder.final(),
          ]).toString(),
        );
        const expires =
          Number(
            f.sql(
              "SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint",
            ),
          ) + 3;
        frozen.authority.candidate.expires = expires;
        const nonce = randomBytes(12),
          encoder = createCipheriv("aes-256-gcm", key, nonce);
        const encrypted = Buffer.concat([
          encoder.update(JSON.stringify(frozen)),
          encoder.final(),
        ]);
        const shortened = {
          ...set,
          binding: Buffer.concat([
            nonce,
            encrypted,
            encoder.getAuthTag(),
          ]).toString("base64"),
        };
        const body = input(g, shortened);
        g.entry.expectedSeed = '"a"';
        const hold = gate();
        g.entry.hold = hold;
        const before = g.entry.seen,
          pending = post(g, body);
        pending.catch(() => {});
        await until(
          () => g.entry.seen > before,
          "actual near-expiry probe origin request",
        );
        assert.equal(
          f.sql(
            `SELECT p.expires_at<=to_timestamp(${expires}) AND r.lease_until<=to_timestamp(${expires}) FROM playback_requests r JOIN playback_sessions p ON p.id=r.session_id WHERE r.idempotency_key=${quote(body.idempotency_key)}`,
          ),
          "t",
          "Both production leases retain the candidate's deadline",
        );
        await until(
          () =>
            report.requests
              .filter((v) => v.entry === g.entry.label && v.phase === "prepare")
              .every((v) => v.closed),
          "origin closes under grant expiry while its response remains held",
          8000,
        );
        assert.equal(hold.released, false);
        const response = await pending,
          value = await response.json();
        assert.ok([409, 410, 502].includes(response.status));
        assert.ok(!value.session_id);
        await drained(g);
        const requests = g.entry.seen;
        await reject(await post(g, body));
        assert.equal(g.entry.seen, requests);
        hold.release();
        g.entry.hold = null;
        return {
          synthetic_shorter_signed_deadline: true,
          leases_clamped: true,
          origin_closed_before_release: true,
          incomplete_retry_rejected: true,
          final_status: response.status,
        };
      },
    );
    for (const phase of ["preflight", "prepare"])
      for (const authority of ["logout", "expiry", "membership", "source"])
        await check(
          `late ${phase} cannot publish after ${authority} changes`,
          async () => {
            const g = await seed("late " + phase + " " + authority);
            if (["logout", "expiry"].includes(authority)) {
              g.client = f.client();
              await g.client.login();
            }
            const invite =
              authority === "membership"
                ? await admin.request(`/rooms/${g.room.id}/invites`, "POST")
                : null;
            const oldEpoch = f.sql(
              `SELECT membership_epoch FROM room_members WHERE room_id=${quote(g.room.id)} AND user_id=${quote(adminUser.id)}`,
            );
            const set = phase === "prepare" ? await candidates(g) : null;
            if (set) {
              await drained(g);
              g.entry.expectedSeed = '"a"';
            }
            g.entry.phase = phase;
            g.entry.hold = gate();
            const before = g.entry.seen;
            const pending = set ? post(g, input(g, set)) : preflight(g);
            pending.catch(() => {});
            await until(
              () => g.entry.seen > before,
              "actual origin request before authority change",
            );
            if (authority === "logout")
              await g.client.request("/auth/logout", "POST");
            if (authority === "expiry")
              f.sql(
                `UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=${quote(digest(g.client.cookie.split("=")[1]))}`,
              );
            if (authority === "membership") {
              f.sql(
                `DELETE FROM room_members WHERE room_id=${quote(g.room.id)} AND user_id=${quote(adminUser.id)}`,
              );
              await admin.request(`/rooms/${g.room.id}/join`, "POST", {
                token: invite.token,
              });
              assert.notEqual(
                f.sql(
                  `SELECT membership_epoch FROM room_members WHERE room_id=${quote(g.room.id)} AND user_id=${quote(adminUser.id)}`,
                ),
                oldEpoch,
              );
            }
            if (authority === "source")
              await admin.request(
                `/sources/${g.source.id}/access-policy`,
                "POST",
                { expected_revision: 1, policy },
              );
            g.entry.hold.release();
            g.entry.hold = null;
            const response = await pending,
              value = await response.json();
            assert.ok(
              [401, 403, 409, 410, 502].includes(response.status),
              `Late ${authority}: ${response.status}`,
            );
            assert.equal(value.http_file_capabilities_version, undefined);
            assert.ok(!value.binding);
            assert.ok(!value.session_id);
            await drained(g);
            return {
              origin_barrier_observed: true,
              final_status: response.status,
              no_binding: true,
            };
          },
        );
    assert.deepEqual(originErrors, []);
    assert.equal(
      report.unexpected_origin_requests,
      0,
      "No HLS child origin request was followed",
    );
    report.confirmed_drains = {
      preparations: Number(
        f.sql(
          "SELECT count(*) FROM playback_preparations WHERE drained_at IS NOT NULL",
        ),
      ),
      worker_executions: Number(
        f.sql(
          "SELECT count(*) FROM media_executions WHERE reaped_at IS NOT NULL",
        ),
      ),
    };
    assert.ok(
      report.confirmed_drains.preparations > 0 &&
        report.confirmed_drains.worker_executions > 0,
    );
    await verifyBinding();
    report.result = "passed";
  });
} catch (error) {
  failure = error;
  report.result = "failed";
  report.failure = String(error.stack ?? error);
} finally {
  for (const hold of holds) hold.release();
  for (const timer of timers) clearTimeout(timer);
  for (const child of decoders) child.kill("SIGKILL");
  await Promise.all([...decoders].map((child) => child.done));
  if (originServer) {
    originServer.closeAllConnections();
    await new Promise((done) => originServer.close(done));
  }
  if (fixture) {
    report.cleanup = {
      ...(await fixture.verifyStopped()),
      worker_pid: workerPid,
      worker_pid_absent: !workerPid || verifyPidAbsent(workerPid),
      worker_port_closed: await verifyClosedPort(
        Number(new URL(fixture.workerOrigin).port),
      ),
      origin_port_closed:
        originPort === undefined || (await verifyClosedPort(originPort)),
      decoder_pids_absent: decoderPids.every(verifyPidAbsent),
    };
    assert.equal(report.cleanup.worker_pid_absent, true);
    assert.equal(report.cleanup.worker_port_closed, true);
    assert.equal(report.cleanup.origin_port_closed, true);
    assert.equal(report.cleanup.decoder_pids_absent, true);
    report.finished_at = new Date().toISOString();
    const output = resolve(fixture.root, "report.json");
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log("Evidence: " + output);
  }
}
if (failure) throw failure;
