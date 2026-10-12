//! Finite characterization of the real parent helpers before/after extraction.
//! This file is identical in both phases; it contains no legacy implementation.
use super::{
    GUEST_RATE_IDENTITY, PEER, SECRET, forward_response_headers, guest_rate_identity, node_route,
    room_path,
};
use crate::account_security;
use axum::{
    body::{Body, to_bytes},
    extract::{ConnectInfo, Request},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::net::SocketAddr;
use uuid::Uuid;

fn record(suite: &str, id: String, input: Value, output: Value) {
    // The leading newline also separates this record from libtest's status line.
    println!(
        "\nP21_CASE {}",
        json!({"suite": suite, "id": id, "input": input, "output": output})
    );
}

fn header_bytes(headers: &HeaderMap) -> Value {
    let mut names: Vec<_> = headers.keys().map(|name| name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    // Header-name order is canonicalized; every value's bytes and the order of
    // repeated values for the same name remain intact, especially Set-Cookie.
    json!(
        names
            .into_iter()
            .map(|name| {
                json!([
                    name,
                    headers
                        .get_all(name)
                        .iter()
                        .map(|value| { hex::encode(value.as_bytes()) })
                        .collect::<Vec<_>>()
                ])
            })
            .collect::<Vec<_>>()
    )
}

async fn response_bytes(response: Response) -> Value {
    let status = response.status().as_u16();
    let version = format!("{:?}", response.version());
    let headers = header_bytes(response.headers());
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    json!({"status": status, "version": version, "headers": headers, "body_hex": hex::encode(body)})
}

const ROOM_CASES: &[(&str, Option<&str>)] = &[
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/join",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/guest-session",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/guest-access",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/invites",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/playlist",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/messages",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/members",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/permissions",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/ownership",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/owner",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/lifecycle",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/close",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/reopen",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/archive",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/timeline",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/timeline/",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/timeline/current",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/timeline/current/",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/permissions/",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/members/",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/invites/",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/playlist/",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/permissions/user",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/members/user",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/invites/token",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/playlist/item",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/permissions//",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/members//user",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/invites/../sources",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/playlist/%2F",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/timeline/../../platform-media",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/playback-plan",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/playback-plan/",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/compute/jobs",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/platform-media",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/sources",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/sources/",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/p2p",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/unknown",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/unknown/child",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/join/",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/guest-session/",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/guest-access/",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/messages/",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/ownership/",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/owner/",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/lifecycle/",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/close/",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/reopen/",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/archive/",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/timeline-extra/current",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/timelines/current",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/permissions-extra/user",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/permissionsx/user",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/memberships/user",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/invites-extra/token",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/playlist-extra/item",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/guests-session",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/guest-session-extra",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/Timeline/current",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/JOIN",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000//join",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000///",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/timeline//",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/permissions%2Fuser",
        None,
    ),
    (
        "/api/v1/rooms/123e4567e89b12d3a456426614174000/join",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/123E4567-E89B-12D3-A456-426614174000/join",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/{123e4567-e89b-12d3-a456-426614174000}/join",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/urn:uuid:123e4567-e89b-12d3-a456-426614174000/join",
        Some("123e4567-e89b-12d3-a456-426614174000"),
    ),
    (
        "/api/v1/rooms/00000000-0000-0000-0000-000000000000/join",
        Some("00000000-0000-0000-0000-000000000000"),
    ),
    ("/api/v1/rooms/not-a-uuid/join", None),
    ("/api/v1/rooms//join", None),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-42661417400g/join",
        None,
    ),
    (
        "/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000x/join",
        None,
    ),
    ("/api/v1/rooms", None),
    ("/api/v1/rooms/", None),
    ("/api/v1/rooms//", None),
    (
        "/api/v1/room/123e4567-e89b-12d3-a456-426614174000/join",
        None,
    ),
    (
        "/api/v1/rooms-extra/123e4567-e89b-12d3-a456-426614174000/join",
        None,
    ),
    (
        "/api/v1/ROOMS/123e4567-e89b-12d3-a456-426614174000/join",
        None,
    ),
    (
        "api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/join",
        None,
    ),
    (
        "//api/v1/rooms/123e4567-e89b-12d3-a456-426614174000/join",
        None,
    ),
    ("", None),
    ("/", None),
];

