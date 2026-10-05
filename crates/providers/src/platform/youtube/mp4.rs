//! Bounded discovery of the pragmatic, single-track SegmentBase MP4 subset.
//!
//! This is not a general ISO BMFF validator and does not inspect media samples,
//! `moof`/`mdat`, decode H.264/AAC, or prove that every indexed byte is playable.
//! It accepts a prefix containing `ftyp`, a complete fragmented `moov`, and one
//! flat `sidx`. Edits, encryption, external data references, multiple tracks,
//! unknown structural boxes, nonempty sample tables and hierarchical indexes
//! fail closed. Only version-0 `avc1`/AVC configurations and `mp4a`/AAC-LC with
//! an ordinary two-byte AudioSpecificConfig are supported.
//!
//! Initialization rules: https://www.w3.org/TR/mse-byte-stream-format-isobmff/
//! SIDX offset/timing model (independent implementation, no copied code):
//! https://github.com/Dash-Industry-Forum/dash.js/blob/development/src/dash/SegmentBaseLoader.js
//! Unlike dash.js's general discovery, this probe never scans past media boxes
//! or recursively downloads an index. Its four prefix requests share one
//! deadline and an aggregate 2 MiB ceiling. Production readers must validate
//! headers *before* streaming the body and enforce `max_body_bytes` while reading.

use std::{fmt, future::Future, pin::Pin};
use tokio::time::{Instant, timeout_at};

pub const MAX_PROBE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PROBE_REQUESTS: usize = 4;
const FIRST_BYTES: usize = 4096;
const MAX_BOXES: usize = 512;
const MAX_DEPTH: usize = 8;
const MAX_REFERENCES: usize = 4096;
const MAX_DURATION_SECONDS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeError {
    Unsupported,
    InvalidResponse,
    TooLarge,
    Deadline,
    Transport,
}
impl fmt::Display for ProbeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unsupported => "youtube_unsupported_mp4",
            Self::InvalidResponse => "youtube_invalid_range_response",
            Self::TooLarge => "youtube_probe_too_large",
            Self::Deadline => "youtube_probe_deadline",
            Self::Transport => "youtube_probe_transport",
        })
    }
}
impl std::error::Error for ProbeError {}
pub type Result<T> = std::result::Result<T, ProbeError>;

/// Inclusive byte range. Construction and arithmetic are checked by the probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}
impl ByteRange {
    /// Reversed endpoints do not name any bytes and are invalid probe requests.
    pub fn is_empty(self) -> bool {
        self.start > self.end
    }

    pub fn len(self) -> Result<usize> {
        let len = self
            .end
            .checked_sub(self.start)
            .and_then(|n| n.checked_add(1))
            .ok_or(ProbeError::InvalidResponse)?;
        usize::try_from(len).map_err(|_| ProbeError::TooLarge)
    }
    pub fn header(self) -> String {
        format!("bytes={}-{}", self.start, self.end)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Codec {
    Avc {
        rfc6381: String,
        width: u32,
        height: u32,
    },
    Av1 {
        rfc6381: String,
        width: u32,
        height: u32,
    },
    Vp9 {
        rfc6381: String,
        width: u32,
        height: u32,
    },
    HevcMain10 {
        rfc6381: String,
        width: u32,
        height: u32,
        color_primaries: u16,
        color_transfer: u16,
        color_space: u16,
        color_range: u8,
    },
    Hevc {
        rfc6381: String,
        width: u32,
        height: u32,
    },
    AacLc {
        sample_rate: u32,
        channels: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub range: ByteRange,
    pub duration_ticks: u32,
}

#[derive(Clone, PartialEq, Eq)]
pub struct Probe {
    pub initialization: ByteRange,
    pub index: ByteRange,
    pub track_id: u32,
    pub codec: Codec,
    pub timescale: u32,
    pub duration_ticks: u64,
    pub segments: Vec<Segment>,
    pub total_bytes: u64,
    /// Only a syntactically valid strong entity-tag; never a weak tag or date.
    pub strong_etag: Option<String>,
}

impl fmt::Debug for Probe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Probe")
            .field("initialization", &self.initialization)
            .field("index", &self.index)
            .field("track_id", &self.track_id)
            .field("codec", &self.codec)
            .field("timescale", &self.timescale)
            .field("duration_ticks", &self.duration_ticks)
            .field("segment_count", &self.segments.len())
            .field("total_bytes", &self.total_bytes)
            .field("has_strong_etag", &self.strong_etag.is_some())
            .finish()
    }
}

/// Raw occurrences, not a merged header map: duplicate critical headers fail.
/// The reader must bound other headers through its normal transport boundary.
#[derive(Clone, Default)]
pub struct RangeHeaders {
    pub content_range: Vec<String>,
    pub content_length: Vec<String>,
    pub content_encoding: Vec<String>,
    pub etag: Vec<String>,
    pub last_modified: Vec<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct RangeIdentity {
    pub total_bytes: u64,
    /// Kept for cross-request equality even when weak; not a strong validator.
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}
impl fmt::Debug for RangeIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RangeIdentity")
            .field("total_bytes", &self.total_bytes)
            .field("has_etag", &self.etag.is_some())
            .field("has_last_modified", &self.last_modified.is_some())
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct RangeRequest {
    pub range: ByteRange,
    pub deadline: Instant,
    pub max_body_bytes: usize,
    pub expected: Option<RangeIdentity>,
}

pub struct RangeResponse {
    pub status: u16,
    pub headers: RangeHeaders,
    pub body: Vec<u8>,
}
impl fmt::Debug for RangeResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RangeResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish_non_exhaustive()
    }
}

