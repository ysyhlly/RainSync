use super::DecodedSegment;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SegmentMapping {
    pub index: usize,
    pub discontinuity: bool,
    pub original_bytes: usize,
    pub original_sha256: String,
    pub normalized_sha256: String,
    pub original_video_first_pts: i64,
    pub normalized_video_first_pts: i64,
    pub video_frames: usize,
    pub video_step_ticks: i64,
    pub original_audio_first_pts: Option<i64>,
    pub normalized_audio_first_pts: Option<i64>,
    pub audio_packets: usize,
    pub timestamp_offset_ticks: i64,
}
#[derive(Default)]
pub struct TimestampMap {
    configuration: Option<String>,
    video_end: Option<i64>,
    audio_end: Option<i64>,
    offset: i64,
    continuity: BTreeMap<u16, u8>,
    pub mappings: Vec<SegmentMapping>,
}
pub struct NormalizedSegment {
    pub bytes: Vec<u8>,
    pub mapping: SegmentMapping,
}
fn fail(condition: bool, reason: &str) -> Result<()> {
    ensure!(condition, "unsupported_finite_hls:{reason}");
    Ok(())
}
fn timestamp(data: &[u8], prefix: u8) -> Result<i64> {
    fail(
        data.len() >= 5
            && data[0] >> 4 == prefix
            && data[0] & 1 == 1
            && data[2] & 1 == 1
            && data[4] & 1 == 1,
        "pes_timestamp",
    )?;
    Ok((i64::from((data[0] >> 1) & 7) << 30)
        | (i64::from(data[1]) << 22)
        | (i64::from(data[2] >> 1) << 15)
        | (i64::from(data[3]) << 7)
        | i64::from(data[4] >> 1))
}
fn write_timestamp(data: &mut [u8], value: i64) -> Result<()> {
    fail(
        (0..1i64 << 33).contains(&value),
        "normalized_timestamp_bound",
    )?;
    data[0] = (data[0] & 0xf0) | (((value >> 30) as u8 & 7) << 1) | 1;
    data[1] = (value >> 22) as u8;
    data[2] = (((value >> 15) as u8 & 127) << 1) | 1;
    data[3] = (value >> 7) as u8;
    data[4] = ((value as u8 & 127) << 1) | 1;
    Ok(())
}
/// Rebase only physically observed PTS/DTS/PCR and continuity counters. Exact
/// decoded packet sequences must match actual PES headers before bytes change.
/// A reset is allowed only at an explicit boundary; no gap/overlap is concealed.
pub fn normalize_transport_stream(
    bytes: &[u8],
    decoded: &DecodedSegment,
    discontinuity: bool,
    state: &mut TimestampMap,
) -> Result<NormalizedSegment> {
    fail(
        bytes.len() == decoded.original_bytes
            && format!("{:x}", Sha256::digest(bytes)) == decoded.original_sha256
            && decoded.process_tree_reaped,
        "original_decode_binding",
    )?;
    fail(
        bytes.len().is_multiple_of(188) && !bytes.is_empty(),
        "ts_packet_alignment",
    )?;
    fail(
        state
            .configuration
            .as_ref()
            .is_none_or(|v| v == &decoded.configuration),
        "changed_codec_configuration",
    )?;
    let expected = state.video_end.unwrap_or(90000);
    let offset = if state.video_end.is_none() || discontinuity {
        expected - decoded.video_pts[0]
    } else {
        state.offset
    };
    fail(
        decoded.video_pts[0] + offset == expected,
        "undeclared_timestamp_gap_or_reset",
    )?;
    let first_audio = decoded.audio_pts.first().copied().map(|v| v + offset);
    fail(first_audio.is_none_or(|v| v >= 0), "normalized_audio_bound")?;
    if let Some(end) = state.audio_end {
        fail(first_audio == Some(end), "aac_boundary_gap_or_overlap")?;
    } else {
        fail(
            state.video_end.is_none() || first_audio.is_none(),
            "changed_audio_track",
        )?;
    }
    let mut result = bytes.to_vec();
    let mut observed_video = Vec::new();
    let mut observed_audio = Vec::new();
    let mut counters = state.continuity.clone();
    let mut video_pid = None;
    let mut audio_pid = None;
    for packet in result.as_chunks_mut::<188>().0 {
        fail(
            packet[0] == 0x47 && packet[1] & 0x80 == 0 && packet[3] & 0xc0 == 0,
            "ts_sync_error_or_scrambling",
        )?;
        let pid = (u16::from(packet[1] & 31) << 8) | u16::from(packet[2]);
        let adaptation = (packet[3] >> 4) & 3;
        fail(adaptation != 0, "ts_adaptation")?;
        let payload = adaptation & 1 != 0;
        let mut start = 4usize;
        if adaptation & 2 != 0 {
            let length = usize::from(packet[4]);
            fail(length <= 183, "ts_adaptation")?;
            start = 5 + length;
            if length > 0 && packet[5] & 0x10 != 0 {
                fail(length >= 7, "ts_pcr")?;
                let p = &mut packet[6..12];
                fail(p[4] & 0x7e == 0x7e, "ts_pcr_reserved")?;
                let clock = (i64::from(p[0]) << 25)
                    | (i64::from(p[1]) << 17)
                    | (i64::from(p[2]) << 9)
                    | (i64::from(p[3]) << 1)
                    | i64::from(p[4] >> 7);
                let clock = clock + offset;
                fail((0..1i64 << 33).contains(&clock), "normalized_pcr_bound")?;
                p[0] = (clock >> 25) as u8;
                p[1] = (clock >> 17) as u8;
                p[2] = (clock >> 9) as u8;
                p[3] = (clock >> 1) as u8;
                p[4] = (p[4] & 0x7f) | ((clock as u8 & 1) << 7);
            }
            // OPCR/splice/private/extension grammars are not silently preserved.
            if length > 0 {
                fail(packet[5] & 0x0f == 0, "ts_adaptation_extension")?;
                packet[5] &= !0x80;
            }
        }
        if pid != 0x1fff {
            let value = counters.get(&pid).map_or(packet[3] & 15, |last| {
                if payload { (last + 1) & 15 } else { *last }
            });
            packet[3] = (packet[3] & 0xf0) | value;
            counters.insert(pid, value);
        }
        if payload
            && packet[1] & 0x40 != 0
            && start + 9 <= 188
            && packet[start..start + 3] == [0, 0, 1]
        {
            let stream_id = packet[start + 3];
            let video = (0xe0..=0xef).contains(&stream_id);
            let audio = (0xc0..=0xdf).contains(&stream_id);
            fail(video || audio, "ts_extra_pes_track")?;
            let chosen = if video {
                &mut video_pid
            } else {
                &mut audio_pid
            };
            fail(
                chosen.is_none_or(|v| v == pid),
                "ts_multiple_elementary_tracks",
            )?;
            *chosen = Some(pid);
            fail(
                packet[start + 6] & 0xc0 == 0x80 && packet[start + 6] & 0x30 == 0,
                "pes_protection",
            )?;
            let flags = packet[start + 7];
            let length = usize::from(packet[start + 8]);
            fail(
                flags & 0x3f == 0 && matches!(flags >> 6, 2 | 3) && start + 9 + length <= 188,
                "pes_optional_or_split_header",
            )?;
            let clock = timestamp(&packet[start + 9..], if flags >> 6 == 2 { 2 } else { 3 })?;
            if video {
                observed_video.push(clock);
            } else {
                observed_audio.push(clock);
            }
            write_timestamp(&mut packet[start + 9..], clock + offset)?;
            if flags >> 6 == 3 {
                fail(length >= 10, "pes_dts")?;
                let dts = timestamp(&packet[start + 14..], 1)?;
                fail(dts == clock, "pes_b_frame_or_clock")?;
                write_timestamp(&mut packet[start + 14..], dts + offset)?;
            } else {
                fail(length >= 5, "pes_pts")?;
            }
        }
    }
    // AVC has one PES timestamp per decoded packet. AAC PES commonly groups
    // several ADTS packets; each observed PES start must equal an actual packet.
    fail(
        observed_video == decoded.video_pts && !observed_video.is_empty(),
        "pes_decoder_video_binding",
    )?;
    fail(
        if decoded.audio_pts.is_empty() {
            observed_audio.is_empty()
        } else {
            !observed_audio.is_empty()
                && observed_audio[0] == decoded.audio_pts[0]
                && observed_audio.windows(2).all(|p| p[1] > p[0])
                && observed_audio
                    .iter()
                    .all(|p| decoded.audio_pts.binary_search(p).is_ok())
        },
        "pes_decoder_audio_binding",
    )?;
    let mapping = SegmentMapping {
        index: state.mappings.len(),
        discontinuity,
        original_bytes: bytes.len(),
        original_sha256: decoded.original_sha256.clone(),
        normalized_sha256: format!("{:x}", Sha256::digest(&result)),
        original_video_first_pts: decoded.video_pts[0],
        normalized_video_first_pts: expected,
        video_frames: decoded.video_pts.len(),
        video_step_ticks: decoded.video_step,
        original_audio_first_pts: decoded.audio_pts.first().copied(),
        normalized_audio_first_pts: first_audio,
        audio_packets: decoded.audio_pts.len(),
        timestamp_offset_ticks: offset,
    };
    state.configuration = Some(decoded.configuration.clone());
    state.offset = offset;
    state.video_end = Some(expected + decoded.video_pts.len() as i64 * decoded.video_step);
    state.audio_end = decoded
        .audio_pts
        .last()
        .map(|v| v + offset + decoded.audio_step);
    state.continuity = counters;
    state.mappings.push(mapping.clone());
    Ok(NormalizedSegment {
        bytes: result,
        mapping,
    })
}
