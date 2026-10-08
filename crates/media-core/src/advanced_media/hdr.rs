use anyhow::{Result, ensure};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Transfer {
    Pq,
    Hlg,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Matrix {
    Bt2020NonConstant,
    Bt2020Constant,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Range {
    Limited,
    Full,
}

/// Validated source tags. HDR is never guessed from codec or pixel depth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HdrSource {
    #[serde(skip_serializing_if = "Option::is_none")]
    transfer: Option<Transfer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    matrix: Option<Matrix>,
    #[serde(skip_serializing_if = "Option::is_none")]
    range: Option<Range>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dolby_vision: Option<super::DolbyVisionSource>,
}

pub fn classify_hdr(video: &Value) -> Result<Option<HdrSource>> {
    let side = video["side_data_list"].as_array();
    if let Some(source) = super::DolbyVisionSource::from_stream(video)? {
        return Ok(Some(HdrSource {
            transfer: None,
            matrix: None,
            range: None,
            dolby_vision: Some(source),
        }));
    }
    let transfer = match video["color_transfer"].as_str() {
        Some("smpte2084") => Transfer::Pq,
        Some("arib-std-b67") => Transfer::Hlg,
        _ => {
            ensure!(
                !side.is_some_and(|rows| rows.iter().any(|row| matches!(
                    row["side_data_type"].as_str(),
                    Some(
                        "Mastering display metadata"
                            | "Content light level metadata"
                            | "HDR Dynamic Metadata SMPTE2094-40 (HDR10+)"
                    )
                ))),
                "hdr_transfer_unclassified"
            );
            return Ok(None);
        }
    };
    ensure!(
        video["color_primaries"] == "bt2020",
        "hdr_primaries_unsupported"
    );
    let matrix = match video["color_space"].as_str() {
        Some("bt2020nc") => Matrix::Bt2020NonConstant,
        Some("bt2020c") => Matrix::Bt2020Constant,
        _ => anyhow::bail!("hdr_matrix_unsupported"),
    };
    let range = match video["color_range"].as_str() {
        Some("tv") => Range::Limited,
        Some("pc") => Range::Full,
        _ => anyhow::bail!("hdr_range_unclassified"),
    };
    ensure!(
        matches!(
            video["pix_fmt"].as_str(),
            Some(
                "yuv420p10le"
                    | "yuv422p10le"
                    | "yuv444p10le"
                    | "yuv420p12le"
                    | "yuv422p12le"
                    | "yuv444p12le"
                    | "p010le"
                    | "p016le"
            )
        ),
        "hdr_pixel_format_unsupported"
    );
    Ok(Some(HdrSource {
        transfer: Some(transfer),
        matrix: Some(matrix),
        range: Some(range),
        dolby_vision: None,
    }))
}

impl HdrSource {
    pub fn is_dolby_vision(self) -> bool {
        self.dolby_vision.is_some()
    }

    pub(super) fn filter(self) -> String {
        if self.is_dolby_vision() {
            // libplacebo consumes the decoded per-frame RPU, performs Dolby
            // reshaping (including profile-5 IPT-PQ-C2), then maps to SDR.
            // The CPU Vulkan ICD also works without a host GPU device.
            return "hwupload,libplacebo=apply_dolbyvision=1:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=mobius:format=yuv420p,hwdownload,format=yuv420p,sidedata=mode=delete".into();
        }
        // Official tonemap requires linear, single-precision floating-point
        // data. npl=100 fixes reference white; peak=0 retains FFmpeg's source
        // metadata/reference-peak handling rather than inventing source nits.
        // https://ffmpeg.org/ffmpeg-filters.html#tonemap
        // https://ffmpeg.org/ffmpeg-filters.html#zscale
        format!(
            "zscale=pin=bt2020:tin={}:min={}:rin={}:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=mobius:param=0.3:desat=2:peak=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,sidedata=mode=delete",
            match self.transfer.expect("validated HDR transfer") {
                Transfer::Pq => "smpte2084",
                Transfer::Hlg => "arib-std-b67",
            },
            match self.matrix.expect("validated HDR matrix") {
                Matrix::Bt2020NonConstant => "bt2020nc",
                Matrix::Bt2020Constant => "bt2020c",
            },
            match self.range.expect("validated HDR range") {
                Range::Limited => "tv",
                Range::Full => "pc",
            }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_explicit_pq_hlg_bt2020_ranges_are_tone_mapped() {
        for transfer in ["smpte2084", "arib-std-b67"] {
            let mut v = json!({"color_transfer":transfer,"color_primaries":"bt2020","color_space":"bt2020nc","color_range":"tv","pix_fmt":"yuv420p10le"});
            let filter = classify_hdr(&v).unwrap().unwrap().filter();
            assert!(filter.contains("t=linear:npl=100,format=gbrpf32le"));
            assert!(filter.contains("tonemap=tonemap=mobius"));
            assert!(filter.ends_with("format=yuv420p,sidedata=mode=delete"));
            v["color_range"] = Value::Null;
            assert!(classify_hdr(&v).is_err());
            v["color_range"] = json!("tv");
            v["side_data_list"] = json!([{"side_data_type":"DOVI configuration record"}]);
            assert!(classify_hdr(&v).is_err());
        }
        assert!(
            classify_hdr(&json!({"color_transfer":"bt709","pix_fmt":"yuv420p10le"}))
                .unwrap()
                .is_none()
        );
        assert!(
            classify_hdr(
                &json!({"side_data_list":[{"side_data_type":"Mastering display metadata"}]})
            )
            .is_err()
        );
    }
}
