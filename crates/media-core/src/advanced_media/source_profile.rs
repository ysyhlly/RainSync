//! Probe-backed extended codec facts. A codec name or provider MIME string is
//! not enough to authorize a high-depth decode. This admits a deliberately
//! finite 4:2:0 subset and does not claim decoder or complete-file qualification.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VideoSourceProof {
    pub codec: String,
    pub profile: String,
    pub pixel_format: String,
    pub bit_depth: u8,
    pub color_transfer: String,
    pub color_primaries: String,
    pub color_space: String,
    pub color_range: String,
    pub sample_aspect_ratio: String,
    pub width: u32,
    pub height: u32,
}
fn text<'a>(stream: &'a Value, key: &str) -> Result<&'a str> {
    stream[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or_else(|| anyhow::anyhow!("advanced_media_source_profile_required"))
}
impl VideoSourceProof {
    /// Require positive, internally coherent profile/pixel/color/SAR facts for
    /// new codec coverage. Unknown values are not silently treated as SDR.
    pub fn from_stream(stream: &Value) -> Result<Self> {
        ensure!(
            stream["codec_type"] == "video",
            "advanced_media_source_profile_required"
        );
        let codec = text(stream, "codec_name")?;
        let profile = text(stream, "profile")?;
        let pixel = text(stream, "pix_fmt")?;
        let depth = match (codec, profile, pixel) {
            ("h264", "Baseline" | "Constrained Baseline" | "Main" | "High", "yuv420p")
            | ("hevc", "Main", "yuv420p")
            | ("av1", "Main", "yuv420p")
            | ("vp9", "Profile 0", "yuv420p") => 8,
            ("hevc", "Main 10", "yuv420p10le")
            | ("av1", "Main", "yuv420p10le")
            | ("vp9", "Profile 2", "yuv420p10le") => 10,
            _ => anyhow::bail!("advanced_media_source_profile_unsupported"),
        };
        if let Some(value) = stream.get("bits_per_raw_sample") {
            let bits = value.as_u64().or_else(|| value.as_str()?.parse().ok());
            ensure!(
                bits == Some(0) || bits == Some(depth.into()),
                "advanced_media_source_depth_mismatch"
            );
        }
        let sar = text(stream, "sample_aspect_ratio")?;
        let (a, b) = sar
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("advanced_media_source_sar_required"))?;
        let a = a.parse::<u32>()?;
        let b = b.parse::<u32>()?;
        ensure!(
            (1..=65535).contains(&a) && (1..=65535).contains(&b),
            "advanced_media_source_sar_required"
        );
        let transfer = text(stream, "color_transfer")?;
        let primaries = text(stream, "color_primaries")?;
        let matrix = text(stream, "color_space")?;
        let range = text(stream, "color_range")?;
        ensure!(
            matches!(range, "tv" | "pc"),
            "advanced_media_source_color_required"
        );
        match transfer {
            "smpte2084" | "arib-std-b67" => {
                ensure!(
                    depth == 10
                        && primaries == "bt2020"
                        && matches!(matrix, "bt2020nc" | "bt2020c"),
                    "advanced_media_source_color_mismatch"
                );
                super::classify_hdr(stream)?
                    .ok_or_else(|| anyhow::anyhow!("advanced_media_source_color_required"))?;
            }
            "bt709" => ensure!(
                primaries == "bt709" && matrix == "bt709",
                "advanced_media_source_color_mismatch"
            ),
            "smpte170m" | "bt470bg" => ensure!(
                matches!(
                    (primaries, matrix),
                    ("smpte170m", "smpte170m") | ("bt470bg", "bt470bg")
                ),
                "advanced_media_source_color_mismatch"
            ),
            _ => anyhow::bail!("advanced_media_source_color_unsupported"),
        }
        ensure!(
            !crate::video_needs_transform(stream),
            "advanced_media_source_transform_unsupported"
        );
        let geometry = |key: &str| {
            stream[key]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| (1..=16384).contains(n))
                .ok_or_else(|| anyhow::anyhow!("advanced_media_geometry_invalid"))
        };
        Ok(Self {
            codec: codec.into(),
            profile: profile.into(),
            pixel_format: pixel.into(),
            bit_depth: depth,
            color_transfer: transfer.into(),
            color_primaries: primaries.into(),
            color_space: matrix.into(),
            color_range: range.into(),
            sample_aspect_ratio: sar.into(),
            width: geometry("width")?,
            height: geometry("height")?,
        })
    }
    pub fn decoder(&self) -> &'static str {
        match self.codec.as_str() {
            "av1" => "av1",
            "vp9" => "vp9",
            "hevc" => "hevc",
            _ => "h264",
        }
    }
}

