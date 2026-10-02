import test from "node:test";
import assert from "node:assert/strict";
import { encoderEvidence, encoderLogSnapshot, collectEncoderLogs } from "./fixtures/upstream-encoder-evidence.mjs";
const sample = '/bin/ffmpeg -i "http://user:SECRET@host/input?api_key=SECRET" -map 0:1 -c:a:0 aac -ar:a:0 48000 -af "aresample=48000" -f segment "/private/SECRET.ts"\nInput #0, mpegts:\n Stream #0:1: Audio: aac (LC), 44100 Hz, mono\nOutput #0, segment:\n Stream #0:0: Audio: aac (LC), 48000 Hz, stereo\nSID-SECRET DEVICE-SECRET\n';
test("effective command flags and input/output observations retain no secret text", () => {
  const row = encoderEvidence(sample, { sid: "SID-SECRET", device: "DEVICE-SECRET" });
  assert.equal(row.commands[0].capture, "single_input_line_observed");
  assert.equal(row.commands[0].output_ar, "observed");
  assert.deepEqual(row.commands[0].command_resample_numeric_values, [48000]);
  assert.deepEqual(row.commands[0].maps, ["0:1"]);
  assert.deepEqual(row.audio.map((v) => [v.section, v.sample_rate]), [["input", 44100], ["output", 48000]]);
  assert.equal(row.sid_text_match, true); assert.equal(row.device_text_match, true);
  assert.equal(JSON.stringify(row).includes("SECRET"), false);
});
test("absent -ar differs from partial capture, filter setting and copy", () => {
  let row = encoderEvidence('/bin/ffmpeg -i input -c:a copy -af "aformat=sample_rates=48000" -f hls output\n');
  assert.equal(row.commands[0].output_ar, "absent_in_captured_command");
  assert.deepEqual(row.commands[0].command_resample_numeric_values, [48000]);
  assert.equal(row.commands[0].flags.find((v) => v.flag === "-c:a").value, "copy");
  row = encoderEvidence('/bin/ffmpeg -i input -ar 48000 \\\n');
  assert.equal(row.commands[0].output_ar, "unknown");
  assert.equal(encoderEvidence("no command\n").capture, "no_command_observed");
  row = encoderEvidence('/bin/ffmpeg -i input -af "SECRET" -f hls output\n');
  assert.equal(row.commands[0].unparsed_audio_filter_present, true); assert.equal(JSON.stringify(row).includes("SECRET"), false);
});
const log = (Name, Size = 123) => ({ Name, Size, DateModified: "now" });
function adminFor(items, body = sample) { const paths = []; return { paths, async raw(path, options) { paths.push(path); assert.ok(options.timeout <= 3000);
  return new Response(path.startsWith("/System/Logs/Query") ? JSON.stringify({ Items: items, TotalRecordCount: items.length }) : body); } }; }
test("bounded collector reads only new safe ffmpeg names and persists no names", async () => {
  const admin = adminFor([log("ffmpeg-old.txt"), log("ffmpeg-new.txt"), log("ffmpeg-../secret.txt"), log("server.txt")]);
  const snapshot = await encoderLogSnapshot(admin); assert.equal(snapshot.length, 2);
  const row = await collectEncoderLogs(admin, [{ name: "ffmpeg-old.txt" }], {});
  assert.equal(row.status, "captured"); assert.equal(row.logs.length, 1);
  assert.deepEqual(admin.paths.filter((p) => !p.startsWith("/System/Logs/Query")), ["/System/Logs/ffmpeg-new.txt?Sanitize=true"]);
  assert.equal(JSON.stringify(row).includes("ffmpeg-new"), false);
});
test("missing, oversized, too many or unreadable logs are never absent-command proof", async () => {
  assert.equal((await collectEncoderLogs(adminFor([]), [], {})).status, "no_new_ffmpeg_logs");
  assert.equal((await collectEncoderLogs(adminFor([log("ffmpeg-big.txt", 999999)]), [], {})).status, "incomplete_or_unavailable");
  assert.equal((await collectEncoderLogs(adminFor(Array.from({length:9},(_,i)=>log(`ffmpeg-${i}.txt`))), [], {})).status, "incomplete_or_unavailable");
  assert.equal((await collectEncoderLogs(adminFor([log("ffmpeg-x.txt")], "x".repeat(512*1024+1)), [], {})).status, "incomplete_or_unavailable");
  assert.throws(() => encoderEvidence("x".repeat(512*1024+1)), /limit/);
});

test("truncated and multi-input commands never claim complete output option scope", () => {
  for (const text of ['/bin/ffmpeg -f mp4 -i input -ar 48000\n', '/bin/ffmpeg -i one -ar 48000 -i two -f hls output\n', '/bin/ffmpeg -i one -ar 48000 -f hls\n']) {
    const row = encoderEvidence(text); assert.equal(row.commands[0].output_ar, "unknown");
    assert.ok(row.commands[0].flags.every((flag) => flag.scope === "unknown"));
  }
  assert.equal(encoderEvidence('/bin/ffmpeg -i input -ar:0 48000 -f hls output\n').commands[0].output_ar, "observed");
  assert.equal(encoderEvidence('/bin/ffmpeg -i input -ar:p:3 48000 -f hls output\n').commands[0].output_ar, "unknown");
});
test("declared oversized response is cancelled before read and stream overflow is cancelled", async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const admin = adminFor([log("ffmpeg-new.txt")]); const old = admin.raw;
    admin.raw = async (path, options) => path.startsWith("/System/Logs/Query") ? old(path, options) :
      new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(512*1024+1)); }, cancel() { cancelled = true; } }),
        { headers: declared ? { "content-length": "999999" } : {} });
    const result = await collectEncoderLogs(admin, [], {});
    assert.equal(result.status, "incomplete_or_unavailable"); assert.equal(cancelled, true);
  }
});
