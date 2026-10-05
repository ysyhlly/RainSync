use super::*;

const ID: &str = "dQw4w9WgXcQ";
const NOW: u64 = 1_700_000_000;

fn fixture() -> serde_json::Value {
    serde_json::json!({
        "_type":"video", "id":ID, "extractor_key":"Youtube", "title":"Example VOD",
        "duration":123.5, "live_status":"not_live", "is_live":false, "was_live":false,
        "availability":"public", "age_limit":0, "webpage_url":format!("https://www.youtube.com/watch?v={ID}"),
        "ext":"mp4", "protocol":"https", "vcodec":"avc1.42001E", "acodec":"mp4a.40.2",
        "url":format!("https://rr1---sn-example.googlevideo.com/videoplayback?expire={}&sig=DO_NOT_LOG",NOW+3600),
        "width":640, "height":360, "has_drm":false,
        "downloader_options":{"http_chunk_size":10485760},
        "http_headers":{"User-Agent":USER_AGENT,"Referer":REFERER,"Accept":"*/*",
            "Accept-Language":"en-US,en;q=0.5","Accept-Encoding":"identity","Sec-Fetch-Mode":"navigate"},
        "unknown_secret":{"cookie":"DO_NOT_COPY"}, "formats":[{"url":"DO_NOT_COPY"}]
    })
}
fn normalize(value: &serde_json::Value) -> Result<ResolvedVideo> {
    normalize_json(
        &serde_json::to_vec(value).unwrap(),
        &parse_resource(ID).unwrap(),
        NOW,
        SelectionMode::PreferAdaptive,
    )
}

#[test]
fn quality_selectors_are_closed_and_bound_both_capability_branches() {
    for quality in [
        QualityLimit::P144,
        QualityLimit::P240,
        QualityLimit::P360,
        QualityLimit::P480,
        QualityLimit::P720,
        QualityLimit::P1080,
        QualityLimit::P1440,
        QualityLimit::P2160,
        QualityLimit::P4320,
    ] {
        let height = quality.height().unwrap();
        let selector = process::format_selector(SelectionMode::PreferAdaptive, quality);
        let (adaptive, progressive) = selector.split_once('/').unwrap();
        assert!(adaptive.contains(&format!("[height<={height}]")));
        assert!(progressive.contains(&format!("[height<={height}]")));
        let progressive = process::format_selector(SelectionMode::ProgressiveOnly, quality);
        assert!(!progressive.contains("+bestaudio"));
        assert!(progressive.ends_with(&format!("[height>0][height<={height}]")));
    }
    assert_eq!(
        process::format_selector(SelectionMode::PreferAdaptive, QualityLimit::Auto),
        process::FORMAT_SELECTOR
    );
    assert_eq!(
        process::format_selector(SelectionMode::ProgressiveOnly, QualityLimit::Auto),
        process::PROGRESSIVE_FORMAT_SELECTOR
    );
    let selected = normalize(&adaptive_fixture()).unwrap();
    assert!(validate_quality_limit(&selected, QualityLimit::P720).is_err());
    assert!(validate_quality_limit(&selected, QualityLimit::P1080).is_ok());
}

#[test]
fn quality_discovery_retains_only_actual_compatible_heights_and_is_bounded() {
    let mut data = adaptive_fixture();
    let mut video = data["requested_formats"][0].clone();
    video["height"] = serde_json::json!(720);
    video["width"] = serde_json::json!(1280);
    let mut unsupported = video.clone();
    unsupported["vcodec"] = serde_json::json!("vp09.00.40.08");
    unsupported["height"] = serde_json::json!(2160);
    let mut expired = video.clone();
    expired["height"] = serde_json::json!(1440);
    expired["url"] = serde_json::json!(format!(
        "https://rr1.googlevideo.com/videoplayback?expire={NOW}"
    ));
    data["formats"] = serde_json::json!([video, unsupported, expired, fixture()]);
    assert_eq!(
        normalize(&data).unwrap().available_heights,
        vec![360, 720, 1080]
    );
    let mut muxed = fixture();
    muxed["formats"] = data["formats"].clone();
    assert_eq!(
        normalize_json(
            &serde_json::to_vec(&muxed).unwrap(),
            &parse_resource(ID).unwrap(),
            NOW,
            SelectionMode::ProgressiveOnly
        )
        .unwrap()
        .available_heights,
        vec![360]
    );
    data["formats"] = serde_json::json!(vec![serde_json::json!({}); 129]);
    assert!(normalize(&data).is_err());
}

