use super::*;

pub use rooms::ownership_operations::Transfer;

pub async fn members(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    Ok(responses::ok_json(
        rooms::ownership_operations::members(app.identity_context(), &h, id).await?,
    ))
}

pub async fn transfer(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Transfer>,
) -> Result<Response> {
    let committed =
        rooms::ownership_operations::transfer(app.identity_context(), &h, id, body).await?;
    rooms::ownership_changed(
        &app,
        &committed.state,
        committed.owner_id,
        committed.event_id,
    )
    .await;
    Ok(responses::ok_json(
        json!({"owner_id":committed.owner_id,"state":committed.state,"event_id":committed.event_id}),
    ))
}
