import { computed, ref, nextTick, onScopeDispose, watch, type Ref } from "vue";
import Hls from "hls.js";
import {
  detectCapabilities,
  detectCapabilitiesAsync,
  detectCandidateReport,
  PlaybackPlanGenerations,
  matchesPlanGeneration,
  PlaybackRateSupport,
  availablePlaybackRanges,
  containsPlaybackPosition,
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
  PlaybackCandidateSet,
  PlaybackMetricsReceipt,
} from "../../../../../packages/protocol";
import { RequestFailure } from "../../errors";
import { StaleIdentity } from "../../shared/api/client";
import {
  PlaybackCancelled,
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
import { createPlaybackMetricsSender } from "./metrics-sender";

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
}) {
  const { session, state, connected, clock, error, run } = ctx;
  const roomIsActive = () => ctx.active?.value !== false;
  const video = ref<HTMLVideoElement>(),
    waiting = ref(false),
    blocked = ref(false),
    dragging = ref(false),
    mode = ref("auto");
  const tracks = ref<PlaybackPlan["audio_tracks"]>([]),
    subtitles = ref<PlaybackPlan["subtitle_tracks"]>([]),
    audioIndex = ref<number | undefined>(),
    subtitleIndex = ref<number | undefined>();
  const duration = ref(0),
    position = ref(0),
    sessionId = ref<string | null>(null);
  const recoveryState = ref<PlaybackRecoveryState>("idle");
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
    firstFrameTimer: ReturnType<typeof setTimeout> | undefined,
    capabilityProbe: AbortController | undefined,
    generationWait: AbortController | undefined,
    generationWaitFailed = false,
    generatedEnd: number | undefined;
  const corrector = new Corrector();
  let rates: PlaybackRateSupport | undefined,
    applySerial = 0,
    pendingUserSeek = false,
    pendingForce = false,
    seekSerial = 0;
  let pendingPlay: object | undefined;
  const clockRevision = () => clock.revision ?? 0;
  const clockUsable = () => {
    ctx.checkClock?.();
    return clock.ready && connected.value && foreground();
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
  const planGenerations = new PlaybackPlanGenerations();
  const currentPlan = (p: PlaybackPlan) =>
    plan === p && planGenerations.current(p);
  let playbackRequests: PlaybackRequests | undefined;
  let playbackUser: string | undefined;
  let playbackEpoch: number | undefined;
  let observations: ReturnType<typeof bindPlaybackObservations> | undefined;
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
    element?: HTMLVideoElement;
    meter?: PlaybackMetrics;
    last?: PlaybackMetricsSnapshot;
    disabled: boolean;
    enabledPlan?: PlaybackPlan;
  };
  let metricIntent: MetricIntent | undefined;
  let metricSource: ReturnType<typeof bindPlaybackMetricEvents> | undefined;
  let pendingLoad:
    | {
        metrics: MetricIntent;
        intent: ReturnType<PlaybackPlanGenerations["next"]>;
        failed: string[];
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
    state.value?.room_id === m.room &&
    state.value?.media_generation === m.media &&
    (!m.element || video.value === m.element);
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
  function finishMetrics() {
    const m = metricIntent;
    if (m && metricCurrent(m)) {
      const final = bestEffort(() => m.meter?.dispose(m.fence, metricRead()));
      if (final && !m.disabled) bestEffort(() => metricSender.offer(final));
    }
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
    if (!m?.meter || !metricCurrent(m) || m.enabledPlan !== p) return;
    if (restart) advanceMetricAttempt(m);
    const fence = m.fence;
    const meter = m.meter;
    metricSource = bestEffort(() =>
      bindPlaybackMetricEvents({
        element: el,
        meter,
        fence,
        current: () =>
          metricCurrent(m) &&
          m.fence === fence &&
          currentPlan(p) &&
          video.value === el,
        state: metricState,
      }),
    );
  }
  function bindMetricGrant(p: PlaybackPlan) {
    const m = metricIntent,
      grant = p.playback_metrics;
    if (
      !m ||
      !metricCurrent(m) ||
      m.disabled ||
      p.playback_metrics_version !== 1 ||
      !grant ||
      grant.closed !== false ||
      grant.meter_start_generation !== m.startGeneration ||
      grant.startup_origin !== m.origin ||
      !Number.isSafeInteger(grant.metrics_seq) ||
      grant.metrics_seq < 0 ||
      grant.metrics_seq > (m.last?.seq ?? 0)
    ) {
      if (
        m &&
        grant &&
        (grant.closed || grant.metrics_seq > (m.last?.seq ?? 0))
      )
        m.disabled = true;
      return;
    }
    m.enabledPlan = p;
    bestEffort(() =>
      metricSender.bind({
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
      state.value?.media_generation,
      state.value?.playback_status,
    ],
    () => {
      if (metricIntent && !metricCurrent(metricIntent)) finishMetrics();
      else observeMetrics();
    },
    { flush: "sync" },
  );
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", observeMetrics);
  let checkingEnd = false,
    endAttempt = -Infinity;
  async function completed() {
    const p = plan,
      el = video.value,
      s = state.value;
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
          return session.api<PlaybackPlan>(
            "/playback-sessions",
            "POST",
            body,
            signal,
          );
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
      );
    }
    return playbackRequests;
  }
  async function readReadiness(
    id: string,
    signal: AbortSignal,
    relativePosition = 0,
    planGeneration?: number,
  ): Promise<PlaybackReadiness> {
    const readiness = await session.api<PlaybackReadiness>(
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
    // Keep polling the real position; a complete or legacy response needs no lead.
    if (
      state.value?.playback_status === "playing" &&
      readiness.status === "ready" &&
      readiness.complete === false &&
      readiness.available_until_ms != null &&
      Number.isFinite(readiness.available_until_ms) &&
      readiness.available_until_ms - relativePosition < 4_000
    ) {
      return { ...readiness, status: "preparing" };
    }
    return readiness;
  }
  async function stopPlayback() {
    recoveryPending = false;
    recoveryState.value = "idle";
    terminalEnd = false;
    ++applySerial;
    pendingPlay = undefined;
    // Grant teardown alone (including automatic fallback) never ends its meter.
    bestEffort(() => metricSource?.stop());
    metricSource = undefined;
    bestEffort(() => metricSender.unbind(true));
    if (metricIntent) metricIntent.enabledPlan = undefined;
    // Capture the old element before teardown changes its time or identity.
    const finalObservation = bestEffort(() => observations?.stop());
    observations = undefined;
    clearTimeout(firstFrameTimer);
    firstFrameTimer = undefined;
    capabilityProbe?.abort();
    capabilityProbe = undefined;
    generationWait?.abort();
    generationWait = undefined;
    generationWaitFailed = false;
    generatedEnd = undefined;
    recoveringHls = false;
    const old = plan;
    plan = undefined;
    sessionId.value = null;
    if (video.value) {
      video.value.onerror = null;
      video.value.onended = null;
      video.value.onloadedmetadata = null;
      video.value.onloadeddata = null;
    }
    hls?.destroy();
    hls = undefined;
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
  function beginLoad(origin: PlaybackMetricsOrigin) {
    if (!roomIsActive()) return;
    const s = state.value;
    if (!s?.media_id) return;
    const t0 = performance.now();
    finishMetrics();
    ++loadSerial;
    const intent = planGenerations.next();
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
      element: video.value,
      disabled: false,
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
  async function fallbackLoad(failed: string[] = []) {
    const m = metricIntent;
    if (!m || !metricCurrent(m)) return;
    const intent = planGenerations.next();
    advanceMetricAttempt(m);
    await loadAttempt(failed, intent, m);
  }
  async function loadAttempt(
    failedCandidates: string[],
    intent: ReturnType<PlaybackPlanGenerations["next"]>,
    metrics: MetricIntent,
  ) {
    if (!metricCurrent(metrics)) return;
    const s = state.value!;
    pendingLoad = { metrics, intent, failed: failedCandidates };
    recoveryPending = true;
    updateRecovery();
    if (!clockUsable()) {
      clockAction = "load";
      return;
    }
    const revision = clockRevision();
    const serial = ++loadSerial;
    try {
      await stopPlayback();
      await nextTick();
      if (
        serial !== loadSerial ||
        !metricCurrent(metrics) ||
        !roomIsActive() ||
        !video.value
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
      const probe = new AbortController();
      capabilityProbe = probe;
      let candidateSet: PlaybackCandidateSet | undefined;
      try {
        candidateSet = await session.api<PlaybackCandidateSet>(
          "/playback-candidates",
          "POST",
          {
            room_id: s.room_id,
            media_generation: s.media_generation,
            audio_index: audioIndex.value ?? null,
            position_ms: target(s, clock.now()),
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
      const mseProbe = Hls.isSupported() ? Hls.getMediaSource() : undefined;
      const decoder =
        typeof navigator === "undefined"
          ? undefined
          : navigator.mediaCapabilities;
      const candidateReport = candidateSet
        ? await detectCandidateReport(element, candidateSet, mseProbe, decoder)
        : undefined;
      if (candidateReport)
        candidateReport.excluded_candidates = [...failedCandidates];
      const capabilities = candidateReport
        ? detectCapabilities(element, mseProbe)
        : await detectCapabilitiesAsync(element, mseProbe, decoder);
      // Capability probing is optional asynchronous work. Never start a session
      // for an old identity, element or media after a newer load/reset wins.
      if (
        serial !== loadSerial ||
        !metricCurrent(metrics) ||
        session.epoch !== identity ||
        !roomIsActive() ||
        probe.signal.aborted ||
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
      const request: PlaybackRequest = {
        ...intent,
        room_id: s.room_id,
        media_generation: s.media_generation,
        mode: mode.value,
        audio_index: audioIndex.value ?? null,
        position_ms: target(state.value ?? s, clock.now()),
        capabilities,
        ...(candidateReport ? { candidate_report: candidateReport } : {}),
        observation_version: 1,
        playback_metrics_version: 1,
        playback_metrics: {
          meter_start_generation: metrics.startGeneration,
          startup_origin: metrics.origin,
        },
      };
      waiting.value = true;
      const requestedSeek = seekSerial;
      const p = await requests().prepare(request, () => {
        if (!clockUsable() || revision !== clockRevision()) {
          clockAction = "load";
          throw new PlaybackCancelled();
        }
        return target(state.value ?? s, clock.now());
      });
      if (
        serial !== loadSerial ||
        !metricCurrent(metrics) ||
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
      plan = p;
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
      bindMetricGrant(p);
      applySubtitles();
      const el = video.value;
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
        void completed();
      };
      waiting.value = true;
      let recoveries = 0;
      let mse =
        p.transport === "hls" &&
        !el.canPlayType("application/vnd.apple.mpegurl") &&
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
      const retryDecode = () => {
        const candidate = p.selected_candidate_id;
        if (
          serial !== loadSerial ||
          !currentPlan(p) ||
          !roomIsActive() ||
          mode.value !== "auto" ||
          !candidate ||
          !candidateReport ||
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
          !state.value ||
          recoveries >= 3 ||
          !clockUsable()
        )
          return false;
        recoveries++;
        generationWait?.abort();
        generationWait = undefined;
        generationWaitFailed = false;
        generatedEnd = undefined;
        recoveringHls = true;
        waiting.value = true;
        const position = playbackPosition();
        if (mse && hls) {
          hls.stopLoad();
          bindMetricSource(p, el, true);
          hls.config.startPosition = position;
          hls.loadSource(p.playback_url);
          hls.startLoad(position);
        } else {
          // Native media errors do not expose the failing HTTP status. Retry the
          // unfenced entry with a bounded cache-busting URL and room-time fragment.
          const url = new URL(p.playback_url, location.href);
          bindMetricSource(p, el, true);
          url.searchParams.set("recovery", String(recoveries));
          url.hash = `t=${position}`;
          el.src = url.href;
          el.load();
        }
        return true;
      };
      el.onerror = () => {
        // load() during teardown and queued events from a previous resource are
        // not failures of this plan. A real media error belongs to the active URL.
        if (
          serial !== loadSerial ||
          !roomIsActive() ||
          !currentPlan(p) ||
          video.value !== el ||
          !el.getAttribute("src") ||
          !el.error ||
          el.error.code === 1
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
            el.pause();
            bestEffort(() => metricSource?.stop());
            el.removeAttribute("src");
            el.load();
            bindMetricSource(p, el, true);
            attachHls();
            return;
          }
          if (recover()) return;
        }
        if ((el.error.code === 3 || el.error.code === 4) && retryDecode())
          return;
        recoveringHls = false;
        error.value =
          el.error.code === 2
            ? "媒体加载中断，请检查连接后重新加载"
            : "无法播放此格式，可切换兼容转码后重载";
        waiting.value = false;
      };
      const attachHls = () => {
        hls = new Hls({
          startPosition: playbackPosition(),
          maxBufferLength: 20,
          maxMaxBufferLength: 60,
          backBufferLength: 30,
        });
        hls.loadSource(p.playback_url);
        hls.attachMedia(el);
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (
            serial === loadSerial &&
            currentPlan(p) &&
            roomIsActive() &&
            data.fatal
          ) {
            if (data.response?.code === 409 && recover()) return;
            if (data.type === "mediaError" && retryDecode()) return;
            recoveringHls = false;
            error.value = "媒体加载失败：" + data.details;
            waiting.value = false;
          }
        });
      };
      bindMetricSource(p, el);
      if (mse) attachHls();
      else el.src = p.playback_url;
      if (p.selected_candidate_id) {
        firstFrameTimer = setTimeout(() => {
          if (serial !== loadSerial || !currentPlan(p) || el.readyState >= 2)
            return;
          waiting.value = false;
          error.value = "首帧等待超时，请检查连接或重新加载播放";
        }, 20000);
        el.onloadeddata = () => {
          if (serial !== loadSerial || !currentPlan(p) || el.readyState < 2)
            return;
          clearTimeout(firstFrameTimer);
          firstFrameTimer = undefined;
        };
      }
      el.onloadedmetadata = () => {
        if (serial !== loadSerial || !currentPlan(p)) return;
        applySubtitles();
        duration.value = p.duration_ms ? p.duration_ms / 1000 : el.duration;
        void runAutomaticApply(true);
      };
    } catch (e) {
      if (serial !== loadSerial || e instanceof PlaybackCancelled) return;
      waiting.value = false;
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
        video.value.src = url.href;
        video.value.load();
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
      throw e;
    } finally {
      if (generationWait === controller) generationWait = undefined;
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
    if (!currentPlan(p)) return;
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
      if (userSeek) await beginLoad("automatic_load");
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
      if (el.paused && !blocked.value && !pendingPlay) {
        const playing = {};
        pendingPlay = playing;
        try {
          await el.play();
          if (!afterPlay(p, el, revision, serial)) return;
          blocked.value = false;
          observeMetrics();
        } catch {
          if (!afterPlay(p, el, revision, serial)) return;
          blocked.value = true;
          observeMetrics();
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
    if (!clockUsable()) {
      queueApply();
      return;
    }
    if (p && el && currentPlan(p) && baseRate() && !pendingPlay) {
      const serial = ++applySerial,
        revision = clockRevision();
      const playing = {};
      pendingPlay = playing;
      try {
        await el.play();
      } catch (failure) {
        if (!afterPlay(p, el, revision, serial)) return;
        throw failure;
      } finally {
        if (pendingPlay === playing) pendingPlay = undefined;
      }
      if (!afterPlay(p, el, revision, serial)) return;
      blocked.value = false;
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
    queueApply();
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
          loadAttempt(pending.failed, pending.intent, pending.metrics),
        );
      else void runAutomaticApply(pendingForce, pendingUserSeek);
    }
  }
  function mediaChanged() {
    corrector.reset();
    audioIndex.value = undefined;
    subtitleIndex.value = undefined;
    void run(async () => {
      await beginLoad("automatic_load");
    });
  }
  async function reset() {
    finishMetrics();
    ++loadSerial;
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
    duration.value = 0;
    position.value = 0;
    await stopPlayback();
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
    () => [
      roomIsActive(),
      state.value?.room_id,
      state.value?.media_id,
      state.value?.media_generation,
      session.epoch,
      connected.value,
      waiting.value,
      blocked.value,
      error.value,
    ],
    updateRecovery,
    { flush: "sync" },
  );
  const timer = setInterval(tick, 500);
  const observationTimer = setInterval(
    () => bestEffort(() => observations?.progress()),
    5000,
  );
  const metricsTimer = setInterval(sampleMetrics, 5000);
  const renewTimer = setInterval(() => {
    const current = plan?.session_id;
    if (current && roomIsActive())
      void session
        .api(`/playback-sessions/${current}`, "POST")
        .catch((failure) => {
          if (
            plan?.session_id === current &&
            failure instanceof RequestFailure &&
            ["INVALID_PLAYBACK_SESSION", "SESSION_EXPIRED"].includes(
              failure.code,
            )
          )
            error.value = "播放会话已失效，请重新加载";
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
      document.removeEventListener("visibilitychange", observeMetrics);
  });
  return {
    video,
    waiting,
    blocked,
    dragging,
    mode,
    tracks,
    subtitles,
    audioIndex,
    subtitleIndex,
    duration,
    position,
    sessionId,
    recoveryState,
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
