use super::*;
use serde_json::json;
use std::sync::Mutex;
use std::time::Duration;

const ID: &str = "7123456789012345678";
const NOW: u64 = 1_700_000_000_000;
const TIKTOK_MP4: &str =
    "https://v58.tiktokcdn.com/video/fixture.mp4?x-expires=2000000000&signature=fixture-secret";
const DOUYIN_MP4: &str =
    "https://v26-web.douyinvod.com/video/fixture.mp4?expire=2000000000&signature=fixture-secret";
const PLAY: &str =
    "https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0d00f7b0000fixture&ratio=720p&line=0";
fn tik_item() -> Value {
    json!({"id":ID,"desc":"TikTok fixture title", "author":{"uniqueId":"creator"}, "video":{"duration":15,"width":1080,"height":1920,"playAddr":TIKTOK_MP4}})
}
fn dou_item() -> Value {
    json!({"aweme_id":ID,"aweme_type":0,"desc":"Douyin fixture title", "video":{"duration":15000,"width":1080,"height":1920,"play_addr":{"uri":"v0d00f7b0000fixture","url_list":[DOUYIN_MP4]}}})
}
fn tik_html(item: Value) -> Vec<u8> {
    format!("<html><script type='application/json' id='__UNIVERSAL_DATA_FOR_REHYDRATION__'>{}</script></html>", json!({"__DEFAULT_SCOPE__":{"webapp.video-detail":{"statusCode":0,"itemInfo":{"itemStruct":item}}}})).into_bytes()
}
fn dou_html(item: Value) -> Vec<u8> {
    format!(
        "<html><script>window._ROUTER_DATA = {};</script></html>",
        json!({"loaderData":{"video_(id)/page":{"videoInfoRes":{"item_list":[item]}}}})
    )
    .into_bytes()
}
fn reference(platform: Platform) -> VideoRef {
    parse_resource(platform, ID).unwrap()
}
fn parsed_tik(item: Value) -> Result<ProgressiveResolved> {
    parse_webpage(&reference(Platform::TikTok), &tik_html(item), NOW)
}
fn parsed_dou(item: Value) -> Result<ProgressiveResolved> {
    parse_webpage(&reference(Platform::Douyin), &dou_html(item), NOW)
}

