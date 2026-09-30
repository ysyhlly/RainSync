//! In-memory grants exist only for one leased attempt. HLS children get opaque
//! grants in the same registry and never carry upstream URLs or credentials.
use super::*;
use persistence::media_previews::Attempt;
use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::watch;
type HttpValidators = (Option<String>, Option<String>);

#[derive(Clone, Default)]
pub struct Registry(Arc<Mutex<HashMap<Uuid, Arc<Grant>>>>);
pub struct Grant {
    pub attempt: Attempt,
    pub resource: Value,
    pub cancel: watch::Sender<bool>,
    input_failure: input_failure::Observation,
    remaining: AtomicU64,
    targets: Mutex<HashMap<Uuid, String>>,
    validators: Mutex<HashMap<String, HttpValidators>>,
}
/// Owned by the leased attempt, independently of retained proxy bodies.
pub struct Lifecycle {
    registry: Registry,
    grant: Arc<Grant>,
}
impl Lifecycle {
    pub fn stop(&self) {
        let mut entries = self.registry.0.lock().unwrap();
        let id = self.grant.attempt.attempt_id;
        if entries
            .get(&id)
            .is_some_and(|value| Arc::ptr_eq(value, &self.grant))
        {
            entries.remove(&id);
        }
        drop(entries);
        self.grant.stop();
    }
}
impl Drop for Lifecycle {
    fn drop(&mut self) {
        self.stop();
    }
}
impl Grant {
    fn stop(&self) {
        self.cancel.send_replace(true);
        self.input_failure.stop();
    }
    pub fn target(&self, url: String) -> Uuid {
        let key = Uuid::new_v4();
        self.targets.lock().unwrap().insert(key, url);
        key
    }
    fn charge(&self, n: usize) -> std::io::Result<()> {
        self.remaining
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(n as u64)
            })
            .map(|_| ())
            .map_err(|_| {
                self.stop();
                std::io::Error::other("preview_input_budget")
            })
    }
}
pub fn register(
    app: &App,
    attempt: Attempt,
    resource: Value,
    bytes: u64,
    cancel: watch::Sender<bool>,
) -> (Arc<Grant>, Lifecycle) {
    app.preview_inputs
        .register(attempt, resource, bytes, cancel)
}
impl Registry {
    fn register(
        &self,
        attempt: Attempt,
        resource: Value,
        bytes: u64,
        cancel: watch::Sender<bool>,
    ) -> (Arc<Grant>, Lifecycle) {
        let grant = Arc::new(Grant {
            attempt,
            resource,
            cancel,
            input_failure: Default::default(),
            remaining: AtomicU64::new(bytes),
            targets: Default::default(),
            validators: Default::default(),
        });
        self.0
            .lock()
            .unwrap()
            .insert(grant.attempt.attempt_id, grant.clone());
        let lifecycle = Lifecycle {
            registry: self.clone(),
            grant: grant.clone(),
        };
        (grant, lifecycle)
    }
}
pub fn url(attempt: Uuid, key: Uuid) -> anyhow::Result<String> {
    let mut bind = std::env::var("WORKER_BIND")
        .unwrap_or("0.0.0.0:8081".into())
        .parse::<std::net::SocketAddr>()?;
    if bind.ip().is_unspecified() {
        bind.set_ip(std::net::Ipv4Addr::LOCALHOST.into())
    }
    Ok(format!("http://{bind}/preview-input/{attempt}/{key}"))
}
pub async fn read(
    State(app): State<App>,
    Path((id, key)): Path<(Uuid, String)>,
    h: HeaderMap,
    method: axum::http::Method,
) -> Result<Response> {
    let unauthorized = || (StatusCode::UNAUTHORIZED, "invalid_resource".into());
    let grant = app
        .preview_inputs
        .0
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(unauthorized)?;
    if *grant.cancel.borrow() {
        return Err(unauthorized());
    }
    let key = Uuid::parse_str(key.split('.').next().unwrap_or("")).map_err(|_| unauthorized())?;
    let target = grant
        .targets
        .lock()
        .unwrap()
        .get(&key)
        .cloned()
        .ok_or_else(unauthorized)?;
    let a = &grant.attempt;
    let valid:bool=sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM media_previews p JOIN media_items m ON m.id=p.media_id JOIN sources s ON s.id=m.source_id WHERE p.attempt_id=$1 AND p.owner_id=$2 AND p.status='running' AND p.lease_until>clock_timestamp() AND {} AND {})",persistence::media_previews::VALID,persistence::media_previews::FRESH))
        .bind(a.attempt_id).bind(a.owner_id).fetch_one(&app.db).await.map_err(failure)?;
    if !valid {
        return Err(unauthorized());
    }
    let head = method == axum::http::Method::HEAD;
    let resource = &grant.resource;
    let response = match resource["kind"].as_str().unwrap_or("") {
        "local" => {
            let path = media_core::safe_path(
                std::path::Path::new(resource["root"].as_str().unwrap_or("")),
                resource["resource"].as_str().unwrap_or(""),
            )
            .map_err(failure)?;
            let file = std::fs::File::open(&path).map_err(failure)?;
            let version = media_core::file_version::snapshot_file(&file).map_err(failure)?;
            if resource["read_version"] != version.version {
                return Err((StatusCode::CONFLICT, "source_changed".into()));
            }
            file_delivery::response(&path, &h, head, None, Some(file), Some(version.version))
                .await?
        }
        "agent" => {
            relay::fetch(&app, resource, &h, head, grant.input_failure.clone(), None).await?
        }
        _ => return remote(&app, grant, target, &h, head).await,
    };
    Ok(bounded(response, grant, head))
}

