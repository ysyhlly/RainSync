import type {
  PlaybackPlan,
  UpstreamMeasuredOutput,
} from "../../../../../packages/protocol";

const MAX_BYTES = 16 * 1024 * 1024;
const exactKeys = (value: unknown, fields: readonly string[]): boolean =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  Object.keys(value).every((key) => fields.includes(key));
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Facts only describe the finite decoded response window on this exact grant. */
export function validateUpstreamOutput(
  value: unknown,
  plan: PlaybackPlan,
): UpstreamMeasuredOutput | undefined {
  if (!value || typeof value !== "object" || !plan.upstream_profile) return;
  const facts = value as UpstreamMeasuredOutput;
  const video = facts.video;
  const audio = facts.audio;
  if (
    !exactKeys(facts, [
      "schema_version",
      "semantics",
      "session_id",
      "plan_generation",
      "upstream_sid_sha256",
      "route_sha256",
      "representation_sha256",
      "measured_bytes",
      "measured_segments",
      "manifest_duration_ms",
      "video",
      "audio",
      "process_tree_reaped",
    ]) ||
    !exactKeys(video, [
      "codec",
      "profile",
      "width",
      "height",
      "pixel_format",
      "frame_rate",
      "decoded_frames",
    ]) ||
    (audio !== null &&
      !exactKeys(audio, [
        "codec",
        "profile",
        "sample_rate",
        "channels",
        "decoded_frames",
      ])) ||
    facts.schema_version !== 1 ||
    facts.semantics !== "finite_same_sid_output_not_whole_title" ||
    facts.session_id !== plan.session_id ||
    facts.plan_generation !== (plan.plan_generation ?? null) ||
    !hash(facts.upstream_sid_sha256) ||
    !hash(facts.route_sha256) ||
    !hash(facts.representation_sha256) ||
    !Number.isInteger(facts.measured_bytes) ||
    facts.measured_bytes < 1 ||
    facts.measured_bytes > MAX_BYTES ||
    !Number.isInteger(facts.measured_segments) ||
    facts.measured_segments < 1 ||
    facts.measured_segments > 3 ||
    !Number.isFinite(facts.manifest_duration_ms) ||
    facts.manifest_duration_ms <= 0 ||
    facts.manifest_duration_ms > 24000 ||
    facts.process_tree_reaped !== true ||
    !video ||
    video.codec !== "h264" ||
    !["Baseline", "Constrained Baseline", "Main", "High"].includes(
      video.profile,
    ) ||
    !["yuv420p", "yuvj420p"].includes(video.pixel_format) ||
    !Number.isInteger(video.width) ||
    video.width < 1 ||
    video.width > 1920 ||
    !Number.isInteger(video.height) ||
    video.height < 1 ||
    video.height > 1080 ||
    !Number.isFinite(video.frame_rate) ||
    video.frame_rate <= 0 ||
    video.frame_rate > 60 ||
    !Number.isInteger(video.decoded_frames) ||
    video.decoded_frames < 1 ||
    video.decoded_frames > 1440 ||
    (audio !== null &&
      (!audio ||
        audio.codec !== "aac" ||
        audio.profile !== "LC" ||
        ![44100, 48000].includes(audio.sample_rate) ||
        !Number.isInteger(audio.channels) ||
        audio.channels < 1 ||
        audio.channels > 2 ||
        !Number.isInteger(audio.decoded_frames) ||
        audio.decoded_frames < 1 ||
        audio.decoded_frames > 2300))
  )
    return;
  return structuredClone(facts);
}

/** Compares only observed codec/profile/dimensions/fps and audio fields.
 * Level, color and bitrate remain unmeasured; this is never whole-profile proof. */
export function upstreamOutputMatchesMeasuredBounds(
  facts: UpstreamMeasuredOutput,
  plan: PlaybackPlan,
): boolean {
  const profile = plan.upstream_profile;
  if (
    !profile ||
    facts.session_id !== plan.session_id ||
    facts.plan_generation !== (plan.plan_generation ?? null)
  )
    return false;
  if (
    facts.video.codec.toLowerCase() !==
      profile.requested_video.codec.toLowerCase() ||
    facts.video.profile.toLowerCase() !==
      profile.requested_video.profile.toLowerCase() ||
    (facts.audio &&
      facts.audio.codec.toLowerCase() !==
        profile.requested_audio?.codec.toLowerCase())
  )
    return false;
  if (
    facts.video.width > profile.requested_video.max_width ||
    facts.video.height > profile.requested_video.max_height ||
    facts.video.frame_rate > profile.requested_video.max_framerate + 0.01
  )
    return false;
  if ((facts.audio === null) !== (profile.requested_audio === null))
    return false;
  return (
    !facts.audio ||
    (!!profile.requested_audio &&
      facts.audio.channels <= profile.requested_audio.max_channels &&
      (
        profile.audio_rate_contract?.allowed_sample_rates ?? [
          profile.requested_audio.requested_sample_rate,
        ]
      ).includes(facts.audio.sample_rate))
  );
}

