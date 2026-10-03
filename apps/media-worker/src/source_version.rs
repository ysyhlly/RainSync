//! Final and periodic identity checks for version-bound local encoder input.
use anyhow::Result;
use serde_json::Value;
use std::{path::PathBuf, time::Duration};

pub async fn verify(spec: &Value) -> Result<()> {
    let Some(expected) = spec["source_version"].as_str() else {
        return Ok(());
    };
    // Remote providers own their own input version checks. Legacy jobs without
    // a recorded identity retain their existing execution path.
    if spec["source_kind"]
        .as_str()
        .is_some_and(|kind| kind != "local")
    {
        return Ok(());
    }
    let root = PathBuf::from(spec["root"].as_str().unwrap_or(""));
    let resource = spec["resource"].as_str().unwrap_or("").to_owned();
    let expected = expected.to_owned();
    let current = media_core::child_process::blocking(move || -> Result<bool> {
        let path = media_core::safe_path(&root, &resource)?;
        let file = std::fs::File::open(path)?;
        Ok(media_core::file_version::snapshot_file(&file)?.version == expected)
    })
    .await?;
    if !matches!(current, Ok(true)) {
        return Err(persistence::media_jobs::JobFailure::SourceChanged.into());
    }
    Ok(())
}

pub async fn monitor(spec: &Value) -> anyhow::Error {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if let Err(error) = verify(spec).await {
            return error;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn persisted_legacy_jobs_do_not_invent_a_source_version() {
        for spec in [
            serde_json::json!({"source_kind":"local","root":"missing-legacy-root","resource":"input.mp4"}),
            serde_json::json!({"source_kind":"local","root":"missing-legacy-root","resource":"input.mp4","source_version":null}),
        ] {
            let before = spec.clone();
            verify(&spec).await.unwrap();
            assert_eq!(spec, before);
        }
    }

    #[tokio::test]
    async fn final_identity_check_detects_changed_or_missing_local_file() {
        let root =
            std::env::temp_dir().join(format!("rainsync-source-version-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("input.mp4");
        std::fs::write(&path, b"first").unwrap();
        let version = media_core::file_version::snapshot_file(&std::fs::File::open(&path).unwrap())
            .unwrap()
            .version;
        let spec = serde_json::json!({"root":root,"resource":"input.mp4","source_kind":"local","source_version":version});
        verify(&spec).await.unwrap();
        std::fs::write(&path, b"changed input").unwrap();
        let error = verify(&spec).await.unwrap_err();
        assert!(matches!(
            error.downcast_ref::<persistence::media_jobs::JobFailure>(),
            Some(persistence::media_jobs::JobFailure::SourceChanged)
        ));
        std::fs::remove_file(path).unwrap();
        assert!(verify(&spec).await.is_err());
        std::fs::remove_dir(root).unwrap();
    }
}
