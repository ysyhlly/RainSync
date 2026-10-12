//! Private, fixed-provider HTTPS transport.
//!
//! No caller-provided origin, proxy, resolver or redirect policy is accepted.
//! A whole bounded DNS answer is checked for public addresses, then the existing
//! source-access client pins exactly that answer while retaining Host/TLS SNI.
//! Cookies are permitted only on fixed Bilibili account APIs and typed,
//! provider-bound Douyin/TikTok authenticated metadata endpoints. Anonymous
//! pages, typed discovery and every provider's media stay credential-free.
//! Errors and Debug implementations omit URLs and headers.

mod course_http;
mod cover_http;
mod live_http;
mod oauth_http;
mod other_live_http;
mod pgc_http;
mod renewal_http;
mod text_http;

use super::{
    bilibili::{self, ApiRequest, ApiResponse, Endpoint},
    short_video::{self, PageRequest, PageResponse},
};
use crate::access_policy::{
    AuthorizedClient, OriginRule, Resolution, Resolver, SourceAccess, SourceAccessPolicy,
    SystemResolver,
};
use reqwest::{
    Method, StatusCode, Url,
    header::{self, HeaderMap, HeaderName, HeaderValue},
};
use std::{
    collections::{BTreeMap, HashSet},
    fmt,
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    pin::Pin,
    time::Duration,
};
use tokio::time::Instant;
#[path = "http/import_http.rs"]
mod import_http;

const MAX_URL_BYTES: usize = 16 * 1024;
const MAX_DNS_ADDRESSES: usize = 64;
const DNS_TIMEOUT: Duration = Duration::from_secs(3);
const API_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_RESPONSE_HEADERS: usize = 128;
const MAX_SET_COOKIES: usize = 32;
const MAX_COOKIE_BYTES: usize = 8192;
const MAX_MEDIA_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_MEDIA_LIFETIME: Duration = Duration::from_secs(6 * 60 * 60);
const USER_AGENT: &str = "Mozilla/5.0 RainSync/0.1";
const REFERER: &str = "https://www.bilibili.com/";
const MAX_PLAY_LOCATION_BYTES: usize = 8192;

type Result<T> = std::result::Result<T, bilibili::Error>;

/// A closed server-side policy selector, never a caller-supplied host family.
/// Names must match persisted playback bindings exactly, without aliases.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Provider {
    Bilibili,
    Douyin,
    TikTok,
    YouTube,
}

impl Provider {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "bilibili" => Ok(Self::Bilibili),
            "douyin" => Ok(Self::Douyin),
            "tiktok" => Ok(Self::TikTok),
            "youtube" => Ok(Self::YouTube),
            _ => Err(bilibili::Error::Restricted("platform_provider_denied")),
        }
    }

    fn referer(self) -> &'static str {
        match self {
            Self::Bilibili => REFERER,
            Self::Douyin => "https://www.douyin.com/",
            Self::TikTok => "https://www.tiktok.com/",
            Self::YouTube => "https://www.youtube.com/",
        }
    }

    fn permits_media_host(self, host: &str) -> bool {
        match self {
            Self::Bilibili => {
                [
                    "bilivideo.com",
                    "bilivideo.cn",
                    "bilivideo.net",
                    "hdslb.com",
                ]
                .iter()
                .any(|root| domain_matches(host, root))
                    || host == "upos-hz-mirrorakam.akamaized.net"
            }
            // Provenance: developer-maintained video observations in
            // https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/main/src/dtk/media/domains.py
            // (Douyin: v9-v2-mps-cdn.douyinvod.com and the exact zjcdn host below;
            // TikTok: named video families and v16-webapp-prime.us.tiktok.com).
            // These are policy inputs, not a claim of live acceptance. Shared
            // ByteDance/ByteCDN roots, image/static hosts and live are absent.
            Self::Douyin => {
                domain_matches(host, "douyinvod.com") || host == "v5-dy-ov-experiment.zjcdn.com"
            }
            Self::TikTok => {
                [
                    "tiktokcdn.com",
                    "tiktokcdn-us.com",
                    "tiktokcdn-eu.com",
                    "tiktokv.com",
                    "tiktokv.us",
                ]
                .iter()
                .any(|root| domain_matches(host, root))
                    // Additional observed exact video hosts:
                    // https://github.com/yt-dlp/yt-dlp/issues/9704
                    // https://github.com/yt-dlp/yt-dlp/issues/13771
                    || matches!(
                        host,
                        "v16-webapp-prime.us.tiktok.com"
                            | "v16-webapp-prime.tiktok.com"
                            | "v19-webapp-prime.tiktok.com"
                    )
            }
            Self::YouTube => domain_matches(host, "googlevideo.com"),
        }
    }
}

fn media_headers(provider: Provider) -> HeaderMap {
    HeaderMap::from_iter([
        (header::USER_AGENT, HeaderValue::from_static(USER_AGENT)),
        (
            header::REFERER,
            HeaderValue::from_static(provider.referer()),
        ),
        (
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        ),
    ])
}

/// Production transport. Configuration cannot turn this into a general proxy.
#[derive(Clone, Copy, Debug, Default)]
pub struct PlatformHttp;

impl PlatformHttp {
    pub fn new() -> Self {
        Self
    }

    /// Fetch an authorized Bilibili CDN track. The caller must separately check
    /// its account, playback grant, room membership and source revision. The
    /// target is server-owned and must never be accepted from a browser URL.
    /// Redirects are deliberately refused, including same-origin redirects.
    pub async fn media_request(
        &self,
        target: &str,
        method: Method,
        range: Option<&str>,
        deadline: Instant,
    ) -> Result<MediaResponse> {
        self.media_request_for("bilibili", target, method, range, deadline)
            .await
    }

    /// Fetch an authorized, server-owned CDN track under one named provider's
    /// closed origin policy. The persisted binding supplies the provider name;
    /// a browser must never supply either the raw target or its provider scope.
    /// Cookies, authentication headers, redirects, proxies and caller-defined
    /// headers are refused.
    pub async fn media_request_for(
        &self,
        provider: &str,
        target: &str,
        method: Method,
        range: Option<&str>,
        deadline: Instant,
    ) -> Result<MediaResponse> {
        let provider = Provider::parse(provider)?;
        if !matches!(method, Method::GET | Method::HEAD) {
            return Err(bilibili::Error::Restricted("platform_method_denied"));
        }
        let url = validate_media_url_for_provider(provider, target)?;
        let range = range.map(validate_range).transpose()?;
        let deadline = bounded_deadline(deadline, MAX_MEDIA_LIFETIME)?;
        let client = pinned_client(&url, &SystemResolver, deadline).await?;
        let mut request = client
            .request(method)
            .headers(media_headers(provider))
            .timeout(remaining(deadline)?);
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        let response = tokio::time::timeout_at(deadline, request.send())
            .await
            .map_err(|_| bilibili::Error::Deadline)?
            .map_err(http_error)?;
        check_response_headers(response.headers())?;
        validate_media_encoding(response.headers())?;
        if response.status().is_redirection() {
            return Err(bilibili::Error::Restricted("platform_redirect_denied"));
        }
        if !matches!(
            response.status(),
            StatusCode::OK | StatusCode::PARTIAL_CONTENT
        ) {
            return Err(bilibili::Error::Status(response.status().as_u16()));
        }
        let mut headers = HeaderMap::new();
        // Deliberately exclude Location, Set-Cookie, authentication and all
        // arbitrary upstream headers from the downstream streaming contract.
        for name in [
            header::CONTENT_TYPE,
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::CONTENT_ENCODING,
            header::ACCEPT_RANGES,
            header::ETAG,
            header::LAST_MODIFIED,
            header::CACHE_CONTROL,
        ] {
            // Preserve cardinality so a range probe/delivery can reject ambiguous
            // duplicate framing and validators instead of trusting the first value.
            for value in response.headers().get_all(&name) {
                headers.append(name.clone(), value.clone());
            }
        }
        Ok(MediaResponse {
            response,
            headers,
            deadline,
        })
    }
}

fn validate_media_encoding(headers: &HeaderMap) -> Result<()> {
    let mut values = headers.get_all(header::CONTENT_ENCODING).iter();
    if let Some(value) = values.next()
        && (values.next().is_some() || value.as_bytes() != b"identity")
    {
        return Err(bilibili::Error::InvalidResponse(
            "platform_media_encoding_denied",
        ));
    }
    Ok(())
}

impl bilibili::Transport for PlatformHttp {
    fn get<'a>(
        &'a self,
        request: ApiRequest,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + 'a>> {
        Box::pin(async move {
            let deadline = bounded_deadline(deadline, API_TIMEOUT)?;
            tokio::time::timeout_at(deadline, api_get(request, deadline))
                .await
                .map_err(|_| bilibili::Error::Deadline)?
        })
    }
}

