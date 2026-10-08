use super::*;
use serde_json::json;
use std::sync::{Arc, Mutex};

const EP: &str = "9007199254740993";
const CID: &str = "9007199254740995";
const NOW: u64 = 1_700_000_000;
fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
fn metadata_json() -> Value {
    serde_json::from_str(include_str!("fixtures/season-single-episode.json")).unwrap()
}
fn play_json() -> Value {
    serde_json::from_str(include_str!("fixtures/v2-whole-dash.json")).unwrap()
}
fn metadata() -> Metadata {
    parse_metadata_response(
        &bytes(&metadata_json()),
        &parse_resource(&format!("ep{EP}")).unwrap(),
    )
    .unwrap()
}
fn parse(value: &Value) -> Result<Resolved> {
    parse_playurl_response(&bytes(value), &metadata(), None, NOW)
}

#[test]
fn pgc_resource_only_explicit_normalized_episode_identity() {
    for input in [
        format!("ep{EP}"),
        format!("https://www.bilibili.com/bangumi/play/ep{EP}"),
        format!("https://m.bilibili.com/bangumi/play/ep{EP}/"),
    ] {
        let reference = parse_resource(&input).unwrap();
        assert_eq!(reference.ep_id, EP);
        assert_eq!(parse_resource(&reference.canonical()).unwrap(), reference);
    }
    for input in [
        "ep0",
        "ep01",
        "ep18446744073709551616",
        "ep+1",
        "EP1",
        "1",
        "ss1",
        "md1",
        "BV1xx411c7mD",
        " ep1",
        "ep1\n",
        "ep1?p=1",
        "https://b23.tv/example",
        "https://www.bilibili.com/video/BV1xx411c7mD",
        "https://www.bilibili.com/bangumi/play/ss1",
        "https://www.bilibili.com/bangumi/play/ep1?from=test",
        "https://www.bilibili.com/bangumi/play/ep1#x",
        "https://www.bilibili.com/bangumi/play/ep1/2",
        "https://www.bilibili.com/bangumi/play/%65p1",
        "https://www.bilibili.com/bangumi/play/ep1/../ep2",
        "https://www.bilibili.com:443/bangumi/play/ep1",
        "https://www.bilibili.com.evil.invalid/bangumi/play/ep1",
        "https://user@www.bilibili.com/bangumi/play/ep1",
        "https://%77ww.bilibili.com/bangumi/play/ep1",
        "http://www.bilibili.com/bangumi/play/ep1",
        "https://WWW.bilibili.com/bangumi/play/ep1",
    ] {
        assert!(parse_resource(input).is_err(), "accepted {input}");
    }
    // The ordinary UGC route remains closed to all PGC identities.
    assert!(super::super::parse_resource("ep1").is_err());
    assert!(super::super::parse_resource("https://www.bilibili.com/bangumi/play/ep1").is_err());
}

