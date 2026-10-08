//! Fixed logical queue and run duration summaries for committed job transitions.

use std::fmt::Write;

/// Cumulative finite histogram bounds. The known count supplies the +Inf bucket.
pub const TIMING_BUCKET_SECONDS: [f64; 12] = [
    0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 30.0, 120.0, 600.0, 3600.0, 21600.0, 86400.0,
];

pub(super) const TIMING_SLOTS: usize = 7;
const KINDS: [TimingKind; TIMING_SLOTS] = [
    TimingKind::QueueStarted,
    TimingKind::QueueFailed,
    TimingKind::QueueCancelled,
    TimingKind::RunSucceeded,
    TimingKind::RunFailed,
    TimingKind::RunCancelled,
    TimingKind::RunRetry,
];

/// The closed phase/outcome set for logical per-attempt job timings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimingKind {
    QueueStarted,
    QueueFailed,
    QueueCancelled,
    RunSucceeded,
    RunFailed,
    RunCancelled,
    RunRetry,
}

impl TimingKind {
    pub(super) const fn slot(self) -> usize {
        match self {
            Self::QueueStarted => 0,
            Self::QueueFailed => 1,
            Self::QueueCancelled => 2,
            Self::RunSucceeded => 3,
            Self::RunFailed => 4,
            Self::RunCancelled => 5,
            Self::RunRetry => 6,
        }
    }

    const fn labels(self) -> (&'static str, &'static str) {
        match self {
            Self::QueueStarted => ("queue", "started"),
            Self::QueueFailed => ("queue", "failed"),
            Self::QueueCancelled => ("queue", "cancelled"),
            Self::RunSucceeded => ("run", "succeeded"),
            Self::RunFailed => ("run", "failed"),
            Self::RunCancelled => ("run", "cancelled"),
            Self::RunRetry => ("run", "retry"),
        }
    }
}

/// A validated, fixed-size summary, including observations with unknown duration.
///
/// `total - known` counts missing samples. Such observations never contribute a
/// zero duration to a histogram. Fields are private to preserve the invariants.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimingAggregate {
    total: u64,
    known: u64,
    sum_seconds: f64,
    buckets: [u64; 12],
}

impl TimingAggregate {
    pub(super) const EMPTY: Self = Self {
        total: 0,
        known: 0,
        sum_seconds: 0.0,
        buckets: [0; 12],
    };

    /// Validate a cumulative histogram summary without changing observations.
    /// Invalid input is rejected; callers must retain any resulting observation
    /// gap in the transaction's acknowledged-commit observation.
    pub fn new(total: u64, known: u64, sum_seconds: f64, buckets: [u64; 12]) -> Option<Self> {
        if known > total || !sum_seconds.is_finite() || sum_seconds < 0.0 {
            return None;
        }
        let mut previous = 0;
        for bucket in buckets {
            if bucket < previous || bucket > known {
                return None;
            }
            previous = bucket;
        }
        if known == 0 && (sum_seconds != 0.0 || buckets != [0; 12]) {
            return None;
        }
        Some(Self {
            total,
            known,
            sum_seconds,
            buckets,
        })
    }

    pub(super) const fn is_empty(self) -> bool {
        self.total == 0
    }

    pub(super) fn checked_add(self, other: Self) -> Option<Self> {
        let total = self.total.checked_add(other.total)?;
        let known = self.known.checked_add(other.known)?;
        let mut buckets = self.buckets;
        for (bucket, addition) in buckets.iter_mut().zip(other.buckets) {
            *bucket = bucket.checked_add(addition)?;
        }
        Self::new(total, known, self.sum_seconds + other.sum_seconds, buckets)
    }
}

pub(super) fn checked_sum(
    current: [TimingAggregate; TIMING_SLOTS],
    delta: [TimingAggregate; TIMING_SLOTS],
) -> Option<[TimingAggregate; TIMING_SLOTS]> {
    let mut next = current;
    for (aggregate, addition) in next.iter_mut().zip(delta) {
        *aggregate = aggregate.checked_add(addition)?;
    }
    Some(next)
}

pub(super) fn render(
    output: &mut String,
    process: &str,
    timings: &[TimingAggregate; TIMING_SLOTS],
) {
    output.push_str(
        "# HELP rainsync_media_job_queue_duration_seconds Process-local committed logical queue durations; unknown durations are omitted, with reset on restart and possible observation gaps.\n\
         # TYPE rainsync_media_job_queue_duration_seconds histogram\n",
    );
    for kind in &KINDS[..3] {
        render_histogram(output, process, *kind, timings[kind.slot()]);
    }
    output.push_str(
        "# HELP rainsync_media_job_run_duration_seconds Process-local committed logical run durations; unknown durations are omitted, with reset on restart and possible observation gaps.\n\
         # TYPE rainsync_media_job_run_duration_seconds histogram\n",
    );
    for kind in &KINDS[3..] {
        render_histogram(output, process, *kind, timings[kind.slot()]);
    }
    output.push_str(
        "# HELP rainsync_media_job_timing_unknown_total Process-local committed job timing observations with unknown duration; intentional missing samples, reset on restart.\n\
         # TYPE rainsync_media_job_timing_unknown_total counter\n",
    );
    for kind in KINDS {
        let (phase, outcome) = kind.labels();
        let aggregate = timings[kind.slot()];
        let _ = writeln!(
            output,
            "rainsync_media_job_timing_unknown_total{{process=\"{process}\",phase=\"{phase}\",outcome=\"{outcome}\"}} {}",
            aggregate.total - aggregate.known
        );
    }
}

