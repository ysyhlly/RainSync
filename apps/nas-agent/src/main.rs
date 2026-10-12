mod connected_session;
mod data_transfer;
mod drain;
mod receipt_mode;
mod transfer_admission;
mod uplink_metrics;
mod uplink_reporter;
use anyhow::{Context, Result};
use futures_util::SinkExt;
use media_core::runtime_metrics::NasUplinkMetrics;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Semaphore;

use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

async fn send_control(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    value: Value,
    shutdown: &tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let mut shutdown = shutdown.clone();
    tokio::select! {
        biased;
        _ = drain::cancelled(&mut shutdown) => anyhow::bail!("agent_shutdown"),
        result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            socket.send(Message::Text(value.to_string().into())),
        ) => result??,
    }
    Ok(())
}

type IndexPage = (Vec<Value>, bool);
fn index(
    root: &std::path::Path,
    pages: &tokio::sync::mpsc::Sender<Result<IndexPage>>,
    cancelled: &AtomicBool,
) -> Result<()> {
    let mut stack = vec![root.to_path_buf()];
    let mut items = vec![];
    let mut bytes = 0;
    while let Some(dir) = stack.pop() {
        anyhow::ensure!(!cancelled.load(Ordering::Relaxed), "index_cancelled");
        for entry in std::fs::read_dir(dir)? {
            anyhow::ensure!(!cancelled.load(Ordering::Relaxed), "index_cancelled");
            let e = entry?;
            let ty = match e.file_type() {
                Ok(ty) => ty,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if ty.is_symlink() {
                continue;
            }
            if ty.is_dir() {
                stack.push(e.path());
                continue;
            }
            if !ty.is_file() {
                continue;
            }
            let p = e.path();
            let ext = p
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !["mp4", "mkv", "webm", "mov", "m4v"].contains(&ext.as_str()) {
                continue;
            }
            let title = p.file_stem().context("file_stem")?.to_string_lossy();
            let resource = p.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
            anyhow::ensure!(
                title.chars().count() <= 1024 && resource.chars().count() <= 16384,
                "index_path_too_long"
            );
            // A known individual file may be unavailable without invalidating
            // enumeration of the rest of the library. Directory errors still
            // abort the snapshot: its missing entries cannot justify deletion.
            let version = match std::fs::File::open(&p) {
                Ok(file) => media_core::file_version::snapshot_file(&file)
                    .ok()
                    .map(|snapshot| snapshot.version),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => None,
            };
            let item = json!({"title":title,"resource":resource,"available":version.is_some(),"source_version":version});
            let size = serde_json::to_vec(&item)?.len() + 1;
            if !items.is_empty() && (items.len() >= 128 || bytes + size > 128 * 1024) {
                pages.blocking_send(Ok((std::mem::take(&mut items), false)))?;
                bytes = 0;
            }
            bytes += size;
            items.push(item);
        }
    }
    pages.blocking_send(Ok((items, true)))?;
    Ok(())
}

struct IndexScan {
    incoming: tokio::sync::mpsc::Receiver<Result<IndexPage>>,
    snapshot: String,
    sequence: u64,
    awaiting_ack: bool,
    final_page: bool,
    aborting: bool,
    sent_at: tokio::time::Instant,
    cancelled: Arc<AtomicBool>,
}

impl Drop for IndexScan {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

fn start_index(root: PathBuf, scans: Arc<Semaphore>) -> Option<IndexScan> {
    // The permit belongs to the actual blocking task, including across control
    // reconnects. A cancelled task stuck in filesystem I/O must not cause new
    // scans to accumulate while it is still alive.
    let permit = scans.try_acquire_owned().ok()?;
    let (pages, incoming) = tokio::sync::mpsc::channel(2);
    let cancelled = Arc::new(AtomicBool::new(false));
    let scan_cancelled = cancelled.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if let Err(error) = index(&root, &pages, &scan_cancelled) {
            let _ = pages.blocking_send(Err(error));
        }
    });
    Some(IndexScan {
        incoming,
        snapshot: uuid::Uuid::new_v4().to_string(),
        sequence: 0,
        awaiting_ack: false,
        final_page: false,
        aborting: false,
        sent_at: tokio::time::Instant::now(),
        cancelled,
    })
}

fn index_interval_seconds() -> Result<u64> {
    let seconds = std::env::var("AGENT_INDEX_INTERVAL_SECS")
        .unwrap_or_else(|_| "60".into())
        .parse::<u64>()
        .context("invalid_agent_index_interval")?;
    anyhow::ensure!(
        (5..=86400).contains(&seconds),
        "invalid_agent_index_interval"
    );
    Ok(seconds)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().init();
    let (signal, shutdown) = tokio::sync::watch::channel(false);
    let listener = tokio::spawn(async move {
        let result = media_core::process_signal::wait().await;
        signal.send_replace(true);
        result
    });
    let result = run(shutdown.clone()).await;
    if *shutdown.borrow() {
        listener.await??;
    } else {
        listener.abort();
    }
    result
}

async fn retry_or_shutdown(shutdown: &mut tokio::sync::watch::Receiver<bool>) -> bool {
    tokio::select! {
        biased;
        _ = drain::cancelled(shutdown) => true,
        _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => false,
    }
}

