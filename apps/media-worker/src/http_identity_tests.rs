//! Runs only against a fresh cluster created by tests/http-representation-identity.mjs.
use super::*;
use crate::http_identity::{self as identity, Class, Metadata};
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};

fn make_app(db: PgPool) -> App {
    App {
        readiness: Default::default(),
        metrics: Default::default(),
        db,
        key: Arc::new(Aes256Gcm::new_from_slice(&[31; 32]).unwrap()),
        cache: std::env::temp_dir(),
        client: reqwest::Client::new(),
        relay: Default::default(),
        public_url: "http://127.0.0.1".into(),
        probes: Arc::new(tokio::sync::Semaphore::new(2)),
        output_checks: Default::default(),
        input_failures: Default::default(),
        preview_inputs: Default::default(),
        deliveries: Default::default(),
    }
}
async fn session(app: &App) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,1,$2,'{}',now()+interval '10 minutes')")
        .bind(id).bind(id.to_string()).execute(&app.db).await.unwrap();
    id
}
fn resource(url: &str) -> Value {
    json!({"kind":"http","url":url,"source_url":url,"headers":{
        "Authorization":"Bearer fixture", "If-Match":"\"malicious-config\"", "Accept-Encoding":"gzip"
    },"access_policy":{"schema_version":1,"origins":[{"origin":url::Url::parse(url).unwrap().origin().ascii_serialization(),"cidrs":["127.0.0.1/32"]}]}})
}
async fn fetch(
    app: &App,
    id: Uuid,
    url: &str,
    range: Option<&str>,
    if_range: Option<&str>,
    head: bool,
    execution: bool,
) -> Result<Response> {
    let mut headers = HeaderMap::new();
    if let Some(value) = range {
        headers.insert(header::RANGE, value.parse().unwrap());
    }
    if let Some(value) = if_range {
        headers.insert(header::IF_RANGE, value.parse().unwrap());
    }
    let q = Params {
        token: "fixture".into(),
        url: None,
        attempt: None,
        execution: execution.then(Uuid::new_v4),
    };
    prepare_pinned(
        app,
        id,
        &resource(url),
        &q,
        &headers,
        head,
        Default::default(),
    )
    .await
}
async fn bytes(response: Response) -> Vec<u8> {
    axum::body::to_bytes(response.into_body(), 1_000_000)
        .await
        .unwrap()
        .to_vec()
}

