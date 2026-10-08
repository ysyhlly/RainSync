//! Serial playback queue coordination. Persistence owns admission, fairness and
//! the claim transaction; the original attempt body owns execution and receipts.
//! Preview and static-HLS child schedulers intentionally remain independent.
use crate::{App, process, readiness};
use persistence::media_jobs::Claim;
use sqlx::PgPool;
use std::{future::Future, time::Duration};
use tokio::sync::watch;
use uuid::Uuid;

pub(crate) async fn run(app: App, mut stop: watch::Receiver<bool>) {
    let _claim_loop = app.readiness.claim_loop_guard();
    let worker = Uuid::new_v4();
    loop {
        // Includes the original resource drain and durable receipt retry. Do
        // not spawn another attempt or prefetch a claim while it is pending.
        // Keep the large existing executor future out of this coordinator's
        // stack frame. Pinning changes storage only: it remains awaited here,
        // with the same scope, stop receiver, claim and settlement owner.
        let result = Box::pin(crate::run_next_job(&app, worker, &mut stop)).await;
        if *stop.borrow() {
            break;
        }
        if result.is_err() {
            // Never render a spec, resource, upstream error or input ticket.
            tracing::warn!("media queue retry");
        }
        if pause(&mut stop, result.is_err()).await {
            break;
        }
    }
}

/// Called inside the original child-process Scope. Returning a Claim neither
/// renews its lease nor creates a replacement execution or deadline.
pub(crate) async fn claim_next(
    db: &PgPool,
    readiness: &readiness::Runtime,
    worker: Uuid,
    stop: &mut watch::Receiver<bool>,
) -> anyhow::Result<Option<Claim>> {
    claim_with(
        readiness,
        stop,
        persistence::media_jobs::claim_platform_capable(db, worker),
    )
    .await
}

async fn claim_with(
    readiness: &readiness::Runtime,
    stop: &mut watch::Receiver<bool>,
    claim: impl Future<Output = anyhow::Result<Option<Claim>>>,
) -> anyhow::Result<Option<Claim>> {
    tokio::select! {
        biased;
        _ = process::stopped(stop) => Ok(None),
        result = tokio::time::timeout(Duration::from_secs(3), claim) => {
            match &result {
                Ok(Ok(value)) => readiness.claim_succeeded(value.is_some()),
                _ => readiness.claim_failed(),
            }
            Ok(result??)
        },
    }
}

async fn pause(stop: &mut watch::Receiver<bool>, failed: bool) -> bool {
    tokio::select! {
        _ = process::stopped(stop) => true,
        _ = tokio::time::sleep(Duration::from_secs(if failed { 2 } else { 1 })) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::readiness::Outcome;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn claim(owner: Uuid) -> Claim {
        Claim {
            id: Uuid::new_v4(),
            owner,
            attempt: 7,
            spec: json!({"input_ticket":"private-test-ticket"}),
        }
    }

    #[test]
    fn coordinator_keeps_the_attempt_frame_on_the_heap() {
        fn future_size<F>(_: impl Fn(App, watch::Receiver<bool>) -> F) -> usize {
            std::mem::size_of::<F>()
        }
        fn attempt_future_size<F>(
            _: impl Fn(&'static App, Uuid, &'static mut watch::Receiver<bool>) -> F,
        ) -> usize {
            std::mem::size_of::<F>()
        }
        let bytes = future_size(run);
        let attempt_bytes = attempt_future_size(crate::run_next_job);
        println!(
            "coordinator future: {bytes} bytes; original attempt future: {attempt_bytes} bytes"
        );
        assert!(
            bytes <= 16 * 1024,
            "coordinator future occupies {bytes} bytes"
        );
    }

    #[tokio::test]
    async fn already_stopped_wins_without_polling_a_ready_claim() {
        let (_sender, mut stop) = watch::channel(true);
        let readiness = readiness::Runtime::default();
        let polled = AtomicUsize::new(0);
        let result = claim_with(&readiness, &mut stop, async {
            polled.fetch_add(1, Ordering::SeqCst);
            Ok(Some(claim(Uuid::new_v4())))
        })
        .await
        .unwrap();
        assert!(result.is_none());
        assert_eq!(polled.load(Ordering::SeqCst), 0);
        assert_eq!(readiness.snapshot().checks["claim_loop"], Outcome::Unknown);
    }

    #[tokio::test]
    async fn stop_interrupts_a_pending_claim_without_reporting_a_claim_failure() {
        let (sender, mut stop) = watch::channel(false);
        let readiness = readiness::Runtime::default();
        let claiming = claim_with(&readiness, &mut stop, std::future::pending());
        let stopping = async {
            tokio::task::yield_now().await;
            sender.send(true).unwrap();
        };
        let (result, ()) = tokio::join!(claiming, stopping);
        assert!(result.unwrap().is_none());
        assert_eq!(readiness.snapshot().checks["claim_loop"], Outcome::Unknown);
    }

    #[tokio::test]
    async fn a_completed_claim_keeps_the_exact_original_identity_and_spec() {
        let (_sender, mut stop) = watch::channel(false);
        let readiness = readiness::Runtime::default();
        let original = claim(Uuid::new_v4());
        let identity = (original.id, original.owner, original.attempt);
        let spec = original.spec.clone();
        let received = claim_with(&readiness, &mut stop, async { Ok(Some(original)) })
            .await
            .unwrap()
            .unwrap();
        assert_eq!((received.id, received.owner, received.attempt), identity);
        assert_eq!(received.spec, spec);
        assert_eq!(readiness.snapshot().checks["claim_loop"], Outcome::Ready);
        assert_eq!(
            readiness.snapshot().checks["task_ownership"],
            Outcome::Unknown
        );
    }

    #[tokio::test]
    async fn an_empty_queue_and_a_failed_claim_keep_distinct_health_evidence() {
        let (_sender, mut stop) = watch::channel(false);
        let readiness = readiness::Runtime::default();
        assert!(
            claim_with(&readiness, &mut stop, async { Ok(None) })
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            readiness.snapshot().checks["task_ownership"],
            Outcome::Ready
        );
        assert!(
            claim_with(&readiness, &mut stop, async {
                Err(anyhow::anyhow!("fixture_database_unavailable"))
            })
            .await
            .is_err()
        );
        assert_eq!(readiness.snapshot().checks["claim_loop"], Outcome::Failed);
    }

    #[tokio::test(start_paused = true)]
    async fn claim_timeout_keeps_the_original_three_second_bound() {
        let (_sender, mut stop) = watch::channel(false);
        let readiness = readiness::Runtime::default();
        let began = tokio::time::Instant::now();
        let error = claim_with(&readiness, &mut stop, std::future::pending())
            .await
            .err()
            .unwrap();
        assert!(error.is::<tokio::time::error::Elapsed>());
        assert_eq!(began.elapsed(), Duration::from_secs(3));
        assert_eq!(readiness.snapshot().checks["claim_loop"], Outcome::Failed);
    }

    #[tokio::test(start_paused = true)]
    async fn serial_cadence_keeps_the_original_success_and_error_delays() {
        let (sender, mut stop) = watch::channel(false);
        for (failed, seconds) in [(false, 1), (true, 2)] {
            let began = tokio::time::Instant::now();
            assert!(!pause(&mut stop, failed).await);
            assert_eq!(began.elapsed(), Duration::from_secs(seconds));
        }
        sender.send(true).unwrap();
        assert!(pause(&mut stop, true).await);
    }
}
