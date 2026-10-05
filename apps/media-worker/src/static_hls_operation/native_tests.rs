//! Owned PG/cache/HTTP test of the actual Worker operation endpoint.
use super::*;
use aes_gcm::{KeyInit, Nonce, aead::Aead};
use axum::{Router, body::Body};
use media_core::static_hls::contracts::input::FrozenInput;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub(super) async fn seed(app: &App, url: &str) -> Result<FrozenInput> {
    seed_with_lifetime(app, url, 45_000).await
}

pub(super) async fn seed_with_lifetime(
    app: &App,
    url: &str,
    preparation_ms: i64,
) -> Result<FrozenInput> {
    let user = Uuid::new_v4();
    let room = Uuid::new_v4();
    let source = Uuid::new_v4();
    let media = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let login = hex::encode(Sha256::digest(Uuid::new_v4().as_bytes()));
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'owned-rpc-fixture')")
        .bind(user)
        .bind(format!("rpc_{user}"))
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,'owned',clock_timestamp()+interval '1 hour')").bind(&login).bind(user).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,'owned RPC',$2)")
        .bind(room)
        .bind(user)
        .execute(&mut *tx)
        .await?;
    let member: Uuid = sqlx::query_scalar(
        "INSERT INTO room_members(room_id,user_id) VALUES($1,$2) RETURNING membership_epoch",
    )
    .bind(room)
    .bind(user)
    .fetch_one(&mut *tx)
    .await?;
    let config = json!({"url":format!("{url}/"),"headers":{},"access_policy":{"schema_version":1,"origins":[{"origin":url,"cidrs":["127.0.0.0/8"]}],"redirects":{"max_hops":1}}});
    sqlx::query("INSERT INTO sources(id,name,kind,config_encrypted,access_policy_revision) VALUES($1,'owned','http',$2,1)").bind(source).bind(seal_storage(app,&serde_json::to_vec(&config)?)?).execute(&mut *tx).await?;
    let generation:i64=sqlx::query_scalar("INSERT INTO media_items(id,source_id,title,resource,source_version) VALUES($1,$2,'owned',$3,'owned-1') RETURNING preview_generation").bind(media).bind(source).bind(format!("{url}/index.m3u8")).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO room_snapshots(room_id,state) VALUES($1,$2)")
        .bind(room)
        .bind(json!({"media_id":media,"media_generation":0}))
        .execute(&mut *tx)
        .await?;
    let database: Uuid =
        sqlx::query_scalar("SELECT id FROM static_hls_database_binding WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    let at: i64 =
        sqlx::query_scalar("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    let mut value: Value = serde_json::from_str(include_str!(
        "../../../../crates/media-core/src/static_hls/contracts/golden_input_v1.json"
    ))?;
    for (name, uuid) in [
        ("operation_id", Uuid::new_v4()),
        ("session_id", Uuid::new_v4()),
        ("request_owner_epoch", Uuid::new_v4()),
        ("user_id", user),
        ("room_id", room),
        ("media_id", media),
        ("viewer_id", viewer),
        ("auth_membership_epoch", member),
        ("database", database),
        ("worker_instance", *crate::static_hls_contract::INSTANCE),
    ] {
        value[name] = json!(uuid);
    }
    value["auth_login_hash"] = json!(login);
    value["request_sha256"] = json!(hex::encode(Sha256::digest(Uuid::new_v4().as_bytes())));
    value["root_admitted_at_ms"] = json!(at);
    value["root_hard_expires_at_ms"] = json!(at + 1_800_000);
    value["prepare_started_at_ms"] = json!(at);
    value["prepare_expires_at_ms"] = json!(at + preparation_ms);
    value["source"] = json!({"kind":"http","source_id":source,"source_policy_revision":1,"media_source_generation":generation,
        "configured_base_url":format!("{url}/"),"canonical_target":format!("{url}/index.m3u8"),"headers":[],"access_policy":config["access_policy"]});
    let input = FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value)?)?;
    let row=sqlx::query("SELECT m.id AS media_id,m.source_id,m.resource,m.source_version,m.preview_generation,s.kind,s.config_encrypted,s.access_policy_revision FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1").bind(media).fetch_one(&app.db).await?;
    let prepared = pending::PreparedParentInput::seal(
        input.clone(),
        pending::CatalogSnapshot::from_row(&row),
        |bytes| seal_storage(app, bytes),
    )?;
    ensure!(matches!(
        pending::freeze(&app.db, Uuid::new_v4(), &prepared, 16).await?,
        pending::Freeze::Frozen
    ));
    Ok(input)
}

async fn envelope(
    app: &App,
    input: &FrozenInput,
    action: Action,
) -> Result<(
    String,
    ExpectedBinding,
    media_core::static_hls_probe::OwnedProbe,
)> {
    let challenge = Uuid::new_v4();
    let mut bytes = [0u8; 64];
    for chunk in bytes.chunks_mut(16) {
        chunk.copy_from_slice(Uuid::new_v4().as_bytes());
    }
    let digest = hex::encode(Sha256::digest(bytes));
    let mut probe = media_core::static_hls_probe::OwnedProbe::create(
        &app.cache,
        &challenge.to_string(),
        bytes,
    )?;
    probe.write_nonce()?;
    let until:i64=sqlx::query_scalar("UPDATE static_hls_database_binding SET probe_challenge=$1,probe_sha256=$2,probe_until=clock_timestamp()+interval '6 seconds' WHERE singleton RETURNING floor(extract(epoch FROM probe_until)*1000)::bigint").bind(challenge).bind(&digest).fetch_one(&app.db).await?;
    let expected = ExpectedBinding::from_trusted_input(
        input,
        &input.identity_statement(),
        ChallengeObservation {
            challenge: challenge.to_string(),
            cache_challenge_sha256: digest,
            challenge_expires_at_ms: until as u64,
        },
        RpcWindow {
            issued_at_ms: now_ms()?,
            rpc_expires_at_ms: now_ms()? + 5000,
        },
        now_ms()?,
    )?;
    // A complete pending request was created by seed. The Worker independently
    // reads SQL authority rather than trusting this sender's statement.
    let identity = input.identity_statement();
    let loaded = pending::load_operation(
        &app.db,
        Uuid::parse_str(&identity.operation_id)?,
        Uuid::parse_str(&identity.session_id)?,
        |text| open_storage(app, text),
    )
    .await?
    .context("original operation missing")?;
    let authority = || {
        if action == Action::Publish {
            CallAuthority::LivePublication(LivePublicationAuthorityStatement {
                current_identity: &identity,
                current_authority_live: loaded.publication_authority_live,
                observed_at_ms: loaded.observed_at_ms,
                pending: loaded.publication_pending,
                pending_lease_expires_at_ms: loaded.pending_lease_expires_at_ms,
            })
        } else if action == Action::Create {
            CallAuthority::LivePending(LivePendingAuthorityStatement {
                current_identity: &identity,
                current_authority_live: true,
                observed_at_ms: now_ms().unwrap(),
                pending_lease_expires_at_ms: input.preparation_deadline_ms(),
            })
        } else {
            CallAuthority::ObservationOnly
        }
    };
    let request = OperationRequest::for_expected(action, &expected, now_ms()?, authority())?;
    let random = Uuid::new_v4();
    let nonce = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13].map(|i| random.as_bytes()[i]);
    let wire = crate::static_hls_operation_cipher::seal_request(
        &app.key,
        nonce,
        &request,
        action,
        &expected,
        now_ms()?,
        authority(),
    )?;
    Ok((wire, expected, probe))
}
async fn reply(
    client: &reqwest::Client,
    url: &str,
    app: &App,
    input: &FrozenInput,
    action: Action,
) -> Result<(String, Value)> {
    let (wire, expected, mut probe) = envelope(app, input, action).await?;
    let response = client.post(url).body(wire.clone()).send().await?;
    ensure!(
        response.status() == StatusCode::OK,
        "operation status {}",
        response.status()
    );
    ensure!(response.headers()[header::CACHE_CONTROL] == "no-store");
    let body = response.bytes().await?;
    let identity = input.identity_statement();
    let authority = if action == Action::Create {
        CallAuthority::LivePending(LivePendingAuthorityStatement {
            current_identity: &identity,
            current_authority_live: true,
            observed_at_ms: now_ms()?,
            pending_lease_expires_at_ms: input.preparation_deadline_ms(),
        })
    } else {
        CallAuthority::ObservationOnly
    };
    let decoded = crate::static_hls_operation_cipher::open_response(
        &app.key,
        &body,
        action,
        &expected,
        now_ms()?,
        authority,
    )?;
    let value = serde_json::from_slice(decoded.private_transport_plaintext())?;
    probe.remove_owned()?;
    Ok((wire, value))
}

