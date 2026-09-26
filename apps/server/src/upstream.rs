use super::*;
pub async fn report(app: &App, id: Uuid, event: &str) -> anyhow::Result<()> {
    let row=sqlx::query("SELECT p.resource,s.state FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id WHERE p.id=$1").bind(id).fetch_one(&app.db).await?;
    let encrypted: Value = row.get("resource");
    let resource = app.decrypt(encrypted["encrypted"].as_str().unwrap_or(""))?;
    let Some(base) = resource["upstream_base"].as_str() else {
        return Ok(());
    };
    let state: protocol::RoomState = serde_json::from_value(row.get("state"))?;
    let endpoint = match event {
        "start" => "Sessions/Playing",
        "stop" => "Sessions/Playing/Stopped",
        _ => "Sessions/Playing/Progress",
    };
    let body = json!({"ItemId":resource["upstream_item"],"PlaySessionId":resource["upstream_session"],"PositionTicks":(room_core::position(&state,app.now())*10000.0)as u64,"IsPaused":state.playback_status!=protocol::PlaybackStatus::Playing,"CanSeek":true,"PlayMethod":if resource["transport"]=="hls"{"Transcode"}else{"DirectPlay"}});
    let mut request = providers::client()
        .post(format!("{}/{endpoint}", base.trim_end_matches('/')))
        .json(&body);
    if let Some(headers) = resource["headers"].as_object() {
        for (k, v) in headers {
            if let Some(v) = v.as_str() {
                request = request.header(k, v)
            }
        }
    }
    request.send().await?.error_for_status()?;
    Ok(())
}
pub async fn maintenance(app: App) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        let rows=sqlx::query("SELECT p.id,p.stopped,p.expires_at<now() OR (s.state->>'media_generation')::bigint<>p.generation AS expired,p.resource FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id WHERE NOT (p.resource ? 'upstream_closed')").fetch_all(&app.db).await.unwrap_or_default();
        for row in rows {
            let id: Uuid = row.get("id");
            let stopped: bool = row.get("stopped");
            let expired: bool = row.get("expired");
            if stopped || expired {
                if report(&app, id, "stop").await.is_ok() {
                    let _=sqlx::query("UPDATE playback_sessions SET stopped=true,resource=resource||'{\"upstream_closed\":true}'::jsonb WHERE id=$1").bind(id).execute(&app.db).await;
                }
            } else {
                let _ = report(&app, id, "progress").await;
            }
        }
    }
}
