//! Closed ordinary YouTube playlists. Only the PL identity family is admitted;
//! uploads, mixes, personal feeds, channels and playlist-of-playlists are absent.
//! Metadata comes from the existing trusted, simulated flat-playlist boundary.
use super::{Error, MAX_JSON_BYTES, MAX_RESOURCE_BYTES, Result, VideoRef, valid_id};
use reqwest::Url;
use serde::Deserialize;
use std::{collections::HashSet, fmt};
use tokio::time::Instant;

pub const MAX_ITEMS: usize = 20;
pub(super) const MAX_METADATA_ITEMS: usize = MAX_ITEMS + 1;

#[derive(Clone, PartialEq, Eq)]
pub struct PlaylistRef {
    id: String,
}
impl fmt::Debug for PlaylistRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("YoutubePlaylistRef([REDACTED])")
    }
}
impl PlaylistRef {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn canonical(&self) -> String {
        format!("https://www.youtube.com/playlist?list={}", self.id)
    }
}
fn valid_playlist_id(value: &str) -> bool {
    // The maintained extractor recognizes PL followed by at least 10 URL-safe
    // characters. The application adds a 64-byte cap and excludes other families.
    // https://github.com/yt-dlp/yt-dlp/blob/51bab8a0116f4d8004c315706d809782607d5847/yt_dlp/extractor/youtube/_base.py#L451
    (12..=64).contains(&value.len())
        && value.starts_with("PL")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
/// Bare PL IDs or exact HTTPS /playlist?list=PL… URLs only. Query duplicates,
/// tracking, watch-context lists, escaped spellings and arbitrary origins fail.
pub fn parse_resource(input: &str) -> Result<PlaylistRef> {
    if input.is_empty()
        || input.len() > MAX_RESOURCE_BYTES
        || !input.is_ascii()
        || input
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control() || b == b'\\')
    {
        return Err(Error::InvalidResource);
    }
    if valid_playlist_id(input) {
        return Ok(PlaylistRef { id: input.into() });
    }
    let rest = input
        .strip_prefix("https://")
        .ok_or(Error::InvalidResource)?;
    let (authority, path_query) = rest.split_once('/').ok_or(Error::InvalidResource)?;
    if !matches!(
        authority,
        "youtube.com" | "www.youtube.com" | "m.youtube.com"
    ) || !path_query.starts_with("playlist?list=")
    {
        return Err(Error::InvalidResource);
    }
    let id = path_query
        .strip_prefix("playlist?list=")
        .ok_or(Error::InvalidResource)?;
    if !valid_playlist_id(id) {
        return Err(Error::InvalidResource);
    }
    let url = Url::parse(input).map_err(|_| Error::InvalidResource)?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.path() != "/playlist"
        || url.query() != Some(&format!("list={id}"))
    {
        return Err(Error::InvalidResource);
    }
    Ok(PlaylistRef { id: id.into() })
}

