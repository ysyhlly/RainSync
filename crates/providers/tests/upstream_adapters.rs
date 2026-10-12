//! Controlled HTTP exercises the production adapter and dispatch paths.
use providers::{Item, PlaybackOptions, SourceConfig, emby, jellyfin};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn upstream(replies: Vec<(u16, Value)>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    upstream_with_headers(
        replies
            .into_iter()
            .map(|(status, body)| (status, body, Vec::new()))
            .collect(),
    )
    .await
}

type HttpReply = (u16, Value, Vec<(&'static str, String)>);

async fn upstream_with_headers(
    replies: Vec<HttpReply>,
) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    upstream_with_raw_bodies(
        replies
            .into_iter()
            .map(|(status, body, headers)| (status, body.to_string(), headers))
            .collect(),
    )
    .await
}

type RawHttpReply = (u16, String, Vec<(&'static str, String)>);

async fn upstream_with_raw_bodies(
    replies: Vec<RawHttpReply>,
) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/emby/", socket.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, text, extra_headers) in replies {
            let (mut stream, _) = socket.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0; 4096];
                let count = stream.read(&mut buffer).await.unwrap();
                assert!(count > 0, "complete request before EOF");
                request.extend_from_slice(&buffer[..count]);
                let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
            requests.push(String::from_utf8(request).unwrap());
            let extra_headers = extra_headers
                .into_iter()
                .map(|(name, value)| format!("{name}: {value}\r\n"))
                .collect::<String>();
            stream.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra_headers}Connection: close\r\n\r\n{text}", text.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    (base, task)
}

fn config(base: &str) -> SourceConfig {
    serde_json::from_value(json!({"url":base,"user_id":"owned-user","token":"owned-test-token"}))
        .unwrap()
}
fn options() -> PlaybackOptions {
    PlaybackOptions {
        position_ms: 12_345.6,
        audio_index: Some(2),
        media_source_id: Some("observed-source".into()),
        progressive: true,
        hls: true,
        force_transcode: false,
    }
}
async fn list(kind: &str, config: &SourceConfig) -> anyhow::Result<Vec<Item>> {
    providers::list_items(kind, config).await
}

#[test]
fn each_product_preserves_seek_audio_and_transport_contracts() {
    for body in [
        jellyfin::playback_request(&config("https://owned.invalid"), &options()).unwrap(),
        emby::playback_request(&config("https://owned.invalid"), &options()).unwrap(),
    ] {
        assert_eq!(body["StartTimeTicks"], 123_456_000);
        assert_eq!(body["AudioStreamIndex"], 2);
        assert_eq!(body["MediaSourceId"], "observed-source");
        assert_eq!(body["EnableDirectPlay"], false);
        assert_eq!(body["DeviceProfile"]["MaxStreamingBitrate"], 12_000_000);
    }
    let direct = PlaybackOptions {
        audio_index: None,
        media_source_id: None,
        hls: false,
        ..options()
    };
    assert_eq!(
        jellyfin::playback_request(&config("https://owned.invalid"), &direct).unwrap()["EnableDirectPlay"],
        true
    );
    assert_eq!(
        emby::playback_request(&config("https://owned.invalid"), &direct).unwrap()["EnableTranscoding"],
        false
    );
    let forced = PlaybackOptions {
        force_transcode: true,
        ..options()
    };
    assert_eq!(
        emby::playback_request(&config("https://owned.invalid"), &forced).unwrap()["AllowVideoStreamCopy"],
        false
    );
}

#[test]
fn both_products_reject_invalid_positions_tracks_and_empty_transports() {
    for position in [-1.0, f64::NAN, f64::INFINITY, i64::MAX as f64 / 10_000.0] {
        let options = PlaybackOptions {
            position_ms: position,
            ..options()
        };
        assert!(jellyfin::playback_request(&config("https://owned.invalid"), &options).is_err());
        assert!(emby::playback_request(&config("https://owned.invalid"), &options).is_err());
    }
    let invalid = PlaybackOptions {
        audio_index: Some(i32::MAX as u32 + 1),
        ..options()
    };
    assert!(emby::playback_request(&config("https://owned.invalid"), &invalid).is_err());
    let unsupported = PlaybackOptions {
        progressive: false,
        hls: false,
        ..options()
    };
    assert!(jellyfin::playback_request(&config("https://owned.invalid"), &unsupported).is_err());
}

