//! Viewer-owned platform account vault and exact-login-bound Bilibili QR login.
//! Douyin/TikTok browser sessions are imported with consent and remain unverified.
//!
//! No provider credential is placed in a SourceConfig, a room event, a public
//! account DTO, a playback descriptor or a global HTTP client. Provider calls
//! run without a database transaction, and publication reacquires authority.
use crate::*;
use providers::platform::bilibili::auth::LoginValidity;
use providers::platform::bilibili::{Client, Cookie as BiliCookie, QrKey, QrState};
use providers::platform::short_video::{Credential as ShortCredential, Platform as ShortPlatform};
use sqlx::{Postgres, Transaction, postgres::PgRow};
use tokio::time::{Duration, Instant as Deadline};

pub mod exchanges;
pub mod maintenance;
pub mod oauth;
pub mod renewal;
mod scope;
mod youtube;
use scope::{AccountScope, QrScope};
pub use youtube::{import_youtube_credential, unlink_youtube, youtube_status};

const PROVIDER: &str = scope::PROVIDER;
const QR_KEY_PURPOSE: &str = "platform_qr_poll_key_v1";
const QR_PAYLOAD_PURPOSE: &str = "platform_qr_payload_v1";
const QR_LIFETIME_SECONDS: i32 = 180;
const OPERATION_LEASE_SECONDS: i32 = 45;
const POLL_INTERVAL_SECONDS: i32 = 3;
const HTTP_SECONDS: u64 = 20;

/// Not serializable or printable: the Cookie is an opaque server-only value.
pub(crate) struct FrozenAccount {
    viewer_id: Uuid,
    provider: &'static str,
    observed: Option<AccountScope>,
    credential_expires_at_ms: Option<i64>,
    cookie: Option<BiliCookie>,
    short_cookie: Option<ShortCredential>,
    youtube_cookie: Option<providers::platform::youtube::Credential>,
    explicit_anonymous: bool,
}

impl FrozenAccount {
    pub(crate) fn provider_name(&self) -> &'static str {
        self.provider
    }
    /// Explicit anonymous intent has no dependency on any account credential.
    pub(crate) fn anonymous(viewer_id: Uuid) -> Self {
        Self::anonymous_scoped(viewer_id, PROVIDER)
    }
    pub(crate) fn anonymous_for_provider(viewer_id: Uuid, provider: &str) -> Result<Self> {
        Ok(Self::anonymous_scoped(
            viewer_id,
            if provider == "youtube" {
                "youtube"
            } else {
                account_provider(provider)?
            },
        ))
    }
    fn anonymous_scoped(viewer_id: Uuid, provider: &'static str) -> Self {
        Self {
            viewer_id,
            provider,
            observed: None,
            credential_expires_at_ms: None,
            cookie: None,
            short_cookie: None,
            youtube_cookie: None,
            explicit_anonymous: true,
        }
    }
    fn has_credential(&self) -> bool {
        self.cookie.is_some() || self.short_cookie.is_some() || self.youtube_cookie.is_some()
    }
    pub(crate) fn account_id(&self) -> Option<Uuid> {
        self.has_credential()
            .then_some(self.observed)
            .flatten()
            .map(|scope| scope.account_id)
    }
    pub(crate) fn revision(&self) -> Option<i64> {
        self.has_credential()
            .then_some(self.observed)
            .flatten()
            .map(|scope| scope.revision)
    }
    pub(crate) fn credential_expires_at_ms(&self) -> Option<i64> {
        self.has_credential()
            .then_some(self.credential_expires_at_ms)
            .flatten()
    }
    pub(crate) fn cookie(&self) -> Option<&BiliCookie> {
        self.cookie.as_ref()
    }
    pub(crate) fn short_cookie(&self) -> Option<&ShortCredential> {
        self.short_cookie.as_ref()
    }
    pub(crate) fn youtube_cookie(&self) -> Option<&providers::platform::youtube::Credential> {
        self.youtube_cookie.as_ref()
    }
    /// Non-secret exact snapshot for explicitly paged collection discovery.
    /// Include an observed disconnected account too: replacing such a row must
    /// not silently change an own-or-anonymous continuation's account basis.
    pub(crate) fn continuation_fingerprint(&self) -> String {
        hash(
            &json!({
                "purpose":"platform_collection_account_v1",
                "viewer":self.viewer_id,
                "provider":self.provider,
                "observed":self.observed.map(|scope| json!({
                    "id":scope.account_id,"revision":scope.revision
                })),
                "has_credential":self.has_credential(),
                "expires":self.credential_expires_at_ms,
                "explicit_anonymous":self.explicit_anonymous,
            })
            .to_string(),
        )
    }
}

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

