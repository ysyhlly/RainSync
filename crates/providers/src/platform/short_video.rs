//! Bounded Douyin/TikTok ordinary-video metadata resolvers.
//!
//! TikTok hydration and field names were adapted from SyncTV at
//! ca91048b9da595e50642a61618b0eabfbc05e09b:
//! https://github.com/synctv-org/synctv/tree/ca91048b9da595e50642a61618b0eabfbc05e09b/synctv-media-providers/src/tiktok
//! Schema references: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py
//! Douyin's fixed official share page supplies static window._ROUTER_DATA; its
//! route and schema are grounded in https://github.com/ldsoy/douyin-video-parser.
//! The independently implemented scanner does not execute JavaScript. Historic
//! RENDER_DATA is also accepted only for the requested ordinary video.
//! Authenticated requests reuse explicitly imported, platform-scoped cookies.
//! Douyin uses the fixed web detail endpoint observed in yt-dlp's DouyinIE;
//! TikTok reuses its ordinary video webpage hydration. These are web-session
//! adapters, not the platforms' OAuth Display APIs. Neither resolving a public
//! video nor parsing a cookie proves that the session is logged in.
//! Missing/challenged metadata never triggers cookie bootstrap, generated
//! signatures/fingerprints, JavaScript execution, or an alternate endpoint.
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

mod captions;
mod credentials;
mod json;
pub use credentials::{Credential, MAX_COOKIE_HEADER_BYTES};
#[cfg(test)]
mod tests;

use reqwest::Url;
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fmt,
    future::Future,
    pin::Pin,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::time::Instant;

