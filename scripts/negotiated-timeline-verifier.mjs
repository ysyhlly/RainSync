// Owned-fixture verifier, not a general media admission policy. A visible RST1
// source clock is independent of both the requested seek and output timestamps.
import assert from "node:assert/strict";

export const OUTPUT_FPS = 30;
export const MAX_SOURCE_INTERVAL_MS = 80;
export const PROBE_ROUNDING_MS = 0.01;

export function verifySourceClock({
  frames,
  formatStartMs,
  videoStartMs,
  selectedAudioStartMs,
}) {
  assert.ok(frames.length > 2, "source clock needs decoded frame observations");
  for (const [name, start] of Object.entries({
    formatStartMs,
    videoStartMs,
    ...(selectedAudioStartMs === null ? {} : { selectedAudioStartMs }),
  }))
    assert.ok(
      Number.isFinite(start) && Math.abs(start) <= PROBE_ROUNDING_MS,
      `unestablished zero source origin: ${name}=${start}`,
    );
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    assert.ok(Number.isFinite(frame.source_pts_ms), "missing source PTS");
    assert.ok(
      Math.abs(frame.source_pts_ms - frame.original_position_ms) <=
        PROBE_ROUNDING_MS,
      "source PTS disagrees with independent visible clock",
    );
    if (i) {
      const gap = frame.source_pts_ms - frames[i - 1].source_pts_ms;
      assert.ok(
        gap > 0 && gap <= MAX_SOURCE_INTERVAL_MS + PROBE_ROUNDING_MS,
        "undeclared source timestamp jump/nonmonotonicity",
      );
    }
  }
  return true;
}

export function verifyOutputTimeline({
  startMs,
  sourceFrames,
  samples,
  outputFrames,
  timeBase,
}) {
  assert.ok(Number.isFinite(startMs) && startMs >= 0);
  const [num, den] = timeBase.split("/").map(Number);
  const tickMs = (num / den) * 1000;
  assert.ok(
    Number.isFinite(tickMs) && tickMs > 0 && tickMs <= 1,
    "unsupported output timebase",
  );
  assert.ok(
    outputFrames.length > 120 && samples.length >= 5,
    "insufficient later/boundary coverage",
  );
  for (let i = 0; i < outputFrames.length; i++) {
    const pts = outputFrames[i];
    assert.ok(
      Number.isFinite(pts) &&
        Math.abs(pts - (i * 1000) / OUTPUT_FPS) <= tickMs + PROBE_ROUNDING_MS,
      "output does not have the promised zero-based continuous CFR clock",
    );
  }
  const indices = samples.map((sample) => sample.output_frame_index);
  assert.equal(
    new Set(indices).size,
    indices.length,
    "duplicate sampled output frame",
  );
  for (const required of [0, 45, 119, 120, 121])
    assert.ok(
      indices.includes(required),
      "missing first/later/segment-boundary sample",
    );
  const times = sourceFrames.map((f) => f.original_position_ms);
  const checks = [];
  for (const sample of samples) {
    assert.ok(
      Number.isSafeInteger(sample.output_frame_index) &&
        sample.output_frame_index >= 0,
    );
    const outputMs = outputFrames[sample.output_frame_index];
    assert.ok(Number.isFinite(outputMs), "sample outside output");
    const target = startMs + outputMs;
    assert.ok(
      target <= times.at(-1) + MAX_SOURCE_INTERVAL_MS,
      "output outlives source clock",
    );
    // Exact decode/discard: first visible source frame must be the first frame
    // at/after the requested point. Later CFR30 resampling may choose only the
    // immediate source neighbors. No ±N-frame search, PSNR threshold or widened
    // millisecond tolerance is allowed, including the first frame of a segment.
    const later = times.find((t) => t >= target - PROBE_ROUNDING_MS);
    const earlier = times.findLast((t) => t <= target + PROBE_ROUNDING_MS);
    const allowed = [
      ...new Set(sample.output_frame_index === 0 ? [later] : [earlier, later]),
    ].filter(Number.isFinite);
    assert.ok(
      allowed.includes(sample.original_position_ms),
      `wrong source frame at output ${sample.output_frame_index}: observed=${sample.original_position_ms}, target=${target}, allowed=${allowed}`,
    );
    assert.ok(
      sourceFrames.some(
        (f) =>
          f.frame_index === sample.frame_index &&
          f.original_position_ms === sample.original_position_ms,
      ),
      "sample identity absent from decoded source",
    );
    checks.push({
      ...sample,
      output_pts_ms: outputMs,
      target_source_ms: target,
      allowed_source_ms: allowed,
      residual_ms: sample.original_position_ms - target,
    });
  }
  return checks;
}
