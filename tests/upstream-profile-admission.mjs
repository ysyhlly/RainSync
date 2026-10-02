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
    "Actual isolated Server/PostgreSQL; generated metadata and controlled loopback Jellyfin/Emby HTTP only. No real fixed product, media decode, Worker or browser acceptance. Synthetic binding clock fixtures are explicitly labeled. Membership deletion is isolated concurrency fault injection; other authorization changes use public APIs or actual account observations.",
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
      SampleRate: 48000,
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
    MaxFramerate: "30",
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
      AudioSampleRate: "48000",
      TranscodingMaxAudioChannels: "2",
    }))
      query.set(name, value);
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
      return json(playbackInfo(subject, sid, body, fault));
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
            profile_version: 1,
            binding: profile.binding,
            profile_id: profile.profile.profile_id,
            mse_supported: true,
            mse_decoding: {
              supported: true,
              smooth: true,
              power_efficient: false,
            },
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
      function resealClock(value, expiresInMs) {
        const proof = decodeProfile(value),
          now = Number(
            f.sql(
              "SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint",
            ),
          );
        proof.issued_at_ms = now - 1000;
        proof.expires_at_ms = now + expiresInMs;
        const nonce = randomBytes(12),
          cipher = createCipheriv(
            "aes-256-gcm",
            Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"),
            nonce,
          );
        return Buffer.concat([
          nonce,
          cipher.update(JSON.stringify(proof)),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString("base64");
      }
      async function candidates(subject, audio = null, overrides = {}) {
        return api(subject.client, "/upstream-profile-candidates", {
          profile_version: 1,
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
        assert.equal(response.body.profile_version, 1);
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
                  value.upstream_profile_report.profile_version = 2;
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
              profile_version: 2,
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
              } else {
                assert.equal(profile.profile.requested_audio.codec, "aac");
                assert.ok(
                  profile.profile.mse_sample.audio.content_type.includes(
                    "mp4a.40.2",
                  ),
                );
              }
              const response = await prepare(subject, body);
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
                record.checkpoint = checkpoint;
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
              error(response, 409, "STALE_CAPABILITY_REPORT");
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
            await client.request("/auth/logout", "POST");
            await client.login();
            const changed = await prepare(subject, body);
            error(changed, 409, "STALE_CAPABILITY_REPORT");
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
              assert.equal(ledger(row.session_id).state, "closing");
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
          const subject = await setup(
              "jellyfin",
              "preflight bounded database fixture",
            ),
            fault = { hold: gate() };
          subject.metadataQueue.push(fault);
          const pending = candidates(subject),
            tag = "profile-preflight-table-lock-" + randomUUID();
          let lock;
          try {
            await until(
              () => fault.received,
              "preflight metadata proves auth and durable admission finished",
            );
            // Own a real table barrier after initial auth/admission. It neither
            // rewrites authorization nor manufactures owner/cleanup receipts.
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
            fault.hold.release();
            const started = performance.now(),
              first = await pending;
            noPlan(first);
            assert.ok(
              performance.now() - started < 3500,
              "held preflight read fails within its database budget",
            );
            const results = [safeResponse(first)];
            for (let attempt = 0; attempt < 3; attempt++) {
              const began = performance.now(),
                response = await candidates(subject);
              noPlan(response);
              const elapsed = performance.now() - began;
              assert.ok(
                elapsed < 3500,
                "repeated bounded preflight does not wait for the external table owner",
              );
              results.push({
                ...safeResponse(response),
                elapsed_ms: Math.round(elapsed),
              });
              const rooms = await admin.request("/rooms");
              assert.ok(
                Array.isArray(rooms),
                "independent authenticated API remains usable while media lock is held",
              );
              assert.equal(
                f.sql(
                  "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT m.source_id,m.resource,s.kind,s.config_encrypted,s.access_policy_revision%'",
                ),
                "0",
                "cancelled preflight does not strand its metadata DB query in the pool",
              );
            }
            assert.equal(count(subject), 0);
            record.rejections_while_lock_held = results;
            record.independent_authenticated_api_usable = true;
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