#[tokio::test]
#[ignore = "requires the fresh PostgreSQL coordinator; never use an existing DB"]
async fn isolated_http_representation_contract() {
    let connection =
        std::env::var("RAINSYNC_HTTP_IDENTITY_TEST_DATABASE").expect("isolated fixture DB");
    let db = persistence::connect(&connection).await.unwrap();
    persistence::migrate(&db).await.unwrap();
    let app = make_app(db);
    let version = Arc::new(AtomicU64::new(1));
    let requests = Arc::new(Mutex::new(Vec::<(String, HeaderMap)>::new()));
    let seen = requests.clone();
    let upstream_version = version.clone();
    let router = Router::new().fallback(
        move |uri: axum::http::Uri, method: axum::http::Method, headers: HeaderMap| {
            let seen = seen.clone();
            let version = upstream_version.clone();
            async move {
                assert_eq!(headers[header::AUTHORIZATION], "Bearer fixture");
                assert_eq!(headers[header::ACCEPT_ENCODING], "identity");
                assert_ne!(
                    headers.get(header::IF_MATCH).map(|v| v.to_str().unwrap()),
                    Some("\"malicious-config\"")
                );
                seen.lock()
                    .unwrap()
                    .push((uri.path().into(), headers.clone()));
                let version = version.load(Ordering::SeqCst);
                let etag = format!("\"v{version}\"");
                let size = if uri.path() == "/empty" { 0 } else { 4096_u64 };
                if uri.path() != "/dishonest"
                    && headers
                        .get(header::IF_MATCH)
                        .is_some_and(|v| v != etag.as_str())
                {
                    return Response::builder().status(412).body(Body::empty()).unwrap();
                }
                let range = if method == axum::http::Method::HEAD || uri.path() == "/ignore" {
                    None
                } else {
                    headers.get(header::RANGE).and_then(|v| v.to_str().ok())
                };
                let selected = range.map(|value| media_core::byte_range(Some(value), size));
                let mut response = Response::builder()
                    .header(header::CONTENT_TYPE, "video/mp4")
                    .header(header::ACCEPT_RANGES, "bytes");
                let sparse_head =
                    uri.path() == "/sparse-head" && method == axum::http::Method::HEAD;
                if !matches!(uri.path(), "/absent" | "/date") && !sparse_head {
                    response = response.header(
                        header::ETAG,
                        if uri.path() == "/weak" {
                            format!("W/{etag}")
                        } else {
                            etag
                        },
                    );
                }
                if uri.path() == "/date" {
                    response = response
                        .header(
                            header::LAST_MODIFIED,
                            if version == 1 {
                                "Wed, 30 Sep 2026 08:00:00 GMT"
                            } else {
                                "Wed, 30 Sep 2026 08:01:00 GMT"
                            },
                        )
                        .header(header::DATE, "Wed, 30 Sep 2026 08:03:00 GMT");
                }
                let (start, end) = match selected {
                    Some(Ok(Some((start, end)))) => {
                        response = response
                            .status(206)
                            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
                        (start, end + 1)
                    }
                    Some(Err(_)) => {
                        return response
                            .status(416)
                            .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                            .body(Body::empty())
                            .unwrap();
                    }
                    _ => (0, size),
                };
                let length = end - start;
                if sparse_head {
                    return response
                        .body(Body::from_stream(futures_util::stream::empty::<
                            std::io::Result<axum::body::Bytes>,
                        >()))
                        .unwrap();
                }
                response = response.header(header::CONTENT_LENGTH, length);
                response
                    .body(if method == axum::http::Method::HEAD {
                        Body::empty()
                    } else {
                        Body::from(vec![version as u8; length as usize])
                    })
                    .unwrap()
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let id = session(&app).await;
    let url = format!("{origin}/movie");
    let response = fetch(&app, id, &url, Some("bytes=100-199"), None, false, false)
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(
        response.headers()[header::CONTENT_RANGE],
        "bytes 100-199/4096"
    );
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "100");
    assert_eq!(response.headers()[header::ETAG], "\"v1\"");
    assert_eq!(bytes(response).await, vec![1; 100]);
    let response = fetch(&app, id, &url, None, None, true, false)
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "4096");
    assert_eq!(response.headers()[header::ETAG], "\"v1\"");
    assert!(bytes(response).await.is_empty());
    for (value, status, length) in [
        ("\"v1\"", 206, 100),
        ("\"old\"", 200, 4096),
        ("W/\"v1\"", 200, 4096),
    ] {
        let response = fetch(
            &app,
            id,
            &url,
            Some("bytes=100-199"),
            Some(value),
            false,
            false,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), status);
        assert_eq!(bytes(response).await.len(), length);
    }
    for (range, status, length) in [
        ("bytes=-500", 206, 500),
        ("bytes=4000-9999", 206, 96),
        ("bytes=0-", 206, 4096),
        ("bytes=4096-", 416, 0),
        ("bytes=0-1,3-4", 200, 4096),
        ("bytes=3-2", 200, 4096),
    ] {
        let response = fetch(&app, id, &url, Some(range), None, false, false)
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{range}");
        if status == 416 {
            assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */4096");
        }
        assert_eq!(bytes(response).await.len(), length);
    }
    let records = requests.lock().unwrap().clone();
    assert_eq!(records[0].1[header::RANGE], "bytes=0-1023");
    assert_eq!(records[1].1[header::RANGE], "bytes=100-199");
    assert_eq!(records[1].1[header::IF_MATCH], "\"v1\"");
    assert_eq!(records[1].1[header::IF_RANGE], "\"v1\"");

    // A HEAD that omits optional metadata cannot erase or poison the pin.
    let sparse_id = session(&app).await;
    let sparse_url = format!("{origin}/sparse-head");
    assert!(
        bytes(
            fetch(&app, sparse_id, &sparse_url, None, None, true, false)
                .await
                .unwrap()
        )
        .await
        .is_empty()
    );
    assert!(
        identity::load(&app.db, sparse_id, &sparse_url)
            .await
            .unwrap()
            .is_none()
    );
    bytes(
        fetch(&app, sparse_id, &sparse_url, None, None, false, false)
            .await
            .unwrap(),
    )
    .await;
    let head = fetch(&app, sparse_id, &sparse_url, None, None, true, false)
        .await
        .unwrap();
    assert_eq!(head.headers()[header::ACCEPT_RANGES], "bytes");
    assert!(bytes(head).await.is_empty());
    assert!(
        identity::load(&app.db, sparse_id, &sparse_url)
            .await
            .unwrap()
            .unwrap()
            .metadata
            .reliable()
    );

    // Durable pins are loaded by another App/connection, not a process cache.
    let other_app = make_app(persistence::connect(&connection).await.unwrap());
    let response = fetch(
        &other_app,
        id,
        &url,
        Some("bytes=200-299"),
        None,
        false,
        false,
    )
    .await
    .unwrap();
    assert_eq!(bytes(response).await, vec![1; 100]);
    version.store(2, Ordering::SeqCst);
    assert_eq!(
        fetch(&app, id, &url, Some("bytes=200-299"), None, false, false)
            .await
            .unwrap_err(),
        identity::changed()
    );
    let stopped: bool = sqlx::query_scalar("SELECT stopped FROM playback_sessions WHERE id=$1")
        .bind(id)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert!(stopped);
    let tombstone: bool = sqlx::query_scalar("SELECT (identity->>'changed')::boolean FROM playback_http_representations WHERE session_id=$1").bind(id).fetch_one(&app.db).await.unwrap();
    assert!(tombstone);
    version.store(1, Ordering::SeqCst);

    // Fragments are not part of the HTTP target and cannot mint a second pin.
    let alias_id = session(&app).await;
    let alias_url = format!("{origin}/absent#first");
    bytes(
        fetch(&app, alias_id, &alias_url, None, None, false, false)
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        fetch(
            &app,
            alias_id,
            &format!("{origin}/absent#second"),
            None,
            None,
            false,
            false
        )
        .await
        .unwrap_err(),
        identity::required()
    );
    let rewritten = rewrite(
        &app,
        alias_id,
        &resource(&alias_url),
        &Params {
            token: "fixture".into(),
            url: None,
            attempt: None,
            execution: None,
        },
        &url::Url::parse(&format!("{origin}/master.m3u8")).unwrap(),
        0,
        "#EXTM3U\n#EXTINF:1,\nsegment.ts#one\n#EXTINF:1,\nsegment.ts#two\n#EXT-X-ENDLIST\n",
    )
    .unwrap();
    let uris: Vec<_> = rewritten
        .lines()
        .filter(|line| !line.starts_with('#'))
        .collect();
    assert_eq!(uris.len(), 2);
    assert_eq!(uris[0], uris[1]);
    assert_eq!(
        fetch(&app, id, &url, None, None, false, false)
            .await
            .unwrap_err(),
        identity::changed()
    );

    let id = session(&app).await;
    let url = format!("{origin}/dishonest");
    bytes(
        fetch(&app, id, &url, None, None, false, false)
            .await
            .unwrap(),
    )
    .await;
    version.store(2, Ordering::SeqCst);
    assert_eq!(
        fetch(&app, id, &url, None, None, false, false)
            .await
            .unwrap_err(),
        identity::changed()
    );
    version.store(1, Ordering::SeqCst);

    for path in ["weak", "absent"] {
        let id = session(&app).await;
        let url = format!("{origin}/{path}");
        assert!(
            bytes(
                fetch(&app, id, &url, None, None, true, false)
                    .await
                    .unwrap()
            )
            .await
            .is_empty()
        );
        let response = fetch(&app, id, &url, None, None, false, false)
            .await
            .unwrap();
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "none");
        assert!(!response.headers().contains_key(header::ETAG));
        assert_eq!(bytes(response).await.len(), 4096);
        assert_eq!(
            fetch(&app, id, &url, None, None, false, false)
                .await
                .unwrap_err(),
            identity::required()
        );
        let id = session(&app).await;
        assert_eq!(
            fetch(&app, id, &url, Some("bytes=100-199"), None, false, false)
                .await
                .unwrap_err(),
            identity::required()
        );
        let id = session(&app).await;
        assert_eq!(
            fetch(&app, id, &url, None, None, false, true)
                .await
                .unwrap_err(),
            identity::required()
        );
    }
    let id = session(&app).await;
    let url = format!("{origin}/date");
    bytes(
        fetch(&app, id, &url, None, None, false, false)
            .await
            .unwrap(),
    )
    .await;
    let response = fetch(
        &app,
        id,
        &url,
        Some("bytes=100-199"),
        Some("Wed, 30 Sep 2026 08:00:00 GMT"),
        false,
        false,
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 206);
    bytes(response).await;
    assert!(requests.lock().unwrap().iter().any(|(path, h)| {
        path == "/date"
            && h.get(header::IF_UNMODIFIED_SINCE)
                .is_some_and(|v| v == "Wed, 30 Sep 2026 08:00:00 GMT")
    }));
    version.store(2, Ordering::SeqCst);
    assert_eq!(
        fetch(&app, id, &url, Some("bytes=4096-"), None, false, false)
            .await
            .unwrap_err(),
        identity::changed()
    );
    version.store(1, Ordering::SeqCst);

    let id = session(&app).await;
    let url = format!("{origin}/ignore");
    let response = fetch(&app, id, &url, Some("bytes=100-199"), None, false, false)
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(!response.headers().contains_key(header::CONTENT_RANGE));
    assert_eq!(bytes(response).await.len(), 4096);
    let error = fetch(&app, id, &url, Some("bytes=100-199"), None, false, true)
        .await
        .unwrap_err();
    assert_eq!(
        error,
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            "source_seek_unsupported".into()
        )
    );
    let execution = app.input_failures.register(id);
    let observation = app.input_failures.observe(id, Some(execution.token()));
    let q = Params {
        token: "fixture".into(),
        url: None,
        attempt: None,
        execution: Some(execution.token()),
    };
    let mut headers = HeaderMap::new();
    headers.insert(header::RANGE, "bytes=100-199".parse().unwrap());
    let error = prepare_pinned(&app, id, &resource(&url), &q, &headers, false, observation)
        .await
        .unwrap_err();
    assert_eq!(error.1, "source_seek_unsupported");
    assert!(matches!(
        execution.failure(),
        Some(persistence::media_jobs::JobFailure::SourceSeekUnsupported)
    ));

    let id = session(&app).await;
    let url = format!("{origin}/empty");
    assert!(
        bytes(
            fetch(&app, id, &url, None, None, false, false)
                .await
                .unwrap()
        )
        .await
        .is_empty()
    );
    let response = fetch(&app, id, &url, Some("bytes=0-"), None, false, false)
        .await
        .unwrap();
    assert_eq!(response.status(), 416);
    assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */0");

    // Conflicting simultaneous first commits cannot both authorize bodies.
    let id = session(&app).await;
    let a = Metadata {
        final_target_sha256: None,
        etag: Some("\"first\"".into()),
        modified: None,
        reliable_modified: false,
        size: Some(10),
    };
    let b = Metadata {
        etag: Some("\"second\"".into()),
        ..a.clone()
    };
    let (first, second) = tokio::join!(
        identity::commit(&app.db, id, "race", &a, Some(Class::Binary), true, true),
        identity::commit(
            &other_app.db,
            id,
            "race",
            &b,
            Some(Class::Binary),
            true,
            true
        )
    );
    assert_ne!(first.is_ok(), second.is_ok());
    assert_eq!(
        first.err().or_else(|| second.err()).unwrap(),
        identity::changed()
    );
    let persisted: bool = sqlx::query_scalar("SELECT stopped FROM playback_sessions WHERE id=$1")
        .bind(id)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert!(persisted);
    let id = session(&app).await;
    let weak = Metadata {
        etag: None,
        ..a.clone()
    };
    let (first, second) = tokio::join!(
        identity::commit(
            &app.db,
            id,
            "single",
            &weak,
            Some(Class::Binary),
            true,
            false
        ),
        identity::commit(
            &other_app.db,
            id,
            "single",
            &weak,
            Some(Class::Binary),
            true,
            false
        )
    );
    assert_ne!(first.is_ok(), second.is_ok());
    assert_eq!(
        first.err().or_else(|| second.err()).unwrap(),
        identity::required()
    );
    sqlx::query("DELETE FROM playback_sessions WHERE id=$1")
        .bind(id)
        .execute(&app.db)
        .await
        .unwrap();
    assert!(
        identity::load(&app.db, id, "single")
            .await
            .unwrap()
            .is_none()
    );
    redirected_http_representation_contract(&app).await;
    server.abort();
    server.await.unwrap_err();
    other_app.db.close().await;
    app.db.close().await;
}

