//! Fail-closed, bounded source-timeline prerequisite for a captured static HLS
//! closure. This module neither fetches resources nor grants playback authority.
//! Probe JSON is evidence only when the caller binds a successfully reaped,
//! error-free decoder to an immutable snapshot of these exact resource bytes.
//!
//! Media bytes are consumed one resource at a time. Only bounded sample tables,
//! codec configurations and byte identities remain in the accumulator.
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
pub const MAX_INIT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_RESOURCE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_SEGMENTS: usize = 64;
pub const MAX_SECONDS: f64 = 300.0;
pub const MAX_RECORDS: usize = 70_000;
pub const MAX_DECODER_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_DECODE_MILLISECONDS: u64 = 35_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CODEC_BYTES: usize = 65_536;
const DURATION_TOLERANCE: f64 = 0.000_001_1;

fn check(condition: bool, reason: &str) -> Result<()> {
    ensure!(condition, "unsupported_static_hls_timeline:{reason}");
    Ok(())
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlaylistSegment {
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<ByteRange>,
    pub duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Playlist {
    pub map: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_range: Option<ByteRange>,
    pub segments: Vec<PlaylistSegment>,
    pub seconds: f64,
    pub sequence: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ByteRange {
    pub offset: usize,
    pub length: usize,
}
impl ByteRange {
    pub fn end(self) -> Option<usize> {
        self.offset.checked_add(self.length)
    }
}

fn range(raw: &str, previous: Option<usize>, maximum: usize) -> Result<ByteRange> {
    let (length, offset) = raw
        .split_once('@')
        .map_or((raw, None), |(n, o)| (n, Some(o)));
    check(
        digits(length) && offset.is_none_or(digits),
        "byte_range_format",
    )?;
    let length = length
        .parse::<usize>()
        .ok()
        .filter(|n| *n > 0 && *n <= maximum);
    let offset = offset.and_then(|n| n.parse::<usize>().ok()).or(previous);
    check(
        length.is_some() && offset.is_some(),
        "byte_range_offset_required",
    )?;
    let result = ByteRange {
        offset: offset.unwrap(),
        length: length.unwrap(),
    };
    check(
        result.end().is_some_and(|n| n <= MAX_RESOURCE_BYTES),
        "byte_range_bound",
    )?;
    Ok(result)
}

pub fn parse_map_reference(raw: &str) -> Result<(String, Option<ByteRange>)> {
    // Closed attribute list; either order is legal. A MAP range has an explicit
    // offset so it cannot inherit state from media segment byte ranges.
    let mut uri = None;
    let mut selected = None;
    let mut remaining = raw;
    while !remaining.is_empty() {
        let (name, rest) = remaining
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("unsupported_static_hls_timeline:init_reference"))?;
        check(rest.starts_with('"'), "init_reference")?;
        let (value, tail) = rest[1..]
            .split_once('"')
            .ok_or_else(|| anyhow::anyhow!("unsupported_static_hls_timeline:init_reference"))?;
        match name {
            "URI" => {
                check(
                    uri.is_none()
                        && !value.is_empty()
                        && !value.contains("{$")
                        && !value.bytes().any(|b| b <= 32 || b == 127),
                    "init_reference",
                )?;
                uri = Some(value.to_owned());
            }
            "BYTERANGE" => {
                check(selected.is_none(), "init_reference")?;
                selected = Some(range(value, None, MAX_INIT_BYTES)?);
            }
            _ => bail!("unsupported_static_hls_timeline:init_reference"),
        }
        remaining = if tail.is_empty() {
            ""
        } else {
            tail.strip_prefix(',')
                .filter(|v| !v.is_empty())
                .ok_or_else(|| anyhow::anyhow!("unsupported_static_hls_timeline:init_reference"))?
        };
    }
    Ok((
        uri.ok_or_else(|| anyhow::anyhow!("unsupported_static_hls_timeline:init_reference"))?,
        selected,
    ))
}

fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

/// Parse a depth-one finite VOD playlist. URI authorization and resolution are
/// the capture gateway's job; references are preserved byte-for-byte here.
/// ENDLIST and MEDIA-SEQUENCE never establish a source presentation origin.
pub fn parse_playlist(text: &str) -> Result<Playlist> {
    parse_playlist_mode(text, false)
}
/// Source-only metadata admission. Generated child output keeps the original
/// closed grammar; these tags can never relax its published output contract.
pub fn parse_source_playlist(text: &str) -> Result<Playlist> {
    parse_playlist_mode(text, true)
}
fn parse_playlist_mode(text: &str, source_metadata: bool) -> Result<Playlist> {
    check(text.len() <= MAX_MANIFEST_BYTES, "manifest_bound")?;
    let mut lines = text
        .trim_end()
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line));
    check(lines.next() == Some("#EXTM3U"), "manifest_header")?;
    let (mut map, mut duration, mut target, mut version, mut sequence) =
        (None, None, None, None, None);
    let (mut ended, mut vod) = (false, false);
    let mut independent = false;
    let mut pending_discontinuity = false;
    let mut map_range = None;
    let mut pending_range: Option<String> = None;
    let mut segments = Vec::new();
    for line in lines {
        check(
            !line.is_empty() && line == line.trim() && !ended,
            "manifest_order",
        )?;
        if line == "#EXT-X-ENDLIST" {
            check(
                duration.is_none() && pending_range.is_none() && !pending_discontinuity,
                "dangling_duration",
            )?;
            ended = true;
        } else if source_metadata && line == "#EXT-X-INDEPENDENT-SEGMENTS" {
            check(
                !independent && duration.is_none() && pending_range.is_none(),
                "independent_segments_order",
            )?;
            independent = true;
        } else if source_metadata && line == "#EXT-X-KEY:METHOD=NONE" {
            // Explicit clear state creates no key URI, AES operation, or source
            // access. Every encrypted/extended KEY form still fails closed.
            check(
                duration.is_none() && pending_range.is_none(),
                "clear_key_order",
            )?;
        } else if source_metadata && line == "#EXT-X-DISCONTINUITY" {
            // A source may emit a redundant boundary marker. Qualification
            // still requires identical initialization and actual contiguous
            // decode/presentation timestamps. No reset is normalized here.
            check(
                !segments.is_empty()
                    && duration.is_none()
                    && pending_range.is_none()
                    && !pending_discontinuity,
                "discontinuity_boundary",
            )?;
            pending_discontinuity = true;
        } else if line == "#EXT-X-PLAYLIST-TYPE:VOD" {
            check(!vod, "duplicate_playlist_type")?;
            vod = true;
        } else if let Some(raw) = line.strip_prefix("#EXT-X-MAP:") {
            check(
                duration.is_none() && pending_range.is_none(),
                "manifest_order",
            )?;
            let (reference, selected) = parse_map_reference(raw)?;
            if let Some(existing) = &map {
                check(
                    existing == &reference && map_range == selected,
                    "single_init_required",
                )?;
            } else {
                map = Some(reference);
                map_range = selected;
            }
        } else if let Some(raw) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            check(
                duration.is_some() && pending_range.is_none(),
                "byte_range_order",
            )?;
            pending_range = Some(raw.to_owned());
        } else if let Some(raw) = line.strip_prefix("#EXTINF:") {
            check(duration.is_none(), "duplicate_duration")?;
            let raw = raw.strip_suffix(',').unwrap_or("");
            let valid = match raw.split_once('.') {
                Some((whole, decimal)) => digits(whole) && digits(decimal) && decimal.len() <= 6,
                None => digits(raw),
            };
            check(valid, "duration_format")?;
            let seconds = raw.parse::<f64>().unwrap_or(f64::INFINITY);
            check(seconds > 0.0 && seconds <= 32.0, "segment_duration_bound")?;
            duration = Some(seconds);
        } else if let Some(raw) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            check(
                target.is_none() && digits(raw) && raw.len() <= 2 && !raw.starts_with('0'),
                "target_duration",
            )?;
            let seconds = raw.parse::<u32>().unwrap_or(u32::MAX);
            check(seconds <= 32, "target_duration_bound")?;
            target = Some(seconds);
        } else if let Some(raw) = line.strip_prefix("#EXT-X-VERSION:") {
            check(
                version.is_none() && matches!(raw, "6" | "7"),
                "manifest_version",
            )?;
            version = Some(raw);
        } else if let Some(raw) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            check(sequence.is_none() && digits(raw), "media_sequence")?;
            let parsed = raw.parse::<u64>().ok().filter(|n| *n <= MAX_SAFE_INTEGER);
            check(parsed.is_some(), "media_sequence")?;
            sequence = parsed;
        } else if !line.starts_with('#') {
            check(
                map.is_some()
                    && duration.is_some()
                    && !line.contains("{$")
                    && !line.bytes().any(|b| b <= 32 || b == 127),
                "segment_reference",
            )?;
            check(segments.len() < MAX_SEGMENTS, "segment_count_bound")?;
            let previous = segments
                .last()
                .filter(|s: &&PlaylistSegment| s.uri == line)
                .and_then(|s| s.range)
                .and_then(ByteRange::end);
            let selected = pending_range
                .take()
                .map(|raw| range(&raw, previous, MAX_RESOURCE_BYTES))
                .transpose()?;
            pending_discontinuity = false;
            segments.push(PlaylistSegment {
                uri: line.to_owned(),
                range: selected,
                duration: duration.take().unwrap(),
            });
        } else {
            bail!("unsupported_static_hls_timeline:unsupported_manifest_tag");
        }
    }
    check(
        ended
            && vod
            && map.is_some()
            && target.is_some()
            && version.is_some()
            && !segments.is_empty(),
        "static_fmp4_required",
    )?;
    let seconds: f64 = segments.iter().map(|segment| segment.duration).sum();
    check(seconds <= MAX_SECONDS, "duration_bound")?;
    check(
        segments
            .iter()
            .all(|s| s.duration.ceil() <= f64::from(target.unwrap())),
        "target_duration_mismatch",
    )?;
    let map = map.unwrap();
    // The same URI is legal only for finite, disjoint projected ranges. A whole
    // resource alias, overlapping range or changed init remains fail closed.
    let references: Vec<_> = std::iter::once((map.as_str(), map_range))
        .chain(segments.iter().map(|s| (s.uri.as_str(), s.range)))
        .collect();
    for (index, (uri, selected)) in references.iter().enumerate() {
        for (other_uri, other) in &references[..index] {
            if uri == other_uri {
                check(
                    selected.zip(*other).is_some_and(|(a, b)| {
                        a.end().is_some_and(|end| end <= b.offset)
                            || b.end().is_some_and(|end| end <= a.offset)
                    }),
                    "duplicate_resource",
                )?;
            }
        }
    }
    Ok(Playlist {
        map,
        map_range,
        segments,
        seconds,
        sequence: sequence.unwrap_or(0),
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
}

impl TrackKind {
    fn name(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Audio => "audio",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Track {
    pub id: u32,
    pub kind: TrackKind,
    pub scale: u32,
    pub media_time: i32,
    pub width: Option<u16>,
    pub height: Option<u16>,
    pub channels: Option<u16>,
    pub codec_config_sha256: String,
    /// Bounded actual avcC/AudioSpecificConfig, required for decoder comparison.
    #[serde(skip)]
    codec_config: Vec<u8>,
}

#[derive(Clone, Copy)]
struct BoxRef<'a> {
    kind: &'a [u8],
    data: &'a [u8],
    start: usize,
    end: usize,
}

fn boxes(bytes: &[u8]) -> Result<Vec<BoxRef<'_>>> {
    let (mut out, mut offset) = (Vec::new(), 0usize);
    while offset < bytes.len() {
        check(bytes.len() - offset >= 8, "truncated_box")?;
        let size = u32_at(bytes, offset)? as usize;
        check(
            size >= 8 && size <= bytes.len() - offset && out.len() < 128,
            "box_bound",
        )?;
        out.push(BoxRef {
            kind: &bytes[offset + 4..offset + 8],
            data: &bytes[offset + 8..offset + size],
            start: offset,
            end: offset + size,
        });
        offset += size;
    }
    Ok(out)
}

fn one<'a>(list: &[BoxRef<'a>], kind: &[u8]) -> Result<&'a [u8]> {
    let selected: Vec<_> = list.iter().filter(|b| b.kind == kind).collect();
    check(
        selected.len() == 1,
        &format!("single_{}_required", String::from_utf8_lossy(kind)),
    )?;
    Ok(selected[0].data)
}

