import type {
  UpstreamProfileCandidateSet,
  UpstreamProfileReport,
  UpstreamTranscodeProfileEnvelope,
} from "../protocol";
import type { MediaCapabilitiesProbe, MediaSourceProbe } from "./capabilities";

const PROFILE_ID = "avc_sdr_720p_v1";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

/** This version describes requested bounds and an advisory sample, never output. */
export function isUpstreamProfileEnvelope(
  value: unknown,
): value is UpstreamTranscodeProfileEnvelope {
  if (
    !object(value) ||
    !keys(value, [
      "profile_version",
      "profile_id",
      "configuration_semantics",
      "transport",
      "container",
      "requested_video",
      "requested_audio",
      "mse_sample",
    ]) ||
    value.profile_version !== 1 ||
    value.profile_id !== PROFILE_ID ||
    value.configuration_semantics !== "upstream_transcode_profile_envelope" ||
    value.transport !== "hls" ||
    value.container !== "ts" ||
    !object(value.requested_video) ||
    !object(value.mse_sample) ||
    !object(value.mse_sample.video) ||
    !keys(value.mse_sample, ["video", "audio"])
  )
    return false;
  const requested = value.requested_video;
  const video = value.mse_sample.video;
  if (
    !keys(requested, [
      "codec",
      "profile",
      "max_level",
      "max_width",
      "max_height",
      "max_framerate",
      "max_bitrate",
      "requested_bit_depth",
      "requested_range",
    ]) ||
    !keys(video, ["content_type", "width", "height", "framerate", "bitrate"]) ||
    requested.codec !== "h264" ||
    requested.profile !== "main" ||
    requested.max_level !== "3.1" ||
    requested.max_width !== 1280 ||
    requested.max_height !== 720 ||
    requested.max_framerate !== 30 ||
    requested.max_bitrate !== 4_000_000 ||
    requested.requested_bit_depth !== 8 ||
    requested.requested_range !== "SDR" ||
    video.content_type !== 'video/mp4; codecs="avc1.4d001f"' ||
    video.width !== 1280 ||
    video.height !== 720 ||
    video.framerate !== 30 ||
    video.bitrate !== 4_000_000
  )
    return false;
  // Explicit null is known no audio. Missing or conflicting audio is unknown.
  if (value.requested_audio === null) return value.mse_sample.audio === null;
  const audio = value.mse_sample.audio;
  const requestedAudio = value.requested_audio;
  return (
    object(requestedAudio) &&
    keys(requestedAudio, [
      "codec",
      "max_channels",
      "requested_sample_rate",
      "max_bitrate",
    ]) &&
    requestedAudio.codec === "aac" &&
    requestedAudio.max_channels === 2 &&
    requestedAudio.requested_sample_rate === 48_000 &&
    requestedAudio.max_bitrate === 128_000 &&
    object(audio) &&
    keys(audio, ["content_type", "channels", "bitrate", "samplerate"]) &&
    audio.content_type === 'audio/mp4; codecs="mp4a.40.2"' &&
    audio.channels === "2" &&
    audio.bitrate === 128_000 &&
    audio.samplerate === requestedAudio.requested_sample_rate
  );
}

/** A dedicated request must receive the same versioned server recipe. */
export function matchesUpstreamProfilePlan(
  report: UpstreamProfileReport | undefined,
  profile: unknown,
  deliveryMode: string,
  transport: string,
): boolean {
  if (!report) return profile === undefined;
  return (
    report.profile_version === 1 &&
    report.profile_id === PROFILE_ID &&
    report.mse_supported === true &&
    report.mse_decoding?.supported === true &&
    isUpstreamProfileEnvelope(profile) &&
    profile.profile_version === report.profile_version &&
    profile.profile_id === report.profile_id &&
    deliveryMode === "transcode" &&
    transport === "hls"
  );
}

/** Probe only the envelope's MSE sample; native/file results cannot replace it. */
export async function detectUpstreamProfileReport(
  candidates: UpstreamProfileCandidateSet,
  mse?: MediaSourceProbe,
  mediaCapabilities?: MediaCapabilitiesProbe,
  signal?: AbortSignal,
): Promise<UpstreamProfileReport | undefined> {
  if (
    !object(candidates) ||
    !keys(candidates, [
      "profile_version",
      "binding",
      "profile",
      "decision_reason",
    ]) ||
    candidates.profile_version !== 1 ||
    typeof candidates.binding !== "string" ||
    !candidates.binding.trim() ||
    !isUpstreamProfileEnvelope(candidates.profile) ||
    !mse ||
    !mediaCapabilities ||
    signal?.aborted
  )
    return;
  const { video, audio } = candidates.profile.mse_sample;
  try {
    if (
      mse.isTypeSupported(video.content_type) !== true ||
      (audio && mse.isTypeSupported(audio.content_type) !== true)
    )
      return;
  } catch {
    return;
  }
  const configuration: MediaDecodingConfiguration = {
    type: "media-source",
    video: {
      contentType: video.content_type,
      width: video.width,
      height: video.height,
      framerate: video.framerate,
      bitrate: video.bitrate,
    },
    ...(audio
      ? {
          audio: {
            contentType: audio.content_type,
            channels: audio.channels,
            samplerate: audio.samplerate,
            bitrate: audio.bitrate,
          },
        }
      : {}),
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const startedAt = performance.now();
  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(() => mediaCapabilities.decodingInfo(configuration))
        .catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 500);
        abort = () => resolve(undefined);
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
    const elapsed = performance.now() - startedAt;
    if (
      signal?.aborted ||
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      elapsed > 500 ||
      result?.supported !== true ||
      typeof result.smooth !== "boolean" ||
      typeof result.powerEfficient !== "boolean"
    )
      return;
    // Nothing mutates this evidence after a timeout, cancellation or late result.
    return {
      profile_version: 1,
      binding: candidates.binding,
      profile_id: candidates.profile.profile_id,
      mse_supported: true,
      mse_decoding: {
        supported: true,
        smooth: result.smooth,
        power_efficient: result.powerEfficient,
      },
    };
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
