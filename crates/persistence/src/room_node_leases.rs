//! Cross-node control authority. Call guard inside EVERY control write transaction.
//! A routing hint or in-memory actor is never authority to commit.
use anyhow::{Result, ensure};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lease {
    pub room: Uuid,
    pub node: Uuid,
    pub incarnation: Uuid,
    pub fencing_token: i64,
    pub remaining_ms: i64,
}
#[derive(Debug, Clone)]
pub struct Route {
    pub node: Uuid,
    pub origin: String,
    pub fencing_token: i64,
    pub remaining_ms: i64,
}
/// Origins are provisioned by an administrator, never accepted from client routing hints.
pub async fn heartbeat(pool: &PgPool, node: Uuid, origin: &str) -> Result<()> {
    let valid = origin.starts_with("https://")
        || origin.starts_with("http://127.0.0.1:")
        || origin.starts_with("http://localhost:");
    ensure!(
        valid && !origin.contains(['\r', '\n', '?', '#']) && origin.len() <= 512,
        "invalid_control_node_origin"
    );
    sqlx::query("INSERT INTO control_nodes(id,route_origin) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET route_origin=$2,heartbeat_at=clock_timestamp()")
        .bind(node).bind(origin.trim_end_matches('/')).execute(pool).await?;
    Ok(())
}
/// A live other-node lease cannot be stolen. Every new ownership window gets a new token.
pub async fn claim(pool: &PgPool, room: Uuid, node: Uuid) -> Result<Option<Lease>> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    let healthy:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM control_nodes WHERE id=$1 AND heartbeat_at>clock_timestamp()-interval '10 seconds')").bind(node).fetch_one(&mut *tx).await?;
    ensure!(healthy, "control_node_unhealthy");
    let row=sqlx::query("INSERT INTO room_leases(room_id,owner_node,owner_incarnation,lease_until) SELECT $1,$2,incarnation,clock_timestamp()+interval '10 seconds' FROM control_nodes WHERE id=$2 ON CONFLICT(room_id) DO UPDATE SET owner_node=$2,owner_incarnation=EXCLUDED.owner_incarnation,fencing_token=CASE WHEN room_leases.owner_node=$2 AND room_leases.owner_incarnation=EXCLUDED.owner_incarnation AND room_leases.lease_until>clock_timestamp() THEN room_leases.fencing_token ELSE nextval('room_fencing_tokens') END,lease_until=clock_timestamp()+interval '10 seconds' WHERE room_leases.owner_node=$2 OR room_leases.lease_until<=clock_timestamp() RETURNING fencing_token,owner_incarnation,FLOOR(EXTRACT(EPOCH FROM(lease_until-clock_timestamp()))*1000)::bigint AS remaining_ms").bind(room).bind(node).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    Ok(row.map(|r| Lease {
        room,
        node,
        incarnation: r.get("owner_incarnation"),
        fencing_token: r.get("fencing_token"),
        remaining_ms: r.get("remaining_ms"),
    }))
}
/// Expired owners cannot renew their old fence, even when no replacement has appeared.
pub async fn renew(pool: &PgPool, lease: &Lease) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar("UPDATE room_leases l SET lease_until=clock_timestamp()+interval '10 seconds' FROM control_nodes n WHERE l.room_id=$1 AND l.owner_node=$2 AND l.fencing_token=$3 AND l.owner_incarnation=n.incarnation AND l.lease_until>clock_timestamp() AND n.id=l.owner_node AND n.incarnation=l.owner_incarnation AND n.heartbeat_at>clock_timestamp()-interval '10 seconds' RETURNING FLOOR(EXTRACT(EPOCH FROM(l.lease_until-clock_timestamp()))*1000)::bigint").bind(lease.room).bind(lease.node).bind(lease.fencing_token).fetch_optional(pool).await?)
}
/// Acquire after room->snapshot locks, before control writes, and recheck at final commit.
/// FOR SHARE holds the lease row through commit so a new owner cannot acquire concurrently.
pub async fn guard(tx: &mut Transaction<'_, Postgres>, lease: &Lease) -> Result<()> {
    let valid:Option<i64>=sqlx::query_scalar("SELECT l.fencing_token FROM room_leases l JOIN control_nodes n ON n.id=l.owner_node WHERE l.room_id=$1 AND l.owner_node=$2 AND l.fencing_token=$3 AND l.owner_incarnation=n.incarnation AND n.incarnation=$4 AND l.lease_until>clock_timestamp() AND n.heartbeat_at>clock_timestamp()-interval '10 seconds' FOR SHARE OF l FOR KEY SHARE OF n").bind(lease.room).bind(lease.node).bind(lease.fencing_token).bind(lease.incarnation).fetch_optional(&mut **tx).await?;
    ensure!(valid.is_some(), "room_owner_lost");
    Ok(())
}
pub async fn route(pool: &PgPool, room: Uuid) -> Result<Option<Route>> {
    let row=sqlx::query("SELECT l.owner_node,n.route_origin,l.fencing_token,FLOOR(EXTRACT(EPOCH FROM(l.lease_until-clock_timestamp()))*1000)::bigint AS remaining_ms FROM room_leases l JOIN control_nodes n ON n.id=l.owner_node JOIN rooms r ON r.id=l.room_id WHERE l.room_id=$1 AND l.owner_incarnation=n.incarnation AND l.lease_until>clock_timestamp() AND n.heartbeat_at>clock_timestamp()-interval '10 seconds'").bind(room).fetch_optional(pool).await?;
    Ok(row.map(|r| Route {
        node: r.get("owner_node"),
        origin: r.get("route_origin"),
        fencing_token: r.get("fencing_token"),
        remaining_ms: r.get("remaining_ms"),
    }))
}
/// Gateways broadcast only database-committed room events. A gap requires a fresh snapshot.
pub async fn committed_after(
    pool: &PgPool,
    room: Uuid,
    revision: i64,
) -> Result<Vec<protocol::RoomState>> {
    let rows:Vec<serde_json::Value>=sqlx::query_scalar("SELECT state FROM room_events WHERE room_id=$1 AND revision>$2 ORDER BY revision LIMIT 128").bind(room).bind(revision).fetch_all(pool).await?;
    rows.into_iter()
        .map(|r| Ok(serde_json::from_value(r)?))
        .collect()
}