fn bounded(response: Response, grant: Arc<Grant>, head: bool) -> Response {
    let (parts, body) = response.into_parts();
    if head {
        return Response::from_parts(parts, Body::empty());
    }
    let stream = body.into_data_stream();
    let cancel = grant.cancel.subscribe();
    let stream = futures_util::stream::unfold(
        (stream, grant, cancel),
        |(mut stream, grant, mut cancel)| async move {
            if *cancel.borrow() {
                return None;
            }
            let chunk = tokio::select! {biased;_=cancel.changed()=>return None,v=stream.next()=>v?};
            let chunk = chunk.map_err(std::io::Error::other).and_then(|bytes| {
                grant.charge(bytes.len())?;
                Ok(bytes)
            });
            Some((chunk, (stream, grant, cancel)))
        },
    );
    Response::from_parts(parts, Body::from_stream(stream))
}
async fn remote(
    app: &App,
    grant: Arc<Grant>,
    target: String,
    h: &HeaderMap,
    head: bool,
) -> Result<Response> {
    let original =
        providers::validate_url(grant.resource["url"].as_str().unwrap_or("")).map_err(failure)?;
    let target = providers::validate_url(&target).map_err(failure)?;
    if target.origin() != original.origin() {
        return Err((StatusCode::FORBIDDEN, "cross_origin_media_rejected".into()));
    }
    let mut req = if head {
        app.client.head(target.clone())
    } else {
        app.client.get(target.clone())
    };
    if let Some(headers) = grant.resource["headers"].as_object() {
        for (k, v) in headers {
            if let Some(v) = v.as_str() {
                req = req.header(k, v)
            }
        }
    }
    if let Some(range) = h.get(header::RANGE) {
        req = req.header(header::RANGE, range)
    }
    let previous = grant
        .validators
        .lock()
        .unwrap()
        .get(target.as_str())
        .cloned();
    if let Some((etag, modified)) = &previous {
        if let Some(etag) = etag {
            req = req.header(header::IF_MATCH, etag)
        } else if let Some(modified) = modified {
            req = req.header(header::IF_UNMODIFIED_SINCE, modified)
        }
    }
    let response = req.send().await.map_err(failure)?;
    if !response.status().is_success() {
        return Err((StatusCode::BAD_GATEWAY, "upstream_media_error".into()));
    }
    let validator = (
        response
            .headers()
            .get(header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        response
            .headers()
            .get(header::LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
    );
    {
        let mut validators = grant.validators.lock().unwrap();
        if validators
            .get(target.as_str())
            .is_some_and(|v| v != &validator)
        {
            return Err((StatusCode::CONFLICT, "source_changed".into()));
        }
        validators.insert(target.to_string(), validator);
    }
    let playlist = target.path().ends_with(".m3u8")
        || response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("mpegurl"));
    if playlist && !head {
        let mut stream = response.bytes_stream();
        let mut bytes = vec![];
        let mut cancel = grant.cancel.subscribe();
        loop {
            let chunk = tokio::select! {_=cancel.changed()=>return Err(failure("cancelled")),v=stream.next()=>v};
            let Some(chunk) = chunk else { break };
            let chunk = chunk.map_err(failure)?;
            grant.charge(chunk.len()).map_err(failure)?;
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err(failure("manifest_limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8(bytes).map_err(failure)?;
        let mut invalid = false;
        let rewritten = rewrite_manifest(&text, |child| {
            let joined = target.join(child).ok().filter(|v| {
                v.origin() == original.origin()
                    && matches!(v.scheme(), "http" | "https")
                    && v.username().is_empty()
                    && v.password().is_none()
            });
            match joined {
                Some(v) => {
                    let key = grant.target(v.to_string());
                    let extension = v
                        .path()
                        .rsplit('.')
                        .next()
                        .filter(|v| matches!(*v, "m3u8" | "ts" | "m4s" | "mp4" | "aac" | "key"))
                        .unwrap_or("bin");
                    format!(
                        "{}.{}",
                        url(grant.attempt.attempt_id, key).unwrap_or_default(),
                        extension
                    )
                }
                None => {
                    invalid = true;
                    String::new()
                }
            }
        });
        if invalid {
            return Err((StatusCode::FORBIDDEN, "cross_origin_media_rejected".into()));
        }
        return Ok((
            [(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")],
            rewritten,
        )
            .into_response());
    }
    let mut result = Response::builder().status(response.status());
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(v) = response.headers().get(&name) {
            result = result.header(name, v)
        }
    }
    let response = result
        .body(if head {
            Body::empty()
        } else {
            Body::from_stream(response.bytes_stream())
        })
        .map_err(failure)?;
    Ok(bounded(response, grant, head))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn attempt() -> Attempt {
        Attempt {
            media_id: Uuid::new_v4(),
            attempt_id: Uuid::new_v4(),
            owner_id: Uuid::new_v4(),
            generation: 1,
        }
    }

    #[tokio::test]
    async fn attempt_drop_stops_retained_unpolled_body_and_only_its_relay() {
        let registry = Registry::default();
        let (cancel, mut receiver) = watch::channel(false);
        let (grant, lifecycle) = registry.register(attempt(), json!({}), 16, cancel);
        let observer = grant.input_failure.clone();
        let body = bounded(
            Response::new(Body::from_stream(futures_util::stream::pending::<
                std::result::Result<axum::body::Bytes, std::io::Error>,
            >())),
            grant.clone(),
            false,
        );
        let (other_cancel, _) = watch::channel(false);
        let (other, _other_lifecycle) = registry.register(attempt(), json!({}), 16, other_cancel);
        let playback_registry = input_failure::Registry::default();
        let playback_id = Uuid::new_v4();
        let playback = playback_registry.register(playback_id);
        let playback_observer = playback_registry.observe(playback_id, Some(playback.token()));

        // No response/body poll or Drop is needed to end the attempt's NAS owner.
        drop(lifecycle);
        tokio::time::timeout(Duration::from_millis(500), observer.stopped())
            .await
            .unwrap();
        receiver.changed().await.unwrap();
        assert!(*receiver.borrow());
        assert!(
            !registry
                .0
                .lock()
                .unwrap()
                .contains_key(&grant.attempt.attempt_id)
        );
        for unrelated in [&other.input_failure, &playback_observer] {
            assert!(
                tokio::time::timeout(Duration::from_millis(20), unrelated.stopped())
                    .await
                    .is_err()
            );
        }
        assert!(
            registry
                .0
                .lock()
                .unwrap()
                .contains_key(&other.attempt.attempt_id)
        );
        drop(body);
    }

    #[tokio::test]
    async fn budget_exhaustion_and_explicit_stop_cancel_the_owned_relay() {
        let registry = Registry::default();
        let (cancel, receiver) = watch::channel(false);
        let (grant, lifecycle) = registry.register(attempt(), json!({}), 4, cancel);
        grant.charge(4).unwrap();
        assert!(grant.charge(1).is_err());
        assert!(*receiver.borrow());
        tokio::time::timeout(Duration::from_millis(500), grant.input_failure.stopped())
            .await
            .unwrap();
        lifecycle.stop();
        lifecycle.stop();
        assert!(registry.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn retiring_old_lifecycle_cannot_remove_a_replacement_grant() {
        let registry = Registry::default();
        let a = attempt();
        let (cancel, _) = watch::channel(false);
        let (old, old_lifecycle) = registry.register(a.clone(), json!({}), 16, cancel);
        let (cancel, _) = watch::channel(false);
        let (current, current_lifecycle) = registry.register(a.clone(), json!({}), 16, cancel);
        drop(old_lifecycle);
        old.input_failure.stopped().await;
        assert!(Arc::ptr_eq(
            registry.0.lock().unwrap().get(&a.attempt_id).unwrap(),
            &current
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), current.input_failure.stopped())
                .await
                .is_err()
        );
        current_lifecycle.stop();
        current.input_failure.stopped().await;
        assert!(registry.0.lock().unwrap().is_empty());
    }
}
