//! Closed, opt-in transforms for freshly probed owned local media.
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AdvancedPlaybackRequest {
    #[schemars(range(min = 1, max = 1))]
    pub schema_version: u8,
    pub tone_map_hdr: bool,
    pub subtitle_stream_index: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AdvancedSubtitleCodec {
    Ass,
    Ssa,
    Pgs,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AdvancedSubtitleTrack {
    pub index: u32,
    pub codec: AdvancedSubtitleCodec,
    pub label: String,
    pub language: String,
}

/// Source eligibility only. The Worker independently checks its real FFmpeg
/// inventory and owned input before running; no device execution is asserted.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AdvancedPlaybackCapabilities {
    #[schemars(range(min = 1, max = 1))]
    pub schema_version: u8,
    pub tone_map_hdr: bool,
    pub subtitle_streams: Vec<AdvancedSubtitleTrack>,
    pub worker_runtime_required: bool,
}

/// Committed constrained recipe intent, never a measured encoder result.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AdvancedPlaybackFacts {
    pub request: AdvancedPlaybackRequest,
    pub subtitle_codec: Option<AdvancedSubtitleCodec>,
    pub video_basis: PlaybackOutputBasis,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn advanced_request_is_closed_and_stream_zero_is_preserved() {
        let value = json!({"schema_version":1,"tone_map_hdr":false,"subtitle_stream_index":0});
        let request: AdvancedPlaybackRequest = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(request.subtitle_stream_index, Some(0));
        assert_eq!(serde_json::to_value(request).unwrap(), value);
        for key in ["filter", "device", "fontsdir", "force_style", "source_path"] {
            let mut extra = value.clone();
            extra[key] = json!("untrusted");
            assert!(serde_json::from_value::<AdvancedPlaybackRequest>(extra).is_err());
        }
    }

    #[test]
    fn advanced_intent_is_absent_for_legacy_and_changes_canonical_request() {
        let legacy = json!({"room_id":Uuid::nil(),"media_generation":1});
        let mut request: PlaybackRequest = serde_json::from_value(legacy).unwrap();
        let original = serde_json::to_string(&request).unwrap();
        assert!(
            serde_json::to_value(&request)
                .unwrap()
                .get("advanced_playback")
                .is_none()
        );
        request.advanced_playback = Some(AdvancedPlaybackRequest {
            schema_version: 1,
            tone_map_hdr: true,
            subtitle_stream_index: None,
        });
        let first = serde_json::to_string(&request).unwrap();
        assert_ne!(original, first);
        request
            .advanced_playback
            .as_mut()
            .unwrap()
            .subtitle_stream_index = Some(0);
        assert_ne!(first, serde_json::to_string(&request).unwrap());
    }
}
