//! Source-bound account observations, owned by the single authoritative server.
//! Observation rows fence authorization; retiring a grant is not a drain ACK.
use super::{App, Result, err};
use axum::http::StatusCode;
use persistence::media_job_timing::{CancellationScope, cancel_jobs};
use providers::account_policy::{UpstreamAccountPolicy, upstream_account_policy};
use sqlx::{Connection, PgPool, Postgres, Row, Transaction, pool::PoolConnection};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Notify, OwnedSemaphorePermit, Semaphore},
    time::Instant,
};
use uuid::Uuid;

const POSITIVE_TTL: Duration = Duration::from_secs(5);
const INITIAL_WAIT: Duration = Duration::from_secs(3);
const DATABASE_BUDGET: Duration = Duration::from_millis(500);
const MAX_POLLS: usize = 8;
const MAX_TRACKED_SOURCES: usize = 1024;

#[derive(Clone, Copy)]
struct Positive {
    revision: i64,
    generation: i64,
    observation_seq: i64,
    deadline: Instant,
}

pub struct Runtime {
    permits: Arc<Semaphore>,
    active: Mutex<HashSet<Uuid>>,
    positives: Mutex<HashMap<Uuid, Positive>>,
    changed: Notify,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            permits: Arc::new(Semaphore::new(MAX_POLLS)),
            active: Mutex::new(HashSet::new()),
            positives: Mutex::new(HashMap::new()),
            changed: Notify::new(),
        }
    }
}

struct PollOwner {
    runtime: Arc<Runtime>,
    source: Uuid,
    _permit: OwnedSemaphorePermit,
}

impl Drop for PollOwner {
    fn drop(&mut self) {
        self.runtime
            .active
            .lock()
            .expect("policy polls")
            .remove(&self.source);
        self.runtime.changed.notify_waiters();
    }
}

impl Runtime {
    fn admit(self: &Arc<Self>, source: Uuid) -> Option<PollOwner> {
        let permit = self.permits.clone().try_acquire_owned().ok()?;
        let mut active = self.active.lock().expect("policy polls");
        if active.contains(&source) {
            return None;
        }
        let positives = self.positives.lock().expect("policy positives");
        let tracked = positives.len()
            + active
                .iter()
                .filter(|id| !positives.contains_key(id))
                .count();
        if !positives.contains_key(&source) && tracked >= MAX_TRACKED_SOURCES {
            // Keep expiry evidence until its durable invalidation succeeds.
            // New sources stay unavailable instead of growing an unbounded map.
            return None;
        }
        active.insert(source);
        Some(PollOwner {
            runtime: self.clone(),
            source,
            _permit: permit,
        })
    }

    fn positive(&self, source: Uuid, revision: i64, generation: i64) -> bool {
        self.positives
            .lock()
            .expect("policy positives")
            .get(&source)
            .is_some_and(|value| {
                value.revision == revision
                    && value.generation == generation
                    && value.deadline > Instant::now()
            })
    }

    fn pending_invalidation(&self, source: Uuid, revision: i64) -> Option<(i64, i64)> {
        self.positives
            .lock()
            .expect("policy positives")
            .get(&source)
            .filter(|value| value.revision == revision && value.deadline <= Instant::now())
            .map(|value| (value.generation, value.observation_seq))
    }
}

// Cancellation closes the socket rather than returning a connection whose
// query may still be running to the shared pool. Acquire is inside the budget.
struct Database(Option<PoolConnection<Postgres>>);
impl Drop for Database {
    fn drop(&mut self) {
        if let Some(connection) = &mut self.0 {
            connection.close_on_drop();
        }
    }
}
impl Database {
    async fn acquire(pool: &PgPool) -> anyhow::Result<Self> {
        Ok(Self(Some(pool.acquire().await?)))
    }
    async fn transaction(&mut self) -> anyhow::Result<Transaction<'_, Postgres>> {
        let mut tx = self.0.as_mut().expect("policy connection").begin().await?;
        sqlx::query("SELECT set_config('statement_timeout','350ms',true),set_config('lock_timeout','250ms',true)")
            .execute(&mut *tx).await?;
        Ok(tx)
    }
    fn release(&mut self) {
        drop(self.0.take());
    }
}

async fn bounded<T>(future: impl Future<Output = anyhow::Result<T>>) -> anyhow::Result<T> {
    tokio::time::timeout(DATABASE_BUDGET, future)
        .await
        .map_err(|_| anyhow::anyhow!("upstream_policy_database_timeout"))?
}

