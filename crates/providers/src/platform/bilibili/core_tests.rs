use super::*;
use serde_json::json;
use std::sync::{Arc, Mutex as StdMutex};

const BV: &str = "BV1xx411c7mD";
const CID: &str = "9007199254740993";
const NOW: u64 = 1_700_000_000;
fn bytes(value: Value) -> Vec<u8> {
    serde_json::to_vec(&value).unwrap()
}
fn metadata() -> VideoMetadata {
    VideoMetadata {
        bvid: BV.into(),
        aid: "9007199254740995".into(),
        cid: CID.into(),
        part: 2,
        part_count: 2,
        title: "Bounded VOD".into(),
        part_title: "Part two".into(),
        duration_seconds: 90,
    }
}
fn view_json() -> Value {
    json!({"code":0,"data":{"bvid":BV,"aid":9007199254740995u64,"state":0,"title":"Bounded VOD",
        "rights":{"pay":0,"ugc_pay":0,"arc_pay":0},
        "pages":[{"cid":10001,"page":1,"part":"Part one","duration":60},
                 {"cid":9007199254740993u64,"page":2,"part":"Part two","duration":90}]}})
}
fn nav_json() -> Value {
    json!({"code":-101,"data":{"isLogin":false,"wbi_img":{
        "img_url":"https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
        "sub_url":"https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png"}}})
}
fn video_json() -> Value {
    json!({"id":80,"baseUrl":"https://upos-sz-mirrorcos.bilivideo.com/video.m4s?deadline=1700003600",
        "backupUrl":["https://upos-hz-mirrorakam.akamaized.net/video.m4s?deadline=1700003500"],
        "mimeType":"video/mp4","codecs":"avc1.640028","codecid":7,"bandwidth":1200000,
        "width":1920,"height":1080,"frameRate":"30000/1001","sar":"1:1","startWithSap":1,
        "SegmentBase":{"Initialization":"0-999","indexRange":"1000-1999"}})
}
fn audio_json() -> Value {
    json!({"id":30280,"baseUrl":"https://upos-sz-mirrorcos.bilivideo.com/audio.m4s?deadline=1700003400",
        "backupUrl":[],"mimeType":"audio/mp4","codecs":"mp4a.40.2","bandwidth":192000,
        "audioSamplingRate":"48000","startWithSap":1,
        "SegmentBase":{"Initialization":"0-699","indexRange":"700-899"}})
}
fn play_json() -> Value {
    json!({"code":0,"data":{"bvid":BV,"cid":CID,"quality":80,"timelength":90000,
        "accept_quality":[80,64],"accept_description":["1080P","720P"],
        "support_formats":[{"quality":80,"new_description":"1080P","need_login":true,"need_vip":false},
                           {"quality":64,"new_description":"720P","need_login":false,"need_vip":false}],
        "is_preview":0,"dash":{"duration":90,"minBufferTime":1.5,"video":[video_json()],"audio":[audio_json()]}}})
}

#[test]
fn bilibili_core_strict_canonical_resource_and_part() {
    for input in [
        BV.to_owned(),
        format!("{BV}?p=2"),
        format!("https://www.bilibili.com/video/{BV}/?p=2"),
        "av9007199254740993?p=2".to_owned(),
        "https://m.bilibili.com/video/av9007199254740993?p=2".to_owned(),
    ] {
        let parsed = parse_resource(&input).unwrap();
        assert_eq!(parse_resource(&parsed.canonical()).unwrap(), parsed);
    }
    for input in [
        "av0",
        "av01",
        "av18446744073709551616",
        "BV1xx411c7m",
        "BV1xx411c7mDx",
        "BV1xx411c7m0",
        "bv1xx411c7mD",
        "BV1xx411c7mD?p=0",
        "BV1xx411c7mD?p=01",
        "BV1xx411c7mD?p=10001",
        "BV1xx411c7mD?p=2&p=3",
        "BV1xx411c7mD?%70=2",
        "BV1xx411c7mD?p=2&foo=bar",
        "https://www.bilibili.com.evil.invalid/video/BV1xx411c7mD",
        "https://user@www.bilibili.com/video/BV1xx411c7mD",
        "https://www.bilibili.com/video/BV1xx411c7mD#p=2",
        "http://www.bilibili.com/video/BV1xx411c7mD",
        "https://b23.tv/thing",
        "https://www.bilibili.com/bangumi/play/ep1",
        "https://www.bilibili.com/video/%42V1xx411c7mD",
        " BV1xx411c7mD",
        "BV1xx411c7mD\n",
    ] {
        assert!(parse_resource(input).is_err(), "accepted {input}");
    }
}

