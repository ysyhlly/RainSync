//! Fail-closed, single-episode PUGV course adapter, separate from UGC and PGC.
//!
//! Endpoint/envelope provenance and fixture limits are recorded in
//! `course/BOUNDARY.md`. The course playurl response must positively identify whole
//! playback before any CDN descriptor is exposed. Metadata, status 0, duration,
//! a VIP account or the presence of playable URLs never establishes full access.
//! No alternative account, region, legacy API, UGC or webpage fallback exists.
use super::{
    AudioCodec, AudioTrack, Cookie, Dash, Error, MediaUrl, Playback, Quality, Result, SegmentBase,
    VideoCodec, alias, array, boolish, bounded_u32, bounded_u64, check_code, codec_text, decimal,
    field, id, media_addresses, numeric_string, object, optional_alias, optional_sap, parse_dash,
    parse_media_url, parse_qualities, parse_segment_base, playback_expiry, strict_json, text,
    unix_seconds,
};
use crate::platform::youtube::mp4;
use reqwest::Url;
use serde_json::Value;
use std::{collections::HashSet, fmt, future::Future, pin::Pin};
use tokio::time::Instant;

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_EPISODES: usize = 2_000;
const MAX_INIT_BYTES: usize = 256 * 1024;
const MAX_CLEAR_AUDIO_BANDWIDTH: u64 = 512_000;
const MAX_DURATION_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeRef {
    pub ep_id: String,
}
impl EpisodeRef {
    pub fn canonical(&self) -> String {
        format!("https://www.bilibili.com/cheese/play/ep{}", self.ep_id)
    }
}

/// Only explicit course:ep identities or exact course URLs are supported.
/// Season/media selectors, short links,
/// URL queries/fragments and ordinary UGC identifiers are rejected.
pub fn parse_resource(input: &str) -> Result<EpisodeRef> {
    if input.is_empty()
        || input.len() > 2048
        || input.trim() != input
        || input.chars().any(char::is_control)
    {
        return Err(Error::InvalidResource);
    }
    let identity = if input.starts_with("https://") {
        let url = Url::parse(input).map_err(|_| Error::InvalidResource)?;
        let authority = input
            .strip_prefix("https://")
            .and_then(|rest| rest.split('/').next())
            .ok_or(Error::InvalidResource)?;
        if !matches!(authority, "www.bilibili.com" | "bilibili.com" | "m.bilibili.com")
            || !matches!(url.host_str(), Some("www.bilibili.com" | "bilibili.com" | "m.bilibili.com"))
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path().contains('%')
            || url.path().contains("/../")
            // Reject URL parser path normalization, including dot segments.
            || input != format!("https://{authority}{}", url.path())
        {
            return Err(Error::InvalidResource);
        }
        url.path()
            .strip_prefix("/cheese/play/ep")
            .map(|identity| identity.strip_suffix('/').unwrap_or(identity).to_owned())
            .ok_or(Error::InvalidResource)?
    } else {
        input
            .strip_prefix("course:ep")
            .ok_or(Error::InvalidResource)?
            .to_owned()
    };
    if !decimal(&identity) {
        return Err(Error::InvalidResource);
    }
    Ok(EpisodeRef { ep_id: identity })
}

/// No signed address, purchase state or opaque upstream payload is serializable.
/// Private access evidence also binds identity and duration against caller edits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Metadata {
    pub season_id: String,
    pub ep_id: String,
    pub aid: String,
    pub cid: String,
    pub title: String,
    pub episode_title: String,
    pub duration_ms: u64,
    access: EpisodeAccess,
}
impl Metadata {
    pub fn canonical(&self) -> String {
        EpisodeRef {
            ep_id: self.ep_id.clone(),
        }
        .canonical()
    }
    pub fn duration_seconds(&self) -> u64 {
        self.duration_ms / 1000
    }
    fn validate(&self) -> Result<()> {
        if !decimal(&self.season_id)
            || !decimal(&self.ep_id)
            || !decimal(&self.aid)
            || !decimal(&self.cid)
            || !(1000..=MAX_DURATION_MS).contains(&self.duration_ms)
            || self.title.is_empty()
            || self.title.len() > 4096
            || self.episode_title.is_empty()
            || self.episode_title.len() > 4096
            || self
                .title
                .chars()
                .chain(self.episode_title.chars())
                .any(char::is_control)
        {
            return Err(Error::InvalidResponse("course_metadata_identity"));
        }
        if self.access.season_id != self.season_id
            || self.access.ep_id != self.ep_id
            || self.access.aid != self.aid
            || self.access.cid != self.cid
            || self.access.duration_ms != self.duration_ms
        {
            return Err(Error::InvalidResponse("course_metadata_access_identity"));
        }
        Ok(())
    }
}

