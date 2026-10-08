import { evaluatePlaybackRecovery } from "./playback-recovery-state";
import { createPlaybackSessionController, checkCandidateLifetime } from "./playback-session-controller";
export type { PlaybackRecoveryState } from "./playback-runtime-types";
import { createLiveWindowRecovery } from "./live-window-recovery";
import { discoverPlaybackCandidates } from "./playback-candidate-discovery";
import type {
  PlaybackRuntimeContext,
  PlaybackIntent,
  CandidateDiscovery,
  StaticChildState,
  PlaybackContinuation,
  PlaybackRecoveryState,
  PlaybackLoadingStage,
} from "./playback-runtime-types";
import { createMediaDataDeadline } from "./media-data-deadline";
import { createPlaybackMetricRuntime } from "./playback-metric-runtime";
import { createPlaybackScope, type PlaybackObservationScope } from "./playback-scope";
import { bestEffort, freezeCandidateSnapshot } from "./playback-runtime-utils";
import {
  finiteHlsRequestParameters,
  validateFiniteHlsChoice,
} from "./finite-hls-intent";
import { computed, ref, nextTick, onScopeDispose, watch } from "vue";
import type { HlsDriver } from "./drivers/hls-driver";
import { loadHlsDriver } from "./hls-driver-loader";
import { getPlaybackMediaSource, supportsHlsPlayback } from "./browser-mse";
import {
  liveRoomMatchesPlan,
  nativeLiveDirective,
  nativeLiveEdge,
  validNativeLiveBinding,
  validNativeLiveDeliveryUrl,
} from "./native-live";
import {
  createDashPlayback,
  loadDashJs,
} from "../../../../../packages/player-core/dash";
import {
  nativePlatformRequest,
  validNativeCompatibilityDeliveryUrl,
  nativePlatformPlaybackChoice,
  type NativePlatformPlaybackMode,
} from "./native-platform-intent";
import {
  advancedPlaybackRequest,
  needsDolbyVisionToneMap,
} from "./advanced-playback-intent";
import {
  localHlsLadderRequest,
  bindLocalHlsLevels,
  hasHlsLadder,
} from "./local-hls-ladder-intent";
import { RoomP2PTransport, type PeerStats } from "./room-p2p";
import {
  validDistributedIntent,
  sameDistributedIntent,
} from "./distributed-playback-intent";
import { createPlatformTextRuntime } from "./platform-text-runtime";
import {
  SameSidDecoderRecovery,
  upstreamOutputMatchesMeasuredBounds,
} from "./upstream-output";
import { observeUpstreamOutput } from "./upstream-output-observer";
import type { NativePlatformProvider } from "../../shared/api/types";
import {
  platformProviderLabels,
  validNativePlatformMetadata,
} from "../rooms/platform-import";
import {
  detectCapabilities,
  PlaybackRateSupport,
  availablePlaybackRanges,
  containsPlaybackPosition,
} from "../../../../../packages/player-core";
import { Corrector, target } from "../../../../../packages/sync-engine";
import type {
  PlaybackPlan,
  PlaybackRequest,
  PlaybackMetricsReceipt,
  NativePlatformMaxHeight,
  NativePlatformQualityOption,
  AdvancedPlaybackCapabilities,
  AdvancedPlaybackFacts,
  LocalHlsLadderCapabilities,
  LocalHlsLadderFacts,
  LocalHlsRendition,
  DistributedComputePlaybackIntent,
  DistributedComputePlaybackFacts,
  UpstreamMeasuredOutput,
} from "../../../../../packages/protocol";
import { RequestFailure } from "../../errors";
import { StaleIdentity } from "../../shared/api/client";
import { actionErrorMessage } from "../../shared/action-error";
import {
  PlaybackCancelled,
  waitPlaybackReady,
} from "../../playback-request";
import { bindPlaybackObservations } from "./observation-binding";
import {
  createPlaybackMetrics,
  type PlaybackMetricsOrigin,
  type PlaybackMetricsSnapshot,
} from "./playback-metrics";
import {
  summarizePlaybackPlan,
  type PlaybackSummary,
} from "./playback-summary";
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
  staticHlsAvailabilityLabel,
  staticHlsOfferCurrent,
  type StaticHlsAvailability,
} from "./static-hls-availability";

const candidateError = "播放候选无法安全使用，请重新加载播放";

