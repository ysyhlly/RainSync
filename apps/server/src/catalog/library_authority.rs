//! Transaction-local library authority and confirmed-write retirement receipts.
//! Callers retain their distinct caller-first or room-first lock order. No helper
//! represents permanent authority, and cleanup does not imply physical disposal.
use super::*;
use crate::{Error, media_authorization};
use sqlx::Connection;

pub fn enabled() -> bool {
    std::env::var("PRIVATE_LIBRARIES_ENABLED").is_ok_and(|v| v == "true")
}

pub(crate) fn require_enabled() -> Result<()> {
    if enabled() {
        Ok(())
    } else {
        Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "private_libraries_disabled",
        ))
    }
}

pub(crate) async fn authorize_media(
    db: &PgPool,
    user: Uuid,
    media: Uuid,
    action: &str,
    room: Option<Uuid>,
) -> Result<()> {
    let ok: bool = sqlx::query_scalar("SELECT library_media_allowed($1,$2,$3,$4)")
        .bind(user)
        .bind(media)
        .bind(action)
        .bind(room)
        .fetch_one(db)
        .await?;
    if ok {
        Ok(())
    } else {
        Err(err(StatusCode::NOT_FOUND, "media_not_found"))
    }
}

pub(crate) async fn lock_manage(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    id: Uuid,
    expected: i64,
) -> Result<sqlx::postgres::PgRow> {
    let row=sqlx::query("SELECT l.* FROM private_libraries l WHERE l.id=$2 AND library_allowed($1,l.id,'manage') FOR UPDATE")
        .bind(user).bind(id).fetch_optional(&mut **tx).await?.ok_or_else(||err(StatusCode::NOT_FOUND,"library_not_found"))?;
    if row.get::<i64, _>("revision") != expected {
        return Err(err(StatusCode::CONFLICT, "library_conflict"));
    }
    Ok(row)
}

pub(crate) async fn lock_caller(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: &User,
    h: &HeaderMap,
    operator: bool,
) -> Result<()> {
    let login = media_authorization::login_hash(h)?;
    let admin: Option<bool> = sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 FOR SHARE")
        .bind(user.id)
        .fetch_optional(&mut **tx)
        .await?;
    if admin.is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    if operator && admin != Some(true) {
        return Err(err(StatusCode::FORBIDDEN, "admin_required"));
    }
    let live:Option<Uuid>=sqlx::query_scalar("SELECT user_id FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE").bind(login).bind(user.id).fetch_optional(&mut **tx).await?;
    if live.is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    Ok(())
}

pub(crate) async fn commit_caller(
    mut tx: sqlx::Transaction<'_, sqlx::Postgres>,
    user: &User,
    h: &HeaderMap,
    operator: bool,
) -> Result<()> {
    // Time may pass while waiting for a library/source lock. A locked login can
    // still expire, so check database time again immediately before commit.
    lock_caller(&mut tx, user, h, operator).await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    lib: Uuid,
    actor: Uuid,
    action: &str,
    target: Option<Uuid>,
) -> Result<()> {
    sqlx::query("INSERT INTO library_permission_audit(library_id,actor_id,action,target_id,permission_epoch) SELECT id,$2,$3,$4,permission_epoch FROM private_libraries WHERE id=$1")
        .bind(lib).bind(actor).bind(action).bind(target).execute(&mut **tx).await?;
    Ok(())
}

pub(crate) async fn advance(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    lib: Uuid,
    permissions: bool,
) -> Result<()> {
    sqlx::query("UPDATE private_libraries SET revision=revision+1,permission_epoch=permission_epoch+CASE WHEN $2 THEN 1 ELSE 0 END WHERE id=$1")
        .bind(lib).bind(permissions).execute(&mut **tx).await?;
    Ok(())
}

pub(crate) async fn retire(db: &PgPool) -> Result<()> {
    // Preserve the eager path's original transaction and commit-observation order.
    let mut tx = db.begin().await?;
    let obs = retire_rows(&mut tx).await?.into_commit_observation();
    tx.commit().await?;
    obs.confirmed();
    Ok(())
}

async fn retire_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
) -> Result<media_core::job_health::PendingJobHealth> {
    // Do not hold library locks while locking playback/jobs. Reader predicates
    // already reject old epochs; process-local cancellation observes stopped.
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE NOT stopped AND NOT playback_library_session_allowed(id)")
        .execute(&mut **tx).await?;
    Ok(persistence::media_job_timing::cancel_jobs(
        &mut **tx,
        persistence::media_job_timing::CancellationScope::StoppedSessions,
    )
    .await?)
}

