import type {
  PlaybackObservation,
  PlaybackPlan,
  PlaybackRequest,
} from "../../../../../packages/protocol";
import type { PlaybackIntent } from "../../../../../packages/player-core/plan-generation";

/** One immutable child proposal for an actual Server-marked parent. Local
 * decode evidence is callback-fenced; Server still owns eligibility, source
 * identity, authentication, the unique claim and successor authority. */
export type StaticHlsCurrentIntent = Readonly<{
  room_id: string;
  media_id: string;
  media_generation: number;
  viewer_id: string;
  plan_generation: number;
}>;

export type StaticHlsPlanBinding = StaticHlsCurrentIntent &
  Readonly<{
    plan: PlaybackPlan;
    /** A local callback fence, never source identity or authority evidence. */
    attachment: object;
  }>;

type NonDecodeClassification =
  "network" | "authorization" | "timeout" | "unsupported_timeline";

/** An adapter must carry any known non-decoder classification through this
 * gate, even if a wrapper also calls the error a media error. */
export type StaticHlsFailureEvent = Readonly<
  (
    | { kind: "native"; code: number }
    | {
        kind: "hls";
        fatal: boolean;
        type: string;
        details: string;
        response?: Readonly<{ code?: number }>;
        media_error_code?: number;
        error_name?: string;
      }
    | { kind: NonDecodeClassification }
  ) & { classification?: NonDecodeClassification }
>;

export type StaticHlsDecodeFailure =
  | Readonly<{ kind: "native_decode"; code: 3 }>
  | Readonly<{ kind: "hls_media_decode" }>;

// The fatal mediaError family also contains stalls, buffer-full conditions and
// seek holes. Those are not a measured decoder failure. Unknown details fail
// closed, including future hls.js error families.
const HLS_DECODE_DETAILS = new Set([
  "fragParsingError",
  "manifestIncompatibleCodecsError",
  "bufferAddCodecError",
  "bufferIncompatibleCodecsError",
  "bufferAppendError",
  "bufferAppendingError",
]);

export function classifyStaticHlsDecodeFailure(
  event: StaticHlsFailureEvent,
): StaticHlsDecodeFailure | undefined {
  if (event.classification !== undefined) return;
  if (event.kind === "native")
    return event.code === 3
      ? Object.freeze({ kind: "native_decode", code: 3 })
      : undefined;
  if (
    event.kind !== "hls" ||
    event.fatal !== true ||
    event.type !== "mediaError" ||
    !HLS_DECODE_DETAILS.has(event.details) ||
    (event.media_error_code !== undefined && event.media_error_code !== 3) ||
    [
      "QuotaExceededError",
      "AbortError",
      "SecurityError",
      "NotAllowedError",
      "TimeoutError",
      "NetworkError",
    ].includes(event.error_name ?? "")
  )
    return;
  const status = event.response?.code;
  if (
    status !== undefined &&
    (!Number.isInteger(status) || status < 200 || status >= 300)
  )
    return;
  return Object.freeze({ kind: "hls_media_decode" });
}

// This is a local projection of the existing Server parser's closed lookup,
// not an additive shared protocol declaration or a client-owned graph DTO.
export type StaticHlsChildRequest = Readonly<
  Pick<
    PlaybackRequest,
    | "room_id"
    | "media_generation"
    | "audio_index"
    | "observation_version"
    | "playback_metrics_version"
  >
> &
  PlaybackIntent &
  Readonly<{
    idempotency_key: string;
    mode: "transcode";
    position_ms: number;
    static_hls_fallback_version: 1;
    capabilities: Readonly<{
      progressive_h264_aac: boolean;
      native_hls: boolean;
      mse_h264_aac: boolean;
    }>;
    playback_metrics?: Readonly<
      NonNullable<PlaybackRequest["playback_metrics"]>
    >;
    playback_metrics_supported_versions?: number[];
    static_hls_fallback: Readonly<{
      parent_session_id: string;
      failure: StaticHlsDecodeFailure;
      final_observation: Readonly<PlaybackObservation> | null;
    }>;
  }>;

