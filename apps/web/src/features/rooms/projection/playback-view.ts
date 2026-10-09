import type { createPlaybackRuntime } from "../../playback/playback-runtime";

type PlaybackRuntime = ReturnType<typeof createPlaybackRuntime>;
/** Explicit allowlist: adding owner internals never enlarges the page surface. */
const pageFields = [
  "runPlayback",
  "distributedFacts",
  "peerStats",
  "peerSharing",
  "useDistributedOutput",
  "useOriginalSource",
  "startPeerSharing",
  "stopPeerSharing",
  "waiting",
  "nativePlatform",
  "nativePlaybackMode",
  "live",
  "audioIndex",
  "duration",
  "position",
  "sessionId",
  "recoveryState",
  "playbackSummary",
  "recoveryLabel",
  "loadMedia",
  "attach",
] as const;
type PlaybackPageView = Pick<PlaybackRuntime, (typeof pageFields)[number]>;

/** Existing page aliases only; owner effects stay private. Each alias retires
 * with its consumer migration in docs/design/ROOM_RUNTIME_BOUNDARIES.md. */
export function createRoomPlaybackFacade(
  playback: PlaybackRuntime,
): PlaybackPageView {
  return Object.fromEntries(
    pageFields.map((key) => [key, playback[key]]),
  ) as PlaybackPageView;
}
