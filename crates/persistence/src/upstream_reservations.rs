//! Durable upstream ownership, independent of a successfully published plan.
//! No database lock is held during network I/O. A random claim fences local
//! completions; it never purports to fence a timed-out remote operation.
use anyhow::Result;
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgRow};
use uuid::Uuid;

pub const NEGOTIATION_SECONDS: u64 = 30;
pub const CLEANUP_SECONDS: u64 = 3;
pub const CLEANUP_ATTEMPTS: i32 = 5;
pub const CLEANUP_TOTAL_SECONDS: u64 = 60;

pub struct Reservation<'a> {
    pub id: Uuid,
    pub user: Uuid,
    pub request_key: Uuid,
    pub owner_epoch: Uuid,
    pub room: Uuid,
    pub media: Uuid,
    pub source: Uuid,
    pub source_policy_revision: i64,
    pub generation: i64,
    pub kind: &'a str,
    pub device_id: &'a str,
    pub origin_key: &'a str,
    pub scope_encrypted: &'a str,
    pub observation_version: Option<u32>,
}

pub async fn reserve(tx: &mut Transaction<'_, Postgres>, r: &Reservation<'_>) -> Result<()> {
    let epoch = crate::room_lifecycle::lock_active(tx, r.room).await?;
    sqlx::query("INSERT INTO upstream_reservations(id,user_id,request_key,owner_epoch,room_id,media_id,source_id,generation,kind,device_id,origin_key,scope_encrypted,observation_version,lifecycle_epoch,source_policy_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)")
        .bind(r.id).bind(r.user).bind(r.request_key).bind(r.owner_epoch).bind(r.room)
        .bind(r.media).bind(r.source).bind(r.generation).bind(r.kind).bind(r.device_id)
        .bind(r.origin_key).bind(r.scope_encrypted).bind(r.observation_version.map(|version| version as i32)).bind(epoch).bind(r.source_policy_revision).execute(&mut **tx).await?;
    Ok(())
}

pub async fn close(tx: &mut Transaction<'_, Postgres>, id: Uuid, reason: &str) -> Result<()> {
    sqlx::query("UPDATE upstream_reservations SET state='closing',close_reason=COALESCE(close_reason,$2),cleanup_after=COALESCE(cleanup_after,clock_timestamp()),cleanup_deadline=COALESCE(cleanup_deadline,clock_timestamp()+interval '60 seconds'),updated_at=clock_timestamp() WHERE id=$1 AND state IN('preparing','active')")
        .bind(id).bind(reason).execute(&mut **tx).await?;
    Ok(())
}

pub async fn close_room(
    tx: &mut Transaction<'_, Postgres>,
    room: Uuid,
    generation: i64,
) -> Result<()> {
    sqlx::query("UPDATE upstream_reservations SET state='closing',close_reason=COALESCE(close_reason,'stale_media'),cleanup_after=COALESCE(cleanup_after,clock_timestamp()),cleanup_deadline=COALESCE(cleanup_deadline,clock_timestamp()+interval '60 seconds'),updated_at=clock_timestamp() WHERE room_id=$1 AND generation<>$2 AND state IN('preparing','active')")
        .bind(room).bind(generation).execute(&mut **tx).await?;
    Ok(())
}

/// Lifecycle close is independent of a change in media generation. Preserve
/// existing finite cleanup budgets and all uncertain/failed evidence.
pub async fn close_lifecycle(
    tx: &mut Transaction<'_, Postgres>,
    room: Uuid,
    epoch: i64,
) -> Result<()> {
    sqlx::query("UPDATE upstream_reservations SET state='closing',close_reason=COALESCE(close_reason,'room_closed'),cleanup_after=COALESCE(cleanup_after,clock_timestamp()),cleanup_deadline=COALESCE(cleanup_deadline,clock_timestamp()+interval '60 seconds'),updated_at=clock_timestamp() WHERE room_id=$1 AND lifecycle_epoch<$2 AND state IN('preparing','active')")
        .bind(room).bind(epoch).execute(&mut **tx).await?;
    Ok(())
}

