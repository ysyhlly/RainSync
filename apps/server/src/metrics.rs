use super::*;
pub use media_core::runtime_metrics as runtime;
use sqlx::{Connection, Postgres, pool::PoolConnection};
use std::{sync::Mutex, time::Duration};

const SCRAPE_DEADLINE: Duration = Duration::from_secs(3);
const MAX_COOKIE_BYTES: usize = 8192;
static SCRAPES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);

// Own the connection independently of the borrowed transaction so cancellation
// cannot return it to SQLx's unbounded rollback/ping path. Only a completed
// rollback makes this connection safe to reuse.
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

fn session_hash(headers: &HeaderMap) -> Option<String> {
    let mut length = 0usize;
    let mut token = None;
    for cookie in headers.get_all(header::COOKIE) {
        length = length.checked_add(cookie.as_bytes().len())?;
        if length > MAX_COOKIE_BYTES {
            return None;
        }
        for part in cookie.to_str().ok()?.split(';') {
            if let Some(value) = part.trim().strip_prefix("rainsync_session=") {
                if token.is_some()
                    || value.len() != 64
                    || !value.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return None;
                }
                token = Some(value);
            }
        }
    }
    Some(hash(token?))
}

async fn database_snapshot(
    db: &PgPool,
    hash: String,
    deadline: tokio::time::Instant,
) -> Result<(i64, i64)> {
    let (admin, rooms, queued) = tokio::time::timeout_at(deadline, async {
        let mut owned = MetricsConnection {
            connection: db.acquire().await?,
            reusable: false,
        };
        let mut tx = owned.connection.begin().await?;
        sqlx::query("SET TRANSACTION READ ONLY").execute(&mut *tx).await?;
        // Limits are local to this transaction and cover every scrape query.
        sqlx::query("SELECT set_config('statement_timeout','1000ms',true), set_config('lock_timeout','500ms',true)").execute(&mut *tx).await?;
        let admin: Option<bool> = sqlx::query_scalar("SELECT u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp()")
            .bind(hash).fetch_optional(&mut *tx).await?;
        let (rooms, queued) = if admin == Some(true) {
            let rooms: i64 = sqlx::query_scalar("SELECT count(*) FROM rooms")
                .fetch_one(&mut *tx)
                .await?;
            let queued: i64 = sqlx::query_scalar("SELECT count(*) FROM media_jobs WHERE status='queued'")
                .fetch_one(&mut *tx)
                .await?;
            (rooms, queued)
        } else {
            (0, 0)
        };
        tx.rollback().await?;
        owned.reusable = true;
        Ok::<_, sqlx::Error>((admin, rooms, queued))
    })
    .await
    .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "metrics_unavailable"))?
    .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "metrics_unavailable"))?;
    match admin {
        Some(true) => Ok((rooms, queued)),
        Some(false) => Err(err(StatusCode::FORBIDDEN, "admin_required")),
        None => Err(err(StatusCode::UNAUTHORIZED, "session_expired")),
    }
}

fn denied(error: Error) -> Response {
    let mut response = error.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

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
        s.push_str(&self.runtime.render_for(runtime::Process::Server));
        s
    }
}
pub async fn endpoint(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    let Some(hash) = session_hash(&h) else {
        return Ok(denied(err(StatusCode::UNAUTHORIZED, "login_required")));
    };
    let Ok(_permit) = SCRAPES.try_acquire() else {
        return Ok(denied(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "metrics_unavailable",
        )));
    };
    let deadline = tokio::time::Instant::now() + SCRAPE_DEADLINE;
    let (rooms, queued) = match database_snapshot(&app.db, hash, deadline).await {
        Ok(snapshot) => snapshot,
        Err(error) => return Ok(denied(error)),
    };
    let (actors, connections, queue_total, queue_max) = {
        let rooms = match tokio::time::timeout_at(deadline, app.rooms.lock()).await {
            Ok(rooms) => rooms,
            Err(_) => {
                return Ok(denied(err(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "metrics_unavailable",
                )));
            }
        };
        let (mut connections, mut queue_total, mut queue_max) = (0usize, 0usize, 0usize);
        for handle in rooms.values() {
            connections = connections.saturating_add(handle.connected_receivers());
            let depth = handle.command_queue_depth();
            queue_total = queue_total.saturating_add(depth);
            queue_max = queue_max.max(depth);
        }
        (rooms.len(), connections, queue_total, queue_max)
    };
    let mut text = app.metrics.render();
    text += &format!(
        "# TYPE rainsync_room_actors gauge\nrainsync_room_actors {actors}\n# TYPE rainsync_control_connections gauge\nrainsync_control_connections {connections}\n# TYPE rainsync_control_queue_depth gauge\nrainsync_control_queue_depth {queue_total}\n# TYPE rainsync_control_queue_max_depth gauge\nrainsync_control_queue_max_depth {queue_max}\n# TYPE rainsync_db_pool_connections gauge\nrainsync_db_pool_connections {}\n# TYPE rainsync_db_pool_idle_connections gauge\nrainsync_db_pool_idle_connections {}\n",
        app.db.size(),
        app.db.num_idle()
    );
    text += &format!(
        "# TYPE rainsync_rooms gauge\nrainsync_rooms {rooms}\n# TYPE rainsync_media_jobs_queued gauge\nrainsync_media_jobs_queued {queued}\n"
    );
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "text/plain; version=0.0.4; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        text,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scrape_cookie_is_bounded_and_duplicate_sessions_fail_closed() {
        let mut headers = HeaderMap::new();
        assert!(session_hash(&headers).is_none());
        headers.insert(header::AUTHORIZATION, "Bearer fixture".parse().unwrap());
        assert!(session_hash(&headers).is_none());
        let cookie = format!("other=value; rainsync_session={}", "a".repeat(64));
        headers.insert(header::COOKIE, cookie.parse().unwrap());
        assert_eq!(session_hash(&headers), Some(hash(&"a".repeat(64))));
        headers.append(header::COOKIE, cookie.parse().unwrap());
        assert!(session_hash(&headers).is_none());
        headers.remove(header::COOKIE);
        headers.insert(
            header::COOKIE,
            format!(
                "rainsync_session={}; other={}",
                "a".repeat(64),
                "x".repeat(MAX_COOKIE_BYTES)
            )
            .parse()
            .unwrap(),
        );
        assert!(session_hash(&headers).is_none());
    }
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
        assert!(
            metrics
                .render()
                .contains("rainsync_cache_lookups_total{result=\"hit\",process=\"server\"} 1\n")
        );
    }
}
