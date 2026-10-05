import type {
  PlaybackMetricsReceipt,
  PlaybackMetricsSample,
  PlaybackMetricsPacket,
} from "../../../../../packages/protocol";
import { RequestFailure } from "../../errors";
import {
  PLAYBACK_METRICS_MAX_ELAPSED_MS,
  type PlaybackMetricsSnapshot,
} from "./playback-metrics";

export type PlaybackMetricsBinding = Readonly<{
  version: 1 | 2;
  sessionId: string;
  planGeneration: number;
  meterStartGeneration: number;
  mediaGeneration: number;
  startupOrigin: PlaybackMetricsSample["startup_origin"];
  current: () => boolean;
}>;
type Packet = { binding: PlaybackMetricsBinding; body: PlaybackMetricsPacket };

/** One player owns one bounded sender, including through logical intent changes.
 * seq belongs to the cumulative meter. Binding changes never rewrite old packets. */
export function createPlaybackMetricsSender(
  send: (
    binding: PlaybackMetricsBinding,
    body: PlaybackMetricsPacket,
    signal: AbortSignal,
  ) => Promise<PlaybackMetricsReceipt>,
) {
  let active = true;
  let binding: PlaybackMetricsBinding | undefined;
  let pending: Packet | undefined;
  let running: Promise<void> | undefined;
  let request: AbortController | undefined;
  let inFlight: Packet | undefined;
  let failure: unknown;
  let offeredSeq = 0;
  let cancelBackoff: (() => void) | undefined;
  const current = (b: PlaybackMetricsBinding) => {
    try {
      return b.current();
    } catch {
      return false;
    }
  };
  const live = (p: Packet) =>
    active && binding === p.binding && current(p.binding);
  const transient = (e: unknown) =>
    e instanceof TypeError ||
    (e instanceof DOMException && e.name === "AbortError") ||
    (e instanceof RequestFailure &&
      (e.retryable ||
        e.code === "SERVICE_UNAVAILABLE" ||
        e.code.includes("RATE_LIMIT")));
  function backoff(error: unknown) {
    // The shared API exposes the structured delay. The receiver's 429 header
    // alone is not available here; its documented two-second default is used.
    const delay =
      error instanceof RequestFailure
        ? Math.min(
            5000,
            Math.max(
              0,
              error.retryAfterMs ??
                (error.code.includes("RATE_LIMIT") ? 2000 : 1000),
            ),
          )
        : 1000;
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        cancelBackoff = undefined;
        resolve();
      };
      const timer = setTimeout(finish, delay);
      cancelBackoff = finish;
    });
  }
  async function drain() {
    while (active && pending) {
      const packet = pending;
      pending = undefined;
      if (!live(packet)) continue;
      inFlight = packet;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!live(packet)) break;
        const controller = new AbortController();
        request = controller;
        const deadline = setTimeout(() => controller.abort(), 5000);
        try {
          const receipt = await send(
            packet.binding,
            packet.body,
            controller.signal,
          );
          if (controller.signal.aborted || !live(packet)) break;
          if (
            receipt.session_id !== packet.binding.sessionId ||
            receipt.meter_start_generation !==
              packet.body.meter_start_generation ||
            receipt.metrics_seq !== packet.body.seq ||
            receipt.closed !== packet.body.final
          )
            throw new Error("Invalid metrics receipt");
          failure = undefined;
          break;
        } catch (error) {
          if (!live(packet)) break;
          failure = error;
          if (!transient(error)) {
            binding = undefined;
            pending = undefined;
            break;
          }
          if (pending || attempt === 1) break;
          clearTimeout(deadline);
          await backoff(error);
          if (!live(packet) || pending) break;
        } finally {
          clearTimeout(deadline);
          if (request === controller) request = undefined;
        }
      }
      inFlight = undefined;
    }
  }
  function start() {
    if (running || !active || !pending) return;
    running = drain().finally(() => {
      running = undefined;
      if (active && pending) start();
    });
  }
  return {
    bind(next: PlaybackMetricsBinding) {
      cancelBackoff?.();
      binding = Object.freeze({
        version: next.version,
        sessionId: next.sessionId,
        planGeneration: next.planGeneration,
        meterStartGeneration: next.meterStartGeneration,
        mediaGeneration: next.mediaGeneration,
        startupOrigin: next.startupOrigin,
        current: next.current,
      });
      pending = undefined;
      offeredSeq = 0;
      request?.abort();
    },
    offer(snapshot: PlaybackMetricsSnapshot): boolean {
      const totals = {
        startup_ms: snapshot.totals.startup_ms,
        autoplay_blocked_ms: snapshot.totals.autoplay_blocked_ms,
        background_ms: snapshot.totals.background_ms,
        paused_ms: snapshot.totals.paused_ms,
        seeking_ms: snapshot.totals.seeking_ms,
        rebuffer_ms: snapshot.totals.rebuffer_ms,
        playing_ms: snapshot.totals.playing_ms,
        unobserved_ms: snapshot.totals.unobserved_ms,
      };
      if (
        !active ||
        !binding ||
        !current(binding) ||
        ![1, 2].includes(binding.version) ||
        !Number.isInteger(binding.planGeneration) ||
        binding.planGeneration < 1 ||
        binding.planGeneration > 0xffff_ffff ||
        !Number.isInteger(binding.meterStartGeneration) ||
        binding.meterStartGeneration < 1 ||
        binding.meterStartGeneration > binding.planGeneration ||
        !Number.isInteger(binding.mediaGeneration) ||
        binding.mediaGeneration < 0 ||
        binding.mediaGeneration > 0xffff_ffff ||
        typeof snapshot.final !== "boolean" ||
        snapshot.startup_origin !== binding.startupOrigin ||
        !Number.isSafeInteger(snapshot.seq) ||
        snapshot.seq <= offeredSeq ||
        !Number.isInteger(snapshot.elapsed_ms) ||
        snapshot.elapsed_ms < 0 ||
        snapshot.elapsed_ms > PLAYBACK_METRICS_MAX_ELAPSED_MS ||
        Object.values(totals).some(
          (v) =>
            !Number.isInteger(v) ||
            v < 0 ||
            v > PLAYBACK_METRICS_MAX_ELAPSED_MS,
        ) ||
        Object.values(totals).reduce((a, b) => a + b, 0) !==
          snapshot.elapsed_ms ||
        (snapshot.first_frame &&
          (!Number.isInteger(snapshot.first_frame.elapsed_ms) ||
            !Number.isInteger(snapshot.first_frame.confirmed_elapsed_ms) ||
            !["video_frame_callback", "playing_time_advance"].includes(
              snapshot.first_frame.evidence,
            ) ||
            snapshot.first_frame.elapsed_ms < 0 ||
            snapshot.first_frame.elapsed_ms >
              snapshot.first_frame.confirmed_elapsed_ms ||
            snapshot.first_frame.confirmed_elapsed_ms > snapshot.elapsed_ms))
      )
        return false;
      const phases = snapshot.startup_phases;
      const originGeneration = snapshot.first_frame_plan_generation;
      if (
        binding.version === 2 &&
        (!phases ||
          [phases.preparation_ms, phases.loading_ms, phases.unobserved_ms].some(
            (v) =>
              !Number.isInteger(v) ||
              v < 0 ||
              v > PLAYBACK_METRICS_MAX_ELAPSED_MS,
          ) ||
          phases.preparation_ms + phases.loading_ms + phases.unobserved_ms !==
            (snapshot.first_frame?.confirmed_elapsed_ms ??
              snapshot.elapsed_ms) ||
          !!snapshot.first_frame !== (originGeneration !== undefined) ||
          (originGeneration !== undefined &&
            (!Number.isInteger(originGeneration) ||
              originGeneration < binding.meterStartGeneration ||
              originGeneration > binding.planGeneration)))
      )
        return false;
      const fields = {
        media_generation: binding.mediaGeneration,
        plan_generation: binding.planGeneration,
        meter_start_generation: binding.meterStartGeneration,
        seq: snapshot.seq,
        startup_origin: snapshot.startup_origin,
        elapsed_ms: snapshot.elapsed_ms,
        totals: Object.freeze(totals),
        ...(snapshot.first_frame
          ? {
              first_frame: Object.freeze({
                elapsed_ms: snapshot.first_frame.elapsed_ms,
                confirmed_elapsed_ms: snapshot.first_frame.confirmed_elapsed_ms,
                evidence: snapshot.first_frame.evidence,
              }),
            }
          : {}),
        final: snapshot.final,
      };
      const body: PlaybackMetricsPacket =
        binding.version === 1
          ? Object.freeze({ version: 1, ...fields })
          : Object.freeze({
              version: 2,
              ...fields,
              startup_phases: Object.freeze({
                preparation_ms: phases.preparation_ms,
                loading_ms: phases.loading_ms,
                unobserved_ms: phases.unobserved_ms,
              }),
              ...(originGeneration === undefined
                ? {}
                : {
                    first_frame_plan_generation: originGeneration,
                  }),
            });
      if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 4096)
        return false;
      offeredSeq = snapshot.seq;
      pending = { binding, body };
      start();
      return true;
    },
    // A final POST starts before Stop, but cleanup never awaits it. Let an already
    // started final run to its fixed deadline; queued final coverage may be lost.
    unbind(preserveStartedFinal = false) {
      cancelBackoff?.();
      binding = undefined;
      pending = undefined;
      if (!(preserveStartedFinal && inFlight?.body.final)) request?.abort();
    },
    stop() {
      cancelBackoff?.();
      active = false;
      binding = undefined;
      pending = undefined;
      request?.abort();
    },
    get failure() {
      return failure;
    },
  };
}
