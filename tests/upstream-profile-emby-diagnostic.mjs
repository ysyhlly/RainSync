// Opt-in raw-product observation, never a RainSync admission/compatibility pass.
// Uses only a pinned disposable Emby and synthetic 60fps/44.1kHz input.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedUpstreamReal } from "./fixtures/upstream-real.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = async (path) => sha(await readFile(path));
const image = "emby/embyserver@sha256:3aafff933d3f28d23ed0bc201022abe71c0aa80deb17177566c726b9bbc686c6";

export async function diagnosticBody(response, cap, budget = { remaining: cap }) {
  const allowed = Math.min(cap, budget.remaining);
  assert.ok(allowed > 0);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > allowed)) {
    await response.body?.cancel();
    throw Error("response exceeds declared pre-read budget");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let total = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > allowed) throw Error("response exceeds streamed budget");
      budget.remaining -= next.value.byteLength; chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

// Resolve only original returned references. Never add/replace query parameters.
export function diagnosticPath(reference, parent, base, item, sid, master = false) {
  assert.equal(typeof reference, "string"); assert.ok(reference.length > 0 && reference.length <= 16384);
  const url = new URL(reference, parent), configured = new URL(base);
  assert.equal(url.origin, configured.origin);
  assert.ok(!url.username && !url.password && !url.hash);
  const prefix = configured.pathname.replace(/\/$/, "");
  const itemPrefix = `${prefix}/videos/${encodeURIComponent(item)}/`;
  assert.ok(url.pathname.toLowerCase().startsWith(itemPrefix.toLowerCase()), "same owned item only");
  if (master) assert.equal(url.pathname.toLowerCase(), `${itemPrefix}master.m3u8`.toLowerCase());
  const query = new Map();
  for (const [key, value] of url.searchParams) {
    const normalized = key.toLowerCase(); assert.ok(!query.has(normalized), "no duplicate query keys");
    query.set(normalized, value);
  }
  if (master || query.has("playsessionid")) assert.equal(query.get("playsessionid"), sid);
  const path = url.pathname.slice(prefix.length) + url.search;
  assert.equal(base.replace(/\/$/, "") + path, url.href, "original route round-trips without synthesis");
  return { url, path, query };
}

export function diagnosticRouteShape(reference, base) {
  const shape = { present: typeof reference === "string" && reference.length > 0 };
  if (!shape.present) return shape;
  shape.form = reference.startsWith("/") ? "root-relative" : /^[a-z][a-z0-9+.-]*:/i.test(reference) ? "absolute" : "relative";
  try {
    const configured = new URL(base), route = new URL(reference, base + "/");
    shape.valid_url = true;
    shape.same_owned_origin = route.origin === configured.origin;
    shape.under_configured_base = route.pathname.toLowerCase().startsWith(configured.pathname.replace(/\/$/, "").toLowerCase() + "/");
    shape.master_path = route.pathname.toLowerCase().endsWith("/master.m3u8");
  } catch { shape.valid_url = false; }
  return shape;
}

export function finiteObservation(streams) {
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const rate = (value) => {
    const [n, d = 1] = String(value).split("/").map(Number);
    return Number.isFinite(n / d) && n / d > 0 ? n / d : null;
  };
  const nominal = rate(video?.r_frame_rate), average = rate(video?.avg_frame_rate);
  return { nominal_frame_rate: nominal, average_frame_rate: average,
    audio_sample_rate: Number(audio?.sample_rate) || null,
    observed_fps_at_most_30: nominal !== null && average !== null && nominal <= 30.001 && average <= 30.001,
    observed_audio_48000: Number(audio?.sample_rate) === 48000 };
}