fn unchecked_wire(app: &App, plain: &[u8]) -> Result<String> {
    let random = Uuid::new_v4();
    let nonce = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13].map(|i| random.as_bytes()[i]);
    let encrypted = app
        .key
        .encrypt(Nonce::from_slice(&nonce), plain)
        .map_err(|_| anyhow::anyhow!("fixture encryption"))?;
    let mut bytes = nonce.to_vec();
    bytes.extend(encrypted);
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        bytes,
    ))
}

async fn reject_wire(
    client: &reqwest::Client,
    url: &str,
    wire: String,
    status: StatusCode,
) -> Result<()> {
    let response = client.post(url).body(wire).send().await?;
    ensure!(
        response.status() == status,
        "rejection status {}",
        response.status()
    );
    if status == StatusCode::SERVICE_UNAVAILABLE {
        ensure!(response.headers()[header::CACHE_CONTROL] == "no-store");
        ensure!(
            response.bytes().await?.is_empty(),
            "private diagnostic leaked"
        );
    }
    Ok(())
}

async fn rejection_matrix(
    client: &reqwest::Client,
    url: &str,
    app: &App,
    input: &FrozenInput,
) -> Result<()> {
    reject_wire(
        client,
        url,
        "invalid authenticated envelope".into(),
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await?;
    reject_wire(client, url, "x".repeat(4097), StatusCode::PAYLOAD_TOO_LARGE).await?;
    for fault in ["duplicate_json", "purpose", "worker", "expiry", "input"] {
        let (wire, _, mut probe) = envelope(app, input, Action::Query).await?;
        let request =
            crate::static_hls_operation_cipher::authenticate_request(&app.key, wire.as_bytes())?;
        let plain = request.private_transport_plaintext();
        let altered = if fault == "duplicate_json" {
            let text = std::str::from_utf8(plain)?;
            ensure!(text.starts_with('{') && text.contains("\"purpose\""));
            let value: Value = serde_json::from_slice(plain)?;
            let purpose = serde_json::to_string(&value["purpose"])?;
            format!("{{\"purpose\":{purpose},{}", &text[1..]).into_bytes()
        } else {
            let mut value: Value = serde_json::from_slice(plain)?;
            match fault {
                "purpose" => value["purpose"] = json!("unknown_purpose"),
                "worker" => value["binding"]["worker_instance"] = json!(Uuid::new_v4()),
                "expiry" => {
                    value["binding"]["issued_at_ms"] = json!(0);
                    value["binding"]["rpc_expires_at_ms"] = json!(1);
                }
                "input" => value["binding"]["input_sha256"] = json!("0".repeat(64)),
                _ => unreachable!(),
            }
            serde_json::to_vec(&value)?
        };
        reject_wire(
            client,
            url,
            unchecked_wire(app, &altered)?,
            StatusCode::SERVICE_UNAVAILABLE,
        )
        .await?;
        probe.remove_owned()?;
    }
    Ok(())
}

#[derive(Clone, Default)]
pub(super) struct ClientFixtures {
    paused_seen: Arc<tokio::sync::Notify>,
    paused_release: Arc<tokio::sync::Notify>,
    mutate_seen: Arc<tokio::sync::Notify>,
    mutate_release: Arc<tokio::sync::Notify>,
    replay: Arc<Mutex<Option<Vec<u8>>>>,
    pub(super) prepare_pause_seen: Arc<tokio::sync::Notify>,
    pub(super) prepare_pause_release: Arc<tokio::sync::Notify>,
    prepare_create_delayed: Arc<std::sync::atomic::AtomicBool>,
    prepare_create_paused: Arc<std::sync::atomic::AtomicBool>,
    prepare_publication_delayed: Arc<std::sync::atomic::AtomicBool>,
    pub(super) prepare_target: Arc<Mutex<Option<Uuid>>>,
    pub(super) prepare_counts: Arc<Mutex<HashMap<Uuid, [usize; 4]>>>,
    pub(super) prepare_unknown: Arc<Mutex<Option<Value>>>,
}

struct ReleaseProbeGate(Arc<crate::static_hls_operation_client::ProbeGate>);
impl Drop for ReleaseProbeGate {
    fn drop(&mut self) {
        self.0.release();
    }
}

async fn client_fixture_reply(
    app: App,
    body: axum::body::Bytes,
    mode: &'static str,
    fixtures: ClientFixtures,
) -> axum::response::Response {
    let original = app.clone();
    let preparation = mode.starts_with("prepare-");
    let request = preparation.then(|| {
        crate::static_hls_operation_cipher::authenticate_request(&app.key, &body).unwrap()
    });
    let operation = request.as_ref().map(|request| {
        let value: Value = serde_json::from_slice(request.private_transport_plaintext()).unwrap();
        Uuid::parse_str(value["binding"]["operation_id"].as_str().unwrap()).unwrap()
    });
    if let (Some(request), Some(operation)) = (&request, operation) {
        let index = match request.action() {
            Action::Create => 0,
            Action::Query => 1,
            Action::Publish => 2,
            Action::Cancel => 3,
            Action::PublishChild => {
                return (
                    StatusCode::CONFLICT,
                    "parent_fixture_rejects_child_publication",
                )
                    .into_response();
            }
        };
        fixtures
            .prepare_counts
            .lock()
            .await
            .entry(operation)
            .or_default()[index] += 1;
    }
    let response = endpoint(axum::extract::State(app), body)
        .await
        .into_response();
    if response.status() != StatusCode::OK {
        return response;
    }
    let body = axum::body::to_bytes(response.into_body(), 8192)
        .await
        .unwrap();
    let reply = match mode {
        "delay" => {
            tokio::time::sleep(Duration::from_secs(3)).await;
            Body::from(body)
        }
        "pause" => {
            fixtures.paused_seen.notify_one();
            fixtures.paused_release.notified().await;
            Body::from(body)
        }
        "mutate" => {
            fixtures.mutate_seen.notify_one();
            fixtures.mutate_release.notified().await;
            Body::from(body)
        }
        "replay" => {
            let mut replay = fixtures.replay.lock().await;
            Body::from(replay.get_or_insert_with(|| body.to_vec()).clone())
        }
        "oversize" => Body::from_stream(futures_util::stream::iter([
            Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(vec![b'x'; 5000])),
            Ok(axum::body::Bytes::from(vec![b'x'; 3193])),
        ])),
        "prepare-create-delay" => {
            if request.as_ref().unwrap().action() == Action::Create
                && !fixtures.prepare_create_delayed.swap(true, Ordering::SeqCst)
            {
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            Body::from(body)
        }
        "prepare-create-pause" => {
            if request.as_ref().unwrap().action() == Action::Create
                && !fixtures.prepare_create_paused.swap(true, Ordering::SeqCst)
            {
                fixtures.prepare_pause_seen.notify_one();
                fixtures.prepare_pause_release.notified().await;
            }
            Body::from(body)
        }
        "prepare-publish-delay" => {
            let target = *fixtures.prepare_target.lock().await;
            let entry = match target {
                Some(target) => original
                    .static_hls_operations
                    .0
                    .entries
                    .lock()
                    .await
                    .get(&target)
                    .cloned(),
                None => None,
            };
            if request.as_ref().unwrap().action() == Action::Publish
                && let Some(entry) = entry
                && !matches!(*entry.publication.lock().await, PublicationState::Dormant)
                && !fixtures
                    .prepare_publication_delayed
                    .swap(true, Ordering::SeqCst)
            {
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            Body::from(body)
        }
        "prepare-normal" | "prepare-short-1500" => Body::from(body),
        "prepare-missing-owner" => {
            if request.as_ref().unwrap().action() == Action::Create {
                let state: Value = sqlx::query_scalar("SELECT jsonb_build_object('state',c.state,'reservation_bytes',r.bytes,'disposed_at',c.disposed_at) FROM static_hls_captures c LEFT JOIN cache_write_reservations r ON r.job_id=c.id WHERE c.id=$1")
                    .bind(operation.unwrap()).fetch_one(&original.db).await.unwrap();
                *fixtures.prepare_unknown.lock().await = Some(state);
            }
            Body::from(body)
        }
        _ => unreachable!(),
    };
    axum::http::Response::builder()
        .status(StatusCode::OK)
        .header(header::CACHE_CONTROL, "no-store")
        .body(reply)
        .unwrap()
}

struct CaptureFailureDiagnostic {
    cache: PathBuf,
    capture: Arc<media_core::static_hls::VerifiedCapture>,
    complete: bool,
}

impl Drop for CaptureFailureDiagnostic {
    fn drop(&mut self) {
        if !self.complete {
            let _ = std::fs::write(
                self.cache.join(format!("capture-client-failure-{}.json", Uuid::new_v4())),
                serde_json::to_vec_pretty(&json!({
                    "original_capture_failure":self.capture.diagnostic_failure(),
                    "live_evidence_failure":self.capture.live_evidence().err().map(|error| error.to_string())
                })).unwrap_or_default(),
            );
        }
    }
}

async fn server_client_round_trip(
    app: &App,
    base: &str,
    url: &str,
    reads: &std::sync::atomic::AtomicUsize,
    fixtures: &ClientFixtures,
    read_fixtures: Arc<super::read_tests::ReadFixtures>,
) -> Result<Value> {
    use crate::static_hls_operation_client as sender;
    let worker = url
        .strip_suffix("/media-delivery/static-hls-operation")
        .context("worker base")?;
    let caller = |prefix: &str| {
        sender::Client::new(
            app.db.clone(),
            app.key.clone(),
            app.cache.clone(),
            &format!("{worker}{prefix}"),
        )
    };
    let normal = caller("")?;
    let input = seed(app, base).await?;
    app.static_hls_operations.open();
    let decode = |reply: &OperationResponse| -> Result<Value> {
        Ok(serde_json::from_slice(reply.private_transport_plaintext())?)
    };
    let first = decode(&normal.call(&input, Action::Create).await?)?;
    ensure!(first["result"]["kind"] == "pending");
    let until = tokio::time::Instant::now() + Duration::from_secs(10);
    let verified = loop {
        let value = decode(&normal.call(&input, Action::Query).await?)?;
        if value["result"]["kind"] == "verified" {
            break value;
        }
        ensure!(
            tokio::time::Instant::now() < until,
            "Server client did not observe verified"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let original_capture = app.static_hls_operations.original_snapshot(&input).await?;
    let mut failure_diagnostic = CaptureFailureDiagnostic {
        cache: app.cache.clone(),
        capture: original_capture.clone(),
        complete: false,
    };
    let before = reads.load(Ordering::SeqCst);
    ensure!(decode(&normal.call(&input, Action::Create).await?)?["result"]["kind"] == "verified");
    ensure!(reads.load(Ordering::SeqCst) == before);

    let replay = caller("/replay")?;
    ensure!(decode(&replay.call(&input, Action::Query).await?)?["result"]["kind"] == "verified");
    ensure!(
        replay.call(&input, Action::Query).await.is_err(),
        "old response echo accepted"
    );
    ensure!(
        caller("/oversize")?
            .call(&input, Action::Query)
            .await
            .is_err(),
        "oversize stream accepted"
    );
    let late_input = seed(app, base).await?;
    ensure!(
        caller("/delay")?
            .call(&late_input, Action::Create)
            .await
            .is_err(),
        "late create reply accepted"
    );
    let until = tokio::time::Instant::now() + Duration::from_secs(10);
    let late_verified = loop {
        let value = decode(&normal.call(&late_input, Action::Query).await?)?;
        if value["result"]["kind"] == "verified" {
            break value;
        }
        ensure!(
            tokio::time::Instant::now() < until,
            "lost create did not retain original owner"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let before = reads.load(Ordering::SeqCst);
    ensure!(
        decode(&normal.call(&late_input, Action::Create).await?)?["result"]["kind"] == "verified"
    );
    ensure!(
        reads.load(Ordering::SeqCst) == before,
        "lost create started duplicate source work"
    );
    ensure!(
        decode(&normal.call(&late_input, Action::Cancel).await?)?["result"]["kind"]
            == "cancel_requested"
    );
    let until = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if decode(&normal.call(&late_input, Action::Query).await?)?["result"]["kind"] == "disposed"
        {
            break;
        }
        ensure!(
            tokio::time::Instant::now() < until,
            "lost-create owner did not dispose"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let paused = caller("/pause")?;
    let retained = input.clone();
    let waiting = tokio::spawn(async move { paused.call(&retained, Action::Query).await });
    tokio::time::timeout(Duration::from_secs(2), fixtures.paused_seen.notified())
        .await
        .context("Server client query pause was not reached")?;
    waiting.abort();
    match waiting.await {
        Err(error) => ensure!(error.is_cancelled()),
        Ok(_) => anyhow::bail!("waiter was not cancelled"),
    }
    ensure!(sender::active_calls() == 1);
    fixtures.paused_release.notify_one();
    let until = tokio::time::Instant::now() + Duration::from_secs(2);
    while sender::active_calls() != 0 {
        ensure!(
            tokio::time::Instant::now() < until,
            "dropped call lost cleanup owner"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let mutated = caller("/mutate")?;
    let retained = input.clone();
    let waiting = tokio::spawn(async move { mutated.call(&retained, Action::Query).await });
    tokio::time::timeout(Duration::from_secs(2), fixtures.mutate_seen.notified())
        .await
        .context("Server client probe mutation gate was not reached")?;
    let probes = std::fs::read_dir(&app.cache)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(".static-hls-probe-")
        })
        .collect::<Vec<_>>();
    ensure!(probes.len() == 1);
    let path = probes[0].path();
    let original = std::fs::read(&path)?;
    ensure!(original.len() == 64);
    std::fs::write(&path, [99u8; 64])?;
    fixtures.mutate_release.notify_one();
    ensure!(waiting.await?.is_err());
    ensure!(sender::active_calls() == 1 && std::fs::read(&path)? == [99u8; 64]);
    ensure!(
        normal.call(&input, Action::Query).await.is_err(),
        "uncertain cleanup slot released"
    );
    std::fs::write(&path, original)?;
    let until = tokio::time::Instant::now() + Duration::from_secs(3);
    while sender::active_calls() != 0 {
        ensure!(
            tokio::time::Instant::now() < until,
            "original probe retry did not finish"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    ensure!(!path.exists());
    let gate = Arc::new(sender::ProbeGate::default());
    let _release_on_error = ReleaseProbeGate(gate.clone());
    let gated = normal.clone().with_probe_gate(gate.clone());
    let retained = input.clone();
    let began = tokio::time::Instant::now();
    let waiting = tokio::spawn(async move { gated.call(&retained, Action::Query).await });
    tokio::time::timeout(Duration::from_secs(2), gate.entered.notified())
        .await
        .context("Server client probe constructor gate was not reached")?;
    ensure!(
        waiting.await?.is_err(),
        "blocked constructor did not bound caller wait"
    );
    tokio::time::sleep_until(began + Duration::from_millis(5250)).await;
    ensure!(
        sender::active_calls() == 1,
        "unfinished constructor lost its lifetime"
    );
    let files = std::fs::read_dir(&app.cache)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(".static-hls-probe-")
        })
        .collect::<Vec<_>>();
    ensure!(files.len() == 1 && std::fs::metadata(files[0].path())?.len() == 0);
    gate.release();
    let until = tokio::time::Instant::now() + Duration::from_secs(3);
    while sender::active_calls() != 0 {
        ensure!(
            tokio::time::Instant::now() < until,
            "late constructor was not drained and cleaned"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    ensure!(!files[0].path().exists());
    ensure!(
        reads.load(Ordering::SeqCst) == before,
        "observations re-read source"
    );
    // Accept the actual publication, then drop its Server waiter before the
    // private HTTP response is delivered. Original Worker responsibility stays.
    let paused = caller("/pause")?;
    let retained = input.clone();
    let waiting = tokio::spawn(async move { paused.call(&retained, Action::Publish).await });
    tokio::time::timeout(Duration::from_secs(2), fixtures.paused_seen.notified())
        .await
        .context("Server client publication pause was not reached")?;
    waiting.abort();
    ensure!(
        waiting
            .await
            .err()
            .context("publication waiter did not cancel")?
            .is_cancelled()
    );
    fixtures.paused_release.notify_one();
    let until = tokio::time::Instant::now() + Duration::from_secs(3);
    while sender::active_calls() != 0 {
        ensure!(
            tokio::time::Instant::now() < until,
            "publication caller cleanup did not drain"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let until = tokio::time::Instant::now() + Duration::from_secs(10);
    let published = loop {
        let value = decode(&normal.call(&input, Action::Query).await?)?;
        if value["result"]["kind"] == "published" {
            break value;
        }
        if tokio::time::Instant::now() >= until {
            let row:Value=sqlx::query_scalar("SELECT jsonb_build_object('request_status',r.status,'prepare_remaining',extract(epoch FROM(r.static_hls_prepare_expires_at-clock_timestamp())),'capture_state',c.state,'capture_phase',c.publication_phase,'response_present',r.response_encrypted IS NOT NULL,'session_present',p.id IS NOT NULL) FROM playback_requests r LEFT JOIN static_hls_captures c ON c.session_id=r.session_id LEFT JOIN playback_sessions p ON p.id=r.session_id WHERE r.session_id=$1")
                .bind(Uuid::parse_str(&input.identity_statement().session_id)?).fetch_one(&app.db).await?;
            std::fs::write(
                app.cache.join("publication-query-timeout.json"),
                serde_json::to_vec_pretty(&json!({"last_reply":value,"rows":row,
                    "original_capture_failure":original_capture.diagnostic_failure()}))?,
            )?;
            anyhow::bail!("lost publication reply did not retain original owner");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let original_reply = published["result"]["reply_encrypted"]
        .as_str()
        .context("publication ciphertext missing")?;
    let clear = open_storage(app, original_reply)?;
    let private_reply: Value = serde_json::from_slice(&clear)?;
    ensure!(
        private_reply["session_id"] == input.identity_statement().session_id
            && private_reply["static_hls_capture_id"] == input.identity_statement().operation_id
    );
    let published_reads = reads.load(Ordering::SeqCst);
    let repeated = decode(&normal.call(&input, Action::Publish).await?)?;
    ensure!(
        repeated["result"]["reply_encrypted"] == original_reply
            && repeated["result"]["published_at_ms"] == published["result"]["published_at_ms"]
            && reads.load(Ordering::SeqCst) == published_reads
    );
    ensure!(
        caller("/delay")?
            .call(&input, Action::Publish)
            .await
            .is_err(),
        "late publication response accepted"
    );
    let replayed = decode(&normal.call(&input, Action::Query).await?)?;
    ensure!(
        replayed["result"]["reply_encrypted"] == original_reply
            && reads.load(Ordering::SeqCst) == published_reads
    );
    let grants: i64 = sqlx::query_scalar("SELECT count(*) FROM playback_sessions WHERE id=$1")
        .bind(Uuid::parse_str(&input.identity_statement().session_id)?)
        .fetch_one(&app.db)
        .await?;
    ensure!(grants == 1);
    let reserved: i64 =
        sqlx::query_scalar("SELECT bytes FROM cache_write_reservations WHERE job_id=$1")
            .bind(Uuid::parse_str(&input.identity_statement().operation_id)?)
            .fetch_one(&app.db)
            .await?;
    ensure!(
        reserved == 134217728,
        "publication released original reservation"
    );
    let plan_evidence = super::plan_tests::exercise(app, worker, &input, &normal, reads).await?;
    let read_evidence =
        super::read_tests::exercise(app, worker, &input, &private_reply, reads, read_fixtures)
            .await?;
    ensure!(
        normal.published_plan(&input).await.is_err(),
        "revoked parent became a public plan"
    );
    let cancelled = decode(&normal.call(&input, Action::Cancel).await?)?;
    if cancelled["result"]["kind"] == "disposed" {
        let closed: bool=sqlx::query_scalar("SELECT state='disposed' AND streams_closed_at IS NOT NULL AND process_closed_at IS NOT NULL AND process_disposition='reaped' AND files_removed_at IS NOT NULL AND disposed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id=c.id) FROM static_hls_captures c WHERE id=$1")
            .bind(Uuid::parse_str(&input.identity_statement().operation_id)?).fetch_one(&app.db).await?;
        ensure!(
            closed,
            "already-disposed cancel lacked original positive closure"
        );
    } else {
        ensure!(cancelled["result"]["kind"] == "cancel_requested");
    }
    app.static_hls_operations.close().await;
    app.static_hls_operations.drain().await;
    let disposed = decode(&normal.call(&input, Action::Query).await?)?;
    ensure!(disposed["result"]["kind"] == "disposed");
    app.deliveries.close();
    app.deliveries.drain().await;
    let unreaped: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM media_executions WHERE session_id=$1 AND reaped_at IS NULL",
    )
    .bind(Uuid::parse_str(&input.identity_statement().session_id)?)
    .fetch_one(&app.db)
    .await?;
    ensure!(
        unreaped == 0,
        "public reads lost original delivery drainage receipts"
    );
    let challenge: Option<Uuid> = sqlx::query_scalar(
        "SELECT probe_challenge FROM static_hls_database_binding WHERE singleton",
    )
    .fetch_one(&app.db)
    .await?;
    ensure!(challenge.is_none());
    ensure!(std::fs::read_dir(&app.cache)?.all(|e| {
        !e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".static-hls-probe-")
    }));
    sender::drain().await;
    ensure!(sender::active_calls() == 0 && normal.call(&input, Action::Query).await.is_err());
    failure_diagnostic.complete = true;
    Ok(
        json!({"create":first,"verified":verified,"cancel":cancelled,"disposed":disposed,
        "late_create_verified":late_verified,"published":published,"publication_replayed":replayed,
        "source_reads_before_observations":before,"source_reads_after_observations":before,
        "source_reads_after_publication":published_reads,"duplicate_publication_source_reads":0,
        "probe_files":0,"probe_challenge":null,"active_calls":0,"public_plan":plan_evidence,"public_read":read_evidence,"public_hls_activated":false}),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "owned PostgreSQL, cache and actual native Worker HTTP operation fixture"]
async fn owned_worker_operation_round_trip() -> Result<()> {
    let run = Uuid::parse_str(&std::env::var("RAINSYNC_OWNED_TEST_RUN_ID")?)?;
    let dburl = std::env::var("RAINSYNC_OWNED_TEST_DATABASE_URL")?;
    ensure!(dburl.starts_with("postgresql://postgres@127.0.0.1:"));
    let db = persistence::connect(&dburl).await?;
    let marker: Uuid =
        sqlx::query_scalar("SELECT run_id FROM rainsync_owned_test_binding WHERE singleton")
            .fetch_one(&db)
            .await?;
    ensure!(marker == run);
    let name: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&db)
        .await?;
    ensure!(name == format!("rainsync_pending_{}", run.simple()));
    let cache = PathBuf::from("/tmp/rainsync-worker-operation");
    std::fs::create_dir(&cache)?;
    let source = cache.join("source");
    std::fs::create_dir(&source)?;
    let output = source.join("index.m3u8");
    let mut command = tokio::process::Command::new("/usr/bin/ffmpeg");
    command
        .args([
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=128x72:rate=25:duration=2",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-threads",
            "1",
            "-bf",
            "0",
            "-g",
            "25",
            "-sc_threshold",
            "0",
            "-avoid_negative_ts",
            "disabled",
            "-f",
            "hls",
            "-hls_time",
            "1",
            "-hls_segment_type",
            "fmp4",
            "-hls_playlist_type",
            "vod",
        ])
        .arg(&output);
    ensure!(
        media_core::child_process::capture(command, Duration::from_secs(10), 65536)
            .await?
            .0
            .success()
    );
    let files: Arc<HashMap<String, Vec<u8>>> = Arc::new(
        std::fs::read_dir(&source)?
            .map(|e| {
                let p = e.unwrap().path();
                (
                    format!("/{}", p.file_name().unwrap().to_str().unwrap()),
                    std::fs::read(&p).unwrap(),
                )
            })
            .collect(),
    );
    let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = reads.clone();
    let read_fixtures = Arc::new(super::read_tests::ReadFixtures::default());
    let read_gate = read_fixtures.clone();
    let origin = Router::new().fallback(move |uri: axum::http::Uri| {
        let files = files.clone();
        let seen = seen.clone();
        let read_gate = read_gate.clone();
        async move {
            seen.fetch_add(1, Ordering::SeqCst);
            let data = files.get(uri.path()).cloned().unwrap_or_default();
            let length = data.len();
            let body =
                if uri.path().ends_with(".m4s") && read_gate.armed.swap(false, Ordering::SeqCst) {
                    super::read_tests::paused_body(data, read_gate)
                } else {
                    Body::from(data)
                };
            axum::http::Response::builder()
                .header(header::ETAG, "\"rpc-fixed\"")
                .header(header::CONTENT_LENGTH, length)
                .body(body)
                .unwrap()
        }
    });
    let listen = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listen.local_addr()?);
    let origin_task = tokio::spawn(async move { axum::serve(listen, origin).await });
    let app = App {
        readiness: Default::default(),
        metrics: Default::default(),
        db: db.clone(),
        key: Arc::new(aes_gcm::Aes256Gcm::new_from_slice(&[31u8; 32]).unwrap()),
        cache: cache.clone(),
        client: reqwest::Client::new(),
        relay: Default::default(),
        public_url: String::new(),
        probes: Arc::new(tokio::sync::Semaphore::new(2)),
        output_checks: Default::default(),
        input_failures: Default::default(),
        preview_inputs: Default::default(),
        deliveries: Default::default(),
        static_hls_operations: Default::default(),
        static_hls_children: Default::default(),
        static_hls_child_dispatch: Default::default(),
        static_hls_child_encoders: Default::default(),
    };
    app.static_hls_operations.open();
    let input = seed(&app, &base).await?;
    let mut missing_owner_app = app.clone();
    missing_owner_app.static_hls_operations = Default::default();
    missing_owner_app.static_hls_operations.open();
    let fixtures = ClientFixtures::default();
    let mut router = Router::new()
        .route(
            "/media-delivery/{id}/{path}",
            axum::routing::get(crate::delivery).head(crate::delivery),
        )
        .route(
            "/media-delivery/{id}/static-hls/{token}/{path}",
            axum::routing::get(crate::static_hls_read::endpoint)
                .head(crate::static_hls_read::endpoint),
        )
        .route(
            "/media-delivery/static-hls-operation",
            axum::routing::post(endpoint).layer(axum::extract::DefaultBodyLimit::max(4096)),
        )
        .with_state(app.clone())
        .merge(
            Router::new()
                .route(
                    "/missing-read/media-delivery/static-hls-operation",
                    axum::routing::post(endpoint).layer(axum::extract::DefaultBodyLimit::max(4096)),
                )
                .route(
                    "/missing-read/media-delivery/{id}/static-hls/{token}/{path}",
                    axum::routing::get(crate::static_hls_read::endpoint)
                        .head(crate::static_hls_read::endpoint),
                )
                .route(
                    "/missing-owner",
                    axum::routing::post(endpoint).layer(axum::extract::DefaultBodyLimit::max(4096)),
                )
                .with_state(missing_owner_app.clone()),
        );
    for mode in [
        "delay",
        "pause",
        "mutate",
        "replay",
        "oversize",
        "prepare-normal",
        "prepare-short-1500",
        "prepare-create-delay",
        "prepare-create-pause",
        "prepare-publish-delay",
        "prepare-missing-owner",
    ] {
        let receiver = if mode == "prepare-missing-owner" {
            missing_owner_app.clone()
        } else {
            app.clone()
        };
        let controlled = fixtures.clone();
        router = router.route(
            &format!("/{mode}/media-delivery/static-hls-operation"),
            axum::routing::post(move |body: axum::body::Bytes| {
                client_fixture_reply(receiver.clone(), body, mode, controlled.clone())
            })
            .layer(axum::extract::DefaultBodyLimit::max(4096)),
        );
    }
    let listen = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!(
        "http://{}/media-delivery/static-hls-operation",
        listen.local_addr()?
    );
    let server = tokio::spawn(async move { axum::serve(listen, router).await });
    let client = reqwest::Client::new();
    rejection_matrix(&client, &url, &app, &input).await?;
    ensure!(reads.load(Ordering::SeqCst) == 0);
    let captures: i64 = sqlx::query_scalar("SELECT count(*) FROM static_hls_captures")
        .fetch_one(&db)
        .await?;
    ensure!(captures == 0 && app.static_hls_operations.0.entries.lock().await.is_empty());
    let (wire, initial) = reply(&client, &url, &app, &input, Action::Create).await?;
    ensure!(initial["result"]["kind"] == "pending");
    ensure!(
        client.post(&url).body(wire).send().await?.status() == StatusCode::SERVICE_UNAVAILABLE,
        "challenge replay accepted"
    );
    let until = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut final_value = None;
    let mut last_query = None;
    while tokio::time::Instant::now() < until {
        let (_, value) = reply(&client, &url, &app, &input, Action::Query).await?;
        if value["result"]["kind"] == "verified" {
            final_value = Some(value);
            break;
        }
        last_query = Some(value);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if final_value.is_none() {
        let operation = Uuid::parse_str(&input.identity_statement().operation_id)?;
        let row: Value = sqlx::query_scalar("SELECT jsonb_build_object('request_status',r.status,'prepare_remaining',extract(epoch FROM(r.static_hls_prepare_expires_at-clock_timestamp())),'capture_state',c.state,'capture_phase',c.publication_phase,'root_present',c.root_digest IS NOT NULL,'inventory_present',c.inventory_encrypted IS NOT NULL,'streams_closed',c.streams_closed_at IS NOT NULL,'process_closed',c.process_closed_at IS NOT NULL,'files_removed',c.files_removed_at IS NOT NULL,'disposed',c.disposed_at IS NOT NULL) FROM playback_requests r LEFT JOIN static_hls_captures c ON c.session_id=r.session_id WHERE r.session_id=$1")
            .bind(Uuid::parse_str(&input.identity_statement().session_id)?)
            .fetch_one(&app.db).await?;
        let control = app
            .static_hls_operations
            .0
            .entries
            .lock()
            .await
            .get(&operation)
            .and_then(|entry| entry.control.get())
            .map(|control| {
                json!({"disposal_state":format!("{:?}",control.disposal_state()),
                "retry_available":control.disposal_retry_available()})
            });
        std::fs::write(
            app.cache.join("original-verification-timeout.json"),
            serde_json::to_vec_pretty(&json!({"operation":operation,"last_reply":last_query,
                "rows":row,"original_control":control}))?,
        )?;
    }
    ensure!(final_value.is_some(), "original Worker never verified");
    let before_publication = reads.load(Ordering::SeqCst);
    let publication = app
        .static_hls_operations
        .publication_original(&input)
        .await?;
    publication.check().await?;
    ensure!(
        reads.load(Ordering::SeqCst) - before_publication
            == publication.live_evidence()?.inventory.len(),
        "publication skipped a complete graph resource"
    );
    ensure!(
        publication.identity().capture_id == input.identity_statement().operation_id,
        "publication adopted another capture"
    );
    let publication_held: i64 =
        sqlx::query_scalar("SELECT bytes FROM cache_write_reservations WHERE job_id=$1")
            .bind(Uuid::parse_str(&input.identity_statement().operation_id)?)
            .fetch_one(&db)
            .await?;
    ensure!(
        publication_held == 134217728,
        "publication released original reservation"
    );
    drop(publication);
    tokio::time::sleep(Duration::from_millis(20)).await;
    use media_core::static_hls::{ReadMethod, ReadRange, ReadResource};
    let mut head = app
        .static_hls_operations
        .read_original(&input, ReadResource::Init, ReadMethod::Head, None)
        .await?;
    ensure!(head.content_length() > 0 && head.chunk().await?.is_none());
    drop(head);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let mut prefix = app
        .static_hls_operations
        .read_original(
            &input,
            ReadResource::Segment(0),
            ReadMethod::Get,
            Some(ReadRange::Inclusive { first: 0, last: 31 }),
        )
        .await?;
    ensure!(
        prefix.content_length() == 32
            && prefix.chunk().await?.context("prefix missing")?.len() == 32
    );
    ensure!(prefix.chunk().await?.is_none());
    drop(prefix);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let mut parked_init = app
        .static_hls_operations
        .read_original(&input, ReadResource::Init, ReadMethod::Get, None)
        .await?;
    let mut parked_segment = app
        .static_hls_operations
        .read_original(&input, ReadResource::Segment(0), ReadMethod::Get, None)
        .await?;
    let held_bytes: i64 =
        sqlx::query_scalar("SELECT bytes FROM cache_write_reservations WHERE job_id=$1")
            .bind(Uuid::parse_str(&input.identity_statement().operation_id)?)
            .fetch_one(&db)
            .await?;
    ensure!(
        held_bytes == 134217728,
        "read released original reservation"
    );
    ensure!(
        app.static_hls_operations
            .read_original(&input, ReadResource::Manifest, ReadMethod::Get, None)
            .await
            .is_err()
    );
    let before = reads.load(Ordering::SeqCst);
    let (_, duplicate) = reply(&client, &url, &app, &input, Action::Create).await?;
    ensure!(
        duplicate["result"]["kind"] == "verified" && reads.load(Ordering::SeqCst) == before,
        "duplicate started source work"
    );
    let missing_url = url.replace("/media-delivery/static-hls-operation", "/missing-owner");
    let (_, missing) = reply(&client, &missing_url, &app, &input, Action::Query).await?;
    ensure!(missing["result"]["kind"] == "unknown");
    ensure!(
        missing_owner_app
            .static_hls_operations
            .publication_original(&input)
            .await
            .is_err()
    );
    ensure!(
        missing_owner_app
            .static_hls_operations
            .0
            .entries
            .lock()
            .await
            .is_empty()
    );
    ensure!(
        reads.load(Ordering::SeqCst) == before,
        "missing owner adopted source work"
    );

    let limited = seed(&app, &base).await?;
    let quota_file = cache.join("owned-logical-quota-fixture");
    let max: u64 = std::env::var("CACHE_MAX_BYTES")?.parse()?;
    std::fs::File::create(&quota_file)?.set_len(max)?;
    let (_, capacity_pending) = reply(&client, &url, &app, &limited, Action::Create).await?;
    ensure!(capacity_pending["result"]["kind"] == "pending");
    let until = tokio::time::Instant::now() + Duration::from_secs(10);
    let capacity = loop {
        let (_, value) = reply(&client, &url, &app, &limited, Action::Query).await?;
        if value["result"]["kind"] == "refused" {
            break value;
        }
        ensure!(
            tokio::time::Instant::now() < until,
            "capacity result missing"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    ensure!(
        capacity["result"]["reason"] == "capacity" && capacity["result"]["capture_id"].is_null()
    );
    ensure!(
        reads.load(Ordering::SeqCst) == before,
        "quota refusal read source"
    );
    let extra: i64 = sqlx::query_scalar("SELECT count(*) FROM static_hls_captures WHERE id=$1")
        .bind(Uuid::parse_str(&limited.identity_statement().operation_id)?)
        .fetch_one(&db)
        .await?;
    ensure!(extra == 0, "quota refusal admitted capture");
    std::fs::remove_file(&quota_file)?;
    let (_, limited_cancel) = reply(&client, &url, &app, &limited, Action::Cancel).await?;
    ensure!(limited_cancel["result"]["kind"] == "cancel_requested");
    let (_, cancelled) = reply(&client, &url, &app, &input, Action::Cancel).await?;
    ensure!(cancelled["result"]["kind"] == "cancel_requested");
    for cancelled_input in [&input, &limited] {
        let row = sqlx::query(
            "SELECT status,error_status,error_code FROM playback_requests WHERE session_id=$1",
        )
        .bind(Uuid::parse_str(
            &cancelled_input.identity_statement().session_id,
        )?)
        .fetch_one(&db)
        .await?;
        ensure!(
            row.get::<String, _>("status") == "failed"
                && row.get::<i16, _>("error_status") == 410
                && row.get::<String, _>("error_code") == "static_hls_operation_cancelled"
        );
    }
    let (revoked_wire, _, mut probe) = envelope(&app, &input, Action::Create).await?;
    reject_wire(&client, &url, revoked_wire, StatusCode::SERVICE_UNAVAILABLE).await?;
    probe.remove_owned()?;
    app.static_hls_operations.close().await;
    app.static_hls_operations.drain().await;
    let (_, disposed) = reply(&client, &url, &app, &input, Action::Query).await?;
    ensure!(disposed["result"]["kind"] == "disposed");
    ensure!(
        app.static_hls_operations
            .publication_original(&input)
            .await
            .is_err()
    );
    ensure!(parked_init.chunk().await.is_err() && parked_segment.chunk().await.is_err());
    drop(parked_init);
    drop(parked_segment);
    let operation = Uuid::parse_str(&input.identity_statement().operation_id)?;
    ensure!(
        !app.static_hls_operations
            .0
            .entries
            .lock()
            .await
            .contains_key(&operation)
    );
    let held: i64 =
        sqlx::query_scalar("SELECT count(*) FROM cache_write_reservations WHERE job_id=$1")
            .bind(operation)
            .fetch_one(&db)
            .await?;
    ensure!(held == 0);
    // Only this run's isolated database is reachable. Interrupt the exact
    // admission backend after it reaches its budget UPDATE. This checks real
    // connection failure, not a synthetic result or a lost-COMMIT-ACK claim.
    let fault_input = seed(&app, &base).await?;
    app.static_hls_operations.open();
    sqlx::raw_sql("CREATE FUNCTION rainsync_owned_admission_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$; CREATE TRIGGER rainsync_owned_admission_pause BEFORE UPDATE ON cache_budget FOR EACH ROW EXECUTE FUNCTION rainsync_owned_admission_pause();")
        .execute(&db).await?;
    let (_, fault_pending) = reply(&client, &url, &app, &fault_input, Action::Create).await?;
    ensure!(fault_pending["result"]["kind"] == "pending");
    let until = tokio::time::Instant::now() + Duration::from_secs(2);
    let pid = loop {
        let pid: Option<i32> = sqlx::query_scalar("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event='PgSleep' AND query LIKE 'UPDATE cache_budget SET revision=revision+1 WHERE singleton AND revision=%'")
            .fetch_optional(&db).await?;
        if let Some(pid) = pid {
            break pid;
        }
        ensure!(
            tokio::time::Instant::now() < until,
            "owned admission backend not observed"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let terminated: bool = sqlx::query_scalar("SELECT pg_terminate_backend($1)")
        .bind(pid)
        .fetch_one(&db)
        .await?;
    ensure!(terminated, "owned backend termination unconfirmed");
    let until = tokio::time::Instant::now() + Duration::from_secs(2);
    let uncertain = loop {
        let (_, value) = reply(&client, &url, &app, &fault_input, Action::Query).await?;
        if value["result"]["kind"] == "unknown" {
            break value;
        }
        ensure!(
            tokio::time::Instant::now() < until,
            "uncertain admission result missing"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    ensure!(uncertain["result"]["reason"] == "unavailable");
    ensure!(
        reads.load(Ordering::SeqCst) == before,
        "failed admission started source"
    );
    sqlx::raw_sql("DROP TRIGGER rainsync_owned_admission_pause ON cache_budget; DROP FUNCTION rainsync_owned_admission_pause();")
        .execute(&db).await?;
    let (_, fault_cancel) = reply(&client, &url, &app, &fault_input, Action::Cancel).await?;
    ensure!(fault_cancel["result"]["kind"] == "cancel_requested");
    app.static_hls_operations.close().await;
    app.static_hls_operations.drain().await;
    let fault_operation = Uuid::parse_str(&fault_input.identity_statement().operation_id)?;
    let fault_captures: i64 =
        sqlx::query_scalar("SELECT count(*) FROM static_hls_captures WHERE id=$1")
            .bind(fault_operation)
            .fetch_one(&db)
            .await?;
    ensure!(fault_captures == 0);
    app.static_hls_operations.open();
    let prepare_evidence =
        super::prepare_tests::exercise(&app, &base, &url, &reads, &fixtures, read_fixtures.clone())
            .await?;
    let client_evidence =
        server_client_round_trip(&app, &base, &url, &reads, &fixtures, read_fixtures).await?;
    std::fs::write(
        cache.join("rpc-evidence.json"),
        serde_json::to_vec_pretty(
            &json!({"run_id":run,"create":initial,"verified":final_value,"duplicate":duplicate,"missing_owner":missing,"capacity":capacity,"cancel":cancelled,"disposed":disposed,"uncertain_admission":uncertain,"preparation":prepare_evidence,"server_client":client_evidence,"source_reads":before,"reservation_count":0,"public_hls_activated":false}),
        )?,
    )?;
    server.abort();
    let _ = server.await;
    origin_task.abort();
    let _ = origin_task.await;
    media_core::child_process::shutdown().await?;
    db.close().await;
    std::fs::write(
        std::env::var("RAINSYNC_OWNED_TEST_REPORT")?,
        serde_json::to_vec_pretty(&json!({
            "schemaVersion":1,"runId":run,"complete":true,"scope":"actual-worker-private-operation-http",
            "passed":["authenticated_create","challenge_replay_rejected","same_owner_query_verified","duplicate_create_no_source_io","cancel_original_owner","original_positive_disposal",
            "malformed_mac_rejected","oversized_body_rejected","duplicate_json_rejected","wrong_purpose_rejected","wrong_worker_rejected","expired_rpc_rejected","input_binding_mismatch_rejected",
            "missing_local_owner_not_adopted","logical_capacity_no_source_io","cancel_terminalizes_request","revoked_create_rejected","revoked_query_observes_original_disposal","disposed_owner_registry_retired","admission_connection_failure_stays_unknown",
            "server_client_create_query_cancel","server_client_replay_echo_rejected","server_client_oversize_stream_rejected","server_client_late_reply_keeps_original_operation","server_client_dropped_waiter_retains_cleanup","server_client_cleanup_error_retains_original_probe_and_slot","server_client_original_probe_retry_clears_file_and_database","server_client_shutdown_drains_and_fences","server_client_late_constructor_is_drained_before_cleanup",
            "original_worker_read_lease_head_range_retains_real_reservation","original_worker_unpolled_reads_cancel_before_positive_disposal",
            "original_worker_publication_revalidates_every_resource_and_holds_real_reservation","original_worker_publication_rejects_missing_and_closed_owner",
            "server_client_publish_original_owner_after_dropped_waiter","server_client_publish_replay_no_source_io_or_second_grant","server_client_late_publish_receipt_replays_original_ciphertext",
            "published_parent_http_manifest_init_segment_and_head",
            "published_parent_http_ranges_and_if_range_use_verified_bytes",
            "published_parent_http_416_revalidates_complete_resource",
            "published_parent_http_malformed_token_legacy_and_missing_owner_refusals_no_source_io",
            "published_parent_http_login_revocation_closes_actual_upstream_body",
            "published_parent_http_execution_ack_reader_bound_and_positive",
            "published_parent_http_delivery_receipts_are_drained_before_owner_shutdown",
            "published_parent_public_plan_matches_original_graph_and_reads_original_manifest",
            "published_parent_public_plan_replay_preserves_url_session_deadline_and_reservation",
            "published_parent_public_plan_contains_no_private_graph_source_or_cipher",
            "published_parent_public_plan_rejects_foreign_cipher_and_root_bindings",
            "published_parent_public_plan_requires_original_worker_snapshot",
            "published_parent_public_plan_refuses_after_original_login_revocation",
            "prepare_normal_single_capture_publication_original_root",
            "prepare_lost_create_reply_queries_original_operation",
            "prepare_lost_publish_reply_queries_original_publication",
            "prepare_http_waiter_exit_keeps_original_preparation",
            "prepare_cancel_terminalizes_without_optimistic_release",
            "prepare_original_deadline_ends_without_publication_or_renewal",
            "prepare_original_1500ms_budget_records_terminal_and_original_custody",
            "prepare_missing_owner_unknown_retains_original_reservation",
            "prepare_qualification_ended_is_not_a_native_grant"],
            "preparation":prepare_evidence,
            "scannerOrProcessStarted":true,"physicalDisposalProven":true,"publicHlsActivated":false
        }))?,
    )?;
    Ok(())
}
