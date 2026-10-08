use super::*;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn boxed(kind: &[u8; 4], payload: Vec<u8>) -> Vec<u8> {
    let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend(payload);
    out
}
fn container(kind: &[u8; 4], children: Vec<Vec<u8>>) -> Vec<u8> {
    boxed(kind, children.into_iter().flatten().collect())
}
fn put16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_be_bytes());
}
fn put32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_be_bytes());
}
fn put64(bytes: &mut [u8], at: usize, value: u64) {
    bytes[at..at + 8].copy_from_slice(&value.to_be_bytes());
}
fn fullbox(kind: &[u8; 4], flags: u32, tail: Vec<u8>) -> Vec<u8> {
    let mut payload = flags.to_be_bytes().to_vec();
    payload.extend(tail);
    boxed(kind, payload)
}
fn matrix_into(bytes: &mut [u8], at: usize) {
    for (i, value) in [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]
        .iter()
        .enumerate()
    {
        put32(bytes, at + i * 4, *value);
    }
}
fn desc(tag: u8, payload: Vec<u8>) -> Vec<u8> {
    assert!(payload.len() < 128);
    let mut out = vec![tag, payload.len() as u8];
    out.extend(payload);
    out
}
fn sample_entry(kind: TrackKind) -> Vec<u8> {
    match kind {
        TrackKind::Video => {
            let mut entry = vec![0; 78];
            put16(&mut entry, 6, 1);
            put16(&mut entry, 24, 640);
            put16(&mut entry, 26, 360);
            put32(&mut entry, 28, 0x00480000);
            put32(&mut entry, 32, 0x00480000);
            put16(&mut entry, 40, 1);
            put16(&mut entry, 74, 24);
            put16(&mut entry, 76, 0xffff);
            // High-profile SPS/PPS encoded in the standard AVC configuration
            // record. The parser validates configuration framing, not decoding.
            let sps = [
                0x67, 0x64, 0x00, 0x1e, 0xac, 0xd9, 0x40, 0xa0, 0x2f, 0xf9, 0x70, 0x11, 0x00, 0x00,
                0x03, 0x00, 0x01, 0x00, 0x00, 0x03, 0x00, 0x32, 0x0f, 0x16, 0x2d, 0x96,
            ];
            let pps = [0x68, 0xeb, 0xec, 0xb2, 0x2c];
            let mut config = vec![1, 100, 0, 30, 0xff, 0xe1];
            config.extend((sps.len() as u16).to_be_bytes());
            config.extend(sps);
            config.push(1);
            config.extend((pps.len() as u16).to_be_bytes());
            config.extend(pps);
            entry.extend(boxed(b"avcC", config));
            boxed(b"avc1", entry)
        }
        TrackKind::Audio => {
            let mut entry = vec![0; 28];
            put16(&mut entry, 6, 1);
            put16(&mut entry, 16, 2);
            put16(&mut entry, 18, 16);
            put32(&mut entry, 24, 48000 << 16);
            let mut decoder = vec![0x40, 0x15, 0, 0, 0];
            decoder.extend(128000u32.to_be_bytes());
            decoder.extend(128000u32.to_be_bytes());
            decoder.extend(desc(5, vec![0x11, 0x90])); // AAC-LC, 48 kHz, stereo, ordinary GASpecificConfig.
            let mut es = vec![0, 1, 0];
            es.extend(desc(4, decoder));
            es.extend(desc(6, vec![2]));
            entry.extend(fullbox(b"esds", 0, desc(3, es)));
            boxed(b"mp4a", entry)
        }
    }
}
fn moov(kind: TrackKind, padding: usize) -> Vec<u8> {
    moov_with_entry(kind, padding, sample_entry(kind))
}
fn moov_with_entry(kind: TrackKind, padding: usize, entry: Vec<u8>) -> Vec<u8> {
    let mut mvhd = vec![0; 100];
    put32(&mut mvhd, 12, 1000);
    put32(&mut mvhd, 20, 0x10000);
    put16(&mut mvhd, 24, 0x100);
    matrix_into(&mut mvhd, 36);
    put32(&mut mvhd, 96, 2);
    let mut tkhd = vec![0; 84];
    put32(&mut tkhd, 0, 3);
    put32(&mut tkhd, 12, 1);
    matrix_into(&mut tkhd, 40);
    if kind == TrackKind::Video {
        put32(&mut tkhd, 76, 640 << 16);
        put32(&mut tkhd, 80, 360 << 16);
    } else {
        put16(&mut tkhd, 36, 0x100);
    }
    let mut mdhd = vec![0; 24];
    put32(
        &mut mdhd,
        12,
        match kind {
            TrackKind::Video => 90000,
            TrackKind::Audio => 48000,
        },
    );
    put16(&mut mdhd, 20, 0x55c4);
    let mut hdlr = vec![0; 24];
    hdlr[8..12].copy_from_slice(match kind {
        TrackKind::Video => b"vide",
        TrackKind::Audio => b"soun",
    });
    hdlr.extend_from_slice(b"test\0");
    let media_header = match kind {
        TrackKind::Video => fullbox(b"vmhd", 1, vec![0; 8]),
        TrackKind::Audio => fullbox(b"smhd", 0, vec![0; 4]),
    };
    let dinf = container(
        b"dinf",
        vec![fullbox(
            b"dref",
            0,
            [1u32.to_be_bytes().to_vec(), fullbox(b"url ", 1, vec![])].concat(),
        )],
    );
    let mut stsd = 1u32.to_be_bytes().to_vec();
    stsd.extend(entry);
    let stbl = container(
        b"stbl",
        vec![
            fullbox(b"stsd", 0, stsd),
            fullbox(b"stts", 0, vec![0; 4]),
            fullbox(b"stsc", 0, vec![0; 4]),
            fullbox(b"stsz", 0, vec![0; 8]),
            fullbox(b"stco", 0, vec![0; 4]),
        ],
    );
    let minf = container(b"minf", vec![media_header, dinf, stbl]);
    let mdia = container(
        b"mdia",
        vec![boxed(b"mdhd", mdhd), boxed(b"hdlr", hdlr), minf],
    );
    let trak = container(b"trak", vec![boxed(b"tkhd", tkhd), mdia]);
    let mut trex = vec![0; 24];
    put32(&mut trex, 4, 1);
    put32(&mut trex, 8, 1);
    let mvex = container(b"mvex", vec![boxed(b"trex", trex)]);
    let mut children = vec![boxed(b"mvhd", mvhd), trak, mvex];
    if padding != 0 {
        children.push(boxed(b"free", vec![0; padding]));
    }
    container(b"moov", children)
}
fn sidx(version: u8, size: u32) -> Vec<u8> {
    let mut payload = vec![0; if version == 0 { 24 } else { 32 }];
    payload[0] = version;
    put32(&mut payload, 4, 1);
    put32(&mut payload, 8, 1000);
    let count_at = if version == 0 { 22 } else { 30 };
    put16(&mut payload, count_at, 2);
    for _ in 0..2 {
        payload.extend(size.to_be_bytes());
        payload.extend(2000u32.to_be_bytes());
        payload.extend(0x90000000u32.to_be_bytes());
    }
    boxed(b"sidx", payload)
}
fn fragment(sequence: u32) -> Vec<u8> {
    let mfhd = fullbox(b"mfhd", 0, sequence.to_be_bytes().to_vec());
    let tfhd = fullbox(b"tfhd", 0x020000, 1u32.to_be_bytes().to_vec());
    let tfdt = fullbox(
        b"tfdt",
        0x01000000,
        ((sequence - 1) as u64 * 2000).to_be_bytes().to_vec(),
    );
    let mut trun = 1u32.to_be_bytes().to_vec();
    trun.extend(100u32.to_be_bytes());
    let moof = container(
        b"moof",
        vec![
            mfhd,
            container(b"traf", vec![tfhd, tfdt, fullbox(b"trun", 1, trun)]),
        ],
    );
    let padding = 4096 - moof.len() - 8;
    [moof, boxed(b"mdat", vec![0x55; padding])].concat()
}
fn fixture(kind: TrackKind, padding: usize, version: u8) -> Vec<u8> {
    let ftyp = boxed(
        b"ftyp",
        [
            b"dash".to_vec(),
            0u32.to_be_bytes().to_vec(),
            b"iso6avc1mp41".to_vec(),
        ]
        .concat(),
    );
    [
        ftyp,
        moov(kind, padding),
        sidx(version, 4096),
        fragment(1),
        fragment(2),
    ]
    .concat()
}
fn parsed(bytes: &[u8], kind: TrackKind) -> Probe {
    match parse_prefix(bytes, bytes.len() as u64, kind).unwrap() {
        Prefix::Complete(probe) => probe,
        Prefix::Need(_) => panic!("incomplete"),
    }
}
/// Find a literal test box name, then mutate its payload without pretending to
/// discover production structure through raw byte searches.
fn payload_at(bytes: &[u8], name: &[u8; 4]) -> usize {
    bytes
        .windows(4)
        .enumerate()
        .find(|(at, value)| {
            *at >= 4
                && *value == name
                && u32_at(bytes, *at - 4)
                    .is_ok_and(|size| size >= 8 && size as usize <= bytes.len() - (*at - 4))
        })
        .unwrap()
        .0
        + 4
}
fn unsupported(bytes: &[u8], kind: TrackKind) {
    assert!(matches!(
        parse_prefix(bytes, bytes.len() as u64, kind),
        Err(ProbeError::Unsupported | ProbeError::TooLarge)
    ));
}