async fn lock_admission(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<bool> {
    let identity: Option<(Uuid, i64)> =
        sqlx::query_as("SELECT room_id,lifecycle_epoch FROM upstream_reservations WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    let Some((room, epoch)) = identity else {
        return Ok(false);
    };
    match crate::room_lifecycle::lock_epoch(tx, room, epoch).await {
        Ok(()) => Ok(true),
        Err(error) if error.to_string() == "room_not_active" => Ok(false),
        Err(error) => Err(error),
    }
}

/// A cancelled reservation that never issued a request has a positive no-call
/// proof. Once the call is claimed, a missing SID can only be uncertain.
pub async fn begin_negotiation(pool: &PgPool, id: Uuid, epoch: Uuid, token: Uuid) -> Result<bool> {
    let mut tx = pool.begin().await?;
    if !lock_admission(&mut tx, id).await? {
        return Ok(false);
    }
    let n=sqlx::query("UPDATE upstream_reservations u SET negotiation='running',negotiation_token=$3,negotiation_deadline=clock_timestamp()+interval '30 seconds',io_claim=$3,io_kind='negotiate',io_lease_until=clock_timestamp()+interval '35 seconds',updated_at=clock_timestamp() WHERE u.id=$1 AND u.owner_epoch=$2 AND u.state='preparing' AND u.negotiation='reserved' AND EXISTS(SELECT 1 FROM sources src WHERE src.id=u.source_id AND src.access_policy_revision=u.source_policy_revision) AND EXISTS(SELECT 1 FROM playback_requests r WHERE r.user_id=u.user_id AND r.idempotency_key=u.request_key AND r.session_id=u.id AND r.owner_epoch=$2 AND r.status='pending' AND r.lease_until>clock_timestamp()) AND EXISTS(SELECT 1 FROM room_snapshots s JOIN room_members m ON m.room_id=s.room_id WHERE s.room_id=u.room_id AND m.user_id=u.user_id AND (s.state->>'media_generation')::bigint=u.generation)")
        .bind(id).bind(epoch).bind(token).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(n.rows_affected() == 1)
}

/// An immutable negotiation token admits a late SID checkpoint after a cancel
/// or lease expiry, but never changes a closing row back to preparing/active.
/// Every attempt gets a new reservation UUID; this token is never reissued.
pub async fn checkpoint(
    pool: &PgPool,
    id: Uuid,
    token: Uuid,
    response: &str,
    sid: Option<&str>,
    media_source: Option<&str>,
    live_stream: Option<&str>,
) -> Result<bool> {
    let n=sqlx::query("UPDATE upstream_reservations SET response_encrypted=$3,play_session_id=$4,media_source_id=$5,live_stream_id=$6,negotiation='received',state=CASE WHEN state='preparing' AND $4::text IS NOT NULL THEN 'preparing' ELSE 'closing' END,close_reason=CASE WHEN $4::text IS NULL THEN COALESCE(close_reason,'upstream_session_unknown') ELSE close_reason END,last_error=CASE WHEN $4::text IS NULL THEN 'upstream_session_unknown' ELSE NULL END,cleanup_after=CASE WHEN state<>'preparing' OR $4::text IS NULL THEN COALESCE(cleanup_after,clock_timestamp()) ELSE cleanup_after END,cleanup_deadline=CASE WHEN state<>'preparing' OR $4::text IS NULL THEN COALESCE(cleanup_deadline,clock_timestamp()+interval '60 seconds') ELSE cleanup_deadline END,io_claim=CASE WHEN io_claim=$2 THEN NULL ELSE io_claim END,io_kind=CASE WHEN io_claim=$2 THEN NULL ELSE io_kind END,io_lease_until=CASE WHEN io_claim=$2 THEN NULL ELSE io_lease_until END,updated_at=clock_timestamp() WHERE id=$1 AND negotiation_token=$2 AND negotiation IN('running','unknown') AND state<>'closed'")
        .bind(id).bind(token).bind(response).bind(sid).bind(media_source).bind(live_stream).execute(pool).await?;
    Ok(n.rows_affected() == 1)
}

pub async fn negotiation_unknown(pool: &PgPool, id: Uuid, token: Uuid) -> Result<()> {
    sqlx::query("UPDATE upstream_reservations SET state='cleanup_failed',negotiation='unknown',close_reason=COALESCE(close_reason,'upstream_negotiation_unknown'),last_error='upstream_session_unknown',cleanup_after=NULL,cleanup_deadline=COALESCE(cleanup_deadline,clock_timestamp()+interval '60 seconds'),io_claim=NULL,io_kind=NULL,io_lease_until=NULL,io_observation_seq=NULL,io_observation=NULL,updated_at=clock_timestamp() WHERE id=$1 AND negotiation_token=$2 AND negotiation='running' AND io_claim=$2")
        .bind(id).bind(token).execute(pool).await?;
    Ok(())
}

pub async fn activate(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    play_method: &str,
) -> Result<bool> {
    if !lock_admission(tx, id).await? {
        return Ok(false);
    }
    let n=sqlx::query("UPDATE upstream_reservations SET state='active',play_method=$2,updated_at=clock_timestamp() WHERE id=$1 AND state='preparing' AND negotiation='received' AND play_session_id IS NOT NULL AND io_claim IS NULL")
        .bind(id).bind(play_method).execute(&mut **tx).await?;
    Ok(n.rows_affected() == 1)
}

/// Reconcile authorization, not application epoch. Completed playback grants
/// remain authorized across a server restart. Old pending owners do not.
pub async fn reconcile(pool: &PgPool, epoch: Uuid) -> Result<()> {
    sqlx::query("UPDATE upstream_reservations u SET state='closing',close_reason=COALESCE(close_reason,'upstream_authorization_lost'),cleanup_after=COALESCE(cleanup_after,clock_timestamp()),cleanup_deadline=COALESCE(cleanup_deadline,clock_timestamp()+interval '60 seconds'),updated_at=clock_timestamp() WHERE (u.state IN('preparing','active') AND NOT EXISTS(SELECT 1 FROM rooms life WHERE life.id=u.room_id AND life.lifecycle='active' AND life.lifecycle_epoch=u.lifecycle_epoch) OR u.state='preparing' AND NOT EXISTS(SELECT 1 FROM playback_requests r WHERE r.user_id=u.user_id AND r.idempotency_key=u.request_key AND r.session_id=u.id AND r.status='pending' AND r.owner_epoch=$1 AND r.lease_until>clock_timestamp()) OR u.state='active' AND NOT EXISTS(SELECT 1 FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id JOIN room_members m ON m.room_id=p.room_id AND m.user_id=p.user_id WHERE p.id=u.id AND NOT p.stopped AND p.expires_at>clock_timestamp() AND (s.state->>'media_generation')::bigint=p.generation))")
        .bind(epoch).execute(pool).await?;
    sqlx::query("UPDATE upstream_reservations SET state='closed',negotiation='not_sent',close_reason=COALESCE(close_reason,'upstream_authorization_lost'),closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE state='closing' AND negotiation='reserved'")
        .execute(pool).await?;
    sqlx::query("UPDATE upstream_reservations SET state='cleanup_failed',negotiation='unknown',close_reason=COALESCE(close_reason,'upstream_negotiation_unknown'),last_error='upstream_session_unknown',io_claim=NULL,io_kind=NULL,io_lease_until=NULL,io_observation_seq=NULL,io_observation=NULL,updated_at=clock_timestamp() WHERE negotiation='running' AND io_lease_until<=clock_timestamp()")
        .execute(pool).await?;
    sqlx::query("UPDATE upstream_reservations SET state='cleanup_failed',last_error='upstream_session_unknown',updated_at=clock_timestamp() WHERE state='closing' AND negotiation IN('received','unknown') AND play_session_id IS NULL")
        .execute(pool).await?;
    // A lost local reporter may already be executing remotely. Keep that fact
    // even when a later successful Stop is observed.
    sqlx::query("UPDATE upstream_reservations SET io_uncertain=io_uncertain OR io_kind IN('start','progress'),io_claim=NULL,io_kind=NULL,io_lease_until=NULL,io_observation_seq=NULL,io_observation=NULL,updated_at=clock_timestamp() WHERE io_kind<>'negotiate' AND io_lease_until<=clock_timestamp()")
        .execute(pool).await?;
    sqlx::query("UPDATE upstream_reservations SET state='cleanup_failed',last_error=COALESCE(last_error,'upstream_cleanup_deadline'),updated_at=clock_timestamp() WHERE state='closing' AND (cleanup_attempts>=5 OR cleanup_deadline<=clock_timestamp()) AND io_claim IS NULL AND negotiation<>'running'")
        .execute(pool).await?;
    Ok(())
}

pub async fn recover(tx: &mut Transaction<'_, Postgres>, epoch: Uuid) -> Result<()> {
    // Instance-lock acquisition proves the previous process is gone, but does
    // not prove its already submitted upstream requests stopped executing.
    sqlx::query("UPDATE upstream_reservations SET state='cleanup_failed',negotiation='unknown',last_error='upstream_session_unknown',close_reason=COALESCE(close_reason,'upstream_owner_lost'),io_claim=NULL,io_kind=NULL,io_lease_until=NULL,io_observation_seq=NULL,io_observation=NULL,updated_at=clock_timestamp() WHERE negotiation='running' AND owner_epoch<>$1")
        .bind(epoch).execute(&mut **tx).await?;
    sqlx::query("UPDATE upstream_reservations SET io_uncertain=io_uncertain OR io_kind IN('start','progress'),io_claim=NULL,io_kind=NULL,io_lease_until=NULL,io_observation_seq=NULL,io_observation=NULL,updated_at=clock_timestamp() WHERE io_kind<>'negotiate'")
        .execute(&mut **tx).await?;
    Ok(())
}

#[derive(Debug)]
pub struct Claim {
    pub id: Uuid,
    pub token: Uuid,
    pub event: String,
    pub kind: String,
    pub scope_encrypted: String,
    pub device_id: String,
    pub sid: String,
    pub media_source: Option<String>,
    pub live_stream: Option<String>,
    pub play_method: Option<String>,
    pub stop_confirmed: bool,
    pub encoding_stop_confirmed: bool,
    pub state: Option<serde_json::Value>,
    pub observation_seq: Option<u64>,
    pub observation: Option<serde_json::Value>,
    pub observation_version: Option<u32>,
    pub cleanup_remaining_ms: Option<f64>,
    claimed_at: std::time::Instant,
}

impl Claim {
    fn from_row(row: PgRow, token: Uuid, event: &str, claimed_at: std::time::Instant) -> Self {
        Self {
            id: row.get("id"),
            token,
            event: event.into(),
            kind: row.get("kind"),
            scope_encrypted: row.get("scope_encrypted"),
            device_id: row.get("device_id"),
            sid: row.get("play_session_id"),
            media_source: row.get("media_source_id"),
            live_stream: row.get("live_stream_id"),
            play_method: row.get("play_method"),
            stop_confirmed: row.get("stop_confirmed"),
            encoding_stop_confirmed: row.get("encoding_stop_confirmed"),
            state: row.get("room_state"),
            observation_seq: row
                .get::<Option<i64>, _>("io_observation_seq")
                .map(|seq| seq as u64),
            observation: row.get("io_observation"),
            observation_version: row
                .get::<Option<i32>, _>("observation_version")
                .map(|version| version as u32),
            cleanup_remaining_ms: row.get("cleanup_remaining_ms"),
            claimed_at,
        }
    }

    pub fn network_budget(&self) -> std::time::Duration {
        let maximum = std::time::Duration::from_secs(CLEANUP_SECONDS);
        self.cleanup_remaining_ms.map_or(maximum, |remaining| {
            if !remaining.is_finite() || remaining <= 0.0 {
                return std::time::Duration::ZERO;
            }
            std::time::Duration::from_secs_f64(
                (remaining / 1000.0 - self.claimed_at.elapsed().as_secs_f64())
                    .max(0.0)
                    .min(maximum.as_secs_f64()),
            )
        })
    }
}

pub async fn ready(pool: &PgPool, stop: bool) -> Result<Vec<(Uuid, String)>> {
    let query = if stop {
        "SELECT id,origin_key FROM upstream_reservations WHERE state='closing' AND negotiation='received' AND play_session_id IS NOT NULL AND io_claim IS NULL AND cleanup_after<=clock_timestamp() AND cleanup_deadline>clock_timestamp() AND cleanup_attempts<5 ORDER BY cleanup_after LIMIT 32"
    } else {
        "SELECT u.id,u.origin_key FROM upstream_reservations u LEFT JOIN playback_observations o ON o.session_id=u.id WHERE u.state='active' AND NOT u.io_uncertain AND u.io_claim IS NULL AND ((u.observation_version IS NULL AND o.session_id IS NULL AND (NOT u.start_reported OR u.last_report_at IS NULL OR u.last_report_at<=clock_timestamp()-interval '10 seconds')) OR (o.has_played AND o.seq>o.reported_seq)) ORDER BY u.last_report_at NULLS FIRST,u.created_at LIMIT 32"
    };
    Ok(sqlx::query(query)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|r| (r.get("id"), r.get("origin_key")))
        .collect())
}

