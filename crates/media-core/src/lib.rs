use anyhow::{Result, bail};
use std::path::{Path, PathBuf};

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

pub fn hls_args(input: &str, output: &str, start_seconds: f64, transcode: bool) -> Vec<String> {
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
        "0:a:0?".into(),
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
