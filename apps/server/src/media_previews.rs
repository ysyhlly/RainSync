use super::*;

pub use catalog::previews::{ImageQuery, Query, Request};

pub async fn request(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Request>,
) -> Result<Response> {
    Ok(responses::ok_json(json!(
        catalog::previews::request(
            app.identity_context(),
            &h,
            body,
            catalog::previews::QueueLimit::new(&app.preview_settings.queue_limit),
        )
        .await?
    )))
}
pub async fn status(
    State(app): State<App>,
    h: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<Query>,
) -> Result<Response> {
    Ok(responses::ok_json(json!(
        catalog::previews::status(app.identity_context(), &h, q).await?
    )))
}
pub async fn image(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<ImageQuery>,
) -> Result<Response> {
    let row = catalog::previews::image(app.identity_context(), &h, id, q).await?;
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
