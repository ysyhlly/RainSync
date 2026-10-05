//! One server-owned, explicitly requested upstream transcode recipe.
//!
//! This evidence describes request bounds, never measured encoder output.
//! Metadata comes only from the authenticated, bounded single-item GET. The
//! reservation owner must checkpoint every returned SID before `validate_route`.
use super::{PlaybackOptions, SourceConfig, upstream_common, upstream_headers};
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

pub const PROFILE_ID: &str = "avc_sdr_720p_v1";
pub const PROFILE_VERSION: u8 = 1;
pub const EMBY_PROFILE_ID: &str = "emby_avc_sdr_720p_rates_v2";
pub const EMBY_PROFILE_VERSION: u8 = 2;
pub const EMBY_AUDIO_RATES: [u32; 2] = [44_100, 48_000];
pub fn profile_identity(kind: &str) -> (u8, &'static str) {
    if kind == "emby" {
        (EMBY_PROFILE_VERSION, EMBY_PROFILE_ID)
    } else {
        (PROFILE_VERSION, PROFILE_ID)
    }
}
pub fn validate_profile_metadata(kind: &str, metadata: &UpstreamProfileMetadata) -> Result<()> {
    validate_metadata_proof(metadata)?;
    ensure!(matches!(kind, "emby" | "jellyfin"), "invalid_upstream_kind");
    ensure!(
        kind != "emby"
            || metadata
                .audio
                .as_ref()
                .is_none_or(|audio| EMBY_AUDIO_RATES.contains(&audio.sample_rate)),
        "upstream_profile_audio_rate_unsupported"
    );
    Ok(())
}
const MAX_STREAMS: usize = 64;
const MAX_RUNTIME_TICKS: u64 = 7 * 24 * 60 * 60 * 10_000_000;

/// Bounded, comparable proof for a purpose-separated encrypted choice binding.
/// Arbitrary item metadata, paths, URLs and credentials are deliberately absent.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UpstreamProfileMetadata {
    pub item_id: String,
    pub media_source_id: String,
    pub runtime_ticks: u64,
    pub video: UpstreamVideoMetadata,
    pub audio: Option<UpstreamAudioMetadata>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UpstreamVideoMetadata {
    pub index: u32,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: Option<f64>,
    pub bit_depth: Option<u32>,
    pub bit_rate: Option<u32>,
    pub profile: Option<String>,
    pub level: Option<f64>,
    pub range: String,
    pub color_transfer: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UpstreamAudioMetadata {
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub bit_rate: Option<u32>,
    pub profile: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UpstreamProfileEvidence {
    pub profile_id: String,
    pub profile_version: u8,
    pub video_codec: String,
    pub video_profile: String,
    pub video_range: String,
    pub max_width: u32,
    pub max_height: u32,
    pub max_frame_rate: u32,
    pub max_video_level: String,
    pub max_video_bit_rate: u32,
    pub audio: Option<UpstreamAudioEvidence>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UpstreamAudioEvidence {
    pub codec: String,
    pub max_channels: u32,
    pub requested_sample_rate: u32,
    pub max_bit_rate: u32,
}

/// Distinguish upstream-returned evidence from our explicit request. Neither
/// proves measured output. Kept in the encrypted playback grant and replayed.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UpstreamProfileRouteProvenance {
    pub schema_version: u8,
    pub semantics: String,
    pub frame_rate_field: String,
    pub provider_audio_sample_rate: Option<u32>,
    pub server_requested_audio_sample_rate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_audio_sample_rates: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_audio_sample_rate: Option<u32>,
}

pub struct UpstreamProfileRoute {
    pub url: reqwest::Url,
    pub media_source_id: String,
    pub audio_index: Option<u32>,
    pub evidence: UpstreamProfileEvidence,
    pub provenance: UpstreamProfileRouteProvenance,
}

pub fn evidence(kind: &str, metadata: &UpstreamProfileMetadata) -> UpstreamProfileEvidence {
    UpstreamProfileEvidence {
        profile_id: profile_identity(kind).1.into(),
        profile_version: profile_identity(kind).0,
        video_codec: "h264".into(),
        video_profile: "main".into(),
        video_range: "SDR".into(),
        max_width: 1280,
        max_height: 720,
        max_frame_rate: 30,
        max_video_level: "3.1".into(),
        max_video_bit_rate: 4_000_000,
        audio: metadata.audio.as_ref().map(|_| UpstreamAudioEvidence {
            codec: "aac".into(),
            max_channels: 2,
            requested_sample_rate: 48_000,
            max_bit_rate: 128_000,
        }),
    }
}

pub async fn metadata(
    kind: &str,
    config: &SourceConfig,
    item: &str,
    audio_index: Option<u32>,
    device_id: &str,
) -> Result<UpstreamProfileMetadata> {
    ensure!(matches!(kind, "jellyfin" | "emby"), "invalid_upstream_kind");
    let headers = upstream_headers(kind, config, device_id)
        .map_err(|_| anyhow::anyhow!("upstream_metadata_identity_invalid"))?;
    let value = upstream_common::item_metadata(config, item, &headers).await?;
    let metadata = normalize_metadata(&value, item, audio_index)?;
    validate_profile_metadata(kind, &metadata)?;
    Ok(metadata)
}

fn text(value: &Value, key: &str, required: bool) -> Result<Option<String>> {
    match value.get(key) {
        None | Some(Value::Null) if !required => Ok(None),
        Some(Value::String(text))
            if !text.is_empty()
                && text.len() <= 64
                && text.trim() == text
                && text.bytes().all(|b| {
                    b.is_ascii_alphanumeric() || matches!(b, b' ' | b'-' | b'_' | b'.')
                }) =>
        {
            Ok(Some(text.to_ascii_lowercase()))
        }
        _ => bail!("upstream_profile_metadata_invalid"),
    }
}

fn integer(value: &Value, key: &str, required: bool, max: u32) -> Result<Option<u32>> {
    match value.get(key) {
        None | Some(Value::Null) if !required => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|number| *number > 0 && *number <= u64::from(max))
            .map(|number| Some(number as u32))
            .ok_or_else(|| anyhow::anyhow!("upstream_profile_metadata_invalid")),
        _ => bail!("upstream_profile_metadata_invalid"),
    }
}

fn number(value: &Value, key: &str, max: f64) -> Result<Option<f64>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .filter(|number| number.is_finite() && *number > 0.0 && *number <= max)
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("upstream_profile_metadata_invalid")),
    }
}

fn index(value: &Value) -> Result<u32> {
    value["Index"]
        .as_u64()
        .filter(|index| *index <= i32::MAX as u64)
        .map(|index| index as u32)
        .ok_or_else(|| anyhow::anyhow!("upstream_profile_metadata_invalid"))
}

