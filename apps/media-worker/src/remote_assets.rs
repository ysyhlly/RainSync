//! Assets are reached only through the original authenticated session, a
//! frozen numeric catalog, and the original source policy/revision/deadline.
use super::*;
use futures_util::StreamExt;
use media_core::advanced_media::{
    self as assets, AssetCatalog, AssetFile, HttpAssetAssociation, HttpAssetPin, HttpSourcePin,
    RemoteAssetCatalog, SubtitleAsset,
};
use std::time::Duration;

fn remote_source(resource: &Value) -> &str {
    if resource["kind"] == "http" {
        resource["url"].as_str().unwrap_or("")
    } else {
        resource["resource"].as_str().unwrap_or("")
    }
}
async fn agent_capable(app: &App, resource: &Value) -> anyhow::Result<bool> {
    let agent = Uuid::parse_str(resource["agent_id"].as_str().unwrap_or(""))?;
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agents WHERE id=$1 AND NOT revoked AND last_seen>clock_timestamp()-interval '15 seconds' AND advanced_assets_version=1)").bind(agent).fetch_one(&app.db).await?)
}
async fn read_body(response: reqwest::Response, limit: u64) -> anyhow::Result<Vec<u8>> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| anyhow::anyhow!("advanced_asset_read_failed"))?;
        anyhow::ensure!(
            (bytes.len() as u64)
                .checked_add(chunk.len() as u64)
                .is_some_and(|n| n <= limit),
            "advanced_asset_bound"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn http_file(
    resource: &Value,
    logical: &str,
    expected: Option<&HttpAssetPin>,
    head: bool,
) -> anyhow::Result<(HttpAssetPin, Vec<u8>)> {
    let target = assets::http_asset_url(remote_source(resource), logical)?;
    let config = providers::resource_config(resource)?;
    // No redirects: original same-stem URLs and credentials stay at exactly
    // the registered origin and still pass the existing source access policy.
    let mut request = providers::source_request(
        &config,
        &target,
        if head {
            reqwest::Method::HEAD
        } else {
            reqwest::Method::GET
        },
        &config.headers,
    )
    .await?
    .header(header::ACCEPT_ENCODING, "identity");
    if let Some(pin) = expected {
        request = request.header(header::IF_MATCH, &pin.etag);
    }
    let response = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("advanced_asset_read_failed"))?;
    anyhow::ensure!(
        response.status() == reqwest::StatusCode::OK && response.url().as_str() == target,
        "source_changed"
    );
    let metadata = crate::http_identity::Metadata::read(response.status(), response.headers())?;
    let etag = metadata
        .etag
        .filter(|v| crate::http_identity::strong_etag(v))
        .ok_or_else(|| anyhow::anyhow!("source_version_required"))?;
    let bytes = metadata
        .size
        .filter(|n| (1..=16 * 1024 * 1024).contains(n))
        .ok_or_else(|| anyhow::anyhow!("advanced_asset_bound"))?;
    if let Some(pin) = expected {
        anyhow::ensure!(etag == pin.etag && bytes == pin.bytes, "source_changed");
    }
    if head {
        return Ok((
            expected
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("advanced_asset_source_binding_required"))?,
            Vec::new(),
        ));
    }
    let content = read_body(response, bytes).await?;
    anyhow::ensure!(content.len() as u64 == bytes, "source_changed");
    let pin = HttpAssetPin {
        resource: logical.into(),
        etag,
        bytes,
        content_sha256: assets::asset_sha256(&content),
    };
    if let Some(expected) = expected {
        anyhow::ensure!(&pin == expected, "source_changed");
    }
    Ok((pin, content))
}
async fn source_pin(app: &App, id: Uuid, resource: &Value) -> anyhow::Result<HttpSourcePin> {
    let state = crate::http_identity::load(&app.db, id, remote_source(resource))
        .await
        .map_err(|(_, s)| anyhow::anyhow!(s))?
        .ok_or_else(|| anyhow::anyhow!("source_version_required"))?;
    anyhow::ensure!(
        !state.changed
            && state.class == Some(crate::http_identity::Class::Binary)
            && state.metadata.final_target_sha256.is_none(),
        "source_changed"
    );
    Ok(HttpSourcePin {
        etag: state
            .metadata
            .etag
            .filter(|v| crate::http_identity::strong_etag(v))
            .ok_or_else(|| anyhow::anyhow!("source_version_required"))?,
        bytes: state
            .metadata
            .size
            .filter(|n| (1..=2147483648).contains(n))
            .ok_or_else(|| anyhow::anyhow!("advanced_asset_bound"))?,
    })
}
fn discovery_allowed(resource: &Value) -> bool {
    // Provisional server probe tickets stay private. Once the session is
    // published, its browser-visible token must not reveal source URLs or
    // signed queries by re-running catalog discovery through /probe.
    resource.get("job_id").is_none()
        && resource.get("advanced_remote_assets").is_none()
        && matches!(
            resource["advanced_probe"].as_str(),
            Some("metadata_only" | "offer")
        )
}

