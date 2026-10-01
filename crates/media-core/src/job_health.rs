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

#[path = "job_health_timing.rs"]
mod timing;
use timing::TIMING_SLOTS;
pub use timing::{TIMING_BUCKET_SECONDS, TimingAggregate, TimingKind};

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
/// Overflow invalidates the whole delta locally. Observation quality changes
/// only after confirmed publication or loss of an armed acknowledgement.
pub struct PendingJobHealth {
    counts: [u64; COUNTER_SLOTS],
    timings: [TimingAggregate; TIMING_SLOTS],
    incomplete: bool,
}

impl Default for PendingJobHealth {
    fn default() -> Self {
        Self {
            counts: [0; COUNTER_SLOTS],
            timings: [TimingAggregate::EMPTY; TIMING_SLOTS],
            incomplete: false,
        }
    }
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

    /// Add a validated logical phase summary to this same commit observation.
    /// Overflow invalidates the whole delta without affecting the mutation.
    pub fn timing(&mut self, kind: TimingKind, aggregate: TimingAggregate) {
        if self.incomplete {
            return;
        }
        let slot = kind.slot();
        if let Some(next) = self.timings[slot].checked_add(aggregate) {
            self.timings[slot] = next;
        } else {
            self.mark_incomplete();
        }
    }

    /// Retain a possible observation gap, such as an invalid decoded summary.
    /// This remains local until commit acknowledgement; rollback is silent.
    pub fn mark_incomplete(&mut self) {
        self.incomplete = true;
    }

