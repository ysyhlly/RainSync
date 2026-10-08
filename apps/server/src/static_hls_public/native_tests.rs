//! Opt-in, network-isolated fixture of the production public handlers and Worker.
//! Only the coordinator's exact database/binding and generated fixture files.
use super::*;
use anyhow::{Context, Result, ensure};
use axum::{
    Router,
    body::Body,
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

async fn app(db: PgPool) -> Result<App> {
    Ok(App {
        control_cluster: None,
        platform_http: providers::platform::http::PlatformHttp::new(),
        live_playback: crate::native_live::LiveStore::default(),
        other_live_playback: crate::native_other_live::LiveStore::default(),
        other_live_enabled: false,
        platform_oauth: Arc::new(providers::platform::oauth::Registry::disabled()),
        platform_oauth_exchanges: Arc::new(platform_accounts::exchanges::Registry::new()),
        native_transcode_delivery: Arc::new(Default::default()),
        youtube: providers::platform::youtube::YoutubeResolver::new(
            providers::platform::youtube::Config::disabled(),
        ),
        presence_sequence: Default::default(),
        account_security: account_security::Security::configured()?,
        avatar_settings: avatar_image::Settings::configured()?,
        session_limit: 8,
        queue_limit: 8,
        preview_settings: persistence::media_previews::Settings::configured()?,
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
    })
}

async fn seed(app: &App, origin: &str, path: &str) -> Result<(Value, String, String, Uuid)> {
    let user = Uuid::new_v4();
    let room = Uuid::new_v4();
    let source = Uuid::new_v4();
    let media = Uuid::new_v4();
    let login = format!("owned-{}", Uuid::new_v4());
    let other = format!("owned-{}", Uuid::new_v4());
    let mut tx = app.db.begin().await?;
    sqlx::query(
        "INSERT INTO users(id,username,password_hash) VALUES($1,$2,'owned-public-fixture')",
    )
    .bind(user)
    .bind(format!("public_{user}"))
    .execute(&mut *tx)
    .await?;
    for token in [&login, &other] {
        sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,'owned-public',clock_timestamp()+interval '1 hour')").bind(hash(token)).bind(user).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,'owned public prepare',$2)")
        .bind(room)
        .bind(user)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2)")
        .bind(room)
        .bind(user)
        .execute(&mut *tx)
        .await?;
    let config = json!({"url":format!("{origin}/"),"headers":{},"access_policy":{"schema_version":1,"origins":[{"origin":origin,"cidrs":["127.0.0.0/8"]}],"redirects":{"max_hops":1}}});
    sqlx::query("INSERT INTO sources(id,name,kind,config_encrypted,access_policy_revision) VALUES($1,'owned','http',$2,1)").bind(source).bind(app.encrypt(&config)?).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO media_items(id,source_id,title,resource,source_version) VALUES($1,$2,'owned',$3,'owned-1')").bind(media).bind(source).bind(format!("{origin}/{path}")).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO room_snapshots(room_id,state) VALUES($1,$2)")
        .bind(room)
        .bind(serde_json::to_value(protocol::RoomState {
            room_id: room,
            revision: 0,
            media_id: Some(media),
            media_generation: 0,
            playback_status: protocol::PlaybackStatus::Paused,
            anchor_position_ms: 0.0,
            anchor_server_time_ms: 0.0,
            playback_rate: 1.0,
            controller_user_id: user,
            duration_ms: Some(2_000.0),
            live: None,
            clock_epoch: Uuid::new_v4(),
        })?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((
        json!({"static_hls_fallback_version":1,"room_id":room,"media_generation":0,"position_ms":0,"idempotency_key":Uuid::new_v4(),"viewer_id":Uuid::new_v4(),"plan_generation":1,"capabilities":{"progressive_h264_aac":true,"native_hls":true,"mse_h264_aac":false}}),
        login,
        other,
        user,
    ))
}

async fn request(
    client: &reqwest::Client,
    base: &str,
    body: &Value,
    login: Option<&str>,
    csrf: bool,
) -> Result<(StatusCode, Value)> {
    let mut request = client
        .post(format!("{base}/api/v1/playback-sessions"))
        .json(body)
        .header("origin", "http://localhost");
    if let Some(login) = login {
        request = request.header("cookie", format!("rainsync_session={login}"));
    }
    if csrf {
        request = request.header("x-csrf-token", "owned-public");
    }
    let reply = request.send().await.map_err(anyhow::Error::from)?;
    let status = reply.status();
    Ok((status, reply.json().await.map_err(anyhow::Error::from)?))
}

