//! Viewer-owned platform account vault and exact-login-bound Bilibili QR login.
//! Douyin/TikTok browser sessions are imported with consent and remain unverified.
//!
//! No provider credential is placed in a SourceConfig, a room event, a public
//! account DTO, a playback descriptor or a global HTTP client. Provider calls
//! run without a database transaction, and publication reacquires authority.
use crate::*;
use providers::platform::bilibili::auth::LoginValidity;
use providers::platform::bilibili::{Client, Cookie as BiliCookie};
use providers::platform::short_video::{Credential as ShortCredential, Platform as ShortPlatform};
use sqlx::{Postgres, Transaction, postgres::PgRow};
use tokio::time::{Duration, Instant as Deadline};

mod account_operations;
pub mod exchanges;
pub mod maintenance;
pub mod oauth;
mod playback;
mod qr_login;
pub mod renewal;
mod scope;
mod short;
pub(crate) use playback::{FrozenAccount, guard_for_publish};
pub use short::ImportCredential;
mod youtube;
use scope::{AccountScope, QrScope};
pub use youtube::ImportYoutubeCredential;

const PROVIDER: &str = scope::PROVIDER;
const QR_KEY_PURPOSE: &str = "platform_qr_poll_key_v1";
const QR_PAYLOAD_PURPOSE: &str = "platform_qr_payload_v1";
const QR_LIFETIME_SECONDS: i32 = 180;
const OPERATION_LEASE_SECONDS: i32 = 45;
const POLL_INTERVAL_SECONDS: i32 = 3;
const HTTP_SECONDS: u64 = 20;

fn account_provider(provider: &str) -> Result<&'static str> {
    match provider {
        "bilibili" => Ok(PROVIDER),
        "douyin" => Ok("douyin"),
        "tiktok" => Ok("tiktok"),
        "youtube" => Ok("youtube"),
        _ => Err(err(StatusCode::BAD_REQUEST, "native_platform_invalid")),
    }
}

fn short_provider(provider: &str) -> Result<ShortPlatform> {
    match provider {
        "douyin" => Ok(ShortPlatform::Douyin),
        "tiktok" => Ok(ShortPlatform::TikTok),
        _ => Err(err(StatusCode::BAD_REQUEST, "native_platform_invalid")),
    }
}

const ACCOUNT_SELECT: &str = "SELECT id,user_id,revision,state,credential_encrypted, \
    floor(extract(epoch FROM credential_expires_at)*1000)::bigint AS credential_expires_at_ms, \
    state='connected' AND (credential_expires_at IS NULL OR credential_expires_at>clock_timestamp()) AS credential_live \
    FROM platform_accounts WHERE user_id=$1 AND provider='bilibili'";

const PROVIDER_ACCOUNT_SELECT: &str = "SELECT id,user_id,revision,state,credential_encrypted, \
    floor(extract(epoch FROM credential_expires_at)*1000)::bigint AS credential_expires_at_ms, \
    state='connected' AND (credential_expires_at IS NULL OR credential_expires_at>clock_timestamp()) AS credential_live \
    FROM platform_accounts WHERE user_id=$1 AND provider=$2";

fn account_scope(row: &PgRow) -> AccountScope {
    AccountScope {
        user_id: row.get("user_id"),
        account_id: row.get("id"),
        revision: row.get("revision"),
    }
}

fn cookie_value(cookie: &BiliCookie) -> Value {
    let values = cookie
        .expose_for_storage()
        .split(';')
        .map(|pair| {
            let (name, value) = pair
                .trim()
                .split_once('=')
                .expect("validated provider Cookie");
            (name.to_owned(), Value::String(value.to_owned()))
        })
        .collect::<serde_json::Map<String, Value>>();
    Value::Object(values)
}

fn cookie_from_value(value: Value) -> Result<BiliCookie> {
    let values = value
        .as_object()
        .filter(|values| (2..=4).contains(&values.len()))
        .ok_or_else(credential_error)?;
    let mut pairs = Vec::with_capacity(values.len());
    for (name, value) in values {
        if !matches!(
            name.as_str(),
            "SESSDATA" | "bili_jct" | "DedeUserID" | "DedeUserID__ckMd5"
        ) {
            return Err(credential_error());
        }
        let secret = value.as_str().ok_or_else(credential_error)?;
        pairs.push(format!("{name}={secret}"));
    }
    BiliCookie::from_header(&pairs.join("; ")).map_err(|_| credential_error())
}

