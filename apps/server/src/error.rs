//! Internal failures retain the established HTTP reason adapter.
//! Public codes and safe messages still come from protocol::ErrorCode/http_api::errors.
use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug)]
pub struct Error(
    pub(crate) StatusCode,
    pub(crate) String,
    pub(crate) Option<u32>,
);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let mut response = (self.0, Json(json!({"error":self.1}))).into_response();
        if let Some(seconds) = self.2 {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, seconds.to_string().parse().unwrap());
        }
        response
    }
}
impl From<anyhow::Error> for Error {
    fn from(_error: anyhow::Error) -> Self {
        #[cfg(test)]
        if std::env::var("RAINSYNC_OWNED_TEST_RUN_ID").is_ok() {
            eprintln!("owned fixture operation failure: {_error}");
        }
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "operation_failed".into(),
            None,
        )
    }
}
impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        if let sqlx::Error::Database(ref db) = error {
            if db.message() == "guest_restricted" {
                return err(StatusCode::FORBIDDEN, "guest_restricted");
            }
            if db.message() == "account_inactive" {
                return err(StatusCode::FORBIDDEN, "account_inactive");
            }
            if matches!(db.code().as_deref(), Some("40P01" | "55P03")) {
                return err(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable");
            }
        }
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "database_error".into(),
            None,
        )
    }
}
pub(crate) fn err(status: StatusCode, msg: &str) -> Error {
    Error(status, msg.into(), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_header_survives_the_internal_adapter() {
        let response = Error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited".into(),
            Some(7),
        )
        .into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::RETRY_AFTER], "7");
        assert!(
            !err(StatusCode::FORBIDDEN, "admin_required")
                .into_response()
                .headers()
                .contains_key(header::RETRY_AFTER)
        );
    }

    #[test]
    fn opaque_failures_do_not_expose_database_or_upstream_details() {
        let operation = Error::from(anyhow::anyhow!("https://private.invalid/?token=secret"));
        assert_eq!(operation.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(operation.1, "operation_failed");
        assert_eq!(operation.2, None);
        let database = Error::from(sqlx::Error::Protocol("private SQL or credentials".into()));
        assert_eq!(database.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(database.1, "database_error");
        assert_eq!(database.2, None);
    }
}
