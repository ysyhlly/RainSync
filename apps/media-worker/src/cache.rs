use super::*;

// Compatibility entry points only borrow ports and return the same core future.
// They add no awaited layer, snapshot, normalization or cache/resource owner.
pub fn check_output_capacity(
    app: &App,
) -> impl std::future::Future<Output = anyhow::Result<()>> + '_ {
    check_output_capacity_at(&app.cache)
}
pub fn reserve_output<'a>(
    app: &'a App,
    claim: &'a persistence::media_jobs::Claim,
) -> impl std::future::Future<Output = anyhow::Result<()>> + 'a {
    reserve_output_at(&app.db, &app.cache, claim)
}
pub fn ensure_capacity(app: &App) -> impl std::future::Future<Output = anyhow::Result<()>> + '_ {
    ensure_capacity_at(&app.db, &app.cache)
}
pub fn monitor(app: &App) -> impl std::future::Future<Output = anyhow::Error> + '_ {
    monitor_at(&app.db, &app.cache)
}

/// Apply only at cache-write sites, never to source reads or process spawning.
pub fn write_error(error: std::io::Error) -> anyhow::Error {
    use persistence::media_jobs::JobFailure;
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => JobFailure::CachePermissionDenied.into(),
        std::io::ErrorKind::ReadOnlyFilesystem => JobFailure::CacheReadOnly.into(),
        std::io::ErrorKind::StorageFull => JobFailure::CacheCapacityExceeded.into(),
        _ => error.into(),
    }
}

/// Completion must not trust the encoder exit code alone: some muxer write
/// failures can occur between periodic checks. Do not evict files here, since
/// freeing space would hide the failure we are trying to classify.
pub(crate) async fn check_output_capacity_at(cache: &std::path::Path) -> anyhow::Result<()> {
    let root = cache.to_path_buf();
    media_core::child_process::blocking(move || -> anyhow::Result<()> {
        let max = std::env::var("CACHE_MAX_BYTES")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(20 * 1024 * 1024 * 1024);
        anyhow::ensure!(
            fs2::available_space(&root)? as f64 / fs2::total_space(&root)? as f64 > 0.1,
            persistence::media_jobs::JobFailure::CacheCapacityExceeded
        );
        anyhow::ensure!(
            size(&root)? < max,
            persistence::media_jobs::JobFailure::CacheCapacityExceeded
        );
        Ok(())
    })
    .await??;
    Ok(())
}

pub(crate) async fn reserve_output_at(
    db: &PgPool,
    cache: &std::path::Path,
    claim: &persistence::media_jobs::Claim,
) -> anyhow::Result<()> {
    use persistence::cache_budget::{self, Admission};
    let output_bytes = claim.spec["estimated_output_bytes"]
        .as_u64()
        .unwrap_or_else(|| {
            std::env::var("CACHE_UNKNOWN_OUTPUT_BYTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|v| *v > 0)
                .unwrap_or(2 * 1024 * 1024 * 1024)
        });
    // Descriptor-backed remote subtitle/HDR recipes reserve their complete
    // finite materialization together with the original output writer slot.
    // Asset copies are source-associated and bounded before this admission.
    let input_bytes = claim.spec["held_input_bytes"].as_u64().unwrap_or(0);
    let asset_bytes = if let Some(value) = claim.spec.get("advanced_assets") {
        let catalog: media_core::advanced_media::AssetCatalog =
            serde_json::from_value(value.clone())?;
        if claim.spec["kind"] == "remote_asset_transcode_v1" {
            let remote: media_core::advanced_media::RemoteAssetCatalog =
                serde_json::from_value(claim.spec["advanced_remote_assets"].clone())?;
            remote.validate(
                claim.spec["source_kind"].as_str().unwrap_or(""),
                claim.spec["resource"].as_str().unwrap_or(""),
                claim.spec["source_version"].as_str(),
            )?;
            anyhow::ensure!(
                remote.catalog == catalog,
                "advanced_asset_source_binding_required"
            );
        } else {
            catalog.validate(
                claim.spec["resource"].as_str().unwrap_or(""),
                claim.spec["source_version"].as_str().unwrap_or(""),
            )?;
        }
        let copied_fonts = if claim.spec["kind"] == "remote_asset_transcode_v1" {
            catalog.fonts.iter().map(|f| f.bytes).sum()
        } else {
            0
        };
        catalog
            .bytes()
            .checked_add(copied_fonts)
            .ok_or_else(|| anyhow::anyhow!("advanced_media_cache_bound"))?
    } else {
        0
    };
    let bytes = output_bytes
        .checked_add(input_bytes)
        .and_then(|v| v.checked_add(asset_bytes))
        .ok_or_else(|| anyhow::anyhow!("advanced_media_cache_bound"))?;
    for _ in 0..4 {
        let revision = cache_budget::snapshot(db).await?;
        let root = cache.to_path_buf();
        let headroom =
            media_core::child_process::blocking(move || reservation_headroom(&root)).await??;
        match cache_budget::reserve(db, claim, revision, bytes, headroom).await? {
            Admission::Reserved => return Ok(()),
            Admission::Changed => continue,
            Admission::Full => {
                let held = cache_budget::reserved_bytes(db).await?;
                ensure_headroom(db, cache, bytes.saturating_add(held)).await?;
            }
            Admission::Stale => return Err(process::LeaseInterrupted.into()),
        }
    }
    Err(process::LeaseInterrupted.into())
}

/// Read-only capacity observation. A caller must obtain the budget revision
/// before this filesystem observation and recheck it in the admission transaction.
pub(super) fn reservation_headroom(root: &std::path::Path) -> anyhow::Result<u64> {
    let max = std::env::var("CACHE_MAX_BYTES")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(20 * 1024 * 1024 * 1024);
    let quota = max.saturating_sub(size(root)?);
    let free = fs2::available_space(root)?;
    let disk = free.saturating_sub(fs2::total_space(root)? / 10);
    Ok(quota.min(disk))
}
fn size(path: &std::path::Path) -> std::io::Result<u64> {
    let mut bytes = 0;
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let metadata = match std::fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let ty = metadata.file_type();
        if ty.is_symlink() {
            continue;
        }
        bytes += if ty.is_dir() {
            size(&entry.path())?
        } else {
            metadata.len()
        };
    }
    Ok(bytes)
}
pub(crate) async fn ensure_capacity_at(db: &PgPool, cache: &std::path::Path) -> anyhow::Result<()> {
    ensure_headroom(db, cache, 0).await
}

