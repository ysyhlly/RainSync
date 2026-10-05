use anyhow::{Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone, Debug)]
pub struct DecodedSegment {
    pub(crate) video_pts: Vec<i64>,
    pub(crate) video_step: i64,
    pub(crate) audio_pts: Vec<i64>,
    pub(crate) audio_step: i64,
    pub(crate) configuration: String,
    pub(crate) original_sha256: String,
    pub(crate) original_bytes: usize,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) frame_rate: f64,
    pub(crate) process_tree_reaped: bool,
}
impl DecodedSegment {
    pub fn first_video_pts(&self) -> i64 {
        self.video_pts[0]
    }
    pub fn video_frames(&self) -> usize {
        self.video_pts.len()
    }
    pub fn has_audio(&self) -> bool {
        !self.audio_pts.is_empty()
    }
    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn frame_rate(&self) -> f64 {
        self.frame_rate
    }
}
fn fail(condition: bool, reason: &str) -> Result<()> {
    ensure!(condition, "unsupported_finite_hls:{reason}");
    Ok(())
}
fn integer(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}
fn records<'a>(all: &'a [Value], index: i64, kind: &str) -> Vec<&'a Value> {
    all.iter()
        .filter(|r| r["type"] == kind && integer(&r["stream_index"]) == Some(index))
        .collect()
}
fn timeline(packets: &[&Value], frames: &[&Value], step: i64, video: bool) -> Result<Vec<i64>> {
    fail(
        !packets.is_empty() && packets.len() == frames.len() && packets.len() <= 35_000,
        "complete_decode_records",
    )?;
    let mut pts = Vec::with_capacity(packets.len());
    for (packet, frame) in packets.iter().zip(frames) {
        let clock = integer(&packet["pts"])
            .ok_or_else(|| anyhow::anyhow!("unsupported_finite_hls:packet_pts"))?;
        fail(
            (0..(1i64 << 33)).contains(&clock)
                && integer(&packet["dts"]) == Some(clock)
                && integer(&packet["duration"]) == Some(step)
                && integer(&frame["pts"]) == Some(clock)
                && integer(&frame["best_effort_timestamp"]) == Some(clock)
                && integer(&frame["pkt_duration"]).or_else(|| integer(&frame["duration"]))
                    == Some(step),
            "decode_timestamp_or_duration",
        )?;
        if !video {
            fail(integer(&frame["nb_samples"]) == Some(1024), "aac_samples")?;
        }
        if let Some(previous) = pts.last() {
            fail(clock == previous + step, "segment_timestamp_gap_or_overlap")?;
        }
        pts.push(clock);
    }
    Ok(pts)
}
fn inspect(bytes: &[u8], duration: f64, value: &Value) -> Result<DecodedSegment> {
    let streams = value["streams"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("unsupported_finite_hls:streams"))?;
    fail((1..=2).contains(&streams.len()), "muxed_track_set")?;
    let videos: Vec<_> = streams
        .iter()
        .filter(|s| s["codec_type"] == "video")
        .collect();
    let audios: Vec<_> = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .collect();
    fail(
        videos.len() == 1 && videos.len() + audios.len() == streams.len(),
        "muxed_track_set",
    )?;
    let video = videos[0];
    fail(
        video["codec_name"] == "h264"
            && video["has_b_frames"] == 0
            && matches!(video["pix_fmt"].as_str(), Some("yuv420p" | "yuvj420p"))
            && video["time_base"] == "1/90000"
            && video["sample_aspect_ratio"] == "1:1"
            && video
                .get("side_data_list")
                .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty))
            && !matches!(
                video["color_transfer"].as_str(),
                Some("smpte2084" | "arib-std-b67")
            ),
        "clear_sdr_avc_scope",
    )?;
    let width = integer(&video["width"]).filter(|v| (1..=1920).contains(v));
    let height = integer(&video["height"]).filter(|v| (1..=1080).contains(v));
    let step = match video["r_frame_rate"].as_str() {
        Some("30/1") => 3000,
        Some("25/1") => 3600,
        _ => 0,
    };
    fail(
        width.is_some()
            && height.is_some()
            && step > 0
            && video["avg_frame_rate"] == video["r_frame_rate"],
        "avc_geometry_or_rate",
    )?;
    let all = value["packets_and_frames"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("unsupported_finite_hls:decode_records"))?;
    fail(all.len() <= 70_000, "decode_record_bound")?;
    let index = integer(&video["index"])
        .ok_or_else(|| anyhow::anyhow!("unsupported_finite_hls:stream_index"))?;
    let vp = records(all, index, "packet");
    let vf = records(all, index, "frame");
    let video_pts = timeline(&vp, &vf, step, true)?;
    fail(
        (video_pts.len() as f64 * step as f64 / 90000.0 - duration).abs() <= 0.000_011_2,
        "manifest_actual_video_duration",
    )?;
    // Each selected segment must start independently at a decoded keyframe.
    fail(
        integer(&vf[0]["key_frame"]) == Some(1)
            && vp[0]["flags"].as_str().is_some_and(|f| f.contains('K')),
        "segment_independent_keyframe",
    )?;
    let mut audio_pts = Vec::new();
    if let Some(audio) = audios.first() {
        fail(
            audio["codec_name"] == "aac"
                && audio["profile"] == "LC"
                && integer(&audio["sample_rate"]) == Some(48000)
                && matches!(integer(&audio["channels"]), Some(1 | 2))
                && audio["time_base"] == "1/90000",
            "aac_scope",
        )?;
        let index = integer(&audio["index"])
            .ok_or_else(|| anyhow::anyhow!("unsupported_finite_hls:stream_index"))?;
        audio_pts = timeline(
            &records(all, index, "packet"),
            &records(all, index, "frame"),
            1920,
            false,
        )?;
        fail(
            (audio_pts[0] - video_pts[0]).abs() <= 3840,
            "aac_video_offset",
        )?;
    }
    let config = serde_json::json!({"video": {
        "codec":video["codec_name"],"profile":video["profile"],"level":video["level"],
        "width":video["width"],"height":video["height"],"sar":video["sample_aspect_ratio"],
        "pixel":video["pix_fmt"],"rate":video["r_frame_rate"],"extradata":video["extradata"],
        "primaries":video["color_primaries"],"transfer":video["color_transfer"],"space":video["color_space"],"range":video["color_range"]},
        "audio":audios.first().map(|a|serde_json::json!({"codec":a["codec_name"],"profile":a["profile"],"sample_rate":a["sample_rate"],"channels":a["channels"],"layout":a["channel_layout"],"extradata":a["extradata"]}))});
    Ok(DecodedSegment {
        video_pts,
        video_step: step,
        audio_pts,
        audio_step: 1920,
        configuration: format!("{:x}", Sha256::digest(serde_json::to_vec(&config)?)),
        original_sha256: format!("{:x}", Sha256::digest(bytes)),
        original_bytes: bytes.len(),
        width: width.unwrap() as u32,
        height: height.unwrap() as u32,
        frame_rate: 90000.0 / step as f64,
        process_tree_reaped: true,
    })
}
async fn read(mut pipe: impl tokio::io::AsyncRead + Unpin, maximum: usize) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut block = vec![0u8; 65536];
    loop {
        let n = pipe.read(&mut block).await?;
        if n == 0 {
            return Ok(out);
        }
        fail(out.len() + n <= maximum, "decoder_output_bound")?;
        out.extend_from_slice(&block[..n]);
    }
}
/// Full packet/frame decode of the exact bounded byte pipe. Caller must invoke
/// inside its original non-cancellable Scope and authorization/deadline guard.
/// Cancellation never asserts reaping; that Scope retains disposal ownership.
pub async fn decode_transport_stream(bytes: &[u8], duration: f64) -> Result<DecodedSegment> {
    fail(
        !bytes.is_empty()
            && bytes.len() <= super::MAX_RESOURCE_BYTES
            && duration.is_finite()
            && duration > 0.0
            && duration <= 32.0,
        "decode_input_bound",
    )?;
    let mut command = tokio::process::Command::new("/usr/bin/ffprobe");
    crate::input_policy::clean_environment(&mut command);
    crate::bounded_decode::install(&mut command)?;
    command
        .args([
            "-v",
            "error",
            "-threads",
            "1",
            "-max_alloc",
            "134217728",
            "-protocol_whitelist",
            "pipe",
            "-format_whitelist",
            "mpegts",
            "-err_detect",
            "explode",
            "-f",
            "mpegts",
            "-show_packets",
            "-show_frames",
            "-show_streams",
            "-show_data",
            "-of",
            "json",
            "-i",
            "pipe:0",
        ])
        .env("OPENBLAS_NUM_THREADS", "1")
        .env("OMP_NUM_THREADS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::child_process::spawn(command)?;
    let mut input = child.stdin.take().expect("finite hls stdin");
    let out = child.stdout.take().expect("finite hls stdout");
    let err = child.stderr.take().expect("finite hls stderr");
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        tokio::try_join!(
            async {
                input.write_all(bytes).await?;
                input.shutdown().await?;
                drop(input);
                Ok::<_, anyhow::Error>(())
            },
            read(out, 16 * 1024 * 1024),
            read(err, 65536),
            async { Ok::<_, anyhow::Error>(child.wait().await?) }
        )
    })
    .await;
    let (_, out, err, status) = match result {
        Ok(Ok(v)) => v,
        _ => {
            child.kill().await?;
            anyhow::bail!("unsupported_finite_hls:decoder_failed_or_deadline")
        }
    };
    fail(status.success() && err.is_empty(), "decoder_failed")?;
    inspect(bytes, duration, &serde_json::from_slice(&out)?)
}

