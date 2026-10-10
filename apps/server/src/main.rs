mod account_exit;
mod account_exit_cleanup;
mod account_rules;
mod account_security;
mod admin_bootstrap;
mod admin_settings;
mod advanced_playback;
mod agent_drain;
mod agent_metrics;
mod agents;
mod avatar_image;
mod avatars;
mod bootstrap;
mod catalog;
mod control_cluster;
mod control_recovery_metrics;
mod database_checks;
mod distributed_compute;
mod distributed_playback;
mod error;
mod finite_hls;
mod guests;
mod health;
mod http_representation;
mod identity;
mod limits;
mod local_hls_ladder;
mod local_hls_ladder_readiness;
mod media;
mod media_authorization;
mod media_browse;
mod media_previews;
mod media_titles;
mod metrics;
mod native_live;
mod native_other_live;
mod native_platform;
mod native_platform_config;
mod native_platform_text;
mod owned_http;
mod platform_accounts;
mod platform_import;
mod platform_media;
mod playback;
mod playback_capabilities;
mod playback_metrics;
mod playback_observations;
mod playback_plan;
mod playback_requests;
mod plugins;
mod preparation_owner;
pub mod presence;
mod private_library;
mod profile;
mod registration;
mod registration_auth;
mod responses;
mod room_cleanup;
mod room_diagnostics;
mod room_lifecycle;
mod room_ownership;
mod room_p2p;
mod rooms;
mod s3_playback;
mod source_access;
mod source_key_check;
mod source_settings;
mod static_hls_availability;
mod static_hls_child_parent;
mod static_hls_child_plan;
mod static_hls_child_public;
mod static_hls_child_readiness;
mod static_hls_child_request;
mod static_hls_contract;
mod static_hls_input_cipher;
mod static_hls_operation_cipher;
mod static_hls_operation_client;
mod static_hls_parent_plan;
mod static_hls_public;
mod timeline_chat;
mod upstream;
mod upstream_policy;
mod upstream_profiles;
#[cfg(test)]
use aes_gcm::KeyInit;
use aes_gcm::{Aes256Gcm, aead::Aead};
use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, State, ws::WebSocketUpgrade},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::{collections::HashMap, sync::Arc, time::Instant};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone)]
pub struct App {
    control_cluster: Option<control_cluster::Runtime>,
    platform_http: providers::platform::http::PlatformHttp,
    bilibili_signing_keys: Arc<platform_media::bilibili_cache::Registry>,
    native_delivery_owners: Arc<platform_media::NativeDeliveryRegistry>,
    youtube: providers::platform::youtube::YoutubeResolver,
    live_playback: native_live::LiveStore,
    other_live_playback: native_other_live::LiveStore,
    other_live_enabled: bool,
    platform_oauth: Arc<providers::platform::oauth::Registry>,
    platform_oauth_exchanges: Arc<platform_accounts::exchanges::Registry>,
    native_transcode_delivery: Arc<platform_media::transcode::Registry>,
    pub presence_sequence: presence::Sequence,
    account_security: account_security::Security,
    avatar_settings: avatar_image::Settings,
    session_limit: i64,
    queue_limit: i64,
    preview_settings: persistence::media_previews::Settings,
    metrics: Arc<metrics::Metrics>,
    readiness: Arc<health::Runtime>,
    db: PgPool,
    origin: String,
    secure: bool,
    key: Arc<Aes256Gcm>,
    epoch: Uuid,
    start: Instant,
    rooms: Arc<Mutex<HashMap<Uuid, rooms::Handle>>>,
    agent_controls: Arc<Mutex<HashMap<Uuid, agents::Control>>>,
    upstream: Arc<upstream::Runtime>,
    upstream_policy: Arc<upstream_policy::Runtime>,
    preparations: Arc<preparation_owner::Registry>,
}
impl App {
    fn identity_context(&self) -> identity::RequestContext<'_> {
        identity::RequestContext {
            db: &self.db,
            origin: &self.origin,
        }
    }
    fn now(&self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }
    fn encrypt(&self, value: &Value) -> anyhow::Result<String> {
        let mut nonce = [0; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let cipher = self
            .key
            .encrypt((&nonce).into(), serde_json::to_vec(value)?.as_slice())
            .map_err(|_| anyhow::anyhow!("encryption_failed"))?;
        Ok(STANDARD.encode([nonce.to_vec(), cipher].concat()))
    }
    fn decrypt(&self, value: &str) -> anyhow::Result<Value> {
        let bytes = STANDARD.decode(value)?;
        if bytes.len() < 12 {
            anyhow::bail!("invalid_ciphertext")
        }
        let data = self
            .key
            .decrypt(bytes[..12].into(), &bytes[12..])
            .map_err(|_| anyhow::anyhow!("decryption_failed"))?;
        Ok(serde_json::from_slice(&data)?)
    }
}
pub use error::Error;
use error::err;
pub use identity::RequestIdentity as User;
type Result<T> = std::result::Result<T, Error>;
fn hash(v: &str) -> String {
    hex::encode(Sha256::digest(v.as_bytes()))
}
fn token() -> String {
    let mut v = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut v);
    hex::encode(v)
}
fn session_cookie(app: &App, token: &str) -> String {
    format!(
        "rainsync_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800{}",
        if app.secure { "; Secure" } else { "" }
    )
}
// Compatibility adapters for handlers not yet migrated to narrow request contexts.
// They do not confer transaction admission; each mutation retains its own locks.
use identity::request::{admin, cookie};
fn origin(app: &App, h: &HeaderMap) -> Result<()> {
    identity::request::origin(&app.origin, h)
}
async fn auth(app: &App, h: &HeaderMap, write: bool) -> Result<User> {
    identity::request::authenticate(app.identity_context(), h, write, false).await
}
/// Only explicit room-viewer handlers may opt in. New endpoints fail closed.
async fn auth_viewer(app: &App, h: &HeaderMap, write: bool) -> Result<User> {
    identity::request::authenticate(app.identity_context(), h, write, true).await
}
async fn member(app: &App, user: &User, room: Uuid) -> Result<()> {
    identity::request::member(&app.db, user, room).await
}

