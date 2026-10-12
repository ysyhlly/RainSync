import type { DeepReadonly } from "vue";
import type { createPlaybackRuntime } from "./playback-runtime";

type PlaybackOwner = ReturnType<typeof createPlaybackRuntime>;
type SettingsContext = {
  playback: Pick<
    PlaybackOwner,
    | "advancedCapabilities"
    | "advancedFacts"
    | "audioIndex"
    | "burnInSubtitleIndex"
    | "ladderCapabilities"
    | "ladderFacts"
    | "ladderManual"
    | "ladderQuality"
    | "ladderSelected"
    | "live"
    | "localHlsLadderEnabled"
    | "mode"
    | "nativeCredentialMode"
    | "nativeEncodedHeight"
    | "nativeLadderRenditions"
    | "nativePlatform"
    | "nativePlaybackMode"
    | "nativeProvider"
    | "nativeQualityMaxHeight"
    | "nativeQualityOptions"
    | "nativeQualitySelectedHeight"
    | "platformDanmakuEnabled"
    | "platformDanmakuStatus"
    | "platformLiveDanmakuMode"
    | "platformSubtitleId"
    | "platformSubtitleStatus"
    | "platformSubtitleTracks"
    | "platformTextError"
    | "platformTextLive"
    | "playbackSummary"
    | "startupDiagnostics"
    | "staticHlsAvailability"
    | "staticHlsAvailabilityText"
    | "staticHlsFallbackEnabled"
    | "subtitleIndex"
    | "subtitles"
    | "toneMapHdr"
    | "tracks"
    | "upstreamMeasuredMatchesRequested"
    | "upstreamMeasuredOutput"
  >;
  actions: Readonly<
    Pick<
      PlaybackOwner,
      | "runPlayback"
      | "loadMedia"
      | "applySubtitles"
      | "selectNativeQuality"
      | "selectLadderQuality"
      | "selectPlatformSubtitle"
      | "setPlatformDanmaku"
      | "setPlatformLiveDanmaku"
    >
  >;
  hasMedia: () => boolean;
};

