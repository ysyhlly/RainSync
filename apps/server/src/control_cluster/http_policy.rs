//! Pure route, guest-source and upstream-response HTTP policy.
use super::GUEST_RATE_IDENTITY;
use crate::{Result, account_security, err};
use axum::{
    extract::{ConnectInfo, Request},
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use std::net::SocketAddr;
use uuid::Uuid;

/// Only room-control routes are peer-forwarded. Media/account/OAuth/agent state
/// must stay on the sole media authority; unknown control-node routes fail closed.
pub(super) fn room_path(path: &str) -> Option<Uuid> {
    let mut parts = path.strip_prefix("/api/v1/rooms/")?.split('/');
    let room = Uuid::parse_str(parts.next()?).ok()?;
    let tail = parts.collect::<Vec<_>>().join("/");
    let control = tail.is_empty()
        || matches!(
            tail.as_str(),
            "join"
                | "guest-session"
                | "guest-access"
                | "invites"
                | "playlist"
                | "messages"
                | "members"
                | "permissions"
                | "ownership"
                | "owner"
                | "lifecycle"
                | "close"
                | "reopen"
                | "archive"
        )
        || tail.starts_with("permissions/")
        || tail.starts_with("members/")
        || tail.starts_with("invites/")
        || tail.starts_with("playlist/")
        || tail.starts_with("timeline/");
    control.then_some(room)
}
pub(super) fn node_route(path: &str) -> bool {
    matches!(
        path,
        "/ready"
            | "/api/v1/deployment/ready"
            | "/api/v1/ws"
            | "/api/v1/rooms"
            | "/api/v1/auth/me"
            | "/health"
            | "/api/v1/deployment/health"
            | "/api/v1/metrics"
    )
}
pub(super) fn guest_rate_identity(
    security: &account_security::Security,
    request: &Request,
    authenticated_peer: bool,
) -> Result<account_security::GuestRateIdentity> {
    if authenticated_peer {
        // The private source is meaningful only together with the existing
        // allowlisted-node/shared-secret authentication. Reject ambiguous or
        // missing context rather than grouping a peer's users into one bucket.
        let mut values = request.headers().get_all(GUEST_RATE_IDENTITY).iter();
        let identity = values
            .next()
            .and_then(|value| value.to_str().ok())
            .and_then(account_security::GuestRateIdentity::from_authenticated_peer);
        if values.next().is_some() {
            return Err(err(StatusCode::FORBIDDEN, "control_peer_rejected"));
        }
        return identity.ok_or_else(|| err(StatusCode::FORBIDDEN, "control_peer_rejected"));
    }
    // Public callers cannot select the private identity. Derive it from the
    // actual socket and the same configured proxy trust used without a cluster.
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .ok_or_else(|| err(StatusCode::INTERNAL_SERVER_ERROR, "service_unavailable"))?;
    Ok(security.guest_rate_identity(peer.0, request.headers()))
}

pub(super) fn forward_response_headers(
    headers: &HeaderMap,
    response: &mut Response,
    guest_entry: bool,
) {
    for name in [
        header::CONTENT_TYPE,
        header::CACHE_CONTROL,
        header::RETRY_AFTER,
        header::VARY,
    ] {
        if let Some(value) = headers.get(&name) {
            response.headers_mut().insert(name, value.clone());
        }
    }
    // A trusted room owner has already committed the new guest's invitation
    // redemption. Its HttpOnly cookie is the only login credential; dropping it
    // strands that membership. Keep separate Set-Cookie fields separate, and
    // retain the closed header policy for every other route and error response.
    if guest_entry && response.status() == StatusCode::CREATED {
        for value in headers.get_all(header::SET_COOKIE) {
            response
                .headers_mut()
                .append(header::SET_COOKIE, value.clone());
        }
    }
}
