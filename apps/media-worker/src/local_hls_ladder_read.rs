//! Same-origin, token-fenced closed ladder delivery. No raw muxer playlist reads.
use super::*;
use media_core::hls_ladder::{Resource, parse_master};
use std::time::Duration;

struct DeliveryRequest {
    params: Params,
    headers: HeaderMap,
    method: axum::http::Method,
}

pub async fn endpoint(
    State(app): State<App>,
    Path((id, path)): Path<(Uuid, String)>,
    Query(q): Query<Params>,
    headers: HeaderMap,
    method: axum::http::Method,
) -> Result<Response> {
    if q.token.len() != 64
        || !q
            .token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err((StatusCode::UNAUTHORIZED, "invalid_playback_session".into()));
    }
    let resource =
        Resource::parse(&path).map_err(|_| (StatusCode::BAD_REQUEST, "invalid_resource".into()))?;
    if q.url.is_some() || q.execution.is_some() {
        return Err((StatusCode::BAD_REQUEST, "invalid_resource".into()));
    }
    let login = browser_login_hash(&headers)?;
    let boundary = playback_access::LadderBoundary::new(login, q.attempt)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "invalid_playback_session".into()))?;
    let pin = boundary.clone();
    let token = hash(&q.token);
    let entry = method == axum::http::Method::GET && resource == Resource::Master;
    let db = app.db.clone();
    let deliveries = app.deliveries.clone();
    let input = app.input_failures.observe(id, None);
    let metrics = app.metrics.clone();
    let observe_db = db.clone();
    let head = method == axum::http::Method::HEAD;
    let response = playback_access::protect_local_hls_ladder(
        move |first| {
            response(
                app,
                id,
                resource,
                DeliveryRequest {
                    params: q,
                    headers,
                    method,
                },
                first,
                pin,
            )
        },
        db,
        id,
        token,
        deliveries,
        input,
        entry,
        boundary,
    )
    .await?;
    if response.status().is_success()
        && let Some(ready) = response
            .extensions()
            .get::<output_entry_metrics::Ready>()
            .copied()
    {
        output_entry_metrics::record_ready(observe_db, id, ready);
    }
    if head || !response.status().is_success() {
        return Ok(response);
    }
    let cache = response
        .extensions()
        .get::<Cache>()
        .copied()
        .unwrap_or(Cache::NotHit);
    let length = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let (parts, body) = response.into_parts();
    Ok(Response::from_parts(
        parts,
        Body::from_stream(
            metric_stream::wrap(
                body.into_data_stream(),
                &metrics,
                media_core::runtime_metrics::Layer::WorkerEgress,
                cache,
            )
            .with_body_length(length),
        ),
    ))
}
/// Require exactly one original browser session cookie. A delivery token is
/// never login authority, and another current login cannot adopt the grant.
fn browser_login_hash(headers: &HeaderMap) -> Result<String> {
    let mut cookies = Vec::new();
    for header in headers.get_all(header::COOKIE) {
        let text = header
            .to_str()
            .map_err(|_| (StatusCode::UNAUTHORIZED, "login_required".into()))?;
        for cookie in text.split(';') {
            if let Some(token) = cookie.trim().strip_prefix("rainsync_session=") {
                cookies.push(token);
            }
        }
    }
    if cookies.len() != 1
        || cookies[0].len() != 64
        || !cookies[0]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err((StatusCode::UNAUTHORIZED, "login_required".into()));
    }
    Ok(hash(cookies[0]))
}

