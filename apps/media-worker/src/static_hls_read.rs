//! Serve only the original published parent's sealed resources. The relative
//! manifest names retain this session/token prefix without rewriting its bytes.
use super::{App, Result, metric_stream, playback_access};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::Response,
};
use media_core::{
    runtime_metrics::{Cache, Layer},
    static_hls::{ReadMethod, ReadRange, ReadResource},
};
use uuid::Uuid;

pub(super) async fn endpoint(
    State(app): State<App>,
    Path((id, token, path)): Path<(Uuid, String, String)>,
    headers: HeaderMap,
    method: Method,
) -> Result<Response> {
    if token.len() != 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err((StatusCode::UNAUTHORIZED, "invalid_playback_session".into()));
    }
    let resource = resource_key(&path)?;
    let head = method == Method::HEAD;
    let range = if head { None } else { parse_range(&headers)? };
    let pool = app.db.clone();
    let registry = app.deliveries.clone();
    let cancelled = app.input_failures.observe(id, None);
    let token_hash = super::hash(&token);
    let prepare_hash = token_hash.clone();
    let metrics = app.metrics.clone();
    let response = playback_access::protect_static_hls(
        move |_| prepare(app, id, prepare_hash, resource, headers, head, range),
        pool,
        id,
        token_hash,
        registry,
        cancelled,
        !head && path == "index.m3u8",
    )
    .await?;
    if head || !response.status().is_success() {
        return Ok(response);
    }
    let length = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let (parts, body) = response.into_parts();
    let measured = metric_stream::wrap(
        body.into_data_stream(),
        &metrics,
        Layer::WorkerEgress,
        Cache::NotHit,
    )
    .with_body_length(length);
    Ok(Response::from_parts(parts, Body::from_stream(measured)))
}

async fn prepare(
    app: App,
    id: Uuid,
    token_hash: String,
    resource: ReadResource,
    headers: HeaderMap,
    head: bool,
    range: Option<ReadRange>,
) -> Result<Response> {
    let loaded = persistence::static_hls_pending::load_published_parent(
        &app.db,
        id,
        &token_hash,
        |cipher| super::static_hls_operation::open_storage(&app, cipher),
    )
    .await
    .map_err(unavailable)?
    .ok_or((StatusCode::UNAUTHORIZED, "invalid_playback_session".into()))?;
    let mut lease = app
        .static_hls_operations
        .read_original(
            &loaded.input,
            resource,
            if head {
                ReadMethod::Head
            } else {
                ReadMethod::Get
            },
            None,
        )
        .await
        .map_err(|error| {
            #[cfg(all(test, target_os = "linux"))]
            if std::env::var("RAINSYNC_OWNED_TEST_RUN_ID").is_ok_and(|id| Uuid::parse_str(&id).is_ok()) {
                let _=std::fs::write(app.cache.join(format!("public-read-resource-failure-{}.json",Uuid::new_v4())),
                    serde_json::to_vec_pretty(&serde_json::json!({"operation":loaded.input.identity_statement().operation_id,
                        "error":format!("{error:#}")})).unwrap_or_default());
            }
            read_error(error)
        })?;
    let total = lease.total_bytes();
    let etag = lease.strong_etag().to_owned();
    if let Some(range) = range.filter(|_| if_range_matches(&headers, &etag)) {
        if !satisfiable(range, total) {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::ETAG, etag)
                .header(header::CACHE_CONTROL, "private, no-store")
                .header(header::CONTENT_LENGTH, "0")
                .body(Body::empty())
                .map_err(unavailable);
        }
        lease.select_range(range).map_err(read_error)?;
    }
    let mut response = Response::builder()
        .status(if lease.is_partial() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(
            header::CONTENT_TYPE,
            if matches!(resource, ReadResource::Manifest) {
                "application/vnd.apple.mpegurl"
            } else {
                "video/mp4"
            },
        )
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, etag)
        .header(header::CONTENT_LENGTH, lease.content_length().to_string());
    if lease.is_partial() {
        response = response.header(
            header::CONTENT_RANGE,
            format!(
                "bytes {}-{}/{total}",
                lease.first_byte(),
                lease.first_byte() + lease.content_length() - 1
            ),
        );
    }
    let body = if head {
        drop(lease);
        Body::empty()
    } else {
        Body::from_stream(futures_util::stream::try_unfold(
            lease,
            |mut lease| async move {
                lease
                    .chunk()
                    .await
                    .map(|chunk| chunk.map(|bytes| (bytes, lease)))
                    .map_err(|_| std::io::Error::other("static_hls_read_failed"))
            },
        ))
    };
    response.body(body).map_err(unavailable)
}