impl short_video::Transport for PlatformHttp {
    fn get<'a>(
        &'a self,
        request: PageRequest,
        deadline: Instant,
    ) -> Pin<
        Box<dyn Future<Output = std::result::Result<PageResponse, short_video::Error>> + Send + 'a>,
    > {
        Box::pin(async move {
            let deadline = bounded_deadline(deadline, API_TIMEOUT).map_err(short_video_error)?;
            tokio::time::timeout_at(deadline, page_get(request, deadline))
                .await
                .map_err(|_| short_video::Error::Deadline)?
                .map_err(short_video_error)
        })
    }
}

fn short_video_error(error: bilibili::Error) -> short_video::Error {
    match error {
        bilibili::Error::InvalidResource => short_video::Error::InvalidResource,
        bilibili::Error::InvalidResponse(reason) => short_video::Error::InvalidResponse(reason),
        bilibili::Error::InvalidQrUrl(_) => short_video::Error::InvalidResponse("qr_url"),
        bilibili::Error::InvalidJson => short_video::Error::InvalidJson,
        bilibili::Error::Restricted(reason) => short_video::Error::Restricted(reason),
        bilibili::Error::Api(code) => short_video::Error::Api(code),
        bilibili::Error::Status(status) => short_video::Error::Status(status),
        bilibili::Error::Deadline => short_video::Error::Deadline,
        bilibili::Error::Transport => short_video::Error::Transport,
        bilibili::Error::TooLarge => short_video::Error::TooLarge,
    }
}

/// Fixed anonymous pages, typed authenticated metadata and one anonymous Douyin
/// play discovery only. No cookie bootstrap, generated signatures, arbitrary
/// URL, automatic redirects, caller headers or anti-bot fallback is available.
async fn page_get(request: PageRequest, deadline: Instant) -> Result<PageResponse> {
    let discover = matches!(
        request.endpoint(),
        short_video::Endpoint::DouyinPlayRedirect
    );
    let provider = validate_page_url(request.endpoint(), request.url())?;
    let headers = page_headers(
        request.endpoint(),
        provider,
        request.headers(),
        request.credential(),
    )?;
    let limit = request.max_response_bytes();
    if (discover && limit != 0) || (!discover && (limit == 0 || limit > MAX_JSON_BYTES)) {
        return Err(bilibili::Error::TooLarge);
    }
    let client = pinned_client(request.url(), &SystemResolver, deadline).await?;
    let mut response = client
        .request(Method::GET)
        .headers(headers)
        .timeout(remaining(deadline)?)
        .send()
        .await
        .map_err(http_error)?;
    check_response_headers(response.headers())?;
    if discover {
        // Never consume a play endpoint's body, including a 200 stream. The
        // core rejects every non-approved 3xx/challenge status. A Location is
        // only returned after exact cardinality/size and final CDN validation.
        let location = capture_play_location(response.status(), response.headers())?;
        return Ok(PageResponse {
            status: response.status().as_u16(),
            body: Vec::new(),
            location,
        });
    }
    if response.status().is_redirection() {
        return Err(bilibili::Error::Restricted("platform_redirect_denied"));
    }
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(bilibili::Error::TooLarge);
    }
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(http_error)? {
        append_bounded(&mut body, &chunk, limit)?;
    }
    // Set-Cookie and every other upstream header are intentionally discarded.
    Ok(PageResponse {
        status,
        body,
        location: None,
    })
}

fn capture_play_location(status: StatusCode, headers: &HeaderMap) -> Result<Option<String>> {
    if !matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    ) {
        return Ok(None);
    }
    let mut values = headers.get_all(header::LOCATION).iter();
    let location = values.next().ok_or(bilibili::Error::InvalidResponse(
        "missing_platform_redirect",
    ))?;
    if values.next().is_some() {
        return Err(bilibili::Error::InvalidResponse(
            "duplicate_platform_redirect",
        ));
    }
    if location.as_bytes().len() > MAX_PLAY_LOCATION_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    let location = location
        .to_str()
        .map_err(|_| bilibili::Error::InvalidResponse("invalid_platform_redirect"))?;
    validate_media_url_for_provider(Provider::Douyin, location)?;
    Ok(Some(location.to_owned()))
}

fn validate_page_url(endpoint: short_video::Endpoint, url: &Url) -> Result<Provider> {
    strict_https_url(url.as_str())?;
    if matches!(endpoint, short_video::Endpoint::DouyinPlayRedirect) {
        short_video::validate_play_redirect_url(url.as_str())
            .map_err(|_| bilibili::Error::Restricted("platform_origin_denied"))?;
        return Ok(Provider::Douyin);
    }
    if endpoint == short_video::Endpoint::DouyinAuthenticatedDetail {
        let identity = url
            .query()
            .and_then(|query| query.strip_prefix("aweme_id="))
            .ok_or(bilibili::Error::Restricted("platform_origin_denied"))?;
        let resource = short_video::parse_resource(short_video::Platform::Douyin, identity)
            .map_err(|_| bilibili::Error::Restricted("platform_origin_denied"))?;
        if url.as_str()
            != format!(
                "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id={}",
                resource.id()
            )
        {
            return Err(bilibili::Error::Restricted("platform_origin_denied"));
        }
        return Ok(Provider::Douyin);
    }
    if url.query().is_some() || url.path().contains('%') {
        return Err(bilibili::Error::Restricted("platform_origin_denied"));
    }
    let (provider, platform, host, identity) = match endpoint {
        short_video::Endpoint::DouyinWebpage => (
            Provider::Douyin,
            short_video::Platform::Douyin,
            "www.iesdouyin.com",
            url.path().strip_prefix("/share/video/").unwrap_or(""),
        ),
        short_video::Endpoint::TikTokWebpage
        | short_video::Endpoint::TikTokAuthenticatedWebpage => (
            Provider::TikTok,
            short_video::Platform::TikTok,
            "www.tiktok.com",
            url.as_str(),
        ),
        short_video::Endpoint::DouyinPlayRedirect
        | short_video::Endpoint::DouyinAuthenticatedDetail => unreachable!("validated separately"),
    };
    let resource = short_video::parse_resource(platform, identity)
        .map_err(|_| bilibili::Error::Restricted("platform_origin_denied"))?;
    let expected = match provider {
        Provider::Douyin => format!("https://www.iesdouyin.com/share/video/{}", resource.id()),
        Provider::TikTok => resource.canonical(),
        _ => return Err(bilibili::Error::Restricted("platform_origin_denied")),
    };
    if url.host_str() != Some(host) || expected != url.as_str() {
        return Err(bilibili::Error::Restricted("platform_origin_denied"));
    }
    Ok(provider)
}

fn page_headers(
    endpoint: short_video::Endpoint,
    provider: Provider,
    supplied: &BTreeMap<String, String>,
    credential: Option<&short_video::Credential>,
) -> Result<HeaderMap> {
    if !matches!(provider, Provider::Douyin | Provider::TikTok) || supplied.len() > 4 {
        return Err(bilibili::Error::Restricted("platform_header_denied"));
    }
    let mut headers = media_headers(provider);
    if provider == Provider::Douyin && endpoint != short_video::Endpoint::DouyinAuthenticatedDetail
    {
        headers.insert(
            header::USER_AGENT,
            HeaderValue::from_static(short_video::DOUYIN_USER_AGENT),
        );
    }
    headers.insert(
        header::ACCEPT,
        HeaderValue::from_static(
            if endpoint == short_video::Endpoint::DouyinAuthenticatedDetail {
                "application/json"
            } else {
                "text/html"
            },
        ),
    );
    let mut names = HashSet::new();
    for (name, value) in supplied {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| bilibili::Error::Restricted("platform_header_denied"))?;
        if !names.insert(name.clone())
            || headers
                .get(&name)
                .is_none_or(|expected| expected.as_bytes() != value.as_bytes())
        {
            return Err(bilibili::Error::Restricted("platform_header_denied"));
        }
    }
    let authenticated_platform = match endpoint {
        short_video::Endpoint::DouyinAuthenticatedDetail if provider == Provider::Douyin => {
            Some(short_video::Platform::Douyin)
        }
        short_video::Endpoint::TikTokAuthenticatedWebpage if provider == Provider::TikTok => {
            Some(short_video::Platform::TikTok)
        }
        short_video::Endpoint::DouyinWebpage | short_video::Endpoint::DouyinPlayRedirect
            if provider == Provider::Douyin =>
        {
            None
        }
        short_video::Endpoint::TikTokWebpage if provider == Provider::TikTok => None,
        _ => return Err(bilibili::Error::Restricted("platform_header_denied")),
    };
    match (authenticated_platform, credential) {
        (Some(platform), Some(credential)) if credential.platform() == platform => {
            // Revalidate even opaque stored state, then mark the transport's
            // header sensitive so reqwest/HeaderMap Debug cannot expose it.
            let checked = short_video::Credential::parse(platform, credential.cookie_header())
                .map_err(|_| bilibili::Error::Restricted("platform_header_denied"))?;
            let mut value = HeaderValue::from_str(checked.cookie_header())
                .map_err(|_| bilibili::Error::Restricted("platform_header_denied"))?;
            value.set_sensitive(true);
            headers.insert(header::COOKIE, value);
        }
        (None, None) => {}
        _ => return Err(bilibili::Error::Restricted("platform_header_denied")),
    }
    // Return server constants rather than caller strings, even for exact matches.
    Ok(headers)
}

