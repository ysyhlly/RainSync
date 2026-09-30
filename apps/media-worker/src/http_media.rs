//! Typed, depth-bounded HLS grants and content-based primary HTTP delivery.
use super::*;
use preview_input::{
    hls_manifest::{self, Kind, Manifest},
    http_delivery,
};
use std::collections::HashMap;

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
        let url = providers::validate_url(target.join(reference.uri)?.as_str())?;
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
