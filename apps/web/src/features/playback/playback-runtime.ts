import { finiteHlsRequestParameters, validateFiniteHlsChoice } from "./finite-hls-intent";
import { computed, ref, nextTick, onScopeDispose, watch, type Ref } from "vue";
import Hls from "hls.js";
import {
  liveRoomMatchesPlan,
  nativeLiveDirective,
  nativeLiveEdge,
  validNativeLiveBinding,
  validNativeLiveDeliveryUrl,
} from "./native-live";
import { createDashPlayback } from "../../../../../packages/player-core/dash";
import {
  nativePlatformRequest,
  validNativePlatformPlan,
  validNativeCompatibilityDeliveryUrl,
  nativePlatformPlaybackChoice,
  type NativePlatformPlaybackMode,
} from "./native-platform-intent";
import {
  advancedPlaybackRequest,
  matchesAdvancedPlaybackPlan,
  sameAdvancedPlaybackRequest,
  validAdvancedPlaybackCapabilities,
} from "./advanced-playback-intent";
import {
  localHlsLadderRequest,
  validLocalHlsLadderCapabilities,
  matchesLocalHlsLadderPlan,
  sameLocalHlsLadderRequest,
  bindLocalHlsLevels,
  hasHlsLadder,
} from "./local-hls-ladder-intent";
import { RoomP2PTransport, type PeerStats } from "./room-p2p";
import { createP2PFragmentLoader } from "./room-p2p-loader";
import { validDistributedIntent, sameDistributedIntent, matchesDistributedPlaybackPlan } from "./distributed-playback-intent";
import { createPlatformTextRuntime } from "./platform-text-runtime";
import { SameSidDecoderRecovery, upstreamOutputMatchesMeasuredBounds } from "./upstream-output";
import { observeUpstreamOutput } from "./upstream-output-observer";
import type { Media, NativePlatformProvider } from "../../shared/api/types";
import {
  platformProviderLabels,
  validNativePlatformMetadata,
} from "../rooms/platform-import";
import {
  detectCapabilities,
  detectCapabilitiesAsync,
  detectCandidateReport,
  detectUpstreamProfileReport,
  isUpstreamProfileEnvelope,
  PlaybackPlanGenerations,
  matchesPlanGeneration,
  PlaybackRateSupport,
  availablePlaybackRanges,
  containsPlaybackPosition,
  hasUsablePlaybackTimeline,
} from "../../../../../packages/player-core";
import {
  Corrector,
  target,
  type Clock,
} from "../../../../../packages/sync-engine";
import type {
  RoomState,
  PlaybackPlan,
  PlaybackRequest,
  PlaybackReadiness,
  PlaybackObservation,
  PlaybackCandidateSet,
  PlaybackCandidateReport,
  PlaybackCapabilities,
  PlaybackMetricsReceipt,
  NativePlatformMaxHeight,
  NativePlatformQualityOption,
  UpstreamProfileCandidateSet,
  UpstreamProfileReport,
  AdvancedPlaybackRequest,
  AdvancedPlaybackCapabilities,
  AdvancedPlaybackFacts,
  LocalHlsLadderRequest,
  LocalHlsLadderCapabilities,
  LocalHlsLadderFacts,
  LocalHlsRendition,
  DistributedComputePlaybackIntent,
  DistributedComputePlaybackFacts,
  UpstreamMeasuredOutput,
} from "../../../../../packages/protocol";
import { RequestFailure, isUnsupportedTimelineResponse } from "../../errors";
import { StaleIdentity } from "../../shared/api/client";
import {
  PlaybackCancelled,
  PlaybackViewerOriginRequired,
  PlaybackRequests,
  waitPlaybackReady,
} from "../../playback-request";
import type { useSession } from "../auth/session.store";
import { bindPlaybackObservations } from "./observation-binding";
import {
  createPlaybackMetrics,
  PLAYBACK_METRICS_MAX_ELAPSED_MS,
  type PlaybackMetrics,
  type PlaybackMetricsFence,
  type PlaybackMetricsOrigin,
  type PlaybackMetricsSnapshot,
} from "./playback-metrics";
import { bindPlaybackMetricEvents } from "./metrics-binding";
import {
  summarizePlaybackPlan,
  type PlaybackSummary,
} from "./playback-summary";
import { createPlaybackMetricsSender } from "./metrics-sender";
import { createFirstFrameDeadline } from "./first-frame-deadline";
import {
  applyPreparationSnapshot,
  preparationFailure,
  preparationReadinessSnapshot,
  type PlaybackPreparationState,
} from "./playback-preparation";

import {
  classifyStaticHlsDecodeFailure,
  createStaticHlsChildIntentState,
  type StaticHlsChildIntent,
  type StaticHlsFailureEvent,
  type StaticHlsPlanBinding,
} from "./static-hls-child-intent";

import {
  staticHlsAvailability as parseStaticHlsAvailability,
  staticHlsAvailabilityLabel,
  staticHlsOfferCurrent,
  type StaticHlsAvailability,
} from "./static-hls-availability";

type StaticChildState = ReturnType<typeof createStaticHlsChildIntentState>;
type PlaybackContinuation = {
  parent: PlaybackPlan;
  capabilities: PlaybackCapabilities;
  staticChild?: {
    state: StaticChildState;
    intent: StaticHlsChildIntent;
    finalObservation?: PlaybackObservation;
  };
};

const CANDIDATE_LIFETIME_MS = 5 * 60 * 1000;
const candidateError = "播放候选无法安全使用，请重新加载播放";
const candidateExpiredError = "播放候选已失效，请重新加载播放";

function freezeCandidateSnapshot<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeCandidateSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

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

