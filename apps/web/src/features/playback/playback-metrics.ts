/** Client-reported measurements only. Pure local state: no timer, network,
 * storage, protocol imports, identity map, or server measurement claim.
 *
 * The owner creates one meter per logical intent before async preparation,
 * supplies the original monotonic t0, and retains it across automatic fallback.
 * Every reliable media/intent/visibility edge calls observe; a 5s owner timer
 * calls sample with freshly read state. Never feed cached flags as fresh evidence.
 * The current fence includes auth/room/media/element identity through an opaque
 * object; generation advances before any new attempt's async work. Dispose before
 * teardown. Replacing the logical identity requires a new meter, not a reset.
 */
export const PLAYBACK_METRICS_SAMPLE_MS = 5_000;
export const PLAYBACK_METRICS_MAX_GAP_MS = 15_000;
export const PLAYBACK_METRICS_MAX_ELAPSED_MS = 604_800_000;

export type PlaybackMetricsFence = Readonly<{
  identity: object;
  generation: number;
}>;
export type PlaybackMetricsObservation = Readonly<{
  foreground: boolean;
  /** Latest accepted room/user intent, independent of an element's temporary pause. */
  expectedPlaying: boolean;
  paused: boolean;
  /** Actual playback wait; a stalled fetch while media advances is insufficient. */
  buffering: boolean;
  seeking: boolean;
  autoplayBlocked: boolean;
}>;
export type PlaybackMetricsOrigin = "user_intent" | "automatic_load";
export type PlaybackFrameEvidence =
  "video_frame_callback" | "playing_time_advance";
export type PlaybackMetricsFrame = Readonly<{
  presentedAtMs: number;
  evidence: PlaybackFrameEvidence;
  /** Published server plan, never the local callback fence generation. */
  planGeneration: number;
}>;
export type PlaybackMetricsConfig = {
  t0: number;
  startupOrigin: PlaybackMetricsOrigin;
  fence: PlaybackMetricsFence;
  current: () => PlaybackMetricsFence | undefined;
  initial: PlaybackMetricsObservation;
  now?: () => number;
};
export type PlaybackMetricsTotals = Readonly<{
  startup_ms: number;
  autoplay_blocked_ms: number;
  background_ms: number;
  paused_ms: number;
  seeking_ms: number;
  rebuffer_ms: number;
  playing_ms: number;
  unobserved_ms: number;
}>;
export type PlaybackMetricsStartupPhases = Readonly<{
  preparation_ms: number;
  loading_ms: number;
  unobserved_ms: number;
}>;
export type PlaybackMetricsSnapshot = Readonly<{
  source: "client_reported";
  seq: number;
  generation: number;
  startup_origin: PlaybackMetricsOrigin;
  elapsed_ms: number;
  observed_ms: number;
  /** Foreground playing + rebuffer + seeking, matching the offline denominator.
   * Startup, block, background, pause and unknown coverage are excluded. */
  expected_playback_ms: number;
  totals: PlaybackMetricsTotals;
  startup_phases: PlaybackMetricsStartupPhases;
  first_frame_plan_generation?: number;
  first_frame?: Readonly<{
    elapsed_ms: number;
    confirmed_elapsed_ms: number;
    evidence: PlaybackFrameEvidence;
  }>;
  final: boolean;
}>;

type Category = keyof PlaybackMetricsTotals;
const OBSERVATION_KEYS = [
  "foreground",
  "expectedPlaying",
  "paused",
  "buffering",
  "seeking",
  "autoplayBlocked",
] as const;
const validTime = (value: number) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;
const validFence = (fence: PlaybackMetricsFence | undefined) =>
  !!fence &&
  typeof fence.identity === "object" &&
  fence.identity !== null &&
  Number.isInteger(fence.generation) &&
  fence.generation > 0 &&
  fence.generation <= 0xffff_ffff;
const validObservation = (value: PlaybackMetricsObservation) =>
  !!value && OBSERVATION_KEYS.every((key) => typeof value[key] === "boolean");
// Copy only the six flags; don't retain arbitrary caller payloads/proxies.
const copyObservation = (value: PlaybackMetricsObservation) => ({
  foreground: value.foreground,
  expectedPlaying: value.expectedPlaying,
  paused: value.paused,
  buffering: value.buffering,
  seeking: value.seeking,
  autoplayBlocked: value.autoplayBlocked,
});

