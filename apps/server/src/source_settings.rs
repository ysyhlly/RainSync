//! HTTP adaptation for source settings; catalog operations own the transaction.
use super::*;
pub use catalog::source_settings::Change;

pub async fn get(State(app): State<App>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Response> {
    let user = identity::request::authenticate(app.identity_context(), &h, false, false).await?;
    admin(&user)?;
    let context = catalog::SourceReadContext {
        db: &app.db,
        decrypt: &|value| app.decrypt(value),
    };
    Ok(responses::ok_json(
        catalog::source_settings::get(context, &user, &h, id).await?,
    ))
}
pub async fn change(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Change>,
) -> Result<Response> {
    let user = identity::request::authenticate(app.identity_context(), &h, true, false).await?;
    admin(&user)?;
    let context = catalog::SourceChangeContext {
        db: &app.db,
        encrypt: &|value| app.encrypt(value),
        decrypt: &|value| app.decrypt(value),
    };
    let committed = catalog::source_settings::change(context, &user, &h, id, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}