async fn api_get(request: ApiRequest, deadline: Instant) -> Result<ApiResponse> {
    let url = request.url();
    validate_api_url(request.endpoint(), &url)?;
    let headers = api_headers(&request)?;
    let limit = request.max_response_bytes();
    if limit == 0 || limit > MAX_JSON_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    let client = pinned_client(&url, &SystemResolver, deadline).await?;
    let mut response = client
        .request(Method::GET)
        .headers(headers)
        .timeout(remaining(deadline)?)
        .send()
        .await
        .map_err(http_error)?;
    check_response_headers(response.headers())?;
    if response.status().is_redirection() {
        return Err(bilibili::Error::Restricted("platform_redirect_denied"));
    }
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(bilibili::Error::TooLarge);
    }
    let set_cookie = capture_cookies(request.endpoint(), response.headers())?;
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| bilibili::Error::Transport)?
    {
        append_bounded(&mut body, &chunk, limit)?;
    }
    Ok(ApiResponse {
        status,
        body,
        set_cookie,
    })
}

/// A redacted streaming response. Its headers contain only safe media metadata,
/// and each read remains under the original absolute deadline. The reqwest
/// client's read timeout additionally bounds an idle body read to 30 seconds.
pub struct MediaResponse {
    response: reqwest::Response,
    headers: HeaderMap,
    deadline: Instant,
}

impl fmt::Debug for MediaResponse {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output
            .debug_struct("MediaResponse")
            .field("status", &self.response.status().as_u16())
            .finish_non_exhaustive()
    }
}

impl MediaResponse {
    pub fn status(&self) -> StatusCode {
        self.response.status()
    }

    pub fn headers(&self) -> &HeaderMap {
        &self.headers
    }

    pub async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>> {
        remaining(self.deadline)?;
        let chunk = tokio::time::timeout_at(self.deadline, self.response.chunk())
            .await
            .map_err(|_| bilibili::Error::Deadline)?
            .map_err(http_error)?;
        chunk
            .map(|chunk| {
                if chunk.len() > MAX_MEDIA_CHUNK_BYTES {
                    return Err(bilibili::Error::TooLarge);
                }
                Ok(chunk.to_vec())
            })
            .transpose()
    }
}

/// Pure provider-origin validation, without DNS or network access. This alone is
/// not authorization to connect: `media_request` additionally validates and pins
/// the whole DNS answer on every request.
pub fn validate_media_url(value: &str) -> Result<Url> {
    validate_media_url_for("bilibili", value)
}

/// Pure validation using the exact provider from a sealed playback binding.
/// Provider families are disjoint: a URL accepted for one platform cannot be
/// replayed with another platform's policy or Referer. DNS is checked separately
/// and pinned by `media_request_for` before making any outbound connection.
pub fn validate_media_url_for(provider: &str, value: &str) -> Result<Url> {
    validate_media_url_for_provider(Provider::parse(provider)?, value)
}

fn validate_media_url_for_provider(provider: Provider, value: &str) -> Result<Url> {
    let url = strict_https_url(value)?;
    let host = url.host_str().ok_or(bilibili::Error::InvalidResource)?;
    if !provider.permits_media_host(host) {
        return Err(bilibili::Error::Restricted("platform_origin_denied"));
    }
    Ok(url)
}

fn strict_https_url(value: &str) -> Result<Url> {
    if value.is_empty()
        || value.len() > MAX_URL_BYTES
        || !value.is_ascii()
        || value
            .bytes()
            .any(|byte| byte <= b' ' || byte == 0x7f || byte == b'\\')
        || value.contains('#')
    {
        return Err(bilibili::Error::InvalidResource);
    }
    let url = Url::parse(value).map_err(|_| bilibili::Error::InvalidResource)?;
    let authority = value
        .split_once("://")
        .and_then(|(_, rest)| rest.split(['/', '?', '#']).next())
        .ok_or(bilibili::Error::InvalidResource)?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || authority.contains('@')
        || authority.contains('%')
        || url.fragment().is_some()
        || url.host_str().is_none_or(|host| {
            host.is_empty()
                || host.len() > 253
                || !host.is_ascii()
                || host.parse::<IpAddr>().is_ok()
                || host.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || label.starts_with('-')
                        || label.ends_with('-')
                        || !label
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                })
        })
    {
        return Err(bilibili::Error::InvalidResource);
    }
    Ok(url)
}

fn domain_matches(host: &str, root: &str) -> bool {
    host == root
        || host
            .strip_suffix(root)
            .is_some_and(|prefix| !prefix.is_empty() && prefix.ends_with('.'))
}

fn validate_api_url(endpoint: Endpoint, url: &Url) -> Result<()> {
    strict_https_url(url.as_str())?;
    let (host, path) = match endpoint {
        Endpoint::View => ("api.bilibili.com", "/x/web-interface/view"),
        Endpoint::Nav => ("api.bilibili.com", "/x/web-interface/nav"),
        Endpoint::PlayUrl => ("api.bilibili.com", "/x/player/wbi/playurl"),
        Endpoint::QrGenerate => (
            "passport.bilibili.com",
            "/x/passport-login/web/qrcode/generate",
        ),
        Endpoint::QrPoll => ("passport.bilibili.com", "/x/passport-login/web/qrcode/poll"),
    };
    if url.host_str() != Some(host) || url.path() != path {
        return Err(bilibili::Error::Restricted("platform_origin_denied"));
    }
    Ok(())
}

fn api_headers(request: &ApiRequest) -> Result<HeaderMap> {
    request_headers(request.endpoint(), request.headers())
}

fn request_headers(endpoint: Endpoint, supplied: &BTreeMap<String, String>) -> Result<HeaderMap> {
    if supplied.len() > 4 {
        return Err(bilibili::Error::Restricted("platform_header_denied"));
    }
    let mut headers = HeaderMap::new();
    for (name, value) in supplied {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| bilibili::Error::Restricted("platform_header_denied"))?;
        if headers.contains_key(&name) {
            return Err(bilibili::Error::Restricted("platform_header_denied"));
        }
        match name.as_str() {
            "cookie" => {
                if !matches!(endpoint, Endpoint::View | Endpoint::Nav | Endpoint::PlayUrl)
                    || value.is_empty()
                    || value.len() > MAX_COOKIE_BYTES
                {
                    return Err(bilibili::Error::Restricted("platform_cookie_denied"));
                }
            }
            "referer" => {
                let referer = strict_https_url(value)?;
                let permitted = if matches!(endpoint, Endpoint::QrGenerate | Endpoint::QrPoll) {
                    referer.host_str() == Some("passport.bilibili.com")
                        && referer.path() == "/login"
                } else {
                    referer.host_str() == Some("www.bilibili.com")
                        && (referer.path() == "/" || referer.path().starts_with("/video/"))
                };
                if !permitted || referer.query().is_some() {
                    return Err(bilibili::Error::Restricted("platform_header_denied"));
                }
            }
            "user-agent" if value.len() <= 512 => {}
            "accept" if value == "application/json" => {}
            _ => return Err(bilibili::Error::Restricted("platform_header_denied")),
        }
        let mut value = HeaderValue::from_str(value)
            .map_err(|_| bilibili::Error::Restricted("platform_header_denied"))?;
        if name == header::COOKIE {
            value.set_sensitive(true);
        }
        headers.insert(name, value);
    }
    if !headers.contains_key(header::USER_AGENT) {
        headers.insert(header::USER_AGENT, HeaderValue::from_static(USER_AGENT));
    }
    if !headers.contains_key(header::REFERER) {
        let referer = if matches!(endpoint, Endpoint::QrGenerate | Endpoint::QrPoll) {
            "https://passport.bilibili.com/login"
        } else {
            REFERER
        };
        headers.insert(header::REFERER, HeaderValue::from_static(referer));
    }
    if !headers.contains_key(header::ACCEPT) {
        headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
    }
    Ok(headers)
}