/// Minted only from known, positively playable selected episode metadata.
/// These flags authorize the normal playback API, but are not by themselves
/// proof of a complete episode. That proof requires the playback gate below.
#[derive(Debug, Clone, PartialEq, Eq)]
struct EpisodeAccess {
    season_id: String,
    ep_id: String,
    aid: String,
    cid: String,
    duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct Resolved {
    entitlement: WholeEntitlement,
    pub metadata: Metadata,
    pub current_quality: u32,
    pub qualities: Vec<Quality>,
    /// Only clear AVC/AAC tracks within the requested actual height ceiling.
    pub dash: Dash,
    /// Unknown if any retained primary or backup lacks a recognized expiry.
    pub earliest_expires_at: Option<u64>,
    /// Present only after a missing audio rate was derived from bounded bytes.
    pub audio_probe: Option<AudioProbeIdentity>,
}

/// A partially parsed playback result cannot expose a DASH descriptor. Missing
/// sampling rate is represented as unknown, never replaced by a default value.
#[derive(Debug, Clone)]
pub struct PendingResolved {
    metadata: Metadata,
    current_quality: u32,
    qualities: Vec<Quality>,
    dash: Dash,
    audio: PendingAudio,
}
#[derive(Debug, Clone)]
struct PendingAudio {
    key: String,
    id: u32,
    codec: AudioCodec,
    codecs: String,
    mime_type: String,
    bandwidth: u64,
    sampling_rate: Option<u32>,
    start_with_sap: u32,
    segment_base: SegmentBase,
    primary: MediaUrl,
    backups: Vec<MediaUrl>,
}
#[derive(Clone, PartialEq, Eq)]
pub struct AudioProbeIdentity {
    pub total_bytes: u64,
    pub strong_etag: Option<String>,
}
impl std::fmt::Debug for AudioProbeIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioProbeIdentity")
            .field("total_bytes", &self.total_bytes)
            .field("has_strong_etag", &self.strong_etag.is_some())
            .finish()
    }
}
impl PendingResolved {
    /// Pure fixtures and callers with complete rate metadata may finalize without
    /// byte probes. Unknown rate cannot be resolved through this method.
    pub fn finish_without_probe(self) -> Result<Resolved> {
        self.finish(None)
    }
    fn finish(mut self, derived: Option<(u32, AudioProbeIdentity)>) -> Result<Resolved> {
        let (sampling_rate, audio_probe) = match (self.audio.sampling_rate, derived) {
            (Some(rate), None) => (rate, None),
            (None, Some((rate, identity))) => (rate, Some(identity)),
            _ => return Err(Error::InvalidResponse("course_audio_rate_required")),
        };
        if !(8000..=96000).contains(&sampling_rate) {
            return Err(Error::Restricted("course_clear_avc_aac_unavailable"));
        }
        self.dash.audio.push(AudioTrack {
            key: self.audio.key,
            id: self.audio.id,
            codec: self.audio.codec,
            codecs: self.audio.codecs,
            mime_type: self.audio.mime_type,
            bandwidth: self.audio.bandwidth,
            sampling_rate,
            start_with_sap: self.audio.start_with_sap,
            segment_base: self.audio.segment_base,
            primary: self.audio.primary,
            backups: self.audio.backups,
        });
        let earliest_expires_at = playback_expiry(&Playback::Dash(self.dash.clone()));
        Ok(Resolved {
            entitlement: WholeEntitlement { _private: () },
            metadata: self.metadata,
            current_quality: self.current_quality,
            qualities: self.qualities,
            dash: self.dash,
            earliest_expires_at,
            audio_probe,
        })
    }
}

