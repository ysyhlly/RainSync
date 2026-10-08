//! Finite observations of bytes produced by one already-owned upstream SID.
//! These facts never authorize another negotiation, recipe, or whole-title claim.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpstreamMeasuredVideo {
    pub codec: String,
    pub profile: String,
    pub width: u32,
    pub height: u32,
    pub pixel_format: String,
    pub frame_rate: f64,
    pub decoded_frames: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpstreamMeasuredAudio {
    pub codec: String,
    pub profile: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub decoded_frames: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpstreamMeasuredOutput {
    pub schema_version: u8,
    pub semantics: String,
    pub session_id: Uuid,
    pub plan_generation: Option<u32>,
    /// SHA-256 identities avoid exposing provider session identifiers/URLs.
    pub upstream_sid_sha256: String,
    pub route_sha256: String,
    pub representation_sha256: String,
    pub measured_bytes: u32,
    pub measured_segments: u8,
    pub manifest_duration_ms: f64,
    pub video: UpstreamMeasuredVideo,
    pub audio: Option<UpstreamMeasuredAudio>,
    pub process_tree_reaped: bool,
}
