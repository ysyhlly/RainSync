//! Finite configurations derived from actual codec headers or a fixed encoder recipe.
use protocol::{
    AudioCapabilityConfiguration as Audio, PlaybackCandidate, PlaybackRouteDecision,
    PlaybackRouteReason as Reason, VideoCapabilityConfiguration as Video,
};
use serde_json::Value;

pub const OUTPUT_AVC: &str = "avc1.64001F";
// `dar` includes sample aspect ratio after FFmpeg's input autorotation. Fitting
// coded width/height and then discarding SAR would stretch anamorphic inputs.
pub const OUTPUT_VIDEO_FILTER: &str = "scale=w='if(gte(dar,16/9),1280,max(2,trunc(720*dar/2)*2))':h='if(gte(dar,16/9),max(2,trunc(1280/dar/2)*2),720)',setsar=1,pad=1280:720:(ow-iw)/2:(oh-ih)/2";

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

pub(crate) fn avc_codec(stream: &Value) -> Option<String> {
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
    // AudioSpecificConfig's channelConfiguration is not a channel count (7 is
    // 7.1, and 0 requires a program configuration element we do not parse).
    // ffprobe labels alone must not override a contradictory codec header.
    let frequency_index = (bytes[0] & 7) << 1 | bytes[1] >> 7;
    let sample_rates = [
        96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025,
        8_000, 7_350,
    ];
    let (header_rate, channel_configuration) = if frequency_index == 15 {
        if bytes.len() < 5 {
            return None;
        }
        (
            (u32::from(bytes[1] & 0x7f) << 17)
                | (u32::from(bytes[2]) << 9)
                | (u32::from(bytes[3]) << 1)
                | u32::from(bytes[4] >> 7),
            (bytes[4] >> 3) & 15,
        )
    } else {
        (
            *sample_rates.get(usize::from(frequency_index))?,
            (bytes[1] >> 3) & 15,
        )
    };
    let header_channels = match channel_configuration {
        1..=6 => u64::from(channel_configuration),
        7 => 8,
        _ => return None,
    };
    let channels = stream["channels"]
        .as_u64()
        .filter(|v| *v == header_channels)?;
    let samplerate = number(&stream["sample_rate"])?;
    let bitrate = number(&stream["bit_rate"])?;
    if samplerate != f64::from(header_rate)
        || bitrate > f64::from(u32::MAX)
        || bitrate.fract() != 0.0
    {
        return None;
    }
    Some(Audio {
        content_type: "audio/mp4; codecs=\"mp4a.40.2\"".into(),
        channels: channels.to_string(),
        bitrate: bitrate as u32,
        samplerate: header_rate,
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

/// HEVC configurationRecord fields follow ISO/IEC 14496-15 Annex E codec
/// parameter syntax: compatibility bits are reversed, constraint bytes are not.
/// Only a measured hvc1/hev1 MP4 entry and explicit BT.709 SDR are supported.
fn hevc_codec(stream: &Value) -> Option<String> {
    if stream["codec_name"] != "hevc"
        || !matches!(stream["codec_tag_string"].as_str(), Some("hvc1" | "hev1"))
        || stream["color_transfer"] != "bt709"
        || stream["color_primaries"] != "bt709"
        || stream["color_space"] != "bt709"
    {
        return None;
    }
    hevc_parameter_codec(stream)
}

fn hevc_parameter_codec(stream: &Value) -> Option<String> {
    let tag = stream["codec_tag_string"].as_str()?;
    if !matches!(tag, "hvc1" | "hev1" | "dvh1" | "dvhe") {
        return None;
    }
    let bytes = extradata(stream)?;
    if bytes.len() < 23 || bytes[0] != 1 || bytes[1] >> 6 != 0 {
        return None;
    }
    let profile = bytes[1] & 31;
    let depth = match (
        profile,
        stream["pix_fmt"].as_str(),
        stream["profile"].as_str(),
    ) {
        (1, Some("yuv420p"), Some("Main")) => 0,
        (2, Some("yuv420p10le"), Some("Main 10")) => 2,
        _ => return None,
    };
    if bytes[16] & 3 != 1
        || bytes[17] & 7 != depth
        || bytes[18] & 7 != depth
        || bytes[12] == 0
        || stream["level"].as_u64() != Some(u64::from(bytes[12]))
    {
        return None;
    }
    let compatibility = u32::from_be_bytes(bytes[2..6].try_into().ok()?).reverse_bits();
    let tier = if bytes[1] & 32 == 0 { 'L' } else { 'H' };
    let mut codec = format!("{tag}.{profile}.{compatibility:X}.{tier}{}", bytes[12]);
    if let Some(last) = bytes[6..12].iter().rposition(|byte| *byte != 0) {
        for byte in &bytes[6..=6 + last] {
            codec.push_str(&format!(".{byte:02X}"));
        }
    }
    Some(codec)
}

fn native_dolby_vision(
    video: &Value,
) -> anyhow::Result<Option<crate::advanced_media::DolbyVisionSource>> {
    // Keep the public candidate refusal compatible with existing HDR clients;
    // the advanced recipe retains the more specific internal diagnosis.
    crate::advanced_media::DolbyVisionSource::from_stream(video)
        .map_err(|_| anyhow::anyhow!("hdr_unsupported"))
}

/// These are explicit source indicators, not a DRM scan or proof of its absence.
pub fn validate_source(meta: &Value) -> anyhow::Result<&Value> {
    let streams = validate_protected_tracks(meta)?;
    let video = streams
        .iter()
        .find(|v| v["codec_type"] == "video")
        .ok_or_else(|| anyhow::anyhow!("no_video"))?;
    validate_video_range(video)?;
    Ok(video)
}

/// The protected-track guard remains global, including cover and unselected
/// streams. A selected motion stream cannot waive encrypted-track rejection.
pub(crate) fn validate_protected_tracks(meta: &Value) -> anyhow::Result<&[Value]> {
    let streams = meta["streams"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("no_streams"))?;
    let encrypted = streams.iter().any(|stream| {
        matches!(stream["codec_tag_string"].as_str(), Some("encv" | "enca"))
            || stream["side_data_list"].as_array().is_some_and(|rows| {
                rows.iter().any(|row| {
                    matches!(
                        row["side_data_type"].as_str(),
                        Some("Encryption initialization data" | "Encryption info")
                    )
                })
            })
    });
    anyhow::ensure!(!encrypted, "drm_unsupported");
    Ok(streams)
}

pub fn validate_motion_source(
    meta: &Value,
) -> anyhow::Result<crate::motion_video::SelectedMotionVideo<'_>> {
    validate_protected_tracks(meta)?;
    let selected = crate::motion_video::select(meta)?;
    validate_video_range(selected.stream)?;
    Ok(selected)
}

fn validate_video_range(video: &Value) -> anyhow::Result<()> {
    let hdr = matches!(video["codec_tag_string"].as_str(), Some("dvh1" | "dvhe"))
        || matches!(
            video["color_transfer"].as_str(),
            Some("smpte2084" | "arib-std-b67")
        )
        || video["side_data_list"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| row["side_data_type"] == "DOVI configuration record")
        });
    anyhow::ensure!(!hdr, "hdr_unsupported");
    // Pixel names are an explicit bounded <=8-bit set, not a heuristic that
    // mistakes missing bits_per_raw_sample or an unfamiliar name for SDR.
    // Packed, semi-planar, gray and float high-depth families must not slip
    // through merely because their spelling lacks "p10" (p010le, rgb48le, ...).
    let known_low_depth = matches!(
        video["pix_fmt"].as_str(),
        Some(
            "yuv420p"
                | "yuv422p"
                | "yuv444p"
                | "yuv410p"
                | "yuv411p"
                | "yuv440p"
                | "yuvj420p"
                | "yuvj422p"
                | "yuvj444p"
                | "yuvj440p"
                | "yuvj411p"
                | "yuva420p"
                | "yuva422p"
                | "yuva444p"
                | "nv12"
                | "nv21"
                | "nv16"
                | "nv24"
                | "nv42"
                | "yuyv422"
                | "uyvy422"
                | "uyyvyy411"
                | "gray"
                | "monow"
                | "monob"
                | "pal8"
                | "ya8"
                | "gbrp"
                | "gbrap"
                | "rgb24"
                | "bgr24"
                | "rgb8"
                | "bgr8"
                | "rgb4"
                | "bgr4"
                | "rgb4_byte"
                | "bgr4_byte"
                | "rgba"
                | "bgra"
                | "argb"
                | "abgr"
                | "0rgb"
                | "rgb0"
                | "0bgr"
                | "bgr0"
        )
    ) && number(&video["bits_per_raw_sample"])
        .is_none_or(|depth| depth <= 8.0);
    anyhow::ensure!(
        known_low_depth || video["color_transfer"] == "bt709",
        "unclassified_video_range"
    );
    Ok(())
}