fn unavailable() -> super::Error {
    err(
        StatusCode::SERVICE_UNAVAILABLE,
        "upstream_policy_unavailable",
    )
}

fn changed() -> super::Error {
    err(StatusCode::FORBIDDEN, "upstream_policy_changed")
}

/// Run after obtaining the existing instance lock, before accepting requests.
pub async fn startup(app: &App) -> anyhow::Result<()> {
    bounded(async {
        let mut db = Database::acquire(&app.db).await?;
        let mut tx = db.transaction().await?;
        sqlx::query("UPDATE source_account_policies SET generation=generation+1,state='unknown',reason='upstream_policy_unknown',observer_epoch=$1,valid_until=NULL,claim=NULL,next_check_at=clock_timestamp()")
            .bind(app.epoch).execute(&mut *tx).await?;
        tx.commit().await?;
        db.release();
        Ok(())
    }).await?;
    retire(&app.db).await
}

struct Snapshot {
    state: String,
    reason: String,
    generation: i64,
    fresh: bool,
}

async fn snapshot(
    app: &App,
    source: Uuid,
    revision: i64,
    demand: bool,
) -> anyhow::Result<Option<Snapshot>> {
    bounded(async {
        let mut db = Database::acquire(&app.db).await?;
        let mut tx = db.transaction().await?;
        // The source trigger creates/resets the row atomically with config.
        // No source lock is acquired while holding this policy row.
        if demand {
            sqlx::query("UPDATE source_account_policies a SET demand_until=clock_timestamp()+interval '30 seconds' WHERE a.source_id=$1 AND a.source_revision=$2 AND EXISTS(SELECT 1 FROM sources s WHERE s.id=a.source_id AND s.access_policy_revision=$2 AND s.kind IN('jellyfin','emby'))")
                .bind(source).bind(revision).execute(&mut *tx).await?;
        }
        let row = sqlx::query("SELECT a.state,a.reason,a.generation,COALESCE(a.valid_until>clock_timestamp() AND a.observer_epoch=$3,false) AS fresh FROM source_account_policies a JOIN sources s ON s.id=a.source_id WHERE a.source_id=$1 AND a.source_revision=$2 AND s.access_policy_revision=$2 AND s.kind IN('jellyfin','emby')")
            .bind(source).bind(revision).bind(app.epoch).fetch_optional(&mut *tx).await?;
        tx.commit().await?;
        db.release();
        Ok(row.map(|row| Snapshot { state: row.get("state"), reason: row.get("reason"), generation: row.get("generation"), fresh: row.get("fresh") }))
    }).await
}

/// Unknown or expired evidence can wait for a fresh observation without granting
/// access. Explicit negatives fail fast while their next refresh runs in background.
pub async fn ensure(app: &App, source: Uuid, revision: i64) -> Result<i64> {
    tokio::time::timeout(INITIAL_WAIT, async {
        let mut first = true;
        loop {
            let notified = app.upstream_policy.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let state = snapshot(app, source, revision, first)
                .await
                .map_err(|_| unavailable())?
                .ok_or_else(changed)?;
            first = false;
            schedule(app, source, revision);
            match state.state.as_str() {
                "allowed"
                    if state.fresh
                        && app
                            .upstream_policy
                            .positive(source, revision, state.generation) =>
                {
                    return Ok(state.generation);
                }
                "denied" => return Err(err(StatusCode::FORBIDDEN, "upstream_policy_denied")),
                "unknown" => {}
                "allowed" if !state.fresh => {}
                "unavailable" if state.reason == "upstream_policy_expired" => {}
                _ => return Err(unavailable()),
            }
            tokio::select! {
                _ = &mut notified => {},
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
            }
        }
    })
    .await
    .map_err(|_| unavailable())?
}