async fn response(
    app: App,
    id: Uuid,
    resource: Resource,
    request: DeliveryRequest,
    first_entry: bool,
    boundary: playback_access::LadderBoundary,
) -> Result<Response> {
    let DeliveryRequest {
        params: q,
        headers,
        method,
    } = request;
    let row=sqlx::query("SELECT p.resource,p.auth_login_hash FROM playback_sessions p WHERE p.id=$1 AND p.delivery_token_hash=$2 AND p.resource->'local_hls_ladder_version'='1'::jsonb AND local_hls_ladder_session_allowed(p.id) AND playback_source_allowed(p.media_id,p.resource,p.id)")
        .bind(id).bind(hash(&q.token)).fetch_optional(&app.db).await.map_err(failure)?.ok_or((StatusCode::UNAUTHORIZED,"invalid_playback_session".into()))?;
    boundary
        .require_original_login(
            row.get::<Option<String>, _>("auth_login_hash")
                .as_deref()
                .unwrap_or(""),
        )
        .map_err(|_| (StatusCode::UNAUTHORIZED, "invalid_playback_session".into()))?;
    let stored: Value = row.get("resource");
    let encrypted = decrypt(&app, stored["encrypted"].as_str().unwrap_or("")).map_err(failure)?;
    if encrypted["kind"] != "local"
        || encrypted["local_hls_ladder_version"] != 1
        || encrypted["job_id"]
            .as_str()
            .and_then(|v| Uuid::parse_str(v).ok())
            != Some(id)
    {
        return Err((StatusCode::UNAUTHORIZED, "invalid_playback_session".into()));
    }
    source_version::verify(&encrypted)
        .await
        .map_err(|_| (StatusCode::CONFLICT, "source_changed".into()))?;
    if resource != Resource::Master && q.attempt.is_none() {
        return Err((StatusCode::CONFLICT, "stale_media".into()));
    }
    let head = method == axum::http::Method::HEAD;
    let mut snapshot = None;
    let mut entry =
        output_entry_metrics::Entry::new(first_entry && !head && resource == Resource::Master);
    let mut queue = (None, None, None);
    for _ in 0..30 {
        let row=sqlx::query("SELECT status,error,attempt,metrics_queue_ms,metrics_queue_complete,metrics_queue_accounted_attempt FROM media_jobs WHERE id=$1 AND logical_queue IN ('local_hls_ladder_v1','advanced_hls_ladder_v1','advanced_owned_hls_ladder_v1')").bind(id).fetch_optional(&app.db).await.map_err(failure)?.ok_or_else(||failure("missing_job"))?;
        if entry.lookup(&row.get::<String, _>("status"), row.get("attempt")) {
            output_entry_metrics::record_cold(app.db.clone(), id);
        }
        if let Some(ready) = persistence::local_hls_ladder::read(&app.db, id)
            .await
            .map_err(failure)?
        {
            queue = (
                row.get::<Option<i64>, _>("metrics_queue_ms"),
                row.get::<Option<bool>, _>("metrics_queue_complete"),
                row.get::<Option<i64>, _>("metrics_queue_accounted_attempt"),
            );
            snapshot = Some(ready);
            break;
        }
        match row.get::<String, _>("status").as_str() {
            "failed" => {
                let code: Option<String> = row.get("error");
                let (status, code) = persistence::media_jobs::terminal_error(code.as_deref());
                return Err((StatusCode::from_u16(status).unwrap(), code.into()));
            }
            "cancelled" => return Err((StatusCode::GONE, "media_job_cancelled".into())),
            "succeeded" => return Err(failure("missing_ladder_proof")),
            _ => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
    let snapshot = snapshot.ok_or((StatusCode::SERVICE_UNAVAILABLE, "media_unavailable".into()))?;
    if q.attempt.is_some_and(|attempt| attempt != snapshot.attempt) {
        return Err((StatusCode::CONFLICT, "stale_media".into()));
    }
    let attempt = snapshot.attempt;
    boundary
        .bind_attempt(attempt)
        .map_err(|_| (StatusCode::CONFLICT, "stale_media".into()))?;
    let planned = match resource {
        Resource::Master => None,
        Resource::Playlist(id) | Resource::Init(id) | Resource::Segment(id, _) => Some(id),
    };
    if planned.is_some_and(|id| !snapshot.renditions.iter().any(|r| r.0 == id)) {
        return Err((StatusCode::NOT_FOUND, "invalid_resource".into()));
    }
    let reader = cache_read::ReadGuard::acquire(&app.db, id, attempt)
        .await
        .map_err(failure)?;
    if !reader.healthy() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "media_unavailable".into()));
    }
    let rewrite = |path: String| {
        format!(
            "/media-delivery/{id}/ladder/{path}?token={}&attempt={attempt}",
            q.token
        )
    };
    let manifest = match resource {
        Resource::Master => {
            parse_master(&snapshot.master).map_err(failure)?;
            Some(rewrite_manifest(&snapshot.master, |uri| {
                rewrite(uri.to_owned())
            }))
        }
        Resource::Playlist(rung) => {
            let text = &snapshot.renditions.iter().find(|r| r.0 == rung).unwrap().1;
            Some(rewrite_manifest(text, |uri| {
                rewrite(format!("{}/{uri}", rung.as_str()))
            }))
        }
        _ => None,
    };
    if let Some(text) = manifest {
        let mut response = (
            [
                (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                (header::CACHE_CONTROL, "private, no-store"),
            ],
            if head { String::new() } else { text },
        )
            .into_response();
        if let Some(ready) = entry.ready(attempt, queue.0, queue.1, queue.2) {
            response.extensions_mut().insert(ready);
        }
        return Ok(with_cache(
            response,
            if snapshot.status == "succeeded" {
                Cache::Hit
            } else {
                Cache::NotHit
            },
        ));
    }
    let (rung, index) = match resource {
        Resource::Init(rung) => (rung, -1),
        Resource::Segment(rung, index) if index < snapshot.segment_count as usize => {
            (rung, index as i32)
        }
        _ => return Err((StatusCode::NOT_FOUND, "unpublished_output_segment".into())),
    };
    let proof = persistence::local_hls_ladder::file_proof(&app.db, id, attempt, rung, index)
        .await
        .map_err(failure)?;
    let path = persistence::media_jobs::output_dir(&app.cache, id, attempt).join(resource.path());
    let opened = app
        .output_checks
        .open(path.clone(), Some(proof))
        .await
        .map_err(failure)?;
    let response =
        file_delivery::response(&path, &headers, head, Some(reader), Some(opened), None).await?;
    Ok(with_cache(
        response,
        if snapshot.status == "succeeded" {
            Cache::Hit
        } else {
            Cache::NotHit
        },
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn token_only_and_ambiguous_login_are_not_browser_authority() {
        let mut headers = HeaderMap::new();
        assert!(browser_login_hash(&headers).is_err());
        headers.insert(
            header::AUTHORIZATION,
            "Bearer playback-token".parse().unwrap(),
        );
        assert!(browser_login_hash(&headers).is_err());
        headers.insert(
            header::COOKIE,
            format!("rainsync_session={}", "a".repeat(64))
                .parse()
                .unwrap(),
        );
        let original = browser_login_hash(&headers).unwrap();
        assert_eq!(original, hash(&"a".repeat(64)));
        headers.insert(
            header::COOKIE,
            format!("rainsync_session={}", "b".repeat(64))
                .parse()
                .unwrap(),
        );
        let other = browser_login_hash(&headers).unwrap();
        assert_ne!(other, original);
        assert!(
            playback_access::LadderBoundary::new(other, None)
                .unwrap()
                .require_original_login(&original)
                .is_err()
        );
        headers.append(
            header::COOKIE,
            format!("rainsync_session={}", "a".repeat(64))
                .parse()
                .unwrap(),
        );
        assert!(browser_login_hash(&headers).is_err());
    }
    #[test]
    fn every_resource_rewrite_stays_same_origin_and_attempt_fenced() {
        let source = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=1250000,RESOLUTION=640x360,FRAME-RATE=30.000,CODECS=\"avc1.64001F\"\nlow/index.m3u8\n";
        assert!(parse_master(source).is_ok());
        let id = Uuid::nil();
        let text = rewrite_manifest(source, |path| {
            format!("/media-delivery/{id}/ladder/{path}?token=secret&attempt=3")
        });
        assert!(text.contains("/ladder/low/index.m3u8?token=secret&attempt=3"));
        for path in [
            "../low/init.mp4",
            "low/../init.mp4",
            "https://host/a",
            "low/key.bin",
            "low/index00.m4s",
            "low/index0.m4s?token=x",
        ] {
            assert!(Resource::parse(path).is_err(), "{path}");
        }
    }
}
