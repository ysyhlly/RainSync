//! Bounded process-local measurements of real body streams. No client telemetry.
//! Owners must bind these hooks at actual I/O and committed transition sites.
use std::fmt::Write;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

pub const MAX_ACTIVE_TRANSFERS: usize = 1024;
const BOUNDS_US: [u64; 9] = [
    10_000,
    50_000,
    100_000,
    500_000,
    1_000_000,
    5_000_000,
    30_000_000,
    120_000_000,
    600_000_000,
];
const LAYERS: [&str; 3] = ["worker_egress", "nas_uplink", "upstream_read"];
const OUTCOMES: [&str; 3] = ["complete", "failed", "cancelled"];

#[derive(Clone, Copy, Debug)]
pub enum Layer {
    WorkerEgress,
    NasUplink,
    UpstreamRead,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cache {
    Hit,
    NotHit,
}
#[derive(Clone, Copy, Debug)]
pub enum Outcome {
    Complete,
    Failed,
    Cancelled,
}
#[derive(Clone, Copy, Debug)]
pub enum CacheDecision {
    Hit,
    Miss,
}
#[derive(Clone, Copy, Debug)]
pub enum Failure {
    Prepare,
    Upstream,
    Capacity,
    Other,
}

#[derive(Clone, Copy, Default)]
struct Aggregate {
    count: u64,
    bytes: u64,
    micros: u64,
    buckets: [u64; 9],
}
impl Aggregate {
    fn observe(&mut self, bytes: u64, micros: u64) {
        self.count = self.count.saturating_add(1);
        self.bytes = self.bytes.saturating_add(bytes);
        self.micros = self.micros.saturating_add(micros);
        for (bucket, bound) in self.buckets.iter_mut().zip(BOUNDS_US) {
            if micros <= bound {
                *bucket = bucket.saturating_add(1);
            }
        }
    }
}
#[derive(Clone, Default)]
struct Snapshot {
    active: usize,
    admitted: u64,
    dropped: u64,
    body_bytes: [u64; 3],
    body_seen: [bool; 3],
    transfers: [[Aggregate; 3]; 3],
    cache: [u64; 2],
    cache_seen: bool,
    cached_bytes: u64,
    cached_bytes_seen: bool,
    failures: [u64; 4],
    failures_seen: bool,
}
#[derive(Clone, Default)]
pub struct RuntimeMetrics {
    inner: Arc<Mutex<Snapshot>>,
}
fn lock(inner: &Mutex<Snapshot>) -> MutexGuard<'_, Snapshot> {
    // No external callbacks run under this lock. Preserve bounded state if a
    // caller's panic nevertheless poisoned the mutex.
    inner.lock().unwrap_or_else(|e| e.into_inner())
}
impl RuntimeMetrics {
    /// Admission failure must never fail media delivery. Hit is only meaningful
    /// on Worker egress; invalid layer/cache combinations are rejected too.
    pub fn begin_transfer(&self, layer: Layer, cache: Cache) -> Option<Transfer> {
        let mut state = lock(&self.inner);
        if state.active == MAX_ACTIVE_TRANSFERS
            || (cache == Cache::Hit && !matches!(layer, Layer::WorkerEgress))
        {
            state.dropped = state.dropped.saturating_add(1);
            return None;
        }
        state.active += 1;
        state.admitted = state.admitted.saturating_add(1);
        Some(Transfer {
            inner: Arc::clone(&self.inner),
            layer,
            cache,
            started: Instant::now(),
            sequence: 0,
            bytes: 0,
            finished: false,
        })
    }
    /// Exactly once per cache-eligible lookup, after its actual decision.
    pub fn cache_lookup(&self, decision: CacheDecision) {
        let mut state = lock(&self.inner);
        state.cache_seen = true;
        let n = &mut state.cache[decision as usize];
        *n = n.saturating_add(1);
    }
    /// Owner calls only after a new failure transition commits; not on replay.
    pub fn playback_failure(&self, failure: Failure) {
        let mut state = lock(&self.inner);
        state.failures_seen = true;
        let n = &mut state.failures[failure as usize];
        *n = n.saturating_add(1);
    }
    pub fn render(&self) -> String {
        let state = lock(&self.inner).clone();
        let mut out = String::with_capacity(16_384);
        if state.admitted > 0 || state.dropped > 0 {
            out.push_str("# HELP rainsync_metric_transfer_admissions_total Admitted process-local body transfer measurements.\n# TYPE rainsync_metric_transfer_admissions_total counter\n");
            writeln!(
                out,
                "rainsync_metric_transfer_admissions_total {}",
                state.admitted
            )
            .unwrap();
            out.push_str("# HELP rainsync_metric_transfer_dropped_total Measurements omitted by capacity or invalid cache layer; delivery is unaffected.\n# TYPE rainsync_metric_transfer_dropped_total counter\n");
            writeln!(
                out,
                "rainsync_metric_transfer_dropped_total {}",
                state.dropped
            )
            .unwrap();
            out.push_str("# TYPE rainsync_metric_active_transfers gauge\n");
            writeln!(out, "rainsync_metric_active_transfers {}", state.active).unwrap();
            out.push_str("# HELP rainsync_transfer_bytes_total Actual body bytes accounted at transfer termination; not receiver acknowledgement.\n# TYPE rainsync_transfer_bytes_total counter\n# HELP rainsync_transfer_duration_seconds Monotonic body stream lifetime, including failed/cancelled transfers; overlapping durations are additive.\n# TYPE rainsync_transfer_duration_seconds histogram\n");
            for (layer, aggregates) in LAYERS.iter().zip(state.transfers) {
                for (outcome, aggregate) in OUTCOMES.iter().zip(aggregates) {
                    if aggregate.count == 0 {
                        continue;
                    }
                    let labels = format!("layer=\"{layer}\",outcome=\"{outcome}\"");
                    writeln!(
                        out,
                        "rainsync_transfer_bytes_total{{{labels}}} {}",
                        aggregate.bytes
                    )
                    .unwrap();
                    for (bound, count) in BOUNDS_US.iter().zip(aggregate.buckets) {
                        writeln!(out, "rainsync_transfer_duration_seconds_bucket{{{labels},le=\"{}\"}} {count}", *bound as f64 / 1_000_000.0).unwrap();
                    }
                    writeln!(out, "rainsync_transfer_duration_seconds_bucket{{{labels},le=\"+Inf\"}} {}\nrainsync_transfer_duration_seconds_count{{{labels}}} {}\nrainsync_transfer_duration_seconds_sum{{{labels}}} {}", aggregate.count, aggregate.count, aggregate.micros as f64 / 1_000_000.0).unwrap();
                }
            }
        }
        if state.body_seen.iter().any(|seen| *seen) {
            out.push_str("# HELP rainsync_transfer_body_bytes_total Actual body bytes observed as chunks are read or handed off, including streams still active; not receiver acknowledgement.\n# TYPE rainsync_transfer_body_bytes_total counter\n");
            for (index, layer) in LAYERS.iter().enumerate() {
                if state.body_seen[index] {
                    writeln!(
                        out,
                        "rainsync_transfer_body_bytes_total{{layer=\"{layer}\"}} {}",
                        state.body_bytes[index]
                    )
                    .unwrap();
                }
            }
        }
        if state.cache_seen {
            out.push_str("# HELP rainsync_cache_lookups_total Actual cache-eligible lookups; hit requires validated open and read lease.\n# TYPE rainsync_cache_lookups_total counter\n");
            for (result, count) in ["hit", "miss"].iter().zip(state.cache) {
                writeln!(
                    out,
                    "rainsync_cache_lookups_total{{result=\"{result}\"}} {count}"
                )
                .unwrap();
            }
        }
        if state.cached_bytes_seen {
            out.push_str("# HELP rainsync_cache_served_bytes_total Cached body bytes handed off, including partial failed or cancelled streams.\n# TYPE rainsync_cache_served_bytes_total counter\n");
            writeln!(
                out,
                "rainsync_cache_served_bytes_total {}",
                state.cached_bytes
            )
            .unwrap();
        }
        if state.failures_seen {
            out.push_str("# HELP rainsync_playback_preparation_failures_total Newly committed preparation failures; excludes cancellation, supersession and replay.\n# TYPE rainsync_playback_preparation_failures_total counter\n");
            for (reason, count) in ["prepare", "upstream", "capacity", "other"]
                .iter()
                .zip(state.failures)
            {
                writeln!(
                    out,
                    "rainsync_playback_preparation_failures_total{{reason=\"{reason}\"}} {count}"
                )
                .unwrap();
            }
        }
        out
    }
}
/// Not Clone: one owner and one terminal accounting event per actual stream.
pub struct Transfer {
    inner: Arc<Mutex<Snapshot>>,
    layer: Layer,
    cache: Cache,
    started: Instant,
    sequence: u64,
    bytes: u64,
    finished: bool,
}
impl Transfer {
    pub fn sample(&mut self, sequence: u64, cumulative_bytes: u64) -> bool {
        if sequence == 0 || sequence < self.sequence || cumulative_bytes < self.bytes {
            return false;
        }
        if sequence == self.sequence {
            return cumulative_bytes == self.bytes;
        }
        let delta = cumulative_bytes - self.bytes;
        let mut state = lock(&self.inner);
        let index = self.layer as usize;
        state.body_seen[index] = true;
        state.body_bytes[index] = state.body_bytes[index].saturating_add(delta);
        if self.cache == Cache::Hit {
            state.cached_bytes_seen = true;
            state.cached_bytes = state.cached_bytes.saturating_add(delta);
        }
        self.sequence = sequence;
        self.bytes = cumulative_bytes;
        true
    }
    pub fn finish(mut self, outcome: Outcome) {
        self.record(outcome);
    }
    fn record(&mut self, outcome: Outcome) {
        if self.finished {
            return;
        }
        self.finished = true;
        let micros = self.started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let mut state = lock(&self.inner);
        state.active -= 1;
        state.transfers[self.layer as usize][outcome as usize].observe(self.bytes, micros);
    }
}
impl Drop for Transfer {
    fn drop(&mut self) {
        self.record(Outcome::Cancelled);
    }
}

#[cfg(test)]
#[path = "runtime_metrics_tests.rs"]
mod tests;