#[tokio::test]
async fn chunked_body_accounting_rejects_truncation_and_overflow() {
    for (actual, expected, success) in [(2, 3, false), (4, 3, false), (3, 3, true), (0, 0, true)] {
        let body = futures_util::stream::iter([Ok(axum::body::Bytes::from(vec![1; actual]))]);
        let stream = counted_stream(body, Some(expected), Default::default());
        let result: Vec<_> = stream.collect().await;
        assert_eq!(result.iter().all(|v| v.is_ok()), success);
    }
}

#[tokio::test]
async fn short_sniffed_bodies_remain_terminated_when_consumed_after_eof() {
    for bytes in [
        b"#EXTM3U\n#EXT-X-ENDLIST\n".as_slice(),
        b"small binary",
        b"",
    ] {
        let source = futures_util::stream::iter([Ok(axum::body::Bytes::copy_from_slice(bytes))]);
        let mut stream = counted_stream(source, Some(bytes.len() as u64), Default::default());
        let mut prefix = Vec::new();
        while prefix.len() < http_delivery::SNIFF_BYTES {
            let Some(chunk) = stream.next().await else {
                break;
            };
            prefix.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(prefix, bytes);
        assert!(stream.next().await.is_none());
        assert!(stream.next().await.is_none());
    }
}

// Reuses only the freshly-created database owned by the coordinator above.
async fn redirected_http_representation_contract(app: &App) {
    let cdn_router=Router::new().fallback(|uri: axum::http::Uri, method: axum::http::Method, headers: HeaderMap| async move {
        assert!(!headers.contains_key(header::AUTHORIZATION));
        assert!(!headers.contains_key(header::COOKIE));
        if uri.path()=="/nested/list.m3u8" {
            let text="#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n";
            return Response::builder().header(header::CONTENT_TYPE,"application/vnd.apple.mpegurl").header(header::CONTENT_LENGTH,text.len()).header(header::ETAG,"\"manifest\"").body(Body::from(text)).unwrap();
        }
        let range=headers.get(header::RANGE).and_then(|value| value.to_str().ok());
        let (start,end)=if method==axum::http::Method::HEAD { (0,63) } else { media_core::byte_range(range,64).unwrap().unwrap_or((0,63)) };
        let mut response=Response::builder().header(header::ETAG,"\"equal-across-destinations\"").header(header::CONTENT_LENGTH,end-start+1);
        if range.is_some() && method!=axum::http::Method::HEAD { response=response.status(206).header(header::CONTENT_RANGE,format!("bytes {start}-{end}/64")); }
        response.body(if method==axum::http::Method::HEAD { Body::empty() } else { Body::from(vec![1; (end-start+1) as usize]) }).unwrap()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cdn = format!("http://{}", listener.local_addr().unwrap());
    let cdn_task = tokio::spawn(async move { axum::serve(listener, cdn_router).await.unwrap() });
    let destination = Arc::new(Mutex::new(format!("{cdn}/file?signature=one")));
    let selected = destination.clone();
    let source_router = Router::new().fallback(move |headers: HeaderMap| {
        let location = selected.lock().unwrap().clone();
        async move {
            assert_eq!(headers[header::AUTHORIZATION], "Bearer fixture");
            Response::builder()
                .status(302)
                .header(header::LOCATION, location)
                .body(Body::empty())
                .unwrap()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = format!("http://{}", listener.local_addr().unwrap());
    let source_task =
        tokio::spawn(async move { axum::serve(listener, source_router).await.unwrap() });
    let root = format!("{source}/root");
    let resource = json!({"kind":"http","url":root,"source_url":source,"headers":{"Authorization":"Bearer fixture","Cookie":"fixture=secret"},
        "access_policy":{"schema_version":1,"origins":[{"origin":source,"cidrs":["127.0.0.1/32"]},{"origin":cdn,"cidrs":["127.0.0.1/32"]}],"redirects":{"max_hops":5}}});
    let q = Params {
        token: "fixture".into(),
        url: None,
        attempt: None,
        execution: None,
    };
    let id = session(app).await;
    let first = prepare_pinned(
        app,
        id,
        &resource,
        &q,
        &HeaderMap::new(),
        false,
        Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(bytes(first).await, vec![1; 64]);
    let state = identity::load(&app.db, id, &root).await.unwrap().unwrap();
    assert_eq!(
        state.metadata.final_target_sha256,
        Some(hash(&format!("{cdn}/file?signature=one")))
    );
    let head = prepare_pinned(
        app,
        id,
        &resource,
        &q,
        &HeaderMap::new(),
        true,
        Default::default(),
    )
    .await
    .unwrap();
    assert!(bytes(head).await.is_empty());
    let mut ranged = HeaderMap::new();
    ranged.insert(header::RANGE, "bytes=10-19".parse().unwrap());
    let partial = prepare_pinned(app, id, &resource, &q, &ranged, false, Default::default())
        .await
        .unwrap();
    assert_eq!(partial.status(), 206);
    assert_eq!(bytes(partial).await, vec![1; 10]);
    *destination.lock().unwrap() = format!("{cdn}/file?signature=two");
    assert_eq!(
        prepare_pinned(
            app,
            id,
            &resource,
            &q,
            &HeaderMap::new(),
            true,
            Default::default()
        )
        .await
        .unwrap_err(),
        identity::changed()
    );
    *destination.lock().unwrap() = format!("{cdn}/file?signature=one");
    assert_eq!(
        prepare_pinned(app, id, &resource, &q, &ranged, false, Default::default())
            .await
            .unwrap_err(),
        identity::changed()
    );
    // Old no-follow evidence must never silently acquire a redirected identity.
    let legacy = session(app).await;
    let mut old = state.metadata.clone();
    old.final_target_sha256 = None;
    identity::commit(
        &app.db,
        legacy,
        &root,
        &old,
        Some(Class::Binary),
        true,
        true,
    )
    .await
    .unwrap();
    assert_eq!(
        prepare_pinned(
            app,
            legacy,
            &resource,
            &q,
            &ranged,
            false,
            Default::default()
        )
        .await
        .unwrap_err(),
        identity::changed()
    );
    // HLS tickets keep the final manifest directory without inheriting its query.
    let id = session(app).await;
    *destination.lock().unwrap() = format!("{cdn}/nested/list.m3u8?signature=manifest");
    let response = prepare_pinned(
        app,
        id,
        &resource,
        &q,
        &HeaderMap::new(),
        false,
        Default::default(),
    )
    .await
    .unwrap();
    let text = String::from_utf8(bytes(response).await).unwrap();
    assert!(!text.contains(&cdn));
    assert!(!text.contains("signature=manifest"));
    let manifest = Manifest::parse(&text).unwrap();
    let mut targets = Vec::new();
    for reference in manifest.references() {
        let exposed = url::Url::parse(&format!("http://gateway.invalid{}", reference.uri)).unwrap();
        let encoded = exposed
            .query_pairs()
            .find(|(key, _)| key == "url")
            .unwrap()
            .1
            .into_owned();
        let child = Params {
            token: "fixture".into(),
            url: Some(encoded),
            attempt: None,
            execution: None,
        };
        targets.push(target(app, id, &resource, &child).unwrap().0.to_string());
    }
    assert_eq!(
        targets,
        vec![
            format!("{cdn}/nested/init.mp4"),
            format!("{cdn}/nested/key.bin"),
            format!("{cdn}/nested/segment.ts")
        ]
    );
    source_task.abort();
    cdn_task.abort();
    source_task.await.unwrap_err();
    cdn_task.await.unwrap_err();
}
