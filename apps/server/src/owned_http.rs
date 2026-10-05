//! Complete-response HTTP custody is selected only by explicit fresh transcode.
//! It is not an external version pin or automatic continuation right.
use super::*;
pub(crate) fn fresh_binary_request(body: &protocol::PlaybackRequest) -> bool {
    body.mode.as_deref() == Some("transcode")
        && body.candidate_report.is_none()
        && body.http_file_fallback.is_none()
        && body.advanced_playback.is_none()
        && body.local_hls_ladder.is_none()
        && body.static_hls_fallback_version.is_none()
        && body.finite_hls_version.is_none()
}
/// Initial preparation policy only. It is established once, before a request
/// lease is issued, and never renewed by a slow source or later keepalive.
pub(crate) async fn initial_preparation_seconds(
    app: &App,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    body: &protocol::PlaybackRequest,
    state: &Value,
) -> Result<u64> {
    crate::finite_hls::validate(body)?;
    if body.finite_hls_version == Some(1) {
        return Ok(65);
    }
    if !fresh_binary_request(body) {
        return Ok(45);
    }
    let media = state["media_id"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok());
    let row=sqlx::query("SELECT m.resource,s.kind,s.config_encrypted FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND m.available").bind(media).fetch_optional(&mut **tx).await?;
    let Some(row) = row else {
        return Ok(45);
    };
    if row.get::<String, _>("kind") != "http" {
        return Ok(45);
    }
    let config: providers::SourceConfig =
        serde_json::from_value(app.decrypt(&row.get::<String, _>("config_encrypted"))?)
            .map_err(anyhow::Error::from)?;
    let target = providers::validate_url(&config.url)?;
    if target.path().to_ascii_lowercase().ends_with(".m3u8") {
        return Ok(45);
    }
    Ok(350)
}
pub(crate) fn select(
    body: &protocol::PlaybackRequest,
    resource: &mut Value,
    continuation: bool,
    session: Uuid,
) -> Result<()> {
    if crate::finite_hls::select(body, resource, continuation, session)? {
        return Ok(());
    }
    if body.mode.as_deref() != Some("transcode")
        || resource["kind"] != "http"
        || body.candidate_report.is_some()
        || continuation
        || body.advanced_playback.is_some()
        || body.local_hls_ladder.is_some()
        || body.static_hls_fallback_version.is_some()
    {
        return Ok(());
    }
    // Known HLS keeps its existing typed playlist path. This complete binary
    // representation slice never retags a playlist into an owned single file.
    if resource["url"]
        .as_str()
        .and_then(|value| providers::validate_url(value).ok())
        .is_some_and(|url| url.path().to_ascii_lowercase().ends_with(".m3u8"))
    {
        return Ok(());
    }
    if !cfg!(target_os = "linux") {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "owned_http_linux_required",
        ));
    }
    playback_requests::http_file_fallback::restrict_binary(resource)?;
    resource["http_owned_response_version"] = json!(1);
    resource["http_owned_large_response_version"] = json!(1);
    resource["owned_http_session_id"] = json!(session);
    Ok(())
}
/// The completed owned descriptor must remain authorized between its probe
/// and atomic final publication. Other HTTP provisional probes still retire.
pub(crate) fn keep_provisional(resource: &Value) -> bool {
    resource["kind"] == "http" && resource["http_owned_response_version"] == 1
}
pub(crate) async fn deadline(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    resource: &Value,
) -> Result<Option<i64>> {
    if resource.get("http_owned_response_version").is_none() {
        return Ok(None);
    }
    if resource["http_owned_response_version"] != 1 || resource["kind"] != "http" {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    let deadline:Option<i64>=sqlx::query_scalar("SELECT floor(extract(epoch FROM expires_at)*1000)::bigint FROM owned_http_representations WHERE session_id=$1 AND state='ready' AND target_sha256=$2 AND owned_http_representation_authority_allowed(session_id)").bind(id).bind(hash(resource["url"].as_str().ok_or_else(||err(StatusCode::CONFLICT,"source_changed"))?)).fetch_optional(&mut **tx).await?;
    deadline
        .map(Some)
        .ok_or_else(|| err(StatusCode::CONFLICT, "source_version_required"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_fresh_transcode_selects_owned_whole_response() {
        let mut body:protocol::PlaybackRequest=serde_json::from_value(json!({"room_id":Uuid::nil(),"media_generation":0,"position_ms":0.0,"mode":"transcode"})).unwrap();
        let mut resource = json!({"kind":"http","url":"https://source.test/a.mp4"});
        select(&body, &mut resource, false, Uuid::nil()).unwrap();
        assert_eq!(resource["http_owned_response_version"], 1);
        assert!(keep_provisional(&resource));
        assert_eq!(resource["http_file_binary_only"]["version"], 1);
        for mode in ["auto", "direct", "remux"] {
            body.mode = Some(mode.into());
            let mut r = json!({"kind":"http"});
            select(&body, &mut r, false, Uuid::nil()).unwrap();
            assert!(r.get("http_owned_response_version").is_none());
            assert!(!keep_provisional(&r));
        }
        body.mode = Some("transcode".into());
        let mut hls = json!({"kind":"http","url":"https://source.test/a.M3U8?token=bound"});
        select(&body, &mut hls, false, Uuid::nil()).unwrap();
        assert!(hls.get("http_owned_response_version").is_none());
        body.mode = Some("transcode".into());
        let mut r = json!({"kind":"http"});
        select(&body, &mut r, true, Uuid::nil()).unwrap();
        assert!(r.get("http_owned_response_version").is_none());
    }
}