const NODE_CASES: &[(&str, bool)] = &[
    ("/ready", true),
    ("/api/v1/deployment/ready", true),
    ("/api/v1/ws", true),
    ("/api/v1/rooms", true),
    ("/api/v1/auth/me", true),
    ("/health", true),
    ("/api/v1/deployment/health", true),
    ("/api/v1/metrics", true),
    ("/ready/", false),
    ("/api/v1/deployment/ready/", false),
    ("/api/v1/ws/", false),
    ("/api/v1/rooms/", false),
    ("/api/v1/auth/me/", false),
    ("/health/", false),
    ("/api/v1/deployment/health/", false),
    ("/api/v1/metrics/", false),
    ("/ready/child", false),
    ("/api/v1/deployment/ready/child", false),
    ("/api/v1/ws/child", false),
    ("/api/v1/rooms/child", false),
    ("/api/v1/auth/me/child", false),
    ("/health/child", false),
    ("/api/v1/deployment/health/child", false),
    ("/api/v1/metrics/child", false),
    ("", false),
    ("/", false),
    ("/ready-extra", false),
    ("/healthy", false),
    ("/Health", false),
    ("/api/v1/auth/me-extra", false),
    ("/api/v1/ws-extra", false),
    ("/api/v1/rooms/123e4567-e89b-12d3-a456-426614174000", false),
    ("/api/v1/rooms-extra", false),
    ("/api/v1/metrics-extra", false),
    ("/api/v1/deployment/readiness", false),
    (
        "/_rainsync/control/ws/123e4567-e89b-12d3-a456-426614174000",
        false,
    ),
];

#[test]
fn route_output_matrix_preserves_exact_and_prefix_boundaries() {
    for (index, (path, expected)) in ROOM_CASES.iter().enumerate() {
        let actual = room_path(path);
        assert_eq!(
            actual,
            expected.map(|value| Uuid::parse_str(value).unwrap()),
            "{path}"
        );
        record(
            "room",
            format!("room-{index:03}"),
            json!({"path": path}),
            json!({"room": actual.map(|room| room.to_string())}),
        );
    }
    for (index, (path, expected)) in NODE_CASES.iter().enumerate() {
        let actual = node_route(path);
        assert_eq!(actual, *expected, "{path}");
        record(
            "node",
            format!("node-{index:03}"),
            json!({"path": path}),
            json!({"allowed": actual}),
        );
    }
}

struct IdentityCase {
    name: &'static str,
    private_values: Vec<Vec<u8>>,
    peer_identity: Option<String>,
}

