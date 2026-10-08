use super::*;
use serde_json::json;
const NOW: u64 = 1700000100;
fn room() -> Value {
    json!({"status_code":0,"data":{"id_str":"7","status":2,"create_time":1700000000,"owner":{"id_str":"9","display_id":"creator"},"title":"Synthetic stream","stream_url_filtered_info":{"is_gated_room":false,"is_paid_event":false},"stream_url":{"hls_pull_url":"https://pull-hls-f16-va01.tiktokcdn.com/stage/stream-7/index.m3u8","hls_pull_url_params":"{\"VCodec\":\"h264\"}"}}})
}
fn resolved() -> Resolved {
    parse_response(
        &Resource::TikTokRoom {
            room_id: "7".into(),
        },
        &serde_json::to_vec(&room()).unwrap(),
        NOW,
    )
    .unwrap()
}
#[test]
fn live_resources_never_reclassify_vod_or_transport_urls() {
    for (p, url) in [
        (
            Provider::YouTube,
            "https://www.youtube.com/live/dQw4w9WgXcQ",
        ),
        (Provider::Douyin, "https://live.douyin.com/7"),
        (Provider::TikTok, "https://www.tiktok.com/@creator/live"),
        (Provider::TikTok, "https://m.tiktok.com/share/live/7"),
    ] {
        let r = parse_resource(p, url).unwrap();
        r.validate().unwrap();
        assert_eq!(r.canonical(), url);
        for suffix in ["?cookie=secret", "#x"] {
            assert!(parse_resource(p, &format!("{url}{suffix}")).is_err());
        }
    }
    for (p, url) in [
        (
            Provider::YouTube,
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        ),
        (Provider::Douyin, "https://www.douyin.com/video/7"),
        (Provider::TikTok, "https://www.tiktok.com/@creator/video/7"),
        (Provider::TikTok, "https://www.tiktok.com:443/@creator/live"),
        (Provider::Douyin, "https://live.douyin.com/../7"),
    ] {
        assert!(parse_resource(p, url).is_err());
    }
}
#[test]
fn broadcast_hash_binds_provider_source_ids_and_provider_start_not_local_clock() {
    let r = resolved();
    assert_eq!(r.metadata.broadcast_id.len(), 64);
    assert_eq!(r.metadata.started_at, 1700000000);
    assert!(!format!("{r:?}").contains("pull-hls"));
    assert_ne!(
        broadcast_id(Provider::TikTok, "7", "9", 1700000000),
        broadcast_id(Provider::Douyin, "7", "9", 1700000000)
    );
    for edit in 0..4 {
        let mut changed = r.clone();
        match edit {
            0 => changed.metadata.resource_id = "8".into(),
            1 => changed.metadata.broadcaster_id = "8".into(),
            2 => changed.metadata.started_at += 1,
            _ => changed.metadata.broadcast_id = "a".repeat(64),
        };
        assert!(changed.validate().is_err());
    }
    assert_eq!(
        parse_response(
            &Resource::TikTokRoom {
                room_id: "7".into()
            },
            &serde_json::to_vec(&room()).unwrap(),
            NOW + 50
        )
        .unwrap()
        .metadata
        .broadcast_id,
        r.metadata.broadcast_id
    );
}
#[test]
fn live_status_access_and_clear_codec_are_positive_gates() {
    let resource = Resource::TikTokRoom {
        room_id: "7".into(),
    };
    for (path, value) in [
        (vec!["data", "status"], json!(4)),
        (vec!["data", "create_time"], Value::Null),
        (
            vec!["data", "stream_url_filtered_info", "is_paid_event"],
            json!(true),
        ),
        (
            vec!["data", "stream_url", "hls_pull_url_params"],
            json!("{\"VCodec\":\"hevc\"}"),
        ),
        (vec!["data", "id_str"], json!("8")),
    ] {
        let mut v = room();
        let mut target = &mut v;
        for key in &path[..path.len() - 1] {
            target = &mut target[*key];
        }
        target[*path.last().unwrap()] = value;
        assert!(parse_response(&resource, &serde_json::to_vec(&v).unwrap(), NOW).is_err());
    }
    assert!(
        parse_response(
            &resource,
            br#"{"status_code":0,"status_code":1,"data":{}}"#,
            NOW
        )
        .is_err()
    );
}
#[test]
fn youtube_requires_exact_public_current_broadcast_and_no_vod_fallback() {
    let resource = Resource::YouTube {
        id: "dQw4w9WgXcQ".into(),
    };
    let v = json!({"_type":"video","extractor_key":"Youtube","id":"dQw4w9WgXcQ","channel_id":"UCabcdefghijklmnopqrstuv","release_timestamp":1700000000,"title":"Synthetic stream","is_live":true,"live_status":"is_live","availability":"public","age_limit":0,"protocol":"m3u8_native","vcodec":"avc1.64001F","acodec":"mp4a.40.2","url":"https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1700000200/id/test/index.m3u8"});
    assert!(parse_youtube_response(&resource, &serde_json::to_vec(&v).unwrap(), NOW).is_ok());
    for (k, value) in [
        ("is_live", json!(false)),
        ("availability", json!("private")),
        ("live_status", json!("post_live")),
        ("release_timestamp", Value::Null),
        ("vcodec", json!("vp09")),
        ("requested_formats", json!([])),
        ("extractor_key", json!("TikTokLive")),
        ("url", json!("https://example.invalid/index.m3u8")),
    ] {
        let mut bad = v.clone();
        bad[k] = value;
        assert!(
            parse_youtube_response(&resource, &serde_json::to_vec(&bad).unwrap(), NOW).is_err()
        );
    }
}
#[test]
fn transport_requests_are_fixed_credential_and_provider_scoped_without_signatures() {
    let r = Resource::TikTokRoom {
        room_id: "7".into(),
    };
    let req = request(&r, None).unwrap();
    req.validate().unwrap();
    assert_eq!(
        req.url().as_str(),
        "https://webcast.tiktok.com/webcast/room/info?aid=1988&room_id=7"
    );
    let c = short_video::Credential::parse(
        short_video::Platform::Douyin,
        "sessionid=fixture-session-123456",
    )
    .unwrap();
    assert!(request(&r, Some(&c)).is_err());
    let req = request(
        &Resource::Douyin {
            web_rid: "7".into(),
        },
        Some(&c),
    )
    .unwrap();
    req.validate().unwrap();
    assert!(
        req.url()
            .as_str()
            .starts_with("https://live.douyin.com/webcast/room/web/enter/?web_rid=7&")
    );
    assert!(!format!("{req:?}").contains("fixture"));
    assert!(!req.url().as_str().contains("signature"));
}
#[test]
fn hls_rolling_graph_rejects_backward_and_expired_windows_and_never_copies_origin() {
    let url = "https://pull-hls-f16-va01.tiktokcdn.com/stage/stream-7/index.m3u8";
    let bytes=b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2.000,\n7.ts\n#EXTINF:2.000,\n8.ts\n";
    let p = parse_playlist(Provider::TikTok, bytes, url).unwrap();
    let mut window = RollingWindow::default();
    window.accept(p.clone()).unwrap();
    let text = p
        .rewrite(|s| {
            Ok(format!(
                "/api/v1/platform-other-live-delivery/session/segments/{}",
                s.sequence
            ))
        })
        .unwrap();
    assert!(!text.contains("tiktokcdn"));
    assert!(!text.contains("ENDLIST"));
    let mut back = p.clone();
    back.sequence = 6;
    back.segments[0].sequence = 6;
    back.segments[1].sequence = 7;
    assert!(window.accept(back).is_err());
    for extra in [
        "#EXT-X-ENDLIST\n",
        "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n",
        "#EXT-X-MAP:URI=\"init.mp4\"\n",
    ] {
        let text = format!("{}{}", std::str::from_utf8(bytes).unwrap(), extra);
        assert!(parse_playlist(Provider::TikTok, text.as_bytes(), url).is_err());
    }
}

