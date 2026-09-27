use anyhow::{Result, bail};
use std::path::{Path, PathBuf};
pub mod subtitles;

pub fn byte_range(value: Option<&str>, size: u64) -> Result<Option<(u64, u64)>> {
    let Some(value) = value else { return Ok(None) };
    if size == 0 {
        bail!("unsatisfiable_range")
    }
    let raw = value
        .strip_prefix("bytes=")
        .ok_or_else(|| anyhow::anyhow!("invalid_range"))?;
    if raw.contains(',') {
        bail!("multiple_ranges_unsupported")
    }
    let (a, b) = raw
        .split_once('-')
        .ok_or_else(|| anyhow::anyhow!("invalid_range"))?;
    let (start, end) = if a.is_empty() {
        let n = b.parse::<u64>()?;
        if n == 0 {
            bail!("invalid_range")
        };
        (size.saturating_sub(n), size - 1)
    } else {
        (
            a.parse::<u64>()?,
            if b.is_empty() {
                size - 1
            } else {
                b.parse::<u64>()?.min(size - 1)
            },
        )
    };
    if start >= size || start > end {
        bail!("unsatisfiable_range")
    };
    Ok(Some((start, end)))
}

pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let root = root.canonicalize()?;
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        bail!("invalid_path")
    }
    let full = root.join(relative).canonicalize()?;
    if !full.starts_with(&root) || !full.is_file() {
        bail!("outside_media_root")
    }
    Ok(full)
}

