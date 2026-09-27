use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    sync::Semaphore,
};
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
    let (mut socket, _) = connect_async(url).await?;
    if request["busy"].as_bool().unwrap_or(false) {
        socket
            .send(Message::Text(
                json!({"status":503,"content-length":"0"})
                    .to_string()
                    .into(),
            ))
            .await?;
        socket.close(None).await?;
        return Ok(());
    }
    let result:Result<()>=async{
        let path=media_core::safe_path(&root,request["resource"].as_str().context("resource")?)?;
        let mut file=tokio::fs::File::open(&path).await?;let size=file.metadata().await?.len();
        let range=match media_core::byte_range(request["range"].as_str(),size){Ok(v)=>v,Err(_)=>{socket.send(Message::Text(json!({"status":416,"content-range":format!("bytes */{size}"),"content-length":"0"}).to_string().into())).await?;return Ok(())}};
        let(start,len)=range.map(|(a,b)|(a,b-a+1)).unwrap_or((0,size));
        let mut meta=json!({"status":if range.is_some(){206}else{200},"content-length":len.to_string(),"content-type":content_type(&path),"accept-ranges":"bytes"});if let Some((a,b))=range{meta["content-range"]=json!(format!("bytes {a}-{b}/{size}"))}
        socket.send(Message::Text(meta.to_string().into())).await?;
        if !request["head"].as_bool().unwrap_or(false){file.seek(std::io::SeekFrom::Start(start)).await?;let mut file=file.take(len);let mut buf=vec![0;65536];loop{let n=file.read(&mut buf).await?;if n==0{break}socket.send(Message::Binary(buf[..n].to_vec().into())).await?;}}
        Ok(())
    }.await;
    if result.is_err() {
        let _ = socket
            .send(Message::Text(
                json!({"status":404,"content-length":"0"})
                    .to_string()
                    .into(),
            ))
            .await;
    }
    let _ = socket.close(None).await;
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
            let item = json!({"title":title,"resource":resource});
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
            let snapshot = format!(
                "{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_nanos()
            );
            let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                tokio::select! {
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
                        let root=root.clone();let slots=slots.clone();tokio::spawn(async move{let Ok(_permit)=slots.try_acquire_owned()else{let mut request=request;request["busy"]=json!(true);let _=transfer(root,request).await;return};if transfer(root,request).await.is_err(){tracing::warn!("transfer ended with error")}});}}
                }
            }
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