fn prepare_probe_metadata(resource: &Value, meta: &mut Value) -> bool {
    if resource.get("job_id").is_some() || resource.get("advanced_remote_assets").is_some() {
        // Also scrub already-present cached evidence; skipping fresh reads
        // alone cannot protect a cache that contains a private association.
        if let Some(object) = meta.as_object_mut() {
            for key in [
                "advanced_assets",
                "advanced_remote_assets",
                "advanced_asset_association",
                "source_resource",
                "source_url",
                "headers",
                "root",
                "input_ticket",
            ] {
                object.remove(key);
            }
        }
        if let Some(format) = meta.get_mut("format").and_then(Value::as_object_mut) {
            for key in [
                "filename",
                "source_resource",
                "source_url",
                "advanced_asset_association",
            ] {
                format.remove(key);
            }
        }
        return false;
    }
    discovery_allowed(resource)
}

pub(crate) async fn discover(
    app: &App,
    id: Uuid,
    resource: &Value,
    q: &Params,
    observation: input_failure::Observation,
    meta: &mut Value,
) -> anyhow::Result<()> {
    if !prepare_probe_metadata(resource, meta) {
        return Ok(());
    }
    let work = async {
        let remote = if resource["kind"] == "agent" {
            if !agent_capable(app, resource).await? {
                return Ok(());
            }
            let mut selected = resource.clone();
            selected["advanced_asset_catalog"] = json!(true);
            let response = relay::fetch(
                app,
                &selected,
                &HeaderMap::new(),
                false,
                observation.clone(),
                Some(id),
            )
            .await
            .map_err(|(_, s)| anyhow::anyhow!(s))?;
            let bytes = axum::body::to_bytes(response.into_body(), 65536).await?;
            let catalog: AssetCatalog = serde_json::from_slice(&bytes)?;
            RemoteAssetCatalog {
                schema_version: 1,
                source_kind: "agent".into(),
                source_resource: remote_source(resource).into(),
                source_version: resource["source_version"].as_str().unwrap_or("").into(),
                catalog,
                source_http: None,
                http_files: Vec::new(),
            }
        } else if resource["kind"] == "http" {
            let Some(declaration) = resource
                .get("advanced_asset_association")
                .filter(|v| !v.is_null())
            else {
                return Ok(());
            };
            let association: HttpAssetAssociation = serde_json::from_value(declaration.clone())?;
            association.validate()?;
            let source_http = source_pin(app, id, resource).await?;
            let version = assets::source_http_version(remote_source(resource), &source_http)?;
            let mut catalog = AssetCatalog {
                schema_version: 2,
                source_resource: assets::HTTP_ASSET_SOURCE.into(),
                source_version: version.clone(),
                subtitles: Vec::new(),
                fonts: Vec::new(),
            };
            let mut http_files = Vec::new();
            let mut total = 0u64;
            for (logical, kind) in association.resources()? {
                let (pin, bytes) = http_file(resource, &logical, None, false).await?;
                total = total
                    .checked_add(pin.bytes)
                    .ok_or_else(|| anyhow::anyhow!("advanced_asset_bound"))?;
                anyhow::ensure!(total <= assets::MAX_ASSET_BYTES, "advanced_asset_bound");
                let file = AssetFile {
                    resource: logical,
                    source_version: format!("http-v1:{}", pin.content_sha256),
                    bytes: pin.bytes,
                };
                if let Some(kind) = kind {
                    assets::validate_subtitle_bytes(kind, &bytes)?;
                    catalog.subtitles.push(SubtitleAsset {
                        index: RemoteAssetCatalog::subtitle_index(kind),
                        kind,
                        file,
                    });
                } else {
                    anyhow::ensure!(
                        bytes
                            .get(..4)
                            .is_some_and(|b| matches!(b, b"\0\x01\0\0" | b"OTTO" | b"ttcf")),
                        "advanced_font_format_unsupported"
                    );
                    catalog.fonts.push(file);
                }
                http_files.push(pin);
            }
            RemoteAssetCatalog {
                schema_version: 1,
                source_kind: "http".into(),
                source_resource: remote_source(resource).into(),
                source_version: version,
                catalog,
                source_http: Some(source_http),
                http_files,
            }
        } else {
            return Ok(());
        };
        remote.validate(
            resource["kind"].as_str().unwrap_or(""),
            remote_source(resource),
            resource["source_version"].as_str(),
        )?;
        // Retain the complete association identity in both fresh candidate
        // evidence and eventual frozen job/session. No URL reaches the browser.
        meta["advanced_assets"] = serde_json::to_value(&remote.catalog)?;
        meta["advanced_remote_assets"] = serde_json::to_value(remote)?;
        Ok(())
    };
    let _ = q;
    tokio::select! {biased;_=observation.stopped()=>anyhow::bail!("input_cancelled"),r=tokio::time::timeout(Duration::from_secs(25),work)=>r?}
}
// Keep the exact request, execution observation and frozen resource explicit at this boundary.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn response(
    app: &App,
    id: Uuid,
    resource: &Value,
    q: &Params,
    h: &HeaderMap,
    head: bool,
    observation: input_failure::Observation,
    path: &str,
) -> Result<Response> {
    let number = path
        .strip_prefix("asset-")
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse::<usize>().ok())
        .ok_or_else(|| failure("advanced_asset_association_required"))?;
    if q.url.is_some() || !app.input_failures.authenticates(id, q.execution) {
        return Err((
            StatusCode::FORBIDDEN,
            "advanced_asset_custody_required".into(),
        ));
    }
    let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=$1 AND j.session_id=$1 AND j.status='running' AND j.lease_until>clock_timestamp() AND remote_asset_job_allowed(j.id))").bind(id).fetch_one(&app.db).await.map_err(failure)?;
    if !allowed {
        return Err((
            StatusCode::UNAUTHORIZED,
            "advanced_asset_custody_required".into(),
        ));
    }
    let remote: RemoteAssetCatalog =
        serde_json::from_value(resource["advanced_remote_assets"].clone()).map_err(failure)?;
    remote
        .validate(
            resource["kind"].as_str().unwrap_or(""),
            remote_source(resource),
            resource["source_version"].as_str(),
        )
        .map_err(failure)?;
    let file = remote
        .files()
        .get(number)
        .copied()
        .ok_or_else(|| failure("advanced_asset_association_required"))?
        .clone();
    if remote.source_kind == "agent" {
        if !agent_capable(app, resource).await.map_err(failure)? {
            return Err((
                StatusCode::CONFLICT,
                "advanced_asset_custody_required".into(),
            ));
        }
        let mut selected = resource.clone();
        selected["resource"] = json!(file.resource);
        selected["source_version"] = json!(file.source_version);
        selected["bound_asset_catalog"] = serde_json::to_value(&remote.catalog).map_err(failure)?;
        return relay::fetch(app, &selected, h, head, observation, Some(id)).await;
    }
    let source = source_pin(app, id, resource).await.map_err(failure)?;
    if Some(source) != remote.source_http {
        observation.source_changed();
        return Err((StatusCode::CONFLICT, "source_changed".into()));
    }
    let pin = remote
        .http_files
        .get(number)
        .ok_or_else(|| failure("advanced_asset_association_required"))?;
    let mut allowed = HeaderMap::new();
    allowed.insert(
        header::RANGE,
        format!("bytes=0-{}", file.bytes - 1)
            .parse()
            .map_err(failure)?,
    );
    if !head && h.get(header::RANGE) != allowed.get(header::RANGE) {
        return Err((
            StatusCode::BAD_REQUEST,
            "advanced_asset_finite_range_required".into(),
        ));
    }
    let work = http_file(resource, &file.resource, Some(pin), head);
    let (_, bytes) = tokio::select! {biased;_=observation.stopped()=>return Err(failure("input_cancelled")),r=tokio::time::timeout(Duration::from_secs(25),work)=>r.map_err(failure)?.map_err(|e|{observation.source_changed();failure(e)})?};
    Response::builder()
        .status(if head {
            StatusCode::OK
        } else {
            StatusCode::PARTIAL_CONTENT
        })
        .header(header::CONTENT_LENGTH, file.bytes.to_string())
        .header(
            header::CONTENT_RANGE,
            format!("bytes 0-{}/{}", file.bytes - 1, file.bytes),
        )
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(if head {
            Body::empty()
        } else {
            Body::from(bytes)
        })
        .map_err(failure)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[test]
    fn provisional_probe_retains_server_only_catalog_evidence() {
        let resource = json!({"kind":"http","advanced_probe":"metadata_only"});
        let mut metadata = json!({"advanced_remote_assets":{"source_resource":"https://owned.invalid/a.mkv?signed=query"},"advanced_assets":{"fonts":[]},"format":{"filename":"server-only probe input","duration":"10"},"streams":[]});
        let before = metadata.clone();
        assert!(prepare_probe_metadata(&resource, &mut metadata));
        assert_eq!(metadata, before);
    }
    #[test]
    fn published_sessions_do_not_rediscover_or_return_cached_private_asset_urls() {
        let provisional = json!({"kind":"http","advanced_probe":"metadata_only"});
        assert!(discovery_allowed(&provisional));
        for (key, value) in [
            ("job_id", json!(Uuid::new_v4())),
            (
                "advanced_remote_assets",
                json!({"source_resource":"https://owned.invalid/a.mkv?signed=query"}),
            ),
        ] {
            let mut published = provisional.clone();
            published[key] = value;
            assert!(!discovery_allowed(&published));
            let private = "https://owned.invalid/a.mkv?signed=query";
            let mut metadata = json!({"advanced_remote_assets":{"source_resource":private},"advanced_assets":{"fonts":[{"resource":private}]},"advanced_asset_association":{"fonts":["private.ttf"]},"source_url":private,"source_resource":private,"root":"private-root","headers":{"authorization":"fixture-sensitive"},"input_ticket":"private-ticket","format":{"filename":private,"duration":"10"},"streams":[{"index":0,"codec_name":"h264"}]});
            assert!(!prepare_probe_metadata(&published, &mut metadata));
            let serialized = serde_json::to_string(&metadata).unwrap();
            for secret in [
                private,
                "private.ttf",
                "private-root",
                "fixture-sensitive",
                "private-ticket",
            ] {
                assert!(!serialized.contains(secret));
            }
            assert_eq!(metadata["format"]["duration"], "10");
            assert_eq!(metadata["streams"][0]["codec_name"], "h264");
        }
        assert!(!discovery_allowed(
            &json!({"kind":"http","advanced_probe":"legacy"})
        ));
    }
    async fn fixture(reply: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                loop {
                    let mut bytes = [0; 1024];
                    let n = socket.read(&mut bytes).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&bytes[..n]);
                    if buf.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                assert!(String::from_utf8_lossy(&buf).contains("/a.ass"));
                let _ = socket.write_all(&reply).await;
            }
        });
        (format!("http://{address}/a.mkv"), task)
    }
    #[tokio::test]
    async fn http_asset_bytes_are_complete_strong_and_digest_bound() {
        let body = b"[Script Info]\n[Events]\nFormat: Layer, Text\n";
        let mut reply=format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"owned-1\"\r\nConnection: close\r\n\r\n",body.len()).into_bytes();
        reply.extend_from_slice(body);
        let (url, task) = fixture(reply).await;
        let resource = json!({"kind":"http","url":url,"source_url":url,"headers":{}});
        let (pin, bytes) = http_file(&resource, "http-source.ass", None, false)
            .await
            .unwrap();
        assert_eq!(bytes, body);
        assert_eq!(pin.content_sha256, assets::asset_sha256(body));
        assert!(
            http_file(&resource, "http-source.ass", Some(&pin), false)
                .await
                .is_ok()
        );
        let mut changed = pin.clone();
        changed.etag = "\"different\"".into();
        assert!(
            http_file(&resource, "http-source.ass", Some(&changed), false)
                .await
                .is_err()
        );
        changed = pin;
        changed.content_sha256 = "0".repeat(64);
        assert!(
            http_file(&resource, "http-source.ass", Some(&changed), false)
                .await
                .is_err()
        );
        task.abort();
    }
    #[tokio::test]
    async fn weak_duplicate_encoded_redirected_or_incomplete_assets_fail_closed() {
        for reply in[
   b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nETag: W/\"weak\"\r\nConnection: close\r\n\r\nfont".to_vec(),
   b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nETag: \"a\"\r\nETag: \"b\"\r\nConnection: close\r\n\r\nfont".to_vec(),
   b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nETag: \"a\"\r\nContent-Encoding: gzip\r\nConnection: close\r\n\r\nfont".to_vec(),
   b"HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: https://foreign.invalid/a.ass\r\nConnection: close\r\n\r\n".to_vec(),
   b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nETag: \"a\"\r\nConnection: close\r\n\r\nfont".to_vec(),
  ]{let(url,task)=fixture(reply).await;let resource=json!({"kind":"http","url":url,"source_url":url,"headers":{}});assert!(http_file(&resource,"http-source.ass",None,false).await.is_err());task.abort();}
    }
}
