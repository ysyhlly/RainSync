//! Worker-local exposition behind the existing RainSync administrator session.
use crate::App;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use media_core::runtime_metrics::Process;
use sha2::{Digest, Sha256};
use sqlx::{Connection, PgPool, Postgres, pool::PoolConnection};
use std::fmt::Write;
use std::time::Duration;

const AUTH_DEADLINE: Duration = Duration::from_secs(3);
const MAX_COOKIE_BYTES: usize = 8192;
static SCRAPES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);

// Keep ownership outside the borrowed transaction. A cancelled SQLx transaction
// queues a rollback; returning that connection normally would wait for its reply
// and the pool's ping without a deadline. Discard it unless rollback completed.
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
                // Current Server sessions are 32-byte lowercase hex tokens.
                // Ambiguous duplicates fail closed rather than choosing one.
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
    Some(hex::encode(Sha256::digest(token?.as_bytes())))
}
async fn authorize(db: &PgPool, hash: String) -> Result<(), StatusCode> {
    let admin = tokio::time::timeout(AUTH_DEADLINE, async {
        let mut owned = MetricsConnection {
            connection: db.acquire().await?,
            reusable: false,
        };
        let mut tx = owned.connection.begin().await?;
        sqlx::query("SET TRANSACTION READ ONLY").execute(&mut *tx).await?;
        // Transaction-local deadlines cannot leak into another pool borrower.
        // The connection guard also covers cancellation while BEGIN, timeout
        // setup, authorization, or rollback is waiting for a database reply.
        sqlx::query("SELECT set_config('statement_timeout','1000ms',true), set_config('lock_timeout','500ms',true)").execute(&mut *tx).await?;
        let admin: Option<bool> = sqlx::query_scalar("SELECT u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp()")
            .bind(hash).fetch_optional(&mut *tx).await?;
        tx.rollback().await?;
        owned.reusable = true;
        Ok::<_, sqlx::Error>(admin)
    }).await.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    match admin {
        Some(true) => Ok(()),
        Some(false) => Err(StatusCode::FORBIDDEN),
        None => Err(StatusCode::UNAUTHORIZED),
    }
}
fn denied(status: StatusCode) -> Response {
    let reason = match status {
        StatusCode::UNAUTHORIZED => "login_required",
        StatusCode::FORBIDDEN => "admin_required",
        _ => "metrics_unavailable",
    };
    (status, [(header::CACHE_CONTROL, "no-store")], reason).into_response()
}

fn append_observations(
    output: &mut String,
    owners: Option<media_core::child_process::OwnerSnapshot>,
    inventory: Option<crate::readiness::CacheInventorySnapshot>,
) {
    for (name, help) in [
        (
            "rainsync_process_owner_observation_available",
            "Whether the process owner registry was available without waiting.",
        ),
        (
            "rainsync_owned_process_tree_owners",
            "Registered process-tree owners, not a physical process count or drain receipt.",
        ),
        (
            "rainsync_process_admission_closed",
            "Whether process admission is closed.",
        ),
        (
            "rainsync_process_cleanup_failed",
            "Whether the owner registry retained a cleanup failure; zero owners is not a successful drain receipt.",
        ),
        (
            "rainsync_cache_inventory_available",
            "Whether a fresh successful cache traversal observation is available.",
        ),
        (
            "rainsync_cache_regular_files",
            "Regular-file entries observed by the bounded readiness scan, excluding symlinks and its probe file; not an atomic inventory.",
        ),
        (
            "rainsync_cache_logical_bytes",
            "Logical regular-file lengths observed by the bounded readiness scan; not allocated disk bytes or an atomic inventory.",
        ),
        (
            "rainsync_cache_inventory_age_seconds",
            "Monotonic age of the fresh successful cache traversal observation.",
        ),
    ] {
        writeln!(output, "# HELP {name} {help}\n# TYPE {name} gauge").unwrap();
    }
    writeln!(
        output,
        "rainsync_process_owner_observation_available{{process=\"worker\"}} {}",
        u8::from(owners.is_some())
    )
    .unwrap();
    if let Some(owners) = owners {
        writeln!(
            output,
            "rainsync_owned_process_tree_owners{{process=\"worker\"}} {}",
            owners.active_owners
        )
        .unwrap();
        writeln!(
            output,
            "rainsync_process_admission_closed{{process=\"worker\"}} {}",
            u8::from(owners.admission_closed)
        )
        .unwrap();
        writeln!(
            output,
            "rainsync_process_cleanup_failed{{process=\"worker\"}} {}",
            u8::from(owners.cleanup_failed)
        )
        .unwrap();
    }
    writeln!(
        output,
        "rainsync_cache_inventory_available{{process=\"worker\"}} {}",
        u8::from(inventory.is_some())
    )
    .unwrap();
    if let Some(inventory) = inventory {
        writeln!(
            output,
            "rainsync_cache_regular_files{{process=\"worker\"}} {}",
            inventory.regular_files
        )
        .unwrap();
        writeln!(
            output,
            "rainsync_cache_logical_bytes{{process=\"worker\"}} {}",
            inventory.logical_bytes
        )
        .unwrap();
        writeln!(
            output,
            "rainsync_cache_inventory_age_seconds{{process=\"worker\"}} {}",
            inventory.age.as_secs_f64()
        )
        .unwrap();
    }
}

