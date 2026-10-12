import type { Ref } from "vue";
import type { RoomState } from "../../../../../packages/protocol";
import type { PlaybackPreparationState } from "./playback-preparation";
import type { PlaybackLoadingStage } from "./playback-runtime-types";

type ControlPermission = "play" | "pause" | "seek" | "set_rate";
type ControlState = Readonly<
  Pick<RoomState, "media_id" | "playback_status" | "playback_rate">
>;

/** A live view over existing owners. The control strip never receives a store,
 * mutable room projection, media element or playback-session authority. */
export function createPlaybackControlsPort(ctx: {
  timeline: {
    state: Readonly<Ref<ControlState | null>>;
    connected: Readonly<Ref<boolean>>;
    can: (permission: ControlPermission) => boolean;
  };
  playback: {
    duration: Readonly<Ref<number>>;
    position: Ref<number>;
    dragging: Ref<boolean>;
    live: Readonly<Ref<boolean>>;
    preparation: Readonly<
      Ref<Readonly<Pick<PlaybackPreparationState, "phase">>>
    >;
    loadingStage: Readonly<Ref<PlaybackLoadingStage>>;
    setLocalVolume: (volume: number) => void;
    setLocalMuted: (muted: boolean) => void;
  };
  commands: {
    play: () => boolean;
    pause: () => boolean;
    setRate: (rate: number) => boolean;
    seek: (event: Event) => void;
  };
}) {
  return {
    get state() {
      return ctx.timeline.state.value;
    },
    get connected() {
      return ctx.timeline.connected.value;
    },
    get duration() {
      return ctx.playback.duration.value;
    },
    get position() {
      return ctx.playback.position.value;
    },
    get dragging() {
      return ctx.playback.dragging.value;
    },
    get live() {
      return ctx.playback.live.value;
    },
    get preparationPhase() {
      return ctx.playback.preparation.value.phase;
    },
    get loadingStage() {
      return ctx.playback.loadingStage.value;
    },
    can: ctx.timeline.can,
    togglePlayback() {
      return ctx.timeline.state.value?.playback_status === "playing"
        ? ctx.commands.pause()
        : ctx.commands.play();
    },
    setRate: ctx.commands.setRate,
    seek: ctx.commands.seek,
    setDragging(value: boolean) {
      ctx.playback.dragging.value = value;
    },
    // The component marks dragging before it reads/converts the input value.
    previewSeek(value: number) {
      ctx.playback.position.value = value;
    },
    setLocalVolume: ctx.playback.setLocalVolume,
    setLocalMuted: ctx.playback.setLocalMuted,
  };
}

export type PlaybackControlsPort = Readonly<
  ReturnType<typeof createPlaybackControlsPort>
>;
