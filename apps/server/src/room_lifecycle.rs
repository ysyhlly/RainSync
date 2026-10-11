use super::*;

#[path = "room_management_authority.rs"]
pub(crate) mod management_authority;

pub use rooms::lifecycle_operations::Change;

pub fn gate_error(error: anyhow::Error) -> Error {
    match error.to_string().as_str() {
        "room_not_active" => err(StatusCode::CONFLICT, "room_not_active"),
        _ => error.into(),
    }
}

pub async fn status(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    Ok(responses::ok_json(
        rooms::lifecycle_operations::status(app.identity_context(), &h, id).await?,
    ))
}

pub async fn close(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Change>,
) -> Result<Response> {
    let committed = rooms::lifecycle_operations::close(
        app.identity_context(),
        &h,
        id,
        body,
        app.start,
        app.epoch,
    )
    .await?;
    rooms::lifecycle_changed(
        &app,
        &committed.state,
        "closing",
        committed.lifecycle_epoch,
        committed.event_id,
    )
    .await;
    Ok(responses::ok_json(
        json!({"lifecycle":"closing","lifecycle_epoch":committed.lifecycle_epoch,"owner_id":committed.owner_id,"state":committed.state,"event_id":committed.event_id}),
    ))
}

/// Reschedule the current closing epoch without stealing a live cleanup owner,
/// reopening admission, revoking new state, or manufacturing any owner receipt.
pub async fn retry_cleanup(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Change>,
) -> Result<Response> {
    Ok(responses::ok_json(
        rooms::lifecycle_operations::retry_cleanup(app.identity_context(), &h, id, body).await?,
    ))
}
pub async fn reopen(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Change>,
) -> Result<Response> {
    let committed = rooms::lifecycle_operations::reopen(
        app.identity_context(),
        &h,
        id,
        body,
        app.start,
        app.epoch,
    )
    .await?;
    rooms::lifecycle_changed(
        &app,
        &committed.state,
        "active",
        committed.lifecycle_epoch,
        committed.event_id,
    )
    .await;
    Ok(responses::ok_json(
        json!({"lifecycle":"active","lifecycle_epoch":committed.lifecycle_epoch,"owner_id":committed.owner_id,"state":committed.state,"event_id":committed.event_id}),
    ))
}

pub async fn archive(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Change>,
) -> Result<Response> {
    let committed = rooms::lifecycle_operations::archive(
        app.identity_context(),
        &h,
        id,
        body,
        app.start,
        app.epoch,
    )
    .await?;
    rooms::lifecycle_changed(
        &app,
        &committed.state,
        "archived",
        committed.lifecycle_epoch,
        committed.event_id,
    )
    .await;
    Ok(responses::ok_json(
        json!({"lifecycle":"archived","lifecycle_epoch":committed.lifecycle_epoch,"owner_id":committed.owner_id,"state":committed.state,"event_id":committed.event_id}),
    ))
}