#[test]
fn parses_only_full_canonical_video_links_and_u64_ids() {
    for platform in [Platform::Douyin, Platform::TikTok] {
        assert_eq!(parse_resource(platform, ID).unwrap().id(), ID);
        for input in [
            "0",
            "01",
            "18446744073709551616",
            " 123",
            "123\n",
            "1?x=2",
            "https://127.0.0.1/video/1",
            "https://douyin.com.evil/video/1",
        ] {
            assert!(parse_resource(platform, input).is_err(), "accepted {input}");
        }
    }
    assert_eq!(
        parse_resource(Platform::Douyin, "https://douyin.com/video/123/")
            .unwrap()
            .canonical(),
        "https://www.douyin.com/video/123"
    );
    assert_eq!(
        parse_resource(
            Platform::TikTok,
            "https://www.tiktok.com/@creator.name/video/123"
        )
        .unwrap()
        .canonical(),
        "https://www.tiktok.com/@creator.name/video/123"
    );
    for input in [
        "https://www.tiktok.com:443/@a/video/1",
        "https://user@www.tiktok.com/@a/video/1",
        "https://www.tiktok.com/@a/video/1?lang=en",
        "https://www.tiktok.com/@a/video/1#x",
        "https://www.tiktok.com/@a/../@b/video/1",
        "https://www.tiktok.com/@%61/video/1",
        "https://www.tiktok.com/@a/video/1//",
        "https://vm.tiktok.com/short",
        "https://www.tiktok.com/@../video/1",
    ] {
        assert!(
            parse_resource(Platform::TikTok, input).is_err(),
            "accepted {input}"
        );
    }
}
#[test]
fn canonical_image_and_live_routes_are_explicitly_unsupported() {
    assert_eq!(
        parse_resource(Platform::Douyin, "https://www.douyin.com/note/123"),
        Err(Error::Unsupported(Unsupported::ImagePost))
    );
    assert_eq!(
        parse_resource(
            Platform::TikTok,
            "https://www.tiktok.com/@creator/photo/123"
        ),
        Err(Error::Unsupported(Unsupported::ImagePost))
    );
    assert_eq!(
        parse_resource(Platform::TikTok, "https://www.tiktok.com/@creator/live"),
        Err(Error::Unsupported(Unsupported::Live))
    );
}
#[test]
fn resolves_universal_tiktok_and_official_share_douyin_fixtures() {
    let tik = parsed_tik(tik_item()).unwrap();
    assert_eq!(tik.content_id, ID);
    assert_eq!(tik.duration_seconds, 15.0);
    assert_eq!(tik.title, "TikTok fixture title");
    assert_eq!(tik.width, Some(1080));
    assert_eq!(tik.height, Some(1920));
    assert_eq!(tik.video_codec, None);
    assert_eq!(tik.audio_codec, None);
    assert_eq!(tik.media.expires_at_ms, Some(2_000_000_000_000));
    let dou = parsed_dou(dou_item()).unwrap();
    assert_eq!(dou.duration_seconds, 15.0);
    assert_eq!(dou.media.as_str(), DOUYIN_MP4);
    assert_eq!(
        dou.canonical_url,
        format!("https://www.douyin.com/video/{ID}")
    );
}
#[test]
fn rejects_wrong_resource_and_wrong_creator_identity() {
    let mut item = tik_item();
    item["id"] = json!("7123456789012345679");
    assert_eq!(
        parsed_tik(item),
        Err(Error::InvalidResponse("identity_mismatch"))
    );
    let reference = parse_resource(
        Platform::TikTok,
        &format!("https://www.tiktok.com/@different/video/{ID}"),
    )
    .unwrap();
    assert_eq!(
        parse_webpage(&reference, &tik_html(tik_item()), NOW),
        Err(Error::InvalidResponse("author_identity_mismatch"))
    );
}
#[test]
fn rejects_duplicate_json_keys_aliases_and_hydration() {
    assert_eq!(
        json::parse(br#"{"id":"1","id":"2"}"#),
        Err(Error::InvalidJson)
    );
    assert_eq!(
        json::parse(br#"{"nested":{"x":1,"x":2}}"#),
        Err(Error::InvalidJson)
    );
    assert_eq!(
        json::parse(br#"{"id":1} trailing"#),
        Err(Error::InvalidJson)
    );
    let mut item = tik_item();
    item["aweme_id"] = json!(ID);
    assert_eq!(
        parsed_tik(item),
        Err(Error::InvalidResponse("duplicate_alias"))
    );
    let mut html = tik_html(tik_item());
    html.extend(tik_html(tik_item()));
    assert_eq!(
        parse_webpage(&reference(Platform::TikTok), &html, NOW),
        Err(Error::InvalidResponse("duplicate_hydration"))
    );
    let mut html = dou_html(dou_item());
    html.extend(dou_html(dou_item()));
    assert_eq!(
        parse_webpage(&reference(Platform::Douyin), &html, NOW),
        Err(Error::InvalidResponse("duplicate_hydration"))
    );
}
#[test]
fn rejects_malformed_unknown_or_excluded_content_types() {
    for kind in [json!("bad"), json!(-1), json!({}), json!(999)] {
        let mut item = dou_item();
        item["aweme_type"] = kind;
        assert!(parsed_dou(item).is_err());
    }
    for kind in [2, 68, 150] {
        let mut item = dou_item();
        item["aweme_type"] = json!(kind);
        assert_eq!(
            parsed_dou(item),
            Err(Error::Unsupported(Unsupported::ImagePost))
        );
    }
    let mut item = dou_item();
    item["aweme_type"] = json!(101);
    assert_eq!(parsed_dou(item), Err(Error::Unsupported(Unsupported::Live)));
    let mut item = tik_item();
    item["imagePost"] = json!({"images":[]});
    assert_eq!(
        parsed_tik(item),
        Err(Error::Unsupported(Unsupported::ImagePost))
    );
}
#[test]
fn drm_private_and_challenge_fail_closed_without_messages_leaking() {
    let mut item = tik_item();
    item["video"]["drmInfo"] = json!({"secret":"upstream-secret"});
    let error = parsed_tik(item).unwrap_err();
    assert_eq!(error, Error::Unsupported(Unsupported::Drm));
    assert!(!format!("{error:?} {error}").contains("upstream-secret"));
    let mut item = tik_item();
    item["isPrivate"] = json!(true);
    assert_eq!(
        parsed_tik(item),
        Err(Error::Restricted("private_or_friends_only"))
    );
    assert_eq!(
        parse_webpage(
            &reference(Platform::Douyin),
            b"<script>_$jsvmprt=secret</script>",
            NOW
        ),
        Err(Error::Restricted("platform_challenge"))
    );
    assert_eq!(
        parse_webpage(&reference(Platform::Douyin), b"<html>empty</html>", NOW),
        Err(Error::Unsupported(Unsupported::SigningRequired))
    );
    assert_eq!(
        parse_webpage(&reference(Platform::TikTok), b"<html>empty</html>", NOW),
        Err(Error::Restricted("hydration_unavailable"))
    );
}
#[test]
fn treats_separate_audio_and_video_only_flags_separately() {
    let mut item = tik_item();
    item["video"]["playAddr"] = json!({"UrlList":[TIKTOK_MP4],"audioOnly":false,"videoOnly":false});
    assert!(parsed_tik(item).is_ok());
    let mut item = tik_item();
    item["video"]["playAddr"] = json!({"UrlList":[TIKTOK_MP4],"videoOnly":true});
    assert_eq!(
        parsed_tik(item),
        Err(Error::Unsupported(Unsupported::NoProgressiveVideo))
    );
}
#[test]
fn array_addresses_check_drm_and_track_only_markers() {
    let mut item = dou_item();
    item["video"]["play_addr"] = json!([{"src":DOUYIN_MP4,"isDrm":true}]);
    assert_eq!(parsed_dou(item), Err(Error::Unsupported(Unsupported::Drm)));
    let mut item = dou_item();
    item["video"]["play_addr"] = json!([{"src":DOUYIN_MP4,"audioOnly":true}]);
    assert_eq!(
        parsed_dou(item),
        Err(Error::Unsupported(Unsupported::NoProgressiveVideo))
    );
}
#[test]
fn preserves_explicit_declarations_without_inventing_codecs() {
    let mut item = tik_item();
    item["video"]["videoCodec"] = json!("avc1.640028");
    item["video"]["audioCodec"] = json!("mp4a.40.2");
    let result = parsed_tik(item).unwrap();
    assert_eq!(result.video_codec.as_deref(), Some("avc1.640028"));
    assert_eq!(result.audio_codec.as_deref(), Some("mp4a.40.2"));
}
#[test]
fn skips_known_separate_hevc_and_returns_single_mp4() {
    let mut item = tik_item();
    item["video"]["playAddr"] =
        json!("https://v58.tiktokcdn.com/video/media-video-hvc1/?mime_type=video_mp4");
    item["video"]["bitrateInfo"] =
        json!([{"PlayAddr":{"UrlKey":"v123_h264_720p_1234","UrlList":[TIKTOK_MP4]}}]);
    assert_eq!(parsed_tik(item).unwrap().media.as_str(), TIKTOK_MP4);
}
#[test]
fn expiry_queries_and_signed_hex_path_are_bounded() {
    assert_eq!(
        parse_media(
            Platform::TikTok,
            "https://v58.tiktokcdn.com/video/a.mp4?x-expires=1700000000",
            NOW
        ),
        Err(Error::Restricted("media_expired"))
    );
    assert_eq!(
        parse_media(
            Platform::TikTok,
            "https://v58.tiktokcdn.com/video/a.mp4?x-expires=2000000000&x-expires=2000000001",
            NOW
        ),
        Err(Error::InvalidResponse("duplicate_media_query"))
    );
    assert_eq!(
        parse_media(
            Platform::TikTok,
            "https://v58.tiktokcdn.com/video/a.mp4?expire=garbage",
            NOW
        ),
        Err(Error::InvalidResponse("media_expiry"))
    );
    let url = "https://v26-web.douyinvod.com/0123456789abcdef0123456789abcdef/77359400/video/a/?mime_type=video_mp4";
    assert_eq!(
        parse_media(Platform::Douyin, url, NOW)
            .unwrap()
            .expires_at_ms,
        Some(2_000_000_000_000)
    );
    assert!(
        parse_media(
            Platform::TikTok,
            "http://v58.tiktokcdn.com/video/a.mp4",
            NOW
        )
        .is_err()
    );
    assert!(
        parse_media(
            Platform::TikTok,
            "https://v58.tiktokcdn.com.evil/video/a.mp4",
            NOW
        )
        .is_err()
    );
}
#[test]
fn parser_limits_utf8_and_no_script_execution() {
    assert_eq!(
        parse_webpage(&reference(Platform::TikTok), &[0xff], NOW),
        Err(Error::InvalidResponse("html_encoding"))
    );
    assert_eq!(
        parse_webpage(&reference(Platform::TikTok), &vec![b' '; MAX_BODY + 1], NOW),
        Err(Error::TooLarge)
    );
    let deep = format!("{}0{}", "[".repeat(70), "]".repeat(70));
    assert_eq!(json::parse(deep.as_bytes()), Err(Error::InvalidJson));
    let mut html = dou_html(dou_item());
    let len = html.len();
    html.splice(len - 16..len - 16, b"runMalicious();".iter().copied());
    assert!(parse_webpage(&reference(Platform::Douyin), &html, NOW).is_err());
}
#[test]
fn percent_encoded_legacy_render_data_preserves_plus() {
    let data = json!({"43":{"aweme":{"detail":{"id":ID,"desc":"a+b","video":{"duration":15000,"playAddr":[{"src":DOUYIN_MP4}]}}}}});
    let encoded: String = data
        .to_string()
        .bytes()
        .map(|b| format!("%{b:02X}"))
        .collect();
    let html = format!("<script id=\"RENDER_DATA\">{encoded}</script>");
    assert_eq!(
        parse_webpage(&reference(Platform::Douyin), html.as_bytes(), NOW)
            .unwrap()
            .title,
        "a+b"
    );
}
#[test]
fn official_play_discovery_keeps_query_and_watermark_unchanged() {
    let parsed = validate_play_redirect_url(PLAY).unwrap();
    assert_eq!(parsed.as_str(), PLAY);
    for url in [
        "https://aweme.snssdk.com.evil/aweme/v1/play/?video_id=v1234567&ratio=720p&line=0",
        "http://aweme.snssdk.com/aweme/v1/play/?video_id=v1234567&ratio=720p&line=0",
        "https://aweme.snssdk.com:443/aweme/v1/play/?video_id=v1234567&ratio=720p&line=0",
        "https://aweme.snssdk.com/aweme/v1/play/?video_id=v1234567&ratio=720p&line=0&line=1",
        "https://aweme.snssdk.com/aweme/v1/play/?video_id=v1234567&ratio=720p&line=0&token=secret",
    ] {
        assert!(validate_play_redirect_url(url).is_err());
    }
}

struct Mock {
    replies: Mutex<Vec<PageResponse>>,
    seen: Mutex<Vec<(Endpoint, String, Instant)>>,
}
impl Mock {
    fn new(replies: Vec<PageResponse>) -> Self {
        Self {
            replies: Mutex::new(replies),
            seen: Mutex::new(Vec::new()),
        }
    }
}
impl Transport for Mock {
    fn get<'a>(
        &'a self,
        request: PageRequest,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<PageResponse>> + Send + 'a>> {
        Box::pin(async move {
            assert!(!request.headers().contains_key("Cookie"));
            assert!(!request.headers().contains_key("Authorization"));
            self.seen.lock().unwrap().push((
                request.endpoint(),
                request.url().to_string(),
                deadline,
            ));
            Ok(self.replies.lock().unwrap().remove(0))
        })
    }
}
#[tokio::test]
async fn resolve_uses_one_original_absolute_deadline_without_retry() {
    let mock = Mock::new(vec![PageResponse {
        status: 403,
        body: Vec::new(),
        location: None,
    }]);
    let resolver = Resolver::new(mock);
    let deadline = Instant::now() + Duration::from_secs(1);
    assert_eq!(
        resolver.resolve(Platform::TikTok, ID, deadline).await,
        Err(Error::Restricted("platform_challenge"))
    );
    assert_eq!(resolver.transport.seen.lock().unwrap().len(), 1);
    assert_eq!(resolver.transport.seen.lock().unwrap()[0].2, deadline);
    assert_eq!(
        resolver.resolve(Platform::TikTok, ID, Instant::now()).await,
        Err(Error::Deadline)
    );
    assert_eq!(resolver.transport.seen.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn fixed_official_share_and_one_typed_discovery_produce_direct_cdn() {
    let mut item = dou_item();
    item["video"]["play_addr"]["url_list"] = json!([PLAY]);
    let mock = Mock::new(vec![
        PageResponse {
            status: 200,
            body: dou_html(item),
            location: None,
        },
        PageResponse {
            status: 302,
            body: Vec::new(),
            location: Some(DOUYIN_MP4.to_owned()),
        },
    ]);
    let resolver = Resolver::new(mock);
    let deadline = Instant::now() + Duration::from_secs(1);
    let result = resolver
        .resolve(Platform::Douyin, ID, deadline)
        .await
        .unwrap();
    assert_eq!(result.media.as_str(), DOUYIN_MP4);
    let seen = resolver.transport.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(
        seen[0].1,
        format!("https://www.iesdouyin.com/share/video/{ID}")
    );
    assert_eq!(seen[1].1, PLAY);
    assert!(seen.iter().all(|request| request.2 == deadline));
}
#[tokio::test]
async fn rejects_streamed_discovery_untrusted_destination_and_identity_transplant() {
    for response in [
        PageResponse {
            status: 200,
            body: Vec::new(),
            location: None,
        },
        PageResponse {
            status: 302,
            body: Vec::new(),
            location: Some("https://evil.example/a.mp4".to_owned()),
        },
        PageResponse {
            status: 302,
            body: Vec::new(),
            location: Some("http://v26-web.douyinvod.com/a.mp4".to_owned()),
        },
        PageResponse {
            status: 302,
            body: Vec::new(),
            location: Some(PLAY.to_owned()),
        },
    ] {
        let mut item = dou_item();
        item["video"]["play_addr"]["url_list"] = json!([PLAY]);
        let resolver = Resolver::new(Mock::new(vec![
            PageResponse {
                status: 200,
                body: dou_html(item),
                location: None,
            },
            response,
        ]));
        assert!(
            resolver
                .resolve(
                    Platform::Douyin,
                    ID,
                    Instant::now() + Duration::from_secs(1)
                )
                .await
                .is_err()
        );
        assert_eq!(resolver.transport.seen.lock().unwrap().len(), 2);
    }
    let mut item = dou_item();
    item["video"]["play_addr"]["uri"] = json!("wrong-video-uri");
    item["video"]["play_addr"]["url_list"] = json!([PLAY]);
    let resolver = Resolver::new(Mock::new(vec![PageResponse {
        status: 200,
        body: dou_html(item),
        location: None,
    }]));
    assert_eq!(
        resolver
            .resolve(
                Platform::Douyin,
                ID,
                Instant::now() + Duration::from_secs(1)
            )
            .await,
        Err(Error::InvalidResponse("play_identity_mismatch"))
    );
    assert_eq!(resolver.transport.seen.lock().unwrap().len(), 1);
}
#[test]
fn debug_outputs_never_expose_signed_urls_json_or_headers() {
    let resource = reference(Platform::TikTok);
    let request = PageRequest::new(&resource);
    let response = PageResponse {
        status: 200,
        body: b"secret-body".to_vec(),
        location: Some("secret-location".to_owned()),
    };
    let resolved = parsed_tik(tik_item()).unwrap();
    let debug = format!("{request:?} {response:?} {resolved:?}");
    for secret in [
        "fixture-secret",
        "secret-body",
        "secret-location",
        "https://",
        "Mozilla",
        "Referer",
    ] {
        assert!(!debug.contains(secret));
    }
}

#[test]
fn inert_html_cannot_impersonate_hydration() {
    let html = String::from_utf8(tik_html(tik_item())).unwrap();
    for inert in [
        format!("<!--{html}-->"),
        format!("<textarea>{html}</textarea>"),
        format!("<div data-value='{html}'></div>"),
    ] {
        assert_eq!(
            parse_webpage(&reference(Platform::TikTok), inert.as_bytes(), NOW),
            Err(Error::Restricted("hydration_unavailable"))
        );
    }
}

const SESSION_COOKIE: &str = "sessionid=synthetic-private-login-session";

struct AuthMock {
    replies: Mutex<Vec<PageResponse>>,
    seen: Mutex<Vec<(Endpoint, String, bool, Instant)>>,
}
impl AuthMock {
    fn new(replies: Vec<PageResponse>) -> Self {
        Self {
            replies: Mutex::new(replies),
            seen: Mutex::new(Vec::new()),
        }
    }
}
impl Transport for AuthMock {
    fn get<'a>(
        &'a self,
        request: PageRequest,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<PageResponse>> + Send + 'a>> {
        Box::pin(async move {
            assert!(!request.headers().contains_key("Cookie"));
            assert!(!request.headers().contains_key("Authorization"));
            let credential = request.credential();
            if let Some(credential) = credential {
                assert_eq!(credential.cookie_header(), SESSION_COOKIE);
                assert!(matches!(
                    (request.endpoint(), credential.platform()),
                    (Endpoint::DouyinAuthenticatedDetail, Platform::Douyin)
                        | (Endpoint::TikTokAuthenticatedWebpage, Platform::TikTok)
                ));
            }
            self.seen.lock().unwrap().push((
                request.endpoint(),
                request.url().to_string(),
                credential.is_some(),
                deadline,
            ));
            Ok(self.replies.lock().unwrap().remove(0))
        })
    }
}
fn ok_response(body: Vec<u8>) -> PageResponse {
    PageResponse {
        status: 200,
        body,
        location: None,
    }
}
fn auth_dou_body(item: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"status_code":0,"aweme_detail":item})).unwrap()
}

