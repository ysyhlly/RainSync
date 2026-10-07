import type { PlaybackPlan, RoomState } from "../../../../../packages/protocol";
import type { PlaybackRateSupport } from "../../../../../packages/player-core";
import {
  availablePlaybackRanges,
  containsPlaybackPosition,
} from "../../../../../packages/player-core";
import { target } from "../../../../../packages/sync-engine";
import type { PlaybackRecoveryState } from "./playback-runtime-types";
export interface RecoverySnapshot {
  state: RoomState | null;
  element: HTMLVideoElement | undefined;
  plan: PlaybackPlan | undefined;
  active: boolean;
  foreground: boolean;
  clockReady: boolean;
  now: () => number;
  connected: boolean;
  error: string;
  blocked: boolean;
  waiting: boolean;
  ownsPlan: boolean;
  ownsLoad: boolean;
  pending: boolean;
  previous: PlaybackRecoveryState;
  terminalEnd: boolean;
  rates: PlaybackRateSupport | undefined;
  confirmedBaseRate: number | undefined;
  rejectedBaseRate: number | undefined;
  generatedEnd: number | undefined;
  generationWait: boolean;
  generationWaitFailed: boolean;
  recoveringHls: boolean;
  pendingForce: boolean;
  pendingUserSeek: boolean;
  pendingPlay: boolean;
  unsupportedRateError: string;
}
/** A synchronous snapshot projection: no rendering samples clocks or writes rates. */
export function evaluatePlaybackRecovery(input: RecoverySnapshot): {
  state: PlaybackRecoveryState;
  pending: boolean;
} {
  const {
    state: s,
    element: el,
    plan,
    rates,
    ownsPlan,
    ownsLoad,
    terminalEnd,
    rejectedBaseRate,
    confirmedBaseRate,
    generatedEnd,
    generationWait,
    generationWaitFailed,
    recoveringHls,
    pendingForce,
    pendingUserSeek,
    pendingPlay,
    unsupportedRateError,
  } = input;
  let recoveryPending = input.pending;
  let next: PlaybackRecoveryState;
  const prefixEnded = el?.ended && plan?.rebuild_on_seek && !terminalEnd;
  if (
    !input.active ||
    !s?.media_id ||
    !el ||
    (!ownsPlan && !ownsLoad) ||
    (ownsPlan && plan!.media_generation !== s.media_generation) ||
    (el.ended && !prefixEnded)
  ) {
    recoveryPending = false;
    next = "idle";
  } else if (plan?.native_platform?.live) {
    // Decoder-local edge/status recovery never compares a VOD room clock.
    next = input.error
      ? "failed"
      : !input.connected
        ? "reconnecting"
        : !input.foreground
          ? "background"
          : input.blocked
            ? "blocked"
            : input.waiting || el.readyState < 2 || pendingPlay
              ? "waiting"
              : "idle";
    recoveryPending = next !== "idle";
  } else if (rejectedBaseRate === s.playback_rate) {
    next = "unsupported_rate";
  } else if (input.error && input.error !== unsupportedRateError) {
    // Authentication/media failures stay in their existing error UI.
    next = "failed";
  } else if (!input.connected) {
    next = "reconnecting";
  } else if (!input.foreground) {
    next = "background";
  } else if (!input.clockReady) {
    next = "calibrating";
  } else if (prefixEnded) {
    // A growing HLS prefix ending is not a completed film or recovery.
    recoveryPending = true;
    next = "waiting";
  } else if (!recoveryPending) {
    next = "idle";
  } else if (input.blocked) {
    next = "blocked";
  } else if (
    !ownsPlan ||
    ownsLoad ||
    input.waiting ||
    el.readyState < 2 ||
    el.seeking ||
    generationWait ||
    generationWaitFailed ||
    recoveringHls ||
    pendingForce ||
    pendingUserSeek ||
    pendingPlay ||
    confirmedBaseRate !== s.playback_rate ||
    !rates?.baseSupported
  ) {
    next = "waiting";
  } else {
    const expected = Math.min(
      generatedEnd ?? Infinity,
      Math.max(0, (target(s, input.now()) - plan!.timeline_origin_ms) / 1000),
    );
    if (!containsPlaybackPosition(availablePlaybackRanges(el), expected)) {
      next = "waiting";
      return { state: next, pending: recoveryPending };
    }
    const drift = Math.abs(expected - el.currentTime) * 1000;
    const window = rates.fineUnsupported ? 500 : 150;
    const matchesStatus =
      s.playback_status === "playing" ? !el.paused : el.paused;
    if (matchesStatus && Number.isFinite(drift) && drift <= window) {
      recoveryPending = false;
      next = "idle";
    } else next = "catching_up";
  }

  return { state: next, pending: recoveryPending };
}
