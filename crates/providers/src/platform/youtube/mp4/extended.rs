//! Private-compatibility configuration framing, never native-browser claims.
//! AV1 binding: https://aomediacodec.github.io/av1-isobmff/ (av1C)
//! VP9 binding: https://www.webmproject.org/vp9/mp4/ (vpcC)
//! Actual profile/pixels/color/SAR are independently required by the owned
//! Worker's bounded ffprobe before decoding. This is not complete bitstream QA.
use super::*;
fn level_vp9(n: u8) -> bool {
    matches!(
        n,
        10 | 11 | 20 | 21 | 30 | 31 | 40 | 41 | 50 | 51 | 52 | 60 | 61 | 62
    )
}
pub(super) fn valid_av1(value: &str) -> bool {
    let p = value.split('.').collect::<Vec<_>>();
    (p.len() == 4 || p.len() == 10)
        && p[0] == "av01"
        && p[1] == "0"
        && p[2].len() == 3
        && p[2].ends_with('M')
        && p[2][..2].parse::<u8>().is_ok_and(|n| n <= 23)
        && matches!(p[3], "08" | "10")
        && (p.len() == 4
            || (p[4] == "0"
                && matches!(p[5], "110" | "111" | "112")
                && color(
                    p[6].parse().unwrap_or(0),
                    p[7].parse().unwrap_or(0),
                    p[8].parse().unwrap_or(0),
                    p[3] == "10",
                )
                && matches!(p[9], "0" | "1")))
}
pub(super) fn valid_vp9(value: &str) -> bool {
    let p = value.split('.').collect::<Vec<_>>();
    (p.len() == 4 || p.len() == 9)
        && p[0] == "vp09"
        && matches!((p[1], p[3]), ("00", "08") | ("02", "10"))
        && p[2].len() == 2
        && p[2].parse::<u8>().is_ok_and(level_vp9)
        && (p.len() == 4
            || (matches!(p[4], "00" | "01")
                && color(
                    p[5].parse().unwrap_or(0),
                    p[6].parse().unwrap_or(0),
                    p[7].parse().unwrap_or(0),
                    p[3] == "10",
                )
                && matches!(p[8], "00" | "01")))
}
fn color(p: u16, t: u16, m: u16, high: bool) -> bool {
    (p, t, m) == (1, 1, 1) || high && p == 9 && matches!(t, 16 | 18) && matches!(m, 9 | 10)
}
pub(super) fn equivalent(actual: &str, expected: &str) -> bool {
    if actual.eq_ignore_ascii_case(expected) {
        return true;
    }
    let a = actual.split('.').collect::<Vec<_>>();
    let e = expected.split('.').collect::<Vec<_>>();
    a.len() >= 4 && e.len() == 4 && a[..4] == e[..4]
}
pub(super) fn av1_configuration_depth(c: &[u8]) -> Result<u8> {
    if c.len() < 4
        || c.len() > 65536
        || c[0] != 0x81
        || c[1] >> 5 != 0
        || c[1] & 31 > 23
        || c[2] & 0xb0 != 0
        || c[2] & 0x0c != 0x0c
        || c[2] & 3 > 2
        || c[3] != 0
    {
        return Err(ProbeError::Unsupported);
    }
    let depth = if c[2] & 0x40 != 0 { 10 } else { 8 };
    if c.len() > 4 {
        // At most one bounded sequence-header OBU; no extension, metadata,
        // extra operating-point payload or hidden trailing configuration.
        let obu = c[4];
        if obu != 0x0a {
            return Err(ProbeError::Unsupported);
        }
        let mut at = 5;
        let mut size = 0usize;
        let mut shift = 0;
        loop {
            let b = *c.get(at).ok_or(ProbeError::Unsupported)?;
            at += 1;
            if shift >= 28 {
                return Err(ProbeError::Unsupported);
            }
            size |= ((b & 127) as usize) << shift;
            shift += 7;
            if b & 128 == 0 {
                break;
            }
        }
        if size == 0 || at.checked_add(size) != Some(c.len()) || c[at] >> 5 != 0 {
            return Err(ProbeError::Unsupported);
        }
    }
    Ok(depth)
}
pub(super) fn parse(parser: &mut Parser, bytes: &[u8], kind: [u8; 4]) -> Result<Codec> {
    let fixed = bytes.get(..78).ok_or(ProbeError::Unsupported)?;
    zero(&fixed[8..24])?;
    let width = u16_at(bytes, 24)? as u32;
    let height = u16_at(bytes, 26)? as u32;
    if !(1..=8192).contains(&width)
        || !(1..=4320).contains(&height)
        || u32_at(bytes, 28)? != 0x00480000
        || u32_at(bytes, 32)? != 0x00480000
        || u32_at(bytes, 36)? != 0
        || u16_at(bytes, 40)? != 1
        || bytes[42] > 31
        || u16_at(bytes, 74)? != 24
        || u16_at(bytes, 76)? != 0xffff
    {
        return Err(ProbeError::Unsupported);
    }
    let boxes = parser.children(&bytes[78..], 7)?;
    let config_kind = if kind == *b"av01" {
        *b"av1C"
    } else if kind == *b"vp09" {
        *b"vpcC"
    } else {
        return Err(ProbeError::Unsupported);
    };
    // No sinf/dvcc/dvvc/auxiliary/layered/unrecognized boxes, including encrypted
    // sample entries whose uncompressed headers could still look decodable.
    allowed(&boxes, &[config_kind, *b"pasp", *b"colr", *b"btrt"])?;
    for item in &boxes {
        if item.kind == *b"pasp" {
            exact(item.payload, 8)?;
            if u32_at(item.payload, 0)? != 1 || u32_at(item.payload, 4)? != 1 {
                return Err(ProbeError::Unsupported);
            }
        } else if item.kind == *b"btrt" {
            exact(item.payload, 12)?;
        }
    }
    let c = unique(&boxes, &config_kind)?.payload;
    let (profile, level, depth, chroma, range, p, t, m) = if kind == *b"vp09" {
        exact(c, 12)?;
        full(c, 1, 0)?;
        let profile = c[4];
        let level = c[5];
        let depth = c[6] >> 4;
        let chroma = (c[6] >> 1) & 7;
        let range = c[6] & 1;
        if !matches!((profile, depth), (0, 8) | (2, 10))
            || !level_vp9(level)
            || chroma > 1
            || u16_at(c, 10)? != 0
            || !color(c[7].into(), c[8].into(), c[9].into(), depth == 10)
        {
            return Err(ProbeError::Unsupported);
        }
        (
            profile,
            level,
            depth,
            chroma,
            range,
            c[7] as u16,
            c[8] as u16,
            c[9] as u16,
        )
    } else {
        let depth = av1_configuration_depth(c)?;
        let colr = unique(&boxes, b"colr")?.payload;
        exact(colr, 11)?;
        if &colr[..4] != b"nclx" || colr[10] & 127 != 0 {
            return Err(ProbeError::Unsupported);
        }
        let (p, t, m) = (u16_at(colr, 4)?, u16_at(colr, 6)?, u16_at(colr, 8)?);
        if !color(p, t, m, depth == 10) {
            return Err(ProbeError::Unsupported);
        }
        (0, c[1] & 31, depth, c[2] & 3, colr[10] >> 7, p, t, m)
    };
    if let Some(colr) = boxes.iter().find(|b| b.kind == *b"colr") {
        exact(colr.payload, 11)?;
        if &colr.payload[..4] != b"nclx"
            || u16_at(colr.payload, 4)? != p
            || u16_at(colr.payload, 6)? != t
            || u16_at(colr.payload, 8)? != m
            || colr.payload[10] != range << 7
        {
            return Err(ProbeError::Unsupported);
        }
    }
    if kind == *b"vp09" {
        Ok(Codec::Vp9 {
            rfc6381: format!(
                "vp09.{profile:02}.{level:02}.{depth:02}.{chroma:02}.{p:02}.{t:02}.{m:02}.{range:02}"
            ),
            width,
            height,
        })
    } else {
        Ok(Codec::Av1 {
            rfc6381: format!(
                "av01.0.{level:02}M.{depth:02}.0.11{chroma}.{p:02}.{t:02}.{m:02}.{range}"
            ),
            width,
            height,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codec_strings_remain_closed() {
        for c in ["av01.0.05M.08", "av01.0.08M.10.0.110.09.16.09.0"] {
            assert!(valid_av1(c));
        }
        for c in ["vp09.00.41.08", "vp09.02.51.10.01.09.16.09.00"] {
            assert!(valid_vp9(c));
        }
        for c in [
            "av01.1.05M.08",
            "av01.0.24M.10",
            "av01.0.08H.10",
            "av01.0.08M.12",
        ] {
            assert!(!valid_av1(c));
        }
        for c in ["vp09.01.41.08", "vp09.02.51.12", "vp09.00.00.08"] {
            assert!(!valid_vp9(c));
        }
    }
}