/// A closed, credential-free media request minted after episode access,
/// non-preview evidence, identity, duration, codec, CDN and range checks.
/// Only the selected clear AAC-LC primary URL and its declared init range occur.
#[derive(Clone)]
pub struct InitRequest {
    url: MediaUrl,
    range_request: mp4::RangeRequest,
}
impl fmt::Debug for InitRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CourseInitRequest")
            .field("range", &self.range_request.range)
            .field("max_body_bytes", &self.range_request.max_body_bytes)
            .finish_non_exhaustive()
    }
}
impl InitRequest {
    pub fn url(&self) -> &Url {
        self.url.url()
    }
    pub fn range_request(&self) -> &mp4::RangeRequest {
        &self.range_request
    }
    pub fn validate(&self) -> Result<()> {
        parse_media_url(self.url.as_str(), unix_seconds()?)?;
        if self.range_request.range.start != 0
            || self.range_request.range.len().map_err(probe_error)?
                != self.range_request.max_body_bytes
            || self.range_request.max_body_bytes == 0
            || self.range_request.max_body_bytes > MAX_INIT_BYTES
            || self.range_request.expected.is_some()
        {
            return Err(Error::InvalidResponse("course_init_range"));
        }
        if Instant::now() >= self.range_request.deadline {
            return Err(Error::Deadline);
        }
        Ok(())
    }
}
fn init_request(audio: &PendingAudio, deadline: Instant) -> Result<InitRequest> {
    let range = mp4::ByteRange {
        start: audio.segment_base.initialization_range.start,
        end: audio.segment_base.initialization_range.end,
    };
    let request = InitRequest {
        url: audio.primary.clone(),
        range_request: mp4::RangeRequest {
            range,
            deadline,
            max_body_bytes: range.len().map_err(probe_error)?,
            expected: None,
        },
    };
    request.validate()?;
    Ok(request)
}
fn probe_error(error: mp4::ProbeError) -> Error {
    match error {
        mp4::ProbeError::Deadline => Error::Deadline,
        mp4::ProbeError::TooLarge => Error::TooLarge,
        mp4::ProbeError::Unsupported => Error::Restricted("course_audio_init_unsupported"),
        mp4::ProbeError::InvalidResponse => Error::InvalidResponse("course_audio_init_response"),
        mp4::ProbeError::Transport => Error::Transport,
    }
}

/// Opaque proof minted only after parsing positive whole-playback evidence.
/// Account tier, metadata and arbitrary server callers cannot construct it.
#[derive(Debug, Clone)]
pub struct WholeEntitlement {
    _private: (),
}
impl WholeEntitlement {
    pub fn is_whole(&self) -> bool {
        true
    }
}
impl Resolved {
    pub fn whole_entitlement(&self) -> &WholeEntitlement {
        &self.entitlement
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    Season,
    PlayUrl,
}
impl Endpoint {
    fn url(self) -> &'static str {
        match self {
            Self::Season => "https://api.bilibili.com/pugv/view/web/season",
            Self::PlayUrl => "https://api.bilibili.com/pugv/player/web/playurl",
        }
    }
}

