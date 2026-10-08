//! Closed local-only multirendition HLS intent and constrained recipe facts.
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct LocalHlsLadderRequest {
    #[schemars(range(min = 1, max = 1))]
    pub schema_version: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct LocalHlsRendition {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub bandwidth: u32,
    pub codecs: String,
}

/// Fresh local source eligibility; Worker runtime/output qualification is separate.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct LocalHlsLadderCapabilities {
    #[schemars(range(min = 1, max = 1))]
    pub schema_version: u8,
    pub renditions: Vec<LocalHlsRendition>,
    pub worker_runtime_required: bool,
}

/// Exact server master recipe, never the client's currently decoded level.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct LocalHlsLadderFacts {
    pub request: LocalHlsLadderRequest,
    pub renditions: Vec<LocalHlsRendition>,
    pub video_basis: PlaybackOutputBasis,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn intent_is_closed_and_legacy_hash_remains_unchanged() {
        let original = serde_json::json!({"room_id": Uuid::nil(), "media_generation":1});
        let mut request: PlaybackRequest = serde_json::from_value(original).unwrap();
        let legacy = serde_json::to_string(&request).unwrap();
        assert!(
            serde_json::to_value(&request)
                .unwrap()
                .get("local_hls_ladder")
                .is_none()
        );
        request.local_hls_ladder = Some(LocalHlsLadderRequest { schema_version: 1 });
        assert_ne!(legacy, serde_json::to_string(&request).unwrap());
        for key in ["renditions", "path", "encoder", "filter", "device"] {
            let mut input = serde_json::json!({"schema_version":1});
            input[key] = serde_json::json!("untrusted");
            assert!(serde_json::from_value::<LocalHlsLadderRequest>(input).is_err());
        }
    }
}
