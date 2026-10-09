//! Owns one NAS data socket and its blocking file work through confirmed disposal.
use crate::{drain, uplink_metrics};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use media_core::runtime_metrics::{NasUplinkMetrics, Outcome};
use serde_json::{Value, json};
use std::{
    io::{Read, Seek},
    path::PathBuf,
    sync::Arc,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug)]
struct SourceChanged;
impl std::fmt::Display for SourceChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("source_changed")
    }
}
impl std::error::Error for SourceChanged {}
fn content_type(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

// Sent by Worker only while its bounded consumer queue is backpressured and
// its transfer owner remains live. Ordinary Ping/Pong cannot excuse a stall.
const BACKPRESSURE_HEARTBEAT: &[u8] = b"rainsync-backpressure-v1";

async fn send_with_backpressure_health<F>(
    send: F,
    signals: &mut tokio::sync::watch::Receiver<tokio::time::Instant>,
) -> Result<()>
where
    F: std::future::Future<Output = std::result::Result<(), tokio_tungstenite::tungstenite::Error>>,
{
    let idle = std::time::Duration::from_secs(30);
    let mut deadline = tokio::time::Instant::now() + idle;
    // Keep the same send future: cancelling and retrying it could duplicate a
    // partially written frame. The receiver is polled independently below.
    tokio::pin!(send);
    loop {
        tokio::select! {
            result = &mut send => { result?; return Ok(()) }
            changed = signals.changed() => {
                changed.context("agent_backpressure_peer_lost")?;
                deadline = deadline.max(*signals.borrow_and_update() + idle);
            }
            _ = tokio::time::sleep_until(deadline) => anyhow::bail!("agent_write_progress_timeout"),
        }
    }
}

fn associated_asset_source(
    root: &std::path::Path,
    request: &Value,
) -> Result<Option<Arc<media_core::advanced_media::OwnedLocalInput>>> {
    let Some(value) = request.get("bound_asset_catalog") else {
        return Ok(None);
    };
    let catalog: media_core::advanced_media::AssetCatalog = serde_json::from_value(value.clone())?;
    let resource = request["resource"].as_str().context("resource")?;
    let expected = request["source_version"]
        .as_str()
        .context("source_version")?;
    catalog.validate(&catalog.source_resource, &catalog.source_version)?;
    anyhow::ensure!(
        catalog.schema_version == 1,
        "advanced_asset_association_required"
    );
    anyhow::ensure!(
        catalog
            .subtitles
            .iter()
            .map(|s| &s.file)
            .chain(catalog.fonts.iter())
            .any(|f| f.resource == resource && f.source_version == expected),
        "advanced_asset_association_required"
    );
    catalog.verify_files(root)?;
    Ok(Some(Arc::new(
        media_core::advanced_media::OwnedLocalInput::open(
            root,
            &catalog.source_resource,
            &catalog.source_version,
        )?,
    )))
}

pub(super) async fn run(
    root: PathBuf,
    request: Value,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    metrics: Option<NasUplinkMetrics>,
) -> Result<()> {
    let url = request["data_url"].as_str().context("data_url")?;
    let (socket, _) = tokio::select! {
        biased;
        _ = drain::cancelled(&mut cancel) => return Ok(()),
        connected = tokio::time::timeout(std::time::Duration::from_secs(10), connect_async(url)) => connected??,
    };
    let (mut writer, mut reader) = socket.split();
    let (liveness, mut signals) = tokio::sync::watch::channel(tokio::time::Instant::now());
    let mut headers_started = false;
    let operations = drain::FileOps::default();
    let mut measurement = uplink_metrics::BodyMeasurement::default();
    let work = async {
        if request["busy"].as_bool().unwrap_or(false) {
            headers_started = true;
            tokio::time::timeout(
                std::time::Duration::from_secs(1),
                writer.send(Message::Text(
                    json!({"status":503,"content-length":"0"})
                        .to_string()
                        .into(),
                )),
            )
            .await??;
            return Ok(());
        }
        if request["advanced_asset_catalog"] == true {
            let resource = request["resource"].as_str().context("resource")?.to_owned();
            let version = request["source_version"]
                .as_str()
                .context("source_version")?
                .to_owned();
            let root = root.clone();
            let version_reply = version.clone();
            let bytes = operations
                .run(move || -> Result<Vec<u8>> {
                    let source = media_core::advanced_media::OwnedLocalInput::open(
                        &root, &resource, &version,
                    )?;
                    let catalog = media_core::advanced_media::AssetCatalog::discover(
                        &root, &resource, &version,
                    )?;
                    catalog.verify_files(&root)?;
                    source.verify()?;
                    let bytes = serde_json::to_vec(&catalog)?;
                    anyhow::ensure!(bytes.len() <= 65536, "advanced_asset_bound");
                    Ok(bytes)
                })
                .await?;
            headers_started = true;
            tokio::time::timeout(std::time::Duration::from_secs(3),writer.send(Message::Text(json!({"status":200,"content-length":bytes.len().to_string(),"content-type":"application/json","source_version":version_reply}).to_string().into()))).await??;
            if !request["head"].as_bool().unwrap_or(false) {
                tokio::time::timeout(
                    std::time::Duration::from_secs(3),
                    writer.send(Message::Binary(bytes.into())),
                )
                .await??;
            }
            return Ok(());
        }
        let asset_root = root.clone();
        let asset_request = request.clone();
        let associated_source = operations
            .run(move || associated_asset_source(&asset_root, &asset_request))
            .await?;
        let resource = request["resource"].as_str().context("resource")?.to_owned();
        let expected = request["source_version"].as_str().map(str::to_owned);
        let (path, file, snapshot) = operations
            .run(move || -> Result<_> {
                let path = media_core::safe_path(&root, &resource)?;
                let file = std::fs::File::open(&path)?;
                let snapshot = media_core::file_version::snapshot_file(&file)?;
                if expected.as_ref().is_some_and(|v| *v != snapshot.version) {
                    return Err(SourceChanged.into());
                }
                Ok((path, Arc::new(file), snapshot))
            })
            .await?;
        let size = snapshot.len;
        // Also normalize at the file owner for older Workers. HEAD always
        // describes the complete representation; malformed/multi-range input
        // is ignored, while a valid range selecting no bytes remains 416.
        let range_request = if request["head"].as_bool().unwrap_or(false) {
            media_core::http_range::Request::default()
        } else {
            media_core::http_range::Request::parse(request["range"].as_str())
        };
        let range = match range_request.resolve(size) {
            media_core::http_range::Selection::Full => None,
            media_core::http_range::Selection::Partial(start, end) => Some((start, end)),
            media_core::http_range::Selection::Unsatisfiable => {
                headers_started = true;
                tokio::time::timeout(std::time::Duration::from_secs(30), writer.send(Message::Text(json!({"status":416,"content-range":format!("bytes */{size}"),"content-length":"0"}).to_string().into()))).await??;
                return Ok(());
            }
        };
        let (start, len) = range.map(|(a, b)| (a, b - a + 1)).unwrap_or((0, size));
        let mut meta = json!({"status":if range.is_some(){206}else{200},"content-length":len.to_string(),"content-type":content_type(&path),"accept-ranges":"bytes","source_version":snapshot.version});
        if let Some((a, b)) = range {
            meta["content-range"] = json!(format!("bytes {a}-{b}/{size}"));
        }
        // A timed-out send may already have written part of the frame.
        headers_started = true;
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            writer.send(Message::Text(meta.to_string().into())),
        )
        .await??;
        if !request["head"].as_bool().unwrap_or(false) {
            measurement = uplink_metrics::BodyMeasurement::begin(metrics.as_ref(), len);
            let seek_file = file.clone();
            operations
                .run(move || Ok((&*seek_file).seek(std::io::SeekFrom::Start(start))?))
                .await?;
            let mut remaining = len;
            while remaining > 0 {
                let wanted = remaining.min(65536) as usize;
                let read_file = file.clone();
                let version = snapshot.version.clone();
                let associated_source = associated_source.clone();
                let buf = operations
                    .run(move || -> Result<Vec<u8>> {
                        if media_core::file_version::snapshot_file(&read_file)?.version != version {
                            return Err(SourceChanged.into());
                        }
                        if let Some(source) = &associated_source {
                            source.verify()?;
                        }
                        let mut bytes = vec![0; wanted];
                        let n = (&*read_file).read(&mut bytes)?;
                        if n == 0
                            || media_core::file_version::snapshot_file(&read_file)?.version
                                != version
                        {
                            return Err(SourceChanged.into());
                        }
                        if let Some(source) = &associated_source {
                            source.verify()?;
                        }
                        bytes.truncate(n);
                        Ok(bytes)
                    })
                    .await?;
                let n = buf.len();
                measurement
                    .send_frame(
                        n,
                        send_with_backpressure_health(
                            writer.send(Message::Binary(buf.into())),
                            &mut signals,
                        ),
                    )
                    .await?;
                remaining -= n as u64;
            }
        }
        Ok::<(), anyhow::Error>(())
    };
    // Poll the peer while file I/O or a backpressured write is pending. Merely
    // sending frames does not observe a Close promptly on every socket state.
    let (result, outcome): (Result<()>, Outcome) = tokio::select! {
        biased;
        _ = drain::cancelled(&mut cancel) => (Ok(()), Outcome::Cancelled),
        result = work => {
            let outcome = if result.is_err() { Outcome::Failed } else { Outcome::Complete };
            (result, outcome)
        },
        outcome = async {
            loop {
                match reader.next().await {
                    Some(Ok(Message::Ping(payload))) => {
                        if payload.as_ref() == BACKPRESSURE_HEARTBEAT {
                            liveness.send_replace(tokio::time::Instant::now());
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {},
                    Some(Err(_)) => return Outcome::Failed,
                    _ => return Outcome::Cancelled,
                }
            }
        } => (Ok(()), outcome),
    };
    // End byte observation independently, before socket/file disposal is proved.
    measurement.finish(outcome);
    if result.is_err() && !headers_started {
        let changed = result
            .as_ref()
            .err()
            .is_some_and(|e| e.is::<SourceChanged>() || e.to_string() == "source_changed");
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            writer.send(Message::Text(
                json!({"status":if changed {409}else{404},"error":if changed {"source_changed"}else{"media_not_found"},"content-length":"0"})
                    .to_string()
                    .into(),
            )),
        )
        .await;
    }
    // Once headers have been sent, failure terminates the stream; never send a
    // second metadata response as if it were media bytes.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), writer.close()).await;
    drop(writer);
    drop(reader);
    operations.drain().await?;
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mime_types_match_the_original_container() {
        for (file, mime) in [
            ("movie.MKV", "video/x-matroska"),
            ("movie.webm", "video/webm"),
            ("movie.mov", "video/quicktime"),
            ("movie.mp4", "video/mp4"),
            ("movie.m4v", "video/mp4"),
            ("unknown", "application/octet-stream"),
        ] {
            assert_eq!(content_type(std::path::Path::new(file)), mime);
        }
    }
}

#[cfg(test)]
mod remote_asset_tests {
    use super::*;
    #[test]
    fn nas_assets_hold_original_source_and_cannot_borrow_files() {
        const CHILD_ROOT: &str = "RAINSYNC_NAS_ASSET_TEST_ROOT";
        let parent = std::env::temp_dir().canonicalize().unwrap();
        let root = if let Some(root) = std::env::var_os(CHILD_ROOT) {
            PathBuf::from(root)
        } else {
            let root = parent.join(format!("rainsync-nas-assets-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "data_transfer::remote_asset_tests::nas_assets_hold_original_source_and_cannot_borrow_files",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD_ROOT, &root)
                .env("MEDIA_ROOT", &root);
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
                        .starts_with("rainsync-nas-assets-")
                );
                std::fs::remove_dir_all(&root).unwrap();
            }
            assert!(
                output.status.success(),
                "isolated NAS asset fixture failed: {} {}",
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
                .starts_with("rainsync-nas-assets-")
        );
        std::fs::write(root.join("a.mkv"), b"original source").unwrap();
        std::fs::write(
            root.join("a.ass"),
            b"[Script Info]\n[Events]\nFormat: Layer, Text\n",
        )
        .unwrap();
        let version = media_core::file_version::snapshot_file(
            &std::fs::File::open(root.join("a.mkv")).unwrap(),
        )
        .unwrap()
        .version;
        let catalog =
            media_core::advanced_media::AssetCatalog::discover(&root, "a.mkv", &version).unwrap();
        assert_eq!(
            catalog.subtitles.len(),
            1,
            "owned-root fixture must discover the associated subtitle"
        );
        let file = &catalog.subtitles[0].file;
        let request = json!({"resource":file.resource,"source_version":file.source_version,"bound_asset_catalog":catalog});
        let held = associated_asset_source(&root, &request).unwrap().unwrap();
        held.verify().unwrap();
        let mut borrowed = request.clone();
        borrowed["resource"] = json!("b.ass");
        assert!(associated_asset_source(&root, &borrowed).is_err());
        let mut unversioned = request.clone();
        unversioned["source_version"] = Value::Null;
        assert!(associated_asset_source(&root, &unversioned).is_err());
        #[cfg(windows)]
        {
            let error = std::fs::write(root.join("a.mkv"), b"changed original").unwrap_err();
            assert_eq!(
                error.raw_os_error(),
                Some(32),
                "retained source must reject writes with ERROR_SHARING_VIOLATION"
            );
            held.verify().unwrap();
            drop(held);
            std::fs::write(root.join("a.mkv"), b"changed original").unwrap();
            assert!(associated_asset_source(&root, &request).is_err());
        }
        #[cfg(not(windows))]
        {
            std::fs::write(root.join("a.mkv"), b"changed original").unwrap();
            assert!(held.verify().is_err());
            assert!(associated_asset_source(&root, &request).is_err());
            drop(held);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
