use super::*;
use persistence::media_previews::{FRESH, VALID};

pub use catalog::media_projection::cover;

fn bounded(mut ids: Vec<Uuid>) -> Result<Vec<Uuid>> {
    ids.sort();
    ids.dedup();
    if ids.len() > 24 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    Ok(ids)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    media_ids: Vec<Uuid>,
}
#[derive(Deserialize)]
pub struct Query {
    #[serde(default)]
    ids: String,
}
pub async fn request(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Request>,
) -> Result<Response> {
    let user = auth(&app, &h, true).await?;
    let ids = bounded(body.media_ids)?;
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM media_items WHERE id=ANY($1) AND library_media_allowed($2,id,'browse',NULL)").bind(&ids).bind(user.id).fetch_all(&app.db).await?;
    if !persistence::media_previews::enqueue(&app.db, &ids, app.preview_settings.queue_limit)
        .await?
    {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "media_preview_queue_full",
        ));
    }
    states(&app, user.id, &ids).await
}
pub async fn status(
    State(app): State<App>,
    h: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<Query>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    let ids = if q.ids.is_empty() {
        vec![]
    } else {
        q.ids
            .split(',')
            .map(Uuid::parse_str)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_request"))?
    };
    states(&app, user.id, &bounded(ids)?).await
}
async fn states(app: &App, user: Uuid, ids: &[Uuid]) -> Result<Response> {
    let rows=sqlx::query(&format!("SELECT m.id,p.status AS preview_status,p.result_revision AS preview_revision FROM media_items m JOIN sources s ON s.id=m.source_id LEFT JOIN media_previews p ON p.media_id=m.id AND {FRESH} WHERE m.id=ANY($1) AND {VALID} AND library_media_allowed($2,m.id,'browse',NULL)"))
        .bind(ids).bind(user).fetch_all(&app.db).await?;
    Ok(responses::ok_json(
        json!({"items":rows.iter().map(|r|json!({"media_id":r.get::<Uuid,_>("id"),"cover":cover(r)})).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
pub struct ImageQuery {
    revision: Uuid,
    room_id: Option<Uuid>,
}
pub async fn image(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<ImageQuery>,
) -> Result<Response> {
    let user = auth_viewer(&app, &h, false).await?;
    let mut tx = app.db.begin().await?;
    // Keep authorization valid through the read, including NAS revocation.
    let source: Option<Uuid> =
        sqlx::query_scalar("SELECT source_id FROM media_items WHERE id=$1 AND available AND library_media_allowed($2,id,CASE WHEN $3::uuid IS NULL THEN 'browse' ELSE 'play' END,$3)")
            .bind(id).bind(user.id).bind(q.room_id)
            .fetch_optional(&mut *tx)
            .await?;
    let source = source.ok_or_else(|| err(StatusCode::NOT_FOUND, "media_not_found"))?;
    sqlx::query("SELECT l.id FROM private_libraries l JOIN sources s ON s.library_id=l.id WHERE s.id=$1 FOR SHARE OF l")
        .bind(source).execute(&mut *tx).await?;
    sqlx::query("SELECT id FROM media_items WHERE id=$1 AND available FOR SHARE")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM agents WHERE id=$1 FOR SHARE")
        .bind(source)
        .execute(&mut *tx)
        .await?;
    let row=sqlx::query(&format!("SELECT p.image,p.image_sha256 FROM media_previews p JOIN media_items m ON m.id=p.media_id JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND library_media_allowed($3,m.id,CASE WHEN $4::uuid IS NULL THEN 'browse' ELSE 'play' END,$4) AND p.result_revision=$2 AND p.status='ready' AND {VALID} AND {FRESH}"))
        .bind(id).bind(q.revision).bind(user.id).bind(q.room_id).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::CONFLICT,"media_preview_stale"))?;
    // Throttle LRU writes; a read should not write for every revalidation.
    sqlx::query("UPDATE media_previews SET accessed_at=clock_timestamp() WHERE media_id=$1 AND accessed_at<clock_timestamp()-interval '1 minute'").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    let etag = format!("\"{}\"", row.get::<String, _>("image_sha256"));
    let unchanged = h.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(&etag);
    let mut response = if unchanged {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        (
            [(header::CONTENT_TYPE, "image/webp")],
            row.get::<Vec<u8>, _>("image"),
        )
            .into_response()
    };
    response
        .headers_mut()
        .insert(header::ETAG, etag.parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-cache".parse().unwrap());
    Ok(response)
}
