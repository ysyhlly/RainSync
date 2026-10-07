/** One media-data budget belongs to the original plan, across native/MSE reattachment. */
export function createMediaDataDeadline(ctx: {
  element: HTMLVideoElement;
  current: () => boolean;
  suspended: () => boolean;
  ready: () => void;
  clearBlockedFailure: () => boolean;
  timeout: () => void;
  budgetMs?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let source: object | undefined;
  let ready = false;
  let timedOut = false;
  let stopped = false;
  let remainingMs = ctx.budgetMs ?? 20000;
  let startedAt = 0;
  let loadedData:
    ((this: GlobalEventHandlers, ev: Event) => unknown) | undefined;
  const current = (binding: object) =>
    source === binding && !stopped && ctx.current();
  function clearTimer() {
    if (timer !== undefined) {
      const elapsed = performance.now() - startedAt;
      remainingMs =
        Number.isFinite(elapsed) && elapsed >= 0
          ? Math.max(0, remainingMs - elapsed)
          : 0;
    }
    clearTimeout(timer);
    timer = undefined;
  }
  function sync() {
    const binding = source;
    if (!binding) return;
    if (!current(binding)) {
      stopped = true;
      source = undefined;
      clearTimer();
      return;
    }
    if (ctx.element.readyState >= 2) {
      ready = true;
      clearTimer();
      ctx.ready();
      return;
    }
    if (ctx.suspended()) {
      clearTimer();
      if (ctx.clearBlockedFailure()) timedOut = false;
      return;
    }
    if (ready || timedOut || timer !== undefined) return;
    startedAt = performance.now();
    timer = setTimeout(() => {
      remainingMs = 0;
      timer = undefined;
      if (!current(binding) || ctx.element.readyState >= 2 || ctx.suspended()) {
        sync();
        return;
      }
      timedOut = true;
      ctx.timeout();
    }, remainingMs);
  }
  function stop() {
    stopped = true;
    source = undefined;
    clearTimer();
    if (ctx.element.onloadeddata === loadedData)
      ctx.element.onloadeddata = null;
    loadedData = undefined;
  }
  return {
    sourceChanged() {
      if (stopped) return;
      clearTimer();
      const binding = (source = {});
      loadedData = () => {
        if (current(binding) && ctx.element.readyState >= 2) sync();
      };
      ctx.element.onloadeddata = loadedData;
      sync();
    },
    sync,
    stop,
  };
}
