export type PlaybackStatus = "playing" | "paused" | "ended";
export type RoomState = { room_id: string, revision: number, media_id: string | null, media_generation: number, playback_status: PlaybackStatus, anchor_position_ms: number, anchor_server_time_ms: number, playback_rate: number, controller_user_id: string, duration_ms: number | null, clock_epoch: string, };
export type PresenceMember = { user_id: string, connection_count: number, };
export type PresenceSnapshot = { room_id: string, presence_epoch: string, presence_seq: number, members: Array<PresenceMember>, };
export type ControlRecoveryMessageType = "CONTROL_RECOVERY_METRICS";
export type ControlRecoveryMetricsSample = { type: ControlRecoveryMessageType, version: number, socket_open_to_state_applied_ms: number, disconnect_observed_to_state_applied_ms?: number, background: boolean, };
export type NasUplinkOutcomeTotals = { transfers: number, bytes: number, duration_us: number, duration_buckets: [number, number, number, number, number, number, number, number, number], };
export type NasUplinkTotals = { admitted: number, dropped: number, active: number, body_seen: boolean, body_bytes: number, complete: NasUplinkOutcomeTotals, failed: NasUplinkOutcomeTotals, cancelled: NasUplinkOutcomeTotals, };
export type NasUplinkMetricsSample = { version: number, connection_id: string, seq: number, totals: NasUplinkTotals, };
export type Action = { "type": "PLAY" } | { "type": "PAUSE" } | { "type": "SEEK", "payload": { position_ms: number, } } | { "type": "SET_RATE", "payload": { rate: number, } } | { "type": "CHANGE_MEDIA", "payload": { media_id: string, } } | { "type": "END_MEDIA", "payload": { position_ms: number, } };
export type Command = { protocol_version: number, room_id: string, command_id: string, control_epoch?: string, expected_revision: number, media_generation: number, } & ({ "type": "PLAY" } | { "type": "PAUSE" } | { "type": "SEEK", "payload": { position_ms: number, } } | { "type": "SET_RATE", "payload": { rate: number, } } | { "type": "CHANGE_MEDIA", "payload": { media_id: string, } } | { "type": "END_MEDIA", "payload": { position_ms: number, } });
export type ControlEpoch = { id: string, expires_at_ms: number, };
export type MediaTrack = { index: number, label: string, language: string, url: string | null, };
export type SubtitleDeliveryMode = "none" | "external_vtt";
export type DecoderFallbackMode = "remux" | "transcode";
export type PlaybackMediaRange = { start_ms: number, end_ms: number, };
export type HttpFileFallback = { parent_session_id: string, final_observation?: PlaybackObservation, };
export type PlaybackPlan = { session_id: string,
/**
 * Per-viewer intent generation; absent for legacy grants. Never room revision.
 */
plan_generation?: number, media_id: string, media_generation: number, delivery_mode: string, transport: string, playback_url: string, timeline_origin_ms: number, duration_ms: number | null, expires_in_seconds: number, rebuild_on_seek: boolean, audio_tracks: Array<MediaTrack>, subtitle_tracks: Array<MediaTrack>, decision_reason?: string, selected_audio_track?: number, selected_candidate_id?: string,
/**
 * Available delivery pipeline, not the user's currently selected subtitle.
 */
subtitle_mode?: SubtitleDeliveryMode,
/**
 * Original-media intervals; absent is unknown, while [] is known empty.
 */
seekable_media_ranges_ms?: Array<PlaybackMediaRange>,
/**
 * A real authorized local job only while queued or running.
 */
pending_job_id?: string,
/**
 * Evidence-backed next request modes, never access or decode guarantees.
 */
decoder_fallback_modes?: Array<DecoderFallbackMode>,
/**
 * This live root grant supports one same-representation HTTP file→transcode
 * transition. Absent for legacy, unsupported inputs and successor grants.
 */
http_file_fallback_version?: number,
/**
 * Present only when this grant negotiated actual viewer observations.
 */
observation_version?: number, observation_seq?: number,
/**
 * Optional independent client-reported metrics; observations v1 is unchanged.
 */
playback_metrics_version?: number, playback_metrics?: PlaybackMetricsGrant, };
export type PreparationStatus = "queued" | "preparing" | "ready";
export type PlaybackReadiness = { session_id: string,
/**
 * Echoes the immutable grant generation, independent of job attempts.
 */
plan_generation?: number, status: PreparationStatus, complete: boolean,
/**
 * Exclusive end of the published prefix, relative to the plan's timeline origin.
 * None means this source/legacy output has no measured generated interval.
 */
available_until_ms: number | null,
/**
 * Original-media intervals; absent is unknown, while [] is known empty.
 */
seekable_media_ranges_ms?: Array<PlaybackMediaRange>, pending_job_id?: string, observation_version?: number, observation_seq?: number, };
export type MediaTypeSupport = "unknown" | "unsupported" | "maybe" | "probably";
export type VideoCapabilityConfiguration = { content_type: string, width: number, height: number, bitrate: number, framerate: number, };
export type AudioCapabilityConfiguration = { content_type: string, channels: string, bitrate: number, samplerate: number, };
export type MediaDecodingSupport = { supported: boolean, smooth: boolean, power_efficient: boolean, };
export type MediaCapabilityCandidate = {
/**
 * Combined container/codec MIME type tested through canPlayType and MSE.
 */
content_type: string, video: VideoCapabilityConfiguration, audio: AudioCapabilityConfiguration, progressive: MediaTypeSupport,
/**
 * Omitted means unavailable or failed, not supported.
 */
mse_supported?: boolean, file_decoding?: MediaDecodingSupport, mse_decoding?: MediaDecodingSupport, };
export type CapabilityReport = { schema_version: number, candidates: Array<MediaCapabilityCandidate>, };
export type PlaybackCandidateRequest = {
/**
 * Opt in to version-bound, reliable single-file HTTP candidates.
 * Omitted by explicit-direct requests, which must not force source probing.
 */
http_file_capabilities_version?: number, room_id: string, media_generation: number, audio_index: number | null, position_ms: number, };
export type PlaybackCandidate = { id: string, delivery_mode: string, transport: string, content_type: string, video: VideoCapabilityConfiguration, audio: AudioCapabilityConfiguration | null, };
export type PlaybackCandidateSet = { schema_version: number,
/**
 * Present only for a verified HTTP Binary binding. The client retains the
 * original binding across automatic route changes within the same intent.
 */
http_file_capabilities_version?: number, binding: string | null, candidates: Array<PlaybackCandidate>, decision_reason: string, };
export type PlaybackCandidateResult = { candidate_id: string, progressive: MediaTypeSupport, mse_supported?: boolean, file_decoding?: MediaDecodingSupport, mse_decoding?: MediaDecodingSupport, };
export type PlaybackCandidateReport = { binding: string, results: Array<PlaybackCandidateResult>,
/**
 * Bounded client decode-failure history; never changes authorization.
 */
excluded_candidates: Array<string>, };
export type PlaybackCapabilities = { progressive_h264_aac: boolean, native_hls: boolean, mse_h264_aac: boolean,
/**
 * Optional additive hints. Old clients retain the original transport gates.
 */
report?: CapabilityReport, };
export type PlaybackRequest = {
/**
 * Negotiate single-hop verified HTTP-file continuation; absence is legacy.
 */
http_file_fallback_version?: number, http_file_fallback?: HttpFileFallback,
/**
 * Opaque per-player identity for ordering only, never authorization.
 */
viewer_id?: string,
/**
 * Positive monotonic intent generation within user/room/viewer scope.
 * Must be supplied together with viewer_id; same-key retries retain it.
 */
plan_generation?: number, idempotency_key?: string, room_id: string, media_generation: number, mode: string | null, position_ms: number, audio_index: number | null, capabilities: PlaybackCapabilities | null, observation_version?: number, candidate_report?: PlaybackCandidateReport,
/**
 * Optional independent client-reported metrics; observations v1 is unchanged.
 */
playback_metrics_version?: number, playback_metrics?: PlaybackMetricsIntent, };
export type PlaybackMetricsOrigin = "user_intent" | "automatic_load";
export type PlaybackMetricsFrameEvidence = "video_frame_callback" | "playing_time_advance";
export type PlaybackMetricsIntent = { meter_start_generation: number, startup_origin: PlaybackMetricsOrigin, };
export type PlaybackMetricsTotals = { startup_ms: number, autoplay_blocked_ms: number, background_ms: number, paused_ms: number, seeking_ms: number, rebuffer_ms: number, playing_ms: number, unobserved_ms: number, };
export type PlaybackMetricsFirstFrame = { elapsed_ms: number, confirmed_elapsed_ms: number, evidence: PlaybackMetricsFrameEvidence, };
export type PlaybackMetricsSample = { version: number, media_generation: number, plan_generation: number, meter_start_generation: number, seq: number, startup_origin: PlaybackMetricsOrigin, elapsed_ms: number, totals: PlaybackMetricsTotals, first_frame?: PlaybackMetricsFirstFrame, final: boolean, };
export type PlaybackMetricsGrant = { meter_start_generation: number, startup_origin: PlaybackMetricsOrigin, metrics_seq: number, closed: boolean, last_sample?: PlaybackMetricsSample, };
export type PlaybackMetricsReceipt = { session_id: string, meter_start_generation: number, metrics_seq: number, closed: boolean, };
export type PlaybackObservationEvent = "playing" | "pause" | "progress" | "seeking" | "seeked" | "buffering" | "ended";
export type PlaybackObservation = { media_generation: number, seq: number, event: PlaybackObservationEvent, media_time_ms: number, paused: boolean, seeking: boolean, buffering: boolean, playback_rate: number, has_played: boolean, };
export type PlaybackObservationReceipt = { session_id: string, observation_seq: number, has_played: boolean, };
export type ErrorCode = "INVALID_REQUEST" | "UNSUPPORTED_PLAYBACK_METRICS_VERSION" | "INVALID_PLAYBACK_METRICS" | "PLAYBACK_METRICS_NOT_NEGOTIATED" | "STALE_PLAYBACK_METRICS" | "PLAYBACK_METRICS_SEQUENCE_STALE" | "PLAYBACK_METRICS_CONFLICT" | "PLAYBACK_METRICS_CLOSED" | "PLAYBACK_METRICS_TIME_INVALID" | "LOGIN_REQUIRED" | "SESSION_EXPIRED" | "FORBIDDEN" | "NOT_FOUND" | "METHOD_NOT_ALLOWED" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "RANGE_NOT_SATISFIABLE" | "RATE_LIMITED" | "INTERNAL_ERROR" | "UPSTREAM_FAILED" | "SERVICE_UNAVAILABLE" | "REQUEST_TIMEOUT" | "INVALID_CREDENTIALS" | "ORIGIN_REJECTED" | "CSRF_REJECTED" | "NOT_A_MEMBER" | "ADMIN_REQUIRED" | "CONTROLLER_REQUIRED" | "INVALID_NAME" | "USERNAME_OR_PASSWORD_INVALID" | "USERNAME_TAKEN" | "ALREADY_AUTHENTICATED" | "AVATAR_INVALID" | "AVATAR_TOO_LARGE" | "AVATAR_VERSION_CONFLICT" | "AVATAR_OPERATION_CONFLICT" | "AVATAR_PROCESSING_FAILED" | "AVATAR_PROCESSING_TIMEOUT" | "REGISTRATION_INVITE_INVALID" | "REGISTRATION_INVITE_ALREADY_USED" | "REGISTRATION_BATCH_CONFLICT" | "REGISTRATION_BATCH_ALREADY_CREATED" | "INVALID_INVITE" | "ROOM_FULL" | "ROOM_NOT_ACTIVE" | "ROOM_LIFECYCLE_CONFLICT" | "PAIR_CODE_INVALID" | "AGENT_TOKEN_REQUIRED" | "INVALID_AGENT" | "INVALID_SOURCE" | "MEDIA_ROOT_UNAVAILABLE" | "SOURCE_ROOT_UNAVAILABLE" | "OUTSIDE_MEDIA_ROOT" | "INVALID_SOURCE_URL" | "SOURCE_SCAN_FAILED" | "TOO_MANY_PLAYBACK_SESSIONS" | "MEDIA_QUEUE_FULL" | "PLAYBACK_REQUEST_CONFLICT" | "PLAYBACK_REQUEST_IN_PROGRESS" | "PLAYBACK_REQUEST_INTERRUPTED" | "PLAYBACK_REQUEST_EXPIRED" | "PLAYBACK_REQUEST_RETRY_EXHAUSTED" | "PLAYBACK_REQUEST_CANCELLED" | "UNSUPPORTED_OBSERVATION_VERSION" | "OBSERVATION_VERSION_REQUIRED" | "INVALID_OBSERVATION" | "INVALID_OBSERVATION_SEQUENCE" | "OBSERVATION_SEQUENCE_STALE" | "OBSERVATION_CONFLICT" | "INVALID_OBSERVATION_POSITION" | "INVALID_OBSERVATION_RATE" | "OBSERVATION_NOT_COMPLETE" | "STALE_MEDIA" | "INVALID_PLAN_GENERATION" | "PLAYBACK_VIEWER_LIMIT_EXCEEDED" | "STALE_PLAYBACK_PLAN" | "INVALID_POSITION" | "INVALID_RATE" | "NO_MEDIA" | "INVALID_MODE" | "UNSUPPORTED_VIDEO_OR_HDR" | "UPSTREAM_PLAYBACK_FAILED" | "UPSTREAM_POLICY_DENIED" | "UPSTREAM_POLICY_CHANGED" | "UPSTREAM_POLICY_UNAVAILABLE" | "NO_MEDIA_SOURCE" | "INVALID_UPSTREAM_BASE" | "UPSTREAM_NO_COMPATIBLE_STREAM" | "SOURCE_PROBE_FAILED" | "SOURCE_CHANGED" | "SOURCE_VERSION_REQUIRED" | "SOURCE_SEEK_UNSUPPORTED" | "STALE_CAPABILITY_REPORT" | "INVALID_AUDIO_TRACK" | "DEVICE_HAS_NO_COMPATIBLE_PLAYBACK_TRANSPORT" | "UPSTREAM_DEVICE_PROFILE_REQUIRED" | "PROTOCOL_VERSION" | "ROOM_MISMATCH" | "REVISION_CONFLICT" | "COMMAND_OWNED_BY_ANOTHER_USER" | "COMMAND_PAYLOAD_CONFLICT" | "COMMAND_REPLAY_UNVERIFIABLE" | "CONTROL_EPOCH_REQUIRED" | "CONTROL_EPOCH_EXPIRED" | "DATABASE_ERROR" | "COMMIT_FAILED" | "ROOM_BUSY" | "MEDIA_NOT_FOUND" | "MEDIA_TITLE_INVALID" | "MEDIA_TITLE_CONFLICT" | "MEDIA_PREVIEW_STALE" | "MEDIA_PREVIEW_QUEUE_FULL" | "MEDIA_PREVIEW_UNAVAILABLE" | "MEDIA_UNAVAILABLE" | "INVALID_PLAYBACK_SESSION" | "PROBE_BUSY" | "INVALID_SUBTITLE" | "CROSS_ORIGIN_SUBTITLE" | "INVALID_RESOURCE" | "MEDIA_JOB_FAILED" | "MEDIA_INPUT_INVALID" | "MEDIA_INPUT_DENIED" | "MEDIA_DECODER_UNAVAILABLE" | "MEDIA_ENCODER_UNAVAILABLE" | "CACHE_CAPACITY_EXCEEDED" | "CACHE_READ_ONLY" | "CACHE_PERMISSION_DENIED" | "MEDIA_JOB_CANCELLED" | "MEDIA_JOB_RETRY_EXHAUSTED" | "INVALID_RESOURCE_SIGNATURE" | "WRONG_RESOURCE_SESSION" | "CROSS_ORIGIN_MEDIA_REJECTED" | "UPSTREAM_MEDIA_ERROR" | "MANIFEST_TOO_LARGE" | "AGENT_OFFLINE" | "AGENT_TIMEOUT" | "INVALID_TRANSFER" | "TRANSFER_EXPIRED";
export type ApiError = { code: ErrorCode, message: string, retryable: boolean, retry_after_ms?: number, request_id: string, };
export type ErrorResponse = { error: ApiError, };
