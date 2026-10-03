//! Owned loopback fixtures only. No system DNS, external hosts or real secrets.
use providers::{
    SourceConfig,
    access_policy::{AccessError, Resolution, Resolver},
    media_request::MediaRequestError,
    source_media_request,
};
use reqwest::{Method, header};
use serde_json::json;
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Fixture {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new(reply: impl Fn(&str, u16) -> String + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = vec![];
                loop {
                    let mut buf = [0; 1024];
                    let count = stream.read(&mut buf).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..count]);
                    if bytes.ends_with(b"\r\n\r\n") {
                        break;
                    }
                    assert!(bytes.len() < 65536);
                }
                let request = String::from_utf8(bytes).unwrap();
                seen.lock().unwrap().push(request.clone());
                let response = reply(&request, port);
                // A rejected redirect can close the connection without a body.
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        Self {
            port,
            requests,
            task,
        }
    }
    fn url(&self, path: &str) -> String {
        format!("http://primary.invalid:{}{path}", self.port)
    }
    fn config(&self, hops: Option<u8>, cdn: bool) -> SourceConfig {
        let mut origins = vec![json!({"origin":self.url(""),"cidrs":["127.0.0.1/32"]})];
        if cdn {
            origins.push(json!({"origin":format!("http://cdn.invalid:{}",self.port),"cidrs":["127.0.0.1/32"]}));
        }
        let mut policy = json!({"schema_version":1,"origins":origins});
        if let Some(hops) = hops {
            policy["redirects"] = json!({"max_hops":hops});
        }
        serde_json::from_value(
            json!({"url":self.url("/start?private=origin-secret"),"access_policy":policy}),
        )
        .unwrap()
    }
}
fn response(status: u16, headers: &str) -> String {
    format!("HTTP/1.1 {status} Fixture\r\n{headers}Content-Length: 0\r\nConnection: close\r\n\r\n")
}
fn redirect(status: u16, location: &str) -> String {
    response(status, &format!("Location: {location}\r\n"))
}
struct LocalResolver {
    calls: AtomicUsize,
}
impl LocalResolver {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
        }
    }
}
impl Resolver for LocalResolver {
    fn resolve<'a>(&'a self, _host: &'a str, port: u16) -> Resolution<'a> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(vec![SocketAddr::from(([127, 0, 0, 1], port))]) })
    }
}
async fn request(
    config: &SourceConfig,
    target: &str,
    method: Method,
    resolver: &impl Resolver,
) -> Result<reqwest::Response, MediaRequestError> {
    source_media_request(config, target, method, &BTreeMap::new())
        .await?
        .send_with_resolver(resolver)
        .await
}

#[tokio::test]
async fn strict_opt_in_is_bounded_and_legacy_and_old_policy_stay_no_follow() {
    let fixture = Fixture::new(|_, _| redirect(302, "/final")).await;
    for hops in [Some(0), Some(6), Some(255)] {
        assert!(matches!(
            request(
                &fixture.config(hops, false),
                &fixture.url("/start"),
                Method::GET,
                &LocalResolver::new()
            )
            .await,
            Err(MediaRequestError::Access(AccessError::InvalidPolicy))
        ));
    }
    let mut legacy = fixture.config(None, false);
    legacy.access_policy = None;
    for config in [fixture.config(None, false), legacy] {
        assert!(matches!(
            request(
                &config,
                &fixture.url("/start"),
                Method::GET,
                &LocalResolver::new()
            )
            .await,
            Err(MediaRequestError::RedirectDisabled)
        ));
    }
    assert_eq!(fixture.requests.lock().unwrap().len(), 2);
    let serialized = serde_json::to_value(fixture.config(None, false)).unwrap();
    assert!(serialized["access_policy"].get("redirects").is_none());
    for value in [
        json!({}),
        json!({"max_hops":1,"headers":{"Authorization":"secret"}}),
        json!({"max_hops":"5"}),
    ] {
        let mut config = serialized.clone();
        config["access_policy"]["redirects"] = value;
        assert!(serde_json::from_value::<SourceConfig>(config).is_err());
    }
}

