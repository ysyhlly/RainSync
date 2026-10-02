import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticBody, diagnosticPath, finiteObservation } from "./upstream-profile-emby-diagnostic.mjs";
import { upstreamFixtureSampleSettings } from "./fixtures/upstream-real.mjs";
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
  assert.equal(child.path, "/Videos/123/hls1/main/0.ts");
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
