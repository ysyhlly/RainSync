// Synthetic RST1/PCM evidence verifier. No runtime grant or browser clock proof.
import assert from "node:assert/strict";
import { verifyOutputTimeline } from "./negotiated-timeline-verifier.mjs";

export const CHILD_TOLERANCES = Object.freeze({
  sourceTickMs: 0.01,
  audioPhaseSamples: 48, // 1 ms at 48 kHz, fixed before native measurements
  audioCorrelationMinimum: 0.9,
  audioPaddingSamples: 1024,
  avResidualFormula: "1000 / scanner-qualified source fps + audioPhaseSamples / 48",
});

export function verifyHlsSourcePixels(proof, probe, observations) {
  assert.equal(proof.source_origin_ms, 0);
  const video = proof.tracks.find((row) => row.kind === "video");
  const [n, d] = video.time_base.split("/").map(Number);
  const frames = probe.packets_and_frames.filter(
    (row) => row.type === "frame" && row.media_type === "video",
  );
  assert.equal(frames.length, observations.length);
  return observations.map((observation, i) => {
    const pts = Number(frames[i].pts) * n / d * 1000;
    assert.equal(observation.frame_index, i, "source pixel frame identity");
    assert.ok(Math.abs(pts - observation.original_position_ms) <= CHILD_TOLERANCES.sourceTickMs,
      "source HLS PTS disagrees with independently decoded RST1 origin");
    return { ...observation, source_pts_ms: pts };
  });
}

export function verifyChildPixels({ startMs, sourceFrames, sourceFps, sourceDurationMs, probe, observations }) {
  const video = probe.streams.find((row) => row.codec_type === "video");
  const [n, d] = video.time_base.split("/").map(Number);
  const frames = probe.packets_and_frames.filter(
    (row) => row.type === "frame" && row.media_type === "video",
  );
  assert.equal(frames.length, observations.length);
  const checks = verifyOutputTimeline({ startMs, sourceFrames,
    samples: observations.map((row, i) => ({ ...row, output_frame_index: i })),
    outputFrames: frames.map((row) => Number(row.pts) * n / d * 1000),
    timeBase: video.time_base,
  });
  assert.ok([25, 30].includes(sourceFps), "scanner-qualified CFR source rate required");
  assert.equal(video.avg_frame_rate, "30/1", "measured child CFR rate required");
  const outputPeriodMs = 1000 / 30;
  const selectedEnd = Math.min(sourceDurationMs, startMs + 20000);
  const actualDuration = frames.length * outputPeriodMs;
  assert.ok(Math.abs(actualDuration - (selectedEnd - startMs)) <= outputPeriodMs + CHILD_TOLERANCES.sourceTickMs,
    "child end-duration outside one measured output frame period");
  let duplicates = 1;
  for (let i = 1; i < checks.length; i++) {
    const step = checks[i].frame_index - checks[i - 1].frame_index;
    assert.ok(step >= 0, "source frame correspondence moves backwards");
    assert.ok(step <= 1, "child skips a source frame despite higher output fps");
    duplicates = step === 0 ? duplicates + 1 : 1;
    assert.ok(duplicates <= Math.ceil(30 / sourceFps), "excess source-frame duplication");
  }
  const selected = sourceFrames.filter((row) => row.source_pts_ms >= startMs - CHILD_TOLERANCES.sourceTickMs
    && row.source_pts_ms < selectedEnd - CHILD_TOLERANCES.sourceTickMs).map((row) => row.frame_index);
  assert.deepEqual([...new Set(checks.map((row) => row.frame_index))], selected,
    "complete selected source-frame coverage required at output fps >= source fps");
  return checks;
}

export function verifyChildAudioClock(probe, expectedSeconds, structure) {
  const stream = probe.streams.find((row) => row.codec_type === "audio");
  assert.equal(stream.sample_rate, "48000");
  const packets = probe.packets_and_frames.filter(
    (row) => row.type === "packet" && row.stream_index === stream.index,
  );
  const frames = probe.packets_and_frames.filter(
    (row) => row.type === "frame" && row.media_type === "audio",
  );
  assert.equal(Number(packets[0].pts), -1024, "raw AAC priming stays separate");
  assert.equal(Number(packets[0].dts), -1024);
  assert.equal(packets[0].side_data_list[0].skip_samples, 1024);
  const track = structure.tracks.find((row) => row.kind === "audio");
  const samples = structure.allSamples.get(track.id);
  assert.equal(packets.length, samples.length);
  let packetEnd = -1024, decodedEnd = 0;
  for (let i = 0; i < packets.length; i++) {
    const row = packets[i], sample = samples[i];
    assert.equal(sample.pts, packetEnd, "actual BMFF audio sample continuity");
    assert.equal(Number(row.pts), sample.pts, "raw audio packet/sample match");
    assert.equal(Number(row.dts), sample.pts);
    if (i) assert.equal(row.duration, 1024, "decoder AAC packet duration");
    // FFprobe may omit first packet duration and reports 1024 for the short
    // final raw sample. Never invent either BMFF duration from that diagnostic.
    packetEnd += sample.duration;
  }
  for (const row of frames) {
    assert.equal(Number(row.pts), decodedEnd, "decoded audio sample continuity");
    assert.equal(Number(row.best_effort_timestamp), decodedEnd);
    assert.equal(Number(row.duration), Number(row.nb_samples));
    decodedEnd += Number(row.nb_samples);
  }
  assert.equal(Number(frames[0].pts), 0);
  assert.equal(frames.length, samples.length - 1, "complete decoded audio scan");
  assert.ok(Math.abs(packetEnd - Math.round(expectedSeconds * 48000)) <= 1,
    "raw child audio length must equal proven source interval");
  assert.ok(decodedEnd >= packetEnd && decodedEnd - packetEnd <= CHILD_TOLERANCES.audioPaddingSamples,
    "decoded final AAC padding is explicit and bounded");
  return { raw_first_pts: -1024, decoded_first_pts: 0, raw_end_samples: packetEnd,
    decoded_end_samples: decodedEnd, tail_padding_samples: decodedEnd - packetEnd };
}

