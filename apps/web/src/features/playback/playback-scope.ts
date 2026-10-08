import type {
  PlaybackMetrics,
  PlaybackMetricsFence,
  PlaybackMetricsOrigin,
  PlaybackMetricsSnapshot,
} from "./playback-metrics";

/** Opaque logical owner; it is never an auth, room, plan or SDK generation. */
export type PlaybackOwnerToken = Readonly<{ kind: "playback-owner" }>;

/** Optional measurement state has no request, retry, candidate or grant authority. */
export type PlaybackObservationScope = {
  readonly owner: PlaybackOwnerToken;
  readonly t0: number;
  readonly startGeneration: number;
  readonly origin: PlaybackMetricsOrigin;
  /** A local callback fence, independent of the server's plan generation. */
  fence: PlaybackMetricsFence;
  meter?: PlaybackMetrics;
  last?: PlaybackMetricsSnapshot;
  disabled: boolean;
  metricsVersion?: 1 | 2;
};

/** Create both owners once per logical intent. Source/driver replacement reuses
 * this pair; observation failure never creates another business intent. */
export function createPlaybackScope<I extends object>(
  input: I,
  timing: {
    t0: number;
    startGeneration: number;
    origin: PlaybackMetricsOrigin;
  },
): {
  intent: I & {
    readonly owner: PlaybackOwnerToken;
    readonly origin: PlaybackMetricsOrigin;
    readonly initialPlanGeneration: number;
  };
  observation: PlaybackObservationScope;
} {
  const owner: PlaybackOwnerToken = Object.freeze({ kind: "playback-owner" });
  return {
    intent: {
      ...input,
      owner,
      origin: timing.origin,
      initialPlanGeneration: timing.startGeneration,
    },
    observation: {
      owner,
      t0: timing.t0,
      startGeneration: timing.startGeneration,
      origin: timing.origin,
      fence: Object.freeze({ identity: owner, generation: 1 }),
      disabled: false,
    },
  };
}