pub async fn claim_io(pool: &PgPool, id: Uuid, stop: bool) -> Result<Option<Claim>> {
    let mut tx = pool.begin().await?;
    if !stop && !lock_admission(&mut tx, id).await? {
        return Ok(None);
    }
    let token = Uuid::new_v4();
    let capture = "io_observation_seq=(SELECT seq FROM playback_observations WHERE session_id=u.id),io_observation=(SELECT jsonb_build_object('seq',seq,'position_ms',COALESCE(position_ms,timeline_origin_ms),'paused',COALESCE((payload->>'paused')::boolean,true),'seeking',COALESCE((payload->>'seeking')::boolean,false),'buffering',COALESCE((payload->>'buffering')::boolean,false),'playback_rate',COALESCE((payload->>'playback_rate')::double precision,1),'has_played',has_played) FROM playback_observations WHERE session_id=u.id)";
    let query = if stop {
        format!(
            "UPDATE upstream_reservations u SET io_claim=$2,io_kind='stop',io_lease_until=LEAST(clock_timestamp()+interval '10 seconds',cleanup_deadline),cleanup_attempts=cleanup_attempts+1,{capture},updated_at=clock_timestamp() WHERE id=$1 AND state='closing' AND negotiation='received' AND play_session_id IS NOT NULL AND io_claim IS NULL AND cleanup_after<=clock_timestamp() AND cleanup_deadline>clock_timestamp() AND cleanup_attempts<5 RETURNING u.*,(SELECT state FROM room_snapshots WHERE room_id=u.room_id) AS room_state,EXTRACT(EPOCH FROM(cleanup_deadline-clock_timestamp()))::double precision*1000 AS cleanup_remaining_ms"
        )
    } else {
        format!(
            "UPDATE upstream_reservations u SET io_claim=$2,io_kind=CASE WHEN start_reported THEN 'progress' ELSE 'start' END,io_lease_until=clock_timestamp()+interval '10 seconds',{capture},updated_at=clock_timestamp() WHERE id=$1 AND state='active' AND NOT io_uncertain AND io_claim IS NULL AND ((u.observation_version IS NULL AND NOT EXISTS(SELECT 1 FROM playback_observations o WHERE o.session_id=u.id) AND (NOT start_reported OR last_report_at IS NULL OR last_report_at<=clock_timestamp()-interval '10 seconds')) OR EXISTS(SELECT 1 FROM playback_observations o WHERE o.session_id=u.id AND o.has_played AND o.seq>o.reported_seq)) AND EXISTS(SELECT 1 FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id JOIN room_members m ON m.room_id=p.room_id AND m.user_id=p.user_id WHERE p.id=u.id AND NOT p.stopped AND p.expires_at>clock_timestamp() AND (s.state->>'media_generation')::bigint=p.generation) RETURNING u.*,(SELECT state FROM room_snapshots WHERE room_id=u.room_id) AS room_state,NULL::double precision AS cleanup_remaining_ms"
        )
    };
    let claimed_at = std::time::Instant::now();
    let row = sqlx::query(&query)
        .bind(id)
        .bind(token)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(row.map(|r| {
        let event: String = r.get("io_kind");
        Claim::from_row(r, token, &event, claimed_at)
    }))
}

