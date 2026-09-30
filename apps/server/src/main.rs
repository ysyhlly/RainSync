mod account_rules;
mod account_security;
mod agents;
mod avatar_image;
mod avatars;
mod database_checks;
mod health;
mod http_representation;
mod limits;
mod media;
mod media_previews;
mod media_titles;
mod metrics;
mod playback_capabilities;
mod playback_metrics;
mod playback_observations;
mod playback_requests;
mod preparation_owner;
pub mod presence;
mod profile;
mod registration;
mod registration_auth;
mod room_cleanup;
mod room_lifecycle;
mod room_ownership;
mod rooms;
mod source_access;
mod upstream;
mod upstream_policy;
use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{
    Json, Router,
    extract::{Path, State, ws::WebSocketUpgrade},
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
#[derive(Clone)]
pub struct User {
    id: Uuid,
    admin: bool,
}
#[derive(Debug)]
pub struct Error(StatusCode, String, Option<u32>);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let mut response = (self.0, Json(json!({"error":self.1}))).into_response();
        if let Some(seconds) = self.2 {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, seconds.to_string().parse().unwrap());
        }
        response
    }
}
impl From<anyhow::Error> for Error {
    fn from(_: anyhow::Error) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "operation_failed".into(),
            None,
        )
    }
}
impl From<sqlx::Error> for Error {
    fn from(_: sqlx::Error) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "database_error".into(),
            None,
        )
    }
}
type Result<T> = std::result::Result<T, Error>;
fn err(status: StatusCode, msg: &str) -> Error {
    Error(status, msg.into(), None)
}
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
fn cookie(h: &HeaderMap) -> Option<String> {
    h.get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|p| p.trim().strip_prefix("rainsync_session=").map(String::from))
}
fn origin(app: &App, h: &HeaderMap) -> Result<()> {
    if h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(app.origin.as_str()) {
        return Err(err(StatusCode::FORBIDDEN, "origin_rejected"));
    };
    Ok(())
}
async fn auth(app: &App, h: &HeaderMap, write: bool) -> Result<User> {
    let token = cookie(h).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))?;
    let row=sqlx::query("SELECT u.id,u.admin,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now()").bind(hash(&token)).fetch_optional(&app.db).await?.ok_or_else(||err(StatusCode::UNAUTHORIZED,"session_expired"))?;
    if write {
        origin(app, h)?;
        if h.get("x-csrf-token").and_then(|v| v.to_str().ok())
            != Some(row.get::<String, _>("csrf").as_str())
        {
            return Err(err(StatusCode::FORBIDDEN, "csrf_rejected"));
        }
    }
    Ok(User {
        id: row.get("id"),
        admin: row.get("admin"),
    })
}
async fn member(app: &App, user: &User, room: Uuid) -> Result<()> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)",
    )
    .bind(room)
    .bind(user.id)
    .fetch_one(&app.db)
    .await?;
    if !exists {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    };
    Ok(())
}
fn admin(user: &User) -> Result<()> {
    if !user.admin {
        return Err(err(StatusCode::FORBIDDEN, "admin_required"));
    };
    Ok(())
}

