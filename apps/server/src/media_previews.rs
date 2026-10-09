use super::*;

pub use catalog::previews::{ImageQuery, Query, Request};

pub async fn request(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Request>,
) -> Result<Response> {
    let user = auth(&app, &h, true).await?;
    Ok(responses::ok_json(json!(
        catalog::previews::request(&app.db, user.id, body, &|| app.preview_settings.queue_limit)
            .await?
    )))
}
pub async fn status(
    State(app): State<App>,
    h: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<Query>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    Ok(responses::ok_json(json!(
        catalog::previews::status(&app.db, user.id, q).await?
    )))
}
pub async fn image(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<ImageQuery>,
) -> Result<Response> {
    let user = auth_viewer(&app, &h, false).await?;
    let row = catalog::previews::image(&app.db, user.id, id, q).await?;
    let etag = format!("\"{}\"", row.sha256());
    let unchanged = h.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(&etag);
    let mut response = if unchanged {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        ([(header::CONTENT_TYPE, "image/webp")], row.into_bytes()).into_response()
    };
    response
        .headers_mut()
        .insert(header::ETAG, etag.parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-cache".parse().unwrap());
    Ok(response)
}
