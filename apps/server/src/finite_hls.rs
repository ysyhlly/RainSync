//! Explicit finite clear-source normalization, sharing original owned custody.
use super::*;
pub(crate) fn validate(body: &protocol::PlaybackRequest) -> Result<()> {
    if body.finite_hls_version.is_none() {
        return Ok(());
    }
    if body.finite_hls_version != Some(1)
        || body.mode.as_deref() != Some("transcode")
        || body.native_platform.is_some()
        || body.upstream_profile_report.is_some()
        || body.distributed_compute.is_some()
        || body.candidate_report.is_some()
        || body.http_file_fallback.is_some()
        || body.advanced_playback.is_some()
        || body.local_hls_ladder.is_some()
        || body.static_hls_fallback_version.is_some()
    {
        return Err(err(StatusCode::BAD_REQUEST, "finite_hls_request_invalid"));
    }
    Ok(())
}
pub(crate) fn select(
    body: &protocol::PlaybackRequest,
    resource: &mut Value,
    continuation: bool,
    session: Uuid,
) -> Result<bool> {
    validate(body)?;
    if body.finite_hls_version.is_none() {
        return Ok(false);
    }
    if resource["kind"] != "http" || continuation || !cfg!(target_os = "linux") {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "finite_hls_source_unsupported",
        ));
    }
    resource["http_owned_response_version"] = json!(1);
    resource["http_finite_hls_version"] = json!(1);
    resource["owned_http_session_id"] = json!(session);
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_finite_source_cannot_enter_another_recipe_or_continuation() {
        let mut request:protocol::PlaybackRequest=serde_json::from_value(json!({"room_id":Uuid::nil(),"media_generation":0,"position_ms":0.0,"mode":"transcode","finite_hls_version":1})).unwrap();
        let mut resource = json!({"kind":"http","url":"https://source.example/master.m3u8"});
        assert!(select(&request, &mut resource, false, Uuid::nil()).unwrap());
        assert_eq!(resource["http_finite_hls_version"], 1);
        assert!(resource.get("http_file_binary_only").is_none());
        assert!(select(&request, &mut resource, true, Uuid::nil()).is_err());
        request.mode = Some("direct".into());
        assert!(validate(&request).is_err());
        request.mode = Some("transcode".into());
        request.finite_hls_version = Some(2);
        assert!(validate(&request).is_err());
    }
}