#[derive(Deserialize)]
struct Login {
    username: String,
    password: String,
}
async fn login(State(app): State<App>, h: HeaderMap, Json(body): Json<Login>) -> Result<Response> {
    origin(&app, &h)?;
    if body.username.len() > 80 || body.password.len() > 1024 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_credentials"));
    }
    login_attempt(&app.db, &body.username).await?;
    let row = sqlx::query("SELECT id,password_hash FROM users WHERE username=$1")
        .bind(&body.username)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "invalid_credentials"))?;
    let stored: String = row.get("password_hash");
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&stored).ok().is_some_and(|p| {
            Argon2::default()
                .verify_password(body.password.as_bytes(), &p)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if !valid {
        return Err(err(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }
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
async fn login_attempt(db: &PgPool, username: &str) -> Result<()> {
    let mut tx = db.begin().await?;
    // Serialize only the small bounded bookkeeping transaction, never Argon2.
    sqlx::query("LOCK TABLE login_attempts IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM login_attempts WHERE window_started<=now()-interval '60 seconds'")
        .execute(&mut *tx)
        .await?;
    let key = hash(username);
    let full: bool = sqlx::query_scalar("SELECT (SELECT count(*) FROM login_attempts)>=1000 AND NOT EXISTS(SELECT 1 FROM login_attempts WHERE username_hash=$1)")
        .bind(&key).fetch_one(&mut *tx).await?;
    if full {
        tx.commit().await?;
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "try_later"));
    }
    let attempts: i32 = sqlx::query_scalar("INSERT INTO login_attempts(username_hash,attempts) VALUES($1,1) ON CONFLICT(username_hash) DO UPDATE SET attempts=LEAST(login_attempts.attempts+1,11) RETURNING attempts")
        .bind(key).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    if attempts > 10 {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "try_later"));
    }
    Ok(())
}
async fn me(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    let mut value = profile::value(&app, u.id).await?;
    let csrf: String = sqlx::query_scalar("SELECT csrf FROM sessions WHERE token_hash=$1")
        .bind(hash(&cookie(&h).unwrap()))
        .fetch_one(&app.db)
        .await?;
    value["admin"] = json!(u.admin);
    value["csrf"] = json!(csrf);
    Ok(registration::private_json(StatusCode::OK, value))
}
async fn logout(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    auth(&app, &h, true).await?;
    sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
        .bind(hash(&cookie(&h).unwrap()))
        .execute(&app.db)
        .await?;
    Ok((
        [(
            header::SET_COOKIE,
            "rainsync_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
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
    admin(&auth(&app, &h, true).await?)?;
    let display_name = body.validate()?;
    let pw = account_security::password_hash(&app, body.password).await?;
    let id = Uuid::new_v4();
    let mut tx = app.db.begin().await?;
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
    tx.commit().await?;
    Ok(Json(json!({"id":id})))
}
async fn ws(State(app): State<App>, h: HeaderMap, upgrade: WebSocketUpgrade) -> Result<Response> {
    origin(&app, &h)?;
    let user = auth(&app, &h, false).await?;
    let session_hash = hash(&cookie(&h).unwrap());
    Ok(upgrade
        .max_message_size(16384)
        .max_frame_size(16384)
        .on_upgrade(move |socket| rooms::socket(app, user, socket, session_hash)))
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let owners = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .thread_name("media-owner")
        .enable_all()
        .build()?;
    media_core::child_process::set_owner_runtime(owners.handle().clone())?;
    let application = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = application.block_on(async {
        let (lost, loss) = tokio::sync::oneshot::channel();
        tokio::select! {
            biased;
            Ok(()) = loss => anyhow::bail!("server instance lock connection lost"),
            result = run(lost) => result,
        }
    });
    // On lock loss there is no HTTP grace period: abort every application task,
    // including upgraded sockets and detached maintenance/preparation tasks.
    // The separate process reactor remains alive to kill and reap descendants.
    drop(application);
    owners.block_on(media_core::child_process::shutdown())?;
    result
}

async fn run(lost: tokio::sync::oneshot::Sender<()>) -> anyhow::Result<()> {
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    persistence::migrate(&db).await?;
    let mut lock = db.acquire().await?;
    let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(72614931)")
        .fetch_one(&mut *lock)
        .await?;
    anyhow::ensure!(acquired, "another RainSync server owns the instance lock");
    let readiness = Arc::new(health::Runtime::default());
    readiness.observe(health::Check::InstanceOwnership, health::Outcome::Ready);
    let lock_readiness = readiness.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if !matches!(
                tokio::time::timeout(
                    std::time::Duration::from_secs(3),
                    sqlx::query("SELECT 1").execute(&mut *lock),
                )
                .await,
                Ok(Ok(_))
            ) {
                lock_readiness.observe(health::Check::InstanceOwnership, health::Outcome::Failed);
                lock_readiness.accepting(false);
                let _ = lost.send(());
                // A timed-out connection may still own the lock. Retain it
                // until the supervisor stops the entire application runtime.
                std::future::pending::<()>().await;
                return;
            }
            // This is the same live connection which owns the advisory lock.
            lock_readiness.observe(health::Check::InstanceOwnership, health::Outcome::Ready);
        }
    });
    let probe_db = db.clone();
    let probe_readiness = readiness.clone();
    tokio::spawn(async move {
        loop {
            let healthy = matches!(
                tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    database_checks::boolean(&probe_db, sqlx::query_scalar("SELECT true"), 750)
                )
                .await,
                Ok(Ok(_))
            );
            probe_readiness.observe(
                health::Check::Database,
                if healthy {
                    health::Outcome::Ready
                } else {
                    health::Outcome::Failed
                },
            );
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&db)
        .await?;
    if count == 0 {
        let password = std::env::var("ADMIN_PASSWORD")?;
        let username = std::env::var("ADMIN_USERNAME").unwrap_or("admin".into());
        anyhow::ensure!(
            account_rules::valid_password(&password),
            "ADMIN_PASSWORD must have 8-1024 printable ASCII characters; spaces are preserved"
        );
        anyhow::ensure!(
            account_rules::valid_username(&username),
            "ADMIN_USERNAME must match [A-Za-z0-9_.-] and have 1-80 characters"
        );
        let pw = Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map_err(|_| anyhow::anyhow!("hash_failed"))?
            .to_string();
        sqlx::query("INSERT INTO users VALUES($1,$2,$3,true)")
            .bind(Uuid::new_v4())
            .bind(username)
            .bind(pw)
            .execute(&db)
            .await?;
    }
    let key = STANDARD.decode(std::env::var("SOURCE_ENCRYPTION_KEY")?)?;
    anyhow::ensure!(
        key.len() == 32,
        "SOURCE_ENCRYPTION_KEY must decode to 32 bytes"
    );
    let public_origin = std::env::var("PUBLIC_ORIGIN").unwrap_or("http://localhost:5173".into());
    let app = App {
        presence_sequence: presence::Sequence::default(),
        account_security: account_security::Security::configured()?,
        avatar_settings: avatar_image::Settings::configured()?,
        session_limit: limits::configured("PLAYBACK_SESSION_LIMIT", limits::DEFAULT_SESSION_LIMIT)?,
        queue_limit: limits::configured("MEDIA_QUEUE_LIMIT", limits::DEFAULT_QUEUE_LIMIT)?,
        preview_settings: persistence::media_previews::Settings::configured()?,
        metrics: Default::default(),
        readiness: readiness.clone(),
        db: db.clone(),
        secure: public_origin.starts_with("https://"),
        origin: public_origin,
        key: Arc::new(Aes256Gcm::new_from_slice(&key).unwrap()),
        epoch: Uuid::new_v4(),
        start: Instant::now(),
        rooms: Default::default(),
        agent_controls: Default::default(),
        upstream: Default::default(),
        upstream_policy: Default::default(),
        preparations: Default::default(),
    };
    // Retire previous-process grants before same-key recovery. The instance
    // lock fences new valid publication; it is not positive physical drain
    // proof. Unknown preparation/resource receipts remain unconfirmed.
    upstream_policy::startup(&app).await?;
    let mut recovery = db.begin().await?;
    sqlx::query("UPDATE playback_requests SET status='failed',error_status=409,error_code='playback_request_interrupted' WHERE status='pending'")
        .execute(&mut *recovery).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id IN(SELECT session_id FROM playback_requests WHERE status='failed' AND error_code='playback_request_interrupted')")
        .execute(&mut *recovery).await?;
    persistence::upstream_reservations::recover(&mut recovery, app.epoch).await?;
    recovery.commit().await?;
    for row in sqlx::query("SELECT state FROM room_snapshots")
        .fetch_all(&db)
        .await?
    {
        let mut s: protocol::RoomState = serde_json::from_value(row.get("state"))?;
        s.playback_status = protocol::PlaybackStatus::Paused;
        s.clock_epoch = app.epoch;
        s.anchor_server_time_ms = 0.0;
        s.revision += 1;
        sqlx::query("UPDATE room_snapshots SET state=$2 WHERE room_id=$1")
            .bind(s.room_id)
            .bind(serde_json::to_value(&s)?)
            .execute(&db)
            .await?;
    }
    let cleanup = db.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            for query in [
                "DELETE FROM room_events WHERE created_at<now()-interval '24 hours'",
                "DELETE FROM chat_messages WHERE created_at<now()-interval '7 days'",
                "DELETE FROM sessions WHERE expires_at<now()",
                "DELETE FROM playback_http_representations WHERE (session_id,target_sha256) IN (SELECT h.session_id,h.target_sha256 FROM playback_http_representations h JOIN playback_sessions p ON p.id=h.session_id WHERE p.stopped AND p.expires_at<clock_timestamp()-interval '48 hours' AND NOT EXISTS(SELECT 1 FROM playback_preparations prep WHERE prep.session_id=p.id AND prep.drained_at IS NULL) LIMIT 1000)",
                "DELETE FROM login_attempts WHERE window_started<=now()-interval '60 seconds'",
                "DELETE FROM account_rate_limits WHERE expires_at<=clock_timestamp()",
                "DELETE FROM agent_transfers WHERE expires_at<now()",
                "UPDATE agent_transfer_runs SET status='failed',reason='transfer_owner_lost',updated_at=now(),finished_at=now(),agent_drained_at=CASE WHEN dispatched_at IS NULL AND NOT legacy_unconfirmed THEN COALESCE(agent_drained_at,clock_timestamp()) ELSE agent_drained_at END WHERE finished_at IS NULL AND lease_until<=now()",
                "DELETE FROM agent_transfer_runs WHERE NOT legacy_unconfirmed AND finished_at<now()-interval '24 hours' AND (session_id IS NULL OR agent_drained_at IS NOT NULL)",
                "DELETE FROM playback_requests r WHERE r.expires_at<now() AND NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=r.session_id AND NOT p.stopped AND p.expires_at>now())",
                // Preserve the positive ledger proof across a failed marker write.
                // These statements acquire session rows only; do not invert the
                // session-before-upstream lock order used by Stop/close.
                "UPDATE playback_sessions p SET stopped=true,resource=resource||'{\"upstream_closed\":true}'::jsonb WHERE NOT(p.resource @> '{\"upstream_closed\":true}'::jsonb) AND EXISTS(SELECT 1 FROM upstream_reservations u WHERE u.id=p.id AND u.state='closed')",
                "DELETE FROM upstream_reservations u WHERE u.state='closed' AND u.closed_at<now()-interval '48 hours' AND NOT EXISTS(SELECT 1 FROM room_cleanup_tasks c WHERE c.room_id=u.room_id AND c.completed_at IS NULL) AND NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=u.id AND NOT(p.resource @> '{\"upstream_closed\":true}'::jsonb))",
                "DELETE FROM playback_observations o WHERE o.created_at<now()-interval '48 hours' AND NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=o.session_id AND NOT p.stopped AND p.expires_at>now()) AND NOT EXISTS(SELECT 1 FROM upstream_reservations u WHERE u.id=o.session_id AND u.state<>'closed')",
            ] {
                let _ = sqlx::query(query).execute(&cleanup).await;
            }
            let _ = persistence::cleanup_control_history(&cleanup).await;
            let _ = persistence::room_cleanup::prune_receipts(&cleanup).await;
        }
    });
    tokio::spawn(upstream::maintenance(app.clone()));
    tokio::spawn(upstream_policy::maintenance(app.clone()));
    tokio::spawn(room_cleanup::run(app.clone()));
    let preparations = app.preparations.clone();
    let upstream = app.upstream.clone();
    let router = Router::new()
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
        .route("/api/v1/auth/login", post(login))
        .route(
            "/api/v1/auth/registration-invites/validate",
            post(registration_auth::validate),
        )
        .route("/api/v1/auth/register", post(registration_auth::register))
        .route("/api/v1/auth/me", get(me))
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/users", post(users))
        .route(
            "/api/v1/users/me/profile",
            get(profile::get_profile).patch(profile::update),
        )
        .route(
            "/api/v1/users/me/avatar",
            axum::routing::put(avatars::upload).delete(avatars::remove),
        )
        .route("/api/v1/users/{id}/avatar", get(avatars::read))
        .route(
            "/api/v1/admin/registration-invites",
            get(registration::list).post(registration::create),
        )
        .route(
            "/api/v1/admin/registration-invites/{id}",
            delete(registration::revoke),
        )
        .route("/api/v1/rooms", get(rooms::list).post(rooms::create))
        .route("/api/v1/rooms/{id}/members", get(room_ownership::members))
        .route("/api/v1/rooms/{id}/owner", post(room_ownership::transfer))
        .route("/api/v1/rooms/{id}/lifecycle", get(room_lifecycle::status))
        .route("/api/v1/rooms/{id}/close", post(room_lifecycle::close))
        .route("/api/v1/rooms/{id}/reopen", post(room_lifecycle::reopen))
        .route("/api/v1/rooms/{id}/archive", post(room_lifecycle::archive))
        .route("/api/v1/rooms/{id}/join", post(rooms::join))
        .route("/api/v1/rooms/{id}/invites", post(rooms::invite))
        .route(
            "/api/v1/rooms/{id}/invites/{token}",
            delete(rooms::revoke_invite),
        )
        .route(
            "/api/v1/rooms/{id}/playlist",
            get(rooms::playlist).post(rooms::add_playlist),
        )
        .route(
            "/api/v1/rooms/{id}/playlist/{item}",
            delete(rooms::remove_playlist),
        )
        .route("/api/v1/rooms/{id}/messages", get(rooms::messages))
        .route(
            "/api/v1/sources",
            get(media::sources).post(media::add_source),
        )
        .route("/api/v1/sources/{id}/test", post(media::scan))
        .route(
            "/api/v1/sources/{id}/access-policy",
            post(source_access::change),
        )
        .route("/api/v1/media", get(media::library))
        .route(
            "/api/v1/media/previews",
            get(media_previews::status).post(media_previews::request),
        )
        .route("/api/v1/media/{id}/cover", get(media_previews::image))
        .route("/api/v1/media/{id}", get(media_titles::detail))
        .route(
            "/api/v1/media/{id}/personal-title",
            axum::routing::put(media_titles::personal),
        )
        .route(
            "/api/v1/admin/media/{id}/shared-title",
            axum::routing::put(media_titles::shared),
        )
        .route(
            "/api/v1/playback-candidates",
            post(playback_capabilities::candidates),
        )
        .route("/api/v1/playback-sessions", post(media::playback))
        .route(
            "/api/v1/playback-requests/{key}",
            delete(playback_requests::cancel),
        )
        .route(
            "/api/v1/playback-sessions/{id}",
            get(media::readiness).delete(media::stop).post(media::renew),
        )
        .route(
            "/api/v1/playback-sessions/{id}/observations",
            post(playback_observations::observe),
        )
        .route(
            "/api/v1/playback-sessions/{id}/metrics",
            post(playback_metrics::endpoint).layer(axum::extract::DefaultBodyLimit::max(4096)),
        )
        .route("/api/v1/agents", get(agents::list).post(agents::create))
        .route("/api/v1/agents/pair", post(agents::pair))
        .route("/api/v1/agents/{id}", delete(agents::revoke))
        .route("/api/v1/agents/{id}/scan", post(agents::scan))
        .route("/api/v1/agents/ws", get(agents::connect))
        .route("/api/v1/ws", get(ws))
        .route("/api/v1/metrics", get(metrics::endpoint))
        .layer(axum::extract::DefaultBodyLimit::max(65536))
        .layer(axum::middleware::from_fn(http_api::errors))
        .route("/ready", get(health::endpoint))
        .with_state(app);
    let listener =
        tokio::net::TcpListener::bind(std::env::var("BIND").unwrap_or("0.0.0.0:8080".into()))
            .await?;
    readiness.accepting(true);
    tracing::info!("RainSync server ready");
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = stopped.await;
    })
    .into_future();
    tokio::pin!(server);
    let server_result = tokio::select! {
        result = &mut server => result,
        signal = media_core::process_signal::wait() => {
            readiness.accepting(false);
            preparations.close();
            upstream.close_admission();
            let _ = stop.send(());
            // A stalled request or long-lived connection cannot delay process
            // shutdown indefinitely. Keep the instance lock throughout draining.
            let grace = signal.as_ref().map_or(std::time::Duration::ZERO, |reason| reason.http_grace());
            let result = tokio::time::timeout(grace, &mut server)
                .await.unwrap_or(Ok(()));
            signal.map(|_| ()).and(result)
        },
    };
    readiness.accepting(false);
    // Fence late HTTP admission and retain the application runtime through
    // reservation commits, scoped resource disposal and durable receipt retries.
    // Instance-lock loss intentionally skips this barrier and remains unknown.
    upstream.close_admission();
    let (_, upstream_result) = tokio::join!(preparations.drain(), upstream.drain());
    // Also drain after listener failure: cancelling a request does not itself
    // wait for the independent ffprobe process owner to reap its descendants.
    media_core::child_process::shutdown().await?;
    upstream_result?;
    server_result?;
    Ok(())
}