export function upstreamOutputUrl(
  plan: PlaybackPlan,
  origin: string,
): string | undefined {
  if (
    !plan.upstream_profile ||
    plan.transport !== "hls" ||
    plan.delivery_mode !== "transcode"
  )
    return;
  const url = new URL(plan.playback_url, origin);
  if (
    url.origin !== new URL(origin).origin ||
    url.pathname !== `/media-delivery/${plan.session_id}/index.m3u8` ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== "token") ||
    url.searchParams.getAll("token").length !== 1 ||
    !url.searchParams.get("token")
  )
    return;
  url.pathname = `/media-delivery/${plan.session_id}/upstream-output`;
  return url.href;
}

/** This budget belongs to the original grant, not an SDK attachment/callback. */
export class SameSidDecoderRecovery {
  private readonly frozen: Readonly<{
    session: string;
    generation: number | undefined;
    url: string;
  }>;
  private attempts = 0;
  private networkAttempts = 0;
  private nextNetworkAt = 0;
  private readonly networkUntil: number;
  private readonly networkWallUntil: number;
  private retired = false;
  constructor(plan: PlaybackPlan) {
    const lifetime =
      Number.isFinite(plan.expires_in_seconds) &&
      plan.expires_in_seconds > 0 &&
      plan.expires_in_seconds <= 1800
        ? plan.expires_in_seconds * 1000
        : 0;
    this.networkUntil = performance.now() + lifetime;
    this.networkWallUntil = Date.now() + lifetime;
    this.frozen = Object.freeze({
      session: plan.session_id,
      generation: plan.plan_generation,
      url: plan.playback_url,
    });
  }
  recover(input: {
    plan: PlaybackPlan;
    current: boolean;
    fatal: boolean;
    type: string;
    recoverMediaError: () => void;
  }): boolean {
    const { plan } = input;
    if (
      this.retired ||
      !input.current ||
      !input.fatal ||
      input.type !== "mediaError" ||
      this.attempts >= 2 ||
      !plan.upstream_profile ||
      plan.transport !== "hls" ||
      plan.delivery_mode !== "transcode" ||
      plan.session_id !== this.frozen.session ||
      plan.plan_generation !== this.frozen.generation ||
      plan.playback_url !== this.frozen.url
    )
      return false;
    // Spend before invoking the SDK: throws and re-entrant callbacks do not
    // regenerate budget. No PlaybackInfo, preparation or URL mutation occurs.
    this.attempts++;
    try {
      input.recoverMediaError();
    } catch {
      return false;
    }
    return true;
  }
  recoverNetwork(input: {
    plan: PlaybackPlan;
    current: boolean;
    fatal: boolean;
    type: string;
    details: string;
    status: number | undefined;
    startLoad: () => void;
  }): boolean {
    const { plan } = input;
    const now = performance.now();
    if (
      this.retired ||
      !input.current ||
      !input.fatal ||
      input.type !== "networkError" ||
      this.networkAttempts >= 2 ||
      now < this.nextNetworkAt ||
      now >= this.networkUntil ||
      Date.now() >= this.networkWallUntil ||
      ![408, 429, 500, 502, 503, 504].includes(input.status ?? 0) ||
      !["manifestLoadError", "levelLoadError", "fragLoadError"].includes(
        input.details,
      ) ||
      !plan.upstream_profile ||
      plan.transport !== "hls" ||
      plan.delivery_mode !== "transcode" ||
      plan.session_id !== this.frozen.session ||
      plan.plan_generation !== this.frozen.generation ||
      plan.playback_url !== this.frozen.url
    )
      return false;
    // This independent budget cannot be reset by media recovery, reattachment,
    // keepalive or a newly reported lifetime. Spend before any SDK callback.
    this.networkAttempts++;
    this.nextNetworkAt = now + 1000 * this.networkAttempts;
    try {
      input.startLoad();
    } catch {
      return false;
    }
    return true;
  }
  networkCount(): number {
    return this.networkAttempts;
  }
  retire(): void {
    this.retired = true;
  }
  count(): number {
    return this.attempts;
  }
}
