//! Source policy changes fence grants without claiming physical resource drain.
use super::*;
pub use catalog::access_policy::Change;

pub async fn guard(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    source: Uuid,
    revision: i64,
) -> Result<()> {
    let current: i64 =
        sqlx::query_scalar("SELECT access_policy_revision FROM sources WHERE id=$1 FOR SHARE")
            .bind(source)
            .fetch_one(&mut **tx)
            .await?;
    if current != revision {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    Ok(())
}
pub async fn change(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Change>,
) -> Result<Json<Value>> {
    let user =
        identity::request::authenticate(app.identity_context(), &headers, true, false).await?;
    admin(&user)?;
    let context = catalog::SourceChangeContext {
        db: &app.db,
        encrypt: &|value| app.encrypt(value),
        decrypt: &|value| app.decrypt(value),
    };
    let committed = catalog::access_policy::change(context, &user, &headers, id, body).await?;
    Ok(Json(committed.response(&app.db).await))
}
