//! Typed, depth-bounded HLS grants and content-based primary HTTP delivery.
use super::*;
use preview_input::{
    hls_manifest::{self, Kind, Manifest},
    http_delivery,
};
use std::collections::HashMap;

#[cfg(test)]
#[path = "http_identity_tests.rs"]
mod identity_tests;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Ticket {
    version: u8,
    session: Uuid,
    source: Option<Uuid>,
    url: String,
    kind: String,
    depth: u8,
    policy_revision: i64,
}
fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Playlist => "playlist",
        Kind::Segment => "segment",
        Kind::Initialization => "initialization",
        Kind::Key => "key",
        Kind::Data => "data",
    }
}
fn parse_kind(kind: &str) -> anyhow::Result<Kind> {
    Ok(match kind {
        "playlist" => Kind::Playlist,
        "segment" => Kind::Segment,
        "initialization" => Kind::Initialization,
        "key" => Kind::Key,
        "data" => Kind::Data,
        _ => anyhow::bail!("invalid_resource_kind"),
    })
}
fn target(
    app: &App,
    id: Uuid,
    resource: &Value,
    q: &Params,
) -> anyhow::Result<(url::Url, Option<Kind>, u8)> {
    let original = providers::validate_url(resource["url"].as_str().unwrap_or(""))?;
    let Some(encoded) = q.url.as_deref() else {
        return Ok((original, None, 0));
    };
    anyhow::ensure!(encoded.len() <= 32768, "invalid_resource_signature");
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded)?;
    anyhow::ensure!(bytes.len() >= 12, "invalid_resource_signature");
    let plain = app
        .key
        .decrypt(bytes[..12].into(), &bytes[12..])
        .map_err(|_| anyhow::anyhow!("invalid_resource_signature"))?;
    let grant: Ticket = serde_json::from_slice(&plain)?;
    anyhow::ensure!(
        grant.version == 1
            && grant.session == id
            && grant.depth > 0
            && grant.depth <= hls_manifest::MAX_DEPTH
            && grant.policy_revision == resource["source_policy_revision"].as_i64().unwrap_or(0),
        "stale_resource_policy"
    );
    anyhow::ensure!(
        grant.source
            == resource["source_id"]
                .as_str()
                .and_then(|v| Uuid::parse_str(v).ok()),
        "wrong_resource_source"
    );
    let url = providers::validate_url(&grant.url)?;
    let config = providers::resource_config(resource)?;
    providers::access_policy::SourceAccess::new(&config.url, config.access_policy.as_ref())?
        .authorize_url(url.as_str())?;
    Ok((url, Some(parse_kind(&grant.kind)?), grant.depth))
}
fn rewrite(
    app: &App,
    id: Uuid,
    resource: &Value,
    q: &Params,
    target: &url::Url,
    depth: u8,
    text: &str,
) -> anyhow::Result<String> {
    anyhow::ensure!(depth < hls_manifest::MAX_DEPTH, "manifest_depth_limit");
    let manifest = Manifest::parse(text)?;
    // A repeated URI remains identical for implicit BYTERANGE offsets. Mixed
    // key/media aliases fail before returning any partially rewritten body.
    let mut granted: HashMap<String, (Kind, String)> = HashMap::new();
    manifest.rewrite(|reference| {
        let mut url = providers::validate_url(target.join(reference.uri)?.as_str())?;
        if resource["kind"] == "http" {
            url.set_fragment(None);
        }
        let config = providers::resource_config(resource)?;
        providers::access_policy::SourceAccess::new(&config.url, config.access_policy.as_ref())?
            .authorize_url(url.as_str())?;
        if let Some((kind, uri)) = granted.get(url.as_str()) {
            anyhow::ensure!(
                (*kind == Kind::Key) == (reference.kind == Kind::Key),
                "ambiguous_resource_kind"
            );
            if *kind == reference.kind {
                return Ok(uri.clone());
            }
            // Playlist/non-playlist aliases also fail instead of depending on order.
            anyhow::ensure!(
                *kind != Kind::Playlist && reference.kind != Kind::Playlist,
                "ambiguous_resource_kind"
            );
            return Ok(uri.clone());
        }
        let grant = Ticket {
            version: 1,
            session: id,
            source: resource["source_id"]
                .as_str()
                .and_then(|v| Uuid::parse_str(v).ok()),
            url: url.to_string(),
            kind: kind_name(reference.kind).into(),
            depth: depth + 1,
            policy_revision: resource["source_policy_revision"].as_i64().unwrap_or(0),
        };
        let nonce = Uuid::new_v4();
        let nonce = &nonce.as_bytes()[..12];
        let cipher = app
            .key
            .encrypt(nonce.into(), serde_json::to_vec(&grant)?.as_slice())
            .map_err(|_| anyhow::anyhow!("resource_grant_failed"))?;
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode([nonce.to_vec(), cipher].concat());
        let extension = match reference.kind {
            Kind::Playlist => "m3u8",
            Kind::Key => "key",
            Kind::Data => anyhow::bail!("unsupported_manifest_data"),
            Kind::Initialization => "mp4",
            Kind::Segment => url
                .path()
                .rsplit_once('.')
                .map(|(_, ext)| ext)
                .filter(|ext| {
                    matches!(
                        *ext,
                        "ts" | "m4s" | "mp4" | "aac" | "m4a" | "mp3" | "ac3" | "vtt" | "webvtt"
                    )
                })
                .unwrap_or("ts"),
        };
        let execution = q
            .execution
            .map(|v| format!("&execution={v}"))
            .unwrap_or_default();
        let uri = format!(
            "/media-delivery/{id}/segment.{extension}?token={}&url={encoded}{execution}",
            q.token
        );
        granted.insert(url.to_string(), (reference.kind, uri.clone()));
        Ok(uri)
    })
}