/// Source revision must already be locked by source_access::guard. Keep this
/// shared policy lock through publication, so invalidation and grants serialize.
pub async fn guard(
    tx: &mut Transaction<'_, Postgres>,
    source: Uuid,
    revision: i64,
    generation: Option<i64>,
) -> Result<()> {
    sqlx::query("SELECT set_config('statement_timeout','350ms',true),set_config('lock_timeout','250ms',true)")
        .execute(&mut **tx).await.map_err(|_| unavailable())?;
    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM sources WHERE id=$1 AND access_policy_revision=$2")
            .bind(source)
            .bind(revision)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|_| unavailable())?;
    let Some(kind) = kind else {
        return Err(changed());
    };
    if !matches!(kind.as_str(), "jellyfin" | "emby") {
        return Ok(());
    }
    sqlx::query("SELECT source_id FROM source_account_policies WHERE source_id=$1 AND source_revision=$2 FOR SHARE")
        .bind(source).bind(revision).fetch_optional(&mut **tx).await.map_err(|_| unavailable())?.ok_or_else(changed)?;
    // Evaluate wall-clock freshness only after the contended row lock returns.
    let row = sqlx::query("SELECT state,generation,COALESCE(valid_until>clock_timestamp(),false) AS fresh FROM source_account_policies WHERE source_id=$1 AND source_revision=$2")
        .bind(source).bind(revision).fetch_optional(&mut **tx).await.map_err(|_| unavailable())?.ok_or_else(changed)?;
    if generation != Some(row.get("generation")) {
        return Err(changed());
    }
    match row.get::<String, _>("state").as_str() {
        "allowed" if row.get::<bool, _>("fresh") => Ok(()),
        "denied" => Err(err(StatusCode::FORBIDDEN, "upstream_policy_denied")),
        _ => Err(unavailable()),
    }
}

fn schedule(app: &App, source: Uuid, revision: i64) {
    let Some(owner) = app.upstream_policy.admit(source) else {
        return;
    };
    let app = app.clone();
    tokio::spawn(async move {
        let _owner = owner;
        if poll(&app, source, revision).await.is_err() {
            // Failed publication never manufactures a positive. The expiry
            // sweep and claim lease recover even when the database is absent.
            tracing::debug!(source=%source, "upstream policy observation unavailable");
        }
    });
}

struct Claim {
    token: Uuid,
    kind: String,
    encrypted: String,
}

async fn claim(app: &App, source: Uuid, revision: i64) -> anyhow::Result<Option<Claim>> {
    bounded(async {
        let mut db = Database::acquire(&app.db).await?;
        let mut tx = db.transaction().await?;
        // Match the configuration trigger and publication lock order.
        let current: Option<Uuid> = sqlx::query_scalar("SELECT id FROM sources WHERE id=$1 AND access_policy_revision=$2 AND kind IN('jellyfin','emby') FOR SHARE")
            .bind(source).bind(revision).fetch_optional(&mut *tx).await?;
        if current.is_none() { tx.commit().await?; db.release(); return Ok(None); }
        let token = Uuid::new_v4();
        let row = sqlx::query("UPDATE source_account_policies a SET claim=$3,observer_epoch=$4,next_check_at=clock_timestamp()+interval '2 seconds' FROM sources s WHERE a.source_id=$1 AND a.source_revision=$2 AND s.id=a.source_id AND s.access_policy_revision=$2 AND s.kind IN('jellyfin','emby') AND a.next_check_at<=clock_timestamp() AND (a.claim IS NULL OR a.next_check_at<=clock_timestamp()-interval '3 seconds') RETURNING s.kind,s.config_encrypted")
            .bind(source).bind(revision).bind(token).bind(app.epoch).fetch_optional(&mut *tx).await?;
        tx.commit().await?;
        db.release();
        Ok(row.map(|row| Claim { token, kind: row.get("kind"), encrypted: row.get("config_encrypted") }))
    }).await
}

