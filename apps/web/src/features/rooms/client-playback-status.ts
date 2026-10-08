import {
  target,
  type PlaybackState,
} from "../../../../../packages/sync-engine";

/** Decoder elapsed time has no verified room-time mapping for live-edge mode. */
export function clientPlaybackStatus(
  state: PlaybackState,
  nowMs: number,
  positionSeconds: number,
  buffering: boolean,
): { buffering: boolean; drift_ms?: number } {
  const status: { buffering: boolean; drift_ms?: number } = { buffering };
  if (!state.live) {
    const drift = target(state, nowMs) - positionSeconds * 1000;
    if (Number.isFinite(drift)) status.drift_ms = drift;
  }
  return status;
}
