//! Bounded process-local measurements of real body streams and separately named,
//! untrusted client reports. Owners bind hooks at actual I/O and committed sites.
use protocol::{
    ControlRecoveryMetricsSample, NAS_METRIC_MAX_ACTIVE, NasUplinkDelta, NasUplinkOutcomeTotals,
    NasUplinkTotals, PLAYBACK_METRICS_MAX_ELAPSED_MS, PlaybackMetricsFirstFrame,
    PlaybackMetricsFrameEvidence, PlaybackMetricsOrigin, PlaybackMetricsTotals,
};
use std::fmt::Write;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

pub const MAX_ACTIVE_TRANSFERS: usize = 1024;
/// Fixed aggregate storage, including the two separately named report families.
pub const MAX_METRIC_SNAPSHOT_BYTES: usize = 4096;
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
const CLIENT_ORIGINS: [&str; 2] = ["user_intent", "automatic_load"];
const CLIENT_STATES: [&str; 8] = [
    "startup",
    "autoplay_blocked",
    "background",
    "paused",
    "seeking",
    "rebuffer",
    "playing",
    "unobserved",
];
const CLIENT_EVIDENCE: [&str; 2] = ["video_frame_callback", "playing_time_advance"];
const CLIENT_DROP_REASONS: [&str; 5] = [
    "rate_limited",
    "capacity",
    "invalid",
    "unavailable",
    "overflow",
];
const CLIENT_BOUNDS_MS: [u64; 9] = [10, 50, 100, 500, 1_000, 5_000, 30_000, 120_000, 600_000];

#[derive(Clone, Copy, Debug)]
pub enum Process {
    Server,
    Worker,
}

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

