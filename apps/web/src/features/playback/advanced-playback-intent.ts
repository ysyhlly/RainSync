import type {
  AdvancedPlaybackCapabilities,
  AdvancedPlaybackRequest,
  PlaybackPlan,
} from "../../../../../packages/protocol";

const codecs = new Set(["ass", "ssa", "pgs"]);
const uint32 = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 0xffffffff;

export function validAdvancedPlaybackCapabilities(
  value: unknown,
): value is AdvancedPlaybackCapabilities {
  if (!value || typeof value !== "object") return false;
  const caps = value as AdvancedPlaybackCapabilities;
  if (
    caps.schema_version !== 1 ||
    typeof caps.tone_map_hdr !== "boolean" ||
    caps.worker_runtime_required !== true ||
    !Array.isArray(caps.subtitle_streams) ||
    caps.subtitle_streams.length > 256
  )
    return false;
  const seen = new Set<number>();
  return caps.subtitle_streams.every((track) => {
    if (
      !track ||
      !uint32(track.index) ||
      seen.has(track.index) ||
      !codecs.has(track.codec) ||
      typeof track.label !== "string" ||
      track.label.length > 512 ||
      typeof track.language !== "string" ||
      track.language.length > 64
    )
      return false;
    seen.add(track.index);
    return true;
  });
}

/** One frozen per-viewer transform intent, never a filter or hardware choice. */
export function advancedPlaybackRequest(
  intent: { toneMapHdr: boolean; subtitleStreamIndex?: number },
  caps: AdvancedPlaybackCapabilities | undefined,
): AdvancedPlaybackRequest | undefined {
  if (!intent.toneMapHdr && intent.subtitleStreamIndex === undefined) return;
  if (
    !validAdvancedPlaybackCapabilities(caps) ||
    (intent.toneMapHdr && !caps.tone_map_hdr) ||
    (intent.subtitleStreamIndex !== undefined &&
      (!uint32(intent.subtitleStreamIndex) ||
        !caps.subtitle_streams.some(
          (track) => track.index === intent.subtitleStreamIndex,
        ))) ||
    (caps.tone_map_hdr &&
      intent.subtitleStreamIndex !== undefined &&
      !intent.toneMapHdr)
  )
    throw new Error("当前片源不支持所选高级播放选项，请重新加载片源信息");
  return Object.freeze({
    schema_version: 1,
    tone_map_hdr: intent.toneMapHdr,
    subtitle_stream_index: intent.subtitleStreamIndex ?? null,
  });
}

export function sameAdvancedPlaybackRequest(
  first: AdvancedPlaybackRequest | undefined,
  second: AdvancedPlaybackRequest | undefined,
): boolean {
  return first === undefined
    ? second === undefined
    : second !== undefined &&
        first.schema_version === 1 &&
        second.schema_version === 1 &&
        first.tone_map_hdr === second.tone_map_hdr &&
        first.subtitle_stream_index === second.subtitle_stream_index;
}

/** A new client must reject an old server silently dropping a transform. */
export function matchesAdvancedPlaybackPlan(
  request: AdvancedPlaybackRequest | undefined,
  plan: Pick<
    PlaybackPlan,
    | "advanced_playback"
    | "delivery_mode"
    | "transport"
    | "subtitle_mode"
    | "selected_candidate_id"
  >,
): boolean {
  if (!request) return plan.advanced_playback === undefined;
  const facts = plan.advanced_playback;
  return (
    !!facts &&
    sameAdvancedPlaybackRequest(request, facts.request) &&
    facts.video_basis === "constrained_encoder_recipe" &&
    plan.delivery_mode === "transcode" &&
    plan.transport === "hls" &&
    plan.selected_candidate_id === "transcode_720p" &&
    (request.subtitle_stream_index === null
      ? facts.subtitle_codec === null && plan.subtitle_mode !== "burned_in"
      : codecs.has(facts.subtitle_codec ?? "") &&
        plan.subtitle_mode === "burned_in")
  );
}
