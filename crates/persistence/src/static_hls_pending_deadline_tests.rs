//! Deterministic local budget witnesses. No database, service, process, scanner,
//! or responsive-owner timing evidence is produced by these tests.
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};

#[derive(Clone)]
struct Clock {
    anchor: Instant,
    millis: Arc<AtomicU64>,
}
impl Clock {
    fn new() -> Self {
        Self {
            anchor: Instant::now(),
            millis: Arc::new(AtomicU64::new(0)),
        }
    }
    fn now(&self) -> Instant {
        self.anchor + Duration::from_millis(self.millis.load(Ordering::SeqCst))
    }
    fn advance(&self, millis: u64) {
        self.millis.fetch_add(millis, Ordering::SeqCst);
    }
}

struct Activation {
    clock: Clock,
    stages: [u64; 2],
    calls: AtomicUsize,
}
impl Activation {
    fn new(clock: &Clock, stages: [u64; 2]) -> Self {
        Self {
            clock: clock.clone(),
            stages,
            calls: AtomicUsize::new(0),
        }
    }
}
impl crate::static_hls::ActivationCheck for Activation {
    fn check(&self) -> media_core::static_hls::CaptureFuture<'_, ()> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            self.clock.advance(self.stages[call]);
            Ok(())
        })
    }
}