// Sanitize values, never serialized JSON or object keys. Public synthetic item
// numbers are not secrets. Short secrets require token boundaries in free text;
// typed integrity hashes and immutable image digests retain their meaning.
export function redactDiagnostic(value, secrets = new Set()) {
  const known = [...secrets].filter((secret) => typeof secret === "string" && secret.length)
    .sort((a, b) => b.length - a.length);
  const sensitive = (key) => /^(?:[a-z]*password|passwd|pw|[a-z]*token|apikey|[a-z]*authorization|cookie|setcookie|[a-z]*secret|credentials?|sourceencryptionkey|privatekey|csrf)$/i.test(key.replace(/[-_]/g, ""));
  const text = (value, key) => {
    if (known.includes(value)) return "[redacted]";
    if ((/(?:^|_)sha256$|^source_digest$/.test(key) && /^[0-9a-f]{64}$/.test(value)) ||
        (key === "image" && /^[a-z0-9/.-]+@sha256:[0-9a-f]{64}$/.test(value))) return value;
    let result = value;
    for (const secret of known) {
      if (secret.length >= 8) result = result.replaceAll(secret, "[redacted]");
      else {
        let offset = 0, next = "", found;
        while ((found = result.indexOf(secret, offset)) !== -1) {
          const end = found + secret.length;
          const boundary = (character) => !character || !/[A-Za-z0-9_]/.test(character);
          next += result.slice(offset, found) + (boundary(result[found - 1]) && boundary(result[end]) ? "[redacted]" : secret);
          offset = end;
        }
        result = next + result.slice(offset);
      }
    }
    return result.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[redacted-url]")
      // Error strings are not a trusted parser format. Drop the rest of a
      // credential-bearing line, including quoted/escaped/whitespace values.
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|authorization|cookie|csrf)\s*["']?\s*[=:]\s*)[^\r\n]*/gi, "$1[redacted]")
      .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]");
  };
  const visit = (entry, key = "") => {
    if (sensitive(key)) return "[redacted]";
    if (typeof entry === "string") return text(entry, key);
    if (Array.isArray(entry)) return entry.map((child) => visit(child));
    if (entry && typeof entry === "object")
      return Object.fromEntries(Object.entries(entry).map(([name, child]) => [name, visit(child, name)]));
    return entry;
  };
  return visit(value);
}

export function diagnosticError(error, phase, seen = new Set(), depth = 0) {
  if (depth >= 5 || seen.has(error)) return { phase, message: "[cause chain bounded]" };
  if (!error || typeof error !== "object") return { phase, message: String(error).slice(0, 4096) };
  seen.add(error);
  const result = { phase, name: String(error.name ?? "Error").slice(0, 128), message: String(error.message ?? error).slice(0, 4096) };
  if (typeof error.code === "string" || typeof error.code === "number") result.code = error.code;
  if (error.cause !== undefined) result.cause = diagnosticError(error.cause, phase, seen, depth + 1);
  if (Array.isArray(error.errors)) result.errors = error.errors.slice(0, 4).map((child) => diagnosticError(child, phase, seen, depth + 1));
  return result;
}

// Keep only useful fixture evidence, not credentials, command arguments or logs.
export function diagnosticFixtureEvidence(fixture) {
  const fields = ["id", "kind", "image", "actual_version", "result", "failures", "cleanup",
    "source_sha256", "storage_helper_sha256", "source_unchanged", "toolchain_unchanged", "started_at", "finished_at"];
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(fixture, key)).map((key) => [key, fixture[key]]));
}

