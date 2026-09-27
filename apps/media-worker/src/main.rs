mod cache;
mod cache_outputs;
mod cache_read;
use media_core::child_process;
mod input_failure;
mod output_decode;
mod output_publish;
mod output_read;
mod outputs;
mod process;
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
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::{path::PathBuf, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

#[derive(Clone)]
struct App {
    db: PgPool,
    key: Arc<Aes256Gcm>,
    cache: PathBuf,
    client: reqwest::Client,
    relay: relay::Registry,
    public_url: String,
    probes: Arc<tokio::sync::Semaphore>,
    output_checks: Arc<output_read::Checks>,
    input_failures: input_failure::Registry,
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
    #[serde(default)]
    attempt: Option<i64>,
    #[serde(default)]
    execution: Option<Uuid>,
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
    let input_failure = app.input_failures.observe(id, q.execution);
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
            let bytes = media_core::subtitles::shift_webvtt(
                &bytes,
                resource["timeline_origin_ms"].as_f64().unwrap_or(0.0),
            )
            .map_err(failure)?;
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
        if sidecar.is_some() {
            let size = tokio::fs::metadata(&input).await.map_err(failure)?.len();
            if size > media_core::subtitles::MAX_BYTES as u64 {
                return Err(failure("subtitle_too_large"));
            }
        }
        let mut command = tokio::process::Command::new("ffmpeg");
        command
            .args(["-v", "error", "-nostdin", "-i"])
            .arg(input)
            .args([
                "-map",
                &format!("0:{}", if sidecar.is_some() { 0 } else { index }),
                "-f",
                "webvtt",
                "pipe:1",
            ]);
        let (status, bytes) = child_process::capture(
            command,
            std::time::Duration::from_secs(30),
            media_core::subtitles::MAX_BYTES,
        )
        .await
        .map_err(failure)?;
        if !status.success() {
            return Err(failure("subtitle_failed"));
        }
        let output = media_core::subtitles::shift_webvtt(
            &bytes,
            resource["timeline_origin_ms"].as_f64().unwrap_or(0.0),
        )
        .map_err(failure)?;
        return Ok((
            [
                (header::CONTENT_TYPE, "text/vtt; charset=utf-8"),
                (header::CACHE_CONTROL, "private, no-store"),
            ],
            if head { Vec::new() } else { output },
        )
            .into_response());
    }
    if resource.get("job_id").is_some() && path != "source" && q.url.is_none() {
        if path != "index.m3u8" && !outputs::media_path(&path) {
            return Err((StatusCode::BAD_REQUEST, "invalid_resource".into()));
        }
        let mut output = None;
        for _ in 0..30 {
            let job =
                sqlx::query("SELECT j.status,j.error,j.attempt,o.status AS output_status,o.manifest_sha256,o.validation_version,o.visible_manifest,(j.status='succeeded' OR (j.status='running' AND j.lease_until>clock_timestamp())) AS readable FROM media_jobs j LEFT JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt WHERE j.id=$1")
                    .bind(id)
                    .fetch_optional(&app.db)
                    .await
                    .map_err(failure)?;
            let Some(job) = job else {
                return Err((StatusCode::BAD_GATEWAY, "media_job_failed".into()));
            };
            let status: String = job.get("status");
            let attempt: i64 = job.get("attempt");
            if q.attempt.is_some_and(|requested| requested != attempt) {
                return Err((StatusCode::CONFLICT, "stale_media".into()));
            }
            // Only the entry playlist may discover the current attempt. Its
            // child URLs must remain pinned, including the init segment.
            if path != "index.m3u8" && q.attempt.is_none() {
                return Err((StatusCode::CONFLICT, "stale_media".into()));
            }
            if status == "cancelled" {
                return Err((StatusCode::GONE, "media_job_cancelled".into()));
            }
            if status == "failed" {
                let stored: Option<String> = job.get("error");
                let (status, reason) = persistence::media_jobs::terminal_error(stored.as_deref());
                return Err((
                    StatusCode::from_u16(status).expect("fixed terminal status"),
                    reason.into(),
                ));
            }
            let output_status: Option<String> = job.get("output_status");
            if (status == "succeeded"
                && !matches!(output_status.as_deref(), Some("published" | "legacy")))
                || (status == "running" && output_status.as_deref() != Some("writing"))
            {
                return Err((StatusCode::BAD_GATEWAY, "media_job_failed".into()));
            }
            let manifest_digest: Option<String> = job.get("manifest_sha256");
            let persisted = job
                .get::<Option<i32>, _>("validation_version")
                .is_some_and(|v| v >= 2);
            let visible: Option<String> = job.get("visible_manifest");
            if persisted && visible.is_none() && status == "running" {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
            let directory = persistence::media_jobs::output_dir(&app.cache, id, attempt);
            let file = directory.join(&path);
            if job.get::<Option<bool>, _>("readable").unwrap_or(false)
                && ((persisted && path == "index.m3u8") || file.is_file())
            {
                let reader = cache_read::ReadGuard::acquire(&app.db, id, attempt)
                    .await
                    .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "media_unavailable".into()))?;
                let checked = async {
                    let text = if persisted {
                        visible.ok_or_else(|| anyhow::anyhow!("output_not_ready"))?
                    } else {
                        outputs::read_manifest(&directory.join("index.m3u8")).await?
                    };
                    anyhow::ensure!(
                        if persisted { manifest_digest.as_ref().is_some_and(|digest| hash(&text) == *digest) }
                        else { status != "succeeded" || manifest_digest.as_ref().is_none_or(|digest| hash(&text) == *digest) },
                        "output_manifest_changed"
                    );
                    let text = if persisted {
                        anyhow::ensure!(outputs::readable_manifest(&text), "invalid_output_manifest");
                        text
                    } else { app.output_checks.snapshot(directory, text).await? };
                    let opened = if path == "index.m3u8" {
                        None
                    } else {
                        anyhow::ensure!(
                            path == "init.mp4" || text.lines().any(|line| line == path),
                            "unpublished_output_segment"
                        );
                        let proof = if persisted {
                            let index: i32 = if path == "init.mp4" { -1 } else { path.strip_prefix("index").and_then(|v| v.strip_suffix(".m4s")).unwrap_or("").parse()? };
                            let row = sqlx::query("SELECT size_bytes,sha256 FROM media_output_files WHERE job_id=$1 AND attempt=$2 AND segment_index=$3")
                                .bind(id).bind(attempt).bind(index).fetch_one(&app.db).await?;
                            Some(persistence::media_outputs::FileProof { index, size_bytes: row.get("size_bytes"), sha256: row.get("sha256") })
                        } else { None };
                        Some(app.output_checks.open(file.clone(), proof).await?)
                    };
                    Ok::<_, anyhow::Error>((text, opened))
                }
                .await;
                let (text, opened) = match checked {
                    Ok(value) => value,
                    _ if status == "running" => {
                        // Recheck the job/attempt on every retry; never serve a torn write.
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        continue;
                    }
                    _ => return Err((StatusCode::BAD_GATEWAY, "media_job_failed".into())),
                };
                let manifest = (path == "index.m3u8").then_some(text);
                output = Some((
                    file,
                    attempt,
                    status == "succeeded",
                    manifest_digest,
                    manifest,
                    reader,
                    opened,
                ));
                break;
            }
            if status == "succeeded" {
                return Err((StatusCode::BAD_GATEWAY, "media_job_failed".into()));
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        let (file, attempt, complete, manifest_digest, manifest, reader, opened) =
            output.ok_or((StatusCode::SERVICE_UNAVAILABLE, "media_unavailable".into()))?;
        if !reader.healthy() {
            return Err((StatusCode::SERVICE_UNAVAILABLE, "media_unavailable".into()));
        }
        if let Some(manifest) = manifest {
            if complete && manifest_digest.is_some_and(|digest| hash(&manifest) != digest) {
                return Err((StatusCode::BAD_GATEWAY, "media_job_failed".into()));
            }
            // ENDLIST is visible only after this attempt commits success.
            let manifest = if complete {
                manifest
            } else {
                manifest
                    .lines()
                    .filter(|line| *line != "#EXT-X-ENDLIST")
                    .map(|line| format!("{line}\n"))
                    .collect::<String>()
            };
            let text = rewrite_manifest(&manifest, |uri| {
                format!(
                    "/media-delivery/{id}/{uri}?token={}&attempt={attempt}",
                    q.token
                )
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
        return file_response(&file, &h, head, Some(reader), opened).await;
    }
    if resource["kind"] == "agent" {
        return relay::fetch(&app, &resource, &h, head, input_failure).await;
    }
    if resource["kind"] == "local" {
        let p = media_core::safe_path(
            std::path::Path::new(resource["root"].as_str().unwrap_or("")),
            resource["resource"].as_str().unwrap_or(""),
        )
        .map_err(failure)?;
        return file_response(&p, &h, head, None, None).await;
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
    let response = request.send().await.map_err(|error| {
        input_failure.network(&error);
        failure(error)
    })?;
    let status = response.status();
    input_failure.status(status);
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
            bytes.extend_from_slice(&chunk.map_err(|error| {
                input_failure.network(&error);
                failure(error)
            })?);
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
            let execution = q
                .execution
                .map(|t| format!("&execution={t}"))
                .unwrap_or_default();
            format!(
                "/media-delivery/{id}/segment.{extension}?token={}&url={grant}{execution}",
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
            Body::from_stream(response.bytes_stream().map(move |chunk| {
                if let Err(error) = &chunk {
                    input_failure.network(error);
                }
                chunk
            }))
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
            } else if line.starts_with("#EXT-X-") && line.contains(':') {
                let (tag, attributes) = line.split_once(':').unwrap();
                let mut output = format!("{tag}:");
                let mut quoted = false;
                let mut start = 0;
                // Commas inside quoted strings are not attribute separators.
                for (i, byte) in attributes.bytes().chain(std::iter::once(b',')).enumerate() {
                    if byte == b'"' {
                        quoted = !quoted;
                    }
                    if byte == b',' && !quoted {
                        let field = &attributes[start..i];
                        if let Some((key, value)) = field.split_once('=')
                            && key == "URI"
                            && let Some(value) =
                                value.strip_prefix('"').and_then(|v| v.strip_suffix('"'))
                        {
                            output.push_str(&format!("URI=\"{}\"", uri(value)));
                        } else {
                            output.push_str(field);
                        }
                        if i < attributes.len() {
                            output.push(',');
                        }
                        start = i + 1;
                    }
                }
                if start <= attributes.len() {
                    output.push_str(&attributes[start..]);
                }
                output
            } else {
                line.into()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
async fn file_response(
    path: &std::path::Path,
    h: &HeaderMap,
    head: bool,
    reader: Option<cache_read::ReadGuard>,
    checked_file: Option<tokio::fs::File>,
) -> Result<Response> {
    let mut file = match checked_file {
        Some(file) => file,
        None => tokio::fs::File::open(path).await.map_err(failure)?,
    };
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
        match reader {
            Some(reader) => reader.body(file.take(len)),
            None => Body::from_stream(ReaderStream::with_capacity(file.take(len), 65536)),
        }
    })
    .map_err(failure)
}
fn source_url(id: Uuid, token: &str) -> anyhow::Result<String> {
    let bind = std::env::var("WORKER_BIND")
        .unwrap_or("0.0.0.0:8081".into())
        .parse::<std::net::SocketAddr>()?;
    Ok(source_url_for_bind(bind, id, token))
}
fn source_url_for_bind(mut bind: std::net::SocketAddr, id: Uuid, token: &str) -> String {
    if bind.ip().is_unspecified() {
        bind.set_ip(if bind.is_ipv6() {
            std::net::Ipv6Addr::LOCALHOST.into()
        } else {
            std::net::Ipv4Addr::LOCALHOST.into()
        });
    }
    format!("http://{bind}/media-delivery/{id}/source?token={token}")
}
async fn jobs(app: App, mut stop: tokio::sync::watch::Receiver<bool>) {
    use std::time::Duration;
    let worker = Uuid::new_v4();
    loop {
        let mut reservation = None;
        let mut writer_stopped = true;
        let output_decoder = output_decode::Gate::default();
        let result: anyhow::Result<()> = async {
            let claim = tokio::select! {
                biased;
                _ = process::stopped(&mut stop) => return Ok(()),
                claim = tokio::time::timeout(Duration::from_secs(3), persistence::media_jobs::claim(&app.db, worker)) => claim??,
            };
            let Some(claim) = claim else { return Ok(()) };
            reservation = Some((claim.id, claim.owner, claim.attempt));
            let output_builder: output_publish::Shared = Default::default();
            let input_failure = app.input_failures.register(claim.id);
            // Preparation has no child and can be cancelled. Once spawned,
            // supervision must finish its explicit kill/wait before release.
            let prepare = async {
                cache::ensure_capacity(&app).await?;
                cache::reserve_output(&app, &claim).await?;
                let spec = &claim.spec;
                let input = if let Some(ticket) = spec["input_ticket"].as_str() {
                    let ticket = decrypt(&app, ticket)?;
                    let token = ticket["token"].as_str().ok_or_else(|| anyhow::anyhow!("invalid_input_ticket"))?;
                    format!("{}&execution={}", source_url(claim.id, token)?, input_failure.token())
                } else {
                    media_core::safe_path(std::path::Path::new(spec["root"].as_str().unwrap_or("")), spec["resource"].as_str().unwrap_or(""))?.to_str().ok_or_else(|| anyhow::anyhow!("path"))?.to_owned()
                };
                let dir = persistence::media_jobs::output_dir(&app.cache, claim.id, claim.attempt);
                tokio::fs::create_dir_all(&dir).await.map_err(cache::write_error)?;
                let audio_index = spec["audio_index"].as_u64().map(u32::try_from).transpose()?;
                let args = media_core::hls_args(&input, dir.join("index.m3u8").to_str().unwrap(), spec["start_seconds"].as_f64().unwrap_or(0.0), spec["transcode"].as_bool().unwrap_or(true), audio_index);
                anyhow::ensure!(persistence::media_jobs::renew(&app.db, &claim).await?, "lease_lost_before_spawn");
                Ok::<_, anyhow::Error>(args)
            };
            let prepared = tokio::select! {
                biased;
                _ = process::stopped(&mut stop) => Err(anyhow::anyhow!("worker_shutdown")),
                result = prepare => result,
            };
            let mut execution_stopped = true;
            let mut result = async {
                let args = prepared?;
                anyhow::ensure!(!*stop.borrow(), "worker_shutdown");
                let mut command = tokio::process::Command::new("ffmpeg");
                command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
                #[cfg(windows)]
                command.creation_flags(0x08000000);
                let mut child = child_process::spawn(command)?;
                writer_stopped = false;
                execution_stopped = false;
                let result = process::supervise(&mut child, &mut stop, || async {
                    persistence::media_jobs::renew(&app.db, &claim).await
                }, async {
                    tokio::select! {
                        error = cache::monitor(&app) => error,
                        error = output_publish::monitor(&app.db, &claim, persistence::media_jobs::output_dir(&app.cache, claim.id, claim.attempt), output_builder.clone(), &output_decoder) => error,
                    }
                }).await;
                execution_stopped = child.try_wait()?.is_some();
                writer_stopped = execution_stopped;
                result
            }.await;
            if result.as_ref().is_err_and(|e| e.is::<process::LeaseInterrupted>()) {
                // Reaped child; leave the fenced lease to expire and be retried by the queue.
                return result;
            }
            if !*stop.borrow() && execution_stopped {
                match process::finalization_deadline(Duration::from_secs(3), cache::check_output_capacity(&app)).await {
                    Ok(()) => {},
                    Err(error) if result.is_ok() && error.is::<process::LeaseInterrupted>() => return Err(error),
                    Err(error) => {
                        if result.is_ok() || error.downcast_ref::<persistence::media_jobs::JobFailure>().is_some() {
                            result = Err(error);
                        }
                    },
                }
            }
            if execution_stopped && !*stop.borrow() && let Some(failure) = input_failure.failure()
                && result.as_ref().err().is_none_or(|error| error.downcast_ref::<persistence::media_jobs::JobFailure>().is_none()) {
                // A truncated input may make FFmpeg exit successfully. A known
                // source transport failure must not publish that partial movie.
                result = Err(failure.into());
            }
            let mut publication = None;
            if result.is_ok() && !*stop.borrow() {
                let directory = persistence::media_jobs::output_dir(&app.cache, claim.id, claim.attempt);
                result = match process::finalization_deadline(Duration::from_secs(10), async {
                    output_publish::prepare(output_builder.clone(), directory, true, &output_decoder).await
                }).await {
                    Ok(proof) => { publication = Some(proof); Ok(()) },
                    Err(error) => Err(error),
                };
            }
            if result.as_ref().is_err_and(|e| e.is::<process::LeaseInterrupted>()) {
                return result;
            }
            if *stop.borrow() && execution_stopped {
                tokio::time::timeout(Duration::from_secs(3), persistence::media_jobs::release(&app.db, &claim)).await??;
            } else if !*stop.borrow() {
                if let Some(snapshot) = publication.as_ref() {
                    tokio::time::timeout(Duration::from_secs(3), persistence::media_outputs::publish(&app.db, &claim, snapshot, true)).await??;
                } else {
                    tokio::time::timeout(Duration::from_secs(3), persistence::media_jobs::finish(&app.db, &claim, result.as_ref().err().map(|error| error.downcast_ref::<persistence::media_jobs::JobFailure>().copied().unwrap_or(persistence::media_jobs::JobFailure::ExecutionFailed)), None)).await??;
                }
            }
            Ok(())
        }.await;
        if output_decoder.stop().await.is_err() {
            tracing::error!("first segment decoder could not be reaped");
            // Keep the gate alive and retry cleanup before accepting more work.
            while output_decoder.stop().await.is_err() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        if writer_stopped && let Some((id, owner, attempt)) = reservation {
            // Completion/error/exit all release only after the child is reaped.
            // On database failure, the next budget snapshot reclaims dead jobs.
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                persistence::cache_budget::release(&app.db, id, owner, attempt),
            )
            .await;
        }
        if *stop.borrow() {
            break;
        }
        if result.is_err() {
            tracing::warn!("media queue retry");
        }
        tokio::select! {
            _ = process::stopped(&mut stop) => break,
            _ = tokio::time::sleep(Duration::from_secs(if result.is_err() { 2 } else { 1 })) => {},
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
        output_checks: Default::default(),
        input_failures: Default::default(),
        public_url: std::env::var("PUBLIC_ORIGIN").unwrap_or("http://localhost:8088".into()),
    };
    tokio::fs::create_dir_all(&app.cache).await?;
    let (stop, mut server_stop) = tokio::sync::watch::channel(false);
    let job_app = app.clone();
    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/media-delivery/{id}/{path}", get(delivery).head(delivery))
        .route("/agent-data/{id}", get(relay::connect))
        .with_state(app)
        .layer(axum::middleware::from_fn(http_api::errors));
    let listener = tokio::net::TcpListener::bind(
        std::env::var("WORKER_BIND").unwrap_or("0.0.0.0:8081".into()),
    )
    .await?;
    let cleaner = tokio::spawn(cache_outputs::run(job_app.clone(), stop.subscribe()));
    let queue = tokio::spawn(jobs(job_app, stop.subscribe()));
    let server = axum::serve(listener, router)
        .with_graceful_shutdown(async move { process::stopped(&mut server_stop).await })
        .into_future();
    tokio::pin!(server);
    let (result, signal_result) = tokio::select! {
        result = &mut server => (Some(result), Ok(media_core::process_signal::Reason::Normal)),
        signal = media_core::process_signal::wait() => (None, signal),
    };
    let _ = stop.send(true);
    let grace = signal_result
        .as_ref()
        .map_or(std::time::Duration::ZERO, |reason| reason.http_grace());
    // Keep the runtime alive until the queue has reaped its child. HTTP
    // consumers get a bounded drain; they cannot hold process exit forever.
    let (queue_result, server_result) = tokio::join!(queue, async {
        match result {
            Some(result) => result,
            None => tokio::time::timeout(grace, &mut server)
                .await
                .unwrap_or(Ok(())),
        }
    });
    // HTTP draining may stop before a cancelled probe/subtitle owner finishes.
    // Close admission and reap every registered owner before returning from main,
    // even when the queue or cleanup task failed.
    let process_result = child_process::shutdown().await;
    let cleaner_result = cleaner.await;
    process_result?;
    queue_result?;
    cleaner_result?;
    server_result?;
    signal_result?;
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
    #[test]
    fn rewrites_each_exact_uri_without_touching_quoted_text_or_similar_keys() {
        let input = "# comment URI=\"keep\"\n#EXT-X-MEDIA:NAME=\"a,URI=not-an-attribute\",X-URI=\"keep\",URI=\"音频,a.m3u8\",URI=\"b.m3u8\"\n";
        let output = rewrite_manifest(input, |v| format!("signed/{v}"));
        assert_eq!(
            output,
            "# comment URI=\"keep\"\n#EXT-X-MEDIA:NAME=\"a,URI=not-an-attribute\",X-URI=\"keep\",URI=\"signed/音频,a.m3u8\",URI=\"signed/b.m3u8\"\n"
        );
        assert_eq!(
            rewrite_manifest("#EXT-X-MAP:URI=\"unfinished", |v| v.to_owned()),
            "#EXT-X-MAP:URI=\"unfinished\n"
        );
        assert_eq!(
            rewrite_manifest("#EXTINF:4,URI=\"title\"", |_| "changed".into()),
            "#EXTINF:4,URI=\"title\"\n"
        );
    }
    #[test]
    fn source_urls_follow_wildcard_loopback_and_concrete_bind_addresses() {
        for (bind, expected) in [
            ("0.0.0.0:8081", "127.0.0.1:8081"),
            ("127.0.0.2:8082", "127.0.0.2:8082"),
            ("192.0.2.10:8081", "192.0.2.10:8081"),
            ("[::]:8081", "[::1]:8081"),
            ("[2001:db8::1]:8082", "[2001:db8::1]:8082"),
        ] {
            assert_eq!(
                source_url_for_bind(bind.parse().unwrap(), Uuid::nil(), "test"),
                format!(
                    "http://{expected}/media-delivery/{}/source?token=test",
                    Uuid::nil()
                )
            );
        }
    }
}
