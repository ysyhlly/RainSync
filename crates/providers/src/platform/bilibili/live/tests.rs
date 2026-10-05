use super::*;
use serde_json::json;
use std::sync::{Arc, Mutex};
const NOW: u64 = 1_700_000_000;
fn bytes(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap()
}
fn metadata_json() -> Value {
    json!({"code":0,"data":{"room_id":1234,"short_id":12,"uid":5678,"title":"Synthetic live room","live_status":1,"live_time":"2023-11-15 06:13:20"}})
}
fn metadata() -> Metadata {
    parse_metadata_response(
        &bytes(&metadata_json()),
        &parse_resource("https://live.bilibili.com/12").unwrap(),
    )
    .unwrap()
}
fn play_json() -> Value {
    json!({"code":0,"data":{"room_id":1234,"uid":5678,"live_status":1,"live_time":1700000000,"playurl_info":{"playurl":{"stream":[{"protocol_name":"http_hls","format":[{"format_name":"ts","codec":[{"codec_name":"avc","current_qn":150,"accept_qn":[150,80],"base_url":"/live-bvc/123/live_5678_1234.m3u8?","url_info":[{"host":"https://cn-gotcha01.bilivideo.com","extra":"expires=1700003600&sign=synthetic","stream_ttl":3600}]}]}]}]}}}})
}
fn playlist(seq: u64) -> String {
    format!(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:{seq}\n#EXT-X-DISCONTINUITY-SEQUENCE:0\n#EXTINF:2.000,\n{seq}.ts?sign=synthetic\n#EXTINF:2.000,\n{}.ts?sign=synthetic\n",
        seq + 1
    )
}
const ROOT: &str = "https://cn-gotcha01.bilivideo.com/live-bvc/123/live_5678_1234.m3u8?expires=1700003600&sign=synthetic";
#[test]
fn exact_live_resources_do_not_enter_vod() {
    for input in [
        "https://live.bilibili.com/123",
        "https://live.bilibili.com/blanc/123/",
    ] {
        let r = parse_resource(input).unwrap();
        assert_eq!(r.canonical(), "https://live.bilibili.com/123");
        assert!(super::super::parse_resource(input).is_err());
        assert!(super::super::pgc::parse_resource(input).is_err());
    }
    for input in [
        "123",
        "live123",
        "http://live.bilibili.com/123",
        "https://LIVE.bilibili.com/123",
        "https://live.bilibili.com:443/123",
        "https://live.bilibili.com/01",
        "https://live.bilibili.com/0",
        "https://live.bilibili.com/123?a=1",
        "https://live.bilibili.com/123#x",
        "https://live.bilibili.com/x/../123",
        "https://live.bilibili.com/%31",
        "https://user@live.bilibili.com/123",
        "https://live.bilibili.com.evil.invalid/123",
        "https://live.bilibili.com/123/456",
    ] {
        assert!(parse_resource(input).is_err(), "{input}");
    }
}
#[test]
fn metadata_requires_current_canonical_broadcast_identity() {
    let m = metadata();
    assert_eq!(m.room_id, "1234");
    assert_eq!(m.started_at, NOW);
    assert_eq!(m.broadcast_id, "1234:5678:1700000000");
    for (field, value) in [
        ("live_status", json!(0)),
        ("live_status", json!(2)),
        ("live_time", json!("0000-00-00 00:00:00")),
        ("live_time", json!("2023-02-29 00:00:00")),
        ("short_id", json!(99)),
        ("encrypted", json!(true)),
        ("is_hidden", json!(1)),
        ("need_pay", json!(true)),
    ] {
        let mut v = metadata_json();
        v["data"][field] = value;
        assert!(
            parse_metadata_response(
                &bytes(&v),
                &parse_resource("https://live.bilibili.com/12").unwrap()
            )
            .is_err(),
            "{field}"
        );
    }
    assert!(
        parse_metadata_response(
            b"{\"code\":0,\"code\":0}",
            &parse_resource("https://live.bilibili.com/12").unwrap()
        )
        .is_err()
    );
}
#[test]
fn resolve_response_is_clear_hls_only_same_broadcast() {
    let m = metadata();
    let r = parse_playurl_response(&bytes(&play_json()), &m, NOW).unwrap();
    assert_eq!(r.current_quality, 150);
    assert_eq!(r.expires_at, Some(NOW + 3600));
    assert!(!format!("{r:?}").contains("sign=synthetic"));
    for (path, value) in [
        ("/data/live_time", json!(NOW + 1)),
        ("/data/room_id", json!(1235)),
        ("/data/live_status", json!(2)),
        (
            "/data/playurl_info/playurl/stream/0/protocol_name",
            json!("http_stream"),
        ),
        (
            "/data/playurl_info/playurl/stream/0/format/0/format_name",
            json!("fmp4"),
        ),
        (
            "/data/playurl_info/playurl/stream/0/format/0/codec/0/codec_name",
            json!("hevc"),
        ),
        (
            "/data/playurl_info/playurl/stream/0/format/0/codec/0/current_qn",
            json!(400),
        ),
        (
            "/data/playurl_info/playurl/stream/0/format/0/codec/0/base_url",
            json!("/vod/123.m3u8?"),
        ),
        (
            "/data/playurl_info/playurl/stream/0/format/0/codec/0/url_info/0/host",
            json!("https://cdn.example"),
        ),
        (
            "/data/playurl_info/playurl/stream/0/format/0/codec/0/url_info/0/extra",
            json!("expires=1700000000"),
        ),
        (
            "/data/playurl_info/playurl/stream/0/format/0/codec/0/url_info/0/extra",
            json!("expires=1700003600&expires=1700003600"),
        ),
    ] {
        let mut v = play_json();
        *v.pointer_mut(path).unwrap() = value;
        assert!(
            parse_playurl_response(&bytes(&v), &m, NOW).is_err(),
            "{path}"
        );
    }
    for name in [
        "drm",
        "license_url",
        "encrypted",
        "need_login",
        "need_vip",
        "need_pay",
        "is_preview",
        "is_trial",
        "area_limit",
    ] {
        let mut v = play_json();
        v["data"][name] = json!(1);
        assert!(
            parse_playurl_response(&bytes(&v), &m, NOW).is_err(),
            "{name}"
        );
    }
}
#[test]
fn live_cdn_is_narrower_than_vod() {
    assert!(validate_playlist_url(ROOT).is_ok());
    for url in [
        "https://bilivideo.com/live-bvc/123/a.m3u8",
        "https://cdn.bilivideo.com.evil.invalid/live-bvc/123/a.m3u8",
        "https://i0.hdslb.com/live-bvc/123/a.m3u8",
        "https://cdn.bilivideo.cn/live-bvc/123/a.m3u8",
        "http://cn.bilivideo.com/live-bvc/123/a.m3u8",
        "https://cn.bilivideo.com:443/live-bvc/123/a.m3u8",
        "https://cn.bilivideo.com/live-bvc/123/../a.m3u8",
        "https://cn.bilivideo.com/live-bvc/%31/a.m3u8",
        "https://cn.bilivideo.com/upgcxcode/a.m3u8",
        "https://cn.bilivideo.com/live-bvc/123/a.m3u8#x",
    ] {
        assert!(validate_playlist_url(url).is_err(), "{url}");
    }
}
#[test]
fn rolling_playlist_closed_rewrite_never_leaks_addresses() {
    let p = parse_playlist(playlist(10).as_bytes(), ROOT).unwrap();
    assert_eq!(p.segments[0].sequence, 10);
    assert_eq!(p.target_duration_ms, 2000);
    let rendered = p
        .rewrite(|s| {
            Ok(format!(
                "/api/playback/test/live/segment/{}-{}?token=synthetic",
                s.sequence, s.discontinuity
            ))
        })
        .unwrap();
    assert!(rendered.contains("#EXT-X-MEDIA-SEQUENCE:10"));
    assert!(!rendered.contains("bilivideo"));
    assert!(!rendered.contains("#EXT-X-ENDLIST"));
    assert!(!format!("{p:?}").contains("sign=synthetic"));
    assert!(
        p.rewrite(|_| Ok("https://cdn.example/a.ts".into()))
            .is_err()
    );
    assert!(p.rewrite(|_| Ok("//evil.invalid/a.ts".into())).is_err());
}
#[test]
fn terminal_endlist_requires_a_complete_valid_playlist_and_unique_final_marker() {
    let ended = format!("{}#EXT-X-ENDLIST\n", playlist(10));
    assert!(matches!(
        parse_playlist(ended.as_bytes(), ROOT),
        Err(Error::Restricted("live_broadcast_ended"))
    ));
    for invalid in [
        "#EXTM3U\n#EXT-X-ENDLIST\n".to_owned(),
        format!("{ended}#EXT-X-ENDLIST\n"),
        format!("{ended}#EXTINF:2.000,\n12.ts\n"),
        ended.replace("#EXTINF:2.000,", "#EXTINF:bad,"),
        ended.replace("10.ts", "https://evil.invalid/10.ts"),
    ] {
        let result = parse_playlist(invalid.as_bytes(), ROOT);
        assert!(result.is_err());
        assert!(!matches!(
            result,
            Err(Error::Restricted("live_broadcast_ended"))
        ));
    }
}
#[test]
fn all_unsupported_playlist_network_features_fail_closed() {
    for tag in [
        "#EXT-X-KEY:METHOD=NONE",
        "#EXT-X-KEY:METHOD=AES-128,URI=\"https://evil.invalid/key\"",
        "#EXT-X-MAP:URI=\"a.mp4\"",
        "#EXT-X-PART:DURATION=1,URI=\"a.ts\"",
        "#EXT-X-BYTERANGE:100@0",
        "#EXT-X-STREAM-INF:BANDWIDTH=1",
        "#EXT-X-MEDIA:TYPE=AUDIO,URI=\"a.m3u8\"",
        "#EXT-X-DEFINE:NAME=\"x\",VALUE=\"y\"",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-GAP",
        "#EXT-X-START:TIME-OFFSET=0",
        "#EXT-X-ENDLIST",
    ] {
        let input = playlist(10).replace("#EXTINF:2.000,", &format!("{tag}\n#EXTINF:2.000,"));
        assert!(parse_playlist(input.as_bytes(), ROOT).is_err(), "{tag}");
    }
    for reference in [
        "https://evil.invalid/live-bvc/123/10.ts",
        "//cn-gotcha01.bilivideo.com/live-bvc/123/10.ts",
        "../10.ts",
        "%31%30.ts",
        "/live-bvc/999/10.ts",
        "a.m3u8",
        "{$token}.ts",
    ] {
        let input = playlist(10).replacen("10.ts?sign=synthetic", reference, 1);
        assert!(
            parse_playlist(input.as_bytes(), ROOT).is_err(),
            "{reference}"
        );
    }
}
#[test]
fn rolling_sequence_and_discontinuity_fences() {
    let mut window = RollingWindow::default();
    window
        .accept(parse_playlist(playlist(10).as_bytes(), ROOT).unwrap())
        .unwrap();
    window
        .accept(parse_playlist(playlist(11).as_bytes(), ROOT).unwrap())
        .unwrap();
    assert!(window.segment(10, 0).is_none());
    assert!(window.segment(11, 0).is_some());
    assert!(
        window
            .accept(parse_playlist(playlist(10).as_bytes(), ROOT).unwrap())
            .is_err()
    );
    assert!(
        window
            .accept(parse_playlist(playlist(14).as_bytes(), ROOT).unwrap())
            .is_err()
    );
    for mutate in [
        playlist(11).replacen("11.ts", "changed.ts", 1),
        playlist(11).replacen("2.000", "1.000", 1),
        playlist(11).replace("DISCONTINUITY-SEQUENCE:0", "DISCONTINUITY-SEQUENCE:1"),
    ] {
        assert!(
            window
                .accept(parse_playlist(mutate.as_bytes(), ROOT).unwrap())
                .is_err()
        );
    }
    let next = playlist(12).replace("#EXTINF:2.000,", "#EXT-X-DISCONTINUITY\n#EXTINF:2.000,");
    assert!(
        window
            .accept(parse_playlist(next.as_bytes(), ROOT).unwrap())
            .is_err()
    );
}
#[test]
fn pdt_is_validated_without_claiming_frame_alignment() {
    let input = playlist(10).replacen(
        "#EXTINF:",
        "#EXT-X-PROGRAM-DATE-TIME:2023-11-15T06:13:20+08:00\n#EXTINF:",
        1,
    );
    let p = parse_playlist(input.as_bytes(), ROOT).unwrap();
    assert_eq!(p.segments[0].program_date_time_ms, Some(NOW as i64 * 1000));
    assert_eq!(
        p.segments[1].program_date_time_ms,
        Some(NOW as i64 * 1000 + 2000)
    );
    assert!(
        !p.rewrite(|s| Ok(format!("/live/{}.ts", s.sequence)))
            .unwrap()
            .contains("PROGRAM-DATE-TIME")
    );
    for time in [
        "2023-02-29T06:13:20Z",
        "2023-11-15T26:13:20Z",
        "2023-11-15T06:13:60Z",
        "2023-11-15T06:13:20+15:00",
        "2023-11-15T06:13:20.0001Z",
    ] {
        let bad = input.replace("2023-11-15T06:13:20+08:00", time);
        assert!(parse_playlist(bad.as_bytes(), ROOT).is_err(), "{time}");
    }
}
struct Fixture(Arc<Mutex<Vec<Request>>>);
impl Transport for Fixture {
    fn get_live<'a>(
        &'a self,
        request: Request,
        _deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>> {
        Box::pin(async move {
            let body = if request.endpoint() == Endpoint::RoomInfo {
                bytes(&metadata_json())
            } else {
                let mut value = play_json();
                value["data"]["playurl_info"]["playurl"]["stream"][0]["format"][0]["codec"][0]["url_info"]
                    [0]["extra"] =
                    json!(format!("expires={}&sign=synthetic", unix_seconds()? + 300));
                bytes(&value)
            };
            self.0.lock().unwrap().push(request);
            Ok(Response { status: 200, body })
        })
    }
}
#[tokio::test]
async fn client_fences_changed_broadcast_before_play_api() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let client = Client::new(Fixture(requests.clone()), None);
    assert!(
        client
            .resolve(
                "https://live.bilibili.com/12",
                Some("1234:5678:1699999999"),
                Instant::now() + std::time::Duration::from_secs(1)
            )
            .await
            .is_err()
    );
    let calls = requests.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].endpoint(), Endpoint::RoomInfo);
}

