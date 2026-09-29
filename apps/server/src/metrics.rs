use super::*;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
#[derive(Default)]
pub struct Metrics {
    samples: AtomicU64,
    buffering: AtomicU64,
    drift_sum: AtomicU64,
    steady: AtomicU64,
    buckets: [AtomicU64; 4],
}
impl Metrics {
    pub fn report(&self, value: &Value) {
        self.samples.fetch_add(1, Relaxed);
        if value["buffering"].as_bool().unwrap_or(false) {
            self.buffering.fetch_add(1, Relaxed);
            return;
        }
        if let Some(drift) = value["drift_ms"]
            .as_f64()
            .filter(|v| v.is_finite() && v.abs() <= 3600000.0)
        {
            let drift = drift.abs() as u64;
            self.steady.fetch_add(1, Relaxed);
            self.drift_sum.fetch_add(drift, Relaxed);
            for (i, bound) in [150, 300, 800, 2000].iter().enumerate() {
                if drift <= *bound {
                    self.buckets[i].fetch_add(1, Relaxed);
                }
            }
        }
    }
    fn render(&self) -> String {
        let mut s = format!(
            "# TYPE rainsync_client_samples_total counter\nrainsync_client_samples_total {}\n# TYPE rainsync_buffering_samples_total counter\nrainsync_buffering_samples_total {}\n# TYPE rainsync_sync_error_ms histogram\n",
            self.samples.load(Relaxed),
            self.buffering.load(Relaxed)
        );
        for (i, b) in [150, 300, 800, 2000].iter().enumerate() {
            s += &format!(
                "rainsync_sync_error_ms_bucket{{le=\"{b}\"}} {}\n",
                self.buckets[i].load(Relaxed)
            );
        }
        s += &format!(
            "rainsync_sync_error_ms_bucket{{le=\"+Inf\"}} {}\nrainsync_sync_error_ms_count {}\nrainsync_sync_error_ms_sum {}\n",
            self.steady.load(Relaxed),
            self.steady.load(Relaxed),
            self.drift_sum.load(Relaxed)
        );
        s
    }
}
pub async fn endpoint(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    admin(&auth(&app, &h, false).await?)?;
    let mut text = app.metrics.render();
    let (actors, connections, queue_total, queue_max) = {
        let rooms = app.rooms.lock().await;
        (
            rooms.len(),
            rooms
                .values()
                .map(|h| h.connected_receivers())
                .sum::<usize>(),
            rooms
                .values()
                .map(|h| h.command_queue_depth())
                .sum::<usize>(),
            rooms
                .values()
                .map(|h| h.command_queue_depth())
                .max()
                .unwrap_or(0),
        )
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
