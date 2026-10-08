//! Transaction-local room grants. Call after locking the room and membership.
use anyhow::{Result, bail};
use protocol::RoomPermission;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub async fn allowed(
    tx: &mut Transaction<'_, Postgres>,
    room: Uuid,
    user: Uuid,
    permission: RoomPermission,
) -> Result<bool> {
    // Room locking serializes managed grant changes; SHARE also protects against
    // an explicit SQL revocation while the admitted transaction is committing.
    sqlx::query(
        "SELECT user_id FROM room_member_permissions WHERE room_id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(room)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(
        sqlx::query_scalar("SELECT room_permission_allowed($1,$2,$3)")
            .bind(room)
            .bind(user)
            .bind(permission.as_str())
            .fetch_one(&mut **tx)
            .await?,
    )
}

pub async fn require(
    tx: &mut Transaction<'_, Postgres>,
    room: Uuid,
    user: Uuid,
    permission: RoomPermission,
) -> Result<()> {
    if !allowed(tx, room, user, permission).await? {
        bail!("controller_required");
    }
    Ok(())
}
