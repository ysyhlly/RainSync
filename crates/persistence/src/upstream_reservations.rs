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
    pub generation: i64,
    pub kind: &'a str,
    pub device_id: &'a str,
    pub origin_key: &'a str,
    pub scope_encrypted: &'a str,
}

pub async fn reserve(tx: &mut Transaction<'_, Postgres>, r: &Reservation<'_>) -> Result<()> {
    sqlx::query("INSERT INTO upstream_reservations(id,user_id,request_key,owner_epoch,room_id,media_id,source_id,generation,kind,device_id,origin_key,scope_encrypted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)")
        .bind(r.id).bind(r.user).bind(r.request_key).bind(r.owner_epoch).bind(r.room)
        .bind(r.media).bind(r.source).bind(r.generation).bind(r.kind).bind(r.device_id)
        .bind(r.origin_key).bind(r.scope_encrypted).execute(&mut **tx).await?;
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

/// A cancelled reservation that never issued a request has a positive no-call
/// proof. Once the call is claimed, a missing SID can only be uncertain.
pub async fn begin_negotiation(pool: &PgPool, id: Uuid, epoch: Uuid, token: Uuid) -> Result<bool> {
    let n=sqlx::query("UPDATE upstream_reservations u SET negotiation='running',negotiation_token=$3,negotiation_deadline=clock_timestamp()+interval '30 seconds',io_claim=$3,io_kind='negotiate',io_lease_until=clock_timestamp()+interval '35 seconds',updated_at=clock_timestamp() WHERE u.id=$1 AND u.owner_epoch=$2 AND u.state='preparing' AND u.negotiation='reserved' AND EXISTS(SELECT 1 FROM playback_requests r WHERE r.user_id=u.user_id AND r.idempotency_key=u.request_key AND r.session_id=u.id AND r.owner_epoch=$2 AND r.status='pending' AND r.lease_until>clock_timestamp()) AND EXISTS(SELECT 1 FROM room_snapshots s JOIN room_members m ON m.room_id=s.room_id WHERE s.room_id=u.room_id AND m.user_id=u.user_id AND (s.state->>'media_generation')::bigint=u.generation)")
        .bind(id).bind(epoch).bind(token).execute(pool).await?;
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
    sqlx::query("UPDATE upstream_reservations SET state='cleanup_failed',negotiation='unknown',close_reason=COALESCE(close_reason,'upstream_negotiation_unknown'),last_error='upstream_session_unknown',cleanup_after=NULL,cleanup_deadline=COALESCE(cleanup_deadline,clock_timestamp()+interval '60 seconds'),io_claim=NULL,io_kind=NULL,io_lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND negotiation_token=$2 AND negotiation='running' AND io_claim=$2")
        .bind(id).bind(token).execute(pool).await?;
    Ok(())
}

pub async fn activate(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    play_method: &str,
) -> Result<bool> {
    let n=sqlx::query("UPDATE upstream_reservations SET state='active',play_method=$2,updated_at=clock_timestamp() WHERE id=$1 AND state='preparing' AND negotiation='received' AND play_session_id IS NOT NULL AND io_claim IS NULL")
        .bind(id).bind(play_method).execute(&mut **tx).await?;
    Ok(n.rows_affected() == 1)
}

/// Reconcile authorization, not application epoch. Completed playback grants
/// remain authorized across a server restart. Old pending owners do not.
pub async fn reconcile(pool: &PgPool, epoch: Uuid) -> Result<()> {
    sqlx::query("UPDATE upstream_reservations u SET state='closing',close_reason=COALESCE(close_reason,'upstream_authorization_lost'),cleanup_after=COALESCE(cleanup_after,clock_timestamp()),cleanup_deadline=COALESCE(cleanup_deadline,clock_timestamp()+interval '60 seconds'),updated_at=clock_timestamp() WHERE (u.state='preparing' AND NOT EXISTS(SELECT 1 FROM playback_requests r WHERE r.user_id=u.user_id AND r.idempotency_key=u.request_key AND r.session_id=u.id AND r.status='pending' AND r.owner_epoch=$1 AND r.lease_until>clock_timestamp()) OR u.state='active' AND NOT EXISTS(SELECT 1 FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id JOIN room_members m ON m.room_id=p.room_id AND m.user_id=p.user_id WHERE p.id=u.id AND NOT p.stopped AND p.expires_at>clock_timestamp() AND (s.state->>'media_generation')::bigint=p.generation))")
        .bind(epoch).execute(pool).await?;
    sqlx::query("UPDATE upstream_reservations SET state='closed',negotiation='not_sent',close_reason=COALESCE(close_reason,'upstream_authorization_lost'),closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE state='closing' AND negotiation='reserved'")
        .execute(pool).await?;
    sqlx::query("UPDATE upstream_reservations SET state='cleanup_failed',negotiation='unknown',close_reason=COALESCE(close_reason,'upstream_negotiation_unknown'),last_error='upstream_session_unknown',io_claim=NULL,io_kind=NULL,io_lease_until=NULL,updated_at=clock_timestamp() WHERE negotiation='running' AND io_lease_until<=clock_timestamp()")
        .execute(pool).await?;
    sqlx::query("UPDATE upstream_reservations SET state='cleanup_failed',last_error='upstream_session_unknown',updated_at=clock_timestamp() WHERE state='closing' AND negotiation IN('received','unknown') AND play_session_id IS NULL")
        .execute(pool).await?;
    // A lost local reporter may already be executing remotely. Keep that fact
    // even when a later successful Stop is observed.
    sqlx::query("UPDATE upstream_reservations SET io_uncertain=io_uncertain OR io_kind IN('start','progress'),io_claim=NULL,io_kind=NULL,io_lease_until=NULL,updated_at=clock_timestamp() WHERE io_kind<>'negotiate' AND io_lease_until<=clock_timestamp()")
        .execute(pool).await?;
    sqlx::query("UPDATE upstream_reservations SET state='cleanup_failed',last_error=COALESCE(last_error,'upstream_cleanup_deadline'),updated_at=clock_timestamp() WHERE state='closing' AND (cleanup_attempts>=5 OR cleanup_deadline<=clock_timestamp()) AND io_claim IS NULL AND negotiation<>'running'")
        .execute(pool).await?;
    Ok(())
}

pub async fn recover(tx: &mut Transaction<'_, Postgres>, epoch: Uuid) -> Result<()> {
    // Instance-lock acquisition proves the previous process is gone, but does
    // not prove its already submitted upstream requests stopped executing.
    sqlx::query("UPDATE upstream_reservations SET state='cleanup_failed',negotiation='unknown',last_error='upstream_session_unknown',close_reason=COALESCE(close_reason,'upstream_owner_lost'),io_claim=NULL,io_kind=NULL,io_lease_until=NULL,updated_at=clock_timestamp() WHERE negotiation='running' AND owner_epoch<>$1")
        .bind(epoch).execute(&mut **tx).await?;
    sqlx::query("UPDATE upstream_reservations SET io_uncertain=io_uncertain OR io_kind IN('start','progress'),io_claim=NULL,io_kind=NULL,io_lease_until=NULL,updated_at=clock_timestamp() WHERE io_kind<>'negotiate'")
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
}

impl Claim {
    fn from_row(row: PgRow, token: Uuid, event: &str) -> Self {
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
        }
    }
}