fn resource_key(path: &str) -> Result<ReadResource> {
    match path {
        "index.m3u8" => Ok(ReadResource::Manifest),
        "init.mp4" => Ok(ReadResource::Init),
        _ if path.len() == 8 && path.starts_with('s') && path.ends_with(".m4s") => {
            let index = path[1..4]
                .parse::<usize>()
                .ok()
                .filter(|index| *index < 64 && path == format!("s{index:03}.m4s"));
            index.map(ReadResource::Segment).ok_or((
                StatusCode::BAD_REQUEST,
                "invalid_static_hls_resource".into(),
            ))
        }
        _ => Err((
            StatusCode::BAD_REQUEST,
            "invalid_static_hls_resource".into(),
        )),
    }
}

fn parse_range(headers: &HeaderMap) -> Result<Option<ReadRange>> {
    super::static_hls_range::parse(headers)
        .map_err(|()| (StatusCode::BAD_REQUEST, "invalid_static_hls_range".into()))
}

fn satisfiable(range: ReadRange, total: usize) -> bool {
    match range {
        ReadRange::From(first) | ReadRange::Inclusive { first, .. } => first < total,
        ReadRange::Suffix(length) => length > 0 && total > 0,
    }
}

fn if_range_matches(headers: &HeaderMap, etag: &str) -> bool {
    let mut values = headers.get_all(header::IF_RANGE).iter();
    let Some(value) = values.next() else {
        return true;
    };
    values.next().is_none() && value.to_str().is_ok_and(|value| value == etag)
}

fn unavailable(_: impl std::fmt::Display) -> (StatusCode, String) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "static_hls_unavailable".into(),
    )
}

fn read_error(error: anyhow::Error) -> (StatusCode, String) {
    match error.to_string().as_str() {
        "static_hls_read_busy" => (StatusCode::TOO_MANY_REQUESTS, "static_hls_read_busy".into()),
        "static_hls_resource_missing" => {
            (StatusCode::NOT_FOUND, "static_hls_resource_missing".into())
        }
        _ => unavailable(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_range_errors_keep_the_parent_status_and_code() {
        let expected = (StatusCode::BAD_REQUEST, "invalid_static_hls_range".into());
        for value in [
            "",
            "bytes=",
            "bytes=-",
            "bytes=9-3",
            "bytes=0-2,4-8",
            "bytes=+1-2",
            "bytes=--5",
            "bytes=1-18446744073709551616",
            "items=0-2",
            "bytes =0-2",
            "bytes=0 -2",
            "bytes=0- 2",
            "Bytes=0-2",
            "bytes=０-2",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::RANGE,
                axum::http::HeaderValue::from_bytes(value.as_bytes()).unwrap(),
            );
            assert_eq!(parse_range(&headers).err().unwrap(), expected, "{value}");
        }
        let mut headers = HeaderMap::new();
        headers.append(header::RANGE, "bytes=0-3".parse().unwrap());
        headers.append(header::RANGE, "bytes=4-9".parse().unwrap());
        assert_eq!(parse_range(&headers).err().unwrap(), expected);
    }

    #[test]
    fn range_forms_and_raw_header_byte_limit_are_unchanged() {
        assert!(parse_range(&HeaderMap::new()).unwrap().is_none());
        for (value, expected) in [
            ("bytes=3-9", (0, 3, 9)),
            ("bytes=0-", (1, 0, 0)),
            ("bytes=-5", (2, 5, 0)),
            ("bytes=-0", (2, 0, 0)),
            ("  bytes=003-009  ", (0, 3, 9)),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::RANGE, value.parse().unwrap());
            let actual = match parse_range(&headers).unwrap().unwrap() {
                ReadRange::Inclusive { first, last } => (0, first, last),
                ReadRange::From(first) => (1, first, 0),
                ReadRange::Suffix(length) => (2, length, 0),
            };
            assert_eq!(actual, expected, "{value}");
        }
        let mut headers = HeaderMap::new();
        let value = format!("bytes={}-1", "0".repeat(120));
        assert_eq!(value.len(), 128);
        headers.insert(header::RANGE, value.parse().unwrap());
        assert!(matches!(
            parse_range(&headers),
            Ok(Some(ReadRange::Inclusive { first: 0, last: 1 }))
        ));
        headers.insert(header::RANGE, format!("{value} ").parse().unwrap());
        assert_eq!(
            parse_range(&headers).err().unwrap(),
            (StatusCode::BAD_REQUEST, "invalid_static_hls_range".into())
        );
        assert!(!satisfiable(ReadRange::Suffix(0), 20));
    }

    #[test]
    fn if_range_retains_parent_exact_match_and_duplicate_behavior() {
        let mut headers = HeaderMap::new();
        assert!(if_range_matches(&headers, "\"current\""));
        for (value, expected) in [
            ("\"current\"", true),
            ("\"old\"", false),
            ("W/\"current\"", false),
        ] {
            headers.insert(header::IF_RANGE, value.parse().unwrap());
            assert_eq!(if_range_matches(&headers, "\"current\""), expected);
        }
        headers.insert(header::IF_RANGE, "\"current\"".parse().unwrap());
        headers.append(header::IF_RANGE, "\"current\"".parse().unwrap());
        assert!(!if_range_matches(&headers, "\"current\""));
    }
}