fn credential_error() -> Error {
    err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "platform_credential_invalid",
    )
}

/// Compatibility adapter for account selection at existing call sites.
pub(crate) async fn load_for_playback(app: &App, viewer_id: Uuid) -> Result<FrozenAccount> {
    load_for_provider_playback(app, viewer_id, PROVIDER).await
}

pub(crate) async fn load_for_provider_playback(
    app: &App,
    viewer_id: Uuid,
    provider: &str,
) -> Result<FrozenAccount> {
    let decrypt = |value: &str| app.decrypt(value);
    playback::load(
        playback::Context {
            db: &app.db,
            decrypt: &decrypt,
        },
        viewer_id,
        provider,
    )
    .await
}

fn login_hash(headers: &HeaderMap) -> Result<String> {
    cookie(headers)
        .map(|value| hash(&value))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))
}

/// Locks are always current principal/login, then account, then QR request.
/// clock_timestamp() is re-evaluated after waiting for each authority lock.
async fn guard_login(tx: &mut Transaction<'_, Postgres>, user: Uuid, login: &str) -> Result<()> {
    let principal: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE id=$1 FOR KEY SHARE")
            .bind(user)
            .fetch_optional(&mut **tx)
            .await?;
    if principal.is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    let session: Option<String> = sqlx::query_scalar(
        "SELECT token_hash FROM sessions WHERE user_id=$1 AND token_hash=$2 FOR SHARE",
    )
    .bind(user)
    .bind(login)
    .fetch_optional(&mut **tx)
    .await?;
    if session.is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    guard_login_live(tx, user, login).await
}

async fn guard_login_live(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    login: &str,
) -> Result<()> {
    let live: bool = sqlx::query_scalar("SELECT playback_login_allowed($1,$2)")
        .bind(user)
        .bind(login)
        .fetch_one(&mut **tx)
        .await?;
    if !live {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    Ok(())
}

async fn lock_account(tx: &mut Transaction<'_, Postgres>, user: Uuid) -> Result<PgRow> {
    Ok(lock_provider_account(tx, user, PROVIDER).await?.0)
}

/// Returns whether this transaction created the initial account tombstone.
/// Null expected_revision matches only that insertion, never an existing row.
async fn lock_provider_account(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    provider: &'static str,
) -> Result<(PgRow, bool)> {
    let inserted: Option<Uuid> = sqlx::query_scalar("INSERT INTO platform_accounts(id,user_id,provider,state) VALUES($1,$2,$3,'revoked') ON CONFLICT(user_id,provider) DO NOTHING RETURNING id")
        .bind(Uuid::new_v4()).bind(user).bind(provider).fetch_optional(&mut **tx).await?;
    sqlx::query("SELECT id FROM platform_accounts WHERE user_id=$1 AND provider=$2 FOR UPDATE")
        .bind(user)
        .bind(provider)
        .fetch_one(&mut **tx)
        .await?;
    let mut row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(user)
        .bind(provider)
        .fetch_one(&mut **tx)
        .await?;
    // Expiration is a credential change; never retain an expired secret.
    if row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live") {
        sqlx::query("UPDATE platform_accounts SET state='expired',credential_encrypted=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1")
            .bind(row.get::<Uuid, _>("id")).execute(&mut **tx).await?;
        if provider == PROVIDER {
            fail_pending(tx, user).await?;
        }
        row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
            .bind(user)
            .bind(provider)
            .fetch_one(&mut **tx)
            .await?;
    }
    Ok((row, inserted.is_some()))
}

async fn fail_pending(tx: &mut Transaction<'_, Postgres>, user: Uuid) -> Result<()> {
    sqlx::query("UPDATE platform_login_requests SET status='failed',qr_key_encrypted=NULL,qr_payload_encrypted=NULL,operation_nonce=NULL,operation_expires_at=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND provider='bilibili' AND status='pending'")
        .bind(user).execute(&mut **tx).await?;
    Ok(())
}

/// Public account representation includes no secrets or upstream identifiers.
fn status_value(row: Option<&PgRow>) -> Value {
    match row {
        Some(row) => json!({"id": row.get::<Uuid, _>("id"), "provider": PROVIDER,
            "revision": row.get::<i64, _>("revision").to_string(), "state": row.get::<String, _>("state")}),
        None => json!({"id": null, "provider": PROVIDER, "revision": null, "state": "revoked"}),
    }
}

