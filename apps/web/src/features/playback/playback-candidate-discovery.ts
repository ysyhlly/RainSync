import { freezeCandidateSnapshot } from "./playback-runtime-utils";
import {
  getPlaybackMediaSource,
  hasPlaybackMseApi,
  supportsHlsPlayback,
} from "./browser-mse";
import { validAdvancedPlaybackCapabilities } from "./advanced-playback-intent";
import { validLocalHlsLadderCapabilities } from "./local-hls-ladder-intent";
import {
  detectCapabilities,
  detectCapabilitiesAsync,
  detectCandidateReport,
  detectUpstreamProfileReport,
  isUpstreamProfileEnvelope,
} from "../../../../../packages/player-core";
import { target } from "../../../../../packages/sync-engine";
import type {
  PlaybackCandidateSet,
  UpstreamProfileCandidateSet,
} from "../../../../../packages/protocol";
import { RequestFailure } from "../../errors";
import { PlaybackCancelled } from "../../playback-request";
import { staticHlsAvailability as parseStaticHlsAvailability } from "./static-hls-availability";
import type { Ref } from "vue";
import type {
  AdvancedPlaybackCapabilities,
  LocalHlsLadderCapabilities,
} from "../../../../../packages/protocol";
import type {
  PlaybackRuntimeContext,
  MetricIntent,
  CandidateDiscovery,
} from "./playback-runtime-types";
import type { StaticHlsAvailability } from "./static-hls-availability";
export interface CandidateDiscoveryPorts {
  context: PlaybackRuntimeContext;
  session: PlaybackRuntimeContext["session"];
  state: PlaybackRuntimeContext["state"];
  clock: PlaybackRuntimeContext["clock"];
  video: Ref<HTMLVideoElement | undefined>;
  current: (intent: MetricIntent) => boolean;
  advancedCapabilities: Ref<AdvancedPlaybackCapabilities | undefined>;
  ladderCapabilities: Ref<LocalHlsLadderCapabilities | undefined>;
  staticHlsAvailability: Ref<StaticHlsAvailability | undefined>;
  candidateError: string;
  probe: () => AbortController | undefined;
  setProbe: (probe: AbortController | undefined) => void;
}
export function discoverPlaybackCandidates(
  ports: CandidateDiscoveryPorts,
  metrics: MetricIntent,
  element: HTMLVideoElement,
): Promise<CandidateDiscovery> {
  const {
    session,
    state,
    video,
    clock,
    context: ctx,
    current: candidateIntentCurrent,
    advancedCapabilities,
    ladderCapabilities,
    staticHlsAvailability,
    candidateError,
  } = ports;
  if (metrics.concreteCandidates)
    return Promise.resolve(metrics.concreteCandidates);
  if (metrics.candidateDiscovery) return metrics.candidateDiscovery.result;
  const probe = new AbortController();
  ports.setProbe(probe);
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
            ...(metrics.mode === "direct" || metrics.advanced || metrics.ladder
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
        if (!validAdvancedPlaybackCapabilities(candidateSet.advanced_playback))
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
        candidateSet = freezeCandidateSnapshot(structuredClone(candidateSet!));
      }
      if ((metrics.advanced || metrics.ladder) && !concrete)
        throw new Error(candidateError);
      const profileDiscovery =
        !metrics.advanced &&
        !metrics.ladder &&
        metrics.mode === "transcode" &&
        !concrete;
      let mseProbe: ReturnType<typeof getPlaybackMediaSource>;
      let decoder: MediaCapabilities | undefined;
      if (profileDiscovery) {
        // API availability opts into the new envelope; it is not sample
        // evidence. An unavailable/unreadable API keeps legacy negotiation.
        try {
          mseProbe = hasPlaybackMseApi() ? getPlaybackMediaSource() : undefined;
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
          if (typeof decoder?.decodingInfo !== "function") decoder = undefined;
        } catch {
          decoder = undefined;
        }
      } else {
        mseProbe = supportsHlsPlayback() ? getPlaybackMediaSource() : undefined;
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
        ? await detectCandidateReport(element, candidateSet, mseProbe, decoder)
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
      if (ports.probe() === probe) ports.setProbe(undefined);
    }
  })();
  return discovery.result;
}
