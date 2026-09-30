//! Lifecycle locks precede snapshot, preparation, session and job locks.
//! Holding this lock through publication fences every grant against close/reopen.
use anyhow::{Result, bail};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub async fn lock_active(tx: &mut Transaction<'_, Postgres>, room: Uuid) -> Result<i64> {
    let row =
        sqlx::query("SELECT lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
            .bind(room)
            .fetch_one(&mut **tx)
            .await?;
    if row.get::<String, _>("lifecycle") != "active" {
        bail!("room_not_active");
    }
    Ok(row.get("lifecycle_epoch"))
}

pub async fn lock_epoch(tx: &mut Transaction<'_, Postgres>, room: Uuid, epoch: i64) -> Result<()> {
    if lock_active(tx, room).await? != epoch {
        bail!("room_not_active");
    }
    Ok(())
}
