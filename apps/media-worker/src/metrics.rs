//! Worker-local exposition behind the existing RainSync administrator session.
use crate::App;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use media_core::runtime_metrics::Process;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::time::Duration;

const AUTH_DEADLINE: Duration = Duration::from_secs(3);
const MAX_COOKIE_BYTES: usize = 8192;

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
async fn authorize(db: &PgPool, headers: &HeaderMap) -> Result<(), StatusCode> {
    let hash = session_hash(headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let admin = tokio::time::timeout(AUTH_DEADLINE, async {
        let mut tx = db.begin().await?;
        sqlx::query("SET TRANSACTION READ ONLY").execute(&mut *tx).await?;
        // Transaction-local deadlines cannot leak into another pool borrower.
        // On HTTP cancellation SQLx drops/rolls back the transaction; this DB
        // statement deadline also bounds a query still executing after Drop.
        sqlx::query("SELECT set_config('statement_timeout','1000ms',true), set_config('lock_timeout','500ms',true)").execute(&mut *tx).await?;
        let admin: Option<bool> = sqlx::query_scalar("SELECT u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp()")
            .bind(hash).fetch_optional(&mut *tx).await?;
        tx.rollback().await?;
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
    if let Err(status) = authorize(&app.db, &headers).await {
        return denied(status);
    }
    (
        [
            (
                header::CONTENT_TYPE,
                "text/plain; version=0.0.4; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        app.metrics.render_for(Process::Worker),
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