fn adaptive_fixture() -> serde_json::Value {
    let mut data = fixture();
    data.as_object_mut().unwrap().remove("url");
    data["protocol"] = serde_json::json!("https+https");
    data["vcodec"] = serde_json::json!("avc1.640028");
    data["width"] = serde_json::json!(1920);
    data["height"] = serde_json::json!(1080);
    data["fps"] = serde_json::json!(60.0);
    data["asr"] = serde_json::json!(48000);
    data["audio_channels"] = serde_json::json!(2);
    data["tbr"] = serde_json::json!(4128.25);
    data["requested_formats"] = serde_json::json!([
        {
            "ext":"mp4", "protocol":"https", "vcodec":"avc1.640028", "acodec":"none",
            "url":format!("https://rr1.googlevideo.com/videoplayback?expire={}&itag=137&sig=PRIVATE_VIDEO", NOW+3600),
            "width":1920, "height":1080, "fps":60.0, "tbr":4000.25,"vbr":4000.25,"abr":0,
            "asr":null, "audio_channels":null, "has_drm":false,"container":"mp4_dash",
            "downloader_options":{"http_chunk_size":10485760},
            "http_headers":{"User-Agent":USER_AGENT,"Referer":REFERER},
            "unknown_secret":{"cookie":"NEVER_COPY"}
        },
        {
            "ext":"m4a", "protocol":"https", "vcodec":"none", "acodec":"mp4a.40.2",
            "url":format!("https://rr2.googlevideo.com/videoplayback?expire={}&itag=140&sig=PRIVATE_AUDIO", NOW+1800),
            "width":null, "height":null, "fps":null, "asr":48000, "audio_channels":2,
            "tbr":128.0,"abr":128.0,"vbr":0,"has_drm":false,"container":"m4a_dash",
            "downloader_options":{"http_chunk_size":10485760},
            "http_headers":{"User-Agent":USER_AGENT,"Referer":REFERER}
        }
    ]);
    data
}

#[test]
fn identities_are_canonical_and_cannot_smuggle_flags_playlists_or_origins() {
    for input in [
        ID.to_string(),
        format!("https://www.youtube.com/watch?v={ID}"),
        format!("https://youtube.com/watch?si=Ab_c&v={ID}&t=1m2s"),
        format!("https://m.youtube.com/shorts/{ID}/?feature=share"),
        format!("https://youtu.be/{ID}?si=x-y"),
    ] {
        assert_eq!(
            parse_resource(&input).unwrap().canonical(),
            format!("https://www.youtube.com/watch?v={ID}")
        );
    }
    for input in [
        "--exec=bad".to_string(),
        format!("http://youtube.com/watch?v={ID}"),
        format!("https://www.youtube.com:443/watch?v={ID}"),
        format!("https://user@youtube.com/watch?v={ID}"),
        format!("https://youtube.com.attacker.invalid/watch?v={ID}"),
        format!("https://youtube.com/watch?v={ID}&list=secret"),
        format!("https://youtube.com/watch?v={ID}&v={ID}"),
        format!("https://youtube.com/watch?v={ID}#fragment"),
        format!("https://youtube.com/watch?%76={ID}"),
        format!("https://youtu.be/{ID}?si=x&si=y"),
        format!("https://youtu.be/{ID}?t=word"),
        format!("https://youtube.com/embed/{ID}"),
        format!("https://youtube.com/x/../watch?v={ID}"),
        format!("https://youtube.com/x/%2e%2e/watch?v={ID}"),
        "https://youtube.com/shorts/%64Qw4w9WgXcQ".to_string(),
        format!(" https://youtube.com/watch?v={ID}"),
        format!("https://youtube.com\\watch?v={ID}"),
    ] {
        assert_eq!(
            parse_resource(&input),
            Err(Error::InvalidResource),
            "{input}"
        );
    }
}