pub(crate) async fn load_for_playback(app: &App, viewer_id: Uuid) -> Result<FrozenAccount> {
    load_for_provider_playback(app, viewer_id, PROVIDER).await
}

/// Credentials belong only to the viewing principal and the requested provider.
/// Imported short-video cookies are locally validated, never declared logged in.
pub(crate) async fn load_for_provider_playback(
    app: &App,
    viewer_id: Uuid,
    provider: &str,
) -> Result<FrozenAccount> {
    let provider = account_provider(provider)?;
    let row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(viewer_id)
        .bind(provider)
        .fetch_optional(&app.db)
        .await?;
    let Some(row) = row else {
        let mut frozen = FrozenAccount::anonymous_scoped(viewer_id, provider);
        frozen.explicit_anonymous = false;
        return Ok(frozen);
    };
    let scope = account_scope(&row);
    let live: bool = row.get("credential_live");
    let expiry = row.get("credential_expires_at_ms");
    let mut frozen = FrozenAccount {
        viewer_id,
        provider,
        observed: Some(scope),
        credential_expires_at_ms: expiry,
        cookie: None,
        short_cookie: None,
        youtube_cookie: None,
        explicit_anonymous: false,
    };
    if live {
        let encrypted: Option<String> = row.get("credential_encrypted");
        let plaintext = app
            .decrypt(encrypted.as_deref().ok_or_else(credential_error)?)
            .map_err(|_| credential_error())?;
        let stored = if provider == PROVIDER {
            scope::credential_cookies(scope, plaintext)
        } else {
            scope::credential_cookies_for_provider(scope, provider, plaintext)
        }
        .ok_or_else(credential_error)?;
        if provider == PROVIDER {
            frozen.cookie = Some(cookie_from_value(stored)?);
        } else if provider == "youtube" {
            let raw = stored.as_str().ok_or_else(credential_error)?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| credential_error())?
                .as_secs();
            frozen.youtube_cookie = Some(
                providers::platform::youtube::Credential::parse(raw, now)
                    .map_err(|_| credential_error())?,
            );
        } else {
            let raw = stored.as_str().ok_or_else(credential_error)?;
            frozen.short_cookie = Some(
                ShortCredential::parse(short_provider(provider)?, raw)
                    .map_err(|_| credential_error())?,
            );
        }
    }
    Ok(frozen)
}

