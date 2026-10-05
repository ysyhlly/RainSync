//! Closed server-only descriptors. Rendering never copies platform manifests.
use super::*;
use providers::platform::bilibili::{AudioCodec, Playback, ResolvedVideo, VideoCodec, VideoTrack};
use serde::{Deserialize, Serialize};

pub(super) const MAX_MANIFEST_BYTES: usize = 128 * 1024;
pub(super) const UNKNOWN_URL_POLICY_MS: i64 = 120_000;
pub(super) const MAX_GRANT_MS: i64 = 1_800_000;
pub(super) const URL_EXPIRY_MARGIN_MS: i64 = 30_000;
const MAX_JS_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_METADATA_RANGE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_VIDEO_BANDWIDTH: u64 = 80_000_000;
const MAX_AUDIO_BANDWIDTH: u64 = 512_000;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Binding {
    pub version: u32,
    pub provider: String,
    pub media_id: Uuid,
    pub room_id: Uuid,
    pub user_id: Uuid,
    pub entry_revision: String,
    pub credential_mode: String,
    pub account_id: Option<Uuid>,
    pub account_revision: Option<String>,
    // Version 1 omits this field so existing encrypted grants round-trip exactly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<native_platform::PgcIdentity>,
}
impl Binding {
    pub fn matches_entry(&self, entry: &native_platform::Entry) -> bool {
        self.validate()
            && self.media_id == entry.media_id
            && self.room_id == entry.room_id
            && self.provider == entry.provider
            && self.entry_revision == entry.revision.to_string()
            && self.resource == entry.identity()
    }
    pub fn validate(&self) -> bool {
        ((self.version == 1 && self.resource.is_none())
            || (self.version == 2
                && self.provider == "bilibili"
                && self
                    .resource
                    .as_ref()
                    .is_some_and(|identity| identity.is_pgc() && identity.validate()))
            || (self.version == 4
                && self.provider == "bilibili"
                && self
                    .resource
                    .as_ref()
                    .is_some_and(|identity| identity.is_course() && identity.validate())))
            && matches!(
                self.provider.as_str(),
                "bilibili" | "douyin" | "tiktok" | "youtube"
            )
            && positive_decimal(&self.entry_revision)
            && match self.credential_mode.as_str() {
                "anonymous" => self.account_id.is_none() && self.account_revision.is_none(),
                "own_account" => {
                    matches!(
                        self.provider.as_str(),
                        "bilibili" | "douyin" | "tiktok" | "youtube"
                    ) && self.account_id.is_some()
                        && self
                            .account_revision
                            .as_deref()
                            .is_some_and(positive_decimal)
                }
                _ => false,
            }
    }
}
fn positive_decimal(value: &str) -> bool {
    !value.starts_with('0')
        && value.bytes().all(|c| c.is_ascii_digit())
        && value.parse::<i64>().is_ok_and(|v| v > 0)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Sealed {
    pub kind: String,
    pub version: u32,
    pub binding: Binding,
    pub resolved_at_ms: i64,
    pub url_expires_at_ms: Option<i64>,
    pub descriptor: Descriptor,
}
impl Sealed {
    pub fn policy_deadline_ms(&self) -> Result<i64> {
        if self.kind != "native_platform"
            || self.version != 1
            || !self.binding.validate()
            || self.resolved_at_ms <= 0
        {
            return Err(invalid_grant());
        }
        self.descriptor.validate_for(&self.binding.provider)?;
        if self.descriptor.compatibility_source.is_some()
            && ((!matches!(self.binding.provider.as_str(), "bilibili" | "youtube")
                || self.descriptor.compatibility_source
                    == Some(CompatibilitySource::ClearHevcMainV1)
                    && self.binding.provider != "bilibili")
                || self.binding.version != 1
                || self.binding.resource.is_some())
        {
            return Err(invalid_grant());
        }
        if self.url_expires_at_ms != self.descriptor.earliest_known_expiry_ms() {
            return Err(invalid_grant());
        }
        let deadline = policy_deadline(
            self.resolved_at_ms,
            self.url_expires_at_ms,
            self.descriptor.has_unknown_expiry(),
        )?;
        Ok(deadline)
    }
}

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Transport {
    #[default]
    Dash,
    Progressive,
}
fn is_dash(value: &Transport) -> bool {
    *value == Transport::Dash
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum CompatibilitySource {
    ClearHevcMainV1,
    ClearExtendedV1,
    ClearWebmV1,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Descriptor {
    // A source-custody label, never a browser codec or public output label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compatibility_source: Option<CompatibilitySource>,
    // Omit the legacy value so canonical decoding of pre-existing Bili grants
    // keeps its exact envelope. New progressive grants always declare it.
    #[serde(default, skip_serializing_if = "is_dash")]
    pub transport: Transport,
    pub duration_seconds: f64,
    pub min_buffer_seconds: f64,
    pub tracks: Vec<Track>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Track {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_webm: Option<media_core::advanced_media::WebmSourceExpectation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_video: Option<media_core::advanced_media::VideoSourceExpectation>,
    pub key: String,
    pub kind: String,
    pub url: String,
    pub observed_url_expires_at_ms: Option<i64>,
    pub codecs: String,
    pub mime_type: String,
    pub bandwidth: u64,
    pub start_with_sap: u32,
    pub index_start: u64,
    pub index_end: u64,
    pub initialization_start: u64,
    pub initialization_end: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<String>,
    pub sar: Option<String>,
    pub sampling_rate: Option<u32>,
    // Additive facts are omitted for legacy Bili grants. Their exact canonical
    // serialization remains unchanged after round-trip decoding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_content_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strong_etag: Option<String>,
}
impl Descriptor {
    pub fn bilibili_heights(resolved: &ResolvedVideo) -> Vec<u32> {
        match &resolved.playback {
            Playback::Dash(dash) => Self::bilibili_dash_heights(dash, resolved.current_quality),
            _ => vec![],
        }
    }
    pub fn from_resolved_with_max_height(
        resolved: &ResolvedVideo,
        max_height: Option<u32>,
    ) -> Result<(Self, Option<i64>)> {
        let Playback::Dash(dash) = &resolved.playback else {
            return Err(err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "native_platform_progressive_unsupported",
            ));
        };
        Self::from_bilibili_dash(dash, resolved.current_quality, max_height)
    }
    pub fn bilibili_dash_heights(dash: &bilibili::Dash, current_quality: u32) -> Vec<u32> {
        dash.video
            .iter()
            .filter(|track| compatible_bilibili_video(track, current_quality))
            .map(|track| track.height)
            .collect()
    }
    pub fn from_bilibili_dash(
        dash: &bilibili::Dash,
        current_quality: u32,
        max_height: Option<u32>,
    ) -> Result<(Self, Option<i64>)> {
        Self::from_bilibili_dash_selected(dash, current_quality, max_height, false)
    }
    /// A private provisional source. HEVC is not grant-valid until exact byte
    /// proofs populate both representation identities; never return it directly.
    pub fn bilibili_compatibility_candidate(
        resolved: &ResolvedVideo,
        max_height: Option<u32>,
    ) -> Result<(Self, Vec<u32>)> {
        let Playback::Dash(dash) = &resolved.playback else {
            return Err(err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "native_platform_progressive_unsupported",
            ));
        };
        let heights = dash
            .video
            .iter()
            .filter(|v| compatible_bilibili_source(v, resolved.current_quality))
            .map(|v| v.height)
            .collect();
        let (descriptor, _) =
            Self::from_bilibili_dash_selected(dash, resolved.current_quality, max_height, true)?;
        Ok((descriptor, heights))
    }
    fn from_bilibili_dash_selected(
        dash: &bilibili::Dash,
        current_quality: u32,
        max_height: Option<u32>,
        compatibility: bool,
    ) -> Result<(Self, Option<i64>)> {
        // Paid PGC/course/native callers always retain the original AVC policy.
        let video = dash
            .video
            .iter()
            .filter(|v| {
                (if compatibility {
                    compatible_bilibili_source(v, current_quality)
                } else {
                    compatible_bilibili_video(v, current_quality)
                }) && max_height.is_none_or(|height| v.height <= height)
            })
            .max_by_key(|v| {
                (
                    v.height,
                    v.codec == VideoCodec::Avc,
                    v.quality_id,
                    v.bandwidth,
                )
            })
            .ok_or_else(|| {
                err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "native_platform_codec_unsupported",
                )
            })?;
        let audio = dash
            .audio
            .iter()
            .filter(|a| {
                a.codec == AudioCodec::Aac
                    && a.codecs == "mp4a.40.2"
                    && a.mime_type == "audio/mp4"
                    && audio_shape(a.sampling_rate, a.bandwidth)
                    && valid_segments(
                        a.segment_base.index_range.start,
                        a.segment_base.index_range.end,
                        a.segment_base.initialization_range.start,
                        a.segment_base.initialization_range.end,
                    )
            })
            .max_by_key(|a| a.bandwidth)
            .ok_or_else(|| {
                err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "native_platform_codec_unsupported",
                )
            })?;
        let descriptor = Self {
            compatibility_source: if video.codec == VideoCodec::Avc {
                None
            } else if video.codec == VideoCodec::Hevc && video.codecs.split('.').nth(1) == Some("1")
            {
                Some(CompatibilitySource::ClearHevcMainV1)
            } else {
                Some(CompatibilitySource::ClearExtendedV1)
            },
            transport: Transport::Dash,
            duration_seconds: dash.duration_seconds,
            min_buffer_seconds: dash.min_buffer_seconds,
            tracks: vec![
                Track {
                    source_webm: None,
                    source_video: None,
                    key: "video".into(),
                    kind: "video".into(),
                    url: video.primary.as_str().into(),
                    observed_url_expires_at_ms: expiry_ms(video.primary.expires_at)?,
                    codecs: video.codecs.clone(),
                    mime_type: video.mime_type.clone(),
                    bandwidth: video.bandwidth,
                    start_with_sap: video.start_with_sap,
                    index_start: video.segment_base.index_range.start,
                    index_end: video.segment_base.index_range.end,
                    initialization_start: video.segment_base.initialization_range.start,
                    initialization_end: video.segment_base.initialization_range.end,
                    width: Some(video.width),
                    height: Some(video.height),
                    frame_rate: Some(video.frame_rate.clone()),
                    sar: Some(video.sar.clone()),
                    sampling_rate: None,
                    observed_content_length: None,
                    strong_etag: None,
                },
                Track {
                    source_webm: None,
                    source_video: None,
                    key: "audio".into(),
                    kind: "audio".into(),
                    url: audio.primary.as_str().into(),
                    observed_url_expires_at_ms: expiry_ms(audio.primary.expires_at)?,
                    codecs: audio.codecs.clone(),
                    mime_type: audio.mime_type.clone(),
                    bandwidth: audio.bandwidth,
                    start_with_sap: audio.start_with_sap,
                    index_start: audio.segment_base.index_range.start,
                    index_end: audio.segment_base.index_range.end,
                    initialization_start: audio.segment_base.initialization_range.start,
                    initialization_end: audio.segment_base.initialization_range.end,
                    width: None,
                    height: None,
                    frame_rate: None,
                    sar: None,
                    sampling_rate: Some(audio.sampling_rate),
                    observed_content_length: None,
                    strong_etag: None,
                },
            ],
        };
        if descriptor.compatibility_source.is_none() {
            descriptor.validate().map_err(|_| {
                err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "native_platform_descriptor_unsupported",
                )
            })?;
        }
        // Only selected primary URLs are deliverable. Unused backups cannot
        // extend or shorten authority and are not persisted as future grants.
        let expires = descriptor.earliest_known_expiry_ms();
        Ok((descriptor, expires))
    }
    pub fn from_progressive(
        provider: &str,
        resolved: &super::resolver::ResolvedProgressive,
    ) -> Result<(Self, Option<i64>)> {
        let video = resolved.video_codec.as_deref();
        let audio = resolved.audio_codec.as_deref();
        if video.is_some_and(|v| !valid_progressive_avc(v))
            || audio.is_some_and(|v| !matches!(v, "aac" | "mp4a.40.2"))
        {
            return Err(err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "native_platform_codec_unsupported",
            ));
        }
        let codecs = match (video, audio) {
            (Some(v), Some("mp4a.40.2")) if valid_avc(v) => format!("{v},mp4a.40.2"),
            _ => String::new(),
        };
        // YouTube's narrow extractor contract must select both declared codecs. Short
        // video hydration may omit declarations and gets an explicit browser
        // decode attempt, with no credential or Worker fallback.
        if provider == "youtube" && codecs.is_empty() {
            return Err(err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "native_platform_codec_unsupported",
            ));
        }
        let descriptor = Self {
            compatibility_source: None,
            transport: Transport::Progressive,
            duration_seconds: resolved.duration_seconds,
            min_buffer_seconds: 0.0,
            tracks: vec![Track {
                source_webm: None,
                source_video: None,
                key: "progressive".into(),
                kind: "muxed".into(),
                url: resolved.url.clone(),
                observed_url_expires_at_ms: resolved.url_expires_at_ms,
                codecs,
                mime_type: "video/mp4".into(),
                bandwidth: 0,
                start_with_sap: 0,
                index_start: 0,
                index_end: 0,
                initialization_start: 0,
                initialization_end: 0,
                width: resolved.width,
                height: resolved.height,
                frame_rate: None,
                sar: None,
                sampling_rate: None,
                observed_content_length: None,
                strong_etag: None,
            }],
        };
        descriptor.validate_for(provider).map_err(|_| {
            err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "native_platform_descriptor_unsupported",
            )
        })?;
        let expires = descriptor.earliest_known_expiry_ms();
        Ok((descriptor, expires))
    }
    pub fn decision_reason(&self, provider: &str) -> &'static str {
        match self.transport {
            Transport::Dash if self.compatibility_source.is_some() => {
                "native_platform_clear_media_compatibility"
            }
            Transport::Dash => "native_platform_avc_aac_dash",
            Transport::Progressive if provider == "youtube" => {
                "native_platform_avc_aac_progressive"
            }
            Transport::Progressive => "native_platform_mp4_codec_unverified",
        }
    }
    pub fn earliest_known_expiry_ms(&self) -> Option<i64> {
        self.tracks
            .iter()
            .filter_map(|track| track.observed_url_expires_at_ms)
            .min()
    }
    pub fn has_unknown_expiry(&self) -> bool {
        self.tracks
            .iter()
            .any(|track| track.observed_url_expires_at_ms.is_none())
    }
    pub fn validate(&self) -> Result<()> {
        self.validate_for("bilibili")
    }
    pub fn validate_for(&self, provider: &str) -> Result<()> {
        if self.compatibility_source == Some(CompatibilitySource::ClearWebmV1) {
            return self.validate_webm(provider);
        }
        if self.tracks.iter().any(|t| t.source_webm.is_some()) {
            return Err(invalid_grant());
        }
        if self.transport == Transport::Progressive {
            if self.compatibility_source.is_some() {
                return Err(invalid_grant());
            }
            return self.validate_progressive(provider);
        }
        if !matches!(provider, "bilibili" | "youtube")
            || (self.compatibility_source == Some(CompatibilitySource::ClearHevcMainV1)
                && provider != "bilibili")
        {
            return Err(invalid_grant());
        }
        if !self.duration_seconds.is_finite()
            || !(0.001..=604800.0).contains(&self.duration_seconds)
            || !self.min_buffer_seconds.is_finite()
            || !(0.0..=120.0).contains(&self.min_buffer_seconds)
            || self.tracks.len() != 2
        {
            return Err(invalid_grant());
        }
        let mut video = 0;
        let mut audio = 0;
        let mut keys = std::collections::HashSet::new();
        for track in &self.tracks {
            if self.compatibility_source == Some(CompatibilitySource::ClearExtendedV1)
                && track.kind == "video"
            {
                let expected = track.source_video.as_ref().ok_or_else(invalid_grant)?;
                expected.validate().map_err(|_| invalid_grant())?;
                if Some(expected.width) != track.width
                    || Some(expected.height) != track.height
                    || track.sar.as_deref() != Some(expected.sample_aspect_ratio.as_str())
                {
                    return Err(invalid_grant());
                }
            } else if track.source_video.is_some() {
                return Err(invalid_grant());
            }
            if !valid_key(&track.key)
                || !keys.insert(&track.key)
                || track.bandwidth == 0
                || track.bandwidth > 1_000_000_000
                || track.start_with_sap > 6
                || !valid_segments(
                    track.index_start,
                    track.index_end,
                    track.initialization_start,
                    track.initialization_end,
                )
                || track.observed_url_expires_at_ms.is_some_and(|v| v <= 0)
                || providers::platform::http::validate_media_url_for(provider, &track.url).is_err()
                || !valid_representation_facts(track)
                || (provider == "youtube" && track.observed_content_length.is_none())
                || (self.compatibility_source.is_some()
                    && (track.observed_content_length.is_none() || track.strong_etag.is_none()))
            {
                return Err(invalid_grant());
            }
            match track.kind.as_str() {
                "video"
                    if track.mime_type == "video/mp4"
                        && (if self.compatibility_source.is_some() {
                            providers::platform::youtube::mp4::valid_clear_extended_codec(
                                &track.codecs,
                            )
                        } else {
                            valid_avc(&track.codecs)
                        })
                        && track
                            .width
                            .zip(track.height)
                            .zip(track.frame_rate.as_deref().zip(track.sar.as_deref()))
                            .is_some_and(|((width, height), (rate, sar))| {
                                video_shape(width, height, rate, sar, track.bandwidth)
                            })
                        && track.sampling_rate.is_none() =>
                {
                    video += 1
                }
                "audio"
                    if track.mime_type == "audio/mp4"
                        && track.codecs == "mp4a.40.2"
                        && track
                            .sampling_rate
                            .is_some_and(|rate| audio_shape(rate, track.bandwidth))
                        && track.width.is_none()
                        && track.height.is_none()
                        && track.frame_rate.is_none()
                        && track.sar.is_none() =>
                {
                    audio += 1
                }
                _ => return Err(invalid_grant()),
            }
        }
        if video != 1 || audio != 1 {
            return Err(invalid_grant());
        }
        Ok(())
    }
    fn validate_webm(&self, provider: &str) -> Result<()> {
        if provider != "youtube"
            || self.transport != Transport::Dash
            || self.tracks.len() != 2
            || !self.duration_seconds.is_finite()
            || !(0.001..=21600.0).contains(&self.duration_seconds)
            || self.min_buffer_seconds != 1.5
        {
            return Err(invalid_grant());
        }
        let (v, a) = (&self.tracks[0], &self.tracks[1]);
        let e = v.source_webm.as_ref().ok_or_else(invalid_grant)?;
        e.validate().map_err(|_| invalid_grant())?;
        if v.source_video.is_some()
            || a.source_video.is_some()
            || a.source_webm.is_some()
            || v.key != "video"
            || v.kind != "video"
            || v.mime_type != "video/webm"
            || v.codecs != e.codec
            || v.width != Some(e.width)
            || v.height != Some(e.height)
            || v.sar.as_deref() != Some("1:1")
            || v.sampling_rate.is_some()
            || v.start_with_sap != 0
            || v.index_start != 0
            || v.index_end != 0
            || v.initialization_start != 0
            || !valid_metadata_range(0, v.initialization_end)
            || !v
                .frame_rate
                .as_deref()
                .is_some_and(|r| video_shape(e.width, e.height, r, "1:1", v.bandwidth))
            || a.key != "audio"
            || a.kind != "audio"
            || a.mime_type != "audio/mp4"
            || a.codecs != "mp4a.40.2"
            || a.width.is_some()
            || a.height.is_some()
            || a.frame_rate.is_some()
            || a.sar.is_some()
            || !a.sampling_rate.is_some_and(|r| audio_shape(r, a.bandwidth))
            || !valid_segments(
                a.index_start,
                a.index_end,
                a.initialization_start,
                a.initialization_end,
            )
            || self.tracks.iter().any(|t| {
                t.observed_content_length.is_none()
                    || t.strong_etag.is_none()
                    || !valid_representation_facts(t)
                    || !t.observed_url_expires_at_ms.is_some_and(|n| n > 0)
                    || providers::platform::http::validate_media_url_for(provider, &t.url).is_err()
            })
        {
            return Err(invalid_grant());
        }
        Ok(())
    }
    fn validate_progressive(&self, provider: &str) -> Result<()> {
        if !matches!(provider, "douyin" | "tiktok" | "youtube")
            || !self.duration_seconds.is_finite()
            || !(0.001..=604800.0).contains(&self.duration_seconds)
            || self.min_buffer_seconds != 0.0
            || self.tracks.len() != 1
        {
            return Err(invalid_grant());
        }
        let t = &self.tracks[0];
        let declared_baseline = t
            .codecs
            .split_once(',')
            .is_some_and(|(v, a)| valid_avc(v) && a == "mp4a.40.2");
        if t.key != "progressive"
            || t.kind != "muxed"
            || t.mime_type != "video/mp4"
            || (!t.codecs.is_empty() && !declared_baseline)
            || (provider == "youtube" && !declared_baseline)
            || t.bandwidth != 0
            || t.start_with_sap != 0
            || t.index_start != 0
            || t.index_end != 0
            || t.initialization_start != 0
            || t.initialization_end != 0
            || t.frame_rate.is_some()
            || t.sar.is_some()
            || t.sampling_rate.is_some()
            || !matches!(
                (t.width, t.height),
                (None, None) | (Some(1..=8192), Some(1..=4320))
            )
            || t.observed_url_expires_at_ms.is_some_and(|v| v <= 0)
            || !valid_representation_facts(t)
            || providers::platform::http::validate_media_url_for(provider, &t.url).is_err()
        {
            return Err(invalid_grant());
        }
        Ok(())
    }
    #[cfg(test)]
    pub fn render(&self, session: Uuid, token: &str) -> Result<String> {
        self.render_for("bilibili", session, token)
    }
    pub fn render_for(&self, provider: &str, session: Uuid, token: &str) -> Result<String> {
        self.validate_for(provider)?;
        if self.transport != Transport::Dash || self.compatibility_source.is_some() {
            return Err(invalid_grant());
        }
        if token.len() != 64 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(invalid_grant());
        }
        let mut xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\" type=\"static\" profiles=\"urn:mpeg:dash:profile:isoff-on-demand:2011\" mediaPresentationDuration=\"PT{}S\" minBufferTime=\"PT{}S\"><Period>",
            self.duration_seconds, self.min_buffer_seconds
        );
        for track in &self.tracks {
            xml.push_str(&format!("<AdaptationSet contentType=\"{}\" mimeType=\"{}\"><Representation id=\"{}\" codecs=\"{}\" bandwidth=\"{}\" startWithSAP=\"{}\"",xml_escape(&track.kind),xml_escape(&track.mime_type),xml_escape(&track.key),xml_escape(&track.codecs),track.bandwidth,track.start_with_sap));
            if let (Some(width), Some(height), Some(rate), Some(sar)) =
                (track.width, track.height, &track.frame_rate, &track.sar)
            {
                xml.push_str(&format!(
                    " width=\"{width}\" height=\"{height}\" frameRate=\"{}\" sar=\"{}\"",
                    xml_escape(&rendered_frame_rate(rate)),
                    xml_escape(&rendered_sar(sar))
                ));
            }
            if let Some(rate) = track.sampling_rate {
                xml.push_str(&format!(" audioSamplingRate=\"{rate}\""));
            }
            xml.push_str(&format!("><BaseURL>/api/v1/platform-delivery/{session}/tracks/{}?token={}</BaseURL><SegmentBase indexRange=\"{}-{}\"><Initialization range=\"{}-{}\"/></SegmentBase></Representation></AdaptationSet>",xml_escape(&track.key),xml_escape(token),track.index_start,track.index_end,track.initialization_start,track.initialization_end));
        }
        xml.push_str("</Period></MPD>");
        if xml.len() > MAX_MANIFEST_BYTES {
            return Err(invalid_grant());
        }
        Ok(xml)
    }
}
fn valid_representation_facts(track: &Track) -> bool {
    track.observed_content_length.is_none_or(|length| {
        length > 0
            && length <= MAX_JS_INTEGER
            && (track.index_end < length && track.initialization_end < length)
    }) && track.strong_etag.as_deref().is_none_or(valid_strong_etag)
        && (track.strong_etag.is_none() || track.observed_content_length.is_some())
}
pub(super) fn valid_strong_etag(value: &str) -> bool {
    value.len() >= 2
        && value.len() <= 1024
        && value.starts_with('"')
        && value.ends_with('"')
        && value.as_bytes()[1..value.len() - 1]
            .iter()
            .all(|byte| *byte == b'!' || (b'#'..=b'~').contains(byte))
}

