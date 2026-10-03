//! Login-bound admission is distinct from cleanup: cleanup never calls these gates.
use anyhow::Result;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

/// Caller holds room/snapshot admission. Lock membership then login, never I/O.
pub async fn capture(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    room: Uuid,
    login: &str,
) -> Result<Option<Uuid>> {
    let member: Option<Uuid> = sqlx::query_scalar(
        "SELECT membership_epoch FROM room_members WHERE user_id=$1 AND room_id=$2 FOR KEY SHARE",
    )
    .bind(user)
    .bind(room)
    .fetch_optional(&mut **tx)
    .await?;
    if member.is_none() || !lock_login(tx, user, login).await? {
        return Ok(None);
    }
    let allowed: bool = sqlx::query_scalar("SELECT playback_origin_allowed($1,$2,$3,$4)")
        .bind(user)
        .bind(room)
        .bind(login)
        .bind(member)
        .fetch_one(&mut **tx)
        .await?;
    Ok(member.filter(|_| allowed))
}

pub async fn lock_login(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    login: &str,
) -> Result<bool> {
    let row: Option<String> = sqlx::query_scalar(
        "SELECT token_hash FROM sessions WHERE user_id=$1 AND token_hash=$2 FOR SHARE",
    )
    .bind(user)
    .bind(login)
    .fetch_optional(&mut **tx)
    .await?;
    if row.is_none() {
        return Ok(false);
    }
    Ok(
        sqlx::query_scalar("SELECT COALESCE(playback_login_allowed($1,$2),false)")
            .bind(user)
            .bind(login)
            .fetch_one(&mut **tx)
            .await?,
    )
}

pub async fn lock_request(tx: &mut Transaction<'_, Postgres>, session: Uuid) -> Result<bool> {
    let row=sqlx::query("SELECT user_id,room_id,auth_login_hash,auth_membership_epoch FROM playback_requests WHERE session_id=$1")
        .bind(session).fetch_optional(&mut **tx).await?;
    let Some(row) = row else { return Ok(false) };
    let Some(login) = row.get::<Option<String>, _>("auth_login_hash") else {
        return Ok(false);
    };
    Ok(
        capture(tx, row.get("user_id"), row.get("room_id"), &login).await?
            == row.get::<Option<Uuid>, _>("auth_membership_epoch"),
    )
}

pub async fn lock_origin(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    room: Uuid,
    login: Option<&str>,
    member: Option<Uuid>,
) -> Result<bool> {
    let Some(login) = login else { return Ok(true) }; // grandfathered, never reassigned
    Ok(capture(tx, user, room, login)
        .await?
        .is_some_and(|epoch| Some(epoch) == member))
}
