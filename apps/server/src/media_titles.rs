use super::*;
use crate::responses::ok_json;

pub use catalog::media_projection::{SELECT, VISIBLE, media};

pub async fn detail(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let user = identity::request::authenticate(app.identity_context(), &h, false, false).await?;
    Ok(ok_json(
        catalog::media_reads::read(&app.db, user.id, id).await?,
    ))
}

pub async fn personal(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Response> {
    Ok(ok_json(
        catalog::titles::change(app.identity_context(), h, id, body, false).await?,
    ))
}
pub async fn shared(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Response> {
    Ok(ok_json(
        catalog::titles::change(app.identity_context(), h, id, body, true).await?,
    ))
}