export function createPlaybackRuntime(ctx: PlaybackRuntimeContext) {
  const { identity: viewer, api, timeline, commands = {} } = ctx;
  const { state, connected, clock } = timeline;
  const error = ref(""), busy = ref(false);
  let actionSerial = 0, disposed = false;
  const pendingActions = new Set<object>();
  function invalidateActions() {
    ++actionSerial;
    pendingActions.clear();
    busy.value = false;
    error.value = "";
  }
  async function run(
    action: () => Promise<unknown>,
    options: { preserveError?: boolean; busy?: boolean } = {},
  ) {
    if (disposed) return;
    const serial = ++actionSerial,
      epoch = viewer.current().epoch,
      room = state.value?.room_id,
      token = {};
    const tracksBusy = options.busy !== false;
    if (tracksBusy) {
      pendingActions.add(token);
      busy.value = true;
    }
    if (!options.preserveError) error.value = "";
    try {
      await action();
    } catch (failure) {
      if (
        !disposed &&
        serial === actionSerial &&
        epoch === viewer.current().epoch &&
        room === state.value?.room_id &&
        !(failure instanceof PlaybackCancelled) &&
        !(failure instanceof StaleIdentity)
      )
        error.value = actionErrorMessage(failure);
    } finally {
      if (tracksBusy) {
        pendingActions.delete(token);
        if (!disposed) busy.value = pendingActions.size > 0;
      }
    }
  }
  const stopIdentityActions = viewer.subscribeInvalidation(invalidateActions);
  watch(() => state.value?.room_id, invalidateActions, { flush: "sync" });
  onScopeDispose(() => {
    disposed = true;
    stopIdentityActions();
    invalidateActions();
  });
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
  const roomIsActive = () => timeline.active?.value !== false;
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
  const liveWindowScope = () =>
    roomIsActive() && validNativeLiveBinding(state.value?.live)
      ? JSON.stringify([
          viewer.current().userId,
          viewer.current().epoch,
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
  const liveRecovery = createLiveWindowRecovery({
    intent: () => readIntent(),
    terminalEnd: () => terminalEnd,
    scope: liveWindowScope,
    currentPlan: (p) => currentPlan(p),
    currentIntent: (m) => candidateIntentCurrent(m),
    clearRefresh: () => {
      clearTimeout(nativeRefresh);
      nativeRefresh = undefined;
    },
    needsEdge: () => {
      liveNeedsEdge = true;
    },
    error,
    connected,
    state,
    video,
    foreground: () => foreground(),
    fail: (p, code) => failNativeLive(p, code),
    load: () => beginLoad("automatic_load"),
    run,
  });
  const {
    recoverExpiredLiveWindow,
    bindLiveWindowProgress,
    probeExpiredNativeLiveWindow,
  } = liveRecovery;
  const platformText = createPlatformTextRuntime({
    identity: viewer,
    api,
    video,
    preferenceScope: () =>
      roomIsActive() && state.value?.media_id
        ? JSON.stringify([
            viewer.current().userId,
            viewer.current().epoch,
            state.value.room_id,
            state.value.media_id,
            state.value.media_generation,
            nativeCredentialMode.value,
            ctx.platformAccountChange?.value ?? 0,
            ctx.shortPlatformAccountChanges?.value.douyin ?? 0,
            ctx.shortPlatformAccountChanges?.value.tiktok ?? 0,
            ctx.youtubePlatformAccountChange?.value ?? 0,
            ctx.shortPlatformAccountIds?.value.douyin,
            ctx.shortPlatformAccountIds?.value.tiktok,
            ctx.youtubePlatformAccountId?.value,
          ])
        : undefined,
  });
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
  let upstreamRecoveryGrant:
    | {
        session: string;
        generation: number | undefined;
        recovery: SameSidDecoderRecovery;
      }
    | undefined;
  let qualityContext: string | undefined;
  const qualityScope = () =>
    JSON.stringify([
      viewer.current().userId,
      viewer.current().epoch,
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
    const currentIntent = readIntent();
    const p = readPlan();
    if (
      !p ||
      !hasHlsLadder(p) ||
      !currentPlan(p) ||
      !hls ||
      !ladderManual.value ||
      !ladderLevelMap ||
      !currentIntent ||
      !candidateIntentCurrent(currentIntent)
    )
      return;
    const level = value === "auto" ? -1 : ladderLevelMap.get(value);
    if (level === undefined) return;
    ladderQuality.value = value;
    hls.setLevel(level);
  }
  const advancedScope = () =>
    [
      viewer.current().epoch,
      viewer.current().userId,
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
  async function startPeerSharing(consent: {
    acknowledge_peer_addresses: boolean;
    confirm_current_network: boolean;
    upload_allowed: boolean;
  }) {
    const p = readPlan();
    if (
      !p ||
      !currentPlan(p) ||
      !p.distributed_compute?.p2p_enabled ||
      !hls ||
      !primaryPeer ||
      !supportsHlsPlayback()
    )
      throw new Error("当前主播放器不能启用 P2P 分片共享");
    const peer = primaryPeer;
    await peer.start(consent);
    if (!currentPlan(p) || primaryPeer !== peer || !roomIsActive()) {
      await peer.stop();
      throw new PlaybackCancelled();
    }
    updatePeerStats();
  }
  async function useDistributedOutput(
    value: DistributedComputePlaybackIntent,
    sourceAudioIndex?: number | null,
  ) {
    if (!validDistributedIntent(value)) throw new Error("NAS 产物绑定无效");
    if (sourceAudioIndex !== undefined) {
      if (
        sourceAudioIndex !== null &&
        (!Number.isInteger(sourceAudioIndex) ||
          sourceAudioIndex < 0 ||
          sourceAudioIndex > 65535)
      )
        throw new Error("原片音轨编号无效");
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
    position = ref(0);
  const recoveryState = ref<PlaybackRecoveryState>("idle");
  const preparation = ref<PlaybackPreparationState>({ phase: "idle" });
  const loadingStage = ref<PlaybackLoadingStage>("idle");
  const startupDiagnostics = ref<PlaybackMetricsSnapshot>();
  let sourcePresented = false;
  let recoveryWaitAt: number | undefined;
  const recoveryTimeoutError = "本机同步等待超时，请重新加载播放以跟上房间进度";
  function failLocalPlayback(message: string, code?: string, notice = message) {
    // A terminal transport/decoder failure owns its error. Loading deadlines
    // must not replace it after the SDK has already detached the source.
    // Deadline failures retain their existing late-data/gesture recovery.
    if (code !== "MEDIA_DATA_TIMEOUT" && code !== "FIRST_FRAME_TIMEOUT") {
      firstFrameDeadline?.stop();
      mediaDataLoad?.stop();
    }
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
    loadingStage.value = "failed";
  }
  function failNativeCompatibility(p: PlaybackPlan, message: string) {
    if (readPlan() !== p || !p.native_platform?.compatibility) return;
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
  let hls: HlsDriver | undefined,
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
    timeline.checkClock?.();
    return (live.value || clock.ready) && connected.value && foreground();
  };
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
      // Playback's action runner clears its errors for user actions. Automatic
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
  /** Apply an accepted room projection within playback's own status scope.
   * Explicit seeks retain busy feedback; normal projection convergence does not. */
  function applyRoomState(force = false, userSeek = false) {
    return run(() => applyState(force, userSeek), {
      preserveError: true,
      busy: force && userSeek,
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
  let observations: ReturnType<typeof bindPlaybackObservations> | undefined;
  let staticChildState: StaticChildState | undefined;
  let staticBinding: StaticHlsPlanBinding | undefined;
  const sessionController = createPlaybackSessionController({
    identity: viewer,
    api,
    timeline: { state, active: timeline.active },
    storage: () => sessionStorage,
    origin: () => location.origin,
    intentCurrent: (intent) => candidateIntentCurrent(intent),
    retryStaticChild: (binding) => staticChildState?.retry(binding),
    prepared: (value) => {
      preparation.value = applyPreparationSnapshot(preparation.value, {
        generation: value.plan_generation!, sessionId: value.session_id,
        deliveryMode: value.delivery_mode, phase: "preparing",
      });
    },
    readiness: (value) => {
      const snapshot = preparationReadinessSnapshot(value, preparation.value.deliveryMode);
      if (snapshot) preparation.value = applyPreparationSnapshot(preparation.value, snapshot);
    },
  });
  const {
    plan: readPlan,
    intent: readIntent,
    sessionId,
    currentPlan,
    allocateIdempotencyKey,
    nextPlan,
    readReadiness,
    stop: stopSessionRequests,
  } = sessionController;
  let activeObservation: PlaybackObservationScope | undefined;
  function observationFor(intent: PlaybackIntent) {
    return readIntent() === intent && activeObservation?.owner === intent.owner
      ? activeObservation
      : undefined;
  }
  function observationCurrent(scope: PlaybackObservationScope) {
    const currentIntent = readIntent();
    return (
      activeObservation === scope &&
      !!currentIntent &&
      currentIntent.owner === scope.owner &&
      intentCurrent(currentIntent)
    );
  }
  function advanceIntentObservation(intent: PlaybackIntent) {
    const scope = observationFor(intent);
    if (scope) advanceObservationSource(scope);
  }
  let pendingLoad:
    | {
        playbackIntent: PlaybackIntent;
        planIntent: ReturnType<typeof sessionController.nextPlan>;
        failed: string[];
        preparing: boolean;
        continuation?: PlaybackContinuation;
      }
    | undefined;
  const metricRuntime = createPlaybackMetricRuntime({
    scope: () => activeObservation,
    currentScope: observationCurrent,
    currentPlan,
    video,
    state: () => metricState(),
    snapshot: (value) => {
      startupDiagnostics.value = value;
    },
    send: (binding, body, signal) =>
      api<PlaybackMetricsReceipt>(
        `/playback-sessions/${binding.sessionId}/metrics`,
        "POST",
        body,
        signal,
      ),
  });
  const {
    sender: metricSender,
    observeMetrics,
    advanceObservationSource,
    bindMetricSource,
    attachMetricSource: recordMetricSource,
    bindMetricGrant,
    sampleMetrics,
  } = metricRuntime;
  const attachMetricSource = () => {
    recordMetricSource();
    if (!sourcePresented && !preparation.value.failure)
      loadingStage.value = "loading_media";
  };
  const foreground = () =>
    typeof document === "undefined" || document.visibilityState !== "hidden";
  function refreshRecovery() {
    const currentSession = readPlan(), currentIntent = readIntent();
    const ownTimeout =
      preparation.value.failure?.code === "PLAYBACK_RECOVERY_TIMEOUT";
    const next = evaluatePlaybackRecovery({
      state: state.value,
      element: video.value,
      plan: currentSession,
      rates,
      active: roomIsActive(),
      foreground: foreground(),
      clockReady: clock.ready,
      now: () => clock.now(),
      connected: connected.value,
      error:
        ownTimeout && error.value === recoveryTimeoutError ? "" : error.value,
      blocked: blocked.value,
      waiting: waiting.value,
      ownsPlan:
        !!currentSession &&
        currentPlan(currentSession) &&
        !!currentIntent &&
        intentCurrent(currentIntent),
      ownsLoad: !!pendingLoad && intentCurrent(pendingLoad.playbackIntent),
      pending: recoveryPending || ownTimeout,
      previous: recoveryState.value,
      terminalEnd,
      rejectedBaseRate,
      confirmedBaseRate,
      generatedEnd,
      generationWait: !!generationWait,
      generationWaitFailed,
      recoveringHls,
      pendingForce,
      pendingUserSeek,
      pendingPlay: !!pendingPlay,
      unsupportedRateError,
    });
    const at = performance.now();
    const recovering = next.state === "waiting" || next.state === "catching_up";
    if (!sourcePresented || !recovering || !Number.isFinite(at)) {
      recoveryWaitAt = undefined;
    } else {
      recoveryWaitAt ??= at;
      if (ownTimeout || at - recoveryWaitAt >= 20_000) {
        if (!ownTimeout) {
          failLocalPlayback(recoveryTimeoutError, "PLAYBACK_RECOVERY_TIMEOUT");
          if (!error.value) error.value = recoveryTimeoutError;
        }
        recoveryPending = false;
        recoveryState.value = "failed";
        return;
      }
    }
    // Timeout is local uncertainty. Confirmed room convergence may retire
    // exactly its own notice, while other media/authentication failures stay.
    if (ownTimeout && next.state === "idle") {
      if (error.value === recoveryTimeoutError) error.value = "";
      preparation.value = {
        ...preparation.value,
        phase: "ready",
        failure: undefined,
      };
      loadingStage.value = "playing";
    }
    recoveryPending = next.pending;
    recoveryState.value = next.state;
  }
  // Only actions update the status; rendering never samples the clock or writes
  // a rate. Ordinary drift does not reopen an already completed recovery.
  const updateRecovery = () => bestEffort(refreshRecovery);
  const intentCurrent = (m: PlaybackIntent) =>
    readIntent() === m &&
    roomIsActive() &&
    viewer.current().userId === m.user &&
    viewer.current().epoch === m.epoch &&
    (!usesPlatformAccount(m.nativeProvider) ||
      m.nativeCredentialMode === "anonymous" ||
      accountRevision(m.nativeProvider) === m.accountChange) &&
    state.value?.room_id === m.room &&
    state.value?.media_generation === m.media &&
    state.value?.media_id === m.mediaId &&
    (!m.element || video.value === m.element);
  const candidateIntentCurrent = (m: PlaybackIntent) =>
    intentCurrent(m) &&
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
  function invalidateCandidates(m: PlaybackIntent) {
    m.inputsInvalidated = true;
    m.candidateDiscovery?.probe.abort();
    m.candidateDiscovery = undefined;
    m.concreteCandidates = undefined;
  }
  const metricState = () => ({
    foreground: foreground(),
    expectedPlaying: state.value?.playback_status === "playing",
    autoplayBlocked: blocked.value,
    buffering: !!generationWait || recoveringHls,
  });
  const metricRead = metricRuntime.read;
  function visibilityChanged() {
    mediaDataLoad?.sync();
    firstFrameDeadline?.sync();
    observeMetrics();
    updateRecovery();
  }
  function finishIntent() {
    staticChildState?.close();
    staticChildState = undefined;
    staticBinding = undefined;
    const m = readIntent();
    metricRuntime.offerFinalScope();
    if (m) invalidateCandidates(m);
    sessionController.clearIntent();
    activeObservation = undefined;
    startupDiagnostics.value = undefined;
    loadingStage.value = "idle";
    pendingLoad = undefined;
    metricRuntime.stopSource();
    metricRuntime.stopMetrics();
    bestEffort(() => metricSender.unbind(true));
  }
  // Accepted intent/visibility edges remain separate from observation-v1 flags.
  watch(
    () => [
      viewer.current().epoch,
      viewer.current().userId,
      roomIsActive(),
      state.value?.room_id,
      state.value?.media_id,
      state.value?.media_generation,
      state.value?.playback_status,
    ],
    () => {
      const intent = readIntent();
      if (intent && !intentCurrent(intent)) finishIntent();
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
      const intent = readIntent();
      if (intent) invalidateCandidates(intent);
    },
    { flush: "sync" },
  );
  watch(qualityScope, () => clearNativeQuality(true), { flush: "sync" });
  watch(
    advancedScope,
    () => {
      distributedIntent.value = undefined;
      void stopPeerSharing();
    },
    { flush: "sync" },
  );
  watch(advancedScope, clearAdvancedPlayback, { flush: "sync" });
  watch(advancedScope, clearLadderPlayback, { flush: "sync" });
  watch(advancedScope, clearStaticHlsAvailability, { flush: "sync" });
  watch(nativeCredentialMode, () => clearNativeQuality(true), {
    flush: "sync",
  });
  let checkingEnd = false,
    endAttempt = -Infinity;
  function failNativeLive(
    p: PlaybackPlan,
    code = "NATIVE_LIVE_NOT_BROADCASTING",
  ) {
    if (readPlan() !== p || !p.native_platform?.live) return;
    terminalEnd = true;
    liveRecovery.retire();
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
    const p = readPlan(),
      el = video.value,
      s = state.value;
    if (p?.native_platform?.live) {
      if (el?.ended && readPlan() === p) failNativeLive(p);
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
        commands.ended?.(el.currentTime * 1000 + p.timeline_origin_ms);
      }
    } catch (failure) {
      if (currentPlan(p))
        error.value =
          failure instanceof Error ? failure.message : String(failure);
    } finally {
      checkingEnd = false;
    }
  }
  function detachPlayback(
    preserveCandidates?: PlaybackIntent,
    child?: PlaybackContinuation["staticChild"],
  ) {
    upstreamObserver?.stop();
    upstreamObserver = undefined;
    upstreamMeasuredOutput.value = undefined;
    upstreamMeasuredMatchesRequested.value = undefined;
    platformText.retire();
    liveRecovery.retire();
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
    metricRuntime.stopSource();
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
    const detachedSession = sessionController.retirePlan();
    const old = detachedSession?.plan;
    playbackSummary.value = undefined;
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
    const previous = sessionController.captureRequests();
    const deletePrevious = async () => {
      if (detachedSession)
        await detachedSession.stop(finalObservation)
          .catch((failure) => {
            if (!(failure instanceof StaleIdentity))
              console.warn("Playback grant cleanup could not be confirmed");
          });
    };
    return { old, finalObservation, previous, deletePrevious };
  }
  async function stopPlayback(preserveCandidates?: PlaybackIntent) {
    const { finalObservation, previous, deletePrevious } =
      detachPlayback(preserveCandidates);
    // The final sample and Stop commit together before key cancellation can
    // close the grant. Preparing work is still aborted synchronously in stop().
    const beforeCleanup = finalObservation ? deletePrevious : undefined;
    const cancellation = (
      previous
        ? previous.stop(beforeCleanup)
        : viewer.current().userId
          ? stopSessionRequests(beforeCleanup)
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
    if (!s?.media_id) return reset();
    liveRecovery.beginScope(liveWindowScope(), origin === "user_intent");
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
    validateFiniteHlsChoice(mode.value, {
      advanced,
      ladder,
      distributed: distributedIntent.value,
    });
    platformText.retire();
    const t0 = performance.now();
    finishIntent();
    // A source/account refresh immediately retires the owned platform decoder,
    // even while room clock calibration or key cleanup is pending.
    clearTimeout(nativeRefresh);
    nativeRefresh = undefined;
    dash?.destroy();
    dash = undefined;
    const previousPlan = readPlan();
    if (
      previousPlan?.native_platform &&
      (previousPlan.transport === "progressive" ||
        !!previousPlan.native_platform.live ||
        !!previousPlan.native_platform.compatibility) &&
      video.value
    ) {
      // Retire the owned MP4 immediately, even if room-clock calibration delays
      // the replacement request. All stored handlers are fenced by the new intent.
      video.value.onerror = null;
      video.value.onended = null;
      video.value.onloadedmetadata = null;
      video.value.onloadeddata = null;
      if (previousPlan.native_platform.live || previousPlan.native_platform.compatibility) {
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
    const intent = nextPlan();
    preparation.value = {
      phase: "preparing",
      generation: intent.plan_generation,
    };
    sourcePresented = false;
    recoveryWaitAt = undefined;
    loadingStage.value = "preparing";
    const scope = createPlaybackScope<
      Omit<PlaybackIntent, "owner" | "origin" | "initialPlanGeneration">
    >(
      {
        user: viewer.current().userId,
        epoch: viewer.current().epoch,
        room: s.room_id,
        media: s.media_generation,
        mediaId: s.media_id,
        mode: mode.value,
        audio: audioIndex.value,
        advanced,
        ladder,
        staticHlsFallback: staticHlsFallbackEnabled.value,
        distributed: distributedIntent.value
          ? freezeCandidateSnapshot(structuredClone(distributedIntent.value))
          : undefined,
        failedCandidates: [],
        element: video.value,
        originRecoveryUsed,
        accountChange: ctx.platformAccountChange?.value ?? 0,
        nativeCredentialMode: nativeCredentialMode.value,
        nativeQualityMaxHeight: nativeQualityMaxHeight.value,
        nativePlaybackMode: nativePlaybackMode.value,
      },
      { t0, startGeneration: intent.plan_generation, origin },
    );
    const m: PlaybackIntent = scope.intent;
    const observation = scope.observation;
    sessionController.adoptIntent(m);
    activeObservation = observation;
    rates?.reset();
    confirmedBaseRate = rejectedBaseRate = undefined;
    corrector.reset();
    observation.meter = bestEffort(() =>
      createPlaybackMetrics({
        t0: observation.t0,
        startupOrigin: observation.origin,
        fence: observation.fence,
        current: () =>
          observationCurrent(observation) ? observation.fence : undefined,
        initial: metricRead(),
      }),
    );
    metricRuntime.startMetrics();
    return loadAttempt([], intent, m);
  }
  async function loadMedia() {
    await beginLoad("user_intent");
  }
  async function selectNativeQuality(value: string | undefined) {
    const currentIntent = readIntent();
    const p = readPlan();
    if (
      !p?.native_platform?.quality ||
      !currentPlan(p) ||
      !currentIntent ||
      !candidateIntentCurrent(currentIntent) ||
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
    const m = readIntent();
    if (!m || !candidateIntentCurrent(m)) return;
    if (m.distributed)
      throw new Error("此 NAS 产物解码失败，请使用 HTTP 重新加载或选择原片源");
    if (m.concreteCandidates?.upstream) throw new Error(candidateError);
    if (m.concreteCandidates) {
      m.failedCandidates = [...new Set([...m.failedCandidates, ...failed])];
      failed = [...m.failedCandidates];
    }
    const intent = nextPlan();
    advanceIntentObservation(m);
    await loadAttempt(failed, intent, m, continuation);
  }
  function discoverCandidates(
    playbackIntent: PlaybackIntent,
    element: HTMLVideoElement,
  ): Promise<CandidateDiscovery> {
    return discoverPlaybackCandidates(
      {
        staticHlsFallback: ctx.staticHlsFallback,
        api,
        state,
        video,
        clock,
        current: candidateIntentCurrent,
        advancedCapabilities,
        ladderCapabilities,
        staticHlsAvailability,
        candidateError,
        probe: () => capabilityProbe,
        setProbe: (value) => {
          capabilityProbe = value;
        },
      },
      playbackIntent,
      element,
    );
  }
  async function loadAttempt(
    failedCandidates: string[],
    intent: ReturnType<typeof sessionController.nextPlan>,
    playbackIntent: PlaybackIntent,
    continuation?: PlaybackContinuation,
  ): Promise<void> {
    if (!candidateIntentCurrent(playbackIntent)) return;
    loadingStage.value = "preparing";
    sourcePresented = false;
    recoveryWaitAt = undefined;
    if (preparation.value.generation !== intent.plan_generation)
      preparation.value = {
        phase: "preparing",
        generation: intent.plan_generation,
      };
    const s = state.value!;
    const pending = {
      playbackIntent,
      planIntent: intent,
      failed: failedCandidates,
      continuation,
      preparing: false,
    };
    pendingLoad = pending;
    recoveryPending = true;
    updateRecovery();
    const revision = clockRevision();
    const serial = ++loadSerial;
    try {
      if (!continuation) {
        const stopped = stopPlayback(playbackIntent);
        recoveryPending = true;
        updateRecovery();
        await stopped;
      }
      await nextTick();
      if (
        serial !== loadSerial ||
        !candidateIntentCurrent(playbackIntent) ||
        !roomIsActive() ||
        !video.value ||
        (continuation &&
          !continuation.staticChild &&
          readPlan() !== continuation.parent)
      )
        return;
      recoveryPending = true;
      updateRecovery();
      if (!clockUsable() || revision !== clockRevision()) {
        clockAction = "load";
        return;
      }
      const element = video.value;
      playbackIntent.element = element;
      const identity = viewer.current().epoch;
      waiting.value = true;
      const media = ctx.resolveMedia
        ? await ctx.resolveMedia(s.room_id, s.media_id!)
        : undefined;
      if (serial !== loadSerial || !candidateIntentCurrent(playbackIntent)) return;
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
        platform &&
        (media?.platform?.version === 3 || media?.platform?.version === 5)
          ? media.platform
          : undefined;
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
      playbackIntent.nativeProvider = nativeProvider.value;
      if (qualityContext !== qualityScope()) {
        clearNativeQuality(true);
        qualityContext = qualityScope();
        playbackIntent.nativeQualityMaxHeight = "auto";
      }
      if (usesPlatformAccount(playbackIntent.nativeProvider))
        playbackIntent.accountChange = accountRevision(playbackIntent.nativeProvider);
      const nativeCapabilities = platform
        ? detectCapabilities(element, getPlaybackMediaSource())
        : undefined;
      playbackIntent.nativeCourse = platform && media?.platform?.version === 4;
      if (platform) {
        // Finite-mode preference is hidden for Live and cannot leak a transform
        // intent into its separate edge/control contract.
        const choice = nativePlatformPlaybackChoice(
          liveMetadata ? "native" : playbackIntent.nativePlaybackMode,
          playbackIntent.nativeProvider!,
          nativeCapabilities!,
          !!liveMetadata,
        );
        if (
          choice === "unsupported" &&
          (playbackIntent.nativePlaybackMode === "compatibility" ||
            playbackIntent.nativePlaybackMode === "adaptive")
        )
          throw new RequestFailure({
            error: { code: "NATIVE_PLATFORM_DEVICE_UNSUPPORTED" },
          });
        playbackIntent.nativeCompatibility = choice === "compatibility";
      }
      const discovered: CandidateDiscovery = platform
        ? {
            capabilities: {
              progressive_h264_aac:
                playbackIntent.nativeProvider !== "bilibili" &&
                nativeCapabilities!.progressive_h264_aac,
              native_hls:
                (!!liveMetadata || !!playbackIntent.nativeCompatibility) &&
                nativeCapabilities!.native_hls,
              mse_h264_aac:
                (liveMetadata ||
                  playbackIntent.nativeCompatibility ||
                  playbackIntent.nativeProvider === "bilibili" ||
                  playbackIntent.nativeProvider === "youtube") &&
                nativeCapabilities!.mse_h264_aac,
            },
          }
        : playbackIntent.distributed
          ? {
              capabilities: detectCapabilities(
                element,
                getPlaybackMediaSource(),
              ),
            }
          : playbackIntent.mode === "finite_hls"
            ? {
                capabilities: detectCapabilities(
                  element,
                  getPlaybackMediaSource(),
                ),
              }
            : continuation
              ? { capabilities: continuation.capabilities }
              : await discoverCandidates(playbackIntent, element);
      if (serial !== loadSerial || !candidateIntentCurrent(playbackIntent)) return;
      if (
        !platform &&
        !playbackIntent.distributed &&
        !playbackIntent.advanced &&
        !playbackIntent.ladder &&
        !continuation &&
        playbackIntent.mode === "auto" &&
        needsDolbyVisionToneMap(
          advancedCapabilities.value,
          discovered.concrete?.candidates,
          discovered.report,
          failedCandidates,
        )
      ) {
        toneMapHdr.value = true;
        await beginLoad("user_intent");
        return;
      }
      validateFiniteHlsChoice(playbackIntent.mode, {
        advanced: playbackIntent.advanced,
        ladder: playbackIntent.ladder,
        distributed: playbackIntent.distributed,
        continuation,
      });
      const finiteParameters =
        !platform && playbackIntent.mode === "finite_hls"
          ? finiteHlsRequestParameters(
              playbackIntent.mode,
              media?.kind,
              discovered.capabilities,
            )
          : undefined;
      const staticRoot =
        !platform &&
        !playbackIntent.distributed &&
        !playbackIntent.advanced &&
        !playbackIntent.ladder &&
        !continuation &&
        ctx.staticHlsFallback === true &&
        playbackIntent.staticHlsFallback &&
        staticHlsOfferCurrent(
          discovered.staticHls?.availability,
          discovered.staticHls?.observedAt,
          performance.now(),
        ) &&
        (discovered.capabilities.native_hls ||
          discovered.capabilities.mse_h264_aac) &&
        !discovered.concrete &&
        !discovered.upstream &&
        ["auto", "direct"].includes(playbackIntent.mode);
      const staticReplay = continuation?.staticChild;
      if (
        staticReplay &&
        !staticReplay.state.retry({
          room_id: playbackIntent.room,
          media_id: playbackIntent.mediaId,
          media_generation: playbackIntent.media,
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
                ? playbackIntent.failedCandidates
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
        !candidateIntentCurrent(playbackIntent) ||
        viewer.current().epoch !== identity ||
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
      const observation = observationFor(playbackIntent);
      const request: PlaybackRequest = platform
        ? nativePlatformRequest({
            ...intent,
            idempotency_key: allocateIdempotencyKey(),
            room_id: s.room_id,
            media_generation: s.media_generation,
            position_ms: target(state.value ?? s, clock.now()),
            credential_mode: playbackIntent.nativeCredentialMode,
            provider: playbackIntent.nativeProvider,
            media_id: s.media_id!,
            max_height: playbackIntent.nativeQualityMaxHeight,
            account_id:
              playbackIntent.nativeProvider === "douyin" ||
              playbackIntent.nativeProvider === "tiktok"
                ? ctx.shortPlatformAccountIds?.value[playbackIntent.nativeProvider]
                : playbackIntent.nativeProvider === "youtube"
                  ? ctx.youtubePlatformAccountId?.value
                  : undefined,
            mse_h264_aac: capabilities.mse_h264_aac,
            progressive_h264_aac: capabilities.progressive_h264_aac,
            native_hls: capabilities.native_hls,
            live: !!liveMetadata,
            compatibility: playbackIntent.nativeCompatibility,
            compatibility_ladder:
              playbackIntent.nativeCompatibility &&
              playbackIntent.nativePlaybackMode === "adaptive",
            course: playbackIntent.nativeCourse,
            playback_metrics:
              observation?.meter && !observation.disabled
                ? freezeCandidateSnapshot({
                    meter_start_generation: playbackIntent.initialPlanGeneration,
                    startup_origin: playbackIntent.origin,
                  })
                : undefined,
          })
        : staticReplay
          ? staticReplay.intent.request
          : {
              ...intent,
              idempotency_key: allocateIdempotencyKey(),
              room_id: s.room_id,
              media_generation: s.media_generation,
              mode: playbackIntent.distributed
                ? "auto"
                : continuation || playbackIntent.advanced || playbackIntent.ladder
                  ? "transcode"
                  : (finiteParameters?.mode ?? playbackIntent.mode),
              ...(finiteParameters?.finite_hls_version === 1
                ? { finite_hls_version: 1 }
                : {}),
              audio_index: continuation
                ? (continuation.parent.selected_audio_track ?? null)
                : (playbackIntent.audio ?? null),
              position_ms: target(state.value ?? s, clock.now()),
              capabilities,
              ...(playbackIntent.distributed
                ? { distributed_compute: playbackIntent.distributed }
                : {}),
              ...(playbackIntent.ladder ? { local_hls_ladder: playbackIntent.ladder } : {}),
              ...(playbackIntent.advanced
                ? { advanced_playback: playbackIntent.advanced }
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
              ...(playbackIntent.distributed ||
              finiteParameters ||
              playbackIntent.advanced ||
              playbackIntent.ladder
                ? {}
                : staticRoot
                  ? { static_hls_fallback_version: 1 }
                  : { http_file_fallback_version: 1 }),
              playback_metrics_version: 1,
              playback_metrics_supported_versions: freezeCandidateSnapshot([
                1, 2,
              ]),
              playback_metrics: freezeCandidateSnapshot({
                meter_start_generation: playbackIntent.initialPlanGeneration,
                startup_origin: playbackIntent.origin,
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
        playbackIntent.distributed ||
        !!finiteParameters ||
        staticReplay ||
        discovered.concrete ||
        discovered.upstream
      );
      if (
        platform &&
        playbackIntent.nativeProvider === "bilibili" &&
        !liveMetadata &&
        !playbackIntent.nativeCompatibility &&
        capabilities.mse_h264_aac
      ) {
        // This resource can only use DASH on this branch. Overlap the static
        // SDK download with server preparation, never with media authorization.
        // The shared loader owns no attachment, identity or room mutation.
        void loadDashJs().catch(() => {});
      }
      let p: PlaybackPlan;
      if (continuation?.staticChild) {
        if (readPlan() !== continuation.parent) throw new PlaybackCancelled();
        const detached = detachPlayback(undefined, continuation.staticChild);
        const preparing = sessionController.prepareStaticHlsChild(
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
        if (readPlan() !== continuation.parent) throw new PlaybackCancelled();
        const detached = detachPlayback();
        request.http_file_fallback = {
          parent_session_id: continuation.parent.session_id,
          ...(detached.finalObservation
            ? { final_observation: detached.finalObservation }
            : {}),
        };
        const preparing = sessionController.prepareContinuation(
          request,
          detached.deletePrevious,
          currentPosition,
        );
        recoveryPending = true;
        updateRecovery();
        p = await preparing;
      } else p = await sessionController.prepare(request, currentPosition);
      if (
        serial !== loadSerial ||
        !candidateIntentCurrent(playbackIntent) ||
        !roomIsActive() ||
        viewer.current().epoch !== identity ||
        video.value !== element ||
        state.value?.room_id !== s.room_id ||
        state.value?.media_generation !== s.media_generation ||
        !sessionController.planGenerationCurrent(p)
      ) {
        await sessionController.captureSessionStop(p, {
          userId: playbackIntent.user, epoch: playbackIntent.epoch,
        })();
        return;
      }
      if (platform && p.media_id !== playbackIntent.mediaId) {
        await stopSessionRequests();
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
        await stopSessionRequests();
        throw new Error(candidateError);
      }
      if (discovered.upstream && !supportsHlsPlayback()) {
        await stopSessionRequests();
        throw new Error(candidateError);
      }
      sessionController.adoptPlan(p, playbackIntent);
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
      nativeEncodedHeight.value = hasHlsLadder(p)
        ? undefined
        : p.native_platform?.compatibility?.output?.height;
      nativeLadderRenditions.value =
        p.native_platform?.compatibility?.output?.renditions;
      preparation.value = applyPreparationSnapshot(preparation.value, {
        phase: "ready",
        generation: intent.plan_generation,
        sessionId: p.session_id,
        deliveryMode: p.delivery_mode,
      });
      loadingStage.value = "initializing";
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
          ? {
              mode: "NAS 计算产物",
              reason: `已测量输出 H.264 ${p.distributed_compute.width}×${p.distributed_compute.height}；跟随原片房间时间，分片默认 HTTP`,
            }
          : summarizePlaybackPlan(p);
      pendingLoad = undefined;
      // A new plan request has consumed the latest explicit target. Its own
      // metadata reconcile must not replay a pre-load seek as another rebuild.
      if (requestedSeek === seekSerial) {
        pendingUserSeek = false;
        pendingForce = false;
      }
      sessionController.publishSession(p);
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
        const user = viewer.current().userId!;
        const epoch = viewer.current().epoch;
        observations = bestEffort(() =>
          bindPlaybackObservations({
            element: el,
            plan: p,
            current: () =>
              currentPlan(p) &&
              roomIsActive() &&
              serial === loadSerial &&
              video.value === el &&
              viewer.current().userId === user &&
              viewer.current().epoch === epoch &&
              state.value?.room_id === s.room_id &&
              state.value?.media_generation === p.media_generation,
            finalCurrent: () =>
              readPlan() === p &&
              video.value === el &&
              viewer.current().userId === user &&
              viewer.current().epoch === epoch,
            send: async (body, signal) => {
              if (viewer.current().epoch !== epoch) throw new StaleIdentity();
              await api(
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
        if (serial !== loadSerial || !currentPlan(p) || !intentCurrent(playbackIntent))
          return;
        void completed();
      };
      waiting.value = true;
      let recoveries = 0;
      firstFrameDeadline = createFirstFrameDeadline({
        element: el,
        current: () =>
          serial === loadSerial && currentPlan(p) && intentCurrent(playbackIntent),
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
        presented: () => {
          if (
            serial !== loadSerial ||
            !currentPlan(p) ||
            !intentCurrent(playbackIntent)
          )
            return;
          sourcePresented = true;
          const failed = preparation.value.failure;
          if (failed?.code === "FIRST_FRAME_TIMEOUT") {
            preparation.value = {
              ...preparation.value,
              phase: "ready",
              failure: undefined,
            };
            if (error.value === firstFrameTimeoutError) error.value = "";
          }
          if (!preparation.value.failure) loadingStage.value = "playing";
          waiting.value = false;
          updateRecovery();
        },
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
      const dataMediaId = s.media_id;
      mediaDataLoad = createMediaDataDeadline({
        element: el,
        current: () =>
          serial === loadSerial &&
          currentPlan(p) &&
          roomIsActive() &&
          viewer.current().userId === playbackIntent.user &&
          viewer.current().epoch === playbackIntent.epoch &&
          state.value?.room_id === playbackIntent.room &&
          state.value?.media_generation === playbackIntent.media &&
          state.value?.media_id === dataMediaId &&
          video.value === el,
        suspended: () =>
          !!generationWait ||
          generationWaitFailed ||
          blocked.value ||
          !foreground(),
        ready: () => {
          if (preparation.value.failure?.code === "MEDIA_DATA_TIMEOUT")
            preparation.value = {
              ...preparation.value,
              phase: "ready",
              failure: undefined,
            };
          if (error.value === mediaDataTimeoutError) error.value = "";
          if (!sourcePresented && !preparation.value.failure)
            loadingStage.value = "waiting_frame";
        },
        clearBlockedFailure: () => {
          if (!blocked.value || error.value !== mediaDataTimeoutError)
            return false;
          error.value = "";
          return true;
        },
        timeout: () => {
          recoveringHls = false;
          waiting.value = false;
          failLocalPlayback(mediaDataTimeoutError, "MEDIA_DATA_TIMEOUT");
          if (!error.value) error.value = mediaDataTimeoutError;
        },
      });
      const Hls = p.transport === "hls" ? await loadHlsDriver() : undefined;
      if (
        serial !== loadSerial ||
        !roomIsActive() ||
        !currentPlan(p) ||
        !candidateIntentCurrent(playbackIntent) ||
        video.value !== el
      )
        return;
      let mse =
        p.transport === "hls" &&
        (!!p.distributed_compute ||
          !!p.upstream_profile ||
          !el.canPlayType("application/vnd.apple.mpegurl")) &&
        Hls?.isSupported();
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
        candidateIntentCurrent(playbackIntent) &&
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
        const childIntent = sessionController.nextPlanWhen((intent) => {
          const proposal = childState!.propose({
            current: binding,
            failure: { binding, event },
            child: {
              ...intent,
              idempotency_key: allocateIdempotencyKey(),
            },
            position_ms: target(state.value!, clock.now()),
            final_observation: sample ? { binding, sample } : null,
          });
          if (proposal.kind !== "proposed") return false;
          proposed = proposal.intent;
          return true;
        });
        if (!childIntent || !proposed) return false;
        advanceIntentObservation(playbackIntent);
        const next: PlaybackContinuation = {
          parent: p,
          capabilities: proposed.request.capabilities,
          staticChild: {
            state: childState!,
            intent: proposed,
            finalObservation: sample,
          },
        };
        void run(() => loadAttempt([], childIntent, playbackIntent, next));
        return true;
      };
      const retryDecode = () => {
        const candidate = p.selected_candidate_id;
        if (
          serial !== loadSerial ||
          !currentPlan(p) ||
          !roomIsActive() ||
          !candidateIntentCurrent(playbackIntent) ||
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
          !intentCurrent(playbackIntent) ||
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
            if (hls.reload(position)) attachMetricSource();
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
            !intentCurrent(playbackIntent) ||
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
              Hls?.isSupported()
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
              metricRuntime.stopSource(false);
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
      if (
        p.upstream_profile &&
        (!upstreamRecoveryGrant ||
          upstreamRecoveryGrant.session !== p.session_id ||
          upstreamRecoveryGrant.generation !== p.plan_generation)
      ) {
        upstreamRecoveryGrant = {
          session: p.session_id,
          generation: p.plan_generation,
          recovery: new SameSidDecoderRecovery(p),
        };
      }
      const sameSidRecovery = p.upstream_profile
        ? upstreamRecoveryGrant?.recovery
        : undefined;
      if (p.distributed_compute && Hls?.isSupported()) {
        const f = p.distributed_compute;
        const peer = new RoomP2PTransport(
          api,
          s.room_id,
          f.job_id,
          updatePeerStats,
          { session: p.session_id, outputGeneration: f.output_generation },
        );
        primaryPeer = peer;
        await peer.prepare();
        if (
          serial !== loadSerial ||
          !currentPlan(p) ||
          !roomIsActive() ||
          primaryPeer !== peer
        ) {
          await peer.stop();
          return;
        }
        updatePeerStats();
      }
      const primaryBufferSeconds = () => {
        for (let i = 0; i < el.buffered.length; i++)
          if (
            el.currentTime >= el.buffered.start(i) &&
            el.currentTime < el.buffered.end(i)
          )
            return el.buffered.end(i) - el.currentTime;
        return 0;
      };
      const attachHls = () => {
        if (!Hls || serial !== loadSerial || !currentPlan(p) || video.value !== el)
          return;
        const attachedHls = Hls.create({
          element: el,
          url: p.playback_url,
          startPosition: p.native_platform?.live ? -1 : playbackPosition(),
          current: () =>
            serial === loadSerial &&
            currentPlan(p) &&
            intentCurrent(playbackIntent) &&
            roomIsActive() &&
            hls === attachedHls &&
            video.value === el,
          live: !!p.native_platform?.live,
          fragments:
            p.distributed_compute && primaryPeer
              ? { transport: primaryPeer, bufferSeconds: primaryBufferSeconds }
              : undefined,
          validateRequest: p.native_platform?.live
            ? (url) =>
                validNativeLiveDeliveryUrl(
                  url,
                  p.session_id,
                  location.origin,
                  false,
                  p.native_platform!.live!.version,
                )
            : p.native_platform?.compatibility
              ? (url) => validNativeCompatibilityDeliveryUrl(url, p, location.origin)
              : undefined,
          attached: attachMetricSource,
          captions: p.native_platform?.live
            ? (track, cues) => platformText.ingestLiveInbandCaptions(track, cues)
            : undefined,
          ...(hasHlsLadder(p)
            ? {
                manifest: (levels) => {
                  if (!candidateIntentCurrent(playbackIntent)) return;
                  const mapping = bindLocalHlsLevels(p, levels, location.origin);
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
                  attachedHls.setLevel(
                    ladderQuality.value === "auto"
                      ? -1
                      : mapping.get(ladderQuality.value)!,
                  );
                },
                level: (level) => {
                  if (candidateIntentCurrent(playbackIntent) && ladderLevelMap)
                    ladderSelected.value = [...ladderLevelMap].find(
                      ([, index]) => index === level,
                    )?.[0];
                },
              }
            : {}),
          error: (data) => {
            if (
              serial === loadSerial &&
              currentPlan(p) &&
              intentCurrent(playbackIntent) &&
              roomIsActive() &&
              hls === attachedHls &&
              staticBinding === binding &&
              (data.fatal ||
                (!!p.native_platform &&
                  [401, 403, 409, 410].includes(data.response?.code ?? 0)))
            ) {
              if (p.native_platform?.live) {
                const code = data.liveCode ?? "NATIVE_PLATFORM_DELIVERY_INVALID";
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
              if (data.unsupportedTimeline) {
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
                  media_error_code: data.media_error_code,
                  error_name: data.error_name,
                })
              )
                return;
              if (data.response?.code === 409 && recover()) return;
              if (
                sameSidRecovery?.recover({
                  plan: p,
                  current:
                    serial === loadSerial &&
                    currentPlan(p) &&
                    roomIsActive() &&
                    intentCurrent(playbackIntent) &&
                    candidateIntentCurrent(playbackIntent) &&
                    video.value === el &&
                    hls === attachedHls,
                  fatal: data.fatal,
                  type: data.type,
                  recoverMediaError: () => attachedHls.recoverMediaError(),
                })
              ) {
                recoveringHls = true;
                waiting.value = true;
                return;
              }
              if (
                sameSidRecovery?.recoverNetwork({
                  plan: p,
                  current:
                    serial === loadSerial &&
                    currentPlan(p) &&
                    roomIsActive() &&
                    intentCurrent(playbackIntent) &&
                    candidateIntentCurrent(playbackIntent) &&
                    video.value === el &&
                    hls === attachedHls,
                  fatal: data.fatal,
                  type: data.type,
                  details: data.details,
                  status: data.response?.code,
                  startLoad: () => attachedHls.startLoad(-1),
                })
              ) {
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
          },
        });
        hls = attachedHls;
        const binding = bindAttachment(attachedHls);
        attachedHls.attach();
      };
      bindMetricSource(p, el);
      if (p.upstream_profile) {
        upstreamObserver?.stop();
        upstreamObserver = observeUpstreamOutput({
          plan: p,
          origin: location.origin,
          current: () =>
            serial === loadSerial &&
            currentPlan(p) &&
            roomIsActive() &&
            intentCurrent(playbackIntent) &&
            candidateIntentCurrent(playbackIntent) &&
            video.value === el,
          facts: (facts) => {
            upstreamMeasuredOutput.value = facts;
            upstreamMeasuredMatchesRequested.value =
              upstreamOutputMatchesMeasuredBounds(facts, p);
          },
        });
      }
      // Metadata drives room reconciliation; SDK readiness does not prove a frame.
      el.onloadedmetadata = () => {
        if (serial !== loadSerial || !currentPlan(p) || !intentCurrent(playbackIntent))
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
          intentCurrent(playbackIntent) &&
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
            onSourceAttached: () => {
              if (current()) attachMetricSource();
            },
            onStatus: (snapshot) => {
              if (!current() || sourcePresented) return;
              if (snapshot.status === "loading")
                loadingStage.value = "initializing";
              else if (snapshot.status === "failed")
                loadingStage.value = "failed";
              else if (
                [
                  "loading_media",
                  "ready",
                  "waiting",
                  "playing",
                  "paused",
                  "seeking",
                ].includes(snapshot.status)
              )
                loadingStage.value =
                  snapshot.readyState >= 2 ? "waiting_frame" : "loading_media";
            },
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
        !candidateIntentCurrent(playbackIntent) ||
        e instanceof PlaybackCancelled
      )
        return;
      waiting.value = false;
      pendingLoad = undefined;
      // Only the controller's qualified pre-mutation rejection may rotate.
      // This starts a new logical meter/intent; old packets and keys stay owned.
      if (
        !continuation &&
        sessionController.rotateViewerOrigin(e, playbackIntent)
      )
        return beginLoad(playbackIntent.origin, true);
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
        throw new Error("此服务器不支持安全续接，请重新加载播放", { cause: e });
      }
      preparation.value = {
        ...preparation.value,
        phase: "failed",
        failure: preparationFailure(e),
      };
      loadingStage.value = "failed";
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
    } catch (failure) {
      // Clock recalibration and media replacement cancel readiness deliberately.
      if (!(failure instanceof PlaybackCancelled)) throw failure;
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
    const p = readPlan();
    if (!s || !el || !p) return;
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
    const p = readPlan(),
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
    const p = readPlan();
    if (!s || !el || !p) return;
    if (failedCompatibilityPlan === p) return;
    if (p.native_platform?.live) {
      position.value = duration.value = 0;
      corrector.reset();
      if (!liveRoomMatchesPlan(s, p)) {
        failNativeLive(p, "NATIVE_LIVE_STATE_CHANGED");
        return;
      }
      if (el.ended) {
        if (!terminalEnd) failNativeLive(p);
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
      position.value = el.currentTime + p.timeline_origin_ms / 1000;
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
      (target(s, clock.now()) - p.timeline_origin_ms) / 1000,
    );
    const ranges = availablePlaybackRanges(el);
    if (!containsPlaybackPosition(ranges, expected)) {
      restoreBaseRate();
      corrector.reset();
      if (p.rebuild_on_seek) void runAutomaticApply(true);
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
    recoveryPending = !!readPlan() || !!pendingLoad;
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
            pending.planIntent,
            pending.playbackIntent,
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
    finishIntent();
    ++loadSerial;
    preparation.value = { phase: "idle" };
    sourcePresented = false;
    recoveryWaitAt = undefined;
    loadingStage.value = "idle";
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
    if (
      !readPlan() &&
      pendingLoad &&
      !pendingLoad.preparing &&
      roomIsActive() &&
      candidateIntentCurrent(pendingLoad.playbackIntent)
    ) {
      // Late host attachment replays the original deferred generation/meter.
      // A previous pre-POST attempt is fenced by loadSerial, not a new intent.
      clockAction = "load";
      onClockReady();
    }
  }
  watch(
    liveWindowScope,
    () => {
      liveRecovery.retire();
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
      viewer.current().userId,
      viewer.current().epoch,
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
  const maintenance = sessionController.startMaintenance({
    tick,
    observe: () => observations?.progress(),
    sample: sampleMetrics,
    visibilityChanged,
    reload: () => {
      void run(() => beginLoad("automatic_load") ?? Promise.resolve());
    },
    expired: () => {
      error.value = "播放会话已失效，请重新加载";
    },
  });
  onScopeDispose(() => {
    maintenance.stop();
    void reset().catch(() => {
      // The disposed scope cannot display an error; report only its category.
      console.warn("Playback runtime cleanup could not be confirmed");
    });
    bestEffort(() => metricSender.stop());
  });
  return {
    playbackError: error,
    playbackBusy: busy,
    runPlayback: run,
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
    loadingStage,
    startupDiagnostics,
    cancelPreparation,
    recoveryState,
    playbackSummary,
    recoveryLabel,
    loadMedia,
    applyState,
    applyRoomState,
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
