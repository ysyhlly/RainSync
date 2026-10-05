//! Transactional policy admission. Cleanup never calls these gates.
use anyhow::Result;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

const NATIVE_ACCOUNT_LOCK: &str =
    "SELECT id FROM platform_accounts WHERE id::text=$1 AND user_id=$2 AND provider=$3 FOR SHARE";

fn native_account_provider(context: &serde_json::Value) -> Option<&str> {
    context["provider"]
        .as_str()
        .filter(|provider| matches!(*provider, "bilibili" | "douyin" | "tiktok" | "youtube"))
}

pub async fn lock(
    tx: &mut Transaction<'_, Postgres>,
    source: Uuid,
    revision: i64,
    generation: Option<i64>,
) -> Result<bool> {
    let row = sqlx::query("SELECT kind,access_policy_revision FROM sources WHERE id=$1 FOR SHARE")
        .bind(source)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(row) = row else { return Ok(false) };
    if row.get::<i64, _>("access_policy_revision") != revision {
        return Ok(false);
    }
    if matches!(row.get::<String, _>("kind").as_str(), "jellyfin" | "emby") {
        sqlx::query("SELECT source_id FROM source_account_policies WHERE source_id=$1 FOR SHARE")
            .bind(source)
            .fetch_optional(&mut **tx)
            .await?;
    }
    // Re-evaluate expiry after waiting for all contended authority locks.
    Ok(
        sqlx::query_scalar("SELECT source_account_policy_allowed($1,$2,$3)")
            .bind(source)
            .bind(revision)
            .bind(generation)
            .fetch_one(&mut **tx)
            .await?,
    )
}

/// Caller holds its room/lifecycle admission lock through commit. This locks
/// source authority only; the final statement must also recheck stopped/expiry.
pub async fn lock_session(tx: &mut Transaction<'_, Postgres>, session: Uuid) -> Result<bool> {
    let row = sqlx::query("SELECT m.source_id,p.resource,p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch,COALESCE((p.resource->>'source_policy_revision')::bigint,0) AS revision,(p.resource->>'account_policy_generation')::bigint AS generation FROM playback_sessions p JOIN media_items m ON m.id=p.media_id WHERE p.id=$1")
        .bind(session).fetch_optional(&mut **tx).await?;
    let Some(row) = row else { return Ok(false) };
    if let Some(login) = row.get::<Option<String>, _>("auth_login_hash")
        && !crate::media_authorization::lock_origin(
            tx,
            row.get("user_id"),
            row.get("room_id"),
            Some(&login),
            row.get("auth_membership_epoch"),
        )
        .await?
    {
        return Ok(false);
    }
    let resource = row.get("resource");
    if !crate::http_file_authorization::resource_scope_matches(
        &resource,
        row.get("user_id"),
        row.get("room_id"),
    ) || !crate::http_file_authorization::lock_resource(tx, &resource).await?
    {
        return Ok(false);
    }
    if resource.get("native_platform_context").is_some() {
        let context = &resource["native_platform_context"];
        let entry: Option<Uuid> = sqlx::query_scalar(
            "SELECT e.media_id FROM room_platform_media e JOIN playback_sessions p ON p.media_id=e.media_id AND p.room_id=e.room_id WHERE p.id=$1 FOR SHARE OF e",
        )
        .bind(session)
        .fetch_optional(&mut **tx)
        .await?;
        let Some(media_id) = entry else {
            return Ok(false);
        };
        if context["credential_mode"].as_str() == Some("own_account") {
            // Account identity is viewer- and provider-bound, never room owner.
            let Some(provider) = native_account_provider(context) else {
                return Ok(false);
            };
            let account: Option<Uuid> = sqlx::query_scalar(NATIVE_ACCOUNT_LOCK)
                .bind(context["account_id"].as_str())
                .bind(row.get::<Uuid, _>("user_id"))
                .bind(provider)
                .fetch_optional(&mut **tx)
                .await?;
            if account.is_none() {
                return Ok(false);
            }
        }
        return Ok(
            sqlx::query_scalar("SELECT native_platform_source_allowed($1,$2)")
                .bind(media_id)
                .bind(&resource)
                .fetch_one(&mut **tx)
                .await?,
        );
    }
    let Some(source) = row.get::<Option<Uuid>, _>("source_id") else {
        return Ok(false);
    };
    lock(tx, source, row.get("revision"), row.get("generation")).await
}

pub async fn lock_reservation(
    tx: &mut Transaction<'_, Postgres>,
    reservation: Uuid,
) -> Result<bool> {
    let row = sqlx::query("SELECT source_id,source_policy_revision,account_policy_generation,user_id,room_id,auth_login_hash,auth_membership_epoch FROM upstream_reservations WHERE id=$1")
        .bind(reservation).fetch_optional(&mut **tx).await?;
    let Some(row) = row else { return Ok(false) };
    if !crate::media_authorization::lock_origin(
        tx,
        row.get("user_id"),
        row.get("room_id"),
        row.get::<Option<String>, _>("auth_login_hash").as_deref(),
        row.get("auth_membership_epoch"),
    )
    .await?
    {
        return Ok(false);
    }
    lock(
        tx,
        row.get("source_id"),
        row.get("source_policy_revision"),
        row.get("account_policy_generation"),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_account_lock_is_exact_viewer_provider_and_id_never_room_owner() {
        for provider in ["bilibili", "douyin", "tiktok", "youtube"] {
            assert_eq!(
                native_account_provider(&serde_json::json!({"provider":provider})),
                Some(provider)
            );
        }
        for context in [
            serde_json::json!({}),
            serde_json::json!({"provider":null}),
            serde_json::json!({"provider":"youtube_playlist"}),
            serde_json::json!({"provider":"douyin_live"}),
            serde_json::json!({"provider":"owner_account"}),
        ] {
            assert_eq!(native_account_provider(&context), None);
        }
        for fence in ["id::text=$1", "user_id=$2", "provider=$3", "FOR SHARE"] {
            assert!(NATIVE_ACCOUNT_LOCK.contains(fence));
        }
        assert!(!NATIVE_ACCOUNT_LOCK.contains("room"));
        assert!(!NATIVE_ACCOUNT_LOCK.contains("owner"));
    }
}
