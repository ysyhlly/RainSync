//! Explicit compatibility-only HEVC Main/Main10 configuration subset.
//! Independent configuration framing based on ISO/IEC 14496-15's hvcC layout:
//! https://ffmpeg.org/doxygen/trunk/hevc_8c_source.html
//! RFC6381 HEVC signaling: ETSI TS 126 244 V13.3.0, Annex A.2.2.
//! This checks complete configuration arrays and parameter-set identity/profile/
//! geometry prefixes, not full HEVC syntax or sample decoding. The owned Worker
//! must still qualify its decoded output. Only single-layer/single-temporal-layer
//! Main or Main10, Main Tier, progressive 8/10-bit 4:2:0 with one VPS/SPS/PPS is admitted.
use super::*;

pub(super) fn valid_codec_string(value: &str) -> bool {
    let mut parts = value.split('.');
    let prefix = parts.next();
    let profile = parts.next();
    let compatibility = parts.next();
    let level = parts.next();
    let constraint = parts.next();
    matches!(prefix, Some("hvc1" | "hev1"))
        && matches!(
            (profile, compatibility),
            (Some("1"), Some("2" | "6")) | (Some("2"), Some("4" | "6"))
        )
        && level.is_some_and(|v| {
            v.strip_prefix('L').is_some_and(|level| {
                level
                    .parse::<u8>()
                    .is_ok_and(|n| valid_level(n) && level == n.to_string())
            })
        })
        && constraint.is_some_and(|v| v.eq_ignore_ascii_case("90") || v.eq_ignore_ascii_case("b0"))
        && parts.next().is_none()
}
fn valid_level(level: u8) -> bool {
    matches!(
        level,
        30 | 60 | 63 | 90 | 93 | 120 | 123 | 150 | 153 | 156 | 180 | 183 | 186
    )
}

