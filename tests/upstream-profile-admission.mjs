// Actual isolated Server/PostgreSQL and controlled loopback Jellyfin/Emby HTTP.
// Requires a successful frozen backend binding; never builds or installs.
// Metadata, routes and SIDs are generated contract fixtures, not product media.
// Two expiry cases reseal only fixture-issued binding clock fields with this
// isolated Server's random key. They do not claim five minutes really elapsed.
import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WS from "ws";
import { delay, isolatedServer } from "./fixtures/server.mjs";
import { verifyClosedPort } from "./fixtures/postgres.mjs";
import { assertAudioRateContract, positiveRateReports, profileVersion } from "./fixtures/upstream-profile-rate-contract.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const boundRepo = resolve(
  process.env.RAINSYNC_UPSTREAM_PROFILE_BOUND_REPO ?? repo,
);
const bindingPath =
  process.env.RAINSYNC_UPSTREAM_PROFILE_BINDING_FILE ??
  process.env.W03_BACKEND_BINDING;
const focusBases = process.env.RAINSYNC_UPSTREAM_PROFILE_FOCUS_BASES === "1";
assert.ok(bindingPath, "a successful frozen backend binding is required");
assert.ok(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "an external artifact directory is required",
);
assert.ok(
  process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  "owned native PostgreSQL is required",
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bindingBytes = await readFile(bindingPath),
  binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
for (const path of [
  "apps/server/src/upstream_profiles.rs",
  "apps/server/src/upstream.rs",
  "apps/server/src/media.rs",
  "crates/providers/src/upstream_profiles.rs",
]) {
  assert.ok(
    binding.source.some((input) => input.path === path),
    `binding includes ${path}`,
  );
}
const suffix = process.platform === "win32" ? ".exe" : "";
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
const serverBinary = binding.binaries.find(
  (binary) => binary.name === "rainsync-server",
);
assert.ok(serverBinary, "binding includes actual Server");
assert.equal(
  resolve(serverBinary.path),
  resolve(target, "rainsync-server" + suffix),
);
const coordinator = await Promise.all(
  [
    "tests/upstream-profile-admission.mjs",
    "tests/fixtures/upstream-profile-rate-contract.mjs",
    "tests/fixtures/server.mjs",
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
    "binding remains frozen",
  );
  for (const input of binding.source)
    assert.equal(
      digest(await readFile(resolve(boundRepo, input.path))),
      input.sha256,
      `bound source remains frozen: ${input.path}`,
    );
  for (const input of coordinator)
    assert.equal(
      digest(await readFile(resolve(repo, input.path))),
      input.sha256,
      `test coordinator remains frozen: ${input.path}`,
    );
  for (const binary of binding.binaries)
    assert.equal(
      digest(await readFile(binary.path)),
      binary.sha256,
      `frozen binary unchanged: ${binary.name}`,
    );
}
await verifyBinding();
const runId = randomUUID(),
  root = resolve(
    process.env.RAINSYNC_ARTIFACT_DIR,
    "upstream-profile-admission",
    runId,
  );
await mkdir(root, { recursive: true });
const reportPath = resolve(root, "report.json");
const report = {
  schema_version: 1,
  run_id: runId,
  started_at: new Date().toISOString(),
  result: "running",
  scope:
    "Actual isolated Server/PostgreSQL; generated metadata and controlled loopback Jellyfin/Emby HTTP only. No real fixed product, media decode, Worker or browser acceptance. Synthetic binding clock fixtures are explicitly labeled. Membership deletion and explicitly resealed replay proofs are isolated fault injection; other authorization changes use public APIs or actual account observations.",
  backend_binding: {
    path: resolve(bindingPath),
    sha256: digest(bindingBytes),
    bound_repo: boundRepo,
    source_digest: binding.source_digest,
    binaries: binding.binaries,
  },
  coordinator,
  case_selection: focusBases
    ? "configured_base_spellings_only"
    : "full_finite_matrix",
  cases: [],
  failures: [],
  cleanup: {},
};
const save = () =>
  writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function until(check, label, timeout = 14000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const answer = await check();
    if (answer) return answer;
    await delay(30);
  }
  throw Error("Deadline: " + label);
}
const gates = new Set();
function gate() {
  let release;
  const promise = new Promise((done) => {
    release = done;
  });
  const hold = {
    promise,
    release() {
      hold.released_at ??= new Date().toISOString();
      release();
    },
  };
  gates.add(hold);
  return hold;
}
async function scenario(name, run) {
  if (
    focusBases &&
    !name.includes("base spelling") &&
    !name.startsWith("all owned active grants")
  )
    return;
  const record = {
    name,
    started_at: new Date().toISOString(),
    result: "running",
  };
  report.cases.push(record);
  await save();
  try {
    await run(record);
    record.result = "passed";
    console.log("PASS " + name);
  } catch (error) {
    record.result = "failed";
    record.error = String(error.stack ?? error);
    report.failures.push({ name, error: record.error });
    console.error("FAIL " + name + ": " + error.message);
  } finally {
    record.finished_at = new Date().toISOString();
    await save();
  }
}