pub async fn endpoint(State(app): State<App>, headers: HeaderMap) -> Response {
    let Some(hash) = session_hash(&headers) else {
        return denied(StatusCode::UNAUTHORIZED);
    };
    // Keep concurrent database waits and exposition allocations bounded too.
    let Ok(_permit) = SCRAPES.try_acquire() else {
        return denied(StatusCode::SERVICE_UNAVAILABLE);
    };
    if let Err(status) = authorize(&app.db, hash).await {
        return denied(status);
    }
    let mut output = app.metrics.render_for(Process::Worker);
    append_observations(
        &mut output,
        media_core::child_process::owner_snapshot(),
        app.readiness.cache_inventory(),
    );
    (
        [
            (
                header::CONTENT_TYPE,
                "text/plain; version=0.0.4; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        output,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unavailable_observations_omit_counts_instead_of_exporting_zero() {
        let mut output = String::new();
        append_observations(&mut output, None, None);
        let samples: Vec<_> = output
            .lines()
            .filter(|line| !line.starts_with('#'))
            .collect();
        assert_eq!(
            samples,
            [
                "rainsync_process_owner_observation_available{process=\"worker\"} 0",
                "rainsync_cache_inventory_available{process=\"worker\"} 0",
            ]
        );
    }
    #[test]
    fn successful_empty_inventory_and_owner_failure_are_independent_fixed_gauges() {
        let mut output = String::new();
        append_observations(
            &mut output,
            Some(media_core::child_process::OwnerSnapshot {
                active_owners: 0,
                admission_closed: true,
                cleanup_failed: true,
            }),
            Some(crate::readiness::CacheInventorySnapshot {
                regular_files: 0,
                logical_bytes: 0,
                age: Duration::from_millis(1250),
            }),
        );
        for sample in [
            "rainsync_process_owner_observation_available{process=\"worker\"} 1",
            "rainsync_owned_process_tree_owners{process=\"worker\"} 0",
            "rainsync_process_admission_closed{process=\"worker\"} 1",
            "rainsync_process_cleanup_failed{process=\"worker\"} 1",
            "rainsync_cache_inventory_available{process=\"worker\"} 1",
            "rainsync_cache_regular_files{process=\"worker\"} 0",
            "rainsync_cache_logical_bytes{process=\"worker\"} 0",
            "rainsync_cache_inventory_age_seconds{process=\"worker\"} 1.25",
        ] {
            assert!(
                output.lines().any(|line| line == sample),
                "missing {sample}"
            );
        }
        assert_eq!(
            output
                .lines()
                .filter(|line| line.starts_with("# TYPE ") && line.ends_with(" gauge"))
                .count(),
            8
        );
        assert!(output.len() < 4096);
    }
    #[test]
    fn nonzero_inventory_exports_observed_values_without_identity_labels() {
        let mut output = String::new();
        append_observations(
            &mut output,
            Some(media_core::child_process::OwnerSnapshot {
                active_owners: 7,
                admission_closed: false,
                cleanup_failed: false,
            }),
            Some(crate::readiness::CacheInventorySnapshot {
                regular_files: 11,
                logical_bytes: 2048,
                age: Duration::ZERO,
            }),
        );
        for sample in [
            "rainsync_owned_process_tree_owners{process=\"worker\"} 7",
            "rainsync_cache_regular_files{process=\"worker\"} 11",
            "rainsync_cache_logical_bytes{process=\"worker\"} 2048",
        ] {
            assert!(
                output.lines().any(|line| line == sample),
                "missing {sample}"
            );
        }
        assert!(
            output
                .lines()
                .filter(|line| !line.starts_with('#'))
                .all(|line| line
                    .split_once('{')
                    .unwrap()
                    .1
                    .starts_with("process=\"worker\"} "))
        );
    }
    #[test]
    fn worker_cookie_boundaries_and_ambiguous_tokens_fail_closed() {
        let mut headers = HeaderMap::new();
        assert!(session_hash(&headers).is_none());
        headers.insert(header::AUTHORIZATION, "Bearer fixture".parse().unwrap());
        assert!(session_hash(&headers).is_none());
        let cookie = format!("other=value; rainsync_session={}", "a".repeat(64));
        headers.insert(header::COOKIE, cookie.parse().unwrap());
        assert_eq!(
            session_hash(&headers).unwrap(),
            hex::encode(Sha256::digest("a".repeat(64).as_bytes()))
        );
        headers.append(header::COOKIE, cookie.parse().unwrap());
        assert!(session_hash(&headers).is_none());
        headers.remove(header::COOKIE);
        for value in [
            "x".repeat(64),
            "a".repeat(63),
            format!("{}; other={}", "a".repeat(64), "x".repeat(MAX_COOKIE_BYTES)),
        ] {
            headers.insert(
                header::COOKIE,
                format!("rainsync_session={value}").parse().unwrap(),
            );
            assert!(session_hash(&headers).is_none());
        }
    }
}