pub(crate) async fn retire_maintenance(db: &PgPool) -> Result<()> {
    // Include pool acquisition, transaction start and COMMIT in the overall
    // budget. A timeout is only an unfinished attempt, never disposal evidence.
    let attempt = async {
        let mut connection = RetirementConnection(Some(db.acquire().await?));
        let mut tx = connection
            .0
            .as_mut()
            .expect("retirement connection")
            .begin()
            .await?;
        // Same bounded SQL convention as room cleanup; only this background
        // attempt receives limits. The eager receipt path is unchanged.
        sqlx::query("SET LOCAL lock_timeout='2s'")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SET LOCAL statement_timeout='3s'")
            .execute(&mut *tx)
            .await?;
        let obs = retire_rows(&mut tx).await?.into_commit_observation();
        tx.commit().await?;
        obs.confirmed();
        connection.release();
        Ok::<(), Error>(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), attempt)
        .await
        .map_err(|_| anyhow::anyhow!("library_retirement_timeout"))?
}

pub(crate) async fn require_current_permission(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    library: Uuid,
    action: &str,
) -> Result<()> {
    // Row locks freeze configuration, not the wall-clock expiry of a grant.
    let allowed: bool = sqlx::query_scalar("SELECT library_allowed($1,$2,$3)")
        .bind(user)
        .bind(library)
        .bind(action)
        .fetch_one(&mut **tx)
        .await?;
    if !allowed {
        return Err(err(StatusCode::NOT_FOUND, "library_not_found"));
    }
    Ok(())
}

pub(crate) async fn lock_source_library(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    library: Uuid,
) -> Result<()> {
    let allowed: Option<Uuid> = sqlx::query_scalar("SELECT id FROM private_libraries WHERE id=$1 AND library_allowed($2,id,'manage') FOR UPDATE")
        .bind(library).bind(user).fetch_optional(&mut **tx).await?;
    if allowed.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "library_not_found"));
    }
    Ok(())
}

pub(crate) async fn require_idle_sources(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    library: Uuid,
    source: Option<Uuid>,
) -> Result<()> {
    // Source locks are already held. Preparation admission takes a source share
    // lock, so no new reader can enter between this check and tombstoning.
    let in_use: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN media_items m ON m.id=p.media_id JOIN sources s ON s.id=m.source_id WHERE s.library_id=$1 AND ($2::uuid IS NULL OR s.id=$2) AND NOT p.stopped AND p.expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM upstream_reservations r JOIN sources s ON s.id=r.source_id WHERE s.library_id=$1 AND ($2::uuid IS NULL OR s.id=$2) AND (r.state IN('preparing','active','closing') OR r.io_claim IS NOT NULL OR r.io_uncertain))")
        .bind(library).bind(source).fetch_one(&mut **tx).await?;
    if in_use {
        let unconfirmed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM upstream_reservations r JOIN sources s ON s.id=r.source_id WHERE s.library_id=$1 AND ($2::uuid IS NULL OR s.id=$2) AND r.state='cleanup_failed' AND (r.io_uncertain OR r.io_claim IS NOT NULL))")
            .bind(library).bind(source).fetch_one(&mut **tx).await?;
        return Err(err(
            StatusCode::CONFLICT,
            if unconfirmed {
                "source_cleanup_unconfirmed"
            } else {
                "source_in_use"
            },
        ));
    }
    Ok(())
}
/// Construct only after the original transaction confirms COMMIT. This receipt
/// carries the response captured under that transaction's authority, not a new
/// post-commit read or permission token. COMMIT errors still propagate.
pub(crate) struct CommittedLibraryChange {
    library: Uuid,
    value: Value,
    retirement_required: bool,
}
impl CommittedLibraryChange {
    pub(super) fn new(library: Uuid, value: Value, retirement_required: bool) -> Self {
        Self {
            library,
            value,
            retirement_required,
        }
    }
    pub(crate) async fn response(self, db: &PgPool) -> Value {
        if self.retirement_required && retire(db).await.is_err() {
            // Existing epoch/source predicates fence use immediately; the
            // existing maintenance coordinator retries logical retirement.
            // This is not a physical resource-disposal receipt.
            tracing::warn!(library = %self.library, cleanup = "pending", "library change committed; retirement deferred to maintenance");
        }
        self.value
    }
}

// Follow upstream_policy's connection ownership: an interrupted or failed
// attempt discards its connection rather than returning uncertain SQL to the pool.
// Normal release is allowed only after the transaction confirms its commit.
struct RetirementConnection(Option<sqlx::pool::PoolConnection<sqlx::Postgres>>);
impl Drop for RetirementConnection {
    fn drop(&mut self) {
        if let Some(connection) = &mut self.0 {
            connection.close_on_drop();
        }
    }
}
impl RetirementConnection {
    fn release(&mut self) {
        drop(self.0.take());
    }
}