/// Closed telemetry-loss reasons; never include an identity or free-form error.
#[derive(Clone, Copy, Debug)]
pub enum ClientMetricsDrop {
    RateLimited,
    Capacity,
    Invalid,
    Unavailable,
    Overflow,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ClientHistogram {
    count: u64,
    milliseconds: u64,
    buckets: [u64; 9],
}
impl ClientHistogram {
    fn checked_observe(&mut self, milliseconds: u64) -> Option<()> {
        self.count = self.count.checked_add(1)?;
        self.milliseconds = self.milliseconds.checked_add(milliseconds)?;
        for (bucket, bound) in self.buckets.iter_mut().zip(CLIENT_BOUNDS_MS) {
            if milliseconds <= bound {
                *bucket = bucket.checked_add(1)?;
            }
        }
        Some(())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ClientFirstFrame {
    elapsed: ClientHistogram,
    confirmation_lag: ClientHistogram,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ClientPlaybackAggregate {
    samples: u64,
    elapsed_ms: u64,
    duration_ms: [u64; 8],
    first_frames: [ClientFirstFrame; 2],
}
impl ClientPlaybackAggregate {
    fn checked_observe(
        &mut self,
        values: [u32; 8],
        elapsed_ms: u64,
        first: Option<&PlaybackMetricsFirstFrame>,
    ) -> Option<()> {
        self.samples = self.samples.checked_add(1)?;
        self.elapsed_ms = self.elapsed_ms.checked_add(elapsed_ms)?;
        for (total, delta) in self.duration_ms.iter_mut().zip(values) {
            *total = total.checked_add(u64::from(delta))?;
        }
        if let Some(first) = first {
            let evidence = match first.evidence {
                PlaybackMetricsFrameEvidence::VideoFrameCallback => 0,
                PlaybackMetricsFrameEvidence::PlayingTimeAdvance => 1,
            };
            let frame = &mut self.first_frames[evidence];
            frame.elapsed.checked_observe(u64::from(first.elapsed_ms))?;
            frame.confirmation_lag.checked_observe(u64::from(
                first.confirmed_elapsed_ms.checked_sub(first.elapsed_ms)?,
            ))?;
        }
        Some(())
    }
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
    client_playback: [ClientPlaybackAggregate; 2],
    client_dropped: [u64; 5],
    control_recovery: [ControlRecoveryAggregate; 2],
    control_dropped: [u64; 7],
    agent_nas: AgentNasAggregate,
    agent_nas_dropped: [u64; 7],
}

#[derive(Clone, Copy, Debug)]
pub enum TransportMetricDrop {
    Invalid,
    Stale,
    RateLimited,
    Capacity,
    Unavailable,
    Unauthorized,
    Overflow,
}
const TRANSPORT_DROP_REASONS: [&str; 7] = [
    "invalid",
    "stale",
    "rate_limited",
    "capacity",
    "unavailable",
    "unauthorized",
    "overflow",
];

#[derive(Clone, Copy, Default)]
struct ControlRecoveryAggregate {
    socket: ClientHistogram,
    disconnect: ClientHistogram,
}

#[derive(Clone, Copy, Default)]
struct AgentNasAggregate {
    samples: u64,
    admitted: u64,
    dropped: u64,
    body_bytes: u64,
    body_seen: bool,
    outcomes: [Aggregate; 3],
}

/// A sealed NAS-only collector. It cannot admit other layers or cache events,
/// so its fixed snapshot does not confuse shared process-wide totals with NAS.
#[derive(Clone, Default)]
pub struct NasUplinkMetrics(RuntimeMetrics);
impl NasUplinkMetrics {
    pub fn begin_transfer(&self) -> Option<Transfer> {
        let transfer = self.0.begin_transfer_with_limit(
            Layer::NasUplink,
            Cache::NotHit,
            NAS_METRIC_MAX_ACTIVE as usize,
        )?;
        lock(&self.0.inner).body_seen[Layer::NasUplink as usize] = true;
        Some(transfer)
    }
    pub fn snapshot(&self) -> NasUplinkTotals {
        let state = lock(&self.0.inner);
        let [complete, failed, cancelled] =
            state.transfers[Layer::NasUplink as usize].map(|value| NasUplinkOutcomeTotals {
                transfers: value.count,
                bytes: value.bytes,
                duration_us: value.micros,
                duration_buckets: value.buckets,
            });
        NasUplinkTotals {
            admitted: state.admitted,
            dropped: state.dropped,
            active: state.active as u32,
            body_seen: state.body_seen[Layer::NasUplink as usize],
            body_bytes: state.body_bytes[Layer::NasUplink as usize],
            complete,
            failed,
            cancelled,
        }
    }
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
        self.begin_transfer_with_limit(layer, cache, MAX_ACTIVE_TRANSFERS)
    }
    fn begin_transfer_with_limit(
        &self,
        layer: Layer,
        cache: Cache,
        limit: usize,
    ) -> Option<Transfer> {
        let mut state = lock(&self.inner);
        if state.active >= limit || (cache == Cache::Hit && !matches!(layer, Layer::WorkerEgress)) {
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

    pub fn client_control_recovery(&self, sample: &ControlRecoveryMetricsSample) -> bool {
        let mut state = lock(&self.inner);
        if !sample.valid() {
            state.control_dropped[TransportMetricDrop::Invalid as usize] =
                state.control_dropped[TransportMetricDrop::Invalid as usize].saturating_add(1);
            return false;
        }
        let target = &mut state.control_recovery[usize::from(sample.background)];
        let mut candidate = *target;
        let accepted = candidate
            .socket
            .checked_observe(u64::from(sample.socket_open_to_state_applied_ms))
            .is_some()
            && sample
                .disconnect_observed_to_state_applied_ms
                .is_none_or(|value| {
                    candidate
                        .disconnect
                        .checked_observe(u64::from(value))
                        .is_some()
                });
        if accepted {
            *target = candidate;
        } else {
            state.control_dropped[TransportMetricDrop::Overflow as usize] =
                state.control_dropped[TransportMetricDrop::Overflow as usize].saturating_add(1);
        }
        accepted
    }
    pub fn client_control_dropped(&self, reason: TransportMetricDrop) {
        let mut state = lock(&self.inner);
        state.control_dropped[reason as usize] =
            state.control_dropped[reason as usize].saturating_add(1);
    }

    /// Receiver owns current-connection authentication, sequence and baseline.
    /// This namespace remains authenticated Agent self-report, not local I/O.
    pub fn agent_nas_sample(&self, delta: &NasUplinkDelta) -> bool {
        let mut state = lock(&self.inner);
        if !delta.valid() {
            state.agent_nas_dropped[TransportMetricDrop::Invalid as usize] =
                state.agent_nas_dropped[TransportMetricDrop::Invalid as usize].saturating_add(1);
            return false;
        }
        let mut next = state.agent_nas;
        let updated = (|| -> Option<()> {
            next.samples = next.samples.checked_add(1)?;
            next.admitted = next.admitted.checked_add(delta.admitted)?;
            next.dropped = next.dropped.checked_add(delta.dropped)?;
            next.body_bytes = next.body_bytes.checked_add(delta.body_bytes)?;
            next.body_seen |= delta.body_seen;
            for (target, value) in
                next.outcomes
                    .iter_mut()
                    .zip([delta.complete, delta.failed, delta.cancelled])
            {
                target.count = target.count.checked_add(value.transfers)?;
                target.bytes = target.bytes.checked_add(value.bytes)?;
                target.micros = target.micros.checked_add(value.duration_us)?;
                for (target, value) in target.buckets.iter_mut().zip(value.duration_buckets) {
                    *target = target.checked_add(value)?;
                }
            }
            Some(())
        })();
        if updated.is_some() {
            state.agent_nas = next;
            true
        } else {
            state.agent_nas_dropped[TransportMetricDrop::Overflow as usize] =
                state.agent_nas_dropped[TransportMetricDrop::Overflow as usize].saturating_add(1);
            false
        }
    }
    pub fn agent_nas_dropped(&self, reason: TransportMetricDrop) {
        let mut state = lock(&self.inner);
        state.agent_nas_dropped[reason as usize] =
            state.agent_nas_dropped[reason as usize].saturating_add(1);
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
    /// Call only after a newly accepted durable client sample commits. The owner
    /// supplies the checked cumulative delta and only a newly recorded first
    /// frame; sequence, replay and lifecycle ownership stay outside this collector.
    /// Reports do not prove physical display and never carry a delivery-mode label.
    /// Returns false and records one fixed loss reason if the whole update is dropped.
    pub fn client_playback_sample(
        &self,
        origin: PlaybackMetricsOrigin,
        delta: &PlaybackMetricsTotals,
        first: Option<&PlaybackMetricsFirstFrame>,
    ) -> bool {
        let values = delta.values();
        let elapsed_ms = values
            .iter()
            .try_fold(0_u64, |sum, value| sum.checked_add(u64::from(*value)));
        let valid = values
            .iter()
            .all(|value| *value <= PLAYBACK_METRICS_MAX_ELAPSED_MS)
            && elapsed_ms.is_some_and(|sum| sum <= u64::from(PLAYBACK_METRICS_MAX_ELAPSED_MS))
            && first.is_none_or(|frame| {
                frame.elapsed_ms <= frame.confirmed_elapsed_ms
                    && frame.confirmed_elapsed_ms <= PLAYBACK_METRICS_MAX_ELAPSED_MS
            });
        let mut state = lock(&self.inner);
        if !valid {
            let count = &mut state.client_dropped[ClientMetricsDrop::Invalid as usize];
            *count = count.saturating_add(1);
            return false;
        }
        let index = match origin {
            PlaybackMetricsOrigin::UserIntent => 0,
            PlaybackMetricsOrigin::AutomaticLoad => 1,
        };
        // Stage a fixed-size copy: overflow in any duration/histogram cannot
        // credit a sample or a partial subset of its measurements.
        let mut next = state.client_playback[index];
        if next
            .checked_observe(values, elapsed_ms.expect("validated delta sum"), first)
            .is_none()
        {
            let count = &mut state.client_dropped[ClientMetricsDrop::Overflow as usize];
            *count = count.saturating_add(1);
            return false;
        }
        state.client_playback[index] = next;
        true
    }
    /// Count known loss at the receiver without storing identities or packets.
    /// Collector rejection already records Invalid/Overflow; do not count it twice.
    pub fn client_playback_dropped(&self, reason: ClientMetricsDrop) {
        let mut state = lock(&self.inner);
        let count = &mut state.client_dropped[reason as usize];
        *count = count.saturating_add(1);
    }
    /// Process labels are closed enum values; this never contacts another process.
    pub fn render_for(&self, process: Process) -> String {
        let raw = self.render_unlabelled();
        let label = match process {
            Process::Server => "server",
            Process::Worker => "worker",
        };
        let mut output = String::with_capacity(raw.len() + 4096);
        for line in raw.lines() {
            if line.starts_with('#') {
                writeln!(output, "{line}").unwrap();
                continue;
            }
            let (name, value) = line.split_once(' ').expect("fixed metric sample");
            if let Some(name) = name.strip_suffix('}') {
                writeln!(output, "{name},process=\"{label}\"}} {value}").unwrap();
            } else {
                writeln!(output, "{name}{{process=\"{label}\"}} {value}").unwrap();
            }
        }
        output
    }
    fn render_unlabelled(&self) -> String {
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
        if state
            .client_playback
            .iter()
            .any(|aggregate| aggregate.samples > 0)
        {
            out.push_str("# HELP rainsync_client_reported_playback_samples_total Newly committed client reports; untrusted initial prefixes are bounded, and replay is excluded by the owner.\n# TYPE rainsync_client_reported_playback_samples_total counter\n# HELP rainsync_client_reported_playback_elapsed_milliseconds_total Accepted client-reported delta duration, including unobserved time.\n# TYPE rainsync_client_reported_playback_elapsed_milliseconds_total counter\n# HELP rainsync_client_reported_playback_state_duration_milliseconds_total Accepted client-reported deltas by mutually exclusive state; seeking remains separate from playing.\n# TYPE rainsync_client_reported_playback_state_duration_milliseconds_total counter\n");
            for (origin, aggregate) in CLIENT_ORIGINS.iter().zip(state.client_playback) {
                if aggregate.samples == 0 {
                    continue;
                }
                writeln!(
                    out,
                    "rainsync_client_reported_playback_samples_total{{origin=\"{origin}\"}} {}",
                    aggregate.samples
                )
                .unwrap();
                writeln!(out, "rainsync_client_reported_playback_elapsed_milliseconds_total{{origin=\"{origin}\"}} {}", aggregate.elapsed_ms).unwrap();
                for (state, duration) in CLIENT_STATES.iter().zip(aggregate.duration_ms) {
                    writeln!(out, "rainsync_client_reported_playback_state_duration_milliseconds_total{{origin=\"{origin}\",state=\"{state}\"}} {duration}").unwrap();
                }
            }
        }
        if state.client_playback.iter().any(|aggregate| {
            aggregate
                .first_frames
                .iter()
                .any(|frame| frame.elapsed.count > 0)
        }) {
            out.push_str("# HELP rainsync_client_reported_playback_first_frame_elapsed_milliseconds Client-reported startup elapsed to first-frame evidence; video_frame_callback is presentation submission, not proof of physical display.\n# TYPE rainsync_client_reported_playback_first_frame_elapsed_milliseconds histogram\n# HELP rainsync_client_reported_playback_first_frame_confirmation_lag_milliseconds Client-reported delay between first-frame evidence and confirmation; absent reports do not contribute zero.\n# TYPE rainsync_client_reported_playback_first_frame_confirmation_lag_milliseconds histogram\n");
            for (origin, aggregate) in CLIENT_ORIGINS.iter().zip(state.client_playback) {
                for (evidence, frame) in CLIENT_EVIDENCE.iter().zip(aggregate.first_frames) {
                    if frame.elapsed.count == 0 {
                        continue;
                    }
                    let labels = format!("origin=\"{origin}\",evidence=\"{evidence}\"");
                    render_client_histogram(
                        &mut out,
                        "rainsync_client_reported_playback_first_frame_elapsed_milliseconds",
                        &labels,
                        frame.elapsed,
                    );
                    render_client_histogram(
                        &mut out,
                        "rainsync_client_reported_playback_first_frame_confirmation_lag_milliseconds",
                        &labels,
                        frame.confirmation_lag,
                    );
                }
            }
        }
        if state.client_dropped.iter().any(|count| *count > 0) {
            out.push_str("# HELP rainsync_client_reported_playback_dropped_total Known telemetry loss by fixed reason; playback delivery is unaffected.\n# TYPE rainsync_client_reported_playback_dropped_total counter\n");
            for (reason, count) in CLIENT_DROP_REASONS.iter().zip(state.client_dropped) {
                if count > 0 {
                    writeln!(out, "rainsync_client_reported_playback_dropped_total{{reason=\"{reason}\"}} {count}").unwrap();
                }
            }
        }
        if state
            .control_recovery
            .iter()
            .any(|value| value.socket.count > 0)
        {
            out.push_str("# HELP rainsync_client_reported_control_recovery_milliseconds Successful client-reported socket/disconnect to applied authoritative state; not verified network restoration or playback recovery; unreported failures are absent.\n# TYPE rainsync_client_reported_control_recovery_milliseconds histogram\n");
            for (background, value) in ["false", "true"].iter().zip(state.control_recovery) {
                for (boundary, histogram) in [
                    ("socket_open_to_state_applied", value.socket),
                    ("disconnect_observed_to_state_applied", value.disconnect),
                ] {
                    if histogram.count > 0 {
                        render_client_histogram(
                            &mut out,
                            "rainsync_client_reported_control_recovery_milliseconds",
                            &format!("boundary=\"{boundary}\",background=\"{background}\""),
                            histogram,
                        );
                    }
                }
            }
        }
        if state.agent_nas.samples > 0 {
            out.push_str("# HELP rainsync_agent_reported_nas_samples_total Accepted current-connection Agent reports; uncredited baselines and lost tails are excluded.\n# TYPE rainsync_agent_reported_nas_samples_total counter\n# HELP rainsync_agent_reported_nas_body_bytes_total Agent-reported successful WebSocket body handoff, including active transfers; not Server-observed I/O, peer acknowledgement or billing authority.\n# TYPE rainsync_agent_reported_nas_body_bytes_total counter\n# TYPE rainsync_agent_reported_nas_admissions_total counter\n# TYPE rainsync_agent_reported_nas_measurements_dropped_total counter\n");
            writeln!(
                out,
                "rainsync_agent_reported_nas_samples_total {}",
                state.agent_nas.samples
            )
            .unwrap();
            writeln!(
                out,
                "rainsync_agent_reported_nas_admissions_total {}",
                state.agent_nas.admitted
            )
            .unwrap();
            writeln!(
                out,
                "rainsync_agent_reported_nas_measurements_dropped_total {}",
                state.agent_nas.dropped
            )
            .unwrap();
            if state.agent_nas.body_seen {
                writeln!(
                    out,
                    "rainsync_agent_reported_nas_body_bytes_total {}",
                    state.agent_nas.body_bytes
                )
                .unwrap();
            }
            if state.agent_nas.outcomes.iter().any(|value| value.count > 0) {
                out.push_str("# HELP rainsync_agent_reported_nas_transfer_bytes_total Agent-reported bytes in completed body observations; a terminal aggregate can span its connection baseline.\n# TYPE rainsync_agent_reported_nas_transfer_bytes_total counter\n# HELP rainsync_agent_reported_nas_transfer_duration_seconds Agent-reported monotonic body lifetime; successful handoff is not resource disposal or peer acknowledgement.\n# TYPE rainsync_agent_reported_nas_transfer_duration_seconds histogram\n");
                for (outcome, value) in OUTCOMES.iter().zip(state.agent_nas.outcomes) {
                    if value.count == 0 {
                        continue;
                    }
                    writeln!(out, "rainsync_agent_reported_nas_transfer_bytes_total{{outcome=\"{outcome}\"}} {}", value.bytes).unwrap();
                    for (bound, count) in BOUNDS_US.iter().zip(value.buckets) {
                        writeln!(out, "rainsync_agent_reported_nas_transfer_duration_seconds_bucket{{outcome=\"{outcome}\",le=\"{}\"}} {count}", *bound as f64 / 1_000_000.0).unwrap();
                    }
                    writeln!(out, "rainsync_agent_reported_nas_transfer_duration_seconds_bucket{{outcome=\"{outcome}\",le=\"+Inf\"}} {}\nrainsync_agent_reported_nas_transfer_duration_seconds_count{{outcome=\"{outcome}\"}} {}\nrainsync_agent_reported_nas_transfer_duration_seconds_sum{{outcome=\"{outcome}\"}} {}", value.count, value.count, value.micros as f64 / 1_000_000.0).unwrap();
                }
            }
        }
        for (name, values) in [
            (
                "rainsync_client_reported_control_recovery_dropped_total",
                state.control_dropped,
            ),
            (
                "rainsync_agent_reported_nas_dropped_total",
                state.agent_nas_dropped,
            ),
        ] {
            if values.iter().any(|value| *value > 0) {
                writeln!(out, "# TYPE {name} counter").unwrap();
                for (reason, count) in TRANSPORT_DROP_REASONS.iter().zip(values) {
                    if count > 0 {
                        writeln!(out, "{name}{{reason=\"{reason}\"}} {count}").unwrap();
                    }
                }
            }
        }
        out
    }
}
fn render_client_histogram(out: &mut String, name: &str, labels: &str, histogram: ClientHistogram) {
    for (bound, count) in CLIENT_BOUNDS_MS.iter().zip(histogram.buckets) {
        writeln!(out, "{name}_bucket{{{labels},le=\"{bound}\"}} {count}").unwrap();
    }
    writeln!(out, "{name}_bucket{{{labels},le=\"+Inf\"}} {}\n{name}_count{{{labels}}} {}\n{name}_sum{{{labels}}} {}", histogram.count, histogram.count, histogram.milliseconds).unwrap();
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