/// Refresh a revision-bound progress checkpoint in an existing authority transaction.
/// The caller already holds room -> snapshot locks. Never extrapolate a different epoch.
pub async fn checkpoint_locked(
    tx: &mut Transaction<'_, Postgres>,
    lease: &Lease,
    state: &protocol::RoomState,
    now_ms: f64,
) -> Result<()> {
    ensure!(
        state.room_id == lease.room,
        "control_checkpoint_room_mismatch"
    );
    guard(tx, lease).await?;
    let position = room_core::position(state, now_ms);
    ensure!(
        position.is_finite() && position >= 0.0,
        "invalid_control_checkpoint"
    );
    sqlx::query("UPDATE room_leases SET checkpoint_revision=$4,checkpoint_generation=$5,checkpoint_clock_epoch=$6,checkpoint_position_ms=$7,checkpoint_confirmed_at=clock_timestamp() WHERE room_id=$1 AND owner_node=$2 AND fencing_token=$3")
        .bind(lease.room).bind(lease.node).bind(lease.fencing_token)
        .bind(i64::from(state.revision)).bind(i64::from(state.media_generation))
        .bind(state.clock_epoch).bind(position.min(protocol::UNKNOWN_DURATION_LIMIT_MS))
        .execute(&mut **tx).await?;
    Ok(())
}

/// Renew and checkpoint together. A revision change invalidates an older checkpoint.
pub async fn renew_checkpoint(
    pool: &PgPool,
    lease: &Lease,
    epoch: Uuid,
    now_ms: f64,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='1500ms'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(lease.room)
        .fetch_one(&mut *tx)
        .await?;
    let state: protocol::RoomState = serde_json::from_value(
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(lease.room)
            .fetch_one(&mut *tx)
            .await?,
    )?;
    guard(&mut tx, lease).await?;
    ensure!(state.clock_epoch == epoch, "room_clock_not_owned");
    checkpoint_locked(&mut tx, lease, &state, now_ms).await?;
    let count=sqlx::query("UPDATE room_leases SET lease_until=clock_timestamp()+interval '10 seconds' WHERE room_id=$1 AND owner_node=$2 AND fencing_token=$3 AND lease_until>clock_timestamp()")
       .bind(lease.room).bind(lease.node).bind(lease.fencing_token).execute(&mut *tx).await?.rows_affected();
    guard(&mut tx, lease).await?;
    tx.commit().await?;
    Ok(count == 1)
}

