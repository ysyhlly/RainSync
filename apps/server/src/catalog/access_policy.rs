//! A policy change owns one source-revision transaction and returns only a
//! confirmed-write receipt and logical revision retirement.
use super::*;
use crate::identity::admin;
use persistence::media_job_timing::{CancellationScope, cancel_jobs};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    expected_revision: i64,
    policy: Value,
}

pub(crate) async fn change(
    context: SourceChangeContext<'_>,
    user: &User,
    headers: &HeaderMap,
    id: Uuid,
    body: Change,
) -> Result<CommittedSourceChange> {
    let mut tx = context.db.begin().await?;
    let login = admin::lock_admin(&mut tx, user.id, headers, true).await?;
    let row = sqlx::query(
        "SELECT kind,config_encrypted,access_policy_revision FROM sources WHERE id=$1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    let kind: String = row.get("kind");
    if !matches!(kind.as_str(), "http" | "jellyfin" | "emby") {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_source"));
    }
    let previous: i64 = row.get("access_policy_revision");
    if previous != body.expected_revision {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    let next = previous
        .checked_add(1)
        .ok_or_else(|| err(StatusCode::CONFLICT, "source_changed"))?;
    let mut config: providers::SourceConfig = serde_json::from_value((context.decrypt)(
        &row.get::<String, _>("config_encrypted"),
    )?)
    .map_err(anyhow::Error::from)?;
    config.access_policy = serde_json::from_value(body.policy)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    providers::access_policy::SourceAccess::new(&config.url, config.access_policy.as_ref())
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    providers::validate_source_headers(&config.headers)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    let encrypted = (context.encrypt)(&serde_json::to_value(config).map_err(anyhow::Error::from)?)?;
    sqlx::query("UPDATE sources SET config_encrypted=$2,access_policy_revision=$3 WHERE id=$1")
        .bind(id)
        .bind(encrypted)
        .bind(next)
        .execute(&mut *tx)
        .await?;
    // Migration 0024 invalidates previews once when config_encrypted changes.
    sqlx::query("UPDATE source_scans SET generation=$2 WHERE source_id=$1")
        .bind(id)
        .bind(Uuid::new_v4())
        .execute(&mut *tx)
        .await?;
    admin::finish(tx, user.id, &login).await?;
    // Release the source lock before taking session/cleanup locks. Readers and
    // final publication are already fenced by the committed source revision.
    // Reconciliation repeats this retirement if the HTTP waiter is interrupted.
    let committed =
        CommittedSourceChange::new(id, json!({"id":id,"access_policy_revision":next}), true);
    Ok(committed)
}

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

pub(crate) async fn retire(db: &PgPool) -> anyhow::Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE playback_sessions p SET stopped=true FROM media_items m JOIN sources s ON s.id=m.source_id WHERE p.media_id=m.id AND NOT p.stopped AND COALESCE((p.resource->>'source_policy_revision')::bigint,0)<>s.access_policy_revision").execute(&mut *tx).await?;
    let job_health = cancel_jobs(&mut *tx, CancellationScope::StoppedSessions).await?;
    sqlx::query("UPDATE upstream_reservations u SET state='closing',close_reason=COALESCE(close_reason,'source_changed'),cleanup_after=COALESCE(cleanup_after,clock_timestamp()),cleanup_deadline=COALESCE(cleanup_deadline,clock_timestamp()+interval '60 seconds'),updated_at=clock_timestamp() FROM sources s WHERE u.source_id=s.id AND u.source_policy_revision<>s.access_policy_revision AND u.state IN('preparing','active')").execute(&mut *tx).await?;
    let observation = job_health.into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
    Ok(())
}
