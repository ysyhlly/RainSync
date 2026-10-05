//! Optional, untrusted NAS uplink reports on the ordinary Agent control socket.
//! No telemetry path grants dispatch, drain, heartbeat or receipt authority.
use crate::App;
use media_core::runtime_metrics::{RuntimeMetrics, TransportMetricDrop};
use protocol::{
    NasUplinkDelta, NasUplinkMetricsSample, NasUplinkTotals, TRANSPORT_METRICS_MAX_BYTES,
    TRANSPORT_METRICS_VERSION,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Connection, Postgres, pool::PoolConnection};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    sync::{Semaphore, SemaphorePermit},
    task::JoinSet,
};
use uuid::Uuid;

const MIN_REPORT_INTERVAL: Duration = Duration::from_secs(1);
const DATABASE_DEADLINE: Duration = Duration::from_secs(2);
const MAX_SESSIONS: usize = 1024;
const MAX_PENDING: usize = 32;
static SESSIONS: Semaphore = Semaphore::const_new(MAX_SESSIONS);
static PENDING: Semaphore = Semaphore::const_new(MAX_PENDING);
static DATABASE: Semaphore = Semaphore::const_new(2);

#[derive(Deserialize)]
enum HelloType {
    #[serde(rename = "HELLO")]
    Hello,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    #[serde(rename = "type")]
    _kind: HelloType,
    #[serde(default, rename = "manual_scan")]
    _manual_scan: Option<bool>,
    #[serde(default, rename = "source_versions")]
    _source_versions: Option<bool>,
    #[serde(default, rename = "drain_receipts")]
    _drain_receipts: Option<bool>,
    #[serde(default, rename = "advanced_assets_version")]
    _advanced_assets_version: Option<u8>,
    #[serde(default)]
    uplink_metrics_version: Option<u8>,
    #[serde(default)]
    uplink_metrics_baseline: Option<NasUplinkTotals>,
}
#[derive(Deserialize)]
enum HeartbeatType {
    #[serde(rename = "HEARTBEAT")]
    Heartbeat,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Heartbeat {
    #[serde(rename = "type")]
    _kind: HeartbeatType,
    uplink_metrics: NasUplinkMetricsSample,
}

// The checkout outlives its borrowed transaction. Cancellation closes it rather
// than returning an unfinished query/rollback to the shared pool.
struct MetricsConnection {
    connection: PoolConnection<Postgres>,
    reusable: bool,
}
impl Drop for MetricsConnection {
    fn drop(&mut self) {
        if !self.reusable {
            self.connection.close_on_drop();
        }
    }
}

#[derive(Clone, Copy)]
struct Cursor {
    connection: Uuid,
    sequence: u32,
    totals: NasUplinkTotals,
}
impl Cursor {
    fn prepare(
        &self,
        sample: &NasUplinkMetricsSample,
    ) -> Result<Option<NasUplinkDelta>, TransportMetricDrop> {
        if !sample.valid() {
            return Err(TransportMetricDrop::Invalid);
        }
        if sample.connection_id != self.connection || sample.seq < self.sequence {
            return Err(TransportMetricDrop::Stale);
        }
        if sample.seq == self.sequence {
            return if sample.totals == self.totals {
                Ok(None)
            } else {
                Err(TransportMetricDrop::Invalid)
            };
        }
        sample
            .totals
            .checked_delta(&self.totals)
            .filter(NasUplinkDelta::valid)
            .map(Some)
            .ok_or(TransportMetricDrop::Invalid)
    }