#[test]
fn closed_json_result_is_muxed_verified_redacted_and_expiring() {
    let resolved = normalize(&fixture()).unwrap();
    assert_eq!(resolved.content_id, ID);
    let Playback::Progressive(track) = &resolved.playback else {
        panic!("muxed fixture must retain progressive fallback")
    };
    assert_eq!(track.video_codec, "avc1.42001E");
    assert_eq!(track.audio_codec, "mp4a.40.2");
    assert_eq!(
        resolved.expires_at_unix_ms,
        Some(((NOW + 3600) * 1000) as i64)
    );
    let debug = format!("{resolved:?}");
    for private in [
        "googlevideo",
        "DO_NOT_LOG",
        "DO_NOT_COPY",
        "Example VOD",
        ID,
    ] {
        assert!(!debug.contains(private));
    }
    for (key, value) in [
        ("id", serde_json::json!("aaaaaaaaaaa")),
        ("extractor_key", serde_json::json!("Generic")),
        (
            "webpage_url",
            serde_json::json!("https://www.youtube.com/watch?v=aaaaaaaaaaa"),
        ),
        ("duration", serde_json::json!(0)),
        ("width", serde_json::json!(9000)),
        ("title", serde_json::json!("secret\ncontrol")),
    ] {
        let mut data = fixture();
        data[key] = value;
        assert_eq!(
            normalize(&data).unwrap_err(),
            Error::InvalidResponse,
            "{key}"
        );
    }
    for (key, value) in [
        ("live_status", serde_json::json!("is_live")),
        ("was_live", serde_json::json!(true)),
        ("availability", serde_json::json!("needs_auth")),
        ("availability", serde_json::Value::Null),
        ("age_limit", serde_json::json!(18)),
        ("has_drm", serde_json::json!(true)),
        ("has_drm", serde_json::json!("maybe")),
        ("entries", serde_json::json!([])),
        ("fragments", serde_json::json!([])),
        ("manifest_url", serde_json::json!("hidden")),
        ("request_data", serde_json::json!("hidden")),
        ("cookies", serde_json::json!("hidden")),
        ("ext", serde_json::json!("webm")),
        ("protocol", serde_json::json!("m3u8_native")),
        ("protocol", serde_json::json!("sabr")),
        ("vcodec", serde_json::json!("vp9")),
        ("acodec", serde_json::json!("mp4a.40.5")),
        ("acodec", serde_json::json!("none")),
    ] {
        let mut data = fixture();
        data[key] = value;
        assert_eq!(normalize(&data).unwrap_err(), Error::Unsupported, "{key}");
    }
}

#[test]
fn selected_adaptive_pair_is_high_quality_complementary_and_redacted() {
    for reverse in [false, true] {
        let mut data = adaptive_fixture();
        if reverse {
            data["requested_formats"].as_array_mut().unwrap().reverse();
        }
        let resolved = normalize(&data).unwrap();
        let Playback::Adaptive { video, audio } = &resolved.playback else {
            panic!("selected pair must remain adaptive")
        };
        assert_eq!(video.width, 1920);
        assert_eq!(video.height, 1080);
        assert_eq!(video.fps, 60.0);
        assert_eq!(video.codec, "avc1.640028");
        assert_eq!(video.bitrate_bps, 4_000_250);
        assert_eq!(audio.sample_rate, 48000);
        assert_eq!(audio.channels, 2);
        assert_eq!(audio.codec, "mp4a.40.2");
        assert_eq!(audio.bitrate_bps, 128_000);
        assert_eq!(resolved.playback.dimensions(), (Some(1920), Some(1080)));
        assert_eq!(
            resolved.expires_at_unix_ms,
            Some(((NOW + 1800) * 1000) as i64)
        );
        assert_eq!(video.expires_at_unix_ms, ((NOW + 3600) * 1000) as i64);
        for debug in [
            format!("{resolved:?}"),
            format!("{video:?}"),
            format!("{audio:?}"),
        ] {
            for private in [
                "googlevideo",
                "PRIVATE_VIDEO",
                "PRIVATE_AUDIO",
                "NEVER_COPY",
                "Example VOD",
                ID,
            ] {
                assert!(!debug.contains(private));
            }
        }
    }
    // The official format summary need not repeat per-track timing. Root VOD
    // duration remains mandatory, and no byte ranges are synthesized here.
    let mut data = adaptive_fixture();
    for index in 0..2 {
        data["requested_formats"][index]["duration"] = serde_json::json!(123.75);
    }
    assert!(normalize(&data).is_ok());
    data.as_object_mut().unwrap().remove("duration");
    assert_eq!(normalize(&data).unwrap_err(), Error::InvalidResponse);
}

#[test]
fn malformed_selected_shape_never_downgrades_to_muxed_url_or_formats() {
    let pair = adaptive_fixture()["requested_formats"].clone();
    for requested in [
        serde_json::Value::Null,
        serde_json::json!([]),
        serde_json::json!([pair[0]]),
        serde_json::json!([pair[0], pair[1], pair[1]]),
        serde_json::json!({"0":pair[0],"1":pair[1]}),
        serde_json::json!([null, null]),
    ] {
        let mut data = fixture();
        data["requested_formats"] = requested;
        // A fully valid muxed URL and unselected formats cannot rescue it.
        data["formats"] = serde_json::json!([fixture()]);
        assert_eq!(normalize(&data).unwrap_err(), Error::InvalidResponse);
    }
    let mut data = adaptive_fixture();
    data["url"] = fixture()["url"].clone();
    assert_eq!(normalize(&data).unwrap_err(), Error::Unsupported);
    data.as_object_mut().unwrap().remove("url");
    data["requested_formats"][1] = data["requested_formats"][0].clone();
    assert_eq!(normalize(&data).unwrap_err(), Error::Unsupported);
    let mut data = adaptive_fixture();
    data["requested_formats"][0] = fixture();
    assert_eq!(normalize(&data).unwrap_err(), Error::Unsupported);
    let mut data = adaptive_fixture();
    data["requested_formats"][1]["url"] = data["requested_formats"][0]["url"].clone();
    assert_eq!(normalize(&data).unwrap_err(), Error::Unsupported);
}

