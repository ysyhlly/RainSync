//! Final and periodic identity checks for version-bound local encoder input.
use anyhow::Result;
use serde_json::Value;
use std::{path::PathBuf, time::Duration};

pub async fn verify(spec: &Value) -> Result<()> {
    if spec["source_kind"] == "local"
        && let Some(value) = spec.get("advanced_assets")
    {
        let catalog: media_core::advanced_media::AssetCatalog =
            serde_json::from_value(value.clone())?;
        catalog.validate(
            spec["resource"].as_str().unwrap_or(""),
            spec["source_version"].as_str().unwrap_or(""),
        )?;
        let root = PathBuf::from(spec["root"].as_str().unwrap_or(""));
        let checked = media_core::child_process::blocking(move || -> Result<()> {
            catalog.verify_files(&root)
        })
        .await?;
        if let Err(error) = checked {
            if error.to_string() == "source_changed"
                || error.to_string() == "advanced_asset_symlink_unsupported"
                || error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            {
                return Err(persistence::media_jobs::JobFailure::SourceChanged.into());
            }
            return Err(error);
        }
    }

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
        let file = media_core::open_local_file(&root, &resource)?;
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
        const CHILD_ROOT: &str = "RAINSYNC_SOURCE_VERSION_TEST_ROOT";
        let parent = std::env::temp_dir().canonicalize().unwrap();
        let root = if let Some(root) = std::env::var_os(CHILD_ROOT) {
            std::path::PathBuf::from(root)
        } else {
            let root = parent.join(format!("rainsync-source-version-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", "source_version::tests::final_identity_check_detects_changed_or_missing_local_file", "--nocapture", "--test-threads=1"])
                .env(CHILD_ROOT, &root).env("MEDIA_ROOT", &root);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let output = command.output().unwrap();
            if root.exists() {
                assert_eq!(
                    root.canonicalize().unwrap().parent(),
                    Some(parent.as_path())
                );
                assert!(
                    root.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("rainsync-source-version-")
                );
                std::fs::remove_dir_all(&root).unwrap();
            }
            assert!(
                output.status.success(),
                "isolated source version fixture failed: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
                "isolated fixture did not execute its exact test"
            );
            return;
        };
        assert_eq!(
            root.canonicalize().unwrap().parent(),
            Some(parent.as_path())
        );
        assert!(
            root.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("rainsync-source-version-")
        );
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