#[test]
fn bilibili_core_view_binds_part_and_preserves_large_string_ids() {
    let reference = parse_resource(&format!("{BV}?p=2")).unwrap();
    let actual = parse_view_response(&bytes(view_json()), &reference).unwrap();
    assert_eq!(actual, metadata());
    let av = parse_resource("av9007199254740995?p=2").unwrap();
    assert_eq!(
        parse_view_response(&bytes(view_json()), &av).unwrap().cid,
        CID
    );
    let wrong = parse_resource("av9007199254740994?p=2").unwrap();
    assert!(parse_view_response(&bytes(view_json()), &wrong).is_err());
    for kind in 0..6 {
        let mut value = view_json();
        match kind {
            0 => value["data"]["pages"][1]["cid"] = json!(10001),
            1 => value["data"]["pages"][1]["page"] = json!(1),
            2 => value["data"]["pages"][1]["duration"] = json!(0),
            3 => value["data"]["rights"]["ugc_pay"] = json!(1),
            4 => value["data"]["state"] = json!(-4),
            _ => value["data"]["redirect_url"] = json!("https://www.bilibili.com/bangumi/play/ep1"),
        }
        assert!(parse_view_response(&bytes(value), &reference).is_err());
    }
}

#[test]
fn bilibili_core_json_rejects_duplicates_even_equal_or_escaped() {
    for input in [
        r#"{"code":0,"code":0}"#,
        r#"{"code":0,"\u0063ode":-101}"#,
        r#"{"data":{"cid":1,"cid":2}}"#,
        r#"{"unknown":[{"x":1,"x":1}]}"#,
        r#"{"code":0} {"code":0}"#,
        r#"{"code":NaN}"#,
    ] {
        assert!(strict_json(input.as_bytes(), MAX_BODY).is_err());
    }
    assert_eq!(strict_json(b"{}", 1), Err(Error::TooLarge));
    assert!(strict_json(&vec![b' '; MAX_BODY + 1], usize::MAX).is_err());
    assert!(
        strict_json(
            format!("[{}]", "0,".repeat(10001) + "0").as_bytes(),
            MAX_BODY
        )
        .is_err()
    );
    assert!(
        strict_json(
            format!("{}0{}", "[".repeat(130), "]".repeat(130)).as_bytes(),
            MAX_BODY
        )
        .is_err()
    );
}

#[test]
fn bilibili_core_wbi_signature_matches_fixed_vector() {
    let nav = parse_nav_response(&bytes(nav_json())).unwrap();
    assert!(!nav.is_logged_in);
    assert_eq!(nav.wbi.mixin, "ea1db124af3c7062474693fa704f4ff8");
    let params = signed_playurl_query(&metadata(), 80, &nav.wbi, NOW).unwrap();
    let values = params.into_iter().collect::<BTreeMap<_, _>>();
    assert_eq!(values["wts"], "1700000000");
    assert_eq!(values["w_rid"], "5e8422748f60ab0f73dbd4ba4b29ffbd");
    assert_eq!(values["cid"], CID);
    let mut invalid = nav_json();
    invalid["data"]["wbi_img"]["img_url"] =
        json!("https://evil.invalid/7cd084941338484aae1ad9425b84077c.png");
    assert!(parse_nav_response(&bytes(invalid)).is_err());
}