const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_SCRIPT_COUNT: usize = 256;
const MAX_SCRIPT_TAG: usize = 8192;
const MAX_CANDIDATES: usize = 128;
const MAX_DURATION_SECONDS: f64 = 24.0 * 60.0 * 60.0;
const USER_AGENT: &str = "Mozilla/5.0 RainSync/0.1";
pub const DOUYIN_USER_AGENT: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1 RainSync/0.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Douyin,
    TikTok,
}
impl Platform {
    pub fn id(self) -> &'static str {
        match self {
            Self::Douyin => "douyin",
            Self::TikTok => "tiktok",
        }
    }
    pub fn referer(self) -> &'static str {
        match self {
            Self::Douyin => "https://www.douyin.com/",
            Self::TikTok => "https://www.tiktok.com/",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unsupported {
    ImagePost,
    Live,
    Drm,
    SigningRequired,
    Codec,
    NoProgressiveVideo,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    InvalidResource,
    InvalidResponse(&'static str),
    InvalidJson,
    Restricted(&'static str),
    Unsupported(Unsupported),
    Api(i64),
    Status(u16),
    Deadline,
    Transport,
    TooLarge,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidResource => f.write_str("short_video_invalid_resource"),
            Self::InvalidResponse(reason) => write!(f, "short_video_invalid_response:{reason}"),
            Self::InvalidJson => f.write_str("short_video_invalid_json"),
            Self::Restricted(reason) => write!(f, "short_video_restricted:{reason}"),
            Self::Unsupported(reason) => write!(
                f,
                "short_video_unsupported:{}",
                match reason {
                    Unsupported::ImagePost => "image_post",
                    Unsupported::Live => "live",
                    Unsupported::Drm => "drm",
                    Unsupported::SigningRequired => "signing_or_fresh_session_required",
                    Unsupported::Codec => "codec",
                    Unsupported::NoProgressiveVideo => "no_progressive_video",
                }
            ),
            Self::Api(code) => write!(f, "short_video_api:{code}"),
            Self::Status(status) => write!(f, "short_video_http_status:{status}"),
            Self::Deadline => f.write_str("short_video_deadline"),
            Self::Transport => f.write_str("short_video_transport"),
            Self::TooLarge => f.write_str("short_video_response_too_large"),
        }
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

/// Validated stable identity, never an arbitrary URL or feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoRef {
    platform: Platform,
    id: String,
    handle: Option<String>,
}
impl VideoRef {
    pub fn platform(&self) -> Platform {
        self.platform
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn canonical(&self) -> String {
        match self.platform {
            Platform::Douyin => format!("https://www.douyin.com/video/{}", self.id),
            Platform::TikTok => format!(
                "https://www.tiktok.com/@{}/video/{}",
                self.handle.as_deref().unwrap_or("_"),
                self.id
            ),
        }
    }
}
fn decimal(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 20
        && !value.starts_with('0')
        && value.bytes().all(|b| b.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}
fn handle(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 24
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_'))
        && !value.starts_with('.')
        && !value.ends_with('.')
        && !value.contains("..")
}

/// Strict HTTPS full video links (optional trailing slash) or positive u64 IDs.
/// Queries, shares, short links, percent aliases, userinfo and explicit ports are
/// refused before URL normalization can erase their original representation.
pub fn parse_resource(platform: Platform, input: &str) -> Result<VideoRef> {
    if input.is_empty()
        || input.len() > 2048
        || !input.is_ascii()
        || input.bytes().any(|b| b <= b' ' || b == 0x7f || b == b'\\')
    {
        return Err(Error::InvalidResource);
    }
    if decimal(input) {
        return Ok(VideoRef {
            platform,
            id: input.to_owned(),
            handle: None,
        });
    }
    let rest = input
        .strip_prefix("https://")
        .ok_or(Error::InvalidResource)?;
    let (authority, path) = rest.split_once('/').ok_or(Error::InvalidResource)?;
    let permitted = match platform {
        Platform::Douyin => matches!(authority, "www.douyin.com" | "douyin.com"),
        Platform::TikTok => matches!(authority, "www.tiktok.com" | "tiktok.com"),
    };
    if !permitted || path.contains(['?', '#', '%']) {
        return Err(Error::InvalidResource);
    }
    let path = path.strip_suffix('/').unwrap_or(path);
    let segments: Vec<_> = path.split('/').collect();
    let (id, creator) = match platform {
        Platform::Douyin if segments.len() == 2 && segments[0] == "video" => (segments[1], None),
        Platform::Douyin if segments.first() == Some(&"note") => {
            return Err(Error::Unsupported(Unsupported::ImagePost));
        }
        Platform::TikTok if segments.len() == 3 && segments[1] == "video" => {
            let value = segments[0]
                .strip_prefix('@')
                .filter(|s| handle(s))
                .ok_or(Error::InvalidResource)?;
            (segments[2], (value != "_").then(|| value.to_owned()))
        }
        Platform::TikTok if segments.len() == 2 && segments[1] == "live" => {
            return Err(Error::Unsupported(Unsupported::Live));
        }
        Platform::TikTok if segments.len() == 3 && segments[1] == "photo" => {
            return Err(Error::Unsupported(Unsupported::ImagePost));
        }
        _ => return Err(Error::InvalidResource),
    };
    if !decimal(id) {
        return Err(Error::InvalidResource);
    }
    Ok(VideoRef {
        platform,
        id: id.to_owned(),
        handle: creator,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    DouyinWebpage,
    TikTokWebpage,
    DouyinAuthenticatedDetail,
    TikTokAuthenticatedWebpage,
    DouyinPlayRedirect,
}
/// Fixed request; callers cannot supply headers or origins. Credentials are
/// separate from the printable header map and permitted only on the two typed
/// authenticated metadata endpoints, never discovery or media destinations.
pub struct PageRequest {
    endpoint: Endpoint,
    url: Url,
    headers: BTreeMap<String, String>,
    credential: Option<Credential>,
}
impl PageRequest {
    fn new(resource: &VideoRef) -> Self {
        Self {
            endpoint: match resource.platform {
                Platform::Douyin => Endpoint::DouyinWebpage,
                Platform::TikTok => Endpoint::TikTokWebpage,
            },
            url: Url::parse(&match resource.platform {
                Platform::Douyin => {
                    format!("https://www.iesdouyin.com/share/video/{}", resource.id)
                }
                Platform::TikTok => resource.canonical(),
            })
            .expect("validated fixed page URL"),
            headers: BTreeMap::from([
                (
                    "User-Agent".to_owned(),
                    match resource.platform {
                        Platform::Douyin => DOUYIN_USER_AGENT,
                        Platform::TikTok => USER_AGENT,
                    }
                    .to_owned(),
                ),
                ("Referer".to_owned(), resource.platform.referer().to_owned()),
                ("Accept".to_owned(), "text/html".to_owned()),
                ("Accept-Encoding".to_owned(), "identity".to_owned()),
            ]),
            credential: None,
        }
    }
    fn authenticated(resource: &VideoRef, credential: &Credential) -> Result<Self> {
        if resource.platform != credential.platform() {
            return Err(Error::Restricted("credential_provider_mismatch"));
        }
        let mut request = Self::new(resource);
        request.endpoint = match resource.platform {
            Platform::Douyin => Endpoint::DouyinAuthenticatedDetail,
            Platform::TikTok => Endpoint::TikTokAuthenticatedWebpage,
        };
        if resource.platform == Platform::Douyin {
            request.url = Url::parse(&format!(
                "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id={}",
                resource.id
            ))
            .expect("fixed authenticated detail URL");
            request
                .headers
                .insert("User-Agent".to_owned(), USER_AGENT.to_owned());
            request
                .headers
                .insert("Accept".to_owned(), "application/json".to_owned());
        }
        request.credential = Some(credential.clone());
        Ok(request)
    }
    pub fn endpoint(&self) -> Endpoint {
        self.endpoint
    }
    pub fn url(&self) -> &Url {
        &self.url
    }
    pub fn headers(&self) -> &BTreeMap<String, String> {
        &self.headers
    }
    /// Transport-only secret accessor. Never include it in public metadata or
    /// playback grants. Set-Cookie responses are not collected or persisted.
    pub fn credential(&self) -> Option<&Credential> {
        self.credential.as_ref()
    }
    pub fn max_response_bytes(&self) -> usize {
        if self.endpoint == Endpoint::DouyinPlayRedirect {
            0
        } else {
            MAX_BODY
        }
    }
    fn play_redirect(url: Url) -> Self {
        Self {
            endpoint: Endpoint::DouyinPlayRedirect,
            url,
            headers: BTreeMap::from([
                ("User-Agent".to_owned(), DOUYIN_USER_AGENT.to_owned()),
                ("Referer".to_owned(), Platform::Douyin.referer().to_owned()),
                ("Accept".to_owned(), "text/html".to_owned()),
                ("Accept-Encoding".to_owned(), "identity".to_owned()),
            ]),
            credential: None,
        }
    }
}
impl fmt::Debug for PageRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PageRequest")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}
pub struct PageResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub location: Option<String>,
}
impl fmt::Debug for PageResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PageResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish_non_exhaustive()
    }
}
/// Transport must pin a completely public DNS answer, refuse all redirects and
/// incrementally enforce max_response_bytes. Tests use this boundary offline.
pub trait Transport: Send + Sync {
    fn get<'a>(
        &'a self,
        request: PageRequest,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<PageResponse>> + Send + 'a>>;
}

#[derive(Clone, PartialEq, Eq)]
pub struct MediaUrl {
    url: Url,
    pub expires_at_ms: Option<u64>,
}
impl MediaUrl {
    pub fn as_str(&self) -> &str {
        self.url.as_str()
    }
}
impl fmt::Debug for MediaUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MediaUrl")
            .field("expires_at_ms", &self.expires_at_ms)
            .finish_non_exhaustive()
    }
}
/// Server-only progressive candidate. Codec strings are upstream declarations,
/// never proof of the codecs or muxing actually present in the fetched MP4.
#[derive(Clone, PartialEq)]
pub struct ProgressiveResolved {
    pub platform: Platform,
    pub content_id: String,
    pub canonical_url: String,
    pub title: String,
    pub duration_seconds: f64,
    pub media: MediaUrl,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
}
impl fmt::Debug for ProgressiveResolved {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProgressiveResolved")
            .field("platform", &self.platform)
            .field("content_id", &self.content_id)
            .field("duration_seconds", &self.duration_seconds)
            .field("media", &self.media)
            .finish_non_exhaustive()
    }
}
pub struct Resolver<T> {
    transport: T,
}
impl<T: Transport> Resolver<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }
    pub async fn resolve(
        &self,
        platform: Platform,
        input: &str,
        deadline: Instant,
    ) -> Result<ProgressiveResolved> {
        let resource = parse_resource(platform, input)?;
        let request = PageRequest::new(&resource);
        self.resolve_request(resource, request, deadline).await
    }
    /// Uses one explicitly supplied session. Failures never fall back to an
    /// anonymous request, another account, or a challenge/signature solver.
    pub async fn resolve_authenticated(
        &self,
        platform: Platform,
        input: &str,
        credential: &Credential,
        deadline: Instant,
    ) -> Result<ProgressiveResolved> {
        let resource = parse_resource(platform, input)?;
        let request = PageRequest::authenticated(&resource, credential)?;
        self.resolve_request(resource, request, deadline).await
    }
    pub async fn caption_catalog(
        &self,
        platform: Platform,
        input: &str,
        credential: Option<&Credential>,
        deadline: Instant,
    ) -> Result<crate::platform::text::Catalog> {
        let resource = parse_resource(platform, input)?;
        let request = if let Some(credential) = credential {
            PageRequest::authenticated(&resource, credential)?
        } else {
            PageRequest::new(&resource)
        };
        let endpoint = request.endpoint();
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        let response = tokio::time::timeout_at(deadline, self.transport.get(request, deadline))
            .await
            .map_err(|_| Error::Deadline)??;
        if response.body.len() > MAX_BODY {
            return Err(Error::TooLarge);
        }
        match response.status {
            200 => {}
            401 => return Err(Error::Restricted("login_required")),
            403 | 429 => return Err(Error::Restricted("platform_challenge")),
            300..=399 => return Err(Error::Restricted("redirect_denied")),
            n => return Err(Error::Status(n)),
        }
        let item = if endpoint == Endpoint::DouyinAuthenticatedDetail {
            authenticated_douyin_item(&resource, &response.body)?
        } else {
            webpage_item(&resource, &response.body)?
        };
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::InvalidResponse("clock"))?
            .as_millis()
            .try_into()
            .map_err(|_| Error::InvalidResponse("clock"))?;
        // Positive ordinary-media identity/access checks precede text discovery.
        // A caption URL alone is never evidence of content access.
        normalize(&resource, &item, now_ms)?;
        let result = captions::parse(&resource, &item)?;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        Ok(result)
    }
    async fn resolve_request(
        &self,
        resource: VideoRef,
        request: PageRequest,
        deadline: Instant,
    ) -> Result<ProgressiveResolved> {
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        let endpoint = request.endpoint();
        let response = tokio::time::timeout_at(deadline, self.transport.get(request, deadline))
            .await
            .map_err(|_| Error::Deadline)??;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        if response.body.len() > MAX_BODY {
            return Err(Error::TooLarge);
        }
        match response.status {
            200 => {}
            401 => return Err(Error::Restricted("login_required")),
            403 | 429 => return Err(Error::Restricted("platform_challenge")),
            300..=399 => return Err(Error::Restricted("redirect_denied")),
            other => return Err(Error::Status(other)),
        }
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::InvalidResponse("clock"))?
            .as_millis()
            .try_into()
            .map_err(|_| Error::InvalidResponse("clock"))?;
        let parsed = if endpoint == Endpoint::DouyinAuthenticatedDetail {
            parse_authenticated_douyin(&resource, &response.body, now_ms)?
        } else {
            parse_page(&resource, &response.body, now_ms)?
        };
        let media = match parsed.media {
            MediaCandidate::Direct(media) => media,
            MediaCandidate::Redirect(request) => {
                let response =
                    tokio::time::timeout_at(deadline, self.transport.get(request, deadline))
                        .await
                        .map_err(|_| Error::Deadline)??;
                if Instant::now() >= deadline {
                    return Err(Error::Deadline);
                }
                if !matches!(response.status, 301 | 302 | 303 | 307 | 308)
                    || !response.body.is_empty()
                {
                    return Err(Error::Unsupported(Unsupported::NoProgressiveVideo));
                }
                let location = response
                    .location
                    .ok_or(Error::InvalidResponse("redirect_location"))?;
                if location.len() > 8192 {
                    return Err(Error::TooLarge);
                }
                // Only an absolute direct CDN location is accepted. No relative,
                // scheme-relative destination or second redirector is followed.
                if !location.starts_with("https://") {
                    return Err(Error::Unsupported(Unsupported::NoProgressiveVideo));
                }
                let discovered_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| Error::InvalidResponse("clock"))?
                    .as_millis()
                    .try_into()
                    .map_err(|_| Error::InvalidResponse("clock"))?;
                parse_media(Platform::Douyin, &location, discovered_ms)?
            }
        };
        let result = parsed.metadata.with_media(media);
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        Ok(result)
    }
}

