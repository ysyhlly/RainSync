use super::*;

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
    super::kick_operations::kick(app.identity_context(), &h, room, target).await?;
    broadcast_timeline(
        &app,
        room,
        json!({"type":"ROOM_PERMISSIONS_CHANGED","user_id":target}),
    )
    .await;
    Ok(Json(json!({"ok":true})))
}
