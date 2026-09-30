use crate::child_process::Child;
use std::{future::Future, time::Duration};
use tokio::sync::watch;
use tokio::time::Instant;

#[derive(Debug)]
pub struct LeaseInterrupted;
impl std::fmt::Display for LeaseInterrupted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("worker_lease_interrupted")
    }
}
impl std::error::Error for LeaseInterrupted {}

/// Missing finalization evidence is recoverable; never turn a deadline into
/// a permanent encoder failure or publish an unverified output.
pub async fn finalization_deadline<T>(
    duration: Duration,
    work: impl Future<Output = anyhow::Result<T>>,
) -> anyhow::Result<T> {
    tokio::time::timeout(duration, work)
        .await
        .map_err(|_| anyhow::Error::new(LeaseInterrupted))?
}

pub async fn stopped(stop: &mut watch::Receiver<bool>) {
    while !*stop.borrow_and_update() {
        if stop.changed().await.is_err() {
            return;
        }
    }
}

/// Start the deadline before pool acquisition/SQL/network waits. A slow reply
/// cannot manufacture more time than the database actually confirmed.
pub async fn confirmed_deadline(
    renewal: impl Future<Output = anyhow::Result<Option<Duration>>>,
) -> anyhow::Result<Option<Instant>> {
    let began = Instant::now();
    Ok(renewal
        .await?
        .and_then(|remaining| began.checked_add(remaining)))
}