#[test]
fn explicit_audio_requires_a_valid_observed_media_source() {
    for source in [
        None,
        Some(String::new()),
        Some(" \t".into()),
        Some("source\nother".into()),
        Some("x".repeat(513)),
    ] {
        let options = PlaybackOptions {
            media_source_id: source,
            ..options()
        };
        for result in [
            jellyfin::playback_request(&config("https://owned.invalid"), &options),
            emby::playback_request(&config("https://owned.invalid"), &options),
        ] {
            assert!(
                result.is_err(),
                "explicit audio cannot use an unbound source"
            );
        }
    }
}

fn audio_metadata(item: &str, source: &str) -> Value {
    json!({
        "Id": item,
        "MediaSources": [{
            "Id": source,
            "MediaStreams": [
                {"Type":"Video","Index":0},
                {"Type":"Audio","Index":1},
                {"Type":"Audio","Index":2}
            ]
        }]
    })
}

#[tokio::test]
async fn audio_discovery_binds_the_observed_source_before_one_playback_post() {
    for kind in ["jellyfin", "emby"] {
        let item = "movie/?#";
        let source = "observed-source/?#";
        let reply = json!({
            "PlaySessionId":"owned-sid",
            "MediaSources":[{"Id":source,"DefaultAudioStreamIndex":2}]
        });
        let (base, task) = upstream(vec![
            (200, audio_metadata(item, source)),
            (200, reply.clone()),
        ])
        .await;
        let mut config = config(&format!("{base}?discard=1#discard"));
        config.user_id = "viewer/?#".into();
        config.access_policy = Some(
            serde_json::from_value(json!({
                "schema_version":1,
                "origins":[{
                    "origin":providers::validate_url(&base).unwrap().origin().ascii_serialization(),
                    "cidrs":["127.0.0.1/32"]
                }]
            }))
            .unwrap(),
        );
        let device = "rainsync-audio-viewer";
        let observed = providers::upstream_audio_source(kind, &config, item, 2, device)
            .await
            .unwrap();
        assert_eq!(observed, source);
        let options = PlaybackOptions {
            media_source_id: Some(observed),
            ..options()
        };
        assert_eq!(
            providers::upstream_plan(kind, &config, item, &options, device)
                .await
                .unwrap(),
            reply
        );
        let requests = task.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(
            requests[0]
                .starts_with("GET /emby/Users/viewer%2F%3F%23/Items/movie%2F%3F%23 HTTP/1.1\r\n")
        );
        assert!(
            requests[1].starts_with("POST /emby/Items/movie%2F%3F%23/PlaybackInfo HTTP/1.1\r\n")
        );
        for request in &requests {
            let headers = request.split_once("\r\n\r\n").unwrap().0;
            assert!(headers.contains(&format!("DeviceId=\"{device}\"")));
            assert!(headers.contains("Token=\"owned-test-token\""));
            assert_eq!(
                headers
                    .to_ascii_lowercase()
                    .contains("x-emby-token: owned-test-token"),
                kind == "emby"
            );
            assert!(!headers.contains("discard"));
        }
        assert_eq!(requests[0].split_once("\r\n\r\n").unwrap().1, "");
        let body: Value =
            serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["MediaSourceId"], source);
        assert_ne!(body["MediaSourceId"], item);
        assert_eq!(body["AudioStreamIndex"], 2);
        assert_eq!(body["StartTimeTicks"], 123_456_000);
    }
}