pub fn normalize_metadata(
    value: &Value,
    item: &str,
    audio_index: Option<u32>,
) -> Result<UpstreamProfileMetadata> {
    ensure!(
        upstream_common::valid_source_id(item),
        "upstream_profile_metadata_invalid"
    );
    ensure!(value["Id"].as_str() == Some(item), "upstream_item_mismatch");
    let sources = value["MediaSources"]
        .as_array()
        .filter(|sources| sources.len() == 1)
        .ok_or_else(|| anyhow::anyhow!("upstream_profile_source_ambiguous"))?;
    let source = &sources[0];
    let media_source_id = source["Id"]
        .as_str()
        .filter(|id| upstream_common::valid_source_id(id))
        .ok_or_else(|| anyhow::anyhow!("upstream_profile_metadata_invalid"))?;
    ensure!(
        source["SupportsTranscoding"] == true,
        "upstream_profile_transcode_unavailable"
    );
    ensure!(
        source["IsInfiniteStream"] == false,
        "upstream_profile_stream_not_finite"
    );
    for key in ["RequiresOpening", "RequiresClosing", "RequiresLooping"] {
        ensure!(
            matches!(
                source.get(key),
                None | Some(Value::Null) | Some(Value::Bool(false))
            ),
            "upstream_profile_stream_not_finite"
        );
    }
    ensure!(
        matches!(source.get("LiveStreamId"), None | Some(Value::Null))
            || source["LiveStreamId"] == "",
        "upstream_profile_stream_not_finite"
    );
    let runtime_ticks = source["RunTimeTicks"]
        .as_u64()
        .filter(|ticks| *ticks > 0 && *ticks <= MAX_RUNTIME_TICKS)
        .ok_or_else(|| anyhow::anyhow!("upstream_profile_stream_not_finite"))?;
    let streams = source["MediaStreams"]
        .as_array()
        .filter(|streams| !streams.is_empty() && streams.len() <= MAX_STREAMS)
        .ok_or_else(|| anyhow::anyhow!("upstream_profile_metadata_invalid"))?;
    let mut indices = HashSet::new();
    for stream in streams {
        ensure!(
            stream.is_object() && indices.insert(index(stream)?),
            "upstream_profile_stream_ambiguous"
        );
    }
    let videos: Vec<_> = streams
        .iter()
        .filter(|stream| stream["Type"] == "Video")
        .collect();
    ensure!(videos.len() == 1, "upstream_profile_stream_ambiguous");
    let video = videos[0];
    ensure!(
        video.get("IsExternal").is_none_or(|v| *v == false),
        "upstream_profile_stream_ambiguous"
    );
    let ranges = [
        text(video, "VideoRange", false)?,
        text(video, "VideoRangeType", false)?,
    ];
    ensure!(
        ranges.iter().flatten().next().is_some(),
        "upstream_profile_range_unknown"
    );
    ensure!(
        ranges.iter().flatten().all(|range| range == "sdr"),
        "upstream_profile_range_unsupported"
    );
    if let Some(extended) = text(video, "ExtendedVideoType", false)? {
        ensure!(extended == "none", "upstream_profile_range_unsupported");
    }
    let color_transfer = text(video, "ColorTransfer", false)?;
    ensure!(
        color_transfer
            .as_deref()
            .is_none_or(|transfer| !matches!(transfer, "smpte2084" | "arib-std-b67" | "smpte428")),
        "upstream_profile_range_unsupported"
    );
    let video = UpstreamVideoMetadata {
        index: index(video)?,
        codec: text(video, "Codec", true)?.unwrap(),
        width: integer(video, "Width", true, 32_768)?.unwrap(),
        height: integer(video, "Height", true, 32_768)?.unwrap(),
        frame_rate: number(video, "AverageFrameRate", 240.0)?.or(number(
            video,
            "RealFrameRate",
            240.0,
        )?),
        bit_depth: integer(video, "BitDepth", false, 16)?,
        bit_rate: integer(video, "BitRate", false, i32::MAX as u32)?,
        profile: text(video, "Profile", false)?,
        level: number(video, "Level", 1024.0)?,
        range: "SDR".into(),
        color_transfer,
    };
    let audios: Vec<_> = streams
        .iter()
        .filter(|stream| stream["Type"] == "Audio")
        .collect();
    if audios.is_empty() {
        ensure!(
            source
                .get("DefaultAudioStreamIndex")
                .is_none_or(Value::is_null),
            "upstream_profile_audio_ambiguous"
        );
    }
    let selected = match audio_index {
        Some(requested) => {
            ensure!(
                requested <= i32::MAX as u32,
                "upstream_profile_audio_invalid"
            );
            Some(requested)
        }
        None if audios.is_empty() => None,
        None => match source.get("DefaultAudioStreamIndex") {
            Some(Value::Number(value)) => Some(
                value
                    .as_u64()
                    .filter(|v| *v <= i32::MAX as u64)
                    .ok_or_else(|| anyhow::anyhow!("upstream_profile_audio_ambiguous"))?
                    as u32,
            ),
            None | Some(Value::Null) if audios.len() == 1 => Some(index(audios[0])?),
            _ => bail!("upstream_profile_audio_ambiguous"),
        },
    };
    let audio = selected
        .map(|selected| -> Result<UpstreamAudioMetadata> {
            let stream = audios
                .iter()
                .find(|stream| index(stream).ok() == Some(selected))
                .ok_or_else(|| anyhow::anyhow!("upstream_profile_audio_invalid"))?;
            ensure!(
                stream.get("IsExternal").is_none_or(|v| *v == false),
                "upstream_profile_audio_invalid"
            );
            Ok(UpstreamAudioMetadata {
                index: selected,
                codec: text(stream, "Codec", true)?.unwrap(),
                channels: integer(stream, "Channels", true, 64)?.unwrap(),
                sample_rate: integer(stream, "SampleRate", true, 768_000)?.unwrap(),
                bit_rate: integer(stream, "BitRate", false, i32::MAX as u32)?,
                profile: text(stream, "Profile", false)?,
            })
        })
        .transpose()?;
    Ok(UpstreamProfileMetadata {
        item_id: item.into(),
        media_source_id: media_source_id.into(),
        runtime_ticks,
        video,
        audio,
    })
}

pub(super) fn request(
    kind: &str,
    config: &SourceConfig,
    options: &PlaybackOptions,
    metadata: &UpstreamProfileMetadata,
) -> Result<Value> {
    ensure!(matches!(kind, "jellyfin" | "emby"), "invalid_upstream_kind");
    validate_profile_metadata(kind, metadata)?;
    ensure!(
        options.hls && options.force_transcode,
        "upstream_profile_explicit_transcode_required"
    );
    ensure!(
        options
            .media_source_id
            .as_deref()
            .is_none_or(|id| id == metadata.media_source_id)
            && options.audio_index.is_none_or(|index| metadata
                .audio
                .as_ref()
                .is_some_and(|audio| audio.index == index)),
        "upstream_profile_selection_mismatch"
    );
    let options = PlaybackOptions {
        progressive: false,
        audio_index: metadata.audio.as_ref().map(|audio| audio.index),
        media_source_id: Some(metadata.media_source_id.clone()),
        ..options.clone()
    };
    let mut body = upstream_common::playback_body(config, &options)?;
    body["EnableDirectPlay"] = json!(false);
    body["EnableDirectStream"] = json!(false);
    body["AllowVideoStreamCopy"] = json!(false);
    body["AllowAudioStreamCopy"] = json!(false);
    body["AllowInterlacedVideoStreamCopy"] = json!(false);
    body["MaxAudioChannels"] = json!(2);
    body["MaxStreamingBitrate"] = json!(4_128_000);
    let condition = |property: &str, comparison: &str, value: &str| {
        json!({
            "Property":property,"Condition":comparison,"Value":value,"IsRequired":true
        })
    };
    let mut video_conditions = vec![
        condition("Width", "LessThanEqual", "1280"),
        condition("Height", "LessThanEqual", "720"),
        condition("VideoFramerate", "LessThanEqual", "30"),
        condition("VideoBitrate", "LessThanEqual", "4000000"),
        condition("VideoLevel", "LessThanEqual", "31"),
        condition("VideoProfile", "Equals", "main"),
        condition("VideoBitDepth", "LessThanEqual", "8"),
    ];
    // Jellyfin renamed this condition; do not apply its spelling to Emby.
    video_conditions.push(condition(
        if kind == "jellyfin" {
            "VideoRangeType"
        } else {
            "VideoRange"
        },
        "Equals",
        "SDR",
    ));
    let mut transcoding = json!({
        "Container":"ts","Type":"Video","Protocol":"hls","VideoCodec":"h264",
        "AudioCodec":"aac","Context":"Streaming","MaxAudioChannels":"2",
        "EnableAudioVbrEncoding":false,"AllowInterlacedVideoStreamCopy":false
    });
    if kind == "emby" {
        transcoding["MaxWidth"] = json!(1280);
        transcoding["MaxHeight"] = json!(720);
    }
    body["DeviceProfile"] = json!({
        "Name":"RainSync explicit AVC SDR 720p v1",
        "MaxStreamingBitrate":4_128_000,
        "DirectPlayProfiles":[],
        "TranscodingProfiles":[transcoding],
        "SubtitleProfiles":[{"Format":"vtt","Method":"External"}],
        "CodecProfiles":[
            {"Type":"Video","Codec":"h264","Conditions":video_conditions},
            {"Type":"VideoAudio","Codec":"aac","Conditions":[
                condition("AudioChannels","LessThanEqual","2"),
                condition("AudioSampleRate","Equals","48000"),
                condition("AudioBitrate","LessThanEqual","128000")
            ]}
        ]
    });
    Ok(body)
}

