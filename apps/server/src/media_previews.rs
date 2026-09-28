use super::*;
use persistence::media_previews::{FRESH, VALID};

pub fn cover(row: &sqlx::postgres::PgRow) -> Value {
    let status = row
        .get::<Option<String>, _>("preview_status")
        .unwrap_or("missing".into());
    let revision = row.get::<Option<Uuid>, _>("preview_revision");
    let id: Uuid = row.get("id");
    json!({"status":status,"revision":revision,"url":if status=="ready" {revision.map(|v|format!("/api/v1/media/{id}/cover?revision={v}"))}else{None},"retry_after_ms":match status.as_str(){"queued"|"running"=>Some(2000),"unavailable"=>Some(60000),_=>None}})
}
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
    auth(&app, &h, true).await?;
    let ids = bounded(body.media_ids)?;
    if !persistence::media_previews::enqueue(&app.db, &ids, app.preview_settings.queue_limit)
        .await?
    {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "media_preview_queue_full",
        ));
    }
    states(&app, &ids).await
}
pub async fn status(
    State(app): State<App>,
    h: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<Query>,
) -> Result<Response> {
    auth(&app, &h, false).await?;
    let ids = if q.ids.is_empty() {
        vec![]
    } else {
        q.ids
            .split(',')
            .map(Uuid::parse_str)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_request"))?
    };
    states(&app, &bounded(ids)?).await
}
async fn states(app: &App, ids: &[Uuid]) -> Result<Response> {
    let rows=sqlx::query(&format!("SELECT m.id,p.status AS preview_status,p.result_revision AS preview_revision FROM media_items m JOIN sources s ON s.id=m.source_id LEFT JOIN media_previews p ON p.media_id=m.id AND {FRESH} WHERE m.id=ANY($1) AND {VALID}"))
        .bind(ids).fetch_all(&app.db).await?;
    Ok(media_titles::private_json(
        json!({"items":rows.iter().map(|r|json!({"media_id":r.get::<Uuid,_>("id"),"cover":cover(r)})).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
pub struct ImageQuery {
    revision: Uuid,
}
pub async fn image(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<ImageQuery>,
) -> Result<Response> {
    auth(&app, &h, false).await?;
    let mut tx = app.db.begin().await?;
    // Keep authorization valid through the read, including NAS revocation.
    let source: Option<Uuid> =
        sqlx::query_scalar("SELECT source_id FROM media_items WHERE id=$1 AND available FOR SHARE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let source = source.ok_or_else(|| err(StatusCode::NOT_FOUND, "media_not_found"))?;
    sqlx::query("SELECT id FROM agents WHERE id=$1 FOR SHARE")
        .bind(source)
        .execute(&mut *tx)
        .await?;
    let row=sqlx::query(&format!("SELECT p.image,p.image_sha256 FROM media_previews p JOIN media_items m ON m.id=p.media_id JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND p.result_revision=$2 AND p.status='ready' AND {VALID} AND {FRESH}"))
        .bind(id).bind(q.revision).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::CONFLICT,"media_preview_stale"))?;
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
