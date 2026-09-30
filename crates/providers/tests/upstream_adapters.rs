//! Controlled HTTP exercises the production adapter and dispatch paths.
use providers::{Item, PlaybackOptions, SourceConfig, emby, jellyfin};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn upstream(replies: Vec<(u16, Value)>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/emby/", socket.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in replies {
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
            let text = body.to_string();
            stream.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len()).as_bytes()).await.unwrap();
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
        assert_eq!(body["EnableDirectPlay"], false);
        assert_eq!(body["DeviceProfile"]["MaxStreamingBitrate"], 12_000_000);
    }
    let direct = PlaybackOptions {
        audio_index: None,
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