pub async fn probe(path: &str) -> Result<serde_json::Value> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
                path,
            ])
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    if !output.status.success() {
        bail!("probe_failed")
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

/// Stream-copy HLS does not reliably preserve MP4 display matrices. Baking the
/// orientation into pixels requires decoding, even when H.264 is supported.
/// A material difference between nominal and average frame rate also takes the
/// conservative CFR route: stream-copy HLS can undercount VFR segment duration.
pub fn hls_needs_video_transform(meta: &serde_json::Value) -> bool {
    meta["streams"].as_array().is_some_and(|streams| {
        streams
            .iter()
            .filter(|s| s["codec_type"] == "video")
            .any(|video| {
                let rotated = |value: &serde_json::Value| {
                    value
                        .as_f64()
                        .or_else(|| value.as_str()?.parse().ok())
                        .is_some_and(|rotation: f64| {
                            !rotation.is_finite() || rotation.rem_euclid(360.0).abs() > 0.01
                        })
                };
                let rate = |value: &serde_json::Value| -> Option<f64> {
                    let (n, d) = value.as_str()?.split_once('/')?;
                    let fps = n.parse::<f64>().ok()? / d.parse::<f64>().ok()?;
                    (fps.is_finite() && fps > 0.0).then_some(fps)
                };
                let irregular_rate = rate(&video["r_frame_rate"])
                    .zip(rate(&video["avg_frame_rate"]))
                    .is_some_and(|(nominal, average)| (nominal / average - 1.0).abs() > 0.01);
                irregular_rate
                    || rotated(&video["tags"]["rotate"])
                    || video["side_data_list"].as_array().is_some_and(|rows| {
                        rows.iter().any(|row| {
                            row["side_data_type"] == "Display Matrix" && rotated(&row["rotation"])
                        })
                    })
            })
    })
}

pub fn hls_args(
    input: &str,
    output: &str,
    start_seconds: f64,
    transcode: bool,
    audio_index: Option<u32>,
) -> Vec<String> {
    // Stream copy seeks to an earlier keyframe and cannot honor the plan's
    // requested timeline origin. Decode/discard preroll for nonzero starts.
    let transcode = transcode || start_seconds > 0.0;
    let mut a = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-ss".into(),
        start_seconds.to_string(),
        "-i".into(),
        input.into(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        // API track indices are absolute stream indices, not audio ordinals.
        audio_index.map_or_else(|| "0:a:0?".into(), |index| format!("0:{index}")),
    ];
    let extra = if transcode {
        vec![
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            // B-frame reorder and automatic negative-DTS shifting otherwise
            // move the first displayed frame away from zero in fMP4 HLS.
            "-bf",
            "0",
            "-fps_mode",
            "cfr",
            "-vf",
            "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-force_key_frames",
            "expr:gte(t,n_forced*4)",
            "-c:a",
            "aac",
        ]
    } else {
        vec!["-c:v", "copy", "-c:a", "aac"]
    };
    a.extend(extra.into_iter().map(String::from));
    a.extend(
        [
            "-avoid_negative_ts",
            "disabled",
            "-f",
            "hls",
            "-hls_time",
            "4",
            "-hls_segment_type",
            "fmp4",
            "-hls_playlist_type",
            "event",
            "-hls_flags",
            "temp_file",
        ]
        .into_iter()
        .map(String::from),
    );
    a.push(output.into());
    a
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges() {
        assert_eq!(byte_range(Some("bytes=-5"), 20).unwrap(), Some((15, 19)));
        assert_eq!(byte_range(Some("bytes=2-"), 20).unwrap(), Some((2, 19)));
        assert!(byte_range(Some("bytes=20-"), 20).is_err());
        assert!(byte_range(Some("bytes=0-2,4-8"), 20).is_err());
        assert!(byte_range(Some("bytes=0-"), 0).is_err());
    }
}

/// Conservative single-profile browser fallback. Unknown/HDR video is never silently tone-mapped.
pub fn compatible_mode(meta: &serde_json::Value, selected_audio: bool) -> Result<&'static str> {
    let streams = meta["streams"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("no_streams"))?;
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or_else(|| anyhow::anyhow!("no_video"))?;
    if matches!(
        video["color_transfer"].as_str(),
        Some("smpte2084" | "arib-std-b67")
    ) {
        bail!("hdr_unsupported");
    }
    if video["codec_name"] != "h264"
        || !matches!(video["pix_fmt"].as_str(), Some("yuv420p" | "yuvj420p"))
    {
        return Ok("transcode");
    }
    let audio = streams.iter().find(|s| s["codec_type"] == "audio");
    let mp4 = meta["format"]["format_name"]
        .as_str()
        .is_some_and(|s| s.split(',').any(|v| matches!(v, "mp4" | "hls")));
    if selected_audio || !mp4 || audio.is_some_and(|a| a["codec_name"] != "aac") {
        Ok("remux")
    } else {
        Ok("direct")
    }
}
#[cfg(test)]
mod compatibility_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn inconsistent_frame_rates_take_the_conservative_cfr_route() {
        for (nominal, average, expected) in [
            ("24/1", "384/23", true),
            ("30000/1001", "30000/1001", false),
            ("24/1", "24000/1001", false),
            ("0/0", "24/1", false),
            ("24/1", "unknown", false),
        ] {
            let meta = json!({"streams":[{"codec_type":"video","r_frame_rate":nominal,"avg_frame_rate":average}]});
            assert_eq!(hls_needs_video_transform(&meta), expected);
        }
    }
    #[test]
    fn rotated_video_requires_pixels_to_be_transformed_for_hls() {
        for rotation in [90, -90, 180, 270] {
            let meta = json!({"streams":[{"codec_type":"video","side_data_list":[{"side_data_type":"Display Matrix","rotation":rotation}]}]});
            assert!(hls_needs_video_transform(&meta));
        }
        assert!(hls_needs_video_transform(
            &json!({"streams":[{"codec_type":"video","tags":{"rotate":"90"}}]})
        ));
        assert!(!hls_needs_video_transform(
            &json!({"streams":[{"codec_type":"video","tags":{"rotate":"360"}}]})
        ));
        assert!(!hls_needs_video_transform(
            &json!({"streams":[{"codec_type":"video"}]})
        ));
    }
    #[test]
    fn codec_pixel_format_container_and_hdr_are_distinguished() {
        let mut m = json!({"format":{"format_name":"mov,mp4"},"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p"},{"codec_type":"audio","codec_name":"aac"}]});
        assert_eq!(compatible_mode(&m, false).unwrap(), "direct");
        assert_eq!(compatible_mode(&m, true).unwrap(), "remux");
        m["streams"][0]["pix_fmt"] = json!("yuv420p10le");
        assert_eq!(compatible_mode(&m, false).unwrap(), "transcode");
        m["streams"][0]["color_transfer"] = json!("smpte2084");
        assert!(compatible_mode(&m, false).is_err());
    }
}
