use super::{MAX_DURATION_MS, RECIPE_VERSION, Resource};
use crate::advanced_media::{Input, Inventory};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Component, Path},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenditionId {
    Low,
    Medium,
    High,
}
impl RenditionId {
    pub const ALL: [Self; 3] = [Self::Low, Self::Medium, Self::High];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            _ => anyhow::bail!("hls_ladder_rendition_invalid"),
        }
    }
}

/// A sealed recipe configuration. No user-provided bitrate/filter/path strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Rendition {
    pub id: RenditionId,
    pub width: u32,
    pub height: u32,
    pub video_bitrate: u32,
    pub video_maxrate: u32,
    pub bandwidth: u32,
    pub average_bandwidth: u32,
    pub avc_codec: &'static str,
    pub audio_bitrate: Option<u32>,
}
impl Rendition {
    pub fn codecs(&self) -> String {
        format!(
            "{}{}",
            self.avc_codec,
            if self.audio_bitrate.is_some() {
                ",mp4a.40.2"
            } else {
                ""
            }
        )
    }
}

// Keep admission and the finite MP4 colr grammar consistent. Scaling does not
// convert primaries/transfer/matrix, so do not advertise an unsupported family
// or force BT.709 labels onto its pixels. Missing/unspecified metadata remains
// unspecified; only explicit BT.709 and ISO color code 2 are supported in v1.
fn validate_color_subset(stream: &Value, reason: &str) -> Result<()> {
    ensure!(
        ["color_primaries", "color_transfer", "color_space"]
            .iter()
            .all(|name| match stream.get(*name) {
                None | Some(Value::Null) => true,
                Some(Value::String(value)) =>
                    matches!(value.as_str(), "bt709" | "unknown" | "unspecified"),
                _ => false,
            }),
        "{reason}"
    );
    Ok(())
}

