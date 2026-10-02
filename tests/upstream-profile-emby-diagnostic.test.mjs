import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { diagnosticBody, diagnosticPath, finiteObservation, redactDiagnostic, diagnosticError, diagnosticFixtureEvidence, diagnosticRouteShape } from "./upstream-profile-emby-diagnostic.mjs";
import { upstreamFixtureSampleSettings } from "./fixtures/upstream-real.mjs";
import { fetchOwnedEmbyMedia } from "./fixtures/upstream-media-route.mjs";
const base = "http://127.0.0.1:8096/emby";
const route = "/emby/Videos/123/master.m3u8?PlaySessionId=owned&MediaSourceId=source&h264-maxframerate=30";

test("stress fixture is explicit and defaults remain unchanged", () => {
  assert.deepEqual(upstreamFixtureSampleSettings(), { h264_frame_rate: 10, h264_sample_rate: 48000 });
  assert.deepEqual(upstreamFixtureSampleSettings(true), { h264_frame_rate: 60, h264_sample_rate: 44100 });
  assert.throws(() => upstreamFixtureSampleSettings("true"));
});
test("diagnostic retains original URL and records missing constraints without synthesis", () => {
  const original = new URL(route, base).href;
  const result = diagnosticPath(route, base + "/", base, "123", "owned", true);
  assert.equal(result.url.href, original);
  assert.equal(result.query.get("h264-maxframerate"), "30");
  assert.equal(result.query.has("maxframerate"), false);
  assert.equal(result.query.has("audiosamplerate"), false);
});
test("raw route restricts origin, item, SID, credential authority, duplicates and fragments", () => {
  for (const invalid of [
    "https://foreign.test" + route,
    route.replace("/123/", "/456/"), route.replace("owned", "foreign"),
    "http://user:password@127.0.0.1:8096" + route,
    route + "#fragment", route + "&playsessionid=owned",
    route.replace("master.m3u8", "../../another/master.m3u8"),
  ]) assert.throws(() => diagnosticPath(invalid, base + "/", base, "123", "owned", true));
});
test("child references stay in original item namespace without adding SID", () => {
  const master = diagnosticPath(route, base + "/", base, "123", "owned", true);
  const child = diagnosticPath("hls1/main/0.ts", master.url, base, "123", "owned");
  assert.equal(child.path, "/emby/Videos/123/hls1/main/0.ts");
  assert.equal(child.query.size, 0);
  assert.throws(() => diagnosticPath("/emby/Users/private", master.url, base, "123", "owned"));
});
test("pre-read and streamed limits cannot consume oversized resources", async () => {
  await assert.rejects(diagnosticBody(new Response("large", { headers: { "content-length": "999" } }), 4), /pre-read/);
  await assert.rejects(diagnosticBody(new Response("large"), 4), /streamed/);
  const budget = { remaining: 5 };
  assert.equal((await diagnosticBody(new Response("abc"), 5, budget)).toString(), "abc");
  assert.equal(budget.remaining, 2);
  await assert.rejects(diagnosticBody(new Response("abc"), 5, budget), /streamed/);
});
test("finite observations preserve absent and failing output as evidence", () => {
  assert.deepEqual(finiteObservation([]), { nominal_frame_rate: null, average_frame_rate: null,
    audio_sample_rate: null, observed_fps_at_most_30: false, observed_audio_48000: false });
  const observed = finiteObservation([{ codec_type: "video", r_frame_rate: "60/1", avg_frame_rate: "60/1" },
    { codec_type: "audio", sample_rate: "44100" }]);
  assert.equal(observed.observed_fps_at_most_30, false); assert.equal(observed.observed_audio_48000, false);
  const bounded = finiteObservation([{ codec_type: "video", r_frame_rate: "30000/1001", avg_frame_rate: "30000/1001" },
    { codec_type: "audio", sample_rate: "48000" }]);
  assert.equal(bounded.observed_fps_at_most_30, true); assert.equal(bounded.observed_audio_48000, true);
});