/// Closed request construction. The exact viewer's normal Bilibili cookie is
/// carried solely to the two fixed APIs; it is never a media header.
pub struct Request {
    endpoint: Endpoint,
    url: Url,
    cookie: Option<Cookie>,
}
impl fmt::Debug for Request {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CourseRequest")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}
impl Request {
    pub fn endpoint(&self) -> Endpoint {
        self.endpoint
    }
    pub fn url(&self) -> &Url {
        &self.url
    }
    pub fn cookie(&self) -> Option<&Cookie> {
        self.cookie.as_ref()
    }
    pub fn max_response_bytes(&self) -> usize {
        MAX_BYTES
    }
    pub fn validate(&self) -> Result<()> {
        let expected = Url::parse(self.endpoint.url()).expect("fixed PUGV course endpoint");
        if self.url.scheme() != "https"
            || self.url.host_str() != expected.host_str()
            || self.url.path() != expected.path()
            || self.url.port().is_some()
            || !self.url.username().is_empty()
            || self.url.password().is_some()
            || self.url.fragment().is_some()
            || self.url.as_str().len() > 2048
        {
            return Err(Error::Restricted("course_origin_denied"));
        }
        let pairs = self.url.query_pairs().collect::<Vec<_>>();
        let expected_keys: &[&str] = match self.endpoint {
            Endpoint::Season => &["ep_id"],
            Endpoint::PlayUrl => &["ep_id", "avid", "cid", "qn", "fnval", "fnver", "fourk"],
        };
        if pairs.len() != expected_keys.len()
            || pairs
                .iter()
                .zip(expected_keys)
                .any(|((name, value), expected)| {
                    name != expected || !decimal(value) && !matches!(*expected, "fnver")
                })
        {
            return Err(Error::InvalidResponse("course_request_query"));
        }
        if self.endpoint == Endpoint::PlayUrl
            && (pairs[4].1 != "16"
                || pairs[5].1 != "0"
                || pairs[6].1 != "1"
                || !matches!(
                    pairs[3].1.as_ref(),
                    "16" | "32" | "64" | "80" | "120" | "127"
                ))
        {
            return Err(Error::InvalidResponse("course_request_query"));
        }
        if let Some(cookie) = self.cookie() {
            Cookie::from_header(cookie.expose_for_storage())?;
        }
        Ok(())
    }
}
fn request(
    endpoint: Endpoint,
    pairs: &[(&str, String)],
    cookie: Option<&Cookie>,
) -> Result<Request> {
    let mut url = Url::parse(endpoint.url()).expect("fixed PUGV course endpoint");
    url.query_pairs_mut()
        .extend_pairs(pairs.iter().map(|(name, value)| (*name, value.as_str())));
    let result = Request {
        endpoint,
        url,
        cookie: cookie.cloned(),
    };
    result.validate()?;
    Ok(result)
}
pub fn metadata_request(reference: &EpisodeRef, cookie: Option<&Cookie>) -> Result<Request> {
    let checked = parse_resource(&reference.canonical())?;
    request(Endpoint::Season, &[("ep_id", checked.ep_id)], cookie)
}
pub fn play_request(
    metadata: &Metadata,
    max_height: Option<u32>,
    cookie: Option<&Cookie>,
) -> Result<Request> {
    metadata.validate()?;
    request(
        Endpoint::PlayUrl,
        &[
            ("ep_id", metadata.ep_id.clone()),
            ("avid", metadata.aid.clone()),
            ("cid", metadata.cid.clone()),
            ("qn", requested_qn(max_height)?.to_string()),
            ("fnval", "16".into()),
            ("fnver", "0".into()),
            ("fourk", "1".into()),
        ],
        cookie,
    )
}

/// Pixel height and Bilibili qn identifiers are deliberately separate concepts.
fn requested_qn(max_height: Option<u32>) -> Result<u32> {
    match max_height {
        None | Some(4320) => Ok(127),
        Some(2160) => Ok(120),
        Some(1080 | 1440) => Ok(80),
        Some(720) => Ok(64),
        Some(480) => Ok(32),
        Some(144 | 240 | 360) => Ok(16),
        _ => Err(Error::InvalidResponse("course_requested_max_height")),
    }
}

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}
impl fmt::Debug for Response {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CourseResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish()
    }
}
pub trait Transport: Send + Sync {
    fn get_course<'a>(
        &'a self,
        request: Request,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>>;
    fn read_course_init<'a>(
        &'a self,
        request: InitRequest,
    ) -> Pin<Box<dyn Future<Output = Result<mp4::RangeResponse>> + Send + 'a>>;
}
pub struct Client<T: Transport> {
    transport: T,
    cookie: Option<Cookie>,
}
impl<T: Transport> Client<T> {
    pub fn new(transport: T, cookie: Option<Cookie>) -> Self {
        Self { transport, cookie }
    }
    async fn send(&self, request: Request, deadline: Instant) -> Result<Response> {
        request.validate()?;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        let response =
            tokio::time::timeout_at(deadline, self.transport.get_course(request, deadline))
                .await
                .map_err(|_| Error::Deadline)??;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        if response.status != 200 {
            return Err(Error::Status(response.status));
        }
        if response.body.len() > MAX_BYTES {
            return Err(Error::TooLarge);
        }
        Ok(response)
    }
    pub async fn view(&self, reference: &EpisodeRef, deadline: Instant) -> Result<Metadata> {
        let response = self
            .send(metadata_request(reference, self.cookie.as_ref())?, deadline)
            .await?;
        let metadata = parse_metadata_response(&response.body, reference)?;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        Ok(metadata)
    }
    pub async fn resolve(
        &self,
        input: &str,
        max_height: Option<u32>,
        deadline: Instant,
    ) -> Result<Resolved> {
        let reference = parse_resource(input)?;
        requested_qn(max_height)?;
        let metadata = self.view(&reference, deadline).await?;
        let response = self
            .send(
                play_request(&metadata, max_height, self.cookie.as_ref())?,
                deadline,
            )
            .await?;
        // Exactly one playurl request: denied access, challenges and changed
        // entitlement never trigger a retry, refresh, lower API or other account.
        let pending =
            parse_playurl_response(&response.body, &metadata, max_height, unix_seconds()?)?;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        if pending.audio.sampling_rate.is_some() {
            return pending.finish_without_probe();
        }
        // One selected-track initialization request, never a full download,
        // alternate quality, backup, different account or denial retry.
        let request = init_request(&pending.audio, deadline)?;
        let range = request.range_request.clone();
        let response = tokio::time::timeout_at(deadline, self.transport.read_course_init(request))
            .await
            .map_err(|_| Error::Deadline)??;
        let identity = mp4::validate_range_headers(&range, response.status, &response.headers)
            .map_err(probe_error)?;
        if identity.total_bytes <= pending.audio.segment_base.index_range.end {
            return Err(Error::InvalidResponse("course_audio_total_identity"));
        }
        if response.body.len() > MAX_INIT_BYTES {
            return Err(Error::TooLarge);
        }
        if response.body.len() != range.range.len().map_err(probe_error)? {
            return Err(Error::InvalidResponse("course_audio_init_response"));
        }
        let init = mp4::parse_initialization(&response.body, mp4::TrackKind::Audio)
            .map_err(probe_error)?;
        let sample_rate = match init.codec {
            mp4::Codec::AacLc { sample_rate, .. } => sample_rate,
            _ => return Err(Error::Restricted("course_audio_init_unsupported")),
        };
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        pending.finish(Some((
            sample_rate,
            AudioProbeIdentity {
                total_bytes: identity.total_bytes,
                strong_etag: identity.etag.filter(|etag| !etag.starts_with("W/")),
            },
        )))
    }
}

