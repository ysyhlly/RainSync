mod cache;
mod relay;
use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
use axum::{
    Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    sync::Mutex,
};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

#[derive(Clone)]
struct App {
    db: PgPool,
    key: Arc<Aes256Gcm>,
    cache: PathBuf,
    client: reqwest::Client,
    relay: Arc<Mutex<HashMap<Uuid, relay::Pending>>>,
    public_url: String,
    probes: Arc<tokio::sync::Semaphore>,
}
fn hash(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}
fn decrypt(app: &App, v: &str) -> anyhow::Result<Value> {
    let b = STANDARD.decode(v)?;
    anyhow::ensure!(b.len() >= 12, "ciphertext");
    let data = app
        .key
        .decrypt(b[..12].into(), &b[12..])
        .map_err(|_| anyhow::anyhow!("decrypt"))?;
    Ok(serde_json::from_slice(&data)?)
}
type Result<T> = std::result::Result<T, (StatusCode, String)>;
fn failure(_: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::BAD_GATEWAY, "media_unavailable".into())
}

#[derive(serde::Deserialize)]
struct Params {
    token: String,
    #[serde(default)]
    url: Option<String>,
}
async fn delivery(
    State(app): State<App>,
    Path((id, path)): Path<(Uuid, String)>,
    Query(q): Query<Params>,
    h: HeaderMap,
    method: axum::http::Method,
) -> Result<Response> {
    let row=sqlx::query("SELECT p.resource FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id WHERE p.id=$1 AND p.delivery_token_hash=$2 AND p.expires_at>now() AND NOT p.stopped AND (s.state->>'media_generation')::bigint=p.generation AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id)").bind(id).bind(hash(&q.token)).fetch_optional(&app.db).await.map_err(failure)?.ok_or((StatusCode::UNAUTHORIZED,"invalid_playback_session".into()))?;
    let data: Value = row.get("resource");
    let resource = decrypt(&app, data["encrypted"].as_str().unwrap_or("")).map_err(failure)?;
    let head = method == axum::http::Method::HEAD;
    if path == "probe" {
        let _permit = app
            .probes
            .try_acquire()
            .map_err(|_| (StatusCode::TOO_MANY_REQUESTS, "probe_busy".into()))?;
        let metadata = media_core::probe(&source_url(id, &q.token).map_err(failure)?)
            .await
            .map_err(failure)?;
        return Ok(axum::Json(metadata).into_response());
    }
    if path.starts_with("subtitle-") && path.ends_with(".vtt") {
        let index = path
            .trim_start_matches("subtitle-")
            .trim_end_matches(".vtt")
            .parse::<u32>()
            .map_err(failure)?;
        if !resource["subtitle_indices"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(index)))
        {
            return Err((StatusCode::FORBIDDEN, "invalid_subtitle".into()));
        }
        if let Some(value) = resource["subtitle_urls"][index.to_string()].as_str() {
            let url = url::Url::parse(value).map_err(failure)?;
            let base = url::Url::parse(resource["upstream_base"].as_str().unwrap_or(""))
                .map_err(failure)?;
            if url.origin() != base.origin() {
                return Err((StatusCode::FORBIDDEN, "cross_origin_subtitle".into()));
            }
            let mut request = app.client.get(url);
            if let Some(headers) = resource["headers"].as_object() {
                for (k, v) in headers {
                    if let Some(v) = v.as_str() {
                        request = request.header(k, v);
                    }
                }
            }
            let response = request
                .send()
                .await
                .map_err(failure)?
                .error_for_status()
                .map_err(failure)?;
            use futures_util::StreamExt;
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(failure)?;
                if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                    return Err(failure("subtitle_too_large"));
                }
                bytes.extend_from_slice(&chunk);
            }
            if !bytes.starts_with(b"WEBVTT") {
                return Err(failure("invalid_webvtt"));
            }
            return Ok((
                [
                    (header::CONTENT_TYPE, "text/vtt; charset=utf-8"),
                    (header::CACHE_CONTROL, "private, no-store"),
                ],
                if head { Vec::new() } else { bytes },
            )
                .into_response());
        }
        let sidecar = resource["subtitle_files"][index.to_string()].as_str();
        let input = if resource["kind"] == "local" {
            media_core::safe_path(
                std::path::Path::new(resource["root"].as_str().unwrap_or("")),
                sidecar.unwrap_or(resource["resource"].as_str().unwrap_or("")),
            )
            .map_err(failure)?
            .to_string_lossy()
            .into_owned()
        } else {
            source_url(id, &q.token).map_err(failure)?
        };
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            tokio::process::Command::new("ffmpeg")
                .args([
                    "-v",
                    "error",
                    "-nostdin",
                    "-ss",
                    &(resource["timeline_origin_ms"].as_f64().unwrap_or(0.0) / 1000.0).to_string(),
                    "-i",
                ])
                .arg(input)
                .args([
                    "-map",
                    &format!("0:{}", if sidecar.is_some() { 0 } else { index }),
                    "-f",
                    "webvtt",
                    "pipe:1",
                ])
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(failure)?
        .map_err(failure)?;
        if !output.status.success() {
            return Err(failure("subtitle_failed"));
        }
        return Ok((
            [
                (header::CONTENT_TYPE, "text/vtt; charset=utf-8"),
                (header::CACHE_CONTROL, "private, no-store"),
            ],
            output.stdout,
        )
            .into_response());
    }
    if resource.get("job_id").is_some() && path != "source" && q.url.is_none() {
        if path.contains('/') || path.contains('\\') || path.contains("..") {
            return Err((StatusCode::BAD_REQUEST, "invalid_resource".into()));
        }
        let file = app.cache.join(id.to_string()).join(&path);
        for _ in 0..30 {
            if file.is_file() {
                break;
            }
            let status: Option<String> =
                sqlx::query_scalar("SELECT status FROM media_jobs WHERE id=$1")
                    .bind(id)
                    .fetch_optional(&app.db)
                    .await
                    .map_err(failure)?;
            if matches!(status.as_deref(), Some("failed" | "cancelled")) {
                return Err((StatusCode::BAD_GATEWAY, "media_job_failed".into()));
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        if path.ends_with(".m3u8") {
            let manifest = tokio::fs::read_to_string(file).await.map_err(failure)?;
            let text = rewrite_manifest(&manifest, |uri| {
                format!("/media-delivery/{id}/{uri}?token={}", q.token)
            });
            return Ok((
                [
                    (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                if head { String::new() } else { text },
            )
                .into_response());
        }
        return file_response(&file, &h, head).await;
    }
    if resource["kind"] == "agent" {
        return relay::fetch(&app, &resource, &h, head).await;
    }
    if resource["kind"] == "local" {
        let p = media_core::safe_path(
            std::path::Path::new(resource["root"].as_str().unwrap_or("")),
            resource["resource"].as_str().unwrap_or(""),
        )
        .map_err(failure)?;
        return file_response(&p, &h, head).await;
    }
    let original = url::Url::parse(resource["url"].as_str().unwrap_or("")).map_err(failure)?;
    let target = if let Some(encoded) = q.url.as_deref() {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(failure)?;
        if bytes.len() < 12 {
            return Err((StatusCode::BAD_REQUEST, "invalid_resource".into()));
        }
        let plain = app
            .key
            .decrypt(bytes[..12].into(), &bytes[12..])
            .map_err(|_| (StatusCode::FORBIDDEN, "invalid_resource_signature".into()))?;
        let grant: Value = serde_json::from_slice(&plain).map_err(failure)?;
        if grant["session"] != id.to_string() {
            return Err((StatusCode::FORBIDDEN, "wrong_resource_session".into()));
        }
        url::Url::parse(grant["url"].as_str().unwrap_or("")).map_err(failure)?
    } else {
        original.clone()
    };
    // Never forward source credentials to a different origin. Redirects are disabled.
    if target.origin() != original.origin() || !matches!(target.scheme(), "http" | "https") {
        return Err((StatusCode::FORBIDDEN, "cross_origin_media_rejected".into()));
    }
    let mut request = if head {
        app.client.head(target.clone())
    } else {
        app.client.get(target.clone())
    };
    if let Some(headers) = resource["headers"].as_object() {
        for (k, v) in headers {
            if let Some(v) = v.as_str() {
                request = request.header(k, v);
            }
        }
    }
    if let Some(range) = h.get(header::RANGE) {
        request = request.header(header::RANGE, range)
    }
    let response = request.send().await.map_err(failure)?;
    let status = response.status();
    if !status.is_success() {
        return Err((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            "upstream_media_error".into(),
        ));
    }
    let is_playlist = target.path().ends_with(".m3u8")
        || response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|s| s.contains("mpegurl"));
    if is_playlist && !head {
        if response.content_length().unwrap_or(0) > 2 * 1024 * 1024 {
            return Err((StatusCode::BAD_GATEWAY, "manifest_too_large".into()));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            bytes.extend_from_slice(&chunk.map_err(failure)?);
            if bytes.len() > 2 * 1024 * 1024 {
                return Err((StatusCode::BAD_GATEWAY, "manifest_too_large".into()));
            }
        }
        let manifest = String::from_utf8(bytes).map_err(failure)?;
        let text = rewrite_manifest(&manifest, |uri| {
            let absolute = target.join(uri).map(|v| v.to_string()).unwrap_or_default();
            let nonce = Uuid::new_v4();
            let nonce = &nonce.as_bytes()[..12];
            let data = serde_json::to_vec(&json!({"session":id,"url":absolute})).unwrap();
            let cipher = app
                .key
                .encrypt(nonce.into(), data.as_slice())
                .expect("valid nonce");
            let grant = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode([nonce.to_vec(), cipher].concat());
            let extension = target
                .join(uri)
                .ok()
                .and_then(|url| {
                    url.path()
                        .rsplit('.')
                        .next()
                        .filter(|ext| {
                            matches!(*ext, "m3u8" | "ts" | "m4s" | "mp4" | "aac" | "vtt" | "key")
                        })
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| "bin".into());
            format!(
                "/media-delivery/{id}/segment.{extension}?token={}&url={grant}",
                q.token
            )
        });
        return Ok((
            [
                (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            text,
        )
            .into_response());
    }
    let mut builder = Response::builder().status(status);
    for key in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(v) = response.headers().get(&key) {
            builder = builder.header(key, v)
        }
    }
    builder
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(if head {
            Body::empty()
        } else {
            Body::from_stream(response.bytes_stream())
        })
        .map_err(failure)
}
fn rewrite_manifest(input: &str, mut uri: impl FnMut(&str) -> String) -> String {
    input
        .lines()
        .map(|line| {
            if line.is_empty() {
                String::new()
            } else if !line.starts_with('#') {
                uri(line.trim())
            } else if let Some(start) = line.find("URI=\"") {
                let pos = start + 5;
                if let Some(end) = line[pos..].find('"') {
                    format!(
                        "{}{}{}",
                        &line[..pos],
                        uri(&line[pos..pos + end]),
                        &line[pos + end..]
                    )
                } else {
                    line.into()
                }
            } else {
                line.into()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
async fn file_response(path: &std::path::Path, h: &HeaderMap, head: bool) -> Result<Response> {
    let mut file = tokio::fs::File::open(path).await.map_err(failure)?;
    let size = file.metadata().await.map_err(failure)?.len();
    let range =
        match media_core::byte_range(h.get(header::RANGE).and_then(|v| v.to_str().ok()), size) {
            Ok(v) => v,
            Err(_) => {
                return Ok(Response::builder()
                    .status(416)
                    .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                    .body(Body::empty())
                    .unwrap());
            }
        };
    let (start, len) = range.map(|(a, b)| (a, b - a + 1)).unwrap_or((0, size));
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(failure)?;
    let mime = match path.extension().and_then(|x| x.to_str()).unwrap_or("") {
        "m3u8" => "application/vnd.apple.mpegurl",
        "m4s" => "video/iso.segment",
        "vtt" => "text/vtt",
        "webm" => "video/webm",
        _ => "video/mp4",
    };
    let mut b = Response::builder()
        .status(if range.is_some() { 206 } else { 200 })
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, len)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, no-store");
    if let Some((a, z)) = range {
        b = b.header(header::CONTENT_RANGE, format!("bytes {a}-{z}/{size}"))
    }
    b.body(if head {
        Body::empty()
    } else {
        Body::from_stream(ReaderStream::with_capacity(file.take(len), 65536))
    })
    .map_err(failure)
}
fn source_url(id: Uuid, token: &str) -> anyhow::Result<String> {
    let bind = std::env::var("WORKER_BIND")
        .unwrap_or("0.0.0.0:8081".into())
        .parse::<std::net::SocketAddr>()?;
    let host = if bind.is_ipv6() { "[::1]" } else { "127.0.0.1" };
    Ok(format!(
        "http://{host}:{}/media-delivery/{id}/source?token={token}",
        bind.port()
    ))
}
async fn jobs(app: App) {
    let worker = Uuid::new_v4();
    loop {
        let result: anyhow::Result<()> = async{
            let row=sqlx::query("UPDATE media_jobs SET status='running',owner_id=$1,lease_until=now()+interval '30 seconds' WHERE id=(SELECT j.id FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id WHERE (j.status='queued' OR (j.status='running' AND j.lease_until<now())) AND NOT p.stopped AND p.expires_at>now() ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING id,spec").bind(worker).fetch_optional(&app.db).await?;
            let Some(row)=row else{tokio::time::sleep(std::time::Duration::from_secs(1)).await;return Ok(())};let id:Uuid=row.get("id");let spec:Value=row.get("spec");
            let result:anyhow::Result<()>=async{
                cache::ensure_capacity(&app).await?;
                let input = if let Some(ticket) = spec["input_ticket"].as_str() {
                    let ticket = decrypt(&app, ticket)?;
                    let token = ticket["token"].as_str().ok_or_else(||anyhow::anyhow!("invalid_input_ticket"))?;
                    source_url(id, token)?
                } else {
                    media_core::safe_path(std::path::Path::new(spec["root"].as_str().unwrap_or("")),spec["resource"].as_str().unwrap_or(""))?.to_str().ok_or_else(||anyhow::anyhow!("path"))?.to_owned()
                };
                let dir=app.cache.join(id.to_string());tokio::fs::create_dir_all(&dir).await?;
                let mut args=media_core::hls_args(&input,dir.join("index.m3u8").to_str().unwrap(),spec["start_seconds"].as_f64().unwrap_or(0.0),spec["transcode"].as_bool().unwrap_or(true));
                if let Some(index)=spec["audio_index"].as_u64()&& let Some(arg)=args.iter_mut().find(|a|a.as_str()=="0:a:0?"){*arg=format!("0:{index}")}
                let mut child=tokio::process::Command::new("ffmpeg").args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true).spawn()?;
                loop{tokio::select!{status=child.wait()=>{anyhow::ensure!(status?.success(),"ffmpeg_failed");break},_=tokio::time::sleep(std::time::Duration::from_secs(5))=>{
                    let result=sqlx::query("UPDATE media_jobs j SET lease_until=now()+interval '30 seconds' FROM playback_sessions p WHERE j.id=$1 AND j.owner_id=$2 AND j.status='running' AND p.id=j.session_id AND NOT p.stopped AND p.expires_at>now()").bind(id).bind(worker).execute(&app.db).await?;
                    if result.rows_affected()==0{child.kill().await?;anyhow::bail!("cancelled")}
                    if cache::ensure_capacity(&app).await.is_err(){child.kill().await?;anyhow::bail!("cache_full")}
                }}}Ok(())
            }.await;
            sqlx::query("UPDATE media_jobs SET status=$3,error=$4,lease_until=NULL WHERE id=$1 AND owner_id=$2 AND status='running'").bind(id).bind(worker).bind(if result.is_ok(){"succeeded"}else{"failed"}).bind(result.err().map(|_|"media_job_failed")).execute(&app.db).await?;Ok(())
        }.await;
        if result.is_err() {
            tracing::warn!("media queue retry");
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    let key = STANDARD.decode(std::env::var("SOURCE_ENCRYPTION_KEY")?)?;
    let app = App {
        db,
        key: Arc::new(
            Aes256Gcm::new_from_slice(&key)
                .map_err(|_| anyhow::anyhow!("invalid encryption key"))?,
        ),
        cache: PathBuf::from(std::env::var("CACHE_ROOT").unwrap_or("/cache".into())),
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(30))
            .build()?,
        relay: Default::default(),
        probes: Arc::new(tokio::sync::Semaphore::new(2)),
        public_url: std::env::var("PUBLIC_ORIGIN").unwrap_or("http://localhost:8088".into()),
    };
    tokio::fs::create_dir_all(&app.cache).await?;
    tokio::spawn(jobs(app.clone()));
    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/media-delivery/{id}/{path}", get(delivery).head(delivery))
        .route("/agent-data/{id}", get(relay::connect))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(
        std::env::var("WORKER_BIND").unwrap_or("0.0.0.0:8081".into()),
    )
    .await?;
    axum::serve(listener, router).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewrites_keys_and_segments() {
        let s = rewrite_manifest("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\na.m4s\n", |v| {
            format!("signed/{v}")
        });
        assert!(s.contains("URI=\"signed/init.mp4\""));
        assert!(s.contains("signed/a.m4s"));
    }
}
