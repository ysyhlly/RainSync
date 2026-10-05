//! Bounded share-link discovery and explicit collection metadata pages.
//! This is a closed metadata API, never a general URL fetcher or feed crawler.
//! V2 pages opt in explicitly; only exact-viewer Bili season APIs admit cookies.
//! Endpoint provenance: yt-dlp's maintained Bilibili collection adapters:
//! https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py
use super::{bilibili, short_video, youtube};
use reqwest::Url;
use serde_json::Value;
use std::{collections::HashSet, fmt, future::Future, pin::Pin};
use tokio::time::Instant;
mod pages;
pub use pages::{
    CollectionPage, CollectionPageRequest, parse_collection_page_response, preview_collection_page,
};

pub const MAX_ITEMS: usize = 20;
pub const MAX_INPUT_BYTES: usize = 16 * 1024;
const MAX_URL_BYTES: usize = 2048;
const MAX_HOPS: usize = 3;
pub type Result<T> = std::result::Result<T, bilibili::Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Bilibili,
    Douyin,
    TikTok,
    YouTube,
}
impl Provider {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "bilibili" => Ok(Self::Bilibili),
            "douyin" => Ok(Self::Douyin),
            "tiktok" => Ok(Self::TikTok),
            "youtube" => Ok(Self::YouTube),
            _ => Err(bilibili::Error::InvalidResource),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bilibili => "bilibili",
            Self::Douyin => "douyin",
            Self::TikTok => "tiktok",
            Self::YouTube => "youtube",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    pub provider: Provider,
    pub url: String,
    pub part: u32,
    pub title: Option<String>,
}
impl Reference {
    pub fn key(&self) -> String {
        format!("{}:{}:{}", self.provider.as_str(), self.url, self.part)
    }
}
#[derive(Clone, PartialEq, Eq)]
pub enum Input {
    Video(Reference),
    Short { provider: Provider, url: Url },
}
impl fmt::Debug for Input {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PlatformImportInput([REDACTED])")
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Collection {
    Parts(bilibili::VideoRef),
    Season {
        mid: String,
        id: String,
    },
    Series {
        mid: String,
        id: String,
    },
    /// One explicitly supplied public TikTok saved collection, never a creator
    /// playlist, sound/tag/user feed or app/mobile API.
    TikTok {
        id: String,
    },
    TikTokPlaylist {
        id: String,
    },
    DouyinMix {
        id: String,
    },
    PgcSeason {
        id: String,
    },
    CourseSeason {
        id: String,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    ShortRedirect,
    BilibiliParts,
    BilibiliSeason,
    BilibiliSeries,
    TikTokCollection,
    TikTokPlaylist,
    DouyinMix,
    BilibiliPgcSeason,
    BilibiliCourseSeason,
}
/// Constructible only by validated input/collection identities in this module.
pub struct Request {
    endpoint: Endpoint,
    url: Url,
    provider: Provider,
    cookie: Option<bilibili::Cookie>,
}
impl fmt::Debug for Request {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ImportRequest")
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
    pub fn provider(&self) -> Provider {
        self.provider
    }
    pub fn cookie(&self) -> Option<&bilibili::Cookie> {
        self.cookie.as_ref()
    }
    pub fn referer(&self) -> Option<String> {
        if self.provider == Provider::Douyin {
            return Some("https://www.douyin.com/".into());
        }
        if self.provider == Provider::TikTok {
            return Some("https://www.tiktok.com/".into());
        }
        if self.endpoint == Endpoint::TikTokCollection {
            return Some("https://www.tiktok.com/".into());
        }
        if self.provider != Provider::Bilibili {
            return None;
        }
        let (kind, id_key) = match self.endpoint {
            Endpoint::BilibiliSeason => ("collectiondetail", "season_id"),
            Endpoint::BilibiliSeries => ("seriesdetail", "series_id"),
            _ => return Some("https://www.bilibili.com/".into()),
        };
        let pairs: std::collections::HashMap<_, _> = self.url.query_pairs().collect();
        Some(format!(
            "https://space.bilibili.com/{}/channel/{kind}?sid={}",
            pairs.get("mid")?,
            pairs.get(id_key)?
        ))
    }
    pub fn validate(&self) -> Result<()> {
        if pages::is_page_endpoint(self.endpoint) {
            return pages::validate_request(self);
        }
        if self.cookie.is_some() {
            return Err(invalid());
        }
        if self.endpoint == Endpoint::ShortRedirect {
            return match parse_input(self.url.as_str(), Some(self.provider))? {
                Input::Short { url, .. } if url == self.url => Ok(()),
                _ => Err(bilibili::Error::InvalidResource),
            };
        }
        strict_url(self.url.as_str())?;
        if self.endpoint == Endpoint::TikTokCollection {
            let id = self
                .url
                .query_pairs()
                .find(|(key, _)| key == "collectionId")
                .map(|(_, value)| value.into_owned())
                .ok_or_else(invalid)?;
            if self.provider != Provider::TikTok
                || !decimal(&id)
                || !pages::validate_saved_url(&self.url, &id)
            {
                return Err(invalid());
            }
            return Ok(());
        }
        let path = match self.endpoint {
            Endpoint::BilibiliParts => "/x/web-interface/view",
            Endpoint::BilibiliSeason => "/x/polymer/web-space/seasons_archives_list",
            Endpoint::BilibiliSeries => "/x/series/archives",
            Endpoint::ShortRedirect => unreachable!(),
            Endpoint::TikTokCollection => unreachable!(),
            Endpoint::TikTokPlaylist
            | Endpoint::DouyinMix
            | Endpoint::BilibiliPgcSeason
            | Endpoint::BilibiliCourseSeason => unreachable!(),
        };
        if self.provider != Provider::Bilibili
            || self.url.host_str() != Some("api.bilibili.com")
            || self.url.path() != path
        {
            return Err(bilibili::Error::InvalidResource);
        }
        Ok(())
    }
}
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
    pub location: Option<String>,
}
impl fmt::Debug for Response {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ImportResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish_non_exhaustive()
    }
}
pub trait Transport: Send + Sync {
    fn get<'a>(
        &'a self,
        request: Request,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>>;
}
#[derive(Debug)]
pub struct CollectionPreview {
    pub items: Vec<Reference>,
    pub truncated: bool,
}

