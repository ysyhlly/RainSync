//! Closed, opt-in other-platform live adapters. No VOD/extractor fallback.
//! Raw URLs/cookies stay server-side. No signature, fingerprint, JS challenge,
//! login, DRM, feed or arbitrary endpoint is implemented. See BOUNDARY.md.
use super::{
    bilibili::{self, Error},
    short_video,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fmt, future::Future, pin::Pin};
use tokio::time::Instant;
pub type Result<T> = std::result::Result<T, Error>;
pub const MAX_API_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PLAYLIST_BYTES: usize = 128 * 1024;
pub const MAX_SEGMENT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_LIVE_GRANT_SECONDS: u64 = 120;
pub mod playlist;
pub use playlist::{Playlist, RollingWindow, Segment, parse_playlist};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    #[serde(rename = "youtube")]
    YouTube,
    Douyin,
    #[serde(rename = "tiktok")]
    TikTok,
}
impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::YouTube => "youtube",
            Self::Douyin => "douyin",
            Self::TikTok => "tiktok",
        }
    }
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "youtube" => Ok(Self::YouTube),
            "douyin" => Ok(Self::Douyin),
            "tiktok" => Ok(Self::TikTok),
            _ => Err(Error::InvalidResource),
        }
    }
    pub fn referer(self) -> &'static str {
        match self {
            Self::YouTube => "https://www.youtube.com/",
            Self::Douyin => "https://live.douyin.com/",
            Self::TikTok => "https://www.tiktok.com/",
        }
    }
    fn short(self) -> Result<short_video::Platform> {
        match self {
            Self::Douyin => Ok(short_video::Platform::Douyin),
            Self::TikTok => Ok(short_video::Platform::TikTok),
            _ => Err(Error::InvalidResource),
        }
    }
}
fn decimal(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('0')
        && s.len() <= 20
        && s.bytes().all(|b| b.is_ascii_digit())
        && s.parse::<u64>().is_ok()
}
fn yt(s: &str) -> bool {
    s.len() == 11
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn handle(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 24
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.'))
        && s != "."
        && s != ".."
}
fn invalid() -> Error {
    Error::InvalidResponse("other_live_identity")
}
fn strict_url(s: &str) -> Result<Url> {
    if s.is_empty()
        || s.len() > 8192
        || !s.is_ascii()
        || s.bytes().any(|b| b <= b' ' || b == 127 || b == b'\\')
        || s.contains('#')
    {
        return Err(Error::InvalidResource);
    }
    let mut escapes = s.as_bytes().iter().copied();
    while let Some(b) = escapes.next() {
        if b == b'%'
            && (!escapes.next().is_some_and(|b| b.is_ascii_hexdigit())
                || !escapes.next().is_some_and(|b| b.is_ascii_hexdigit()))
        {
            return Err(Error::InvalidResource);
        }
    }
    let u = Url::parse(s).map_err(|_| Error::InvalidResource)?;
    let host = u.host_str().ok_or(Error::InvalidResource)?;
    if u.scheme() != "https"
        || u.port().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || s != format!(
            "https://{host}{}{}",
            u.path(),
            u.query().map(|q| format!("?{q}")).unwrap_or_default()
        )
        || u.path().split('/').any(|p| matches!(p, "." | ".."))
    {
        return Err(Error::InvalidResource);
    }
    Ok(u)
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Resource {
    #[serde(rename = "youtube")]
    YouTube {
        id: String,
    },
    Douyin {
        web_rid: String,
    },
    #[serde(rename = "tiktok_room")]
    TikTokRoom {
        room_id: String,
    },
    #[serde(rename = "tiktok_handle")]
    TikTokHandle {
        handle: String,
    },
}
impl Resource {
    pub fn provider(&self) -> Provider {
        match self {
            Self::YouTube { .. } => Provider::YouTube,
            Self::Douyin { .. } => Provider::Douyin,
            _ => Provider::TikTok,
        }
    }
    pub fn canonical(&self) -> String {
        match self {
            Self::YouTube { id } => format!("https://www.youtube.com/live/{id}"),
            Self::Douyin { web_rid } => format!("https://live.douyin.com/{web_rid}"),
            Self::TikTokRoom { room_id } => format!("https://m.tiktok.com/share/live/{room_id}"),
            Self::TikTokHandle { handle } => format!("https://www.tiktok.com/@{handle}/live"),
        }
    }
    pub fn validate(&self) -> Result<()> {
        if parse_resource(self.provider(), &self.canonical())? != *self {
            return Err(invalid());
        }
        Ok(())
    }
}
pub fn parse_resource(provider: Provider, s: &str) -> Result<Resource> {
    let u = strict_url(s)?;
    if u.query().is_some() {
        return Err(Error::InvalidResource);
    }
    let path = u.path().strip_suffix('/').unwrap_or(u.path());
    match provider {
        Provider::YouTube
            if matches!(
                u.host_str(),
                Some("www.youtube.com" | "youtube.com" | "m.youtube.com")
            ) =>
        {
            let id = path
                .strip_prefix("/live/")
                .filter(|s| yt(s))
                .ok_or(Error::InvalidResource)?;
            Ok(Resource::YouTube { id: id.into() })
        }
        Provider::Douyin if u.host_str() == Some("live.douyin.com") => {
            let id = path
                .strip_prefix('/')
                .filter(|s| decimal(s))
                .ok_or(Error::InvalidResource)?;
            Ok(Resource::Douyin { web_rid: id.into() })
        }
        Provider::TikTok if u.host_str() == Some("m.tiktok.com") => {
            let id = path
                .strip_prefix("/share/live/")
                .filter(|s| decimal(s))
                .ok_or(Error::InvalidResource)?;
            Ok(Resource::TikTokRoom { room_id: id.into() })
        }
        Provider::TikTok if u.host_str() == Some("www.tiktok.com") => {
            let name = path
                .strip_prefix("/@")
                .and_then(|s| s.strip_suffix("/live"))
                .filter(|s| handle(s))
                .ok_or(Error::InvalidResource)?;
            Ok(Resource::TikTokHandle {
                handle: name.into(),
            })
        }
        _ => Err(Error::InvalidResource),
    }
}
/// Source-observed immutable broadcast. The full ID is hashed, never truncated.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub provider: Provider,
    pub resource: Resource,
    pub resource_id: String,
    pub broadcaster_id: String,
    pub started_at: u64,
    pub broadcast_id: String,
    pub title: String,
}
impl Metadata {
    pub fn canonical(&self) -> String {
        self.resource.canonical()
    }
    pub fn content_id(&self) -> String {
        format!("live:{}:{}", self.provider.as_str(), self.broadcast_id)
    }
    pub fn validate(&self) -> Result<()> {
        self.resource.validate()?;
        if self.provider != self.resource.provider()
            || !(946684800..=4102444800).contains(&self.started_at)
            || self.title.is_empty()
            || self.title.len() > 4096
            || self.title.chars().any(char::is_control)
            || self.broadcast_id
                != broadcast_id(
                    self.provider,
                    &self.resource_id,
                    &self.broadcaster_id,
                    self.started_at,
                )
        {
            return Err(invalid());
        }
        match self.provider {
            Provider::YouTube
                if !yt(&self.resource_id)
                    || self.broadcaster_id.len() != 24
                    || !self.broadcaster_id.starts_with("UC")
                    || !self
                        .broadcaster_id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')) =>
            {
                return Err(invalid());
            }
            Provider::Douyin | Provider::TikTok
                if !decimal(&self.resource_id) || !decimal(&self.broadcaster_id) =>
            {
                return Err(invalid());
            }
            _ => {}
        }
        match &self.resource {
            Resource::YouTube { id } if id != &self.resource_id => return Err(invalid()),
            Resource::TikTokRoom { room_id } if room_id != &self.resource_id => {
                return Err(invalid());
            }
            _ => {}
        }
        Ok(())
    }
}
pub fn broadcast_id(p: Provider, resource: &str, broadcaster: &str, start: u64) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            format!(
                "rainsync-other-live-v1\0{}\0{resource}\0{broadcaster}\0{start}",
                p.as_str()
            )
            .as_bytes()
        )
    )
}
#[derive(Clone)]
pub struct Resolved {
    pub metadata: Metadata,
    pub playlist_url: String,
    pub expires_at: Option<u64>,
    proof: Metadata,
}
impl fmt::Debug for Resolved {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OtherLiveResolved")
            .field("metadata", &self.metadata)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}
