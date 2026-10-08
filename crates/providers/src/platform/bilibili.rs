//! Bounded, server-only Bilibili UGC VOD adapter.
//!
//! Endpoint construction and the WBI permutation/signing procedure were adapted
//! from SyncTV's Bilibili client at ca91048b9da595e50642a61618b0eabfbc05e09b:
//! https://github.com/synctv-org/synctv/blob/ca91048b9da595e50642a61618b0eabfbc05e09b/synctv-media-providers/src/bilibili/client.rs
//! Unlike a browser client, these models deliberately do not implement Serialize.
//! Signed media addresses and account state must never enter frontend responses.
//!
//! MIT License (adapted SyncTV portions)
//! Copyright (c) 2026 SyncTV Contributors
//! Permission is hereby granted, free of charge, to any person obtaining a copy
//! of this software and associated documentation files (the "Software"), to deal
//! in the Software without restriction, including without limitation the rights
//! to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//! copies of the Software, and to permit persons to whom the Software is
//! furnished to do so, subject to the following conditions:
//! The above copyright notice and this permission notice shall be included in all
//! copies or substantial portions of the Software.
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//! IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//! FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//! AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//! LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//! OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//! SOFTWARE.

use md5::{Digest, Md5};
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use tokio::time::Instant;

pub mod auth;
pub mod course;
pub mod cover;
pub mod live;
pub mod pgc;
pub mod renewal;

const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_SMALL_BODY: usize = 64 * 1024;
const MAX_PAGES: usize = 10_000;
const MAX_TRACKS: usize = 128;
const MAX_BACKUPS: usize = 8;
const MAX_DURATION_SECONDS: u64 = 7 * 24 * 60 * 60;
const REFERER: &str = "https://www.bilibili.com/";
const USER_AGENT: &str = "RainSync/0.1 (+server-side authorized media adapter)";

/// Bounded errors never contain upstream response text, signed URLs or cookies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    InvalidResource,
    InvalidResponse(&'static str),
    InvalidQrUrl(QrUrlRejection),
    InvalidJson,
    Restricted(&'static str),
    Api(i64),
    Status(u16),
    Deadline,
    Transport,
    TooLarge,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidResource => f.write_str("bilibili_invalid_resource"),
            Self::InvalidResponse(reason) => write!(f, "bilibili_invalid_response:{reason}"),
            Self::InvalidQrUrl(_) => f.write_str("bilibili_invalid_response:qr_url"),
            Self::InvalidJson => f.write_str("bilibili_invalid_json"),
            Self::Restricted(reason) => write!(f, "bilibili_restricted:{reason}"),
            Self::Api(code) => write!(f, "bilibili_api:{code}"),
            Self::Status(status) => write!(f, "bilibili_http_status:{status}"),
            Self::Deadline => f.write_str("bilibili_deadline"),
            Self::Transport => f.write_str("bilibili_transport"),
            Self::TooLarge => f.write_str("bilibili_response_too_large"),
        }
    }
}
impl std::error::Error for Error {}
type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoId {
    Bv(String),
    Av(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoRef {
    pub id: VideoId,
    pub part: u32,
}

impl VideoRef {
    pub fn canonical(&self) -> String {
        let id = match &self.id {
            VideoId::Bv(id) => id.clone(),
            VideoId::Av(id) => format!("av{id}"),
        };
        format!("https://www.bilibili.com/video/{id}?p={}", self.part)
    }
}

fn valid_bv(value: &str) -> bool {
    value.len() == 12
        && value.starts_with("BV1")
        && value[3..].bytes().all(|c| {
            matches!(c, b'1'..=b'9' | b'A'..=b'H' | b'J'..=b'N' | b'P'..=b'Z' | b'a'..=b'k' | b'm'..=b'z')
        })
}

fn decimal(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 20
        && !value.starts_with('0')
        && value.bytes().all(|c| c.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}

/// Only full BV/AV identifiers and canonical bilibili.com/video URLs are accepted.
/// Short links, embedded player URLs, PGC, courses and live resources are separate
/// adapters, not routes that this VOD resolver silently follows.
pub fn parse_resource(input: &str) -> Result<VideoRef> {
    if input.is_empty()
        || input.len() > 2048
        || input.trim() != input
        || input.chars().any(char::is_control)
    {
        return Err(Error::InvalidResource);
    }
    let (id, query) = if input.starts_with("https://") {
        let url = Url::parse(input).map_err(|_| Error::InvalidResource)?;
        if url.scheme() != "https"
            || !matches!(
                url.host_str(),
                Some("www.bilibili.com" | "m.bilibili.com" | "bilibili.com")
            )
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::InvalidResource);
        }
        let path = url
            .path()
            .strip_prefix("/video/")
            .ok_or(Error::InvalidResource)?;
        let id = path.strip_suffix('/').unwrap_or(path);
        if id.contains('/') || id.contains('%') {
            return Err(Error::InvalidResource);
        }
        (id.to_owned(), url.query().map(str::to_owned))
    } else {
        let (id, query) = input
            .split_once('?')
            .map_or((input, None), |(id, query)| (id, Some(query)));
        (id.to_owned(), query.map(str::to_owned))
    };
    let id = if valid_bv(&id) {
        VideoId::Bv(id)
    } else if let Some(aid) = id.strip_prefix("av").filter(|value| decimal(value)) {
        VideoId::Av(aid.to_owned())
    } else {
        return Err(Error::InvalidResource);
    };
    let part = match query {
        None => 1,
        Some(query) => {
            // No percent-encoded aliases, duplicate p, extra parameters or empty values.
            let value = query.strip_prefix("p=").ok_or(Error::InvalidResource)?;
            if !decimal(value) {
                return Err(Error::InvalidResource);
            }
            value.parse::<u32>().map_err(|_| Error::InvalidResource)?
        }
    };
    if part == 0 || part as usize > MAX_PAGES {
        return Err(Error::InvalidResource);
    }
    Ok(VideoRef { id, part })
}

/// The only upstream endpoints this adapter can construct. Fixture transports
/// intercept requests by this enum; production cannot replace their origins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    View,
    Nav,
    PlayUrl,
    QrGenerate,
    QrPoll,
}

impl Endpoint {
    fn url(self) -> &'static str {
        match self {
            Self::View => "https://api.bilibili.com/x/web-interface/view",
            Self::Nav => "https://api.bilibili.com/x/web-interface/nav",
            Self::PlayUrl => "https://api.bilibili.com/x/player/wbi/playurl",
            Self::QrGenerate => {
                "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
            }
            Self::QrPoll => "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
        }
    }
    fn account_api(self) -> bool {
        matches!(self, Self::View | Self::Nav | Self::PlayUrl)
    }
}

/// Server-internal HTTP descriptor. Its Debug view never reveals header values
/// or query values (QR state and signatures are also secret capabilities).
pub struct ApiRequest {
    endpoint: Endpoint,
    url: Url,
    headers: BTreeMap<String, String>,
}
impl fmt::Debug for ApiRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiRequest")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}
impl ApiRequest {
    fn new(endpoint: Endpoint, query: &[(String, String)], cookie: Option<&Cookie>) -> Self {
        let mut url = Url::parse(endpoint.url()).expect("fixed Bilibili endpoint");
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(
                query
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str())),
            );
        }
        let mut headers = BTreeMap::from([
            ("User-Agent".to_owned(), USER_AGENT.to_owned()),
            (
                "Referer".to_owned(),
                if endpoint.account_api() {
                    REFERER
                } else {
                    "https://passport.bilibili.com/login"
                }
                .to_owned(),
            ),
            ("Accept".to_owned(), "application/json".to_owned()),
        ]);
        if endpoint.account_api()
            && let Some(cookie) = cookie
        {
            headers.insert("Cookie".to_owned(), cookie.0.clone());
        }
        Self {
            endpoint,
            url,
            headers,
        }
    }
    pub fn endpoint(&self) -> Endpoint {
        self.endpoint
    }
    pub fn url(&self) -> Url {
        self.url.clone()
    }
    /// Transport-only accessor; never include these headers in public metadata.
    pub fn headers(&self) -> &BTreeMap<String, String> {
        &self.headers
    }
    pub fn max_response_bytes(&self) -> usize {
        if matches!(self.endpoint, Endpoint::View | Endpoint::PlayUrl) {
            MAX_BODY
        } else {
            MAX_SMALL_BODY
        }
    }
}