#[test]
fn realistic_video_and_audio_flat_sidx_v0_v1() {
    for kind in [TrackKind::Video, TrackKind::Audio] {
        for version in [0, 1] {
            let bytes = fixture(kind, 0, version);
            let probe = parsed(&bytes, kind);
            assert_eq!(probe.timescale, 1000);
            assert_eq!(probe.duration_ticks, 4000);
            assert_eq!(probe.track_id, 1);
            assert_eq!(probe.total_bytes, bytes.len() as u64);
            assert_eq!(probe.segments.len(), 2);
            assert_eq!(probe.segments[1].range.end, bytes.len() as u64 - 1);
            assert_eq!(probe.segments[0].range.start, probe.index.end + 1);
            assert_eq!(
                &bytes[probe.index.start as usize + 4..probe.index.start as usize + 8],
                b"sidx"
            );
            match kind {
                TrackKind::Video => assert_eq!(
                    probe.codec,
                    Codec::Avc {
                        rfc6381: "avc1.64001e".into(),
                        width: 640,
                        height: 360
                    }
                ),
                TrackKind::Audio => assert_eq!(
                    probe.codec,
                    Codec::AacLc {
                        sample_rate: 48000,
                        channels: 2
                    }
                ),
            }
        }
    }
}
#[test]
fn prefix_stops_at_index_without_parsing_media() {
    let bytes = fixture(TrackKind::Video, 0, 0);
    let expected = parsed(&bytes, TrackKind::Video);
    let prefix = &bytes[..expected.index.end as usize + 1];
    assert!(matches!(
        parse_prefix(prefix, bytes.len() as u64, TrackKind::Video),
        Ok(Prefix::Complete(_))
    ));
    let mut corrupt_media = bytes;
    corrupt_media[expected.segments[0].range.start as usize..].fill(0xff);
    assert!(matches!(
        parse_prefix(&corrupt_media, corrupt_media.len() as u64, TrackKind::Video),
        Ok(Prefix::Complete(_))
    ));
}
#[test]
fn all_truncated_initialization_and_index_prefixes_are_bounded() {
    let bytes = fixture(TrackKind::Video, 0, 0);
    let probe = parsed(&bytes, TrackKind::Video);
    for end in 0..probe.index.end as usize {
        match parse_prefix(&bytes[..end], bytes.len() as u64, TrackKind::Video) {
            Ok(Prefix::Need(needed)) => {
                assert!(needed > end);
                assert!(needed <= MAX_PROBE_BYTES);
            }
            Ok(Prefix::Complete(_)) => panic!("truncated index accepted"),
            Err(ProbeError::Unsupported) => {} // An already malformed complete box may fail closed.
            Err(error) => panic!("unexpected error: {error}"),
        }
    }
}
#[test]
fn reject_nonfragmented_multitrack_encrypted_and_external_structures() {
    for replacement in [*b"pssh", *b"uuid", *b"edts", *b"sinf"] {
        let mut bytes = fixture(TrackKind::Video, 0, 0);
        let at = payload_at(&bytes, b"mvex") - 4;
        bytes[at..at + 4].copy_from_slice(&replacement);
        unsupported(&bytes, TrackKind::Video);
    }
    let mut bytes = fixture(TrackKind::Video, 0, 0);
    let at = payload_at(&bytes, b"url ");
    put32(&mut bytes, at, 0);
    unsupported(&bytes, TrackKind::Video);
    let mut bytes = fixture(TrackKind::Video, 0, 0);
    let at = payload_at(&bytes, b"avc1") - 4;
    bytes[at..at + 4].copy_from_slice(b"encv");
    unsupported(&bytes, TrackKind::Video);
    let mut bytes = fixture(TrackKind::Audio, 0, 0);
    let at = payload_at(&bytes, b"mp4a") - 4;
    bytes[at..at + 4].copy_from_slice(b"enca");
    unsupported(&bytes, TrackKind::Audio);
    // Put another structurally complete track into moov and adjust only moov size.
    let mut bytes = fixture(TrackKind::Video, 0, 0);
    let moov_at = payload_at(&bytes, b"moov") - 8;
    let trak_at = payload_at(&bytes, b"trak") - 8;
    let trak_size = u32_at(&bytes, trak_at).unwrap() as usize;
    let extra = bytes[trak_at..trak_at + trak_size].to_vec();
    let moov_size = u32_at(&bytes, moov_at).unwrap() as usize;
    bytes.splice(moov_at + moov_size..moov_at + moov_size, extra);
    put32(&mut bytes, moov_at, (moov_size + trak_size) as u32);
    unsupported(&bytes, TrackKind::Video);
}
#[test]
fn reject_nonempty_or_duplicate_sample_tables_and_wrong_handler() {
    for (name, field) in [
        (b"stts", 4),
        (b"stsc", 4),
        (b"stsz", 8),
        (b"stco", 4),
        (b"stsd", 4),
    ] {
        let mut bytes = fixture(TrackKind::Video, 0, 0);
        let at = payload_at(&bytes, name);
        put32(&mut bytes, at + field, 2);
        unsupported(&bytes, TrackKind::Video);
    }
    let bytes = fixture(TrackKind::Video, 0, 0);
    unsupported(&bytes, TrackKind::Audio);
    let mut bytes = bytes;
    let at = payload_at(&bytes, b"stco") - 4;
    bytes[at..at + 4].copy_from_slice(b"stts");
    unsupported(&bytes, TrackKind::Video);
}
#[test]
fn reject_bad_codec_configuration_and_conflicting_sample_metadata() {
    for (offset, value) in [(0, 2), (1, 110), (4, 0xfe), (5, 0xe0), (8, 0xe7)] {
        let mut bytes = fixture(TrackKind::Video, 0, 0);
        let at = payload_at(&bytes, b"avcC");
        bytes[at + offset] = value;
        unsupported(&bytes, TrackKind::Video);
    }
    let mut bytes = fixture(TrackKind::Video, 0, 0);
    let at = payload_at(&bytes, b"avc1");
    put16(&mut bytes, at + 24, 1280);
    unsupported(&bytes, TrackKind::Video);
    let mut bytes = fixture(TrackKind::Video, 0, 0);
    let at = payload_at(&bytes, b"tkhd");
    put32(&mut bytes, at + 40, 0);
    unsupported(&bytes, TrackKind::Video);
    let mut bytes = fixture(TrackKind::Audio, 0, 0);
    let at = payload_at(&bytes, b"mp4a");
    put16(&mut bytes, at + 16, 1);
    unsupported(&bytes, TrackKind::Audio);
    for (from, to) in [
        (vec![0x11, 0x90], vec![0x29, 0x90]),
        (vec![0x11, 0x90], vec![0x11, 0x91]),
    ] {
        let mut bytes = fixture(TrackKind::Audio, 0, 0);
        let at = bytes.windows(2).position(|b| b == from).unwrap();
        bytes[at..at + 2].copy_from_slice(&to);
        unsupported(&bytes, TrackKind::Audio);
    }
    let mut bytes = fixture(TrackKind::Audio, 0, 0);
    let at = payload_at(&bytes, b"esds");
    bytes[at + 5] = 0xff;
    unsupported(&bytes, TrackKind::Audio);
}
#[test]
fn reject_invalid_sidx_values_hierarchy_sap_and_out_of_file_ranges() {
    for version in [0, 1] {
        let base = fixture(TrackKind::Video, 0, version);
        let at = payload_at(&base, b"sidx");
        let count_at = if version == 0 { 22 } else { 30 };
        for (offset, value) in [
            (4, 2),
            (8, 0),
            (count_at + 2, 0),
            (count_at + 2, 0x80001000),
            (count_at + 6, 0),
            (count_at + 10, 0),
            (count_at + 10, 0x90000001),
            (count_at + 10, 0xb0000000),
        ] {
            let mut bytes = base.clone();
            put32(&mut bytes, at + offset, value);
            unsupported(&bytes, TrackKind::Video);
        }
        let mut bytes = base.clone();
        bytes[at] = 2;
        unsupported(&bytes, TrackKind::Video);
        let mut bytes = base.clone();
        put16(&mut bytes, at + count_at, 0);
        unsupported(&bytes, TrackKind::Video);
        let mut bytes = base.clone();
        put16(&mut bytes, at + count_at, 4097);
        unsupported(&bytes, TrackKind::Video);
        let mut bytes = base.clone();
        if version == 0 {
            put32(&mut bytes, at + 12, 1);
        } else {
            put64(&mut bytes, at + 12, 1);
        }
        unsupported(&bytes, TrackKind::Video);
        let mut bytes = base;
        if version == 0 {
            put32(&mut bytes, at + 16, u32::MAX);
        } else {
            put64(&mut bytes, at + 20, u64::MAX);
        }
        unsupported(&bytes, TrackKind::Video);
    }
}
#[test]
fn reject_zero_overflow_truncated_large_boxes_and_media_before_index() {
    for value in [0, 7, u32::MAX] {
        let mut bytes = fixture(TrackKind::Video, 0, 0);
        put32(&mut bytes, 0, value);
        unsupported(&bytes, TrackKind::Video);
    }
    let mut bytes = fixture(TrackKind::Video, 0, 0);
    let at = payload_at(&bytes, b"sidx") - 4;
    bytes[at..at + 4].copy_from_slice(b"mdat");
    unsupported(&bytes, TrackKind::Video);
    let mut bytes = 1u32.to_be_bytes().to_vec();
    bytes.extend(b"ftyp");
    bytes.extend(u64::MAX.to_be_bytes());
    assert!(matches!(
        parse_prefix(&bytes, u64::MAX, TrackKind::Video),
        Err(ProbeError::TooLarge)
    ));
    let mut bytes = fixture(TrackKind::Video, 0, 0);
    let at = payload_at(&bytes, b"moov") - 8;
    put32(&mut bytes, at, MAX_PROBE_BYTES as u32 + 1);
    unsupported(&bytes, TrackKind::Video);
    assert!(matches!(
        parse_prefix(&vec![0; MAX_PROBE_BYTES + 1], u64::MAX, TrackKind::Video),
        Err(ProbeError::TooLarge)
    ));
}
#[test]
fn parser_box_count_and_nesting_limits_are_explicit() {
    let mut parser = Parser {
        count: 0,
        mode: VideoMode::NativeAvc,
    };
    let many = (0..MAX_BOXES + 1)
        .flat_map(|_| boxed(b"free", vec![]))
        .collect::<Vec<_>>();
    assert!(matches!(
        parser.children(&many, 1),
        Err(ProbeError::TooLarge)
    ));
    assert!(matches!(
        parser.children(&[], MAX_DEPTH + 1),
        Err(ProbeError::Unsupported)
    ));
}

