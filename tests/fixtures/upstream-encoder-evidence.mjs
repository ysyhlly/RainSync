// Test-only owned-fixture log observations. Raw names, commands and logs never leave this module.
import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 512 * 1024;
const safeName = (name) => typeof name === "string" && /^ffmpeg[A-Za-z0-9_.-]{0,180}\.(txt|log)$/i.test(name) && !name.includes("..");
const codec = /^(aac|libfdk_aac|libfaac|copy|ac3|eac3|mp3|libmp3lame|opus|libopus)$/;
export function encoderEvidence(text, expected = {}) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw Error("encoder log byte limit");
  const commands = [], audio = []; let section = "unknown";
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*Input #\d/.test(line)) section = "input";
    if (/^\s*Output #\d/.test(line)) section = "output";
    const stream = /Audio:\s*([A-Za-z0-9_]+)(?:[^\r\n]*?),\s*(\d{4,6}) Hz\b/.exec(line);
    if (audio.length >= 64) throw Error("encoder audio count limit");
    if (stream) audio.push({ section, codec: codec.test(stream[1]) ? stream[1] : "unrecognized", sample_rate: Number(stream[2]) });
    // Only a complete single-line invocation containing an input and output format is classified.
    if (!/(?:^|[\/\\"\s])ffmpeg(?:\.exe)?(?:"|\s)/i.test(line)) continue;
    const tokens = line.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? [];
    const unquote = (v) => v?.replace(/^("|')(.*)\1$/, "$2");
    const input = tokens.findIndex((token) => token === "-i");
    const balanced = (line.match(/(?<!\\)"/g)?.length ?? 0) % 2 === 0 && (line.match(/'/g)?.length ?? 0) % 2 === 0;
    const inputs = tokens.filter((token) => token === "-i").length;
    const outputFormat = tokens.findIndex((token, index) => token === "-f" && index > input + 1);
    const last = unquote(tokens.at(-1));
    const complete = balanced && inputs === 1 && input >= 0 && outputFormat > input + 1 &&
      outputFormat + 2 < tokens.length && last && !last.startsWith("-") && !/\\\s*$/.test(line);
    const flags = [];
    for (let i = 0; i < tokens.length - 1; i++) {
      const flag = tokens[i], value = unquote(tokens[i + 1]);
      if (!/^-(ar(?::(?:a(?::\d+)?|\d+))?|acodec|c:a(?::\d+)?|codec:a(?::\d+)?|f)$/.test(flag)) continue;
      const numeric = flag.startsWith("-ar"), format = flag === "-f";
      const safe = numeric ? /^\d{4,6}$/.test(value) : format ? /^(hls|segment|mpegts|mp4|matroska|adts|dash)$/.test(value) : codec.test(value);
      flags.push({ flag, scope: !complete ? "unknown" : i > input + 1 ? "output" : "input", value: safe ? value : "unrecognized" });
    }
    const maps = tokens.flatMap((token, i) => token === "-map" ? [/^-?\d{1,3}:[av]?\d{0,3}\??$/.test(unquote(tokens[i + 1])) ? unquote(tokens[i + 1]) : "unrecognized"] : []);
    const resample = [...line.matchAll(/(?:aresample\s*=\s*|(?:sample_rates|osr|out_sample_rate)\s*=\s*)(\d{4,6})\b/g)].map((match) => Number(match[1]));
    commands.push({ maps, capture: complete ? "single_input_line_observed" : "unknown_or_partial", flags,
      output_ar: !complete || tokens.some((token) => /^-ar(?::|$)/.test(token) && !flags.some((flag) => flag.flag === token)) ? "unknown" : flags.some((flag) => flag.scope === "output" && flag.flag.startsWith("-ar")) ? "observed" : "absent_in_captured_command",
      resample_filter_present: /\b(aresample|aformat)\b/.test(line),
      unparsed_audio_filter_present: tokens.some((token) => /^-(af|filter:a(?::\d+)?)$/.test(token)) && resample.length === 0, command_resample_numeric_values: resample });
    if (commands.length > 8 || audio.length > 64) throw Error("encoder parse count limit");
  }
  return { schema_version: 1, log_sha256: hash(text), byte_length: Buffer.byteLength(text),
    capture: commands.length ? "commands_observed" : "no_command_observed",
    sid_text_match: Boolean(expected.sid && text.includes(expected.sid)), device_text_match: Boolean(expected.device && text.includes(expected.device)),
    sid_hash: expected.sid ? hash(expected.sid) : null, commands, audio };
}
async function bytes(response, max) {
  if (response.status !== 200) { await response.body?.cancel(); throw Error("encoder log API status"); }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) {
    await response.body?.cancel(); throw Error("encoder log declared response limit");
  }
  const reader = response.body?.getReader(); if (!reader) throw Error("encoder log body absent");
  const parts = []; let length = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; length += next.value.length;
    if (length > max) throw Error("encoder log read limit"); parts.push(Buffer.from(next.value)); }
  } catch(error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
  return Buffer.concat(parts, length);
}
async function listing(admin, timeout) {
  const body = await bytes(await admin.raw("/System/Logs/Query?StartIndex=0&Limit=64", { timeout }), 64 * 1024);
  const result = JSON.parse(body.toString("utf8"));
  if (!Array.isArray(result.Items) || result.Items.length > 64 || !Number.isInteger(result.TotalRecordCount) || result.TotalRecordCount > 64)
    throw Error("encoder log listing incomplete");
  return result.Items.filter((entry) => safeName(entry.Name)).map((entry) => ({ name: entry.Name, size: entry.Size, modified: entry.DateModified }));
}
export async function encoderLogSnapshot(admin) { return listing(admin, 2000); }
export async function collectEncoderLogs(admin, before, expected) {
  const deadline = Date.now() + 12000;
  const timeout = () => { const left = deadline - Date.now(); if (left <= 0) throw Error("encoder log deadline"); return Math.min(left, 3000); };
  const result = { status: "unknown", semantics: "owned_case_new_log_observation_not_output_acceptance", logs: [] };
  try {
    const after = await listing(admin, timeout());
    const names = new Set(before.map((entry) => entry.name));
    const selected = after.filter((entry) => !names.has(entry.name));
    result.new_log_count = selected.length;
    if (selected.length > 8) throw Error("encoder log count limit");
    for (const entry of selected) {
      if (!Number.isInteger(entry.size) || entry.size < 0 || entry.size > MAX_BYTES) throw Error("encoder log declared size limit");
      const body = await bytes(await admin.raw(`/System/Logs/${encodeURIComponent(entry.name)}?Sanitize=true`, { timeout: timeout() }), MAX_BYTES);
      result.logs.push(encoderEvidence(body.toString("utf8"), expected));
    }
    result.status = selected.length ? "captured" : "no_new_ffmpeg_logs";
  } catch { result.status = "incomplete_or_unavailable"; }
  return result;
}
