use super::{
    EncoderSelection, HdrSource, Input, Inventory, Request, SubtitleKind, SubtitleSelection,
};
use anyhow::{Result, ensure};
use protocol::{
    AudioCapabilityConfiguration, PlaybackCandidate, PlaybackRouteDecision, PlaybackRouteReason,
    VideoCapabilityConfiguration,
};
use serde_json::Value;
use std::{collections::BTreeSet, path::Path};

pub(super) fn indexed_streams(meta: &Value) -> Result<Vec<(u32, &Value)>> {
    let streams = crate::capabilities::validate_protected_tracks(meta)?;
    ensure!(streams.len() <= 256, "advanced_media_stream_limit");
    let mut seen = BTreeSet::new();
    let mut rows = Vec::new();
    for row in streams {
        let index = row["index"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(|| anyhow::anyhow!("advanced_media_stream_index_required"))?;
        ensure!(seen.insert(index), "advanced_media_duplicate_stream_index");
        ensure!(
            matches!(
                row["codec_type"].as_str(),
                Some("video" | "audio" | "subtitle" | "attachment" | "data")
            ),
            "advanced_media_stream_type_unsupported"
        );
        rows.push((index, row));
    }
    rows.sort_unstable_by_key(|(index, _)| *index);
    Ok(rows)
}

/// Source-bound recipe facts. The constructor revalidates the actual probe;
/// callers cannot supply arbitrary mapping/filter/device strings.
#[derive(Debug, Clone)]
pub struct Recipe {
    video: u32,
    audio: Option<u32>,
    hdr: Option<HdrSource>,
    subtitle: Option<SubtitleSelection>,
    width: u32,
    height: u32,
    subtitle_origin_seconds: f64,
    start_seconds: f64,
    encoder: EncoderSelection,
    source_proof: Option<super::VideoSourceProof>,
    external_subtitle: Option<super::SubtitleAsset>,
    external_fonts: bool,
}
impl Recipe {
    pub fn from_probe(
        meta: &Value,
        audio: Option<u32>,
        start_seconds: f64,
        request: &Request,
        encoder: EncoderSelection,
    ) -> Result<Self> {
        request.validate()?;
        ensure!(
            start_seconds.is_finite() && (0.0..=9_007_199_254_740.0).contains(&start_seconds),
            "invalid_position"
        );
        indexed_streams(meta)?;
        let selected = crate::motion_video::select(meta)?;
        let crate::motion_video::VideoMapping::Absolute { index: video } =
            selected.identity.mapping
        else {
            anyhow::bail!("advanced_media_stream_index_required")
        };
        let source_proof = super::extended_source_proof(selected.stream)?;
        let hdr = super::classify_hdr(selected.stream)?;
        // The Vulkan color transform and hardware encoder use separate device
        // contexts. Until that interop is qualified, Dolby uses the constrained
        // software H.264 recipe instead of uploading its output to the wrong GPU.
        let encoder = if hdr.is_some_and(HdrSource::is_dolby_vision) {
            EncoderSelection::software_recipe()
        } else {
            encoder
        };
        if hdr.is_some() {
            ensure!(request.tone_map_hdr, "hdr_tonemap_required");
        } else {
            ensure!(!request.tone_map_hdr, "hdr_tonemap_source_required");
            if source_proof.is_none() {
                crate::capabilities::validate_motion_source(meta)?;
            }
        }
        let audio = crate::motion_video::selected_audio_index(meta, audio)?;
        let width = selected.stream["width"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| (1..=16384).contains(n))
            .ok_or_else(|| anyhow::anyhow!("advanced_media_geometry_invalid"))?;
        let height = selected.stream["height"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| (1..=16384).contains(n))
            .ok_or_else(|| anyhow::anyhow!("advanced_media_geometry_invalid"))?;
        let external_subtitle = if let Some(
            index @ (super::EXTERNAL_ASS_INDEX
            | super::EXTERNAL_SSA_INDEX
            | super::EXTERNAL_PGS_INDEX),
        ) = request.subtitle_stream_index
        {
            let catalog: super::AssetCatalog =
                serde_json::from_value(meta["advanced_assets"].clone())?;
            catalog.validate(&catalog.source_resource, &catalog.source_version)?;
            Some(catalog.selected(index)?.clone())
        } else {
            None
        };
        let subtitle = if let Some(asset) = &external_subtitle {
            Some(SubtitleSelection {
                index: asset.index,
                ordinal: 0,
                kind: asset.kind,
            })
        } else {
            request
                .subtitle_stream_index
                .map(|index| super::select_subtitle(meta, index))
                .transpose()?
        };
        let external_fonts = if external_subtitle.is_none()
            && subtitle.is_some_and(|s| matches!(s.kind, SubtitleKind::Ass | SubtitleKind::Ssa))
        {
            if let Some(value) = meta.get("advanced_assets") {
                let catalog: super::AssetCatalog = serde_json::from_value(value.clone())?;
                catalog.validate(&catalog.source_resource, &catalog.source_version)?;
                !catalog.fonts.is_empty()
            } else {
                false
            }
        } else {
            false
        };
        let subtitle_origin_seconds = if subtitle.is_some() {
            let origin = meta["format"]["start_time"]
                .as_f64()
                .or_else(|| meta["format"]["start_time"].as_str()?.parse().ok())
                .ok_or_else(|| anyhow::anyhow!("subtitle_source_origin_unavailable"))?;
            ensure!(
                origin.is_finite()
                    && origin >= 0.0
                    && origin + start_seconds <= 9_007_199_254_740.0,
                "subtitle_source_origin_invalid"
            );
            // Bitmap canvas coordinates must not undergo implicit input
            // autorotation before overlaying source-coordinate subtitle pixels.
            if subtitle.is_some_and(|s| s.kind == SubtitleKind::Pgs) {
                ensure!(
                    !crate::video_needs_transform(selected.stream),
                    "pgs_source_transform_unsupported"
                );
            }
            origin
        } else {
            0.0
        };
        Ok(Self {
            video,
            audio,
            hdr,
            subtitle,
            width,
            height,
            subtitle_origin_seconds,
            start_seconds,
            encoder,
            source_proof,
            external_subtitle,
            external_fonts,
        })
    }
    pub fn encoder(&self) -> &EncoderSelection {
        &self.encoder
    }
    pub fn source_proof(&self) -> Option<&super::VideoSourceProof> {
        self.source_proof.as_ref()
    }
    pub fn requires_external_fonts(&self) -> bool {
        self.external_fonts
    }
    pub fn external_subtitle(&self) -> Option<&super::SubtitleAsset> {
        self.external_subtitle.as_ref()
    }
    pub fn tone_mapped(&self) -> bool {
        self.hdr.is_some()
    }
    pub fn has_audio(&self) -> bool {
        self.audio.is_some()
    }
    pub fn subtitle(&self) -> Option<SubtitleSelection> {
        self.subtitle
    }
    pub fn ffmpeg_args(
        &self,
        input: Input<'_>,
        output: &Path,
        inventory: &Inventory,
        rewritten_hls: bool,
    ) -> Result<Vec<String>> {
        self.ffmpeg_args_with_assets(input, output, inventory, rewritten_hls, None)
    }
    pub fn ffmpeg_args_with_assets(
        &self,
        input: Input<'_>,
        output: &Path,
        inventory: &Inventory,
        rewritten_hls: bool,
        assets: Option<&super::OwnedAssets>,
    ) -> Result<Vec<String>> {
        ensure!(
            (self.external_subtitle.is_some() || self.external_fonts) == assets.is_some(),
            "advanced_asset_custody_required"
        );
        if let Some(assets) = assets {
            ensure!(
                assets.fonts_only() == self.external_fonts,
                "advanced_asset_custody_required"
            );
            assets.verify()?;
        }
        if let Some(source) = self.source_proof() {
            let available = if source.codec == "av1" {
                ["av1", "libdav1d", "libaom_av1"]
                    .iter()
                    .any(|name| inventory.decoder(name))
            } else {
                inventory.decoder(source.decoder())
            };
            ensure!(available, "advanced_media_source_decoder_unavailable");
        }
        inventory.require_filters(&["null", "scale", "setsar", "pad", "format"])?;
        ensure!(
            inventory.encoder(self.encoder.backend().encoder())
                && (self.audio.is_none() || inventory.encoder("aac")),
            "advanced_media_encoder_unavailable"
        );
        if let Some(hdr) = self.hdr {
            if hdr.is_dolby_vision() {
                inventory.require_filters(&["hwupload", "libplacebo", "hwdownload", "sidedata"])?;
            } else {
                inventory.require_filters(&["zscale", "tonemap", "sidedata"])?;
            }
        }
        let output = output
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("advanced_media_output_path_invalid"))?;
        ensure!(
            output.ends_with("/index.m3u8")
                && !output.contains(['\0', '\n', '\r'])
                && !Path::new(output)
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir)),
            "advanced_media_output_path_invalid"
        );
        let path = input.path()?;
        let mut args = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];
        args.extend(self.encoder.initial_args()?);
        if self.hdr.is_some_and(HdrSource::is_dolby_vision) {
            args.extend([
                "-init_hw_device".into(),
                "vulkan=rainsync_dovi".into(),
                "-filter_hw_device".into(),
                "rainsync_dovi".into(),
            ]);
        }
        if self.subtitle.is_some() {
            inventory.require_filters(&["trim", "setpts"])?;
            args.push("-copyts".into());
            if self.external_subtitle.is_none()
                && self.subtitle.is_some_and(|s| s.kind == SubtitleKind::Pgs)
            {
                args.extend([
                    "-canvas_size".into(),
                    format!("{}x{}", self.width, self.height),
                ]);
            }
        } else if self.start_seconds > 0.0 {
            args.extend(["-ss".into(), self.start_seconds.to_string()]);
        }
        args.extend(crate::input_policy::args(input.network(), rewritten_hls));
        args.extend(["-i".into(), path]);
        let mut filter = self.hdr.map_or_else(|| "null".into(), HdrSource::filter);
        let mut graph = String::new();
        if self.external_subtitle.is_some() {
            filter = format!("setpts=PTS-{}/TB,{filter}", self.subtitle_origin_seconds);
        }
        match self.subtitle {
            Some(s) if matches!(s.kind, SubtitleKind::Ass | SubtitleKind::Ssa) => {
                inventory.require_filters(&[if self.external_subtitle.is_some() {
                    "ass"
                } else {
                    "subtitles"
                }])?;
                ensure!(
                    inventory.decoder(if s.kind == SubtitleKind::Ass {
                        "ass"
                    } else {
                        "ssa"
                    }) || inventory.decoder("ass"),
                    "subtitle_decoder_unavailable"
                );
                let fd_path = if self.external_subtitle.is_some() {
                    assets.unwrap().subtitle.decoder_path()?
                } else {
                    input.subtitle_descriptor()?
                };
                // Both container and attached fonts come from this same owned
                // descriptor; no filename escapes or arbitrary fontsdir.
                if self.external_subtitle.is_some() {
                    let assets = assets.unwrap();
                    filter.push_str(&format!(
                        ",ass=filename='{fd_path}':original_size={}x{}:fontsdir='{}'",
                        self.width,
                        self.height,
                        assets.fonts_directory()?
                    ));
                } else {
                    filter.push_str(&format!(
                        ",subtitles=filename='{fd_path}':si={}:original_size={}x{}",
                        s.ordinal, self.width, self.height
                    ));
                    if self.external_fonts {
                        filter.push_str(&format!(
                            ":fontsdir='{}'",
                            assets.unwrap().fonts_directory()?
                        ));
                    }
                }
            }
            Some(s) => {
                inventory.require_filters(&["overlay"])?;
                ensure!(inventory.decoder("pgssub"), "subtitle_decoder_unavailable");
                let pgs_input = if let Some(assets) = assets {
                    args.extend(
                        [
                            "-protocol_whitelist",
                            "file,pipe",
                            "-format_whitelist",
                            "sup",
                            "-f",
                            "sup",
                            "-canvas_size",
                        ]
                        .map(String::from),
                    );
                    args.extend([
                        format!("{}x{}", self.width, self.height),
                        "-i".into(),
                        assets.subtitle.decoder_path()?,
                    ]);
                    "1:0".into()
                } else {
                    input.subtitle_descriptor()?;
                    format!("0:{}", s.index)
                };
                graph = format!(
                    "[0:{}]{filter}[rsbase];[rsbase][{pgs_input}]overlay=eof_action=pass:shortest=0:repeatlast=0:format=yuv420",
                    self.video
                );
                filter.clear();
            }
            None => {}
        }
        if self.subtitle.is_some() {
            let trim = if self.external_subtitle.is_some() {
                self.start_seconds
            } else {
                self.subtitle_origin_seconds + self.start_seconds
            };
            filter.push_str(&format!(",trim=start={trim},setpts=PTS-{trim}/TB"));
        }
        filter.push(',');
        filter.push_str(crate::capabilities::OUTPUT_VIDEO_FILTER);
        filter.push_str(self.encoder.upload_filter());
        if graph.is_empty() {
            graph = format!("[0:{}]{}[rsv]", self.video, filter);
        } else {
            graph.push_str(&filter);
            graph.push_str("[rsv]");
        }
        if let Some(index) = self.audio
            && self.subtitle.is_some()
        {
            inventory.require_filters(&["atrim", "asetpts"])?;
            graph.push_str(&format!(
                ";[0:{index}]atrim=start={trim},asetpts=PTS-{trim}/TB[rsa]",
                trim = self.subtitle_origin_seconds + self.start_seconds
            ));
        }
        args.extend([
            "-filter_complex".into(),
            graph,
            "-map".into(),
            "[rsv]".into(),
        ]);
        if let Some(index) = self.audio {
            args.extend([
                "-map".into(),
                if self.subtitle.is_some() {
                    "[rsa]".into()
                } else {
                    format!("0:{index}")
                },
            ]);
        } else {
            args.push("-an".into());
        }
        args.extend(self.encoder.output_args());
        args.extend(
            [
                "-tag:v",
                "avc1",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
            ]
            .into_iter()
            .map(String::from),
        );
        if self.hdr.is_some() {
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
                .into_iter()
                .map(String::from),
            );
        }
        if self.audio.is_some() {
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
                .map(String::from),
            );
        }
        args.extend(
            [
                "-sn",
                "-dn",
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
        Ok(args)
    }
    /// Header checks complement the Worker's existing immutable fragment
    /// decoder. They are never themselves proof of pixels, subtitle rendering
    /// correctness or successful hardware execution.
    pub fn validate_output_probe(&self, meta: &Value) -> Result<()> {
        let streams = meta["streams"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("advanced_media_output_streams_invalid"))?;
        let video: Vec<_> = streams
            .iter()
            .filter(|s| s["codec_type"] == "video")
            .collect();
        ensure!(video.len() == 1, "advanced_media_output_video_invalid");
        let video = video[0];
        ensure!(
            crate::capabilities::avc_codec(video).as_deref()
                == Some(crate::capabilities::OUTPUT_AVC)
                && video["codec_tag_string"] == "avc1"
                && video["width"] == 1280
                && video["height"] == 720
                && video["pix_fmt"] == "yuv420p"
                && video["sample_aspect_ratio"] == "1:1",
            "advanced_media_output_video_recipe_mismatch"
        );
        let rate = video["r_frame_rate"]
            .as_str()
            .and_then(|s| s.split_once('/'))
            .and_then(|(a, b)| Some(a.parse::<f64>().ok()? / b.parse::<f64>().ok()?));
        ensure!(rate == Some(30.0), "advanced_media_output_rate_mismatch");
        if self.hdr.is_some() {
            ensure!(
                video["color_transfer"] == "bt709"
                    && video["color_primaries"] == "bt709"
                    && video["color_space"] == "bt709"
                    && video["color_range"] == "tv",
                "advanced_media_output_sdr_mismatch"
            );
        }
        ensure!(
            super::classify_hdr(video)?.is_none(),
            "advanced_media_output_hdr_metadata"
        );
        let audio: Vec<_> = streams
            .iter()
            .filter(|s| s["codec_type"] == "audio")
            .collect();
        ensure!(
            audio.len() == usize::from(self.audio.is_some()),
            "advanced_media_output_audio_invalid"
        );
        if let Some(audio) = audio.first() {
            ensure!(
                audio["codec_name"] == "aac"
                    && audio["profile"] == "LC"
                    && audio["channels"] == 2
                    && audio["sample_rate"] == "48000",
                "advanced_media_output_audio_recipe_mismatch"
            );
        }
        ensure!(
            streams.len() == 1 + audio.len(),
            "advanced_media_output_unexpected_track"
        );
        Ok(())
    }
}

