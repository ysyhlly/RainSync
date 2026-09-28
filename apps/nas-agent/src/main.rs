use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::io::{Read, Seek};
use std::{path::PathBuf, sync::Arc};
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

async fn transfer(root: PathBuf, request: Value) -> Result<()> {
    let url = request["data_url"].as_str().context("data_url")?;
    let (socket, _) =
        tokio::time::timeout(std::time::Duration::from_secs(10), connect_async(url)).await??;
    let (mut writer, mut reader) = socket.split();
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
                tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    writer.send(Message::Binary(buf.into())),
                )
                .await??;
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
            while let Some(Ok(Message::Ping(_) | Message::Pong(_))) = reader.next().await {}
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
) -> Result<()> {
    let mut stack = vec![root.to_path_buf()];
    let mut items = vec![];
    let mut bytes = 0;
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir)? {
            let e = entry?;
            let ty = e.file_type()?;
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
            let version =
                media_core::file_version::snapshot_file(&std::fs::File::open(&p)?)?.version;
            let item = json!({"title":title,"resource":resource,"source_version":version});
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
            if socket
                .send(Message::Text(
                    json!({"type":"HELLO","manual_scan":true})
                        .to_string()
                        .into(),
                ))
                .await
                .is_err()
            {
                continue;
            }
            let mut transfers = tokio::task::JoinSet::new();
            let (pages, mut incoming) = tokio::sync::mpsc::channel(2);
            let scan_root = root.clone();
            tokio::task::spawn_blocking(move || {
                if let Err(error) = index(&scan_root, &pages) {
                    let _ = pages.blocking_send(Err(error));
                }
            });
            let mut sequence = 0u64;
            let mut awaiting_ack = false;
            let mut sent_at = tokio::time::Instant::now();
            let mut finished = false;
            let mut snapshot = format!(
                "{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_nanos()
            );
            let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                tokio::select! {
                    _ = transfers.join_next(), if !transfers.is_empty() => {}
                    page = incoming.recv(), if !awaiting_ack && !finished => {
                        let Some(Ok((items, final_page))) = page else { break };
                        let message = json!({"type":"INDEX","snapshot":snapshot,"sequence":sequence,"final":final_page,"items":items});
                        if socket.send(Message::Text(message.to_string().into())).await.is_err() { break }
                        awaiting_ack = true;
                        sent_at = tokio::time::Instant::now();
                        finished = final_page;
                    }
                    _=heartbeat.tick()=>{if awaiting_ack && sent_at.elapsed().as_secs() > 60 { break }
                        if socket.send(Message::Text(json!({"type":"HEARTBEAT"}).to_string().into())).await.is_err(){break}}
                    message=socket.next()=>{let text = match message { Some(Ok(Message::Text(text))) => text, Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue, _ => break };let Ok(v)=serde_json::from_str::<Value>(&text)else{continue};
                        if v["type"] == "INDEX_ERROR" { break }
                        if v["type"] == "SCAN" {
                            if !finished || awaiting_ack {
                                if socket.send(Message::Text(json!({"type":"SCAN_BUSY","snapshot":v["snapshot"]}).to_string().into())).await.is_err() { break }
                                continue;
                            }
                            let Some(request_id) = v["snapshot"].as_str() else { continue };
                            if request_id.len() > 64 { continue; }
                            let (pages, receiver) = tokio::sync::mpsc::channel(2);
                            incoming = receiver;
                            let scan_root = root.clone();
                            tokio::task::spawn_blocking(move || {
                                if let Err(error) = index(&scan_root, &pages) { let _ = pages.blocking_send(Err(error)); }
                            });
                            snapshot = request_id.to_string();
                            sequence = 0;
                            finished = false;
                            continue;
                        }
                        if v["type"] == "INDEX_ACK" {
                            if !awaiting_ack || v["sequence"].as_u64() != Some(sequence) { break }
                            awaiting_ack = false;
                            sequence += 1;
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
        let scan = std::thread::spawn(move || index(&scan_root, &sender));
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
        assert!(index(&root, &sender).is_err());
    }
}