async function main() {
  assert.equal(process.platform, "linux");
  assert.equal(process.env.RAINSYNC_RUN_EMBY_PROFILE_DIAGNOSTIC, "1", "explicit diagnostic opt-in required");
  assert.equal(process.argv.length, 2);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const artifact = process.env.RAINSYNC_ARTIFACT_DIR;
  assert.ok(artifact && isAbsolute(artifact) && relative(repo, artifact).startsWith(".." + sep));
  assert.ok(process.env.RAINSYNC_FFMPEG_BIN && isAbsolute(process.env.RAINSYNC_FFMPEG_BIN), "explicit existing toolchain required");
  const bindingPath = process.env.W03_BACKEND_BINDING;
  assert.ok(bindingPath && isAbsolute(bindingPath));
  const bindingBytes = await readFile(bindingPath), binding = JSON.parse(bindingBytes);
  assert.equal(binding.result, "passed"); assert.equal(binding.build.exit_code, 0);
  assert.equal(sha(JSON.stringify(binding.source)), binding.source_digest);
  const helper = binding.test_helpers.find((value) => value.name === "emby_profile_request");
  assert.ok(helper && isAbsolute(helper.path), "actual production request builder must be build-bound");
  for (const path of ["crates/providers/examples/emby_profile_request.rs", "crates/providers/src/upstream_profiles.rs"])
    assert.ok(binding.source.some((entry) => entry.path === path));
  const coordinator = await Promise.all(["tests/upstream-profile-emby-diagnostic.mjs", "tests/fixtures/upstream-real.mjs",
    "tests/fixtures/upstream-storage.mjs", "tests/fixtures/postgres.mjs"].map(async (path) => ({ path, sha256: await digest(resolve(repo, path)) })));
  const verify = async () => {
    assert.equal(await digest(bindingPath), sha(bindingBytes));
    for (const entry of [...binding.source, ...coordinator]) {
      assert.ok(!isAbsolute(entry.path) && !relative(repo, resolve(repo, entry.path)).startsWith(".."));
      assert.equal(await digest(resolve(repo, entry.path)), entry.sha256);
    }
    for (const entry of [...binding.binaries, ...binding.test_helpers]) assert.equal(await digest(entry.path), entry.sha256);
    assert.equal(await digest(resolve(repo, binding.producer.path)), binding.producer.sha256);
    assert.equal(await digest(binding.build.log_path), binding.build.log_sha256);
  };
  await verify();
  const id = randomUUID(), root = resolve(artifact, "emby-profile-diagnostic", id);
  const owned = resolve(artifact, "emby-profile-diagnostic-owned", id);
  await mkdir(root, { recursive: true }); await mkdir(owned, { recursive: true });
  const report = { schema_version: 1, result: "running", id, started_at: new Date().toISOString(), image,
    scope: "Raw pinned Emby original returned route, one owned SID, synthetic stress input. Diagnostic only; RainSync production admission remains strict and this cannot mark compatibility passed.",
    limits: { request_ms: 15000, process_ms: 15000, window_bytes: 25 * 1024 * 1024, segments: 3, manifest_depth: 2 },
    backend_binding_sha256: sha(bindingBytes), coordinator, processes: [], failures: [], cleanup: {}, resources: [] };
  const secrets = new Set();
  let phase = "fixture_startup";
  const save = () => writeFile(resolve(root, "report.json"), JSON.stringify(redactDiagnostic(report, secrets), null, 2) + "\n");
  const tool = async (binary, args, label, input) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    const record = { label, pid: child.pid ?? null, closed: false, pid_absent: false }; report.processes.push(record);
    let failure, outSize = 0, errSize = 0; const chunks = [];
    child.on("error", () => { failure = Error(`${label} process start failed`); });
    child.stdin.on("error", () => { failure = Error(`${label} input failed`); });
    child.stdout.on("data", (chunk) => { outSize += chunk.length; if (outSize > 2 * 1024 * 1024) { failure = Error(`${label} output budget`); child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.stderr.on("data", (chunk) => { errSize += chunk.length; if (errSize > 256 * 1024) { failure = Error(`${label} error budget`); child.kill("SIGKILL"); } });
    const timer = setTimeout(() => { failure = Error(`${label} process deadline`); child.kill("SIGKILL"); }, 15000);
    child.stdin.end(input);
    const code = await new Promise((done) => child.once("close", (code) => { record.closed = true; done(code); }));
    clearTimeout(timer); record.exit_code = code; record.pid_absent = !child.pid || verifyPidAbsent(child.pid);
    assert.equal(record.pid_absent, true);
    if (failure || code !== 0) throw failure ?? Error(`${label} process failed`);
    return Buffer.concat(chunks);
  };
  try {
    await isolatedUpstreamReal("emby", async (upstream) => {
      assert.equal(upstream.metadata.image, image); assert.equal(upstream.metadata.actual_version, "4.10.0.40");
      phase = "fixture_client";
      const client = await upstream.client({ restricted: true });
      secrets.add(client.userId); secrets.add(client.deviceId);
      const item = upstream.items.find((entry) => entry.MediaSources?.[0]?.MediaStreams?.some((stream) => stream.Type === "Video" && stream.Codec === "h264"));
      assert.ok(item); const itemId = item.Id;
      let sid, sourceId;
      const json = async (path, method = "GET", body) => {
        const response = await client.raw(path, { method, body, timeout: 15000 });
        const bytes = await diagnosticBody(response, 1024 * 1024);
        assert.equal(response.status, 200); return JSON.parse(bytes);
      };
      try {
        phase = "source_metadata";
        const metadata = await json(`/Users/${encodeURIComponent(client.userId)}/Items/${encodeURIComponent(itemId)}`);
        assert.equal(metadata.MediaSources.length, 1); const source = metadata.MediaSources[0];
        sourceId = source.Id;
        const inputVideo = source.MediaStreams.find((stream) => stream.Type === "Video");
        const inputAudio = source.MediaStreams.find((stream) => stream.Type === "Audio");
        assert.ok(inputVideo && inputAudio);
        assert.equal(inputVideo.RealFrameRate ?? inputVideo.AverageFrameRate, 60);
        assert.equal(inputAudio.SampleRate, 44100);
        report.input = { frame_rate: 60, sample_rate: 44100,
          samples: upstream.metadata.samples.map(({ sha256, codec, duration_seconds }) => ({ sha256, codec, duration_seconds })) };
        phase = "request_builder";
        const body = JSON.parse(await tool(helper.path, [], "production request builder", JSON.stringify({
          user_id: client.userId, item_id: itemId, item_metadata: metadata, audio_index: inputAudio.Index, position_ms: 0,
        })));
        assert.equal(body.UserId, client.userId); assert.equal(body.MediaSourceId, sourceId);
        assert.equal(body.EnableDirectPlay, false); assert.equal(body.EnableDirectStream, false);
        assert.equal(body.AllowVideoStreamCopy, false); assert.equal(body.AllowAudioStreamCopy, false);
        report.request = { body_sha256: sha(JSON.stringify(body)), device_profile: body.DeviceProfile,
          max_streaming_bitrate: body.MaxStreamingBitrate, position_ticks: body.StartTimeTicks ?? null };
        phase = "upstream_negotiation";
        const negotiation = await client.raw(`/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, { method: "POST", body, timeout: 15000 });
        const info = JSON.parse(await diagnosticBody(negotiation, 1024 * 1024));
        // Keep cleanup ownership before validating status, returned route or source.
        if (typeof info.PlaySessionId === "string" && info.PlaySessionId) { sid = info.PlaySessionId; secrets.add(sid); }
        assert.ok(sid && sid.length <= 512 && !/[\x00-\x1f]/.test(sid));
        report.sid_sha256 = sha(sid); report.device_sha256 = sha(client.deviceId);
        assert.equal(negotiation.status, 200);
        phase = "returned_route_validation";
        report.returned_route_facts = {
          source_count: Array.isArray(info.MediaSources) ? info.MediaSources.length : null,
          source_matches: info.MediaSources?.[0]?.Id === sourceId,
          audio_matches: info.MediaSources?.[0]?.DefaultAudioStreamIndex === inputAudio.Index,
          route: diagnosticRouteShape(info.MediaSources?.[0]?.TranscodingUrl, upstream.base),
        };
        await save();
        assert.equal(info.MediaSources.length, 1); const returned = info.MediaSources[0];
        assert.equal(returned.Id, sourceId); assert.equal(returned.DefaultAudioStreamIndex, inputAudio.Index);
        const master = diagnosticPath(returned.TranscodingUrl, upstream.base + "/", upstream.base, itemId, sid, true);
        assert.equal(master.query.get("mediasourceid"), sourceId);
        const selectedKeys = ["maxframerate", "h264-maxframerate", "framerate", "audiosamplerate", "audiocodec", "videocodec", "allowvideostreamcopy", "allowaudiostreamcopy"];
        report.original_route = { sha256: sha(master.url.href), fields: Object.fromEntries(selectedKeys.map((key) => [key, master.query.get(key) ?? null])), synthesized: false };
        await save();
        const statusBody = { ItemId: itemId, MediaSourceId: sourceId, PlaySessionId: sid, PositionTicks: 0,
          CanSeek: true, IsPaused: false, PlayMethod: "Transcode" };
        phase = "upstream_playing_start";
        const start = await client.raw("/Sessions/Playing", { method: "POST", body: statusBody, timeout: 15000 });
        await diagnosticBody(start, 64 * 1024); assert.ok([200, 204].includes(start.status));
        const budget = { remaining: report.limits.window_bytes };
        const fetchOriginal = async (route, cap, type) => {
          const response = await client.raw(route.path, { timeout: 15000 });
          const bytes = await diagnosticBody(response, cap, budget);
          report.resources.push({ type, url_sha256: sha(route.url.href), status: response.status, bytes: bytes.length, sha256: sha(bytes) });
          assert.equal(response.status, 200); return bytes;
        };
        phase = "original_hls_read";
        let current = master, lines;
        for (let depth = 0; depth <= 2; depth++) {
          const text = (await fetchOriginal(current, 256 * 1024, "manifest")).toString("utf8");
          assert.ok(text.startsWith("#EXTM3U")); lines = text.split(/\r?\n/).map((line) => line.trim());
          if (!lines.some((line) => line.startsWith("#EXT-X-STREAM-INF:"))) break;
          assert.ok(depth < 2);
          current = diagnosticPath(lines.find((line) => line && !line.startsWith("#")), current.url, upstream.base, itemId, sid);
        }
        for (const marker of ["#EXT-X-BYTERANGE:", "#EXT-X-DISCONTINUITY", "#EXT-X-KEY:"])
          assert.ok(!lines.some((line) => line.startsWith(marker)), "bounded diagnostic does not support extra HLS semantics");
        const maps = lines.filter((line) => line.startsWith("#EXT-X-MAP:")); assert.ok(maps.length <= 1);
        const chunks = [];
        if (maps.length) {
          assert.ok(!maps[0].includes("BYTERANGE")); const uri = /URI="([^"]+)"/.exec(maps[0])?.[1]; assert.ok(uri);
          chunks.push(await fetchOriginal(diagnosticPath(uri, current.url, upstream.base, itemId, sid), 1024 * 1024, "initialization"));
        }
        const segments = lines.filter((line) => line && !line.startsWith("#")).slice(0, 3);
        assert.ok(segments.length > 0);
        for (const segment of segments)
          chunks.push(await fetchOriginal(diagnosticPath(segment, current.url, upstream.base, itemId, sid), 8 * 1024 * 1024, "segment"));
        const window = resolve(root, "synthetic-window.media"); const bytes = Buffer.concat(chunks);
        await writeFile(window, bytes); report.window = { sha256: sha(bytes), bytes: bytes.length, segment_count: segments.length };
        const ffprobe = upstream.metadata.ffmpeg.find((entry) => entry.tool === "ffprobe").path;
        const ffmpeg = upstream.metadata.ffmpeg.find((entry) => entry.tool === "ffmpeg").path;
        const limits = ["-probesize", "8388608", "-analyzeduration", "60000000", "-max_probe_packets", "32768"];
        phase = "finite_probe";
        const probe = JSON.parse(await tool(ffprobe, ["-v", "error", ...limits, "-show_streams", "-of", "json", window], "finite probe"));
        report.observed_streams = (probe.streams ?? []).map((stream) => Object.fromEntries([
          "codec_type", "codec_name", "profile", "width", "height", "r_frame_rate", "avg_frame_rate", "sample_rate", "channels",
        ].map((key) => [key, stream[key] ?? null])));
        report.finite_observation = finiteObservation(report.observed_streams); await save();
        phase = "finite_decode";
        await tool(ffmpeg, ["-v", "error", "-nostdin", "-threads", "1", ...limits, "-i", window,
          "-t", "1", "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], "finite video/audio decode");
        report.finite_decode_completed = true;
        report.interpretation = "These observations describe only downloaded finite output. Missing route constraints stay missing; neither output observations nor this test change RainSync admission or promise whole-title behavior.";
      } catch (error) {
        report.callback_error = diagnosticError(error, phase);
        throw error;
      } finally {
        phase = "session_cleanup";
        if (sid) {
          const stops = await Promise.allSettled([
            (async () => {
              const response = await client.raw("/Sessions/Playing/Stopped", { method: "POST", timeout: 15000,
                body: { ItemId: itemId, MediaSourceId: sourceId, PlaySessionId: sid, PositionTicks: 0, CanSeek: true, IsPaused: true, PlayMethod: "Transcode" } });
              await diagnosticBody(response, 64 * 1024); assert.ok([200, 204].includes(response.status)); report.cleanup.playing_stop_status = response.status;
            })(),
            (async () => {
              const response = await client.raw(`/Videos/ActiveEncodings?DeviceId=${encodeURIComponent(client.deviceId)}&PlaySessionId=${encodeURIComponent(sid)}`, { method: "DELETE", timeout: 15000 });
              await diagnosticBody(response, 64 * 1024); assert.ok([200, 204].includes(response.status)); report.cleanup.encoding_stop_status = response.status;
            })(),
          ]);
          report.cleanup.sid_sha256 = sha(sid); report.cleanup.device_sha256 = sha(client.deviceId);
          assert.ok(stops.every((entry) => entry.status === "fulfilled"), "both exact-SID cleanup requests must succeed");
        }
        for (const entry of [...upstream.metadata.ffmpeg, ...upstream.metadata.samples]) assert.equal(await digest(entry.path), entry.sha256);
        report.source_samples_and_tools_unchanged = true;
      }
    }, { durationSeconds: 20, h264ConstraintStress: true, artifactRoot: owned, ffmpegBin: process.env.RAINSYNC_FFMPEG_BIN });
  } catch (error) { report.failures.push(diagnosticError(error, phase)); }
  finally {
    try {
      phase = "fixture_evidence_and_cleanup";
      const entries = await readdir(owned, { withFileTypes: true }); assert.equal(entries.length, 1);
      const entry = entries[0]; assert.ok(entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name));
      const fixture = JSON.parse(await readFile(resolve(owned, entry.name, "report.json"), "utf8"));
      assert.equal(fixture.id, entry.name); assert.equal(fixture.kind, "emby"); assert.equal(fixture.image, image);
      // Retain safe inner failure evidence before cleanup assertions/removal.
      const evidence = redactDiagnostic(diagnosticFixtureEvidence(fixture), secrets);
      await writeFile(resolve(root, "fixture.sanitized.json"), JSON.stringify(evidence, null, 2) + "\n");
      report.fixture_evidence = { filename: "fixture.sanitized.json", result: evidence.result, failures: evidence.failures };
      await save();
      report.fixture_cleanup = fixture.cleanup;
      assert.equal(fixture.cleanup.container, true); assert.equal(fixture.cleanup.network, true);
      assert.ok(fixture.cleanup.volumes.every((volume) => volume.absent));
      assert.equal(fixture.source_unchanged, true); assert.equal(fixture.toolchain_unchanged, true);
      if (fixture.container?.port) assert.equal(await verifyClosedPort(fixture.container.port), true);
      await rm(owned, { recursive: true }); report.owned_fixture_data_removed = true;
      await verify(); report.bound_source_and_binaries_unchanged = true;
      assert.ok(report.processes.every((process) => process.closed && process.pid_absent));
    } catch (error) { report.failures.push(diagnosticError(error, phase)); }
    report.finished_at = new Date().toISOString();
    report.result = report.failures.length ? "diagnostic_failed" : "diagnostic_completed";
    await save(); console.log(`Sanitized Emby diagnostic: ${resolve(root, "report.json")}`);
    if (report.failures.length) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
