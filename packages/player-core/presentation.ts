export type PresentedFrame = Readonly<{
  presentedAtMs: number;
  evidence: "video_frame_callback" | "playing_time_advance";
}>;

/** One attached source, independent of optional telemetry. RVFC means submitted
 * for composition, not proof that a person saw pixels. The fallback is explicitly
 * approximate and requires an observed playing edge followed by time advancement.
 * A seek, loadeddata, canplay or a fulfilled play() promise is not presentation. */
export function bindPresentedFrame(ctx: {
  element: HTMLVideoElement;
  current: () => boolean;
  eligible: () => boolean;
  accept: (frame: PresentedFrame) => boolean;
  now?: () => number;
}) {
  const el = ctx.element;
  const now = ctx.now ?? (() => performance.now());
  const attachedAt = now();
  let active = true;
  let played = false;
  let lastTime = el.currentTime;
  let frameId: number | undefined;
  const listeners: [string, EventListener][] = [];
  const hasFrameCallback = typeof el.requestVideoFrameCallback === "function";
  function stop() {
    if (!active) return;
    active = false;
    const pending = frameId;
    frameId = undefined;
    try {
      if (pending !== undefined) el.cancelVideoFrameCallback(pending);
    } catch {
      // An uncancelable queued callback is still fenced by active.
    }
    for (const [event, listener] of listeners.splice(0)) {
      try {
        el.removeEventListener(event, listener);
      } catch {
        // Continue cleanup; stale listeners are inert.
      }
    }
  }
  function current() {
    if (!active) return false;
    if (ctx.current()) return true;
    stop();
    return false;
  }
  function guard(action: () => void) {
    if (!active) return;
    try {
      action();
    } catch {
      // Lack of an observation never establishes success. The owner's deadline
      // remains armed even if the browser fails registration or property reads.
      stop();
    }
  }
  function accept(frame: PresentedFrame) {
    const at = now();
    if (
      current() &&
      ctx.eligible() &&
      Number.isFinite(at) &&
      Number.isFinite(attachedAt) &&
      Number.isFinite(frame.presentedAtMs) &&
      frame.presentedAtMs >= attachedAt &&
      frame.presentedAtMs <= at &&
      ctx.accept(frame)
    )
      stop();
  }
  function baseline() {
    if (!current()) return;
    lastTime = el.currentTime;
  }
  function progress() {
    if (!current()) return;
    const time = el.currentTime;
    const advances =
      Number.isFinite(time) && Number.isFinite(lastTime) && time > lastTime;
    lastTime = time;
    if (played && advances && !el.paused && !el.seeking && el.readyState >= 2)
      accept({ presentedAtMs: now(), evidence: "playing_time_advance" });
  }
  function frame(_at: number, metadata: VideoFrameCallbackMetadata) {
    guard(() => {
      frameId = undefined;
      if (!current()) return;
      accept({
        presentedAtMs: metadata.presentationTime,
        evidence: "video_frame_callback",
      });
      if (current()) frameId = el.requestVideoFrameCallback(frame);
    });
  }
  guard(() => {
    if (hasFrameCallback) frameId = el.requestVideoFrameCallback(frame);
    else {
      const events: [string, () => void][] = [
        [
          "playing",
          () => {
            if (!current() || el.paused || el.seeking || el.readyState < 2)
              return;
            played = true;
            baseline();
          },
        ],
        ["seeking", baseline],
        ["seeked", baseline],
        ["timeupdate", progress],
      ];
      for (const [event, handler] of events) {
        const listener = () => guard(handler);
        listeners.push([event, listener]);
        el.addEventListener(event, listener);
      }
    }
  });
  return { stop };
}
