//! Closed rolling clear MPEG-TS HLS graph, independent of finite static HLS.
//! No upstream tag, comment, URI, key or byte range is copied into a response.
use super::{
    Error, MAX_PLAYLIST_BYTES, Provider, Result, validate_playlist_url, validate_segment_url,
};
pub(crate) use crate::platform::live_playlist_syntax::parse_program_date_time;
use crate::platform::live_playlist_syntax::{MAX_SEQUENCE, duration, integer, invalid};
use reqwest::Url;
use std::{collections::HashSet, fmt};
const MAX_SEGMENTS: usize = 120;
const MAX_WINDOW_MS: u64 = 180_000;
#[derive(Clone, PartialEq, Eq)]
pub struct Segment {
    pub sequence: u64,
    pub discontinuity: u64,
    pub duration_ms: u32,
    pub url: String,
    pub program_date_time_ms: Option<i64>,
}
impl fmt::Debug for Segment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LiveSegment")
            .field("sequence", &self.sequence)
            .field("discontinuity", &self.discontinuity)
            .field("duration_ms", &self.duration_ms)
            .field("program_date_time_ms", &self.program_date_time_ms)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Playlist {
    pub provider: Provider,
    pub sequence: u64,
    pub discontinuity_sequence: u64,
    pub target_duration_ms: u32,
    pub segments: Vec<Segment>,
}
impl Playlist {
    pub fn validate(&self) -> Result<()> {
        if self.segments.is_empty()
            || self.segments.len() > MAX_SEGMENTS
            || self.sequence > MAX_SEQUENCE
            || self.discontinuity_sequence > MAX_SEQUENCE
            || !(1000..=30000).contains(&self.target_duration_ms)
            || !self.target_duration_ms.is_multiple_of(1000)
        {
            return Err(invalid());
        }
        let first = validate_segment_url(self.provider, &self.segments[0].url)?;
        let root = first
            .path()
            .rsplit_once('/')
            .ok_or_else(invalid)?
            .0
            .to_owned()
            + "/";
        let mut total = 0u64;
        let mut disc = self.discontinuity_sequence;
        let mut previous_time = None;
        let mut seen = HashSet::new();
        for (index, segment) in self.segments.iter().enumerate() {
            if segment.sequence
                != self
                    .sequence
                    .checked_add(index as u64)
                    .ok_or_else(invalid)?
                || segment.sequence > MAX_SEQUENCE
                || !(1..=30000).contains(&segment.duration_ms)
                || (segment.duration_ms as u64 + 500) / 1000 > self.target_duration_ms as u64 / 1000
            {
                return Err(invalid());
            }
            if segment.discontinuity == disc.saturating_add(1) {
                disc = segment.discontinuity;
                previous_time = None;
            } else if segment.discontinuity != disc {
                return Err(invalid());
            }
            if disc > MAX_SEQUENCE {
                return Err(invalid());
            }
            let url = validate_segment_url(self.provider, &segment.url)?;
            if (self.provider != Provider::YouTube
                && (url.origin() != first.origin() || !url.path().starts_with(&root)))
                || !seen.insert(format!(
                    "{}{}",
                    url.origin().ascii_serialization(),
                    url.path()
                ))
            {
                return Err(Error::Restricted("live_segment_scope_denied"));
            }
            if let Some(time) = segment.program_date_time_ms {
                if !(946_684_800_000..=4_102_444_800_000).contains(&time)
                    || previous_time.is_some_and(|expected| expected != time)
                {
                    return Err(Error::InvalidResponse("live_pdt_changed"));
                }
                previous_time = Some(
                    time.checked_add(segment.duration_ms as i64)
                        .ok_or_else(invalid)?,
                );
            } else if previous_time.is_some() {
                return Err(Error::InvalidResponse("live_pdt_changed"));
            }
            total = total
                .checked_add(segment.duration_ms as u64)
                .filter(|n| *n <= MAX_WINDOW_MS)
                .ok_or_else(invalid)?;
        }
        Ok(())
    }
    /// Rendering accepts only closed same-origin application-relative routes.
    /// A caller supplies a per-grant sequence/discontinuity-fenced route for each
    /// admitted segment; arbitrary origin and scheme-relative strings fail.
    pub fn rewrite<F>(&self, mut route: F) -> Result<String>
    where
        F: FnMut(&Segment) -> Result<String>,
    {
        self.validate()?;
        let mut output = format!(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:{}\n#EXT-X-MEDIA-SEQUENCE:{}\n#EXT-X-DISCONTINUITY-SEQUENCE:{}\n",
            self.target_duration_ms / 1000,
            self.sequence,
            self.discontinuity_sequence
        );
        let mut disc = self.discontinuity_sequence;
        for segment in &self.segments {
            if segment.discontinuity == disc + 1 {
                output.push_str("#EXT-X-DISCONTINUITY\n");
                disc += 1;
            } else if segment.discontinuity != disc {
                return Err(invalid());
            }
            // PDT is deliberately withheld in this first live-edge contract.
            // Presence alone is not proof of a shared, verified room time map.
            let uri = route(segment)?;
            if !uri.starts_with('/')
                || uri.starts_with("//")
                || !uri.is_ascii()
                || uri.len() > 4096
                || uri.bytes().any(|b| b <= b' ' || b == 127 || b == b'\\')
                || uri.contains('#')
                || uri.contains("://")
                || uri.contains('%')
                || uri
                    .split('?')
                    .next()
                    .unwrap_or("")
                    .split('/')
                    .any(|p| matches!(p, "." | ".."))
            {
                return Err(Error::Restricted("live_application_route_denied"));
            }
            output.push_str(&format!(
                "#EXTINF:{}.{:03},\n{}\n",
                segment.duration_ms / 1000,
                segment.duration_ms % 1000,
                uri
            ));
            if output.len() > MAX_PLAYLIST_BYTES {
                return Err(Error::TooLarge);
            }
        }
        Ok(output)
    }
}
/// Only a media playlist with clear full TS segments is admitted. Masters, LL-HLS,
/// maps, byte ranges, encryption (even METHOD=NONE), variable substitution,
/// alternate renditions, gaps, EVENT/VOD and ENDLIST are explicitly unsupported.
pub fn parse_playlist(provider: Provider, bytes: &[u8], upstream: &str) -> Result<Playlist> {
    if bytes.is_empty() || bytes.len() > MAX_PLAYLIST_BYTES {
        return Err(Error::TooLarge);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    if text.bytes().any(|b| b < 32 && !matches!(b, b'\n' | b'\r'))
        || text.contains('\u{7f}')
        || text.contains('\u{feff}')
    {
        return Err(invalid());
    }
    let base = validate_playlist_url(provider, upstream)?;
    let root = base
        .path()
        .rsplit_once('/')
        .ok_or_else(invalid)?
        .0
        .to_owned()
        + "/";
    let mut lines = text.lines();
    if lines.next() != Some("#EXTM3U") {
        return Err(invalid());
    }
    let mut singleton = HashSet::new();
    let mut target = None;
    let mut first = None;
    let mut base_disc = None;
    let mut disc = 0u64;
    let mut segments = Vec::new();
    let mut pending_duration = None;
    let mut pending_pdt = None;
    let mut next_pdt = None;
    let mut total = 0u64;
    let mut seen = HashSet::new();
    let mut pending_discontinuity = false;
    let mut ended = false;
    for line in lines {
        if line.len() > 8192 || line.ends_with('\r') {
            return Err(invalid());
        }
        if line.is_empty() {
            continue;
        }
        if ended {
            return Err(invalid());
        }
        if line == "#EXT-X-ENDLIST" {
            if segments.is_empty()
                || pending_duration.is_some()
                || pending_pdt.is_some()
                || pending_discontinuity
            {
                return Err(invalid());
            }
            ended = true;
            continue;
        }
        if line == "#EXT-X-DISCONTINUITY" {
            if pending_duration.is_some() || pending_discontinuity {
                return Err(invalid());
            }
            disc = disc
                .checked_add(1)
                .filter(|n| *n <= MAX_SEQUENCE)
                .ok_or_else(invalid)?;
            pending_discontinuity = true;
            next_pdt = None;
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            if pending_duration.is_some() || first.is_none() || target.is_none() {
                return Err(invalid());
            }
            let (seconds, title) = value.split_once(',').ok_or_else(invalid)?;
            if title.len() > 1024 {
                return Err(invalid());
            }
            pending_duration = Some(duration(seconds)?);
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-PROGRAM-DATE-TIME:") {
            if pending_pdt.is_some() {
                return Err(invalid());
            }
            pending_pdt = Some(parse_program_date_time(value)?);
            continue;
        }
        if line.starts_with("#EXT") {
            let (tag, value) = line
                .split_once(':')
                .map_or((line, None), |(a, b)| (a, Some(b)));
            if !segments.is_empty()
                || pending_duration.is_some()
                || !singleton.insert(tag.to_owned())
            {
                return Err(invalid());
            }
            match (tag, value) {
                ("#EXT-X-VERSION", Some(s)) => {
                    if !(3..=7).contains(&integer(s)?) {
                        return Err(invalid());
                    }
                }
                ("#EXT-X-TARGETDURATION", Some(s)) => {
                    let n = integer(s)?;
                    if !(1..=30).contains(&n) {
                        return Err(invalid());
                    }
                    target = Some(n as u32 * 1000);
                }
                ("#EXT-X-MEDIA-SEQUENCE", Some(s)) => first = Some(integer(s)?),
                ("#EXT-X-DISCONTINUITY-SEQUENCE", Some(s)) => {
                    if pending_discontinuity {
                        return Err(invalid());
                    }
                    let n = integer(s)?;
                    base_disc = Some(n);
                    disc = n;
                }
                ("#EXT-X-INDEPENDENT-SEGMENTS", None) => {}
                ("#EXT-X-ALLOW-CACHE", Some("YES" | "NO")) => {}
                _ => return Err(Error::Restricted("live_playlist_tag_denied")),
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let ms = pending_duration.take().ok_or_else(invalid)?;
        if segments.len() >= MAX_SEGMENTS
            || (ms as u64 + 500) / 1000 > target.ok_or_else(invalid)? as u64 / 1000
        {
            return Err(invalid());
        }
        total = total
            .checked_add(ms as u64)
            .filter(|n| *n <= MAX_WINDOW_MS)
            .ok_or_else(invalid)?;
        let sequence = first
            .ok_or_else(invalid)?
            .checked_add(segments.len() as u64)
            .filter(|n| *n <= MAX_SEQUENCE)
            .ok_or_else(invalid)?;
        let url = resolve_segment(provider, &base, &root, line)?;
        if !seen.insert(url.path().to_owned()) {
            return Err(Error::InvalidResponse("live_duplicate_segment"));
        }
        let explicit_pdt = pending_pdt.take();
        if let (Some(a), Some(b)) = (explicit_pdt, next_pdt)
            && a != b
        {
            return Err(Error::InvalidResponse("live_pdt_changed"));
        }
        let pdt = explicit_pdt.or(next_pdt);
        next_pdt = pdt
            .map(|n| n.checked_add(ms as i64).ok_or_else(invalid))
            .transpose()?;
        segments.push(Segment {
            sequence,
            discontinuity: disc,
            duration_ms: ms,
            url: url.to_string(),
            program_date_time_ms: pdt,
        });
        pending_discontinuity = false;
    }
    if segments.is_empty()
        || pending_duration.is_some()
        || pending_pdt.is_some()
        || pending_discontinuity
    {
        return Err(invalid());
    }
    let parsed = Playlist {
        provider,
        sequence: first.ok_or_else(invalid)?,
        discontinuity_sequence: base_disc.unwrap_or(0),
        target_duration_ms: target.ok_or_else(invalid)?,
        segments,
    };
    parsed.validate()?;
    if ended {
        return Err(Error::Restricted("live_broadcast_ended"));
    }
    Ok(parsed)
}
fn resolve_segment(provider: Provider, base: &Url, root: &str, value: &str) -> Result<Url> {
    if value.is_empty()
        || value.len() > 8192
        || !value.is_ascii()
        || value.bytes().any(|b| b <= b' ' || b == 127 || b == b'\\')
        || value.contains('#')
        || value.starts_with("//")
        || value
            .split('?')
            .next()
            .unwrap_or("")
            .split('/')
            .any(|p| matches!(p, "." | ".."))
    {
        return Err(Error::Restricted("live_segment_reference_denied"));
    }
    let url = base.join(value).map_err(|_| invalid())?;
    validate_segment_url(provider, url.as_str())?;
    if provider != Provider::YouTube
        && (url.origin() != base.origin() || !url.path().starts_with(root))
    {
        return Err(Error::Restricted("live_segment_scope_denied"));
    }
    Ok(url)
}
/// Bounded playlist fence owned by one immutable viewer/broadcast grant. Only
/// the latest window is retained; this is not a recording or DVR cache.
#[derive(Clone, Debug, Default)]
pub struct RollingWindow {
    latest: Option<Playlist>,
    last_advance: Option<std::time::Instant>,
}
impl RollingWindow {
    pub fn latest(&self) -> Option<&Playlist> {
        let playlist = self.latest.as_ref()?;
        if self.last_advance.is_none_or(|stamp| {
            stamp.elapsed()
                > std::time::Duration::from_millis(u64::from(playlist.target_duration_ms) * 3)
        }) {
            return None;
        }
        Some(playlist)
    }
    pub fn segment(&self, sequence: u64, discontinuity: u64) -> Option<&Segment> {
        self.latest()?
            .segments
            .iter()
            .find(|s| s.sequence == sequence && s.discontinuity == discontinuity)
    }
    pub fn accept(&mut self, next: Playlist) -> Result<()> {
        next.validate()?;
        if let Some(old) = &self.latest {
            if self.last_advance.is_none_or(|stamp| {
                stamp.elapsed()
                    > std::time::Duration::from_millis(u64::from(old.target_duration_ms) * 3)
            }) {
                return Err(Error::Restricted("live_playlist_stale"));
            }
            let last = old.segments.last().ok_or_else(invalid)?;
            if next.provider != old.provider
                || next.sequence < old.sequence
                || next.target_duration_ms != old.target_duration_ms
            {
                return Err(Error::Restricted("live_sequence_fence_changed"));
            }
            if next.sequence > last.sequence.saturating_add(1) {
                let first = next.segments.first().ok_or_else(invalid)?;
                let gap = next.sequence - last.sequence;
                // An expired moving window is distinct from a rewind or graph
                // mutation. It still cannot silently reset this grant's fence.
                if first.discontinuity < last.discontinuity
                    || first.discontinuity - last.discontinuity > gap
                {
                    return Err(Error::Restricted("live_discontinuity_fence_changed"));
                }
                return Err(Error::Restricted("live_window_expired"));
            }
            for segment in &next.segments {
                if let Some(previous) = old.segments.iter().find(|s| s.sequence == segment.sequence)
                {
                    let a = validate_segment_url(old.provider, &previous.url)?;
                    let b = validate_segment_url(next.provider, &segment.url)?;
                    if a.origin() != b.origin()
                        || a.path() != b.path()
                        || segment.discontinuity != previous.discontinuity
                        || segment.duration_ms != previous.duration_ms
                        || segment.program_date_time_ms != previous.program_date_time_ms
                    {
                        return Err(Error::Restricted("live_segment_fence_changed"));
                    }
                } else if segment.sequence == last.sequence + 1
                    && !(segment.discontinuity == last.discontinuity
                        || segment.discontinuity == last.discontinuity + 1)
                {
                    return Err(Error::Restricted("live_discontinuity_fence_changed"));
                }
            }
            if next
                .segments
                .last()
                .is_none_or(|s| s.sequence < last.sequence)
            {
                return Err(Error::Restricted("live_sequence_fence_changed"));
            }
        }
        if self.latest.as_ref().is_none_or(|old| {
            old.segments.last().map(|s| s.sequence) < next.segments.last().map(|s| s.sequence)
        }) {
            self.last_advance = Some(std::time::Instant::now());
        }
        self.latest = Some(next);
        Ok(())
    }
}
#[cfg(test)]
mod freshness_tests {
    use super::*;
    #[test]
    fn unchanged_sequence_cannot_refresh_or_resurrect_a_stale_graph() {
        let p = parse_playlist(
            Provider::TikTok,
            b"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:1.000,\n7.ts\n",
            "https://pull.tiktokcdn.com/stage/stream-7/index.m3u8",
        )
        .unwrap();
        let mut w = RollingWindow::default();
        w.accept(p.clone()).unwrap();
        let original = w.last_advance;
        w.accept(p.clone()).unwrap();
        assert_eq!(w.last_advance, original);
        w.last_advance = Some(std::time::Instant::now() - std::time::Duration::from_secs(4));
        assert!(w.latest().is_none());
        assert_eq!(
            w.accept(p).unwrap_err(),
            Error::Restricted("live_playlist_stale")
        );
    }
}
