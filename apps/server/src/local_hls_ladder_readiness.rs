//! Dedicated ladder readiness; master playlists are never scalar EXTINF evidence.
use super::*;

pub(crate) async fn read_authenticated(
    app: &App,
    user: Uuid,
    login_hash: &str,
    session: Uuid,
    requested_generation: Option<u32>,
    relative_position_ms: Option<f64>,
) -> Result<Option<protocol::PlaybackReadiness>> {
    let marked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions p LEFT JOIN media_jobs j ON j.session_id=p.id WHERE p.id=$1 AND (p.resource ? 'local_hls_ladder_version' OR j.logical_queue='local_hls_ladder_v1' OR left(COALESCE(j.spec->>'kind',''),16)='local_hls_ladder'))")
        .bind(session).fetch_one(&app.db).await?;
    if !marked {
        return Ok(None);
    }
    let row=sqlx::query("SELECT p.plan_generation,p.resource,j.status,j.error,v.seq FROM playback_sessions p JOIN media_jobs j ON j.id=p.id AND j.session_id=p.id LEFT JOIN playback_observations v ON v.session_id=p.id WHERE p.id=$1 AND p.user_id=$2 AND p.auth_login_hash=$3 AND local_hls_ladder_session_allowed(p.id) AND playback_source_allowed(p.media_id,p.resource,p.id) AND playback_caller_allowed(p.resource,$2,$3)")
        .bind(session).bind(user).bind(login_hash).fetch_optional(&app.db).await?.ok_or_else(||err(StatusCode::GONE,"invalid_playback_session"))?;
    let generation = u32::try_from(
        row.get::<Option<i64>, _>("plan_generation")
            .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?,
    )
    .map_err(|_| err(StatusCode::GONE, "invalid_playback_session"))?;
    if requested_generation.is_some_and(|g| g != generation) {
        return Err(err(StatusCode::CONFLICT, "stale_playback_plan"));
    }
    let stored: Value = row.get("resource");
    let resource = app.decrypt(stored["encrypted"].as_str().unwrap_or(""))?;
    if resource["kind"] != "local"
        || resource["local_hls_ladder_version"] != 1
        || resource["job_id"]
            .as_str()
            .and_then(|v| Uuid::parse_str(v).ok())
            != Some(session)
    {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    let origin = resource["timeline_origin_ms"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    let status: String = row.get("status");
    match status.as_str() {
        "failed" => {
            let reason: Option<String> = row.get("error");
            let (status, code) = persistence::media_jobs::terminal_error(reason.as_deref());
            return Err(err(StatusCode::from_u16(status).unwrap(), code));
        }
        "cancelled" => return Err(err(StatusCode::GONE, "media_job_cancelled")),
        "queued" | "running" | "succeeded" => {}
        _ => return Err(err(StatusCode::SERVICE_UNAVAILABLE, "media_unavailable")),
    }
    let ready = persistence::local_hls_ladder::read(&app.db, session).await?;
    if status == "succeeded" && ready.is_none() {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, "media_unavailable"));
    }
    let complete = ready.as_ref().is_some_and(|s| s.status == "succeeded");
    let available = ready
        .as_ref()
        .map_or(0.0, |s| s.duration_us as f64 / 1000.0);
    let ranges = if available > 0.0 {
        vec![
            protocol::PlaybackMediaRange::new(origin, origin + available)
                .ok_or_else(|| err(StatusCode::SERVICE_UNAVAILABLE, "media_unavailable"))?,
        ]
    } else {
        vec![]
    };
    let playable =
        ready.is_some() && relative_position_ms.is_none_or(|position| position < available);
    Ok(Some(protocol::PlaybackReadiness {
        session_id: session,
        plan_generation: Some(generation),
        status: if status == "queued" {
            protocol::PreparationStatus::Queued
        } else if playable {
            protocol::PreparationStatus::Ready
        } else {
            protocol::PreparationStatus::Preparing
        },
        complete,
        available_until_ms: Some(available),
        seekable_media_ranges_ms: Some(ranges),
        pending_job_id: (!complete).then_some(session),
        observation_version: row.get::<Option<i64>, _>("seq").map(|_| 1),
        observation_seq: row.get::<Option<i64>, _>("seq").map(|v| v as u64),
    }))
}
