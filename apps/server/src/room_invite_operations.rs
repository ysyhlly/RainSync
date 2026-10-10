use super::{commit_controller, controller_admission, permission_operations};
use crate::identity::{RequestContext, request};
use crate::{Error, Result, err, hash, room_lifecycle, token};
use axum::http::{HeaderMap, StatusCode};
use protocol::RoomPermission;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

pub(crate) fn redeem_error(error: anyhow::Error) -> Error {
    match error.to_string().as_str() {
        "invalid_invite" => err(StatusCode::FORBIDDEN, "invalid_invite"),
        "room_full" => err(StatusCode::CONFLICT, "room_full"),
        _ => error.into(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    #[serde(default = "default_ttl")]
    expires_in_seconds: i64,
    max_uses: Option<i32>,
    invited_user_id: Option<Uuid>,
    #[serde(default = "default_role")]
    role: String,
    #[serde(default)]
    permissions: Vec<RoomPermission>,
    grant_expires_in_seconds: Option<i64>,
}
fn default_ttl() -> i64 {
    86_400
}
fn default_role() -> String {
    "viewer".into()
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            expires_in_seconds: default_ttl(),
            max_uses: None,
            invited_user_id: None,
            role: default_role(),
            permissions: vec![],
            grant_expires_in_seconds: None,
        }
    }
}
impl Policy {
    fn validate(&self) -> Result<()> {
        permission_operations::Grant {
            role: self.role.clone(),
            permissions: self.permissions.clone(),
            expires_in_seconds: self.grant_expires_in_seconds,
        }
        .validate()?;
        if !(60..=2_592_000).contains(&self.expires_in_seconds)
            || self.max_uses.is_some_and(|n| !(1..=10000).contains(&n))
        {
            return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
        }
        Ok(())
    }
}

