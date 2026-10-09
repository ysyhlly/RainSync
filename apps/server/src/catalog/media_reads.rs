//! Bounded media reads with current per-request browse visibility.
use super::media_projection::{self, BROWSE, SELECT, media};
use crate::{Result, err};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct LibraryQuery {
    after: Option<Uuid>,
    limit: Option<i64>,
    #[serde(default)]
    search: String,
}
pub async fn list(db: &PgPool, viewer: Uuid, query: LibraryQuery) -> Result<Value> {
    let rows=sqlx::query(&format!("{} WHERE {} AND ($2::uuid IS NULL OR m.id>$2) AND strpos(lower(COALESCE(u.title,m.shared_title,m.title)),lower($3))>0 ORDER BY m.id LIMIT $4", media_projection::SELECT, media_projection::BROWSE))
        .bind(viewer).bind(query.after).bind(query.search).bind(query.limit.unwrap_or(100).clamp(1,200)).fetch_all(db).await?;
    Ok(Value::Array(
        rows.iter().map(media_projection::media).collect(),
    ))
}

#[derive(Deserialize)]
pub struct MediaQuery {
    after: Option<Uuid>,
    limit: Option<i64>,
    #[serde(default)]
    search: String,
}
pub async fn list_private(db: &PgPool, viewer: Uuid, id: Uuid, q: MediaQuery) -> Result<Value> {
    let allowed: bool = sqlx::query_scalar("SELECT library_allowed($1,$2,'browse')")
        .bind(viewer)
        .bind(id)
        .fetch_one(db)
        .await?;
    if !allowed {
        return Err(err(StatusCode::NOT_FOUND, "library_not_found"));
    }
    let rows=sqlx::query(&format!("{} WHERE {} AND s.library_id=$2 AND library_media_allowed($1,m.id,'browse',NULL) AND ($3::uuid IS NULL OR m.id>$3) AND strpos(lower(COALESCE(u.title,m.shared_title,m.title)),lower($4))>0 ORDER BY m.id LIMIT $5",media_projection::SELECT,media_projection::VISIBLE))
      .bind(viewer).bind(id).bind(q.after).bind(q.search).bind(q.limit.unwrap_or(100).clamp(1,200)).fetch_all(db).await?;
    Ok(json!(
        rows.iter().map(media_projection::media).collect::<Vec<_>>()
    ))
}

pub async fn read(db: &PgPool, viewer: Uuid, id: Uuid) -> Result<Value> {
    let row = sqlx::query(&format!("{SELECT} WHERE {BROWSE} AND m.id=$2"))
        .bind(viewer)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "media_not_found"))?;
    Ok(media(&row))
}