#[derive(Deserialize)]
struct Login {
    username: String,
    password: String,
}
async fn login(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    h: HeaderMap,
    Json(body): Json<Login>,
) -> Result<Response> {
    origin(&app, &h)?;
    if let Some(current) = cookie(&h) {
        let guest:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp() AND u.principal_kind='guest')").bind(hash(&current)).fetch_one(&app.db).await?;
        if guest {
            return Err(err(StatusCode::CONFLICT, "already_authenticated"));
        }
    }
    if body.username.len() > 80 || body.password.len() > 1024 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_credentials"));
    }
    let source = app.account_security.source(peer, &h).to_string();
    account_security::login_admit(&app.db, &source).await?;
    let row = sqlx::query("SELECT id,password_hash FROM users WHERE username=$1 AND principal_kind='account' AND NOT EXISTS(SELECT 1 FROM account_exits e WHERE e.user_id=users.id)")
        .bind(&body.username)
        .fetch_optional(&app.db)
        .await?;
    let valid = account_security::login_verify(
        &app.account_security,
        row.as_ref().map(|row| row.get("password_hash")),
        body.password,
    )
    .await?;
    if !valid {
        account_security::login_failed(&app.db, &source).await?;
        return Err(err(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }
    let row = row.ok_or_else(|| err(StatusCode::UNAUTHORIZED, "invalid_credentials"))?;
    let t = token();
    let csrf = token();
    sqlx::query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '7 days')")
        .bind(hash(&t))
        .bind(row.get::<Uuid, _>("id"))
        .bind(&csrf)
        .execute(&app.db)
        .await?;
    Ok((
        [
            (header::SET_COOKIE, session_cookie(&app, &t)),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
        Json(json!({"csrf":csrf})),
    )
        .into_response())
}
async fn me(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    let u = auth_viewer(&app, &h, false).await?;
    let mut value = identity::profiles::value(&app.db, u.id).await?;
    let csrf: String = sqlx::query_scalar("SELECT csrf FROM sessions WHERE token_hash=$1")
        .bind(hash(&cookie(&h).unwrap()))
        .fetch_one(&app.db)
        .await?;
    value["admin"] = json!(u.admin);
    value["csrf"] = json!(csrf);
    guests::add_identity(&app, u.id, &mut value).await?;
    Ok(responses::private_json(StatusCode::OK, value))
}
async fn logout(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    origin(&app, &h)?;
    match auth_viewer(&app, &h, true).await {
        Ok(_) => {}
        Err(error) if error.0 == StatusCode::UNAUTHORIZED => {}
        Err(error) => return Err(error),
    }
    if let Some(session) = cookie(&h) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
            .bind(hash(&session))
            .execute(&app.db)
            .await?;
    }
    Ok((
        [(
            header::SET_COOKIE,
            format!(
                "rainsync_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{}",
                if app.secure { "; Secure" } else { "" }
            ),
        )],
        Json(json!({"ok":true})),
    )
        .into_response())
}
async fn users(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<account_rules::NewAccount>,
) -> Result<Json<Value>> {
    let actor = auth(&app, &h, true).await?;
    admin(&actor)?;
    let display_name = body.validate()?;
    let pw = account_security::password_hash(&app, body.password).await?;
    let id = Uuid::new_v4();
    let mut tx = app.db.begin().await?;
    let login = admin_settings::lock_admin(&mut tx, &actor, &h, true).await?;
    sqlx::query("INSERT INTO users VALUES($1,$2,$3,false)")
        .bind(id)
        .bind(body.username)
        .bind(pw)
        .execute(&mut *tx)
        .await
        .map_err(account_rules::insert_error)?;
    if let Some(name) = display_name {
        sqlx::query("INSERT INTO user_profiles(user_id,display_name) VALUES($1,$2)")
            .bind(id)
            .bind(name)
            .execute(&mut *tx)
            .await?;
    }
    admin_settings::finish(tx, &actor, &login).await?;
    Ok(Json(json!({"id":id})))
}
async fn ws(State(app): State<App>, h: HeaderMap, upgrade: WebSocketUpgrade) -> Result<Response> {
    origin(&app, &h)?;
    let user = auth_viewer(&app, &h, false).await?;
    let session_hash = hash(&cookie(&h).unwrap());
    Ok(upgrade
        .max_message_size(16384)
        .max_frame_size(16384)
        .on_upgrade(move |socket| rooms::socket(app, user, socket, session_hash)))
}

fn main() -> anyhow::Result<()> {
    bootstrap::main()
}
