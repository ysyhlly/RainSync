//! Source policy changes fence grants without claiming physical resource drain.
use super::*;
pub use catalog::access_policy::Change;
use persistence::media_job_timing::{CancellationScope, cancel_jobs};

/// The original write is confirmed before this receipt is created. A failed
/// COMMIT (including an unknown outcome) must still propagate from its caller.
pub(crate) struct CommittedSourceChange {
    source: Uuid,
    value: Value,
    retirement_required: bool,
}

impl CommittedSourceChange {
    pub(crate) fn new(source: Uuid, value: Value, retirement_required: bool) -> Self {
        Self {
            source,
            value,
            retirement_required,
        }
    }

    /// Eager logical retirement is best effort, not part of the write outcome.
    /// Committed source revisions immediately fence readers/publication and the
    /// remaining revision mismatches durably identify work for maintenance.
    /// This neither waits for physical drain nor claims a disposal receipt.
    pub(crate) async fn response(self, db: &PgPool) -> Value {
        if self.retirement_required && retire(db).await.is_err() {
            // Never log database/provider errors or configuration credentials.
            tracing::warn!(
                source = %self.source,
                cleanup = "pending",
                "source change committed; retirement deferred to maintenance"
            );
        }
        self.value
    }
}

pub async fn guard(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    source: Uuid,
    revision: i64,
) -> Result<()> {
    let current: i64 =
        sqlx::query_scalar("SELECT access_policy_revision FROM sources WHERE id=$1 FOR SHARE")
            .bind(source)
            .fetch_one(&mut **tx)
            .await?;
    if current != revision {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    Ok(())
}
pub async fn change(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Change>,
) -> Result<Json<Value>> {
    let user = auth(&app, &headers, true).await?;
    admin(&user)?;
    let context = catalog::SourceChangeContext {
        db: &app.db,
        encrypt: &|value| app.encrypt(value),
        decrypt: &|value| app.decrypt(value),
    };
    let committed = catalog::access_policy::change(context, &user, &headers, id, body).await?;
    Ok(Json(committed.response(&app.db).await))
}
pub async fn retire(db: &PgPool) -> anyhow::Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE playback_sessions p SET stopped=true FROM media_items m JOIN sources s ON s.id=m.source_id WHERE p.media_id=m.id AND NOT p.stopped AND COALESCE((p.resource->>'source_policy_revision')::bigint,0)<>s.access_policy_revision").execute(&mut *tx).await?;
    let job_health = cancel_jobs(&mut *tx, CancellationScope::StoppedSessions).await?;
    sqlx::query("UPDATE upstream_reservations u SET state='closing',close_reason=COALESCE(close_reason,'source_changed'),cleanup_after=COALESCE(cleanup_after,clock_timestamp()),cleanup_deadline=COALESCE(cleanup_deadline,clock_timestamp()+interval '60 seconds'),updated_at=clock_timestamp() FROM sources s WHERE u.source_id=s.id AND u.source_policy_revision<>s.access_policy_revision AND u.state IN('preparing','active')").execute(&mut *tx).await?;
    let observation = job_health.into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
    Ok(())
}
