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