async fn poll(app: &App, source: Uuid, revision: i64) -> anyhow::Result<()> {
    let Some(claim) = claim(app, source, revision).await? else {
        return Ok(());
    };
    let config = app
        .decrypt(&claim.encrypted)
        .ok()
        .and_then(|value| serde_json::from_value::<providers::SourceConfig>(value).ok());
    // Start before invoking the reader: DNS and the complete GET consume TTL.
    let started = Instant::now();
    let (state, reason) = match config {
        Some(config) => match upstream_account_policy(&claim.kind, &config).await {
            Ok(UpstreamAccountPolicy::Allowed) => ("allowed", "upstream_policy_allowed".to_owned()),
            Ok(UpstreamAccountPolicy::Denied(_)) => ("denied", "upstream_policy_denied".to_owned()),
            Err(error) => ("unavailable", error.to_string()),
        },
        None => (
            "unavailable",
            "upstream_account_policy_invalid_configuration".to_owned(),
        ),
    };
    if state != "allowed" {
        // Stop local positive admission immediately, even if publishing the
        // negative later encounters a database outage. Retain its exact old
        // observation as retryable invalidation evidence for the expiry sweep.
        if let Some(positive) = app
            .upstream_policy
            .positives
            .lock()
            .expect("policy positives")
            .get_mut(&source)
            .filter(|positive| positive.revision == revision)
        {
            positive.deadline = Instant::now();
        }
        app.upstream_policy.changed.notify_waiters();
    }
    let published = publish(app, source, revision, claim.token, started, state, &reason).await?;
    if let Some((generation, observation_seq)) = published {
        let mut positives = app
            .upstream_policy
            .positives
            .lock()
            .expect("policy positives");
        if state == "allowed" && started.elapsed() < POSITIVE_TTL {
            positives.insert(
                source,
                Positive {
                    revision,
                    generation,
                    observation_seq,
                    deadline: started + POSITIVE_TTL,
                },
            );
        } else {
            positives.remove(&source);
        }
    }
    app.upstream_policy.changed.notify_waiters();
    // Policy locks are already released. Never invert policy->session lock
    // order against final publication, and never infer physical cleanup here.
    if published.is_some() {
        retire(&app.db).await?;
    }
    Ok(())
}

async fn publish(
    app: &App,
    source: Uuid,
    revision: i64,
    claim: Uuid,
    started: Instant,
    state: &str,
    reason: &str,
) -> anyhow::Result<Option<(i64, i64)>> {
    bounded(async {
        let mut db = Database::acquire(&app.db).await?;
        let mut tx = db.transaction().await?;
        let current: Option<Uuid> = sqlx::query_scalar("SELECT id FROM sources WHERE id=$1 AND access_policy_revision=$2 AND kind IN('jellyfin','emby') FOR SHARE")
            .bind(source).bind(revision).fetch_optional(&mut *tx).await?;
        if current.is_none() { tx.commit().await?; db.release(); return Ok(None); }
        let ours: Option<Uuid> = sqlx::query_scalar("SELECT source_id FROM source_account_policies WHERE source_id=$1 AND source_revision=$2 AND claim=$3 AND observer_epoch=$4 FOR UPDATE")
            .bind(source).bind(revision).bind(claim).bind(app.epoch).fetch_optional(&mut *tx).await?;
        if ours.is_none() { tx.commit().await?; db.release(); return Ok(None); }
        // A known negative may have failed to reach the database. A later
        // positive must still fence grants from that exact old observation;
        // it cannot treat an unexpired durable allow as continuous authority.
        let pending = app.upstream_policy.pending_invalidation(source, revision);
        // Both authority locks are held before evaluating old freshness.
        // Add only the monotonic remaining budget to this earlier DB anchor,
        // so response time and query transit cannot renew the observation.
        let anchor: String = sqlx::query_scalar("SELECT clock_timestamp()::text").fetch_one(&mut *tx).await?;
        let remaining = POSITIVE_TTL.saturating_sub(started.elapsed());
        let state = if state == "allowed" && remaining.is_zero() { "unavailable" } else { state };
        let reason = if state == "unavailable" && remaining.is_zero() { "upstream_policy_expired" } else { reason };
        let published = sqlx::query_as("UPDATE source_account_policies a SET generation=generation+CASE WHEN state='allowed' AND ($5::text<>'allowed' OR valid_until<=clock_timestamp() OR (generation=$9::bigint AND observation_seq=$10::bigint)) THEN 1 ELSE 0 END,state=$5,reason=$6,valid_until=CASE WHEN $5::text='allowed' THEN $7::timestamptz+make_interval(secs=>$8::double precision) ELSE NULL END,observed_at=$7::timestamptz,observation_seq=observation_seq+1,claim=NULL WHERE a.source_id=$1 AND a.source_revision=$2 AND a.claim=$3 AND a.observer_epoch=$4 AND EXISTS(SELECT 1 FROM sources s WHERE s.id=a.source_id AND s.access_policy_revision=$2 AND s.kind IN('jellyfin','emby')) RETURNING generation,observation_seq")
            .bind(source).bind(revision).bind(claim).bind(app.epoch).bind(state).bind(reason).bind(anchor).bind(remaining.as_secs_f64())
            .bind(pending.map(|value| value.0)).bind(pending.map(|value| value.1))
            .fetch_optional(&mut *tx).await?;
        tx.commit().await?;
        db.release();
        Ok(published)
    }).await
}

