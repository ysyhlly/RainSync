//! Bounded metadata discovery for clear single-track finite WebM inputs.
//! Only private Worker compatibility uses this parser. It does not render DASH,
//! validate complete clusters/cues, or establish successful elementary decoding.
//! Exact ranges share the original deadline, strong validator and 2MiB budget.
//! https://www.webmproject.org/docs/container/
use super::mp4::{
    self, ByteRange, ProbeError, RangeIdentity, RangeReader, RangeRequest, TrackKind,
};
use media_core::advanced_media::WebmSourceExpectation;
use tokio::time::{Instant, timeout_at};
type Result<T> = mp4::Result<T>;

#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub duration_seconds: f64,
    pub metadata_end: u64,
    pub total_bytes: u64,
    pub strong_etag: String,
    pub codec: Codec,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Codec {
    Video(WebmSourceExpectation),
    Opus {
        sample_rate: u32,
        channels: u16,
        pre_skip: u16,
    },
}
#[derive(Clone, Copy)]
struct Element {
    id: u32,
    start: usize,
    data: usize,
    end: usize,
    unknown: bool,
}
fn bad() -> ProbeError {
    ProbeError::Unsupported
}
fn vint(bytes: &[u8], at: usize, id: bool) -> Result<Option<(u64, usize, bool)>> {
    let Some(first) = bytes.get(at).copied() else {
        return Ok(None);
    };
    if first == 0 {
        return Err(bad());
    }
    let n = first.leading_zeros() as usize + 1;
    if n > if id { 4 } else { 8 } {
        return Err(bad());
    }
    let Some(data) = bytes.get(at..at + n) else {
        return Ok(None);
    };
    let mut v = u64::from(if id {
        first
    } else {
        first & ((0xffu64 >> n) as u8)
    });
    for b in &data[1..] {
        v = (v << 8) | u64::from(*b);
    }
    Ok(Some((v, n, !id && v == (1u64 << (7 * n)) - 1)))
}
fn element(bytes: &[u8], at: usize, total: usize) -> Result<Option<Element>> {
    let Some((id, a, _)) = vint(bytes, at, true)? else {
        return Ok(None);
    };
    let Some((size, b, unknown)) = vint(bytes, at + a, false)? else {
        return Ok(None);
    };
    let data = at.checked_add(a + b).ok_or_else(bad)?;
    let end = if unknown {
        total
    } else {
        data.checked_add(usize::try_from(size).map_err(|_| bad())?)
            .ok_or_else(bad)?
    };
    if end > total || data > end {
        return Err(bad());
    }
    Ok(Some(Element {
        id: id as u32,
        start: at,
        data,
        end,
        unknown,
    }))
}
fn children(bytes: &[u8], e: Element) -> Result<Vec<Element>> {
    if e.unknown || e.end > bytes.len() {
        return Err(bad());
    }
    let mut at = e.data;
    let mut result = Vec::new();
    while at < e.end {
        if result.len() >= 128 {
            return Err(ProbeError::TooLarge);
        }
        let child = element(bytes, at, e.end)?.ok_or_else(bad)?;
        if child.unknown || child.end > bytes.len() {
            return Err(bad());
        }
        at = child.end;
        result.push(child);
    }
    Ok(result)
}
fn uint(bytes: &[u8], e: Element) -> Result<u64> {
    let data = &bytes[e.data..e.end];
    if data.is_empty() || data.len() > 8 {
        return Err(bad());
    }
    Ok(data.iter().fold(0, |v, b| (v << 8) | u64::from(*b)))
}
fn float(bytes: &[u8], e: Element) -> Result<f64> {
    let value = match &bytes[e.data..e.end] {
        b if b.len() == 4 => f64::from(f32::from_be_bytes(b.try_into().unwrap())),
        b if b.len() == 8 => f64::from_be_bytes(b.try_into().unwrap()),
        _ => return Err(bad()),
    };
    if !value.is_finite() || value <= 0.0 {
        return Err(bad());
    }
    Ok(value)
}
fn unique(rows: &[Element]) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    if rows.iter().any(|e| e.id != 0xec && !seen.insert(e.id)) {
        return Err(bad());
    }
    Ok(())
}
fn ebml(bytes: &[u8], e: Element) -> Result<()> {
    let rows = children(bytes, e)?;
    unique(&rows)?;
    let mut doc = false;
    for r in rows {
        match r.id {
            0x4282 => {
                if &bytes[r.data..r.end] != b"webm" {
                    return Err(bad());
                }
                doc = true;
            }
            0x4286 | 0x42f7 => {
                if uint(bytes, r)? != 1 {
                    return Err(bad());
                }
            }
            0x42f2 => {
                if uint(bytes, r)? != 4 {
                    return Err(bad());
                }
            }
            0x42f3 => {
                if uint(bytes, r)? != 8 {
                    return Err(bad());
                }
            }
            0x4287 | 0x4285 => {
                if !(1..=4).contains(&uint(bytes, r)?) {
                    return Err(bad());
                }
            }
            0xec => {}
            _ => return Err(bad()),
        }
    }
    if !doc {
        return Err(bad());
    }
    Ok(())
}
fn info(bytes: &[u8], e: Element) -> Result<f64> {
    let rows = children(bytes, e)?;
    unique(&rows)?;
    let mut scale = 1_000_000u64;
    let mut duration = None;
    for r in rows {
        match r.id {
            0x2ad7b1 => {
                scale = uint(bytes, r)?;
                if !(1..=1_000_000_000).contains(&scale) {
                    return Err(bad());
                }
            }
            0x4489 => duration = Some(float(bytes, r)?),
            // Inert bounded descriptive values. Linked segments and translated
            // codecs are absent from this grammar, never followed by the decoder.
            0x4d80 | 0x5741 | 0x7ba9 => {
                if r.end - r.data > 512 {
                    return Err(bad());
                }
            }
            0x4461 => {
                if r.end - r.data != 8 {
                    return Err(bad());
                }
            }
            0xec => {}
            _ => return Err(bad()),
        }
    }
    let seconds = duration.ok_or_else(bad)? * scale as f64 / 1_000_000_000.0;
    if !(0.001..=21_600.0).contains(&seconds) {
        return Err(bad());
    }
    Ok(seconds)
}
fn colour(bytes: &[u8], e: Element, expected: &mut WebmSourceExpectation) -> Result<()> {
    let rows = children(bytes, e)?;
    unique(&rows)?;
    for r in rows {
        let n = uint(bytes, r)?;
        let n = u8::try_from(n).map_err(|_| bad())?;
        match r.id {
            0x55b1 => expected.color_space = Some(n),
            0x55b2 => expected.bit_depth = Some(n),
            0x55b9 => expected.color_range = Some(n),
            0x55ba => expected.color_transfer = Some(n),
            0x55bb => expected.color_primaries = Some(n),
            // Chroma subsampling and siting may be omitted. Reported non-4:2:0
            // geometry fails here; actual pixel format is checked independently.
            0x55b3 | 0x55b4 => {
                if n != 1 {
                    return Err(bad());
                }
            }
            0x55b7 | 0x55b8 => {
                if !matches!(n, 0..=2) {
                    return Err(bad());
                }
            }
            0xec => {}
            _ => return Err(bad()),
        }
    }
    Ok(())
}
fn video(bytes: &[u8], e: Element, expected: &mut WebmSourceExpectation) -> Result<()> {
    let rows = children(bytes, e)?;
    unique(&rows)?;
    let mut dw = None;
    let mut dh = None;
    for r in rows {
        match r.id {
            0xb0 => expected.width = u32::try_from(uint(bytes, r)?).map_err(|_| bad())?,
            0xba => expected.height = u32::try_from(uint(bytes, r)?).map_err(|_| bad())?,
            0x54b0 => dw = Some(uint(bytes, r)?),
            0x54ba => dh = Some(uint(bytes, r)?),
            0x54b2 | 0x53b8 | 0x54aa | 0x54bb | 0x54cc | 0x54dd => {
                if uint(bytes, r)? != 0 {
                    return Err(bad());
                }
            }
            0x9a => {
                if !matches!(uint(bytes, r)?, 0 | 2) {
                    return Err(bad());
                }
            }
            0x55b0 => colour(bytes, r, expected)?,
            0xec => {}
            _ => return Err(bad()),
        }
    }
    if dw.is_some_and(|n| n != u64::from(expected.width))
        || dh.is_some_and(|n| n != u64::from(expected.height))
    {
        return Err(bad());
    }
    Ok(())
}
fn vp9_private(bytes: &[u8], expected: &mut WebmSourceExpectation) -> Result<()> {
    let mut at = 0;
    let mut seen = std::collections::HashSet::new();
    while at < bytes.len() {
        let pair = bytes.get(at..at + 2).ok_or_else(bad)?;
        let (id, n) = (pair[0], usize::from(pair[1]));
        at += 2;
        let data = bytes.get(at..at + n).ok_or_else(bad)?;
        at += n;
        if !seen.insert(id) || n != 1 {
            return Err(bad());
        }
        match id {
            1 => expected.profile = Some(data[0]),
            2 => {
                if !matches!(
                    data[0],
                    10 | 11 | 20 | 21 | 30 | 31 | 40 | 41 | 50 | 51 | 52 | 60 | 61 | 62
                ) {
                    return Err(bad());
                }
            }
            3 => {
                if expected.bit_depth.is_some_and(|d| d != data[0]) {
                    return Err(bad());
                }
                expected.bit_depth = Some(data[0]);
            }
            4 => {
                if !matches!(data[0], 0 | 1) {
                    return Err(bad());
                }
            }
            _ => return Err(bad()),
        }
    }
    Ok(())
}
fn track(bytes: &[u8], e: Element, kind: TrackKind) -> Result<Codec> {
    let rows = children(bytes, e)?;
    unique(&rows)?;
    let (mut number, mut ty, mut codec, mut private, mut picture, mut audio) =
        (None, None, None, None, None, None);
    let (mut delay, mut preroll) = (None, None);
    for r in rows {
        match r.id {
            0xd7 => number = Some(uint(bytes, r)?),
            0x73c5 => {
                uint(bytes, r)?;
            }
            0x83 => ty = Some(uint(bytes, r)?),
            0x86 => codec = Some(&bytes[r.data..r.end]),
            0x63a2 => {
                if r.end - r.data > 65536 {
                    return Err(ProbeError::TooLarge);
                }
                private = Some(&bytes[r.data..r.end]);
            }
            0xe0 => picture = Some(r),
            0xe1 => audio = Some(r),
            0x56aa => delay = Some(uint(bytes, r)?),
            0x56bb => preroll = Some(uint(bytes, r)?),
            0xb9 => {
                if uint(bytes, r)? != 1 {
                    return Err(bad());
                }
            }
            0x88 | 0x55aa | 0x9c => {
                if uint(bytes, r)? > 1 {
                    return Err(bad());
                }
            }
            0x23e383 => {
                if !(8_333_333..=1_000_000_000).contains(&uint(bytes, r)?) {
                    return Err(bad());
                }
            }
            0x22b59c | 0x536e => {
                if r.end - r.data > 128 {
                    return Err(bad());
                }
            }
            0xec => {}
            _ => return Err(bad()),
        }
    }
    if number.is_none_or(|n| !(1..=127).contains(&n)) {
        return Err(bad());
    }
    match kind {
        TrackKind::Video => {
            if ty != Some(1) || audio.is_some() || delay.is_some() || preroll.is_some() {
                return Err(bad());
            }
            let codec = match codec {
                Some(b"V_VP9") => "vp9",
                Some(b"V_AV1") => "av1",
                _ => return Err(bad()),
            };
            let mut e = WebmSourceExpectation {
                schema_version: 1,
                codec: codec.into(),
                width: 0,
                height: 0,
                profile: None,
                bit_depth: None,
                color_primaries: None,
                color_transfer: None,
                color_space: None,
                color_range: None,
            };
            video(bytes, picture.ok_or_else(bad)?, &mut e)?;
            if codec == "vp9" {
                if let Some(p) = private {
                    vp9_private(p, &mut e)?;
                }
            } else {
                // Matroska AV1CodecConfigurationRecord framing; the decoder
                // remains responsible for sequence-header and frame validation.
                let p = private.ok_or_else(bad)?;
                e.profile = Some(0);
                let depth = mp4::av1_configuration_depth(p)?;
                if e.bit_depth.is_some_and(|d| d != depth) {
                    return Err(bad());
                }
                e.bit_depth = Some(depth);
            }
            e.validate().map_err(|_| bad())?;
            Ok(Codec::Video(e))
        }
        TrackKind::Audio => {
            if ty != Some(2) || codec != Some(&b"A_OPUS"[..]) || picture.is_some() {
                return Err(bad());
            }
            let p = private.ok_or_else(bad)?;
            if p.len() != 19
                || &p[..8] != b"OpusHead"
                || p[8] != 1
                || !matches!(p[9], 1 | 2)
                || p[18] != 0
                || p[16..18] != [0, 0]
            {
                return Err(bad());
            }
            let skip = u16::from_le_bytes(p[10..12].try_into().unwrap());
            if skip > 3840
                || preroll.is_some_and(|n| n > 120_000_000)
                || delay.is_some_and(|n| n.abs_diff(u64::from(skip) * 1_000_000_000 / 48000) > 1)
            {
                return Err(bad());
            }
            let rows = children(bytes, audio.ok_or_else(bad)?)?;
            unique(&rows)?;
            let mut rate = 8000.0;
            let mut channels = 1u64;
            for r in rows {
                match r.id {
                    0xb5 => rate = float(bytes, r)?,
                    0x9f => channels = uint(bytes, r)?,
                    0x6264 => {
                        if !matches!(uint(bytes, r)?, 16 | 24 | 32) {
                            return Err(bad());
                        }
                    }
                    0xec => {}
                    _ => return Err(bad()),
                }
            }
            if rate != 48000.0 || channels != u64::from(p[9]) {
                return Err(bad());
            }
            Ok(Codec::Opus {
                sample_rate: 48000,
                channels: p[9].into(),
                pre_skip: skip,
            })
        }
    }
}
fn tags(bytes: &[u8], root: Element) -> Result<()> {
    fn walk(bytes: &[u8], e: Element, depth: u8) -> Result<()> {
        if depth > 4 || e.end - e.data > 65536 {
            return Err(bad());
        }
        for row in children(bytes, e)? {
            match row.id {
                0x7373 | 0x63c0 | 0x67c8 => walk(bytes, row, depth + 1)?,
                0x45a3 | 0x4487 | 0x447a | 0x63ca => {
                    if row.end - row.data > 16384
                        || std::str::from_utf8(&bytes[row.data..row.end]).is_err()
                    {
                        return Err(bad());
                    }
                }
                0x68ca | 0x63c5 | 0x63c9 | 0x63c4 | 0x63c6 => {
                    uint(bytes, row)?;
                }
                0xec => {}
                _ => return Err(bad()),
            }
        }
        Ok(())
    }
    walk(bytes, root, 0)
}
/// Freeze the extractor's declared profile/depth as an expectation, while
/// refusing any disagreement with actual optional container configuration.
/// This does not relabel the hint as an observed decoder fact.
pub fn bind_codec_hint(expected: &mut WebmSourceExpectation, hint: &str) -> Result<()> {
    let (codec, profile, depth) = match hint {
        "vp9" => ("vp9", 0, 8),
        "vp9.2" => ("vp9", 2, 10),
        "av1" => ("av1", 0, expected.bit_depth.ok_or_else(bad)?),
        _ => {
            if !super::valid_webm_video_hint(hint) {
                return Err(bad());
            }
            let fields = hint.split('.').collect::<Vec<_>>();
            let codec = if fields[0] == "vp09" { "vp9" } else { "av1" };
            let profile = fields[1].parse::<u8>().map_err(|_| bad())?;
            let depth = fields[3].parse::<u8>().map_err(|_| bad())?;
            (codec, profile, depth)
        }
    };
    if expected.codec != codec
        || expected.profile.is_some_and(|p| p != profile)
        || expected.bit_depth.is_some_and(|d| d != depth)
    {
        return Err(bad());
    }
    expected.profile = Some(profile);
    expected.bit_depth = Some(depth);
    expected.validate().map_err(|_| bad())
}
fn parse(bytes: &[u8], total: u64, kind: TrackKind) -> Result<Option<Probe>> {
    let total = usize::try_from(total).map_err(|_| bad())?;
    let Some(header) = element(bytes, 0, total)? else {
        return Ok(None);
    };
    if header.id != 0x1a45dfa3 || header.unknown || header.end > 4096 {
        return Err(bad());
    }
    if header.end > bytes.len() {
        return Ok(None);
    }
    ebml(bytes, header)?;
    let Some(segment) = element(bytes, header.end, total)? else {
        return Ok(None);
    };
    if segment.id != 0x18538067 || segment.end != total {
        return Err(bad());
    }
    let mut at = segment.data;
    let (mut duration, mut selected) = (None, None);
    let mut count = 0;
    while at < segment.end {
        count += 1;
        if count > 128 {
            return Err(ProbeError::TooLarge);
        }
        let Some(e) = element(bytes, at, segment.end)? else {
            return Ok(None);
        };
        if e.id == 0x1f43b675 {
            if duration.is_none() || selected.is_none() || e.data >= segment.end {
                return Err(bad());
            }
            return Ok(Some(Probe {
                duration_seconds: duration.unwrap(),
                metadata_end: e.start as u64,
                total_bytes: total as u64,
                strong_etag: String::new(),
                codec: selected.unwrap(),
            }));
        }
        if e.unknown {
            return Err(bad());
        }
        if e.end > bytes.len() {
            return Ok(None);
        }
        match e.id {
            0x1549a966 => {
                if duration.is_some() {
                    return Err(bad());
                }
                duration = Some(info(bytes, e)?);
            }
            0x1654ae6b => {
                if selected.is_some() {
                    return Err(bad());
                }
                let tracks = children(bytes, e)?;
                if !matches!(tracks.as_slice(),[t] if t.id==0xae) {
                    return Err(bad());
                }
                selected = Some(track(bytes, tracks[0], kind)?);
            }
            // SeekHead and Cues describe offsets only; they are never fetched
            // separately. The Worker range gateway bounds every eventual seek.
            0x114d9b74 | 0x1c53bb6b | 0xec => {}
            0x1254c367 => tags(bytes, e)?,
            _ => return Err(bad()),
        }
        at = e.end;
    }
    Err(bad())
}
pub async fn probe(reader: &dyn RangeReader, kind: TrackKind, deadline: Instant) -> Result<Probe> {
    let mut spent = 0usize;
    let mut expected: Option<RangeIdentity> = None;
    for maximum in [4096, 65536, mp4::MAX_PROBE_BYTES - 4096 - 65536] {
        if Instant::now() >= deadline {
            return Err(ProbeError::Deadline);
        }
        let count = expected
            .as_ref()
            .map_or(maximum, |e| maximum.min(e.total_bytes as usize));
        let request = RangeRequest {
            range: ByteRange {
                start: 0,
                end: count as u64 - 1,
            },
            deadline,
            max_body_bytes: count,
            expected: expected.clone(),
        };
        let response = timeout_at(deadline, reader.read(request.clone()))
            .await
            .map_err(|_| ProbeError::Deadline)??;
        let identity = mp4::validate_range_headers(&request, response.status, &response.headers)?;
        if response.body.len() != count {
            return Err(ProbeError::InvalidResponse);
        }
        let etag = identity
            .etag
            .as_ref()
            .filter(|e| e.starts_with('"'))
            .ok_or(ProbeError::Unsupported)?
            .clone();
        spent += response.body.len();
        if spent > mp4::MAX_PROBE_BYTES {
            return Err(ProbeError::TooLarge);
        }
        if let Some(mut probe) = parse(&response.body, identity.total_bytes, kind)? {
            if Instant::now() >= deadline {
                return Err(ProbeError::Deadline);
            }
            probe.strong_etag = etag;
            return Ok(probe);
        }
        expected = Some(identity);
    }
    Err(ProbeError::TooLarge)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn e(id: u32, data: &[u8]) -> Vec<u8> {
        let bytes = id.to_be_bytes();
        let first = bytes.iter().position(|b| *b != 0).unwrap();
        let mut v = bytes[first..].to_vec();
        if data.len() < 127 {
            v.push(0x80 | data.len() as u8);
        } else {
            v.extend_from_slice(&(0x4000 | data.len() as u16).to_be_bytes());
        }
        v.extend(data);
        v
    }
    fn fixture() -> Vec<u8> {
        let header = e(0x1a45dfa3, &e(0x4282, b"webm"));
        let info = e(0x1549a966, &e(0x4489, &1000.0f64.to_be_bytes()));
        let video = e(0xe0, &[e(0xb0, &[64]), e(0xba, &[64])].concat());
        let track = e(
            0xae,
            &[e(0xd7, &[1]), e(0x83, &[1]), e(0x86, b"V_VP9"), video].concat(),
        );
        let body = [info, e(0x1654ae6b, &track), e(0x1f43b675, &[0u8; 10])].concat();
        [header, e(0x18538067, &body)].concat()
    }
    #[test]
    fn finite_single_track_header_is_metadata_only_and_protection_fails_closed() {
        let bytes = fixture();
        let p = parse(&bytes, bytes.len() as u64, TrackKind::Video)
            .unwrap()
            .unwrap();
        assert_eq!(p.duration_seconds, 1.0);
        let Codec::Video(v) = p.codec else { panic!() };
        assert_eq!(v.width, 64);
        assert!(v.profile.is_none());
        for bad_id in [0x6d80u32, 0x6624, 0x3cb923] {
            let mut bad = bytes.clone();
            let target = bad.windows(2).position(|b| b == [0xe0, 0x86]).unwrap();
            bad[target..target + 2].copy_from_slice(&(bad_id as u16).to_be_bytes());
            assert!(parse(&bad, bad.len() as u64, TrackKind::Video).is_err());
        }
        assert!(parse(&bytes, bytes.len() as u64 + 1, TrackKind::Video).is_err());
        assert!(parse(&bytes, bytes.len() as u64, TrackKind::Audio).is_err());
    }
    struct Reader {
        bytes: Vec<u8>,
        etag: &'static str,
        changed: bool,
        calls: std::sync::atomic::AtomicUsize,
    }
    impl RangeReader for Reader {
        fn read<'a>(
            &'a self,
            request: RangeRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<mp4::RangeResponse>> + Send + 'a>,
        > {
            Box::pin(async move {
                let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let start = request.range.start as usize;
                let end = request.range.end as usize;
                Ok(mp4::RangeResponse {
                    status: 206,
                    headers: mp4::RangeHeaders {
                        content_range: vec![format!("bytes {start}-{end}/{}", self.bytes.len())],
                        content_length: vec![(end - start + 1).to_string()],
                        etag: vec![
                            if self.changed && call > 0 {
                                "\"changed\""
                            } else {
                                self.etag
                            }
                            .into(),
                        ],
                        ..Default::default()
                    },
                    body: self.bytes[start..=end].to_vec(),
                })
            })
        }
    }
    fn ranged_fixture() -> Vec<u8> {
        let bytes = fixture();
        let header = element(&bytes, 0, bytes.len()).unwrap().unwrap();
        let segment = element(&bytes, header.end, bytes.len()).unwrap().unwrap();
        // A bounded Void before metadata needs a second prefix; complete media
        // bytes remain outside the metadata result and no full-body retry exists.
        let body = [
            e(0xec, &vec![0; 10000]),
            bytes[segment.data..segment.end].to_vec(),
        ]
        .concat();
        [bytes[..header.end].to_vec(), e(0x18538067, &body)].concat()
    }
    #[tokio::test]
    async fn exact_ranges_require_original_identity_and_share_the_deadline() {
        for (etag, changed, accepted) in [
            ("\"same\"", false, true),
            ("W/\"weak\"", false, false),
            ("\"same\"", true, false),
        ] {
            let reader = Reader {
                bytes: ranged_fixture(),
                etag,
                changed,
                calls: Default::default(),
            };
            let result = probe(
                &reader,
                TrackKind::Video,
                Instant::now() + std::time::Duration::from_secs(1),
            )
            .await;
            assert_eq!(result.is_ok(), accepted);
            assert!(reader.calls.load(std::sync::atomic::Ordering::SeqCst) <= 2);
        }
        let reader = Reader {
            bytes: ranged_fixture(),
            etag: "\"same\"",
            changed: false,
            calls: Default::default(),
        };
        assert_eq!(
            probe(&reader, TrackKind::Video, Instant::now()).await,
            Err(ProbeError::Deadline)
        );
        assert_eq!(reader.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
    #[test]
    fn declared_profile_is_an_expectation_and_rejects_byte_configuration_conflicts() {
        let bytes = fixture();
        let p = parse(&bytes, bytes.len() as u64, TrackKind::Video)
            .unwrap()
            .unwrap();
        let Codec::Video(mut e) = p.codec else {
            panic!()
        };
        bind_codec_hint(&mut e, "vp9.2").unwrap();
        assert_eq!((e.profile, e.bit_depth), (Some(2), Some(10)));
        assert!(bind_codec_hint(&mut e, "vp9").is_err());
        assert!(bind_codec_hint(&mut e, "vp09.03.40.12").is_err());
    }
    #[tokio::test]
    #[ignore = "requires an explicitly supplied owned generated media fixture"]
    async fn owned_generated_webm_header_qualifies_without_platform_access() {
        let path =
            std::env::var("RAINSYNC_OWNED_WEBM_FIXTURE").expect("owned fixture path required");
        let file = std::fs::File::open(&path).unwrap();
        let total = file.metadata().unwrap().len();
        assert!(total <= mp4::MAX_PROBE_BYTES as u64);
        use std::io::Read;
        let mut bytes = Vec::new();
        file.take(mp4::MAX_PROBE_BYTES as u64)
            .read_to_end(&mut bytes)
            .unwrap();
        let result = parse(&bytes, total, TrackKind::Video).unwrap().unwrap();
        let Codec::Video(expected) = result.codec else {
            panic!()
        };
        let codec = std::env::var("RAINSYNC_OWNED_WEBM_CODEC").unwrap_or_else(|_| "vp9".into());
        assert!(matches!(codec.as_str(), "vp9" | "av1"));
        assert_eq!(expected.codec, codec);
        assert_eq!((expected.width, expected.height), (128, 96));
        assert!((result.duration_seconds - 2.0).abs() < 0.01);
        let mut command = tokio::process::Command::new("ffprobe");
        media_core::input_policy::clean_environment(&mut command);
        command
            .args([
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                "matroska",
                "-f",
                "matroska",
                "-show_streams",
                "-of",
                "json",
                "-i",
            ])
            .arg(&path);
        let scope = media_core::child_process::Scope::new();
        let (status, bytes) = scope
            .run(media_core::child_process::capture(
                command,
                std::time::Duration::from_secs(20),
                1024 * 1024,
            ))
            .await
            .unwrap();
        scope.shutdown().await.unwrap();
        assert!(status.success());
        let actual: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let proof = expected.verify_probe(&actual["streams"][0]);
        if codec == "av1" {
            assert!(proof.is_ok());
        } else {
            // This real generated VP9 fixture lacks two ffprobe color facts.
            // A successful container read/decode cannot fill them in for us.
            assert!(proof.is_err());
            assert!(actual["streams"][0].get("color_transfer").is_none());
            assert!(actual["streams"][0].get("color_primaries").is_none());
        }
    }
    #[test]
    fn eight_byte_ebml_sizes_have_a_wide_mask_and_checked_unknown_value() {
        assert_eq!(
            vint(&[1, 0, 0, 0, 0, 0, 0, 67], 0, false).unwrap(),
            Some((67, 8, false))
        );
        assert_eq!(
            vint(&[1, 255, 255, 255, 255, 255, 255, 255], 0, false).unwrap(),
            Some(((1u64 << 56) - 1, 8, true))
        );
    }
    #[test]
    fn truncated_header_and_unknown_child_cannot_claim_a_probe() {
        let bytes = fixture();
        assert!(
            parse(&bytes[..20], bytes.len() as u64, TrackKind::Video)
                .unwrap()
                .is_none()
        );
        assert!(vint(&[0], 0, false).is_err());
        let unknown = e(0xae, &[0x6d, 0x80, 0x80]);
        assert!(
            track(
                &unknown,
                element(&unknown, 0, unknown.len()).unwrap().unwrap(),
                TrackKind::Video
            )
            .is_err()
        );
    }
}
