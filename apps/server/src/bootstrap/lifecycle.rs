//! Background maintenance and shutdown retain the original resource owners.
//! A cancelled request, elapsed lease or listener grace timeout is not a drain receipt.
use crate::*;

pub(super) async fn serve(
    app: App,
    media_authority: bool,
    control_shutdown: Arc<std::sync::atomic::AtomicBool>,
) -> anyhow::Result<()> {
    let db = app.db.clone();
    let readiness = app.readiness.clone();
    let control_cluster = app.control_cluster.clone();
    if media_authority {
        let cleanup = db.clone();
        let compute_cleanup = app.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                let _ = distributed_compute::cleanup(&compute_cleanup).await;
                for query in [
                    "DELETE FROM room_events WHERE created_at<now()-interval '24 hours'",
                    "DELETE FROM chat_messages WHERE created_at<now()-interval '7 days'",
                    "DELETE FROM room_reactions WHERE expires_at<now()",
                    "DELETE FROM room_reaction_receipts WHERE created_at<now()-interval '48 hours'",
                    "DELETE FROM sessions WHERE token_hash IN(SELECT token_hash FROM sessions WHERE expires_at<clock_timestamp() LIMIT 1000)",
                    "UPDATE guest_principals SET revoked_at=clock_timestamp(),display_name='游客' WHERE user_id IN(SELECT user_id FROM guest_principals WHERE revoked_at IS NULL AND expires_at<=clock_timestamp() LIMIT 1000)",
                    "DELETE FROM playback_http_representations WHERE (session_id,target_sha256) IN (SELECT h.session_id,h.target_sha256 FROM playback_http_representations h JOIN playback_sessions p ON p.id=h.session_id WHERE p.stopped AND p.expires_at<clock_timestamp()-interval '48 hours' AND NOT EXISTS(SELECT 1 FROM playback_preparations prep WHERE prep.session_id=p.id AND prep.drained_at IS NULL) LIMIT 1000)",
                    "DELETE FROM login_attempts WHERE window_started<=now()-interval '60 seconds'",
                    "DELETE FROM account_rate_limits WHERE expires_at<=clock_timestamp()",
                    "DELETE FROM agent_transfers WHERE expires_at<now()",
                    "UPDATE agent_transfer_runs SET status='failed',reason='transfer_owner_lost',updated_at=now(),finished_at=now(),agent_drained_at=CASE WHEN dispatched_at IS NULL AND NOT legacy_unconfirmed THEN COALESCE(agent_drained_at,clock_timestamp()) ELSE agent_drained_at END WHERE finished_at IS NULL AND lease_until<=now()",
                    "DELETE FROM agent_transfer_runs WHERE NOT legacy_unconfirmed AND finished_at<now()-interval '24 hours' AND (session_id IS NULL OR agent_drained_at IS NOT NULL)",
                    "DELETE FROM playback_requests r WHERE r.static_hls_input_version IS NULL AND NOT EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.session_id=r.session_id) AND r.expires_at<now() AND NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=r.session_id AND NOT p.stopped AND p.expires_at>now())",
                    // Preserve the positive ledger proof across a failed marker write.
                    // These statements acquire session rows only; do not invert the
                    // session-before-upstream lock order used by Stop/close.
                    "UPDATE playback_sessions p SET stopped=true,resource=resource||'{\"upstream_closed\":true}'::jsonb WHERE NOT(p.resource @> '{\"upstream_closed\":true}'::jsonb) AND EXISTS(SELECT 1 FROM upstream_reservations u WHERE u.id=p.id AND u.state='closed')",
                    "DELETE FROM upstream_reservations u WHERE u.state='closed' AND u.closed_at<now()-interval '48 hours' AND NOT EXISTS(SELECT 1 FROM room_cleanup_tasks c WHERE c.room_id=u.room_id AND c.completed_at IS NULL) AND NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=u.id AND NOT(p.resource @> '{\"upstream_closed\":true}'::jsonb))",
                    "DELETE FROM playback_observations o WHERE o.created_at<now()-interval '48 hours' AND NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=o.session_id AND NOT p.stopped AND p.expires_at>now()) AND NOT EXISTS(SELECT 1 FROM upstream_reservations u WHERE u.id=o.session_id AND u.state<>'closed')",
                ] {
                    let _ = sqlx::query(query).execute(&cleanup).await;
                }
                let _ = persistence::cleanup_control_history(&cleanup).await;
                let _ = persistence::static_hls_history::prune_batch(&cleanup).await;
                let _ = persistence::room_cleanup::prune_receipts(&cleanup).await;
            }
        });
        tokio::spawn(upstream::maintenance(app.clone()));
        tokio::spawn(upstream_policy::maintenance(app.clone()));
    }
    tokio::spawn(room_cleanup::run(app.clone()));
    let _account_exit_cleanup = account_exit_cleanup::Maintenance::start(app.clone());
    let _guest_cleanup = guests::Maintenance::start(app.clone());
    let mut platform_renewal =
        media_authority.then(|| platform_accounts::maintenance::Maintenance::start(app.clone()));
    let preparations = app.preparations.clone();
    let upstream = app.upstream.clone();
    let live_playback = app.live_playback.clone();
    let other_live_playback = app.other_live_playback.clone();
    let platform_oauth_exchanges = app.platform_oauth_exchanges.clone();
    let native_transcode_delivery = app.native_transcode_delivery.clone();
    let native_delivery_owners = app.native_delivery_owners.clone();
    let router = super::routes::router(app);
    let listener = tokio::net::TcpListener::bind(super::config::listener_address()).await?;
    readiness.accepting(true);
    tracing::info!("RainSync server ready");
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = stopped.await;
    })
    .into_future();
    tokio::pin!(server);
    let server_result = tokio::select! {
        result = &mut server => result,
        signal = media_core::process_signal::wait() => {
            readiness.accepting(false);
            control_shutdown.store(true, std::sync::atomic::Ordering::Release);
            if let Some(cluster) = &control_cluster { cluster.close(); }
            preparations.close();
            static_hls_operation_client::close();
            upstream.close_admission();
            live_playback.close_admission();
            other_live_playback.close_admission();
            native_transcode_delivery.close_admission();
            native_delivery_owners.close_admission();
            if let Some(renewal) = &mut platform_renewal { renewal.close(); }
            platform_oauth_exchanges.close();
            let _ = stop.send(());
            // A stalled request or long-lived connection cannot delay process
            // shutdown indefinitely. Keep the instance lock throughout draining.
            let grace = signal.as_ref().map_or(std::time::Duration::ZERO, |reason| reason.http_grace());
            let result = tokio::time::timeout(grace, &mut server)
                .await.unwrap_or(Ok(()));
            signal.map(|_| ()).and(result)
        },
    };
    readiness.accepting(false);
    control_shutdown.store(true, std::sync::atomic::Ordering::Release);
    if let Some(cluster) = &control_cluster {
        cluster.close();
    }
    // Fence late HTTP admission and retain the application runtime through
    // reservation commits, scoped resource disposal and durable receipt retries.
    // Instance-lock loss intentionally skips this barrier and remains unknown.
    upstream.close_admission();
    live_playback.close_admission();
    other_live_playback.close_admission();
    native_transcode_delivery.close_admission();
    native_delivery_owners.close_admission();
    if let Some(renewal) = &mut platform_renewal {
        renewal.close();
    }
    platform_oauth_exchanges.close();
    static_hls_operation_client::close();
    let (
        _,
        _,
        upstream_result,
        live_result,
        other_live_result,
        native_transcode_result,
        native_delivery_result,
        platform_renewal_result,
        oauth_exchange_result,
    ) = tokio::join!(
        preparations.drain(),
        static_hls_operation_client::drain(),
        upstream.drain(),
        live_playback.drain(),
        other_live_playback.drain(),
        native_transcode_delivery.drain(),
        native_delivery_owners.drain(),
        async {
            match &mut platform_renewal {
                Some(renewal) => renewal.drain().await,
                None => Ok(()),
            }
        },
        platform_oauth_exchanges.drain()
    );
    // Also drain after listener failure: cancelling a request does not itself
    // wait for the independent ffprobe process owner to reap its descendants.
    media_core::child_process::shutdown().await?;
    upstream_result?;
    live_result?;
    other_live_result?;
    native_transcode_result?;
    native_delivery_result?;
    platform_renewal_result
        .map_err(|_| anyhow::anyhow!("platform account renewal drain unconfirmed"))?;
    oauth_exchange_result
        .map_err(|_| anyhow::anyhow!("platform OAuth exchange drain unconfirmed"))?;
    server_result?;
    Ok(())
}
