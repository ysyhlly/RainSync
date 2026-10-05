use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

pub const TRANSPORT_METRICS_VERSION: u8 = 1;
pub const TRANSPORT_METRICS_MAX_BYTES: usize = 4096;
pub const CONTROL_RECOVERY_MAX_MS: u32 = 7 * 24 * 60 * 60 * 1000;
pub const NAS_METRIC_MAX_COUNTER: u64 = 9_007_199_254_740_991;
pub const NAS_METRIC_MAX_ACTIVE: u32 = 16;
pub const NAS_METRIC_BOUNDS_US: [u64; 9] = [
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub enum ControlRecoveryMessageType {
    #[serde(rename = "CONTROL_RECOVERY_METRICS")]
    ControlRecoveryMetrics,
}

/// Successful state application reported by a client, not physical network
/// restoration, playback recovery, authority, or independent timing evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ControlRecoveryMetricsSample {
    #[serde(rename = "type")]
    pub kind: ControlRecoveryMessageType,
    pub version: u8,
    pub socket_open_to_state_applied_ms: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub disconnect_observed_to_state_applied_ms: Option<u32>,
    pub background: bool,
}

impl ControlRecoveryMetricsSample {
    pub fn valid(&self) -> bool {
        self.version == TRANSPORT_METRICS_VERSION
            && self.socket_open_to_state_applied_ms <= CONTROL_RECOVERY_MAX_MS
            && self
                .disconnect_observed_to_state_applied_ms
                .is_none_or(|value| {
                    value <= CONTROL_RECOVERY_MAX_MS
                        && value >= self.socket_open_to_state_applied_ms
                })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NasUplinkOutcomeTotals {
    #[ts(type = "number")]
    pub transfers: u64,
    #[ts(type = "number")]
    pub bytes: u64,
    #[ts(type = "number")]
    pub duration_us: u64,
    #[ts(type = "[number, number, number, number, number, number, number, number, number]")]
    pub duration_buckets: [u64; 9],
}

impl NasUplinkOutcomeTotals {
    pub fn valid(&self) -> bool {
        let shape = self.transfers <= NAS_METRIC_MAX_COUNTER
            && self.bytes <= NAS_METRIC_MAX_COUNTER
            && self.duration_us <= NAS_METRIC_MAX_COUNTER
            && self
                .duration_buckets
                .iter()
                .all(|value| *value <= self.transfers)
            && self
                .duration_buckets
                .windows(2)
                .all(|pair| pair[0] <= pair[1])
            && (self.transfers > 0 || (self.bytes == 0 && self.duration_us == 0));
        if !shape {
            return false;
        }
        let mut previous_count = 0;
        let mut lower = 0;
        let mut minimum = 0u128;
        let mut maximum = 0u128;
        for (count, upper) in self.duration_buckets.into_iter().zip(NAS_METRIC_BOUNDS_US) {
            let group = u128::from(count - previous_count);
            minimum += group * lower;
            maximum += group * u128::from(upper);
            previous_count = count;
            lower = u128::from(upper) + 1;
        }
        let tail = u128::from(self.transfers - previous_count);
        minimum += tail * lower;
        let sum = u128::from(self.duration_us);
        sum >= minimum && (tail != 0 || sum <= maximum)
    }

    fn checked_delta(&self, previous: &Self) -> Option<Self> {
        let mut buckets = [0; 9];
        for (delta, (current, previous)) in buckets
            .iter_mut()
            .zip(self.duration_buckets.iter().zip(previous.duration_buckets))
        {
            *delta = current.checked_sub(previous)?;
        }
        let delta = Self {
            transfers: self.transfers.checked_sub(previous.transfers)?,
            bytes: self.bytes.checked_sub(previous.bytes)?,
            duration_us: self.duration_us.checked_sub(previous.duration_us)?,
            duration_buckets: buckets,
        };
        delta.valid().then_some(delta)
    }
}

/// Cumulative measurements from one fixed Agent collector. No identities,
/// arbitrary dimensions, source fields, credentials, or authoritative claims.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NasUplinkTotals {
    #[ts(type = "number")]
    pub admitted: u64,
    #[ts(type = "number")]
    pub dropped: u64,
    pub active: u32,
    pub body_seen: bool,
    #[ts(type = "number")]
    pub body_bytes: u64,
    pub complete: NasUplinkOutcomeTotals,
    pub failed: NasUplinkOutcomeTotals,
    pub cancelled: NasUplinkOutcomeTotals,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NasUplinkDelta {
    pub admitted: u64,
    pub dropped: u64,
    pub body_seen: bool,
    pub body_bytes: u64,
    pub complete: NasUplinkOutcomeTotals,
    pub failed: NasUplinkOutcomeTotals,
    pub cancelled: NasUplinkOutcomeTotals,
}

impl NasUplinkDelta {
    pub fn valid(&self) -> bool {
        self.admitted <= NAS_METRIC_MAX_COUNTER
            && self.dropped <= NAS_METRIC_MAX_COUNTER
            && self.body_bytes <= NAS_METRIC_MAX_COUNTER
            && (self.body_seen || self.body_bytes == 0)
            && [self.complete, self.failed, self.cancelled]
                .iter()
                .all(|value| value.valid())
    }
}

impl NasUplinkTotals {
    pub fn valid(&self) -> bool {
        let outcomes = [self.complete, self.failed, self.cancelled];
        if self.admitted > NAS_METRIC_MAX_COUNTER
            || self.dropped > NAS_METRIC_MAX_COUNTER
            || self.body_bytes > NAS_METRIC_MAX_COUNTER
            || self.active > NAS_METRIC_MAX_ACTIVE
            || (!self.body_seen && self.body_bytes != 0)
            || outcomes.iter().any(|value| !value.valid())
        {
            return false;
        }
        let count = outcomes
            .iter()
            .try_fold(u64::from(self.active), |total, value| {
                total.checked_add(value.transfers)
            });
        let bytes = outcomes
            .iter()
            .try_fold(0u64, |total, value| total.checked_add(value.bytes));
        count == Some(self.admitted) && bytes.is_some_and(|bytes| bytes <= self.body_bytes)
    }

    pub fn checked_delta(&self, previous: &Self) -> Option<NasUplinkDelta> {
        if !self.valid() || !previous.valid() || (previous.body_seen && !self.body_seen) {
            return None;
        }
        Some(NasUplinkDelta {
            admitted: self.admitted.checked_sub(previous.admitted)?,
            dropped: self.dropped.checked_sub(previous.dropped)?,
            // An old process-lifetime observation in the HELLO baseline is not
            // a new zero-byte body measurement after reconnect. A newly
            // admitted empty body is still an actual observation.
            body_seen: self.body_seen
                && (!previous.body_seen
                    || self.admitted > previous.admitted
                    || self.body_bytes > previous.body_bytes),
            body_bytes: self.body_bytes.checked_sub(previous.body_bytes)?,
            complete: self.complete.checked_delta(&previous.complete)?,
            failed: self.failed.checked_delta(&previous.failed)?,
            cancelled: self.cancelled.checked_delta(&previous.cancelled)?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NasUplinkMetricsSample {
    pub version: u8,
    pub connection_id: Uuid,
    pub seq: u32,
    pub totals: NasUplinkTotals,
}

impl NasUplinkMetricsSample {
    pub fn valid(&self) -> bool {
        self.version == TRANSPORT_METRICS_VERSION && self.seq > 0 && self.totals.valid()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_baseline_does_not_invent_a_new_body_observation() {
        let before = NasUplinkTotals {
            admitted: 1,
            active: 1,
            body_seen: true,
            body_bytes: 10,
            ..Default::default()
        };
        assert!(!before.checked_delta(&before).unwrap().body_seen);
        let mut current = before;
        current.body_bytes += 1;
        assert!(current.checked_delta(&before).unwrap().body_seen);
        current = before;
        current.admitted += 1;
        current.active += 1;
        let empty = current.checked_delta(&before).unwrap();
        assert!(empty.body_seen);
        assert_eq!(empty.body_bytes, 0);
    }

    #[test]
    fn control_reports_are_bounded_and_cannot_claim_network_restoration() {
        let mut sample = ControlRecoveryMetricsSample {
            kind: ControlRecoveryMessageType::ControlRecoveryMetrics,
            version: 1,
            socket_open_to_state_applied_ms: 12,
            disconnect_observed_to_state_applied_ms: Some(35),
            background: true,
        };
        assert!(sample.valid());
        sample.disconnect_observed_to_state_applied_ms = Some(11);
        assert!(!sample.valid());
        sample.disconnect_observed_to_state_applied_ms = None;
        sample.socket_open_to_state_applied_ms = CONTROL_RECOVERY_MAX_MS + 1;
        assert!(!sample.valid());
        let text = r#"{"type":"CONTROL_RECOVERY_METRICS","version":1,"socket_open_to_state_applied_ms":3,"background":false,"network_restored_ms":0}"#;
        assert!(serde_json::from_str::<ControlRecoveryMetricsSample>(text).is_err());
    }

    #[test]
    fn nas_cumulative_frames_cannot_rewrite_prior_histograms_or_counts() {
        let mut prior = NasUplinkTotals {
            admitted: 1,
            active: 1,
            body_seen: true,
            body_bytes: 10,
            ..Default::default()
        };
        assert!(prior.valid());
        let mut next = prior;
        next.active = 0;
        next.complete = NasUplinkOutcomeTotals {
            transfers: 1,
            bytes: 10,
            duration_us: 12_000,
            duration_buckets: [0, 1, 1, 1, 1, 1, 1, 1, 1],
        };
        let delta = next.checked_delta(&prior).unwrap();
        assert_eq!(delta.body_bytes, 0);
        assert_eq!(delta.complete.bytes, 10); // an active body can span a baseline
        prior = next;
        next.admitted += 1;
        next.complete.transfers += 1;
        next.complete.duration_buckets = [2; 9];
        assert!(next.valid());
        assert!(next.checked_delta(&prior).is_none());
        next.body_seen = false;
        assert!(!next.valid());
    }

    #[test]
    fn nas_wire_is_closed_bounded_and_duplicate_fields_are_rejected() {
        let sample = NasUplinkMetricsSample {
            version: 1,
            connection_id: Uuid::nil(),
            seq: 1,
            totals: NasUplinkTotals::default(),
        };
        let text = serde_json::to_string(&sample).unwrap();
        assert!(text.len() < TRANSPORT_METRICS_MAX_BYTES);
        assert!(sample.valid());
        assert!(
            serde_json::from_str::<NasUplinkMetricsSample>(&text.replacen(
                "\"seq\":1",
                "\"seq\":1,\"seq\":1",
                1
            ))
            .is_err()
        );
        let mut invalid = sample;
        invalid.totals.body_bytes = NAS_METRIC_MAX_COUNTER + 1;
        assert!(!invalid.valid());
    }
}