    // Call only with the current Agent row SHARE lock and control mutex held.
    // Both aggregate credit and cursor advance are synchronous, so cancelling
    // the later read-only transaction cleanup cannot recount this prefix.
    fn credit(
        &mut self,
        sample: &NasUplinkMetricsSample,
        runtime: &RuntimeMetrics,
    ) -> Result<(), TransportMetricDrop> {
        if let Some(delta) = self.prepare(sample)?
            && runtime.agent_nas_sample(&delta)
        {
            self.sequence = sample.seq;
            self.totals = sample.totals;
        }
        // The collector records its own overflow/invalid drop on rejection.
        Ok(())
    }
}

pub struct Receiver {
    runtime: RuntimeMetrics,
    agent: Uuid,
    connection: Uuid,
    token_hash: String,
    hello_seen: bool,
    session: Option<SemaphorePermit<'static>>,
    cursor: Option<Arc<Mutex<Cursor>>>,
    attempted: Option<Instant>,
    pending: Option<NasUplinkMetricsSample>,
    tasks: JoinSet<()>,
}
impl Receiver {
    pub fn new(runtime: RuntimeMetrics, agent: Uuid, connection: Uuid, token_hash: String) -> Self {
        Self {
            runtime,
            agent,
            connection,
            token_hash,
            hello_seen: false,
            session: None,
            cursor: None,
            attempted: None,
            pending: None,
            tasks: JoinSet::new(),
        }
    }

    /// Called once per ordinary HELLO, only for the current control connection.
    /// Ordinary capabilities are still handled by the existing permissive path.
    pub fn hello(&mut self, text: &str, ordinary: &Value) -> Option<Value> {
        if self.hello_seen {
            return None;
        }
        self.hello_seen = true;
        if ordinary.get("uplink_metrics_version").is_none()
            && ordinary.get("uplink_metrics_baseline").is_none()
        {
            return None;
        }
        let baseline = if text.len() <= TRANSPORT_METRICS_MAX_BYTES {
            serde_json::from_str::<Hello>(text).ok().and_then(|hello| {
                (hello.uplink_metrics_version == Some(TRANSPORT_METRICS_VERSION))
                    .then_some(hello.uplink_metrics_baseline)
                    .flatten()
                    .filter(NasUplinkTotals::valid)
            })
        } else {
            None
        };
        let Some(totals) = baseline else {
            self.runtime.agent_nas_dropped(TransportMetricDrop::Invalid);
            return None;
        };
        let Ok(permit) = SESSIONS.try_acquire() else {
            self.runtime
                .agent_nas_dropped(TransportMetricDrop::Capacity);
            return None;
        };
        self.session = Some(permit);
        self.cursor = Some(Arc::new(Mutex::new(Cursor {
            connection: self.connection,
            sequence: 0,
            totals,
        })));
        Some(
            json!({"type":"NAS_METRICS_READY", "version":TRANSPORT_METRICS_VERSION,
            "connection_id": self.connection}),
        )
    }

    /// Starts at most one socket-owned task after bounded admission. JoinSet
    /// drop aborts it, while its deadline remains independently polled during
    /// ordinary socket branches that await dispatch/index/network work.
    pub fn heartbeat(&mut self, app: &App, text: &str, ordinary: &Value) {
        if ordinary.get("uplink_metrics").is_none() {
            return;
        }
        if let Some((sample, cursor, permit)) = self.prepare(text, Instant::now()) {
            let app = app.clone();
            let agent = self.agent;
            let connection = self.connection;
            let token_hash = self.token_hash.clone();
            let runtime = self.runtime.clone();
            self.pending = Some(sample);
            self.tasks.spawn(async move {
                let _permit = permit;
                receive_report(
                    &app,
                    agent,
                    connection,
                    &token_hash,
                    &cursor,
                    &sample,
                    &runtime,
                )
                .await;
            });
        }
    }

