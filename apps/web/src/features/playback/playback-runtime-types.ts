import type { Ref } from "vue";
import type { Clock } from "../../../../../packages/sync-engine";
import type { Media, NativePlatformProvider } from "../../shared/api/types";
import type { useSession } from "../auth/session.store";
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
export type PlaybackRuntimeContext = {
  session: ReturnType<typeof useSession>;
  state: Ref<RoomState | null>;
  connected: Ref<boolean>;
  active?: Ref<boolean>;
  clock: Clock;
  checkClock?: () => void;
  error: Ref<string>;
  run: (action: () => Promise<void>) => Promise<void>;
  ended?: (positionMs: number) => void;
  /** Explicit negotiation choice only; eligibility always comes from Server.
   * Ordinary wiring uses this flag to discover availability; the viewer toggle starts off. */
  staticHlsFallback?: boolean;
  resolveMedia?: (room: string, media: string) => Promise<Media>;
  platformAccountChange?: Ref<number>;
  shortPlatformAccountChanges?: Ref<Record<"douyin" | "tiktok", number>>;
  shortPlatformAccountIds?: Ref<Partial<Record<"douyin" | "tiktok", string>>>;
  youtubePlatformAccountChange?: Ref<number>;
  youtubePlatformAccountId?: Ref<string | undefined>;
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
