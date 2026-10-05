use super::*;
use media_core::static_hls::contracts::input::FrozenInput;

pub(super) async fn exercise(
    app: &App,
    worker: &str,
    input: &FrozenInput,
    client: &crate::static_hls_operation_client::Client,
    reads: &std::sync::atomic::AtomicUsize,
) -> Result<Value> {
    let before = reads.load(Ordering::SeqCst);
    let original = client.published_plan(input).await?;
    let operation = Uuid::parse_str(&input.identity_statement().operation_id)?;
    let session = Uuid::parse_str(&input.identity_statement().session_id)?;
    let repeated = client.replay_published(operation, session).await?;
    ensure!(
        original.session_id == session
            && repeated.session_id == session
            && original.playback_url == repeated.playback_url
            && repeated.expires_in_seconds <= original.expires_in_seconds
            && original
                .duration_ms
                .is_some_and(|duration| duration > 0.0 && duration.is_finite())
            && original.duration_ms == repeated.duration_ms
            && original.timeline_origin_ms == repeated.timeline_origin_ms,
        "public replay changed original plan or duration"
    );
    ensure!(
        original.delivery_mode == "direct"
            && original.transport == "hls"
            && !original.rebuild_on_seek
            && original
                .decoder_fallback_modes
                .as_ref()
                .is_some_and(|modes| modes.is_empty())
            && original.http_file_fallback_version.is_none()
            && original.pending_job_id.is_none()
            && original.observation_version.is_none()
            && original.playback_metrics_version.is_none()
    );
    let wire = serde_json::to_value(&original)?;
    let clear = serde_json::to_string(&wire)?;
    for private in [
        "input_sha256",
        "root_digest",
        "root_hard_expires_at_ms",
        "static_hls_capture_id",
        "inventory",
        "source_config",
        "encrypted",
        "http://127.0.0.1",
    ] {
        ensure!(
            !clear.contains(private),
            "private publication metadata leaked to browser"
        );
    }
    let parsed: protocol::PlaybackPlan = serde_json::from_value(wire.clone())?;
    ensure!(
        parsed
            .playback_url
            .starts_with(&format!("/media-delivery/{session}/static-hls/"))
            && parsed.media_id == Uuid::parse_str(&input.identity_statement().media_id)?
            && parsed.media_generation
                == u32::try_from(input.identity_statement().media_generation)?
            && parsed.plan_generation
                == Some(u32::try_from(input.identity_statement().plan_generation)?)
    );
    let response = client.call(input, Action::Query).await?;
    let published = response
        .published_result_statement()
        .context("publication missing")?;
    let original_reply: Value =
        serde_json::from_slice(&open_storage(app, published.reply_encrypted)?)?;
    for field in [
        "delivery_token",
        "input_sha256",
        "root_digest",
        "root_hard_expires_at_ms",
    ] {
        let mut malformed = original_reply.clone();
        malformed[field] = if field == "root_hard_expires_at_ms" {
            json!(input.root_deadline_ms() + 1)
        } else {
            json!("f".repeat(64))
        };
        let mut statement: Value = serde_json::from_slice(response.private_transport_plaintext())?;
        statement["result"]["reply_encrypted"] =
            json!(seal_storage(app, &serde_json::to_vec(&malformed)?)?);
        let fake = OperationResponse::parse_private_plaintext(&serde_json::to_vec(&statement)?)?;
        ensure!(
            crate::static_hls_parent_plan::from_original_receipt(&app.db, &app.key, input, &fake)
                .await
                .is_err(),
            "foreign publication data became a public plan"
        );
    }
    let absent = crate::static_hls_operation_client::Client::new(
        app.db.clone(),
        app.key.clone(),
        app.cache.clone(),
        &format!("{worker}/missing-read"),
    )?;
    ensure!(
        absent.published_plan(input).await.is_err(),
        "missing original Worker snapshot became a plan"
    );
    ensure!(
        reads.load(Ordering::SeqCst) == before,
        "public plan replay performed source IO"
    );
    let captures: i64 = sqlx::query_scalar("SELECT count(*) FROM static_hls_captures WHERE id=$1")
        .bind(operation)
        .fetch_one(&app.db)
        .await?;
    let held: i64 =
        sqlx::query_scalar("SELECT bytes FROM cache_write_reservations WHERE job_id=$1")
            .bind(operation)
            .fetch_one(&app.db)
            .await?;
    ensure!(captures == 1 && held == 134217728);
    let resource = reqwest::get(format!("{worker}{}", original.playback_url)).await?;
    ensure!(
        resource.status() == StatusCode::OK && resource.text().await?.starts_with("#EXTM3U"),
        "public playback URL did not read original manifest"
    );
    Ok(
        json!({"plan":wire,"original_capture_count":captures,"reservation_bytes":held,
        "replay_source_reads":0,"original_worker_required":true,"browser_playback_verified":false}),
    )
}
