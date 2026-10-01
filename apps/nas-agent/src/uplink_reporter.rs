//! Constant-size negotiation and cumulative reporting on the ordinary heartbeat.
//! Every new connection starts from an uncredited, frozen HELLO baseline.
use protocol::{
    NasUplinkMetricsSample, NasUplinkTotals, TRANSPORT_METRICS_MAX_BYTES, TRANSPORT_METRICS_VERSION,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
enum ReadyType {
    #[serde(rename = "NAS_METRICS_READY")]
    NasMetricsReady,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    #[serde(rename = "type")]
    _kind: ReadyType,
    version: u8,
    connection_id: Uuid,
}

pub struct Reporter {
    baseline: NasUplinkTotals,
    previous: NasUplinkTotals,
    connection: Option<Uuid>,
    sequence: u32,
}

impl Reporter {
    pub fn new(baseline: NasUplinkTotals) -> Self {
        Self {
            baseline,
            previous: baseline,
            connection: None,
            sequence: 0,
        }
    }

    pub fn hello(&self) -> Value {
        let mut hello = json!({
            "type": "HELLO",
            "manual_scan": true,
            "source_versions": true,
            "drain_receipts": true,
        });
        if self.baseline.valid() {
            hello["uplink_metrics_version"] = json!(TRANSPORT_METRICS_VERSION);
            hello["uplink_metrics_baseline"] = json!(self.baseline);
        }
        hello
    }

    /// Parse the original text so duplicate and unknown READY fields fail closed.
    /// Later READY packets cannot replace this connection or reset its sequence.
    pub fn ready(&mut self, text: &str) {
        if self.connection.is_some()
            || !self.baseline.valid()
            || text.len() > TRANSPORT_METRICS_MAX_BYTES
        {
            return;
        }
        let Ok(ready) = serde_json::from_str::<Ready>(text) else {
            return;
        };
        if ready.version == TRANSPORT_METRICS_VERSION && !ready.connection_id.is_nil() {
            self.connection = Some(ready.connection_id);
        }
    }

    pub fn is_ready(&self) -> bool {
        self.connection.is_some()
    }

    /// No ACK, retry queue or extra send: only a field on the existing heartbeat.
    /// Invalid/overflowed observation leaves the ordinary heartbeat usable.
    pub fn heartbeat(&mut self, totals: NasUplinkTotals) -> Value {
        let ordinary = json!({"type": "HEARTBEAT"});
        let Some(connection_id) = self.connection else {
            return ordinary;
        };
        let Some(seq) = self.sequence.checked_add(1) else {
            return ordinary;
        };
        if totals.checked_delta(&self.previous).is_none() {
            return ordinary;
        }
        let sample = NasUplinkMetricsSample {
            version: TRANSPORT_METRICS_VERSION,
            connection_id,
            seq,
            totals,
        };
        let message = json!({"type": "HEARTBEAT", "uplink_metrics": sample});
        if !serde_json::to_vec(&message)
            .is_ok_and(|bytes| bytes.len() <= TRANSPORT_METRICS_MAX_BYTES)
        {
            return ordinary;
        }
        self.sequence = seq;
        self.previous = totals;
        message
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{NAS_METRIC_MAX_COUNTER, NasUplinkOutcomeTotals};

    fn ready(connection: Uuid) -> String {
        json!({"type":"NAS_METRICS_READY", "version":1, "connection_id":connection}).to_string()
    }

    fn active(bytes: u64) -> NasUplinkTotals {
        NasUplinkTotals {
            admitted: 1,
            active: 1,
            body_seen: true,
            body_bytes: bytes,
            ..Default::default()
        }
    }

    fn sample(value: Value) -> NasUplinkMetricsSample {
        assert_eq!(value["type"], "HEARTBEAT");
        serde_json::from_value(value["uplink_metrics"].clone()).unwrap()
    }

    #[test]
    fn baseline_is_frozen_and_legacy_control_never_produces_a_sample() {
        let baseline = active(7);
        let mut reporter = Reporter::new(baseline);
        let hello = reporter.hello();
        assert_eq!(hello["uplink_metrics_version"], 1);
        assert_eq!(hello["uplink_metrics_baseline"], json!(baseline));
        assert!(!reporter.is_ready());
        assert_eq!(reporter.heartbeat(active(12)), json!({"type":"HEARTBEAT"}));
        assert_eq!(reporter.hello(), hello);
    }

    #[test]
    fn ready_is_strict_and_cannot_rebind_or_reset_reporting() {
        let connection = Uuid::new_v4();
        let mut reporter = Reporter::new(NasUplinkTotals::default());
        for text in [
            ready(Uuid::nil()),
            ready(connection).replacen("\"version\":1", "\"version\":2", 1),
            ready(connection).replacen("\"version\":1", "\"version\":1,\"version\":1", 1),
            ready(connection).replacen("\"version\":1", "\"version\":1,\"agent_id\":\"other\"", 1),
            " ".repeat(TRANSPORT_METRICS_MAX_BYTES + 1),
        ] {
            reporter.ready(&text);
            assert!(!reporter.is_ready());
        }
        reporter.ready(&ready(connection));
        assert_eq!(sample(reporter.heartbeat(active(10))).seq, 1);
        reporter.ready(&ready(Uuid::new_v4()));
        reporter.ready(&ready(connection));
        let next = sample(reporter.heartbeat(active(20)));
        assert_eq!(next.connection_id, connection);
        assert_eq!(next.seq, 2);
    }

    #[test]
    fn missed_samples_are_recovered_by_a_later_cumulative_prefix() {
        let baseline = NasUplinkTotals::default();
        let mut reporter = Reporter::new(baseline);
        reporter.ready(&ready(Uuid::new_v4()));
        let first = sample(reporter.heartbeat(active(10)));
        let _lost = sample(reporter.heartbeat(active(20)));
        let third = sample(reporter.heartbeat(active(30)));
        assert_eq!(third.seq, 3);
        assert_eq!(
            third
                .totals
                .checked_delta(&first.totals)
                .unwrap()
                .body_bytes,
            20
        );
    }

    #[test]
    fn invalid_counters_and_sequence_exhaustion_do_not_break_heartbeat() {
        let mut reporter = Reporter::new(NasUplinkTotals::default());
        reporter.ready(&ready(Uuid::new_v4()));
        assert_eq!(sample(reporter.heartbeat(active(10))).seq, 1);
        assert_eq!(reporter.heartbeat(active(9)), json!({"type":"HEARTBEAT"}));
        assert_eq!(
            reporter.heartbeat(active(NAS_METRIC_MAX_COUNTER + 1)),
            json!({"type":"HEARTBEAT"})
        );
        assert_eq!(sample(reporter.heartbeat(active(11))).seq, 2);
        reporter.sequence = u32::MAX - 1;
        assert_eq!(sample(reporter.heartbeat(active(12))).seq, u32::MAX);
        assert_eq!(reporter.heartbeat(active(13)), json!({"type":"HEARTBEAT"}));
        assert_eq!(reporter.sequence, u32::MAX);
    }

    #[test]
    fn reconnect_baseline_never_recounts_an_old_prefix() {
        let mut first = Reporter::new(NasUplinkTotals::default());
        let first_connection = Uuid::new_v4();
        first.ready(&ready(first_connection));
        let accepted = sample(first.heartbeat(active(10)));
        // Five more locally measured bytes were never sent before disconnect.
        let baseline = active(15);
        let mut reconnected = Reporter::new(baseline);
        let new_connection = Uuid::new_v4();
        reconnected.ready(&ready(new_connection));
        let new = sample(reconnected.heartbeat(active(20)));
        assert_eq!(new.seq, 1);
        assert_ne!(new.connection_id, accepted.connection_id);
        assert_eq!(new.totals.checked_delta(&baseline).unwrap().body_bytes, 5);
    }

    #[test]
    fn maximum_valid_envelope_is_bounded_and_has_only_fixed_fields() {
        let outcome = NasUplinkOutcomeTotals {
            transfers: NAS_METRIC_MAX_COUNTER / 3,
            bytes: NAS_METRIC_MAX_COUNTER / 3,
            duration_us: NAS_METRIC_MAX_COUNTER,
            duration_buckets: [NAS_METRIC_MAX_COUNTER / 3; 9],
        };
        let totals = NasUplinkTotals {
            admitted: NAS_METRIC_MAX_COUNTER,
            active: (NAS_METRIC_MAX_COUNTER % 3) as u32,
            dropped: NAS_METRIC_MAX_COUNTER,
            body_seen: true,
            body_bytes: NAS_METRIC_MAX_COUNTER,
            complete: outcome,
            failed: outcome,
            cancelled: outcome,
        };
        assert!(totals.valid());
        let mut reporter = Reporter::new(NasUplinkTotals::default());
        reporter.ready(&ready(Uuid::new_v4()));
        let message = reporter.heartbeat(totals);
        assert!(serde_json::to_vec(&message).unwrap().len() <= TRANSPORT_METRICS_MAX_BYTES);
        assert_eq!(sample(message).totals, totals);
        let mut invalid_baseline = totals;
        invalid_baseline.active = 17;
        let mut disabled = Reporter::new(invalid_baseline);
        assert!(disabled.hello().get("uplink_metrics_version").is_none());
        disabled.ready(&ready(Uuid::new_v4()));
        assert!(!disabled.is_ready());
        assert_eq!(disabled.heartbeat(totals), json!({"type":"HEARTBEAT"}));
    }
}
