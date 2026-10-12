//! Server composition root: offline commands, runtimes, database startup and owners.
mod app_assembly;
mod config;
mod lifecycle;
mod routes;

use crate::*;

pub(crate) fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("init-admin") {
        let arguments: Vec<String> = std::env::args().skip(2).collect();
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(admin_bootstrap::run(&arguments));
    }
    if std::env::args().nth(1).as_deref() == Some("--source-access-contract") {
        anyhow::ensure!(
            std::env::args().len() == 2,
            "invalid capability probe arguments"
        );
        println!("{}", providers::source_access_contract::SERVER);
        return Ok(());
    }
    // Offline cutover probe: no runtime, environment loading, database or listener.
    if std::env::args().nth(1).as_deref() == Some("--media-authorization-contract") {
        anyhow::ensure!(
            std::env::args().len() == 2,
            "invalid capability probe arguments"
        );
        println!(
            "{{\"schema_version\":1,\"contract\":\"media-login-binding-v1\",\"migration\":41,\"legacy\":\"fixed-expiry\",\"caller\":\"exact-login\"}}"
        );
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let owners = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .thread_name("media-owner")
        .enable_all()
        .build()?;
    media_core::child_process::set_owner_runtime(owners.handle().clone())?;
    let application = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = application.block_on(async {
        let (lost, loss) = tokio::sync::oneshot::channel();
        tokio::select! {
            biased;
            Ok(()) = loss => anyhow::bail!("server instance lock connection lost"),
            result = run(lost) => result,
        }
    });
    // On lock loss there is no HTTP grace period: abort every application task,
    // including upgraded sockets and detached maintenance/preparation tasks.
    // The separate process reactor remains alive to kill and reap descendants.
    drop(application);
    owners.block_on(media_core::child_process::shutdown())?;
    result
}

async fn run(lost: tokio::sync::oneshot::Sender<()>) -> anyhow::Result<()> {
    let config::DatabaseSettings {
        deployment,
        cipher,
        control: control_settings,
        database_url,
    } = config::DatabaseSettings::from_env()?;
    let media_authority = control_settings
        .as_ref()
        .is_none_or(|settings| settings.media_authority());
    let db = persistence::connect_with_control_instance(
        &database_url,
        control_settings.as_ref().map(|settings| settings.node),
        control_settings.as_ref().map(|settings| settings.instance),
    )
    .await?;
    source_key_check::verify(&db, &cipher).await?;
    persistence::migrate(&db).await?;
    if control_settings.is_none() {
        anyhow::ensure!(
            !persistence::room_node_leases::active_cluster(&db).await?,
            "control cluster mode is required for this database"
        );
    }
    let signal_loss = Arc::new(Mutex::new(Some(lost)));
    let readiness = Arc::new(health::Runtime::default());
    readiness.observe(health::Check::InstanceOwnership, health::Outcome::Ready);
    if media_authority {
        let mut lock = db.acquire().await?;
        let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(72614931)")
            .fetch_one(&mut *lock)
            .await?;
        anyhow::ensure!(acquired, "another RainSync server owns the instance lock");
        let lock_readiness = readiness.clone();
        let lock_loss = signal_loss.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                if !matches!(
                    tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        sqlx::query("SELECT 1").execute(&mut *lock),
                    )
                    .await,
                    Ok(Ok(_))
                ) {
                    lock_readiness
                        .observe(health::Check::InstanceOwnership, health::Outcome::Failed);
                    lock_readiness.accepting(false);
                    if let Some(lost) = lock_loss.lock().await.take() {
                        let _ = lost.send(());
                    }
                    // A timed-out connection may still own the lock. Retain it
                    // until the supervisor stops the entire application runtime.
                    std::future::pending::<()>().await;
                    return;
                }
                // This is the same live connection which owns the advisory lock.
                lock_readiness.observe(health::Check::InstanceOwnership, health::Outcome::Ready);
            }
        });
    }
    let probe_db = db.clone();
    let probe_readiness = readiness.clone();
    tokio::spawn(async move {
        loop {
            let healthy = matches!(
                tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    database_checks::boolean(&probe_db, sqlx::query_scalar("SELECT true"), 750)
                )
                .await,
                Ok(Ok(_))
            );
            probe_readiness.observe(
                health::Check::Database,
                if healthy {
                    health::Outcome::Ready
                } else {
                    health::Outcome::Failed
                },
            );
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&db)
        .await?;
    if count == 0 {
        anyhow::ensure!(
            media_authority,
            "initialize the media authority before a control-only node"
        );
        let password = std::env::var("ADMIN_PASSWORD")?;
        let username = std::env::var("ADMIN_USERNAME").unwrap_or("admin".into());
        anyhow::ensure!(
            account_rules::valid_password(&password),
            "ADMIN_PASSWORD must have 8-1024 printable ASCII characters; spaces are preserved"
        );
        anyhow::ensure!(
            account_rules::valid_username(&username),
            "ADMIN_USERNAME must match [A-Za-z0-9_.-] and have 1-80 characters"
        );
        let pw = Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map_err(|_| anyhow::anyhow!("hash_failed"))?
            .to_string();
        sqlx::query("INSERT INTO users VALUES($1,$2,$3,true)")
            .bind(Uuid::new_v4())
            .bind(username)
            .bind(pw)
            .execute(&db)
            .await?;
    }
    let public_origin = deployment.public_origin;
    let epoch = Uuid::new_v4();
    let start = Instant::now();
    let control_cluster = match control_settings {
        Some(settings) => {
            Some(control_cluster::Runtime::start(db.clone(), settings, epoch, start).await?)
        }
        None => None,
    };
    let control_shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
    if let Some(cluster) = control_cluster.clone() {
        let health = readiness.clone();
        let loss = signal_loss.clone();
        let stopping = control_shutdown.clone();
        tokio::spawn(async move {
            loop {
                if stopping.load(std::sync::atomic::Ordering::Acquire) {
                    return;
                }
                if !cluster.healthy() && !stopping.load(std::sync::atomic::Ordering::Acquire) {
                    health.observe(health::Check::InstanceOwnership, health::Outcome::Failed);
                    health.accepting(false);
                    if let Some(lost) = loss.lock().await.take() {
                        let _ = lost.send(());
                    }
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        });
    }
    let app = app_assembly::assemble(app_assembly::Context {
        db: &db,
        readiness: &readiness,
        control_cluster: &control_cluster,
        public_origin,
        cipher,
        epoch,
        start,
    })?;
    // Retire previous-process grants before same-key recovery. The instance
    // lock fences new valid publication; it is not positive physical drain
    // proof. Unknown preparation/resource receipts remain unconfirmed.
    if media_authority {
        upstream_policy::startup(&app).await?;
        let mut recovery = db.begin().await?;
        // Keep legacy startup semantics in their own transaction. It must not
        // acquire pending-custody room locks after these legacy request locks.
        sqlx::query("UPDATE playback_requests SET status='failed',error_status=409,error_code='playback_request_interrupted' WHERE status='pending' AND static_hls_input_version IS NULL")
        .execute(&mut *recovery).await?;
        sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id IN(SELECT session_id FROM playback_requests WHERE status='failed' AND error_code='playback_request_interrupted')")
        .execute(&mut *recovery).await?;
        persistence::upstream_reservations::recover(&mut recovery, app.epoch).await?;
        recovery.commit().await?;
        persistence::static_hls_pending::recover_pending(&db).await?;
    }
    if control_cluster.is_none() {
        persistence::room_diagnostics::reset_clock(&db, app.epoch).await?;
    }
    lifecycle::serve(app, media_authority, control_shutdown).await
}