pub struct ApiResponse {
    pub status: u16,
    pub body: Vec<u8>,
    /// Transport must bound this collection; only QR success parses it.
    pub set_cookie: Vec<String>,
}
impl fmt::Debug for ApiResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish_non_exhaustive()
    }
}

/// Production implementations must pin public HTTPS DNS, reject redirects and
/// read bodies incrementally up to request.max_response_bytes(). Client checks
/// those bounds again; fixtures need not open a real network connection.
pub trait Transport: Send + Sync {
    fn get<'a>(
        &'a self,
        request: ApiRequest,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + 'a>>;
}

/// Opaque account state. No Serialize, Deserialize or revealing Debug support.
#[derive(Clone)]
pub struct Cookie(String);
impl fmt::Debug for Cookie {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Cookie([REDACTED])")
    }
}
impl Cookie {
    /// Restore server-side encrypted session state, not a frontend cookie import.
    pub fn from_header(header: &str) -> Result<Self> {
        if header.is_empty() || header.len() > 8192 {
            return Err(Error::InvalidResponse("cookie"));
        }
        let mut pairs = BTreeMap::new();
        for pair in header.split(';') {
            let (name, value) = pair
                .trim()
                .split_once('=')
                .ok_or(Error::InvalidResponse("cookie"))?;
            if !cookie_name(name) || !cookie_value(value) || pairs.insert(name, value).is_some() {
                return Err(Error::InvalidResponse("cookie"));
            }
        }
        if !pairs.contains_key("SESSDATA") || !pairs.contains_key("DedeUserID") {
            return Err(Error::InvalidResponse("cookie_identity"));
        }
        if !decimal(pairs["DedeUserID"]) {
            return Err(Error::InvalidResponse("cookie_identity"));
        }
        Ok(Self(
            pairs
                .into_iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join("; "),
        ))
    }
    /// Explicit secret accessor solely for the server's encrypted credential store.
    pub fn expose_for_storage(&self) -> &str {
        &self.0
    }
}
fn cookie_name(name: &str) -> bool {
    matches!(
        name,
        "SESSDATA" | "bili_jct" | "DedeUserID" | "DedeUserID__ckMd5"
    )
}
fn cookie_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value
            .bytes()
            .all(|b| (0x21..=0x7e).contains(&b) && !matches!(b, b';' | b',' | b'"' | b'\\'))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoMetadata {
    pub bvid: String,
    pub aid: String,
    pub cid: String,
    pub part: u32,
    pub part_count: u32,
    pub title: String,
    pub part_title: String,
    pub duration_seconds: u64,
}
impl VideoMetadata {
    pub fn canonical(&self) -> String {
        VideoRef {
            id: VideoId::Bv(self.bvid.clone()),
            part: self.part,
        }
        .canonical()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quality {
    pub id: u32,
    pub label: String,
    pub requires_login: bool,
    pub requires_vip: bool,
    /// Determined by actual returned tracks, not the advertised support list.
    pub available: bool,
}

/// CDN addresses are server-only and never receive account cookies.
#[derive(Clone, PartialEq, Eq)]
pub struct MediaUrl {
    url: Url,
    pub expires_at: Option<u64>,
}
impl fmt::Debug for MediaUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MediaUrl")
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}
impl MediaUrl {
    pub fn as_str(&self) -> &str {
        self.url.as_str()
    }
    pub fn url(&self) -> &Url {
        &self.url
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}
impl fmt::Display for ByteRange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}-{}", self.start, self.end)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentBase {
    pub index_range: ByteRange,
    pub initialization_range: ByteRange,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    Avc,
    Hevc,
    Av1,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioCodec {
    Aac,
    Flac,
    Dolby,
}

#[derive(Debug, Clone)]
pub struct VideoTrack {
    pub key: String,
    pub quality_id: u32,
    pub codec: VideoCodec,
    pub codecs: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: String,
    pub sar: String,
    pub bandwidth: u64,
    pub start_with_sap: u32,
    pub segment_base: SegmentBase,
    pub primary: MediaUrl,
    pub backups: Vec<MediaUrl>,
}
#[derive(Debug, Clone)]
pub struct AudioTrack {
    pub key: String,
    pub id: u32,
    pub codec: AudioCodec,
    pub codecs: String,
    pub mime_type: String,
    pub bandwidth: u64,
    /// Provider-declared rate, when present. Missing metadata is not a measured
    /// value and must not be replaced by a guessed default.
    pub sampling_rate: Option<u32>,
    pub start_with_sap: u32,
    pub segment_base: SegmentBase,
    pub primary: MediaUrl,
    pub backups: Vec<MediaUrl>,
}
#[derive(Debug, Clone)]
pub struct Dash {
    pub duration_seconds: f64,
    pub min_buffer_seconds: f64,
    pub video: Vec<VideoTrack>,
    pub audio: Vec<AudioTrack>,
}
#[derive(Debug, Clone)]
pub struct ProgressiveSegment {
    pub order: u32,
    pub size_bytes: u64,
    pub duration_ms: u64,
    pub primary: MediaUrl,
    pub backups: Vec<MediaUrl>,
}
#[derive(Debug, Clone)]
pub enum Playback {
    Dash(Dash),
    Progressive {
        format: String,
        segments: Vec<ProgressiveSegment>,
    },
}
#[derive(Debug, Clone)]
pub struct ResolvedVideo {
    pub metadata: VideoMetadata,
    pub current_quality: u32,
    pub qualities: Vec<Quality>,
    pub playback: Playback,
    /// Unknown if ANY selected stream or backup lacks a recognized expiry.
    pub earliest_expires_at: Option<u64>,
}

#[derive(Clone)]
pub struct WbiKeys {
    mixin: String,
}
impl fmt::Debug for WbiKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WbiKeys([REDACTED])")
    }
}
#[derive(Debug, Clone)]
pub struct NavInfo {
    pub is_logged_in: bool,
    pub user_id: Option<String>,
    pub username: Option<String>,
    pub wbi: WbiKeys,
}
struct CachedWbi {
    keys: WbiKeys,
    expires: Instant,
    generation: u64,
}

#[derive(Default)]
struct WbiCacheState {
    cached: Option<CachedWbi>,
    generation: u64,
}

/// An opaque cache of signing keys only. Reuse it within one frozen account and
/// login scope; the owner must keep different scopes isolated. No credential,
/// login-validity result, metadata or signed media URL is retained here.
#[derive(Default)]
pub struct WbiKeyCache {
    state: Mutex<WbiCacheState>,
}

pub struct Client<T: Transport> {
    transport: T,
    cookie: Option<Cookie>,
    wbi: Arc<WbiKeyCache>,
}

pub struct VideoPreview {
    pub metadata: VideoMetadata,
    pub cover: Option<cover::CoverUrl>,
}
impl<T: Transport> Client<T> {
    pub fn new(transport: T, cookie: Option<Cookie>) -> Self {
        Self::with_wbi_cache(transport, cookie, Arc::new(WbiKeyCache::default()))
    }

    pub fn with_wbi_cache(transport: T, cookie: Option<Cookie>, wbi: Arc<WbiKeyCache>) -> Self {
        Self {
            transport,
            cookie,
            wbi,
        }
    }

