export type DistributedComputePlaybackIntent = { schema_version: number, job_id: string, output_generation: string, };
export type DistributedComputePlaybackFacts = { schema_version: number, job_id: string, output_generation: string, attempt: number, qualification_sha256: string, manifest_sha256: string, directory_url: string, p2p_enabled: boolean, source_video_index: number, source_audio_index: number | null, video_codec: string, width: number, height: number, audio_codec: string | null, audio_channels: number | null, audio_sample_rate: number | null, source_duration_ms: number, timestamp_shift_ms: number, };
export type LocalHlsLadderRequest = { schema_version: number, };
export type LocalHlsRendition = { id: string, width: number, height: number, bandwidth: number, codecs: string, };
export type LocalHlsLadderCapabilities = { schema_version: number, renditions: Array<LocalHlsRendition>, worker_runtime_required: boolean, };
export type LocalHlsLadderFacts = { request: LocalHlsLadderRequest, renditions: Array<LocalHlsRendition>, video_basis: PlaybackOutputBasis, };
export type AdvancedPlaybackRequest = { schema_version: number, tone_map_hdr: boolean, subtitle_stream_index: number | null, };
export type AdvancedSubtitleCodec = "ass" | "ssa" | "pgs";
export type AdvancedSubtitleTrack = { index: number, codec: AdvancedSubtitleCodec, label: string, language: string, };
export type AdvancedPlaybackCapabilities = { schema_version: number, tone_map_hdr: boolean, subtitle_streams: Array<AdvancedSubtitleTrack>, worker_runtime_required: boolean, dolby_vision?: DolbyVisionConfiguration, };
export type DolbyVisionConfiguration = { profile: number, level: number, compatibility_id: number, codec: string, };
export type AdvancedPlaybackFacts = { request: AdvancedPlaybackRequest, subtitle_codec: AdvancedSubtitleCodec | null, video_basis: PlaybackOutputBasis, };
export type NativePlatformCredentialMode = "own_or_anonymous" | "anonymous";
export type NativePlatformProvider = "bilibili" | "douyin" | "tiktok" | "youtube";
export type NativePlatformResolvedCredentialMode = "own_account" | "anonymous";
export type NativePlatformMaxHeight = "auto" | "p144" | "p240" | "p360" | "p480" | "p720" | "p1080" | "p1440" | "p2160" | "p4320";
export type NativePlatformQualityIntent = { version: number, provider: NativePlatformProvider, media_id: string, max_height: NativePlatformMaxHeight, };
export type NativePlatformQualityOption = { max_height: NativePlatformMaxHeight,
/**
 * Observed compatible provider rendition, used for truthful UI labels.
 */
height: number, };
export type NativePlatformQualityBinding = { version: number, requested_max_height: NativePlatformMaxHeight, selected_height: number, options: Array<NativePlatformQualityOption>, };
export type NativePlatformCompatibilityMode = "hls_avc_aac" | "hls_avc_aac_ladder";
export type NativePlatformCompatibilityIntent = { version: number, mode: NativePlatformCompatibilityMode, };
export type NativePlatformCompatibilityOutput = { attempt: number,
/**
 * Full immutable publication for this exact attempt; prefix readiness from
 * an earlier retry cannot supply its completion or forward-lead policy.
 */
complete: boolean, codecs: string, width: number, height: number,
/**
 * Qualified renditions belonging to this exact ladder attempt. The scalar
 * dimensions describe the highest rendition, not the player's current
 * automatically selected level. Absent for the single-output recipe.
 */
renditions?: Array<LocalHlsRendition>, };
export type NativePlatformCompatibilityBinding = { version: number, mode: NativePlatformCompatibilityMode, output?: NativePlatformCompatibilityOutput, };
export type NativePlatformLiveSyncMode = "live_edge_control";
export type NativePlatformLiveBinding = { version: number, broadcast_id: string, sync_mode: NativePlatformLiveSyncMode, };
export type NativePlatformPlaybackIntent = {
/**
 * Explicit opt-in to the distinct, positively entitled course route.
 */
course_version?: number,
/**
 * Dedicated compatibility prepare route only; absence preserves v1 hashes.
 */
compatibility?: NativePlatformCompatibilityIntent,
/**
 * Explicit opt-in to live-edge/control semantics; absence is legacy VOD.
 */
live_version?: number, version: number, credential_mode: NativePlatformCredentialMode, account_id?: string, quality?: NativePlatformQualityIntent, };
export type NativePlatformPlaybackBinding = { course_version?: number, compatibility?: NativePlatformCompatibilityBinding, live?: NativePlatformLiveBinding, version: number, provider: NativePlatformProvider, credential_mode: NativePlatformResolvedCredentialMode,
/**
 * An application refresh policy, not a promise about upstream URL TTL.
 */
refresh_after_seconds: number, quality?: NativePlatformQualityBinding, };
export type PlaybackStatus = "playing" | "paused" | "ended";
export type RoomState = {
/**
 * Derived from the selected immutable room-private media by the server.
 */
live?: NativePlatformLiveBinding, room_id: string, revision: number, media_id: string | null, media_generation: number, playback_status: PlaybackStatus, anchor_position_ms: number, anchor_server_time_ms: number, playback_rate: number, controller_user_id: string, duration_ms: number | null, clock_epoch: string, };
export type PresenceMember = { user_id: string, connection_count: number, };
export type PresenceSnapshot = { room_id: string, presence_epoch: string, presence_seq: number, members: Array<PresenceMember>, };
export type ControlRecoveryMessageType = "CONTROL_RECOVERY_METRICS";
export type ControlRecoveryMetricsSample = { type: ControlRecoveryMessageType, version: number, socket_open_to_state_applied_ms: number, disconnect_observed_to_state_applied_ms?: number, background: boolean, };
export type NasUplinkOutcomeTotals = { transfers: number, bytes: number, duration_us: number, duration_buckets: [number, number, number, number, number, number, number, number, number], };
export type NasUplinkTotals = { admitted: number, dropped: number, active: number, body_seen: boolean, body_bytes: number, complete: NasUplinkOutcomeTotals, failed: NasUplinkOutcomeTotals, cancelled: NasUplinkOutcomeTotals, };
export type NasUplinkMetricsSample = { version: number, connection_id: string, seq: number, totals: NasUplinkTotals, };
export type Action = { "type": "PLAY" } | { "type": "PAUSE" } | { "type": "SEEK", "payload": { position_ms: number, } } | { "type": "SET_RATE", "payload": { rate: number, } } | { "type": "CHANGE_MEDIA", "payload": { media_id: string, } } | { "type": "END_MEDIA", "payload": { position_ms: number, } };
export type Command = {
/**
 * Old clients must opt in before controlling or selecting live media.
 */
live_version?: number, protocol_version: number, room_id: string, command_id: string, control_epoch?: string, expected_revision: number, media_generation: number, } & ({ "type": "PLAY" } | { "type": "PAUSE" } | { "type": "SEEK", "payload": { position_ms: number, } } | { "type": "SET_RATE", "payload": { rate: number, } } | { "type": "CHANGE_MEDIA", "payload": { media_id: string, } } | { "type": "END_MEDIA", "payload": { position_ms: number, } });
export type ControlEpoch = { id: string, expires_at_ms: number, };
export type MediaTrack = { index: number, label: string, language: string, url: string | null, };
export type SubtitleDeliveryMode = "none" | "external_vtt" | "burned_in";
export type DecoderFallbackMode = "remux" | "transcode";
export type PlaybackMediaRange = { start_ms: number, end_ms: number, };
export type HttpFileFallback = { parent_session_id: string, final_observation?: PlaybackObservation, };
export type PlaybackPlan = { distributed_compute?: DistributedComputePlaybackFacts, local_hls_ladder?: LocalHlsLadderFacts, advanced_playback?: AdvancedPlaybackFacts, native_platform?: NativePlatformPlaybackBinding,
/**
 * Negotiated upstream recipe envelope; not measured media configuration.
 */
upstream_profile?: UpstreamTranscodeProfileEnvelope, session_id: string,
/**
 * Per-viewer intent generation; absent for legacy grants. Never room revision.
 */
plan_generation?: number, media_id: string, media_generation: number, delivery_mode: string, transport: string, playback_url: string, timeline_origin_ms: number, duration_ms: number | null, expires_in_seconds: number, rebuild_on_seek: boolean, audio_tracks: Array<MediaTrack>, subtitle_tracks: Array<MediaTrack>, decision_reason?: string, selected_audio_track?: number, selected_candidate_id?: string,
/**
 * Server-selected bound configuration, not measured output or playback.
 */
selected_output?: PlaybackSelectedOutput,
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
 * Server-verified static-HLS root may claim one decode-failure child.
 * Absent for legacy/ineligible parents and every successor grant.
 */
static_hls_fallback_version?: number,
/**
 * Present only when this grant negotiated actual viewer observations.
 */
observation_version?: number, observation_seq?: number,
/**
 * Optional independent client-reported metrics; observations v1 is unchanged.
 */
playback_metrics_version?: number, playback_metrics?: PlaybackMetricsGrantWire, };
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
export type VideoCapabilityConfiguration = { content_type: string, width: number, height: number, bitrate: number, framerate: number, dolby_vision?: DolbyVisionConfiguration, };
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
export type PlaybackCandidateRequest = { local_hls_ladder_capabilities_version?: number, local_hls_ladder?: LocalHlsLadderRequest,
/**
 * Opt in to source-eligible advanced controls while retaining legacy
 * candidate/error behavior for clients that omit this offer.
 */
advanced_playback_capabilities_version?: number, advanced_playback?: AdvancedPlaybackRequest,
/**
 * Opt in to version-bound, reliable single-file HTTP candidates.
 * Omitted by explicit-direct requests, which must not force source probing.
 */
http_file_capabilities_version?: number, room_id: string, media_generation: number, audio_index: number | null, position_ms: number, };
export type PlaybackCandidate = { id: string, delivery_mode: string, transport: string, content_type: string, video: VideoCapabilityConfiguration, audio: AudioCapabilityConfiguration | null, };
export type PlaybackRouteReason = "source_configuration" | "constrained_encoder_recipe" | "video_configuration_unavailable" | "video_copy_unsupported" | "sample_entry_unsupported" | "video_transform_required" | "container_unsupported" | "track_mapping_required" | "audio_configuration_unavailable" | "no_audio_track" | "nonzero_copy_origin";
export type PlaybackRouteDecision = { candidate_id: string,
/**
 * Offered for concrete client testing, not proven device decoding.
 */
offered: boolean, reason: PlaybackRouteReason, };
export type PlaybackOutputBasis = "source_probe" | "constrained_encoder_recipe";
export type PlaybackSelectedOutput = { configuration: PlaybackCandidate, video_basis: PlaybackOutputBasis, audio_basis: PlaybackOutputBasis | null, };
export type PlaybackCandidateSet = { local_hls_ladder?: LocalHlsLadderCapabilities,
/**
 * Fresh local source eligibility, independent of Worker device support.
 */
advanced_playback?: AdvancedPlaybackCapabilities, schema_version: number,
/**
 * Present only for a verified HTTP Binary binding. The client retains the
 * original binding across automatic route changes within the same intent.
 */
http_file_capabilities_version?: number, binding: string | null, candidates: Array<PlaybackCandidate>, decision_reason: string,
/**
 * At most the four server routes. Absent on legacy/unsupported providers.
 */
route_decisions?: Array<PlaybackRouteDecision>, };
export type PlaybackCandidateResult = { candidate_id: string, progressive: MediaTypeSupport, dolby_vision_supported?: boolean, mse_supported?: boolean, file_decoding?: MediaDecodingSupport, mse_decoding?: MediaDecodingSupport, };
export type PlaybackCandidateReport = { binding: string, results: Array<PlaybackCandidateResult>,
/**
 * Bounded client decode-failure history; never changes authorization.
 */
excluded_candidates: Array<string>, };
export type UpstreamProfileSemantics = "upstream_transcode_profile_envelope";
export type UpstreamVideoProfileBounds = { codec: string, profile: string, max_level: string, max_width: number, max_height: number, max_framerate: number, max_bitrate: number, requested_bit_depth: number, requested_range: string, };
export type UpstreamAudioProfileBounds = {
/**
 * AAC is requested. A particular AAC profile is not promised by this field.
 */
codec: string, max_channels: number, requested_sample_rate: number, max_bitrate: number, };
export type UpstreamProfileProbeSample = { video: VideoCapabilityConfiguration, audio: AudioCapabilityConfiguration | null, };
export type UpstreamAudioRateContract = { allowed_sample_rates: Array<number>, source_sample_rate: number, mse_samples: Array<AudioCapabilityConfiguration>, };
export type UpstreamAudioRateReport = { sample_rate: number, mse_supported: boolean, mse_decoding?: MediaDecodingSupport, };
export type UpstreamTranscodeProfileEnvelope = { profile_version: number, profile_id: string, configuration_semantics: UpstreamProfileSemantics, transport: string, container: string, requested_video: UpstreamVideoProfileBounds, requested_audio: UpstreamAudioProfileBounds | null, mse_sample: UpstreamProfileProbeSample, audio_rate_contract?: UpstreamAudioRateContract, };
export type UpstreamProfileCandidateRequest = {
/**
 * Maximum supported dedicated contract version; response keeps its actual version.
 */
profile_version: number, room_id: string, media_generation: number, position_ms: number, audio_index: number | null, };
export type UpstreamProfileCandidateSet = { profile_version: number,
/**
 * Binding and profile are either both present or both absent.
 */
binding: string | null, profile: UpstreamTranscodeProfileEnvelope | null, decision_reason: string, };
export type UpstreamProfileReport = { profile_version: number, binding: string, profile_id: string, mse_supported: boolean, mse_decoding?: MediaDecodingSupport, audio_rate_reports?: Array<UpstreamAudioRateReport>, };
export type UpstreamMeasuredVideo = { codec: string, profile: string, width: number, height: number, pixel_format: string, frame_rate: number, decoded_frames: number, };
export type UpstreamMeasuredAudio = { codec: string, profile: string, sample_rate: number, channels: number, decoded_frames: number, };
export type UpstreamMeasuredOutput = { schema_version: number, semantics: string, session_id: string, plan_generation: number | null,
/**
 * SHA-256 identities avoid exposing provider session identifiers/URLs.
 */
upstream_sid_sha256: string, route_sha256: string, representation_sha256: string, measured_bytes: number, measured_segments: number, manifest_duration_ms: number, video: UpstreamMeasuredVideo, audio: UpstreamMeasuredAudio | null, process_tree_reaped: boolean, };
export type PlaybackCapabilities = { progressive_h264_aac: boolean, native_hls: boolean, mse_h264_aac: boolean,
/**
 * Optional additive hints. Old clients retain the original transport gates.
 */
report?: CapabilityReport, };
export type PlaybackRequest = {
/**
 * Dedicated primary NAS output endpoint; absence preserves legacy hashes.
 */
distributed_compute?: DistributedComputePlaybackIntent,
/**
 * Explicit finite-HLS local transcode admission only.
 */
finite_hls_version?: number,
/**
 * Dedicated local multirendition endpoint only; absence preserves legacy hashes.
 */
local_hls_ladder?: LocalHlsLadderRequest,
/**
 * Dedicated advanced-local route only. Absence preserves legacy hashes.
 */
advanced_playback?: AdvancedPlaybackRequest,
/**
 * Dedicated native-platform route only. Absence preserves legacy hashes.
 */
native_platform?: NativePlatformPlaybackIntent,
/**
 * Opt into verified static-HLS parent preparation. Absence is legacy.
 * A child continuation is advertised separately only when implemented.
 */
static_hls_fallback_version?: number,
/**
 * Dedicated upstream-profile route only; absence preserves legacy hashes.
 */
upstream_profile_report?: UpstreamProfileReport,
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
playback_metrics_version?: number, playback_metrics?: PlaybackMetricsIntent,
/**
 * Outer offer is ignored by old servers. Absence preserves canonical hashes.
 */
playback_metrics_supported_versions?: Array<number>, };
export type PlaybackMetricsOrigin = "user_intent" | "automatic_load";
export type PlaybackMetricsFrameEvidence = "video_frame_callback" | "playing_time_advance";
export type PlaybackMetricsIntent = { meter_start_generation: number, startup_origin: PlaybackMetricsOrigin, };
export type PlaybackMetricsTotals = { startup_ms: number, autoplay_blocked_ms: number, background_ms: number, paused_ms: number, seeking_ms: number, rebuffer_ms: number, playing_ms: number, unobserved_ms: number, };
export type PlaybackMetricsFirstFrame = { elapsed_ms: number, confirmed_elapsed_ms: number, evidence: PlaybackMetricsFrameEvidence, };
export type PlaybackMetricsSample = { version: number, media_generation: number, plan_generation: number, meter_start_generation: number, seq: number, startup_origin: PlaybackMetricsOrigin, elapsed_ms: number, totals: PlaybackMetricsTotals, first_frame?: PlaybackMetricsFirstFrame, final: boolean, };
export type PlaybackMetricsStartupPhases = { preparation_ms: number, loading_ms: number, unobserved_ms: number, };
export type PlaybackMetricsSampleV2 = { version: number, media_generation: number, plan_generation: number, meter_start_generation: number, seq: number, startup_origin: PlaybackMetricsOrigin, elapsed_ms: number, totals: PlaybackMetricsTotals, startup_phases: PlaybackMetricsStartupPhases,
/**
 * The originating published grant, never a local source callback counter.
 */
first_frame_plan_generation?: number, first_frame?: PlaybackMetricsFirstFrame, final: boolean, };
export type PlaybackMetricsPacket = PlaybackMetricsSample | PlaybackMetricsSampleV2;
export type PlaybackMetricsGrantV2 = { meter_start_generation: number, startup_origin: PlaybackMetricsOrigin, metrics_seq: number, closed: boolean, last_sample?: PlaybackMetricsSampleV2, };
export type PlaybackMetricsGrantWire = PlaybackMetricsGrant | PlaybackMetricsGrantV2;
export type PlaybackMetricsGrant = { meter_start_generation: number, startup_origin: PlaybackMetricsOrigin, metrics_seq: number, closed: boolean, last_sample?: PlaybackMetricsSample, };
export type PlaybackMetricsReceipt = { session_id: string, meter_start_generation: number, metrics_seq: number, closed: boolean, };
export type PlaybackObservationEvent = "playing" | "pause" | "progress" | "seeking" | "seeked" | "buffering" | "ended";
export type PlaybackObservation = { media_generation: number, seq: number, event: PlaybackObservationEvent, media_time_ms: number, paused: boolean, seeking: boolean, buffering: boolean, playback_rate: number, has_played: boolean, };
export type PlaybackObservationReceipt = { session_id: string, observation_seq: number, has_played: boolean, };
export type ErrorCode = "ACCOUNT_INACTIVE" | "ACCOUNT_OWNERSHIP_REQUIRED" | "ACCOUNT_LAST_ADMIN" | "DISTRIBUTED_PLAYBACK_INTENT_REQUIRED" | "INVALID_DISTRIBUTED_PLAYBACK_INTENT" | "DEDICATED_DISTRIBUTED_ENDPOINT_REQUIRED" | "DISTRIBUTED_OUTPUT_NOT_QUALIFIED" | "DISTRIBUTED_AUDIO_SELECTION_CHANGED" | "COMPUTE_AUDIO_TRACK_UNAVAILABLE" | "COMPUTE_VERIFICATION_INTERRUPTED" | "COMPUTE_QUALIFICATION_REJECTED" | "COMPUTE_QUALIFICATION_BINDING_CHANGED" | "COMPUTE_SERVER_OUTPUT_REJECTED" | "COMPUTE_OUTPUT_REPORT_MISMATCH" | "COMPUTE_VERIFICATION_ALREADY_OWNED" | "INVALID_COMPUTE_DRAIN_RECEIPT" | "COMPUTE_DRAIN_RECEIPT_NOT_OWNED" | "NAS_COMPUTE_DISABLED" | "INVALID_COMPUTE_POLICY" | "COMPUTE_POLICY_CONFLICT" | "INVALID_AGENT_NAME" | "AGENT_SETTINGS_CONFLICT" | "INVALID_ADMIN_SETTINGS" | "SETTINGS_REVISION_CONFLICT" | "REGISTRATION_CLOSED" | "INVALID_COMPUTE_CAPABILITY" | "COMPUTE_NOT_AUTHORIZED" | "INVALID_COMPUTE_SOURCE" | "COMPUTE_SOURCE_CHANGED" | "INVALID_COMPUTE_RECIPE" | "COMPUTE_RECIPE_UNAVAILABLE" | "COMPUTE_OUTPUT_BUDGET_INSUFFICIENT" | "COMPUTE_SOURCE_TOO_LARGE" | "COMPUTE_SOURCE_DURATION_UNSUPPORTED" | "COMPUTE_ROOM_QUEUE_FULL" | "COMPUTE_SOURCE_NOT_READY" | "COMPUTE_NODE_UNHEALTHY" | "COMPUTE_LEASE_LOST" | "COMPUTE_FENCE_REQUIRED" | "INVALID_COMPUTE_ARTIFACT" | "COMPUTE_ARTIFACT_HASH_MISMATCH" | "COMPUTE_ARTIFACT_IMMUTABLE" | "COMPUTE_OUTPUT_BUDGET_EXCEEDED" | "COMPUTE_GLOBAL_BUDGET_EXCEEDED" | "INVALID_COMPUTE_MANIFEST" | "INCOMPLETE_COMPUTE_ARTIFACT" | "UNREFERENCED_COMPUTE_ARTIFACT" | "COMPUTE_ARTIFACT_CHANGED" | "COMPUTE_OUTPUT_NOT_FOUND" | "COMPUTE_JOB_NOT_FOUND" | "COMPUTE_OUTPUT_NOT_READY" | "P2P_DISABLED" | "P2P_CONSENT_REQUIRED" | "P2P_SCOPE_CHANGED" | "P2P_PEER_EXPIRED" | "INVALID_P2P_SIGNAL" | "P2P_SIGNAL_BUDGET_EXCEEDED" | "P2P_TARGET_UNAVAILABLE" | "P2P_ROOM_PEER_BUDGET_EXCEEDED" | "PRIVATE_LIBRARIES_DISABLED" | "LIBRARY_INVALID" | "LIBRARY_NOT_FOUND" | "LIBRARY_LIMIT" | "LIBRARY_SOURCE_LIMIT" | "LIBRARY_CONFLICT" | "LIBRARY_OWNER_REQUIRED" | "LIBRARY_SHARED_PROTECTED" | "LIBRARY_MANAGED_SOURCES" | "LIBRARY_SHARE_INACTIVE" | "LIBRARY_SHARE_EXPIRY_INVALID" | "SOURCE_CREDENTIALS_ORIGIN_CHANGED" | "SOURCE_CLEANUP_UNCONFIRMED" | "SOURCE_ALREADY_ATTACHED" | "S3_SOURCE_REQUIRED" | "S3_SCAN_FAILED" | "SOURCE_SCAN_BUSY" | "SOURCE_NOT_FOUND" | "USER_NOT_FOUND" | "CHAT_MUTED" | "CHAT_RATE_LIMITED" | "CHAT_MODERATOR_REQUIRED" | "CHAT_MODERATION_INVALID" | "CHAT_TARGET_PROTECTED" | "CHAT_MESSAGE_NOT_FOUND" | "TIMELINE_MEDIA_UNAVAILABLE" | "TIMELINE_CLOCK_STALE" | "TIMELINE_CURSOR_INVALID" | "TIMELINE_ACTIVITY_NOT_FOUND" | "TIMELINE_CURSOR_EXPIRED" | "TIMELINE_COMMENT_INVALID" | "TIMELINE_MESSAGE_CONFLICT" | "TIMELINE_ACTIVITY_UNAVAILABLE" | "TIMELINE_ACTIVITY_STALE" | "TIMELINE_POSITION_INVALID" | "REACTION_INVALID" | "REACTION_CONFLICT" | "REACTION_RATE_LIMITED" | "PLUGIN_REVISION_INVALID" | "PLUGIN_MANIFEST_OR_PERMISSIONS_INVALID" | "PLUGIN_REVISION_CONFLICT" | "PLUGIN_NOT_FOUND" | "PLUGIN_NO_ROLLBACK" | "PLUGIN_ROLLBACK_INVALID" | "PLUGIN_MEDIA_CHANGED" | "PLATFORM_COLLECTION_RESTRICTED" | "PLATFORM_COLLECTION_PROVIDER_UNAVAILABLE" | "PLATFORM_COLLECTION_CLEANUP_FAILED" | "PLATFORM_COLLECTION_ITEMS_UNAVAILABLE" | "PLATFORM_IMPORT_UNAVAILABLE" | "PLATFORM_IMPORT_PLATFORM_RESTRICTED" | "PLATFORM_IMPORT_INVALID" | "PLATFORM_IMPORT_CANCELLED" | "PLATFORM_COLLECTION_CHANGED" | "PLATFORM_COLLECTION_INVALID" | "PLATFORM_COLLECTION_UNSUPPORTED" | "PLATFORM_COLLECTION_SINGLE_REQUIRED" | "PLATFORM_IMPORT_LIMIT" | "PLATFORM_IMPORT_DEADLINE" | "NATIVE_PLATFORM_TEXT_INVALID" | "NATIVE_PLATFORM_TEXT_UNAVAILABLE" | "NATIVE_PLATFORM_TEXT_TIMEOUT" | "NATIVE_PLATFORM_TEXT_UNSUPPORTED" | "NATIVE_PLATFORM_SUBTITLE_LOGIN_REQUIRED" | "NATIVE_PLATFORM_SUBTITLE_UNAVAILABLE" | "NATIVE_PLATFORM_DANMAKU_UNSUPPORTED" | "NATIVE_PLATFORM_DANMAKU_TIME_INVALID" | "NATIVE_PLATFORM_CAPTION_METADATA_UNAVAILABLE" | "NATIVE_PLATFORM_CAPTION_FORMAT_UNSUPPORTED" | "NATIVE_PLATFORM_CAPTION_ORIGIN_UNSUPPORTED" | "NATIVE_PLATFORM_CAPTION_SIGNING_REQUIRED" | "NATIVE_LIVE_DANMAKU_CLIENT_ID_CONSENT_REQUIRED" | "NATIVE_LIVE_DANMAKU_LOGIN_REQUIRED" | "NATIVE_LIVE_DANMAKU_AUTH_DENIED" | "NATIVE_LIVE_DANMAKU_PROTOCOL_UNSUPPORTED" | "NATIVE_LIVE_DANMAKU_HEARTBEAT_TIMEOUT" | "NATIVE_LIVE_DANMAKU_OUTPUT_LIMIT" | "NATIVE_LIVE_DANMAKU_CLOSED" | "NATIVE_LIVE_CLIENT_UNSUPPORTED" | "NATIVE_LIVE_BROADCAST_CHANGED" | "NATIVE_LIVE_NOT_BROADCASTING" | "NATIVE_LIVE_RATE_LIMITED" | "NATIVE_LIVE_CAPACITY" | "NATIVE_LIVE_PLAYLIST_CHANGED" | "NATIVE_LIVE_WINDOW_EXPIRED" | "NATIVE_LIVE_SEEK_UNSUPPORTED" | "NATIVE_LIVE_RATE_UNSUPPORTED" | "NATIVE_LIVE_END_UNSUPPORTED" | "NATIVE_LIVE_STATE_CHANGED" | "NATIVE_PLATFORM_INVALID" | "NATIVE_PLATFORM_INVALID_RESPONSE" | "NATIVE_PLATFORM_ENTRY_CHANGED" | "NATIVE_PLATFORM_INTENT_REQUIRED" | "NATIVE_PLATFORM_INVALID_INTENT" | "NATIVE_PLATFORM_ACCESS_DENIED" | "NATIVE_PLATFORM_PROVIDER_UNAVAILABLE" | "NATIVE_PLATFORM_ANONYMOUS_UNSUPPORTED" | "NATIVE_PLATFORM_DEVICE_UNSUPPORTED" | "NATIVE_PLATFORM_RESOLVE_FAILED" | "NATIVE_PLATFORM_RESOLVE_TIMEOUT" | "NATIVE_PLATFORM_URL_EXPIRED" | "NATIVE_PLATFORM_CODEC_UNSUPPORTED" | "NATIVE_PLATFORM_COMPATIBILITY_SOURCE_UNSUPPORTED" | "NATIVE_PLATFORM_PROGRESSIVE_UNSUPPORTED" | "NATIVE_PLATFORM_DELIVERY_INVALID" | "NATIVE_PLATFORM_RANGE_INVALID" | "PLATFORM_ACCOUNT_CHANGED" | "PLATFORM_CREDENTIAL_INVALID" | "PLATFORM_LOGIN_CHANGED" | "PLATFORM_LOGIN_EXPIRED" | "PLATFORM_LOGIN_IN_PROGRESS" | "PLATFORM_LOGIN_REQUEST_CONFLICT" | "PLATFORM_LOGIN_REQUEST_INVALID" | "PLATFORM_LOGIN_REQUEST_NOT_FOUND" | "PLATFORM_LOGIN_UPSTREAM_FAILED" | "PLATFORM_STORAGE_CONSENT_REQUIRED" | "PLATFORM_PLAN_REFRESH_REQUIRED" | "DEDICATED_PLATFORM_ENDPOINT_REQUIRED" | "INVALID_REQUEST" | "CHAT_CURSOR_NOT_FOUND" | "UNSUPPORTED_PLAYBACK_METRICS_VERSION" | "INVALID_PLAYBACK_METRICS" | "PLAYBACK_METRICS_NOT_NEGOTIATED" | "STALE_PLAYBACK_METRICS" | "PLAYBACK_METRICS_SEQUENCE_STALE" | "PLAYBACK_METRICS_CONFLICT" | "PLAYBACK_METRICS_CLOSED" | "PLAYBACK_METRICS_TIME_INVALID" | "LOGIN_REQUIRED" | "SESSION_EXPIRED" | "FORBIDDEN" | "NOT_FOUND" | "METHOD_NOT_ALLOWED" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "RANGE_NOT_SATISFIABLE" | "RATE_LIMITED" | "INTERNAL_ERROR" | "UPSTREAM_FAILED" | "SERVICE_UNAVAILABLE" | "REQUEST_TIMEOUT" | "INVALID_CREDENTIALS" | "ORIGIN_REJECTED" | "CSRF_REJECTED" | "NOT_A_MEMBER" | "ADMIN_REQUIRED" | "CONTROLLER_REQUIRED" | "INVALID_NAME" | "USERNAME_OR_PASSWORD_INVALID" | "USERNAME_TAKEN" | "ALREADY_AUTHENTICATED" | "AVATAR_INVALID" | "AVATAR_TOO_LARGE" | "AVATAR_VERSION_CONFLICT" | "AVATAR_OPERATION_CONFLICT" | "AVATAR_PROCESSING_FAILED" | "AVATAR_PROCESSING_TIMEOUT" | "REGISTRATION_INVITE_INVALID" | "REGISTRATION_INVITE_ALREADY_USED" | "REGISTRATION_BATCH_CONFLICT" | "REGISTRATION_BATCH_ALREADY_CREATED" | "INVALID_INVITE" | "ROOM_FULL" | "ROOM_NOT_ACTIVE" | "ROOM_LIFECYCLE_CONFLICT" | "PAIR_CODE_INVALID" | "AGENT_TOKEN_REQUIRED" | "INVALID_AGENT" | "INVALID_SOURCE" | "MEDIA_ROOT_UNAVAILABLE" | "SOURCE_ROOT_UNAVAILABLE" | "OUTSIDE_MEDIA_ROOT" | "INVALID_SOURCE_URL" | "SOURCE_SCAN_FAILED" | "SOURCE_IN_USE" | "SOURCE_MANAGED_ELSEWHERE" | "TOO_MANY_PLAYBACK_SESSIONS" | "MEDIA_QUEUE_FULL" | "PLAYBACK_REQUEST_CONFLICT" | "PLAYBACK_REQUEST_IN_PROGRESS" | "PLAYBACK_REQUEST_INTERRUPTED" | "PLAYBACK_REQUEST_EXPIRED" | "PLAYBACK_REQUEST_RETRY_EXHAUSTED" | "PLAYBACK_REQUEST_CANCELLED" | "UNSUPPORTED_OBSERVATION_VERSION" | "OBSERVATION_VERSION_REQUIRED" | "INVALID_OBSERVATION" | "INVALID_OBSERVATION_SEQUENCE" | "OBSERVATION_SEQUENCE_STALE" | "OBSERVATION_CONFLICT" | "INVALID_OBSERVATION_POSITION" | "INVALID_OBSERVATION_RATE" | "OBSERVATION_NOT_COMPLETE" | "STALE_MEDIA" | "INVALID_PLAN_GENERATION" | "PLAYBACK_VIEWER_LIMIT_EXCEEDED" | "PLAYBACK_VIEWER_ORIGIN_REQUIRED" | "STALE_PLAYBACK_PLAN" | "INVALID_POSITION" | "INVALID_RATE" | "NO_MEDIA" | "INVALID_MODE" | "UNSUPPORTED_VIDEO_OR_HDR" | "HDR_UNSUPPORTED" | "DRM_UNSUPPORTED" | "UNSUPPORTED_TIMELINE" | "UPSTREAM_PLAYBACK_FAILED" | "UPSTREAM_POLICY_DENIED" | "UPSTREAM_POLICY_CHANGED" | "UPSTREAM_POLICY_UNAVAILABLE" | "NO_MEDIA_SOURCE" | "INVALID_UPSTREAM_BASE" | "UPSTREAM_NO_COMPATIBLE_STREAM" | "SOURCE_PROBE_FAILED" | "SOURCE_CHANGED" | "SOURCE_VERSION_REQUIRED" | "SOURCE_SEEK_UNSUPPORTED" | "STALE_CAPABILITY_REPORT" | "INVALID_AUDIO_TRACK" | "DEVICE_HAS_NO_COMPATIBLE_PLAYBACK_TRANSPORT" | "UPSTREAM_DEVICE_PROFILE_REQUIRED" | "PROTOCOL_VERSION" | "ROOM_MISMATCH" | "REVISION_CONFLICT" | "COMMAND_OWNED_BY_ANOTHER_USER" | "COMMAND_PAYLOAD_CONFLICT" | "COMMAND_REPLAY_UNVERIFIABLE" | "CONTROL_EPOCH_REQUIRED" | "CONTROL_EPOCH_EXPIRED" | "DATABASE_ERROR" | "COMMIT_FAILED" | "ROOM_BUSY" | "MEDIA_NOT_FOUND" | "MEDIA_TITLE_INVALID" | "MEDIA_TITLE_CONFLICT" | "MEDIA_PREVIEW_STALE" | "MEDIA_PREVIEW_QUEUE_FULL" | "MEDIA_PREVIEW_UNAVAILABLE" | "MEDIA_UNAVAILABLE" | "INVALID_PLAYBACK_SESSION" | "PROBE_BUSY" | "INVALID_SUBTITLE" | "CROSS_ORIGIN_SUBTITLE" | "INVALID_RESOURCE" | "MEDIA_JOB_FAILED" | "MEDIA_INPUT_INVALID" | "MEDIA_INPUT_DENIED" | "MEDIA_DECODER_UNAVAILABLE" | "MEDIA_ENCODER_UNAVAILABLE" | "CACHE_CAPACITY_EXCEEDED" | "CACHE_READ_ONLY" | "CACHE_PERMISSION_DENIED" | "MEDIA_JOB_CANCELLED" | "MEDIA_JOB_RETRY_EXHAUSTED" | "INVALID_RESOURCE_SIGNATURE" | "WRONG_RESOURCE_SESSION" | "CROSS_ORIGIN_MEDIA_REJECTED" | "UPSTREAM_MEDIA_ERROR" | "MANIFEST_TOO_LARGE" | "AGENT_OFFLINE" | "AGENT_TIMEOUT" | "INVALID_TRANSFER" | "TRANSFER_EXPIRED";
export type ApiError = { code: ErrorCode, message: string, retryable: boolean, retry_after_ms?: number, request_id: string, };
export type ErrorResponse = { error: ApiError, };
