//! Fixed, process-local observations of committed media-job transitions.
//!
//! Callers accumulate rows in a transaction-local [`PendingJobHealth`] and call
//! [`publish_committed`] only after an unambiguous database commit acknowledgement.
//! Dropping a pending delta, including on rollback, publishes nothing. An unknown
//! commit acknowledgement must instead call [`mark_observation_incomplete`]; it
//! must not guess which events committed. Arm a commit or mutation observation
//! guard before awaiting the acknowledgement so task cancellation also records
//! a possible gap without inventing committed events.
//!
//! These counters are observations, not a durable job history. They reset on
//! process restart, and crashes can leave gaps between committing and publishing.
//! Collection never waits for another producer or scrape. Lost observations set
//! a sticky quality flag; an unavailable snapshot omits counters instead of
//! reporting false zeros. Storage is independent of body-stream metrics.

use crate::runtime_metrics::Process;
use std::fmt::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, TryLockError};

const COUNTER_SLOTS: usize = 6;
const CANCELLATIONS_SLOT: usize = 3;
const RETRY_LABELS: [&str; 3] = ["upstream_transport", "worker_shutdown", "lease_expired"];
const LEASE_EXPIRY_LABELS: [&str; 2] = ["requeued", "exhausted"];

/// A closed set of reasons for scheduling a media-job retry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryReason {
    UpstreamTransport,
    WorkerShutdown,
    LeaseExpired,
}

impl RetryReason {
    const fn slot(self) -> usize {
        match self {
            Self::UpstreamTransport => 0,
            Self::WorkerShutdown => 1,
            Self::LeaseExpired => 2,
        }
    }
}

/// The committed result of normalizing an expired job lease.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseExpiryResult {
    Requeued,
    Exhausted,
}

impl LeaseExpiryResult {
    const fn slot(self) -> usize {
        match self {
            Self::Requeued => 4,
            Self::Exhausted => 5,
        }
    }
}

/// An owned transaction-local delta. It cannot be cloned or copied for replay.
///
/// Overflow invalidates the whole delta locally. This only affects observation
/// quality if the caller subsequently publishes it after a confirmed commit.
#[derive(Default)]
pub struct PendingJobHealth {
    counts: [u64; COUNTER_SLOTS],
    incomplete: bool,
}

impl PendingJobHealth {
    pub fn retry_scheduled(&mut self, reason: RetryReason, rows: u64) {
        self.add(reason.slot(), rows);
    }

    pub fn cancelled(&mut self, rows: u64) {
        self.add(CANCELLATIONS_SLOT, rows);
    }

    pub fn lease_expiry_normalized(&mut self, result: LeaseExpiryResult, rows: u64) {
        self.add(result.slot(), rows);
    }

    /// Consume another pending delta without publishing either transaction.
    /// An overflow or invalid input invalidates the merged delta as a whole.
    pub fn merge(&mut self, other: Self) {
        if self.incomplete || other.incomplete {
            self.incomplete = true;
            return;
        }
        if let Some(counts) = checked_sum(self.counts, other.counts) {
            self.counts = counts;
        } else {
            self.incomplete = true;
        }
    }

    /// Arm observation immediately before awaiting a transaction commit.
    /// The guard holds only pending data, never a collector lock.
    pub fn into_commit_observation(self) -> CommitObservation<'static> {
        JOB_HEALTH.commit_observation(self)
    }

    fn add(&mut self, slot: usize, rows: u64) {
        if self.incomplete {
            return;
        }
        if let Some(count) = self.counts[slot].checked_add(rows) {
            self.counts[slot] = count;
        } else {
            self.incomplete = true;
        }
    }
}

/// Cancellation-safe observation of a transaction commit acknowledgement.
///
/// Dropping an unconfirmed nonempty or invalid delta marks a possible gap. An
/// empty delta is silent. Ordinary rollback should drop [`PendingJobHealth`]
/// before arming this guard, since it has no committed observations to lose.
#[must_use = "confirm after commit acknowledgement, or drop to mark a possible gap"]
pub struct CommitObservation<'a> {
    collector: &'a JobHealthCollector,
    delta: Option<PendingJobHealth>,
}

