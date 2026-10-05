//! Dedicated authenticated reads of the SAME original published child owner.
//!
//! Frozen SQL observations select comparison data, never a filesystem path or
//! a reconstructed output. Parent and generic `indexN` authorities are absent.
use super::{App, Result, metric_stream, playback_access, static_hls_child_delivery};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::Response,
};
use media_core::runtime_metrics::{Cache, Layer};
use std::sync::Arc;
use uuid::Uuid;

pub(super) async fn endpoint(
    State(app): State<App>,
    Path((id, token, path)): Path<(Uuid, String, String)>,
    headers: HeaderMap,
    method: Method,
) -> Result<Response> {
    validate_route(&token, &path)?;
    let token_hash = super::hash(&token);
    let loaded = persistence::static_hls_child_read::load_published_child(
        &app.db,
        id,
        &token_hash,
        *super::static_hls_contract::INSTANCE,
        |ciphertext| super::static_hls_operation::open_storage(&app, ciphertext),
    )
    .await
    .map_err(unavailable)?
    .ok_or_else(unauthorized)?;
    let loaded = Arc::new(loaded);
    // Registry lookup retains the actual original attempt's physical owner and
    // checks complete frozen input equality. Never adopt DB output/path facts.
    let output = app
        .static_hls_child_encoders
        .published(loaded.input())
        .map_err(unavailable)?
        .ok_or_else(unavailable_without_detail)?;
    if output.identity() != loaded.output_identity()
        || output.require_same_frozen_input(loaded.input()).is_err()
    {
        return Err(unauthorized());
    }
    let boundary = playback_access::ChildBoundary { loaded, output };
    let prepare_boundary = boundary.clone();
    let head = method == Method::HEAD;
    let metrics = app.metrics.clone();
    let response = playback_access::protect_static_hls_child(
        move |_| async move {
            static_hls_child_delivery::response(
                prepare_boundary.output.clone(),
                static_hls_child_delivery::ReadDemand {
                    input: prepare_boundary.loaded.input(),
                    expected_output: prepare_boundary.loaded.output_identity(),
                    authenticated_user: prepare_boundary.loaded.authenticated_user(),
                },
                &path,
                &method,
                &headers,
            )
            .await
        },
        app.db.clone(),
        id,
        token_hash,
        app.deliveries.clone(),
        app.input_failures.observe(id, None),
        boundary,
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
    Ok(Response::from_parts(
        parts,
        Body::from_stream(
            metric_stream::wrap(
                body.into_data_stream(),
                &metrics,
                Layer::WorkerEgress,
                Cache::NotHit,
            )
            .with_body_length(length),
        ),
    ))
}

/// Closed child route surface, independently of Axum's path decoding. The
/// delivery helper repeats the exhaustive resource set before opening bytes.
pub(crate) fn validate_route(token: &str, path: &str) -> Result<()> {
    if token.len() != 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(unauthorized());
    }
    if !matches!(
        path,
        "index.m3u8" | "init.mp4" | "s000.m4s" | "s001.m4s" | "s002.m4s" | "s003.m4s" | "s004.m4s"
    ) {
        return Err((
            StatusCode::BAD_REQUEST,
            "invalid_static_hls_child_resource".into(),
        ));
    }
    Ok(())
}

fn unauthorized() -> (StatusCode, String) {
    (StatusCode::UNAUTHORIZED, "invalid_playback_session".into())
}
fn unavailable_without_detail() -> (StatusCode, String) {
    (StatusCode::SERVICE_UNAVAILABLE, "media_unavailable".into())
}
fn unavailable(_: impl std::fmt::Display) -> (StatusCode, String) {
    unavailable_without_detail()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_accepts_only_lower_hex_and_child_resource_names() {
        let token = "a".repeat(64);
        for path in [
            "index.m3u8",
            "init.mp4",
            "s000.m4s",
            "s001.m4s",
            "s002.m4s",
            "s003.m4s",
            "s004.m4s",
        ] {
            assert!(validate_route(&token, path).is_ok());
        }
        for path in [
            "index0.m3u8",
            "index1.ts",
            "s005.m4s",
            "s999.m4s",
            "../index.m3u8",
            "x/index.m3u8",
            "s00.m4s",
            "index.m3u8?x=1",
            "init.mp4/",
            "%69ndex.m3u8",
        ] {
            assert_eq!(
                validate_route(&token, path).unwrap_err().0,
                StatusCode::BAD_REQUEST
            );
        }
        for token in [
            "A".repeat(64),
            "a".repeat(63),
            "0".repeat(65),
            "g".repeat(64),
        ] {
            assert_eq!(
                validate_route(&token, "index.m3u8").unwrap_err().0,
                StatusCode::UNAUTHORIZED
            );
        }
    }
}