#[test]
fn bilibili_core_dash_typed_ranges_codecs_qualities_and_expiry() {
    let resolved = parse_playurl_response(&bytes(play_json()), &metadata(), NOW).unwrap();
    assert_eq!(resolved.earliest_expires_at, Some(NOW + 3400));
    assert!(resolved.qualities[0].available);
    assert!(resolved.qualities[0].requires_login);
    assert!(!resolved.qualities[1].available);
    let Playback::Dash(dash) = &resolved.playback else {
        panic!("expected DASH")
    };
    assert_eq!(dash.video[0].codec, VideoCodec::Avc);
    assert_eq!(dash.audio[0].codec, AudioCodec::Aac);
    assert_eq!(
        dash.video[0].segment_base.index_range.to_string(),
        "1000-1999"
    );
    assert_eq!(dash.audio[0].sampling_rate, 48000);
    assert!(!format!("{resolved:?}").contains("bilivideo.com"));
    let mut unknown = play_json();
    unknown["data"]["dash"]["audio"][0]["baseUrl"] =
        json!("https://upos-sz-mirrorcos.bilivideo.com/audio.m4s");
    assert_eq!(
        parse_playurl_response(&bytes(unknown), &metadata(), NOW)
            .unwrap()
            .earliest_expires_at,
        None
    );
}

#[test]
fn bilibili_core_compatible_aliases_agree_or_fail_closed() {
    let mut compatible = play_json();
    let track = &mut compatible["data"]["dash"]["video"][0];
    track["base_url"] = track["baseUrl"].clone();
    track["backup_url"] = track["backupUrl"].clone();
    track["segment_base"] = json!({"initialization":"0-999","index_range":"1000-1999"});
    assert!(parse_playurl_response(&bytes(compatible.clone()), &metadata(), NOW).is_ok());
    compatible["data"]["dash"]["video"][0]["base_url"] =
        json!("https://upos-sz-mirrorcos.bilivideo.com/other.m4s?deadline=1700003600");
    assert!(parse_playurl_response(&bytes(compatible), &metadata(), NOW).is_err());
}

