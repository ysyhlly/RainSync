import type { Ref } from "vue";
import type { PlaybackPlan } from "../../../../../packages/protocol";
import { bindPlaybackMetricEvents } from "./metrics-binding";
import { createPlaybackMetricsSender } from "./metrics-sender";
import {
  PLAYBACK_METRICS_MAX_ELAPSED_MS,
  type PlaybackMetrics,
  type PlaybackMetricsFence,
  type PlaybackMetricsOrigin,
  type PlaybackMetricsSnapshot,
} from "./playback-metrics";
import { bestEffort } from "./playback-runtime-utils";
export interface PlaybackMetricAttempt {
  t0: number;
  identity: object;
  fence: PlaybackMetricsFence;
  startGeneration: number;
  origin: PlaybackMetricsOrigin;
  meter?: PlaybackMetrics;
  last?: PlaybackMetricsSnapshot;
  disabled: boolean;
  metricsVersion?: 1 | 2;
}
export function createPlaybackMetricRuntime<
  I extends PlaybackMetricAttempt,
>(ctx: {
  intent: () => I | undefined;
  currentIntent: (intent: I) => boolean;
  currentPlan: (plan: PlaybackPlan) => boolean;
  video: Ref<HTMLVideoElement | undefined>;
  state: () => {
    foreground: boolean;
    expectedPlaying: boolean;
    autoplayBlocked: boolean;
    buffering: boolean;
  };
  send: Parameters<typeof createPlaybackMetricsSender>[0];
}) {
  const {
    currentIntent: metricCurrent,
    currentPlan,
    video,
    state: metricState,
  } = ctx;
  let metricSource: ReturnType<typeof bindPlaybackMetricEvents> | undefined;
  const metricSender = createPlaybackMetricsSender(ctx.send);
  const metricRead = () =>
    bestEffort(() => metricSource?.read()) ?? {
      ...metricState(),
      paused: video.value?.paused ?? true,
      seeking: video.value?.seeking ?? false,
    };
  function advanceMetricAttempt(m: I) {
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
    const m = ctx.intent();
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
    const m = ctx.intent();
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
    const m = ctx.intent(),
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
    const m = ctx.intent();
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

  function observeMetrics() {
    const m = ctx.intent();
    if (m && metricCurrent(m))
      bestEffort(() => m.meter?.observe(m.fence, metricRead()));
  }
  function stopSource(clear = true) {
    bestEffort(() => metricSource?.stop());
    if (clear) metricSource = undefined;
  }
  function offerFinalIntent() {
    const intent = ctx.intent();
    if (!intent || !metricCurrent(intent)) return;
    const final = bestEffort(() =>
      intent.meter?.dispose(intent.fence, metricRead()),
    );
    if (final && !intent.disabled) bestEffort(() => metricSender.offer(final));
  }
  return {
    sender: metricSender,
    read: metricRead,
    observeMetrics,
    advanceMetricAttempt,
    bindMetricSource,
    attachMetricSource,
    bindMetricGrant,
    sampleMetrics,
    stopSource,
    offerFinalIntent,
    progress: () => metricSource?.progress(),
  };
}