/// Full decoded sample-table evidence for an owned normalized fMP4 descriptor.
/// It uses the same finite packet/frame grammar as static-HLS qualification;
/// no manifest/reference demuxer or network protocol is enabled.
pub async fn decode_fmp4_owned(input: &crate::advanced_media::OwnedLocalInput) -> Result<Value> {
    input.verify()?;
    let mut command = tokio::process::Command::new("/usr/bin/ffprobe");
    crate::input_policy::clean_environment(&mut command);
    crate::bounded_decode::install(&mut command)?;
    command.args(["-v","error","-threads","1","-max_alloc","134217728","-protocol_whitelist","file","-format_whitelist","mov","-err_detect","explode","-show_packets","-show_frames","-show_streams","-show_format","-show_data","-show_entries","stream:format:frame=stream_index,media_type,pts,best_effort_timestamp,duration,pkt_duration,nb_samples,width,height,key_frame:packet=stream_index,pts,dts,duration:packet_side_data=side_data_type,skip_samples,discard_padding","-of","json","-i"])
        .arg(input.decoder_path()?).env("OPENBLAS_NUM_THREADS","1").env("OMP_NUM_THREADS","1")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    input.install(&mut command)?;
    let mut child = crate::child_process::spawn(command)?;
    let out = child.stdout.take().expect("finite fmp4 stdout");
    let err = child.stderr.take().expect("finite fmp4 stderr");
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        tokio::try_join!(read(out, 16 * 1024 * 1024), read(err, 65536), async {
            Ok::<_, anyhow::Error>(child.wait().await?)
        })
    })
    .await;
    let (out, err, status) = match result {
        Ok(Ok(v)) => v,
        _ => {
            child.kill().await?;
            anyhow::bail!("unsupported_finite_hls:fmp4_decode_failed_or_deadline")
        }
    };
    fail(status.success() && err.is_empty(), "fmp4_decoder_failed")?;
    input.verify()?;
    Ok(serde_json::from_slice(&out)?)
}
