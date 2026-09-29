use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::io::{Read, Seek};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Semaphore;

#[derive(Debug)]
struct SourceChanged;
impl std::fmt::Display for SourceChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("source_changed")
    }
}
impl std::error::Error for SourceChanged {}
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

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

async fn transfer(root: PathBuf, request: Value) -> Result<()> {
    let url = request["data_url"].as_str().context("data_url")?;
    let (socket, _) =
        tokio::time::timeout(std::time::Duration::from_secs(10), connect_async(url)).await??;
    let (mut writer, mut reader) = socket.split();
    let (liveness, mut signals) = tokio::sync::watch::channel(tokio::time::Instant::now());
    let mut headers_started = false;
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
        let resource = request["resource"].as_str().context("resource")?.to_owned();
        let expected = request["source_version"].as_str().map(str::to_owned);
        let (path, file, snapshot) = tokio::task::spawn_blocking(move || -> Result<_> {
            let path = media_core::safe_path(&root, &resource)?;
            let file = std::fs::File::open(&path)?;
            let snapshot = media_core::file_version::snapshot_file(&file)?;
            if expected.as_ref().is_some_and(|v| *v != snapshot.version) {
                return Err(SourceChanged.into());
            }
            Ok((path, Arc::new(file), snapshot))
        })
        .await??;
        let size = snapshot.len;
        let range = match media_core::byte_range(request["range"].as_str(), size) {
            Ok(value) => value,
            Err(_) => {
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
            let seek_file = file.clone();
            tokio::task::spawn_blocking(move || {
                (&*seek_file).seek(std::io::SeekFrom::Start(start))
            })
            .await??;
            let mut remaining = len;
            while remaining > 0 {
                let wanted = remaining.min(65536) as usize;
                let read_file = file.clone();
                let version = snapshot.version.clone();
                let buf = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
                    if media_core::file_version::snapshot_file(&read_file)?.version != version {
                        return Err(SourceChanged.into());
                    }
                    let mut bytes = vec![0; wanted];
                    let n = (&*read_file).read(&mut bytes)?;
                    if n == 0
                        || media_core::file_version::snapshot_file(&read_file)?.version != version
                    {
                        return Err(SourceChanged.into());
                    }
                    bytes.truncate(n);
                    Ok(bytes)
                })
                .await??;
                let n = buf.len();
                send_with_backpressure_health(
                    writer.send(Message::Binary(buf.into())),
                    &mut signals,
                )
                .await?;
                remaining -= n as u64;
            }
        }
        Ok(())
    };
    // Poll the peer while file I/O or a backpressured write is pending. Merely
    // sending frames does not observe a Close promptly on every socket state.
    let result: Result<()> = tokio::select! {
        result = work => result,
        _ = async {
            while let Some(Ok(message)) = reader.next().await {
                match message {
                    Message::Ping(payload) => {
                        if payload.as_ref() == BACKPRESSURE_HEARTBEAT {
                            liveness.send_replace(tokio::time::Instant::now());
                        }
                    }
                    Message::Pong(_) => {},
                    _ => break,
                }
            }
        } => Ok(()),
    };
    if result.is_err() && !headers_started {
        let changed = result
            .as_ref()
            .err()
            .is_some_and(|e| e.is::<SourceChanged>());
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
    result
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
    let server = std::env::var("SERVER_URL")?;
    let root = PathBuf::from(std::env::var("MEDIA_ROOT")?).canonicalize()?;
    let credential = PathBuf::from(
        std::env::var("AGENT_CREDENTIAL_FILE").unwrap_or("agent-credentials.json".into()),
    );
    let token = if let Ok(token) = std::env::var("AGENT_TOKEN") {
        token
    } else if credential.is_file() {
        serde_json::from_slice::<Value>(&tokio::fs::read(&credential).await?)?["token"]
            .as_str()
            .context("token")?
            .to_string()
    } else {
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
        v["token"].as_str().context("pair token")?.to_string()
    };
    let slots = Arc::new(Semaphore::new(16));
    let rejections = Arc::new(Semaphore::new(4));
    let scans = Arc::new(Semaphore::new(1));
    let index_interval = std::time::Duration::from_secs(index_interval_seconds()?);
    loop {
        let url = format!(
            "{}/api/v1/agents/ws",
            server
                .replace("https://", "wss://")
                .replace("http://", "ws://")
        );
        let mut req = url.into_client_request()?;
        req.headers_mut()
            .insert("Authorization", format!("Bearer {token}").parse()?);
        if let Ok((mut socket, _)) = connect_async(req).await {
            if !matches!(
                tokio::time::timeout(
                    std::time::Duration::from_secs(3),
                    socket.send(Message::Text(
                        json!({"type":"HELLO","manual_scan":true})
                            .to_string()
                            .into()
                    ))
                )
                .await,
                Ok(Ok(()))
            ) {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
            let mut transfers = tokio::task::JoinSet::new();
            let mut scan: Option<IndexScan> = None;
            let mut refresh = tokio::time::interval(index_interval);
            refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                tokio::select! {
                    _ = transfers.join_next(), if !transfers.is_empty() => {}
                    _ = refresh.tick() => {
                        if scan.is_none() { scan = start_index(root.clone(), scans.clone()); }
                    }
                    page = async { scan.as_mut().unwrap().incoming.recv().await }, if scan.as_ref().is_some_and(|s| !s.awaiting_ack) => {
                        let current = scan.as_mut().unwrap();
                        let message = match page {
                            Some(Ok((items, final_page))) => {
                                current.final_page = final_page;
                                json!({"type":"INDEX","snapshot":current.snapshot,"sequence":current.sequence,"final":final_page,"items":items})
                            }
                            _ => {
                                tracing::warn!("index scan incomplete; retaining previous snapshot");
                                current.aborting = true;
                                json!({"type":"INDEX_ABORT","snapshot":current.snapshot,"sequence":current.sequence})
                            }
                        };
                        if !matches!(tokio::time::timeout(std::time::Duration::from_secs(3), socket.send(Message::Text(message.to_string().into()))).await, Ok(Ok(()))) { break }
                        current.awaiting_ack = true;
                        current.sent_at = tokio::time::Instant::now();
                    }
                    _=heartbeat.tick()=>{
                        if scan.as_ref().is_some_and(|s| s.awaiting_ack && s.sent_at.elapsed().as_secs() > 60) { break }
                        if !matches!(tokio::time::timeout(std::time::Duration::from_secs(3), socket.send(Message::Text(json!({"type":"HEARTBEAT"}).to_string().into()))).await, Ok(Ok(()))) { break }
                    }
                    message=socket.next()=>{let text = match message { Some(Ok(Message::Text(text))) => text, Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue, _ => break };let Ok(v)=serde_json::from_str::<Value>(&text)else{continue};
                        if v["type"] == "INDEX_ERROR" { break }
                        if v["type"] == "SCAN" {
                            let Some(request_id) = v["snapshot"].as_str() else { continue };
                            if request_id.is_empty() || request_id.len() > 64 { continue; }
                            let requested = if scan.is_none() { start_index(root.clone(), scans.clone()) } else { None };
                            if let Some(mut requested) = requested {
                                requested.snapshot = request_id.to_owned();
                                scan = Some(requested);
                            } else if !matches!(tokio::time::timeout(std::time::Duration::from_secs(3), socket.send(Message::Text(json!({"type":"SCAN_BUSY","snapshot":request_id}).to_string().into()))).await, Ok(Ok(()))) { break }
                            continue;
                        }
                        if v["type"] == "INDEX_ACK" || v["type"] == "INDEX_ABORT_ACK" {
                            let Some(current) = scan.as_mut() else { break };
                            if !current.awaiting_ack || v["sequence"].as_u64() != Some(current.sequence)
                                || (!v["snapshot"].is_null() && v["snapshot"] != current.snapshot)
                                || (v["type"] == "INDEX_ABORT_ACK") != current.aborting { break }
                            if current.aborting || current.final_page { scan = None; }
                            else { current.awaiting_ack = false; current.sequence += 1; }
                            continue
                        }
                        if v["type"]=="TRANSFER"{let mut request=v["request"].clone();
                        // Data ingress shares the configured service origin; localhost in server configuration is not the NAS host.
                        if let Some(value)=request["data_url"].as_str() {
                            let Ok(mut url)=reqwest::Url::parse(&std::env::var("AGENT_DATA_ORIGIN").unwrap_or_else(|_|server.clone())) else {continue};
                            let Ok(data)=reqwest::Url::parse(value) else {continue};
                            url.set_path(data.path());url.set_query(data.query());
                            let scheme=if url.scheme()=="https" {"wss"} else {"ws"};
                            if url.set_scheme(scheme).is_err(){continue}
                            request["data_url"]=json!(url.as_str());
                        }
                        let root=root.clone();
                        let permit = match slots.clone().try_acquire_owned() {
                            Ok(permit) => permit,
                            Err(_) => { let Ok(permit) = rejections.clone().try_acquire_owned() else { continue }; request["busy"] = json!(true); permit }
                        };
                        transfers.spawn(async move { let _permit=permit; if transfer(root,request).await.is_err(){tracing::warn!("transfer ended with error")} });}}
                }
            }
            drop(scan);
            // Control loss includes revoked credentials. No old transfer may
            // outlive that authorized connection or retain its admission slot.
            transfers.shutdown().await;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
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