export type StaticHlsChildIntent = Readonly<{
  request: StaticHlsChildRequest;
  /** Capture once; HTTP retries must not rebuild or update JSON. */
  body: string;
}>;

export type StaticHlsChildRefusal =
  | "unmarked_parent"
  | "invalid_parent"
  | "stale_plan"
  | "failure_not_decode"
  | "invalid_child"
  | "invalid_observation"
  | "already_proposed"
  | "closed";

export type StaticHlsChildProposal =
  | Readonly<{ kind: "proposed"; intent: StaticHlsChildIntent }>
  | Readonly<{ kind: "refused"; reason: StaticHlsChildRefusal }>;

type ProposalInput = {
  current: StaticHlsPlanBinding;
  failure: Readonly<{
    binding: StaticHlsPlanBinding;
    event: StaticHlsFailureEvent;
  }>;
  child: PlaybackIntent & Readonly<{ idempotency_key: string }>;
  position_ms: number;
  /** Null is explicit and required when no actual bound sample is available. */
  final_observation: Readonly<{
    binding: StaticHlsPlanBinding;
    sample: PlaybackObservation;
  }> | null;
};

const U32_MAX = 0xffff_ffff;
const UNKNOWN_DURATION_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OBSERVATION_POSITION_MS = 900_719_925_474;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== NIL_UUID &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}
function u32(value: unknown, positive = false): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= (positive ? 1 : 0) &&
    value <= U32_MAX
  );
}
function position(value: number): boolean {
  return (
    Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
  );
}
function marked(plan: PlaybackPlan): boolean {
  return (
    Object.hasOwn(plan, "static_hls_fallback_version") &&
    (plan as PlaybackPlan & { static_hls_fallback_version?: unknown })
      .static_hls_fallback_version === 1
  );
}
function sameIntent(
  left: StaticHlsCurrentIntent,
  right: StaticHlsCurrentIntent,
): boolean {
  return (
    left.room_id === right.room_id &&
    left.media_id === right.media_id &&
    left.media_generation === right.media_generation &&
    left.viewer_id === right.viewer_id &&
    left.plan_generation === right.plan_generation
  );
}
function sameBinding(
  left: StaticHlsPlanBinding,
  right: StaticHlsPlanBinding,
): boolean {
  return (
    left.plan === right.plan &&
    left.attachment === right.attachment &&
    sameIntent(left, right)
  );
}

function validMetrics(request: PlaybackRequest): boolean {
  const version = request.playback_metrics_version;
  const metrics = request.playback_metrics;
  const versions = request.playback_metrics_supported_versions;
  if (version === undefined && metrics === undefined && versions === undefined)
    return true;
  return (
    version === 1 &&
    !!metrics &&
    u32(metrics.meter_start_generation, true) &&
    metrics.meter_start_generation <= (request.plan_generation ?? 0) &&
    ["user_intent", "automatic_load"].includes(metrics.startup_origin) &&
    (versions === undefined ||
      (versions.length >= 1 &&
        versions.length <= 2 &&
        versions.every((value) => value === 1 || value === 2) &&
        new Set(versions).size === versions.length))
  );
}