pub fn parse_metadata_response(bytes: &[u8], requested: &EpisodeRef) -> Result<Metadata> {
    let checked = parse_resource(&requested.canonical())?;
    let value = strict_json(bytes, MAX_BYTES)?;
    check_code(&value)?;
    let data = object(field(&value, "data")?)?;
    let season_id = id(field(data, "season_id")?)?;
    let title = text(field(data, "title")?, 4096)?.to_owned();
    // Purchase status, paid_view, has_paid, labels and account tier cannot grant
    // rights. Scan season-level denials without unrelated episode permissions.
    deny_flags(data, true, false)?;
    let episodes = array(field(data, "episodes")?, MAX_EPISODES)?;
    if episodes.is_empty() {
        return Err(Error::InvalidResponse("course_episodes"));
    }
    let mut seen = HashSet::new();
    let mut selected = None;
    for episode in episodes {
        let episode = object(episode)?;
        let ep_id = id(alias(episode, &["id", "ep_id"])?)?;
        if !seen.insert(ep_id.clone()) {
            return Err(Error::InvalidResponse("course_duplicate_episode"));
        }
        if ep_id != checked.ep_id {
            continue;
        }
        deny_flags(episode, true, false)?;
        // Exact known source-shaped values, never truthy strings or an absent
        // flag. Future publication/permission values require reviewed fixtures.
        if field(episode, "playable")?.as_bool() != Some(true)
            || field(episode, "episode_can_view")?.as_bool() != Some(true)
            || field(episode, "ep_status")?.as_i64() != Some(0)
            || field(episode, "status")?.as_u64() != Some(1)
        {
            return Err(Error::Restricted("course_episode_access_required"));
        }
        if field(episode, "from")?.as_str() != Some("pugv") {
            return Err(Error::InvalidResponse("course_episode_type"));
        }
        let episode_title = text(field(episode, "title")?, 4096)?.to_owned();
        let aid = id(field(episode, "aid")?)?;
        let cid = id(field(episode, "cid")?)?;
        // Course metadata uses seconds; playurl timelength is milliseconds.
        let duration_ms =
            bounded_u64(field(episode, "duration")?, 1, MAX_DURATION_MS / 1000)? * 1000;
        let access = EpisodeAccess {
            season_id: season_id.clone(),
            ep_id: ep_id.clone(),
            aid: aid.clone(),
            cid: cid.clone(),
            duration_ms,
        };
        let metadata = Metadata {
            season_id: season_id.clone(),
            ep_id,
            aid,
            cid,
            title: title.clone(),
            episode_title,
            duration_ms,
            access,
        };
        metadata.validate()?;
        if let Some(episode_season) = episode.get("season_id")
            && id(episode_season)? != metadata.season_id
        {
            return Err(Error::InvalidResponse("course_episode_season_identity"));
        }
        selected = Some(metadata);
    }
    selected.ok_or(Error::InvalidResponse("course_episode_missing"))
}