pub async fn finish_report(pool: &PgPool, claim: &Claim, successful: bool) -> Result<bool> {
    let mut tx = pool.begin().await?;
    // Same observation-before-ledger order as final sample plus Stop. No room
    // or grant lock is held while executing upstream I/O.
    sqlx::query("SELECT session_id FROM playback_observations WHERE session_id=$1 FOR UPDATE")
        .bind(claim.id)
        .fetch_optional(&mut *tx)
        .await?;
    let n=sqlx::query("UPDATE upstream_reservations SET start_reported=start_reported OR ($3 AND io_kind='start'),io_uncertain=io_uncertain OR NOT $3,last_error=CASE WHEN $3 THEN last_error ELSE 'upstream_io_uncertain' END,last_report_at=clock_timestamp(),io_claim=NULL,io_kind=NULL,io_lease_until=NULL,io_observation_seq=NULL,io_observation=NULL,updated_at=clock_timestamp() WHERE id=$1 AND io_claim=$2 AND io_kind IN('start','progress') AND io_lease_until>clock_timestamp() AND io_observation_seq IS NOT DISTINCT FROM $4")
        .bind(claim.id).bind(claim.token).bind(successful).bind(claim.observation_seq.map(|seq| seq as i64))
        .execute(&mut *tx).await?;
    let matched = n.rows_affected() == 1;
    if matched
        && successful
        && let Some(seq) = claim.observation_seq
    {
        sqlx::query("UPDATE playback_observations SET reported_seq=GREATEST(reported_seq,$2) WHERE session_id=$1 AND seq>=$2")
            .bind(claim.id).bind(seq as i64).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(matched)
}

pub async fn finish_stop(
    pool: &PgPool,
    claim: &Claim,
    stopped: bool,
    encoding_stopped: bool,
) -> Result<bool> {
    let n=sqlx::query("UPDATE upstream_reservations SET stop_confirmed=stop_confirmed OR $3,encoding_stop_confirmed=encoding_stop_confirmed OR $4,state=CASE WHEN $3 AND (kind='jellyfin' OR $4) AND NOT io_uncertain THEN 'closed' WHEN $3 AND (kind='jellyfin' OR $4) AND io_uncertain THEN 'cleanup_failed' WHEN cleanup_attempts>=5 OR cleanup_deadline<=clock_timestamp() THEN 'cleanup_failed' ELSE 'closing' END,closed_at=CASE WHEN $3 AND (kind='jellyfin' OR $4) AND NOT io_uncertain THEN clock_timestamp() ELSE NULL END,last_error=CASE WHEN io_uncertain THEN 'upstream_io_uncertain' WHEN $3 AND (kind='jellyfin' OR $4) THEN NULL ELSE 'upstream_stop_failed' END,cleanup_after=clock_timestamp()+make_interval(secs=>LEAST(16,power(2,cleanup_attempts)::integer)),io_claim=NULL,io_kind=NULL,io_lease_until=NULL,io_observation_seq=NULL,io_observation=NULL,updated_at=clock_timestamp() WHERE id=$1 AND io_claim=$2 AND io_kind='stop' AND io_lease_until>clock_timestamp()")
        .bind(claim.id).bind(claim.token).bind(stopped).bind(encoding_stopped).execute(pool).await?;
    Ok(n.rows_affected() == 1)
}
