use super::{commit_controller, controller_admission};
use crate::identity::{RequestContext, request};
use crate::{Result, err};
use axum::http::{HeaderMap, StatusCode};
use protocol::RoomPermission;
use serde_json::Value;
use uuid::Uuid;

pub(crate) async fn kick(
    context: RequestContext<'_>,
    h: &HeaderMap,
    room: Uuid,
    target: Uuid,
) -> Result<()> {
    let db = context.db;
    let origin = context.origin;
    let actor = request::authenticate(context, h, true, false).await?;
    let controller = request::authenticate(RequestContext { db, origin }, h, true, false).await?;
    request::member(db, &controller, room).await?;
    let mut tx = controller_admission(db, controller, h, room, RoomPermission::Kick, true).await?;
    let owner: Uuid = sqlx::query_scalar("SELECT owner_id FROM rooms WHERE id=$1")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    let state: protocol::RoomState = serde_json::from_value(
        sqlx::query_scalar::<_, Value>("SELECT state FROM room_snapshots WHERE room_id=$1")
            .bind(room)
            .fetch_one(&mut *tx)
            .await?,
    )
    .map_err(anyhow::Error::from)?;
    let target_admin: Option<bool> = sqlx::query_scalar("SELECT admin FROM users WHERE id=$1")
        .bind(target)
        .fetch_optional(&mut *tx)
        .await?;
    if target == owner
        || target == state.controller_user_id
        || target == actor.id
        || (target_admin == Some(true) && !actor.admin)
    {
        return Err(err(StatusCode::FORBIDDEN, "forbidden"));
    }
    sqlx::query("DELETE FROM control_epochs WHERE room_id=$1 AND user_id=$2")
        .bind(room)
        .bind(target)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE room_id=$1 AND user_id=$2")
        .bind(room)
        .bind(target)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM room_members WHERE room_id=$1 AND user_id=$2")
        .bind(room)
        .bind(target)
        .execute(&mut *tx)
        .await?;
    commit_controller(tx, h).await?;
    Ok(())
}
