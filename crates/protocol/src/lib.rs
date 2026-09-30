use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

mod presence;
pub use presence::{PRESENCE_VERSION, PresenceMember, PresenceSnapshot};

mod errors;
pub use errors::{ApiError, ErrorCode, ErrorResponse};
mod playback_candidates;
pub use playback_candidates::*;

pub const VERSION: u8 = 1;
/// Unknown-duration media is bounded to one week. Known durations are authoritative.
pub const UNKNOWN_DURATION_LIMIT_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
pub fn bounded_position(position: f64, duration: Option<f64>) -> f64 {
    position.max(0.0).min(
        duration
            .filter(|d| d.is_finite() && *d >= 0.0)
            .unwrap_or(UNKNOWN_DURATION_LIMIT_MS),
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackStatus {
    Playing,
    Paused,
    Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
pub struct RoomState {
    pub room_id: Uuid,
    pub revision: u32,
    pub media_id: Option<Uuid>,
    pub media_generation: u32,
    pub playback_status: PlaybackStatus,
    pub anchor_position_ms: f64,
    pub anchor_server_time_ms: f64,
    pub playback_rate: f64,
    pub controller_user_id: Uuid,
    pub duration_ms: Option<f64>,
    pub clock_epoch: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", content = "payload", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Action {
    Play,
    Pause,
    Seek { position_ms: f64 },
    SetRate { rate: f64 },
    ChangeMedia { media_id: Uuid },
    EndMedia { position_ms: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct Command {
    pub protocol_version: u8,
    pub room_id: Uuid,
    pub command_id: Uuid,
    // Optional on decode so legacy clients get a specific resynchronization error.
    #[serde(default)]
    #[ts(optional)]
    pub control_epoch: Option<Uuid>,
    pub expected_revision: u32,
    pub media_generation: u32,
    #[serde(flatten)]
    pub action: Action,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ControlEpoch {
    pub id: Uuid,
    #[ts(type = "number")]
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackPlan {
    pub session_id: Uuid,
    /// Per-viewer intent generation; absent for legacy grants. Never room revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[schemars(range(min = 1))]
    pub plan_generation: Option<u32>,
    pub media_id: Uuid,
    pub media_generation: u32,
    pub delivery_mode: String,
    pub transport: String,
    pub playback_url: String,
    pub timeline_origin_ms: f64,
    pub duration_ms: Option<f64>,
    pub expires_in_seconds: u32,
    pub rebuild_on_seek: bool,
    pub audio_tracks: Vec<MediaTrack>,
    pub subtitle_tracks: Vec<MediaTrack>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub decision_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub selected_audio_track: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub selected_candidate_id: Option<String>,
    /// Present only when this grant negotiated actual viewer observations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub observation_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub observation_seq: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackObservationEvent {
    Playing,
    Pause,
    Progress,
    Seeking,
    Seeked,
    Buffering,
    Ended,
}

/// An immutable sample of the actual media element, relative to its plan.
/// `has_played` is cumulative for that grant, even when the latest sample pauses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackObservation {
    pub media_generation: u32,
    #[ts(type = "number")]
    pub seq: u64,
    pub event: PlaybackObservationEvent,
    pub media_time_ms: f64,
    pub paused: bool,
    pub seeking: bool,
    pub buffering: bool,
    pub playback_rate: f64,
    pub has_played: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackObservationReceipt {
    pub session_id: Uuid,
    #[ts(type = "number")]
    pub observation_seq: u64,
    pub has_played: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PreparationStatus {
    Queued,
    Preparing,
    Ready,
}

/// Ready means the entry can be loaded, not that the entire movie is encoded.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackReadiness {
    pub session_id: Uuid,
    /// Echoes the immutable grant generation, independent of job attempts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[schemars(range(min = 1))]
    pub plan_generation: Option<u32>,
    pub status: PreparationStatus,
    pub complete: bool,
    /// Exclusive end of the published prefix, relative to the plan's timeline origin.
    /// None means this source/legacy output has no measured generated interval.
    pub available_until_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub observation_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub observation_seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct MediaTrack {
    pub index: u32,
    pub label: String,
    pub language: String,
    pub url: Option<String>,
}

/// Browser MIME-type hints are not guarantees for arbitrary media or hardware.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum MediaTypeSupport {
    Unknown,
    Unsupported,
    Maybe,
    Probably,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct VideoCapabilityConfiguration {
    pub content_type: String,
    pub width: u32,
    pub height: u32,
    pub bitrate: u32,
    pub framerate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct AudioCapabilityConfiguration {
    pub content_type: String,
    pub channels: String,
    pub bitrate: u32,
    pub samplerate: u32,
}

/// Estimates apply only to the accompanying configuration and decoding path.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct MediaDecodingSupport {
    pub supported: bool,
    pub smooth: bool,
    pub power_efficient: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct MediaCapabilityCandidate {
    /// Combined container/codec MIME type tested through canPlayType and MSE.
    pub content_type: String,
    pub video: VideoCapabilityConfiguration,
    pub audio: AudioCapabilityConfiguration,
    pub progressive: MediaTypeSupport,
    /// Omitted means unavailable or failed, not supported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mse_supported: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub file_decoding: Option<MediaDecodingSupport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mse_decoding: Option<MediaDecodingSupport>,
}

/// A small set of concrete sample hints, not a device-wide codec/size guarantee.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct CapabilityReport {
    pub schema_version: u32,
    pub candidates: Vec<MediaCapabilityCandidate>,
}

/// Independently detected transports; MSE support does not imply progressive support.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackCapabilities {
    pub progressive_h264_aac: bool,
    pub native_hls: bool,
    pub mse_h264_aac: bool,
    /// Optional additive hints. Old clients retain the original transport gates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub report: Option<CapabilityReport>,
}

/// Missing optional fields preserve the original v1 playback request defaults.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackRequest {
    /// Opaque per-player identity for ordering only, never authorization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub viewer_id: Option<Uuid>,
    /// Positive monotonic intent generation within user/room/viewer scope.
    /// Must be supplied together with viewer_id; same-key retries retain it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[schemars(range(min = 1))]
    pub plan_generation: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub idempotency_key: Option<Uuid>,
    pub room_id: Uuid,
    pub media_generation: u32,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub position_ms: f64,
    #[serde(default)]
    pub audio_index: Option<u32>,
    #[serde(default)]
    pub capabilities: Option<PlaybackCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub observation_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub candidate_report: Option<PlaybackCandidateReport>,
}

impl PlaybackCapabilities {
    fn h264_aac_sample(&self) -> Option<&MediaCapabilityCandidate> {
        self.report
            .as_ref()
            .filter(|report| report.schema_version == 1)?
            .candidates
            .iter()
            .find(|candidate| {
                candidate.content_type == "video/mp4; codecs=\"avc1.640028, mp4a.40.2\""
            })
    }
    pub fn supports_progressive(&self) -> bool {
        self.progressive_h264_aac
            && self.h264_aac_sample().is_none_or(|sample| {
                matches!(
                    sample.progressive,
                    MediaTypeSupport::Maybe | MediaTypeSupport::Probably
                )
            })
    }
    pub fn supports_hls(&self) -> bool {
        // Native HLS is independent of progressive and MSE MP4 decoding.
        // Sample-specific decodingInfo estimates cannot blacklist a codec family.
        self.native_hls
            || (self.mse_h264_aac
                && self
                    .h264_aac_sample()
                    .is_none_or(|sample| sample.mse_supported == Some(true)))
    }
    pub fn negotiate<'a>(&self, mode: &'a str, transport: &'a str) -> Option<(&'a str, &'a str)> {
        if transport == "hls" || mode != "direct" {
            return self.supports_hls().then_some((mode, "hls"));
        }
        if self.supports_progressive() {
            Some((mode, transport))
        } else {
            self.supports_hls().then_some(("remux", "hls"))
        }
    }
}

#[cfg(test)]
mod capability_tests {
    use super::*;
    #[test]
    fn legacy_playback_requests_keep_defaults() {
        let request: PlaybackRequest = serde_json::from_value(serde_json::json!({
            "room_id": Uuid::nil(), "media_generation": 1
        }))
        .unwrap();
        assert_eq!(request.position_ms, 0.0);
        assert!(request.mode.is_none());
        assert!(request.audio_index.is_none());
        assert!(request.capabilities.is_none());
        assert!(request.observation_version.is_none());
        assert!(request.candidate_report.is_none());
        assert!(request.viewer_id.is_none());
        assert!(request.plan_generation.is_none());
    }
    #[test]
    fn plan_generation_fields_are_additive_and_bounded_on_decode() {
        let legacy = serde_json::json!({"room_id": Uuid::nil(), "media_generation": 1});
        let request: PlaybackRequest = serde_json::from_value(legacy.clone()).unwrap();
        let canonical = serde_json::to_value(request).unwrap();
        assert!(canonical.get("viewer_id").is_none());
        assert!(canonical.get("plan_generation").is_none());
        let mut current = legacy;
        current["viewer_id"] = serde_json::json!(Uuid::new_v4());
        current["plan_generation"] = serde_json::json!(u32::MAX);
        let request: PlaybackRequest = serde_json::from_value(current.clone()).unwrap();
        assert_eq!(request.plan_generation, Some(u32::MAX));
        for value in [
            serde_json::json!(-1),
            serde_json::json!(4294967296_u64),
            serde_json::json!(1.5),
        ] {
            current["plan_generation"] = value;
            assert!(serde_json::from_value::<PlaybackRequest>(current.clone()).is_err());
        }
    }

    #[test]
    fn refuses_unplayable_output_and_distinguishes_transports() {
        let mut caps = PlaybackCapabilities {
            progressive_h264_aac: true,
            native_hls: false,
            mse_h264_aac: false,
            report: None,
        };
        assert_eq!(
            caps.negotiate("direct", "progressive"),
            Some(("direct", "progressive"))
        );
        assert_eq!(caps.negotiate("transcode", "hls"), None);
        caps.progressive_h264_aac = false;
        assert_eq!(caps.negotiate("direct", "progressive"), None);
        caps.native_hls = true;
        assert_eq!(
            caps.negotiate("direct", "progressive"),
            Some(("remux", "hls"))
        );
    }

    #[test]
    fn observation_contract_requires_actual_flags_and_integral_sequence() {
        let payload = serde_json::json!({
            "media_generation":1,"seq":1,"event":"pause","media_time_ms":10.25,
            "paused":true,"seeking":false,"buffering":false,"playback_rate":1.5,"has_played":true
        });
        let sample: PlaybackObservation = serde_json::from_value(payload.clone()).unwrap();
        assert_eq!(serde_json::to_value(sample).unwrap(), payload);
        for invalid in ["extra", "missing", "fractional_seq"] {
            let mut candidate = payload.clone();
            match invalid {
                "extra" => candidate["room_clock"] = serde_json::json!(50),
                "missing" => {
                    candidate.as_object_mut().unwrap().remove("has_played");
                }
                _ => candidate["seq"] = serde_json::json!(1.5),
            }
            assert!(serde_json::from_value::<PlaybackObservation>(candidate).is_err());
        }
    }
    #[test]
    fn legacy_capabilities_keep_their_transport_gates() {
        let caps: PlaybackCapabilities = serde_json::from_value(serde_json::json!({
            "progressive_h264_aac": true, "native_hls": false, "mse_h264_aac": false
        }))
        .unwrap();
        assert!(caps.report.is_none());
        assert!(caps.supports_progressive());
        assert_eq!(
            caps.negotiate("direct", "progressive"),
            Some(("direct", "progressive"))
        );
        assert!(serde_json::to_value(caps).unwrap().get("report").is_none());
    }
    #[test]
    fn concrete_mime_hints_constrain_negotiation_without_assuming_native_support() {
        let mut caps: PlaybackCapabilities = serde_json::from_value(serde_json::json!({
            "progressive_h264_aac": true, "native_hls": false, "mse_h264_aac": true,
            "report": {"schema_version": 1, "candidates": [{
                "content_type": "video/mp4; codecs=\"avc1.640028, mp4a.40.2\"",
                "video": {"content_type": "video/mp4; codecs=\"avc1.640028\"",
                    "width": 1920, "height": 1080, "bitrate": 8000000, "framerate": 30.0},
                "audio": {"content_type": "audio/mp4; codecs=\"mp4a.40.2\"",
                    "channels": "2", "bitrate": 128000, "samplerate": 48000},
                "progressive": "unsupported", "mse_supported": true,
                "mse_decoding": {"supported": false, "smooth": false, "power_efficient": false}
            }]}
        }))
        .unwrap();
        assert!(!caps.supports_progressive());
        assert_eq!(
            caps.negotiate("direct", "progressive"),
            Some(("remux", "hls"))
        );
        caps.report.as_mut().unwrap().candidates[0].mse_supported = Some(false);
        assert_eq!(caps.negotiate("direct", "progressive"), None);
        caps.native_hls = true;
        assert_eq!(
            caps.negotiate("direct", "progressive"),
            Some(("remux", "hls"))
        );
        // Future report semantics must not break existing transport negotiation.
        caps.report.as_mut().unwrap().schema_version = 2;
        assert!(caps.supports_progressive());
    }
}