fn invalid() -> bilibili::Error {
    bilibili::Error::InvalidResource
}
fn strict_url(value: &str) -> Result<Url> {
    if value.len() > MAX_URL_BYTES
        || !value.is_ascii()
        || value.bytes().any(|b| b <= 32 || b == 127 || b == b'\\')
        || value.contains('#')
    {
        return Err(invalid());
    }
    let url = Url::parse(value).map_err(|_| invalid())?;
    let authority = value
        .strip_prefix("https://")
        .and_then(|s| s.split('/').next())
        .ok_or_else(invalid)?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || authority.contains(['@', '%', ':'])
        || url.path().contains('%')
        || value
            .split('?')
            .next()
            .is_some_and(|v| v.split('/').any(|s| matches!(s, "." | "..")))
    {
        return Err(invalid());
    }
    Ok(url)
}
pub fn recognize(value: &str) -> Option<Provider> {
    if value.starts_with("course:ep") {
        return Some(Provider::Bilibili);
    }
    match Url::parse(value).ok()?.host_str()? {
        "bilibili.com" | "www.bilibili.com" | "m.bilibili.com" | "b23.tv"
        | "space.bilibili.com" | "live.bilibili.com" => Some(Provider::Bilibili),
        "douyin.com" | "www.douyin.com" | "v.douyin.com" | "live.douyin.com" => {
            Some(Provider::Douyin)
        }
        "tiktok.com" | "www.tiktok.com" | "vm.tiktok.com" | "vt.tiktok.com" | "m.tiktok.com" => {
            Some(Provider::TikTok)
        }
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "youtu.be" => Some(Provider::YouTube),
        _ => None,
    }
}
pub fn parse_input(value: &str, selected: Option<Provider>) -> Result<Input> {
    let value = value.trim();
    let provider = recognize(value).or(selected).ok_or_else(invalid)?;
    if selected.is_some_and(|s| s != provider) {
        return Err(invalid());
    }
    if value.starts_with("https://") {
        let url = strict_url(value)?;
        let short = match (provider, url.host_str()) {
            (Provider::Bilibili, Some("b23.tv"))
            | (Provider::Douyin, Some("v.douyin.com"))
            | (Provider::TikTok, Some("vm.tiktok.com" | "vt.tiktok.com")) => true,
            (Provider::TikTok, Some("www.tiktok.com" | "tiktok.com")) => {
                url.path().starts_with("/t/")
            }
            _ => false,
        };
        if short {
            let path = url.path().strip_prefix('/').ok_or_else(invalid)?;
            let path = path.strip_suffix('/').unwrap_or(path);
            let token = if provider == Provider::TikTok
                && matches!(url.host_str(), Some("www.tiktok.com" | "tiktok.com"))
            {
                path.strip_prefix("t/").ok_or_else(invalid)?
            } else {
                path
            };
            if url.query().is_some()
                || token.is_empty()
                || token.len() > 64
                || !token.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                return Err(invalid());
            }
            return Ok(Input::Short { provider, url });
        }
    }
    if provider != Provider::Bilibili
        && let Ok(p) = super::other_live::Provider::parse(provider.as_str())
        && let Ok(resource) = super::other_live::parse_resource(p, value)
    {
        return Ok(Input::Video(Reference {
            provider,
            url: resource.canonical(),
            part: 1,
            title: None,
        }));
    }
    // Live pages retain their exact no-query identity and never enter the VOD
    // tracking-query normalization or collection expansion contract.
    if provider == Provider::Bilibili
        && Url::parse(value)
            .ok()
            .is_some_and(|url| url.host_str() == Some("live.bilibili.com"))
    {
        let room = bilibili::live::parse_resource(value)?;
        return Ok(Input::Video(Reference {
            provider,
            url: room.canonical(),
            part: 1,
            title: None,
        }));
    }
    // Course episodes preserve their own exact identity and do not inherit
    // ordinary VOD tracking-query stripping, part selection or season crawling.
    if provider == Provider::Bilibili
        && (value.starts_with("course:ep")
            || Url::parse(value)
                .ok()
                .is_some_and(|url| url.path().starts_with("/cheese/")))
    {
        let episode = bilibili::course::parse_resource(value)?;
        return Ok(Input::Video(Reference {
            provider,
            url: episode.canonical(),
            part: 1,
            title: None,
        }));
    }
    // PGC episodes have a separate closed identity and never inherit the UGC
    // query stripping / part-number contract, even after a short redirect.
    if provider == Provider::Bilibili && (value.starts_with("ep") || value.contains("/bangumi/")) {
        let episode = bilibili::pgc::parse_resource(value)?;
        return Ok(Input::Video(Reference {
            provider,
            url: episode.canonical(),
            part: 1,
            title: None,
        }));
    }
    // Sharing a Bilibili video commonly adds tracking keys. Keep only its exact
    // part identity; other providers retain their stricter ordinary parser.
    if provider == Provider::Bilibili && value.starts_with("https://") {
        let mut url = strict_url(value)?;
        let parts = parts(&url)?;
        if parts.len() > 1 {
            return Err(invalid());
        }
        url.set_query(None);
        if let Some(part) = parts.first() {
            url.set_query(Some(&format!("p={part}")));
        }
        return canonical(provider, url.as_str()).map(Input::Video);
    }
    canonical(provider, value).map(Input::Video)
}
fn canonical(provider: Provider, value: &str) -> Result<Reference> {
    let (url, part) = match provider {
        Provider::Bilibili => {
            let r = bilibili::parse_resource(value)?;
            (r.canonical(), r.part)
        }
        Provider::Douyin | Provider::TikTok => {
            let p = if provider == Provider::Douyin {
                short_video::Platform::Douyin
            } else {
                short_video::Platform::TikTok
            };
            let r = short_video::parse_resource(p, value).map_err(|_| invalid())?;
            (r.canonical(), 1)
        }
        Provider::YouTube => {
            let r = youtube::parse_resource(value).map_err(|_| invalid())?;
            (r.canonical(), 1)
        }
    };
    Ok(Reference {
        provider,
        url,
        part,
        title: None,
    })
}
/// Extract HTTPS links from ordinary share text. Each unrecognized URL remains a
/// candidate and fails explicitly; never silently turn mixed text into a crawl.
pub fn candidates(value: &str) -> Result<Vec<String>> {
    if value.trim().is_empty() || value.len() > MAX_INPUT_BYTES || value.chars().any(|c| c == '\0')
    {
        return Err(invalid());
    }
    let mut links = Vec::new();
    let mut rest = value;
    while let Some(offset) = rest.find("https://") {
        rest = &rest[offset..];
        let end = rest
            .find(|c: char| {
                c.is_whitespace()
                    || matches!(
                        c,
                        '，' | '。' | '；' | '、' | '（' | '）' | '<' | '>' | '"' | '\''
                    )
            })
            .unwrap_or(rest.len());
        let link = rest[..end].trim_end_matches(['.', ',', ';', ')', ']']);
        if link.len() > MAX_URL_BYTES || links.len() >= MAX_ITEMS {
            return Err(bilibili::Error::TooLarge);
        }
        links.push(link.to_owned());
        rest = &rest[end..];
    }
    if links.is_empty() {
        for line in value.lines().map(str::trim).filter(|v| !v.is_empty()) {
            if links.len() >= MAX_ITEMS || line.len() > MAX_URL_BYTES {
                return Err(bilibili::Error::TooLarge);
            }
            links.push(line.to_owned());
        }
    }
    Ok(links)
}
fn redirect_identity(provider: Provider, value: &str) -> Result<Input> {
    let mut url = strict_url(value)?;
    if url.host_str() == Some("live.bilibili.com") || url.path().starts_with("/cheese/") {
        return parse_input(value, Some(provider));
    }
    if matches!(
        url.host_str(),
        Some("b23.tv" | "v.douyin.com" | "vm.tiktok.com" | "vt.tiktok.com")
    ) || (provider == Provider::TikTok && url.path().starts_with("/t/"))
    {
        return parse_input(value, Some(provider));
    }
    // Query tracking is discarded without ever visiting the final video page.
    // Bilibili alone preserves the exact, unique part selection.
    let part = if provider == Provider::Bilibili {
        let parts = parts(&url)?;
        if parts.len() > 1 {
            return Err(invalid());
        }
        parts.into_iter().next()
    } else {
        None
    };
    url.set_query(None);
    if provider == Provider::Douyin
        && matches!(url.host_str(), Some("www.iesdouyin.com" | "iesdouyin.com"))
    {
        let id = url
            .path()
            .trim_end_matches('/')
            .strip_prefix("/share/video/")
            .ok_or_else(invalid)?;
        return canonical(provider, id).map(Input::Video);
    }
    if let Some(part) = part {
        url.set_query(Some(&format!("p={part}")));
    }
    canonical(provider, url.as_str()).map(Input::Video)
}
fn parts(url: &Url) -> Result<Vec<String>> {
    let mut parts = Vec::new();
    if let Some(query) = url.query() {
        for pair in query.split('&') {
            let (key, value) = pair.split_once('=').ok_or_else(invalid)?;
            if key.is_empty()
                || !key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            {
                return Err(invalid());
            }
            if key == "p" {
                if !decimal(value) {
                    return Err(invalid());
                }
                parts.push(value.into());
            }
        }
    }
    Ok(parts)
}
pub async fn resolve<T: Transport>(
    transport: &T,
    input: Input,
    deadline: Instant,
) -> Result<Reference> {
    let mut input = input;
    let mut visited = HashSet::new();
    for _ in 0..MAX_HOPS {
        let (provider, url) = match input {
            Input::Video(reference) => return Ok(reference),
            Input::Short { provider, url } => (provider, url),
        };
        if !visited.insert(url.as_str().to_owned()) {
            return Err(bilibili::Error::Restricted(
                "platform_import_redirect_cycle",
            ));
        }
        let response = tokio::time::timeout_at(
            deadline,
            transport.get(
                Request {
                    endpoint: Endpoint::ShortRedirect,
                    url,
                    provider,
                    cookie: None,
                },
                deadline,
            ),
        )
        .await
        .map_err(|_| bilibili::Error::Deadline)??;
        if !matches!(response.status, 301 | 302 | 303 | 307 | 308) || !response.body.is_empty() {
            return Err(bilibili::Error::Restricted(
                "platform_import_shortlink_unavailable",
            ));
        }
        let target = response
            .location
            .as_deref()
            .ok_or(bilibili::Error::InvalidResponse(
                "missing_platform_redirect",
            ))?;
        input = redirect_identity(provider, target)?;
        if let Input::Video(reference) = input {
            return Ok(reference);
        }
    }
    Err(bilibili::Error::Restricted(
        "platform_import_redirect_limit",
    ))
}
fn decimal(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('0')
        && value.len() <= 20
        && value.bytes().all(|b| b.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}
pub fn parse_collection(value: &str, provider: Provider) -> Result<Collection> {
    if let Some(result) = pages::parse_new_collection(value, provider) {
        return result;
    }
    if provider == Provider::TikTok {
        // Only the reviewed saved-collection path is supported. Creator
        // /playlist and other list families deliberately remain unsupported.
        if value.contains("/collection/") {
            return parse_tiktok_collection(value).map(|id| Collection::TikTok { id });
        }
        return Err(bilibili::Error::Restricted(
            "platform_collection_unsupported",
        ));
    }
    if provider != Provider::Bilibili {
        return Err(bilibili::Error::Restricted(
            "platform_collection_unsupported",
        ));
    }
    if let Ok(reference) = bilibili::parse_resource(value) {
        return Ok(Collection::Parts(reference));
    }
    let url = strict_url(value.trim())?;
    if url.host_str() != Some("space.bilibili.com") {
        return Err(invalid());
    }
    let path: Vec<_> = url.path().trim_matches('/').split('/').collect();
    let pairs: Vec<_> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if path.len() == 3
        && decimal(path[0])
        && path[1] == "lists"
        && decimal(path[2])
        && pairs.len() == 1
        && pairs[0].0 == "type"
    {
        return match pairs[0].1.as_str() {
            "season" => Ok(Collection::Season {
                mid: path[0].into(),
                id: path[2].into(),
            }),
            "series" => Ok(Collection::Series {
                mid: path[0].into(),
                id: path[2].into(),
            }),
            _ => Err(invalid()),
        };
    }
    if path.len() == 3
        && decimal(path[0])
        && path[1] == "channel"
        && pairs.len() == 1
        && pairs[0].0 == "sid"
        && decimal(&pairs[0].1)
    {
        return match path[2] {
            "collectiondetail" => Ok(Collection::Season {
                mid: path[0].into(),
                id: pairs[0].1.clone(),
            }),
            "seriesdetail" => Ok(Collection::Series {
                mid: path[0].into(),
                id: pairs[0].1.clone(),
            }),
            _ => Err(invalid()),
        };
    }
    Err(invalid())
}

// Source-grounded first page only, count=30 is the maintained adapter's fixed
// web API shape. The application outputs <=20 and never follows a cursor.
// https://github.com/yt-dlp/yt-dlp/blob/51bab8a0116f4d8004c315706d809782607d5847/yt_dlp/extractor/tiktok.py#L1235-L1286
const TIKTOK_COLLECTION_PAGE_ITEMS: usize = 30;
fn parse_tiktok_collection(value: &str) -> Result<String> {
    if value.is_empty()
        || value.len() > MAX_URL_BYTES
        || !value.is_ascii()
        || value.bytes().any(|b| b <= 32 || b == 127 || b == b'\\')
    {
        return Err(invalid());
    }
    let rest = value
        .strip_prefix("https://www.tiktok.com/")
        .ok_or_else(invalid)?;
    if rest.contains(['?', '#']) {
        return Err(invalid());
    }
    let segments = rest
        .strip_suffix('/')
        .unwrap_or(rest)
        .split('/')
        .collect::<Vec<_>>();
    if segments.len() != 3 || segments[1] != "collection" {
        return Err(invalid());
    }
    let handle = segments[0].strip_prefix('@').ok_or_else(invalid)?;
    // Reuse the admitted ordinary-video handle grammar, without visiting it.
    short_video::parse_resource(
        short_video::Platform::TikTok,
        &format!("https://www.tiktok.com/@{handle}/video/1"),
    )
    .map_err(|_| invalid())?;
    let (title, id) = segments[2].rsplit_once('-').ok_or_else(invalid)?;
    if title.is_empty() || title.len() > 512 || !decimal(id) {
        return Err(invalid());
    }
    // Titles may carry ordinary percent-encoded Unicode (maintained fixture:
    // emoji collection names). Decode only this inert label; reject separators,
    // controls, double escapes and dot-normalization spellings before admission.
    let mut decoded = Vec::new();
    let mut raw = title.as_bytes().iter().copied();
    while let Some(byte) = raw.next() {
        if byte == b'%' {
            let hi = raw
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or_else(invalid)?;
            let lo = raw
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or_else(invalid)?;
            decoded.push((hi * 16 + lo) as u8);
        } else {
            decoded.push(byte);
        }
    }
    let label = std::str::from_utf8(&decoded).map_err(|_| invalid())?;
    if label.trim().is_empty()
        || matches!(label, "." | "..")
        || label.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | '?' | '#' | '%' | '\u{2028}' | '\u{2029}')
        })
    {
        return Err(invalid());
    }
    // A second URL parse checks spelling without ever sending a page request.
    let url = Url::parse(value).map_err(|_| invalid())?;
    if url.host_str() != Some("www.tiktok.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(id.into())
}
fn tiktok_collection_url(id: &str) -> Result<Url> {
    if !decimal(id) {
        return Err(invalid());
    }
    let mut url =
        Url::parse("https://www.tiktok.com/api/collection/item_list/").expect("fixed origin");
    url.query_pairs_mut().extend_pairs([
        ("aid", "1988"),
        ("collectionId", id),
        ("count", "30"),
        ("cursor", "0"),
        ("sourceType", "113"),
    ]);
    Ok(url)
}
fn parse_tiktok_collection_response(body: &[u8]) -> Result<CollectionPreview> {
    let value: Value = serde_json::from_slice(body).map_err(|_| bilibili::Error::InvalidJson)?;
    if let Some(status) = value.get("statusCode") {
        let code = status.as_i64().ok_or_else(invalid)?;
        if code != 0 {
            return Err(bilibili::Error::Api(code));
        }
    }
    let has_more = value["hasMore"].as_bool().ok_or_else(invalid)?;
    let records = value["itemList"].as_array().ok_or_else(invalid)?;
    if records.len() > TIKTOK_COLLECTION_PAGE_ITEMS {
        return Err(bilibili::Error::TooLarge);
    }
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for (index, record) in records.iter().enumerate() {
        let id = record["id"]
            .as_str()
            .filter(|id| decimal(id))
            .ok_or_else(invalid)?;
        let handle = record["author"]["uniqueId"].as_str().ok_or_else(invalid)?;
        let checked = short_video::parse_resource(
            short_video::Platform::TikTok,
            &format!("https://www.tiktok.com/@{handle}/video/{id}"),
        )
        .map_err(|_| invalid())?;
        // Validate all received identities, but no tail item can refill or
        // expand the first20 preview. Child import checks ordinary video rights.
        if index < MAX_ITEMS && seen.insert(checked.id().to_owned()) {
            items.push(Reference {
                provider: Provider::TikTok,
                url: checked.canonical(),
                part: 1,
                title: title(&record["desc"]),
            });
        }
    }
    Ok(CollectionPreview {
        items,
        truncated: has_more || records.len() > MAX_ITEMS,
    })
}
fn collection_request(collection: &Collection) -> Result<Request> {
    if let Collection::TikTok { id } = collection {
        return Ok(Request {
            endpoint: Endpoint::TikTokCollection,
            url: tiktok_collection_url(id)?,
            provider: Provider::TikTok,
            cookie: None,
        });
    }
    let (endpoint, path, pairs) = match collection {
        Collection::Parts(reference) => {
            let checked = bilibili::parse_resource(&reference.canonical())?;
            let pair = match checked.id {
                bilibili::VideoId::Bv(id) => ("bvid", id),
                bilibili::VideoId::Av(id) => ("aid", id),
            };
            (Endpoint::BilibiliParts, "/x/web-interface/view", vec![pair])
        }
        Collection::Season { mid, id } | Collection::Series { mid, id } => {
            if !decimal(mid) || !decimal(id) {
                return Err(invalid());
            }
            if matches!(collection, Collection::Season { .. }) {
                (
                    Endpoint::BilibiliSeason,
                    "/x/polymer/web-space/seasons_archives_list",
                    vec![
                        ("mid", mid.clone()),
                        ("season_id", id.clone()),
                        ("sort_reverse", "false".into()),
                        ("page_num", "1".into()),
                        ("page_size", MAX_ITEMS.to_string()),
                    ],
                )
            } else {
                (
                    Endpoint::BilibiliSeries,
                    "/x/series/archives",
                    vec![
                        ("mid", mid.clone()),
                        ("series_id", id.clone()),
                        ("pn", "1".into()),
                        ("ps", MAX_ITEMS.to_string()),
                    ],
                )
            }
        }
        Collection::TikTok { .. } => unreachable!(),
        Collection::TikTokPlaylist { .. }
        | Collection::DouyinMix { .. }
        | Collection::PgcSeason { .. }
        | Collection::CourseSeason { .. } => {
            return pages::page_request(collection, &CollectionPageRequest::default(), None);
        }
    };
    let mut url = Url::parse(&format!("https://api.bilibili.com{path}")).expect("fixed origin");
    url.query_pairs_mut().extend_pairs(pairs);
    Ok(Request {
        endpoint,
        url,
        provider: Provider::Bilibili,
        cookie: None,
    })
}
fn title(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|s| {
            s.chars()
                .filter(|c| !c.is_control() && !matches!(c, '\u{2028}' | '\u{2029}'))
                .take(200)
                .collect::<String>()
        })
        .filter(|s| !s.trim().is_empty())
}
pub fn parse_collection_response(
    collection: &Collection,
    body: &[u8],
) -> Result<CollectionPreview> {
    if matches!(
        collection,
        Collection::TikTokPlaylist { .. }
            | Collection::DouyinMix { .. }
            | Collection::PgcSeason { .. }
            | Collection::CourseSeason { .. }
    ) {
        let page =
            parse_collection_page_response(collection, &CollectionPageRequest::default(), body)?;
        return Ok(CollectionPreview {
            items: page.items,
            truncated: page.has_more,
        });
    }
    if body.len() > 2 * 1024 * 1024 {
        return Err(bilibili::Error::TooLarge);
    }
    if let Collection::TikTok { id } = collection {
        if !decimal(id) {
            return Err(invalid());
        }
        return parse_tiktok_collection_response(body);
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| bilibili::Error::InvalidJson)?;
    let code = value["code"]
        .as_i64()
        .ok_or(bilibili::Error::InvalidResponse("collection_code"))?;
    if code != 0 {
        return Err(bilibili::Error::Api(code));
    }
    let data = &value["data"];
    let (entries, total) = if let Collection::Parts(reference) = collection {
        let bvid = data["bvid"].as_str().ok_or_else(invalid)?;
        let checked = bilibili::parse_resource(bvid)?;
        match &reference.id {
            bilibili::VideoId::Bv(id) if id != bvid => return Err(invalid()),
            bilibili::VideoId::Av(id)
                if data["aid"].as_u64().map(|v| v.to_string()).as_deref() != Some(id) =>
            {
                return Err(invalid());
            }
            _ => {}
        }
        let pages = data["pages"].as_array().ok_or_else(invalid)?;
        if pages.is_empty() || pages.len() > 10_000 {
            return Err(bilibili::Error::TooLarge);
        }
        let mut entries = Vec::new();
        for (index, page) in pages.iter().take(MAX_ITEMS).enumerate() {
            if page["page"].as_u64() != Some((index + 1) as u64) {
                return Err(invalid());
            }
            let r = bilibili::VideoRef {
                id: checked.id.clone(),
                part: (index + 1) as u32,
            };
            let name = title(&page["part"]).unwrap_or_else(|| format!("P{}", index + 1));
            entries.push(Reference {
                provider: Provider::Bilibili,
                url: r.canonical(),
                part: r.part,
                title: Some(
                    format!(
                        "{} · {}",
                        title(&data["title"]).unwrap_or_else(|| "Bilibili".into()),
                        name
                    )
                    .chars()
                    .take(200)
                    .collect(),
                ),
            });
        }
        (entries, pages.len() as u64)
    } else {
        let archives = data["archives"].as_array().ok_or_else(invalid)?;
        if let Collection::Season { mid, id } = collection
            && (data["meta"]["mid"]
                .as_u64()
                .map(|v| v.to_string())
                .as_deref()
                != Some(mid)
                || data["meta"]["season_id"]
                    .as_u64()
                    .map(|v| v.to_string())
                    .as_deref()
                    != Some(id)
                || data["page"]["page_num"].as_u64() != Some(1)
                || data["page"]["page_size"].as_u64() != Some(MAX_ITEMS as u64))
        {
            return Err(invalid());
        }
        let total = data["page"]["total"]
            .as_u64()
            .filter(|v| *v <= 1_000_000)
            .ok_or_else(invalid)?;
        if archives.len() > MAX_ITEMS || total < archives.len() as u64 {
            return Err(bilibili::Error::TooLarge);
        }
        let mut entries = Vec::new();
        let mut seen = HashSet::new();
        for archive in archives {
            let bvid = archive["bvid"].as_str().ok_or_else(invalid)?;
            let mut reference = canonical(Provider::Bilibili, bvid)?;
            if !matches!(bilibili::parse_resource(bvid)?.id, bilibili::VideoId::Bv(_))
                || !seen.insert(reference.key())
            {
                return Err(invalid());
            }
            reference.title = title(&archive["title"]);
            entries.push(reference);
        }
        (entries, total)
    };
    let truncated = total > entries.len() as u64;
    Ok(CollectionPreview {
        items: entries,
        truncated,
    })
}
pub async fn preview_collection<T: Transport>(
    transport: &T,
    collection: &Collection,
    deadline: Instant,
) -> Result<CollectionPreview> {
    if Instant::now() >= deadline {
        return Err(bilibili::Error::Deadline);
    }
    let response = tokio::time::timeout_at(
        deadline,
        transport.get(collection_request(collection)?, deadline),
    )
    .await
    .map_err(|_| bilibili::Error::Deadline)??;
    if Instant::now() >= deadline {
        return Err(bilibili::Error::Deadline);
    }
    if response.status != 200 || response.location.is_some() {
        return Err(bilibili::Error::Status(response.status));
    }
    let result = parse_collection_response(collection, &response.body);
    if Instant::now() >= deadline {
        return Err(bilibili::Error::Deadline);
    }
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn pgc_episode_discovery_keeps_closed_episode_identity_and_rejects_ugc_queries() {
        let input = super::parse_input(
            "https://www.bilibili.com/bangumi/play/ep7",
            Some(super::Provider::Bilibili),
        )
        .unwrap();
        assert!(
            matches!(input,super::Input::Video(ref r) if r.url=="https://www.bilibili.com/bangumi/play/ep7" && r.part==1)
        );
        for resource in [
            "https://www.bilibili.com/bangumi/play/ss7",
            "https://www.bilibili.com/bangumi/play/ep7?p=2",
            "https://www.bilibili.com/bangumi/play/ep7?from=share",
        ] {
            assert!(super::parse_input(resource, Some(super::Provider::Bilibili)).is_err());
        }
    }

    use super::*;
    #[test]
    fn sharetext_and_limits() {
        assert_eq!(
            candidates("复制打开抖音 https://v.douyin.com/ABC123/ 看视频").unwrap(),
            vec!["https://v.douyin.com/ABC123/"]
        );
        assert_eq!(
            candidates("https://b23.tv/ABC1234，https://youtu.be/dQw4w9WgXcQ")
                .unwrap()
                .len(),
            2
        );
        assert!(candidates(&"https://b23.tv/ABC1234\n".repeat(21)).is_err());
        assert!(candidates(&"x".repeat(MAX_INPUT_BYTES + 1)).is_err());
    }
    #[test]
    fn closed_short_origins_and_provider_fences() {
        for (p, url) in [
            (Provider::Bilibili, "https://b23.tv/ABC1234"),
            (Provider::Douyin, "https://v.douyin.com/ABC123/"),
            (Provider::TikTok, "https://vm.tiktok.com/ZMABC123/"),
            (Provider::TikTok, "https://www.tiktok.com/t/ZMABC123/"),
        ] {
            assert!(matches!(
                parse_input(url, Some(p)).unwrap(),
                Input::Short { .. }
            ));
        }
        for url in [
            "http://b23.tv/ABC1234",
            "https://b23.tv.evil.test/ABC1234",
            "https://b23.tv:443/ABC1234",
            "https://user@b23.tv/ABC1234",
            "https://b23.tv/../ABC1234",
            "https://b23.tv/ABC1234?token=secret",
            "https://b23.tv/%41BC1234",
            "https://b23.tv/ABC1234#x",
        ] {
            assert!(parse_input(url, Some(Provider::Bilibili)).is_err(), "{url}");
        }
        assert!(parse_input("https://v.douyin.com/ABC123/", Some(Provider::TikTok)).is_err());
        assert!(
            redirect_identity(
                Provider::Douyin,
                "https://www.tiktok.com/@creator/video/123"
            )
            .is_err()
        );
        assert!(
            redirect_identity(Provider::Bilibili, "https://127.0.0.1/video/BV1xx411c7mD").is_err()
        );
        assert!(
            redirect_identity(
                Provider::Bilibili,
                "https://www.bilibili.com/video/BV1xx411c7mD?p=1&p=2"
            )
            .is_err()
        );
        assert_eq!(
            match redirect_identity(
                Provider::Douyin,
                "https://www.iesdouyin.com/share/video/123/?from=share"
            )
            .unwrap()
            {
                Input::Video(r) => r.url,
                _ => panic!(),
            },
            "https://www.douyin.com/video/123"
        );
    }
    #[test]
    fn bounded_collection_parse() {
        let collection = parse_collection(
            "https://space.bilibili.com/123/lists/456?type=season",
            Provider::Bilibili,
        )
        .unwrap();
        let request = collection_request(&collection).unwrap();
        request.validate().unwrap();
        assert_eq!(
            request.url().as_str(),
            "https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=123&season_id=456&sort_reverse=false&page_num=1&page_size=20"
        );
        let body=serde_json::to_vec(&serde_json::json!({"code":0,"data":{"meta":{"mid":123,"season_id":456},"page":{"total":21,"page_num":1,"page_size":20},"archives":[{"bvid":"BV1xx411c7mD","title":"Example"}]}})).unwrap();
        let preview = parse_collection_response(&collection, &body).unwrap();
        assert_eq!(preview.items.len(), 1);
        assert!(preview.truncated);
        for p in [Provider::Douyin, Provider::TikTok, Provider::YouTube] {
            assert_eq!(
                parse_collection("https://example.test/collection", p).unwrap_err(),
                bilibili::Error::Restricted("platform_collection_unsupported")
            );
        }
        assert!(
            parse_collection(
                "https://space.bilibili.com/123/lists/456?type=season&cookie=secret",
                Provider::Bilibili
            )
            .is_err()
        );
    }
    #[test]
    fn tiktok_saved_collection_is_exact_unsigned_first_page_and_never_a_creator_playlist() {
        let collection = parse_collection(
            "https://www.tiktok.com/@creator/collection/example-7371330159376370462",
            Provider::TikTok,
        )
        .unwrap();
        let request = collection_request(&collection).unwrap();
        request.validate().unwrap();
        assert_eq!(
            request.url().as_str(),
            "https://www.tiktok.com/api/collection/item_list/?aid=1988&collectionId=7371330159376370462&count=30&cursor=0&sourceType=113"
        );
        assert_eq!(request.endpoint(), Endpoint::TikTokCollection);
        assert!(
            parse_collection(
                "https://www.tiktok.com/@creator/collection/%F0%9F%98%82-7371330159376370462",
                Provider::TikTok
            )
            .is_ok()
        );
        assert!(matches!(
            parse_collection(
                "https://www.tiktok.com/@creator/playlist/example-7371330159376370462",
                Provider::TikTok
            )
            .unwrap(),
            Collection::TikTokPlaylist { .. }
        ));
        assert!(matches!(
            parse_collection(
                "https://www.douyin.com/collection/7371330159376370462",
                Provider::Douyin
            )
            .unwrap(),
            Collection::DouyinMix { .. }
        ));
        for path in [
            "https://user@www.tiktok.com/@creator/collection/example-123",
            "https://www.tiktok.com:443/@creator/collection/example-123",
            "https://www.tiktok.com/@creator/collection/example-123?cursor=30",
            "https://www.tiktok.com/@creator/collection/example-123#x",
            "https://www.tiktok.com/@creator/collection/example-01",
            "https://www.tiktok.com/@creator/collection/%2F-123",
            "https://www.tiktok.com/@creator/collection/%252F-123",
            "https://www.tiktok.com/@creator/collection/../example-123",
            "https://www.tiktok.com/@creator/collection/%2e%2e-123",
            "https://www.tiktok.com/@creator/collection/%FF-123",
            "https://www.tiktok.com/@creator/collection/example-123///",
        ] {
            assert!(parse_collection(path, Provider::TikTok).is_err(), "{path}");
        }
        for query in [
            "&cookie=private",
            "&cursor=30",
            "&collectionId=1",
            "&count=100",
        ] {
            let request = Request {
                endpoint: Endpoint::TikTokCollection,
                provider: Provider::TikTok,
                cookie: None,
                url: Url::parse(&format!("{}{}", request.url(), query)).unwrap(),
            };
            assert!(request.validate().is_err());
        }
    }
    fn tiktok_collection_fixture(count: usize) -> Value {
        serde_json::json!({"statusCode":0,"hasMore":false,"itemList":(0..count).map(|i|serde_json::json!({"id":(100+i).to_string(),"author":{"uniqueId":"creator"},"desc":"Example","video":{"playAddr":"https://attacker.test/do-not-copy"},"http_headers":{"Cookie":"never-copy"}})).collect::<Vec<_>>()})
    }
    #[tokio::test]
    async fn tiktok_collection_preview_never_requests_a_continuation_or_child_page() {
        struct FirstPage {
            calls: std::sync::atomic::AtomicUsize,
            body: Vec<u8>,
        }
        impl Transport for FirstPage {
            fn get<'a>(
                &'a self,
                request: Request,
                _: Instant,
            ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>> {
                Box::pin(async move {
                    request.validate()?;
                    assert_eq!(request.endpoint(), Endpoint::TikTokCollection);
                    assert!(
                        request
                            .url()
                            .as_str()
                            .contains("count=30&cursor=0&sourceType=113")
                    );
                    self.calls
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    Ok(Response {
                        status: 200,
                        body: self.body.clone(),
                        location: None,
                    })
                })
            }
        }
        let mut fixture = tiktok_collection_fixture(30);
        fixture["hasMore"] = serde_json::json!(true);
        fixture["cursor"] = serde_json::json!(30);
        let transport = FirstPage {
            calls: std::sync::atomic::AtomicUsize::new(0),
            body: serde_json::to_vec(&fixture).unwrap(),
        };
        let collection = Collection::TikTok { id: "123".into() };
        let preview = preview_collection(
            &transport,
            &collection,
            Instant::now() + std::time::Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(preview.items.len(), 20);
        assert!(preview.truncated);
        assert_eq!(
            transport.calls.load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        assert_eq!(
            preview_collection(&transport, &collection, Instant::now())
                .await
                .unwrap_err(),
            bilibili::Error::Deadline
        );
        assert_eq!(
            transport.calls.load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }
    #[test]
    fn tiktok_collection_records_have_strict_canonical_ids_titles_and_bounded_truncation() {
        let collection = Collection::TikTok {
            id: "7371330159376370462".into(),
        };
        let parse =
            |v: &Value| parse_collection_response(&collection, &serde_json::to_vec(v).unwrap());
        let p = parse(&tiktok_collection_fixture(30)).unwrap();
        assert_eq!(p.items.len(), 20);
        assert!(p.truncated);
        assert_eq!(p.items[0].url, "https://www.tiktok.com/@creator/video/100");
        assert!(!format!("{p:?}").contains("attacker"));
        assert!(!format!("{p:?}").contains("never-copy"));
        assert!(!parse(&tiktok_collection_fixture(20)).unwrap().truncated);
        assert_eq!(
            parse(&tiktok_collection_fixture(31)).unwrap_err(),
            bilibili::Error::TooLarge
        );
        let mut f = tiktok_collection_fixture(1);
        f["hasMore"] = serde_json::json!(true);
        assert!(parse(&f).unwrap().truncated);
        f["statusCode"] = serde_json::json!(403);
        assert_eq!(parse(&f).unwrap_err(), bilibili::Error::Api(403));
        for (field, value) in [
            ("id", serde_json::json!(123)),
            ("id", serde_json::json!("000123")),
            ("id", serde_json::json!("18446744073709551616")),
            ("author", serde_json::json!({"uniqueId":"bad/name"})),
            ("author", serde_json::json!({"uniqueId":"../escape"})),
            (
                "author",
                serde_json::json!({"uniqueId":"https://attacker.test"}),
            ),
        ] {
            let mut f = tiktok_collection_fixture(1);
            f["itemList"][0][field] = value;
            assert!(parse(&f).is_err());
        }
        let mut f = tiktok_collection_fixture(2);
        f["itemList"][0]["desc"] = serde_json::json!(format!("\n{}\u{2028}", "好".repeat(201)));
        f["itemList"][1] = f["itemList"][0].clone();
        let p = parse(&f).unwrap();
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.items[0].title.as_ref().unwrap().chars().count(), 200);
        let mut f = tiktok_collection_fixture(30);
        f["itemList"][29]["id"] = serde_json::json!("bad");
        assert!(parse(&f).is_err());
        for value in [
            serde_json::json!({}),
            serde_json::json!({"hasMore":false}),
            serde_json::json!({"hasMore":0,"itemList":[]}),
            serde_json::json!({"hasMore":true,"itemList":{}}),
        ] {
            assert!(parse(&value).is_err());
        }
    }
    struct Mock {
        locations: std::sync::Mutex<Vec<String>>,
    }
    impl Transport for Mock {
        fn get<'a>(
            &'a self,
            request: Request,
            _: Instant,
        ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>> {
            Box::pin(async move {
                request.validate()?;
                Ok(Response {
                    status: 302,
                    body: vec![],
                    location: Some(self.locations.lock().unwrap().remove(0)),
                })
            })
        }
    }
    #[tokio::test]
    async fn redirects_are_typed_bounded_and_anonymous() {
        let input = parse_input("https://b23.tv/ABC1234", None).unwrap();
        let mock = Mock {
            locations: std::sync::Mutex::new(vec![
                "https://www.bilibili.com/video/BV1xx411c7mD?p=2&share_source=copy".into(),
            ]),
        };
        assert_eq!(
            resolve(
                &mock,
                input,
                tokio::time::Instant::now() + std::time::Duration::from_secs(1)
            )
            .await
            .unwrap()
            .part,
            2
        );
        let mock = Mock {
            locations: std::sync::Mutex::new(vec!["https://b23.tv/ABC1234".into()]),
        };
        assert!(
            resolve(
                &mock,
                parse_input("https://b23.tv/ABC1234", None).unwrap(),
                Instant::now() + std::time::Duration::from_secs(1)
            )
            .await
            .is_err()
        );
    }
    #[test]
    fn live_import_stays_a_closed_page_identity_without_vod_query_stripping() {
        let input = parse_input("https://live.bilibili.com/blanc/7", None).unwrap();
        let Input::Video(reference) = input else {
            panic!()
        };
        assert_eq!(reference.url, "https://live.bilibili.com/7");
        assert_eq!(reference.provider, Provider::Bilibili);
        assert!(parse_collection(&reference.url, Provider::Bilibili).is_err());
        for value in [
            "https://live.bilibili.com/7?expires=123",
            "https://live.bilibili.com/7#fragment",
            "https://live.bilibili.com/live-bvc/index.m3u8",
            "https://live.bilibili.com/7?share_source=copy",
        ] {
            assert!(parse_input(value, None).is_err());
            assert!(redirect_identity(Provider::Bilibili, value).is_err());
        }
    }
    #[test]
    fn course_import_is_exact_and_never_a_collection_or_ugc_part() {
        for value in [
            "course:ep9007199254740993",
            "https://m.bilibili.com/cheese/play/ep9007199254740993/",
        ] {
            let Input::Video(reference) = parse_input(value, None).unwrap() else {
                panic!()
            };
            assert_eq!(reference.provider, Provider::Bilibili);
            assert_eq!(
                reference.url,
                "https://www.bilibili.com/cheese/play/ep9007199254740993"
            );
            assert_eq!(reference.part, 1);
            assert!(parse_collection(&reference.url, Provider::Bilibili).is_err());
            assert!(parse_input(value, Some(Provider::YouTube)).is_err());
        }
        for value in [
            "course:ep0",
            "course:ep01",
            "course:ep1?p=2",
            "https://www.bilibili.com/cheese/play/ep1?share_source=copy",
            "https://www.bilibili.com/cheese/play/ep1?p=2",
            "https://www.bilibili.com/cheese/play/ep1#fragment",
            "https://www.bilibili.com/cheese/play/ss1",
        ] {
            assert!(parse_input(value, Some(Provider::Bilibili)).is_err());
        }
        assert!(matches!(
            parse_collection(
                "https://www.bilibili.com/cheese/play/ss1",
                Provider::Bilibili
            )
            .unwrap(),
            Collection::CourseSeason { .. }
        ));
        assert!(
            redirect_identity(
                Provider::Bilibili,
                "https://www.bilibili.com/cheese/play/ep1?from=share"
            )
            .is_err()
        );
        let Input::Video(reference) = redirect_identity(
            Provider::Bilibili,
            "https://www.bilibili.com/cheese/play/ep1",
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(reference.url, "https://www.bilibili.com/cheese/play/ep1");
    }
    #[tokio::test]
    async fn canonical_course_import_never_opens_a_discovery_transport() {
        let mock = Mock {
            locations: std::sync::Mutex::new(vec![]),
        };
        let reference = resolve(
            &mock,
            parse_input("course:ep7", None).unwrap(),
            Instant::now() + std::time::Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(reference.url, "https://www.bilibili.com/cheese/play/ep7");
        assert_eq!(reference.part, 1);
        assert!(mock.locations.lock().unwrap().is_empty());
    }
}
