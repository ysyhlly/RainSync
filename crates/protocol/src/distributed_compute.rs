use super::*;
/// Dedicated primary endpoint only. An output ID is a choice, never authority.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DistributedComputePlaybackIntent {
    #[schemars(range(min = 1, max = 1))]
    pub schema_version: u32,
    pub job_id: Uuid,
    pub output_generation: Uuid,
}
/// Independently server-verified output and authenticated NAS source measurements.
/// This is qualification evidence, not observed browser playback.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DistributedComputePlaybackFacts {
    pub schema_version: u32,
    pub job_id: Uuid,
    pub output_generation: Uuid,
    pub attempt: u32,
    pub qualification_sha256: String,
    pub manifest_sha256: String,
    pub directory_url: String,
    pub p2p_enabled: bool,
    pub source_video_index: u32,
    pub source_audio_index: Option<u32>,
    pub video_codec: String,
    pub width: u32,
    pub height: u32,
    pub audio_codec: Option<String>,
    pub audio_channels: Option<u32>,
    pub audio_sample_rate: Option<u32>,
    pub source_duration_ms: f64,
    pub timestamp_shift_ms: f64,
}