impl CommitObservation<'_> {
    /// Publish the owned delta after an unambiguous commit acknowledgement.
    pub fn confirmed(mut self) {
        if let Some(delta) = self.delta.take() {
            self.collector.publish_committed(delta);
        }
    }
}

impl Drop for CommitObservation<'_> {
    fn drop(&mut self) {
        if self
            .delta
            .as_ref()
            .is_some_and(|delta| delta.incomplete || delta.counts != [0; COUNTER_SLOTS])
        {
            self.collector.mark_observation_incomplete();
        }
    }
}

/// Cancellation-safe observation of a standalone mutation with unknown row count.
/// This owns no lock and only marks a possible gap if acknowledgement is lost.
#[must_use = "confirm affected rows after acknowledgement, or drop to mark a possible gap"]
pub struct MutationObservation<'a> {
    collector: &'a JobHealthCollector,
    awaiting_acknowledgement: bool,
}

impl MutationObservation<'_> {
    /// Publish affected rows after an unambiguous mutation acknowledgement.
    /// A confirmed zero-row mutation does not create an observation gap.
    pub fn confirmed(mut self, delta: PendingJobHealth) {
        self.awaiting_acknowledgement = false;
        self.collector.publish_committed(delta);
    }
}

impl Drop for MutationObservation<'_> {
    fn drop(&mut self) {
        if self.awaiting_acknowledgement {
            self.collector.mark_observation_incomplete();
        }
    }
}

fn checked_sum(
    current: [u64; COUNTER_SLOTS],
    delta: [u64; COUNTER_SLOTS],
) -> Option<[u64; COUNTER_SLOTS]> {
    let mut next = current;
    for (total, addition) in next.iter_mut().zip(delta) {
        *total = total.checked_add(addition)?;
    }
    Some(next)
}

struct JobHealthCollector {
    counts: Mutex<[u64; COUNTER_SLOTS]>,
    observation_incomplete: AtomicBool,
}

impl JobHealthCollector {
    const fn new() -> Self {
        Self {
            counts: Mutex::new([0; COUNTER_SLOTS]),
            observation_incomplete: AtomicBool::new(false),
        }
    }

    fn publish_committed(&self, delta: PendingJobHealth) {
        if delta.incomplete {
            self.mark_observation_incomplete();
            return;
        }
        // A no-op transaction cannot lose an observation, even under contention.
        if delta.counts == [0; COUNTER_SLOTS] {
            return;
        }
        let Ok(mut counts) = self.counts.try_lock() else {
            self.mark_observation_incomplete();
            return;
        };
        if let Some(next) = checked_sum(*counts, delta.counts) {
            *counts = next;
        } else {
            self.mark_observation_incomplete();
        }
    }

    fn mark_observation_incomplete(&self) {
        self.observation_incomplete.store(true, Ordering::Release);
    }