#[derive(Clone, Copy, Default)]
enum Fault {
    #[default]
    None,
    Status,
    MissingRange,
    WrongRange,
    UnknownTotal,
    WrongLength,
    Encoded,
    Truncated,
    Oversize,
    ChangedTotal,
    ChangedEtag,
    MissingEtag,
    ChangedDate,
    DuplicateRange,
    DuplicateLength,
    DuplicateEtag,
    InvalidEtag,
    WeakEtag,
    Delay,
    Transport,
}
struct FakeReader {
    bytes: Arc<Vec<u8>>,
    fault: Fault,
    fault_call: usize,
    requests: Mutex<Vec<RangeRequest>>,
}
impl FakeReader {
    fn new(bytes: Vec<u8>, fault: Fault, fault_call: usize) -> Self {
        Self {
            bytes: Arc::new(bytes),
            fault,
            fault_call,
            requests: Mutex::new(vec![]),
        }
    }
}
impl RangeReader for FakeReader {
    fn read<'a>(
        &'a self,
        request: RangeRequest,
    ) -> Pin<Box<dyn Future<Output = Result<RangeResponse>> + Send + 'a>> {
        Box::pin(async move {
            let call = {
                let mut requests = self.requests.lock().unwrap();
                requests.push(request.clone());
                requests.len()
            };
            let fault = if call == self.fault_call {
                self.fault
            } else {
                Fault::None
            };
            if matches!(fault, Fault::Transport) {
                return Err(ProbeError::Transport);
            }
            if matches!(fault, Fault::Delay) {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let mut status = 206;
            let mut headers = RangeHeaders {
                content_range: vec![format!(
                    "bytes {}-{}/{}",
                    request.range.start,
                    request.range.end,
                    self.bytes.len()
                )],
                content_length: vec![request.range.len()?.to_string()],
                content_encoding: vec![],
                etag: vec!["\"fixture\"".into()],
                last_modified: vec!["Sun, 04 Oct 2026 00:00:00 GMT".into()],
            };
            let mut body = self
                .bytes
                .get(request.range.start as usize..=request.range.end as usize)
                .ok_or(ProbeError::Transport)?
                .to_vec();
            match fault {
                Fault::Status => status = 200,
                Fault::MissingRange => headers.content_range.clear(),
                Fault::WrongRange => {
                    headers.content_range = vec![format!(
                        "bytes 0-{}/{}",
                        request.range.end,
                        self.bytes.len()
                    )]
                }
                Fault::UnknownTotal => {
                    headers.content_range = vec![format!(
                        "bytes {}-{}/*",
                        request.range.start, request.range.end
                    )]
                }
                Fault::WrongLength => headers.content_length = vec!["1".into()],
                Fault::Encoded => headers.content_encoding = vec!["gzip".into()],
                Fault::Truncated => {
                    body.pop();
                }
                Fault::Oversize => body.push(0),
                Fault::ChangedTotal => {
                    headers.content_range = vec![format!(
                        "bytes {}-{}/{}",
                        request.range.start,
                        request.range.end,
                        self.bytes.len() + 1
                    )]
                }
                Fault::ChangedEtag => headers.etag = vec!["\"changed\"".into()],
                Fault::MissingEtag => headers.etag.clear(),
                Fault::ChangedDate => {
                    headers.last_modified = vec!["Mon, 05 Oct 2026 00:00:00 GMT".into()]
                }
                Fault::DuplicateRange => {
                    headers.content_range.push(headers.content_range[0].clone())
                }
                Fault::DuplicateLength => headers
                    .content_length
                    .push(headers.content_length[0].clone()),
                Fault::DuplicateEtag => headers.etag.push(headers.etag[0].clone()),
                Fault::InvalidEtag => headers.etag = vec!["unquoted".into()],
                Fault::WeakEtag => headers.etag = vec!["W/\"fixture\"".into()],
                _ => {}
            }
            Ok(RangeResponse {
                status,
                headers,
                body,
            })
        })
    }
}
#[tokio::test]
async fn fake_transport_exact_ranges_bound_bytes_requests_and_deadline() {
    let reader = FakeReader::new(fixture(TrackKind::Video, 8192, 1), Fault::None, 0);
    let deadline = Instant::now() + Duration::from_secs(1);
    let result = probe(&reader, TrackKind::Video, deadline).await.unwrap();
    assert_eq!(result.strong_etag.as_deref(), Some("\"fixture\""));
    let requests = reader.requests.lock().unwrap();
    assert!(requests.len() <= MAX_PROBE_REQUESTS);
    assert!(requests.len() >= 2);
    let total: usize = requests.iter().map(|r| r.range.len().unwrap()).sum();
    assert!(total <= MAX_PROBE_BYTES);
    for request in requests.iter() {
        assert_eq!(request.deadline, deadline);
        assert_eq!(request.range.len().unwrap(), request.max_body_bytes);
    }
    for pair in requests.windows(2) {
        assert_eq!(pair[0].range.end + 1, pair[1].range.start);
        assert!(pair[1].expected.is_some());
    }
    assert_eq!(requests.last().unwrap().range.end, result.index.end);
}
#[tokio::test]
async fn fake_transport_rejects_response_and_validator_failures() {
    for fault in [
        Fault::Status,
        Fault::MissingRange,
        Fault::WrongRange,
        Fault::UnknownTotal,
        Fault::WrongLength,
        Fault::Encoded,
        Fault::Truncated,
        Fault::ChangedTotal,
        Fault::ChangedEtag,
        Fault::MissingEtag,
        Fault::ChangedDate,
        Fault::DuplicateRange,
        Fault::DuplicateLength,
        Fault::DuplicateEtag,
        Fault::InvalidEtag,
    ] {
        let reader = FakeReader::new(fixture(TrackKind::Video, 8192, 0), fault, 2);
        assert_eq!(
            probe(
                &reader,
                TrackKind::Video,
                Instant::now() + Duration::from_secs(1)
            )
            .await
            .unwrap_err(),
            ProbeError::InvalidResponse
        );
        assert_eq!(reader.requests.lock().unwrap().len(), 2); // No 200/full-file fallback or retry.
    }
    let reader = FakeReader::new(fixture(TrackKind::Video, 0, 0), Fault::Oversize, 1);
    assert_eq!(
        probe(
            &reader,
            TrackKind::Video,
            Instant::now() + Duration::from_secs(1)
        )
        .await
        .unwrap_err(),
        ProbeError::TooLarge
    );
}
#[tokio::test]
async fn fake_transport_preserves_only_strong_validators() {
    let reader = FakeReader::new(fixture(TrackKind::Audio, 0, 0), Fault::WeakEtag, 1);
    assert_eq!(
        probe(
            &reader,
            TrackKind::Audio,
            Instant::now() + Duration::from_secs(1)
        )
        .await
        .unwrap()
        .strong_etag,
        None
    );
}
#[tokio::test]
async fn fake_transport_timeouts_and_transport_errors_stop() {
    let reader = FakeReader::new(fixture(TrackKind::Video, 8192, 0), Fault::Delay, 2);
    let deadline = Instant::now() + Duration::from_millis(10);
    assert_eq!(
        probe(&reader, TrackKind::Video, deadline)
            .await
            .unwrap_err(),
        ProbeError::Deadline
    );
    assert_eq!(reader.requests.lock().unwrap().len(), 2);
    let reader = FakeReader::new(fixture(TrackKind::Video, 0, 0), Fault::Transport, 1);
    assert_eq!(
        probe(
            &reader,
            TrackKind::Video,
            Instant::now() + Duration::from_secs(1)
        )
        .await
        .unwrap_err(),
        ProbeError::Transport
    );
    let reader = FakeReader::new(fixture(TrackKind::Video, 0, 0), Fault::None, 0);
    assert_eq!(
        probe(
            &reader,
            TrackKind::Video,
            Instant::now() - Duration::from_millis(1)
        )
        .await
        .unwrap_err(),
        ProbeError::Deadline
    );
    assert!(reader.requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn request_count_and_aggregate_byte_limits_fail_without_unbounded_scan() {
    let ftyp = boxed(
        b"ftyp",
        [
            b"dash".to_vec(),
            0u32.to_be_bytes().to_vec(),
            b"iso6".to_vec(),
        ]
        .concat(),
    );
    // Valid boxes separated by large padding force repeated prefix reads. The
    // fixed ceiling wins instead of scanning indefinitely toward an index.
    let mut bytes = ftyp;
    for _ in 0..8 {
        bytes.extend(boxed(b"free", vec![0; 8192]));
    }
    bytes.extend(moov(TrackKind::Video, 0));
    bytes.extend(sidx(0, 4096));
    bytes.extend(fragment(1));
    bytes.extend(fragment(2));
    let reader = FakeReader::new(bytes, Fault::None, 0);
    assert_eq!(
        probe(
            &reader,
            TrackKind::Video,
            Instant::now() + Duration::from_secs(1)
        )
        .await
        .unwrap_err(),
        ProbeError::TooLarge
    );
    assert_eq!(reader.requests.lock().unwrap().len(), MAX_PROBE_REQUESTS);
    let bytes = fixture(TrackKind::Video, MAX_PROBE_BYTES, 0);
    let reader = FakeReader::new(bytes, Fault::None, 0);
    assert_eq!(
        probe(
            &reader,
            TrackKind::Video,
            Instant::now() + Duration::from_secs(1)
        )
        .await
        .unwrap_err(),
        ProbeError::TooLarge
    );
    assert_eq!(reader.requests.lock().unwrap().len(), 1);
}
#[test]
fn critical_headers_are_checked_before_body_and_ranges_do_not_wrap() {
    let request = RangeRequest {
        range: ByteRange { start: 0, end: 9 },
        deadline: Instant::now(),
        max_body_bytes: 10,
        expected: None,
    };
    let valid = RangeHeaders {
        content_range: vec!["bytes 0-9/100".into()],
        content_length: vec!["10".into()],
        ..Default::default()
    };
    assert_eq!(
        validate_range_headers(&request, 206, &valid)
            .unwrap()
            .total_bytes,
        100
    );
    assert_eq!(
        validate_range_headers(&request, 200, &valid).unwrap_err(),
        ProbeError::InvalidResponse
    );
    for range in [
        "bytes 0-9/*",
        "bytes 0-8/100",
        "bytes 0-9/9",
        "bytes 0-9/10, bytes 0-9/10",
        "bytes -1-9/100",
        "bytes 0-18446744073709551616/100",
    ] {
        let mut headers = valid.clone();
        headers.content_range = vec![range.into()];
        assert!(validate_range_headers(&request, 206, &headers).is_err());
    }
    assert!(ByteRange { start: 1, end: 0 }.len().is_err());
    assert!(
        ByteRange {
            start: 0,
            end: u64::MAX
        }
        .len()
        .is_err()
    );
    assert_eq!(request.range.header(), "bytes=0-9");
}

/// Rebuild fixture container sizes when modifying a nested sample/config box.
fn map_fixture_boxes(bytes: &[u8], target: &[u8; 4], modify: &dyn Fn(&[u8]) -> Vec<u8>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let (size, header, kind) = box_header(&bytes[at..]).unwrap();
        let payload = &bytes[at + header..at + size];
        let next = if &kind == target {
            modify(payload)
        } else {
            let fixed = match &kind {
                b"moov" | b"trak" | b"mdia" | b"minf" | b"dinf" | b"stbl" | b"mvex" => Some(0),
                b"stsd" => Some(8),
                b"avc1" => Some(78),
                b"mp4a" => Some(28),
                _ => None,
            };
            if let Some(fixed) = fixed {
                [
                    payload[..fixed].to_vec(),
                    map_fixture_boxes(&payload[fixed..], target, modify),
                ]
                .concat()
            } else {
                payload.to_vec()
            }
        };
        out.extend(boxed(&kind, next));
        at += size;
    }
    out
}
#[test]
fn square_pixels_optional_high_profile_extension_and_large_box_headers() {
    let base = fixture(TrackKind::Video, 0, 0);
    let square = map_fixture_boxes(&base, b"avc1", &|entry| {
        [
            entry.to_vec(),
            boxed(b"pasp", [1u32.to_be_bytes(), 1u32.to_be_bytes()].concat()),
        ]
        .concat()
    });
    assert_eq!(
        parsed(&square, TrackKind::Video).codec,
        parsed(&base, TrackKind::Video).codec
    );
    let stretched = map_fixture_boxes(&base, b"avc1", &|entry| {
        [
            entry.to_vec(),
            boxed(b"pasp", [4u32.to_be_bytes(), 3u32.to_be_bytes()].concat()),
        ]
        .concat()
    });
    unsupported(&stretched, TrackKind::Video);
    let high = map_fixture_boxes(&base, b"avcC", &|config| {
        [config.to_vec(), vec![0xfd, 0xf8, 0xf8, 0]].concat()
    });
    assert_eq!(
        parsed(&high, TrackKind::Video).codec,
        parsed(&base, TrackKind::Video).codec
    );
    let mut extended = 1u32.to_be_bytes().to_vec();
    let first_size = u32_at(&base, 0).unwrap() as usize;
    extended.extend(b"ftyp");
    extended.extend(((first_size + 8) as u64).to_be_bytes());
    extended.extend(&base[8..]);
    assert_eq!(
        parsed(&extended, TrackKind::Video).codec,
        parsed(&base, TrackKind::Video).codec
    );
}
#[test]
fn nested_encryption_edits_unknowns_and_tiny_parameter_sets_fail_closed() {
    for kind in [TrackKind::Video, TrackKind::Audio] {
        let base = fixture(kind, 0, 0);
        let sample = match kind {
            TrackKind::Video => b"avc1",
            TrackKind::Audio => b"mp4a",
        };
        let encrypted = map_fixture_boxes(&base, sample, &|entry| {
            [entry.to_vec(), boxed(b"sinf", vec![])].concat()
        });
        unsupported(&encrypted, kind);
        let edit = map_fixture_boxes(&base, b"trak", &|track| {
            [
                track.to_vec(),
                container(b"edts", vec![fullbox(b"elst", 0, vec![0; 4])]),
            ]
            .concat()
        });
        unsupported(&edit, kind);
        let unknown = map_fixture_boxes(&base, b"moov", &|movie| {
            [movie.to_vec(), boxed(b"zzzz", vec![])].concat()
        });
        unsupported(&unknown, kind);
    }
    let base = fixture(TrackKind::Video, 0, 0);
    let tiny = map_fixture_boxes(&base, b"avcC", &|_| {
        vec![1, 100, 0, 30, 0xff, 0xe1, 0, 1, 0x67, 1, 0, 1, 0x68]
    });
    unsupported(&tiny, TrackKind::Video);
    let conflicting = map_fixture_boxes(&base, b"avcC", &|config| {
        let mut out = config.to_vec();
        out[9] = 66;
        out
    });
    unsupported(&conflicting, TrackKind::Video);
}
#[test]
fn version_one_movie_track_and_media_headers_are_supported() {
    for kind in [TrackKind::Video, TrackKind::Audio] {
        let base = fixture(kind, 0, 1);
        let mvhd = map_fixture_boxes(&base, b"mvhd", &|v0| {
            let mut out = 0x01000000u32.to_be_bytes().to_vec();
            out.extend([0; 16]);
            out.extend(&v0[12..16]);
            out.extend([0; 8]);
            out.extend(&v0[20..]);
            out
        });
        let tkhd = map_fixture_boxes(&mvhd, b"tkhd", &|v0| {
            let mut out = 0x01000003u32.to_be_bytes().to_vec();
            out.extend([0; 16]);
            out.extend(&v0[12..20]);
            out.extend([0; 8]);
            out.extend(&v0[24..]);
            out
        });
        let mdhd = map_fixture_boxes(&tkhd, b"mdhd", &|v0| {
            let mut out = 0x01000000u32.to_be_bytes().to_vec();
            out.extend([0; 16]);
            out.extend(&v0[12..16]);
            out.extend([0; 8]);
            out.extend(&v0[20..]);
            out
        });
        assert_eq!(parsed(&mdhd, kind).codec, parsed(&base, kind).codec);
    }
}
#[tokio::test]
async fn cancellation_drops_inflight_reader_future_without_a_followup_request() {
    struct DropFlag(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    struct PendingReader {
        started: Arc<tokio::sync::Notify>,
        dropped: Arc<std::sync::atomic::AtomicBool>,
    }
    impl RangeReader for PendingReader {
        fn read<'a>(
            &'a self,
            _: RangeRequest,
        ) -> Pin<Box<dyn Future<Output = Result<RangeResponse>> + Send + 'a>> {
            Box::pin(async move {
                let _guard = DropFlag(self.dropped.clone());
                self.started.notify_one();
                std::future::pending().await
            })
        }
    }
    let started = Arc::new(tokio::sync::Notify::new());
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader = Arc::new(PendingReader {
        started: started.clone(),
        dropped: dropped.clone(),
    });
    let handle = tokio::spawn(async move {
        probe(
            &*reader,
            TrackKind::Video,
            Instant::now() + Duration::from_secs(1),
        )
        .await
    });
    started.notified().await;
    handle.abort();
    assert!(handle.await.unwrap_err().is_cancelled());
    assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn debug_output_excludes_opaque_entity_tags_and_dates() {
    let mut result = parsed(&fixture(TrackKind::Video, 0, 0), TrackKind::Video);
    result.strong_etag = Some("\"https://signed.invalid/private-marker\"".into());
    assert!(!format!("{result:?}").contains("private-marker"));
    let identity = RangeIdentity {
        total_bytes: 10000,
        etag: result.strong_etag,
        last_modified: Some("private-date-marker".into()),
    };
    let request = RangeRequest {
        range: ByteRange { start: 0, end: 9 },
        deadline: Instant::now(),
        max_body_bytes: 10,
        expected: Some(identity),
    };
    let debug = format!("{request:?}");
    assert!(!debug.contains("private-marker"));
    assert!(!debug.contains("private-date-marker"));
}
#[test]
fn hostile_mutations_never_panic_or_request_an_unbounded_prefix() {
    for kind in [TrackKind::Video, TrackKind::Audio] {
        let base = fixture(kind, 0, 1);
        let mut seed = 0x9e3779b97f4a7c15u64;
        for _ in 0..4096 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let mut bytes = base.clone();
            let at = seed as usize % bytes.len();
            bytes[at] = ((seed >> 24) & 255) as u8;
            match parse_prefix(&bytes, bytes.len() as u64, kind) {
                Ok(Prefix::Need(end)) => assert!(end <= MAX_PROBE_BYTES),
                Ok(Prefix::Complete(result)) => {
                    assert!(result.initialization.end < result.index.start);
                    assert!(result.index.end < result.total_bytes);
                    assert!(
                        result
                            .segments
                            .iter()
                            .all(|segment| segment.range.start <= segment.range.end
                                && segment.range.end < result.total_bytes)
                    );
                }
                Err(_) => {}
            }
        }
    }
}

