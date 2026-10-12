//! Complete room guest-access policy read/write operations.
use crate::identity::{RequestContext, request};
use crate::{Result, err};
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Access {
    enabled: bool,
}

pub(crate) async fn access(
    context: RequestContext<'_>,
    h: &HeaderMap,
    room: Uuid,
) -> Result<Value> {
    let db = context.db;
    let user = request::authenticate(context, h, false, false).await?;
    let owner: Option<Uuid> = sqlx::query_scalar("SELECT owner_id FROM rooms WHERE id=$1")
        .bind(room)
        .fetch_optional(db)
        .await?;
    if owner.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "not_found"));
    }
    if !user.admin && owner != Some(user.id) {
        return Err(err(StatusCode::FORBIDDEN, "forbidden"));
    }
    let enabled: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM room_guest_access WHERE room_id=$1 AND enabled)",
    )
    .bind(room)
    .fetch_one(db)
    .await?;
    let global:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM admin_settings WHERE singleton AND COALESCE(guests_enabled,false))").fetch_one(db).await?;
    Ok(
        json!({"enabled":enabled,"guests_enabled":global,"session_ttl_seconds":7200,"invite_required":true}),
    )
}

pub(crate) async fn set_access(
    context: RequestContext<'_>,
    h: &HeaderMap,
    room: Uuid,
    body: Access,
) -> Result<Value> {
    let (mut tx, authority, actor) =
        crate::rooms::permission_operations::owner_authority(context, h, room).await?;
    sqlx::query("INSERT INTO room_guest_access(room_id,enabled,updated_by) VALUES($1,$2,$3) ON CONFLICT(room_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()")
        .bind(room).bind(body.enabled).bind(actor).execute(&mut *tx).await?;
    authority.commit(tx).await?;
    Ok(json!({"enabled":body.enabled}))
}

#[cfg(test)]
mod tests {
    use super::Access;
    use serde_json::json;

    #[test]
    fn access_requires_the_original_boolean_field() {
        for enabled in [false, true] {
            let access: Access = serde_json::from_value(json!({ "enabled": enabled })).unwrap();
            assert_eq!(access.enabled, enabled);
        }
        for value in [
            json!({}),
            json!({ "enabled": null }),
            json!({ "enabled": "true" }),
        ] {
            assert!(serde_json::from_value::<Access>(value).is_err());
        }
    }

    #[test]
    fn access_rejects_unknown_fields() {
        assert!(
            serde_json::from_value::<Access>(json!({ "enabled": true, "extra": true })).is_err()
        );
    }
}