pub struct CandidateAnalysis {
    pub candidates: Vec<PlaybackCandidate>,
    pub route_decisions: Vec<PlaybackRouteDecision>,
}

/// No fabricated profile IDs: passthrough formats require codec extradata.
/// A full transcode candidate describes the enforced SDR 720p30 recipe below.
pub fn candidates(
    meta: &Value,
    selected: Option<u32>,
    position_ms: f64,
) -> anyhow::Result<Vec<PlaybackCandidate>> {
    Ok(analyze(meta, selected, position_ms)?.candidates)
}

pub fn analyze(
    meta: &Value,
    selected: Option<u32>,
    position_ms: f64,
) -> anyhow::Result<CandidateAnalysis> {
    anyhow::ensure!(
        position_ms.is_finite() && position_ms >= 0.0,
        "invalid_position"
    );
    // Candidate analysis may offer an original Dolby Vision file. The ordinary
    // Worker range validator remains strict, so this never authorizes an SDR
    // transcode that discards an RPU.
    let streams = validate_protected_tracks(meta)?;
    let first = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or_else(|| anyhow::anyhow!("no_video"))?;
    let video = if native_dolby_vision(first)?.is_some() {
        first
    } else {
        validate_source(meta)?
    };
    analyze_video(
        meta,
        selected,
        position_ms,
        video,
        super::hls_needs_video_transform(meta),
        false,
    )
}

fn unavailable_routes(reason: Reason) -> CandidateAnalysis {
    CandidateAnalysis {
        candidates: Vec::new(),
        route_decisions: ["direct", "remux", "audio_transcode", "transcode_720p"]
            .into_iter()
            .map(|id| PlaybackRouteDecision {
                candidate_id: id.into(),
                offered: false,
                reason,
            })
            .collect(),
    }
}

