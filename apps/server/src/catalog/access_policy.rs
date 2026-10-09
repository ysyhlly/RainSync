//! A policy change owns one source-revision transaction and returns only a
//! confirmed-write receipt. Cleanup still belongs to the existing retirement owner.
use super::*;
use crate::{admin_settings, source_access::CommittedSourceChange};

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
    let login = admin_settings::lock_admin(&mut tx, user, headers, true).await?;
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
    admin_settings::finish(tx, user, &login).await?;
    // Release the source lock before taking session/cleanup locks. Readers and
    // final publication are already fenced by the committed source revision.
    // Reconciliation repeats this retirement if the HTTP waiter is interrupted.
    let committed =
        CommittedSourceChange::new(id, json!({"id":id,"access_policy_revision":next}), true);
    Ok(committed)
}
