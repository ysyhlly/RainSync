//! Explicit, invite-bound two-hour viewers. Ordinary auth is closed to guests.
use crate::*;
use axum::{Extension, extract::ConnectInfo};
use std::net::SocketAddr;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    token: String,
    display_name: Option<String>,
}

pub async fn enter(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    forwarded_identity: Option<Extension<account_security::GuestRateIdentity>>,
    h: HeaderMap,
    Path(room_id): Path<Uuid>,
    Json(body): Json<Entry>,
) -> Result<Response> {
    account_security::anonymous_json_request(&app, &h)?;
    // Neither a registered account nor an existing guest is silently replaced.
    // Check raw live sessions, including a guest invalidated by a newer policy.
    if let Some(cookie) = cookie(&h) {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM guest_principals WHERE login_hash=$1)")
            .bind(hash(&cookie)).fetch_one(&app.db).await?;
        if exists {
            return Err(err(StatusCode::CONFLICT, "already_authenticated"));
        }
    }
    let identity = forwarded_identity
        .map(|Extension(identity)| identity)
        .unwrap_or_else(|| app.account_security.guest_rate_identity(peer, &h));
    account_security::guest_rate_limit(&app.db, &identity).await?;
    let display_name =
        account_rules::display_name(body.display_name.as_deref())?.unwrap_or_else(|| "游客".into());
    if body.token.len() != 64 || !body.token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(err(StatusCode::FORBIDDEN, "invalid_invite"));
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    persistence::room_lifecycle::lock_active(&mut tx, room_id)
        .await
        .map_err(room_lifecycle::gate_error)?;
    // The singleton lock both fences disable and bounds global admissions.
    let enabled: Option<bool> = sqlx::query_scalar(
        "SELECT COALESCE(guests_enabled,false) FROM admin_settings WHERE singleton FOR UPDATE",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let room_enabled: Option<bool> =
        sqlx::query_scalar("SELECT enabled FROM room_guest_access WHERE room_id=$1 FOR SHARE")
            .bind(room_id)
            .fetch_optional(&mut *tx)
            .await?;
    if enabled != Some(true) || room_enabled != Some(true) {
        return Err(err(StatusCode::FORBIDDEN, "guest_access_disabled"));
    }
    // Guest access never bypasses normal invitation expiry, revocation or uses.
    // A targeted or elevated invitation cannot be converted into guest access.
    let invitation = hash(&body.token);
    let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM invites WHERE room_id=$1 AND token_hash=$2 AND invited_user_id IS NULL AND granted_role='viewer' AND cardinality(permissions)=0)")
        .bind(room_id).bind(&invitation).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(err(StatusCode::FORBIDDEN, "invalid_invite"));
    }
    // Remove only inactive temporary memberships in this already-locked room.
    sqlx::query("DELETE FROM room_members m USING guest_principals g WHERE m.user_id=g.user_id AND m.room_id=$1 AND (g.revoked_at IS NOT NULL OR g.expires_at<=clock_timestamp())")
        .bind(room_id).execute(&mut *tx).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM guest_principals WHERE revoked_at IS NULL AND expires_at>clock_timestamp()")
        .fetch_one(&mut *tx).await?;
    if count >= 1000 {
        return Err(account_security::limited(60));
    }
    let id = Uuid::new_v4();
    let login = token();
    let csrf = token();
    let username = format!("guest_{id}");
    sqlx::query("INSERT INTO users(id,username,password_hash,admin,principal_kind) VALUES($1,$2,'!',false,'guest')")
        .bind(id).bind(&username).execute(&mut *tx).await?;
    let expires: i64 = sqlx::query_scalar("WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at) INSERT INTO guest_principals(user_id,room_id,login_hash,display_name,created_at,expires_at) SELECT $1,$2,$3,$4,at,at+interval '2 hours' FROM stamp RETURNING floor(extract(epoch FROM expires_at)*1000)::bigint")
        .bind(id).bind(room_id).bind(hash(&login)).bind(&display_name).fetch_one(&mut *tx).await?;
    persistence::room_invites::redeem(&mut tx, room_id, id, &invitation)
        .await
        .map_err(rooms::redeem_error)?;
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) SELECT login_hash,user_id,$2,expires_at FROM guest_principals WHERE user_id=$1")
        .bind(id).bind(&csrf).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut response = responses::private_json(
        StatusCode::CREATED,
        json!({"id":id,"username":username,"display_name":display_name,"admin":false,"csrf":csrf,"avatar_url":null,"avatar_version":null,"guest":true,"guest_room_id":room_id,"guest_expires_at":expires}),
    );
    response.headers_mut().insert(
        header::SET_COOKIE,
        format!(
            "rainsync_session={login}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200{}",
            if app.secure { "; Secure" } else { "" }
        )
        .parse()
        .unwrap(),
    );
    Ok(response)
}

