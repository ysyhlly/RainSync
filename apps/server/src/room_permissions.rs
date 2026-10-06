use super::*;
use protocol::RoomPermission;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub role: String,
    #[serde(default)]
    pub permissions: Vec<RoomPermission>,
    pub expires_in_seconds: Option<i64>,
}
impl Grant {
    pub(super) fn validate(&self) -> Result<()> {
        if !matches!(self.role.as_str(), "viewer" | "moderator")
            || (self.role == "viewer" && !self.permissions.is_empty())
            || self.permissions.len() > 9
            || self
                .expires_in_seconds
                .is_some_and(|s| !(60..=31_536_000).contains(&s))
        {
            return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
        }
        Ok(())
    }
}

pub(super) async fn owner_authority<'a>(
    app: &'a App,
    h: &HeaderMap,
    room: Uuid,
) -> Result<(
    sqlx::Transaction<'a, sqlx::Postgres>,
    crate::room_lifecycle::management_authority::Authority,
    Uuid,
)> {
    let user = auth(app, h, true).await?;
    let mut tx = app.db.begin().await?;
    let owner: Uuid =
        sqlx::query_scalar("SELECT owner_id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
            .bind(room)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    persistence::room_lifecycle::lock_active(&mut tx, room)
        .await
        .map_err(room_lifecycle::gate_error)?;
    sqlx::query("SELECT room_id FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    let membership: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(room)
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let authority = crate::room_lifecycle::management_authority::Authority::admit(
        &mut tx,
        h,
        user.id,
        owner,
        membership.is_some(),
    )
    .await?;
    Ok((tx, authority, user.id))
}

pub async fn permissions(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    if !user.admin {
        member(&app, &user, room).await?;
    }
    let owner: Uuid = sqlx::query_scalar("SELECT owner_id FROM rooms WHERE id=$1")
        .bind(room)
        .fetch_one(&app.db)
        .await?;
    let rows = sqlx::query("SELECT m.user_id,COALESCE(p.role,'viewer') AS role,COALESCE(p.permissions,'{}'::text[]) AS permissions,p.revoked, floor(extract(epoch FROM p.expires_at)*1000)::bigint AS expires_at_ms, COALESCE(NOT p.revoked AND account_active(p.user_id) AND account_active(p.granted_by) AND (p.expires_at IS NULL OR p.expires_at>clock_timestamp()),false) AS active FROM room_members m LEFT JOIN room_member_permissions p USING(room_id,user_id) WHERE m.room_id=$1 AND account_active(m.user_id) ORDER BY m.user_id")
        .bind(room).fetch_all(&app.db).await?;
    let own = rows.iter().find(|r| r.get::<Uuid, _>("user_id") == user.id);
    Ok(media_titles::private_json(
        json!({"owner_id":owner,"self_permissions":own.filter(|r|r.get::<bool,_>("active")).map(|r| r.get::<Vec<String>,_>("permissions")).unwrap_or_default(),"members":rows.iter().map(|r|json!({"user_id":r.get::<Uuid,_>("user_id"),"role":r.get::<String,_>("role"),"permissions":r.get::<Vec<String>,_>("permissions"),"expires_at":r.get::<Option<i64>,_>("expires_at_ms"),"revoked":r.get::<Option<bool>,_>("revoked").unwrap_or(false),"active":r.get::<bool,_>("active")})).collect::<Vec<_>>()}),
    ))
}

pub async fn set_permissions(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, target)): Path<(Uuid, Uuid)>,
    Json(body): Json<Grant>,
) -> Result<Json<Value>> {
    body.validate()?;
    let (mut tx, authority, actor) = owner_authority(&app, &h, room).await?;
    let owner: Uuid = sqlx::query_scalar("SELECT owner_id FROM rooms WHERE id=$1")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    if target == owner {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let exists: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 AND account_active(user_id) FOR KEY SHARE",
    )
    .bind(room)
    .bind(target)
    .fetch_optional(&mut *tx)
    .await?;
    if exists.is_none() {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    sqlx::query("INSERT INTO room_member_permissions(room_id,user_id,role,permissions,expires_at,granted_by) VALUES($1,$2,$3,$4,CASE WHEN $5::bigint IS NULL THEN NULL ELSE clock_timestamp()+$5*interval '1 second' END,$6) ON CONFLICT(room_id,user_id) DO UPDATE SET role=EXCLUDED.role,permissions=EXCLUDED.permissions,expires_at=EXCLUDED.expires_at,revoked=false,granted_by=EXCLUDED.granted_by,updated_at=clock_timestamp()")
        .bind(room).bind(target).bind(&body.role).bind(body.permissions.iter().map(|p|p.as_str()).collect::<Vec<_>>()).bind(body.expires_in_seconds).bind(actor).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM control_epochs WHERE room_id=$1 AND user_id=$2")
        .bind(room)
        .bind(target)
        .execute(&mut *tx)
        .await?;
    authority.commit(tx).await?;
    broadcast_timeline(
        &app,
        room,
        json!({"type":"ROOM_PERMISSIONS_CHANGED","user_id":target}),
    )
    .await;
    Ok(Json(json!({"ok":true})))
}
pub async fn revoke_permissions(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, target)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let (mut tx, authority, _) = owner_authority(&app, &h, room).await?;
    sqlx::query("UPDATE room_member_permissions SET revoked=true,updated_at=clock_timestamp() WHERE room_id=$1 AND user_id=$2").bind(room).bind(target).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM control_epochs WHERE room_id=$1 AND user_id=$2")
        .bind(room)
        .bind(target)
        .execute(&mut *tx)
        .await?;
    authority.commit(tx).await?;
    broadcast_timeline(
        &app,
        room,
        json!({"type":"ROOM_PERMISSIONS_CHANGED","user_id":target}),
    )
    .await;
    Ok(Json(json!({"ok":true})))
}
pub async fn kick(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, target)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let actor = auth(&app, &h, true).await?;
    let mut tx = controller_for_permission(&app, &h, room, RoomPermission::Kick).await?;
    let owner: Uuid = sqlx::query_scalar("SELECT owner_id FROM rooms WHERE id=$1")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    let state: protocol::RoomState = serde_json::from_value(
        sqlx::query_scalar::<_, Value>("SELECT state FROM room_snapshots WHERE room_id=$1")
            .bind(room)
            .fetch_one(&mut *tx)
            .await?,
    )
    .map_err(anyhow::Error::from)?;
    let target_admin: Option<bool> = sqlx::query_scalar("SELECT admin FROM users WHERE id=$1")
        .bind(target)
        .fetch_optional(&mut *tx)
        .await?;
    if target == owner
        || target == state.controller_user_id
        || target == actor.id
        || (target_admin == Some(true) && !actor.admin)
    {
        return Err(err(StatusCode::FORBIDDEN, "forbidden"));
    }
    sqlx::query("DELETE FROM control_epochs WHERE room_id=$1 AND user_id=$2")
        .bind(room)
        .bind(target)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE room_id=$1 AND user_id=$2")
        .bind(room)
        .bind(target)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM room_members WHERE room_id=$1 AND user_id=$2")
        .bind(room)
        .bind(target)
        .execute(&mut *tx)
        .await?;
    commit_controller(tx, &h).await?;
    broadcast_timeline(
        &app,
        room,
        json!({"type":"ROOM_PERMISSIONS_CHANGED","user_id":target}),
    )
    .await;
    Ok(Json(json!({"ok":true})))
}
