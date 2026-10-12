//! Opt-in coordinator-owned DB and real loopback HTTP reads, never Bilibili.
use super::*;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

// Test-only process-global capture: exact ignored driver, fixed targets/typed fields.
struct AckCaptureState {
    file: std::fs::File,
    failed: bool,
    event_count: usize,
}
#[derive(Clone)]
struct AckCaptureLayer(Arc<std::sync::Mutex<AckCaptureState>>);
#[derive(Default)]
struct AckCaptureFields(serde_json::Map<String, Value>);
impl tracing::field::Visit for AckCaptureFields {
    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        if matches!(field.name(), "ack_age_ms" | "failed_calls" | "probe") {
            self.0.insert(field.name().into(), json!(value));
        }
    }
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if matches!(
            (field.name(), value),
            ("failure", "ack_error" | "timeout") | ("outcome", "recovered")
        ) {
            self.0.insert(field.name().into(), json!(value));
        }
    }
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if matches!(field.name(), "room_id" | "execution_id")
            && let Ok(id) = Uuid::parse_str(&format!("{value:?}"))
        {
            self.0.insert(field.name().into(), json!(id.to_string()));
        }
    }
}
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for AckCaptureLayer {
    fn enabled(
        &self,
        metadata: &tracing::Metadata<'_>,
        _context: tracing_subscriber::layer::Context<'_, S>,
    ) -> bool {
        matches!(
            metadata.target(),
            "native_delivery_ack" | "native_delivery_ack_capture_probe"
        )
    }
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _context: tracing_subscriber::layer::Context<'_, S>,
    ) {
        if !matches!(
            event.metadata().target(),
            "native_delivery_ack" | "native_delivery_ack_capture_probe"
        ) {
            return;
        }
        let mut fields = AckCaptureFields::default();
        event.record(&mut fields);
        fields
            .0
            .insert("target".into(), json!(event.metadata().target()));
        fields
            .0
            .insert("level".into(), json!(event.metadata().level().as_str()));
        let mut state = match self.0.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                poisoned.into_inner().failed = true;
                return;
            }
        };
        if state.failed {
            return;
        }
        if state.event_count >= 128 {
            state.failed = true;
            return;
        }
        state.event_count += 1;
        use std::io::Write;
        if serde_json::to_writer(&mut state.file, &fields.0).is_err()
            || state.file.write_all(b"\n").is_err()
        {
            state.failed = true;
        }
    }
}

#[derive(Deserialize)]
struct Fixture {
    id: Uuid,
    nonce: String,
    origin: String,
    cookie: String,
    csrf: String,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    room: Uuid,
    session: Uuid,
    user: Uuid,
    login: String,
    token: String,
    url: String,
}

#[derive(Clone, Default)]
struct Flags {
    started: Arc<AtomicUsize>,
    chunks: Arc<AtomicUsize>,
    future_dropped: Arc<AtomicBool>,
    response_dropped: Arc<AtomicBool>,
}
struct RequestGuard(Flags);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.0.future_dropped.store(true, Ordering::SeqCst);
    }
}
struct HttpSource {
    response: reqwest::Response,
    flags: Flags,
}
impl Drop for HttpSource {
    fn drop(&mut self) {
        self.flags.response_dropped.store(true, Ordering::SeqCst);
    }
}
impl Source for HttpSource {
    fn status(&self) -> StatusCode {
        self.response.status()
    }
    fn headers(&self) -> &HeaderMap {
        self.response.headers()
    }
    fn next<'a>(
        &'a mut self,
    ) -> Pin<
        Box<dyn Future<Output = std::result::Result<Option<Vec<u8>>, bilibili::Error>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.response
                .chunk()
                .await
                .map(|chunk| {
                    chunk.map(|chunk| {
                        self.flags.chunks.fetch_add(1, Ordering::SeqCst);
                        chunk.to_vec()
                    })
                })
                .map_err(|_| bilibili::Error::Transport)
        })
    }
}
struct HttpFixture {
    client: reqwest::Client,
    url: String,
    flags: Flags,
}
impl Transport for HttpFixture {
    fn open<'a>(
        &'a self,
        request: &'a Request,
    ) -> Pin<
        Box<dyn Future<Output = std::result::Result<Box<dyn Source>, bilibili::Error>> + Send + 'a>,
    > {
        Box::pin(async move {
            let _future = RequestGuard(self.flags.clone());
            self.flags.started.fetch_add(1, Ordering::SeqCst);
            assert_eq!(request.provider, "bilibili");
            let mut pending = self.client.request(request.method.clone(), &self.url);
            if let Some(range) = &request.range {
                pending = pending.header("range", range);
            }
            let response = pending
                .send()
                .await
                .map_err(|_| bilibili::Error::Transport)?;
            Ok(Box::new(HttpSource {
                response,
                flags: self.flags.clone(),
            }) as Box<dyn Source>)
        })
    }
}

