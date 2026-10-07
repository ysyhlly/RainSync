//! Small response constructors for private JSON endpoints.
use crate::*;

pub fn private_json(status: StatusCode, value: Value) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

pub fn ok_json(value: Value) -> Response {
    private_json(StatusCode::OK, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn private_json_preserves_status_headers_and_body() {
        for status in [StatusCode::OK, StatusCode::CREATED] {
            let value = json!({"ok":true,"id":"unchanged"});
            let response = private_json(status, value.clone());
            assert_eq!(response.status(), status);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), value);
        }
        let response = ok_json(json!({"ok":true}));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    }
}