export function createPlaybackMetrics(config: PlaybackMetricsConfig) {
  const clock = config.now ?? (() => performance.now());
  const created = clock();
  if (
    !validTime(config.t0) ||
    !validTime(created) ||
    config.t0 > created ||
    Math.floor(created) - Math.floor(config.t0) >
      PLAYBACK_METRICS_MAX_ELAPSED_MS ||
    !validFence(config.fence) ||
    !validObservation(config.initial) ||
    !["user_intent", "automatic_load"].includes(config.startupOrigin)
  )
    throw new RangeError(
      "Invalid playback measurement origin or initial state",
    );
  const identity = config.fence.identity;
  const t0 = config.t0;
  const origin = config.startupOrigin;
  const current = config.current;
  let generation = config.fence.generation;
  let reliableAt = created;
  let attemptAt = created;
  let attachedAt: number | undefined;
  let lastSampleAt = created;
  let active = true;
  let seq = 0;
  let state = copyObservation(config.initial);
  let first: PlaybackMetricsSnapshot["first_frame"];
  let firstPlanGeneration: number | undefined;
  const startupPhases = {
    preparation_ms: 0,
    loading_ms: 0,
    unobserved_ms: Math.floor(created) - Math.floor(t0),
  };
  let attemptFrame: PlaybackMetricsFrame | undefined;
  // Time before this meter existed has no state witness, even with a valid t0.
  const totals = {
    startup_ms: 0,
    autoplay_blocked_ms: 0,
    background_ms: 0,
    paused_ms: 0,
    seeking_ms: 0,
    rebuffer_ms: 0,
    playing_ms: 0,
    unobserved_ms: Math.floor(created) - Math.floor(t0),
  };
  function allowed(fence: PlaybackMetricsFence, newer = false) {
    if (!active || !validFence(fence) || fence.identity !== identity)
      return false;
    let live: PlaybackMetricsFence | undefined;
    try {
      live = current();
    } catch {
      return false;
    }
    return (
      validFence(live) &&
      live!.identity === identity &&
      live!.generation === fence.generation &&
      (newer ? fence.generation > generation : fence.generation === generation)
    );
  }
  function time(): number | undefined {
    try {
      const value = clock();
      if (
        validTime(value) &&
        Math.floor(value) - Math.floor(t0) > PLAYBACK_METRICS_MAX_ELAPSED_MS
      ) {
        active = false;
        return undefined;
      }
      return validTime(value) && value >= reliableAt ? value : undefined;
    } catch {
      return undefined;
    }
  }
  function category(): Category {
    // Fixed precedence keeps every interval in exactly one category. Startup
    // latency continues until presentation even if expected play changes there.
    if (!state.foreground) return "background_ms";
    if (state.autoplayBlocked) return "autoplay_blocked_ms";
    if (!first) return "startup_ms";
    if (!state.expectedPlaying) return "paused_ms";
    if (state.seeking) return "seeking_ms";
    if (state.buffering || !attemptFrame) return "rebuffer_ms";
    // A known pause with expected play and no buffering cause is contradictory
    // coverage. It must not be fabricated as either playing or rebuffering.
    if (state.paused) return "unobserved_ms";
    return "playing_ms";
  }
  function advance(at: number) {
    const interval = Math.floor(at) - Math.floor(reliableAt);
    // Classify the ENTIRE unwitnessed gap, not only its excess over 15s.
    const key =
      at - reliableAt > PLAYBACK_METRICS_MAX_GAP_MS
        ? "unobserved_ms"
        : category();
    totals[key] += interval;
    // Independent from playback-state classification: hidden or blocked startup
    // still belongs to its witnessed phase, until first-frame CONFIRMATION.
    if (!first) {
      const phase =
        at - reliableAt > PLAYBACK_METRICS_MAX_GAP_MS
          ? "unobserved_ms"
          : attachedAt === undefined
            ? "preparation_ms"
            : "loading_ms";
      startupPhases[phase] += interval;
    }
    reliableAt = at;
  }
  function accept(
    fence: PlaybackMetricsFence,
    observation: PlaybackMetricsObservation,
  ) {
    if (!allowed(fence) || !validObservation(observation)) return;
    const at = time();
    if (at === undefined) return;
    advance(at);
    state = copyObservation(observation);
    return at;
  }
  function capture(at: number, final: boolean): PlaybackMetricsSnapshot {
    lastSampleAt = at;
    // 5s cadence bounds sequence increments below MAX_SAFE_INTEGER for the
    // accepted clock range; only one additional final capture can occur.
    return Object.freeze({
      source: "client_reported" as const,
      seq: ++seq,
      generation,
      startup_origin: origin,
      elapsed_ms: Math.floor(at) - Math.floor(t0),
      observed_ms: Math.floor(at) - Math.floor(t0) - totals.unobserved_ms,
      expected_playback_ms:
        totals.playing_ms + totals.rebuffer_ms + totals.seeking_ms,
      totals: Object.freeze({ ...totals }),
      startup_phases: Object.freeze({ ...startupPhases }),
      ...(first
        ? {
            first_frame: first,
            first_frame_plan_generation: firstPlanGeneration!,
          }
        : {}),
      final,
    });
  }
  return {
    /** Automatic fallback only: adopt a strictly newer current generation while
     * preserving the original logical t0, counters and first-frame receipt. */
    beginAttempt(
      fence: PlaybackMetricsFence,
      observation: PlaybackMetricsObservation,
    ): boolean {
      if (!allowed(fence, true) || !validObservation(observation)) return false;
      const at = time();
      if (at === undefined) return false;
      advance(at);
      generation = fence.generation;
      attemptAt = at;
      attachedAt = undefined;
      attemptFrame = undefined;
      state = copyObservation(observation);
      return true;
    },
    /** Called only after a source has actually been attached to this attempt. */
    attachSource(
      fence: PlaybackMetricsFence,
      observation: PlaybackMetricsObservation,
    ): boolean {
      if (attachedAt !== undefined) return allowed(fence);
      const at = accept(fence, observation);
      if (at === undefined) return false;
      attachedAt = at;
      return true;
    },
    observe(
      fence: PlaybackMetricsFence,
      observation: PlaybackMetricsObservation,
    ): boolean {
      return accept(fence, observation) !== undefined;
    },
    /** RVFC: presentedAtMs is metadata.presentationTime from this time origin,
     * submitted for composition, not proven screen display. Fallback requires
     * playing + readyState >=2 + actual time advance, supplied by the owner.
     * Classification changes at confirmation, never retroactively. Its separate
     * confirmation time exposes callback delay. Repeat capture is idempotent. */
    firstFrame(
      fence: PlaybackMetricsFence,
      frame: PlaybackMetricsFrame,
      observation: PlaybackMetricsObservation,
    ): boolean {
      if (
        !allowed(fence) ||
        !validObservation(observation) ||
        !frame ||
        !validTime(frame.presentedAtMs) ||
        !Number.isInteger(frame.planGeneration) ||
        frame.planGeneration < 1 ||
        frame.planGeneration > 0xffff_ffff ||
        !["video_frame_callback", "playing_time_advance"].includes(
          frame.evidence,
        )
      )
        return false;
      if (attemptFrame)
        return (
          attemptFrame.presentedAtMs === frame.presentedAtMs &&
          attemptFrame.evidence === frame.evidence &&
          attemptFrame.planGeneration === frame.planGeneration
        );
      const at = time();
      if (
        at === undefined ||
        attachedAt === undefined ||
        frame.presentedAtMs < Math.max(attemptAt, attachedAt) ||
        frame.presentedAtMs > at
      )
        return false;
      advance(at);
      state = copyObservation(observation);
      attemptFrame = {
        presentedAtMs: frame.presentedAtMs,
        evidence: frame.evidence,
        planGeneration: frame.planGeneration,
      };
      if (!first) firstPlanGeneration = frame.planGeneration;
      first ??= Object.freeze({
        elapsed_ms: Math.floor(frame.presentedAtMs) - Math.floor(t0),
        confirmed_elapsed_ms: Math.floor(at) - Math.floor(t0),
        evidence: frame.evidence,
      });
      return true;
    },
    /** Caller provides a fresh reliable read even if cadence suppresses output.
     * This returns a local immutable snapshot only, never sends a v1 message. */
    sample(
      fence: PlaybackMetricsFence,
      observation: PlaybackMetricsObservation,
    ): PlaybackMetricsSnapshot | undefined {
      const at = accept(fence, observation);
      if (at === undefined || at - lastSampleAt < PLAYBACK_METRICS_SAMPLE_MS)
        return;
      return capture(at, false);
    },
    /** Only the current attempt may close its meter. Old async cleanup cannot
     * dispose a newer fallback. Final cumulative capture bypasses 5s cadence. */
    dispose(
      fence: PlaybackMetricsFence,
      observation: PlaybackMetricsObservation,
    ): PlaybackMetricsSnapshot | undefined {
      const at = accept(fence, observation);
      if (at === undefined) return;
      const snapshot = capture(at, true);
      active = false;
      return snapshot;
    },
  };
}

export type PlaybackMetrics = ReturnType<typeof createPlaybackMetrics>;