#[tokio::test]
async fn audio_discovery_rejects_ambiguous_or_malformed_metadata() {
    let valid = audio_metadata("item", "observed-source");
    let mut cases = vec![
        (
            "missing item identity",
            json!({"MediaSources":valid["MediaSources"]}),
        ),
        (
            "wrong item",
            audio_metadata("other-item", "observed-source"),
        ),
        ("missing sources", json!({"Id":"item"})),
        ("non-array sources", json!({"Id":"item","MediaSources":{}})),
        ("empty sources", json!({"Id":"item","MediaSources":[]})),
        (
            "non-object source",
            json!({"Id":"item","MediaSources":[null]}),
        ),
        (
            "missing source ID",
            json!({"Id":"item","MediaSources":[{"MediaStreams":[{"Type":"Audio","Index":2}]}]}),
        ),
        (
            "multiple sources",
            json!({"Id":"item","MediaSources":[valid["MediaSources"][0],audio_metadata("item","other-source")["MediaSources"][0]]}),
        ),
        (
            "duplicate source IDs",
            json!({"Id":"item","MediaSources":[valid["MediaSources"][0],valid["MediaSources"][0]]}),
        ),
    ];
    for (name, source) in [
        ("empty source ID", "".to_owned()),
        ("blank source ID", "  ".to_owned()),
        ("control in source ID", "source\nother".to_owned()),
        ("oversized source ID", "x".repeat(513)),
    ] {
        cases.push((name, audio_metadata("item", &source)));
    }
    for (name, tracks) in [
        ("missing tracks", Value::Null),
        ("non-array tracks", json!({})),
        (
            "absent requested track",
            json!([{"Type":"Audio","Index":1}]),
        ),
        (
            "video index is not audio",
            json!([{"Type":"Video","Index":2}]),
        ),
        ("string audio index", json!([{"Type":"Audio","Index":"2"}])),
        (
            "duplicate audio index",
            json!([{"Type":"Audio","Index":2},{"Type":"Audio","Index":2}]),
        ),
    ] {
        let mut metadata = valid.clone();
        metadata["MediaSources"][0]["MediaStreams"] = tracks;
        cases.push((name, metadata));
    }
    for kind in ["jellyfin", "emby"] {
        for (name, metadata) in &cases {
            let (base, task) = upstream(vec![(200, metadata.clone())]).await;
            assert!(
                providers::upstream_audio_source(
                    kind,
                    &config(&base),
                    "item",
                    2,
                    "rainsync-viewer"
                )
                .await
                .is_err(),
                "{kind}: {name} must not bind an audio selection"
            );
            let requests = task.await.unwrap();
            assert_eq!(requests.len(), 1);
            assert!(requests[0].starts_with("GET /emby/Users/owned-user/Items/item HTTP/1.1"));
        }
    }
}