/// Analyze admission for generated jobs that retain the legacy Worker maps.
/// Generated routes require strict equivalence; the original-file route keeps
/// its existing analysis and exactly-one-total-video track constraint. This
/// gate does not activate indexed mappings or change legacy recipe wrappers.
pub fn analyze_legacy_mapped_source(
    meta: &Value,
    selected_audio: Option<u32>,
    position_ms: f64,
) -> anyhow::Result<CandidateAnalysis> {
    anyhow::ensure!(
        position_ms.is_finite() && position_ms >= 0.0,
        "invalid_position"
    );
    // Mapping uncertainty must never waive the global protected-track guard.
    let streams = match validate_protected_tracks(meta) {
        Ok(streams) => streams,
        Err(error) if error.to_string() == "no_streams" => {
            return Ok(unavailable_routes(Reason::VideoConfigurationUnavailable));
        }
        Err(error) => return Err(error),
    };
    if let Some(video) = streams.iter().find(|row| row["codec_type"] == "video")
        && !crate::motion_video::is_attached_picture(video)
        && native_dolby_vision(video)?.is_some()
    {
        // The legacy map equivalence proof includes the ordinary SDR range
        // gate. Dolby offers only the original-file route, whose exact track
        // layout is checked independently; no generated legacy map is used.
        return analyze(meta, selected_audio, position_ms);
    }
    let equivalent = match crate::motion_video::legacy_mapping_equivalent(meta, selected_audio) {
        Ok(()) => true,
        Err(error) if error.to_string() == "legacy_stream_mapping_unsupported" => false,
        Err(error) => return Err(error),
    };
    if equivalent {
        // The proof equates JSON-first facts with both legacy FFmpeg maps; keep
        // all existing transform, codec, HDR/range and direct guards unchanged.
        return analyze(meta, selected_audio, position_ms);
    }
    let videos: Vec<_> = streams
        .iter()
        .filter(|row| row["codec_type"] == "video")
        .collect();
    let no_motion = !videos
        .iter()
        .any(|video| !crate::motion_video::is_attached_picture(video));
    let original_track_layout = selected_audio.is_none()
        && videos.len() == 1
        && streams
            .iter()
            .filter(|row| row["codec_type"] == "audio")
            .count()
            <= 1;
    if !original_track_layout {
        // No original route is eligible. Refuse the uncertain generated maps
        // without claiming that an unselected cover or alternate is HDR.
        return Ok(unavailable_routes(if no_motion {
            Reason::VideoConfigurationUnavailable
        } else {
            Reason::TrackMappingRequired
        }));
    }
    let mut analysis = if no_motion {
        // Preserve an original route only when legacy analysis actually offers
        // it. A cover-only catalog cannot establish generated video support;
        // its JPEG depth/range facts are not evidence of motion-video HDR.
        match analyze(meta, selected_audio, position_ms) {
            Ok(analysis)
                if analysis
                    .candidates
                    .iter()
                    .any(|candidate| candidate.id == "direct") =>
            {
                analysis
            }
            _ => return Ok(unavailable_routes(Reason::VideoConfigurationUnavailable)),
        }
    } else {
        analyze(meta, selected_audio, position_ms)?
    };
    analysis
        .candidates
        .retain(|candidate| candidate.id == "direct");
    for decision in &mut analysis.route_decisions {
        if decision.candidate_id != "direct" {
            decision.offered = false;
            decision.reason = if no_motion {
                Reason::VideoConfigurationUnavailable
            } else {
                Reason::TrackMappingRequired
            };
        }
    }
    Ok(analysis)
}

/// Pure opt-in analysis. It does not enable public candidates or new jobs.
/// Cover-only/audio-only catalogs return explanatory not-offered decisions
/// using the existing finite reason; no new protocol/schema is introduced.
pub fn analyze_motion_source(
    meta: &Value,
    selected_audio: Option<u32>,
    position_ms: f64,
) -> anyhow::Result<CandidateAnalysis> {
    anyhow::ensure!(
        position_ms.is_finite() && position_ms >= 0.0,
        "invalid_position"
    );
    validate_protected_tracks(meta)?;
    let motion = crate::motion_video::select(meta);
    let selected = match motion.and_then(|selected| {
        if native_dolby_vision(selected.stream)?.is_none() {
            validate_video_range(selected.stream)?;
        }
        Ok(selected)
    }) {
        Ok(selected) => selected,
        Err(error) if error.to_string() == "no_motion_video" => {
            return Ok(CandidateAnalysis {
                candidates: Vec::new(),
                route_decisions: ["direct", "remux", "audio_transcode", "transcode_720p"]
                    .into_iter()
                    .map(|id| PlaybackRouteDecision {
                        candidate_id: id.into(),
                        offered: false,
                        reason: Reason::VideoConfigurationUnavailable,
                    })
                    .collect(),
            });
        }
        Err(error) => return Err(error),
    };
    analyze_video(
        meta,
        selected_audio,
        position_ms,
        selected.stream,
        super::video_needs_transform(selected.stream),
        true,
    )
}

/// Source-bound provenance helper for the future paired recipe. Configuration
/// equivalence alone cannot detect a changed source under a fixed transcode.
pub fn require_current_motion_candidate(
    meta: &Value,
    selection: &crate::motion_video::VideoSelectionIdentity,
    candidate: &PlaybackCandidate,
    audio_index: Option<u32>,
    position_ms: f64,
) -> anyhow::Result<()> {
    crate::motion_video::require_same_selection(meta, selection)
        .map_err(|_| anyhow::anyhow!("source_changed"))?;
    let actual = analyze_motion_source(meta, audio_index, position_ms)
        .map_err(|_| anyhow::anyhow!("source_changed"))?;
    let expected = serde_json::to_value(candidate)?;
    anyhow::ensure!(
        actual
            .candidates
            .iter()
            .any(|candidate| serde_json::to_value(candidate).ok().as_ref() == Some(&expected)),
        "source_changed"
    );
    Ok(())
}