export function createPlaybackRuntime(ctx: {
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
}) {
  const { session, state, connected, clock, error, run } = ctx;
  const accountRevision = (provider?: NativePlatformProvider) =>
    provider === "bilibili"
      ? (ctx.platformAccountChange?.value ?? 0)
      : provider === "douyin" || provider === "tiktok"
        ? (ctx.shortPlatformAccountChanges?.value[provider] ?? 0)
        : provider === "youtube"
          ? (ctx.youtubePlatformAccountChange?.value ?? 0)
          : 0;
  const usesPlatformAccount = (provider?: NativePlatformProvider) =>
    provider === "bilibili" ||
    provider === "douyin" ||
    provider === "tiktok" ||
    provider === "youtube";
  const roomIsActive = () => ctx.active?.value !== false;
  const video = ref<HTMLVideoElement>(),
    waiting = ref(false),
    blocked = ref(false),
    dragging = ref(false),
    mode = ref("auto");
  const nativePlatform = ref(false),
    nativeProvider = ref<NativePlatformProvider>(),
    nativePlaybackMode = ref<NativePlatformPlaybackMode>("auto"),
    nativeCredentialMode = ref<"own_or_anonymous" | "anonymous">(
      "own_or_anonymous",
    );
  const live = computed(() => validNativeLiveBinding(state.value?.live));
  let liveNeedsEdge = true;
  // One automatic edge rejoin per recovery episode. A prepared grant or timer
  // never resets the budget; actual resumed media progress may start a new episode.
  let liveWindowRecovery:
    | {
        scope: string;
        consumed: boolean;
        probed: boolean;
        parent?: PlaybackPlan;
        replacement?: PlaybackPlan;
        resumedAt?: number;
        resumedPosition?: number;
      }
    | undefined;
  let liveWindowProbe: AbortController | undefined;
  let liveWindowProgressStop: (() => void) | undefined;
  const liveWindowScope = () =>
    roomIsActive() && validNativeLiveBinding(state.value?.live)
      ? JSON.stringify([
          session.user?.id,
          session.epoch,
          state.value?.room_id,
          state.value?.media_id,
          state.value?.media_generation,
          state.value?.live?.broadcast_id,
          nativeCredentialMode.value,
          nativeCredentialMode.value === "anonymous"
            ? 0
            : accountRevision("bilibili"),
        ])
      : undefined;
  const platformText = createPlatformTextRuntime({ session, video });
  const nativeQualityMaxHeight = ref<NativePlatformMaxHeight>("auto"),
    nativeQualityOptions = ref<NativePlatformQualityOption[]>([]),
    nativeQualitySelectedHeight = ref<number>();
  const nativeEncodedHeight = ref<number>();
  const nativeLadderRenditions = ref<LocalHlsRendition[]>();
  const upstreamMeasuredOutput = ref<UpstreamMeasuredOutput>();
  const upstreamMeasuredMatchesRequested = ref<boolean>();
  let upstreamObserver: ReturnType<typeof observeUpstreamOutput> | undefined;
  // Preserve the original grant budget even if the same completed response is
  // reattached through another load attempt. A changed URL cannot reset it.
  let upstreamRecoveryGrant: {
    session: string;
    generation: number | undefined;
    recovery: SameSidDecoderRecovery;
  } | undefined;
  let qualityContext: string | undefined;
  const qualityScope = () =>
    JSON.stringify([
      session.user?.id,
      session.epoch,
      state.value?.room_id,
      state.value?.media_id,
      state.value?.media_generation,
    ]);
  function clearNativeQuality(clearSelection = false) {
    nativeQualityOptions.value = [];
    nativeQualitySelectedHeight.value = undefined;
    nativeEncodedHeight.value = undefined;
    nativeLadderRenditions.value = undefined;
    if (clearSelection) {
      nativeQualityMaxHeight.value = "auto";
      qualityContext = undefined;
    }
  }
  let dash: ReturnType<typeof createDashPlayback> | undefined,
    nativeRefresh: ReturnType<typeof setTimeout> | undefined;
  let failedCompatibilityPlan: PlaybackPlan | undefined;
  const tracks = ref<PlaybackPlan["audio_tracks"]>([]),
    subtitles = ref<PlaybackPlan["subtitle_tracks"]>([]),
    audioIndex = ref<number | undefined>(),
    subtitleIndex = ref<number | undefined>();
  const advancedCapabilities = ref<AdvancedPlaybackCapabilities>(),
    advancedFacts = ref<AdvancedPlaybackFacts>(),
    toneMapHdr = ref(false),
    burnInSubtitleIndex = ref<number>();
  const staticHlsFallbackEnabled = ref(false),
    staticHlsAvailability = ref<StaticHlsAvailability>();
  const staticHlsAvailabilityText = computed(() =>
    staticHlsAvailabilityLabel(staticHlsAvailability.value),
  );
  function clearStaticHlsAvailability() {
    staticHlsFallbackEnabled.value = false;
    staticHlsAvailability.value = undefined;
  }
  const localHlsLadderEnabled = ref(false),
    ladderCapabilities = ref<LocalHlsLadderCapabilities>(),
    ladderFacts = ref<LocalHlsLadderFacts>(),
    ladderQuality = ref("auto"),
    ladderSelected = ref<string>(),
    ladderManual = ref(false);
  let ladderLevelMap: Map<string, number> | undefined;
  function clearLadderPlayback() {
    localHlsLadderEnabled.value = false;
    ladderCapabilities.value = undefined;
    ladderFacts.value = undefined;
    ladderQuality.value = "auto";
    ladderSelected.value = undefined;
    ladderManual.value = false;
    ladderLevelMap = undefined;
  }
  function selectLadderQuality(value: string) {
    const p = plan;
    if (
      !p || !hasHlsLadder(p) ||
      !currentPlan(p) ||
      !hls ||
      !ladderManual.value ||
      !ladderLevelMap ||
      !metricIntent ||
      !candidateIntentCurrent(metricIntent)
    )
      return;
    const level = value === "auto" ? -1 : ladderLevelMap.get(value);
    if (level === undefined) return;
    ladderQuality.value = value;
    hls.loadLevel = level;
  }
  const advancedScope = () =>
    [
      session.epoch,
      session.user?.id,
      state.value?.room_id,
      state.value?.media_id,
      state.value?.media_generation,
    ].join("|");
  function clearAdvancedPlayback() {
    advancedCapabilities.value = undefined;
    advancedFacts.value = undefined;
    toneMapHdr.value = false;
    burnInSubtitleIndex.value = undefined;
  }
  const distributedIntent = ref<DistributedComputePlaybackIntent>();
  const distributedFacts = ref<DistributedComputePlaybackFacts>();
  const peerStats = ref<PeerStats>();
  const peerSharing = ref(false);
  let primaryPeer: RoomP2PTransport | undefined;
  function updatePeerStats() {
    if (!primaryPeer) return;
    peerStats.value = { ...primaryPeer.stats };
    peerSharing.value = primaryPeer.active;
  }
  async function stopPeerSharing() {
    await primaryPeer?.stop();
    peerSharing.value = false;
  }
  async function startPeerSharing(consent: {acknowledge_peer_addresses:boolean;confirm_current_network:boolean;upload_allowed:boolean}) {
    const p = plan;
    if (!p || !currentPlan(p) || !p.distributed_compute?.p2p_enabled || !hls || !primaryPeer || !Hls.isSupported())
      throw new Error("当前主播放器不能启用 P2P 分片共享");
    const peer = primaryPeer;
    await peer.start(consent);
    if (!currentPlan(p) || primaryPeer !== peer || !roomIsActive()) {
      await peer.stop();
      throw new PlaybackCancelled();
    }
    updatePeerStats();
  }
  async function useDistributedOutput(value: DistributedComputePlaybackIntent, sourceAudioIndex?: number | null) {
    if (!validDistributedIntent(value)) throw new Error("NAS 产物绑定无效");
    if (sourceAudioIndex !== undefined) {
      if (sourceAudioIndex !== null && (!Number.isInteger(sourceAudioIndex) || sourceAudioIndex < 0 || sourceAudioIndex > 65535)) throw new Error("原片音轨编号无效");
      audioIndex.value = sourceAudioIndex ?? undefined;
    }
    distributedIntent.value = freezeCandidateSnapshot(structuredClone(value));
    mode.value = "auto";
    clearAdvancedPlayback();
    clearLadderPlayback();
    clearStaticHlsAvailability();
    await beginLoad("user_intent");
  }
  async function useOriginalSource() {
    distributedIntent.value = undefined;
    await beginLoad("user_intent");
  }
  const duration = ref(0),
    position = ref(0),
    sessionId = ref<string | null>(null);
  const recoveryState = ref<PlaybackRecoveryState>("idle");
  const preparation = ref<PlaybackPreparationState>({ phase: "idle" });
  function failLocalPlayback(message: string, code?: string, notice = message) {
    preparation.value = {
      ...preparation.value,
      phase: "failed",
      failure: {
        message,
        code,
        retryable: true,
        ownsNotice: (value) => value === notice,
      },
    };
  }
  function failNativeCompatibility(p: PlaybackPlan, message: string) {
    if (plan !== p || !p.native_platform?.compatibility) return;
    failedCompatibilityPlan = p;
    clearTimeout(nativeRefresh);
    nativeRefresh = undefined;
    invalidatePlayActions();
    video.value?.pause();
    hls?.stopLoad();
    firstFrameDeadline?.stop();
    mediaDataLoad?.stop();
    recoveringHls = false;
    waiting.value = false;
    error.value = message;
    failLocalPlayback(message, "NATIVE_PLATFORM_DELIVERY_INVALID");
  }
  const playbackSummary = ref<PlaybackSummary>();
  const recoveryLabel = computed(() => {
    switch (recoveryState.value) {
      case "calibrating":
        return "正在重新校准房间时间…";
      case "catching_up":
        return "正在追赶房间进度…";
      case "waiting":
        return "等待播放就绪后追赶…";
      case "blocked":
        return "等待点击加入播放";
      case "unsupported_rate":
        return "本地播放器不支持此速率";
      case "reconnecting":
        return "正在重连，连接后重新校准…";
      default:
        return "";
    }
  });
  let recoveryPending = false,
    confirmedBaseRate: number | undefined,
    rejectedBaseRate: number | undefined;
  let hls: Hls | undefined,
    plan: PlaybackPlan | undefined,
    loadSerial = 0,
    clockAction: "load" | "apply" | undefined;
  let recoveringHls = false,
    terminalEnd = false,
    capabilityProbe: AbortController | undefined,
    generationWait: AbortController | undefined,
    generationWaitFailed = false,
    generatedEnd: number | undefined;
  let mediaDataLoad:
    | { sourceChanged: () => void; sync: () => void; stop: () => void }
    | undefined;
  let firstFrameDeadline:
    ReturnType<typeof createFirstFrameDeadline> | undefined;
  const firstFrameTimeoutError =
    "播放首帧等待超时，尚未确认画面呈现，请重新加载播放";
  const mediaDataTimeoutError = "媒体数据加载超时，请检查连接或重新加载播放";
  const corrector = new Corrector();
  let rates: PlaybackRateSupport | undefined,
    applySerial = 0,
    pendingUserSeek = false,
    pendingForce = false,
    seekSerial = 0;
  let pendingPlay: object | undefined;
  let playFailed = false;
  function invalidatePlayActions() {
    ++applySerial;
    pendingPlay = undefined;
    playFailed = false;
  }
  const playFailureIs = (failure: unknown, name: string) =>
    !!failure &&
    typeof failure === "object" &&
    "name" in failure &&
    failure.name === name;
  const clockRevision = () => clock.revision ?? 0;
  const clockUsable = () => {
    ctx.checkClock?.();
    return (live.value || clock.ready) && connected.value && foreground();
  };
  function bestEffort<T>(action: () => T): T | undefined {
    try {
      return action();
    } catch {
      // Local telemetry must never prevent a media action or grant teardown.
      return undefined;
    }
  }
  const unsupportedRateError =
    "本地播放器不支持此速率，请调整房间倍速或重新加载";
  const playInterruptedError = "媒体播放被中断，请重试或重新加载播放";
  function reportPlayInterruption() {
    if (!error.value) error.value = playInterruptedError;
  }
  function reportUnsupportedRate() {
    rejectedBaseRate = state.value?.playback_rate;
    if (!error.value || error.value === unsupportedRateError)
      error.value = unsupportedRateError;
  }
  function runAutomaticApply(force = false, userSeek = false) {
    const previousError = error.value;
    return run(async () => {
      // The room's action runner clears errors for user actions. Automatic
      // convergence must preserve unrelated authentication/media failures.
      if (
        previousError &&
        previousError !== unsupportedRateError &&
        !error.value
      )
        error.value = previousError;
      await applyState(force, userSeek);
    });
  }
  function baseRate() {
    const rate = state.value?.playback_rate;
    if (rate === undefined || !rates) return false;
    const supported = rates.ensureBase(rate);
    if (!supported) reportUnsupportedRate();
    else {
      confirmedBaseRate = rate;
      rejectedBaseRate = undefined;
      if (error.value === unsupportedRateError) error.value = "";
    }
    return supported;
  }
  function restoreBaseRate() {
    if (baseRate() && !rates!.restoreBase()) reportUnsupportedRate();
  }
  function queueApply(force = false, userSeek = false) {
    pendingForce ||= force;
    pendingUserSeek ||= userSeek;
    clockAction ??= "apply";
  }
  let planGenerations = new PlaybackPlanGenerations();
  const currentPlan = (p: PlaybackPlan) =>
    plan === p &&
    planGenerations.current(p) &&
    (!p.native_platform?.live ||
      (!!state.value && liveRoomMatchesPlan(state.value, p)));
  let playbackRequests: PlaybackRequests | undefined;
  let playbackUser: string | undefined;
  let playbackEpoch: number | undefined;
  let observations: ReturnType<typeof bindPlaybackObservations> | undefined;
  let staticChildState: StaticChildState | undefined;
  let staticBinding: StaticHlsPlanBinding | undefined;
  type MetricIntent = {
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
  type CandidateDiscovery = {
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
  let metricIntent: MetricIntent | undefined;
  let metricSource: ReturnType<typeof bindPlaybackMetricEvents> | undefined;
  let pendingLoad:
    | {
        metrics: MetricIntent;
        intent: ReturnType<PlaybackPlanGenerations["next"]>;
        failed: string[];
        preparing: boolean;
        continuation?: PlaybackContinuation;
      }
    | undefined;
  const metricSender = createPlaybackMetricsSender((binding, body, signal) =>
    session.api<PlaybackMetricsReceipt>(
      `/playback-sessions/${binding.sessionId}/metrics`,
      "POST",
      body,
      signal,
    ),
  );
  const foreground = () =>
    typeof document === "undefined" || document.visibilityState !== "hidden";
  function refreshRecovery() {
    const s = state.value,
      el = video.value;
    const ownsPlan =
      !!plan &&
      currentPlan(plan) &&
      !!metricIntent &&
      metricCurrent(metricIntent);
    const ownsLoad = !!pendingLoad && metricCurrent(pendingLoad.metrics);
    const prefixEnded = el?.ended && plan?.rebuild_on_seek && !terminalEnd;
    if (
      !roomIsActive() ||
      !s?.media_id ||
      !el ||
      (!ownsPlan && !ownsLoad) ||
      (ownsPlan && plan!.media_generation !== s.media_generation) ||
      (el.ended && !prefixEnded)
    ) {
      recoveryPending = false;
      recoveryState.value = "idle";
    } else if (plan?.native_platform?.live) {
      // Decoder-local edge/status recovery never compares a VOD room clock.
      recoveryState.value = error.value
        ? "failed"
        : !connected.value
          ? "reconnecting"
          : !foreground()
            ? "background"
            : blocked.value
              ? "blocked"
              : waiting.value || el.readyState < 2 || pendingPlay
                ? "waiting"
                : "idle";
      recoveryPending = recoveryState.value !== "idle";
    } else if (rejectedBaseRate === s.playback_rate) {
      recoveryState.value = "unsupported_rate";
    } else if (error.value && error.value !== unsupportedRateError) {
      // Authentication/media failures stay in their existing error UI.
      recoveryState.value = "failed";
    } else if (!connected.value) {
      recoveryState.value = "reconnecting";
    } else if (!foreground()) {
      recoveryState.value = "background";
    } else if (!clock.ready) {
      recoveryState.value = "calibrating";
    } else if (prefixEnded) {
      // A growing HLS prefix ending is not a completed film or recovery.
      recoveryPending = true;
      recoveryState.value = "waiting";
    } else if (!recoveryPending) {
      recoveryState.value = "idle";
    } else if (blocked.value) {
      recoveryState.value = "blocked";
    } else if (
      !ownsPlan ||
      ownsLoad ||
      waiting.value ||
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
      recoveryState.value = "waiting";
    } else {
      const expected = Math.min(
        generatedEnd ?? Infinity,
        Math.max(0, (target(s, clock.now()) - plan!.timeline_origin_ms) / 1000),
      );
      if (!containsPlaybackPosition(availablePlaybackRanges(el), expected)) {
        recoveryState.value = "waiting";
        return;
      }
      const drift = Math.abs(expected - el.currentTime) * 1000;
      const window = rates.fineUnsupported ? 500 : 150;
      const matchesStatus =
        s.playback_status === "playing" ? !el.paused : el.paused;
      if (matchesStatus && Number.isFinite(drift) && drift <= window) {
        recoveryPending = false;
        recoveryState.value = "idle";
      } else recoveryState.value = "catching_up";
    }
  }
  // Only actions update the status; rendering never samples the clock or writes
  // a rate. Ordinary drift does not reopen an already completed recovery.
  const updateRecovery = () => bestEffort(refreshRecovery);
  const metricCurrent = (m: MetricIntent) =>
    metricIntent === m &&
    roomIsActive() &&
    session.user?.id === m.user &&
    session.epoch === m.epoch &&
    (!usesPlatformAccount(m.nativeProvider) ||
      m.nativeCredentialMode === "anonymous" ||
      accountRevision(m.nativeProvider) === m.accountChange) &&
    state.value?.room_id === m.room &&
    state.value?.media_generation === m.media &&
    state.value?.media_id === m.mediaId &&
    (!m.element || video.value === m.element);
  const candidateIntentCurrent = (m: MetricIntent) =>
    metricCurrent(m) &&
    !m.inputsInvalidated &&
    sameDistributedIntent(distributedIntent.value, m.distributed) &&
    mode.value === m.mode &&
    audioIndex.value === m.audio &&
    localHlsLadderEnabled.value === !!m.ladder &&
    staticHlsFallbackEnabled.value === m.staticHlsFallback &&
    toneMapHdr.value === (m.advanced?.tone_map_hdr ?? false) &&
    burnInSubtitleIndex.value ===
      (m.advanced?.subtitle_stream_index ?? undefined) &&
    nativeQualityMaxHeight.value === m.nativeQualityMaxHeight &&
    nativePlaybackMode.value === m.nativePlaybackMode &&
    (!usesPlatformAccount(m.nativeProvider) ||
      nativeCredentialMode.value === m.nativeCredentialMode);
  function invalidateCandidates(m: MetricIntent) {
    m.inputsInvalidated = true;
    m.candidateDiscovery?.probe.abort();
    m.candidateDiscovery = undefined;
    m.concreteCandidates = undefined;
  }
  function checkCandidateLifetime(snapshot: CandidateDiscovery) {
    const startedAt =
      snapshot.upstream?.startedAt ?? snapshot.concrete?.startedAt;
    if (startedAt === undefined) return;
    const elapsed = performance.now() - startedAt;
    // This conservative local limit never authorizes a binding. The server's
    // original authority-clock expiry and current fences still decide prepare.
    if (
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      elapsed >= CANDIDATE_LIFETIME_MS
    )
      throw new Error(candidateExpiredError);
  }
  const metricState = () => ({
    foreground: foreground(),
    expectedPlaying: state.value?.playback_status === "playing",
    autoplayBlocked: blocked.value,
    buffering: !!generationWait || recoveringHls,
  });
  const metricRead = () =>
    bestEffort(() => metricSource?.read()) ?? {
      ...metricState(),
      paused: video.value?.paused ?? true,
      seeking: video.value?.seeking ?? false,
    };
  function observeMetrics() {
    const m = metricIntent;
    if (m && metricCurrent(m))
      bestEffort(() => m.meter?.observe(m.fence, metricRead()));
  }
  function visibilityChanged() {
    mediaDataLoad?.sync();
    firstFrameDeadline?.sync();
    observeMetrics();
    updateRecovery();
  }
  function finishMetrics() {
    staticChildState?.close();
    staticChildState = undefined;
    staticBinding = undefined;
    const m = metricIntent;
    if (m && metricCurrent(m)) {
      const final = bestEffort(() => m.meter?.dispose(m.fence, metricRead()));
      if (final && !m.disabled) bestEffort(() => metricSender.offer(final));
    }
    if (m) invalidateCandidates(m);
    metricIntent = undefined;
    pendingLoad = undefined;
    bestEffort(() => metricSource?.stop());
    metricSource = undefined;
    bestEffort(() => metricSender.unbind(true));
  }
  function advanceMetricAttempt(m: MetricIntent) {
    bestEffort(() => metricSource?.stop());
    metricSource = undefined;
    m.fence = { identity: m.identity, generation: m.fence.generation + 1 };
    bestEffort(() => m.meter?.beginAttempt(m.fence, metricRead()));
  }
  function bindMetricSource(
    p: PlaybackPlan,
    el: HTMLVideoElement,
    restart = false,
  ) {
    const m = metricIntent;
    // Local evidence precedes optional negotiation. A later valid grant may
    // enable this same meter; never reconstruct its source phases or frame then.
    if (
      !m?.meter ||
      !metricCurrent(m) ||
      m.disabled ||
      !Number.isInteger(p.plan_generation) ||
      p.plan_generation! < 1 ||
      p.plan_generation! > 0xffff_ffff
    )
      return;
    if (restart) advanceMetricAttempt(m);
    const fence = m.fence;
    const meter = m.meter;
    metricSource = bestEffort(() =>
      bindPlaybackMetricEvents({
        element: el,
        meter,
        fence,
        planGeneration: p.plan_generation!,
        current: () =>
          metricCurrent(m) &&
          m.fence === fence &&
          currentPlan(p) &&
          video.value === el,
        state: metricState,
      }),
    );
  }
  function attachMetricSource() {
    const m = metricIntent;
    if (!m?.meter || m.disabled || !metricCurrent(m)) return;
    if (bestEffort(() => metricSource?.attachSource()) !== true) {
      // An actual source edge was lost. Do not emit coherent-looking phase
      // totals reconstructed from the later playback state.
      m.disabled = true;
      bestEffort(() => metricSender.unbind());
      bestEffort(() => metricSource?.stop());
      metricSource = undefined;
    }
  }
  function bindMetricGrant(p: PlaybackPlan) {
    const m = metricIntent,
      grant = p.playback_metrics,
      version = p.playback_metrics_version;
    if (
      !m ||
      !metricCurrent(m) ||
      m.disabled ||
      (version !== 1 && version !== 2) ||
      !Number.isInteger(p.plan_generation) ||
      p.plan_generation! < m.startGeneration ||
      p.plan_generation! > 0xffff_ffff ||
      (m.metricsVersion !== undefined && m.metricsVersion !== version) ||
      !grant ||
      grant.closed !== false ||
      grant.meter_start_generation !== m.startGeneration ||
      grant.startup_origin !== m.origin ||
      !Number.isSafeInteger(grant.metrics_seq) ||
      grant.metrics_seq < 0 ||
      grant.metrics_seq > (m.last?.seq ?? 0) ||
      (grant.last_sample !== undefined &&
        (grant.last_sample.version !== version ||
          grant.last_sample.seq !== grant.metrics_seq ||
          grant.last_sample.meter_start_generation !== m.startGeneration ||
          grant.last_sample.startup_origin !== m.origin))
    ) {
      if (
        m &&
        grant &&
        (grant.closed ||
          grant.metrics_seq > (m.last?.seq ?? 0) ||
          (m.metricsVersion !== undefined && m.metricsVersion !== version))
      )
        m.disabled = true;
      return;
    }
    m.metricsVersion ??= version;
    bestEffort(() =>
      metricSender.bind({
        version,
        sessionId: p.session_id,
        planGeneration: p.plan_generation!,
        mediaGeneration: p.media_generation,
        meterStartGeneration: m.startGeneration,
        startupOrigin: m.origin,
        current: () => metricCurrent(m) && currentPlan(p),
      }),
    );
  }
  function sampleMetrics() {
    const m = metricIntent;
    if (!m || !metricCurrent(m)) return;
    if (
      Math.floor(performance.now()) - Math.floor(m.t0) >
      PLAYBACK_METRICS_MAX_ELAPSED_MS
    ) {
      m.disabled = true;
      bestEffort(() => metricSender.unbind());
      bestEffort(() => metricSource?.stop());
      metricSource = undefined;
      return;
    }
    bestEffort(() => metricSource?.progress());
    const snapshot = bestEffort(() => m.meter?.sample(m.fence, metricRead()));
    if (snapshot) {
      m.last = snapshot;
      if (!m.disabled) bestEffort(() => metricSender.offer(snapshot));
    }
  }
  // Accepted intent/visibility edges remain separate from observation-v1 flags.
  watch(
    () => [
      session.epoch,
      session.user?.id,
      roomIsActive(),
      state.value?.room_id,
      state.value?.media_id,
      state.value?.media_generation,
      state.value?.playback_status,
    ],
    () => {
      if (metricIntent && !metricCurrent(metricIntent)) finishMetrics();
      else observeMetrics();
    },
    { flush: "sync" },
  );
  watch(
    () => [
      mode.value,
      audioIndex.value,
      toneMapHdr.value,
      burnInSubtitleIndex.value,
      localHlsLadderEnabled.value,
      staticHlsFallbackEnabled.value,
      nativePlaybackMode.value,
    ],
    () => {
      if (metricIntent) invalidateCandidates(metricIntent);
    },
    { flush: "sync" },
  );
  watch(qualityScope, () => clearNativeQuality(true), { flush: "sync" });
  watch(advancedScope, () => { distributedIntent.value = undefined; void stopPeerSharing(); }, {flush:"sync"});
  watch(advancedScope, clearAdvancedPlayback, { flush: "sync" });
  watch(advancedScope, clearLadderPlayback, { flush: "sync" });
  watch(advancedScope, clearStaticHlsAvailability, { flush: "sync" });
  watch(nativeCredentialMode, () => clearNativeQuality(true), {
    flush: "sync",
  });
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", visibilityChanged);
  let checkingEnd = false,
    endAttempt = -Infinity;
  function recoverExpiredLiveWindow(p: PlaybackPlan): boolean {
    const metrics = metricIntent;
    const scope = liveWindowScope();
    if (
      terminalEnd ||
      !scope ||
      !metrics ||
      !currentPlan(p) ||
      !candidateIntentCurrent(metrics) ||
      liveWindowRecovery?.scope !== scope ||
      liveWindowRecovery.consumed
    )
      return false;
    // Claim before any asynchronous cleanup so duplicate/stale loader callbacks
    // cannot allocate another generation. No broadcast import or room mutation.
    liveWindowRecovery.consumed = true;
    liveWindowRecovery.parent = p;
    clearTimeout(nativeRefresh);
    nativeRefresh = undefined;
    liveNeedsEdge = true;
    error.value = "";
    const loading = beginLoad("automatic_load");
    if (loading) void run(() => loading);
    return true;
  }
  function bindLiveWindowProgress(p: PlaybackPlan, el: HTMLVideoElement) {
    liveWindowProgressStop?.();
    liveWindowProgressStop = undefined;
    const budget = liveWindowRecovery,
      scope = liveWindowScope();
    if (
      !p.native_platform?.live ||
      !budget?.consumed ||
      budget.scope !== scope ||
      !budget.parent ||
      p.session_id === budget.parent.session_id ||
      (p.plan_generation ?? 0) <= (budget.parent.plan_generation ?? 0)
    )
      return;
    budget.replacement = p;
    budget.resumedAt = budget.resumedPosition = undefined;
    const current = () =>
      liveWindowRecovery === budget &&
      budget.replacement === p &&
      currentPlan(p) &&
      liveWindowScope() === scope &&
      connected.value &&
      foreground() &&
      state.value?.playback_status === "playing" &&
      !el.paused &&
      !el.seeking &&
      !el.ended &&
      el.readyState >= 2 &&
      Number.isFinite(el.currentTime);
    const playing = () => {
      if (!current()) return;
      budget.resumedAt = performance.now();
      budget.resumedPosition = el.currentTime;
    };
    const progress = () => {
      if (
        !current() ||
        budget.resumedAt === undefined ||
        budget.resumedPosition === undefined
      )
        return;
      const elapsed = (performance.now() - budget.resumedAt) / 1000;
      const advanced = el.currentTime - budget.resumedPosition;
      // A seek/jump or a prepare response does not certify resumed decoding.
      if (
        !Number.isFinite(elapsed) ||
        elapsed < 1 ||
        advanced < 0.5 ||
        advanced > elapsed * 1.25 + 0.25
      )
        return;
      budget.consumed = budget.probed = false;
      budget.parent = budget.replacement = undefined;
      budget.resumedAt = budget.resumedPosition = undefined;
      liveWindowProgressStop?.();
      liveWindowProgressStop = undefined;
    };
    el.addEventListener("playing", playing);
    el.addEventListener("timeupdate", progress);
    liveWindowProgressStop = () => {
      el.removeEventListener("playing", playing);
      el.removeEventListener("timeupdate", progress);
    };
  }
  async function probeExpiredNativeLiveWindow(p: PlaybackPlan) {
    const metrics = metricIntent,
      scope = liveWindowScope(),
      budget = liveWindowRecovery;
    const current = () =>
      !terminalEnd &&
      !!scope &&
      !!metrics &&
      currentPlan(p) &&
      candidateIntentCurrent(metrics) &&
      liveWindowScope() === scope &&
      liveWindowRecovery === budget;
    if (!current()) return;
    if (liveWindowProbe) return; // Duplicate native errors share the one pending probe.
    if (
      !budget ||
      budget.scope !== scope ||
      budget.consumed ||
      budget.probed ||
      !validNativeLiveDeliveryUrl(
        p.playback_url,
        p.session_id,
        location.origin,
        true,
        p.native_platform!.live!.version,
      )
    ) {
      failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
      return;
    }
    budget.probed = true;
    clearTimeout(nativeRefresh);
    nativeRefresh = undefined;
    video.value?.pause();
    const controller = new AbortController();
    liveWindowProbe = controller;
    const startedWall = Date.now(),
      startedMono = performance.now();
    const expired = () =>
      Date.now() - startedWall >= 2500 ||
      performance.now() - startedMono >= 2500 ||
      Date.now() < startedWall ||
      performance.now() < startedMono;
    const timeout = setTimeout(() => controller.abort(), 2500);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("native_live_probe_aborted")),
        { once: true },
      );
    });
    try {
      const response = await Promise.race([
        fetch(p.playback_url, {
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        }),
        aborted,
      ]);
      if (!current()) return;
      if (controller.signal.aborted || expired()) {
        failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
        return;
      }
      if (
        response.status !== 409 ||
        !response.headers.get("content-type")?.startsWith("application/json") ||
        (response.url &&
          !validNativeLiveDeliveryUrl(
            response.url,
            p.session_id,
            location.origin,
            true,
            p.native_platform!.live!.version,
          )) ||
        Number(response.headers.get("content-length") ?? 0) > 16384 ||
        !response.body
      ) {
        void response.body?.cancel().catch(() => {});
        failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
        return;
      }
      const reader = response.body.getReader();
      const bytes = new Uint8Array(16384);
      let size = 0;
      try {
        while (true) {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (!current()) return;
          if (controller.signal.aborted || expired()) {
            failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
            return;
          }
          if (chunk.done) break;
          if (size + chunk.value.byteLength > bytes.byteLength) {
            controller.abort();
            throw new Error("oversized_live_error");
          }
          bytes.set(chunk.value, size);
          size += chunk.value.byteLength;
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      const code = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)))
        ?.error?.code;
      if (
        current() &&
        !expired() &&
        code === "NATIVE_LIVE_WINDOW_EXPIRED" &&
        recoverExpiredLiveWindow(p)
      )
        return;
      if (current()) failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
    } catch {
      if (current()) failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
    } finally {
      clearTimeout(timeout);
      if (liveWindowProbe === controller) liveWindowProbe = undefined;
    }
  }
  function failNativeLive(
    p: PlaybackPlan,
    code = "NATIVE_LIVE_NOT_BROADCASTING",
  ) {
    if (plan !== p || !p.native_platform?.live) return;
    terminalEnd = true;
    liveWindowProbe?.abort();
    liveWindowProbe = undefined;
    liveWindowProgressStop?.();
    liveWindowProgressStop = undefined;
    clearTimeout(nativeRefresh);
    nativeRefresh = undefined;
    invalidatePlayActions();
    firstFrameDeadline?.stop();
    mediaDataLoad?.stop();
    video.value?.pause();
    hls?.stopLoad();
    platformText.reset();
    waiting.value = false;
    const failure = new RequestFailure({ error: { code } });
    error.value = failure.message;
    failLocalPlayback(failure.message, code);
    if (preparation.value.failure) preparation.value.failure.retryable = false;
  }
  async function completed() {
    const p = plan,
      el = video.value,
      s = state.value;
    if (p?.native_platform?.live) {
      if (el?.ended && plan === p) failNativeLive(p);
      return;
    }
    if (
      !roomIsActive() ||
      !p ||
      !el?.ended ||
      !s ||
      !connected.value ||
      s.playback_status !== "playing" ||
      p.media_generation !== s.media_generation ||
      checkingEnd ||
      performance.now() - endAttempt < 2000
    )
      return;
    checkingEnd = true;
    endAttempt = performance.now();
    try {
      // A generated HLS prefix ending is not the end of the film.
      if (p.rebuild_on_seek) {
        const readiness = await readReadiness(
          p.session_id,
          AbortSignal.timeout(5000),
          0,
          p.plan_generation,
        );
        if (
          !currentPlan(p) ||
          state.value?.media_generation !== p.media_generation
        )
          return;
        if (!readiness.complete) {
          await waitForGenerated(p);
          return;
        }
      }
      if (
        currentPlan(p) &&
        roomIsActive() &&
        el.ended &&
        state.value?.playback_status === "playing"
      ) {
        terminalEnd = true;
        recoveryPending = false;
        updateRecovery();
        bestEffort(() => observations?.completed());
        ctx.ended?.(el.currentTime * 1000 + p.timeline_origin_ms);
      }
    } catch (failure) {
      if (currentPlan(p))
        error.value =
          failure instanceof Error ? failure.message : String(failure);
    } finally {
      checkingEnd = false;
    }
  }
  function requests() {
    const user = session.user!.id;
    const epoch = session.epoch;
    if (!playbackRequests || playbackUser !== user || playbackEpoch !== epoch) {
      playbackUser = user;
      playbackEpoch = epoch;
      playbackRequests = new PlaybackRequests(
        (body, signal) => {
          if (session.epoch !== epoch) throw new StaleIdentity();
          const provider = metricIntent?.nativeProvider;
          if (Object.hasOwn(body, "static_hls_fallback")) {
            const metrics = metricIntent;
            // Lost-response replay keeps the frozen child after parent detach,
            // but a replacement source, input, Stop or logout closes its fence.
            if (!metrics || !candidateIntentCurrent(metrics))
              throw new PlaybackCancelled();
            const replay = staticChildState?.retry({
              room_id: body.room_id,
              media_id: metrics.mediaId,
              media_generation: body.media_generation,
              viewer_id: body.viewer_id ?? "",
              plan_generation: body.plan_generation ?? 0,
            });
            if (!replay || JSON.stringify(body) !== replay.body)
              throw new PlaybackCancelled();
          }
          if (body.upstream_profile_report) {
            const snapshot = metricIntent?.concreteCandidates;
            if (
              !snapshot?.upstream ||
              !candidateIntentCurrent(metricIntent!) ||
              snapshot.upstream.report.binding !==
                body.upstream_profile_report.binding
            )
              throw new PlaybackCancelled();
            checkCandidateLifetime(snapshot);
          }
          if (body.local_hls_ladder) {
            const metrics = metricIntent,
              snapshot = metrics?.concreteCandidates;
            if (
              !metrics ||
              !candidateIntentCurrent(metrics) ||
              !snapshot?.concrete ||
              !sameLocalHlsLadderRequest(
                metrics.ladder,
                body.local_hls_ladder,
              ) ||
              snapshot.report?.binding !== body.candidate_report?.binding
            )
              throw new PlaybackCancelled();
            checkCandidateLifetime(snapshot);
          }
          if (body.advanced_playback) {
            const metrics = metricIntent;
            const snapshot = metrics?.concreteCandidates;
            if (
              !metrics ||
              !candidateIntentCurrent(metrics) ||
              !snapshot?.concrete ||
              !sameAdvancedPlaybackRequest(
                metrics.advanced,
                body.advanced_playback,
              ) ||
              snapshot.report?.binding !== body.candidate_report?.binding
            )
              throw new PlaybackCancelled();
            checkCandidateLifetime(snapshot);
          }
          return session
            .api<PlaybackPlan>(
              body.distributed_compute
                ? "/playback-sessions/distributed-compute"
                : body.native_platform
                ? body.native_platform.compatibility
                  ? "/playback-sessions/native-platform-compatibility"
                  : "/playback-sessions/native-platform"
                : body.local_hls_ladder
                  ? "/playback-sessions/local-hls-ladder"
                  : body.advanced_playback
                    ? "/playback-sessions/advanced-local"
                    : body.upstream_profile_report
                      ? "/playback-sessions/upstream-profile"
                      : body.http_file_fallback
                        ? "/playback-sessions/http-file-continuation"
                        : "/playback-sessions",
              "POST",
              body.upstream_profile_report ? structuredClone(body) : body,
              signal,
            )
            .then((result) => {
              // Check before readiness arithmetic, subtitle binding, seeking or
              // observations can consume an unproven/nonfinite scalar origin.
              if (
                body.native_platform
                  ? !provider ||
                    !validNativePlatformPlan(
                      body,
                      result,
                      location.origin,
                      provider,
                      state.value?.live?.broadcast_id,
                      metricIntent?.nativeCourse === true,
                    )
                  : !!result.native_platform ||
                    result.transport === "dash" ||
                    !hasUsablePlaybackTimeline(result)
              )
                throw new RequestFailure({
                  error: { code: "UNSUPPORTED_TIMELINE" },
                });
              if (!matchesDistributedPlaybackPlan(body, result))
                throw new RequestFailure({error:{code:"STALE_CAPABILITY_REPORT"}});
              if (
                !matchesLocalHlsLadderPlan(
                  body.local_hls_ladder,
                  result,
                  location.origin,
                  metricIntent?.concreteCandidates?.concrete?.candidates
                    .local_hls_ladder,
                )
              )
                throw new RequestFailure({
                  error: { code: "STALE_CAPABILITY_REPORT" },
                });
              if (!matchesAdvancedPlaybackPlan(body.advanced_playback, result))
                throw new RequestFailure({
                  error: { code: "STALE_CAPABILITY_REPORT" },
                });
              if (
                !signal.aborted &&
                roomIsActive() &&
                matchesPlanGeneration(
                  body.plan_generation,
                  result.plan_generation,
                ) &&
                result.plan_generation !== undefined
              )
                preparation.value = applyPreparationSnapshot(
                  preparation.value,
                  {
                    generation: result.plan_generation,
                    sessionId: result.session_id,
                    deliveryMode: result.delivery_mode,
                    phase: "preparing",
                  },
                );
              return result;
            });
        },
        (key, signal) => {
          if (session.epoch !== epoch) throw new StaleIdentity();
          return session.api(
            "/playback-requests/" + key,
            "DELETE",
            undefined,
            signal,
          );
        },
        sessionStorage,
        `rainsync:playback:${user}`,
        readReadiness,
        () => (state.value?.playback_status === "playing" ? 4000 : 0),
      );
    }
    return playbackRequests;
  }
  async function readReadiness(
    id: string,
    signal: AbortSignal,
    relativePosition = 0,
    planGeneration?: number,
    currentRelativePosition?: () => number,
  ): Promise<PlaybackReadiness> {
    let readiness = await session.api<PlaybackReadiness>(
      `/playback-sessions/${id}?relative_position_ms=${encodeURIComponent(relativePosition)}${planGeneration === undefined ? "" : `&plan_generation=${planGeneration}`}`,
      "GET",
      undefined,
      signal,
    );
    if (
      readiness.session_id !== id ||
      !matchesPlanGeneration(planGeneration, readiness.plan_generation)
    )
      throw new RequestFailure({ error: { code: "STALE_PLAYBACK_PLAN" } });
    // A running EVENT prefix needs one whole segment ahead of the room clock.
    // Network time can consume that lead. Recheck the current target after the
    // response, not only the position sent in the request. Complete/legacy
    // responses and a paused room still need no forward lead.
    if (
      state.value?.playback_status === "playing" &&
      readiness.status === "ready" &&
      readiness.complete === false &&
      readiness.available_until_ms != null &&
      Number.isFinite(readiness.available_until_ms) &&
      readiness.available_until_ms -
        (currentRelativePosition?.() ?? relativePosition) <
        4_000
    ) {
      readiness = { ...readiness, status: "preparing" };
    }
    const snapshot = preparationReadinessSnapshot(
      readiness,
      preparation.value.deliveryMode,
    );
    if (!signal.aborted && roomIsActive() && snapshot)
      preparation.value = applyPreparationSnapshot(preparation.value, snapshot);
    return readiness;
  }
  function detachPlayback(
    preserveCandidates?: MetricIntent,
    child?: PlaybackContinuation["staticChild"],
  ) {
    upstreamObserver?.stop();
    upstreamObserver = undefined;
    upstreamMeasuredOutput.value = undefined;
    upstreamMeasuredMatchesRequested.value = undefined;
    platformText.reset();
    liveWindowProbe?.abort();
    liveWindowProbe = undefined;
    liveWindowProgressStop?.();
    liveWindowProgressStop = undefined;
    if (staticChildState !== child?.state) {
      staticChildState?.close();
      staticChildState = undefined;
    }
    staticBinding = undefined;
    recoveryPending = false;
    recoveryState.value = "idle";
    terminalEnd = false;
    liveNeedsEdge = true;
    invalidatePlayActions();
    // Grant teardown alone (including automatic fallback) never ends its meter.
    bestEffort(() => metricSource?.stop());
    metricSource = undefined;
    bestEffort(() => metricSender.unbind(true));
    // Capture the old element before teardown changes its time or identity.
    const finalObservation = bestEffort(() =>
      observations?.stop(child?.finalObservation),
    );
    observations = undefined;
    firstFrameDeadline?.stop();
    firstFrameDeadline = undefined;
    mediaDataLoad?.stop();
    mediaDataLoad = undefined;
    if (capabilityProbe !== preserveCandidates?.candidateDiscovery?.probe) {
      capabilityProbe?.abort();
      capabilityProbe = undefined;
    }
    generationWait?.abort();
    generationWait = undefined;
    generationWaitFailed = false;
    generatedEnd = undefined;
    recoveringHls = false;
    const old = plan;
    plan = undefined;
    playbackSummary.value = undefined;
    sessionId.value = null;
    if (video.value) {
      video.value.onerror = null;
      video.value.onended = null;
      video.value.onloadedmetadata = null;
      video.value.onloadeddata = null;
    }
    clearTimeout(nativeRefresh);
    nativeRefresh = undefined;
    dash?.destroy();
    dash = undefined;
    nativePlatform.value = false;
    nativeProvider.value = undefined;
    clearNativeQuality();
    advancedFacts.value = undefined;
    ladderFacts.value = undefined;
    ladderSelected.value = undefined;
    ladderManual.value = false;
    ladderLevelMap = undefined;
    hls?.destroy();
    hls = undefined;
    const oldPeer = primaryPeer;
    primaryPeer = undefined;
    void oldPeer?.stop();
    distributedFacts.value = undefined;
    peerSharing.value = false;
    peerStats.value = undefined;
    if (video.value) {
      video.value.pause();
      video.value.removeAttribute("src");
      video.value.load();
    }
    // Capture and cancel this operation before the first asynchronous wait.
    // A late session DELETE must never call stop() on a newer preparation.
    const previous = playbackRequests;
    const deletePrevious = async () => {
      if (old)
        await session
          .api(
            `/playback-sessions/${old.session_id}`,
            "DELETE",
            finalObservation,
            AbortSignal.timeout(5000),
          )
          .catch(() => {});
    };
    return { old, finalObservation, previous, deletePrevious };
  }
  async function stopPlayback(preserveCandidates?: MetricIntent) {
    const { finalObservation, previous, deletePrevious } =
      detachPlayback(preserveCandidates);
    // The final sample and Stop commit together before key cancellation can
    // close the grant. Preparing work is still aborted synchronously in stop().
    const beforeCleanup = finalObservation ? deletePrevious : undefined;
    const cancellation = (
      previous
        ? previous.stop(beforeCleanup)
        : session.user
          ? requests().stop(beforeCleanup)
          : Promise.resolve()
    ).catch((e) => {
      if (!(e instanceof StaleIdentity)) throw e;
    });
    await Promise.all([
      cancellation,
      beforeCleanup ? Promise.resolve() : deletePrevious(),
    ]);
  }
  function beginLoad(
    origin: PlaybackMetricsOrigin,
    originRecoveryUsed = false,
  ): Promise<void> | undefined {
    if (!roomIsActive()) return;
    const s = state.value;
    if (!s?.media_id) return;
    const liveScope = liveWindowScope();
    if (origin === "user_intent" || liveWindowRecovery?.scope !== liveScope)
      liveWindowRecovery = liveScope
        ? { scope: liveScope, consumed: false, probed: false }
        : undefined;
    liveWindowProbe?.abort();
    liveWindowProbe = undefined;
    liveWindowProgressStop?.();
    liveWindowProgressStop = undefined;
    const advanced = advancedPlaybackRequest(
      {
        toneMapHdr: toneMapHdr.value,
        subtitleStreamIndex: burnInSubtitleIndex.value,
      },
      advancedCapabilities.value,
    );
    const ladder = localHlsLadderRequest(
      localHlsLadderEnabled.value,
      ladderCapabilities.value,
      !!advanced,
    );
    validateFiniteHlsChoice(mode.value, { advanced, ladder, distributed: distributedIntent.value });
    platformText.reset();
    const t0 = performance.now();
    finishMetrics();
    // A source/account refresh immediately retires the owned platform decoder,
    // even while room clock calibration or key cleanup is pending.
    clearTimeout(nativeRefresh);
    nativeRefresh = undefined;
    dash?.destroy();
    dash = undefined;
    if (
      plan?.native_platform &&
      (plan.transport === "progressive" ||
        !!plan.native_platform.live ||
        !!plan.native_platform.compatibility) &&
      video.value
    ) {
      // Retire the owned MP4 immediately, even if room-clock calibration delays
      // the replacement request. All stored handlers are fenced by the new intent.
      video.value.onerror = null;
      video.value.onended = null;
      video.value.onloadedmetadata = null;
      video.value.onloadeddata = null;
      if (plan.native_platform.live || plan.native_platform.compatibility) {
        hls?.destroy();
        hls = undefined;
      }
      video.value.pause();
      video.value.removeAttribute("src");
      video.value.load();
    }
    nativePlatform.value = false;
    nativeProvider.value = undefined;
    ++loadSerial;
    clearNativeQuality();
    const intent = planGenerations.next();
    preparation.value = {
      phase: "preparing",
      generation: intent.plan_generation,
    };
    const identity = {};
    const m: MetricIntent = {
      t0,
      identity,
      fence: { identity, generation: 1 },
      startGeneration: intent.plan_generation,
      origin,
      user: session.user?.id,
      epoch: session.epoch,
      room: s.room_id,
      media: s.media_generation,
      mediaId: s.media_id,
      mode: mode.value,
      audio: audioIndex.value,
      advanced,
      ladder,
      staticHlsFallback: staticHlsFallbackEnabled.value,
      distributed: distributedIntent.value ? freezeCandidateSnapshot(structuredClone(distributedIntent.value)) : undefined,
      failedCandidates: [],
      element: video.value,
      disabled: false,
      originRecoveryUsed,
      accountChange: ctx.platformAccountChange?.value ?? 0,
      nativeCredentialMode: nativeCredentialMode.value,
      nativeQualityMaxHeight: nativeQualityMaxHeight.value,
      nativePlaybackMode: nativePlaybackMode.value,
    };
    metricIntent = m;
    rates?.reset();
    confirmedBaseRate = rejectedBaseRate = undefined;
    corrector.reset();
    m.meter = bestEffort(() =>
      createPlaybackMetrics({
        t0: m.t0,
        startupOrigin: origin,
        fence: m.fence,
        current: () => (metricCurrent(m) ? m.fence : undefined),
        initial: metricRead(),
      }),
    );
    return loadAttempt([], intent, m);
  }
  async function loadMedia() {
    await beginLoad("user_intent");
  }
  async function selectNativeQuality(value: string | undefined) {
    const p = plan;
    if (
      !p?.native_platform?.quality ||
      !currentPlan(p) ||
      !metricIntent ||
      !candidateIntentCurrent(metricIntent) ||
      qualityContext !== qualityScope() ||
      (value !== "auto" &&
        !nativeQualityOptions.value.some(
          (option) => option.max_height === value,
        ))
    )
      return;
    if (value === nativeQualityMaxHeight.value) return;
    nativeQualityMaxHeight.value = value as NativePlatformMaxHeight;
    // A quality switch is a fresh per-viewer intent. Room timing is read again
    // when prepared, and every old decoder/callback is retired by beginLoad.
    await beginLoad("user_intent");
  }
  async function fallbackLoad(
    failed: string[] = [],
    continuation?: PlaybackContinuation,
  ) {
    const m = metricIntent;
    if (!m || !candidateIntentCurrent(m)) return;
    if (m.distributed) throw new Error("此 NAS 产物解码失败，请使用 HTTP 重新加载或选择原片源");
    if (m.concreteCandidates?.upstream) throw new Error(candidateError);
    if (m.concreteCandidates) {
      m.failedCandidates = [...new Set([...m.failedCandidates, ...failed])];
      failed = [...m.failedCandidates];
    }
    const intent = planGenerations.next();
    advanceMetricAttempt(m);
    await loadAttempt(failed, intent, m, continuation);
  }
  function discoverCandidates(
    metrics: MetricIntent,
    element: HTMLVideoElement,
  ): Promise<CandidateDiscovery> {
    if (metrics.concreteCandidates)
      return Promise.resolve(metrics.concreteCandidates);
    if (metrics.candidateDiscovery) return metrics.candidateDiscovery.result;
    const probe = new AbortController();
    capabilityProbe = probe;
    const discovery = {
      probe,
      result: undefined as unknown as Promise<CandidateDiscovery>,
    };
    metrics.candidateDiscovery = discovery;
    discovery.result = (async () => {
      let marked = false,
        concrete = false,
        upstreamAttempted = false;
      try {
        const startedAt = performance.now();
        let candidateSet: PlaybackCandidateSet | undefined;
        try {
          candidateSet = await session.api<PlaybackCandidateSet>(
            "/playback-candidates",
            "POST",
            {
              room_id: metrics.room,
              media_generation: metrics.media,
              advanced_playback_capabilities_version: 1,
              local_hls_ladder_capabilities_version: 1,
              audio_index: metrics.audio ?? null,
              position_ms: target(state.value!, clock.now()),
              ...(metrics.ladder ? { local_hls_ladder: metrics.ladder } : {}),
              ...(metrics.advanced
                ? { advanced_playback: metrics.advanced }
                : {}),
              ...(metrics.mode === "direct" ||
              metrics.advanced ||
              metrics.ladder
                ? {}
                : { http_file_capabilities_version: 1 }),
            },
            AbortSignal.any([probe.signal, AbortSignal.timeout(40000)]),
          );
        } catch (failure) {
          if (
            !(failure instanceof RequestFailure) ||
            !["NOT_FOUND", "METHOD_NOT_ALLOWED"].includes(failure.code)
          )
            throw failure;
        }
        const current = () =>
          candidateIntentCurrent(metrics) &&
          metrics.candidateDiscovery === discovery &&
          !probe.signal.aborted &&
          video.value === element;
        if (!current()) throw new PlaybackCancelled();
        let staticHls: CandidateDiscovery["staticHls"];
        if (
          ctx.staticHlsFallback === true &&
          !metrics.advanced &&
          !metrics.ladder &&
          ["auto", "direct"].includes(metrics.mode)
        ) {
          let response: unknown;
          try {
            response = await session.api(
              "/playback-static-hls-capabilities",
              "POST",
              {
                version: 1,
                room_id: metrics.room,
                media_generation: metrics.media,
              },
              AbortSignal.any([probe.signal, AbortSignal.timeout(7500)]),
            );
          } catch {
            /* Unknown, older or unavailable service never opts in. */
          }
          if (!current()) throw new PlaybackCancelled();
          const available = parseStaticHlsAvailability(response);
          staticHlsAvailability.value = available;
          if (available)
            staticHls = {
              availability: available,
              observedAt: performance.now(),
            };
        }
        if (candidateSet?.advanced_playback !== undefined) {
          if (
            !validAdvancedPlaybackCapabilities(candidateSet.advanced_playback)
          )
            throw new Error(candidateError);
          advancedCapabilities.value = freezeCandidateSnapshot(
            structuredClone(candidateSet.advanced_playback),
          );
        } else if (metrics.advanced) throw new Error(candidateError);
        if (candidateSet?.local_hls_ladder !== undefined) {
          if (!validLocalHlsLadderCapabilities(candidateSet.local_hls_ladder))
            throw new Error(candidateError);
          ladderCapabilities.value = freezeCandidateSnapshot(
            structuredClone(candidateSet.local_hls_ladder),
          );
        } else if (metrics.ladder) throw new Error(candidateError);
        marked = candidateSet?.http_file_capabilities_version !== undefined;
        if (marked) {
          if (
            metrics.mode === "direct" ||
            candidateSet!.http_file_capabilities_version !== 1 ||
            candidateSet!.schema_version !== 1 ||
            typeof candidateSet!.binding !== "string" ||
            !candidateSet!.binding.trim() ||
            !Array.isArray(candidateSet!.candidates) ||
            !candidateSet!.candidates.length
          )
            throw new Error(candidateError);
        }
        concrete =
          candidateSet?.schema_version === 1 &&
          typeof candidateSet.binding === "string" &&
          !!candidateSet.binding.trim() &&
          Array.isArray(candidateSet.candidates) &&
          candidateSet.candidates.length > 0;
        if (concrete) {
          // Freeze before device probing: local/Agent and marked HTTP routes
          // retain the source configurations that produced this device report.
          candidateSet = freezeCandidateSnapshot(
            structuredClone(candidateSet!),
          );
        }
        if ((metrics.advanced || metrics.ladder) && !concrete)
          throw new Error(candidateError);
        const profileDiscovery =
          !metrics.advanced &&
          !metrics.ladder &&
          metrics.mode === "transcode" &&
          !concrete;
        let mseProbe: ReturnType<typeof Hls.getMediaSource>;
        let decoder: MediaCapabilities | undefined;
        if (profileDiscovery) {
          // API availability opts into the new envelope; it is not sample
          // evidence. An unavailable/unreadable API keeps legacy negotiation.
          try {
            mseProbe = Hls.isMSESupported() ? Hls.getMediaSource() : undefined;
            if (typeof mseProbe?.isTypeSupported !== "function")
              mseProbe = undefined;
          } catch {
            mseProbe = undefined;
          }
          try {
            decoder =
              typeof navigator === "undefined"
                ? undefined
                : navigator.mediaCapabilities;
            if (typeof decoder?.decodingInfo !== "function")
              decoder = undefined;
          } catch {
            decoder = undefined;
          }
        } else {
          mseProbe = Hls.isSupported() ? Hls.getMediaSource() : undefined;
          decoder =
            typeof navigator === "undefined"
              ? undefined
              : navigator.mediaCapabilities;
        }
        if (profileDiscovery && mseProbe && decoder) {
          if (
            candidateSet &&
            (candidateSet.schema_version !== 1 ||
              candidateSet.binding !== null ||
              !Array.isArray(candidateSet.candidates) ||
              candidateSet.candidates.length !== 0)
          )
            throw new Error(candidateError);
          // Provider legacy/empty candidates negotiate a separate recipe. Keep
          // this attempt (including rejection) for the whole original intent.
          upstreamAttempted = true;
          let upstreamSet: UpstreamProfileCandidateSet | undefined;
          let endpointAbsent = false;
          try {
            upstreamSet = await session.api<UpstreamProfileCandidateSet>(
              "/upstream-profile-candidates",
              "POST",
              {
                // Discovery advertises our maximum supported profile version.
                profile_version: 2,
                room_id: metrics.room,
                media_generation: metrics.media,
                audio_index: metrics.audio ?? null,
                position_ms: target(state.value!, clock.now()),
              },
              AbortSignal.any([probe.signal, AbortSignal.timeout(40000)]),
            );
          } catch (failure) {
            if (
              !(failure instanceof RequestFailure) ||
              failure.code !== "NOT_FOUND"
            )
              throw failure;
            endpointAbsent = true;
          }
          if (!current()) throw new PlaybackCancelled();
          if (!endpointAbsent && upstreamSet === undefined)
            throw new Error(candidateError);
          if (upstreamSet !== undefined) {
            if (
              !upstreamSet ||
              typeof upstreamSet !== "object" ||
              ![1, 2].includes(upstreamSet.profile_version) ||
              typeof upstreamSet.decision_reason !== "string" ||
              Object.keys(upstreamSet).some(
                (key) =>
                  ![
                    "profile_version",
                    "binding",
                    "profile",
                    "decision_reason",
                  ].includes(key),
              )
            )
              throw new Error(candidateError);
            const absent =
              upstreamSet.binding === null && upstreamSet.profile === null;
            if (!absent) {
              marked = true;
              if (
                typeof upstreamSet.binding !== "string" ||
                !upstreamSet.binding.trim() ||
                !isUpstreamProfileEnvelope(upstreamSet.profile) ||
                upstreamSet.profile_version !==
                  upstreamSet.profile.profile_version
              )
                throw new Error(candidateError);
              const candidates = freezeCandidateSnapshot(
                structuredClone(upstreamSet),
              );
              const report = await detectUpstreamProfileReport(
                candidates,
                mseProbe,
                decoder,
                probe.signal,
              );
              if (!current()) throw new PlaybackCancelled();
              if (!report) throw new Error(candidateError);
              const result: CandidateDiscovery = {
                capabilities: detectCapabilities(element, mseProbe),
                upstream: { candidates, report, startedAt },
              };
              metrics.concreteCandidates = freezeCandidateSnapshot(
                structuredClone(result),
              );
              return metrics.concreteCandidates;
            }
          }
        }
        const report = candidateSet
          ? await detectCandidateReport(
              element,
              candidateSet,
              mseProbe,
              decoder,
            )
          : undefined;
        if (!current()) throw new PlaybackCancelled();
        if (concrete && !report) throw new Error(candidateError);
        const capabilities = report
          ? detectCapabilities(element, mseProbe)
          : await detectCapabilitiesAsync(element, mseProbe, decoder);
        if (!current()) throw new PlaybackCancelled();
        const result: CandidateDiscovery = {
          capabilities,
          ...(staticHls ? { staticHls } : {}),
          ...(report ? { report } : {}),
          ...(concrete
            ? { concrete: { candidates: candidateSet!, startedAt } }
            : {}),
        };
        if (concrete) {
          metrics.concreteCandidates = freezeCandidateSnapshot(
            structuredClone(result),
          );
          return metrics.concreteCandidates;
        }
        return result;
      } finally {
        // Empty/old-server negotiation keeps its legacy discovery behavior.
        // Concrete report and marked validation failures stay rejected for this
        // intent; recovery cannot downgrade or discover a replacement source.
        if (
          metrics.candidateDiscovery === discovery &&
          !marked &&
          !concrete &&
          !upstreamAttempted
        )
          metrics.candidateDiscovery = undefined;
        if (capabilityProbe === probe) capabilityProbe = undefined;
      }
    })();
    return discovery.result;
  }
  async function loadAttempt(
    failedCandidates: string[],
    intent: ReturnType<PlaybackPlanGenerations["next"]>,
    metrics: MetricIntent,
    continuation?: PlaybackContinuation,
  ): Promise<void> {
    if (!candidateIntentCurrent(metrics)) return;
    if (preparation.value.generation !== intent.plan_generation)
      preparation.value = {
        phase: "preparing",
        generation: intent.plan_generation,
      };
    const s = state.value!;
    const pending = {
      metrics,
      intent,
      failed: failedCandidates,
      continuation,
      preparing: false,
    };
    pendingLoad = pending;
    recoveryPending = true;
    updateRecovery();
    if (!clockUsable()) {
      clockAction = "load";
      return;
    }
    const revision = clockRevision();
    const serial = ++loadSerial;
    try {
      if (!continuation) await stopPlayback(metrics);
      await nextTick();
      if (
        serial !== loadSerial ||
        !candidateIntentCurrent(metrics) ||
        !roomIsActive() ||
        !video.value ||
        (continuation &&
          !continuation.staticChild &&
          plan !== continuation.parent)
      )
        return;
      recoveryPending = true;
      updateRecovery();
      if (!clockUsable() || revision !== clockRevision()) {
        clockAction = "load";
        return;
      }
      const element = video.value;
      metrics.element = element;
      const identity = session.epoch;
      waiting.value = true;
      const media = ctx.resolveMedia
        ? await ctx.resolveMedia(s.room_id, s.media_id!)
        : undefined;
      if (serial !== loadSerial || !candidateIntentCurrent(metrics)) return;
      const platform = media?.kind === "native_platform";
      nativePlatform.value = platform;
      if (
        platform &&
        (!validNativePlatformMetadata(media?.platform) ||
          (media?.platform?.version !== 1 && media?.id !== s.media_id) ||
          continuation)
      )
        throw Error("此平台媒体暂不支持播放");
      const liveMetadata =
        platform && (media?.platform?.version === 3 || media?.platform?.version === 5) ? media.platform : undefined;
      if (
        !!liveMetadata !== !!s.live ||
        (liveMetadata &&
          (!validNativeLiveBinding(s.live) ||
            s.live!.version !== (liveMetadata.version === 3 ? 1 : 2) ||
            liveMetadata.resource.broadcast_id !== s.live!.broadcast_id))
      )
        throw new RequestFailure({
          error: { code: "NATIVE_LIVE_STATE_CHANGED" },
        });
      nativeProvider.value = platform ? media!.platform!.provider : undefined;
      metrics.nativeProvider = nativeProvider.value;
      if (qualityContext !== qualityScope()) {
        clearNativeQuality(true);
        qualityContext = qualityScope();
        metrics.nativeQualityMaxHeight = "auto";
      }
      if (usesPlatformAccount(metrics.nativeProvider))
        metrics.accountChange = accountRevision(metrics.nativeProvider);
      const nativeCapabilities = platform
        ? detectCapabilities(element, Hls.getMediaSource())
        : undefined;
      metrics.nativeCourse = platform && media?.platform?.version === 4;
      if (platform) {
        // Finite-mode preference is hidden for Live and cannot leak a transform
        // intent into its separate edge/control contract.
        const choice = nativePlatformPlaybackChoice(
          liveMetadata ? "native" : metrics.nativePlaybackMode,
          metrics.nativeProvider!,
          nativeCapabilities!,
          !!liveMetadata,
        );
        if (
          choice === "unsupported" &&
          (metrics.nativePlaybackMode === "compatibility" || metrics.nativePlaybackMode === "adaptive")
        )
          throw new RequestFailure({
            error: { code: "NATIVE_PLATFORM_DEVICE_UNSUPPORTED" },
          });
        metrics.nativeCompatibility = choice === "compatibility";
      }
      const discovered: CandidateDiscovery = platform
        ? {
            capabilities: {
              progressive_h264_aac:
                metrics.nativeProvider !== "bilibili" &&
                nativeCapabilities!.progressive_h264_aac,
              native_hls:
                (!!liveMetadata || !!metrics.nativeCompatibility) &&
                nativeCapabilities!.native_hls,
              mse_h264_aac:
                (liveMetadata || metrics.nativeCompatibility ||
                  metrics.nativeProvider === "bilibili" ||
                  metrics.nativeProvider === "youtube") &&
                nativeCapabilities!.mse_h264_aac,
            },
          }
        : metrics.distributed
          ? { capabilities: detectCapabilities(element, Hls.getMediaSource()) }
          : metrics.mode === "finite_hls"
          ? { capabilities: detectCapabilities(element, Hls.getMediaSource()) }
          : continuation
          ? { capabilities: continuation.capabilities }
          : await discoverCandidates(metrics, element);
      validateFiniteHlsChoice(metrics.mode, { advanced: metrics.advanced, ladder: metrics.ladder, distributed: metrics.distributed, continuation });
      const finiteParameters = !platform && metrics.mode === "finite_hls"
        ? finiteHlsRequestParameters(metrics.mode, media?.kind, discovered.capabilities)
        : undefined;
      const staticRoot =
        !platform &&
        !metrics.distributed &&
        !metrics.advanced &&
        !metrics.ladder &&
        !continuation &&
        ctx.staticHlsFallback === true &&
        metrics.staticHlsFallback &&
        staticHlsOfferCurrent(
          discovered.staticHls?.availability,
          discovered.staticHls?.observedAt,
          performance.now(),
        ) &&
        (discovered.capabilities.native_hls ||
          discovered.capabilities.mse_h264_aac) &&
        !discovered.concrete &&
        !discovered.upstream &&
        ["auto", "direct"].includes(metrics.mode);
      const staticReplay = continuation?.staticChild;
      if (
        staticReplay &&
        !staticReplay.state.retry({
          room_id: metrics.room,
          media_id: metrics.mediaId,
          media_generation: metrics.media,
          viewer_id: intent.viewer_id,
          plan_generation: intent.plan_generation,
        })
      )
        throw new PlaybackCancelled();
      const candidateReport = discovered.report
        ? {
            ...structuredClone(discovered.report),
            excluded_candidates: [
              ...(discovered.concrete
                ? metrics.failedCandidates
                : failedCandidates),
            ],
          }
        : undefined;
      const capabilities = staticRoot
        ? {
            progressive_h264_aac: discovered.capabilities.progressive_h264_aac,
            native_hls: discovered.capabilities.native_hls,
            mse_h264_aac: discovered.capabilities.mse_h264_aac,
          }
        : structuredClone(discovered.capabilities);
      // Capability probing is optional asynchronous work. Never start a session
      // for an old identity, element or media after a newer load/reset wins.
      if (
        serial !== loadSerial ||
        !candidateIntentCurrent(metrics) ||
        session.epoch !== identity ||
        !roomIsActive() ||
        video.value !== element ||
        state.value?.room_id !== s.room_id ||
        state.value?.media_generation !== s.media_generation
      )
        return;
      if (!clockUsable() || revision !== clockRevision()) {
        waiting.value = false;
        clockAction = "load";
        return;
      }
      checkCandidateLifetime(discovered);
      const request: PlaybackRequest = platform
        ? nativePlatformRequest({
            ...intent,
            idempotency_key: requests().allocateIdempotencyKey(),
            room_id: s.room_id,
            media_generation: s.media_generation,
            position_ms: target(state.value ?? s, clock.now()),
            credential_mode: metrics.nativeCredentialMode,
            provider: metrics.nativeProvider,
            media_id: s.media_id!,
            max_height: metrics.nativeQualityMaxHeight,
            account_id:
              metrics.nativeProvider === "douyin" ||
              metrics.nativeProvider === "tiktok"
                ? ctx.shortPlatformAccountIds?.value[metrics.nativeProvider]
                : metrics.nativeProvider === "youtube"
                  ? ctx.youtubePlatformAccountId?.value
                  : undefined,
            mse_h264_aac: capabilities.mse_h264_aac,
            progressive_h264_aac: capabilities.progressive_h264_aac,
            native_hls: capabilities.native_hls,
            live: !!liveMetadata,
            compatibility: metrics.nativeCompatibility,
            compatibility_ladder: metrics.nativeCompatibility && metrics.nativePlaybackMode === "adaptive",
            course: metrics.nativeCourse,
          })
        : staticReplay
          ? staticReplay.intent.request
          : {
              ...intent,
              idempotency_key: requests().allocateIdempotencyKey(),
              room_id: s.room_id,
              media_generation: s.media_generation,
              mode:
                metrics.distributed ? "auto" : continuation || metrics.advanced || metrics.ladder
                  ? "transcode"
                  : (finiteParameters?.mode ?? metrics.mode),
              ...(finiteParameters?.finite_hls_version === 1 ? { finite_hls_version: 1 } : {}),
              audio_index: continuation
                ? (continuation.parent.selected_audio_track ?? null)
                : (metrics.audio ?? null),
              position_ms: target(state.value ?? s, clock.now()),
              capabilities,
              ...(metrics.distributed ? { distributed_compute: metrics.distributed } : {}),
              ...(metrics.ladder ? { local_hls_ladder: metrics.ladder } : {}),
              ...(metrics.advanced
                ? { advanced_playback: metrics.advanced }
                : {}),
              ...(!staticRoot && candidateReport
                ? { candidate_report: candidateReport }
                : {}),
              ...(discovered.upstream
                ? {
                    upstream_profile_report: structuredClone(
                      discovered.upstream.report,
                    ),
                  }
                : {}),
              observation_version: 1,
              ...(metrics.distributed || finiteParameters || metrics.advanced || metrics.ladder
                ? {}
                : staticRoot
                  ? { static_hls_fallback_version: 1 }
                  : { http_file_fallback_version: 1 }),
              playback_metrics_version: 1,
              playback_metrics_supported_versions: freezeCandidateSnapshot([
                1, 2,
              ]),
              playback_metrics: freezeCandidateSnapshot({
                meter_start_generation: metrics.startGeneration,
                startup_origin: metrics.origin,
              }),
            };
      waiting.value = true;
      const requestedSeek = seekSerial;
      const currentPosition = () => {
        if (!clockUsable() || revision !== clockRevision()) {
          // Keep the already claimed file/version and request key through a
          // clock recalibration. Reconciliation waits for fresh clock correction;
          // readiness can safely inspect the originally requested position.
          if (continuation || discovered.concrete || discovered.upstream)
            return request.position_ms;
          clockAction = "load";
          throw new PlaybackCancelled();
        }
        return target(state.value ?? s, clock.now());
      };
      // Once claimed, a concrete request keeps its key/generation through clock
      // recovery. A new key at that generation would violate high-water.
      pending.preparing = !!(
        platform ||
        metrics.distributed ||
        !!finiteParameters ||
        staticReplay ||
        discovered.concrete ||
        discovered.upstream
      );
      let p: PlaybackPlan;
      if (continuation?.staticChild) {
        if (plan !== continuation.parent) throw new PlaybackCancelled();
        const detached = detachPlayback(undefined, continuation.staticChild);
        const preparing = requests().prepareStaticHlsChild(
          continuation.staticChild.intent,
          detached.deletePrevious,
          currentPosition,
        );
        recoveryPending = true;
        updateRecovery();
        p = await preparing;
        continuation.staticChild.state.close();
      } else if (continuation) {
        // No await between detaching the old element and handing its cleanup
        // ownership to the request manager. Stop can then cancel the child key
        // immediately while the parent final DELETE is still pending.
        if (plan !== continuation.parent) throw new PlaybackCancelled();
        const detached = detachPlayback();
        request.http_file_fallback = {
          parent_session_id: continuation.parent.session_id,
          ...(detached.finalObservation
            ? { final_observation: detached.finalObservation }
            : {}),
        };
        const preparing = requests().prepareContinuation(
          request,
          detached.deletePrevious,
          currentPosition,
        );
        recoveryPending = true;
        updateRecovery();
        p = await preparing;
      } else p = await requests().prepare(request, currentPosition);
      if (
        serial !== loadSerial ||
        !candidateIntentCurrent(metrics) ||
        !roomIsActive() ||
        session.epoch !== identity ||
        video.value !== element ||
        state.value?.room_id !== s.room_id ||
        state.value?.media_generation !== s.media_generation ||
        !planGenerations.current(p)
      ) {
        await session.api(`/playback-sessions/${p.session_id}`, "DELETE");
        return;
      }
      if (platform && p.media_id !== metrics.mediaId) {
        await requests().stop();
        throw Error("平台媒体响应身份不一致，请重新加载");
      }
      const grantedAt = performance.now();
      // The helper validates the fixed recipe before readiness. Retain the
      // original audio selection and source rate; both rates can be supported
      // without allowing a different source-bound contract into this intent.
      if (
        discovered.upstream &&
        ((p.upstream_profile?.requested_audio === null) !==
          (discovered.upstream.candidates.profile!.requested_audio === null) ||
          p.upstream_profile?.audio_rate_contract?.source_sample_rate !==
            discovered.upstream.candidates.profile!.audio_rate_contract
              ?.source_sample_rate)
      ) {
        await requests().stop();
        throw new Error(candidateError);
      }
      if (discovered.upstream && !Hls.isSupported()) {
        await requests().stop();
        throw new Error(candidateError);
      }
      plan = p;
      distributedFacts.value = p.distributed_compute;
      advancedFacts.value = p.advanced_playback;
      ladderFacts.value = p.local_hls_ladder;
      ladderSelected.value = undefined;
      ladderManual.value = false;
      ladderLevelMap = undefined;
      if (p.native_platform) {
        platformText.bind(p);
      }
      nativeQualityOptions.value = p.native_platform?.quality?.options ?? [];
      nativeQualitySelectedHeight.value =
        p.native_platform?.quality?.selected_height;
      nativeEncodedHeight.value =
        hasHlsLadder(p) ? undefined : p.native_platform?.compatibility?.output?.height;
      nativeLadderRenditions.value = p.native_platform?.compatibility?.output?.renditions;
      preparation.value = applyPreparationSnapshot(preparation.value, {
        phase: "ready",
        generation: intent.plan_generation,
        sessionId: p.session_id,
        deliveryMode: p.delivery_mode,
      });
      playbackSummary.value = p.native_platform
        ? {
            mode: p.native_platform.live
              ? "Bilibili 直播"
              : `${platformProviderLabels[p.native_platform.provider]} ${p.native_platform.compatibility ? "兼容转码" : "原生播放"}`,
            reason: p.native_platform.live
              ? "直播边缘与播放/暂停控制同步；不保证逐帧对齐"
              : p.native_platform.credential_mode === "own_account"
                ? "使用自己的平台账号"
                : p.decision_reason === "native_platform_mp4_codec_unverified"
                  ? "匿名播放；视频编码未经确认，兼容性由浏览器尝试"
                  : "匿名播放",
          }
        : p.distributed_compute
          ? {mode: "NAS 计算产物", reason: `已测量输出 H.264 ${p.distributed_compute.width}×${p.distributed_compute.height}；跟随原片房间时间，分片默认 HTTP`}
          : summarizePlaybackPlan(p);
      pendingLoad = undefined;
      // A new plan request has consumed the latest explicit target. Its own
      // metadata reconcile must not replay a pre-load seek as another rebuild.
      if (requestedSeek === seekSerial) {
        pendingUserSeek = false;
        pendingForce = false;
      }
      sessionId.value = p.session_id;
      tracks.value = p.audio_tracks;
      subtitles.value = p.subtitle_tracks;
      if (!p.subtitle_tracks.some((t) => t.index === subtitleIndex.value))
        subtitleIndex.value = undefined;
      await nextTick();
      if (serial !== loadSerial || !currentPlan(p)) return;
      bestEffort(() => bindMetricGrant(p));
      applySubtitles();
      const el = video.value;
      bindLiveWindowProgress(p, el);
      const childState =
        p.static_hls_fallback_version === 1 && !continuation
          ? createStaticHlsChildIntentState({ plan: p, request })
          : undefined;
      staticChildState = childState;
      const attachmentBinding = (attachment: object): StaticHlsPlanBinding =>
        Object.freeze({
          plan: p,
          attachment,
          room_id: request.room_id,
          media_id: p.media_id,
          media_generation: request.media_generation,
          viewer_id: request.viewer_id ?? "",
          plan_generation: request.plan_generation ?? 0,
        });
      const bindAttachment = (attachment: object) => {
        const binding = attachmentBinding(attachment);
        staticBinding = binding;
        return binding;
      };
      if (p.observation_version === 1) {
        const user = session.user!.id;
        const epoch = session.epoch;
        observations = bestEffort(() =>
          bindPlaybackObservations({
            element: el,
            plan: p,
            current: () =>
              currentPlan(p) &&
              roomIsActive() &&
              serial === loadSerial &&
              video.value === el &&
              session.user?.id === user &&
              session.epoch === epoch &&
              state.value?.room_id === s.room_id &&
              state.value?.media_generation === p.media_generation,
            finalCurrent: () =>
              plan === p &&
              video.value === el &&
              session.user?.id === user &&
              session.epoch === epoch,
            send: async (body, signal) => {
              if (session.epoch !== epoch) throw new StaleIdentity();
              await session.api(
                `/playback-sessions/${p.session_id}/observations`,
                "POST",
                body,
                signal,
              );
            },
            storage: sessionStorage,
            storageKey: `rainsync:observation:${user}:${p.session_id}`,
          }),
        );
      }
      endAttempt = -Infinity;
      el.onended = () => {
        if (serial !== loadSerial || !currentPlan(p) || !metricCurrent(metrics))
          return;
        void completed();
      };
      waiting.value = true;
      let recoveries = 0;
      firstFrameDeadline = createFirstFrameDeadline({
        element: el,
        current: () =>
          serial === loadSerial && currentPlan(p) && metricCurrent(metrics),
        suspended: () =>
          !!generationWait ||
          generationWaitFailed ||
          blocked.value ||
          !foreground() ||
          state.value?.playback_status !== "playing",
        eligible: () =>
          !generationWait &&
          !generationWaitFailed &&
          !blocked.value &&
          foreground(),
        timeout: () => {
          recoveringHls = false;
          waiting.value = false;
          failLocalPlayback(firstFrameTimeoutError, "FIRST_FRAME_TIMEOUT");
          if (!error.value) error.value = firstFrameTimeoutError;
        },
      });
      // This bounds usable media data for the attached plan, not a
      // presented first frame. Server queue/generated waits keep their own
      // deadlines. Known gesture/background suspension excludes time when
      // the browser may prevent loading; an unresolved play() still counts.
      let dataTimer: ReturnType<typeof setTimeout> | undefined;
      let dataSource: object | undefined;
      let dataReady = false;
      let dataTimedOut = false;
      let dataStopped = false;
      let dataRemainingMs = 20000;
      let dataStartedAt = 0;
      const dataMediaId = s.media_id;
      const dataCurrent = (source: object) =>
        dataSource === source &&
        serial === loadSerial &&
        currentPlan(p) &&
        roomIsActive() &&
        session.user?.id === metrics.user &&
        session.epoch === metrics.epoch &&
        state.value?.room_id === metrics.room &&
        state.value?.media_generation === metrics.media &&
        state.value?.media_id === dataMediaId &&
        video.value === el;
      const clearDataTimer = () => {
        if (dataTimer !== undefined) {
          const elapsed = performance.now() - dataStartedAt;
          // A broken local clock cannot extend or disable a media deadline.
          dataRemainingMs =
            Number.isFinite(elapsed) && elapsed >= 0
              ? Math.max(0, dataRemainingMs - elapsed)
              : 0;
        }
        clearTimeout(dataTimer);
        dataTimer = undefined;
      };
      const syncDataLoad = () => {
        const source = dataSource;
        if (!source) return;
        if (!dataCurrent(source)) {
          dataStopped = true;
          dataSource = undefined;
          clearDataTimer();
          return;
        }
        if (el.readyState >= 2) {
          dataReady = true;
          clearDataTimer();
          if (preparation.value.failure?.code === "MEDIA_DATA_TIMEOUT")
            preparation.value = {
              ...preparation.value,
              phase: "ready",
              failure: undefined,
            };
          if (error.value === mediaDataTimeoutError) error.value = "";
          return;
        }
        if (
          generationWait ||
          generationWaitFailed ||
          blocked.value ||
          !foreground()
        ) {
          clearDataTimer();
          if (blocked.value && error.value === mediaDataTimeoutError) {
            dataTimedOut = false;
            error.value = "";
          }
          return;
        }
        if (dataReady || dataTimedOut || dataTimer !== undefined) return;
        dataStartedAt = performance.now();
        dataTimer = setTimeout(() => {
          dataRemainingMs = 0;
          dataTimer = undefined;
          if (!dataCurrent(source)) {
            syncDataLoad();
            return;
          }
          if (
            el.readyState >= 2 ||
            generationWait ||
            generationWaitFailed ||
            blocked.value ||
            !foreground()
          ) {
            syncDataLoad();
            return;
          }
          dataTimedOut = true;
          recoveringHls = false;
          waiting.value = false;
          failLocalPlayback(mediaDataTimeoutError, "MEDIA_DATA_TIMEOUT");
          if (!error.value) error.value = mediaDataTimeoutError;
        }, dataRemainingMs);
      };
      mediaDataLoad = {
        sourceChanged() {
          if (dataStopped) return;
          clearDataTimer();
          const source = (dataSource = {});
          // Native → MSE and native reloads retain the plan's original budget.
          // Once data was usable, later recovery is governed by its own path.
          el.onloadeddata = () => {
            if (!dataCurrent(source) || el.readyState < 2) return;
            syncDataLoad();
          };
          syncDataLoad();
        },
        sync: syncDataLoad,
        stop() {
          dataStopped = true;
          dataSource = undefined;
          clearDataTimer();
        },
      };
      let mse =
        p.transport === "hls" &&
        (!!p.distributed_compute || !!p.upstream_profile ||
          !el.canPlayType("application/vnd.apple.mpegurl")) &&
        Hls.isSupported();
      const playbackPosition = () => {
        if (!clockUsable()) {
          queueApply();
          return el.currentTime;
        }
        return Math.max(
          0,
          (target(state.value!, clock.now()) - p.timeline_origin_ms) / 1000,
        );
      };
      const staticCurrent = (binding: StaticHlsPlanBinding) =>
        childState &&
        staticChildState === childState &&
        staticBinding === binding &&
        serial === loadSerial &&
        currentPlan(p) &&
        roomIsActive() &&
        candidateIntentCurrent(metrics) &&
        video.value === el &&
        connected.value &&
        clockUsable() &&
        state.value?.room_id === binding.room_id &&
        state.value?.media_id === binding.media_id &&
        state.value?.media_generation === binding.media_generation;
      const retryStaticDecode = (
        binding: StaticHlsPlanBinding,
        event: StaticHlsFailureEvent,
      ) => {
        if (!staticCurrent(binding) || !classifyStaticHlsDecodeFailure(event))
          return false;
        const sample = bestEffort(() => observations?.captureFinal());
        let proposed: StaticHlsChildIntent | undefined;
        const manager = requests();
        const childIntent = planGenerations.nextWhen((intent) => {
          const proposal = childState!.propose({
            current: binding,
            failure: { binding, event },
            child: {
              ...intent,
              idempotency_key: manager.allocateIdempotencyKey(),
            },
            position_ms: target(state.value!, clock.now()),
            final_observation: sample ? { binding, sample } : null,
          });
          if (proposal.kind !== "proposed") return false;
          proposed = proposal.intent;
          return true;
        });
        if (!childIntent || !proposed) return false;
        advanceMetricAttempt(metrics);
        const next: PlaybackContinuation = {
          parent: p,
          capabilities: proposed.request.capabilities,
          staticChild: {
            state: childState!,
            intent: proposed,
            finalObservation: sample,
          },
        };
        void run(() => loadAttempt([], childIntent, metrics, next));
        return true;
      };
      const retryDecode = () => {
        const candidate = p.selected_candidate_id;
        if (
          serial !== loadSerial ||
          !currentPlan(p) ||
          !roomIsActive() ||
          !candidateIntentCurrent(metrics) ||
          !!p.upstream_profile ||
          hasHlsLadder(p) ||
          !!p.native_platform ||
          mode.value !== "auto"
        )
          return false;
        if (
          !discovered.concrete &&
          p.http_file_fallback_version === 1 &&
          p.delivery_mode === "direct" &&
          p.transport === "progressive" &&
          p.decoder_fallback_modes?.includes("transcode") &&
          (audioIndex.value === undefined ||
            audioIndex.value === p.selected_audio_track)
        ) {
          void run(() => fallbackLoad([], { parent: p, capabilities }));
          return true;
        }
        if (
          !candidate ||
          !candidateReport ||
          !candidateReport.results.some(
            (result) => result.candidate_id === candidate,
          ) ||
          failedCandidates.includes(candidate) ||
          failedCandidates.length >= 2
        )
          return false;
        // Only real decoder failures may move to another route. Authorization,
        // network errors and ordinary timeouts never trigger extra transcoding.
        void run(() => fallbackLoad([...failedCandidates, candidate]));
        return true;
      };
      const recover = () => {
        if (
          serial !== loadSerial ||
          !roomIsActive() ||
          !currentPlan(p) ||
          !metricCurrent(metrics) ||
          !state.value ||
          recoveries >= 3 ||
          !clockUsable() ||
          !!p.native_platform?.compatibility
        )
          return false;
        recoveries++;
        generationWait?.abort();
        generationWait = undefined;
        generationWaitFailed = false;
        generatedEnd = undefined;
        recoveringHls = true;
        waiting.value = true;
        invalidatePlayActions();
        firstFrameDeadline?.detachSource();
        mediaDataLoad?.sourceChanged();
        const position = playbackPosition();
        if (mse && hls) {
          hls.stopLoad();
          // Refresh the attachment fence on an actual source reload. Existing
          // callbacks stay stale; attachHls installs the new source callback.
          bindMetricSource(p, el, true);
          if (childState || hasHlsLadder(p)) {
            ladderManual.value = false;
            ladderLevelMap = undefined;
            hls.destroy();
            attachHls();
            hls!.startLoad(position);
          } else {
            hls.config.startPosition = position;
            hls.loadSource(p.playback_url);
            hls.startLoad(position);
            attachMetricSource();
          }
        } else {
          // Native media errors do not expose the failing HTTP status. Retry the
          // unfenced entry with a bounded cache-busting URL and room-time fragment.
          const url = new URL(p.playback_url, location.href);
          bindMetricSource(p, el, true);
          url.searchParams.set("recovery", String(recoveries));
          url.hash = `t=${position}`;
          bindNativeError(bindAttachment({}));
          el.src = url.href;
          el.load();
          attachMetricSource();
        }
        firstFrameDeadline?.attachSource();
        return true;
      };
      const bindNativeError = (binding: StaticHlsPlanBinding) => {
        el.onerror = () => {
          // load() during teardown and queued events from a previous resource are
          // not failures of this plan. A real media error belongs to the active URL.
          if (
            serial !== loadSerial ||
            !roomIsActive() ||
            !currentPlan(p) ||
            video.value !== el ||
            staticBinding !== binding ||
            !metricCurrent(metrics) ||
            !el.getAttribute("src") ||
            !el.error ||
            el.error.code === 1
          )
            return;
          if (
            el.error.code === 3 &&
            retryStaticDecode(binding, {
              kind: "native",
              code: el.error.code,
            })
          )
            return;
          if (p.transport === "hls" && !mse) {
            if (
              (el.error.code === 3 || el.error.code === 4) &&
              Hls.isSupported()
            ) {
              // A native decoder/parser failure can be transport-specific. Try MSE
              // once, with this same authorized plan and the current room position.
              mse = true;
              generationWait?.abort();
              generationWait = undefined;
              generationWaitFailed = false;
              generatedEnd = undefined;
              recoveringHls = true;
              waiting.value = true;
              invalidatePlayActions();
              firstFrameDeadline?.detachSource();
              mediaDataLoad?.sourceChanged();
              el.pause();
              bestEffort(() => metricSource?.stop());
              el.removeAttribute("src");
              el.load();
              bindMetricSource(p, el, true);
              attachHls();
              firstFrameDeadline?.attachSource();
              return;
            }
            if (recover()) return;
          }
          // HTML code 4 mixes format, delivery and support failures. It cannot
          // justify a fresh grant, including the legacy one-hop HTTP continuation.
          if (el.error.code === 3 && retryDecode()) return;
          recoveringHls = false;
          error.value =
            el.error.code === 2
              ? "媒体加载中断，请检查连接后重新加载"
              : el.error.code === 4
                ? "媒体加载或格式支持状态未知，请检查连接后重新加载"
                : "无法播放此格式，可切换兼容转码后重载";
          if (p.native_platform?.compatibility) {
            failNativeCompatibility(p, error.value);
            return;
          }
          failLocalPlayback(error.value);
          waiting.value = false;
        };
      };
      if (p.upstream_profile && (!upstreamRecoveryGrant
        || upstreamRecoveryGrant.session !== p.session_id
        || upstreamRecoveryGrant.generation !== p.plan_generation)) {
        upstreamRecoveryGrant = {
          session: p.session_id, generation: p.plan_generation,
          recovery: new SameSidDecoderRecovery(p),
        };
      }
      const sameSidRecovery = p.upstream_profile ? upstreamRecoveryGrant?.recovery : undefined;
      if (p.distributed_compute && Hls.isSupported()) {
        const f = p.distributed_compute;
        const peer = new RoomP2PTransport(session.api, s.room_id, f.job_id, updatePeerStats, {session:p.session_id,outputGeneration:f.output_generation});
        primaryPeer = peer;
        await peer.prepare();
        if (serial !== loadSerial || !currentPlan(p) || !roomIsActive() || primaryPeer !== peer) {
          await peer.stop();
          return;
        }
        updatePeerStats();
      }
      const primaryBufferSeconds = () => {
        for (let i=0;i<el.buffered.length;i++)
          if (el.currentTime>=el.buffered.start(i) && el.currentTime<el.buffered.end(i)) return el.buffered.end(i)-el.currentTime;
        return 0;
      };
      const attachHls = () => {
        hls = new Hls({
          startPosition: p.native_platform?.live ? -1 : playbackPosition(),
          ...(p.distributed_compute && primaryPeer ? {fLoader:createP2PFragmentLoader(primaryPeer,primaryBufferSeconds)} : {}),
          ...(p.native_platform?.live ? {enableCEA708Captions:true,enableWebVTT:false,enableIMSC1:false,renderTextTracksNatively:false} : {}),
          ...(p.native_platform?.live
            ? {
                xhrSetup: (_xhr: XMLHttpRequest, url: string) => {
                  if (
                    !validNativeLiveDeliveryUrl(
                      url,
                      p.session_id,
                      location.origin,
                      false,
                      p.native_platform!.live!.version,
                    )
                  )
                    throw new Error("NATIVE_PLATFORM_DELIVERY_INVALID");
                },
              }
            : {}),
          ...(p.native_platform?.compatibility
            ? {
                xhrSetup: (_xhr: XMLHttpRequest, url: string) => {
                  if (
                    !validNativeCompatibilityDeliveryUrl(
                      url,
                      p,
                      location.origin,
                    )
                  )
                    throw new Error("NATIVE_PLATFORM_DELIVERY_INVALID");
                },
              }
            : {}),
          maxBufferLength: 20,
          maxMaxBufferLength: 60,
          backBufferLength: 30,
        });
        const attachedHls = hls;
        const binding = bindAttachment(attachedHls);
        if (p.native_platform?.live) {
          // Only decoder-observed CEA captions; no extra subtitle URI fetches.
          attachedHls.on(Hls.Events.CUES_PARSED, (_, data) => {
            if (data.type !== "captions" || serial !== loadSerial || !currentPlan(p) || !roomIsActive() || hls !== attachedHls || video.value !== el) return;
            platformText.ingestLiveInbandCaptions(data.track, data.cues);
          });
        }

        if (hasHlsLadder(p)) {
          const current = () =>
            serial === loadSerial &&
            currentPlan(p) &&
            metricCurrent(metrics) &&
            candidateIntentCurrent(metrics) &&
            roomIsActive() &&
            hls === attachedHls &&
            video.value === el;
          attachedHls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (!current()) return;
            const mapping = bindLocalHlsLevels(
              p,
              attachedHls.levels,
              location.origin,
            );
            if (!mapping) {
              attachedHls.destroy();
              if (hls === attachedHls) hls = undefined;
              ladderManual.value = false;
              ladderLevelMap = undefined;
              waiting.value = false;
              error.value =
                "服务器 HLS 清晰度列表与已授权方案不一致，请重新加载";
              failLocalPlayback(error.value);
              return;
            }
            ladderLevelMap = mapping;
            ladderManual.value = true;
            if (
              ladderQuality.value !== "auto" &&
              !mapping.has(ladderQuality.value)
            )
              ladderQuality.value = "auto";
            attachedHls.loadLevel =
              ladderQuality.value === "auto"
                ? -1
                : mapping.get(ladderQuality.value)!;
          });
          attachedHls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
            if (!current() || !ladderLevelMap) return;
            ladderSelected.value = [...ladderLevelMap].find(
              ([, index]) => index === data.level,
            )?.[0];
          });
        }
        hls.loadSource(p.playback_url);
        hls.attachMedia(el);
        attachMetricSource();
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (
            serial === loadSerial &&
            currentPlan(p) &&
            metricCurrent(metrics) &&
            roomIsActive() &&
            hls === attachedHls &&
            staticBinding === binding &&
            (data.fatal ||
              (!!p.native_platform &&
                [401, 403, 409, 410].includes(data.response?.code ?? 0)))
          ) {
            if (p.native_platform?.live) {
              let code = "NATIVE_PLATFORM_DELIVERY_INVALID";
              const body = bestEffort(() =>
                data.networkDetails && "responseText" in data.networkDetails
                  ? data.networkDetails.responseText
                  : undefined,
              );
              if (typeof body === "string" && body.length <= 16384) {
                try {
                  const reported = JSON.parse(body)?.error?.code;
                  if (
                    [
                      "NATIVE_LIVE_WINDOW_EXPIRED",
                      "NATIVE_LIVE_BROADCAST_CHANGED",
                      "NATIVE_LIVE_NOT_BROADCASTING",
                      "NATIVE_LIVE_PLAYLIST_CHANGED",
                      "NATIVE_LIVE_STATE_CHANGED",
                      "NATIVE_LIVE_RATE_LIMITED",
                      "NATIVE_LIVE_CAPACITY",
                      "NATIVE_PLATFORM_URL_EXPIRED",
                      "ROOM_NOT_ACTIVE",
                      "STALE_MEDIA",
                    ].includes(reported)
                  )
                    code = reported;
                } catch {
                  /* Upstream/raw responses never enter the UI. */
                }
              }
              if (
                code === "NATIVE_LIVE_WINDOW_EXPIRED" &&
                recoverExpiredLiveWindow(p)
              )
                return;
              failNativeLive(p, code);
              return;
            }
            if (p.native_platform?.compatibility) {
              failNativeCompatibility(
                p,
                "平台兼容转码播放失败，请保持此方式并重新加载；平台授权和片源有效期仍适用",
              );
              return;
            }
            if (
              isUnsupportedTimelineResponse(
                data.response?.code,
                bestEffort(() =>
                  data.networkDetails && "responseText" in data.networkDetails
                    ? data.networkDetails.responseText
                    : undefined,
                ),
              )
            ) {
              firstFrameDeadline?.stop();
              recoveringHls = false;
              waiting.value = false;
              error.value = new RequestFailure({
                error: { code: "UNSUPPORTED_TIMELINE" },
              }).message;
              preparation.value = {
                ...preparation.value,
                phase: "failed",
                failure: preparationFailure(
                  new RequestFailure({
                    error: { code: "UNSUPPORTED_TIMELINE" },
                  }),
                ),
              };
              return;
            }
            if (
              retryStaticDecode(binding, {
                kind: "hls",
                fatal: data.fatal,
                type: data.type,
                details: data.details,
                response: data.response,
                media_error_code: el.error?.code,
                error_name: data.error?.name,
              })
            )
              return;
            if (data.response?.code === 409 && recover()) return;
            if (sameSidRecovery?.recover({
              plan: p,
              current: serial === loadSerial && currentPlan(p) && roomIsActive()
                && metricCurrent(metrics) && candidateIntentCurrent(metrics)
                && video.value === el && hls === attachedHls,
              fatal: data.fatal,
              type: data.type,
              recoverMediaError: () => attachedHls.recoverMediaError(),
            })) {
              recoveringHls = true;
              waiting.value = true;
              return;
            }
            if (sameSidRecovery?.recoverNetwork({
              plan: p,
              current: serial === loadSerial && currentPlan(p) && roomIsActive()
                && metricCurrent(metrics) && candidateIntentCurrent(metrics)
                && video.value === el && hls === attachedHls,
              fatal: data.fatal,
              type: data.type,
              details: data.details,
              status: data.response?.code,
              startLoad: () => attachedHls.startLoad(-1),
            })) {
              recoveringHls = true;
              waiting.value = true;
              return;
            }
            if (data.type === "mediaError" && retryDecode()) return;
            recoveringHls = false;
            error.value = "媒体加载失败：" + data.details;
            failLocalPlayback(
              "媒体加载失败，请检查连接或重新发起播放。",
              undefined,
              error.value,
            );
            waiting.value = false;
          }
        });
      };
      bindMetricSource(p, el);
      if (p.upstream_profile) {
        upstreamObserver?.stop();
        upstreamObserver = observeUpstreamOutput({
          plan: p, origin: location.origin,
          current: () => serial === loadSerial && currentPlan(p) && roomIsActive()
            && metricCurrent(metrics) && candidateIntentCurrent(metrics) && video.value === el,
          facts: (facts) => {
            upstreamMeasuredOutput.value = facts;
            upstreamMeasuredMatchesRequested.value = upstreamOutputMatchesMeasuredBounds(facts, p);
          },
        });
      }
      // Metadata drives room reconciliation; SDK readiness does not prove a frame.
      el.onloadedmetadata = () => {
        if (serial !== loadSerial || !currentPlan(p) || !metricCurrent(metrics))
          return;
        applySubtitles();
        duration.value = p.native_platform?.live
          ? 0
          : p.duration_ms
            ? p.duration_ms / 1000
            : el.duration;
        void runAutomaticApply(true);
      };
      if (p.native_platform) {
        const binding = p.native_platform;
        const current = () =>
          serial === loadSerial &&
          currentPlan(p) &&
          metricCurrent(metrics) &&
          roomIsActive() &&
          video.value === el;
        if (binding.compatibility) {
          // Only the readiness-refreshed, actual-attempt-pinned grant reaches
          // here. Generic recovery cannot change its query or choose native.
          if (
            !binding.compatibility.output ||
            p.transport !== "hls" ||
            !validNativeCompatibilityDeliveryUrl(
              p.playback_url,
              p,
              location.origin,
              true,
            )
          )
            throw new RequestFailure({
              error: { code: "NATIVE_PLATFORM_DELIVERY_INVALID" },
            });
          if (mse) attachHls();
          else {
            bindNativeError(bindAttachment({}));
            el.src = p.playback_url;
            attachMetricSource();
          }
          mediaDataLoad.sourceChanged();
          firstFrameDeadline.attachSource();
        } else if (binding.live) {
          if (mse) attachHls();
          else {
            el.onerror = () => {
              if (!current() || !el.error || el.error.code === 1) return;
              if (el.error.code === 2) {
                void probeExpiredNativeLiveWindow(p);
                return;
              }
              failNativeLive(p, "NATIVE_PLATFORM_DELIVERY_INVALID");
            };
            el.src = p.playback_url;
            attachMetricSource();
          }
          mediaDataLoad.sourceChanged();
          firstFrameDeadline.attachSource();
        } else if (p.transport === "dash") {
          const attached = createDashPlayback({
            video: el,
            sessionId: p.session_id,
            playbackUrl: p.playback_url,
            current,
            onError: (failure) => {
              if (!current()) return;
              waiting.value = false;
              error.value = failure.message;
              failLocalPlayback(failure.message, failure.code);
            },
          });
          dash = attached;
          mediaDataLoad.sourceChanged();
          firstFrameDeadline.attachSource();
          attachMetricSource();
          if (!(await attached.load()) || !current()) return;
        } else {
          // A native MP4 is a dedicated platform grant, not the generic
          // progressive route. Never offer decoder/worker fallback or mutate
          // its token-bearing URL with generic recovery parameters.
          el.onerror = () => {
            if (
              !current() ||
              !el.getAttribute("src") ||
              !el.error ||
              el.error.code === 1
            )
              return;
            waiting.value = false;
            error.value =
              el.error.code === 2
                ? "平台视频加载中断，请检查连接后重新加载"
                : el.error.code === 4
                  ? "平台视频加载或格式支持状态未知，请检查连接后重新加载"
                  : "浏览器无法播放此平台视频格式，请重新加载或选择其他视频";
            failLocalPlayback(error.value, "NATIVE_PLATFORM_MEDIA_FAILED");
          };
          el.src = p.playback_url;
          attachMetricSource();
          mediaDataLoad.sourceChanged();
          firstFrameDeadline.attachSource();
        }
        // A fresh dedicated plan re-resolves URLs using the current room clock.
        // Never renew the old signed stream with the generic session endpoint.
        nativeRefresh = setTimeout(
          () => {
            nativeRefresh = undefined;
            if (current() && failedCompatibilityPlan !== p)
              void run(() => beginLoad("automatic_load") ?? Promise.resolve());
          },
          Math.max(
            0,
            binding.refresh_after_seconds * 1000 -
              (performance.now() - grantedAt),
          ),
        );
      } else {
        if (mse) attachHls();
        else {
          bindNativeError(bindAttachment({}));
          el.src = p.playback_url;
          attachMetricSource();
        }
        mediaDataLoad.sourceChanged();
        firstFrameDeadline.attachSource();
      }
    } catch (e) {
      if (
        serial !== loadSerial ||
        !candidateIntentCurrent(metrics) ||
        e instanceof PlaybackCancelled
      )
        return;
      waiting.value = false;
      pendingLoad = undefined;
      if (
        !continuation &&
        !metrics.originRecoveryUsed &&
        e instanceof PlaybackViewerOriginRequired
      ) {
        // Explicitly pre-mutation, first-attempt rejection only. This starts a
        // new logical meter/intent; no metrics packet or old key is relabeled.
        planGenerations = new PlaybackPlanGenerations();
        return beginLoad(metrics.origin, true);
      }
      if (
        continuation &&
        e instanceof RequestFailure &&
        ["NOT_FOUND", "METHOD_NOT_ALLOWED"].includes(e.code)
      ) {
        preparation.value = {
          ...preparation.value,
          phase: "failed",
          failure: {
            message: "此服务器不支持安全续接，请重新加载播放。",
            retryable: false,
          },
        };
        throw new Error("此服务器不支持安全续接，请重新加载播放");
      }
      preparation.value = {
        ...preparation.value,
        phase: "failed",
        failure: preparationFailure(e),
      };
      throw e;
    }
  }
  function applySubtitles() {
    if (!video.value) return;
    for (const element of Array.from(video.value.querySelectorAll("track"))) {
      element.track.mode =
        subtitleIndex.value !== undefined &&
        Number(element.dataset.index) === subtitleIndex.value
          ? "showing"
          : "disabled";
    }
  }
  async function waitForGenerated(p: PlaybackPlan) {
    if (generationWait || generationWaitFailed) return;
    if (!clockUsable()) {
      queueApply();
      return;
    }
    const revision = clockRevision();
    const controller = new AbortController();
    generationWait = controller;
    invalidatePlayActions();
    mediaDataLoad?.sync();
    firstFrameDeadline?.sync();
    observeMetrics();
    waiting.value = true;
    video.value?.pause();
    try {
      const ready = await waitPlaybackReady(
        (id, signal) => {
          if (!clockUsable() || revision !== clockRevision()) {
            queueApply();
            throw new PlaybackCancelled();
          }
          return readReadiness(
            id,
            signal,
            Math.max(
              0,
              target(state.value!, clock.now()) - p.timeline_origin_ms,
            ),
            p.plan_generation,
            () =>
              Math.max(
                0,
                target(state.value!, clock.now()) - p.timeline_origin_ms,
              ),
          );
        },
        p.session_id,
        controller.signal,
        p.plan_generation,
      );
      if (controller.signal.aborted || !currentPlan(p) || !roomIsActive())
        throw new PlaybackCancelled();
      if (!clockUsable() || revision !== clockRevision()) {
        queueApply();
        return;
      }
      if (ready.complete && ready.available_until_ms != null)
        generatedEnd = ready.available_until_ms / 1000;
      const position = Math.min(
        generatedEnd ?? Infinity,
        Math.max(
          0,
          (target(state.value!, clock.now()) - p.timeline_origin_ms) / 1000,
        ),
      );
      recoveringHls = true;
      if (hls) {
        // Retain the growing EVENT attempt and wait for an actual local interval.
        hls.startLoad(position);
      } else if (video.value) {
        bindMetricSource(p, video.value, true);
        const url = new URL(p.playback_url, location.href);
        url.hash = `t=${position}`;
        invalidatePlayActions();
        firstFrameDeadline?.detachSource();
        mediaDataLoad?.sourceChanged();
        video.value.src = url.href;
        video.value.load();
        attachMetricSource();
        firstFrameDeadline?.attachSource();
      }
    } catch (e) {
      if (controller.signal.aborted || !currentPlan(p) || !roomIsActive())
        throw new PlaybackCancelled();
      if (revision !== clockRevision() || !clockUsable()) {
        queueApply();
        return;
      }
      generationWaitFailed = true;
      waiting.value = false;
      preparation.value = {
        ...preparation.value,
        phase: "failed",
        failure: preparationFailure(e),
      };
      throw e;
    } finally {
      if (generationWait === controller) generationWait = undefined;
      mediaDataLoad?.sync();
      firstFrameDeadline?.sync();
      observeMetrics();
    }
  }
  function actionCurrent(
    p: PlaybackPlan,
    el: HTMLVideoElement,
    revision: number,
    serial: number,
  ) {
    return (
      clockUsable() &&
      revision === clockRevision() &&
      serial === applySerial &&
      currentPlan(p) &&
      roomIsActive() &&
      video.value === el
    );
  }
  function afterPlay(
    p: PlaybackPlan,
    el: HTMLVideoElement,
    revision: number,
    serial: number,
  ) {
    // A play promise may settle after a newer PAUSE. Enforce the latest state,
    // but never pause a replacement grant or pause merely for clock recovery.
    if (
      currentPlan(p) &&
      video.value === el &&
      state.value?.playback_status !== "playing"
    )
      el.pause();
    return (
      actionCurrent(p, el, revision, serial) &&
      state.value?.playback_status === "playing"
    );
  }
  async function applyState(force = false, userSeek = false) {
    try {
      await reconcileState(force, userSeek);
    } finally {
      updateRecovery();
    }
  }
  async function reconcileState(force = false, userSeek = false) {
    if (userSeek) ++seekSerial;
    pendingUserSeek ||= userSeek;
    const serial = ++applySerial;
    observeMetrics();
    if (!roomIsActive()) return;
    const s = state.value,
      el = video.value;
    if (!s || !el || !plan) return;
    const p = plan;
    if (failedCompatibilityPlan === p) return;
    if (!currentPlan(p)) {
      if (p.native_platform?.live)
        failNativeLive(p, "NATIVE_LIVE_STATE_CHANGED");
      return;
    }
    if (p.native_platform?.live) {
      const directive = nativeLiveDirective({
        room: s,
        plan: p,
        active: roomIsActive(),
        connected: connected.value,
        ended: el.ended || terminalEnd,
      });
      corrector.reset();
      if (directive === "stale") {
        failNativeLive(p, "NATIVE_LIVE_STATE_CHANGED");
        return;
      }
      if (directive === "offline") {
        if (!terminalEnd) failNativeLive(p);
        return;
      }
      if (!baseRate()) return;
      restoreBaseRate();
      if (directive === "pause") {
        el.pause();
        liveNeedsEdge = true;
        return;
      }
      if (directive === "wait" || !foreground() || el.readyState < 1) return;
      if (userSeek) return; // Room-wide seeks are never broadcast timeline claims.
      if (el.paused) liveNeedsEdge = true;
      if (force || liveNeedsEdge) {
        const edge = nativeLiveEdge(
          availablePlaybackRanges(el),
          hls?.liveSyncPosition ?? undefined,
        );
        if (edge !== undefined) {
          el.currentTime = edge;
          liveNeedsEdge = false;
        }
      }
      pendingForce = pendingUserSeek = false;
      if (el.paused && !blocked.value && !pendingPlay && !playFailed) {
        const playing = {};
        pendingPlay = playing;
        const revision = clockRevision();
        try {
          await el.play();
          if (!afterPlay(p, el, revision, serial)) return;
          blocked.value = false;
        } catch (failure) {
          if (!afterPlay(p, el, revision, serial)) return;
          if (playFailureIs(failure, "NotAllowedError")) blocked.value = true;
          else {
            playFailed = true;
            reportPlayInterruption();
          }
        } finally {
          if (pendingPlay === playing) pendingPlay = undefined;
        }
      }
      return;
    }
    if (s.playback_status !== "playing") {
      el.pause();
      restoreBaseRate();
    }
    if (!clockUsable()) {
      restoreBaseRate();
      queueApply(force, userSeek);
      return;
    }
    if (el.readyState < 1) return;
    userSeek ||= pendingUserSeek;
    force ||= pendingForce;
    pendingUserSeek = false;
    pendingForce = false;
    if (el.ended && s.playback_status === "playing" && !userSeek) {
      void completed();
      return;
    }
    if (!baseRate()) return;
    const revision = clockRevision();
    if (userSeek) {
      generationWaitFailed = false;
      generatedEnd = undefined;
      recoveringHls = false;
      generationWait?.abort();
      generationWait = undefined;
      mediaDataLoad?.sync();
      firstFrameDeadline?.sync();
    }
    if (generationWait || generationWaitFailed) return;
    const relative = (target(s, clock.now()) - p.timeline_origin_ms) / 1000;
    const expected = Math.min(generatedEnd ?? Infinity, Math.max(0, relative));
    const ranges = availablePlaybackRanges(el);
    const seekable = containsPlaybackPosition(ranges, expected);
    const end = ranges.length
      ? Math.max(...ranges.map(([, end]) => end))
      : undefined;
    if (
      force &&
      p.rebuild_on_seek &&
      (relative < -0.5 || (userSeek && !seekable))
    ) {
      // A fresh authoritative target before this upstream timeline is a new
      // seek intent, not a decoder retry of the previous profile or SID.
      const profileTimelineSeek = relative < -0.5 && !!p.upstream_profile;
      if (userSeek || profileTimelineSeek) await beginLoad("automatic_load");
      else await fallbackLoad();
      return;
    }
    if (recoveringHls && !seekable) {
      if (end !== undefined && expected <= end) {
        recoveringHls = false;
        waiting.value = false;
        error.value = "目标进度尚不可定位，请稍后重试或重新加载";
      }
      return;
    }
    if (
      p.rebuild_on_seek &&
      !userSeek &&
      !recoveringHls &&
      generatedEnd === undefined &&
      !seekable &&
      (end === undefined || expected > end + 0.1)
    ) {
      await waitForGenerated(p);
      return;
    }
    // Neither a finite duration nor a later interval authorizes a seek into a
    // hole. Generated holes stay on the finite recovery/reload path.
    if (!seekable && Math.abs(el.currentTime - expected) > 0.15) {
      restoreBaseRate();
      error.value = "目标进度尚不可定位，请稍后重试或重新加载";
      // Initial playback may need play() to expose any local intervals. Keep
      // the metadata seek pending, and never assign an unavailable position.
      if (!ranges.length && force && !userSeek) pendingForce = true;
      if (userSeek || ranges.length) return;
    }
    if (recoveringHls) recoveringHls = false;
    if (seekable && error.value === "目标进度尚不可定位，请稍后重试或重新加载")
      error.value = "";
    if (force || s.playback_status !== "playing") {
      if (seekable && Math.abs(el.currentTime - expected) > 0.15)
        el.currentTime = expected;
    }
    if (s.playback_status === "playing") {
      if (el.paused && !blocked.value && !pendingPlay && !playFailed) {
        const playing = {};
        pendingPlay = playing;
        try {
          await el.play();
          if (!afterPlay(p, el, revision, serial)) return;
          blocked.value = false;
          if (error.value === playInterruptedError) error.value = "";
          observeMetrics();
        } catch (failure) {
          if (!afterPlay(p, el, revision, serial)) return;
          if (playFailureIs(failure, "NotAllowedError")) {
            blocked.value = true;
            observeMetrics();
          } else {
            // Stop periodic play retries without claiming a gesture denial or
            // suspending the independent media-data deadline.
            playFailed = true;
            if (playFailureIs(failure, "AbortError")) {
              reportPlayInterruption();
              return;
            }
            throw failure;
          }
        } finally {
          if (pendingPlay === playing) pendingPlay = undefined;
        }
      }
    }
  }
  async function enablePlayback() {
    if (!roomIsActive()) return;
    const p = plan,
      el = video.value;
    if (p && failedCompatibilityPlan === p) return;
    if (!clockUsable()) {
      queueApply();
      return;
    }
    if (p && el && currentPlan(p) && baseRate() && !pendingPlay) {
      if (p.native_platform?.live) {
        if (terminalEnd || el.ended) {
          if (!terminalEnd) failNativeLive(p);
          return;
        }
        if (state.value?.playback_status !== "playing") return;
        const edge = nativeLiveEdge(
          availablePlaybackRanges(el),
          hls?.liveSyncPosition ?? undefined,
        );
        liveNeedsEdge = edge === undefined;
        if (edge !== undefined) el.currentTime = edge;
      }
      const serial = ++applySerial,
        revision = clockRevision();
      const playing = {};
      pendingPlay = playing;
      playFailed = false;
      // An explicit gesture resumes loading even while play() waits for data.
      // Only a new permission denial may restore the gesture gate.
      blocked.value = false;
      observeMetrics();
      try {
        await el.play();
      } catch (failure) {
        if (!afterPlay(p, el, revision, serial)) return;
        if (playFailureIs(failure, "NotAllowedError")) {
          blocked.value = true;
          observeMetrics();
        } else {
          playFailed = true;
          if (playFailureIs(failure, "AbortError")) {
            reportPlayInterruption();
            return;
          }
        }
        throw failure;
      } finally {
        if (pendingPlay === playing) pendingPlay = undefined;
      }
      if (!afterPlay(p, el, revision, serial)) return;
      blocked.value = false;
      if (error.value === playInterruptedError) error.value = "";
      observeMetrics();
      await applyState(true);
    }
  }
  function tick() {
    try {
      tickPlayback();
    } finally {
      updateRecovery();
    }
  }
  function tickPlayback() {
    const usable = clockUsable();
    if (!roomIsActive()) return;
    const s = state.value,
      el = video.value;
    if (!s || !el || !plan) return;
    if (failedCompatibilityPlan === plan) return;
    if (plan.native_platform?.live) {
      position.value = duration.value = 0;
      corrector.reset();
      if (!liveRoomMatchesPlan(s, plan)) {
        failNativeLive(plan, "NATIVE_LIVE_STATE_CHANGED");
        return;
      }
      if (el.ended) {
        if (!terminalEnd) failNativeLive(plan);
        return;
      }
      if (
        !terminalEnd &&
        (s.playback_status !== "playing" || el.paused || liveNeedsEdge)
      )
        void runAutomaticApply();
      return;
    }
    if (!dragging.value)
      position.value = el.currentTime + plan.timeline_origin_ms / 1000;
    if (!usable || s.playback_status !== "playing") {
      corrector.reset();
      restoreBaseRate();
      return;
    }
    if (!baseRate()) return;
    if (el.ended) {
      void completed();
      return;
    }
    if (generationWait || generationWaitFailed) return;
    if (recoveringHls) {
      void runAutomaticApply(true);
      return;
    }
    const expected = Math.min(
      generatedEnd ?? Infinity,
      (target(s, clock.now()) - plan.timeline_origin_ms) / 1000,
    );
    const ranges = availablePlaybackRanges(el);
    if (!containsPlaybackPosition(ranges, expected)) {
      restoreBaseRate();
      corrector.reset();
      if (plan.rebuild_on_seek) void runAutomaticApply(true);
      return;
    }
    if (
      !blocked.value &&
      !pendingPlay &&
      !playFailed &&
      (el.paused || pendingForce || pendingUserSeek)
    ) {
      void runAutomaticApply(pendingForce, pendingUserSeek);
      return;
    }
    const drift = (expected - el.currentTime) * 1000;
    const pausedCorrection =
      waiting.value || el.seeking || blocked.value || el.readyState < 2;
    const adjustment = corrector.step(
      rates!.fineUnsupported && Math.abs(drift) <= 500 ? 0 : drift,
      s.playback_rate,
      performance.now(),
      pausedCorrection,
    );
    if (pausedCorrection || adjustment.seek) restoreBaseRate();
    else if (!rates!.fineUnsupported) rates!.applyCorrection(adjustment.rate);
    if (!rates!.baseSupported) {
      reportUnsupportedRate();
      corrector.reset();
      return;
    }
    if (adjustment.seek) el.currentTime = expected;
  }
  function onClockInvalidated() {
    ++applySerial;
    corrector.reset();
    restoreBaseRate();
    generationWait?.abort();
    generationWait = undefined;
    generationWaitFailed = false;
    mediaDataLoad?.sync();
    firstFrameDeadline?.sync();
    queueApply();
    if (pendingLoad && !pendingLoad.preparing) clockAction = "load";
    recoveryPending = !!plan || !!pendingLoad;
    updateRecovery();
  }
  function onClockReady() {
    if (!roomIsActive() || !clockUsable()) return;
    updateRecovery();
    if (clockAction) {
      const action = clockAction;
      clockAction = undefined;
      const pending = pendingLoad;
      if (action === "load" && pending)
        void run(() =>
          loadAttempt(
            pending.failed,
            pending.intent,
            pending.metrics,
            pending.continuation,
          ),
        );
      else void runAutomaticApply(pendingForce, pendingUserSeek);
    }
  }
  function mediaChanged() {
    distributedIntent.value = undefined;
    corrector.reset();
    audioIndex.value = undefined;
    subtitleIndex.value = undefined;
    clearAdvancedPlayback();
    clearLadderPlayback();
    void run(async () => {
      await beginLoad("automatic_load");
    });
  }
  async function reset() {
    distributedIntent.value = undefined;
    finishMetrics();
    ++loadSerial;
    preparation.value = { phase: "idle" };
    clockAction = undefined;
    pendingUserSeek = false;
    pendingForce = false;
    corrector.reset();
    rates?.reset();
    confirmedBaseRate = rejectedBaseRate = undefined;
    dragging.value = false;
    tracks.value = [];
    subtitles.value = [];
    waiting.value = false;
    blocked.value = false;
    nativePlatform.value = false;
    nativeProvider.value = undefined;
    clearNativeQuality(true);
    platformText.reset();
    clearAdvancedPlayback();
    clearLadderPlayback();
    clearStaticHlsAvailability();
    duration.value = 0;
    position.value = 0;
    await stopPlayback();
  }
  async function cancelPreparation() {
    if (
      !["preparing", "queued", "transcoding"].includes(preparation.value.phase)
    )
      return;
    const generation = preparation.value.generation;
    // reset invalidates load/clock/probe work before its first asynchronous wait.
    // Keep cancelling visible until existing request-key revocation completes.
    const cleanup = reset();
    const serial = loadSerial;
    preparation.value = { phase: "cancelling", generation };
    try {
      await cleanup;
      if (serial === loadSerial && preparation.value.phase === "cancelling")
        preparation.value = { phase: "cancelled", generation };
    } catch (failure) {
      if (serial === loadSerial && preparation.value.phase === "cancelling")
        preparation.value = {
          phase: "failed",
          generation,
          failure: {
            ...preparationFailure(failure),
            message: "取消尚未确认，恢复连接后重试撤销请求。",
          },
        };
      throw failure;
    }
  }
  function resetClockAction() {
    clockAction = undefined;
  }
  function attach(element: HTMLVideoElement) {
    if (video.value === element) return;
    if (video.value) throw new Error("播放器已绑定；需先显式停止");
    video.value = element;
    rates = new PlaybackRateSupport(element);
    confirmedBaseRate = rejectedBaseRate = undefined;
  }
  watch(
    liveWindowScope,
    () => {
      liveWindowProbe?.abort();
      liveWindowProbe = undefined;
      liveWindowProgressStop?.();
      liveWindowProgressStop = undefined;
    },
    { flush: "sync" },
  );
  watch(
    () => [
      roomIsActive(),
      state.value?.room_id,
      state.value?.media_id,
      state.value?.media_generation,
      state.value?.playback_status,
      session.user?.id,
      session.epoch,
      connected.value,
      waiting.value,
      blocked.value,
      error.value,
    ],
    () => {
      mediaDataLoad?.sync();
      firstFrameDeadline?.sync();
      updateRecovery();
    },
    { flush: "sync" },
  );
  if (ctx.platformAccountChange)
    watch(
      ctx.platformAccountChange,
      () => {
        if (!nativePlatform.value || nativeProvider.value !== "bilibili")
          return;
        // New credential revision invalidates SDK callbacks before any backend wait.
        clearNativeQuality(true);
        const loading = beginLoad("automatic_load");
        if (loading) void run(() => loading);
      },
      { flush: "sync" },
    );
  if (ctx.shortPlatformAccountChanges)
    watch(
      ctx.shortPlatformAccountChanges,
      (value, previous) => {
        const provider = nativeProvider.value;
        if (
          !nativePlatform.value ||
          (provider !== "douyin" && provider !== "tiktok") ||
          nativeCredentialMode.value === "anonymous" ||
          value[provider] === previous[provider]
        )
          return;
        // Retire the owned progressive grant before waiting for a replacement.
        const loading = beginLoad("automatic_load");
        if (loading) void run(() => loading);
      },
      { flush: "sync" },
    );
  if (ctx.youtubePlatformAccountChange)
    watch(
      ctx.youtubePlatformAccountChange,
      () => {
        if (
          !nativePlatform.value ||
          nativeProvider.value !== "youtube" ||
          nativeCredentialMode.value === "anonymous"
        )
          return;
        clearNativeQuality(true);
        const loading = beginLoad("automatic_load");
        if (loading) void run(() => loading);
      },
      { flush: "sync" },
    );
  const timer = setInterval(tick, 500);
  const observationTimer = setInterval(
    () => bestEffort(() => observations?.progress()),
    5000,
  );
  const metricsTimer = setInterval(sampleMetrics, 5000);
  // Only an explicit legacy receipt establishes this non-renewable boundary.
  // An ordinary 200 never means a fabricated extra 30 minutes.
  let legacyExpiry: { plan: PlaybackPlan; deadline: number } | undefined;
  let renewing: PlaybackPlan | undefined;
  const renewTimer = setInterval(() => {
    const current = plan;
    if (
      !current ||
      current.native_platform ||
      !roomIsActive() ||
      renewing === current
    )
      return;
    const epoch = session.epoch;
    renewing = current;
    void session
      .api(`/playback-sessions/${current.session_id}`, "POST")
      .then((receipt: unknown) => {
        if (!currentPlan(current) || session.epoch !== epoch) return;
        if (
          receipt &&
          typeof receipt === "object" &&
          "legacy_expiry_unchanged" in receipt &&
          receipt.legacy_expiry_unchanged === true &&
          "expires_in_seconds" in receipt &&
          typeof receipt.expires_in_seconds === "number" &&
          Number.isInteger(receipt.expires_in_seconds) &&
          receipt.expires_in_seconds >= 0 &&
          receipt.expires_in_seconds <= 1800
        ) {
          const deadline =
            performance.now() + receipt.expires_in_seconds * 1000;
          legacyExpiry = {
            plan: current,
            deadline:
              legacyExpiry?.plan === current
                ? Math.min(legacyExpiry.deadline, deadline)
                : deadline,
          };
        }
      })
      .catch((failure) => {
        if (
          !currentPlan(current) ||
          session.epoch !== epoch ||
          !(failure instanceof RequestFailure)
        )
          return;
        if (
          failure.code === "INVALID_PLAYBACK_SESSION" &&
          legacyExpiry?.plan === current &&
          performance.now() >= legacyExpiry.deadline
        ) {
          // Server rejection after its truthful fixed expiry permits one new
          // intent. A 200 with zero remaining merely waits for normal cadence.
          legacyExpiry = undefined;
          void run(() => beginLoad("automatic_load") ?? Promise.resolve());
        } else if (
          ["INVALID_PLAYBACK_SESSION", "SESSION_EXPIRED"].includes(failure.code)
        ) {
          error.value = "播放会话已失效，请重新加载";
        }
      })
      .finally(() => {
        if (renewing === current) renewing = undefined;
      });
  }, 600000);
  onScopeDispose(() => {
    clearInterval(timer);
    clearInterval(observationTimer);
    clearInterval(metricsTimer);
    clearInterval(renewTimer);
    void reset().catch(() => {});
    bestEffort(() => metricSender.stop());
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", visibilityChanged);
  });
  return {
    video,
    distributedIntent,
    distributedFacts,
    peerStats,
    peerSharing,
    useDistributedOutput,
    useOriginalSource,
    startPeerSharing,
    stopPeerSharing,
    waiting,
    blocked,
    dragging,
    mode,
    nativePlatform,
    nativePlaybackMode,
    nativeEncodedHeight,
    nativeLadderRenditions,
    upstreamMeasuredOutput,
    upstreamMeasuredMatchesRequested,
    live,
    nativeProvider,
    nativeCredentialMode,
    nativeQualityMaxHeight,
    nativeQualityOptions,
    nativeQualitySelectedHeight,
    selectNativeQuality,
    platformSubtitleTracks: platformText.platformSubtitleTracks,
    platformSubtitleId: platformText.platformSubtitleId,
    platformSubtitleStatus: platformText.platformSubtitleStatus,
    platformDanmakuStatus: platformText.platformDanmakuStatus,
    platformDanmakuEnabled: platformText.platformDanmakuEnabled,
    platformDanmakuCues: platformText.platformDanmakuCues,
    platformTextError: platformText.platformTextError,
    platformTextLive: platformText.platformTextLive,
    platformLiveDanmakuMode: platformText.platformLiveDanmakuMode,
    setPlatformLiveDanmaku: platformText.setPlatformLiveDanmaku,
    selectPlatformSubtitle: platformText.selectPlatformSubtitle,
    setPlatformDanmaku: platformText.setPlatformDanmaku,
    tracks,
    subtitles,
    audioIndex,
    subtitleIndex,
    advancedCapabilities,
    advancedFacts,
    staticHlsFallbackEnabled,
    staticHlsAvailability,
    staticHlsAvailabilityText,
    localHlsLadderEnabled,
    ladderCapabilities,
    ladderFacts,
    ladderQuality,
    ladderSelected,
    ladderManual,
    selectLadderQuality,
    toneMapHdr,
    burnInSubtitleIndex,
    duration,
    position,
    sessionId,
    preparation,
    cancelPreparation,
    recoveryState,
    playbackSummary,
    recoveryLabel,
    loadMedia,
    applyState,
    enablePlayback,
    applySubtitles,
    reset,
    onClockReady,
    onClockInvalidated,
    mediaChanged,
    resetClockAction,
    attach,
  };
}
