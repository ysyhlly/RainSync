//! The original owned input survives a cancelled public probe waiter. Unknown
//! private process/IO drain retains input custody and the outer scope receipt.
use super::*;
use std::{future::Future, io};
use tokio::sync::oneshot;

async fn drain_until_positive<F, Fut>(mut drain: F, mut unknown: impl FnMut())
where
    F: FnMut() -> Fut,
    Fut: Future<Output = io::Result<()>>,
{
    loop {
        match drain().await {
            Ok(()) => return,
            Err(_) => {
                unknown();
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}
/// Registration captures the original snapshot before process admission. The
/// inner scope owns decoder reaping; the inherited delivery scope owns this
/// supervisor receipt and must not be shut down from inside its own receipt.
pub(super) fn launch<T, Work, WorkFuture, Post, PostFuture>(
    snapshot: Arc<Snapshot>,
    work: Work,
    post: Post,
) -> anyhow::Result<oneshot::Receiver<anyhow::Result<T>>>
where
    T: Send + 'static,
    Work: FnOnce(Arc<Snapshot>) -> WorkFuture + Send + 'static,
    WorkFuture: Future<Output = anyhow::Result<T>> + Send + 'static,
    Post: FnOnce(Arc<Snapshot>, T) -> PostFuture + Send + 'static,
    PostFuture: Future<Output = anyhow::Result<T>> + Send + 'static,
{
    let (sender, receiver) = oneshot::channel();
    child_process::supervise(async move {
        let owner = snapshot;
        let private = child_process::Scope::new();
        let mut sender = Some(sender);
        let mut retired = owner.retired.clone();
        let result = if *retired.borrow() || tokio::time::Instant::now() >= owner.until {
            Err(anyhow::anyhow!("owned_http_retired"))
        } else {
            private.run(async {
                tokio::select! {
                    biased;
                    _=sender.as_mut().expect("owned probe sender").closed()=>Err(anyhow::anyhow!("owned_http_probe_waiter_closed")),
                    _=retired.changed()=>Err(anyhow::anyhow!("owned_http_retired")),
                    _=tokio::time::sleep_until(owner.until)=>Err(anyhow::anyhow!("owned_http_retired")),
                    result=work(owner.clone())=>result,
                }
            }).await
        };
        drain_until_positive(
            || {
                let scope = private.clone();
                async move { scope.shutdown().await }
            },
            || {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(Err(anyhow::anyhow!("owned_http_probe_drain_unknown")));
                }
            },
        )
        .await;
        // Only positive private drain permits ordinary extraction errors or a
        // final authority check to release the original retained descriptor.
        let result = match result {
            Ok(value) => post(owner.clone(), value).await,
            Err(error) => Err(error),
        };
        drop(owner);
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
        Ok(())
    })?;
    Ok(receiver)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn snapshot() -> (Arc<Snapshot>, std::path::PathBuf, watch::Sender<bool>) {
        let root = std::env::temp_dir().join(format!("rainsync-owned-probe-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("source.bin");
        std::fs::write(&path, b"owned synthetic input").unwrap();
        let input = Arc::new(
            OwnedLocalInput::materialized_retained(std::fs::File::open(&path).unwrap(), path)
                .unwrap(),
        );
        let (retire, retired) = watch::channel(false);
        (
            Arc::new(Snapshot {
                input,
                finite_evidence: None,
                bytes: 21,
                sha256: "a".repeat(64),
                target_sha256: "b".repeat(64),
                until: tokio::time::Instant::now() + Duration::from_secs(30),
                acquisition_until: tokio::time::Instant::now() + Duration::from_secs(25),
                retired,
            }),
            root,
            retire,
        )
    }
    #[tokio::test]
    async fn canceled_probe_keeps_snapshot_and_outer_receipt_until_real_private_drain() {
        let (snapshot, root, _retired) = snapshot();
        let outer = child_process::Scope::new();
        let (release, gate) = std::sync::mpsc::channel();
        let started = Arc::new(AtomicUsize::new(0));
        let observed = started.clone();
        let leader = root.join("leader.pid");
        let descendant = root.join("descendant.pid");
        let leader_path = leader.clone();
        let descendant_path = descendant.clone();
        let waiter = outer
            .run(async {
                launch(
                    snapshot.clone(),
                    move |input| async move {
                        let mut command = tokio::process::Command::new("/bin/sh");
                        command.args(["-c", r#"set -e; cat "$OWNED_INPUT" >/dev/null; printf '%s\n' "$$" >"$LEADER_PID"; sleep 60 & printf '%s\n' "$!" >"$DESCENDANT_PID"; wait"#])
                            .env("OWNED_INPUT",input.input.decoder_path()?)
                            .env("LEADER_PID",leader_path).env("DESCENDANT_PID",descendant_path);
                        input.input.install(&mut command)?;
                        // A real managed process and an independently registered blocking
                        // reader prove this private drain cannot be inferred from Arc/PID.
                        let mut child = child_process::spawn(command)?;
                        let read = input.input.duplicate_file()?;
                        child_process::blocking(move || {
                            let _read=read;
                            observed.store(1, Ordering::SeqCst);
                            gate.recv().unwrap();
                        })
                        .await?;
                        let _ = child.wait().await?;
                        Ok::<_, anyhow::Error>(())
                    },
                    |_input, value| async move { Ok(value) },
                )
            })
            .await
            .unwrap();
        while started.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let (leader_pid, descendant_pid) = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let leader_pid = std::fs::read_to_string(&leader)
                    .ok()
                    .and_then(|v| v.trim().parse::<i32>().ok())
                    .filter(|pid| *pid > 1);
                let descendant_pid = std::fs::read_to_string(&descendant)
                    .ok()
                    .and_then(|v| v.trim().parse::<i32>().ok())
                    .filter(|pid| *pid > 1);
                if let (Some(leader), Some(descendant)) = (leader_pid, descendant_pid) {
                    return (leader, descendant);
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        drop(waiter);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), outer.shutdown())
                .await
                .is_err()
        );
        assert!(Arc::strong_count(&snapshot) > 1);
        assert!(snapshot.input.verify().is_ok());
        assert!(root.join("source.bin").exists());
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(3), outer.shutdown())
            .await
            .unwrap()
            .unwrap();
        for pid in [leader_pid, descendant_pid] {
            assert_eq!(
                std::fs::symlink_metadata(format!("/proc/{pid}"))
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::NotFound
            );
        }
        assert_eq!(Arc::strong_count(&snapshot), 1);
        assert_eq!(Arc::strong_count(&snapshot.input), 1);
        drop(snapshot);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn unknown_drain_holds_original_input_and_receipt_without_age_based_success() {
        let (snapshot, root, _retired) = snapshot();
        let outer = child_process::Scope::new();
        let errors = Arc::new(AtomicUsize::new(0));
        let observed = errors.clone();
        let (release, gate) = watch::channel(false);
        let held = snapshot.clone();
        outer
            .run(async {
                child_process::supervise(async move {
                    drain_until_positive(
                        || {
                            let gate = gate.clone();
                            let count = observed.clone();
                            async move {
                                if *gate.borrow() {
                                    Ok(())
                                } else {
                                    count.fetch_add(1, Ordering::SeqCst);
                                    Err(io::Error::other("synthetic private reap unknown"))
                                }
                            }
                        },
                        || {},
                    )
                    .await;
                    drop(held);
                    Ok(())
                })
                .unwrap();
            })
            .await;
        while errors.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), outer.shutdown())
                .await
                .is_err()
        );
        assert!(Arc::strong_count(&snapshot) > 1);
        assert!(snapshot.input.verify().is_ok());
        assert!(root.join("source.bin").exists());
        // The fixture explicitly supplies a later positive test receipt. Elapsed
        // time or the preceding failures never caused custody release.
        release.send_replace(true);
        tokio::time::timeout(Duration::from_secs(3), outer.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(Arc::strong_count(&snapshot), 1);
        drop(snapshot);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn cancellation_before_admission_and_retired_or_expired_input_never_launch_work() {
        for mode in ["closed", "retired", "expired"] {
            let (mut snapshot, root, retire) = snapshot();
            let outer = child_process::Scope::new();
            let work = Arc::new(AtomicUsize::new(0));
            let observed = work.clone();
            if mode == "retired" {
                retire.send_replace(true);
            } else if mode == "expired" {
                Arc::get_mut(&mut snapshot).unwrap().until = tokio::time::Instant::now();
            }
            let receiver = outer
                .run(async {
                    launch(
                        snapshot.clone(),
                        move |_input| async move {
                            observed.fetch_add(1, Ordering::SeqCst);
                            Ok::<_, anyhow::Error>(())
                        },
                        |_, value| async move { Ok(value) },
                    )
                })
                .await
                .unwrap();
            if mode == "closed" {
                drop(receiver);
            } else {
                assert!(receiver.await.unwrap().is_err());
            }
            tokio::time::timeout(Duration::from_secs(3), outer.shutdown())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(work.load(Ordering::SeqCst), 0);
            assert_eq!(Arc::strong_count(&snapshot), 1);
            drop(snapshot);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