function observation(
  sample: PlaybackObservation,
  plan: PlaybackPlan,
): Readonly<PlaybackObservation> | undefined {
  const events = [
    "playing",
    "pause",
    "progress",
    "seeking",
    "seeked",
    "buffering",
    "ended",
  ];
  const originalPosition = plan.timeline_origin_ms + sample.media_time_ms;
  const limit =
    plan.duration_ms === null
      ? UNKNOWN_DURATION_LIMIT_MS
      : plan.duration_ms + 1000;
  if (
    plan.observation_version !== 1 ||
    sample.media_generation !== plan.media_generation ||
    !Number.isSafeInteger(sample.seq) ||
    sample.seq <= 0 ||
    !events.includes(sample.event) ||
    !Number.isFinite(sample.media_time_ms) ||
    sample.media_time_ms < 0 ||
    !Number.isFinite(sample.playback_rate) ||
    sample.playback_rate < 0.2375 ||
    sample.playback_rate > 4.2 ||
    !Number.isFinite(originalPosition) ||
    originalPosition > limit ||
    originalPosition > MAX_OBSERVATION_POSITION_MS ||
    [sample.paused, sample.seeking, sample.buffering, sample.has_played].some(
      (value) => typeof value !== "boolean",
    )
  )
    return;
  // Project the closed existing observation; never propagate arbitrary extras.
  return Object.freeze({
    media_generation: sample.media_generation,
    seq: sample.seq,
    event: sample.event,
    media_time_ms: sample.media_time_ms === 0 ? 0 : sample.media_time_ms,
    paused: sample.paused,
    seeking: sample.seeking,
    buffering: sample.buffering,
    playback_rate: sample.playback_rate,
    has_played: sample.has_played,
  });
}