/// Own the wait until the process tree is reaped, including shutdown while a
/// lease renewal is blocked. Never cancel this future to stop a child.
pub async fn supervise<F, Fut, Capacity>(
    child: &mut Child,
    stop: &mut watch::Receiver<bool>,
    mut confirmed_until: Instant,
    mut healthy: F,
    capacity: Capacity,
) -> anyhow::Result<()>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<Option<Instant>>>,
    Capacity: Future<Output = anyhow::Error>,
{
    tokio::pin!(capacity);
    let result = async {
        let mut next_check = Instant::now() + Duration::from_secs(4);
        loop {
            tokio::select! {
                biased;
                _ = stopped(stop) => anyhow::bail!("worker_shutdown"),
                error = &mut capacity => return Err(error),
                _ = tokio::time::sleep_until(confirmed_until) => return Err(LeaseInterrupted.into()),
                status = child.wait() => {
                    anyhow::ensure!(status?.success(), "ffmpeg_failed");
                    return Ok(());
                }
                _ = tokio::time::sleep_until(next_check) => {
                    tokio::select! {
                        biased;
                        _ = stopped(stop) => anyhow::bail!("worker_shutdown"),
                        error = &mut capacity => return Err(error),
                        _ = tokio::time::sleep_until(confirmed_until) => return Err(LeaseInterrupted.into()),
                        status = child.wait() => {
                            anyhow::ensure!(status?.success(), "ffmpeg_failed");
                            return Ok(());
                        }
                        result = tokio::time::timeout(Duration::from_secs(3), healthy()) => {
                            // A future can finish a single poll after the old
                            // deadline. Do not let that late response revive it.
                            if Instant::now() >= confirmed_until {
                                return Err(LeaseInterrupted.into());
                            }
                            match result {
                                Ok(Ok(Some(until))) if until > Instant::now() => {
                                    confirmed_until = until;
                                    next_check = Instant::now() + Duration::from_secs(4);
                                }
                                Ok(Ok(_)) => return Err(LeaseInterrupted.into()),
                                _ => {
                                    // Unknown is not permission to extend the lease. The
                                    // independently selected confirmed deadline still wins.
                                    tracing::warn!("worker lease renewal unknown; retrying within confirmed lease");
                                    next_check = Instant::now() + Duration::from_secs(1);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    .await;
    if result.is_err() {
        // kill() includes wait(); even a naturally exited child is reaped.
        child.kill().await?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[test]
    #[ignore = "subprocess fixture launched by supervision tests"]
    fn child_fixture() {
        std::thread::sleep(Duration::from_secs(120));
    }

    fn child() -> Child {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--ignored", "--exact", "process::tests::child_fixture"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        crate::child_process::spawn(command).unwrap()
    }

    fn lease() -> Instant {
        Instant::now() + Duration::from_secs(30)
    }

    #[tokio::test]
    async fn stalled_active_renewal_marks_readiness_failed_before_lease_expiry() {
        let mut child = child();
        let (sender, mut stop) = watch::channel(false);
        let readiness = crate::readiness::Runtime::default();
        readiness.claim_succeeded(true);
        let until = lease();
        readiness.observe_lease(&Ok::<_, ()>(Some(until)));
        let inspected = readiness.clone();
        let observer = async move {
            tokio::time::timeout(Duration::from_secs(9), async {
                loop {
                    if inspected.snapshot().checks["task_ownership"]
                        == crate::readiness::Outcome::Failed
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert!(Instant::now() < until);
            sender.send(true).unwrap();
        };
        let execution = supervise(
            &mut child,
            &mut stop,
            until,
            || readiness.check_lease(std::future::pending::<anyhow::Result<Option<Instant>>>()),
            std::future::pending::<anyhow::Error>(),
        );
        let (_, result) = tokio::join!(observer, execution);
        assert!(result.is_err());
        assert!(child.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    async fn confirmation_deducts_the_complete_request_round_trip() {
        let began = Instant::now();
        let until = confirmed_deadline(async {
            tokio::time::sleep(Duration::from_millis(40)).await;
            Ok(Some(Duration::from_millis(100)))
        })
        .await
        .unwrap()
        .unwrap();
        assert!(until <= began + Duration::from_millis(105));
        assert!(until.duration_since(Instant::now()) < Duration::from_millis(70));
    }

    #[tokio::test]
    async fn a_confirmation_received_after_expiry_cannot_revive_the_child() {
        let mut child = child();
        let (_sender, mut stop) = watch::channel(false);
        let error = tokio::time::timeout(
            Duration::from_secs(6),
            supervise(
                &mut child,
                &mut stop,
                Instant::now() + Duration::from_millis(4050),
                || async {
                    // Simulate one database-response poll delayed by processing.
                    std::thread::sleep(Duration::from_millis(150));
                    Ok(Some(lease()))
                },
                std::future::pending::<anyhow::Error>(),
            ),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(error.is::<LeaseInterrupted>());
        assert!(child.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    async fn finalization_timeouts_remain_recoverable_without_hiding_invalid_output() {
        let timeout = finalization_deadline(
            Duration::from_millis(1),
            std::future::pending::<anyhow::Result<()>>(),
        )
        .await
        .unwrap_err();
        assert!(timeout.is::<LeaseInterrupted>());
        assert_eq!(
            finalization_deadline(Duration::from_secs(1), async { Ok(42) })
                .await
                .unwrap(),
            42
        );
        let invalid = finalization_deadline(Duration::from_secs(1), async {
            Err::<(), _>(anyhow::anyhow!("truncated_output_box"))
        })
        .await
        .unwrap_err();
        assert!(!invalid.is::<LeaseInterrupted>());
    }
    #[tokio::test]
    async fn shutdown_reaps_child_even_during_stalled_health_check() {
        let mut child = child();
        let (sender, mut stop) = watch::channel(false);
        let (entered, ready) = tokio::sync::oneshot::channel();
        let mut entered = Some(entered);
        let signal = tokio::spawn(async move {
            ready.await.unwrap();
            sender.send(true).unwrap();
        });
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            supervise(
                &mut child,
                &mut stop,
                lease(),
                || {
                    entered.take().unwrap().send(()).unwrap();
                    std::future::pending::<anyhow::Result<Option<Instant>>>()
                },
                std::future::pending::<anyhow::Error>(),
            ),
        )
        .await
        .unwrap();
        assert!(result.unwrap_err().to_string().contains("worker_shutdown"));
        assert!(child.try_wait().unwrap().is_some());
        signal.await.unwrap();
    }

    #[tokio::test]
    async fn stalled_health_check_has_a_deadline_and_reaps_child() {
        let mut child = child();
        let (_sender, mut stop) = watch::channel(false);
        let began = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(12),
            supervise(
                &mut child,
                &mut stop,
                began + Duration::from_secs(9),
                std::future::pending::<anyhow::Result<Option<Instant>>>,
                std::future::pending::<anyhow::Error>(),
            ),
        )
        .await
        .unwrap();
        assert!(result.is_err());
        assert!(began.elapsed() >= Duration::from_secs(9));
        assert!(began.elapsed() < Duration::from_secs(10));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    async fn stalled_capacity_scan_does_not_block_lease_renewals() {
        let mut child = child();
        let (sender, mut stop) = watch::channel(false);
        let renewals = std::sync::atomic::AtomicUsize::new(0);
        let result = tokio::time::timeout(
            Duration::from_secs(13),
            supervise(
                &mut child,
                &mut stop,
                lease(),
                || async {
                    if renewals.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                        sender.send(true).unwrap();
                    }
                    Ok(Some(lease()))
                },
                std::future::pending::<anyhow::Error>(),
            ),
        )
        .await
        .unwrap();
        assert!(result.unwrap_err().to_string().contains("worker_shutdown"));
        assert_eq!(renewals.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert!(child.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    async fn confirmed_capacity_failure_reaps_child_and_preserves_reason() {
        let mut child = child();
        let (_sender, mut stop) = watch::channel(false);
        let error = supervise(
            &mut child,
            &mut stop,
            lease(),
            || async { Ok(Some(lease())) },
            async { persistence::media_jobs::JobFailure::CacheCapacityExceeded.into() },
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<persistence::media_jobs::JobFailure>(),
            Some(persistence::media_jobs::JobFailure::CacheCapacityExceeded)
        ));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    async fn confirmed_lost_lease_and_unknown_database_error_reap_child() {
        for database_error in [false, true] {
            let mut child = child();
            let (_sender, mut stop) = watch::channel(false);
            assert!(
                supervise(
                    &mut child,
                    &mut stop,
                    Instant::now() + Duration::from_secs(6),
                    || async move {
                        if database_error {
                            anyhow::bail!("database_unreachable")
                        }
                        Ok(None)
                    },
                    std::future::pending::<anyhow::Error>()
                )
                .await
                .is_err()
            );
            assert!(child.try_wait().unwrap().is_some());
        }
    }

    async fn postgres_claim(db: &sqlx::PgPool) -> persistence::media_jobs::Claim {
        let id = uuid::Uuid::new_v4();
        let owner = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}',clock_timestamp()+interval '1 hour')")
            .bind(id).bind(id.to_string()).execute(db).await.unwrap();
        sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec,owner_id,attempt,lease_until) VALUES($1,$1,'running','{}',$2,1,clock_timestamp()+interval '30 seconds')")
            .bind(id).bind(owner).execute(db).await.unwrap();
        sqlx::query("INSERT INTO media_outputs(job_id,attempt,owner_id,status,relative_dir,validation_version) VALUES($1,1,$2,'writing',$3,3)")
            .bind(id).bind(owner).bind(id.to_string()).execute(db).await.unwrap();
        persistence::media_jobs::Claim {
            id,
            owner,
            attempt: 1,
            spec: serde_json::json!({}),
        }
    }

    async fn postgres_deadline(
        db: &sqlx::PgPool,
        claim: &persistence::media_jobs::Claim,
    ) -> Instant {
        confirmed_deadline(persistence::media_jobs::renew_remaining(db, claim))
            .await
            .unwrap()
            .unwrap()
    }

    // Run only through tests/worker-health.mjs, which owns a disposable random
    // database/container and records real UTC start/end and cleanup evidence.
    #[tokio::test]
    #[ignore = "requires an isolated real PostgreSQL database"]
    async fn postgres_worker_health() {
        assert_eq!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref(), Ok("1"));
        let db = persistence::connect(&std::env::var("WORKER_HEALTH_DATABASE_URL").unwrap())
            .await
            .unwrap();
        let name: String = sqlx::query_scalar("SELECT current_database()")
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(name.starts_with("rainsync_worker_health_"));
        persistence::migrate(&db).await.unwrap();
        let mut evidence = Vec::new();

        // A real 4.5s job-row lock crosses the unchanged 3s query deadline.
        // The same child survives the unknown result and receives a confirmed
        // renewal after the lock releases, rather than beginning a new attempt.
        let claim = postgres_claim(&db).await;
        let until = postgres_deadline(&db, &claim).await;
        let lock_db = db.clone();
        let id = claim.id;
        let locker = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(3500)).await;
            let mut tx = lock_db.begin().await.unwrap();
            sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
                .bind(id)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            let locked = Instant::now();
            tokio::time::sleep(Duration::from_millis(4500)).await;
            tx.rollback().await.unwrap();
            locked.elapsed().as_secs_f64()
        });
        let mut child = self::child();
        let (sender, mut stop) = watch::channel(false);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let began = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            supervise(
                &mut child,
                &mut stop,
                until,
                || async {
                    let call = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let renewed =
                        confirmed_deadline(persistence::media_jobs::renew_remaining(&db, &claim))
                            .await?;
                    if renewed.is_some() && call > 0 {
                        sender.send(true).unwrap();
                    }
                    Ok(renewed)
                },
                std::future::pending::<anyhow::Error>(),
            ),
        )
        .await
        .unwrap();
        assert!(result.unwrap_err().to_string().contains("worker_shutdown"));
        assert!(calls.load(std::sync::atomic::Ordering::SeqCst) >= 2);
        assert!(child.try_wait().unwrap().is_some());
        let lock_seconds = locker.await.unwrap();
        assert!((4.4..5.5).contains(&lock_seconds));
        let attempt: i64 = sqlx::query_scalar("SELECT attempt FROM media_jobs WHERE id=$1")
            .bind(claim.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(attempt, 1);
        evidence.push(serde_json::json!({"case":"4.5s-row-lock-recovery","lock_seconds":lock_seconds,"elapsed_seconds":began.elapsed().as_secs_f64(),"renewal_requests":calls.load(std::sync::atomic::Ordering::SeqCst),"attempt":attempt,"child_reaped":true}));

        // A publication timeout leaves the known prefix untouched. Retrying
        // the complete proof transaction after unlock succeeds exactly once.
        let claim = postgres_claim(&db).await;
        let snapshot = persistence::media_outputs::Snapshot {
            manifest: "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nindex0.m4s\n".into(),
            segment_count: 1,
            files: [( -1, "database init proof"), (0, "database fragment proof")].into_iter()
                .map(|(index, bytes)| persistence::media_outputs::FileProof { index, size_bytes: bytes.len() as i64, sha256: crate::hash(bytes) }).collect(),
        };
        let mut tx = db.begin().await.unwrap();
        sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
            .bind(claim.id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let lock_began = Instant::now();
        let locker = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(4500)).await;
            tx.rollback().await.unwrap();
        });
        assert_eq!(
            crate::output_publish::publish_confirmed(&db, &claim, &snapshot)
                .await
                .unwrap(),
            None
        );
        let ready: i32 =
            sqlx::query_scalar("SELECT ready_segments FROM media_outputs WHERE job_id=$1")
                .bind(claim.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(
            ready, 0,
            "unknown publication never exposes an unconfirmed prefix"
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(
            crate::output_publish::publish_confirmed(&db, &claim, &snapshot)
                .await
                .unwrap(),
            Some(true)
        );
        locker.await.unwrap();
        let visible: String =
            sqlx::query_scalar("SELECT visible_manifest FROM media_outputs WHERE job_id=$1")
                .bind(claim.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(visible, snapshot.manifest);
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM media_output_files WHERE job_id=$1")
                .bind(claim.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(count, 2);
        sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
            .bind(claim.id)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            crate::output_publish::publish_confirmed(&db, &claim, &snapshot)
                .await
                .unwrap(),
            Some(false)
        );
        evidence.push(serde_json::json!({"case":"publication-unknown-retains-prefix","elapsed_seconds":lock_began.elapsed().as_secs_f64(),"unconfirmed_ready_segments":ready,"confirmed_file_proofs":count,"revoked_publication":false}));

        // A confirmed stopped session is not a retryable database uncertainty.
        let claim = postgres_claim(&db).await;
        let until = postgres_deadline(&db, &claim).await;
        sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
            .bind(claim.id)
            .execute(&db)
            .await
            .unwrap();
        let mut child = self::child();
        let (_sender, mut stop) = watch::channel(false);
        let began = Instant::now();
        let error = supervise(
            &mut child,
            &mut stop,
            until,
            || confirmed_deadline(persistence::media_jobs::renew_remaining(&db, &claim)),
            std::future::pending::<anyhow::Error>(),
        )
        .await
        .unwrap_err();
        assert!(error.is::<LeaseInterrupted>());
        assert!(began.elapsed() < Duration::from_secs(5));
        assert!(child.try_wait().unwrap().is_some());
        evidence.push(serde_json::json!({"case":"confirmed-session-revocation","elapsed_seconds":began.elapsed().as_secs_f64(),"child_reaped":true}));

        // Stop remains responsive while a real renewal is waiting on a row.
        let claim = postgres_claim(&db).await;
        let until = postgres_deadline(&db, &claim).await;
        let mut tx = db.begin().await.unwrap();
        sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
            .bind(claim.id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let mut child = self::child();
        let (sender, mut stop) = watch::channel(false);
        let (entered, ready) = tokio::sync::oneshot::channel();
        let mut entered = Some(entered);
        let signal = tokio::spawn(async move {
            ready.await.unwrap();
            tokio::time::sleep(Duration::from_millis(150)).await;
            let at = Instant::now();
            sender.send(true).unwrap();
            at
        });
        let error = supervise(
            &mut child,
            &mut stop,
            until,
            || {
                entered.take().unwrap().send(()).unwrap();
                confirmed_deadline(persistence::media_jobs::renew_remaining(&db, &claim))
            },
            std::future::pending::<anyhow::Error>(),
        )
        .await
        .unwrap_err();
        let signalled = signal.await.unwrap();
        assert!(error.to_string().contains("worker_shutdown"));
        assert!(signalled.elapsed() < Duration::from_secs(5));
        assert!(child.try_wait().unwrap().is_some());
        tx.rollback().await.unwrap();
        evidence.push(serde_json::json!({"case":"stop-during-postgres-row-lock","stop_seconds":signalled.elapsed().as_secs_f64(),"child_reaped":true}));

        // Continuous unknown results cannot run beyond the actual previously
        // confirmed lease, including a query pending across its final instant.
        let claim = postgres_claim(&db).await;
        let until = postgres_deadline(&db, &claim).await;
        let mut tx = db.begin().await.unwrap();
        sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
            .bind(claim.id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let mut child = self::child();
        let (_sender, mut stop) = watch::channel(false);
        let began = Instant::now();
        let confirmed_seconds = until.duration_since(began).as_secs_f64();
        let error = tokio::time::timeout(
            Duration::from_secs(33),
            supervise(
                &mut child,
                &mut stop,
                until,
                || confirmed_deadline(persistence::media_jobs::renew_remaining(&db, &claim)),
                std::future::pending::<anyhow::Error>(),
            ),
        )
        .await
        .unwrap()
        .unwrap_err();
        let elapsed = began.elapsed().as_secs_f64();
        assert!(error.is::<LeaseInterrupted>());
        assert!(elapsed >= confirmed_seconds);
        assert!(elapsed < confirmed_seconds + 1.0);
        assert!(child.try_wait().unwrap().is_some());
        tx.rollback().await.unwrap();
        // Account for the conservative request-start deduction before testing
        // the actual database expiry; do not manufacture a new local lease.
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let live: bool = sqlx::query_scalar(
                    "SELECT lease_until>clock_timestamp() FROM media_jobs WHERE id=$1",
                )
                .bind(claim.id)
                .fetch_one(&db)
                .await
                .unwrap();
                if !live {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            persistence::media_jobs::renew_remaining(&db, &claim)
                .await
                .unwrap()
                .is_none(),
            "an expired execution cannot revive after row-lock release"
        );
        evidence.push(serde_json::json!({"case":"continuous-unknown-stops-at-confirmed-expiry","confirmed_seconds":confirmed_seconds,"elapsed_seconds":elapsed,"late_renewal":false,"child_reaped":true}));

        // The original owner and attempt fences remain effective.
        let claim = postgres_claim(&db).await;
        sqlx::query("UPDATE media_jobs SET attempt=attempt+1,owner_id=$2 WHERE id=$1")
            .bind(claim.id)
            .bind(uuid::Uuid::new_v4())
            .execute(&db)
            .await
            .unwrap();
        assert!(
            persistence::media_jobs::renew_remaining(&db, &claim)
                .await
                .unwrap()
                .is_none()
        );
        evidence.push(serde_json::json!({"case":"stale-owner-and-attempt-fence","renewed":false}));
        std::fs::write(
            std::env::var("WORKER_HEALTH_REPORT").unwrap(),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
        db.close().await;
    }
}
