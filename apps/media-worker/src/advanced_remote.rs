//! Finite source gateway materialization. Neither decoder nor libass receives
//! an upstream URL. Cancellation drops partial bytes before lease release;
//! completed descriptors stay held through positive decoder reaping.
use anyhow::{Result, ensure};
use futures_util::StreamExt;
use media_core::advanced_media::{OwnedLocalInput, WorkerGatewayInput};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
struct Partial {
    file: Option<std::fs::File>,
    path: PathBuf,
}
impl Drop for Partial {
    fn drop(&mut self) {
        drop(self.file.take());
        if self.path.as_os_str().is_empty() {
            return;
        }
        if let Err(error) = std::fs::remove_file(&self.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::error!(error_kind=?error.kind(),"advanced held partial input cleanup remains unverified");
        }
    }
}
pub(crate) async fn hold(input: &str, bytes: u64, output: &Path) -> Result<Arc<OwnedLocalInput>> {
    WorkerGatewayInput::new(input)?;
    hold_named(input, bytes, output, "held-source.bin").await
}
async fn hold_named(
    input: &str,
    bytes: u64,
    output: &Path,
    name: &str,
) -> Result<Arc<OwnedLocalInput>> {
    ensure!(
        (1..=MAX_BYTES).contains(&bytes),
        "advanced_remote_input_bound"
    );
    let parent = output
        .parent()
        .ok_or_else(|| anyhow::anyhow!("advanced_remote_directory_required"))?;
    ensure!(parent.is_absolute(), "advanced_remote_directory_required");
    let path = parent.join(name);
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut partial = Partial {
        file: Some(options.open(&path).map_err(super::cache::write_error)?),
        path,
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(300))
        .build()?;
    let response = client
        .get(input)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header(reqwest::header::RANGE, format!("bytes=0-{}", bytes - 1))
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("advanced_remote_read_failed"))?;
    ensure!(
        response.status() == reqwest::StatusCode::PARTIAL_CONTENT,
        "advanced_remote_finite_range_required"
    );
    ensure!(
        response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|h| h.to_str().ok())
            == Some(format!("bytes 0-{}/{}", bytes - 1, bytes).as_str())
            && response.content_length() == Some(bytes),
        "advanced_remote_representation_changed"
    );
    ensure!(
        response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .is_none_or(|h| h == "identity"),
        "advanced_remote_representation_changed"
    );
    let mut stream = response.bytes_stream();
    let mut written = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| anyhow::anyhow!("advanced_remote_read_failed"))?;
        written = written
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| anyhow::anyhow!("advanced_remote_input_bound"))?;
        ensure!(written <= bytes, "advanced_remote_input_bound");
        partial
            .file
            .as_mut()
            .unwrap()
            .write_all(&chunk)
            .map_err(super::cache::write_error)?;
    }
    ensure!(written == bytes, "advanced_remote_representation_changed");
    partial
        .file
        .as_mut()
        .unwrap()
        .flush()
        .map_err(super::cache::write_error)?;
    let file = partial.file.take().unwrap();
    let path = partial.path.clone();
    let owner = Arc::new(OwnedLocalInput::materialized(file, path)?);
    partial.path = PathBuf::new();
    drop(partial);
    Ok(owner)
}
pub(crate) async fn hold_assets(
    input: &str,
    remote: &media_core::advanced_media::RemoteAssetCatalog,
    source: Arc<OwnedLocalInput>,
    output: &Path,
    index: Option<u32>,
) -> Result<Arc<media_core::advanced_media::OwnedAssets>> {
    WorkerGatewayInput::new(input)?;
    let mut url = url::Url::parse(input)?;
    let session = url.path_segments().unwrap().nth(1).unwrap().to_owned();
    let mut held = Vec::new();
    for (number, asset) in remote.files().into_iter().enumerate() {
        url.set_path(&format!("/media-delivery/{session}/asset-{number}"));
        WorkerGatewayInput::asset(url.as_str())?;
        let owner = tokio::time::timeout(
            Duration::from_secs(30),
            hold_named(
                url.as_str(),
                asset.bytes,
                output,
                &format!("held-asset-{number}.bin"),
            ),
        )
        .await??;
        if remote.source_kind == "http" {
            use std::io::{Read, Seek};
            let mut file = owner.duplicate_file()?;
            file.rewind()?;
            let mut bytes = Vec::new();
            file.take(asset.bytes + 1).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() as u64 == asset.bytes
                    && media_core::advanced_media::asset_sha256(&bytes)
                        == remote.http_files[number].content_sha256,
                "source_changed"
            );
        }
        held.push(owner);
    }
    let directory = output
        .parent()
        .ok_or_else(|| anyhow::anyhow!("advanced_asset_directory_invalid"))?
        .join("owned-fonts");
    let catalog = remote.catalog.clone();
    let owner = media_core::child_process::blocking(move || {
        media_core::advanced_media::OwnedAssets::from_materialized(
            &catalog, index, source, held, &directory,
        )
    })
    .await??;
    Ok(Arc::new(owner))
}
fn head_representation_length(response: &reqwest::Response) -> Option<u64> {
    let mut values = response
        .headers()
        .get_all(reqwest::header::CONTENT_LENGTH)
        .iter();
    let length = values.next()?.to_str().ok()?;
    if values.next().is_some() || length.is_empty() || !length.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    length.parse().ok()
}
/// Re-observe every original bound representation while custody remains held.
/// Session/owner/execution gates remain in the original loopback gateway.
pub(crate) async fn verify_assets(
    input: &str,
    remote: &media_core::advanced_media::RemoteAssetCatalog,
) -> Result<()> {
    WorkerGatewayInput::new(input)?;
    let work = async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()?;
        let response = client
            .head(input)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("advanced_remote_read_failed"))?;
        ensure!(
            response.status().is_success()
                && match &remote.source_http {
                    Some(pin) => head_representation_length(&response) == Some(pin.bytes),
                    None => head_representation_length(&response)
                        .is_some_and(|bytes| (1..=MAX_BYTES).contains(&bytes)),
                },
            "source_changed"
        );
        let mut url = url::Url::parse(input)?;
        let session = url.path_segments().unwrap().nth(1).unwrap().to_owned();
        for (number, file) in remote.files().into_iter().enumerate() {
            url.set_path(&format!("/media-delivery/{session}/asset-{number}"));
            WorkerGatewayInput::asset(url.as_str())?;
            let response = client
                .head(url.as_str())
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("advanced_remote_read_failed"))?;
            ensure!(
                response.status().is_success()
                    && head_representation_length(&response) == Some(file.bytes),
                "source_changed"
            );
        }
        Ok(())
    };
    tokio::time::timeout(Duration::from_secs(15), work).await?
}
#[cfg(test)]
mod tests {
    #[test]
    fn finite_materialization_admission_has_no_upstream_paths() {
        assert!(
            media_core::advanced_media::WorkerGatewayInput::new("https://upstream.invalid/a.mkv")
                .is_err()
        );
        assert!(media_core::advanced_media::WorkerGatewayInput::new("file:///etc/passwd").is_err());
    }
}

#[cfg(test)]
#[path = "advanced_remote_runtime.rs"]
mod runtime_tests;
