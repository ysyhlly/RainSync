//! Bounded MPEG-TS structural/conditional-access gate, not a media decoder.
//! RFC8216 §3.2 requires PAT/PMT in each TS segment when EXT-X-MAP is absent.
//! AVC/AAC stream-kind values follow the ISO transport vocabulary also used by
//! FFmpeg libavformat/mpegts.h. Unknown and HLS sample-encrypted types fail.
use super::{Error, MAX_SEGMENT_BYTES, Result};
const PACKET: usize = 188;
const MAX_PSI_SECTION: usize = 1024;
const MAX_PSI_SECTIONS: usize = 64;
fn invalid() -> Error {
    Error::InvalidResponse("live_ts_framing")
}
fn encrypted() -> Error {
    Error::Restricted("live_encrypted_segment_denied")
}
struct Packet<'a> {
    pid: u16,
    start: bool,
    continuity: u8,
    payload: Option<&'a [u8]>,
}
fn packet(bytes: &[u8]) -> Result<Packet<'_>> {
    if bytes.len() != PACKET || bytes[0] != 0x47 || bytes[1] & 0x80 != 0 || bytes[3] & 0x30 == 0 {
        return Err(invalid());
    }
    if bytes[3] & 0xc0 != 0 {
        return Err(encrypted());
    }
    let pid = ((u16::from(bytes[1]) & 0x1f) << 8) | u16::from(bytes[2]);
    // Conditional Access Table is never part of this clear-only contract.
    if pid == 1 {
        return Err(encrypted());
    }
    let adaptation = bytes[3] & 0x20 != 0;
    let has_payload = bytes[3] & 0x10 != 0;
    let mut offset = 4;
    if adaptation {
        let length = usize::from(bytes[4]);
        offset = 5 + length;
        if offset > PACKET || !has_payload && offset != PACKET {
            return Err(invalid());
        }
    }
    let payload = if has_payload {
        if offset >= PACKET {
            return Err(invalid());
        }
        Some(&bytes[offset..])
    } else {
        None
    };
    Ok(Packet {
        pid,
        start: bytes[1] & 0x40 != 0,
        continuity: bytes[3] & 0x0f,
        payload,
    })
}
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= u32::from(*byte) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0x04c1_1db7
            } else {
                crc << 1
            };
        }
    }
    crc
}
fn section_header(section: &[u8], table: u8) -> Result<()> {
    if section.len() < 12
        || section.len() > MAX_PSI_SECTION
        || section[0] != table
        || section[1] & 0xf0 != 0xb0
        || section[5] & 0xc1 != 0xc1
        || section[6] != 0
        || section[7] != 0
        || crc32(section) != 0
    {
        return Err(invalid());
    }
    Ok(())
}
fn append_sections(
    pending: &mut Vec<u8>,
    mut input: &[u8],
    output: &mut Vec<Vec<u8>>,
) -> Result<()> {
    while !input.is_empty() {
        if pending.is_empty() && input[0] == 0xff {
            if input.iter().any(|b| *b != 0xff) {
                return Err(invalid());
            }
            break;
        }
        let needed = if pending.len() < 3 {
            3 - pending.len()
        } else {
            let length = 3 + ((usize::from(pending[1]) & 0x0f) << 8) + usize::from(pending[2]);
            if !(12..=MAX_PSI_SECTION).contains(&length) {
                return Err(invalid());
            }
            length.checked_sub(pending.len()).ok_or_else(invalid)?
        };
        let copied = needed.min(input.len());
        pending.extend_from_slice(&input[..copied]);
        input = &input[copied..];
        if pending.len() >= 3 {
            let length = 3 + ((usize::from(pending[1]) & 0x0f) << 8) + usize::from(pending[2]);
            if !(12..=MAX_PSI_SECTION).contains(&length) {
                return Err(invalid());
            }
            if pending.len() == length {
                if output.len() >= MAX_PSI_SECTIONS {
                    return Err(Error::TooLarge);
                }
                output.push(std::mem::take(pending));
            }
        }
    }
    Ok(())
}
fn sections(bytes: &[u8], wanted: u16) -> Result<Vec<Vec<u8>>> {
    let mut output = Vec::new();
    let mut pending = Vec::new();
    let mut previous: Option<(u8, Vec<u8>)> = None;
    for raw in bytes.as_chunks::<PACKET>().0 {
        let packet = packet(raw)?;
        if packet.pid != wanted {
            continue;
        }
        let Some(payload) = packet.payload else {
            continue;
        };
        if let Some((cc, last)) = &previous {
            if packet.continuity == *cc {
                if payload == last.as_slice() {
                    continue;
                }
                return Err(invalid());
            }
            if packet.continuity != ((*cc + 1) & 0x0f) {
                return Err(invalid());
            }
        }
        previous = Some((packet.continuity, payload.to_vec()));
        if packet.start {
            let pointer = usize::from(payload[0]);
            if pointer + 1 > payload.len() {
                return Err(invalid());
            }
            if !pending.is_empty() {
                append_sections(&mut pending, &payload[1..1 + pointer], &mut output)?;
                if !pending.is_empty() {
                    return Err(invalid());
                }
            }
            append_sections(&mut pending, &payload[1 + pointer..], &mut output)?;
        } else if !pending.is_empty() {
            append_sections(&mut pending, payload, &mut output)?;
        }
    }
    if !pending.is_empty() || output.is_empty() {
        return Err(invalid());
    }
    Ok(output)
}
fn parse_pat(section: &[u8]) -> Result<(u16, u16)> {
    section_header(section, 0)?;
    let entries = &section[8..section.len() - 4];
    if !entries.len().is_multiple_of(4) {
        return Err(invalid());
    }
    let mut program = None;
    for entry in entries.as_chunks::<4>().0 {
        if entry[2] & 0xe0 != 0xe0 {
            return Err(invalid());
        }
        let number = u16::from_be_bytes([entry[0], entry[1]]);
        let pid = ((u16::from(entry[2]) & 0x1f) << 8) | u16::from(entry[3]);
        if number == 0 {
            continue;
        }
        if pid < 16 || pid == 0x1fff || program.is_some() {
            return Err(Error::Restricted("live_ts_multi_program_denied"));
        }
        program = Some((number, pid));
    }
    program.ok_or_else(invalid)
}
fn descriptors(mut bytes: &[u8]) -> Result<()> {
    while !bytes.is_empty() {
        if bytes.len() < 2 {
            return Err(invalid());
        }
        let tag = bytes[0];
        let length = usize::from(bytes[1]);
        if length + 2 > bytes.len() {
            return Err(invalid());
        }
        // CA and registration descriptors can introduce protected or unfamiliar
        // payload modes. Narrow first slice has neither a decryption nor an
        // alternate descriptor interpretation path.
        if matches!(tag, 0x09 | 0x05) {
            return Err(encrypted());
        }
        bytes = &bytes[2 + length..];
    }
    Ok(())
}
fn parse_pmt(section: &[u8], program: u16) -> Result<Vec<(u16, u8)>> {
    section_header(section, 2)?;
    if section.len() < 21
        || u16::from_be_bytes([section[3], section[4]]) != program
        || section[8] & 0xe0 != 0xe0
        || section[10] & 0xf0 != 0xf0
    {
        return Err(invalid());
    }
    let pcr_pid = ((u16::from(section[8]) & 0x1f) << 8) | u16::from(section[9]);
    let info = ((usize::from(section[10]) & 0x0f) << 8) | usize::from(section[11]);
    let end = section.len() - 4;
    if 12 + info > end {
        return Err(invalid());
    }
    descriptors(&section[12..12 + info])?;
    let mut index = 12 + info;
    let mut streams = Vec::new();
    let mut video = false;
    let mut audio = false;
    while index < end {
        if index + 5 > end || section[index + 1] & 0xe0 != 0xe0 || section[index + 3] & 0xf0 != 0xf0
        {
            return Err(invalid());
        }
        let kind = section[index];
        let pid = ((u16::from(section[index + 1]) & 0x1f) << 8) | u16::from(section[index + 2]);
        let length =
            ((usize::from(section[index + 3]) & 0x0f) << 8) | usize::from(section[index + 4]);
        if index + 5 + length > end
            || pid < 16
            || pid == 0x1fff
            || streams.iter().any(|(p, _)| *p == pid)
        {
            return Err(invalid());
        }
        match kind {
            0x1b if !video => video = true,
            0x0f if !audio => audio = true,
            _ => return Err(Error::Restricted("live_ts_codec_denied")),
        }
        descriptors(&section[index + 5..index + 5 + length])?;
        streams.push((pid, kind));
        index += 5 + length;
    }
    if !video || !audio || !streams.iter().any(|(pid, _)| *pid == pcr_pid) {
        return Err(Error::Restricted("live_ts_codec_denied"));
    }
    Ok(streams)
}
pub(crate) fn validate_clear_ts(bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_SEGMENT_BYTES || !bytes.len().is_multiple_of(PACKET) {
        return Err(invalid());
    }
    for raw in bytes.as_chunks::<PACKET>().0 {
        packet(raw)?;
    }
    let pats = sections(bytes, 0)?;
    let program = parse_pat(&pats[0])?;
    for pat in &pats[1..] {
        if parse_pat(pat)? != program {
            return Err(Error::Restricted("live_ts_program_changed"));
        }
    }
    let pmts = sections(bytes, program.1)?;
    let streams = parse_pmt(&pmts[0], program.0)?;
    for pmt in &pmts[1..] {
        if parse_pmt(pmt, program.0)? != streams {
            return Err(Error::Restricted("live_ts_program_changed"));
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn with_crc(mut section: Vec<u8>) -> Vec<u8> {
        let crc = crc32(&section);
        section.extend_from_slice(&crc.to_be_bytes());
        section
    }
    fn wrap(pid: u16, section: &[u8]) -> Vec<u8> {
        assert!(section.len() < 184);
        let mut packet = vec![0xff; PACKET];
        packet[0] = 0x47;
        packet[1] = 0x40 | ((pid >> 8) as u8 & 0x1f);
        packet[2] = pid as u8;
        packet[3] = 0x10;
        packet[4] = 0;
        packet[5..5 + section.len()].copy_from_slice(section);
        packet
    }
    fn pat() -> Vec<u8> {
        with_crc(vec![0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0])
    }
    fn pmt(extra: &[u8], audio: u8) -> Vec<u8> {
        let mut raw = vec![
            2,
            0xb0,
            (23 + extra.len()) as u8,
            0,
            1,
            0xc1,
            0,
            0,
            0xe1,
            1,
            0xf0,
            extra.len() as u8,
        ];
        raw.extend_from_slice(extra);
        raw.extend_from_slice(&[0x1b, 0xe1, 1, 0xf0, 0, audio, 0xe1, 2, 0xf0, 0]);
        with_crc(raw)
    }
    fn fixture(extra: &[u8], audio: u8) -> Vec<u8> {
        let mut body = wrap(0, &pat());
        body.extend_from_slice(&wrap(256, &pmt(extra, audio)));
        body
    }
    #[test]
    fn live_ts_requires_one_clear_avc_aac_program() {
        let clear = fixture(&[], 0x0f);
        assert!(validate_clear_ts(&clear).is_ok());
        for extra in [
            &[0x09, 4, 0, 1, 0xe1, 3][..],
            &[0x05, 4, b'a', b'p', b'a', b'd'][..],
        ] {
            assert!(validate_clear_ts(&fixture(extra, 0x0f)).is_err());
        }
        for kind in [0x06, 0x11, 0x81, 0xcf] {
            assert!(validate_clear_ts(&fixture(&[], kind)).is_err());
        }
        let mut scrambled = clear.clone();
        scrambled[3] |= 0x80;
        assert!(validate_clear_ts(&scrambled).is_err());
        let mut bad_crc = clear.clone();
        bad_crc[20] ^= 1;
        assert!(validate_clear_ts(&bad_crc).is_err());
        let mut truncated = clear.clone();
        truncated.pop();
        assert!(validate_clear_ts(&truncated).is_err());
        assert!(validate_clear_ts(&clear[..PACKET]).is_err());
        assert!(validate_clear_ts(&clear[PACKET..]).is_err());
        let mut cat = clear;
        cat.extend_from_slice(&wrap(1, &pat()));
        assert!(validate_clear_ts(&cat).is_err());
    }
    #[test]
    fn live_ts_program_and_descriptor_lengths_are_closed() {
        let mut many = vec![0, 0xb0, 17, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0, 0, 2, 0xe1, 3];
        many = with_crc(many);
        let mut body = wrap(0, &many);
        body.extend_from_slice(&wrap(256, &pmt(&[], 0x0f)));
        assert!(validate_clear_ts(&body).is_err());
        assert!(validate_clear_ts(&fixture(&[0x0a, 10, 0], 0x0f)).is_err());
        let mut bad_adaptation = fixture(&[], 0x0f);
        bad_adaptation[3] = 0x30;
        bad_adaptation[4] = 184;
        assert!(validate_clear_ts(&bad_adaptation).is_err());
    }
    #[test]
    fn live_ts_psi_reassembly_is_bounded_and_continuity_checked() {
        let mut extra = vec![0x0a, 180];
        extra.extend(std::iter::repeat_n(0, 180));
        let section = pmt(&extra, 0x0f);
        assert!(section.len() > 183);
        let mut first = vec![0xff; PACKET];
        first[0] = 0x47;
        first[1] = 0x41;
        first[2] = 0;
        first[3] = 0x10;
        first[4] = 0;
        first[5..].copy_from_slice(&section[..183]);
        let mut second = vec![0xff; PACKET];
        second[0] = 0x47;
        second[1] = 1;
        second[2] = 0;
        second[3] = 0x11;
        second[4..4 + section.len() - 183].copy_from_slice(&section[183..]);
        let mut body = wrap(0, &pat());
        body.extend_from_slice(&first);
        body.extend_from_slice(&second);
        assert!(validate_clear_ts(&body).is_ok());
        body[PACKET * 2 + 3] = 0x13;
        assert!(validate_clear_ts(&body).is_err());
        body.truncate(PACKET * 2);
        assert!(validate_clear_ts(&body).is_err());
    }
}
