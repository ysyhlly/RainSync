use super::*;
use std::sync::Mutex;
#[path = "runtime_metrics.rs"]
pub mod runtime;

#[derive(Default)]
struct ClientSnapshot {
    samples: u64,
    buffering: u64,
    drift_sum: u64,
    steady: u64,
    buckets: [u64; 4],
}
#[derive(Default)]
pub struct Metrics {
    client: Mutex<ClientSnapshot>,
    pub runtime: runtime::RuntimeMetrics,
}
impl Metrics {
    pub fn report(&self, value: &Value) {
        let mut state = self.client.lock().unwrap_or_else(|e| e.into_inner());
        state.samples = state.samples.saturating_add(1);
        if value["buffering"].as_bool().unwrap_or(false) {
            state.buffering = state.buffering.saturating_add(1);
            return;
        }
        if let Some(drift) = value["drift_ms"]
            .as_f64()
            .filter(|v| v.is_finite() && v.abs() <= 3_600_000.0)
        {
            let drift = drift.abs() as u64;
            state.steady = state.steady.saturating_add(1);
            state.drift_sum = state.drift_sum.saturating_add(drift);
            for (i, bound) in [150, 300, 800, 2000].iter().enumerate() {
                if drift <= *bound {
                    state.buckets[i] = state.buckets[i].saturating_add(1);
                }
            }
        }
    }
    fn render(&self) -> String {
        let state = self.client.lock().unwrap_or_else(|e| e.into_inner());
        let mut s = format!(
            "# HELP rainsync_client_samples_total Untrusted CLIENT_STATUS messages received, including retries; not unique playback observations.\n# TYPE rainsync_client_samples_total counter\nrainsync_client_samples_total {}\n# HELP rainsync_buffering_samples_total Untrusted buffering sample count, not stall duration.\n# TYPE rainsync_buffering_samples_total counter\nrainsync_buffering_samples_total {}\n# HELP rainsync_sync_error_ms Client-reported absolute drift in milliseconds, not independently measured synchronization error.\n# TYPE rainsync_sync_error_ms histogram\n",
            state.samples, state.buffering
        );
        for (i, b) in [150, 300, 800, 2000].iter().enumerate() {
            s += &format!(
                "rainsync_sync_error_ms_bucket{{le=\"{b}\"}} {}\n",
                state.buckets[i]
            );
        }
        s += &format!(
            "rainsync_sync_error_ms_bucket{{le=\"+Inf\"}} {}\nrainsync_sync_error_ms_count {}\nrainsync_sync_error_ms_sum {}\n",
            state.steady, state.steady, state.drift_sum
        );
        drop(state);
        s.push_str(&self.runtime.render());
        s
    }
}
pub async fn endpoint(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    admin(&auth(&app, &h, false).await?)?;
    let mut text = app.metrics.render();
    let (actors, connections, queue_total, queue_max) = {
        let rooms = app.rooms.lock().await;
        let (mut connections, mut queue_total, mut queue_max) = (0usize, 0usize, 0usize);
        for handle in rooms.values() {
            connections = connections.saturating_add(handle.connected_receivers());
            let depth = handle.command_queue_depth();
            queue_total = queue_total.saturating_add(depth);
            queue_max = queue_max.max(depth);
        }
        (rooms.len(), connections, queue_total, queue_max)
    };
    text += &format!(
        "# TYPE rainsync_room_actors gauge\nrainsync_room_actors {actors}\n# TYPE rainsync_control_connections gauge\nrainsync_control_connections {connections}\n# TYPE rainsync_control_queue_depth gauge\nrainsync_control_queue_depth {queue_total}\n# TYPE rainsync_control_queue_max_depth gauge\nrainsync_control_queue_max_depth {queue_max}\n# TYPE rainsync_db_pool_connections gauge\nrainsync_db_pool_connections {}\n# TYPE rainsync_db_pool_idle_connections gauge\nrainsync_db_pool_idle_connections {}\n",
        app.db.size(),
        app.db.num_idle()
    );
    let rooms: i64 = sqlx::query_scalar("SELECT count(*) FROM rooms")
        .fetch_one(&app.db)
        .await?;
    let queued: i64 = sqlx::query_scalar("SELECT count(*) FROM media_jobs WHERE status='queued'")
        .fetch_one(&app.db)
        .await?;
    text += &format!(
        "# TYPE rainsync_rooms gauge\nrainsync_rooms {rooms}\n# TYPE rainsync_media_jobs_queued gauge\nrainsync_media_jobs_queued {queued}\n"
    );
    Ok(([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], text).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn client_values_are_bounded_and_explicitly_untrusted() {
        let metrics = Metrics::default();
        for value in [
            json!({"drift_ms": -12.0}),
            json!({"drift_ms": 3_600_001}),
            json!({"drift_ms": "NaN"}),
            json!({"drift_ms": null}),
            json!({"drift_ms": f64::INFINITY}),
            json!({"drift_ms": f64::NAN}),
        ] {
            metrics.report(&value);
        }
        let text = metrics.render();
        assert!(text.contains("rainsync_client_samples_total 6\n"));
        assert!(text.contains("rainsync_sync_error_ms_count 1\n"));
        assert!(text.contains("rainsync_sync_error_ms_sum 12\n"));
        assert!(text.contains("not independently measured"));
        assert!(!text.contains("rainsync_transfer_bytes_total"));
    }
    #[test]
    fn repeated_legacy_messages_count_messages_not_unique_observations() {
        let metrics = Metrics::default();
        for _ in 0..2 {
            metrics.report(&json!({"buffering": true, "drift_ms": 900}));
        }
        let text = metrics.render();
        assert!(text.contains("rainsync_buffering_samples_total 2\n"));
        assert!(text.contains("rainsync_sync_error_ms_count 0\n"));
        assert!(text.contains("including retries"));
    }
    #[test]
    fn actual_runtime_hook_is_included_in_server_render() {
        let metrics = Metrics::default();
        metrics.runtime.cache_lookup(runtime::CacheDecision::Hit);
        assert!(metrics
            .render()
            .contains("rainsync_cache_lookups_total{result=\"hit\"} 1\n"));
    }
}
