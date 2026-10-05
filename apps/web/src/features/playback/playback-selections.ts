import type {
  MediaTrack,
  PlaybackPlan,
  PlaybackRequest,
} from "../../../../../packages/protocol";
import type { SelectOption, SelectValue } from "../../shared/ui/select";

export type PlaybackSelectionInput = {
  audioIndex?: SelectValue;
  subtitleIndex?: SelectValue;
};
export type PlaybackSelectionParameters = {
  request: Pick<PlaybackRequest, "audio_index">;
  /** Local WebVTT selection; never a playback-session request field. */
  subtitleIndex: number | undefined;
};
export type PlaybackQualityPlan = Pick<
  PlaybackPlan,
  | "delivery_mode"
  | "decision_reason"
  | "selected_candidate_id"
  | "selected_output"
>;

function validIndex(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffffffff
  );
}

/** Provider indices are IDs, not positions. Ambiguous IDs cannot be selected. */
function availableTracks(
  tracks: readonly MediaTrack[],
  subtitle = false,
): MediaTrack[] {
  const counts = new Map<number, number>();
  for (const track of tracks)
    counts.set(track.index, (counts.get(track.index) ?? 0) + 1);
  return tracks.filter(
    (track) =>
      validIndex(track.index) &&
      counts.get(track.index) === 1 &&
      (!subtitle ||
        (typeof track.url === "string" && track.url.trim().length > 0)),
  );
}

function trackOption(track: MediaTrack, kind: "音轨" | "字幕"): SelectOption {
  const label = track.label.trim() || `${kind} ${track.index}`;
  const language = track.language.trim();
  return {
    value: track.index,
    label: language ? `${label} · ${language}` : label,
  };
}

export function audioSelectionOptions(
  tracks: readonly MediaTrack[],
): SelectOption[] {
  const available = availableTracks(tracks);
  return available.length
    ? [
        { value: null, label: "自动选择" },
        ...available.map((track) => trackOption(track, "音轨")),
      ]
    : [];
}

export function subtitleSelectionOptions(
  tracks: readonly MediaTrack[],
): SelectOption[] {
  const available = availableSubtitleTracks(tracks);
  return available.length
    ? [
        { value: null, label: "关闭" },
        ...available.map((track) => trackOption(track, "字幕")),
      ]
    : [];
}

/** The rendered track list must agree with selectable, unambiguous IDs. */
export function availableSubtitleTracks(
  tracks: readonly MediaTrack[],
): MediaTrack[] {
  return availableTracks(tracks, true);
}

export class PlaybackSelectionError extends Error {
  constructor(readonly field: "audioIndex" | "subtitleIndex") {
    super(
      field === "audioIndex"
        ? "此音轨已不可用，请重新选择"
        : "此字幕已不可用，请重新选择",
    );
    this.name = "PlaybackSelectionError";
  }
}

/** Call with the latest plan's tracks. Never coerce strings to provider IDs. */
export function buildPlaybackSelectionParameters(
  input: PlaybackSelectionInput,
  availability: Pick<PlaybackPlan, "audio_tracks" | "subtitle_tracks">,
): PlaybackSelectionParameters {
  const audio = input.audioIndex == null ? undefined : input.audioIndex;
  const subtitle =
    input.subtitleIndex == null ? undefined : input.subtitleIndex;
  if (
    audio !== undefined &&
    (!validIndex(audio) ||
      !availableTracks(availability.audio_tracks).some(
        (track) => track.index === audio,
      ))
  )
    throw new PlaybackSelectionError("audioIndex");
  if (
    subtitle !== undefined &&
    (!validIndex(subtitle) ||
      !availableTracks(availability.subtitle_tracks, true).some(
        (track) => track.index === subtitle,
      ))
  )
    throw new PlaybackSelectionError("subtitleIndex");
  return {
    request: { audio_index: audio ?? null },
    subtitleIndex: subtitle as number | undefined,
  };
}

/** A selected configuration is a fact about this plan, never a quality menu. */
export function describePlaybackQuality(
  plan?: PlaybackQualityPlan,
): string | undefined {
  const output = plan?.selected_output;
  const configuration = output?.configuration;
  if (
    !plan?.selected_candidate_id ||
    !configuration ||
    configuration.id !== plan.selected_candidate_id ||
    configuration.delivery_mode !== plan.delivery_mode ||
    plan.decision_reason !== `actual_media_${configuration.id}` ||
    (output?.video_basis !== "source_probe" &&
      output?.video_basis !== "constrained_encoder_recipe")
  )
    return;
  const { width, height } = configuration.video;
  if (
    ![width, height].every(
      (value) => Number.isInteger(value) && value > 0 && value <= 16384,
    )
  )
    return;
  return `${width}×${height}（${output.video_basis === "source_probe" ? "片源配置" : "编码目标"}）`;
}
