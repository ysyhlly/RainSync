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
        let mut file=tokio::fs::File::open(path).await?;let size=file.metadata().await?.len();
        let range=match media_core::byte_range(request["range"].as_str(),size){Ok(v)=>v,Err(_)=>{socket.send(Message::Text(json!({"status":416,"content-range":format!("bytes */{size}"),"content-length":"0"}).to_string().into())).await?;return Ok(())}};
        let(start,len)=range.map(|(a,b)|(a,b-a+1)).unwrap_or((0,size));
        let mut meta=json!({"status":if range.is_some(){206}else{200},"content-length":len.to_string(),"content-type":"video/mp4","accept-ranges":"bytes"});if let Some((a,b))=range{meta["content-range"]=json!(format!("bytes {a}-{b}/{size}"))}
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
fn index(root: &std::path::Path) -> Result<Vec<Value>> {
    let mut stack = vec![root.to_path_buf()];
    let mut items = vec![];
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
            if ["mp4", "mkv", "webm", "mov"].contains(&ext.as_str()) {
                items.push(json!({"title":p.file_stem().unwrap().to_string_lossy(),"resource":p.strip_prefix(root)?.to_string_lossy().replace('\\',"/")}));
            }
            anyhow::ensure!(items.len() < 10000, "library limit");
        }
    }
    Ok(items)
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
            let items = index(&root)?;
            socket
                .send(Message::Text(
                    json!({"type":"INDEX","items":items}).to_string().into(),
                ))
                .await?;
            let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                tokio::select! {
                    _=heartbeat.tick()=>{if socket.send(Message::Text(json!({"type":"HEARTBEAT"}).to_string().into())).await.is_err(){break}}
                    message=socket.next()=>{let Some(Ok(Message::Text(text)))=message else{break};let Ok(v)=serde_json::from_str::<Value>(&text)else{continue};if v["type"]=="TRANSFER"{let mut request=v["request"].clone();
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