/// Restore a room only once for this ownership window. Its old monotonic clock
/// is never reused. Matching, committed checkpoints bound lost playback progress
/// to the checkpoint interval plus lease failure detection (normally 2 seconds).
pub async fn prepare(
    pool: &PgPool,
    lease: &Lease,
    epoch: Uuid,
    now_ms: f64,
) -> Result<protocol::RoomState> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    let room =
        sqlx::query("SELECT lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
            .bind(lease.room)
            .fetch_one(&mut *tx)
            .await?;
    let before: protocol::RoomState = serde_json::from_value(
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(lease.room)
            .fetch_one(&mut *tx)
            .await?,
    )?;
    guard(&mut tx, lease).await?;
    let checkpoint=sqlx::query("SELECT prepared_fencing_token,prepared_clock_epoch,checkpoint_revision,checkpoint_generation,checkpoint_clock_epoch,checkpoint_position_ms FROM room_leases WHERE room_id=$1 AND owner_node=$2 AND fencing_token=$3 FOR UPDATE")
        .bind(lease.room).bind(lease.node).bind(lease.fencing_token).fetch_one(&mut *tx).await?;
    let prepared = checkpoint.get::<Option<i64>, _>("prepared_fencing_token")
        == Some(lease.fencing_token)
        && checkpoint.get::<Option<Uuid>, _>("prepared_clock_epoch") == Some(epoch);
    let mut state = before.clone();
    if !prepared && before.clock_epoch != epoch {
        let valid = checkpoint.get::<Option<i64>, _>("checkpoint_revision")
            == Some(i64::from(before.revision))
            && checkpoint.get::<Option<i64>, _>("checkpoint_generation")
                == Some(i64::from(before.media_generation))
            && checkpoint.get::<Option<Uuid>, _>("checkpoint_clock_epoch")
                == Some(before.clock_epoch);
        state.anchor_position_ms = if valid {
            checkpoint
                .get::<Option<f64>, _>("checkpoint_position_ms")
                .unwrap_or(before.anchor_position_ms)
        } else {
            before.anchor_position_ms
        };
        state.playback_status = protocol::PlaybackStatus::Paused;
        state.clock_epoch = epoch;
        state.anchor_server_time_ms = now_ms;
        state.revision = state
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("revision_overflow"))?;
        let life = super::room_diagnostics::lifecycle(
            room.get::<String, _>("lifecycle").as_str(),
            room.get("lifecycle_epoch"),
        )?;
        let diagnostic = super::room_diagnostics::envelope(
            Uuid::new_v4(),
            before,
            None,
            life,
            life,
            room_core::diagnostics::Operation::ControlOwnerTakeover {
                clock_epoch: epoch,
                server_time_ms: now_ms,
                recovered_position_ms: state.anchor_position_ms,
                checkpoint_matched: valid,
            },
        );
        sqlx::query("UPDATE room_snapshots SET state=$2 WHERE room_id=$1")
            .bind(lease.room)
            .bind(serde_json::to_value(&state)?)
            .execute(&mut *tx)
            .await?;
        super::room_diagnostics::append(&mut tx, &state, diagnostic).await?;
    }
    sqlx::query(
        "UPDATE room_leases SET prepared_fencing_token=$2,prepared_clock_epoch=$3 WHERE room_id=$1",
    )
    .bind(lease.room)
    .bind(lease.fencing_token)
    .bind(epoch)
    .execute(&mut *tx)
    .await?;
    checkpoint_locked(&mut tx, lease, &state, now_ms).await?;
    guard(&mut tx, lease).await?;
    tx.commit().await?;
    Ok(state)
}

pub async fn active_cluster(pool: &PgPool) -> Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM control_cluster_activation)")
            .fetch_one(pool)
            .await?,
    )
}

pub async fn register_instance(
    pool: &PgPool,
    node: Uuid,
    instance: Uuid,
    origin: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO control_nodes(id,route_origin,incarnation) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET route_origin=$2,incarnation=$3,heartbeat_at=clock_timestamp()")
       .bind(node).bind(origin).bind(instance).execute(pool).await?;
    Ok(())
}
pub async fn heartbeat_instance(pool: &PgPool, node: Uuid, instance: Uuid) -> Result<()> {
    let updated = sqlx::query(
        "UPDATE control_nodes SET heartbeat_at=clock_timestamp() WHERE id=$1 AND incarnation=$2",
    )
    .bind(node)
    .bind(instance)
    .execute(pool)
    .await?;
    ensure!(
        updated.rows_affected() == 1,
        "control_node_incarnation_lost"
    );
    Ok(())
}
