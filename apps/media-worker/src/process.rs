use std::{future::Future, time::Duration};
use tokio::{process::Child, sync::watch};

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

/// Own the wait until the direct child is reaped, including shutdown while a
/// lease renewal is blocked. Never cancel this future to stop a child.
pub async fn supervise<F, Fut, Capacity>(
    child: &mut Child,
    stop: &mut watch::Receiver<bool>,
    mut healthy: F,
    capacity: Capacity,
) -> anyhow::Result<()>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<bool>>,
    Capacity: Future<Output = anyhow::Error>,
{
    tokio::pin!(capacity);
    let result = async {
        loop {
            tokio::select! {
                biased;
                _ = stopped(stop) => anyhow::bail!("worker_shutdown"),
                error = &mut capacity => return Err(error),
                status = child.wait() => {
                    anyhow::ensure!(status?.success(), "ffmpeg_failed");
                    return Ok(());
                }
                _ = tokio::time::sleep(Duration::from_secs(5)) => {
                    tokio::select! {
                        biased;
                        _ = stopped(stop) => anyhow::bail!("worker_shutdown"),
                        result = tokio::time::timeout(Duration::from_secs(3), healthy()) => {
                            if !matches!(result, Ok(Ok(true))) { return Err(LeaseInterrupted.into()); }
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
        command.spawn().unwrap()
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
                || {
                    entered.take().unwrap().send(()).unwrap();
                    std::future::pending::<anyhow::Result<bool>>()
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
        let result = tokio::time::timeout(
            Duration::from_secs(12),
            supervise(
                &mut child,
                &mut stop,
                std::future::pending::<anyhow::Result<bool>>,
                std::future::pending::<anyhow::Error>(),
            ),
        )
        .await
        .unwrap();
        assert!(result.is_err());
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
                || async {
                    if renewals.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                        sender.send(true).unwrap();
                    }
                    Ok(true)
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
        let error = supervise(&mut child, &mut stop, || async { Ok(true) }, async {
            persistence::media_jobs::JobFailure::CacheCapacityExceeded.into()
        })
        .await
        .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<persistence::media_jobs::JobFailure>(),
            Some(persistence::media_jobs::JobFailure::CacheCapacityExceeded)
        ));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    async fn lost_lease_and_database_error_reap_child() {
        for database_error in [false, true] {
            let mut child = child();
            let (_sender, mut stop) = watch::channel(false);
            assert!(
                supervise(
                    &mut child,
                    &mut stop,
                    || async move {
                        if database_error {
                            anyhow::bail!("database_unreachable")
                        }
                        Ok(false)
                    },
                    std::future::pending::<anyhow::Error>()
                )
                .await
                .is_err()
            );
            assert!(child.try_wait().unwrap().is_some());
        }
    }
}
