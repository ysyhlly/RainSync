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
#[path = "hls_manifest.rs"]
pub(crate) mod hls_manifest;
#[path = "http_delivery.rs"]
pub(crate) mod http_delivery;

#[derive(Clone, Debug, PartialEq, Eq)]
struct HttpValidators {
    etag: Option<String>,
    modified: Option<String>,
    size: Option<u64>,
}
impl HttpValidators {
    fn from_headers(headers: &HeaderMap) -> Self {
        let text = |name| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let size = if headers.contains_key(header::CONTENT_RANGE) {
            headers
                .get(header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| http_delivery::ContentRange::parse(v).ok())
                .and_then(|v| v.total())
        } else {
            headers
                .get(header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok())
        };
        Self {
            etag: text(header::ETAG),
            modified: text(header::LAST_MODIFIED),
            size,
        }
    }
    fn strong_etag(&self) -> Option<&str> {
        self.etag.as_deref().filter(|v| {
            v.starts_with('"')
                && v.ends_with('"')
                && v.len() >= 2
                && !v[1..v.len() - 1]
                    .bytes()
                    .any(|v| v == b'"' || v.is_ascii_control())
        })
    }
}

#[derive(Clone)]
struct Target {
    url: String,
    depth: u8,
    kind: Option<hls_manifest::Kind>,
}
#[derive(Default)]
struct Targets {
    by_key: HashMap<Uuid, Target>,
    by_url: HashMap<(String, u8), Uuid>,
}
impl Targets {
    fn insert(&mut self, url: String, depth: u8) -> anyhow::Result<Uuid> {
        self.insert_kind(url, depth, None)
    }
    fn insert_kind(
        &mut self,
        url: String,
        depth: u8,
        kind: Option<hls_manifest::Kind>,
    ) -> anyhow::Result<Uuid> {
        if let Some(key) = self.by_url.get(&(url.clone(), depth)) {
            let existing = self.by_key.get_mut(key).expect("registered target");
            // Only exclusively cryptographic key inputs may bypass demuxer
            // sniffing. Reusing a key grant for a segment (or vice versa) would
            // expose unclassified upstream bytes to the decoder.
            anyhow::ensure!(
                (existing.kind == Some(hls_manifest::Kind::Key))
                    == (kind == Some(hls_manifest::Kind::Key)),
                "manifest_key_resource_conflict"
            );
            if kind == Some(hls_manifest::Kind::Playlist) || existing.kind.is_none() {
                existing.kind = kind;
            }
            return Ok(*key);
        }
        anyhow::ensure!(
            self.by_key.len() < hls_manifest::MAX_REFERENCES,
            "manifest_resource_limit"
        );
        let key = Uuid::new_v4();
        self.by_url.insert((url.clone(), depth), key);
        self.by_key.insert(key, Target { url, depth, kind });
        Ok(key)
    }
}

