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
  RoomTimelinePort,
  PlaybackIntent,
  CandidateDiscovery,
} from "./playback-runtime-types";
import type { StaticHlsAvailability } from "./static-hls-availability";
export interface CandidateDiscoveryPorts {
  staticHlsFallback?: boolean;
  api: PlaybackRuntimeContext["api"];
  state: RoomTimelinePort["state"];
  clock: RoomTimelinePort["clock"];
  video: Ref<HTMLVideoElement | undefined>;
  current: (intent: PlaybackIntent) => boolean;
  advancedCapabilities: Ref<AdvancedPlaybackCapabilities | undefined>;
  ladderCapabilities: Ref<LocalHlsLadderCapabilities | undefined>;
  staticHlsAvailability: Ref<StaticHlsAvailability | undefined>;
  candidateError: string;
  probe: () => AbortController | undefined;
  setProbe: (probe: AbortController | undefined) => void;
}
export function discoverPlaybackCandidates(
  ports: CandidateDiscoveryPorts,
  playbackIntent: PlaybackIntent,
  element: HTMLVideoElement,
): Promise<CandidateDiscovery> {
  const {
    api,
    state,
    video,
    clock,
    staticHlsFallback,
    current: candidateIntentCurrent,
    advancedCapabilities,
    ladderCapabilities,
    staticHlsAvailability,
    candidateError,
  } = ports;
  if (playbackIntent.concreteCandidates)
    return Promise.resolve(playbackIntent.concreteCandidates);
  if (playbackIntent.candidateDiscovery) return playbackIntent.candidateDiscovery.result;
  const probe = new AbortController();
  ports.setProbe(probe);
  const discovery = {
    probe,
    result: undefined as unknown as Promise<CandidateDiscovery>,
  };
  playbackIntent.candidateDiscovery = discovery;
  discovery.result = (async () => {
    let marked = false,
      concrete = false,
      upstreamAttempted = false;
    try {
      const startedAt = performance.now();
      let candidateSet: PlaybackCandidateSet | undefined;
      try {
        candidateSet = await api<PlaybackCandidateSet>(
          "/playback-candidates",
          "POST",
          {
            room_id: playbackIntent.room,
            media_generation: playbackIntent.media,
            advanced_playback_capabilities_version: 1,
            local_hls_ladder_capabilities_version: 1,
            audio_index: playbackIntent.audio ?? null,
            position_ms: target(state.value!, clock.now()),
            ...(playbackIntent.ladder ? { local_hls_ladder: playbackIntent.ladder } : {}),
            ...(playbackIntent.advanced
              ? { advanced_playback: playbackIntent.advanced }
              : {}),
            ...(playbackIntent.mode === "direct" || playbackIntent.advanced || playbackIntent.ladder
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
        candidateIntentCurrent(playbackIntent) &&
        playbackIntent.candidateDiscovery === discovery &&
        !probe.signal.aborted &&
        video.value === element;
      if (!current()) throw new PlaybackCancelled();
      let staticHls: CandidateDiscovery["staticHls"];
      if (
        staticHlsFallback === true &&
        !playbackIntent.advanced &&
        !playbackIntent.ladder &&
        ["auto", "direct"].includes(playbackIntent.mode)
      ) {
        let response: unknown;
        try {
          response = await api(
            "/playback-static-hls-capabilities",
            "POST",
            {
              version: 1,
              room_id: playbackIntent.room,
              media_generation: playbackIntent.media,
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
      } else if (playbackIntent.advanced) throw new Error(candidateError);
      if (candidateSet?.local_hls_ladder !== undefined) {
        if (!validLocalHlsLadderCapabilities(candidateSet.local_hls_ladder))
          throw new Error(candidateError);
        ladderCapabilities.value = freezeCandidateSnapshot(
          structuredClone(candidateSet.local_hls_ladder),
        );
      } else if (playbackIntent.ladder) throw new Error(candidateError);
      marked = candidateSet?.http_file_capabilities_version !== undefined;
      if (marked) {
        if (
          playbackIntent.mode === "direct" ||
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
      if ((playbackIntent.advanced || playbackIntent.ladder) && !concrete)
        throw new Error(candidateError);
      const profileDiscovery =
        !playbackIntent.advanced &&
        !playbackIntent.ladder &&
        playbackIntent.mode === "transcode" &&
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
          upstreamSet = await api<UpstreamProfileCandidateSet>(
            "/upstream-profile-candidates",
            "POST",
            {
              // Discovery advertises our maximum supported profile version.
              profile_version: 2,
              room_id: playbackIntent.room,
              media_generation: playbackIntent.media,
              audio_index: playbackIntent.audio ?? null,
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
            playbackIntent.concreteCandidates = freezeCandidateSnapshot(
              structuredClone(result),
            );
            return playbackIntent.concreteCandidates;
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
        playbackIntent.concreteCandidates = freezeCandidateSnapshot(
          structuredClone(result),
        );
        return playbackIntent.concreteCandidates;
      }
      return result;
    } finally {
      // Empty/old-server negotiation keeps its legacy discovery behavior.
      // Concrete report and marked validation failures stay rejected for this
      // intent; recovery cannot downgrade or discover a replacement source.
      if (
        playbackIntent.candidateDiscovery === discovery &&
        !marked &&
        !concrete &&
        !upstreamAttempted
      )
        playbackIntent.candidateDiscovery = undefined;
      if (ports.probe() === probe) ports.setProbe(undefined);
    }
  })();
  return discovery.result;
}
