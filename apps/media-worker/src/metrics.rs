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
use std::time::Duration;

#[path = "metrics/observations.rs"]
mod observations;
use observations::append_observations;

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
    output.push_str(&media_core::job_health::render(Process::Worker));
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
