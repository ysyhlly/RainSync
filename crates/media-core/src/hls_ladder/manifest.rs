use super::{
    FRAME_RATE, MAX_DURATION_MS, MAX_MANIFEST_BYTES, MAX_RENDITIONS, MAX_SEGMENTS, RenditionId,
    Resource,
};
use anyhow::{Result, ensure};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub index: usize,
    pub duration_us: u64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaPlaylist {
    pub segments: Vec<Segment>,
    pub complete: bool,
}
impl MediaPlaylist {
    pub fn duration_us(&self) -> u64 {
        self.segments.iter().map(|s| s.duration_us).sum()
    }
    pub fn first_duration_us(&self) -> u64 {
        self.segments[0].duration_us
    }
}
fn lines(text: &str) -> Result<Vec<&str>> {
    ensure!(
        text.len() <= MAX_MANIFEST_BYTES && text.ends_with('\n') && !text.contains('\0'),
        "hls_ladder_manifest_bound"
    );
    let lines: Vec<_> = text.lines().collect();
    ensure!(
        lines.first() == Some(&"#EXTM3U")
            && lines.iter().all(|s| !s.is_empty()
                && s.trim() == *s
                && !s.bytes().any(|b| b.is_ascii_control())),
        "hls_ladder_manifest_header"
    );
    Ok(lines)
}
fn uint(raw: &str) -> Result<u64> {
    ensure!(
        !raw.is_empty()
            && raw.bytes().all(|b| b.is_ascii_digit())
            && (raw == "0" || !raw.starts_with('0')),
        "hls_ladder_manifest_number"
    );
    raw.parse()
        .map_err(|_| anyhow::anyhow!("hls_ladder_manifest_number"))
}
fn duration(raw: &str) -> Result<u64> {
    let (whole, fractional) = raw.split_once('.').unwrap_or((raw, ""));
    let seconds = uint(whole)?;
    ensure!(
        fractional.len() <= 6
            && fractional.bytes().all(|b| b.is_ascii_digit())
            && (!raw.contains('.') || !fractional.is_empty()),
        "hls_ladder_manifest_duration"
    );
    let fraction = if fractional.is_empty() {
        0
    } else {
        fractional.parse::<u64>()? * 10u64.pow(6 - fractional.len() as u32)
    };
    let value = seconds
        .checked_mul(1_000_000)
        .and_then(|n| n.checked_add(fraction))
        .ok_or_else(|| anyhow::anyhow!("hls_ladder_manifest_duration"))?;
    ensure!(
        value > 0 && value <= 4_000_000,
        "hls_ladder_manifest_duration"
    );
    Ok(value)
}
/// Parse only this recipe's complete EVENT snapshot. No external/encoded path,
/// traversal, key/DRM URI, discontinuity, byte range, LL-HLS or extra tag.
pub fn parse_media_playlist(text: &str) -> Result<MediaPlaylist> {
    let lines = lines(text)?;
    let mut tags = BTreeSet::new();
    let mut segments = Vec::new();
    let mut pending = None;
    let mut complete = false;
    let mut target_duration = None;
    for line in &lines[1..] {
        ensure!(!complete, "hls_ladder_manifest_after_end");
        if let Some(raw) = line.strip_prefix("#EXTINF:") {
            ensure!(
                pending.is_none() && tags.len() >= 5,
                "hls_ladder_manifest_order"
            );
            let raw = raw
                .strip_suffix(',')
                .ok_or_else(|| anyhow::anyhow!("hls_ladder_manifest_duration"))?;
            pending = Some(duration(raw)?);
        } else if *line == "#EXT-X-ENDLIST" {
            ensure!(
                pending.is_none() && !segments.is_empty(),
                "hls_ladder_manifest_order"
            );
            complete = true;
        } else if line.starts_with('#') {
            ensure!(
                pending.is_none() && segments.is_empty(),
                "hls_ladder_manifest_order"
            );
            let tag = match *line {
                "#EXT-X-VERSION:7" => "version",
                "#EXT-X-TARGETDURATION:1"
                | "#EXT-X-TARGETDURATION:2"
                | "#EXT-X-TARGETDURATION:3"
                | "#EXT-X-TARGETDURATION:4" => {
                    target_duration =
                        Some(uint(line.strip_prefix("#EXT-X-TARGETDURATION:").unwrap())?);
                    "target"
                }
                "#EXT-X-MEDIA-SEQUENCE:0" => "sequence",
                "#EXT-X-PLAYLIST-TYPE:EVENT" => "type",
                "#EXT-X-MAP:URI=\"init.mp4\"" => "map",
                "#EXT-X-INDEPENDENT-SEGMENTS" => "independent",
                _ => anyhow::bail!("hls_ladder_manifest_tag_unsupported"),
            };
            ensure!(tags.insert(tag), "hls_ladder_manifest_duplicate_tag");
        } else {
            let duration_us = pending
                .take()
                .ok_or_else(|| anyhow::anyhow!("hls_ladder_manifest_order"))?;
            let index = segments.len();
            ensure!(
                index < MAX_SEGMENTS && *line == format!("index{index}.m4s"),
                "hls_ladder_manifest_uri_invalid"
            );
            segments.push(Segment { index, duration_us });
        }
    }
    ensure!(
        ["version", "target", "sequence", "type", "map"]
            .iter()
            .all(|t| tags.contains(t))
            && pending.is_none()
            && !segments.is_empty(),
        "hls_ladder_manifest_incomplete"
    );
    ensure!(
        segments
            .iter()
            .enumerate()
            .all(|(i, s)| s.duration_us == 4_000_000 || (complete && i + 1 == segments.len()))
            && segments.iter().map(|s| s.duration_us).sum::<u64>() <= MAX_DURATION_MS * 1000,
        "hls_ladder_manifest_unaligned"
    );
    let target_duration =
        target_duration.ok_or_else(|| anyhow::anyhow!("hls_ladder_manifest_incomplete"))?;
    if target_duration < 4 {
        // FFmpeg can round TARGETDURATION below four for a short source.
        // HLS bounds EXTINF after nearest-integer rounding. This exception is
        // one complete final segment only; it never changes EVENT alignment,
        // the content clock bound or the generated conservative-four target.
        ensure!(
            complete
                && segments.len() == 1
                && segments[0].duration_us < 4_000_000
                && (segments[0].duration_us + 500_000) / 1_000_000 <= target_duration,
            "hls_ladder_manifest_short_target_invalid"
        );
    }
    Ok(MediaPlaylist { segments, complete })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterVariant {
    pub id: RenditionId,
    pub bandwidth: u32,
    pub width: u32,
    pub height: u32,
    pub codecs: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterPlaylist {
    pub variants: Vec<MasterVariant>,
}
impl MasterPlaylist {
    pub(super) fn render(&self) -> String {
        // INDEPENDENT-SEGMENTS is intentionally absent: startup only qualified
        // first fragments. Serving later fragments requires per-segment checks.
        let mut result = "#EXTM3U\n#EXT-X-VERSION:7\n".to_owned();
        for r in &self.variants {
            result.push_str(&format!("#EXT-X-STREAM-INF:BANDWIDTH={},RESOLUTION={}x{},FRAME-RATE=30.000,CODECS=\"{}\"\n{}\n", r.bandwidth, r.width, r.height, r.codecs, Resource::Playlist(r.id).path()));
        }
        result
    }
}
fn attributes(raw: &str) -> Result<BTreeMap<&str, &str>> {
    let mut values = BTreeMap::new();
    let mut remaining = raw;
    while !remaining.is_empty() {
        let (name, value) = remaining
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("hls_ladder_master_attributes"))?;
        let (value, next) = if let Some(quoted) = value.strip_prefix('"') {
            let (value, tail) = quoted
                .split_once('"')
                .ok_or_else(|| anyhow::anyhow!("hls_ladder_master_attributes"))?;
            (
                value,
                if tail.is_empty() {
                    ""
                } else {
                    tail.strip_prefix(',')
                        .ok_or_else(|| anyhow::anyhow!("hls_ladder_master_attributes"))?
                },
            )
        } else {
            value.split_once(',').unwrap_or((value, ""))
        };
        ensure!(
            !value.is_empty() && values.insert(name, value).is_none() && values.len() <= 4,
            "hls_ladder_master_attributes"
        );
        remaining = next;
    }
    ensure!(
        values.len() == 4
            && ["BANDWIDTH", "RESOLUTION", "FRAME-RATE", "CODECS"]
                .iter()
                .all(|name| values.contains_key(name)),
        "hls_ladder_master_attributes"
    );
    Ok(values)
}
/// Parses the versioned generated master only. Paths are the closed rendition
/// IDs, so URL schemes, //, ../, percent encoding, queries and keys cannot pass.
pub fn parse_master(text: &str) -> Result<MasterPlaylist> {
    let lines = lines(text)?;
    ensure!(
        lines.get(1) == Some(&"#EXT-X-VERSION:7") && (lines.len() - 2) % 2 == 0,
        "hls_ladder_master_shape"
    );
    let mut variants = Vec::new();
    let mut ids = BTreeSet::new();
    for pair in lines[2..].chunks(2) {
        ensure!(variants.len() < MAX_RENDITIONS, "hls_ladder_master_limit");
        let raw = pair[0]
            .strip_prefix("#EXT-X-STREAM-INF:")
            .ok_or_else(|| anyhow::anyhow!("hls_ladder_master_tag_unsupported"))?;
        let attrs = attributes(raw)?;
        let Resource::Playlist(id) = Resource::parse(pair[1])? else {
            anyhow::bail!("hls_ladder_master_uri_invalid")
        };
        ensure!(
            ids.insert(id) && variants.last().is_none_or(|r: &MasterVariant| r.id < id),
            "hls_ladder_master_rendition_order"
        );
        let (w, h) = attrs["RESOLUTION"]
            .split_once('x')
            .ok_or_else(|| anyhow::anyhow!("hls_ladder_master_resolution"))?;
        let (width, height) = (u32::try_from(uint(w)?)?, u32::try_from(uint(h)?)?);
        let bandwidth = u32::try_from(uint(attrs["BANDWIDTH"])?)?;
        ensure!(
            (2..=1920).contains(&width)
                && (2..=1080).contains(&height)
                && width % 2 == 0
                && height % 2 == 0
                && bandwidth > 0
                && bandwidth <= 8_000_000
                && attrs["FRAME-RATE"] == format!("{FRAME_RATE}.000")
                && matches!(
                    attrs["CODECS"],
                    "avc1.64001F"
                        | "avc1.640028"
                        | "avc1.64001F,mp4a.40.2"
                        | "avc1.640028,mp4a.40.2"
                ),
            "hls_ladder_master_configuration"
        );
        variants.push(MasterVariant {
            id,
            bandwidth,
            width,
            height,
            codecs: attrs["CODECS"].into(),
        });
    }
    ensure!(!variants.is_empty(), "hls_ladder_master_empty");
    Ok(MasterPlaylist { variants })
}