    async fn send(&self, request: ApiRequest, deadline: Instant) -> Result<ApiResponse> {
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        let limit = request.max_response_bytes();
        let response = tokio::time::timeout_at(deadline, self.transport.get(request, deadline))
            .await
            .map_err(|_| Error::Deadline)??;
        if response.status != 200 {
            return Err(Error::Status(response.status));
        }
        if response.body.len() > limit
            || response.set_cookie.len() > 32
            || response.set_cookie.iter().any(|value| value.len() > 8192)
            || response.set_cookie.iter().map(String::len).sum::<usize>() > 32 * 1024
        {
            return Err(Error::TooLarge);
        }
        Ok(response)
    }

    pub async fn nav(&self, deadline: Instant) -> Result<NavInfo> {
        let response = self
            .send(
                ApiRequest::new(Endpoint::Nav, &[], self.cookie.as_ref()),
                deadline,
            )
            .await?;
        parse_nav_response(&response.body)
    }

    async fn wbi_key(&self, deadline: Instant, stale: Option<u64>) -> Result<(WbiKeys, u64)> {
        // Holding one async mutex through the bounded nav request gives single
        // flight refresh. Waiting for the mutex consumes the original deadline.
        let mut cache = tokio::time::timeout_at(deadline, self.wbi.state.lock())
            .await
            .map_err(|_| Error::Deadline)?;
        if let Some(key) = cache.cached.as_ref()
            && key.expires > Instant::now()
            && stale != Some(key.generation)
        {
            return Ok((key.keys.clone(), key.generation));
        }
        cache.generation = cache.generation.saturating_add(1);
        let generation = cache.generation;
        cache.cached = None;
        let nav = self.nav(deadline).await?;
        cache.cached = Some(CachedWbi {
            keys: nav.wbi.clone(),
            expires: Instant::now() + Duration::from_secs(1800),
            generation,
        });
        Ok((nav.wbi, generation))
    }

    pub async fn view(&self, reference: &VideoRef, deadline: Instant) -> Result<VideoMetadata> {
        let (reference, response) = self.view_response(reference, deadline).await?;
        parse_view_response(&response.body, &reference)
    }

    pub async fn view_preview(
        &self,
        reference: &VideoRef,
        deadline: Instant,
    ) -> Result<VideoPreview> {
        let (reference, response) = self.view_response(reference, deadline).await?;
        let metadata = parse_view_response(&response.body, &reference)?;
        let value = strict_json(&response.body, MAX_BODY)?;
        let cover = value["data"]["pic"]
            .as_str()
            .and_then(|value| cover::CoverUrl::parse(value).ok());
        Ok(VideoPreview { metadata, cover })
    }

    async fn view_response(
        &self,
        reference: &VideoRef,
        deadline: Instant,
    ) -> Result<(VideoRef, ApiResponse)> {
        // Revalidate public struct construction before query use.
        let reference = parse_resource(&reference.canonical())?;
        let query = match &reference.id {
            VideoId::Bv(id) => vec![("bvid".to_owned(), id.clone())],
            VideoId::Av(id) => vec![("aid".to_owned(), id.clone())],
        };
        let response = self
            .send(
                ApiRequest::new(Endpoint::View, &query, self.cookie.as_ref()),
                deadline,
            )
            .await?;
        Ok((reference, response))
    }

    pub async fn resolve(
        &self,
        input: &str,
        quality: u32,
        deadline: Instant,
    ) -> Result<ResolvedVideo> {
        let reference = parse_resource(input)?;
        if !matches!(
            quality,
            16 | 32 | 64 | 74 | 80 | 112 | 116 | 120 | 125 | 126 | 127
        ) {
            return Err(Error::InvalidResponse("requested_quality"));
        }
        // Metadata and signing keys are independent. Start both immediately,
        // but do not send playurl until the real CID and keys are available.
        // Both futures keep the original deadline; either failure cancels the
        // other request without creating a background refresh task.
        let (metadata, (mut keys, mut generation)) = tokio::try_join!(
            self.view(&reference, deadline),
            self.wbi_key(deadline, None)
        )?;
        // At most two signed playurl attempts and one forced refresh, all under
        // the original deadline. Unauthorized responses are never retried.
        for attempt in 0..2 {
            let now = unix_seconds()?;
            let query = signed_playurl_query(&metadata, quality, &keys, now)?;
            let response = self
                .send(
                    ApiRequest::new(Endpoint::PlayUrl, &query, self.cookie.as_ref()),
                    deadline,
                )
                .await?;
            match parse_playurl_response(&response.body, &metadata, now) {
                Err(Error::Api(-352)) if attempt == 0 => {
                    (keys, generation) = self.wbi_key(deadline, Some(generation)).await?;
                }
                result => return result,
            }
        }
        Err(Error::Api(-352))
    }

    /// These methods are request constructions for explicitly authorized login
    /// flows. Merely constructing the adapter never generates or polls a QR.
    pub async fn generate_qr(&self, deadline: Instant) -> Result<QrChallenge> {
        let response = self.send(qr_generate_request(), deadline).await?;
        parse_qr_generate_response(&response.body)
    }
    pub async fn poll_qr(&self, key: &QrKey, deadline: Instant) -> Result<QrPoll> {
        let response = self.send(qr_poll_request(key), deadline).await?;
        parse_qr_poll_response(&response.body, &response.set_cookie)
    }
}

fn unix_seconds() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| Error::InvalidResponse("clock"))
}

