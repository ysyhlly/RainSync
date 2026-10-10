//! Request snapshots and caller-first transaction admission have separate lifetimes.
//! Room-first playback authorization stays in media_authorization and persistence.
pub(crate) mod admin;
pub(crate) mod profiles;
pub(crate) mod request;

use crate::{Error, err};
use axum::http::StatusCode;

/// Identity observed at request entry. Neither `admin` nor this value grants
/// transaction authority; writes must lock and recheck after every relevant wait.
#[derive(Clone)]
pub struct RequestIdentity {
    pub(crate) id: uuid::Uuid,
    pub(crate) admin: bool,
}

/// Only the dependencies needed for request authentication. No owner registry,
/// cipher, mutable settings snapshot or application service locator is exposed.
pub(crate) struct RequestContext<'a> {
    pub db: &'a sqlx::PgPool,
    pub origin: &'a str,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum Failure {
    LoginRequired,
    SessionExpired,
    GuestRestricted,
    OriginRejected,
    CsrfRejected,
    NotAMember,
    AdminRequired,
}
impl From<Failure> for Error {
    fn from(failure: Failure) -> Self {
        let (status, reason) = match failure {
            Failure::LoginRequired => (StatusCode::UNAUTHORIZED, "login_required"),
            Failure::SessionExpired => (StatusCode::UNAUTHORIZED, "session_expired"),
            Failure::GuestRestricted => (StatusCode::FORBIDDEN, "guest_restricted"),
            Failure::OriginRejected => (StatusCode::FORBIDDEN, "origin_rejected"),
            Failure::CsrfRejected => (StatusCode::FORBIDDEN, "csrf_rejected"),
            Failure::NotAMember => (StatusCode::FORBIDDEN, "not_a_member"),
            Failure::AdminRequired => (StatusCode::FORBIDDEN, "admin_required"),
        };
        err(status, reason)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::ErrorCode;

    #[test]
    fn typed_identity_failures_keep_existing_public_protocol_mapping() {
        for (failure, status, reason) in [
            (
                Failure::LoginRequired,
                StatusCode::UNAUTHORIZED,
                "login_required",
            ),
            (
                Failure::SessionExpired,
                StatusCode::UNAUTHORIZED,
                "session_expired",
            ),
            (
                Failure::GuestRestricted,
                StatusCode::FORBIDDEN,
                "guest_restricted",
            ),
            (
                Failure::OriginRejected,
                StatusCode::FORBIDDEN,
                "origin_rejected",
            ),
            (
                Failure::CsrfRejected,
                StatusCode::FORBIDDEN,
                "csrf_rejected",
            ),
            (Failure::NotAMember, StatusCode::FORBIDDEN, "not_a_member"),
            (
                Failure::AdminRequired,
                StatusCode::FORBIDDEN,
                "admin_required",
            ),
        ] {
            let actual: Error = failure.into();
            assert_eq!(actual.0, status);
            assert_eq!(actual.1, reason);
            assert_eq!(actual.2, None);
            assert_eq!(
                ErrorCode::from_reason(&actual.1, actual.0.as_u16()),
                ErrorCode::from_reason(reason, status.as_u16())
            );
        }
    }
}
