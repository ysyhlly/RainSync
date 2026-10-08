import type { Ref } from "vue";
import type { PlaybackPlan } from "../../../../../packages/protocol";
import { bindPlaybackMetricEvents } from "./metrics-binding";
import { createPlaybackMetricsSender } from "./metrics-sender";
import {
  PLAYBACK_METRICS_MAX_ELAPSED_MS,
  PLAYBACK_METRICS_SAMPLE_MS,
  type PlaybackMetricsSnapshot,
} from "./playback-metrics";
import { bestEffort } from "./playback-runtime-utils";
import type { PlaybackObservationScope } from "./playback-scope";
export type { PlaybackObservationScope } from "./playback-scope";
export function createPlaybackMetricRuntime(ctx: {
  scope: () => PlaybackObservationScope | undefined;
  currentScope: (scope: PlaybackObservationScope) => boolean;
  currentPlan: (plan: PlaybackPlan) => boolean;
  video: Ref<HTMLVideoElement | undefined>;
  state: () => {
    foreground: boolean;
    expectedPlaying: boolean;
    autoplayBlocked: boolean;
    buffering: boolean;
  };
  send: Parameters<typeof createPlaybackMetricsSender>[0];
  snapshot?: (value: PlaybackMetricsSnapshot) => void;
}) {
  const {
    currentScope: scopeCurrent,
    currentPlan,
    video,
    state: metricState,
  } = ctx;
  let metricSource: ReturnType<typeof bindPlaybackMetricEvents> | undefined;
  let samplingScope: PlaybackObservationScope | undefined;
  let sampleTimer: ReturnType<typeof setTimeout> | undefined;
  let nextSampleAt: number | undefined;
  const metricSender = createPlaybackMetricsSender(ctx.send);
  const metricRead = () =>
    bestEffort(() => metricSource?.read()) ?? {
      ...metricState(),
      paused: video.value?.paused ?? true,
      seeking: video.value?.seeking ?? false,
    };
  function advanceObservationSource(m: PlaybackObservationScope) {
    if (ctx.scope() !== m || !scopeCurrent(m)) return;
    bestEffort(() => metricSource?.stop());
    metricSource = undefined;
    m.fence = Object.freeze({
      identity: m.owner,
      generation: m.fence.generation + 1,
    });
    bestEffort(() => m.meter?.beginAttempt(m.fence, metricRead()));
  }

  function bindMetricSource(
    p: PlaybackPlan,
    el: HTMLVideoElement,
    restart = false,
  ) {
    const m = ctx.scope();
    // Local evidence precedes optional negotiation. A later valid grant may
    // enable this same meter; never reconstruct its source phases or frame then.
    if (
      !m?.meter ||
      !scopeCurrent(m) ||
      !currentPlan(p) ||
      m.disabled ||
      !Number.isInteger(p.plan_generation) ||
      p.plan_generation! < 1 ||
      p.plan_generation! > 0xffff_ffff
    )
      return;
    if (restart) advanceObservationSource(m);
    const fence = m.fence;
    const meter = m.meter;
    metricSource = bestEffort(() =>
      bindPlaybackMetricEvents({
        element: el,
        meter,
        fence,
        planGeneration: p.plan_generation!,
        current: () =>
          scopeCurrent(m) &&
          m.fence === fence &&
          currentPlan(p) &&
          video.value === el,
        state: metricState,
      }),
    );
  }

  function attachMetricSource() {
    const m = ctx.scope();
    if (!m?.meter || m.disabled || !scopeCurrent(m)) return;
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
    const m = ctx.scope(),
      grant = p.playback_metrics,
      version = p.playback_metrics_version;
    // Reject obsolete publication before changing this scope's negotiated
    // version/disabled state. A stale grant must not poison its current meter.
    if (!m || !scopeCurrent(m) || !currentPlan(p)) return;
    if (
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
        current: () => scopeCurrent(m) && currentPlan(p),
      }),
    );
  }

  function sampleMetrics() {
    const m = ctx.scope();
    if (!m || !scopeCurrent(m)) return;
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
      // The maintenance tick can also sample. Keep our next timer at least a
      // complete cadence after whichever owner call actually emitted this seq.
      if (samplingScope === m)
        nextSampleAt = performance.now() + PLAYBACK_METRICS_SAMPLE_MS;
      bestEffort(() => ctx.snapshot?.(snapshot));
      if (!m.disabled) bestEffort(() => metricSender.offer(snapshot));
    }
  }

  function stopMetrics() {
    clearTimeout(sampleTimer);
    sampleTimer = undefined;
    samplingScope = undefined;
    nextSampleAt = undefined;
  }
  /** One cadence per logical meter, starting at its t0. Plan/grant/source
   * replacement within the same scope never restarts this schedule. */
  function startMetrics() {
    const m = ctx.scope();
    if (samplingScope === m) return;
    stopMetrics();
    if (!m?.meter || !scopeCurrent(m)) return;
    samplingScope = m;
    nextSampleAt = m.t0 + PLAYBACK_METRICS_SAMPLE_MS;
    const schedule = () => {
      if (samplingScope !== m) return;
      sampleTimer = setTimeout(
        () => {
          sampleTimer = undefined;
          if (samplingScope !== m || ctx.scope() !== m || !scopeCurrent(m)) {
            stopMetrics();
            return;
          }
          const scheduledAt = nextSampleAt;
          sampleMetrics();
          if (samplingScope !== m) return; // snapshot callbacks may replace scope
          if (
            !scopeCurrent(m) ||
            performance.now() - m.t0 > PLAYBACK_METRICS_MAX_ELAPSED_MS
          ) {
            stopMetrics();
            return;
          }
          // Optional observation/sampling failure must not become a 1 ms retry
          // loop. Keep the regular cadence without manufacturing a missing seq.
          if (
            nextSampleAt === scheduledAt &&
            nextSampleAt! <= performance.now()
          )
            nextSampleAt = performance.now() + PLAYBACK_METRICS_SAMPLE_MS;
          schedule();
        },
        Math.max(
          1,
          Math.ceil((nextSampleAt ?? performance.now()) - performance.now()),
        ),
      );
    };
    schedule();
  }

  function observeMetrics() {
    const m = ctx.scope();
    if (m && scopeCurrent(m))
      bestEffort(() => m.meter?.observe(m.fence, metricRead()));
  }
  function stopSource(clear = true) {
    bestEffort(() => metricSource?.stop());
    if (clear) metricSource = undefined;
  }
  function offerFinalScope() {
    const scope = ctx.scope();
    if (!scope || !scopeCurrent(scope)) return;
    const final = bestEffort(() =>
      scope.meter?.dispose(scope.fence, metricRead()),
    );
    if (final && !scope.disabled) bestEffort(() => metricSender.offer(final));
  }
  return {
    sender: metricSender,
    read: metricRead,
    observeMetrics,
    advanceObservationSource,
    bindMetricSource,
    attachMetricSource,
    bindMetricGrant,
    sampleMetrics,
    startMetrics,
    stopMetrics,
    stopSource,
    offerFinalScope,
    progress: () => metricSource?.progress(),
  };
}