fn full_view_evidence(data: &Value) -> Result<()> {
    // Maintained yutto's course handler explicitly classifies is_preview=1 as
    // preview. A pinned independent PUGV fixture supplies numeric 0 for a whole
    // authorized episode. Missing, boolean, null, string and future values fail.
    // has_paid is deliberately ignored: false also occurs on full free episodes.
    if field(data, "is_preview")?.as_u64() != Some(0) {
        return Err(Error::Restricted("course_full_view_required"));
    }
    Ok(())
}

/// Unknown/missing/contradictory entitlement is rejected before DASH parsing.
pub fn parse_playurl_response(
    bytes: &[u8],
    metadata: &Metadata,
    max_height: Option<u32>,
    now: u64,
) -> Result<PendingResolved> {
    metadata.validate()?;
    let qn = requested_qn(max_height)?;
    let value = strict_json(bytes, MAX_BYTES)?;
    check_code(&value)?;
    let video_info = object(field(&value, "data")?)?;
    check_code(video_info)?;
    deny_flags(video_info, true, true)?;
    full_view_evidence(video_info)?;
    // Supplied echoes must agree with the immutable selected-episode evidence.
    // Omitted echoes are bound by the closed ep_id/avid/cid request descriptor.
    for (names, expected) in [
        (&["ep_id", "episode_id"][..], &metadata.ep_id),
        (&["cid"][..], &metadata.cid),
        (&["season_id"][..], &metadata.season_id),
        (&["aid", "avid"][..], &metadata.aid),
    ] {
        if let Some(actual) = optional_alias(video_info, names)?
            && id(actual)? != *expected
        {
            return Err(Error::InvalidResponse("course_playurl_identity"));
        }
    }
    // Maintained course consumers select the main data.dash lesson, not the
    // separate fragment_videos post-roll. Only the observed independent POST
    // metadata shape is accepted; no fragment URL is fetched or exposed.
    validate_post_fragments(video_info, metadata)?;
    let current_quality = bounded_u32(field(video_info, "quality")?, 1, 127)?;
    if current_quality > qn {
        return Err(Error::InvalidResponse("course_quality_ceiling"));
    }
    let duration_ms = bounded_u64(field(video_info, "timelength")?, 1000, MAX_DURATION_MS)?;
    if duration_ms.abs_diff(metadata.duration_ms) > 1500 {
        return Err(Error::Restricted("course_preview_or_duration_mismatch"));
    }
    if video_info.get("durl").is_some_and(|value| {
        !value.is_null() && value.as_array().is_none_or(|items| !items.is_empty())
    }) {
        return Err(Error::Restricted("course_progressive_unsupported"));
    }
    let raw_dash = object(field(video_info, "dash")?)?;
    let audio = parse_pending_audio(raw_dash, now)?;
    // Existing UGC parsing is unchanged. Reuse its bounded video/manifest path
    // with audio separated into an explicitly unknown-rate course-only model.
    let mut video_dash = raw_dash.clone();
    for name in ["audio", "dolby", "flac"] {
        video_dash
            .as_object_mut()
            .expect("checked object")
            .remove(name);
    }
    let mut dash = parse_dash(&video_dash, metadata.duration_seconds(), now)?;
    if (dash.duration_seconds * 1000.0 - metadata.duration_ms as f64).abs() > 1500.0 {
        return Err(Error::Restricted("course_preview_or_duration_mismatch"));
    }
    // Parse all raw tracks first, so unsupported families cannot hide malformed
    // URLs, duplicate identities or ranges. Then expose only ordinary clear MP4.
    let raw_playback = Playback::Dash(dash.clone());
    let mut qualities = parse_qualities(video_info, current_quality, &raw_playback)?;
    dash.video.retain(|track| {
        track.codec == VideoCodec::Avc
            && track.quality_id <= current_quality
            && max_height.is_none_or(|height| track.height <= height)
    });
    if dash.video.is_empty() {
        return Err(Error::Restricted("course_clear_avc_aac_unavailable"));
    }
    for quality in &mut qualities {
        quality.available = dash
            .video
            .iter()
            .any(|track| track.quality_id == quality.id);
    }
    Ok(PendingResolved {
        metadata: metadata.clone(),
        current_quality,
        qualities,
        dash,
        audio,
    })
}