/// Old eight-bit inputs keep their existing admission. New AV1/VP9 and HEVC
/// Main10 coverage must carry the complete proof, including 10-bit SDR.
pub fn extended_source_proof(stream: &Value) -> Result<Option<VideoSourceProof>> {
    if matches!(stream["codec_name"].as_str(), Some("av1" | "vp9"))
        || (stream["codec_name"] == "hevc"
            && (stream["profile"] == "Main 10" || stream["pix_fmt"] == "yuv420p10le"))
    {
        Ok(Some(VideoSourceProof::from_stream(stream)?))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn source(codec: &str, profile: &str, pixel: &str) -> Value {
        json!({"codec_type":"video","codec_name":codec,"profile":profile,"pix_fmt":pixel,"width":1920,"height":1080,"sample_aspect_ratio":"1:1","color_transfer":"bt709","color_primaries":"bt709","color_space":"bt709","color_range":"tv"})
    }
    #[test]
    fn extended_profiles_are_positive_and_closed() {
        for (codec, profile, pixel, depth) in [
            ("av1", "Main", "yuv420p", 8),
            ("av1", "Main", "yuv420p10le", 10),
            ("vp9", "Profile 0", "yuv420p", 8),
            ("vp9", "Profile 2", "yuv420p10le", 10),
            ("hevc", "Main 10", "yuv420p10le", 10),
        ] {
            let s = source(codec, profile, pixel);
            assert_eq!(extended_source_proof(&s).unwrap().unwrap().bit_depth, depth);
            for key in [
                "profile",
                "pix_fmt",
                "color_transfer",
                "color_primaries",
                "color_space",
                "color_range",
                "sample_aspect_ratio",
            ] {
                let mut missing = s.clone();
                missing.as_object_mut().unwrap().remove(key);
                assert!(extended_source_proof(&missing).is_err(), "{codec}/{key}");
            }
        }
        for (codec, profile, pixel) in [
            ("vp9", "Profile 1", "yuv444p"),
            ("vp9", "Profile 2", "yuv420p12le"),
            ("hevc", "Main 10", "yuv420p"),
            ("av1", "Professional", "yuv420p10le"),
        ] {
            assert!(extended_source_proof(&source(codec, profile, pixel)).is_err());
        }
    }
    #[test]
    fn hdr_and_sdr_never_share_guessed_color_facts() {
        let mut s = source("hevc", "Main 10", "yuv420p10le");
        s["color_transfer"] = json!("smpte2084");
        assert!(VideoSourceProof::from_stream(&s).is_err());
        s["color_primaries"] = json!("bt2020");
        s["color_space"] = json!("bt2020nc");
        assert!(VideoSourceProof::from_stream(&s).is_ok());
        s["sample_aspect_ratio"] = json!("0:1");
        assert!(VideoSourceProof::from_stream(&s).is_err());
    }
}

/// Expected configuration from the Server's source-backed private byte proof.
/// The Worker compares actual ffprobe facts against it before any encoding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VideoSourceExpectation {
    pub schema_version: u8,
    pub codec: String,
    pub profile: String,
    pub pixel_format: String,
    pub width: u32,
    pub height: u32,
    pub sample_aspect_ratio: String,
    pub level: u8,
    pub color_transfer: String,
    pub color_primaries: String,
    pub color_space: String,
    pub color_range: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chroma_location: Option<String>,
}
impl VideoSourceExpectation {
    pub fn from_configuration(codec: &str, width: u32, height: u32) -> Result<Self> {
        let p = codec.split('.').collect::<Vec<_>>();
        let (family, profile, pixel) = match p.as_slice() {
            ["av01", "0", _, "08", ..] => ("av1", "Main", "yuv420p"),
            ["av01", "0", _, "10", ..] => ("av1", "Main", "yuv420p10le"),
            ["vp09", "00", _, "08", ..] => ("vp9", "Profile 0", "yuv420p"),
            ["vp09", "02", _, "10", ..] => ("vp9", "Profile 2", "yuv420p10le"),
            ["hvc1" | "hev1", "1", ..] => ("hevc", "Main", "yuv420p"),
            ["hvc1" | "hev1", "2", ..] => ("hevc", "Main 10", "yuv420p10le"),
            _ => anyhow::bail!("native_platform_source_configuration_unsupported"),
        };
        let level = match family {
            "av1" => p[2].strip_suffix('M').and_then(|v| v.parse().ok()),
            "vp9" => p[2].parse().ok(),
            _ => p
                .get(3)
                .and_then(|v| v.strip_prefix('L'))
                .and_then(|v| v.parse().ok()),
        }
        .ok_or_else(|| anyhow::anyhow!("native_platform_source_configuration_unsupported"))?;
        let mut expected = Self {
            schema_version: 1,
            codec: family.into(),
            profile: profile.into(),
            pixel_format: pixel.into(),
            width,
            height,
            sample_aspect_ratio: "1:1".into(),
            level,
            color_transfer: "bt709".into(),
            color_primaries: "bt709".into(),
            color_space: "bt709".into(),
            color_range: "tv".into(),
            chroma_location: None,
        };
        if family == "av1" {
            ensure!(
                p.len() == 10,
                "native_platform_source_configuration_required"
            );
            expected.set_color(p[6].parse()?, p[7].parse()?, p[8].parse()?, p[9].parse()?)?;
            expected.chroma_location = match p[5] {
                "110" => None,
                "111" => Some("left".into()),
                "112" => Some("topleft".into()),
                _ => anyhow::bail!("native_platform_source_configuration_unsupported"),
            };
        } else if family == "vp9" {
            ensure!(
                p.len() == 9,
                "native_platform_source_configuration_required"
            );
            expected.set_color(p[5].parse()?, p[6].parse()?, p[7].parse()?, p[8].parse()?)?;
            expected.chroma_location = match p[4] {
                "00" => Some("left".into()),
                "01" => Some("topleft".into()),
                _ => anyhow::bail!("native_platform_source_configuration_unsupported"),
            };
        }
        expected.validate()?;
        Ok(expected)
    }
    pub fn set_color(
        &mut self,
        primaries: u16,
        transfer: u16,
        matrix: u16,
        range: u8,
    ) -> Result<()> {
        self.color_primaries = match primaries {
            1 => "bt709",
            9 => "bt2020",
            _ => anyhow::bail!("native_platform_source_configuration_unsupported"),
        }
        .into();
        self.color_transfer = match transfer {
            1 => "bt709",
            16 => "smpte2084",
            18 => "arib-std-b67",
            _ => anyhow::bail!("native_platform_source_configuration_unsupported"),
        }
        .into();
        self.color_space = match matrix {
            1 => "bt709",
            9 => "bt2020nc",
            10 => "bt2020c",
            _ => anyhow::bail!("native_platform_source_configuration_unsupported"),
        }
        .into();
        self.color_range = match range {
            0 => "tv",
            1 => "pc",
            _ => anyhow::bail!("native_platform_source_configuration_unsupported"),
        }
        .into();
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        let color = (
            &*self.color_primaries,
            &*self.color_transfer,
            &*self.color_space,
        );
        ensure!(
            self.schema_version == 1
                && (1..=8192).contains(&self.width)
                && (1..=4320).contains(&self.height)
                && self.sample_aspect_ratio == "1:1"
                && matches!(self.color_range.as_str(), "tv" | "pc")
                && self
                    .chroma_location
                    .as_deref()
                    .is_none_or(|v| matches!(v, "left" | "topleft"))
                && (color == ("bt709", "bt709", "bt709")
                    || self.pixel_format == "yuv420p10le"
                        && color.0 == "bt2020"
                        && matches!(color.1, "smpte2084" | "arib-std-b67")
                        && matches!(color.2, "bt2020nc" | "bt2020c"))
                && match self.codec.as_str() {
                    "av1" => self.level <= 23,
                    "vp9" => matches!(
                        self.level,
                        10 | 11 | 20 | 21 | 30 | 31 | 40 | 41 | 50 | 51 | 52 | 60 | 61 | 62
                    ),
                    "hevc" => matches!(
                        self.level,
                        30 | 60 | 63 | 90 | 93 | 120 | 123 | 150 | 153 | 156 | 180 | 183 | 186
                    ),
                    _ => false,
                }
                && matches!(
                    (
                        self.codec.as_str(),
                        self.profile.as_str(),
                        self.pixel_format.as_str()
                    ),
                    ("av1", "Main", "yuv420p" | "yuv420p10le")
                        | ("vp9", "Profile 0", "yuv420p")
                        | ("vp9", "Profile 2", "yuv420p10le")
                        | ("hevc", "Main", "yuv420p")
                        | ("hevc", "Main 10", "yuv420p10le")
                ),
            "native_platform_source_configuration_invalid"
        );
        Ok(())
    }
    pub fn verify_probe(&self, stream: &Value) -> Result<VideoSourceProof> {
        self.validate()?;
        let actual = VideoSourceProof::from_stream(stream)?;
        ensure!(
            actual.codec == self.codec
                && actual.profile == self.profile
                && actual.pixel_format == self.pixel_format
                && actual.width == self.width
                && actual.height == self.height
                && actual.sample_aspect_ratio == self.sample_aspect_ratio
                && actual.color_transfer == self.color_transfer
                && actual.color_primaries == self.color_primaries
                && actual.color_space == self.color_space
                && actual.color_range == self.color_range
                && (stream["level"].as_u64() == Some(self.level.into())
                    || self.codec == "vp9"
                        && stream["level"].as_i64().is_none_or(|level| level < 0))
                && self.chroma_location.as_ref().is_none_or(|expected| {
                    match stream["chroma_location"].as_str() {
                        None | Some("unspecified" | "unknown" | "N/A") => true,
                        Some(actual) => actual == expected,
                    }
                }),
            "native_platform_source_configuration_changed"
        );
        Ok(actual)
    }
}