async fn expire(app: &App) -> anyhow::Result<bool> {
    let expired: Vec<(Uuid, Positive)> = app
        .upstream_policy
        .positives
        .lock()
        .expect("policy positives")
        .iter()
        .filter(|(_, value)| value.deadline <= Instant::now())
        .map(|(id, value)| (*id, *value))
        .collect();
    let sources: Vec<_> = expired.iter().map(|(id, _)| *id).collect();
    let generations: Vec<_> = expired.iter().map(|(_, value)| value.generation).collect();
    let observations: Vec<_> = expired
        .iter()
        .map(|(_, value)| value.observation_seq)
        .collect();
    let changed = bounded(async {
        let mut db = Database::acquire(&app.db).await?;
        let mut tx = db.transaction().await?;
        let result = sqlx::query("UPDATE source_account_policies a SET generation=generation+1,state='unavailable',reason='upstream_policy_expired',valid_until=NULL WHERE state='allowed' AND (valid_until<=clock_timestamp() OR observer_epoch IS DISTINCT FROM $1 OR EXISTS(SELECT 1 FROM unnest($2::uuid[],$3::bigint[],$4::bigint[]) AS expired(source,generation,observation) WHERE expired.source=a.source_id AND expired.generation=a.generation AND expired.observation=a.observation_seq))")
            .bind(app.epoch).bind(sources).bind(generations).bind(observations).execute(&mut *tx).await?;
        tx.commit().await?;
        db.release();
        Ok(result.rows_affected() != 0)
    }).await?;
    // Do not discard monotonic expiration evidence until its durable write
    // succeeds. A concurrent newer positive survives this cleanup.
    app.upstream_policy
        .positives
        .lock()
        .expect("policy positives")
        .retain(|id, value| {
            !expired.iter().any(|(expired_id, expired_value)| {
                id == expired_id
                    && value.generation == expired_value.generation
                    && value.observation_seq == expired_value.observation_seq
            })
        });
    if changed {
        app.upstream_policy.changed.notify_waiters();
    }
    Ok(changed)
}

async fn retire(pool: &PgPool) -> anyhow::Result<()> {
    bounded(async {
        let mut db = Database::acquire(pool).await?;
        let mut tx = db.transaction().await?;
        sqlx::query("UPDATE playback_sessions p SET stopped=true FROM media_items m JOIN sources s ON s.id=m.source_id WHERE p.media_id=m.id AND NOT p.stopped AND ((p.auth_login_hash IS NOT NULL AND NOT playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)) OR (s.kind IN('jellyfin','emby') AND NOT playback_source_allowed(p.media_id,p.resource)))")
            .execute(&mut *tx).await?;
        let job_health = cancel_jobs(&mut *tx, CancellationScope::StoppedSessions).await?;
        sqlx::query("UPDATE upstream_reservations u SET state='closing',close_reason=COALESCE(close_reason,CASE WHEN EXISTS(SELECT 1 FROM sources s WHERE s.id=u.source_id AND s.access_policy_revision=u.source_policy_revision) THEN 'upstream_policy_changed' ELSE 'source_changed' END),cleanup_after=COALESCE(cleanup_after,clock_timestamp()),cleanup_deadline=COALESCE(cleanup_deadline,clock_timestamp()+interval '60 seconds'),updated_at=clock_timestamp() WHERE u.state IN('preparing','active') AND (NOT playback_origin_allowed(u.user_id,u.room_id,u.auth_login_hash,u.auth_membership_epoch) OR NOT source_account_policy_allowed(u.source_id,u.source_policy_revision,u.account_policy_generation))")
            .execute(&mut *tx).await?;
        let observation = job_health.into_commit_observation();
        tx.commit().await?;
        observation.confirmed();
        db.release();
        Ok(())
    }).await
}

async fn ready(app: &App) -> anyhow::Result<Vec<(Uuid, i64)>> {
    bounded(async {
        let mut db = Database::acquire(&app.db).await?;
        let mut tx = db.transaction().await?;
        let rows = sqlx::query_as("SELECT a.source_id,a.source_revision FROM source_account_policies a JOIN sources s ON s.id=a.source_id AND s.access_policy_revision=a.source_revision WHERE s.kind IN('jellyfin','emby') AND a.next_check_at<=clock_timestamp() AND (a.claim IS NULL OR a.next_check_at<=clock_timestamp()-interval '3 seconds') AND (a.demand_until>clock_timestamp() OR EXISTS(SELECT 1 FROM playback_sessions p JOIN media_items m ON m.id=p.media_id WHERE m.source_id=a.source_id AND NOT p.stopped AND p.expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM upstream_reservations u WHERE u.source_id=a.source_id AND u.state IN('preparing','active'))) ORDER BY a.next_check_at,a.source_id LIMIT 8")
            .fetch_all(&mut *tx).await?;
        tx.commit().await?;
        db.release();
        Ok(rows)
    }).await
}