/// No URL or credentials are accepted here. Production owns a previously
/// authorized track and routes every request through PlatformHttp's fixed
/// provider-bound media policy. Dropping this future must drop the response stream.
/// Never collect a 200 response or retry a failed range with a full download.
pub trait RangeReader: Send + Sync {
    fn read<'a>(
        &'a self,
        request: RangeRequest,
    ) -> Pin<Box<dyn Future<Output = Result<RangeResponse>> + Send + 'a>>;
}

fn one(values: &[String], required: bool) -> Result<Option<&str>> {
    match values {
        [] if !required => Ok(None),
        [value]
            if value.len() <= 256
                && value.is_ascii()
                && !value.bytes().any(|b| b.is_ascii_control()) =>
        {
            Ok(Some(value.as_str()))
        }
        _ => Err(ProbeError::InvalidResponse),
    }
}
fn decimal(value: &str) -> Result<u64> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ProbeError::InvalidResponse);
    }
    value.parse().map_err(|_| ProbeError::InvalidResponse)
}
fn entity_tag(value: &str) -> bool {
    let value = value.strip_prefix("W/").unwrap_or(value);
    value.len() >= 2
        && value.starts_with('"')
        && value.ends_with('"')
        && value[1..value.len() - 1]
            .bytes()
            .all(|b| b == 0x21 || (0x23..=0x7e).contains(&b))
}

/// Call before consuming any body bytes. A 206 must describe exactly the
/// requested range with a known total, exact Content-Length and identity
/// encoding. Clipped ranges, multipart bodies and unknown totals are rejected.
/// An initial file smaller than FIRST_BYTES is deliberately outside this subset.
pub fn validate_range_headers(
    request: &RangeRequest,
    status: u16,
    headers: &RangeHeaders,
) -> Result<RangeIdentity> {
    if status != 206 {
        return Err(ProbeError::InvalidResponse);
    }
    let wanted = request.range.len()?;
    if wanted > request.max_body_bytes {
        return Err(ProbeError::TooLarge);
    }
    let length = decimal(one(&headers.content_length, true)?.ok_or(ProbeError::InvalidResponse)?)?;
    if length != wanted as u64 {
        return Err(ProbeError::InvalidResponse);
    }
    if one(&headers.content_encoding, false)?
        .is_some_and(|encoding| !encoding.eq_ignore_ascii_case("identity"))
    {
        return Err(ProbeError::InvalidResponse);
    }
    let value = one(&headers.content_range, true)?.ok_or(ProbeError::InvalidResponse)?;
    let value = value
        .strip_prefix("bytes ")
        .ok_or(ProbeError::InvalidResponse)?;
    let (range, total) = value.split_once('/').ok_or(ProbeError::InvalidResponse)?;
    let (start, end) = range.split_once('-').ok_or(ProbeError::InvalidResponse)?;
    let total = decimal(total)?;
    if decimal(start)? != request.range.start
        || decimal(end)? != request.range.end
        || total <= request.range.end
    {
        return Err(ProbeError::InvalidResponse);
    }
    let etag = one(&headers.etag, false)?;
    if etag.is_some_and(|tag| !entity_tag(tag)) {
        return Err(ProbeError::InvalidResponse);
    }
    let identity = RangeIdentity {
        total_bytes: total,
        etag: etag.map(str::to_owned),
        last_modified: one(&headers.last_modified, false)?.map(str::to_owned),
    };
    if request
        .expected
        .as_ref()
        .is_some_and(|expected| expected != &identity)
    {
        return Err(ProbeError::InvalidResponse);
    }
    Ok(identity)
}

pub async fn probe<R: RangeReader + ?Sized>(
    reader: &R,
    kind: TrackKind,
    deadline: Instant,
) -> Result<Probe> {
    probe_with_mode(reader, kind, deadline, VideoMode::NativeAvc).await
}

/// Source configuration discovery for explicitly requested private compatibility
/// input only. This does not expand native YouTube/browser codec selection.
pub async fn probe_clear_hevc_compatibility<R: RangeReader + ?Sized>(
    reader: &R,
    kind: TrackKind,
    deadline: Instant,
) -> Result<Probe> {
    probe_with_mode(reader, kind, deadline, VideoMode::ClearHevcCompatibility).await
}

async fn probe_with_mode<R: RangeReader + ?Sized>(
    reader: &R,
    kind: TrackKind,
    deadline: Instant,
    mode: VideoMode,
) -> Result<Probe> {
    let mut prefix = Vec::new();
    let mut needed = FIRST_BYTES;
    let mut identity: Option<RangeIdentity> = None;
    for _ in 0..MAX_PROBE_REQUESTS {
        if Instant::now() >= deadline {
            return Err(ProbeError::Deadline);
        }
        if needed <= prefix.len() || needed > MAX_PROBE_BYTES {
            return Err(ProbeError::TooLarge);
        }
        if identity
            .as_ref()
            .is_some_and(|id| needed as u64 > id.total_bytes)
        {
            return Err(ProbeError::Unsupported);
        }
        let request = RangeRequest {
            range: ByteRange {
                start: prefix.len() as u64,
                end: (needed - 1) as u64,
            },
            deadline,
            max_body_bytes: needed - prefix.len(),
            expected: identity.clone(),
        };
        let response = timeout_at(deadline, reader.read(request.clone()))
            .await
            .map_err(|_| ProbeError::Deadline)??;
        let observed = validate_range_headers(&request, response.status, &response.headers)?;
        if response.body.len() > request.max_body_bytes {
            return Err(ProbeError::TooLarge);
        }
        if response.body.len() != request.range.len()? {
            return Err(ProbeError::InvalidResponse);
        }
        prefix.extend_from_slice(&response.body);
        identity = Some(observed);
        let id = identity.as_ref().ok_or(ProbeError::InvalidResponse)?;
        let parsed = parse_prefix_with_mode(&prefix, id.total_bytes, kind, mode);
        if Instant::now() >= deadline {
            return Err(ProbeError::Deadline);
        }
        match parsed? {
            Prefix::Complete(mut result) => {
                result.strong_etag = id
                    .etag
                    .as_ref()
                    .filter(|tag| !tag.starts_with("W/"))
                    .cloned();
                if Instant::now() >= deadline {
                    return Err(ProbeError::Deadline);
                }
                return Ok(result);
            }
            Prefix::Need(end) => needed = end,
        }
    }
    Err(ProbeError::TooLarge)
}

