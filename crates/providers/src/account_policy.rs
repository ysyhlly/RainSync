//! Bounded, read-only account policy observations for configured upstream users.
//!
//! Jellyfin 10.11 and Emby expose the account policy through authenticated
//! `GET /Users/{Id}`. This reader never logs in, creates credentials, changes a
//! policy, or infers a different account from the token. A successful read only
//! observes these account flags; callers own freshness and playback revocation.
//! References:
//! https://github.com/jellyfin/jellyfin/blob/v10.11.0/Jellyfin.Api/Controllers/UserController.cs
//! https://dev.emby.media/reference/RestAPI/UserService/getUsersById.html

use crate::{
    SourceConfig,
    access_policy::{AccessError, Resolver, SourceAccess, SystemResolver},
    upstream_headers, validate_source_headers,
};
use reqwest::{Method, StatusCode};
use serde::Deserialize;
use std::{fmt, time::Duration};

pub const ACCOUNT_POLICY_TIMEOUT: Duration = Duration::from_secs(2);
pub const ACCOUNT_POLICY_MAX_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpstreamAccountPolicy {
    Allowed,
    Denied(AccountPolicyDenial),
}

/// Normalized upstream denials; no upstream text is copied into diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountPolicyDenial {
    AccountDisabled,
    MediaPlaybackDisabled,
}

impl fmt::Display for AccountPolicyDenial {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::AccountDisabled => "upstream_account_disabled",
            Self::MediaPlaybackDisabled => "upstream_media_playback_disabled",
        })
    }
}

/// All failures are inconclusive observations and must fail closed. Errors
/// deliberately retain no URL, account identifier, response body or headers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountPolicyError {
    UnsupportedProvider,
    InvalidConfiguration,
    SourceAccess(AccessError),
    Timeout,
    Unavailable,
    Unauthorized,
    Forbidden,
    UnexpectedStatus,
    BodyTooLarge,
    InvalidResponse,
    UserMismatch,
}

impl fmt::Display for AccountPolicyError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::UnsupportedProvider => "upstream_account_policy_unsupported",
            Self::InvalidConfiguration => "upstream_account_policy_invalid_configuration",
            Self::SourceAccess(_) => "upstream_account_policy_source_access_failed",
            Self::Timeout => "upstream_account_policy_timeout",
            Self::Unavailable => "upstream_account_policy_unavailable",
            Self::Unauthorized => "upstream_account_policy_unauthorized",
            Self::Forbidden => "upstream_account_policy_forbidden",
            Self::UnexpectedStatus => "upstream_account_policy_unexpected_status",
            Self::BodyTooLarge => "upstream_account_policy_body_too_large",
            Self::InvalidResponse => "upstream_account_policy_invalid_response",
            Self::UserMismatch => "upstream_account_policy_user_mismatch",
        })
    }
}

impl std::error::Error for AccountPolicyError {}

pub type Result<T> = std::result::Result<T, AccountPolicyError>;

#[derive(Deserialize)]
struct UserResponse {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "Policy")]
    policy: UserPolicy,
}

#[derive(Deserialize)]
struct UserPolicy {
    // No defaults: omitted, null, duplicate and incorrectly typed policy fields
    // must never manufacture a positive observation.
    #[serde(rename = "IsDisabled")]
    is_disabled: bool,
    #[serde(rename = "EnableMediaPlayback")]
    enable_media_playback: bool,
}

/// Read exactly the configured account using its existing source token. The
/// single deadline includes resolver admission, DNS, connect, headers and body.
/// Dropping this future also drops its response and scoped client: no detached
/// HTTP request or retry is spawned. System DNS retains its existing bounded
/// blocking-worker ownership when the OS lookup itself cannot be cancelled.
pub async fn upstream_account_policy(
    kind: &str,
    config: &SourceConfig,
) -> Result<UpstreamAccountPolicy> {
    account_policy_with_resolver(kind, config, &SystemResolver).await
}