    fn prepare(
        &mut self,
        text: &str,
        now: Instant,
    ) -> Option<(
        NasUplinkMetricsSample,
        Arc<Mutex<Cursor>>,
        SemaphorePermit<'static>,
    )> {
        if text.len() > TRANSPORT_METRICS_MAX_BYTES {
            self.runtime.agent_nas_dropped(TransportMetricDrop::Invalid);
            return None;
        }
        let sample = match serde_json::from_str::<Heartbeat>(text) {
            Ok(heartbeat) => heartbeat.uplink_metrics,
            Err(_) => {
                self.runtime.agent_nas_dropped(TransportMetricDrop::Invalid);
                return None;
            }
        };
        let Some(cursor) = self.cursor.as_ref() else {
            self.runtime.agent_nas_dropped(TransportMetricDrop::Stale);
            return None;
        };
        let disposition = cursor
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .prepare(&sample);
        match disposition {
            Ok(None) => return None,
            Err(reason) => {
                self.runtime.agent_nas_dropped(reason);
                return None;
            }
            Ok(Some(_)) => {}
        }
        if let Some(pending) = &self.pending {
            if sample == *pending {
                return None;
            }
            let reason = if sample.seq == pending.seq {
                TransportMetricDrop::Invalid
            } else if sample.seq < pending.seq {
                TransportMetricDrop::Stale
            } else {
                TransportMetricDrop::Capacity
            };
            self.runtime.agent_nas_dropped(reason);
            return None;
        }
        if self
            .attempted
            .is_some_and(|at| now.saturating_duration_since(at) < MIN_REPORT_INTERVAL)
        {
            self.runtime
                .agent_nas_dropped(TransportMetricDrop::RateLimited);
            return None;
        }
        self.attempted = Some(now);
        let Ok(permit) = PENDING.try_acquire() else {
            self.runtime
                .agent_nas_dropped(TransportMetricDrop::Capacity);
            return None;
        };
        Some((sample, Arc::clone(cursor), permit))
    }

