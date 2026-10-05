//! Preparation remains owned independently of the public waiter. This module
//! runs only inside the existing exact, isolated native Worker fixture.
use super::native_tests::{ClientFixtures, seed, seed_with_lifetime};
use super::*;
use crate::static_hls_operation_client::{Client, ParentPreparation};
use media_core::static_hls::contracts::input::FrozenInput;
use std::sync::atomic::AtomicUsize;

mod short_deadline;

async fn state(app: &App, input: &FrozenInput) -> Result<Value> {
    Ok(sqlx::query_scalar("SELECT jsonb_build_object('request_status',r.status,'error_code',r.error_code,'root_deadline_ms',floor(extract(epoch FROM r.static_hls_root_expires_at)*1000)::bigint,'prepare_deadline_ms',floor(extract(epoch FROM r.static_hls_prepare_expires_at)*1000)::bigint,'captures',(SELECT count(*) FROM static_hls_captures WHERE session_id=r.session_id),'grants',(SELECT count(*) FROM playback_sessions WHERE id=r.session_id),'reservation_bytes',(SELECT bytes FROM cache_write_reservations WHERE job_id=c.id),'capture_state',c.state,'phase',c.publication_phase,'positive_disposal',c.state='disposed' AND c.streams_closed_at IS NOT NULL AND c.process_closed_at IS NOT NULL AND c.process_disposition IN ('reaped','never_started') AND c.files_removed_at IS NOT NULL AND c.disposed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id=c.id)) FROM playback_requests r LEFT JOIN static_hls_captures c ON c.session_id=r.session_id WHERE r.session_id=$1")
        .bind(Uuid::parse_str(&input.identity_statement().session_id)?)
        .fetch_one(&app.db).await?)
}

fn unchanged_deadlines(input: &FrozenInput, state: &Value) -> Result<()> {
    ensure!(
        state["root_deadline_ms"] == input.root_deadline_ms()
            && state["prepare_deadline_ms"] == input.preparation_deadline_ms(),
        "preparation renewed an original deadline"
    );
    Ok(())
}

async fn counts(fixtures: &ClientFixtures, input: &FrozenInput) -> Result<[usize; 4]> {
    fixtures
        .prepare_counts
        .lock()
        .await
        .get(&Uuid::parse_str(&input.identity_statement().operation_id)?)
        .copied()
        .context("preparation request counters missing")
}