test("prior item 6 replacement corrupts JSON; structured redaction preserves types, keys and hashes", () => {
  const original = { schema_version: 1, frame_rate: 60, sample_rate: 44100, input_item: "6",
    ok: true, missing: null, sha256: "6".repeat(64), backend_binding_sha256: "a6".repeat(32),
    image: "emby/embyserver@sha256:" + "6".repeat(64), codec: "h264", timestamp: "2026-10-02T02:26:30Z" };
  assert.throws(() => JSON.parse(JSON.stringify(original).replaceAll("6", "[redacted]")));
  const cleaned = JSON.parse(JSON.stringify(redactDiagnostic(original)));
  assert.deepEqual(cleaned, original, "public synthetic item IDs are not credentials");
  const shortSecret = JSON.parse(JSON.stringify(redactDiagnostic(original, new Set(["6"]))));
  assert.equal(shortSecret.input_item, "[redacted]");
  for (const key of ["frame_rate", "sample_rate", "ok", "missing", "sha256", "backend_binding_sha256", "image", "codec", "timestamp"])
    assert.deepEqual(shortSecret[key], original[key]);
});

test("one-character, numeric and regex-sensitive credentials are literal string values only", () => {
  const secrets = new Set(["6", "x", "p.a$ss[9]"]);
  const cleaned = redactDiagnostic({ count: 6, nested: ["6", "x", "p.a$ss[9]", "x token observed", "h264"],
    password: "6", headers: { Authorization: "Bearer unknown-credential", "X-Emby-Token": "unlisted" },
    error: 'auth p.a$ss[9] failed; token=unknown-secret; {"access_token":"json-secret"}',
    url: "http://fixture.test/route?api_key=private" }, secrets);
  const bytes = JSON.stringify(cleaned);
  assert.equal(cleaned.count, 6);
  assert.deepEqual(cleaned.nested, ["[redacted]", "[redacted]", "[redacted]", "[redacted] token observed", "h264"]);
  for (const secret of ["p.a$ss[9]", "unknown-credential", "unlisted", "unknown-secret", "json-secret", "private"])
    assert.equal(bytes.includes(secret), false, secret);
  assert.equal(cleaned.headers.Authorization, "[redacted]");
  assert.equal(cleaned.password, "[redacted]");
});

test("exact secret digest values are redacted even in hash-shaped fields", () => {
  const token = "a".repeat(64);
  assert.equal(redactDiagnostic({ sha256: token }, new Set([token])).sha256, "[redacted]");
});

test("bounded nested failure chains preserve the original phase beside cleanup failure", () => {
  const cause = new Error('route validation failed: token=secret-value'); cause.code = "ERR_ASSERTION";
  const wrapper = new Error("Owned emby fixture failed", { cause });
  const callback = diagnosticError(wrapper, "returned_route_validation");
  const cleanup = diagnosticError(new Error("encoding cleanup failed"), "session_cleanup");
  const cleaned = redactDiagnostic({ callback_error: callback, failures: [cleanup] });
  assert.equal(cleaned.callback_error.phase, "returned_route_validation");
  assert.equal(cleaned.callback_error.cause.code, "ERR_ASSERTION");
  assert.match(cleaned.callback_error.cause.message, /route validation failed/);
  assert.equal(JSON.stringify(cleaned).includes("secret-value"), false);
  assert.equal(cleaned.failures[0].phase, "session_cleanup");
  cause.cause = wrapper;
  assert.match(JSON.stringify(diagnosticError(wrapper, "route")), /cause chain bounded/);
  const aggregate = diagnosticError(new AggregateError([cause, new Error("second")], "multiple"), "cleanup");
  assert.equal(aggregate.errors.length, 2);
});

test("retained fixture evidence preserves inner failure and cleanup, excluding private command state", () => {
  const fixture = { id: "owned", kind: "emby", result: "failed", failures: ['AssertionError: missing route; password="secret-value"'],
    cleanup: { container: true }, source_sha256: "6".repeat(64),
    command_failures: [{ argv: ["secret-cli-argument"] }], root: "/private/owned", credentials: "not-in-evidence" };
  const bytes = JSON.stringify(redactDiagnostic(diagnosticFixtureEvidence(fixture)));
  const evidence = JSON.parse(bytes);
  assert.equal(evidence.result, "failed"); assert.equal(evidence.cleanup.container, true);
  assert.match(evidence.failures[0], /AssertionError: missing route/);
  assert.equal(evidence.source_sha256, fixture.source_sha256);
  for (const privateValue of ["secret-value", "secret-cli-argument", "/private/owned", "not-in-evidence"])
    assert.equal(bytes.includes(privateValue), false);
});