#[test]
fn adaptive_codecs_transports_headers_and_security_fields_fail_closed() {
    for (index, key, value) in [
        (0, "vcodec", serde_json::json!("vp9")),
        (0, "vcodec", serde_json::json!("avc1.64002")),
        (0, "vcodec", serde_json::json!("avc1.64002Z")),
        (0, "vcodec", serde_json::json!("avc3.640028")),
        (0, "ext", serde_json::json!("webm")),
        (0, "acodec", serde_json::json!("mp4a.40.2")),
        (1, "ext", serde_json::json!("mp4")),
        (1, "acodec", serde_json::json!("mp4a.40.5")),
        (1, "vcodec", serde_json::json!("avc1.640028")),
        (0, "protocol", serde_json::json!("m3u8_native")),
        (1, "protocol", serde_json::json!("http_dash_segments")),
        (1, "protocol", serde_json::json!("sabr")),
        (0, "has_drm", serde_json::json!(true)),
        (1, "has_drm", serde_json::json!("maybe")),
    ] {
        let mut data = adaptive_fixture();
        data["requested_formats"][index][key] = value;
        assert_eq!(
            normalize(&data).unwrap_err(),
            Error::Unsupported,
            "{index}/{key}"
        );
    }
    for index in 0..2 {
        for key in [
            "requested_formats",
            "fragments",
            "manifest_url",
            "fragment_base_url",
            "request_data",
            "cookies",
            "hls_aes",
            "init_range",
            "index_range",
            "impersonate",
        ] {
            let mut data = adaptive_fixture();
            // Presence including null is never treated as missing for selected
            // transport fields, nor are pretend extractor ranges trusted.
            data["requested_formats"][index][key] = serde_json::Value::Null;
            assert_eq!(
                normalize(&data).unwrap_err(),
                Error::Unsupported,
                "{index}/{key}"
            );
        }
        for name in ["Cookie", "Authorization", "X-Forwarded-For", "User-Agent"] {
            let mut data = adaptive_fixture();
            data["requested_formats"][index]["http_headers"][name] = serde_json::json!("secret");
            assert_eq!(
                normalize(&data).unwrap_err(),
                Error::InvalidResponse,
                "{index}/{name}"
            );
        }
        for options in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({"http_chunk_size":1}),
            serde_json::json!({"http_chunk_size":10485760,"proxy":1}),
            serde_json::json!({"http_chunk_size":"10485760"}),
        ] {
            let mut data = adaptive_fixture();
            data["requested_formats"][index]["downloader_options"] = options;
            assert_eq!(normalize(&data).unwrap_err(), Error::InvalidResponse);
        }
        for query in [
            "pot=secret",
            "po_token=secret",
            "sabr=x",
            "authorization=secret",
        ] {
            let mut data = adaptive_fixture();
            data["requested_formats"][index]["url"] = serde_json::json!(format!(
                "https://rr1.googlevideo.com/videoplayback?expire={}&{query}",
                NOW + 3600
            ));
            assert_eq!(normalize(&data).unwrap_err(), Error::Unsupported);
        }
    }
}

