//! Closed descriptor-backed HTTP jobs. The original held representation remains
//! separate from output scheduling, retries and process drain receipts.
use anyhow::{Result, ensure};
use serde_json::Value;
pub const QUEUE: &str = "owned_http_v1";
pub const KIND: &str = "owned_http_transcode_v1";
pub fn validate_spec(spec: &Value) -> Result<()> {
    let object = spec
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("owned_http_job_invalid"))?;
    const FIELDS: &[&str] = &[
        "kind",
        "owned_http_response_version",
        "root",
        "resource",
        "source_kind",
        "input_ticket",
        "start_seconds",
        "transcode",
        "audio_index",
        "estimated_output_bytes",
        "negotiated_mode",
        "source_version",
    ];
    ensure!(
        object.len() == FIELDS.len()
            && FIELDS.iter().all(|field| object.contains_key(*field))
            && spec["kind"] == KIND
            && spec["owned_http_response_version"] == 1
            && spec["source_kind"] == "http"
            && spec["transcode"] == true
            && spec["source_version"].is_null()
            && spec["root"].is_string()
            && spec["resource"].is_string()
            && spec["input_ticket"]
                .as_str()
                .is_some_and(|v| !v.is_empty() && v.len() <= 16384)
            && spec["start_seconds"]
                .as_f64()
                .is_some_and(|v| v.is_finite() && (0.0..=21600.0).contains(&v))
            && (spec["audio_index"].is_null()
                || spec["audio_index"]
                    .as_u64()
                    .is_some_and(|v| v <= u64::from(u32::MAX)))
            && (spec["negotiated_mode"].is_null() || spec["negotiated_mode"] == "transcode")
            && (spec["estimated_output_bytes"].is_null()
                || spec["estimated_output_bytes"]
                    .as_u64()
                    .is_some_and(|v| v > 0 && v <= i64::MAX as u64)),
        "owned_http_job_invalid"
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn spec_is_closed_and_cannot_substitute_remote_authority() {
        let spec = json!({"kind":KIND,"owned_http_response_version":1,"root":"","resource":"file","source_kind":"http","input_ticket":"encrypted","start_seconds":0.0,"transcode":true,"audio_index":null,"estimated_output_bytes":null,"negotiated_mode":null,"source_version":null});
        validate_spec(&spec).unwrap();
        for (name, value) in [
            ("url", json!("https://other.invalid/a")),
            ("input_ticket", json!("")),
            ("source_version", json!("W/weak")),
            ("start_seconds", json!(21601.0)),
            ("audio_index", json!(-1)),
            ("transcode", json!(false)),
            ("kind", json!("legacy")),
        ] {
            let mut bad = spec.clone();
            bad[name] = value;
            assert!(validate_spec(&bad).is_err());
        }
    }
}
