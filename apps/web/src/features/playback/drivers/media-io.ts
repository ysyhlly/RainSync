/** Transparent rate I/O for the one existing readback tracker. */
export type PlaybackRateIO = Pick<HTMLVideoElement, "playbackRate">;
export type VodMediaFacts = Readonly<
  Pick<
    HTMLVideoElement,
    | "currentTime"
    | "seekable"
    | "buffered"
    | "ended"
    | "paused"
    | "seeking"
    | "readyState"
  >
>;
export type VodMediaPort = Readonly<{
  facts: VodMediaFacts;
  seek: (position: number) => void;
}>;
type PlaybackMediaIO = VodMediaPort & Readonly<{ rate: PlaybackRateIO }>;

/** Passive views of the permanent element. Invocation qualification belongs to
 * the synchronization owner; SDK readiness and grant policy do not live here. */
export function createPlaybackMediaIO(
  element: HTMLVideoElement,
): PlaybackMediaIO {
  return {
    facts: element,
    rate: element,
    seek: (position) => {
      element.currentTime = position;
    },
  };
}