pub async fn response(
    app: &App,
    id: Uuid,
    resource: &Value,
    q: &Params,
    h: &HeaderMap,
    head: bool,
    input_failure: input_failure::Observation,
) -> Result<Response> {
    // Only header/prefix/manifest/key preparation is bounded here. A produced
    // media body remains streaming under the existing independent owner guard.
    match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        prepare(app, id, resource, q, h, head, input_failure.clone()),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            input_failure.transient();
            Err(failure("upstream_prepare_timeout"))
        }
    }
}

async fn prepare(
    app: &App,
    id: Uuid,
    resource: &Value,
    q: &Params,
    h: &HeaderMap,
    head: bool,
    input_failure: input_failure::Observation,
) -> Result<Response> {
    if resource["kind"] == "http" {
        return prepare_pinned(app, id, resource, q, h, head, input_failure).await;
    }
    let (target, kind, depth) = target(app, id, resource, q)
        .map_err(|_| (StatusCode::FORBIDDEN, "invalid_resource_signature".into()))?;
    let config = providers::resource_config(resource).map_err(failure)?;
    let mut request = tokio::select! {biased;
        _=input_failure.stopped()=>return Err(failure("input_cancelled")),
        result=providers::source_request(&config,target.as_str(),if head {reqwest::Method::HEAD}else{reqwest::Method::GET},&config.headers)=>result.map_err(failure)?,
    };
    // Without a reliable pinned validator, If-Range safely yields the full body.
    if !head
        && !matches!(kind, Some(Kind::Key | Kind::Playlist))
        && !target.path().ends_with(".m3u8")
        && !(kind.is_none() && q.execution.is_some())
        && !h.contains_key(header::IF_RANGE)
        && h.get_all(header::RANGE).iter().count() == 1
        && let Some(range) = h.get(header::RANGE)
    {
        request = request.header(header::RANGE, range)
    }
    let response = tokio::select! {biased;_=input_failure.stopped()=>return Err(failure("input_cancelled")),result=request.send()=>result.map_err(|e|{input_failure.network(&e);failure(e)})?};
    let status = response.status();
    input_failure.status(status);
    http_delivery::validate_range_response(status, response.headers()).map_err(failure)?;
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        let mut out = Response::builder()
            .status(status)
            .header(header::CACHE_CONTROL, "private, no-store");
        if let Some(v) = response.headers().get(header::CONTENT_RANGE) {
            out = out.header(header::CONTENT_RANGE, v)
        }
        return out.body(Body::empty()).map_err(failure);
    }
    if !status.is_success() {
        return Err((status, "upstream_media_error".into()));
    }
    let headers = response.headers().clone();
    let declared = kind == Some(Kind::Playlist)
        || target.path().ends_with(".m3u8")
        || headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|s| s.contains("mpegurl"));
    if kind == Some(Kind::Key)
        && (declared
            || headers
                .get(header::CONTENT_LENGTH)
                .is_some_and(|v| v.to_str().ok().and_then(|v| v.parse::<usize>().ok()) != Some(16)))
    {
        return Err(failure("invalid_hls_key"));
    }
    if head {
        let mut out = Response::builder()
            .status(status)
            .header(header::CACHE_CONTROL, "private, no-store");
        if declared {
            out = out.header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
        } else {
            for name in [
                header::CONTENT_TYPE,
                header::CONTENT_LENGTH,
                header::ACCEPT_RANGES,
            ] {
                if let Some(v) = headers.get(&name) {
                    out = out.header(name, v)
                }
            }
        }
        return out.body(Body::empty()).map_err(failure);
    }
    let mut stream = response.bytes_stream();
    if kind == Some(Kind::Key) {
        let mut key = Vec::with_capacity(16);
        loop {
            let next = tokio::select! {biased;_=input_failure.stopped()=>return Err(failure("input_cancelled")), next=stream.next()=>next};
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(failure)?;
            if key.len() + chunk.len() > 16 {
                return Err(failure("invalid_hls_key"));
            }
            key.extend_from_slice(&chunk);
        }
        if key.len() != 16 {
            return Err(failure("invalid_hls_key"));
        }
        return Ok((
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CACHE_CONTROL, "private, no-store"),
            ],
            key,
        )
            .into_response());
    }

    let mut prefix = Vec::new();
    let mut chunks = Vec::new();
    if kind != Some(Kind::Key) {
        while prefix.len() < http_delivery::SNIFF_BYTES {
            let Some(chunk) = (tokio::select! {biased;_=input_failure.stopped()=>return Err(failure("input_cancelled")), next=stream.next()=>next})
            else {
                break;
            };
            let chunk = chunk.map_err(|e| {
                input_failure.network(&e);
                failure(e)
            })?;
            prefix.extend_from_slice(
                &chunk[..chunk.len().min(http_delivery::SNIFF_BYTES - prefix.len())],
            );
            chunks.push(chunk);
        }
    }
    let sniffed = if kind == Some(Kind::Key) {
        false
    } else {
        http_delivery::hls_prefix(&prefix).map_err(|e| {
            input_failure.permanent();
            failure(e)
        })?
    };
    if declared || sniffed {
        if kind == Some(Kind::Key) {
            return Err(failure("invalid_key_manifest"));
        }
        let mut bytes = Vec::new();
        for chunk in chunks {
            bytes.extend_from_slice(&chunk)
        }
        if bytes.len() > hls_manifest::MAX_BYTES {
            return Err(failure("manifest_too_large"));
        }
        while let Some(chunk) = tokio::select! {biased;_=input_failure.stopped()=>return Err(failure("input_cancelled")), next=stream.next()=>next}
        {
            bytes.extend_from_slice(&chunk.map_err(|e| {
                input_failure.network(&e);
                failure(e)
            })?);
            if bytes.len() > hls_manifest::MAX_BYTES {
                return Err(failure("manifest_too_large"));
            }
        }
        let text = String::from_utf8(bytes).map_err(failure)?;
        let text = rewrite(app, id, resource, q, &target, depth, &text).map_err(|e| {
            input_failure.permanent();
            failure(e)
        })?;
        return Ok((
            [
                (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                (header::CACHE_CONTROL, "private, no-store"),
            ],
            text,
        )
            .into_response());
    }
    let mut out = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "private, no-store");
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(v) = headers.get(&name) {
            out = out.header(name, v)
        }
    }
    let combined = futures_util::stream::iter(chunks.into_iter().map(Ok))
        .chain(stream)
        .map(move |chunk| {
            if let Err(e) = &chunk {
                input_failure.network(e)
            }
            chunk
        });
    out.body(Body::from_stream(combined)).map_err(failure)
}