fn analyze_video(
    meta: &Value,
    selected: Option<u32>,
    position_ms: f64,
    video: &Value,
    video_transform: bool,
    canonical_default_audio: bool,
) -> anyhow::Result<CandidateAnalysis> {
    let streams = meta["streams"].as_array().expect("validated streams");
    let audio = if canonical_default_audio {
        crate::motion_video::select_audio(meta, selected)?
    } else if let Some(index) = selected {
        let mut matching = streams.iter().filter(|v| {
            v["codec_type"] == "audio" && v["index"].as_u64() == Some(u64::from(index))
        });
        let audio = matching
            .next()
            .ok_or_else(|| anyhow::anyhow!("invalid_audio_track"))?;
        anyhow::ensure!(matching.next().is_none(), "invalid_audio_track");
        Some(audio)
    } else {
        streams.iter().find(|v| v["codec_type"] == "audio")
    };
    let dolby = native_dolby_vision(video)?;
    let avc = avc_codec(video);
    let codec = if let Some(dolby) = dolby {
        hevc_parameter_codec(video).map(|codec| {
            if matches!(video["codec_tag_string"].as_str(), Some("dvh1" | "dvhe")) {
                dolby.codec(video["codec_tag_string"] == "dvhe")
            } else {
                codec
            }
        })
    } else {
        avc.clone().or_else(|| hevc_codec(video))
    };
    let configuration = codec
        .as_ref()
        .zip(video["width"].as_u64())
        .zip(video["height"].as_u64())
        .zip(rate(&video["avg_frame_rate"]))
        .zip(number(&video["bit_rate"]).or_else(|| number(&meta["format"]["bit_rate"])))
        .and_then(|((((codec, width), height), framerate), bitrate)| {
            ((1..=16384).contains(&width)
                && (1..=16384).contains(&height)
                && bitrate <= u32::MAX as f64)
                .then(|| Video {
                    content_type: format!("video/mp4; codecs=\"{codec}\""),
                    width: width as u32,
                    height: height as u32,
                    framerate,
                    bitrate: bitrate as u32,
                    dolby_vision: dolby.map(|source| {
                        source.configuration(matches!(
                            video["codec_tag_string"].as_str(),
                            Some("hev1" | "dvhe")
                        ))
                    }),
                })
        });
    let transform = video_transform
        || !matches!(
            video["sample_aspect_ratio"].as_str(),
            None | Some("1:1" | "N/A")
        );
    let measured_audio = audio.and_then(aac);
    let audio_copy = audio.is_none() || measured_audio.is_some();
    let mp4_family = meta["format"]["format_name"]
        .as_str()
        .is_some_and(|s| s.split(',').any(|v| v == "mp4"));
    // ffprobe's mov,mp4,... string identifies a shared demuxer, not the file's
    // container. Require a known ISO-BMFF/MP4 brand for original-file MP4 MIME.
    let mp4 = mp4_family
        && matches!(
            meta["format"]["tags"]["major_brand"].as_str(),
            Some(
                "isom"
                    | "iso2"
                    | "iso3"
                    | "iso4"
                    | "iso5"
                    | "iso6"
                    | "iso7"
                    | "iso8"
                    | "iso9"
                    | "mp41"
                    | "mp42"
                    | "avc1"
            )
        );
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
    let common = if configuration.is_none() {
        Some(Reason::VideoConfigurationUnavailable)
    } else if avc.is_some()
        && (video["codec_tag_string"] == "avc3"
            || (mp4_family && video["codec_tag_string"] != "avc1"))
    {
        // avcC is also used by avc3. It cannot prove an avc1 original-file
        // sample entry or that stream copy safely changes that contract.
        Some(Reason::SampleEntryUnsupported)
    } else if transform {
        Some(Reason::VideoTransformRequired)
    } else {
        None
    };
    let direct = common.or_else(|| {
        if !mp4 {
            Some(Reason::ContainerUnsupported)
        } else if selected.is_some() || !unambiguous_tracks {
            Some(Reason::TrackMappingRequired)
        } else if !audio_copy {
            Some(Reason::AudioConfigurationUnavailable)
        } else {
            None
        }
    });
    let copy = common.or_else(|| {
        if avc.is_none() {
            Some(Reason::VideoCopyUnsupported)
        } else if position_ms != 0.0 {
            Some(Reason::NonzeroCopyOrigin)
        } else {
            None
        }
    });
    let remux = copy.or((!audio_copy).then_some(Reason::AudioConfigurationUnavailable));
    let audio_transcode = copy.or(audio.is_none().then_some(Reason::NoAudioTrack));
    let mut result = Vec::new();
    let mut decisions = Vec::new();
    for (id, mode, transport, rejected, output_audio) in [
        (
            "direct",
            "direct",
            "progressive",
            direct,
            measured_audio.clone(),
        ),
        ("remux", "remux", "hls", remux, measured_audio),
        (
            "audio_transcode",
            "audio_transcode",
            "hls",
            audio_transcode,
            audio.map(|_| output_audio()),
        ),
    ] {
        decisions.push(PlaybackRouteDecision {
            candidate_id: id.into(),
            offered: rejected.is_none(),
            reason: rejected.unwrap_or(if mode == "audio_transcode" {
                Reason::ConstrainedEncoderRecipe
            } else {
                Reason::SourceConfiguration
            }),
        });
        if rejected.is_none() {
            result.push(make(
                id,
                mode,
                transport,
                codec.as_ref().expect("measured codec"),
                configuration
                    .as_ref()
                    .expect("measured configuration")
                    .clone(),
                output_audio,
            ));
        }
    }
    if dolby.is_some() {
        decisions.push(PlaybackRouteDecision {
            candidate_id: "transcode_720p".into(),
            offered: false,
            reason: Reason::VideoCopyUnsupported,
        });
        return Ok(CandidateAnalysis {
            candidates: result,
            route_decisions: decisions,
        });
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
            dolby_vision: None,
        },
        audio.map(|_| output_audio()),
    ));
    decisions.push(PlaybackRouteDecision {
        candidate_id: "transcode_720p".into(),
        offered: true,
        reason: Reason::ConstrainedEncoderRecipe,
    });
    Ok(CandidateAnalysis {
        candidates: result,
        route_decisions: decisions,
    })
}

