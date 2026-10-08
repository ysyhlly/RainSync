//! Atomic invite redemption under the caller's room lifecycle lock.
use anyhow::{Result, bail};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub async fn redeem(
    tx: &mut Transaction<'_, Postgres>,
    room: Uuid,
    user: Uuid,
    token_hash: &str,
) -> Result<()> {
    let row=sqlx::query("SELECT invited_user_id,granted_role,permissions,grant_expires_at,created_by,max_uses,use_count,expires_at>clock_timestamp() AND NOT revoked AND account_active(created_by) AND account_active(invited_user_id) AS valid FROM invites WHERE room_id=$1 AND token_hash=$2 FOR UPDATE")
        .bind(room).bind(token_hash).fetch_optional(&mut **tx).await?.ok_or_else(||anyhow::anyhow!("invalid_invite"))?;
    if !row.get::<bool, _>("valid")
        || row
            .get::<Option<Uuid>, _>("invited_user_id")
            .is_some_and(|target| target != user)
    {
        bail!("invalid_invite");
    }
    let still_valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM invites WHERE room_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp() AND NOT revoked AND account_active(created_by) AND account_active(invited_user_id))")
        .bind(room).bind(token_hash).fetch_one(&mut **tx).await?;
    if !still_valid {
        bail!("invalid_invite");
    }
    let epoch: Option<Uuid> = sqlx::query_scalar(
        "SELECT membership_epoch FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(room)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?;
    let previous: Option<Uuid> = sqlx::query_scalar(
        "SELECT membership_epoch FROM room_invite_redemptions WHERE token_hash=$1 AND user_id=$2",
    )
    .bind(token_hash)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?;
    // Retrying a completed join is safe and never restores a later-revoked grant.
    if epoch.is_some() && epoch == previous {
        return Ok(());
    }
    let max: Option<i32> = row.get("max_uses");
    if max.is_some_and(|max| row.get::<i32, _>("use_count") >= max) {
        bail!("invalid_invite");
    }
    if epoch.is_none() {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM room_members WHERE room_id=$1 AND account_active(user_id)",
        )
        .bind(room)
        .fetch_one(&mut **tx)
        .await?;
        if count >= 10 {
            bail!("room_full");
        }
    }
    let epoch:Uuid=sqlx::query_scalar("INSERT INTO room_members(room_id,user_id) VALUES($1,$2) ON CONFLICT(room_id,user_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING membership_epoch")
        .bind(room).bind(user).fetch_one(&mut **tx).await?;
    let updated=sqlx::query("UPDATE invites SET use_count=use_count+1 WHERE room_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp() AND NOT revoked AND account_active(created_by) AND account_active(invited_user_id) AND (max_uses IS NULL OR use_count<max_uses)")
        .bind(room).bind(token_hash).execute(&mut **tx).await?;
    if updated.rows_affected() != 1 {
        bail!("invalid_invite");
    }
    let role: String = row.get("granted_role");
    if role == "moderator" {
        // Keep the original grantor. An inviter can never elevate the invite's policy.
        sqlx::query("INSERT INTO room_member_permissions(room_id,user_id,role,permissions,expires_at,granted_by) SELECT $1,$2,granted_role,permissions,grant_expires_at,created_by FROM invites WHERE token_hash=$3 AND created_by IS NOT NULL ON CONFLICT(room_id,user_id) DO UPDATE SET role=EXCLUDED.role,permissions=EXCLUDED.permissions,expires_at=EXCLUDED.expires_at,revoked=false,granted_by=EXCLUDED.granted_by,updated_at=clock_timestamp()")
            .bind(room).bind(user).bind(token_hash).execute(&mut **tx).await?;
    }
    sqlx::query("INSERT INTO room_invite_redemptions(token_hash,user_id,membership_epoch) VALUES($1,$2,$3) ON CONFLICT(token_hash,user_id) DO UPDATE SET membership_epoch=EXCLUDED.membership_epoch,redeemed_at=clock_timestamp()")
        .bind(token_hash).bind(user).bind(epoch).execute(&mut **tx).await?;
    Ok(())
}