fn expiry_ms(seconds: Option<u64>) -> Result<Option<i64>> {
    seconds
        .map(|v| {
            i64::try_from(v)
                .ok()
                .and_then(|v| v.checked_mul(1000))
                .filter(|v| *v > 0)
                .ok_or_else(invalid_grant)
        })
        .transpose()
}
pub(super) fn valid_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}
fn valid_progressive_avc(value: &str) -> bool {
    valid_avc(value) || matches!(value, "h264" | "avc" | "avc1")
}
fn compatible_bilibili_video(track: &VideoTrack, current_quality: u32) -> bool {
    track.codec == VideoCodec::Avc
        && valid_avc(&track.codecs)
        && bilibili_video_shape(track, current_quality)
}
fn compatible_bilibili_source(track: &VideoTrack, current_quality: u32) -> bool {
    (compatible_bilibili_video(track, current_quality)
        || (matches!(track.codec, VideoCodec::Hevc | VideoCodec::Av1)
            && providers::platform::youtube::mp4::valid_clear_extended_codec(&track.codecs)
            && track.sar == "1:1"))
        && bilibili_video_shape(track, current_quality)
}
fn bilibili_video_shape(track: &VideoTrack, current_quality: u32) -> bool {
    track.mime_type == "video/mp4"
        && track.quality_id <= current_quality
        && video_shape(
            track.width,
            track.height,
            &track.frame_rate,
            &track.sar,
            track.bandwidth,
        )
        && valid_segments(
            track.segment_base.index_range.start,
            track.segment_base.index_range.end,
            track.segment_base.initialization_range.start,
            track.segment_base.initialization_range.end,
        )
}
fn valid_avc(value: &str) -> bool {
    value
        .strip_prefix("avc1.")
        .is_some_and(|v| v.len() == 6 && v.bytes().all(|c| c.is_ascii_hexdigit()))
}
fn video_shape(width: u32, height: u32, rate: &str, sar: &str, bandwidth: u64) -> bool {
    (1..=8192).contains(&width)
        && (1..=4320).contains(&height)
        && (1..=MAX_VIDEO_BANDWIDTH).contains(&bandwidth)
        && valid_frame_rate(rate)
        && valid_ratio(sar, ':').is_some()
}
fn audio_shape(rate: u32, bandwidth: u64) -> bool {
    (8000..=96000).contains(&rate) && (1..=MAX_AUDIO_BANDWIDTH).contains(&bandwidth)
}
fn valid_frame_rate(value: &str) -> bool {
    valid_ratio(value, '/').is_some_and(|v| v <= 120.0)
}
fn rendered_frame_rate(value: &str) -> String {
    if let Some((a, b)) = value.split_once('/') {
        format!(
            "{}/{}",
            a.parse::<u32>().expect("validated frame numerator"),
            b.parse::<u32>().expect("validated frame denominator")
        )
    } else {
        value
            .parse::<u32>()
            .expect("validated frame scalar")
            .to_string()
    }
}
fn rendered_sar(value: &str) -> String {
    if value.contains(':') {
        value.to_owned()
    } else {
        format!(
            "{}:1",
            value.parse::<u32>().expect("validated positive scalar SAR")
        )
    }
}
fn valid_segments(
    index_start: u64,
    index_end: u64,
    initialization_start: u64,
    initialization_end: u64,
) -> bool {
    initialization_start == 0
        && initialization_end < index_start
        && valid_metadata_range(index_start, index_end)
        && valid_metadata_range(initialization_start, initialization_end)
}
fn valid_metadata_range(start: u64, end: u64) -> bool {
    start <= end
        && end <= MAX_JS_INTEGER
        && end
            .checked_sub(start)
            .and_then(|v| v.checked_add(1))
            .is_some_and(|v| v <= MAX_METADATA_RANGE_BYTES)
}
fn valid_ratio(value: &str, separator: char) -> Option<f64> {
    if value.is_empty() || value.len() > 32 {
        return None;
    }
    let mut parts = value.split(separator);
    let number = |v: &str| {
        if !v.is_empty() && v.bytes().all(|v| v.is_ascii_digit()) {
            v.parse::<u32>().ok().filter(|v| *v > 0)
        } else {
            None
        }
    };
    let numerator = number(parts.next()?)?;
    let denominator = parts.next().map(number).unwrap_or(Some(1))?;
    if parts.next().is_some() {
        return None;
    }
    let ratio = f64::from(numerator) / f64::from(denominator);
    (ratio.is_finite() && ratio > 0.0).then_some(ratio)
}
pub(super) fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
pub(super) fn policy_deadline(
    resolved: i64,
    expires: Option<i64>,
    has_unknown_expiry: bool,
) -> Result<i64> {
    let max = resolved
        .checked_add(MAX_GRANT_MS)
        .ok_or_else(invalid_grant)?;
    let mut deadline = match expires {
        Some(v) => v
            .checked_sub(URL_EXPIRY_MARGIN_MS)
            .ok_or_else(invalid_grant)?
            .min(max),
        None => max,
    };
    if has_unknown_expiry || expires.is_none() {
        deadline = deadline.min(
            resolved
                .checked_add(UNKNOWN_URL_POLICY_MS)
                .ok_or_else(invalid_grant)?,
        );
    }
    if deadline <= resolved {
        return Err(err(StatusCode::GONE, "native_platform_url_expired"));
    }
    Ok(deadline)
}
fn invalid_grant() -> Error {
    err(StatusCode::GONE, "invalid_playback_session")
}