#[tokio::test]
async fn audio_discovery_rejects_duplicate_json_fields_before_binding() {
    // Value-based fixtures cannot preserve duplicate fields. Every raw response
    // below would otherwise leave a usable item/source/audio after last-wins
    // parsing, including duplicates that agree and escaped key spellings.
    let cases = [
        r#"{"Id":"other","Id":"item","MediaSources":[{"Id":"source","MediaStreams":[{"Type":"Audio","Index":2}]}]}"#,
        r#"{"Id":"item","Id":"item","MediaSources":[{"Id":"source","MediaStreams":[{"Type":"Audio","Index":2}]}]}"#,
        r#"{"Id":"other","\u0049d":"item","MediaSources":[{"Id":"source","MediaStreams":[{"Type":"Audio","Index":2}]}]}"#,
        r#"{"Id":"item","MediaSources":[],"MediaSources":[{"Id":"source","MediaStreams":[{"Type":"Audio","Index":2}]}]}"#,
        r#"{"Id":"item","MediaSources":[{"Id":"other","Id":"source","MediaStreams":[{"Type":"Audio","Index":2}]}]}"#,
        r#"{"Id":"item","MediaSources":[{"Id":"source","Id":"source","MediaStreams":[{"Type":"Audio","Index":2}]}]}"#,
        r#"{"Id":"item","MediaSources":[{"Id":"source","MediaStreams":[],"MediaStreams":[{"Type":"Audio","Index":2}]}]}"#,
        r#"{"Id":"item","MediaSources":[{"Id":"source","MediaStreams":[{"Type":"Video","Type":"Audio","Index":2}]}]}"#,
        r#"{"Id":"item","MediaSources":[{"Id":"source","MediaStreams":[{"Type":"Audio","Index":1,"Index":2}]}]}"#,
        r#"{"Id":"item","MediaSources":[{"Id":"source","MediaStreams":[{"Type":"Audio","Index":2,"Index":2}]}]}"#,
    ];
    for kind in ["jellyfin", "emby"] {
        for metadata in cases {
            let (base, task) =
                upstream_with_raw_bodies(vec![(200, metadata.into(), Vec::new())]).await;
            assert_eq!(
                providers::upstream_audio_source(
                    kind,
                    &config(&base),
                    "item",
                    2,
                    "rainsync-viewer"
                )
                .await
                .unwrap_err()
                .to_string(),
                "upstream_metadata_invalid_json",
                "{kind}: ambiguous metadata must not produce a source binding"
            );
            let requests = task.await.unwrap();
            assert_eq!(requests.len(), 1);
            assert!(requests[0].starts_with("GET /emby/Users/owned-user/Items/item HTTP/1.1"));
        }
    }
}

#[tokio::test]
async fn audio_discovery_rejects_malformed_or_trailing_json_with_bounded_errors() {
    let valid = audio_metadata("item", "source").to_string();
    let cases = [
        format!("{valid} {{\"private-provider-data\":true}}"),
        format!("{valid} private-provider-data"),
        "{\"Id\":\"private-provider-data\"".into(),
    ];
    for kind in ["jellyfin", "emby"] {
        for metadata in &cases {
            let (base, task) =
                upstream_with_raw_bodies(vec![(200, metadata.clone(), Vec::new())]).await;
            assert_eq!(
                providers::upstream_audio_source(
                    kind,
                    &config(&base),
                    "item",
                    2,
                    "rainsync-viewer"
                )
                .await
                .unwrap_err()
                .to_string(),
                "upstream_metadata_invalid_json"
            );
            assert_eq!(task.await.unwrap().len(), 1);
        }
    }
}

#[tokio::test]
async fn audio_discovery_requires_http_ok_even_with_valid_metadata() {
    for kind in ["jellyfin", "emby"] {
        for status in [201, 202, 204, 206, 401, 403, 404, 500] {
            let (base, task) =
                upstream(vec![(status, audio_metadata("item", "observed-source"))]).await;
            assert_eq!(
                providers::upstream_audio_source(
                    kind,
                    &config(&base),
                    "item",
                    2,
                    "rainsync-viewer"
                )
                .await
                .unwrap_err()
                .to_string(),
                "upstream_metadata_status",
                "{kind}: HTTP {status} must not provide a usable source"
            );
            assert_eq!(task.await.unwrap().len(), 1);
        }
    }
}

#[tokio::test]
async fn audio_discovery_neither_accepts_nor_follows_redirects() {
    for kind in ["jellyfin", "emby"] {
        let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = format!("http://{}/capture", destination.local_addr().unwrap());
        let (base, task) = upstream_with_headers(vec![(
            302,
            audio_metadata("item", "observed-source"),
            vec![("Location", target)],
        )])
        .await;
        assert!(
            providers::upstream_audio_source(kind, &config(&base), "item", 2, "rainsync-viewer")
                .await
                .is_err(),
            "a redirect body is not a successful metadata response"
        );
        assert_eq!(task.await.unwrap().len(), 1);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), destination.accept())
                .await
                .is_err(),
            "discovery must not follow a redirect or forward credentials"
        );
    }
}