pub async fn maintenance(app: App) {
    let mut ticks = tokio::time::interval(Duration::from_millis(250));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_retirement = Instant::now() - Duration::from_secs(1);
    loop {
        ticks.tick().await;
        let invalidated = expire(&app).await.unwrap_or(false);
        if (invalidated || last_retirement.elapsed() >= Duration::from_secs(1))
            && retire(&app.db).await.is_ok()
        {
            last_retirement = Instant::now();
        }
        if let Ok(rows) = ready(&app).await {
            for (source, revision) in rows {
                schedule(&app, source, revision);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_is_single_flight_and_has_no_waiting_queue() {
        let runtime = Arc::new(Runtime::default());
        let source = Uuid::new_v4();
        let first = runtime.admit(source).unwrap();
        assert!(runtime.admit(source).is_none());
        let others: Vec<_> = (1..MAX_POLLS)
            .map(|_| runtime.admit(Uuid::new_v4()).unwrap())
            .collect();
        assert!(runtime.admit(Uuid::new_v4()).is_none());
        drop(first);
        assert!(runtime.admit(source).is_some());
        drop(others);
        assert_eq!(runtime.permits.available_permits(), MAX_POLLS);
        assert!(runtime.active.lock().unwrap().is_empty());
    }

    #[test]
    fn positive_is_bound_to_revision_generation_and_monotonic_deadline() {
        let runtime = Runtime::default();
        let source = Uuid::new_v4();
        runtime.positives.lock().unwrap().insert(
            source,
            Positive {
                revision: 7,
                generation: 11,
                observation_seq: 19,
                deadline: Instant::now() + POSITIVE_TTL,
            },
        );
        assert!(runtime.positive(source, 7, 11));
        assert!(!runtime.positive(source, 8, 11));
        assert!(!runtime.positive(source, 7, 12));
        runtime
            .positives
            .lock()
            .unwrap()
            .get_mut(&source)
            .unwrap()
            .deadline = Instant::now();
        assert!(!runtime.positive(source, 7, 11));
    }

    #[test]
    fn tracked_source_cap_preserves_expiry_evidence_and_existing_refreshes() {
        let runtime = Arc::new(Runtime::default());
        let mut existing = Uuid::nil();
        for _ in 0..MAX_TRACKED_SOURCES {
            existing = Uuid::new_v4();
            runtime.positives.lock().unwrap().insert(
                existing,
                Positive {
                    revision: 1,
                    generation: 1,
                    observation_seq: 1,
                    deadline: Instant::now(),
                },
            );
        }
        assert!(runtime.admit(Uuid::new_v4()).is_none());
        assert!(runtime.admit(existing).is_some());
        assert_eq!(runtime.positives.lock().unwrap().len(), MAX_TRACKED_SOURCES);
    }

    #[test]
    fn invalidation_fence_survives_until_durable_observation_replaces_it() {
        let runtime = Runtime::default();
        let source = Uuid::new_v4();
        runtime.positives.lock().unwrap().insert(
            source,
            Positive {
                revision: 4,
                generation: 7,
                observation_seq: 9,
                deadline: Instant::now(),
            },
        );
        assert_eq!(runtime.pending_invalidation(source, 4), Some((7, 9)));
        // Failed/cancelled publication does not consume its revocation fence.
        assert_eq!(runtime.pending_invalidation(source, 4), Some((7, 9)));
        assert!(!runtime.positive(source, 4, 7));
        assert_eq!(runtime.pending_invalidation(source, 5), None);
        // Only an accepted newer durable observation replaces this evidence.
        runtime.positives.lock().unwrap().insert(
            source,
            Positive {
                revision: 4,
                generation: 8,
                observation_seq: 10,
                deadline: Instant::now() + POSITIVE_TTL,
            },
        );
        assert_eq!(runtime.pending_invalidation(source, 4), None);
        assert!(!runtime.positive(source, 4, 7));
        assert!(runtime.positive(source, 4, 8));
    }
}
