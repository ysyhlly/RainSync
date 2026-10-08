//! Offline, exact-version binary declaration for paired source-access readers.
//! These constants perform no environment, key, database or network access.
pub const SERVER: &str = r#"{"schema_version":1,"contract":"controlled-media-redirects-v1","identity":"final-target-sha256-v1","credential_origin":"configured-origin","methods":["GET","HEAD"],"default":"no-follow","role":"server"}"#;
pub const WORKER: &str = r#"{"schema_version":1,"contract":"controlled-media-redirects-v1","identity":"final-target-sha256-v1","credential_origin":"configured-origin","methods":["GET","HEAD"],"default":"no-follow","role":"worker"}"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn declarations_are_exact_closed_role_specific_json() {
        for (text, role) in [(SERVER, "server"), (WORKER, "worker")] {
            let value: serde_json::Value = serde_json::from_str(text).unwrap();
            assert_eq!(
                value,
                serde_json::json!({"schema_version":1,"contract":"controlled-media-redirects-v1","identity":"final-target-sha256-v1","credential_origin":"configured-origin","methods":["GET","HEAD"],"default":"no-follow","role":role})
            );
            assert!(text.starts_with("{\"schema_version\":1,\"contract\":"));
            assert!(text.ends_with(&format!(",\"role\":\"{role}\"}}")));
            assert!(!text.contains('\n'));
        }
    }
}
