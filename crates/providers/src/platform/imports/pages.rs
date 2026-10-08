//! Explicit bounded collection pagination. One caller-requested page, no crawl.
//! Whole seasons are finite metadata snapshots, not invented upstream pages.
//! Metadata never supplies whole-episode playback rights or CDN descriptors.
use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_PAGES: u32 = 100;
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionPageRequest {
    /// Zero-based explicit UI page. No automatic loop follows `next`.
    #[serde(default)]
    pub page: u32,
    pub cursor: Option<String>,
    /// Only saved TikTok collections split their genuine 30-row API page.
    #[serde(default)]
    pub offset: u32,
    /// Required on subsequent slices of a complete PGC/course/parts snapshot.
    pub snapshot: Option<String>,
}
#[derive(Debug)]
pub struct CollectionPage {
    pub items: Vec<Reference>,
    pub next: Option<CollectionPageRequest>,
    /// Source says rows remain, even if the explicit 100-page cap stops next.
    pub has_more: bool,
    pub snapshot: Option<String>,
    /// Access-restricted episode metadata is withheld, not reclassified as UGC.
    pub omitted: usize,
}
impl CollectionPageRequest {
    fn validate(&self) -> Result<()> {
        if self.page >= MAX_PAGES
            || !matches!(self.offset, 0 | 20)
            || self.cursor.as_ref().is_some_and(|s| !cursor(s))
            || self.snapshot.as_ref().is_some_and(|s| {
                s.len() != 64
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            })
            || (self.page == 0
                && (self.cursor.is_some() || self.snapshot.is_some() || self.offset != 0))
        {
            return Err(invalid());
        }
        Ok(())
    }
}
fn cursor(s: &str) -> bool {
    s == "0" || decimal(s)
}
pub(super) fn parse_new_collection(value: &str, provider: Provider) -> Option<Result<Collection>> {
    if provider == Provider::TikTok && value.contains("/playlist/") {
        return Some(
            parse_tiktok_collection(&value.replacen("/playlist/", "/collection/", 1))
                .map(|id| Collection::TikTokPlaylist { id }),
        );
    }
    if provider == Provider::Douyin && value.contains("/collection/") {
        return Some((|| {
            let url = strict_url(value)?;
            if url.host_str() != Some("www.douyin.com") || url.query().is_some() {
                return Err(invalid());
            }
            let id = url
                .path()
                .strip_prefix("/collection/")
                .ok_or_else(invalid)?
                .strip_suffix('/')
                .unwrap_or(url.path().strip_prefix("/collection/").unwrap());
            if !decimal(id) {
                return Err(invalid());
            }
            Ok(Collection::DouyinMix { id: id.into() })
        })());
    }
    if provider != Provider::Bilibili {
        return None;
    }
    let (path, course) = if value.contains("/cheese/play/ss") {
        ("/cheese/play/ss", true)
    } else if value.contains("/bangumi/play/ss") {
        ("/bangumi/play/ss", false)
    } else {
        return None;
    };
    Some((|| {
        let url = strict_url(value)?;
        if !matches!(
            url.host_str(),
            Some("www.bilibili.com" | "bilibili.com" | "m.bilibili.com")
        ) || url.query().is_some()
        {
            return Err(invalid());
        }
        let id = url.path().strip_prefix(path).ok_or_else(invalid)?;
        let id = id.strip_suffix('/').unwrap_or(id);
        if !decimal(id) {
            return Err(invalid());
        }
        Ok(if course {
            Collection::CourseSeason { id: id.into() }
        } else {
            Collection::PgcSeason { id: id.into() }
        })
    })())
}
pub(super) fn is_page_endpoint(ep: Endpoint) -> bool {
    matches!(
        ep,
        Endpoint::TikTokPlaylist
            | Endpoint::DouyinMix
            | Endpoint::BilibiliPgcSeason
            | Endpoint::BilibiliCourseSeason
    )
}
pub(super) fn validate_request(request: &Request) -> Result<()> {
    strict_url(request.url.as_str())?;
    let expected: (&str, &str, Provider, &[&str]) = match request.endpoint {
        Endpoint::TikTokPlaylist => (
            "www.tiktok.com",
            "/api/mix/item_list/",
            Provider::TikTok,
            &["mixId", "count", "cursor"],
        ),
        Endpoint::DouyinMix => (
            "www.douyin.com",
            "/aweme/v1/web/mix/aweme/",
            Provider::Douyin,
            &[
                "device_platform",
                "aid",
                "channel",
                "mix_id",
                "cursor",
                "count",
            ],
        ),
        Endpoint::BilibiliPgcSeason => (
            "api.bilibili.com",
            "/pgc/view/web/season",
            Provider::Bilibili,
            &["season_id"],
        ),
        Endpoint::BilibiliCourseSeason => (
            "api.bilibili.com",
            "/pugv/view/web/season",
            Provider::Bilibili,
            &["season_id"],
        ),
        _ => return Err(invalid()),
    };
    let pairs = request.url.query_pairs().collect::<Vec<_>>();
    if request.url.host_str() != Some(expected.0)
        || request.url.path() != expected.1
        || request.provider != expected.2
        || pairs.len() != expected.3.len()
    {
        return Err(invalid());
    }
    for ((k, v), key) in pairs.iter().zip(expected.3) {
        if k != key
            || match *key {
                "cursor" => !cursor(v),
                "count" => v != "20",
                "device_platform" => v != "webapp",
                "aid" => v != "6383",
                "channel" => v != "channel_pc_web",
                _ => !decimal(v),
            }
        {
            return Err(invalid());
        }
    }
    if let Some(cookie) = &request.cookie {
        if request.provider != Provider::Bilibili {
            return Err(invalid());
        }
        bilibili::Cookie::from_header(cookie.expose_for_storage())?;
    }
    Ok(())
}
pub(super) fn page_request(
    collection: &Collection,
    page: &CollectionPageRequest,
    cookie: Option<&bilibili::Cookie>,
) -> Result<Request> {
    page.validate()?;
    if !matches!(collection, Collection::TikTok { .. }) && page.offset != 0 {
        return Err(invalid());
    }
    if let Collection::TikTok { id } = collection {
        if cookie.is_some()
            || !decimal(id)
            || (page.page > 0 && page.cursor.is_none())
            || (page.offset == 20 && page.snapshot.is_none())
            || (page.offset == 0 && page.snapshot.is_some())
        {
            return Err(invalid());
        }
        let cursor = page.cursor.as_deref().unwrap_or("0");
        if cursor.parse::<u64>().map_err(|_| invalid())? % 30 != 0 {
            return Err(invalid());
        }
        let mut url = tiktok_collection_url(id)?;
        let pairs = url
            .query_pairs()
            .map(|(k, v)| {
                (
                    k.clone().into_owned(),
                    if k == "cursor" {
                        cursor.to_owned()
                    } else {
                        v.into_owned()
                    },
                )
            })
            .collect::<Vec<_>>();
        url.set_query(None);
        url.query_pairs_mut().extend_pairs(pairs);
        return Ok(Request {
            endpoint: Endpoint::TikTokCollection,
            provider: Provider::TikTok,
            url,
            cookie: None,
        });
    }
    let (endpoint, base, provider, pairs) = match collection {
        Collection::PgcSeason { id } | Collection::CourseSeason { id } => {
            if !decimal(id) || page.cursor.is_some() || (page.page > 0 && page.snapshot.is_none()) {
                return Err(invalid());
            }
            let pgc = matches!(collection, Collection::PgcSeason { .. });
            (
                if pgc {
                    Endpoint::BilibiliPgcSeason
                } else {
                    Endpoint::BilibiliCourseSeason
                },
                if pgc {
                    "https://api.bilibili.com/pgc/view/web/season"
                } else {
                    "https://api.bilibili.com/pugv/view/web/season"
                },
                Provider::Bilibili,
                vec![("season_id", id.clone())],
            )
        }
        Collection::TikTokPlaylist { id } => {
            if !decimal(id)
                || page.snapshot.is_some()
                || (page.page > 0 && page.cursor.is_none())
                || cookie.is_some()
            {
                return Err(invalid());
            }
            (
                Endpoint::TikTokPlaylist,
                "https://www.tiktok.com/api/mix/item_list/",
                Provider::TikTok,
                vec![
                    ("mixId", id.clone()),
                    ("count", "20".into()),
                    ("cursor", page.cursor.clone().unwrap_or("0".into())),
                ],
            )
        }
        Collection::DouyinMix { id } => {
            if !decimal(id)
                || page.snapshot.is_some()
                || (page.page > 0 && page.cursor.is_none())
                || cookie.is_some()
            {
                return Err(invalid());
            }
            (
                Endpoint::DouyinMix,
                "https://www.douyin.com/aweme/v1/web/mix/aweme/",
                Provider::Douyin,
                vec![
                    ("device_platform", "webapp".into()),
                    ("aid", "6383".into()),
                    ("channel", "channel_pc_web".into()),
                    ("mix_id", id.clone()),
                    ("cursor", page.cursor.clone().unwrap_or("0".into())),
                    ("count", "20".into()),
                ],
            )
        }
        other => {
            if cookie.is_some()
                || page.cursor.is_some()
                || (!matches!(other, Collection::Parts(_)) && page.snapshot.is_some())
            {
                return Err(invalid());
            }
            let mut request = collection_request(other)?;
            if page.page > 0 {
                match other {
                    Collection::Season { .. } | Collection::Series { .. } => {
                        let pairs = request
                            .url
                            .query_pairs()
                            .map(|(k, v)| {
                                (
                                    k.clone().into_owned(),
                                    if matches!(k.as_ref(), "page_num" | "pn") {
                                        (page.page + 1).to_string()
                                    } else {
                                        v.into_owned()
                                    },
                                )
                            })
                            .collect::<Vec<_>>();
                        request.url.set_query(None);
                        request.url.query_pairs_mut().extend_pairs(pairs);
                    }
                    Collection::Parts(_) | Collection::TikTok { .. } => {}
                    _ => unreachable!(),
                }
            }
            return Ok(request);
        }
    };
    let mut url = Url::parse(base).expect("fixed endpoint");
    url.query_pairs_mut().extend_pairs(pairs);
    let request = Request {
        endpoint,
        url,
        provider,
        cookie: cookie.cloned(),
    };
    request.validate()?;
    Ok(request)
}
fn id(v: &Value) -> Result<String> {
    match v {
        Value::String(s) if decimal(s) => Ok(s.clone()),
        Value::Number(n) if n.as_u64().is_some_and(|n| n > 0) => Ok(n.to_string()),
        _ => Err(invalid()),
    }
}
fn snapshot(items: &[Reference]) -> String {
    let mut h = Sha256::new();
    for item in items {
        h.update(item.key());
        h.update([0]);
        if let Some(title) = &item.title {
            h.update(title);
        }
        h.update([0]);
    }
    format!("{:x}", h.finalize())
}
fn slice_snapshot(
    items: Vec<Reference>,
    page: &CollectionPageRequest,
    omitted: usize,
) -> Result<CollectionPage> {
    let stamp = snapshot(&items);
    if page.snapshot.as_ref().is_some_and(|old| old != &stamp) {
        return Err(bilibili::Error::Restricted("platform_collection_changed"));
    }
    if page.page > 0 && page.snapshot.is_none() {
        return Err(invalid());
    }
    let start = page.page as usize * MAX_ITEMS;
    if start > items.len() || (page.page > 0 && start == items.len()) {
        return Err(invalid());
    }
    let next = (start + MAX_ITEMS < items.len() && page.page + 1 < MAX_PAGES).then(|| {
        CollectionPageRequest {
            page: page.page + 1,
            offset: 0,
            cursor: None,
            snapshot: Some(stamp.clone()),
        }
    });
    let has_more = start + MAX_ITEMS < items.len();
    Ok(CollectionPage {
        has_more,
        items: items.into_iter().skip(start).take(MAX_ITEMS).collect(),
        next,
        snapshot: Some(stamp),
        omitted,
    })
}
pub fn parse_collection_page_response(
    collection: &Collection,
    page: &CollectionPageRequest,
    bytes: &[u8],
) -> Result<CollectionPage> {
    page.validate()?;
    if !matches!(collection, Collection::TikTok { .. }) && page.offset != 0 {
        return Err(invalid());
    }
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(bilibili::Error::TooLarge);
    }
    let value = bilibili::strict_json(bytes, 2 * 1024 * 1024)?;
    match collection {
        Collection::PgcSeason { id: season } | Collection::CourseSeason { id: season } => {
            let course = matches!(collection, Collection::CourseSeason { .. });
            if page.cursor.is_some() {
                return Err(invalid());
            }
            let code = value["code"].as_i64().ok_or_else(invalid)?;
            if code != 0 {
                return Err(bilibili::Error::Api(code));
            }
            let data = &value[if course { "data" } else { "result" }];
            if id(&data["season_id"])? != *season {
                return Err(invalid());
            }
            let mut episodes = data["episodes"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .collect::<Vec<_>>();
            if !course {
                if data.get("section").is_some() && data.get("sections").is_some() {
                    return Err(invalid());
                }
                if let Some(sections) = data.get("section").or_else(|| data.get("sections")) {
                    let sections = sections.as_array().ok_or_else(invalid)?;
                    if sections.len() > 100 {
                        return Err(bilibili::Error::TooLarge);
                    }
                    for section in sections {
                        episodes.extend(section["episodes"].as_array().ok_or_else(invalid)?.iter());
                    }
                }
            }
            if episodes.is_empty() || episodes.len() > 2000 {
                return Err(bilibili::Error::TooLarge);
            }
            // Validate every identity once, but run the existing entitlement-
            // aware selected metadata parser only for this explicit 20-row slice.
            // Reparsing all 2000 episodes for every row would be quadratic work.
            let stamp=format!("{:x}",Sha256::digest(serde_json::to_vec(&serde_json::json!({"season_id":season,"title":data["title"],"rights":data["rights"],"episodes":episodes})).map_err(|_|invalid())?));
            if page.snapshot.as_ref().is_some_and(|old| old != &stamp) {
                return Err(bilibili::Error::Restricted("platform_collection_changed"));
            }
            if page.page > 0 && page.snapshot.is_none() {
                return Err(invalid());
            }
            let total = episodes.len();
            let start = page.page as usize * MAX_ITEMS;
            if start > total || (page.page > 0 && start == total) {
                return Err(invalid());
            }
            let mut items = Vec::new();
            let mut seen = HashSet::new();
            let mut omitted = 0;
            for (index, episode) in episodes.into_iter().enumerate() {
                let ep = match (episode.get("id"), episode.get("ep_id")) {
                    (Some(a), Some(b)) if id(a)? != id(b)? => return Err(invalid()),
                    (Some(a), _) | (_, Some(a)) => id(a)?,
                    _ => return Err(invalid()),
                };
                if !seen.insert(ep.clone()) {
                    return Err(invalid());
                }
                if index < start || index >= start + MAX_ITEMS {
                    continue;
                }
                let metadata = if course {
                    bilibili::course::parse_metadata_response(
                        bytes,
                        &bilibili::course::EpisodeRef { ep_id: ep.clone() },
                    )
                    .map(|m| (m.canonical(), format!("{} · {}", m.title, m.episode_title)))
                } else {
                    bilibili::pgc::parse_metadata_response(
                        bytes,
                        &bilibili::pgc::EpisodeRef { ep_id: ep.clone() },
                    )
                    .map(|m| (m.canonical(), format!("{} · {}", m.title, m.episode_title)))
                };
                match metadata {
                    Ok((url, name)) => items.push(Reference {
                        provider: Provider::Bilibili,
                        url,
                        part: 1,
                        title: title(&Value::String(name)),
                    }),
                    Err(bilibili::Error::Restricted(_)) => omitted += 1,
                    Err(error) => return Err(error),
                }
            }
            let next = (start + MAX_ITEMS < total && page.page + 1 < MAX_PAGES).then(|| {
                CollectionPageRequest {
                    page: page.page + 1,
                    cursor: None,
                    offset: 0,
                    snapshot: Some(stamp.clone()),
                }
            });
            Ok(CollectionPage {
                has_more: start + MAX_ITEMS < total,
                items,
                next,
                snapshot: Some(stamp),
                omitted,
            })
        }
        Collection::TikTokPlaylist { id: collection_id }
        | Collection::DouyinMix { id: collection_id } => {
            if page.snapshot.is_some() {
                return Err(invalid());
            }
            let douyin = matches!(collection, Collection::DouyinMix { .. });
            let status = value[if douyin { "status_code" } else { "statusCode" }]
                .as_i64()
                .ok_or_else(invalid)?;
            if status != 0 {
                return Err(bilibili::Error::Api(status));
            }
            let records = value[if douyin { "aweme_list" } else { "itemList" }]
                .as_array()
                .ok_or_else(invalid)?;
            if records.len() > MAX_ITEMS {
                return Err(bilibili::Error::TooLarge);
            }
            let has_more = if douyin {
                match value["has_more"].as_u64() {
                    Some(0) => false,
                    Some(1) => true,
                    _ => return Err(invalid()),
                }
            } else {
                value["hasMore"].as_bool().ok_or_else(invalid)?
            };
            let mut items = Vec::new();
            let mut seen = HashSet::new();
            for record in records {
                let (provider, url, name) = if douyin {
                    if id(&record["mix_info"]["mix_id"])? != *collection_id {
                        return Err(invalid());
                    }
                    let video_id = id(&record["aweme_id"])?;
                    let checked =
                        short_video::parse_resource(short_video::Platform::Douyin, &video_id)
                            .map_err(|_| invalid())?;
                    (Provider::Douyin, checked.canonical(), &record["desc"])
                } else {
                    if id(&record["mixInfo"]["mixId"])? != *collection_id {
                        return Err(invalid());
                    }
                    let video_id = id(&record["id"])?;
                    let handle = record["author"]["uniqueId"].as_str().ok_or_else(invalid)?;
                    let checked = short_video::parse_resource(
                        short_video::Platform::TikTok,
                        &format!("https://www.tiktok.com/@{handle}/video/{video_id}"),
                    )
                    .map_err(|_| invalid())?;
                    (Provider::TikTok, checked.canonical(), &record["desc"])
                };
                let item = Reference {
                    provider,
                    url,
                    part: 1,
                    title: title(name),
                };
                if !seen.insert(item.key()) {
                    return Err(invalid());
                }
                items.push(item);
            }
            let next = if has_more {
                let next_cursor = id(&value["cursor"])?;
                if items.is_empty() || page.cursor.as_ref() == Some(&next_cursor) {
                    return Err(bilibili::Error::Restricted(
                        "platform_collection_cursor_invalid",
                    ));
                }
                (page.page + 1 < MAX_PAGES).then_some(CollectionPageRequest {
                    page: page.page + 1,
                    offset: 0,
                    cursor: Some(next_cursor),
                    snapshot: None,
                })
            } else {
                None
            };
            Ok(CollectionPage {
                has_more,
                items,
                next,
                snapshot: None,
                omitted: 0,
            })
        }
        Collection::Parts(_) => {
            // The API returns the complete parts metadata. Use a stable local
            // snapshot slice, explicitly labelled as such to the client.
            let code = value["code"].as_i64().ok_or_else(invalid)?;
            if code != 0 {
                return Err(bilibili::Error::Api(code));
            }
            let data = &value["data"];
            let checked = bilibili::parse_resource(data["bvid"].as_str().ok_or_else(invalid)?)?;
            if let Collection::Parts(reference) = collection {
                match &reference.id {
                    bilibili::VideoId::Bv(id) if id != data["bvid"].as_str().unwrap() => {
                        return Err(invalid());
                    }
                    bilibili::VideoId::Av(id) if self::id(&data["aid"])? != *id => {
                        return Err(invalid());
                    }
                    _ => {}
                }
            }
            let pages = data["pages"].as_array().ok_or_else(invalid)?;
            if pages.is_empty() || pages.len() > 2000 {
                return Err(bilibili::Error::TooLarge);
            }
            let mut items = Vec::new();
            for (index, p) in pages.iter().enumerate() {
                if p["page"].as_u64() != Some((index + 1) as u64) {
                    return Err(invalid());
                }
                let reference = bilibili::VideoRef {
                    id: checked.id.clone(),
                    part: (index + 1) as u32,
                };
                items.push(Reference {
                    provider: Provider::Bilibili,
                    url: reference.canonical(),
                    part: reference.part,
                    title: title(&p["part"]),
                });
            }
            slice_snapshot(items, page, 0)
        }
        Collection::Season { mid, id: season } | Collection::Series { mid, id: season } => {
            if page.cursor.is_some() || page.snapshot.is_some() {
                return Err(invalid());
            }
            let code = value["code"].as_i64().ok_or_else(invalid)?;
            if code != 0 {
                return Err(bilibili::Error::Api(code));
            }
            let data = &value["data"];
            let seasonal = matches!(collection, Collection::Season { .. });
            if seasonal
                && (id(&data["meta"]["mid"])? != *mid || id(&data["meta"]["season_id"])? != *season)
            {
                return Err(invalid());
            }
            let p = &data["page"];
            let n = p[if seasonal { "page_num" } else { "num" }]
                .as_u64()
                .ok_or_else(invalid)?;
            let size = p[if seasonal { "page_size" } else { "size" }]
                .as_u64()
                .ok_or_else(invalid)?;
            if n != u64::from(page.page) + 1 || size != MAX_ITEMS as u64 {
                return Err(invalid());
            }
            let records = data["archives"].as_array().ok_or_else(invalid)?;
            let total = p["total"]
                .as_u64()
                .filter(|t| *t <= 1_000_000)
                .ok_or_else(invalid)?;
            if records.len() > MAX_ITEMS || total < records.len() as u64 {
                return Err(invalid());
            }
            let mut items = Vec::new();
            let mut seen = HashSet::new();
            for record in records {
                let mut r = canonical(
                    Provider::Bilibili,
                    record["bvid"].as_str().ok_or_else(invalid)?,
                )?;
                if !seen.insert(r.key()) {
                    return Err(invalid());
                }
                r.title = title(&record["title"]);
                items.push(r);
            }
            let more = (u64::from(page.page) + 1) * (MAX_ITEMS as u64) < total;
            if more && items.is_empty() {
                return Err(invalid());
            }
            let next = (more && page.page + 1 < MAX_PAGES).then(|| CollectionPageRequest {
                page: page.page + 1,
                offset: 0,
                cursor: None,
                snapshot: None,
            });
            Ok(CollectionPage {
                has_more: more,
                items,
                next,
                snapshot: None,
                omitted: 0,
            })
        }
        Collection::TikTok { id: collection_id } => {
            if !decimal(collection_id)
                || (page.page > 0 && page.cursor.is_none())
                || (page.offset == 20 && page.snapshot.is_none())
                || (page.offset == 0 && page.snapshot.is_some())
            {
                return Err(invalid());
            }
            if let Some(status) = value.get("statusCode") {
                let code = status.as_i64().ok_or_else(invalid)?;
                if code != 0 {
                    return Err(bilibili::Error::Api(code));
                }
            }
            let records = value["itemList"].as_array().ok_or_else(invalid)?;
            let more = value["hasMore"].as_bool().ok_or_else(invalid)?;
            if records.len() > TIKTOK_COLLECTION_PAGE_ITEMS {
                return Err(bilibili::Error::TooLarge);
            }
            let mut items = Vec::new();
            let mut seen = HashSet::new();
            for record in records {
                let video_id = record["id"]
                    .as_str()
                    .filter(|s| decimal(s))
                    .ok_or_else(invalid)?;
                let handle = record["author"]["uniqueId"].as_str().ok_or_else(invalid)?;
                let checked = short_video::parse_resource(
                    short_video::Platform::TikTok,
                    &format!("https://www.tiktok.com/@{handle}/video/{video_id}"),
                )
                .map_err(|_| invalid())?;
                if !seen.insert(checked.id().to_owned()) {
                    return Err(invalid());
                }
                items.push(Reference {
                    provider: Provider::TikTok,
                    url: checked.canonical(),
                    part: 1,
                    title: title(&record["desc"]),
                });
            }
            let stamp = snapshot(&items);
            if page.snapshot.as_ref().is_some_and(|old| old != &stamp) {
                return Err(bilibili::Error::Restricted("platform_collection_changed"));
            }
            let current_cursor = page
                .cursor
                .as_deref()
                .unwrap_or("0")
                .parse::<u64>()
                .map_err(|_| invalid())?;
            if current_cursor % 30 != 0 || (page.offset > 0 && items.len() <= MAX_ITEMS) {
                return Err(invalid());
            }
            let next = if page.page + 1 >= MAX_PAGES {
                None
            } else if page.offset == 0 && items.len() > MAX_ITEMS {
                Some(CollectionPageRequest {
                    page: page.page + 1,
                    offset: 20,
                    cursor: Some(current_cursor.to_string()),
                    snapshot: Some(stamp.clone()),
                })
            } else if more {
                if items.is_empty() {
                    return Err(invalid());
                }
                Some(CollectionPageRequest {
                    page: page.page + 1,
                    offset: 0,
                    cursor: Some(
                        current_cursor
                            .checked_add(30)
                            .ok_or_else(invalid)?
                            .to_string(),
                    ),
                    snapshot: None,
                })
            } else {
                None
            };
            let has_more = more || (page.offset == 0 && items.len() > MAX_ITEMS);
            Ok(CollectionPage {
                has_more,
                items: items
                    .into_iter()
                    .skip(page.offset as usize)
                    .take(MAX_ITEMS)
                    .collect(),
                next,
                snapshot: Some(stamp),
                omitted: 0,
            })
        }
    }
}
pub async fn preview_collection_page<T: Transport>(
    transport: &T,
    collection: &Collection,
    page: &CollectionPageRequest,
    cookie: Option<&bilibili::Cookie>,
    deadline: Instant,
) -> Result<CollectionPage> {
    if Instant::now() >= deadline {
        return Err(bilibili::Error::Deadline);
    }
    let request = page_request(collection, page, cookie)?;
    let response = tokio::time::timeout_at(deadline, transport.get(request, deadline))
        .await
        .map_err(|_| bilibili::Error::Deadline)??;
    if response.status == 403 || response.status == 401 {
        return Err(bilibili::Error::Restricted(
            "platform_collection_user_handoff_required",
        ));
    }
    if response.status != 200 || response.location.is_some() {
        return Err(bilibili::Error::Status(response.status));
    }
    let result = parse_collection_page_response(collection, page, &response.body);
    if Instant::now() >= deadline {
        return Err(bilibili::Error::Deadline);
    }
    result
}
pub(super) fn validate_saved_url(url: &Url, id: &str) -> bool {
    let cursor = url
        .query_pairs()
        .find(|(k, _)| k == "cursor")
        .and_then(|(_, v)| v.parse::<u64>().ok());
    let Some(cursor) = cursor else {
        return false;
    };
    if cursor % 30 != 0 {
        return false;
    }
    let Ok(mut expected) = tiktok_collection_url(id) else {
        return false;
    };
    let pairs = expected
        .query_pairs()
        .map(|(k, v)| {
            (
                k.clone().into_owned(),
                if k == "cursor" {
                    cursor.to_string()
                } else {
                    v.into_owned()
                },
            )
        })
        .collect::<Vec<_>>();
    expected.set_query(None);
    expected.query_pairs_mut().extend_pairs(pairs);
    *url == expected
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn whole_seasons_are_snapshots_of_exact_entitlement_aware_episode_references() {
        for course in [false, true] {
            let bytes = if course {
                include_bytes!("../bilibili/course/fixtures/season-authorized-episode.json")
                    .as_slice()
            } else {
                include_bytes!("../bilibili/pgc/fixtures/season-single-episode.json").as_slice()
            };
            let c = if course {
                Collection::CourseSeason { id: "12345".into() }
            } else {
                Collection::PgcSeason { id: "12345".into() }
            };
            let mut value: Value = serde_json::from_slice(bytes).unwrap();
            let data = &mut value[if course { "data" } else { "result" }];
            let mut entries = Vec::new();
            let base = data["episodes"][1].clone();
            for n in 1..=25 {
                let mut ep = base.clone();
                ep["id"] = serde_json::json!(n);
                entries.push(ep);
            }
            data["episodes"] = serde_json::json!(entries);
            let bytes = serde_json::to_vec(&value).unwrap();
            let first =
                parse_collection_page_response(&c, &CollectionPageRequest::default(), &bytes)
                    .unwrap();
            assert_eq!(first.items.len(), 20);
            assert_eq!(first.omitted, 0);
            assert!(first.items.iter().all(|r| r.url.contains(if course {
                "/cheese/play/ep"
            } else {
                "/bangumi/play/ep"
            }) && r.part == 1));
            let second =
                parse_collection_page_response(&c, first.next.as_ref().unwrap(), &bytes).unwrap();
            assert_eq!(second.items.len(), 5);
            assert!(second.next.is_none());
            value[if course { "data" } else { "result" }]["episodes"][0]["title"] =
                serde_json::json!("changed");
            assert_eq!(
                parse_collection_page_response(
                    &c,
                    first.next.as_ref().unwrap(),
                    &serde_json::to_vec(&value).unwrap()
                )
                .unwrap_err(),
                bilibili::Error::Restricted("platform_collection_changed")
            );
            assert!(
                parse_collection_page_response(
                    &c,
                    &CollectionPageRequest {
                        page: 1,
                        cursor: None,
                        offset: 0,
                        snapshot: None
                    },
                    &bytes
                )
                .is_err()
            );
            let req = page_request(&c, &CollectionPageRequest::default(), None).unwrap();
            req.validate().unwrap();
            assert_eq!(req.url().query(), Some("season_id=12345"));
        }
    }
    #[test]
    fn saved_tiktok_preserves_all_thirty_rows_without_inventing_a_twenty_cursor() {
        let c = Collection::TikTok { id: "1".into() };
        let v = serde_json::json!({"statusCode":0,"hasMore":true,"itemList":(1..=30).map(|i|serde_json::json!({"id":i.to_string(),"author":{"uniqueId":"creator"},"desc":"caption"})).collect::<Vec<_>>()});
        let bytes = serde_json::to_vec(&v).unwrap();
        let first =
            parse_collection_page_response(&c, &CollectionPageRequest::default(), &bytes).unwrap();
        assert_eq!(first.items.len(), 20);
        let tail = first.next.unwrap();
        assert_eq!(tail.offset, 20);
        assert_eq!(tail.cursor.as_deref(), Some("0"));
        let second = parse_collection_page_response(&c, &tail, &bytes).unwrap();
        assert_eq!(second.items.len(), 10);
        let next = second.next.unwrap();
        assert_eq!(next.offset, 0);
        assert_eq!(next.cursor.as_deref(), Some("30"));
        let req = page_request(&c, &next, None).unwrap();
        req.validate().unwrap();
        assert!(req.url().as_str().contains("count=30&cursor=30"));
        let mut changed = v;
        changed["itemList"][20]["id"] = serde_json::json!("99");
        assert!(
            parse_collection_page_response(&c, &tail, &serde_json::to_vec(&changed).unwrap())
                .is_err()
        );
    }
    #[test]
    fn mix_continuations_are_response_cursors_bound_to_matching_collection_identity() {
        let c = Collection::TikTokPlaylist { id: "7".into() };
        let v = serde_json::json!({"statusCode":0,"hasMore":true,"cursor":42,"itemList":[{"id":"1","mixInfo":{"mixId":"7"},"author":{"uniqueId":"creator"},"desc":"a"}]});
        let page = parse_collection_page_response(
            &c,
            &CollectionPageRequest::default(),
            &serde_json::to_vec(&v).unwrap(),
        )
        .unwrap();
        let next = page.next.unwrap();
        assert_eq!(next.cursor.as_deref(), Some("42"));
        page_request(&c, &next, None).unwrap().validate().unwrap();
        assert!(
            parse_collection_page_response(&c, &next, &serde_json::to_vec(&v).unwrap()).is_err()
        );
        let mut bad = v;
        bad["itemList"][0]["mixInfo"]["mixId"] = serde_json::json!("8");
        assert!(
            parse_collection_page_response(
                &c,
                &CollectionPageRequest::default(),
                &serde_json::to_vec(&bad).unwrap()
            )
            .is_err()
        );
        assert!(
            parse_collection_page_response(
                &c,
                &CollectionPageRequest::default(),
                br#"{"statusCode":0,"statusCode":1,"hasMore":false,"itemList":[]}"#
            )
            .is_err()
        );
    }
    #[test]
    fn collection_selectors_never_admit_feeds_or_transport_parameters() {
        for value in [
            "https://www.douyin.com/user/1",
            "https://www.douyin.com/collection/1?signature=x",
            "https://www.tiktok.com/@creator/playlist/name-1?cursor=20",
            "https://www.bilibili.com/bangumi/play/ss1?p=2",
        ] {
            let p = recognize(value).unwrap();
            assert!(parse_collection(value, p).is_err());
        }
    }
}