test("credential-bearing free-text lines redact complete quoted and escaped values", () => {
  for (const message of [
    'route failed password="two words" after',
    "route failed password='two words' after",
    'route failed {"access_token":"two words"}',
    'route failed Authorization: Basic two words',
    'route failed Cookie: session=two words',
    'route failed token="quote\\\"two words" after',
    'route failed token=\\"two words\\" after',
  ]) {
    const cleaned = redactDiagnostic({ message }).message;
    assert.match(cleaned, /^route failed/);
    assert.equal(cleaned.includes("two"), false);
    assert.equal(cleaned.includes("words"), false);
  }
});


test("prevalidation route shape explains base resolution without retaining URL or credentials", () => {
  const original = "/Videos/6/master.m3u8?api_key=private";
  const shape = diagnosticRouteShape(original, base);
  assert.deepEqual(shape, { present: true, form: "root-relative", valid_url: true,
    same_owned_origin: true, under_configured_base: false, master_path: true });
  assert.equal(diagnosticRouteShape("Videos/6/master.m3u8?api_key=private", base).under_configured_base, true);
  assert.equal(JSON.stringify(shape).includes("private"), false);
  assert.equal(JSON.stringify(shape).includes("/Videos/6"), false);
});


test("raw media fetch preserves both exact root and API-prefixed URLs and query spelling", async () => {
  for (const prefix of ["", "/emby"]) {
    const original = `http://127.0.0.1:8096${prefix}/Videos/123/master.m3u8?PlaySessionId=owned&MediaSourceId=source&h264-maxframerate=30&VideoCodec=h264%2Ch264`;
    const calls = [];
    const controller = new AbortController();
    const response = await fetchOwnedEmbyMedia({ reference: original, parent: original, base,
      item: "123", source: "source", sid: "owned", master: true, ownedItems: new Map([["123", new Set(["source"])]]),
      headers: { Authorization: "fixture-auth" }, signal: controller.signal }, async (...args) => {
      calls.push(args); return new Response("media");
    });
    assert.equal(await response.text(), "media");
    assert.equal(calls.length, 1); assert.equal(calls[0][0], original);
    assert.equal(calls[0][1].headers.Authorization, "fixture-auth");
    assert.equal(calls[0][1].redirect, "error"); assert.equal(calls[0][1].method, "GET");
    controller.abort(); assert.equal(calls[0][1].signal.aborted, true);
  }
});

test("media helper rejects unowned catalog items and wrong target before authenticated fetch", async () => {
  const root = "http://127.0.0.1:8096/Videos/123/master.m3u8?PlaySessionId=owned&MediaSourceId=source";
  for (const overrides of [
    { reference: root, ownedItems: new Map([["other", new Set(["source"])]]) },
    { reference: root.replace("/Videos/", "/private/Videos/") },
    { reference: root.replace("/123/", "/456/") },
    { reference: root.replace("127.0.0.1", "foreign.test") },
    { reference: root.replace("http://", "http://user:password@") },
    { reference: root.replace("owned", "other") },
    { reference: root + "&playsessionid=owned" },
    { reference: root + "#fragment" },
    { source: "wrong-source" },
    { reference: root.replace("MediaSourceId=source", "MediaSourceId=other") },
    { reference: root.replace("/Videos/", "/emby/Videos/") },
    { timeout: 0 },
  ]) {
    let called = false;
    await assert.rejects(fetchOwnedEmbyMedia({ reference: root, parent: root, base,
      item: "123", source: "source", sid: "owned", master: true, ownedItems: new Map([["123", new Set(["source"])]]), ...overrides }, async () => { called = true; }));
    assert.equal(called, false);
  }
});

test("root controller children stay in root namespace; aliases cannot change mid-grant", () => {
  const parent = "http://127.0.0.1:8096/Videos/123/master.m3u8?PlaySessionId=owned";
  assert.equal(diagnosticPath("hls1/main/0.ts", parent, base, "123", "owned").path, "/Videos/123/hls1/main/0.ts");
  assert.throws(() => diagnosticPath("/emby/Videos/123/hls1/main/0.ts", parent, base, "123", "owned"));
  assert.throws(() => diagnosticPath("/Videos/123/hls1/main/0.ts", base + "/Videos/123/master.m3u8", base, "123", "owned"));
});


test("ordinary fixture API raw still appends configured base; media helper is a separate path", async () => {
  const source = await readFile(new URL("./fixtures/upstream-real.mjs", import.meta.url), "utf8");
  const ordinary = source.slice(source.indexOf("const raw = async"), source.indexOf("const api = async"));
  assert.match(ordinary, /fetch\(base \+ path,/);
  assert.match(ordinary, /redirect: "error"/);
  assert.equal(ordinary.includes("fetchOwnedEmbyMedia"), false);
});
