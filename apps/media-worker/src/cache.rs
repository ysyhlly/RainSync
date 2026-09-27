use super::*;

/// Completion must not trust the encoder exit code alone: some muxer write
/// failures can occur between periodic checks. Do not evict files here, since
/// freeing space would hide the failure we are trying to classify.
pub async fn check_output_capacity(app: &App) -> anyhow::Result<()> {
    let root = app.cache.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
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
fn size(path: &std::path::Path) -> std::io::Result<u64> {
    let mut bytes = 0;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            continue;
        }
        bytes += if ty.is_dir() {
            size(&entry.path())?
        } else {
            entry.metadata()?.len()
        };
    }
    Ok(bytes)
}
pub async fn ensure_capacity(app: &App) -> anyhow::Result<()> {
    let root = app.cache.canonicalize()?;
    let active: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM playback_sessions WHERE NOT stopped AND expires_at>now()",
    )
    .fetch_all(&app.db)
    .await?;
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let max = std::env::var("CACHE_MAX_BYTES")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(20 * 1024 * 1024 * 1024);
        let mut total = size(&root)?;
        let mut candidates = std::fs::read_dir(&root)?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()))
            .filter_map(|e| {
                let id = Uuid::parse_str(&e.file_name().to_string_lossy()).ok()?;
                if active.contains(&id) { None } else { Some(e) }
            })
            .collect::<Vec<_>>();
        candidates.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
        for entry in candidates {
            if total < max
                && fs2::available_space(&root)? as f64 / fs2::total_space(&root)? as f64 > 0.1
            {
                break;
            }
            let path = entry.path().canonicalize()?;
            anyhow::ensure!(path.parent() == Some(root.as_path()), "cache_path_boundary");
            let bytes = size(&path)?;
            std::fs::remove_dir_all(path)?;
            total = total.saturating_sub(bytes);
        }
        anyhow::ensure!(
            total < max,
            persistence::media_jobs::JobFailure::CacheCapacityExceeded
        );
        anyhow::ensure!(
            fs2::available_space(&root)? as f64 / fs2::total_space(&root)? as f64 > 0.1,
            persistence::media_jobs::JobFailure::CacheCapacityExceeded
        );
        Ok(())
    })
    .await??;
    Ok(())
}

/// Cache traversal is independent of lease renewal. Slow scans cannot consume
/// the renewal deadline; only a confirmed capacity error stops the encoder.
pub async fn monitor(app: &App) -> anyhow::Error {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        if let Err(error) = ensure_capacity(app).await {
            if error.is::<persistence::media_jobs::JobFailure>() {
                return error;
            }
            tracing::warn!("cache capacity scan unavailable; will retry");
        }
    }
}
