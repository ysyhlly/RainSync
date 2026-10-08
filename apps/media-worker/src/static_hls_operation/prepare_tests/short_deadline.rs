//! Diagnose the original 1.5 second budget without requiring a body gate.
//! A missing gate never proves non-admission or physical disposal.
use super::*;
use std::io::Write;

fn record(log: &mut std::fs::File, event: Value) -> Result<()> {
    serde_json::to_writer(&mut *log, &event)?;
    log.write_all(b"\n")?;
    log.flush()?;
    Ok(())
}

async fn snapshot(
    app: &App,
    input: &FrozenInput,
    fixtures: &ClientFixtures,
    source_reads: usize,
    body_gate: bool,
    elapsed_ms: u128,
) -> Result<Value> {
    tokio::time::timeout(
        Duration::from_secs(2),
        observe(app, input, fixtures, source_reads, body_gate, elapsed_ms),
    )
    .await
    .context("short deadline observation is unknown")?
}

async fn observe(
    app: &App,
    input: &FrozenInput,
    fixtures: &ClientFixtures,
    source_reads: usize,
    body_gate: bool,
    elapsed_ms: u128,
) -> Result<Value> {
    let operation = Uuid::parse_str(&input.identity_statement().operation_id)?;
    let mut value = tokio::time::timeout(Duration::from_millis(750), state(app, input))
        .await
        .context("short deadline state observation timed out")??;
    let times: Value = tokio::time::timeout(Duration::from_millis(750),
        sqlx::query_scalar("SELECT jsonb_build_object('observed_ms',floor(extract(epoch FROM clock_timestamp())*1000)::bigint,'request_created_ms',floor(extract(epoch FROM r.created_at)*1000)::bigint,'capture_id',c.id,'capture_created_ms',floor(extract(epoch FROM c.created_at)*1000)::bigint,'capture_expires_ms',floor(extract(epoch FROM c.expires_at)*1000)::bigint,'streams_closed_ms',floor(extract(epoch FROM c.streams_closed_at)*1000)::bigint,'process_closed_ms',floor(extract(epoch FROM c.process_closed_at)*1000)::bigint,'process_disposition',c.process_disposition,'files_removed_ms',floor(extract(epoch FROM c.files_removed_at)*1000)::bigint,'disposed_ms',floor(extract(epoch FROM c.disposed_at)*1000)::bigint,'budget_revision',(SELECT revision FROM cache_budget WHERE singleton)) FROM playback_requests r LEFT JOIN static_hls_captures c ON c.session_id=r.session_id WHERE r.session_id=$1")
            .bind(Uuid::parse_str(&input.identity_statement().session_id)?)
            .fetch_one(&app.db)).await.context("short deadline timeline observation timed out")??;
    let entry = app
        .static_hls_operations
        .0
        .entries
        .lock()
        .await
        .get(&operation)
        .cloned();
    let local = if let Some(entry) = entry {
        let state = entry.state.lock().await;
        let (kind, refused_admitted) = match &*state {
            EntryState::Capture => ("capture", None),
            EntryState::Unknown => ("unknown", None),
            EntryState::Verified { .. } => ("verified", None),
            EntryState::Refused { admitted, .. } => ("refused", Some(*admitted)),
        };
        json!({"state":kind,"refused_admitted":refused_admitted,
            "admitted":entry.admitted.load(Ordering::SeqCst),
            "admission_attempted":entry.admission_attempted.load(Ordering::SeqCst),
            "original_owner_present":entry.owner.get().is_some(),
            "original_control_present":entry.control.get().is_some(),
            "cancelled":entry.cancelled.load(Ordering::SeqCst)})
    } else {
        json!({"state":"absent"})
    };
    let calls = fixtures
        .prepare_counts
        .lock()
        .await
        .get(&operation)
        .copied()
        .unwrap_or([0; 4]);
    value["times"] = times;
    value["local"] = local;
    value["calls"] = json!(calls);
    value["source_reads"] = json!(source_reads);
    value["body_gate_seen"] = json!(body_gate);
    value["elapsed_ms"] = json!(elapsed_ms);
    value["active_rpc_calls"] = json!(crate::static_hls_operation_client::active_calls());
    Ok(value)
}

