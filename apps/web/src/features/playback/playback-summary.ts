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
    | "selected_output"
  >,
): PlaybackSummary | undefined {
  const modes: Record<string, string> = {
    direct: "直接播放",
    remux: "转封装",
    audio_transcode: "仅音频转码",
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
      (plan.upstream_profile.requested_audio
        ? plan.upstream_profile.profile_version === 2
          ? " / AAC（44.1或48 kHz）"
          : " / AAC"
        : "") +
      "；设备兼容性为估计";
    return summary;
  }
  if (
    plan.selected_candidate_id &&
    plan.decision_reason === `actual_media_${plan.selected_candidate_id}`
  ) {
    summary.reason = "根据当前文件和设备能力报告选择";
    const output = plan.selected_output;
    const configuration = output?.configuration;
    if (
      configuration?.id === plan.selected_candidate_id &&
      configuration.delivery_mode === plan.delivery_mode &&
      (output?.video_basis === "source_probe" ||
        output?.video_basis === "constrained_encoder_recipe") &&
      Number.isInteger(configuration.video.width) &&
      configuration.video.width > 0 &&
      configuration.video.width <= 16384 &&
      Number.isInteger(configuration.video.height) &&
      configuration.video.height > 0 &&
      configuration.video.height <= 16384 &&
      Number.isFinite(configuration.video.framerate) &&
      configuration.video.framerate > 0 &&
      configuration.video.framerate <= 1000
    ) {
      const video = configuration.video;
      const codec = /^video\/mp4; codecs="avc1\.[0-9A-F]{6}"$/i.test(
        video.content_type,
      )
        ? "H.264"
        : /^video\/mp4; codecs="(?:hvc1|hev1)\.[0-9A-F.]+\.[LH][0-9]+(?:\.[0-9A-F]{2})*"$/i.test(
              video.content_type,
            )
          ? "HEVC"
          : undefined;
      if (codec) {
        const basis =
          output.video_basis === "source_probe"
            ? "片源视频配置"
            : "视频编码目标";
        const audio = configuration.audio;
        let audioText = "";
        if (audio === null && output.audio_basis === null)
          audioText = "，无音轨";
        else if (
          audio?.content_type === 'audio/mp4; codecs="mp4a.40.2"' &&
          /^(?:[1-6]|8)$/.test(audio.channels) &&
          (output.audio_basis === "source_probe" ||
            output.audio_basis === "constrained_encoder_recipe")
        ) {
          audioText = `，${output.audio_basis === "constrained_encoder_recipe" ? "音频编码目标 " : "音频配置 "}AAC ${audio.channels} 声道`;
        }
        summary.reason = `${basis}：${codec} ${video.width}×${video.height} / ${Number(video.framerate.toFixed(2))} fps${audioText}；设备兼容性为估计`;
      }
    }
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
    /^(local|http|agent)_(automatic|requested)_(direct|remux|audio_transcode|transcode)_(authorized_probe|source_version_matched_metadata|legacy_transport_policy)$/.exec(
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