#[test]
fn constructed_graphs_cannot_bypass_parser_fences() {
    let good = parse_playlist(playlist(10).as_bytes(), ROOT).unwrap();
    let mut altered = good.clone();
    altered.segments[0].sequence = 99;
    assert!(altered.validate().is_err());
    assert!(altered.rewrite(|_| Ok("/live/segment.ts".into())).is_err());
    assert!(RollingWindow::default().accept(altered).is_err());
    let mut altered = good.clone();
    altered.segments[1].url = "https://other.bilivideo.com/live-bvc/123/11.ts".into();
    assert!(altered.validate().is_err());
    let mut altered = good.clone();
    altered.segments[0].duration_ms = 0;
    assert!(altered.validate().is_err());
    let mut altered = good;
    altered.target_duration_ms = 2001;
    assert!(altered.validate().is_err());
}
#[test]
fn playlist_explicit_bounds_duplicates_and_partial_records() {
    for input in [
        playlist(10).replace("#EXT-X-MEDIA-SEQUENCE:10\n", ""),
        playlist(10).replace("#EXT-X-TARGETDURATION:2", "#EXT-X-TARGETDURATION:31"),
        playlist(10).replace(
            "#EXT-X-MEDIA-SEQUENCE:10",
            "#EXT-X-MEDIA-SEQUENCE:9007199254740991",
        ),
        playlist(10).replace("#EXT-X-VERSION:3", "#EXT-X-VERSION:3\n#EXT-X-VERSION:3"),
        playlist(10).replace("11.ts?sign=synthetic", "10.ts?different=synthetic"),
        playlist(10) + "#EXTINF:2.000,\n",
        playlist(10) + "#EXT-X-DISCONTINUITY\n",
        playlist(10).replacen("#EXTINF:2.000,", "#EXTINF:2.0001,", 1),
    ] {
        assert!(parse_playlist(input.as_bytes(), ROOT).is_err(), "{input}");
    }
    assert!(parse_playlist(&vec![b'x'; MAX_PLAYLIST_BYTES + 1], ROOT).is_err());
    let mut bounded = String::from("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n");
    for n in 0..91 {
        bounded += &format!("#EXTINF:2.000,\n{n}.ts\n");
    }
    assert!(parse_playlist(bounded.as_bytes(), ROOT).is_err());
}
#[test]
fn discontinuity_increment_is_admitted_only_on_new_sequences() {
    let mut window = RollingWindow::default();
    window
        .accept(parse_playlist(playlist(10).as_bytes(), ROOT).unwrap())
        .unwrap();
    let next = playlist(11).replacen(
        "#EXTINF:2.000,\n12.ts",
        "#EXT-X-DISCONTINUITY\n#EXTINF:2.000,\n12.ts",
        1,
    );
    let parsed = parse_playlist(next.as_bytes(), ROOT).unwrap();
    assert_eq!(parsed.segments[1].discontinuity, 1);
    window.accept(parsed).unwrap();
    let advanced = playlist(12).replace("DISCONTINUITY-SEQUENCE:0", "DISCONTINUITY-SEQUENCE:1");
    window
        .accept(parse_playlist(advanced.as_bytes(), ROOT).unwrap())
        .unwrap();
    assert!(window.segment(12, 0).is_none());
    assert!(window.segment(12, 1).is_some());
}
#[test]
fn pdt_contradiction_inside_a_continuity_fails() {
    let input = playlist(10)
        .replacen(
            "#EXTINF:",
            "#EXT-X-PROGRAM-DATE-TIME:2023-11-15T06:13:20+08:00\n#EXTINF:",
            1,
        )
        .replacen(
            "#EXTINF:2.000,\n11.ts",
            "#EXT-X-PROGRAM-DATE-TIME:2023-11-15T06:13:25+08:00\n#EXTINF:2.000,\n11.ts",
            1,
        );
    assert!(parse_playlist(input.as_bytes(), ROOT).is_err());
}
#[test]
fn fixed_api_selectors_and_redaction_are_closed() {
    let m = metadata();
    let cookie = Cookie::from_header("SESSDATA=synthetic; DedeUserID=42").unwrap();
    let mut request = play_request(&m, Some(&cookie)).unwrap();
    assert!(request.validate().is_ok());
    assert!(
        request
            .url()
            .as_str()
            .contains("protocol=1&format=1&codec=0&qn=150")
    );
    assert!(!format!("{request:?}").contains("synthetic"));
    request.url.query_pairs_mut().append_pair("qn", "10000");
    assert!(request.validate().is_err());
    let mut request = play_request(&m, None).unwrap();
    request.url.set_host(Some("api.bilibili.com")).unwrap();
    assert!(request.validate().is_err());
    let response = Response {
        status: 200,
        body: b"synthetic-private-body".to_vec(),
    };
    assert!(!format!("{response:?}").contains("private-body"));
}

