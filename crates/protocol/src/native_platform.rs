//! Native platform playback uses ordinary room authority, but a dedicated
//! prepare/delivery contract. This public model never contains credentials,
//! platform API responses or upstream media addresses.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum NativePlatformCredentialMode {
    OwnOrAnonymous,
    Anonymous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum NativePlatformProvider {
    Bilibili,
    Douyin,
    Tiktok,
    Youtube,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum NativePlatformResolvedCredentialMode {
    OwnAccount,
    Anonymous,
}

/// Closed height ceilings. These are application policy, never extractor flags
/// or a promise that a provider has a rendition at the named height.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum NativePlatformMaxHeight {
    #[default]
    Auto,
    P144,
    P240,
    P360,
    P480,
    P720,
    P1080,
    P1440,
    P2160,
    P4320,
}
impl NativePlatformMaxHeight {
    pub fn limit(self) -> Option<u32> {
        match self {
            Self::Auto => None,
            Self::P144 => Some(144),
            Self::P240 => Some(240),
            Self::P360 => Some(360),
            Self::P480 => Some(480),
            Self::P720 => Some(720),
            Self::P1080 => Some(1080),
            Self::P1440 => Some(1440),
            Self::P2160 => Some(2160),
            Self::P4320 => Some(4320),
        }
    }
    pub fn for_height(height: u32) -> Option<Self> {
        [
            Self::P144,
            Self::P240,
            Self::P360,
            Self::P480,
            Self::P720,
            Self::P1080,
            Self::P1440,
            Self::P2160,
            Self::P4320,
        ]
        .into_iter()
        .find(|value| height > 0 && value.limit().is_some_and(|limit| height <= limit))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NativePlatformQualityIntent {
    #[schemars(range(min = 1, max = 1))]
    pub version: u32,
    pub provider: NativePlatformProvider,
    pub media_id: Uuid,
    pub max_height: NativePlatformMaxHeight,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NativePlatformQualityOption {
    pub max_height: NativePlatformMaxHeight,
    /// Observed compatible provider rendition, used for truthful UI labels.
    #[schemars(range(min = 1, max = 4320))]
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NativePlatformQualityBinding {
    #[schemars(range(min = 1, max = 1))]
    pub version: u32,
    pub requested_max_height: NativePlatformMaxHeight,
    #[schemars(range(min = 1, max = 4320))]
    pub selected_height: u32,
    #[schemars(length(min = 1, max = 9))]
    pub options: Vec<NativePlatformQualityOption>,
}

/// A closed, explicit request for the server-owned clear-media recipe.
/// It never carries extractor flags, upstream URLs or credential material.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum NativePlatformCompatibilityMode {
    HlsAvcAac,
    HlsAvcAacLadder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NativePlatformCompatibilityIntent {
    #[schemars(range(min = 1, max = 1))]
    pub version: u32,
    pub mode: NativePlatformCompatibilityMode,
}

/// Qualified encoded output, never the selected provider/source quality.
/// Absent while queued, and attached only after the actual attempt is known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NativePlatformCompatibilityOutput {
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub attempt: i64,
    /// Full immutable publication for this exact attempt; prefix readiness from
    /// an earlier retry cannot supply its completion or forward-lead policy.
    pub complete: bool,
    pub codecs: String,
    pub width: u32,
    pub height: u32,
    /// Qualified renditions belonging to this exact ladder attempt. The scalar
    /// dimensions describe the highest rendition, not the player's current
    /// automatically selected level. Absent for the single-output recipe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[schemars(length(min = 1, max = 3))]
    pub renditions: Option<Vec<crate::LocalHlsRendition>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NativePlatformCompatibilityBinding {
    #[schemars(range(min = 1, max = 1))]
    pub version: u32,
    pub mode: NativePlatformCompatibilityMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub output: Option<NativePlatformCompatibilityOutput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NativePlatformPlaybackIntent {
    /// Explicit opt-in to the distinct, positively entitled course route.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[schemars(range(min = 1, max = 1))]
    pub course_version: Option<u32>,
    /// Dedicated compatibility prepare route only; absence preserves v1 hashes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub compatibility: Option<NativePlatformCompatibilityIntent>,
    /// Explicit opt-in to live-edge/control semantics; absence is legacy VOD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[schemars(range(min = 1, max = 2))]
    pub live_version: Option<u32>,
    #[schemars(range(min = 1, max = 1))]
    pub version: u32,
    pub credential_mode: NativePlatformCredentialMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub quality: Option<NativePlatformQualityIntent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NativePlatformPlaybackBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[schemars(range(min = 1, max = 1))]
    pub course_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub compatibility: Option<NativePlatformCompatibilityBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub live: Option<NativePlatformLiveBinding>,
    #[schemars(range(min = 1, max = 1))]
    pub version: u32,
    pub provider: NativePlatformProvider,
    pub credential_mode: NativePlatformResolvedCredentialMode,
    /// An application refresh policy, not a promise about upstream URL TTL.
    #[schemars(range(min = 1))]
    pub refresh_after_seconds: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub quality: Option<NativePlatformQualityBinding>,
}

/// No shared program-date-time mapping is certified. Only live-edge playback
/// and room play/pause controls are shared, never a frame-aligned VOD clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum NativePlatformLiveSyncMode {
    LiveEdgeControl,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NativePlatformLiveBinding {
    #[schemars(range(min = 1, max = 2))]
    pub version: u32,
    #[schemars(length(min = 5, max = 64))]
    pub broadcast_id: String,
    pub sync_mode: NativePlatformLiveSyncMode,
}

impl NativePlatformLiveBinding {
    pub fn valid(&self) -> bool {
        if self.version == 2 {
            return self.broadcast_id.len() == 64
                && self
                    .broadcast_id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        }
        self.version == 1
            && self.broadcast_id.len() <= 64
            && self.broadcast_id.split(':').count() == 3
            && self.broadcast_id.split(':').all(|part| {
                !part.is_empty()
                    && part.len() <= 19
                    && !part.starts_with('0')
                    && part.bytes().all(|byte| byte.is_ascii_digit())
                    && part.parse::<i64>().is_ok()
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compatibility_intent_is_closed_optional_and_source_quality_remains_separate() {
        let legacy = json!({"version":1,"credential_mode":"anonymous"});
        let decoded: NativePlatformPlaybackIntent = serde_json::from_value(legacy.clone()).unwrap();
        assert!(decoded.compatibility.is_none());
        assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
        let intent = json!({"version":1,"mode":"hls_avc_aac"});
        assert!(
            serde_json::from_value::<NativePlatformCompatibilityIntent>(intent.clone()).is_ok()
        );
        for key in [
            "url",
            "cookie",
            "filter",
            "hardware",
            "burn_in",
            "tone_map_hdr",
        ] {
            let mut changed = intent.clone();
            changed[key] = json!("untrusted");
            assert!(serde_json::from_value::<NativePlatformCompatibilityIntent>(changed).is_err());
        }
        assert!(
            serde_json::from_value::<NativePlatformCompatibilityIntent>(
                json!({"version":1,"mode":"native"})
            )
            .is_err()
        );
        let binding = NativePlatformCompatibilityBinding {
            version: 1,
            mode: NativePlatformCompatibilityMode::HlsAvcAac,
            output: None,
        };
        assert_eq!(serde_json::to_value(binding).unwrap(), intent);
        let quality = NativePlatformQualityBinding {
            version: 1,
            requested_max_height: NativePlatformMaxHeight::P1080,
            selected_height: 1080,
            options: vec![NativePlatformQualityOption {
                max_height: NativePlatformMaxHeight::P1080,
                height: 1080,
            }],
        };
        let output = NativePlatformCompatibilityOutput {
            attempt: 7,
            complete: false,
            codecs: "avc1.64001F,mp4a.40.2".into(),
            width: 1280,
            height: 720,
            renditions: None,
        };
        assert_eq!(quality.selected_height, 1080);
        assert_eq!(output.height, 720);
    }

    #[test]
    fn named_providers_roundtrip_without_aliases() {
        for (provider, name) in [
            (NativePlatformProvider::Bilibili, "bilibili"),
            (NativePlatformProvider::Douyin, "douyin"),
            (NativePlatformProvider::Tiktok, "tiktok"),
            (NativePlatformProvider::Youtube, "youtube"),
        ] {
            assert_eq!(serde_json::to_value(provider).unwrap(), json!(name));
            assert_eq!(
                serde_json::from_value::<NativePlatformProvider>(json!(name)).unwrap(),
                provider
            );
        }
        for alias in ["douyin_live", "tiktok.com", "you_tube", "youtube_playlist"] {
            assert!(serde_json::from_value::<NativePlatformProvider>(json!(alias)).is_err());
        }
    }

    #[test]
    fn closed_platform_intent_has_no_credential_or_url_fields() {
        let value = json!({"version":1,"credential_mode":"own_or_anonymous"});
        let intent: NativePlatformPlaybackIntent = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(intent).unwrap(), value);
        for field in ["cookie", "headers", "url", "owner_id", "shared_account"] {
            let mut invalid = value.clone();
            invalid[field] = json!("secret");
            assert!(serde_json::from_value::<NativePlatformPlaybackIntent>(invalid).is_err());
        }
        assert!(
            serde_json::from_value::<NativePlatformCredentialMode>(json!("owner_account")).is_err()
        );
        assert!(serde_json::from_value::<NativePlatformProvider>(json!("unknown")).is_err());
    }

    #[test]
    fn quality_ceiling_is_finite_and_not_an_extractor_selector() {
        for value in [
            "auto", "p144", "p240", "p360", "p480", "p720", "p1080", "p1440", "p2160", "p4320",
        ] {
            assert!(serde_json::from_value::<NativePlatformMaxHeight>(json!(value)).is_ok());
        }
        for value in [
            json!(720),
            json!("720"),
            json!("bestvideo"),
            json!("p480/evil"),
            json!("p8640"),
        ] {
            assert!(serde_json::from_value::<NativePlatformMaxHeight>(value).is_err());
        }
        let value = json!({"version":1,"provider":"youtube","media_id":Uuid::from_u128(1),"max_height":"p720"});
        assert!(serde_json::from_value::<NativePlatformQualityIntent>(value.clone()).is_ok());
        for field in ["url", "selector", "user_id", "account_id", "cookie"] {
            let mut invalid = value.clone();
            invalid[field] = json!("private");
            assert!(serde_json::from_value::<NativePlatformQualityIntent>(invalid).is_err());
        }
        assert_eq!(
            NativePlatformMaxHeight::for_height(404),
            Some(NativePlatformMaxHeight::P480)
        );
        assert_eq!(NativePlatformMaxHeight::for_height(0), None);
        assert_eq!(NativePlatformMaxHeight::for_height(4321), None);
    }
}