fn allowed(list: &[BoxRef<'_>], kinds: &[&[u8]], reason: &str) -> Result<()> {
    check(list.iter().all(|b| kinds.contains(&b.kind)), reason)
}

fn full(data: &[u8], version: u8, minimum: usize) -> Result<()> {
    check(
        data.len() >= minimum && data.first() == Some(&version),
        "box_version_or_length",
    )
}

fn u16_at(data: &[u8], offset: usize) -> Result<u16> {
    check(
        offset.checked_add(2).is_some_and(|end| end <= data.len()),
        "truncated_integer",
    )?;
    Ok(u16::from_be_bytes(
        data[offset..offset + 2].try_into().unwrap(),
    ))
}

fn u32_at(data: &[u8], offset: usize) -> Result<u32> {
    check(
        offset.checked_add(4).is_some_and(|end| end <= data.len()),
        "truncated_integer",
    )?;
    Ok(u32::from_be_bytes(
        data[offset..offset + 4].try_into().unwrap(),
    ))
}

fn u64_at(data: &[u8], offset: usize) -> Result<u64> {
    check(
        offset.checked_add(8).is_some_and(|end| end <= data.len()),
        "truncated_integer",
    )?;
    let value = u64::from_be_bytes(data[offset..offset + 8].try_into().unwrap());
    check(value <= MAX_SAFE_INTEGER, "timestamp_bound")?;
    Ok(value)
}

/// Known, self-contained AVCDecoderConfigurationRecord. Reject unknown
/// extensions, missing SPS/PPS, reserved-field changes and protected entries.
fn avc_config(data: &[u8]) -> Result<Vec<u8>> {
    check(
        data.len() >= 7
            && data.len() <= MAX_CODEC_BYTES
            && data[0] == 1
            && data[4] == 0xff
            && data[5] & 0xe0 == 0xe0,
        "unsupported_avcc",
    )?;
    check(
        matches!(data[1], 66 | 77 | 88 | 100),
        "unsupported_avc_profile",
    )?;
    let mut offset = 6;
    let sequence_count = usize::from(data[5] & 31);
    check(sequence_count > 0, "avcc_parameter_sets")?;
    for _ in 0..sequence_count {
        avc_nal(data, &mut offset, 7)?;
    }
    check(offset < data.len(), "avcc_parameter_sets")?;
    let picture_count = usize::from(data[offset]);
    offset += 1;
    check(picture_count > 0, "avcc_parameter_sets")?;
    for _ in 0..picture_count {
        avc_nal(data, &mut offset, 8)?;
    }
    if offset < data.len() {
        // The supported high-profile extension is 4:2:0, eight-bit, no
        // sequence-parameter-set extensions. Unknown tails are never ignored.
        check(
            data[1] == 100 && data.get(offset..) == Some(&[0xfd, 0xf8, 0xf8, 0][..]),
            "unsupported_avcc_extension",
        )?;
        offset += 4;
    }
    check(offset == data.len(), "avcc_length")?;
    Ok(data.to_vec())
}

fn avc_nal(data: &[u8], offset: &mut usize, kind: u8) -> Result<()> {
    let length = usize::from(u16_at(data, *offset)?);
    *offset += 2;
    check(
        length >= if kind == 7 { 4 } else { 1 } && length <= data.len().saturating_sub(*offset),
        "avcc_parameter_sets",
    )?;
    check(
        data[*offset] & 0x80 == 0 && data[*offset] & 31 == kind,
        "avcc_parameter_sets",
    )?;
    if kind == 7 {
        check(
            data[*offset + 1..*offset + 4] == data[1..4],
            "avcc_header_mismatch",
        )?;
    }
    *offset += length;
    Ok(())
}

fn descriptor<'a>(data: &'a [u8], offset: &mut usize, expected: u8) -> Result<&'a [u8]> {
    check(data.get(*offset) == Some(&expected), "unsupported_esds")?;
    *offset += 1;
    let (mut length, mut complete) = (0usize, false);
    for _ in 0..4 {
        let Some(byte) = data.get(*offset) else {
            bail!("unsupported_static_hls_timeline:unsupported_esds")
        };
        *offset += 1;
        length = (length << 7) | usize::from(byte & 0x7f);
        if byte & 0x80 == 0 {
            complete = true;
            break;
        }
    }
    check(
        complete && length <= data.len().saturating_sub(*offset),
        "unsupported_esds",
    )?;
    let out = &data[*offset..*offset + length];
    *offset += length;
    Ok(out)
}

fn aac_config(data: &[u8], entry_channels: u16) -> Result<(Vec<u8>, u16)> {
    check(
        data.len() >= 4 && data.len() <= MAX_CODEC_BYTES && u32_at(data, 0)? == 0,
        "unsupported_esds",
    )?;
    let mut offset = 4;
    let es = descriptor(data, &mut offset, 3)?;
    check(
        offset == data.len() && es.len() >= 3 && es[2] == 0,
        "unsupported_esds",
    )?;
    let mut offset = 3;
    let decoder = descriptor(es, &mut offset, 4)?;
    check(
        decoder.len() >= 13 && decoder[0] == 0x40 && decoder[1] == 0x15,
        "unsupported_aac_config",
    )?;
    let mut decoder_offset = 13;
    let config = descriptor(decoder, &mut decoder_offset, 5)?;
    check(
        decoder_offset == decoder.len() && config.len() >= 2 && config.len() <= 32,
        "unsupported_aac_config",
    )?;
    let sl = descriptor(es, &mut offset, 6)?;
    check(offset == es.len() && sl == [2], "unsupported_esds")?;
    // AAC-LC, 48 kHz, fixed mono/stereo channel configuration. Decoder output
    // is additionally required to agree, including the exact extradata bytes.
    let channels = u16::from((config[1] >> 3) & 15);
    check(
        config[0] >> 3 == 2
            && ((config[0] & 7) << 1 | config[1] >> 7) == 3
            && matches!(channels, 1 | 2)
            && config[1] & 7 == 0,
        "unsupported_aac_config",
    )?;
    // The version-zero MP4 sample entry uses a reserved channel count of two
    // even for mono AAC (FFmpeg 5.1 movenc.c). It cannot override the ASC.
    // An explicit mono entry must still agree; other entry values are refused.
    check(
        entry_channels == 2 || entry_channels == channels,
        "unsupported_aac_config",
    )?;
    // FFmpeg's optional, measured sync extension declares SBR absent. Any
    // other ASC tail (implicit SBR/PS or unparsed semantics) is unsupported.
    check(
        config.len() == 2 || config.get(2..) == Some(&[0x56, 0xe5, 0][..]),
        "unsupported_aac_config_extension",
    )?;
    Ok((config.to_vec(), channels))
}