/** Live facts and named settings operations over the existing owners. */
export function createPlaybackSettingsPort(ctx: SettingsContext) {
  const port = {
    get hasMedia() {
      return ctx.hasMedia();
    },
    get advancedCapabilities() {
      return ctx.playback.advancedCapabilities.value;
    },
    get advancedFacts() {
      return ctx.playback.advancedFacts.value;
    },
    get audioIndex() {
      return ctx.playback.audioIndex.value;
    },
    get burnInSubtitleIndex() {
      return ctx.playback.burnInSubtitleIndex.value;
    },
    get ladderCapabilities() {
      return ctx.playback.ladderCapabilities.value;
    },
    get ladderFacts() {
      return ctx.playback.ladderFacts.value;
    },
    get ladderManual() {
      return ctx.playback.ladderManual.value;
    },
    get ladderQuality() {
      return ctx.playback.ladderQuality.value;
    },
    get ladderSelected() {
      return ctx.playback.ladderSelected.value;
    },
    get live() {
      return ctx.playback.live.value;
    },
    get localHlsLadderEnabled() {
      return ctx.playback.localHlsLadderEnabled.value;
    },
    get mode() {
      return ctx.playback.mode.value;
    },
    get nativeCredentialMode() {
      return ctx.playback.nativeCredentialMode.value;
    },
    get nativeEncodedHeight() {
      return ctx.playback.nativeEncodedHeight.value;
    },
    get nativeLadderRenditions() {
      return ctx.playback.nativeLadderRenditions.value;
    },
    get nativePlatform() {
      return ctx.playback.nativePlatform.value;
    },
    get nativePlaybackMode() {
      return ctx.playback.nativePlaybackMode.value;
    },
    get nativeProvider() {
      return ctx.playback.nativeProvider.value;
    },
    get nativeQualityMaxHeight() {
      return ctx.playback.nativeQualityMaxHeight.value;
    },
    get nativeQualityOptions() {
      return ctx.playback.nativeQualityOptions.value;
    },
    get nativeQualitySelectedHeight() {
      return ctx.playback.nativeQualitySelectedHeight.value;
    },
    get platformDanmakuEnabled() {
      return ctx.playback.platformDanmakuEnabled.value;
    },
    get platformDanmakuStatus() {
      return ctx.playback.platformDanmakuStatus.value;
    },
    get platformLiveDanmakuMode() {
      return ctx.playback.platformLiveDanmakuMode.value;
    },
    get platformSubtitleId() {
      return ctx.playback.platformSubtitleId.value;
    },
    get platformSubtitleStatus() {
      return ctx.playback.platformSubtitleStatus.value;
    },
    get platformSubtitleTracks() {
      return ctx.playback.platformSubtitleTracks.value;
    },
    get platformTextError() {
      return ctx.playback.platformTextError.value;
    },
    get platformTextLive() {
      return ctx.playback.platformTextLive.value;
    },
    get playbackSummary() {
      return ctx.playback.playbackSummary.value;
    },
    get startupDiagnostics() {
      return ctx.playback.startupDiagnostics.value;
    },
    get staticHlsAvailability() {
      return ctx.playback.staticHlsAvailability.value;
    },
    get staticHlsAvailabilityText() {
      return ctx.playback.staticHlsAvailabilityText.value;
    },
    get staticHlsFallbackEnabled() {
      return ctx.playback.staticHlsFallbackEnabled.value;
    },
    get subtitleIndex() {
      return ctx.playback.subtitleIndex.value;
    },
    get subtitles() {
      return ctx.playback.subtitles.value;
    },
    get toneMapHdr() {
      return ctx.playback.toneMapHdr.value;
    },
    get tracks() {
      return ctx.playback.tracks.value;
    },
    get upstreamMeasuredMatchesRequested() {
      return ctx.playback.upstreamMeasuredMatchesRequested.value;
    },
    get upstreamMeasuredOutput() {
      return ctx.playback.upstreamMeasuredOutput.value;
    },

    stageMode(value: string) {
      ctx.playback.mode.value = value;
    },
    stageNativePlaybackMode(
      value: PlaybackOwner["nativePlaybackMode"]["value"],
    ) {
      ctx.playback.nativePlaybackMode.value = value;
    },
    stageNativeCredentialMode(
      value: PlaybackOwner["nativeCredentialMode"]["value"],
    ) {
      ctx.playback.nativeCredentialMode.value = value;
    },
    stageStaticHlsFallback(value: boolean) {
      ctx.playback.staticHlsFallbackEnabled.value = value;
    },
    stageLocalHlsLadder(value: boolean) {
      ctx.playback.localHlsLadderEnabled.value = value;
    },
    stageToneMapHdr(value: boolean) {
      ctx.playback.toneMapHdr.value = value;
    },
    stageBurnInSubtitle(value: number | undefined) {
      ctx.playback.burnInSubtitleIndex.value = value;
    },
    chooseAudio(value: number | undefined) {
      ctx.playback.audioIndex.value = value;
      ctx.actions.runPlayback(ctx.actions.loadMedia);
    },
    chooseSubtitle(value: number | undefined) {
      ctx.playback.subtitleIndex.value = value;
      ctx.actions.applySubtitles();
    },
    reload() {
      return ctx.actions.runPlayback(ctx.actions.loadMedia);
    },
    chooseNativeQuality(value: string | undefined) {
      return ctx.actions.runPlayback(() =>
        ctx.actions.selectNativeQuality(value),
      );
    },
    // These callbacks are read by the component while rendering. Returning the
    // action itself retains Vue's original render-captured event identity.
    get selectLadderQuality() {
      return ctx.actions.selectLadderQuality;
    },
    get selectPlatformSubtitle() {
      return ctx.actions.selectPlatformSubtitle;
    },
    get setPlatformDanmaku() {
      return ctx.actions.setPlatformDanmaku;
    },
    get setPlatformLiveDanmaku() {
      return ctx.actions.setPlatformLiveDanmaku;
    },
  };
  return port as DeepReadonly<typeof port>;
}
export type PlaybackSettingsPort = ReturnType<
  typeof createPlaybackSettingsPort
>;
