//! Optional client-reported playback measurement contract, independent of observations v1.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;
pub const PLAYBACK_METRICS_VERSION: u32 = 1;
pub const PLAYBACK_METRICS_MAX_ELAPSED_MS: u32 = 604_800_000;
pub const PLAYBACK_METRICS_MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
pub const PLAYBACK_METRICS_MAX_CAPTURE_LEAD_MS: u32 = 15_000;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackMetricsOrigin {
    UserIntent,
    AutomaticLoad,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackMetricsFrameEvidence {
    VideoFrameCallback,
    PlayingTimeAdvance,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackMetricsIntent {
    #[schemars(range(min = 1))]
    pub meter_start_generation: u32,
    pub startup_origin: PlaybackMetricsOrigin,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackMetricsTotals {
    #[schemars(range(max = 604800000))]
    pub startup_ms: u32,
    #[schemars(range(max = 604800000))]
    pub autoplay_blocked_ms: u32,
    #[schemars(range(max = 604800000))]
    pub background_ms: u32,
    #[schemars(range(max = 604800000))]
    pub paused_ms: u32,
    #[schemars(range(max = 604800000))]
    pub seeking_ms: u32,
    #[schemars(range(max = 604800000))]
    pub rebuffer_ms: u32,
    #[schemars(range(max = 604800000))]
    pub playing_ms: u32,
    #[schemars(range(max = 604800000))]
    pub unobserved_ms: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackMetricsFirstFrame {
    #[schemars(range(max = 604800000))]
    pub elapsed_ms: u32,
    #[schemars(range(max = 604800000))]
    pub confirmed_elapsed_ms: u32,
    pub evidence: PlaybackMetricsFrameEvidence,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackMetricsSample {
    #[schemars(range(min = 1, max = 1))]
    pub version: u32,
    pub media_generation: u32,
    #[schemars(range(min = 1))]
    pub plan_generation: u32,
    #[schemars(range(min = 1))]
    pub meter_start_generation: u32,
    #[ts(type = "number")]
    #[schemars(range(min = 1, max = 9007199254740991_u64))]
    pub seq: u64,
    pub startup_origin: PlaybackMetricsOrigin,
    #[schemars(range(max = 604800000))]
    pub elapsed_ms: u32,
    pub totals: PlaybackMetricsTotals,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub first_frame: Option<PlaybackMetricsFirstFrame>,
    #[serde(rename = "final")]
    pub final_sample: bool,
}
/// Separate cumulative startup coverage through first-frame confirmation.
/// This is not a breakdown of the mutually exclusive playback state counters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackMetricsStartupPhases {
    #[schemars(range(max = 604800000))]
    pub preparation_ms: u32,
    #[schemars(range(max = 604800000))]
    pub loading_ms: u32,
    #[schemars(range(max = 604800000))]
    pub unobserved_ms: u32,
}
impl PlaybackMetricsStartupPhases {
    pub fn values(&self) -> [u32; 3] {
        [self.preparation_ms, self.loading_ms, self.unobserved_ms]
    }
    pub fn sum(&self) -> u64 {
        self.values().into_iter().map(u64::from).sum()
    }
    pub fn checked_delta(&self, previous: &Self) -> Option<Self> {
        Some(Self {
            preparation_ms: self.preparation_ms.checked_sub(previous.preparation_ms)?,
            loading_ms: self.loading_ms.checked_sub(previous.loading_ms)?,
            unobserved_ms: self.unobserved_ms.checked_sub(previous.unobserved_ms)?,
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackMetricsSampleV2 {
    #[schemars(range(min = 2, max = 2))]
    pub version: u32,
    pub media_generation: u32,
    #[schemars(range(min = 1))]
    pub plan_generation: u32,
    #[schemars(range(min = 1))]
    pub meter_start_generation: u32,
    #[ts(type = "number")]
    #[schemars(range(min = 1, max = 9007199254740991_u64))]
    pub seq: u64,
    pub startup_origin: PlaybackMetricsOrigin,
    #[schemars(range(max = 604800000))]
    pub elapsed_ms: u32,
    pub totals: PlaybackMetricsTotals,
    pub startup_phases: PlaybackMetricsStartupPhases,
    /// The originating published grant, never a local source callback counter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[schemars(range(min = 1))]
    pub first_frame_plan_generation: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub first_frame: Option<PlaybackMetricsFirstFrame>,
    #[serde(rename = "final")]
    pub final_sample: bool,
}
impl PlaybackMetricsSampleV2 {
    pub fn common(&self) -> PlaybackMetricsSample {
        PlaybackMetricsSample {
            version: self.version,
            media_generation: self.media_generation,
            plan_generation: self.plan_generation,
            meter_start_generation: self.meter_start_generation,
            seq: self.seq,
            startup_origin: self.startup_origin,
            elapsed_ms: self.elapsed_ms,
            totals: self.totals.clone(),
            first_frame: self.first_frame.clone(),
            final_sample: self.final_sample,
        }
    }
    pub fn valid(&self) -> bool {
        let mut common = self.common();
        common.version = 1;
        self.version == 2
            && common.valid()
            && self.startup_phases.sum()
                == u64::from(
                    self.first_frame
                        .as_ref()
                        .map_or(self.elapsed_ms, |frame| frame.confirmed_elapsed_ms),
                )
            && self
                .startup_phases
                .values()
                .iter()
                .all(|v| *v <= PLAYBACK_METRICS_MAX_ELAPSED_MS)
            && match (&self.first_frame, self.first_frame_plan_generation) {
                (None, None) => true,
                (Some(_), Some(generation)) => {
                    generation >= self.meter_start_generation && generation <= self.plan_generation
                }
                _ => false,
            }
    }
}
/// Version dispatch happens before strict DTO deserialization. An unknown or
/// mistyped version must never fall back to the more permissive other variant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum PlaybackMetricsPacket {
    V1(PlaybackMetricsSample),
    V2(PlaybackMetricsSampleV2),
}
impl<'de> Deserialize<'de> for PlaybackMetricsPacket {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Keep original JSON until the selected strict DTO reads it. Going
        // through Value here would silently collapse duplicate object keys.
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        #[derive(Deserialize)]
        struct Version {
            version: u32,
        }
        let selector: Version =
            serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
        match selector.version {
            1 => serde_json::from_str(raw.get()).map(Self::V1),
            2 => serde_json::from_str(raw.get()).map(Self::V2),
            _ => {
                return Err(serde::de::Error::custom(
                    "unsupported_playback_metrics_version",
                ));
            }
        }
        .map_err(serde::de::Error::custom)
    }
}
impl PlaybackMetricsPacket {
    pub fn common(&self) -> PlaybackMetricsSample {
        match self {
            Self::V1(sample) => sample.clone(),
            Self::V2(sample) => sample.common(),
        }
    }
    pub fn valid(&self) -> bool {
        match self {
            Self::V1(sample) => sample.valid(),
            Self::V2(sample) => sample.valid(),
        }
    }
    pub fn startup_phases(&self) -> Option<&PlaybackMetricsStartupPhases> {
        match self {
            Self::V1(_) => None,
            Self::V2(sample) => Some(&sample.startup_phases),
        }
    }
    pub fn first_frame_plan_generation(&self) -> Option<u32> {
        match self {
            Self::V1(_) => None,
            Self::V2(sample) => sample.first_frame_plan_generation,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackMetricsGrant {
    #[schemars(range(min = 1))]
    pub meter_start_generation: u32,
    pub startup_origin: PlaybackMetricsOrigin,
    #[ts(type = "number")]
    #[schemars(range(max = 9007199254740991_u64))]
    pub metrics_seq: u64,
    pub closed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_sample: Option<PlaybackMetricsSample>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackMetricsGrantV2 {
    #[schemars(range(min = 1))]
    pub meter_start_generation: u32,
    pub startup_origin: PlaybackMetricsOrigin,
    #[ts(type = "number")]
    #[schemars(range(max = 9007199254740991_u64))]
    pub metrics_seq: u64,
    pub closed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_sample: Option<PlaybackMetricsSampleV2>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum PlaybackMetricsGrantWire {
    V1(PlaybackMetricsGrant),
    V2(PlaybackMetricsGrantV2),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlaybackMetricsReceipt {
    pub session_id: Uuid,
    #[schemars(range(min = 1))]
    pub meter_start_generation: u32,
    #[ts(type = "number")]
    #[schemars(range(max = 9007199254740991_u64))]
    pub metrics_seq: u64,
    pub closed: bool,
}
impl PlaybackMetricsTotals {
    pub fn values(&self) -> [u32; 8] {
        [
            self.startup_ms,
            self.autoplay_blocked_ms,
            self.background_ms,
            self.paused_ms,
            self.seeking_ms,
            self.rebuffer_ms,
            self.playing_ms,
            self.unobserved_ms,
        ]
    }
    pub fn sum(&self) -> u64 {
        self.values().into_iter().map(u64::from).sum()
    }
    pub fn checked_delta(&self, previous: &Self) -> Option<Self> {
        Some(Self {
            startup_ms: self.startup_ms.checked_sub(previous.startup_ms)?,
            autoplay_blocked_ms: self
                .autoplay_blocked_ms
                .checked_sub(previous.autoplay_blocked_ms)?,
            background_ms: self.background_ms.checked_sub(previous.background_ms)?,
            paused_ms: self.paused_ms.checked_sub(previous.paused_ms)?,
            seeking_ms: self.seeking_ms.checked_sub(previous.seeking_ms)?,
            rebuffer_ms: self.rebuffer_ms.checked_sub(previous.rebuffer_ms)?,
            playing_ms: self.playing_ms.checked_sub(previous.playing_ms)?,
            unobserved_ms: self.unobserved_ms.checked_sub(previous.unobserved_ms)?,
        })
    }
}
impl PlaybackMetricsSample {
    pub fn valid(&self) -> bool {
        self.version == PLAYBACK_METRICS_VERSION
            && self.plan_generation > 0
            && self.meter_start_generation > 0
            && self.meter_start_generation <= self.plan_generation
            && (1..=PLAYBACK_METRICS_MAX_SEQUENCE).contains(&self.seq)
            && self.elapsed_ms <= PLAYBACK_METRICS_MAX_ELAPSED_MS
            && self
                .totals
                .values()
                .iter()
                .all(|v| *v <= PLAYBACK_METRICS_MAX_ELAPSED_MS)
            && self.totals.sum() == u64::from(self.elapsed_ms)
            && self.first_frame.as_ref().is_none_or(|frame| {
                frame.elapsed_ms <= frame.confirmed_elapsed_ms
                    && frame.confirmed_elapsed_ms <= self.elapsed_ms
            })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> PlaybackMetricsSample {
        serde_json::from_value(serde_json::json!({"version":1,"media_generation":1,"plan_generation":2,"meter_start_generation":1,"seq":1,"startup_origin":"automatic_load","elapsed_ms":5,"totals":{"startup_ms":5,"autoplay_blocked_ms":0,"background_ms":0,"paused_ms":0,"seeking_ms":0,"rebuffer_ms":0,"playing_ms":0,"unobserved_ms":0},"final":false})).unwrap()
    }
    fn v2() -> serde_json::Value {
        let mut value = serde_json::to_value(sample()).unwrap();
        value["version"] = serde_json::json!(2);
        value["startup_phases"] =
            serde_json::json!({"preparation_ms":2,"loading_ms":3,"unobserved_ms":0});
        value
    }
    #[test]
    fn strict_version_dispatch_preserves_v1_and_rejects_cross_version_fields() {
        let old = serde_json::to_value(sample()).unwrap();
        let decoded: PlaybackMetricsPacket = serde_json::from_value(old.clone()).unwrap();
        assert!(decoded.valid());
        assert_eq!(serde_json::to_value(decoded).unwrap(), old);
        let value = v2();
        assert!(
            serde_json::from_value::<PlaybackMetricsPacket>(value.clone())
                .unwrap()
                .valid()
        );
        assert!(serde_json::from_value::<PlaybackMetricsSample>(value.clone()).is_err());
        for version in [
            serde_json::json!(0),
            serde_json::json!(3),
            serde_json::json!("2"),
            serde_json::Value::Null,
        ] {
            let mut wrong = value.clone();
            wrong["version"] = version;
            assert!(serde_json::from_value::<PlaybackMetricsPacket>(wrong).is_err());
        }
        let mut wrong = value;
        wrong["version"] = serde_json::json!(1);
        assert!(serde_json::from_value::<PlaybackMetricsPacket>(wrong).is_err());
        let mut missing = old;
        missing["version"] = serde_json::json!(2);
        assert!(serde_json::from_value::<PlaybackMetricsPacket>(missing).is_err());
    }
    #[test]
    fn packet_dispatch_does_not_collapse_duplicate_json_fields() {
        for value in [serde_json::to_value(sample()).unwrap(), v2()] {
            let body = serde_json::to_string(&value).unwrap();
            for duplicate in [
                body.replacen("\"seq\":1", "\"seq\":1,\"seq\":1", 1),
                body.replacen("\"startup_ms\":5", "\"startup_ms\":5,\"startup_ms\":5", 1),
            ] {
                assert_ne!(duplicate, body);
                assert!(serde_json::from_str::<PlaybackMetricsPacket>(&duplicate).is_err());
            }
        }
        let body = serde_json::to_string(&v2()).unwrap().replacen(
            "\"preparation_ms\":2",
            "\"preparation_ms\":2,\"preparation_ms\":2",
            1,
        );
        assert!(serde_json::from_str::<PlaybackMetricsPacket>(&body).is_err());
    }
    #[test]
    fn v2_phases_cover_confirmation_and_originating_grant_is_paired_and_bounded() {
        let mut value = v2();
        value["first_frame"] = serde_json::json!({"elapsed_ms":3,"confirmed_elapsed_ms":5,"evidence":"video_frame_callback"});
        assert!(
            !serde_json::from_value::<PlaybackMetricsPacket>(value.clone())
                .unwrap()
                .valid()
        );
        value["first_frame_plan_generation"] = serde_json::json!(1);
        assert!(
            serde_json::from_value::<PlaybackMetricsPacket>(value.clone())
                .unwrap()
                .valid()
        );
        for generation in [0, 3] {
            value["first_frame_plan_generation"] = serde_json::json!(generation);
            assert!(
                !serde_json::from_value::<PlaybackMetricsPacket>(value.clone())
                    .unwrap()
                    .valid()
            );
        }
        value["first_frame_plan_generation"] = serde_json::json!(2);
        value["startup_phases"]["preparation_ms"] = serde_json::json!(3);
        assert!(
            !serde_json::from_value::<PlaybackMetricsPacket>(value)
                .unwrap()
                .valid()
        );
    }
    #[test]
    fn time_conservation_and_numeric_bounds_are_checked() {
        let mut s = sample();
        assert!(s.valid());
        s.totals.playing_ms = 1;
        assert!(!s.valid());
        s = sample();
        s.seq = PLAYBACK_METRICS_MAX_SEQUENCE + 1;
        assert!(!s.valid());
        s = sample();
        s.elapsed_ms = PLAYBACK_METRICS_MAX_ELAPSED_MS + 1;
        s.totals.startup_ms = s.elapsed_ms;
        assert!(!s.valid());
        s = sample();
        s.first_frame = Some(PlaybackMetricsFirstFrame {
            elapsed_ms: 6,
            confirmed_elapsed_ms: 6,
            evidence: PlaybackMetricsFrameEvidence::VideoFrameCallback,
        });
        assert!(!s.valid());
        s = sample();
        s.meter_start_generation = 3;
        assert!(!s.valid());
    }
    #[test]
    fn unknown_fields_and_invalid_unsigned_values_are_rejected() {
        let mut v = serde_json::to_value(sample()).unwrap();
        v["source"] = serde_json::json!("trusted");
        assert!(serde_json::from_value::<PlaybackMetricsSample>(v).is_err());
        let mut v = serde_json::to_value(sample()).unwrap();
        v["totals"]["playing_ms"] = serde_json::json!(-1);
        assert!(serde_json::from_value::<PlaybackMetricsSample>(v).is_err());
    }
    #[test]
    fn checked_delta_cannot_hide_a_category_regression() {
        let before = sample().totals;
        let mut after = before.clone();
        after.playing_ms = 7;
        assert_eq!(after.checked_delta(&before).unwrap().sum(), 7);
        after.startup_ms = 4;
        assert!(after.checked_delta(&before).is_none());
    }
}
