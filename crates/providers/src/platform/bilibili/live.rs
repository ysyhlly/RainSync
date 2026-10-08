//! Dedicated clear Bilibili HLS live-edge adapter. Never a finite VOD resolver.
//! Provenance and offline-only acceptance limits: `live/BOUNDARY.md`.
//! Provider addresses and account state are deliberately non-serializable and
//! redacted in Debug. The caller binds the exact viewer and broadcast grant.
use super::{
    Cookie, Error, Result, array, bounded_u32, check_code, decimal, field, id, object, strict_json,
    text, unix_seconds,
};
use reqwest::Url;
use serde_json::Value;
use std::{fmt, future::Future, pin::Pin};
use tokio::time::Instant;

pub mod playlist;
mod ts;
pub use playlist::{Playlist, RollingWindow, Segment, parse_playlist};
pub(crate) use ts::validate_clear_ts;
pub const MAX_API_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PLAYLIST_BYTES: usize = 128 * 1024;
pub const MAX_SEGMENT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_LIVE_GRANT_SECONDS: u64 = 120;
const QUALITY: u32 = 150;
const MAX_URL_BYTES: usize = 8192;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomRef {
    pub room_id: String,
}
impl RoomRef {
    pub fn canonical(&self) -> String {
        format!("https://live.bilibili.com/{}", self.room_id)
    }
}
/// Exact HTTPS room pages only. Short room aliases are resolved by get_info,
/// never treated as the canonical room or broadcast identity.
pub fn parse_resource(input: &str) -> Result<RoomRef> {
    if input.len() > 2048
        || input.trim() != input
        || !input.is_ascii()
        || input.bytes().any(|b| b <= b' ' || b == 127 || b == b'\\')
    {
        return Err(Error::InvalidResource);
    }
    let url = Url::parse(input).map_err(|_| Error::InvalidResource)?;
    if url.scheme() != "https"
        || url.host_str() != Some("live.bilibili.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || input != format!("https://live.bilibili.com{}", url.path())
    {
        return Err(Error::InvalidResource);
    }
    let path = url
        .path()
        .strip_prefix("/blanc/")
        .or_else(|| url.path().strip_prefix('/'))
        .ok_or(Error::InvalidResource)?;
    let room_id = path.strip_suffix('/').unwrap_or(path);
    if !decimal(room_id) {
        return Err(Error::InvalidResource);
    }
    Ok(RoomRef {
        room_id: room_id.into(),
    })
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Metadata {
    pub room_id: String,
    pub uid: String,
    /// UTC epoch seconds derived from the provider's UTC+8 room live_time.
    pub started_at: u64,
    pub broadcast_id: String,
    pub title: String,
}
impl Metadata {
    pub fn canonical(&self) -> String {
        RoomRef {
            room_id: self.room_id.clone(),
        }
        .canonical()
    }
    pub fn validate(&self) -> Result<()> {
        if !decimal(&self.room_id)
            || !decimal(&self.uid)
            || !(946_684_800..=4_102_444_800).contains(&self.started_at)
            || self.broadcast_id != format!("{}:{}:{}", self.room_id, self.uid, self.started_at)
            || self.title.is_empty()
            || self.title.len() > 4096
            || self.title.chars().any(char::is_control)
        {
            return Err(Error::InvalidResponse("live_broadcast_identity"));
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct Resolved {
    pub metadata: Metadata,
    pub current_quality: u32,
    pub playlist_url: String,
    pub expires_at: Option<u64>,
}
impl fmt::Debug for Resolved {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BilibiliLive")
            .field("metadata", &self.metadata)
            .field("current_quality", &self.current_quality)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    RoomInfo,
    PlayInfo,
}
impl Endpoint {
    fn url(self) -> &'static str {
        match self {
            Self::RoomInfo => "https://api.live.bilibili.com/room/v1/Room/get_info",
            Self::PlayInfo => {
                "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo"
            }
        }
    }
}
pub struct Request {
    endpoint: Endpoint,
    url: Url,
    cookie: Option<Cookie>,
}
impl fmt::Debug for Request {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BilibiliLiveRequest")
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
        MAX_API_BYTES
    }
    pub fn validate(&self) -> Result<()> {
        let fixed = Url::parse(self.endpoint.url()).expect("fixed live endpoint");
        if self.url.scheme() != "https"
            || self.url.host_str() != fixed.host_str()
            || self.url.path() != fixed.path()
            || self.url.port().is_some()
            || !self.url.username().is_empty()
            || self.url.password().is_some()
            || self.url.fragment().is_some()
            || self.url.as_str().len() > 2048
        {
            return Err(Error::Restricted("live_api_origin_denied"));
        }
        let pairs = self.url.query_pairs().collect::<Vec<_>>();
        let expected: &[(&str, &str)] = match self.endpoint {
            Endpoint::RoomInfo => &[("room_id", "")],
            Endpoint::PlayInfo => &[
                ("room_id", ""),
                ("protocol", "1"),
                ("format", "1"),
                ("codec", "0"),
                ("qn", "150"),
                ("platform", "web"),
                ("ptype", "8"),
            ],
        };
        if pairs.len() != expected.len()
            || pairs.iter().zip(expected).any(|((k, v), (ek, ev))| {
                k != ek
                    || if *ek == "room_id" {
                        !decimal(v)
                    } else {
                        v != ev
                    }
            })
        {
            return Err(Error::Restricted("live_api_query_denied"));
        }
        if let Some(cookie) = self.cookie() {
            Cookie::from_header(cookie.expose_for_storage())?;
        }
        Ok(())
    }
}
fn request(endpoint: Endpoint, room: &str, cookie: Option<&Cookie>) -> Result<Request> {
    if !decimal(room) {
        return Err(Error::InvalidResource);
    }
    let mut url = Url::parse(endpoint.url()).expect("fixed live endpoint");
    url.query_pairs_mut().append_pair("room_id", room);
    if endpoint == Endpoint::PlayInfo {
        url.query_pairs_mut().extend_pairs([
            ("protocol", "1"),
            ("format", "1"),
            ("codec", "0"),
            ("qn", "150"),
            ("platform", "web"),
            ("ptype", "8"),
        ]);
    }
    let result = Request {
        endpoint,
        url,
        cookie: cookie.cloned(),
    };
    result.validate()?;
    Ok(result)
}
pub fn metadata_request(room: &RoomRef, cookie: Option<&Cookie>) -> Result<Request> {
    let checked = parse_resource(&room.canonical())?;
    request(Endpoint::RoomInfo, &checked.room_id, cookie)
}
pub fn play_request(metadata: &Metadata, cookie: Option<&Cookie>) -> Result<Request> {
    metadata.validate()?;
    request(Endpoint::PlayInfo, &metadata.room_id, cookie)
}
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}
impl fmt::Debug for Response {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LiveResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish()
    }
}
pub trait Transport: Send + Sync {
    fn get_live<'a>(
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
        let response =
            tokio::time::timeout_at(deadline, self.transport.get_live(request, deadline))
                .await
                .map_err(|_| Error::Deadline)??;
        if response.status != 200 {
            return Err(Error::Status(response.status));
        }
        if response.body.len() > MAX_API_BYTES {
            return Err(Error::TooLarge);
        }
        Ok(response)
    }
    pub async fn view(&self, room: &RoomRef, deadline: Instant) -> Result<Metadata> {
        let response = self
            .send(metadata_request(room, self.cookie.as_ref())?, deadline)
            .await?;
        parse_metadata_response(&response.body, room)
    }
    /// Exactly one room and one playback request, without retry/fallback. An
    /// imported broadcast fence prevents a later broadcast being substituted.
    pub async fn resolve(
        &self,
        input: &str,
        expected_broadcast: Option<&str>,
        deadline: Instant,
    ) -> Result<Resolved> {
        let room = parse_resource(input)?;
        let metadata = self.view(&room, deadline).await?;
        if expected_broadcast.is_some_and(|b| b != metadata.broadcast_id) {
            return Err(Error::Restricted("live_broadcast_changed"));
        }
        self.resolve_metadata(&metadata, deadline).await
    }
    /// One normal play-info request after a caller has just parsed/verified the
    /// room metadata. The caller must retain its before/after broadcast fence;
    /// this avoids repeating get_info during every admitted rolling reload.
    pub async fn resolve_metadata(
        &self,
        metadata: &Metadata,
        deadline: Instant,
    ) -> Result<Resolved> {
        metadata.validate()?;
        let response = self
            .send(play_request(metadata, self.cookie.as_ref())?, deadline)
            .await?;
        parse_playurl_response(&response.body, metadata, unix_seconds()?)
    }
}
fn deny_protection(value: &Value, depth: usize) -> Result<()> {
    if depth > 24 {
        return Err(Error::TooLarge);
    }
    match value {
        Value::Object(fields) => {
            for (k, v) in fields {
                let key = k.to_ascii_lowercase();
                if matches!(
                    key.as_str(),
                    "drm"
                        | "drm_info"
                        | "drm_type"
                        | "license_url"
                        | "license"
                        | "encryption"
                        | "encrypted"
                        | "is_encrypted"
                        | "is_locked"
                        | "is_hidden"
                        | "is_block"
                        | "need_login"
                        | "need_vip"
                        | "need_pay"
                        | "is_pay"
                        | "is_preview"
                        | "is_trial"
                        | "access_denied"
                        | "geo_blocked"
                        | "area_limit"
                ) && !matches!(v, Value::Null | Value::Bool(false))
                    && v.as_u64() != Some(0)
                    && v.as_str() != Some("")
                {
                    return Err(Error::Restricted("live_protection_denied"));
                }
                deny_protection(v, depth + 1)?;
            }
        }
        Value::Array(items) => {
            for v in items {
                deny_protection(v, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn parse_metadata_response(bytes: &[u8], requested: &RoomRef) -> Result<Metadata> {
    parse_resource(&requested.canonical())?;
    let value = strict_json(bytes, MAX_API_BYTES)?;
    check_code(&value)?;
    deny_protection(&value, 0)?;
    let data = object(field(&value, "data")?)?;
    if bounded_u32(field(data, "live_status")?, 0, 2)? != 1 {
        return Err(Error::Restricted("live_not_broadcasting"));
    }
    let room_id = id(field(data, "room_id")?)?;
    let uid = id(field(data, "uid")?)?;
    // A short alias is allowed only when the endpoint positively returns its
    // canonical room. A supplied short_id must explain any changed identity.
    if room_id != requested.room_id
        && data.get("short_id").map(id).transpose()?.as_deref() != Some(requested.room_id.as_str())
    {
        return Err(Error::InvalidResponse("live_room_identity"));
    }
    let live_time = text(field(data, "live_time")?, 19)?;
    let started_at = parse_room_time(live_time)?;
    let metadata = Metadata {
        broadcast_id: format!("{room_id}:{uid}:{started_at}"),
        room_id,
        uid,
        started_at,
        title: text(field(data, "title")?, 4096)?.to_owned(),
    };
    metadata.validate()?;
    Ok(metadata)
}
pub fn parse_playurl_response(bytes: &[u8], metadata: &Metadata, now: u64) -> Result<Resolved> {
    metadata.validate()?;
    if metadata.started_at > now.saturating_add(60) {
        return Err(Error::InvalidResponse("live_future_broadcast"));
    }
    let value = strict_json(bytes, MAX_API_BYTES)?;
    check_code(&value)?;
    deny_protection(&value, 0)?;
    let data = object(field(&value, "data")?)?;
    for (k, expected) in [("room_id", &metadata.room_id), ("uid", &metadata.uid)] {
        if let Some(v) = data.get(k)
            && id(v)? != *expected
        {
            return Err(Error::InvalidResponse("live_play_identity"));
        }
    }
    if let Some(v) = data.get("live_status")
        && v.as_u64() != Some(1)
    {
        return Err(Error::Restricted("live_not_broadcasting"));
    }
    if let Some(v) = data.get("live_time")
        && v.as_u64() != Some(metadata.started_at)
    {
        return Err(Error::Restricted("live_broadcast_changed"));
    }
    let wrapper = object(field(data, "playurl_info")?)?;
    let playurl = object(field(wrapper, "playurl")?)?;
    let mut selected = None;
    for stream in array(field(playurl, "stream")?, 8)? {
        let stream = object(stream)?;
        let protocol = text(field(stream, "protocol_name")?, 32)?;
        if protocol != "http_hls" {
            return Err(Error::Restricted("live_protocol_denied"));
        }
        for format in array(field(stream, "format")?, 8)? {
            let format = object(format)?;
            if text(field(format, "format_name")?, 32)? != "ts" {
                return Err(Error::Restricted("live_format_denied"));
            }
            for codec in array(field(format, "codec")?, 8)? {
                let codec = object(codec)?;
                if text(field(codec, "codec_name")?, 32)? != "avc" {
                    return Err(Error::Restricted("live_codec_denied"));
                }
                let quality = bounded_u32(field(codec, "current_qn")?, 1, 30_000)?;
                if quality > QUALITY || !matches!(quality, 80 | 150) {
                    return Err(Error::Restricted("live_quality_denied"));
                }
                let base = text(field(codec, "base_url")?, 4096)?;
                if !base.starts_with("/live-bvc/")
                    || base.starts_with("//")
                    || base.contains('#')
                    || base.contains('\\')
                {
                    return Err(Error::Restricted("live_path_denied"));
                }
                let urls = array(field(codec, "url_info")?, 8)?;
                if urls.is_empty() {
                    return Err(Error::InvalidResponse("live_urls_empty"));
                }
                for info in urls {
                    let info = object(info)?;
                    let host = text(field(info, "host")?, 512)?;
                    let extra = text(field(info, "extra")?, 4096)?;
                    let origin = Url::parse(host).map_err(|_| Error::InvalidResource)?;
                    if origin.path() != "/"
                        || origin.query().is_some()
                        || origin.fragment().is_some()
                        || host != format!("https://{}", origin.host_str().unwrap_or(""))
                    {
                        return Err(Error::Restricted("live_origin_denied"));
                    }
                    let address = format!("{host}{base}{extra}");
                    let url = validate_playlist_url(&address)?;
                    let expires_at = expiry(&url, now)?;
                    if selected.is_none() {
                        selected = Some((quality, address, expires_at));
                    }
                }
            }
        }
    }
    let (current_quality, playlist_url, expires_at) =
        selected.ok_or(Error::Restricted("live_clear_hls_unavailable"))?;
    Ok(Resolved {
        metadata: metadata.clone(),
        current_quality,
        playlist_url,
        expires_at,
    })
}
/// Dedicated narrow live CDN policy. VOD/static/image/CDN families do not imply
/// live access. DNS/public-address pinning is an additional transport gate.
pub fn validate_media_url(value: &str) -> Result<Url> {
    if value.is_empty()
        || value.len() > MAX_URL_BYTES
        || !value.is_ascii()
        || value.bytes().any(|b| b <= b' ' || b == 127 || b == b'\\')
        || value.contains('#')
    {
        return Err(Error::InvalidResource);
    }
    let url = Url::parse(value).map_err(|_| Error::InvalidResource)?;
    let host = url.host_str().ok_or(Error::InvalidResource)?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !host.ends_with(".bilivideo.com")
        || host.split('.').any(|s| {
            s.is_empty()
                || s.len() > 63
                || s.starts_with('-')
                || s.ends_with('-')
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
    {
        return Err(Error::Restricted("live_origin_denied"));
    }
    if value
        != format!(
            "https://{host}{}{}",
            url.path(),
            url.query().map(|q| format!("?{q}")).unwrap_or_default()
        )
        || !url.path().starts_with("/live-bvc/")
        || url.path().contains('%')
        || url.path().contains("//")
        || url.path().split('/').any(|s| matches!(s, "." | ".."))
    {
        return Err(Error::Restricted("live_path_denied"));
    }
    Ok(url)
}
pub fn validate_playlist_url(value: &str) -> Result<Url> {
    let url = validate_media_url(value)?;
    if !url.path().ends_with(".m3u8") {
        return Err(Error::Restricted("live_playlist_path_denied"));
    }
    Ok(url)
}
pub fn validate_segment_url(value: &str) -> Result<Url> {
    let url = validate_media_url(value)?;
    if !url.path().ends_with(".ts") {
        return Err(Error::Restricted("live_segment_path_denied"));
    }
    Ok(url)
}
fn expiry(url: &Url, now: u64) -> Result<Option<u64>> {
    let mut expires = None;
    for (k, v) in url.query_pairs() {
        if k == "expires" {
            if expires.is_some() || !decimal(&v) {
                return Err(Error::InvalidResponse("live_expiry"));
            }
            let n = v
                .parse::<u64>()
                .map_err(|_| Error::InvalidResponse("live_expiry"))?;
            if n <= now || n > now.saturating_add(24 * 3600) {
                return Err(Error::Restricted("live_url_expired"));
            }
            expires = Some(n);
        }
    }
    Ok(expires)
}
/// A known signed URL expiry also bounds the individual CDN fetch. Unknown
/// expiry is bounded by the immutable application grant and20s HTTP deadline.
pub(crate) fn media_remaining_seconds(url: &Url) -> Result<Option<u64>> {
    let now = unix_seconds()?;
    expiry(url, now)?
        .map(|expires| {
            expires
                .checked_sub(now)
                .filter(|n| *n > 0)
                .ok_or(Error::Restricted("live_url_expired"))
        })
        .transpose()
}
fn parse_room_time(value: &str) -> Result<u64> {
    if !value.is_ascii() || value.len() != 19 || value.as_bytes()[10] != b' ' {
        return Err(Error::InvalidResponse("live_started_at"));
    }
    let iso = format!("{}T{}+08:00", &value[..10], &value[11..]);
    let millis = playlist::parse_program_date_time(&iso)?;
    u64::try_from(millis / 1000).map_err(|_| Error::InvalidResponse("live_started_at"))
}
#[cfg(test)]
mod tests;