fn validate_post_fragments(data: &Value, metadata: &Metadata) -> Result<()> {
    let Some(fragments) = data.get("fragment_videos").filter(|value| !value.is_null()) else {
        return Ok(());
    };
    for fragment in array(fragments, 1)? {
        let fragment = object(fragment)?;
        let info = object(field(fragment, "fragment_info")?)?;
        let aid = id(field(info, "aid")?)?;
        let cid = id(field(info, "cid")?)?;
        if field(info, "fragment_type")?.as_str() != Some("PUGV_FRAGMENT")
            || field(info, "fragment_position")?.as_str() != Some("POST")
            || field(info, "index")?.as_u64() != Some(0)
            || aid == metadata.aid
            || cid == metadata.cid
            || field(fragment, "playable_status")?.as_bool().is_none()
        {
            return Err(Error::Restricted("course_fragments_unsupported"));
        }
        let video = object(field(fragment, "video_info")?)?;
        if id(field(video, "cid")?)? != cid {
            return Err(Error::InvalidResponse("course_fragment_identity"));
        }
        bounded_u64(field(video, "timelength")?, 1000, MAX_DURATION_MS)?;
    }
    Ok(())
}

fn parse_pending_audio(dash: &Value, now: u64) -> Result<PendingAudio> {
    let mut tracks = Vec::new();
    if let Some(values) = dash.get("audio").filter(|value| !value.is_null()) {
        tracks.extend(array(values, 32)?.iter());
    }
    if let Some(dolby) = dash.get("dolby").filter(|value| !value.is_null())
        && let Some(values) = object(dolby)?.get("audio").filter(|value| !value.is_null())
    {
        tracks.extend(array(values, 8)?.iter());
    }
    if let Some(flac) = dash.get("flac").filter(|value| !value.is_null())
        && let Some(track) = object(flac)?.get("audio").filter(|value| !value.is_null())
    {
        tracks.push(track);
    }
    if tracks.len() > 40 {
        return Err(Error::TooLarge);
    }
    let mut seen = HashSet::new();
    let mut compatible = Vec::new();
    for track in tracks {
        let track = object(track)?;
        let id = bounded_u32(field(track, "id")?, 1, 100_000)?;
        let codecs = codec_text(field(track, "codecs")?)?;
        let codec = if codecs.starts_with("mp4a.") {
            AudioCodec::Aac
        } else if matches!(codecs.as_str(), "fLaC" | "flac") {
            AudioCodec::Flac
        } else if matches!(codecs.as_str(), "ec-3" | "ac-3") {
            AudioCodec::Dolby
        } else {
            return Err(Error::InvalidResponse("audio_codec"));
        };
        let key = format!("a-{id}-{codecs}");
        if !seen.insert(key.clone()) {
            return Err(Error::InvalidResponse("duplicate_audio_track"));
        }
        let mime_type = text(alias(track, &["mimeType", "mime_type"])?, 64)?.to_owned();
        if mime_type != "audio/mp4" {
            return Err(Error::InvalidResponse("audio_mime"));
        }
        let sampling_rate = optional_alias(track, &["audioSamplingRate", "audio_sampling_rate"])?
            .map(|value| {
                let rate = numeric_string(value)?
                    .parse::<u32>()
                    .map_err(|_| Error::InvalidResponse("sampling_rate"))?;
                if !(8000..=384000).contains(&rate) {
                    return Err(Error::InvalidResponse("sampling_rate"));
                }
                Ok(rate)
            })
            .transpose()?;
        let (primary, backups) = media_addresses(track, &["baseUrl", "base_url"], now)?;
        let parsed = PendingAudio {
            key,
            id,
            codec,
            codecs,
            mime_type,
            bandwidth: bounded_u64(field(track, "bandwidth")?, 1, 100_000_000)?,
            sampling_rate,
            start_with_sap: optional_sap(track)?,
            segment_base: parse_segment_base(track)?,
            primary,
            backups,
        };
        if parsed.codec == AudioCodec::Aac
            && parsed.codecs == "mp4a.40.2"
            && parsed.bandwidth <= MAX_CLEAR_AUDIO_BANDWIDTH
            && parsed.sampling_rate.is_none_or(|rate| rate <= 96000)
        {
            compatible.push(parsed);
        }
    }
    // Descriptor delivery uses one audio track. Probe only that selected track,
    // not every advertised family, and do not fall back after a failed probe.
    compatible
        .into_iter()
        .max_by_key(|audio| (audio.bandwidth, audio.id))
        .ok_or(Error::Restricted("course_clear_avc_aac_unavailable"))
}