#[tokio::test]
async fn all_supported_statuses_preserve_get_head_and_use_final_url() {
    for status in [301, 302, 303, 307, 308] {
        for method in [Method::GET, Method::HEAD] {
            let fixture = Fixture::new(move |request, _| {
                if request.lines().next().unwrap().contains(" /start") {
                    redirect(status, "/nested/final.m3u8")
                } else {
                    response(200, "")
                }
            })
            .await;
            let resolver = LocalResolver::new();
            let result = request(
                &fixture.config(Some(5), false),
                &fixture.url("/start?secret=not-inherited"),
                method.clone(),
                &resolver,
            )
            .await
            .unwrap();
            assert_eq!(result.url().as_str(), fixture.url("/nested/final.m3u8"));
            assert_eq!(
                resolver.calls.load(Ordering::SeqCst),
                2,
                "same-origin hop must re-resolve and pin"
            );
            let seen = fixture.requests.lock().unwrap();
            assert_eq!(seen.len(), 2);
            assert!(seen.iter().all(|r| r.starts_with(method.as_str())));
            assert!(!seen[1].contains("secret=not-inherited"));
            assert!(
                seen[1]
                    .to_ascii_lowercase()
                    .contains(&format!("host: primary.invalid:{}", fixture.port))
            );
        }
    }
}

#[tokio::test]
async fn relative_and_protocol_relative_locations_use_current_url_without_query_inheritance() {
    let fixture = Fixture::new(|request, port| {
        if request.contains(" /old/start?signature=private ") {
            redirect(302, "../new/middle")
        } else if request.contains(" /new/middle ") {
            redirect(
                307,
                &format!("//cdn.invalid:{port}/edge/final?signature=cdn"),
            )
        } else {
            response(200, "")
        }
    })
    .await;
    let result = request(
        &fixture.config(Some(5), true),
        &fixture.url("/old/start?signature=private"),
        Method::GET,
        &LocalResolver::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        result.url().as_str(),
        format!(
            "http://cdn.invalid:{}/edge/final?signature=cdn",
            fixture.port
        )
    );
    let seen = fixture.requests.lock().unwrap();
    assert_eq!(seen.len(), 3);
    assert!(seen[1].starts_with("GET /new/middle HTTP/1.1"));
    assert!(!seen[1].contains("signature=private"));
    assert!(!seen[2].contains("signature=private"));
}

#[tokio::test]
async fn exact_origin_credentials_never_cross_and_delivery_headers_survive() {
    let fixture = Fixture::new(|request, port| {
        if request.contains(" /start ") {
            redirect(302, &format!("http://cdn.invalid:{port}/edge"))
        } else if request.contains(" /edge ") {
            response(
                307,
                &format!(
                    "Location: http://primary.invalid:{port}/final\r\nSet-Cookie: stolen=value\r\n"
                ),
            )
        } else {
            response(200, "")
        }
    })
    .await;
    let source = BTreeMap::from([
        ("Authorization".into(), "Bearer fixture-secret".into()),
        ("Cookie".into(), "fixture=cookie-secret".into()),
        ("X-Custom-Secret".into(), "custom-secret".into()),
        (
            "Referer".into(),
            "https://private.invalid/query?secret=referrer".into(),
        ),
    ]);
    let config = fixture.config(Some(5), true);
    source_media_request(&config, &fixture.url("/start"), Method::GET, &source)
        .await
        .unwrap()
        .header(header::RANGE, "bytes=1-2")
        .header(header::IF_RANGE, "\"fixture-etag\"")
        .header(header::IF_MATCH, "\"fixture-etag\"")
        .header(header::ACCEPT_ENCODING, "identity")
        .send_with_resolver(&LocalResolver::new())
        .await
        .unwrap();
    let seen = fixture.requests.lock().unwrap();
    assert_eq!(seen.len(), 3);
    for index in [0, 2] {
        assert!(seen[index].contains("fixture-secret"));
        assert!(seen[index].contains("custom-secret"));
    }
    let cdn = seen[1].to_ascii_lowercase();
    for forbidden in [
        "authorization:",
        "cookie:",
        "x-custom-secret:",
        "referer:",
        "fixture-secret",
        "custom-secret",
    ] {
        assert!(!cdn.contains(forbidden), "{forbidden}");
    }
    for current in seen.iter() {
        let current = current.to_ascii_lowercase();
        assert!(current.contains("range: bytes=1-2\r\n"));
        assert!(current.contains("if-match: \"fixture-etag\"\r\n"));
        assert!(current.contains("if-range: \"fixture-etag\"\r\n"));
        assert!(current.contains("accept-encoding: identity\r\n"));
        assert!(!current.contains("stolen=value"));
    }
}

