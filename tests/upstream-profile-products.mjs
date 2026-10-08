// Bounded fixed-product validation of the explicit upstream profile envelope.
// This script consumes existing frozen binaries. It never builds, installs,
// pulls images, uses existing accounts/databases, or runs a browser. The positive
// MSE report is CONTROLLED browser-estimate evidence; output evidence comes only
// from this grant's actual Worker HLS and a finite local ffprobe/ffmpeg decode.
// Run in authorized ephemeral CI only:
// W03_BACKEND_BINDING=/absolute/binding.json
// RAINSYNC_ARTIFACT_DIR=/absolute/external/artifacts
// RAINSYNC_FFMPEG_BIN=/absolute/existing/bin
// RAINSYNC_NATIVE_POSTGRES_BIN=/absolute/existing/postgresql/bin
// CARGO_TARGET_DIR=/absolute/frozen/target
// node tests/upstream-profile-products.mjs [all|jellyfin|emby]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import WS from "ws";
import { encoderLogSnapshot, collectEncoderLogs } from "./fixtures/upstream-encoder-evidence.mjs";
import { chainEvidence, manifestReferences } from "./fixtures/upstream-profile-chain.mjs";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";
import { delay } from "./fixtures/server.mjs";
import { isolatedUpstreamReal } from "./fixtures/upstream-real.mjs";
import { assertAudioRateContract, assertObservedAudioRate, positiveRateReports, profileVersion } from "./fixtures/upstream-profile-rate-contract.mjs";
import { sameProfileItemMasterPath, profileSubtitleSelectionSupported } from "./fixtures/upstream-profile-route-contract.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digest = async (path) => sha256(await readFile(path));
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const selection = process.argv[2] ?? "all";
assert.equal(process.platform, "linux", "authorized ephemeral Linux CI owns this product/process validation");
assert.ok(["all", "jellyfin", "emby"].includes(selection));
assert.ok(process.argv.length <= 3);
const bindingPath = process.env.RAINSYNC_UPSTREAM_PROFILE_BACKEND_BINDING ??
  process.env.W03_BACKEND_BINDING ?? process.env.RAINSYNC_SOURCE_ACCESS_BINDING_FILE;
assert.ok(bindingPath && isAbsolute(bindingPath), "absolute frozen backend binding required");
const artifactRoot = process.env.RAINSYNC_ARTIFACT_DIR;
assert.ok(artifactRoot && isAbsolute(artifactRoot), "absolute external artifact root required");
assert.ok(relative(repo, artifactRoot).startsWith(".." + sep), "artifacts stay outside the checkout");
assert.ok(process.env.RAINSYNC_FFMPEG_BIN && isAbsolute(process.env.RAINSYNC_FFMPEG_BIN),
  "explicit existing ffmpeg/ffprobe directory required; no installation or download");
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN && isAbsolute(process.env.RAINSYNC_NATIVE_POSTGRES_BIN),
  "existing native PostgreSQL required; never fall back to a PostgreSQL Docker pull");
const bindingBytes = await readFile(bindingPath);
const binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.equal(sha256(JSON.stringify(binding.source)), binding.source_digest);
assert.equal(binding.binaries.length, 3);
for (const path of ["apps/server/src/upstream_profiles.rs", "crates/providers/src/upstream_profiles.rs",
  "crates/protocol/src/upstream_profiles.rs", "migrations/0033_upstream_account_policy.sql"])
  assert.ok(binding.source.some((entry) => entry.path === path), "profile and policy sources are bound");
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
for (const name of ["rainsync-server", "rainsync-media-worker", "rainsync-nas-agent"])
  assert.equal(resolve(binding.binaries.find((entry) => entry.name === name)?.path ?? "missing"),
    resolve(target, name + (process.platform === "win32" ? ".exe" : "")), "frozen binary location");
const coordinator = await Promise.all([
  "tests/upstream-profile-products.mjs", "tests/fixtures/upstream-real.mjs",
  "tests/fixtures/upstream-profile-rate-contract.mjs",
  "tests/fixtures/upstream-storage.mjs",
  "tests/fixtures/upstream-profile-route-contract.mjs", "tests/fixtures/upstream-profile-chain.mjs",
  "tests/fixtures/upstream-encoder-evidence.mjs",
  "tests/fixtures/media-stack.mjs", "tests/fixtures/server.mjs", "tests/fixtures/postgres.mjs",
].map(async (path) => ({ path, sha256: await digest(resolve(repo, path)) })));
const nodeRuntime = { version: process.version, path: process.execPath, sha256: await digest(process.execPath) };
const postgresTools = await Promise.all(["initdb", "postgres", "pg_ctl", "psql"].map(async (name) => {
  const path = resolve(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, name);
  return { name, path, sha256: await digest(path) };
}));
async function verifyBinding() {
  assert.equal(await digest(bindingPath), sha256(bindingBytes), "frozen binding unchanged");
  for (const input of [...binding.source, ...coordinator]) {
    assert.ok(!isAbsolute(input.path) && !relative(repo, resolve(repo, input.path)).startsWith(".."),
      "bound source path belongs to this checkout");
    assert.match(input.sha256, /^[0-9a-f]{64}$/);
    assert.equal(await digest(resolve(repo, input.path)), input.sha256, `bound source unchanged: ${input.path}`);
  }
  for (const binary of binding.binaries)
    assert.equal(await digest(binary.path), binary.sha256, `bound binary unchanged: ${binary.name}`);
  for (const helper of binding.test_helpers ?? [])
    assert.equal(await digest(helper.path), helper.sha256, `bound test binary unchanged: ${helper.name}`);
  if (binding.producer)
    assert.equal(await digest(resolve(repo, binding.producer.path)), binding.producer.sha256, "binding producer unchanged");
  if (binding.build.log_path)
    assert.equal(await digest(binding.build.log_path), binding.build.log_sha256, "successful frozen build log unchanged");
  assert.equal(await digest(nodeRuntime.path), nodeRuntime.sha256, "recorded Node interpreter unchanged");
  for (const entry of postgresTools)
    assert.equal(await digest(entry.path), entry.sha256, `recorded native PostgreSQL tool unchanged: ${entry.name}`);
}
await verifyBinding();

const pinned = {
  jellyfin: { version: "10.11.0", image: "jellyfin/jellyfin@sha256:59417f441213e236a9f907d4e71a13472042409d85f9e9310dbdd87ee33d7bd4" },
  emby: { version: "4.10.0.40", image: "emby/embyserver@sha256:3aafff933d3f28d23ed0bc201022abe71c0aa80deb17177566c726b9bbc686c6" },
};
const expectedVideo = { codec: "h264", profile: "main", max_level: "3.1", max_width: 1280,
  max_height: 720, max_framerate: 30, max_bitrate: 4000000, requested_bit_depth: 8, requested_range: "SDR" };
const expectedAudio = { codec: "aac", max_channels: 2, requested_sample_rate: 48000, max_bitrate: 128000 };
const productCases = [{ name: "h264-default-zero", title: "rainsync-h264", position_ms: 0, track: 0, audio_hz: 440, source_rate: 44100, source_codec: "aac", source_channels: 1 },
        { name: "hevc-default-seek", title: "rainsync-hevc", position_ms: 10000, track: 0, audio_hz: 440, source_rate: 44100, source_codec: "aac", source_channels: 1 },
        { name: "hevc-alternate-seek", title: "rainsync-hevc", position_ms: 27000, track: 1, audio_hz: 880, source_rate: 44100, source_codec: "aac", source_channels: 1 },
        { name: "h264-48k-stereo-aac-zero", title: "rainsync-h264-48k-stereo-aac", position_ms: 0, track: 0, audio_hz: 440, source_rate: 48000, source_codec: "aac", source_channels: 2 },
        { name: "h264-44k-stereo-ac3-seek", title: "rainsync-h264-44k-stereo-ac3", position_ms: 10000, track: 0, audio_hz: 440, source_rate: 44100, source_codec: "ac3", source_channels: 2 },
        { name: "h264-48k-stereo-ac3-seek", title: "rainsync-h264-48k-stereo-ac3", position_ms: 27000, track: 0, audio_hz: 440, source_rate: 48000, source_codec: "ac3", source_channels: 2 }];
const runId = randomUUID();
const root = resolve(artifactRoot, "upstream-profile-products", runId);
// Fixtures containing credentials are separate from the uploadable evidence.
const ownedRoot = resolve(artifactRoot, "upstream-profile-products-owned", runId);
await mkdir(root, { recursive: true });
await mkdir(ownedRoot, { recursive: true });
const reportPath = resolve(root, "report.json");
const secrets = new Set();
const redact = (value) => {
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    if (secret) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/(?:https?|wss?|postgres(?:ql)?):\/\/[^\s\"'<>]+/gi, "[redacted-url]")
    .replace(/((?:api[_-]?key|token|access[_-]?token|password|csrf|url)=)[^&\s\"']+/gi, "$1[redacted]");
};
const report = {
  schema_version: 1, run_id: runId, started_at: new Date().toISOString(), result: "running", selection,
  scope: "Actual RainSync preflight and dedicated explicit-transcode prepare against fixed disposable products, actual Worker-delivered HLS, finite native decode. Browser estimate is controlled, not browser execution or whole-title output proof. Raw upstream policy semantics remain in upstream-real-contracts.mjs.",
  browser_estimate: { controlled: true, mse_supported: true,
    mse_decoding: { supported: true, smooth: false, power_efficient: false } },
  limits: { request_ms: 20000, probe_decode_ms: 15000, stop_ms: 15000, cleanup_grace_ms: 10000,
    stack_startup_ms: 180000, stack_matrix_ms: 900000,
    max_segments_per_window: 3, total_read_budget_per_window_bytes: 25 * 1024 * 1024,
    manifest_bytes: 256 * 1024, segment_bytes: 8 * 1024 * 1024, initialization_bytes: 1024 * 1024 },
  interpretation: {
    bitrate: "Recipe/request bounds verified. Finite-window rate may be recorded as an observation; instantaneous packet rate is not guaranteed by requested bitrate bounds.",
    aac: "AAC family is requested. Observed AAC profile is recorded; the advisory AAC-LC MSE sample is not an enforced AAC profile.",
    audio_rate: "Jellyfin v1 output must equal 48000. Emby v2 output must be a member of the exact discrete set [44100,48000]; requested 48000 and original route/encoder evidence remain independently recorded. No lower-rate ceiling or prior-failure rewrite.",
  },
  backend_binding: { sha256: sha256(bindingBytes), source_digest: binding.source_digest,
    binaries: binding.binaries.map(({ name, path, sha256 }) => ({ name, path, sha256 })) },
  coordinator, node_runtime: nodeRuntime, native_postgres_tools: postgresTools,
  products: [], failures: [], decode_processes: [],
};
const save = () => writeFile(reportPath, redact(JSON.stringify(report, null, 2)) + "\n");
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw Error(`deadline: ${label}`);
}
async function bounded(promise, label, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`deadline: ${label}`)), ms);
  })]); } finally { clearTimeout(timer); }
}
async function absent(path) {
  try { await stat(path); return false; } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}
