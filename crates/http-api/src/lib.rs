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

/// Trusted readiness handlers return a fixed, low-cardinality diagnostic body
/// even when readiness fails. Request data cannot create this response marker.
#[derive(Clone, Copy, Debug)]
pub struct PreserveReadinessBody;

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
    if (!parts.status.is_client_error() && !parts.status.is_server_error())
        || parts.extensions.get::<PreserveReadinessBody>().is_some()
    {
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
    let code = if let Some(structured) = value["error"].as_object() {
        // A Gateway can return an error already normalized by another Server.
        // Decode only the public enum, never trust its wording, retry flags,
        // request identity, or any additional upstream fields.
        structured
            .get("code")
            .and_then(serde_json::Value::as_str)
            .and_then(|code| {
                serde_json::from_value::<ErrorCode>(serde_json::Value::String(code.into())).ok()
            })
            .unwrap_or_else(|| ErrorCode::from_status(parts.status.as_u16()))
    } else {
        ErrorCode::from_reason(reason, parts.status.as_u16())
    };
    let mut error = ApiError::new(code, request_id);
    // Fixed allowlisted wording. Never reflect source/probe/provider text.
    match reason {
        "idempotency_key_conflict" => {
            error.message = "此创建请求键已用于另一个房间名称，请使用原名称重试".into()
        }
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
    async fn dedicated_codes_survive_two_actual_error_middleware_passes() {
        for (reason, expected) in [
            ("invalid_invite", ErrorCode::InvalidInvite),
            ("controller_required", ErrorCode::ControllerRequired),
            ("control_epoch_expired", ErrorCode::ControlEpochExpired),
        ] {
            let router = Router::new()
                .route(
                    "/",
                    get(move || async move {
                        (
                            axum::http::StatusCode::FORBIDDEN,
                            Json(serde_json::json!({"error": reason})),
                        )
                    }),
                )
                .layer(axum::middleware::from_fn(errors))
                .layer(axum::middleware::from_fn(errors));
            let response = router
                .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
            let request_id = response.headers()["x-request-id"]
                .to_str()
                .unwrap()
                .to_owned();
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            let decoded: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(decoded.error.code, expected);
            assert_eq!(decoded.error.request_id.to_string(), request_id);
        }
    }

    #[tokio::test]
    async fn structured_gateway_error_keeps_only_the_allowlisted_code() {
        let supplied_id = Uuid::new_v4();
        let malicious = serde_json::json!({
            "error": {
                "code": "INVALID_INVITE", "message": "credential-secret <script>",
                "request_id": supplied_id, "retryable": true,
                "retry_after_ms": 99999999, "credential": "credential-secret"
            },
            "debug": "credential-secret"
        });
        let router = Router::new()
            .route(
                "/",
                get(move || async move { (axum::http::StatusCode::FORBIDDEN, Json(malicious)) }),
            )
            .layer(axum::middleware::from_fn(errors));
        let response = router
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let request_id = response.headers()["x-request-id"]
            .to_str()
            .unwrap()
            .to_owned();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 1);
        assert!(!String::from_utf8_lossy(&bytes).contains("credential-secret"));
        assert!(!String::from_utf8_lossy(&bytes).contains("<script>"));
        let decoded: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded.error.code, ErrorCode::InvalidInvite);
        assert_eq!(
            decoded.error.message,
            ApiError::new(ErrorCode::InvalidInvite, Uuid::nil()).message
        );
        assert!(!decoded.error.retryable);
        assert_eq!(decoded.error.retry_after_ms, None);
        assert_ne!(decoded.error.request_id, supplied_id);
        assert_eq!(decoded.error.request_id.to_string(), request_id);
    }

    #[tokio::test]
    async fn unknown_or_malformed_structured_codes_use_status_and_drop_upstream_fields() {
        for code in [
            serde_json::json!("INVENTED_PRIVILEGE"),
            serde_json::json!("invalid_invite"),
            serde_json::json!({"INVALID_INVITE": null}),
            serde_json::json!(123),
            serde_json::Value::Null,
        ] {
            let payload = serde_json::json!({"error": {
                "code": code, "message": "upstream-private-key", "retryable": true,
                "retry_after_ms": 2000, "request_id": "upstream-private-key"
            }});
            let router = Router::new()
                .route(
                    "/",
                    get(move || async move { (axum::http::StatusCode::FORBIDDEN, Json(payload)) }),
                )
                .layer(axum::middleware::from_fn(errors));
            let response = router
                .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
                .await
                .unwrap();
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("upstream-private-key"));
            let decoded: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(decoded.error.code, ErrorCode::Forbidden);
            assert!(!decoded.error.retryable);
            assert_eq!(decoded.error.retry_after_ms, None);
        }
    }

    #[tokio::test]
    async fn structured_backoff_uses_only_bounded_retry_after_headers() {
        for (retry_after, expected) in [
            ("2", Some(2000)),
            ("3600", Some(3600000)),
            ("0", None),
            ("3601", None),
            ("invalid", None),
        ] {
            let router = Router::new()
                .route(
                    "/",
                    get(move || async move {
                        (
                            axum::http::StatusCode::TOO_MANY_REQUESTS,
                            [
                                (header::RETRY_AFTER, retry_after),
                                (header::CONTENT_RANGE, "bytes */120"),
                            ],
                            Json(serde_json::json!({"error": {
                                "code": "CHAT_RATE_LIMITED", "retryable": false,
                                "retry_after_ms": 99999999, "message": "private-backoff"
                            }})),
                        )
                    }),
                )
                .layer(axum::middleware::from_fn(errors));
            let response = router
                .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.headers()[header::RETRY_AFTER], retry_after);
            assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */120");
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("private-backoff"));
            let decoded: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(decoded.error.code, ErrorCode::ChatRateLimited);
            assert!(decoded.error.retryable);
            assert_eq!(decoded.error.retry_after_ms, expected);
        }
    }

    #[tokio::test]
    async fn trusted_readiness_failure_keeps_checks_without_bypassing_unmarked_errors() {
        let readiness = serde_json::json!({
            "ready": false,
            "checks": {
                "accepting_work": "ready",
                "database": "failed",
                "instance_ownership": "ready"
            }
        });
        for marked in [false, true] {
            let value = readiness.clone();
            let router = Router::new()
                .route(
                    "/ready",
                    get(move || async move {
                        let mut response = (
                            axum::http::StatusCode::SERVICE_UNAVAILABLE,
                            [(header::CACHE_CONTROL, "no-store")],
                            Json(value),
                        )
                            .into_response();
                        if marked {
                            response.extensions_mut().insert(PreserveReadinessBody);
                        }
                        response
                    }),
                )
                .layer(axum::middleware::from_fn(errors));
            let response = router
                .oneshot(
                    Request::builder()
                        .uri("/ready")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                axum::http::StatusCode::SERVICE_UNAVAILABLE
            );
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert!(response.headers().contains_key("x-request-id"));
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            if marked {
                let actual: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(actual, readiness);
            } else {
                let actual: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(actual.error.code, ErrorCode::ServiceUnavailable);
            }
        }
    }

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
