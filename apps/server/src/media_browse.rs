//! HTTP adaptation for the bounded catalog hierarchy projection.
use super::*;

pub use catalog::browse::BrowseQuery;

pub async fn browse(
    State(app): State<App>,
    h: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<BrowseQuery>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    Ok(responses::ok_json(
        catalog::browse::browse(&app.db, user.id, query).await?,
    ))
}
