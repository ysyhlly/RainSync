//! Closed private WebM facts, independently checked against the decoder.
//! Header metadata never stands in for successful decoding or a color proof.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivateInputContainer {
    #[default]
    Mp4,
    Webm,
}
impl PrivateInputContainer {
    pub fn is_mp4(&self) -> bool {
        *self == Self::Mp4
    }
    pub fn demuxer(self) -> &'static str {
        match self {
            Self::Mp4 => "mov",
            Self::Webm => "matroska",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebmSourceExpectation {
    pub schema_version: u8,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    // Absent optional metadata stays absent. No guessed profile/color/level.
    pub profile: Option<u8>,
    pub bit_depth: Option<u8>,
    pub color_primaries: Option<u8>,
    pub color_transfer: Option<u8>,
    pub color_space: Option<u8>,
    pub color_range: Option<u8>,
}
impl WebmSourceExpectation {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == 1
                && matches!(self.codec.as_str(), "vp9" | "av1")
                && (1..=8192).contains(&self.width)
                && (1..=4320).contains(&self.height)
                && self.profile.is_none_or(|p| if self.codec == "vp9" {
                    matches!(p, 0 | 2)
                } else {
                    p == 0
                })
                && self.bit_depth.is_none_or(|v| matches!(v, 8 | 10))
                && self.color_primaries.is_none_or(|v| matches!(v, 1 | 9))
                && self.color_transfer.is_none_or(|v| matches!(v, 1 | 16 | 18))
                && self.color_space.is_none_or(|v| matches!(v, 1 | 9 | 10))
                && self.color_range.is_none_or(|v| matches!(v, 1 | 2)),
            "native_platform_webm_configuration_invalid"
        );
        if let (Some(profile), Some(depth)) = (self.profile, self.bit_depth) {
            ensure!(
                self.codec != "vp9" || matches!((profile, depth), (0, 8) | (2, 10)),
                "native_platform_webm_configuration_invalid"
            );
        }
        Ok(())
    }
    pub fn verify_probe(&self, stream: &Value) -> Result<super::VideoSourceProof> {
        self.validate()?;
        let actual = super::VideoSourceProof::from_stream(stream)?;
        ensure!(
            actual.codec == self.codec
                && actual.width == self.width
                && actual.height == self.height
                && actual.sample_aspect_ratio == "1:1"
                && self.profile.is_none_or(|p| match (self.codec.as_str(), p) {
                    ("vp9", 0) => actual.profile == "Profile 0",
                    ("vp9", 2) => actual.profile == "Profile 2",
                    ("av1", 0) => actual.profile == "Main",
                    _ => false,
                })
                && self.bit_depth.is_none_or(|d| d == actual.bit_depth),
            "native_platform_webm_configuration_changed"
        );
        for (expected, value, names) in [
            (
                self.color_primaries,
                actual.color_primaries.as_str(),
                &[(1, "bt709"), (9, "bt2020")][..],
            ),
            (
                self.color_transfer,
                actual.color_transfer.as_str(),
                &[(1, "bt709"), (16, "smpte2084"), (18, "arib-std-b67")][..],
            ),
            (
                self.color_space,
                actual.color_space.as_str(),
                &[(1, "bt709"), (9, "bt2020nc"), (10, "bt2020c")][..],
            ),
            (
                self.color_range,
                actual.color_range.as_str(),
                &[(1, "tv"), (2, "pc")][..],
            ),
        ] {
            ensure!(
                expected.is_none_or(|e| names.contains(&(e, value))),
                "native_platform_webm_configuration_changed"
            );
        }
        Ok(actual)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn absent_webm_color_does_not_invent_sdr_or_bypass_actual_profile() {
        let e = WebmSourceExpectation {
            schema_version: 1,
            codec: "vp9".into(),
            width: 64,
            height: 64,
            profile: None,
            bit_depth: None,
            color_primaries: None,
            color_transfer: None,
            color_space: None,
            color_range: None,
        };
        let mut s = json!({"codec_type":"video","codec_name":"vp9","profile":"Profile 0","pix_fmt":"yuv420p","width":64,"height":64,"sample_aspect_ratio":"1:1","color_primaries":"bt709","color_transfer":"bt709","color_space":"bt709","color_range":"tv"});
        assert!(e.verify_probe(&s).is_ok());
        s["color_transfer"] = json!("unknown");
        assert!(e.verify_probe(&s).is_err());
        s["color_transfer"] = json!("bt709");
        s["profile"] = json!("Profile 1");
        assert!(e.verify_probe(&s).is_err());
        s["profile"] = json!("Profile 0");
        s["width"] = json!(32);
        assert!(e.verify_probe(&s).is_err());
    }
}