function sidHash(value) { return typeof value === "string" && value ? sha256(value) : null; }

// Failure before the media-stack callback must still have a process deadline.
// Identify only postmasters in this run's freshly minted directory. Verify the
// actual process command before signaling it; never trust a stale PID alone.
async function killOwnedStack(fixture, product, reason) {
  const killed = [], errors = [];
  const kill = (kind, pid) => {
    try { process.kill(pid, "SIGKILL"); killed.push({ kind, pid }); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  for (const [kind, pid] of [["server", fixture?.serverPid], ["worker", fixture?.workerPid]]) {
    try {
      if (!pid || verifyPidAbsent(pid)) continue;
      const bytes = await readFile(`/proc/${pid}/environ`).catch((error) => {
        if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error;
      });
      if (!bytes?.length) continue; // Exiting processes may have an empty /proc entry.
      const environment = bytes.toString("utf8").split("\0");
      assert.ok(environment.includes(`MEDIA_ROOT=${fixture.root}`), "deadline only signals this fixture's process");
      kill(kind, pid);
    } catch (error) { errors.push({ kind, pid, error: redact(error.message) }); }
  }
  const directory = resolve(ownedRoot, "stack");
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  for (const entry of entries) {
    try {
      assert.ok(entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name));
      const data = resolve(directory, entry.name, "postgres");
      const pidFile = await readFile(resolve(data, "postmaster.pid"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return null; throw error;
      });
      if (!pidFile) continue;
      const [rawPid, actualData] = pidFile.split(/\r?\n/);
      assert.match(rawPid, /^\d+$/); assert.equal(actualData, data);
      const pid = Number(rawPid); assert.ok(pid > 1);
      if (verifyPidAbsent(pid)) continue;
      const command = await readFile(`/proc/${pid}/cmdline`).catch((error) => {
        if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error;
      });
      if (!command?.length) continue;
      const argv = command.toString("utf8").split("\0");
      assert.equal(argv[0], resolve(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, "postgres"));
      assert.equal(argv[argv.indexOf("-D") + 1], data, "deadline only signals this minted native PostgreSQL cluster");
      kill("postgres", pid);
    } catch (error) { errors.push({ kind: "postgres", fixture: entry.name, error: redact(error.message) }); }
  }
  (product.process_deadlines ??= []).push({ reason, killed, errors });
  if (errors.length) throw Error("owned process deadline could not verify every target; independent remaining targets were still checked");
}

// Read limits are checked BEFORE the read, including Content-Length and every
// streamed chunk. No unbounded arrayBuffer() or post-download budget assertion.
async function limitedBody(response, cap, budget = { remaining: cap }) {
  const allowed = Math.min(cap, budget.remaining);
  assert.ok(allowed > 0, "positive read budget before opening the response body");
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    assert.match(declared, /^\d+$/);
    if (Number(declared) > allowed) {
      await response.body?.cancel();
      throw Error("declared response exceeds the remaining pre-read budget");
    }
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (length + next.value.byteLength > allowed) throw Error("streamed response exceeds the remaining pre-read budget");
      length += next.value.byteLength;
      budget.remaining -= next.value.byteLength;
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

const queryFields = ["videocodec", "audiocodec", "allowvideostreamcopy", "allowaudiostreamcopy",
  "allowinterlacedvideostreamcopy", "enableautostreamcopy", "static", "maxwidth", "maxheight", "width", "height",
  "maxframerate", "h264-maxframerate", "framerate", "videobitrate", "h264-level", "h264-profile", "h264-rangetype", "h264-videorange",
  "level", "profile", "videorange", "videostreamindex", "audiostreamindex", "audiobitrate", "audiosamplerate",
  "transcodingmaxaudiochannels", "maxaudiochannels", "audiochannels", "aac-audiochannels", "subtitlestreamindex", "subtitlemethod"];
function routeEvidence(value, expected, upstream) {
  if (typeof value !== "string" || !value) return { present: false, fields: Object.fromEntries(queryFields.map((key) => [key, null])) };
  const base = new URL(upstream.base + "/");
  const path = value.startsWith("/") && !value.startsWith("//") && !value.startsWith(base.pathname)
    ? value.slice(1) : value;
  let url;
  try { url = new URL(path, base); } catch { return { present: true, valid_url: false }; }
  const query = new Map();
  for (const [key, value] of url.searchParams) {
    const normalized = key.toLowerCase();
    const values = query.get(normalized) ?? [];
    values.push(value); query.set(normalized, values);
  }
  return {
    present: true, valid_url: true, same_owned_origin: url.origin === base.origin,
    owned_base_path: url.pathname.startsWith(base.pathname),
    exact_item_master_path: url.pathname.toLowerCase() === `${base.pathname}videos/${expected.item}/master.m3u8`.toLowerCase(),
    same_item_master_path: sameProfileItemMasterPath(upstream.kind, base.pathname, expected.item, url.pathname),
    query_keys: [...query.keys()].sort(), duplicate_keys: [...query].filter(([, values]) => values.length > 1).map(([key]) => key),
    fields: Object.fromEntries(queryFields.map((key) => [key, query.get(key)?.map((value) =>
      /^[A-Za-z0-9.,_-]{1,80}$/.test(value) ? value : "[unrecognized-value]") ?? null])),
    media_source_matches: query.get("mediasourceid")?.length === 1 && query.get("mediasourceid")[0] === expected.source,
    play_session_matches: query.get("playsessionid")?.length === 1 && query.get("playsessionid")[0] === expected.sid,
    fragment_present: Boolean(url.hash),
  };
}
function streamFields(stream) {
  return Object.fromEntries(["Type", "Index", "Codec", "Profile", "Level", "Width", "Height", "BitDepth", "VideoRange",
    "VideoRangeType", "ColorTransfer", "RealFrameRate", "AverageFrameRate", "Channels", "SampleRate", "BitRate", "IsExternal"]
    .map((key) => [key, stream?.[key] ?? null]));
}
function requestedRecipe(body) {
  return Object.fromEntries(["EnableDirectPlay", "EnableDirectStream", "EnableTranscoding", "AllowVideoStreamCopy",
    "AllowAudioStreamCopy", "AllowInterlacedVideoStreamCopy", "MaxAudioChannels", "MaxStreamingBitrate", "StartTimeTicks",
    "AudioStreamIndex", "SubtitleStreamIndex", "DeviceProfile"].map((key) => [key, body?.[key] ?? null]));
}
function recipeChecks(request, kind) {
  const checks = [];
  const equals = (field, actual, expected) => checks.push({ field, observed: actual ?? null,
    expected, passed: isDeepStrictEqual(actual, expected) });
  for (const [field, value] of Object.entries({ EnableDirectPlay: false, EnableDirectStream: false, EnableTranscoding: true,
    AllowVideoStreamCopy: false, AllowAudioStreamCopy: false, AllowInterlacedVideoStreamCopy: false,
    MaxAudioChannels: 2, MaxStreamingBitrate: 4128000, SubtitleStreamIndex: -1 }))
    equals(field, request[field], value);
  const profile = request.DeviceProfile;
  equals("DeviceProfile.MaxStreamingBitrate", profile?.MaxStreamingBitrate, 4128000);
  equals("DeviceProfile.DirectPlayProfiles", profile?.DirectPlayProfiles, []);
  equals("DeviceProfile.TranscodingProfiles.length", profile?.TranscodingProfiles?.length, 1);
  const transcode = profile?.TranscodingProfiles?.[0];
  for (const [field, value] of Object.entries({ Container: "ts", Type: "Video", Protocol: "hls", VideoCodec: "h264",
    AudioCodec: "aac", Context: "Streaming", MaxAudioChannels: "2", EnableAudioVbrEncoding: false,
    AllowInterlacedVideoStreamCopy: false, ...(kind === "emby" ? { MaxWidth: 1280, MaxHeight: 720 } : {}) }))
    equals(`DeviceProfile.TranscodingProfiles[0].${field}`, transcode?.[field], value);
  const expected = [
    ["Video", "h264", "Width", "LessThanEqual", "1280"], ["Video", "h264", "Height", "LessThanEqual", "720"],
    ["Video", "h264", "VideoFramerate", "LessThanEqual", "30"], ["Video", "h264", "VideoBitrate", "LessThanEqual", "4000000"],
    ["Video", "h264", "VideoLevel", "LessThanEqual", "31"], ["Video", "h264", "VideoProfile", "Equals", "main"],
    ["Video", "h264", "VideoBitDepth", "LessThanEqual", "8"],
    ["Video", "h264", kind === "jellyfin" ? "VideoRangeType" : "VideoRange", "Equals", "SDR"],
    ["VideoAudio", "aac", "AudioChannels", "LessThanEqual", "2"],
    ["VideoAudio", "aac", "AudioSampleRate", "Equals", "48000"], ["VideoAudio", "aac", "AudioBitrate", "LessThanEqual", "128000"],
  ];
  for (const [type, codec, property, condition, value] of expected) {
    const codecs = profile?.CodecProfiles?.filter((entry) => entry.Type === type && entry.Codec === codec) ?? [];
    const conditions = codecs.length === 1 ? codecs[0].Conditions?.filter((entry) => entry.Property === property) ?? [] : [];
    equals(`DeviceProfile.${codec}.${property}`, conditions, [{ Property: property, Condition: condition, Value: value, IsRequired: true }]);
  }
  return checks;
}
function routeChecks(route, kind, audioIndex, originalResponse = false) {
  const checks = [], fields = route?.fields ?? {};
  const one = (key) => fields[key]?.length === 1 ? fields[key][0] : null;
  const exact = (key, expected) => checks.push({ field: key, observed: fields[key] ?? null, expected,
    passed: typeof one(key) === "string" && one(key).toLowerCase() === String(expected).toLowerCase() });
  const max = (key, limit) => { const value = Number(one(key)); checks.push({ field: key,
    observed: fields[key] ?? null, expected: `positive and <= ${limit}`, passed: one(key) !== null && Number.isFinite(value) && value > 0 && value <= limit }); };
  const flag = (field, observed, expected = true) => checks.push({ field, observed: observed ?? null, expected, passed: observed === expected });
  flag("route.present", route?.present); flag("route.valid_url", route?.valid_url);
  flag("route.same_owned_origin", route?.same_owned_origin); flag("route.same_item_master_path", route?.same_item_master_path);
  flag("route.media_source_matches", route?.media_source_matches); flag("route.play_session_matches", route?.play_session_matches);
  flag("route.fragment_present", route?.fragment_present, false);
  checks.push({ field: "route.duplicate_keys", observed: route?.duplicate_keys ?? null, expected: [], passed: route?.duplicate_keys?.length === 0 });
  const codecs = one("videocodec")?.split(",") ?? [];
  checks.push({ field: "videocodec", observed: fields.videocodec ?? null, expected: "only h264",
    passed: codecs.length > 0 && codecs.length <= 4 && codecs.every((codec) => codec.toLowerCase() === "h264") });
  exact("allowvideostreamcopy", "false"); exact("allowaudiostreamcopy", "false");
  for (const key of ["allowinterlacedvideostreamcopy", "enableautostreamcopy", "static"])
    if (fields[key]) exact(key, "false");
  for (const [key, limit] of [["maxwidth", 1280], ["maxheight", 720], ["videobitrate", 4000000]]) max(key, limit);
  const frameField = kind === "emby" && fields["h264-maxframerate"] ? "h264-maxframerate" : "maxframerate";
  max(frameField, 30);
  checks.push({ field: "frame_rate_namespace", observed: [fields.maxframerate ?? null, fields["h264-maxframerate"] ?? null],
    expected: "exactly one provider-supported frame-rate field", passed: kind === "emby"
      ? Boolean(fields.maxframerate) !== Boolean(fields["h264-maxframerate"])
      : Boolean(fields.maxframerate) && fields["h264-maxframerate"] == null });
  for (const [key, limit] of [["width", 1280], ["height", 720], ["framerate", 30]]) if (fields[key]) max(key, limit);
  if (kind === "jellyfin") {
    for (const key of ["level", "profile", "videorange"])
      checks.push({ field: key, observed: fields[key] ?? null, expected: null, passed: fields[key] == null });
    max("h264-level", 31); exact("h264-profile", "main"); exact("h264-rangetype", "SDR");
  } else {
    for (const [primary, alias] of [["h264-level", "level"], ["h264-profile", "profile"], ["h264-videorange", "videorange"]])
      checks.push({ field: `${primary}/${alias}`, observed: [fields[primary] ?? null, fields[alias] ?? null],
        expected: "one product-specific namespace", passed: !(fields[primary] && fields[alias]) });
    const level = fields["h264-level"] ? "h264-level" : "level";
    max(level, level === "level" ? 3.1 : 31);
    exact(fields["h264-profile"] ? "h264-profile" : "profile", "main");
    exact(fields["h264-videorange"] ? "h264-videorange" : "videorange", "SDR");
  }
  exact("audiostreamindex", audioIndex); exact("audiocodec", "aac"); max("audiobitrate", 128000);
  if (kind === "emby" && originalResponse && fields.audiosamplerate == null)
    checks.push({ field: "audiosamplerate", observed: null,
      expected: "absent in provider response; requires separately proven same-SID server request", passed: true });
  else if (kind === "emby") checks.push({ field: "audiosamplerate", observed: fields.audiosamplerate ?? null,
    expected: "exactly 44100 or 48000", passed: ["44100", "48000"].includes(one("audiosamplerate")) });
  else exact("audiosamplerate", "48000");
  max(fields.transcodingmaxaudiochannels ? "transcodingmaxaudiochannels" : "maxaudiochannels", 2);
  for (const key of ["audiochannels", "aac-audiochannels", "maxaudiochannels", "transcodingmaxaudiochannels"])
    if (fields[key]) max(key, 2);
  if (fields.subtitlestreamindex) exact("subtitlestreamindex", "-1");
  checks.push({ field: "subtitle_selection", observed: { index: fields.subtitlestreamindex ?? null, method: fields.subtitlemethod ?? null },
    expected: "no selected subtitle; Jellyfin Encode without an index is inert", passed: profileSubtitleSelectionSupported(kind, fields) });
  return checks;
}
function assertChecks(checks, label) {
  const rejected = checks.filter((entry) => !entry.passed).map((entry) => entry.field);
  assert.equal(rejected.length, 0, `${label}: missing/rejected actual fields: ${rejected.join(", ")}`);
}

// Transparent recorder: it changes only the owned source's destination before
// creation. It never alters PlaybackInfo bodies, route fields, policy or media.
async function recorder(upstream, product) {
  const prefix = new URL(upstream.base).pathname.replace(/\/$/, "");
  const negotiations = [], reads = [], stops = [], failures = [], mediaRequests = [], originalResponses = new Map();
  const chain = [], referenced = new Map();
  const recordChain = (entry) => {
    assert.ok(chain.length < 512, "bounded product chain observations"); chain.push(entry);
  };
  const controllers = new Set(), pending = new Set(), sockets = new Set();
  const server = createServer((incoming, outgoing) => {
    const work = (async () => {
      const control = new AbortController(); controllers.add(control);
      const timer = setTimeout(() => control.abort(), 20000);
      outgoing.once("close", () => control.abort());
      try {
        const url = new URL(incoming.url, upstream.origin);
        assert.equal(url.origin, upstream.origin, "recorder only contacts its owned product");
        assert.ok(!url.username && !url.password && url.pathname.startsWith(prefix + "/"));
        const path = url.pathname.slice(prefix.length);
        const chunks = []; let length = 0;
        for await (const chunk of incoming) {
          length += chunk.length; assert.ok(length <= 1024 * 1024, "bounded proxy request body");
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        const headers = { ...incoming.headers, "accept-encoding": "identity" };
        for (const key of ["host", "connection", "content-length"]) delete headers[key];
        const negotiation = incoming.method === "POST" && /^\/Items\/[^/]+\/PlaybackInfo$/.test(path);
        const metadata = incoming.method === "GET" && /^\/Users\/[^/]+\/Items\/[^/]+$/.test(path);
        const mediaMaster = incoming.method === "GET" && /^\/Videos\/[^/]+\/master\.m3u8$/i.test(path);
        if (mediaMaster) {
          const query = new Map([...url.searchParams].map(([key, value]) => [key.toLowerCase(), value]));
          const sid = query.get("playsessionid"), original = originalResponses.get(sid);
          assert.ok(original, "actual Worker master read belongs to one previously negotiated SID");
          mediaRequests.push({ sid_hash: sidHash(sid), device_hash: sidHash(query.get("deviceid")),
            path_and_query_sha256: sha256(url.pathname + url.search),
            route: routeEvidence(url.href, { item: original.item, source: original.source, sid }, upstream) });
        }
        const query = new Map([...url.searchParams].map(([key, value]) => [key.toLowerCase(), value]));
        const sid = query.get("playsessionid"), negotiated = originalResponses.get(sid);
        const inherited = referenced.get(sha256(url.href));
        const expected = inherited?.expected ?? (negotiated ? { sid, source: negotiated.source, device: negotiated.device } : undefined);
        const isMedia = incoming.method === "GET" && (mediaMaster || Boolean(inherited));
        const chainRequest = isMedia ? { boundary: "outbound_request", parent_url_sha256: inherited?.parent ?? null,
          ...chainEvidence(url.href, upstream.base, expected), requested_at_ms: Date.now(), status: null } : null;
        if (chainRequest) recordChain(chainRequest);
        const stopping = (incoming.method === "POST" && path === "/Sessions/Playing/Stopped") ||
          (incoming.method === "DELETE" && path === "/Videos/ActiveEncodings");
        const body = bytes.length && (negotiation || stopping) ? JSON.parse(bytes) : {};
        const deviceId = /DeviceId="([^"]+)"/.exec(headers.authorization ?? headers["x-emby-authorization"] ?? "")?.[1];
        const event = negotiation ? { post_index: negotiations.length + 1, requested_at_ms: Date.now(),
          device_hash: sidHash(deviceId), request: requestedRecipe(body), request_source_hash: sidHash(body.MediaSourceId),
          status: null, response: null } : stopping ? { kind: path === "/Videos/ActiveEncodings" ? "encoding" : "playing",
          sid_hash: sidHash(body.PlaySessionId ?? url.searchParams.get("PlaySessionId")), device_hash: sidHash(deviceId), status: null } : null;
        if (negotiation) negotiations.push(event);
        if (stopping) stops.push(event);
        const response = await fetch(url, { method: incoming.method, headers, body: bytes.length ? bytes : undefined,
          redirect: "manual", signal: control.signal });
        if (event) event.status = response.status;
        if (chainRequest) chainRequest.status = response.status;
        assert.ok(response.status < 300 || response.status >= 400, "owned product redirect is not followed");
        const forwarded = Object.fromEntries(response.headers);
        for (const key of ["transfer-encoding", "connection", "content-encoding"]) delete forwarded[key];
        if (negotiation || metadata || stopping) {
          const data = await limitedBody(response, 2 * 1024 * 1024);
          let value = null;
          try { value = data.length ? JSON.parse(data) : null; } catch {}
          if (negotiation) {
            const sources = value?.MediaSources;
            if (value?.PlaySessionId) originalResponses.set(value.PlaySessionId, {
              item: path.split("/")[2], source: body.MediaSourceId, device: deviceId, info: structuredClone(value),
            });
            event.response = { error_code: value?.ErrorCode ?? null, sid_present: Boolean(value?.PlaySessionId),
              sid_hash: sidHash(value?.PlaySessionId), source_count: Array.isArray(sources) ? sources.length : null,
              sources: (Array.isArray(sources) ? sources.slice(0, 4) : []).map((source) => ({
                source_hash: sidHash(source.Id), default_audio_index: source.DefaultAudioStreamIndex ?? null,
                supports_transcoding: source.SupportsTranscoding ?? null, transcoding_subprotocol: source.TranscodingSubProtocol ?? null,
                transcoding_container: source.TranscodingContainer ?? null,
                streams: (source.MediaStreams ?? []).slice(0, 64).map(streamFields),
                route: routeEvidence(source.TranscodingUrl, { item: path.split("/")[2], source: body.MediaSourceId, sid: value?.PlaySessionId }, upstream),
              })) };
          }
          if (metadata) reads.push({ status: response.status, item_hash: sidHash(value?.Id),
            source_count: value?.MediaSources?.length ?? null,
            sources: (value?.MediaSources ?? []).slice(0, 4).map((source) => ({ source_hash: sidHash(source.Id),
              default_audio_index: source.DefaultAudioStreamIndex ?? null, streams: (source.MediaStreams ?? []).slice(0, 64).map(streamFields) })) });
          delete forwarded["content-length"];
          outgoing.writeHead(response.status, forwarded).end(data);
        } else if (isMedia && /\.m3u8$/i.test(url.pathname)) {
          const data = await limitedBody(response, 256 * 1024);
          const parent = sha256(url.href);
          if (response.ok) for (const reference of manifestReferences(data.toString("utf8"))) {
            const evidence = chainEvidence(reference, url.href, expected);
            recordChain({ boundary: "returned_reference", parent_url_sha256: parent, ...evidence });
            if (evidence.valid_url) {
              assert.ok(referenced.size < 256 || referenced.has(evidence.url_sha256), "bounded referenced product URLs");
              referenced.set(evidence.url_sha256, { expected, parent });
            }
          }
          // Preserve the upstream bytes, including every child URI and query.
          outgoing.writeHead(response.status, forwarded).end(data);
        } else {
          outgoing.writeHead(response.status, forwarded);
          const reader = response.body?.getReader();
          if (reader) {
            let length = 0;
            try {
              while (true) {
                const next = await reader.read(); if (next.done) break;
                length += next.value.byteLength; assert.ok(length <= 25 * 1024 * 1024, "bounded forwarded product resource");
                if (!outgoing.write(Buffer.from(next.value)))
                  await bounded(new Promise((done, reject) => {
                    outgoing.once("drain", done); outgoing.once("close", () => reject(Error("owned downstream closed")));
                  }), "proxy backpressure", 20000);
              }
            } catch (error) { await reader.cancel().catch(() => {}); throw error; }
            finally { reader.releaseLock(); }
          }
          outgoing.end();
        }
      } catch (error) {
        // Normal downstream cancellation is owned and expected during Stop.
        if (!control.signal.aborted) failures.push(redact(error.message));
        if (!outgoing.headersSent) outgoing.writeHead(502).end(); else outgoing.destroy();
      } finally { clearTimeout(timer); controllers.delete(control); }
    })();
    pending.add(work); work.finally(() => pending.delete(work));
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  product.recorder = { negotiations, metadata_reads: reads, stops, media_requests: mediaRequests, media_chain: chain, failures, port };
  return { negotiations, reads, stops, mediaRequests,
    originalResponse(sid) { return originalResponses.get(sid)?.info; },
    async source(client, upstreamClient) {
      return upstream.addRainSyncSource({ request(path, method, body) {
        assert.equal(path, "/sources"); assert.equal(method, "POST");
        secrets.add(body.config.token);
        return client.request(path, method, { ...body, config: { ...body.config, url: origin + prefix,
          access_policy: { schema_version: 1, origins: [{ origin, cidrs: ["127.0.0.1/32"] }] } } });
      } }, upstreamClient);
    },
    async close() {
      for (const controller of controllers) controller.abort();
      const closed = new Promise((done) => server.close(done));
      server.closeAllConnections(); for (const socket of sockets) socket.destroy();
      await bounded(Promise.all([closed, ...pending]), "owned recorder closes", 25000);
      assert.equal(pending.size, 0); assert.equal(sockets.size, 0);
      assert.equal(await verifyClosedPort(port), true);
      product.recorder.port_closed = true;
      assert.deepEqual(failures, [], "transparent recorder had no unexplained failures");
    },
  };
}

class Controller {
  constructor(fixture, client) { this.fixture = fixture; this.client = client; this.inbox = []; }
  async message(check) { return until(() => {
    const index = this.inbox.findIndex(check);
    return index < 0 ? null : this.inbox.splice(index, 1)[0];
  }, "room WebSocket response"); }
  async join(room) {
    this.room = room;
    this.socket = new WS(this.fixture.origin.replace("http", "ws") + "/api/v1/ws",
      { headers: { Origin: this.fixture.origin, Cookie: this.client.cookie }, handshakeTimeout: 5000 });
    this.socket.on("message", (bytes) => this.inbox.push(JSON.parse(bytes)));
    await bounded(new Promise((done, reject) => { this.socket.once("open", done); this.socket.once("error", reject); }), "room WebSocket opens", 6000);
    this.socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    const snapshot = await this.message((entry) => entry.type === "SNAPSHOT");
    this.state = snapshot.state; this.epoch = snapshot.control_epoch.id;
  }
  async media(mediaId) {
    const commandId = randomUUID();
    this.socket.send(JSON.stringify({ protocol_version: 1, room_id: this.room.id, control_epoch: this.epoch,
      command_id: commandId, expected_revision: this.state.revision, media_generation: this.state.media_generation,
      type: "CHANGE_MEDIA", payload: { media_id: mediaId } }));
    const answer = await this.message((entry) => entry.command_id === commandId);
    assert.equal(answer.type, "ACK"); this.state = answer.state;
  }
  async close() {
    if (!this.socket || this.socket.readyState === WS.CLOSED) return;
    const closed = new Promise((done) => this.socket.once("close", done)); this.socket.terminate();
    await bounded(closed, "owned WebSocket closes", 5000);
    assert.equal(this.socket.readyState, WS.CLOSED);
  }
}

async function tool(binary, args, label, encoding = "utf8", maxBytes = 2 * 1024 * 1024) {
  const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const record = { label, tool: binary.endsWith("ffprobe") || binary.endsWith("ffprobe.exe") ? "ffprobe" : "ffmpeg",
    pid: child.pid ?? null, timeout_ms: 15000, close_observed: false, pid_absent: false };
  report.decode_processes.push(record);
  const out = [], err = []; let bytes = 0, errBytes = 0, failure;
  child.once("error", (error) => { failure = error; });
  child.stdout.on("data", (chunk) => { bytes += chunk.length;
    if (bytes > maxBytes) { failure = Error("finite decoder stdout budget exceeded"); child.kill("SIGKILL"); }
    else out.push(chunk); });
  child.stderr.on("data", (chunk) => { errBytes += chunk.length;
    if (errBytes > 256 * 1024) { failure = Error("finite decoder stderr budget exceeded"); child.kill("SIGKILL"); }
    else err.push(chunk); });
  const timer = setTimeout(() => { failure = Error("finite decoder process deadline exceeded"); child.kill("SIGKILL"); }, 15000);
  const code = await new Promise((done) => child.once("close", (code, signal) => {
    record.close_observed = true; record.exit_code = code; record.signal = signal; done(code);
  }));
  clearTimeout(timer);
  record.pid_absent = !child.pid || verifyPidAbsent(child.pid);
  record.stderr = redact(Buffer.concat(err).toString("utf8")).slice(0, 8192);
  assert.equal(record.pid_absent, true, "owned finite decoder process reaped");
  if (failure || code !== 0) throw Error(`${label}: ${failure ? redact(failure.message) : "native decoder failed"}`);
  const result = Buffer.concat(out);
  return encoding === "buffer" ? result : result.toString(encoding);
}

function workerPath(value, parent, fixture, session) {
  assert.equal(typeof value, "string"); assert.ok(value.length > 0 && value.length <= 65536);
  const url = new URL(value, parent);
  assert.equal(url.origin, fixture.workerOrigin, "HLS references use the actual owned Worker origin");
  assert.ok(!url.username && !url.password && !url.hash);
  assert.ok(url.pathname.startsWith(`/media-delivery/${session}/`), "every child stays within this grant's path");
  const token = url.searchParams.get("token");
  assert.ok(token); secrets.add(token); return url;
}
function sanitizedManifest(text) {
  return text.split(/\r?\n/).map((line) => {
    if (line && !line.startsWith("#")) return `[worker-resource sha256=${sha256(line)}]`;
    return redact(line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="[worker-resource sha256=${sha256(uri)}]"`));
  }).join("\n");
}
async function hlsWindow(fixture, plan, row, directory) {
  const budget = { remaining: 25 * 1024 * 1024 };
  const read = async (url, cap, type) => {
    assert.ok(budget.remaining > 0, "read budget checked before issuing Worker request");
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20000) });
    const diagnostic = { type, status: response.status, content_type: response.headers.get("content-type"),
      declared_bytes: response.headers.get("content-length"), budget_before_bytes: budget.remaining };
    row.worker_resources.push(diagnostic);
    if (response.status !== 200) { await response.body?.cancel(); throw Error(`actual Worker ${type} status ${response.status}`); }
    const bytes = await limitedBody(response, cap, budget);
    diagnostic.byte_length = bytes.length; diagnostic.sha256 = sha256(bytes);
    diagnostic.budget_after_bytes = budget.remaining;
    return { bytes, url };
  };
  row.worker_resources = []; row.manifests = [];
  let manifest = await read(workerPath(plan.playback_url, fixture.workerOrigin, fixture, plan.session_id), 256 * 1024, "manifest");
  let lines;
  for (let depth = 0; depth <= 2; depth++) {
    const text = manifest.bytes.toString("utf8");
    const path = resolve(directory, `manifest-${depth}.sanitized.m3u8`);
    await writeFile(path, sanitizedManifest(text));
    row.manifests.push({ depth, path, byte_length: manifest.bytes.length, sha256: sha256(manifest.bytes) });
    assert.ok(text.startsWith("#EXTM3U"), "actual Worker response is HLS");
    lines = text.split(/\r?\n/).map((line) => line.trim());
    if (!lines.some((line) => line.startsWith("#EXT-X-STREAM-INF:"))) break;
    assert.ok(depth < 2, "bounded master traversal");
    const child = lines.find((line) => line && !line.startsWith("#"));
    assert.ok(child, "master references a media playlist");
    manifest = await read(workerPath(child, manifest.url, fixture, plan.session_id), 256 * 1024, "manifest");
  }
  assert.equal(lines.includes("#EXT-X-DISCONTINUITY"), false, "finite fixture window is contiguous");
  assert.equal(lines.some((line) => line.startsWith("#EXT-X-BYTERANGE:")), false, "fixture uses complete media segments");
  assert.equal(lines.some((line) => line.startsWith("#EXT-X-KEY:") && !line.includes("METHOD=NONE")), false,
    "fixture media does not require an unowned key fetch");
  const segments = []; let start = 0, pending = null;
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      assert.equal(pending, null); pending = Number(line.slice(8).split(",")[0]) * 1000;
      assert.ok(Number.isFinite(pending) && pending > 0 && pending <= 60000);
    } else if (line && !line.startsWith("#")) {
      assert.ok(pending !== null); segments.push({ uri: line, start_ms: start, duration_ms: pending });
      start += pending; pending = null;
    }
  }
  const relativePosition = row.position_ms - plan.timeline_origin_ms;
  assert.ok(Number.isFinite(relativePosition) && relativePosition >= 0);
  const selected = segments.findIndex((segment) => relativePosition < segment.start_ms + segment.duration_ms);
  assert.ok(selected >= 0, "actual returned HLS timeline covers requested source time");
  const window = segments.slice(Math.max(0, selected - 1), selected + 2);
  assert.ok(window.length > 0 && window.length <= 3);
  row.hls = { media_sequence: lines.find((line) => line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) ?? null,
    timeline_origin_ms: plan.timeline_origin_ms, requested_relative_position_ms: relativePosition,
    selected_segment_index: selected, window_start_ms: window[0].start_ms,
    window_segment_count: window.length, segments: [], initialization: null };
  const maps = lines.filter((line) => line.startsWith("#EXT-X-MAP:"));
  assert.ok(maps.length <= 1, "at most one initialization section");
  assert.ok(maps.every((line) => !/\bBYTERANGE\s*=/.test(line)),
    "fixture initialization is a complete resource, not an unsupported byte range");
  const init = maps.length ? /URI="([^"]+)"/.exec(maps[0])?.[1] : null;
  if (maps.length) assert.ok(init);
  const chunks = [];
  if (init) {
    const result = await read(workerPath(init, manifest.url, fixture, plan.session_id), 1024 * 1024, "initialization");
    chunks.push(result.bytes); row.hls.initialization = { byte_length: result.bytes.length, sha256: sha256(result.bytes) };
  }
  for (const segment of window) {
    const result = await read(workerPath(segment.uri, manifest.url, fixture, plan.session_id), 8 * 1024 * 1024, "segment");
    chunks.push(result.bytes); row.hls.segments.push({ start_ms: segment.start_ms, duration_ms: segment.duration_ms,
      byte_length: result.bytes.length, sha256: sha256(result.bytes) });
  }
  row.hls.total_read_bytes = 25 * 1024 * 1024 - budget.remaining;
  const bytes = Buffer.concat(chunks);
  const path = resolve(directory, "window.media"); await writeFile(path, bytes);
  row.hls.window_path = path; row.hls.window_sha256 = sha256(bytes); row.hls.window_bytes = bytes.length;
  return { path, seek_ms: relativePosition - window[0].start_ms };
}

function rate(value) {
  const parts = String(value).split("/");
  const result = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}
async function decode(upstream, input, row, directory) {
  const ffmpeg = upstream.metadata.ffmpeg.find((entry) => entry.tool === "ffmpeg").path;
  const ffprobe = upstream.metadata.ffmpeg.find((entry) => entry.tool === "ffprobe").path;
  const probeOptions = ["-probesize", "8388608", "-analyzeduration", "60000000", "-max_probe_packets", "32768"];
  const probed = JSON.parse(await tool(ffprobe, ["-v", "error", ...probeOptions, "-show_streams", "-show_format", "-of", "json", input.path], `${row.name}: probe`));
  const streams = (probed.streams ?? []).map((stream) => Object.fromEntries(["index", "codec_type", "codec_name", "profile", "level",
    "pix_fmt", "bits_per_raw_sample", "width", "height", "r_frame_rate", "avg_frame_rate", "sample_rate", "channels",
    "channel_layout", "color_range", "color_space", "color_transfer", "color_primaries", "start_time", "duration", "bit_rate"]
    .map((key) => [key, stream[key] ?? null])));
  row.observed = { streams, format: Object.fromEntries(["format_name", "start_time", "duration", "size", "bit_rate"]
    .map((key) => [key, probed.format?.[key] ?? null])), requested_seek_in_window_ms: input.seek_ms,
    probe_limits: { bytes: 8388608, media_microseconds: 60000000, packets: 32768 } };
  await writeFile(resolve(directory, "streams.sanitized.json"), redact(JSON.stringify(row.observed, null, 2)) + "\n");
  await save(); // Preserve stream facts even if a bound or the decode fails.
  const videos = streams.filter((stream) => stream.codec_type === "video");
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  assert.equal(videos.length, 1, "exactly one actual video output");
  assert.equal(audios.length, 1, "exactly one actual selected audio output");
  const video = videos[0], audio = audios[0];
  assert.equal(video.codec_name, expectedVideo.codec, "observed output codec");
  assert.equal(video.profile?.toLowerCase(), expectedVideo.profile, "observed H264 profile must match requested Main");
  assert.ok(Number.isInteger(video.level) && video.level > 0 && video.level <= 31, "observed AVC level at most 3.1");
  assert.ok(Number.isInteger(video.width) && video.width > 0 && video.width <= expectedVideo.max_width);
  assert.ok(Number.isInteger(video.height) && video.height > 0 && video.height <= expectedVideo.max_height);
  // yuv420p is an unambiguous eight-bit pixel format, including when ffprobe's
  // bits_per_raw_sample is absent. Do not turn absent bit-depth evidence into 8.
  const bitDepth = video.pix_fmt === "yuv420p" || video.pix_fmt === "yuvj420p" ? 8 : Number(video.bits_per_raw_sample);
  row.observed.video_bit_depth = bitDepth;
  assert.equal(bitDepth, expectedVideo.requested_bit_depth, "observed output bit depth");
  row.observed.frame_rate = { nominal: rate(video.r_frame_rate), average: rate(video.avg_frame_rate) };
  assert.ok(row.observed.frame_rate.nominal && row.observed.frame_rate.nominal <= 30.001, "observed nominal frame rate");
  if (row.observed.frame_rate.average !== null)
    assert.ok(row.observed.frame_rate.average <= 30.001, "observed average frame rate");
  assert.ok(!["smpte2084", "arib-std-b67"].includes(video.color_transfer), "observed output does not signal HDR transfer");
  row.observed.range_evidence = { color_transfer: video.color_transfer,
    interpretation: "Finite output has no observed PQ/HLG signaling. Absent transfer metadata remains unspecified; requested SDR is verified separately as recipe evidence." };
  assert.equal(audio.codec_name, expectedAudio.codec, "observed AAC family");
  assert.ok(Number.isInteger(audio.channels) && audio.channels > 0 && audio.channels <= expectedAudio.max_channels,
    "observed audio channel bound");
  row.observed.audio_rate_contract = { profile_version: profileVersion(upstream.kind),
    allowed_sample_rates: upstream.kind === "emby" ? [44100, 48000] : [48000],
    requested_sample_rate: expectedAudio.requested_sample_rate, measured_sample_rate: Number(audio.sample_rate) };
  assertObservedAudioRate(upstream.kind, Number(audio.sample_rate));
  // Same loss-tolerant frame-clock and zero-crossing algorithms as the existing
  // real-product contract suite, applied to actual Worker bytes for this grant.
  const frame = await tool(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", ...probeOptions,
    "-i", input.path, "-ss", String(input.seek_ms / 1000), "-map", "0:v:0", "-frames:v", "1", "-pix_fmt", "gray",
    "-threads", "1", "-f", "rawvideo", "pipe:1"], `${row.name}: source frame`, "buffer", 2 * 1024 * 1024);
  assert.equal(frame.length, video.width * video.height, "one actual decoded source-clock frame");
  let sourceFrame = 0;
  for (let bit = 0; bit < 16; bit++) {
    const x = Math.round(((bit * 8 + 4) * video.width) / 320);
    const y = Math.round((6 * video.height) / 180);
    if (frame[y * video.width + x] > 128) sourceFrame += 2 ** bit;
  }
  row.observed.decoded_source_position_ms = sourceFrame * 100;
  row.observed.decoded_frame_sha256 = sha256(frame);
  assert.ok(Math.abs(row.observed.decoded_source_position_ms - row.position_ms) <= 600,
    "actual source pixels match requested seek within 600ms");
  const pcm = await tool(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", ...probeOptions,
    "-i", input.path, "-ss", String(input.seek_ms / 1000), "-t", "0.3", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000",
    "-f", "f32le", "pipe:1"], `${row.name}: selected audio`, "buffer", 1024 * 1024);
  assert.equal(pcm.length % 4, 0); const samples = pcm.length / 4; assert.ok(samples >= 800);
  let crossings = 0;
  for (let index = 1; index < samples; index++)
    if (pcm.readFloatLE((index - 1) * 4) <= 0 && pcm.readFloatLE(index * 4) > 0) crossings++;
  row.observed.selected_audio = { expected_hz: row.audio_hz, measured_hz: crossings * 8000 / samples,
    decoded_pcm_sha256: sha256(pcm), decoded_samples: samples };
  assert.ok(Math.abs(row.observed.selected_audio.measured_hz - row.audio_hz) < 30,
    "actual decoded audio matches the exact selected source track");
}

function assertEnvelope(profile, kind, sourceRate) {
  assert.ok(profile); assertAudioRateContract(profile, kind, sourceRate);
  assert.equal(profile.configuration_semantics, "upstream_transcode_profile_envelope");
  assert.equal(profile.transport, "hls"); assert.equal(profile.container, "ts");
  assert.deepEqual(profile.requested_video, expectedVideo); assert.deepEqual(profile.requested_audio, expectedAudio);
  assert.equal(profile.mse_sample.video.content_type, 'video/mp4; codecs="avc1.4d001f"');
  assert.equal(profile.mse_sample.audio.content_type, 'audio/mp4; codecs="mp4a.40.2"');
}

async function runProduct(upstream, product, directory) {
  assert.equal(upstream.metadata.image, pinned[upstream.kind].image);
  assert.equal(upstream.metadata.actual_version, pinned[upstream.kind].version);
  product.image = upstream.metadata.image; product.image_id = upstream.metadata.image_id;
  product.version = upstream.metadata.actual_version; product.toolchain = upstream.metadata.ffmpeg;
  product.samples = upstream.metadata.samples.map(({ title, sha256, codec, audio_streams, audio_codec, audio_channels, duration_seconds, frame_rate, audio_sample_rate }) =>
    ({ title, sha256, codec, audio_streams, audio_codec, audio_channels, duration_seconds, frame_rate, audio_sample_rate }));
  product.sample_settings = upstream.metadata.sample_settings;
  assert.equal(product.samples.length, 5);
  assert.ok(product.samples.every((sample) => sample.frame_rate === 60 && [44100, 48000].includes(sample.audio_sample_rate)),
    "both known source rates retain stressed 60fps video");
  assert.deepEqual([...new Set(product.samples.map((sample) => sample.audio_sample_rate))].sort(), [44100, 48000]);
  assert.ok(product.samples.some((sample) => sample.audio_codec === "ac3" && sample.audio_channels === 2),
    "stereo and non-AAC source coverage is real generated media, not metadata rewrites");
  for (const entry of [...upstream.metadata.ffmpeg, ...upstream.metadata.samples])
    assert.equal(await digest(entry.path), entry.sha256, "recorded tool/sample hash before product checks");
  const proxy = await recorder(upstream, product);
  let fixture, controller, deadlineTimer, deadlineWork, deadlineExpired = false;
  const armDeadline = (reason, ms, failure = true) => {
    clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => {
      if (failure) deadlineExpired = true;
      deadlineWork = killOwnedStack(fixture, product, reason).catch((error) => {
        deadlineExpired = true;
        (product.process_deadlines ??= []).push({ reason, error: redact(error.message) });
      });
    }, ms);
  };
  try {
    const upstreamClient = await upstream.client({ restricted: true, deviceId: `profile-products-${runId}` });
    armDeadline("owned stack startup", 180000);
    await isolatedMediaStack("stack", async (f) => {
      fixture = f;
      armDeadline("owned stack product matrix", 900000);
      try {
      const workerStart = f.startWorker();
      const force = setTimeout(() => { if (f.workerPid && !verifyPidAbsent(f.workerPid)) process.kill(f.workerPid, "SIGKILL"); }, 15000);
      try { await workerStart; } finally { clearTimeout(force); }
      const admin = f.client(); await admin.login(); secrets.add(admin.cookie); secrets.add(admin.csrf);
      secrets.add(admin.cookie.slice(admin.cookie.indexOf("=") + 1));
      const source = await proxy.source(admin, upstreamClient); await admin.request(`/sources/${source.id}/test`, "POST");
      const room = await admin.request("/rooms", "POST", { name: "Owned explicit profile products" });
      controller = new Controller(f, admin); await controller.join(room);
      const ledger = (key) => {
        const value = f.sql(`SELECT jsonb_build_object('id',id,'state',state,'negotiation',negotiation,'play_session_id',play_session_id,
          'media_source_id',media_source_id,'device_id',device_id,'stop_confirmed',stop_confirmed,'encoding_stop_confirmed',encoding_stop_confirmed,
          'io_uncertain',io_uncertain,'close_reason',close_reason,'last_error',last_error,'closed_at',closed_at)
          FROM upstream_reservations WHERE request_key=${quote(key)}`);
        return value ? JSON.parse(value) : null;
      };
      const ledgerSummary = (value) => value && { session_id: value.id, state: value.state, negotiation: value.negotiation,
        sid_hash: sidHash(value.play_session_id), source_hash: sidHash(value.media_source_id), device_hash: sidHash(value.device_id),
        stop_confirmed: value.stop_confirmed, encoding_stop_confirmed: value.encoding_stop_confirmed,
        io_uncertain: value.io_uncertain, close_reason: value.close_reason, last_error: value.last_error, closed_at: value.closed_at };

      try {
        for (const input of productCases) {
          const row = { ...input, result: "running", started_at: new Date().toISOString(), browser_estimate_controlled: true };
          product.cases.push(row); await save();
          const caseDirectory = resolve(directory, row.name); await mkdir(caseDirectory, { recursive: true });
          const key = randomUUID(); let plan, encoderBefore;
          if (upstream.kind === "emby") {
            try { encoderBefore = await encoderLogSnapshot(upstream.admin); }
            catch { row.encoder_log_evidence = { status: "pre_case_snapshot_unavailable" }; }
          }
          try {
            const listed = upstream.items.find((entry) => entry.Name === input.title); assert.ok(listed);
            const item = await upstreamClient.api(`/Users/${upstreamClient.userId}/Items/${listed.Id}`);
            assert.equal(item.Id, listed.Id); assert.equal(item.MediaSources?.length, 1);
            const observedSource = item.MediaSources[0];
            const audio = observedSource.MediaStreams.filter((stream) => stream.Type === "Audio")[input.track];
            assert.ok(audio && Number.isInteger(audio.Index));
            row.selection = { item_hash: sidHash(item.Id), source_hash: sidHash(observedSource.Id), audio_index: audio.Index,
              source_video: streamFields(observedSource.MediaStreams.find((stream) => stream.Type === "Video")), source_audio: streamFields(audio) };
            assert.equal(row.selection.source_audio.SampleRate, input.source_rate, "actual product metadata observes the exact generated source rate");
            assert.equal(row.selection.source_audio.Codec, input.source_codec);
            assert.equal(row.selection.source_audio.Channels, input.source_channels);
            assert.equal(row.selection.source_video.AverageFrameRate ?? row.selection.source_video.RealFrameRate, 60,
              "actual product metadata observes stressed source video");
            const media = f.sql(`SELECT id FROM media_items WHERE source_id=${quote(source.id)} AND title=${quote(input.title)}`);
            assert.match(media, /^[0-9a-f-]{36}$/); await controller.media(media);
            const beforePosts = proxy.negotiations.length, beforeReads = proxy.reads.length;
            const beforeSids = Number(f.sql("SELECT count(*) FROM upstream_reservations WHERE play_session_id IS NOT NULL"));
            const preflightResponse = await admin.raw("/upstream-profile-candidates", { method: "POST", body: {
              profile_version: 2, room_id: room.id, media_generation: controller.state.media_generation,
              position_ms: input.position_ms, audio_index: audio.Index } });
            const candidates = JSON.parse((await limitedBody(preflightResponse, 1024 * 1024)).toString("utf8"));
            if (candidates.binding) secrets.add(candidates.binding);
            row.preflight = { status: preflightResponse.status, error_code: candidates.error?.code ?? null,
              decision_reason: candidates.decision_reason ?? null, binding_present: Boolean(candidates.binding), profile: candidates.profile ?? null,
              metadata_gets: proxy.reads.length - beforeReads, playback_info_posts: proxy.negotiations.length - beforePosts,
              allocated_sids: Number(f.sql("SELECT count(*) FROM upstream_reservations WHERE play_session_id IS NOT NULL")) - beforeSids };
            assert.equal(row.preflight.playback_info_posts, 0, "metadata-only discovery allocates no PlaybackInfo/SID");
            assert.equal(row.preflight.allocated_sids, 0, "metadata-only discovery allocates no ledger SID");
            assert.equal(preflightResponse.status, 200, "actual RainSync preflight succeeds");
            assert.equal(row.preflight.metadata_gets, 1, "one actual bounded metadata GET");
            assert.ok(candidates.binding);
            assert.equal(candidates.profile_version, profileVersion(upstream.kind));
            assertEnvelope(candidates.profile, upstream.kind, input.source_rate);
            row.browser_audio_rate_reports = positiveRateReports(candidates.profile).audio_rate_reports ?? null;
            const beforePrepare = proxy.negotiations.length;
            const response = await admin.raw("/playback-sessions/upstream-profile", { method: "POST", body: {
              room_id: room.id, media_generation: controller.state.media_generation, viewer_id: randomUUID(), plan_generation: 1,
              idempotency_key: key, mode: "transcode", position_ms: input.position_ms, audio_index: audio.Index,
              capabilities: { progressive_h264_aac: false, native_hls: false, mse_h264_aac: true },
              upstream_profile_report: { profile_version: candidates.profile_version, binding: candidates.binding, profile_id: candidates.profile.profile_id,
                mse_supported: true, mse_decoding: { supported: true, smooth: false, power_efficient: false },
                ...positiveRateReports(candidates.profile) } } });
            const value = JSON.parse((await limitedBody(response, 1024 * 1024)).toString("utf8"));
            // Own the plan immediately, before any route/marker/output assertion.
            if (value.session_id) plan = value;
            row.prepare = { status: response.status, error_code: value.error?.code ?? null,
              playback_info_posts: proxy.negotiations.length - beforePrepare,
              session_id: value.session_id ?? null, delivery_mode: value.delivery_mode ?? null, transport: value.transport ?? null,
              selected_audio_track: value.selected_audio_track ?? null, timeline_origin_ms: value.timeline_origin_ms ?? null,
              decision_reason: value.decision_reason ?? null, upstream_profile: value.upstream_profile ?? null };
            row.negotiations = proxy.negotiations.slice(beforePrepare);
            for (const negotiation of row.negotiations) {
              negotiation.request_constraint_checks = recipeChecks(negotiation.request, upstream.kind);
              for (const source of negotiation.response?.sources ?? [])
                source.route.constraint_checks = routeChecks(source.route, upstream.kind, audio.Index, true);
            }
            row.reservation_after_prepare = ledgerSummary(ledger(key));
            await save();
            assert.equal(row.prepare.playback_info_posts, 1, "one final prepare uses exactly one owned PlaybackInfo");
            assert.equal(row.negotiations[0].request_source_hash, row.selection.source_hash, "requested exact selected media source");
            assert.equal(row.negotiations[0].request.AudioStreamIndex, audio.Index, "requested exact selected audio");
            assertChecks(row.negotiations[0].request_constraint_checks, "actual PlaybackInfo recipe");
            assert.equal(response.status, 200, "product profile constraints must propagate or use the narrowly recorded same-SID completion");
            assert.equal(plan.delivery_mode, "transcode"); assert.equal(plan.transport, "hls"); assertEnvelope(plan.upstream_profile, upstream.kind, input.source_rate);
            assert.deepEqual(plan.upstream_profile, candidates.profile, "published requested recipe marker is unchanged");
            assert.equal(plan.selected_audio_track, audio.Index, "RainSync selected exact audio track");
            const reservation = ledger(key);
            assert.ok(reservation && reservation.play_session_id, "known SID is checkpointed before output checks");
            assert.equal(row.negotiations[0].response.sid_hash, sidHash(reservation.play_session_id));
            assert.equal(reservation.media_source_id, observedSource.Id);
            const remote = row.negotiations[0].response.sources[0];
            assert.equal(remote.source_hash, row.selection.source_hash); assert.equal(remote.default_audio_index, audio.Index);
            assert.equal(remote.route.media_source_matches, true); assert.equal(remote.route.play_session_matches, true);
            assert.equal(remote.route.same_owned_origin, true); assert.equal(remote.route.same_item_master_path, true);
            assert.equal(remote.supports_transcoding, true); assert.equal(remote.transcoding_subprotocol?.toLowerCase(), "hls");
            assert.equal(remote.transcoding_container?.toLowerCase(), "ts");
            assertChecks(remote.route.constraint_checks, "actual product-returned route");
            const decrypted = (encrypted) => {
              const bytes = Buffer.from(encrypted, "base64"), cipher = createDecipheriv("aes-256-gcm",
                Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"), bytes.subarray(0, 12));
              cipher.setAuthTag(bytes.subarray(-16));
              return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString("utf8"));
            };
            const checkpoint = decrypted(f.sql(`SELECT response_encrypted FROM upstream_reservations WHERE id=${quote(plan.session_id)}`));
            assert.deepEqual(checkpoint, proxy.originalResponse(reservation.play_session_id), "exact untouched provider response is checkpointed");
            const resource = decrypted(f.sql(`SELECT resource->>'encrypted' FROM playback_sessions WHERE id=${quote(plan.session_id)}`));
            const base = new URL(resource.upstream_base.replace(/\/$/, "") + "/");
            const originalPath = checkpoint.MediaSources[0].TranscodingUrl;
            const original = new URL(originalPath.startsWith("/") && !originalPath.startsWith("//") && !originalPath.startsWith(base.pathname)
              ? originalPath.slice(1) : originalPath, base);
            const query = new Map([...original.searchParams].map(([key, value]) => [key.toLowerCase(), value]));
            const completed = upstream.kind === "emby" && !query.has("audiosamplerate");
            const final = new URL(original);
            if (!query.has("deviceid")) final.search += "&DeviceId=" + encodeURIComponent(reservation.device_id);
            if (completed) final.search += "&AudioSampleRate=48000";
            assert.equal(resource.url, final.href, "completed URL adds only owned missing device identity and missing AudioSampleRate");
            const expectedProvenance = { schema_version: upstream.kind === "emby" ? 2 : 1, semantics: "requested_configuration_not_measured_output",
              frame_rate_field: query.has("h264-maxframerate") ? "h264-maxframerate" : "maxframerate",
              provider_audio_sample_rate: query.has("audiosamplerate") ? Number(query.get("audiosamplerate")) : null,
              server_requested_audio_sample_rate: completed ? 48000 : null,
              ...(upstream.kind === "emby" ? { allowed_audio_sample_rates: [44100, 48000], source_audio_sample_rate: input.source_rate } : {}) };
            assert.deepEqual(resource.upstream_profile_route_provenance, expectedProvenance);
            assert.equal(plan.decision_reason === "emby_server_requested_audio_sample_rate_48000", completed);
            if (upstream.kind === "emby") {
              assert.equal(completed, true, "pinned Emby exercises missing-rate completion on the original SID");
              assert.equal(query.get("h264-maxframerate"), "30", "pinned Emby original frame-rate constraint remains intact");
              assert.equal(query.has("maxframerate"), false, "no substitute frame-rate request is synthesized");
            }
            row.route_provenance = expectedProvenance;
            row.original_response_unchanged = true;
            row.only_permitted_request_fields_added = true;
            const output = await hlsWindow(f, plan, row, caseDirectory);
            const delivered = proxy.mediaRequests.filter((entry) => entry.sid_hash === sidHash(reservation.play_session_id));
            assert.ok(delivered.length > 0, "actual Worker fetched the original SID's completed master request");
            for (const entry of delivered) {
              assert.equal(entry.path_and_query_sha256, sha256(final.pathname + final.search), "actual Worker sends exactly the persisted completed request");
              assert.equal(entry.device_hash, sidHash(reservation.device_id));
              entry.constraint_checks = routeChecks(entry.route, upstream.kind, audio.Index);
              assertChecks(entry.constraint_checks, "actual Worker outbound request");
            }
            row.worker_master_requests = delivered;
            assert.equal(proxy.negotiations.length - beforePrepare, 1, "finite actual output uses the single original PlaybackInfo/SID");
            await decode(upstream, output, row, caseDirectory);
            row.result = "passed";
          } catch (error) {
            row.result = "failed"; row.error = redact(error.message);
            report.failures.push({ kind: upstream.kind, case: input.name, error: row.error });
          } finally {
            try {
              const initial = ledger(key);
              const ownedSession = plan?.session_id ?? initial?.id;
              // A lost/malformed HTTP response never discards cleanup ownership.
              // A published grant is recoverable through our exact request key.
              const published = ownedSession && f.sql(`SELECT count(*) FROM playback_sessions WHERE id=${quote(ownedSession)}`) === "1";
              if (published) {
                const response = await admin.raw(`/playback-sessions/${ownedSession}`, { method: "DELETE" });
                row.stop_api_status = response.status; await limitedBody(response, 64 * 1024);
                assert.equal(response.status, 200, "Stop accepted for exactly this owned grant");
              }
              if (initial) {
                const closed = await until(() => { const value = ledger(key); return value?.state === "closed" ? value : null; },
                  "exact upstream SID/cleanup owner closes", 15000);
                row.cleanup = ledgerSummary(closed);
                if (closed.play_session_id) {
                  assert.equal(closed.stop_confirmed, true); assert.equal(closed.io_uncertain, false);
                  if (upstream.kind === "emby") assert.equal(closed.encoding_stop_confirmed, true);
                  assert.ok(proxy.stops.some((event) => event.kind === "playing" && event.sid_hash === sidHash(closed.play_session_id)
                    && event.device_hash === sidHash(closed.device_id) && [200, 204].includes(event.status)), "exact SID/device product Stop confirmed");
                  if (upstream.kind === "emby") assert.ok(proxy.stops.some((event) => event.kind === "encoding"
                    && event.sid_hash === sidHash(closed.play_session_id) && event.device_hash === sidHash(closed.device_id)
                    && [200, 204].includes(event.status)), "exact Emby encoding Stop confirmed");
                } else assert.equal(closed.negotiation, "not_sent", "no SID means negotiation never sent");
              }
              if (plan) {
                assert.equal(f.sql(`SELECT stopped FROM playback_sessions WHERE id=${quote(plan.session_id)}`), "t");
                const response = await fetch(workerPath(plan.playback_url, f.workerOrigin, f, plan.session_id),
                  { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000) });
                row.stopped_worker_status = response.status; await response.body?.cancel();
                assert.equal(response.status, 401, "Stop closes actual Worker delivery grant");
              }
              row.cleanup_verified = true;
            } catch (error) {
              row.result = "failed"; row.cleanup_error = redact(error.message);
              report.failures.push({ kind: upstream.kind, case: input.name, stage: "cleanup", error: row.cleanup_error });
            }
            if (upstream.kind === "emby" && encoderBefore) {
              // Cleanup above remains independent; log inspection cannot replace the primary case failure.
              try {
                const owned = ledger(key);
                row.encoder_log_evidence = await collectEncoderLogs(upstream.admin, encoderBefore,
                  { sid: owned?.play_session_id, device: owned?.device_id });
              } catch { row.encoder_log_evidence = { status: "incomplete_or_unavailable" }; }
            }
            row.finished_at = new Date().toISOString(); await save();
            console.log(`${row.result === "passed" ? "PASS" : "FAIL"} ${upstream.kind} ${input.name}`);
          }
        }
      } finally {
        await controller.close();
        product.final_reservations = JSON.parse(f.sql("SELECT COALESCE(jsonb_agg(jsonb_build_object('state',state,'negotiation',negotiation,'stop_confirmed',stop_confirmed,'encoding_stop_confirmed',encoding_stop_confirmed,'io_uncertain',io_uncertain)), '[]') FROM upstream_reservations"));
        assert.ok(product.final_reservations.every((value) => value.state === "closed"), "every owned cleanup obligation retired");
      }
      } finally {
        // Existing fixture owners reap their processes; the independent grace
        // timer prevents a stuck graceful exit from leaving an unbounded wait.
        armDeadline("owned stack cleanup grace", 10000, false);
      }
    }, { beforeStart(f) { fixture = f; secrets.add(f.password); secrets.add(f.env.SOURCE_ENCRYPTION_KEY); },
      env: { PLAYBACK_SESSION_LIMIT: "8" } });
  } finally {
    clearTimeout(deadlineTimer); await deadlineWork;
    const results = await Promise.allSettled([
      proxy.close(),
      controller?.close(),
      (async () => {
        if (!fixture) return;
        product.stack_cleanup = await fixture.verifyStopped();
        if (fixture.workerPid) {
          product.stack_cleanup.worker = { pid: fixture.workerPid, pid_absent: verifyPidAbsent(fixture.workerPid),
            port_closed: await verifyClosedPort(Number(new URL(fixture.workerOrigin).port)) };
          assert.equal(product.stack_cleanup.worker.pid_absent, true); assert.equal(product.stack_cleanup.worker.port_closed, true);
        }
        for (const event of product.process_deadlines ?? [])
          for (const process of event.killed ?? [])
            assert.equal(verifyPidAbsent(process.pid), true, "deadline-killed owned process is absent");
        assert.equal(deadlineExpired, false, "owned startup/matrix process deadline was not exceeded");
      })(),
      (async () => {
        for (const entry of [...upstream.metadata.ffmpeg, ...upstream.metadata.samples])
          assert.equal(await digest(entry.path), entry.sha256, "recorded tool/sample hash after product checks");
        product.source_samples_and_toolchain_unchanged = true;
      })(),
    ]);
    const failures = results.filter((entry) => entry.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((entry) => entry.reason), "owned product stack cleanup/integrity unconfirmed");
  }
}

async function retainFixtureEvidence(kind, product, directory) {
  const fixtureBase = resolve(ownedRoot, kind, "upstream");
  let entries;
  try { entries = await readdir(fixtureBase, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  product.upstream_cleanup = [];
  for (const entry of entries) {
    assert.ok(entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name), "only minted owned fixture directories");
    const source = resolve(fixtureBase, entry.name);
    const fixtureReport = JSON.parse(await readFile(resolve(source, "report.json"), "utf8"));
    assert.equal(fixtureReport.id, entry.name); assert.equal(fixtureReport.kind, kind); assert.equal(fixtureReport.image, pinned[kind].image);
    const destination = resolve(directory, "upstream-fixture"); await mkdir(destination, { recursive: true });
    for (const filename of ["report.json", "upstream.log", "activity.jsonl"])
      if (!(await absent(resolve(source, filename))))
        await writeFile(resolve(destination, filename), redact(await readFile(resolve(source, filename), "utf8")));
    product.upstream_cleanup.push({ id: entry.name, result: fixtureReport.result, ...fixtureReport.cleanup,
      source_unchanged: fixtureReport.source_unchanged, toolchain_unchanged: fixtureReport.toolchain_unchanged });
    assert.equal(fixtureReport.cleanup.container, true); assert.equal(fixtureReport.cleanup.network, true);
    assert.ok(fixtureReport.cleanup.volumes.every((volume) => volume.absent));
    if (fixtureReport.ffmpeg?.length) assert.equal(fixtureReport.toolchain_unchanged, true);
    assert.equal(fixtureReport.source_unchanged, true);
    if (fixtureReport.container?.port) assert.equal(await verifyClosedPort(fixtureReport.container.port), true);
  }
}

// Logs are copied only after their owners stop; credential/config/database
// directories are never uploadable evidence. Retained media is synthetic output.
async function retainStackLogs(directory, destination) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "postgres" && entry.name !== "config" && entry.name !== "cache" && entry.name !== "media")
      await retainStackLogs(path, resolve(destination, entry.name));
    if (entry.isFile() && entry.name.endsWith(".log")) {
      await mkdir(destination, { recursive: true });
      await writeFile(resolve(destination, entry.name), redact(await readFile(path, "utf8")));
    }
  }
}

const originalArtifactRoot = process.env.RAINSYNC_ARTIFACT_DIR;
process.env.RAINSYNC_ARTIFACT_DIR = ownedRoot;
try {
  for (const kind of selection === "all" ? ["jellyfin", "emby"] : [selection]) {
    const product = { kind, result: "running", cases: [] }; report.products.push(product);
    const directory = resolve(root, kind); await mkdir(directory, { recursive: true }); await save();
    try {
      await verifyBinding();
      await isolatedUpstreamReal(kind, (upstream) => runProduct(upstream, product, directory),
        { durationSeconds: 60, profileConstraintStress: true, profileAudioRateMatrix: true, artifactRoot: resolve(ownedRoot, kind, "upstream"), ffmpegBin: process.env.RAINSYNC_FFMPEG_BIN });
      product.result = product.cases.every((row) => row.result === "passed" && row.cleanup_verified) && product.cases.length === productCases.length
        ? "passed" : "failed";
    } catch (error) {
      product.result = "failed"; product.error = redact(error.message);
      report.failures.push({ kind, stage: "product", error: product.error });
    } finally {
      try { await retainFixtureEvidence(kind, product, directory); }
      catch (error) { product.result = "failed"; report.failures.push({ kind, stage: "fixture cleanup", error: redact(error.message) }); }
      await save();
    }
  }
} finally { process.env.RAINSYNC_ARTIFACT_DIR = originalArtifactRoot; }
try {
  await verifyBinding(); report.bound_source_and_binaries_unchanged = true;
  assert.ok(report.decode_processes.every((entry) => entry.close_observed && entry.pid_absent), "all finite decoder processes reaped");
  const stacks = await readdir(resolve(ownedRoot, "stack"), { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  // verifyStopped above is required before removing any retained fixture data.
  assert.ok(report.products.every((product) => product.stack_cleanup?.completed || !product.recorder), "owned stack cleanup is positively verified");
  assert.ok(report.products.every((product) => product.upstream_cleanup?.length && product.upstream_cleanup.every((value) =>
    value.container && value.network && value.volumes.every((volume) => volume.absent))), "all product containers/networks/volumes positively absent");
  for (const stack of stacks) {
    assert.ok(stack.isDirectory() && /^[0-9a-f-]{36}$/.test(stack.name));
    await retainStackLogs(resolve(ownedRoot, "stack", stack.name), resolve(root, "stack-logs", stack.name));
  }
  await rm(ownedRoot, { recursive: true }); assert.equal(await absent(ownedRoot), true);
  report.owned_fixture_data_removed = true;
} catch (error) { report.failures.push({ stage: "final integrity/cleanup", error: redact(error.message) }); }
report.finished_at = new Date().toISOString();
report.result = report.failures.length || report.products.some((product) => product.result !== "passed") ? "failed" : "passed";
await save();
console.log(`Sanitized report: ${reportPath}`);
if (report.result !== "passed") process.exitCode = 1;