#[test]
fn adaptive_metadata_is_required_finite_bounded_and_consistent() {
    for (index, key, value) in [
        (0, "width", serde_json::json!(0)),
        (0, "height", serde_json::json!(4321)),
        (0, "fps", serde_json::json!(0)),
        (0, "fps", serde_json::json!(120.01)),
        (0, "tbr", serde_json::json!(-1)),
        (0, "tbr", serde_json::json!(80000.1)),
        (0, "vbr", serde_json::json!(80000.1)),
        (0, "abr", serde_json::json!(1)),
        (0, "asr", serde_json::json!(48000)),
        (0, "audio_channels", serde_json::json!(2)),
        (1, "asr", serde_json::json!(7999)),
        (1, "asr", serde_json::json!(96001)),
        (1, "audio_channels", serde_json::json!(0)),
        (1, "audio_channels", serde_json::json!(3)),
        (1, "audio_channels", serde_json::json!(9)),
        (1, "tbr", serde_json::json!(512.1)),
        (1, "abr", serde_json::json!(512.1)),
        (1, "vbr", serde_json::json!(1)),
        (1, "width", serde_json::json!(640)),
        (1, "height", serde_json::json!(360)),
        (1, "fps", serde_json::json!(30)),
        (0, "duration", serde_json::json!(0)),
        (1, "duration", serde_json::json!(MAX_DURATION_SECONDS + 1.0)),
        (1, "duration", serde_json::json!(120.0)),
    ] {
        let mut data = adaptive_fixture();
        data["requested_formats"][index][key] = value;
        assert_eq!(
            normalize(&data).unwrap_err(),
            Error::InvalidResponse,
            "{index}/{key}"
        );
    }
    for (index, key) in [
        (0, "width"),
        (0, "height"),
        (0, "fps"),
        (0, "tbr"),
        (1, "asr"),
        (1, "audio_channels"),
        (1, "tbr"),
    ] {
        let mut data = adaptive_fixture();
        data["requested_formats"][index]
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert_eq!(
            normalize(&data).unwrap_err(),
            Error::InvalidResponse,
            "{index}/{key}"
        );
    }
    for (key, value) in [
        ("width", serde_json::json!(1280)),
        ("height", serde_json::json!(720)),
        ("fps", serde_json::json!(30)),
        ("asr", serde_json::json!(44100)),
        ("audio_channels", serde_json::json!(1)),
        ("duration", serde_json::json!(0)),
    ] {
        let mut data = adaptive_fixture();
        data[key] = value;
        assert_eq!(
            normalize(&data).unwrap_err(),
            Error::InvalidResponse,
            "root/{key}"
        );
    }
    let bytes = serde_json::to_string(&adaptive_fixture())
        .unwrap()
        .replacen("4000.25", "1e999", 1);
    assert_eq!(
        normalize_json(
            bytes.as_bytes(),
            &parse_resource(ID).unwrap(),
            NOW,
            SelectionMode::PreferAdaptive
        )
        .unwrap_err(),
        Error::InvalidResponse
    );
}

#[test]
fn adaptive_selection_envelope_matches_downstream_player_limits() {
    let mut data = adaptive_fixture();
    for key in ["width", "height", "fps"] {
        let value = match key {
            "width" => serde_json::json!(8192),
            "height" => serde_json::json!(4320),
            _ => serde_json::json!(120.0),
        };
        data[key] = value.clone();
        data["requested_formats"][0][key] = value;
    }
    data["asr"] = serde_json::json!(96000);
    data["requested_formats"][1]["asr"] = serde_json::json!(96000);
    data["tbr"] = serde_json::json!(80512.0);
    data["requested_formats"][0]["tbr"] = serde_json::json!(80000.0);
    data["requested_formats"][0]["vbr"] = serde_json::json!(80000.0);
    data["requested_formats"][1]["tbr"] = serde_json::json!(512.0);
    data["requested_formats"][1]["abr"] = serde_json::json!(512.0);
    let Playback::Adaptive { video, audio } = normalize(&data).unwrap().playback else {
        panic!("bounded compatible maxima must remain adaptive")
    };
    assert_eq!(video.bitrate_bps, 80_000_000);
    assert_eq!(audio.bitrate_bps, 512_000);
    for required in [
        "[width<=8192]",
        "[height<=4320]",
        "[fps<=120]",
        "[tbr<=80000]",
        "[asr<=96000]",
        "[audio_channels>=1]",
        "[audio_channels<=2]",
        "[tbr<=512]",
    ] {
        assert!(process::FORMAT_SELECTOR.contains(required), "{required}");
    }
}

#[test]
fn progressive_only_policy_is_explicit_and_never_reinterprets_selected_pairs() {
    let reference = parse_resource(ID).unwrap();
    let progressive = serde_json::to_vec(&fixture()).unwrap();
    for mode in [
        SelectionMode::PreferAdaptive,
        SelectionMode::ProgressiveOnly,
    ] {
        assert!(matches!(
            normalize_json(&progressive, &reference, NOW, mode)
                .unwrap()
                .playback,
            Playback::Progressive(_)
        ));
    }
    let adaptive = serde_json::to_vec(&adaptive_fixture()).unwrap();
    assert_eq!(
        normalize_json(&adaptive, &reference, NOW, SelectionMode::ProgressiveOnly).unwrap_err(),
        Error::Unsupported
    );
    let mut malformed = fixture();
    malformed["requested_formats"] = serde_json::json!([]);
    assert_eq!(
        normalize_json(
            &serde_json::to_vec(&malformed).unwrap(),
            &reference,
            NOW,
            SelectionMode::ProgressiveOnly
        )
        .unwrap_err(),
        Error::InvalidResponse
    );
}

#[test]
fn normalized_result_is_not_released_after_absolute_deadline() {
    let bytes = serde_json::to_vec(&adaptive_fixture()).unwrap();
    let reference = parse_resource(ID).unwrap();
    assert_eq!(
        normalize_json_before_deadline(
            &bytes,
            &reference,
            NOW,
            SelectionMode::PreferAdaptive,
            Instant::now()
        )
        .unwrap_err(),
        Error::Deadline
    );
    assert_eq!(
        normalize_json_before_deadline(
            b"invalid",
            &reference,
            NOW,
            SelectionMode::PreferAdaptive,
            Instant::now()
        )
        .unwrap_err(),
        Error::Deadline
    );
    assert!(
        normalize_json_before_deadline(
            &bytes,
            &reference,
            NOW,
            SelectionMode::PreferAdaptive,
            Instant::now() + Duration::from_secs(1)
        )
        .is_ok()
    );
}