#[tokio::test]
async fn synchronously_late_response_cannot_return_success_after_deadline() {
    struct LateReader(FakeReader);
    impl RangeReader for LateReader {
        fn read<'a>(
            &'a self,
            request: RangeRequest,
        ) -> Pin<Box<dyn Future<Output = Result<RangeResponse>> + Send + 'a>> {
            Box::pin(async move {
                let response = self.0.read(request).await?;
                // A ready future may monopolize one poll past the timer's due
                // instant. The post-parse absolute check must forbid success.
                std::thread::sleep(Duration::from_millis(20));
                Ok(response)
            })
        }
    }
    let reader = LateReader(FakeReader::new(
        fixture(TrackKind::Video, 0, 0),
        Fault::None,
        0,
    ));
    assert_eq!(
        probe(
            &reader,
            TrackKind::Video,
            Instant::now() + Duration::from_millis(5)
        )
        .await
        .unwrap_err(),
        ProbeError::Deadline
    );
}

#[test]
fn initialization_only_derives_codec_facts_without_index_or_media() {
    for kind in [TrackKind::Audio, TrackKind::Video] {
        let body = fixture(kind, 0, 0);
        let expected = parsed(&body, kind);
        let init = &body[..=expected.initialization.end as usize];
        let facts = parse_initialization(init, kind).unwrap();
        assert_eq!(facts.track_id, expected.track_id);
        assert_eq!(facts.codec, expected.codec);
        assert!(parse_initialization(&body, kind).is_err());
        assert!(parse_initialization(&init[..init.len() - 1], kind).is_err());
        let wrong_kind = if kind == TrackKind::Audio {
            TrackKind::Video
        } else {
            TrackKind::Audio
        };
        assert!(parse_initialization(init, wrong_kind).is_err());
    }
}