    fn commit_observation(&self, delta: PendingJobHealth) -> CommitObservation<'_> {
        CommitObservation {
            collector: self,
            delta: Some(delta),
        }
    }

    fn mutation_observation(&self) -> MutationObservation<'_> {
        MutationObservation {
            collector: self,
            awaiting_acknowledgement: true,
        }
    }

    fn snapshot(&self) -> Option<[u64; COUNTER_SLOTS]> {
        match self.counts.try_lock() {
            Ok(counts) => Some(*counts),
            Err(TryLockError::WouldBlock) => None,
            Err(TryLockError::Poisoned(_)) => {
                self.mark_observation_incomplete();
                None
            }
        }
    }

    fn render(&self, process: Process) -> String {
        let counts = self.snapshot();
        // The copied snapshot has released the mutex before any formatting.
        let incomplete = self.observation_incomplete.load(Ordering::Acquire);
        let process = match process {
            Process::Server => "server",
            Process::Worker => "worker",
        };
        let mut output = String::with_capacity(2048);
        output.push_str(
            "# HELP rainsync_media_job_observation_available Whether the fixed process-local job observation snapshot is available; unavailable snapshots omit counters.\n\
             # TYPE rainsync_media_job_observation_available gauge\n",
        );
        let _ = writeln!(
            output,
            "rainsync_media_job_observation_available{{process=\"{process}\"}} {}",
            u8::from(counts.is_some())
        );
        output.push_str(
            "# HELP rainsync_media_job_observation_incomplete Whether observations may be incomplete since process start, including failed or cancelled acknowledgement waits; sticky until restart.\n\
             # TYPE rainsync_media_job_observation_incomplete gauge\n",
        );
        let _ = writeln!(
            output,
            "rainsync_media_job_observation_incomplete{{process=\"{process}\"}} {}",
            u8::from(incomplete)
        );
        let Some(counts) = counts else {
            return output;
        };
        output.push_str(
            "# HELP rainsync_media_job_retry_schedules_total Process-local committed retry schedules; reset on restart, with possible crash and unknown-commit gaps.\n\
             # TYPE rainsync_media_job_retry_schedules_total counter\n",
        );
        for (slot, reason) in RETRY_LABELS.iter().enumerate() {
            let _ = writeln!(
                output,
                "rainsync_media_job_retry_schedules_total{{process=\"{process}\",reason=\"{reason}\"}} {}",
                counts[slot]
            );
        }
        output.push_str(
            "# HELP rainsync_media_job_cancellations_total Process-local committed job cancellations; reset on restart, with possible crash and unknown-commit gaps.\n\
             # TYPE rainsync_media_job_cancellations_total counter\n",
        );
        let _ = writeln!(
            output,
            "rainsync_media_job_cancellations_total{{process=\"{process}\"}} {}",
            counts[CANCELLATIONS_SLOT]
        );
        output.push_str(
            "# HELP rainsync_media_job_lease_expiry_normalizations_total Process-local committed lease-expiry normalizations; reset on restart, with possible crash and unknown-commit gaps.\n\
             # TYPE rainsync_media_job_lease_expiry_normalizations_total counter\n",
        );
        for (index, result) in LEASE_EXPIRY_LABELS.iter().enumerate() {
            let _ = writeln!(
                output,
                "rainsync_media_job_lease_expiry_normalizations_total{{process=\"{process}\",result=\"{result}\"}} {}",
                counts[index + 4]
            );
        }
        output
    }
}

static JOB_HEALTH: JobHealthCollector = JobHealthCollector::new();

/// Consume and record a pending delta after the caller confirms database commit.
/// This never waits, retries, panics on poison/overflow, or returns a business error.
pub fn publish_committed(delta: PendingJobHealth) {
    JOB_HEALTH.publish_committed(delta);
}

/// Mark a known observation gap, such as an ambiguous commit acknowledgement.
/// This flag does not guess or increment any job event.
pub fn mark_observation_incomplete() {
    JOB_HEALTH.mark_observation_incomplete();
}

/// Arm observation immediately before awaiting a standalone mutation whose
/// affected row count is unknown. Confirm with the returned rows on success.
/// Cancellation or loss of acknowledgement marks a possible observation gap.
pub fn begin_mutation_observation() -> MutationObservation<'static> {
    JOB_HEALTH.mutation_observation()
}