/// Inspect actual init track IDs, edits and codec configurations before decode.
pub fn inspect_init(bytes: &[u8]) -> Result<Vec<Track>> {
    check(
        !bytes.is_empty() && bytes.len() <= MAX_INIT_BYTES,
        "init_bound",
    )?;
    let top = boxes(bytes)?;
    allowed(&top, &[b"ftyp", b"moov"], "init_box_type")?;
    one(&top, b"ftyp")?;
    let moov = boxes(one(&top, b"moov")?)?;
    allowed(
        &moov,
        &[b"mvhd", b"trak", b"mvex", b"udta"],
        "init_clock_structure",
    )?;
    one(&moov, b"mvhd")?;
    let mut tracks = Vec::new();
    for boxed in moov.iter().filter(|b| b.kind == b"trak") {
        check(tracks.len() < 2, "track_set")?;
        let track = boxes(boxed.data)?;
        allowed(&track, &[b"tkhd", b"edts", b"mdia"], "init_track_structure")?;
        let tkhd = one(&track, b"tkhd")?;
        full(tkhd, 0, 24)?;
        let id = u32_at(tkhd, 12)?;
        check(id > 0, "track_id")?;
        let mdia = boxes(one(&track, b"mdia")?)?;
        allowed(&mdia, &[b"mdhd", b"hdlr", b"minf"], "init_media_structure")?;
        let (mdhd, hdlr) = (one(&mdia, b"mdhd")?, one(&mdia, b"hdlr")?);
        full(mdhd, 0, 24)?;
        full(hdlr, 0, 12)?;
        let scale = u32_at(mdhd, 12)?;
        check(scale > 0 && scale <= 1_000_000, "timescale_bound")?;
        let kind = match &hdlr[8..12] {
            b"vide" => TrackKind::Video,
            b"soun" => TrackKind::Audio,
            _ => bail!("unsupported_static_hls_timeline:unknown_track"),
        };
        let minf = boxes(one(&mdia, b"minf")?)?;
        allowed(
            &minf,
            &[b"vmhd", b"smhd", b"dinf", b"stbl"],
            "init_sample_structure",
        )?;
        let dinf = boxes(one(&minf, b"dinf")?)?;
        allowed(&dinf, &[b"dref"], "external_data_reference")?;
        let dref = one(&dinf, b"dref")?;
        full(dref, 0, 8)?;
        check(
            u32_at(dref, 0)? == 0 && u32_at(dref, 4)? == 1,
            "external_data_reference",
        )?;
        let refs = boxes(&dref[8..])?;
        check(
            refs.len() == 1 && refs[0].kind == b"url " && refs[0].data == [0, 0, 0, 1],
            "external_data_reference",
        )?;
        let stbl = boxes(one(&minf, b"stbl")?)?;
        allowed(
            &stbl,
            &[b"stsd", b"stts", b"stsc", b"stsz", b"stco"],
            "init_sample_structure",
        )?;
        for tag in [b"stts", b"stsc", b"stco"] {
            check(one(&stbl, tag)? == [0; 8], "init_contains_samples")?;
        }
        check(one(&stbl, b"stsz")? == [0; 12], "init_contains_samples")?;
        let stsd = one(&stbl, b"stsd")?;
        full(stsd, 0, 16)?;
        check(
            u32_at(stsd, 0)? == 0 && u32_at(stsd, 4)? == 1,
            "alternate_sample_description",
        )?;
        let entries = boxes(&stsd[8..])?;
        check(
            entries.len() == 1
                && entries[0].kind
                    == if kind == TrackKind::Video {
                        b"avc1"
                    } else {
                        b"mp4a"
                    },
            "unsupported_codec_entry",
        )?;
        let entry = entries[0].data;
        check(
            entry.len() >= 28 && entry[..6] == [0; 6] && u16_at(entry, 6)? == 1,
            "sample_data_reference",
        )?;
        let (width, height, channels, config) = if kind == TrackKind::Video {
            check(entry.len() >= 78, "init_geometry_bound")?;
            let (w, h) = (u16_at(entry, 24)?, u16_at(entry, 26)?);
            check(
                w > 0 && w <= 1920 && h > 0 && h <= 1080,
                "init_geometry_bound",
            )?;
            let extensions = boxes(&entry[78..])?;
            allowed(
                &extensions,
                &[b"avcC", b"pasp", b"btrt"],
                "unsupported_sample_extension",
            )?;
            validate_inert_extensions(&extensions)?;
            (
                Some(w),
                Some(h),
                None,
                avc_config(one(&extensions, b"avcC")?)?,
            )
        } else {
            let channels = u16_at(entry, 16)?;
            check(
                matches!(channels, 1 | 2)
                    && u32_at(entry, 24)? == 48_000 * 65_536
                    && u32_at(entry, 8)? == 0
                    && u32_at(entry, 12)? == 0,
                "init_audio_bound",
            )?;
            let extensions = boxes(&entry[28..])?;
            allowed(
                &extensions,
                &[b"esds", b"btrt"],
                "unsupported_sample_extension",
            )?;
            validate_inert_extensions(&extensions)?;
            let (config, channels) = aac_config(one(&extensions, b"esds")?, channels)?;
            (None, None, Some(channels), config)
        };
        let edts = boxes(one(&track, b"edts")?)?;
        allowed(&edts, &[b"elst"], "unknown_edit_list")?;
        let edit = one(&edts, b"elst")?;
        full(edit, 0, 20)?;
        check(
            edit.len() == 20
                && u32_at(edit, 0)? == 0
                && u32_at(edit, 4)? == 1
                && u32_at(edit, 8)? == 0
                && u32_at(edit, 16)? == 65_536,
            "unknown_edit_list",
        )?;
        let media_time = u32_at(edit, 12)? as i32;
        check(
            if kind == TrackKind::Video {
                media_time == 0
            } else {
                matches!(media_time, 0 | 1024)
            },
            "unknown_edit_offset",
        )?;
        tracks.push(Track {
            id,
            kind,
            scale,
            media_time,
            width,
            height,
            channels,
            codec_config_sha256: sha(&config),
            codec_config: config,
        });
    }
    check(
        !tracks.is_empty()
            && tracks.iter().filter(|t| t.kind == TrackKind::Video).count() == 1
            && tracks.iter().filter(|t| t.kind == TrackKind::Audio).count() <= 1,
        "track_set",
    )?;
    let ids: BTreeSet<_> = tracks.iter().map(|t| t.id).collect();
    check(ids.len() == tracks.len(), "duplicate_track")?;
    let mvex = boxes(one(&moov, b"mvex")?)?;
    allowed(&mvex, &[b"trex"], "init_fragment_defaults")?;
    let mut trex_ids = BTreeSet::new();
    for trex in mvex {
        check(
            trex.data.len() == 24 && u32_at(trex.data, 0)? == 0 && u32_at(trex.data, 8)? == 1,
            "init_fragment_defaults",
        )?;
        check(
            trex_ids.insert(u32_at(trex.data, 4)?),
            "init_fragment_defaults",
        )?;
    }
    check(trex_ids == ids, "init_fragment_defaults")?;
    Ok(tracks)
}