pub(super) fn parse_hevc(parser: &mut Parser, bytes: &[u8], entry_kind: [u8; 4]) -> Result<Codec> {
    let fixed = bytes.get(..78).ok_or(ProbeError::Unsupported)?;
    zero(&fixed[8..24])?;
    let width = u16_at(bytes, 24)? as u32;
    let height = u16_at(bytes, 26)? as u32;
    if !(1..=8192).contains(&width)
        || !(1..=4320).contains(&height)
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
    // Encryption, Dolby Vision, layered extensions and arbitrary metadata are
    // never treated as an ordinary clear HEVC configuration.
    allowed(&boxes, &[*b"hvcC", *b"btrt", *b"pasp", *b"colr"])?;
    for item in &boxes {
        match &item.kind {
            b"btrt" => exact(item.payload, 12)?,
            b"pasp" => {
                exact(item.payload, 8)?;
                if u32_at(item.payload, 0)? != 1 || u32_at(item.payload, 4)? != 1 {
                    return Err(ProbeError::Unsupported);
                }
            }
            b"colr" => {
                exact(item.payload, 11)?;
                if &item.payload[..4] != b"nclx"
                    || !matches!(
                        (
                            u16_at(item.payload, 4)?,
                            u16_at(item.payload, 6)?,
                            u16_at(item.payload, 8)?
                        ),
                        (1, 1, 1) | (9, 16, 9) | (9, 16, 10) | (9, 18, 9) | (9, 18, 10)
                    )
                    || item.payload[10] != 0
                {
                    return Err(ProbeError::Unsupported);
                }
            }
            _ => {}
        }
    }
    let config = unique(&boxes, b"hvcC")?.payload;
    if config.len() < 23
        || config[0] != 1
        || !matches!(config[1],1|2) // closed Main/Main10, profile_space=0, main tier
        || !(if config[1]==1 {matches!(u32_at(config,2)?.reverse_bits(),2|6)} else {matches!(u32_at(config,2)?.reverse_bits(),4|6)})
        || !matches!(config[6], 0x90 | 0xb0)
        || config[7..12].iter().any(|&b| b != 0)
        || !valid_level(config[12])
        || u16_at(config, 13)? & 0xf000 != 0xf000
        || config[15] & 0xfc != 0xfc
        || config[16] != 0xfd // 4:2:0
        || config[17] != if config[1]==1 {0xf8} else {0xfa}
        || config[18] != config[17]
        || config[21] & 0x3f != 0x0f // one nested temporal layer, four-byte NAL length
        || config[22] != 3
    {
        return Err(ProbeError::Unsupported);
    }
    let mut at = 23;
    let mut nals: [Option<Vec<u8>>; 3] = [None, None, None];
    for _ in 0..3 {
        let header = *config.get(at).ok_or(ProbeError::Unsupported)?;
        at += 1;
        let kind = header & 0x3f;
        if header & 0xc0 != 0x80 || !matches!(kind, 32..=34) || u16_at(config, at)? != 1 {
            return Err(ProbeError::Unsupported);
        }
        at += 2;
        let length = u16_at(config, at)? as usize;
        at += 2;
        let end = at.checked_add(length).ok_or(ProbeError::Unsupported)?;
        let nal = config.get(at..end).ok_or(ProbeError::Unsupported)?;
        if !(3..=65535).contains(&length) || nal[0] != kind << 1 || nal[1] != 1 {
            return Err(ProbeError::Unsupported); // forbidden=0, layer_id=0, temporal_id_plus1=1
        }
        let index = (kind - 32) as usize;
        if nals[index].is_some() {
            return Err(ProbeError::Unsupported);
        }
        nals[index] = Some(rbsp(&nal[2..])?);
        at = end;
    }
    if at != config.len() {
        return Err(ProbeError::Unsupported);
    }
    let vps = nals[0].as_ref().ok_or(ProbeError::Unsupported)?;
    let sps = nals[1].as_ref().ok_or(ProbeError::Unsupported)?;
    let pps = nals[2].as_ref().ok_or(ProbeError::Unsupported)?;
    let mut vps_bits = Bits::new(vps);
    let vps_id = vps_bits.read(4)?;
    if vps_bits.read(2)? != 3
        || vps_bits.read(6)? != 0
        || vps_bits.read(3)? != 0
        || vps_bits.read(1)? != 1
        || vps_bits.read(16)? != 0xffff
    {
        return Err(ProbeError::Unsupported);
    }
    ptl(&mut vps_bits, config)?;
    let mut sps_bits = Bits::new(sps);
    if sps_bits.read(4)? != vps_id || sps_bits.read(3)? != 0 || sps_bits.read(1)? != 1 {
        return Err(ProbeError::Unsupported);
    }
    ptl(&mut sps_bits, config)?;
    let sps_id = sps_bits.ue()?;
    if sps_id > 15 || sps_bits.ue()? != 1 {
        return Err(ProbeError::Unsupported);
    }
    let coded_width = sps_bits.ue()?;
    let coded_height = sps_bits.ue()?;
    let mut horizontal = 0u32;
    let mut vertical = 0u32;
    if sps_bits.read(1)? != 0 {
        horizontal = sps_bits
            .ue()?
            .checked_add(sps_bits.ue()?)
            .ok_or(ProbeError::Unsupported)?;
        vertical = sps_bits
            .ue()?
            .checked_add(sps_bits.ue()?)
            .ok_or(ProbeError::Unsupported)?;
    }
    let width_crop = horizontal.checked_mul(2).ok_or(ProbeError::Unsupported)?;
    let height_crop = vertical.checked_mul(2).ok_or(ProbeError::Unsupported)?;
    if coded_width.checked_sub(width_crop) != Some(width)
        || coded_height.checked_sub(height_crop) != Some(height)
        || coded_width > 8192
        || coded_height > 4320
        || sps_bits.ue()? != if config[1] == 1 { 0 } else { 2 }
        || sps_bits.ue()? != if config[1] == 1 { 0 } else { 2 }
    {
        return Err(ProbeError::Unsupported);
    }
    let mut pps_bits = Bits::new(pps);
    if pps_bits.ue()? > 63 || pps_bits.ue()? != sps_id {
        return Err(ProbeError::Unsupported);
    }
    let prefix = std::str::from_utf8(&entry_kind).map_err(|_| ProbeError::Unsupported)?;
    let rfc6381 = format!(
        "{prefix}.{}.{:X}.L{}.{:02X}",
        config[1],
        u32_at(config, 2)?.reverse_bits(),
        config[12],
        config[6]
    );
    if config[1] == 2 {
        let colr = unique(&boxes, b"colr")?.payload;
        Ok(Codec::HevcMain10 {
            rfc6381,
            width,
            height,
            color_primaries: u16_at(colr, 4)?,
            color_transfer: u16_at(colr, 6)?,
            color_space: u16_at(colr, 8)?,
            color_range: colr[10] >> 7,
        })
    } else {
        Ok(Codec::Hevc {
            rfc6381,
            width,
            height,
        })
    }
}
fn ptl(bits: &mut Bits<'_>, config: &[u8]) -> Result<()> {
    for &byte in &config[1..13] {
        if bits.read(8)? != u32::from(byte) {
            return Err(ProbeError::Unsupported);
        }
    }
    Ok(())
}
fn rbsp(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut zeros = 0;
    for (at, &byte) in bytes.iter().enumerate() {
        if zeros >= 2 {
            if byte == 3 {
                if bytes.get(at + 1).is_none_or(|&next| next > 3) {
                    return Err(ProbeError::Unsupported);
                }
                zeros = 0;
                continue;
            }
            if byte < 3 {
                return Err(ProbeError::Unsupported);
            }
        }
        out.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    Ok(out)
}
struct Bits<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> Bits<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }
    fn read(&mut self, count: usize) -> Result<u32> {
        if count > 32
            || self
                .at
                .checked_add(count)
                .is_none_or(|end| end > self.bytes.len() * 8)
        {
            return Err(ProbeError::Unsupported);
        }
        let mut value = 0;
        for _ in 0..count {
            value = (value << 1) | u32::from((self.bytes[self.at / 8] >> (7 - self.at % 8)) & 1);
            self.at += 1;
        }
        Ok(value)
    }
    fn ue(&mut self) -> Result<u32> {
        let mut zeros = 0;
        while self.read(1)? == 0 {
            zeros += 1;
            if zeros > 15 {
                return Err(ProbeError::Unsupported);
            }
        }
        Ok((1 << zeros) - 1 + self.read(zeros)?)
    }
}
