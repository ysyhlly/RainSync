import type { DeepReadonly, Ref } from "vue";
import type { Media, NativePlatformProvider } from "../../shared/api/types";
import type { ApiClient } from "../../shared/api/client";
import type { RequestFailure } from "../../errors";
import type {
  RoomState,
  PlaybackCapabilities,
  PlaybackCandidateReport,
  PlaybackCandidateSet,
  UpstreamProfileCandidateSet,
  UpstreamProfileReport,
  AdvancedPlaybackRequest,
  LocalHlsLadderRequest,
  NativePlatformMaxHeight,
  DistributedComputePlaybackIntent,
} from "../../../../../packages/protocol";
import type { NativePlatformPlaybackMode } from "./native-platform-intent";
import type {
  PlaybackMetrics,
  PlaybackMetricsFence,
  PlaybackMetricsOrigin,
  PlaybackMetricsSnapshot,
} from "./playback-metrics";
import type { StaticHlsAvailability } from "./static-hls-availability";
import type {
  createStaticHlsChildIntentState,
  StaticHlsChildIntent,
} from "./static-hls-child-intent";
import type {
  PlaybackPlan,
  PlaybackObservation,
} from "../../../../../packages/protocol";
export type PlaybackIdentitySnapshot = Readonly<{
  userId: string | undefined;
  epoch: number;
}>;
/** An exact-login snapshot and synchronous invalidation, never the auth store. */
export type PlaybackIdentityPort = {
  current: () => PlaybackIdentitySnapshot;
  invalidate: (failure: RequestFailure) => void;
  subscribeInvalidation: (listener: () => void) => () => void;
};
/** Playback may observe the projection and clock, but cannot write either. */
export type RoomTimelinePort = {
  state: DeepReadonly<Ref<RoomState | null>>;
  connected: Readonly<Ref<boolean>>;
  active?: Readonly<Ref<boolean>>;
  clock: {
    readonly ready: boolean;
    readonly revision?: number;
    now: () => number;
  };
  checkClock?: () => void;
};
export type PlaybackRoomCommands = {
  ended?: (positionMs: number) => void;
};
export type PlaybackRuntimeContext = {
  identity: PlaybackIdentityPort;
  api: ApiClient;
  timeline: RoomTimelinePort;
  commands?: PlaybackRoomCommands;
  /** Explicit negotiation choice only; eligibility always comes from Server.
   * Ordinary wiring uses this flag to discover availability; the viewer toggle starts off. */
  staticHlsFallback?: boolean;
  resolveMedia?: (room: string, media: string) => Promise<Media>;
  platformAccountChange?: Readonly<Ref<number>>;
  shortPlatformAccountChanges?: DeepReadonly<
    Ref<Record<"douyin" | "tiktok", number>>
  >;
  shortPlatformAccountIds?: DeepReadonly<
    Ref<Partial<Record<"douyin" | "tiktok", string>>>
  >;
  youtubePlatformAccountChange?: Readonly<Ref<number>>;
  youtubePlatformAccountId?: Readonly<Ref<string | undefined>>;
};
export type MetricIntent = {
  t0: number;
  identity: object;
  fence: PlaybackMetricsFence;
  startGeneration: number;
  origin: PlaybackMetricsOrigin;
  user: string | undefined;
  epoch: number;
  room: string;
  media: number;
  mediaId: string;
  mode: string;
  audio: number | undefined;
  advanced?: AdvancedPlaybackRequest;
  ladder?: LocalHlsLadderRequest;
  staticHlsFallback: boolean;
  distributed?: DistributedComputePlaybackIntent;
  inputsInvalidated?: boolean;
  candidateDiscovery?: {
    probe: AbortController;
    result: Promise<CandidateDiscovery>;
  };
  concreteCandidates?: CandidateDiscovery;
  failedCandidates: string[];
  element?: HTMLVideoElement;
  meter?: PlaybackMetrics;
  last?: PlaybackMetricsSnapshot;
  disabled: boolean;
  metricsVersion?: 1 | 2;
  originRecoveryUsed: boolean;
  accountChange: number;
  nativeCredentialMode: "own_or_anonymous" | "anonymous";
  nativeProvider?: NativePlatformProvider;
  nativeQualityMaxHeight: NativePlatformMaxHeight;
  nativePlaybackMode: NativePlatformPlaybackMode;
  nativeCompatibility?: boolean;
  nativeCourse?: boolean;
};
export type CandidateDiscovery = {
  capabilities: PlaybackCapabilities;
  staticHls?: { availability: StaticHlsAvailability; observedAt: number };
  report?: PlaybackCandidateReport;
  // A finite schema-1 set keeps its original binding and device evidence.
  concrete?: { candidates: PlaybackCandidateSet; startedAt: number };
  upstream?: {
    candidates: UpstreamProfileCandidateSet;
    report: UpstreamProfileReport;
    startedAt: number;
  };
};

export type StaticChildState = ReturnType<
  typeof createStaticHlsChildIntentState
>;
export type PlaybackContinuation = {
  parent: PlaybackPlan;
  capabilities: PlaybackCapabilities;
  staticChild?: {
    state: StaticChildState;
    intent: StaticHlsChildIntent;
    finalObservation?: PlaybackObservation;
  };
};
export type PlaybackRecoveryState =
  | "idle"
  | "calibrating"
  | "catching_up"
  | "waiting"
  | "blocked"
  | "unsupported_rate"
  | "reconnecting"
  | "background"
  | "failed";
/** Browser startup phases; SDK or usable-data readiness never proves a frame. */
export type PlaybackLoadingStage =
  | "idle"
  | "preparing"
  | "initializing"
  | "loading_media"
  | "waiting_frame"
  | "playing"
  | "failed";