pub async fn add_identity(app: &App, user: Uuid, value: &mut Value) -> Result<()> {
    let row=sqlx::query("SELECT room_id,floor(extract(epoch FROM expires_at)*1000)::bigint AS expires_at_ms FROM guest_principals WHERE user_id=$1")
        .bind(user).fetch_optional(&app.db).await?;
    value["guest"] = json!(row.is_some());
    if let Some(row) = row {
        value["guest_room_id"] = json!(row.get::<Option<Uuid>, _>("room_id"));
        value["guest_expires_at"] = json!(row.get::<i64, _>("expires_at_ms"));
    }
    Ok(())
}

pub async fn is_guest(app: &App, user: Uuid) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT NOT guest_is_account($1)")
        .bind(user)
        .fetch_one(&app.db)
        .await?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Access {
    enabled: bool,
}

pub async fn access(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    let owner: Option<Uuid> = sqlx::query_scalar("SELECT owner_id FROM rooms WHERE id=$1")
        .bind(room)
        .fetch_optional(&app.db)
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
    .fetch_one(&app.db)
    .await?;
    let global:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM admin_settings WHERE singleton AND COALESCE(guests_enabled,false))").fetch_one(&app.db).await?;
    Ok(responses::private_json(
        StatusCode::OK,
        json!({"enabled":enabled,"guests_enabled":global,"session_ttl_seconds":7200,"invite_required":true}),
    ))
}

pub async fn set_access(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    Json(body): Json<Access>,
) -> Result<Response> {
    let (mut tx, authority, actor) =
        rooms::permission_operations::owner_authority(app.identity_context(), &h, room).await?;
    sqlx::query("INSERT INTO room_guest_access(room_id,enabled,updated_by) VALUES($1,$2,$3) ON CONFLICT(room_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()")
        .bind(room).bind(body.enabled).bind(actor).execute(&mut *tx).await?;
    authority.commit(tx).await?;
    Ok(responses::private_json(
        StatusCode::OK,
        json!({"enabled":body.enabled}),
    ))
}

/// Room-owned cleanup is bounded and can be retried after a lease/lock failure.
/// Retain only opaque history principals; remove expired memberships and names.
pub struct Maintenance(tokio::task::JoinHandle<()>);
impl Drop for Maintenance {
    fn drop(&mut self) {
        self.0.abort();
    }
}
impl Maintenance {
    pub fn start(app: App) -> Self {
        Self(tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let rooms:Vec<Uuid>=match sqlx::query_scalar("SELECT DISTINCT m.room_id FROM room_members m JOIN guest_principals g ON g.user_id=m.user_id WHERE g.revoked_at IS NOT NULL OR g.expires_at<=clock_timestamp() ORDER BY m.room_id LIMIT 100").fetch_all(&app.db).await {
                    Ok(rows)=>rows, Err(_)=>continue
                };
                for room in rooms {
                    let _ = cleanup_room(&app, room).await;
                }
            }
        }))
    }
}
async fn cleanup_room(app: &App, room: Uuid) -> Result<()> {
    if let Some(cluster) = &app.control_cluster
        && cluster.local_lease(room).await.is_err()
    {
        return Ok(());
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='1s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(room)
        .fetch_optional(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM room_members m USING guest_principals g WHERE m.user_id=g.user_id AND m.room_id=$1 AND (g.revoked_at IS NOT NULL OR g.expires_at<=clock_timestamp())")
        .bind(room).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guest_input_cannot_select_identity_or_permissions() {
        let room = Uuid::new_v4();
        for extra in [
            "user_id",
            "admin",
            "role",
            "permissions",
            "expires_at",
            "login_hash",
        ] {
            let mut value = json!({"token":"a".repeat(64),"display_name":"Guest"});
            value[extra] = json!("injected");
            assert!(serde_json::from_value::<Entry>(value).is_err());
        }
        assert!(serde_json::from_value::<Entry>(json!({"room_id":room})).is_err());
    }
}