const MIXIN: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
fn key_from_url(value: &str) -> Result<String> {
    let url = Url::parse(value).map_err(|_| Error::InvalidResponse("wbi_key"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url
            .host_str()
            .is_some_and(|host| host == "hdslb.com" || host.ends_with(".hdslb.com"))
    {
        return Err(Error::InvalidResponse("wbi_key"));
    }
    let name = url.path().rsplit('/').next().unwrap_or_default();
    let (key, ext) = name
        .rsplit_once('.')
        .ok_or(Error::InvalidResponse("wbi_key"))?;
    if key.len() != 32
        || !key.bytes().all(|b| b.is_ascii_hexdigit())
        || !matches!(ext, "png" | "jpg" | "webp")
    {
        return Err(Error::InvalidResponse("wbi_key"));
    }
    Ok(key.to_owned())
}

pub fn parse_nav_response(bytes: &[u8]) -> Result<NavInfo> {
    let value = strict_json(bytes, MAX_SMALL_BODY)?;
    let code = code(&value)?;
    // Anonymous nav legitimately returns -101 together with usable public keys.
    if !matches!(code, 0 | -101) {
        return Err(Error::Api(code));
    }
    let data = object(field(&value, "data")?)?;
    let images = object(field(data, "wbi_img")?)?;
    let combined = format!(
        "{}{}",
        key_from_url(text(field(images, "img_url")?, 2048)?)?,
        key_from_url(text(field(images, "sub_url")?, 2048)?)?
    );
    let mixin = MIXIN[..32]
        .iter()
        .map(|index| combined.as_bytes()[*index] as char)
        .collect();
    let is_logged_in = boolish_optional(data, "isLogin")?.unwrap_or(false);
    if code == -101 && is_logged_in {
        return Err(Error::InvalidResponse("nav_identity"));
    }
    let (user_id, username) = if is_logged_in {
        (
            Some(id(field(data, "mid")?)?),
            Some(text(field(data, "uname")?, 512)?.to_owned()),
        )
    } else {
        (None, None)
    };
    Ok(NavInfo {
        is_logged_in,
        user_id,
        username,
        wbi: WbiKeys { mixin },
    })
}

/// Standard WBI signing, limited to the UGC playurl parameter set.
pub fn signed_playurl_query(
    metadata: &VideoMetadata,
    quality: u32,
    keys: &WbiKeys,
    now: u64,
) -> Result<Vec<(String, String)>> {
    if !valid_bv(&metadata.bvid)
        || !decimal(&metadata.aid)
        || !decimal(&metadata.cid)
        || quality == 0
        || quality > 127
        || now == 0
        || keys.mixin.len() != 32
    {
        return Err(Error::InvalidResponse("playurl_identity"));
    }
    let mut values = BTreeMap::from([
        ("bvid", metadata.bvid.clone()),
        ("cid", metadata.cid.clone()),
        ("qn", quality.to_string()),
        ("fnver", "0".to_owned()),
        ("fnval", "4048".to_owned()),
        ("fourk", "1".to_owned()),
        ("wts", now.to_string()),
    ]);
    // Only validated ASCII identifiers/numbers enter this endpoint. Keep the
    // prescribed value filter explicit to avoid changing WBI semantics later.
    for value in values.values_mut() {
        value.retain(|c| !"!'()*".contains(c));
    }
    let mut unsigned = Url::parse(Endpoint::PlayUrl.url()).expect("fixed endpoint");
    unsigned
        .query_pairs_mut()
        .extend_pairs(values.iter().map(|(key, value)| (*key, value.as_str())));
    let hash_input = format!("{}{}", unsigned.query().unwrap_or_default(), keys.mixin);
    let digest = format!("{:x}", Md5::digest(hash_input.as_bytes()));
    let mut signed = values
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect::<Vec<_>>();
    signed.push(("w_rid".to_owned(), digest));
    Ok(signed)
}

pub fn parse_view_response(bytes: &[u8], requested: &VideoRef) -> Result<VideoMetadata> {
    let value = strict_json(bytes, MAX_BODY)?;
    check_code(&value)?;
    let data = object(field(&value, "data")?)?;
    deny_restrictions(data)?;
    if let Some(state) = data.get("state")
        && state.as_i64() != Some(0)
    {
        return Err(Error::Restricted("unavailable"));
    }
    if data
        .get("redirect_url")
        .is_some_and(|value| value.as_str().is_none_or(|value| !value.is_empty()))
    {
        return Err(Error::Restricted("redirected_resource"));
    }
    let bvid = text(field(data, "bvid")?, 12)?.to_owned();
    let aid = id(field(data, "aid")?)?;
    if !valid_bv(&bvid)
        || match &requested.id {
            VideoId::Bv(value) => value != &bvid,
            VideoId::Av(value) => value != &aid,
        }
    {
        return Err(Error::InvalidResponse("video_identity"));
    }
    let pages = array(field(data, "pages")?, MAX_PAGES)?;
    if pages.is_empty() {
        return Err(Error::InvalidResponse("pages"));
    }
    let mut identities = HashSet::new();
    let mut cids = HashSet::new();
    let mut selected = None;
    for (index, page) in pages.iter().enumerate() {
        let page = object(page)?;
        let number = bounded_u32(field(page, "page")?, 1, MAX_PAGES as u32)?;
        let cid = id(field(page, "cid")?)?;
        if number as usize != index + 1 || !identities.insert(number) || !cids.insert(cid.clone()) {
            return Err(Error::InvalidResponse("page_identity"));
        }
        if number == requested.part {
            selected = Some((
                cid,
                text(field(page, "part")?, 4096)?.to_owned(),
                bounded_u64(field(page, "duration")?, 1, MAX_DURATION_SECONDS)?,
            ));
        }
    }
    let (cid, part_title, duration_seconds) =
        selected.ok_or(Error::InvalidResponse("part_missing"))?;
    Ok(VideoMetadata {
        bvid,
        aid,
        cid,
        part: requested.part,
        part_count: pages.len() as u32,
        title: text(field(data, "title")?, 4096)?.to_owned(),
        part_title,
        duration_seconds,
    })
}

/// Parse a signed playurl response without fetching any media bytes.
pub fn parse_playurl_response(
    bytes: &[u8],
    metadata: &VideoMetadata,
    now: u64,
) -> Result<ResolvedVideo> {
    if !valid_bv(&metadata.bvid)
        || !decimal(&metadata.aid)
        || !decimal(&metadata.cid)
        || metadata.part == 0
        || metadata.part > metadata.part_count
        || metadata.part_count as usize > MAX_PAGES
        || !(1..=MAX_DURATION_SECONDS).contains(&metadata.duration_seconds)
    {
        return Err(Error::InvalidResponse("playurl_identity"));
    }
    let value = strict_json(bytes, MAX_BODY)?;
    check_code(&value)?;
    let data = object(field(&value, "data")?)?;
    deny_restrictions(data)?;
    // Endpoint responses don't always echo these identifiers. If supplied, each
    // one must match the request; aliases cannot silently overwrite each other.
    for (name, expected) in [
        ("bvid", &metadata.bvid),
        ("aid", &metadata.aid),
        ("cid", &metadata.cid),
    ] {
        if let Some(actual) = data.get(name) {
            let actual = if name == "bvid" {
                text(actual, 12)?.to_owned()
            } else {
                id(actual)?
            };
            if &actual != expected {
                return Err(Error::InvalidResponse("playurl_identity"));
            }
        }
    }
    let current_quality = bounded_u32(field(data, "quality")?, 1, 127)?;
    let duration_ms = bounded_u64(field(data, "timelength")?, 1, MAX_DURATION_SECONDS * 1000)?;
    duration_matches(duration_ms as f64 / 1000.0, metadata.duration_seconds)?;
    let has_dash = data.get("dash").is_some_and(|value| !value.is_null());
    let has_durl = data
        .get("durl")
        .is_some_and(|value| value.as_array().is_some_and(|items| !items.is_empty()));
    if has_dash == has_durl {
        return Err(Error::InvalidResponse("playback_shape"));
    }
    let playback = if has_dash {
        Playback::Dash(parse_dash(
            field(data, "dash")?,
            metadata.duration_seconds,
            now,
        )?)
    } else {
        let format = text(field(data, "format")?, 32)?.to_owned();
        if !matches!(
            format.as_str(),
            "mp4" | "flv" | "flv720" | "flv480" | "hdflv2"
        ) {
            return Err(Error::InvalidResponse("progressive_format"));
        }
        let durls = array(field(data, "durl")?, 128)?;
        let mut total_ms = 0u64;
        let mut segments = Vec::new();
        for (index, segment) in durls.iter().enumerate() {
            let segment = object(segment)?;
            let order = bounded_u32(field(segment, "order")?, 1, 128)?;
            if order as usize != index + 1 {
                return Err(Error::InvalidResponse("segment_order"));
            }
            let length = bounded_u64(field(segment, "length")?, 1, MAX_DURATION_SECONDS * 1000)?;
            total_ms = total_ms
                .checked_add(length)
                .ok_or(Error::InvalidResponse("duration"))?;
            let (primary, backups) = media_addresses(segment, &["url"], now)?;
            segments.push(ProgressiveSegment {
                order,
                size_bytes: bounded_u64(field(segment, "size")?, 1, 1 << 50)?,
                duration_ms: length,
                primary,
                backups,
            });
        }
        if segments.is_empty() || total_ms.abs_diff(duration_ms) > 2000 {
            return Err(Error::InvalidResponse("segment_duration"));
        }
        Playback::Progressive { format, segments }
    };
    let qualities = parse_qualities(data, current_quality, &playback)?;
    let earliest_expires_at = playback_expiry(&playback);
    Ok(ResolvedVideo {
        metadata: metadata.clone(),
        current_quality,
        qualities,
        playback,
        earliest_expires_at,
    })
}

fn duration_matches(actual: f64, expected: u64) -> Result<()> {
    if !actual.is_finite()
        || actual <= 0.0
        || actual > MAX_DURATION_SECONDS as f64
        || (actual - expected as f64).abs() > 1.5
    {
        return Err(Error::Restricted("preview_or_duration_mismatch"));
    }
    Ok(())
}

fn parse_dash(value: &Value, expected_duration_seconds: u64, now: u64) -> Result<Dash> {
    let data = object(value)?;
    let duration_seconds = finite(field(data, "duration")?, 0.001, MAX_DURATION_SECONDS as f64)?;
    duration_matches(duration_seconds, expected_duration_seconds)?;
    let min_buffer_seconds = finite(
        alias(data, &["minBufferTime", "min_buffer_time"])?,
        0.0,
        600.0,
    )?;
    let mut seen_video = HashSet::new();
    let mut video = Vec::new();
    for track in array(field(data, "video")?, MAX_TRACKS)? {
        let track = object(track)?;
        let quality_id = bounded_u32(field(track, "id")?, 1, 127)?;
        let codecs = codec_text(field(track, "codecs")?)?;
        let codec = if codecs.starts_with("avc1.") {
            VideoCodec::Avc
        } else if codecs.starts_with("hev1.") || codecs.starts_with("hvc1.") {
            VideoCodec::Hevc
        } else if codecs.starts_with("av01.") {
            VideoCodec::Av1
        } else {
            return Err(Error::InvalidResponse("video_codec"));
        };
        if let Some(codecid) = track.get("codecid") {
            let expected = match codec {
                VideoCodec::Avc => 7,
                VideoCodec::Hevc => 12,
                VideoCodec::Av1 => 13,
            };
            if codecid.as_u64() != Some(expected) {
                return Err(Error::InvalidResponse("video_codec_identity"));
            }
        }
        let width = bounded_u32(field(track, "width")?, 1, 16_384)?;
        let height = bounded_u32(field(track, "height")?, 1, 16_384)?;
        let key = format!("v-{quality_id}-{codecs}-{width}x{height}");
        if !seen_video.insert(key.clone()) {
            return Err(Error::InvalidResponse("duplicate_video_track"));
        }
        let mime_type = text(alias(track, &["mimeType", "mime_type"])?, 64)?.to_owned();
        if mime_type != "video/mp4" {
            return Err(Error::InvalidResponse("video_mime"));
        }
        let frame_rate =
            canonical_frame_rate(text(alias(track, &["frameRate", "frame_rate"])?, 32)?)?;
        let sar = track
            .get("sar")
            .map(|value| text(value, 32).map(str::to_owned))
            .transpose()?
            .unwrap_or_else(|| "1:1".to_owned());
        ratio(&sar, ':', 100.0)?;
        let (primary, backups) = media_addresses(track, &["baseUrl", "base_url"], now)?;
        video.push(VideoTrack {
            key,
            quality_id,
            codec,
            codecs,
            mime_type,
            width,
            height,
            frame_rate,
            sar,
            bandwidth: bounded_u64(field(track, "bandwidth")?, 1, 2_000_000_000)?,
            start_with_sap: optional_sap(track)?,
            segment_base: parse_segment_base(track)?,
            primary,
            backups,
        });
    }
    if video.is_empty() {
        return Err(Error::InvalidResponse("no_video_tracks"));
    }
    let mut audio_values = Vec::new();
    if let Some(values) = data.get("audio").filter(|value| !value.is_null()) {
        audio_values.extend(array(values, 32)?.iter());
    }
    if let Some(dolby) = data.get("dolby").filter(|value| !value.is_null()) {
        let dolby = object(dolby)?;
        if let Some(values) = dolby.get("audio").filter(|value| !value.is_null()) {
            audio_values.extend(array(values, 8)?.iter());
        }
    }
    if let Some(flac) = data.get("flac").filter(|value| !value.is_null())
        && let Some(track) = object(flac)?.get("audio").filter(|value| !value.is_null())
    {
        audio_values.push(track);
    }
    if audio_values.len() > 40 {
        return Err(Error::InvalidResponse("audio_tracks"));
    }
    let mut seen_audio = HashSet::new();
    let mut audio = Vec::new();
    for track in audio_values {
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
        if !seen_audio.insert(key.clone()) {
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
        audio.push(AudioTrack {
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
        });
    }
    Ok(Dash {
        duration_seconds,
        min_buffer_seconds,
        video,
        audio,
    })
}

fn optional_sap(track: &Value) -> Result<u32> {
    match track
        .get("startWithSap")
        .or_else(|| track.get("start_with_sap"))
    {
        None => Ok(1),
        Some(_) => bounded_u32(alias(track, &["startWithSap", "start_with_sap"])?, 0, 6),
    }
}
fn codec_text(value: &Value) -> Result<String> {
    let value = text(value, 64)?;
    if !value
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
    {
        return Err(Error::InvalidResponse("codec"));
    }
    Ok(value.to_owned())
}
fn canonical_frame_rate(value: &str) -> Result<String> {
    let invalid = || Error::InvalidResponse("frame_rate");
    ratio(value, '/', 240.0)?;
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit());
    if let Some((whole, fraction)) = value.split_once('.') {
        if !digits(whole) || !digits(fraction) {
            return Err(invalid());
        }
        // Bilibili reports ordinary rates such as "25.000". The closed DASH
        // renderer and browser contract require integer or integer-ratio rates.
        // Convert exactly, without rounding a fractional cadence to an integer.
        let fraction = fraction.trim_end_matches('0');
        if fraction.len() > 9 {
            return Err(invalid());
        }
        let denominator = 10_u64.pow(fraction.len() as u32);
        let numerator = whole
            .parse::<u64>()
            .ok()
            .and_then(|whole| whole.checked_mul(denominator))
            .and_then(|whole| {
                if fraction.is_empty() {
                    Some(whole)
                } else {
                    whole.checked_add(fraction.parse::<u64>().ok()?)
                }
            })
            .ok_or_else(invalid)?;
        let (mut a, mut b) = (numerator, denominator);
        while b != 0 {
            (a, b) = (b, a % b);
        }
        let numerator = u32::try_from(numerator / a).map_err(|_| invalid())?;
        let denominator = u32::try_from(denominator / a).map_err(|_| invalid())?;
        return Ok(if denominator == 1 {
            numerator.to_string()
        } else {
            format!("{numerator}/{denominator}")
        });
    }
    // Existing integer/rational rates remain byte-for-byte unchanged. Reject
    // exponent/sign syntax and components the browser contract cannot represent.
    let mut parts = value.split('/');
    let number = |part: &str| digits(part) && part.parse::<u32>().is_ok_and(|number| number > 0);
    if !parts.next().is_some_and(number)
        || !parts.next().is_none_or(number)
        || parts.next().is_some()
    {
        return Err(invalid());
    }
    Ok(value.to_owned())
}

fn ratio(value: &str, separator: char, max: f64) -> Result<()> {
    let result = if let Some((a, b)) = value.split_once(separator) {
        let a = a
            .parse::<f64>()
            .map_err(|_| Error::InvalidResponse("ratio"))?;
        let b = b
            .parse::<f64>()
            .map_err(|_| Error::InvalidResponse("ratio"))?;
        if !a.is_finite() || !b.is_finite() || b <= 0.0 {
            return Err(Error::InvalidResponse("ratio"));
        }
        a / b
    } else {
        value
            .parse::<f64>()
            .map_err(|_| Error::InvalidResponse("ratio"))?
    };
    if !result.is_finite() || result <= 0.0 || result > max {
        return Err(Error::InvalidResponse("ratio"));
    }
    Ok(())
}
fn parse_segment_base(track: &Value) -> Result<SegmentBase> {
    fn parse(base: &Value) -> Result<SegmentBase> {
        let base = object(base)?;
        let index_range = parse_range(text(alias(base, &["indexRange", "index_range"])?, 48)?)?;
        let initialization_range = parse_range(text(
            alias(base, &["Initialization", "initialization"])?,
            48,
        )?)?;
        if initialization_range.start != 0 || initialization_range.end >= index_range.start {
            return Err(Error::InvalidResponse("segment_base_overlap"));
        }
        Ok(SegmentBase {
            index_range,
            initialization_range,
        })
    }
    let camel = track.get("SegmentBase").map(parse).transpose()?;
    let snake = track.get("segment_base").map(parse).transpose()?;
    match (camel, snake) {
        (Some(camel), Some(snake)) if camel != snake => {
            Err(Error::InvalidResponse("conflicting_segment_base"))
        }
        (Some(value), _) | (_, Some(value)) => Ok(value),
        _ => Err(Error::InvalidResponse("missing_field")),
    }
}
fn parse_range(value: &str) -> Result<ByteRange> {
    let (start, end) = value
        .split_once('-')
        .ok_or(Error::InvalidResponse("byte_range"))?;
    fn component(value: &str) -> Result<u64> {
        if value.is_empty()
            || value.len() > 10
            || !value.bytes().all(|b| b.is_ascii_digit())
            || (value.len() > 1 && value.starts_with('0'))
        {
            return Err(Error::InvalidResponse("byte_range"));
        }
        value
            .parse()
            .map_err(|_| Error::InvalidResponse("byte_range"))
    }
    let start = component(start)?;
    let end = component(end)?;
    if start > end || end > 64 * 1024 * 1024 {
        return Err(Error::InvalidResponse("byte_range"));
    }
    Ok(ByteRange { start, end })
}

fn media_addresses(
    value: &Value,
    primary_keys: &[&str],
    now: u64,
) -> Result<(MediaUrl, Vec<MediaUrl>)> {
    let primary = parse_media_url(text(alias(value, primary_keys)?, 8192)?, now)?;
    let backup = optional_alias(value, &["backupUrl", "backup_url"])?;
    let mut backups = Vec::new();
    let mut seen = HashSet::from([primary.as_str().to_owned()]);
    if let Some(backup) = backup.filter(|value| !value.is_null()) {
        for item in array(backup, MAX_BACKUPS)? {
            let item = parse_media_url(text(item, 8192)?, now)?;
            if !seen.insert(item.as_str().to_owned()) {
                return Err(Error::InvalidResponse("duplicate_media_url"));
            }
            backups.push(item);
        }
    }
    Ok((primary, backups))
}

/// Syntactic CDN validation is also applied before descriptors leave this module.
/// Production transport must additionally enforce public DNS at request time.
pub fn parse_media_url(value: &str, now: u64) -> Result<MediaUrl> {
    if value.len() > 8192 || value.trim() != value || value.chars().any(char::is_control) {
        return Err(Error::InvalidResponse("media_url"));
    }
    let url = Url::parse(value).map_err(|_| Error::InvalidResponse("media_url"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.path() == "/"
        || !url.host_str().is_some_and(media_host_allowed)
    {
        return Err(Error::InvalidResponse("media_url"));
    }
    let mut seen = HashSet::new();
    let mut expires_at = None;
    for (name, value) in url.query_pairs() {
        if !seen.insert(name.to_string()) {
            return Err(Error::InvalidResponse("duplicate_media_query"));
        }
        let expiry = match name.as_ref() {
            "deadline" | "expires" => Some(
                value
                    .parse::<u64>()
                    .map_err(|_| Error::InvalidResponse("media_expiry"))?,
            ),
            "wsTime" => Some(
                u64::from_str_radix(&value, 16)
                    .map_err(|_| Error::InvalidResponse("media_expiry"))?,
            ),
            _ => None,
        };
        if let Some(expiry) = expiry {
            if expiry <= now || expiry > 32_503_680_000 {
                return Err(Error::InvalidResponse("media_expired"));
            }
            expires_at = Some(expires_at.map_or(expiry, |old: u64| old.min(expiry)));
        }
    }
    Ok(MediaUrl { url, expires_at })
}
pub fn media_host_allowed(host: &str) -> bool {
    [
        "bilivideo.com",
        "bilivideo.cn",
        "bilivideo.net",
        "hdslb.com",
    ]
    .iter()
    .any(|suffix| {
        host == *suffix
            || host
                .strip_suffix(suffix)
                .is_some_and(|prefix| prefix.ends_with('.'))
    }) || host == "upos-hz-mirrorakam.akamaized.net"
}

fn playback_expiry(playback: &Playback) -> Option<u64> {
    let addresses: Vec<&MediaUrl> = match playback {
        Playback::Dash(dash) => dash
            .video
            .iter()
            .flat_map(|track| std::iter::once(&track.primary).chain(track.backups.iter()))
            .chain(
                dash.audio
                    .iter()
                    .flat_map(|track| std::iter::once(&track.primary).chain(track.backups.iter())),
            )
            .collect(),
        Playback::Progressive { segments, .. } => segments
            .iter()
            .flat_map(|segment| std::iter::once(&segment.primary).chain(segment.backups.iter()))
            .collect(),
    };
    let mut earliest = None;
    for address in addresses {
        let expiry = address.expires_at?;
        earliest = Some(earliest.map_or(expiry, |old: u64| old.min(expiry)));
    }
    earliest
}
fn parse_qualities(data: &Value, current: u32, playback: &Playback) -> Result<Vec<Quality>> {
    let ids = array(field(data, "accept_quality")?, 32)?;
    let labels = array(field(data, "accept_description")?, 32)?;
    if ids.is_empty() || ids.len() != labels.len() {
        return Err(Error::InvalidResponse("qualities"));
    }
    let mut seen = HashSet::new();
    let mut qualities = Vec::new();
    for (id, label) in ids.iter().zip(labels) {
        let id = bounded_u32(id, 1, 127)?;
        if !seen.insert(id) {
            return Err(Error::InvalidResponse("duplicate_quality"));
        }
        let available = match playback {
            Playback::Dash(dash) => dash.video.iter().any(|track| track.quality_id == id),
            Playback::Progressive { .. } => id == current,
        };
        qualities.push(Quality {
            id,
            label: text(label, 256)?.to_owned(),
            requires_login: false,
            requires_vip: false,
            available,
        });
    }
    if !seen.contains(&current) {
        return Err(Error::InvalidResponse("current_quality"));
    }
    if let Playback::Dash(dash) = playback
        && dash
            .video
            .iter()
            .any(|track| !seen.contains(&track.quality_id))
    {
        return Err(Error::InvalidResponse("track_quality"));
    }
    if let Some(formats) = data.get("support_formats").filter(|value| !value.is_null()) {
        let mut seen_formats = HashSet::new();
        for format in array(formats, 32)? {
            let format = object(format)?;
            let id = bounded_u32(field(format, "quality")?, 1, 127)?;
            if !seen_formats.insert(id) {
                return Err(Error::InvalidResponse("duplicate_quality_format"));
            }
            if let Some(quality) = qualities.iter_mut().find(|quality| quality.id == id) {
                quality.requires_login = boolish_optional(format, "need_login")?.unwrap_or(false);
                quality.requires_vip = boolish_optional(format, "need_vip")?.unwrap_or(false);
                if let Some(label) = format
                    .get("new_description")
                    .or_else(|| format.get("description"))
                {
                    quality.label = text(label, 256)?.to_owned();
                }
            }
        }
    }
    Ok(qualities)
}

/// Conservative restriction checks; no restricted response is converted into
/// a lower-friction route, different account, region or unsigned API fallback.
fn deny_restrictions(value: &Value) -> Result<()> {
    fn walk(value: &Value) -> Result<()> {
        match value {
            Value::Object(fields) => {
                for (name, child) in fields {
                    let restricted = match name.as_str() {
                        "support_formats" => continue,
                        "is_preview" | "isPreview" | "is_drm" | "isDrm" | "need_login"
                        | "need_vip" | "need_pay" | "pay" | "ugc_pay" | "arc_pay" => {
                            boolish(child)?
                        }
                        "can_play" | "is_playable" | "is_available" => !boolish(child)?,
                        "drm_tech_type" => child.as_u64() != Some(0),
                        "drm" | "drm_info" | "drmInfo" | "license_url" | "licenseUrl"
                        | "widevine" | "playready" | "fairplay" | "content_protection"
                        | "ContentProtection" => !child.is_null() && child != &Value::Bool(false),
                        "permission" => {
                            matches!(child.as_str(), Some("denied" | "restricted" | "forbidden"))
                        }
                        _ => false,
                    };
                    if restricted {
                        return Err(Error::Restricted("upstream_access_or_drm"));
                    }
                    walk(child)?;
                }
            }
            Value::Array(values) => {
                for value in values {
                    walk(value)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(value)
}

/// Closed diagnostic categories only. These must never retain the rejected
/// URL, its query, QR key, user information or arbitrary provider strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QrUrlScheme {
    Https,
    Http,
    Other,
    Unparsed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QrUrlHost {
    Passport,
    Account,
    OtherBilibili,
    Other,
    Missing,
    Unparsed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QrUrlPath {
    Login,
    LoginScan,
    AccountScanWeb,
    LegacyQrLogin,
    OtherPassport,
    Other,
    Unparsed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QrUrlRejection {
    pub scheme: QrUrlScheme,
    pub host: QrUrlHost,
    pub path: QrUrlPath,
    pub has_port: bool,
    pub has_credentials: bool,
    pub has_fragment: bool,
}
impl QrUrlRejection {
    fn unparsed() -> Self {
        Self {
            scheme: QrUrlScheme::Unparsed,
            host: QrUrlHost::Unparsed,
            path: QrUrlPath::Unparsed,
            has_port: false,
            has_credentials: false,
            has_fragment: false,
        }
    }
    fn from_url(url: &Url) -> Self {
        Self {
            scheme: match url.scheme() {
                "https" => QrUrlScheme::Https,
                "http" => QrUrlScheme::Http,
                _ => QrUrlScheme::Other,
            },
            host: match url.host_str() {
                Some("passport.bilibili.com") => QrUrlHost::Passport,
                Some("account.bilibili.com") => QrUrlHost::Account,
                Some(host) if host == "bilibili.com" || host.ends_with(".bilibili.com") => {
                    QrUrlHost::OtherBilibili
                }
                Some(_) => QrUrlHost::Other,
                None => QrUrlHost::Missing,
            },
            path: match url.path() {
                "/h5-app/passport/login" => QrUrlPath::Login,
                "/h5-app/passport/login/scan" => QrUrlPath::LoginScan,
                "/h5/account-h5/auth/scan-web" => QrUrlPath::AccountScanWeb,
                "/qrcode/h5/login" => QrUrlPath::LegacyQrLogin,
                path if path.starts_with("/h5-app/passport/") => QrUrlPath::OtherPassport,
                _ => QrUrlPath::Other,
            },
            has_port: url.port().is_some(),
            has_credentials: !url.username().is_empty() || url.password().is_some(),
            has_fragment: url.fragment().is_some(),
        }
    }
}

#[derive(Clone)]
pub struct QrKey(String);
impl fmt::Debug for QrKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("QrKey([REDACTED])")
    }
}
impl QrKey {
    pub fn from_secret(value: &str) -> Result<Self> {
        if !(16..=128).contains(&value.len())
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(Error::InvalidResponse("qr_key"));
        }
        Ok(Self(value.to_owned()))
    }
    pub fn expose_for_storage(&self) -> &str {
        &self.0
    }
}
#[derive(Clone)]
pub struct QrChallenge {
    pub login_url: String,
    pub key: QrKey,
}
impl fmt::Debug for QrChallenge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("QrChallenge([REDACTED])")
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QrState {
    Waiting,
    Scanned,
    Expired,
    Confirmed,
}
#[derive(Debug, Clone)]
pub struct QrPoll {
    pub state: QrState,
    pub session: Option<Cookie>,
    pub refresh_token: Option<renewal::RefreshToken>,
}
pub fn qr_generate_request() -> ApiRequest {
    ApiRequest::new(Endpoint::QrGenerate, &[], None)
}
pub fn qr_poll_request(key: &QrKey) -> ApiRequest {
    ApiRequest::new(
        Endpoint::QrPoll,
        &[("qrcode_key".to_owned(), key.0.clone())],
        None,
    )
}
pub fn parse_qr_generate_response(bytes: &[u8]) -> Result<QrChallenge> {
    let value = strict_json(bytes, MAX_SMALL_BODY)?;
    check_code(&value)?;
    let data = object(field(&value, "data")?)?;
    let login_url = text(field(data, "url")?, 4096)?.to_owned();
    let url =
        Url::parse(&login_url).map_err(|_| Error::InvalidQrUrl(QrUrlRejection::unparsed()))?;
    // Observed from the fixed official web QR generation endpoint. Keep the
    // host/path pairs exact; an arbitrary Bilibili URL is not a login capability.
    let account_scan = url.host_str() == Some("account.bilibili.com")
        && url.path() == "/h5/account-h5/auth/scan-web";
    let passport_scan = url.host_str() == Some("passport.bilibili.com")
        && matches!(
            url.path(),
            "/h5-app/passport/login" | "/h5-app/passport/login/scan"
        );
    if url.scheme() != "https"
        || !(account_scan || passport_scan)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::InvalidQrUrl(QrUrlRejection::from_url(&url)));
    }
    let key = QrKey::from_secret(text(field(data, "qrcode_key")?, 128)?)?;
    // Every supported shape must carry exactly one binding to the poll key.
    let bindings = url
        .query_pairs()
        .filter(|(name, _)| matches!(name.as_ref(), "qrcode_key" | "oauthKey"))
        .collect::<Vec<_>>();
    if bindings.len() != 1
        || ((account_scan || url.path().ends_with("/scan")) && bindings[0].0 != "qrcode_key")
        || bindings[0].1 != key.0
    {
        return Err(Error::InvalidResponse("qr_binding"));
    }
    if account_scan {
        let query = url.query_pairs().collect::<Vec<_>>();
        if query.iter().any(|(name, value)| match name.as_ref() {
            "qrcode_key" => false,
            "navhide" => value != "1",
            "callback" => value != "close",
            "from" => !value.is_empty(),
            _ => true,
        }) || query.iter().filter(|(name, _)| name == "callback").count() != 1
            || query.iter().filter(|(name, _)| name == "navhide").count() > 1
            || query.iter().filter(|(name, _)| name == "from").count() > 1
        {
            return Err(Error::InvalidResponse("qr_binding"));
        }
    }
    Ok(QrChallenge { login_url, key })
}
pub fn parse_qr_poll_response(bytes: &[u8], set_cookie: &[String]) -> Result<QrPoll> {
    let value = strict_json(bytes, MAX_SMALL_BODY)?;
    check_code(&value)?;
    let data = object(field(&value, "data")?)?;
    let state = match field(data, "code")?
        .as_u64()
        .ok_or(Error::InvalidResponse("qr_state"))?
    {
        86101 => QrState::Waiting,
        86090 => QrState::Scanned,
        86038 => QrState::Expired,
        0 => QrState::Confirmed,
        _ => return Err(Error::InvalidResponse("qr_state")),
    };
    if state != QrState::Confirmed {
        return Ok(QrPoll {
            state,
            session: None,
            refresh_token: None,
        });
    }
    if set_cookie.len() > 32 || set_cookie.iter().map(String::len).sum::<usize>() > 32 * 1024 {
        return Err(Error::TooLarge);
    }
    let mut pairs = Vec::new();
    for line in set_cookie {
        if line.len() > 8192 || line.bytes().any(|b| b < 0x20 || b == 0x7f) {
            return Err(Error::InvalidResponse("set_cookie"));
        }
        let mut components = line.split(';');
        let pair = components.next().unwrap_or_default().trim();
        let (name, value) = pair
            .split_once('=')
            .ok_or(Error::InvalidResponse("set_cookie"))?;
        if !cookie_name(name) {
            continue;
        }
        if !cookie_value(value) {
            return Err(Error::InvalidResponse("set_cookie"));
        }
        let mut domain_seen = false;
        let mut path_seen = false;
        for attribute in components {
            let (name, value) = attribute
                .trim()
                .split_once('=')
                .unwrap_or((attribute.trim(), ""));
            if name.eq_ignore_ascii_case("domain") {
                if domain_seen
                    || !matches!(
                        value.to_ascii_lowercase().as_str(),
                        ".bilibili.com" | "bilibili.com"
                    )
                {
                    return Err(Error::InvalidResponse("cookie_origin"));
                }
                domain_seen = true;
            } else if name.eq_ignore_ascii_case("path") {
                if path_seen || value != "/" {
                    return Err(Error::InvalidResponse("cookie_path"));
                }
                path_seen = true;
            }
        }
        // A host-only passport cookie cannot be reused on api.bilibili.com.
        if !domain_seen {
            return Err(Error::InvalidResponse("cookie_origin"));
        }
        pairs.push(pair.to_owned());
    }
    let session = Cookie::from_header(&pairs.join("; "))?;
    Ok(QrPoll {
        state,
        session: Some(session),
        refresh_token: data
            .get("refresh_token")
            .map(|v| {
                v.as_str()
                    .ok_or(Error::InvalidResponse("refresh_token"))
                    .and_then(renewal::RefreshToken::from_secret)
            })
            .transpose()?,
    })
}

fn code(value: &Value) -> Result<i64> {
    field(object(value)?, "code")?
        .as_i64()
        .ok_or(Error::InvalidResponse("api_code"))
}
fn check_code(value: &Value) -> Result<()> {
    match code(value)? {
        0 => Ok(()),
        -101 => Err(Error::Restricted("authentication_required")),
        -104 | -401 | -403 | -404 | 62002 | 62004 | 62012 => {
            Err(Error::Restricted("unavailable_or_permission"))
        }
        code => Err(Error::Api(code)),
    }
}
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value> {
    value
        .get(key)
        .ok_or(Error::InvalidResponse("missing_field"))
}
fn object(value: &Value) -> Result<&Value> {
    if value.is_object() {
        Ok(value)
    } else {
        Err(Error::InvalidResponse("object"))
    }
}
fn array(value: &Value, max: usize) -> Result<&Vec<Value>> {
    value
        .as_array()
        .filter(|value| value.len() <= max)
        .ok_or(Error::InvalidResponse("array"))
}
fn text(value: &Value, max: usize) -> Result<&str> {
    value
        .as_str()
        .filter(|value| {
            !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
        })
        .ok_or(Error::InvalidResponse("text"))
}
fn id(value: &Value) -> Result<String> {
    let value = numeric_string(value)?;
    if !decimal(&value) {
        return Err(Error::InvalidResponse("id"));
    }
    Ok(value)
}
fn numeric_string(value: &Value) -> Result<String> {
    if let Some(value) = value.as_str() {
        Ok(value.to_owned())
    } else {
        value
            .as_u64()
            .map(|value| value.to_string())
            .ok_or(Error::InvalidResponse("integer"))
    }
}
fn bounded_u64(value: &Value, min: u64, max: u64) -> Result<u64> {
    value
        .as_u64()
        .filter(|value| (min..=max).contains(value))
        .ok_or(Error::InvalidResponse("integer_bound"))
}
fn bounded_u32(value: &Value, min: u32, max: u32) -> Result<u32> {
    bounded_u64(value, u64::from(min), u64::from(max)).map(|value| value as u32)
}
fn finite(value: &Value, min: f64, max: f64) -> Result<f64> {
    value
        .as_f64()
        .filter(|value| value.is_finite() && (min..=max).contains(value))
        .ok_or(Error::InvalidResponse("finite_number"))
}
fn boolish(value: &Value) -> Result<bool> {
    match value {
        Value::Bool(value) => Ok(*value),
        Value::Number(value) if value.as_u64() == Some(0) => Ok(false),
        Value::Number(value) if value.as_u64() == Some(1) => Ok(true),
        _ => Err(Error::InvalidResponse("boolean")),
    }
}
fn boolish_optional(value: &Value, key: &str) -> Result<Option<bool>> {
    value.get(key).map(boolish).transpose()
}
fn optional_alias<'a>(value: &'a Value, keys: &[&str]) -> Result<Option<&'a Value>> {
    let mut selected = None;
    for key in keys {
        if let Some(found) = value.get(*key) {
            if selected.is_some_and(|selected| selected != found) {
                return Err(Error::InvalidResponse("conflicting_alias"));
            }
            selected = Some(found);
        }
    }
    Ok(selected)
}
fn alias<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Value> {
    optional_alias(value, keys)?.ok_or(Error::InvalidResponse("missing_field"))
}

/// All JSON objects use unique-field semantics, including unknown nested fields.
/// serde_json's recursion limit stays enabled. Bytes and collection sizes are
/// bounded before or during allocation; trailing JSON is rejected too.
pub fn strict_json(bytes: &[u8], limit: usize) -> Result<Value> {
    if bytes.len() > limit.min(MAX_BODY) {
        return Err(Error::TooLarge);
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let result = UniqueValue::deserialize(&mut deserializer)
        .map_err(|_| Error::InvalidJson)?
        .0;
    deserializer.end().map_err(|_| Error::InvalidJson)?;
    Ok(result)
}
struct UniqueValue(Value);
impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueValue;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("bounded unique-field JSON")
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::Null))
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                value: bool,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(value.into()))
            }
            fn visit_i64<E: serde::de::Error>(
                self,
                value: i64,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(value.into()))
            }
            fn visit_u64<E: serde::de::Error>(
                self,
                value: u64,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(value.into()))
            }
            fn visit_f64<E: serde::de::Error>(
                self,
                value: f64,
            ) -> std::result::Result<Self::Value, E> {
                serde_json::Number::from_f64(value)
                    .map(|value| UniqueValue(Value::Number(value)))
                    .ok_or_else(|| E::custom("nonfinite number"))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                value: &str,
            ) -> std::result::Result<Self::Value, E> {
                if value.len() > 65536 {
                    return Err(E::custom("string too large"));
                }
                Ok(UniqueValue(value.into()))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                value: String,
            ) -> std::result::Result<Self::Value, E> {
                if value.len() > 65536 {
                    return Err(E::custom("string too large"));
                }
                Ok(UniqueValue(value.into()))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<UniqueValue>()? {
                    if values.len() >= MAX_PAGES {
                        return Err(serde::de::Error::custom("array too large"));
                    }
                    values.push(value.0);
                }
                Ok(UniqueValue(Value::Array(values)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if key.len() > 256 || values.len() >= 1024 || values.contains_key(&key) {
                        return Err(serde::de::Error::custom("ambiguous or oversized object"));
                    }
                    values.insert(key, map.next_value::<UniqueValue>()?.0);
                }
                Ok(UniqueValue(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

#[cfg(test)]
#[path = "bilibili/core_tests.rs"]
mod core_tests;

/// Normal WBI signing for one fixed live getDanmuInfo request. Keys must have
/// been returned by nav; no signature/fingerprint guessing or retry exists.
pub fn signed_live_danmaku_query(
    room_id: u64,
    keys: &WbiKeys,
    now: u64,
) -> Result<Vec<(String, String)>> {
    if room_id == 0 || now == 0 || keys.mixin.len() != 32 {
        return Err(Error::InvalidResponse("live_danmaku_signing"));
    }
    let values = BTreeMap::from([
        ("id", room_id.to_string()),
        ("type", "0".into()),
        ("web_location", "444.8".into()),
        ("wts", now.to_string()),
    ]);
    let mut url =
        Url::parse("https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo").unwrap();
    url.query_pairs_mut()
        .extend_pairs(values.iter().map(|(key, value)| (*key, value.as_str())));
    let digest = format!(
        "{:x}",
        Md5::digest(format!("{}{}", url.query().unwrap_or_default(), keys.mixin).as_bytes())
    );
    let mut pairs = values
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect::<Vec<_>>();
    pairs.push(("w_rid".into(), digest));
    Ok(pairs)
}
