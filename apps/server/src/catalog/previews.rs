//! Preview use cases preserve the original queue and image transaction owners.
use super::media_projection::cover;
use crate::{Result, err};
use axum::http::StatusCode;
use persistence::media_previews::{FRESH, VALID};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// A result of the original image transaction, not a continuing authority token.
pub struct ImageRead {
    row: sqlx::postgres::PgRow,
}
impl ImageRead {
    pub fn sha256(&self) -> String {
        self.row.get::<String, _>("image_sha256")
    }
    pub fn into_bytes(self) -> Vec<u8> {
        self.row.get::<Vec<u8>, _>("image")
    }
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
    db: &PgPool,
    viewer: Uuid,
    body: Request,
    queue_limit: &(dyn Fn() -> i64 + Sync),
) -> Result<Value> {
    let ids = bounded(body.media_ids)?;
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM media_items WHERE id=ANY($1) AND library_media_allowed($2,id,'browse',NULL)").bind(&ids).bind(viewer).fetch_all(db).await?;
    if !persistence::media_previews::enqueue(db, &ids, queue_limit()).await? {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "media_preview_queue_full",
        ));
    }
    states(db, viewer, &ids).await
}
pub async fn status(db: &PgPool, viewer: Uuid, q: Query) -> Result<Value> {
    let ids = if q.ids.is_empty() {
        vec![]
    } else {
        q.ids
            .split(',')
            .map(Uuid::parse_str)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_request"))?
    };
    states(db, viewer, &bounded(ids)?).await
}
async fn states(db: &PgPool, user: Uuid, ids: &[Uuid]) -> Result<Value> {
    let rows=sqlx::query(&format!("SELECT m.id,p.status AS preview_status,p.result_revision AS preview_revision FROM media_items m JOIN sources s ON s.id=m.source_id LEFT JOIN media_previews p ON p.media_id=m.id AND {FRESH} WHERE m.id=ANY($1) AND {VALID} AND library_media_allowed($2,m.id,'browse',NULL)"))
        .bind(ids).bind(user).fetch_all(db).await?;
    Ok(
        json!({"items":rows.iter().map(|r|json!({"media_id":r.get::<Uuid,_>("id"),"cover":cover(r)})).collect::<Vec<_>>()}),
    )
}

#[derive(Deserialize)]
pub struct ImageQuery {
    revision: Uuid,
    room_id: Option<Uuid>,
}
pub async fn image(db: &PgPool, viewer: Uuid, id: Uuid, q: ImageQuery) -> Result<ImageRead> {
    let mut tx = db.begin().await?;
    // Keep authorization valid through the read, including NAS revocation.
    let source: Option<Uuid> =
        sqlx::query_scalar("SELECT source_id FROM media_items WHERE id=$1 AND available AND library_media_allowed($2,id,CASE WHEN $3::uuid IS NULL THEN 'browse' ELSE 'play' END,$3)")
            .bind(id).bind(viewer).bind(q.room_id)
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
        .bind(id).bind(q.revision).bind(viewer).bind(q.room_id).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::CONFLICT,"media_preview_stale"))?;
    // Throttle LRU writes; a read should not write for every revalidation.
    sqlx::query("UPDATE media_previews SET accessed_at=clock_timestamp() WHERE media_id=$1 AND accessed_at<clock_timestamp()-interval '1 minute'").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(ImageRead { row })
}
