//! Single-layer HEVC Dolby Vision. Profile 5 must be reshaped from IPT-PQ-C2;
//! treating it as ordinary HDR10 produces incorrect colors. Dual-layer/FEL
//! and other codecs remain outside this recipe.
use anyhow::{Result, ensure};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DolbyVisionSource {
    pub profile: u8,
    pub level: u8,
    pub compatibility_id: u8,
}

impl DolbyVisionSource {
    pub fn from_stream(video: &Value) -> Result<Option<Self>> {
        let Some(rows) = video["side_data_list"].as_array() else {
            return Ok(None);
        };
        let records: Vec<_> = rows
            .iter()
            .filter(|row| {
                row["side_data_type"]
                    .as_str()
                    .is_some_and(|s| s.contains("DOVI") || s.contains("Dolby Vision"))
            })
            .collect();
        if records.is_empty() {
            return Ok(None);
        }
        ensure!(records.len() == 1, "dolby_vision_configuration_invalid");
        let record = records[0];
        ensure!(
            record["side_data_type"] == "DOVI configuration record"
                && record["dv_version_major"] == 1
                && record["dv_version_minor"] == 0
                && record["rpu_present_flag"] == 1
                && record["el_present_flag"] == 0
                && record["bl_present_flag"] == 1,
            "dolby_vision_single_layer_rpu_required"
        );
        ensure!(
            video["codec_name"] == "hevc"
                && video["profile"] == "Main 10"
                && video["pix_fmt"] == "yuv420p10le",
            "dolby_vision_video_format_unsupported"
        );
        let profile = record["dv_profile"].as_u64();
        let compatibility = record["dv_bl_signal_compatibility_id"].as_u64();
        let coherent_color = match (profile, compatibility) {
            (Some(5), Some(0)) => {
                let unspecified = |key: &str| {
                    matches!(video[key].as_str(), None | Some("unknown" | "unspecified"))
                };
                matches!(video["color_range"].as_str(), Some("pc" | "tv"))
                    && ((video["color_primaries"] == "bt2020"
                        && video["color_transfer"] == "smpte2084"
                        && video["color_space"] == "ipt-c2")
                        || (unspecified("color_primaries")
                            && unspecified("color_transfer")
                            && unspecified("color_space")))
            }
            (Some(8), Some(1 | 4)) => {
                video["color_range"] == "tv"
                    && video["color_primaries"] == "bt2020"
                    && video["color_space"] == "bt2020nc"
                    && video["color_transfer"]
                        == if compatibility == Some(1) {
                            "smpte2084"
                        } else {
                            "arib-std-b67"
                        }
            }
            _ => anyhow::bail!("dolby_vision_profile_unsupported"),
        };
        ensure!(coherent_color, "dolby_vision_color_mismatch");
        let level = record["dv_level"]
            .as_u64()
            .filter(|level| (1..=13).contains(level))
            .ok_or_else(|| anyhow::anyhow!("dolby_vision_level_unsupported"))?;
        Ok(Some(Self {
            profile: profile.unwrap() as u8,
            level: level as u8,
            compatibility_id: compatibility.unwrap() as u8,
        }))
    }

    /// Additional decoder requirement even when the MP4 uses an hvc1 entry.
    pub fn codec(self, in_band_parameter_sets: bool) -> String {
        format!(
            "{}.{:02}.{:02}",
            if in_band_parameter_sets {
                "dvhe"
            } else {
                "dvh1"
            },
            self.profile,
            self.level
        )
    }

    pub fn configuration(self, in_band_parameter_sets: bool) -> protocol::DolbyVisionConfiguration {
        protocol::DolbyVisionConfiguration {
            profile: self.profile,
            level: self.level,
            compatibility_id: self.compatibility_id,
            codec: self.codec(in_band_parameter_sets),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn sample(profile: u8, compatibility: u8) -> Value {
        json!({
            "codec_type":"video", "codec_name":"hevc", "profile":"Main 10",
            "pix_fmt":"yuv420p10le", "color_range":"tv", "color_primaries":"bt2020",
            "color_space":"bt2020nc", "color_transfer": if compatibility == 4 {"arib-std-b67"} else {"smpte2084"},
            "side_data_list":[{"side_data_type":"DOVI configuration record",
                "dv_version_major":1,"dv_version_minor":0,"dv_profile":profile,"dv_level":4,
                "rpu_present_flag":1,"el_present_flag":0,"bl_present_flag":1,
                "dv_bl_signal_compatibility_id":compatibility}]
        })
    }

    #[test]
    fn single_layer_profiles_require_coherent_rpu_and_color_facts() {
        for compatibility in [1, 4] {
            let video = sample(8, compatibility);
            let source = DolbyVisionSource::from_stream(&video).unwrap().unwrap();
            assert_eq!(source.codec(false), "dvh1.08.04");
            for (key, value) in [
                ("rpu_present_flag", 0),
                ("el_present_flag", 1),
                ("bl_present_flag", 0),
                ("dv_version_major", 2),
                ("dv_profile", 7),
                ("dv_level", 0),
                ("dv_bl_signal_compatibility_id", 2),
            ] {
                let mut invalid = video.clone();
                invalid["side_data_list"][0][key] = json!(value);
                assert!(DolbyVisionSource::from_stream(&invalid).is_err(), "{key}");
            }
            let mut conflicting = video.clone();
            conflicting["color_space"] = json!("bt709");
            assert!(DolbyVisionSource::from_stream(&conflicting).is_err());
        }
        let mut p5 = sample(5, 0);
        p5["color_range"] = json!("pc");
        for key in ["color_space", "color_transfer", "color_primaries"] {
            p5.as_object_mut().unwrap().remove(key);
        }
        assert!(DolbyVisionSource::from_stream(&p5).unwrap().is_some());
        // A profile-5 record is never sufficient to reinterpret ordinary PQ.
        p5["color_space"] = json!("bt2020nc");
        p5["color_transfer"] = json!("smpte2084");
        p5["color_primaries"] = json!("bt2020");
        assert!(DolbyVisionSource::from_stream(&p5).is_err());
    }
}