#[test]
fn initialization_only_rejects_duplicate_protected_and_unbounded_structure() {
    let body = fixture(TrackKind::Audio, 0, 0);
    let end = parsed(&body, TrackKind::Audio).initialization.end as usize;
    let init = body[..=end].to_vec();
    let mut duplicate = init.clone();
    duplicate.extend(moov(TrackKind::Audio, 0));
    assert!(parse_initialization(&duplicate, TrackKind::Audio).is_err());
    let mut protected = init.clone();
    protected.extend(boxed(b"pssh", vec![0; 32]));
    assert!(parse_initialization(&protected, TrackKind::Audio).is_err());
    let mut protected = init.clone();
    let entry = payload_at(&protected, b"mp4a") - 4;
    protected[entry..entry + 4].copy_from_slice(b"enca");
    assert!(parse_initialization(&protected, TrackKind::Audio).is_err());
    assert!(parse_initialization(&vec![0; MAX_PROBE_BYTES + 1], TrackKind::Audio).is_err());
    assert!(parse_initialization(&moov(TrackKind::Audio, 0), TrackKind::Audio).is_err());
}

// Pure configuration fixtures. These do not assert complete HEVC syntax/sample
// decoding; no extractor, media process, network or listener is started.
struct HevcBits(Vec<bool>);
impl HevcBits {
    fn push(&mut self, value: u32, count: usize) {
        for shift in (0..count).rev() {
            self.0.push((value >> shift) & 1 != 0);
        }
    }
    fn ue(&mut self, value: u32) {
        let coded = value + 1;
        let bits = (32 - coded.leading_zeros()) as usize;
        self.push(0, bits - 1);
        self.push(coded, bits);
    }
    fn finish(mut self) -> Vec<u8> {
        self.0.push(true); // trailing-bit framing of this synthetic prefix
        while !self.0.len().is_multiple_of(8) {
            self.0.push(false);
        }
        let raw = self
            .0
            .chunks(8)
            .map(|bits| bits.iter().fold(0u8, |n, b| (n << 1) | u8::from(*b)))
            .collect::<Vec<_>>();
        let mut escaped = Vec::new();
        let mut zeros = 0;
        for byte in raw {
            if zeros >= 2 && byte <= 3 {
                escaped.push(3);
                zeros = 0;
            }
            escaped.push(byte);
            zeros = if byte == 0 { zeros + 1 } else { 0 };
        }
        escaped
    }
}
fn hevc_entry(prefix: &[u8; 4]) -> Vec<u8> {
    hevc_entry_with_depth(prefix, false)
}
fn hevc_entry_with_depth(prefix: &[u8; 4], ten: bool) -> Vec<u8> {
    let avc = sample_entry(TrackKind::Video);
    let mut entry = avc[8..86].to_vec();
    let mut config = vec![
        1, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f,
        3,
    ];
    if ten {
        config[1] = 2;
        config[2] = 0x20;
        config[6] = 0xb0;
        config[17] = 0xfa;
        config[18] = 0xfa;
    }
    let ptl = config[1..13].to_vec();
    let mut vps = HevcBits(vec![]);
    vps.push(0, 4);
    vps.push(3, 2);
    vps.push(0, 6);
    vps.push(0, 3);
    vps.push(1, 1);
    vps.push(0xffff, 16);
    for &byte in &ptl {
        vps.push(u32::from(byte), 8);
    }
    let mut sps = HevcBits(vec![]);
    sps.push(0, 4);
    sps.push(0, 3);
    sps.push(1, 1);
    for &byte in &ptl {
        sps.push(u32::from(byte), 8);
    }
    sps.ue(0);
    sps.ue(1);
    sps.ue(640);
    sps.ue(360);
    sps.push(0, 1);
    sps.ue(if ten { 2 } else { 0 });
    sps.ue(if ten { 2 } else { 0 });
    let mut pps = HevcBits(vec![]);
    pps.ue(0);
    pps.ue(0);
    for (kind, payload) in [(32, vps.finish()), (33, sps.finish()), (34, pps.finish())] {
        config.push(0x80 | kind);
        config.extend(1u16.to_be_bytes());
        config.extend(((payload.len() + 2) as u16).to_be_bytes());
        config.extend([kind << 1, 1]);
        config.extend(payload);
    }
    entry.extend(boxed(b"hvcC", config));
    if ten {
        entry.extend(boxed(
            b"colr",
            [
                b"nclx".to_vec(),
                1u16.to_be_bytes().to_vec(),
                1u16.to_be_bytes().to_vec(),
                1u16.to_be_bytes().to_vec(),
                vec![0],
            ]
            .concat(),
        ));
    }
    boxed(prefix, entry)
}
fn hevc_fixture(prefix: &[u8; 4]) -> Vec<u8> {
    [
        boxed(
            b"ftyp",
            [b"dash".to_vec(), vec![0; 4], b"iso6mp41".to_vec()].concat(),
        ),
        moov_with_entry(TrackKind::Video, 0, hevc_entry(prefix)),
        sidx(0, 4096),
        fragment(1),
        fragment(2),
    ]
    .concat()
}
fn hevc_parsed(bytes: &[u8]) -> Result<Prefix> {
    parse_prefix_with_mode(
        bytes,
        bytes.len() as u64,
        TrackKind::Video,
        VideoMode::ClearHevcCompatibility,
    )
}
#[test]
fn hevc_configuration_is_explicit_and_preserves_sample_entry_codec() {
    for prefix in [b"hev1", b"hvc1"] {
        let bytes = hevc_fixture(prefix);
        assert!(
            parse_initialization(&bytes[..payload_at(&bytes, b"sidx") - 8], TrackKind::Video)
                .is_err()
        );
        unsupported(&bytes, TrackKind::Video);
        let Prefix::Complete(probe) = hevc_parsed(&bytes).unwrap() else {
            panic!("incomplete");
        };
        assert_eq!(
            probe.codec,
            Codec::Hevc {
                rfc6381: format!("{}.1.6.L93.90", std::str::from_utf8(prefix).unwrap()),
                width: 640,
                height: 360
            }
        );
        assert_eq!(probe.duration_ticks, 4000);
    }
    assert!(valid_clear_hevc_codec("hev1.1.6.L120.90"));
    assert!(valid_clear_hevc_codec("hev1.2.4.L120.B0"));
    for codec in [
        "av01.0.08M.08",
        "hev1.1.6.H120.90",
        "hev1.1.6.L0120.90",
        "hev1.1.6.L120.90.0",
        "hvc1",
        "hev1.1.6.L120.C0",
    ] {
        assert!(!valid_clear_hevc_codec(codec));
    }
}
#[test]
fn hevc_configuration_rejects_missing_mismatched_protected_and_unbounded_facts() {
    let bytes = hevc_fixture(b"hev1");
    let at = payload_at(&bytes, b"hvcC");
    for (offset, value) in [
        (0, 0),
        (1, 2),
        (6, 0xd0),
        (12, 255),
        (16, 0xfc),
        (17, 0xf9),
        (18, 0xf9),
        (21, 0x17),
        (22, 2),
        (23, 32),
        (24, 1),
        (25, 2),
        (28, 0x42),
        (29, 2),
    ] {
        let mut changed = bytes.clone();
        changed[at + offset] = value;
        assert!(hevc_parsed(&changed).is_err(), "offset {offset}");
    }
    // SPS/VPS PTL disagreement, declaration geometry disagreement, and an
    // encrypted sample entry cannot enter even the explicit compatibility path.
    let mut changed = bytes.clone();
    changed[at + 32] ^= 1;
    assert!(hevc_parsed(&changed).is_err());
    let mut changed = bytes.clone();
    let entry = payload_at(&changed, b"hev1");
    put16(&mut changed, entry + 24, 639);
    assert!(hevc_parsed(&changed).is_err());
    let mut changed = bytes.clone();
    changed[entry - 4..entry].copy_from_slice(b"encv");
    assert!(hevc_parsed(&changed).is_err());
    let mut parser = Parser {
        count: 0,
        mode: VideoMode::ClearHevcCompatibility,
    };
    let entry = hevc_entry(b"hev1");
    for end in 0..entry.len() - 8 {
        assert!(hevc::parse_hevc(&mut parser, &entry[8..8 + end], *b"hev1").is_err());
        parser.count = 0;
    }
}
#[tokio::test]
async fn explicit_hevc_probe_retains_exact_ranges_identity_budget_and_deadline() {
    let bytes = hevc_fixture(b"hev1");
    let reader = FakeReader::new(bytes.clone(), Fault::None, 0);
    let result = probe_clear_hevc_compatibility(
        &reader,
        TrackKind::Video,
        Instant::now() + Duration::from_secs(1),
    )
    .await
    .unwrap();
    assert!(matches!(result.codec, Codec::Hevc { .. }));
    assert!(reader.requests.lock().unwrap().len() <= MAX_PROBE_REQUESTS);
    assert_eq!(
        probe_clear_hevc_compatibility(&reader, TrackKind::Video, Instant::now())
            .await
            .unwrap_err(),
        ProbeError::Deadline
    );
    assert!(
        probe(
            &reader,
            TrackKind::Video,
            Instant::now() + Duration::from_secs(1)
        )
        .await
        .is_err()
    );
}