/// Uses the transport's single closed CDN policy; DNS validation is still needed
/// by each actual media request. Never transmit cookies to a media target.
pub fn validate_media_url(platform: Platform, value: &str) -> Result<Url> {
    super::http::validate_media_url_for(platform.id(), value)
        .map_err(|_| Error::Restricted("cdn_origin_denied"))
}

/// Pure bounded hydration parser for fixtures and server-owned fetched pages.
pub fn parse_webpage(resource: &VideoRef, body: &[u8], now_ms: u64) -> Result<ProgressiveResolved> {
    let parsed = parse_page(resource, body, now_ms)?;
    match parsed.media {
        MediaCandidate::Direct(media) => Ok(parsed.metadata.with_media(media)),
        MediaCandidate::Redirect(_) => Err(Error::Unsupported(Unsupported::NoProgressiveVideo)),
    }
}
fn parse_page(resource: &VideoRef, body: &[u8], now_ms: u64) -> Result<ParsedVideo> {
    if body.len() > MAX_BODY {
        return Err(Error::TooLarge);
    }
    let item = webpage_item(resource, body)?;
    normalize(resource, &item, now_ms)
}
fn webpage_item(resource: &VideoRef, body: &[u8]) -> Result<Value> {
    if body.len() > MAX_BODY {
        return Err(Error::TooLarge);
    }
    let html = std::str::from_utf8(body).map_err(|_| Error::InvalidResponse("html_encoding"))?;
    let scripts = scripts(html)?;
    let wanted = match resource.platform {
        Platform::Douyin => "RENDER_DATA",
        Platform::TikTok => "__UNIVERSAL_DATA_FOR_REHYDRATION__",
    };
    let mut encoded = scripts
        .iter()
        .filter_map(|script| (script.id.as_deref() == Some(wanted)).then_some(script.body));
    let raw = encoded.next();
    if encoded.next().is_some() {
        return Err(Error::InvalidResponse("duplicate_hydration"));
    }
    let router = if resource.platform == Platform::Douyin {
        router_json(&scripts)?
    } else {
        None
    };
    if raw.is_some() && router.is_some() {
        return Err(Error::InvalidResponse("duplicate_hydration"));
    }
    let data = match raw {
        Some(raw) => {
            let decoded = if resource.platform == Platform::Douyin {
                percent_decode(raw)?
            } else {
                raw.to_owned()
            };
            json::parse(decoded.as_bytes())?
        }
        None if router.is_some() => json::parse(router.expect("checked router JSON").as_bytes())?,
        None => {
            if is_challenge(html) {
                return Err(Error::Restricted("platform_challenge"));
            }
            if html.contains("<title>Log in")
                || html.contains("<title>Login")
                || html.contains("action=\"/login\"")
            {
                return Err(Error::Restricted("login_required"));
            }
            return Err(match resource.platform {
                Platform::Douyin => Error::Unsupported(Unsupported::SigningRequired),
                Platform::TikTok => Error::Restricted("hydration_unavailable"),
            });
        }
    };
    let item = match resource.platform {
        Platform::TikTok => {
            let detail = data
                .pointer("/__DEFAULT_SCOPE__/webapp.video-detail")
                .ok_or(Error::InvalidResponse("video_detail_missing"))?;
            check_status(detail, &["statusCode"])?;
            detail
                .pointer("/itemInfo/itemStruct")
                .ok_or(Error::Restricted("video_unavailable"))?
        }
        Platform::Douyin => douyin_item(&data)?,
    };
    Ok(item.clone())
}