// Aperiodic source PCM makes a unique physical sample match. This search measures
// phase; it does not widen the allowed 48-sample residual to the search window.
export function measureAudioPhase(source, child, expectedStart, outputSample) {
  const count = 4096;
  assert.ok(outputSample + count <= child.length);
  const correlation = (lag, stride) => {
    let xy = 0, xx = 0, yy = 0;
    const at = expectedStart + outputSample + lag;
    if (at < 0 || at + count > source.length) return -1;
    for (let i = 0; i < count; i += stride) {
      const x = source[at + i], y = child[outputSample + i];
      xy += x * y; xx += x * x; yy += y * y;
    }
    return xy / Math.sqrt(xx * yy);
  };
  let best = { lag_samples: 0, correlation: -1 };
  for (let lag = -2048; lag <= 2048; lag += 8) {
    const score = correlation(lag, 8);
    if (score > best.correlation) best = { lag_samples: lag, correlation: score };
  }
  const coarse = best.lag_samples;
  best.correlation = -1;
  for (let lag = coarse - 8; lag <= coarse + 8; lag++) {
    const score = correlation(lag, 1);
    if (score > best.correlation) best = { lag_samples: lag, correlation: score };
  }
  return { output_sample: outputSample, expected_source_sample: expectedStart + outputSample,
    ...best, residual_ms: best.lag_samples / 48 };
}

export function verifyAudioPhase(measurements) {
  assert.ok(measurements.length >= 8, "interior sampled audio phase coverage");
  for (const row of measurements) {
    verifyAudioPhaseMeasurement(row);
  }
  return measurements;
}

function verifyAudioPhaseMeasurement(row) {
  assert.ok(row.correlation >= CHILD_TOLERANCES.audioCorrelationMinimum,
    "audio identity correlation below fixed threshold");
  assert.ok(Math.abs(row.lag_samples) <= CHILD_TOLERANCES.audioPhaseSamples,
    "wrong audio source origin/phase");
}

// Correlation samples the first/last 4096 *valid raw* presented samples. Encoder
// priming packets are absent from decoded PCM; decoded tail padding is excluded.
// This supplies boundary windows, not an identity check of every PCM sample.
export function verifyAudioEndpointIdentity({ source, child, expectedStart,
  sourceClock, childClock }) {
  assert.ok(Number.isSafeInteger(expectedStart) && expectedStart >= 0);
  for (const [name, clock, pcm] of [["source", sourceClock, source], ["child", childClock, child]]) {
    assert.ok(Number.isSafeInteger(clock.raw_end_samples) && clock.raw_end_samples >= 4096,
      `${name} raw PCM bound`);
    assert.equal(pcm.length, clock.decoded_end_samples,
      `${name} decoded PCM length disagrees with proven decoded sample count`);
    assert.ok(clock.decoded_end_samples >= clock.raw_end_samples
      && clock.decoded_end_samples - clock.raw_end_samples <= CHILD_TOLERANCES.audioPaddingSamples,
      `${name} explicit decoder tail padding`);
  }
  assert.equal(expectedStart + childClock.raw_end_samples, sourceClock.raw_end_samples,
    "selected raw PCM interval must finish at the proven source end");
  const validSource = source.subarray(0, sourceClock.raw_end_samples);
  const validChild = child.subarray(0, childClock.raw_end_samples);
  const endpoints = [0, childClock.raw_end_samples - 4096].map((at) =>
    measureAudioPhase(validSource, validChild, expectedStart, at));
  endpoints.forEach(verifyAudioPhaseMeasurement);
  return { window_samples: 4096, endpoints,
    source_valid_samples: sourceClock.raw_end_samples,
    child_valid_samples: childClock.raw_end_samples,
    source_tail_padding_excluded: sourceClock.decoded_end_samples - sourceClock.raw_end_samples,
    child_tail_padding_excluded: childClock.decoded_end_samples - childClock.raw_end_samples,
    priming_boundary: "Raw -1024/skip-1024 AAC packets are not PCM; decoded presented sample zero is compared without another skip",
    coverage: "First and last valid raw PCM windows plus separate sampled interior phase evidence; not every-sample content identity" };
}