/// Configuration facts from an exact, bounded initialization range. This does
/// not inspect SIDX, media samples, timestamps or the rest of the resource.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Initialization {
    pub track_id: u32,
    pub codec: Codec,
}

/// Inspect a complete ftyp + clear fragmented single-track moov range. Callers
/// must separately authenticate the selected source and validate HTTP framing
/// before collecting these bytes; no URL, Cookie or transport is accepted here.
pub fn parse_initialization(bytes: &[u8], kind: TrackKind) -> Result<Initialization> {
    if bytes.len() > MAX_PROBE_BYTES {
        return Err(ProbeError::TooLarge);
    }
    let mut parser = Parser {
        count: 0,
        mode: VideoMode::NativeAvc,
    };
    let boxes = parser.children(bytes, 0)?;
    allowed(&boxes, &[*b"ftyp", *b"moov", *b"free"])?;
    if boxes.first().is_none_or(|b| b.kind != *b"ftyp") {
        return Err(ProbeError::Unsupported);
    }
    let ftyp = unique(&boxes, b"ftyp")?;
    if ftyp.payload.len() > 248
        || boxes
            .iter()
            .any(|b| b.kind == *b"free" && b.payload.len() > 64 * 1024 - 8)
    {
        return Err(ProbeError::Unsupported);
    }
    parse_ftyp(ftyp.payload, VideoMode::NativeAvc)?;
    let track = parse_moov(&mut parser, unique(&boxes, b"moov")?.payload, kind)?;
    Ok(Initialization {
        track_id: track.id,
        codec: track.codec,
    })
}

enum Prefix {
    Need(usize),
    Complete(Probe),
}