impl Resolved {
    pub fn validate(&self) -> Result<()> {
        self.metadata.validate()?;
        if self.metadata != self.proof {
            return Err(invalid());
        }
        validate_playlist_url(self.metadata.provider, &self.playlist_url)?;
        Ok(())
    }
}
fn mint(
    resource: &Resource,
    id: String,
    owner: String,
    start: u64,
    title: String,
    url: String,
    now: u64,
) -> Result<Resolved> {
    let provider = resource.provider();
    let metadata = Metadata {
        provider,
        resource: resource.clone(),
        broadcast_id: broadcast_id(provider, &id, &owner, start),
        resource_id: id,
        broadcaster_id: owner,
        started_at: start,
        title,
    };
    metadata.validate()?;
    if start > now.saturating_add(60) {
        return Err(invalid());
    }
    let checked = validate_playlist_url(provider, &url)?;
    let expires_at = expiry(&checked, now)?;
    let r = Resolved {
        proof: metadata.clone(),
        metadata,
        playlist_url: url,
        expires_at,
    };
    r.validate()?;
    Ok(r)
}
fn id(v: &Value) -> Result<String> {
    match v {
        Value::String(s) if decimal(s) => Ok(s.clone()),
        Value::Number(n) if n.as_u64().is_some_and(|v| v > 0) => Ok(n.to_string()),
        _ => Err(invalid()),
    }
}
fn label(v: &Value) -> Result<String> {
    v.as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(invalid)
}
fn deny(v: &Value, depth: usize) -> Result<()> {
    if depth > 64 {
        return Err(Error::TooLarge);
    }
    match v {
        Value::Object(map) => {
            for (k, v) in map {
                if matches!(
                    k.as_str(),
                    "is_gated_room"
                        | "is_paid_event"
                        | "is_private"
                        | "is_age_restricted"
                        | "is_blocked"
                        | "has_drm"
                        | "drm"
                ) && v != &Value::Bool(false)
                    && v != &serde_json::json!(0)
                    && v != &Value::Null
                {
                    return Err(Error::Restricted("other_live_access_denied"));
                }
                if matches!(k.as_str(), "license_url" | "drm_license_url" | "encryption")
                    && !v.is_null()
                {
                    return Err(Error::Restricted("other_live_protection_denied"));
                }
                deny(v, depth + 1)?;
            }
        }
        Value::Array(a) => {
            for v in a {
                deny(v, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Endpoint {
    DouyinRoom,
    TikTokRoom,
    TikTokPage,
}
pub struct Request {
    endpoint: Endpoint,
    url: Url,
    resource: Resource,
    credential: Option<short_video::Credential>,
}
impl fmt::Debug for Request {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OtherLiveRequest")
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
        self.resource.provider()
    }
    pub fn credential(&self) -> Option<&short_video::Credential> {
        self.credential.as_ref()
    }
    pub fn validate(&self) -> Result<()> {
        let expected = request(&self.resource, self.credential.as_ref())?;
        if expected.url != self.url || expected.endpoint != self.endpoint {
            return Err(invalid());
        }
        Ok(())
    }
}
fn request(resource: &Resource, credential: Option<&short_video::Credential>) -> Result<Request> {
    resource.validate()?;
    if let Some(c) = credential
        && c.platform() != resource.provider().short()?
    {
        return Err(Error::Restricted("other_live_credential_scope"));
    }
    let (endpoint, url) = match resource {
        Resource::Douyin { web_rid } => {
            let mut u = Url::parse("https://live.douyin.com/webcast/room/web/enter/").unwrap();
            u.query_pairs_mut().extend_pairs([
                ("web_rid", web_rid.as_str()),
                ("app_name", "douyin_web"),
                ("live_id", "1"),
                ("device_platform", "web"),
                ("language", "zh-CN"),
                ("enter_source", ""),
                ("is_need_double_stream", "false"),
                ("cookie_enabled", "true"),
            ]);
            (Endpoint::DouyinRoom, u)
        }
        Resource::TikTokRoom { room_id } => {
            let mut u = Url::parse("https://webcast.tiktok.com/webcast/room/info").unwrap();
            u.query_pairs_mut()
                .extend_pairs([("aid", "1988"), ("room_id", room_id.as_str())]);
            (Endpoint::TikTokRoom, u)
        }
        Resource::TikTokHandle { .. } => (
            Endpoint::TikTokPage,
            Url::parse(&resource.canonical()).unwrap(),
        ),
        _ => {
            return Err(Error::Restricted(
                "other_live_youtube_configured_extractor_required",
            ));
        }
    };
    Ok(Request {
        endpoint,
        url,
        resource: resource.clone(),
        credential: credential.cloned(),
    })
}
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}
impl fmt::Debug for Response {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OtherLiveResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish()
    }
}
pub trait Transport: Send + Sync {
    fn get_other_live<'a>(
        &'a self,
        request: Request,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>>;
}
pub struct Client<T> {
    transport: T,
    credential: Option<short_video::Credential>,
}
impl<T: Transport> Client<T> {
    pub fn new(transport: T, credential: Option<short_video::Credential>) -> Self {
        Self {
            transport,
            credential,
        }
    }
    pub async fn resolve(&self, resource: &Resource, deadline: Instant) -> Result<Resolved> {
        let first = self.fetch(resource, deadline).await?;
        let room = if let Resource::TikTokHandle { handle: expected } = resource {
            let value = html_state(&first.body)?;
            let user = &value["LiveRoom"]["liveRoomUserInfo"]["user"];
            if user["uniqueId"].as_str() != Some(expected) {
                return Err(invalid());
            }
            let room_id = user["roomId"]
                .as_str()
                .filter(|s| decimal(s))
                .ok_or(Error::Restricted("other_live_user_handoff_required"))?;
            let fetched = self
                .fetch(
                    &Resource::TikTokRoom {
                        room_id: room_id.into(),
                    },
                    deadline,
                )
                .await?;
            (fetched.body, Some(room_id.to_owned()))
        } else {
            (first.body, None)
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| invalid())?
            .as_secs();
        let resolved = parse_response(resource, &room.0, now)?;
        if room
            .1
            .as_ref()
            .is_some_and(|id| id != &resolved.metadata.resource_id)
        {
            return Err(invalid());
        }
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        Ok(resolved)
    }
    async fn fetch(&self, resource: &Resource, deadline: Instant) -> Result<Response> {
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        let r = tokio::time::timeout_at(
            deadline,
            self.transport
                .get_other_live(request(resource, self.credential.as_ref())?, deadline),
        )
        .await
        .map_err(|_| Error::Deadline)??;
        if matches!(r.status, 401 | 403 | 429) {
            return Err(Error::Restricted("other_live_user_handoff_required"));
        }
        if r.status != 200 {
            return Err(Error::Status(r.status));
        }
        if r.body.len() > MAX_API_BYTES {
            return Err(Error::TooLarge);
        }
        Ok(r)
    }
}
fn html_state(bytes: &[u8]) -> Result<Value> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let markers = ["id=\"SIGI_STATE\"", "id='SIGI_STATE'"];
    let start = markers
        .iter()
        .filter_map(|m| text.find(m).map(|n| n + m.len()))
        .min()
        .ok_or(Error::Restricted("other_live_user_handoff_required"))?;
    let tail = &text[start..];
    let json = tail
        .split_once('>')
        .and_then(|(_, s)| s.split_once("</script>").map(|(a, _)| a))
        .ok_or_else(invalid)?;
    bilibili::strict_json(json.as_bytes(), MAX_API_BYTES)
}
pub fn parse_response(resource: &Resource, bytes: &[u8], now: u64) -> Result<Resolved> {
    resource.validate()?;
    let value = bilibili::strict_json(bytes, MAX_API_BYTES)?;
    deny(&value, 0)?;
    if value["status_code"].as_i64() != Some(0) {
        return Err(Error::Restricted("other_live_user_handoff_required"));
    }
    let room = match resource {
        Resource::Douyin { .. } => {
            let rooms = value["data"]["data"]
                .as_array()
                .filter(|a| a.len() == 1)
                .ok_or_else(invalid)?;
            &rooms[0]
        }
        Resource::TikTokRoom { .. } | Resource::TikTokHandle { .. } => &value["data"],
        _ => return Err(invalid()),
    };
    if room["status"].as_u64() != Some(2) {
        return Err(Error::Restricted("live_not_broadcasting"));
    }
    let resource_id = id(&room["id_str"])?;
    let owner = id(&room["owner"]["id_str"])?;
    if let Resource::TikTokHandle { handle } = resource
        && room["owner"]["display_id"].as_str() != Some(handle)
    {
        return Err(invalid());
    }
    if let Resource::Douyin { web_rid } = resource
        && let Some(v) = room.get("web_rid")
        && id(v)? != *web_rid
    {
        return Err(invalid());
    }
    let started_at = room["create_time"].as_u64().ok_or_else(invalid)?;
    let stream = &room["stream_url"];
    let params = stream["hls_pull_url_params"]
        .as_str()
        .ok_or(Error::Restricted("other_live_codec_unverified"))?;
    let params = bilibili::strict_json(params.as_bytes(), 16 * 1024)?;
    if !matches!(params["VCodec"].as_str(), Some("h264" | "avc")) {
        return Err(Error::Restricted("other_live_codec_unsupported"));
    }
    let canonical_room = if matches!(resource, Resource::TikTokHandle { .. }) {
        Some(Resource::TikTokRoom {
            room_id: resource_id.clone(),
        })
    } else {
        None
    };
    mint(
        canonical_room.as_ref().unwrap_or(resource),
        resource_id,
        owner,
        started_at,
        label(&room["title"])?,
        label(&stream["hls_pull_url"])?,
        now,
    )
}
/// Trusted yt-dlp simulated live metadata. Exact public broadcast, clear HLS.
/// No JSON cookie/header, format list fallback or extracted script is accepted.
pub fn parse_youtube_response(resource: &Resource, bytes: &[u8], now: u64) -> Result<Resolved> {
    let Resource::YouTube { id: requested } = resource else {
        return Err(invalid());
    };
    let v = bilibili::strict_json(bytes, MAX_API_BYTES)?;
    deny(&v, 0)?;
    if matches!(
        v["live_status"].as_str(),
        Some("post_live" | "was_live" | "not_live")
    ) || v["is_live"].as_bool() == Some(false)
    {
        return Err(Error::Restricted("live_not_broadcasting"));
    }
    if !matches!(v.get("_type").and_then(Value::as_str), None | Some("video"))
        || v["extractor_key"].as_str() != Some("Youtube")
        || v["id"].as_str() != Some(requested)
        || v["live_status"].as_str() != Some("is_live")
        || v["is_live"].as_bool() != Some(true)
        || v["availability"].as_str() != Some("public")
        || v["age_limit"].as_u64() != Some(0)
        || v["protocol"].as_str() != Some("m3u8_native")
        || !v["vcodec"].as_str().is_some_and(|s| s.starts_with("avc1."))
        || v["acodec"].as_str() != Some("mp4a.40.2")
        || v.get("requested_formats").is_some()
        || v.get("requested_downloads").is_some()
    {
        return Err(Error::Restricted("other_live_youtube_clear_hls_required"));
    }
    mint(
        resource,
        requested.clone(),
        label(&v["channel_id"])?,
        v["release_timestamp"].as_u64().ok_or_else(invalid)?,
        label(&v["title"])?,
        label(&v["url"])?,
        now,
    )
}
fn domain(host: &str, root: &str) -> bool {
    host != root
        && host
            .strip_suffix(root)
            .is_some_and(|prefix| prefix.ends_with('.'))
}
pub fn validate_media_url(provider: Provider, value: &str) -> Result<Url> {
    let u = strict_url(value)?;
    let h = u.host_str().ok_or_else(invalid)?;
    let allowed = match provider {
        Provider::YouTube => domain(h, "googlevideo.com"),
        Provider::Douyin => domain(h, "douyincdn.com") || h == "pull-hls-f5.flive.lf.bytedance.com",
        Provider::TikTok => {
            domain(h, "tiktokcdn.com")
                || domain(h, "tiktokcdn-us.com")
                || domain(h, "tiktokcdn-eu.com")
        }
    };
    if !allowed || u.path().contains("//") {
        return Err(Error::Restricted("other_live_media_origin_denied"));
    }
    match provider {
        Provider::YouTube
            if !u.path().starts_with("/api/manifest/")
                && !u.path().starts_with("/videoplayback/")
                && !u.path().starts_with("/videoplayback") =>
        {
            return Err(Error::Restricted("other_live_media_path_denied"));
        }
        Provider::Douyin | Provider::TikTok
            if !u.path().starts_with("/stage/")
                && !u.path().starts_with("/live/")
                && !u.path().starts_with("/third/") =>
        {
            return Err(Error::Restricted("other_live_media_path_denied"));
        }
        _ => {}
    }
    Ok(u)
}
pub fn validate_playlist_url(provider: Provider, value: &str) -> Result<Url> {
    let u = validate_media_url(provider, value)?;
    if !u.path().ends_with(".m3u8") {
        return Err(Error::Restricted("other_live_playlist_path_denied"));
    }
    Ok(u)
}
pub fn validate_segment_url(provider: Provider, value: &str) -> Result<Url> {
    let u = validate_media_url(provider, value)?;
    if !u.path().ends_with(".ts") {
        return Err(Error::Restricted("other_live_segment_path_denied"));
    }
    Ok(u)
}
pub fn expiry(url: &Url, now: u64) -> Result<Option<u64>> {
    let mut expiry = None;
    for (k, v) in url.query_pairs() {
        if matches!(k.as_ref(), "expire" | "expires") {
            if expiry.is_some() {
                return Err(invalid());
            }
            expiry = Some(v.parse::<u64>().map_err(|_| invalid())?);
        }
    }
    {
        let parts = url.path().split('/').collect::<Vec<_>>();
        for pair in parts.windows(2) {
            if pair[0] == "expire" {
                if expiry.is_some() {
                    return Err(invalid());
                }
                expiry = Some(pair[1].parse::<u64>().map_err(|_| invalid())?);
            }
        }
    }
    if expiry.is_some_and(|e| e <= now || e > now.saturating_add(86400)) {
        return Err(Error::Restricted("live_url_expired"));
    }
    Ok(expiry)
}

#[cfg(test)]
mod tests;
