use anyhow::{Result, bail, ensure};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq)]
pub struct Variant {
    pub uri: String,
    pub bandwidth: u64,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    pub has_audio: bool,
}
#[derive(Clone, Debug)]
pub struct Master {
    pub variants: Vec<Variant>,
}
impl Master {
    /// One deterministic muxed AVC/AAC variant, selected before reading media.
    /// Source claims only select a candidate; actual decoder facts still govern.
    pub fn selected(&self) -> Result<&Variant> {
        self.variants
            .iter()
            .filter(|v| v.width <= 1920 && v.height <= 1080 && matches!(v.frame_rate, 25.0 | 30.0))
            .max_by_key(|v| (u64::from(v.width) * u64::from(v.height), v.bandwidth))
            .ok_or_else(|| anyhow::anyhow!("unsupported_finite_hls:no_compatible_muxed_variant"))
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Container {
    TransportStream,
    FragmentedMp4,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    pub uri: String,
    pub duration: f64,
    /// A boundary permits a clock reset; it never proves one occurred.
    pub discontinuity: bool,
}
#[derive(Clone, Debug)]
pub struct MediaPlaylist {
    pub container: Container,
    pub map: Option<String>,
    pub segments: Vec<Segment>,
    pub seconds: f64,
    pub sequence: u64,
}
fn fail(condition: bool, reason: &str) -> Result<()> {
    ensure!(condition, "unsupported_finite_hls:{reason}");
    Ok(())
}
fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}
fn uri(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 16384
        && !s.contains("{$")
        && !s.contains('\\')
        && !s.bytes().any(|b| b <= 32 || b == 127)
}
fn lines(text: &str) -> Result<Vec<&str>> {
    fail(text.len() <= super::MAX_MANIFEST_BYTES, "manifest_bound")?;
    let lines: Vec<_> = text
        .trim_end_matches(['\n', '\r'])
        .split('\n')
        .map(|s| s.strip_suffix('\r').unwrap_or(s))
        .collect();
    fail(
        lines.first() == Some(&"#EXTM3U") && lines.iter().all(|s| !s.is_empty() && *s == s.trim()),
        "manifest_header_or_order",
    )?;
    Ok(lines)
}
fn attributes(raw: &str) -> Result<BTreeMap<&str, &str>> {
    let mut rest = raw;
    let mut out = BTreeMap::new();
    while !rest.is_empty() {
        let (name, tail) = rest
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("unsupported_finite_hls:attributes"))?;
        fail(
            !name.is_empty()
                && name.bytes().all(|b| b.is_ascii_uppercase() || b == b'-')
                && !out.contains_key(name),
            "attributes",
        )?;
        let (value, tail) = if let Some(tail) = tail.strip_prefix('"') {
            tail.split_once('"')
                .ok_or_else(|| anyhow::anyhow!("unsupported_finite_hls:attributes"))?
        } else {
            tail.split_once(',').map_or((tail, ""), |(value, tail)| {
                (value, &rest[rest.len() - tail.len() - 1..])
            })
        };
        fail(
            !value.is_empty()
                && !value.bytes().any(|b| b.is_ascii_control())
                && !value.contains('"'),
            "attributes",
        )?;
        out.insert(name, value);
        rest = if tail.is_empty() {
            ""
        } else {
            tail.strip_prefix(',')
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("unsupported_finite_hls:attributes"))?
        };
        fail(out.len() <= 8, "attribute_bound")?;
    }
    Ok(out)
}
pub fn parse_master(text: &str) -> Result<Master> {
    let lines = lines(text)?;
    let mut variants = Vec::new();
    let mut pending = None;
    let mut version = false;
    let mut independent = false;
    for line in &lines[1..] {
        if let Some(raw) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            fail(
                pending.is_none() && variants.len() < 16,
                "master_variant_bound_or_order",
            )?;
            let attr = attributes(raw)?;
            fail(
                attr.keys().all(|n| {
                    matches!(
                        *n,
                        "BANDWIDTH" | "AVERAGE-BANDWIDTH" | "RESOLUTION" | "FRAME-RATE" | "CODECS"
                    )
                }),
                "master_separate_rendition_or_attribute",
            )?;
            let codecs = attr.get("CODECS").copied().unwrap_or("");
            let codecs: Vec<_> = codecs.split(',').collect();
            fail(
                (1..=2).contains(&codecs.len())
                    && codecs[0]
                        .strip_prefix("avc1.")
                        .is_some_and(|s| s.len() == 6 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                    && (codecs.len() == 1 || codecs[1] == "mp4a.40.2"),
                "master_clear_avc_aac_required",
            )?;
            let bandwidth = attr
                .get("BANDWIDTH")
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|n| (1..=100_000_000).contains(n));
            let dimensions = attr
                .get("RESOLUTION")
                .and_then(|s| s.split_once('x'))
                .and_then(|(w, h)| Some((w.parse::<u32>().ok()?, h.parse::<u32>().ok()?)))
                .filter(|(w, h)| *w > 0 && *h > 0 && *w <= 7680 && *h <= 4320);
            let rate = attr
                .get("FRAME-RATE")
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|n| n.is_finite() && *n > 0.0 && *n <= 120.0);
            fail(
                bandwidth.is_some() && dimensions.is_some() && rate.is_some(),
                "master_facts_required",
            )?;
            if let Some(n) = attr.get("AVERAGE-BANDWIDTH") {
                fail(
                    n.parse::<u64>()
                        .is_ok_and(|n| n > 0 && n <= bandwidth.unwrap()),
                    "master_bandwidth",
                )?;
            }
            pending = Some((
                bandwidth.unwrap(),
                dimensions.unwrap(),
                rate.unwrap(),
                codecs.len() == 2,
            ));
        } else if let Some(raw) = line.strip_prefix("#EXT-X-VERSION:") {
            fail(
                !version && pending.is_none() && matches!(raw, "3" | "4" | "5" | "6" | "7"),
                "master_version",
            )?;
            version = true;
        } else if *line == "#EXT-X-INDEPENDENT-SEGMENTS" {
            fail(
                !independent && pending.is_none(),
                "master_independent_order",
            )?;
            independent = true;
        } else if !line.starts_with('#') {
            fail(
                uri(line)
                    && pending.is_some()
                    && !variants.iter().any(|v: &Variant| v.uri == *line),
                "master_variant_reference",
            )?;
            let (bandwidth, (width, height), frame_rate, has_audio) = pending.take().unwrap();
            variants.push(Variant {
                uri: (*line).into(),
                bandwidth,
                width,
                height,
                frame_rate,
                has_audio,
            });
        } else {
            bail!("unsupported_finite_hls:master_tag");
        }
    }
    fail(pending.is_none() && !variants.is_empty(), "master_complete")?;
    Ok(Master { variants })
}
pub fn parse_media(text: &str) -> Result<MediaPlaylist> {
    let lines = lines(text)?;
    let (mut map, mut pending, mut target, mut sequence) = (None, None, None, None);
    let (mut ended, mut vod, mut version, mut independent, mut boundary) =
        (false, false, false, false, false);
    let mut segments = Vec::new();
    let mut seen = BTreeSet::new();
    for line in &lines[1..] {
        fail(!ended, "media_after_end")?;
        if *line == "#EXT-X-ENDLIST" {
            fail(pending.is_none() && !boundary, "media_dangling")?;
            ended = true;
        } else if *line == "#EXT-X-PLAYLIST-TYPE:VOD" {
            fail(!vod && segments.is_empty(), "media_vod")?;
            vod = true;
        } else if let Some(raw) = line.strip_prefix("#EXT-X-VERSION:") {
            fail(
                !version && matches!(raw, "3" | "4" | "5" | "6" | "7"),
                "media_version",
            )?;
            version = true;
        } else if let Some(raw) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            fail(target.is_none() && digits(raw), "media_target")?;
            target = raw.parse::<u32>().ok().filter(|n| (1..=32).contains(n));
            fail(target.is_some(), "media_target")?;
        } else if let Some(raw) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            fail(sequence.is_none() && digits(raw), "media_sequence")?;
            sequence = raw
                .parse::<u64>()
                .ok()
                .filter(|n| *n <= 9_007_199_254_740_991);
            fail(sequence.is_some(), "media_sequence")?;
        } else if *line == "#EXT-X-KEY:METHOD=NONE" {
            fail(pending.is_none(), "media_clear_key_order")?;
        } else if *line == "#EXT-X-INDEPENDENT-SEGMENTS" {
            fail(!independent && pending.is_none(), "media_independent_order")?;
            independent = true;
        } else if *line == "#EXT-X-DISCONTINUITY" {
            fail(
                !segments.is_empty() && !boundary && pending.is_none(),
                "media_discontinuity_order",
            )?;
            boundary = true;
        } else if let Some(raw) = line.strip_prefix("#EXT-X-MAP:") {
            fail(pending.is_none(), "media_map_order")?;
            let attr = attributes(raw)?;
            fail(
                attr.len() == 1 && attr.contains_key("URI") && uri(attr["URI"]),
                "media_map",
            )?;
            fail(
                map.as_ref().is_none_or(|m| m == attr["URI"]),
                "media_changed_map",
            )?;
            map = Some(attr["URI"].to_owned());
        } else if let Some(raw) = line.strip_prefix("#EXTINF:") {
            fail(pending.is_none(), "media_duration_order")?;
            let raw = raw.strip_suffix(',').unwrap_or("");
            fail(
                raw.split_once('.').map_or_else(
                    || digits(raw),
                    |(w, f)| digits(w) && digits(f) && f.len() <= 6,
                ),
                "media_duration_format",
            )?;
            pending = raw.parse::<f64>().ok().filter(|n| *n > 0.0 && *n <= 32.0);
            fail(pending.is_some(), "media_duration_bound")?;
        } else if !line.starts_with('#') {
            fail(
                uri(line)
                    && pending.is_some()
                    && segments.len() < super::MAX_SEGMENTS
                    && seen.insert(*line),
                "media_segment_reference",
            )?;
            segments.push(Segment {
                uri: (*line).into(),
                duration: pending.take().unwrap(),
                discontinuity: std::mem::take(&mut boundary),
            });
        } else {
            bail!("unsupported_finite_hls:media_tag");
        }
    }
    fail(
        ended && vod && version && target.is_some() && !segments.is_empty(),
        "finite_vod_required",
    )?;
    let seconds = segments.iter().map(|s| s.duration).sum::<f64>();
    fail(
        seconds <= super::MAX_SECONDS
            && segments
                .iter()
                .all(|s| s.duration.round() <= f64::from(target.unwrap())),
        "media_duration_bound",
    )?;
    if let Some(map) = &map {
        fail(!seen.contains(map.as_str()), "media_init_alias")?;
    }
    Ok(MediaPlaylist {
        container: if map.is_some() {
            Container::FragmentedMp4
        } else {
            Container::TransportStream
        },
        map,
        segments,
        seconds,
        sequence: sequence.unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_master_selects_one_muxed_compatible_variant() {
        let m = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS=\"avc1.64001f,mp4a.40.2\"\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=7000000,RESOLUTION=1920x1080,FRAME-RATE=30.000,CODECS=\"avc1.640028,mp4a.40.2\"\n1080.m3u8\n";
        assert_eq!(
            parse_master(m).unwrap().selected().unwrap().uri,
            "1080.m3u8"
        );
        assert!(
            parse_master(&m.replace("FRAME-RATE=30.000", "AUDIO=\"external\",FRAME-RATE=30.000"))
                .is_err()
        );
        assert!(parse_master(&m.replace("mp4a.40.2", "ac-3")).is_err());
        assert!(
            parse_master(&m.replace(
                "720.m3u8\n",
                "#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"key\"\n720.m3u8\n"
            ))
            .is_err()
        );
    }
    #[test]
    fn media_freezes_explicit_boundaries_without_claiming_timestamps() {
        let m = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.000000,\na.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST\n";
        let p = parse_media(m).unwrap();
        assert_eq!(p.container, Container::TransportStream);
        assert!(p.segments[1].discontinuity);
        assert_eq!(p.seconds, 8.0);
        for altered in [
            m.replace("#EXT-X-ENDLIST\n", ""),
            m.replace("b.ts", "a.ts"),
            m.replace(
                "#EXT-X-DISCONTINUITY",
                "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"",
            ),
            m.replace("#EXTINF:4,", "#EXT-X-BYTERANGE:42@0\n#EXTINF:4,"),
        ] {
            assert!(parse_media(&altered).is_err());
        }
    }
}
