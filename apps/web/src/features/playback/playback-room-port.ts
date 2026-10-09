import type { DeepReadonly, Ref } from "vue";
import type { createPlaybackRuntime } from "./playback-runtime";

type PlaybackOwner = ReturnType<typeof createPlaybackRuntime>;
type RoomContext = {
  playback: DeepReadonly<
    Pick<
      PlaybackOwner,
      | "nativePlaybackMode"
      | "duration"
      | "live"
      | "audioIndex"
      | "recoveryLabel"
      | "peerSharing"
      | "peerStats"
    > & {
      playbackSummary: Ref<
        | Pick<NonNullable<PlaybackOwner["playbackSummary"]["value"]>, "mode">
        | undefined
      >;
      distributedFacts: Ref<
        | Pick<
            NonNullable<PlaybackOwner["distributedFacts"]["value"]>,
            "job_id"
          >
        | undefined
      >;
    }
  >;
  actions: Readonly<
    Pick<
      PlaybackOwner,
      | "useDistributedOutput"
      | "useOriginalSource"
      | "startPeerSharing"
      | "stopPeerSharing"
    >
  >;
};

/** Passive RoomPage facts and original action references. The playback and
 * peer owners retain source switching, consent, preparation and cleanup. */
export function createPlaybackRoomPort(ctx: RoomContext) {
  const port = {
    get nativePlaybackMode() {
      return ctx.playback.nativePlaybackMode.value;
    },
    get duration() {
      return ctx.playback.duration.value;
    },
    get live() {
      return ctx.playback.live.value;
    },
    get audioIndex() {
      return ctx.playback.audioIndex.value;
    },
    get playbackSummary() {
      return ctx.playback.playbackSummary.value;
    },
    get recoveryLabel() {
      return ctx.playback.recoveryLabel.value;
    },
    get distributedFacts() {
      return ctx.playback.distributedFacts.value;
    },
    get peerSharing() {
      return ctx.playback.peerSharing.value;
    },
    get peerStats() {
      return ctx.playback.peerStats.value;
    },
    get useDistributedOutput() {
      return ctx.actions.useDistributedOutput;
    },
    get useOriginalSource() {
      return ctx.actions.useOriginalSource;
    },
    get startPeerSharing() {
      return ctx.actions.startPeerSharing;
    },
    get stopPeerSharing() {
      return ctx.actions.stopPeerSharing;
    },
  };
  return port as DeepReadonly<typeof port>;
}

export type PlaybackRoomPort = ReturnType<typeof createPlaybackRoomPort>;
