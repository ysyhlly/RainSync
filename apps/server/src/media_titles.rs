use super::*;
use crate::responses::ok_json;

pub use catalog::media_projection::{BROWSE, SELECT, VISIBLE, media};

pub async fn read(app: &App, viewer: Uuid, id: Uuid) -> Result<Value> {
    let row = sqlx::query(&format!("{SELECT} WHERE {BROWSE} AND m.id=$2"))
        .bind(viewer)
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "media_not_found"))?;
    Ok(media(&row))
}

pub async fn detail(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    Ok(ok_json(read(&app, user.id, id).await?))
}

pub async fn personal(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Response> {
    change(app, h, id, body, false).await
}
pub async fn shared(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Response> {
    change(app, h, id, body, true).await
}
async fn change(app: App, h: HeaderMap, id: Uuid, body: Value, shared: bool) -> Result<Response> {
    let user = auth(&app, &h, true).await?;
    if shared {
        admin(&user)?;
    }
    Ok(ok_json(
        catalog::titles::change(&app.db, user, h, id, body, shared).await?,
    ))
}