/// Explicit zero-based UI page; no extractor syntax or automatic feed walk.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub page: u32,
}
impl Page {
    pub fn validate(self) -> Result<()> {
        if self.page >= 100 {
            Err(Error::InvalidResource)
        } else {
            Ok(())
        }
    }
    pub fn range(self) -> Result<String> {
        self.validate()?;
        let start = self.page as usize * MAX_ITEMS + 1;
        Ok(format!("{start}:{}", start + MAX_ITEMS))
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PagePreview {
    pub preview: Preview,
    pub next: Option<Page>,
    pub boundary_hash: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct Item {
    pub video: VideoRef,
    pub title: Option<String>,
}
impl fmt::Debug for Item {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("YoutubePlaylistItem([REDACTED])")
    }
}
#[derive(Clone, PartialEq, Eq)]
pub struct Preview {
    pub items: Vec<Item>,
    pub truncated: bool,
    pub unavailable: usize,
}
impl fmt::Debug for Preview {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("YoutubePlaylistPreview")
            .field("item_count", &self.items.len())
            .field("truncated", &self.truncated)
            .field("unavailable", &self.unavailable)
            .finish()
    }
}
#[derive(Deserialize)]
struct Metadata {
    #[serde(rename = "_type")]
    kind: String,
    id: String,
    extractor_key: String,
    availability: Option<String>,
    webpage_url: String,
    playlist_count: Option<u64>,
    entries: Vec<FlatItem>,
}
#[derive(Deserialize)]
struct FlatItem {
    #[serde(rename = "_type")]
    kind: String,
    id: String,
    ie_key: String,
    url: String,
    title: Option<String>,
    availability: Option<String>,
    live_status: Option<String>,
    is_live: Option<bool>,
    age_limit: Option<u32>,
}
fn title(value: Option<String>) -> Option<String> {
    value
        .map(|value| {
            value
                .chars()
                .filter(|c| !c.is_control() && !matches!(c, '\u{2028}' | '\u{2029}'))
                .take(200)
                .collect::<String>()
        })
        .filter(|value| !value.trim().is_empty())
}
pub(super) fn normalize_before_deadline(
    bytes: &[u8],
    requested: &PlaylistRef,
    deadline: Instant,
) -> Result<Preview> {
    if Instant::now() >= deadline {
        return Err(Error::Deadline);
    }
    let result = normalize(bytes, requested);
    if Instant::now() >= deadline {
        return Err(Error::Deadline);
    }
    result
}
pub(super) fn normalize(bytes: &[u8], requested: &PlaylistRef) -> Result<Preview> {
    normalize_at(bytes, requested, Page::default()).map(|p| p.preview)
}
pub(super) fn normalize_page_before_deadline(
    bytes: &[u8],
    requested: &PlaylistRef,
    page: Page,
    deadline: Instant,
) -> Result<PagePreview> {
    if Instant::now() >= deadline {
        return Err(Error::Deadline);
    }
    let result = normalize_at(bytes, requested, page);
    if Instant::now() >= deadline {
        return Err(Error::Deadline);
    }
    result
}
fn boundary(id: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(format!("rainsync-youtube-playlist-boundary-v1\0{id}").as_bytes())
    )
}
pub(super) fn normalize_page_with_boundary(
    bytes: &[u8],
    requested: &PlaylistRef,
    page: Page,
    expected: Option<&str>,
    deadline: Instant,
) -> Result<PagePreview> {
    page.validate()?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(Error::TooLarge);
    }
    if Instant::now() >= deadline {
        return Err(Error::Deadline);
    }
    if (page.page == 0 && expected.is_some()) || (page.page > 0 && expected.is_none()) {
        return Err(Error::InvalidResource);
    }
    if let Some(expected) = expected {
        if expected.len() != 64
            || !expected
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::InvalidResource);
        }
        let data: Metadata = serde_json::from_slice(bytes).map_err(|_| Error::InvalidResponse)?;
        let first = data.entries.first().ok_or(Error::InvalidResponse)?;
        let checked = super::parse_resource(&first.url).map_err(|_| Error::InvalidResponse)?;
        if !valid_id(&first.id)
            || checked.id != first.id
            || boundary(&checked.canonical()) != expected
        {
            return Err(Error::InvalidResponse);
        }
    }
    normalize_page_before_deadline(bytes, requested, page, deadline)
}
fn normalize_at(bytes: &[u8], requested: &PlaylistRef, page: Page) -> Result<PagePreview> {
    page.validate()?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(Error::TooLarge);
    }
    let data: Metadata = serde_json::from_slice(bytes).map_err(|_| Error::InvalidResponse)?;
    if data.kind != "playlist"
        || data.id != requested.id
        || data.extractor_key != "YoutubeTab"
        || data.webpage_url != requested.canonical()
    {
        return Err(Error::InvalidResponse);
    }
    if !matches!(data.availability.as_deref(), Some("public" | "unlisted")) {
        return Err(Error::Unsupported);
    }
    if data.entries.len() > MAX_METADATA_ITEMS
        || data
            .playlist_count
            .is_some_and(|n| n > 1_000_000 || n < data.entries.len() as u64)
    {
        return Err(Error::TooLarge);
    }
    let truncated = data.entries.len() > MAX_ITEMS
        || data
            .playlist_count
            .is_some_and(|n| n > u64::from(page.page + 1) * MAX_ITEMS as u64);
    let has_sentinel = data.entries.len() > MAX_ITEMS;
    let mut boundary_hash = None;
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut unavailable = 0;
    for (index, entry) in data.entries.into_iter().enumerate() {
        // Validate even the sentinel entry. No extractor-supplied URL is exposed
        // or visited: the admitted video identity creates its canonical URL.
        if entry.kind != "url" || entry.ie_key != "Youtube" || !valid_id(&entry.id) {
            return Err(Error::InvalidResponse);
        }
        let checked = super::parse_resource(&entry.url).map_err(|_| Error::InvalidResponse)?;
        if checked.id != entry.id {
            return Err(Error::InvalidResponse);
        }
        if index >= MAX_ITEMS {
            // Mint only after the full sentinel kind/ID/canonical URL checks.
            boundary_hash = Some(boundary(&checked.canonical()));
            continue;
        }
        if entry.is_live == Some(true)
            || entry.age_limit.is_some_and(|n| n > 0)
            || !matches!(entry.live_status.as_deref(), None | Some("not_live"))
            || !matches!(
                entry.availability.as_deref(),
                None | Some("public" | "unlisted")
            )
        {
            unavailable += 1;
            continue;
        }
        // A video repeated in a playlist is one room identity, preserving first
        // occurrence order and the existing import idempotency contract.
        if seen.insert(checked.id.clone()) {
            items.push(Item {
                video: checked,
                title: title(entry.title),
            });
        }
    }
    Ok(PagePreview {
        preview: Preview {
            items,
            truncated,
            unavailable,
        },
        next: (has_sentinel && page.page + 1 < 100).then_some(Page {
            page: page.page + 1,
        }),
        boundary_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    const LIST: &str = "PLBB231211A4F62143";
    fn entry(index: usize) -> Value {
        let id = format!("video{index:06}");
        json!({"_type":"url","ie_key":"Youtube","id":id,"url":format!("https://www.youtube.com/watch?v={id}"),"title":"Example","availability":null,"live_status":null,
            "http_headers":{"Cookie":"never-copy"},"unknown_secret":"never-copy"})
    }
    fn fixture(count: usize) -> Value {
        json!({"_type":"playlist","id":LIST,"extractor_key":"YoutubeTab","availability":"public","webpage_url":format!("https://www.youtube.com/playlist?list={LIST}"),"entries":(0..count).map(entry).collect::<Vec<_>>(),
            "url":"https://attacker.test/do-not-copy","http_headers":{"Cookie":"do-not-copy"}})
    }
    fn parse(value: &Value) -> Result<Preview> {
        normalize(
            &serde_json::to_vec(value).unwrap(),
            &parse_resource(LIST).unwrap(),
        )
    }
    #[test]
    fn exact_playlist_identity_never_accepts_feeds_channels_mixes_or_video_lists() {
        for input in [
            LIST.into(),
            format!("https://www.youtube.com/playlist?list={LIST}"),
            format!("https://m.youtube.com/playlist?list={LIST}"),
        ] {
            assert_eq!(
                parse_resource(&input).unwrap().canonical(),
                format!("https://www.youtube.com/playlist?list={LIST}")
            );
        }
        for input in [
            "RDabcdefghijk",
            "UUabcdefghijk",
            "WL",
            "LL",
            "--exec=bad",
            "https://www.youtube.com/feed/history",
            "https://www.youtube.com/@creator",
            "https://evil.test/playlist?list=PLBB231211A4F62143",
            "https://www.youtube.com:443/playlist?list=PLBB231211A4F62143",
            "https://www.youtube.com/a/../playlist?list=PLBB231211A4F62143",
            "https://user@www.youtube.com/playlist?list=PLBB231211A4F62143",
            "https://www.youtube.com/playlist?list=PLBB231211A4F62143&list=PLBB231211A4F62143",
            "https://www.youtube.com/playlist?%6cist=PLBB231211A4F62143",
            "https://www.youtube.com/playlist?list=PLBB231211A4F62143#fragment",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLBB231211A4F62143",
            "https://www.youtube.com/playlist?list=PLBB231211A4F62143&si=tracking",
        ] {
            assert!(parse_resource(input).is_err(), "{input}");
        }
    }
    #[test]
    fn preview_caps_at_twenty_plus_one_sentinel_and_discards_unknown_output() {
        assert!(parse(&fixture(0)).unwrap().items.is_empty());
        let p = parse(&fixture(20)).unwrap();
        assert_eq!(p.items.len(), 20);
        assert!(!p.truncated);
        assert!(p.items[0].video.canonical().ends_with("v=video000000"));
        assert!(!format!("{p:?}").contains("never-copy"));
        assert!(!format!("{p:?}").contains("attacker"));
        assert!(!format!("{p:?}").contains("Example"));
        assert!(!format!("{:?}", parse_resource(LIST).unwrap()).contains(LIST));
        let p = parse(&fixture(21)).unwrap();
        assert_eq!(p.items.len(), 20);
        assert!(p.truncated);
        assert_eq!(parse(&fixture(22)).unwrap_err(), Error::TooLarge);
        let mut f = fixture(2);
        f["playlist_count"] = json!(200);
        assert!(parse(&f).unwrap().truncated);
        f["playlist_count"] = json!(1);
        assert!(parse(&f).is_err());
    }
    #[test]
    fn absolute_deadline_is_checked_before_metadata_publication() {
        let bytes = serde_json::to_vec(&fixture(1)).unwrap();
        let reference = parse_resource(LIST).unwrap();
        assert_eq!(
            normalize_before_deadline(&bytes, &reference, Instant::now()).unwrap_err(),
            Error::Deadline
        );
        assert!(
            normalize_before_deadline(
                &bytes,
                &reference,
                Instant::now() + std::time::Duration::from_secs(1)
            )
            .is_ok()
        );
    }
    #[test]
    fn response_identity_and_nested_or_foreign_extractors_fail_closed() {
        for (field, value) in [
            ("id", json!("PLAAAAAAAAAAAAAA")),
            ("_type", json!("video")),
            ("extractor_key", json!("Youtube")),
            ("webpage_url", json!("https://www.youtube.com/feed/history")),
        ] {
            let mut f = fixture(1);
            f[field] = value;
            assert!(parse(&f).is_err());
        }
        for (field, value) in [
            ("id", json!("invalid")),
            ("_type", json!("playlist")),
            ("ie_key", json!("Generic")),
            ("url", json!("https://evil.test/watch?v=video000000")),
            ("url", json!("https://www.youtube.com/watch?v=dQw4w9WgXcQ")),
        ] {
            let mut f = fixture(1);
            f["entries"][0][field] = value;
            assert!(parse(&f).is_err());
        }
        let mut f = fixture(21);
        f["entries"][20]["ie_key"] = json!("Generic");
        assert!(parse(&f).is_err());
        for availability in [json!("private"), json!("premium_only"), json!(null)] {
            let mut f = fixture(1);
            f["availability"] = availability;
            assert_eq!(parse(&f).unwrap_err(), Error::Unsupported);
        }
        assert_eq!(
            normalize(
                &vec![b'x'; MAX_JSON_BYTES + 1],
                &parse_resource(LIST).unwrap()
            )
            .unwrap_err(),
            Error::TooLarge
        );
    }
    #[test]
    fn known_unavailable_items_are_omitted_without_expanding_and_titles_are_safe() {
        let mut f = fixture(5);
        f["entries"][0]["is_live"] = json!(true);
        f["entries"][1]["availability"] = json!("private");
        f["entries"][2]["age_limit"] = json!(18);
        f["entries"][3]["title"] = json!(format!("\n{}\u{2028}", "好".repeat(205)));
        f["entries"][4] = f["entries"][3].clone();
        let p = parse(&f).unwrap();
        assert_eq!(p.unavailable, 3);
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.items[0].title.as_ref().unwrap().chars().count(), 200);
        assert!(!p.truncated);
    }
}
#[cfg(test)]
mod page_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn typed_pages_select_twenty_plus_a_sentinel_without_inventing_a_snapshot() {
        assert_eq!(Page { page: 0 }.range().unwrap(), "1:21");
        assert_eq!(Page { page: 1 }.range().unwrap(), "21:41");
        assert_eq!(Page { page: 99 }.range().unwrap(), "1981:2001");
        assert!(Page { page: 100 }.range().is_err());
        let list = parse_resource("PLBB231211A4F62143").unwrap();
        let entries=(1..=21).map(|n|{let id=format!("video{n:06}");json!({"_type":"url","id":id,"ie_key":"Youtube","url":format!("https://www.youtube.com/watch?v={id}")})}).collect::<Vec<_>>();
        let mut value = json!({"_type":"playlist","id":list.id(),"extractor_key":"YoutubeTab","availability":"public","webpage_url":list.canonical(),"playlist_count":40,"entries":entries});
        let first = normalize_at(
            &serde_json::to_vec(&value).unwrap(),
            &list,
            Page { page: 0 },
        )
        .unwrap();
        assert_eq!(first.preview.items.len(), 20);
        assert_eq!(first.next, Some(Page { page: 1 }));
        value["entries"].as_array_mut().unwrap().truncate(20);
        let last = normalize_at(
            &serde_json::to_vec(&value).unwrap(),
            &list,
            Page { page: 1 },
        )
        .unwrap();
        assert!(last.next.is_none());
        assert!(!last.preview.truncated);
        value["playlist_count"] = json!(1000);
        let count_only = normalize_at(
            &serde_json::to_vec(&value).unwrap(),
            &list,
            Page { page: 1 },
        )
        .unwrap();
        assert!(count_only.next.is_none());
        assert!(count_only.preview.truncated);
    }
}
#[cfg(test)]
mod boundary_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn next_page_requires_prior_canonical_sentinel_and_refuses_source_boundary_changes() {
        let list = parse_resource("PLBB231211A4F62143").unwrap();
        let entry = |n: usize| {
            let id = format!("video{n:06}");
            json!({"_type":"url","id":id,"ie_key":"Youtube","url":format!("https://www.youtube.com/watch?v={id}")})
        };
        let fixture = |start: usize| json!({"_type":"playlist","id":list.id(),"extractor_key":"YoutubeTab","availability":"public","webpage_url":list.canonical(),"entries":(start..start+21).map(entry).collect::<Vec<_>>()});
        let deadline = Instant::now() + std::time::Duration::from_secs(1);
        let first = normalize_page_with_boundary(
            &serde_json::to_vec(&fixture(1)).unwrap(),
            &list,
            Page { page: 0 },
            None,
            deadline,
        )
        .unwrap();
        let proof = first.boundary_hash.unwrap();
        assert!(
            normalize_page_with_boundary(
                &serde_json::to_vec(&fixture(21)).unwrap(),
                &list,
                Page { page: 1 },
                Some(&proof),
                deadline
            )
            .is_ok()
        );
        assert!(
            normalize_page_with_boundary(
                &serde_json::to_vec(&fixture(20)).unwrap(),
                &list,
                Page { page: 1 },
                Some(&proof),
                deadline
            )
            .is_err()
        );
        assert!(
            normalize_page_with_boundary(
                &serde_json::to_vec(&fixture(21)).unwrap(),
                &list,
                Page { page: 1 },
                None,
                deadline
            )
            .is_err()
        );
        let mut bad = fixture(1);
        bad["entries"][20]["url"] = json!("https://example.invalid/redirect");
        assert!(
            normalize_page_with_boundary(
                &serde_json::to_vec(&bad).unwrap(),
                &list,
                Page { page: 0 },
                None,
                deadline
            )
            .is_err()
        );
    }
}