#[tokio::test]
async fn audio_discovery_checks_source_policy_before_connecting() {
    for kind in ["jellyfin", "emby"] {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", socket.local_addr().unwrap());
        let mut config = config(&format!("{origin}/emby/"));
        config.access_policy = Some(
            serde_json::from_value(json!({
                "schema_version":1,
                "origins":[{"origin":origin,"cidrs":["192.0.2.0/24"]}]
            }))
            .unwrap(),
        );
        assert_eq!(
            providers::upstream_audio_source(kind, &config, "item", 2, "rainsync-viewer")
                .await
                .unwrap_err()
                .to_string(),
            "source_address_denied"
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), socket.accept())
                .await
                .is_err(),
            "denied addresses must receive no request or credential"
        );
    }
}

#[tokio::test]
async fn negotiation_keeps_unique_device_headers_and_complete_rejected_response() {
    for kind in ["jellyfin", "emby"] {
        let rejected =
            json!({"PlaySessionId":"owned-sid","ErrorCode":"NoCompatibleStream","MediaSources":[]});
        let (base, task) = upstream(vec![(200, rejected.clone()), (200, rejected.clone())]).await;
        let config = config(&base);
        for device in ["rainsync-viewer-a", "rainsync-viewer-b"] {
            let info = providers::upstream_plan(kind, &config, "id/?#", &options(), device)
                .await
                .unwrap();
            assert_eq!(
                info, rejected,
                "SID retained for reservation checkpoint and stop compensation"
            );
        }
        let requests = task.await.unwrap();
        for (request, device) in requests
            .iter()
            .zip(["rainsync-viewer-a", "rainsync-viewer-b"])
        {
            assert!(request.starts_with("POST /emby/Items/id%2F%3F%23/PlaybackInfo HTTP/1.1"));
            assert!(request.contains(&format!("DeviceId=\"{device}\"")));
            assert_eq!(
                request
                    .to_ascii_lowercase()
                    .contains("x-emby-token: owned-test-token"),
                kind == "emby"
            );
            let body: Value =
                serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(body["StartTimeTicks"], 123_456_000);
        }
    }
}

