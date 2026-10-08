// Read-only reanalysis of already-closed, hash-bound producer evidence. No
// decoder, media generator, Cargo, network or other child process is launched.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyAudioEndpointIdentity, verifyChildAudioClock, CHILD_TOLERANCES,
  measureAudioPhase } from "../scripts/static-hls-child-verifier.mjs";
import { inspectStaticHlsTimeline, inspectStaticHlsStructure } from "../scripts/static-hls-timeline.mjs";

const args = process.argv.slice(2);
assert.equal(args.length, 4, "--binding FROZEN-PRODUCER-BINDING --output NEW-DIRECTORY");
assert.equal(args[0], "--binding"); assert.equal(args[2], "--output");
const bindingPath = path.resolve(args[1]), output = path.resolve(args[3]);
process.umask(0o077); await fs.mkdir(output);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bindingBytes = await fs.readFile(bindingPath), binding = JSON.parse(bindingBytes);
const repo = binding.worktree, producerRoot = path.dirname(binding.final_report);
const inventory = new Map(binding.final_artifacts.map((row) => [row.path, row]));
const inputs = new Map();
async function read(file) {
  const at = path.resolve(file), relative = path.relative(repo, at), expected = inventory.get(relative);
  assert.ok(expected, `file absent from frozen producer binding: ${relative}`);
  const bytes = await fs.readFile(at);
  assert.equal(bytes.length, expected.bytes, `bound input length ${relative}`);
  assert.equal(sha(bytes), expected.sha256, `bound input digest ${relative}`);
  inputs.set(relative, expected);
  return bytes;
}
const json = async (file) => JSON.parse(await read(file));
const pcm = (bytes) => {
  assert.equal(bytes.length % 4, 0, "complete f32 samples");
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
async function structure(directory, { source = false, probe } = {}) {
  const originalManifest = (await read(path.join(directory, "index.m3u8"))).toString();
  const manifest = source ? originalManifest : originalManifest.replace("PLAYLIST-TYPE:EVENT", "PLAYLIST-TYPE:VOD");
  const names = originalManifest.split("\n").filter((line) => line && !line.startsWith("#"));
  for (const name of names) assert.equal(path.basename(name), name, "bound basename only");
  const input = { manifest, init: await read(path.join(directory, "init.mp4")),
    segments: await Promise.all(names.map((name) => read(path.join(directory, name)))) };
  return source ? inspectStaticHlsTimeline({ ...input, probe }) : inspectStaticHlsStructure(input);
}
const report = { version: 1, scope: "hash-bound-retained-PCM-endpoint-reanalysis",
  accepted: false, release_ready: false, production_fallback_enabled: false,
  status: "running", producer_commit: binding.commit, producer_binding: bindingPath,
  producer_binding_sha256: sha(bindingBytes), producer_report: binding.final_report,
  producer_report_sha256: binding.final_report_sha256, tolerances: CHILD_TOLERANCES,
  analysis_node_version: process.version, analysis_node_executable: process.execPath,
  cases: [], negative_controls: [],
  boundary: "No media rerun. Original producer source/tool/helper/scope receipts remain separate. Correlation checks selected interior/head/end windows, not every PCM sample. Synthetic negative mutations are decoded-PCM substitutions of 1024 samples, not encoded AAC packet mutations." };
const save = async () => fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
await save();
try {
  const producer = await json(binding.final_report);
  assert.equal(producer.status, "passed");
  assert.equal(sha(await fs.readFile(binding.final_report)), binding.final_report_sha256);
  assert.ok(binding.all_final_actual_close);
  assert.ok(producer.commands.every((row) => row.state === "actual-close-observed" && row.process_group_reaped));
  report.analysis_sources_sha256 = Object.fromEntries(await Promise.all([
    "scripts/static-hls-child-verifier.mjs", "scripts/static-hls-timeline.mjs",
    "tests/static-hls-audio-endpoints-retained.mjs",
  ].map(async (file) => [file, sha(await fs.readFile(path.join(repo, file)))])));
  report.analysis_node_sha256 = sha(await fs.readFile(process.execPath));
  const sourcePcm = pcm(await read(path.join(producerRoot, "source-hls/decoded-audio.f32")));
  const firstDirectory = path.join(producerRoot, `sequential-${producer.cases[0].start_seconds}`);
  const sourceProbe = await json(path.join(firstDirectory, "source-probe.json"));
  const sourceProof = await structure(path.join(producerRoot, "source-hls"), { source: true, probe: sourceProbe });
  const sourceAudio = sourceProof.tracks.find((row) => row.kind === "audio");
  const sourceClock = { raw_end_samples: Math.round(sourceAudio.raw_end_seconds * 48000),
    decoded_end_samples: Math.round(sourceAudio.end_seconds * 48000) };
  report.source_clock = sourceClock;
  report.source_raw_priming = { raw_first_pts: sourceAudio.raw_first_pts,
    decoded_first_pts: sourceAudio.decoded_first_pts, priming_samples: sourceAudio.priming_samples };
  for (const original of producer.cases) {
    const directory = path.join(producerRoot, `sequential-${original.start_seconds}`);
    const native = await json(path.join(directory, "native-report.json"));
    assert.equal(native.process_scope_reaped, true);
    const owner = producer.commands.find((row) => row.owner_id === native.outer_owner_id);
    assert.ok(owner && owner.native_scope === "positively-drained");
    assert.equal(sha(await read(path.join(directory, "native-report.json"))), owner.native_receipt_sha256);
    const childProbe = await json(path.join(directory, "child-probe.json"));
    const childStructure = await structure(path.join(directory, "child"));
    const childClock = verifyChildAudioClock(childProbe,
      sourceClock.raw_end_samples / 48000 - original.start_seconds, childStructure);
    assert.deepEqual(childClock, original.audio_clock);
    const childPcm = pcm(await read(path.join(directory, "decoded-audio.f32")));
    const expectedStart = Math.round(original.start_seconds * 48000);
    const input = { source: sourcePcm, child: childPcm, expectedStart, sourceClock, childClock };
    const endpoints = verifyAudioEndpointIdentity(input);
    report.cases.push({ start_seconds: original.start_seconds, child_clock: childClock,
      endpoint_checks: endpoints, original_interior_phase_checks: original.audio_phase_checks,
      original_interior_scope: "sampled phase windows only; original first/last valid PCM content gap is closed by this separate endpoint analysis",
      original_producer_commit: binding.commit, bound_native_owner_id: native.outer_owner_id });
    for (const where of ["head", "tail"]) {
      const changed = childPcm.slice(), replacementStart = 8192, block = 1024;
      const destination = where === "head" ? 0 : childClock.raw_end_samples - block;
      changed.set(childPcm.subarray(replacementStart, replacementStart + block), destination);
      assert.equal(changed.length, childPcm.length, "same-length corruption control");
      const measurement = measureAudioPhase(sourcePcm.subarray(0, sourceClock.raw_end_samples),
        changed.subarray(0, childClock.raw_end_samples), expectedStart,
        where === "head" ? 0 : childClock.raw_end_samples - 4096);
      assert.throws(() => verifyAudioEndpointIdentity({ ...input, child: changed }),
        /audio identity correlation below fixed threshold|wrong audio source origin/);
      report.negative_controls.push({ start_seconds: original.start_seconds,
        kind: `same-length-${where}-AAC-sized-decoded-PCM-block-substitution`,
        block_samples: block, replacement_from_sample: replacementStart, destination_sample: destination,
        mutated_pcm_sha256: sha(Buffer.from(changed.buffer)), measured_boundary: measurement,
        exact_mutation_input: path.join(directory, "decoded-audio.f32"), rejected: true,
        boundary: "Synthetic decoded-PCM mutation reconstructed from retained original; no encoded AAC bytes or producer timestamps changed" });
    }
    for (const [kind, end] of [["truncated-decoded-PCM", childPcm.length - 1024],
      ["truncated-valid-tail-PCM", childClock.raw_end_samples - 1]]) {
      const changed = childPcm.subarray(0, end);
      assert.throws(() => verifyAudioEndpointIdentity({ ...input, child: changed }),
        /decoded PCM length disagrees with proven decoded sample count/);
      report.negative_controls.push({ start_seconds: original.start_seconds, kind,
        retained_samples: changed.length, expected_decoded_samples: childClock.decoded_end_samples,
        valid_raw_samples: childClock.raw_end_samples,
        mutated_pcm_sha256: sha(Buffer.from(changed.buffer, changed.byteOffset, changed.byteLength)),
        rejected: true, boundary: "Explicit length/truncation rejection is separate from boundary content correlation" });
    }
    await save();
  }
  report.bound_inputs = [...inputs.values()];
  report.status = "passed";
} catch (error) { report.status = "failed"; report.failure = error.stack; throw error;
} finally { await save(); console.log(`Retained endpoint PCM evidence: ${output}`); }