#[tokio::test]
async fn verified_metadata_has_exactly_one_play_info_request() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let client = Client::new(Fixture(calls.clone()), None);
    let resolved = client
        .resolve_metadata(
            &metadata(),
            Instant::now() + std::time::Duration::from_secs(1),
        )
        .await
        .unwrap();
    assert_eq!(resolved.metadata.broadcast_id, metadata().broadcast_id);
    let requests = calls.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].endpoint(), Endpoint::PlayInfo);
}
#[test]
fn fresh_cdn_expiry_validation_rejects_expired_and_duplicate_values() {
    let now = unix_seconds().unwrap();
    let expired = validate_segment_url(&format!(
        "https://cn.bilivideo.com/live-bvc/1/a.ts?expires={now}"
    ))
    .unwrap();
    assert!(media_remaining_seconds(&expired).is_err());
    let duplicate = validate_segment_url(&format!(
        "https://cn.bilivideo.com/live-bvc/1/a.ts?expires={}&expires={}",
        now + 300,
        now + 300
    ))
    .unwrap();
    assert!(media_remaining_seconds(&duplicate).is_err());
    let fresh = validate_segment_url(&format!(
        "https://cn.bilivideo.com/live-bvc/1/a.ts?expires={}",
        now + 300
    ))
    .unwrap();
    assert!(
        media_remaining_seconds(&fresh)
            .unwrap()
            .is_some_and(|s| s <= 300 && s > 0)
    );
}