pub async fn status(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let value = account_operations::status(app.identity_context(), headers).await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckLogin {
    // A required null means no account was observed, not an unconditional check.
    expected_revision: Value,
}

/// Check only this viewer's current credential. The upstream call never holds
/// a transaction. Publication rechecks the exact login and credential revision.
/// Inconclusive provider errors preserve the saved session; only explicit logout
/// or a different upstream identity clears it and invalidates historical grants.
pub async fn check_login(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<CheckLogin>,
) -> Result<Response> {
    let key = app.key.as_ref();
    let decrypt = |value: &str| crate::decrypt_value(key, value);
    let value = account_operations::check_login(
        app.identity_context(),
        app.platform_http,
        &decrypt,
        headers,
        body,
    )
    .await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartLogin {
    idempotency_key: Uuid,
    consent_to_store: bool,
    #[serde(default)]
    consent_to_renew: bool,
}

struct LoginRequest {
    scope: QrScope,
    status: String,
    qr_key_encrypted: Option<String>,
    qr_payload_encrypted: Option<String>,
    expires_at_ms: i64,
    next_poll_at_ms: i64,
    server_time_ms: i64,
    live: bool,
    operation_live: bool,
    operation_nonce: Option<Uuid>,
    ready_to_poll: bool,
    consent_to_renew: bool,
}

const REQUEST_SELECT: &str = "SELECT id,user_id,auth_login_hash,account_id,account_revision,status,qr_key_encrypted,qr_payload_encrypted,operation_nonce,consent_to_renew, \
    floor(extract(epoch FROM expires_at)*1000)::bigint AS expires_at_ms, \
    floor(extract(epoch FROM next_poll_at)*1000)::bigint AS next_poll_at_ms, \
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS server_time_ms, \
    expires_at>clock_timestamp() AS live, \
    COALESCE(operation_expires_at>clock_timestamp(),false) AS operation_live, \
    next_poll_at<=clock_timestamp() AS ready_to_poll \
    FROM platform_login_requests WHERE id=$1";

fn request_from_row(row: PgRow, user: Uuid, login: &str) -> Result<LoginRequest> {
    if row.get::<Uuid, _>("user_id") != user || row.get::<String, _>("auth_login_hash") != login {
        return Err(err(StatusCode::CONFLICT, "platform_login_request_conflict"));
    }
    Ok(LoginRequest {
        scope: QrScope {
            account: AccountScope {
                user_id: user,
                account_id: row.get("account_id"),
                revision: row.get("account_revision"),
            },
            request_id: row.get("id"),
            login_hash: login.to_owned(),
        },
        status: row.get("status"),
        qr_key_encrypted: row.get("qr_key_encrypted"),
        qr_payload_encrypted: row.get("qr_payload_encrypted"),
        expires_at_ms: row.get("expires_at_ms"),
        next_poll_at_ms: row.get("next_poll_at_ms"),
        server_time_ms: row.get("server_time_ms"),
        live: row.get("live"),
        operation_live: row.get("operation_live"),
        operation_nonce: row.get("operation_nonce"),
        ready_to_poll: row.get("ready_to_poll"),
        consent_to_renew: row.get("consent_to_renew"),
    })
}

async fn lock_request(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    user: Uuid,
    login: &str,
) -> Result<LoginRequest> {
    sqlx::query("SELECT id FROM platform_login_requests WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "platform_login_request_not_found"))?;
    let row = sqlx::query(REQUEST_SELECT)
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    guard_login_live(tx, user, login).await?;
    request_from_row(row, user, login)
}

fn can_complete(request: &LoginRequest, nonce: Uuid, account: AccountScope) -> bool {
    request.status == "pending"
        && request.live
        && request.operation_live
        && request.operation_nonce == Some(nonce)
        && request.scope.account == account
}

async fn terminalize(tx: &mut Transaction<'_, Postgres>, id: Uuid, status: &str) -> Result<()> {
    sqlx::query("UPDATE platform_login_requests SET status=$2,qr_key_encrypted=NULL,qr_payload_encrypted=NULL,operation_nonce=NULL,operation_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='pending'")
        .bind(id).bind(status).execute(&mut **tx).await?;
    Ok(())
}

fn upstream_failure_class(error: &providers::platform::bilibili::Error) -> &'static str {
    use providers::platform::bilibili::Error as Upstream;
    // A closed, low-cardinality vocabulary, not upstream text or a secret URL.
    match error {
        Upstream::InvalidResponse("qr_url") | Upstream::InvalidQrUrl(_) => "qr_url_invalid",
        Upstream::InvalidResponse("qr_key") => "qr_key_invalid",
        Upstream::InvalidResponse("qr_binding") => "qr_binding_invalid",
        Upstream::InvalidResponse("qr_state") => "qr_state_invalid",
        Upstream::InvalidResponse(
            "set_cookie" | "cookie_origin" | "cookie_path" | "cookie" | "cookie_identity",
        ) => "qr_cookie_invalid",
        Upstream::InvalidResponse(_) | Upstream::InvalidResource => "response_schema_invalid",
        Upstream::InvalidJson => "response_json_invalid",
        Upstream::Restricted(_) => "transport_policy_rejected",
        Upstream::Api(_) => "provider_api_rejected",
        Upstream::Status(_) => "provider_http_rejected",
        Upstream::Deadline => "deadline_exceeded",
        Upstream::Transport => "transport_failed",
        Upstream::TooLarge => "response_limit_exceeded",
    }
}

fn upstream_error(operation: &'static str, error: providers::platform::bilibili::Error) -> Error {
    if let providers::platform::bilibili::Error::InvalidQrUrl(shape) = &error {
        tracing::warn!(
            event = "platform_login_upstream_failed",
            provider = PROVIDER,
            operation,
            failure_class = upstream_failure_class(&error),
            qr_url_scheme = ?shape.scheme,
            qr_url_host = ?shape.host,
            qr_url_path = ?shape.path,
            qr_url_has_port = shape.has_port,
            qr_url_has_credentials = shape.has_credentials,
            qr_url_has_fragment = shape.has_fragment,
        );
    } else {
        tracing::warn!(
            event = "platform_login_upstream_failed",
            provider = PROVIDER,
            operation,
            failure_class = upstream_failure_class(&error),
        );
    }
    // Never format provider errors, body, URL, Cookie or key into public errors.
    err(StatusCode::BAD_GATEWAY, "platform_login_upstream_failed")
}

fn deadline(request: &LoginRequest) -> Result<Deadline> {
    let remaining_ms = request.expires_at_ms.saturating_sub(request.server_time_ms);
    if remaining_ms <= 0 {
        return Err(err(StatusCode::GONE, "platform_login_expired"));
    }
    Ok(Deadline::now() + Duration::from_millis((remaining_ms as u64).min(HTTP_SECONDS * 1000)))
}

pub async fn start_login(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<StartLogin>,
) -> Result<Response> {
    let key = app.key.as_ref();
    let decrypt = |value: &str| crate::decrypt_value(key, value);
    let encrypt = |value: &Value| crate::encrypt_value(key, value);
    let outcome = qr_login::start_login(
        app.identity_context(),
        &app.platform_http,
        &decrypt,
        &encrypt,
        headers,
        body,
    )
    .await?;
    let (status, value) = match outcome {
        qr_login::StartLoginOutcome::Replay(value) => (StatusCode::OK, value),
        qr_login::StartLoginOutcome::Created(value) => (StatusCode::CREATED, value),
    };
    Ok(responses::private_json(status, value))
}

pub async fn poll_login(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response> {
    let key = app.key.as_ref();
    let decrypt = |value: &str| crate::decrypt_value(key, value);
    let encrypt = |value: &Value| crate::encrypt_value(key, value);
    let value = qr_login::poll_login(
        app.identity_context(),
        &app.platform_http,
        &decrypt,
        &encrypt,
        id,
        headers,
    )
    .await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

pub async fn cancel_login(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response> {
    let value = qr_login::cancel_login(app.identity_context(), id, headers).await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

pub async fn unlink(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let value = account_operations::unlink(app.identity_context(), headers).await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

// Only locally imported web sessions are supported for these providers. Official
// OAuth/QR APIs require an approved application and do not provide web cookies.
// No provider request, account verification, or secret is returned by this API.
pub async fn short_status(
    State(app): State<App>,
    Path(provider): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let value = short::status(app.identity_context(), provider, headers).await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnlinkCredential {
    expected_revision: Value,
}

fn expected_revision(value: &Value) -> Result<Option<i64>> {
    if value.is_null() {
        return Ok(None);
    }
    let parsed = value
        .as_str()
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|revision| *revision > 0)
        .filter(|revision| value.as_str() == Some(revision.to_string().as_str()))
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_request"))?;
    Ok(Some(parsed))
}

fn revision_matches(expected: Option<i64>, current: i64, inserted: bool) -> bool {
    match expected {
        None => inserted,
        Some(revision) => !inserted && revision == current,
    }
}

pub async fn import_short_credential(
    State(app): State<App>,
    Path(provider): Path<String>,
    headers: HeaderMap,
    Json(body): Json<ImportCredential>,
) -> Result<Response> {
    let value = short::import(app.identity_context(), &app.key, provider, headers, body).await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

pub async fn unlink_short(
    State(app): State<App>,
    Path(provider): Path<String>,
    headers: HeaderMap,
    Json(body): Json<UnlinkCredential>,
) -> Result<Response> {
    let value = short::unlink(app.identity_context(), provider, headers, body).await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

pub async fn youtube_status(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let value = youtube::status(
        app.identity_context(),
        app.youtube.viewer_credentials_enabled(),
        headers,
    )
    .await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

pub async fn import_youtube_credential(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<ImportYoutubeCredential>,
) -> Result<Response> {
    let key = app.key.as_ref();
    let encrypt = |value: &Value| crate::encrypt_value(key, value);
    let value = youtube::import(
        app.identity_context(),
        app.youtube.viewer_credentials_enabled(),
        &encrypt,
        headers,
        body,
    )
    .await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

pub async fn unlink_youtube(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<UnlinkCredential>,
) -> Result<Response> {
    let value = youtube::unlink(
        app.identity_context(),
        app.youtube.viewer_credentials_enabled(),
        headers,
        body,
    )
    .await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

#[cfg(test)]
mod tests {
    use super::account_operations::{check_revision_matches, check_snapshot_matches, check_value};
    use super::*;

    #[test]
    fn validity_checks_require_observed_revision_and_reacquire_live_exact_scope() {
        let scope = AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: 3,
        };
        assert!(check_revision_matches(None, None));
        assert!(check_revision_matches(Some(3), Some(scope)));
        assert!(!check_revision_matches(None, Some(scope)));
        assert!(!check_revision_matches(Some(2), Some(scope)));
        assert!(!check_revision_matches(Some(3), None));
        assert!(check_snapshot_matches(scope, None, Some(scope), true, None));
        assert!(!check_snapshot_matches(scope, None, None, true, None));
        assert!(!check_snapshot_matches(
            scope,
            None,
            Some(scope),
            false,
            None
        ));
        assert!(!check_snapshot_matches(
            scope,
            None,
            Some(scope),
            true,
            Some(100)
        ));
        for changed in [
            AccountScope {
                user_id: Uuid::from_u128(4),
                ..scope
            },
            AccountScope {
                account_id: Uuid::from_u128(4),
                ..scope
            },
            AccountScope {
                revision: 4,
                ..scope
            },
        ] {
            assert!(!check_snapshot_matches(
                scope,
                None,
                Some(changed),
                true,
                None
            ));
        }
    }

    #[test]
    fn check_ingress_and_response_never_accept_or_expose_secrets() {
        assert!(serde_json::from_value::<CheckLogin>(json!({"expected_revision":null})).is_ok());
        assert!(serde_json::from_value::<CheckLogin>(json!({})).is_err());
        assert!(
            serde_json::from_value::<CheckLogin>(
                json!({"expected_revision":"3","cookie":"synthetic"})
            )
            .is_err()
        );
        let value = check_value(status_value(None), "none", None);
        assert_eq!(value.as_object().unwrap().len(), 4);
        assert_eq!(value["renew_method"], "qr_login");
        assert_eq!(value["verification"], "none");
        assert!(value["checked_at"].is_null());
    }

    fn pending_request(nonce: Uuid) -> LoginRequest {
        LoginRequest {
            scope: QrScope {
                account: AccountScope {
                    user_id: Uuid::from_u128(1),
                    account_id: Uuid::from_u128(2),
                    revision: 1,
                },
                request_id: Uuid::from_u128(3),
                login_hash: "a".repeat(64),
            },
            status: "pending".into(),
            qr_key_encrypted: None,
            qr_payload_encrypted: None,
            expires_at_ms: 180000,
            next_poll_at_ms: 3000,
            server_time_ms: 1000,
            live: true,
            operation_live: true,
            operation_nonce: Some(nonce),
            ready_to_poll: false,
            consent_to_renew: false,
        }
    }

    #[test]
    fn qr_upstream_diagnostics_are_closed_and_never_include_provider_values() {
        use providers::platform::bilibili::Error as Upstream;
        use providers::platform::bilibili::{QrUrlHost, QrUrlPath, QrUrlRejection, QrUrlScheme};
        for (error, expected) in [
            (Upstream::InvalidResponse("qr_url"), "qr_url_invalid"),
            (
                Upstream::InvalidQrUrl(QrUrlRejection {
                    scheme: QrUrlScheme::Https,
                    host: QrUrlHost::Passport,
                    path: QrUrlPath::Other,
                    has_port: false,
                    has_credentials: false,
                    has_fragment: false,
                }),
                "qr_url_invalid",
            ),
            (
                Upstream::InvalidResponse("qr_binding"),
                "qr_binding_invalid",
            ),
            (Upstream::InvalidResponse("qr_key"), "qr_key_invalid"),
            (Upstream::InvalidResponse("qr_state"), "qr_state_invalid"),
            (
                Upstream::InvalidResponse("cookie_origin"),
                "qr_cookie_invalid",
            ),
            (
                Upstream::InvalidResponse("synthetic-private-value"),
                "response_schema_invalid",
            ),
            (
                Upstream::Restricted("synthetic-private-value"),
                "transport_policy_rejected",
            ),
            (Upstream::Api(-352), "provider_api_rejected"),
            (Upstream::Status(403), "provider_http_rejected"),
            (Upstream::InvalidJson, "response_json_invalid"),
            (Upstream::Deadline, "deadline_exceeded"),
            (Upstream::Transport, "transport_failed"),
            (Upstream::TooLarge, "response_limit_exceeded"),
        ] {
            let class = upstream_failure_class(&error);
            assert_eq!(class, expected);
            assert!(!class.contains("synthetic"));
            assert!(!class.contains("-352"));
            assert!(!class.contains("403"));
        }
    }

    #[test]
    fn late_qr_success_is_fenced_by_cancel_expiry_claim_and_account_revision() {
        let nonce = Uuid::from_u128(4);
        let mut request = pending_request(nonce);
        let account = request.scope.account;
        assert!(can_complete(&request, nonce, account));
        request.status = "failed".into();
        assert!(!can_complete(&request, nonce, account));
        request.status = "pending".into();
        request.live = false;
        assert!(!can_complete(&request, nonce, account));
        request.live = true;
        request.operation_live = false;
        assert!(!can_complete(&request, nonce, account));
        request.operation_live = true;
        assert!(!can_complete(&request, Uuid::from_u128(5), account));
        assert!(!can_complete(
            &request,
            nonce,
            AccountScope {
                revision: 2,
                ..account
            }
        ));
        assert!(!can_complete(
            &request,
            nonce,
            AccountScope {
                user_id: Uuid::from_u128(6),
                ..account
            }
        ));
        assert!(!can_complete(
            &request,
            nonce,
            AccountScope {
                account_id: Uuid::from_u128(7),
                ..account
            }
        ));
    }

    #[test]
    fn vault_cookie_roundtrip_has_only_expected_allowlisted_names() {
        let cookie =
            BiliCookie::from_header("SESSDATA=fixture-only; DedeUserID=1; bili_jct=fixture-csrf")
                .unwrap();
        let restored = cookie_from_value(cookie_value(&cookie)).unwrap();
        assert_eq!(restored.expose_for_storage(), cookie.expose_for_storage());
        assert!(
            cookie_from_value(
                json!({"SESSDATA":"fixture-only", "DedeUserID":"1", "other":"secret"})
            )
            .is_err()
        );
        assert!(cookie_from_value(json!({"SESSDATA":"fixture-only", "DedeUserID":1})).is_err());
        assert!(cookie_from_value(json!("SESSDATA=fixture-only; DedeUserID=1")).is_err());
    }

    #[test]
    fn credential_binding_is_canonical_and_invalidation_changes_revision() {
        let original = AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: 1,
        };
        let cookies = json!({"SESSDATA":"fixture-only", "DedeUserID":"1"});
        let value = scope::credential_plaintext(original, cookies.clone());
        assert_eq!(
            scope::credential_cookies(original, value.clone()),
            Some(cookies)
        );
        let replaced = AccountScope {
            revision: 2,
            ..original
        };
        assert!(scope::credential_cookies(replaced, value).is_none());
    }

    #[test]
    fn anonymous_public_bindings_never_expose_account_context() {
        let frozen = FrozenAccount::anonymous(Uuid::from_u128(1));
        assert!(frozen.account_id().is_none());
        assert!(frozen.revision().is_none());
        assert!(frozen.credential_expires_at_ms().is_none());
        assert!(frozen.cookie().is_none());
        let status = status_value(None);
        assert_eq!(status.as_object().unwrap().len(), 4);
        for forbidden in [
            "cookies",
            "credential",
            "credential_encrypted",
            "auth_login_hash",
            "qr_key",
        ] {
            assert!(!status.as_object().unwrap().contains_key(forbidden));
        }
    }

    #[test]
    fn short_account_status_discloses_import_and_no_verification_without_secrets() {
        for provider in [ShortPlatform::Douyin, ShortPlatform::TikTok] {
            let value = short::short_status_value(provider, None);
            assert_eq!(value["provider"], provider.id());
            assert_eq!(value["state"], "revoked");
            assert_eq!(value["login_method"], "cookie_import");
            assert_eq!(value["qr_available"], false);
            assert_eq!(value["verification"], "none");
            assert!(value["revision"].is_null());
            assert!(value["credential_expires_at"].is_null());
            assert_eq!(value.as_object().unwrap().len(), 8);
            for forbidden in [
                "cookie",
                "cookies",
                "credential",
                "credential_encrypted",
                "user_id",
                "auth_login_hash",
            ] {
                assert!(!value.as_object().unwrap().contains_key(forbidden));
            }
        }
    }

    #[test]
    fn short_import_requires_explicit_consent_and_revision_field() {
        let valid = json!({"cookie":"sessionid=fixture-only", "consent_to_store":true, "expected_revision":null});
        assert!(serde_json::from_value::<ImportCredential>(valid.clone()).is_ok());
        for field in ["cookie", "consent_to_store", "expected_revision"] {
            let mut changed = valid.clone();
            changed.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<ImportCredential>(changed).is_err());
        }
        let mut changed = valid;
        changed["provider"] = json!("tiktok");
        assert!(serde_json::from_value::<ImportCredential>(changed).is_err());
        assert!(serde_json::from_value::<UnlinkCredential>(json!({})).is_err());
        assert!(
            serde_json::from_value::<UnlinkCredential>(json!({"expected_revision":null})).is_ok()
        );
        assert!(
            serde_json::from_value::<UnlinkCredential>(
                json!({"expected_revision":"2", "cookie":"secret"})
            )
            .is_err()
        );
    }

    #[test]
    fn import_and_unlink_revision_fences_reject_reordered_stale_and_noncanonical_values() {
        assert_eq!(expected_revision(&Value::Null).unwrap(), None);
        assert_eq!(expected_revision(&json!("2")).unwrap(), Some(2));
        assert_eq!(
            expected_revision(&json!(i64::MAX.to_string())).unwrap(),
            Some(i64::MAX)
        );
        for invalid in [
            json!(2),
            json!("02"),
            json!("+2"),
            json!(" 2"),
            json!("0"),
            json!("-2"),
            json!("9223372036854775808"),
            json!(true),
            json!({}),
        ] {
            assert!(expected_revision(&invalid).is_err());
        }
        assert!(revision_matches(None, 1, true));
        assert!(!revision_matches(None, 1, false));
        assert!(!revision_matches(Some(1), 1, true));
        assert!(revision_matches(Some(2), 2, false));
        // An unlink/replacement advances revision. Late retries cannot relink it.
        assert!(!revision_matches(Some(2), 3, false));
        assert!(!revision_matches(None, 3, false));
    }

    #[test]
    fn start_requires_explicit_consent_and_rejects_unknown_fields() {
        assert!(
            serde_json::from_value::<StartLogin>(json!({"idempotency_key":Uuid::from_u128(1)}))
                .is_err()
        );
        assert!(serde_json::from_value::<StartLogin>(json!({"idempotency_key":Uuid::from_u128(1),"consent_to_store":true,"cookie":"secret"})).is_err());
        assert!(
            serde_json::from_value::<StartLogin>(
                json!({"idempotency_key":Uuid::from_u128(1),"consent_to_store":true})
            )
            .is_ok()
        );
    }
}