pub(crate) async fn invite(
    context: RequestContext<'_>,
    h: &HeaderMap,
    room: Uuid,
    body: &[u8],
) -> Result<Value> {
    let db = context.db;
    let origin = context.origin;
    let body: Policy = if body.is_empty() {
        Policy::default()
    } else {
        serde_json::from_slice(body).map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_request"))?
    };
    body.validate()?;
    let actor = request::authenticate(RequestContext { db, origin }, h, true, false).await?;
    let controller = request::authenticate(context, h, true, false).await?;
    request::member(db, &controller, room).await?;
    let mut tx =
        controller_admission(db, controller, h, room, RoomPermission::Invite, true).await?;
    let owner: Uuid = sqlx::query_scalar("SELECT owner_id FROM rooms WHERE id=$1")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    let admin: bool = sqlx::query_scalar("SELECT admin FROM users WHERE id=$1")
        .bind(actor.id)
        .fetch_one(&mut *tx)
        .await?;
    // Inviting authority cannot manufacture additional authority, even for itself.
    if body.role == "moderator" && owner != actor.id && !admin {
        return Err(err(StatusCode::FORBIDDEN, "forbidden"));
    }
    if let Some(target) = body.invited_user_id {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND account_active(id))",
        )
        .bind(target)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
            return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
        }
    }
    let invitation = token();
    let row = sqlx::query("INSERT INTO invites(token_hash,room_id,expires_at,created_by,max_uses,invited_user_id,granted_role,permissions,grant_expires_at) VALUES($1,$2,clock_timestamp()+$3*interval '1 second',$4,$5,$6,$7,$8,CASE WHEN $9::bigint IS NULL THEN NULL ELSE clock_timestamp()+$9*interval '1 second' END) RETURNING id,floor(extract(epoch FROM expires_at)*1000)::bigint AS expires_at_ms")
        .bind(hash(&invitation)).bind(room).bind(body.expires_in_seconds).bind(actor.id).bind(body.max_uses).bind(body.invited_user_id).bind(&body.role).bind(body.permissions.iter().map(|p|p.as_str()).collect::<Vec<_>>()).bind(body.grant_expires_in_seconds).fetch_one(&mut *tx).await?;
    let result = json!({"id":row.get::<Uuid,_>("id"),"token":invitation,"room_id":room,"expires_at":row.get::<i64,_>("expires_at_ms"),"max_uses":body.max_uses,"use_count":0,"invited_user_id":body.invited_user_id,"role":body.role,"permissions":body.permissions});
    commit_controller(tx, h).await?;
    Ok(result)
}
pub(crate) async fn list_invites(
    context: RequestContext<'_>,
    h: &HeaderMap,
    room: Uuid,
) -> Result<Value> {
    let db = context.db;
    let controller = request::authenticate(context, h, false, false).await?;
    request::member(db, &controller, room).await?;
    let mut tx =
        controller_admission(db, controller, h, room, RoomPermission::Invite, false).await?;
    let rows=sqlx::query("SELECT id,created_by,invited_user_id,granted_role,permissions,max_uses,use_count,(revoked OR NOT account_active(created_by) OR NOT account_active(invited_user_id)) AS revoked,floor(extract(epoch FROM expires_at)*1000)::bigint AS expires_at_ms,floor(extract(epoch FROM revoked_at)*1000)::bigint AS revoked_at_ms,expires_at<=clock_timestamp() AS expired FROM invites WHERE room_id=$1 ORDER BY created_at DESC LIMIT 100")
        .bind(room).fetch_all(&mut *tx).await?;
    let result=rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"room_id":room,"created_by":r.get::<Option<Uuid>,_>("created_by"),"invited_user_id":r.get::<Option<Uuid>,_>("invited_user_id"),"role":r.get::<String,_>("granted_role"),"permissions":r.get::<Vec<String>,_>("permissions"),"max_uses":r.get::<Option<i32>,_>("max_uses"),"use_count":r.get::<i32,_>("use_count"),"revoked":r.get::<bool,_>("revoked"),"revoked_at":r.get::<Option<i64>,_>("revoked_at_ms"),"expired":r.get::<bool,_>("expired"),"expires_at":r.get::<i64,_>("expires_at_ms")})).collect::<Vec<_>>();
    commit_controller(tx, h).await?;
    Ok(json!(result))
}
pub(crate) async fn revoke_invite(
    context: RequestContext<'_>,
    h: &HeaderMap,
    room: Uuid,
    identity: String,
) -> Result<Value> {
    let db = context.db;
    let controller = request::authenticate(context, h, true, false).await?;
    request::member(db, &controller, room).await?;
    let mut tx =
        controller_admission(db, controller, h, room, RoomPermission::Invite, true).await?;
    sqlx::query("UPDATE invites SET revoked=true WHERE room_id=$1 AND (token_hash=$2 OR id=$3)")
        .bind(room)
        .bind(hash(&identity))
        .bind(Uuid::parse_str(&identity).ok())
        .execute(&mut *tx)
        .await?;
    commit_controller(tx, h).await?;
    Ok(json!({"ok":true}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Join {
    token: String,
}
pub(crate) async fn join(
    context: RequestContext<'_>,
    h: &HeaderMap,
    room: Uuid,
    body: Join,
) -> Result<Value> {
    let db = context.db;
    let actor = request::authenticate(context, h, true, false).await?;
    let mut tx = db.begin().await?;
    persistence::room_lifecycle::lock_active(&mut tx, room)
        .await
        .map_err(room_lifecycle::gate_error)?;
    persistence::room_invites::redeem(&mut tx, room, actor.id, &hash(&body.token))
        .await
        .map_err(redeem_error)?;
    // Admission must still belong to the exact live login after lock waits.
    let login =
        hash(&request::cookie(h).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))?);
    let locked_csrf: Option<String> = sqlx::query_scalar(
        "SELECT csrf FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(&login)
    .bind(actor.id)
    .fetch_optional(&mut *tx)
    .await?;
    if locked_csrf.as_deref() != h.get("x-csrf-token").and_then(|value| value.to_str().ok())
        || locked_csrf.is_none()
    {
        return Err(err(StatusCode::FORBIDDEN, "csrf_rejected"));
    }
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())")
        .bind(login).bind(actor.id).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    tx.commit().await?;
    Ok(json!({"ok":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redeem_error_preserves_known_statuses_and_unknown_error_policy() {
        for (message, status, code) in [
            ("invalid_invite", StatusCode::FORBIDDEN, "invalid_invite"),
            ("room_full", StatusCode::CONFLICT, "room_full"),
            (
                "unexpected database error",
                StatusCode::INTERNAL_SERVER_ERROR,
                "operation_failed",
            ),
        ] {
            let Error(actual_status, actual_code, retry) = redeem_error(anyhow::anyhow!(message));
            assert_eq!(actual_status, status);
            assert_eq!(actual_code, code);
            assert_eq!(retry, None);
        }
    }
}
