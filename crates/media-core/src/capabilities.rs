//! Finite configurations derived from actual codec headers or a fixed encoder recipe.
use protocol::{
    AudioCapabilityConfiguration as Audio, PlaybackCandidate, VideoCapabilityConfiguration as Video,
};
use serde_json::Value;

pub const OUTPUT_AVC: &str = "avc1.64001F";

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
}
fn rate(value: &Value) -> Option<f64> {
    let (a, b) = value.as_str()?.split_once('/')?;
    let rate = a.parse::<f64>().ok()? / b.parse::<f64>().ok()?;
    (rate.is_finite() && rate > 0.0).then_some(rate)
}

/// Decode only ffprobe's structured hex dump, never its printable ASCII column.
fn extradata(stream: &Value) -> Option<Vec<u8>> {
    let dump = stream["extradata"].as_str()?;
    let mut bytes = Vec::new();
    for line in dump.lines().filter(|line| !line.trim().is_empty()) {
        let (_, data) = line.split_once(':')?;
        let hex = data.trim_start().split("  ").next()?;
        for word in hex.split_whitespace() {
            if word.len() % 2 != 0 {
                return None;
            }
            for offset in (0..word.len()).step_by(2) {
                bytes.push(u8::from_str_radix(&word[offset..offset + 2], 16).ok()?);
            }
        }
        if bytes.len() > 65536 {
            return None;
        }
    }
    (!bytes.is_empty()).then_some(bytes)
}

fn avc_codec(stream: &Value) -> Option<String> {
    if stream["codec_name"] != "h264"
        || !matches!(stream["pix_fmt"].as_str(), Some("yuv420p" | "yuvj420p"))
    {
        return None;
    }
    let bytes = extradata(stream)?;
    let header = if bytes.len() >= 7 && bytes[0] == 1 {
        // AVCDecoderConfigurationRecord stores the actual compatibility flags.
        &bytes[1..4]
    } else {
        let start = bytes
            .windows(4)
            .position(|v| v == [0, 0, 0, 1])
            .map(|i| i + 4)
            .or_else(|| bytes.windows(3).position(|v| v == [0, 0, 1]).map(|i| i + 3))?;
        if bytes.get(start)? & 31 != 7 {
            return None;
        }
        bytes.get(start + 1..start + 4)?
    };
    Some(format!(
        "avc1.{:02X}{:02X}{:02X}",
        header[0], header[1], header[2]
    ))
}

fn aac(stream: &Value) -> Option<Audio> {
    if stream["codec_name"] != "aac" {
        return None;
    }
    let bytes = extradata(stream)?;
    // Only measured AAC-LC is in the current conservative MP4 path. Extended
    // object types and implicit SBR/PS are not inferred from a profile label.
    if bytes.len() < 2 || bytes[0] >> 3 != 2 || stream["profile"] != "LC" {
        return None;
    }
    let channels = stream["channels"].as_u64().filter(|v| *v > 0 && *v <= 8)?;
    let samplerate = number(&stream["sample_rate"])? as u32;
    let bitrate = number(&stream["bit_rate"])? as u32;
    Some(Audio {
        content_type: "audio/mp4; codecs=\"mp4a.40.2\"".into(),
        channels: channels.to_string(),
        bitrate,
        samplerate,
    })
}

fn output_audio() -> Audio {
    Audio {
        content_type: "audio/mp4; codecs=\"mp4a.40.2\"".into(),
        channels: "2".into(),
        bitrate: 128000,
        samplerate: 48000,
    }
}
fn make(
    id: &str,
    mode: &str,
    transport: &str,
    codec: &str,
    video: Video,
    audio: Option<Audio>,
) -> PlaybackCandidate {
    PlaybackCandidate {
        id: id.into(),
        delivery_mode: mode.into(),
        transport: transport.into(),
        content_type: format!(
            "video/mp4; codecs=\"{codec}{}\"",
            if audio.is_some() { ", mp4a.40.2" } else { "" }
        ),
        video,
        audio,
    }
}