#[derive(Clone, Copy)]
struct BoxView<'a> {
    kind: [u8; 4],
    payload: &'a [u8],
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum VideoMode {
    NativeAvc,
    ClearHevcCompatibility,
}
struct Parser {
    count: usize,
    mode: VideoMode,
}
impl Parser {
    fn children<'a>(&mut self, bytes: &'a [u8], depth: usize) -> Result<Vec<BoxView<'a>>> {
        if depth > MAX_DEPTH {
            return Err(ProbeError::Unsupported);
        }
        let mut boxes = Vec::new();
        let mut position = 0;
        while position < bytes.len() {
            self.count = self.count.checked_add(1).ok_or(ProbeError::TooLarge)?;
            if self.count > MAX_BOXES {
                return Err(ProbeError::TooLarge);
            }
            let (size, header, kind) = box_header(&bytes[position..])?;
            let end = position.checked_add(size).ok_or(ProbeError::Unsupported)?;
            if end > bytes.len() {
                return Err(ProbeError::Unsupported);
            }
            boxes.push(BoxView {
                kind,
                payload: &bytes[position + header..end],
            });
            position = end;
        }
        Ok(boxes)
    }
}
fn u16_at(bytes: &[u8], at: usize) -> Result<u16> {
    let value = bytes
        .get(at..at.checked_add(2).ok_or(ProbeError::Unsupported)?)
        .ok_or(ProbeError::Unsupported)?;
    Ok(u16::from_be_bytes([value[0], value[1]]))
}
fn u32_at(bytes: &[u8], at: usize) -> Result<u32> {
    let value = bytes
        .get(at..at.checked_add(4).ok_or(ProbeError::Unsupported)?)
        .ok_or(ProbeError::Unsupported)?;
    Ok(u32::from_be_bytes([value[0], value[1], value[2], value[3]]))
}
fn u64_at(bytes: &[u8], at: usize) -> Result<u64> {
    let hi = u32_at(bytes, at)? as u64;
    let lo = u32_at(bytes, at.checked_add(4).ok_or(ProbeError::Unsupported)?)? as u64;
    Ok((hi << 32) | lo)
}
fn box_header(bytes: &[u8]) -> Result<(usize, usize, [u8; 4])> {
    let size = u32_at(bytes, 0)?;
    let kind = bytes.get(4..8).ok_or(ProbeError::Unsupported)?;
    let (size, header) = match size {
        0 => return Err(ProbeError::Unsupported),
        1 => (
            usize::try_from(u64_at(bytes, 8)?).map_err(|_| ProbeError::TooLarge)?,
            16,
        ),
        size => (size as usize, 8),
    };
    if size < header {
        return Err(ProbeError::Unsupported);
    }
    Ok((size, header, [kind[0], kind[1], kind[2], kind[3]]))
}
fn full(bytes: &[u8], version: u8, flags: u32) -> Result<()> {
    if u32_at(bytes, 0)? != ((version as u32) << 24) | flags {
        return Err(ProbeError::Unsupported);
    }
    Ok(())
}
fn zero(bytes: &[u8]) -> Result<()> {
    if bytes.iter().any(|&b| b != 0) {
        return Err(ProbeError::Unsupported);
    }
    Ok(())
}
fn exact(bytes: &[u8], len: usize) -> Result<()> {
    if bytes.len() != len {
        return Err(ProbeError::Unsupported);
    }
    Ok(())
}
fn unique<'a>(boxes: &[BoxView<'a>], kind: &[u8; 4]) -> Result<BoxView<'a>> {
    let mut matches = boxes.iter().filter(|b| &b.kind == kind);
    let result = *matches.next().ok_or(ProbeError::Unsupported)?;
    if matches.next().is_some() {
        return Err(ProbeError::Unsupported);
    }
    Ok(result)
}
fn allowed(boxes: &[BoxView<'_>], kinds: &[[u8; 4]]) -> Result<()> {
    if boxes.iter().any(|b| !kinds.contains(&b.kind)) {
        return Err(ProbeError::Unsupported);
    }
    // Padding may repeat; every semantic box in the supported subset is unique.
    for kind in kinds.iter().filter(|kind| *kind != b"free") {
        if boxes.iter().filter(|b| &b.kind == kind).count() > 1 {
            return Err(ProbeError::Unsupported);
        }
    }
    Ok(())
}

/// Pure prefix parser. `Need` is the minimum contiguous prefix length to fetch,
/// not permission to search the rest of the file. Prefixes and declared boxes
/// beyond 2 MiB are refused even when the caller already holds larger data.
#[cfg(test)]
fn parse_prefix(bytes: &[u8], total: u64, kind: TrackKind) -> Result<Prefix> {
    parse_prefix_with_mode(bytes, total, kind, VideoMode::NativeAvc)
}
fn parse_prefix_with_mode(
    bytes: &[u8],
    total: u64,
    kind: TrackKind,
    mode: VideoMode,
) -> Result<Prefix> {
    if bytes.len() > MAX_PROBE_BYTES {
        return Err(ProbeError::TooLarge);
    }
    if total < bytes.len() as u64 || total == 0 {
        return Err(ProbeError::Unsupported);
    }
    let mut parser = Parser { count: 0, mode };
    let mut position = 0usize;
    let mut moov = None;
    let mut initialization = None;
    let mut seen_ftyp = false;
    loop {
        parser.count += 1;
        if parser.count > MAX_BOXES {
            return Err(ProbeError::TooLarge);
        }
        let available = bytes.len().saturating_sub(position);
        if available < 8 {
            return need(position.checked_add(8), total);
        }
        if u32_at(bytes, position)? == 1 && available < 16 {
            return need(position.checked_add(16), total);
        }
        let (size, header, box_kind) = box_header(&bytes[position..])?;
        let end = position.checked_add(size).ok_or(ProbeError::Unsupported)?;
        if end > MAX_PROBE_BYTES {
            return Err(ProbeError::TooLarge);
        }
        if end as u64 > total {
            return Err(ProbeError::Unsupported);
        }
        match &box_kind {
            b"ftyp" if position == 0 && !seen_ftyp => {
                if size > 256 {
                    return Err(ProbeError::Unsupported);
                }
            }
            b"moov" if seen_ftyp && moov.is_none() => {}
            b"sidx" if moov.is_some() => {}
            b"free" if seen_ftyp && size <= 64 * 1024 => {}
            _ => return Err(ProbeError::Unsupported),
        }
        if end > bytes.len() {
            // Fetch the known box and enough bytes for the following header in
            // one request. A large-size next header may require one more request.
            let next = if &box_kind == b"sidx" {
                Some(end)
            } else {
                end.checked_add(8)
            };
            return need(next, total);
        }
        let payload = &bytes[position + header..end];
        match &box_kind {
            b"ftyp" => {
                parse_ftyp(payload, mode)?;
                seen_ftyp = true;
            }
            b"moov" => {
                moov = Some(parse_moov(&mut parser, payload, kind)?);
                initialization = Some(ByteRange {
                    start: 0,
                    end: (end - 1) as u64,
                });
            }
            b"sidx" => {
                let track = moov.ok_or(ProbeError::Unsupported)?;
                let (timescale, duration_ticks, segments) =
                    parse_sidx(payload, end as u64, total, &track, kind)?;
                return Ok(Prefix::Complete(Probe {
                    initialization: initialization.ok_or(ProbeError::Unsupported)?,
                    index: ByteRange {
                        start: position as u64,
                        end: (end - 1) as u64,
                    },
                    track_id: track.id,
                    codec: track.codec,
                    timescale,
                    duration_ticks,
                    segments,
                    total_bytes: total,
                    strong_etag: None,
                }));
            }
            b"free" => {}
            _ => return Err(ProbeError::Unsupported),
        }
        position = end;
    }
}
fn need(end: Option<usize>, total: u64) -> Result<Prefix> {
    let end = end.ok_or(ProbeError::TooLarge)?;
    if end > MAX_PROBE_BYTES {
        return Err(ProbeError::TooLarge);
    }
    if end as u64 > total {
        return Err(ProbeError::Unsupported);
    }
    Ok(Prefix::Need(end))
}
fn parse_ftyp(bytes: &[u8], mode: VideoMode) -> Result<()> {
    if bytes.len() < 12 || !(bytes.len() - 8).is_multiple_of(4) {
        return Err(ProbeError::Unsupported);
    }
    let native_brands = [
        *b"isom", *b"iso2", *b"iso5", *b"iso6", *b"mp41", *b"mp42", *b"avc1", *b"dash",
    ];
    let compatible: &[[u8; 4]] = if mode == VideoMode::ClearHevcCompatibility {
        &[
            *b"isom", *b"iso2", *b"iso5", *b"iso6", *b"mp41", *b"mp42", *b"avc1", *b"dash",
            *b"hvc1", *b"hev1", *b"av01", *b"vp09",
        ]
    } else {
        &native_brands
    };
    if !compatible.iter().any(|brand| &bytes[..4] == brand) {
        return Err(ProbeError::Unsupported);
    }
    // Unsupported compatibility declarations (including protected formats) are
    // not silently treated as an unprotected ISO base-media profile.
    if bytes[8..]
        .as_chunks::<4>()
        .0
        .iter()
        .any(|brand| !compatible.iter().any(|known| brand == known))
    {
        return Err(ProbeError::Unsupported);
    }
    Ok(())
}

struct Track {
    id: u32,
    codec: Codec,
}
fn parse_moov(parser: &mut Parser, bytes: &[u8], kind: TrackKind) -> Result<Track> {
    let boxes = parser.children(bytes, 1)?;
    allowed(&boxes, &[*b"mvhd", *b"trak", *b"mvex", *b"free"])?;
    let mvhd = unique(&boxes, b"mvhd")?.payload;
    parse_movie_header(mvhd)?;
    let track = parse_trak(parser, unique(&boxes, b"trak")?.payload, kind)?;
    let mvex = parser.children(unique(&boxes, b"mvex")?.payload, 2)?;
    allowed(&mvex, &[*b"trex", *b"mehd", *b"free"])?;
    let trex = unique(&mvex, b"trex")?.payload;
    full(trex, 0, 0)?;
    exact(trex, 24)?;
    if u32_at(trex, 4)? != track.id || u32_at(trex, 8)? != 1 {
        return Err(ProbeError::Unsupported);
    }
    if let Some(mehd) = mvex.iter().find(|b| &b.kind == b"mehd") {
        match mehd.payload.first() {
            Some(0) => {
                full(mehd.payload, 0, 0)?;
                exact(mehd.payload, 8)?;
            }
            Some(1) => {
                full(mehd.payload, 1, 0)?;
                exact(mehd.payload, 12)?;
            }
            _ => return Err(ProbeError::Unsupported),
        }
    }
    Ok(track)
}
fn parse_movie_header(bytes: &[u8]) -> Result<()> {
    let (len, timescale_at) = match bytes.first() {
        Some(0) => (100, 12),
        Some(1) => (112, 20),
        _ => return Err(ProbeError::Unsupported),
    };
    full(bytes, bytes[0], 0)?;
    exact(bytes, len)?;
    if u32_at(bytes, timescale_at)? == 0 {
        return Err(ProbeError::Unsupported);
    }
    Ok(())
}
fn matrix(bytes: &[u8]) -> Result<()> {
    exact(bytes, 36)?;
    for (at, expected) in [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]
        .iter()
        .enumerate()
    {
        if u32_at(bytes, at * 4)? != *expected {
            return Err(ProbeError::Unsupported);
        }
    }
    Ok(())
}
fn parse_trak(parser: &mut Parser, bytes: &[u8], kind: TrackKind) -> Result<Track> {
    let boxes = parser.children(bytes, 2)?;
    allowed(&boxes, &[*b"tkhd", *b"mdia", *b"free"])?; // `edts` deliberately rejected.
    let tkhd = unique(&boxes, b"tkhd")?.payload;
    let (len, id_at, matrix_at) = match tkhd.first() {
        Some(0) => (84, 12, 40),
        Some(1) => (96, 20, 52),
        _ => return Err(ProbeError::Unsupported),
    };
    exact(tkhd, len)?;
    let flags = u32_at(tkhd, 0)? & 0x00ff_ffff;
    if flags & !7 != 0 || flags & 3 != 3 {
        return Err(ProbeError::Unsupported);
    }
    let id = u32_at(tkhd, id_at)?;
    if id == 0 {
        return Err(ProbeError::Unsupported);
    }
    matrix(&tkhd[matrix_at..matrix_at + 36])?;
    let width = u32_at(tkhd, len - 8)?;
    let height = u32_at(tkhd, len - 4)?;
    if width & 0xffff != 0 || height & 0xffff != 0 {
        return Err(ProbeError::Unsupported);
    }
    let mdia = parser.children(unique(&boxes, b"mdia")?.payload, 3)?;
    allowed(&mdia, &[*b"mdhd", *b"hdlr", *b"minf", *b"free"])?;
    let mdhd = unique(&mdia, b"mdhd")?.payload;
    let (len, timescale_at) = match mdhd.first() {
        Some(0) => (24, 12),
        Some(1) => (36, 20),
        _ => return Err(ProbeError::Unsupported),
    };
    full(mdhd, mdhd[0], 0)?;
    exact(mdhd, len)?;
    let timescale = u32_at(mdhd, timescale_at)?;
    if timescale == 0 {
        return Err(ProbeError::Unsupported);
    }
    let hdlr = unique(&mdia, b"hdlr")?.payload;
    full(hdlr, 0, 0)?;
    if hdlr.len() < 25
        || hdlr.len() > 280
        || u32_at(hdlr, 4)? != 0
        || &hdlr[8..12]
            != match kind {
                TrackKind::Video => b"vide",
                TrackKind::Audio => b"soun",
            }
        || hdlr.last() != Some(&0)
    {
        return Err(ProbeError::Unsupported);
    }
    zero(&hdlr[12..24])?;
    let codec = parse_minf(parser, unique(&mdia, b"minf")?.payload, kind)?;
    match &codec {
        Codec::Avc {
            width: w,
            height: h,
            ..
        }
        | Codec::Av1 {
            width: w,
            height: h,
            ..
        }
        | Codec::Vp9 {
            width: w,
            height: h,
            ..
        }
        | Codec::HevcMain10 {
            width: w,
            height: h,
            ..
        }
        | Codec::Hevc {
            width: w,
            height: h,
            ..
        } if width >> 16 == *w && height >> 16 == *h => {}
        Codec::AacLc { sample_rate, .. }
            if width == 0 && height == 0 && timescale == *sample_rate => {}
        _ => return Err(ProbeError::Unsupported),
    }
    Ok(Track { id, codec })
}
fn parse_minf(parser: &mut Parser, bytes: &[u8], kind: TrackKind) -> Result<Codec> {
    let boxes = parser.children(bytes, 4)?;
    let header_kind = match kind {
        TrackKind::Video => *b"vmhd",
        TrackKind::Audio => *b"smhd",
    };
    allowed(&boxes, &[header_kind, *b"dinf", *b"stbl", *b"free"])?;
    let header = unique(&boxes, &header_kind)?.payload;
    match kind {
        TrackKind::Video => {
            full(header, 0, 1)?;
            exact(header, 12)?;
            zero(&header[4..])?;
        }
        TrackKind::Audio => {
            full(header, 0, 0)?;
            exact(header, 8)?;
            zero(&header[4..])?;
        }
    }
    let dinf = parser.children(unique(&boxes, b"dinf")?.payload, 5)?;
    allowed(&dinf, &[*b"dref"])?;
    let dref = unique(&dinf, b"dref")?.payload;
    full(dref, 0, 0)?;
    if u32_at(dref, 4)? != 1 {
        return Err(ProbeError::Unsupported);
    }
    let references = parser.children(dref.get(8..).ok_or(ProbeError::Unsupported)?, 6)?;
    allowed(&references, &[*b"url "])?;
    let url = unique(&references, b"url ")?.payload;
    full(url, 0, 1)?;
    exact(url, 4)?; // Self-contained; external URL/URN never accepted.
    parse_stbl(parser, unique(&boxes, b"stbl")?.payload, kind)
}
fn parse_stbl(parser: &mut Parser, bytes: &[u8], kind: TrackKind) -> Result<Codec> {
    let boxes = parser.children(bytes, 5)?;
    allowed(
        &boxes,
        &[
            *b"stsd", *b"stts", *b"stsc", *b"stsz", *b"stco", *b"co64", *b"stss", *b"ctts",
            *b"free",
        ],
    )?;
    for name in [b"stts", b"stsc"] {
        let table = unique(&boxes, name)?.payload;
        full(table, 0, 0)?;
        exact(table, 8)?;
        if u32_at(table, 4)? != 0 {
            return Err(ProbeError::Unsupported);
        }
    }
    let offsets: Vec<_> = boxes
        .iter()
        .filter(|b| matches!(&b.kind, b"stco" | b"co64"))
        .collect();
    if offsets.len() != 1 {
        return Err(ProbeError::Unsupported);
    }
    full(offsets[0].payload, 0, 0)?;
    exact(offsets[0].payload, 8)?;
    if u32_at(offsets[0].payload, 4)? != 0 {
        return Err(ProbeError::Unsupported);
    }
    let sizes = unique(&boxes, b"stsz")?.payload;
    full(sizes, 0, 0)?;
    exact(sizes, 12)?;
    zero(&sizes[4..])?;
    for table in boxes
        .iter()
        .filter(|b| matches!(&b.kind, b"stss" | b"ctts"))
    {
        let version = table
            .payload
            .first()
            .copied()
            .ok_or(ProbeError::Unsupported)?;
        if version != 0 && !(version == 1 && &table.kind == b"ctts") {
            return Err(ProbeError::Unsupported);
        }
        full(table.payload, version, 0)?;
        exact(table.payload, 8)?;
        if u32_at(table.payload, 4)? != 0 {
            return Err(ProbeError::Unsupported);
        }
    }
    let stsd = unique(&boxes, b"stsd")?.payload;
    full(stsd, 0, 0)?;
    if u32_at(stsd, 4)? != 1 {
        return Err(ProbeError::Unsupported);
    }
    let entries = parser.children(stsd.get(8..).ok_or(ProbeError::Unsupported)?, 6)?;
    let supported: &[[u8; 4]] = match kind {
        TrackKind::Video if parser.mode == VideoMode::ClearHevcCompatibility => {
            &[*b"avc1", *b"hvc1", *b"hev1", *b"av01", *b"vp09"]
        }
        TrackKind::Video => &[*b"avc1"],
        TrackKind::Audio => &[*b"mp4a"],
    };
    allowed(&entries, supported)?;
    if entries.len() != 1 {
        return Err(ProbeError::Unsupported);
    }
    let entry_kind = entries[0].kind;
    let entry = entries[0].payload;
    let reserved = entry.get(..6).ok_or(ProbeError::Unsupported)?;
    zero(reserved)?;
    if u16_at(entry, 6)? != 1 {
        return Err(ProbeError::Unsupported);
    }
    match kind {
        TrackKind::Video if entry_kind == *b"avc1" => parse_avc(parser, entry),
        TrackKind::Video if matches!(&entry_kind, b"av01" | b"vp09") => {
            extended::parse(parser, entry, entry_kind)
        }
        TrackKind::Video => hevc::parse_hevc(parser, entry, entry_kind),
        TrackKind::Audio => parse_aac(parser, entry),
    }
}
fn parse_avc(parser: &mut Parser, bytes: &[u8]) -> Result<Codec> {
    let fixed = bytes.get(..78).ok_or(ProbeError::Unsupported)?;
    zero(&fixed[8..24])?;
    let width = u16_at(bytes, 24)? as u32;
    let height = u16_at(bytes, 26)? as u32;
    if width == 0
        || height == 0
        || width > 16_384
        || height > 16_384
        || u32_at(bytes, 28)? != 0x0048_0000
        || u32_at(bytes, 32)? != 0x0048_0000
        || u32_at(bytes, 36)? != 0
        || u16_at(bytes, 40)? != 1
        || bytes[42] > 31
        || u16_at(bytes, 74)? != 24
        || u16_at(bytes, 76)? != 0xffff
    {
        return Err(ProbeError::Unsupported);
    }
    let boxes = parser.children(&bytes[78..], 7)?;
    allowed(&boxes, &[*b"avcC", *b"btrt", *b"pasp", *b"colr"])?;
    for item in &boxes {
        match &item.kind {
            b"btrt" => exact(item.payload, 12)?,
            b"pasp" => {
                exact(item.payload, 8)?;
                if u32_at(item.payload, 0)? == 0
                    || u32_at(item.payload, 0)? != u32_at(item.payload, 4)?
                {
                    return Err(ProbeError::Unsupported);
                }
            }
            b"colr" => {
                if (item.payload.len() != 11 || &item.payload[..4] != b"nclx")
                    && (item.payload.len() != 10 || &item.payload[..4] != b"nclc")
                {
                    return Err(ProbeError::Unsupported);
                }
                if item.payload.len() == 11 && item.payload[10] & 0x7f != 0 {
                    return Err(ProbeError::Unsupported);
                }
            }
            _ => {}
        }
    }
    let config = unique(&boxes, b"avcC")?.payload;
    if config.len() < 7
        || config[0] != 1
        || !matches!(config[1], 66 | 77 | 100)
        || config[2] & 3 != 0
        || !matches!(config[3], 10..=13 | 20..=22 | 30..=32 | 40..=42 | 50..=52 | 60..=62)
        || config[4] != 0xff
        || config[5] & 0xe0 != 0xe0
    {
        return Err(ProbeError::Unsupported);
    }
    let sps_count = config[5] & 0x1f;
    if sps_count == 0 {
        return Err(ProbeError::Unsupported);
    }
    let mut at = 6;
    for _ in 0..sps_count {
        let sps = nal(config, &mut at, 7)?;
        if sps.len() < 4 || sps[1..4] != config[1..4] {
            return Err(ProbeError::Unsupported);
        }
    }
    let pps_count = *config.get(at).ok_or(ProbeError::Unsupported)?;
    at += 1;
    if pps_count == 0 {
        return Err(ProbeError::Unsupported);
    }
    for _ in 0..pps_count {
        nal(config, &mut at, 8)?;
    }
    if at != config.len() {
        // Optional high-profile extension: ordinary 8-bit 4:2:0 and no SPS-ext.
        if config[1] != 100 || config.get(at..) != Some(&[0xfd, 0xf8, 0xf8, 0][..]) {
            return Err(ProbeError::Unsupported);
        }
    }
    Ok(Codec::Avc {
        rfc6381: format!("avc1.{:02x}{:02x}{:02x}", config[1], config[2], config[3]),
        width,
        height,
    })
}
fn nal<'a>(bytes: &'a [u8], at: &mut usize, kind: u8) -> Result<&'a [u8]> {
    let length = u16_at(bytes, *at)? as usize;
    *at = at.checked_add(2).ok_or(ProbeError::Unsupported)?;
    let end = at.checked_add(length).ok_or(ProbeError::Unsupported)?;
    let data = bytes.get(*at..end).ok_or(ProbeError::Unsupported)?;
    if length < 2 || data[0] & 0x80 != 0 || data[0] & 0x60 == 0 || data[0] & 0x1f != kind {
        return Err(ProbeError::Unsupported);
    }
    *at = end;
    Ok(data)
}
fn descriptor<'a>(bytes: &'a [u8], at: &mut usize, tag: u8) -> Result<&'a [u8]> {
    if bytes.get(*at) != Some(&tag) {
        return Err(ProbeError::Unsupported);
    }
    *at += 1;
    let mut len = 0usize;
    let mut ended = false;
    for _ in 0..4 {
        let byte = *bytes.get(*at).ok_or(ProbeError::Unsupported)?;
        *at += 1;
        len = len
            .checked_mul(128)
            .and_then(|n| n.checked_add((byte & 0x7f) as usize))
            .ok_or(ProbeError::Unsupported)?;
        if byte & 0x80 == 0 {
            ended = true;
            break;
        }
    }
    if !ended {
        return Err(ProbeError::Unsupported);
    }
    let end = at.checked_add(len).ok_or(ProbeError::Unsupported)?;
    let result = bytes.get(*at..end).ok_or(ProbeError::Unsupported)?;
    *at = end;
    Ok(result)
}
fn parse_aac(parser: &mut Parser, bytes: &[u8]) -> Result<Codec> {
    let fixed = bytes.get(..28).ok_or(ProbeError::Unsupported)?;
    zero(&fixed[8..16])?; // QuickTime version/revision/vendor extensions unsupported.
    let channels = u16_at(bytes, 16)?;
    let rate = u32_at(bytes, 24)?;
    if !matches!(channels, 1 | 2)
        || u16_at(bytes, 18)? != 16
        || u32_at(bytes, 20)? != 0
        || rate & 0xffff != 0
        || rate >> 16 == 0
    {
        return Err(ProbeError::Unsupported);
    }
    let boxes = parser.children(&bytes[28..], 7)?;
    allowed(&boxes, &[*b"esds", *b"btrt"])?;
    if let Some(btrt) = boxes.iter().find(|b| &b.kind == b"btrt") {
        exact(btrt.payload, 12)?;
    }
    let esds = unique(&boxes, b"esds")?.payload;
    full(esds, 0, 0)?;
    let mut at = 4;
    let es = descriptor(esds, &mut at, 3)?;
    if at != esds.len() || es.len() < 3 || es[2] != 0 {
        return Err(ProbeError::Unsupported);
    }
    let mut at = 3;
    let config = descriptor(es, &mut at, 4)?;
    let sl = descriptor(es, &mut at, 6)?;
    if at != es.len() || sl != [2] || config.len() < 13 || config[0] != 0x40 || config[1] != 0x15 {
        return Err(ProbeError::Unsupported);
    }
    let mut at = 13;
    let asc = descriptor(config, &mut at, 5)?;
    if at != config.len() || asc.len() != 2 {
        return Err(ProbeError::Unsupported);
    }
    let bits = u16::from_be_bytes([asc[0], asc[1]]);
    let object = bits >> 11;
    let frequency = (bits >> 7) & 15;
    let configured_channels = (bits >> 3) & 15;
    let frequencies = [
        96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
    ];
    let sample_rate = *frequencies
        .get(frequency as usize)
        .ok_or(ProbeError::Unsupported)?;
    if object != 2 || configured_channels != channels || bits & 7 != 0 || sample_rate != rate >> 16
    {
        return Err(ProbeError::Unsupported);
    }
    Ok(Codec::AacLc {
        sample_rate,
        channels,
    })
}
fn parse_sidx(
    bytes: &[u8],
    box_end: u64,
    total: u64,
    track: &Track,
    kind: TrackKind,
) -> Result<(u32, u64, Vec<Segment>)> {
    let (earliest, offset, count_at) = match bytes.first() {
        Some(0) => {
            full(bytes, 0, 0)?;
            (u32_at(bytes, 12)? as u64, u32_at(bytes, 16)? as u64, 22)
        }
        Some(1) => {
            full(bytes, 1, 0)?;
            (u64_at(bytes, 12)?, u64_at(bytes, 20)?, 30)
        }
        _ => return Err(ProbeError::Unsupported),
    };
    let timescale = u32_at(bytes, 8)?;
    if u32_at(bytes, 4)? != track.id
        || timescale == 0
        || earliest != 0
        || u16_at(bytes, count_at - 2)? != 0
    {
        return Err(ProbeError::Unsupported);
    }
    let count = u16_at(bytes, count_at)? as usize;
    if count == 0 || count > MAX_REFERENCES {
        return Err(ProbeError::Unsupported);
    }
    exact(bytes, count_at + 2 + count * 12)?;
    let mut position = box_end.checked_add(offset).ok_or(ProbeError::Unsupported)?;
    let mut duration = 0u64;
    let mut segments = Vec::with_capacity(count);
    for index in 0..count {
        let at = count_at + 2 + index * 12;
        let size = u32_at(bytes, at)?;
        let ticks = u32_at(bytes, at + 4)?;
        let sap = u32_at(bytes, at + 8)?;
        if size & 0x8000_0000 != 0 || size == 0 || ticks == 0 {
            return Err(ProbeError::Unsupported);
        }
        let starts_with_sap = sap >> 31 == 1;
        let sap_type = (sap >> 28) & 7;
        let sap_delta = sap & 0x0fff_ffff;
        if sap_type > 6
            || (kind == TrackKind::Video
                && (!starts_with_sap || !matches!(sap_type, 1 | 2) || sap_delta != 0))
        {
            return Err(ProbeError::Unsupported);
        }
        let end = position
            .checked_add(size as u64)
            .ok_or(ProbeError::Unsupported)?;
        if end > total {
            return Err(ProbeError::Unsupported);
        }
        duration = duration
            .checked_add(ticks as u64)
            .ok_or(ProbeError::Unsupported)?;
        segments.push(Segment {
            range: ByteRange {
                start: position,
                end: end - 1,
            },
            duration_ticks: ticks,
        });
        position = end;
    }
    if duration
        > MAX_DURATION_SECONDS
            .checked_mul(timescale as u64)
            .ok_or(ProbeError::Unsupported)?
    {
        return Err(ProbeError::Unsupported);
    }
    Ok((timescale, duration, segments))
}

