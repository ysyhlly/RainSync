//! Validate one existing output generation using the caller's transaction.
//! Authorization, fences and publication remain with the finish operation.
use super::{file_path, safe_name};
use crate::{Result, error::err};
use axum::http::StatusCode;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::path::Path as FsPath;
use uuid::Uuid;

pub(super) fn playlist_segments(bytes: &[u8]) -> anyhow::Result<Vec<String>> {
    let text = std::str::from_utf8(bytes)?;
    anyhow::ensure!(
        text.starts_with("#EXTM3U\n") && text.lines().any(|s| s == "#EXT-X-ENDLIST"),
        "invalid_hls_manifest"
    );
    let mut files = Vec::new();
    let mut duration = false;
    for line in text.lines() {
        if line.starts_with("#EXTINF:") {
            let d = line
                .trim_start_matches("#EXTINF:")
                .trim_end_matches(',')
                .parse::<f64>()?;
            anyhow::ensure!(
                d.is_finite() && d > 0.0 && d <= 30.0,
                "invalid_segment_duration"
            );
            duration = true;
        } else if !line.is_empty() && !line.starts_with('#') {
            anyhow::ensure!(
                duration
                    && safe_name(line)
                    && line != "index.m3u8"
                    && !files.iter().any(|s| s == line),
                "invalid_hls_segment"
            );
            files.push(line.to_string());
            duration = false;
        } else if line.contains("URI=")
            || line.starts_with("#EXT-X-KEY")
            || line.starts_with("#EXT-X-STREAM-INF")
        {
            anyhow::bail!("unsupported_hls_manifest")
        }
    }
    anyhow::ensure!(!files.is_empty() && !duration, "empty_hls_manifest");
    Ok(files)
}
pub(super) async fn verify_files(
    root: &FsPath,
    id: Uuid,
    generation: Uuid,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
) -> Result<()> {
    let manifest = tokio::fs::read(file_path(root, id, generation, "index.m3u8"))
        .await
        .map_err(anyhow::Error::from)?;
    let files = playlist_segments(&manifest)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_compute_manifest"))?;
    let rows=sqlx::query("SELECT name,sha256,size_bytes FROM distributed_compute_files WHERE job_id=$1 AND output_generation=$2").bind(id).bind(generation).fetch_all(&mut **tx).await?;
    if rows.len() != files.len() + 1 {
        return Err(err(StatusCode::CONFLICT, "incomplete_compute_artifact"));
    }
    for row in &rows {
        let name: String = row.get("name");
        if name != "index.m3u8" && !files.contains(&name) {
            return Err(err(StatusCode::CONFLICT, "unreferenced_compute_artifact"));
        }
        let bytes = tokio::fs::read(file_path(root, id, generation, &name))
            .await
            .map_err(anyhow::Error::from)?;
        if bytes.len() as i64 != row.get::<i64, _>("size_bytes")
            || hex::encode(Sha256::digest(&bytes)) != row.get::<String, _>("sha256")
        {
            return Err(err(StatusCode::CONFLICT, "compute_artifact_changed"));
        }
    }
    Ok(())
}
