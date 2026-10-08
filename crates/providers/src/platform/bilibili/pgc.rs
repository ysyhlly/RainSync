//! Fail-closed, single-episode PGC adapter, separate from ordinary UGC VOD.
//!
//! Endpoint/envelope provenance and fixture limits are recorded in
//! `pgc/BOUNDARY.md`. The v2 playurl response must positively identify whole
//! playback before any CDN descriptor is exposed. Metadata, status 0, duration,
//! a VIP account or the presence of playable URLs never establishes entitlement.
//! No alternative account, region, legacy API, UGC or webpage fallback exists.
use super::{
    AudioCodec, Cookie, Dash, Error, Playback, Quality, Result, VideoCodec, alias, array, boolish,
    bounded_u32, bounded_u64, check_code, decimal, field, id, object, optional_alias, parse_dash,
    parse_qualities, playback_expiry, strict_json, text, unix_seconds, valid_bv,
};
use reqwest::Url;
use serde_json::Value;
use std::{collections::HashSet, fmt, future::Future, pin::Pin};
use tokio::time::Instant;

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_EPISODES: usize = 2_000;
const MAX_SECTIONS: usize = 100;
const MAX_DURATION_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeRef {
    pub ep_id: String,
}
impl EpisodeRef {
    pub fn canonical(&self) -> String {
        format!("https://www.bilibili.com/bangumi/play/ep{}", self.ep_id)
    }
}

/// Only explicit episodes are supported. Season/media selectors, short links,
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
            .strip_prefix("/bangumi/play/ep")
            .map(|identity| identity.strip_suffix('/').unwrap_or(identity).to_owned())
            .ok_or(Error::InvalidResource)?
    } else {
        input
            .strip_prefix("ep")
            .ok_or(Error::InvalidResource)?
            .to_owned()
    };
    if !decimal(&identity) {
        return Err(Error::InvalidResource);
    }
    Ok(EpisodeRef { ep_id: identity })
}

/// No signed address, account flags or opaque upstream payload is serializable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Metadata {
    pub season_id: String,
    pub ep_id: String,
    pub aid: String,
    pub bvid: String,
    pub cid: String,
    pub title: String,
    pub episode_title: String,
    pub duration_ms: u64,
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
            || !valid_bv(&self.bvid)
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
            return Err(Error::InvalidResponse("pgc_metadata_identity"));
        }
        Ok(())
    }
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
            Self::Season => "https://api.bilibili.com/pgc/view/web/season",
            Self::PlayUrl => "https://api.bilibili.com/pgc/player/web/v2/playurl",
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
        f.debug_struct("PgcRequest")
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
        let expected = Url::parse(self.endpoint.url()).expect("fixed PGC endpoint");
        if self.url.scheme() != "https"
            || self.url.host_str() != expected.host_str()
            || self.url.path() != expected.path()
            || self.url.port().is_some()
            || !self.url.username().is_empty()
            || self.url.password().is_some()
            || self.url.fragment().is_some()
            || self.url.as_str().len() > 2048
        {
            return Err(Error::Restricted("pgc_origin_denied"));
        }
        let pairs = self.url.query_pairs().collect::<Vec<_>>();
        let expected_keys: &[&str] = match self.endpoint {
            Endpoint::Season => &["ep_id"],
            Endpoint::PlayUrl => &["ep_id", "cid", "qn", "fnval", "fnver", "fourk"],
        };
        if pairs.len() != expected_keys.len()
            || pairs
                .iter()
                .zip(expected_keys)
                .any(|((name, value), expected)| {
                    name != expected || !decimal(value) && !matches!(*expected, "fnver")
                })
        {
            return Err(Error::InvalidResponse("pgc_request_query"));
        }
        if self.endpoint == Endpoint::PlayUrl
            && (pairs[3].1 != "4048"
                || pairs[4].1 != "0"
                || pairs[5].1 != "1"
                || !matches!(
                    pairs[2].1.as_ref(),
                    "16" | "32" | "64" | "80" | "120" | "127"
                ))
        {
            return Err(Error::InvalidResponse("pgc_request_query"));
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
    let mut url = Url::parse(endpoint.url()).expect("fixed PGC endpoint");
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
            ("cid", metadata.cid.clone()),
            ("qn", requested_qn(max_height)?.to_string()),
            ("fnval", "4048".into()),
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
        _ => Err(Error::InvalidResponse("pgc_requested_max_height")),
    }
}

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}
impl fmt::Debug for Response {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PgcResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish()
    }
}
pub trait Transport: Send + Sync {
    fn get_pgc<'a>(
        &'a self,
        request: Request,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>>;
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
        let response = tokio::time::timeout_at(deadline, self.transport.get_pgc(request, deadline))
            .await
            .map_err(|_| Error::Deadline)??;
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
        parse_metadata_response(&response.body, reference)
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
        parse_playurl_response(&response.body, &metadata, max_height, unix_seconds()?)
    }
}