/// Authenticated Douyin's fixed first-party web detail JSON, as observed in
/// yt-dlp's DouyinIE (2026-10-04):
/// https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py .
/// This is a single request using existing login state. No app impersonation,
/// generated signatures, fingerprint setup, token bootstrap or fallback occurs.
fn parse_authenticated_douyin(
    resource: &VideoRef,
    body: &[u8],
    now_ms: u64,
) -> Result<ParsedVideo> {
    let item = authenticated_douyin_item(resource, body)?;
    normalize(resource, &item, now_ms)
}
fn authenticated_douyin_item(resource: &VideoRef, body: &[u8]) -> Result<Value> {
    if resource.platform != Platform::Douyin {
        return Err(Error::Restricted("credential_provider_mismatch"));
    }
    if body.len() > MAX_BODY {
        return Err(Error::TooLarge);
    }
    let text = std::str::from_utf8(body).map_err(|_| Error::InvalidResponse("json_encoding"))?;
    if is_challenge(text) {
        return Err(Error::Restricted("platform_challenge"));
    }
    if text.contains("<title>Log in")
        || text.contains("<title>Login")
        || text.contains("action=\"/login\"")
    {
        return Err(Error::Restricted("login_required"));
    }
    if text.trim().is_empty() {
        return Err(Error::Unsupported(Unsupported::SigningRequired));
    }
    let data = json::parse(body)?;
    check_status(&data, &["status_code", "statusCode"])?;
    let item = data
        .get("aweme_detail")
        .filter(|item| !item.is_null())
        .ok_or(Error::Unsupported(Unsupported::SigningRequired))?;
    // normalize enforces the requested aweme ID, ordinary-video kind, DRM and
    // codecs, bounded candidate count, direct CDN policy and expiry exactly as
    // it does for anonymous hydration. Unrelated list/recursive data is ignored.
    Ok(item.clone())
}

