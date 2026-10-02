import type { PlaybackPlan } from "../../../../../packages/protocol";
import { isUpstreamProfileEnvelope } from "../../../../../packages/player-core";

export type PlaybackSummary = { mode: string; reason?: string };

/** Explain only the received plan's facts; unknown internal strings stay hidden. */
export function summarizePlaybackPlan(
  plan: Pick<
    PlaybackPlan,
    | "delivery_mode"
    | "decision_reason"
    | "selected_candidate_id"
    | "upstream_profile"
  >,
): PlaybackSummary | undefined {
  const modes: Record<string, string> = {
    direct: "直接播放",
    remux: "转封装",
    transcode: "兼容转码",
  };
  const mode = Object.hasOwn(modes, plan.delivery_mode)
    ? modes[plan.delivery_mode]
    : undefined;
  if (!mode) return;
  const summary: PlaybackSummary = { mode };
  if (
    plan.delivery_mode === "transcode" &&
    isUpstreamProfileEnvelope(plan.upstream_profile)
  ) {
    summary.reason =
      "请求上游转码：最高720p SDR，H.264" +
      (plan.upstream_profile.requested_audio ? " / AAC" : "") +
      "；设备兼容性为估计";
    return summary;
  }
  if (
    plan.selected_candidate_id &&
    plan.decision_reason === `actual_media_${plan.selected_candidate_id}`
  ) {
    summary.reason = "根据当前文件和设备能力报告选择";
    return summary;
  }
  const provider = /^(jellyfin|emby)_negotiated_(direct|remux|transcode)$/.exec(
    plan.decision_reason ?? "",
  );
  if (provider && provider[2] === plan.delivery_mode) {
    summary.reason = `由 ${provider[1] === "jellyfin" ? "Jellyfin" : "Emby"} 返回的播放方案确定`;
    return summary;
  }
  const local =
    /^(local|http|agent)_(automatic|requested)_(direct|remux|transcode)_(authorized_probe|source_version_matched_metadata|legacy_transport_policy)$/.exec(
      plan.decision_reason ?? "",
    );
  if (local && local[3] === plan.delivery_mode) {
    summary.reason = {
      authorized_probe: "根据当前片源的探测信息选择",
      source_version_matched_metadata: "根据已核对版本的片源信息选择",
      legacy_transport_policy: "当前文件能力尚未确认，按基础兼容规则选择",
    }[local[4]];
  }
  return summary;
}