/// Generic HTTP resources have durable per-grant pins. Jellyfin/Emby retain
/// their provider-owned session contracts in the path above.
async fn prepare_pinned(
    app: &App,
    id: Uuid,
    resource: &Value,
    q: &Params,
    h: &HeaderMap,
    head: bool,
    observation: input_failure::Observation,
) -> Result<Response> {
    use crate::http_identity::{self as identity, Class, Metadata, Range};
    let (mut target, kind, depth) = target(app, id, resource, q)
        .map_err(|_| (StatusCode::FORBIDDEN, "invalid_resource_signature".into()))?;
    target.set_fragment(None);
    let config = providers::resource_config(resource).map_err(failure)?;
    let mut previous = identity::load(&app.db, id, target.as_str()).await?;
    let mut declared = kind == Some(Kind::Playlist)
        || target.path().ends_with(".m3u8")
        || previous
            .as_ref()
            .is_some_and(|state| state.class == Some(Class::Playlist));
    let mut range = (!head && !declared && kind != Some(Kind::Key))
        .then(|| Range::read(h))
        .flatten();
    // A client validator does not establish the grant's identity. Before a pin
    // exists, If-Range falls back to a whole response; after pinning it must
    // exactly match the strong validator we exposed for that representation.
    if h.contains_key(header::IF_RANGE)
        && !previous
            .as_ref()
            .is_some_and(|state| state.metadata.if_range_matches(h))
    {
        range = None;
    }
    if range.is_some() && previous.as_ref().is_none_or(|state| state.class.is_none()) {
        // Classify from byte zero, even for an initial suffix/tail request. This
        // preserves the decoder manifest boundary while enabling later seeks.
        let response = pinned_request(
            &config,
            &target,
            previous.as_ref(),
            false,
            Some("bytes=0-1023"),
            &observation,
        )
        .await?;
        let status = response.status();
        if status == StatusCode::PRECONDITION_FAILED {
            observation.source_changed();
            return identity::invalidate(&app.db, id)
                .await
                .and_then(|_| Err(identity::changed()));
        }
        if !status.is_success() && status != StatusCode::RANGE_NOT_SATISFIABLE {
            return Err((status, "upstream_media_error".into()));
        }
        let metadata = Metadata::read(status, response.headers()).map_err(failure)?;
        if metadata.size.is_none() {
            observation.source_version_required();
            return Err(identity::required());
        }
        Range::From(0, Some(1023))
            .validate(status, response.headers())
            .map_err(failure)?;
        declared |= playlist_headers(response.headers());
        let mut stream = response.bytes_stream();
        let mut prefix = Vec::new();
        if status != StatusCode::RANGE_NOT_SATISFIABLE {
            while prefix.len() < http_delivery::SNIFF_BYTES {
                let next = tokio::select! {biased;
                    _=observation.stopped()=>return Err(failure("input_cancelled")),
                    next=stream.next()=>next,
                };
                let Some(chunk) = next else { break };
                let chunk = chunk.map_err(|error| {
                    observation.network(&error);
                    failure(error)
                })?;
                prefix.extend_from_slice(
                    &chunk[..chunk.len().min(http_delivery::SNIFF_BYTES - prefix.len())],
                );
            }
        }
        drop(stream);
        if !prefix.is_empty() {
            declared |= http_delivery::hls_prefix(&prefix).map_err(failure)?;
        } else if metadata.size != Some(0) {
            return Err(failure("upstream_empty_prefix"));
        }
        let class = if declared {
            Class::Playlist
        } else {
            Class::Binary
        };
        previous = Some(identity_result(
            identity::commit(
                &app.db,
                id,
                target.as_str(),
                &metadata,
                Some(class),
                false,
                true,
            )
            .await,
            &observation,
        )?);
        if declared {
            range = None;
        }
    }
    let range_text = range
        .and_then(|_| h.get(header::RANGE))
        .and_then(|value| value.to_str().ok());
    let response = pinned_request(
        &config,
        &target,
        previous.as_ref(),
        head,
        range_text,
        &observation,
    )
    .await?;
    let status = response.status();
    if status == StatusCode::PRECONDITION_FAILED {
        observation.source_changed();
        return identity::invalidate(&app.db, id)
            .await
            .and_then(|_| Err(identity::changed()));
    }
    let headers = response.headers().clone();
    if !status.is_success() && status != StatusCode::RANGE_NOT_SATISFIABLE {
        return Err((status, "upstream_media_error".into()));
    }
    let metadata = Metadata::read(status, &headers).map_err(failure)?;
    if let Some(range) = range {
        range.validate(status, &headers).map_err(failure)?;
    } else if status == StatusCode::PARTIAL_CONTENT {
        return Err(failure("unsolicited_upstream_range"));
    }
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        if previous
            .as_ref()
            .is_some_and(|state| state.metadata.conflicts_with_partial(&metadata))
        {
            observation.source_changed();
            return identity::invalidate(&app.db, id)
                .await
                .and_then(|_| Err(identity::changed()));
        }
        if range.is_none() {
            return Err(failure("unsolicited_upstream_range"));
        }
        return Response::builder()
            .status(status)
            .header(
                header::CONTENT_RANGE,
                headers[header::CONTENT_RANGE].clone(),
            )
            .header(header::CONTENT_LENGTH, 0)
            .header(header::CACHE_CONTROL, "private, no-store")
            .body(Body::empty())
            .map_err(failure);
    }
    // Commit headers before any bytes can escape. This also detects an origin
    // that ignores If-Match and returns a changed 200 or 206 representation.
    let admitted = identity_result(
        if head {
            identity::head(&app.db, id, target.as_str(), &metadata).await
        } else {
            identity::commit(
                &app.db,
                id,
                target.as_str(),
                &metadata,
                None,
                false,
                !head && (range.is_some() || q.execution.is_some()),
            )
            .await
        },
        &observation,
    )?;
    if range.is_some() && status == StatusCode::OK && q.execution.is_some() {
        observation.source_seek_unsupported();
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "source_seek_unsupported".into(),
        ));
    }
    declared |= playlist_headers(&headers);
    if kind == Some(Kind::Key) && (declared || metadata.size.is_some_and(|size| size != 16)) {
        return Err(failure("invalid_hls_key"));
    }
    if head {
        // An unclassified HEAD may be an extensionless playlist. Omit fields
        // that would describe its original bytes rather than rewritten output.
        return pinned_headers(
            status,
            &headers,
            &admitted.metadata,
            declared,
            previous.as_ref().and_then(|state| state.class).is_some(),
        )
        .body(Body::empty())
        .map_err(failure);
    }
    let expected_length = if let Some(http_delivery::ContentRange::Partial { start, end, .. }) =
        http_delivery::validate_range_response(status, &headers).map_err(failure)?
    {
        Some(end - start + 1)
    } else {
        headers
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
    };
    let mut stream = counted_stream(
        response.bytes_stream(),
        expected_length,
        observation.clone(),
    );
    let mut chunks = Vec::new();
    let mut prefix = Vec::new();
    let starts_at_zero = status != StatusCode::PARTIAL_CONTENT
        || matches!(
            http_delivery::validate_range_response(status, &headers).map_err(failure)?,
            Some(http_delivery::ContentRange::Partial { start: 0, .. })
        );
    if kind != Some(Kind::Key) && starts_at_zero && metadata.size != Some(0) {
        while prefix.len() < http_delivery::SNIFF_BYTES {
            let Some(chunk) = stream.next().await else {
                break;
            };
            let chunk = chunk.map_err(failure)?;
            prefix.extend_from_slice(
                &chunk[..chunk.len().min(http_delivery::SNIFF_BYTES - prefix.len())],
            );
            chunks.push(chunk);
        }
        declared |= http_delivery::hls_prefix(&prefix).map_err(|error| {
            observation.permanent();
            failure(error)
        })?;
    }
    if declared && status == StatusCode::PARTIAL_CONTENT {
        // The preflight should already have classified playlists. Never parse
        // or rewrite a partial manifest as a whole representation.
        observation.source_changed();
        return identity::invalidate(&app.db, id)
            .await
            .and_then(|_| Err(identity::changed()));
    }
    let class = if declared {
        Class::Playlist
    } else if kind == Some(Kind::Key) {
        Class::Key
    } else {
        Class::Binary
    };
    if declared || kind == Some(Kind::Key) {
        let limit = if declared {
            hls_manifest::MAX_BYTES
        } else {
            16
        };
        let mut bytes = Vec::new();
        for chunk in chunks {
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() > limit {
            return Err(failure("upstream_body_limit"));
        }
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(failure)?;
            if chunk.len() > limit - bytes.len() {
                return Err(failure("upstream_body_limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let bytes = if declared {
            let text = String::from_utf8(bytes).map_err(failure)?;
            rewrite(app, id, resource, q, &target, depth, &text)
                .map_err(failure)?
                .into_bytes()
        } else {
            if bytes.len() != 16 {
                return Err(failure("invalid_hls_key"));
            }
            bytes
        };
        identity_result(
            identity::commit(
                &app.db,
                id,
                target.as_str(),
                &metadata,
                Some(class),
                true,
                q.execution.is_some(),
            )
            .await,
            &observation,
        )?;
        let mut out = Response::builder()
            .status(StatusCode::OK)
            .header(header::CACHE_CONTROL, "private, no-store")
            .header(
                header::CONTENT_TYPE,
                if declared {
                    "application/vnd.apple.mpegurl"
                } else {
                    "application/octet-stream"
                },
            );
        // Upstream validators never describe the rewritten manifest bytes.
        if !declared && metadata.reliable() {
            for name in [header::ETAG, header::LAST_MODIFIED] {
                if let Some(value) = headers.get(&name) {
                    out = out.header(name, value);
                }
            }
        }
        return out.body(Body::from(bytes)).map_err(failure);
    }
    identity_result(
        identity::commit(
            &app.db,
            id,
            target.as_str(),
            &metadata,
            Some(class),
            true,
            range.is_some() || q.execution.is_some(),
        )
        .await,
        &observation,
    )?;
    let combined = futures_util::stream::iter(chunks.into_iter().map(Ok)).chain(stream);
    pinned_headers(status, &headers, &metadata, false, true)
        .body(Body::from_stream(combined))
        .map_err(failure)
}

fn playlist_headers(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("mpegurl"))
}

fn identity_result<T>(result: Result<T>, observation: &input_failure::Observation) -> Result<T> {
    result.inspect_err(|error| {
        if error.1 == "source_changed" {
            observation.source_changed();
        }
        if error.1 == "source_version_required" {
            observation.source_version_required();
        }
    })
}

async fn pinned_request(
    config: &providers::SourceConfig,
    target: &url::Url,
    previous: Option<&crate::http_identity::State>,
    head: bool,
    range: Option<&str>,
    observation: &input_failure::Observation,
) -> Result<reqwest::Response> {
    // Source configuration may contain old conditional headers. Only this
    // grant's validator and range may control the selected representation.
    let headers = config
        .headers
        .iter()
        .filter(|(name, _)| {
            !matches!(
                name.to_ascii_lowercase().as_str(),
                "range"
                    | "if-range"
                    | "if-match"
                    | "if-none-match"
                    | "if-modified-since"
                    | "if-unmodified-since"
                    | "accept-encoding"
            )
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let mut request = tokio::select! {biased;
        _=observation.stopped()=>return Err(failure("input_cancelled")),
        request=providers::source_request(config,target.as_str(),if head {reqwest::Method::HEAD}else{reqwest::Method::GET},&headers)=>request.map_err(failure)?,
    }.header(header::ACCEPT_ENCODING, "identity");
    if let Some(range) = range {
        request = request.header(header::RANGE, range);
    }
    if let Some(previous) = previous {
        request = previous.metadata.condition(request, range.is_some());
    }
    let response = tokio::select! {biased;
        _=observation.stopped()=>return Err(failure("input_cancelled")),
        response=request.send()=>response.map_err(|error| { observation.network(&error); failure(error) })?,
    };
    observation.status(response.status());
    Ok(response)
}

fn pinned_headers(
    status: StatusCode,
    headers: &HeaderMap,
    metadata: &crate::http_identity::Metadata,
    playlist: bool,
    classified: bool,
) -> axum::http::response::Builder {
    let mut out = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "private, no-store");
    if playlist {
        return out.header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl");
    }
    if let Some(value) = headers.get(header::CONTENT_TYPE) {
        out = out.header(header::CONTENT_TYPE, value);
    }
    if classified {
        for name in [header::CONTENT_LENGTH, header::CONTENT_RANGE] {
            if let Some(value) = headers.get(&name) {
                out = out.header(name, value);
            }
        }
        if metadata.reliable() {
            for name in [header::ETAG, header::LAST_MODIFIED, header::ACCEPT_RANGES] {
                if let Some(value) = headers.get(&name) {
                    out = out.header(name, value);
                }
            }
        } else {
            out = out.header(header::ACCEPT_RANGES, "none");
        }
    }
    out
}

/// Count actual bytes even for chunked 206 responses. Truncation/overflow ends
/// the body rather than silently completing an apparently valid range.
fn counted_stream<S>(
    source: S,
    expected: Option<u64>,
    observation: input_failure::Observation,
) -> impl futures_util::Stream<Item = std::io::Result<axum::body::Bytes>> + Send + Unpin
where
    S: futures_util::Stream<Item = std::result::Result<axum::body::Bytes, reqwest::Error>>
        + Send
        + 'static,
{
    Box::pin(
        futures_util::stream::unfold(
            (Box::pin(source), expected, 0_u64, false, observation),
            |(mut source, expected, count, done, observation)| async move {
                if done {
                    return None;
                }
                let next = tokio::select! {biased;
                    _=observation.stopped()=>return None,
                    next=source.next()=>next,
                };
                let result = match next {
                    Some(Ok(bytes)) => match count.checked_add(bytes.len() as u64) {
                        Some(next) if expected.is_none_or(|expected| next <= expected) => {
                            return Some((Ok(bytes), (source, expected, next, false, observation)));
                        }
                        _ => Err(std::io::Error::other("upstream_body_length_mismatch")),
                    },
                    Some(Err(error)) => {
                        observation.network(&error);
                        Err(std::io::Error::other(error))
                    }
                    None if expected.is_some_and(|expected| count != expected) => {
                        Err(std::io::Error::other("upstream_body_length_mismatch"))
                    }
                    None => return None,
                };
                observation.transient();
                Some((result, (source, expected, count, true, observation)))
            },
        )
        .fuse(),
    )
}