#[derive(Clone, Default)]
pub struct Registry(Arc<Mutex<HashMap<Uuid, Arc<Grant>>>>);
pub struct Grant {
    pub attempt: Attempt,
    pub resource: Value,
    pub cancel: watch::Sender<bool>,
    input_failure: input_failure::Observation,
    remaining: AtomicU64,
    targets: Mutex<Targets>,
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
        // Root targets are the bounded, provider-generated video/poster list.
        // A failed registration yields an unregistered key, never a URL bypass.
        self.targets
            .lock()
            .unwrap()
            .insert(url, 0)
            .unwrap_or_else(|_| {
                self.stop();
                Uuid::new_v4()
            })
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
        .by_key
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
        _ => return remote(&app.client, grant, target, &h, head).await,
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
    client: &reqwest::Client,
    grant: Arc<Grant>,
    registration: Target,
    h: &HeaderMap,
    head: bool,
) -> Result<Response> {
    let original =
        providers::validate_url(grant.resource["url"].as_str().unwrap_or("")).map_err(failure)?;
    let target = providers::validate_url(&registration.url).map_err(failure)?;
    if target.origin() != original.origin() {
        return Err((StatusCode::FORBIDDEN, "cross_origin_media_rejected".into()));
    }
    let mut req = if head {
        client.head(target.clone())
    } else {
        client.get(target.clone())
    };
    if let Some(headers) = grant.resource["headers"].as_object() {
        for (k, v) in headers {
            if let Some(v) = v.as_str() {
                req = req.header(k, v)
            }
        }
    }
    if !head {
        for name in [header::RANGE, header::IF_RANGE] {
            if let Some(value) = h.get(&name) {
                req = req.header(name, value)
            }
        }
    }
    let previous = grant
        .validators
        .lock()
        .unwrap()
        .get(target.as_str())
        .cloned();
    if let Some(previous) = &previous
        && let Some(etag) = previous.strong_etag()
    {
        req = req.header(header::IF_MATCH, etag)
    }
    let mut cancel = grant.cancel.subscribe();
    if *cancel.borrow() {
        return Err((StatusCode::UNAUTHORIZED, "invalid_resource".into()));
    }
    let response = tokio::select! {biased;
        _ = cancel.changed() => return Err((StatusCode::UNAUTHORIZED, "invalid_resource".into())),
        response = req.send() => response.map_err(failure)?,
    };
    if response.status() == StatusCode::PRECONDITION_FAILED {
        grant.stop();
        return Err((StatusCode::CONFLICT, "source_changed".into()));
    }
    if response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
        let range = http_delivery::validate_range_response(response.status(), response.headers())
            .map_err(failure)?;
        if previous
            .as_ref()
            .and_then(|v| v.size)
            .zip(range.and_then(|v| v.total()))
            .is_some_and(|(old, new)| old != new)
        {
            grant.stop();
            return Err((StatusCode::CONFLICT, "source_changed".into()));
        }
        let mut result = Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_LENGTH, 0)
            .header(header::CACHE_CONTROL, "private, no-store");
        for name in [header::CONTENT_RANGE, header::ACCEPT_RANGES] {
            if let Some(value) = response.headers().get(&name) {
                result = result.header(name, value);
            }
        }
        return result.body(Body::empty()).map_err(failure);
    }
    if !response.status().is_success() {
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            grant.stop();
        }
        return Err((StatusCode::BAD_GATEWAY, "upstream_media_error".into()));
    }
    http_delivery::validate_range_response(response.status(), response.headers())
        .map_err(failure)?;
    let response_status = response.status();
    let response_headers = response.headers().clone();
    let mut playlist = registration.kind == Some(hls_manifest::Kind::Playlist)
        || target.path().ends_with(".m3u8")
        || response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().contains("mpegurl"));
    let mut source = response.bytes_stream();
    let mut prefix = Vec::new();
    let mut buffered = Vec::new();
    if !head {
        while prefix.len() < http_delivery::SNIFF_BYTES {
            let next = tokio::select! {biased;
                _ = cancel.changed() => return Err((StatusCode::UNAUTHORIZED, "invalid_resource".into())),
                next = source.next() => next,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(failure)?;
            prefix.extend_from_slice(
                &chunk[..chunk.len().min(http_delivery::SNIFF_BYTES - prefix.len())],
            );
            buffered.push(chunk);
        }
        // Keys are raw 16-byte cryptographic values, not demuxer input.
        if registration.kind != Some(hls_manifest::Kind::Key) {
            playlist |= http_delivery::hls_prefix(&prefix).map_err(failure)?;
        }
    }
    let stream = futures_util::stream::iter(buffered.into_iter().map(Ok)).chain(source);
    {
        let mut targets = grant.targets.lock().unwrap();
        let registered_key = targets
            .by_url
            .get(&(registration.url.clone(), registration.depth))
            .copied();
        let current_kind = registered_key
            .and_then(|key| targets.by_key.get(&key))
            .and_then(|v| v.kind);
        let mut validators = grant.validators.lock().unwrap();
        if head && current_kind == Some(hls_manifest::Kind::Playlist) {
            playlist = true;
        }
        if playlist {
            // Every stored validator belongs to a body classified as binary. An
            // upstream switch to HLS is a representation change, even if it ignores
            // If-Match or reuses its ETag; do not silently upgrade that prior body.
            if previous.is_some() || validators.contains_key(target.as_str()) {
                grant.stop();
                return Err((StatusCode::CONFLICT, "source_changed".into()));
            }
            if let Some(key) = registered_key {
                targets
                    .by_key
                    .get_mut(&key)
                    .expect("registered target")
                    .kind = Some(hls_manifest::Kind::Playlist);
            }
            validators.remove(target.as_str());
        } else if current_kind == Some(hls_manifest::Kind::Playlist) {
            grant.stop();
            return Err((StatusCode::CONFLICT, "source_changed".into()));
        } else if !head || previous.is_some() {
            // An unknown HEAD has no body evidence: it could describe a mutable,
            // extensionless playlist. Compare already-bound binary bodies only.
            let validator = HttpValidators::from_headers(&response_headers);
            if validators
                .get(target.as_str())
                .is_some_and(|v| v != &validator)
            {
                grant.stop();
                return Err((StatusCode::CONFLICT, "source_changed".into()));
            }
            validators.insert(target.to_string(), validator);
        }
    }
    if playlist && head {
        // The upstream length/ETag describe its original playlist, not the
        // representation whose URIs we rewrite. HEAD may omit fields that can
        // only be determined by generating the GET body (RFC 9110 9.3.2).
        return Ok((
            [
                (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                (header::CACHE_CONTROL, "private, no-store"),
            ],
            Body::empty(),
        )
            .into_response());
    }
    if playlist && !head {
        if registration.depth >= hls_manifest::MAX_DEPTH {
            return Err(failure("manifest_depth_limit"));
        }
        if response_headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .is_some_and(|v| v > hls_manifest::MAX_BYTES as u64)
        {
            return Err(failure("manifest_limit"));
        }
        let mut stream = stream;
        let mut bytes = vec![];
        let mut cancel = grant.cancel.subscribe();
        loop {
            let chunk = tokio::select! {_=cancel.changed()=>return Err(failure("cancelled")),v=stream.next()=>v};
            let Some(chunk) = chunk else { break };
            let chunk = chunk.map_err(failure)?;
            grant.charge(chunk.len()).map_err(failure)?;
            if bytes.len() + chunk.len() > hls_manifest::MAX_BYTES {
                return Err(failure("manifest_limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8(bytes).map_err(failure)?;
        let manifest = hls_manifest::Manifest::parse(&text).map_err(failure)?;
        // Validate all references before registering any grants. Relative URLs
        // always resolve against the current playlist, not its root ancestor.
        let children = manifest
            .references()
            .iter()
            .map(|reference| {
                let joined = target.join(reference.uri).map_err(failure)?;
                let joined = providers::validate_url(joined.as_str()).map_err(failure)?;
                if joined.origin() != original.origin() {
                    return Err((StatusCode::FORBIDDEN, "cross_origin_media_rejected".into()));
                }
                Ok(joined)
            })
            .collect::<Result<Vec<_>>>()?;
        let mut children = children.into_iter();
        let rewritten = manifest
            .rewrite(|reference| {
                let child = children.next().expect("one child per parsed reference");
                let key = grant.targets.lock().unwrap().insert_kind(
                    child.to_string(),
                    registration.depth + 1,
                    Some(reference.kind),
                )?;
                let extension = if reference.kind == hls_manifest::Kind::Playlist {
                    "m3u8"
                } else {
                    child
                        .path()
                        .rsplit('.')
                        .next()
                        .filter(|v| matches!(*v, "ts" | "m4s" | "mp4" | "aac" | "key" | "vtt"))
                        .unwrap_or("bin")
                };
                Ok(format!(
                    "{}.{}",
                    url(grant.attempt.attempt_id, key)?,
                    extension
                ))
            })
            .map_err(failure)?;
        return Ok((
            [
                (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                (header::CACHE_CONTROL, "private, no-store"),
            ],
            rewritten,
        )
            .into_response());
    }
    let mut result = Response::builder().status(response_status);
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::ETAG,
        header::LAST_MODIFIED,
    ] {
        if let Some(v) = response_headers.get(&name) {
            result = result.header(name, v)
        }
    }
    let response = result
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(if head {
            Body::empty()
        } else {
            Body::from_stream(stream)
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

    async fn origin(router: axum::Router) -> (String, tokio::task::JoinHandle<()>) {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = socket.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(socket, router).await.unwrap() });
        (format!("http://{address}"), task)
    }
    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }
    fn http_grant(url: &str) -> (Arc<Grant>, Lifecycle) {
        let (cancel, _) = watch::channel(false);
        Registry::default().register(attempt(), json!({"url": url, "headers": {"Authorization": "Bearer fixture", "Cookie": "fixture=secret", "X-Source-Key": "fixture-secret"}}), 16 * 1024 * 1024, cancel)
    }
    fn target(grant: &Grant, url: &str) -> Target {
        let key = grant.target(url.to_owned());
        grant.targets.lock().unwrap().by_key[&key].clone()
    }

    #[tokio::test]
    async fn redirect_cannot_forward_source_credentials_to_another_origin() {
        let hits = Arc::new(AtomicU64::new(0));
        let seen = hits.clone();
        let (forbidden, forbidden_task) = origin(axum::Router::new().fallback(move || {
            let seen = seen.clone();
            async move {
                seen.fetch_add(1, Ordering::SeqCst);
                "unexpected"
            }
        }))
        .await;
        let location = format!("{forbidden}/stolen");
        let (source, source_task) =
            origin(axum::Router::new().fallback(move |headers: HeaderMap| {
                let location = location.clone();
                async move {
                    assert_eq!(headers[header::AUTHORIZATION], "Bearer fixture");
                    Response::builder()
                        .status(302)
                        .header(header::LOCATION, location)
                        .body(Body::empty())
                        .unwrap()
                }
            }))
            .await;
        let url = format!("{source}/video.mp4");
        let (grant, _lifecycle) = http_grant(&url);
        let result = remote(
            &client(),
            grant.clone(),
            target(&grant, &url),
            &HeaderMap::new(),
            false,
        )
        .await;
        assert_eq!(result.unwrap_err().0, StatusCode::BAD_GATEWAY);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        let result = remote(
            &client(),
            grant.clone(),
            target(&grant, &forbidden),
            &HeaderMap::new(),
            false,
        )
        .await;
        assert_eq!(result.unwrap_err().0, StatusCode::FORBIDDEN);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        source_task.abort();
        forbidden_task.abort();
    }

    #[tokio::test]
    async fn every_hls_reference_is_checked_before_any_child_grant_is_registered() {
        let (source, task) = origin(axum::Router::new().fallback(|| async {
            "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"http://other.example/key\"\nsegment.ts\n"
        })).await;
        let url = format!("{source}/root.m3u8");
        let (grant, _lifecycle) = http_grant(&url);
        let registered = target(&grant, &url);
        let result = remote(
            &client(),
            grant.clone(),
            registered,
            &HeaderMap::new(),
            false,
        )
        .await;
        assert_eq!(result.unwrap_err().0, StatusCode::FORBIDDEN);
        assert_eq!(grant.targets.lock().unwrap().by_key.len(), 1);
        task.abort();
    }

    #[tokio::test]
    async fn extensionless_octet_stream_variant_cannot_bypass_child_authorization() {
        let (source, task) = origin(axum::Router::new().fallback(
            |uri: axum::http::Uri| async move {
                let body = if uri.path() == "/master.m3u8" {
                    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nnested/variant\n"
                } else {
                    "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://other.example/escape.ts\n"
                };
                Response::builder()
                    .header(header::CONTENT_TYPE, "application/octet-stream")
                    .body(Body::from(body))
                    .unwrap()
            },
        ))
        .await;
        let url = format!("{source}/master.m3u8");
        let (grant, _lifecycle) = http_grant(&url);
        remote(
            &client(),
            grant.clone(),
            target(&grant, &url),
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        let child = grant
            .targets
            .lock()
            .unwrap()
            .by_key
            .values()
            .find(|v| v.depth == 1)
            .unwrap()
            .clone();
        assert_eq!(child.kind, Some(hls_manifest::Kind::Playlist));
        assert!(child.url.ends_with("/nested/variant"));
        assert_eq!(
            remote(&client(), grant.clone(), child, &HeaderMap::new(), false)
                .await
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );
        task.abort();
    }

    #[tokio::test]
    async fn misleading_root_metadata_cannot_hide_hls_or_unsupported_dash() {
        let (source, task) = origin(axum::Router::new().fallback(|uri: axum::http::Uri| async move {
            let body = if uri.path() == "/dash.mp4" {
                "<?xml version=\"1.0\"?><MPD><BaseURL>http://other.example/escape</BaseURL></MPD>"
            } else {
                "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://other.example/escape.ts\n"
            };
            Response::builder().header(header::CONTENT_TYPE, "video/mp4").body(Body::from(body)).unwrap()
        })).await;
        for (path, status) in [
            ("hidden.mp4", StatusCode::FORBIDDEN),
            ("dash.mp4", StatusCode::BAD_GATEWAY),
        ] {
            let url = format!("{source}/{path}");
            let (grant, _lifecycle) = http_grant(&url);
            assert_eq!(
                remote(
                    &client(),
                    grant.clone(),
                    target(&grant, &url),
                    &HeaderMap::new(),
                    false
                )
                .await
                .unwrap_err()
                .0,
                status
            );
        }
        task.abort();
    }

    #[tokio::test]
    async fn long_whitespace_padding_cannot_defer_mpd_detection_into_decoder_probing() {
        let (source, task) = origin(axum::Router::new().fallback(|| async {
            let body = futures_util::stream::iter([
                Ok::<_, std::io::Error>(axum::body::Bytes::from(vec![b' '; 700])),
                Ok(axum::body::Bytes::from(format!(
                    "{}<MPD><BaseURL>http://other.example/escape</BaseURL></MPD>",
                    " ".repeat(700)
                ))),
            ]);
            Response::builder()
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(Body::from_stream(body))
                .unwrap()
        }))
        .await;
        let url = format!("{source}/movie.mp4");
        let (grant, _lifecycle) = http_grant(&url);
        assert_eq!(
            remote(
                &client(),
                grant.clone(),
                target(&grant, &url),
                &HeaderMap::new(),
                false
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::BAD_GATEWAY
        );
        task.abort();
    }

    #[tokio::test]
    async fn nested_manifest_uses_its_own_base_and_stable_keys_for_byte_ranges() {
        let (source, task) = origin(axum::Router::new().fallback(|headers: HeaderMap| async move {
            assert_eq!(headers[header::COOKIE], "fixture=secret");
            assert_eq!(headers["x-source-key"], "fixture-secret");
            "#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"s\",NAME=\"Subtitles\",URI=\"../subs/list.m3u8\"\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"100@0\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXT-X-BYTERANGE:10@100\nmedia.mp4\n#EXT-X-DISCONTINUITY\n#EXT-X-BYTERANGE:10\nmedia.mp4\n"
        })).await;
        let url = format!("{source}/root.m3u8");
        let nested = format!("{source}/nested/list.m3u8");
        let (grant, _lifecycle) = http_grant(&url);
        let registration = target(&grant, &nested);
        let first = remote(
            &client(),
            grant.clone(),
            registration.clone(),
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(first.headers()[header::CACHE_CONTROL], "private, no-store");
        let first = axum::body::to_bytes(first.into_body(), 4096).await.unwrap();
        let second = remote(
            &client(),
            grant.clone(),
            registration,
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        let second = axum::body::to_bytes(second.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(first, second);
        let rewritten = String::from_utf8(first.to_vec()).unwrap();
        assert!(!rewritten.contains(&source));
        let segments: Vec<_> = rewritten.lines().filter(|v| !v.starts_with('#')).collect();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0], segments[1]);
        let targets = grant.targets.lock().unwrap();
        assert_eq!(targets.by_key.len(), 5);
        assert!(
            targets
                .by_url
                .contains_key(&(format!("{source}/subs/list.m3u8"), 1))
        );
        assert!(
            targets
                .by_url
                .contains_key(&(format!("{source}/nested/init.mp4"), 1))
        );
        assert!(
            targets
                .by_url
                .contains_key(&(format!("{source}/nested/key.bin"), 1))
        );
        task.abort();
    }

    #[tokio::test]
    async fn playlist_cycles_stop_at_four_levels_and_live_updates_do_not_pin_old_etags() {
        let reads = Arc::new(AtomicU64::new(0));
        let seen = reads.clone();
        let (source, task) = origin(axum::Router::new().fallback(move || {
            let seen = seen.clone();
            async move {
                let version = seen.fetch_add(1, Ordering::SeqCst);
                Response::builder()
                    .header(header::ETAG, format!("\"{version}\""))
                    .body(Body::from(
                        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nloop.m3u8\n",
                    ))
                    .unwrap()
            }
        }))
        .await;
        let url = format!("{source}/loop.m3u8");
        let (grant, _lifecycle) = http_grant(&url);
        let registration = target(&grant, &url);
        remote(
            &client(),
            grant.clone(),
            registration.clone(),
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        remote(
            &client(),
            grant.clone(),
            registration,
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        assert!(grant.validators.lock().unwrap().is_empty());
        for depth in 1..hls_manifest::MAX_DEPTH {
            let registration = grant
                .targets
                .lock()
                .unwrap()
                .by_key
                .values()
                .find(|v| v.depth == depth)
                .unwrap()
                .clone();
            remote(
                &client(),
                grant.clone(),
                registration,
                &HeaderMap::new(),
                false,
            )
            .await
            .unwrap();
        }
        let deepest = grant
            .targets
            .lock()
            .unwrap()
            .by_key
            .values()
            .find(|v| v.depth == hls_manifest::MAX_DEPTH)
            .unwrap()
            .clone();
        let result = remote(&client(), grant.clone(), deepest, &HeaderMap::new(), false).await;
        assert_eq!(result.unwrap_err().0, StatusCode::BAD_GATEWAY);
        assert_eq!(
            grant.targets.lock().unwrap().by_key.len(),
            hls_manifest::MAX_DEPTH as usize + 1
        );
        task.abort();
    }

    #[tokio::test]
    async fn mutually_recursive_playlists_cannot_reset_depth_through_key_deduplication() {
        let (source, task) = origin(axum::Router::new().fallback(
            |uri: axum::http::Uri| async move {
                if uri.path() == "/a.m3u8" {
                    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nb.m3u8\n"
                } else {
                    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n"
                }
            },
        ))
        .await;
        let url = format!("{source}/a.m3u8");
        let (grant, _lifecycle) = http_grant(&url);
        let mut registration = target(&grant, &url);
        for depth in 0..hls_manifest::MAX_DEPTH {
            assert_eq!(registration.depth, depth);
            remote(
                &client(),
                grant.clone(),
                registration,
                &HeaderMap::new(),
                false,
            )
            .await
            .unwrap();
            registration = grant
                .targets
                .lock()
                .unwrap()
                .by_key
                .values()
                .find(|v| v.depth == depth + 1)
                .unwrap()
                .clone();
        }
        assert_eq!(registration.depth, hls_manifest::MAX_DEPTH);
        assert_eq!(
            remote(
                &client(),
                grant.clone(),
                registration,
                &HeaderMap::new(),
                false
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            grant.targets.lock().unwrap().by_key.len(),
            hls_manifest::MAX_DEPTH as usize + 1
        );
        task.abort();
    }

    #[tokio::test]
    async fn unknown_head_cannot_pin_extensionless_live_hls_and_sniffed_kind_is_retained() {
        let reads = Arc::new(AtomicU64::new(0));
        let seen = reads.clone();
        let (source, task) = origin(axum::Router::new().fallback(move |headers: HeaderMap| {
            let seen = seen.clone();
            async move {
                assert!(!headers.contains_key(header::IF_MATCH));
                let version = seen.fetch_add(1, Ordering::SeqCst);
                Response::builder()
                    .header(header::CONTENT_TYPE, "application/octet-stream")
                    .header(header::ETAG, format!("\"{version}\""))
                    .body(Body::from(
                        "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nseg.ts\n",
                    ))
                    .unwrap()
            }
        }))
        .await;
        let url = format!("{source}/live");
        let (grant, _lifecycle) = http_grant(&url);
        let registration = target(&grant, &url);
        remote(
            &client(),
            grant.clone(),
            registration,
            &HeaderMap::new(),
            true,
        )
        .await
        .unwrap();
        assert!(grant.validators.lock().unwrap().is_empty());
        let registration = target(&grant, &url);
        remote(
            &client(),
            grant.clone(),
            registration,
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            target(&grant, &url).kind,
            Some(hls_manifest::Kind::Playlist)
        );
        for head in [true, false, true, false] {
            remote(
                &client(),
                grant.clone(),
                target(&grant, &url),
                &HeaderMap::new(),
                head,
            )
            .await
            .unwrap();
        }
        assert!(grant.validators.lock().unwrap().is_empty());
        assert!(!*grant.cancel.borrow());
        task.abort();
    }

    #[tokio::test]
    async fn a_binary_resource_cannot_change_into_hls_even_if_upstream_ignores_if_match() {
        let reads = Arc::new(AtomicU64::new(0));
        let seen = reads.clone();
        let (source, task) = origin(axum::Router::new().fallback(move || {
            let seen = seen.clone();
            async move {
                let body = if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                    b"\0\0\0\x18ftypisom".as_slice()
                } else {
                    b"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nseg.ts\n".as_slice()
                };
                Response::builder()
                    .header(header::ETAG, "\"reused\"")
                    .body(Body::from(body))
                    .unwrap()
            }
        }))
        .await;
        let url = format!("{source}/media");
        let (grant, _lifecycle) = http_grant(&url);
        remote(
            &client(),
            grant.clone(),
            target(&grant, &url),
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            remote(
                &client(),
                grant.clone(),
                target(&grant, &url),
                &HeaderMap::new(),
                false
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::CONFLICT
        );
        assert!(*grant.cancel.borrow());
        task.abort();
    }

    #[tokio::test]
    async fn concurrent_late_hls_cannot_erase_an_already_published_binary_binding() {
        let reads = Arc::new(AtomicU64::new(0));
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let seen = reads.clone();
        let observed = entered.clone();
        let gate = release.clone();
        let (source, task) = origin(axum::Router::new().fallback(move || {
            let (seen, observed, gate) = (seen.clone(), observed.clone(), gate.clone());
            async move {
                if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                    observed.notify_one();
                    gate.notified().await;
                    Body::from("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nseg.ts\n")
                } else {
                    Body::from("binary body")
                }
            }
        }))
        .await;
        let url = format!("{source}/media");
        let (grant, _lifecycle) = http_grant(&url);
        let registration = target(&grant, &url);
        let owned = grant.clone();
        let late = tokio::spawn(async move {
            remote(&client(), owned, registration, &HeaderMap::new(), false).await
        });
        tokio::time::timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        remote(
            &client(),
            grant.clone(),
            target(&grant, &url),
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        release.notify_one();
        assert_eq!(late.await.unwrap().unwrap_err().0, StatusCode::CONFLICT);
        assert!(*grant.cancel.borrow());
        task.abort();
    }

    #[tokio::test]
    async fn playlist_head_does_not_claim_the_length_or_etag_of_unrewritten_bytes() {
        let (source, task) = origin(axum::Router::new().fallback(|| async {
            Response::builder()
                .header(header::ETAG, "\"raw-playlist\"")
                .body(Body::from("#EXTM3U\nseg.ts\n"))
                .unwrap()
        }))
        .await;
        let url = format!("{source}/a.m3u8");
        let (grant, _lifecycle) = http_grant(&url);
        let response = remote(
            &client(),
            grant.clone(),
            target(&grant, &url),
            &HeaderMap::new(),
            true,
        )
        .await
        .unwrap();
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/vnd.apple.mpegurl"
        );
        assert!(!response.headers().contains_key(header::CONTENT_LENGTH));
        assert!(!response.headers().contains_key(header::ETAG));
        assert!(
            axum::body::to_bytes(response.into_body(), 0)
                .await
                .unwrap()
                .is_empty()
        );
        task.abort();
    }

    #[test]
    fn key_grants_cannot_alias_any_decoder_resource_in_either_order() {
        use hls_manifest::Kind;
        for other in [
            None,
            Some(Kind::Playlist),
            Some(Kind::Segment),
            Some(Kind::Initialization),
            Some(Kind::Data),
        ] {
            for (first, second) in [(Some(Kind::Key), other), (other, Some(Kind::Key))] {
                let mut targets = Targets::default();
                let url = "http://media/shared.bin".to_owned();
                let key = targets.insert_kind(url.clone(), 1, first).unwrap();
                assert_eq!(
                    targets.insert_kind(url.clone(), 1, first).unwrap(),
                    key,
                    "same-role references keep their stable grant"
                );
                assert!(
                    targets.insert_kind(url, 1, second).is_err(),
                    "accepted conflicting roles {first:?} then {second:?}"
                );
                assert_eq!(targets.by_key[&key].kind, first);
                assert_eq!(targets.by_key.len(), 1);
            }
        }
    }

    #[tokio::test]
    async fn unused_key_alias_cannot_turn_a_segment_into_unclassified_input() {
        let child_reads = Arc::new(AtomicU64::new(0));
        let seen = child_reads.clone();
        let (source, task) = origin(axum::Router::new().fallback(
            move |uri: axum::http::Uri| {
                let seen = seen.clone();
                async move {
                    match uri.path() {
                        "/key-first.m3u8" => "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=AES-128,URI=\"shared.bin\"\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\nshared.bin\n#EXT-X-ENDLIST\n",
                        "/segment-first.m3u8" => "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nshared.bin\n#EXT-X-KEY:METHOD=AES-128,URI=\"shared.bin\"\n#EXT-X-KEY:METHOD=NONE\n#EXT-X-ENDLIST\n",
                        _ => {
                            seen.fetch_add(1, Ordering::SeqCst);
                            "<MPD><BaseURL>http://other.example/escape</BaseURL></MPD>"
                        }
                    }
                }
            },
        ))
        .await;
        for path in ["key-first.m3u8", "segment-first.m3u8"] {
            let url = format!("{source}/{path}");
            let (grant, _lifecycle) = http_grant(&url);
            let response = remote(
                &client(),
                grant.clone(),
                target(&grant, &url),
                &HeaderMap::new(),
                false,
            )
            .await;
            assert_eq!(response.unwrap_err().0, StatusCode::BAD_GATEWAY);
        }
        assert_eq!(child_reads.load(Ordering::SeqCst), 0);
        task.abort();
    }

    #[tokio::test]
    async fn exclusively_cryptographic_keys_preserve_arbitrary_sixteen_byte_values() {
        let bytes = vec![b'<'; 16];
        let upstream_bytes = bytes.clone();
        let (source, task) = origin(axum::Router::new().fallback(move || {
            let bytes = upstream_bytes.clone();
            async move { bytes }
        }))
        .await;
        let url = format!("{source}/secret.bin");
        let (grant, _lifecycle) = http_grant(&url);
        let registration = {
            let mut targets = grant.targets.lock().unwrap();
            let key = targets
                .insert_kind(url, 1, Some(hls_manifest::Kind::Key))
                .unwrap();
            targets.by_key[&key].clone()
        };
        let response = remote(&client(), grant, registration, &HeaderMap::new(), false)
            .await
            .unwrap();
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 16)
                .await
                .unwrap(),
            bytes
        );
        task.abort();
    }

    #[test]
    fn target_budget_and_validator_strength_are_explicit() {
        let mut targets = Targets::default();
        let first = targets.insert("http://media/0".into(), 0).unwrap();
        assert_eq!(targets.insert("http://media/0".into(), 0).unwrap(), first);
        targets
            .insert_kind(
                "http://media/0".into(),
                0,
                Some(hls_manifest::Kind::Playlist),
            )
            .unwrap();
        targets
            .insert_kind(
                "http://media/0".into(),
                0,
                Some(hls_manifest::Kind::Segment),
            )
            .unwrap();
        assert_eq!(
            targets.by_key[&first].kind,
            Some(hls_manifest::Kind::Playlist)
        );
        for i in 1..hls_manifest::MAX_REFERENCES {
            targets.insert(format!("http://media/{i}"), 0).unwrap();
        }
        assert!(targets.insert("http://media/extra".into(), 0).is_err());
        for etag in ["W/\"weak\"", "unquoted", "\"broken\"tag\""] {
            let validator = HttpValidators {
                etag: Some(etag.into()),
                modified: None,
                size: None,
            };
            assert!(validator.strong_etag().is_none());
        }
        let validator = HttpValidators {
            etag: Some("\"strong\"".into()),
            modified: None,
            size: None,
        };
        assert_eq!(validator.strong_etag(), Some("\"strong\""));
    }

    #[tokio::test]
    async fn upstream_range_head_if_range_and_416_keep_their_actual_semantics() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let (source, task) = origin(axum::Router::new().fallback(
            move |method: axum::http::Method, headers: HeaderMap| {
                let seen = seen.clone();
                async move {
                    seen.lock().unwrap().push((method, headers.clone()));
                    if headers.get(header::RANGE).is_some_and(|v| v == "bytes=3-") {
                        Response::builder()
                            .status(416)
                            .header(header::CONTENT_RANGE, "bytes */3")
                            .header(header::ACCEPT_RANGES, "bytes")
                            .body(Body::empty())
                            .unwrap()
                    } else {
                        // A server that ignores Range keeps its 200 and full length.
                        Response::builder()
                            .header(header::CONTENT_LENGTH, 3)
                            .header(header::ETAG, "W/\"weak\"")
                            .body(Body::from("abc"))
                            .unwrap()
                    }
                }
            },
        ))
        .await;
        let url = format!("{source}/video.mp4");
        let (grant, _lifecycle) = http_grant(&url);
        let registration = target(&grant, &url);
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=1-2".parse().unwrap());
        headers.insert(header::IF_RANGE, "\"earlier\"".parse().unwrap());
        let response = remote(
            &client(),
            grant.clone(),
            registration.clone(),
            &headers,
            false,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "3");
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 3).await.unwrap(),
            "abc"
        );
        let response = remote(
            &client(),
            grant.clone(),
            registration.clone(),
            &headers,
            true,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "3");
        assert!(
            axum::body::to_bytes(response.into_body(), 0)
                .await
                .unwrap()
                .is_empty()
        );
        headers.insert(header::RANGE, "bytes=3-".parse().unwrap());
        let response = remote(&client(), grant.clone(), registration, &headers, false)
            .await
            .unwrap();
        assert_eq!(response.status(), 416);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */3");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "0");
        let requests = requests.lock().unwrap();
        assert_eq!(requests[0].1[header::IF_RANGE], "\"earlier\"");
        assert_eq!(requests[1].0, axum::http::Method::HEAD);
        assert!(!requests[1].1.contains_key(header::RANGE));
        assert!(!requests[1].1.contains_key(header::IF_RANGE));
        assert!(
            requests
                .iter()
                .all(|(_, h)| !h.contains_key(header::IF_MATCH))
        );
        task.abort();
    }

    #[tokio::test]
    async fn changed_representation_cancels_retained_bodies_and_412_becomes_conflict() {
        let changed = Arc::new(AtomicU64::new(0));
        let seen = changed.clone();
        let (source, task) = origin(axum::Router::new().fallback(move |headers: HeaderMap| {
            let seen = seen.clone();
            async move {
                if seen.load(Ordering::SeqCst) == 1 {
                    assert_eq!(headers[header::IF_MATCH], "\"original\"");
                    Response::builder().status(412).body(Body::empty()).unwrap()
                } else {
                    Response::builder()
                        .header(header::ETAG, "\"original\"")
                        .header(header::CONTENT_LENGTH, 3)
                        .body(Body::from("abc"))
                        .unwrap()
                }
            }
        }))
        .await;
        let url = format!("{source}/video.mp4");
        let (grant, _lifecycle) = http_grant(&url);
        let registration = target(&grant, &url);
        let retained = remote(
            &client(),
            grant.clone(),
            registration.clone(),
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        changed.store(1, Ordering::SeqCst);
        let result = remote(
            &client(),
            grant.clone(),
            registration,
            &HeaderMap::new(),
            false,
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            (StatusCode::CONFLICT, "source_changed".into())
        );
        assert!(*grant.cancel.borrow());
        assert!(
            axum::body::to_bytes(retained.into_body(), 3)
                .await
                .unwrap()
                .is_empty()
        );
        grant.input_failure.stopped().await;
        task.abort();
    }

    #[tokio::test]
    async fn length_changes_without_a_strong_etag_still_invalidate_the_attempt() {
        let reads = Arc::new(AtomicU64::new(0));
        let seen = reads.clone();
        let (source, task) = origin(axum::Router::new().fallback(move || {
            let seen = seen.clone();
            async move {
                if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                    "abc"
                } else {
                    "abcdef"
                }
            }
        }))
        .await;
        let url = format!("{source}/video.mp4");
        let (grant, _lifecycle) = http_grant(&url);
        let registration = target(&grant, &url);
        let first = remote(
            &client(),
            grant.clone(),
            registration.clone(),
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            axum::body::to_bytes(first.into_body(), 3).await.unwrap(),
            "abc"
        );
        let result = remote(
            &client(),
            grant.clone(),
            registration,
            &HeaderMap::new(),
            false,
        )
        .await;
        assert_eq!(result.unwrap_err().0, StatusCode::CONFLICT);
        assert!(*grant.cancel.borrow());
        task.abort();
    }

    #[tokio::test]
    async fn a_new_416_resource_length_invalidates_the_attempt() {
        let reads = Arc::new(AtomicU64::new(0));
        let seen = reads.clone();
        let (source, task) = origin(axum::Router::new().fallback(move || {
            let seen = seen.clone();
            async move {
                if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                    Response::new(Body::from("abcdef"))
                } else {
                    Response::builder()
                        .status(416)
                        .header(header::CONTENT_RANGE, "bytes */3")
                        .body(Body::empty())
                        .unwrap()
                }
            }
        }))
        .await;
        let url = format!("{source}/video.mp4");
        let (grant, _lifecycle) = http_grant(&url);
        let registration = target(&grant, &url);
        let first = remote(
            &client(),
            grant.clone(),
            registration.clone(),
            &HeaderMap::new(),
            false,
        )
        .await
        .unwrap();
        axum::body::to_bytes(first.into_body(), 6).await.unwrap();
        let result = remote(
            &client(),
            grant.clone(),
            registration,
            &HeaderMap::new(),
            false,
        )
        .await;
        assert_eq!(result.unwrap_err().0, StatusCode::CONFLICT);
        assert!(*grant.cancel.borrow());
        task.abort();
    }

    #[tokio::test]
    async fn cancellation_interrupts_header_wait_without_a_body_poll() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let seen = entered.clone();
        let (source, task) = origin(axum::Router::new().fallback(move || {
            let seen = seen.clone();
            async move {
                seen.notify_one();
                std::future::pending::<&'static str>().await
            }
        }))
        .await;
        let url = format!("{source}/video.mp4");
        let (grant, lifecycle) = http_grant(&url);
        let registration = target(&grant, &url);
        let owned = grant.clone();
        let request = tokio::spawn(async move {
            remote(&client(), owned, registration, &HeaderMap::new(), false).await
        });
        tokio::time::timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        lifecycle.stop();
        let result = tokio::time::timeout(Duration::from_millis(500), request)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err().0, StatusCode::UNAUTHORIZED);
        task.abort();
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