#[test]
fn pgc_metadata_binds_one_episode_and_preserves_exact_large_ids() {
    let actual = metadata();
    assert_eq!(actual.ep_id, EP);
    assert_eq!(actual.cid, CID);
    assert_eq!(actual.season_id, "12345");
    assert_eq!(actual.duration_ms, 90090);
    assert_eq!(actual.duration_seconds(), 90);
    assert!(actual.canonical().ends_with(EP));
    // A metadata-only locked unrelated episode cannot grant or deny this one.
    let mut section = metadata_json();
    let selected = section["result"]["episodes"]
        .as_array_mut()
        .unwrap()
        .pop()
        .unwrap();
    section["result"]["section"] = json!([{"title":"Extras","episodes":[selected]}]);
    assert_eq!(
        parse_metadata_response(
            &bytes(&section),
            &parse_resource(&format!("ep{EP}")).unwrap()
        )
        .unwrap(),
        actual
    );
    for field_name in ["id", "cid", "aid", "season_id"] {
        let mut value = metadata_json();
        value["result"]["episodes"][1][field_name] = json!("0");
        assert!(
            parse_metadata_response(&bytes(&value), &parse_resource(&format!("ep{EP}")).unwrap())
                .is_err(),
            "accepted {field_name}"
        );
    }
    for change in 0..8 {
        let mut value = metadata_json();
        match change {
            0 => value["result"]["episodes"][1]["ep_id"] = json!(1),
            1 => value["result"]["episodes"][1]["season_id"] = json!(54321),
            2 => value["result"]["episodes"][1]["bvid"] = json!("BV-invalid"),
            3 => value["result"]["episodes"][1]["duration"] = json!(0),
            4 => value["result"]["episodes"][1]["duration"] = json!(MAX_DURATION_MS + 1),
            5 => {
                let duplicate = value["result"]["episodes"][1].clone();
                value["result"]["episodes"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            6 => value["result"]["rights"]["area_limit"] = json!(1),
            _ => value["result"]["episodes"][1]["rights"]["can_watch"] = json!(false),
        }
        assert!(
            parse_metadata_response(&bytes(&value), &parse_resource(&format!("ep{EP}")).unwrap())
                .is_err(),
            "accepted change {change}"
        );
    }
    assert!(
        parse_metadata_response(&bytes(&metadata_json()), &parse_resource("ep2").unwrap()).is_err()
    );
}

#[test]
fn pgc_metadata_capabilities_never_establish_entitlement() {
    let mut value = metadata_json();
    value["result"]["episodes"][1]["need_vip"] = json!(true);
    value["result"]["episodes"][1]["rights"]["pay"] = json!(1);
    let meta =
        parse_metadata_response(&bytes(&value), &parse_resource(&format!("ep{EP}")).unwrap())
            .unwrap();
    let mut play = play_json();
    play["result"].as_object_mut().unwrap().remove("play_check");
    play["result"]
        .as_object_mut()
        .unwrap()
        .remove("play_video_type");
    assert!(parse_playurl_response(&bytes(&play), &meta, None, NOW).is_err());
}

#[test]
fn pgc_positive_whole_gate_and_clear_codec_slice() {
    let resolved = parse(&play_json()).unwrap();
    assert!(resolved.whole_entitlement().is_whole());
    assert_eq!(resolved.dash.video.len(), 3); // HEVC is parsed but never exposed
    assert!(
        resolved
            .dash
            .video
            .iter()
            .all(|track| track.codec == VideoCodec::Avc)
    );
    assert_eq!(resolved.dash.audio.len(), 1);
    assert_eq!(resolved.dash.audio[0].codecs, "mp4a.40.2");
    assert_eq!(resolved.earliest_expires_at, Some(NOW + 3500));
    assert!(resolved.qualities[0].requires_vip);
    for remove in ["play_check", "play_video_type"] {
        let mut value = play_json();
        value["result"].as_object_mut().unwrap().remove(remove);
        assert!(parse(&value).is_ok()); // Either known positive field suffices
    }
    for detail in [
        json!("PLAY_PREVIEW"),
        json!("PLAY_NONE"),
        json!("PLAY_FULL"),
        json!(true),
        json!(null),
    ] {
        let mut value = play_json();
        value["result"]["play_check"]["play_detail"] = detail;
        assert!(parse(&value).is_err());
    }
    for kind in [
        json!("preview"),
        json!("none"),
        json!("full"),
        json!(1),
        json!({}),
        json!(null),
    ] {
        let mut value = play_json();
        value["result"]["play_video_type"] = kind;
        assert!(parse(&value).is_err());
    }
    for check in [
        json!({}),
        json!(null),
        json!("PLAY_WHOLE"),
        json!({"play_detail":"PLAY_WHOLE","is_preview":true}),
    ] {
        let mut value = play_json();
        value["result"]["play_check"] = check;
        assert!(parse(&value).is_err());
    }
    let mut contradiction = play_json();
    contradiction["result"]["video_info"]["play_video_type"] = json!("preview");
    assert!(parse(&contradiction).is_err());
    // The v2 direct API envelope is intentionally narrow; webpage SSR wrappers
    // and the old UGC/legacy PGC data shapes are not entitlement fallbacks.
    for value in [
        json!({"code":0,"data":play_json()["result"]}),
        json!({"code":0,"raw":play_json()}),
    ] {
        assert!(parse(&value).is_err());
    }
}

#[test]
fn pgc_rejects_explicit_access_geo_drm_and_encryption_signals() {
    for (name, value) in [
        ("is_preview", json!(true)),
        ("isPreview", json!(1)),
        ("need_login", json!(true)),
        ("need_vip", json!(true)),
        ("need_pay", json!(true)),
        ("can_play", json!(false)),
        ("can_watch", json!(0)),
        ("permission", json!("denied")),
        ("area_limit", json!(true)),
        ("is_drm", json!(1)),
        ("drm_tech_type", json!(2)),
        ("drm_info", json!({})),
        ("license_url", json!("https://license.invalid/example")),
        ("ContentProtection", json!({})),
        ("widevine", json!({})),
        ("playready", json!({})),
        ("fairplay", json!({})),
        ("is_encrypted", json!(true)),
        ("encryption", json!({"method":"AES-128"})),
        ("encryption_key", json!("synthetic")),
        ("drm_unknown_future", json!({})),
        ("licenseUrl", json!("synthetic")),
    ] {
        let mut play = play_json();
        play["result"]["video_info"][name] = value;
        assert!(parse(&play).is_err(), "accepted {name}");
    }
    for nesting in 0..3 {
        let mut value = play_json();
        match nesting {
            0 => value["result"]["plugins"][0]["config"]["is_block"] = json!(true),
            1 => {
                value["result"]["video_info"]["dash"]["video"][0]["license_url"] =
                    json!("synthetic")
            }
            _ => value["result"]["video_info"]["support_formats"][0]["drm_info"] = json!({}),
        }
        assert!(parse(&value).is_err());
    }
    for code in [-101, -10403, -403, -404, -352, 6002003, 10015002] {
        let mut value = play_json();
        value["code"] = json!(code);
        assert!(parse(&value).is_err(), "accepted API code {code}");
    }
}

#[test]
fn pgc_playurl_echoes_never_override_episode_cid_or_season() {
    for container in ["result", "video_info"] {
        for name in ["ep_id", "episode_id", "cid", "season_id", "aid", "bvid"] {
            let mut value = play_json();
            let target = if container == "result" {
                &mut value["result"]
            } else {
                &mut value["result"]["video_info"]
            };
            target[name] = if name == "bvid" {
                json!("BV1xx411c7mE")
            } else {
                json!(1)
            };
            assert!(
                parse(&value).is_err(),
                "accepted mismatch {container}.{name}"
            );
        }
    }
    let mut duplicate_alias = play_json();
    duplicate_alias["result"]["episode_id"] = json!(1);
    assert!(parse(&duplicate_alias).is_err());
}

#[test]
fn pgc_duration_and_playback_shape_fail_closed() {
    for duration in [
        json!(0),
        json!(60000),
        json!(MAX_DURATION_MS + 1),
        json!("90090"),
    ] {
        let mut value = play_json();
        value["result"]["video_info"]["timelength"] = duration;
        assert!(parse(&value).is_err());
    }
    for duration in [json!(0), json!(60), json!(99), json!("90.09")] {
        let mut value = play_json();
        value["result"]["video_info"]["dash"]["duration"] = duration;
        assert!(parse(&value).is_err());
    }
    let mut progressive = play_json();
    progressive["result"]["video_info"]["durl"] =
        json!([{"url":"https://example.invalid/video.mp4"}]);
    assert!(parse(&progressive).is_err());
    let mut malformed = play_json();
    malformed["result"]["video_info"]["durl"] = json!({});
    assert!(parse(&malformed).is_err());
}

#[test]
fn pgc_height_ceiling_uses_actual_pixels_and_separate_qn_mapping() {
    let mut value = play_json();
    value["result"]["video_info"]["quality"] = json!(64);
    let resolved = parse_playurl_response(&bytes(&value), &metadata(), Some(720), NOW).unwrap();
    assert!(
        resolved
            .dash
            .video
            .iter()
            .all(|track| track.height <= 720 && track.quality_id <= 64)
    );
    assert!(
        !resolved
            .qualities
            .iter()
            .find(|q| q.id == 80)
            .unwrap()
            .available
    );
    assert!(parse_playurl_response(&bytes(&play_json()), &metadata(), Some(720), NOW).is_err());
    assert!(parse_playurl_response(&bytes(&play_json()), &metadata(), Some(64), NOW).is_err());
    assert!(parse_playurl_response(&bytes(&play_json()), &metadata(), Some(144), NOW).is_err());
    for (height, qn) in [
        (360, 16),
        (480, 32),
        (720, 64),
        (1080, 80),
        (1440, 80),
        (2160, 120),
        (4320, 127),
    ] {
        let request = play_request(&metadata(), Some(height), None).unwrap();
        assert_eq!(
            request
                .url()
                .query_pairs()
                .find(|(key, _)| key == "qn")
                .unwrap()
                .1,
            qn.to_string()
        );
    }
}

#[test]
fn pgc_all_track_urls_ranges_and_codecs_are_validated_before_filtering() {
    for url in [
        "http://upos-sz-mirrorcos.bilivideo.com/video.m4s",
        "https://evil.invalid/video.m4s",
        "https://bilivideo.com.evil.invalid/video.m4s",
        "https://upos-sz-mirrorcos.bilivideo.com:444/video.m4s",
        "https://upos-sz-mirrorcos.bilivideo.com/video.m4s?deadline=1",
        "https://upos-sz-mirrorcos.bilivideo.com/video.m4s?deadline=1700003600&deadline=1700003600",
    ] {
        let mut value = play_json();
        // Even a filtered-out HEVC URL must be valid.
        value["result"]["video_info"]["dash"]["video"][3]["baseUrl"] = json!(url);
        assert!(parse(&value).is_err(), "accepted {url}");
    }
    for (name, value) in [
        ("indexRange", json!("1999-1000")),
        ("Initialization", json!("0-1001")),
        ("indexRange", json!("1000-999999999")),
    ] {
        let mut play = play_json();
        play["result"]["video_info"]["dash"]["video"][0]["SegmentBase"][name] = value;
        assert!(parse(&play).is_err());
    }
    let mut no_avc = play_json();
    no_avc["result"]["video_info"]["dash"]["video"] =
        json!([no_avc["result"]["video_info"]["dash"]["video"][3]]);
    assert!(parse(&no_avc).is_err());
    let mut no_aac = play_json();
    no_aac["result"]["video_info"]["dash"]["audio"][0]["codecs"] = json!("mp4a.40.5");
    assert!(parse(&no_aac).is_err());
    let mut expiry_unknown = play_json();
    expiry_unknown["result"]["video_info"]["dash"]["audio"][0]["baseUrl"] =
        json!("https://upos-sz-mirrorcos.bilivideo.com/synthetic.m4s");
    assert_eq!(parse(&expiry_unknown).unwrap().earliest_expires_at, None);
}

#[test]
fn pgc_fixed_requests_and_debug_never_disclose_cookies_or_cdn_urls() {
    let cookie = Cookie::from_header("SESSDATA=synthetic-session; DedeUserID=42").unwrap();
    let request = play_request(&metadata(), Some(720), Some(&cookie)).unwrap();
    request.validate().unwrap();
    assert_eq!(request.url().host_str(), Some("api.bilibili.com"));
    assert_eq!(request.url().path(), "/pgc/player/web/v2/playurl");
    assert_eq!(
        request.cookie().unwrap().expose_for_storage(),
        cookie.expose_for_storage()
    );
    assert!(!format!("{request:?}").contains("synthetic-session"));
    let resolved = parse(&play_json()).unwrap();
    assert!(!format!("{resolved:?}").contains("bilivideo.com"));
    assert!(!format!("{resolved:?}").contains("deadline="));
    let mut forged = request;
    forged.url = Url::parse("https://api.bilibili.com/x/player/wbi/playurl?ep_id=1").unwrap();
    assert!(forged.validate().is_err());
    let mut changed_query = metadata_request(&parse_resource("ep1").unwrap(), None).unwrap();
    changed_query
        .url
        .query_pairs_mut()
        .append_pair("host", "example.invalid");
    assert!(changed_query.validate().is_err());
}

#[test]
fn pgc_json_size_unique_fields_and_malformed_payloads_are_bounded() {
    for bytes in [br#"{"code":0,"code":0,"result":{}}"#.as_slice(),
        br#"{"code":0,"result":{"play_check":{"play_detail":"PLAY_WHOLE","play_detail":"PLAY_PREVIEW"}}}"#.as_slice(),
        b"{} {}", b"<html>challenge</html>"] {
        assert!(parse_playurl_response(bytes, &metadata(), None, NOW).is_err());
    }
    assert_eq!(
        parse_playurl_response(&vec![b' '; MAX_BYTES + 1], &metadata(), None, NOW).unwrap_err(),
        Error::TooLarge
    );
}

type RecordedRequests = Arc<Mutex<Vec<(Endpoint, String, Option<String>)>>>;
struct FixtureTransport {
    responses: Mutex<Vec<Response>>,
    requests: RecordedRequests,
}
impl Transport for FixtureTransport {
    fn get_pgc<'a>(
        &'a self,
        request: Request,
        _deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>> {
        Box::pin(async move {
            self.requests.lock().unwrap().push((
                request.endpoint(),
                request.url().to_string(),
                request
                    .cookie()
                    .map(|cookie| cookie.expose_for_storage().to_owned()),
            ));
            let mut responses = self.responses.lock().unwrap();
            if responses.is_empty() {
                return Err(Error::Transport);
            }
            Ok(responses.remove(0))
        })
    }
}
fn transport(play: Value) -> (FixtureTransport, RecordedRequests) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    (
        FixtureTransport {
            responses: Mutex::new(vec![
                Response {
                    status: 200,
                    body: bytes(&metadata_json()),
                },
                Response {
                    status: 200,
                    body: bytes(&play),
                },
            ]),
            requests: requests.clone(),
        },
        requests,
    )
}

#[tokio::test]
async fn pgc_denials_issue_no_retry_or_alternate_route_and_cookie_is_exact_viewer() {
    for denial in [json!({"code":-10403}), json!({"code":-352}), {
        let mut play = play_json();
        play["result"]["play_video_type"] = json!("preview");
        play
    }] {
        let (transport, calls) = transport(denial);
        let cookie = Cookie::from_header("SESSDATA=viewer-session; DedeUserID=42").unwrap();
        let client = Client::new(transport, Some(cookie.clone()));
        assert!(
            client
                .resolve(
                    &format!("ep{EP}"),
                    None,
                    Instant::now() + std::time::Duration::from_secs(2)
                )
                .await
                .is_err()
        );
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, Endpoint::Season);
        assert_eq!(calls[1].0, Endpoint::PlayUrl);
        assert!(
            calls
                .iter()
                .all(|call| call.2.as_deref() == Some(cookie.expose_for_storage()))
        );
        assert!(calls[1].1.contains(&format!("ep_id={EP}&cid={CID}")));
        assert!(!calls[1].1.contains("/x/player/"));
    }
    let (transport, calls) = transport(play_json());
    let client = Client::new(transport, None);
    assert_eq!(
        client
            .resolve(&format!("ep{EP}"), None, Instant::now())
            .await
            .unwrap_err(),
        Error::Deadline
    );
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn pgc_transport_status_and_size_errors_never_parse_or_expose_media() {
    for response in [
        Response {
            status: 403,
            body: bytes(&play_json()),
        },
        Response {
            status: 200,
            body: vec![b' '; MAX_BYTES + 1],
        },
    ] {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let client = Client::new(
            FixtureTransport {
                responses: Mutex::new(vec![response]),
                requests: requests.clone(),
            },
            None,
        );
        assert!(
            client
                .resolve(
                    &format!("ep{EP}"),
                    None,
                    Instant::now() + std::time::Duration::from_secs(2)
                )
                .await
                .is_err()
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
}