#[cfg(unix)]
#[test]
fn closed_selection_mode_changes_only_fixed_selector_before_extraction() {
    let config = Config::opt_in_absolute(std::env::current_exe().unwrap()).unwrap();
    let scratch = process::ScratchDir::create().unwrap();
    let reference = parse_resource(ID).unwrap();
    let args = |mode| {
        process::command(&config, &reference, mode, scratch.path())
            .unwrap()
            .as_std()
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
    };
    let adaptive = args(SelectionMode::PreferAdaptive);
    let mut progressive = args(SelectionMode::ProgressiveOnly);
    let selector = progressive
        .iter()
        .position(|arg| arg == "--format")
        .unwrap()
        + 1;
    assert_eq!(progressive[selector], process::PROGRESSIVE_FORMAT_SELECTOR);
    assert!(!progressive[selector].contains('+'));
    assert!(!progressive[selector].contains('/'));
    assert!(progressive.contains(&"--simulate".to_owned()));
    progressive[selector] = process::FORMAT_SELECTOR.to_owned();
    assert_eq!(adaptive, progressive);
}

#[test]
fn urls_and_headers_never_expand_anonymous_access() {
    for url in [
        format!(
            "https://googlevideo.com.evil.invalid/videoplayback?expire={}",
            NOW + 3600
        ),
        format!(
            "https://rr1.googlevideo.com:443/videoplayback?expire={}",
            NOW + 3600
        ),
        format!(
            "https://user:password@rr1.googlevideo.com/videoplayback?expire={}",
            NOW + 3600
        ),
        format!("https://rr1.googlevideo.com/manifest?expire={}", NOW + 3600),
        format!(
            "https://rr1.googlevideo.com/x/../videoplayback?expire={}",
            NOW + 3600
        ),
        format!(
            "https://rr1.googlevideo.com/videoplayback?expire={}",
            NOW + 1
        ),
        format!(
            "https://rr1.googlevideo.com/videoplayback?expire={}",
            NOW + MAX_EXPIRY_SECONDS + 1
        ),
        format!(
            "https://rr1.googlevideo.com/videoplayback?expire={}&expire={}",
            NOW + 3600,
            NOW + 3600
        ),
        "https://rr1.googlevideo.com/videoplayback?sig=secret".to_string(),
    ] {
        assert_eq!(validate_media_url(&url, NOW), Err(Error::InvalidResponse));
    }
    for extra in [
        "pot=secret",
        "po_token=secret",
        "sabr=x",
        "access_token=secret",
        "Cookie=secret",
    ] {
        let url = format!(
            "https://rr1.googlevideo.com/videoplayback?expire={}&{extra}",
            NOW + 3600
        );
        assert_eq!(validate_media_url(&url, NOW), Err(Error::Unsupported));
    }
    for name in ["Cookie", "Authorization", "X-Forwarded-For", "User-Agent"] {
        let mut data = fixture();
        data["http_headers"][name] = serde_json::json!("secret");
        assert_eq!(normalize(&data).unwrap_err(), Error::InvalidResponse);
    }
    let mut bytes = serde_json::to_string(&fixture()).unwrap();
    bytes = bytes.replacen(
        "\"http_headers\":{",
        "\"http_headers\":{\"accept\":\"*/*\",",
        1,
    );
    assert_eq!(
        normalize_json(
            bytes.as_bytes(),
            &parse_resource(ID).unwrap(),
            NOW,
            SelectionMode::PreferAdaptive
        )
        .unwrap_err(),
        Error::InvalidResponse
    );
    assert_eq!(
        normalize_json(
            &vec![b' '; MAX_JSON_BYTES + 1],
            &parse_resource(ID).unwrap(),
            NOW,
            SelectionMode::PreferAdaptive,
        )
        .unwrap_err(),
        Error::TooLarge
    );
}

#[tokio::test]
async fn disabled_resolver_and_expired_deadline_do_not_spawn() {
    let resolver = YoutubeResolver::new(Config::disabled());
    assert_eq!(
        resolver
            .resolve(ID, Instant::now() + Duration::from_secs(1))
            .await
            .unwrap_err(),
        Error::ProviderUnavailable
    );
    assert!(Arc::ptr_eq(&resolver.slots, &resolver.clone().slots));
    assert_eq!(
        Config::opt_in_absolute(PathBuf::from("yt-dlp")).unwrap_err(),
        Error::InvalidConfiguration
    );
    #[cfg(unix)]
    {
        let configured = YoutubeResolver::new(
            Config::opt_in_absolute(std::env::current_exe().unwrap()).unwrap(),
        );
        assert_eq!(
            configured
                .resolve(ID, Instant::now() - Duration::from_secs(1))
                .await
                .unwrap_err(),
            Error::Deadline
        );
        assert_eq!(configured.slots.available_permits(), MAX_CONCURRENT);
    }
}