#[cfg(test)]
#[path = "mp4/tests.rs"]
mod tests;

#[path = "mp4/hevc.rs"]
mod hevc;
/// Strict metadata prefilter only; admission still requires the byte probe.
pub fn valid_clear_hevc_codec(value: &str) -> bool {
    hevc::valid_codec_string(value)
}

#[path = "mp4/extended.rs"]
mod extended;
pub fn valid_clear_extended_codec(value: &str) -> bool {
    valid_clear_hevc_codec(value) || extended::valid_av1(value) || extended::valid_vp9(value)
}
pub fn clear_extended_codec_equivalent(actual: &str, expected: &str) -> bool {
    extended::equivalent(actual, expected)
}

pub fn clear_extended_codec_hint(actual: &str, declared: &str) -> bool {
    clear_extended_codec_equivalent(actual, declared)
        || match declared {
            "vp9" => actual.starts_with("vp09.00."),
            "vp9.2" => actual.starts_with("vp09.02."),
            "av1" => actual.starts_with("av01.0."),
            _ => false,
        }
}
pub fn valid_clear_extended_codec_hint(value: &str) -> bool {
    (valid_clear_extended_codec(value)
        && !value.starts_with("hvc1.1.")
        && !value.starts_with("hev1.1."))
        || matches!(value, "vp9" | "vp9.2" | "av1")
}

impl Codec {
    pub fn source_expectation(&self) -> Option<media_core::advanced_media::VideoSourceExpectation> {
        match self {
            Self::Av1 {
                rfc6381,
                width,
                height,
            }
            | Self::Vp9 {
                rfc6381,
                width,
                height,
            } => media_core::advanced_media::VideoSourceExpectation::from_configuration(
                rfc6381, *width, *height,
            )
            .ok(),
            Self::HevcMain10 {
                rfc6381,
                width,
                height,
                color_primaries,
                color_transfer,
                color_space,
                color_range,
            } => {
                let mut e = media_core::advanced_media::VideoSourceExpectation::from_configuration(
                    rfc6381, *width, *height,
                )
                .ok()?;
                e.set_color(
                    *color_primaries,
                    *color_transfer,
                    *color_space,
                    *color_range,
                )
                .ok()?;
                e.validate().ok()?;
                Some(e)
            }
            _ => None,
        }
    }
}

/// Shared finite AV1CodecConfigurationRecord framing for private containers.
/// This does not validate an entire sequence header or elementary bitstream.
pub fn av1_configuration_depth(bytes: &[u8]) -> Result<u8> {
    extended::av1_configuration_depth(bytes)
}
