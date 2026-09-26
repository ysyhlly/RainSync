use anyhow::{Result, bail};
use protocol::{Command, RoomState};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use uuid::Uuid;

pub async fn connect(url: &str) -> Result<PgPool> {
    Ok(PgPoolOptions::new()
        .max_connections(12)
        .connect(url)
        .await?)
}
pub async fn migrate(pool: &PgPool) -> Result<()> {
    sqlx::migrate!("../../migrations").run(pool).await?;
    Ok(())
}
pub async fn snapshot(pool: &PgPool, id: Uuid) -> Result<RoomState> {
    let state: serde_json::Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1")
            .bind(id)
            .fetch_one(pool)
            .await?;
    Ok(serde_json::from_value(state)?)
}
pub async fn previous(
    pool: &PgPool,
    room: Uuid,
    command: &Command,
    user: Uuid,
) -> Result<Option<RoomState>> {
    let row =
        sqlx::query("SELECT state,user_id,request_payload FROM command_results WHERE room_id=$1 AND command_id=$2")
            .bind(room)
            .bind(command.command_id)
            .fetch_optional(pool)
            .await?;
    match row {
        None => Ok(None),
        Some(row) => {
            if row.get::<Uuid, _>("user_id") != user {
                bail!("command_owned_by_another_user")
            };
            let saved: Option<serde_json::Value> = row.get("request_payload");
            match saved {
                None => bail!("command_replay_unverifiable"),
                Some(saved) if saved != serde_json::to_value(command)? => {
                    bail!("command_payload_conflict")
                }
                Some(_) => {}
            }
            Ok(Some(serde_json::from_value(row.get("state"))?))
        }
    }
}
pub async fn commit(
    pool: &PgPool,
    state: &RoomState,
    command: &Command,
    user: Uuid,
    previous_revision: u32,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let value = serde_json::to_value(state)?;
    let result = sqlx::query(
        "UPDATE room_snapshots SET state=$2 WHERE room_id=$1 AND (state->>'revision')::bigint=$3",
    )
    .bind(state.room_id)
    .bind(&value)
    .bind(i64::from(previous_revision))
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() != 1 {
        bail!("revision_conflict")
    }
    sqlx::query("INSERT INTO room_events(room_id,revision,state) VALUES($1,$2,$3)")
        .bind(state.room_id)
        .bind(i64::from(state.revision))
        .bind(&value)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO command_results(room_id,command_id,user_id,state,request_payload) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(state.room_id)
    .bind(command.command_id)
    .bind(user)
    .bind(value)
    .bind(serde_json::to_value(command)?)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE room_id=$1 AND generation<>$2 AND NOT stopped").bind(state.room_id).bind(i64::from(state.media_generation)).execute(&mut *tx).await?;
    sqlx::query("UPDATE media_jobs SET status='cancelled' WHERE status IN('queued','running') AND session_id IN(SELECT id FROM playback_sessions WHERE room_id=$1 AND stopped)").bind(state.room_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
