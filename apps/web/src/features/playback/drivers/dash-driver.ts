import {
  createDashPlayback,
  type DashPlaybackOptions,
} from "../../../../../../packages/player-core/dash";
export type {
  DashPlaybackError,
  DashPlaybackSnapshot,
} from "../../../../../../packages/player-core/dash";

/** Only the original source and media facts enter the existing adapter. */
export type DashDriverOptions = Pick<
  DashPlaybackOptions,
  | "video"
  | "sessionId"
  | "playbackUrl"
  | "origin"
  | "onStatus"
  | "onSourceAttached"
  | "onError"
> & { current: () => boolean };

export function createDashDriver(options: DashDriverOptions) {
  const {
    video,
    sessionId,
    playbackUrl,
    origin,
    current,
    onStatus,
    onSourceAttached,
    onError,
  } = options;
  // The adapter remains the single SDK/interceptor/generation owner. Copy only
  // this immutable attachment's inputs, never retain a mutable options object.
  const { load, destroy } = createDashPlayback({
    video,
    sessionId,
    playbackUrl,
    origin,
    current,
    onStatus,
    onSourceAttached,
    onError,
  });
  return { load, destroy };
}
export type DashDriver = ReturnType<typeof createDashDriver>;