#[test]
fn expired_rolling_window_is_distinct_from_corruption_and_requires_a_new_grant() {
    let mut window = RollingWindow::default();
    window
        .accept(parse_playlist(playlist(10).as_bytes(), ROOT).unwrap())
        .unwrap();
    let previous = window.latest().unwrap().clone();
    assert_eq!(
        window.accept(parse_playlist(playlist(20).as_bytes(), ROOT).unwrap()),
        Err(Error::Restricted("live_window_expired"))
    );
    assert_eq!(window.latest(), Some(&previous));
    assert_eq!(
        window.accept(parse_playlist(playlist(9).as_bytes(), ROOT).unwrap()),
        Err(Error::Restricted("live_sequence_fence_changed"))
    );
    let impossible = playlist(20).replace("DISCONTINUITY-SEQUENCE:0", "DISCONTINUITY-SEQUENCE:100");
    assert_eq!(
        window.accept(parse_playlist(impossible.as_bytes(), ROOT).unwrap()),
        Err(Error::Restricted("live_discontinuity_fence_changed"))
    );
    let corrupt = playlist(10).replacen("10.ts", "changed.ts", 1);
    assert_eq!(
        window.accept(parse_playlist(corrupt.as_bytes(), ROOT).unwrap()),
        Err(Error::Restricted("live_segment_fence_changed"))
    );
    let mut fresh = RollingWindow::default();
    fresh
        .accept(parse_playlist(playlist(20).as_bytes(), ROOT).unwrap())
        .unwrap();
    assert_eq!(fresh.latest().unwrap().sequence, 20);
}
