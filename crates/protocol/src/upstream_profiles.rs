use super::*;

pub const UPSTREAM_PROFILE_VERSION: u8 = 1;
pub const UPSTREAM_PROFILE_ID: &str = "avc_sdr_720p_v1";

/// Advisory output recipe, deliberately separate from exact media candidates.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum UpstreamProfileSemantics {
    UpstreamTranscodeProfileEnvelope,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpstreamVideoProfileBounds {
    pub codec: String,
    pub profile: String,
    pub max_level: String,
    pub max_width: u32,
    pub max_height: u32,
    pub max_framerate: u32,
    pub max_bitrate: u32,
    pub requested_bit_depth: u8,
    pub requested_range: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpstreamAudioProfileBounds {
    /// AAC is requested. A particular AAC profile is not promised by this field.
    pub codec: String,
    pub max_channels: u32,
    pub requested_sample_rate: u32,
    pub max_bitrate: u32,
}

/// A finite browser estimate for MSE after HLS transmuxing, not measured output.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpstreamProfileProbeSample {
    pub video: VideoCapabilityConfiguration,
    pub audio: Option<AudioCapabilityConfiguration>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpstreamTranscodeProfileEnvelope {
    pub profile_version: u8,
    pub profile_id: String,
    pub configuration_semantics: UpstreamProfileSemantics,
    pub transport: String,
    pub container: String,
    pub requested_video: UpstreamVideoProfileBounds,
    pub requested_audio: Option<UpstreamAudioProfileBounds>,
    pub mse_sample: UpstreamProfileProbeSample,
}

/// The dedicated endpoint only describes explicit-transcode eligibility.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpstreamProfileCandidateRequest {
    pub profile_version: u8,
    pub room_id: Uuid,
    pub media_generation: u32,
    #[serde(default)]
    pub position_ms: f64,
    #[serde(default)]
    pub audio_index: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpstreamProfileCandidateSet {
    pub profile_version: u8,
    /// Binding and profile are either both present or both absent.
    pub binding: Option<String>,
    pub profile: Option<UpstreamTranscodeProfileEnvelope>,
    pub decision_reason: String,
}

/// Only the dedicated preparation endpoint accepts this report. It grants no
/// authority and cannot describe a replacement recipe or automatic fallback.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpstreamProfileReport {
    pub profile_version: u8,
    pub binding: String,
    pub profile_id: String,
    pub mse_supported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mse_decoding: Option<MediaDecodingSupport>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_request_is_closed_and_does_not_accept_a_client_recipe() {
        let mut value = serde_json::json!({
            "profile_version": 1, "room_id": Uuid::nil(), "media_generation": 0
        });
        assert!(serde_json::from_value::<UpstreamProfileCandidateRequest>(value.clone()).is_ok());
        value["device_profile"] = serde_json::json!({});
        assert!(serde_json::from_value::<UpstreamProfileCandidateRequest>(value).is_err());
    }

    #[test]
    fn legacy_playback_request_has_no_profile_field_or_hash_input() {
        let value = serde_json::json!({
            "idempotency_key":null,"room_id":Uuid::nil(),"media_generation":0,
            "mode":null,"position_ms":0.0,"audio_index":null,"capabilities":null
        });
        let request: PlaybackRequest = serde_json::from_value(value.clone()).unwrap();
        assert!(request.upstream_profile_report.is_none());
        assert_eq!(serde_json::to_value(request).unwrap(), value);
    }

    #[test]
    fn report_does_not_accept_exact_candidate_exclusions_or_profile_overrides() {
        let mut value = serde_json::json!({
            "profile_version":1,"binding":"opaque","profile_id":UPSTREAM_PROFILE_ID,
            "mse_supported":true
        });
        assert!(serde_json::from_value::<UpstreamProfileReport>(value.clone()).is_ok());
        value["excluded_candidates"] = serde_json::json!([]);
        assert!(serde_json::from_value::<UpstreamProfileReport>(value).is_err());
    }
}
