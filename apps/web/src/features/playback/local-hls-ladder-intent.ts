import type {
  LocalHlsLadderRequest,
  LocalHlsLadderCapabilities,
  LocalHlsRendition,
  PlaybackPlan,
} from "../../../../../packages/protocol";
const ids = ["low", "medium", "high"];
const limits = [
  [640, 360, 1000000],
  [1280, 720, 3000000],
  [1920, 1080, 6000000],
];
export function validLocalHlsRenditions(
  value: unknown,
): value is LocalHlsRendition[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3)
    return false;
  let previous = -1,
    area = 0;
  return value.every((r) => {
    if (!r || typeof r !== "object") return false;
    const index = ids.indexOf(r.id),
      box = limits[index];
    if (
      index <= previous ||
      !box ||
      !Number.isInteger(r.width) ||
      !Number.isInteger(r.height) ||
      r.width < 2 ||
      r.height < 2 ||
      r.width % 2 ||
      r.height % 2 ||
      r.width > box[0]! ||
      r.height > box[1]! ||
      r.width * r.height <= area
    )
      return false;
    const avc = index === 2 ? "avc1.640028" : "avc1.64001F";
    const audio = r.codecs === `${avc},mp4a.40.2`;
    if (r.codecs !== avc && !audio) return false;
    if (r.bandwidth !== ((box[2]! + (audio ? 128000 : 0)) * 5) / 4)
      return false;
    previous = index;
    area = r.width * r.height;
    return true;
  });
}
export function validLocalHlsLadderCapabilities(
  value: unknown,
): value is LocalHlsLadderCapabilities {
  if (!value || typeof value !== "object") return false;
  const caps = value as LocalHlsLadderCapabilities;
  return (
    caps.schema_version === 1 &&
    caps.worker_runtime_required === true &&
    Array.isArray(caps.renditions) &&
    (caps.renditions.length === 0 || validLocalHlsRenditions(caps.renditions))
  );
}
export function localHlsLadderRequest(
  enabled: boolean,
  caps: LocalHlsLadderCapabilities | undefined,
  advanced: boolean,
): LocalHlsLadderRequest | undefined {
  if (!enabled) return;
  // Advanced composition is admitted through the same explicit, closed intent.
  // The sealed capability report must describe these exact combined rungs.
  void advanced;
  if (
    !validLocalHlsLadderCapabilities(caps) ||
    !validLocalHlsRenditions(caps.renditions)
  )
    throw new Error("当前本地片源不支持多清晰度 HLS，请重新加载片源信息");
  return Object.freeze({ schema_version: 1 });
}
export function sameLocalHlsLadderRequest(
  first: LocalHlsLadderRequest | undefined,
  second: LocalHlsLadderRequest | undefined,
): boolean {
  return first === undefined
    ? second === undefined
    : second?.schema_version === 1 && first.schema_version === 1;
}
export function matchesLocalHlsLadderPlan(
  request: LocalHlsLadderRequest | undefined,
  plan: PlaybackPlan,
  origin: string,
  caps?: LocalHlsLadderCapabilities,
): boolean {
  if (!request) return plan.local_hls_ladder === undefined;
  const facts = plan.local_hls_ladder;
  if (
    !facts ||
    !sameLocalHlsLadderRequest(request, facts.request) ||
    !validLocalHlsRenditions(facts.renditions) ||
    facts.video_basis !== "constrained_encoder_recipe" ||
    plan.transport !== "hls" ||
    plan.delivery_mode !== "transcode" ||
    !plan.rebuild_on_seek ||
    plan.native_platform ||
    !plan.plan_generation
  )
    return false;
  if (
    !validLocalHlsLadderCapabilities(caps) ||
    caps.renditions.length !== facts.renditions.length ||
    !caps.renditions.every((r, i) => {
      const f = facts.renditions[i];
      return (
        !!f &&
        r.id === f.id &&
        r.width === f.width &&
        r.height === f.height &&
        r.bandwidth === f.bandwidth &&
        r.codecs === f.codecs
      );
    })
  )
    return false;
  try {
    const url = new URL(plan.playback_url, origin);
    return (
      url.origin === origin &&
      url.pathname ===
        `/media-delivery/${plan.session_id}/ladder/master.m3u8` &&
      !url.hash &&
      url.searchParams.size === 1 &&
      !!url.searchParams.get("token")
    );
  } catch {
    return false;
  }
}
export type LadderLevel = {
  width: number;
  height: number;
  bitrate: number;
  videoCodec?: string;
  audioCodec?: string;
  url: string[];
};
/** Bind actual SDK level indices to the authorized master, never list order. */
export function bindLocalHlsLevels(
  plan: PlaybackPlan,
  levels: readonly LadderLevel[],
  origin: string,
): Map<string, number> | undefined {
  const local=plan.local_hls_ladder;
  const native=plan.native_platform?.compatibility;
  const facts=local ?? (native?.mode === "hls_avc_aac_ladder" && native.output?.renditions
    ? {renditions:native.output.renditions} : undefined);
  if (
    !facts ||
    !validLocalHlsRenditions(facts.renditions) ||
    levels.length !== facts.renditions.length
  )
    return;
  const result = new Map<string, number>();
  try {
    const master = new URL(plan.playback_url, origin);
    let boundAttempt: string | undefined;
    for (const [index, level] of levels.entries()) {
      const r = facts.renditions.find(
        (r) =>
          r.width === level.width &&
          r.height === level.height &&
          r.bandwidth === level.bitrate &&
          r.codecs ===
            [level.videoCodec, level.audioCodec].filter(Boolean).join(","),
      );
      if (!r || result.has(r.id) || level.url.length !== 1) return;
      const url = new URL(level.url[0]!, master);
      if (
        url.origin !== master.origin ||
        url.pathname !==
          (local ? `/media-delivery/${plan.session_id}/ladder/${r.id}/index.m3u8`
            : `/api/v1/platform-delivery/${plan.session_id}/compatibility/${r.id}/index.m3u8`) ||
        url.searchParams.size !== 2 ||
        url.searchParams.get("token") !== master.searchParams.get("token") ||
        !/^[1-9][0-9]{0,18}$/.test(url.searchParams.get("attempt") ?? "") ||
        BigInt(url.searchParams.get("attempt") ?? "0") > 9223372036854775807n ||
        (boundAttempt !== undefined &&
          url.searchParams.get("attempt") !== boundAttempt) ||
        (!local && url.searchParams.get("attempt") !== String(native?.output?.attempt)) ||
        url.hash
      )
        return;
      boundAttempt = url.searchParams.get("attempt")!;
      result.set(r.id, index);
    }
    return result;
  } catch {
    return;
  }
}

/** True only when a bound public plan names multiple qualified output rungs. */
export function hasHlsLadder(plan: PlaybackPlan): boolean {
  return validLocalHlsRenditions(plan.local_hls_ladder?.renditions) ||
    (plan.native_platform?.compatibility?.mode === "hls_avc_aac_ladder" &&
     validLocalHlsRenditions(plan.native_platform.compatibility.output?.renditions));
}
