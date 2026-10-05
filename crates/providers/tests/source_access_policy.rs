//! Independent harness until integration exports providers::access_policy.
use providers::access_policy;

use access_policy::{
    AccessError, Enforcement, Resolution, Resolver, SourceAccess, SourceAccessPolicy,
};
use reqwest::Method;
use serde_json::json;
use std::{
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn strict(origin: &str, cidrs: &[&str]) -> SourceAccess {
    let policy: SourceAccessPolicy = serde_json::from_value(json!({
        "schema_version": 1,
        "origins": [{"origin": origin, "cidrs": cidrs}],
    }))
    .unwrap();
    SourceAccess::new(&format!("{origin}/media?private=never-log"), Some(&policy)).unwrap()
}

fn addresses(values: &[&str]) -> Vec<SocketAddr> {
    values.iter().map(|value| value.parse().unwrap()).collect()
}

#[test]
fn public_only_policy_preserves_old_bytes_and_rejects_all_private_answer_members() {
    let origin = "https://media.invalid";
    let old: SourceAccessPolicy = serde_json::from_value(json!({"schema_version":1,
        "origins":[{"origin":origin,"cidrs":["0.0.0.0/0","::/0"]}]}))
    .unwrap();
    assert!(!old.public_only);
    assert!(
        serde_json::to_value(&old)
            .unwrap()
            .get("public_only")
            .is_none()
    );
    let policy = SourceAccessPolicy::public_origin(origin).unwrap();
    assert!(policy.public_only);
    assert_eq!(serde_json::to_value(&policy).unwrap()["public_only"], true);
    let access = SourceAccess::new(origin, Some(&policy)).unwrap();
    assert!(
        access
            .validate_addresses(
                origin,
                &addresses(&["8.8.8.8:443", "[2001:4860:4860::8888]:443"])
            )
            .is_ok()
    );
    for denied in [
        "127.0.0.1:443",
        "10.0.0.1:443",
        "169.254.169.254:443",
        "168.63.129.16:443",
        "192.168.1.1:443",
        "100.64.0.1:443",
        "192.0.2.1:443",
        "[::1]:443",
        "[::ffff:127.0.0.1]:443",
        "[fc00::1]:443",
        "[fe80::1]:443",
        "[2001:db8::1]:443",
        "[64:ff9b::7f00:1]:443",
    ] {
        assert_eq!(
            access.validate_addresses(origin, &addresses(&[denied])),
            Err(AccessError::AddressDenied),
            "{denied}"
        );
        assert_eq!(
            access.validate_addresses(origin, &addresses(&["8.8.8.8:443", denied])),
            Err(AccessError::AddressDenied),
            "mixed {denied}"
        );
    }
    // Existing administrator CIDR configurations still admit explicit LAN.
    assert!(
        SourceAccess::new(origin, Some(&old))
            .unwrap()
            .validate_addresses(origin, &addresses(&["127.0.0.1:443"]))
            .is_ok()
    );
}

#[tokio::test]
async fn public_only_get_head_and_source_builder_deny_loopback_before_socket_io() {
    let (port, server) = local_origin().await;
    let origin = format!("http://127.0.0.1:{port}");
    let policy = SourceAccessPolicy::public_origin(&origin).unwrap();
    let config: providers::SourceConfig =
        serde_json::from_value(json!({"url":origin,"access_policy":policy})).unwrap();
    for method in [Method::GET, Method::HEAD] {
        let result =
            providers::source_media_request(&config, &origin, method.clone(), &Default::default())
                .await
                .unwrap()
                .send()
                .await;
        assert!(matches!(
            result,
            Err(providers::media_request::MediaRequestError::Access(
                AccessError::AddressDenied
            ))
        ));
        let result = providers::source_request(&config, &origin, method, &Default::default()).await;
        assert_eq!(result.err().unwrap().to_string(), "source_address_denied");
    }
    server.abort();
}

#[test]
fn strict_policy_rejects_unknown_malformed_and_ambiguous_fields() {
    for policy in [
        json!({"schema_version":1,"origins":[],"fallback":"allow"}),
        json!({"schema_version":1,"origins":[{"origin":"http://media.invalid","cidrs":["127.0.0.0/8"],"allow_proxy":true}]}),
        json!({"schema_version":"1","origins":[]}),
    ] {
        assert!(serde_json::from_value::<SourceAccessPolicy>(policy).is_err());
    }
    for policy in [
        json!({"schema_version":1,"origins":[]}),
        json!({"schema_version":1,"origins":[{"origin":"http://media.invalid","cidrs":[]}]}),
        json!({"schema_version":1,"origins":[{"origin":"http://other.invalid","cidrs":["127.0.0.0/8"]}]}),
        json!({"schema_version":1,"origins":[{"origin":"http://media.invalid","cidrs":["127.0.0.0/8"]},{"origin":"http://MEDIA.invalid:80/","cidrs":["127.0.0.0/8"]}]}),
        json!({"schema_version":1,"origins":[{"origin":"http://media.invalid/path","cidrs":["127.0.0.0/8"]}]}),
        json!({"schema_version":1,"origins":[{"origin":"http://media.invalid/path/..","cidrs":["127.0.0.0/8"]}]}),
        json!({"schema_version":1,"origins":[{"origin":"http://*.invalid","cidrs":["127.0.0.0/8"]}]}),
        json!({"schema_version":1,"origins":[{"origin":"http://%6dedia.invalid","cidrs":["127.0.0.0/8"]}]}),
        json!({"schema_version":1,"origins":[{"origin":"http://media.invalid?token=secret","cidrs":["127.0.0.0/8"]}]}),
        json!({"schema_version":1,"origins":[{"origin":"http://media.invalid#private","cidrs":["127.0.0.0/8"]}]}),
    ] {
        let policy: SourceAccessPolicy = serde_json::from_value(policy).unwrap();
        assert!(matches!(
            SourceAccess::new("http://media.invalid/root", Some(&policy)),
            Err(AccessError::InvalidPolicy)
        ));
    }
    let policy: SourceAccessPolicy =
        serde_json::from_value(json!({"schema_version":2,"origins":[]})).unwrap();
    assert!(matches!(
        SourceAccess::new("http://media.invalid", Some(&policy)),
        Err(AccessError::UnsupportedVersion)
    ));
}

#[test]
fn cidrs_require_canonical_networks_and_normalize_mapped_ipv4() {
    for cidrs in [
        vec!["127.0.0.1/8"],
        vec!["10.0.0.0/33"],
        vec!["::/129"],
        vec!["10.0.0.0/08"],
        vec!["127.0.0.1"],
        vec!["::ffff:0:0/95"],
        vec!["127.0.0.0/8", "::ffff:127.0.0.0/104"],
    ] {
        let policy: SourceAccessPolicy = serde_json::from_value(
            json!({"schema_version":1,"origins":[{"origin":"http://media.invalid","cidrs":cidrs}]}),
        )
        .unwrap();
        assert!(matches!(
            SourceAccess::new("http://media.invalid", Some(&policy)),
            Err(AccessError::InvalidPolicy)
        ));
    }
    let policy = strict("http://media.invalid", &["127.0.0.0/8", "2001:db8::/32"]);
    assert_eq!(policy.enforcement(), Enforcement::StrictCidrsV1);
    let result = policy
        .validate_addresses(
            "http://media.invalid",
            &addresses(&["[::ffff:127.0.0.1]:80", "127.0.0.1:80", "[2001:db8::1]:80"]),
        )
        .unwrap();
    assert_eq!(result, addresses(&["127.0.0.1:80", "[2001:db8::1]:80"]));
    let mapped_policy = strict("http://media.invalid", &["::ffff:192.0.2.0/120"]);
    assert!(
        mapped_policy
            .validate_addresses("http://media.invalid", &addresses(&["192.0.2.12:80"]))
            .is_ok()
    );
    // A native IPv6 wildcard must not accidentally authorize mapped IPv4.
    assert_eq!(
        strict("http://media.invalid", &["::/0"]).validate_addresses(
            "http://media.invalid",
            &addresses(&["[::ffff:127.0.0.1]:80"])
        ),
        Err(AccessError::AddressDenied)
    );
}

#[test]
fn every_dns_answer_must_be_allowed_without_filtering_or_network_class_guessing() {
    let public_only = strict("http://media.invalid", &["93.184.216.0/24"]);
    assert!(
        public_only
            .validate_addresses("http://media.invalid", &addresses(&["93.184.216.34:80"]))
            .is_ok()
    );
    assert_eq!(
        public_only.validate_addresses(
            "http://media.invalid",
            &addresses(&["93.184.216.34:80", "10.0.0.2:80"])
        ),
        Err(AccessError::AddressDenied)
    );
    assert_eq!(
        public_only.validate_addresses(
            "http://media.invalid",
            &addresses(&["[::ffff:10.0.0.2]:80"])
        ),
        Err(AccessError::AddressDenied)
    );
    let intentional_mix = strict("http://media.invalid", &["93.184.216.0/24", "10.0.0.0/8"]);
    assert!(
        intentional_mix
            .validate_addresses(
                "http://media.invalid",
                &addresses(&["93.184.216.34:80", "10.0.0.2:80"])
            )
            .is_ok()
    );
    assert_eq!(
        public_only.validate_addresses("http://media.invalid", &[]),
        Err(AccessError::EmptyDnsAnswer)
    );
    assert_eq!(
        public_only.validate_addresses(
            "http://media.invalid",
            &["93.184.216.34:80".parse().unwrap(); 65]
        ),
        Err(AccessError::DnsAnswerLimit)
    );
    assert_eq!(
        public_only.validate_addresses("http://media.invalid", &addresses(&["93.184.216.34:81"])),
        Err(AccessError::InvalidAddress)
    );
    for value in [
        "0.0.0.0:80",
        "224.0.0.1:80",
        "255.255.255.255:80",
        "[::]:80",
        "[ff02::1]:80",
    ] {
        assert_eq!(
            strict("http://media.invalid", &["0.0.0.0/0", "::/0"])
                .validate_addresses("http://media.invalid", &addresses(&[value])),
            Err(AccessError::InvalidAddress)
        );
    }
}

#[test]
fn legacy_keeps_exact_admin_origin_and_lan_without_claiming_cidr_protection() {
    let access = SourceAccess::new("http://nas.invalid:8096/emby", None).unwrap();
    assert_eq!(access.enforcement(), Enforcement::LegacyOriginOnly);
    assert!(
        access
            .validate_addresses(
                "http://nas.invalid:8096/Videos/movie",
                &addresses(&["192.168.1.5:8096", "127.0.0.1:8096", "[::1]:8096"])
            )
            .is_ok()
    );
    for url in [
        "http://other.invalid:8096/",
        "https://nas.invalid:8096/",
        "http://nas.invalid:8097/",
        "http://nas.invalid/",
    ] {
        assert_eq!(access.authorize_url(url), Err(AccessError::OriginDenied));
    }
    for url in [
        "file:///media/movie",
        "http://user:private@nas.invalid:8096/",
        "http://nas.invalid:8096\\evil",
        " http://nas.invalid:8096/",
        "http://nas.invalid:8096/\n",
        "http://nas.invalid:0/",
    ] {
        let error = access.authorize_url(url).unwrap_err();
        assert_eq!(error, AccessError::InvalidUrl);
        assert_eq!(error.to_string(), "invalid_source_url");
    }
    assert_eq!(
        access
            .authorize_url("http://nas.invalid:8096/movie#ignored")
            .unwrap()
            .fragment(),
        None
    );
}

struct FakeResolver {
    answer: Arc<Mutex<Vec<SocketAddr>>>,
    calls: Arc<AtomicUsize>,
}
impl Resolver for FakeResolver {
    fn resolve<'a>(&'a self, _host: &'a str, _port: u16) -> Resolution<'a> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let answer = self.answer.lock().unwrap().clone();
        Box::pin(async move { Ok(answer) })
    }
}
impl FakeResolver {
    fn new(answer: Vec<SocketAddr>) -> Self {
        Self {
            answer: Arc::new(Mutex::new(answer)),
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }
}

async fn local_origin() -> (u16, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut socket, _) =
            tokio::time::timeout(std::time::Duration::from_secs(10), listener.accept())
                .await
                .unwrap()
                .unwrap();
        let mut request = Vec::new();
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let mut chunk = [0; 1024];
            let read = socket.read(&mut chunk).await.unwrap();
            assert!(read > 0 && request.len() + read <= 16 * 1024);
            request.extend_from_slice(&chunk[..read]);
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\npinned")
            .await
            .unwrap();
        String::from_utf8(request).unwrap()
    });
    (port, server)
}

