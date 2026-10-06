//! Conservative qualification of NAS-generated HLS. These are measured node
//! reports, never proof of browser playback or an independent Server probe.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::Duration,
};
use tokio::process::Command;

pub const QUALIFICATION_VERSION: u32 = 1;
/// Fit without upscaling height, round coded geometry to even pixels, and
/// explicitly make the browser output square-pixel. FFmpeg otherwise adjusts
/// SAR after -2 width rounding (720p -> 854x480 yields SAR 1280:1281).
/// The existing measured aspect-ratio gate still bounds rounding distortion.
pub const H264_480P_VIDEO_FILTER: &str = "scale=w=-2:h='min(480,trunc(ih/2)*2)',setsar=1";
/// An exact, immutable recipe allowlist shared by admission, execution and
/// qualification. Nothing in a job can supply an encoder flag or filter.
#[derive(Debug, Clone, Copy)]
pub struct ComputeRecipe {
    pub id: &'static str,
    pub max_width: u32,
    pub max_height: u32,
    pub max_h264_level: i64,
    pub transcode: Option<H264Recipe>,
    pub segment_seconds: u32,
}
#[derive(Debug, Clone, Copy)]
pub struct H264Recipe {
    pub video_filter: &'static str,
    pub video_kbps: u32,
    pub max_video_kbps: u32,
    pub buffer_kbits: u32,
    pub audio_kbps: u32,
}
pub static COMPUTE_RECIPES: &[ComputeRecipe] = &[
    ComputeRecipe {
        id: "remux_hls_v1",
        max_width: 1920,
        max_height: 1080,
        max_h264_level: 42,
        transcode: None,
        segment_seconds: 4,
    },
    // Keep the legacy height-only fit and its bitrate settings unchanged.
    ComputeRecipe {
        id: "h264_480p_hls_v1",
        max_width: 1920,
        max_height: 480,
        max_h264_level: 42,
        transcode: Some(H264Recipe {
            video_filter: H264_480P_VIDEO_FILTER,
            video_kbps: 1000,
            max_video_kbps: 1200,
            buffer_kbits: 2400,
            audio_kbps: 96,
        }),
        segment_seconds: 4,
    },
    ComputeRecipe {
        id: "h264_720p_hls_v1",
        max_width: 1280,
        max_height: 720,
        max_h264_level: 42,
        transcode: Some(H264Recipe {
            video_filter: "scale=w='trunc(iw*min(1,min(1280/iw,720/ih))/2)*2':h='trunc(ih*min(1,min(1280/iw,720/ih))/2)*2',setsar=1",
            video_kbps: 2500,
            max_video_kbps: 3000,
            buffer_kbits: 6000,
            audio_kbps: 128,
        }),
        segment_seconds: 2,
    },
    ComputeRecipe {
        id: "h264_1080p_hls_v1",
        max_width: 1920,
        max_height: 1080,
        max_h264_level: 42,
        transcode: Some(H264Recipe {
            video_filter: "scale=w='trunc(iw*min(1,min(1920/iw,1080/ih))/2)*2':h='trunc(ih*min(1,min(1920/iw,1080/ih))/2)*2',setsar=1",
            video_kbps: 5000,
            max_video_kbps: 6000,
            buffer_kbits: 12000,
            audio_kbps: 128,
        }),
        segment_seconds: 2,
    },
    // Two-second keyframe-aligned segments and a one-second VBV buffer keep
    // UHD uploads inside the existing 8 MiB per-file bound, including TS overhead.
    ComputeRecipe {
        id: "h264_2160p_hls_v1",
        max_width: 3840,
        max_height: 2160,
        max_h264_level: 52,
        transcode: Some(H264Recipe {
            video_filter: "scale=w='trunc(iw*min(1,min(3840/iw,2160/ih))/2)*2':h='trunc(ih*min(1,min(3840/iw,2160/ih))/2)*2',setsar=1",
            video_kbps: 14000,
            max_video_kbps: 16000,
            buffer_kbits: 16000,
            audio_kbps: 192,
        }),
        segment_seconds: 2,
    },
];
pub fn compute_recipe(id: &str) -> Result<&'static ComputeRecipe> {
    COMPUTE_RECIPES
        .iter()
        .find(|r| r.id == id)
        .context("unsupported_structured_recipe")
}
impl ComputeRecipe {
    /// Conservative reservation, not a prediction or minimum actual file size:
    /// max video/audio rate, one VBV buffer, 20% mux margin and 64 KiB metadata.
    /// Remux has no fixed bitrate; non-finite/out-of-range durations fail closed.
    pub fn estimated_output_bytes(&self, duration_seconds: f64, with_audio: bool) -> Option<u64> {
        if !duration_seconds.is_finite()
            || duration_seconds <= 0.0
            || duration_seconds > MAX_SOURCE_DURATION_SECONDS
        {
            return None;
        }
        let h264 = self.transcode?;
        let kbps = h264.max_video_kbps + if with_audio { h264.audio_kbps } else { 0 };
        Some(
            (((duration_seconds * f64::from(kbps) + f64::from(h264.buffer_kbits)) * 125.0 * 1.2)
                .ceil() as u64)
                + 65536,
        )
    }
}
pub const MAX_SEGMENT_BYTES: u64 = 8 * 1024 * 1024;