fn check_response_headers(headers: &HeaderMap) -> Result<()> {
    if headers.len() > MAX_RESPONSE_HEADERS {
        return Err(bilibili::Error::TooLarge);
    }
    let total = headers.iter().try_fold(0usize, |total, (name, value)| {
        total
            .checked_add(name.as_str().len())
            .and_then(|total| total.checked_add(value.as_bytes().len()))
    });
    if total.is_none_or(|total| total > MAX_HEADER_BYTES) {
        return Err(bilibili::Error::TooLarge);
    }
    Ok(())
}

fn capture_cookies(endpoint: Endpoint, headers: &HeaderMap) -> Result<Vec<String>> {
    if !matches!(endpoint, Endpoint::QrGenerate | Endpoint::QrPoll) {
        return Ok(Vec::new());
    }
    let values = headers.get_all(header::SET_COOKIE);
    let mut cookies = Vec::new();
    for value in &values {
        if cookies.len() >= MAX_SET_COOKIES || value.as_bytes().len() > MAX_COOKIE_BYTES {
            return Err(bilibili::Error::TooLarge);
        }
        cookies.push(
            value
                .to_str()
                .map_err(|_| bilibili::Error::InvalidResponse("invalid_platform_cookie"))?
                .to_owned(),
        );
    }
    Ok(cookies)
}

fn append_bounded(body: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<()> {
    if body
        .len()
        .checked_add(chunk.len())
        .is_none_or(|size| size > limit)
    {
        return Err(bilibili::Error::TooLarge);
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn http_error(error: reqwest::Error) -> bilibili::Error {
    if error.is_timeout() {
        bilibili::Error::Deadline
    } else {
        bilibili::Error::Transport
    }
}

fn bounded_deadline(deadline: Instant, limit: Duration) -> Result<Instant> {
    let now = Instant::now();
    if deadline <= now {
        return Err(bilibili::Error::Deadline);
    }
    Ok(deadline.min(now + limit))
}

fn remaining(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(bilibili::Error::Deadline)
}

fn validate_range(value: &str) -> Result<HeaderValue> {
    if value.len() > 96 {
        return Err(bilibili::Error::Restricted("platform_range_denied"));
    }
    let range = value
        .strip_prefix("bytes=")
        .and_then(|value| value.split_once('-'))
        .ok_or(bilibili::Error::Restricted("platform_range_denied"))?;
    let number = |value: &str| {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            None
        } else {
            value.parse::<u64>().ok()
        }
    };
    let valid = match (number(range.0), number(range.1)) {
        (Some(start), Some(end)) => start <= end,
        (Some(_), None) => range.1.is_empty(),
        (None, Some(suffix)) => range.0.is_empty() && suffix > 0,
        (None, None) => false,
    };
    if !valid {
        return Err(bilibili::Error::Restricted("platform_range_denied"));
    }
    HeaderValue::from_str(value).map_err(|_| bilibili::Error::Restricted("platform_range_denied"))
}

// The injection point is private. Production always uses SystemResolver; the
// injected resolver still cannot bypass provider-origin or address validation.
async fn pinned_client(
    url: &Url,
    resolver: &impl Resolver,
    deadline: Instant,
) -> Result<AuthorizedClient> {
    // Check the scheme/port/authority again before any DNS work.
    strict_https_url(url.as_str())?;
    let host = url.host_str().ok_or(bilibili::Error::InvalidResource)?;
    remaining(deadline)?;
    let dns_deadline = deadline.min(Instant::now() + DNS_TIMEOUT);
    let addresses = tokio::time::timeout_at(dns_deadline, resolver.resolve(host, 443))
        .await
        .map_err(|_| bilibili::Error::Deadline)?
        .map_err(|_| bilibili::Error::Transport)?;
    let addresses = validate_addresses(&addresses)?;
    let cidrs = addresses
        .iter()
        .map(|address| match address.ip() {
            IpAddr::V4(address) => format!("{address}/32"),
            IpAddr::V6(address) => format!("{address}/128"),
        })
        .collect();
    let policy = SourceAccessPolicy {
        schema_version: 1,
        public_only: true,
        origins: vec![OriginRule {
            origin: url.origin().ascii_serialization(),
            cidrs,
        }],
        redirects: None,
    };
    let access =
        SourceAccess::new(url.as_str(), Some(&policy)).map_err(|_| bilibili::Error::Transport)?;
    // This resolver returns the already-checked answer, never performing a
    // second lookup. SourceAccess disables env proxies and automatic redirects,
    // preserves certificate verification, and pins every fallback address.
    access
        .client_for_with_resolver(url.as_str(), &PinnedAddresses(addresses))
        .await
        .map_err(|_| bilibili::Error::Transport)
}

struct PinnedAddresses(Vec<SocketAddr>);
impl Resolver for PinnedAddresses {
    fn resolve<'a>(&'a self, _host: &'a str, _port: u16) -> Resolution<'a> {
        Box::pin(async move { Ok(self.0.clone()) })
    }
}

fn validate_addresses(addresses: &[SocketAddr]) -> Result<Vec<SocketAddr>> {
    if addresses.is_empty() || addresses.len() > MAX_DNS_ADDRESSES {
        return Err(bilibili::Error::Restricted("platform_dns_answer_denied"));
    }
    let mut unique = HashSet::new();
    let mut validated = Vec::with_capacity(addresses.len());
    for address in addresses {
        if address.port() != 443
            || matches!(address, SocketAddr::V6(value) if value.scope_id() != 0 || value.flowinfo() != 0)
            || !public_address(address.ip())
        {
            // Reject the whole answer, including mixed public/private results.
            // Never filter and retry a safe-looking subset.
            return Err(bilibili::Error::Restricted("platform_address_denied"));
        }
        if unique.insert(*address) {
            validated.push(*address);
        }
    }
    Ok(validated)
}

pub(crate) fn public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => public_ipv4(address),
        IpAddr::V6(address) => public_ipv6(address),
    }
}

fn public_ipv4(address: Ipv4Addr) -> bool {
    let value = u32::from(address);
    // Conservative exclusions based on the IANA special-purpose registry:
    // https://www.iana.org/assignments/iana-ipv4-special-registry
    // Also deny the Azure fabric/metadata address, although globally numbered.
    const DENIED: &[(u32, u8)] = &[
        (0x0000_0000, 8),
        (0x0a00_0000, 8),
        (0x6440_0000, 10),
        (0x7f00_0000, 8),
        (0xa9fe_0000, 16),
        (0xac10_0000, 12),
        (0xc000_0000, 24),
        (0xc000_0200, 24),
        (0xc058_6300, 24),
        (0xc0a8_0000, 16),
        (0xc612_0000, 15),
        (0xc633_6400, 24),
        (0xcb00_7100, 24),
        (0xe000_0000, 3),
        (0xa83f_8110, 32),
    ];
    !DENIED.iter().any(|(network, prefix)| {
        let mask = u32::MAX << (32 - u32::from(*prefix));
        value & mask == *network
    })
}

