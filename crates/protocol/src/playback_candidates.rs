use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackCandidateRequest {
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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PlaybackCandidateSet {
    pub schema_version: u32,
    pub binding: Option<String>,
    pub candidates: Vec<PlaybackCandidate>,
    pub decision_reason: String,
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
