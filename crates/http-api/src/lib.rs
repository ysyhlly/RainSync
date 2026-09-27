use axum::{
    Json,
    body::{Body, to_bytes},
    extract::Request,
    http::{Method, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use protocol::{ApiError, ErrorCode, ErrorResponse};
use uuid::Uuid;

/// Normalize application, extractor and router failures without returning raw
/// upstream/framework bodies. Preserve protocol headers such as Content-Range.
pub async fn errors(request: Request, next: Next) -> Response {
    let request_id = Uuid::new_v4();
    let head = request.method() == Method::HEAD;
    let response = next.run(request).await;
    let (mut parts, body) = response.into_parts();
    parts
        .headers
        .insert("x-request-id", request_id.to_string().parse().unwrap());
    if !parts.status.is_client_error() && !parts.status.is_server_error() {
        return Response::from_parts(parts, body);
    }
    // An Agent can return a streamed error. Do not wait indefinitely for its
    // diagnostic body; dropping it also releases the relay reader.
    let bytes = tokio::time::timeout(std::time::Duration::from_secs(1), to_bytes(body, 16384))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
    let reason = value["error"]
        .as_str()
        .or_else(|| std::str::from_utf8(&bytes).ok())
        .unwrap_or("");
    let code = ErrorCode::from_reason(reason, parts.status.as_u16());
    let mut error = ApiError::new(code, request_id);
    if code == ErrorCode::RateLimited {
        error.retry_after_ms = parts
            .headers
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|seconds| (1..=3600).contains(seconds))
            .map(|seconds| seconds * 1000);
    }
    tracing::warn!(%request_id, ?code, status = parts.status.as_u16(), "request failed");
    let normalized = Json(ErrorResponse { error }).into_response();
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.remove(header::CONTENT_ENCODING);
    parts.headers.remove(header::ETAG);
    parts
        .headers
        .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    parts
        .headers
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Response::from_parts(
        parts,
        if head {
            Body::empty()
        } else {
            normalized.into_body()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, routing::get};
    use tower::ServiceExt;

    #[tokio::test]
    async fn oversized_and_stalled_upstream_error_bodies_are_bounded() {
        for stalled in [false, true] {
            let router = Router::new()
                .route(
                    "/",
                    get(move || async move {
                        let body = if stalled {
                            Body::from_stream(futures_util::stream::pending::<
                                Result<axum::body::Bytes, std::io::Error>,
                            >())
                        } else {
                            Body::from("private-token".repeat(2000))
                        };
                        Response::builder()
                            .status(502)
                            .header(header::CONTENT_ENCODING, "gzip")
                            .header(header::ETAG, "upstream-private-etag")
                            .body(body)
                            .unwrap()
                    }),
                )
                .layer(axum::middleware::from_fn(errors));
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                router.oneshot(Request::builder().uri("/").body(Body::empty()).unwrap()),
            )
            .await
            .expect("a stalled error stream must not stall the response")
            .unwrap();
            assert_eq!(response.status(), 502);
            assert!(response.headers().get(header::CONTENT_ENCODING).is_none());
            assert!(response.headers().get(header::ETAG).is_none());
            let request_id = response.headers()["x-request-id"]
                .to_str()
                .unwrap()
                .to_owned();
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            let decoded: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(decoded.error.code, ErrorCode::UpstreamFailed);
            assert_eq!(decoded.error.request_id.to_string(), request_id);
            assert!(!String::from_utf8_lossy(&bytes).contains("private-token"));
        }
    }
}