fn invariants(root: u64, preparation: u64, value: &Value) -> Result<()> {
    ensure!(
        value["root_deadline_ms"] == root && value["prepare_deadline_ms"] == preparation,
        "short preparation changed an original deadline"
    );
    ensure!(
        value["calls"][0]
            .as_u64()
            .context("missing create counter")?
            <= 1
            && value["calls"][2] == 0
            && value["grants"] == 0
            && value["captures"]
                .as_u64()
                .context("missing capture count")?
                <= 1,
        "short preparation duplicated capture or published: {value}"
    );
    if value["captures"] == 1 {
        ensure!(
            value["times"]["capture_expires_ms"] == root,
            "short preparation renewed capture root"
        );
    }
    Ok(())
}

fn conclusion(
    root: u64,
    preparation: u64,
    operation: &str,
    result: &str,
    value: &Value,
) -> Result<&'static str> {
    invariants(root, preparation, value)?;
    ensure!(
        result == "static_hls_preparation_expired"
            || (result == "static_hls_preparation_authority_revoked"
                && value["result_observed_ms"]
                    .as_u64()
                    .context("missing database observation time")?
                    >= preparation),
        "short preparation ended with an unexpected result: {result}"
    );
    ensure!(
        value["request_status"] == "failed" && value["active_rpc_calls"] == 0,
        "short preparation has not terminalized its original request/RPC"
    );
    if value["captures"] == 1 {
        ensure!(
            value["times"]["capture_id"] == operation
                && value["positive_disposal"] == true
                && value["reservation_bytes"].is_null(),
            "short preparation admission has no original positive disposal"
        );
        return Ok(if value["body_gate_seen"] == true {
            "admitted_body_gate_then_expired"
        } else {
            "admitted_without_observed_body_gate_then_expired"
        });
    }
    ensure!(
        value["reservation_bytes"].is_null() && value["source_reads"] == 0,
        "short preparation non-admission has resource activity"
    );
    let local = &value["local"];
    ensure!(
        (value["calls"][0] == 0 && local["state"] == "absent")
            || (local["state"] == "refused"
                && local["refused_admitted"] == false
                && local["admitted"] == false
                && local["original_owner_present"] == false),
        "short preparation non-admission is uncertain; retain original scope"
    );
    Ok("expired_with_confirmed_non_admission")
}