fn identity_cases() -> Vec<IdentityCase> {
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    let digits = "1".repeat(64);
    let mixed = "0123456789abcdef".repeat(4);
    let zero = "0".repeat(64);
    type IdentityRow = (&'static str, Vec<Vec<u8>>, Option<String>);
    let rows: Vec<IdentityRow> = vec![
        ("absent", vec![], None),
        ("lowercase", vec![a.as_bytes().to_vec()], Some(a.clone())),
        ("digits", vec![digits.as_bytes().to_vec()], Some(digits)),
        ("mixed_hex", vec![mixed.as_bytes().to_vec()], Some(mixed)),
        ("zero", vec![zero.as_bytes().to_vec()], Some(zero)),
        ("uppercase_a", vec!["A".repeat(64).into_bytes()], None),
        ("invalid_g", vec!["G".repeat(64).into_bytes()], None),
        ("empty", vec![vec![]], None),
        ("short", vec!["a".repeat(63).into_bytes()], None),
        ("long", vec!["a".repeat(65).into_bytes()], None),
        ("leading_space", vec![format!(" {a}").into_bytes()], None),
        ("trailing_space", vec![format!("{a} ").into_bytes()], None),
        ("comma_joined", vec![format!("{a},{b}").into_bytes()], None),
        (
            "duplicate_same",
            vec![a.as_bytes().to_vec(), a.as_bytes().to_vec()],
            None,
        ),
        (
            "duplicate_different",
            vec![a.as_bytes().to_vec(), b.as_bytes().to_vec()],
            None,
        ),
        (
            "valid_then_invalid",
            vec![a.as_bytes().to_vec(), b"invalid".to_vec()],
            None,
        ),
        (
            "invalid_then_valid",
            vec![b"invalid".to_vec(), a.as_bytes().to_vec()],
            None,
        ),
        ("opaque_bytes", vec![vec![0xff; 64]], None),
        (
            "three_values",
            vec![a.as_bytes().to_vec(), b.as_bytes().to_vec(), a.into_bytes()],
            None,
        ),
        (
            "mixed_case",
            vec!["0123456789abcdeF".repeat(4).into_bytes()],
            None,
        ),
    ];
    rows.into_iter()
        .map(|(name, private_values, peer_identity)| IdentityCase {
            name,
            private_values,
            peer_identity,
        })
        .collect()
}

#[tokio::test]
async fn guest_context_output_matrix_preserves_identity_and_error_bytes() {
    let security = account_security::Security::for_test();
    let sources: [(&str, Option<SocketAddr>); 4] = [
        ("ipv4", Some("192.0.2.1:1234".parse().unwrap())),
        (
            "mapped_ipv4",
            Some("[::ffff:192.0.2.1]:4321".parse().unwrap()),
        ),
        ("ipv6", Some("[2001:db8::1]:1234".parse().unwrap())),
        ("missing", None),
    ];
    for case in identity_cases() {
        for (source_name, source) in sources {
            for authenticated_peer in [false, true] {
                let mut request = Request::new(Body::empty());
                if let Some(source) = source {
                    request.extensions_mut().insert(ConnectInfo(source));
                }
                request
                    .headers_mut()
                    .insert("x-forwarded-for", HeaderValue::from_static("198.51.100.2"));
                for value in &case.private_values {
                    request
                        .headers_mut()
                        .append(GUEST_RATE_IDENTITY, HeaderValue::from_bytes(value).unwrap());
                }
                let expected_identity = if authenticated_peer {
                    case.peer_identity.clone()
                } else {
                    source.map(|source| {
                        security
                            .guest_rate_identity(source, request.headers())
                            .as_str()
                            .to_owned()
                    })
                };
                let input = json!({"authenticated_peer": authenticated_peer, "socket": source.map(|socket| socket.to_string()), "headers": header_bytes(request.headers())});
                let output = match guest_rate_identity(&security, &request, authenticated_peer) {
                    Ok(identity) => {
                        assert_eq!(
                            Some(identity.as_str()),
                            expected_identity.as_deref(),
                            "{} {source_name} {authenticated_peer}",
                            case.name
                        );
                        json!({"kind": "identity", "identity": identity.as_str(), "identity_hex": hex::encode(identity.as_str().as_bytes())})
                    }
                    Err(error) => {
                        assert!(
                            expected_identity.is_none(),
                            "{} {source_name} {authenticated_peer}",
                            case.name
                        );
                        let expected_error = if authenticated_peer {
                            (StatusCode::FORBIDDEN, "control_peer_rejected")
                        } else {
                            (StatusCode::INTERNAL_SERVER_ERROR, "service_unavailable")
                        };
                        assert_eq!(
                            (error.0, error.1.as_str(), error.2),
                            (expected_error.0, expected_error.1, None)
                        );
                        let status = error.0.as_u16();
                        let reason = error.1.clone();
                        let retry_after = error.2;
                        let response = response_bytes(error.into_response()).await;
                        json!({"kind": "error", "status": status, "reason": reason, "retry_after": retry_after, "response": response})
                    }
                };
                record(
                    "guest",
                    format!("guest-{}-{source_name}-{authenticated_peer}", case.name),
                    input,
                    output,
                );
            }
        }
    }
}

fn upstream_headers(kind: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if kind == "full_multi" {
        for (name, value) in [
            (header::CONTENT_TYPE, "application/json"),
            (header::CONTENT_TYPE, "application/problem+json"),
            (header::CACHE_CONTROL, "no-store"),
            (header::CACHE_CONTROL, "private"),
            (header::RETRY_AFTER, "17"),
            (header::RETRY_AFTER, "29"),
            (header::VARY, "Origin"),
            (header::VARY, "Accept"),
            (header::CONNECTION, "close"),
            (header::CONTENT_LENGTH, "999"),
            (header::TRANSFER_ENCODING, "chunked"),
            (header::LOCATION, "https://example.invalid/never-forward"),
        ] {
            headers.append(name, HeaderValue::from_static(value));
        }
        headers.append(PEER, HeaderValue::from_static("synthetic-peer"));
        headers.append(SECRET, HeaderValue::from_static("synthetic-secret"));
        headers.append(
            GUEST_RATE_IDENTITY,
            HeaderValue::from_bytes(&[b'a'; 64]).unwrap(),
        );
        headers.append(
            "x-unknown-upstream",
            HeaderValue::from_static("never-forward"),
        );
    }
    if matches!(kind, "full_multi" | "cookie_only") {
        headers.append(header::SET_COOKIE, HeaderValue::from_static("rainsync_session=synthetic; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200; Secure"));
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_static("other_synthetic=value; HttpOnly; Path=/"),
        );
        headers.append(
            header::SET_COOKIE,
            HeaderValue::from_bytes(b"opaque=\x80\xff; Path=/").unwrap(),
        );
    }
    if kind == "opaque_allowed" {
        for name in [
            header::CONTENT_TYPE,
            header::CACHE_CONTROL,
            header::RETRY_AFTER,
            header::VARY,
        ] {
            headers.append(name, HeaderValue::from_bytes(b"first-\x80\xff").unwrap());
        }
    }
    headers
}