/// Render a fixed process-labelled snapshot. Missing acquisition emits availability
/// zero and omits the counters; known empty state emits all six zero counters.
pub fn render(process: Process) -> String {
    JOB_HEALTH.render(process)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, mpsc};
    use std::thread;
    use std::time::Duration;

    fn complete_delta() -> PendingJobHealth {
        let mut delta = PendingJobHealth::default();
        delta.retry_scheduled(RetryReason::UpstreamTransport, 1);
        delta.retry_scheduled(RetryReason::WorkerShutdown, 2);
        delta.retry_scheduled(RetryReason::LeaseExpired, 3);
        delta.cancelled(4);
        delta.lease_expiry_normalized(LeaseExpiryResult::Requeued, 5);
        delta.lease_expiry_normalized(LeaseExpiryResult::Exhausted, 6);
        delta
    }

    fn samples(rendered: &str) -> Vec<&str> {
        rendered
            .lines()
            .filter(|line| !line.starts_with('#'))
            .collect()
    }

    #[test]
    fn storage_and_all_labels_are_fixed() {
        let collector = JobHealthCollector::new();
        assert_eq!(std::mem::size_of::<[u64; COUNTER_SLOTS]>(), 48);
        collector.publish_committed(complete_delta());
        assert_eq!(collector.snapshot(), Some([1, 2, 3, 4, 5, 6]));
        for (process, name) in [(Process::Server, "server"), (Process::Worker, "worker")] {
            let rendered = collector.render(process);
            let expected = [
                format!("rainsync_media_job_observation_available{{process=\"{name}\"}} 1"),
                format!("rainsync_media_job_observation_incomplete{{process=\"{name}\"}} 0"),
                format!(
                    "rainsync_media_job_retry_schedules_total{{process=\"{name}\",reason=\"upstream_transport\"}} 1"
                ),
                format!(
                    "rainsync_media_job_retry_schedules_total{{process=\"{name}\",reason=\"worker_shutdown\"}} 2"
                ),
                format!(
                    "rainsync_media_job_retry_schedules_total{{process=\"{name}\",reason=\"lease_expired\"}} 3"
                ),
                format!("rainsync_media_job_cancellations_total{{process=\"{name}\"}} 4"),
                format!(
                    "rainsync_media_job_lease_expiry_normalizations_total{{process=\"{name}\",result=\"requeued\"}} 5"
                ),
                format!(
                    "rainsync_media_job_lease_expiry_normalizations_total{{process=\"{name}\",result=\"exhausted\"}} 6"
                ),
            ];
            assert_eq!(
                samples(&rendered),
                expected.iter().map(String::as_str).collect::<Vec<_>>()
            );
            assert_eq!(rendered.matches("# TYPE ").count(), 5);
            assert!(
                rendered.contains("reset on restart, with possible crash and unknown-commit gaps")
            );
        }
    }

    #[test]
    fn known_empty_snapshot_emits_zero_counters() {
        let collector = JobHealthCollector::new();
        let rendered = collector.render(Process::Server);
        let samples = samples(&rendered);
        assert_eq!(samples.len(), 8);
        assert!(samples[0].ends_with(" 1"));
        assert!(samples[1..].iter().all(|sample| sample.ends_with(" 0")));
    }

    #[test]
    fn unavailable_snapshot_omits_counters_and_recovers() {
        let collector = JobHealthCollector::new();
        collector.publish_committed(complete_delta());
        let guard = collector.counts.lock().unwrap();
        let rendered = collector.render(Process::Worker);
        assert_eq!(
            samples(&rendered),
            [
                "rainsync_media_job_observation_available{process=\"worker\"} 0",
                "rainsync_media_job_observation_incomplete{process=\"worker\"} 0",
            ]
        );
        assert!(!rendered.contains("_total"));
        drop(guard);
        assert_eq!(collector.snapshot(), Some([1, 2, 3, 4, 5, 6]));
        assert_eq!(samples(&collector.render(Process::Worker)).len(), 8);
    }

    #[test]
    fn dropped_pending_delta_credits_nothing_even_if_invalid() {
        let collector = JobHealthCollector::new();
        {
            let _pending_rollback = complete_delta();
            let mut overflowed_rollback = PendingJobHealth::default();
            overflowed_rollback.cancelled(u64::MAX);
            overflowed_rollback.cancelled(1);
        }
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn confirmed_commit_guard_publishes_once_without_holding_a_lock() {
        let collector = JobHealthCollector::new();
        let observation = collector.commit_observation(complete_delta());
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
        observation.confirmed();
        assert_eq!(collector.snapshot(), Some([1, 2, 3, 4, 5, 6]));
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn unacknowledged_commit_guard_marks_a_gap_without_credit() {
        let collector = JobHealthCollector::new();
        drop(collector.commit_observation(complete_delta()));
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn dropped_empty_commit_guard_does_not_create_a_false_gap() {
        let collector = JobHealthCollector::new();
        let guard = collector.counts.lock().unwrap();
        drop(collector.commit_observation(PendingJobHealth::default()));
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
        drop(guard);
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
    }

    #[test]
    fn dropped_invalid_commit_guard_marks_a_gap_without_credit() {
        let collector = JobHealthCollector::new();
        let mut invalid = PendingJobHealth::default();
        invalid.cancelled(u64::MAX);
        invalid.cancelled(1);
        drop(collector.commit_observation(invalid));
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn standalone_acknowledgement_guard_is_cancellation_safe() {
        let collector = JobHealthCollector::new();
        let observation = collector.mutation_observation();
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
        drop(observation);
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn confirmed_standalone_guard_publishes_without_a_false_drop_gap() {
        let collector = JobHealthCollector::new();
        collector.mutation_observation().confirmed(complete_delta());
        collector
            .mutation_observation()
            .confirmed(PendingJobHealth::default());
        assert_eq!(collector.snapshot(), Some([1, 2, 3, 4, 5, 6]));
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn guards_can_be_held_by_send_futures() {
        fn assert_send<T: Send>() {}
        assert_send::<CommitObservation<'static>>();
        assert_send::<MutationObservation<'static>>();
    }

    #[test]
    fn merge_consumes_and_sums_all_slots_before_publication() {
        let collector = JobHealthCollector::new();
        let mut pending = complete_delta();
        pending.merge(complete_delta());
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
        collector.publish_committed(pending);
        assert_eq!(collector.snapshot(), Some([2, 4, 6, 8, 10, 12]));
    }

    #[test]
    fn pending_overflow_publishes_no_partial_delta() {
        let collector = JobHealthCollector::new();
        let mut delta = complete_delta();
        delta.cancelled(u64::MAX);
        delta.retry_scheduled(RetryReason::UpstreamTransport, 100);
        assert!(delta.incomplete);
        collector.publish_committed(delta);
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn merge_overflow_does_not_partially_change_pending_counts() {
        let collector = JobHealthCollector::new();
        let mut pending = complete_delta();
        let mut other = complete_delta();
        other.counts[5] = u64::MAX;
        pending.merge(other);
        assert_eq!(pending.counts, [1, 2, 3, 4, 5, 6]);
        assert!(pending.incomplete);
        collector.publish_committed(pending);
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn merge_preserves_invalidity_from_either_input() {
        for invalid_left in [false, true] {
            let collector = JobHealthCollector::new();
            let mut left = complete_delta();
            let mut right = complete_delta();
            if invalid_left {
                left.incomplete = true;
            } else {
                right.incomplete = true;
            }
            left.merge(right);
            collector.publish_committed(left);
            assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
            assert!(collector.observation_incomplete.load(Ordering::Acquire));
        }
    }

    #[test]
    fn collector_overflow_drops_the_whole_update_and_stays_usable() {
        let collector = JobHealthCollector::new();
        let initial = [10, 20, 30, 40, 50, u64::MAX];
        *collector.counts.lock().unwrap() = initial;
        collector.publish_committed(complete_delta());
        assert_eq!(collector.snapshot(), Some(initial));
        assert!(collector.observation_incomplete.load(Ordering::Acquire));
        let mut later = PendingJobHealth::default();
        later.cancelled(1);
        collector.publish_committed(later);
        assert_eq!(collector.snapshot(), Some([10, 20, 30, 41, 50, u64::MAX]));
        assert!(
            collector
                .render(Process::Worker)
                .contains("rainsync_media_job_observation_available{process=\"worker\"} 1")
        );
    }

    #[test]
    fn publish_and_snapshot_return_while_another_thread_holds_the_lock() {
        let collector = Arc::new(JobHealthCollector::new());
        let guard = collector.counts.lock().unwrap();
        let (sender, receiver) = mpsc::channel();
        let producer = Arc::clone(&collector);
        let handle = thread::spawn(move || {
            producer.publish_committed(complete_delta());
            let rendered = producer.render(Process::Server);
            sender.send(rendered).unwrap();
        });
        let result = receiver.recv_timeout(Duration::from_secs(2));
        // Always release the lock before joining, including a failing regression.
        drop(guard);
        handle.join().unwrap();
        let rendered = result.expect("collection waited for the held mutex");
        assert_eq!(
            samples(&rendered),
            [
                "rainsync_media_job_observation_available{process=\"server\"} 0",
                "rainsync_media_job_observation_incomplete{process=\"server\"} 1",
            ]
        );
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
    }

    #[test]
    fn zero_delta_under_contention_does_not_create_a_false_gap() {
        let collector = JobHealthCollector::new();
        let guard = collector.counts.lock().unwrap();
        let mut empty = PendingJobHealth::default();
        empty.retry_scheduled(RetryReason::LeaseExpired, 0);
        empty.cancelled(0);
        empty.lease_expiry_normalized(LeaseExpiryResult::Exhausted, 0);
        empty.merge(PendingJobHealth::default());
        collector.publish_committed(empty);
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
        drop(guard);
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
    }

    #[test]
    fn concurrent_producers_cannot_double_credit_or_partially_publish() {
        const PRODUCERS: usize = 8;
        const DELTAS_PER_PRODUCER: usize = 500;
        let collector = Arc::new(JobHealthCollector::new());
        collector.publish_committed(complete_delta());
        let barrier = Arc::new(Barrier::new(PRODUCERS));
        let handles: Vec<_> = (0..PRODUCERS)
            .map(|_| {
                let collector = Arc::clone(&collector);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    for _ in 0..DELTAS_PER_PRODUCER {
                        collector.publish_committed(complete_delta());
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let counts = collector.snapshot().unwrap();
        let accepted = counts[0];
        assert!((1..=(1 + PRODUCERS * DELTAS_PER_PRODUCER) as u64).contains(&accepted));
        assert_eq!(
            counts,
            [
                accepted,
                2 * accepted,
                3 * accepted,
                4 * accepted,
                5 * accepted,
                6 * accepted
            ]
        );
    }

    #[test]
    fn explicit_ambiguity_is_sticky_and_never_guesses_events() {
        let collector = JobHealthCollector::new();
        collector.mark_observation_incomplete();
        assert_eq!(collector.snapshot(), Some([0; COUNTER_SLOTS]));
        collector.publish_committed(complete_delta());
        collector.publish_committed(PendingJobHealth::default());
        assert_eq!(collector.snapshot(), Some([1, 2, 3, 4, 5, 6]));
        assert!(
            collector
                .render(Process::Server)
                .contains("rainsync_media_job_observation_incomplete{process=\"server\"} 1")
        );
    }

    #[test]
    fn poisoned_collector_omits_counters_and_does_not_panic_on_publish() {
        let collector = Arc::new(JobHealthCollector::new());
        let poisoned = Arc::clone(&collector);
        assert!(
            thread::spawn(move || {
                let _guard = poisoned.counts.lock().unwrap();
                panic!("test-only mutex poisoning");
            })
            .join()
            .is_err()
        );
        collector.publish_committed(complete_delta());
        let rendered = collector.render(Process::Server);
        assert_eq!(
            samples(&rendered),
            [
                "rainsync_media_job_observation_available{process=\"server\"} 0",
                "rainsync_media_job_observation_incomplete{process=\"server\"} 1",
            ]
        );
        assert!(!rendered.contains("_total"));
    }

    #[test]
    fn fresh_collector_resets_process_observations_and_quality() {
        let old_process = JobHealthCollector::new();
        old_process.publish_committed(complete_delta());
        old_process.mark_observation_incomplete();
        let restarted_process = JobHealthCollector::new();
        assert_eq!(restarted_process.snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(
            !restarted_process
                .observation_incomplete
                .load(Ordering::Acquire)
        );
        assert_eq!(old_process.snapshot(), Some([1, 2, 3, 4, 5, 6]));
        assert!(old_process.observation_incomplete.load(Ordering::Acquire));
    }
}
