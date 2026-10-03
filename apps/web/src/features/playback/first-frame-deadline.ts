import {
  bindPresentedFrame,
  type PresentedFrame,
} from "../../../../../packages/player-core/presentation";

export const FIRST_FRAME_TIMEOUT_MS = 20_000;

/** A route's foreground, expected-playing budget starts only after readiness.
 * Queue/preparation, explicit room pause, hidden document and actual autoplay
 * denial are separate waits. Neither usable data nor a pending play() completes
 * this budget. Source replacement preserves remaining time and cancels callbacks.
 * Timeout is an unknown presentation failure, never decoder-fallback authority. */
export function createFirstFrameDeadline(ctx: {
  element: HTMLVideoElement;
  current: () => boolean;
  suspended: () => boolean;
  eligible: () => boolean;
  timeout: () => void;
  presented?: (frame: PresentedFrame) => void;
  now?: () => number;
}) {
  const now = ctx.now ?? (() => performance.now());
  let active = true;
  let source: object | undefined;
  let binding: ReturnType<typeof bindPresentedFrame> | undefined;
  let remaining = FIRST_FRAME_TIMEOUT_MS;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clear() {
    if (timer !== undefined) {
      const elapsed = now() - startedAt;
      remaining =
        Number.isFinite(elapsed) && elapsed >= 0
          ? Math.max(0, remaining - elapsed)
          : 0;
      clearTimeout(timer);
      timer = undefined;
    }
  }
  function detachSource() {
    source = undefined;
    binding?.stop();
    binding = undefined;
    clear();
  }
  function stop() {
    active = false;
    detachSource();
  }
  function current() {
    if (!active) return false;
    if (ctx.current()) return true;
    stop();
    return false;
  }
  function sync() {
    if (!current() || !source) return;
    if (ctx.suspended()) {
      clear();
      return;
    }
    if (timer !== undefined) return;
    startedAt = now();
    const captured = source;
    timer = setTimeout(() => {
      remaining = 0;
      timer = undefined;
      if (!current() || source !== captured) return;
      if (ctx.suspended()) return;
      stop();
      ctx.timeout();
    }, remaining);
  }
  function attachSource() {
    detachSource();
    if (!current()) return;
    const captured = (source = {});
    binding = bindPresentedFrame({
      element: ctx.element,
      now,
      current: () => current() && source === captured,
      eligible: ctx.eligible,
      accept: (frame) => {
        if (!current() || source !== captured) return false;
        stop();
        ctx.presented?.(frame);
        return true;
      },
    });
    sync();
  }
  return { attachSource, detachSource, sync, stop };
}
