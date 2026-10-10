use super::*;
use protocol::RoomPermission;

pub use super::permission_operations::Grant;

pub async fn permissions(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
) -> Result<Response> {
    Ok(responses::ok_json(
        super::permission_operations::permissions(app.identity_context(), &h, room).await?,
    ))
}

pub async fn set_permissions(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, target)): Path<(Uuid, Uuid)>,
    Json(body): Json<Grant>,
) -> Result<Json<Value>> {
    super::permission_operations::set_permissions(app.identity_context(), &h, room, target, body)
        .await?;
    broadcast_timeline(
        &app,
        room,
        json!({"type":"ROOM_PERMISSIONS_CHANGED","user_id":target}),
    )
    .await;
    Ok(Json(json!({"ok":true})))
}

pub async fn revoke_permissions(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, target)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    super::permission_operations::revoke_permissions(app.identity_context(), &h, room, target)
        .await?;
    broadcast_timeline(
        &app,
        room,
        json!({"type":"ROOM_PERMISSIONS_CHANGED","user_id":target}),
    )
    .await;
    Ok(Json(json!({"ok":true})))
}

pub async fn kick(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, target)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let actor = auth(&app, &h, true).await?;
    let mut tx = controller_for_permission(&app, &h, room, RoomPermission::Kick).await?;
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
    commit_controller(tx, &h).await?;
    broadcast_timeline(
        &app,
        room,
        json!({"type":"ROOM_PERMISSIONS_CHANGED","user_id":target}),
    )
    .await;
    Ok(Json(json!({"ok":true})))
}