fn douyin_item(data: &Value) -> Result<&Value> {
    if let Some(loader) = data.get("loaderData") {
        let loader = object(loader)?;
        let mut responses = loader.iter().filter_map(|(key, value)| {
            (key.starts_with("video_") && key.ends_with("/page"))
                .then(|| value.get("videoInfoRes"))
                .flatten()
        });
        let response = responses
            .next()
            .ok_or(Error::InvalidResponse("video_detail_missing"))?;
        if responses.next().is_some() {
            return Err(Error::InvalidResponse("ambiguous_video_detail"));
        }
        check_status(response, &["status_code", "statusCode"])?;
        let items = response
            .get("item_list")
            .and_then(Value::as_array)
            .ok_or(Error::InvalidResponse("video_detail_missing"))?;
        if items.is_empty() {
            return Err(Error::Restricted("video_unavailable"));
        }
        if items.len() != 1 {
            return Err(Error::InvalidResponse("ambiguous_video_detail"));
        }
        return Ok(&items[0]);
    }
    // Historic RENDER_DATA route keys are generated; inspect only the known
    // aweme.detail semantic path, not arbitrary recursively found media objects.
    let root = object(data)?;
    let mut items = Vec::new();
    if let Some(item) = data.pointer("/app/videoDetail").filter(|v| !v.is_null()) {
        items.push(item);
    }
    if let Some(item) = data.get("aweme_detail").filter(|v| !v.is_null()) {
        check_status(data, &["status_code"])?;
        items.push(item);
    }
    for value in root.values() {
        if let Some(item) = value.pointer("/aweme/detail").filter(|v| !v.is_null()) {
            items.push(item);
        }
    }
    if items.len() > 1 {
        return Err(Error::InvalidResponse("ambiguous_video_detail"));
    }
    items
        .into_iter()
        .next()
        .ok_or(Error::Unsupported(Unsupported::SigningRequired))
}
fn check_status(value: &Value, aliases: &[&str]) -> Result<()> {
    if let Some(status) = optional_alias(object(value)?, aliases)? {
        let status = status.as_i64().ok_or(Error::InvalidResponse("status"))?;
        if status != 0 {
            return Err(Error::Api(status));
        }
    }
    Ok(())
}
fn object(value: &Value) -> Result<&Map<String, Value>> {
    value.as_object().ok_or(Error::InvalidResponse("object"))
}
fn optional_alias<'a>(object: &'a Map<String, Value>, names: &[&str]) -> Result<Option<&'a Value>> {
    let mut values = names.iter().filter_map(|name| object.get(*name));
    let value = values.next();
    if values.next().is_some() {
        return Err(Error::InvalidResponse("duplicate_alias"));
    }
    Ok(value.filter(|v| !v.is_null()))
}
fn required_alias<'a>(object: &'a Map<String, Value>, names: &[&str]) -> Result<&'a Value> {
    optional_alias(object, names)?.ok_or(Error::InvalidResponse("missing_field"))
}
fn unsigned(value: &Value) -> Result<u64> {
    if let Some(value) = value.as_u64() {
        return Ok(value);
    }
    let value = value.as_str().ok_or(Error::InvalidResponse("number"))?;
    if value.is_empty()
        || value.len() > 20
        || !value.bytes().all(|b| b.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(Error::InvalidResponse("number"));
    }
    value.parse().map_err(|_| Error::InvalidResponse("number"))
}
fn flag(value: &Value) -> Result<bool> {
    match value {
        Value::Bool(value) => Ok(*value),
        Value::Number(_) => match value.as_u64() {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            _ => Err(Error::InvalidResponse("flag")),
        },
        _ => Err(Error::InvalidResponse("flag")),
    }
}
fn explicit_flag(object: &Map<String, Value>, names: &[&str]) -> Result<bool> {
    optional_alias(object, names)?
        .map(flag)
        .transpose()
        .map(|v| v.unwrap_or(false))
}
fn drm(object: &Map<String, Value>) -> Result<bool> {
    for name in [
        "drm",
        "drmInfo",
        "drm_info",
        "encryption",
        "encryptionInfo",
        "isDrm",
        "is_drm",
        "isEncrypted",
        "is_encrypted",
    ] {
        if let Some(value) = object.get(name) {
            let absent = match value {
                Value::Null => true,
                Value::Bool(value) => !value,
                Value::Number(_) => value.as_u64() == Some(0),
                Value::String(value) => value.is_empty(),
                Value::Object(value) => value.is_empty(),
                Value::Array(value) => value.is_empty(),
            };
            if !absent {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
fn dimension(object: &Map<String, Value>, name: &str) -> Result<Option<u32>> {
    object
        .get(name)
        .filter(|v| !v.is_null())
        .map(|v| {
            let n = unsigned(v)?;
            if !(1..=16_384).contains(&n) {
                return Err(Error::InvalidResponse("dimension"));
            }
            Ok(n as u32)
        })
        .transpose()
}
fn declaration(object: &Map<String, Value>, names: &[&str]) -> Result<Option<String>> {
    optional_alias(object, names)?
        .map(|v| {
            let value = v.as_str().ok_or(Error::InvalidResponse("codec"))?;
            if value.is_empty()
                || value.len() > 64
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
            {
                return Err(Error::InvalidResponse("codec"));
            }
            Ok(value.to_owned())
        })
        .transpose()
}
struct ParsedVideo {
    metadata: ParsedMetadata,
    media: MediaCandidate,
}
enum MediaCandidate {
    Direct(MediaUrl),
    Redirect(PageRequest),
}
struct ParsedMetadata {
    platform: Platform,
    content_id: String,
    canonical_url: String,
    title: String,
    duration_seconds: f64,
    width: Option<u32>,
    height: Option<u32>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
}
impl ParsedMetadata {
    fn with_media(self, media: MediaUrl) -> ProgressiveResolved {
        ProgressiveResolved {
            platform: self.platform,
            content_id: self.content_id,
            canonical_url: self.canonical_url,
            title: self.title,
            duration_seconds: self.duration_seconds,
            media,
            width: self.width,
            height: self.height,
            video_codec: self.video_codec,
            audio_codec: self.audio_codec,
        }
    }
}
fn normalize(resource: &VideoRef, value: &Value, now_ms: u64) -> Result<ParsedVideo> {
    let item = object(value)?;
    let id = required_alias(item, &["id", "aweme_id", "awemeId"])?;
    let id = if let Some(id) = id.as_str() {
        if !decimal(id) {
            return Err(Error::InvalidResponse("identity"));
        }
        id.to_owned()
    } else {
        let id = unsigned(id)?;
        if id == 0 {
            return Err(Error::InvalidResponse("identity"));
        }
        id.to_string()
    };
    if id != resource.id {
        return Err(Error::InvalidResponse("identity_mismatch"));
    }
    if let Some(expected) = &resource.handle {
        let author = object(
            item.get("author")
                .ok_or(Error::InvalidResponse("author_identity"))?,
        )?;
        let actual = required_alias(author, &["uniqueId", "unique_id"])?
            .as_str()
            .ok_or(Error::InvalidResponse("author_identity"))?;
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(Error::InvalidResponse("author_identity_mismatch"));
        }
    }
    if drm(item)? {
        return Err(Error::Unsupported(Unsupported::Drm));
    }
    if let Some(kind) = optional_alias(item, &["aweme_type", "awemeType"])? {
        match unsigned(kind)? {
            0 => {}
            101 => return Err(Error::Unsupported(Unsupported::Live)),
            2 | 68 | 150 => return Err(Error::Unsupported(Unsupported::ImagePost)),
            _ => return Err(Error::InvalidResponse("unsupported_content_type")),
        }
    }
    if explicit_flag(item, &["isLive", "is_live"])? {
        return Err(Error::Unsupported(Unsupported::Live));
    }
    if optional_alias(item, &["imagePost", "image_post_info", "images"])?.is_some() {
        return Err(Error::Unsupported(Unsupported::ImagePost));
    }
    if explicit_flag(item, &["isPrivate", "is_private"])?
        || explicit_flag(item, &["isFriendsOnly", "is_friends_only"])?
    {
        return Err(Error::Restricted("private_or_friends_only"));
    }
    let video = item.get("video").filter(|v| !v.is_null()).ok_or_else(|| {
        if item.get("isContentClassified").and_then(Value::as_bool) == Some(true) {
            Error::Restricted("login_required")
        } else {
            Error::Unsupported(Unsupported::NoProgressiveVideo)
        }
    })?;
    let video = object(video)?;
    if drm(video)? {
        return Err(Error::Unsupported(Unsupported::Drm));
    }
    if explicit_flag(video, &["isLive", "is_live"])? {
        return Err(Error::Unsupported(Unsupported::Live));
    }
    let duration = unsigned(required_alias(video, &["duration"])?)?;
    let duration_seconds = match resource.platform {
        Platform::Douyin => duration as f64 / 1000.0,
        Platform::TikTok => duration as f64,
    };
    if duration_seconds <= 0.0 || duration_seconds > MAX_DURATION_SECONDS {
        return Err(Error::InvalidResponse("duration"));
    }
    let title = required_alias(item, &["desc", "description"])?
        .as_str()
        .ok_or(Error::InvalidResponse("title"))?;
    if title.len() > 16_384
        || title
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err(Error::InvalidResponse("title"));
    }
    let video_codec = declaration(video, &["videoCodec", "video_codec", "codec"])?;
    let audio_codec = declaration(video, &["audioCodec", "audio_codec"])?;
    let mut candidates = Vec::new();
    if let Some(address) = optional_alias(video, &["playAddr", "play_addr"])? {
        address_urls(address, &mut candidates)?;
    }
    if let Some(bitrates) = optional_alias(video, &["bitrateInfo", "bit_rate"])? {
        let bitrates = bitrates
            .as_array()
            .ok_or(Error::InvalidResponse("bitrates"))?;
        if bitrates.len() > 32 {
            return Err(Error::TooLarge);
        }
        for bitrate in bitrates {
            let bitrate = object(bitrate)?;
            if drm(bitrate)? {
                return Err(Error::Unsupported(Unsupported::Drm));
            }
            if explicit_flag(bitrate, &["is_bytevc1", "isBytevc1"])? {
                continue;
            }
            if let Some(address) = optional_alias(bitrate, &["PlayAddr", "play_addr", "playAddr"])?
            {
                if let Some(key) = address
                    .as_object()
                    .and_then(|o| o.get("UrlKey").or_else(|| o.get("url_key")))
                    .and_then(Value::as_str)
                    && (key.contains("bytevc1")
                        || key.contains("bytevc2")
                        || key.contains("hvc1")
                        || key.contains("hevc")
                        || key.contains("vvc"))
                {
                    continue;
                }
                address_urls(address, &mut candidates)?;
            }
        }
    }
    if let Some(address) = optional_alias(video, &["downloadAddr", "download_addr"])? {
        address_urls(address, &mut candidates)?;
    }
    let mut seen = HashSet::new();
    let mut selected = None;
    let mut redirect = None;
    let mut last_rejection = Error::Unsupported(Unsupported::NoProgressiveVideo);
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }
        if resource.platform == Platform::Douyin
            && candidate.starts_with("https://aweme.snssdk.com/")
        {
            let target = validate_play_redirect_url(&candidate)?;
            let expected_uri = optional_alias(video, &["play_addr", "playAddr"])?
                .and_then(Value::as_object)
                .and_then(|a| a.get("uri"))
                .and_then(Value::as_str)
                .ok_or(Error::InvalidResponse("play_identity"))?;
            if !target
                .query_pairs()
                .any(|(key, value)| key == "video_id" && value == expected_uri)
            {
                return Err(Error::InvalidResponse("play_identity_mismatch"));
            }
            if redirect.is_none() {
                redirect = Some(PageRequest::play_redirect(target));
            }
            continue;
        }
        match parse_media(resource.platform, &candidate, now_ms) {
            Ok(media) if selected.is_none() => selected = Some(MediaCandidate::Direct(media)),
            Ok(_) => {}
            Err(
                error @ (Error::Unsupported(Unsupported::NoProgressiveVideo)
                | Error::Restricted("cdn_origin_denied")
                | Error::Restricted("media_expired")),
            ) => last_rejection = error,
            Err(error) => return Err(error),
        }
    }
    let media = selected
        .or_else(|| redirect.map(MediaCandidate::Redirect))
        .ok_or(last_rejection)?;
    Ok(ParsedVideo {
        metadata: ParsedMetadata {
            platform: resource.platform,
            content_id: id,
            canonical_url: resource.canonical(),
            title: title.to_owned(),
            duration_seconds,
            width: dimension(video, "width")?,
            height: dimension(video, "height")?,
            video_codec,
            audio_codec,
        },
        media,
    })
}