#[tokio::test]
async fn an_initial_cdn_target_never_becomes_the_credential_authority() {
    let fixture = Fixture::new(|_, _| response(200, "")).await;
    let config = fixture.config(Some(5), true);
    let headers = BTreeMap::from([
        ("Authorization".into(), "Bearer source-private".into()),
        ("Cookie".into(), "source=private".into()),
        ("X-Custom-Secret".into(), "private".into()),
    ]);
    let cdn = format!("http://cdn.invalid:{}/media", fixture.port);
    source_media_request(&config, &cdn, Method::GET, &headers)
        .await
        .unwrap()
        .send_with_resolver(&LocalResolver::new())
        .await
        .unwrap();
    let seen = fixture.requests.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let request = seen[0].to_ascii_lowercase();
    for forbidden in ["authorization:", "cookie:", "x-custom-secret:", "private"] {
        assert!(!request.contains(forbidden));
    }
}

#[tokio::test]
async fn transport_errors_have_no_url_or_nested_reqwest_cause() {
    use std::error::Error;
    let fixture = Fixture::new(|_, _| String::new()).await;
    let error = request(
        &fixture.config(Some(5), false),
        &fixture.url("/media?signature=never-log"),
        Method::GET,
        &LocalResolver::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(error, MediaRequestError::RequestFailed);
    assert!(error.source().is_none());
    for value in [format!("{error}"), format!("{error:?}")] {
        assert!(!value.contains("never-log"));
        assert!(!value.contains("media?"));
    }
}

#[tokio::test]
async fn exactly_five_redirects_pass_sixth_and_cycles_stop_without_extra_requests() {
    for redirects in [5, 6] {
        let fixture = Fixture::new(move |request, _| {
            let path = request.split_whitespace().nth(1).unwrap();
            let n = path.trim_start_matches('/').parse::<usize>().unwrap();
            if n < redirects {
                redirect(302, &format!("/{}", n + 1))
            } else {
                response(200, "")
            }
        })
        .await;
        let result = request(
            &fixture.config(Some(5), false),
            &fixture.url("/0"),
            Method::GET,
            &LocalResolver::new(),
        )
        .await;
        if redirects == 5 {
            assert!(result.is_ok());
        } else {
            assert!(matches!(result, Err(MediaRequestError::RedirectLimit)));
        }
        assert_eq!(fixture.requests.lock().unwrap().len(), 6);
    }
    let fixture = Fixture::new(|request, _| {
        redirect(
            302,
            if request.contains(" /a ") {
                "/b"
            } else {
                "/a#same"
            },
        )
    })
    .await;
    assert!(matches!(
        request(
            &fixture.config(Some(5), false),
            &fixture.url("/a"),
            Method::GET,
            &LocalResolver::new()
        )
        .await,
        Err(MediaRequestError::RedirectLoop)
    ));
    assert_eq!(fixture.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn disallowed_locations_stop_before_dns_or_destination_connection_and_errors_are_redacted() {
    for location in [
        "http://forbidden.invalid/private?signature=secret",
        "https://primary.invalid/private?signature=secret",
        "http://primary.invalid:1/private?signature=secret",
        "file:///private?signature=secret",
        "http://user:secret@primary.invalid/x",
        "\\\\forbidden.invalid\\secret",
        "#same",
    ] {
        let location = location.to_owned();
        let fixture = Fixture::new(move |_, _| redirect(302, &location)).await;
        let resolver = LocalResolver::new();
        let error = request(
            &fixture.config(Some(5), false),
            &fixture.url("/start?signature=secret"),
            Method::GET,
            &resolver,
        )
        .await
        .unwrap_err();
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
        for text in [error.to_string(), format!("{error:?}")] {
            assert!(!text.contains("secret"));
            assert!(!text.contains("invalid/"));
        }
    }
    for headers in ["", "Location: /a\r\nLocation: /b\r\n", "Location: \r\n"] {
        let headers = headers.to_owned();
        let fixture = Fixture::new(move |_, _| response(302, &headers)).await;
        assert!(matches!(
            request(
                &fixture.config(Some(5), false),
                &fixture.url("/start"),
                Method::GET,
                &LocalResolver::new()
            )
            .await,
            Err(MediaRequestError::InvalidLocation)
        ));
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }
}

struct RebindingResolver {
    calls: AtomicUsize,
    mixed: bool,
}
impl Resolver for RebindingResolver {
    fn resolve<'a>(&'a self, _host: &'a str, port: u16) -> Resolution<'a> {
        let next = self.calls.fetch_add(1, Ordering::SeqCst);
        let mixed = self.mixed;
        Box::pin(async move {
            let good = SocketAddr::from(([127, 0, 0, 1], port));
            let denied = SocketAddr::from(([169, 254, 169, 254], port));
            Ok(if next == 0 {
                vec![good]
            } else if mixed {
                vec![good, denied]
            } else {
                vec![denied]
            })
        })
    }
}
#[tokio::test]
async fn every_hop_rechecks_whole_dns_answer_before_connection() {
    for mixed in [true, false] {
        let fixture = Fixture::new(|_, _| redirect(302, "/next")).await;
        let resolver = RebindingResolver {
            calls: AtomicUsize::new(0),
            mixed,
        };
        assert!(matches!(
            request(
                &fixture.config(Some(5), false),
                &fixture.url("/start"),
                Method::GET,
                &resolver
            )
            .await,
            Err(MediaRequestError::Access(AccessError::AddressDenied))
        ));
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 2);
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn media_builder_rejects_mutating_methods_and_unscoped_delivery_headers_before_io() {
    let fixture = Fixture::new(|_, _| response(200, "")).await;
    let config = fixture.config(Some(5), false);
    for method in [Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS] {
        assert!(matches!(
            source_media_request(&config, &fixture.url("/start"), method, &BTreeMap::new()).await,
            Err(MediaRequestError::UnsupportedMethod)
        ));
    }
    for name in [
        header::AUTHORIZATION,
        header::COOKIE,
        header::HOST,
        header::REFERER,
        header::PROXY_AUTHORIZATION,
        header::HeaderName::from_static("x-custom-secret"),
    ] {
        assert!(matches!(
            source_media_request(
                &config,
                &fixture.url("/start"),
                Method::GET,
                &BTreeMap::new()
            )
            .await
            .unwrap()
            .header(name, "private")
            .send_with_resolver(&LocalResolver::new())
            .await,
            Err(MediaRequestError::InvalidHeaders)
        ));
    }
    assert!(fixture.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mutation_and_provider_request_builder_stay_no_follow_even_when_media_opted_in() {
    let fixture = Fixture::new(|_, _| redirect(303, "/unexpected")).await;
    let url = format!("http://127.0.0.1:{}/session", fixture.port);
    let config:SourceConfig=serde_json::from_value(json!({"url":url,"access_policy":{"schema_version":1,"origins":[{"origin":format!("http://127.0.0.1:{}",fixture.port),"cidrs":["127.0.0.1/32"]}],"redirects":{"max_hops":5}}})).unwrap();
    for method in [Method::GET, Method::POST] {
        let result = providers::source_request(&config, &url, method, &BTreeMap::new())
            .await
            .unwrap()
            .send()
            .await
            .unwrap();
        assert_eq!(result.status(), 303);
    }
    assert_eq!(fixture.requests.lock().unwrap().len(), 2);
}