fn public_ipv6(address: Ipv6Addr) -> bool {
    let value = u128::from(address);
    // Only global-unicast 2000::/3, excluding special-purpose/transition and
    // documentation blocks. This refuses mapped IPv4, NAT64, loopback, ULA,
    // link/site-local, multicast, unspecified and scoped addresses outright.
    // https://www.iana.org/assignments/iana-ipv6-special-registry
    if value >> 125 != 1 {
        return false;
    }
    const DENIED: &[(u128, u8)] = &[
        (0x2001_0000_0000_0000_0000_0000_0000_0000, 23),
        (0x2001_0db8_0000_0000_0000_0000_0000_0000, 32),
        (0x2002_0000_0000_0000_0000_0000_0000_0000, 16),
        (0x3fff_0000_0000_0000_0000_0000_0000_0000, 20),
    ];
    !DENIED.iter().any(|(network, prefix)| {
        let mask = u128::MAX << (128 - u32::from(*prefix));
        value & mask == *network
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn address(value: &str) -> SocketAddr {
        SocketAddr::new(value.parse().unwrap(), 443)
    }

    #[test]
    fn media_encoding_is_identity_and_single_before_any_body_read() {
        let mut headers = HeaderMap::new();
        assert!(validate_media_encoding(&headers).is_ok());
        headers.insert(
            header::CONTENT_ENCODING,
            HeaderValue::from_static("identity"),
        );
        assert!(validate_media_encoding(&headers).is_ok());
        headers.append(
            header::CONTENT_ENCODING,
            HeaderValue::from_static("identity"),
        );
        assert!(validate_media_encoding(&headers).is_err());
        for value in ["gzip", "br", "deflate", "identity, gzip", "Identity", ""] {
            headers.insert(
                header::CONTENT_ENCODING,
                HeaderValue::from_str(value).unwrap(),
            );
            assert!(validate_media_encoding(&headers).is_err());
        }
    }

    #[test]
    fn media_origins_are_closed_https_only_and_suffix_boundary_safe() {
        for url in [
            "https://upos-sz-mirrorali.bilivideo.com/track.m4s?signature=secret",
            "https://cn-something.mcdn.bilivideo.cn/track.m4s",
            "https://cdn.bilivideo.net/track.m4s",
            "https://cdn.hdslb.com/track.m4s",
            "https://upos-hz-mirrorakam.akamaized.net/track.m4s",
            "https://bilivideo.com:443/track",
        ] {
            assert!(validate_media_url(url).is_ok());
        }
        for url in [
            "http://upos-sz-mirrorali.bilivideo.com/track",
            "https://bilivideo.com:444/track",
            "https://bilivideo.com.evil.example/track",
            "https://evilbilivideo.com/track",
            "https://bilivideo.cn.evil.example/track",
            "https://evilhdslb.com/track",
            "https://hdslb.com.evil.example/track",
            "https://evilbilivideo.net/track",
            "https://unrelated.akamaized.net/track",
            "https://api.bilibili.com/track",
            "https://localhost/track",
            "https://127.0.0.1/track",
            "https://[::ffff:127.0.0.1]/track",
            "https://bilivideo.com./track",
            "https://.bilivideo.com/track",
            "https://cdn..bilivideo.com/track",
            "https://-cdn.bilivideo.com/track",
            "https://cdn-.bilivideo.com/track",
            "https://cdn_unsafe.bilivideo.com/track",
            "https://user@bilivideo.com/track",
            "https://@bilivideo.com/track",
            "https://user:password@bilivideo.com/track",
            "https://%62ilivideo.com/track",
            "https://bilivideo.com/track#fragment",
            "https://bilivideo.com/track#",
            " https://bilivideo.com/track",
            "https://bilivideo.com/track\n",
            "https://bilivideo.com\\@evil.example/track",
            "https://bilivideo.com/\u{7f}",
        ] {
            assert!(validate_media_url(url).is_err(), "unexpected allowed URL");
        }
    }

    #[test]
    fn named_media_policies_are_disjoint_and_suffix_boundary_safe() {
        let accepted = [
            (
                "bilibili",
                "https://upos-sz-mirrorali.bilivideo.com/track.m4s?signature=private",
            ),
            (
                "douyin",
                "https://v9-v2-mps-cdn.douyinvod.com/video.mp4?signature=private",
            ),
            ("douyin", "https://v5-dy-ov-experiment.zjcdn.com/video.mp4"),
            (
                "tiktok",
                "https://v58.tiktokcdn.com/video.mp4?signature=private",
            ),
            ("tiktok", "https://v1.tiktokcdn-us.com/video.mp4"),
            ("tiktok", "https://v15m.tiktokcdn-eu.com/video.mp4"),
            ("tiktok", "https://v1.tiktokv.com/video.mp4"),
            ("tiktok", "https://v1.tiktokv.us/video.mp4"),
            ("tiktok", "https://v16-webapp-prime.us.tiktok.com/video.mp4"),
            ("tiktok", "https://v16-webapp-prime.tiktok.com/video.mp4"),
            ("tiktok", "https://v19-webapp-prime.tiktok.com/video.mp4"),
            (
                "youtube",
                "https://rr1---sn-example.googlevideo.com/videoplayback?signature=private",
            ),
        ];
        for (provider, url) in accepted {
            assert!(validate_media_url_for(provider, url).is_ok());
            for wrong in ["bilibili", "douyin", "tiktok", "youtube"] {
                if wrong != provider {
                    assert!(validate_media_url_for(wrong, url).is_err());
                }
            }
        }
        for provider in ["", "bili", "YouTube", "googlevideo", "other"] {
            assert!(validate_media_url_for(provider, accepted[0].1).is_err());
        }
        for (provider, url) in [
            ("douyin", "https://evildouyinvod.com/video"),
            ("douyin", "https://douyinvod.com.evil.example/video"),
            ("douyin", "https://unrelated.zjcdn.com/video"),
            ("douyin", "https://zjcdn.com/video"),
            ("douyin", "https://douyincdn.com/video"),
            ("douyin", "https://www.douyin.com/video/123"),
            ("tiktok", "https://eviltiktokcdn.com/video"),
            ("tiktok", "https://tiktokcdn.com.evil.example/video"),
            ("tiktok", "https://tiktokv.us.evil.example/video"),
            ("tiktok", "https://www.tiktok.com/video"),
            ("tiktok", "https://v99-webapp-prime.tiktok.com/video"),
            ("tiktok", "https://evil.v16-webapp-prime.tiktok.com/video"),
            (
                "tiktok",
                "https://v16-webapp-prime.us.tiktok.com.evil.example/video",
            ),
            ("tiktok", "https://byteoversea.com/video"),
            ("youtube", "https://evilgooglevideo.com/videoplayback"),
            (
                "youtube",
                "https://googlevideo.com.evil.example/videoplayback",
            ),
            ("youtube", "https://www.youtube.com/watch?v=123"),
        ] {
            assert!(validate_media_url_for(provider, url).is_err());
        }
    }

    #[test]
    fn every_named_policy_refuses_unsafe_authorities_and_anonymous_headers_are_fixed() {
        for (provider, host) in [
            ("douyin", "v9-v2-mps-cdn.douyinvod.com"),
            ("tiktok", "v58.tiktokcdn.com"),
            ("youtube", "rr1.googlevideo.com"),
        ] {
            for url in [
                format!("http://{host}/video"),
                format!("https://{host}:444/video"),
                format!("https://user:private@{host}/video"),
                format!("https://@{host}/video"),
                format!("https://{host}./video"),
                format!("https://.{host}/video"),
                format!("https://cdn..{host}/video"),
                format!("https://{host}/video#private"),
                format!("https://{host}/video\\@evil.example"),
                "https://127.0.0.1/video?signature=private".to_owned(),
                "https://[::ffff:8.8.8.8]/video?signature=private".to_owned(),
                "https://169.254.169.254/video?signature=private".to_owned(),
            ] {
                let error = validate_media_url_for(provider, &url).unwrap_err();
                let text = format!("{error:?} {error}");
                assert!(!text.contains("private"));
                assert!(!text.contains(host));
                assert!(!text.contains("https://"));
            }
            let provider = Provider::parse(provider).unwrap();
            let headers = media_headers(provider);
            assert_eq!(headers.len(), 3);
            assert_eq!(headers[header::USER_AGENT], USER_AGENT);
            assert_eq!(headers[header::REFERER], provider.referer());
            assert_eq!(headers[header::ACCEPT_ENCODING], "identity");
            assert!(!headers.contains_key(header::COOKIE));
            assert!(!headers.contains_key(header::AUTHORIZATION));
            assert!(!headers.contains_key(header::PROXY_AUTHORIZATION));
        }
    }

    #[test]
    fn anonymous_page_origins_paths_and_headers_are_fixed() {
        use short_video::Endpoint::{DouyinWebpage, TikTokWebpage};
        for (endpoint, url, provider) in [
            (
                DouyinWebpage,
                "https://www.iesdouyin.com/share/video/1234567890",
                Provider::Douyin,
            ),
            (
                TikTokWebpage,
                "https://www.tiktok.com/@_/video/1234567890",
                Provider::TikTok,
            ),
            (
                TikTokWebpage,
                "https://www.tiktok.com/@creator.name_1/video/1234567890",
                Provider::TikTok,
            ),
        ] {
            assert_eq!(
                validate_page_url(endpoint, &Url::parse(url).unwrap()).unwrap(),
                provider
            );
            let expected = BTreeMap::from([
                (
                    "User-Agent".into(),
                    if provider == Provider::Douyin {
                        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1 RainSync/0.1".into()
                    } else {
                        USER_AGENT.into()
                    },
                ),
                ("Referer".into(), provider.referer().into()),
                ("Accept".into(), "text/html".into()),
            ]);
            let headers = page_headers(endpoint, provider, &expected, None).unwrap();
            assert_eq!(headers.len(), 4);
            assert_eq!(headers[header::USER_AGENT], expected["User-Agent"].as_str());
            assert!(!headers.contains_key(header::COOKIE));
            assert!(!headers.contains_key(header::AUTHORIZATION));
            assert!(page_headers(endpoint, provider, &BTreeMap::new(), None).is_ok());
            for supplied in [
                BTreeMap::from([("Cookie".into(), "session=private".into())]),
                BTreeMap::from([("Authorization".into(), "private".into())]),
                BTreeMap::from([("Host".into(), "evil.example".into())]),
                BTreeMap::from([("User-Agent".into(), "custom-user-agent".into())]),
                BTreeMap::from([("Referer".into(), "https://evil.example/".into())]),
                BTreeMap::from([("Accept".into(), "application/json".into())]),
                BTreeMap::from([
                    ("Referer".into(), provider.referer().into()),
                    ("referer".into(), provider.referer().into()),
                ]),
            ] {
                let error = page_headers(endpoint, provider, &supplied, None).unwrap_err();
                assert_eq!(error, bilibili::Error::Restricted("platform_header_denied"));
                assert!(!format!("{error:?}").contains("private"));
            }
        }
        for (endpoint, url) in [
            (
                DouyinWebpage,
                "https://www.iesdouyin.com/share/video/123?private=token",
            ),
            (DouyinWebpage, "https://www.iesdouyin.com/share/video/123/"),
            (
                DouyinWebpage,
                "https://www.iesdouyin.com/share/video/%31%32%33",
            ),
            (DouyinWebpage, "https://www.iesdouyin.com/share/video/0"),
            (
                DouyinWebpage,
                "https://www.iesdouyin.com/share/video/18446744073709551616",
            ),
            (
                DouyinWebpage,
                "https://www.iesdouyin.com.evil.example/share/video/123",
            ),
            (
                DouyinWebpage,
                "https://www.iesdouyin.com:444/share/video/123",
            ),
            (DouyinWebpage, "https://www.douyin.com/video/123"),
            (
                DouyinWebpage,
                "https://www.douyin.com/video/123?private=token",
            ),
            (DouyinWebpage, "https://www.douyin.com/video/123/"),
            (DouyinWebpage, "https://www.douyin.com/video/%31%32%33"),
            (
                DouyinWebpage,
                "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123",
            ),
            (DouyinWebpage, "https://live.douyin.com/123"),
            (DouyinWebpage, "https://v.douyin.com/123"),
            (
                DouyinWebpage,
                "https://ttwid.bytedance.com/ttwid/union/register/",
            ),
            (DouyinWebpage, "https://www.tiktok.com/@_/video/123"),
            (
                TikTokWebpage,
                "https://www.tiktok.com/@_/video/123?private=token",
            ),
            (TikTokWebpage, "https://www.tiktok.com/@_/video/123/"),
            (
                TikTokWebpage,
                "https://www.tiktok.com/@_%2Fsecret/video/123",
            ),
            (TikTokWebpage, "https://www.tiktok.com/@/video/123"),
            (TikTokWebpage, "https://www.tiktok.com/@_/video/not-numeric"),
            (TikTokWebpage, "https://www.tiktok.com/@_/live"),
            (TikTokWebpage, "https://vm.tiktok.com/short"),
            (TikTokWebpage, "https://www.tiktok.com/api/item/detail/"),
            (
                TikTokWebpage,
                "https://www.tiktok.com.evil.example/@_/video/123",
            ),
            (TikTokWebpage, "https://www.tiktok.com:444/@_/video/123"),
            (
                TikTokWebpage,
                "https://user:private@www.tiktok.com/@_/video/123",
            ),
        ] {
            assert!(validate_page_url(endpoint, &Url::parse(url).unwrap()).is_err());
        }
    }

    #[test]
    fn authenticated_short_metadata_origins_and_queries_are_closed() {
        use short_video::Endpoint::{DouyinAuthenticatedDetail, TikTokAuthenticatedWebpage};
        for (endpoint, url, provider) in [
            (
                DouyinAuthenticatedDetail,
                "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1234567890",
                Provider::Douyin,
            ),
            (
                TikTokAuthenticatedWebpage,
                "https://www.tiktok.com/@creator.name/video/1234567890",
                Provider::TikTok,
            ),
        ] {
            assert_eq!(
                validate_page_url(endpoint, &Url::parse(url).unwrap()).unwrap(),
                provider
            );
        }
        for url in [
            "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123&aweme_id=456",
            "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123&signature=private",
            "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=%31%32%33",
            "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=0",
            "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=18446744073709551616",
            "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=https://www.douyin.com/video/123",
            "https://www.douyin.com/aweme/v1/web/aweme/detail/",
            "https://www.douyin.com/aweme/v1/web/aweme/detail?aweme_id=123",
            "https://www.douyin.com/aweme/v1/web/aweme/detail/?AWEME_ID=123",
            "https://www.douyin.com.evil.example/aweme/v1/web/aweme/detail/?aweme_id=123",
            "https://www.douyin.com:444/aweme/v1/web/aweme/detail/?aweme_id=123",
            "https://user:private@www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123",
            "https://www.iesdouyin.com/aweme/v1/web/aweme/detail/?aweme_id=123",
            "https://aweme.snssdk.com/aweme/v1/web/aweme/detail/?aweme_id=123",
            "https://www.douyin.com/video/123",
            "https://www.tiktok.com/api/item/detail/?itemId=123",
            "https://v26-web.douyinvod.com/video/fixture.mp4",
            "https://127.0.0.1/aweme/v1/web/aweme/detail/?aweme_id=123",
        ] {
            let error = validate_page_url(DouyinAuthenticatedDetail, &Url::parse(url).unwrap())
                .unwrap_err();
            assert!(!format!("{error:?} {error}").contains("private"));
        }
        for url in [
            "https://www.tiktok.com/@creator/video/123?secret=private",
            "https://www.tiktok.com/@creator/video/123/",
            "https://www.tiktok.com/api/item/detail/?itemId=123",
            "https://www.tiktok.com/login",
            "https://www.tiktok.com.evil.example/@creator/video/123",
            "https://www.tiktok.com:444/@creator/video/123",
            "https://user:private@www.tiktok.com/@creator/video/123",
            "https://v58.tiktokcdn.com/video/fixture.mp4",
            "https://www.douyin.com/video/123",
        ] {
            assert!(
                validate_page_url(TikTokAuthenticatedWebpage, &Url::parse(url).unwrap()).is_err()
            );
        }
    }

    #[test]
    fn typed_credentials_only_reach_matching_authenticated_metadata_headers() {
        use short_video::Endpoint::*;
        const SECRET: &str = "synthetic-private-login-session";
        let douyin = short_video::Credential::parse(
            short_video::Platform::Douyin,
            &format!("sessionid={SECRET}"),
        )
        .unwrap();
        let tiktok = short_video::Credential::parse(
            short_video::Platform::TikTok,
            &format!("sessionid={SECRET}"),
        )
        .unwrap();
        for (endpoint, provider, credential, wrong, accept, user_agent) in [
            (
                DouyinAuthenticatedDetail,
                Provider::Douyin,
                &douyin,
                &tiktok,
                "application/json",
                USER_AGENT,
            ),
            (
                TikTokAuthenticatedWebpage,
                Provider::TikTok,
                &tiktok,
                &douyin,
                "text/html",
                USER_AGENT,
            ),
        ] {
            let headers =
                page_headers(endpoint, provider, &BTreeMap::new(), Some(credential)).unwrap();
            assert_eq!(headers[header::COOKIE], format!("sessionid={SECRET}"));
            assert!(headers[header::COOKIE].is_sensitive());
            assert!(!format!("{headers:?}").contains(SECRET));
            assert_eq!(headers[header::ACCEPT], accept);
            assert_eq!(headers[header::USER_AGENT], user_agent);
            assert_eq!(headers[header::REFERER], provider.referer());
            assert!(!headers.contains_key(header::AUTHORIZATION));
            assert!(page_headers(endpoint, provider, &BTreeMap::new(), None).is_err());
            assert!(page_headers(endpoint, provider, &BTreeMap::new(), Some(wrong)).is_err());
            for supplied in [
                BTreeMap::from([("Cookie".into(), format!("sessionid={SECRET}"))]),
                BTreeMap::from([("Authorization".into(), SECRET.into())]),
                BTreeMap::from([("Host".into(), "evil.example".into())]),
                BTreeMap::from([("Referer".into(), "https://evil.example/".into())]),
                BTreeMap::from([("Accept-Encoding".into(), "gzip".into())]),
            ] {
                let error =
                    page_headers(endpoint, provider, &supplied, Some(credential)).unwrap_err();
                assert!(!format!("{error:?} {error}").contains(SECRET));
            }
        }
        for (endpoint, provider) in [
            (DouyinWebpage, Provider::Douyin),
            (DouyinPlayRedirect, Provider::Douyin),
            (TikTokWebpage, Provider::TikTok),
        ] {
            for credential in [&douyin, &tiktok] {
                assert!(
                    page_headers(endpoint, provider, &BTreeMap::new(), Some(credential)).is_err()
                );
            }
            let headers = page_headers(endpoint, provider, &BTreeMap::new(), None).unwrap();
            assert!(!headers.contains_key(header::COOKIE));
        }
        for provider in [Provider::Bilibili, Provider::YouTube] {
            assert!(
                page_headers(
                    DouyinAuthenticatedDetail,
                    provider,
                    &BTreeMap::new(),
                    Some(&douyin)
                )
                .is_err()
            );
        }
        assert!(!media_headers(Provider::Douyin).contains_key(header::COOKIE));
        assert!(!media_headers(Provider::TikTok).contains_key(header::COOKIE));
    }

    #[test]
    fn typed_douyin_discovery_only_returns_one_bounded_provider_bound_location() {
        let target = "https://v9-v2-mps-cdn.douyinvod.com/video.mp4?signature=private";
        let headers = HeaderMap::from_iter([
            (header::LOCATION, HeaderValue::from_static(target)),
            (
                header::SET_COOKIE,
                HeaderValue::from_static("session=private"),
            ),
        ]);
        for status in [
            StatusCode::MOVED_PERMANENTLY,
            StatusCode::FOUND,
            StatusCode::SEE_OTHER,
            StatusCode::TEMPORARY_REDIRECT,
            StatusCode::PERMANENT_REDIRECT,
        ] {
            assert_eq!(
                capture_play_location(status, &headers).unwrap().as_deref(),
                Some(target)
            );
            assert!(capture_play_location(status, &HeaderMap::new()).is_err());
        }
        for status in [
            StatusCode::OK,
            StatusCode::FORBIDDEN,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::NOT_MODIFIED,
        ] {
            assert!(capture_play_location(status, &headers).unwrap().is_none());
        }
        let mut duplicate = headers.clone();
        duplicate.append(header::LOCATION, HeaderValue::from_static(target));
        assert_eq!(
            capture_play_location(StatusCode::FOUND, &duplicate).unwrap_err(),
            bilibili::Error::InvalidResponse("duplicate_platform_redirect")
        );
        for target in [
            "/video.mp4",
            "http://v9-v2-mps-cdn.douyinvod.com/video.mp4",
            "https://user:private@v9-v2-mps-cdn.douyinvod.com/video.mp4",
            "https://v9-v2-mps-cdn.douyinvod.com:444/video.mp4",
            "https://v9-v2-mps-cdn.douyinvod.com/video.mp4#private",
            "https://v58.tiktokcdn.com/video.mp4?signature=private",
            "https://rr1.googlevideo.com/video.mp4?signature=private",
            "https://aweme.snssdk.com/aweme/v1/play/?video_id=private",
            "https://127.0.0.1/video.mp4?signature=private",
            "https://douyinvod.com.evil.example/video.mp4?signature=private",
        ] {
            let headers =
                HeaderMap::from_iter([(header::LOCATION, HeaderValue::from_str(target).unwrap())]);
            let error = capture_play_location(StatusCode::FOUND, &headers).unwrap_err();
            assert!(!format!("{error:?} {error}").contains("private"));
        }
        let oversized = format!(
            "https://v9-v2-mps-cdn.douyinvod.com/{}",
            "x".repeat(MAX_PLAY_LOCATION_BYTES)
        );
        let headers =
            HeaderMap::from_iter([(header::LOCATION, HeaderValue::from_str(&oversized).unwrap())]);
        assert_eq!(
            capture_play_location(StatusCode::FOUND, &headers).unwrap_err(),
            bilibili::Error::TooLarge
        );
        let headers = HeaderMap::from_iter([(
            header::LOCATION,
            HeaderValue::from_bytes(b"https://v9-v2-mps-cdn.douyinvod.com/\xff").unwrap(),
        )]);
        assert_eq!(
            capture_play_location(StatusCode::FOUND, &headers).unwrap_err(),
            bilibili::Error::InvalidResponse("invalid_platform_redirect")
        );
    }

    #[test]
    fn typed_play_descriptor_cannot_select_pages_apis_or_other_providers() {
        use short_video::Endpoint::{DouyinPlayRedirect, DouyinWebpage, TikTokWebpage};
        for target in [
            "https://aweme.snssdk.com/aweme/v1/play/?video_id=v0d00f7b0000fixture&ratio=720p&line=0",
            "https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0d00f7b0000fixture&ratio=720p&line=0",
        ] {
            let url = Url::parse(target).unwrap();
            assert_eq!(
                validate_page_url(DouyinPlayRedirect, &url).unwrap(),
                Provider::Douyin
            );
            assert!(validate_page_url(DouyinWebpage, &url).is_err());
            assert!(validate_page_url(TikTokWebpage, &url).is_err());
        }
        for target in [
            "https://www.iesdouyin.com/share/video/1234567890",
            "https://www.douyin.com/aweme/v1/play/?video_id=v0d00f7b0000fixture&ratio=720p&line=0",
            "https://aweme.snssdk.com/aweme/v1/aweme/detail/?video_id=v0d00f7b0000fixture&ratio=720p&line=0",
            "https://aweme.snssdk.com.evil.example/aweme/v1/play/?video_id=v0d00f7b0000fixture&ratio=720p&line=0",
            "https://aweme.snssdk.com:444/aweme/v1/play/?video_id=v0d00f7b0000fixture&ratio=720p&line=0",
            "https://user:private@aweme.snssdk.com/aweme/v1/play/?video_id=v0d00f7b0000fixture&ratio=720p&line=0",
            "https://aweme.snssdk.com/aweme/v1/play/?video_id=v0d00f7b0000fixture&ratio=720p&line=0&token=private",
            "https://aweme.snssdk.com/aweme/v1/play/?video_id=v0d00f7b0000fixture&ratio=720p&line=0&line=1",
            "https://v58.tiktokcdn.com/video.mp4",
            "https://rr1.googlevideo.com/video.mp4",
        ] {
            let error =
                validate_page_url(DouyinPlayRedirect, &Url::parse(target).unwrap()).unwrap_err();
            assert!(!format!("{error:?} {error}").contains("private"));
        }
    }

    #[test]
    fn endpoint_origin_and_path_cannot_be_overridden() {
        assert!(
            validate_api_url(
                Endpoint::View,
                &Url::parse("https://api.bilibili.com/x/web-interface/view?bvid=BV123").unwrap()
            )
            .is_ok()
        );
        for url in [
            "https://api.bilibili.com/x/player/playurl",
            "https://passport.bilibili.com/x/web-interface/view",
            "https://api.bilibili.com.evil.example/x/web-interface/view",
            "https://api.bilibili.com:444/x/web-interface/view",
            "http://api.bilibili.com/x/web-interface/view",
        ] {
            assert!(validate_api_url(Endpoint::View, &Url::parse(url).unwrap()).is_err());
        }
    }

    #[test]
    fn public_dns_policy_refuses_every_special_and_metadata_address() {
        for ip in [
            "0.0.0.0",
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "100.100.100.200",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.9",
            "192.0.2.1",
            "192.88.99.1",
            "192.168.0.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "168.63.129.16",
            "::",
            "::1",
            "::ffff:8.8.8.8",
            "::ffff:127.0.0.1",
            "64:ff9b::a00:1",
            "64:ff9b:1::1",
            "100::1",
            "2001::1",
            "2001:2::1",
            "2001:db8::1",
            "2002:0808:0808::1",
            "3fff::1",
            "fc00::1",
            "fd00::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "5f00::1",
        ] {
            assert!(
                validate_addresses(&[address(ip)]).is_err(),
                "unexpected public address"
            );
        }
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "172.15.255.255",
            "172.32.0.1",
            "2606:4700:4700::1111",
        ] {
            assert!(validate_addresses(&[address(ip)]).is_ok());
        }
        assert!(validate_addresses(&[address("8.8.8.8"), address("127.0.0.1")]).is_err());
        assert!(validate_addresses(&[]).is_err());
        assert!(validate_addresses(&vec![address("8.8.8.8"); 65]).is_err());
        assert!(validate_addresses(&[SocketAddr::new("8.8.8.8".parse().unwrap(), 80)]).is_err());
        assert_eq!(
            validate_addresses(&[address("8.8.8.8"), address("8.8.8.8")])
                .unwrap()
                .len(),
            1
        );
        assert!(
            validate_addresses(&[SocketAddr::V6(std::net::SocketAddrV6::new(
                "2606:4700:4700::1111".parse().unwrap(),
                443,
                0,
                1
            ))])
            .is_err()
        );
    }

    struct FakeResolver {
        calls: AtomicUsize,
        addresses: Vec<SocketAddr>,
    }

    struct NamedResolver {
        calls: AtomicUsize,
        host: &'static str,
        addresses: Vec<SocketAddr>,
    }

    impl Resolver for NamedResolver {
        fn resolve<'a>(&'a self, host: &'a str, port: u16) -> Resolution<'a> {
            Box::pin(async move {
                assert_eq!(host, self.host);
                assert_eq!(port, 443);
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(self.addresses.clone())
            })
        }
    }

    #[tokio::test]
    async fn named_provider_dns_uses_one_complete_checked_answer_without_connecting() {
        for (provider, host) in [
            ("douyin", "v9-v2-mps-cdn.douyinvod.com"),
            ("tiktok", "v58.tiktokcdn.com"),
            ("youtube", "rr1.googlevideo.com"),
        ] {
            let url = validate_media_url_for(provider, &format!("https://{host}/video")).unwrap();
            let resolver = NamedResolver {
                calls: AtomicUsize::new(0),
                host,
                addresses: vec![address("8.8.8.8"), address("2606:4700:4700::1111")],
            };
            let client = pinned_client(&url, &resolver, Instant::now() + Duration::from_secs(5))
                .await
                .unwrap();
            assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
            assert_eq!(client.addresses(), resolver.addresses);
            for denied in ["127.0.0.1", "169.254.169.254", "::ffff:8.8.8.8"] {
                let resolver = NamedResolver {
                    calls: AtomicUsize::new(0),
                    host,
                    addresses: vec![address("8.8.8.8"), address(denied)],
                };
                assert!(
                    pinned_client(&url, &resolver, Instant::now() + Duration::from_secs(5))
                        .await
                        .is_err()
                );
                assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
            }
        }
    }

    #[tokio::test]
    async fn invalid_method_provider_origin_range_and_deadline_fail_before_network() {
        let http = PlatformHttp::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        for (provider, url, method, range, expected) in [
            (
                "youtube",
                "https://rr1.googlevideo.com/video",
                Method::POST,
                None,
                bilibili::Error::Restricted("platform_method_denied"),
            ),
            (
                "arbitrary",
                "https://rr1.googlevideo.com/video",
                Method::GET,
                None,
                bilibili::Error::Restricted("platform_provider_denied"),
            ),
            (
                "douyin",
                "https://rr1.googlevideo.com/video",
                Method::GET,
                None,
                bilibili::Error::Restricted("platform_origin_denied"),
            ),
            (
                "youtube",
                "https://rr1.googlevideo.com/video",
                Method::GET,
                Some("bytes=0-1\r\nCookie: private"),
                bilibili::Error::Restricted("platform_range_denied"),
            ),
        ] {
            let error = http
                .media_request_for(provider, url, method, range, deadline)
                .await
                .unwrap_err();
            assert_eq!(error, expected);
            assert!(!format!("{error:?} {error}").contains("private"));
        }
        let error = http
            .media_request_for(
                "youtube",
                "https://rr1.googlevideo.com/video",
                Method::GET,
                None,
                Instant::now(),
            )
            .await
            .unwrap_err();
        assert_eq!(error, bilibili::Error::Deadline);
    }
    impl Resolver for FakeResolver {
        fn resolve<'a>(&'a self, host: &'a str, port: u16) -> Resolution<'a> {
            Box::pin(async move {
                assert_eq!(host, "api.bilibili.com");
                assert_eq!(port, 443);
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(self.addresses.clone())
            })
        }
    }

    #[tokio::test]
    async fn one_dns_answer_is_public_checked_and_pinned_without_second_lookup() {
        let url = Url::parse("https://api.bilibili.com/x/web-interface/nav").unwrap();
        let resolver = FakeResolver {
            calls: AtomicUsize::new(0),
            addresses: vec![address("8.8.8.8"), address("1.1.1.1")],
        };
        let client = pinned_client(&url, &resolver, Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
        assert_eq!(client.addresses(), resolver.addresses);
        assert_eq!(
            client.enforcement(),
            crate::access_policy::Enforcement::StrictCidrsV1
        );
        let resolver = FakeResolver {
            calls: AtomicUsize::new(0),
            addresses: vec![address("8.8.8.8"), address("169.254.169.254")],
        };
        assert!(
            pinned_client(&url, &resolver, Instant::now() + Duration::from_secs(5))
                .await
                .is_err()
        );
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn expired_deadline_fails_before_dns() {
        let resolver = FakeResolver {
            calls: AtomicUsize::new(0),
            addresses: vec![address("8.8.8.8")],
        };
        let url = Url::parse("https://api.bilibili.com/x/web-interface/nav").unwrap();
        assert!(matches!(
            pinned_client(&url, &resolver, Instant::now()).await,
            Err(bilibili::Error::Deadline)
        ));
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn range_syntax_is_single_and_bounded() {
        for range in ["bytes=0-0", "bytes=1-10", "bytes=100-", "bytes=-1"] {
            assert!(validate_range(range).is_ok());
        }
        for range in [
            "bytes=-",
            "bytes=-0",
            "bytes=10-1",
            "bytes=0-1,4-5",
            "bytes= 0-1",
            "bytes=+1-2",
            "bytes=0-1\r\nHost: evil",
            "bytes=18446744073709551616-",
        ] {
            assert!(validate_range(range).is_err());
        }
    }

    #[test]
    fn real_qr_descriptors_match_fixed_transport_contract_without_dns() {
        let key = bilibili::QrKey::from_secret("0123456789abcdef0123456789abcdef").unwrap();
        for request in [
            bilibili::qr_generate_request(),
            bilibili::qr_poll_request(&key),
        ] {
            validate_api_url(request.endpoint(), &request.url()).unwrap();
            let headers = api_headers(&request).unwrap();
            assert!(!headers.contains_key(header::COOKIE));
            assert_eq!(
                headers[header::REFERER],
                "https://passport.bilibili.com/login"
            );
            assert_eq!(headers[header::ACCEPT], "application/json");
        }
    }

    #[test]
    fn only_fixed_api_endpoints_receive_redacted_cookie_headers() {
        let supplied = BTreeMap::from([
            ("Cookie".into(), "SESSDATA=private-login-state".into()),
            ("Referer".into(), REFERER.into()),
            ("User-Agent".into(), USER_AGENT.into()),
        ]);
        for endpoint in [Endpoint::View, Endpoint::Nav, Endpoint::PlayUrl] {
            let headers = request_headers(endpoint, &supplied).unwrap();
            assert!(headers.get(header::COOKIE).unwrap().is_sensitive());
            assert!(!format!("{headers:?}").contains("private-login-state"));
        }
        for endpoint in [Endpoint::QrGenerate, Endpoint::QrPoll] {
            assert!(request_headers(endpoint, &supplied).is_err());
        }
        for name in [
            "Host",
            "Authorization",
            "Proxy-Authorization",
            "Connection",
            "X-Secret",
        ] {
            let supplied = BTreeMap::from([(name.into(), "private-value".into())]);
            assert!(request_headers(Endpoint::View, &supplied).is_err());
        }
        let duplicate = BTreeMap::from([
            ("Cookie".into(), "a=b".into()),
            ("cookie".into(), "c=d".into()),
        ]);
        assert!(request_headers(Endpoint::View, &duplicate).is_err());
        for value in ["SESSDATA=secret\r\nHost:evil", ""] {
            let supplied = BTreeMap::from([("Cookie".into(), value.into())]);
            assert!(request_headers(Endpoint::View, &supplied).is_err());
        }
        for referer in [
            "https://evil.example/",
            "https://www.bilibili.com:444/",
            "https://www.bilibili.com/?secret=token",
        ] {
            let supplied = BTreeMap::from([("Referer".into(), referer.into())]);
            assert!(request_headers(Endpoint::View, &supplied).is_err());
        }
    }

    #[test]
    fn body_and_response_cookie_capture_are_bounded_and_origin_scoped() {
        let mut body = Vec::new();
        append_bounded(&mut body, b"123", 4).unwrap();
        assert!(append_bounded(&mut body, b"45", 4).is_err());
        assert_eq!(body, b"123");
        append_bounded(&mut body, b"4", 4).unwrap();
        let mut headers = HeaderMap::new();
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("SESSDATA=private; Secure; HttpOnly"),
        );
        assert!(
            capture_cookies(Endpoint::View, &headers)
                .unwrap()
                .is_empty()
        );
        assert!(
            capture_cookies(Endpoint::PlayUrl, &headers)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            capture_cookies(Endpoint::QrPoll, &headers).unwrap().len(),
            1
        );
        for _ in 0..MAX_SET_COOKIES {
            headers.append(header::SET_COOKIE, HeaderValue::from_static("x=y"));
        }
        assert!(capture_cookies(Endpoint::QrPoll, &headers).is_err());
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&"a".repeat(MAX_HEADER_BYTES + 1)).unwrap(),
        );
        assert!(check_response_headers(&headers).is_err());
    }
}
