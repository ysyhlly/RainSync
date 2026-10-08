import test from "node:test";
import assert from "node:assert/strict";
import { chainEvidence, manifestReferences } from "./fixtures/upstream-profile-chain.mjs";
const base = "http://127.0.0.1:8096/emby/Videos/6/master.m3u8?AudioSampleRate=48000&api_key=TOPSECRET";
const expected = { sid: "SIDSECRET", source: "SOURCESECRET", device: "DEVICESECRET" };
test("child resolution observes missing inherited rate without mutating original URL", () => {
  const child = "main.m3u8?PlaySessionId=SIDSECRET&MediaSourceId=SOURCESECRET&DeviceId=DEVICESECRET&api_key=TOPSECRET";
  const evidence = chainEvidence(child, base, expected);
  assert.equal(evidence.route_category, "variant"); assert.equal(evidence.fields.audiosamplerate, undefined);
  assert.equal(evidence.sid_matches, true); assert.equal(evidence.source_matches, true); assert.equal(evidence.device_matches, true);
  assert.equal(evidence.same_owned_origin, true); assert.equal(child.includes("AudioSampleRate"), false);
  assert.equal(/TOPSECRET|SIDSECRET|SOURCESECRET|DEVICESECRET|127\.0\.0\.1/.test(JSON.stringify(evidence)), false);
});
test("retained/duplicate controls remain visible but arbitrary values and credentials do not", () => {
  const value = "main.m3u8?AudioSampleRate=48000&AUDIOSAMPLERATE=44100&AudioCodec=aac&VideoCodec=TOPSECRET&AllowAudioStreamCopy=false&password=TOPSECRET";
  const evidence = chainEvidence(value, base, expected);
  assert.deepEqual(evidence.fields.audiosamplerate, ["48000", "44100"]);
  assert.deepEqual(evidence.fields.videocodec, ["[unrecognized-value]"]);
  assert.equal(JSON.stringify(evidence).includes("TOPSECRET"), false);
  assert.equal(evidence.sid_matches, false); assert.match(evidence.url_sha256, /^[a-f0-9]{64}$/);
});
test("master, media, foreign origins and embedded credentials are observations only", () => {
  assert.equal(chainEvidence(base, base).route_category, "master");
  const evidence = chainEvidence("http://user:TOPSECRET@foreign.invalid/a.ts#secret", base);
  assert.equal(evidence.route_category, "media"); assert.equal(evidence.same_owned_origin, false);
  assert.equal(evidence.credentials_present, true); assert.equal(evidence.fragment_present, true);
  assert.equal(JSON.stringify(evidence).includes("TOPSECRET"), false);
});
test("references include plain and attributed URI with finite limits", () => {
  assert.deepEqual(manifestReferences('#EXTM3U\n#EXT-X-MEDIA:URI="audio.m3u8"\nmain.m3u8?q=1\n#EXT-X-MAP:URI="init.mp4"\na.ts\n'), ["audio.m3u8", "main.m3u8?q=1", "init.mp4", "a.ts"]);
  assert.throws(() => manifestReferences("a.ts\n".repeat(257)), /reference budget/);
  assert.throws(() => manifestReferences("x".repeat(256 * 1024 + 1)), /byte budget/);
});
test("query-bearing child preserves requested rate and independently checks original identities", () => {
  const child = "main.m3u8?AudioSampleRate=48000&h264-maxframerate=30&PlaySessionId=WRONG&DeviceId=DEVICESECRET&MediaSourceId=SOURCESECRET";
  const evidence = chainEvidence(child, base, expected);
  assert.deepEqual(evidence.fields.audiosamplerate, ["48000"]);
  assert.deepEqual(evidence.fields["h264-maxframerate"], ["30"]);
  assert.equal(evidence.sid_matches, false); assert.equal(evidence.device_matches, true);
  assert.equal(JSON.parse(JSON.stringify(evidence)).sid_matches, false);
  assert.equal(JSON.stringify(evidence).includes("WRONG"), false);
});
