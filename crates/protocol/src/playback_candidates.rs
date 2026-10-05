use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackCandidateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[schemars(range(min = 1, max = 1))]
    pub local_hls_ladder_capabilities_version: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_hls_ladder: Option<LocalHlsLadderRequest>,
    /// Opt in to source-eligible advanced controls while retaining legacy
    /// candidate/error behavior for clients that omit this offer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[schemars(range(min = 1, max = 1))]
    pub advanced_playback_capabilities_version: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub advanced_playback: Option<AdvancedPlaybackRequest>,
    /// Opt in to version-bound, reliable single-file HTTP candidates.
    /// Omitted by explicit-direct requests, which must not force source probing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub http_file_capabilities_version: Option<u8>,
    pub room_id: Uuid,
    pub media_generation: u32,
    #[serde(default)]
    pub audio_index: Option<u32>,
    #[serde(default)]
    pub position_ms: f64,
}

/// A server-issued exact input/output configuration, not an arbitrary device profile.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackCandidate {
    pub id: String,
    pub delivery_mode: String,
    pub transport: String,
    pub content_type: String,
    pub video: VideoCapabilityConfiguration,
    pub audio: Option<AudioCapabilityConfiguration>,
}

/// Why the server offered or omitted a route, before any device test.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackRouteReason {
    SourceConfiguration,
    ConstrainedEncoderRecipe,
    VideoConfigurationUnavailable,
    VideoCopyUnsupported,
    SampleEntryUnsupported,
    VideoTransformRequired,
    ContainerUnsupported,
    TrackMappingRequired,
    AudioConfigurationUnavailable,
    NoAudioTrack,
    NonzeroCopyOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackRouteDecision {
    pub candidate_id: String,
    /// Offered for concrete client testing, not proven device decoding.
    pub offered: bool,
    pub reason: PlaybackRouteReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackOutputBasis {
    SourceProbe,
    ConstrainedEncoderRecipe,
}

/// Bound selected configuration. Neither basis is measured encoded output or
/// an observation of playback; copied and encoded tracks have separate bases.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackSelectedOutput {
    pub configuration: PlaybackCandidate,
    pub video_basis: PlaybackOutputBasis,
    pub audio_basis: Option<PlaybackOutputBasis>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackCandidateSet {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_hls_ladder: Option<LocalHlsLadderCapabilities>,
    /// Fresh local source eligibility, independent of Worker device support.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub advanced_playback: Option<AdvancedPlaybackCapabilities>,
    pub schema_version: u32,
    /// Present only for a verified HTTP Binary binding. The client retains the
    /// original binding across automatic route changes within the same intent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub http_file_capabilities_version: Option<u8>,
    pub binding: Option<String>,
    pub candidates: Vec<PlaybackCandidate>,
    pub decision_reason: String,
    /// At most the four server routes. Absent on legacy/unsupported providers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub route_decisions: Option<Vec<PlaybackRouteDecision>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackCandidateResult {
    pub candidate_id: String,
    pub progressive: MediaTypeSupport,
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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackCandidateReport {
    pub binding: String,
    pub results: Vec<PlaybackCandidateResult>,
    /// Bounded client decode-failure history; never changes authorization.
    #[serde(default)]
    pub excluded_candidates: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_candidates_are_explicitly_negotiated_without_changing_legacy_shapes() {
        let legacy = serde_json::json!({
            "room_id": Uuid::nil(), "media_generation": 0,
            "audio_index": null, "position_ms": 0.0
        });
        let mut request: PlaybackCandidateRequest = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(request.http_file_capabilities_version, None);
        assert_eq!(serde_json::to_value(&request).unwrap(), legacy);
        request.http_file_capabilities_version = Some(1);
        assert_eq!(
            serde_json::to_value(request).unwrap()["http_file_capabilities_version"],
            1
        );

        let mut response = PlaybackCandidateSet {
            local_hls_ladder: None,
            advanced_playback: None,
            schema_version: 1,
            http_file_capabilities_version: None,
            binding: None,
            candidates: Vec::new(),
            decision_reason: "provider_requires_legacy_negotiation".into(),
            route_decisions: None,
        };
        let legacy_response = serde_json::to_value(&response).unwrap();
        assert!(legacy_response.get("route_decisions").is_none());
        assert!(
            serde_json::from_value::<PlaybackRouteReason>(serde_json::json!("device_supported"))
                .is_err()
        );
        assert!(
            serde_json::from_value::<PlaybackOutputBasis>(serde_json::json!("measured_output"))
                .is_err()
        );
        assert!(
            legacy_response
                .get("http_file_capabilities_version")
                .is_none()
        );
        assert!(
            serde_json::from_value::<PlaybackCandidateSet>(legacy_response)
                .unwrap()
                .http_file_capabilities_version
                .is_none()
        );
        response.http_file_capabilities_version = Some(1);
        assert_eq!(
            serde_json::to_value(response).unwrap()["http_file_capabilities_version"],
            1
        );
    }
}
