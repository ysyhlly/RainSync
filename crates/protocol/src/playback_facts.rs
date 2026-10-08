//! Additive plan facts. Missing evidence stays unknown rather than inferred.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Subtitle delivery available in the plan, independent of local selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum SubtitleDeliveryMode {
    None,
    ExternalVtt,
    BurnedIn,
}

/// A next request mode justified by existing source/output evidence. It is
/// neither authorization nor a guarantee that the device will decode it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum DecoderFallbackMode {
    Remux,
    Transcode,
}

/// A measured or otherwise established interval in original-media time.
/// The start is inclusive and the end is exclusive; an empty interval is omitted.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackMediaRange {
    #[schemars(range(min = 0))]
    pub start_ms: f64,
    #[schemars(range(min = 0))]
    pub end_ms: f64,
}
impl<'de> Deserialize<'de> for PlaybackMediaRange {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Range {
            start_ms: f64,
            end_ms: f64,
        }
        let range = Range::deserialize(deserializer)?;
        Self::new(range.start_ms, range.end_ms)
            .ok_or_else(|| <D::Error as serde::de::Error>::custom("invalid playback media range"))
    }
}
impl PlaybackMediaRange {
    pub fn new(start_ms: f64, end_ms: f64) -> Option<Self> {
        (start_ms.is_finite() && end_ms.is_finite() && start_ms >= 0.0 && end_ms > start_ms)
            .then_some(Self { start_ms, end_ms })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PlaybackPlan, PlaybackReadiness};
    use serde_json::json;

    #[test]
    fn ranges_require_positive_finite_intervals() {
        assert_eq!(PlaybackMediaRange::new(5.0, 6.0).unwrap().start_ms, 5.0);
        for (start, end) in [
            (-1.0, 1.0),
            (0.0, 0.0),
            (2.0, 1.0),
            (f64::NAN, 2.0),
            (0.0, f64::INFINITY),
        ] {
            assert!(PlaybackMediaRange::new(start, end).is_none());
        }
        for invalid in [
            json!({"start_ms":-1,"end_ms":1}),
            json!({"start_ms":2,"end_ms":1}),
            json!({"start_ms":0,"end_ms":0}),
            json!({"start_ms":0,"end_ms":null}),
        ] {
            assert!(serde_json::from_value::<PlaybackMediaRange>(invalid).is_err());
        }
    }

    #[test]
    fn legacy_plans_preserve_absent_facts_and_known_empty_is_distinct() {
        let legacy = json!({
            "session_id":"00000000-0000-0000-0000-000000000001",
            "media_id":"00000000-0000-0000-0000-000000000002",
            "media_generation":0,"delivery_mode":"direct","transport":"progressive",
            "playback_url":"/owned","timeline_origin_ms":0.0,"duration_ms":null,
            "expires_in_seconds":1800,"rebuild_on_seek":false,
            "audio_tracks":[],"subtitle_tracks":[]
        });
        let mut plan: PlaybackPlan = serde_json::from_value(legacy).unwrap();
        let absent = serde_json::to_value(&plan).unwrap();
        for key in [
            "selected_output",
            "subtitle_mode",
            "seekable_media_ranges_ms",
            "pending_job_id",
            "decoder_fallback_modes",
        ] {
            assert!(absent.get(key).is_none());
        }
        plan.subtitle_mode = Some(SubtitleDeliveryMode::None);
        plan.seekable_media_ranges_ms = Some(vec![]);
        plan.decoder_fallback_modes = Some(vec![]);
        let known = serde_json::to_value(plan).unwrap();
        assert_eq!(known["subtitle_mode"], "none");
        assert_eq!(known["seekable_media_ranges_ms"], json!([]));
        assert_eq!(known["decoder_fallback_modes"], json!([]));
        assert!(known.get("pending_job_id").is_none());
    }

    #[test]
    fn legacy_readiness_and_unknown_enum_values_stay_explicit() {
        let value = json!({"session_id":"00000000-0000-0000-0000-000000000001","status":"ready","complete":true,"available_until_ms":null});
        let old: PlaybackReadiness = serde_json::from_value(value).unwrap();
        assert!(old.seekable_media_ranges_ms.is_none());
        assert!(old.pending_job_id.is_none());
        assert!(serde_json::from_value::<DecoderFallbackMode>(json!("auto")).is_err());
        assert_eq!(
            serde_json::from_value::<SubtitleDeliveryMode>(json!("burned_in")).unwrap(),
            SubtitleDeliveryMode::BurnedIn
        );
        assert!(
            serde_json::from_value::<PlaybackMediaRange>(
                json!({"start_ms":0,"end_ms":1,"unknown":2})
            )
            .is_err()
        );
    }
}