/// V1 excludes HDR, non-BT.709 explicit color families, burn-in, rotation, VFR
/// and non-square source pixels; those
/// remain supported by the independent advanced single-rendition recipe. This
/// version always uses software libx264, not speculative multi-session GPUs.
#[derive(Debug, Clone)]
pub struct LadderRecipe {
    video: u32,
    audio: Option<u32>,
    start_seconds: f64,
    source_sha256: String,
    recipe_sha256: String,
    renditions: Vec<Rendition>,
    advanced: Option<crate::advanced_media::Recipe>,
}
impl LadderRecipe {
    pub fn from_probe(
        meta: &Value,
        requested_audio: Option<u32>,
        start_seconds: f64,
    ) -> Result<Self> {
        ensure!(
            start_seconds.is_finite()
                && start_seconds >= 0.0
                && start_seconds <= MAX_DURATION_MS as f64 / 1000.0,
            "invalid_position"
        );
        let streams = crate::capabilities::validate_protected_tracks(meta)?;
        ensure!(
            !streams.is_empty() && streams.len() <= 256,
            "hls_ladder_stream_limit"
        );
        let mut indices = BTreeSet::new();
        for stream in streams {
            let index = stream["index"]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .ok_or_else(|| anyhow::anyhow!("hls_ladder_stream_index_required"))?;
            ensure!(
                indices.insert(index)
                    && matches!(
                        stream["codec_type"].as_str(),
                        Some("video" | "audio" | "subtitle" | "attachment" | "data")
                    ),
                "hls_ladder_stream_catalog_invalid"
            );
        }
        let selected = crate::capabilities::validate_motion_source(meta)?;
        validate_color_subset(selected.stream, "hls_ladder_source_color_unsupported")?;
        ensure!(
            !crate::video_needs_transform(selected.stream)
                && matches!(
                    selected.stream["sample_aspect_ratio"].as_str(),
                    None | Some("1:1" | "N/A")
                ),
            "hls_ladder_source_transform_unsupported"
        );
        let crate::motion_video::VideoMapping::Absolute { index: video } =
            selected.identity.mapping
        else {
            anyhow::bail!("hls_ladder_stream_index_required")
        };
        let dimension = |name: &str| {
            selected.stream[name]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| (2..=16384).contains(v))
                .ok_or_else(|| anyhow::anyhow!("hls_ladder_source_geometry_invalid"))
        };
        let (width, height) = (dimension("width")?, dimension("height")?);
        let audio = crate::motion_video::selected_audio_index(meta, requested_audio)?;
        let mut renditions = Vec::new();
        let mut seen = BTreeSet::new();
        for (id, box_width, box_height, video_bitrate, video_maxrate, avc_codec) in [
            (
                RenditionId::Low,
                640,
                360,
                800_000,
                1_000_000,
                "avc1.64001F",
            ),
            (
                RenditionId::Medium,
                1280,
                720,
                2_500_000,
                3_000_000,
                "avc1.64001F",
            ),
            (
                RenditionId::High,
                1920,
                1080,
                5_000_000,
                6_000_000,
                "avc1.640028",
            ),
        ] {
            // Integer fit and floor-to-even prevents both upscaling and ratio
            // overflow. Deduping small-source tiers avoids fake ABR choices.
            let numerator = u64::from(box_width.min(width)) * u64::from(height);
            let denominator = u64::from(box_height.min(height)) * u64::from(width);
            let (w, h) = if numerator <= denominator {
                let w = box_width.min(width) / 2 * 2;
                (
                    w,
                    (u64::from(w) * u64::from(height) / u64::from(width)) as u32 / 2 * 2,
                )
            } else {
                let h = box_height.min(height) / 2 * 2;
                (
                    (u64::from(h) * u64::from(width) / u64::from(height)) as u32 / 2 * 2,
                    h,
                )
            };
            ensure!(
                w >= 2 && h >= 2 && w <= width && h <= height,
                "hls_ladder_source_geometry_unsupported"
            );
            if !seen.insert((w, h)) {
                continue;
            }
            let audio_bitrate = audio.map(|_| 128_000);
            let average_bandwidth = video_bitrate + audio_bitrate.unwrap_or(0);
            // Conservative admission/advertising envelope. Every immutable
            // segment must still be checked against it before being served.
            let bandwidth = (video_maxrate + audio_bitrate.unwrap_or(0)) * 5 / 4;
            renditions.push(Rendition {
                id,
                width: w,
                height: h,
                video_bitrate,
                video_maxrate,
                bandwidth,
                average_bandwidth,
                avc_codec,
                audio_bitrate,
            });
        }
        Ok(Self {
            video,
            audio,
            start_seconds,
            recipe_sha256: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(
                    &serde_json::json!({"version": RECIPE_VERSION, "source": meta, "video":video, "audio":audio, "start_seconds":start_seconds})
                )?)
            ),
            source_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(meta)?)),
            renditions,
            advanced: None,
        })
    }
    /// Compose only the closed, source-validated software advanced recipe.
    /// Geometry is derived from the real source; normalized header facts here
    /// describe the intermediate pixels, never the original source codec.
    pub fn from_advanced_probe(
        meta: &Value,
        audio: Option<u32>,
        start_seconds: f64,
        request: &crate::advanced_media::Request,
    ) -> Result<Self> {
        let advanced = crate::advanced_media::Recipe::from_probe(
            meta,
            audio,
            start_seconds,
            request,
            crate::advanced_media::EncoderSelection::software_recipe(),
        )?;
        let selected = crate::motion_video::select(meta)?;
        ensure!(
            !crate::video_needs_transform(selected.stream)
                && matches!(
                    selected.stream["sample_aspect_ratio"].as_str(),
                    None | Some("1:1" | "N/A")
                ),
            "hls_ladder_source_transform_unsupported"
        );
        if !advanced.tone_mapped() {
            validate_color_subset(selected.stream, "hls_ladder_source_color_unsupported")?;
        }
        let mut normalized = meta.clone();
        let index = selected.stream["index"].as_u64().unwrap();
        for stream in normalized["streams"].as_array_mut().unwrap() {
            if stream["index"].as_u64() == Some(index) {
                stream["pix_fmt"] = serde_json::json!("yuv420p");
                stream["bits_per_raw_sample"] = serde_json::json!("8");
                if advanced.tone_mapped() {
                    stream["color_transfer"] = serde_json::json!("bt709");
                    stream["color_primaries"] = serde_json::json!("bt709");
                    stream["color_space"] = serde_json::json!("bt709");
                    stream["color_range"] = serde_json::json!("tv");
                }
                if let Some(o) = stream.as_object_mut() {
                    o.remove("side_data_list");
                }
            }
        }
        let mut recipe = Self::from_probe(&normalized, audio, start_seconds)?;
        recipe.source_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(meta)?));
        recipe.recipe_sha256 = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(
                &serde_json::json!({"version":RECIPE_VERSION,"source":meta,"audio":audio,
                "start_seconds":start_seconds,"advanced_media":request})
            )?)
        );
        recipe.advanced = Some(advanced);
        Ok(recipe)
    }
    pub fn tone_mapped(&self) -> bool {
        self.advanced
            .as_ref()
            .is_some_and(|recipe| recipe.tone_mapped())
    }
    pub fn recipe_version(&self) -> u8 {
        RECIPE_VERSION
    }
    pub fn source_sha256(&self) -> &str {
        &self.source_sha256
    }
    pub fn recipe_sha256(&self) -> &str {
        &self.recipe_sha256
    }
    pub fn renditions(&self) -> &[Rendition] {
        &self.renditions
    }
    pub fn rendition(&self, id: RenditionId) -> Result<&Rendition> {
        self.renditions
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| anyhow::anyhow!("hls_ladder_rendition_not_planned"))
    }
    /// Each rung must be independently reported as browser supported; a low
    /// rung report never establishes support for the high rung's AVC level.
    pub fn candidates(&self) -> Vec<protocol::PlaybackCandidate> {
        self.renditions
            .iter()
            .map(|r| protocol::PlaybackCandidate {
                id: format!("hls_ladder_{}", r.id.as_str()),
                delivery_mode: "transcode".into(),
                transport: "hls".into(),
                content_type: format!("video/mp4; codecs=\"{}\"", r.codecs().replace(',', ", ")),
                video: protocol::VideoCapabilityConfiguration {
                    content_type: format!("video/mp4; codecs=\"{}\"", r.avc_codec),
                    width: r.width,
                    height: r.height,
                    bitrate: r.video_maxrate,
                    framerate: 30.0,
                    dolby_vision: None,
                },
                audio: r
                    .audio_bitrate
                    .map(|bitrate| protocol::AudioCapabilityConfiguration {
                        content_type: "audio/mp4; codecs=\"mp4a.40.2\"".into(),
                        channels: "2".into(),
                        bitrate,
                        samplerate: 48_000,
                    }),
            })
            .collect()
    }
    pub fn has_audio(&self) -> bool {
        self.audio.is_some()
    }
    pub fn start_seconds(&self) -> f64 {
        self.start_seconds
    }
    /// Aggregate disk reservation for all outputs, including duplicated audio,
    /// init/playlist overhead and 25% envelope. Never a usage-enforcement proof.
    pub fn estimated_output_bytes(&self, duration_ms: Option<f64>) -> Option<u64> {
        let duration = duration_ms.filter(|v| {
            v.is_finite() && *v > self.start_seconds * 1000.0 && *v <= MAX_DURATION_MS as f64
        })?;
        let total_rate: u64 = self.renditions.iter().map(|r| u64::from(r.bandwidth)).sum();
        let bytes = ((duration / 1000.0 - self.start_seconds) * total_rate as f64 / 8.0).ceil();
        (bytes <= u64::MAX as f64).then(|| bytes as u64 + self.renditions.len() as u64 * 65536)
    }
    /// One bounded process, explicit per-output options and directories. No
    /// var_stream_map, user master or arbitrary FFmpeg filter is accepted.
    pub fn ffmpeg_args(
        &self,
        input: Input<'_>,
        attempt_directory: &Path,
        inventory: &Inventory,
        rewritten_hls: bool,
    ) -> Result<Vec<String>> {
        self.ffmpeg_args_with_assets(input, attempt_directory, inventory, rewritten_hls, None)
    }
    pub fn requires_external_fonts(&self) -> bool {
        self.advanced
            .as_ref()
            .is_some_and(|r| r.requires_external_fonts())
    }
    pub fn external_subtitle_index(&self) -> Option<u32> {
        self.advanced.as_ref()?.external_subtitle().map(|a| a.index)
    }
    pub fn ffmpeg_args_with_assets(
        &self,
        input: Input<'_>,
        attempt_directory: &Path,
        inventory: &Inventory,
        rewritten_hls: bool,
        assets: Option<&crate::advanced_media::OwnedAssets>,
    ) -> Result<Vec<String>> {
        ensure!(
            inventory.encoder("libx264")
                && (!self.has_audio() || inventory.encoder("aac"))
                && ["scale", "setsar"]
                    .iter()
                    .all(|name| inventory.filter(name)),
            "hls_ladder_software_unavailable"
        );
        ensure!(
            attempt_directory.is_absolute()
                && attempt_directory
                    .components()
                    .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
                && attempt_directory
                    .to_str()
                    .is_some_and(|s| !s.contains(['\0', '\n', '\r'])),
            "hls_ladder_output_directory_invalid"
        );
        let mut audio_mapping = self.audio.map(|index| format!("0:{index}"));
        let mut video_mappings = Vec::new();
        let mut args = if let Some(advanced) = &self.advanced {
            let original = advanced.ffmpeg_args_with_assets(
                input,
                &attempt_directory.join("index.m3u8"),
                inventory,
                rewritten_hls,
                assets,
            )?;
            let end = original
                .iter()
                .position(|v| v == "-map")
                .ok_or_else(|| anyhow::anyhow!("hls_ladder_advanced_graph_missing"))?;
            let mut prefix = original[..end].to_vec();
            let graph_at = prefix
                .iter()
                .position(|v| v == "-filter_complex")
                .ok_or_else(|| anyhow::anyhow!("hls_ladder_advanced_graph_missing"))?
                + 1;
            let graph = &prefix[graph_at];
            let tail = format!(",{}[rsv]", crate::capabilities::OUTPUT_VIDEO_FILTER);
            ensure!(
                graph.matches(&tail).count() == 1,
                "hls_ladder_advanced_graph_changed"
            );
            let mut graph = graph.replacen(&tail, "[rslbase]", 1);
            let names = self
                .renditions
                .iter()
                .map(|r| format!("[rsv_{}]", r.id.as_str()))
                .collect::<Vec<_>>();
            graph.push_str(&format!(
                ";[rslbase]split={}{}",
                names.len(),
                self.renditions
                    .iter()
                    .map(|r| format!("[rsraw_{}]", r.id.as_str()))
                    .collect::<String>()
            ));
            for r in &self.renditions {
                graph.push_str(&format!(
                    ";[rsraw_{}]scale={}:{}:flags=bicubic,setsar=1,format=yuv420p[rsv_{}]",
                    r.id.as_str(),
                    r.width,
                    r.height,
                    r.id.as_str()
                ));
            }
            if graph.contains("[rsa]") {
                graph.push_str(&format!(
                    ";[rsa]asplit={}{}",
                    self.renditions.len(),
                    self.renditions
                        .iter()
                        .map(|r| format!("[rsa_{}]", r.id.as_str()))
                        .collect::<String>()
                ));
                audio_mapping = Some("[rsa]".into());
            }
            prefix[graph_at] = graph;
            prefix.extend([
                "-threads".into(),
                "2".into(),
                "-filter_complex_threads".into(),
                "2".into(),
            ]);
            video_mappings = names;
            prefix
        } else {
            let mut prefix = vec![
                "-hide_banner".into(),
                "-nostdin".into(),
                "-y".into(),
                "-threads".into(),
                "2".into(),
                "-filter_threads".into(),
                "2".into(),
            ];
            if self.start_seconds > 0.0 {
                prefix.extend(["-ss".into(), self.start_seconds.to_string()]);
            }
            prefix.extend(crate::input_policy::args(input.network(), rewritten_hls));
            prefix.extend(["-i".into(), input.path()?]);
            prefix
        };
        for (position, r) in self.renditions.iter().enumerate() {
            args.extend([
                "-map".into(),
                video_mappings
                    .get(position)
                    .cloned()
                    .unwrap_or_else(|| format!("0:{}", self.video)),
            ]);
            if let Some(audio) = &audio_mapping {
                args.extend([
                    "-map".into(),
                    if audio == "[rsa]" {
                        format!("[rsa_{}]", r.id.as_str())
                    } else {
                        audio.clone()
                    },
                ]);
            } else {
                args.push("-an".into());
            }
            args.extend(
                [
                    "-c:v",
                    "libx264",
                    "-threads",
                    "2",
                    "-pix_fmt",
                    "yuv420p",
                    "-preset",
                    "veryfast",
                    "-profile:v",
                    "high",
                    "-level:v",
                    if r.id == RenditionId::High {
                        "4.0"
                    } else {
                        "3.1"
                    },
                    "-tag:v",
                    "avc1",
                    "-bf",
                    "0",
                    "-g",
                    "120",
                    "-keyint_min",
                    "120",
                    "-sc_threshold",
                    "0",
                    "-flags",
                    "+cgop",
                    "-x264-params",
                    "open-gop=0",
                    "-r",
                    "30",
                    "-fps_mode",
                    "cfr",
                    "-forced-idr",
                    "1",
                    "-force_key_frames",
                    "expr:gte(t,n_forced*4)",
                ]
                .into_iter()
                .map(str::to_owned),
            );
            args.extend([
                "-b:v".into(),
                r.video_bitrate.to_string(),
                "-maxrate".into(),
                r.video_maxrate.to_string(),
                "-bufsize".into(),
                (r.video_maxrate * 2).to_string(),
            ]);
            if self.advanced.is_none() {
                args.extend([
                    "-vf".into(),
                    format!("scale={}:{}:flags=bicubic,setsar=1", r.width, r.height),
                ]);
            }
            if self.tone_mapped() {
                args.extend(
                    [
                        "-color_primaries",
                        "bt709",
                        "-color_trc",
                        "bt709",
                        "-colorspace",
                        "bt709",
                        "-color_range",
                        "tv",
                    ]
                    .map(String::from),
                );
            }
            if self.has_audio() {
                args.extend(
                    [
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
                    .into_iter()
                    .map(str::to_owned),
                );
            }
            args.extend(
                [
                    "-sn",
                    "-dn",
                    "-map_metadata",
                    "-1",
                    "-map_chapters",
                    "-1",
                    "-avoid_negative_ts",
                    "disabled",
                    "-f",
                    "hls",
                    "-hls_time",
                    "4",
                    "-hls_segment_type",
                    "fmp4",
                    "-hls_fmp4_init_filename",
                    "init.mp4",
                    "-hls_playlist_type",
                    "event",
                    "-hls_flags",
                    "temp_file+independent_segments",
                    "-start_number",
                    "0",
                    "-hls_segment_filename",
                ]
                .into_iter()
                .map(str::to_owned),
            );
            let dir = attempt_directory.join(r.id.as_str());
            args.push(dir.join("index%d.m4s").to_str().unwrap().into());
            args.push(
                attempt_directory
                    .join(Resource::Playlist(r.id).path())
                    .to_str()
                    .unwrap()
                    .into(),
            );
        }
        Ok(args)
    }
    pub fn validate_output_probe(&self, id: RenditionId, meta: &Value) -> Result<()> {
        let r = self.rendition(id)?;
        let streams = crate::capabilities::validate_protected_tracks(meta)?;
        ensure!(
            streams.len() == 1 + usize::from(self.has_audio()),
            "hls_ladder_output_track_set"
        );
        let video: Vec<_> = streams
            .iter()
            .filter(|s| s["codec_type"] == "video")
            .collect();
        ensure!(video.len() == 1, "hls_ladder_output_track_set");
        let video = video[0];
        ensure!(
            crate::capabilities::avc_codec(video).as_deref() == Some(r.avc_codec)
                && video["codec_tag_string"] == "avc1"
                && video["width"] == r.width
                && video["height"] == r.height
                && video["pix_fmt"] == "yuv420p"
                && video["sample_aspect_ratio"] == "1:1"
                && video["has_b_frames"] == 0
                && matches!(video["r_frame_rate"].as_str(), Some("30/1" | "60/2")),
            "hls_ladder_output_video_mismatch"
        );
        crate::capabilities::validate_motion_source(meta)?;
        validate_color_subset(video, "hls_ladder_output_color_unsupported")?;
        if self.tone_mapped() {
            ensure!(
                video["color_primaries"] == "bt709"
                    && video["color_transfer"] == "bt709"
                    && video["color_space"] == "bt709"
                    && video["color_range"] == "tv",
                "hls_ladder_tonemap_output_mismatch"
            );
        }
        if self.has_audio() {
            let audio: Vec<_> = streams
                .iter()
                .filter(|s| s["codec_type"] == "audio")
                .collect();
            ensure!(
                audio.len() == 1
                    && audio[0]["codec_name"] == "aac"
                    && audio[0]["profile"] == "LC"
                    && audio[0]["channels"] == 2
                    && audio[0]["sample_rate"] == "48000",
                "hls_ladder_output_audio_mismatch"
            );
        }
        Ok(())
    }
}

/// Pure candidate analysis for the separate versioned ladder intent.
pub fn analyze(
    meta: &Value,
    audio: Option<u32>,
    position_ms: f64,
) -> Result<crate::capabilities::CandidateAnalysis> {
    ensure!(
        position_ms.is_finite() && position_ms >= 0.0,
        "invalid_position"
    );
    let recipe = LadderRecipe::from_probe(meta, audio, position_ms / 1000.0)?;
    let candidates = recipe.candidates();
    let route_decisions = candidates
        .iter()
        .map(|candidate| protocol::PlaybackRouteDecision {
            candidate_id: candidate.id.clone(),
            offered: true,
            reason: protocol::PlaybackRouteReason::ConstrainedEncoderRecipe,
        })
        .collect();
    Ok(crate::capabilities::CandidateAnalysis {
        candidates,
        route_decisions,
    })
}
