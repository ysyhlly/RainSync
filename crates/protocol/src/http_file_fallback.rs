//! Optional, single-hop continuation of a verified HTTP file representation.
use crate::PlaybackObservation;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

pub const HTTP_FILE_FALLBACK_VERSION: u32 = 1;

/// A parent ID is only an authenticated lookup key, never a bearer grant.
/// The final observation is captured once before detaching the parent's media.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HttpFileFallback {
    pub parent_session_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub final_observation: Option<PlaybackObservation>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PlaybackRequest;
    use serde_json::json;

    #[test]
    fn legacy_request_hash_input_omits_unnegotiated_fields() {
        let request: PlaybackRequest = serde_json::from_value(json!({
            "room_id":"00000000-0000-0000-0000-000000000001",
            "media_generation":0,"position_ms":0
        }))
        .unwrap();
        let value = serde_json::to_value(request).unwrap();
        assert!(value.get("http_file_fallback_version").is_none());
        assert!(value.get("http_file_fallback").is_none());
    }

    #[test]
    fn parent_lookup_cannot_carry_client_identity_or_source_evidence() {
        let parent = json!({"parent_session_id":"00000000-0000-0000-0000-000000000001"});
        let parsed: HttpFileFallback = serde_json::from_value(parent.clone()).unwrap();
        assert!(parsed.final_observation.is_none());
        for field in ["url", "etag", "source_id", "login_hash", "membership_epoch"] {
            let mut value = parent.clone();
            value[field] = json!("untrusted");
            assert!(serde_json::from_value::<HttpFileFallback>(value).is_err());
        }
    }
}