    /// Consume another pending delta without publishing either transaction.
    /// An overflow or invalid input invalidates the merged delta as a whole.
    pub fn merge(&mut self, other: Self) {
        if self.incomplete || other.incomplete {
            self.incomplete = true;
            return;
        }
        if let (Some(counts), Some(timings)) = (
            checked_sum(self.counts, other.counts),
            timing::checked_sum(self.timings, other.timings),
        ) {
            self.counts = counts;
            self.timings = timings;
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

    fn is_empty(&self) -> bool {
        self.counts == [0; COUNTER_SLOTS]
            && self.timings.iter().all(|aggregate| aggregate.is_empty())
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
            .is_some_and(|delta| delta.incomplete || !delta.is_empty())
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

#[derive(Clone, Copy, Debug, PartialEq)]
struct JobHealthSnapshot {
    counts: [u64; COUNTER_SLOTS],
    timings: [TimingAggregate; TIMING_SLOTS],
}

struct JobHealthCollector {
    collected: Mutex<JobHealthSnapshot>,
    observation_incomplete: AtomicBool,
}

impl JobHealthCollector {
    const fn new() -> Self {
        Self {
            collected: Mutex::new(JobHealthSnapshot {
                counts: [0; COUNTER_SLOTS],
                timings: [TimingAggregate::EMPTY; TIMING_SLOTS],
            }),
            observation_incomplete: AtomicBool::new(false),
        }
    }

    fn publish_committed(&self, delta: PendingJobHealth) {
        if delta.incomplete {
            self.mark_observation_incomplete();
            return;
        }
        // A no-op transaction cannot lose an observation, even under contention.
        if delta.is_empty() {
            return;
        }
        let Ok(mut collected) = self.collected.try_lock() else {
            self.mark_observation_incomplete();
            return;
        };
        if let (Some(counts), Some(timings)) = (
            checked_sum(collected.counts, delta.counts),
            timing::checked_sum(collected.timings, delta.timings),
        ) {
            *collected = JobHealthSnapshot { counts, timings };
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

    fn snapshot(&self) -> Option<JobHealthSnapshot> {
        match self.collected.try_lock() {
            Ok(collected) => Some(*collected),
            Err(TryLockError::WouldBlock) => None,
            Err(TryLockError::Poisoned(_)) => {
                self.mark_observation_incomplete();
                None
            }
        }
    }

    #[cfg(test)]
    fn event_snapshot(&self) -> Option<[u64; COUNTER_SLOTS]> {
        self.snapshot().map(|snapshot| snapshot.counts)
    }

    fn render(&self, process: Process) -> String {
        let snapshot = self.snapshot();
        // The copied snapshot has released the mutex before any formatting.
        let incomplete = self.observation_incomplete.load(Ordering::Acquire);
        let process = match process {
            Process::Server => "server",
            Process::Worker => "worker",
        };
        let mut output = String::with_capacity(16384);
        output.push_str(
            "# HELP rainsync_media_job_observation_available Whether the fixed process-local job observation snapshot is available; unavailable snapshots omit counters.\n\
             # TYPE rainsync_media_job_observation_available gauge\n",
        );
        let _ = writeln!(
            output,
            "rainsync_media_job_observation_available{{process=\"{process}\"}} {}",
            u8::from(snapshot.is_some())
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
        let Some(snapshot) = snapshot else {
            return output;
        };
        let counts = snapshot.counts;
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
        timing::render(&mut output, process, &snapshot.timings);
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
/// zero and omits counters and histograms; known empty state emits their zeros.
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

    fn event_samples(rendered: &str) -> Vec<&str> {
        rendered
            .lines()
            .filter(|line| {
                !line.starts_with('#')
                    && !line.starts_with("rainsync_media_job_queue_duration_seconds")
                    && !line.starts_with("rainsync_media_job_run_duration_seconds")
                    && !line.starts_with("rainsync_media_job_timing_unknown_total")
            })
            .collect()
    }

    fn timing_delta(kind: TimingKind, total: u64, known: u64, sum: f64) -> PendingJobHealth {
        let mut delta = PendingJobHealth::default();
        delta.timing(
            kind,
            TimingAggregate::new(total, known, sum, [known; 12]).unwrap(),
        );
        delta
    }

    #[test]
    fn timing_render_has_exact_closed_labels_and_cumulative_buckets() {
        let collector = JobHealthCollector::new();
        let mut pending = complete_delta();
        let aggregate =
            TimingAggregate::new(5, 3, 650.0, [0, 0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 3]).unwrap();
        let outcomes = [
            (TimingKind::QueueStarted, "queue", "started"),
            (TimingKind::QueueFailed, "queue", "failed"),
            (TimingKind::QueueCancelled, "queue", "cancelled"),
            (TimingKind::RunSucceeded, "run", "succeeded"),
            (TimingKind::RunFailed, "run", "failed"),
            (TimingKind::RunCancelled, "run", "cancelled"),
            (TimingKind::RunRetry, "run", "retry"),
        ];
        for (kind, _, _) in outcomes {
            pending.timing(kind, aggregate);
        }
        collector.commit_observation(pending).confirmed();
        assert_eq!(std::mem::size_of::<JobHealthSnapshot>(), 888);
        for (process, process_label) in [(Process::Server, "server"), (Process::Worker, "worker")] {
            let rendered = collector.render(process);
            let actual: Vec<_> = rendered
                .lines()
                .filter(|line| !line.starts_with('#'))
                .collect();
            let mut expected: Vec<String> = event_samples(&rendered)
                .iter()
                .map(|line| line.to_string())
                .collect();
            for (_, phase, outcome) in outcomes {
                let family = format!("rainsync_media_job_{phase}_duration_seconds");
                for (bound, count) in [
                    ("0.01", 0),
                    ("0.05", 0),
                    ("0.1", 0),
                    ("0.5", 0),
                    ("1", 1),
                    ("5", 1),
                    ("30", 2),
                    ("120", 2),
                    ("600", 2),
                    ("3600", 3),
                    ("21600", 3),
                    ("86400", 3),
                    ("+Inf", 3),
                ] {
                    expected.push(format!("{family}_bucket{{process=\"{process_label}\",outcome=\"{outcome}\",le=\"{bound}\"}} {count}"));
                }
                expected.push(format!(
                    "{family}_sum{{process=\"{process_label}\",outcome=\"{outcome}\"}} 650"
                ));
                expected.push(format!(
                    "{family}_count{{process=\"{process_label}\",outcome=\"{outcome}\"}} 3"
                ));
            }
            for (_, phase, outcome) in outcomes {
                expected.push(format!("rainsync_media_job_timing_unknown_total{{process=\"{process_label}\",phase=\"{phase}\",outcome=\"{outcome}\"}} 2"));
            }
            assert_eq!(
                actual,
                expected.iter().map(String::as_str).collect::<Vec<_>>()
            );
            assert_eq!(actual.len(), 120);
            assert_eq!(rendered.matches("# TYPE ").count(), 8);
            assert!(
                rendered.contains("# TYPE rainsync_media_job_queue_duration_seconds histogram")
            );
            assert!(rendered.contains("# TYPE rainsync_media_job_run_duration_seconds histogram"));
            assert!(!collector.observation_incomplete.load(Ordering::Acquire));
        }
    }

    #[test]
    fn unknown_only_duration_is_missing_and_never_a_zero_sample_or_gap() {
        let collector = JobHealthCollector::new();
        collector.publish_committed(timing_delta(TimingKind::QueueStarted, 7, 0, 0.0));
        let rendered = collector.render(Process::Server);
        assert!(rendered.contains("rainsync_media_job_timing_unknown_total{process=\"server\",phase=\"queue\",outcome=\"started\"} 7"));
        for line in rendered.lines().filter(|line| {
            line.starts_with("rainsync_media_job_queue_duration_seconds")
                && line.contains("outcome=\"started\"")
        }) {
            assert!(line.ends_with(" 0"), "unknown timing was included: {line}");
        }
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn durations_above_final_finite_bound_still_have_an_infinite_bucket() {
        let collector = JobHealthCollector::new();
        let mut pending = PendingJobHealth::default();
        pending.timing(
            TimingKind::RunSucceeded,
            TimingAggregate::new(1, 1, TIMING_BUCKET_SECONDS[11] + 1.0, [0; 12]).unwrap(),
        );
        collector.publish_committed(pending);
        let rendered = collector.render(Process::Worker);
        assert!(rendered.contains("rainsync_media_job_run_duration_seconds_bucket{process=\"worker\",outcome=\"succeeded\",le=\"86400\"} 0"));
        assert!(rendered.contains("rainsync_media_job_run_duration_seconds_bucket{process=\"worker\",outcome=\"succeeded\",le=\"+Inf\"} 1"));
        assert!(rendered.contains("rainsync_media_job_run_duration_seconds_count{process=\"worker\",outcome=\"succeeded\"} 1"));
        assert!(rendered.contains("rainsync_media_job_run_duration_seconds_sum{process=\"worker\",outcome=\"succeeded\"} 86401"));
    }

    #[test]
    fn standalone_timing_acknowledgement_and_plain_rollback_use_same_ownership() {
        let collector = JobHealthCollector::new();
        {
            let _rollback = timing_delta(TimingKind::QueueCancelled, 2, 1, 1.0);
        }
        assert_eq!(
            collector.snapshot().unwrap().timings,
            [TimingAggregate::EMPTY; TIMING_SLOTS]
        );
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
        collector.mutation_observation().confirmed(timing_delta(
            TimingKind::QueueCancelled,
            2,
            1,
            1.0,
        ));
        assert_eq!(
            collector.snapshot().unwrap().timings[TimingKind::QueueCancelled.slot()],
            TimingAggregate::new(2, 1, 1.0, [1; 12]).unwrap()
        );
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn timing_only_guards_publish_once_or_record_acknowledgement_gap() {
        for known in [0, 1] {
            let collector = JobHealthCollector::new();
            let delta = timing_delta(TimingKind::RunSucceeded, 1, known, known as f64);
            collector.commit_observation(delta).confirmed();
            let published = collector.snapshot().unwrap();
            assert_eq!(
                published.timings[TimingKind::RunSucceeded.slot()],
                TimingAggregate::new(1, known, known as f64, [known; 12]).unwrap()
            );
            assert!(!collector.observation_incomplete.load(Ordering::Acquire));
            drop(collector.commit_observation(timing_delta(
                TimingKind::RunSucceeded,
                1,
                known,
                known as f64,
            )));
            assert_eq!(collector.snapshot(), Some(published));
            assert!(collector.observation_incomplete.load(Ordering::Acquire));
        }
    }

    #[test]
    fn invalid_timing_summary_stays_local_until_acknowledgement() {
        let collector = JobHealthCollector::new();
        {
            let mut rollback = timing_delta(TimingKind::RunFailed, 1, 1, 1.0);
            rollback.mark_incomplete();
        }
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
        assert_eq!(
            collector.snapshot().unwrap().timings,
            [TimingAggregate::EMPTY; TIMING_SLOTS]
        );
        let mut acknowledged = complete_delta();
        acknowledged.mark_incomplete();
        collector.commit_observation(acknowledged).confirmed();
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(collector.observation_incomplete.load(Ordering::Acquire));

        let lost_acknowledgement = JobHealthCollector::new();
        let mut invalid_empty = PendingJobHealth::default();
        invalid_empty.mark_incomplete();
        drop(lost_acknowledgement.commit_observation(invalid_empty));
        assert!(
            lost_acknowledgement
                .observation_incomplete
                .load(Ordering::Acquire)
        );
    }

    #[test]
    fn pending_timing_overflow_and_invalidity_drop_event_counts_too() {
        for floating_overflow in [false, true] {
            let collector = JobHealthCollector::new();
            let mut pending = complete_delta();
            if floating_overflow {
                pending.timing(
                    TimingKind::RunFailed,
                    TimingAggregate::new(1, 1, f64::MAX, [0; 12]).unwrap(),
                );
                pending.timing(
                    TimingKind::RunFailed,
                    TimingAggregate::new(1, 1, f64::MAX, [0; 12]).unwrap(),
                );
            } else {
                pending.timing(
                    TimingKind::QueueFailed,
                    TimingAggregate::new(u64::MAX, 0, 0.0, [0; 12]).unwrap(),
                );
                pending.timing(
                    TimingKind::QueueFailed,
                    TimingAggregate::new(1, 0, 0.0, [0; 12]).unwrap(),
                );
            }
            assert!(pending.incomplete);
            pending.timing(
                TimingKind::RunSucceeded,
                TimingAggregate::new(1, 1, 1.0, [1; 12]).unwrap(),
            );
            collector.publish_committed(pending);
            let snapshot = collector.snapshot().unwrap();
            assert_eq!(snapshot.counts, [0; COUNTER_SLOTS]);
            assert_eq!(snapshot.timings, [TimingAggregate::EMPTY; TIMING_SLOTS]);
            assert!(collector.observation_incomplete.load(Ordering::Acquire));
        }
    }

    #[test]
    fn mixed_merge_is_atomic_on_timing_or_event_overflow() {
        for timing_overflow in [false, true] {
            let collector = JobHealthCollector::new();
            let mut left = complete_delta();
            left.timing(
                TimingKind::RunCancelled,
                TimingAggregate::new(1, 1, 1.0, [1; 12]).unwrap(),
            );
            let mut right = complete_delta();
            if timing_overflow {
                right.timing(
                    TimingKind::RunCancelled,
                    TimingAggregate::new(u64::MAX, u64::MAX, 1.0, [u64::MAX; 12]).unwrap(),
                );
            } else {
                right.cancelled(u64::MAX - 4);
                right.timing(
                    TimingKind::RunCancelled,
                    TimingAggregate::new(2, 1, 1.0, [1; 12]).unwrap(),
                );
            }
            let before_counts = left.counts;
            let before_timings = left.timings;
            left.merge(right);
            assert!(left.incomplete);
            assert_eq!(left.counts, before_counts);
            assert_eq!(left.timings, before_timings);
            collector.publish_committed(left);
            assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
            assert_eq!(
                collector.snapshot().unwrap().timings,
                [TimingAggregate::EMPTY; TIMING_SLOTS]
            );
            assert!(collector.observation_incomplete.load(Ordering::Acquire));
        }
    }

    #[test]
    fn mixed_merge_sums_all_kinds_with_intentional_unknowns() {
        let collector = JobHealthCollector::new();
        let mut left = complete_delta();
        let mut right = complete_delta();
        for kind in [
            TimingKind::QueueStarted,
            TimingKind::QueueFailed,
            TimingKind::QueueCancelled,
            TimingKind::RunSucceeded,
            TimingKind::RunFailed,
            TimingKind::RunCancelled,
            TimingKind::RunRetry,
        ] {
            left.timing(kind, TimingAggregate::new(3, 1, 2.0, [1; 12]).unwrap());
            right.timing(kind, TimingAggregate::new(7, 4, 11.0, [4; 12]).unwrap());
        }
        left.merge(right);
        collector.publish_committed(left);
        let snapshot = collector.snapshot().unwrap();
        assert_eq!(snapshot.counts, [2, 4, 6, 8, 10, 12]);
        assert_eq!(
            snapshot.timings,
            [TimingAggregate::new(10, 5, 13.0, [5; 12]).unwrap(); TIMING_SLOTS]
        );
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn collector_timing_overflow_publishes_no_partial_counts_or_other_kinds() {
        let collector = JobHealthCollector::new();
        collector.publish_committed(timing_delta(TimingKind::RunRetry, u64::MAX, 0, 0.0));
        let before = collector.snapshot().unwrap();
        let mut mixed = complete_delta();
        mixed.timing(
            TimingKind::QueueStarted,
            TimingAggregate::new(1, 1, 1.0, [1; 12]).unwrap(),
        );
        mixed.timing(
            TimingKind::RunRetry,
            TimingAggregate::new(1, 0, 0.0, [0; 12]).unwrap(),
        );
        collector.publish_committed(mixed);
        assert_eq!(collector.snapshot(), Some(before));
        assert!(collector.observation_incomplete.load(Ordering::Acquire));
        collector.publish_committed(timing_delta(TimingKind::QueueCancelled, 1, 1, 1.0));
        assert_eq!(
            collector.snapshot().unwrap().timings[TimingKind::QueueCancelled.slot()],
            TimingAggregate::new(1, 1, 1.0, [1; 12]).unwrap()
        );
    }

    #[test]
    fn timing_only_contention_omits_histograms_and_preserves_quality_rules() {
        let collector = Arc::new(JobHealthCollector::new());
        let guard = collector.collected.lock().unwrap();
        let (sender, receiver) = mpsc::channel();
        let producer = Arc::clone(&collector);
        let handle = thread::spawn(move || {
            producer.publish_committed(timing_delta(TimingKind::RunSucceeded, 1, 1, 1.0));
            sender.send(producer.render(Process::Worker)).unwrap();
        });
        let result = receiver.recv_timeout(Duration::from_secs(2));
        drop(guard);
        handle.join().unwrap();
        let rendered = result.expect("timing collection waited for the held mutex");
        assert_eq!(
            rendered
                .lines()
                .filter(|line| !line.starts_with('#'))
                .collect::<Vec<_>>(),
            [
                "rainsync_media_job_observation_available{process=\"worker\"} 0",
                "rainsync_media_job_observation_incomplete{process=\"worker\"} 1",
            ]
        );
        assert!(!rendered.contains("_duration_seconds"));
        assert!(!rendered.contains("_unknown_total"));
        assert_eq!(
            collector.snapshot().unwrap().timings,
            [TimingAggregate::EMPTY; TIMING_SLOTS]
        );
    }

    #[test]
    fn empty_timing_under_contention_and_guard_drop_is_silent() {
        let collector = JobHealthCollector::new();
        let guard = collector.collected.lock().unwrap();
        collector.publish_committed(timing_delta(TimingKind::RunFailed, 0, 0, 0.0));
        drop(collector.commit_observation(timing_delta(TimingKind::QueueStarted, 0, 0, 0.0)));
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
        drop(guard);
        assert_eq!(
            collector.snapshot().unwrap().timings,
            [TimingAggregate::EMPTY; TIMING_SLOTS]
        );
    }

    #[test]
    fn concurrent_mixed_producers_cannot_partially_publish_or_double_credit() {
        const PRODUCERS: usize = 8;
        const DELTAS_PER_PRODUCER: usize = 500;
        let collector = Arc::new(JobHealthCollector::new());
        let barrier = Arc::new(Barrier::new(PRODUCERS));
        let handles: Vec<_> = (0..PRODUCERS)
            .map(|_| {
                let collector = Arc::clone(&collector);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    for _ in 0..DELTAS_PER_PRODUCER {
                        let mut delta = complete_delta();
                        delta.timing(
                            TimingKind::RunRetry,
                            TimingAggregate::new(3, 2, 8.0, [2; 12]).unwrap(),
                        );
                        collector.publish_committed(delta);
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let snapshot = collector.snapshot().unwrap();
        let accepted = snapshot.counts[0];
        assert!((1..=(PRODUCERS * DELTAS_PER_PRODUCER) as u64).contains(&accepted));
        assert_eq!(
            snapshot.counts,
            [
                accepted,
                2 * accepted,
                3 * accepted,
                4 * accepted,
                5 * accepted,
                6 * accepted
            ]
        );
        assert_eq!(
            snapshot.timings[TimingKind::RunRetry.slot()],
            TimingAggregate::new(
                3 * accepted,
                2 * accepted,
                8.0 * accepted as f64,
                [2 * accepted; 12]
            )
            .unwrap()
        );
    }

    #[test]
    fn storage_and_all_labels_are_fixed() {
        let collector = JobHealthCollector::new();
        assert_eq!(std::mem::size_of::<[u64; COUNTER_SLOTS]>(), 48);
        collector.publish_committed(complete_delta());
        assert_eq!(collector.event_snapshot(), Some([1, 2, 3, 4, 5, 6]));
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
                event_samples(&rendered),
                expected.iter().map(String::as_str).collect::<Vec<_>>()
            );
            assert_eq!(rendered.matches("# TYPE ").count(), 8);
            assert!(
                rendered.contains("reset on restart, with possible crash and unknown-commit gaps")
            );
        }
    }

    #[test]
    fn known_empty_snapshot_emits_zero_counters() {
        let collector = JobHealthCollector::new();
        let rendered = collector.render(Process::Server);
        let all_samples: Vec<_> = rendered
            .lines()
            .filter(|line| !line.starts_with('#'))
            .collect();
        assert_eq!(all_samples.len(), 120);
        assert!(all_samples[0].ends_with(" 1"));
        assert!(all_samples[1..].iter().all(|sample| sample.ends_with(" 0")));
        let samples = event_samples(&rendered);
        assert_eq!(samples.len(), 8);
        assert!(samples[0].ends_with(" 1"));
        assert!(samples[1..].iter().all(|sample| sample.ends_with(" 0")));
    }

    #[test]
    fn unavailable_snapshot_omits_counters_and_recovers() {
        let collector = JobHealthCollector::new();
        collector.publish_committed(complete_delta());
        let guard = collector.collected.lock().unwrap();
        let rendered = collector.render(Process::Worker);
        assert_eq!(
            event_samples(&rendered),
            [
                "rainsync_media_job_observation_available{process=\"worker\"} 0",
                "rainsync_media_job_observation_incomplete{process=\"worker\"} 0",
            ]
        );
        assert!(!rendered.contains("_total"));
        assert!(!rendered.contains("_duration_seconds"));
        drop(guard);
        assert_eq!(collector.event_snapshot(), Some([1, 2, 3, 4, 5, 6]));
        assert_eq!(event_samples(&collector.render(Process::Worker)).len(), 8);
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
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn confirmed_commit_guard_publishes_once_without_holding_a_lock() {
        let collector = JobHealthCollector::new();
        let observation = collector.commit_observation(complete_delta());
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
        observation.confirmed();
        assert_eq!(collector.event_snapshot(), Some([1, 2, 3, 4, 5, 6]));
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn unacknowledged_commit_guard_marks_a_gap_without_credit() {
        let collector = JobHealthCollector::new();
        drop(collector.commit_observation(complete_delta()));
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn dropped_empty_commit_guard_does_not_create_a_false_gap() {
        let collector = JobHealthCollector::new();
        let guard = collector.collected.lock().unwrap();
        drop(collector.commit_observation(PendingJobHealth::default()));
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
        drop(guard);
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
    }

    #[test]
    fn dropped_invalid_commit_guard_marks_a_gap_without_credit() {
        let collector = JobHealthCollector::new();
        let mut invalid = PendingJobHealth::default();
        invalid.cancelled(u64::MAX);
        invalid.cancelled(1);
        drop(collector.commit_observation(invalid));
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn standalone_acknowledgement_guard_is_cancellation_safe() {
        let collector = JobHealthCollector::new();
        let observation = collector.mutation_observation();
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
        drop(observation);
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
        assert!(collector.observation_incomplete.load(Ordering::Acquire));
    }

    #[test]
    fn confirmed_standalone_guard_publishes_without_a_false_drop_gap() {
        let collector = JobHealthCollector::new();
        collector.mutation_observation().confirmed(complete_delta());
        collector
            .mutation_observation()
            .confirmed(PendingJobHealth::default());
        assert_eq!(collector.event_snapshot(), Some([1, 2, 3, 4, 5, 6]));
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
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
        collector.publish_committed(pending);
        assert_eq!(collector.event_snapshot(), Some([2, 4, 6, 8, 10, 12]));
    }

    #[test]
    fn pending_overflow_publishes_no_partial_delta() {
        let collector = JobHealthCollector::new();
        let mut delta = complete_delta();
        delta.cancelled(u64::MAX);
        delta.retry_scheduled(RetryReason::UpstreamTransport, 100);
        assert!(delta.incomplete);
        collector.publish_committed(delta);
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
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
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
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
            assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
            assert!(collector.observation_incomplete.load(Ordering::Acquire));
        }
    }

    #[test]
    fn collector_overflow_drops_the_whole_update_and_stays_usable() {
        let collector = JobHealthCollector::new();
        let initial = [10, 20, 30, 40, 50, u64::MAX];
        collector.collected.lock().unwrap().counts = initial;
        collector.publish_committed(complete_delta());
        assert_eq!(collector.event_snapshot(), Some(initial));
        assert!(collector.observation_incomplete.load(Ordering::Acquire));
        let mut later = PendingJobHealth::default();
        later.cancelled(1);
        collector.publish_committed(later);
        assert_eq!(
            collector.event_snapshot(),
            Some([10, 20, 30, 41, 50, u64::MAX])
        );
        assert!(
            collector
                .render(Process::Worker)
                .contains("rainsync_media_job_observation_available{process=\"worker\"} 1")
        );
    }

    #[test]
    fn publish_and_snapshot_return_while_another_thread_holds_the_lock() {
        let collector = Arc::new(JobHealthCollector::new());
        let guard = collector.collected.lock().unwrap();
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
            event_samples(&rendered),
            [
                "rainsync_media_job_observation_available{process=\"server\"} 0",
                "rainsync_media_job_observation_incomplete{process=\"server\"} 1",
            ]
        );
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
    }

    #[test]
    fn zero_delta_under_contention_does_not_create_a_false_gap() {
        let collector = JobHealthCollector::new();
        let guard = collector.collected.lock().unwrap();
        let mut empty = PendingJobHealth::default();
        empty.retry_scheduled(RetryReason::LeaseExpired, 0);
        empty.cancelled(0);
        empty.lease_expiry_normalized(LeaseExpiryResult::Exhausted, 0);
        empty.merge(PendingJobHealth::default());
        collector.publish_committed(empty);
        assert!(!collector.observation_incomplete.load(Ordering::Acquire));
        drop(guard);
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
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
        let counts = collector.event_snapshot().unwrap();
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
        assert_eq!(collector.event_snapshot(), Some([0; COUNTER_SLOTS]));
        collector.publish_committed(complete_delta());
        collector.publish_committed(PendingJobHealth::default());
        assert_eq!(collector.event_snapshot(), Some([1, 2, 3, 4, 5, 6]));
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
                let _guard = poisoned.collected.lock().unwrap();
                panic!("test-only mutex poisoning");
            })
            .join()
            .is_err()
        );
        collector.publish_committed(complete_delta());
        let rendered = collector.render(Process::Server);
        assert_eq!(
            event_samples(&rendered),
            [
                "rainsync_media_job_observation_available{process=\"server\"} 0",
                "rainsync_media_job_observation_incomplete{process=\"server\"} 1",
            ]
        );
        assert!(!rendered.contains("_total"));
        assert!(!rendered.contains("_duration_seconds"));
    }

    #[test]
    fn fresh_collector_resets_process_observations_and_quality() {
        let old_process = JobHealthCollector::new();
        old_process.publish_committed(complete_delta());
        old_process.publish_committed(timing_delta(TimingKind::RunSucceeded, 5, 2, 4.0));
        old_process.mark_observation_incomplete();
        let restarted_process = JobHealthCollector::new();
        assert_eq!(restarted_process.event_snapshot(), Some([0; COUNTER_SLOTS]));
        assert_eq!(
            restarted_process.snapshot().unwrap().timings,
            [TimingAggregate::EMPTY; TIMING_SLOTS]
        );
        assert!(
            !restarted_process
                .observation_incomplete
                .load(Ordering::Acquire)
        );
        assert_eq!(old_process.event_snapshot(), Some([1, 2, 3, 4, 5, 6]));
        assert!(old_process.observation_incomplete.load(Ordering::Acquire));
    }
}
