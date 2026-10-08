//! Caller-first administrative admission only. Never use for room-first writes.
use super::{Failure, RequestIdentity};
use crate::{Error, Result, media_authorization};
use axum::http::HeaderMap;
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

/// Owns exactly one transaction and its held user/session locks. It cannot be
/// cloned, detached from the transaction, or used as a cached permission token.
/// Commit always rechecks real-clock session expiry after application row waits.
pub(crate) struct AdminTransaction {
    tx: Transaction<'static, Postgres>,
    user: Uuid,
    login: String,
}
impl AdminTransaction {
    pub(crate) async fn begin(
        db: &PgPool,
        user: &RequestIdentity,
        headers: &HeaderMap,
        write: bool,
    ) -> Result<Self> {
        let mut tx = db.begin().await?;
        let login = lock_admin(&mut tx, user.id, headers, write).await?;
        Ok(Self {
            tx,
            user: user.id,
            login,
        })
    }

    pub(crate) fn transaction(&mut self) -> &mut Transaction<'static, Postgres> {
        &mut self.tx
    }

    pub(crate) async fn commit(self) -> Result<()> {
        finish(self.tx, self.user, &self.login).await
    }
}

// Compatibility operations for existing callers which own the transaction.
// The returned login identifies the exact session; it is NOT an admission receipt.
// Same user-before-session lock order as existing administrator settings writes.
// Hold both through commit; recheck real-clock expiry after settings-row waits.
pub(crate) async fn lock_admin(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    headers: &HeaderMap,
    write: bool,
) -> Result<String> {
    let role: Option<bool> =
        sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 AND account_active(id) FOR SHARE")
            .bind(user)
            .fetch_optional(&mut **tx)
            .await?;
    if role != Some(true) {
        return Err(Error::from(Failure::AdminRequired));
    }
    let login = media_authorization::login_hash(headers)?;
    let row = sqlx::query("SELECT csrf FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE")
        .bind(&login).bind(user).fetch_optional(&mut **tx).await?
        .ok_or_else(|| Error::from(Failure::SessionExpired))?;
    if write
        && headers.get("x-csrf-token").and_then(|v| v.to_str().ok())
            != Some(row.get::<String, _>("csrf").as_str())
    {
        return Err(Error::from(Failure::CsrfRejected));
    }
    Ok(login)
}
pub(crate) async fn finish(tx: Transaction<'_, Postgres>, user: Uuid, login: &str) -> Result<()> {
    let mut tx = tx;
    let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.user_id=$2 AND s.expires_at>clock_timestamp() AND u.admin AND account_active(u.id))")
        .bind(login).bind(user).fetch_one(&mut *tx).await?;
    if !live {
        return Err(Error::from(Failure::SessionExpired));
    }
    tx.commit().await?;
    Ok(())
}