#[cfg(test)]
mod expectation_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn private_configuration_binds_actual_color_profile_depth_geometry_and_reported_level() {
        let expected = VideoSourceExpectation::from_configuration(
            "av01.0.05M.10.0.110.01.01.01.0",
            1920,
            1080,
        )
        .unwrap();
        let actual = json!({"codec_type":"video","codec_name":"av1","profile":"Main","pix_fmt":"yuv420p10le","width":1920,"height":1080,"sample_aspect_ratio":"1:1","level":5,"color_primaries":"bt709","color_transfer":"bt709","color_space":"bt709","color_range":"tv"});
        expected.verify_probe(&actual).unwrap();
        for (key, value) in [
            ("width", json!(1280)),
            ("level", json!(6)),
            ("color_range", json!("pc")),
            ("pix_fmt", json!("yuv420p")),
            ("sample_aspect_ratio", json!("2:1")),
        ] {
            let mut changed = actual.clone();
            changed[key] = value;
            assert!(expected.verify_probe(&changed).is_err(), "{key}");
        }
        let mut coherent_hdr = actual.clone();
        coherent_hdr["color_primaries"] = json!("bt2020");
        coherent_hdr["color_transfer"] = json!("smpte2084");
        coherent_hdr["color_space"] = json!("bt2020nc");
        assert!(VideoSourceProof::from_stream(&coherent_hdr).is_ok());
        assert!(expected.verify_probe(&coherent_hdr).is_err());
    }
    #[test]
    fn vp9_unreported_level_is_config_evidence_and_never_a_reported_mismatch() {
        let expected =
            VideoSourceExpectation::from_configuration("vp09.02.41.10.00.01.01.01.00", 1920, 1080)
                .unwrap();
        let mut actual = json!({"codec_type":"video","codec_name":"vp9","profile":"Profile 2","pix_fmt":"yuv420p10le","width":1920,"height":1080,"sample_aspect_ratio":"1:1","level":-99,"color_primaries":"bt709","color_transfer":"bt709","color_space":"bt709","color_range":"tv"});
        expected.verify_probe(&actual).unwrap();
        actual["level"] = json!(51);
        assert!(expected.verify_probe(&actual).is_err());
    }
}
