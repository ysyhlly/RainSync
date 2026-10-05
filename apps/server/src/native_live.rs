//! Dedicated rolling live-edge grants. Finite VOD/static-HLS never admits these
//! identities. Credentials and provider addresses remain server-only; replay
//! cannot extend the immutable two-minute grant or switch its broadcast.
use crate::*;
use providers::platform::bilibili::live;
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgRow;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::{
    sync::{Mutex as AsyncMutex, Semaphore},
    time::{Duration, Instant},
};

mod delivery;
mod import;
mod prepare;
mod producer;
mod text;
pub use delivery::{playlist, segment};
pub(crate) use import::{dto, import_one};
pub(crate) use prepare::{is_live_request, prepare};
pub use text::{catalog as text_catalog, history as text_history, realtime as text_realtime};

const MAX_ACTIVE_GRANTS: usize = 64;
const MAX_GRANT_MS: i64 = 120_000;
const EXPIRY_MARGIN_MS: i64 = 5_000;
const GATE: &str = "p.id=$1 AND p.delivery_token_hash=$2 AND p.auth_login_hash=$3 AND p.user_id=$4 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.viewer_id IS NOT NULL AND p.plan_generation IS NOT NULL AND p.resource->'native_platform_context'->'version'='3'::jsonb AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND s.state->>'media_id'=p.media_id::text AND (s.state->>'media_generation')::bigint=p.generation AND playback_source_allowed(p.media_id,p.resource,p.id) AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id) AND EXISTS(SELECT 1 FROM playback_viewer_plans g WHERE g.user_id=p.user_id AND g.room_id=p.room_id AND g.viewer_id=p.viewer_id AND g.plan_generation=p.plan_generation AND g.auth_login_hash=p.auth_login_hash)";

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Identity {
    BilibiliLive {
        room_id: String,
        uid: String,
        broadcast_id: String,
    },
}
impl Identity {
    fn from_metadata(metadata: &live::Metadata) -> Self {
        Self::BilibiliLive {
            room_id: metadata.room_id.clone(),
            uid: metadata.uid.clone(),
            broadcast_id: metadata.broadcast_id.clone(),
        }
    }
    fn room_id(&self) -> &str {
        let Self::BilibiliLive { room_id, .. } = self;
        room_id
    }
    fn uid(&self) -> &str {
        let Self::BilibiliLive { uid, .. } = self;
        uid
    }
    fn broadcast_id(&self) -> &str {
        let Self::BilibiliLive { broadcast_id, .. } = self;
        broadcast_id
    }
    fn canonical(&self) -> String {
        live::RoomRef {
            room_id: self.room_id().into(),
        }
        .canonical()
    }
    fn validate(&self) -> bool {
        let started = self
            .broadcast_id()
            .rsplit(':')
            .next()
            .and_then(|value| value.parse::<u64>().ok());
        started.is_some_and(|started_at| {
            live::Metadata {
                room_id: self.room_id().into(),
                uid: self.uid().into(),
                started_at,
                broadcast_id: self.broadcast_id().into(),
                title: "live".into(),
            }
            .validate()
            .is_ok()
        })
    }
    fn content_id(&self) -> String {
        format!("live:{}:{}", self.room_id(), self.broadcast_id())
    }
}
#[derive(Clone)]
struct Entry {
    media: Uuid,
    room: Uuid,
    revision: i64,
    identity: Identity,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Binding {
    version: u32,
    provider: String,
    media_id: Uuid,
    room_id: Uuid,
    user_id: Uuid,
    entry_revision: String,
    credential_mode: String,
    account_id: Option<Uuid>,
    account_revision: Option<String>,
    resource: Identity,
}
impl Binding {
    fn validate(&self) -> bool {
        self.version == 3
            && self.provider == "bilibili"
            && positive(&self.entry_revision)
            && self.resource.validate()
            && match self.credential_mode.as_str() {
                "anonymous" => self.account_id.is_none() && self.account_revision.is_none(),
                "own_account" => {
                    self.account_id.is_some()
                        && self.account_revision.as_deref().is_some_and(positive)
                }
                _ => false,
            }
    }
    fn matches(&self, entry: &Entry) -> bool {
        self.validate()
            && self.media_id == entry.media
            && self.room_id == entry.room
            && self.entry_revision == entry.revision.to_string()
            && self.resource == entry.identity
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct GrantScope {
    session_id: Uuid,
    viewer_id: Uuid,
    plan_generation: u32,
    media_generation: u32,
    auth_login_hash: String,
    lifecycle_epoch: i64,
}
impl GrantScope {
    fn valid(&self) -> bool {
        self.plan_generation > 0
            && self.lifecycle_epoch >= 0
            && delivery::hex64(&self.auth_login_hash)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sealed {
    kind: String,
    version: u32,
    binding: Binding,
    scope: GrantScope,
    resolved_at_ms: i64,
    url_expires_at_ms: Option<i64>,
    playlist_url: String,
    current_quality: u32,
}
impl Sealed {
    fn deadline(&self) -> Result<i64> {
        if self.kind != "native_live"
            || self.version != 1
            || !self.binding.validate()
            || !self.scope.valid()
            || self.resolved_at_ms <= 0
            || !matches!(self.current_quality, 80 | 150)
            || live::validate_playlist_url(&self.playlist_url).is_err()
        {
            return Err(invalid());
        }
        policy_deadline(self.resolved_at_ms, self.url_expires_at_ms)
    }
}
fn policy_deadline(resolved: i64, url_expiry: Option<i64>) -> Result<i64> {
    let deadline = resolved.checked_add(MAX_GRANT_MS).ok_or_else(invalid)?;
    let deadline = if let Some(expiry) = url_expiry {
        deadline.min(expiry.checked_sub(EXPIRY_MARGIN_MS).ok_or_else(invalid)?)
    } else {
        deadline
    };
    if resolved <= 0 || deadline <= resolved {
        return Err(invalid());
    }
    Ok(deadline)
}
fn positive(value: &str) -> bool {
    !value.starts_with('0')
        && value.bytes().all(|v| v.is_ascii_digit())
        && value.parse::<i64>().is_ok_and(|v| v > 0)
}
fn invalid() -> Error {
    err(StatusCode::GONE, "invalid_playback_session")
}
fn now_ms() -> Result<i64> {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(anyhow::Error::from)?
            .as_millis(),
    )
    .map_err(|_| invalid())
}
fn provider_error(error: providers::platform::bilibili::Error) -> Error {
    use providers::platform::bilibili::Error as E;
    match error {
        E::Restricted("live_window_expired") => {
            err(StatusCode::CONFLICT, "native_live_window_expired")
        }
        E::Restricted("live_broadcast_changed") => {
            err(StatusCode::CONFLICT, "native_live_broadcast_changed")
        }
        E::Restricted("live_not_broadcasting" | "live_broadcast_ended") => {
            err(StatusCode::GONE, "native_live_not_broadcasting")
        }
        other => platform_media::provider_error(other),
    }
}
async fn capture(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    room: Uuid,
    generation: u32,
) -> Result<Entry> {
    let state: Value = sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1")
        .bind(room)
        .fetch_one(&mut **tx)
        .await?;
    if state["media_generation"].as_u64() != Some(u64::from(generation)) {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    let media = state["media_id"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "no_media"))?;
    let row=sqlx::query("SELECT e.live_room_id,e.live_uid,e.live_broadcast_id,e.content_id,e.canonical_url,e.revision,e.duration_ms,e.part FROM room_platform_media e JOIN media_items m ON m.id=e.media_id WHERE e.room_id=$1 AND e.media_id=$2 AND e.resource_kind='live' AND e.provider='bilibili' AND m.available FOR SHARE OF e,m").bind(room).bind(media).fetch_optional(&mut **tx).await?.ok_or_else(invalid)?;
    let identity = Identity::BilibiliLive {
        room_id: row
            .get::<Option<String>, _>("live_room_id")
            .ok_or_else(invalid)?,
        uid: row
            .get::<Option<String>, _>("live_uid")
            .ok_or_else(invalid)?,
        broadcast_id: row
            .get::<Option<String>, _>("live_broadcast_id")
            .ok_or_else(invalid)?,
    };
    if !identity.validate()
        || row.get::<String, _>("content_id") != identity.content_id()
        || row.get::<Option<String>, _>("canonical_url").as_deref()
            != Some(identity.canonical().as_str())
        || row.get::<Option<f64>, _>("duration_ms").is_some()
        || row.get::<i32, _>("part") != 1
    {
        return Err(invalid());
    }
    Ok(Entry {
        media,
        room,
        revision: row.get("revision"),
        identity,
    })
}
async fn guard(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    entry: &Entry,
    generation: u32,
) -> Result<()> {
    let current = capture(tx, entry.room, generation).await?;
    if current.media != entry.media
        || current.revision != entry.revision
        || current.identity != entry.identity
    {
        return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
    }
    Ok(())
}
// Verified public provider observations are a revocation fence, never a mutable
// media identity. A restart still needs a fresh explicitly selected media row.
async fn observe(app: &App, metadata: &live::Metadata) -> Result<()> {
    metadata.validate().map_err(provider_error)?;
    sqlx::query("INSERT INTO bilibili_live_broadcasts(room_id,uid,broadcast_id,last_started_at) VALUES($1,$2,$3,$4) ON CONFLICT(room_id) DO UPDATE SET uid=EXCLUDED.uid,broadcast_id=EXCLUDED.broadcast_id,last_started_at=EXCLUDED.last_started_at,observed_at=clock_timestamp() WHERE EXCLUDED.last_started_at>=bilibili_live_broadcasts.last_started_at")
        .bind(&metadata.room_id)
        .bind(&metadata.uid)
        .bind(&metadata.broadcast_id)
        .bind(i64::try_from(metadata.started_at).map_err(|_|invalid())?)
        .execute(&app.db).await?;
    Ok(())
}
fn offline_scope(identity: &Identity) -> Result<(&str, &str, &str)> {
    if !identity.validate() {
        return Err(invalid());
    }
    Ok((identity.room_id(), identity.uid(), identity.broadcast_id()))
}
async fn revoke_offline(app: &App, identity: &Identity) -> Result<()> {
    let (room_id, uid, broadcast_id) = offline_scope(identity)?;
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE bilibili_live_broadcasts SET broadcast_id=NULL,observed_at=clock_timestamp() WHERE room_id=$1 AND uid=$2 AND broadcast_id=$3").bind(room_id).bind(uid).bind(broadcast_id).execute(&mut *tx).await?;
    // An explicit offline observation is terminal for existing grants. A stale
    // later observation can never resurrect a previously stopped capability.
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE NOT stopped AND resource->'native_platform_context'->'version'='3'::jsonb AND resource->'native_platform_context'->'resource'->>'broadcast_id'=$1").bind(broadcast_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
fn terminal_playlist_error(error: &providers::platform::bilibili::Error) -> bool {
    matches!(
        error,
        providers::platform::bilibili::Error::Restricted("live_broadcast_ended")
    )
}
async fn parse_bound_playlist(
    app: &App,
    identity: &Identity,
    bytes: &[u8],
    upstream: &str,
) -> Result<live::Playlist> {
    offline_scope(identity)?;
    match live::parse_playlist(bytes, upstream) {
        Ok(playlist) => Ok(playlist),
        Err(error) if terminal_playlist_error(&error) => {
            // Exact room/owner/broadcast predicates prevent a delayed old
            // terminal response from clearing a newer high-water observation.
            revoke_offline(app, identity).await?;
            Err(provider_error(error))
        }
        Err(error) => Err(provider_error(error)),
    }
}
async fn bound_resolve(
    app: &App,
    identity: &Identity,
    account: &platform_accounts::FrozenAccount,
    deadline: Instant,
) -> Result<live::Resolved> {
    let client = live::Client::new(app.platform_http, account.cookie().cloned());
    let metadata = match client
        .view(
            &live::RoomRef {
                room_id: identity.room_id().into(),
            },
            deadline,
        )
        .await
    {
        Ok(value) => value,
        Err(error @ providers::platform::bilibili::Error::Restricted("live_not_broadcasting")) => {
            revoke_offline(app, identity).await?;
            return Err(provider_error(error));
        }
        Err(error) => return Err(provider_error(error)),
    };
    observe(app, &metadata).await?;
    if Identity::from_metadata(&metadata) != *identity {
        return Err(err(StatusCode::CONFLICT, "native_live_broadcast_changed"));
    }
    let resolved = client
        .resolve_metadata(&metadata, deadline)
        .await
        .map_err(provider_error)?;
    if Identity::from_metadata(&resolved.metadata) != *identity {
        return Err(err(StatusCode::CONFLICT, "native_live_broadcast_changed"));
    }
    Ok(resolved)
}
async fn verify_broadcast(
    app: &App,
    identity: &Identity,
    account: &platform_accounts::FrozenAccount,
    deadline: Instant,
) -> Result<()> {
    let metadata = match live::Client::new(app.platform_http, account.cookie().cloned())
        .view(
            &live::RoomRef {
                room_id: identity.room_id().into(),
            },
            deadline,
        )
        .await
    {
        Ok(value) => value,
        Err(error @ providers::platform::bilibili::Error::Restricted("live_not_broadcasting")) => {
            revoke_offline(app, identity).await?;
            return Err(provider_error(error));
        }
        Err(error) => return Err(provider_error(error)),
    };
    observe(app, &metadata).await?;
    if Identity::from_metadata(&metadata) != *identity {
        return Err(err(StatusCode::CONFLICT, "native_live_broadcast_changed"));
    }
    Ok(())
}
async fn account_for(
    app: &App,
    user: Uuid,
    binding: &Binding,
) -> Result<platform_accounts::FrozenAccount> {
    let account = if binding.credential_mode == "own_account" {
        platform_accounts::load_for_provider_playback(app, user, "bilibili").await?
    } else {
        platform_accounts::FrozenAccount::anonymous(user)
    };
    if account.account_id() != binding.account_id
        || account.revision().map(|v| v.to_string()) != binding.account_revision
    {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    Ok(account)
}

/// Memory is only a bounded rolling segment graph, never a DVR or durable
/// authority. Restarting the server loses the graph and the next playlist
/// reload reconstructs it under the unchanged durable grant.
#[derive(Clone)]
pub struct LiveStore {
    entries: Arc<Mutex<HashMap<Uuid, Arc<Runtime>>>>,
    bytes_slots: Arc<Semaphore>,
    deliveries: Arc<producer::Registry>,
}
impl Default for LiveStore {
    fn default() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            bytes_slots: Arc::new(Semaphore::new(8)),
            deliveries: Default::default(),
        }
    }
}
struct Runtime {
    fingerprint: String,
    expires: i64,
    window: AsyncMutex<live::RollingWindow>,
    reload: AsyncMutex<()>,
    segments: Arc<Semaphore>,
    budget: Mutex<Budget>,
    last_reload: Mutex<Option<Instant>>,
}
struct Budget {
    started: Instant,
    playlists: u32,
    segments: u32,
    bytes: u64,
    reserved: u64,
}
impl Budget {
    fn admit(&mut self, playlist: bool, now: Instant) -> bool {
        if now.duration_since(self.started) >= Duration::from_secs(60) {
            self.started = now;
            self.playlists = 0;
            self.segments = 0;
        }
        let (count, limit) = if playlist {
            (&mut self.playlists, 120)
        } else {
            (&mut self.segments, 180)
        };
        if *count >= limit {
            return false;
        }
        *count += 1;
        true
    }
}
impl LiveStore {
    pub fn close_admission(&self) {
        self.deliveries.close_admission();
    }
    pub async fn drain(&self) -> anyhow::Result<()> {
        self.deliveries.drain().await
    }
    fn runtime(&self, session: Uuid, sealed: &Sealed, expires: i64) -> Result<Arc<Runtime>> {
        let now = now_ms()?;
        let fingerprint = hash(&serde_json::to_string(sealed).map_err(anyhow::Error::from)?);
        let mut entries = self.entries.lock().map_err(|_| invalid())?;
        entries.retain(|_, value| value.expires > now);
        if sealed.scope.session_id != session || expires <= now || expires > sealed.deadline()? {
            return Err(invalid());
        }
        if let Some(existing) = entries.get(&session) {
            if existing.fingerprint != fingerprint || expires > existing.expires {
                return Err(invalid());
            }
            return Ok(existing.clone());
        }
        if entries.len() >= MAX_ACTIVE_GRANTS {
            return Err(err(StatusCode::TOO_MANY_REQUESTS, "native_live_capacity"));
        }
        let runtime = Arc::new(Runtime {
            fingerprint,
            expires,
            window: AsyncMutex::new(live::RollingWindow::default()),
            reload: AsyncMutex::new(()),
            segments: Arc::new(Semaphore::new(4)),
            budget: Mutex::new(Budget {
                started: Instant::now(),
                playlists: 0,
                segments: 0,
                bytes: 0,
                reserved: 0,
            }),
            last_reload: Mutex::new(None),
        });
        entries.insert(session, runtime.clone());
        // Expiry disposal holds only a weak store reference, so shutting down
        // the application cannot be kept alive by a cleanup timer.
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let store = Arc::downgrade(&self.entries);
            let fingerprint = runtime.fingerprint.clone();
            let delay = Duration::from_millis((expires - now) as u64);
            handle.spawn(async move {
                tokio::time::sleep(delay).await;
                if let Some(store) = store.upgrade()
                    && let Ok(mut entries) = store.lock()
                    && entries
                        .get(&session)
                        .is_some_and(|runtime| runtime.fingerprint == fingerprint)
                {
                    entries.remove(&session);
                }
            });
        }
        Ok(runtime)
    }
}
struct ByteBudget {
    runtime: Arc<Runtime>,
    committed: bool,
    fetch_started: bool,
}
impl ByteBudget {
    fn start_fetch(&mut self) {
        self.fetch_started = true;
    }
    fn commit(mut self, bytes: usize) -> Result<()> {
        if bytes > live::MAX_SEGMENT_BYTES {
            return Err(invalid());
        }
        let mut budget = self.runtime.budget.lock().map_err(|_| invalid())?;
        budget.reserved = budget
            .reserved
            .saturating_sub(live::MAX_SEGMENT_BYTES as u64);
        budget.bytes = budget.bytes.checked_add(bytes as u64).ok_or_else(invalid)?;
        self.committed = true;
        Ok(())
    }
}
impl Drop for ByteBudget {
    fn drop(&mut self) {
        if !self.committed
            && let Ok(mut budget) = self.runtime.budget.lock()
        {
            budget.reserved = budget
                .reserved
                .saturating_sub(live::MAX_SEGMENT_BYTES as u64);
            if self.fetch_started {
                budget.bytes = budget.bytes.saturating_add(live::MAX_SEGMENT_BYTES as u64);
            }
        }
    }
}
impl Runtime {
    fn reserve_bytes(self: &Arc<Self>) -> Result<ByteBudget> {
        let mut budget = self.budget.lock().map_err(|_| invalid())?;
        const MAX_BYTES: u64 = 256 * 1024 * 1024;
        if budget
            .bytes
            .saturating_add(budget.reserved)
            .saturating_add(live::MAX_SEGMENT_BYTES as u64)
            > MAX_BYTES
        {
            return Err(err(StatusCode::TOO_MANY_REQUESTS, "native_live_capacity"));
        }
        budget.reserved += live::MAX_SEGMENT_BYTES as u64;
        Ok(ByteBudget {
            runtime: self.clone(),
            committed: false,
            fetch_started: false,
        })
    }
    fn admit(&self, playlist: bool) -> Result<()> {
        if self.expires <= now_ms()? {
            return Err(invalid());
        }
        if !self
            .budget
            .lock()
            .map_err(|_| invalid())?
            .admit(playlist, Instant::now())
        {
            return Err(err(
                StatusCode::TOO_MANY_REQUESTS,
                "native_live_rate_limited",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