fn address_urls(value: &Value, out: &mut Vec<String>) -> Result<()> {
    match value {
        Value::String(value) => push_candidate(value, out),
        Value::Array(values) => {
            if values.len() > 16 {
                return Err(Error::TooLarge);
            }
            for value in values {
                // Apply identical DRM/track-only handling to every src object.
                // Nested arrays are outside the supported address shape.
                object(value)?;
                address_urls(value, out)?;
            }
            Ok(())
        }
        Value::Object(value) => {
            if drm(value)? {
                return Err(Error::Unsupported(Unsupported::Drm));
            }
            if explicit_flag(value, &["audioOnly", "audio_only"])?
                || explicit_flag(value, &["videoOnly", "video_only"])?
            {
                return Ok(());
            }
            if let Some(urls) = optional_alias(value, &["UrlList", "urlList", "url_list"])? {
                let urls = urls
                    .as_array()
                    .ok_or(Error::InvalidResponse("media_addresses"))?;
                if urls.len() > 16 {
                    return Err(Error::TooLarge);
                }
                for url in urls {
                    push_candidate(
                        url.as_str()
                            .ok_or(Error::InvalidResponse("media_address"))?,
                        out,
                    )?;
                }
                Ok(())
            } else if let Some(url) = optional_alias(value, &["src", "url", "download"])? {
                push_candidate(
                    url.as_str()
                        .ok_or(Error::InvalidResponse("media_address"))?,
                    out,
                )
            } else {
                Err(Error::InvalidResponse("media_address"))
            }
        }
        Value::Null => Ok(()),
        _ => Err(Error::InvalidResponse("media_address")),
    }
}
fn push_candidate(value: &str, out: &mut Vec<String>) -> Result<()> {
    if out.len() >= MAX_CANDIDATES {
        return Err(Error::TooLarge);
    }
    if value.is_empty() || value.len() > 16 * 1024 {
        return Err(Error::InvalidResponse("media_address"));
    }
    out.push(value.to_owned());
    Ok(())
}
fn parse_media(platform: Platform, value: &str, now_ms: u64) -> Result<MediaUrl> {
    // Scheme-relative HTTPS hydration addresses do not choose a new scheme or
    // origin; they are normalized exactly once before closed-policy validation.
    let normalized = value
        .strip_prefix("//")
        .map(|rest| format!("https://{rest}"));
    let url = validate_media_url(platform, normalized.as_deref().unwrap_or(value))?;
    let path = url.path().to_ascii_lowercase();
    if path.contains("media-video-hvc1")
        || path.contains("media-audio")
        || path.ends_with(".m3u8")
        || path.ends_with(".mpd")
        || path.ends_with(".flv")
        || path.ends_with(".m4a")
        || path.ends_with(".mp3")
        || path.contains("/live/")
    {
        return Err(Error::Unsupported(Unsupported::NoProgressiveVideo));
    }
    let mut mime = false;
    let mut expires = None;
    let mut keys = HashSet::new();
    for (key, value) in url.query_pairs() {
        if !keys.insert(key.to_ascii_lowercase()) {
            return Err(Error::InvalidResponse("duplicate_media_query"));
        }
        match key.as_ref() {
            "mime_type" => {
                if value != "video_mp4" && value != "video/mp4" {
                    return Err(Error::Unsupported(Unsupported::NoProgressiveVideo));
                }
                mime = true;
            }
            "x-expires" | "expire" | "expires" | "VExpiration" => {
                if !decimal(&value) {
                    return Err(Error::InvalidResponse("media_expiry"));
                }
                let seconds: u64 = value
                    .parse()
                    .map_err(|_| Error::InvalidResponse("media_expiry"))?;
                let millis = seconds
                    .checked_mul(1000)
                    .ok_or(Error::InvalidResponse("media_expiry"))?;
                expires = Some(expires.map_or(millis, |prior: u64| prior.min(millis)));
            }
            _ => {}
        }
    }
    if !path.ends_with(".mp4") && !mime {
        return Err(Error::Unsupported(Unsupported::NoProgressiveVideo));
    }
    // Common signed /<32hex signature>/<8hex Unix time>/video/... CDN form.
    let segments: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
    if segments.len() >= 3
        && segments[0].len() == 32
        && segments[0].bytes().all(|b| b.is_ascii_hexdigit())
        && segments[1].len() == 8
        && segments[1].bytes().all(|b| b.is_ascii_hexdigit())
        && segments[2] == "video"
    {
        let seconds = u64::from_str_radix(segments[1], 16)
            .map_err(|_| Error::InvalidResponse("media_expiry"))?;
        let millis = seconds
            .checked_mul(1000)
            .ok_or(Error::InvalidResponse("media_expiry"))?;
        expires = Some(expires.map_or(millis, |prior| prior.min(millis)));
    }
    if expires.is_some_and(|expires| expires <= now_ms.saturating_add(5000)) {
        return Err(Error::Restricted("media_expired"));
    }
    Ok(MediaUrl {
        url,
        expires_at_ms: expires,
    })
}

