// Focused public-API regression with actual native Server/Worker/PostgreSQL,
// owned generated media and one controlled loopback HTTP origin. Never builds.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
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
const bindingPath =
  process.env.RAINSYNC_HTTP_CONTINUATION_BINDING_FILE ??
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
      (binary) => resolve(binary.path) === resolve(target, name),
    ),
    `Binding describes executed ${name}`,
  );
}
const coordinator = await Promise.all(
  [
    "tests/http-playback-continuation.mjs",
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
  scope:
    "Actual owned native PostgreSQL/Server/Worker APIs and generated H264/AAC media; controlled origin barriers and explicit owned membership/expiry SQL fault injection; no browser, device, production or long-run acceptance",
  backend_binding: {
    path: resolve(bindingPath),
    sha256: digest(bindingBytes),
    source_digest: binding.source_digest,
    binaries: binding.binaries,
  },
  coordinator,
};
const sockets = new Set(),
  holds = new Set(),
  timers = new Set(),
  originFailures = [],
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
    `Expected bounded admission rejection; received ${value.status}: ${JSON.stringify(value.body)}`,
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
  child.stderr.on("data", (bytes) => errors.push(bytes));
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
async function controller(f, client, room) {
  const ws = new WebSocket(f.origin.replace("http:", "ws:") + "/api/v1/ws", {
    headers: { Origin: f.origin, Cookie: client.cookie },
  });
  sockets.add(ws);
  ws.on("error", () => {});
  ws.once("close", () => sockets.delete(ws));
  const frames = [];
  ws.on("message", (bytes) => frames.push(JSON.parse(bytes)));
  await new Promise((done, fail) => {
    ws.once("open", done);
    ws.once("error", fail);
  });
  const next = (predicate) =>
    until(() => {
      const index = frames.findIndex(predicate);
      return index < 0 ? null : frames.splice(index, 1)[0];
    }, "public room response");
  ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  const snapshot = await next((frame) => frame.type === "SNAPSHOT");
  let state = snapshot.state,
    epoch = snapshot.control_epoch.id;
  return {
    async select(media) {
      const input = {
        protocol_version: 1,
        room_id: room.id,
        command_id: randomUUID(),
        control_epoch: epoch,
        expected_revision: state.revision,
        media_generation: state.media_generation,
        type: "CHANGE_MEDIA",
        payload: { media_id: media.id },
      };
      ws.send(JSON.stringify(input));
      let response = await next(
        (frame) => frame.command_id === input.command_id,
      );
      if (
        response.type === "ERROR" &&
        response.control_epoch &&
        ["CONTROL_EPOCH_EXPIRED", "CONTROL_EPOCH_REQUIRED"].includes(
          response.error?.code,
        )
      ) {
        epoch = response.control_epoch.id;
        ws.send(JSON.stringify({ ...input, control_epoch: epoch }));
        response = await next((frame) => frame.command_id === input.command_id);
      }
      assert.equal(response.type, "ACK", JSON.stringify(response));
      state = response.state;
      return state.media_generation;
    },
    close() {
      ws.terminate();
    },
  };
}
try {
  await isolatedMediaStack("http-playback-continuation", async (f) => {
    fixture = f;
    report.fixture = { id: f.id, postgres: f.postgresDiagnostics() };
    const noAudio = await readFile(
      await f.makeClip("owned-no-audio.mp4", {
        pictureSeconds: 2,
        width: 320,
        height: 180,
      }),
    );
    const audioPath = resolve(f.root, "owned-one-audio.mp4"),
      multiplePath = resolve(f.root, "owned-two-audio.mp4");
    const generate = (path, multiple) =>
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=red:s=320x180:r=25:d=2",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=2",
          ...(multiple
            ? [
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880:sample_rate=48000:duration=2",
              ]
            : []),
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          ...(multiple ? ["-map", "2:a:0"] : []),
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
          "-movflags",
          "+faststart",
          path,
        ],
        { timeout: 15000, windowsHide: true },
      );
    generate(audioPath, false);
    generate(multiplePath, true);
    const clips = {
      none: noAudio,
      one: await readFile(audioPath),
      multiple: await readFile(multiplePath),
    };
    report.media = Object.fromEntries(
      Object.entries(clips).map(([kind, bytes]) => [
        kind,
        {
          sha256: digest(bytes),
          bytes: bytes.length,
          generated_owned_media: true,
        },
      ]),
    );
    const origins = new Map();
    const auth = "Bearer owned-http-continuation-" + f.id;
    originServer = createServer(async (request, response) => {
      const path = new URL(request.url, "http://owned").pathname,
        state = origins.get(path);
      const row = {
        path,
        method: request.method,
        range: request.headers.range ?? null,
        if_match: request.headers["if-match"] ?? null,
        if_range: request.headers["if-range"] ?? null,
        if_unmodified_since: request.headers["if-unmodified-since"] ?? null,
        accept_encoding: request.headers["accept-encoding"] ?? null,
        authorization_matches: request.headers.authorization === auth,
        phase: state?.phase ?? "unknown",
        status: null,
        body_bytes: 0,
      };
      report.requests.push(row);
      response.once("close", () => {
        row.closed = true;
        row.closed_at = new Date().toISOString();
      });
      try {
        if (!state || !row.authorization_matches)
          return response.writeHead((row.status = 403)).end();
        if (state.hold) {
          const hold = state.hold;
          hold.rows.push(row);
          if (hold.observe) hold.observe(row);
          await hold.promise;
        }
        if (response.destroyed) return;
        if (state.failure)
          return response
            .writeHead((row.status = 503), { "Content-Length": 0 })
            .end();
        const bytes =
          state.type === "playlist"
            ? (state.playlistBytes ??
              Buffer.from(
                "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n",
              ))
            : state.bytes;
        const etag =
          state.validator === "etag"
            ? `"owned-${state.version}"`
            : state.validator === "weak"
              ? `W/"owned-${state.version}"`
              : null;
        const modified = "Thu, 01 Jan 2015 00:00:00 GMT";
        if (
          !state.ignoreCondition &&
          ((request.headers["if-match"] &&
            request.headers["if-match"] !== etag) ||
            (request.headers["if-unmodified-since"] && state.version !== "a"))
        )
          return response
            .writeHead((row.status = 412), { "Content-Length": 0 })
            .end();
        const matched = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        const ranged =
          matched &&
          (!request.headers["if-range"] ||
            request.headers["if-range"] === (etag ?? modified));
        const start = ranged ? Number(matched[1]) : 0,
          end =
            ranged && matched[2]
              ? Math.min(Number(matched[2]), bytes.length - 1)
              : bytes.length - 1;
        if (start > end)
          return response
            .writeHead((row.status = 416), {
              "Content-Range": `bytes */${bytes.length}`,
              "Content-Length": 0,
            })
            .end();
        const headers = {
          "Content-Type":
            state.type === "playlist"
              ? "application/vnd.apple.mpegurl"
              : "video/mp4",
          "Accept-Ranges": "bytes",
        };
        if (!state.unknownLength) headers["Content-Length"] = end - start + 1;
        if (etag) headers.ETag = etag;
        if (state.validator === "date") {
          headers["Last-Modified"] = modified;
          headers.Date = "Thu, 01 Jan 2015 00:05:00 GMT";
        }
        if (ranged)
          headers["Content-Range"] = `bytes ${start}-${end}/${bytes.length}`;
        response.writeHead((row.status = ranged ? 206 : 200), headers);
        if (request.method === "HEAD") return response.end();
        if (state.bodyHold) {
          const hold = state.bodyHold,
            prefixEnd = start + hold.prefix_bytes;
          assert.ok(
            prefixEnd < end + 1,
            "Owned body hold retains source bytes",
          );
          row.body_bytes = hold.prefix_bytes;
          row.prefix_sent_at = new Date().toISOString();
          response.write(bytes.subarray(start, prefixEnd));
          hold.rows.push(row);
          await hold.promise;
          if (response.destroyed) return;
          row.body_bytes += end + 1 - prefixEnd;
          response.end(bytes.subarray(prefixEnd, end + 1));
          return;
        }
        row.body_bytes = end - start + 1;
        response.end(bytes.subarray(start, end + 1));
      } catch (error) {
        row.failure = String(error.stack ?? error);
        originFailures.push(row.failure);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
    await new Promise((done, fail) =>
      originServer.once("error", fail).listen(0, "127.0.0.1", done),
    );
    originPort = originServer.address().port;
    const origin = `http://127.0.0.1:${originPort}`,
      policy = {
        schema_version: 1,
        origins: [{ origin, cidrs: ["127.0.0.1/32"] }],
      };
    await f.startWorker();
    workerPid = f.workerPid;
    await f.startServer({ WORKER_URL: f.workerOrigin });
    const admin = f.client();
    const adminUser = await admin.login();
    const source = async (label, options = {}) => {
      const path = `/${randomUUID()}/${options.type === "playlist" ? "movie.m3u8" : "movie.mp4"}`;
      const state = {
        bytes: clips[options.audio ?? "none"],
        version: "a",
        validator: "etag",
        type: "binary",
        phase: "root",
        ...options,
      };
      origins.set(path, state);
      const created = await admin.request("/sources", "POST", {
        name: "owned " + label,
        kind: "http",
        config: {
          url: origin + path,
          headers: { Authorization: auth },
          access_policy: policy,
        },
      });
      await admin.request(`/sources/${created.id}/test`, "POST");
      const mediaId = f.sql(
        `SELECT id FROM media_items WHERE source_id=${quote(created.id)}`,
      );
      assert.ok(mediaId, "Public scan discovers the HTTP item");
      return { source: created, media: { id: mediaId }, state, path };
    };
    const seed = async (label, options = {}) => {
      const entry = await source(label, options.origin ?? {}),
        client = options.client ?? admin;
      const room = await admin.request("/rooms", "POST", {
        name: "owned " + label,
      });
      if (client !== admin) {
        const invite = await admin.request(`/rooms/${room.id}/invites`, "POST");
        await client.request(`/rooms/${room.id}/join`, "POST", {
          token: invite.token,
        });
      }
      const control = await controller(f, admin, room),
        generation = await control.select(entry.media);
      const input = {
        room_id: room.id,
        media_generation: generation,
        viewer_id: randomUUID(),
        plan_generation: 1,
        idempotency_key: randomUUID(),
        observation_version: 1,
        http_file_fallback_version: 1,
        mode: "auto",
        position_ms: 0,
        capabilities: {
          progressive_h264_aac: true,
          native_hls: false,
          mse_h264_aac: true,
        },
        ...options.input,
      };
      return { ...entry, input, room, control, client };
    };
    const root = async (label, options = {}) => {
      const grant = await seed(label, options);
      const response = await grant.client.raw("/playback-sessions", {
        method: "POST",
        body: grant.input,
      });
      assert.equal(
        response.status,
        200,
        JSON.stringify(await response.clone().json()),
      );
      const plan = await response.json();
      return { ...grant, plan };
    };
    const postPath = (input) =>
      input.http_file_fallback
        ? "/playback-sessions/http-file-continuation"
        : "/playback-sessions";
    const post = (grant, input) =>
      grant.client.raw(postPath(input), { method: "POST", body: input });
    const final = (grant, changes = {}) => ({
      media_generation: grant.input.media_generation,
      seq: 1,
      event: "progress",
      media_time_ms: 400,
      paused: true,
      seeking: false,
      buffering: false,
      playback_rate: 1,
      has_played: true,
      ...changes,
    });
    const continuation = (grant, changes = {}) => ({
      ...grant.input,
      idempotency_key: randomUUID(),
      plan_generation: grant.input.plan_generation + 1,
      mode: "transcode",
      position_ms: 400,
      ...(grant.plan.selected_audio_track === undefined
        ? {}
        : { audio_index: grant.plan.selected_audio_track }),
      http_file_fallback: {
        parent_session_id: grant.plan.session_id,
        final_observation: final(grant),
      },
      ...changes,
    });
    const pins = (id) =>
      JSON.parse(
        f.sql(
          `SELECT COALESCE(json_agg(json_build_object('target_sha256',target_sha256,'identity',identity)),'[]'::json) FROM playback_http_representations WHERE session_id=${quote(id)}`,
        ),
      );
    const observation = (id) =>
      JSON.parse(
        f.sql(
          `SELECT json_build_object('seq',seq,'payload',payload,'observed_at',observed_at,'position_ms',position_ms,'has_played',has_played) FROM playback_observations WHERE session_id=${quote(id)}`,
        ),
      );
    const request = (key) => {
      const value = f.sql(
        `SELECT row_to_json(r) FROM playback_requests r WHERE idempotency_key=${quote(key)}`,
      );
      return value ? JSON.parse(value) : null;
    };
    const stopped = (id) =>
      f.sql(`SELECT stopped FROM playback_sessions WHERE id=${quote(id)}`) ===
      "t";
    const claimCount = (id) =>
      Number(
        f.sql(
          `SELECT count(*) FROM playback_requests WHERE http_file_parent=${quote(id)}`,
        ),
      );
    const originRequests = (grant) =>
      report.requests.filter((row) => row.path === grant.path);
    const cleanup = async (grant, child, input) => {
      grant.state.hold?.release();
      grant.state.hold = null;
      grant.state.bodyHold?.release();
      grant.state.bodyHold = null;
      const rootSession =
        grant.plan?.session_id ??
        request(grant.input.idempotency_key)?.session_id;
      if (input)
        await grant.client
          .raw(`/playback-requests/${input.idempotency_key}`, {
            method: "DELETE",
          })
          .then((r) => r.arrayBuffer())
          .catch(() => {});
      if (child)
        await grant.client
          .raw(`/playback-sessions/${child.session_id}`, { method: "DELETE" })
          .then((r) => r.arrayBuffer())
          .catch(() => {});
      if (rootSession)
        await grant.client
          .raw(`/playback-sessions/${rootSession}`, {
            method: "DELETE",
          })
          .then((r) => r.arrayBuffer())
          .catch(() => {});
      await grant.client
        .raw(`/playback-requests/${grant.input.idempotency_key}`, {
          method: "DELETE",
        })
        .then((r) => r.arrayBuffer())
        .catch(() => {});
      grant.control.close();
    };
    const held = (grant, observe) => {
      const hold = Object.assign(gate(), { rows: [], observe });
      grant.state.hold = hold;
      grant.state.phase = "child";
      return hold;
    };
    const success = async (grant, input) => {
      const response = await post(grant, input);
      const value = await answer(response);
      assert.equal(value.status, 200, JSON.stringify(value.body));
      assert.equal(value.body.delivery_mode, "transcode");
      assert.equal(
        Object.hasOwn(value.body, "http_file_fallback_version"),
        false,
      );
      return value.body;
    };
    const currentRoot = (grant) => {
      assert.equal(stopped(grant.plan.session_id), false);
      assert.equal(claimCount(grant.plan.session_id), 0);
    };
    const conditional = (rows, validator = "etag") => {
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal(row.authorization_matches, true);
        assert.equal(row.accept_encoding, "identity");
        if (validator === "etag") assert.equal(row.if_match, '"owned-a"');
        else
          assert.equal(
            row.if_unmodified_since,
            "Thu, 01 Jan 2015 00:00:00 GMT",
          );
        if (row.range)
          assert.equal(
            row.if_range,
            validator === "etag"
              ? '"owned-a"'
              : "Thu, 01 Jan 2015 00:00:00 GMT",
          );
      }
    };

    await check(
      "known no-audio root claims and stops atomically before exact conditional child I/O; final sample and lost-response replay deduplicate",
      async () => {
        const grant = await root("no-audio continuation");
        let child;
        const input = continuation(grant);
        try {
          assert.equal(grant.plan.http_file_fallback_version, 1);
          assert.equal(grant.plan.selected_audio_track, undefined);
          const originalPin = pins(grant.plan.session_id);
          assert.equal(originalPin.length, 1);
          assert.equal(originalPin[0].identity.class, "binary");
          const hold = held(grant, () => {
            assert.equal(stopped(grant.plan.session_id), true);
            assert.equal(claimCount(grant.plan.session_id), 1);
            assert.deepEqual(
              observation(grant.plan.session_id).payload,
              input.http_file_fallback.final_observation,
            );
          });
          const pending = post(grant, input);
          pending.catch(() => {});
          await until(
            () => hold.rows.length,
            "child source I/O after committed claim",
          );
          assert.equal(originFailures.length, 0);
          hold.release();
          grant.state.hold = null;
          child = await pending.then(answer).then((value) => {
            assert.equal(value.status, 200, JSON.stringify(value.body));
            return value.body;
          });
          assert.equal(child.delivery_mode, "transcode");
          assert.equal(
            Object.hasOwn(child, "http_file_fallback_version"),
            false,
          );
          conditional(hold.rows);
          assert.deepEqual(
            pins(child.session_id)[0].identity.metadata,
            originalPin[0].identity.metadata,
          );
          // Finish independent Worker input before attributing origin traffic
          // to a completed replay; its queued job otherwise races this count.
          await until(
            async () =>
              (
                await grant.client.request(
                  `/playback-sessions/${child.session_id}`,
                )
              ).status === "ready",
            "transcode output before lost-response replay",
            45000,
          );
          const stored = observation(grant.plan.session_id),
            claimed = request(input.idempotency_key),
            count = originRequests(grant).length;
          // Consume and discard the actual committed response, as a client whose ACK was lost.
          const replay = await success(grant, structuredClone(input));
          assert.equal(replay.session_id, child.session_id);
          assert.equal(originRequests(grant).length, count);
          assert.deepEqual(observation(grant.plan.session_id), stored);
          assert.equal(
            request(input.idempotency_key).http_file_context_encrypted,
            claimed.http_file_context_encrypted,
          );
          await grant.client.request(
            `/playback-sessions/${grant.plan.session_id}`,
            "DELETE",
            input.http_file_fallback.final_observation,
          );
          assert.deepEqual(observation(grant.plan.session_id), stored);
          await grant.client.request(
            `/playback-requests/${grant.input.idempotency_key}`,
            "DELETE",
          );
          await reject(
            await post(grant, {
              ...input,
              http_file_fallback: {
                ...input.http_file_fallback,
                final_observation: {
                  ...input.http_file_fallback.final_observation,
                  media_time_ms: 401,
                },
              },
            }),
            "PLAYBACK_REQUEST_CONFLICT",
          );
          await until(
            async () => {
              const value = await grant.client.request(
                `/playback-sessions/${child.session_id}`,
              );
              return value.status === "ready" ? value : null;
            },
            "actual transcode output publication",
            45000,
          );
          const manifestResponse = await fetch(
            new URL(child.playback_url, f.workerOrigin),
            { signal: AbortSignal.timeout(10000) },
          );
          assert.equal(manifestResponse.status, 200);
          const manifest = await manifestResponse.text();
          assert.match(manifest, /#EXTINF:/);
          const decoded = await decodeOutput(
            new URL(child.playback_url, f.workerOrigin),
          );
          conditional(
            originRequests(grant).filter((row) => row.phase === "child"),
          );
          await reject(
            await post(grant, {
              ...continuation(grant),
              http_file_fallback: { parent_session_id: child.session_id },
            }),
          );
          await reject(await post(grant, continuation(grant)));
          assert.equal(claimCount(grant.plan.session_id), 1);
          return {
            parent_session_id: grant.plan.session_id,
            child_session_id: child.session_id,
            final_seq: stored.seq,
            conditional_origin_requests: hold.rows.length,
            actual_transcode_manifest: true,
            decoded_output: decoded,
            lost_response_replay_session_unchanged: true,
          };
        } finally {
          await cleanup(grant, child, input);
        }
      },
    );
    await check(
      "one known audio stream and reliable Last-Modified preserve exact selected audio and conditional date",
      async () => {
        const grant = await root("date one audio", {
          origin: { audio: "one", validator: "date" },
        });
        const input = continuation(grant);
        let child;
        try {
          assert.equal(grant.plan.http_file_fallback_version, 1);
          assert.equal(grant.plan.selected_audio_track, 1);
          grant.state.phase = "child";
          const before = originRequests(grant).length;
          child = await success(grant, input);
          conditional(originRequests(grant).slice(before), "date");
          assert.equal(child.selected_audio_track, 1);
          return { selected_audio_track: child.selected_audio_track };
        } finally {
          await cleanup(grant, child, input);
        }
      },
    );
    await check(
      "two still-live same-user logins cannot claim or replay each other's frozen HTTP intent",
      async () => {
        const grant = await root("two live logins"),
          second = f.client(),
          input = continuation(grant);
        let child;
        await second.login();
        try {
          const hashCookie = (client) =>
            digest(client.cookie.slice(client.cookie.indexOf("=") + 1));
          assert.notEqual(hashCookie(second), hashCookie(grant.client));
          assert.equal(
            f.sql(
              `SELECT count(*) FROM sessions WHERE user_id=${quote(adminUser.id)} AND token_hash IN(${quote(hashCookie(second))},${quote(hashCookie(grant.client))}) AND expires_at>clock_timestamp()`,
            ),
            "2",
            "Both authenticated logins remain independently live",
          );
          const before = originRequests(grant).length,
            original = request(grant.input.idempotency_key),
            sample = observation(grant.plan.session_id);
          for (const body of [grant.input, input])
            await reject(
              await second.raw(postPath(body), { method: "POST", body }),
            );
          currentRoot(grant);
          assert.equal(originRequests(grant).length, before);
          assert.deepEqual(observation(grant.plan.session_id), sample);
          assert.equal(
            request(grant.input.idempotency_key).http_file_context_encrypted,
            original.http_file_context_encrypted,
          );
          assert.equal(
            (
              await grant.client.request(
                "/playback-sessions",
                "POST",
                grant.input,
              )
            ).session_id,
            grant.plan.session_id,
          );
          child = await success(grant, input);
          await until(
            async () =>
              (
                await grant.client.request(
                  `/playback-sessions/${child.session_id}`,
                )
              ).status === "ready",
            "child ready before second-login completed replay",
            45000,
          );
          const childCount = originRequests(grant).length,
            claimed = request(input.idempotency_key),
            finalSample = observation(grant.plan.session_id);
          await reject(
            await second.raw(postPath(input), {
              method: "POST",
              body: input,
            }),
          );
          assert.equal(originRequests(grant).length, childCount);
          assert.deepEqual(observation(grant.plan.session_id), finalSample);
          assert.equal(
            request(input.idempotency_key).http_file_context_encrypted,
            claimed.http_file_context_encrypted,
          );
          assert.equal(claimCount(grant.plan.session_id), 1);
          assert.equal(
            (await success(grant, input)).session_id,
            child.session_id,
          );
          return {
            independently_live_logins: 2,
            foreign_login_claims: 0,
            frozen_root_and_child_replay_denied: true,
          };
        } finally {
          await cleanup(grant, child, input);
          await second.request("/auth/logout", "POST");
        }
      },
    );
    await check(
      "ordinary playback route rejects continuation bodies without mutating the live parent",
      async () => {
        const grant = await root("ordinary route fence"),
          input = continuation(grant);
        try {
          const before = originRequests(grant).length,
            sample = observation(grant.plan.session_id),
            original = request(grant.input.idempotency_key);
          await reject(
            await grant.client.raw("/playback-sessions", {
              method: "POST",
              body: input,
            }),
          );
          currentRoot(grant);
          assert.equal(originRequests(grant).length, before);
          assert.deepEqual(observation(grant.plan.session_id), sample);
          assert.equal(
            request(grant.input.idempotency_key).http_file_context_encrypted,
            original.http_file_context_encrypted,
          );
          assert.equal(
            (
              await grant.client.request(
                "/playback-sessions",
                "POST",
                grant.input,
              )
            ).session_id,
            grant.plan.session_id,
          );
          return {
            rejected_origin_requests: 0,
            successor_claims: 0,
            root_replay_unchanged: true,
          };
        } finally {
          await cleanup(grant, null, input);
        }
      },
    );
    await check(
      "invalid final sample and cross-user/room/viewer/media fences leave a live root and make no origin request",
      async () => {
        const grant = await root("admission fences");
        try {
          const before = originRequests(grant).length;
          await admin.request("/users", "POST", {
            username: "owned-continuation-foreign",
            password: f.password,
          });
          const foreign = f.client();
          await foreign.login("owned-continuation-foreign");
          const invite = await admin.request(
            `/rooms/${grant.room.id}/invites`,
            "POST",
          );
          await foreign.request(`/rooms/${grant.room.id}/join`, "POST", {
            token: invite.token,
          });
          await reject(
            await foreign.raw("/playback-sessions/http-file-continuation", {
              method: "POST",
              body: continuation(grant),
            }),
          );
          currentRoot(grant);
          const otherRoom = await admin.request("/rooms", "POST", {
            name: "owned fence destination",
          });
          const otherControl = await controller(f, admin, otherRoom);
          const otherGeneration = await otherControl.select(grant.media);
          for (const changes of [
            { viewer_id: randomUUID() },
            { room_id: otherRoom.id, media_generation: otherGeneration },
            { media_generation: grant.input.media_generation + 1 },
            { plan_generation: grant.input.plan_generation },
            { mode: "remux" },
            { audio_index: 99 },
            {
              http_file_fallback: {
                parent_session_id: grant.plan.session_id,
                final_observation: final(grant, { playback_rate: 0 }),
              },
            },
          ]) {
            await reject(await post(grant, continuation(grant, changes)));
            currentRoot(grant);
          }
          otherControl.close();
          assert.equal(originRequests(grant).length, before);
          assert.equal(observation(grant.plan.session_id).seq, 0);
          return { rejected_before_origin: 8 };
        } finally {
          await cleanup(grant);
        }
      },
    );
    await check(
      "concurrent distinct keys admit one successor while identical in-flight retry cannot create another",
      async () => {
        const grant = await root("concurrent keys"),
          input = continuation(grant);
        let child;
        try {
          const hold = held(grant);
          const pending = post(grant, input);
          pending.catch(() => {});
          await until(() => hold.rows.length, "winning claim probe");
          const count = hold.rows.length;
          await reject(await post(grant, continuation(grant)));
          await reject(
            await post(grant, structuredClone(input)),
            "PLAYBACK_REQUEST_IN_PROGRESS",
          );
          assert.equal(hold.rows.length, count);
          assert.equal(claimCount(grant.plan.session_id), 1);
          hold.release();
          grant.state.hold = null;
          child = (await answer(await pending)).body;
          assert.equal(
            (await success(grant, input)).session_id,
            child.session_id,
          );
          return { successor_claims: 1 };
        } finally {
          await cleanup(grant, child, input);
        }
      },
    );
    await check(
      "retryable child source failure retains frozen claim and exact final sample for the same key",
      async () => {
        const grant = await root("temporary child failure"),
          input = continuation(grant);
        let child;
        try {
          grant.state.failure = true;
          grant.state.phase = "child";
          const failed = await answer(await post(grant, input));
          assert.ok(
            [502, 503, 504].includes(failed.status),
            JSON.stringify(failed),
          );
          const first = request(input.idempotency_key),
            stored = observation(grant.plan.session_id);
          assert.equal(first.http_file_parent, grant.plan.session_id);
          assert.equal(stopped(grant.plan.session_id), true);
          grant.state.failure = false;
          child = await success(grant, input);
          const second = request(input.idempotency_key);
          assert.equal(
            second.http_file_context_encrypted,
            first.http_file_context_encrypted,
          );
          assert.equal(second.attempt, first.attempt + 1);
          assert.deepEqual(observation(grant.plan.session_id), stored);
          assert.equal(claimCount(grant.plan.session_id), 1);
          assert.equal(stopped(first.session_id), true);
          conditional(
            originRequests(grant).filter((row) => row.phase === "child"),
          );
          return { attempt: second.attempt, frozen_claim_unchanged: true };
        } finally {
          grant.state.failure = false;
          await cleanup(grant, child, input);
        }
      },
    );
    await check(
      "cancel-before-POST and stopped-parent fresh key fence every late continuation",
      async () => {
        const grant = await root("cancel before claim"),
          input = continuation(grant);
        try {
          const before = originRequests(grant).length;
          await grant.client.request(
            `/playback-requests/${input.idempotency_key}`,
            "DELETE",
          );
          await reject(await post(grant, input), "PLAYBACK_REQUEST_CANCELLED");
          currentRoot(grant);
          assert.equal(observation(grant.plan.session_id).seq, 0);
          await grant.client.request(
            `/playback-sessions/${grant.plan.session_id}`,
            "DELETE",
          );
          await reject(await post(grant, continuation(grant)));
          assert.equal(claimCount(grant.plan.session_id), 0);
          assert.equal(originRequests(grant).length, before);
          return { cancelled_before_post: true, stopped_parent_new_claims: 0 };
        } finally {
          await cleanup(grant, null, input);
        }
      },
    );
    await check(
      "caller timeout queued before claim is fenced by cancellation before the room lock releases",
      async () => {
        const grant = await root("queued caller timeout"),
          input = continuation(grant);
        const marker = "owned_room_lock_" + randomUUID().replaceAll("-", "");
        const locker = f.sqlProcess(undefined, { interactive: true });
        let stdout = "";
        locker.stdout.on("data", (bytes) => {
          stdout += bytes.toString();
        });
        try {
          locker.stdin.write(
            `BEGIN; SELECT id FROM rooms WHERE id=${quote(grant.room.id)} FOR NO KEY UPDATE; SELECT '${marker}';\n`,
          );
          await until(
            () => stdout.includes(marker),
            "owned room row lock acquired",
          );
          const before = originRequests(grant).length,
            abort = new AbortController();
          const pending = grant.client.raw(postPath(input), {
            method: "POST",
            body: input,
            signal: abort.signal,
          });
          const outcome = pending.then(
            () => "response",
            () => "aborted",
          );
          await until(
            () =>
              Number(
                f.sql(
                  "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%rooms%' AND query LIKE '%FOR NO KEY UPDATE%'",
                ),
              ) > 0,
            "actual queued continuation room admission",
          );
          abort.abort();
          assert.equal(await outcome, "aborted");
          await grant.client.request(
            `/playback-requests/${input.idempotency_key}`,
            "DELETE",
          );
          locker.stdin.end("COMMIT;\n");
          await locker.done;
          await reject(await post(grant, input), "PLAYBACK_REQUEST_CANCELLED");
          currentRoot(grant);
          assert.equal(originRequests(grant).length, before);
          assert.equal(observation(grant.plan.session_id).seq, 0);
          return {
            caller_aborted_while_queued: true,
            successor_claims: 0,
            rejected_origin_requests: 0,
          };
        } finally {
          if (locker.exitCode === null) {
            locker.stdin.end("ROLLBACK;\n");
            await locker.done;
          }
          await cleanup(grant, null, input);
        }
      },
    );
    await check(
      "caller timeout after claim plus explicit cancellation closes child and prevents late POST resurrection",
      async () => {
        const grant = await root("cancel after claim"),
          input = continuation(grant);
        try {
          const hold = held(grant);
          const abort = new AbortController();
          const pending = grant.client.raw(postPath(input), {
            method: "POST",
            body: input,
            signal: abort.signal,
          });
          const outcome = pending.then(
            () => "response",
            () => "aborted",
          );
          await until(
            () => hold.rows.length,
            "claimed child before caller timeout",
          );
          abort.abort();
          assert.equal(await outcome, "aborted");
          await grant.client.request(
            `/playback-requests/${input.idempotency_key}`,
            "DELETE",
          );
          hold.release();
          grant.state.hold = null;
          await until(
            () =>
              request(input.idempotency_key)?.error_code ===
              "playback_request_cancelled",
            "durable successor cancellation",
          );
          const claimed = request(input.idempotency_key);
          assert.equal(stopped(claimed.session_id), true);
          assert.equal(stopped(grant.plan.session_id), true);
          const before = originRequests(grant).length;
          await reject(await post(grant, input), "PLAYBACK_REQUEST_CANCELLED");
          await reject(await post(grant, continuation(grant)));
          assert.equal(originRequests(grant).length, before);
          return { waiter_aborted: true, child_stopped: true };
        } finally {
          await cleanup(grant, null, input);
        }
      },
    );
    for (const kind of ["etag", "ignored-etag", "length", "type"])
      await check(
        `changed ${kind} fails before child publication and never rebinds frozen representation`,
        async () => {
          const grant = await root("changed " + kind),
            input = continuation(grant);
          try {
            const original = pins(grant.plan.session_id)[0];
            grant.state.phase = "child";
            if (kind === "length")
              grant.state.bytes = Buffer.concat([
                grant.state.bytes,
                Buffer.from([0]),
              ]);
            else if (kind === "type") {
              grant.state.type = "playlist";
              const playlist = Buffer.from(
                "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n",
              );
              grant.state.playlistBytes = Buffer.concat([
                playlist,
                Buffer.from(
                  "#" +
                    " ".repeat(grant.state.bytes.length - playlist.length - 1),
                ),
              ]);
              assert.equal(
                grant.state.playlistBytes.length,
                grant.state.bytes.length,
                "Type-only fault retains exact size and ETag",
              );
            } else {
              grant.state.version = "b";
              const replacement = Buffer.from(grant.state.bytes),
                header = replacement.indexOf(Buffer.from("mvhd"));
              assert.ok(header > 0);
              replacement[header + 11] ^= 1;
              grant.state.bytes = replacement;
              grant.state.ignoreCondition = kind === "ignored-etag";
            }
            const value = await reject(
              await post(grant, input),
              "SOURCE_CHANGED",
            );
            assert.equal(stopped(grant.plan.session_id), true);
            assert.equal(claimCount(grant.plan.session_id), 1);
            const claimed = request(input.idempotency_key);
            assert.equal(stopped(claimed.session_id), true);
            const pin = pins(claimed.session_id)[0];
            assert.deepEqual(pin.identity.metadata, original.identity.metadata);
            assert.equal(pin.identity.changed, true);
            if (kind === "etag")
              assert.ok(
                originRequests(grant).some(
                  (row) =>
                    row.phase === "child" &&
                    row.status === 412 &&
                    row.body_bytes === 0,
                ),
              );
            const before = originRequests(grant).length;
            await reject(await post(grant, input), "SOURCE_CHANGED");
            assert.equal(originRequests(grant).length, before);
            return { error: value.body.error.code, failed_child_stopped: true };
          } finally {
            await cleanup(grant, null, input);
          }
        },
      );
    for (const authority of ["logout", "membership", "source"])
      await check(
        `${authority} change during child probe prevents publication and same-key authority regeneration`,
        async () => {
          const client = authority === "logout" ? f.client() : admin;
          if (client !== admin) await client.login();
          const grant = await root("authority " + authority, { client }),
            input = continuation(grant);
          try {
            const originalEpoch = f.sql(
              `SELECT membership_epoch FROM room_members WHERE room_id=${quote(grant.room.id)} AND user_id=${quote(adminUser.id)}`,
            );
            const rejoinInvite =
              authority === "membership"
                ? await admin.request(`/rooms/${grant.room.id}/invites`, "POST")
                : null;
            const hold = held(grant);
            const pending = post(grant, input);
            pending.catch(() => {});
            await until(
              () => hold.rows.length,
              "claimed child held during " + authority,
            );
            if (authority === "logout") {
              await client.request("/auth/logout", "POST");
              await client.login();
            }
            if (authority === "membership") {
              f.sql(
                `DELETE FROM room_members WHERE room_id=${quote(grant.room.id)} AND user_id=${quote(adminUser.id)}`,
              );
              await admin.request(`/rooms/${grant.room.id}/join`, "POST", {
                token: rejoinInvite.token,
              });
              assert.notEqual(
                f.sql(
                  `SELECT membership_epoch FROM room_members WHERE room_id=${quote(grant.room.id)} AND user_id=${quote(adminUser.id)}`,
                ),
                originalEpoch,
              );
            }
            if (authority === "source") {
              const revised = await admin.request(
                `/sources/${grant.source.id}/access-policy`,
                "POST",
                { expected_revision: 1, policy },
              );
              assert.equal(revised.access_policy_revision, 2);
            }
            hold.release();
            grant.state.hold = null;
            const rejected = await answer(await pending);
            assert.ok(
              rejected.status >= 400 && rejected.body.error?.code,
              JSON.stringify(rejected),
            );
            const before = originRequests(grant).length;
            await reject(await post(grant, input));
            await reject(await post(grant, grant.input));
            assert.equal(originRequests(grant).length, before);
            assert.equal(
              stopped(request(input.idempotency_key).session_id),
              true,
            );
            return { authority, final_publication_rejected: true };
          } finally {
            await cleanup(grant, null, input);
          }
        },
      );
    for (const authority of ["logout", "membership", "source"])
      await check(
        `${authority} change during initial opt-in root probe cannot regenerate the frozen context on replay`,
        async () => {
          const client = authority === "logout" ? f.client() : admin;
          if (client !== admin) await client.login();
          const grant = await seed("initial authority " + authority, {
            client,
          });
          try {
            const rejoinInvite =
              authority === "membership"
                ? await admin.request(`/rooms/${grant.room.id}/invites`, "POST")
                : null;
            const hold = held(grant);
            grant.state.phase = "initial-root";
            const pending = post(grant, grant.input);
            pending.catch(() => {});
            await until(
              () => hold.rows.length,
              "initial root probe held during " + authority,
            );
            const original = request(grant.input.idempotency_key);
            assert.ok(
              original.http_file_context_encrypted,
              "Initial root captured authority before probe",
            );
            if (authority === "logout") {
              await client.request("/auth/logout", "POST");
              await client.login();
            }
            if (authority === "membership") {
              f.sql(
                `DELETE FROM room_members WHERE room_id=${quote(grant.room.id)} AND user_id=${quote(adminUser.id)}`,
              );
              await admin.request(`/rooms/${grant.room.id}/join`, "POST", {
                token: rejoinInvite.token,
              });
            }
            if (authority === "source")
              await admin.request(
                `/sources/${grant.source.id}/access-policy`,
                "POST",
                { expected_revision: 1, policy },
              );
            hold.release();
            grant.state.hold = null;
            const rejected = await answer(await pending);
            assert.ok(
              rejected.status >= 400 && rejected.body.error?.code,
              JSON.stringify(rejected),
            );
            const before = originRequests(grant).length;
            await reject(await post(grant, grant.input));
            assert.equal(originRequests(grant).length, before);
            const after = request(grant.input.idempotency_key);
            assert.equal(
              after.http_file_context_encrypted,
              original.http_file_context_encrypted,
            );
            assert.equal(stopped(after.session_id), true);
            return { authority, frozen_initial_context_unchanged: true };
          } finally {
            await cleanup(grant);
          }
        },
      );
    await check(
      "a newer same-viewer intent retires a claimed child while its real origin probe is held",
      async () => {
        const grant = await root("viewer replacement race"),
          input = continuation(grant);
        let replacement;
        const replacementInput = {
          ...grant.input,
          mode: "direct",
          plan_generation: 3,
          idempotency_key: randomUUID(),
        };
        try {
          const hold = held(grant),
            pending = post(grant, input);
          pending.catch(() => {});
          await until(
            () => hold.rows.length,
            "claimed child source request before viewer replacement",
          );
          const claimed = request(input.idempotency_key),
            stored = observation(grant.plan.session_id);
          assert.equal(claimed.http_file_parent, grant.plan.session_id);
          assert.equal(stopped(grant.plan.session_id), true);
          const value = await answer(await post(grant, replacementInput));
          assert.equal(value.status, 200, JSON.stringify(value.body));
          replacement = value.body;
          assert.equal(replacement.plan_generation, 3);
          assert.equal(
            Object.hasOwn(replacement, "http_file_fallback_version"),
            false,
          );
          await until(
            () => hold.rows.every((row) => row.closed),
            "superseded child origin socket closes before release",
            10000,
          );
          assert.ok(hold.rows.every((row) => row.body_bytes === 0));
          const rejected = await reject(await pending, "STALE_PLAYBACK_PLAN");
          assert.equal(stopped(claimed.session_id), true);
          assert.deepEqual(observation(grant.plan.session_id), stored);
          await until(
            () =>
              f.sql(
                `SELECT count(*) FROM media_executions WHERE session_id=${quote(claimed.session_id)} AND reaped_at IS NULL`,
              ) === "0",
            "superseded child actual Worker execution drain",
          );
          const before = originRequests(grant).length;
          await reject(await post(grant, input), "STALE_PLAYBACK_PLAN");
          assert.equal(originRequests(grant).length, before);
          hold.release();
          grant.state.hold = null;
          assert.equal(
            (
              await grant.client.request(
                `/playback-sessions/${replacement.session_id}`,
              )
            ).status,
            "ready",
          );
          return {
            replacement_plan_generation: 3,
            old_child_error: rejected.body.error.code,
            origin_closed_before_release: true,
            worker_execution_reaped: true,
          };
        } finally {
          await cleanup(grant, replacement, input);
          await grant.client
            .raw(`/playback-requests/${replacementInput.idempotency_key}`, {
              method: "DELETE",
            })
            .then((response) => response.arrayBuffer());
        }
      },
    );
    for (const authority of ["logout", "membership", "source", "viewer"])
      await check(
        `Worker HTTP delivery fences ${authority} changes while actual origin headers wait`,
        async () => {
          const client = authority === "logout" ? f.client() : admin;
          if (client !== admin) await client.login();
          const grant = await root("Worker HTTP " + authority, { client });
          let replacement, replacementInput;
          try {
            const invite =
              authority === "membership"
                ? await admin.request(`/rooms/${grant.room.id}/invites`, "POST")
                : null;
            const hold = held(grant);
            grant.state.phase = "worker-held-delivery";
            const url = new URL(grant.plan.playback_url, f.workerOrigin);
            const pending = fetch(url, {
              headers: { Range: "bytes=128-511" },
              signal: AbortSignal.timeout(15000),
            });
            pending.catch(() => {});
            await until(
              () => hold.rows.length,
              "actual Worker HTTP origin request before " + authority,
            );
            assert.ok(
              Number(
                f.sql(
                  `SELECT count(*) FROM media_executions WHERE session_id=${quote(grant.plan.session_id)} AND kind='delivery' AND reaped_at IS NULL`,
                ),
              ) > 0,
              "Actual unreaped delivery owner exists during held HTTP headers",
            );
            conditional(hold.rows);
            const began = Date.now();
            if (authority === "logout") {
              await client.request("/auth/logout", "POST");
              await client.login();
            }
            if (authority === "membership") {
              f.sql(
                `DELETE FROM room_members WHERE room_id=${quote(grant.room.id)} AND user_id=${quote(adminUser.id)}`,
              );
              await client.request(`/rooms/${grant.room.id}/join`, "POST", {
                token: invite.token,
              });
            }
            if (authority === "source")
              await admin.request(
                `/sources/${grant.source.id}/access-policy`,
                "POST",
                { expected_revision: 1, policy },
              );
            if (authority === "viewer") {
              replacementInput = {
                ...grant.input,
                mode: "direct",
                plan_generation: 2,
                idempotency_key: randomUUID(),
              };
              const value = await answer(await post(grant, replacementInput));
              assert.equal(value.status, 200, JSON.stringify(value.body));
              replacement = value.body;
            }
            const denied = await reject(
              await pending,
              "INVALID_PLAYBACK_SESSION",
            );
            await until(
              () => hold.rows.every((row) => row.closed),
              "revoked HTTP origin socket closes while barrier stays held",
              10000,
            );
            assert.ok(
              hold.rows.every(
                (row) => row.status === null && row.body_bytes === 0,
              ),
              "Revocation exposes no held source headers or media bytes",
            );
            await until(
              () =>
                f.sql(
                  `SELECT count(*) FROM media_executions WHERE session_id=${quote(grant.plan.session_id)} AND kind='delivery' AND reaped_at IS NULL`,
                ) === "0",
              "actual Worker delivery durable drain",
            );
            const before = originRequests(grant).length;
            await reject(await fetch(url), "INVALID_PLAYBACK_SESSION");
            assert.equal(originRequests(grant).length, before);
            hold.release();
            grant.state.hold = null;
            if (replacement)
              assert.equal(
                (
                  await grant.client.request(
                    `/playback-sessions/${replacement.session_id}`,
                  )
                ).status,
                "ready",
              );
            return {
              authority,
              error: denied.body.error.code,
              revoked_in_ms: Date.now() - began,
              origin_closed_before_release: true,
              media_bytes_exposed: 0,
              worker_execution_reaped: true,
            };
          } finally {
            await cleanup(grant, replacement);
            if (replacementInput)
              await grant.client
                .raw(`/playback-requests/${replacementInput.idempotency_key}`, {
                  method: "DELETE",
                })
                .then((response) => response.arrayBuffer());
          }
        },
      );
    await check(
      "Worker drains an already-started Binary response after logout while its consumer is retained and paused",
      async () => {
        const client = f.client();
        await client.login();
        const grant = await root("Worker active body logout", {
          client,
          origin: { audio: "one" },
        });
        let consumer, outgoing;
        const clientEvents = { errors: [], closed: false };
        try {
          const prefixBytes = 2048,
            hold = Object.assign(gate(), {
              rows: [],
              prefix_bytes: prefixBytes,
            });
          assert.ok(grant.state.bytes.length > prefixBytes);
          grant.state.bodyHold = hold;
          grant.state.phase = "worker-active-body";
          const url = new URL(grant.plan.playback_url, f.workerOrigin),
            responseReady = new Promise((done, fail) => {
              outgoing = httpRequest(
                url,
                {
                  headers: { Range: `bytes=0-${grant.state.bytes.length - 1}` },
                },
                (response) => {
                  consumer = response;
                  consumer.pause();
                  consumer.on("error", (error) => {
                    clientEvents.errors.push(error.code ?? error.name);
                  });
                  consumer.once("close", () => {
                    clientEvents.closed = true;
                  });
                  done(response);
                },
              );
              outgoing.once("error", fail);
              outgoing.end();
            });
          responseReady.catch(() => {});
          await until(
            () => hold.rows.length,
            "actual Worker origin sent validated headers and Binary prefix",
          );
          const response = await Promise.race([
            responseReady,
            delay(10000).then(() => {
              throw Error("Deadline: actual Worker active-body response");
            }),
          ]);
          assert.equal(response.statusCode, 206);
          assert.equal(response.headers.etag, '"owned-a"');
          assert.equal(
            response.headers["content-length"],
            String(grant.state.bytes.length),
          );
          assert.equal(
            response.headers["content-range"],
            `bytes 0-${grant.state.bytes.length - 1}/${grant.state.bytes.length}`,
          );
          const initial = await until(
            () => consumer.read(1024),
            "actual Worker client receives the complete Binary sniff prefix",
          );
          assert.deepEqual(initial, grant.state.bytes.subarray(0, 1024));
          assert.equal(consumer.readableFlowing, false);
          assert.equal(consumer.complete, false);
          assert.equal(consumer.destroyed, false);
          assert.equal(hold.released, false);
          assert.ok(hold.rows.every((row) => !row.closed));
          conditional(hold.rows);
          const execution = JSON.parse(
            f.sql(
              `SELECT row_to_json(e) FROM media_executions e WHERE session_id=${quote(grant.plan.session_id)} AND kind='delivery' AND reaped_at IS NULL`,
            ),
          );
          assert.ok(
            execution?.id,
            "Actual live delivery owner precedes logout",
          );
          const began = Date.now();
          await client.request("/auth/logout", "POST");
          const logoutCompletedMs = Date.now() - began;
          // Do not resume, consume, cancel or drop `consumer` while checking
          // revocation. The source producer must drain independently of it.
          await until(
            () => hold.rows.every((row) => row.closed),
            "active Binary origin closes while client and source body stay held",
            10000,
          );
          const originClosedMs = Date.now() - began;
          const reaped = await until(
            () => {
              const value = JSON.parse(
                f.sql(
                  `SELECT row_to_json(e) FROM media_executions e WHERE id=${quote(execution.id)}`,
                ),
              );
              return value.reaped_at && value;
            },
            "already-started actual Worker delivery is durably reaped",
            10000,
          );
          const durablyReapedMs = Date.now() - began;
          assert.equal(hold.released, false);
          assert.equal(consumer.readableFlowing, false);
          assert.ok(hold.rows.every((row) => row.body_bytes === prefixBytes));
          assert.ok(
            hold.rows.every((row) => row.status === 206),
            "These are already-started responses, not held response headers",
          );
          assert.equal(reaped.id, execution.id);
          assert.equal(
            f.sql(
              `SELECT count(*) FROM media_executions WHERE session_id=${quote(grant.plan.session_id)} AND kind='delivery' AND reaped_at IS NULL`,
            ),
            "0",
          );
          const retainedEvidence = {
            authority: "logout",
            response_status: response.statusCode,
            client_prefix_bytes_read: initial.length,
            origin_prefix_bytes_sent: prefixBytes,
            origin_bytes_withheld: grant.state.bytes.length - prefixBytes,
            client_paused_through_reaping: true,
            client_body_retained_through_reaping: true,
            source_gate_closed_through_reaping: true,
            origin_closed_before_release: true,
            worker_execution_id: execution.id,
            worker_execution_reaped_at: reaped.reaped_at,
            logout_completed_in_ms: logoutCompletedMs,
            origin_closed_in_ms: originClosedMs,
            durably_reaped_in_ms: durablyReapedMs,
            client_events_before_teardown: structuredClone(clientEvents),
          };
          hold.release();
          grant.state.bodyHold = null;
          await client.login();
          const before = originRequests(grant).length;
          await reject(await fetch(url), "INVALID_PLAYBACK_SESSION");
          assert.equal(originRequests(grant).length, before);
          return retainedEvidence;
        } finally {
          consumer?.destroy();
          outgoing?.destroy();
          await cleanup(grant);
        }
      },
    );
    for (const kind of [
      "unknown-audio",
      "ambiguous-audio",
      "HLS",
      "weak",
      "unknown-length",
      "legacy",
    ])
      await check(
        `${kind} root exposes no continuation authority and rejects before new source I/O`,
        async () => {
          const options =
            kind === "ambiguous-audio"
              ? { origin: { audio: "multiple" } }
              : kind === "HLS"
                ? { origin: { type: "playlist" }, input: { mode: "direct" } }
                : kind === "weak"
                  ? { origin: { validator: "weak" }, input: { mode: "direct" } }
                  : kind === "unknown-length"
                    ? {
                        origin: { unknownLength: true },
                        input: { mode: "direct" },
                      }
                    : {
                        input: {
                          mode: "direct",
                          ...(kind === "legacy"
                            ? { http_file_fallback_version: undefined }
                            : {}),
                        },
                      };
          const grant = await root("ineligible " + kind, options);
          try {
            assert.equal(
              Object.hasOwn(grant.plan, "http_file_fallback_version"),
              false,
            );
            if (["HLS", "weak", "unknown-length"].includes(kind)) {
              const delivery = await fetch(
                new URL(grant.plan.playback_url, f.workerOrigin),
                { signal: AbortSignal.timeout(10000) },
              );
              assert.equal(delivery.status, 200);
              await delivery.arrayBuffer();
              const pin = pins(grant.plan.session_id)[0];
              assert.ok(
                pin,
                "Ineligible root has actual delivery representation evidence",
              );
              if (kind === "HLS") assert.equal(pin.identity.class, "playlist");
              if (kind === "weak")
                assert.match(pin.identity.metadata.etag, /^W\//);
              if (kind === "unknown-length")
                assert.equal(pin.identity.metadata.size, null);
            }
            const before = originRequests(grant).length;
            await reject(
              await post(
                grant,
                continuation(grant, { http_file_fallback_version: 1 }),
              ),
            );
            currentRoot(grant);
            assert.equal(originRequests(grant).length, before);
            if (kind === "legacy") {
              const replay = await grant.client.request(
                "/playback-sessions",
                "POST",
                grant.input,
              );
              assert.equal(replay.session_id, grant.plan.session_id);
              assert.equal(
                Object.hasOwn(replay, "http_file_fallback_version"),
                false,
              );
            }
            return {
              negotiated_marker_absent: true,
              rejected_origin_requests: 0,
            };
          } finally {
            await cleanup(grant);
          }
        },
      );
    assert.equal(originFailures.length, 0);
    assert.ok(report.requests.every((row) => row.authorization_matches));
    assert.equal(
      f.sql(
        "SELECT count(*) FROM playback_requests r JOIN playback_sessions p ON p.id=r.session_id WHERE r.http_file_parent IS NOT NULL AND r.status='failed' AND NOT p.stopped",
      ),
      "0",
      "Failed successor grants never remain live",
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
  for (const ws of sockets) ws.terminate();
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
      origin_port: originPort,
      origin_port_closed:
        originPort === undefined || (await verifyClosedPort(originPort)),
      decoder_pids_absent: decoderPids.every((pid) => verifyPidAbsent(pid)),
    };
    assert.equal(report.cleanup.worker_pid_absent, true);
    assert.equal(report.cleanup.worker_port_closed, true);
    assert.equal(report.cleanup.origin_port_closed, true);
    assert.equal(report.cleanup.decoder_pids_absent, true);
    report.finished_at = new Date().toISOString();
    const reportPath = resolve(fixture.root, "report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log("Evidence: " + reportPath);
  }
}
if (failure) throw failure;