pub fn analyze(
    meta: &Value,
    audio: Option<u32>,
    position_ms: f64,
    request: &Request,
) -> Result<crate::capabilities::CandidateAnalysis> {
    // Software selection here describes output; actual executable and device
    // availability are checked on the exact Worker at execution time.
    let recipe = Recipe::from_probe(
        meta,
        audio,
        position_ms / 1000.0,
        request,
        EncoderSelection::software_recipe(),
    )?;
    let codec = crate::capabilities::OUTPUT_AVC;
    let output_audio = recipe.audio.map(|_| AudioCapabilityConfiguration {
        content_type: "audio/mp4; codecs=\"mp4a.40.2\"".into(),
        channels: "2".into(),
        bitrate: 128000,
        samplerate: 48000,
    });
    Ok(crate::capabilities::CandidateAnalysis {
        candidates: vec![PlaybackCandidate {
            id: "transcode_720p".into(),
            delivery_mode: "transcode".into(),
            transport: "hls".into(),
            content_type: format!(
                "video/mp4; codecs=\"{codec}{}\"",
                if output_audio.is_some() {
                    ", mp4a.40.2"
                } else {
                    ""
                }
            ),
            video: VideoCapabilityConfiguration {
                content_type: format!("video/mp4; codecs=\"{codec}\""),
                width: 1280,
                height: 720,
                bitrate: 4_000_000,
                framerate: 30.0,
                dolby_vision: None,
            },
            audio: output_audio,
        }],
        route_decisions: ["direct", "remux", "audio_transcode", "transcode_720p"]
            .into_iter()
            .map(|id| PlaybackRouteDecision {
                candidate_id: id.into(),
                offered: id == "transcode_720p",
                reason: if id == "transcode_720p" {
                    PlaybackRouteReason::ConstrainedEncoderRecipe
                } else {
                    PlaybackRouteReason::VideoTransformRequired
                },
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::advanced_media::{DeviceObservation, EncoderPreference, OwnedLocalInput};
    use serde_json::json;
    fn metadata() -> Value {
        json!({"format":{"start_time":"0.250"},"streams":[
            {"index":0,"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}},
            {"index":3,"codec_type":"video","codec_name":"hevc","width":1920,"height":1080,"pix_fmt":"yuv420p","color_transfer":"bt709","disposition":{"attached_pic":0}},
            {"index":4,"codec_type":"audio","codec_name":"aac"},
            {"index":5,"codec_type":"subtitle","codec_name":"ass"},
            {"index":7,"codec_type":"subtitle","codec_name":"ssa"},
            {"index":9,"codec_type":"subtitle","codec_name":"hdmv_pgs_subtitle"}
        ]})
    }
    fn inventory() -> Inventory {
        Inventory::from_reports(" V....D libx264 encoder\n A..... aac encoder\n V....D h264_nvenc encoder\n V..... h264_qsv encoder\n V....D h264_vaapi encoder", " ... null V->V\n ... scale V->V\n ... setsar V->V\n ... pad V->V\n ... format V->V\n ... trim V->V\n ... setpts V->V\n ... subtitles V->V\n ... ass V->V\n ... overlay VV->V\n ... zscale V->V\n ... tonemap V->V\n ... sidedata V->V\n ... atrim A->A\n ... asetpts A->A\n ... hwupload V->V", " S..... ass subtitle\n S..... ssa subtitle\n S..... pgssub subtitle", "ffmpeg version fixture", DeviceObservation { nvenc_device_present:true, vaapi_render_node:Some("/dev/dri/renderD128".into()), qsv_render_node:Some("/dev/dri/renderD128".into()) }).unwrap()
    }
    fn owned() -> (std::path::PathBuf, OwnedLocalInput) {
        let root =
            std::env::temp_dir().join(format!("advanced-media-recipe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            root.join("source.mkv"),
            b"unit metadata fixture only, not media",
        )
        .unwrap();
        let version = crate::file_version::snapshot_file(
            &std::fs::File::open(root.join("source.mkv")).unwrap(),
        )
        .unwrap()
        .version;
        let owner = OwnedLocalInput::open(&root, "source.mkv", &version).unwrap();
        (root, owner)
    }
    #[test]
    fn subtitle_recipe_keeps_absolute_indices_original_timestamps_and_owned_fonts() {
        if !cfg!(target_os = "linux") {
            return;
        }
        let request = Request {
            subtitle_stream_index: Some(7),
            ..Default::default()
        };
        let recipe = Recipe::from_probe(
            &metadata(),
            Some(4),
            1.0135,
            &request,
            EncoderSelection::software_recipe(),
        )
        .unwrap();
        let (root, input) = owned();
        let args = recipe
            .ffmpeg_args(
                Input::OwnedLocal(&input),
                &root.join("index.m3u8"),
                &inventory(),
                false,
            )
            .unwrap();
        let graph = &args[args.iter().position(|s| s == "-filter_complex").unwrap() + 1];
        assert!(graph.starts_with("[0:3]null,subtitles=filename='/proc/self/fd/"));
        assert!(graph.contains(":si=1:original_size=1920x1080"));
        assert!(graph.contains(",trim=start=1.2635,setpts=PTS-1.2635/TB"));
        assert!(graph.contains("[0:4]atrim=start=1.2635,asetpts=PTS-1.2635/TB[rsa]"));
        assert!(args.contains(&"-copyts".into()));
        assert!(!args.contains(&"-ss".into()));
        assert!(!graph.contains("force_style") && !graph.contains("fontsdir"));
        assert_eq!(
            args.last().unwrap(),
            root.join("index.m3u8").to_str().unwrap()
        );
        drop(input);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn external_assets_use_only_owned_descriptors_and_source_relative_timing() {
        if !cfg!(target_os = "linux") {
            return;
        }
        let (root, input) = owned();
        std::fs::write(
            root.join("source.ass"),
            b"[Script Info]\n[Events]\nFormat: Layer, Text\n",
        )
        .unwrap();
        let catalog =
            super::super::AssetCatalog::discover(&root, "source.mkv", input.version()).unwrap();
        let assets = super::super::OwnedAssets::open(
            &root,
            &catalog,
            super::super::EXTERNAL_ASS_INDEX,
            &root.join("owned-fonts"),
        )
        .unwrap();
        let mut meta = metadata();
        meta["advanced_assets"] = serde_json::to_value(&catalog).unwrap();
        let request = Request {
            subtitle_stream_index: Some(super::super::EXTERNAL_ASS_INDEX),
            ..Default::default()
        };
        let recipe = Recipe::from_probe(
            &meta,
            Some(4),
            1.0135,
            &request,
            EncoderSelection::software_recipe(),
        )
        .unwrap();
        assert!(
            recipe
                .ffmpeg_args(
                    Input::OwnedLocal(&input),
                    &root.join("index.m3u8"),
                    &inventory(),
                    false
                )
                .is_err()
        );
        let args = recipe
            .ffmpeg_args_with_assets(
                Input::OwnedLocal(&input),
                &root.join("index.m3u8"),
                &inventory(),
                false,
                Some(&assets),
            )
            .unwrap();
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.starts_with("[0:3]setpts=PTS-0.25/TB,null,ass=filename='/proc/self/fd/"));
        assert!(graph.contains(",trim=start=1.0135,setpts=PTS-1.0135/TB"));
        assert!(graph.contains("[0:4]atrim=start=1.2635,asetpts=PTS-1.2635/TB[rsa]"));
        assert!(graph.contains("fontsdir='"));
        assert!(!graph.contains("force_style"));
        drop(assets);
        drop(input);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn associated_fonts_augment_embedded_ass_without_switching_to_external_text() {
        if !cfg!(target_os = "linux") {
            return;
        }
        let (root, input) = owned();
        std::fs::create_dir(root.join("source.fonts")).unwrap();
        std::fs::write(root.join("source.fonts/f.ttf"), b"\0\x01\0\0font fixture").unwrap();
        let catalog =
            super::super::AssetCatalog::discover(&root, "source.mkv", input.version()).unwrap();
        let mut meta = metadata();
        meta["advanced_assets"] = serde_json::to_value(&catalog).unwrap();
        let recipe = Recipe::from_probe(
            &meta,
            None,
            0.0,
            &Request {
                subtitle_stream_index: Some(5),
                ..Default::default()
            },
            EncoderSelection::software_recipe(),
        )
        .unwrap();
        assert!(recipe.requires_external_fonts());
        assert!(recipe.external_subtitle().is_none());
        let assets =
            super::super::OwnedAssets::open_fonts(&root, &catalog, &root.join("owned-fonts"))
                .unwrap();
        let args = recipe
            .ffmpeg_args_with_assets(
                Input::OwnedLocal(&input),
                &root.join("index.m3u8"),
                &inventory(),
                false,
                Some(&assets),
            )
            .unwrap();
        let graph = &args[args.iter().position(|v| v == "-filter_complex").unwrap() + 1];
        assert!(graph.contains(",subtitles=filename='/proc/self/fd/"));
        assert!(graph.contains(":si=0:"));
        assert!(graph.contains(":fontsdir='"));
        assert!(!graph.contains(",ass=filename="));
        drop(assets);
        drop(input);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pgs_uses_bitmap_overlay_and_never_libass_text_conversion() {
        if !cfg!(target_os = "linux") {
            return;
        }
        let request = Request {
            subtitle_stream_index: Some(9),
            ..Default::default()
        };
        let recipe = Recipe::from_probe(
            &metadata(),
            None,
            0.0,
            &request,
            EncoderSelection::software_recipe(),
        )
        .unwrap();
        let (root, input) = owned();
        let args = recipe
            .ffmpeg_args(
                Input::OwnedLocal(&input),
                &root.join("index.m3u8"),
                &inventory(),
                false,
            )
            .unwrap();
        let graph = &args[args.iter().position(|s| s == "-filter_complex").unwrap() + 1];
        assert!(graph.contains("[rsbase][0:9]overlay=eof_action=pass:shortest=0:repeatlast=0"));
        assert!(!graph.contains("subtitles="));
        assert!(args.windows(2).any(|v| v == ["-canvas_size", "1920x1080"]));
        let mut changed = metadata();
        changed["streams"][1]["side_data_list"] =
            json!([{"side_data_type":"Display Matrix","rotation":90}]);
        assert!(
            Recipe::from_probe(
                &changed,
                None,
                0.0,
                &request,
                EncoderSelection::software_recipe()
            )
            .is_err()
        );
        drop(input);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recognized_hdr_requires_opt_in_and_never_offers_copy_routes() {
        let mut meta = metadata();
        meta["streams"][1]["color_transfer"] = json!("smpte2084");
        meta["streams"][1]["color_primaries"] = json!("bt2020");
        meta["streams"][1]["color_space"] = json!("bt2020nc");
        meta["streams"][1]["color_range"] = json!("tv");
        meta["streams"][1]["pix_fmt"] = json!("yuv420p10le");
        meta["streams"][1]["profile"] = json!("Main 10");
        meta["streams"][1]["sample_aspect_ratio"] = json!("1:1");
        assert!(analyze(&meta, None, 0.0, &Request::default()).is_err());
        let request = Request {
            tone_map_hdr: true,
            ..Default::default()
        };
        let analysis = analyze(&meta, None, 0.0, &request).unwrap();
        assert_eq!(analysis.candidates.len(), 1);
        assert_eq!(analysis.candidates[0].id, "transcode_720p");
        assert!(analysis.route_decisions[..3].iter().all(|r| !r.offered));
        assert!(analyze(&metadata(), None, 0.0, &request).is_err());
        meta["streams"][0]["codec_tag_string"] = json!("encv");
        assert_eq!(
            analyze(&meta, None, 0.0, &request)
                .err()
                .unwrap()
                .to_string(),
            "drm_unsupported"
        );
    }
    #[test]
    fn all_hardware_backends_have_closed_fixed_output_recipes() {
        let meta = metadata();
        let inventory = inventory();
        let (root, input) = owned();
        for preference in [
            EncoderPreference::PreferNvenc,
            EncoderPreference::PreferQsv,
            EncoderPreference::PreferVaapi,
        ] {
            let encoder = EncoderSelection::choose(preference, &inventory).unwrap();
            let recipe =
                Recipe::from_probe(&meta, None, 2.0, &Request::default(), encoder).unwrap();
            let args = recipe
                .ffmpeg_args(
                    Input::OwnedLocal(&input),
                    &root.join("index.m3u8"),
                    &inventory,
                    false,
                )
                .unwrap();
            assert!(
                args.windows(2)
                    .any(|v| v == ["-c:v", recipe.encoder().backend().encoder()])
            );
            assert!(args.windows(2).any(|v| v == ["-level:v", "3.1"]));
            assert!(
                args.windows(2)
                    .any(|v| v == ["-force_key_frames", "expr:gte(t,n_forced*4)"])
            );
            assert!(
                args.windows(2)
                    .any(|v| v == ["-hls_playlist_type", "event"])
            );
            assert_eq!(args.iter().filter(|s| *s == "-i").count(), 1);
        }
        drop(input);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn output_probe_must_match_the_exact_advertised_sdr_configuration() {
        let recipe = Recipe::from_probe(
            &metadata(),
            None,
            0.0,
            &Request::default(),
            EncoderSelection::software_recipe(),
        )
        .unwrap();
        let mut output = json!({"streams":[{"codec_type":"video","codec_name":"h264","codec_tag_string":"avc1","width":1280,"height":720,"pix_fmt":"yuv420p","sample_aspect_ratio":"1:1","r_frame_rate":"30/1","color_transfer":"bt709","extradata":"00000000: 0164 001f ffe1 00  .d....."},{"codec_type":"audio","codec_name":"aac","profile":"LC","channels":2,"sample_rate":"48000"}]});
        recipe.validate_output_probe(&output).unwrap();
        output["streams"][0]["extradata"] = json!("00000000: 0164 002a ffe1 00  .d.....");
        assert!(recipe.validate_output_probe(&output).is_err());
        output["streams"][0]["extradata"] = json!("00000000: 0164 001f ffe1 00  .d.....");
        output["streams"][0]["color_transfer"] = json!("smpte2084");
        assert!(recipe.validate_output_probe(&output).is_err());
    }
    #[test]
    fn request_cannot_carry_filter_path_or_new_schema() {
        assert!(
            serde_json::from_value::<Request>(json!({"schema_version":1,"fontsdir":"/etc"}))
                .is_err()
        );
        assert!(
            Request {
                schema_version: 2,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
}
