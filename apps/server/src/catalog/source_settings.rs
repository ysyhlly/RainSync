//! In-place source settings own the original caller-first transaction. Keep
//! this local administrator policy distinct from administrative settings admission.
use super::source_rules::*;
use super::*;
use crate::{media_authorization, source_access};
use serde_json::Map;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    expected_revision: String,
    name: Option<String>,
    config: Option<Map<String, Value>>,
}
// Pin admin/login authority before source locks. Recheck expiry at commit.
async fn lock_admin(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: &User,
    h: &HeaderMap,
) -> Result<()> {
    let login = media_authorization::login_hash(h)?;
    let role: Option<bool> = sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM account_exits WHERE user_id=$1) FOR SHARE")
        .bind(user.id).fetch_optional(&mut **tx).await?;
    if role != Some(true) {
        return Err(err(StatusCode::FORBIDDEN, "admin_required"));
    }
    let live: Option<Uuid> = sqlx::query_scalar("SELECT user_id FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE")
        .bind(login).bind(user.id).fetch_optional(&mut **tx).await?;
    if live.is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    Ok(())
}
pub(crate) async fn get(
    context: SourceReadContext<'_>,
    user: &User,
    h: &HeaderMap,
    id: Uuid,
) -> Result<Value> {
    let mut tx = context.db.begin().await?;
    lock_admin(&mut tx, user, h).await?;
    let row = sqlx::query("SELECT * FROM sources WHERE id=$1 FOR SHARE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    manageable(&row)?;
    let config = parse_config(&(context.decrypt)(
        &row.get::<String, _>("config_encrypted"),
    )?)?;
    let value = safe_detail(&row, &config);
    tx.commit().await?;
    Ok(value)
}
pub(crate) async fn change(
    context: SourceChangeContext<'_>,
    user: &User,
    h: &HeaderMap,
    id: Uuid,
    body: Change,
) -> Result<source_access::CommittedSourceChange> {
    let expected = revision(&body.expected_revision)?;
    let mut tx = context.db.begin().await?;
    lock_admin(&mut tx, user, h).await?;
    let row = sqlx::query("SELECT * FROM sources WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    manageable(&row)?;
    if row.get::<i64, _>("settings_revision") != expected {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    let kind: String = row.get("kind");
    let old_raw = (context.decrypt)(&row.get::<String, _>("config_encrypted"))?;
    let old = parse_config(&old_raw)?;
    let next_raw = match body.config {
        Some(patch) => merge_config(&kind, &old_raw, &patch)?,
        None => old_raw,
    };
    let next = parse_config(&next_raw)?;
    let config_changed = serde_json::to_value(&old).map_err(anyhow::Error::from)?
        != serde_json::to_value(&next).map_err(anyhow::Error::from)?;
    let next_name = body
        .name
        .as_deref()
        .map(name)
        .transpose()?
        .unwrap_or_else(|| row.get("name"));
    if config_changed {
        validate_config(&kind, &next)?;
        if kind == "http" && next.url != old.url {
            // HTTP sources index one URL. Move its existing media identity so
            // playlist/history/title references survive the connection edit.
            let collision: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_items WHERE source_id=$1 AND resource=$2) AND EXISTS(SELECT 1 FROM media_items WHERE source_id=$1 AND resource=$3)")
                .bind(id).bind(&next.url).bind(&old.url).fetch_one(&mut *tx).await?;
            if collision {
                return Err(err(StatusCode::CONFLICT, "source_changed"));
            }
            sqlx::query("UPDATE media_items SET resource=$3,metadata='{}'::jsonb,duration_ms=NULL,source_version=NULL WHERE source_id=$1 AND resource=$2")
                .bind(id).bind(&old.url).bind(&next.url).execute(&mut *tx).await?;
        } else if (kind == "local" && next.root != old.root)
            || (matches!(kind.as_str(), "jellyfin" | "emby")
                && (next.url != old.url || next.user_id != old.user_id))
        {
            // Old keys may mean different media at the new catalog. Require a
            // scan before reuse, retaining IDs and every relationship.
            sqlx::query("UPDATE media_items SET available=false WHERE source_id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }
    // Encryption is randomized: preserve ciphertext for semantic no-op saves.
    let encrypted = if config_changed {
        (context.encrypt)(&next_raw)?
    } else {
        row.get("config_encrypted")
    };
    let updated =
        sqlx::query("UPDATE sources SET name=$2,config_encrypted=$3 WHERE id=$1 RETURNING *")
            .bind(id)
            .bind(next_name)
            .bind(encrypted)
            .fetch_one(&mut *tx)
            .await?;
    let mut value = safe_detail(&updated, &next);
    value["config_changed"] = json!(config_changed);
    value["rescan_required"] = json!(config_changed);
    lock_admin(&mut tx, user, h).await?;
    tx.commit().await?;
    let committed = source_access::CommittedSourceChange::new(id, value, config_changed);
    Ok(committed)
}