#[test]
fn hevc_configuration_mutations_never_panic_or_expand_the_probe_boundary() {
    let bytes = hevc_fixture(b"hev1");
    let through_index = payload_at(&bytes, b"sidx") - 8 + sidx(0, 4096).len();
    for at in 0..through_index {
        let mut changed = bytes.clone();
        changed[at] ^= 0xa5;
        let result = std::panic::catch_unwind(|| hevc_parsed(&changed));
        let parsed = result.expect("bounded HEVC parsing must not panic");
        if let Ok(Prefix::Need(end)) = parsed {
            assert!(end <= MAX_PROBE_BYTES && end as u64 <= bytes.len() as u64);
        }
    }
}

fn extended_fixture(entry: Vec<u8>) -> Vec<u8> {
    [
        boxed(
            b"ftyp",
            [b"dash".to_vec(), vec![0; 4], b"iso6mp41".to_vec()].concat(),
        ),
        moov_with_entry(TrackKind::Video, 0, entry),
        sidx(0, 4096),
        fragment(1),
        fragment(2),
    ]
    .concat()
}
fn av1_vp9_entry(av1: bool, ten: bool) -> Vec<u8> {
    let native = sample_entry(TrackKind::Video);
    let mut entry = native[8..86].to_vec();
    if av1 {
        entry.extend(boxed(
            b"av1C",
            vec![0x81, 5, if ten { 0x4c } else { 0x0c }, 0],
        ));
        entry.extend(boxed(
            b"colr",
            [
                b"nclx".to_vec(),
                1u16.to_be_bytes().to_vec(),
                1u16.to_be_bytes().to_vec(),
                1u16.to_be_bytes().to_vec(),
                vec![0],
            ]
            .concat(),
        ));
    } else {
        entry.extend(fullbox(
            b"vpcC",
            0x01000000,
            vec![
                if ten { 2 } else { 0 },
                41,
                if ten { 0xa2 } else { 0x82 },
                1,
                1,
                1,
                0,
                0,
            ],
        ));
    }
    boxed(if av1 { b"av01" } else { b"vp09" }, entry)
}
#[test]
fn private_extended_configuration_reaches_real_codec_family_without_broadening_native() {
    for ten in [false, true] {
        for av1 in [false, true] {
            let bytes = extended_fixture(av1_vp9_entry(av1, ten));
            let Prefix::Complete(probe) = hevc_parsed(&bytes).unwrap() else {
                panic!("fixture complete")
            };
            assert!(matches!(probe.codec, Codec::Av1 { .. } | Codec::Vp9 { .. }));
            assert!(parse_prefix(&bytes, bytes.len() as u64, TrackKind::Video).is_err());
            let config = if av1 { b"av1C" } else { b"vpcC" };
            let at = bytes.windows(4).position(|v| v == config).unwrap() + 4;
            let mut bad = bytes.clone();
            bad[at] = 0;
            assert!(hevc_parsed(&bad).is_err());
        }
    }
    let bytes = extended_fixture(hevc_entry_with_depth(b"hvc1", true));
    let Prefix::Complete(probe) = hevc_parsed(&bytes).unwrap() else {
        panic!("fixture complete")
    };
    assert!(matches!(probe.codec,Codec::HevcMain10{rfc6381,..}if rfc6381=="hvc1.2.4.L93.B0"));
    assert!(parse_prefix(&bytes, bytes.len() as u64, TrackKind::Video).is_err());
}
