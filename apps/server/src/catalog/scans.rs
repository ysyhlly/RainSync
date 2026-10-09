//! Shared source scans retain their complete enumeration and batch owners.
use super::{SourceReadContext, scan_pages};
use crate::{Result, err};
use axum::http::StatusCode;
use providers::SourceConfig;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::future::Future;
use uuid::Uuid;

/// Best-effort local metadata inspection receives only the configured root and
/// relative resource. Its adapter returns the existing inspection future.
pub trait LocalProbe: Sync {
    fn probe<'a>(
        &'a self,
        root: &'a str,
        resource: &'a str,
    ) -> impl Future<Output = Result<(Value, String)>> + Send + 'a;
}

pub async fn scan(
    context: &SourceReadContext<'_>,
    id: Uuid,
    local_probe: &impl LocalProbe,
) -> Result<Value> {
    let mut tx = context.db.begin().await?;
    let row = sqlx::query(
        "SELECT kind,config_encrypted FROM sources WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    if row.get::<String, _>("kind") == "s3" {
        tx.commit().await?;
        let status: Option<String> =
            sqlx::query_scalar("SELECT status FROM s3_index_scans WHERE source_id=$1")
                .bind(id)
                .fetch_optional(context.db)
                .await?;
        let restart = status.as_deref().is_none_or(|v| v == "completed");
        let mut value = scan_pages::scan_source_page(context, id, restart).await?;
        value["count"] = value["item_count"].clone();
        return Ok(value);
    }
    let config: SourceConfig = serde_json::from_value((context.decrypt)(
        &row.get::<String, _>("config_encrypted"),
    )?)
    .map_err(anyhow::Error::from)?;
    let generation = Uuid::new_v4();
    sqlx::query("INSERT INTO source_scans(source_id,generation) VALUES($1,$2) ON CONFLICT(source_id) DO UPDATE SET generation=EXCLUDED.generation")
        .bind(id).bind(generation).execute(&mut *tx).await?;
    tx.commit().await?;
    let kind: String = row.get("kind");
    let encrypted: String = row.get("config_encrypted");
    let items = providers::list_items_guarded(&kind, &config, || async {
        let mut tx = context.db.begin().await?;
        guard_scan_config(&mut tx, id, &kind, &encrypted)
            .await
            .map_err(|_| anyhow::anyhow!("source_scan_superseded"))?;
        let current: Option<Uuid> =
            sqlx::query_scalar("SELECT generation FROM source_scans WHERE source_id=$1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        anyhow::ensure!(current == Some(generation), "source_scan_superseded");
        Ok(tx)
    })
    .await
    .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_scan_failed"))?;
    let count = items.len();
    let resources: Vec<String> = items.iter().map(|i| i.resource.clone()).collect();
    let mut batch = Vec::with_capacity(32);
    for mut item in items {
        if row.get::<String, _>("kind") == "local"
            && let Ok((meta, version)) = local_probe.probe(&config.root, &item.resource).await
        {
            item.duration_ms = meta["format"]["duration"]
                .as_str()
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map(|v| v * 1000.0);
            item.metadata = meta;
            item.metadata["preview_file_version"] = json!(version);
            let mut sidecars = serde_json::Map::new();
            for (i, ext) in ["srt", "vtt"].iter().enumerate() {
                let relative = std::path::Path::new(&item.resource)
                    .with_extension(ext)
                    .to_string_lossy()
                    .replace('\\', "/");
                if media_core::safe_local_path(std::path::Path::new(&config.root), &relative)
                    .is_ok()
                {
                    sidecars.insert((100000 + i).to_string(), json!(relative));
                }
            }
            item.metadata["sidecars"] = Value::Object(sidecars);
        }
        if row.get::<String, _>("kind") != "local" {
            item.metadata["preview_scan"] = json!(generation);
        }
        batch.push(item);
        if batch.len() == 32 {
            save_scan_batch(context.db, id, generation, &kind, &encrypted, &mut batch).await?;
        }
    }
    save_scan_batch(context.db, id, generation, &kind, &encrypted, &mut batch).await?;
    let mut tx = context.db.begin().await?;
    guard_scan_config(&mut tx, id, &kind, &encrypted).await?;
    guard_scan(&mut tx, id, generation).await?;
    sqlx::query(
        "UPDATE media_items SET available=false WHERE source_id=$1 AND NOT(resource=ANY($2))",
    )
    .bind(id)
    .bind(&resources)
    .execute(&mut *tx)
    .await?;
    if row.get::<String, _>("kind") == "http" {
        sqlx::query("UPDATE media_items SET library_source_generation=library_source_generation+1 WHERE source_id=$1 AND available").bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(json!({"count":count}))
}

async fn guard_scan_config(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    kind: &str,
    encrypted: &str,
) -> Result<()> {
    let row = sqlx::query(
        "SELECT kind,config_encrypted FROM sources WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    if !row.is_some_and(|row| {
        row.get::<String, _>("kind") == kind
            && row.get::<String, _>("config_encrypted") == encrypted
    }) {
        return Err(err(StatusCode::CONFLICT, "source_scan_failed"));
    }
    Ok(())
}

async fn guard_scan(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    generation: Uuid,
) -> Result<()> {
    // Lock source authority before the scan row, matching source removal's
    // lock order. A delayed provider response cannot recreate removed media.
    sqlx::query("SELECT id FROM sources WHERE id=$1 AND deleted_at IS NULL FOR SHARE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    let current: Uuid =
        sqlx::query_scalar("SELECT generation FROM source_scans WHERE source_id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    if current != generation {
        return Err(err(StatusCode::CONFLICT, "source_scan_failed"));
    }
    Ok(())
}

async fn save_scan_batch(
    db: &PgPool,
    id: Uuid,
    generation: Uuid,
    kind: &str,
    encrypted: &str,
    batch: &mut Vec<providers::Item>,
) -> Result<()> {
    let mut tx = db.begin().await?;
    guard_scan_config(&mut tx, id, kind, encrypted).await?;
    guard_scan(&mut tx, id, generation).await?;
    for item in batch.drain(..) {
        sqlx::query("INSERT INTO media_items(id,source_id,title,resource,duration_ms,metadata) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_id,resource) DO UPDATE SET title=EXCLUDED.title,duration_ms=EXCLUDED.duration_ms,metadata=EXCLUDED.metadata,available=true").bind(Uuid::new_v4()).bind(id).bind(item.title).bind(item.resource).bind(item.duration_ms).bind(item.metadata).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
