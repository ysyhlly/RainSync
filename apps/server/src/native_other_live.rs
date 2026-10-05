//! Dedicated rolling live-edge grants. Finite VOD/static-HLS never admits these
//! identities. Credentials and provider addresses remain server-only; replay
//! cannot extend the immutable two-minute grant or switch its broadcast.
use crate::*;
use providers::platform::other_live as live;
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
pub use delivery::{playlist, segment};
pub(crate) use import::{dto, import_one};
pub(crate) use prepare::{is_live_request, prepare};

const MAX_ACTIVE_GRANTS: usize = 64;
const MAX_GRANT_MS: i64 = 120_000;
const EXPIRY_MARGIN_MS: i64 = 5_000;
const GATE: &str = "p.id=$1 AND p.delivery_token_hash=$2 AND p.auth_login_hash=$3 AND p.user_id=$4 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.viewer_id IS NOT NULL AND p.plan_generation IS NOT NULL AND p.resource->'native_platform_context'->'version'='5'::jsonb AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND s.state->>'media_id'=p.media_id::text AND (s.state->>'media_generation')::bigint=p.generation AND playback_source_allowed(p.media_id,p.resource,p.id) AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id) AND EXISTS(SELECT 1 FROM playback_viewer_plans g WHERE g.user_id=p.user_id AND g.room_id=p.room_id AND g.viewer_id=p.viewer_id AND g.plan_generation=p.plan_generation AND g.auth_login_hash=p.auth_login_hash)";

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Identity {
    OtherLive {
        provider: String,
        resource_id: String,
        broadcaster_id: String,
        started_at: u64,
        broadcast_id: String,
        canonical_url: String,
    },
}
impl Identity {
    fn from_metadata(m: &live::Metadata) -> Self {
        Self::OtherLive {
            provider: m.provider.as_str().into(),
            resource_id: m.resource_id.clone(),
            broadcaster_id: m.broadcaster_id.clone(),
            started_at: m.started_at,
            broadcast_id: m.broadcast_id.clone(),
            canonical_url: m.canonical(),
        }
    }
    fn provider_str(&self) -> &str {
        let Self::OtherLive { provider, .. } = self;
        provider
    }
    fn provider(&self) -> Result<live::Provider> {
        live::Provider::parse(self.provider_str()).map_err(provider_error)
    }
    fn protocol_provider(&self) -> protocol::NativePlatformProvider {
        match self.provider_str() {
            "youtube" => protocol::NativePlatformProvider::Youtube,
            "douyin" => protocol::NativePlatformProvider::Douyin,
            _ => protocol::NativePlatformProvider::Tiktok,
        }
    }
    fn room_id(&self) -> &str {
        let Self::OtherLive { resource_id, .. } = self;
        resource_id
    }
    fn uid(&self) -> &str {
        let Self::OtherLive { broadcaster_id, .. } = self;
        broadcaster_id
    }
    fn started_at(&self) -> u64 {
        let Self::OtherLive { started_at, .. } = self;
        *started_at
    }
    fn broadcast_id(&self) -> &str {
        let Self::OtherLive { broadcast_id, .. } = self;
        broadcast_id
    }
    fn canonical(&self) -> String {
        let Self::OtherLive { canonical_url, .. } = self;
        canonical_url.clone()
    }
    fn selector(&self) -> Result<live::Resource> {
        live::parse_resource(self.provider()?, &self.canonical()).map_err(provider_error)
    }
    fn validate(&self) -> bool {
        self.provider()
            .and_then(|provider| {
                live::Metadata {
                    provider,
                    resource: self.selector()?,
                    resource_id: self.room_id().into(),
                    broadcaster_id: self.uid().into(),
                    started_at: self.started_at(),
                    broadcast_id: self.broadcast_id().into(),
                    title: "live".into(),
                }
                .validate()
                .map_err(provider_error)
            })
            .is_ok()
    }
    fn content_id(&self) -> String {
        format!("live:{}:{}", self.provider_str(), self.broadcast_id())
    }
}
fn identity_from_row(row: &PgRow) -> Result<Identity> {
    let identity = Identity::OtherLive {
        provider: row.get("provider"),
        resource_id: row
            .get::<Option<String>, _>("live_room_id")
            .ok_or_else(invalid)?,
        broadcaster_id: row
            .get::<Option<String>, _>("live_uid")
            .ok_or_else(invalid)?,
        started_at: row
            .get::<Option<i64>, _>("live_started_at")
            .and_then(|v| u64::try_from(v).ok())
            .ok_or_else(invalid)?,
        broadcast_id: row
            .get::<Option<String>, _>("live_broadcast_id")
            .ok_or_else(invalid)?,
        canonical_url: row
            .get::<Option<String>, _>("canonical_url")
            .ok_or_else(invalid)?,
    };
    let selector: live::Resource = serde_json::from_value(
        row.get::<Option<Value>, _>("live_resource")
            .ok_or_else(invalid)?,
    )
    .map_err(|_| invalid())?;
    if !identity.validate() || identity.selector()? != selector {
        return Err(invalid());
    }
    Ok(identity)
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
        self.version == 5
            && self.provider == self.resource.provider_str()
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
}
impl Sealed {
    fn deadline(&self) -> Result<i64> {
        if self.kind != "native_other_live"
            || self.version != 1
            || !self.binding.validate()
            || !self.scope.valid()
            || self.resolved_at_ms <= 0
            || self
                .binding
                .resource
                .provider()
                .and_then(|p| {
                    live::validate_playlist_url(p, &self.playlist_url).map_err(provider_error)
                })
                .is_err()
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
        E::Restricted(
            "other_live_youtube_configured_extractor_required"
            | "other_live_extractor_cleanup_required",
        ) => err(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_other_live_provider_unavailable",
        ),
        E::Restricted("other_live_user_handoff_required") => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_other_live_user_handoff_required",
        ),
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
    let row=sqlx::query("SELECT e.provider,e.live_room_id,e.live_uid,e.live_broadcast_id,e.live_started_at,e.live_resource,e.content_id,e.canonical_url,e.revision,e.duration_ms,e.part FROM room_platform_media e JOIN media_items m ON m.id=e.media_id WHERE e.room_id=$1 AND e.media_id=$2 AND e.resource_kind='other_live' AND e.provider IN ('youtube','douyin','tiktok') AND m.available FOR SHARE OF e,m").bind(room).bind(media).fetch_optional(&mut **tx).await?.ok_or_else(invalid)?;
    let identity = identity_from_row(&row)?;
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
async fn observe(app: &App, m: &live::Metadata) -> Result<()> {
    m.validate().map_err(provider_error)?;
    let changed=sqlx::query("INSERT INTO other_live_broadcasts(provider,canonical_url,resource_id,broadcaster_id,broadcast_id,last_started_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider,canonical_url) DO UPDATE SET resource_id=EXCLUDED.resource_id,broadcaster_id=EXCLUDED.broadcaster_id,broadcast_id=EXCLUDED.broadcast_id,last_started_at=EXCLUDED.last_started_at,observed_at=clock_timestamp() WHERE EXCLUDED.last_started_at>other_live_broadcasts.last_started_at OR (EXCLUDED.last_started_at=other_live_broadcasts.last_started_at AND other_live_broadcasts.broadcast_id=EXCLUDED.broadcast_id AND other_live_broadcasts.resource_id=EXCLUDED.resource_id AND other_live_broadcasts.broadcaster_id=EXCLUDED.broadcaster_id)").bind(m.provider.as_str()).bind(m.canonical()).bind(&m.resource_id).bind(&m.broadcaster_id).bind(&m.broadcast_id).bind(i64::try_from(m.started_at).map_err(|_|invalid())?).execute(&app.db).await?;
    if changed.rows_affected() != 1 {
        return Err(err(StatusCode::CONFLICT, "native_live_broadcast_changed"));
    }
    Ok(())
}
async fn revoke_offline(app: &App, identity: &Identity) -> Result<()> {
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE other_live_broadcasts SET broadcast_id=NULL,observed_at=clock_timestamp() WHERE provider=$1 AND canonical_url=$2 AND broadcast_id=$3").bind(identity.provider_str()).bind(identity.canonical()).bind(identity.broadcast_id()).execute(&mut *tx).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE NOT stopped AND resource->'native_platform_context'->'version'='5'::jsonb AND resource->'native_platform_context'->'resource'->>'provider'=$1 AND resource->'native_platform_context'->'resource'->>'broadcast_id'=$2").bind(identity.provider_str()).bind(identity.broadcast_id()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
async fn resolve(
    app: &App,
    reference: &live::Resource,
    account: &platform_accounts::FrozenAccount,
    deadline: Instant,
) -> Result<live::Resolved> {
    if account.provider_name() != reference.provider().as_str() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    if !app.other_live_enabled {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_other_live_provider_unavailable",
        ));
    }
    if reference.provider() == live::Provider::YouTube {
        return app
            .youtube
            .resolve_live(reference, account.youtube_cookie(), deadline)
            .await
            .map_err(provider_error);
    }
    live::Client::new(app.platform_http, account.short_cookie().cloned())
        .resolve(reference, deadline)
        .await
        .map_err(provider_error)
}
async fn bound_resolve(
    app: &App,
    identity: &Identity,
    account: &platform_accounts::FrozenAccount,
    deadline: Instant,
) -> Result<live::Resolved> {
    let resolved = match resolve(app, &identity.selector()?, account, deadline).await {
        Ok(r) => r,
        Err(error) if error.1 == "native_live_not_broadcasting" => {
            revoke_offline(app, identity).await?;
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    resolved.validate().map_err(provider_error)?;
    // A same-epoch owner/resource rebind is terminal for the old grant. It
    // cannot overwrite the high-water row or leave old queued tails authorized.
    if resolved.metadata.started_at == identity.started_at()
        && Identity::from_metadata(&resolved.metadata) != *identity
    {
        revoke_offline(app, identity).await?;
        return Err(err(StatusCode::CONFLICT, "native_live_broadcast_changed"));
    }
    observe(app, &resolved.metadata).await?;
    if Identity::from_metadata(&resolved.metadata) != *identity {
        return Err(err(StatusCode::CONFLICT, "native_live_broadcast_changed"));
    }
    Ok(resolved)
}
fn playlist_target<'a>(sealed: &'a Sealed, current: &'a live::Resolved) -> Result<&'a str> {
    current.validate().map_err(provider_error)?;
    if Identity::from_metadata(&current.metadata) != sealed.binding.resource {
        return Err(invalid());
    }
    // Google signatures live in path components. Keep the exact original
    // root for this immutable short grant instead of weakening edge identity
    // by stripping signed path components or extending the root's deadline.
    if current.metadata.provider == live::Provider::YouTube {
        Ok(&sealed.playlist_url)
    } else {
        Ok(&current.playlist_url)
    }
}
async fn parse_bound_playlist(
    app: &App,
    identity: &Identity,
    bytes: &[u8],
    upstream: &str,
) -> Result<live::Playlist> {
    match live::parse_playlist(identity.provider()?, bytes, upstream) {
        Ok(p) => Ok(p),
        Err(error @ providers::platform::bilibili::Error::Restricted("live_broadcast_ended")) => {
            revoke_offline(app, identity).await?;
            Err(provider_error(error))
        }
        Err(error) => Err(provider_error(error)),
    }
}
async fn verify_broadcast(
    app: &App,
    identity: &Identity,
    account: &platform_accounts::FrozenAccount,
    deadline: Instant,
) -> Result<()> {
    bound_resolve(app, identity, account, deadline)
        .await
        .map(|_| ())
}
async fn account_for(
    app: &App,
    user: Uuid,
    binding: &Binding,
) -> Result<platform_accounts::FrozenAccount> {
    if binding.provider != binding.resource.provider_str() {
        return Err(invalid());
    }
    let account = if binding.credential_mode == "own_account" {
        platform_accounts::load_for_provider_playback(app, user, binding.resource.provider_str())
            .await?
    } else {
        platform_accounts::FrozenAccount::anonymous_for_provider(
            user,
            binding.resource.provider_str(),
        )?
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