fn route_query(url: &reqwest::Url) -> Result<BTreeMap<String, String>> {
    ensure!(
        url.as_str().len() <= 16_384 && url.fragment().is_none(),
        "upstream_profile_route_invalid"
    );
    let mut query = BTreeMap::new();
    for (name, value) in url.query_pairs() {
        ensure!(
            query.len() < 128
                && name.len() <= 128
                && value.len() <= 1024
                && query
                    .insert(name.to_ascii_lowercase(), value.into_owned())
                    .is_none(),
            "upstream_profile_route_ambiguous"
        );
    }
    Ok(query)
}

fn query_number(query: &BTreeMap<String, String>, key: &str, max: f64) -> Result<()> {
    let number = query
        .get(key)
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0 && *value <= max);
    ensure!(number.is_some(), "upstream_profile_route_bounds_missing");
    Ok(())
}

fn query_exact(query: &BTreeMap<String, String>, key: &str, expected: &str) -> Result<()> {
    ensure!(
        query
            .get(key)
            .is_some_and(|value| value.eq_ignore_ascii_case(expected)),
        "upstream_profile_route_mismatch"
    );
    Ok(())
}

fn item_master_path_matches(
    kind: &str,
    config: &SourceConfig,
    item: &str,
    url: &reqwest::Url,
) -> Result<bool> {
    let expected = upstream_common::profile_item_route(config, item)?;
    if url.path().eq_ignore_ascii_case(expected.path()) {
        return Ok(true);
    }
    // Jellyfin serializes metadata IDs as compact GUIDs but its HLS route uses
    // Guid's hyphenated format. Admit only these two exact GUID spellings, not
    // arbitrary hyphen removal, percent decoding or another item/base path.
    if kind != "jellyfin"
        || !((item.len() == 32 && item.bytes().all(|b| b.is_ascii_hexdigit()))
            || (item.len() == 36
                && item.bytes().enumerate().all(|(i, b)| {
                    if [8, 13, 18, 23].contains(&i) {
                        b == b'-'
                    } else {
                        b.is_ascii_hexdigit()
                    }
                })))
    {
        return Ok(false);
    }
    let compact = item.replace('-', "");
    let alternate = if item.len() == 36 {
        compact
    } else {
        format!(
            "{}-{}-{}-{}-{}",
            &compact[..8],
            &compact[8..12],
            &compact[12..16],
            &compact[16..20],
            &compact[20..]
        )
    };
    let expected = upstream_common::profile_item_route(config, &alternate)?;
    Ok(url.path().eq_ignore_ascii_case(expected.path()))
}

/// Encrypted bindings can outlive this parser invocation. Check their bounded
/// typed representation again before using it to build or admit a recipe.
pub fn validate_metadata_proof(metadata: &UpstreamProfileMetadata) -> Result<()> {
    ensure!(
        upstream_common::valid_source_id(&metadata.item_id)
            && upstream_common::valid_source_id(&metadata.media_source_id)
            && metadata.runtime_ticks > 0
            && metadata.runtime_ticks <= MAX_RUNTIME_TICKS
            && metadata.video.index <= i32::MAX as u32
            && (1..=32_768).contains(&metadata.video.width)
            && (1..=32_768).contains(&metadata.video.height)
            && metadata.video.range == "SDR"
            && metadata
                .video
                .frame_rate
                .is_none_or(|value| value.is_finite() && value > 0.0 && value <= 240.0)
            && metadata
                .video
                .level
                .is_none_or(|value| value.is_finite() && value > 0.0 && value <= 1024.0)
            && metadata
                .video
                .bit_depth
                .is_none_or(|value| (1..=16).contains(&value))
            && metadata
                .video
                .bit_rate
                .is_none_or(|value| (1..=i32::MAX as u32).contains(&value)),
        "upstream_profile_metadata_invalid"
    );
    let bounded_text = |value: &str| {
        !value.is_empty()
            && value.len() <= 64
            && value.trim() == value
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'-' | b'_' | b'.'))
    };
    ensure!(
        bounded_text(&metadata.video.codec)
            && metadata.video.profile.as_deref().is_none_or(bounded_text)
            && metadata
                .video
                .color_transfer
                .as_deref()
                .is_none_or(bounded_text),
        "upstream_profile_metadata_invalid"
    );
    if let Some(audio) = &metadata.audio {
        ensure!(
            audio.index <= i32::MAX as u32
                && audio.index != metadata.video.index
                && bounded_text(&audio.codec)
                && audio.profile.as_deref().is_none_or(bounded_text)
                && (1..=64).contains(&audio.channels)
                && (1..=768_000).contains(&audio.sample_rate)
                && audio
                    .bit_rate
                    .is_none_or(|value| (1..=i32::MAX as u32).contains(&value)),
            "upstream_profile_metadata_invalid"
        );
    }
    Ok(())
}