/// Call after the normal room, membership, current-login and request fences.
/// Account SHARE locks are retained until the grant publication commits.
pub(crate) async fn guard_for_publish(
    tx: &mut Transaction<'_, Postgres>,
    viewer_id: Uuid,
    frozen: &FrozenAccount,
) -> Result<()> {
    let changed = || err(StatusCode::CONFLICT, "platform_account_changed");
    if frozen.viewer_id != viewer_id {
        return Err(changed());
    }
    if frozen.explicit_anonymous {
        return Ok(());
    }
    // Lock first, then project liveness in a fresh statement. PostgreSQL may
    // evaluate the first SELECT before a lock wait crosses the expiry cutoff.
    sqlx::query("SELECT id FROM platform_accounts WHERE user_id=$1 AND provider=$2 FOR SHARE")
        .bind(viewer_id)
        .bind(frozen.provider)
        .fetch_optional(&mut **tx)
        .await?;
    let row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(viewer_id)
        .bind(frozen.provider)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(row) = row else {
        return if frozen.observed.is_none() {
            Ok(())
        } else {
            Err(changed())
        };
    };
    let scope = account_scope(&row);
    let live: bool = row.get("credential_live");
    if frozen.observed != Some(scope)
        || live != frozen.has_credential()
        || (live
            && row.get::<Option<i64>, _>("credential_expires_at_ms")
                != frozen.credential_expires_at_ms)
    {
        return Err(changed());
    }
    Ok(())
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
    let user = auth(&app, &headers, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = app.db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    sqlx::query(
        "SELECT id FROM platform_accounts WHERE user_id=$1 AND provider='bilibili' FOR UPDATE",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let mut row = sqlx::query(ACCOUNT_SELECT)
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;
    if row.as_ref().is_some_and(|row| {
        row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")
    }) {
        row = Some(lock_account(&mut tx, user.id).await?);
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let value = status_value(row.as_ref());
    tx.commit().await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckLogin {
    // A required null means no account was observed, not an unconditional check.
    expected_revision: Value,
}

fn check_value(account: Value, verification: &str, checked_at: Option<i64>) -> Value {
    json!({"account": account, "verification": verification,
        "checked_at": checked_at, "renew_method": "qr_login"})
}

fn check_revision_matches(expected: Option<i64>, scope: Option<AccountScope>) -> bool {
    expected == scope.map(|scope| scope.revision)
}

fn check_snapshot_matches(
    observed: AccountScope,
    expiry: Option<i64>,
    current: Option<AccountScope>,
    live: bool,
    current_expiry: Option<i64>,
) -> bool {
    current == Some(observed) && live && current_expiry == expiry
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
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    let expected = expected_revision(&body.expected_revision)?;
    account_security::rate_limit(
        &app.db,
        "platform-login-check",
        &user.id.to_string(),
        20,
        600,
    )
    .await?;
    let mut tx = app.db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    sqlx::query(
        "SELECT id FROM platform_accounts WHERE user_id=$1 AND provider='bilibili' FOR UPDATE",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let mut row = sqlx::query(ACCOUNT_SELECT)
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;
    let observed = row.as_ref().map(account_scope);
    if !check_revision_matches(expected, observed) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    if row.as_ref().is_some_and(|row| {
        row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")
    }) {
        row = Some(lock_account(&mut tx, user.id).await?);
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let Some(account) = row
        .as_ref()
        .filter(|row| row.get::<bool, _>("credential_live"))
    else {
        let value = check_value(status_value(row.as_ref()), "none", None);
        tx.commit().await?;
        return Ok(responses::private_json(StatusCode::OK, value));
    };
    let scope = account_scope(account);
    let expires_at: Option<i64> = account.get("credential_expires_at_ms");
    let ciphertext: Option<String> = account.get("credential_encrypted");
    let plaintext = app
        .decrypt(ciphertext.as_deref().ok_or_else(credential_error)?)
        .map_err(|_| credential_error())?;
    let cookie = cookie_from_value(
        scope::credential_cookies(scope, plaintext).ok_or_else(credential_error)?,
    )?;
    tx.commit().await?;

    let upstream = Client::new(app.platform_http, Some(cookie))
        .check_login(Deadline::now() + Duration::from_secs(HTTP_SECONDS))
        .await;

    let mut tx = app.db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    sqlx::query(
        "SELECT id FROM platform_accounts WHERE user_id=$1 AND provider='bilibili' FOR UPDATE",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let mut current = sqlx::query(ACCOUNT_SELECT)
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;
    if !current.as_ref().is_some_and(|row| {
        check_snapshot_matches(
            scope,
            expires_at,
            Some(account_scope(row)),
            row.get::<bool, _>("credential_live"),
            row.get::<Option<i64>, _>("credential_expires_at_ms"),
        )
    }) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    let verification = match upstream {
        Ok(LoginValidity::Verified) => "verified",
        Ok(LoginValidity::Invalid) => {
            let revision = scope.revision.checked_add(1).ok_or_else(credential_error)?;
            let updated = sqlx::query("UPDATE platform_accounts SET state='expired',credential_encrypted=NULL,credential_expires_at=NULL,revision=$2,updated_at=clock_timestamp() WHERE id=$1 AND revision=$3 AND user_id=$4 AND provider='bilibili' AND playback_login_allowed($4,$5)")
                .bind(scope.account_id).bind(revision).bind(scope.revision).bind(user.id).bind(&login).execute(&mut *tx).await?;
            if updated.rows_affected() != 1 {
                return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
            }
            fail_pending(&mut tx, user.id).await?;
            current = sqlx::query(ACCOUNT_SELECT)
                .bind(user.id)
                .fetch_optional(&mut *tx)
                .await?;
            "invalid"
        }
        Err(_) => "unknown",
    };
    guard_login_live(&mut tx, user.id, &login).await?;
    let checked_at: i64 =
        sqlx::query_scalar("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&mut *tx)
            .await?;
    let value = check_value(
        status_value(current.as_ref()),
        verification,
        Some(checked_at),
    );
    tx.commit().await?;
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

fn qr_response(
    app: &App,
    request: &LoginRequest,
    include_payload: bool,
    stage: Option<&str>,
) -> Result<Value> {
    let payload = if include_payload && request.status == "pending" && request.live {
        request
            .qr_payload_encrypted
            .as_deref()
            .map(|cipher| {
                app.decrypt(cipher)
                    .ok()
                    .and_then(|value| scope::qr_secret(&request.scope, QR_PAYLOAD_PURPOSE, value))
                    .ok_or_else(credential_error)
            })
            .transpose()?
    } else {
        None
    };
    Ok(
        json!({"id": request.scope.request_id, "provider": PROVIDER, "status": request.status,
        "stage": if request.status == "pending" { stage } else { None }, "qr_payload": payload, "expires_at": request.expires_at_ms,
        "next_poll_at": request.next_poll_at_ms, "server_time": request.server_time_ms}),
    )
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
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    if body.idempotency_key.is_nil() || !body.consent_to_store {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "platform_storage_consent_required",
        ));
    }
    let mut tx = app.db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let account = lock_account(&mut tx, user.id).await?;
    let account = account_scope(&account);
    let previous = sqlx::query("SELECT id FROM platform_login_requests WHERE id=$1 FOR UPDATE")
        .bind(body.idempotency_key)
        .fetch_optional(&mut *tx)
        .await?;
    if previous.is_some() {
        let mut request = lock_request(&mut tx, body.idempotency_key, user.id, &login).await?;
        if request.consent_to_renew != body.consent_to_renew {
            return Err(err(StatusCode::CONFLICT, "platform_login_request_conflict"));
        }
        if request.status == "pending" {
            if !request.live {
                terminalize(&mut tx, request.scope.request_id, "expired").await?;
                request.status = "expired".into();
            } else if request.scope.account != account {
                terminalize(&mut tx, request.scope.request_id, "failed").await?;
                request.status = "failed".into();
            } else if request.qr_key_encrypted.is_none() && !request.operation_live {
                // Generation could have been sent before a process/HTTP loss.
                // An uncertain remote creation is never repeated for this ID.
                terminalize(&mut tx, request.scope.request_id, "failed").await?;
                request.status = "failed".into();
            }
        }
        let value = qr_response(&app, &request, true, None)?;
        tx.commit().await?;
        return Ok(responses::private_json(StatusCode::OK, value));
    }
    // Retire expired requests and requests from a vanished originating login.
    // A live same-login request remains exclusive until cancel or expiry.
    sqlx::query("UPDATE platform_login_requests SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'failed' END,qr_key_encrypted=NULL,qr_payload_encrypted=NULL,operation_nonce=NULL,operation_expires_at=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND provider='bilibili' AND status='pending' AND (expires_at<=clock_timestamp() OR NOT playback_login_allowed(user_id,auth_login_hash))")
        .bind(user.id).execute(&mut *tx).await?;
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform_login_requests WHERE user_id=$1 AND provider='bilibili' AND status='pending')")
        .bind(user.id).fetch_one(&mut *tx).await?;
    if active {
        return Err(err(StatusCode::CONFLICT, "platform_login_in_progress"));
    }
    // Re-reading the same exact-login request never generates another QR.
    // Charge only a new admission, atomically with its exclusive request row.
    if let Some(seconds) = account_security::claim_rate_limit(
        &mut tx,
        "platform-login-start",
        &user.id.to_string(),
        10,
        600,
    )
    .await?
    {
        tx.commit().await?;
        return Err(account_security::limited(seconds));
    }
    let nonce = Uuid::new_v4();
    sqlx::query("INSERT INTO platform_login_requests(id,user_id,auth_login_hash,provider,status,expires_at,next_poll_at,operation_nonce,operation_expires_at,account_id,account_revision,consent_to_renew) VALUES($1,$2,$3,'bilibili','pending',clock_timestamp()+$4*interval '1 second',clock_timestamp()+$5*interval '1 second',$6,clock_timestamp()+$7*interval '1 second',$8,$9,$10)")
        .bind(body.idempotency_key).bind(user.id).bind(&login).bind(QR_LIFETIME_SECONDS).bind(POLL_INTERVAL_SECONDS)
        .bind(nonce).bind(OPERATION_LEASE_SECONDS).bind(account.account_id).bind(account.revision).bind(body.consent_to_renew).execute(&mut *tx).await?;
    let request = lock_request(&mut tx, body.idempotency_key, user.id, &login).await?;
    let upstream_deadline = deadline(&request)?;
    tx.commit().await?;
    let upstream = Client::new(app.platform_http, None)
        .generate_qr(upstream_deadline)
        .await;
    // No database lock/transaction is retained across the provider call.
    let mut tx = app.db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let account = lock_account(&mut tx, user.id).await?;
    let account = account_scope(&account);
    let mut current = lock_request(&mut tx, request.scope.request_id, user.id, &login).await?;
    if current.status != "pending"
        || current.operation_nonce != Some(nonce)
        || account != request.scope.account
    {
        return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
    }
    if !current.live {
        terminalize(&mut tx, current.scope.request_id, "expired").await?;
        current.status = "expired".into();
    } else {
        if !can_complete(&current, nonce, account) {
            return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
        }
        match upstream {
            Ok(challenge) => {
                let key = app
                    .encrypt(&scope::qr_plaintext(
                        &current.scope,
                        QR_KEY_PURPOSE,
                        challenge.key.expose_for_storage(),
                    ))
                    .map_err(|_| credential_error())?;
                let payload = app
                    .encrypt(&scope::qr_plaintext(
                        &current.scope,
                        QR_PAYLOAD_PURPOSE,
                        &challenge.login_url,
                    ))
                    .map_err(|_| credential_error())?;
                sqlx::query("UPDATE platform_login_requests SET qr_key_encrypted=$2,qr_payload_encrypted=$3,operation_nonce=NULL,operation_expires_at=NULL,next_poll_at=GREATEST(next_poll_at,clock_timestamp()+$4*interval '1 second'),updated_at=clock_timestamp() WHERE id=$1")
                    .bind(current.scope.request_id).bind(key).bind(payload).bind(POLL_INTERVAL_SECONDS).execute(&mut *tx).await?;
            }
            Err(error) => {
                terminalize(&mut tx, current.scope.request_id, "failed").await?;
                tx.commit().await?;
                return Err(upstream_error("qr_generate", error));
            }
        }
    }
    let current = lock_request(&mut tx, current.scope.request_id, user.id, &login).await?;
    let value = qr_response(&app, &current, true, Some("waiting"))?;
    tx.commit().await?;
    Ok(responses::private_json(StatusCode::CREATED, value))
}

pub async fn poll_login(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response> {
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    let mut tx = app.db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let account = lock_account(&mut tx, user.id).await?;
    let account = account_scope(&account);
    let mut request = lock_request(&mut tx, id, user.id, &login).await?;
    if request.status == "pending" && !request.live {
        terminalize(&mut tx, id, "expired").await?;
        request.status = "expired".into();
    } else if request.status == "pending" && request.scope.account != account {
        terminalize(&mut tx, id, "failed").await?;
        request.status = "failed".into();
    }
    if request.status != "pending" || request.operation_live || !request.ready_to_poll {
        let value = qr_response(&app, &request, false, None)?;
        tx.commit().await?;
        return Ok(responses::private_json(StatusCode::OK, value));
    }
    let Some(cipher) = request.qr_key_encrypted.as_deref() else {
        // Never recreate a QR key when its generation outcome is unknown.
        terminalize(&mut tx, id, "failed").await?;
        request.status = "failed".into();
        let value = qr_response(&app, &request, false, None)?;
        tx.commit().await?;
        return Ok(responses::private_json(StatusCode::OK, value));
    };
    let key_secret = app
        .decrypt(cipher)
        .ok()
        .and_then(|value| scope::qr_secret(&request.scope, QR_KEY_PURPOSE, value))
        .ok_or_else(credential_error)?;
    let key = QrKey::from_secret(&key_secret).map_err(|_| credential_error())?;
    let nonce = Uuid::new_v4();
    sqlx::query("UPDATE platform_login_requests SET operation_nonce=$2,operation_expires_at=LEAST(expires_at,clock_timestamp()+$3*interval '1 second'),next_poll_at=clock_timestamp()+$4*interval '1 second',updated_at=clock_timestamp() WHERE id=$1")
        .bind(id).bind(nonce).bind(OPERATION_LEASE_SECONDS).bind(POLL_INTERVAL_SECONDS).execute(&mut *tx).await?;
    let upstream_deadline = deadline(&request)?;
    tx.commit().await?;
    let upstream = Client::new(app.platform_http, None)
        .poll_qr(&key, upstream_deadline)
        .await;
    let mut tx = app.db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let account = lock_account(&mut tx, user.id).await?;
    let account = account_scope(&account);
    let mut current = lock_request(&mut tx, id, user.id, &login).await?;
    if current.status != "pending"
        || current.operation_nonce != Some(nonce)
        || account != request.scope.account
    {
        return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
    }
    let stage;
    if !current.live {
        terminalize(&mut tx, id, "expired").await?;
        current.status = "expired".into();
        stage = None;
    } else {
        if !can_complete(&current, nonce, account) {
            return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
        }
        match upstream {
            Ok(poll) => match poll.state {
                QrState::Waiting | QrState::Scanned => {
                    stage = Some(if poll.state == QrState::Scanned {
                        "scanned"
                    } else {
                        "waiting"
                    });
                    sqlx::query("UPDATE platform_login_requests SET operation_nonce=NULL,operation_expires_at=NULL,next_poll_at=GREATEST(next_poll_at,clock_timestamp()+$2*interval '1 second'),updated_at=clock_timestamp() WHERE id=$1")
                        .bind(id).bind(POLL_INTERVAL_SECONDS).execute(&mut *tx).await?;
                }
                QrState::Expired => {
                    terminalize(&mut tx, id, "expired").await?;
                    current.status = "expired".into();
                    stage = None;
                }
                QrState::Confirmed => {
                    let cookie = poll.session.ok_or_else(credential_error)?;
                    let revision = account
                        .revision
                        .checked_add(1)
                        .ok_or_else(credential_error)?;
                    let updated_scope = AccountScope {
                        revision,
                        ..account
                    };
                    let cipher = app
                        .encrypt(&scope::credential_plaintext(
                            updated_scope,
                            cookie_value(&cookie),
                        ))
                        .map_err(|_| credential_error())?;
                    let stored = sqlx::query("UPDATE platform_accounts SET state='connected',credential_encrypted=$2,credential_expires_at=NULL,revision=$3,updated_at=clock_timestamp() WHERE id=$1 AND revision=$4 AND user_id=$5 AND playback_login_allowed($5,$6) AND EXISTS(SELECT 1 FROM platform_login_requests WHERE id=$7 AND user_id=$5 AND auth_login_hash=$6 AND account_id=$1 AND account_revision=$4 AND status='pending' AND expires_at>clock_timestamp() AND operation_nonce=$8 AND operation_expires_at>clock_timestamp())")
                        .bind(account.account_id).bind(cipher).bind(revision).bind(account.revision).bind(user.id).bind(&login).bind(id).bind(nonce).execute(&mut *tx).await?;
                    if stored.rows_affected() != 1 {
                        return Err(err(StatusCode::CONFLICT, "platform_login_changed"));
                    }
                    renewal::store_grant(
                        &app,
                        &mut tx,
                        updated_scope,
                        &login,
                        poll.refresh_token,
                        request.consent_to_renew,
                    )
                    .await?;
                    terminalize(&mut tx, id, "confirmed").await?;
                    current.status = "confirmed".into();
                    // Clear any other requests before a credential can be reused.
                    fail_pending(&mut tx, user.id).await?;
                    stage = None;
                }
            },
            Err(error) => {
                // This read-only poll can be retried for the same original key.
                // Retain its immutable overall deadline and release this claim.
                sqlx::query("UPDATE platform_login_requests SET operation_nonce=NULL,operation_expires_at=NULL,next_poll_at=GREATEST(next_poll_at,clock_timestamp()+$2*interval '1 second'),updated_at=clock_timestamp() WHERE id=$1")
                    .bind(id).bind(POLL_INTERVAL_SECONDS).execute(&mut *tx).await?;
                tx.commit().await?;
                return Err(upstream_error("qr_poll", error));
            }
        }
    }
    let current = lock_request(&mut tx, id, user.id, &login).await?;
    let value = qr_response(&app, &current, false, stage)?;
    tx.commit().await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

pub async fn cancel_login(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response> {
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    account_security::rate_limit(
        &app.db,
        "platform-login-cancel",
        &user.id.to_string(),
        30,
        600,
    )
    .await?;
    let mut tx = app.db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    if id.is_nil() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "platform_login_request_invalid",
        ));
    }
    let account = account_scope(&lock_account(&mut tx, user.id).await?);
    // A stable local tombstone fences a reordered start even if its response
    // never reached the browser. Cancellation never generates a remote QR.
    sqlx::query("INSERT INTO platform_login_requests(id,user_id,auth_login_hash,provider,status,expires_at,next_poll_at,account_id,account_revision) VALUES($1,$2,$3,'bilibili','failed',clock_timestamp()+$4*interval '1 second',clock_timestamp(),$5,$6) ON CONFLICT(id) DO NOTHING")
        .bind(id).bind(user.id).bind(&login).bind(QR_LIFETIME_SECONDS).bind(account.account_id).bind(account.revision).execute(&mut *tx).await?;
    let mut request = lock_request(&mut tx, id, user.id, &login).await?;
    if request.status == "pending" {
        terminalize(&mut tx, id, "failed").await?;
        request.status = "failed".into();
    }
    let value = qr_response(&app, &request, false, None)?;
    tx.commit().await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

pub async fn unlink(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    let mut tx = app.db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let account = lock_account(&mut tx, user.id).await?;
    let revision = account
        .get::<i64, _>("revision")
        .checked_add(1)
        .ok_or_else(credential_error)?;
    sqlx::query("UPDATE platform_accounts SET state='revoked',credential_encrypted=NULL,credential_expires_at=NULL,revision=$2,updated_at=clock_timestamp() WHERE id=$1")
        .bind(account.get::<Uuid, _>("id")).bind(revision).execute(&mut *tx).await?;
    fail_pending(&mut tx, user.id).await?;
    guard_login_live(&mut tx, user.id, &login).await?;
    let row = sqlx::query(ACCOUNT_SELECT)
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await?;
    let value = status_value(Some(&row));
    tx.commit().await?;
    // Existing and historical native grants retain their immutable provenance.
    // The current-account SQL predicate rejects the old revision immediately;
    // delivery revalidation drains active streams without an account→room lock.
    Ok(responses::private_json(StatusCode::OK, value))
}

// Only locally imported web sessions are supported for these providers. Official
// OAuth/QR APIs require an approved application and do not provide web cookies.
// No provider request, account verification, or secret is returned by this API.
fn short_status_value(provider: ShortPlatform, row: Option<&PgRow>) -> Value {
    let mut value = match row {
        Some(row) => json!({"id": row.get::<Uuid, _>("id"), "provider": provider.id(),
            "revision": row.get::<i64, _>("revision").to_string(), "state": row.get::<String, _>("state"),
            "credential_expires_at": row.get::<Option<i64>, _>("credential_expires_at_ms")}),
        None => json!({"id": null, "provider": provider.id(), "revision": null,
            "state": "revoked", "credential_expires_at": null}),
    };
    value["login_method"] = json!("cookie_import");
    value["qr_available"] = json!(false);
    value["verification"] = json!(if value["state"] == "connected" {
        "unverified"
    } else {
        "none"
    });
    value
}

pub async fn short_status(
    State(app): State<App>,
    Path(provider): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let provider = short_provider(&provider)?;
    let user = auth(&app, &headers, false).await?;
    let login = login_hash(&headers)?;
    let mut tx = app.db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    sqlx::query("SELECT id FROM platform_accounts WHERE user_id=$1 AND provider=$2 FOR UPDATE")
        .bind(user.id)
        .bind(provider.id())
        .fetch_optional(&mut *tx)
        .await?;
    let mut row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(user.id)
        .bind(provider.id())
        .fetch_optional(&mut *tx)
        .await?;
    if row.as_ref().is_some_and(|row| {
        row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")
    }) {
        row = Some(
            lock_provider_account(&mut tx, user.id, provider.id())
                .await?
                .0,
        );
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let value = short_status_value(provider, row.as_ref());
    tx.commit().await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

/// Deserialize-only ingress: never derive Debug or Serialize for raw cookies.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCredential {
    cookie: String,
    consent_to_store: bool,
    // Value deliberately requires the field, including explicit initial null.
    expected_revision: Value,
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
    let provider = short_provider(&provider)?;
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    if !body.consent_to_store {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "platform_storage_consent_required",
        ));
    }
    let expected = expected_revision(&body.expected_revision)?;
    // Validate and reduce to the provider's allowlisted, bounded session fields.
    let credential = ShortCredential::parse(provider, &body.cookie)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_credential_invalid"))?;
    account_security::rate_limit(
        &app.db,
        "platform-cookie-import",
        &user.id.to_string(),
        10,
        600,
    )
    .await?;
    let mut tx = app.db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let (row, inserted) = lock_provider_account(&mut tx, user.id, provider.id()).await?;
    let account = account_scope(&row);
    if !revision_matches(expected, account.revision, inserted) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let revision = account
        .revision
        .checked_add(1)
        .ok_or_else(credential_error)?;
    let cipher = app
        .encrypt(&scope::credential_plaintext_for_provider(
            AccountScope {
                revision,
                ..account
            },
            provider.id(),
            json!(credential.cookie_header()),
        ))
        .map_err(|_| credential_error())?;
    // The import never asserts upstream validity or a guessed cookie expiry.
    const IMPORT_ACCOUNT_UPDATE: &str = "UPDATE platform_accounts SET state='connected',credential_encrypted=$2,credential_expires_at=NULL,revision=$3,updated_at=clock_timestamp() WHERE id=$1 AND revision=$4 AND user_id=$5 AND provider=$6 AND playback_login_allowed($5,$7)";
    let stored = sqlx::query(IMPORT_ACCOUNT_UPDATE)
        .bind(account.account_id)
        .bind(cipher)
        .bind(revision)
        .bind(account.revision)
        .bind(user.id)
        .bind(provider.id())
        .bind(&login)
        .execute(&mut *tx)
        .await?;
    if stored.rows_affected() != 1 {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(user.id)
        .bind(provider.id())
        .fetch_one(&mut *tx)
        .await?;
    let value = short_status_value(provider, Some(&row));
    tx.commit().await?;
    Ok(responses::private_json(StatusCode::OK, value))
}

pub async fn unlink_short(
    State(app): State<App>,
    Path(provider): Path<String>,
    headers: HeaderMap,
    Json(body): Json<UnlinkCredential>,
) -> Result<Response> {
    let provider = short_provider(&provider)?;
    let user = auth(&app, &headers, true).await?;
    let login = login_hash(&headers)?;
    let expected = expected_revision(&body.expected_revision)?;
    let mut tx = app.db.begin().await?;
    guard_login(&mut tx, user.id, &login).await?;
    let (row, inserted) = lock_provider_account(&mut tx, user.id, provider.id()).await?;
    let account = account_scope(&row);
    if !revision_matches(expected, account.revision, inserted) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let revision = account
        .revision
        .checked_add(1)
        .ok_or_else(credential_error)?;
    let stored = sqlx::query("UPDATE platform_accounts SET state='revoked',credential_encrypted=NULL,credential_expires_at=NULL,revision=$2,updated_at=clock_timestamp() WHERE id=$1 AND revision=$3 AND user_id=$4 AND provider=$5 AND playback_login_allowed($4,$6)")
        .bind(account.account_id).bind(revision).bind(account.revision)
        .bind(user.id).bind(provider.id()).bind(&login).execute(&mut *tx).await?;
    if stored.rows_affected() != 1 {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    guard_login_live(&mut tx, user.id, &login).await?;
    let row = sqlx::query(PROVIDER_ACCOUNT_SELECT)
        .bind(user.id)
        .bind(provider.id())
        .fetch_one(&mut *tx)
        .await?;
    let value = short_status_value(provider, Some(&row));
    tx.commit().await?;
    // Historical grants retain immutable provenance; their stale provider-bound
    // revisions fail native_platform_source_allowed during delivery rechecks.
    Ok(responses::private_json(StatusCode::OK, value))
}

#[cfg(test)]
mod tests {
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
            let value = short_status_value(provider, None);
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
    fn provider_lookup_and_anonymous_context_do_not_expand_credential_support() {
        assert!(short_provider("bilibili").is_err());
        assert!(short_provider("youtube").is_err());
        assert!(short_provider("Douyin").is_err());
        assert_eq!(account_provider("youtube").unwrap(), "youtube");
        let viewer = Uuid::from_u128(1);
        for provider in ["bilibili", "douyin", "tiktok", "youtube"] {
            let frozen = FrozenAccount::anonymous_for_provider(viewer, provider).unwrap();
            assert_eq!(frozen.provider, provider);
            assert!(frozen.explicit_anonymous);
            assert!(frozen.account_id().is_none());
            assert!(frozen.revision().is_none());
            assert!(frozen.cookie().is_none());
            assert!(frozen.short_cookie().is_none());
        }
        assert!(FrozenAccount::anonymous_for_provider(viewer, "unknown").is_err());
    }

    #[test]
    fn short_frozen_context_uses_only_active_provider_credentials() {
        let account = AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: 3,
        };
        let mut frozen = FrozenAccount {
            viewer_id: account.user_id,
            provider: "douyin",
            observed: Some(account),
            credential_expires_at_ms: None,
            cookie: None,
            short_cookie: Some(
                ShortCredential::parse(ShortPlatform::Douyin, "sessionid=fixture-only-session")
                    .unwrap(),
            ),
            youtube_cookie: None,
            explicit_anonymous: false,
        };
        assert_eq!(frozen.account_id(), Some(account.account_id));
        assert_eq!(frozen.revision(), Some(3));
        assert!(frozen.cookie().is_none());
        assert!(frozen.short_cookie().is_some());
        frozen.short_cookie = None;
        assert!(frozen.account_id().is_none());
        assert!(frozen.revision().is_none());
    }

    #[test]
    fn youtube_frozen_session_is_opaque_and_revision_bound_without_borrowing_other_providers() {
        let account = AccountScope {
            user_id: Uuid::from_u128(1),
            account_id: Uuid::from_u128(2),
            revision: 3,
        };
        let credential = providers::platform::youtube::Credential::parse(
            "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsynthetic-session-only\n.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tsynthetic-login-only\n", 100).unwrap();
        let stored = scope::credential_plaintext_for_provider(
            account,
            "youtube",
            json!(credential.expose_for_storage()),
        );
        assert!(
            scope::credential_cookies_for_provider(account, "bilibili", stored.clone()).is_none()
        );
        assert!(
            scope::credential_cookies_for_provider(account, "douyin", stored.clone()).is_none()
        );
        assert!(
            scope::credential_cookies_for_provider(
                AccountScope {
                    revision: 4,
                    ..account
                },
                "youtube",
                stored.clone()
            )
            .is_none()
        );
        assert!(scope::credential_cookies_for_provider(account, "youtube", stored).is_some());
        let frozen = FrozenAccount {
            viewer_id: account.user_id,
            provider: "youtube",
            observed: Some(account),
            credential_expires_at_ms: None,
            cookie: None,
            short_cookie: None,
            youtube_cookie: Some(credential),
            explicit_anonymous: false,
        };
        assert_eq!(frozen.account_id(), Some(account.account_id));
        assert_eq!(frozen.revision(), Some(3));
        assert!(frozen.cookie().is_none());
        assert!(frozen.short_cookie().is_none());
        assert!(frozen.youtube_cookie().is_some());
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