#[tokio::test]
async fn response_header_output_matrix_preserves_status_order_and_body_bytes() {
    // The third tuple field is the explicit cookie expectation for that case.
    let status_cases: &[(bool, u16, bool)] = &[
        (false, 200, false),
        (false, 201, false),
        (false, 202, false),
        (false, 204, false),
        (false, 301, false),
        (false, 400, false),
        (false, 401, false),
        (false, 403, false),
        (false, 404, false),
        (false, 409, false),
        (false, 429, false),
        (false, 500, false),
        (false, 503, false),
        (true, 200, false),
        (true, 201, true),
        (true, 202, false),
        (true, 204, false),
        (true, 301, false),
        (true, 400, false),
        (true, 401, false),
        (true, 403, false),
        (true, 404, false),
        (true, 409, false),
        (true, 429, false),
        (true, 500, false),
        (true, 503, false),
    ];
    let body = b"synthetic-body:\0\xff\r\n".to_vec();
    for kind in ["empty", "full_multi", "cookie_only", "opaque_allowed"] {
        let headers = upstream_headers(kind);
        for preexisting in [false, true] {
            for &(guest_entry, status, expect_upstream_cookies) in status_cases {
                let mut response = Response::builder()
                    .status(status)
                    .body(Body::from(body.clone()))
                    .unwrap();
                if preexisting {
                    response
                        .headers_mut()
                        .append(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
                    response.headers_mut().append(
                        header::CACHE_CONTROL,
                        HeaderValue::from_static("local-first"),
                    );
                    response.headers_mut().append(
                        header::CACHE_CONTROL,
                        HeaderValue::from_static("local-second"),
                    );
                    response.headers_mut().append(
                        header::SET_COOKIE,
                        HeaderValue::from_static("existing=kept; Path=/"),
                    );
                    response
                        .headers_mut()
                        .append("x-response-local", HeaderValue::from_static("kept"));
                }
                let before = header_bytes(response.headers());
                let mut expected_cookies = response
                    .headers()
                    .get_all(header::SET_COOKIE)
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>();
                if expect_upstream_cookies {
                    expected_cookies.extend(headers.get_all(header::SET_COOKIE).iter().cloned());
                }
                forward_response_headers(&headers, &mut response, guest_entry);
                assert_eq!(response.status().as_u16(), status);
                assert_eq!(
                    response
                        .headers()
                        .get_all(header::SET_COOKIE)
                        .iter()
                        .cloned()
                        .collect::<Vec<_>>(),
                    expected_cookies
                );
                for excluded in [
                    PEER,
                    SECRET,
                    GUEST_RATE_IDENTITY,
                    "connection",
                    "content-length",
                    "transfer-encoding",
                    "location",
                    "x-unknown-upstream",
                ] {
                    assert!(
                        !response.headers().contains_key(excluded),
                        "{kind} {status} {guest_entry} {excluded}"
                    );
                }
                let output = response_bytes(response).await;
                assert_eq!(output["body_hex"], hex::encode(&body));
                record(
                    "headers",
                    format!("headers-{kind}-{preexisting}-{guest_entry}-{status}"),
                    json!({"guest_entry": guest_entry, "status": status, "upstream_headers": header_bytes(&headers), "response_headers_before": before, "body_hex": hex::encode(&body)}),
                    output,
                );
            }
        }
    }
}