#[tokio::test]
async fn staged_latency_shares_one_absolute_budget() {
    let clock = Clock::new();
    let activation = Activation::new(&clock, [300, 300]);
    let read_clock = clock.clone();
    let read = async move {
        read_clock.advance(300);
        Ok(Some(Duration::from_secs(10)))
    };
    let observed = clock.clone();
    let result =
        pending_authority_check(clock.now(), &activation, read, move || observed.now()).await;
    assert_eq!(
        result.unwrap_err().to_string(),
        "static_hls_authority_unknown"
    );
    assert_eq!(activation.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn first_activation_is_charged_to_the_db_lifetime() {
    let clock = Clock::new();
    let activation = Activation::new(&clock, [300, 50]);
    let read_clock = clock.clone();
    let read = async move {
        read_clock.advance(100);
        Ok(Some(Duration::from_millis(450)))
    };
    let observed = clock.clone();
    let result =
        pending_authority_check(clock.now(), &activation, read, move || observed.now()).await;
    assert_eq!(
        result.unwrap_err().to_string(),
        "static_hls_capture_authority_expired"
    );
}

#[tokio::test]
async fn pool_wait_and_sql_both_reduce_the_returned_lifetime() {
    for remaining in [700, 701] {
        let clock = Clock::new();
        let activation = Activation::new(&clock, [50, 50]);
        let read_clock = clock.clone();
        let read = async move {
            read_clock.advance(500); // fake pool acquisition
            read_clock.advance(100); // fake transaction/SQL round trip
            Ok(Some(Duration::from_millis(remaining)))
        };
        let observed = clock.clone();
        let result =
            pending_authority_check(clock.now(), &activation, read, move || observed.now()).await;
        assert_eq!(result.is_ok(), remaining == 701);
        assert_eq!(activation.calls.load(Ordering::SeqCst), 2);
    }
}

#[tokio::test]
async fn exhausted_pool_wait_prevents_final_activation() {
    let clock = Clock::new();
    let activation = Activation::new(&clock, [50, 0]);
    let read_clock = clock.clone();
    let read = async move {
        read_clock.advance(700);
        Ok(Some(Duration::from_secs(10)))
    };
    let observed = clock.clone();
    assert!(
        pending_authority_check(clock.now(), &activation, read, move || observed.now())
            .await
            .is_err()
    );
    assert_eq!(activation.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn ready_completion_at_exact_budget_is_refused() {
    for final_activation in [249, 250] {
        let clock = Clock::new();
        let activation = Activation::new(&clock, [250, final_activation]);
        let read_clock = clock.clone();
        let read = async move {
            read_clock.advance(250);
            Ok(Some(Duration::from_secs(10)))
        };
        let observed = clock.clone();
        let result =
            pending_authority_check(clock.now(), &activation, read, move || observed.now()).await;
        assert_eq!(result.is_ok(), final_activation == 249);
    }
}

#[tokio::test]
async fn created_before_first_poll_cannot_restart_the_deadline() {
    let clock = Clock::new();
    let activation = Activation::new(&clock, [0, 0]);
    let reads = Arc::new(AtomicUsize::new(0));
    let read_calls = reads.clone();
    let read = async move {
        read_calls.fetch_add(1, Ordering::SeqCst);
        Ok(Some(Duration::from_secs(10)))
    };
    let observed = clock.clone();
    let check = pending_authority_check(clock.now(), &activation, read, move || observed.now());
    clock.advance(750);
    assert_eq!(
        check.await.unwrap_err().to_string(),
        "static_hls_authority_unknown"
    );
    assert_eq!(activation.calls.load(Ordering::SeqCst), 0);
    assert_eq!(reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn pre_poll_delay_is_included_in_lifetime_subtraction() {
    let clock = Clock::new();
    let activation = Activation::new(&clock, [50, 50]);
    let read = async { Ok(Some(Duration::from_millis(600))) };
    let observed = clock.clone();
    let check = pending_authority_check(clock.now(), &activation, read, move || observed.now());
    clock.advance(500);
    assert_eq!(
        check.await.unwrap_err().to_string(),
        "static_hls_capture_authority_expired"
    );
}

#[tokio::test]
async fn clock_regression_after_activation_refuses_db_evidence() {
    let clock = Clock::new();
    let activation = Activation::new(&clock, [100, 0]);
    let read_clock = clock.clone();
    let read = async move {
        read_clock.millis.store(99, Ordering::SeqCst);
        Ok(Some(Duration::from_secs(10)))
    };
    let observed = clock.clone();
    let result =
        pending_authority_check(clock.now(), &activation, read, move || observed.now()).await;
    assert_eq!(
        result.unwrap_err().to_string(),
        "static_hls_authority_unknown"
    );
    assert_eq!(activation.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unknown_or_revoked_db_authority_cannot_be_positive() {
    for unknown in [false, true] {
        let clock = Clock::new();
        let activation = Activation::new(&clock, [0, 0]);
        let read = async move {
            if unknown {
                anyhow::bail!("synthetic_database_unknown");
            }
            Ok(None)
        };
        let observed = clock.clone();
        let result =
            pending_authority_check(clock.now(), &activation, read, move || observed.now()).await;
        assert_eq!(
            result.unwrap_err().to_string(),
            if unknown {
                "synthetic_database_unknown"
            } else {
                "static_hls_capture_authority_revoked"
            }
        );
        assert_eq!(activation.calls.load(Ordering::SeqCst), 1);
    }
}

struct PendingRead(Arc<AtomicUsize>);
impl Future for PendingRead {
    type Output = Result<Option<Duration>>;
    fn poll(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        std::task::Poll::Pending
    }
}
impl Drop for PendingRead {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn timer_timeout_drops_only_the_observation_future() {
    // The fake clock remains live; the actual timer is already expired. This
    // exercises timeout cancellation deterministically without sleeping.
    let started = Instant::now() - Duration::from_secs(1);
    let mut deadline = PendingAuthorityDeadline::new(started).unwrap();
    let dropped = Arc::new(AtomicUsize::new(0));
    let read = PendingRead(dropped.clone());
    let result = deadline
        .observe(|| read, &|| started, "static_hls_authority_unknown")
        .await;
    assert_eq!(
        result.unwrap_err().to_string(),
        "static_hls_authority_unknown"
    );
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn canceling_check_drops_the_read_without_minting_disposal() {
    let clock = Clock::new();
    let activation = Activation::new(&clock, [0, 0]);
    let dropped = Arc::new(AtomicUsize::new(0));
    let read = PendingRead(dropped.clone());
    let observed = clock.clone();
    let mut check = pending_authority_check(clock.now(), &activation, read, move || observed.now());
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(check.as_mut().poll(&mut context).is_pending());
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
    drop(check);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert_eq!(activation.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn exact_db_expiry_and_subnanosecond_budget_boundary_fail_closed() {
    let started = Instant::now();
    let mut deadline = PendingAuthorityDeadline::new(started).unwrap();
    let elapsed = PENDING_AUTHORITY_TIME - Duration::from_nanos(1);
    assert_eq!(
        deadline
            .conservative_remaining(PENDING_AUTHORITY_TIME, started + elapsed)
            .unwrap(),
        Duration::from_nanos(1)
    );
    assert!(
        deadline
            .conservative_remaining(elapsed, started + elapsed)
            .is_err()
    );
    assert!(
        deadline
            .elapsed_at(started + PENDING_AUTHORITY_TIME)
            .is_err()
    );
}

#[test]
fn conservative_observation_cannot_extend_an_existing_phase_or_root_fence() {
    use media_core::static_hls::contracts::{ContractError, phase::DeadlineFenceStatements};
    let input = FrozenInput::parse_private_plaintext(include_bytes!(
        "../../media-core/src/static_hls/contracts/golden_input_v1.json"
    ))
    .unwrap();
    let mut fences = DeadlineFenceStatements::from_input(&input, 1000, 0).unwrap();
    let started = Instant::now();
    let mut deadline = PendingAuthorityDeadline::new(started).unwrap();
    let phase_remaining = deadline
        .conservative_remaining(
            Duration::from_millis(1200),
            started + Duration::from_millis(600),
        )
        .unwrap();
    assert_eq!(phase_remaining, Duration::from_millis(600));
    // Entry tick 100 + raw DB phase 1200 equals completion tick 700 +
    // conservative phase 600. The existing pure fence retains that same cap.
    fences.observe(100, 700, 10_000, Some(1200)).unwrap();
    fences.observe(800, 900, 500_000, Some(50_000)).unwrap();
    fences.require_live(1299).unwrap();
    assert_eq!(fences.require_live(1300), Err(ContractError::Deadline));

    let mut root = DeadlineFenceStatements::from_input(&input, 1000, 0).unwrap();
    root.complete_preparation(1).unwrap();
    root.observe(100, 700, 1000, None).unwrap();
    root.observe(800, 900, 500_000, None).unwrap();
    root.require_live(1099).unwrap();
    assert_eq!(root.require_live(1100), Err(ContractError::Deadline));
    assert_eq!(root.require_live(1101), Err(ContractError::Deadline));
}