#[test]
fn bilibili_core_rejects_restrictions_preview_drm_and_invalid_tracks() {
    for (key, value) in [
        ("is_preview", json!(1)),
        ("is_drm", json!(true)),
        ("drm_tech_type", json!(1)),
        ("drm_info", json!({"license_url":"https://license.invalid"})),
        ("need_login", json!(true)),
        ("need_vip", json!(1)),
        ("can_play", json!(false)),
    ] {
        let mut response = play_json();
        response["data"][key] = value;
        assert!(matches!(
            parse_playurl_response(&bytes(response), &metadata(), NOW),
            Err(Error::Restricted(_))
        ));
    }
    for kind in 0..12 {
        let mut response = play_json();
        match kind {
            0 => response["data"]["timelength"] = json!(10000),
            1 => response["data"]["dash"]["duration"] = json!(88),
            2 => response["data"]["cid"] = json!("9999"),
            3 => response["data"]["dash"]["video"][0]["width"] = json!(0),
            4 => response["data"]["dash"]["video"][0]["frameRate"] = json!("30/0"),
            5 => response["data"]["dash"]["video"][0]["codecid"] = json!(12),
            6 => {
                response["data"]["dash"]["video"][0]["SegmentBase"]["indexRange"] =
                    json!("999-1999")
            }
            7 => response["data"]["dash"]["audio"][0]["audioSamplingRate"] = json!("NaN"),
            8 => response["data"]["accept_quality"] = json!([80, 80]),
            9 => {
                let duplicate = response["data"]["dash"]["video"][0].clone();
                response["data"]["dash"]["video"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            10 => {
                response["data"]["dash"]["video"][0]["baseUrl"] =
                    json!("https://bilivideo.com.evil.invalid/media.m4s")
            }
            _ => {
                response["data"]["dash"]["video"][0]["SegmentBase"]["indexRange"] =
                    json!("1000-99999999999")
            }
        }
        assert!(
            parse_playurl_response(&bytes(response), &metadata(), NOW).is_err(),
            "case {kind}"
        );
    }
    for code in [-101, -401, -403, -404, 62002] {
        assert!(matches!(
            parse_playurl_response(&bytes(json!({"code":code})), &metadata(), NOW),
            Err(Error::Restricted(_))
        ));
    }
}

#[test]
fn bilibili_core_progressive_preserves_all_ordered_segments() {
    let response = json!({"code":0,"data":{"quality":80,"timelength":90000,"format":"mp4",
        "accept_quality":[80],"accept_description":["1080P"],"durl":[
        {"order":1,"length":40000,"size":400000,"url":"https://cdn.bilivideo.com/one.mp4?deadline=1700003600","backup_url":[]},
        {"order":2,"length":50000,"size":500000,"url":"https://cdn.bilivideo.com/two.mp4?deadline=1700003700","backup_url":[]}]}});
    let resolved = parse_playurl_response(&bytes(response.clone()), &metadata(), NOW).unwrap();
    let Playback::Progressive { segments, .. } = resolved.playback else {
        panic!("expected progressive")
    };
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[1].duration_ms, 50000);
    let mut wrong = response;
    wrong["data"]["durl"][1]["order"] = json!(1);
    assert!(parse_playurl_response(&bytes(wrong), &metadata(), NOW).is_err());
}

#[test]
fn bilibili_core_cdn_url_origin_queries_and_expiry_are_bounded() {
    assert_eq!(
        parse_media_url(
            "https://cdn.bilivideo.com/v.m4s?deadline=1700000100&wsTime=6553f228",
            NOW
        )
        .unwrap()
        .expires_at,
        Some(NOW + 100)
    );
    for target in [
        "http://cdn.bilivideo.com/v.m4s",
        "https://user:pass@cdn.bilivideo.com/v.m4s",
        "https://127.0.0.1/v.m4s",
        "https://bilivideo.com.evil.invalid/v.m4s",
        "https://evilbilivideo.com/v.m4s",
        "https://cdn.bilivideo.com:444/v.m4s",
        "https://cdn.bilivideo.com/v.m4s?deadline=1700000000",
        "https://cdn.bilivideo.com/v.m4s?deadline=garbage",
        "https://cdn.bilivideo.com/v.m4s?deadline=1700000100&deadline=1700000200",
        "https://cdn.bilivideo.com/v.m4s#secret",
    ] {
        assert!(parse_media_url(target, NOW).is_err(), "accepted {target}");
    }
}

fn login_cookie() -> Cookie {
    Cookie::from_header("SESSDATA=opaque-session; DedeUserID=123; bili_jct=opaque-csrf").unwrap()
}
#[test]
fn bilibili_core_credentials_and_qr_capabilities_are_redacted_and_scoped() {
    let cookie = login_cookie();
    assert!(!format!("{cookie:?}").contains("opaque"));
    for endpoint in [Endpoint::View, Endpoint::Nav, Endpoint::PlayUrl] {
        let request = ApiRequest::new(endpoint, &[], Some(&cookie));
        assert_eq!(request.url().host_str(), Some("api.bilibili.com"));
        assert!(request.headers().contains_key("Cookie"));
        assert!(!format!("{request:?}").contains("opaque"));
    }
    for endpoint in [Endpoint::QrGenerate, Endpoint::QrPoll] {
        assert!(
            !ApiRequest::new(endpoint, &[], Some(&cookie))
                .headers()
                .contains_key("Cookie")
        );
    }
    for header in [
        "SESSDATA=x\r\nX-Header: injected; DedeUserID=123",
        "SESSDATA=x; DedeUserID=01",
        "SESSDATA=x; DedeUserID=123; EvilCookie=y",
        "SESSDATA=x; DedeUserID=123; SESSDATA=x",
        "DedeUserID=123",
    ] {
        assert!(Cookie::from_header(header).is_err());
    }
    let key = QrKey::from_secret("abcdefghijklmnop0123456789").unwrap();
    let request = qr_poll_request(&key);
    assert!(!format!("{request:?}").contains(key.expose_for_storage()));
    assert_eq!(request.url().path(), "/x/passport-login/web/qrcode/poll");
}

#[test]
fn bilibili_core_qr_parser_binds_state_and_captures_only_confirmed_cookie() {
    let key = "abcdefghijklmnop0123456789";
    let generated = json!({"code":0,"data":{"url":format!("https://passport.bilibili.com/h5-app/passport/login?oauthKey={key}&source=main_web"),"qrcode_key":key}});
    let challenge = parse_qr_generate_response(&bytes(generated)).unwrap();
    assert_eq!(challenge.key.expose_for_storage(), key);
    let cookies = vec![
        "SESSDATA=opaque-session; Domain=.bilibili.com; Path=/; Secure; HttpOnly".into(),
        "DedeUserID=123; Domain=.bilibili.com; Path=/; Secure".into(),
    ];
    for (code, expected) in [
        (86101, QrState::Waiting),
        (86090, QrState::Scanned),
        (86038, QrState::Expired),
    ] {
        let result =
            parse_qr_poll_response(&bytes(json!({"code":0,"data":{"code":code}})), &cookies)
                .unwrap();
        assert_eq!(result.state, expected);
        assert!(result.session.is_none());
    }
    let confirmed = bytes(json!({"code":0,"data":{"code":0}}));
    assert!(
        parse_qr_poll_response(&confirmed, &cookies)
            .unwrap()
            .session
            .is_some()
    );
    assert!(parse_qr_poll_response(&confirmed, &[]).is_err());
    for domain in ["evil.invalid", "passport.bilibili.com", "api.bilibili.com"] {
        let bad = vec![
            format!("SESSDATA=x; Domain={domain}; Path=/"),
            cookies[1].clone(),
        ];
        assert!(parse_qr_poll_response(&confirmed, &bad).is_err());
    }
    let wrong = bytes(
        json!({"code":0,"data":{"url":"https://passport.bilibili.com/h5-app/passport/login?oauthKey=other","qrcode_key":key}}),
    );
    assert!(parse_qr_generate_response(&wrong).is_err());
}

#[derive(Clone)]
struct FixtureTransport {
    responses: Arc<StdMutex<FixtureResponses>>,
    seen: Arc<StdMutex<Vec<Endpoint>>>,
}
type FixtureResponses = Vec<(Endpoint, Vec<u8>)>;
impl FixtureTransport {
    fn new(responses: Vec<(Endpoint, Vec<u8>)>) -> Self {
        Self {
            responses: Arc::new(StdMutex::new(responses.into_iter().rev().collect())),
            seen: Arc::new(StdMutex::new(Vec::new())),
        }
    }
}
impl Transport for FixtureTransport {
    fn get<'a>(
        &'a self,
        request: ApiRequest,
        _: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + 'a>> {
        Box::pin(async move {
            self.seen.lock().unwrap().push(request.endpoint());
            let url = request.url();
            if request.endpoint() == Endpoint::PlayUrl {
                assert_eq!(url.host_str(), Some("api.bilibili.com"));
                assert_eq!(url.path(), "/x/player/wbi/playurl");
                let params = url.query_pairs().collect::<BTreeMap<_, _>>();
                assert_eq!(params["bvid"], BV);
                assert_eq!(params["cid"], CID);
                assert_eq!(params["fnval"], "4048");
                assert_eq!(params["w_rid"].len(), 32);
                assert!(params["wts"].parse::<u64>().unwrap() > 0);
            }
            let (endpoint, body) = self
                .responses
                .lock()
                .unwrap()
                .pop()
                .expect("unexpected additional upstream request");
            assert_eq!(endpoint, request.endpoint());
            Ok(ApiResponse {
                status: 200,
                body,
                set_cookie: Vec::new(),
            })
        })
    }
}