fn render_histogram(
    output: &mut String,
    process: &str,
    kind: TimingKind,
    aggregate: TimingAggregate,
) {
    let (_, outcome) = kind.labels();
    let family = match kind {
        TimingKind::QueueStarted | TimingKind::QueueFailed | TimingKind::QueueCancelled => {
            "rainsync_media_job_queue_duration_seconds"
        }
        TimingKind::RunSucceeded
        | TimingKind::RunFailed
        | TimingKind::RunCancelled
        | TimingKind::RunRetry => "rainsync_media_job_run_duration_seconds",
    };
    for (bound, bucket) in TIMING_BUCKET_SECONDS.iter().zip(aggregate.buckets) {
        let _ = writeln!(
            output,
            "{family}_bucket{{process=\"{process}\",outcome=\"{outcome}\",le=\"{bound}\"}} {bucket}"
        );
    }
    let _ = writeln!(
        output,
        "{family}_bucket{{process=\"{process}\",outcome=\"{outcome}\",le=\"+Inf\"}} {}",
        aggregate.known
    );
    let _ = writeln!(
        output,
        "{family}_sum{{process=\"{process}\",outcome=\"{outcome}\"}} {}",
        aggregate.sum_seconds
    );
    let _ = writeln!(
        output,
        "{family}_count{{process=\"{process}\",outcome=\"{outcome}\"}} {}",
        aggregate.known
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_all_aggregate_invariants() {
        assert!(TimingAggregate::new(1, 2, 1.0, [0; 12]).is_none());
        for invalid_sum in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.1] {
            assert!(TimingAggregate::new(2, 1, invalid_sum, [0; 12]).is_none());
        }
        assert!(TimingAggregate::new(2, 0, 0.1, [0; 12]).is_none());
        assert!(TimingAggregate::new(2, 0, 0.0, [1; 12]).is_none());
        assert!(TimingAggregate::new(2, 1, 1.0, [2; 12]).is_none());
        for index in 1..12 {
            let mut decreasing = [1; 12];
            decreasing[index] = 0;
            assert!(TimingAggregate::new(2, 2, 1.0, decreasing).is_none());
        }
        assert_eq!(
            TimingAggregate::new(0, 0, 0.0, [0; 12]),
            Some(TimingAggregate::EMPTY)
        );
        assert!(TimingAggregate::new(u64::MAX, 0, 0.0, [0; 12]).is_some());
        assert!(TimingAggregate::new(2, 1, 0.0, [1; 12]).is_some());
        assert!(TimingAggregate::new(2, 1, 86401.0, [0; 12]).is_some());
    }

    #[test]
    fn checked_add_preserves_known_and_unknown_samples() {
        let left = TimingAggregate::new(3, 1, 1.0, [1; 12]).unwrap();
        let right = TimingAggregate::new(5, 2, 2.0, [2; 12]).unwrap();
        assert_eq!(
            left.checked_add(right),
            TimingAggregate::new(8, 3, 3.0, [3; 12])
        );
        assert_eq!(left.checked_add(TimingAggregate::EMPTY), Some(left));
    }

    #[test]
    fn checked_add_rejects_integer_and_floating_overflow() {
        let unknown = TimingAggregate::new(u64::MAX, 0, 0.0, [0; 12]).unwrap();
        assert!(
            unknown
                .checked_add(TimingAggregate::new(1, 0, 0.0, [0; 12]).unwrap())
                .is_none()
        );
        let maximal = TimingAggregate::new(u64::MAX, u64::MAX, 1.0, [u64::MAX; 12]).unwrap();
        assert!(
            maximal
                .checked_add(TimingAggregate::new(1, 1, 1.0, [1; 12]).unwrap())
                .is_none()
        );
        let large_sum = TimingAggregate::new(1, 1, f64::MAX, [0; 12]).unwrap();
        assert!(large_sum.checked_add(large_sum).is_none());
    }

    #[test]
    fn storage_bounds_and_label_set_are_fixed() {
        assert_eq!(std::mem::size_of::<TimingAggregate>(), 120);
        assert_eq!(std::mem::size_of::<[TimingAggregate; TIMING_SLOTS]>(), 840);
        assert_eq!(
            TIMING_BUCKET_SECONDS,
            [
                0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 30.0, 120.0, 600.0, 3600.0, 21600.0, 86400.0
            ]
        );
        assert_eq!(
            KINDS.map(TimingKind::labels),
            [
                ("queue", "started"),
                ("queue", "failed"),
                ("queue", "cancelled"),
                ("run", "succeeded"),
                ("run", "failed"),
                ("run", "cancelled"),
                ("run", "retry")
            ]
        );
        assert_eq!(KINDS.map(TimingKind::slot), [0, 1, 2, 3, 4, 5, 6]);
    }
}
