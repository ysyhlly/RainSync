import type {
  AudioCapabilityConfiguration,
  MediaCapabilityCandidate,
  MediaDecodingSupport,
  MediaTypeSupport,
  PlaybackCapabilities,
  VideoCapabilityConfiguration,
  PlaybackCandidateSet,
  PlaybackCandidateReport,
  PlaybackCandidateResult,
  PlaybackCandidate,
} from "../protocol";

type VideoProbe = Pick<HTMLVideoElement, "canPlayType">;
export type MediaSourceProbe = { isTypeSupported(type: string): boolean };
export type MediaCapabilitiesProbe = {
  decodingInfo(
    configuration: MediaDecodingConfiguration,
  ): Promise<
    Pick<MediaCapabilitiesInfo, "supported" | "smooth" | "powerEfficient">
  >;
};

export const H264_AAC_CONTENT_TYPE =
  'video/mp4; codecs="avc1.640028, mp4a.40.2"';

type Candidate = {
  content_type: string;
  video: VideoCapabilityConfiguration;
  audio: AudioCapabilityConfiguration;
};

function candidate(
  container: "mp4" | "webm",
  videoCodec: string,
  audioCodec: string,
  width = 1920,
  height = 1080,
  bitrate = 8_000_000,
): Candidate {
  return {
    content_type: `video/${container}; codecs="${videoCodec}, ${audioCodec}"`,
    video: {
      content_type: `video/${container}; codecs="${videoCodec}"`,
      width,
      height,
      bitrate,
      framerate: 30,
    },
    audio: {
      content_type: `audio/${container}; codecs="${audioCodec}"`,
      channels: "2",
      bitrate: 128_000,
      samplerate: 48_000,
    },
  };
}

// Finite representative samples, not a codec-family whitelist. Positive results
// do not establish support for higher levels, 10-bit, HDR, 4K or multichannel.
// Keep the existing High/Level-4 AVC sample first for v1 transport negotiation.
const CANDIDATES: readonly Candidate[] = [
  candidate("mp4", "avc1.640028", "mp4a.40.2"),
  candidate("mp4", "avc1.42E01E", "mp4a.40.2", 640, 360, 1_000_000),
  candidate("mp4", "hvc1.1.6.L120.B0", "mp4a.40.2"),
  candidate("webm", "vp09.00.40.08", "opus"),
  candidate("webm", "av01.0.08M.08", "opus"),
];

function canPlay(video: VideoProbe, contentType: string): MediaTypeSupport {
  try {
    const result = video.canPlayType(contentType);
    if (result === "probably" || result === "maybe") return result;
    return result === "" ? "unsupported" : "unknown";
  } catch {
    return "unknown";
  }
}

function mseSupport(
  mse: MediaSourceProbe | undefined,
  contentType: string,
): boolean | undefined {
  try {
    const result = mse?.isTypeSupported(contentType);
    return typeof result === "boolean" ? result : undefined;
  } catch {
    return undefined;
  }
}

function positive(result: MediaTypeSupport): boolean {
  return result === "maybe" || result === "probably";
}

/** Browser hints only. MIME support never establishes smooth/power-efficient playback. */
export function detectCapabilities(
  video: VideoProbe,
  mse?: MediaSourceProbe,
): PlaybackCapabilities {
  const candidates: MediaCapabilityCandidate[] = CANDIDATES.map((sample) => ({
    ...sample,
    video: { ...sample.video },
    audio: { ...sample.audio },
    progressive: canPlay(video, sample.content_type),
    mse_supported: mseSupport(mse, sample.content_type),
  }));
  return {
    progressive_h264_aac: positive(candidates[0].progressive),
    native_hls:
      positive(canPlay(video, "application/vnd.apple.mpegurl")) ||
      positive(canPlay(video, "application/x-mpegURL")),
    mse_h264_aac: candidates[0].mse_supported === true,
    report: { schema_version: 1, candidates },
  };
}

