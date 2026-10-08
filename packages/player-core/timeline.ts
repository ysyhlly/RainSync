import type { PlaybackPlan } from "../protocol";

/** Validate the existing scalar contract, never derive an origin from a seek.
 * A nonzero origin is reserved for the server's exact decoded/cropped local HLS
 * job. Full upstream manifests retain zero; arbitrary discontinuity mapping
 * requires a future measured contract and is not inferred by this client. */
export function hasUsablePlaybackTimeline(plan: PlaybackPlan): boolean {
  const origin = plan.timeline_origin_ms;
  const duration = plan.duration_ms;
  return (
    Number.isFinite(origin) &&
    origin >= 0 &&
    (duration == null ||
      (Number.isFinite(duration) && duration >= 0 && origin <= duration)) &&
    (origin === 0 ||
      (plan.distributed_compute?.schema_version === 1 &&
        origin <= 1 &&
        plan.transport === "hls" &&
        plan.rebuild_on_seek === false &&
        plan.duration_ms === plan.distributed_compute.source_duration_ms &&
        Number.isFinite(plan.distributed_compute.source_duration_ms) &&
        plan.distributed_compute.source_duration_ms > origin) ||
      (plan.rebuild_on_seek === true &&
        plan.transport === "hls" &&
        plan.delivery_mode === "transcode"))
  );
}