pub async fn ready(pool: &PgPool, stop: bool) -> Result<Vec<(Uuid, String)>> {
    let query = if stop {
        "SELECT id,origin_key FROM upstream_reservations WHERE state='closing' AND negotiation='received' AND play_session_id IS NOT NULL AND io_claim IS NULL AND cleanup_after<=clock_timestamp() AND cleanup_deadline>clock_timestamp() AND cleanup_attempts<5 ORDER BY cleanup_after LIMIT 32"
    } else {
        "SELECT id,origin_key FROM upstream_reservations WHERE state='active' AND NOT io_uncertain AND io_claim IS NULL AND (NOT start_reported OR last_report_at IS NULL OR last_report_at<=clock_timestamp()-interval '10 seconds') ORDER BY last_report_at NULLS FIRST LIMIT 32"
    };
    Ok(sqlx::query(query)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|r| (r.get("id"), r.get("origin_key")))
        .collect())
}

pub async fn claim_io(pool: &PgPool, id: Uuid, stop: bool) -> Result<Option<Claim>> {
    let token = Uuid::new_v4();
    let query = if stop {
        "UPDATE upstream_reservations u SET io_claim=$2,io_kind='stop',io_lease_until=LEAST(clock_timestamp()+interval '10 seconds',cleanup_deadline),cleanup_attempts=cleanup_attempts+1,updated_at=clock_timestamp() WHERE id=$1 AND state='closing' AND negotiation='received' AND play_session_id IS NOT NULL AND io_claim IS NULL AND cleanup_after<=clock_timestamp() AND cleanup_deadline>clock_timestamp() AND cleanup_attempts<5 RETURNING u.*,(SELECT state FROM room_snapshots WHERE room_id=u.room_id) AS room_state"
    } else {
        "UPDATE upstream_reservations u SET io_claim=$2,io_kind=CASE WHEN start_reported THEN 'progress' ELSE 'start' END,io_lease_until=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp() WHERE id=$1 AND state='active' AND NOT io_uncertain AND io_claim IS NULL AND (NOT start_reported OR last_report_at IS NULL OR last_report_at<=clock_timestamp()-interval '10 seconds') AND EXISTS(SELECT 1 FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id JOIN room_members m ON m.room_id=p.room_id AND m.user_id=p.user_id WHERE p.id=u.id AND NOT p.stopped AND p.expires_at>clock_timestamp() AND (s.state->>'media_generation')::bigint=p.generation) RETURNING u.*,(SELECT state FROM room_snapshots WHERE room_id=u.room_id) AS room_state"
    };
    Ok(sqlx::query(query)
        .bind(id)
        .bind(token)
        .fetch_optional(pool)
        .await?
        .map(|r| {
            let event: String = r.get("io_kind");
            Claim::from_row(r, token, &event)
        }))
}

