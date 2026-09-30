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
  let hasPlayed = false;
  let buffering = false;
  let ended = false;
  let storedSeq = 0;
  try {
    const value = Number(storage.getItem(storageKey));
    if (Number.isSafeInteger(value) && value >= 0) storedSeq = value;
  } catch {
    // Browsers that deny tab storage still use the server's persisted sequence.
  }
  const sender = createObservationSender<Omit<PlaybackObservation, "seq">>(
    async (packet, signal) => {
      if (!active || !current()) return;
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
  for (const [event, listener] of listeners)
    element.addEventListener(event, listener);

  return {
    progress() {
      // Independent of sync correction and readiness polling. A growing HLS
      // prefix ending never creates an ended report without complete readiness.
      capture(ended ? "ended" : "progress");
    },
    completed() {
      ended = true;
      capture("ended");
    },
    stop(): PlaybackObservation | undefined {
      const value = sample(ended ? "ended" : "progress", true);
      const packet = value ? sender.reserve(value) : undefined;
      active = false;
      for (const [event, listener] of listeners)
        element.removeEventListener(event, listener);
      sender.stop();
      return packet ? { ...packet.sample, seq: packet.seq } : undefined;
    },
    flush: () => sender.flush(),
    get failure() {
      return sender.failure;
    },
  };
}
