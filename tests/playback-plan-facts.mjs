// Owned public-API regression. Controlled upstreams are protocol peers, not
// Jellyfin/Emby product compatibility evidence. This test never builds binaries.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const bindingPath =
  process.env.RAINSYNC_PLAN_FACTS_BINDING_FILE ??
  process.env.W03_BACKEND_BINDING;
assert.ok(
  bindingPath,
  "Set a frozen backend binding; this regression never builds",
);
const bindingBytes = await readFile(bindingPath),
  binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
assert.ok(
  binding.source.some((v) => v.path === "apps/server/src/playback_plan.rs"),
);
const coordinator = await Promise.all(
  [
    "tests/playback-plan-facts.mjs",
    "tests/fixtures/server.mjs",
    "tests/fixtures/media-stack.mjs",
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
  for (const binary of binding.binaries) {
    assert.equal(
      digest(await readFile(binary.path)),
      binary.sha256,
      binary.name,
    );
    assert.equal(
      resolve(binary.path),
      resolve(process.env.CARGO_TARGET_DIR, "debug", binary.name),
    );
  }
}
await verifyBinding();
const report = {
  schema_version: 1,
  result: "running",
  started_at: new Date().toISOString(),
  checks: [],
  scope:
    "Owned native PostgreSQL/Server/Worker, real generated local/HTTP media, controlled Jellyfin and Emby protocol peers, explicitly labeled owned SQL fault injection. No browser/device/product/production acceptance claim.",
  backend_binding: {
    path: resolve(bindingPath),
    sha256: digest(bindingBytes),
    source_digest: binding.source_digest,
    binaries: binding.binaries,
  },
  coordinator,
};
const sockets = new Set(),
  peers = [];
let fixture, workerPid, workerPort;
async function until(check, label, timeout = 18000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(40);
  }
  throw Error(`Deadline: ${label}`);
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
  await new Promise((done, reject) => {
    ws.once("open", done);
    ws.once("error", reject);
  });
  const next = (predicate) =>
    until(() => {
      const index = frames.findIndex(predicate);
      return index < 0 ? null : frames.splice(index, 1)[0];
    }, "room control response");
  ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  const snapshot = await next((v) => v.type === "SNAPSHOT");
  let state = snapshot.state,
    epoch = snapshot.control_epoch.id;
  return {
    async select(media) {
      const command = {
        protocol_version: 1,
        room_id: room.id,
        command_id: randomUUID(),
        control_epoch: epoch,
        expected_revision: state.revision,
        media_generation: state.media_generation,
        type: "CHANGE_MEDIA",
        payload: { media_id: media.id },
      };
      ws.send(JSON.stringify(command));
      let answer = await next((v) => v.command_id === command.command_id);
      if (
        answer.type === "ERROR" &&
        answer.control_epoch &&
        ["CONTROL_EPOCH_EXPIRED", "CONTROL_EPOCH_REQUIRED"].includes(
          answer.error?.code,
        )
      ) {
        epoch = answer.control_epoch.id;
        ws.send(JSON.stringify({ ...command, control_epoch: epoch }));
        answer = await next((v) => v.command_id === command.command_id);
      }
      assert.equal(answer.type, "ACK", JSON.stringify(answer));
      state = answer.state;
      assert.equal(state.media_id, media.id);
      return state.media_generation;
    },
  };
}
async function peer(clip) {
  const user = randomUUID(),
    token = randomBytes(24).toString("hex");
  const faults = {
    defaultAudio: 2,
    multi: false,
    multipleAudio: false,
    policyDisabled: false,
  };
  const negotiations = [];
  const audio = [
    { Type: "Audio", Index: 1, Codec: "aac" },
    { Type: "Audio", Index: 2, Codec: "aac" },
  ];
  const source = (host) => ({
    Id: "current-source",
    SupportsDirectPlay: true,
    SupportsTranscoding: true,
    DefaultAudioStreamIndex: faults.defaultAudio,
    RunTimeTicks: 100000000,
    TranscodingUrl: `http://${host}/Videos/fixture/master.m3u8`,
    MediaStreams: [
      ...(faults.multipleAudio ? audio : [audio[1]]),
      { Type: "Subtitle", Index: 3, IsTextSubtitleStream: true, Codec: "srt" },
    ],
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1"),
      path = url.pathname;
    if (path === "/clip.mp4") {
      let start = 0,
        end = clip.length - 1,
        status = 200;
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
      if (match) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), end) : end;
        status = 206;
      }
      if (start > end)
        return response
          .writeHead(416, { "Content-Range": `bytes */${clip.length}` })
          .end();
      const headers = {
        "Content-Type": "video/mp4",
        "Content-Length": end - start + 1,
        ETag: '"owned-stable-clip"',
        "Accept-Ranges": "bytes",
      };
      if (status === 206)
        headers["Content-Range"] = `bytes ${start}-${end}/${clip.length}`;
      return response
        .writeHead(status, headers)
        .end(
          request.method === "HEAD" ? undefined : clip.subarray(start, end + 1),
        );
    }
    const auth =
      request.headers.authorization ??
      request.headers["x-emby-authorization"] ??
      "";
    if (
      (request.headers["x-emby-token"] ?? /Token="([^"]+)"/.exec(auth)?.[1]) !==
      token
    )
      return response.writeHead(401).end();
    const json = (body) =>
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(body));
    if (path === `/Users/${user}`)
      return json({
        Id: user,
        Policy: {
          IsDisabled: faults.policyDisabled,
          EnableMediaPlayback: true,
        },
      });
    if (path === `/Users/${user}/Items`)
      return json({
        TotalRecordCount: 1,
        Items: [
          {
            Id: "fixture",
            Name: "controlled-plan-facts",
            RunTimeTicks: 100000000,
          },
        ],
      });
    if (path === `/Users/${user}/Items/fixture`)
      return json({
        Id: "fixture",
        MediaSources: faults.multi
          ? [
              source(request.headers.host),
              { ...source(request.headers.host), Id: "alternate-source" },
            ]
          : [source(request.headers.host)],
      });
    if (path === "/Items/fixture/PlaybackInfo") {
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      const body = JSON.parse(bytes);
      negotiations.push(body);
      return json({
        PlaySessionId: randomUUID(),
        MediaSources: faults.multi
          ? [
              source(request.headers.host),
              { ...source(request.headers.host), Id: "alternate-source" },
            ]
          : [source(request.headers.host)],
      });
    }
    if (
      path.startsWith("/Sessions/Playing") ||
      path === "/Videos/ActiveEncodings"
    )
      return response.writeHead(204).end();
    response.writeHead(404).end();
  });
  await new Promise((done, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", done),
  );
  const port = server.address().port,
    origin = `http://127.0.0.1:${port}`;
  const value = {
    faults,
    negotiations,
    port,
    origin,
    config: {
      url: origin,
      token,
      user_id: user,
      access_policy: {
        schema_version: 1,
        origins: [{ origin, cidrs: ["127.0.0.1/32"] }],
      },
    },
    async close() {
      const done = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await done;
      assert.ok(await verifyClosedPort(port));
    },
  };
  peers.push(value);
  return value;
}
function ciphertext(f, encoded, edit) {
  const key = Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"),
    bytes = Buffer.from(encoded, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  const value = JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]),
  );
  edit(value);
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([
    nonce,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
try {
  await isolatedMediaStack("playback-plan-facts", async (f) => {
    fixture = f;
    report.fixture = { id: f.id, root: f.root };
    const client = f.client();
    await client.login();
    const file = resolve(f.root, "owned-facts.mp4");
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
        "color=red:s=640x360:r=25:d=10",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=10",
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
        "-movflags",
        "+faststart",
        file,
      ],
      { env: f.env, timeout: 15000 },
    );
    await writeFile(
      resolve(f.root, "owned-facts.vtt"),
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOwned fixture\n",
    );
    const source = await client.request("/sources", "POST", {
      name: "owned plan facts",
      kind: "local",
      config: { root: f.root },
    });
    await client.request(`/sources/${source.id}/test`, "POST");
    const media = (await client.request("/media")).find(
      (v) =>
        v.id ===
        f.sql(
          `SELECT id FROM media_items WHERE source_id=${quote(source.id)} AND resource='owned-facts.mp4'`,
        ),
    );
    assert.ok(media);
    const room = await client.request("/rooms", "POST", {
      name: "owned facts room",
    });
    let control = await controller(f, client, room);
    let generation = await control.select(media);
    const caps = {
      progressive_h264_aac: true,
      native_hls: false,
      mse_h264_aac: true,
    };
    const prepare = async (extra = {}, expected = 200) => {
      const input = {
        room_id: room.id,
        media_generation: generation,
        position_ms: 0,
        mode: "auto",
        capabilities: caps,
        idempotency_key: randomUUID(),
        ...extra,
      };
      return {
        input,
        plan: await client.request(
          "/playback-sessions",
          "POST",
          input,
          expected,
        ),
      };
    };
    const replay = (grant) =>
      client.request("/playback-sessions", "POST", grant.input);
    const ready = (grant) =>
      client.request(`/playback-sessions/${grant.plan.session_id}`);
    const stop = (grant) =>
      client.request(`/playback-sessions/${grant.plan.session_id}`, "DELETE");
    const absent = (value, key) =>
      assert.equal(Object.hasOwn(value, key), false, key);
    const check = (name) => {
      report.checks.push(name);
      console.log(`PASS: ${name}`);
    };

    const direct = await prepare();
    assert.equal(direct.plan.delivery_mode, "direct");
    assert.equal(direct.plan.selected_audio_track, 1);
    assert.equal(direct.plan.subtitle_mode, "external_vtt");
    assert.match(
      direct.plan.decision_reason,
      /^local_automatic_direct_authorized_probe$/,
    );
    assert.deepEqual(direct.plan.decoder_fallback_modes, [
      "remux",
      "transcode",
    ]);
    absent(direct.plan, "pending_job_id");
    absent(direct.plan, "seekable_media_ranges_ms");
    const foreign = randomUUID();
    f.sql(
      `INSERT INTO media_jobs(id,session_id,status,spec) VALUES(${quote(foreign)},${quote(direct.plan.session_id)},'queued','{}')`,
    );
    const isolated = await ready(direct);
    absent(isolated, "pending_job_id");
    absent(isolated, "seekable_media_ranges_ms");
    f.sql(`DELETE FROM media_jobs WHERE id=${quote(foreign)}`);
    check(
      "local current metadata explains actual route/audio/subtitle pipeline; an unrelated job ID cannot become a plan fact",
    );
    await stop(direct);

    const candidateSet = await client.request("/playback-candidates", "POST", {
      room_id: room.id,
      media_generation: generation,
      position_ms: 0,
    });
    const exact = await prepare({
      candidate_report: {
        binding: candidateSet.binding,
        excluded_candidates: [],
        results: candidateSet.candidates.map((c) => ({
          candidate_id: c.id,
          progressive: "probably",
          mse_supported: true,
          file_decoding: {
            supported: true,
            smooth: true,
            power_efficient: false,
          },
          mse_decoding: {
            supported: true,
            smooth: true,
            power_efficient: false,
          },
        })),
      },
    });
    assert.equal(exact.plan.selected_candidate_id, "direct");
    assert.equal(exact.plan.decision_reason, "actual_media_direct");
    assert.deepEqual(exact.plan.decoder_fallback_modes, []);
    await stop(exact);
    check(
      "exact candidate recovery retains selected_candidate_id; empty legacy hints do not replace its binding",
    );

    const queued = await prepare({
      mode: "remux",
      position_ms: 2000,
      viewer_id: randomUUID(),
      plan_generation: 1,
    });
    assert.equal(queued.plan.delivery_mode, "transcode");
    assert.equal(queued.plan.timeline_origin_ms, 2000);
    assert.deepEqual(queued.plan.decoder_fallback_modes, []);
    assert.equal(queued.plan.pending_job_id, queued.plan.session_id);
    assert.deepEqual(queued.plan.seekable_media_ranges_ms, []);
    assert.equal((await ready(queued)).status, "queued");
    const otherName = `facts-other-${randomUUID().slice(0, 8)}`;
    await client.request("/users", "POST", {
      username: otherName,
      password: f.password,
    });
    const other = f.client();
    await other.login(otherName);
    const inaccessible = await other.request(
      `/playback-sessions/${queued.plan.session_id}`,
      "GET",
      undefined,
      410,
    );
    assert.equal(inaccessible.error.code, "INVALID_PLAYBACK_SESSION");
    const tools = resolve(f.root, "tools");
    await mkdir(tools);
    const ffmpeg = execFileSync("which", ["ffmpeg"], {
      encoding: "utf8",
    }).trim();
    await writeFile(
      resolve(tools, "ffmpeg"),
      `#!/bin/sh\ncase " $* " in *" -hls_segment_type "*) exec '${ffmpeg.replaceAll("'", "'\\''")}' -re "$@" ;; *) exec '${ffmpeg.replaceAll("'", "'\\''")}' "$@" ;; esac\n`,
      { mode: 0o700 },
    );
    await f.startWorker({ PATH: tools + delimiter + process.env.PATH });
    workerPid = f.workerPid;
    workerPort = Number(new URL(f.workerOrigin).port);
    await f.startServer({ WORKER_URL: f.workerOrigin });
    control = await controller(f, client, room);
    const prefix = await until(async () => {
      const value = await ready(queued);
      return !value.complete && value.seekable_media_ranges_ms?.length
        ? value
        : null;
    }, "actual incremental committed FFmpeg prefix");
    assert.equal(prefix.pending_job_id, queued.plan.session_id);
    assert.equal(prefix.seekable_media_ranges_ms[0].start_ms, 2000);
    assert.equal(
      prefix.seekable_media_ranges_ms[0].end_ms,
      2000 + prefix.available_until_ms,
    );
    assert.equal(
      f.sql(
        `SELECT status FROM media_outputs WHERE job_id=${quote(queued.plan.session_id)} AND attempt=(SELECT attempt FROM media_jobs WHERE id=${quote(queued.plan.session_id)})`,
      ),
      "writing",
    );
    const prefixReplay = await replay(queued);
    assert.equal(prefixReplay.session_id, queued.plan.session_id);
    assert.ok(
      prefixReplay.seekable_media_ranges_ms[0].end_ms >=
        prefix.seekable_media_ranges_ms[0].end_ms,
    );
    const complete = await until(async () => {
      const value = await ready(queued);
      return value.complete ? value : null;
    }, "actual FFmpeg completion");
    absent(complete, "pending_job_id");
    assert.ok(
      complete.seekable_media_ranges_ms[0].end_ms >=
        prefix.seekable_media_ranges_ms[0].end_ms,
    );
    absent(await replay(queued), "pending_job_id");
    check(
      "actual queued→writing prefix→complete ranges/replay use original-media coordinates and clear completed pending IDs; foreign users get no facts",
    );

    await f.stopWorker();
    const originalAttempt = Number(
      f.sql(
        `SELECT attempt FROM media_jobs WHERE id=${quote(queued.plan.session_id)}`,
      ),
    );
    const jobOwner = f.sql(
      `SELECT owner_id FROM media_jobs WHERE id=${quote(queued.plan.session_id)}`,
    );
    f.sql(
      `UPDATE media_outputs SET status='writing' WHERE job_id=${quote(queued.plan.session_id)} AND attempt=${originalAttempt}; UPDATE media_jobs SET status='running',lease_until=clock_timestamp()-interval '1 second' WHERE id=${quote(queued.plan.session_id)}`,
    );
    const expired = await ready(queued);
    absent(expired, "seekable_media_ranges_ms");
    assert.equal(expired.available_until_ms, null);
    assert.equal(expired.status, "preparing");
    absent(await replay(queued), "seekable_media_ranges_ms");
    f.sql(
      `UPDATE media_jobs SET lease_until=clock_timestamp()+interval '30 seconds',owner_id=${quote(randomUUID())} WHERE id=${quote(queued.plan.session_id)}`,
    );
    const unowned = await ready(queued);
    absent(unowned, "seekable_media_ranges_ms");
    assert.equal(unowned.available_until_ms, null);
    assert.equal(unowned.status, "preparing");
    f.sql(
      `UPDATE media_jobs SET owner_id=${quote(jobOwner)},attempt=attempt+1 WHERE id=${quote(queued.plan.session_id)}`,
    );
    const reclaimed = await ready(queued);
    absent(reclaimed, "seekable_media_ranges_ms");
    assert.equal(reclaimed.available_until_ms, null);
    assert.equal(reclaimed.status, "preparing");
    absent(await replay(queued), "seekable_media_ranges_ms");
    f.sql(
      `UPDATE media_outputs SET status='published' WHERE job_id=${quote(queued.plan.session_id)} AND attempt=${originalAttempt}`,
    );
    f.sql(
      `UPDATE media_jobs SET status='succeeded',attempt=${originalAttempt} WHERE id=${quote(queued.plan.session_id)}`,
    );
    f.sql(
      `UPDATE media_outputs SET visible_manifest='#EXTINF:NaN,\nindex0.m4s\n' WHERE job_id=${quote(queued.plan.session_id)} AND attempt=${originalAttempt}`,
    );
    absent(await ready(queued), "seekable_media_ranges_ms");
    absent(await replay(queued), "seekable_media_ranges_ms");
    check(
      "owned lease/attempt/malformed-manifest fault injection: expired/unowned attempts cannot supply ranges and invalid evidence is unknown, not empty",
    );

    // Simulate an authentic pre-facts stored resource/response with this owned
    // fixture's random encryption key; this is explicit compatibility injection.
    const legacyResource = JSON.parse(
      f.sql(
        `SELECT resource FROM playback_sessions WHERE id=${quote(queued.plan.session_id)}`,
      ),
    );
    legacyResource.encrypted = ciphertext(
      f,
      legacyResource.encrypted,
      (value) => delete value.plan_facts_version,
    );
    const oldResponse = f.sql(
      `SELECT response_encrypted FROM playback_requests WHERE session_id=${quote(queued.plan.session_id)}`,
    );
    const encryptedResponse = ciphertext(f, oldResponse, (value) => {
      for (const key of [
        "subtitle_mode",
        "decoder_fallback_modes",
        "pending_job_id",
        "seekable_media_ranges_ms",
      ])
        delete value[key];
    });
    f.sql(
      `UPDATE playback_sessions SET resource=${quote(JSON.stringify(legacyResource))}::jsonb WHERE id=${quote(queued.plan.session_id)}; UPDATE playback_requests SET response_encrypted=${quote(encryptedResponse)} WHERE session_id=${quote(queued.plan.session_id)}`,
    );
    const legacyReady = await ready(queued),
      legacyReplay = await replay(queued);
    for (const key of ["pending_job_id", "seekable_media_ranges_ms"]) {
      absent(legacyReady, key);
      absent(legacyReplay, key);
    }
    for (const key of ["subtitle_mode", "decoder_fallback_modes"])
      absent(legacyReplay, key);
    const successor = await prepare({
      viewer_id: queued.input.viewer_id,
      plan_generation: 2,
      mode: "direct",
    });
    const stale = await client.request(
      "/playback-sessions",
      "POST",
      queued.input,
      409,
    );
    assert.equal(stale.error.code, "STALE_PLAYBACK_PLAN");
    assert.equal(
      (
        await other.request(
          `/playback-sessions/${successor.plan.session_id}`,
          "GET",
          undefined,
          410,
        )
      ).error.code,
      "INVALID_PLAYBACK_SESSION",
    );
    await stop(successor);
    await stop(queued);
    for (const fence of ["epoch", "membership", "source"]) {
      const fenceRoom = await client.request("/rooms", "POST", {
        name: `owned ${fence} fence`,
      });
      const fenceControl = await controller(f, client, fenceRoom);
      const fenceGeneration = await fenceControl.select(media);
      const grant = await prepare({
        room_id: fenceRoom.id,
        media_generation: fenceGeneration,
        mode: "remux",
      });
      assert.equal(grant.plan.pending_job_id, grant.plan.session_id);
      if (fence === "epoch")
        f.sql(
          `UPDATE rooms SET lifecycle_epoch=lifecycle_epoch+1 WHERE id=${quote(fenceRoom.id)}`,
        );
      if (fence === "membership")
        f.sql(`DELETE FROM room_members WHERE room_id=${quote(fenceRoom.id)}`);
      if (fence === "source") {
        const priorConfig = f.sql(
          `SELECT config_encrypted FROM sources WHERE id=${quote(source.id)}`,
        );
        const changedConfig = ciphertext(f, priorConfig, (value) => {
          value.headers = { "X-RainSync-Fixture": "facts-revision" };
        });
        f.sql(
          `UPDATE sources SET config_encrypted=${quote(changedConfig)},access_policy_revision=access_policy_revision+1 WHERE id=${quote(source.id)}`,
        );
      }
      assert.equal(
        (
          await client.request(
            `/playback-sessions/${grant.plan.session_id}`,
            "GET",
            undefined,
            410,
          )
        ).error.code,
        "INVALID_PLAYBACK_SESSION",
      );
      const replayResponse = await client.raw("/playback-sessions", {
        method: "POST",
        body: grant.input,
      });
      assert.equal(replayResponse.status, fence === "membership" ? 403 : 410);
      await stop(grant);
    }
    check(
      "current viewer high-water and owned lifecycle/member/source faults fence readiness/replay before any job facts are exposed",
    );
    check(
      "owned pre-facts compatibility injection preserves absent optional facts through readiness and replay",
    );

    const controlled = await peer(await readFile(file));
    const httpSource = await client.request("/sources", "POST", {
      name: "owned HTTP facts",
      kind: "http",
      config: {
        url: controlled.origin + "/clip.mp4",
        access_policy: controlled.config.access_policy,
      },
    });
    await client.request(`/sources/${httpSource.id}/test`, "POST");
    const httpMedia = (await client.request("/media")).find(
      (v) =>
        v.id ===
        f.sql(
          `SELECT id FROM media_items WHERE source_id=${quote(httpSource.id)}`,
        ),
    );
    assert.ok(httpMedia);
    generation = await control.select(httpMedia);
    await f.startWorker();
    workerPid = f.workerPid;
    const http = await prepare();
    assert.match(
      http.plan.decision_reason,
      /^http_automatic_direct_authorized_probe$/,
    );
    assert.equal(http.plan.selected_audio_track, 1);
    assert.deepEqual(http.plan.decoder_fallback_modes, []);
    absent(http.plan, "http_file_fallback_version");
    absent(http.plan, "seekable_media_ranges_ms");
    absent(http.plan, "pending_job_id");
    assert.equal(http.plan.subtitle_mode, "none");
    await stop(http);
    // Current probe facts alone do not grant HTTP continuation authority.
    const httpFallback = await prepare({
      http_file_fallback_version: 1,
      viewer_id: randomUUID(),
      plan_generation: 1,
    });
    assert.match(
      httpFallback.plan.decision_reason,
      /^http_automatic_direct_authorized_probe$/,
    );
    assert.equal(httpFallback.plan.selected_audio_track, 1);
    assert.equal(httpFallback.plan.http_file_fallback_version, 1);
    assert.deepEqual(httpFallback.plan.decoder_fallback_modes, [
      "remux",
      "transcode",
    ]);
    absent(httpFallback.plan, "seekable_media_ranges_ms");
    absent(httpFallback.plan, "pending_job_id");
    assert.equal(httpFallback.plan.subtitle_mode, "none");
    await stop(httpFallback);
    const unprobed = await prepare({ mode: "direct" });
    absent(unprobed.plan, "selected_audio_track");
    assert.deepEqual(unprobed.plan.decoder_fallback_modes, []);
    absent(unprobed.plan, "seekable_media_ranges_ms");
    await stop(unprobed);
    check(
      "HTTP authorized probe verifies audio; only an opted-in reliable Binary root supplies bounded fallback hints, and duration or unprobed direct never invents ranges or decoder evidence",
    );

    for (const kind of ["jellyfin", "emby"]) {
      const upstream = await peer(await readFile(file));
      const provider = await client.request("/sources", "POST", {
        name: `controlled ${kind} facts`,
        kind,
        config: upstream.config,
      });
      await client.request(`/sources/${provider.id}/test`, "POST");
      const item = (await client.request("/media")).find(
        (v) =>
          v.id ===
          f.sql(
            `SELECT id FROM media_items WHERE source_id=${quote(provider.id)}`,
          ),
      );
      assert.ok(item);
      generation = await control.select(item);
      const before = upstream.negotiations.length,
        grant = await prepare();
      assert.equal(grant.plan.selected_audio_track, 2);
      assert.equal(grant.plan.decision_reason, `${kind}_negotiated_direct`);
      assert.equal(grant.plan.subtitle_mode, "external_vtt");
      assert.deepEqual(grant.plan.decoder_fallback_modes, ["transcode"]);
      absent(grant.plan, "pending_job_id");
      absent(grant.plan, "seekable_media_ranges_ms");
      await replay(grant);
      assert.equal(
        upstream.negotiations.length,
        before + 1,
        "facts/replay never allocate extra SID",
      );
      await stop(grant);
      upstream.faults.multipleAudio = true;
      const nativeMultiple = await prepare();
      absent(nativeMultiple.plan, "selected_audio_track");
      assert.deepEqual(nativeMultiple.plan.decoder_fallback_modes, []);
      await stop(nativeMultiple);
      const defaultHls = await prepare({ mode: "transcode" });
      assert.equal(defaultHls.plan.selected_audio_track, 2);
      await stop(defaultHls);
      const selected = await prepare({ audio_index: 2, mode: "transcode" });
      assert.equal(selected.plan.selected_audio_track, 2);
      assert.equal(selected.plan.delivery_mode, "transcode");
      assert.deepEqual(selected.plan.decoder_fallback_modes, []);
      absent(selected.plan, "pending_job_id");
      await stop(selected);
      upstream.faults.defaultAudio = null;
      const unknown = await prepare();
      absent(unknown.plan, "selected_audio_track");
      assert.deepEqual(unknown.plan.decoder_fallback_modes, []);
      await stop(unknown);
      upstream.faults.defaultAudio = 999;
      const invalid = await prepare();
      absent(invalid.plan, "selected_audio_track");
      assert.deepEqual(invalid.plan.decoder_fallback_modes, []);
      await stop(invalid);
      upstream.faults.defaultAudio = 2;
      upstream.faults.multi = true;
      const multi = await prepare();
      absent(multi.plan, "selected_audio_track");
      assert.deepEqual(multi.plan.decoder_fallback_modes, []);
      await stop(multi);
      const noPost = upstream.negotiations.length;
      const rejected = await prepare({ audio_index: 2 }, 502);
      assert.equal(rejected.plan.error.code, "UPSTREAM_PLAYBACK_FAILED");
      assert.equal(
        upstream.negotiations.length,
        noPost,
        "ambiguous explicit track is rejected before negotiation",
      );
      upstream.faults.multi = false;
      upstream.faults.multipleAudio = false;
      const policyGrant = await prepare();
      upstream.faults.policyDisabled = true;
      f.sql(
        `UPDATE source_account_policies SET valid_until=clock_timestamp()-interval '1 second' WHERE source_id=${quote(provider.id)}`,
      );
      assert.equal(
        (
          await client.request(
            `/playback-sessions/${policyGrant.plan.session_id}`,
            "GET",
            undefined,
            410,
          )
        ).error.code,
        "INVALID_PLAYBACK_SESSION",
      );
      assert.equal(
        (
          await client.request(
            "/playback-sessions",
            "POST",
            policyGrant.input,
            410,
          )
        ).error.code,
        "PLAYBACK_REQUEST_EXPIRED",
      );
      await stop(policyGrant);
      check(
        `controlled ${kind}: current default/explicit audio is verified, unknown/default mismatch/multi-version stays safe, fallback uses existing negotiation only`,
      );
    }
    await f.stopWorker();
    assert.ok(verifyPidAbsent(workerPid));
    assert.ok(await verifyClosedPort(workerPort));
    report.worker_cleanup = { pid_absent: true, port_closed: true };
    await verifyBinding();
    report.result = "passed";
  });
} catch (error) {
  report.result = "failed";
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.terminate();
  for (const peer of peers) await peer.close();
  if (fixture) {
    report.cleanup = await fixture.verifyStopped();
    report.postgres = fixture.postgresDiagnostics();
    report.finished_at = new Date().toISOString();
    await writeFile(
      resolve(fixture.root, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(`${report.result}: ${resolve(fixture.root, "report.json")}`);
  }
}