export function createStaticHlsChildIntentState(parent: {
  plan: PlaybackPlan;
  /** The actual immutable request that produced this plan, not a reconstruction. */
  request: PlaybackRequest;
}) {
  const plan = parent.plan;
  // Snapshot the relevant public data at binding, never add a marker later.
  const wasMarked = marked(plan);
  const request = structuredClone(parent.request);
  const origin: StaticHlsCurrentIntent = Object.freeze({
    room_id: request.room_id,
    media_id: plan.media_id,
    media_generation: request.media_generation,
    viewer_id: request.viewer_id ?? "",
    plan_generation: request.plan_generation ?? 0,
  });
  const parentSession = plan.session_id;
  const timeline = Object.freeze({ ...plan });
  const caps = request.capabilities;
  const validParent =
    uuid(parentSession) &&
    uuid(origin.room_id) &&
    uuid(origin.viewer_id) &&
    uuid(request.idempotency_key) &&
    typeof origin.media_id === "string" &&
    origin.media_id.length > 0 &&
    u32(origin.media_generation) &&
    u32(origin.plan_generation, true) &&
    request.static_hls_fallback_version === 1 &&
    (request.mode === null ||
      request.mode === "auto" ||
      request.mode === "direct") &&
    plan.plan_generation === origin.plan_generation &&
    plan.media_generation === origin.media_generation &&
    plan.delivery_mode === "direct" &&
    plan.transport === "hls" &&
    !plan.upstream_profile &&
    !plan.selected_candidate_id &&
    plan.http_file_fallback_version == null &&
    request.http_file_fallback_version == null &&
    request.http_file_fallback == null &&
    request.candidate_report == null &&
    request.upstream_profile_report == null &&
    !Object.hasOwn(request, "static_hls_fallback") &&
    (request.audio_index === null || u32(request.audio_index)) &&
    (request.observation_version === undefined ||
      request.observation_version === 1) &&
    validMetrics(request) &&
    Number.isFinite(plan.timeline_origin_ms) &&
    plan.timeline_origin_ms >= 0 &&
    (plan.duration_ms === null ||
      (Number.isFinite(plan.duration_ms) &&
        plan.duration_ms >= 0 &&
        plan.duration_ms <= MAX_OBSERVATION_POSITION_MS - 1000)) &&
    !!caps &&
    caps.report == null &&
    Object.keys(caps).every((key) =>
      ["progressive_h264_aac", "native_hls", "mse_h264_aac", "report"].includes(
        key,
      ),
    ) &&
    [caps.progressive_h264_aac, caps.native_hls, caps.mse_h264_aac].every(
      (value) => typeof value === "boolean",
    ) &&
    (caps.native_hls || caps.mse_h264_aac);

  let closed = false;
  let claimed: StaticHlsChildIntent | undefined;
  let childFence: StaticHlsCurrentIntent | undefined;
  const refused = (reason: StaticHlsChildRefusal): StaticHlsChildProposal =>
    Object.freeze({ kind: "refused", reason });

  return {
    propose(input: ProposalInput): StaticHlsChildProposal {
      if (closed) return refused("closed");
      if (claimed) return refused("already_proposed");
      if (!wasMarked) return refused("unmarked_parent");
      if (!validParent || !caps) return refused("invalid_parent");
      if (
        !marked(plan) ||
        input.current.plan !== plan ||
        !input.current.attachment ||
        typeof input.current.attachment !== "object" ||
        !sameIntent(input.current, origin) ||
        !sameBinding(input.failure.binding, input.current) ||
        plan.session_id !== parentSession ||
        plan.media_id !== origin.media_id ||
        plan.media_generation !== origin.media_generation ||
        plan.plan_generation !== origin.plan_generation ||
        plan.delivery_mode !== "direct" ||
        plan.transport !== "hls" ||
        plan.timeline_origin_ms !== timeline.timeline_origin_ms ||
        plan.duration_ms !== timeline.duration_ms
      )
        return refused("stale_plan");
      const failure = classifyStaticHlsDecodeFailure(input.failure.event);
      if (!failure) return refused("failure_not_decode");
      if (
        input.child.viewer_id !== origin.viewer_id ||
        !u32(input.child.plan_generation, true) ||
        input.child.plan_generation <= origin.plan_generation ||
        !uuid(input.child.idempotency_key) ||
        input.child.idempotency_key === request.idempotency_key ||
        !position(input.position_ms)
      )
        return refused("invalid_child");
      let final: Readonly<PlaybackObservation> | null = null;
      if (input.final_observation !== null) {
        if (
          !input.final_observation ||
          !sameBinding(input.final_observation.binding, input.current)
        )
          return refused("invalid_observation");
        const captured = observation(input.final_observation.sample, timeline);
        if (!captured) return refused("invalid_observation");
        final = captured;
      }
      const metrics = request.playback_metrics;
      const body: StaticHlsChildRequest = Object.freeze({
        viewer_id: origin.viewer_id,
        plan_generation: input.child.plan_generation,
        idempotency_key: input.child.idempotency_key,
        room_id: origin.room_id,
        media_generation: origin.media_generation,
        mode: "transcode",
        position_ms: input.position_ms === 0 ? 0 : input.position_ms,
        // The original default/explicit audio INTENT, not selected_audio_track.
        audio_index: request.audio_index,
        capabilities: Object.freeze({
          progressive_h264_aac: caps.progressive_h264_aac,
          native_hls: caps.native_hls,
          mse_h264_aac: caps.mse_h264_aac,
        }),
        ...(request.observation_version !== undefined
          ? { observation_version: request.observation_version }
          : {}),
        ...(request.playback_metrics_version !== undefined
          ? { playback_metrics_version: request.playback_metrics_version }
          : {}),
        ...(metrics
          ? {
              playback_metrics: Object.freeze({
                meter_start_generation: metrics.meter_start_generation,
                startup_origin: metrics.startup_origin,
              }),
            }
          : {}),
        ...(request.playback_metrics_supported_versions
          ? {
              playback_metrics_supported_versions: Object.freeze([
                ...request.playback_metrics_supported_versions,
              ]) as number[],
            }
          : {}),
        static_hls_fallback_version: 1,
        static_hls_fallback: Object.freeze({
          parent_session_id: parentSession,
          failure,
          final_observation: final,
        }),
      });
      claimed = Object.freeze({ request: body, body: JSON.stringify(body) });
      childFence = Object.freeze({
        ...origin,
        plan_generation: input.child.plan_generation,
      });
      return Object.freeze({ kind: "proposed", intent: claimed });
    },
    /** Reuse after parent retirement or an uncertain HTTP result. No new key,
     * position, capabilities, sample or failure can be supplied on this path. */
    retry(current: StaticHlsCurrentIntent): StaticHlsChildIntent | undefined {
      if (!closed && claimed && childFence && sameIntent(current, childFence))
        return claimed;
    },
    close() {
      closed = true;
    },
    get status(): "unused" | "proposed" | "closed" {
      return closed ? "closed" : claimed ? "proposed" : "unused";
    },
  };
}
