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
    // Fixed allowlisted wording. Never reflect source/probe/provider text.
    match reason {
        "legacy_stream_mapping_unsupported" => {
            error.message = "此片源的媒体轨道映射无法安全用于当前生成播放路径".into()
        }
        "local_hls_ladder_source_required" => {
            error.message = "多清晰度 HLS 当前仅支持已核对版本的本地片源".into()
        }
        "local_hls_ladder_source_unsupported" => {
            error.message = "当前片源不满足多清晰度 HLS 的 SDR、轨道或画面要求".into()
        }
        "local_hls_ladder_duration_required" => {
            error.message =
                "多清晰度 HLS 需要已验证的时长（最长 24 小时），且起点必须早于结尾".into()
        }
        "local_hls_ladder_advanced_incompatible" => {
            error.message = "多清晰度 HLS 暂不能与 HDR 色调映射或字幕烧录一起使用".into()
        }
        "dedicated_local_hls_ladder_endpoint_required" => {
            error.message = "多清晰度 HLS 需要受支持的专用接口，请更新客户端和服务端".into()
        }
        "advanced_local_source_required" => {
            error.message = "高级播放当前仅支持由 Server 完整持有并核对版本的本地片源".into()
        }
        "dedicated_advanced_endpoint_required" => {
            error.message = "高级播放需要受支持的专用接口，请更新客户端和服务端".into()
        }
        "invalid_subtitle_track" => {
            error.message = "所选嵌入字幕不可用或无法安全烧录，请重新加载片源信息".into()
        }
        _ => {}
    }
    if matches!(
        code,
        ErrorCode::RateLimited
            | ErrorCode::ChatRateLimited
            | ErrorCode::ReactionRateLimited
            | ErrorCode::ComputeRoomQueueFull
            | ErrorCode::P2pSignalBudgetExceeded
            | ErrorCode::P2pRoomPeerBudgetExceeded
    ) {
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
    async fn chat_and_reaction_limits_preserve_explicit_bounded_backoff() {
        for (reason, expected) in [
            ("chat_rate_limited", ErrorCode::ChatRateLimited),
            ("reaction_rate_limited", ErrorCode::ReactionRateLimited),
        ] {
            let router = Router::new()
                .route(
                    "/",
                    get(move || async move {
                        (
                            axum::http::StatusCode::TOO_MANY_REQUESTS,
                            [(header::RETRY_AFTER, "2")],
                            Json(serde_json::json!({"error":reason})),
                        )
                    }),
                )
                .layer(axum::middleware::from_fn(errors));
            let response = router
                .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            let value: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value.error.code, expected);
            assert!(value.error.retryable);
            assert_eq!(value.error.retry_after_ms, Some(2000));
        }
    }
    #[tokio::test]
    async fn advanced_aliases_have_fixed_nonretryable_messages() {
        for (reason, status, code, text) in [
            (
                "advanced_local_source_required",
                422,
                ErrorCode::UnsupportedVideoOrHdr,
                "本地片源",
            ),
            (
                "dedicated_advanced_endpoint_required",
                400,
                ErrorCode::InvalidRequest,
                "专用接口",
            ),
            (
                "invalid_subtitle_track",
                400,
                ErrorCode::InvalidSubtitle,
                "嵌入字幕",
            ),
        ] {
            let router = Router::new()
                .route(
                    "/",
                    get(move || async move {
                        (
                            axum::http::StatusCode::from_u16(status).unwrap(),
                            Json(serde_json::json!({"error":reason})),
                        )
                    }),
                )
                .layer(axum::middleware::from_fn(errors));
            let response = router
                .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status);
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            let decoded: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(decoded.error.code, code);
            assert!(decoded.error.message.contains(text));
            assert!(!decoded.error.retryable);
        }
    }

    #[tokio::test]
    async fn mapping_refusal_has_specific_wording_and_preserves_prior_video_errors() {
        for reason in [
            "legacy_stream_mapping_unsupported",
            "unsupported_video_or_hdr",
            "hdr_unsupported",
            "drm_unsupported",
        ] {
            let router = Router::new()
                .route(
                    "/",
                    get(move || async move {
                        (
                            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                            Json(serde_json::json!({"error":reason})),
                        )
                    }),
                )
                .layer(axum::middleware::from_fn(errors));
            let response = router
                .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), 422);
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            let decoded: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(decoded.error.code, ErrorCode::from_reason(reason, 422));
            assert!(!decoded.error.retryable);
            if reason == "legacy_stream_mapping_unsupported" {
                assert!(decoded.error.message.contains("轨道映射"));
                assert!(!decoded.error.message.contains("HDR"));
            } else {
                assert_eq!(
                    decoded.error.message,
                    ApiError::new(decoded.error.code, Uuid::nil()).message
                );
            }
        }
    }

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
