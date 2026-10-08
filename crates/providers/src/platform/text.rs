//! Closed platform text boundary. Metadata/URLs are server-only; only sanitized
//! cues and labels may be serialized. Provenance (extractor implementations):
//! https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py
//! https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py
//! Programs are bounded source data for the isolated, finite client interpreter.
//! Remote styles, markup execution and comment publication remain unavailable.
mod advanced;
pub mod live;
mod positioned;
mod protobuf;
mod timed_text;
use super::bilibili::{self, Cookie};
pub use advanced::{DanmakuInteraction, DanmakuProgram};
pub use protobuf::{
    bounded_danmaku, legacy_danmaku, parse_bilibili_segment, parse_bilibili_special,
    parse_bilibili_view,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{fmt, future::Future, pin::Pin};
pub use timed_text::parse_timed_text;
use tokio::time::Instant;

pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_TRACKS: usize = 64;
pub const MAX_CUES: usize = 20_000;
pub const MAX_CUE_TEXT: usize = 2_000;
const MAX_TIME_MS: u64 = 604_800_000;
pub type Result<T> = std::result::Result<T, bilibili::Error>;
fn invalid() -> bilibili::Error {
    bilibili::Error::InvalidResponse("platform_text")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Endpoint {
    BilibiliPlayer,
    BilibiliSubtitle,
    BilibiliDanmaku,
    BilibiliSegment,
    BilibiliDanmakuView,
    BilibiliDanmakuSpecial,
    BilibiliLiveHistory,
    BilibiliLiveInfo,
    BilibiliClientId,
    DouyinCaption,
    TikTokCaption,
    YoutubeCaption,
}
pub struct TextRequest {
    endpoint: Endpoint,
    url: Url,
    cookie: Option<Cookie>,
    content_id: Option<String>,
    client_id: Option<live::ClientId>,
}
impl fmt::Debug for TextRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TextRequest")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}
impl TextRequest {
    pub fn bilibili_danmaku_view(cid: u64) -> Result<Self> {
        if cid == 0 {
            return Err(invalid());
        }
        let mut url = Url::parse("https://api.bilibili.com/x/v2/dm/web/view").unwrap();
        url.query_pairs_mut()
            .append_pair("type", "1")
            .append_pair("oid", &cid.to_string());
        Ok(Self {
            endpoint: Endpoint::BilibiliDanmakuView,
            url,
            cookie: None,
            content_id: None,
            client_id: None,
        })
    }
    pub fn bilibili_danmaku_special(raw: &str) -> Result<Self> {
        let url = validate_text_url(Endpoint::BilibiliDanmakuSpecial, raw, None)?;
        Ok(Self {
            endpoint: Endpoint::BilibiliDanmakuSpecial,
            url,
            cookie: None,
            content_id: None,
            client_id: None,
        })
    }
    pub fn bilibili_player(bvid: &str, cid: u64, cookie: Option<&Cookie>) -> Result<Self> {
        if cid == 0
            || !matches!(bilibili::parse_resource(bvid)?.id, bilibili::VideoId::Bv(ref id) if id == bvid)
        {
            return Err(invalid());
        }
        let mut url = Url::parse("https://api.bilibili.com/x/player/wbi/v2").unwrap();
        url.query_pairs_mut()
            .append_pair("bvid", bvid)
            .append_pair("cid", &cid.to_string());
        Ok(Self {
            endpoint: Endpoint::BilibiliPlayer,
            url,
            cookie: cookie.cloned(),
            content_id: None,
            client_id: None,
        })
    }
    /// PGC/course captions retain their episode/season and aid/cid axes. The
    /// caller first proves these axes against the immutable playback grant.
    pub fn bilibili_episode_player(
        aid: u64,
        cid: u64,
        episode: Option<(u64, u64)>,
        cookie: Option<&Cookie>,
    ) -> Result<Self> {
        if aid == 0 || cid == 0 || episode.is_some_and(|(ep, season)| ep == 0 || season == 0) {
            return Err(invalid());
        }
        let mut url = Url::parse("https://api.bilibili.com/x/player/v2").unwrap();
        url.query_pairs_mut()
            .append_pair("aid", &aid.to_string())
            .append_pair("cid", &cid.to_string());
        if let Some((ep, season)) = episode {
            url.query_pairs_mut()
                .append_pair("ep_id", &ep.to_string())
                .append_pair("season_id", &season.to_string());
        }
        Ok(Self {
            endpoint: Endpoint::BilibiliPlayer,
            url,
            cookie: cookie.cloned(),
            content_id: None,
            client_id: None,
        })
    }
    /// Six-minute protobuf package; never an arbitrary address or credential CDN.
    pub fn bilibili_segment(cid: u64, segment: u32) -> Result<Self> {
        if cid == 0 || !(1..=1680).contains(&segment) {
            return Err(invalid());
        }
        let mut url = Url::parse("https://api.bilibili.com/x/v2/dm/web/seg.so").unwrap();
        url.query_pairs_mut()
            .append_pair("type", "1")
            .append_pair("oid", &cid.to_string())
            .append_pair("segment_index", &segment.to_string());
        Ok(Self {
            endpoint: Endpoint::BilibiliSegment,
            url,
            cookie: None,
            content_id: None,
            client_id: None,
        })
    }
    /// Public recent-history polling, not a websocket/full live chat feed.
    pub fn bilibili_live_history(room: u64) -> Result<Self> {
        if room == 0 {
            return Err(invalid());
        }
        let mut url =
            Url::parse("https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory").unwrap();
        url.query_pairs_mut()
            .append_pair("roomid", &room.to_string());
        Ok(Self {
            endpoint: Endpoint::BilibiliLiveHistory,
            url,
            cookie: None,
            content_id: None,
            client_id: None,
        })
    }
    pub fn bilibili_live_info(
        room: u64,
        keys: &bilibili::WbiKeys,
        now: u64,
        cookie: Option<&Cookie>,
        client_id: &live::ClientId,
    ) -> Result<Self> {
        let pairs = bilibili::signed_live_danmaku_query(room, keys, now)?;
        let mut url =
            Url::parse("https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo")
                .unwrap();
        url.query_pairs_mut()
            .extend_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        Ok(Self {
            endpoint: Endpoint::BilibiliLiveInfo,
            url,
            cookie: cookie.cloned(),
            content_id: None,
            client_id: Some(client_id.clone()),
        })
    }
    /// Only called after the runtime user expressly consents to issue a
    /// transient client ID. It is neither synthesized nor persisted.
    pub fn bilibili_client_id() -> Self {
        Self {
            endpoint: Endpoint::BilibiliClientId,
            url: Url::parse("https://api.bilibili.com/x/frontend/finger/spi").unwrap(),
            cookie: None,
            content_id: None,
            client_id: None,
        }
    }
    pub fn bilibili_danmaku(cid: u64) -> Result<Self> {
        if cid == 0 {
            return Err(invalid());
        }
        Ok(Self {
            endpoint: Endpoint::BilibiliDanmaku,
            url: Url::parse(&format!("https://comment.bilibili.com/{cid}.xml")).unwrap(),
            cookie: None,
            content_id: None,
            client_id: None,
        })
    }
    pub fn subtitle(descriptor: &SubtitleDescriptor) -> Result<Self> {
        let endpoint = match descriptor.format {
            SubtitleFormat::BilibiliJson => Endpoint::BilibiliSubtitle,
            SubtitleFormat::YoutubeJson3 => Endpoint::YoutubeCaption,
            SubtitleFormat::ByteDanceVtt
            | SubtitleFormat::ByteDanceSrt
            | SubtitleFormat::ByteDanceJson => {
                if descriptor.track.id.starts_with("dy") {
                    Endpoint::DouyinCaption
                } else if descriptor.track.id.starts_with("tt") {
                    Endpoint::TikTokCaption
                } else {
                    return Err(invalid());
                }
            }
        };
        let url = validate_text_url(endpoint, &descriptor.url, Some(&descriptor.content_id))?;
        Ok(Self {
            endpoint,
            url,
            cookie: None,
            content_id: Some(descriptor.content_id.clone()),
            client_id: None,
        })
    }
    /// Runtime-only issued ID; only getDanmuInfo may receive this cookie.
    pub fn client_id(&self) -> Option<&live::ClientId> {
        self.client_id.as_ref()
    }
    pub fn content_id(&self) -> Option<&str> {
        self.content_id.as_deref()
    }
    pub fn endpoint(&self) -> Endpoint {
        self.endpoint
    }
    pub fn url(&self) -> &Url {
        &self.url
    }
    /// Transport-only. Credentials are never permitted on caption/danmaku CDNs.
    pub fn cookie(&self) -> Option<&Cookie> {
        self.cookie.as_ref()
    }
    pub fn max_response_bytes(&self) -> usize {
        MAX_TEXT_BYTES
    }
}

/// Exact text origins and path shapes, never the broad media-CDN policy.
pub fn validate_text_url(endpoint: Endpoint, raw: &str, content: Option<&str>) -> Result<Url> {
    if raw.is_empty()
        || raw.len() > 16 * 1024
        || !raw.is_ascii()
        || raw.bytes().any(|b| b <= b' ' || b == 127 || b == b'\\')
        || raw.contains('#')
    {
        return Err(invalid());
    }
    let authority = raw
        .strip_prefix("https://")
        .and_then(|s| s.split(['/', '?']).next())
        .ok_or_else(invalid)?;
    if authority.contains([':', '@', '%'])
        || raw
            .split('?')
            .next()
            .is_some_and(|path| path.split('/').any(|s| matches!(s, "." | "..")))
    {
        return Err(invalid());
    }
    let url = Url::parse(raw).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.path().contains('%')
    {
        return Err(invalid());
    }
    let host = url.host_str().ok_or_else(invalid)?;
    let valid = match endpoint {
        Endpoint::BilibiliDanmakuView => {
            let pairs: Vec<_> = url.query_pairs().collect();
            host == "api.bilibili.com"
                && url.path() == "/x/v2/dm/web/view"
                && pairs.len() == 2
                && pairs[0] == ("type".into(), "1".into())
                && pairs[1].0 == "oid"
                && decimal(&pairs[1].1)
        }
        Endpoint::BilibiliDanmakuSpecial => {
            matches!(host, "i0.hdslb.com" | "i1.hdslb.com" | "i2.hdslb.com")
                && url.query().is_none()
                && url
                    .path()
                    .strip_prefix("/bfs/dm/")
                    .and_then(|s| s.strip_suffix(".bin"))
                    .is_some_and(|s| {
                        !s.is_empty()
                            && s.len() <= 128
                            && s.bytes()
                                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                    })
        }
        Endpoint::BilibiliPlayer => {
            let pairs: Vec<_> = url.query_pairs().collect();
            host == "api.bilibili.com" && matches!(url.path(), "/x/player/wbi/v2" | "/x/player/v2")
                && matches!(pairs.len(), 2 | 4)
                && ((pairs[0].0 == "bvid" && bilibili::parse_resource(&pairs[0].1).is_ok_and(|r| matches!(r.id, bilibili::VideoId::Bv(ref id) if id == pairs[0].1.as_ref()))) || (pairs[0].0 == "aid" && decimal(&pairs[0].1)))
                && pairs[1].0 == "cid" && decimal(&pairs[1].1)
                && (pairs.len() == 2 || (pairs[0].0 == "aid" && pairs[2].0 == "ep_id" && decimal(&pairs[2].1) && pairs[3].0 == "season_id" && decimal(&pairs[3].1)))
        }
        Endpoint::BilibiliSegment => {
            let pairs: Vec<_> = url.query_pairs().collect();
            host == "api.bilibili.com"
                && url.path() == "/x/v2/dm/web/seg.so"
                && pairs.len() == 3
                && pairs[0] == ("type".into(), "1".into())
                && pairs[1].0 == "oid"
                && decimal(&pairs[1].1)
                && pairs[2].0 == "segment_index"
                && pairs[2]
                    .1
                    .parse::<u32>()
                    .is_ok_and(|n| (1..=1680).contains(&n))
                && decimal(&pairs[2].1)
        }
        Endpoint::BilibiliLiveHistory => {
            let pairs: Vec<_> = url.query_pairs().collect();
            host == "api.live.bilibili.com"
                && url.path() == "/xlive/web-room/v1/dM/gethistory"
                && pairs.len() == 1
                && pairs[0].0 == "roomid"
                && decimal(&pairs[0].1)
        }
        Endpoint::BilibiliClientId => {
            host == "api.bilibili.com"
                && url.path() == "/x/frontend/finger/spi"
                && url.query().is_none()
        }
        Endpoint::BilibiliLiveInfo => {
            let pairs = url.query_pairs().collect::<Vec<_>>();
            host == "api.live.bilibili.com"
                && url.path() == "/xlive/web-room/v1/index/getDanmuInfo"
                && pairs.len() == 5
                && pairs[0].0 == "id"
                && decimal(&pairs[0].1)
                && pairs[1].0 == "type"
                && pairs[1].1 == "0"
                && pairs[2].0 == "web_location"
                && pairs[2].1 == "444.8"
                && pairs[3].0 == "wts"
                && decimal(&pairs[3].1)
                && pairs[4].0 == "w_rid"
                && pairs[4].1.len() == 32
                && pairs[4]
                    .1
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        }
        Endpoint::DouyinCaption | Endpoint::TikTokCaption => {
            // Descriptor-owned caption CDN only, narrowed to text extensions.
            // Media host validation pins public DNS; credentials are forbidden.
            let provider = if endpoint == Endpoint::DouyinCaption {
                "douyin"
            } else {
                "tiktok"
            };
            super::http::validate_media_url_for(provider, raw).is_ok()
                && !url.path().contains("//")
                && [".vtt", ".srt", ".json"]
                    .iter()
                    .any(|ext| url.path().ends_with(ext))
                && content.is_some_and(decimal)
        }
        Endpoint::BilibiliSubtitle => {
            matches!(
                host,
                "aisubtitle.hdslb.com" | "i0.hdslb.com" | "i1.hdslb.com" | "i2.hdslb.com"
            ) && {
                let name = url
                    .path()
                    .strip_prefix("/bfs/subtitle/")
                    .and_then(|s| s.strip_suffix(".json"));
                name.is_some_and(|s| {
                    !s.is_empty()
                        && s.len() <= 128
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                })
            }
        }
        Endpoint::BilibiliDanmaku => {
            host == "comment.bilibili.com"
                && url.query().is_none()
                && url
                    .path()
                    .strip_prefix('/')
                    .and_then(|s| s.strip_suffix(".xml"))
                    .is_some_and(decimal)
        }
        Endpoint::YoutubeCaption => {
            matches!(host, "www.youtube.com" | "youtube.com") && url.path() == "/api/timedtext" && {
                let mut seen = std::collections::HashSet::new();
                let mut video = None;
                let mut format = None;
                let mut valid = true;
                for (name, value) in url.query_pairs() {
                    if name.len() > 64
                        || value.len() > 4096
                        || !seen.insert(name.to_string())
                        || value.chars().any(char::is_control)
                    {
                        valid = false;
                    }
                    if name == "v" {
                        video = Some(value.to_string());
                    }
                    if name == "fmt" {
                        format = Some(value.to_string());
                    }
                }
                valid
                    && video.as_deref() == content
                    && format.as_deref() == Some("json3")
                    && content.is_some()
            }
        }
    };
    if !valid {
        return Err(invalid());
    }
    Ok(url)
}
fn decimal(s: &str) -> bool {
    !s.starts_with('0')
        && !s.is_empty()
        && s.bytes().all(|b| b.is_ascii_digit())
        && s.parse::<u64>().is_ok()
}
pub struct TextResponse {
    pub status: u16,
    pub body: Vec<u8>,
}
impl fmt::Debug for TextResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TextResponse")
            .field("status", &self.status)
            .field("bytes", &self.body.len())
            .finish()
    }
}
pub trait Transport: Send + Sync {
    fn get_text<'a>(
        &'a self,
        request: TextRequest,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<TextResponse>> + Send + 'a>>;
}
pub async fn fetch(
    transport: &impl Transport,
    request: TextRequest,
    deadline: Instant,
) -> Result<Vec<u8>> {
    if Instant::now() >= deadline {
        return Err(bilibili::Error::Deadline);
    }
    let response = tokio::time::timeout_at(deadline, transport.get_text(request, deadline))
        .await
        .map_err(|_| bilibili::Error::Deadline)??;
    if response.status != 200 {
        return Err(bilibili::Error::Status(response.status));
    }
    if response.body.len() > MAX_TEXT_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    Ok(response.body)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubtitleFormat {
    BilibiliJson,
    YoutubeJson3,
    ByteDanceVtt,
    ByteDanceSrt,
    ByteDanceJson,
}
#[derive(Clone)]
pub struct SubtitleDescriptor {
    pub track: SubtitleTrack,
    pub content_id: String,
    pub url: String,
    pub format: SubtitleFormat,
}
impl fmt::Debug for SubtitleDescriptor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SubtitleDescriptor")
            .field("track", &self.track)
            .field("format", &self.format)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SubtitleTrack {
    pub id: String,
    pub language: String,
    pub label: String,
    pub automatic: bool,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,
    None,
    LoginRequired,
    Unsupported,
}
pub struct Catalog {
    pub tracks: Vec<SubtitleDescriptor>,
    pub status: Availability,
}
pub fn language(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
pub fn plain_text(value: &str, max: usize) -> String {
    value
        .chars()
        .filter_map(|c| {
            if matches!(c, '\n' | '\r' | '\t') {
                Some(' ')
            } else if c.is_control()
                || matches!(c,'\u{2028}'|'\u{2029}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
            {
                None
            } else {
                Some(c)
            }
        })
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}
#[derive(Deserialize)]
struct BiliEnvelope {
    code: i64,
    data: Option<BiliData>,
}
#[derive(Deserialize)]
struct BiliData {
    #[serde(default)]
    bvid: String,
    aid: Option<u64>,
    cid: u64,
    #[serde(default)]
    need_login_subtitle: bool,
    subtitle: Option<BiliSubtitles>,
}
#[derive(Deserialize)]
struct BiliSubtitles {
    #[serde(default)]
    subtitles: Vec<BiliTrack>,
}
#[derive(Deserialize)]
struct BiliTrack {
    id_str: String,
    lan: String,
    lan_doc: String,
    subtitle_url: String,
    #[serde(default)]
    ai_type: u32,
}
pub fn parse_bilibili_catalog(bytes: &[u8], bvid: &str, cid: u64) -> Result<Catalog> {
    parse_bilibili_catalog_identity(bytes, Some(bvid), None, cid, bvid)
}
pub fn parse_bilibili_episode_catalog(
    bytes: &[u8],
    aid: u64,
    cid: u64,
    content_id: &str,
) -> Result<Catalog> {
    if aid == 0 || cid == 0 || content_id.is_empty() {
        return Err(invalid());
    }
    parse_bilibili_catalog_identity(bytes, None, Some(aid), cid, content_id)
}
fn parse_bilibili_catalog_identity(
    bytes: &[u8],
    bvid: Option<&str>,
    aid: Option<u64>,
    cid: u64,
    content_id: &str,
) -> Result<Catalog> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    let envelope: BiliEnvelope = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if envelope.code != 0 {
        return Err(bilibili::Error::Api(envelope.code));
    }
    let data = envelope.data.ok_or_else(invalid)?;
    if bvid.is_some_and(|id| data.bvid != id)
        || aid.is_some_and(|id| data.aid != Some(id))
        || data.cid != cid
    {
        return Err(invalid());
    }
    let raw = data.subtitle.map(|s| s.subtitles).unwrap_or_default();
    if raw.len() > MAX_TRACKS {
        return Err(bilibili::Error::TooLarge);
    }
    let mut seen = std::collections::HashSet::new();
    let mut tracks = Vec::new();
    for raw in raw {
        if !decimal(&raw.id_str) || !language(&raw.lan) || !seen.insert(raw.id_str.clone()) {
            return Err(invalid());
        }
        let url = if raw.subtitle_url.starts_with("//") {
            format!("https:{}", raw.subtitle_url)
        } else {
            raw.subtitle_url
        };
        validate_text_url(Endpoint::BilibiliSubtitle, &url, None)?;
        let label = plain_text(&raw.lan_doc, 80);
        tracks.push(SubtitleDescriptor {
            track: SubtitleTrack {
                id: format!("b{}", raw.id_str),
                language: raw.lan.clone(),
                label: if label.is_empty() { raw.lan } else { label },
                automatic: raw.ai_type != 0,
            },
            content_id: content_id.into(),
            url,
            format: SubtitleFormat::BilibiliJson,
        });
    }
    let status = if !tracks.is_empty() {
        Availability::Available
    } else if data.need_login_subtitle {
        Availability::LoginRequired
    } else {
        Availability::None
    };
    Ok(Catalog { tracks, status })
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubtitleCue {
    pub from_ms: u64,
    pub to_ms: u64,
    pub text: String,
}
#[derive(Deserialize)]
struct BiliBody {
    body: Vec<BiliCue>,
}
#[derive(Deserialize)]
struct BiliCue {
    from: f64,
    to: f64,
    content: String,
}
#[derive(Deserialize)]
struct Json3 {
    #[serde(default)]
    events: Vec<Json3Event>,
}
#[derive(Deserialize)]
struct Json3Event {
    #[serde(rename = "tStartMs")]
    start: Option<u64>,
    #[serde(rename = "dDurationMs")]
    duration: Option<u64>,
    #[serde(default)]
    segs: Vec<Json3Segment>,
}
#[derive(Deserialize)]
struct Json3Segment {
    #[serde(rename = "utf8")]
    text: String,
}
pub fn subtitle_cues(format: SubtitleFormat, bytes: &[u8]) -> Result<Vec<SubtitleCue>> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    let mut cues = Vec::new();
    match format {
        SubtitleFormat::BilibiliJson => {
            let data: BiliBody = serde_json::from_slice(bytes).map_err(|_| invalid())?;
            if data.body.len() > MAX_CUES {
                return Err(bilibili::Error::TooLarge);
            }
            for c in data.body {
                if !c.from.is_finite()
                    || !c.to.is_finite()
                    || c.from < 0.0
                    || c.to * 1000.0 > MAX_TIME_MS as f64
                    || c.to <= c.from
                {
                    return Err(invalid());
                }
                cues.push(SubtitleCue {
                    from_ms: (c.from * 1000.0).round() as u64,
                    to_ms: (c.to * 1000.0).round() as u64,
                    text: plain_text(&c.content, MAX_CUE_TEXT),
                });
            }
        }
        SubtitleFormat::ByteDanceVtt
        | SubtitleFormat::ByteDanceSrt
        | SubtitleFormat::ByteDanceJson => return parse_timed_text(format, bytes),
        SubtitleFormat::YoutubeJson3 => {
            let data: Json3 = serde_json::from_slice(bytes).map_err(|_| invalid())?;
            if data.events.len() > MAX_CUES {
                return Err(bilibili::Error::TooLarge);
            }
            for event in data.events {
                if event.segs.is_empty() {
                    continue;
                }
                if event.segs.len() > 128 {
                    return Err(bilibili::Error::TooLarge);
                }
                let from = event.start.ok_or_else(invalid)?;
                let to = from
                    .checked_add(event.duration.ok_or_else(invalid)?)
                    .filter(|to| *to <= MAX_TIME_MS && *to > from)
                    .ok_or_else(invalid)?;
                let text = event.segs.into_iter().map(|s| s.text).collect::<String>();
                cues.push(SubtitleCue {
                    from_ms: from,
                    to_ms: to,
                    text: plain_text(&text, MAX_CUE_TEXT),
                });
            }
        }
    }
    cues.retain(|c| !c.text.is_empty() && c.to_ms > c.from_ms);
    cues.sort_by_key(|c| c.from_ms);
    Ok(cues)
}
pub fn render_vtt(cues: &[SubtitleCue]) -> Result<String> {
    if cues.len() > MAX_CUES {
        return Err(bilibili::Error::TooLarge);
    }
    fn stamp(ms: u64) -> String {
        format!(
            "{:02}:{:02}:{:02}.{:03}",
            ms / 3_600_000,
            (ms / 60_000) % 60,
            (ms / 1_000) % 60,
            ms % 1_000
        )
    }
    let mut output = String::from("WEBVTT\n\n");
    for cue in cues {
        if cue.to_ms <= cue.from_ms
            || cue.to_ms > MAX_TIME_MS
            || cue.text.chars().count() > MAX_CUE_TEXT
            || cue.text != plain_text(&cue.text, MAX_CUE_TEXT)
        {
            return Err(invalid());
        }
        let text = cue
            .text
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        output.push_str(&format!(
            "{} --> {}\n{}\n\n",
            stamp(cue.from_ms),
            stamp(cue.to_ms),
            text
        ));
        if output.len() > MAX_TEXT_BYTES {
            return Err(bilibili::Error::TooLarge);
        }
    }
    Ok(output)
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuMode {
    Scroll,
    Top,
    Bottom,
    Positioned,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DanmakuStyle {
    pub color_rgb: u32,
    pub font_size_px: u8,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DanmakuPosition {
    pub x_permyriad: u16,
    pub y_permyriad: u16,
    pub to_x_permyriad: u16,
    pub to_y_permyriad: u16,
    pub duration_ms: u32,
    pub move_duration_ms: u32,
    pub move_delay_ms: u32,
    pub opacity_from_permille: u16,
    pub opacity_to_permille: u16,
    pub rotation_z_deg: i16,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DanmakuCue {
    pub at_ms: u64,
    pub text: String,
    pub mode: DanmakuMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<DanmakuStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<DanmakuPosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced_unsupported: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<DanmakuProgram>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction: Option<DanmakuInteraction>,
}
/// An intentionally small XML subset. Never resolve entities, process a DTD,
/// retain user/style IDs, evaluate advanced/script content or render markup.
pub fn parse_bilibili_danmaku(bytes: &[u8], expected_cid: u64) -> Result<Vec<DanmakuCue>> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(bilibili::Error::TooLarge);
    }
    let mut text = std::str::from_utf8(bytes).map_err(|_| invalid())?.trim();
    if text.starts_with("<?xml ") {
        let end = text.find("?>").filter(|i| *i <= 128).ok_or_else(invalid)?;
        text = text[end + 2..].trim();
    }
    if expected_cid == 0 || text.contains("<!") || text.contains("<?") {
        return Err(invalid());
    }
    let mut rest = text
        .strip_prefix("<i>")
        .and_then(|s| s.strip_suffix("</i>"))
        .ok_or_else(invalid)?;
    let mut cues = Vec::new();
    let mut count = 0;
    let mut metadata = std::collections::HashSet::new();
    let mut seen_cid = false;
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        if !rest.starts_with("<d ") {
            if !rest.starts_with('<') {
                return Err(invalid());
            }
            let tag_end = rest.find('>').filter(|n| *n <= 32).ok_or_else(invalid)?;
            let tag = rest[1..tag_end].to_owned();
            if !matches!(
                tag.as_str(),
                "chatserver" | "chatid" | "mission" | "maxlimit" | "state" | "real_name" | "source"
            ) || !metadata.insert(tag.clone())
            {
                return Err(invalid());
            }
            let end_tag = format!("</{tag}>");
            let value_start = tag_end + 1;
            let end = rest[value_start..]
                .find(&end_tag)
                .filter(|n| *n <= 1024)
                .ok_or_else(invalid)?
                + value_start;
            let value = &rest[value_start..end];
            if value.contains(['<', '&']) {
                return Err(invalid());
            }
            if tag == "chatid" {
                if value.parse::<u64>().ok() != Some(expected_cid) {
                    return Err(invalid());
                }
                seen_cid = true
            }
            rest = &rest[end + end_tag.len()..];
            continue;
        }
        count += 1;
        if count > MAX_CUES {
            return Err(bilibili::Error::TooLarge);
        }
        rest = &rest[3..];
        let close = rest.find('>').ok_or_else(invalid)?;
        let attrs = &rest[..close];
        if attrs.len() > 512 {
            return Err(invalid());
        }
        let p = attrs
            .strip_prefix("p=\"")
            .and_then(|s| s.strip_suffix('"'))
            .ok_or_else(invalid)?;
        let mut params = p.split(',');
        let at = params
            .next()
            .ok_or_else(invalid)?
            .parse::<f64>()
            .map_err(|_| invalid())?;
        let mode = params
            .next()
            .ok_or_else(invalid)?
            .parse::<u32>()
            .map_err(|_| invalid())?;
        if !at.is_finite() || at < 0.0 || at * 1000.0 > MAX_TIME_MS as f64 {
            return Err(invalid());
        }
        rest = &rest[close + 1..];
        let end = rest.find("</d>").ok_or_else(invalid)?;
        let raw = &rest[..end];
        rest = &rest[end + 4..];
        let mut mode = match mode {
            1..=3 | 6 => DanmakuMode::Scroll,
            4 => DanmakuMode::Bottom,
            5 | 7 => DanmakuMode::Top,
            _ => continue,
        };
        if raw.contains('<') {
            return Err(invalid());
        }
        let decoded = decode_entities(raw)?;
        let (content, position, unsupported) = if params_mode_is_advanced(p) {
            positioned::parse(&decoded)?
        } else {
            (plain_text(&decoded, 160), None, false)
        };
        if position.is_some() {
            mode = DanmakuMode::Positioned;
        }
        let size = p.split(',').nth(2).and_then(|v| v.parse::<u64>().ok());
        let color = p
            .split(',')
            .nth(3)
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|n| *n <= 0xffffff);
        let style = match (size, color) {
            (Some(size), Some(color)) => Some(DanmakuStyle {
                color_rgb: color,
                font_size_px: size.clamp(12, 48) as u8,
            }),
            _ => None,
        };
        if !content.is_empty() {
            cues.push(DanmakuCue {
                at_ms: (at * 1000.0).round() as u64,
                text: content,
                mode,
                style,
                position,
                advanced_unsupported: unsupported.then_some(true),
                program: None,
                interaction: None,
            })
        }
    }
    if !seen_cid {
        return Err(invalid());
    }
    cues.sort_by_key(|c| c.at_ms);
    // Bound density to six cues per second, independent of upstream ordering.
    let mut second = None;
    let mut accepted = 0;
    cues.retain(|cue| {
        let bucket = cue.at_ms / 1000;
        if second != Some(bucket) {
            second = Some(bucket);
            accepted = 0
        }
        accepted += 1;
        accepted <= 6
    });
    Ok(cues)
}
fn params_mode_is_advanced(params: &str) -> bool {
    params.split(',').nth(1) == Some("7")
}
/// Plain text fallback for positioned mode-7. It never interprets executable fields.
fn advanced_plain_text(raw: &str) -> Result<String> {
    if raw.len() > 16 * 1024 {
        return Err(bilibili::Error::TooLarge);
    }
    let values: Vec<serde_json::Value> = serde_json::from_str(raw).map_err(|_| invalid())?;
    if !(5..=16).contains(&values.len()) {
        return Err(invalid());
    }
    let text = values[4].as_str().ok_or_else(invalid)?;
    Ok(plain_text(text, 160))
}
fn decode_entities(raw: &str) -> Result<String> {
    let mut output = String::new();
    let mut rest = raw;
    while let Some(at) = rest.find('&') {
        output.push_str(&rest[..at]);
        rest = &rest[at + 1..];
        let end = rest.find(';').filter(|i| *i <= 12).ok_or_else(invalid)?;
        let token = &rest[..end];
        let value = match token {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ => {
                let n = if let Some(hex) = token.strip_prefix("#x") {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    token.strip_prefix('#').and_then(|s| s.parse().ok())
                };
                n.and_then(char::from_u32).ok_or_else(invalid)?
            }
        };
        output.push(value);
        rest = &rest[end + 1..];
    }
    output.push_str(rest);
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn text_urls_are_closed_and_credential_free() {
        assert!(TextRequest::bilibili_player("BV1xx411c7mD", 123, None).is_ok());
        assert!(TextRequest::bilibili_player("BV1xx411c7mD?p=2", 123, None).is_err());
        for raw in [
            "https://evil.hdslb.com/bfs/subtitle/a.json",
            "https://aisubtitle.hdslb.com.evil/bfs/subtitle/a.json",
            "https://aisubtitle.hdslb.com:443/bfs/subtitle/a.json",
            "https://aisubtitle.hdslb.com/bfs/subtitle/../a.json",
            "https://aisubtitle.hdslb.com/bfs/subtitle/a%2ejson",
        ] {
            assert!(
                validate_text_url(Endpoint::BilibiliSubtitle, raw, None).is_err(),
                "{raw}"
            )
        }
        assert!(
            validate_text_url(
                Endpoint::YoutubeCaption,
                "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&fmt=json3",
                Some("dQw4w9WgXcQ")
            )
            .is_ok()
        );
        for raw in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&fmt=json3",
            "https://www.youtube.com/api/timedtext?v=other&fmt=json3",
            "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&v=dQw4w9WgXcQ&fmt=json3",
        ] {
            assert!(validate_text_url(Endpoint::YoutubeCaption, raw, Some("dQw4w9WgXcQ")).is_err())
        }
    }
    #[test]
    fn bili_catalog_keeps_metadata_and_signed_urls_separate() {
        let fixture = json!({"code":0,"data":{"bvid":"BV1xx411c7mD","cid":123,"subtitle":{"subtitles":[{"id_str":"12","lan":"zh-Hans","lan_doc":"中文","subtitle_url":"//aisubtitle.hdslb.com/bfs/subtitle/a.json?auth_key=secret","ai_type":1}]}}});
        let cat =
            parse_bilibili_catalog(&serde_json::to_vec(&fixture).unwrap(), "BV1xx411c7mD", 123)
                .unwrap();
        assert_eq!(cat.status, Availability::Available);
        assert!(
            !serde_json::to_string(&cat.tracks[0].track)
                .unwrap()
                .contains("secret")
        );
        assert!(!format!("{:?}", cat.tracks[0]).contains("secret"));
        assert!(
            parse_bilibili_catalog(&serde_json::to_vec(&fixture).unwrap(), "BV1xx411c7mD", 124)
                .is_err()
        );
        let login =
            json!({"code":0,"data":{"bvid":"BV1xx411c7mD","cid":123,"need_login_subtitle":true}});
        assert_eq!(
            parse_bilibili_catalog(&serde_json::to_vec(&login).unwrap(), "BV1xx411c7mD", 123)
                .unwrap()
                .status,
            Availability::LoginRequired
        );
    }
    #[test]
    fn episode_metadata_preserves_exact_aid_cid_and_caption_transport_has_no_cookie() {
        let cookie = Cookie::from_header("SESSDATA=fixture-session; DedeUserID=42").unwrap();
        let request =
            TextRequest::bilibili_episode_player(77, 123, Some((8, 9)), Some(&cookie)).unwrap();
        assert!(validate_text_url(request.endpoint(), request.url().as_str(), None).is_ok());
        let fixture = serde_json::json!({"code":0,"data":{"aid":77,"cid":123,"subtitle":{"subtitles":[{"id_str":"12","lan":"en","lan_doc":"English","subtitle_url":"//aisubtitle.hdslb.com/bfs/subtitle/a.json"}]}}});
        let body = serde_json::to_vec(&fixture).unwrap();
        let cat = parse_bilibili_episode_catalog(&body, 77, 123, "course:ep8").unwrap();
        assert_eq!(cat.tracks[0].content_id, "course:ep8");
        assert!(
            TextRequest::subtitle(&cat.tracks[0])
                .unwrap()
                .cookie()
                .is_none()
        );
        assert!(parse_bilibili_episode_catalog(&body, 78, 123, "course:ep8").is_err());
        assert!(parse_bilibili_episode_catalog(&body, 77, 124, "course:ep8").is_err());
        assert!(!format!("{:?}", request).contains("fixture-session"));
    }
    #[test]
    fn subtitle_conversion_has_no_markup_styles_or_invalid_timing() {
        let bytes=br#"{"body":[{"from":1.0,"to":2.25,"content":"<script>x</script>\n\nSTYLE\n::cue {color:red}"}]}"#;
        let cues = subtitle_cues(SubtitleFormat::BilibiliJson, bytes).unwrap();
        let vtt = render_vtt(&cues).unwrap();
        assert!(vtt.contains("00:00:01.000 --> 00:00:02.250"));
        assert!(vtt.contains("&lt;script&gt;"));
        assert!(!vtt.contains("\nSTYLE\n"));
        assert!(
            subtitle_cues(
                SubtitleFormat::BilibiliJson,
                br#"{"body":[{"from":-1,"to":2,"content":"x"}]}"#
            )
            .is_err()
        );
        let yt =
            br#"{"events":[{"tStartMs":1000,"dDurationMs":2000,"segs":[{"utf8":"<b>Hi</b>"}]}]}"#;
        assert!(
            render_vtt(&subtitle_cues(SubtitleFormat::YoutubeJson3, yt).unwrap())
                .unwrap()
                .contains("&lt;b&gt;")
        );
    }
    #[test]
    fn malformed_xml_text_never_slices_inside_utf8() {
        for invalid_tail in ["é>", "🙂>", "chatid>", ">", "</chatid>", "<é>1</é>", "<>"] {
            let body = format!("<i><chatid>123</chatid>{invalid_tail}</i>");
            assert!(parse_bilibili_danmaku(body.as_bytes(), 123).is_err());
        }
    }
    #[test]
    fn original_danmaku_is_plain_bounded_and_skips_script_modes() {
        let raw=br#"<?xml version="1.0" encoding="UTF-8"?><i><chatid>123</chatid><d p="1.2,1,25,16777215,0,0,user,1">&lt;img src=x&gt;</d><d p="2,8,25,0,0,0,u,2">script</d><d p="3,5,25,0,0,0,u,3">top</d></i>"#;
        let cues = parse_bilibili_danmaku(raw, 123).unwrap();
        assert!(parse_bilibili_danmaku(raw, 124).is_err());
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "<img src=x>");
        assert_eq!(cues[1].mode, DanmakuMode::Top);
        assert!(
            parse_bilibili_danmaku(
                br#"<!DOCTYPE i [<!ENTITY x SYSTEM "file:///secret">]><i/>"#,
                123
            )
            .is_err()
        );
        assert!(
            parse_bilibili_danmaku(
                br#"<i><chatid>123</chatid><d p="0,1">&unknown;</d></i>"#,
                123
            )
            .is_err()
        );
        let dense = format!(
            "<i><chatid>123</chatid>{}</i>",
            (0..20)
                .map(|n| format!("<d p=\"1.1,1,25,0,0,0,u,{n}\">x</d>"))
                .collect::<String>()
        );
        assert_eq!(
            parse_bilibili_danmaku(dense.as_bytes(), 123).unwrap().len(),
            6
        );
    }
}