#[cfg(test)]
pub(super) fn fixture() -> Descriptor {
    Descriptor {compatibility_source:None,transport:Transport::Dash,duration_seconds:120.0,min_buffer_seconds:1.5,tracks:vec![
        Track{source_webm:None,source_video:None,
key:"video".into(),kind:"video".into(),url:"https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/00/1/1-1.m4s?deadline=2000000000".into(),observed_url_expires_at_ms:None,codecs:"avc1.640028".into(),mime_type:"video/mp4".into(),bandwidth:1000000,start_with_sap:1,index_start:100,index_end:200,initialization_start:0,initialization_end:99,width:Some(1920),height:Some(1080),frame_rate:Some("30000/1001".into()),sar:Some("1:1".into()),sampling_rate:None,observed_content_length:None,strong_etag:None},
        Track{source_webm:None,source_video:None,
key:"audio".into(),kind:"audio".into(),url:"https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/00/1/1-2.m4s?deadline=2000000000".into(),observed_url_expires_at_ms:None,codecs:"mp4a.40.2".into(),mime_type:"audio/mp4".into(),bandwidth:192000,start_with_sap:1,index_start:100,index_end:200,initialization_start:0,initialization_end:99,width:None,height:None,frame_rate:None,sar:None,sampling_rate:Some(48000),observed_content_length:None,strong_etag:None}]}
}
#[cfg(test)]
pub(super) fn progressive_fixture(provider: &str) -> Descriptor {
    let url = match provider {
        "douyin" => "https://v9-v2-mps-cdn.douyinvod.com/video.mp4?signature=private",
        "tiktok" => "https://v58.tiktokcdn.com/video.mp4?signature=private",
        "youtube" => "https://rr1.googlevideo.com/videoplayback?signature=private",
        _ => unreachable!(),
    };
    let resolved = super::resolver::ResolvedProgressive {
        content_id: "123".into(),
        canonical_url: "https://example.invalid/identity".into(),
        title: "Video".into(),
        duration_seconds: 120.0,
        url: url.into(),
        url_expires_at_ms: None,
        width: Some(1920),
        height: Some(1080),
        video_codec: (provider == "youtube").then(|| "avc1.640028".into()),
        audio_codec: (provider == "youtube").then(|| "mp4a.40.2".into()),
    };
    Descriptor::from_progressive(provider, &resolved).unwrap().0
}
#[cfg(test)]
pub(super) fn youtube_fixture() -> Descriptor {
    let mut d = fixture();
    d.min_buffer_seconds = 0.0;
    for track in &mut d.tracks {
        track.url = format!(
            "https://rr1.googlevideo.com/videoplayback?track={}&signature=private",
            track.key
        );
        track.observed_url_expires_at_ms = Some(if track.key == "video" { 180000 } else { 190000 });
        track.observed_content_length = Some(10000);
        track.strong_etag = Some(format!("\"{}-fixture\"", track.key));
        track.start_with_sap = if track.key == "video" { 2 } else { 0 };
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bilibili_manual_height_selects_one_compatible_pair_and_advertises_only_real_tracks() {
        use providers::platform::bilibili::{
            AudioTrack, ByteRange, Dash, SegmentBase, VideoMetadata,
        };
        let url = bilibili::parse_media_url(
            "https://upos-sz-mirrorcos.bilivideo.com/fixture.m4s?deadline=1700003600",
            1700000000,
        )
        .unwrap();
        let segments = SegmentBase {
            initialization_range: ByteRange { start: 0, end: 99 },
            index_range: ByteRange {
                start: 100,
                end: 200,
            },
        };
        let video = |height, quality_id, codec, codecs: &str| VideoTrack {
            key: format!("{quality_id}"),
            quality_id,
            codec,
            codecs: codecs.into(),
            mime_type: "video/mp4".into(),
            width: height * 16 / 9,
            height,
            frame_rate: "30".into(),
            sar: "1:1".into(),
            bandwidth: 1_000_000,
            start_with_sap: 1,
            segment_base: segments.clone(),
            primary: url.clone(),
            backups: vec![],
        };
        let resolved = ResolvedVideo {
            metadata: VideoMetadata {
                bvid: "BV1xx411c7mD".into(),
                aid: "1".into(),
                cid: "2".into(),
                part: 1,
                part_count: 1,
                title: "Fixture".into(),
                part_title: "Fixture".into(),
                duration_seconds: 120,
            },
            current_quality: 127,
            qualities: vec![],
            earliest_expires_at: Some(1700003600),
            playback: Playback::Dash(Dash {
                duration_seconds: 120.0,
                min_buffer_seconds: 1.5,
                video: vec![
                    video(360, 16, VideoCodec::Avc, "avc1.640028"),
                    video(704, 64, VideoCodec::Avc, "avc1.640028"),
                    video(1080, 80, VideoCodec::Avc, "avc1.640028"),
                    video(2160, 120, VideoCodec::Hevc, "hvc1.1.6.L120"),
                ],
                audio: vec![AudioTrack {
                    key: "audio".into(),
                    id: 30280,
                    codec: AudioCodec::Aac,
                    codecs: "mp4a.40.2".into(),
                    mime_type: "audio/mp4".into(),
                    bandwidth: 192000,
                    sampling_rate: 48000,
                    start_with_sap: 1,
                    segment_base: segments,
                    primary: url,
                    backups: vec![],
                }],
            }),
        };
        assert_eq!(
            Descriptor::bilibili_heights(&resolved),
            vec![360, 704, 1080]
        );
        let (descriptor, expiry) =
            Descriptor::from_resolved_with_max_height(&resolved, Some(720)).unwrap();
        assert_eq!(descriptor.tracks.len(), 2);
        assert_eq!(descriptor.tracks[0].height, Some(704));
        assert_eq!(descriptor.tracks[1].codecs, "mp4a.40.2");
        assert_eq!(expiry, Some(1700003600000));
        assert!(Descriptor::from_resolved_with_max_height(&resolved, Some(240)).is_err());
        let xml = descriptor
            .render(Uuid::from_u128(1), &"a".repeat(64))
            .unwrap();
        assert_eq!(xml.matches("<Representation ").count(), 2);
        assert!(!xml.contains("bilivideo"));
        let mut compatibility_resolved = resolved.clone();
        let Playback::Dash(dash) = &mut compatibility_resolved.playback else {
            unreachable!()
        };
        dash.video[3].codecs = "hev1.1.6.L120.90".into();
        let (candidate, heights) =
            Descriptor::bilibili_compatibility_candidate(&compatibility_resolved, Some(2160))
                .unwrap();
        assert_eq!(candidate.tracks[0].height, Some(2160));
        assert_eq!(
            candidate.compatibility_source,
            Some(CompatibilitySource::ClearHevcMainV1)
        );
        assert!(candidate.validate_for("bilibili").is_err()); // byte proof still absent
        assert_eq!(heights, vec![360, 704, 1080, 2160]);
        assert_eq!(
            Descriptor::from_resolved_with_max_height(&compatibility_resolved, Some(2160))
                .unwrap()
                .0
                .tracks[0]
                .height,
            Some(1080)
        );
        dash_only_hevc(&mut compatibility_resolved);
        assert!(
            Descriptor::from_resolved_with_max_height(&compatibility_resolved, Some(2160)).is_err()
        );
        assert!(
            Descriptor::bilibili_compatibility_candidate(&compatibility_resolved, Some(1080))
                .is_err()
        );
    }
    fn dash_only_hevc(resolved: &mut ResolvedVideo) {
        let Playback::Dash(dash) = &mut resolved.playback else {
            unreachable!()
        };
        dash.video.retain(|v| v.codec == VideoCodec::Hevc);
    }
    #[test]
    fn youtube_dash_is_provider_bound_and_requires_probed_representation_facts() {
        let d = youtube_fixture();
        assert!(d.validate_for("youtube").is_ok());
        for foreign in ["bilibili", "douyin", "tiktok", "unknown"] {
            assert!(d.validate_for(foreign).is_err());
            assert!(
                d.render_for(foreign, Uuid::from_u128(42), &"a".repeat(64))
                    .is_err()
            );
        }
        let xml = d
            .render_for("youtube", Uuid::from_u128(42), &"a".repeat(64))
            .unwrap();
        assert_eq!(
            xml,
            include_str!("fixtures/youtube-clear-vod.mpd").trim_end()
        );
        for private in ["googlevideo", "signature", "fixture", "ETag"] {
            assert!(!xml.contains(private));
        }
        let mut changed = d.clone();
        changed.tracks[0].observed_content_length = None;
        changed.tracks[0].strong_etag = None;
        assert!(changed.validate_for("youtube").is_err());
        let mut changed = d.clone();
        changed.tracks[0].observed_content_length = Some(changed.tracks[0].index_end);
        assert!(changed.validate_for("youtube").is_err());
        for invalid in ["W/\"weak\"", "unquoted", "\"bad\"quote\""] {
            let mut changed = d.clone();
            changed.tracks[0].strong_etag = Some(invalid.into());
            assert!(changed.validate_for("youtube").is_err());
        }
    }

    #[test]
    fn old_dash_records_keep_exact_canonical_grant_decoding() {
        let value = serde_json::to_value(fixture()).unwrap();
        assert!(value.get("transport").is_none());
        assert!(value.get("compatibility_source").is_none());
        for track in value["tracks"].as_array().unwrap() {
            assert!(track.get("observed_content_length").is_none());
            assert!(track.get("strong_etag").is_none());
        }
        let decoded: Descriptor = serde_json::from_value(value.clone()).unwrap();
        assert!(decoded.transport == Transport::Dash);
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }
    #[test]
    fn progressive_descriptor_has_closed_provider_bound_single_muxed_track() {
        for provider in ["douyin", "tiktok", "youtube"] {
            let d = progressive_fixture(provider);
            assert!(d.validate_for(provider).is_ok());
            let value = serde_json::to_value(&d).unwrap();
            assert_eq!(value["transport"], "progressive");
            assert_eq!(d.tracks.len(), 1);
            assert!(d.render(Uuid::from_u128(42), &"a".repeat(64)).is_err());
            for foreign in ["bilibili", "douyin", "tiktok", "youtube"] {
                if foreign != provider {
                    assert!(d.validate_for(foreign).is_err());
                }
            }
            let mut changed = d.clone();
            changed.tracks.push(changed.tracks[0].clone());
            assert!(changed.validate_for(provider).is_err());
            let mut changed = d.clone();
            changed.tracks[0].index_start = 1;
            assert!(changed.validate_for(provider).is_err());
            let mut changed = d.clone();
            changed.tracks[0].width = Some(8193);
            assert!(changed.validate_for(provider).is_err());
            let mut changed = d.clone();
            changed.duration_seconds = f64::NAN;
            assert!(changed.validate_for(provider).is_err());
        }
        assert!(fixture().validate_for("youtube").is_err());
        let d = progressive_fixture("douyin");
        assert_eq!(d.tracks[0].codecs, "");
        assert_eq!(
            d.decision_reason("douyin"),
            "native_platform_mp4_codec_unverified"
        );
        let mut d = progressive_fixture("youtube");
        d.tracks[0].codecs.clear();
        assert!(d.validate_for("youtube").is_err());
    }
    #[test]
    fn own_account_bindings_require_supported_provider_id_and_exact_revision() {
        for provider in ["bilibili", "douyin", "tiktok", "youtube"] {
            let mut binding = Binding {
                version: 1,
                provider: provider.into(),
                media_id: Uuid::from_u128(1),
                room_id: Uuid::from_u128(2),
                user_id: Uuid::from_u128(3),
                entry_revision: "1".into(),
                credential_mode: "anonymous".into(),
                account_id: None,
                account_revision: None,
                resource: None,
            };
            assert!(binding.validate());
            binding.credential_mode = "own_account".into();
            binding.account_id = Some(Uuid::from_u128(4));
            binding.account_revision = Some("1".into());
            assert!(binding.validate());
            binding.account_revision = Some("01".into());
            assert!(!binding.validate());
            binding.account_revision = None;
            assert!(!binding.validate());
            binding.account_revision = Some("1".into());
            binding.account_id = None;
            assert!(!binding.validate());
            binding.account_id = Some(Uuid::from_u128(4));
            binding.credential_mode = "owner_account".into();
            assert!(!binding.validate());
        }
    }
    #[test]
    fn manifest_has_closed_same_session_shape_and_no_upstream_urls() {
        let session = Uuid::from_u128(42);
        let token = "a".repeat(64);
        let xml = fixture().render(session, &token).unwrap();
        assert_eq!(xml.matches("<BaseURL>").count(), 2);
        assert_eq!(
            xml.matches(&format!("/api/v1/platform-delivery/{session}/tracks/"))
                .count(),
            2
        );
        for forbidden in [
            "bilivideo",
            "XLink",
            "UTCTiming",
            "ContentProtection",
            "EventStream",
            "Location",
            "SegmentTemplate",
            "Cookie",
        ] {
            assert!(!xml.contains(forbidden));
        }
        assert!(xml.len() < MAX_MANIFEST_BYTES);
        assert_eq!(xml_escape("<&\"'>"), "&lt;&amp;&quot;&apos;&gt;");
    }
    #[test]
    fn descriptors_refuse_foreign_routes_codecs_and_invalid_ranges() {
        let mut d = fixture();
        d.tracks[0].key = "video.avc".into();
        assert!(d.validate().is_err());
        let mut d = fixture();
        d.tracks[0].url = "https://evil.example/file".into();
        assert!(d.validate().is_err());
        let mut d = fixture();
        d.tracks[0].codecs = "hvc1.1.6.L120".into();
        assert!(d.validate().is_err());
        let mut d = fixture();
        d.tracks[1].index_end = 0;
        assert!(d.validate().is_err());
        let mut d = fixture();
        d.tracks.push(d.tracks[0].clone());
        assert!(d.validate().is_err());
    }
    #[test]
    fn descriptors_obey_the_shared_baseline_player_bounds() {
        let mut d = fixture();
        d.tracks[0].width = Some(8193);
        assert!(d.validate().is_err());
        let mut d = fixture();
        d.tracks[0].height = Some(4321);
        assert!(d.validate().is_err());
        let mut d = fixture();
        d.tracks[0].frame_rate = Some("121".into());
        assert!(d.validate().is_err());
        let mut d = fixture();
        d.tracks[0].bandwidth = MAX_VIDEO_BANDWIDTH + 1;
        assert!(d.validate().is_err());
        let mut d = fixture();
        d.tracks[1].bandwidth = MAX_AUDIO_BANDWIDTH + 1;
        assert!(d.validate().is_err());
        let mut d = fixture();
        d.tracks[1].sampling_rate = Some(96001);
        assert!(d.validate().is_err());
        for codec in ["mp4a.40.5", "mp4a.40.29"] {
            let mut d = fixture();
            d.tracks[1].codecs = codec.into();
            assert!(d.validate().is_err());
        }
        assert!(!valid_metadata_range(0, MAX_METADATA_RANGE_BYTES));
        assert!(!valid_metadata_range(MAX_JS_INTEGER, MAX_JS_INTEGER + 1));
        assert!(valid_metadata_range(0, MAX_METADATA_RANGE_BYTES - 1));
        assert!(video_shape(
            8192,
            4320,
            "120/1",
            "4294967295:1",
            MAX_VIDEO_BANDWIDTH
        ));
        assert!(!video_shape(
            1920,
            1080,
            "29.97",
            "1:1",
            MAX_VIDEO_BANDWIDTH
        ));
        assert_eq!(rendered_sar("2"), "2:1");
        assert_eq!(rendered_frame_rate("0010/0001"), "10/1");
        assert!(!valid_frame_rate("121.0"));
        assert!(!valid_frame_rate("1e2"));
        assert!(!valid_segments(50, 100, 0, 99));
        assert!(!valid_segments(100, 200, 1, 99));
        assert!(!video_shape(
            8192,
            4320,
            "120/0",
            "1:1",
            MAX_VIDEO_BANDWIDTH
        ));
    }
    #[test]
    fn server_renderer_matches_the_shared_client_contract_fixture() {
        let mut descriptor = fixture();
        descriptor.min_buffer_seconds = 0.0;
        let xml = descriptor
            .render(Uuid::from_u128(42), &"a".repeat(64))
            .unwrap();
        assert_eq!(xml, include_str!("fixtures/clear-vod.mpd").trim_end());
    }
    #[test]
    fn expiry_is_never_extended_and_unknown_is_explicit_short_policy() {
        assert_eq!(policy_deadline(100000, None, true).unwrap(), 220000);
        assert_eq!(
            policy_deadline(100000, Some(180000), false).unwrap(),
            150000
        );
        assert_eq!(
            policy_deadline(100000, Some(9000000), false).unwrap(),
            1900000
        );
        assert!(policy_deadline(100000, Some(110000), false).is_err());
    }
    #[test]
    fn known_short_expiry_survives_an_unknown_other_track_in_both_orders() {
        for known in 0..2 {
            let mut descriptor = fixture();
            descriptor.tracks[known].observed_url_expires_at_ms = Some(180000);
            assert_eq!(descriptor.earliest_known_expiry_ms(), Some(180000));
            assert!(descriptor.has_unknown_expiry());
            let sealed = Sealed {
                kind: "native_platform".into(),
                version: 1,
                binding: Binding {
                    version: 1,
                    provider: "bilibili".into(),
                    media_id: Uuid::from_u128(1),
                    room_id: Uuid::from_u128(2),
                    user_id: Uuid::from_u128(3),
                    entry_revision: "1".into(),
                    credential_mode: "anonymous".into(),
                    account_id: None,
                    account_revision: None,
                    resource: None,
                },
                resolved_at_ms: 100000,
                url_expires_at_ms: Some(180000),
                descriptor,
            };
            assert_eq!(sealed.policy_deadline_ms().unwrap(), 150000);
            let mut changed = sealed.clone();
            changed.url_expires_at_ms = None;
            assert!(changed.policy_deadline_ms().is_err());
        }
        assert_eq!(
            policy_deadline(100000, Some(9000000), true).unwrap(),
            220000
        );
    }
    #[test]
    fn binding_is_closed_and_ownerless() {
        let binding = Binding {
            version: 1,
            provider: "bilibili".into(),
            media_id: Uuid::from_u128(1),
            room_id: Uuid::from_u128(2),
            user_id: Uuid::from_u128(3),
            entry_revision: "1".into(),
            credential_mode: "anonymous".into(),
            account_id: None,
            account_revision: None,
            resource: None,
        };
        assert!(binding.validate());
        let mut b = binding.clone();
        b.credential_mode = "owner_account".into();
        assert!(!b.validate());
        let mut b = binding.clone();
        b.entry_revision = "01".into();
        assert!(!b.validate());
        let mut value = serde_json::to_value(binding).unwrap();
        value["cookie"] = json!("fixture");
        assert!(serde_json::from_value::<Binding>(value).is_err());
    }
}