#[tokio::test]
async fn authenticated_requests_are_fixed_origin_provider_bound_and_redacted() {
    for (platform, endpoint, url, body, media) in [
        (
            Platform::Douyin,
            Endpoint::DouyinAuthenticatedDetail,
            format!("https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id={ID}"),
            auth_dou_body(dou_item()),
            DOUYIN_MP4,
        ),
        (
            Platform::TikTok,
            Endpoint::TikTokAuthenticatedWebpage,
            format!("https://www.tiktok.com/@_/video/{ID}"),
            tik_html(tik_item()),
            TIKTOK_MP4,
        ),
    ] {
        let credential = Credential::parse(platform, SESSION_COOKIE).unwrap();
        let resolver = Resolver::new(AuthMock::new(vec![ok_response(body)]));
        let deadline = Instant::now() + Duration::from_secs(1);
        let result = resolver
            .resolve_authenticated(platform, ID, &credential, deadline)
            .await
            .unwrap();
        assert_eq!(result.media.as_str(), media);
        assert_eq!(result.content_id, ID);
        assert_eq!(
            *resolver.transport.seen.lock().unwrap(),
            [(endpoint, url, true, deadline)]
        );
        let request = PageRequest::authenticated(&reference(platform), &credential).unwrap();
        let debug = format!("{credential:?} {request:?} {result:?}");
        assert!(!debug.contains("synthetic-private-login-session"));
        assert!(!debug.contains("fixture-secret"));
        assert!(!debug.contains("https://"));
    }
}

