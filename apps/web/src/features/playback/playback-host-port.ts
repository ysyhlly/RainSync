import type { DeepReadonly, Ref } from "vue";
import type { RoomState } from "../../../../../packages/protocol";
import type { Room, RoomPermission } from "../../shared/api/types";
import type { createPlaybackRuntime } from "./playback-runtime";
import type { PlaybackControlsPort } from "./playback-controls-port";
import type { PlaybackSettingsPort } from "./playback-settings-port";
import type { RuntimeErrorNotice } from "./room-notice";

type PlaybackOwner = ReturnType<typeof createPlaybackRuntime>;
type HostPermission = Extract<
  RoomPermission,
  "play" | "pause" | "seek" | "set_rate" | "change_media"
>;
type HostContext = {
  timeline: {
    room: Readonly<Ref<Readonly<Pick<Room, "id" | "name">> | null>>;
    state: Readonly<Ref<Readonly<Pick<RoomState, "media_id">> | null>>;
    connected: Readonly<Ref<boolean>>;
    connectionStopped: Readonly<Ref<boolean>>;
    roomActive: Readonly<Ref<boolean>>;
    currentTitle: Readonly<Ref<string>>;
  };
  playback: DeepReadonly<
    Pick<
      PlaybackOwner,
      | "blocked"
      | "dragging"
      | "duration"
      | "live"
      | "nativePlatform"
      | "platformDanmakuEnabled"
      | "platformDanmakuCues"
      | "subtitles"
      | "sessionId"
      | "preparation"
      | "loadingStage"
      | "startupDiagnostics"
      | "recoveryState"
      | "recoveryLabel"
    >
  > &
    Pick<PlaybackOwner, "waiting" | "subtitleIndex">;
  notice: {
    error: Readonly<Ref<string>>;
    errorNotice: Readonly<Ref<RuntimeErrorNotice | undefined>>;
  };
  actions: Readonly<
    Pick<
      PlaybackOwner,
      | "attach"
      | "runPlayback"
      | "enablePlayback"
      | "loadMedia"
      | "cancelPreparation"
      | "applySubtitles"
    > & {
      can: (permission: HostPermission) => boolean;
      send: (type: "SEEK", payload: { position_ms: number }) => boolean;
      dismissError: (notice: RuntimeErrorNotice | undefined) => void;
    }
  >;
  playbackControls: PlaybackControlsPort;
  playbackSettings: PlaybackSettingsPort;
};

/** The permanent Host owns DOM lifetime. This passive view only delegates its
 * finite playback/room effects to the existing owners and Pinia actions. */
export function createPlaybackHostPort(ctx: HostContext) {
  const information = {
    get recoveryLabel() {
      return ctx.playback.recoveryLabel.value;
    },
  };
  const notice = {
    get error() {
      return ctx.notice.error.value;
    },
    get errorNotice() {
      return ctx.notice.errorNotice.value;
    },
    get preparation() {
      return ctx.playback.preparation.value;
    },
    get dismissError() {
      return ctx.actions.dismissError;
    },
  };
  const port = {
    get room() {
      return ctx.timeline.room.value;
    },
    get state() {
      return ctx.timeline.state.value;
    },
    get connected() {
      return ctx.timeline.connected.value;
    },
    get connectionStopped() {
      return ctx.timeline.connectionStopped.value;
    },
    get roomActive() {
      return ctx.timeline.roomActive.value;
    },
    get currentTitle() {
      return ctx.timeline.currentTitle.value;
    },
    get waiting() {
      return ctx.playback.waiting.value;
    },
    get blocked() {
      return ctx.playback.blocked.value;
    },
    get dragging() {
      return ctx.playback.dragging.value;
    },
    get duration() {
      return ctx.playback.duration.value;
    },
    get live() {
      return ctx.playback.live.value;
    },
    get nativePlatform() {
      return ctx.playback.nativePlatform.value;
    },
    get platformDanmakuEnabled() {
      return ctx.playback.platformDanmakuEnabled.value;
    },
    get platformDanmakuCues() {
      return ctx.playback.platformDanmakuCues.value;
    },
    get subtitles() {
      return ctx.playback.subtitles.value;
    },
    get subtitleIndex() {
      return ctx.playback.subtitleIndex.value;
    },
    get sessionId() {
      return ctx.playback.sessionId.value;
    },
    get preparation() {
      return ctx.playback.preparation.value;
    },
    get loadingStage() {
      return ctx.playback.loadingStage.value;
    },
    get startupDiagnostics() {
      return ctx.playback.startupDiagnostics.value;
    },
    get recoveryState() {
      return ctx.playback.recoveryState.value;
    },
    information,
    notice,
    get playbackControls() {
      return ctx.playbackControls;
    },
    get playbackSettings() {
      return ctx.playbackSettings;
    },
    get can() {
      return ctx.actions.can;
    },
    get attach() {
      return ctx.actions.attach;
    },
    get applySubtitles() {
      return ctx.actions.applySubtitles;
    },
    setWaiting(value: boolean) {
      ctx.playback.waiting.value = value;
    },
    joinPlayback() {
      return ctx.actions.runPlayback(ctx.actions.enablePlayback);
    },
    retryPlayback() {
      return ctx.actions.runPlayback(ctx.actions.loadMedia);
    },
    cancelPlayback() {
      return ctx.actions.runPlayback(ctx.actions.cancelPreparation);
    },
    closeSubtitles() {
      ctx.playback.subtitleIndex.value = undefined;
      ctx.actions.applySubtitles();
    },
    seekDanmaku(at: number) {
      if (
        ctx.actions.can("seek") &&
        ctx.timeline.connected.value &&
        !ctx.playback.live.value &&
        ctx.timeline.state.value?.media_id &&
        at < ctx.playback.duration.value * 1000
      )
        ctx.actions.send("SEEK", { position_ms: at });
    },
  };
  return port as DeepReadonly<typeof port>;
}

export type PlaybackHostPort = ReturnType<typeof createPlaybackHostPort>;
export type PlaybackInformationView = PlaybackHostPort["information"];