pub fn parse_metadata_response(bytes: &[u8], requested: &EpisodeRef) -> Result<Metadata> {
    let checked = parse_resource(&requested.canonical())?;
    let value = strict_json(bytes, MAX_BYTES)?;
    check_pgc_code(&value)?;
    let result = object(field(&value, "result")?)?;
    let season_id = id(field(result, "season_id")?)?;
    let title = text(field(result, "title")?, 4096)?.to_owned();
    // Publication/paid capability metadata is not playback entitlement. Only
    // explicit access/geo/DRM denials are inspected on the selected episode.
    deny_flags(result, true, false)?;
    let mut episodes = Vec::new();
    if let Some(main) = result.get("episodes") {
        episodes.extend(array(main, MAX_EPISODES)?.iter());
    }
    if let Some(sections) = optional_alias(result, &["section", "sections"])? {
        for section in array(sections, MAX_SECTIONS)? {
            let section = object(section)?;
            episodes.extend(array(field(section, "episodes")?, MAX_EPISODES)?.iter());
            if episodes.len() > MAX_EPISODES {
                return Err(Error::TooLarge);
            }
        }
    }
    if episodes.is_empty() || episodes.len() > MAX_EPISODES {
        return Err(Error::InvalidResponse("pgc_episodes"));
    }
    let mut seen = HashSet::new();
    let mut selected = None;
    for episode in episodes {
        let episode = object(episode)?;
        let ep_id = id(alias(episode, &["id", "ep_id"])?)?;
        if !seen.insert(ep_id.clone()) {
            return Err(Error::InvalidResponse("pgc_duplicate_episode"));
        }
        if ep_id != checked.ep_id {
            continue;
        }
        deny_flags(episode, true, false)?;
        let episode_number = text(field(episode, "title")?, 256)?;
        let long_title = match episode.get("long_title") {
            Some(Value::String(value)) if value.is_empty() => None,
            Some(value) => Some(text(value, 3840)?),
            None => None,
        };
        let episode_title = long_title.map_or_else(
            || episode_number.to_owned(),
            |long| format!("{episode_number} {long}"),
        );
        let bvid = text(field(episode, "bvid")?, 12)?.to_owned();
        let metadata = Metadata {
            season_id: season_id.clone(),
            ep_id,
            aid: id(field(episode, "aid")?)?,
            bvid,
            cid: id(field(episode, "cid")?)?,
            title: title.clone(),
            episode_title,
            duration_ms: bounded_u64(field(episode, "duration")?, 1000, MAX_DURATION_MS)?,
        };
        metadata.validate()?;
        if let Some(episode_season) = episode.get("season_id")
            && id(episode_season)? != metadata.season_id
        {
            return Err(Error::InvalidResponse("pgc_episode_season_identity"));
        }
        selected = Some(metadata);
    }
    selected.ok_or(Error::InvalidResponse("pgc_episode_missing"))
}

fn check_pgc_code(value: &Value) -> Result<()> {
    if super::code(value)? == -10403 {
        return Err(Error::Restricted("pgc_entitlement_or_geo_denied"));
    }
    check_code(value)
}

