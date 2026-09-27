use super::{App, process};
use persistence::cache_outputs;
use std::{path::Path, time::Duration};
use uuid::Uuid;

// Paths come only from typed database identities, never relative_dir. Attempt
// zero is the job directory itself and must remain under whole-entry eviction.
fn remove(root: &Path, id: Uuid, attempt: i64) -> anyhow::Result<()> {
    anyhow::ensure!(attempt > 0, "cache_attempt_boundary");
    let root = root.canonicalize()?;
    let parent = root.join(id.to_string());
    let path = parent.join(attempt.to_string());
    for (candidate, expected_parent) in [(&parent, &root), (&path, &parent)] {
        let metadata = match std::fs::symlink_metadata(candidate) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        anyhow::ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "cache_attempt_boundary"
        );
        anyhow::ensure!(
            candidate.canonicalize()?.parent() == Some(expected_parent.as_path()),
            "cache_attempt_boundary"
        );
    }
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn sweep(app: &App, stop: &tokio::sync::watch::Receiver<bool>) -> anyhow::Result<()> {
    let candidates =
        tokio::time::timeout(Duration::from_secs(3), cache_outputs::candidates(&app.db)).await??;
    for (job_id, attempt) in candidates {
        if *stop.borrow() {
            break;
        }
        let Some(claim) = tokio::time::timeout(
            Duration::from_secs(3),
            cache_outputs::claim(&app.db, job_id, attempt),
        )
        .await??
        else {
            continue;
        };
        let root = app.cache.clone();
        // Await the blocking operation itself, including on shutdown. Dropping
        // its future would detach a still-running deletion from this lifecycle.
        if tokio::task::spawn_blocking(move || remove(&root, job_id, attempt))
            .await?
            .is_ok()
        {
            tokio::time::timeout(
                Duration::from_secs(3),
                cache_outputs::finish(&app.db, claim),
            )
            .await??;
        } else {
            tracing::warn!(%job_id, attempt, "obsolete output cleanup deferred");
        }
    }
    Ok(())
}

pub async fn run(app: App, mut stop: tokio::sync::watch::Receiver<bool>) {
    loop {
        if *stop.borrow() {
            break;
        }
        if sweep(&app, &stop).await.is_err() {
            tracing::warn!("obsolete output maintenance deferred");
        }
        tokio::select! {
            _ = process::stopped(&mut stop) => break,
            _ = tokio::time::sleep(Duration::from_secs(5)) => {},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletes_only_selected_attempt_and_revisits_recreated_files() {
        let root = std::env::temp_dir().join(format!("rainsync-output-gc-{}", Uuid::new_v4()));
        let id = Uuid::new_v4();
        let old = root.join(id.to_string()).join("1");
        let current = root.join(id.to_string()).join("2");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(old.join("index.m3u8"), b"old").unwrap();
        std::fs::write(current.join("index.m3u8"), b"current").unwrap();
        assert!(remove(&root, id, 0).is_err());
        assert!(remove(&root, id, -1).is_err());
        remove(&root, id, 1).unwrap();
        assert!(!old.exists());
        assert_eq!(
            std::fs::read(current.join("index.m3u8")).unwrap(),
            b"current"
        );
        remove(&root, id, 1).unwrap();
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("late.tmp"), b"late writer").unwrap();
        remove(&root, id, 1).unwrap();
        assert!(!old.exists());
        // Test-only root, constructed above; never a configured cache/media path.
        std::fs::remove_dir_all(root).unwrap();
    }
}