function configuration(
  sample: Pick<PlaybackCandidate, "video" | "audio">,
  type: "file" | "media-source",
): MediaDecodingConfiguration {
  const { content_type: videoType, ...video } = sample.video;
  return {
    type,
    video: { contentType: videoType, ...video },
    ...(sample.audio
      ? {
          audio: {
            contentType: sample.audio.content_type,
            channels: sample.audio.channels,
            bitrate: sample.audio.bitrate,
            samplerate: sample.audio.samplerate,
          },
        }
      : {}),
  };
}

async function decodingSupport(
  mediaCapabilities: MediaCapabilitiesProbe,
  config: MediaDecodingConfiguration,
): Promise<MediaDecodingSupport | undefined> {
  try {
    const result = await mediaCapabilities.decodingInfo(config);
    if (
      typeof result.supported !== "boolean" ||
      typeof result.smooth !== "boolean" ||
      typeof result.powerEfficient !== "boolean"
    )
      return undefined;
    return {
      supported: result.supported,
      smooth: result.smooth,
      power_efficient: result.powerEfficient,
    };
  } catch {
    // API absence, rejected configurations and browser restrictions are unknown.
    return undefined;
  }
}

/**
 * Optional, bounded estimates for the exact sample configurations. No DRM,
 * hardware identifiers or exhaustive device fingerprinting. These estimates
 * must not turn a single sample into a general codec-family allow/deny rule.
 */
export async function detectCapabilitiesAsync(
  video: VideoProbe,
  mse?: MediaSourceProbe,
  mediaCapabilities?: MediaCapabilitiesProbe,
): Promise<PlaybackCapabilities> {
  const caps = detectCapabilities(video, mse);
  if (!mediaCapabilities) return caps;
  const work = caps.report!.candidates.flatMap((sample) => {
    const probes: Promise<void>[] = [];
    if (positive(sample.progressive))
      probes.push(
        decodingSupport(mediaCapabilities, configuration(sample, "file")).then(
          (result) => {
            if (result) sample.file_decoding = result;
          },
        ),
      );
    if (sample.mse_supported === true)
      probes.push(
        decodingSupport(
          mediaCapabilities,
          configuration(sample, "media-source"),
        ).then((result) => {
          if (result) sample.mse_decoding = result;
        }),
      );
    return probes;
  });
  if (!work.length) return caps;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(work),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  // A timed-out browser promise cannot mutate an already submitted request,
  // including its idempotency payload, if it eventually settles.
  return structuredClone(caps);
}

/** Probe only finite server-issued configurations; echo the binding unchanged. */
export async function detectCandidateReport(
  video: VideoProbe,
  candidates: PlaybackCandidateSet,
  mse?: MediaSourceProbe,
  mediaCapabilities?: MediaCapabilitiesProbe,
): Promise<PlaybackCandidateReport | undefined> {
  if (
    candidates.schema_version !== 1 ||
    !candidates.binding ||
    !Array.isArray(candidates.candidates) ||
    !candidates.candidates.length
  )
    return undefined;
  if (candidates.candidates.length > 4) throw new Error("播放能力候选过多");
  const results: PlaybackCandidateResult[] = candidates.candidates.map(
    (sample) => ({
      candidate_id: sample.id,
      progressive: canPlay(video, sample.content_type),
      mse_supported: mseSupport(mse, sample.content_type),
    }),
  );
  if (mediaCapabilities) {
    const work = candidates.candidates.flatMap((sample, index) => {
      const result = results[index];
      const work: Promise<void>[] = [];
      if (positive(result.progressive))
        work.push(
          decodingSupport(
            mediaCapabilities,
            configuration(sample, "file"),
          ).then((value) => {
            if (value) result.file_decoding = value;
          }),
        );
      if (sample.transport === "hls" && result.mse_supported === true)
        work.push(
          decodingSupport(
            mediaCapabilities,
            configuration(sample, "media-source"),
          ).then((value) => {
            if (value) result.mse_decoding = value;
          }),
        );
      return work;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(work),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return structuredClone({
    binding: candidates.binding,
    results,
    excluded_candidates: [],
  });
}