#[cfg(unix)]
#[test]
fn fixed_command_clears_environment_and_uses_no_shell_or_user_args() {
    let binary = std::env::current_exe().unwrap();
    let config = Config::opt_in_absolute(binary.clone())
        .unwrap()
        .with_deno_absolute(binary)
        .unwrap();
    let scratch = process::ScratchDir::create().unwrap();
    let command = process::command(
        &config,
        &parse_resource(ID).unwrap(),
        SelectionMode::PreferAdaptive,
        scratch.path(),
    )
    .unwrap();
    let args: Vec<_> = command
        .as_std()
        .get_args()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        args.last().unwrap(),
        &format!("https://www.youtube.com/watch?v={ID}")
    );
    for flag in [
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-cookies-from-browser",
        "--no-remote-components",
        "--simulate",
        "--no-cache-dir",
        "--no-js-runtimes",
    ] {
        assert!(args.contains(&flag.to_string()));
    }
    assert!(
        !args
            .iter()
            .any(|arg| arg == "--exec" || arg == "--netrc" || arg == "--update")
    );
    assert!(args.iter().any(|arg| arg.starts_with("deno:/")));
    let selector_index = args.iter().position(|arg| arg == "--format").unwrap() + 1;
    assert_eq!(args[selector_index], process::FORMAT_SELECTOR);
    assert!(process::FORMAT_SELECTOR.starts_with("bestvideo["));
    assert!(process::FORMAT_SELECTOR.contains("+bestaudio[ext=m4a]"));
    assert!(
        process::FORMAT_SELECTOR
            .ends_with("/best[ext=mp4][protocol=https][vcodec^=avc1.][acodec=mp4a.40.2]")
    );
    assert_eq!(args.iter().filter(|arg| *arg == "--simulate").count(), 1);
    for forbidden in [
        "--no-simulate",
        "--skip-download",
        "--merge-output-format",
        "--remux-video",
        "--audio-multistreams",
        "--video-multistreams",
    ] {
        assert!(!args.iter().any(|arg| arg == forbidden));
    }
    let env: std::collections::BTreeMap<_, _> = command.as_std().get_envs().collect();
    assert_eq!(
        env.get(std::ffi::OsStr::new("PATH")),
        Some(&Some(std::ffi::OsStr::new("")))
    );
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "PYTHONPATH",
        "DENO_AUTH_TOKENS",
        "AWS_SECRET_ACCESS_KEY",
        "DATABASE_URL",
    ] {
        assert!(!env.contains_key(std::ffi::OsStr::new(key)));
    }
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(scratch.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

/// Only the workspace-built test executable is launched. No yt-dlp, shell,
/// external fixture script, remote video or user binary is executed by tests.
#[test]
#[ignore]
fn process_fixture() {
    use std::io::Write;
    match std::env::var("RAINSYNC_YOUTUBE_FIXTURE").as_deref() {
        Ok("stderr") => {
            let mut stderr = std::io::stderr();
            for _ in 0..40 {
                stderr.write_all(&[b'x'; 1024]).unwrap();
            }
        }
        Ok("stdout") => {
            let mut stdout = std::io::stdout();
            for _ in 0..300 {
                stdout.write_all(&[b'x'; 8192]).unwrap();
            }
        }
        Ok("wait") => std::thread::sleep(Duration::from_secs(60)),
        _ => {}
    }
}

#[tokio::test]
async fn supervisor_reaps_on_overflow_deadline_and_waiter_cancellation() {
    for mode in ["stderr", "stdout", "wait", "cancel"] {
        let scope = media_core::child_process::Scope::new();
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .env_clear()
            .env(
                "RAINSYNC_YOUTUBE_FIXTURE",
                if mode == "cancel" { "wait" } else { mode },
            )
            .args([
                "--ignored",
                "--exact",
                "platform::youtube::tests::process_fixture",
                "--nocapture",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let slots = Arc::new(Semaphore::new(1));
        let permit = slots.clone().acquire_owned().await.unwrap();
        let (mut send, receive) = tokio::sync::oneshot::channel();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (outcome, owner_result) = tokio::sync::oneshot::channel();
        let deadline = Instant::now()
            + if mode == "wait" {
                Duration::from_millis(100)
            } else {
                Duration::from_secs(5)
            };
        scope
            .run(async {
                media_core::child_process::supervise(async move {
                    let child = media_core::child_process::spawn(command)?;
                    let _ = started.send(());
                    let result = process::capture(child, deadline, &mut send).await;
                    drop(permit);
                    let _ = outcome.send(result);
                    Ok(())
                })
                .unwrap();
            })
            .await;
        tokio::time::timeout(Duration::from_secs(2), ready)
            .await
            .unwrap()
            .unwrap();
        // Keep non-cancelled receiver open without detaching a pipe/wait task.
        let _receiver = if mode == "cancel" {
            drop(receive);
            None
        } else {
            Some(receive)
        };
        if mode == "cancel" {
            tokio::time::timeout(Duration::from_secs(2), scope.shutdown())
                .await
                .unwrap()
                .unwrap();
        }
        let result = tokio::time::timeout(Duration::from_secs(8), owner_result)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            result.unwrap_err(),
            match mode {
                "wait" => Error::Deadline,
                "cancel" => Error::Cancelled,
                _ => Error::TooLarge,
            }
        );
        // Scope success is evidence from the existing original managed owner,
        // not inferred from a timeout, vanished PID or released semaphore.
        tokio::time::timeout(Duration::from_secs(2), scope.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(slots.available_permits(), 1);
    }
}

#[cfg(unix)]
#[test]
fn scratch_disposal_is_explicit_bounded_and_does_not_follow_symlinks() {
    let mut scratch = process::ScratchDir::create().unwrap();
    let mut other = process::ScratchDir::create().unwrap();
    let path = scratch.path().to_owned();
    std::fs::write(other.path().join("keep"), b"owned elsewhere").unwrap();
    std::fs::create_dir(scratch.path().join("cache")).unwrap();
    std::fs::write(scratch.path().join("cache/file"), b"runtime cache").unwrap();
    std::os::unix::fs::symlink(other.path(), scratch.path().join("external-link")).unwrap();
    scratch.dispose().unwrap();
    assert!(!path.exists());
    assert!(other.path().join("keep").exists());
    other.dispose().unwrap();

    let mut scratch = process::ScratchDir::create().unwrap();
    let root = scratch.path().to_owned();
    let moved = root.with_extension("moved");
    std::fs::rename(&root, &moved).unwrap();
    std::fs::create_dir(&root).unwrap();
    assert_eq!(scratch.dispose(), Err(Error::ProcessCleanupFailed));
    // A different directory at the same path is never silently disposed.
    assert!(root.exists());
    std::fs::remove_dir(&root).unwrap();
    std::fs::rename(&moved, &root).unwrap();
    let mut depth = root.clone();
    for _ in 0..17 {
        depth = depth.join("child");
        std::fs::create_dir(&depth).unwrap();
    }
    assert_eq!(scratch.dispose(), Err(Error::ProcessCleanupFailed));
    std::fs::remove_dir(&depth).unwrap();
    scratch.dispose().unwrap();
}

#[test]
fn private_webm_pair_is_separate_from_native_browser_and_keeps_aac() {
    for codec in ["vp9", "vp9.2", "av1", "av01.0.08M.08", "vp09.02.40.10"] {
        let mut data = adaptive_fixture();
        data["vcodec"] = serde_json::json!(codec);
        // yt-dlp's metadata-only VP9 WebM+AACL summary can be mkv; no actual
        // merger or mkv source is executed or admitted.
        data["ext"] = serde_json::json!(if codec.starts_with("vp") {
            "mkv"
        } else {
            "mp4"
        });
        data["requested_formats"][0]["vcodec"] = serde_json::json!(codec);
        data["requested_formats"][0]["ext"] = serde_json::json!("webm");
        let resolved = normalize_json(
            &serde_json::to_vec(&data).unwrap(),
            &parse_resource(ID).unwrap(),
            NOW,
            SelectionMode::CompatibilityAdaptive,
        )
        .unwrap();
        let Playback::Adaptive { video, audio } = resolved.playback else {
            panic!()
        };
        assert_eq!(
            video.container,
            media_core::advanced_media::PrivateInputContainer::Webm
        );
        assert_eq!(audio.codec, "mp4a.40.2");
        assert!(normalize(&data).is_err());
        data["requested_formats"][1]["ext"] = serde_json::json!("webm");
        data["requested_formats"][1]["acodec"] = serde_json::json!("opus");
        assert!(
            normalize_json(
                &serde_json::to_vec(&data).unwrap(),
                &parse_resource(ID).unwrap(),
                NOW,
                SelectionMode::CompatibilityAdaptive
            )
            .is_err()
        );
    }
    for codec in [
        "vp09.01.40.08",
        "vp09.03.40.12",
        "av01.1.08M.08",
        "hev1.2.6.L120",
        "h264",
        "vp8",
    ] {
        assert!(!valid_webm_video_hint(codec));
    }
}