async fn drained_calls() -> Result<()> {
    let until = tokio::time::Instant::now() + Duration::from_secs(8);
    while crate::static_hls_operation_client::active_calls() != 0 {
        ensure!(
            tokio::time::Instant::now() < until,
            "original preparation RPC cleanup did not drain"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

async fn disposed(app: &App, client: &Client, input: &FrozenInput) -> Result<Value> {
    drained_calls().await?;
    let until = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let observation = client.call(input, Action::Query).await?;
        let state = state(app, input).await?;
        if matches!(observation.result(), OperationResult::Disposed { .. }) {
            ensure!(
                state["positive_disposal"] == true,
                "disposal observation lacked original positive proof"
            );
            unchanged_deadlines(input, &state)?;
            return Ok(state);
        }
        ensure!(
            tokio::time::Instant::now() < until,
            "original preparation owner did not positively dispose: {state}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn published(
    app: &App,
    input: &FrozenInput,
    result: ParentPreparation,
    source_reads: usize,
    fixtures: &ClientFixtures,
    client: &Client,
) -> Result<Value> {
    let ParentPreparation::Published { plan } = result else {
        anyhow::bail!("preparation did not publish original parent");
    };
    let plan: protocol::PlaybackPlan = serde_json::from_value(plan)?;
    ensure!(
        plan.session_id == Uuid::parse_str(&input.identity_statement().session_id)?
            && plan.transport == "hls",
        "preparation returned a different parent"
    );
    let original = client.published_plan(input).await?;
    ensure!(
        original.playback_url == plan.playback_url
            && original.expires_in_seconds <= plan.expires_in_seconds
    );
    let current = state(app, input).await?;
    unchanged_deadlines(input, &current)?;
    ensure!(
        current["request_status"] == "completed"
            && current["captures"] == 1
            && current["grants"] == 1
            && current["reservation_bytes"] == 134_217_728
            && current["phase"] == "published_parent",
        "preparation lost original custody: {current}"
    );
    let resources = app
        .static_hls_operations
        .original_snapshot(input)
        .await?
        .live_evidence()?
        .inventory
        .len();
    ensure!(
        source_reads == resources * 2,
        "preparation repeated capture/publication source reads"
    );
    let calls = counts(fixtures, input).await?;
    ensure!(
        calls[0] == 1 && calls[2] == 1,
        "preparation repeated create/publish: {calls:?}"
    );
    // A completed request uses replay; it cannot obtain another preparation.
    ensure!(
        client
            .prepare_owned_parent(input, std::future::pending())
            .await
            .is_err()
    );
    ensure!(state(app, input).await?["request_status"] == "completed");
    Ok(
        json!({"operation":input.identity_statement().operation_id,"before_disposal":current,
        "source_reads":source_reads,"graph_resources":resources,"calls":calls}),
    )
}

pub(super) async fn exercise(
    app: &App,
    base: &str,
    url: &str,
    reads: &AtomicUsize,
    fixtures: &ClientFixtures,
    read_fixtures: Arc<super::read_tests::ReadFixtures>,
) -> Result<Value> {
    let worker = url
        .strip_suffix("/media-delivery/static-hls-operation")
        .context("Worker URL")?;
    let caller = |mode: &str| {
        Client::new(
            app.db.clone(),
            app.key.clone(),
            app.cache.clone(),
            &format!("{worker}/{mode}"),
        )
    };
    let normal = Client::new(app.db.clone(), app.key.clone(), app.cache.clone(), worker)?;
    let mut cases = serde_json::Map::new();
    let save = |phase: &str, cases: &serde_json::Map<String, Value>| -> Result<()> {
        std::fs::write(
            app.cache.join("prepare-evidence.json"),
            serde_json::to_vec_pretty(
                &json!({"phase":phase,"cases":cases,"public_hls_activated":false}),
            )?,
        )?;
        Ok(())
    };
    for mode in [
        "prepare-normal",
        "prepare-create-delay",
        "prepare-publish-delay",
    ] {
        save(mode, &cases)?;
        let input = seed(app, base).await?;
        *fixtures.prepare_target.lock().await =
            Some(Uuid::parse_str(&input.identity_statement().operation_id)?);
        let before = reads.load(Ordering::SeqCst);
        let client = caller(mode)?;
        let result = client
            .prepare_owned_parent(&input, std::future::pending())
            .await?;
        let mut evidence = published(
            app,
            &input,
            result,
            reads.load(Ordering::SeqCst) - before,
            fixtures,
            &normal,
        )
        .await?;
        if mode != "prepare-normal" {
            ensure!(
                counts(fixtures, &input).await?[1] > 0,
                "lost reply was not followed by query"
            );
        }
        normal.call(&input, Action::Cancel).await?;
        evidence["after_disposal"] = disposed(app, &normal, &input).await?;
        cases.insert(mode.to_owned(), evidence);
    }
    save("prepare-waiter-exit", &cases)?;
    let input = seed(app, base).await?;
    let before = reads.load(Ordering::SeqCst);
    let client = caller("prepare-create-pause")?;
    let retained = input.clone();
    let (notify, wait) = tokio::sync::oneshot::channel::<()>();
    let owned_preparation = tokio::spawn(async move {
        let result = client
            .prepare_owned_parent(&retained, std::future::pending())
            .await;
        let _ = notify.send(());
        result
    });
    let public_waiter = tokio::spawn(wait);
    tokio::time::timeout(
        Duration::from_secs(2),
        fixtures.prepare_pause_seen.notified(),
    )
    .await
    .context("owned preparation create gate not reached")?;
    public_waiter.abort();
    ensure!(
        public_waiter
            .await
            .err()
            .context("public waiter remained")?
            .is_cancelled()
    );
    ensure!(
        !owned_preparation.is_finished() && crate::static_hls_operation_client::active_calls() == 1,
        "public waiter exit lost original preparation"
    );
    fixtures.prepare_pause_release.notify_one();
    let result = owned_preparation.await??;
    let mut evidence = published(
        app,
        &input,
        result,
        reads.load(Ordering::SeqCst) - before,
        fixtures,
        &normal,
    )
    .await?;
    normal.call(&input, Action::Cancel).await?;
    evidence["after_disposal"] = disposed(app, &normal, &input).await?;
    cases.insert("prepare-waiter-exit".to_owned(), evidence);

    for cancelled in [true, false] {
        let mode = if cancelled {
            "prepare-cancel"
        } else {
            "prepare-expired"
        };
        save(mode, &cases)?;
        let input = seed_with_lifetime(app, base, if cancelled { 45_000 } else { 6_000 }).await?;
        std::fs::write(
            app.cache.join(format!(
                "prepare-active-{}.json",
                input.identity_statement().operation_id
            )),
            serde_json::to_vec_pretty(
                &json!({"phase":mode,"operation":input.identity_statement().operation_id,
                "session":input.identity_statement().session_id,"root_deadline_ms":input.root_deadline_ms(),
                "prepare_deadline_ms":input.preparation_deadline_ms()}),
            )?,
        )?;
        read_fixtures.armed.store(true, Ordering::SeqCst);
        let client = caller("prepare-normal")?;
        let retained = input.clone();
        let (cancel, cancelled_signal) = tokio::sync::oneshot::channel::<()>();
        let preparation = tokio::spawn(async move {
            client
                .prepare_owned_parent(&retained, async {
                    let _ = cancelled_signal.await;
                })
                .await
        });
        tokio::time::timeout(Duration::from_secs(4), read_fixtures.seen.notified())
            .await
            .context("preparation actual upstream body gate not reached")?;
        let held = state(app, &input).await?;
        ensure!(held["reservation_bytes"] == 134_217_728 && held["grants"] == 0);
        if cancelled {
            cancel
                .send(())
                .map_err(|_| anyhow::anyhow!("original cancel receiver lost"))?;
        } else {
            // Keep the cancel sender alive through the original expiry.
            ensure!(!preparation.is_finished());
        }
        let result = preparation.await?;
        if let Err(error) = &result {
            ensure!(
                error.to_string()
                    == if cancelled {
                        "static_hls_preparation_cancelled"
                    } else {
                        "static_hls_preparation_expired"
                    },
                "unexpected preparation failure: {error:#}"
            );
        } else {
            anyhow::bail!("cancelled/expired preparation produced a grant");
        }
        let closed = disposed(app, &normal, &input).await?;
        ensure!(
            closed["request_status"] == "failed"
                && closed["grants"] == 0
                && closed["captures"] == 1
        );
        let calls = counts(fixtures, &input).await?;
        ensure!(
            calls[0] == 1 && calls[2] == 0,
            "cancel/expiry repeated work or published"
        );
        cases.insert(
            mode.to_owned(),
            json!({"held_before_end":held,"after_disposal":closed,"calls":calls}),
        );
    }

    save("prepare-short-1500", &cases)?;
    cases.insert(
        "prepare-short-1500".to_owned(),
        short_deadline::exercise(
            app,
            base,
            &caller("prepare-short-1500")?,
            reads,
            fixtures,
            &read_fixtures,
        )
        .await?,
    );

    save("prepare-missing-owner", &cases)?;
    let input = seed(app, base).await?;
    normal.call(&input, Action::Create).await?;
    let until = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if matches!(
            normal.call(&input, Action::Query).await?.result(),
            OperationResult::Verified { .. }
        ) {
            break;
        }
        ensure!(
            tokio::time::Instant::now() < until,
            "missing-owner original capture not verified"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let before = reads.load(Ordering::SeqCst);
    let result = caller("prepare-missing-owner")?
        .prepare_owned_parent(&input, std::future::pending())
        .await;
    ensure!(
        result
            .err()
            .context("missing owner became a grant")?
            .to_string()
            == "static_hls_preparation_unknown"
    );
    let unknown = fixtures
        .prepare_unknown
        .lock()
        .await
        .clone()
        .context("unknown custody evidence missing")?;
    ensure!(
        unknown["state"] == "verified"
            && unknown["reservation_bytes"] == 134_217_728
            && unknown["disposed_at"].is_null(),
        "unknown observation released original resources"
    );
    let closed = disposed(app, &normal, &input).await?;
    let calls = counts(fixtures, &input).await?;
    ensure!(
        closed["captures"] == 1
            && closed["grants"] == 0
            && calls[0] == 1
            && calls[2] == 0
            && reads.load(Ordering::SeqCst) == before
    );
    cases.insert("prepare-missing-owner".to_owned(), json!({"unknown_observation":unknown,"after_original_disposal":closed,"calls":calls,"new_source_reads":0}));

    save("prepare-qualification-ended", &cases)?;
    let input = seed(app, base).await?;
    let quota = app.cache.join("prepare-owned-logical-quota-fixture");
    std::fs::File::create(&quota)?.set_len(std::env::var("CACHE_MAX_BYTES")?.parse()?)?;
    let before = reads.load(Ordering::SeqCst);
    let result = caller("prepare-normal")?
        .prepare_owned_parent(&input, std::future::pending())
        .await?;
    let ParentPreparation::QualificationEnded { observation } = result else {
        anyhow::bail!("capacity refusal became a grant");
    };
    ensure!(matches!(
        observation.result(),
        OperationResult::Refused {
            capture_id: None,
            ..
        }
    ));
    let unchanged = state(app, &input).await?;
    unchanged_deadlines(&input, &unchanged)?;
    ensure!(
        unchanged["request_status"] == "pending"
            && unchanged["captures"] == 0
            && unchanged["grants"] == 0
            && reads.load(Ordering::SeqCst) == before
    );
    std::fs::remove_file(quota)?;
    normal.call(&input, Action::Cancel).await?;
    cases.insert(
        "prepare-qualification-ended".to_owned(),
        json!({"observation":unchanged,"native_grant":false}),
    );
    drained_calls().await?;
    save("complete", &cases)?;
    Ok(json!({"complete":true,"cases":cases,"passed":9,"public_hls_activated":false}))
}