#[tokio::test]
async fn bilibili_core_client_resolves_fixture_and_reuses_wbi_cache() {
    let expiry = unix_seconds().unwrap() + 7200;
    let mut play = play_json();
    play["data"]["dash"]["video"][0]["baseUrl"] = json!(format!(
        "https://cdn.bilivideo.com/video.m4s?deadline={expiry}"
    ));
    play["data"]["dash"]["video"][0]["backupUrl"] = json!([]);
    play["data"]["dash"]["audio"][0]["baseUrl"] = json!(format!(
        "https://cdn.bilivideo.com/audio.m4s?deadline={expiry}"
    ));
    let fixture = FixtureTransport::new(vec![
        (Endpoint::View, bytes(view_json())),
        (Endpoint::Nav, bytes(nav_json())),
        (Endpoint::PlayUrl, bytes(play.clone())),
        (Endpoint::View, bytes(view_json())),
        (Endpoint::PlayUrl, bytes(play)),
    ]);
    let client = Client::new(fixture.clone(), Some(login_cookie()));
    for _ in 0..2 {
        let result = client
            .resolve(
                &format!("{BV}?p=2"),
                80,
                Instant::now() + Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert_eq!(result.metadata, metadata());
        assert_eq!(result.earliest_expires_at, Some(expiry));
        assert!(matches!(result.playback, Playback::Dash(_)));
    }
    assert_eq!(
        *fixture.seen.lock().unwrap(),
        vec![
            Endpoint::View,
            Endpoint::Nav,
            Endpoint::PlayUrl,
            Endpoint::View,
            Endpoint::PlayUrl
        ]
    );
}

#[tokio::test]
async fn bilibili_core_client_refresh_is_bounded_and_permission_is_not_retried() {
    let fixture = FixtureTransport::new(vec![
        (Endpoint::View, bytes(view_json())),
        (Endpoint::Nav, bytes(nav_json())),
        (Endpoint::PlayUrl, bytes(json!({"code":-352}))),
        (Endpoint::Nav, bytes(nav_json())),
        (Endpoint::PlayUrl, bytes(json!({"code":-352}))),
    ]);
    let client = Client::new(fixture.clone(), None);
    let result = client
        .resolve(
            &format!("{BV}?p=2"),
            80,
            Instant::now() + Duration::from_secs(2),
        )
        .await;
    assert_eq!(result.unwrap_err(), Error::Api(-352));
    assert_eq!(fixture.seen.lock().unwrap().len(), 5);
    let fixture = FixtureTransport::new(vec![
        (Endpoint::View, bytes(view_json())),
        (Endpoint::Nav, bytes(nav_json())),
        (Endpoint::PlayUrl, bytes(json!({"code":-401}))),
    ]);
    let client = Client::new(fixture.clone(), None);
    assert!(matches!(
        client
            .resolve(
                &format!("{BV}?p=2"),
                80,
                Instant::now() + Duration::from_secs(2)
            )
            .await,
        Err(Error::Restricted(_))
    ));
    assert_eq!(fixture.seen.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn bilibili_core_deadline_and_metadata_do_not_open_media_or_login() {
    let fixture = FixtureTransport::new(Vec::new());
    let client = Client::new(fixture.clone(), None);
    assert_eq!(
        client.resolve(BV, 80, Instant::now()).await.unwrap_err(),
        Error::Deadline
    );
    assert!(fixture.seen.lock().unwrap().is_empty());
    let fixture = FixtureTransport::new(vec![(Endpoint::View, bytes(view_json()))]);
    let client = Client::new(fixture.clone(), None);
    assert_eq!(
        client
            .view(
                &parse_resource(&format!("{BV}?p=2")).unwrap(),
                Instant::now() + Duration::from_secs(2)
            )
            .await
            .unwrap(),
        metadata()
    );
    assert_eq!(*fixture.seen.lock().unwrap(), vec![Endpoint::View]);
}

#[test]
fn live_danmaku_wbi_uses_legitimate_nav_keys_and_fixed_parameter_set() {
    let nav = parse_nav_response(&bytes(nav_json())).unwrap();
    let pairs = signed_live_danmaku_query(123, &nav.wbi, NOW).unwrap();
    assert_eq!(
        pairs,
        vec![
            ("id".into(), "123".into()),
            ("type".into(), "0".into()),
            ("web_location".into(), "444.8".into()),
            ("wts".into(), NOW.to_string()),
            ("w_rid".into(), "cdccf0ea22324c5378b8c62c9649d9e3".into())
        ]
    );
    assert!(signed_live_danmaku_query(0, &nav.wbi, NOW).is_err());
}