async fn account_policy_with_resolver(
    kind: &str,
    config: &SourceConfig,
    resolver: &impl Resolver,
) -> Result<UpstreamAccountPolicy> {
    let deadline = tokio::time::Instant::now() + ACCOUNT_POLICY_TIMEOUT;
    let result = tokio::time::timeout_at(deadline, async {
        if !matches!(kind, "jellyfin" | "emby") {
            return Err(AccountPolicyError::UnsupportedProvider);
        }
        if config.user_id.is_empty()
            || config.user_id.len() > 512
            || config.user_id.trim() != config.user_id
            || matches!(config.user_id.as_str(), "." | "..")
            || config.user_id.chars().any(char::is_control)
            || config.token.is_empty()
        {
            return Err(AccountPolicyError::InvalidConfiguration);
        }
        let headers = upstream_headers(kind, config, "rainsync-account-policy")
            .map_err(|_| AccountPolicyError::InvalidConfiguration)?;
        validate_source_headers(&headers).map_err(|_| AccountPolicyError::InvalidConfiguration)?;
        let access = SourceAccess::new(&config.url, config.access_policy.as_ref())
            .map_err(AccountPolicyError::SourceAccess)?;
        // Validate the unmodified source URL before any URL normalization.
        let mut url = access
            .authorize_url(&config.url)
            .map_err(AccountPolicyError::SourceAccess)?;
        url.set_query(None);
        url.set_fragment(None);
        url.path_segments_mut()
            .map_err(|_| AccountPolicyError::InvalidConfiguration)?
            .pop_if_empty()
            .extend(["Users", &config.user_id]);
        let client = access
            .client_for_with_resolver(url.as_str(), resolver)
            .await
            .map_err(AccountPolicyError::SourceAccess)?;
        if !client.source_credentials_allowed() {
            return Err(AccountPolicyError::InvalidConfiguration);
        }
        let mut request = client
            .request(Method::GET)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CACHE_CONTROL, "no-cache, no-store")
            .header(reqwest::header::PRAGMA, "no-cache");
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| AccountPolicyError::Unavailable)?;
        match response.status() {
            StatusCode::OK => {}
            StatusCode::UNAUTHORIZED => return Err(AccountPolicyError::Unauthorized),
            StatusCode::FORBIDDEN => return Err(AccountPolicyError::Forbidden),
            _ => return Err(AccountPolicyError::UnexpectedStatus),
        }
        if response
            .content_length()
            .is_some_and(|length| length > ACCOUNT_POLICY_MAX_BYTES as u64)
        {
            return Err(AccountPolicyError::BodyTooLarge);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AccountPolicyError::Unavailable)?
        {
            if chunk.len() > ACCOUNT_POLICY_MAX_BYTES - bytes.len() {
                return Err(AccountPolicyError::BodyTooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        let user: UserResponse =
            serde_json::from_slice(&bytes).map_err(|_| AccountPolicyError::InvalidResponse)?;
        if user.id != config.user_id {
            return Err(AccountPolicyError::UserMismatch);
        }
        if user.policy.is_disabled {
            Ok(UpstreamAccountPolicy::Denied(
                AccountPolicyDenial::AccountDisabled,
            ))
        } else if !user.policy.enable_media_playback {
            Ok(UpstreamAccountPolicy::Denied(
                AccountPolicyDenial::MediaPlaybackDisabled,
            ))
        } else {
            Ok(UpstreamAccountPolicy::Allowed)
        }
    })
    .await;
    // Parsing is synchronous but bounded by the body cap. Never return a late
    // positive result if the deadline elapsed during its last poll.
    if tokio::time::Instant::now() >= deadline {
        return Err(AccountPolicyError::Timeout);
    }
    result.map_err(|_| AccountPolicyError::Timeout)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access_policy::{OriginRule, Resolution, SourceAccessPolicy};
    use serde_json::json;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::oneshot,
        task::JoinHandle,
        time::{Instant, timeout},
    };

    fn config(origin: String) -> SourceConfig {
        SourceConfig {
            access_policy: Some(SourceAccessPolicy {
                schema_version: 1,
                origins: vec![OriginRule {
                    origin: origin.clone(),
                    cidrs: vec!["127.0.0.0/8".into()],
                }],
            }),
            url: format!("{origin}/emby?do_not_forward=private-base-query#fragment"),
            user_id: "configured-account".into(),
            token: "configured-token".into(),
            root: String::new(),
            agent_id: String::new(),
            headers: Default::default(),
        }
    }

    fn policy_body(disabled: bool, playback: bool) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "Id": "configured-account",
            "Policy": {"IsDisabled": disabled, "EnableMediaPlayback": playback},
        }))
        .unwrap()
    }

    fn response(status: u16, body: &[u8]) -> Vec<u8> {
        let mut bytes = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    async fn request_headers(socket: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        loop {
            let mut buffer = [0; 1024];
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0, "client closed before sending headers");
            bytes.extend_from_slice(&buffer[..count]);
            assert!(bytes.len() < 16 * 1024, "test request unexpectedly large");
            if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                return String::from_utf8(bytes).unwrap();
            }
        }
    }

    async fn serve(bytes: Vec<u8>) -> (SourceConfig, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = config(format!("http://{}", listener.local_addr().unwrap()));
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = request_headers(&mut socket).await;
            // Early content-length/status rejection may close the connection.
            let _ = socket.write_all(&bytes).await;
            request
        });
        (config, server)
    }

    #[tokio::test]
    async fn uses_exact_configured_user_base_path_and_existing_provider_credentials() {
        for kind in ["jellyfin", "emby"] {
            let (config, server) = serve(response(200, &policy_body(false, true))).await;
            assert_eq!(
                upstream_account_policy(kind, &config).await,
                Ok(UpstreamAccountPolicy::Allowed)
            );
            let request = server.await.unwrap();
            assert!(request.starts_with("GET /emby/Users/configured-account HTTP/1.1\r\n"));
            let lower = request.to_ascii_lowercase();
            assert!(lower.contains("cache-control: no-cache, no-store\r\n"));
            assert!(!request.contains("private-base-query"));
            assert!(!request.contains("fragment"));
            if kind == "jellyfin" {
                assert!(request.contains("authorization: MediaBrowser "));
                assert!(!lower.contains("x-emby-token:"));
            } else {
                assert!(request.contains("x-emby-authorization: Emby "));
                assert!(request.contains("x-emby-token: configured-token\r\n"));
            }
            assert!(request.contains("Token=\"configured-token\""));
        }
    }

    #[tokio::test]
    async fn explicit_flags_deny_with_normalized_reasons() {
        for (disabled, playback, reason) in [
            (true, true, AccountPolicyDenial::AccountDisabled),
            (true, false, AccountPolicyDenial::AccountDisabled),
            (false, false, AccountPolicyDenial::MediaPlaybackDisabled),
        ] {
            let (config, server) = serve(response(200, &policy_body(disabled, playback))).await;
            assert_eq!(
                upstream_account_policy("emby", &config).await,
                Ok(UpstreamAccountPolicy::Denied(reason))
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn malformed_missing_null_wrong_type_and_duplicate_fields_fail_closed() {
        for body in [
            "not json",
            "{}",
            r#"{"Id":"configured-account"}"#,
            r#"{"Id":"configured-account","Policy":null}"#,
            r#"{"Id":"configured-account","Policy":[]}"#,
            r#"{"Id":"configured-account","Policy":{"IsDisabled":false}}"#,
            r#"{"Id":"configured-account","Policy":{"EnableMediaPlayback":true}}"#,
            r#"{"Id":"configured-account","Policy":{"IsDisabled":null,"EnableMediaPlayback":true}}"#,
            r#"{"Id":"configured-account","Policy":{"IsDisabled":false,"EnableMediaPlayback":"true"}}"#,
            r#"{"Id":"configured-account","Policy":{"IsDisabled":0,"EnableMediaPlayback":true}}"#,
            r#"{"Id":123,"Policy":{"IsDisabled":false,"EnableMediaPlayback":true}}"#,
            r#"{"Id":"configured-account","Policy":{"IsDisabled":false,"EnableMediaPlayback":false,"EnableMediaPlayback":true}}"#,
            r#"{"Id":"different-account","Id":"configured-account","Policy":{"IsDisabled":false,"EnableMediaPlayback":true}}"#,
            r#"{"Id":"configured-account","Policy":{"IsDisabled":false,"EnableMediaPlayback":true}}{}"#,
        ] {
            let (config, server) = serve(response(200, body.as_bytes())).await;
            assert_eq!(
                upstream_account_policy("jellyfin", &config).await,
                Err(AccountPolicyError::InvalidResponse)
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn another_user_and_case_variants_cannot_authorize_configured_account() {
        for id in ["other-account", "CONFIGURED-ACCOUNT", "configured-account "] {
            let body =
                json!({"Id": id, "Policy": {"IsDisabled": false, "EnableMediaPlayback": true}});
            let (config, server) = serve(response(200, body.to_string().as_bytes())).await;
            assert_eq!(
                upstream_account_policy("emby", &config).await,
                Err(AccountPolicyError::UserMismatch)
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn non_200_statuses_fail_closed_without_interpreting_their_body() {
        for (status, expected) in [
            (401, AccountPolicyError::Unauthorized),
            (403, AccountPolicyError::Forbidden),
            (404, AccountPolicyError::UnexpectedStatus),
            (500, AccountPolicyError::UnexpectedStatus),
            (204, AccountPolicyError::UnexpectedStatus),
        ] {
            let (config, server) = serve(response(status, &policy_body(false, true))).await;
            assert_eq!(
                upstream_account_policy("jellyfin", &config).await,
                Err(expected)
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn redirects_are_not_followed_or_given_source_credentials() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bytes = format!(
            "HTTP/1.1 302 Found\r\nLocation: http://{}/Users/configured-account\r\nContent-Length: 0\r\n\r\n",
            target.local_addr().unwrap()
        );
        let (config, server) = serve(bytes.into_bytes()).await;
        assert_eq!(
            upstream_account_policy("emby", &config).await,
            Err(AccountPolicyError::UnexpectedStatus)
        );
        server.await.unwrap();
        assert!(
            timeout(Duration::from_millis(100), target.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn enforces_advertised_and_streamed_body_limits_and_accepts_exact_limit() {
        let mut body = policy_body(false, true);
        body.resize(ACCOUNT_POLICY_MAX_BYTES, b' ');
        let (config, server) = serve(response(200, &body)).await;
        assert_eq!(
            upstream_account_policy("jellyfin", &config).await,
            Ok(UpstreamAccountPolicy::Allowed)
        );
        server.await.unwrap();

        let oversized_header = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            ACCOUNT_POLICY_MAX_BYTES + 1
        );
        let (config, server) = serve(oversized_header.into_bytes()).await;
        assert_eq!(
            upstream_account_policy("emby", &config).await,
            Err(AccountPolicyError::BodyTooLarge)
        );
        server.await.unwrap();

        body.push(b' ');
        let mut chunked = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
            body.len()
        )
        .into_bytes();
        chunked.extend_from_slice(&body);
        chunked.extend_from_slice(b"\r\n0\r\n\r\n");
        let (config, server) = serve(chunked).await;
        assert_eq!(
            upstream_account_policy("jellyfin", &config).await,
            Err(AccountPolicyError::BodyTooLarge)
        );
        server.await.unwrap();
    }

    // The server keeps ownership of the socket until it observes the client's
    // close/reset. Returning verifies cancellation releases the actual socket.
    async fn hang(prefix: &'static [u8]) -> (SourceConfig, oneshot::Receiver<()>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = config(format!("http://{}", listener.local_addr().unwrap()));
        let (ready_tx, ready_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            request_headers(&mut socket).await;
            socket.write_all(prefix).await.unwrap();
            ready_tx.send(()).unwrap();
            let mut byte = [0];
            match socket.read(&mut byte).await {
                Ok(0) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
                    ) => {}
                other => panic!("expected socket closure, got {other:?}"),
            }
        });
        (config, ready_rx, server)
    }

    async fn assert_deadline_closes_socket(prefix: &'static [u8]) {
        let (config, ready, server) = hang(prefix).await;
        let started = Instant::now();
        let reader =
            tokio::spawn(async move { upstream_account_policy("jellyfin", &config).await });
        ready.await.unwrap();
        assert_eq!(reader.await.unwrap(), Err(AccountPolicyError::Timeout));
        assert!(started.elapsed() >= ACCOUNT_POLICY_TIMEOUT);
        assert!(started.elapsed() < ACCOUNT_POLICY_TIMEOUT + Duration::from_secs(1));
        timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn hung_response_headers_use_total_deadline_and_release_socket() {
        assert_deadline_closes_socket(b"").await;
    }

    #[tokio::test]
    async fn hung_response_body_uses_total_deadline_and_releases_socket() {
        assert_deadline_closes_socket(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{").await;
    }

    #[tokio::test]
    async fn caller_cancellation_releases_owned_http_socket_without_detached_request() {
        let (config, ready, server) =
            hang(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{").await;
        let reader = tokio::spawn(async move { upstream_account_policy("emby", &config).await });
        ready.await.unwrap();
        reader.abort();
        assert!(reader.await.unwrap_err().is_cancelled());
        timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }

    struct PendingResolver(Arc<AtomicBool>);

    impl Resolver for PendingResolver {
        fn resolve<'a>(&'a self, _host: &'a str, _port: u16) -> Resolution<'a> {
            struct DropFlag(Arc<AtomicBool>);
            impl Drop for DropFlag {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::SeqCst);
                }
            }
            Box::pin(async move {
                let _owner = DropFlag(self.0.clone());
                std::future::pending().await
            })
        }
    }

    #[tokio::test]
    async fn total_deadline_also_covers_dns_and_drops_its_waiter() {
        let dropped = Arc::new(AtomicBool::new(false));
        let config = config("http://policy.invalid".into());
        let started = Instant::now();
        assert_eq!(
            account_policy_with_resolver("jellyfin", &config, &PendingResolver(dropped.clone()))
                .await,
            Err(AccountPolicyError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn dns_and_body_share_one_deadline_instead_of_resetting_each_phase() {
        struct DelayedResolver(std::net::SocketAddr);
        impl Resolver for DelayedResolver {
            fn resolve<'a>(&'a self, _host: &'a str, _port: u16) -> Resolution<'a> {
                Box::pin(async move {
                    tokio::time::sleep(Duration::from_millis(1200)).await;
                    Ok(vec![self.0])
                })
            }
        }

        let (mut config, ready, server) =
            hang(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{").await;
        let url = reqwest::Url::parse(&config.url).unwrap();
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], url.port().unwrap()));
        let origin = format!("http://policy.invalid:{}", address.port());
        config.url = format!("{origin}/emby");
        config.access_policy.as_mut().unwrap().origins[0].origin = origin;

        let started = Instant::now();
        assert_eq!(
            account_policy_with_resolver("emby", &config, &DelayedResolver(address)).await,
            Err(AccountPolicyError::Timeout)
        );
        assert!(started.elapsed() >= ACCOUNT_POLICY_TIMEOUT);
        assert!(started.elapsed() < Duration::from_millis(2800));
        ready.await.unwrap();
        timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn source_cidr_policy_cannot_be_bypassed_by_account_read() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = config(format!("http://{}", listener.local_addr().unwrap()));
        config.access_policy.as_mut().unwrap().origins[0].cidrs = vec!["192.0.2.0/24".into()];
        assert_eq!(
            upstream_account_policy("emby", &config).await,
            Err(AccountPolicyError::SourceAccess(AccessError::AddressDenied))
        );
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn invalid_configuration_fails_before_contacting_server() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let baseline = config(format!("http://{}", listener.local_addr().unwrap()));
        assert_eq!(
            upstream_account_policy("http", &baseline).await,
            Err(AccountPolicyError::UnsupportedProvider)
        );
        for id in ["", " ", ".", "..", " leading", "trailing ", "line\nbreak"] {
            let mut config = baseline.clone();
            config.user_id = id.into();
            assert_eq!(
                upstream_account_policy("emby", &config).await,
                Err(AccountPolicyError::InvalidConfiguration)
            );
        }
        for token in ["", "injected\r\nheader"] {
            let mut config = baseline.clone();
            config.token = token.into();
            assert_eq!(
                upstream_account_policy("jellyfin", &config).await,
                Err(AccountPolicyError::InvalidConfiguration)
            );
        }
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn public_errors_do_not_retain_upstream_body_url_headers_or_credentials() {
        let private = "private upstream URL http://secret.invalid?token=private-body-token";
        let (config, server) = serve(response(500, private.as_bytes())).await;
        let error = upstream_account_policy("emby", &config).await.unwrap_err();
        let diagnostic = format!("{error}: {error:?}");
        for value in [&config.url, &config.token, &config.user_id, private] {
            assert!(!diagnostic.contains(value));
        }
        assert_eq!(
            diagnostic,
            "upstream_account_policy_unexpected_status: UnexpectedStatus"
        );
        server.await.unwrap();
    }
}
