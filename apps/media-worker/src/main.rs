mod advanced_media;
mod advanced_remote;
mod cache;
mod cache_outputs;
mod cache_read;
mod execution_failure;
mod file_delivery;
mod local_hls_ladder;
mod local_hls_ladder_read;
mod native_platform_ladder;
mod native_platform_transcode;
mod remote_assets;
#[path = "../../server/src/source_key_check.rs"]
mod source_key_check;
use media_core::child_process;
use media_core::runtime_metrics::{Cache, CacheDecision, Layer};
mod http_identity;
mod http_media;
mod input_failure;
mod metric_stream;
mod metrics;
mod output_decode;
mod output_entry_metrics;
mod output_publish;
mod output_read;
mod outputs;
mod owned_http;
mod playback_access;
mod preview_input;
mod previews;
mod process;
mod readiness;
mod relay;
mod source_version;
mod static_hls_child_delivery;
mod static_hls_child_dispatch;
mod static_hls_child_encoder;
mod static_hls_child_gate;
#[cfg(all(test, target_os = "linux"))]
#[path = "../../server/src/static_hls_child_plan.rs"]
mod static_hls_child_plan;
mod static_hls_child_read;
mod static_hls_child_registry;
mod static_hls_contract;
#[cfg(all(test, target_os = "linux"))]
#[path = "../../server/src/static_hls_input_cipher.rs"]
mod static_hls_input_cipher;
mod static_hls_operation;
#[path = "../../server/src/static_hls_operation_cipher.rs"]
mod static_hls_operation_cipher;
#[cfg(all(test, target_os = "linux"))]
#[path = "../../server/src/static_hls_operation_client.rs"]
mod static_hls_operation_client;
#[cfg(all(test, target_os = "linux"))]
#[path = "../../server/src/static_hls_parent_plan.rs"]
mod static_hls_parent_plan;
mod static_hls_read;
mod transfer_state;
mod upstream_output;
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
use uuid::Uuid;

#[derive(Clone)]
struct App {
    readiness: readiness::Runtime,
    metrics: media_core::runtime_metrics::RuntimeMetrics,
    db: PgPool,
    key: Arc<Aes256Gcm>,
    cache: PathBuf,
    client: reqwest::Client,
    relay: relay::Registry,
    public_url: String,
    probes: Arc<tokio::sync::Semaphore>,
    output_checks: Arc<output_read::Checks>,
    input_failures: input_failure::Registry,
    preview_inputs: preview_input::Registry,
    deliveries: playback_access::Registry,
    static_hls_operations: static_hls_operation::Registry,
    static_hls_children: static_hls_child_registry::Registry,
    static_hls_child_dispatch: static_hls_child_dispatch::Registry,
    static_hls_child_encoders: static_hls_child_encoder::Registry,
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
    let pool = app.db.clone();
    let deliveries = app.deliveries.clone();
    let token_hash = hash(&q.token);
    let input_cancel = app.input_failures.observe(id, q.execution);
    let measure =
        method == axum::http::Method::GET && !matches!(path.as_str(), "probe" | "upstream-output");
    let metrics = app.metrics.clone();
    let entry_candidate =
        method == axum::http::Method::GET && path == "index.m3u8" && q.url.is_none();
    let observe_pool = pool.clone();
    let response = playback_access::protect(
        move |first_entry| delivery_response(app, id, path, q, h, method, first_entry),
        pool,
        id,
        token_hash,
        deliveries,
        input_cancel,
        entry_candidate,
    )
    .await?;
    if response.status().is_success()
        && let Some(observation) = response
            .extensions()
            .get::<output_entry_metrics::Ready>()
            .copied()
    {
        // Classification may be lost, but never delays delivery or changes its
        // result. The compulsory receipt prevents later reclassification.
        output_entry_metrics::record_ready(observe_pool, id, observation);
    }
    if !measure || !response.status().is_success() || response.status() == StatusCode::NO_CONTENT {
        return Ok(response);
    }
    let cache = response
        .extensions()
        .get::<Cache>()
        .copied()
        .unwrap_or(Cache::NotHit);
    let body_length = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let (parts, body) = response.into_parts();
    Ok(Response::from_parts(
        parts,
        Body::from_stream(
            metric_stream::wrap(
                body.into_data_stream(),
                &metrics,
                Layer::WorkerEgress,
                cache,
            )
            .with_body_length(body_length),
        ),
    ))
}
fn with_cache(mut response: Response, cache: Cache) -> Response {
    response.extensions_mut().insert(cache);
    response
}

