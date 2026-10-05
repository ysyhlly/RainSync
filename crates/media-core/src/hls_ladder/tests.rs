use super::*;
use serde_json::{Value, json};

// Synthetic MP4/probe records exercise content contracts only. They are not
// decoder evidence and cannot establish production readiness or GPU support.
fn source(width: u32, height: u32, audio: bool) -> Value {
    let mut rows = vec![
        json!({"index":0,"codec_type":"video","codec_name":"h264","width":width,"height":height,"pix_fmt":"yuv420p","sample_aspect_ratio":"1:1","r_frame_rate":"30/1","avg_frame_rate":"30/1","disposition":{"attached_pic":0}}),
    ];
    if audio {
        rows.push(json!({"index":1,"codec_type":"audio","codec_name":"aac"}));
    }
    json!({"streams":rows})
}
fn identity() -> AttemptIdentity {
    AttemptIdentity {
        recipe_version: 1,
        attempt_id: "00000000-0000-0000-0000-000000000001".into(),
        source_generation: 5,
        plan_generation: 7,
    }
}
fn playlist(count: usize, ended: bool) -> String {
    let mut text = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-INDEPENDENT-SEGMENTS\n".to_owned();
    for i in 0..count {
        text.push_str(&format!("#EXTINF:4.000000,\nindex{i}.m4s\n"));
    }
    if ended {
        text.push_str("#EXT-X-ENDLIST\n");
    }
    text
}
fn boxed(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    [
        ((data.len() + 8) as u32).to_be_bytes().to_vec(),
        kind.to_vec(),
        data.to_vec(),
    ]
    .concat()
}
fn word(data: &mut [u8], at: usize, value: u32) {
    data[at..at + 4].copy_from_slice(&value.to_be_bytes());
}
fn avc(r: &Rendition) -> Vec<u8> {
    let level = if r.id == RenditionId::High { 40 } else { 31 };
    vec![
        1, 100, 0, level, 255, 225, 0, 4, 103, 100, 0, level, 1, 0, 2, 104, 0, 253, 248, 248, 0,
    ]
}
fn desc(tag: u8, data: &[u8]) -> Vec<u8> {
    [vec![tag, data.len() as u8], data.to_vec()].concat()
}
fn track(r: &Rendition, audio: bool) -> Vec<u8> {
    let id = if audio { 2 } else { 1 };
    let mut tkhd = vec![0; 84];
    word(&mut tkhd, 12, id);
    let mut mdhd = vec![0; 24];
    word(&mut mdhd, 12, if audio { 48_000 } else { 30_000 });
    let mut hdlr = vec![0; 12];
    hdlr[8..12].copy_from_slice(if audio { b"soun" } else { b"vide" });
    let mut entry = vec![0; if audio { 28 } else { 78 }];
    entry[7] = 1;
    if audio {
        entry[16..18].copy_from_slice(&2u16.to_be_bytes());
        word(&mut entry, 24, 48_000 * 65536);
        let mut decoder = vec![0; 13];
        decoder[0] = 0x40;
        decoder[1] = 0x15;
        decoder.extend(desc(5, &[0x11, 0x90]));
        let es = [vec![0, 2, 0], desc(4, &decoder), desc(6, &[2])].concat();
        entry.extend(boxed(b"esds", &[vec![0; 4], desc(3, &es)].concat()));
    } else {
        entry[24..26].copy_from_slice(&(r.width as u16).to_be_bytes());
        entry[26..28].copy_from_slice(&(r.height as u16).to_be_bytes());
        entry.extend(boxed(b"avcC", &avc(r)));
        entry.extend(boxed(b"colr", b"nclx\0\x01\0\x01\0\x01\0"));
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
    word(&mut edit, 12, if audio { 1024 } else { 0 });
    word(&mut edit, 16, 65536);
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
fn init(r: &Rendition) -> Vec<u8> {
    let mut moov = boxed(b"mvhd", &[0; 100]);
    moov.extend(track(r, false));
    if r.audio_bitrate.is_some() {
        moov.extend(track(r, true));
    }
    let mut mvex = Vec::new();
    for id in 1..=if r.audio_bitrate.is_some() { 2 } else { 1 } {
        let mut trex = vec![0; 24];
        word(&mut trex, 4, id);
        word(&mut trex, 8, 1);
        mvex.extend(boxed(b"trex", &trex));
    }
    moov.extend(boxed(b"mvex", &mvex));
    [boxed(b"ftyp", b"iso6\0\0\0\0iso6"), boxed(b"moov", &moov)].concat()
}
fn traf(id: u32, start: u64, count: usize, duration: u32, size: u32, offset: u32) -> Vec<u8> {
    let mut tfhd = vec![0; 20];
    word(&mut tfhd, 0, 0x20038);
    word(&mut tfhd, 4, id);
    word(&mut tfhd, 8, duration);
    word(&mut tfhd, 12, size);
    word(&mut tfhd, 16, 0x01010000);
    let tfdt = [vec![1, 0, 0, 0], start.to_be_bytes().to_vec()].concat();
    let mut trun = vec![0; 16];
    word(&mut trun, 0, 0x305);
    word(&mut trun, 4, count as u32);
    word(&mut trun, 8, offset);
    word(&mut trun, 12, 0x02000000);
    for _ in 0..count {
        trun.extend(duration.to_be_bytes());
        trun.extend(size.to_be_bytes());
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
fn fragment(r: &Rendition, index: usize) -> Vec<u8> {
    let build = |offset| {
        let mut mfhd = vec![0; 8];
        word(&mut mfhd, 4, index as u32 + 1);
        let mut data = boxed(b"mfhd", &mfhd);
        data.extend(traf(1, index as u64 * 120000, 120, 1000, 6, offset));
        if r.audio_bitrate.is_some() {
            data.extend(traf(
                2,
                index as u64 * 188 * 1024,
                188,
                1024,
                4,
                offset + 720,
            ));
        }
        boxed(b"moof", &data)
    };
    let length = build(0).len();
    let mut data = Vec::new();
    for i in 0..120 {
        data.extend([0, 0, 0, 2, if i == 0 { 0x65 } else { 0x41 }, 0]);
    }
    if r.audio_bitrate.is_some() {
        data.extend(vec![0; 188 * 4]);
    }
    [build(length as u32 + 8), boxed(b"mdat", &data)].concat()
}
fn dump(data: &[u8]) -> String {
    format!(
        "\n00000000: {}  synthetic",
        data.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
fn probe(r: &Rendition) -> Value {
    let mut streams = vec![
        json!({"index":0,"codec_type":"video","codec_name":"h264","codec_tag_string":"avc1","pix_fmt":"yuv420p","width":r.width,"height":r.height,"sample_aspect_ratio":"1:1","r_frame_rate":"30/1","has_b_frames":0,"time_base":"1/30000","extradata":dump(&avc(r))}),
    ];
    let mut records = Vec::new();
    for i in 0..120 {
        let pts = i * 1000;
        records.push(json!({"type":"packet","stream_index":0,"pts":pts,"dts":pts,"size":"6"}));
        records.push(json!({"type":"frame","stream_index":0,"pts":pts,"best_effort_timestamp":pts,"width":r.width,"height":r.height,"key_frame":if i == 0 { 1 } else { 0 }}));
    }
    if r.audio_bitrate.is_some() {
        streams.push(json!({"index":1,"codec_type":"audio","codec_name":"aac","profile":"LC","channels":2,"sample_rate":"48000","time_base":"1/48000","extradata":dump(&[0x11,0x90])}));
        for i in 0..188 {
            let pts = i * 1024 - 1024;
            records.push(json!({"type":"packet","stream_index":1,"pts":pts,"dts":pts,"size":"4"}));
            records.push(json!({"type":"frame","stream_index":1,"pts":pts,"best_effort_timestamp":pts,"nb_samples":1024}));
        }
    }
    json!({"streams":streams,"packets_and_frames":records})
}
fn qualified(recipe: &LadderRecipe, id: RenditionId, text: &str) -> QualifiedRendition {
    let r = recipe.rendition(id).unwrap();
    qualify_rendition(
        recipe,
        id,
        &identity(),
        text,
        &init(r),
        &fragment(r, 0),
        &probe(r),
    )
    .unwrap()
}

#[test]
fn finite_ladder_preserves_source_geometry_without_upscaling() {
    let large = LadderRecipe::from_probe(&source(1920, 1080, true), None, 0.0).unwrap();
    assert_eq!(
        large
            .renditions()
            .iter()
            .map(|r| (r.width, r.height))
            .collect::<Vec<_>>(),
        vec![(640, 360), (1280, 720), (1920, 1080)]
    );
    let tiny = LadderRecipe::from_probe(&source(320, 240, false), None, 0.0).unwrap();
    assert_eq!(tiny.renditions().len(), 1);
    assert_eq!(
        (tiny.renditions()[0].width, tiny.renditions()[0].height),
        (320, 240)
    );
    for (width, height) in [(1920, 800), (1080, 1920), (641, 361), (720, 576)] {
        let recipe = LadderRecipe::from_probe(&source(width, height, false), None, 0.0).unwrap();
        assert!(recipe.renditions().iter().all(|r| r.width <= width
            && r.height <= height
            && r.width % 2 == 0
            && r.height % 2 == 0));
    }
}
#[test]
fn separate_recipe_refuses_hdr_drm_and_unhandled_transforms() {
    for (key, value) in [
        ("color_transfer", json!("smpte2084")),
        ("sample_aspect_ratio", json!("4:3")),
        ("codec_tag_string", json!("encv")),
    ] {
        let mut m = source(1920, 1080, false);
        m["streams"][0][key] = value;
        assert!(LadderRecipe::from_probe(&m, None, 0.0).is_err());
    }
    let mut m = source(1920, 1080, false);
    m["streams"][0]["side_data_list"] = json!([{"side_data_type":"Display Matrix","rotation":90}]);
    assert!(LadderRecipe::from_probe(&m, None, 0.0).is_err());
    assert!(LadderRecipe::from_probe(&source(1920, 1080, false), None, f64::NAN).is_err());
}
#[test]
fn closed_resources_reject_traversal_external_encoded_and_noncanonical_uris() {
    for bad in [
        "../master.m3u8",
        "https://evil/index.m3u8",
        "//evil/index.m3u8",
        "low/../high/index.m3u8",
        "low%2findex.m3u8",
        "low/index01.m4s",
        "low/index0.m4s?q=x",
        "low/index20000.m4s",
        "low/init.mp4/extra",
        "other/index.m3u8",
    ] {
        assert!(Resource::parse(bad).is_err(), "{bad}");
    }
    for path in [
        "master.m3u8",
        "low/index.m3u8",
        "medium/init.mp4",
        "high/index0.m4s",
    ] {
        assert_eq!(Resource::parse(path).unwrap().path(), path);
    }
}
#[test]
fn media_parser_rejects_unknown_keys_discontinuities_and_unsafe_timeline() {
    let text = playlist(2, true);
    assert_eq!(
        parse_media_playlist(&text).unwrap().duration_us(),
        8_000_000
    );
    for malicious in [
        text.replace("init.mp4", "../init.mp4"),
        text.replace("index0.m4s", "https://evil/0.m4s"),
        text.replace("index0.m4s", "index00.m4s"),
        text.replace(
            "#EXTINF:4.000000,",
            "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXTINF:4.000000,",
        ),
        text.replace(
            "#EXTINF:4.000000,",
            "#EXT-X-DISCONTINUITY\n#EXTINF:4.000000,",
        ),
        text.replace("4.000000", "3.000000"),
        text.replace("#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-MEDIA-SEQUENCE:1"),
    ] {
        assert!(parse_media_playlist(&malicious).is_err());
    }
    assert!(parse_media_playlist(&text[..text.len() - 1]).is_err());
}
#[test]
fn aggregate_reservation_counts_all_video_and_duplicated_audio() {
    let recipe = LadderRecipe::from_probe(&source(1920, 1080, true), None, 10.0).unwrap();
    let rates: u64 = recipe
        .renditions()
        .iter()
        .map(|r| u64::from(r.bandwidth))
        .sum();
    assert_eq!(
        recipe.estimated_output_bytes(Some(20_000.0)),
        Some(rates * 10 / 8 + 3 * 65536)
    );
    for duration in [
        None,
        Some(0.0),
        Some(10_000.0),
        Some(f64::INFINITY),
        Some(100_000_000.0),
    ] {
        assert_eq!(recipe.estimated_output_bytes(duration), None);
    }
}
#[test]
fn initial_qualification_clips_uneven_progress_to_one_complete_fragment() {
    let recipe = LadderRecipe::from_probe(&source(1920, 1080, true), None, 0.0).unwrap();
    let renditions = recipe
        .renditions()
        .iter()
        .enumerate()
        .map(|(i, r)| qualified(&recipe, r.id, &playlist(i + 1, false)))
        .collect();
    let ladder = qualify_ladder(&recipe, &identity(), renditions).unwrap();
    assert_eq!(ladder.available_through(), 0);
    let master = parse_master(&ladder.master_text()).unwrap();
    assert_eq!(master.variants.len(), 3);
    for r in recipe.renditions() {
        let text = ladder.media_playlist_text(r.id).unwrap();
        assert_eq!(parse_media_playlist(&text).unwrap().segments.len(), 1);
        assert!(!text.contains("ENDLIST"));
    }
}
#[test]
fn append_refresh_and_common_prefix_are_monotonic() {
    let recipe = LadderRecipe::from_probe(&source(1920, 1080, false), None, 0.0).unwrap();
    let mut rungs: Vec<_> = recipe
        .renditions()
        .iter()
        .map(|r| qualified(&recipe, r.id, &playlist(1, false)))
        .collect();
    for rung in &mut rungs {
        let r = recipe.rendition(rung.id()).unwrap();
        rung.refresh_playlist(&playlist(2, true)).unwrap();
        rung.append_fragment(&recipe, &init(r), &fragment(r, 1))
            .unwrap();
        assert!(rung.refresh_playlist(&playlist(1, false)).is_err());
    }
    let ladder = qualify_ladder(&recipe, &identity(), rungs).unwrap();
    assert_eq!(ladder.available_through(), 1);
    assert!(ladder.common_playlist().complete);
    assert!(
        ladder
            .media_playlist_text(RenditionId::Low)
            .unwrap()
            .contains("ENDLIST")
    );
}
#[test]
fn master_refuses_missing_rungs_mixed_generations_and_unknown_uris() {
    let recipe = LadderRecipe::from_probe(&source(1920, 1080, false), None, 0.0).unwrap();
    assert!(
        qualify_ladder(
            &recipe,
            &identity(),
            vec![qualified(&recipe, RenditionId::Low, &playlist(1, false))]
        )
        .is_err()
    );
    let mut rungs: Vec<_> = recipe
        .renditions()
        .iter()
        .map(|r| qualified(&recipe, r.id, &playlist(1, false)))
        .collect();
    let mut other = identity();
    other.plan_generation += 1;
    let r = recipe.rendition(RenditionId::High).unwrap();
    rungs[2] = qualify_rendition(
        &recipe,
        r.id,
        &other,
        &playlist(1, false),
        &init(r),
        &fragment(r, 0),
        &probe(r),
    )
    .unwrap();
    assert!(qualify_ladder(&recipe, &identity(), rungs).is_err());
    let master = MasterPlaylist {
        variants: vec![MasterVariant {
            id: RenditionId::Low,
            bandwidth: 1_250_000,
            width: 640,
            height: 360,
            codecs: "avc1.64001F".into(),
        }],
    }
    .render();
    for bad in [
        master.replace("low/index.m3u8", "../high/index.m3u8"),
        master.replace("low/index.m3u8", "https://evil/low/index.m3u8"),
        master.replace("CODECS=", "URI=\"key\",CODECS="),
        master.replace("640x360", "0x0"),
    ] {
        assert!(parse_master(&bad).is_err());
    }
}
#[test]
fn structural_idr_and_decoder_records_cannot_be_faked_by_headers_only() {
    let recipe = LadderRecipe::from_probe(&source(640, 360, false), None, 0.0).unwrap();
    let r = &recipe.renditions()[0];
    let mut bytes = fragment(r, 0);
    let idr = bytes
        .windows(6)
        .position(|w| w == [0, 0, 0, 2, 0x65, 0])
        .unwrap();
    bytes[idr + 4] = 0x41;
    assert!(validate_first_fragment(&recipe, r.id, &init(r), &bytes, 4_000_000).is_err());
    let mut p = probe(r);
    p["packets_and_frames"] = json!([]);
    assert!(
        qualify_rendition(
            &recipe,
            r.id,
            &identity(),
            &playlist(1, false),
            &init(r),
            &fragment(r, 0),
            &p
        )
        .is_err()
    );
    let mut p = probe(r);
    p["packets_and_frames"][0]["pts"] = json!(1);
    assert!(
        qualify_rendition(
            &recipe,
            r.id,
            &identity(),
            &playlist(1, false),
            &init(r),
            &fragment(r, 0),
            &p
        )
        .is_err()
    );
    let mut p = probe(r);
    p["streams"][0]["extradata"] = json!(dump(&[1, 100, 0, 31, 0, 0, 0]));
    assert!(
        qualify_rendition(
            &recipe,
            r.id,
            &identity(),
            &playlist(1, false),
            &init(r),
            &fragment(r, 0),
            &p
        )
        .is_err()
    );
}
#[test]
fn recipe_is_explicit_software_and_separate_output_directories() {
    let recipe = LadderRecipe::from_probe(&source(1920, 1080, true), None, 0.0).unwrap();
    let inventory = crate::advanced_media::Inventory::from_reports(
        " V..... libx264 software\n A..... aac audio",
        " ... scale V->V\n ... setsar V->V",
        "",
        "ffmpeg version fixture",
        crate::advanced_media::DeviceObservation {
            nvenc_device_present: false,
            vaapi_render_node: None,
            qsv_render_node: None,
        },
    )
    .unwrap();
    let input = crate::advanced_media::WorkerGatewayInput::new("http://127.0.0.1:8081/media-delivery/00000000-0000-0000-0000-000000000001/source?token=t&execution=e").unwrap();
    let args = recipe
        .ffmpeg_args(
            crate::advanced_media::Input::WorkerGateway(&input),
            std::path::Path::new("/attempt"),
            &inventory,
            false,
        )
        .unwrap();
    assert_eq!(args.iter().filter(|s| s.as_str() == "libx264").count(), 3);
    assert!(
        !args
            .iter()
            .any(|s| s.contains("var_stream_map") || s.contains("nvenc"))
    );
    for id in RenditionId::ALL {
        assert!(args.contains(&format!("/attempt/{}/index.m3u8", id.as_str())));
    }
    assert_eq!(
        args.iter()
            .filter(|s| s.as_str() == "expr:gte(t,n_forced*4)")
            .count(),
        3
    );
}

#[test]
fn recipe_binding_includes_audio_and_position_not_just_probe_headers() {
    let recipe = LadderRecipe::from_probe(&source(1920, 1080, false), None, 0.0).unwrap();
    let later = LadderRecipe::from_probe(&source(1920, 1080, false), None, 5.0).unwrap();
    assert_eq!(recipe.source_sha256(), later.source_sha256());
    assert_ne!(recipe.recipe_sha256(), later.recipe_sha256());
    let mut rungs: Vec<_> = recipe
        .renditions()
        .iter()
        .map(|r| qualified(&recipe, r.id, &playlist(1, false)))
        .collect();
    rungs[2] = qualified(&later, RenditionId::High, &playlist(1, false));
    assert!(qualify_ladder(&recipe, &identity(), rungs).is_err());
    let mut m = source(1920, 1080, true);
    m["streams"]
        .as_array_mut()
        .unwrap()
        .push(json!({"index":2,"codec_type":"audio","codec_name":"aac"}));
    let a = LadderRecipe::from_probe(&m, Some(1), 0.0).unwrap();
    let b = LadderRecipe::from_probe(&m, Some(2), 0.0).unwrap();
    assert_ne!(a.recipe_sha256(), b.recipe_sha256());
}
#[test]
fn first_fragment_rejects_clock_offset_size_attack_and_bandwidth_overrun() {
    let recipe = LadderRecipe::from_probe(&source(640, 360, false), None, 0.0).unwrap();
    let r = &recipe.renditions()[0];
    let mut bytes = fragment(r, 0);
    let tfdt = bytes.windows(4).position(|b| b == b"tfdt").unwrap();
    bytes[tfdt + 15] = 1;
    assert!(validate_first_fragment(&recipe, r.id, &init(r), &bytes, 4_000_000).is_err());
    let mut bytes = fragment(r, 0);
    let trun = bytes.windows(4).position(|b| b == b"trun").unwrap();
    bytes[trun + 8..trun + 12].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(validate_first_fragment(&recipe, r.id, &init(r), &bytes, 4_000_000).is_err());
    let bytes = vec![0; 2_000_000];
    assert!(
        validate_first_fragment(&recipe, r.id, &init(r), &bytes, 4_000_000)
            .unwrap_err()
            .to_string()
            .contains("bandwidth")
    );
}
#[test]
fn suffix_rejects_gaps_and_original_init_changes_transactionally() {
    let recipe = LadderRecipe::from_probe(&source(640, 360, false), None, 0.0).unwrap();
    let r = &recipe.renditions()[0];
    let mut rung = qualified(&recipe, r.id, &playlist(2, false));
    assert!(
        rung.append_fragment(&recipe, &init(r), &fragment(r, 0))
            .is_err()
    );
    assert_eq!(rung.qualified_segment_count(), 1);
    let mut changed_init = init(r);
    let ftyp = changed_init.windows(4).position(|b| b == b"iso6").unwrap();
    changed_init[ftyp] = b'x';
    assert!(
        rung.append_fragment(&recipe, &changed_init, &fragment(r, 1))
            .is_err()
    );
    assert_eq!(rung.qualified_segment_count(), 1);
    rung.append_fragment(&recipe, &init(r), &fragment(r, 1))
        .unwrap();
    assert_eq!(rung.qualified_segment_count(), 2);
}
#[test]
fn candidate_reports_are_bounded_and_exact_per_rendition() {
    let recipe = LadderRecipe::from_probe(&source(1920, 1080, true), None, 0.0).unwrap();
    let candidates = recipe.candidates();
    assert_eq!(candidates.len(), 3);
    assert_eq!(candidates[0].id, "hls_ladder_low");
    assert_eq!(candidates[2].id, "hls_ladder_high");
    assert!(candidates[0].content_type.contains("avc1.64001F"));
    assert!(candidates[2].content_type.contains("avc1.640028"));
    assert_eq!(candidates[1].audio.as_ref().unwrap().samplerate, 48_000);
    let analysis = analyze(&source(320, 240, false), None, 0.0).unwrap();
    assert_eq!(analysis.candidates.len(), 1);
    assert_eq!(analysis.route_decisions.len(), 1);
}
#[test]
fn bounded_probe_excludes_packet_payload_hex_amplification() {
    let args = first_fragment_probe_args();
    let entries = &args[args.iter().position(|s| s == "-show_entries").unwrap() + 1];
    assert!(entries.contains("extradata"));
    let packet = entries
        .split(':')
        .find(|s| s.starts_with("packet="))
        .unwrap();
    assert!(!packet.split(',').any(|s| s == "data"));
    assert_eq!(MAX_PROBE_BYTES, 2 * 1024 * 1024);
}

#[test]
fn short_raw_target_requires_one_complete_final_bounded_segment() {
    for (target, duration) in [(1, "1.400000"), (2, "2.400000"), (3, "3.400000")] {
        let text = playlist(1, true)
            .replace(
                "#EXT-X-TARGETDURATION:4",
                &format!("#EXT-X-TARGETDURATION:{target}"),
            )
            .replace("4.000000", duration);
        assert!(parse_media_playlist(&text).is_ok(), "{text}");
        assert!(parse_media_playlist(&text.replace("#EXT-X-ENDLIST\n", "")).is_err());
    }
    for text in [
        playlist(2, true).replace("#EXT-X-TARGETDURATION:4", "#EXT-X-TARGETDURATION:3"),
        playlist(1, true)
            .replace("#EXT-X-TARGETDURATION:4", "#EXT-X-TARGETDURATION:1")
            .replace("4.000000", "1.600000"),
        playlist(1, true)
            .replace("#EXT-X-TARGETDURATION:4", "#EXT-X-TARGETDURATION:2")
            .replace("4.000000", "2.600000"),
        playlist(1, true).replace("#EXT-X-TARGETDURATION:4", "#EXT-X-TARGETDURATION:3"),
        playlist(1, true)
            .replace("#EXT-X-TARGETDURATION:4", "#EXT-X-TARGETDURATION:0")
            .replace("4.000000", "0.200000"),
        playlist(1, true).replace("#EXT-X-TARGETDURATION:4", "#EXT-X-TARGETDURATION:04"),
        playlist(1, true).replace("#EXT-X-TARGETDURATION:4", "#EXT-X-TARGETDURATION:5"),
        playlist(1, true)
            .replace(
                "#EXT-X-TARGETDURATION:4",
                "#EXT-X-TARGETDURATION:3\n#EXT-X-TARGETDURATION:4",
            )
            .replace("4.000000", "3.000000"),
    ] {
        assert!(parse_media_playlist(&text).is_err(), "{text}");
    }
    // Generated four remains a valid conservative target for a short final.
    assert!(parse_media_playlist(&playlist(1, true).replace("4.000000", "1.000000")).is_ok());
}

#[test]
fn source_color_admission_matches_the_closed_sdr_init_subset() {
    for (field, unsupported) in [
        ("color_primaries", "bt470m"),
        ("color_primaries", "bt470bg"),
        ("color_primaries", "smpte170m"),
        ("color_transfer", "gamma22"),
        ("color_transfer", "gamma28"),
        ("color_transfer", "smpte170m"),
        ("color_space", "bt470bg"),
        ("color_space", "smpte170m"),
        ("color_space", "bt2020nc"),
    ] {
        let mut metadata = source(640, 360, false);
        metadata["streams"][0][field] = json!(unsupported);
        assert_eq!(
            LadderRecipe::from_probe(&metadata, None, 0.0)
                .unwrap_err()
                .to_string(),
            "hls_ladder_source_color_unsupported"
        );
        assert!(
            analyze(&metadata, None, 0.0).is_err(),
            "{field}={unsupported} must not be advertised"
        );
    }
    for supported in [
        Value::Null,
        json!("bt709"),
        json!("unknown"),
        json!("unspecified"),
    ] {
        let mut metadata = source(640, 360, false);
        for field in ["color_primaries", "color_transfer", "color_space"] {
            metadata["streams"][0][field] = supported.clone();
        }
        assert!(LadderRecipe::from_probe(&metadata, None, 0.0).is_ok());
    }
    let mut malformed = source(640, 360, false);
    malformed["streams"][0]["color_space"] = json!(6);
    assert!(LadderRecipe::from_probe(&malformed, None, 0.0).is_err());
}

#[test]
fn qualification_refuses_unadvertised_sdr_family_without_relabeling_pixels() {
    let recipe = LadderRecipe::from_probe(&source(640, 360, false), None, 0.0).unwrap();
    let r = &recipe.renditions()[0];
    let mut observed = probe(r);
    observed["streams"][0]["color_space"] = json!("smpte170m");
    assert!(
        qualify_rendition(
            &recipe,
            r.id,
            &identity(),
            &playlist(1, false),
            &init(r),
            &fragment(r, 0),
            &observed
        )
        .is_err()
    );
    let mut unsupported_init = init(r);
    let color = unsupported_init
        .windows(4)
        .position(|bytes| bytes == b"nclx")
        .unwrap();
    unsupported_init[color + 9] = 6;
    assert!(
        validate_first_fragment(&recipe, r.id, &unsupported_init, &fragment(r, 0), 4_000_000)
            .is_err()
    );
}

#[test]
fn hdr_ladder_composes_one_closed_source_graph_and_qualifies_every_output_color() {
    use crate::advanced_media::{DeviceObservation, Input, Inventory, Request, WorkerGatewayInput};
    let mut meta = source(1920, 1080, true);
    meta["streams"][0]["codec_name"] = json!("hevc");
    meta["streams"][0]["profile"] = json!("Main 10");
    meta["streams"][0]["field_order"] = json!("progressive");
    for (key, value) in [
        ("pix_fmt", "yuv420p10le"),
        ("color_primaries", "bt2020"),
        ("color_transfer", "smpte2084"),
        ("color_space", "bt2020nc"),
        ("color_range", "tv"),
    ] {
        meta["streams"][0][key] = json!(value);
    }
    let request = Request {
        schema_version: 1,
        tone_map_hdr: true,
        subtitle_stream_index: None,
    };
    assert!(LadderRecipe::from_probe(&meta, Some(1), 2.0).is_err());
    let recipe = LadderRecipe::from_advanced_probe(&meta, Some(1), 2.0, &request).unwrap();
    assert!(recipe.tone_mapped());
    assert_eq!(recipe.renditions().len(), 3);
    let inventory_with_decoders = |decoders: &str| {
        Inventory::from_reports(" V....D libx264 encoder\n A..... aac encoder"," ... null V->V\n ... scale V->V\n ... setsar V->V\n ... pad V->V\n ... format V->V\n ... zscale V->V\n ... tonemap V->V\n ... sidedata V->V",decoders,"ffmpeg version fixture",DeviceObservation{nvenc_device_present:false,vaapi_render_node:None,qsv_render_node:None}).unwrap()
    };
    let id = "00000000-0000-0000-0000-000000000001";
    let url = format!(
        "http://127.0.0.1:8081/native-platform-input/{id}/progressive?ticket={}&owner={id}&attempt=1&execution={id}",
        "a".repeat(64)
    );
    let input = WorkerGatewayInput::native_platform(&url).unwrap();
    let missing_decoder = inventory_with_decoders("");
    assert_eq!(
        recipe
            .ffmpeg_args(
                Input::WorkerGateway(&input),
                std::path::Path::new("/fixture/attempt"),
                &missing_decoder,
                false
            )
            .unwrap_err()
            .to_string(),
        "advanced_media_source_decoder_unavailable"
    );
    let inventory = inventory_with_decoders(" V..... hevc synthetic decoder");
    let args = recipe
        .ffmpeg_args(
            Input::WorkerGateway(&input),
            std::path::Path::new("/fixture/attempt"),
            &inventory,
            false,
        )
        .unwrap();
    assert_eq!(args.iter().filter(|v| *v == "-i").count(), 1);
    assert_eq!(args.iter().filter(|v| *v == "-filter_complex").count(), 1);
    let graph = &args[args.iter().position(|v| v == "-filter_complex").unwrap() + 1];
    assert!(graph.contains("tonemap="));
    assert!(graph.contains("split=3"));
    assert!(!graph.contains(crate::capabilities::OUTPUT_VIDEO_FILTER));
    assert_eq!(args.iter().filter(|v| *v == "-forced-idr").count(), 3);
    assert_eq!(args.iter().filter(|v| *v == "-color_primaries").count(), 3);
    for r in recipe.renditions() {
        let mut observed = probe(r);
        for k in ["color_primaries", "color_transfer", "color_space"] {
            observed["streams"][0][k] = json!("bt709");
        }
        observed["streams"][0]["color_range"] = json!("tv");
        assert!(recipe.validate_output_probe(r.id, &observed).is_ok());
        observed["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("color_primaries");
        assert!(recipe.validate_output_probe(r.id, &observed).is_err());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn ass_ladder_splits_after_owned_burnin_and_trims_one_shared_av_origin() {
    use crate::advanced_media::{DeviceObservation, Input, Inventory, OwnedLocalInput, Request};
    let mut meta = source(1920, 1080, true);
    meta["format"] = json!({"start_time":"0.250"});
    meta["streams"]
        .as_array_mut()
        .unwrap()
        .push(json!({"index":7,"codec_type":"subtitle","codec_name":"ass"}));
    let request = Request {
        schema_version: 1,
        tone_map_hdr: false,
        subtitle_stream_index: Some(7),
    };
    let recipe = LadderRecipe::from_advanced_probe(&meta, Some(1), 5.0, &request).unwrap();
    let root = std::env::temp_dir().join(format!("rainsync-ladder-ass-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("fixture.mkv"), b"synthetic source custody").unwrap();
    let version =
        crate::file_version::snapshot_file(&std::fs::File::open(root.join("fixture.mkv")).unwrap())
            .unwrap()
            .version;
    let owner = OwnedLocalInput::open(&root, "fixture.mkv", &version).unwrap();
    let inventory=Inventory::from_reports(" V....D libx264 encoder\n A..... aac encoder"," ... null V->V\n ... scale V->V\n ... setsar V->V\n ... pad V->V\n ... format V->V\n ... trim V->V\n ... setpts V->V\n ... atrim A->A\n ... asetpts A->A\n ... subtitles V->V"," S..... ass subtitle","ffmpeg version fixture",DeviceObservation{nvenc_device_present:false,vaapi_render_node:None,qsv_render_node:None}).unwrap();
    let args = recipe
        .ffmpeg_args(
            Input::OwnedLocal(&owner),
            std::path::Path::new("/fixture/attempt"),
            &inventory,
            false,
        )
        .unwrap();
    let graph = &args[args.iter().position(|v| v == "-filter_complex").unwrap() + 1];
    assert!(graph.contains("subtitles=filename='/proc/self/fd/"));
    assert!(graph.contains(":si=0:"));
    assert!(graph.contains("trim=start=5.25,setpts=PTS-5.25/TB"));
    assert!(graph.contains("atrim=start=5.25,asetpts=PTS-5.25/TB"));
    assert!(graph.contains("asplit=3"));
    assert!(args.iter().any(|v| v == "[rsa_high]"));
    assert!(!args.iter().any(|v| v == "-ss"));
    drop(owner);
    std::fs::remove_dir_all(root).unwrap();
}