async fn app(db: PgPool) -> App {
    App {
        control_cluster: None,
        platform_http: Default::default(),
        bilibili_signing_keys: Default::default(),
        native_delivery_owners: Default::default(),
        live_playback: Default::default(),
        other_live_playback: Default::default(),
        other_live_enabled: false,
        platform_oauth: Arc::new(providers::platform::oauth::Registry::disabled()),
        platform_oauth_exchanges: Arc::new(platform_accounts::exchanges::Registry::new()),
        native_transcode_delivery: Default::default(),
        youtube: providers::platform::youtube::YoutubeResolver::new(
            providers::platform::youtube::Config::disabled(),
        ),
        presence_sequence: Default::default(),
        account_security: account_security::Security::configured().unwrap(),
        avatar_settings: avatar_image::Settings::configured().unwrap(),
        session_limit: 8,
        queue_limit: 8,
        preview_settings: persistence::media_previews::Settings::configured().unwrap(),
        metrics: Default::default(),
        readiness: Default::default(),
        db,
        origin: "http://localhost".into(),
        secure: false,
        key: Arc::new(Aes256Gcm::new_from_slice(&[0; 32]).unwrap()),
        epoch: Uuid::new_v4(),
        start: Instant::now(),
        rooms: Default::default(),
        agent_controls: Default::default(),
        upstream: Default::default(),
        upstream_policy: Default::default(),
        preparations: Default::default(),
    }
}
async fn until<F: FnMut() -> Fut, Fut: Future<Output = bool>>(mut condition: F, label: &str) {
    let end = Deadline::now() + Duration::from_secs(15);
    while Deadline::now() < end {
        if condition().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    panic!("deadline: {label}");
}
async fn lifecycle(client: &reqwest::Client, f: &Fixture, room: Uuid) -> Value {
    client
        .get(format!("{}/api/v1/rooms/{room}/lifecycle", f.origin))
        .header("cookie", &f.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}
async fn close(client: &reqwest::Client, f: &Fixture, room: Uuid) {
    let state = lifecycle(client, f, room).await;
    let response = client
        .post(format!("{}/api/v1/rooms/{room}/close", f.origin))
        .header("cookie", &f.cookie)
        .header("origin", &f.origin)
        .header("x-csrf-token", &f.csrf)
        .json(&json!({"expected_revision":state["state"]["revision"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
async fn receipts(db: &PgPool, session: Uuid) -> (i64, i64) {
    let row=sqlx::query("SELECT count(*) AS total,count(*) FILTER(WHERE reaped_at IS NOT NULL) AS reaped FROM media_executions WHERE session_id=$1").bind(session).fetch_one(db).await.unwrap();
    (row.get("total"), row.get("reaped"))
}

// Observe actual existing typed events; never synthesize retry counts.
fn fixture_ack_events(
    request: &std::path::Path,
    capture: &Arc<std::sync::Mutex<AckCaptureState>>,
    execution: Uuid,
) -> Vec<Value> {
    let guard = capture.lock().expect("existing typed capture lock");
    assert!(!guard.failed, "typed ACK observation remains complete");
    std::fs::read_to_string(request.with_file_name("native-ack-observation.private.log"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("complete typed event line"))
        .filter(|event| {
            event["target"] == "native_delivery_ack"
                && event["execution_id"] == execution.to_string()
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the owned native-delivery HTTP/PostgreSQL coordinator"]
async fn native_delivery_owner_http_fixture() {
    assert_eq!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref(), Ok("1"));
    let request =
        std::path::PathBuf::from(std::env::var("RAINSYNC_NATIVE_DELIVERY_REQUEST").unwrap())
            .canonicalize()
            .unwrap();
    let artifacts = std::path::PathBuf::from(std::env::var("RAINSYNC_ARTIFACT_DIR").unwrap())
        .canonicalize()
        .unwrap();
    assert!(request.starts_with(&artifacts));
    let capture_path = request.with_file_name("native-ack-observation.private.log");
    let f: Fixture = serde_json::from_slice(&std::fs::read(&request).unwrap()).unwrap();
    let database = std::env::var("RAINSYNC_NATIVE_DELIVERY_TEST_DATABASE").unwrap();
    assert_eq!(
        reqwest::Url::parse(&database).unwrap().host_str(),
        Some("127.0.0.1")
    );
    let db = persistence::connect(&database).await.unwrap();
    let owned: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM native_delivery_fixture_identity WHERE id=$1 AND nonce=$2)",
    )
    .bind(f.id)
    .bind(&f.nonce)
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(owned, "explicit coordinator identity required");
    let mut capture_options = std::fs::OpenOptions::new();
    capture_options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        capture_options.mode(0o600);
    }
    let capture = Arc::new(std::sync::Mutex::new(AckCaptureState {
        file: capture_options.open(capture_path).unwrap(),
        failed: false,
        event_count: 0,
    }));
    use tracing_subscriber::prelude::*;
    tracing::subscriber::set_global_default(
        tracing_subscriber::registry().with(AckCaptureLayer(capture.clone())),
    )
    .expect("exact owned driver installs one capture subscriber");
    let capture_secret = f.nonce.clone();
    tokio::spawn(async move {
        tracing::debug!(target: "native_delivery_ack_capture_probe", probe = 1_u64, capture_secret = %capture_secret);
    }).await.unwrap();

    assert_eq!(
        reqwest::Url::parse(&f.origin).unwrap().host_str(),
        Some("127.0.0.1")
    );
    let app = app(db.clone()).await;
    let api = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap();
    let fixture_request_path = request.clone();
    for case in &f.cases {
        assert_eq!(
            reqwest::Url::parse(&case.url).unwrap().host_str(),
            Some("127.0.0.1")
        );
        let flags = Flags::default();
        let transport = HttpFixture {
            client: api.clone(),
            url: case.url.clone(),
            flags: flags.clone(),
        };
        let authority = Authority {
            session: case.session,
            token_hash: hash(&case.token),
            login_hash: case.login.clone(),
            user: case.user,
        };
        let request = Request {
            provider: "bilibili".into(),
            target: "https://cdn.bilivideo.com/owned-fixture".into(),
            method: if case.name == "send_head" {
                Method::HEAD
            } else {
                Method::GET
            },
            range: (case.name == "send_range_drop").then(|| "bytes=0-31".into()),
            deadline: Deadline::now() + Duration::from_secs(30),
        };
        if case.name == "reject_closed_admission" {
            app.native_delivery_owners.close_admission();
            assert!(
                start(&app, &authority, case.room, transport, request)
                    .await
                    .is_err()
            );
            assert_eq!(flags.started.load(Ordering::SeqCst), 0);
            assert_eq!(receipts(&db, case.session).await, (0, 0));
            close(&api, &f, case.room).await;
        } else if case.name == "reject_stopped" {
            sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
                .bind(case.session)
                .execute(&db)
                .await
                .unwrap();
            assert!(
                start(&app, &authority, case.room, transport, request)
                    .await
                    .is_err()
            );
            assert_eq!(flags.started.load(Ordering::SeqCst), 0);
            until(
                || async { app.native_delivery_owners.slots.available_permits() == LIMIT },
                "rejected admission reconciles positive absence",
            )
            .await;
            assert_eq!(receipts(&db, case.session).await, (0, 0));
            close(&api, &f, case.room).await;
        } else if case.name.starts_with("send_") {
            let owned = app.clone();
            let room = case.room;
            let pending =
                tokio::spawn(
                    async move { start(&owned, &authority, room, transport, request).await },
                );
            until(
                || async {
                    flags.started.load(Ordering::SeqCst) == 1
                        && receipts(&db, case.session).await == (1, 0)
                },
                "real delayed-header request is registered and running",
            )
            .await;
            if case.name == "send_range_drop" {
                pending.abort();
                let _ = pending.await;
            } else {
                close(&api, &f, case.room).await;
                assert!(pending.await.unwrap().is_err());
            }
            until(
                || async { receipts(&db, case.session).await == (1, 1) },
                "cancelled raw HEAD/GET future drops before receipt",
            )
            .await;
            assert!(flags.future_dropped.load(Ordering::SeqCst));
            assert!(
                !flags.response_dropped.load(Ordering::SeqCst),
                "delayed headers never delivered a response"
            );
            if case.name == "send_range_drop" {
                close(&api, &f, case.room).await;
            }
        } else {
            let (_, body) = start(&app, &authority, case.room, transport, request)
                .await
                .unwrap();
            assert_eq!(receipts(&db, case.session).await, (1, 0));
            assert!(!flags.response_dropped.load(Ordering::SeqCst));
            if case.name == "finish_pool_timeout" || case.name == "finish_retry_eight" {
                use futures_util::FutureExt;
                let observer = persistence::connect(&database).await.unwrap();
                let mut held = Vec::new();
                let mut pids = Vec::new();
                let mut body = Some(body);
                let mut fault_attempted = false;
                let mut execution = None;
                let mut witness = json!({"case":case.name,"room":case.room,"session":case.session});
                // Catch only this added test case; original nine assertions are untouched.
                // Any panic is resumed only after explicit fixture fault/connection cleanup.
                let run_result = std::panic::AssertUnwindSafe(async {
                    let id: Uuid = sqlx::query_scalar("SELECT id FROM media_executions WHERE session_id=$1")
                        .bind(case.session).fetch_one(&observer).await.unwrap();
                    execution=Some(id);witness["execution"]=json!(id);
                    assert!(fixture_ack_events(&fixture_request_path, &capture, id).is_empty());
                    if case.name == "finish_pool_timeout" {
                        until(|| async {body.as_ref().unwrap().receiver.len()==1 && flags.chunks.load(Ordering::SeqCst)==2},
                            "real body backpressure before holding driver pool").await;
                        tokio::time::timeout(Duration::from_secs(15), async {
                            for _ in 0..12 {
                                let mut connection=db.acquire().await.unwrap();
                                // Put the connection into the externally retained vector before SQL can fail.
                                let pid_result=sqlx::query_scalar::<_,i32>("SELECT pg_backend_pid()")
                                    .fetch_one(&mut *connection).await;
                                held.push(connection);pids.push(pid_result.unwrap());
                            }
                        }).await.expect("all twelve actual driver connections owned within existing witness bound");
                        assert_eq!(db.size(),12);assert_eq!(db.num_idle(),0);
                        let unique:std::collections::BTreeSet<_>=pids.iter().copied().collect();
                        assert_eq!(unique.len(),12);assert!(pids.iter().all(|pid|*pid>0));
                        assert!(!flags.response_dropped.load(Ordering::SeqCst),"source remains live before explicit body drop");
                        assert!(fixture_ack_events(&fixture_request_path, &capture, id).is_empty());
                        let actual:Value=sqlx::query_scalar("SELECT jsonb_agg(jsonb_build_object('pid',pid,'backend_start',backend_start,'state',state) ORDER BY pid) FROM pg_stat_activity WHERE pid=ANY($1)")
                            .bind(&pids).fetch_one(&observer).await.unwrap();
                        assert_eq!(actual.as_array().unwrap().len(),12);
                        witness["held"]=json!({"connection_count":held.len(),"pool_size":db.size(),"pool_idle":db.num_idle(),"actual_backends":actual,"observed_at_epoch_ms":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()});
                        drop(body.take());
                        until(|| async {flags.response_dropped.load(Ordering::SeqCst)},"positive raw response disposal before finish timeout").await;
                        witness["response_disposed"]=json!({"observed":true,"observed_at_epoch_ms":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()});
                        until(|| async {fixture_ack_events(&fixture_request_path, &capture, id).iter().any(|e|e["level"]=="WARN" && e["failure"]=="timeout" && e["failed_calls"]==1)},
                            "actual first finish CHECK timeout typed warning").await;
                    } else {
                        fault_attempted=true;
                        sqlx::query(&format!("CREATE FUNCTION native_delivery_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.session_id='{}' AND NEW.reaped_at IS NOT NULL THEN RAISE EXCEPTION 'owned_injected_ack_failure'; END IF; RETURN NEW; END $$",case.session)).execute(&observer).await.unwrap();
                        sqlx::query("CREATE TRIGGER native_delivery_ack_failure BEFORE UPDATE ON media_executions FOR EACH ROW EXECUTE FUNCTION native_delivery_ack_failure()").execute(&observer).await.unwrap();
                        drop(body.take());
                        until(|| async {flags.response_dropped.load(Ordering::SeqCst)},"positive source disposal before retry witnesses").await;
                        until(|| async {fixture_ack_events(&fixture_request_path, &capture, id).iter().any(|e|e["level"]=="WARN" && e["failed_calls"]==8)},"actual same-execution eighth failed ACK warning").await;
                        let events=fixture_ack_events(&fixture_request_path, &capture, id);
                        for count in [1,2,4,8] {assert!(events.iter().any(|e|e["level"]=="WARN" && e["failed_calls"]==count && e["failure"]=="ack_error"));}
                    }
                    let events=fixture_ack_events(&fixture_request_path, &capture, id);
                    assert!(events.iter().all(|e|e["outcome"]!="recovered"));
                    assert_eq!(receipts(&observer,case.session).await,(1,0));
                    assert_eq!(app.native_delivery_owners.slots.available_permits(),LIMIT-1);
                    witness["fault_observation"]=json!({"events":events,"receipt_reaped":false,"permit_retained":true});
                }).catch_unwind().await;
                // Cleanup runs after both success and caught first assertion failure.
                let mut cleanup_errors = Vec::new();
                if fault_attempted {
                    for statement in [
                        "DROP TRIGGER IF EXISTS native_delivery_ack_failure ON media_executions",
                        "DROP FUNCTION IF EXISTS native_delivery_ack_failure()",
                    ] {
                        if let Err(error) = sqlx::query(statement).execute(&observer).await {
                            cleanup_errors.push(format!("fixture_fault_release:{error}"));
                        }
                    }
                    let remaining:std::result::Result<bool,sqlx::Error>=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='native_delivery_ack_failure') OR to_regprocedure('native_delivery_ack_failure()') IS NOT NULL")
                        .fetch_one(&observer).await;
                    match remaining {
                        Ok(false) => witness["fault_released"] = json!(true),
                        _ => cleanup_errors.push("fixture_fault_absence_unconfirmed".into()),
                    }
                }
                drop(body.take());
                let returned = held.len();
                // Explicit awaited return releases actual Rust connection ownership; backend survival is normal.
                for mut connection in held.drain(..) {
                    connection.return_to_pool().await;
                }
                witness["connections_returned"] =
                    json!({"count":returned,"held_vector_empty":held.is_empty()});
                let recovery=std::panic::AssertUnwindSafe(async {
                    if let Some(id)=execution {
                        until(|| async {receipts(&observer,case.session).await==(1,1) && app.native_delivery_owners.slots.available_permits()==LIMIT},"same execution durable ACK and returned permit after cleanup").await;
                        let events=fixture_ack_events(&fixture_request_path, &capture, id);
                        if run_result.is_ok(){assert_eq!(events.iter().filter(|e|e["outcome"]=="recovered").count(),1);}
                        witness["recovered_events"]=json!(events);
                    }
                    if returned==12 {
                        until(|| async {db.num_idle()==12},"all twelve actual driver connections returned idle").await;
                        let states:Value=sqlx::query_scalar("SELECT jsonb_agg(jsonb_build_object('pid',pid,'backend_start',backend_start,'state',state,'xact_start',xact_start) ORDER BY pid) FROM pg_stat_activity WHERE pid=ANY($1)")
                            .bind(&pids).fetch_one(&observer).await.unwrap();
                        assert_eq!(states.as_array().unwrap().len(),12);
                        assert!(states.as_array().unwrap().iter().all(|row|row["state"]=="idle" && row["xact_start"].is_null()));
                        let identity=|rows:&Value| rows.as_array().unwrap().iter().map(|row|(row["pid"].clone(),row["backend_start"].clone())).collect::<Vec<_>>();
                        assert_eq!(identity(&states),identity(&witness["held"]["actual_backends"]));
                        witness["returned_backends"]=json!({"pool_idle":db.num_idle(),"actual_backends":states});
                    }
                    close(&api,&f,case.room).await;
                }).catch_unwind().await;
                if recovery.is_err() {
                    cleanup_errors.push("recovery_or_connection_return_observation_failed".into());
                }
                observer.close().await;
                witness["observer_pool_closed"] = json!(observer.is_closed());
                witness["cleanup_errors"] = json!(cleanup_errors);
                witness["first_assertion_failed"] = json!(run_result.is_err());
                let path = fixture_request_path
                    .with_file_name(format!("{}.finish-witness.private.json", case.name));
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let written = options.open(path).and_then(|mut file| {
                    use std::io::Write;
                    file.write_all(serde_json::to_string(&witness).unwrap().as_bytes())?;
                    file.sync_all()
                });
                // Preserve original panic as first failure after recording cleanup outcome.
                if let Err(first) = run_result {
                    std::panic::resume_unwind(first);
                }
                assert!(written.is_ok(), "private cleanup witness write confirmed");
                assert!(
                    cleanup_errors.is_empty(),
                    "added finish fixture cleanup must be positive"
                );
            } else if case.name == "receipt_failure" || case.name == "receipt_suppressed" {
                let failure = if case.name == "receipt_suppressed" {
                    "RETURN NULL;"
                } else {
                    "RAISE EXCEPTION 'owned_injected_ack_failure';"
                };
                sqlx::query(&format!("CREATE FUNCTION native_delivery_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.session_id='{}' AND NEW.reaped_at IS NOT NULL THEN {failure} END IF; RETURN NEW; END $$",case.session)).execute(&db).await.unwrap();
                sqlx::query("CREATE TRIGGER native_delivery_ack_failure BEFORE UPDATE ON media_executions FOR EACH ROW EXECUTE FUNCTION native_delivery_ack_failure()").execute(&db).await.unwrap();
                drop(body);
                until(
                    || async { flags.response_dropped.load(Ordering::SeqCst) },
                    "real raw response disposed despite injected receipt outage",
                )
                .await;
                close(&api, &f, case.room).await;
                until(
                    || async {
                        lifecycle(&api, &f, case.room).await["cleanup"]["blockers"]
                            .as_array()
                            .is_some_and(|reasons| {
                                reasons.contains(&json!("media_execution_drain_unconfirmed"))
                            })
                    },
                    "missing disposal receipt keeps room closing",
                )
                .await;
                assert_eq!(receipts(&db, case.session).await, (1, 0));
                assert_eq!(
                    app.native_delivery_owners.slots.available_permits(),
                    LIMIT - 1,
                    "owner survives an unconfirmed/zero-row receipt write"
                );
                assert_eq!(lifecycle(&api, &f, case.room).await["lifecycle"], "closing");
                sqlx::query("DROP TRIGGER native_delivery_ack_failure ON media_executions")
                    .execute(&db)
                    .await
                    .unwrap();
                sqlx::query("DROP FUNCTION native_delivery_ack_failure()")
                    .execute(&db)
                    .await
                    .unwrap();
                let state = lifecycle(&api, &f, case.room).await;
                let response = api
                    .post(format!(
                        "{}/api/v1/rooms/{}/cleanup/retry",
                        f.origin, case.room
                    ))
                    .header("cookie", &f.cookie)
                    .header("origin", &f.origin)
                    .header("x-csrf-token", &f.csrf)
                    .json(&json!({"expected_revision":state["state"]["revision"]}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
            } else if case.name == "body_drop" {
                drop(body);
                until(
                    || async { receipts(&db, case.session).await == (1, 1) },
                    "HTTP waiter drop drains retained real source",
                )
                .await;
                assert!(flags.response_dropped.load(Ordering::SeqCst));
                close(&api, &f, case.room).await;
            } else {
                until(
                    || async {
                        body.receiver.len() == 1 && flags.chunks.load(Ordering::SeqCst) == 2
                    },
                    "real source fills the bounded body channel before close",
                )
                .await;
                tokio::time::sleep(Duration::from_millis(200)).await;
                assert_eq!(body.receiver.len(), 1);
                assert_eq!(flags.chunks.load(Ordering::SeqCst), 2);
                assert!(!flags.response_dropped.load(Ordering::SeqCst));
                assert_eq!(receipts(&db, case.session).await, (1, 0));
                close(&api, &f, case.room).await;
                if !flags.response_dropped.load(Ordering::SeqCst) {
                    assert_eq!(lifecycle(&api, &f, case.room).await["lifecycle"], "closing");
                }
                until(
                    || async { receipts(&db, case.session).await == (1, 1) },
                    "close cancels the real source even under body backpressure",
                )
                .await;
                assert!(flags.response_dropped.load(Ordering::SeqCst));
                drop(body);
            }
        }
        until(
            || async { lifecycle(&api, &f, case.room).await["lifecycle"] == "closed" },
            "only positive source/future disposal closes room",
        )
        .await;
        let closed: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM room_lifecycle_events WHERE room_id=$1 AND lifecycle='closed'",
        )
        .bind(case.room)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(closed, 1);
        println!("PASS: native owned real-HTTP lifecycle case {}", case.name);
    }
    app.native_delivery_owners.drain().await.unwrap();
    let mut captured = match capture.lock() {
        Ok(state) => state,
        Err(poisoned) => {
            let mut state = poisoned.into_inner();
            state.failed = true;
            state
        }
    };
    use std::io::Write;
    if captured.file.flush().is_err() {
        captured.failed = true;
    }
    assert!(
        !captured.failed,
        "typed ACK capture must not overflow or lose writes"
    );
}