async fn ensure_headroom(db: &PgPool, cache: &std::path::Path, needed: u64) -> anyhow::Result<()> {
    persistence::cache::cleanup(db).await?;
    let root = cache.canonicalize()?;
    let scan_root = root.clone();
    let (mut total, candidates) =
        media_core::child_process::blocking(move || -> anyhow::Result<_> {
            let candidates = std::fs::read_dir(&scan_root)?
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()))
                .filter_map(|e| Uuid::parse_str(&e.file_name().to_string_lossy()).ok())
                .collect::<Vec<_>>();
            Ok((size(&scan_root)?, candidates))
        })
        .await??;
    sqlx::query("INSERT INTO cache_entries(id,cache_key,path) SELECT v,v::text,v::text FROM unnest($1::uuid[]) AS v ON CONFLICT DO NOTHING")
        .bind(&candidates)
        .execute(db)
        .await?;
    let candidates =
        sqlx::query("SELECT id,state='evicting' AS pending FROM cache_entries WHERE id=ANY($1) OR state='evicting' ORDER BY last_used,id")
            .bind(&candidates)
            .fetch_all(db)
            .await?;
    let max = std::env::var("CACHE_MAX_BYTES")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(20 * 1024 * 1024 * 1024);
    anyhow::ensure!(
        needed < max,
        persistence::media_jobs::JobFailure::CacheCapacityExceeded
    );
    let usable_disk = fs2::total_space(&root)?.saturating_sub(fs2::total_space(&root)? / 10);
    anyhow::ensure!(
        needed < usable_disk,
        persistence::media_jobs::JobFailure::CacheCapacityExceeded
    );
    for candidate in candidates {
        let id: Uuid = candidate.get("id");
        if !candidate.get::<bool, _>("pending")
            && total.saturating_add(needed) < max
            && fs2::available_space(&root)?.saturating_sub(needed) > fs2::total_space(&root)? / 10
        {
            continue;
        }
        let Some(owner) = persistence::cache::claim_eviction(db, id).await? else {
            continue;
        };
        let root = root.clone();
        let removed = media_core::child_process::blocking(move || -> anyhow::Result<u64> {
            let candidate = root.join(id.to_string());
            if !candidate.exists() {
                return Ok(0);
            }
            anyhow::ensure!(
                !std::fs::symlink_metadata(&candidate)?
                    .file_type()
                    .is_symlink(),
                "cache_path_boundary"
            );
            let path = candidate.canonicalize()?;
            anyhow::ensure!(path.parent() == Some(root.as_path()), "cache_path_boundary");
            let bytes = size(&path)?;
            std::fs::remove_dir_all(path)?;
            Ok(bytes)
        })
        .await?;
        match removed {
            Ok(bytes) => {
                persistence::cache::finish_eviction(db, id, owner).await?;
                total = total.saturating_sub(bytes);
            }
            Err(_) => {
                // Keep evicting: deny new readers and retry after claim expiry.
                // In particular, Windows can refuse deletion of a crashed reader's open file.
                tracing::warn!(cache_id=%id, "cache eviction deferred");
            }
        }
    }
    check_output_capacity_at(cache).await?;
    let root = root.clone();
    media_core::child_process::blocking(move || -> anyhow::Result<()> {
        anyhow::ensure!(
            size(&root)?.saturating_add(needed) < max
                && fs2::available_space(&root)?.saturating_sub(needed)
                    > fs2::total_space(&root)? / 10,
            persistence::media_jobs::JobFailure::CacheCapacityExceeded
        );
        Ok(())
    })
    .await?
}

/// Cache traversal is independent of lease renewal. Slow scans cannot consume
/// the renewal deadline; only a confirmed capacity error stops the encoder.
pub(crate) async fn monitor_at(db: &PgPool, cache: &std::path::Path) -> anyhow::Error {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        if let Err(error) = ensure_capacity_at(db, cache).await {
            if error.is::<persistence::media_jobs::JobFailure>() {
                return error;
            }
            tracing::warn!("cache capacity scan unavailable; will retry");
        }
    }
}
