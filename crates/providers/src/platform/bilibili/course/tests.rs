use super::*;
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const EP: &str = "9007199254740993";
const AID: &str = "9007199254740994";
const CID: &str = "9007199254740995";
const NOW: u64 = 1_700_000_000;
const INIT: &[u8] = include_bytes!("fixtures/audio-init-aac44100.mp4");
fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
fn reference() -> EpisodeRef {
    parse_resource(&format!("course:ep{EP}")).unwrap()
}
fn metadata_json() -> Value {
    serde_json::from_str(include_str!("fixtures/season-authorized-episode.json")).unwrap()
}
fn play_json() -> Value {
    serde_json::from_str(include_str!("fixtures/full-clear-dash.json")).unwrap()
}
fn metadata() -> Metadata {
    parse_metadata_response(&bytes(&metadata_json()), &reference()).unwrap()
}
fn parse(value: &Value) -> Result<Resolved> {
    parse_playurl_response(&bytes(value), &metadata(), None, NOW)?.finish_without_probe()
}
fn missing_rate_json() -> Value {
    let mut value = play_json();
    let audio = &mut value["data"]["dash"]["audio"][0];
    audio.as_object_mut().unwrap().remove("audioSamplingRate");
    audio["SegmentBase"] = json!({"Initialization":format!("0-{}",INIT.len()-1),"indexRange":format!("{}-{}",INIT.len(),INIT.len()+99)});
    value
}

#[test]
fn course_probe_debug_never_exposes_opaque_validator() {
    let marker = "https://signed.invalid/private-marker?token=synthetic-secret";
    let identity = AudioProbeIdentity {
        total_bytes: 4096,
        strong_etag: Some(format!("\"{marker}\"")),
    };
    let debug = format!("{identity:?}");
    assert!(debug.contains("has_strong_etag: true"));
    assert!(!debug.contains(marker));
    let mut resolved = parse(&play_json()).unwrap();
    resolved.audio_probe = Some(identity);
    let debug = format!("{resolved:?}");
    assert!(!debug.contains(marker));
    assert!(!debug.contains("synthetic-secret"));
}

#[test]
fn course_resources_are_separate_from_ugc_pgc_and_live() {
    for input in [
        format!("course:ep{EP}"),
        format!("https://www.bilibili.com/cheese/play/ep{EP}"),
        format!("https://m.bilibili.com/cheese/play/ep{EP}/"),
    ] {
        let reference = parse_resource(&input).unwrap();
        assert_eq!(reference.ep_id, EP);
        assert_eq!(parse_resource(&reference.canonical()).unwrap(), reference);
        assert!(super::super::parse_resource(&input).is_err());
        assert!(super::super::pgc::parse_resource(&input).is_err());
    }
    for input in [
        "ep1",
        "course:ep0",
        "course:ep01",
        "course:ep18446744073709551616",
        "course:EP1",
        "course:ep+1",
        "course:ep1?p=1",
        " course:ep1",
        "course:ep1\n",
        "1",
        "ss1",
        "BV1xx411c7mD",
        "https://b23.tv/example",
        "https://live.bilibili.com/1",
        "https://www.bilibili.com/bangumi/play/ep1",
        "https://www.bilibili.com/cheese/play/ss1",
        "https://www.bilibili.com/cheese/play/ep1?from=test",
        "https://www.bilibili.com/cheese/play/ep1#x",
        "https://www.bilibili.com/cheese/play/ep1/2",
        "https://www.bilibili.com/cheese/play/%65p1",
        "https://www.bilibili.com/cheese/play/ep1/../ep2",
        "https://www.bilibili.com:443/cheese/play/ep1",
        "https://www.bilibili.com.evil.invalid/cheese/play/ep1",
        "https://user@www.bilibili.com/cheese/play/ep1",
        "https://%77ww.bilibili.com/cheese/play/ep1",
        "http://www.bilibili.com/cheese/play/ep1",
        "https://WWW.bilibili.com/cheese/play/ep1",
    ] {
        assert!(parse_resource(input).is_err(), "accepted {input}");
    }
}