/// Exact output settings paired with transcode_720p and audio_transcode candidates.
pub fn negotiated_hls_args(
    input: &str,
    output: &str,
    start: f64,
    mode: &str,
    audio_index: Option<u32>,
) -> Vec<String> {
    negotiated_hls_args_for_video(
        input,
        output,
        start,
        mode,
        crate::motion_video::VideoMapping::LegacyFirstVideo,
        audio_index,
    )
}

/// Paired source-recipe helper: selected motion and canonical default audio
/// facts resolve to the same validated absolute FFmpeg mappings. Legacy entry
/// points remain unchanged; this opt-in helper does not enable admission.
pub fn negotiated_hls_args_for_motion_source(
    meta: &Value,
    input: &str,
    output: &str,
    start: f64,
    mode: &str,
    audio_index: Option<u32>,
) -> anyhow::Result<Vec<String>> {
    let video = validate_motion_source(meta)?;
    let audio = crate::motion_video::selected_audio_index(meta, audio_index)?;
    Ok(negotiated_hls_args_for_video(
        input,
        output,
        start,
        mode,
        video.identity.mapping,
        audio,
    ))
}

/// Explicit motion mapping paired with the same finite output configuration.
/// The legacy entry point above preserves old queued jobs and fixture APIs.
pub fn negotiated_hls_args_for_video(
    input: &str,
    output: &str,
    start: f64,
    mode: &str,
    video_mapping: crate::motion_video::VideoMapping,
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
        video_mapping.ffmpeg_specifier(),
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
            OUTPUT_VIDEO_FILTER,
            "-force_key_frames",
            "expr:gte(t,n_forced*4)",
        ]
    } else {
        vec!["-c:v", "copy"]
    };
    args.extend(video.into_iter().map(String::from));
    // Every negotiated generated video is AVC; fix the fMP4 sample entry,
    // including legal non-MP4 AVC copy inputs. avc3 inputs are not copy routes.
    args.extend(["-tag:v".into(), "avc1".into()]);
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
        json!({"format":{"format_name":"mov,mp4","tags":{"major_brand":"isom"},"bit_rate":"1000000"},"streams":[{"codec_type":"video","codec_name":"h264","codec_tag_string":"avc1","pix_fmt":"yuv420p","width":640,"height":360,"avg_frame_rate":"25/1","r_frame_rate":"25/1","extradata":"\n00000000: 0164 000d ffe1 0000                      .d......\n"}]})
    }
    fn indexed_metadata() -> Value {
        let mut value = metadata();
        value["streams"][0]["index"] = json!(7);
        value["streams"][0]["disposition"]["attached_pic"] = json!(0);
        value
    }
    fn assert_analysis_matches(actual: CandidateAnalysis, expected: CandidateAnalysis) {
        assert_eq!(
            serde_json::to_value(actual.candidates).unwrap(),
            serde_json::to_value(expected.candidates).unwrap()
        );
        assert_eq!(
            serde_json::to_value(actual.route_decisions).unwrap(),
            serde_json::to_value(expected.route_decisions).unwrap()
        );
    }
    fn assert_unavailable(analysis: CandidateAnalysis, reason: Reason) {
        assert!(analysis.candidates.is_empty());
        assert_eq!(analysis.route_decisions.len(), 4);
        assert!(
            analysis
                .route_decisions
                .iter()
                .all(|decision| !decision.offered && decision.reason == reason)
        );
    }
    #[test]
    fn equivalent_legacy_mapped_analysis_keeps_existing_guards_and_total_video_constraint() {
        let ordinary = indexed_metadata();
        let mut cover_last = ordinary.clone();
        cover_last["streams"].as_array_mut().unwrap().push(json!({
            "codec_type":"video","codec_name":"mjpeg","index":42,
            "pix_fmt":"rgb24","disposition":{"attached_pic":1}
        }));
        let mut multiple_motion = ordinary.clone();
        let mut alternate = multiple_motion["streams"][0].clone();
        alternate["index"] = json!(42);
        multiple_motion["streams"]
            .as_array_mut()
            .unwrap()
            .push(alternate);
        for value in [ordinary, cover_last, multiple_motion] {
            for position in [0.0, 10.0] {
                assert_analysis_matches(
                    analyze_legacy_mapped_source(&value, None, position).unwrap(),
                    analyze(&value, None, position).unwrap(),
                );
            }
            if value["streams"].as_array().unwrap().len() > 1 {
                assert!(
                    !analyze_legacy_mapped_source(&value, None, 0.0)
                        .unwrap()
                        .candidates
                        .iter()
                        .any(|candidate| candidate.id == "direct")
                );
            }
        }
        for marker in ["smpte2084", "arib-std-b67"] {
            let mut value = indexed_metadata();
            value["streams"][0]["color_transfer"] = json!(marker);
            assert_eq!(
                analyze_legacy_mapped_source(&value, None, 0.0)
                    .err()
                    .unwrap()
                    .to_string(),
                "hdr_unsupported"
            );
        }
        let mut value = indexed_metadata();
        value["streams"][0]["pix_fmt"] = json!("p010le");
        assert_eq!(
            analyze_legacy_mapped_source(&value, None, 0.0)
                .err()
                .unwrap()
                .to_string(),
            "unclassified_video_range"
        );
    }
    #[test]
    fn legacy_mapped_analysis_preserves_indexless_original_and_filters_generated_only() {
        let value = metadata();
        let legacy = analyze(&value, None, 0.0).unwrap();
        let filtered = analyze_legacy_mapped_source(&value, None, 0.0).unwrap();
        assert_eq!(filtered.candidates.len(), 1);
        assert_eq!(filtered.candidates[0].id, "direct");
        assert_eq!(
            serde_json::to_value(&filtered.candidates[0]).unwrap(),
            serde_json::to_value(&legacy.candidates[0]).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&filtered.route_decisions[0]).unwrap(),
            serde_json::to_value(&legacy.route_decisions[0]).unwrap()
        );
        assert!(filtered.route_decisions[1..].iter().all(|decision| {
            !decision.offered && decision.reason == Reason::TrackMappingRequired
        }));
        // Even an explicitly attached sole AVC row keeps historical original
        // behavior. This safety gate only changes generated-job admission.
        let mut sole_attached = indexed_metadata();
        sole_attached["streams"][0]["disposition"]["attached_pic"] = json!(1);
        let legacy = analyze(&sole_attached, None, 0.0).unwrap();
        let filtered = analyze_legacy_mapped_source(&sole_attached, None, 0.0).unwrap();
        assert_eq!(filtered.candidates.len(), 1);
        assert_eq!(filtered.candidates[0].id, "direct");
        assert_eq!(
            serde_json::to_value(&filtered.candidates[0]).unwrap(),
            serde_json::to_value(&legacy.candidates[0]).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&filtered.route_decisions[0]).unwrap(),
            serde_json::to_value(&legacy.route_decisions[0]).unwrap()
        );
        assert!(filtered.route_decisions[1..].iter().all(|decision| {
            !decision.offered && decision.reason == Reason::VideoConfigurationUnavailable
        }));
        let mut hdr = value;
        hdr["streams"][0]["color_transfer"] = json!("smpte2084");
        assert_eq!(
            analyze_legacy_mapped_source(&hdr, None, 0.0)
                .err()
                .unwrap()
                .to_string(),
            "hdr_unsupported"
        );
    }
    #[test]
    fn uncertain_legacy_generated_maps_return_four_finite_refusals_without_cover_hdr_claim() {
        let mut cover_first = indexed_metadata();
        cover_first["streams"].as_array_mut().unwrap().insert(
            0,
            json!({
                "codec_type":"video","codec_name":"mjpeg","index":0,
                "pix_fmt":"rgb48le","disposition":{"attached_pic":1}
            }),
        );
        assert_unavailable(
            analyze_legacy_mapped_source(&cover_first, None, 0.0).unwrap(),
            Reason::TrackMappingRequired,
        );
        let mut reordered_video = indexed_metadata();
        let mut first = reordered_video["streams"][0].clone();
        first["index"] = json!(42);
        reordered_video["streams"]
            .as_array_mut()
            .unwrap()
            .insert(0, first);
        assert_unavailable(
            analyze_legacy_mapped_source(&reordered_video, None, 0.0).unwrap(),
            Reason::TrackMappingRequired,
        );
        let mut reordered_audio = indexed_metadata();
        for index in [42, 0] {
            let mut row = audio(2, "1190");
            row["index"] = json!(index);
            reordered_audio["streams"].as_array_mut().unwrap().push(row);
        }
        assert_unavailable(
            analyze_legacy_mapped_source(&reordered_audio, None, 0.0).unwrap(),
            Reason::TrackMappingRequired,
        );
        for index in [0, 42] {
            assert_analysis_matches(
                analyze_legacy_mapped_source(&reordered_audio, Some(index), 0.0).unwrap(),
                analyze(&reordered_audio, Some(index), 0.0).unwrap(),
            );
        }
    }
    #[test]
    fn legacy_mapped_missing_or_no_motion_inventory_explains_all_unavailable_routes() {
        for value in [
            json!({}),
            json!({"streams":null}),
            json!({"streams":[]}),
            json!({"streams":[{"codec_type":"audio","index":0}]}),
            json!({"streams":[{"codec_type":"video","index":0,
                "disposition":{"attached_pic":1}}]}),
        ] {
            assert_unavailable(
                analyze_legacy_mapped_source(&value, None, 0.0).unwrap(),
                Reason::VideoConfigurationUnavailable,
            );
        }
    }
    #[test]
    fn cover_only_unoffered_original_does_not_report_motion_hdr_or_range_errors() {
        for facts in [
            json!({}),
            json!({"pix_fmt":"rgb24"}),
            json!({"pix_fmt":"rgb48le"}),
            json!({"pix_fmt":"p010le"}),
            json!({"pix_fmt":"rgb24","color_transfer":"smpte2084"}),
            json!({"pix_fmt":"rgb24","side_data_list":[
                {"side_data_type":"DOVI configuration record"}
            ]}),
        ] {
            let mut cover = json!({"codec_type":"video","codec_name":"mjpeg","index":0,
                "disposition":{"attached_pic":1}});
            cover
                .as_object_mut()
                .unwrap()
                .extend(facts.as_object().unwrap().clone());
            assert_unavailable(
                analyze_legacy_mapped_source(&json!({"streams":[cover]}), None, 0.0).unwrap(),
                Reason::VideoConfigurationUnavailable,
            );
        }
        let encrypted_cover = json!({"streams":[{"codec_type":"video","codec_name":"mjpeg",
            "index":0,"codec_tag_string":"encv","disposition":{"attached_pic":1}}]});
        assert_eq!(
            analyze_legacy_mapped_source(&encrypted_cover, None, 0.0)
                .err()
                .unwrap()
                .to_string(),
            "drm_unsupported"
        );
    }
    #[test]
    fn legacy_mapping_refusal_keeps_global_drm_and_explicit_audio_errors_distinct() {
        for kind in ["video", "audio", "subtitle"] {
            let mut value = indexed_metadata();
            let mut first = value["streams"][0].clone();
            first["index"] = json!(42);
            value["streams"].as_array_mut().unwrap().insert(0, first);
            value["streams"].as_array_mut().unwrap().push(json!({
                "codec_type":kind,"index":50,"codec_tag_string":"encv"
            }));
            assert_eq!(
                analyze_legacy_mapped_source(&value, None, 0.0)
                    .err()
                    .unwrap()
                    .to_string(),
                "drm_unsupported"
            );
        }
        let mut value = indexed_metadata();
        value["streams"].as_array_mut().unwrap().push(json!({
            "codec_type":"audio","index":0
        }));
        value["streams"].as_array_mut().unwrap().push(json!({
            "codec_type":"subtitle","index":0
        }));
        assert_eq!(
            analyze_legacy_mapped_source(&value, Some(0), 0.0)
                .err()
                .unwrap()
                .to_string(),
            "invalid_audio_track"
        );
        assert_eq!(
            analyze_legacy_mapped_source(&indexed_metadata(), Some(0), 0.0)
                .err()
                .unwrap()
                .to_string(),
            "invalid_audio_track"
        );
        assert_eq!(
            analyze_legacy_mapped_source(&json!({}), None, f64::NAN)
                .err()
                .unwrap()
                .to_string(),
            "invalid_position"
        );
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
    fn audio(channels: u32, bytes: &str) -> Value {
        json!({"codec_type":"audio", "index":1, "codec_name":"aac", "profile":"LC", "channels":channels,
            "sample_rate":"48000", "bit_rate":"128000", "extradata":format!("\n00000000: {bytes}  ....\n")})
    }
    #[test]
    fn aac_headers_must_agree_with_channels_sample_rate_and_bounded_bitrate() {
        assert_eq!(aac(&audio(2, "1190")).unwrap().channels, "2");
        assert_eq!(aac(&audio(6, "11b0")).unwrap().channels, "6");
        assert_eq!(aac(&audio(8, "11b8")).unwrap().channels, "8");
        for (channels, bytes) in [
            (2, "11b0"),
            (7, "11b8"),
            (2, "1180"),
            (2, "f990"),
            (2, "1690"),
        ] {
            assert!(aac(&audio(channels, bytes)).is_none());
        }
        let mut value = audio(2, "1190");
        for rate in ["44100", "48000.5", "NaN", "42949672960"] {
            value["sample_rate"] = json!(rate);
            assert!(aac(&value).is_none());
        }
        value["sample_rate"] = json!("48000");
        for bitrate in ["128000.5", "42949672960"] {
            value["bit_rate"] = json!(bitrate);
            assert!(aac(&value).is_none());
        }
    }
    #[test]
    fn copied_audio_preserves_actual_multichannel_and_encoded_audio_is_stereo() {
        let mut value = metadata();
        value["streams"]
            .as_array_mut()
            .unwrap()
            .push(audio(6, "11b0"));
        let analysis = analyze(&value, None, 0.0).unwrap();
        assert_eq!(analysis.candidates[0].audio.as_ref().unwrap().channels, "6");
        assert_eq!(analysis.candidates[1].audio.as_ref().unwrap().channels, "6");
        assert_eq!(analysis.candidates[2].id, "audio_transcode");
        assert_eq!(analysis.candidates[2].audio.as_ref().unwrap().channels, "2");
        let selected = analyze(&value, Some(1), 0.0).unwrap();
        assert_eq!(
            selected.route_decisions[0].reason,
            Reason::TrackMappingRequired
        );
        assert!(!selected.route_decisions[0].offered);
        value["streams"]
            .as_array_mut()
            .unwrap()
            .push(audio(2, "1190"));
        assert!(candidates(&value, Some(1), 0.0).is_err());
    }
    #[test]
    fn decisions_describe_offered_routes_not_device_support() {
        let mut value = metadata();
        let analysis = analyze(&value, None, 10.0).unwrap();
        assert_eq!(analysis.route_decisions.len(), 4);
        assert_eq!(
            analysis.route_decisions[0].reason,
            Reason::SourceConfiguration
        );
        assert_eq!(
            analysis.route_decisions[1].reason,
            Reason::NonzeroCopyOrigin
        );
        assert_eq!(
            analysis.route_decisions[3].reason,
            Reason::ConstrainedEncoderRecipe
        );
        assert_eq!(
            analyze(&value, None, 0.0).unwrap().route_decisions[2].reason,
            Reason::NoAudioTrack
        );
        value["format"]["format_name"] = json!("matroska,webm");
        assert_eq!(
            analyze(&value, None, 0.0).unwrap().route_decisions[0].reason,
            Reason::ContainerUnsupported
        );
        value["streams"][0]["sample_aspect_ratio"] = json!("16:15");
        let analysis = analyze(&value, None, 0.0).unwrap();
        assert_eq!(analysis.candidates.len(), 1);
        assert_eq!(
            analysis.route_decisions[0].reason,
            Reason::VideoTransformRequired
        );
    }
    fn hevc_metadata() -> Value {
        let mut value = metadata();
        let stream = &mut value["streams"][0];
        stream["codec_name"] = json!("hevc");
        stream["profile"] = json!("Main");
        stream["level"] = json!(93);
        stream["codec_tag_string"] = json!("hvc1");
        stream["color_transfer"] = json!("bt709");
        stream["color_primaries"] = json!("bt709");
        stream["color_space"] = json!("bt709");
        stream["extradata"] = json!(
            "\n00000000: 0101 6000 0000 b000 0000 0000 5df0 00fc  ........\n00000010: fdf8 f800 000f 00  ....\n"
        );
        value
    }
    #[test]
    fn hevc_exact_record_allows_sdr_direct_only_without_guessed_copy() {
        let mut value = hevc_metadata();
        let analysis = analyze(&value, None, 0.0).unwrap();
        assert_eq!(
            analysis
                .candidates
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            vec!["direct", "transcode_720p"]
        );
        assert_eq!(
            analysis.candidates[0].video.content_type,
            "video/mp4; codecs=\"hvc1.1.6.L93.B0\""
        );
        assert_eq!(
            analysis.route_decisions[1].reason,
            Reason::VideoCopyUnsupported
        );
        value["streams"][0]["pix_fmt"] = json!("yuv420p10le");
        value["streams"][0]["profile"] = json!("Main 10");
        value["streams"][0]["extradata"] = json!(
            "\n00000000: 0102 2000 0000 b000 0000 0000 5df0 00fc  ........\n00000010: fdfa fa00 000f 00  ....\n"
        );
        assert_eq!(
            candidates(&value, None, 0.0).unwrap()[0].video.content_type,
            "video/mp4; codecs=\"hvc1.2.4.L93.B0\""
        );
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("color_transfer");
        assert!(candidates(&value, None, 0.0).is_err());
    }
    #[test]
    fn explicit_hdr_and_encrypted_track_signals_remain_distinct() {
        let mut value = metadata();
        value["streams"][0]["color_transfer"] = json!("smpte2084");
        assert_eq!(
            candidates(&value, None, 0.0).err().unwrap().to_string(),
            "hdr_unsupported"
        );
        value["streams"][0]["color_transfer"] = json!("bt709");
        value["streams"][0]["side_data_list"] =
            json!([{"side_data_type":"DOVI configuration record"}]);
        assert_eq!(
            candidates(&value, None, 0.0).err().unwrap().to_string(),
            "hdr_unsupported"
        );
        value["streams"][0]["side_data_list"] = json!([]);
        value["streams"][0]["codec_tag_string"] = json!("encv");
        assert_eq!(
            candidates(&value, None, 0.0).err().unwrap().to_string(),
            "drm_unsupported"
        );
    }
    #[test]
    fn unknown_and_packed_gray_or_float_depth_never_infer_sdr_from_missing_bits() {
        for format in [
            "p010le",
            "p016be",
            "gray10le",
            "gray16le",
            "rgb48le",
            "rgba64be",
            "gbrpf32le",
            "grayf32le",
            "rgbf32le",
            "future_unknown_format",
        ] {
            for raw in [Value::Null, json!("0")] {
                let mut value = metadata();
                value["streams"][0]["pix_fmt"] = json!(format);
                value["streams"][0]["bits_per_raw_sample"] = raw;
                assert_eq!(
                    candidates(&value, None, 0.0).err().unwrap().to_string(),
                    "unclassified_video_range",
                    "{format}"
                );
                value["streams"][0]["color_transfer"] = json!("bt709");
                let routes = candidates(&value, None, 0.0).unwrap();
                assert_eq!(routes.len(), 1);
                assert_eq!(routes[0].id, "transcode_720p");
            }
        }
        let mut missing = metadata();
        missing["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("pix_fmt");
        assert!(candidates(&missing, None, 0.0).is_err());
        let mut contradictory = metadata();
        contradictory["streams"][0]["bits_per_raw_sample"] = json!("10");
        assert!(candidates(&contradictory, None, 0.0).is_err());
    }
    #[test]
    fn avc1_direct_and_copy_never_infer_the_mp4_sample_entry_from_codec_name() {
        for entry in [Value::Null, json!("avc3"), json!("unknown")] {
            let mut value = metadata();
            value["streams"][0]["codec_tag_string"] = entry;
            let analysis = analyze(&value, None, 0.0).unwrap();
            assert_eq!(analysis.candidates.len(), 1);
            assert_eq!(analysis.candidates[0].id, "transcode_720p");
            assert!(
                analysis.route_decisions[..3]
                    .iter()
                    .all(|decision| !decision.offered
                        && decision.reason == Reason::SampleEntryUnsupported)
            );
        }
        let mut non_mp4 = metadata();
        non_mp4["format"]["format_name"] = json!("matroska,webm");
        non_mp4["streams"][0]["codec_tag_string"] = json!("[0][0][0][0]");
        let analysis = analyze(&non_mp4, None, 0.0).unwrap();
        assert_eq!(analysis.candidates[0].id, "remux");
        assert_eq!(
            analysis.route_decisions[0].reason,
            Reason::ContainerUnsupported
        );
        let args = negotiated_hls_args("owned.mkv", "owned/index.m3u8", 0.0, "remux", None);
        assert!(args.windows(2).any(|args| args == ["-tag:v", "avc1"]));
    }
    #[test]
    fn shared_mov_demuxer_does_not_prove_mp4_original_container() {
        for brand in [Value::Null, json!("qt  "), json!("unknown")] {
            let mut value = metadata();
            value["format"]["tags"]["major_brand"] = brand;
            let analysis = analyze(&value, None, 0.0).unwrap();
            assert_eq!(
                analysis.route_decisions[0].reason,
                Reason::ContainerUnsupported
            );
            assert!(!analysis.route_decisions[0].offered);
            assert_eq!(analysis.candidates[0].id, "remux");
        }
    }
}