fn deny_flags(value: &Value, recursive: bool, playback: bool) -> Result<()> {
    if let Value::Object(fields) = value {
        for (name, child) in fields {
            // Advertisement of an unavailable quality is not an access denial.
            // Main episode lists also contain unrelated locked episodes.
            if name == "support_formats" {
                deny_format_protection(child)?;
                continue;
            }
            if matches!(name.as_str(), "episodes" | "section" | "sections") {
                continue;
            }
            let normalized = name.replace('_', "").to_ascii_lowercase();
            let denied = match normalized.as_str() {
                "ispreview" | "preview" | "isdrm" | "isencrypted" | "encrypted" | "arealimit"
                | "isblock" | "isexpired" => boolish(child)?,
                "needlogin" | "needvip" | "needpay" if playback => boolish(child)?,
                "canplay" | "isplayable" | "isavailable" | "canwatch" | "playable"
                | "episodecanview" => !boolish(child)?,
                "drmtechtype" => child.as_u64() != Some(0),
                _ if normalized.contains("drm")
                    || normalized.contains("license")
                    || normalized.contains("encrypt")
                    || matches!(
                        normalized.as_str(),
                        "widevine" | "playready" | "fairplay" | "contentprotection"
                    ) =>
                {
                    !matches!(child, Value::Null | Value::Bool(false)) && child.as_u64() != Some(0)
                }
                _ => false,
            };
            if denied {
                return Err(Error::Restricted("course_access_geo_or_drm_denied"));
            }
            if recursive {
                deny_flags(child, true, playback)?;
            }
        }
    } else if recursive && let Value::Array(values) = value {
        for value in values {
            deny_flags(value, true, playback)?;
        }
    }
    Ok(())
}

fn deny_format_protection(value: &Value) -> Result<()> {
    match value {
        Value::Object(fields) => {
            for (name, child) in fields {
                let normalized = name.replace('_', "").to_ascii_lowercase();
                if (normalized.contains("drm")
                    || normalized.contains("license")
                    || normalized.contains("encrypt")
                    || matches!(
                        normalized.as_str(),
                        "widevine" | "playready" | "fairplay" | "contentprotection"
                    ))
                    && !matches!(child, Value::Null | Value::Bool(false))
                    && child.as_u64() != Some(0)
                {
                    return Err(Error::Restricted("course_access_geo_or_drm_denied"));
                }
                deny_format_protection(child)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                deny_format_protection(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests;