#[test]
fn course_metadata_binds_exact_identity_without_fabricating_bvid() {
    let actual = metadata();
    assert_eq!(actual.ep_id, EP);
    assert_eq!(actual.aid, AID);
    assert_eq!(actual.cid, CID);
    assert_eq!(actual.season_id, "12345");
    assert_eq!(actual.duration_ms, 90_000);
    assert_eq!(actual.duration_seconds(), 90);
    assert!(actual.canonical().ends_with(EP));
    assert!(!format!("{actual:?}").contains("BV1"));
    assert!(
        parse_metadata_response(
            &bytes(&metadata_json()),
            &parse_resource("course:ep2").unwrap()
        )
        .is_err()
    );
    for name in ["id", "aid", "cid", "season_id"] {
        let mut value = metadata_json();
        value["data"]["episodes"][1][name] = json!("0");
        assert!(parse_metadata_response(&bytes(&value), &reference()).is_err());
    }
    for change in 0..8 {
        let mut value = metadata_json();
        match change {
            0 => value["data"]["episodes"][1]["ep_id"] = json!(1),
            1 => value["data"]["episodes"][1]["season_id"] = json!(54321),
            2 => value["data"]["episodes"][1]["from"] = json!("ugc"),
            3 => value["data"]["episodes"][1]["duration"] = json!(0),
            4 => value["data"]["episodes"][1]["duration"] = json!(86401),
            5 => {
                let duplicate = value["data"]["episodes"][1].clone();
                value["data"]["episodes"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            6 => value["data"]["area_limit"] = json!(true),
            _ => value["data"]["episodes"][1]["is_drm"] = json!(true),
        }
        assert!(
            parse_metadata_response(&bytes(&value), &reference()).is_err(),
            "accepted change {change}"
        );
    }
    for name in ["ep", "cid", "aid", "season", "duration"] {
        let mut changed = actual.clone();
        match name {
            "ep" => changed.ep_id = "7".into(),
            "cid" => changed.cid = "8".into(),
            "aid" => changed.aid = "9".into(),
            "season" => changed.season_id = "10".into(),
            _ => changed.duration_ms = 30_000,
        }
        assert!(play_request(&changed, None, None).is_err());
        assert!(parse_playurl_response(&bytes(&play_json()), &changed, None, NOW).is_err());
    }
}

#[test]
fn course_access_and_full_view_are_distinct_required_gates() {
    for (name, value) in [
        ("playable", json!(false)),
        ("playable", json!(1)),
        ("playable", json!("true")),
        ("episode_can_view", json!(false)),
        ("episode_can_view", json!(1)),
        ("ep_status", json!(-1)),
        ("ep_status", json!(3)),
        ("ep_status", json!(null)),
        ("status", json!(2)),
        ("status", json!(true)),
    ] {
        let mut metadata = metadata_json();
        metadata["data"]["episodes"][1][name] = value;
        assert!(
            parse_metadata_response(&bytes(&metadata), &reference()).is_err(),
            "accepted {name}"
        );
    }
    for name in ["playable", "episode_can_view", "ep_status", "status"] {
        let mut value = metadata_json();
        value["data"]["episodes"][1]
            .as_object_mut()
            .unwrap()
            .remove(name);
        assert!(parse_metadata_response(&bytes(&value), &reference()).is_err());
    }
    for preview in [
        json!(1),
        json!(2),
        json!(-1),
        json!(false),
        json!(true),
        json!("0"),
        json!(null),
    ] {
        let mut value = play_json();
        value["data"]["is_preview"] = preview;
        assert!(parse(&value).is_err());
    }
    let mut no_preview = play_json();
    no_preview["data"]
        .as_object_mut()
        .unwrap()
        .remove("is_preview");
    assert!(parse(&no_preview).is_err());
    no_preview["data"]["has_paid"] = json!(true);
    no_preview["data"]["playable"] = json!(true);
    assert!(parse(&no_preview).is_err());
    // Known whole free/introduction episodes remain legal even has_paid=false.
    let actual = parse(&play_json()).unwrap();
    assert!(actual.whole_entitlement().is_whole());
    assert_eq!(actual.dash.audio[0].sampling_rate, 48000);
    assert!(actual.audio_probe.is_none());
    assert_eq!(actual.dash.video.len(), 3);
    assert!(
        actual
            .dash
            .video
            .iter()
            .all(|track| track.codec == VideoCodec::Avc)
    );
    assert_eq!(actual.earliest_expires_at, Some(NOW + 3500));
    for whole_duration in [false, true] {
        let mut value = play_json();
        if whole_duration {
            value["data"]["dash"]["duration"] = json!(30);
        } else {
            value["data"]["timelength"] = json!(30_000);
        }
        assert!(parse(&value).is_err());
    }
}

#[test]
fn course_rejects_denials_protection_wrong_identity_and_other_envelopes() {
    for (name, value) in [
        ("isPreview", json!(1)),
        ("need_login", json!(true)),
        ("need_vip", json!(true)),
        ("need_pay", json!(true)),
        ("playable", json!(false)),
        ("episode_can_view", json!(false)),
        ("area_limit", json!(true)),
        ("is_drm", json!(true)),
        ("drm_tech_type", json!(2)),
        ("drm_info", json!({})),
        ("license_url", json!("https://license.invalid/example")),
        ("ContentProtection", json!({})),
        ("widevine", json!({})),
        ("playready", json!({})),
        ("fairplay", json!({})),
        ("encrypted", json!(true)),
    ] {
        let mut response = play_json();
        response["data"][name] = value;
        assert!(parse(&response).is_err(), "accepted {name}");
    }
    for name in ["ep_id", "cid", "avid", "season_id"] {
        let mut value = play_json();
        value["data"][name] = json!(999);
        assert!(parse(&value).is_err());
    }
    for change in 0..6 {
        let mut value = play_json();
        match change {
            0 => value["code"] = json!(-403),
            1 => value["data"]["code"] = json!(-403),
            2 => value["data"]["durl"] = json!([{"url":"https://unexpected.invalid"}]),
            3 => value["data"]["fragment_videos"] = json!([{"video_info":{"cid":17}}]),
            4 => value["data"]["dash"]["video"][3]["baseUrl"] = json!("https://127.0.0.1/private"),
            _ => value["data"]["dash"]["audio"][0]["SegmentBase"]["indexRange"] = json!("0-999"),
        }
        assert!(parse(&value).is_err());
    }
    for value in [
        json!({"code":0,"result":play_json()["data"]}),
        json!({"code":0,"raw":play_json()}),
    ] {
        assert!(parse(&value).is_err());
    }
    assert!(
        parse_playurl_response(
            br#"{"code":0,"data":{"is_preview":0,"is_preview":1}}"#,
            &metadata(),
            None,
            NOW
        )
        .is_err()
    );
}

#[test]
fn course_known_independent_post_roll_does_not_replace_main_lesson() {
    let mut value = play_json();
    let post = json!({
        "fragment_info":{"fragment_type":"PUGV_FRAGMENT","fragment_position":"POST","index":0,"aid":11,"cid":12},
        "playable_status":true,
        "video_info":{"cid":12,"timelength":10680,"url":"https://unused.invalid/never-fetched"}
    });
    value["data"]["fragment_videos"] = json!([post]);
    let resolved = parse(&value).unwrap();
    assert_eq!(resolved.metadata.cid, CID);
    assert_eq!(resolved.metadata.duration_ms, 90_000);
    assert_eq!(resolved.dash.duration_seconds, 90.0);
    for change in 0..6 {
        let mut wrong = value.clone();
        match change {
            0 => {
                wrong["data"]["fragment_videos"][0]["fragment_info"]["fragment_position"] =
                    json!("PRE")
            }
            1 => {
                wrong["data"]["fragment_videos"][0]["fragment_info"]["fragment_type"] =
                    json!("UNKNOWN")
            }
            2 => wrong["data"]["fragment_videos"][0]["fragment_info"]["cid"] = json!(CID),
            3 => wrong["data"]["fragment_videos"][0]["video_info"]["cid"] = json!(99),
            4 => wrong["data"]["fragment_videos"][0]["fragment_info"]["index"] = json!(1),
            _ => {
                let duplicate = wrong["data"]["fragment_videos"][0].clone();
                wrong["data"]["fragment_videos"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
        }
        assert!(parse(&wrong).is_err());
    }
}

#[test]
fn course_pixel_height_caps_and_quality_codes_are_separate() {
    let mut value = play_json();
    value["data"]["quality"] = json!(64);
    let actual = parse_playurl_response(&bytes(&value), &metadata(), Some(720), NOW)
        .unwrap()
        .finish_without_probe()
        .unwrap();
    assert_eq!(actual.dash.video.len(), 2);
    assert!(
        actual
            .dash
            .video
            .iter()
            .all(|track| track.height <= 720 && track.quality_id <= 64)
    );
    assert!(parse_playurl_response(&bytes(&play_json()), &metadata(), Some(720), NOW).is_err());
    assert!(play_request(&metadata(), Some(721), None).is_err());
    let cookie = Cookie::from_header("SESSDATA=synthetic_own_viewer; DedeUserID=42").unwrap();
    let request = play_request(&metadata(), Some(720), Some(&cookie)).unwrap();
    assert_eq!(request.url().path(), "/pugv/player/web/playurl");
    assert_eq!(
        request.url().query(),
        Some(
            "ep_id=9007199254740993&avid=9007199254740994&cid=9007199254740995&qn=64&fnval=16&fnver=0&fourk=1"
        )
    );
    assert_eq!(
        request.cookie().unwrap().expose_for_storage(),
        cookie.expose_for_storage()
    );
    assert!(!format!("{request:?}").contains("synthetic"));
}

#[test]
fn course_unusable_audio_cannot_trigger_a_probe_or_an_incomplete_descriptor() {
    for value in [json!(null), json!(0), json!("unknown"), json!(384001)] {
        let mut play = play_json();
        play["data"]["dash"]["audio"][0]["audioSamplingRate"] = value;
        assert!(parse(&play).is_err());
    }
    for change in 0..3 {
        let mut play = missing_rate_json();
        match change {
            0 => {
                play["data"]["dash"]["audio"][0]["bandwidth"] = json!(MAX_CLEAR_AUDIO_BANDWIDTH + 1)
            }
            1 => play["data"]["dash"]["audio"][0]["codecs"] = json!("mp4a.40.5"),
            _ => play["data"]["dash"]["audio"][0]["audio_sampling_rate"] = json!(384000),
        }
        assert!(parse_playurl_response(&bytes(&play), &metadata(), None, NOW).is_err());
    }
}

#[derive(Clone, Copy, Debug)]
enum InitFault {
    None,
    Status,
    Duplicate,
    Encoding,
    UnknownTotal,
    WrongRange,
    Short,
    Oversize,
    BadInit,
    WrongTotal,
}
#[derive(Clone)]
struct FixtureTransport {
    metadata: Value,
    play: Value,
    fault: InitFault,
    calls: Arc<Mutex<Vec<(Endpoint, bool)>>>,
    init_calls: Arc<Mutex<Vec<InitRequest>>>,
}
impl FixtureTransport {
    fn new(play: Value, fault: InitFault) -> Self {
        Self {
            metadata: metadata_json(),
            play,
            fault,
            calls: Arc::new(Mutex::new(Vec::new())),
            init_calls: Arc::new(Mutex::new(Vec::new())),
        }
    }
}
impl Transport for FixtureTransport {
    fn get_course<'a>(
        &'a self,
        request: Request,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>> {
        Box::pin(async move {
            request.validate()?;
            assert!(deadline > Instant::now());
            self.calls
                .lock()
                .unwrap()
                .push((request.endpoint(), request.cookie().is_some()));
            let mut value = match request.endpoint() {
                Endpoint::Season => self.metadata.clone(),
                Endpoint::PlayUrl => self.play.clone(),
            };
            // No real API or signed address: rotate only synthetic fixture expiries.
            if request.endpoint() == Endpoint::PlayUrl {
                let now = unix_seconds()?;
                for family in ["video", "audio"] {
                    for track in value["data"]["dash"][family].as_array_mut().unwrap() {
                        let old = track["baseUrl"]
                            .as_str()
                            .unwrap()
                            .split('?')
                            .next()
                            .unwrap();
                        track["baseUrl"] = json!(format!("{old}?deadline={}", now + 3600));
                    }
                }
            }
            Ok(Response {
                status: 200,
                body: bytes(&value),
            })
        })
    }
    fn read_course_init<'a>(
        &'a self,
        request: InitRequest,
    ) -> Pin<Box<dyn Future<Output = Result<mp4::RangeResponse>> + Send + 'a>> {
        Box::pin(async move {
            request.validate()?;
            let wanted = request.range_request().range;
            assert_eq!(wanted.start, 0);
            assert_eq!(wanted.end, INIT.len() as u64 - 1);
            assert_eq!(
                request.url().host_str(),
                Some("upos-sz-mirrorcos.bilivideo.com")
            );
            self.init_calls.lock().unwrap().push(request.clone());
            let mut headers = mp4::RangeHeaders {
                content_range: vec![format!("bytes 0-{}/100000", INIT.len() - 1)],
                content_length: vec![INIT.len().to_string()],
                content_encoding: vec!["identity".into()],
                etag: vec!["\"synthetic-init-entity\"".into()],
                last_modified: vec![],
            };
            let mut body = INIT.to_vec();
            let mut status = 206;
            match self.fault {
                InitFault::None => {}
                InitFault::Status => status = 200,
                InitFault::Duplicate => {
                    headers.content_range.push(headers.content_range[0].clone())
                }
                InitFault::Encoding => headers.content_encoding = vec!["gzip".into()],
                InitFault::UnknownTotal => {
                    headers.content_range = vec![format!("bytes 0-{}/*", INIT.len() - 1)]
                }
                InitFault::WrongRange => {
                    headers.content_range = vec![format!("bytes 1-{}/100000", INIT.len())]
                }
                InitFault::Short => {
                    body.pop();
                }
                InitFault::Oversize => body.resize(MAX_INIT_BYTES + 1, 0),
                InitFault::BadInit => {
                    let at = body.windows(4).position(|bytes| bytes == b"mp4a").unwrap();
                    body[at..at + 4].copy_from_slice(b"enca");
                }
                InitFault::WrongTotal => {
                    headers.content_range =
                        vec![format!("bytes 0-{}/{}", INIT.len() - 1, INIT.len() + 10)]
                }
            }
            Ok(mp4::RangeResponse {
                status,
                headers,
                body,
            })
        })
    }
}
#[tokio::test]
async fn course_missing_audio_rate_uses_one_bounded_authorized_init_probe() {
    let fixture = FixtureTransport::new(missing_rate_json(), InitFault::None);
    let cookie = Cookie::from_header("SESSDATA=synthetic_own_viewer; DedeUserID=42").unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let resolved = Client::new(fixture.clone(), Some(cookie))
        .resolve(&reference().canonical(), None, deadline)
        .await
        .unwrap();
    assert_eq!(resolved.dash.audio[0].sampling_rate, 44100); // Derived from esds, not a guessed default.
    assert!(resolved.whole_entitlement().is_whole());
    assert_eq!(
        resolved.audio_probe.unwrap(),
        AudioProbeIdentity {
            total_bytes: 100000,
            strong_etag: Some("\"synthetic-init-entity\"".into())
        }
    );
    assert_eq!(
        *fixture.calls.lock().unwrap(),
        vec![(Endpoint::Season, true), (Endpoint::PlayUrl, true)]
    );
    let init = fixture.init_calls.lock().unwrap();
    assert_eq!(init.len(), 1);
    assert_eq!(init[0].range_request().deadline, deadline);
    assert_eq!(init[0].range_request().max_body_bytes, INIT.len());
    assert!(!format!("{:?}", init[0]).contains("bilivideo"));
    assert!(
        parse_playurl_response(&bytes(&missing_rate_json()), &metadata(), None, NOW)
            .unwrap()
            .finish_without_probe()
            .is_err()
    );
}
#[tokio::test]
async fn course_no_probe_or_descriptor_is_exposed_before_all_access_gates() {
    for change in 0..8 {
        let mut play = missing_rate_json();
        let mut fixture = FixtureTransport::new(play.clone(), InitFault::None);
        match change {
            0 => fixture.metadata["data"]["episodes"][1]["playable"] = json!(false),
            1 => play["data"]["is_preview"] = json!(1),
            2 => {
                play["data"].as_object_mut().unwrap().remove("is_preview");
            }
            3 => play["data"]["cid"] = json!(99),
            4 => play["data"]["timelength"] = json!(30_000),
            5 => play["data"]["drm_info"] = json!({}),
            6 => play["data"]["dash"]["audio"][0]["baseUrl"] = json!("https://127.0.0.1/private"),
            _ => {
                play["data"]["dash"]["audio"][0]["SegmentBase"]["Initialization"] =
                    json!(format!("0-{MAX_INIT_BYTES}"))
            }
        }
        fixture.play = play;
        // Address mutation case is parsed directly to avoid the fixture expiry helper.
        if change == 6 {
            assert!(parse_playurl_response(&bytes(&fixture.play), &metadata(), None, NOW).is_err());
            continue;
        }
        assert!(
            Client::new(fixture.clone(), None)
                .resolve(
                    &reference().canonical(),
                    None,
                    Instant::now() + Duration::from_secs(2)
                )
                .await
                .is_err(),
            "accepted change {change}"
        );
        assert!(
            fixture.init_calls.lock().unwrap().is_empty(),
            "probed denied change {change}"
        );
    }
    let fixture = FixtureTransport::new(play_json(), InitFault::None);
    Client::new(fixture.clone(), None)
        .resolve(
            &reference().canonical(),
            None,
            Instant::now() + Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert!(fixture.init_calls.lock().unwrap().is_empty());
}
#[tokio::test]
async fn course_init_denials_bad_framing_and_protection_never_retry() {
    for fault in [
        InitFault::Status,
        InitFault::Duplicate,
        InitFault::Encoding,
        InitFault::UnknownTotal,
        InitFault::WrongRange,
        InitFault::Short,
        InitFault::Oversize,
        InitFault::BadInit,
        InitFault::WrongTotal,
    ] {
        let fixture = FixtureTransport::new(missing_rate_json(), fault);
        assert!(
            Client::new(fixture.clone(), None)
                .resolve(
                    &reference().canonical(),
                    None,
                    Instant::now() + Duration::from_secs(2)
                )
                .await
                .is_err(),
            "accepted {fault:?}"
        );
        assert_eq!(fixture.init_calls.lock().unwrap().len(), 1);
        assert_eq!(fixture.calls.lock().unwrap().len(), 2);
    }
    let fixture = FixtureTransport::new(missing_rate_json(), InitFault::None);
    assert_eq!(
        Client::new(fixture.clone(), None)
            .resolve(&reference().canonical(), None, Instant::now())
            .await
            .unwrap_err(),
        Error::Deadline
    );
    assert!(fixture.calls.lock().unwrap().is_empty());
    assert!(fixture.init_calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn course_ready_future_that_finishes_late_never_returns_a_descriptor() {
    struct LateTransport {
        fixture: FixtureTransport,
        late_init: bool,
    }
    impl Transport for LateTransport {
        fn get_course<'a>(
            &'a self,
            request: Request,
            deadline: Instant,
        ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>> {
            Box::pin(async move {
                let response = self.fixture.get_course(request, deadline).await?;
                if !self.late_init {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Ok(response)
            })
        }
        fn read_course_init<'a>(
            &'a self,
            request: InitRequest,
        ) -> Pin<Box<dyn Future<Output = Result<mp4::RangeResponse>> + Send + 'a>> {
            Box::pin(async move {
                let response = self.fixture.read_course_init(request).await?;
                std::thread::sleep(Duration::from_millis(20));
                Ok(response)
            })
        }
    }
    for late_init in [false, true] {
        let fixture = FixtureTransport::new(missing_rate_json(), InitFault::None);
        let result = Client::new(
            LateTransport {
                fixture: fixture.clone(),
                late_init,
            },
            None,
        )
        .resolve(
            &reference().canonical(),
            None,
            Instant::now() + Duration::from_millis(10),
        )
        .await;
        assert_eq!(result.unwrap_err(), Error::Deadline);
        assert_eq!(
            fixture.init_calls.lock().unwrap().len(),
            usize::from(late_init)
        );
    }
}