/// Validate original provider-returned configuration without fetching media or
/// changing its URL. Only an absent Emby audio sample rate may be completed by
/// complete_route after all original guards and owned device identity pass.
/// Call only after the SID is checkpointed.
pub fn validate_route(
    kind: &str,
    config: &SourceConfig,
    metadata: &UpstreamProfileMetadata,
    info: &Value,
) -> Result<UpstreamProfileRoute> {
    ensure!(matches!(kind, "jellyfin" | "emby"), "invalid_upstream_kind");
    validate_profile_metadata(kind, metadata)?;
    ensure!(
        info.get("ErrorCode").is_none_or(Value::is_null),
        "upstream_profile_route_unavailable"
    );
    let sid = info["PlaySessionId"]
        .as_str()
        .filter(|id| upstream_common::valid_source_id(id))
        .ok_or_else(|| anyhow::anyhow!("upstream_profile_route_unavailable"))?;
    let sources = info["MediaSources"]
        .as_array()
        .filter(|sources| sources.len() == 1)
        .ok_or_else(|| anyhow::anyhow!("upstream_profile_source_ambiguous"))?;
    let source = &sources[0];
    ensure!(
        source["Id"].as_str() == Some(metadata.media_source_id.as_str()),
        "upstream_profile_selection_mismatch"
    );
    ensure!(
        source["SupportsTranscoding"] == true,
        "upstream_profile_route_unavailable"
    );
    ensure!(
        source["TranscodingSubProtocol"]
            .as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case("hls")),
        "upstream_profile_route_not_hls"
    );
    ensure!(
        source["TranscodingContainer"]
            .as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case("ts")),
        "upstream_profile_route_not_hls"
    );
    let path = source["TranscodingUrl"]
        .as_str()
        .filter(|path| !path.is_empty() && path.len() <= 16_384)
        .ok_or_else(|| anyhow::anyhow!("upstream_profile_route_unavailable"))?;
    // Configured origins may include a reverse-proxy directory without a final
    // slash. Resolve the same directory base used by ordinary media delivery.
    let base = super::validate_url(&format!("{}/", config.url.trim_end_matches('/')))
        .map_err(|_| anyhow::anyhow!("upstream_profile_route_invalid"))?;
    let url = super::upstream_url(&base, path)
        .map_err(|_| anyhow::anyhow!("upstream_profile_route_invalid"))?;
    // Only the negotiated master route for this exact item can describe this
    // recipe. Other same-origin routes are not compatible evidence.
    let segments: Vec<_> = url
        .path_segments()
        .ok_or_else(|| anyhow::anyhow!("upstream_profile_route_invalid"))?
        .collect();
    ensure!(
        segments.len() >= 3
            && segments[segments.len() - 3].eq_ignore_ascii_case("videos")
            && segments[segments.len() - 1].eq_ignore_ascii_case("master.m3u8"),
        "upstream_profile_route_not_hls"
    );
    ensure!(
        item_master_path_matches(kind, config, &metadata.item_id, &url)?,
        "upstream_profile_selection_mismatch"
    );
    let query = route_query(&url)?;
    ensure!(
        query.get("mediasourceid").map(String::as_str) == Some(metadata.media_source_id.as_str())
            && query.get("playsessionid").map(String::as_str) == Some(sid),
        "upstream_profile_selection_mismatch"
    );
    if let Some(index) = query.get("videostreamindex") {
        ensure!(
            index == &metadata.video.index.to_string(),
            "upstream_profile_selection_mismatch"
        );
    }
    // Jellyfin may repeat its sole selected codec in a comma-separated list.
    ensure!(
        query.get("videocodec").is_some_and(|value| {
            let values: Vec<_> = value.split(',').collect();
            !values.is_empty()
                && values.len() <= 4
                && values
                    .iter()
                    .all(|value| value.eq_ignore_ascii_case("h264"))
        }),
        "upstream_profile_route_mismatch"
    );
    query_exact(&query, "allowvideostreamcopy", "false")?;
    query_exact(&query, "allowaudiostreamcopy", "false")?;
    for key in [
        "static",
        "enableautostreamcopy",
        "allowinterlacedvideostreamcopy",
    ] {
        if query.contains_key(key) {
            query_exact(&query, key, "false")?;
        }
    }
    query_number(&query, "maxwidth", 1280.0)?;
    query_number(&query, "maxheight", 720.0)?;
    let frame_rate_field = if kind == "emby" && query.contains_key("h264-maxframerate") {
        ensure!(
            !query.contains_key("maxframerate"),
            "upstream_profile_route_ambiguous"
        );
        query_number(&query, "h264-maxframerate", 30.0)?;
        "h264-maxframerate"
    } else {
        ensure!(
            !query.contains_key("h264-maxframerate"),
            "upstream_profile_route_ambiguous"
        );
        query_number(&query, "maxframerate", 30.0)?;
        "maxframerate"
    };
    ensure!(
        !query.contains_key("h264-framerate"),
        "upstream_profile_route_ambiguous"
    );
    if let Some(fixed) = query.get("framerate") {
        let fixed = fixed.parse::<f64>().ok();
        let ceiling = query
            .get(frame_rate_field)
            .and_then(|value| value.parse::<f64>().ok());
        ensure!(
            fixed
                .zip(ceiling)
                .is_some_and(|(fixed, ceiling)| fixed.is_finite()
                    && fixed > 0.0
                    && fixed <= ceiling),
            "upstream_profile_route_mismatch"
        );
    }
    query_number(&query, "videobitrate", 4_000_000.0)?;
    for (key, max) in [("width", 1280.0), ("height", 720.0), ("framerate", 30.0)] {
        if query.contains_key(key) {
            query_number(&query, key, max)?;
        }
    }
    // Version-specific namespaces are validated independently. A missing value
    // stays unsupported; it is never added to the returned URL by RainSync.
    if kind == "jellyfin" {
        ensure!(
            !query.contains_key("level")
                && !query.contains_key("profile")
                && !query.contains_key("videorange"),
            "upstream_profile_route_ambiguous"
        );
        query_number(&query, "h264-level", 31.0)?;
        query_exact(&query, "h264-profile", "main")?;
        query_exact(&query, "h264-rangetype", "SDR")?;
    } else {
        ensure!(
            !(query.contains_key("h264-level") && query.contains_key("level"))
                && !(query.contains_key("h264-profile") && query.contains_key("profile"))
                && !(query.contains_key("h264-videorange") && query.contains_key("videorange")),
            "upstream_profile_route_ambiguous"
        );
        let level = if query.contains_key("h264-level") {
            "h264-level"
        } else {
            "level"
        };
        query_number(&query, level, if level == "level" { 3.1 } else { 31.0 })?;
        let profile = if query.contains_key("h264-profile") {
            "h264-profile"
        } else {
            "profile"
        };
        query_exact(&query, profile, "main")?;
        // Emby's official API documents VideoRange but fixed-product route
        // propagation must establish its own range evidence before admission.
        let range = if query.contains_key("h264-videorange") {
            "h264-videorange"
        } else {
            "videorange"
        };
        query_exact(&query, range, "SDR")?;
    }
    let audio_index = metadata.audio.as_ref().map(|audio| audio.index);
    let mut provider_audio_sample_rate = None;
    let mut server_requested_audio_sample_rate = None;
    if let Some(audio) = &metadata.audio {
        ensure!(
            source["DefaultAudioStreamIndex"].as_u64() == Some(u64::from(audio.index)),
            "upstream_profile_selection_mismatch"
        );
        query_exact(&query, "audiostreamindex", &audio.index.to_string())?;
        query_exact(&query, "audiocodec", "aac")?;
        query_number(&query, "audiobitrate", 128_000.0)?;
        // An explicit contradictory value cannot be silently overwritten.
        // Codec-prefixed or alternative sample-rate knobs are not this contract.
        ensure!(
            !query
                .keys()
                .any(|key| key != "audiosamplerate" && key.contains("samplerate")),
            "upstream_profile_route_ambiguous"
        );
        if kind == "emby" && !query.contains_key("audiosamplerate") {
            server_requested_audio_sample_rate = Some(48_000);
        } else {
            let rate = query
                .get("audiosamplerate")
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|rate| {
                    if kind == "emby" {
                        EMBY_AUDIO_RATES.contains(rate)
                    } else {
                        *rate == 48_000
                    }
                })
                .ok_or_else(|| anyhow::anyhow!("upstream_profile_route_mismatch"))?;
            query_exact(&query, "audiosamplerate", &rate.to_string())?;
            provider_audio_sample_rate = Some(rate);
        }
        let channels = if query.contains_key("transcodingmaxaudiochannels") {
            "transcodingmaxaudiochannels"
        } else {
            "maxaudiochannels"
        };
        query_number(&query, channels, 2.0)?;
        for key in ["audiochannels", "aac-audiochannels"] {
            if query.contains_key(key) {
                query_number(&query, key, 2.0)?;
            }
        }
    } else {
        ensure!(
            !query.contains_key("audiostreamindex")
                && source
                    .get("DefaultAudioStreamIndex")
                    .is_none_or(Value::is_null)
                && source.get("MediaStreams").is_none_or(|streams| {
                    streams.as_array().is_some_and(|streams| {
                        !streams.iter().any(|stream| stream["Type"] == "Audio")
                    })
                }),
            "upstream_profile_selection_mismatch"
        );
    }
    if query.contains_key("subtitlestreamindex") {
        query_exact(&query, "subtitlestreamindex", "-1")?;
    }
    // Jellyfin 10.11 EncodingHelper.AttachMediaSourceInfo calls GetMediaStream
    // for subtitles with returnFirstIfNoIndex=false. Encode alone is therefore
    // an inert default when the route omits the index (or explicitly uses -1).
    // A selected, malformed or duplicate index still fails above/in route_query.
    // Do not assume the same omission semantics for other providers.
    ensure!(
        kind == "jellyfin"
            || !query
                .get("subtitlemethod")
                .is_some_and(|value| value.eq_ignore_ascii_case("encode")),
        "upstream_profile_route_mismatch"
    );
    Ok(UpstreamProfileRoute {
        url,
        media_source_id: metadata.media_source_id.clone(),
        audio_index,
        evidence: evidence(kind, metadata),
        provenance: UpstreamProfileRouteProvenance {
            schema_version: if kind == "emby" { 2 } else { 1 },
            semantics: "requested_configuration_not_measured_output".into(),
            frame_rate_field: frame_rate_field.into(),
            provider_audio_sample_rate,
            server_requested_audio_sample_rate,
            allowed_audio_sample_rates: (kind == "emby" && metadata.audio.is_some())
                .then(|| EMBY_AUDIO_RATES.to_vec()),
            source_audio_sample_rate: if kind == "emby" {
                metadata.audio.as_ref().map(|audio| audio.sample_rate)
            } else {
                None
            },
        },
    })
}