fn validate_inert_extensions(extensions: &[BoxRef<'_>]) -> Result<()> {
    for tag in [b"pasp", b"btrt"] {
        let selected: Vec<_> = extensions.iter().filter(|b| b.kind == tag).collect();
        check(selected.len() <= 1, "unsupported_sample_extension")?;
        if let Some(boxed) = selected.first() {
            if tag == b"pasp" {
                check(
                    boxed.data.len() == 8
                        && u32_at(boxed.data, 0)? > 0
                        && u32_at(boxed.data, 4)? > 0,
                    "unsupported_sample_extension",
                )?;
            } else {
                check(boxed.data.len() == 12, "unsupported_sample_extension")?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct Sample {
    pts: i64,
    duration: u32,
    size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceIdentity {
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SegmentIdentity {
    pub index: usize,
    pub bytes: usize,
    pub sha256: String,
    #[serde(default)]
    pub track_ids: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClosureIdentity {
    pub version: u32,
    pub manifest_sha256: String,
    pub manifest_bytes: usize,
    pub init: ResourceIdentity,
    pub segments: Vec<SegmentIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrackSummary {
    pub track_id: u32,
    pub stream_index: u32,
    pub kind: TrackKind,
    pub time_base: String,
    pub packet_count: usize,
    pub decoded_frames: usize,
    pub raw_first_pts: i64,
    pub decoded_first_pts: i64,
    pub priming_samples: u32,
    pub tail_padding_samples: u32,
    pub raw_end_seconds: f64,
    pub end_seconds: f64,
    pub last_frame_pts: i64,
    pub codec_config_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimelineProof {
    #[serde(flatten)]
    pub closure: ClosureIdentity,
    pub scope: String,
    pub source_origin_ms: u32,
    pub duration_ms: f64,
    pub media_sequence: u64,
    pub tracks: Vec<TrackSummary>,
}

/// Transactional, in-order accumulator. A rejected fragment does not partially
/// append samples, spend the byte budget or claim part of a complete closure.
#[derive(Debug)]
pub struct Structure {
    pub playlist: Playlist,
    pub tracks: Vec<Track>,
    samples: BTreeMap<u32, Vec<Sample>>,
    identity: ClosureIdentity,
    total_bytes: usize,
    sample_count: usize,
}

impl Structure {
    pub fn new(manifest: &str, init: &[u8]) -> Result<Self> {
        let playlist = parse_source_playlist(manifest)?;
        let tracks = inspect_init(init)?;
        let total_bytes = manifest.len() + init.len();
        check(total_bytes <= MAX_TOTAL_BYTES, "total_bytes_bound")?;
        let samples = tracks.iter().map(|t| (t.id, Vec::new())).collect();
        let identity = ClosureIdentity {
            version: 1,
            manifest_sha256: sha(manifest.as_bytes()),
            manifest_bytes: manifest.len(),
            init: ResourceIdentity {
                bytes: init.len(),
                sha256: sha(init),
            },
            segments: Vec::new(),
        };
        Ok(Self {
            playlist,
            tracks,
            samples,
            identity,
            total_bytes,
            sample_count: 0,
        })
    }

    pub fn ingest_fragment(&mut self, bytes: &[u8], index: usize) -> Result<()> {
        check(
            index == self.identity.segments.len() && index < self.playlist.segments.len(),
            "fragment_order",
        )?;
        check(
            !bytes.is_empty() && bytes.len() <= MAX_RESOURCE_BYTES,
            "resource_bound",
        )?;
        check(
            bytes.len() <= MAX_TOTAL_BYTES - self.total_bytes,
            "total_bytes_bound",
        )?;
        let fragments = fragment_samples(bytes, &self.tracks, MAX_RECORDS / 2 - self.sample_count)?;
        let video = fragments
            .iter()
            .find(|(id, _)| {
                self.tracks
                    .iter()
                    .any(|t| t.id == *id && t.kind == TrackKind::Video)
            })
            .unwrap();
        let scale = self.tracks.iter().find(|t| t.id == video.0).unwrap().scale;
        let duration: u64 = video.1.iter().map(|s| u64::from(s.duration)).sum();
        check(
            (duration as f64 / f64::from(scale) - self.playlist.segments[index].duration).abs()
                <= DURATION_TOLERANCE,
            "manifest_media_duration_mismatch",
        )?;
        let track_ids = fragments.iter().map(|(id, _)| *id).collect();
        for (id, samples) in fragments {
            self.sample_count += samples.len();
            self.samples.get_mut(&id).unwrap().extend(samples);
        }
        self.total_bytes += bytes.len();
        self.identity.segments.push(SegmentIdentity {
            index,
            bytes: bytes.len(),
            sha256: sha(bytes),
            track_ids,
        });
        Ok(())
    }

    fn complete(&self) -> Result<()> {
        check(
            self.identity.segments.len() == self.playlist.segments.len(),
            "incomplete_closure",
        )?;
        check(
            self.sample_count * 2 <= MAX_RECORDS,
            "source_sample_count_bound",
        )
    }

    /// Inventory comparison does not assert timeline eligibility.
    pub fn byte_identity(&self) -> Result<ClosureIdentity> {
        self.complete()?;
        Ok(self.identity.clone())
    }

    /// Validate all packets and every decoded frame. No best-effort timestamp,
    /// format start or playlist sequence is substituted for a missing PTS.
    pub fn inspect_probe(&self, probe: &Value) -> Result<TimelineProof> {
        self.complete()?;
        let streams = probe
            .get("streams")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("unsupported_static_hls_timeline:decoder_track_set"))?;
        check(streams.len() == self.tracks.len(), "decoder_track_set")?;
        let records = probe
            .get("packets_and_frames")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                anyhow::anyhow!("unsupported_static_hls_timeline:decoder_record_bound")
            })?;
        check(
            !records.is_empty() && records.len() <= MAX_RECORDS,
            "decoder_record_bound",
        )?;
        let mut summaries = Vec::new();
        let mut indices = BTreeSet::new();
        for track in &self.tracks {
            let same_kind: Vec<_> = streams
                .iter()
                .filter(|s| s["codec_type"] == track.kind.name())
                .collect();
            check(same_kind.len() == 1, "decoder_track_identity")?;
            let stream = same_kind[0];
            if let Some(id) = stream.get("id") {
                check(
                    number_or_string(id) == Some(f64::from(track.id)),
                    "decoder_track_id",
                )?;
            }
            let time_base = format!("1/{}", track.scale);
            check(
                stream["time_base"].as_str() == Some(time_base.as_str()),
                "decoder_track_identity",
            )?;
            let index = integer(&stream["index"], 0, "stream_index")?;
            check(
                index <= i64::from(u32::MAX) && indices.insert(index as u32),
                "stream_index",
            )?;
            let index = index as u32;
            if track.kind == TrackKind::Video {
                check(
                    stream["codec_name"] == "h264"
                        && stream["has_b_frames"] == 0
                        && numeric_equal(&stream["width"], i64::from(track.width.unwrap()))
                        && numeric_equal(&stream["height"], i64::from(track.height.unwrap())),
                    "video_recipe_scope",
                )?;
            } else {
                check(
                    stream["codec_name"] == "aac"
                        && number_or_string(&stream["sample_rate"]) == Some(48_000.0)
                        && track.scale == 48_000
                        && numeric_equal(&stream["channels"], i64::from(track.channels.unwrap())),
                    "audio_recipe_scope",
                )?;
            }
            let extradata = probe_extradata(stream)?;
            check(
                extradata == track.codec_config,
                "decoder_codec_config_mismatch",
            )?;
            let selected: Vec<_> = records
                .iter()
                .filter(|r| numeric_equal(&r["stream_index"], i64::from(index)))
                .collect();
            check(
                !selected.is_empty()
                    && selected
                        .iter()
                        .all(|r| matches!(r["type"].as_str(), Some("packet" | "frame"))),
                "unknown_decoder_record",
            )?;
            let packets: Vec<_> = selected
                .iter()
                .copied()
                .filter(|r| r["type"] == "packet")
                .collect();
            let frames: Vec<_> = selected
                .iter()
                .copied()
                .filter(|r| r["type"] == "frame")
                .collect();
            let samples = &self.samples[&track.id];
            check(!samples.is_empty(), "incomplete_decoder_scan")?;
            if track.kind == TrackKind::Video {
                let duration = u64::from(samples[0].duration);
                check(
                    (u64::from(track.scale) == 25 * duration
                        || u64::from(track.scale) == 30 * duration)
                        && samples.iter().all(|s| s.duration == samples[0].duration),
                    "video_frame_rate_scope",
                )?;
            } else {
                check(
                    samples.iter().enumerate().all(|(i, s)| {
                        s.duration == 1024
                            || (i == samples.len() - 1 && s.duration > 0 && s.duration < 1024)
                    }),
                    "unknown_audio_sample_duration",
                )?;
            }
            check(
                packets.len() == samples.len() && !frames.is_empty(),
                "incomplete_decoder_scan",
            )?;
            let mut priming = 0;
            let mut decoded_preroll = false;
            for (i, (sample, packet)) in samples.iter().zip(&packets).enumerate() {
                let pts = integer(&packet["pts"], -1024, "packet_pts")?;
                check(
                    pts == sample.pts && numeric_equal(&packet["dts"], pts),
                    "packet_sample_clock_mismatch",
                )?;
                if i > 0 {
                    check(
                        sample.pts == samples[i - 1].pts + i64::from(samples[i - 1].duration),
                        "source_timestamp_gap_or_overlap",
                    )?;
                }
                let sides = match packet.get("side_data_list") {
                    None | Some(Value::Null) => &[][..],
                    Some(value) => value.as_array().map(Vec::as_slice).ok_or_else(|| {
                        anyhow::anyhow!("unsupported_static_hls_timeline:packet_side_data")
                    })?,
                };
                if i == 0 && track.kind == TrackKind::Audio && track.media_time == 1024 {
                    decoded_preroll = sides.is_empty();
                    check(
                        sample.pts == -1024
                            && sample.duration == 1024
                            && (!decoded_preroll
                                || packet["duration"].is_null()
                                || numeric_equal(&packet["duration"], 1024))
                            && (decoded_preroll
                                || (sides.len() == 1
                                    && sides[0]["side_data_type"] == "Skip Samples"
                                    && numeric_equal(&sides[0]["skip_samples"], 1024)
                                    && numeric_equal(&sides[0]["discard_padding"], 0))),
                        "aac_priming_mismatch",
                    )?;
                    priming = 1024;
                } else {
                    check(
                        sides.is_empty()
                            && numeric_equal(
                                &packet["duration"],
                                if track.kind == TrackKind::Audio {
                                    1024
                                } else {
                                    i64::from(sample.duration)
                                },
                            ),
                        "unknown_packet_priming_or_duration",
                    )?;
                }
            }
            let displayed = if priming > 0 {
                &samples[1..]
            } else {
                samples.as_slice()
            };
            check(
                !displayed.is_empty()
                    && frames.len()
                        == if decoded_preroll {
                            samples.len()
                        } else {
                            displayed.len()
                        },
                "decoded_sample_count",
            )?;
            // FFprobe's HLS demuxer can expose the exact edit-list preroll as a
            // decoded frame instead of emitting Skip Samples. Validate that
            // frame too; never invent a skip or silently drop an extra frame.
            let decoded_samples = if decoded_preroll {
                samples.as_slice()
            } else {
                displayed
            };
            for (i, (frame, sample)) in frames.iter().zip(decoded_samples).enumerate() {
                check(
                    frame["media_type"] == track.kind.name()
                        && numeric_equal(&frame["pts"], sample.pts)
                        && numeric_equal(&frame["best_effort_timestamp"], sample.pts),
                    "decoded_presentation_clock",
                )?;
                let duration = frame
                    .get("duration")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&frame["pkt_duration"]);
                let expected_duration = if track.kind == TrackKind::Audio {
                    1024
                } else {
                    i64::from(sample.duration)
                };
                check(
                    numeric_equal(duration, expected_duration)
                        || (decoded_preroll && i == 0 && duration.is_null()),
                    "decoded_duration",
                )?;
                if track.kind == TrackKind::Audio {
                    check(
                        numeric_equal(&frame["nb_samples"], 1024),
                        "audio_sample_clock",
                    )?;
                } else {
                    check(
                        frame["width"] == stream["width"] && frame["height"] == stream["height"],
                        "video_geometry_changed",
                    )?;
                }
                if i == 0 {
                    check(
                        sample.pts == if decoded_preroll { -1024 } else { 0 },
                        "nonzero_presentation_origin",
                    )?;
                }
            }
            check(displayed[0].pts == 0, "nonzero_presentation_origin")?;
            let last = displayed.last().unwrap();
            let end = (last.pts
                + if track.kind == TrackKind::Audio {
                    1024
                } else {
                    i64::from(last.duration)
                }) as f64
                / f64::from(track.scale);
            check(
                end > 0.0 && end <= MAX_SECONDS + 1024.0 / 48_000.0,
                "decoded_duration_bound",
            )?;
            summaries.push(TrackSummary {
                track_id: track.id,
                stream_index: index,
                kind: track.kind,
                time_base,
                packet_count: packets.len(),
                decoded_frames: frames.len(),
                raw_first_pts: samples[0].pts,
                decoded_first_pts: displayed[0].pts,
                priming_samples: priming,
                tail_padding_samples: if track.kind == TrackKind::Audio {
                    1024 - last.duration
                } else {
                    0
                },
                raw_end_seconds: (last.pts + i64::from(last.duration)) as f64
                    / f64::from(track.scale),
                end_seconds: end,
                last_frame_pts: last.pts,
                codec_config_sha256: track.codec_config_sha256.clone(),
            });
        }
        check(
            records.iter().all(|r| {
                integer(&r["stream_index"], 0, "decoder_extra_track")
                    .is_ok_and(|i| i <= i64::from(u32::MAX) && indices.contains(&(i as u32)))
            }),
            "decoder_extra_track",
        )?;
        let video = summaries
            .iter()
            .find(|t| t.kind == TrackKind::Video)
            .unwrap();
        check(
            (video.end_seconds - self.playlist.seconds).abs() <= DURATION_TOLERANCE,
            "full_timeline_duration",
        )?;
        if let Some(audio) = summaries.iter().find(|t| t.kind == TrackKind::Audio) {
            check(
                (audio.raw_end_seconds - video.end_seconds).abs() <= DURATION_TOLERANCE
                    && audio.end_seconds >= video.end_seconds
                    && audio.end_seconds - video.end_seconds <= 1024.0 / 48_000.0 + 0.000_001,
                "audio_video_end_alignment",
            )?;
        }
        Ok(TimelineProof {
            closure: self.identity.clone(),
            scope: "bounded-zero-origin-avc-fmp4-prerequisite-only".into(),
            source_origin_ms: 0,
            duration_ms: self.playlist.seconds * 1000.0,
            media_sequence: self.playlist.sequence,
            tracks: summaries,
        })
    }
}

fn fragment_samples(
    bytes: &[u8],
    tracks: &[Track],
    remaining: usize,
) -> Result<Vec<(u32, Vec<Sample>)>> {
    let top = boxes(bytes)?;
    allowed(
        &top,
        &[b"styp", b"sidx", b"moof", b"mdat"],
        "fragment_box_type",
    )?;
    let mdat = one(&top, b"mdat")?;
    let moof_data = one(&top, b"moof")?;
    let moof_box = top.iter().find(|b| b.kind == b"moof").unwrap();
    let mdat_box = top.iter().find(|b| b.kind == b"mdat").unwrap();
    check(mdat_box.start >= moof_box.end, "media_payload_offset")?;
    let moof = boxes(moof_data)?;
    allowed(&moof, &[b"mfhd", b"traf"], "fragment_clock_structure")?;
    let mfhd = one(&moof, b"mfhd")?;
    check(
        mfhd.len() == 8 && u32_at(mfhd, 0)? == 0,
        "fragment_clock_structure",
    )?;
    let (mut collected, mut payload_bytes) = (0usize, 0u64);
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    let mut payload_ranges = Vec::new();
    for traf in moof.iter().filter(|b| b.kind == b"traf") {
        check(out.len() < tracks.len(), "segment_track_set_changed")?;
        let children = boxes(traf.data)?;
        allowed(
            &children,
            &[b"tfhd", b"tfdt", b"trun"],
            "unknown_fragment_timing",
        )?;
        let (tfhd, tfdt, trun) = (
            one(&children, b"tfhd")?,
            one(&children, b"tfdt")?,
            one(&children, b"trun")?,
        );
        full(tfhd, 0, 20)?;
        check(
            tfhd.len() == 20 && u32_at(tfhd, 0)? == 0x20038,
            "unsupported_tfhd",
        )?;
        let id = u32_at(tfhd, 4)?;
        let track = tracks.iter().find(|t| t.id == id).ok_or_else(|| {
            anyhow::anyhow!("unsupported_static_hls_timeline:fragment_unknown_track")
        })?;
        check(seen.insert(id), "segment_track_set_changed")?;
        let (default_duration, default_size) = (u32_at(tfhd, 8)?, u32_at(tfhd, 12)?);
        check(default_duration > 0 && default_size > 0, "sample_defaults")?;
        check(
            (tfdt.len() == 8 && u32_at(tfdt, 0)? == 0)
                || (tfdt.len() == 12 && u32_at(tfdt, 0)? == 0x1000000),
            "tfdt_version",
        )?;
        let mut clock = if tfdt[0] == 1 {
            u64_at(tfdt, 4)?
        } else {
            u64::from(u32_at(tfdt, 4)?)
        };
        full(trun, 0, 12)?;
        let (flags, count) = (u32_at(trun, 0)?, u32_at(trun, 4)? as usize);
        check(
            count > 0 && count <= remaining - collected && flags & !0x305 == 0 && flags & 1 != 0,
            "unsupported_trun",
        )?;
        collected += count;
        let mut offset = 12 + if flags & 4 != 0 { 4 } else { 0 };
        check(offset <= trun.len(), "truncated_samples")?;
        let mut samples = Vec::with_capacity(count);
        let mut size_sum = 0u64;
        for _ in 0..count {
            let duration = if flags & 0x100 != 0 {
                let n = u32_at(trun, offset)?;
                offset += 4;
                n
            } else {
                default_duration
            };
            let size = if flags & 0x200 != 0 {
                let n = u32_at(trun, offset)?;
                offset += 4;
                n
            } else {
                default_size
            };
            check(duration > 0 && size > 0, "empty_sample")?;
            let pts = clock as i64 - i64::from(track.media_time);
            samples.push(Sample {
                pts,
                duration,
                size,
            });
            clock += u64::from(duration);
            check(clock <= MAX_SAFE_INTEGER, "sample_timestamp_bound")?;
            size_sum += u64::from(size);
        }
        check(offset == trun.len(), "sample_table_length")?;
        let data_offset = i64::from(u32_at(trun, 8)? as i32);
        let data_start = moof_box.start as i64 + data_offset;
        check(
            data_start >= mdat_box.start as i64 + 8 && data_start <= mdat_box.end as i64,
            "media_payload_offset",
        )?;
        let data_end = data_start as u64 + size_sum;
        check(data_end <= mdat_box.end as u64, "media_payload_offset")?;
        payload_ranges.push((data_start as u64, data_end));
        payload_bytes += samples.iter().map(|s| u64::from(s.size)).sum::<u64>();
        out.push((id, samples));
    }
    check(
        out.len() == tracks.len() && seen.len() == tracks.len(),
        "segment_track_set_changed",
    )?;
    check(payload_bytes == mdat.len() as u64, "media_payload_size")?;
    payload_ranges.sort_unstable();
    let mut end = mdat_box.start as u64 + 8;
    for (start, next) in payload_ranges {
        check(start == end, "media_payload_offset")?;
        end = next;
    }
    check(end == mdat_box.end as u64, "media_payload_offset")?;
    Ok(out)
}

fn integer(value: &Value, minimum: i64, reason: &str) -> Result<i64> {
    let number = value.as_f64().filter(|n| {
        n.is_finite()
            && n.fract() == 0.0
            && *n >= minimum as f64
            && n.abs() <= MAX_SAFE_INTEGER as f64
    });
    check(number.is_some(), reason)?;
    Ok(number.unwrap() as i64)
}

fn numeric_equal(value: &Value, expected: i64) -> bool {
    integer(value, -(MAX_SAFE_INTEGER as i64), "integer").is_ok_and(|n| n == expected)
}

fn number_or_string(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| {
            let raw = value.as_str()?;
            if let Some(hex) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
                u64::from_str_radix(hex, 16).ok().map(|n| n as f64)
            } else {
                raw.parse().ok()
            }
        })
        .filter(|n| n.is_finite())
}

/// Parse only FFprobe's offset-labelled hex column, never printable ASCII.
fn probe_extradata(stream: &Value) -> Result<Vec<u8>> {
    let dump = stream["extradata"].as_str().ok_or_else(|| {
        anyhow::anyhow!("unsupported_static_hls_timeline:decoder_codec_config_missing")
    })?;
    check(
        dump.len() <= MAX_CODEC_BYTES * 8,
        "decoder_codec_config_bound",
    )?;
    let mut bytes = Vec::new();
    for line in dump.lines().filter(|line| !line.trim().is_empty()) {
        let (offset, data) = line.split_once(':').ok_or_else(|| {
            anyhow::anyhow!("unsupported_static_hls_timeline:decoder_codec_config_dump")
        })?;
        check(
            offset.len() == 8
                && offset.bytes().all(|b| b.is_ascii_hexdigit())
                && usize::from_str_radix(offset, 16).ok() == Some(bytes.len()),
            "decoder_codec_config_dump",
        )?;
        let hex = data.trim_start().split("  ").next().unwrap_or("");
        let mut line_bytes = 0;
        for word in hex.split_whitespace() {
            check(
                word.len() <= 4
                    && !word.is_empty()
                    && word.len() % 2 == 0
                    && word.bytes().all(|b| b.is_ascii_hexdigit()),
                "decoder_codec_config_dump",
            )?;
            for offset in (0..word.len()).step_by(2) {
                bytes.push(u8::from_str_radix(&word[offset..offset + 2], 16).unwrap());
                line_bytes += 1;
                check(bytes.len() <= MAX_CODEC_BYTES, "decoder_codec_config_bound")?;
            }
        }
        check(
            line_bytes > 0 && line_bytes <= 16,
            "decoder_codec_config_dump",
        )?;
    }
    check(!bytes.is_empty(), "decoder_codec_config_dump")?;
    if let Some(size) = stream.get("extradata_size") {
        check(
            numeric_equal(size, bytes.len() as i64),
            "decoder_codec_config_dump",
        )?;
    }
    Ok(bytes)
}

fn validate_identity(proof: &ClosureIdentity) -> Result<()> {
    let hash = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    let size = |n: usize, maximum: usize| n > 0 && n <= maximum;
    check(
        proof.version == 1
            && hash(&proof.manifest_sha256)
            && size(proof.manifest_bytes, MAX_MANIFEST_BYTES)
            && hash(&proof.init.sha256)
            && size(proof.init.bytes, MAX_INIT_BYTES)
            && !proof.segments.is_empty()
            && proof.segments.len() <= MAX_SEGMENTS,
        "closure_proof_shape",
    )?;
    let mut bytes = proof.manifest_bytes + proof.init.bytes;
    for (index, segment) in proof.segments.iter().enumerate() {
        check(
            segment.index == index
                && hash(&segment.sha256)
                && size(segment.bytes, MAX_RESOURCE_BYTES),
            "closure_proof_shape",
        )?;
        bytes += segment.bytes;
    }
    check(bytes <= MAX_TOTAL_BYTES, "closure_proof_shape")
}

/// A valid zero-origin timeline is not a source identity. Compare every byte
/// inventory, including the original manifest (signed-query order included),
/// initialization and all future/final segments independently of eligibility.
pub fn require_same_closure(expected: &ClosureIdentity, current: &ClosureIdentity) -> Result<()> {
    validate_identity(expected)?;
    validate_identity(current)?;
    check(
        expected.manifest_sha256 == current.manifest_sha256
            && expected.manifest_bytes == current.manifest_bytes
            && expected.init == current.init
            && expected.segments.len() == current.segments.len()
            && expected
                .segments
                .iter()
                .zip(&current.segments)
                .all(|(a, b)| a.index == b.index && a.bytes == b.bytes && a.sha256 == b.sha256),
        "source_changed",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // These are deliberately small structural fixtures, not decode evidence.
    // The capture owner separately exercises installed FFmpeg on real media.
    const AVC: &[u8] = &[
        1, 100, 0, 31, 255, 225, 0, 4, 103, 100, 0, 31, 1, 0, 2, 104, 0, 253, 248, 248, 0,
    ];
    const ASC: &[u8] = &[0x11, 0x88];

    fn boxed(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut bytes = ((data.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend(kind);
        bytes.extend(data);
        bytes
    }

    fn word(data: &mut [u8], offset: usize, value: u32) {
        data[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
    }

    fn desc(tag: u8, data: &[u8]) -> Vec<u8> {
        assert!(data.len() < 128);
        [vec![tag, data.len() as u8], data.to_vec()].concat()
    }

    fn esds() -> Vec<u8> {
        let mut decoder = vec![0; 13];
        decoder[0] = 0x40;
        decoder[1] = 0x15;
        decoder.extend(desc(5, ASC));
        let es = [vec![0, 2, 0], desc(4, &decoder), desc(6, &[2])].concat();
        [vec![0; 4], desc(3, &es)].concat()
    }

    fn track(id: u32, audio: bool, edit_offset: u32) -> Vec<u8> {
        let mut tkhd = vec![0; 84];
        word(&mut tkhd, 12, id);
        let mut mdhd = vec![0; 24];
        word(&mut mdhd, 12, if audio { 48_000 } else { 1000 });
        let mut hdlr = vec![0; 12];
        hdlr[8..12].copy_from_slice(if audio { b"soun" } else { b"vide" });
        let mut entry = vec![0; if audio { 28 } else { 78 }];
        entry[7] = 1;
        if audio {
            entry[16..18].copy_from_slice(&1u16.to_be_bytes());
            word(&mut entry, 24, 48_000 * 65_536);
            entry.extend(boxed(b"esds", &esds()));
        } else {
            entry[24..26].copy_from_slice(&640u16.to_be_bytes());
            entry[26..28].copy_from_slice(&360u16.to_be_bytes());
            entry.extend(boxed(b"avcC", AVC));
        }
        let stsd = [
            vec![0, 0, 0, 0, 0, 0, 0, 1],
            boxed(if audio { b"mp4a" } else { b"avc1" }, &entry),
        ]
        .concat();
        let stbl = [
            boxed(b"stsd", &stsd),
            boxed(b"stts", &[0; 8]),
            boxed(b"stsc", &[0; 8]),
            boxed(b"stsz", &[0; 12]),
            boxed(b"stco", &[0; 8]),
        ]
        .concat();
        let dref = [vec![0, 0, 0, 0, 0, 0, 0, 1], boxed(b"url ", &[0, 0, 0, 1])].concat();
        let minf = [
            boxed(if audio { b"smhd" } else { b"vmhd" }, &[0; 8]),
            boxed(b"dinf", &boxed(b"dref", &dref)),
            boxed(b"stbl", &stbl),
        ]
        .concat();
        let mdia = [
            boxed(b"mdhd", &mdhd),
            boxed(b"hdlr", &hdlr),
            boxed(b"minf", &minf),
        ]
        .concat();
        let mut edit = vec![0; 20];
        word(&mut edit, 4, 1);
        word(&mut edit, 12, edit_offset);
        word(&mut edit, 16, 65_536);
        boxed(
            b"trak",
            &[
                boxed(b"tkhd", &tkhd),
                boxed(b"edts", &boxed(b"elst", &edit)),
                boxed(b"mdia", &mdia),
            ]
            .concat(),
        )
    }

    fn init(audio: bool, priming: bool) -> Vec<u8> {
        let mut moov = boxed(b"mvhd", &[0; 100]);
        moov.extend(track(1, false, 0));
        if audio {
            moov.extend(track(2, true, if priming { 1024 } else { 0 }));
        }
        let mut mvex = Vec::new();
        for id in 1..=if audio { 2 } else { 1 } {
            let mut trex = vec![0; 24];
            word(&mut trex, 4, id);
            word(&mut trex, 8, 1);
            mvex.extend(boxed(b"trex", &trex));
        }
        moov.extend(boxed(b"mvex", &mvex));
        [boxed(b"ftyp", b"iso6\0\0\0\0iso6"), boxed(b"moov", &moov)].concat()
    }

    fn traf(id: u32, start: u64, durations: &[u32], data_offset: u32) -> Vec<u8> {
        let mut tfhd = vec![0; 20];
        word(&mut tfhd, 0, 0x20038);
        word(&mut tfhd, 4, id);
        word(&mut tfhd, 8, durations[0]);
        word(&mut tfhd, 12, 4);
        let tfdt = [&[1, 0, 0, 0][..], &start.to_be_bytes()].concat();
        let mut trun = vec![0; 12];
        word(&mut trun, 0, 0x301);
        word(&mut trun, 4, durations.len() as u32);
        word(&mut trun, 8, data_offset);
        for duration in durations {
            trun.extend(duration.to_be_bytes());
            trun.extend(4u32.to_be_bytes());
        }
        boxed(
            b"traf",
            &[
                boxed(b"tfhd", &tfhd),
                boxed(b"tfdt", &tfdt),
                boxed(b"trun", &trun),
            ]
            .concat(),
        )
    }

    fn fragment(
        video_start: u64,
        video_duration: u32,
        video_count: usize,
        audio: Option<(u64, Vec<u32>)>,
    ) -> Vec<u8> {
        let build = |offset: u32| {
            let mut data = boxed(b"mfhd", &[0; 8]);
            data.extend(traf(
                1,
                video_start,
                &vec![video_duration; video_count],
                offset,
            ));
            if let Some((start, ref durations)) = audio {
                data.extend(traf(2, start, durations, offset + video_count as u32 * 4));
            }
            boxed(b"moof", &data)
        };
        let length = build(0).len();
        let count = video_count + audio.as_ref().map_or(0, |(_, d)| d.len());
        [
            build(length as u32 + 8),
            boxed(b"mdat", &vec![0; count * 4]),
        ]
        .concat()
    }

    fn manifest(durations: &[&str], sequence: u64) -> String {
        let mut out = format!(
            "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:32\n#EXT-X-MEDIA-SEQUENCE:{sequence}\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI=\"init.mp4\"\n"
        );
        for (i, duration) in durations.iter().enumerate() {
            out.push_str(&format!("#EXTINF:{duration},\ns{i}.m4s\n"));
        }
        out.push_str("#EXT-X-ENDLIST\n");
        out
    }

    fn dump(bytes: &[u8]) -> String {
        let mut out = String::new();
        for (i, line) in bytes.chunks(16).enumerate() {
            out.push_str(&format!("\n{:08x}: ", i * 16));
            for pair in line.chunks(2) {
                for byte in pair {
                    out.push_str(&format!("{byte:02x}"));
                }
                out.push(' ');
            }
            out.push_str(" ASCII");
        }
        out
    }

    fn probe(structure: &Structure) -> Value {
        let mut streams = Vec::new();
        let mut records = Vec::new();
        for (index, track) in structure.tracks.iter().enumerate() {
            let mut stream = json!({"index":index,"id":format!("0x{:x}",track.id),"codec_type":track.kind.name(),"time_base":format!("1/{}",track.scale),"extradata":dump(&track.codec_config),"extradata_size":track.codec_config.len()});
            if track.kind == TrackKind::Video {
                stream["codec_name"] = json!("h264");
                stream["has_b_frames"] = json!(0);
                stream["width"] = json!(640);
                stream["height"] = json!(360);
            } else {
                stream["codec_name"] = json!("aac");
                stream["sample_rate"] = json!("48000");
                stream["channels"] = json!(1);
            }
            streams.push(stream);
            for (i, sample) in structure.samples[&track.id].iter().enumerate() {
                let duration = if track.kind == TrackKind::Audio {
                    1024
                } else {
                    sample.duration
                };
                let mut packet = json!({"type":"packet","stream_index":index,"pts":sample.pts,"dts":sample.pts,"duration":duration});
                let priming = i == 0 && track.kind == TrackKind::Audio && track.media_time == 1024;
                if priming {
                    packet["side_data_list"] = json!([{"side_data_type":"Skip Samples","skip_samples":1024,"discard_padding":0}]);
                }
                records.push(packet);
                if priming {
                    continue;
                }
                let mut frame = json!({"type":"frame","stream_index":index,"media_type":track.kind.name(),"pts":sample.pts,"best_effort_timestamp":sample.pts,"duration":duration});
                if track.kind == TrackKind::Video {
                    frame["width"] = json!(640);
                    frame["height"] = json!(360);
                } else {
                    frame["nb_samples"] = json!(1024);
                }
                records.push(frame);
            }
        }
        json!({"streams":streams,"packets_and_frames":records})
    }

    fn fixture(audio: bool, priming: bool) -> Structure {
        let mut structure = Structure::new(&manifest(&["1"], 7), &init(audio, priming)).unwrap();
        let audio = audio.then(|| {
            let mut durations = vec![1024; if priming { 47 } else { 46 }];
            durations.push(896);
            (0, durations)
        });
        structure
            .ingest_fragment(&fragment(0, 40, 25, audio), 0)
            .unwrap();
        structure
    }

    fn rejects<T: std::fmt::Debug>(result: Result<T>, reason: &str) {
        assert!(result.unwrap_err().to_string().contains(reason));
    }

    #[test]
    fn every_sample_decoded_and_priming_is_explicit() {
        for (audio, priming) in [(false, false), (true, false), (true, true)] {
            let structure = fixture(audio, priming);
            let proof = structure.inspect_probe(&probe(&structure)).unwrap();
            assert_eq!(proof.source_origin_ms, 0);
            assert_eq!(proof.duration_ms, 1000.0);
            assert_eq!(proof.media_sequence, 7);
            assert_eq!(proof.tracks[0].decoded_frames, 25);
            assert_eq!(proof.tracks.len(), if audio { 2 } else { 1 });
            if audio {
                assert_eq!(
                    proof.tracks[1].priming_samples,
                    if priming { 1024 } else { 0 }
                );
                assert_eq!(proof.tracks[1].tail_padding_samples, 128);
                assert_eq!(proof.tracks[1].raw_end_seconds, 1.0);
                assert_eq!(proof.tracks[1].decoded_first_pts, 0);
            }
            let serialized = serde_json::to_value(&proof).unwrap();
            assert_eq!(serialized["version"], 1);
            assert_eq!(serialized["manifest_sha256"], proof.closure.manifest_sha256);
            assert_eq!(
                serde_json::from_value::<TimelineProof>(serialized).unwrap(),
                proof
            );
        }
    }

    #[test]
    fn independently_supports_thirty_fps() {
        let mut init = init(false, false);
        let mdhd = init.windows(4).position(|b| b == b"mdhd").unwrap() + 4;
        word(&mut init, mdhd + 12, 30_000);
        let mut structure = Structure::new(&manifest(&["1"], 0), &init).unwrap();
        structure
            .ingest_fragment(&fragment(0, 1000, 30, None), 0)
            .unwrap();
        assert_eq!(
            structure.inspect_probe(&probe(&structure)).unwrap().tracks[0].decoded_frames,
            30
        );
    }

    #[test]
    fn byte_ranges_and_repeated_identical_maps_are_explicit_disjoint_projections() {
        let base = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n";
        let body = "#EXT-X-MAP:BYTERANGE=\"20@0\",URI=\"all.mp4\"\n#EXTINF:1,\n#EXT-X-BYTERANGE:30@20\nall.mp4\n#EXT-X-MAP:URI=\"all.mp4\",BYTERANGE=\"20@0\"\n#EXTINF:1,\n#EXT-X-BYTERANGE:40\nall.mp4\n#EXT-X-ENDLIST\n";
        let parsed = parse_playlist(&format!("{base}{body}")).unwrap();
        assert_eq!(
            parsed.map_range,
            Some(ByteRange {
                offset: 0,
                length: 20
            })
        );
        assert_eq!(
            parsed.segments[0].range,
            Some(ByteRange {
                offset: 20,
                length: 30
            })
        );
        assert_eq!(
            parsed.segments[1].range,
            Some(ByteRange {
                offset: 50,
                length: 40
            })
        );
        for invalid in [
            body.replace("30@20", "30@19"),
            body.replace("30@20", "30"),
            body.replace(
                "#EXT-X-BYTERANGE:40\nall.mp4",
                "#EXT-X-BYTERANGE:40\nother.mp4",
            ),
            body.replace("BYTERANGE=\"20@0\"", "BYTERANGE=\"20\""),
            body.replace("BYTERANGE=\"20@0\"", "BYTERANGE=\"0@0\""),
            body.replace(
                "BYTERANGE=\"20@0\"",
                "BYTERANGE=\"20@18446744073709551615\"",
            ),
            body.replace("BYTERANGE=\"20@0\"\n#EXTINF", "BYTERANGE=\"21@0\"\n#EXTINF"),
        ] {
            assert!(
                parse_playlist(&format!("{base}{invalid}")).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn clear_metadata_and_redundant_boundaries_still_require_actual_continuity() {
        let text = manifest(&["1", "1"], 0)
            .replace(
                "#EXT-X-MAP:",
                "#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-KEY:METHOD=NONE\n#EXT-X-MAP:",
            )
            .replace(
                "#EXTINF:1,\ns1.m4s",
                "#EXT-X-DISCONTINUITY\n#EXTINF:1,\ns1.m4s",
            );
        assert_eq!(parse_source_playlist(&text).unwrap().segments.len(), 2);
        assert!(parse_playlist(&text).is_err());
        let mut structure = Structure::new(&text, &init(false, false)).unwrap();
        structure
            .ingest_fragment(&fragment(0, 40, 25, None), 0)
            .unwrap();
        structure
            .ingest_fragment(&fragment(1000, 40, 25, None), 1)
            .unwrap();
        assert!(structure.inspect_probe(&probe(&structure)).is_ok());
        // The same accepted marker cannot turn a genuine timestamp reset into
        // a scalar room timeline or qualify a changed source.
        let mut reset = Structure::new(&text, &init(false, false)).unwrap();
        reset
            .ingest_fragment(&fragment(0, 40, 25, None), 0)
            .unwrap();
        reset
            .ingest_fragment(&fragment(0, 40, 25, None), 1)
            .unwrap();
        assert!(reset.inspect_probe(&probe(&reset)).is_err());
        assert!(
            parse_playlist(&text.replace("#EXT-X-ENDLIST", "#EXT-X-DISCONTINUITY\n#EXT-X-ENDLIST"))
                .is_err()
        );
    }

    #[test]
    fn syntax_is_closed_finite_and_bounded() {
        let source = manifest(&["1"], 0);
        for tag in [
            "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"",
            "#EXT-X-START:TIME-OFFSET=1",
            "#EXT-X-UNKNOWN:1",
            "#EXT-X-STREAM-INF:BANDWIDTH=1",
            "#EXT-X-PLAYLIST-TYPE:EVENT",
        ] {
            rejects(
                parse_playlist(
                    &source.replace("#EXT-X-ENDLIST", &format!("{tag}\n#EXT-X-ENDLIST")),
                ),
                "unsupported_manifest_tag",
            );
        }
        rejects(
            parse_playlist(
                &source.replace("#EXT-X-ENDLIST", "#EXT-X-BYTERANGE:4@0\n#EXT-X-ENDLIST"),
            ),
            "byte_range_order",
        );
        rejects(
            parse_playlist(&source.replace("#EXT-X-ENDLIST\n", "")),
            "static_fmp4_required",
        );
        rejects(
            parse_playlist(&source.replace("#EXT-X-VERSION:7", "#EXT-X-VERSION:8")),
            "manifest_version",
        );
        rejects(
            parse_playlist(&source.replace("s0.m4s", "init.mp4")),
            "duplicate_resource",
        );
        rejects(
            parse_playlist(&source.replace("s0.m4s", "s 0.m4s")),
            "segment_reference",
        );
        rejects(
            parse_playlist(&source.replace("s0.m4s", "{$segment}")),
            "segment_reference",
        );
        rejects(
            parse_playlist(&source.replace("MEDIA-SEQUENCE:0", "MEDIA-SEQUENCE:9007199254740992")),
            "media_sequence",
        );
        rejects(
            parse_playlist(&source.replace("#EXTINF:1,", "#EXTINF:0,")),
            "segment_duration_bound",
        );
        rejects(
            parse_playlist(&source.replace("#EXTINF:1,", "#EXTINF:1.0000001,")),
            "duration_format",
        );
        rejects(parse_playlist(&manifest(&["32"; 10], 0)), "duration_bound");
        rejects(
            parse_playlist(&manifest(&["1"; 65], 0)),
            "segment_count_bound",
        );
        rejects(
            parse_playlist(&"x".repeat(MAX_MANIFEST_BYTES + 1)),
            "manifest_bound",
        );
        assert_eq!(
            parse_playlist(&source.replace('\n', "\r\n"))
                .unwrap()
                .seconds,
            1.0
        );
        assert_eq!(
            parse_playlist(&source.replace("s0.m4s", "s0.m4s?b=2&a=1"))
                .unwrap()
                .segments[0]
                .uri,
            "s0.m4s?b=2&a=1"
        );
    }

    #[test]
    fn malformed_bmff_and_unknown_codec_extensions_fail_without_panics() {
        let original = init(false, false);
        for length in 0..original.len() {
            assert!(inspect_init(&original[..length]).is_err());
        }
        let mut changed = original.clone();
        let avcc = changed.windows(4).position(|b| b == b"avcC").unwrap() + 4;
        changed[avcc] = 0;
        rejects(inspect_init(&changed), "unsupported_avcc");
        let mut changed = original.clone();
        changed[avcc + 4] = 0xfe;
        rejects(inspect_init(&changed), "unsupported_avcc");
        let mut changed = original.clone();
        changed[avcc + 3] ^= 1;
        rejects(inspect_init(&changed), "avcc_header_mismatch");
        let mut changed = original.clone();
        changed[avcc - 4..avcc].copy_from_slice(b"sinf");
        rejects(inspect_init(&changed), "unsupported_sample_extension");
        let mut changed = original.clone();
        let url = changed.windows(4).position(|b| b == b"url ").unwrap() + 4;
        changed[url + 3] = 0;
        rejects(inspect_init(&changed), "external_data_reference");
        let mut changed = original.clone();
        let elst = changed.windows(4).position(|b| b == b"elst").unwrap() + 4;
        word(&mut changed, elst + 12, 1);
        rejects(inspect_init(&changed), "unknown_edit_offset");
        rejects(inspect_init(&vec![0; MAX_INIT_BYTES + 1]), "init_bound");
    }

    #[test]
    fn closure_completion_and_ingestion_are_transactional() {
        let mut structure = Structure::new(&manifest(&["1", "1"], 0), &init(false, false)).unwrap();
        rejects(structure.byte_identity(), "incomplete_closure");
        rejects(
            structure.ingest_fragment(&fragment(0, 40, 25, None), 1),
            "fragment_order",
        );
        let first = fragment(0, 40, 25, None);
        let mut bad = first.clone();
        let trun = bad.windows(4).position(|b| b == b"trun").unwrap() + 4;
        word(&mut bad, trun + 8, 0);
        rejects(structure.ingest_fragment(&bad, 0), "media_payload_offset");
        assert_eq!(structure.sample_count, 0);
        assert!(structure.identity.segments.is_empty());
        structure.ingest_fragment(&first, 0).unwrap();
        rejects(structure.ingest_fragment(&first, 0), "fragment_order");
        structure
            .ingest_fragment(&fragment(1000, 40, 25, None), 1)
            .unwrap();
        assert_eq!(
            structure
                .inspect_probe(&probe(&structure))
                .unwrap()
                .duration_ms,
            2000.0
        );
        rejects(structure.ingest_fragment(&first, 2), "fragment_order");
    }

    #[test]
    fn nonzero_origin_and_undeclared_later_jump_are_not_normalized() {
        let mut offset = Structure::new(&manifest(&["1"], 7), &init(false, false)).unwrap();
        offset
            .ingest_fragment(&fragment(4000, 40, 25, None), 0)
            .unwrap();
        rejects(
            offset.inspect_probe(&probe(&offset)),
            "nonzero_presentation_origin",
        );
        let mut gap = Structure::new(&manifest(&["1", "1"], 0), &init(false, false)).unwrap();
        gap.ingest_fragment(&fragment(0, 40, 25, None), 0).unwrap();
        gap.ingest_fragment(&fragment(2000, 40, 25, None), 1)
            .unwrap();
        rejects(
            gap.inspect_probe(&probe(&gap)),
            "source_timestamp_gap_or_overlap",
        );
    }

    #[test]
    fn reserved_mp4_audio_count_uses_asc_and_still_requires_decoder_agreement() {
        let mut bytes = init(true, true);
        let entry = bytes.windows(4).position(|v| v == b"mp4a").unwrap() + 4;
        bytes[entry + 16..entry + 18].copy_from_slice(&2u16.to_be_bytes());
        let mut structure = fixture(true, true);
        structure.tracks = inspect_init(&bytes).unwrap();
        assert_eq!(structure.tracks[1].channels, Some(1));
        let mut decoded = probe(&structure);
        structure.inspect_probe(&decoded).unwrap();
        decoded["streams"][1]["channels"] = json!(2);
        rejects(structure.inspect_probe(&decoded), "audio_recipe_scope");

        let config = &structure.tracks[1].codec_config;
        let asc = bytes
            .windows(config.len())
            .position(|v| v == config)
            .unwrap();
        bytes[asc + 1] = (bytes[asc + 1] & 0x87) | (2 << 3);
        assert_eq!(inspect_init(&bytes).unwrap()[1].channels, Some(2));
        bytes[entry + 16..entry + 18].copy_from_slice(&1u16.to_be_bytes());
        rejects(inspect_init(&bytes), "unsupported_aac_config");
    }

    #[test]
    fn reserved_mp4_audio_count_cannot_admit_unknown_aac_layouts() {
        let mut original = init(true, false);
        let entry = original.windows(4).position(|v| v == b"mp4a").unwrap() + 4;
        original[entry + 16..entry + 18].copy_from_slice(&2u16.to_be_bytes());
        let config = inspect_init(&original).unwrap()[1].codec_config.clone();
        let asc = original
            .windows(config.len())
            .position(|v| v == config)
            .unwrap();
        for channels in [0, 3, 7, 15] {
            let mut changed = original.clone();
            changed[asc + 1] = (changed[asc + 1] & 0x87) | (channels << 3);
            rejects(inspect_init(&changed), "unsupported_aac_config");
        }
        for channels in [0u16, 3, 65535] {
            let mut changed = original.clone();
            changed[entry + 16..entry + 18].copy_from_slice(&channels.to_be_bytes());
            rejects(inspect_init(&changed), "init_audio_bound");
        }
    }

    #[test]
    fn every_packet_frame_and_codec_configuration_is_required() {
        let structure = fixture(true, true);
        let original = probe(&structure);
        let mut missing = original.clone();
        missing["packets_and_frames"]
            .as_array_mut()
            .unwrap()
            .remove(1);
        rejects(structure.inspect_probe(&missing), "decoded_sample_count");
        let mut missing = original.clone();
        missing["packets_and_frames"][0]
            .as_object_mut()
            .unwrap()
            .remove("pts");
        rejects(structure.inspect_probe(&missing), "packet_pts");
        let mut invented = original.clone();
        invented["packets_and_frames"][1]
            .as_object_mut()
            .unwrap()
            .remove("pts");
        rejects(
            structure.inspect_probe(&invented),
            "decoded_presentation_clock",
        );
        let mut geometry = original.clone();
        geometry["packets_and_frames"][1]["width"] = json!(800);
        rejects(structure.inspect_probe(&geometry), "video_geometry_changed");
        let mut reorder = original.clone();
        reorder["streams"][0]["has_b_frames"] = json!(1);
        rejects(structure.inspect_probe(&reorder), "video_recipe_scope");
        let mut forged = original.clone();
        forged["streams"][0]["extradata"] = json!(dump(&[1, 2]));
        forged["streams"][0]["extradata_size"] = json!(2);
        rejects(
            structure.inspect_probe(&forged),
            "decoder_codec_config_mismatch",
        );
        let mut missing = original.clone();
        missing["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("extradata");
        rejects(
            structure.inspect_probe(&missing),
            "decoder_codec_config_missing",
        );
        let mut extra = original.clone();
        extra["packets_and_frames"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"packet","stream_index":99}));
        rejects(structure.inspect_probe(&extra), "decoder_extra_track");
        let mut overflow = original;
        overflow["packets_and_frames"] = json!(vec![Value::Null; MAX_RECORDS + 1]);
        rejects(structure.inspect_probe(&overflow), "decoder_record_bound");
    }

    #[test]
    fn complete_decoded_edit_preroll_is_measured_without_invented_skip_metadata() {
        let structure = fixture(true, true);
        let mut decoded = probe(&structure);
        let records = decoded["packets_and_frames"].as_array_mut().unwrap();
        let first = records
            .iter()
            .position(|r| r["stream_index"] == 1 && r["type"] == "packet")
            .unwrap();
        records[first]
            .as_object_mut()
            .unwrap()
            .remove("side_data_list");
        records[first].as_object_mut().unwrap().remove("duration");
        records.insert(
            first + 1,
            json!({"type":"frame","stream_index":1,
            "media_type":"audio","pts":-1024,"best_effort_timestamp":-1024,
            "nb_samples":1024}),
        );
        let measured = structure.inspect_probe(&decoded).unwrap();
        assert_eq!(measured.tracks[1].raw_first_pts, -1024);
        assert_eq!(measured.tracks[1].decoded_first_pts, 0);
        assert_eq!(measured.tracks[1].priming_samples, 1024);
        assert_eq!(
            measured.tracks[1].decoded_frames,
            structure.samples[&2].len()
        );
        let mut missing = decoded.clone();
        missing["packets_and_frames"]
            .as_array_mut()
            .unwrap()
            .remove(first + 1);
        rejects(structure.inspect_probe(&missing), "decoded_sample_count");
        let mut shifted = decoded.clone();
        shifted["packets_and_frames"][first + 1]["pts"] = json!(-512);
        rejects(
            structure.inspect_probe(&shifted),
            "decoded_presentation_clock",
        );
        let mut short = decoded;
        short["packets_and_frames"][first + 1]["nb_samples"] = json!(512);
        rejects(structure.inspect_probe(&short), "audio_sample_clock");
        short["packets_and_frames"][first + 1]["nb_samples"] = json!(1024);
        short["packets_and_frames"][first]["duration"] = json!(512);
        rejects(structure.inspect_probe(&short), "aac_priming_mismatch");
    }

    #[test]
    fn unknown_priming_and_raw_audio_tail_fail() {
        let structure = fixture(true, true);
        for (key, value) in [("skip_samples", 512), ("discard_padding", 1)] {
            let mut changed = probe(&structure);
            let packet = changed["packets_and_frames"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|r| r["stream_index"] == 1 && r["type"] == "packet")
                .unwrap();
            packet["side_data_list"][0][key] = json!(value);
            rejects(structure.inspect_probe(&changed), "aac_priming_mismatch");
        }
        for duration in [1, 1023] {
            let mut structure = fixture(true, true);
            structure
                .samples
                .get_mut(&2)
                .unwrap()
                .last_mut()
                .unwrap()
                .duration = duration;
            rejects(
                structure.inspect_probe(&probe(&structure)),
                "audio_video_end_alignment",
            );
        }
    }

    #[test]
    fn last_segment_cannot_change_tracks_or_tables() {
        let mut structure = Structure::new(&manifest(&["1", "1"], 0), &init(true, true)).unwrap();
        let first = fragment(0, 40, 25, Some((0, vec![1024; 48])));
        structure.ingest_fragment(&first, 0).unwrap();
        rejects(
            structure.ingest_fragment(&fragment(1000, 40, 25, None), 1),
            "segment_track_set_changed",
        );
        let mut unknown = first.clone();
        let tfhd = unknown.windows(4).position(|b| b == b"tfhd").unwrap() + 4;
        word(&mut unknown, tfhd + 4, 999);
        rejects(
            structure.ingest_fragment(&unknown, 1),
            "fragment_unknown_track",
        );
        let mut count = first;
        let trun = count.windows(4).position(|b| b == b"trun").unwrap() + 4;
        word(&mut count, trun + 4, u32::MAX);
        rejects(structure.ingest_fragment(&count, 1), "unsupported_trun");
        assert_eq!(structure.identity.segments.len(), 1);
    }

    #[test]
    fn complete_hash_inventory_freezes_same_size_payloads_and_query_order() {
        let structure = fixture(false, false);
        let expected = structure.byte_identity().unwrap();
        require_same_closure(&expected, &expected).unwrap();
        let mut changed = Structure::new(&manifest(&["1"], 7), &init(false, false)).unwrap();
        let mut bytes = fragment(0, 40, 25, None);
        *bytes.last_mut().unwrap() ^= 1;
        changed.ingest_fragment(&bytes, 0).unwrap();
        assert_eq!(
            expected.segments[0].bytes,
            changed.identity.segments[0].bytes
        );
        rejects(
            require_same_closure(&expected, &changed.byte_identity().unwrap()),
            "source_changed",
        );
        let mut changed = expected.clone();
        changed.manifest_sha256 = sha(manifest(&["1"], 7)
            .replace("s0.m4s", "s0.m4s?signature=changed")
            .as_bytes());
        rejects(require_same_closure(&expected, &changed), "source_changed");
        let mut changed = expected.clone();
        changed.init.sha256 = sha(b"different init");
        rejects(require_same_closure(&expected, &changed), "source_changed");
        for invalid in [
            ClosureIdentity {
                segments: Vec::new(),
                ..expected.clone()
            },
            ClosureIdentity {
                manifest_sha256: String::new(),
                ..expected.clone()
            },
            ClosureIdentity {
                init: ResourceIdentity {
                    bytes: 0,
                    sha256: "a".repeat(64),
                },
                ..expected.clone()
            },
        ] {
            rejects(
                require_same_closure(&invalid, &invalid),
                "closure_proof_shape",
            );
        }
    }

    #[test]
    fn ascii_column_never_becomes_decoder_configuration() {
        assert_eq!(
            probe_extradata(&json!({"extradata":dump(AVC),"extradata_size":AVC.len()})).unwrap(),
            AVC
        );
        rejects(
            probe_extradata(&json!({"extradata":"00000001: 0164  001f"})),
            "decoder_codec_config_dump",
        );
        rejects(
            probe_extradata(&json!({"extradata":"00000000: 01zz  001f"})),
            "decoder_codec_config_dump",
        );
        rejects(
            probe_extradata(&json!({"extradata":"00000000: 0164  001f","extradata_size":4})),
            "decoder_codec_config_dump",
        );
    }
}

#[path = "timeline_finite.rs"]
mod finite_normalization;
pub use finite_normalization::FiniteTrackMapping;
pub(crate) use finite_normalization::finite_fragment_rebase;