async fn disposed(db: &PgPool, session: Uuid) -> Result<()> {
    let until = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let positive:bool=sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.session_id=$1 AND (c.state<>'disposed' OR c.streams_closed_at IS NULL OR c.process_closed_at IS NULL OR c.process_disposition IS NULL OR c.process_disposition NOT IN('never_started','reaped') OR c.files_removed_at IS NULL OR c.disposed_at IS NULL)) AND NOT EXISTS(SELECT 1 FROM cache_write_reservations r WHERE r.job_id=$1 OR r.job_id IN(SELECT id FROM static_hls_captures WHERE session_id=$1))").bind(session).fetch_one(db).await?;
        if positive {
            return Ok(());
        }
        ensure!(
            tokio::time::Instant::now() < until,
            "original disposal receipts did not become positive"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[tokio::test]
#[ignore = "requires tests/static-hls-public-prepare.mjs owned isolated coordinator"]
async fn owned_public_prepare_round_trip() -> anyhow::Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::ERROR)
        .try_init();
    let run = Uuid::parse_str(&std::env::var("RAINSYNC_OWNED_TEST_RUN_ID")?)?;
    let dburl = std::env::var("RAINSYNC_OWNED_TEST_DATABASE_URL")?;
    ensure!(
        dburl
            == format!(
                "postgresql://postgres@127.0.0.1:5432/rainsync_pending_{}",
                run.simple()
            )
    );
    let db = persistence::connect(&dburl).await?;
    let binding: Uuid =
        sqlx::query_scalar("SELECT run_id FROM rainsync_owned_test_binding WHERE singleton")
            .fetch_one(&db)
            .await?;
    ensure!(binding == run, "database owner binding changed");
    ensure!(std::env::var("STATIC_HLS_PARENT_PREPARE_ENABLED")? == "1");
    let root = PathBuf::from("/tmp/rainsync-public-prepare");
    std::fs::create_dir(&root)?;
    let cache = root.join("cache");
    std::fs::create_dir(&cache)?;
    let source = root.join("source");
    std::fs::create_dir(&source)?;
    ensure!(std::env::var("CACHE_ROOT")? == cache.to_str().unwrap());
    let mut generate = tokio::process::Command::new("/usr/bin/ffmpeg");
    generate
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
        .arg(source.join("index.m3u8"));
    ensure!(
        media_core::child_process::capture(generate, std::time::Duration::from_secs(10), 65536)
            .await?
            .0
            .success()
    );
    let mut ordinary = tokio::process::Command::new("/usr/bin/ffmpeg");
    ordinary
        .args(["-v", "error", "-nostdin", "-y", "-i"])
        .arg(source.join("index.m3u8"))
        .args(["-c", "copy", "-movflags", "+faststart"])
        .arg(source.join("file.mp4"));
    ensure!(
        media_core::child_process::capture(ordinary, std::time::Duration::from_secs(10), 65536)
            .await?
            .0
            .success()
    );
    let files: Arc<HashMap<String, Vec<u8>>> = Arc::new(
        std::fs::read_dir(&source)?
            .map(|e| {
                let path = e.unwrap().path();
                (
                    format!("/{}", path.file_name().unwrap().to_str().unwrap()),
                    std::fs::read(path).unwrap(),
                )
            })
            .collect(),
    );
    let reads = Arc::new(AtomicUsize::new(0));
    let seen = reads.clone();
    let origin = Router::new().fallback(move |uri: axum::http::Uri| {
        let files = files.clone();
        let seen = seen.clone();
        async move {
            seen.fetch_add(1, Ordering::SeqCst);
            let data = files.get(uri.path()).cloned().unwrap_or_default();
            let len = data.len();
            axum::http::Response::builder()
                .header("etag", "\"owned-public-fixed\"")
                .header("content-length", len)
                .header(
                    "content-type",
                    if uri.path().ends_with(".m3u8") {
                        "application/vnd.apple.mpegurl"
                    } else {
                        "video/mp4"
                    },
                )
                .body(Body::from(data))
                .unwrap()
        }
    });
    let listen = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin_base = format!("http://{}", listen.local_addr()?);
    let (origin_stop, origin_stopped) = tokio::sync::oneshot::channel::<()>();
    let origin_task = tokio::spawn(async move {
        axum::serve(listen, origin)
            .with_graceful_shutdown(async {
                let _ = origin_stopped.await;
            })
            .await
    });
    let app = app(db.clone()).await?;
    let routes = Router::new()
        .route("/api/v1/playback-sessions", post(media::playback))
        .route(
            "/api/v1/playback-requests/{key}",
            delete(playback_requests::cancel),
        )
        .route("/api/v1/playback-sessions/{id}", get(media::readiness))
        .route("/api/v1/playback-sessions/{id}/renew", post(media::renew))
        .with_state(app.clone());
    let listen = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listen.local_addr()?);
    let (server_stop, server_stopped) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        axum::serve(listen, routes)
            .with_graceful_shutdown(async {
                let _ = server_stopped.await;
            })
            .await
    });
    let worker_stdout = std::fs::File::create(root.join("worker.stdout"))?;
    let worker_stderr = std::fs::File::create(root.join("worker.stderr"))?;
    let mut worker = tokio::process::Command::new("/owned-run/rainsync-media-worker")
        .env("DATABASE_URL", &dburl)
        .env("SOURCE_ENCRYPTION_KEY", STANDARD.encode([0; 32]))
        .env("CACHE_ROOT", &cache)
        .env("WORKER_BIND", "127.0.0.1:8081")
        .stdout(worker_stdout)
        .stderr(worker_stderr)
        .spawn()?;
    let worker_id = worker.id().context("owned Worker child missing pid")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(50))
        .build()?;
    let until = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if client
            .get("http://127.0.0.1:8081/health")
            .send()
            .await
            .is_ok()
        {
            break;
        }
        ensure!(
            tokio::time::Instant::now() < until,
            "owned Worker failed to start"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let mut passed = Vec::new();
    let (body, login, other, user) = seed(&app, &origin_base, "index.m3u8").await?;
    ensure!(request(&client, &base, &body, None, true).await?.0 == StatusCode::UNAUTHORIZED);
    ensure!(request(&client, &base, &body, Some(&login), false).await?.0 == StatusCode::FORBIDDEN);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM playback_requests WHERE user_id=$1")
        .bind(user)
        .fetch_one(&db)
        .await?;
    ensure!(count == 0 && reads.load(Ordering::SeqCst) == 0);
    passed.push("login_csrf_no_side_effects");
    let (status, plan) = request(&client, &base, &body, Some(&login), true).await?;
    ensure!(status == StatusCode::OK, "parent prepare: {status}: {plan}");
    ensure!(
        plan["transport"] == "hls"
            && plan["delivery_mode"] == "direct"
            && plan.get("static_hls_fallback").is_none()
            && plan.get("static_hls_fallback_version").is_none()
    );
    let session = Uuid::parse_str(
        plan["session_id"]
            .as_str()
            .context("parent session missing")?,
    )?;
    let playlist = client
        .get(format!(
            "http://127.0.0.1:8081{}",
            plan["playback_url"].as_str().unwrap()
        ))
        .send()
        .await?;
    ensure!(
        playlist.status() == StatusCode::OK && playlist.text().await?.contains("#EXT-X-ENDLIST")
    );
    passed.push("parent_public_plan_and_delivery");
    let before = reads.load(Ordering::SeqCst);
    let (status, replay) = request(&client, &base, &body, Some(&login), true).await?;
    ensure!(
        status == StatusCode::OK
            && replay["session_id"] == plan["session_id"]
            && replay["playback_url"] == plan["playback_url"]
            && reads.load(Ordering::SeqCst) == before
    );
    passed.push("parent_same_key_same_grant_no_recapture");
    let mut changed = body.clone();
    changed["position_ms"] = json!(1);
    ensure!(
        request(&client, &base, &changed, Some(&login), true)
            .await?
            .0
            == StatusCode::CONFLICT
    );
    ensure!(request(&client, &base, &body, Some(&other), true).await?.0 == StatusCode::GONE);
    passed.push("hash_and_exact_login_fences");
    let cancel = client
        .delete(format!(
            "{base}/api/v1/playback-requests/{}",
            body["idempotency_key"].as_str().unwrap()
        ))
        .header("origin", "http://localhost")
        .header("x-csrf-token", "owned-public")
        .header("cookie", format!("rainsync_session={login}"))
        .send()
        .await?;
    ensure!(cancel.status().is_success());
    disposed(&db, session).await?;
    ensure!(request(&client, &base, &body, Some(&login), true).await?.0 == StatusCode::GONE);
    passed.push("cancel_original_key_terminal_and_disposed");
    std::fs::write(
        std::env::var("RAINSYNC_OWNED_TEST_REPORT")?,
        serde_json::to_vec_pretty(
            &json!({"runId":run,"complete":false,"passed":passed,"parentSession":session}),
        )?,
    )?;
    let (mut ordinary, login, _, _) = seed(&app, &origin_base, "file.mp4").await?;
    ordinary["observation_version"] = json!(1);
    let (status, plan) = request(&client, &base, &ordinary, Some(&login), true).await?;
    ensure!(
        status == StatusCode::OK,
        "ordinary fallback: {status}: {plan}"
    );
    ensure!(
        plan["transport"] == "progressive"
            && plan["delivery_mode"] == "direct"
            && plan["decision_reason"] == "static_hls_qualification_refused"
            && plan["decoder_fallback_modes"] == json!([])
    );
    let native_session = Uuid::parse_str(plan["session_id"].as_str().unwrap())?;
    disposed(&db, native_session).await?;
    let frozen:bool=sqlx::query_scalar("SELECT r.session_id=p.id AND p.expires_at=r.static_hls_root_expires_at AND r.lease_until=r.static_hls_prepare_expires_at AND r.static_hls_input_version=1 AND p.static_hls_capture_id IS NULL AND NOT EXISTS(SELECT 1 FROM media_jobs WHERE session_id=p.id) FROM playback_requests r JOIN playback_sessions p ON p.id=r.session_id WHERE p.id=$1").bind(native_session).fetch_one(&db).await?;
    ensure!(frozen);
    let file = client
        .get(format!(
            "http://127.0.0.1:8081{}",
            plan["playback_url"].as_str().unwrap()
        ))
        .send()
        .await?;
    ensure!(file.status() == StatusCode::OK && !file.bytes().await?.is_empty());
    passed.push("qualification_refusal_same_session_original_root_ordinary_delivery");
    std::fs::write(
        std::env::var("RAINSYNC_OWNED_TEST_REPORT")?,
        serde_json::to_vec_pretty(
            &json!({"runId":run,"complete":false,"passed":passed,"parentSession":session,"nativeSession":native_session}),
        )?,
    )?;
    let before = reads.load(Ordering::SeqCst);
    let (status, replay) = request(&client, &base, &ordinary, Some(&login), true).await?;
    ensure!(
        status == StatusCode::OK
            && replay["playback_url"] == plan["playback_url"]
            && replay["session_id"] == plan["session_id"]
            && reads.load(Ordering::SeqCst) == before,
        "ordinary replay: {status}, error={}, same-session={}, same-url={}, source-reads={before}->{}",
        replay["error"],
        replay["session_id"] == plan["session_id"],
        replay["playback_url"] == plan["playback_url"],
        reads.load(Ordering::SeqCst)
    );
    passed.push("ordinary_same_key_replay_no_recapture_no_deadline_extension");
    let renewed = client
        .post(format!(
            "{base}/api/v1/playback-sessions/{native_session}/renew"
        ))
        .header("origin", "http://localhost")
        .header("x-csrf-token", "owned-public")
        .header("cookie", format!("rainsync_session={login}"))
        .send()
        .await?;
    ensure!(renewed.status() == StatusCode::OK);
    ensure!(renewed.json::<Value>().await?["original_expiry_unchanged"] == true);
    let root_unchanged: bool = sqlx::query_scalar("SELECT p.auth_login_hash IS NOT NULL AND p.expires_at=r.static_hls_root_expires_at FROM playback_requests r JOIN playback_sessions p ON p.id=r.session_id WHERE p.id=$1")
        .bind(native_session).fetch_one(&db).await?;
    ensure!(root_unchanged);
    let _ = server_stop.send(());
    server_task.await??;
    let mut term = tokio::process::Command::new("/bin/kill");
    term.args(["-TERM", &worker_id.to_string()]);
    ensure!(term.status().await?.success());
    ensure!(
        tokio::time::timeout(std::time::Duration::from_secs(20), worker.wait())
            .await??
            .success()
    );
    let _ = origin_stop.send(());
    origin_task.await??;
    let positive:bool=sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM static_hls_captures WHERE state<>'disposed' OR streams_closed_at IS NULL OR process_closed_at IS NULL OR process_disposition IS NULL OR process_disposition NOT IN('never_started','reaped') OR files_removed_at IS NULL OR disposed_at IS NULL) AND NOT EXISTS(SELECT 1 FROM cache_write_reservations)").fetch_one(&db).await?;
    ensure!(positive);
    let report = json!({"runId":run,"complete":true,"physicalDisposalProven":true,"workerPid":worker_id,"workerExited":true,"passed":passed,"parentSession":session,"nativeSession":native_session,"sourceRequests":reads.load(Ordering::SeqCst)});
    std::fs::write(
        std::env::var("RAINSYNC_OWNED_TEST_REPORT")?,
        serde_json::to_vec_pretty(&report)?,
    )?;
    db.close().await;
    Ok(())
}
