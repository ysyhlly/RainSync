//! Opt-in coordinator-owned DB and real loopback HTTP reads, never Bilibili.
use super::*;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

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
                .map(|chunk| chunk.map(|chunk| chunk.to_vec()))
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
    let f: Fixture = serde_json::from_slice(&std::fs::read(request).unwrap()).unwrap();
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
    assert_eq!(
        reqwest::Url::parse(&f.origin).unwrap().host_str(),
        Some("127.0.0.1")
    );
    let app = app(db.clone()).await;
    let api = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap();
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
        if case.name == "reject_stopped" {
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
            if case.name == "receipt_failure" || case.name == "receipt_suppressed" {
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
}