/// Complete only the documented missing AudioSampleRate on the original owned
/// Emby SID. A new PlaybackInfo request, route identity or recipe is never minted.
pub fn complete_route(
    kind: &str,
    config: &SourceConfig,
    metadata: &UpstreamProfileMetadata,
    info: &Value,
    device_id: &str,
) -> Result<UpstreamProfileRoute> {
    let mut route = validate_route(kind, config, metadata, info)?;
    let sid = info["PlaySessionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("upstream_profile_route_unavailable"))?;
    // Check any returned DeviceId before adding a configuration request. The
    // existing owned identity binder may supply only missing identity fields.
    route.url = super::bind_playback_identity(route.url, sid, device_id)?;
    if route.provenance.server_requested_audio_sample_rate == Some(48_000) {
        ensure!(
            kind == "emby" && metadata.audio.is_some(),
            "upstream_profile_route_mismatch"
        );
        let original = route.url.query().unwrap_or_default();
        route
            .url
            .set_query(Some(&format!("{original}&AudioSampleRate=48000")));
    }
    // Final length/count bounds still apply after owned identity/completion.
    let final_query = route_query(&route.url)?;
    if metadata.audio.is_some() {
        let rate = route
            .provenance
            .provider_audio_sample_rate
            .or(route.provenance.server_requested_audio_sample_rate)
            .ok_or_else(|| anyhow::anyhow!("upstream_profile_route_mismatch"))?;
        query_exact(&final_query, "audiosamplerate", &rate.to_string())?;
    }
    Ok(route)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn config() -> SourceConfig {
        serde_json::from_value(
            json!({"url":"https://media.example/emby/","user_id":"viewer","token":"private-token"}),
        )
        .unwrap()
    }

    fn item() -> Value {
        json!({"Id":"item","Path":"/private/movie.mkv","MediaSources":[{
            "Id":"source","Path":"/private/movie.mkv","RunTimeTicks":900_000_000,
            "SupportsTranscoding":true,"IsInfiniteStream":false,"RequiresOpening":false,
            "RequiresLooping":false,"LiveStreamId":null,
            "DefaultAudioStreamIndex":1,
            "MediaStreams":[
                {"Index":0,"Type":"Video","Codec":"hevc","Width":1920,"Height":1080,
                    "AverageFrameRate":59.94,"BitDepth":8,"BitRate":6_000_000,"Profile":"Main","Level":120,"VideoRange":"SDR"},
                {"Index":1,"Type":"Audio","Codec":"ac3","Channels":6,"SampleRate":48000,"BitRate":640000,"Profile":"Dolby Digital"},
                {"Index":2,"Type":"Audio","Codec":"aac","Channels":2,"SampleRate":44100,"BitRate":192000,"Profile":"LC"}
            ]
        }]})
    }

    fn proof() -> UpstreamProfileMetadata {
        normalize_metadata(&item(), "item", None).unwrap()
    }

    fn options() -> PlaybackOptions {
        PlaybackOptions {
            position_ms: 12_345.6,
            audio_index: None,
            media_source_id: None,
            progressive: false,
            hls: true,
            force_transcode: true,
        }
    }

    fn reply(kind: &str) -> Value {
        let extra = if kind == "jellyfin" {
            "h264-level=31&h264-profile=main&h264-rangetype=SDR"
        } else {
            "h264-level=31&h264-profile=main&h264-videorange=SDR"
        };
        let route = format!(
            "Videos/item/master.m3u8?MediaSourceId=source&PlaySessionId=owned-sid&VideoCodec=h264&AudioCodec=aac&AudioStreamIndex=1&VideoBitrate=4000000&AudioBitrate=128000&AudioSampleRate=48000&TranscodingMaxAudioChannels=2&MaxWidth=1280&MaxHeight=720&MaxFramerate=30&{extra}&allowVideoStreamCopy=false&allowAudioStreamCopy=false"
        );
        json!({"PlaySessionId":"owned-sid","MediaSources":[{"Id":"source","SupportsTranscoding":true,
            "DefaultAudioStreamIndex":1,"TranscodingSubProtocol":"hls","TranscodingContainer":"ts","TranscodingUrl":route}]})
    }

    #[test]
    fn metadata_proof_is_bounded_comparable_and_contains_only_selected_facts() {
        let proof = proof();
        assert_eq!(proof.media_source_id, "source");
        assert_eq!(proof.audio.as_ref().unwrap().index, 1);
        assert_eq!(
            normalize_metadata(&item(), "item", Some(2))
                .unwrap()
                .audio
                .unwrap()
                .index,
            2
        );
        let encoded = serde_json::to_string(&proof).unwrap();
        assert!(
            !encoded.contains("private") && !encoded.contains("Path") && !encoded.contains("token")
        );
        assert_eq!(
            serde_json::from_str::<UpstreamProfileMetadata>(&encoded).unwrap(),
            proof
        );
        let mut changed = item();
        changed["MediaSources"][0]["MediaStreams"][0]["Width"] = json!(1280);
        assert_ne!(normalize_metadata(&changed, "item", None).unwrap(), proof);
    }

    #[test]
    fn metadata_rejects_ambiguous_unknown_live_hdr_and_invalid_identities() {
        for (pointer, value) in [
            ("/Id", json!("other")),
            ("/MediaSources/0/Id", json!("source\nsecret")),
            ("/MediaSources/0/IsInfiniteStream", Value::Null),
            ("/MediaSources/0/IsInfiniteStream", json!(true)),
            ("/MediaSources/0/RequiresOpening", json!(true)),
            ("/MediaSources/0/RequiresLooping", json!(true)),
            ("/MediaSources/0/LiveStreamId", json!("live")),
            ("/MediaSources/0/RunTimeTicks", json!(0)),
            ("/MediaSources/0/SupportsTranscoding", json!(false)),
            ("/MediaSources/0/DefaultAudioStreamIndex", json!(9)),
            ("/MediaSources/0/DefaultAudioStreamIndex", Value::Null),
            ("/MediaSources/0/MediaStreams/0/VideoRange", json!("HDR")),
            ("/MediaSources/0/MediaStreams/0/VideoRange", Value::Null),
            ("/MediaSources/0/MediaStreams/0/Width", json!("1920")),
            ("/MediaSources/0/MediaStreams/0/AverageFrameRate", json!(0)),
            ("/MediaSources/0/MediaStreams/1/SampleRate", json!(0)),
            ("/MediaSources/0/MediaStreams/2/Index", json!(1)),
        ] {
            let mut metadata = item();
            *metadata.pointer_mut(pointer).unwrap() = value;
            assert!(
                normalize_metadata(&metadata, "item", None).is_err(),
                "{pointer}"
            );
        }
        let mut metadata = item();
        metadata["MediaSources"][0]["MediaStreams"][0]["VideoRangeType"] = json!("HDR10");
        assert!(normalize_metadata(&metadata, "item", None).is_err());
        metadata = item();
        metadata["MediaSources"][0]["MediaStreams"][0]["ColorTransfer"] = json!("smpte2084");
        assert!(normalize_metadata(&metadata, "item", None).is_err());
        let mut malformed = proof();
        malformed.video.frame_rate = Some(f64::NAN);
        assert!(validate_metadata_proof(&malformed).is_err());
        assert!(normalize_metadata(&item(), "item", Some(u32::MAX)).is_err());
    }

    #[test]
    fn single_audio_default_and_video_only_are_explicit() {
        let mut metadata = item();
        let streams = metadata["MediaSources"][0]["MediaStreams"]
            .as_array_mut()
            .unwrap();
        streams.pop();
        metadata["MediaSources"][0]
            .as_object_mut()
            .unwrap()
            .remove("DefaultAudioStreamIndex");
        assert_eq!(
            normalize_metadata(&metadata, "item", None)
                .unwrap()
                .audio
                .unwrap()
                .index,
            1
        );
        metadata["MediaSources"][0]["MediaStreams"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert!(
            normalize_metadata(&metadata, "item", None)
                .unwrap()
                .audio
                .is_none()
        );
        metadata["MediaSources"][0]["DefaultAudioStreamIndex"] = json!(0);
        assert!(normalize_metadata(&metadata, "item", None).is_err());
    }

    #[test]
    fn known_silent_profile_rejects_new_audio_evidence_in_the_returned_route() {
        for kind in ["jellyfin", "emby"] {
            let mut metadata = proof();
            metadata.audio = None;
            let mut info = reply(kind);
            info["MediaSources"][0]["DefaultAudioStreamIndex"] = Value::Null;
            let path = info["MediaSources"][0]["TranscodingUrl"]
                .as_str()
                .unwrap()
                .replace("&AudioStreamIndex=1", "");
            info["MediaSources"][0]["TranscodingUrl"] = json!(path);
            assert!(validate_route(kind, &config(), &metadata, &info).is_ok());
            info["MediaSources"][0]["DefaultAudioStreamIndex"] = json!(0);
            assert!(validate_route(kind, &config(), &metadata, &info).is_err());
            info["MediaSources"][0]["DefaultAudioStreamIndex"] = Value::Null;
            info["MediaSources"][0]["MediaStreams"] = json!([{"Type":"Audio","Index":0}]);
            assert!(validate_route(kind, &config(), &metadata, &info).is_err());
        }
    }

    #[test]
    fn each_product_requests_full_recipe_and_disables_every_copy_or_direct_path() {
        for kind in ["jellyfin", "emby"] {
            let body = request(kind, &config(), &options(), &proof()).unwrap();
            for key in [
                "EnableDirectPlay",
                "EnableDirectStream",
                "AllowVideoStreamCopy",
                "AllowAudioStreamCopy",
                "AllowInterlacedVideoStreamCopy",
            ] {
                assert_eq!(body[key], false);
            }
            assert_eq!(body["EnableTranscoding"], true);
            assert_eq!(body["MediaSourceId"], "source");
            assert_eq!(body["AudioStreamIndex"], 1);
            assert_eq!(body["StartTimeTicks"], 123_456_000);
            assert_eq!(body["DeviceProfile"]["DirectPlayProfiles"], json!([]));
            let conditions = body["DeviceProfile"]["CodecProfiles"][0]["Conditions"]
                .as_array()
                .unwrap();
            assert!(conditions.iter().any(|condition| condition["Property"]
                == if kind == "jellyfin" {
                    "VideoRangeType"
                } else {
                    "VideoRange"
                }));
            assert!(!body.to_string().contains("AudioProfile"));
            assert_eq!(
                body["DeviceProfile"]["TranscodingProfiles"][0]["EnableAudioVbrEncoding"],
                false
            );
        }
        let automatic = PlaybackOptions {
            force_transcode: false,
            ..options()
        };
        assert!(request("jellyfin", &config(), &automatic, &proof()).is_err());
        let changed = PlaybackOptions {
            audio_index: Some(2),
            ..options()
        };
        assert!(request("emby", &config(), &changed, &proof()).is_err());
        let bounds = evidence("jellyfin", &proof());
        assert_eq!(bounds.max_width, 1280);
        assert_eq!(bounds.max_video_bit_rate, 4_000_000);
        assert_eq!(bounds.audio.unwrap().requested_sample_rate, 48_000);
    }

    #[test]
    fn route_resolution_preserves_configured_base_with_or_without_trailing_slash() {
        for kind in ["jellyfin", "emby"] {
            for base in [
                "https://example.test/proxy/emby",
                "https://example.test/proxy/emby/",
            ] {
                let config = SourceConfig {
                    url: base.into(),
                    ..config()
                };
                let route = validate_route(kind, &config, &proof(), &reply(kind)).unwrap();
                assert_eq!(route.url.path(), "/proxy/emby/Videos/item/master.m3u8");
                let mut other_origin = reply(kind);
                other_origin["MediaSources"][0]["TranscodingUrl"] =
                    json!("https://other.test/proxy/emby/Videos/item/master.m3u8");
                assert!(validate_route(kind, &config, &proof(), &other_origin).is_err());
            }
        }
    }

    #[test]
    fn route_validation_requires_complete_provider_evidence_and_exact_selection() {
        for kind in ["jellyfin", "emby"] {
            let good = reply(kind);
            let route = validate_route(kind, &config(), &proof(), &good).unwrap();
            assert_eq!(route.audio_index, Some(1));
            assert_eq!(route.media_source_id, "source");
            assert_eq!(route.evidence.profile_id, profile_identity(kind).1);
            for (before, after) in [
                ("MaxWidth=1280", "MaxWidth=1920"),
                ("MaxHeight=720", "MaxHeight=1080"),
                ("MaxFramerate=30", "MaxFramerate=60"),
                ("VideoBitrate=4000000", "VideoBitrate=5000000"),
                ("AudioBitrate=128000", "AudioBitrate=256000"),
                ("AudioSampleRate=48000", "AudioSampleRate=32000"),
                ("AudioStreamIndex=1", "AudioStreamIndex=2"),
                ("allowVideoStreamCopy=false", "allowVideoStreamCopy=true"),
                ("allowAudioStreamCopy=false", "allowAudioStreamCopy=true"),
                ("MediaSourceId=source", "MediaSourceId=other"),
                ("PlaySessionId=owned-sid", "PlaySessionId=other"),
                ("MaxWidth=1280&", ""),
                ("master.m3u8", "stream.mp4"),
                ("Videos/item/", "Videos/other/"),
            ] {
                let mut bad = good.clone();
                bad["MediaSources"][0]["TranscodingUrl"] = json!(
                    good["MediaSources"][0]["TranscodingUrl"]
                        .as_str()
                        .unwrap()
                        .replace(before, after)
                );
                assert!(
                    validate_route(kind, &config(), &proof(), &bad).is_err(),
                    "{kind}: {before}"
                );
            }
            for suffix in [
                "&MAXWIDTH=1280",
                "&VideoCodec=copy",
                "&static=true",
                "&Width=1920",
                "&SubtitleMethod=Encode&SubtitleStreamIndex=0",
            ] {
                let mut bad = good.clone();
                bad["MediaSources"][0]["TranscodingUrl"] = json!(format!(
                    "{}{suffix}",
                    good["MediaSources"][0]["TranscodingUrl"].as_str().unwrap()
                ));
                assert!(
                    validate_route(kind, &config(), &proof(), &bad).is_err(),
                    "{kind}: {suffix}"
                );
            }
            let mut bad = good.clone();
            bad["MediaSources"][0]["TranscodingUrl"] =
                json!("https://evil.example/private?api_key=secret");
            let error = validate_route(kind, &config(), &proof(), &bad)
                .err()
                .unwrap()
                .to_string();
            assert!(!error.contains("evil") && !error.contains("secret"));
        }
    }

    #[test]
    fn jellyfin_guid_route_spelling_preserves_exact_item_base_and_returned_url() {
        let compact = "1234567890abcdef1234567890abcdef";
        let hyphenated = "12345678-90ab-cdef-1234-567890abcdef";
        for (item, route_item) in [(compact, hyphenated), (hyphenated, compact)] {
            let mut metadata = proof();
            metadata.item_id = item.into();
            for base in [
                "https://example.test/proxy/jellyfin",
                "https://example.test/proxy/jellyfin/",
            ] {
                let config = SourceConfig {
                    url: base.into(),
                    ..config()
                };
                let mut info = reply("jellyfin");
                let path = info["MediaSources"][0]["TranscodingUrl"]
                    .as_str()
                    .unwrap()
                    .replace("Videos/item/", &format!("Videos/{route_item}/"));
                info["MediaSources"][0]["TranscodingUrl"] = json!(path);
                let route = validate_route("jellyfin", &config, &metadata, &info).unwrap();
                assert_eq!(
                    route.url.path(),
                    format!("/proxy/jellyfin/Videos/{route_item}/master.m3u8")
                );
                assert_eq!(
                    route.url.query(),
                    path.split_once('?').map(|(_, query)| query)
                );
                assert!(validate_route("emby", &config, &metadata, &info).is_err());
                for bad in [
                    "12345678-90ab-cdef-1234-567890abcdee", // different GUID
                    "1234-567890ab-cdef-1234-567890abcdef", // misplaced hyphens
                    "{12345678-90ab-cdef-1234-567890abcdef}",
                    "urn:uuid:12345678-90ab-cdef-1234-567890abcdef",
                    "%31%32%33%34%35%36%37%38-90ab-cdef-1234-567890abcdef",
                    "12345678-90ab-cdef-1234-567890abcdef/extra",
                ] {
                    info["MediaSources"][0]["TranscodingUrl"] =
                        json!(path.replace(route_item, bad));
                    assert!(
                        validate_route("jellyfin", &config, &metadata, &info).is_err(),
                        "{bad}"
                    );
                }
                for bad_base in [
                    "https://other.test/proxy/jellyfin",
                    "https://example.test/other",
                ] {
                    info["MediaSources"][0]["TranscodingUrl"] = json!(format!("{bad_base}/{path}"));
                    assert!(validate_route("jellyfin", &config, &metadata, &info).is_err());
                }
            }
        }
        let mut metadata = proof();
        metadata.item_id = "not-a-guid".into();
        let mut info = reply("jellyfin");
        info["MediaSources"][0]["TranscodingUrl"] = json!(
            info["MediaSources"][0]["TranscodingUrl"]
                .as_str()
                .unwrap()
                .replace("Videos/item/", "Videos/notaguid/")
        );
        assert!(validate_route("jellyfin", &config(), &metadata, &info).is_err());
    }

    #[test]
    fn jellyfin_encode_default_requires_no_selected_or_ambiguous_subtitle() {
        for kind in ["jellyfin", "emby"] {
            let good = reply(kind);
            let path = good["MediaSources"][0]["TranscodingUrl"].as_str().unwrap();
            for index in ["", "&SubtitleStreamIndex=-1"] {
                let mut info = good.clone();
                let returned = format!("{path}&SubtitleMethod=Encode{index}");
                info["MediaSources"][0]["TranscodingUrl"] = json!(returned);
                let result = validate_route(kind, &config(), &proof(), &info);
                assert_eq!(result.is_ok(), kind == "jellyfin");
                if let Ok(route) = result {
                    assert_eq!(
                        route.url.query(),
                        returned.split_once('?').map(|(_, query)| query)
                    );
                }
            }
            for index in ["0", "2", "", "null", "-2", "-1&SUBTITLESTREAMINDEX=0"] {
                for method in ["", "&SubtitleMethod=Encode", "&SubtitleMethod=External"] {
                    let mut info = good.clone();
                    info["MediaSources"][0]["TranscodingUrl"] =
                        json!(format!("{path}&SubtitleStreamIndex={index}{method}"));
                    assert!(
                        validate_route(kind, &config(), &proof(), &info).is_err(),
                        "{kind}: {index}{method}"
                    );
                }
            }
            let mut info = good.clone();
            info["MediaSources"][0]["TranscodingUrl"] = json!(format!(
                "{path}&SubtitleMethod=Encode&subtitlemethod=External"
            ));
            assert!(validate_route(kind, &config(), &proof(), &info).is_err());
        }
    }

    #[test]
    fn missing_fields_remain_distinct_from_owned_request_completion() {
        let mut metadata = proof();
        metadata.video.frame_rate = Some(10.0);
        metadata.audio.as_mut().unwrap().sample_rate = 48_000;
        for kind in ["jellyfin", "emby"] {
            let good = reply(kind);
            let path = good["MediaSources"][0]["TranscodingUrl"].as_str().unwrap();
            for (returned, emby_allowed) in [
                (path.replace("&MaxFramerate=30", ""), false),
                (path.replace("&AudioSampleRate=48000", ""), true),
                (
                    path.replace("&MaxFramerate=30", "&h264-maxframerate=30"),
                    true,
                ),
                (
                    path.replace("&AudioSampleRate=48000", "&aac-audiosamplerate=48000"),
                    false,
                ),
            ] {
                let mut info = good.clone();
                info["MediaSources"][0]["TranscodingUrl"] = json!(returned);
                assert_eq!(
                    validate_route(kind, &config(), &metadata, &info).is_ok(),
                    kind == "emby" && emby_allowed
                );
                assert_eq!(info["MediaSources"][0]["TranscodingUrl"], returned);
            }
        }
    }

    fn emby_missing_rate() -> Value {
        let mut info = reply("emby");
        let path = info["MediaSources"][0]["TranscodingUrl"]
            .as_str()
            .unwrap()
            .replace("&MaxFramerate=30", "&h264-maxframerate=30")
            .replace("&AudioSampleRate=48000", "");
        info["MediaSources"][0]["TranscodingUrl"] =
            json!(format!("{path}&DeviceId=owned-device&opaque=a%2fb%20c%2Bd"));
        info
    }

    #[test]
    fn emby_completion_changes_only_missing_sample_rate_and_keeps_provenance() {
        let info = emby_missing_rate();
        let original = info.clone();
        let observed = validate_route("emby", &config(), &proof(), &info).unwrap();
        assert_eq!(observed.provenance.provider_audio_sample_rate, None);
        assert_eq!(
            observed.provenance.server_requested_audio_sample_rate,
            Some(48_000)
        );
        assert_eq!(observed.provenance.frame_rate_field, "h264-maxframerate");
        assert!(!observed.url.query().unwrap().contains("AudioSampleRate"));
        let completed = complete_route("emby", &config(), &proof(), &info, "owned-device").unwrap();
        assert_eq!(
            completed.url.as_str(),
            format!("{}&AudioSampleRate=48000", observed.url)
        );
        assert_eq!(completed.provenance, observed.provenance);
        assert_eq!(info, original);
        let mut missing_device = info.clone();
        missing_device["MediaSources"][0]["TranscodingUrl"] = json!(
            info["MediaSources"][0]["TranscodingUrl"]
                .as_str()
                .unwrap()
                .replace("&DeviceId=owned-device", "")
        );
        let observed = validate_route("emby", &config(), &proof(), &missing_device).unwrap();
        let completed =
            complete_route("emby", &config(), &proof(), &missing_device, "owned-device").unwrap();
        assert_eq!(
            completed.url.as_str(),
            format!(
                "{}&DeviceId=owned-device&AudioSampleRate=48000",
                observed.url
            )
        );
        let echoed =
            complete_route("emby", &config(), &proof(), &reply("emby"), "owned-device").unwrap();
        assert_eq!(echoed.provenance.provider_audio_sample_rate, Some(48_000));
        assert_eq!(echoed.provenance.server_requested_audio_sample_rate, None);
        assert_eq!(
            echoed
                .url
                .query_pairs()
                .filter(|(key, _)| key.eq_ignore_ascii_case("audiosamplerate"))
                .count(),
            1
        );
    }

    #[test]
    fn emby_completion_rejects_conflicting_duplicate_and_original_guard_failures() {
        let good = emby_missing_rate();
        let path = good["MediaSources"][0]["TranscodingUrl"].as_str().unwrap();
        for route in [
            format!("{path}&AudioSampleRate=32000"),
            format!("{path}&AudioSampleRate=48000&AUDIOSAMPLERATE=48000"),
            format!("{path}&aac-audiosamplerate=48000"),
            format!("{path}&MaxFramerate=30"),
            format!("{path}&h264-framerate=60"),
            format!(
                "{}&Framerate=30",
                path.replace("h264-maxframerate=30", "h264-maxframerate=24")
            ),
            path.replace("h264-maxframerate=30", "h264-maxframerate=60"),
            path.replace("DeviceId=owned-device", "DeviceId=foreign-device"),
            path.replace("PlaySessionId=owned-sid", "PlaySessionId=foreign-sid"),
            path.replace("MediaSourceId=source", "MediaSourceId=other"),
            path.replace("AudioStreamIndex=1", "AudioStreamIndex=2"),
            path.replace("allowVideoStreamCopy=false", "allowVideoStreamCopy=true"),
            format!("{path}&SubtitleStreamIndex=0"),
            format!("{path}&SubtitleMethod=Encode"),
            format!("https://foreign.example/{path}"),
            format!("{path}#fragment"),
        ] {
            let mut info = good.clone();
            info["MediaSources"][0]["TranscodingUrl"] = json!(route);
            let before = info.clone();
            assert!(
                complete_route("emby", &config(), &proof(), &info, "owned-device").is_err(),
                "{route}"
            );
            assert_eq!(info, before);
        }
        assert!(complete_route("jellyfin", &config(), &proof(), &good, "owned-device").is_err());
    }

    #[test]
    fn completion_does_not_add_audio_to_known_silent_media() {
        let mut metadata = proof();
        metadata.audio = None;
        let mut info = emby_missing_rate();
        let route = info["MediaSources"][0]["TranscodingUrl"]
            .as_str()
            .unwrap()
            .replace("&AudioStreamIndex=1", "");
        info["MediaSources"][0]["TranscodingUrl"] = json!(route);
        info["MediaSources"][0]["DefaultAudioStreamIndex"] = Value::Null;
        let completed =
            complete_route("emby", &config(), &metadata, &info, "owned-device").unwrap();
        assert_eq!(
            completed.provenance.server_requested_audio_sample_rate,
            None
        );
        assert!(!completed.url.query().unwrap().contains("AudioSampleRate"));
    }

    #[test]
    fn completion_preserves_final_url_and_query_count_bounds() {
        let mut info = emby_missing_rate();
        let mut route = info["MediaSources"][0]["TranscodingUrl"]
            .as_str()
            .unwrap()
            .to_owned();
        let base = super::super::validate_url(&config().url).unwrap();
        while super::super::upstream_url(&base, &route)
            .unwrap()
            .as_str()
            .len()
            + 1010
            < 16380
        {
            route.push_str(&format!("&p{}={}", route.len(), "x".repeat(1000)));
        }
        let remaining = 16380
            - super::super::upstream_url(&base, &route)
                .unwrap()
                .as_str()
                .len()
            - 6;
        route.push_str(&format!("&last={}", "x".repeat(remaining)));
        info["MediaSources"][0]["TranscodingUrl"] = json!(route);
        assert!(validate_route("emby", &config(), &proof(), &info).is_ok());
        assert!(complete_route("emby", &config(), &proof(), &info, "owned-device").is_err());
        let mut info = emby_missing_rate();
        let mut route = info["MediaSources"][0]["TranscodingUrl"]
            .as_str()
            .unwrap()
            .to_owned();
        let count = super::super::upstream_url(&base, &route)
            .unwrap()
            .query_pairs()
            .count();
        for index in count..128 {
            route.push_str(&format!("&padding{index}=x"));
        }
        info["MediaSources"][0]["TranscodingUrl"] = json!(route);
        assert!(validate_route("emby", &config(), &proof(), &info).is_ok());
        assert!(complete_route("emby", &config(), &proof(), &info, "owned-device").is_err());
    }

    #[tokio::test]
    async fn metadata_uses_only_one_authenticated_bounded_get_and_sanitizes_failures() {
        for kind in ["jellyfin", "emby"] {
            for status in [200, 302, 401, 500] {
                let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let mut config = config();
                config.url = format!(
                    "http://{}/emby/?api_key=secret",
                    socket.local_addr().unwrap()
                );
                let body = item().to_string();
                let task = tokio::spawn(async move {
                    let (mut stream, _) = socket.accept().await.unwrap();
                    let mut bytes = [0; 4096];
                    let count = stream.read(&mut bytes).await.unwrap();
                    let request = String::from_utf8_lossy(&bytes[..count]).into_owned();
                    stream.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                    request
                });
                let result =
                    metadata(kind, &config, "item", None, "rainsync-profile-preflight").await;
                if status == 200 {
                    assert_eq!(result.unwrap(), proof());
                } else {
                    let error = result.unwrap_err().to_string();
                    assert_eq!(error, "upstream_metadata_status");
                    assert!(!error.contains("secret"));
                }
                let request = task.await.unwrap();
                assert!(request.starts_with("GET /emby/Users/viewer/Items/item HTTP/1.1"));
                assert!(!request.contains("api_key=secret") && !request.contains("PlaybackInfo"));
                assert!(request.contains("DeviceId=\"rainsync-profile-preflight\""));
            }
        }
    }
    #[test]
    fn emby_discrete_rates_preserve_codec_channel_guards_and_source_provenance() {
        for rate in EMBY_AUDIO_RATES {
            let mut metadata = proof();
            metadata.audio.as_mut().unwrap().sample_rate = rate;
            for codec in ["aac", "ac3"] {
                metadata.audio.as_mut().unwrap().codec = codec.into();
                metadata.audio.as_mut().unwrap().channels = 2;
                assert!(validate_profile_metadata("emby", &metadata).is_ok());
                let mut info = reply("emby");
                info["MediaSources"][0]["TranscodingUrl"] = json!(
                    info["MediaSources"][0]["TranscodingUrl"]
                        .as_str()
                        .unwrap()
                        .replace("AudioSampleRate=48000", &format!("AudioSampleRate={rate}"))
                );
                let route = validate_route("emby", &config(), &metadata, &info).unwrap();
                assert_eq!(
                    route.provenance.allowed_audio_sample_rates,
                    Some(EMBY_AUDIO_RATES.to_vec())
                );
                assert_eq!(route.provenance.source_audio_sample_rate, Some(rate));
                assert_eq!(route.provenance.provider_audio_sample_rate, Some(rate));
                assert_eq!(route.evidence.profile_version, 2);
                let completed =
                    complete_route("emby", &config(), &metadata, &info, "owned-device").unwrap();
                assert_eq!(completed.provenance.provider_audio_sample_rate, Some(rate));
                assert_eq!(
                    completed.provenance.server_requested_audio_sample_rate,
                    None
                );
            }
        }
        for rate in [0, 32_000, 96_000] {
            let mut metadata = proof();
            metadata.audio.as_mut().unwrap().sample_rate = rate;
            assert!(validate_profile_metadata("emby", &metadata).is_err());
            assert!(validate_route("emby", &config(), &metadata, &reply("emby")).is_err());
        }
    }
}
