//! Playback rules are independent of preparation, admission and publication.
//! Existing entry points remain adapters until those later extractions land.
pub(crate) mod facts;
pub(crate) mod projection;
pub(crate) mod route;
pub(crate) mod selection;

impl From<selection::Rejection> for crate::Error {
    fn from(rejection: selection::Rejection) -> Self {
        use axum::http::StatusCode;
        use selection::Rejection;
        let (status, reason) = match rejection {
            Rejection::InvalidRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
            Rejection::NoCompatibleTransport => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "device_has_no_compatible_playback_transport",
            ),
            Rejection::FiniteHlsSourceUnsupported => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "finite_hls_source_unsupported",
            ),
            Rejection::LocalHlsLadderSourceRequired => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "local_hls_ladder_source_required",
            ),
            Rejection::AdvancedLocalSourceRequired => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "advanced_local_source_required",
            ),
            Rejection::StaleCapabilityReport => (StatusCode::CONFLICT, "stale_capability_report"),
        };
        crate::err(status, reason)
    }
}

#[cfg(test)]
mod tests {
    use super::selection::Rejection;

    #[test]
    fn pure_rejections_keep_existing_status_and_reason_at_the_adapter() {
        for (rejection, status, reason) in [
            (Rejection::InvalidRequest, 400, "invalid_request"),
            (
                Rejection::NoCompatibleTransport,
                422,
                "device_has_no_compatible_playback_transport",
            ),
            (
                Rejection::FiniteHlsSourceUnsupported,
                422,
                "finite_hls_source_unsupported",
            ),
            (
                Rejection::LocalHlsLadderSourceRequired,
                422,
                "local_hls_ladder_source_required",
            ),
            (
                Rejection::AdvancedLocalSourceRequired,
                422,
                "advanced_local_source_required",
            ),
            (
                Rejection::StaleCapabilityReport,
                409,
                "stale_capability_report",
            ),
        ] {
            let error = crate::Error::from(rejection);
            assert_eq!(error.0.as_u16(), status);
            assert_eq!(error.1, reason);
            assert_eq!(error.2, None);
        }
    }
}

#[cfg(test)]
mod route_tests;