fn full_view_evidence(result: &Value) -> Result<()> {
    let mut positive = false;
    if let Some(check) = result.get("play_check") {
        let detail = field(object(check)?, "play_detail")?;
        if detail.as_str() != Some("PLAY_WHOLE") {
            return Err(Error::Restricted("pgc_full_view_required"));
        }
        positive = true;
    }
    if let Some(kind) = result.get("play_video_type") {
        if kind.as_str() != Some("whole") {
            return Err(Error::Restricted("pgc_full_view_required"));
        }
        positive = true;
    }
    if !positive {
        return Err(Error::Restricted("pgc_full_view_required"));
    }
    Ok(())
}

/// Unknown/missing/contradictory entitlement is rejected before DASH parsing.
pub fn parse_playurl_response(
    bytes: &[u8],
    metadata: &Metadata,
    max_height: Option<u32>,
    now: u64,
) -> Result<Resolved> {
    metadata.validate()?;
    let qn = requested_qn(max_height)?;
    let value = strict_json(bytes, MAX_BYTES)?;
    check_pgc_code(&value)?;
    let result = object(field(&value, "result")?)?;
    deny_flags(result, true, true)?;
    full_view_evidence(result)?;
    let video_info = object(field(result, "video_info")?)?;
    // Supplied identity echoes at either level must agree. The fixed query binds
    // responses without echoes; an echo is never allowed to override metadata.
    for container in [result, video_info] {
        for (names, expected) in [
            (&["ep_id", "episode_id"][..], &metadata.ep_id),
            (&["cid"][..], &metadata.cid),
            (&["season_id"][..], &metadata.season_id),
            (&["aid"][..], &metadata.aid),
        ] {
            if let Some(actual) = optional_alias(container, names)?
                && id(actual)? != *expected
            {
                return Err(Error::InvalidResponse("pgc_playurl_identity"));
            }
        }
        if let Some(actual) = container.get("bvid")
            && text(actual, 12)? != metadata.bvid
        {
            return Err(Error::InvalidResponse("pgc_playurl_identity"));
        }
    }
    let current_quality = bounded_u32(field(video_info, "quality")?, 1, 127)?;
    if current_quality > qn {
        return Err(Error::InvalidResponse("pgc_quality_ceiling"));
    }
    let duration_ms = bounded_u64(field(video_info, "timelength")?, 1000, MAX_DURATION_MS)?;
    if duration_ms.abs_diff(metadata.duration_ms) > 1500 {
        return Err(Error::Restricted("pgc_preview_or_duration_mismatch"));
    }
    if video_info.get("durl").is_some_and(|value| {
        !value.is_null() && value.as_array().is_none_or(|items| !items.is_empty())
    }) {
        return Err(Error::Restricted("pgc_progressive_unsupported"));
    }
    let mut dash = parse_dash(field(video_info, "dash")?, metadata.duration_seconds(), now)?;
    if (dash.duration_seconds * 1000.0 - metadata.duration_ms as f64).abs() > 1500.0 {
        return Err(Error::Restricted("pgc_preview_or_duration_mismatch"));
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
    dash.audio
        .retain(|track| track.codec == AudioCodec::Aac && track.codecs == "mp4a.40.2");
    if dash.video.is_empty() || dash.audio.is_empty() {
        return Err(Error::Restricted("pgc_clear_avc_aac_unavailable"));
    }
    for quality in &mut qualities {
        quality.available = dash
            .video
            .iter()
            .any(|track| track.quality_id == quality.id);
    }
    let earliest_expires_at = playback_expiry(&Playback::Dash(dash.clone()));
    Ok(Resolved {
        entitlement: WholeEntitlement { _private: () },
        metadata: metadata.clone(),
        current_quality,
        qualities,
        dash,
        earliest_expires_at,
    })
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
                | "isblock" => boolish(child)?,
                "needlogin" | "needvip" | "needpay" if playback => boolish(child)?,
                "canplay" | "isplayable" | "isavailable" | "canwatch" => !boolish(child)?,
                "drmtechtype" => child.as_u64() != Some(0),
                "permission" => !matches!(child.as_str(), Some("allowed" | "granted")),
                "playvideotype" => child.as_str() != Some("whole"),
                "playdetail" => child.as_str() != Some("PLAY_WHOLE"),
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
                return Err(Error::Restricted("pgc_access_geo_or_drm_denied"));
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
                    return Err(Error::Restricted("pgc_access_geo_or_drm_denied"));
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