async fn delivery_response(
    app: App,
    id: Uuid,
    path: String,
    q: Params,
    h: HeaderMap,
    method: axum::http::Method,
    first_entry: bool,
) -> Result<Response> {
    let row=sqlx::query("SELECT p.resource FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id JOIN rooms r ON r.id=p.room_id WHERE r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND p.id=$1 AND p.delivery_token_hash=$2 AND p.expires_at>now() AND NOT p.stopped AND playback_source_allowed(p.media_id,p.resource,p.id) AND (s.state->>'media_generation')::bigint=p.generation AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id)").bind(id).bind(hash(&q.token)).fetch_optional(&app.db).await.map_err(failure)?.ok_or((StatusCode::UNAUTHORIZED,"invalid_playback_session".into()))?;
    let data: Value = row.get("resource");
    if data.get("native_platform_context").is_some() {
        return Err((StatusCode::UNAUTHORIZED, "unsupported_delivery_kind".into()));
    }
    let resource = decrypt(&app, data["encrypted"].as_str().unwrap_or("")).map_err(failure)?;
    // Platform grants have their own authenticated Server gateway. Never let
    // an unknown resource kind reach probe/subtitle/job or generic HTTP code.
    if data.get("native_platform_context").is_some()
        || !matches!(
            resource["kind"].as_str(),
            Some("local" | "agent" | "http" | "jellyfin" | "emby")
        )
    {
        return Err((StatusCode::UNAUTHORIZED, "unsupported_delivery_kind".into()));
    }
    // Ladder grants have a closed route and validation5 proof. Never expose
    // their private per-rung files through the generic single-output adapter.
    if data.get("local_hls_ladder_version").is_some()
        || resource.get("local_hls_ladder_version").is_some()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "dedicated_ladder_endpoint_required".into(),
        ));
    }
    let head = method == axum::http::Method::HEAD;
    let input_failure = app.input_failures.observe(id, q.execution);
    if path == "upstream-output" {
        return upstream_output::response(&app, id, &resource, &q, head).await;
    }
    if path == "probe" {
        let _permit = app
            .probes
            .try_acquire()
            .map_err(|_| (StatusCode::TOO_MANY_REQUESTS, "probe_busy".into()))?;
        let observed = app.input_failures.register(id);
        let source = format!(
            "{}&execution={}",
            source_url(id, &q.token).map_err(failure)?,
            observed.token()
        );
        let metadata = if resource["http_owned_large_response_version"] == 1
            || resource["http_finite_hls_version"] == 1
        {
            owned_http::probe_owned(
                &app,
                id,
                &resource,
                app.input_failures.observe(id, Some(observed.token())),
            )
            .await
        } else {
            advanced_media::probe_advertised(&source, &resource).await
        };
        if let Some((status, reason)) = match observed.failure() {
            Some(persistence::media_jobs::JobFailure::SourceChanged) => {
                Some((StatusCode::CONFLICT, "source_changed"))
            }
            Some(persistence::media_jobs::JobFailure::SourceVersionRequired) => {
                Some((StatusCode::CONFLICT, "source_version_required"))
            }
            Some(persistence::media_jobs::JobFailure::SourceSeekUnsupported) => {
                Some((StatusCode::UNPROCESSABLE_ENTITY, "source_seek_unsupported"))
            }
            Some(persistence::media_jobs::JobFailure::InputDenied) => {
                Some((StatusCode::BAD_GATEWAY, "media_input_denied"))
            }
            _ => None,
        } {
            return Err((status, reason.into()));
        }
        let mut metadata = metadata.map_err(failure)?;
        remote_assets::discover(
            &app,
            id,
            &resource,
            &q,
            app.input_failures.observe(id, Some(observed.token())),
            &mut metadata,
        )
        .await
        .map_err(failure)?;
        return Ok(axum::Json(metadata).into_response());
    }
    if path.starts_with("asset-") {
        return remote_assets::response(&app, id, &resource, &q, &h, head, input_failure, &path)
            .await;
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
            let config = providers::resource_config(&resource).map_err(failure)?;
            let request = providers::source_media_request(
                &config,
                url.as_str(),
                reqwest::Method::GET,
                &config.headers,
            )
            .await
            .map_err(failure)?;
            let response = request
                .send()
                .await
                .map_err(failure)?
                .error_for_status()
                .map_err(failure)?;
            use futures_util::StreamExt;
            let mut stream = metric_stream::wrap(
                response.bytes_stream(),
                &app.metrics,
                Layer::UpstreamRead,
                Cache::NotHit,
            );
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
            let input = input.clone();
            let size = child_process::blocking(move || std::fs::metadata(input))
                .await
                .map_err(failure)?
                .map_err(failure)?
                .len();
            if size > media_core::subtitles::MAX_BYTES as u64 {
                return Err(failure("subtitle_too_large"));
            }
        }
        let mut command = tokio::process::Command::new("ffmpeg");
        media_core::input_policy::clean_environment(&mut command);
        command.args(media_core::input_policy::args(
            input.starts_with("http://"),
            resource["kind"] == "http",
        ));
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
        let mut cache_hit = true;
        let mut entry =
            output_entry_metrics::Entry::new(first_entry && !head && path == "index.m3u8");
        for _ in 0..30 {
            let job =
                sqlx::query("SELECT j.status,j.error,j.attempt,j.metrics_queue_ms,j.metrics_queue_complete,j.metrics_queue_accounted_attempt,o.status AS output_status,o.manifest_sha256,o.validation_version,o.visible_manifest,(j.status='succeeded' OR (j.status='running' AND j.lease_until>clock_timestamp())) AS readable FROM media_jobs j LEFT JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt WHERE j.id=$1")
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
            if entry.lookup(&status, attempt) {
                output_entry_metrics::record_cold(app.db.clone(), id);
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
            if status != "succeeded" && cache_hit {
                app.metrics.cache_lookup(CacheDecision::Miss);
                cache_hit = false;
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
                    _ => {
                        if cache_hit {
                            app.metrics.cache_lookup(CacheDecision::Miss);
                        }
                        return Err((StatusCode::BAD_GATEWAY, "media_job_failed".into()));
                    }
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
                    entry.ready(
                        attempt,
                        job.get::<Option<i64>, _>("metrics_queue_ms"),
                        job.get::<Option<bool>, _>("metrics_queue_complete"),
                        job.get::<Option<i64>, _>("metrics_queue_accounted_attempt"),
                    ),
                ));
                break;
            }
            if status == "succeeded" {
                if cache_hit {
                    app.metrics.cache_lookup(CacheDecision::Miss);
                }
                return Err((StatusCode::BAD_GATEWAY, "media_job_failed".into()));
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        let (file, attempt, complete, manifest_digest, manifest, reader, opened, entry_ready) =
            output.ok_or((StatusCode::SERVICE_UNAVAILABLE, "media_unavailable".into()))?;
        if !reader.healthy() {
            return Err((StatusCode::SERVICE_UNAVAILABLE, "media_unavailable".into()));
        }
        let cache = if cache_hit { Cache::Hit } else { Cache::NotHit };
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
            if cache_hit {
                app.metrics.cache_lookup(CacheDecision::Hit);
            }
            let mut response = with_cache(
                (
                    [
                        (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                        (header::CACHE_CONTROL, "no-store"),
                    ],
                    if head { String::new() } else { text },
                )
                    .into_response(),
                cache,
            );
            if let Some(ready) = entry_ready {
                response.extensions_mut().insert(ready);
            }
            return Ok(response);
        }
        let response = file_delivery::response(&file, &h, head, Some(reader), opened, None).await?;
        if cache_hit {
            app.metrics.cache_lookup(CacheDecision::Hit);
        }
        return Ok(with_cache(response, cache));
    }
    if resource["kind"] == "agent" {
        return relay::fetch(&app, &resource, &h, head, input_failure, Some(id)).await;
    }
    if resource["kind"] == "local" {
        let p = media_core::safe_path(
            std::path::Path::new(resource["root"].as_str().unwrap_or("")),
            resource["resource"].as_str().unwrap_or(""),
        )
        .map_err(failure)?;
        return file_delivery::response(
            &p,
            &h,
            head,
            None,
            None,
            resource["source_version"].as_str().map(str::to_owned),
        )
        .await;
    }
    http_media::response(&app, id, &resource, &q, &h, head, input_failure).await
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
    let _claim_loop = app.readiness.claim_loop_guard();
    let worker = Uuid::new_v4();
    loop {
        let mut reservation = None;
        let mut writer_stopped = true;
        let output_decoder = output_decode::Gate::default();
        let execution_scope = child_process::Scope::new();
        let result: anyhow::Result<()> = execution_scope.run(async {
            let claim = tokio::select! {
                biased;
                _ = process::stopped(&mut stop) => return Ok(()),
                claim = tokio::time::timeout(Duration::from_secs(3), persistence::media_jobs::claim_platform_capable(&app.db, worker)) => {
                    match &claim { Ok(Ok(value)) => app.readiness.claim_succeeded(value.is_some()), _ => app.readiness.claim_failed() }
                    claim??
                },
            };
            let Some(claim) = claim else { return Ok(()) };
            reservation = Some((claim.id, claim.owner, claim.attempt));
            if claim.spec["kind"] == persistence::local_hls_ladder::KIND
                || claim.spec["kind"] == persistence::local_hls_ladder::ADVANCED_KIND
                || claim.spec["kind"] == persistence::local_hls_ladder::OWNED_ADVANCED_KIND
                || claim.spec["kind"] == persistence::native_platform_ladder::KIND {
                let result=if claim.spec["kind"] == persistence::native_platform_ladder::KIND {
                    native_platform_ladder::run(&app,&claim,&mut stop,&mut writer_stopped).await
                } else {
                    local_hls_ladder::run(&app,&claim,&mut stop,&mut writer_stopped).await
                };
                if result.as_ref().is_err_and(|error|error.is::<process::LeaseInterrupted>()) {return result;}
                if *stop.borrow() && writer_stopped {
                    tokio::time::timeout(Duration::from_secs(3),persistence::media_jobs::release(&app.db,&claim)).await??;
                } else if let Err(error)=result {
                    tokio::time::timeout(Duration::from_secs(3),persistence::media_jobs::finish(&app.db,&claim,Some(error.downcast_ref::<persistence::media_jobs::JobFailure>().copied().unwrap_or(persistence::media_jobs::JobFailure::ExecutionFailed)),None)).await??;
                }
                return Ok(());
            }
            let output_builder: output_publish::Shared = Default::default();
            let input_failure = app.input_failures.register(claim.id);
            // Advanced preparation can own bounded metadata children in this
            // scope. Cancellation is drained before the execution receipt;
            // encoder supervision must finish explicit kill/wait before release.
            let prepare = async {
                let native=claim.spec["kind"]==persistence::native_platform_transcode::KIND;
                if native {persistence::native_platform_transcode::validate_spec(&claim.spec)?;}
                else if claim.spec["kind"]==persistence::owned_http::KIND {persistence::owned_http::validate_spec(&claim.spec)?;}
                else if !advanced_media::admit_claim(&claim.spec)? {
                    static_hls_child_gate::reject_unsupported_claim(&claim)?;
                }
                cache::ensure_capacity(&app).await?;
                cache::reserve_output(&app, &claim).await?;
                let spec = &claim.spec;
                source_version::verify(spec).await?;
                let input = if native {let spec=persistence::native_platform_transcode::validate_spec(spec)?;native_platform_transcode::source_url(&claim,&spec.tracks[0].key,input_failure.token())?} else if let Some(ticket) = spec["input_ticket"].as_str() {
                    let ticket = decrypt(&app, ticket)?;
                    let token = ticket["token"].as_str().ok_or_else(|| anyhow::anyhow!("invalid_input_ticket"))?;
                    format!("{}&execution={}", source_url(claim.id, token)?, input_failure.token())
                } else {
                    let path = media_core::safe_path(std::path::Path::new(spec["root"].as_str().unwrap_or("")), spec["resource"].as_str().unwrap_or(""))?;
                    path.to_str().ok_or_else(|| anyhow::anyhow!("path"))?.to_owned()
                };
                let dir = persistence::media_jobs::output_dir(&app.cache, claim.id, claim.attempt);
                child_process::blocking({ let dir=dir.clone(); move || std::fs::create_dir_all(dir) }).await?.map_err(cache::write_error)?;
                let audio_index = spec["audio_index"].as_u64().map(u32::try_from).transpose()?;
                let advanced = if native {Some(native_platform_transcode::prepare(&app,&claim,&dir.join("index.m3u8"),input_failure.token()).await?)} else {advanced_media::prepare_scoped(&app, &claim, &input, &dir.join("index.m3u8"), audio_index).await?};
                let mut args = if let Some(advanced) = &advanced {
                    advanced.args.clone()
                } else if let Some(mode)=spec["negotiated_mode"].as_str() {
                    media_core::capabilities::negotiated_hls_args(&input,dir.join("index.m3u8").to_str().unwrap(),spec["start_seconds"].as_f64().unwrap_or(0.0),mode,audio_index)
                } else {media_core::hls_args(&input, dir.join("index.m3u8").to_str().unwrap(), spec["start_seconds"].as_f64().unwrap_or(0.0), spec["transcode"].as_bool().unwrap_or(true), audio_index)};
                if advanced.is_none() {
                    owned_http::constrain_finite_job(&app,&claim,&mut args).await?;
                    media_core::input_policy::constrain(&mut args, input.starts_with("http://"), spec["source_kind"] == "http");
                }
                let decoder_input = args.iter().position(|argument| argument == "-i")
                    .and_then(|at| args.get(at + 1)).cloned().ok_or_else(|| anyhow::anyhow!("decoder_input_missing"))?;
                let confirmation = app.readiness.check_lease(process::finalization_deadline(Duration::from_secs(3), process::confirmed_deadline(persistence::media_jobs::renew_remaining(&app.db, &claim)))).await;
                let confirmed_until = confirmation?
                    .filter(|until| *until > tokio::time::Instant::now())
                    .ok_or_else(|| anyhow::anyhow!("lease_lost_before_spawn"))?;
                Ok::<_, anyhow::Error>((args, confirmed_until, decoder_input, advanced))
            };
            let prepared = tokio::select! {
                biased;
                _ = process::stopped(&mut stop) => Err(anyhow::anyhow!("worker_shutdown")),
                result = prepare => result,
            };
            let mut execution_stopped = true;
            let mut diagnostic_failure = None;
            let mut result = async {
                let (args, confirmed_until, input, advanced) = prepared?;
                anyhow::ensure!(!*stop.borrow(), "worker_shutdown");
                let mut command = tokio::process::Command::new("ffmpeg");
        media_core::input_policy::clean_environment(&mut command);
                if claim.spec["kind"]==persistence::native_platform_transcode::KIND {native_platform_transcode::clean_native_environment(&mut command);}
                command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
                if let Some(advanced) = &advanced {
                    advanced.install(&mut command)?;
                    output_decoder.configure_advanced(advanced.recipe.clone()).await?;
                }
                #[cfg(windows)]
                command.creation_flags(0x08000000);
                anyhow::ensure!(confirmed_until > tokio::time::Instant::now(), "lease_lost_before_spawn");
                let mut child = child_process::spawn(command)?;
                let diagnostics = child.stderr.take().expect("piped encoder diagnostics");
                writer_stopped = false;
                execution_stopped = false;
                let supervised = process::supervise(&mut child, &mut stop, confirmed_until, || async {
                    app.readiness.check_lease(process::confirmed_deadline(persistence::media_jobs::renew_remaining(&app.db, &claim))).await
                }, async {
                    tokio::select! {
                        error = advanced_media::monitor_scope(&app, &claim, advanced.as_ref()) => error,
                        error = cache::monitor(&app) => error,
                        error = output_publish::monitor(&app.db, &claim, persistence::media_jobs::output_dir(&app.cache, claim.id, claim.attempt), output_builder.clone(), &output_decoder) => error,
                    }
                });
                let (result, evidence) = execution_failure::observe_with_input(supervised, diagnostics, &input).await;
                diagnostic_failure = evidence;
                execution_stopped = child.try_wait()?.is_some();
                writer_stopped = execution_stopped;
                if result.as_ref().is_err_and(|error| error.is::<process::EncodingFailed>())
                    && advanced.as_ref().is_some_and(|prepared| prepared.backend() != media_core::advanced_media::Backend::Software) {
                    tracing::warn!(backend=?advanced.as_ref().unwrap().backend(), "hardware encoder failed; attempt remains fenced and is not rewritten with software");
                }
                if result.is_ok() && let Some(prepared) = &advanced {
                    prepared.verify()?;
                    process::finalization_deadline(Duration::from_secs(10), prepared.verify_remote()).await?;
                }
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
            if execution_stopped && !*stop.borrow()
                && result.as_ref().is_err_and(|error| error.is::<process::EncodingFailed>())
                && let Some(evidence) = diagnostic_failure {
                // Stderr can refine a known encoder exit only. Independent
                // input, source, capacity, cancellation and ownership evidence
                // always keeps precedence; no retry is inferred from text.
                use persistence::media_jobs::JobFailure;
                result = Err(match evidence {
                    execution_failure::Kind::InputInvalid => JobFailure::InputInvalid,
                    execution_failure::Kind::DecoderUnavailable => JobFailure::DecoderUnavailable,
                    execution_failure::Kind::EncoderUnavailable => JobFailure::EncoderUnavailable,
                }.into());
            }
            let mut publication = None;
            if result.is_ok() && !*stop.borrow() {
                let directory = persistence::media_jobs::output_dir(&app.cache, claim.id, claim.attempt);
                result = match process::finalization_deadline(Duration::from_secs(10), async {
                    let proof=output_publish::prepare(output_builder.clone(), directory, true, &output_decoder).await?;
                    source_version::verify(&claim.spec).await?;
                    advanced_media::verify_scope(&app, &claim).await?;
                    if claim.spec["kind"]==persistence::native_platform_transcode::KIND {native_platform_transcode::validate_completed(&claim.spec,&proof)?;}
                    Ok(proof)
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
        }).await;
        if reservation.is_some() {
            app.readiness.receipt_pending(true);
        }
        if output_decoder.stop().await.is_err() {
            app.readiness.drain_failed();
            tracing::error!("first segment decoder could not be reaped");
            // Keep the gate alive and retry cleanup before accepting more work.
            while output_decoder.stop().await.is_err() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        if execution_scope.shutdown().await.is_err() {
            app.readiness.drain_failed();
            writer_stopped = false;
            tracing::error!("media execution resource drain unconfirmed");
        }
        if writer_stopped && let Some((id, owner, attempt)) = reservation {
            // Both encoder and decoder have positive OS-tree reaping evidence.
            // Persist the receipt independently of job cancellation/lease state.
            // Retain ownership through transient DB failures (also on shutdown).
            loop {
                if matches!(
                    tokio::time::timeout(
                        Duration::from_secs(3),
                        persistence::media_executions::acknowledge_job(&app.db, id, attempt, owner)
                    )
                    .await,
                    Ok(Ok(()))
                ) {
                    break;
                }
                tracing::warn!("media execution drain acknowledgement retry");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            // Completion/error/exit all release only after the child is reaped.
            // On database failure, the next budget snapshot uses this receipt.
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                persistence::cache_budget::release(&app.db, id, owner, attempt),
            )
            .await;
        }
        if writer_stopped {
            app.readiness.receipt_pending(false);
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

fn main() -> anyhow::Result<()> {
    // Probe before the Tokio runtime, tracing, configuration or secret loading.
    if std::env::args().nth(1).as_deref() == Some("--source-access-contract") {
        anyhow::ensure!(
            std::env::args().len() == 2,
            "invalid capability probe arguments"
        );
        println!("{}", providers::source_access_contract::WORKER);
        return Ok(());
    }
    run()
}

#[tokio::main]
async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let deployment = media_core::deployment_config::Settings::from_env(
        media_core::deployment_config::Role::Worker,
    )?;
    advanced_media::preference_from_env()?;
    let key = STANDARD.decode(std::env::var("SOURCE_ENCRYPTION_KEY")?)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| anyhow::anyhow!("SOURCE_ENCRYPTION_KEY must decode to 32 bytes"))?;
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    source_key_check::verify(&db, &cipher).await?;
    let runtime_readiness = readiness::Runtime::default();
    let mut app = App {
        readiness: runtime_readiness.clone(),
        metrics: Default::default(),
        db,
        key: Arc::new(cipher),
        cache: deployment.cache_root,
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(30))
            .build()?,
        relay: Default::default(),
        probes: Arc::new(tokio::sync::Semaphore::new(2)),
        output_checks: Default::default(),
        input_failures: Default::default(),
        preview_inputs: Default::default(),
        deliveries: playback_access::Registry::with_readiness(runtime_readiness.clone()),
        static_hls_operations: Default::default(),
        static_hls_children: Default::default(),
        static_hls_child_dispatch: Default::default(),
        static_hls_child_encoders: Default::default(),
        public_url: deployment.agent_data_origin,
    };
    tokio::fs::create_dir_all(&app.cache).await?;
    // Opt-in installs the real bounded pipeline. This switch is not a media
    // qualification receipt; every request still needs original owners and
    // complete runtime proofs. Default deployment behavior remains unchanged.
    let child_requested = match std::env::var("STATIC_HLS_CHILD_EXECUTION_ENABLED") {
        Err(std::env::VarError::NotPresent) => false,
        Ok(value) if value == "0" => false,
        Ok(value) if value == "1" => true,
        _ => anyhow::bail!("invalid STATIC_HLS_CHILD_EXECUTION_ENABLED"),
    };
    if child_requested {
        let queue_limit: i64 = match std::env::var("MEDIA_QUEUE_LIMIT") {
            Err(std::env::VarError::NotPresent) => 20,
            Ok(value) => value.parse()?,
            Err(error) => return Err(error.into()),
        };
        let runtime =
            static_hls_child_encoder::InstalledRuntime::install(&app, queue_limit).await?;
        app.static_hls_child_dispatch = static_hls_child_dispatch::Registry::installed(runtime)?;
    }

    let (stop, mut server_stop) = tokio::sync::watch::channel(false);
    let job_app = app.clone();
    let readiness_db = app.db.clone();
    let readiness_cache = app.cache.clone();
    let deliveries = app.deliveries.clone();
    let static_hls_operations = app.static_hls_operations.clone();
    let static_hls_children = app.static_hls_children.clone();
    let static_hls_child_dispatch = app.static_hls_child_dispatch.clone();
    let static_hls_child_encoders = app.static_hls_child_encoders.clone();
    let child_cleanup_app = app.clone();
    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route(
            "/media-delivery/health",
            get(|| async {
                (
                    [(header::CACHE_CONTROL, "no-store")],
                    axum::Json(json!({"service":"rainsync-worker","live":true})),
                )
            }),
        )
        .route(
            "/agent-data/health",
            get(|| async {
                (
                    [(header::CACHE_CONTROL, "no-store")],
                    axum::Json(json!({"service":"rainsync-worker","live":true})),
                )
            }),
        )
        .route("/metrics", get(metrics::endpoint))
        .route(
            "/media-delivery/static-hls-contract",
            axum::routing::post(static_hls_contract::endpoint)
                .layer(axum::extract::DefaultBodyLimit::max(4096)),
        )
        .route(
            "/media-delivery/static-hls-operation",
            axum::routing::post(static_hls_operation::endpoint)
                .layer(axum::extract::DefaultBodyLimit::max(4096)),
        )
        .route("/media-delivery/{id}/{path}", get(delivery).head(delivery))
        .route(
            "/media-delivery/{id}/ladder/{*path}",
            get(local_hls_ladder_read::endpoint).head(local_hls_ladder_read::endpoint),
        )
        .route(
            "/media-delivery/{id}/static-hls/{token}/{path}",
            get(static_hls_read::endpoint).head(static_hls_read::endpoint),
        )
        .route(
            "/media-delivery/{id}/static-hls-child/{token}/{path}",
            get(static_hls_child_read::endpoint).head(static_hls_child_read::endpoint),
        )
        .route(
            "/native-platform-input/{id}/{key}",
            get(native_platform_transcode::input).head(native_platform_transcode::input),
        )
        .route(
            "/native-platform-output/{id}/{*path}",
            get(native_platform_transcode::output).head(native_platform_transcode::output),
        )
        .route("/agent-data/{id}", get(relay::connect))
        .route(
            "/preview-input/{id}/{key}",
            get(preview_input::read).head(preview_input::read),
        )
        .layer(axum::middleware::from_fn(http_api::errors))
        .route(
            "/ready",
            get(|State(app): State<App>| async move { app.readiness.response() }),
        )
        .route(
            "/media-delivery/ready",
            get(|State(app): State<App>| async move { app.readiness.response() }),
        )
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(
        std::env::var("WORKER_BIND").unwrap_or("0.0.0.0:8081".into()),
    )
    .await?;
    let preview_settings = persistence::media_previews::Settings::configured()?;
    let readiness_monitor =
        readiness::start(runtime_readiness.clone(), readiness_db, readiness_cache);
    runtime_readiness.accepting(true);
    static_hls_operations.open();
    static_hls_children.open();
    static_hls_child_dispatch.open();
    let cleaner_app = job_app.clone();
    let cleaner_readiness = runtime_readiness.clone();
    let cleaner_stop = stop.subscribe();
    let cleaner = tokio::spawn(async move {
        let _lifetime =
            cleaner_readiness.background_task_guard(readiness::BackgroundTask::CacheCleaner);
        cache_outputs::run(cleaner_app, cleaner_stop).await
    });
    let preview_app = job_app.clone();
    let preview_readiness = runtime_readiness.clone();
    let preview_stop = stop.subscribe();
    let preview_queue = tokio::spawn(async move {
        let _lifetime =
            preview_readiness.background_task_guard(readiness::BackgroundTask::PreviewQueue);
        previews::run(preview_app, preview_settings, preview_stop).await
    });
    let queue = tokio::spawn(jobs(job_app, stop.subscribe()));
    let server = axum::serve(listener, router)
        .with_graceful_shutdown(async move { process::stopped(&mut server_stop).await })
        .into_future();
    tokio::pin!(server);
    let (result, signal_result) = tokio::select! {
        result = &mut server => (Some(result), Ok(media_core::process_signal::Reason::Normal)),
        signal = media_core::process_signal::wait() => (None, signal),
    };
    // Fence even handlers already accepted by Axum, then cancel paused sources
    // independently of the HTTP drain and retain their receipt owners.
    runtime_readiness.accepting(false);
    static_hls_child_dispatch.close().await;
    static_hls_child_encoders.close();
    static_hls_children.close().await;
    static_hls_operations.close().await;
    readiness_monitor.stop();
    native_platform_transcode::close_admission();
    owned_http::close();
    deliveries.close();
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
    // Includes late INSERT/COMMIT admission and receipt retries. An unavailable
    // DB or uninterruptible file read cannot be converted to a positive ACK.
    deliveries.drain().await;
    owned_http::shutdown().await;
    let native_transcode_result = native_platform_transcode::drain().await;
    static_hls_operations.drain().await;
    static_hls_child_dispatch.drain().await;
    let child_encoder_obligations = static_hls_child_encoders.drain().await;
    if child_encoder_obligations
        .iter()
        .any(|owner| owner.claim_unknown || owner.output_unknown || owner.reservation_retained)
    {
        tracing::warn!(
            owners = child_encoder_obligations.len(),
            "child encoder shutdown retains unresolved accounting obligations"
        );
    }
    static_hls_children
        .drain_until_confirmed(&child_cleanup_app)
        .await;
    // HTTP draining may stop before a cancelled probe/subtitle owner finishes.
    // Close admission and reap every registered owner before returning from main,
    // even when the queue or cleanup task failed.
    let readiness_result = readiness_monitor.shutdown().await;
    let process_result = child_process::shutdown().await;
    let cleaner_result = cleaner.await;
    let preview_result = preview_queue.await;
    readiness_result?;
    native_transcode_result?;
    process_result?;
    queue_result?;
    cleaner_result?;
    preview_result?;
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