pub async fn finish_report(pool: &PgPool, claim: &Claim, successful: bool) -> Result<bool> {
    let n=sqlx::query("UPDATE upstream_reservations SET start_reported=start_reported OR ($3 AND io_kind='start'),io_uncertain=io_uncertain OR NOT $3,last_error=CASE WHEN $3 THEN last_error ELSE 'upstream_io_uncertain' END,last_report_at=clock_timestamp(),io_claim=NULL,io_kind=NULL,io_lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND io_claim=$2 AND io_kind IN('start','progress') AND io_lease_until>clock_timestamp()")
        .bind(claim.id).bind(claim.token).bind(successful).execute(pool).await?;
    Ok(n.rows_affected() == 1)
}

pub async fn finish_stop(
    pool: &PgPool,
    claim: &Claim,
    stopped: bool,
    encoding_stopped: bool,
) -> Result<bool> {
    let n=sqlx::query("UPDATE upstream_reservations SET stop_confirmed=stop_confirmed OR $3,encoding_stop_confirmed=encoding_stop_confirmed OR $4,state=CASE WHEN $3 AND (kind='jellyfin' OR $4) AND NOT io_uncertain THEN 'closed' WHEN $3 AND (kind='jellyfin' OR $4) AND io_uncertain THEN 'cleanup_failed' WHEN cleanup_attempts>=5 OR cleanup_deadline<=clock_timestamp() THEN 'cleanup_failed' ELSE 'closing' END,closed_at=CASE WHEN $3 AND (kind='jellyfin' OR $4) AND NOT io_uncertain THEN clock_timestamp() ELSE NULL END,last_error=CASE WHEN io_uncertain THEN 'upstream_io_uncertain' WHEN $3 AND (kind='jellyfin' OR $4) THEN NULL ELSE 'upstream_stop_failed' END,cleanup_after=clock_timestamp()+make_interval(secs=>LEAST(16,power(2,cleanup_attempts)::integer)),io_claim=NULL,io_kind=NULL,io_lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND io_claim=$2 AND io_kind='stop' AND io_lease_until>clock_timestamp()")
        .bind(claim.id).bind(claim.token).bind(stopped).bind(encoding_stopped).execute(pool).await?;
    Ok(n.rows_affected() == 1)
}
