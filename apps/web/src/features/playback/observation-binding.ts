import type {
  PlaybackObservation,
  PlaybackObservationEvent,
  PlaybackPlan,
} from "../../../../../packages/protocol";
import { createObservationSender } from "./observation-sender";

/** One immutable grant/element binding. It observes media, never room time. */
export function bindPlaybackObservations(ctx: {
  element: HTMLVideoElement;
  plan: PlaybackPlan;
  current: () => boolean;
  finalCurrent: () => boolean;
  send: (body: PlaybackObservation, signal: AbortSignal) => Promise<void>;
  storage: Pick<Storage, "getItem" | "setItem">;
  storageKey: string;
}) {
  const { element, plan, current, storage, storageKey } = ctx;
  let active = true;
  let stopping = false;
  let localFailure: unknown;
  const attached: [string, EventListener][] = [];
  let hasPlayed = false;
  let buffering = false;
  let ended = false;
  let storedSeq = 0;
  let reservedFinal: PlaybackObservation | undefined;
  try {
    const value = Number(storage.getItem(storageKey));
    if (Number.isSafeInteger(value) && value >= 0) storedSeq = value;
  } catch {
    // Browsers that deny tab storage still use the server's persisted sequence.
  }
  const sender = createObservationSender<Omit<PlaybackObservation, "seq">>(
    async (packet, signal) => {
      if (!guard(() => current())) return;
      await ctx.send(
        { ...packet.sample, seq: packet.seq },
        AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      );
    },
    Math.max(plan.observation_seq ?? 0, storedSeq),
    (seq) => {
      try {
        storage.setItem(storageKey, String(seq));
      } catch {
        // Denied storage cannot block playback or the current tab's ordering.
      }
    },
  );

  function close() {
    if (!active) return;
    active = false;
    for (const [event, listener] of attached.splice(0)) {
      try {
        element.removeEventListener(event, listener);
      } catch {
        // A failed removal must not prevent cancellation or the other removals.
        // Every retained callback is fenced by active before reading media.
      }
    }
    try {
      sender.stop();
    } catch (failure) {
      localFailure ??= failure;
    }
  }
  function guard<T>(action: () => T): T | undefined {
    if (!active || stopping) return;
    try {
      return action();
    } catch (failure) {
      localFailure = failure;
      close();
      return undefined;
    }
  }

  function sample(event: PlaybackObservationEvent, final = false) {
    if (!active || !(final ? ctx.finalCurrent() : current())) return;
    const mediaTime = element.currentTime * 1000;
    if (
      !Number.isFinite(mediaTime) ||
      mediaTime < 0 ||
      !Number.isFinite(element.playbackRate)
    )
      return;
    return {
      media_generation: plan.media_generation,
      event,
      media_time_ms: mediaTime,
      paused: element.paused,
      seeking: element.seeking,
      buffering: buffering || element.readyState < 2,
      playback_rate: element.playbackRate,
      has_played: hasPlayed,
    } satisfies Omit<PlaybackObservation, "seq">;
  }
  function capture(event: PlaybackObservationEvent) {
    const value = sample(event);
    if (value) sender.capture(value);
  }
  function playing() {
    if (
      !active ||
      !current() ||
      element.readyState < 2 ||
      element.paused ||
      element.seeking
    )
      return;
    hasPlayed = true;
    buffering = false;
    ended = false;
    capture("playing");
  }
  function waiting() {
    buffering = true;
    capture("buffering");
  }
  const listeners: [string, EventListener][] = [
    ["playing", playing],
    ["pause", () => capture("pause")],
    ["seeking", () => capture("seeking")],
    ["seeked", () => capture("seeked")],
    ["waiting", waiting],
    ["stalled", waiting],
    [
      "canplay",
      () => {
        buffering = false;
      },
    ],
    ["ratechange", () => capture("progress")],
  ];
  try {
    for (const [event, listener] of listeners) {
      if (!active) break;
      const guarded: EventListener = (value) => guard(() => listener(value));
      // Track before add: an adapter can attach the listener and then throw.
      attached.push([event, guarded]);
      element.addEventListener(event, guarded);
    }
  } catch (failure) {
    localFailure = failure;
    close();
  }

  return {
    progress() {
      // Independent of sync correction and readiness polling. A growing HLS
      // prefix ending never creates an ended report without complete readiness.
      guard(() => capture(ended ? "ended" : "progress"));
    },
    completed() {
      guard(() => {
        ended = true;
        capture("ended");
      });
    },
    /** Reserve from this actual element binding before a child proposal. This
     * does not detach listeners or send a separate observation POST. */
    captureFinal(): PlaybackObservation | undefined {
      return guard(() => {
        const value = sample(ended ? "ended" : "progress", true);
        const packet = value ? sender.reserve(value) : undefined;
        reservedFinal = packet
          ? { ...packet.sample, seq: packet.seq }
          : undefined;
        return reservedFinal;
      });
    },
    stop(captured?: PlaybackObservation): PlaybackObservation | undefined {
      if (!active || stopping) return;
      stopping = true;
      try {
        // Reuse only a sample reserved by this exact observation binding.
        if (captured && captured === reservedFinal && ctx.finalCurrent())
          return captured;
        const value = sample(ended ? "ended" : "progress", true);
        const packet = value ? sender.reserve(value) : undefined;
        return packet ? { ...packet.sample, seq: packet.seq } : undefined;
      } catch (failure) {
        localFailure = failure;
        return undefined;
      } finally {
        close();
      }
    },
    flush: () => sender.flush(),
    get failure() {
      return localFailure ?? sender.failure;
    },
  };
}
