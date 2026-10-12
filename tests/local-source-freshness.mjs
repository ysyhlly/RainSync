// Local-only, source-bound regression with real FFmpeg/ffprobe and an owned
// PostgreSQL/Server/Worker stack. No Agent, external upstream or release proof.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createDecipheriv,
  createCipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

assert.equal(
  process.platform,
  "linux",
  "This deterministic probe barrier is a Linux fixture",
);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (v) => createHash("sha256").update(v).digest("hex");
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;
const bindingPath = process.env.RAINSYNC_LOCAL_FRESHNESS_BINDING_FILE;
assert.ok(
  bindingPath,
  "Set RAINSYNC_LOCAL_FRESHNESS_BINDING_FILE; this test never builds binaries",
);
const bindingBytes = await readFile(bindingPath),
  binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.equal(sha(JSON.stringify(binding.source)), binding.source_digest);
for (const path of [
  "apps/server/src/media.rs",
  "apps/server/src/playback_capabilities.rs",
  "apps/media-worker/src/source_version.rs",
])
  assert.ok(
    binding.source.some((v) => v.path === path),
    path,
  );
const coordinator = await Promise.all(
  [
    "tests/local-source-freshness.mjs",
    "tests/fixtures/server.mjs",
    "tests/fixtures/owned-probe-input.mjs",
    "tests/fixtures/media-stack.mjs",
    "tests/fixtures/postgres.mjs",
    "deploy/owned-process.mjs",
  ].map(async (path) => ({
    path,
    sha256: sha(await readFile(resolve(repo, path))),
  })),
);
async function verifyBinding() {
  assert.equal(sha(await readFile(bindingPath)), sha(bindingBytes));
  for (const file of [...binding.source, ...coordinator])
    assert.equal(
      sha(await readFile(resolve(repo, file.path))),
      file.sha256,
      file.path,
    );
  for (const binary of binding.binaries) {
    assert.equal(
      resolve(binary.path),
      resolve(process.env.CARGO_TARGET_DIR, "debug", binary.name),
    );
    assert.equal(sha(await readFile(binary.path)), binary.sha256, binary.name);
  }
}
await verifyBinding();
const report = {
  schema_version: 1,
  result: "running",
  started_at: new Date().toISOString(),
  checks: [],
  scope:
    "Owned native PostgreSQL/Server/Worker, generated local media, real ffprobe with an explicit after-output barrier, and labeled owned legacy-record fault injection. No Agent, browser, device, load, cryptographic immutability or release acceptance claim.",
  backend_binding: {
    path: resolve(bindingPath),
    sha256: sha(bindingBytes),
    source_digest: binding.source_digest,
    binaries: binding.binaries,
  },
  coordinator,
};
let fixture, socket, worker;
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(30);
  }
  throw Error(`Deadline: ${label}`);
}
const check = (name) => {
  report.checks.push(name);
  console.log(`PASS: ${name}`);
};
function encrypted(f, encoded, transform) {
  const key = Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"),
    bytes = Buffer.from(encoded, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  const value = JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]),
  );
  if (!transform) return value;
  transform(value);
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([
    nonce,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
async function selectMedia(f, client, room, media) {
  socket = new WebSocket(f.origin.replace("http:", "ws:") + "/api/v1/ws", {
    headers: { Origin: f.origin, Cookie: client.cookie },
  });
  const frames = [];
  socket.on("message", (b) => frames.push(JSON.parse(b)));
  socket.on("error", () => {});
  await new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
  });
  const next = (predicate) =>
    until(() => {
      const i = frames.findIndex(predicate);
      return i < 0 ? null : frames.splice(i, 1)[0];
    }, "room response");
  socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  const snapshot = await next((v) => v.type === "SNAPSHOT");
  const command = {
    protocol_version: 1,
    room_id: room.id,
    command_id: randomUUID(),
    control_epoch: snapshot.control_epoch.id,
    expected_revision: snapshot.state.revision,
    media_generation: snapshot.state.media_generation,
    type: "CHANGE_MEDIA",
    payload: { media_id: media.id },
  };
  socket.send(JSON.stringify(command));
  const ack = await next((v) => v.command_id === command.command_id);
  assert.equal(ack.type, "ACK");
  assert.equal(ack.state.media_id, media.id);
  return ack.state.media_generation;
}
try {
  await isolatedMediaStack("local-source-freshness", async (f) => {
    fixture = f;
    report.fixture = { id: f.id, root: f.root };
    const client = f.client();
    await client.login();
    const mediaRoot = resolve(f.root, "media");
    await mkdir(mediaRoot);
    const original = resolve(f.root, "original.mp4"),
      replacement = resolve(f.root, "replacement.mp4"),
      target = resolve(mediaRoot, "movie.mp4");
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
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        original,
      ],
      { env: f.env, timeout: 15000 },
    );
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
        "color=blue:s=320x180:r=25:d=6",
        "-c:v",
        "mpeg4",
        "-threads",
        "1",
        "-an",
        "-movflags",
        "+faststart",
        replacement,
      ],
      { env: f.env, timeout: 15000 },
    );
    report.media = {
      original_sha256: sha(await readFile(original)),
      replacement_sha256: sha(await readFile(replacement)),
      ffmpeg: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split(
        "\n",
      )[0],
      ffprobe: execFileSync("ffprobe", ["-version"], {
        encoding: "utf8",
      }).split("\n")[0],
    };
    const replace = async (file) => {
      const next = resolve(mediaRoot, "next.tmp");
      await copyFile(file, next);
      await rename(next, target);
    };
    await replace(original);
    const source = await client.request("/sources", "POST", {
      name: "owned local freshness",
      kind: "local",
      config: { root: mediaRoot },
    });
    const scan = () => client.request(`/sources/${source.id}/test`, "POST");
    await scan();
    const media = (await client.request("/media")).find((v) =>
      v.title.includes("movie"),
    );
    assert.ok(media);
    const metadata = () =>
      JSON.parse(
        f.sql(`SELECT metadata FROM media_items WHERE id=${quote(media.id)}`),
      );
    const firstVersion = metadata().preview_file_version;
    assert.match(firstVersion, /^stat-v1:[a-f0-9]{64}$/);
    const room = await client.request("/rooms", "POST", {
      name: "owned local freshness",
    });
    const generation = await selectMedia(f, client, room, media);
    const input = (extra) => ({
      room_id: room.id,
      media_generation: generation,
      position_ms: 0,
      audio_index: null,
      mode: "auto",
      idempotency_key: randomUUID(),
      capabilities: {
        progressive_h264_aac: true,
        native_hls: false,
        mse_h264_aac: true,
      },
      ...extra,
    });
    const prepare = (body, status = 200) =>
      client.request("/playback-sessions", "POST", body, status);
    const stored = (id) =>
      JSON.parse(
        f.sql(`SELECT resource FROM playback_sessions WHERE id=${quote(id)}`),
      );
    const resource = (id) => encrypted(f, stored(id).encrypted);
    const directInput = input({}),
      direct = await prepare(directInput);
    assert.equal(direct.delivery_mode, "direct");
    assert.equal(direct.selected_audio_track, 1);
    assert.equal(resource(direct.session_id).source_version, firstVersion);
    assert.equal(
      direct.decision_reason,
      "local_automatic_direct_authorized_probe",
    );
    check("new no-candidate direct grant is bound to its current real probe");

    await replace(replacement);
    const badAudio = await prepare(input({ audio_index: 1 }), 400);
    assert.equal(badAudio.error.code, "INVALID_AUDIO_TRACK");
    const replaced = await prepare(input({ position_ms: 4000 }));
    assert.equal(replaced.delivery_mode, "transcode");
    assert.equal(replaced.duration_ms, 6000);
    assert.equal(replaced.timeline_origin_ms, 4000);
    assert.deepEqual(replaced.audio_tracks, []);
    assert.ok(replaced.selected_audio_track == null);
    assert.deepEqual(replaced.decoder_fallback_modes, []);
    const version = resource(replaced.session_id).source_version;
    assert.notEqual(version, firstVersion);
    assert.equal(metadata().preview_file_version, version);
    const spec = JSON.parse(
      f.sql(
        `SELECT spec FROM media_jobs WHERE id=${quote(replaced.session_id)}`,
      ),
    );
    assert.equal(spec.source_version, version);
    assert.equal(spec.source_kind, "local");
    assert.equal(spec.transcode, true);
    assert.equal(spec.start_seconds, 4);
    assert.equal(spec.input_ticket, null);
    check(
      "replacement before prepare changes mode, duration and audio from the same probe and binds the queued job",
    );

    // No background Worker can race this change: start it only after replacement.
    await replace(original);
    await f.startWorker();
    worker = { pid: f.workerPid, port: Number(new URL(f.workerOrigin).port) };
    await until(
      () =>
        f.sql(
          `SELECT status FROM media_jobs WHERE id=${quote(replaced.session_id)}`,
        ) === "failed",
      "bound job failure",
    );
    assert.equal(
      f.sql(
        `SELECT error FROM media_jobs WHERE id=${quote(replaced.session_id)}`,
      ),
      "source_changed",
    );
    assert.equal(
      f.sql(
        `SELECT count(*) FROM media_outputs WHERE job_id=${quote(replaced.session_id)} AND status='published'`,
      ),
      "0",
    );
    const changedDelivery = await fetch(f.workerOrigin + direct.playback_url);
    assert.equal(changedDelivery.status, 409);
    assert.equal((await changedDelivery.json()).error.code, "SOURCE_CHANGED");
    const replay = await prepare(directInput);
    assert.equal(replay.session_id, direct.session_id);
    assert.equal(resource(direct.session_id).source_version, firstVersion);
    check(
      "existing bound direct delivery and queued local job reject replacement; idempotent replay keeps the recorded version",
    );

    await client.request(`/playback-sessions/${direct.session_id}`, "DELETE");
    await client.request(`/playback-sessions/${replaced.session_id}`, "DELETE");

    // Explicit owned legacy-record fault injection, not a migration or release
    // claim. Reads/replay must not invent a historical identity for old grants.
    const legacyInput = input({}),
      legacy = await prepare(legacyInput),
      legacyStored = stored(legacy.session_id);
    legacyStored.encrypted = encrypted(f, legacyStored.encrypted, (value) => {
      delete value.source_version;
    });
    f.sql(
      `UPDATE playback_sessions SET resource=${quote(JSON.stringify(legacyStored))}::jsonb WHERE id=${quote(legacy.session_id)}`,
    );
    await replace(replacement);
    assert.equal((await prepare(legacyInput)).session_id, legacy.session_id);
    assert.equal(
      Object.hasOwn(resource(legacy.session_id), "source_version"),
      false,
    );
    const legacyDelivery = await fetch(f.workerOrigin + legacy.playback_url);
    assert.equal(legacyDelivery.status, 200);
    await legacyDelivery.arrayBuffer();
    check(
      "owned stored legacy grant without source_version remains unbound on replay and delivery",
    );
    await client.request(`/playback-sessions/${legacy.session_id}`, "DELETE");
    const stopped = await f.stopWorker();
    assert.equal(stopped.observed_close, true);
    assert.equal(verifyPidAbsent(worker.pid), true);
    assert.equal(await verifyClosedPort(worker.port), true);
    report.worker_cleanup = { ...stopped, port_closed: true, pid_absent: true };
    worker = null;

    // The shim runs the real ffprobe to completion, then waits for the test's
    // release file. Match the original Server-owned descriptor used on Linux,
    // not merely its pathname. No metadata or production behavior is fabricated.
    const bin = resolve(f.root, "probe-bin"),
      gate = resolve(f.root, "probe-gate");
    await mkdir(bin);
    await mkdir(gate);
    const realProbe = execFileSync("which", ["ffprobe"], {
      encoding: "utf8",
    }).trim();
    await writeFile(
      resolve(bin, "ffprobe"),
      `#!/usr/bin/env node\nimport {spawnSync} from 'node:child_process';\nimport {existsSync,writeFileSync,unlinkSync} from 'node:fs';\nimport {join} from 'node:path';\nimport {isOwnedProbeInput} from ${JSON.stringify(new URL("./fixtures/owned-probe-input.mjs", import.meta.url).href)};\nconst gate=${JSON.stringify(gate)}, target=${JSON.stringify(target)}, args=process.argv.slice(2);\nconst result=spawnSync(${JSON.stringify(realProbe)},args,{encoding:'buffer'});\nif(isOwnedProbeInput(args.at(-1),target) && existsSync(join(gate,'arm'))){\n unlinkSync(join(gate,'arm')); writeFileSync(join(gate,'reached'),'real probe complete');\n while(!existsSync(join(gate,'release'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);\n}\nif(result.stdout)process.stdout.write(result.stdout); if(result.stderr)process.stderr.write(result.stderr); process.exit(result.status??1);\n`,
      { mode: 0o755 },
    );
    // An executable extensionless script is CommonJS to Node; use .mjs through
    // a shell launcher to keep the fixture independent of temp-directory scope.
    await rename(resolve(bin, "ffprobe"), resolve(bin, "probe.mjs"));
    await writeFile(
      resolve(bin, "ffprobe"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(bin, "probe.mjs"))} "$@"\n`,
      { mode: 0o755 },
    );
    await f.startServer({ PATH: `${bin}${delimiter}${f.env.PATH}` });
    const barrier = async (operation) => {
      for (const name of ["arm", "reached", "release"])
        await rm(resolve(gate, name), { force: true });
      await writeFile(resolve(gate, "arm"), "armed");
      const pending = operation();
      try {
        await until(
          () => exists(resolve(gate, "reached")),
          "actual ffprobe barrier",
        );
        await replace(replacement);
      } finally {
        await writeFile(resolve(gate, "release"), "released");
      }
      return pending;
    };
    await replace(original);
    await scan();
    const before = metadata();
    await barrier(scan);
    assert.equal(metadata().preview_file_version, undefined);
    assert.equal(metadata().streams, undefined);
    check(
      "replacement during scan probe never stamps old facts with the new file identity",
    );
    await replace(original);
    await scan();
    const stable = metadata();
    assert.ok(stable.preview_file_version);
    assert.equal(stable.streams[0].codec_name, before.streams[0].codec_name);
    const sessions = f.sql("SELECT count(*) FROM playback_sessions"),
      jobs = f.sql("SELECT count(*) FROM media_jobs");
    const refused = await barrier(() => prepare(input({}), 409));
    assert.equal(refused.error.code, "SOURCE_CHANGED");
    assert.equal(f.sql("SELECT count(*) FROM playback_sessions"), sessions);
    assert.equal(f.sql("SELECT count(*) FROM media_jobs"), jobs);
    assert.deepEqual(metadata(), stable);
    check(
      "replacement during preparation probe returns SOURCE_CHANGED with no new session, job or probe metadata",
    );
    await replace(original);
    const candidateInput = {
      room_id: room.id,
      media_generation: generation,
      position_ms: 0,
      audio_index: null,
    };
    const candidates = await client.request(
      "/playback-candidates",
      "POST",
      candidateInput,
    );
    assert.ok(candidates.binding);
    const candidateVersion = metadata().capability_source_version;
    const candidateReport = {
      binding: candidates.binding,
      excluded_candidates: [],
      results: candidates.candidates.map((v) => ({
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
    };
    const selected = await prepare(
      input({ candidate_report: candidateReport }),
    );
    assert.equal(selected.selected_candidate_id, "direct");
    assert.equal(
      resource(selected.session_id).source_version,
      candidateVersion,
    );
    await replace(replacement);
    assert.equal(
      (await prepare(input({ candidate_report: candidateReport }), 409)).error
        .code,
      "SOURCE_CHANGED",
    );
    await replace(original);
    const beforeCandidates = metadata();
    const failedCandidates = await barrier(() =>
      client.request("/playback-candidates", "POST", candidateInput, 409),
    );
    assert.equal(failedCandidates.error.code, "SOURCE_CHANGED");
    assert.deepEqual(metadata(), beforeCandidates);
    check(
      "local concrete candidate binding uses the same captured probe version and shared preflight rejects mid-probe replacement",
    );
    socket.close();
    socket = null;
  });
  report.cleanup = await fixture.verifyStopped();
  await verifyBinding();
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = { name: error.name, message: error.message };
  throw error;
} finally {
  if (socket) socket.terminate();
  if (fixture) {
    try {
      report.cleanup ??= await fixture.verifyStopped();
    } catch (error) {
      report.cleanup_error = error.message;
    }
    if (worker)
      report.worker_cleanup = {
        pid: worker.pid,
        pid_absent: verifyPidAbsent(worker.pid),
        port_closed: await verifyClosedPort(worker.port),
      };
  }
  report.finished_at = new Date().toISOString();
  const destination =
    process.env.RAINSYNC_LOCAL_FRESHNESS_REPORT ??
    resolve(
      process.env.RAINSYNC_ARTIFACT_DIR,
      `local-source-freshness-${randomUUID()}.json`,
    );
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${destination}`);
}