#[tokio::test]
async fn connects_to_checked_address_preserves_host_and_rejects_later_rebinding() {
    let (port, server) = local_origin().await;
    let origin = format!("http://pinned.invalid:{port}");
    let access = strict(&origin, &["127.0.0.1/32"]);
    let resolver = FakeResolver::new(vec![SocketAddr::from(([127, 0, 0, 1], port))]);
    let client = access
        .client_for_with_resolver(&format!("{origin}/media"), &resolver)
        .await
        .unwrap();
    assert!(client.source_credentials_allowed());
    assert_eq!(client.enforcement(), Enforcement::StrictCidrsV1);
    assert_eq!(
        client.addresses(),
        &[SocketAddr::from(([127, 0, 0, 1], port))]
    );
    *resolver.answer.lock().unwrap() = vec![SocketAddr::from(([127, 0, 0, 2], port))];
    let response = client.request(Method::GET).send().await.unwrap();
    assert_eq!(
        response.remote_addr().unwrap().ip(),
        "127.0.0.1".parse::<std::net::IpAddr>().unwrap()
    );
    assert_eq!(response.text().await.unwrap(), "pinned");
    assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
    let request = server.await.unwrap();
    assert!(
        request
            .to_ascii_lowercase()
            .contains(&format!("host: pinned.invalid:{port}\r\n"))
    );
    assert!(matches!(
        access.client_for_with_resolver(&origin, &resolver).await,
        Err(AccessError::AddressDenied)
    ));
    assert_eq!(resolver.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn exact_origin_checks_precede_dns_and_ip_literals_do_not_resolve() {
    let access = strict("http://127.0.0.1", &["127.0.0.1/32"]);
    let resolver = FakeResolver::new(addresses(&["10.0.0.1:80"]));
    assert!(
        access
            .client_for_with_resolver("http://127.0.0.1/media", &resolver)
            .await
            .is_ok()
    );
    assert_eq!(resolver.calls.load(Ordering::SeqCst), 0);
    assert!(matches!(
        access
            .client_for_with_resolver("http://127.0.0.2/media", &resolver)
            .await,
        Err(AccessError::OriginDenied)
    ));
    assert_eq!(resolver.calls.load(Ordering::SeqCst), 0);
    let mapped = strict("http://[::ffff:127.0.0.1]", &["127.0.0.1/32"]);
    assert!(
        mapped
            .client_for_with_resolver("http://[::ffff:127.0.0.1]", &resolver)
            .await
            .is_ok()
    );
    assert_eq!(resolver.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn extra_origin_is_explicitly_anonymous() {
    let policy: SourceAccessPolicy = serde_json::from_value(json!({"schema_version":1,"origins":[
        {"origin":"http://primary.invalid","cidrs":["127.0.0.1/32"]},
        {"origin":"http://cdn.invalid","cidrs":["127.0.0.1/32"]}
    ]}))
    .unwrap();
    let access = SourceAccess::new("http://primary.invalid/root", Some(&policy)).unwrap();
    let resolver = FakeResolver::new(addresses(&["127.0.0.1:80"]));
    let client = access
        .client_for_with_resolver("http://cdn.invalid/media", &resolver)
        .await
        .unwrap();
    assert!(!client.source_credentials_allowed());
}

struct FailingResolver;
impl Resolver for FailingResolver {
    fn resolve<'a>(&'a self, _host: &'a str, _port: u16) -> Resolution<'a> {
        Box::pin(async { Err(std::io::Error::other("secret-token must not escape")) })
    }
}
#[tokio::test]
async fn resolver_errors_are_redacted() {
    let result = strict("http://media.invalid", &["127.0.0.1/32"])
        .client_for_with_resolver("http://media.invalid/?token=private", &FailingResolver)
        .await;
    assert!(matches!(result, Err(AccessError::DnsFailed)));
}

struct PendingResolver;
impl Resolver for PendingResolver {
    fn resolve<'a>(&'a self, _host: &'a str, _port: u16) -> Resolution<'a> {
        Box::pin(std::future::pending())
    }
}
#[tokio::test]
async fn resolver_wait_has_a_finite_deadline() {
    let result = strict("http://media.invalid", &["127.0.0.1/32"])
        .client_for_with_resolver("http://media.invalid/", &PendingResolver)
        .await;
    assert!(matches!(result, Err(AccessError::DnsTimeout)));
}

#[tokio::test]
async fn redirects_remain_unfollowed_even_to_another_local_address() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let count = socket.read(&mut request).await.unwrap();
        assert!(count > 0, "received an actual HTTP request");
        socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.2:9/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
    });
    let origin = format!("http://redirect.invalid:{port}");
    let client = strict(&origin, &["127.0.0.1/32"])
        .client_for_with_resolver(
            &origin,
            &FakeResolver::new(vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        )
        .await
        .unwrap();
    assert_eq!(
        client.request(Method::GET).send().await.unwrap().status(),
        reqwest::StatusCode::FOUND
    );
    server.await.unwrap();
}

#[tokio::test]
async fn inherited_proxy_environment_cannot_override_a_pin() {
    let (port, server) = local_origin().await;
    let status = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "proxy_environment_child",
            "--ignored",
            "--nocapture",
        ])
        .env("RAINSYNC_ACCESS_TEST_PORT", port.to_string())
        .env("HTTP_PROXY", "http://127.0.0.1:9")
        .env("HTTPS_PROXY", "http://127.0.0.1:9")
        .env("ALL_PROXY", "http://127.0.0.1:9")
        .env("http_proxy", "http://127.0.0.1:9")
        .env("https_proxy", "http://127.0.0.1:9")
        .env("all_proxy", "http://127.0.0.1:9")
        .env("NO_PROXY", "")
        .env("no_proxy", "")
        .status()
        .await
        .unwrap();
    assert!(status.success());
    server.await.unwrap();
}

#[tokio::test]
#[ignore = "owned subprocess helper for inherited proxy environment"]
async fn proxy_environment_child() {
    let port = std::env::var("RAINSYNC_ACCESS_TEST_PORT")
        .unwrap()
        .parse::<u16>()
        .unwrap();
    let origin = format!("http://proxy-proof.invalid:{port}");
    let client = strict(&origin, &["127.0.0.1/32"])
        .client_for_with_resolver(
            &origin,
            &FakeResolver::new(vec![SocketAddr::from(([127, 0, 0, 1], port))]),
        )
        .await
        .unwrap();
    assert_eq!(
        client
            .request(Method::GET)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "pinned"
    );
}

#[tokio::test]
async fn system_resolver_path_accepts_literal_local_connection_without_external_dns() {
    let (port, server) = local_origin().await;
    let origin = format!("http://127.0.0.1:{port}");
    let client = SourceAccess::new(&origin, None)
        .unwrap()
        .client_for(&origin)
        .await
        .unwrap();
    assert_eq!(
        client
            .request(Method::GET)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "pinned"
    );
    server.await.unwrap();
}