struct Script<'a> {
    id: Option<String>,
    body: &'a str,
}
fn scripts(html: &str) -> Result<Vec<Script<'_>>> {
    // Raw-text content and attribute values stay untouched. Skip comments and
    // non-script raw-text elements so inert markup cannot impersonate hydration.
    // In particular HTML entities are not decoded inside <script> raw text.
    let lower = html.to_ascii_lowercase();
    let mut scripts = Vec::new();
    let mut position = 0;
    while let Some(offset) = lower[position..].find('<') {
        let start = position + offset;
        if lower[start..].starts_with("<!--") {
            position = lower[start + 4..]
                .find("-->")
                .map(|offset| start + 4 + offset + 3)
                .ok_or(Error::InvalidResponse("html_comment"))?;
            continue;
        }
        let name_start = start + 1;
        let mut name_end = name_start;
        while lower
            .as_bytes()
            .get(name_end)
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'-')
        {
            name_end += 1;
        }
        if name_start == name_end {
            position = start + 1;
            continue;
        }
        let name = &lower[name_start..name_end];
        let end = tag_end(html, name_end)?;
        position = end + 1;
        if matches!(
            name,
            "style" | "title" | "textarea" | "xmp" | "iframe" | "noembed" | "noframes"
        ) {
            let close = raw_close(&lower, position, name)?;
            position = tag_end(html, close + name.len() + 2)? + 1;
            continue;
        }
        if name != "script" {
            continue;
        }
        if scripts.len() >= MAX_SCRIPT_COUNT {
            return Err(Error::TooLarge);
        }
        let id = script_id(&html[name_end..end])?;
        let body_start = position;
        let body_end = raw_close(&lower, body_start, "script")?;
        let close_end = tag_end(html, body_end + 8)?;
        scripts.push(Script {
            id,
            body: &html[body_start..body_end],
        });
        position = close_end + 1;
    }
    Ok(scripts)
}
fn raw_close(lower: &str, start: usize, name: &str) -> Result<usize> {
    let marker = format!("</{name}");
    let mut pos = start;
    while let Some(offset) = lower[pos..].find(&marker) {
        let found = pos + offset;
        let boundary = lower.as_bytes().get(found + marker.len()).copied();
        if boundary.is_some_and(|b| b.is_ascii_whitespace() || b == b'>') {
            return Ok(found);
        }
        pos = found + marker.len();
    }
    Err(Error::InvalidResponse("script_tag"))
}
fn tag_end(html: &str, start: usize) -> Result<usize> {
    let mut quote = None;
    for (offset, byte) in html.as_bytes()[start..].iter().copied().enumerate() {
        if offset >= MAX_SCRIPT_TAG {
            return Err(Error::TooLarge);
        }
        match (quote, byte) {
            (None, b'\'' | b'"') => quote = Some(byte),
            (Some(open), close) if open == close => quote = None,
            (None, b'>') => return Ok(start + offset),
            _ => {}
        }
    }
    Err(Error::InvalidResponse("script_tag"))
}
fn script_id(attributes: &str) -> Result<Option<String>> {
    let bytes = attributes.as_bytes();
    let mut pos = 0;
    let mut id = None;
    while pos < bytes.len() {
        while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        if pos == bytes.len() {
            break;
        }
        let start = pos;
        while pos < bytes.len()
            && !bytes[pos].is_ascii_whitespace()
            && !matches!(bytes[pos], b'=' | b'/')
        {
            pos += 1;
        }
        if pos == start {
            return Err(Error::InvalidResponse("script_attribute"));
        }
        let name = &attributes[start..pos];
        while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        let value = if bytes.get(pos) == Some(&b'=') {
            pos += 1;
            while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
                pos += 1;
            }
            if matches!(bytes.get(pos), Some(b'\'' | b'"')) {
                let quote = bytes[pos];
                pos += 1;
                let start = pos;
                while pos < bytes.len() && bytes[pos] != quote {
                    pos += 1;
                }
                if pos == bytes.len() {
                    return Err(Error::InvalidResponse("script_attribute"));
                }
                let value = &attributes[start..pos];
                pos += 1;
                value
            } else {
                let start = pos;
                while pos < bytes.len() && !bytes[pos].is_ascii_whitespace() {
                    pos += 1;
                }
                if start == pos {
                    return Err(Error::InvalidResponse("script_attribute"));
                }
                &attributes[start..pos]
            }
        } else {
            ""
        };
        if name.eq_ignore_ascii_case("id") {
            if id.is_some() || value.is_empty() || value.len() > 128 || !value.is_ascii() {
                return Err(Error::InvalidResponse("script_id"));
            }
            id = Some(value.to_owned());
        }
    }
    Ok(id)
}
fn percent_decode(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut pos = 0;
    while pos < bytes.len() {
        if bytes[pos] == b'%' {
            let hex = bytes.get(pos + 1..pos + 3).ok_or(Error::InvalidJson)?;
            let text = std::str::from_utf8(hex).map_err(|_| Error::InvalidJson)?;
            decoded.push(u8::from_str_radix(text, 16).map_err(|_| Error::InvalidJson)?);
            pos += 3;
        } else {
            decoded.push(bytes[pos]);
            pos += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| Error::InvalidJson)
}
fn is_challenge(html: &str) -> bool {
    html.contains("_$jsvmprt")
        || html.contains("_wafchallengeid")
        || html.contains("id=\"wci\"")
        || html.contains("id='wci'")
        || html.contains("<title>Please wait")
        || html.contains("<title>Verify")
        || html.contains("/captcha/")
}

/// The only accepted official play-discovery descriptor. It comes from an
/// already identity-checked hydration play_addr, not a caller URL. Query order
/// and values are retained unchanged; no watermark or quality transformation.
/// Primary original endpoint/parameters:
/// https://github.com/iawia002/lux/issues/859
/// https://github.com/jackspeng/douyin-api-1/blob/master/%E7%94%A8%E6%88%B7/%E6%8A%96%E9%9F%B3Api%EF%BC%9A%E7%94%A8%E6%88%B7%E8%A7%86%E9%A2%91%E5%88%97%E8%A1%A8.md
pub fn validate_play_redirect_url(value: &str) -> Result<Url> {
    if value.len() > 8192
        || !value.is_ascii()
        || value.bytes().any(|b| b <= b' ' || b == 0x7f || b == b'\\')
    {
        return Err(Error::InvalidResponse("play_redirect"));
    }
    let rest = value
        .strip_prefix("https://aweme.snssdk.com/")
        .ok_or(Error::InvalidResponse("play_redirect"))?;
    let (path, raw_query) = rest
        .split_once('?')
        .ok_or(Error::InvalidResponse("play_redirect"))?;
    if !matches!(path, "aweme/v1/play/" | "aweme/v1/playwm/")
        || raw_query.is_empty()
        || raw_query.contains(['%', '#', '+'])
    {
        return Err(Error::InvalidResponse("play_redirect"));
    }
    let url = Url::parse(value).map_err(|_| Error::InvalidResponse("play_redirect"))?;
    let mut keys = HashSet::new();
    for (key, value) in url.query_pairs() {
        if keys.len() >= 16 || !keys.insert(key.to_string()) {
            return Err(Error::InvalidResponse("play_redirect_query"));
        }
        let valid = match key.as_ref() {
            "video_id" => {
                (8..=128).contains(&value.len())
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            }
            "ratio" => matches!(
                value.as_ref(),
                "default" | "240p" | "360p" | "480p" | "540p" | "720p" | "1080p"
            ),
            "line" | "adapt540" => matches!(value.as_ref(), "0" | "1"),
            "media_type" => value == "4",
            "vr_type" | "improve_bitrate" | "is_support_h265" | "bytevc1" => value == "0",
            "is_play_url" => value == "1",
            "quality_type" => {
                value.bytes().all(|b| b.is_ascii_digit()) && value.parse::<u8>().is_ok()
            }
            "source" => value == "PackSourceEnum_PUBLISH",
            _ => false,
        };
        if !valid {
            return Err(Error::InvalidResponse("play_redirect_query"));
        }
    }
    if !["video_id", "ratio", "line"]
        .iter()
        .all(|key| keys.contains(*key))
    {
        return Err(Error::InvalidResponse("play_redirect_query"));
    }
    Ok(url)
}
fn router_json<'a>(scripts: &[Script<'a>]) -> Result<Option<&'a str>> {
    let mut found = None;
    for script in scripts {
        let body = script.body.trim();
        let Some(rest) = body.strip_prefix("window._ROUTER_DATA") else {
            continue;
        };
        let rest = rest
            .trim_start()
            .strip_prefix('=')
            .ok_or(Error::InvalidJson)?
            .trim_start();
        if !rest.starts_with('{') || found.is_some() {
            return Err(Error::InvalidResponse("duplicate_hydration"));
        }
        let mut depth = 0usize;
        let mut quoted = false;
        let mut escape = false;
        let mut end = None;
        for (index, byte) in rest.bytes().enumerate() {
            if quoted {
                if escape {
                    escape = false;
                } else if byte == b'\\' {
                    escape = true;
                } else if byte == b'"' {
                    quoted = false;
                }
                continue;
            }
            match byte {
                b'"' => quoted = true,
                b'{' => {
                    depth += 1;
                    if depth > 64 {
                        return Err(Error::InvalidJson);
                    }
                }
                b'}' => {
                    depth = depth.checked_sub(1).ok_or(Error::InvalidJson)?;
                    if depth == 0 {
                        end = Some(index + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        let end = end.ok_or(Error::InvalidJson)?;
        if !matches!(rest[end..].trim(), "" | ";") {
            return Err(Error::InvalidJson);
        }
        found = Some(&rest[..end]);
    }
    Ok(found)
}