pub(super) async fn exercise(
    app: &App,
    base: &str,
    client: &Client,
    reads: &AtomicUsize,
    fixtures: &ClientFixtures,
    read_fixtures: &super::super::read_tests::ReadFixtures,
) -> Result<Value> {
    drained_calls().await?;
    let input = seed_with_lifetime(app, base, 1_500).await?;
    let identity = input.identity_statement();
    let path = app.cache.join(format!(
        "prepare-short-1500-{}.jsonl",
        identity.operation_id
    ));
    let mut log = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    record(
        &mut log,
        json!({"event":"identity","operation":identity.operation_id,
        "session":identity.session_id,"preparation_budget_ms":1500,
        "root_deadline_ms":input.root_deadline_ms(),"prepare_deadline_ms":input.preparation_deadline_ms(),
        "coordinator_observation_bound_ms":10000,"owner_observation_bound_ms":10000}),
    )?;
    let before = reads.load(Ordering::SeqCst);
    let began = tokio::time::Instant::now();
    let first = snapshot(app, &input, fixtures, 0, false, began.elapsed().as_millis()).await?;
    record(
        &mut log,
        json!({"event":"before_coordinator","snapshot":first}),
    )?;
    ensure!(
        first["times"]["request_created_ms"]
            .as_u64()
            .context("missing original creation time")?
            + 1_500
            == input.preparation_deadline_ms(),
        "short fixture is not the original 1500ms preparation budget"
    );
    read_fixtures.armed.store(true, Ordering::SeqCst);
    let retained = input.clone();
    let caller = client.clone();
    let mut preparation = tokio::spawn(async move {
        caller
            .prepare_owned_parent(&retained, std::future::pending())
            .await
    });
    let gate = read_fixtures.seen.notified();
    tokio::pin!(gate);
    let bound = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(bound);
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut body_gate = false;
    let result = loop {
        tokio::select! {
            biased;
            result = &mut preparation => { break result; }
            _ = &mut bound => {
                record(&mut log, json!({"event":"coordinator_unconfirmed","elapsed_ms":began.elapsed().as_millis()}))?;
                anyhow::bail!("original short preparation task did not reach terminal; retain scope");
            }
            _ = &mut gate, if !body_gate => {
                body_gate = true;
                record(&mut log, json!({"event":"body_gate","elapsed_ms":began.elapsed().as_millis()}))?;
            }
            _ = tick.tick() => {
                let observed = snapshot(app, &input, fixtures, reads.load(Ordering::SeqCst)-before,
                    body_gate, began.elapsed().as_millis()).await;
                match observed {
                    Ok(value) => {
                        record(&mut log, json!({"event":"during_coordinator","snapshot":value}))?;
                        invariants(input.root_deadline_ms(), input.preparation_deadline_ms(), &value)?;
                    }
                    Err(error) => {
                        record(&mut log, json!({"event":"snapshot_failed","error":format!("{error:#}")}))?;
                        return Err(error);
                    }
                }
            }
        }
    };
    let result_code = match result {
        Ok(Err(error)) => error.to_string(),
        Ok(Ok(ParentPreparation::Published { .. })) => "unexpected_publication".into(),
        Ok(Ok(ParentPreparation::QualificationEnded { .. })) => {
            "unexpected_qualification_end".into()
        }
        Err(error) => format!("owned_task_join_error:{error}"),
    };
    record(
        &mut log,
        json!({"event":"coordinator_terminal","actual_result":result_code,
        "elapsed_ms":began.elapsed().as_millis(),"body_gate_seen":body_gate}),
    )?;
    let until = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut result_observed_ms = None;
    loop {
        // Continue observing the SAME original owner; never create a substitute.
        tokio::select! {
            biased;
            _ = &mut gate, if !body_gate => { body_gate = true; }
            _ = std::future::ready(()) => {}
        }
        let mut value = snapshot(
            app,
            &input,
            fixtures,
            reads.load(Ordering::SeqCst) - before,
            body_gate,
            began.elapsed().as_millis(),
        )
        .await?;
        value["result_observed_ms"] = result_observed_ms
            .get_or_insert_with(|| value["times"]["observed_ms"].clone())
            .clone();
        record(
            &mut log,
            json!({"event":"after_coordinator","snapshot":value}),
        )?;
        invariants(
            input.root_deadline_ms(),
            input.preparation_deadline_ms(),
            &value,
        )?;
        match conclusion(
            input.root_deadline_ms(),
            input.preparation_deadline_ms(),
            &identity.operation_id,
            &result_code,
            &value,
        ) {
            Ok(classification) => {
                read_fixtures.armed.store(false, Ordering::SeqCst);
                let evidence = json!({"operation":identity.operation_id,"session":identity.session_id,
                    "actual_result":result_code,"classification":classification,"preparation_budget_ms":1500,
                    "timeline":path.file_name().and_then(|v|v.to_str()),"initial":first,"terminal":value,
                    "body_gate_seen":body_gate,"original_owner_only":true});
                record(
                    &mut log,
                    json!({"event":"strict_conclusion","evidence":evidence}),
                )?;
                return Ok(evidence);
            }
            Err(error) if tokio::time::Instant::now() >= until => {
                record(
                    &mut log,
                    json!({"event":"strict_conclusion_failed","error":format!("{error:#}"),"snapshot":value}),
                )?;
                return Err(error);
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn not_admitted() -> Value {
        json!({"root_deadline_ms":9000,"prepare_deadline_ms":1500,"captures":0,"grants":0,
            "calls":[0,0,0,0],"request_status":"failed","active_rpc_calls":0,
            "reservation_bytes":null,"source_reads":0,"body_gate_seen":false,
            "times":{"observed_ms":1500},"result_observed_ms":1500,"local":{"state":"absent"}})
    }

    #[test]
    fn absent_gate_requires_positive_non_admission_or_disposal() {
        let mut value = not_admitted();
        assert!(
            conclusion(
                9000,
                1500,
                "original",
                "static_hls_preparation_expired",
                &value
            )
            .is_ok()
        );
        value["calls"][0] = json!(1);
        value["local"] = json!({"state":"refused","refused_admitted":false,"admission_attempted":false,
            "admitted":false,"original_owner_present":false});
        assert!(
            conclusion(
                9000,
                1500,
                "original",
                "static_hls_preparation_expired",
                &value
            )
            .is_ok()
        );
        value["local"]["admission_attempted"] = json!(true);
        // An actual Refused(false) admission receipt proves non-admission;
        // an uncertain COMMIT becomes Unknown instead and cannot pass.
        assert!(
            conclusion(
                9000,
                1500,
                "original",
                "static_hls_preparation_expired",
                &value
            )
            .is_ok()
        );
        value["local"]["state"] = json!("unknown");
        assert!(
            conclusion(
                9000,
                1500,
                "original",
                "static_hls_preparation_expired",
                &value
            )
            .is_err()
        );
    }

    #[test]
    fn container_or_request_terminal_is_not_capture_disposal() {
        let mut value = not_admitted();
        value["captures"] = json!(1);
        value["times"]["capture_id"] = json!("original");
        value["times"]["capture_expires_ms"] = json!(9000);
        value["positive_disposal"] = json!(false);
        assert!(
            conclusion(
                9000,
                1500,
                "original",
                "static_hls_preparation_expired",
                &value
            )
            .is_err()
        );
        value["positive_disposal"] = json!(true);
        value["reservation_bytes"] = json!(134217728);
        assert!(
            conclusion(
                9000,
                1500,
                "original",
                "static_hls_preparation_expired",
                &value
            )
            .is_err()
        );
        value["reservation_bytes"] = Value::Null;
        assert_eq!(
            conclusion(
                9000,
                1500,
                "original",
                "static_hls_preparation_expired",
                &value
            )
            .unwrap(),
            "admitted_without_observed_body_gate_then_expired"
        );
        value["times"]["capture_id"] = json!("replacement");
        assert!(
            conclusion(
                9000,
                1500,
                "original",
                "static_hls_preparation_expired",
                &value
            )
            .is_err()
        );
    }

    #[test]
    fn original_deadlines_and_single_creation_are_mandatory() {
        for key in ["root_deadline_ms", "prepare_deadline_ms"] {
            let mut value = not_admitted();
            value[key] = json!(99999);
            assert!(
                conclusion(
                    9000,
                    1500,
                    "original",
                    "static_hls_preparation_expired",
                    &value
                )
                .is_err()
            );
        }
        for (key, index) in [("calls", 0), ("calls", 2)] {
            let mut value = not_admitted();
            value[key][index] = json!(2);
            assert!(
                conclusion(
                    9000,
                    1500,
                    "original",
                    "static_hls_preparation_expired",
                    &value
                )
                .is_err()
            );
        }
        let mut value = not_admitted();
        value["grants"] = json!(1);
        assert!(
            conclusion(
                9000,
                1500,
                "original",
                "static_hls_preparation_expired",
                &value
            )
            .is_err()
        );
    }

    #[test]
    fn revocation_needs_database_expiry_and_unknown_never_passes() {
        let mut value = not_admitted();
        value["result_observed_ms"] = json!(1499);
        assert!(
            conclusion(
                9000,
                1500,
                "original",
                "static_hls_preparation_authority_revoked",
                &value
            )
            .is_err()
        );
        value["result_observed_ms"] = json!(1500);
        assert!(
            conclusion(
                9000,
                1500,
                "original",
                "static_hls_preparation_authority_revoked",
                &value
            )
            .is_ok()
        );
        for result in [
            "static_hls_preparation_unknown",
            "static_hls_preparation_cancelled",
            "unexpected_publication",
        ] {
            assert!(conclusion(9000, 1500, "original", result, &value).is_err());
        }
        value["active_rpc_calls"] = json!(1);
        assert!(
            conclusion(
                9000,
                1500,
                "original",
                "static_hls_preparation_expired",
                &value
            )
            .is_err()
        );
    }
}