#[test]
fn signed_google_paths_keep_valid_opaque_escapes_without_admitting_escaped_resources_or_expiry_overrides()
 {
    let url = "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1700000200/sig/opaque%3D%3D/index.m3u8";
    let parsed = validate_playlist_url(Provider::YouTube, url).unwrap();
    assert_eq!(parsed.as_str(), url);
    assert_eq!(expiry(&parsed, NOW).unwrap(), Some(1700000200));
    assert!(
        expiry(
            &Url::parse(&format!("{url}?expire=1700000300")).unwrap(),
            NOW
        )
        .is_err()
    );
    assert!(
        parse_resource(
            Provider::YouTube,
            "https://www.youtube.com/live/dQw4w9WgX%63Q"
        )
        .is_err()
    );
    assert!(
        validate_playlist_url(
            Provider::YouTube,
            "https://manifest.googlevideo.com/api/manifest/sig/bad%zz/index.m3u8"
        )
        .is_err()
    );
    let playlist=b"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:1.000,\nhttps://r1---sn-fixture.googlevideo.com/videoplayback/sig/opaque%3D/sq/7/file/seg.ts\n";
    assert!(parse_playlist(Provider::YouTube, playlist, url).is_ok());
}
#[test]
fn only_a_complete_unique_terminal_endlist_can_supply_offline_revocation_evidence() {
    let url = "https://pull.tiktokcdn.com/stage/stream-7/index.m3u8";
    let valid = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:1.000,\n7.ts\n#EXT-X-ENDLIST\n";
    assert_eq!(
        parse_playlist(Provider::TikTok, valid.as_bytes(), url).unwrap_err(),
        Error::Restricted("live_broadcast_ended")
    );
    for broken in ["#EXTM3U\n#EXT-X-ENDLIST\n".to_owned(),format!("{valid}#EXT-X-ENDLIST\n"),format!("{valid}trailing corruption\n"),"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:1.000,\n#EXT-X-ENDLIST\n".to_owned()]{assert!(!matches!(parse_playlist(Provider::TikTok,broken.as_bytes(),url),Err(Error::Restricted("live_broadcast_ended"))));}
}
#[test]
fn positively_matched_handle_resolves_to_one_exact_numeric_broadcast_selector() {
    let resolved = parse_response(
        &Resource::TikTokHandle {
            handle: "creator".into(),
        },
        &serde_json::to_vec(&room()).unwrap(),
        NOW,
    )
    .unwrap();
    assert_eq!(
        resolved.metadata.resource,
        Resource::TikTokRoom {
            room_id: "7".into()
        }
    );
    assert_eq!(
        resolved.metadata.canonical(),
        "https://m.tiktok.com/share/live/7"
    );
    assert!(resolved.validate().is_ok());
    assert!(
        parse_response(
            &Resource::TikTokHandle {
                handle: "other".into()
            },
            &serde_json::to_vec(&room()).unwrap(),
            NOW
        )
        .is_err()
    );
    assert_eq!(
        parse_resource(Provider::YouTube, "https://youtube.com/live/dQw4w9WgXcQ")
            .unwrap()
            .canonical(),
        "https://www.youtube.com/live/dQw4w9WgXcQ"
    );
}