#[tokio::test]
async fn browsing_has_stable_order_complete_pagination_and_empty_library_support() {
    for kind in ["jellyfin", "emby"] {
        let (base, task) = upstream(vec![
            (
                200,
                json!({"TotalRecordCount":2,"Items":[{"Id":"one","RunTimeTicks":123456000}]}),
            ),
            (
                200,
                json!({"TotalRecordCount":2,"Items":[{"Id":"two","RunTimeTicks":null}]}),
            ),
        ])
        .await;
        let items = list(kind, &config(&base)).await.unwrap();
        assert_eq!(
            items
                .iter()
                .map(|item| item.resource.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
        assert_eq!(items[0].duration_ms, Some(12_345.6));
        assert_eq!(items[1].duration_ms, None);
        let requests = task.await.unwrap();
        for (index, request) in requests.iter().enumerate() {
            assert!(
                request.contains("SortBy=SortName&SortOrder=Ascending&EnableTotalRecordCount=true")
            );
            assert!(request.contains(&format!("StartIndex={index}")));
            assert!(request.contains("DeviceId=\"rainsync-library-scan\""));
        }
        let (base, task) = upstream(vec![(200, json!({"TotalRecordCount":0,"Items":[]}))]).await;
        assert!(list(kind, &config(&base)).await.unwrap().is_empty());
        task.await.unwrap();
    }
}

#[tokio::test]
async fn unchanged_total_with_duplicate_identity_does_not_pass_as_complete_scan() {
    for kind in ["jellyfin", "emby"] {
        let page = json!({"TotalRecordCount":2,"Items":[{"Id":"one"}]});
        let (base, task) = upstream(vec![(200, page.clone()), (200, page)]).await;
        assert_eq!(
            list(kind, &config(&base)).await.unwrap_err().to_string(),
            "duplicate_library_item"
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn incomplete_changed_or_malformed_library_never_returns_partial_results() {
    let cases = [
        (
            json!({"TotalRecordCount":2,"Items":[]}),
            "incomplete_library_response",
        ),
        (
            json!({"TotalRecordCount":3,"Items":[{"Id":"two"}]}),
            "library_changed_during_scan",
        ),
        (
            json!({"TotalRecordCount":2,"Items":[{"Id":""}]}),
            "missing_id",
        ),
        (
            json!({"TotalRecordCount":2,"Items":[{"Id":"two","RunTimeTicks":-1}]}),
            "invalid_library_duration",
        ),
        (
            json!({"TotalRecordCount":2,"Items":[{"Id":"two","RunTimeTicks":"wrong"}]}),
            "invalid_library_duration",
        ),
        (json!({"Items":[]}), "invalid_library_total"),
    ];
    for kind in ["jellyfin", "emby"] {
        for (bad, expected) in &cases {
            let (base, task) = upstream(vec![
                (200, json!({"TotalRecordCount":2,"Items":[{"Id":"one"}]})),
                (200, bad.clone()),
            ])
            .await;
            assert_eq!(
                list(kind, &config(&base)).await.unwrap_err().to_string(),
                *expected
            );
            task.await.unwrap();
        }
    }
}

#[tokio::test]
async fn revoked_library_access_is_a_failure_instead_of_an_empty_library() {
    for kind in ["jellyfin", "emby"] {
        for code in [401, 403] {
            let (base, task) = upstream(vec![(code, json!({"error":"denied"}))]).await;
            assert!(list(kind, &config(&base)).await.is_err());
            task.await.unwrap();
        }
    }
}

#[tokio::test]
async fn library_scan_keeps_explicit_series_fields_without_host_paths() {
    for kind in ["jellyfin", "emby"] {
        let (base, task) = upstream(vec![(200, json!({"TotalRecordCount":1,"Items":[{
            "Id":"episode-id","Name":"Episode title","Type":"Episode",
            "SeriesId":"series-id","SeriesName":"Explicit Series",
            "SeasonId":"season-id","SeasonName":"Season 2","ParentIndexNumber":2,"IndexNumber":3,
            "Path":"/host/private/secret/video.mkv","ServerUrl":"https://private.invalid/token"
        }]}))]).await;
        let items = list(kind, &config(&base)).await.unwrap();
        assert_eq!(items[0].metadata["SeriesName"], "Explicit Series");
        assert_eq!(items[0].metadata["SeasonId"], "season-id");
        assert_eq!(items[0].metadata["ParentIndexNumber"], 2);
        assert_eq!(items[0].metadata["IndexNumber"], 3);
        assert!(items[0].metadata.get("Path").is_none());
        assert!(items[0].metadata.get("ServerUrl").is_none());
        task.await.unwrap();
    }
}

#[tokio::test]
async fn guarded_browse_reacquires_the_current_fence_before_each_page() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    struct Fence(Arc<AtomicUsize>);
    impl Drop for Fence {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    for kind in ["jellyfin", "emby"] {
        let (base, task) = upstream(vec![(
            200,
            json!({"TotalRecordCount":2,"Items":[{"Id":"one"}]}),
        )])
        .await;
        let config = config(&base);
        let guards = AtomicUsize::new(0);
        let released = Arc::new(AtomicUsize::new(0));
        let result = providers::list_items_guarded(kind, &config, || {
            let page = guards.fetch_add(1, Ordering::SeqCst);
            std::future::ready(if page == 0 {
                Ok(Fence(released.clone()))
            } else {
                assert_eq!(released.load(Ordering::SeqCst), 1);
                Err(anyhow::anyhow!("source_changed"))
            })
        })
        .await;
        assert_eq!(result.unwrap_err().to_string(), "source_changed");
        assert_eq!(guards.load(Ordering::SeqCst), 2);
        assert_eq!(released.load(Ordering::SeqCst), 1);
        let requests = task.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].contains("StartIndex=0"));
    }
}
