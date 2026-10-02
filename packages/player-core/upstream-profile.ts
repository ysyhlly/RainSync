import type {
  AudioCapabilityConfiguration,
  MediaDecodingSupport,
  UpstreamProfileCandidateSet,
  UpstreamProfileReport,
  UpstreamTranscodeProfileEnvelope,
} from "../protocol";
import type { MediaCapabilitiesProbe, MediaSourceProbe } from "./capabilities";

const PROFILE_ID = "avc_sdr_720p_v1";
const EMBY_PROFILE_ID = "emby_avc_sdr_720p_rates_v2";
const AUDIO_RATES = [44_100, 48_000] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const audioSample = (
  value: unknown,
  sampleRate: number,
): value is AudioCapabilityConfiguration =>
  object(value) &&
  keys(value, ["content_type", "channels", "bitrate", "samplerate"]) &&
  value.content_type === 'audio/mp4; codecs="mp4a.40.2"' &&
  value.channels === "2" &&
  value.bitrate === 128_000 &&
  value.samplerate === sampleRate;
const positiveDecoding = (value: unknown): value is MediaDecodingSupport =>
  object(value) &&
  keys(value, ["supported", "smooth", "power_efficient"]) &&
  value.supported === true &&
  typeof value.smooth === "boolean" &&
  typeof value.power_efficient === "boolean";

/** Requested bounds and advisory samples never establish measured output. */
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
      ...(value.profile_version === 2 && value.requested_audio !== null
        ? ["audio_rate_contract"]
        : []),
    ]) ||
    !(
      (value.profile_version === 1 && value.profile_id === PROFILE_ID) ||
      (value.profile_version === 2 && value.profile_id === EMBY_PROFILE_ID)
    ) ||
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
  if (!(
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
    audioSample(audio, 48_000)
  ))
    return false;
  if (value.profile_version === 1) return true;
  const contract = value.audio_rate_contract;
  if (!object(contract)) return false;
  const allowedRates = contract.allowed_sample_rates;
  const samples = contract.mse_samples;
  return (
    keys(contract, [
      "allowed_sample_rates",
      "source_sample_rate",
      "mse_samples",
    ]) &&
    Array.isArray(allowedRates) &&
    allowedRates.length === AUDIO_RATES.length &&
    AUDIO_RATES.every((rate, index) => allowedRates[index] === rate) &&
    AUDIO_RATES.some((rate) => contract.source_sample_rate === rate) &&
    Array.isArray(samples) &&
    samples.length === AUDIO_RATES.length &&
    AUDIO_RATES.every((rate, index) => audioSample(samples[index], rate))
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
  if (
    !object(report) ||
    !keys(report, [
      "profile_version",
      "binding",
      "profile_id",
      "mse_supported",
      "mse_decoding",
      ...(report.profile_version === 2 ? ["audio_rate_reports"] : []),
    ]) ||
    typeof report.binding !== "string" ||
    !report.binding.trim() ||
    report.mse_supported !== true ||
    !positiveDecoding(report.mse_decoding) ||
    !isUpstreamProfileEnvelope(profile) ||
    profile.profile_version !== report.profile_version ||
    profile.profile_id !== report.profile_id ||
    deliveryMode !== "transcode" ||
    transport !== "hls"
  )
    return false;
  if (report.profile_version === 1) return true;
  const rates = report.audio_rate_reports;
  if (!Array.isArray(rates)) return false;
  if (profile.requested_audio === null) return rates.length === 0;
  return (
    rates.length === AUDIO_RATES.length &&
    AUDIO_RATES.every((rate, index) => {
      const entry = rates[index];
      return (
        object(entry) &&
        keys(entry, ["sample_rate", "mse_supported", "mse_decoding"]) &&
        entry.sample_rate === rate &&
        entry.mse_supported === true &&
        positiveDecoding(entry.mse_decoding)
      );
    })
  );
}

/** Every allowed audio rate needs its own positive, full AV MSE estimate. */
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
    typeof candidates.binding !== "string" ||
    !candidates.binding.trim() ||
    typeof candidates.decision_reason !== "string" ||
    !isUpstreamProfileEnvelope(candidates.profile) ||
    candidates.profile_version !== candidates.profile.profile_version ||
    !mse ||
    !mediaCapabilities ||
    signal?.aborted
  )
    return;
  const profile = candidates.profile;
  const { video, audio } = profile.mse_sample;
  const samples = profile.audio_rate_contract?.mse_samples ?? [audio];
  const configurations: MediaDecodingConfiguration[] = [];
  try {
    for (const sample of samples) {
      if (
        mse.isTypeSupported(video.content_type) !== true ||
        (sample && mse.isTypeSupported(sample.content_type) !== true)
      )
        return;
      configurations.push({
        type: "media-source",
        video: {
          contentType: video.content_type,
          width: video.width,
          height: video.height,
          framerate: video.framerate,
          bitrate: video.bitrate,
        },
        ...(sample
          ? {
              audio: {
                contentType: sample.content_type,
                channels: sample.channels,
                samplerate: sample.samplerate,
                bitrate: sample.bitrate,
              },
            }
          : {}),
      });
    }
  } catch {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const startedAt = performance.now();
  try {
    // One bounded deadline covers the complete contract, including both rates.
    const results = await Promise.race([
      Promise.all(
        configurations.map((configuration) =>
          Promise.resolve()
            .then(() => mediaCapabilities.decodingInfo(configuration))
            .catch(() => undefined),
        ),
      ),
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
      !results ||
      results.some(
        (result) =>
          result?.supported !== true ||
          typeof result.smooth !== "boolean" ||
          typeof result.powerEfficient !== "boolean",
      )
    )
      return;
    const decoding = results.map((result) => ({
      supported: true,
      smooth: result!.smooth,
      power_efficient: result!.powerEfficient,
    }));
    // The top-level estimate keeps the original 48 kHz advisory meaning. The
    // complete v2 audio contract is admitted only through both rate reports.
    return {
      profile_version: profile.profile_version,
      binding: candidates.binding,
      profile_id: profile.profile_id,
      mse_supported: true,
      mse_decoding: decoding.at(-1)!,
      ...(profile.profile_version === 2
        ? {
            audio_rate_reports: audio
              ? AUDIO_RATES.map((sample_rate, index) => ({
                  sample_rate,
                  mse_supported: true,
                  mse_decoding: decoding[index],
                }))
              : [],
          }
        : {}),
    };
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