#[tokio::test]
async fn authenticated_douyin_play_discovery_never_receives_login_cookies() {
    let mut item = dou_item();
    item["video"]["play_addr"]["url_list"] = json!([PLAY]);
    let resolver = Resolver::new(AuthMock::new(vec![
        ok_response(auth_dou_body(item)),
        PageResponse {
            status: 302,
            body: Vec::new(),
            location: Some(DOUYIN_MP4.to_owned()),
        },
    ]));
    let credential = Credential::parse(Platform::Douyin, SESSION_COOKIE).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    let result = resolver
        .resolve_authenticated(Platform::Douyin, ID, &credential, deadline)
        .await
        .unwrap();
    assert_eq!(result.media.as_str(), DOUYIN_MP4);
    let seen = resolver.transport.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].0, Endpoint::DouyinAuthenticatedDetail);
    assert!(seen[0].2);
    assert_eq!(seen[1].0, Endpoint::DouyinPlayRedirect);
    assert_eq!(seen[1].1, PLAY);
    assert!(!seen[1].2);
    assert!(seen.iter().all(|request| request.3 == deadline));
}

#[tokio::test]
async fn credential_scope_invalid_resource_and_deadline_fail_before_transport() {
    let resolver = Resolver::new(AuthMock::new(Vec::new()));
    let credential = Credential::parse(Platform::Douyin, SESSION_COOKIE).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    assert_eq!(
        resolver
            .resolve_authenticated(Platform::TikTok, ID, &credential, deadline)
            .await,
        Err(Error::Restricted("credential_provider_mismatch"))
    );
    assert_eq!(
        resolver
            .resolve_authenticated(
                Platform::Douyin,
                "https://evil.example/a",
                &credential,
                deadline
            )
            .await,
        Err(Error::InvalidResource)
    );
    assert_eq!(
        resolver
            .resolve_authenticated(Platform::Douyin, ID, &credential, Instant::now())
            .await,
        Err(Error::Deadline)
    );
    assert!(resolver.transport.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn authenticated_restrictions_never_retry_anonymously_or_switch_accounts() {
    for platform in [Platform::Douyin, Platform::TikTok] {
        let credential = Credential::parse(platform, SESSION_COOKIE).unwrap();
        for (status, expected) in [
            (401, Error::Restricted("login_required")),
            (403, Error::Restricted("platform_challenge")),
            (429, Error::Restricted("platform_challenge")),
            (302, Error::Restricted("redirect_denied")),
            (500, Error::Status(500)),
        ] {
            let resolver = Resolver::new(AuthMock::new(vec![PageResponse {
                status,
                body: b"synthetic-private-upstream-response".to_vec(),
                location: Some("https://evil.example/login?secret=fixture".to_owned()),
            }]));
            let deadline = Instant::now() + Duration::from_secs(1);
            assert_eq!(
                resolver
                    .resolve_authenticated(platform, ID, &credential, deadline)
                    .await,
                Err(expected)
            );
            assert_eq!(resolver.transport.seen.lock().unwrap().len(), 1);
        }
    }
}

#[test]
fn authenticated_json_is_bounded_identity_checked_and_has_no_fallback_schema() {
    let resource = reference(Platform::Douyin);
    for (body, expected) in [
        (Vec::new(), Error::Unsupported(Unsupported::SigningRequired)),
        (
            b"{}".to_vec(),
            Error::Unsupported(Unsupported::SigningRequired),
        ),
        (
            b"{\"status_code\":0,\"aweme_detail\":null}".to_vec(),
            Error::Unsupported(Unsupported::SigningRequired),
        ),
        (
            b"{\"status_code\":8,\"message\":\"synthetic-private-upstream-message\"}".to_vec(),
            Error::Api(8),
        ),
        (
            b"{\"status_code\":0,\"status_code\":0}".to_vec(),
            Error::InvalidJson,
        ),
        (
            b"{\"aweme_detail\":{},\"aweme_detail\":{}}".to_vec(),
            Error::InvalidJson,
        ),
        (
            b"<html><title>Login</title></html>".to_vec(),
            Error::Restricted("login_required"),
        ),
        (
            b"<html><title>Verify to continue</title></html>".to_vec(),
            Error::Restricted("platform_challenge"),
        ),
        (vec![b'x'; MAX_BODY + 1], Error::TooLarge),
    ] {
        let error = parse_authenticated_douyin(&resource, &body, NOW)
            .err()
            .unwrap();
        assert_eq!(error, expected);
        assert!(!format!("{error} {error:?}").contains("synthetic-private"));
    }
    let mut wrong = dou_item();
    wrong["aweme_id"] = json!("7123456789012345679");
    assert!(parse_authenticated_douyin(&resource, &auth_dou_body(wrong), NOW).is_err());
    let mut drm = dou_item();
    drm["video"]["is_drm"] = json!(true);
    assert_eq!(
        parse_authenticated_douyin(&resource, &auth_dou_body(drm), NOW)
            .err()
            .unwrap(),
        Error::Unsupported(Unsupported::Drm)
    );
    assert_eq!(
        parse_authenticated_douyin(&resource, &dou_html(dou_item()), NOW)
            .err()
            .unwrap(),
        Error::InvalidJson
    );
    assert_eq!(
        parse_authenticated_douyin(
            &reference(Platform::TikTok),
            &auth_dou_body(dou_item()),
            NOW
        )
        .err()
        .unwrap(),
        Error::Restricted("credential_provider_mismatch")
    );
}