async fn run(mut shutdown: tokio::sync::watch::Receiver<bool>) -> Result<()> {
    let deployment = media_core::deployment_config::Settings::from_env(
        media_core::deployment_config::Role::Agent,
    )?;
    let server = deployment.public_origin;
    let configured_root = PathBuf::from(std::env::var("MEDIA_ROOT")?);
    let credential = PathBuf::from(
        std::env::var("AGENT_CREDENTIAL_FILE").unwrap_or("agent-credentials.json".into()),
    );
    // Durable receipts and unchanged existing credentials do not depend on the
    // media mount. Pairing is allowed only after a valid root has been observed.
    let (mut token, mut receipts) = tokio::select! {
        biased;
        _ = drain::cancelled(&mut shutdown) => return Ok(()),
        loaded = async {
            let receipts = drain::Receipts::load(&credential).await?;
            let token = receipt_mode::existing_token(&credential).await?;
            Ok::<_, anyhow::Error>((token, receipts))
        } => loaded?,
    };
    let mut root_check = receipt_mode::RootCheck::default();
    let slots = Arc::new(Semaphore::new(16));
    let rejections = Arc::new(Semaphore::new(4));
    let scans = Arc::new(Semaphore::new(1));
    let index_interval = std::time::Duration::from_secs(index_interval_seconds()?);
    let uplink = NasUplinkMetrics::default();
    loop {
        let Some(root) = root_check
            .validated(&configured_root, &mut shutdown)
            .await?
        else {
            if *shutdown.borrow() {
                break;
            }
            if let Some(token) = token.as_deref()
                && receipt_mode::replay(
                    &server,
                    token,
                    &mut receipts,
                    &mut root_check,
                    &configured_root,
                    &mut shutdown,
                )
                .await
                .is_err()
            {
                tracing::warn!("receipt-only control ended; durable receipts retained for retry");
            }
            // No existing token means no receipt connection, pairing, or write
            // of credentials while the media root is unavailable.
            if retry_or_shutdown(&mut shutdown).await {
                break;
            }
            continue;
        };
        if token.is_none() {
            // A restored mount may also make an existing credential/journal
            // visible. Re-read them before considering the original pairing
            // flow, so recovery never overwrites newly available credentials.
            let restored = tokio::select! {
                biased;
                _ = drain::cancelled(&mut shutdown) => break,
                restored = receipt_mode::existing_token(&credential) => restored?,
            };
            if let Some(restored) = restored {
                receipts = drain::Receipts::load(&credential).await?;
                token = Some(restored);
            }
        }
        if token.is_none() {
            token = Some(tokio::select! {
                    biased;
                    _ = drain::cancelled(&mut shutdown) => break,
                    token = async {
            let code = std::env::var("PAIR_CODE")?;
            let v: Value = reqwest::Client::new()
                .post(format!("{server}/api/v1/agents/pair"))
                .json(&json!({"code":code}))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            tokio::fs::write(&credential, serde_json::to_vec(&v)?).await?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                tokio::fs::set_permissions(&credential, std::fs::Permissions::from_mode(0o600)).await?;
            }
                        Ok::<_, anyhow::Error>(v["token"].as_str().context("pair token")?.to_string())
                    } => token?,
                });
        }
        let token = token.as_deref().unwrap();
        let url = format!(
            "{}/api/v1/agents/ws",
            server
                .replace("https://", "wss://")
                .replace("http://", "ws://")
        );
        let mut req = url.into_client_request()?;
        req.headers_mut()
            .insert("Authorization", format!("Bearer {token}").parse()?);
        let connection = tokio::select! {
            biased;
            _ = drain::cancelled(&mut shutdown) => break,
            result = tokio::time::timeout(std::time::Duration::from_secs(10), connect_async(req)) => result,
        };
        if let Ok(Ok((socket, _))) = connection {
            let context = connected_session::Context {
                root: &root,
                agent_data_origin: &deployment.agent_data_origin,
                slots: &slots,
                rejections: &rejections,
                scans: &scans,
                index_interval,
                shutdown: &mut shutdown,
                receipts: &mut receipts,
                uplink: &uplink,
            };
            match connected_session::run(context, socket).await {
                connected_session::Flow::Stop => break,
                connected_session::Flow::Retried => continue,
                connected_session::Flow::Drained => {}
            }
        }
        if retry_or_shutdown(&mut shutdown).await {
            break;
        }
    }
    // Only already-drained IDs enter Receipts. A planned exit must not lose
    // these truthful acknowledgements merely because their last save failed.
    // A stuck filesystem keeps shutdown pending; it never fabricates a receipt.
    while receipts.flush().await.is_err() {
        tracing::warn!("drain receipt persistence retry during shutdown");
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn index_streams_large_libraries_in_bounded_pages_and_reports_scan_errors() {
        let parent = std::env::temp_dir().canonicalize().unwrap();
        let root = parent.join(format!(
            "rainsync-agent-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        for i in 0..10001 {
            std::fs::write(root.join(format!("{}-{i}.mp4", "电影".repeat(30))), []).unwrap();
        }
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        let scan_root = root.clone();
        let scan = std::thread::spawn(move || index(&scan_root, &sender, &AtomicBool::new(false)));
        let (mut count, mut pages, mut final_seen) = (0, 0, false);
        while let Some(page) = receiver.blocking_recv() {
            let (items, done) = page.unwrap();
            assert!(items.len() <= 128);
            assert!(serde_json::to_vec(&items).unwrap().len() < 129 * 1024);
            count += items.len();
            pages += 1;
            final_seen = done;
        }
        scan.join().unwrap().unwrap();
        assert_eq!(count, 10001);
        assert!(pages > 1 && final_seen);
        assert_eq!(
            root.canonicalize().unwrap().parent(),
            Some(parent.as_path())
        );
        assert!(
            root.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("rainsync-agent-test-")
        );
        std::fs::remove_dir_all(&root).unwrap();
        let (sender, _) = tokio::sync::mpsc::channel(1);
        assert!(index(&root, &sender, &AtomicBool::new(false)).is_err());
    }
}