/// No fabricated profile IDs: passthrough formats require codec extradata.
/// A full transcode candidate describes the enforced SDR 720p30 recipe below.
pub fn candidates(
    meta: &Value,
    selected: Option<u32>,
    position_ms: f64,
) -> anyhow::Result<Vec<PlaybackCandidate>> {
    let streams = meta["streams"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("no_streams"))?;
    let video = streams
        .iter()
        .find(|v| v["codec_type"] == "video")
        .ok_or_else(|| anyhow::anyhow!("no_video"))?;
    anyhow::ensure!(
        !matches!(
            video["color_transfer"].as_str(),
            Some("smpte2084" | "arib-std-b67")
        ),
        "hdr_unsupported"
    );
    let audio = if let Some(index) = selected {
        Some(
            streams
                .iter()
                .find(|v| {
                    v["codec_type"] == "audio" && v["index"].as_u64() == Some(u64::from(index))
                })
                .ok_or_else(|| anyhow::anyhow!("invalid_audio_track"))?,
        )
    } else {
        streams.iter().find(|v| v["codec_type"] == "audio")
    };
    let mut result = Vec::new();
    let fps = rate(&video["avg_frame_rate"]);
    let measured = avc_codec(video)
        .zip(video["width"].as_u64())
        .zip(video["height"].as_u64())
        .zip(fps)
        .zip(number(&video["bit_rate"]).or_else(|| number(&meta["format"]["bit_rate"])));
    if let Some(((((codec, width), height), framerate), bitrate)) = measured
        && width > 0
        && height > 0
        && width <= 16384
        && height <= 16384
        && bitrate <= u32::MAX as f64
        && !super::hls_needs_video_transform(meta)
        && matches!(
            video["sample_aspect_ratio"].as_str(),
            None | Some("1:1" | "N/A")
        )
    {
        let config = Video {
            content_type: format!("video/mp4; codecs=\"{codec}\""),
            width: width as u32,
            height: height as u32,
            framerate,
            bitrate: bitrate as u32,
        };
        let measured_audio = audio.and_then(aac);
        let audio_copy = audio.is_none() || measured_audio.is_some();
        let mp4 = meta["format"]["format_name"]
            .as_str()
            .is_some_and(|s| s.split(',').any(|v| v == "mp4"));
        // Original-file playback leaves track choice to the browser. A probe of
        // one stream cannot describe an alternate/default stream it may choose.
        // Generated candidates explicitly map the probed video/audio instead.
        let unambiguous_tracks = streams
            .iter()
            .filter(|s| s["codec_type"] == "video")
            .count()
            == 1
            && streams
                .iter()
                .filter(|s| s["codec_type"] == "audio")
                .count()
                <= 1;
        if mp4 && audio_copy && selected.is_none() && unambiguous_tracks {
            result.push(make(
                "direct",
                "direct",
                "progressive",
                &codec,
                config.clone(),
                measured_audio.clone(),
            ));
        }
        if position_ms == 0.0 {
            if audio_copy {
                result.push(make(
                    "remux",
                    "remux",
                    "hls",
                    &codec,
                    config.clone(),
                    measured_audio,
                ));
            }
            if audio.is_some() {
                result.push(make(
                    "audio_transcode",
                    "audio_transcode",
                    "hls",
                    &codec,
                    config,
                    Some(output_audio()),
                ));
            }
        }
    }
    result.push(make(
        "transcode_720p",
        "transcode",
        "hls",
        OUTPUT_AVC,
        Video {
            content_type: format!("video/mp4; codecs=\"{OUTPUT_AVC}\""),
            width: 1280,
            height: 720,
            bitrate: 4000000,
            framerate: 30.0,
        },
        audio.map(|_| output_audio()),
    ));
    Ok(result)
}

/// Exact output settings paired with transcode_720p and audio_transcode candidates.
pub fn negotiated_hls_args(
    input: &str,
    output: &str,
    start: f64,
    mode: &str,
    audio_index: Option<u32>,
) -> Vec<String> {
    let mut args = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];
    if start > 0.0 {
        args.extend(["-ss".into(), start.to_string()]);
    }
    args.extend([
        "-i".into(),
        input.into(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        audio_index.map_or_else(|| "0:a:0?".into(), |index| format!("0:{index}")),
    ]);
    let video = if mode == "transcode" {
        vec![
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            "-level:v",
            "3.1",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-maxrate",
            "4M",
            "-bufsize",
            "8M",
            "-bf",
            "0",
            "-r",
            "30",
            "-fps_mode",
            "cfr",
            "-vf",
            "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1",
            "-force_key_frames",
            "expr:gte(t,n_forced*4)",
        ]
    } else {
        vec!["-c:v", "copy"]
    };
    args.extend(video.into_iter().map(String::from));
    let audio = if mode == "remux" {
        vec!["-c:a", "copy"]
    } else {
        vec![
            "-c:a",
            "aac",
            "-profile:a",
            "aac_low",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-b:a",
            "128k",
        ]
    };
    args.extend(audio.into_iter().map(String::from));
    args.extend(
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
    args.push(output.into());
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn metadata() -> Value {
        json!({"format":{"format_name":"mov,mp4","bit_rate":"1000000"},"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","width":640,"height":360,"avg_frame_rate":"25/1","r_frame_rate":"25/1","extradata":"\n00000000: 0164 000d ffe1 0000                      .d......\n"}]})
    }
    #[test]
    fn derives_real_compatibility_bytes_instead_of_guessing_from_profile() {
        let mut m = metadata();
        assert_eq!(
            candidates(&m, None, 0.0).unwrap()[0].video.content_type,
            "video/mp4; codecs=\"avc1.64000D\""
        );
        m["streams"][0]["extradata"] =
            json!("\n00000000: 0142 e01e ffe1 0000                      .B......\n");
        assert!(
            candidates(&m, None, 0.0).unwrap()[0]
                .content_type
                .contains("42E01E")
        );
    }
    #[test]
    fn unknown_extradata_and_hdr_never_fabricate_direct_support() {
        let mut m = metadata();
        m["streams"][0].as_object_mut().unwrap().remove("extradata");
        assert_eq!(candidates(&m, None, 0.0).unwrap().len(), 1);
        m["streams"][0]["color_transfer"] = json!("smpte2084");
        assert!(candidates(&m, None, 0.0).is_err());
    }
    #[test]
    fn multiple_original_tracks_require_explicit_generated_mapping() {
        let mut m = metadata();
        let alternate = m["streams"][0].clone();
        m["streams"].as_array_mut().unwrap().push(alternate);
        let c = candidates(&m, None, 0.0).unwrap();
        assert_eq!(
            c.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(),
            vec!["remux", "transcode_720p"]
        );
    }
    #[test]
    fn nonzero_seek_omits_copy_routes_and_invalid_audio_fails() {
        let m = metadata();
        let c = candidates(&m, None, 100.0).unwrap();
        assert_eq!(
            c.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(),
            vec!["direct", "transcode_720p"]
        );
        assert!(candidates(&m, Some(55), 0.0).is_err());
    }
}