/// Build only fixed allowlisted commands, with decoder, encoder and filters
/// bounded to one thread. Source paths and stream indices remain caller-scoped.
pub fn encode_command(
    ffmpeg: &str,
    source: &Path,
    output: &Path,
    video_index: u32,
    audio_index: Option<u32>,
    recipe: &str,
) -> Result<Command> {
    let recipe = compute_recipe(recipe)?;
    let mut command = Command::new(ffmpeg);
    crate::input_policy::clean_environment(&mut command);
    command
        .args([
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-xerror",
            "-err_detect",
            "explode",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "mov,matroska,webm",
            "-i",
        ])
        .arg(source)
        .arg("-map")
        .arg(format!("0:{video_index}"));
    if let Some(index) = audio_index {
        command.arg("-map").arg(format!("0:{index}"));
    }
    if let Some(h264) = recipe.transcode {
        command
            .args([
                "-vf",
                h264.video_filter,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-threads",
                "1",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg("-b:v")
            .arg(format!("{}k", h264.video_kbps))
            .arg("-maxrate")
            .arg(format!("{}k", h264.max_video_kbps))
            .arg("-bufsize")
            .arg(format!("{}k", h264.buffer_kbits));
        if recipe.segment_seconds == 2 {
            command.args([
                "-g",
                "120",
                "-keyint_min",
                "1",
                "-sc_threshold",
                "0",
                "-force_key_frames",
                "expr:gte(t,n_forced*2)",
            ]);
        } else {
            command.args(["-g", "100", "-keyint_min", "100", "-sc_threshold", "0"]);
        }
        command
            .args(["-c:a", "aac", "-b:a"])
            .arg(format!("{}k", h264.audio_kbps));
    } else {
        command.args(["-c", "copy"]);
    }
    command
        .args(["-f", "hls", "-hls_time"])
        .arg(recipe.segment_seconds.to_string())
        .args([
            "-hls_list_size",
            "0",
            "-hls_playlist_type",
            "vod",
            "-hls_flags",
            "temp_file",
            "-hls_segment_filename",
        ])
        .arg(output.join("segment%05d.ts"))
        .arg(output.join("index.m3u8"));
    Ok(command)
}

/// Check physical bytes, not optional/unreliable stream bitrate metadata.
/// Legacy recipes retain the existing global file cap. HD adds a recipe's
/// conservative rate/buffer envelope as a second bound.
pub fn validate_segment_size(
    recipe: &str,
    bytes: u64,
    duration_seconds: f64,
    with_audio: bool,
) -> Result<()> {
    let recipe = compute_recipe(recipe)?;
    ensure!(
        bytes > 0 && bytes <= MAX_SEGMENT_BYTES,
        "compute_segment_bounds"
    );
    if recipe.segment_seconds == 2 {
        let bound = recipe
            .estimated_output_bytes(duration_seconds, with_audio)
            .context("compute_segment_duration_mismatch")?;
        ensure!(bytes <= bound, "compute_segment_bitrate_exceeded");
    }
    Ok(())
}

const TIME_TOLERANCE: f64 = 0.25;
pub const MAX_SOURCE_DURATION_SECONDS: f64 = 1800.0;
pub const MAX_METADATA_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimelineFacts {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub frames: u64,
    pub max_gap_seconds: f64,
    pub max_overlap_seconds: f64,
    pub first_frame_key: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VideoFacts {
    pub index: u32,
    pub codec: String,
    pub pixel_format: String,
    pub width: u32,
    pub height: u32,
    pub timeline: TimelineFacts,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AudioFacts {
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub timeline: TimelineFacts,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaFacts {
    pub format_duration_seconds: f64,
    pub video: VideoFacts,
    pub audio: Option<AudioFacts>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Qualification {
    pub schema_version: u32,
    pub recipe: String,
    pub source_version: String,
    pub content_sha256: String,
    pub selected_video_index: u32,
    pub selected_audio_index: Option<u32>,
    pub source: MediaFacts,
    pub output: MediaFacts,
    /// First observed source video presentation timestamp; near-zero-only gate.
    pub timeline_origin_seconds: f64,
    /// Measured TS timestamp shift. It is not the room timeline origin.
    pub output_timestamp_offset_seconds: f64,
    /// Set only after a supervised strict decode of the complete VOD playlist.
    pub full_decode: bool,
}

fn number(value: &Value) -> Result<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|v| v.is_finite())
        .context("compute_probe_number_missing")
}
fn positive_u32(value: &Value) -> Result<u32> {
    let n = number(value)?;
    ensure!(
        n > 0.0 && n <= f64::from(u32::MAX) && n.fract() == 0.0,
        "compute_probe_integer_invalid"
    );
    Ok(n as u32)
}
fn rows(meta: &Value) -> Result<&[Value]> {
    let rows = meta["streams"]
        .as_array()
        .context("compute_probe_streams_missing")?;
    let mut seen = BTreeSet::new();
    for row in rows {
        let index = row["index"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .context("compute_probe_index_missing")?;
        ensure!(seen.insert(index), "compute_probe_duplicate_index");
    }
    Ok(rows)
}
fn selected<'a>(rows: &'a [Value], index: u32, kind: &str) -> Result<&'a Value> {
    let row = rows
        .iter()
        .find(|r| r["index"].as_u64() == Some(u64::from(index)))
        .context("compute_selected_stream_missing")?;
    ensure!(row["codec_type"] == kind, "compute_selected_stream_type");
    Ok(row)
}

/// Verify actual source probe against the immutable admitted selection. None is
/// an explicit no-audio selection; it never means choose the first audio row.
pub fn validate_source_probe(
    meta: &Value,
    video_index: u32,
    audio_index: Option<u32>,
    recipe: &str,
) -> Result<()> {
    let definition = compute_recipe(recipe)?;
    let selected_motion = crate::capabilities::validate_motion_source(meta)?;
    ensure!(
        selected_motion.stream["index"].as_u64() == Some(u64::from(video_index)),
        "compute_selected_video_changed"
    );
    let rows = rows(meta)?;
    let video = selected(rows, video_index, "video")?;
    ensure!(
        audio_index.is_some() || !rows.iter().any(|s| s["codec_type"] == "audio"),
        "compute_audio_selection_required"
    );
    ensure!(
        video["disposition"]["attached_pic"].as_u64() == Some(0),
        "compute_not_motion_video"
    );
    ensure!(
        !crate::video_needs_transform(video),
        "compute_source_video_transform_unsupported"
    );
    ensure!(
        matches!(video["sample_aspect_ratio"].as_str(), Some("1:1")),
        "compute_source_aspect_unsupported"
    );
    let start = number(&meta["format"]["start_time"])?;
    ensure!(start.abs() <= 0.05, "compute_source_nonzero_start");
    let duration = number(&meta["format"]["duration"])?;
    ensure!(
        duration > 0.0 && duration <= MAX_SOURCE_DURATION_SECONDS,
        "compute_source_duration_unsupported"
    );
    let width = positive_u32(&video["width"])?;
    let height = positive_u32(&video["height"])?;
    ensure!(
        width >= 2 && height >= 2 && width <= 7680 && height <= 4320,
        "compute_source_dimensions_unsupported"
    );
    if let Some(index) = audio_index {
        let audio = selected(rows, index, "audio")?;
        ensure!(
            (1..=2).contains(&positive_u32(&audio["channels"])?),
            "compute_source_audio_channels_unsupported"
        );
        let rate = positive_u32(&audio["sample_rate"])?;
        ensure!(
            matches!(
                rate,
                8000 | 11025 | 12000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000
            ),
            "compute_source_audio_rate_unsupported"
        );
        if recipe == "remux_hls_v1" {
            ensure!(
                audio["codec_name"] == "aac" && audio["profile"] == "LC",
                "compute_remux_audio_unsupported"
            );
        }
    }
    if recipe == "remux_hls_v1" {
        ensure!(
            video["codec_name"] == "h264"
                && video["pix_fmt"] == "yuv420p"
                && width <= definition.max_width
                && height <= definition.max_height,
            "compute_remux_video_unsupported"
        );
    }
    Ok(())
}

#[derive(Default)]
struct StreamTimeline {
    facts: Option<TimelineFacts>,
    previous_start: Option<f64>,
}
impl StreamTimeline {
    fn frame(&mut self, start: f64, duration: f64, key: bool) -> Result<()> {
        ensure!(
            start.is_finite() && duration.is_finite() && duration > 0.0 && duration <= 10.0,
            "compute_frame_time_invalid"
        );
        let end = start + duration;
        ensure!(end.is_finite(), "compute_frame_time_invalid");
        if let Some(previous) = self.previous_start {
            ensure!(start > previous, "compute_frame_timestamp_not_increasing");
        }
        if let Some(facts) = self.facts.as_mut() {
            let separation = start - facts.end_seconds;
            facts.max_gap_seconds = facts.max_gap_seconds.max(separation.max(0.0));
            facts.max_overlap_seconds = facts.max_overlap_seconds.max((-separation).max(0.0));
            facts.end_seconds = end;
            facts.frames += 1;
        } else {
            self.facts = Some(TimelineFacts {
                start_seconds: start,
                end_seconds: end,
                frames: 1,
                max_gap_seconds: 0.0,
                max_overlap_seconds: 0.0,
                first_frame_key: key,
            });
        }
        self.previous_start = Some(start);
        Ok(())
    }
}

/// Parse ffprobe compact frame records from a complete supervised process.
/// The bounded capture caller must not truncate and still mark the report valid.
pub fn measured_media_facts(
    meta: &Value,
    frame_output: &[u8],
    video_index: u32,
    audio_index: Option<u32>,
) -> Result<MediaFacts> {
    let rows = rows(meta)?;
    let video = selected(rows, video_index, "video")?;
    let audio = audio_index
        .map(|index| selected(rows, index, "audio"))
        .transpose()?;
    let rate = audio.map(|a| positive_u32(&a["sample_rate"])).transpose()?;
    let mut v = StreamTimeline::default();
    let mut a = StreamTimeline::default();
    for line in std::str::from_utf8(frame_output)?
        .lines()
        .filter(|line| !line.is_empty())
    {
        let fields: BTreeMap<_, _> = line
            .split('|')
            .filter_map(|field| field.split_once('='))
            .collect();
        // Side data can occupy its own compact line. A frame record must have
        // stream_index and media_type; other selected records are rejected.
        let Some(kind) = fields.get("media_type") else {
            continue;
        };
        let index: u32 = fields
            .get("stream_index")
            .context("compute_frame_index_missing")?
            .parse()?;
        let timeline = if index == video_index && *kind == "video" {
            &mut v
        } else if Some(index) == audio_index && *kind == "audio" {
            &mut a
        } else {
            continue;
        };
        let start: f64 = fields
            .get("pts_time")
            .context("compute_frame_pts_missing")?
            .parse()?;
        let best_effort: f64 = fields
            .get("best_effort_timestamp_time")
            .context("compute_frame_pts_missing")?
            .parse()?;
        ensure!(
            start.is_finite() && best_effort.is_finite() && (start - best_effort).abs() <= 0.000001,
            "compute_frame_timestamp_inferred"
        );
        if *kind == "video" {
            let width: u32 = fields
                .get("width")
                .context("compute_frame_dimensions_missing")?
                .parse()?;
            let height: u32 = fields
                .get("height")
                .context("compute_frame_dimensions_missing")?
                .parse()?;
            ensure!(
                width == positive_u32(&video["width"])?
                    && height == positive_u32(&video["height"])?
                    && fields.get("pix_fmt").copied() == video["pix_fmt"].as_str()
                    && fields.get("sample_aspect_ratio") == Some(&"1:1"),
                "compute_video_frame_configuration_changed"
            );
        } else {
            let channels: u32 = fields
                .get("channels")
                .context("compute_audio_frame_channels_missing")?
                .parse()?;
            ensure!(
                channels
                    == positive_u32(&audio.context("compute_audio_stream_missing")?["channels"])?,
                "compute_audio_frame_configuration_changed"
            );
        }
        let duration: f64 = if *kind == "audio" {
            let samples: u32 = fields
                .get("nb_samples")
                .context("compute_audio_samples_missing")?
                .parse()?;
            f64::from(samples) / f64::from(rate.context("compute_audio_rate_missing")?)
        } else {
            fields
                .get("duration_time")
                .or_else(|| fields.get("pkt_duration_time"))
                .context("compute_video_duration_missing")?
                .parse()?
        };
        timeline.frame(start, duration, fields.get("key_frame") == Some(&"1"))?;
    }
    Ok(MediaFacts {
        format_duration_seconds: number(&meta["format"]["duration"])?,
        video: VideoFacts {
            index: video_index,
            codec: video["codec_name"]
                .as_str()
                .context("compute_video_codec_missing")?
                .into(),
            pixel_format: video["pix_fmt"]
                .as_str()
                .context("compute_video_pixel_format_missing")?
                .into(),
            width: positive_u32(&video["width"])?,
            height: positive_u32(&video["height"])?,
            timeline: v.facts.context("compute_video_frames_missing")?,
        },
        audio: audio
            .map(|audio| {
                Ok::<_, anyhow::Error>(AudioFacts {
                    index: audio_index.expect("selected audio"),
                    codec: audio["codec_name"]
                        .as_str()
                        .context("compute_audio_codec_missing")?
                        .into(),
                    channels: positive_u32(&audio["channels"])?,
                    sample_rate: rate.expect("selected audio rate"),
                    timeline: a.facts.context("compute_audio_frames_missing")?,
                })
            })
            .transpose()?,
    })
}

/// Obtain output absolute indices only from a complete actual probe. The output
/// must contain exactly the encoded video and admitted optional audio.
pub fn output_selection(meta: &Value, with_audio: bool) -> Result<(u32, Option<u32>)> {
    output_selection_for_recipe(meta, with_audio, "remux_hls_v1")
}
pub fn output_selection_for_recipe(
    meta: &Value,
    with_audio: bool,
    recipe: &str,
) -> Result<(u32, Option<u32>)> {
    let definition = compute_recipe(recipe)?;
    let rows = rows(meta)?;
    ensure!(
        rows.len() == if with_audio { 2 } else { 1 },
        "compute_output_unexpected_streams"
    );
    let videos: Vec<_> = rows.iter().filter(|r| r["codec_type"] == "video").collect();
    let audio: Vec<_> = rows.iter().filter(|r| r["codec_type"] == "audio").collect();
    ensure!(
        videos.len() == 1 && audio.len() == usize::from(with_audio),
        "compute_output_stream_selection"
    );
    ensure!(
        videos[0]["disposition"]["attached_pic"].as_u64() == Some(0),
        "compute_output_not_motion_video"
    );
    let video = videos[0];
    ensure!(
        video["codec_name"] == "h264"
            && video["pix_fmt"] == "yuv420p"
            && matches!(
                video["profile"].as_str(),
                Some("Baseline" | "Constrained Baseline" | "Main" | "High")
            )
            && video["level"]
                .as_i64()
                .is_some_and(|level| (1..=definition.max_h264_level).contains(&level))
            && positive_u32(&video["width"])? <= definition.max_width
            && positive_u32(&video["height"])? <= definition.max_height,
        "compute_output_video_profile_unsupported"
    );
    let rate = |value: &Value| -> Option<f64> {
        let (n, d) = value.as_str()?.split_once('/')?;
        let rate = n.parse::<f64>().ok()? / d.parse::<f64>().ok()?;
        (rate.is_finite() && rate > 0.0 && rate <= 60.0).then_some(rate)
    };
    ensure!(
        rate(&video["avg_frame_rate"]).is_some() && rate(&video["r_frame_rate"]).is_some(),
        "compute_output_frame_rate_unsupported"
    );
    if let Some(a) = audio.first() {
        ensure!(
            a["profile"] == "LC",
            "compute_output_audio_profile_unsupported"
        );
    }
    Ok((
        videos[0]["index"].as_u64().unwrap() as u32,
        audio.first().map(|a| a["index"].as_u64().unwrap() as u32),
    ))
}

fn validate_timeline(t: &TimelineFacts, video: bool) -> Result<()> {
    ensure!(
        t.start_seconds.is_finite()
            && t.end_seconds.is_finite()
            && t.end_seconds > t.start_seconds
            && t.frames > 0
            && t.max_gap_seconds.is_finite()
            && (0.0..=0.005).contains(&t.max_gap_seconds)
            && t.max_overlap_seconds.is_finite()
            && (0.0..=0.005).contains(&t.max_overlap_seconds),
        "compute_timeline_discontinuous"
    );
    if video {
        ensure!(t.first_frame_key, "compute_video_not_random_access");
    }
    Ok(())
}
fn validate_media(m: &MediaFacts) -> Result<()> {
    ensure!(
        m.format_duration_seconds.is_finite()
            && m.format_duration_seconds > 0.0
            && m.format_duration_seconds <= MAX_SOURCE_DURATION_SECONDS + 1.0,
        "compute_duration_invalid"
    );
    ensure!(
        !m.video.codec.is_empty()
            && !m.video.pixel_format.is_empty()
            && (1..=16384).contains(&m.video.width)
            && (1..=16384).contains(&m.video.height),
        "compute_video_facts_invalid"
    );
    validate_timeline(&m.video.timeline, true)?;
    let mut start = m.video.timeline.start_seconds;
    let mut end = m.video.timeline.end_seconds;
    if let Some(a) = &m.audio {
        ensure!(
            !a.codec.is_empty()
                && (1..=2).contains(&a.channels)
                && a.sample_rate > 0
                && a.sample_rate <= 48000
                && a.index != m.video.index,
            "compute_audio_facts_invalid"
        );
        validate_timeline(&a.timeline, false)?;
        ensure!(
            (a.timeline.start_seconds - start).abs() <= TIME_TOLERANCE
                && (a.timeline.end_seconds - end).abs() <= TIME_TOLERANCE,
            "compute_audio_video_alignment"
        );
        start = start.min(a.timeline.start_seconds);
        end = end.max(a.timeline.end_seconds);
    }
    ensure!(
        ((end - start) - m.format_duration_seconds).abs() <= TIME_TOLERANCE,
        "compute_probe_duration_mismatch"
    );
    Ok(())
}

/// Pure conservative validation for the Server as well as the node. Passing
/// this validates the bounded report; callers must separately bind the attempt,
/// immutable stored bytes, source identity and admitted stream selection.
pub fn validate_qualification(q: &Qualification) -> Result<()> {
    ensure!(
        q.schema_version == QUALIFICATION_VERSION && q.full_decode,
        "compute_qualification_version_or_decode"
    );
    ensure!(
        !q.source_version.is_empty()
            && q.content_sha256.len() == 64
            && q.content_sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "compute_qualification_source_identity"
    );
    compute_recipe(&q.recipe)?;
    ensure!(
        q.source.video.index == q.selected_video_index
            && q.source.audio.as_ref().map(|a| a.index) == q.selected_audio_index,
        "compute_qualification_selection"
    );
    validate_media(&q.source)?;
    validate_media(&q.output)?;
    ensure!(
        q.timeline_origin_seconds.is_finite()
            && (q.timeline_origin_seconds - q.source.video.timeline.start_seconds).abs()
                <= 0.000001,
        "compute_primary_origin_unsupported"
    );
    ensure!(
        q.output_timestamp_offset_seconds.is_finite()
            && (q.output_timestamp_offset_seconds
                - (q.output.video.timeline.start_seconds - q.source.video.timeline.start_seconds))
                .abs()
                <= 0.000001,
        "compute_timestamp_offset_mismatch"
    );
    validate_output_relationship(&q.source, &q.output, &q.recipe)
}

pub fn validate_output_relationship(
    source: &MediaFacts,
    output: &MediaFacts,
    recipe: &str,
) -> Result<()> {
    let definition = compute_recipe(recipe)?;
    validate_media(source)?;
    ensure!(
        source.format_duration_seconds <= MAX_SOURCE_DURATION_SECONDS,
        "compute_source_duration_unsupported"
    );
    validate_media(output)?;
    let source_v = &source.video.timeline;
    let output_v = &output.video.timeline;
    ensure!(
        source_v.start_seconds.abs() <= 0.001,
        "compute_primary_origin_unsupported"
    );
    ensure!(
        (source.format_duration_seconds - output.format_duration_seconds).abs() <= TIME_TOLERANCE
            && ((source_v.end_seconds - source_v.start_seconds)
                - (output_v.end_seconds - output_v.start_seconds))
                .abs()
                <= TIME_TOLERANCE,
        "compute_duration_not_preserved"
    );
    ensure!(
        output.video.codec == "h264" && output.video.pixel_format == "yuv420p",
        "compute_output_video_unsupported"
    );
    match (&source.audio, &output.audio) {
        (None, None) => (),
        (Some(source), Some(output)) => {
            ensure!(
                output.codec == "aac"
                    && source.channels == output.channels
                    && source.sample_rate == output.sample_rate,
                "compute_audio_not_preserved"
            );
            ensure!(
                ((output.timeline.start_seconds - output_v.start_seconds)
                    - (source.timeline.start_seconds - source_v.start_seconds))
                    .abs()
                    <= 0.075
                    && ((output.timeline.end_seconds - output_v.end_seconds)
                        - (source.timeline.end_seconds - source_v.end_seconds))
                        .abs()
                        <= 0.15,
                "compute_audio_video_relation_changed"
            );
            if recipe == "remux_hls_v1" {
                ensure!(source.codec == output.codec, "compute_remux_audio_changed");
            }
        }
        _ => anyhow::bail!("compute_audio_selection_not_preserved"),
    }
    ensure!(
        output.video.width <= definition.max_width && output.video.height <= definition.max_height,
        "compute_output_dimensions_unsupported"
    );
    if recipe == "remux_hls_v1" {
        ensure!(
            source.video.codec == output.video.codec
                && source.video.pixel_format == output.video.pixel_format
                && source.video.width == output.video.width
                && source.video.height == output.video.height,
            "compute_remux_video_changed"
        );
    } else {
        ensure!(
            output.video.height <= definition.max_height
                && output.video.height <= source.video.height
                && output.video.width <= source.video.width
                && output.video.width.is_multiple_of(2)
                && output.video.height.is_multiple_of(2),
            "compute_transcode_dimensions_invalid"
        );
        let original_ratio = f64::from(source.video.width) / f64::from(source.video.height);
        let new_ratio = f64::from(output.video.width) / f64::from(output.video.height);
        ensure!(
            (original_ratio / new_ratio - 1.0).abs() <= 0.02,
            "compute_transcode_aspect_changed"
        );
    }
    Ok(())
}

/// Actual source stream identities and measured presentation at the beginning
/// are required even if a legacy catalog admitted an otherwise sparse job.
pub fn qualify_source(
    meta: &Value,
    frame_output: &[u8],
    video_index: u32,
    audio_index: Option<u32>,
    recipe: &str,
) -> Result<MediaFacts> {
    validate_source_probe(meta, video_index, audio_index, recipe)?;
    let facts = measured_media_facts(meta, frame_output, video_index, audio_index)?;
    validate_media(&facts)?;
    ensure!(
        facts.video.timeline.start_seconds.abs() <= 0.001,
        "compute_primary_origin_unsupported"
    );
    Ok(facts)
}

fn local_probe_command(program: &str, generated: bool) -> Command {
    let mut command = Command::new(program);
    crate::input_policy::clean_environment(&mut command);
    command.args([
        "-v",
        "error",
        "-err_detect",
        "explode",
        "-threads",
        "1",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        if generated {
            "hls,mpegts"
        } else {
            "mov,matroska,webm"
        },
    ]);
    command
}
pub fn metadata_command(ffprobe: &str, path: &Path, generated: bool) -> Command {
    let mut command = local_probe_command(ffprobe, generated);
    command
        .args(["-show_format", "-show_streams", "-of", "json"])
        .arg(path);
    command
}
pub fn frames_command(ffprobe: &str, path: &Path, generated: bool) -> Command {
    let mut command = local_probe_command(ffprobe, generated);
    command.args(["-show_frames", "-show_entries", "frame=media_type,stream_index,key_frame,pts_time,best_effort_timestamp_time,pkt_duration_time,duration_time,nb_samples,width,height,pix_fmt,sample_aspect_ratio,channels", "-of", "compact=p=0:nk=0"]).arg(path);
    command
}
pub fn decode_command(
    ffmpeg: &str,
    manifest: &Path,
    video_index: u32,
    audio_index: Option<u32>,
) -> Command {
    let mut command = Command::new(ffmpeg);
    crate::input_policy::clean_environment(&mut command);
    command
        .args([
            "-v",
            "error",
            "-nostdin",
            "-xerror",
            "-err_detect",
            "explode",
            "-threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "hls,mpegts",
            "-i",
        ])
        .arg(manifest)
        .arg("-map")
        .arg(format!("0:{video_index}"));
    if let Some(index) = audio_index {
        command.arg("-map").arg(format!("0:{index}"));
    }
    command.args(["-threads", "1", "-max_error_rate", "0", "-f", "null", "-"]);
    command
}

#[derive(Debug, Clone)]
pub struct PlaylistSegment {
    pub filename: String,
    pub duration_seconds: f64,
}
#[derive(Debug, Clone)]
pub struct SegmentTiming {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

pub fn generated_segments(
    bytes: &[u8],
    filenames: &BTreeSet<String>,
) -> Result<Vec<PlaylistSegment>> {
    generated_segments_for_recipe(bytes, filenames, "remux_hls_v1")
}
pub fn generated_segments_for_recipe(
    bytes: &[u8],
    filenames: &BTreeSet<String>,
    recipe: &str,
) -> Result<Vec<PlaylistSegment>> {
    let definition = compute_recipe(recipe)?;
    let names = validate_generated_playlist(bytes, filenames)?;
    let durations = std::str::from_utf8(bytes)?
        .lines()
        .filter_map(|line| line.strip_prefix("#EXTINF:"))
        .map(|line| {
            line.split_once(',')
                .context("compute_playlist_duration")?
                .0
                .parse::<f64>()
                .map_err(Into::into)
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        names.len() == durations.len()
            && names.len()
                <= (MAX_SOURCE_DURATION_SECONDS as usize / definition.segment_seconds as usize) + 1,
        "compute_playlist_segment_count"
    );
    Ok(names
        .into_iter()
        .zip(durations)
        .map(|(filename, duration_seconds)| PlaylistSegment {
            filename,
            duration_seconds,
        })
        .collect())
}

/// Decode a bounded initial window to prove every segment independently starts
/// with a random-access frame. A metadata row alone cannot establish that fact.
pub fn first_segment_frames_command(ffprobe: &str, segment: &Path, video_index: u32) -> Command {
    let mut command = local_probe_command(ffprobe, true);
    command.arg("-select_streams").arg(video_index.to_string())
        .args(["-read_intervals", "%+0.5", "-show_frames", "-show_entries", "frame=media_type,stream_index,key_frame,pts_time,best_effort_timestamp_time,pkt_duration_time,duration_time,nb_samples,width,height,pix_fmt,sample_aspect_ratio,channels", "-of", "compact=p=0:nk=0"])
        .arg(segment);
    command
}

/// Bind each independently probed MPEG-TS segment to both its EXTINF seek index
/// and the complete decoded video timeline. Audio/video stream identities and
/// configuration must remain invariant across every segment.
#[allow(clippy::too_many_arguments)]
pub fn check_segment_probe(
    meta: &Value,
    first_frames: &[u8],
    complete: &MediaFacts,
    recipe: &str,
    declared_duration: f64,
    playlist_elapsed: f64,
    previous_end: Option<f64>,
) -> Result<SegmentTiming> {
    ensure!(
        meta["format"]["format_name"] == "mpegts",
        "compute_segment_container_unsupported"
    );
    let (video_index, audio_index) =
        output_selection_for_recipe(meta, complete.audio.is_some(), recipe)?;
    ensure!(
        video_index == complete.video.index
            && audio_index == complete.audio.as_ref().map(|a| a.index),
        "compute_segment_stream_selection_changed"
    );
    let rows = rows(meta)?;
    let video = selected(rows, video_index, "video")?;
    ensure!(
        positive_u32(&video["width"])? == complete.video.width
            && positive_u32(&video["height"])? == complete.video.height
            && video["codec_name"] == complete.video.codec
            && video["pix_fmt"] == complete.video.pixel_format,
        "compute_segment_video_configuration_changed"
    );
    if let Some(audio) = &complete.audio {
        let row = selected(rows, audio.index, "audio")?;
        ensure!(
            row["codec_name"] == audio.codec
                && positive_u32(&row["channels"])? == audio.channels
                && positive_u32(&row["sample_rate"])? == audio.sample_rate,
            "compute_segment_audio_configuration_changed"
        );
    }
    let first = measured_media_facts(meta, first_frames, video_index, None)?;
    validate_timeline(&first.video.timeline, true)?;
    let start = first.video.timeline.start_seconds;
    let meta_start = number(&video["start_time"])?;
    let duration = number(&video["duration"])?;
    ensure!(
        (meta_start - start).abs() <= 0.005
            && duration > 0.0
            && duration <= 60.25
            && declared_duration.is_finite()
            && (duration - declared_duration).abs() <= TIME_TOLERANCE,
        "compute_segment_duration_mismatch"
    );
    ensure!(
        playlist_elapsed.is_finite()
            && playlist_elapsed >= 0.0
            && ((start - complete.video.timeline.start_seconds) - playlist_elapsed).abs()
                <= TIME_TOLERANCE,
        "compute_segment_seek_index_mismatch"
    );
    if let Some(end) = previous_end {
        ensure!(
            end.is_finite() && (start - end).abs() <= 0.005,
            "compute_segment_timeline_discontinuous"
        );
    } else {
        ensure!(
            (start - complete.video.timeline.start_seconds).abs() <= 0.005,
            "compute_segment_first_frame_mismatch"
        );
    }
    Ok(SegmentTiming {
        start_seconds: start,
        end_seconds: start + duration,
    })
}

pub fn check_segment_end(last_end: Option<f64>, complete: &MediaFacts) -> Result<()> {
    let end = last_end.context("compute_output_segments_missing")?;
    ensure!(
        end.is_finite() && (end - complete.video.timeline.end_seconds).abs() <= 0.005,
        "compute_segment_last_frame_mismatch"
    );
    Ok(())
}

/// Independent qualification of uploaded immutable output. The caller owns the
/// attempt lease and must run/cancel this inside its process Scope and positively
/// drain that same Scope before acknowledging an attempt after cancellation.
/// Source facts remain authenticated NAS evidence; this probes only output.
pub async fn check_output(
    ffmpeg: &str,
    ffprobe: &str,
    manifest: &Path,
    source: &MediaFacts,
    recipe: &str,
) -> Result<MediaFacts> {
    ensure!(
        manifest
            .file_name()
            .is_some_and(|name| name == "index.m3u8"),
        "compute_output_manifest_name"
    );
    let directory = manifest
        .parent()
        .context("compute_output_manifest_parent")?;
    let mut entries = tokio::fs::read_dir(directory).await?;
    let mut names = BTreeSet::new();
    while let Some(entry) = entries.next_entry().await? {
        ensure!(
            entry.file_type().await?.is_file(),
            "unexpected_compute_output"
        );
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("invalid_compute_filename"))?;
        ensure!(names.insert(name), "duplicate_compute_filename");
    }
    let playlist = tokio::fs::read(manifest).await?;
    let segments = generated_segments_for_recipe(&playlist, &names, recipe)?;
    let (status, bytes) = crate::child_process::capture(
        metadata_command(ffprobe, manifest, true),
        Duration::from_secs(1800),
        MAX_METADATA_BYTES,
    )
    .await?;
    ensure!(status.success(), "compute_output_probe_failed");
    let meta: Value = serde_json::from_slice(&bytes)?;
    let (video_index, audio_index) =
        output_selection_for_recipe(&meta, source.audio.is_some(), recipe)?;
    let (status, frames) = crate::child_process::capture(
        frames_command(ffprobe, manifest, true),
        Duration::from_secs(1800),
        MAX_FRAME_BYTES,
    )
    .await?;
    ensure!(status.success(), "compute_output_frame_probe_failed");
    let output = measured_media_facts(&meta, &frames, video_index, audio_index)?;
    validate_output_relationship(source, &output, recipe)?;
    let (status, _) = crate::child_process::capture(
        decode_command(ffmpeg, manifest, video_index, audio_index),
        Duration::from_secs(1800),
        4096,
    )
    .await?;
    ensure!(status.success(), "compute_output_full_decode_failed");
    let mut elapsed = 0.0;
    let mut previous_end = None;
    for segment in segments {
        let path = directory.join(&segment.filename);
        validate_segment_size(
            recipe,
            tokio::fs::metadata(&path).await?.len(),
            segment.duration_seconds,
            source.audio.is_some(),
        )?;
        let (status, bytes) = crate::child_process::capture(
            metadata_command(ffprobe, &path, true),
            Duration::from_secs(60),
            MAX_METADATA_BYTES,
        )
        .await?;
        ensure!(status.success(), "compute_segment_probe_failed");
        let meta: Value = serde_json::from_slice(&bytes)?;
        let (status, frames) = crate::child_process::capture(
            first_segment_frames_command(ffprobe, &path, output.video.index),
            Duration::from_secs(60),
            MAX_METADATA_BYTES,
        )
        .await?;
        ensure!(status.success(), "compute_segment_frame_probe_failed");
        let timing = check_segment_probe(
            &meta,
            &frames,
            &output,
            recipe,
            segment.duration_seconds,
            elapsed,
            previous_end,
        )?;
        previous_end = Some(timing.end_seconds);
        elapsed += segment.duration_seconds;
    }
    check_segment_end(previous_end, &output)?;
    Ok(output)
}

/// Require the claimed output report to agree with independent measured facts.
/// This is deliberately tighter than source/output encoding tolerances.
pub fn verify_output_report(claimed: &MediaFacts, measured: &MediaFacts) -> Result<()> {
    fn timeline(a: &TimelineFacts, b: &TimelineFacts) -> bool {
        a.frames == b.frames
            && a.first_frame_key == b.first_frame_key
            && (a.start_seconds - b.start_seconds).abs() <= 0.001
            && (a.end_seconds - b.end_seconds).abs() <= 0.001
            && (a.max_gap_seconds - b.max_gap_seconds).abs() <= 0.001
            && (a.max_overlap_seconds - b.max_overlap_seconds).abs() <= 0.001
    }
    validate_media(claimed)?;
    validate_media(measured)?;
    ensure!(
        (claimed.format_duration_seconds - measured.format_duration_seconds).abs() <= 0.001
            && claimed.video.index == measured.video.index
            && claimed.video.codec == measured.video.codec
            && claimed.video.pixel_format == measured.video.pixel_format
            && claimed.video.width == measured.video.width
            && claimed.video.height == measured.video.height
            && timeline(&claimed.video.timeline, &measured.video.timeline),
        "compute_output_report_mismatch"
    );
    match (&claimed.audio, &measured.audio) {
        (None, None) => (),
        (Some(a), Some(b)) => ensure!(
            a.index == b.index
                && a.codec == b.codec
                && a.channels == b.channels
                && a.sample_rate == b.sample_rate
                && timeline(&a.timeline, &b.timeline),
            "compute_output_report_mismatch"
        ),
        _ => anyhow::bail!("compute_output_report_mismatch"),
    }
    Ok(())
}

/// Only our finite unencrypted MPEG-TS VOD grammar is probeable. No URI from a
/// node claim or arbitrary source manifest is ever fed to the HLS demuxer.
pub fn validate_generated_playlist(
    bytes: &[u8],
    filenames: &BTreeSet<String>,
) -> Result<Vec<String>> {
    ensure!(bytes.len() <= 1024 * 1024, "compute_playlist_size");
    let text = std::str::from_utf8(bytes)?;
    let mut lines = text.lines();
    ensure!(lines.next() == Some("#EXTM3U"), "compute_playlist_header");
    let mut segments = Vec::new();
    let mut pending_duration = false;
    let mut end = false;
    let mut vod = false;
    let mut sequence = false;
    for line in lines {
        ensure!(!end, "compute_playlist_after_end");
        if line == "#EXT-X-ENDLIST" {
            ensure!(!pending_duration, "compute_playlist_missing_segment");
            end = true;
        } else if line == "#EXT-X-PLAYLIST-TYPE:VOD" {
            ensure!(!vod, "compute_playlist_duplicate_tag");
            vod = true;
        } else if line == "#EXT-X-MEDIA-SEQUENCE:0" {
            ensure!(!sequence, "compute_playlist_duplicate_tag");
            sequence = true;
        } else if let Some(value) = line.strip_prefix("#EXTINF:") {
            ensure!(!pending_duration, "compute_playlist_missing_segment");
            let (seconds, title) = value.split_once(',').context("compute_playlist_duration")?;
            let duration: f64 = seconds.parse()?;
            ensure!(
                duration.is_finite() && duration > 0.0 && duration <= 60.0 && title.is_empty(),
                "compute_playlist_duration"
            );
            pending_duration = true;
        } else if let Some(value) = line.strip_prefix("#EXT-X-VERSION:") {
            ensure!(matches!(value, "3" | "4" | "6"), "compute_playlist_version");
        } else if let Some(value) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            ensure!(
                (1..=60).contains(&value.parse::<u32>()?),
                "compute_playlist_target_duration"
            );
        } else {
            ensure!(
                pending_duration
                    && !line.starts_with('#')
                    && line.len() == "segment00000.ts".len()
                    && line.starts_with("segment")
                    && line.ends_with(".ts")
                    && line[7..12].bytes().all(|c| c.is_ascii_digit())
                    && filenames.contains(line),
                "compute_playlist_external_or_unsupported"
            );
            ensure!(
                line == format!("segment{:05}.ts", segments.len()),
                "compute_playlist_segment_order"
            );
            segments.push(line.to_owned());
            pending_duration = false;
        }
    }
    ensure!(
        end && vod && sequence && !pending_duration && !segments.is_empty(),
        "compute_playlist_incomplete"
    );
    ensure!(
        filenames.len() == segments.len() + 1 && filenames.contains("index.m3u8"),
        "compute_playlist_extra_files"
    );
    Ok(segments)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn meta() -> Value {
        json!({"format":{"duration":"1.0"},"streams":[{"index":4,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","width":640,"height":480}]})
    }
    #[test]
    fn frame_facts_are_measured_and_discontinuities_are_visible() {
        let frames = b"media_type=video|stream_index=4|key_frame=1|pts_time=0|best_effort_timestamp_time=0|pkt_duration_time=0.5|width=640|height=480|pix_fmt=yuv420p|sample_aspect_ratio=1:1\nmedia_type=video|stream_index=4|key_frame=0|pts_time=0.5|best_effort_timestamp_time=0.5|pkt_duration_time=0.5|width=640|height=480|pix_fmt=yuv420p|sample_aspect_ratio=1:1\n";
        let facts = measured_media_facts(&meta(), frames, 4, None).unwrap();
        assert_eq!(facts.video.timeline.end_seconds, 1.0);
        validate_media(&facts).unwrap();
        let gap = String::from_utf8(frames.to_vec())
            .unwrap()
            .replace("timestamp_time=0.5", "timestamp_time=0.7")
            .replace("pts_time=0.5", "pts_time=0.7");
        assert!(
            validate_media(&measured_media_facts(&meta(), gap.as_bytes(), 4, None).unwrap())
                .is_err()
        );
        assert!(measured_media_facts(&meta(), b"", 4, None).is_err());
    }
    #[test]
    fn qualification_binds_selection_origin_duration_and_av_relationship() {
        let facts = measured_media_facts(&meta(), b"media_type=video|stream_index=4|key_frame=1|pts_time=0|best_effort_timestamp_time=0|pkt_duration_time=1|width=640|height=480|pix_fmt=yuv420p|sample_aspect_ratio=1:1\n", 4, None).unwrap();
        let mut q = Qualification {
            schema_version: 1,
            recipe: "remux_hls_v1".into(),
            source_version: "version".into(),
            content_sha256: "a".repeat(64),
            selected_video_index: 4,
            selected_audio_index: None,
            source: facts.clone(),
            output: facts,
            timeline_origin_seconds: 0.0,
            output_timestamp_offset_seconds: 0.0,
            full_decode: true,
        };
        validate_qualification(&q).unwrap();
        q.timeline_origin_seconds = 10.0;
        assert!(validate_qualification(&q).is_err());
        q.timeline_origin_seconds = 0.0;
        q.selected_video_index = 0;
        assert!(validate_qualification(&q).is_err());
        q.selected_video_index = 4;
        q.full_decode = false;
        assert!(validate_qualification(&q).is_err());
    }
    #[test]
    fn generated_playlist_cannot_enable_external_inputs_or_discontinuity() {
        let names = BTreeSet::from(["index.m3u8".into(), "segment00000.ts".into()]);
        let good = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1.000000,\nsegment00000.ts\n#EXT-X-ENDLIST\n";
        validate_generated_playlist(good.as_bytes(), &names).unwrap();
        for bad in [
            good.replace("segment00000.ts", "https://example.org/input.ts"),
            good.replace("#EXTINF:", "#EXT-X-DISCONTINUITY\n#EXTINF:"),
            good.replace(
                "#EXTINF:",
                "#EXT-X-KEY:METHOD=AES-128,URI=\"secret\"\n#EXTINF:",
            ),
            good.replace("MEDIA-SEQUENCE:0", "MEDIA-SEQUENCE:1"),
        ] {
            assert!(validate_generated_playlist(bad.as_bytes(), &names).is_err());
        }
    }
    #[test]
    fn output_profile_and_frame_rate_are_measured_and_bounded() {
        let mut output = json!({"streams":[{"index":0,"codec_type":"video","codec_name":"h264","profile":"High","level":31,"pix_fmt":"yuv420p","width":854,"height":480,"r_frame_rate":"25/1","avg_frame_rate":"25/1","disposition":{"attached_pic":0}}]});
        output_selection(&output, false).unwrap();
        output["streams"][0]["level"] = json!(51);
        assert!(output_selection(&output, false).is_err());
        output["streams"][0]["level"] = json!(31);
        output["streams"][0]["avg_frame_rate"] = json!("120/1");
        assert!(output_selection(&output, false).is_err());
        output["streams"][0]["avg_frame_rate"] = json!("25/1");
        output["streams"][0]["profile"] = json!("High 4:4:4 Predictive");
        assert!(output_selection(&output, false).is_err());
    }
    #[tokio::test]
    #[ignore = "requires installed official FFmpeg and FFprobe"]
    async fn actual_ffmpeg_output_is_independently_probed_and_corruption_rejected() {
        let ffmpeg = std::env::var("FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
        let ffprobe = std::env::var("FFPROBE").unwrap_or_else(|_| "ffprobe".into());
        let root =
            std::env::temp_dir().join(format!("rainsync-qualified-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let source = root.join("source.mp4");
        let mut fixture = Command::new(&ffmpeg);
        fixture
            .args([
                "-v",
                "error",
                "-nostdin",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x480:rate=25:duration=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=1",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-threads",
                "1",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
            ])
            .arg(&source);
        let (status, _) = crate::child_process::capture(fixture, Duration::from_secs(20), 4096)
            .await
            .unwrap();
        assert!(status.success());
        let (status, bytes) = crate::child_process::capture(
            metadata_command(&ffprobe, &source, false),
            Duration::from_secs(20),
            MAX_METADATA_BYTES,
        )
        .await
        .unwrap();
        assert!(status.success());
        let meta: Value = serde_json::from_slice(&bytes).unwrap();
        let (status, frames) = crate::child_process::capture(
            frames_command(&ffprobe, &source, false),
            Duration::from_secs(20),
            MAX_FRAME_BYTES,
        )
        .await
        .unwrap();
        assert!(status.success());
        let original = qualify_source(&meta, &frames, 0, Some(1), "remux_hls_v1").unwrap();
        assert!(qualify_source(&meta, &frames, 1, Some(0), "remux_hls_v1").is_err());
        assert!(qualify_source(&meta, &frames, 0, Some(1), "arbitrary_recipe").is_err());
        let output = root.join("output");
        tokio::fs::create_dir_all(&output).await.unwrap();
        let manifest = output.join("index.m3u8");
        let mut remux = Command::new(&ffmpeg);
        remux
            .args([
                "-v",
                "error",
                "-nostdin",
                "-y",
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                "mov,matroska,webm",
                "-i",
            ])
            .arg(&source)
            .args([
                "-map",
                "0:0",
                "-map",
                "0:1",
                "-c",
                "copy",
                "-f",
                "hls",
                "-hls_time",
                "4",
                "-hls_list_size",
                "0",
                "-hls_playlist_type",
                "vod",
                "-hls_flags",
                "temp_file",
                "-hls_segment_filename",
            ])
            .arg(output.join("segment%05d.ts"))
            .arg(&manifest);
        let (status, _) = crate::child_process::capture(remux, Duration::from_secs(20), 4096)
            .await
            .unwrap();
        assert!(status.success());
        let measured = check_output(&ffmpeg, &ffprobe, &manifest, &original, "remux_hls_v1")
            .await
            .unwrap();
        assert!(measured.video.timeline.start_seconds > 1.0);
        verify_output_report(&measured, &measured).unwrap();
        let mut false_report = measured.clone();
        false_report.video.width = 1280;
        assert!(verify_output_report(&false_report, &measured).is_err());
        // Replacing immutable uploaded bytes must prevent qualification.
        tokio::fs::write(output.join("segment00000.ts"), b"not a transport stream")
            .await
            .unwrap();
        assert!(
            check_output(&ffmpeg, &ffprobe, &manifest, &original, "remux_hls_v1")
                .await
                .is_err()
        );
        tokio::fs::remove_dir_all(&root).await.unwrap();
    }
    #[tokio::test]
    #[ignore = "requires installed official FFmpeg and FFprobe"]
    async fn actual_720p_to_480p_recipe_preserves_square_pixels_and_selected_audio() {
        let ffmpeg = std::env::var("FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
        let ffprobe = std::env::var("FFPROBE").unwrap_or_else(|_| "ffprobe".into());
        let root =
            std::env::temp_dir().join(format!("rainsync-qualified-720p-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let source = root.join("source.mp4");
        let mut fixture = Command::new(&ffmpeg);
        fixture
            .args([
                "-v",
                "error",
                "-nostdin",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=1280x720:rate=25:duration=5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=5",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-threads",
                "1",
                "-pix_fmt",
                "yuv420p",
                "-g",
                "100",
                "-keyint_min",
                "100",
                "-sc_threshold",
                "0",
                "-c:a",
                "aac",
            ])
            .arg(&source);
        let (status, _) = crate::child_process::capture(fixture, Duration::from_secs(30), 4096)
            .await
            .unwrap();
        assert!(status.success());
        let (status, bytes) = crate::child_process::capture(
            metadata_command(&ffprobe, &source, false),
            Duration::from_secs(30),
            MAX_METADATA_BYTES,
        )
        .await
        .unwrap();
        assert!(status.success());
        let meta: Value = serde_json::from_slice(&bytes).unwrap();
        let (status, frames) = crate::child_process::capture(
            frames_command(&ffprobe, &source, false),
            Duration::from_secs(30),
            MAX_FRAME_BYTES,
        )
        .await
        .unwrap();
        assert!(status.success());
        let original = qualify_source(&meta, &frames, 0, Some(1), "h264_480p_hls_v1").unwrap();
        let output = root.join("output");
        tokio::fs::create_dir_all(&output).await.unwrap();
        let manifest = output.join("index.m3u8");
        for (filter, square_pixels) in [
            ("scale=w=-2:h='min(480,ih)'", false),
            (H264_480P_VIDEO_FILTER, true),
        ] {
            let mut encode = Command::new(&ffmpeg);
            encode
                .args([
                    "-v",
                    "error",
                    "-nostdin",
                    "-y",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-format_whitelist",
                    "mov,matroska,webm",
                    "-i",
                ])
                .arg(&source)
                .args([
                    "-map",
                    "0:0",
                    "-map",
                    "0:1",
                    "-vf",
                    filter,
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-threads",
                    "1",
                    "-pix_fmt",
                    "yuv420p",
                    "-b:v",
                    "1000k",
                    "-maxrate",
                    "1200k",
                    "-bufsize",
                    "2400k",
                    "-g",
                    "100",
                    "-keyint_min",
                    "100",
                    "-sc_threshold",
                    "0",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "96k",
                    "-f",
                    "hls",
                    "-hls_time",
                    "4",
                    "-hls_list_size",
                    "0",
                    "-hls_playlist_type",
                    "vod",
                    "-hls_flags",
                    "temp_file",
                    "-hls_segment_filename",
                ])
                .arg(output.join("segment%05d.ts"))
                .arg(&manifest);
            let (status, _) = crate::child_process::capture(encode, Duration::from_secs(30), 4096)
                .await
                .unwrap();
            assert!(status.success());
            let measured =
                check_output(&ffmpeg, &ffprobe, &manifest, &original, "h264_480p_hls_v1").await;
            if square_pixels {
                let measured = measured.unwrap();
                assert_eq!((measured.video.width, measured.video.height), (854, 480));
                assert_eq!(
                    measured.audio.as_ref().unwrap().channels,
                    original.audio.as_ref().unwrap().channels
                );
                assert_eq!(measured.audio.as_ref().unwrap().sample_rate, 48000);
                verify_output_report(&measured, &measured).unwrap();
            } else {
                assert_eq!(
                    measured.unwrap_err().to_string(),
                    "compute_video_frame_configuration_changed"
                );
            }
        }
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
    #[test]
    fn recipe_allowlist_dimensions_bitrate_and_commands_are_fixed() {
        assert_eq!(COMPUTE_RECIPES.len(), 5);
        assert!(compute_recipe("h264_4k_hls_v1").is_err());
        assert!(compute_recipe("h264_2160p_hls_v1 -i https://example.org").is_err());
        for definition in COMPUTE_RECIPES {
            let command = encode_command(
                "ffmpeg",
                Path::new("source.mp4"),
                Path::new("output"),
                3,
                Some(7),
                definition.id,
            )
            .unwrap();
            let args: Vec<_> = command
                .as_std()
                .get_args()
                .map(|s| s.to_str().unwrap())
                .collect();
            assert!(args.windows(2).any(|w| w == ["-map", "0:3"]));
            assert!(args.windows(2).any(|w| w == ["-map", "0:7"]));
            assert!(args.windows(2).any(|w| w == ["-threads", "1"]));
            if let Some(h264) = definition.transcode {
                assert!(h264.video_kbps <= h264.max_video_kbps);
                assert!(args.windows(2).any(|w| w == ["-vf", h264.video_filter]));
                assert!(
                    definition.estimated_output_bytes(10.0, true).unwrap()
                        > definition.estimated_output_bytes(10.0, false).unwrap()
                );
                if definition.segment_seconds == 2 {
                    assert!(
                        definition.estimated_output_bytes(2.05, true).unwrap() < MAX_SEGMENT_BYTES
                    );
                    assert!(
                        args.windows(2)
                            .any(|w| w == ["-force_key_frames", "expr:gte(t,n_forced*2)"])
                    );
                }
            } else {
                assert!(definition.estimated_output_bytes(10.0, true).is_none());
                assert!(args.windows(2).any(|w| w == ["-c", "copy"]));
            }
            for duration in [f64::NAN, f64::INFINITY, 0.0, -1.0, 1800.1] {
                assert!(definition.estimated_output_bytes(duration, true).is_none());
            }
            assert!(
                validate_segment_size(definition.id, MAX_SEGMENT_BYTES + 1, 2.0, true).is_err()
            );
        }
        assert!(validate_segment_size("h264_720p_hls_v1", 7 * 1024 * 1024, 2.0, true).is_err());
    }
    #[test]
    fn uhd_profile_is_recipe_specific_and_remux_does_not_expand() {
        let mut output = json!({"streams":[{"index":0,"codec_type":"video","codec_name":"h264","profile":"High","level":51,"pix_fmt":"yuv420p","width":3840,"height":2160,"r_frame_rate":"25/1","avg_frame_rate":"25/1","disposition":{"attached_pic":0}}]});
        output_selection_for_recipe(&output, false, "h264_2160p_hls_v1").unwrap();
        for recipe in [
            "remux_hls_v1",
            "h264_480p_hls_v1",
            "h264_720p_hls_v1",
            "h264_1080p_hls_v1",
        ] {
            assert!(output_selection_for_recipe(&output, false, recipe).is_err());
        }
        assert!(output_selection(&output, false).is_err());
        output["streams"][0]["level"] = json!(53);
        assert!(output_selection_for_recipe(&output, false, "h264_2160p_hls_v1").is_err());
        output["streams"][0]["level"] = json!(52);
        output["streams"][0]["width"] = json!(4096);
        assert!(output_selection_for_recipe(&output, false, "h264_2160p_hls_v1").is_err());
    }
    #[test]
    fn all_transcodes_reject_upscaling_odd_pixels_aspect_changes_and_oversize() {
        let source = measured_media_facts(&meta(), b"media_type=video|stream_index=4|key_frame=1|pts_time=0|best_effort_timestamp_time=0|pkt_duration_time=1|width=640|height=480|pix_fmt=yuv420p|sample_aspect_ratio=1:1\n", 4, None).unwrap();
        for recipe in COMPUTE_RECIPES.iter().filter(|r| r.transcode.is_some()) {
            validate_output_relationship(&source, &source, recipe.id).unwrap();
            for (width, height) in [
                (1280, 960),
                (641, 480),
                (640, 479),
                (638, 400),
                (7680, 4320),
            ] {
                let mut invalid = source.clone();
                invalid.video.width = width;
                invalid.video.height = height;
                assert!(
                    validate_output_relationship(&source, &invalid, recipe.id).is_err(),
                    "{} accepted {width}x{height}",
                    recipe.id
                );
            }
        }
        let mut uhd = source.clone();
        uhd.video.width = 3840;
        uhd.video.height = 2160;
        assert!(validate_output_relationship(&uhd, &uhd, "remux_hls_v1").is_err());
    }
    #[test]
    fn hd_playlist_supports_thirty_minutes_of_two_second_segments() {
        let mut names = BTreeSet::from(["index.m3u8".into()]);
        let mut playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n".to_string();
        for index in 0..900 {
            let name = format!("segment{index:05}.ts");
            playlist.push_str(&format!("#EXTINF:2.000000,\n{name}\n"));
            names.insert(name);
        }
        playlist.push_str("#EXT-X-ENDLIST\n");
        assert_eq!(
            generated_segments_for_recipe(playlist.as_bytes(), &names, "h264_2160p_hls_v1")
                .unwrap()
                .len(),
            900
        );
        assert!(generated_segments(playlist.as_bytes(), &names).is_err());
    }
    #[tokio::test]
    #[ignore = "requires installed official FFmpeg and FFprobe"]
    async fn actual_hd_recipes_produce_qualified_bounded_hls_without_upscaling() {
        let ffmpeg = std::env::var("FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
        let ffprobe = std::env::var("FFPROBE").unwrap_or_else(|_| "ffprobe".into());
        let root =
            std::env::temp_dir().join(format!("rainsync-qualified-hd-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        async fn capture(command: Command, limit: usize) -> Vec<u8> {
            let (status, bytes) =
                crate::child_process::capture(command, Duration::from_secs(120), limit)
                    .await
                    .unwrap();
            assert!(status.success());
            bytes
        }
        for (case, width, height, recipe, with_audio, expected) in [
            ("720p", 1280, 720, "h264_720p_hls_v1", true, (1280, 720)),
            (
                "1080p",
                1920,
                1080,
                "h264_1080p_hls_v1",
                false,
                (1920, 1080),
            ),
            ("2160p", 3840, 2160, "h264_2160p_hls_v1", true, (3840, 2160)),
            (
                "no-upscale",
                640,
                360,
                "h264_2160p_hls_v1",
                false,
                (640, 360),
            ),
            (
                "portrait",
                1080,
                1920,
                "h264_720p_hls_v1",
                false,
                (404, 720),
            ),
        ] {
            let source = root.join(format!("{case}.mp4"));
            let mut fixture = Command::new(&ffmpeg);
            fixture
                .args(["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i"])
                .arg(format!(
                    "testsrc2=size={width}x{height}:rate=25:duration=2.4"
                ));
            if with_audio {
                fixture.args([
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000:duration=2.4",
                ]);
            }
            fixture
                .args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-threads",
                    "1",
                    "-filter_threads",
                    "1",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                ])
                .arg(&source);
            capture(fixture, 4096).await;
            let meta: Value = serde_json::from_slice(
                &capture(
                    metadata_command(&ffprobe, &source, false),
                    MAX_METADATA_BYTES,
                )
                .await,
            )
            .unwrap();
            let frames = capture(frames_command(&ffprobe, &source, false), MAX_FRAME_BYTES).await;
            let audio_index = with_audio.then_some(1);
            let original = qualify_source(&meta, &frames, 0, audio_index, recipe).unwrap();
            if case == "2160p" {
                assert!(validate_source_probe(&meta, 0, audio_index, "remux_hls_v1").is_err());
            }
            let output = root.join(case);
            tokio::fs::create_dir_all(&output).await.unwrap();
            capture(
                encode_command(&ffmpeg, &source, &output, 0, audio_index, recipe).unwrap(),
                4096,
            )
            .await;
            let measured = check_output(
                &ffmpeg,
                &ffprobe,
                &output.join("index.m3u8"),
                &original,
                recipe,
            )
            .await
            .unwrap();
            assert_eq!(
                (measured.video.width, measured.video.height),
                expected,
                "{case}"
            );
            assert_eq!(measured.audio.is_some(), with_audio);
            assert!(
                output.join("segment00001.ts").exists(),
                "{case} requires a two-second keyframe boundary"
            );
            let bytes = tokio::fs::metadata(output.join("segment00000.ts"))
                .await
                .unwrap()
                .len();
            assert!(bytes < MAX_SEGMENT_BYTES);
            eprintln!(
                "{recipe}: {}x{}, selected_audio={with_audio}, first_segment_bytes={bytes}, full_decode=passed",
                measured.video.width, measured.video.height
            );
        }
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