    /// Join in the existing socket select. Cancelling this polling borrow
    /// retains ownership; dropping the receiver aborts its bounded task.
    pub async fn poll_pending(&mut self) {
        if self.pending.is_none() {
            std::future::pending::<()>().await;
        }
        if self
            .tasks
            .join_next()
            .await
            .is_some_and(|result| result.is_err())
        {
            self.runtime
                .agent_nas_dropped(TransportMetricDrop::Unavailable);
        }
        self.pending = None;
    }
}

async fn receive_report(
    app: &App,
    agent: Uuid,
    connection: Uuid,
    token_hash: &str,
    cursor: &Mutex<Cursor>,
    sample: &NasUplinkMetricsSample,
    runtime: &RuntimeMetrics,
) {
    let Ok(_permit) = DATABASE.try_acquire() else {
        runtime.agent_nas_dropped(TransportMetricDrop::Capacity);
        return;
    };
    let mut credited = false;
    let result = tokio::time::timeout(DATABASE_DEADLINE, async {
        let mut owned = MetricsConnection { connection: app.db.acquire().await
            .map_err(|_| TransportMetricDrop::Unavailable)?, reusable: false };
        let mut tx = owned.connection.begin().await.map_err(|_| TransportMetricDrop::Unavailable)?;
        // This transaction changes no durable data. READ ONLY itself cannot be
        // set because PostgreSQL forbids SELECT FOR SHARE in read-only mode.
        sqlx::query("SELECT set_config('statement_timeout','750ms',true),set_config('lock_timeout','350ms',true)")
            .execute(&mut *tx).await.map_err(|_| TransportMetricDrop::Unavailable)?;
        let current: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM agents WHERE id=$1 AND token_hash=$2 AND NOT revoked FOR SHARE")
            .bind(agent).bind(token_hash).fetch_optional(&mut *tx).await
            .map_err(|_| TransportMetricDrop::Unavailable)?;
        let outcome = if current == Some(agent) {
            let controls = app.agent_controls.lock().await;
            if controls.get(&agent).is_some_and(|control| control.connection == connection) {
                let mut cursor = cursor.lock().unwrap_or_else(|p| p.into_inner());
                let previous = cursor.sequence;
                let outcome = cursor.credit(sample, runtime);
                credited = cursor.sequence != previous;
                outcome
            } else { Err(TransportMetricDrop::Stale) }
        } else { Err(TransportMetricDrop::Unauthorized) };
        // No control or cursor lock survives cleanup; no WebSocket work occurs
        // anywhere in this future. A timeout after credit only closes checkout.
        tx.rollback().await.map_err(|_| TransportMetricDrop::Unavailable)?;
        owned.reusable = true;
        outcome
    }).await;
    if !credited {
        match result {
            Ok(Err(reason)) => runtime.agent_nas_dropped(reason),
            Err(_) => runtime.agent_nas_dropped(TransportMetricDrop::Unavailable),
            Ok(Ok(())) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_core::runtime_metrics::Process;
    use protocol::{NAS_METRIC_MAX_COUNTER, NasUplinkOutcomeTotals};

    fn active(bytes: u64) -> NasUplinkTotals {
        NasUplinkTotals {
            admitted: 1,
            active: 1,
            body_seen: true,
            body_bytes: bytes,
            ..Default::default()
        }
    }
    fn sample(connection: Uuid, seq: u32, totals: NasUplinkTotals) -> NasUplinkMetricsSample {
        NasUplinkMetricsSample {
            version: 1,
            connection_id: connection,
            seq,
            totals,
        }
    }
    fn hello(totals: NasUplinkTotals) -> String {
        json!({"type":"HELLO","manual_scan":true,"source_versions":true,"drain_receipts":true,
            "uplink_metrics_version":1,"uplink_metrics_baseline":totals})
        .to_string()
    }
    fn heartbeat(sample: NasUplinkMetricsSample) -> String {
        json!({"type":"HEARTBEAT","uplink_metrics":sample}).to_string()
    }
    fn receiver(connection: Uuid) -> Receiver {
        Receiver::new(
            RuntimeMetrics::default(),
            Uuid::new_v4(),
            connection,
            "fixed_hash".into(),
        )
    }
    fn negotiate(receiver: &mut Receiver, totals: NasUplinkTotals) -> Value {
        let text = hello(totals);
        receiver
            .hello(&text, &serde_json::from_str(&text).unwrap())
            .unwrap()
    }

    #[test]
    fn baseline_is_uncredited_and_repeated_hello_never_resets_a_prefix() {
        let connection = Uuid::new_v4();
        let mut receiver = receiver(connection);
        assert_eq!(
            negotiate(&mut receiver, active(10))["connection_id"],
            json!(connection)
        );
        assert!(
            !receiver
                .runtime
                .render_for(Process::Server)
                .contains("rainsync_agent_reported_nas_samples_total")
        );
        let cursor = receiver.cursor.as_ref().unwrap();
        cursor
            .lock()
            .unwrap()
            .credit(&sample(connection, 3, active(20)), &receiver.runtime)
            .unwrap();
        let text = hello(active(2));
        assert!(
            receiver
                .hello(&text, &serde_json::from_str(&text).unwrap())
                .is_none()
        );
        let cursor = receiver.cursor.as_ref().unwrap().lock().unwrap();
        assert_eq!(cursor.sequence, 3);
        assert_eq!(cursor.totals.body_bytes, 20);
    }

    #[test]
    fn reconnect_does_not_recount_prefix_and_terminal_bytes_may_span_baseline() {
        let connection = Uuid::new_v4();
        let mut cursor = Cursor {
            connection,
            sequence: 0,
            totals: active(15),
        };
        let mut terminal = active(20);
        terminal.active = 0;
        terminal.complete = NasUplinkOutcomeTotals {
            transfers: 1,
            bytes: 20,
            duration_us: 20,
            duration_buckets: [1; 9],
        };
        let delta = cursor
            .prepare(&sample(connection, 1, terminal))
            .unwrap()
            .unwrap();
        assert_eq!(delta.body_bytes, 5);
        assert_eq!(delta.complete.bytes, 20);
        cursor
            .credit(&sample(connection, 1, terminal), &RuntimeMetrics::default())
            .unwrap();
        assert!(
            cursor
                .prepare(&sample(connection, 1, terminal))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn sequence_payload_and_cumulative_validation_reject_recounts() {
        let connection = Uuid::new_v4();
        let runtime = RuntimeMetrics::default();
        let mut cursor = Cursor {
            connection,
            sequence: 0,
            totals: NasUplinkTotals::default(),
        };
        let accepted = sample(connection, 4, active(10));
        cursor.credit(&accepted, &runtime).unwrap();
        assert!(cursor.prepare(&accepted).unwrap().is_none());
        for invalid in [
            sample(connection, 0, active(10)),
            sample(connection, 3, active(10)),
            sample(connection, 4, active(11)),
            sample(connection, 5, active(9)),
            sample(Uuid::new_v4(), 5, active(20)),
        ] {
            assert!(cursor.prepare(&invalid).is_err());
        }
        assert_eq!(
            cursor
                .prepare(&sample(connection, 10, active(30)))
                .unwrap()
                .unwrap()
                .body_bytes,
            20
        );
        cursor
            .credit(&sample(connection, u32::MAX, active(30)), &runtime)
            .unwrap();
        assert!(cursor.prepare(&sample(connection, 1, active(31))).is_err());
        assert_eq!(cursor.sequence, u32::MAX);
    }

    #[test]
    fn raw_metric_envelopes_reject_duplicates_unknown_fields_and_oversize() {
        let baseline = hello(NasUplinkTotals::default());
        for invalid in [
            baseline.replacen(
                "\"uplink_metrics_version\":1",
                "\"uplink_metrics_version\":1,\"uplink_metrics_version\":1",
                1,
            ),
            baseline.replacen(
                "\"admitted\":0",
                "\"admitted\":0,\"identity\":\"private\"",
                1,
            ),
            baseline.replacen(
                "\"uplink_metrics_version\":1",
                "\"uplink_metrics_version\":2",
                1,
            ),
            format!("{}{}", baseline, " ".repeat(TRANSPORT_METRICS_MAX_BYTES)),
        ] {
            let mut receiver = receiver(Uuid::new_v4());
            assert!(
                receiver
                    .hello(&invalid, &serde_json::from_str(&invalid).unwrap())
                    .is_none()
            );
            assert!(receiver.cursor.is_none());
        }
        let connection = Uuid::new_v4();
        let mut receiver = receiver(connection);
        negotiate(&mut receiver, NasUplinkTotals::default());
        let text = heartbeat(sample(connection, 1, active(10)));
        for invalid in [
            text.replacen("\"seq\":1", "\"seq\":1,\"seq\":1", 1),
            text.replacen("\"version\":1", "\"version\":1,\"agent_id\":\"private\"", 1),
            text.replacen(
                "\"type\":\"HEARTBEAT\"",
                "\"type\":\"HEARTBEAT\",\"arbitrary\":true",
                1,
            ),
            format!("{}{}", text, " ".repeat(TRANSPORT_METRICS_MAX_BYTES)),
        ] {
            assert!(receiver.prepare(&invalid, Instant::now()).is_none());
        }
        assert!(receiver.prepare(&text, Instant::now()).is_some());
    }

    #[test]
    fn legacy_hello_and_failed_negotiation_keep_no_receiver_slot() {
        let mut receiver = receiver(Uuid::new_v4());
        let text = r#"{"type":"HELLO","manual_scan":true,"legacy_extra":7}"#;
        assert!(
            receiver
                .hello(text, &serde_json::from_str(text).unwrap())
                .is_none()
        );
        assert!(receiver.cursor.is_none());
        assert!(receiver.session.is_none());
        let text = hello(NasUplinkTotals::default());
        assert!(
            receiver
                .hello(&text, &serde_json::from_str(&text).unwrap())
                .is_none()
        );
    }

    #[tokio::test]
    async fn one_pending_report_and_rate_limit_bound_work_without_losing_later_prefix() {
        let connection = Uuid::new_v4();
        let mut receiver = receiver(connection);
        negotiate(&mut receiver, NasUplinkTotals::default());
        let now = Instant::now();
        let first = sample(connection, 1, active(10));
        let (_, _, permit) = receiver.prepare(&heartbeat(first), now).unwrap();
        receiver.pending = Some(first);
        receiver.tasks.spawn(async move {
            let _permit = permit;
            std::future::pending::<()>().await;
        });
        assert!(receiver.prepare(&heartbeat(first), now).is_none());
        assert!(
            receiver
                .prepare(&heartbeat(sample(connection, 1, active(11))), now)
                .is_none()
        );
        assert!(
            receiver
                .prepare(
                    &heartbeat(sample(connection, 3, active(30))),
                    now + MIN_REPORT_INTERVAL
                )
                .is_none()
        );
        receiver.tasks.abort_all();
        while receiver.tasks.join_next().await.is_some() {}
        receiver.pending = None;
        assert!(
            receiver
                .prepare(
                    &heartbeat(sample(connection, 3, active(30))),
                    now + Duration::from_millis(999)
                )
                .is_none()
        );
        let (new, cursor, _permit) = receiver
            .prepare(
                &heartbeat(sample(connection, 4, active(40))),
                now + MIN_REPORT_INTERVAL,
            )
            .unwrap();
        assert_eq!(
            cursor
                .lock()
                .unwrap()
                .prepare(&new)
                .unwrap()
                .unwrap()
                .body_bytes,
            40
        );
    }

    #[tokio::test]
    async fn polling_cancellation_retains_task_and_credit_survives_cleanup_cancellation() {
        let connection = Uuid::new_v4();
        let mut receiver = receiver(connection);
        negotiate(&mut receiver, NasUplinkTotals::default());
        let first = sample(connection, 1, active(10));
        let (_, cursor, permit) = receiver.prepare(&heartbeat(first), Instant::now()).unwrap();
        let runtime = receiver.runtime.clone();
        receiver.pending = Some(first);
        receiver.tasks.spawn(async move {
            let _permit = permit;
            cursor.lock().unwrap().credit(&first, &runtime).unwrap();
            // Represents transaction cleanup that never finishes after credit.
            std::future::pending::<()>().await;
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(1), receiver.poll_pending())
                .await
                .is_err()
        );
        assert!(receiver.pending.is_some());
        assert_eq!(receiver.tasks.len(), 1);
        let cursor = receiver.cursor.as_ref().unwrap().lock().unwrap();
        assert_eq!(cursor.sequence, 1);
        assert!(cursor.prepare(&first).unwrap().is_none());
        drop(cursor);
        receiver.pending = None;
        assert!(
            receiver
                .prepare(&heartbeat(first), Instant::now())
                .is_none()
        );
    }

    #[test]
    fn aggregate_overflow_never_wraps_or_advances_uncredited_highwater() {
        let connection = Uuid::new_v4();
        let runtime = RuntimeMetrics::default();
        let maximum = sample(connection, 1, active(NAS_METRIC_MAX_COUNTER));
        for _ in 0..(u64::MAX / NAS_METRIC_MAX_COUNTER) {
            let mut cursor = Cursor {
                connection,
                sequence: 0,
                totals: NasUplinkTotals::default(),
            };
            cursor.credit(&maximum, &runtime).unwrap();
            assert_eq!(cursor.sequence, 1);
        }
        let mut cursor = Cursor {
            connection,
            sequence: 0,
            totals: NasUplinkTotals::default(),
        };
        cursor.credit(&maximum, &runtime).unwrap();
        assert_eq!(cursor.sequence, 0);
        assert_eq!(cursor.totals, NasUplinkTotals::default());
        assert!(runtime.render_for(Process::Server).contains(
            "rainsync_agent_reported_nas_dropped_total{reason=\"overflow\",process=\"server\"} 1"
        ));
    }

    #[tokio::test]
    async fn task_deadline_progresses_during_socket_wait_and_receiver_drop_aborts() {
        let connection = Uuid::new_v4();
        let mut receiver = receiver(connection);
        let first = sample(connection, 1, active(10));
        receiver.pending = Some(first);
        let (complete, mut completed) = tokio::sync::oneshot::channel();
        receiver.tasks.spawn(async move {
            let timed_out =
                tokio::time::timeout(Duration::from_millis(1), std::future::pending::<()>())
                    .await
                    .is_err();
            let _ = complete.send(timed_out);
        });
        // An ordinary branch is awaiting; the join branch is not being polled.
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(completed.try_recv().unwrap());
        receiver.poll_pending().await;
        assert!(receiver.pending.is_none());
        assert!(receiver.tasks.is_empty());

        struct OnDrop(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for OnDrop {
            fn drop(&mut self) {
                let _ = self.0.take().unwrap().send(());
            }
        }
        let (cancelled, cancellation) = tokio::sync::oneshot::channel();
        receiver.pending = Some(first);
        receiver.tasks.spawn(async move {
            let _on_drop = OnDrop(Some(cancelled));
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;
        drop(receiver);
        tokio::time::timeout(Duration::from_secs(1), cancellation)
            .await
            .unwrap()
            .unwrap();
    }
}