const token = randomBytes(24).toString("hex");
const contract = {
  subjects: new Map(),
  events: [],
  sessions: new Map(),
  failures: [],
};
function metadata(kind, variant = "normal") {
  const audioZero = variant === "audio-zero",
    silent = variant === "silent";
  const streams = [
    {
      Index: audioZero ? 1 : 0,
      Type: "Video",
      Codec: "hevc",
      Width: 1920,
      Height: 1080,
      AverageFrameRate: 24,
      BitDepth: 8,
      BitRate: 6000000,
      Profile: "Main",
      Level: 120,
      VideoRange: "SDR",
    },
  ];
  if (!silent)
    streams.push({
      Index: audioZero ? 0 : 1,
      Type: "Audio",
      Codec: "ac3",
      Channels: 6,
      SampleRate: variant === "source-44100" ? 44100 : variant === "source-32000" ? 32000 : variant === "source-96000" ? 96000 : variant === "source-unknown" ? undefined : 48000,
      BitRate: 640000,
      Profile: "Dolby Digital",
    });
  const source = {
    Id: "source-" + kind,
    RunTimeTicks: 600000000,
    SupportsTranscoding: true,
    IsInfiniteStream: false,
    MediaStreams: streams,
  };
  if (!silent) source.DefaultAudioStreamIndex = audioZero ? 0 : 1;
  const value = { Id: "fixture", MediaSources: [source] };
  if (variant === "ambiguous-source")
    value.MediaSources.push(structuredClone(source));
  if (variant === "ambiguous-audio") {
    delete source.DefaultAudioStreamIndex;
    streams.push({ ...streams[1], Index: 2 });
  }
  if (variant === "changed") streams[0].Width = 1280;
  return value;
}
function playbackInfo(subject, sid, body, fault) {
  const selected = body.AudioStreamIndex;
  const query = new URLSearchParams({
    MediaSourceId: "source-" + subject.kind,
    PlaySessionId: sid,
    VideoCodec: "h264",
    VideoStreamIndex: String(subject.variant === "audio-zero" ? 1 : 0),
    VideoBitrate: "4000000",
    MaxWidth: "1280",
    MaxHeight: "720",
    [subject.kind === "emby" ? "h264-maxframerate" : "MaxFramerate"]: "30",
    AllowVideoStreamCopy: "false",
    AllowAudioStreamCopy: "false",
    "h264-level": "31",
    "h264-profile": "main",
    [subject.kind === "jellyfin" ? "h264-rangetype" : "h264-videorange"]: "SDR",
  });
  if (selected !== undefined && selected !== null)
    for (const [name, value] of Object.entries({
      AudioStreamIndex: String(selected),
      AudioCodec: "aac",
      AudioBitrate: "128000",
      ...(subject.kind === "jellyfin" ? { AudioSampleRate: "48000" } : {}),
      TranscodingMaxAudioChannels: "2",
    }))
      query.set(name, value);
  // Real Jellyfin returns this inert default even with no subtitle index.
  if (subject.kind === "jellyfin") query.set("SubtitleMethod", "Encode");
  if (fault.mismatch === "subtitle-selected")
    query.set("SubtitleStreamIndex", "0");
  if (fault.mismatch === "subtitle-empty") query.set("SubtitleStreamIndex", "");
  if (fault.mismatch === "subtitle-duplicate") {
    query.set("SubtitleStreamIndex", "-1");
    query.set("subtitlestreamindex", "0");
  }
  if (
    fault.mismatch === "missing-frame-rate" ||
    fault.mismatch === "frame-rate-alias"
  ) {
    query.delete("MaxFramerate");
    query.delete("h264-maxframerate");
  }
  if (fault.mismatch === "frame-rate-alias")
    query.set("h264-maxframerate", "30");
  if (fault.mismatch === "frame-rate-conflict") {
    query.set("MaxFramerate", "30");
    query.set("h264-maxframerate", "30");
  }
  if (fault.mismatch === "frame-rate-over-bound") {
    query.delete("MaxFramerate");
    query.set("h264-maxframerate", "60");
  }
  if (fault.mismatch === "missing-sample-rate") query.delete("AudioSampleRate");
  if (fault.explicitSampleRate) query.set("AudioSampleRate", String(fault.explicitSampleRate));
  if (fault.genericFrameRate) {
    query.delete("h264-maxframerate");
    query.set("MaxFramerate", "30");
  }
  if (fault.mismatch === "conflicting-sample-rate")
    query.set("AudioSampleRate", subject.kind === "emby" ? "32000" : "44100");
  if (fault.mismatch === "empty-sample-rate") query.set("AudioSampleRate", "");
  if (fault.mismatch === "duplicate-sample-rate") {
    query.set("AudioSampleRate", "48000");
    query.append("audiosamplerate", "48000");
  }
  if (fault.mismatch === "sample-rate-alias")
    query.set("aac-samplerate", "48000");
  if (fault.mismatch === "device") query.set("DeviceId", "another-device");
  if (fault.mismatch === "sid") query.set("PlaySessionId", "another-sid");
  if (fault.mismatch === "video-copy")
    query.set("AllowVideoStreamCopy", "true");
  if (fault.mismatch === "audio-copy")
    query.set("AllowAudioStreamCopy", "true");
  if (fault.mismatch === "video-codec") query.set("VideoCodec", "hevc");
  if (fault.mismatch === "audio-codec") query.set("AudioCodec", "mp3");
  if (fault.mismatch === "channels")
    query.set("TranscodingMaxAudioChannels", "6");
  if (fault.mismatch === "profile") query.set("h264-profile", "high");
  if (fault.mismatch === "level") query.set("h264-level", "51");
  if (fault.mismatch === "range")
    query.set(
      subject.kind === "jellyfin" ? "h264-rangetype" : "h264-videorange",
      "HDR",
    );
  if (fault.mismatch === "video-index") query.set("VideoStreamIndex", "9");
  if (fault.mismatch === "audio-bitrate") query.set("AudioBitrate", "256000");
  if (fault.mismatch === "video-bitrate") query.set("VideoBitrate", "6000000");
  if (fault.mismatch === "recipe") query.set("MaxWidth", "1920");
  if (fault.mismatch === "audio") query.set("AudioStreamIndex", "17");
  if (fault.mismatch === "namespace") {
    query.delete(
      subject.kind === "jellyfin" ? "h264-rangetype" : "h264-videorange",
    );
    query.set(
      subject.kind === "jellyfin" ? "h264-videorange" : "h264-rangetype",
      "SDR",
    );
  }
  const source = {
    Id: fault.mismatch === "source" ? "wrong-source" : "source-" + subject.kind,
    SupportsTranscoding: true,
    SupportsDirectPlay: true,
    RunTimeTicks: 600000000,
    TranscodingSubProtocol: "hls",
    TranscodingContainer: "ts",
    TranscodingUrl: `Videos/fixture/master.m3u8?${query}`,
    MediaStreams: metadata(subject.kind, subject.variant).MediaSources[0]
      .MediaStreams,
  };
  if (fault.mismatch === "item")
    source.TranscodingUrl = source.TranscodingUrl.replace(
      "Videos/fixture/",
      "Videos/another/",
    );
  if (fault.mismatch === "fragment") source.TranscodingUrl += "#ignored";
  if (fault.mismatch === "origin")
    source.TranscodingUrl = "http://unowned.invalid/" + source.TranscodingUrl;
  if (fault.mismatch === "subprotocol") source.TranscodingSubProtocol = "dash";
  if (fault.mismatch === "container") source.TranscodingContainer = "mp4";
  if (selected !== undefined && selected !== null)
    source.DefaultAudioStreamIndex = selected;
  if (fault.mismatch === "silent-default") source.DefaultAudioStreamIndex = 0;
  if (fault.mismatch === "silent-stream")
    source.MediaStreams.push({ Type: "Audio", Index: 1, Codec: "aac" });
  return { PlaySessionId: sid, MediaSources: [source] };
}
function inspectRecipe(body, subject) {
  assert.equal(body.IsPlayback, true);
  assert.equal(body.EnableDirectPlay, false);
  assert.equal(body.EnableDirectStream, false);
  assert.equal(body.AllowVideoStreamCopy, false);
  assert.equal(body.AllowAudioStreamCopy, false);
  assert.equal(body.MediaSourceId, "source-" + subject.kind);
  const profile = body.DeviceProfile;
  assert.deepEqual(profile.DirectPlayProfiles, []);
  const transcode = profile.TranscodingProfiles[0];
  assert.equal(transcode.VideoCodec, "h264");
  assert.equal(transcode.AudioCodec, "aac");
  assert.equal(transcode.Protocol, "hls");
  assert.equal(transcode.Container, "ts");
  const conditions = profile.CodecProfiles.find(
    (value) => value.Type === "Video",
  ).Conditions;
  assert.ok(
    conditions.some(
      (value) =>
        value.Property ===
          (subject.kind === "jellyfin" ? "VideoRangeType" : "VideoRange") &&
        value.Value === "SDR" &&
        value.IsRequired === true,
    ),
  );
  assert.ok(
    conditions.some(
      (value) => value.Property === "Width" && value.Value === "1280",
    ),
  );
  assert.ok(
    conditions.some(
      (value) => value.Property === "VideoProfile" && value.Value === "main",
    ),
  );
  if (subject.kind === "emby") {
    assert.equal(transcode.MaxWidth, 1280);
    assert.equal(transcode.MaxHeight, 720);
  }
}
let upstreamOrigin;
const upstream = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, upstreamOrigin);
    const [kind, tag, ...parts] = url.pathname.slice(1).split("/");
    const subject = contract.subjects.get(tag),
      path = "/" + parts.join("/");
    assert.ok(
      subject && subject.kind === kind,
      "known controlled provider namespace",
    );
    const authorization =
      request.headers.authorization ??
      request.headers["x-emby-authorization"] ??
      "";
    assert.ok(
      authorization.includes(`Token="${token}"`) ||
        request.headers["x-emby-token"] === token,
      "generated fixture credential forwarded",
    );
    const device =
      /DeviceId="([^"]+)"/.exec(authorization)?.[1] ??
      request.headers["x-emby-device-id"] ??
      url.searchParams.get("DeviceId");
    let body = {};
    if (request.method === "POST") {
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      body = bytes ? JSON.parse(bytes) : {};
    }
    const event = {
      at: new Date().toISOString(),
      kind,
      tag,
      method: request.method,
      path,
      device_id: device ?? null,
      sid: body.PlaySessionId ?? url.searchParams.get("PlaySessionId") ?? null,
    };
    contract.events.push(event);
    const json = (value) => {
      event.response_status = 200;
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(value));
    };
    if (path === "/Users/fixture-user") {
      assert.equal(request.method, "GET");
      return json({
        Id: "fixture-user",
        Policy: {
          IsDisabled: subject.accountDenied ?? false,
          EnableMediaPlayback: true,
        },
      });
    }
    if (path === "/Users/fixture-user/Items")
      return json({
        TotalRecordCount: 1,
        Items: [
          {
            Id: "fixture",
            Name: "Generated legal upstream contract fixture",
            RunTimeTicks: 600000000,
          },
        ],
      });
    if (path === "/Users/fixture-user/Items/fixture") {
      assert.equal(request.method, "GET");
      assert.match(device ?? "", /^rainsync-[0-9a-f-]{36}$/);
      const fault = subject.metadataQueue.shift() ?? {};
      fault.received = event;
      if (fault.hold) await fault.hold.promise;
      event.released_at = new Date().toISOString();
      return json(metadata(kind, fault.variant ?? subject.variant));
    }
    if (path === "/Items/fixture/PlaybackInfo") {
      assert.equal(request.method, "POST");
      assert.match(device ?? "", /^rainsync-[0-9a-f-]{36}$/);
      inspectRecipe(body, subject);
      const fault = subject.playbackQueue.shift() ?? {},
        sid = randomUUID();
      Object.assign(event, {
        sid,
        scenario: fault.name ?? "normal",
        recipe_validated: true,
        selected_audio: body.AudioStreamIndex ?? null,
      });
      const session = {
        sid,
        kind,
        tag,
        device,
        starts: 0,
        stops: 0,
        encoding_stops: 0,
        fault,
      };
      contract.sessions.set(sid, session);
      fault.received = event;
      if (fault.hold) await fault.hold.promise;
      event.released_at = new Date().toISOString();
      session.originalInfo = playbackInfo(subject, sid, body, fault);
      return json(session.originalInfo);
    }
    if (
      [
        "/Sessions/Playing",
        "/Sessions/Playing/Progress",
        "/Sessions/Playing/Stopped",
      ].includes(path)
    ) {
      const session = contract.sessions.get(body.PlaySessionId);
      assert.ok(session, "reported SID was actually allocated");
      assert.equal(device, session.device);
      assert.equal(tag, session.tag);
      assert.equal(body.ItemId, "fixture");
      if (path.endsWith("Stopped")) {
        session.fault.stop_received = event;
        if (session.fault.stopHold) await session.fault.stopHold.promise;
        session.stops++;
      }
      if (path === "/Sessions/Playing") session.starts++;
      event.response_status = 204;
      event.confirmed_at = new Date().toISOString();
      response.writeHead(204).end();
      return;
    }
    if (request.method === "DELETE" && path === "/Videos/ActiveEncodings") {
      const session = contract.sessions.get(
        url.searchParams.get("PlaySessionId"),
      );
      assert.ok(session);
      assert.equal(kind, "emby");
      assert.equal(device, session.device);
      assert.equal(url.searchParams.get("DeviceId"), session.device);
      session.encoding_stops++;
      event.response_status = 204;
      event.confirmed_at = new Date().toISOString();
      response.writeHead(204).end();
      return;
    }
    throw Error(`Unexpected upstream contract route ${request.method} ${path}`);
  } catch (error) {
    contract.failures.push(String(error.stack ?? error));
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

class Controller {
  constructor(fixture, client) {
    this.fixture = fixture;
    this.client = client;
    this.inbox = [];
  }
  async wait(check) {
    return until(() => {
      const index = this.inbox.findIndex(check);
      return index < 0 ? null : this.inbox.splice(index, 1)[0];
    }, "room WebSocket response");
  }
  async join(room) {
    this.room = room;
    this.socket = new WS(
      this.fixture.origin.replace("http", "ws") + "/api/v1/ws",
      { headers: { Origin: this.fixture.origin, Cookie: this.client.cookie } },
    );
    this.socket.on("message", (bytes) => this.inbox.push(JSON.parse(bytes)));
    this.socket.on("error", () => {});
    await new Promise((done, reject) => {
      this.socket.once("open", done);
      this.socket.once("error", reject);
    });
    this.socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    const snapshot = await this.wait((value) => value.type === "SNAPSHOT");
    this.state = snapshot.state;
    this.epoch = snapshot.control_epoch.id;
  }
  async change(media) {
    const command = randomUUID();
    this.socket.send(
      JSON.stringify({
        protocol_version: 1,
        room_id: this.room.id,
        control_epoch: this.epoch,
        command_id: command,
        expected_revision: this.state.revision,
        media_generation: this.state.media_generation,
        type: "CHANGE_MEDIA",
        payload: { media_id: media },
      }),
    );
    const answer = await this.wait((value) => value.command_id === command);
    assert.equal(answer.type, "ACK");
    this.state = answer.state;
  }
  async close() {
    if (!this.socket || this.socket.readyState === WS.CLOSED) return;
    const closed = new Promise((done) => this.socket.once("close", done));
    this.socket.terminate();
    await closed;
  }
}

let fixture, upstreamPort;
const controllers = [],
  locks = new Set();
try {
  await new Promise((done, reject) =>
    upstream.once("error", reject).listen(0, "127.0.0.1", done),
  );
  upstreamPort = upstream.address().port;
  upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
  report.upstream = { origin: upstreamOrigin, port: upstreamPort };
  await isolatedServer(
    "upstream-profile-admission",
    async (f) => {
      fixture = f;
      report.fixture = {
        id: f.id,
        root: f.root,
        origin: f.origin,
        database: f.postgresDiagnostics(),
      };
      const admin = f.client(),
        user = await admin.login();
      const allowed = {
        schema_version: 1,
        origins: [{ origin: upstreamOrigin, cidrs: ["127.0.0.1/32"] }],
      };
      const read = (query) => JSON.parse(f.sql(query) || "null");
      const requestRow = (key) =>
        read(
          `SELECT jsonb_build_object('session_id',session_id,'status',status,'owner_epoch',owner_epoch,'attempt',attempt,'error_code',error_code,'response_persisted',response_encrypted IS NOT NULL,'preparation_drained_at',preparation_drained_at) FROM playback_requests WHERE user_id=${quote(user.id)} AND idempotency_key=${quote(key)}`,
        );
      const ledger = (id) =>
        read(
          `SELECT jsonb_build_object('id',id,'state',state,'negotiation',negotiation,'owner_epoch',owner_epoch,'request_key',request_key,'device_id',device_id,'play_session_id',play_session_id,'media_source_id',media_source_id,'response_persisted',response_encrypted IS NOT NULL,'scope_persisted',scope_encrypted IS NOT NULL,'io_claim',io_claim,'io_kind',io_kind,'start_reported',start_reported,'stop_confirmed',stop_confirmed,'encoding_stop_confirmed',encoding_stop_confirmed,'close_reason',close_reason,'closed_at',closed_at) FROM upstream_reservations WHERE id=${quote(id)}`,
        );
      const count = (subject, path = "/Items/fixture/PlaybackInfo") =>
        contract.events.filter(
          (event) => event.tag === subject.tag && event.path === path,
        ).length;
      const api = async (client, path, body, signal) => {
        const response = await client.raw(path, {
          method: "POST",
          body,
          signal: signal ?? AbortSignal.timeout(40000),
        });
        let value;
        try {
          value = await response.json();
        } catch {
          value = {};
        }
        return { status: response.status, body: value };
      };
      const prepare = (subject, body, signal) =>
        api(
          subject.client,
          "/playback-sessions/upstream-profile",
          body,
          signal,
        );
      const safeResponse = (response) => ({
        status: response.status,
        error_code: response.body.error?.code ?? null,
      });
      const noPlan = (response) => {
        assert.notEqual(
          response.status,
          200,
          "failed admission returns no plan",
        );
        assert.equal(response.body.session_id, undefined);
        assert.equal(response.body.playback_url, undefined);
      };
      const error = (response, status, code) => {
        noPlan(response);
        assert.equal(response.status, status);
        if (code) assert.equal(response.body.error?.code, code);
      };
      async function setup(
        kind,
        name,
        variant = "normal",
        client = admin,
        trailingSlash = true,
      ) {
        const tag = randomUUID(),
          subject = {
            tag,
            kind,
            variant,
            client,
            metadataQueue: [],
            playbackQueue: [],
            base: `/${kind}/${tag}`,
          };
        contract.subjects.set(tag, subject);
        subject.source = await admin.request("/sources", "POST", {
          name,
          kind,
          config: {
            url: upstreamOrigin + subject.base + (trailingSlash ? "/" : ""),
            token,
            user_id: "fixture-user",
            access_policy: allowed,
          },
        });
        await admin.request(`/sources/${subject.source.id}/test`, "POST");
        const media = f.sql(
          `SELECT id FROM media_items WHERE source_id=${quote(subject.source.id)}`,
        );
        assert.match(media, /^[0-9a-f-]{36}$/);
        subject.room = await admin.request("/rooms", "POST", { name });
        subject.controller = new Controller(f, admin);
        controllers.push(subject.controller);
        await subject.controller.join(subject.room);
        await subject.controller.change(media);
        subject.body = (profile, overrides = {}) => ({
          idempotency_key: randomUUID(),
          room_id: subject.room.id,
          media_generation: subject.controller.state.media_generation,
          viewer_id: randomUUID(),
          plan_generation: 1,
          mode: "transcode",
          position_ms: 1200,
          audio_index: null,
          capabilities: {
            progressive_h264_aac: false,
            native_hls: false,
            mse_h264_aac: true,
          },
          upstream_profile_report: {
            profile_version: profile.profile_version,
            binding: profile.binding,
            profile_id: profile.profile.profile_id,
            mse_supported: true,
            mse_decoding: {
              supported: true,
              smooth: true,
              power_efficient: false,
            },
            ...positiveRateReports(profile.profile),
          },
          ...overrides,
        });
        return subject;
      }
      function decodeProfile(value) {
        const key = Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"),
          bytes = Buffer.from(value, "base64");
        const cipher = createDecipheriv(
          "aes-256-gcm",
          key,
          bytes.subarray(0, 12),
        );
        cipher.setAuthTag(bytes.subarray(-16));
        return JSON.parse(
          Buffer.concat([
            cipher.update(bytes.subarray(12, -16)),
            cipher.final(),
          ]).toString("utf8"),
        );
      }
      function sealFixture(value) {
        const nonce = randomBytes(12),
          cipher = createCipheriv(
            "aes-256-gcm",
            Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"),
            nonce,
          );
        return Buffer.concat([
          nonce,
          // serde_json retains float versus integer number representations in
          // the bound Value envelope. Preserve the canonical f64 MSE framerate
          // token when JS reserializes it, so unrelated tamper tests are not
          // accidentally rejected only because 30.0 became 30.
          cipher.update(JSON.stringify(value).replace(/("framerate":)(\d+)(?=[,}])/g, "$1$2.0")),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString("base64");
      }
      function assertExactReplay(replay, original) {
        assert.ok(
          Number.isFinite(replay.expires_in_seconds) &&
            replay.expires_in_seconds > 0 &&
            replay.expires_in_seconds <= original.expires_in_seconds,
          "replay refreshes only its remaining positive lifetime",
        );
        assert.deepEqual(
          { ...replay, expires_in_seconds: original.expires_in_seconds },
          original,
        );
      }
      function assertOwnedRoute(subject, plan) {
        const row = ledger(plan.session_id),
          session = contract.sessions.get(row.play_session_id);
        const checkpoint = decodeProfile(
          f.sql(
            `SELECT response_encrypted FROM upstream_reservations WHERE id=${quote(plan.session_id)}`,
          ),
        );
        assert.deepEqual(
          checkpoint,
          session.originalInfo,
          "checkpoint is the exact original response, never completed in place",
        );
        const resource = decodeProfile(
          f.sql(
            `SELECT resource->>'encrypted' FROM playback_sessions WHERE id=${quote(plan.session_id)}`,
          ),
        );
        const original = new URL(
          checkpoint.MediaSources[0].TranscodingUrl,
          upstreamOrigin + subject.base + "/",
        );
        const returned = new Map(
          [...original.searchParams].map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        );
        const audio = checkpoint.MediaSources[0].MediaStreams.some(
          (stream) => stream.Type === "Audio",
        );
        const completion =
          subject.kind === "emby" && audio && !returned.has("audiosamplerate");
        const expected = new URL(original);
        if (!returned.has("deviceid"))
          expected.search += "&DeviceId=" + encodeURIComponent(row.device_id);
        if (completion) expected.search += "&AudioSampleRate=48000";
        assert.equal(
          resource.url,
          expected.href,
          "only owned missing device identity and explicit missing sample rate are added",
        );
        const provenance = {
          schema_version: subject.kind === "emby" ? 2 : 1,
          semantics: "requested_configuration_not_measured_output",
          frame_rate_field: returned.has("h264-maxframerate")
            ? "h264-maxframerate"
            : "maxframerate",
          provider_audio_sample_rate: returned.has("audiosamplerate")
            ? Number(returned.get("audiosamplerate"))
            : null,
          server_requested_audio_sample_rate: completion ? 48000 : null,
          ...(subject.kind === "emby" && audio ? {
            allowed_audio_sample_rates: [44100, 48000],
            source_audio_sample_rate: subject.variant === "source-44100" ? 44100 : 48000,
          } : {}),
        };
        assert.deepEqual(
          resource.upstream_profile_route_provenance,
          provenance,
        );
        assert.equal(resource.upstream_session, row.play_session_id);
        assert.equal(resource.upstream_device, row.device_id);
        assert.equal(resource.upstream_media_source, row.media_source_id);
        assert.equal(
          plan.decision_reason ===
            "emby_server_requested_audio_sample_rate_48000",
          completion,
        );
        assert.equal(
          count(subject),
          1,
          "completion and replay allocate no second PlaybackInfo or SID",
        );
        return {
          provenance,
          original_response_unchanged: true,
          completed_same_sid: completion,
          playback_posts: 1,
        };
      }
      function resealClock(value, expiresInMs) {
        const proof = decodeProfile(value),
          now = Number(
            f.sql(
              "SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint",
            ),
          );
        proof.issued_at_ms = now - 1000;
        proof.expires_at_ms = now + expiresInMs;
        return sealFixture(proof);
      }
      async function candidates(subject, audio = null, overrides = {}) {
        return api(subject.client, "/upstream-profile-candidates", {
          profile_version: 2,
          room_id: subject.room.id,
          media_generation: subject.controller.state.media_generation,
          position_ms: 1200,
          audio_index: audio,
          ...overrides,
        });
      }
      async function minted(subject, audio = null) {
        const posts = count(subject),
          rows = Number(f.sql("SELECT count(*) FROM playback_requests"));
        const response = await candidates(subject, audio);
        assert.equal(response.status, 200);
        assert.equal(response.body.profile_version, profileVersion(subject.kind));
        assertAudioRateContract(response.body.profile, subject.kind, subject.variant === "source-44100" ? 44100 : 48000);
        assert.ok(response.body.binding);
        assert.ok(response.body.profile);
        assert.equal(
          count(subject),
          posts,
          "preflight does no PlaybackInfo POST",
        );
        assert.equal(
          [...contract.sessions.values()].filter(
            (session) => session.tag === subject.tag,
          ).length,
          posts,
          "preflight allocates no SID",
        );
        assert.equal(
          Number(f.sql("SELECT count(*) FROM playback_requests")),
          rows + 1,
          "preflight owns a durable preparation",
        );
        const last = read(
          `SELECT jsonb_build_object('session_id',session_id,'status',status,'preparation_drained_at',preparation_drained_at) FROM playback_requests WHERE room_id=${quote(subject.room.id)} ORDER BY created_at DESC LIMIT 1`,
        );
        assert.equal(last.status, "failed");
        await until(
          () =>
            f.sql(
              `SELECT drained_at IS NOT NULL FROM playback_preparations WHERE session_id=${quote(last.session_id)}`,
            ) === "t",
          "preflight owner drain",
        );
        assert.equal(
          ledger(last.session_id),
          null,
          "read-only preflight has no upstream reservation",
        );
        const proof = decodeProfile(response.body.binding),
          ttl = proof.expires_at_ms - proof.issued_at_ms;
        assert.ok(ttl > 0 && ttl <= 300000);
        assert.equal(proof.identity.user, user.id);
        assert.equal(proof.identity.room, subject.room.id);
        assert.match(proof.identity.login_hash, /^[0-9a-f]{64}$/);
        assert.match(proof.identity.membership_epoch, /^[0-9a-f-]{36}$/);
        assert.equal(proof.source, subject.source.id);
        assert.equal(proof.kind, subject.kind);
        assert.equal(proof.requested_audio, audio);
        assert.ok(proof.account_generation > 0);
        assert.equal(proof.purpose, "upstream_transcode_profile_envelope_v1");
        assert.equal(proof.profile_version, profileVersion(subject.kind));
        assert.equal(proof.profile_id, response.body.profile.profile_id);
        assert.deepEqual(proof.profile_envelope, subject.kind === "emby" ? response.body.profile : undefined);
        assert.equal(
          response.body.profile.configuration_semantics,
          "upstream_transcode_profile_envelope",
        );
        assert.equal(response.body.profile.requested_video.max_width, 1280);
        assert.equal(response.body.profile.mse_sample.video.width, 1280);
        return response.body;
      }
      async function drained(key) {
        await until(
          () => requestRow(key)?.preparation_drained_at,
          "returned preparation owner acknowledges drain",
        );
        const row = requestRow(key);
        assert.equal(
          f.sql(
            `SELECT drained_at IS NOT NULL FROM playback_preparations WHERE session_id=${quote(row.session_id)}`,
          ),
          "t",
        );
        return row;
      }
      async function stopped(id, noSid = false) {
        await until(
          () => ledger(id)?.state === "closed",
          "owned upstream cleanup reaches closed",
        );
        const row = ledger(id);
        assert.ok(row.closed_at);
        if (noSid) {
          assert.equal(row.negotiation, "not_sent");
          assert.equal(row.play_session_id, null);
          assert.equal(
            row.stop_confirmed,
            false,
            "no request is not a fabricated Stop receipt",
          );
        } else {
          assert.equal(row.negotiation, "received");
          assert.equal(row.response_persisted, true);
          assert.equal(row.stop_confirmed, true);
          const actual = contract.sessions.get(row.play_session_id);
          assert.ok(actual);
          assert.equal(actual.device, row.device_id);
          assert.equal(actual.stops, 1);
          if (actual.kind === "emby") {
            assert.equal(row.encoding_stop_confirmed, true);
            assert.equal(actual.encoding_stops, 1);
          }
        }
        return row;
      }
      async function closePlan(subject, plan) {
        assertOwnedRoute(subject, plan);
        await subject.client.request(
          `/playback-sessions/${plan.session_id}`,
          "DELETE",
        );
        await stopped(plan.session_id);
      }
      async function lockSource(subject, seconds = 2) {
        const tag = "profile-source-lock-" + randomUUID();
        const lock = f.sqlProcess(
          `BEGIN; SELECT id FROM sources WHERE id=${quote(subject.source.id)} FOR NO KEY UPDATE; SELECT pg_sleep(${seconds}) /* ${tag} */; COMMIT;`,
        );
        locks.add(lock);
        await f.waitForSql(
          `SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${tag}%'`,
          "1",
        );
        return lock;
      }
      const controls = [];
      for (const kind of ["jellyfin", "emby"]) {
        const subject = await setup(kind, kind + " independent control"),
          profile = await minted(subject),
          response = await prepare(subject, subject.body(profile));
        assert.equal(response.status, 200);
        controls.push({
          subject,
          plan: response.body,
          sid: ledger(response.body.session_id).play_session_id,
        });
      }
      async function unaffected() {
        for (const control of controls) {
          assert.equal(
            (
              await admin.request(
                `/playback-sessions/${control.plan.session_id}`,
              )
            ).session_id,
            control.plan.session_id,
          );
          assert.equal(ledger(control.plan.session_id).state, "active");
          assert.equal(contract.sessions.get(control.sid).stops, 0);
        }
      }

      for (const kind of ["jellyfin", "emby"]) {
        for (const trailingSlash of [true, false])
          await scenario(
            `${kind}: configured base spelling ${trailingSlash ? "with" : "without"} trailing slash preserves its namespaced route`,
            async (record) => {
              const subject = await setup(
                  kind,
                  "configured base spelling",
                  "normal",
                  admin,
                  trailingSlash,
                ),
                profile = await minted(subject),
                body = subject.body(profile);
              const first = await prepare(subject, body);
              assert.equal(first.status, 200);
              assert.equal(first.body.delivery_mode, "transcode");
              assert.equal(first.body.transport, "hls");
              assert.deepEqual(first.body.upstream_profile, profile.profile);
              const replay = await prepare(subject, body);
              assert.equal(replay.status, 200);
              assert.equal(replay.body.session_id, first.body.session_id);
              assert.equal(count(subject), 1);
              assert.equal(
                count(subject, "/Users/fixture-user/Items/fixture"),
                2,
              );
              await drained(body.idempotency_key);
              await closePlan(subject, first.body);
              await unaffected();
              record.configured_base_has_trailing_slash = trailingSlash;
              record.metadata_gets = 2;
              record.playback_posts = 1;
            },
          );
        await scenario(
          `${kind}: metadata-only preflight and explicit MSE profile plan replay`,
          async (record) => {
            const subject = await setup(kind, "profile positive"),
              profile = await minted(subject),
              body = subject.body(profile);
            assert.equal(
              count(subject, "/Users/fixture-user/Items/fixture"),
              1,
            );
            assert.equal(count(subject), 0);
            const first = await prepare(subject, body);
            assert.equal(first.status, 200);
            assert.equal(first.body.delivery_mode, "transcode");
            assert.equal(first.body.transport, "hls");
            assert.deepEqual(first.body.upstream_profile, profile.profile);
            assert.deepEqual(first.body.decoder_fallback_modes, []);
            assert.equal(count(subject), 1);
            assert.equal(
              count(subject, "/Users/fixture-user/Items/fixture"),
              2,
            );
            const completed = await drained(body.idempotency_key),
              before = ledger(first.body.session_id);
            assert.equal(completed.attempt, 1);
            assert.equal(before.response_persisted, true);
            assert.equal(before.state, "active");
            assert.equal(before.owner_epoch, completed.owner_epoch);
            assert.equal(before.request_key, body.idempotency_key);
            const replay = await prepare(subject, body);
            assert.equal(replay.status, 200);
            assert.equal(replay.body.session_id, first.body.session_id);
            assert.equal(count(subject), 1);
            await closePlan(subject, first.body);
            await unaffected();
            record.playback_posts = 1;
            record.metadata_gets = 2;
            record.binding_lifetime_ms =
              decodeProfile(profile.binding).expires_at_ms -
              decodeProfile(profile.binding).issued_at_ms;
          },
        );
        await scenario(
          `${kind}: dedicated route requires transcode and positive path-specific MSE evidence`,
          async (record) => {
            const subject = await setup(kind, "profile negative samples"),
              profile = await minted(subject),
              base = subject.body(profile),
              cases = [];
            for (const [label, mutate, status, code] of [
              [
                "missing report",
                (value) => {
                  delete value.upstream_profile_report;
                },
                400,
                "INVALID_REQUEST",
              ],
              [
                "unsupported version",
                (value) => {
                  value.upstream_profile_report.profile_version = 3;
                },
                400,
                "INVALID_REQUEST",
              ],
              [
                "empty binding",
                (value) => {
                  value.upstream_profile_report.binding = "";
                },
                400,
                "INVALID_REQUEST",
              ],
              [
                "wrong profile",
                (value) => {
                  value.upstream_profile_report.profile_id = "client-recipe";
                },
                400,
                "INVALID_REQUEST",
              ],
              [
                "negative MSE",
                (value) => {
                  value.upstream_profile_report.mse_supported = false;
                },
                422,
                "DEVICE_HAS_NO_COMPATIBLE_PLAYBACK_TRANSPORT",
              ],
              [
                "missing MSE decoding",
                (value) => {
                  delete value.upstream_profile_report.mse_decoding;
                },
                422,
                "DEVICE_HAS_NO_COMPATIBLE_PLAYBACK_TRANSPORT",
              ],
              [
                "negative MSE decoding",
                (value) => {
                  value.upstream_profile_report.mse_decoding.supported = false;
                },
                422,
                "DEVICE_HAS_NO_COMPATIBLE_PLAYBACK_TRANSPORT",
              ],
              ...["auto", "direct", "remux"].map((mode) => [
                mode + " is not explicit transcode",
                (value) => {
                  value.mode = mode;
                },
                400,
                "INVALID_REQUEST",
              ]),
            ]) {
              const body = structuredClone(base);
              body.idempotency_key = randomUUID();
              mutate(body);
              const result = await prepare(subject, body);
              error(result, status, code);
              cases.push({ label, ...safeResponse(result) });
            }
            if (kind === "jellyfin") {
              assert.equal(base.upstream_profile_report.audio_rate_reports, undefined);
              const unexpected = structuredClone(base); unexpected.idempotency_key = randomUUID();
              unexpected.upstream_profile_report.audio_rate_reports = [];
              error(await prepare(subject, unexpected), 400, "INVALID_REQUEST");
              unexpected.idempotency_key = randomUUID();
              unexpected.upstream_profile_report.audio_rate_reports = null;
              const invalidNull = await prepare(subject, unexpected);
              noPlan(invalidNull); assert.equal(invalidNull.status, 422);
              const legacyDiscovery = await candidates(subject, null, { profile_version: 1 });
              assert.equal(legacyDiscovery.status, 200);
              assert.equal(legacyDiscovery.body.profile_version, 1);
              assert.deepEqual(legacyDiscovery.body.profile, profile.profile);
            }
            const generic = await api(
              subject.client,
              "/playback-sessions",
              base,
            );
            error(generic, 400, "INVALID_REQUEST");
            const malformed = structuredClone(base);
            malformed.upstream_profile_report.device_profile = {};
            const invalidDto = await prepare(subject, malformed);
            noPlan(invalidDto);
            assert.ok([400, 422].includes(invalidDto.status));
            const invalidCipher = structuredClone(base);
            invalidCipher.upstream_profile_report.binding =
              "not-a-valid-encrypted-binding";
            const stale = await prepare(subject, invalidCipher);
            error(stale, 409, "STALE_CAPABILITY_REPORT");
            const unsupportedPreflight = await candidates(subject, null, {
              profile_version: 3,
            });
            error(unsupportedPreflight, 400, "INVALID_REQUEST");
            assert.equal(count(subject), 0);
            record.rejections = cases;
            record.generic_error = safeResponse(generic);
            record.metadata_gets = count(
              subject,
              "/Users/fixture-user/Items/fixture",
            );
            await unaffected();
          },
        );
        for (const variant of ["silent", "audio-zero"])
          await scenario(
            `${kind}: ${variant} metadata preserves exact audio intent`,
            async (record) => {
              const subject = await setup(kind, "profile " + variant, variant),
                audio = variant === "audio-zero" ? 0 : null,
                profile = await minted(subject, audio),
                body = subject.body(profile, { audio_index: audio });
              if (variant === "silent") {
                assert.equal(profile.profile.requested_audio, null);
                assert.equal(profile.profile.mse_sample.audio, null);
                if (kind === "emby") {
                  assert.deepEqual(body.upstream_profile_report.audio_rate_reports, []);
                  for (const nullValue of [false, true]) {
                    const invalid = structuredClone(body); invalid.idempotency_key = randomUUID(); invalid.viewer_id = randomUUID();
                    if (nullValue) invalid.upstream_profile_report.audio_rate_reports = null;
                    else delete invalid.upstream_profile_report.audio_rate_reports;
                    const rejected = await prepare(subject, invalid);
                    if (nullValue) { noPlan(rejected); assert.equal(rejected.status, 422); }
                    else error(rejected, 409, "STALE_CAPABILITY_REPORT");
                    assert.equal(count(subject), 0);
                  }
                  const nonempty = structuredClone(body);
                  nonempty.idempotency_key = randomUUID();
                  nonempty.viewer_id = randomUUID();
                  nonempty.upstream_profile_report.audio_rate_reports = [44100, 48000].map((sample_rate) => ({
                    sample_rate, mse_supported: true, mse_decoding: { supported: true, smooth: false, power_efficient: false },
                  }));
                  error(await prepare(subject, nonempty), 409, "STALE_CAPABILITY_REPORT");
                  assert.equal(count(subject), 0);
                }
              } else {
                assert.equal(profile.profile.requested_audio.codec, "aac");
                assert.equal(decodeProfile(profile.binding).metadata.audio.index, 0);
                assert.equal(decodeProfile(profile.binding).metadata.video.index, 1);
                if (kind === "emby") assert.deepEqual(body.upstream_profile_report.audio_rate_reports.map((entry) => entry.sample_rate), [44100, 48000]);
                assert.ok(
                  profile.profile.mse_sample.audio.content_type.includes(
                    "mp4a.40.2",
                  ),
                );
              }
              const response = await prepare(subject, body);
              record.positive_response = safeResponse(response);
              record.positive_request = requestRow(body.idempotency_key);
              assert.equal(response.status, 200);
              assert.equal(count(subject), 1);
              const event = contract.events.find(
                (value) =>
                  value.tag === subject.tag &&
                  value.path.endsWith("PlaybackInfo"),
              );
              assert.equal(event.selected_audio, audio);
              await closePlan(subject, response.body);
              await drained(body.idempotency_key);
              record.audio_index = audio;
              record.playback_posts = 1;
              await unaffected();
            },
          );
        await scenario(
          `${kind}: ambiguous sources and audio plus non-audio index fail before PlaybackInfo`,
          async (record) => {
            const outcomes = [];
            for (const variant of [
              "ambiguous-source",
              "ambiguous-audio",
              "normal",
            ]) {
              const subject = await setup(kind, variant, variant);
              const result = await candidates(
                subject,
                variant === "normal" ? 0 : null,
              );
              error(result, 502, "UPSTREAM_PLAYBACK_FAILED");
              assert.equal(count(subject), 0);
              outcomes.push({ variant, ...safeResponse(result) });
            }
            record.rejections = outcomes;
            await unaffected();
          },
        );
        await scenario(
          `${kind}: changed metadata during final admission leaves a no-POST cleanup proof`,
          async (record) => {
            const subject = await setup(kind, "changed final metadata"),
              profile = await minted(subject),
              body = subject.body(profile);
            subject.metadataQueue.push({ variant: "changed" });
            const response = await prepare(subject, body);
            error(response, 409, "SOURCE_CHANGED");
            assert.equal(count(subject), 0);
            const row = await drained(body.idempotency_key);
            record.reservation = await stopped(row.session_id, true);
            assert.equal(
              f.sql(
                `SELECT count(*) FROM playback_sessions WHERE id=${quote(row.session_id)}`,
              ),
              "0",
            );
            await unaffected();
          },
        );
        for (const mismatch of [
          "recipe",
          "audio",
          "source",
          "namespace",
          "silent-default",
          "silent-stream",
          "subtitle-selected",
          "subtitle-empty",
          "subtitle-duplicate",
          "missing-frame-rate",
          ...(kind === "jellyfin"
            ? ["frame-rate-alias", "missing-sample-rate"]
            : []),
          "frame-rate-conflict",
          "frame-rate-over-bound",
          "conflicting-sample-rate",
          "empty-sample-rate",
          "duplicate-sample-rate",
          "sample-rate-alias",
          "device",
          "sid",
          "video-copy",
          "audio-copy",
          "video-codec",
          "audio-codec",
          "channels",
          "profile",
          "level",
          "range",
          "video-index",
          "audio-bitrate",
          "video-bitrate",
          "item",
          "fragment",
          "origin",
          "subprotocol",
          "container",
        ])
          await scenario(
            `${kind}: checkpoint ${mismatch} mismatch SID before owned Stop`,
            async (record) => {
              const subject = await setup(
                  kind,
                  mismatch + " route mismatch",
                  mismatch.startsWith("silent-") ? "silent" : "normal",
                ),
                profile = await minted(subject),
                body = subject.body(profile),
                fault = { name: mismatch, mismatch, stopHold: gate() };
              subject.playbackQueue.push(fault);
              try {
                const response = await prepare(subject, body);
                error(response, 502, "UPSTREAM_PLAYBACK_FAILED");
                assert.equal(count(subject), 1);
                const row = requestRow(body.idempotency_key);
                await until(
                  () => fault.stop_received,
                  "mismatch cleanup reaches exact Stop",
                );
                const checkpoint = ledger(row.session_id);
                assert.equal(checkpoint.negotiation, "received");
                assert.equal(checkpoint.play_session_id, fault.received.sid);
                assert.equal(checkpoint.response_persisted, true);
                assert.equal(checkpoint.state, "closing");
                assert.equal(checkpoint.stop_confirmed, false);
                assert.equal(checkpoint.closed_at, null);
                assert.equal(checkpoint.start_reported, false);
                assert.equal(
                  contract.sessions.get(fault.received.sid).starts,
                  0,
                );
                const retainedOriginal = decodeProfile(
                  f.sql(
                    `SELECT response_encrypted FROM upstream_reservations WHERE id=${quote(row.session_id)}`,
                  ),
                );
                assert.deepEqual(
                  retainedOriginal,
                  contract.sessions.get(fault.received.sid).originalInfo,
                );
                record.checkpoint = checkpoint;
                record.original_response_unchanged = true;
                record.missing_sample_rate_did_not_bypass_other_guards =
                  kind === "emby";
                fault.stopHold.release();
                record.terminal = await stopped(row.session_id);
                await drained(body.idempotency_key);
                assert.equal(
                  f.sql(
                    `SELECT count(*) FROM playback_sessions WHERE id=${quote(row.session_id)}`,
                  ),
                  "0",
                );
                await unaffected();
              } finally {
                fault.stopHold.release();
              }
            },
          );
        await scenario(
          `${kind}: cancelled final metadata owns its preparation and allocates no SID`,
          async (record) => {
            const subject = await setup(kind, "cancel held metadata"),
              profile = await minted(subject),
              body = subject.body(profile),
              fault = { hold: gate() };
            subject.metadataQueue.push(fault);
            const pending = prepare(subject, body);
            try {
              await until(() => fault.received, "final metadata held");
              const before = requestRow(body.idempotency_key),
                reserved = ledger(before.session_id);
              assert.equal(before.status, "pending");
              assert.equal(before.preparation_drained_at, null);
              assert.equal(reserved.negotiation, "reserved");
              assert.equal(reserved.play_session_id, null);
              assert.equal(reserved.owner_epoch, before.owner_epoch);
              await subject.client.request(
                `/playback-requests/${body.idempotency_key}`,
                "DELETE",
              );
              assert.equal(count(subject), 0);
              fault.hold.release();
              const response = await pending;
              noPlan(response);
              record.before = reserved;
              record.response = safeResponse(response);
              record.terminal = await stopped(before.session_id, true);
              await drained(body.idempotency_key);
              await unaffected();
            } finally {
              fault.hold.release();
              await pending.catch(() => {});
            }
          },
        );
        await scenario(
          `${kind}: cancellation retains a late SID and records real Stop receipts`,
          async (record) => {
            const subject = await setup(kind, "late SID cancellation"),
              profile = await minted(subject),
              body = subject.body(profile),
              fault = { name: "late-SID", hold: gate(), stopHold: gate() };
            subject.playbackQueue.push(fault);
            const pending = prepare(subject, body);
            try {
              await until(() => fault.received, "PlaybackInfo held after POST");
              const before = requestRow(body.idempotency_key),
                reserved = ledger(before.session_id);
              assert.equal(reserved.negotiation, "running");
              assert.ok(reserved.io_claim);
              assert.equal(reserved.io_kind, "negotiate");
              assert.equal(before.preparation_drained_at, null);
              await subject.client.request(
                `/playback-requests/${body.idempotency_key}`,
                "DELETE",
              );
              const cancelled = ledger(before.session_id);
              assert.equal(cancelled.state, "closing");
              assert.equal(cancelled.play_session_id, null);
              assert.equal(cancelled.closed_at, null);
              fault.hold.release();
              const response = await pending;
              noPlan(response);
              await until(
                () => fault.stop_received,
                "late SID reaches Stop owner",
              );
              const received = ledger(before.session_id);
              assert.equal(received.play_session_id, fault.received.sid);
              assert.equal(received.response_persisted, true);
              assert.equal(received.stop_confirmed, false);
              assert.equal(received.closed_at, null);
              fault.stopHold.release();
              record.terminal = await stopped(before.session_id);
              await drained(body.idempotency_key);
              assert.equal(count(subject), 1);
              assert.equal(contract.sessions.get(fault.received.sid).starts, 0);
              const replay = await prepare(subject, body);
              error(replay, 410, "PLAYBACK_REQUEST_CANCELLED");
              assert.equal(count(subject), 1);
              await unaffected();
            } finally {
              fault.hold.release();
              fault.stopHold.release();
              await pending.catch(() => {});
            }
          },
        );
        await scenario(
          `${kind}: lost HTTP response replays retained preparation without second POST`,
          async (record) => {
            const subject = await setup(kind, "lost response replay"),
              profile = await minted(subject),
              body = subject.body(profile),
              fault = { name: "lost-response", hold: gate() };
            subject.playbackQueue.push(fault);
            const abort = new AbortController(),
              pending = prepare(subject, body, abort.signal).then(
                (value) => ({ value }),
                (cause) => ({ cause }),
              );
            try {
              await until(
                () => fault.received,
                "lost-response PlaybackInfo held",
              );
              abort.abort();
              assert.ok((await pending).cause, "public waiter lost connection");
              fault.hold.release();
              await until(
                () => requestRow(body.idempotency_key)?.status === "completed",
                "independent preparation completes despite disconnect",
              );
              const row = await drained(body.idempotency_key),
                replay = await prepare(subject, body);
              assert.equal(replay.status, 200);
              assert.equal(replay.body.session_id, row.session_id);
              assert.equal(count(subject), 1);
              assert.equal(row.attempt, 1);
              record.retained_session = row.session_id;
              record.playback_posts = 1;
              await closePlan(subject, replay.body);
              await unaffected();
            } finally {
              fault.hold.release();
              await pending;
            }
          },
        );
        await scenario(
          `${kind}: old-login binding and logout during final metadata fail closed`,
          async (record) => {
            const client = f.client();
            await client.login();
            const subject = await setup(
                kind,
                "login-bound metadata",
                "normal",
                client,
              ),
              profile = await minted(subject);
            const otherLogin = f.client();
            await otherLogin.login();
            const old = subject.client;
            subject.client = otherLogin;
            const wrong = await prepare(subject, subject.body(profile));
            error(wrong, 409, "STALE_CAPABILITY_REPORT");
            subject.client = old;
            const body = subject.body(profile),
              fault = { hold: gate() };
            subject.metadataQueue.push(fault);
            const pending = prepare(subject, body);
            try {
              await until(() => fault.received, "logout race metadata held");
              const row = requestRow(body.idempotency_key);
              await client.request("/auth/logout", "POST");
              fault.hold.release();
              const response = await pending;
              error(response, 410, "INVALID_PLAYBACK_SESSION");
              assert.equal(count(subject), 0);
              record.terminal = await stopped(row.session_id, true);
              await drained(body.idempotency_key);
              record.response = safeResponse(response);
              await unaffected();
            } finally {
              fault.hold.release();
              await pending.catch(() => {});
            }
          },
        );
        await scenario(
          `${kind}: completed replay rejects changed login and retains same-login association`,
          async (record) => {
            const client = f.client();
            await client.login();
            const subject = await setup(
                kind,
                "completed login replay",
                "normal",
                client,
              ),
              profile = await minted(subject),
              body = subject.body(profile);
            const original = await prepare(subject, body);
            assert.equal(original.status, 200);
            await drained(body.idempotency_key);
            const same = await prepare(subject, body);
            assert.equal(same.status, 200);
            assert.equal(same.body.session_id, original.body.session_id);
            assert.equal(count(subject), 1);
            const otherLogin = f.client();
            await otherLogin.login();
            subject.client = otherLogin;
            let changed;
            try {
              changed = await prepare(subject, body);
              error(changed, 409, "STALE_PLAYBACK_PLAN");
            } finally {
              subject.client = client;
            }
            const retained = await prepare(subject, body);
            assert.equal(retained.status, 200);
            assert.equal(retained.body.session_id, original.body.session_id);
            assert.equal(count(subject), 1);
            assert.equal(requestRow(body.idempotency_key).attempt, 1);
            assert.equal(
              ledger(original.body.session_id).state,
              "active",
              "rejected report replay does not revoke the separately published grant",
            );
            await closePlan(subject, original.body);
            await unaffected();
            record.changed_login_replay = safeResponse(changed);
            record.playback_posts = 1;
          },
        );
        await scenario(
          `${kind}: source-policy and observed account generation fence old reports`,
          async (record) => {
            const subject = await setup(kind, "policy-bound reports"),
              profile = await minted(subject);
            await admin.request(
              `/sources/${subject.source.id}/access-policy`,
              "POST",
              { expected_revision: 1, policy: allowed },
            );
            const stale = await prepare(subject, subject.body(profile));
            error(stale, 409, "STALE_CAPABILITY_REPORT");
            assert.equal(count(subject), 0);
            const current = await minted(subject),
              beforeGeneration = Number(
                f.sql(
                  `SELECT generation FROM source_account_policies WHERE source_id=${quote(subject.source.id)}`,
                ),
              );
            subject.accountDenied = true;
            await until(
              () =>
                f.sql(
                  `SELECT state FROM source_account_policies WHERE source_id=${quote(subject.source.id)}`,
                ) === "denied",
              "actual account GET publishes denied generation",
            );
            const denied = await prepare(subject, subject.body(current));
            error(denied, 403, "UPSTREAM_POLICY_DENIED");
            assert.equal(count(subject), 0);
            subject.accountDenied = false;
            await until(
              () =>
                f.sql(
                  `SELECT state FROM source_account_policies WHERE source_id=${quote(subject.source.id)}`,
                ) === "allowed",
              "actual account GET restores current account",
            );
            const afterGeneration = Number(
              f.sql(
                `SELECT generation FROM source_account_policies WHERE source_id=${quote(subject.source.id)}`,
              ),
            );
            assert.ok(afterGeneration > beforeGeneration);
            const obsolete = await prepare(subject, subject.body(current));
            error(obsolete, 409, "STALE_CAPABILITY_REPORT");
            assert.equal(count(subject), 0);
            const fresh = await minted(subject),
              recovery = await prepare(subject, subject.body(fresh));
            assert.equal(recovery.status, 200);
            assert.equal(count(subject), 1);
            await closePlan(subject, recovery.body);
            await unaffected();
            record.generations = {
              before: beforeGeneration,
              after: afterGeneration,
            };
            record.current_account_recovered = true;
            record.unrelated_grants_unchanged = true;
          },
        );
        await scenario(
          `${kind}: synthetically expired binding rejects before any final upstream I/O`,
          async (record) => {
            const subject = await setup(kind, "expired binding fixture"),
              profile = await minted(subject),
              body = subject.body(profile);
            body.upstream_profile_report.binding = resealClock(
              profile.binding,
              -1,
            );
            const gets = count(subject, "/Users/fixture-user/Items/fixture"),
              response = await prepare(subject, body);
            error(response, 409, "STALE_CAPABILITY_REPORT");
            assert.equal(count(subject), 0);
            assert.equal(
              count(subject, "/Users/fixture-user/Items/fixture"),
              gets,
            );
            record.clock_fixture =
              "Only issued_at_ms/expires_at_ms resealed with isolated generated key; no five-minute elapsed claim";
            await drained(body.idempotency_key);
            await unaffected();
          },
        );
        await scenario(
          `${kind}: synthetically near-expiry binding is rechecked after contended final source lock`,
          async (record) => {
            const subject = await setup(kind, "expiry final lock fixture"),
              profile = await minted(subject),
              body = subject.body(profile);
            body.upstream_profile_report.binding = resealClock(
              profile.binding,
              1500,
            );
            const fault = { name: "expiry-after-source-lock", hold: gate() };
            subject.playbackQueue.push(fault);
            const pending = prepare(subject, body);
            try {
              await until(
                () => fault.received,
                "PlaybackInfo held for final transaction lock",
              );
              const row = requestRow(body.idempotency_key),
                lock = await lockSource(subject, 2);
              fault.hold.release();
              await until(
                () =>
                  Number(
                    f.sql(
                      "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT access_policy_revision FROM sources%FOR SHARE%'",
                    ),
                  ) > 0,
                "final source authorization actually contends",
              );
              await lock.done;
              const response = await pending;
              error(response, 409, "STALE_CAPABILITY_REPORT");
              assert.equal(count(subject), 1);
              record.terminal = await stopped(row.session_id);
              await drained(body.idempotency_key);
              assert.equal(contract.sessions.get(fault.received.sid).starts, 0);
              assert.equal(
                f.sql(
                  `SELECT count(*) FROM playback_sessions WHERE id=${quote(row.session_id)}`,
                ),
                "0",
              );
              record.clock_fixture =
                "Only binding clock fields resealed; actual final source lock held beyond expiry";
              record.response = safeResponse(response);
              await unaffected();
            } finally {
              fault.hold.release();
              await pending.catch(() => {});
            }
          },
        );
      }
      await scenario(
        "emby: complete canonical discrete-rate probes reject missing extra duplicate unsorted and negative reports before PlaybackInfo",
        async (record) => {
          const subject = await setup("emby", "canonical dual-rate probes", "source-44100"),
            profile = await minted(subject), base = subject.body(profile);
          record.rejections = [];
          for (const [name, mutate] of [
            ["missing complete rate report", (report) => { delete report.audio_rate_reports; }],
            ["empty rate report", (report) => { report.audio_rate_reports = []; }],
            ["missing 44100 probe", (report) => { report.audio_rate_reports.shift(); }],
            ["missing 48000 probe", (report) => { report.audio_rate_reports.pop(); }],
            ["extra 32000 probe", (report) => { report.audio_rate_reports.unshift({ ...report.audio_rate_reports[0], sample_rate: 32000 }); }],
            ["duplicate 44100 probe", (report) => { report.audio_rate_reports[1] = structuredClone(report.audio_rate_reports[0]); }],
            ["unsorted exact set", (report) => { report.audio_rate_reports.reverse(); }],
            ...[0, 1].flatMap((index) => [
              [`negative ${index === 0 ? 44100 : 48000} MSE`, (report) => { report.audio_rate_reports[index].mse_supported = false; }],
              [`negative ${index === 0 ? 44100 : 48000} decoding`, (report) => { report.audio_rate_reports[index].mse_decoding.supported = false; }],
              [`missing ${index === 0 ? 44100 : 48000} decoding`, (report) => { delete report.audio_rate_reports[index].mse_decoding; }],
            ]),
          ]) {
            const body = structuredClone(base); body.idempotency_key = randomUUID(); body.viewer_id = randomUUID();
            mutate(body.upstream_profile_report);
            const rejected = await prepare(subject, body);
            noPlan(rejected);
            error(rejected, 409, "STALE_CAPABILITY_REPORT");
            assert.equal(count(subject), 0, "incomplete rate evidence allocates no PlaybackInfo/SID");
            record.rejections.push({ name, ...safeResponse(rejected) });
          }
          const nullReports = structuredClone(base); nullReports.idempotency_key = randomUUID(); nullReports.viewer_id = randomUUID();
          nullReports.upstream_profile_report.audio_rate_reports = null;
          const invalidNull = await prepare(subject, nullReports);
          noPlan(invalidNull); assert.equal(invalidNull.status, 422, "present null is not an absent or complete rate report");
          assert.equal(count(subject), 0);
          record.rejections.push({ name: "null complete rate report", ...safeResponse(invalidNull) });
          const first = await prepare(subject, base);
          record.positive_response = safeResponse(first);
          record.positive_request = requestRow(base.idempotency_key);
          assert.equal(first.status, 200, "canonical complete reports admit the same source after all negatives");
          assertAudioRateContract(first.body.upstream_profile, "emby", 44100);
          const replay = await prepare(subject, base);
          assert.equal(replay.status, 200); assertExactReplay(replay.body, first.body);
          assert.equal(count(subject), 1);
          await drained(base.idempotency_key); await closePlan(subject, first.body); await unaffected();
          record.canonical_reports = base.upstream_profile_report.audio_rate_reports;
          record.playback_posts = 1;
        },
      );
      await scenario(
        "emby: unknown and other source rates fail before PlaybackInfo without narrowing codec or channel support",
        async (record) => {
          record.rejections = [];
          for (const variant of ["source-unknown", "source-32000", "source-96000"]) {
            const subject = await setup("emby", variant, variant), rejected = await candidates(subject);
            error(rejected, 502, "UPSTREAM_PLAYBACK_FAILED");
            assert.equal(count(subject), 0);
            assert.equal([...contract.sessions.values()].filter((session) => session.tag === subject.tag).length, 0);
            record.rejections.push({ variant, ...safeResponse(rejected) });
          }
          // Both known rates retain the existing AC3/six-channel source support;
          // stereo AAC is an output request, never a new source admission gate.
          for (const variant of ["source-44100", "normal"]) {
            const subject = await setup("emby", variant, variant), profile = await minted(subject),
              body = subject.body(profile), response = await prepare(subject, body);
            assert.equal(response.status, 200);
            assert.equal(decodeProfile(profile.binding).metadata.audio.codec, "ac3");
            assert.equal(decodeProfile(profile.binding).metadata.audio.channels, 6);
            await drained(body.idempotency_key); await closePlan(subject, response.body);
          }
          await unaffected();
        },
      );
      await scenario(
        "emby: independently resealed binding contract metadata selection and version tampering fail before PlaybackInfo",
        async (record) => {
          const subject = await setup("emby", "encrypted complete envelope tamper"),
            profile = await minted(subject), original = decodeProfile(profile.binding), body = subject.body(profile);
          body.upstream_profile_report.binding = sealFixture(original);
          const first = await prepare(subject, body);
          assert.equal(first.status, 200, "unchanged resealed v2 envelope remains admissible before field mutations");
          assert.deepEqual(first.body.upstream_profile, profile.profile);
          await drained(body.idempotency_key);
          const baselinePosts = count(subject); assert.equal(baselinePosts, 1);
          record.unchanged_resealed_binding_admitted = true;
          record.fault_injection = "Each case reseals one changed field with this isolated fixture key; no product credential or source response is rewritten";
          record.rejections = [];
          for (const [name, mutate] of [
            ["missing bound envelope", (proof) => { delete proof.profile_envelope; }],
            ["null bound rate contract", (proof) => { proof.profile_envelope.audio_rate_contract = null; }],
            ["missing bound rate contract", (proof) => { delete proof.profile_envelope.audio_rate_contract; }],
            ["changed allowed set", (proof) => { proof.profile_envelope.audio_rate_contract.allowed_sample_rates = [32000, 48000]; }],
            ["missing allowed rate", (proof) => { proof.profile_envelope.audio_rate_contract.allowed_sample_rates.pop(); }],
            ["unsorted allowed set", (proof) => { proof.profile_envelope.audio_rate_contract.allowed_sample_rates.reverse(); }],
            ["changed bound source rate", (proof) => { proof.profile_envelope.audio_rate_contract.source_sample_rate = 44100; }],
            ["changed bound MSE sample", (proof) => { proof.profile_envelope.audio_rate_contract.mse_samples[0].samplerate = 32000; }],
            ["missing bound MSE sample", (proof) => { proof.profile_envelope.audio_rate_contract.mse_samples.pop(); }],
            ["changed requested rate", (proof) => { proof.profile_envelope.requested_audio.requested_sample_rate = 44100; }],
            ["changed selected metadata rate", (proof) => { proof.metadata.audio.sample_rate = 44100; }],
            ["changed selected audio index", (proof) => { proof.requested_audio = 1; }],
            ["changed binding version", (proof) => { proof.profile_version = 1; }],
            ["changed binding id", (proof) => { proof.profile_id = "avc_sdr_720p_v1"; }],
          ]) {
            const proof = structuredClone(original); mutate(proof);
            const body = subject.body(profile); body.upstream_profile_report.binding = sealFixture(proof);
            const rejected = await prepare(subject, body);
            error(rejected, 409, "STALE_CAPABILITY_REPORT");
            assert.equal(count(subject), baselinePosts, "binding mutation allocates zero new PlaybackInfo/SID");
            record.rejections.push({ name, new_playback_posts: count(subject) - baselinePosts, ...safeResponse(rejected) });
          }
          record.replay_report_rejections = [];
          for (const [name, mutate] of [
            ["missing replay report", (report) => { delete report.audio_rate_reports; }],
            ["negative replay rate", (report) => { report.audio_rate_reports[0].mse_supported = false; }],
            ["changed replay set", (report) => { report.audio_rate_reports[0].sample_rate = 32000; }],
          ]) {
            const replayBody = structuredClone(body); mutate(replayBody.upstream_profile_report);
            const rejected = await prepare(subject, replayBody);
            error(rejected, 409, "STALE_CAPABILITY_REPORT");
            assert.equal(count(subject), 1);
            record.replay_report_rejections.push({ name, ...safeResponse(rejected) });
          }
          const replay = await prepare(subject, body); assert.equal(replay.status, 200);
          assertExactReplay(replay.body, first.body);
          await closePlan(subject, first.body); await unaffected();
        },
      );
      await scenario(
        "emby: stale v1 report cannot admit or replay a v2 discrete-rate profile",
        async (record) => {
          const subject = await setup("emby", "stale Emby v1"), profile = await minted(subject),
            base = subject.body(profile), stale = structuredClone(base);
          stale.viewer_id = randomUUID();
          Object.assign(stale.upstream_profile_report, { profile_version: 1, profile_id: "avc_sdr_720p_v1" });
          delete stale.upstream_profile_report.audio_rate_reports;
          const rejected = await prepare(subject, stale);
          error(rejected, 409, "STALE_CAPABILITY_REPORT");
          assert.equal(count(subject), 0);
          record.admission = safeResponse(rejected);
          const oldDiscovery = await candidates(subject, null, { profile_version: 1 });
          error(oldDiscovery, 409, "STALE_CAPABILITY_REPORT");
          record.discovery = safeResponse(oldDiscovery);
          base.idempotency_key = randomUUID();
          const first = await prepare(subject, base); assert.equal(first.status, 200);
          await drained(base.idempotency_key);
          stale.idempotency_key = base.idempotency_key;
          stale.viewer_id = base.viewer_id;
          const replay = await prepare(subject, stale);
          error(replay, 409, "PLAYBACK_REQUEST_CONFLICT");
          assert.equal(count(subject), 1);
          record.replay = safeResponse(replay);
          const unchanged = await prepare(subject, base);
          assert.equal(unchanged.status, 200); assertExactReplay(unchanged.body, first.body);
          assert.equal(count(subject), 1);
          await closePlan(subject, first.body); await unaffected();
        },
      );
      for (const [explicitSampleRate, genericFrameRate] of [
        [48000, false],
        [48000, true],
        [44100, false],
        [false, true],
      ])
        await scenario(
          `emby: original sample ${explicitSampleRate || "missing"} with ${genericFrameRate ? "generic" : "codec-specific"} frame rate retains provenance`,
          async (record) => {
            const subject = await setup("emby", "same SID provenance variants"),
              profile = await minted(subject),
              body = subject.body(profile);
            subject.playbackQueue.push({
              explicitSampleRate,
              genericFrameRate,
            });
            const first = await prepare(subject, body);
            assert.equal(first.status, 200);
            Object.assign(record, assertOwnedRoute(subject, first.body));
            const replay = await prepare(subject, body);
            assert.equal(replay.status, 200);
            assertExactReplay(replay.body, first.body);
            await drained(body.idempotency_key);
            await closePlan(subject, first.body);
            await unaffected();
          },
        );
      await scenario(
        "emby: isolated completed route and provenance tampering rejects replay without second SID",
        async (record) => {
          const subject = await setup("emby", "replay proof tamper"),
            profile = await minted(subject),
            body = subject.body(profile);
          const first = await prepare(subject, body);
          assert.equal(first.status, 200);
          const id = first.body.session_id;
          await drained(body.idempotency_key);
          Object.assign(record, assertOwnedRoute(subject, first.body));
          const storedResource = read(
            `SELECT resource FROM playback_sessions WHERE id=${quote(id)}`,
          );
          const originalEncrypted = storedResource.encrypted;
          const originalPlan = f.sql(
            `SELECT response_encrypted FROM playback_requests WHERE session_id=${quote(id)}`,
          );
          const originalCheckpoint = f.sql(
            `SELECT response_encrypted FROM upstream_reservations WHERE id=${quote(id)}`,
          );
          const restore = () => {
            f.sql(
              `UPDATE playback_sessions SET resource=jsonb_set(resource,'{encrypted}',to_jsonb(${quote(originalEncrypted)}::text)) WHERE id=${quote(id)}`,
            );
            f.sql(
              `UPDATE playback_requests SET response_encrypted=${quote(originalPlan)} WHERE session_id=${quote(id)}`,
            );
            f.sql(
              `UPDATE upstream_reservations SET response_encrypted=${quote(originalCheckpoint)} WHERE id=${quote(id)}`,
            );
          };
          record.fault_injection =
            "Only this isolated fixture's encrypted resource/plan/checkpoint is resealed for rejection tests; every original value is restored before cleanup";
          record.rejections = [];
          try {
            f.sql(`UPDATE playback_sessions SET resource=jsonb_set(resource,'{encrypted}',to_jsonb(${quote(sealFixture(decodeProfile(originalEncrypted)))}::text)) WHERE id=${quote(id)}`);
            f.sql(`UPDATE playback_requests SET response_encrypted=${quote(sealFixture(decodeProfile(originalPlan)))} WHERE session_id=${quote(id)}`);
            f.sql(`UPDATE upstream_reservations SET response_encrypted=${quote(sealFixture(decodeProfile(originalCheckpoint)))} WHERE id=${quote(id)}`);
            const unchangedReplay = await prepare(subject, body);
            assert.equal(unchangedReplay.status, 200, "unchanged resealed resource plan and checkpoint replay before independent mutations");
            assertExactReplay(unchangedReplay.body, first.body);
            record.unchanged_resealed_replay_admitted = true;
            for (const name of [
              "missing provenance",
              "wrong provenance",
              "changed provenance rate set",
              "changed provenance source rate",
              "changed persisted binding hash",
              "missing sample request",
              "changed frame rate",
              "wrong SID",
              "wrong decision reason",
              "changed plan rate set",
              "changed plan source rate",
              "changed plan MSE rate",
              "changed original checkpoint",
            ]) {
              restore();
              if (name === "changed original checkpoint") {
                const checkpoint = decodeProfile(originalCheckpoint);
                checkpoint.MediaSources[0].TranscodingUrl +=
                  "&AudioSampleRate=48000";
                f.sql(
                  `UPDATE upstream_reservations SET response_encrypted=${quote(sealFixture(checkpoint))} WHERE id=${quote(id)}`,
                );
              } else if (name === "wrong decision reason" || name.startsWith("changed plan")) {
                const plan = decodeProfile(originalPlan);
                if (name === "wrong decision reason") plan.decision_reason = "upstream_transcode";
                if (name === "changed plan rate set") plan.upstream_profile.audio_rate_contract.allowed_sample_rates = [32000, 48000];
                if (name === "changed plan source rate") plan.upstream_profile.audio_rate_contract.source_sample_rate = 44100;
                if (name === "changed plan MSE rate") plan.upstream_profile.audio_rate_contract.mse_samples[0].samplerate = 32000;
                f.sql(
                  `UPDATE playback_requests SET response_encrypted=${quote(sealFixture(plan))} WHERE session_id=${quote(id)}`,
                );
              } else {
                const inner = decodeProfile(originalEncrypted);
                if (name === "missing provenance")
                  delete inner.upstream_profile_route_provenance;
                if (name === "wrong provenance")
                  inner.upstream_profile_route_provenance.provider_audio_sample_rate = 48000;
                if (name === "changed provenance rate set")
                  inner.upstream_profile_route_provenance.allowed_audio_sample_rates = [32000, 48000];
                if (name === "changed provenance source rate")
                  inner.upstream_profile_route_provenance.source_audio_sample_rate = 44100;
                if (name === "changed persisted binding hash")
                  inner.upstream_profile_binding_hash = "0".repeat(64);
                if (name === "missing sample request") {
                  const url = new URL(inner.url);
                  url.searchParams.delete("AudioSampleRate");
                  inner.url = url.href;
                }
                if (name === "changed frame rate") {
                  const url = new URL(inner.url);
                  url.searchParams.set("h264-maxframerate", "60");
                  inner.url = url.href;
                }
                if (name === "wrong SID") {
                  const url = new URL(inner.url);
                  url.searchParams.set("PlaySessionId", "another-sid");
                  inner.url = url.href;
                }
                f.sql(
                  `UPDATE playback_sessions SET resource=jsonb_set(resource,'{encrypted}',to_jsonb(${quote(sealFixture(inner))}::text)) WHERE id=${quote(id)}`,
                );
              }
              const rejected = await prepare(subject, body);
              error(rejected, 409, "STALE_CAPABILITY_REPORT");
              assert.equal(count(subject), 1);
              record.rejections.push({ name, ...safeResponse(rejected) });
            }
          } finally {
            restore();
          }
          const replay = await prepare(subject, body);
          assert.equal(replay.status, 200);
          assertExactReplay(replay.body, first.body);
          await closePlan(subject, first.body);
          await unaffected();
        },
      );
      for (const action of ["source-policy", "account-generation"])
        await scenario(
          `held final metadata rechecks current ${action} before any PlaybackInfo POST`,
          async (record) => {
            const subject = await setup(
                action === "source-policy" ? "emby" : "jellyfin",
                action + " metadata race",
              ),
              profile = await minted(subject),
              body = subject.body(profile),
              fault = { hold: gate() };
            subject.metadataQueue.push(fault);
            const pending = prepare(subject, body);
            try {
              await until(
                () => fault.received,
                action + " final metadata held",
              );
              const row = requestRow(body.idempotency_key);
              assert.equal(ledger(row.session_id).negotiation, "reserved");
              if (action === "source-policy")
                await admin.request(
                  `/sources/${subject.source.id}/access-policy`,
                  "POST",
                  { expected_revision: 1, policy: allowed },
                );
              else {
                subject.accountDenied = true;
                await until(
                  () =>
                    f.sql(
                      `SELECT state FROM source_account_policies WHERE source_id=${quote(subject.source.id)}`,
                    ) === "denied",
                  "held-metadata account denial actually commits",
                );
              }
              assert.equal(count(subject), 0);
              record.invalidated_before_metadata_return = await stopped(
                row.session_id, true,
              );
              fault.hold.release();
              const response = await pending;
              noPlan(response);
              assert.equal(count(subject), 0);
              record.terminal = await stopped(row.session_id, true);
              await drained(body.idempotency_key);
              record.response = safeResponse(response);
              await unaffected();
            } finally {
              fault.hold.release();
              await pending.catch(() => {});
            }
          },
        );
      await scenario(
        "preflight media table contention is bounded and leaves independent API/pool capacity",
        async (record) => {
          const subject = await setup("jellyfin", "preflight bounded database fixture");
          const results = (record.rejections_while_lock_held = []);
          for (let attempt = 0; attempt < 4; attempt++) {
            const fault = { hold: gate() };
            subject.metadataQueue.push(fault);
            const requested = performance.now();
            let settled = false;
            const pending = candidates(subject).then(
              (response) => {
                settled = true;
                return response;
              },
              (cause) => {
                settled = true;
                throw cause;
              },
            );
            pending.catch(() => {});
            const tag = "profile-preflight-table-lock-" + randomUUID();
            let lock;
            try {
              await until(
                () => fault.received,
                "preflight metadata proves auth and durable admission finished",
              );
              // Each admission finishes before its own external table barrier.
              // A single origin has two metadata permits, not four held slots.
              lock = f.sqlProcess(undefined, { interactive: true });
              locks.add(lock);
              let output = "";
              lock.stdout.on("data", (chunk) => {
                output += chunk;
              });
              lock.stdin.write(
                `BEGIN; LOCK TABLE media_items IN ACCESS EXCLUSIVE MODE; SELECT '${tag}';\n`,
              );
              await until(
                () => output.includes(tag),
                "owned media table lock acquired",
              );
              assert.equal(settled, false, "Held metadata has not already failed");
              assert.ok(
                performance.now() - requested < 6000,
                "Held metadata retains its provider timeout budget for the database phase",
              );
              const began = performance.now();
              fault.hold.release();
              const response = await pending;
              const elapsed = performance.now() - began;
              const result = {
                ...safeResponse(response),
                retryable: response.body.error?.retryable,
                elapsed_ms: Math.round(elapsed),
              };
              results.push(result);
              // Preflight's 250 ms lock_timeout raises SQLSTATE 55P03.
              // The Server deliberately exposes lock contention as retryable
              // SERVICE_UNAVAILABLE, rather than an unclassified database fault.
              error(response, 503, "SERVICE_UNAVAILABLE");
              assert.equal(response.body.error.retryable, true);
              assert.equal(response.body.binding, undefined);
              assert.equal(response.body.profile, undefined);
              assert.ok(
                elapsed < 3500,
                attempt === 0
                  ? "held preflight read fails within its database budget"
                  : "repeated bounded preflight does not wait for the external table owner",
              );
              const apiBegan = performance.now();
              const rooms = await admin.request("/rooms");
              result.independent_api_elapsed_ms = Math.round(performance.now() - apiBegan);
              assert.ok(
                Array.isArray(rooms),
                "independent authenticated API remains usable while media lock is held",
              );
              assert.ok(
                result.independent_api_elapsed_ms < 3500,
                "independent authenticated API retains its own bounded pool capacity",
              );
              // The barrier is installed while upstream metadata is held,
              // after the first read. It blocks guard's final SELECT EXISTS, so inspect
              // both preflight media queries rather than only the initial read.
              assert.equal(
                f.sql(
                  "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND (query LIKE 'SELECT m.source_id,m.resource,s.kind,s.config_encrypted,s.access_policy_revision%' OR query LIKE 'SELECT EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id JOIN room_snapshots r ON r.room_id=$1%')",
                ),
                "0",
                "cancelled preflight does not strand its metadata DB query in the pool",
              );
              assert.equal(count(subject), 0);
              lock.stdin.end("COMMIT;\n");
              await lock.done;
              await unaffected();
            } finally {
              fault.hold.release();
              if (lock && lock.exitCode === null) {
                lock.stdin.end("ROLLBACK;\n");
                await lock.done.catch(() => {});
              }
              await pending.catch(() => {});
            }
          }
          await minted(subject);
          assert.equal(count(subject), 0);
          record.preflight_recovers_after_lock_release = true;
          record.independent_authenticated_api_usable = true;
        },
      );
      await scenario(
        "isolated membership removal during final metadata fences report and preserves unrelated grants",
        async (record) => {
          const subject = await setup("jellyfin", "membership metadata race"),
            profile = await minted(subject),
            body = subject.body(profile),
            fault = { hold: gate() };
          subject.metadataQueue.push(fault);
          const pending = prepare(subject, body);
          try {
            await until(() => fault.received, "membership race metadata held");
            const row = requestRow(body.idempotency_key);
            // Public membership deletion is absent. This deletes only the owned
            // test-room member at a documented concurrency fixture boundary.
            f.sql(
              `DELETE FROM room_members WHERE room_id=${quote(subject.room.id)} AND user_id=${quote(user.id)}`,
            );
            fault.hold.release();
            const response = await pending;
            noPlan(response);
            assert.ok([403, 409, 410].includes(response.status));
            assert.equal(count(subject), 0);
            record.terminal = await stopped(row.session_id, true);
            await drained(body.idempotency_key);
            await unaffected();
            record.response = safeResponse(response);
          } finally {
            fault.hold.release();
            await pending.catch(() => {});
          }
        },
      );
      await scenario(
        "all owned active grants close through authenticated API and real Stop receipts",
        async (record) => {
          for (const control of controls)
            await closePlan(control.subject, control.plan);
          const active = read(
            "SELECT COALESCE(json_agg(id),'[]'::json) FROM playback_sessions WHERE NOT stopped",
          );
          for (const id of active) {
            await admin.request(`/playback-sessions/${id}`, "DELETE");
            await stopped(id);
          }
          await until(
            () =>
              f.sql(
                "SELECT count(*) FROM upstream_reservations WHERE state IN ('preparing','active','closing')",
              ) === "0",
            "all owned upstream work terminates",
          );
          await until(
            () =>
              f.sql(
                "SELECT count(*) FROM playback_preparations WHERE drained_at IS NULL",
              ) === "0",
            "all preparation owners record drains",
          );
          assert.equal(
            f.sql("SELECT count(*) FROM playback_sessions WHERE NOT stopped"),
            "0",
          );
          record.active_grants_remaining = 0;
          record.undrained_preparations = 0;
        },
      );
      assert.deepEqual(
        contract.failures,
        [],
        "controlled upstream contract failures",
      );
      for (const controller of controllers) await controller.close();
    },
    { binary: serverBinary.path, env: { PLAYBACK_SESSION_LIMIT: "16" } },
  );
} catch (error) {
  report.failures.push({
    name: "setup or harness",
    error: String(error.stack ?? error),
  });
} finally {
  for (const hold of gates) hold.release();
  for (const lock of locks) if (lock.exitCode === null) lock.kill();
  await Promise.allSettled([...locks].map((lock) => lock.done));
  for (const controller of controllers) await controller.close();
  if (upstream.listening) {
    const closed = new Promise((done) => upstream.close(done));
    upstream.closeAllConnections();
    await closed;
  }
  try {
    if (fixture) report.cleanup.fixture = await fixture.verifyStopped();
    if (upstreamPort) {
      assert.equal(await verifyClosedPort(upstreamPort), true);
      report.cleanup.upstream_port_closed = true;
    }
    await verifyBinding();
    report.backend_source_and_binaries_unchanged = true;
    report.cleanup.completed = Boolean(
      fixture && report.cleanup.upstream_port_closed,
    );
  } catch (error) {
    report.failures.push({
      name: "cleanup or binding",
      error: String(error.stack ?? error),
    });
  }
  report.contract_events = contract.events;
  report.contract_failures = contract.failures;
  report.controlled_sessions = [...contract.sessions.values()].map(
    (session) => ({
      sid: session.sid,
      kind: session.kind,
      tag: session.tag,
      device_id: session.device,
      starts: session.starts,
      stops: session.stops,
      encoding_stops: session.encoding_stops,
    }),
  );
  report.finished_at = new Date().toISOString();
  report.result =
    report.failures.length || contract.failures.length ? "failed" : "passed";
  await save();
  console.log("Evidence: " + reportPath);
  if (report.result !== "passed") process.exitCode = 1;
}
