//! Named libraries use cases; transaction ownership stays here.
use super::library_authority::*;
use super::*;
const LIB_SELECT: &str = "SELECT l.*,library_allowed($1,l.id,'browse') AS browse,library_allowed($1,l.id,'play') AS play,library_allowed($1,l.id,'share_to_room') AS share_to_room,library_allowed($1,l.id,'manage') AS manage FROM private_libraries l";

#[derive(Deserialize)]
pub struct IssuedSharesQuery {
    after: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rename {
    name: String,
    expected_revision: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    username: String,
    browse: bool,
    play: bool,
    share_to_room: bool,
    manage: bool,
    expires_in_hours: u32,
    expected_revision: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expected {
    pub(super) expected_revision: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transfer {
    username: String,
    expected_revision: String,
}

pub(super) fn name(v: &str) -> Result<String> {
    let v = v.trim();
    if !(1..=100).contains(&v.chars().count()) || v.chars().any(|c| c.is_control()) {
        return Err(err(StatusCode::BAD_REQUEST, "library_invalid"));
    }
    Ok(v.to_owned())
}

pub(super) fn revision(v: &str) -> Result<i64> {
    if v.is_empty() || !v.bytes().all(|c| c.is_ascii_digit()) {
        return Err(err(StatusCode::BAD_REQUEST, "library_invalid"));
    }
    v.parse::<i64>()
        .ok()
        .filter(|v| *v > 0 && *v < i64::MAX)
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "library_invalid"))
}

fn library_value(r: &sqlx::postgres::PgRow) -> Value {
    json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"owner_id":r.get::<Option<Uuid>,_>("owner_id"),
      "visibility":r.get::<String,_>("visibility"),"revision":r.get::<i64,_>("revision").to_string(),
      "permission_epoch":r.get::<i64,_>("permission_epoch").to_string(),"permissions":{
        "browse":r.get::<bool,_>("browse"),"play":r.get::<bool,_>("play"),"share_to_room":r.get::<bool,_>("share_to_room"),"manage":r.get::<bool,_>("manage")}})
}

async fn detail_value(connection: &mut sqlx::PgConnection, user: Uuid, id: Uuid) -> Result<Value> {
    let row=sqlx::query(&format!("{LIB_SELECT} WHERE l.id=$2 AND (library_allowed($1,l.id,'browse') OR library_allowed($1,l.id,'manage'))"))
        .bind(user).bind(id).fetch_optional(&mut *connection).await?.ok_or_else(||err(StatusCode::NOT_FOUND,"library_not_found"))?;
    let mut value = library_value(&row);
    // No titles, source paths, credentials or grants leak to room-only viewers.
    if row.get::<bool, _>("manage") {
        let sources=sqlx::query("SELECT id,name,kind,access_policy_revision,settings_revision FROM sources WHERE library_id=$1 AND deleted_at IS NULL ORDER BY name,id").bind(id).fetch_all(&mut *connection).await?;
        value["sources"]=json!(sources.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"kind":r.get::<String,_>("kind"),"revision":r.get::<i64,_>("settings_revision").to_string(),"access_policy_revision":r.get::<i64,_>("access_policy_revision")})).collect::<Vec<_>>());
        let grants=sqlx::query("SELECT g.*,u.username,floor(extract(epoch FROM g.expires_at)*1000)::bigint AS expiry FROM library_grants g JOIN users u ON u.id=g.user_id WHERE g.library_id=$1 ORDER BY u.username").bind(id).fetch_all(&mut *connection).await?;
        value["grants"]=json!(grants.iter().map(|r|json!({"user_id":r.get::<Uuid,_>("user_id"),"username":r.get::<String,_>("username"),"browse":r.get::<bool,_>("browse"),"play":r.get::<bool,_>("play"),"share_to_room":r.get::<bool,_>("share_to_room"),"manage":r.get::<bool,_>("manage"),"expires_at":r.get::<i64,_>("expiry")})).collect::<Vec<_>>());
        let rows=sqlx::query("SELECT id,actor_id,action,target_id,floor(extract(epoch FROM created_at)*1000)::bigint AS created_ms FROM library_permission_audit WHERE library_id=$1 ORDER BY created_at DESC,id LIMIT 100").bind(id).fetch_all(&mut *connection).await?;
        value["audit"]=json!(rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"actor_id":r.get::<Option<Uuid>,_>("actor_id"),"action":r.get::<String,_>("action"),"target_id":r.get::<Option<Uuid>,_>("target_id"),"created_at":r.get::<i64,_>("created_ms")})).collect::<Vec<_>>());
    }
    let shares=sqlx::query("SELECT g.id,g.media_id,g.room_id,g.mode,g.permission_epoch,CASE WHEN s.library_id=$1 AND s.deleted_at IS NULL THEN m.title ELSE '已移出或删除的影片' END AS title,floor(extract(epoch FROM g.created_at+interval '24 hours')*1000)::bigint AS max_expiry,floor(extract(epoch FROM g.expires_at)*1000)::bigint AS expiry,(g.revoked_at IS NULL AND s.library_id=$1 AND s.deleted_at IS NULL AND g.permission_epoch=$2 AND g.source_generation=m.library_source_generation AND m.available AND g.expires_at>clock_timestamp() AND library_allowed(g.grantor_id,g.library_id,'share_to_room')) AS active FROM room_media_grants g JOIN media_items m ON m.id=g.media_id JOIN sources s ON s.id=m.source_id WHERE g.library_id=$1 AND (g.grantor_id=$3 OR library_allowed($3,$1,'manage')) ORDER BY g.created_at DESC LIMIT 100").bind(id).bind(row.get::<i64,_>("permission_epoch")).bind(user).fetch_all(&mut *connection).await?;
    value["room_shares"]=json!(shares.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"media_id":r.get::<Uuid,_>("media_id"),"room_id":r.get::<Uuid,_>("room_id"),"mode":r.get::<String,_>("mode"),"title":r.get::<String,_>("title"),"expires_at":r.get::<i64,_>("expiry"),"max_expires_at":r.get::<i64,_>("max_expiry"),"active":r.get::<bool,_>("active")})).collect::<Vec<_>>());
    Ok(value)
}

pub(crate) async fn list(db: &PgPool, u: User) -> Result<Value> {
    let rows=sqlx::query(&format!("{LIB_SELECT} WHERE library_allowed($1,l.id,'browse') OR library_allowed($1,l.id,'manage') ORDER BY l.name,l.id"))
        .bind(u.id).fetch_all(db).await?;
    Ok(json!({"enabled":enabled(),"items":rows.iter().map(library_value).collect::<Vec<_>>()}))
}

pub(crate) async fn issued_shares(db: &PgPool, u: User, query: IssuedSharesQuery) -> Result<Value> {
    // Grantors can withdraw their own records after losing library access.
    // Return no source configuration, other grantors, or inaccessible titles.
    let rows = sqlx::query("SELECT g.id,g.library_id,g.media_id,g.room_id,g.mode,l.revision,CASE WHEN s.library_id=l.id AND s.deleted_at IS NULL AND library_allowed($1,l.id,'browse') THEN m.title ELSE NULL END AS title,floor(extract(epoch FROM g.expires_at)*1000)::bigint AS expiry,(g.permission_epoch=l.permission_epoch AND s.library_id=l.id AND s.deleted_at IS NULL AND g.source_generation=m.library_source_generation AND m.available AND g.expires_at>clock_timestamp() AND library_allowed($1,l.id,'share_to_room')) AS active FROM room_media_grants g JOIN private_libraries l ON l.id=g.library_id JOIN media_items m ON m.id=g.media_id JOIN sources s ON s.id=m.source_id WHERE g.grantor_id=$1 AND g.revoked_at IS NULL AND l.deleted_at IS NULL AND ($2::uuid IS NULL OR g.id>$2) ORDER BY g.id LIMIT 101")
        .bind(u.id).bind(query.after).fetch_all(db).await?;
    let has_more = rows.len() > 100;
    let items = rows.iter().take(100).map(|r| json!({"id":r.get::<Uuid,_>("id"),"library_id":r.get::<Uuid,_>("library_id"),"revision":r.get::<i64,_>("revision").to_string(),"media_id":r.get::<Uuid,_>("media_id"),"room_id":r.get::<Uuid,_>("room_id"),"mode":r.get::<String,_>("mode"),"title":r.get::<Option<String>,_>("title"),"expires_at":r.get::<i64,_>("expiry"),"active":r.get::<bool,_>("active")})).collect::<Vec<_>>();
    Ok(json!({"items":items,"has_more":has_more}))
}

pub(crate) async fn create(
    db: &PgPool,
    u: User,
    h: HeaderMap,
    body: Create,
) -> Result<CommittedLibraryChange> {
    let name = name(&body.name)?;
    let id = Uuid::new_v4();
    let mut tx = db.begin().await?;
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
    lock_caller(&mut tx, &u, &h, false).await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM private_libraries WHERE owner_id=$1 AND deleted_at IS NULL",
    )
    .bind(u.id)
    .fetch_one(&mut *tx)
    .await?;
    if count >= 20 {
        return Err(err(StatusCode::CONFLICT, "library_limit"));
    }
    sqlx::query(
        "INSERT INTO private_libraries(id,name,owner_id,visibility) VALUES($1,$2,$3,'private')",
    )
    .bind(id)
    .bind(name)
    .bind(u.id)
    .execute(&mut *tx)
    .await?;
    audit(&mut tx, id, u.id, "created", None).await?;
    let value = detail_value(&mut tx, u.id, id).await?;
    commit_caller(tx, &u, &h, false).await?;
    let committed = CommittedLibraryChange::new(id, value, false);
    Ok(committed)
}

pub(crate) async fn detail(db: &PgPool, u: User, id: Uuid) -> Result<Value> {
    let mut connection = db.acquire().await?;
    detail_value(&mut connection, u.id, id).await
}

pub(crate) async fn rename(
    db: &PgPool,
    u: User,
    h: HeaderMap,
    id: Uuid,
    body: Rename,
) -> Result<CommittedLibraryChange> {
    let name = name(&body.name)?;
    let mut tx = db.begin().await?;
    lock_caller(&mut tx, &u, &h, false).await?;
    lock_manage(&mut tx, u.id, id, revision(&body.expected_revision)?).await?;
    sqlx::query("UPDATE private_libraries SET name=$2,revision=revision+1 WHERE id=$1")
        .bind(id)
        .bind(name)
        .execute(&mut *tx)
        .await?;
    audit(&mut tx, id, u.id, "renamed", None).await?;
    let value = detail_value(&mut tx, u.id, id).await?;
    require_current_permission(&mut tx, u.id, id, "manage").await?;
    commit_caller(tx, &u, &h, false).await?;
    let committed = CommittedLibraryChange::new(id, value, false);
    Ok(committed)
}

pub(crate) async fn grant(
    db: &PgPool,
    u: User,
    h: HeaderMap,
    id: Uuid,
    body: Grant,
) -> Result<CommittedLibraryChange> {
    if !(1..=720).contains(&body.expires_in_hours)
        || !(body.browse || body.play || body.share_to_room || body.manage)
        || (body.share_to_room && !body.play)
    {
        return Err(err(StatusCode::BAD_REQUEST, "library_invalid"));
    }
    let mut tx = db.begin().await?;
    lock_caller(&mut tx, &u, &h, false).await?;
    let lib = lock_manage(&mut tx, u.id, id, revision(&body.expected_revision)?).await?;
    if lib.get::<String, _>("visibility") != "private" {
        return Err(err(StatusCode::BAD_REQUEST, "library_invalid"));
    }
    // Only the actual owner may delegate management, including changing an
    // existing manager. Managers cannot mint their own ownership authority.
    if lib.get::<Option<Uuid>, _>("owner_id") != Some(u.id) {
        return Err(err(StatusCode::FORBIDDEN, "library_owner_required"));
    }
    let target: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username=$1")
        .bind(body.username)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "user_not_found"))?;
    if Some(target) == lib.get::<Option<Uuid>, _>("owner_id") {
        return Err(err(StatusCode::BAD_REQUEST, "library_invalid"));
    }
    sqlx::query("INSERT INTO library_grants(library_id,user_id,browse,play,share_to_room,manage,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 hour',$8) ON CONFLICT(library_id,user_id) DO UPDATE SET browse=EXCLUDED.browse,play=EXCLUDED.play,share_to_room=EXCLUDED.share_to_room,manage=EXCLUDED.manage,expires_at=EXCLUDED.expires_at,created_by=EXCLUDED.created_by")
      .bind(id).bind(target).bind(body.browse).bind(body.play).bind(body.share_to_room).bind(body.manage).bind(i64::from(body.expires_in_hours)).bind(u.id).execute(&mut *tx).await?;
    advance(&mut tx, id, true).await?;
    audit(&mut tx, id, u.id, "grant_updated", Some(target)).await?;
    let value = detail_value(&mut tx, u.id, id).await?;
    commit_caller(tx, &u, &h, false).await?;
    let committed = CommittedLibraryChange::new(id, value, true);
    Ok(committed)
}

pub(crate) async fn revoke(
    db: &PgPool,
    u: User,
    h: HeaderMap,
    id: Uuid,
    target: Uuid,
    body: Expected,
) -> Result<CommittedLibraryChange> {
    let mut tx = db.begin().await?;
    lock_caller(&mut tx, &u, &h, false).await?;
    let lib = lock_manage(&mut tx, u.id, id, revision(&body.expected_revision)?).await?;
    if lib.get::<Option<Uuid>, _>("owner_id") != Some(u.id) {
        return Err(err(StatusCode::FORBIDDEN, "library_owner_required"));
    }
    sqlx::query("DELETE FROM library_grants WHERE library_id=$1 AND user_id=$2")
        .bind(id)
        .bind(target)
        .execute(&mut *tx)
        .await?;
    advance(&mut tx, id, true).await?;
    audit(&mut tx, id, u.id, "grant_revoked", Some(target)).await?;
    let value = detail_value(&mut tx, u.id, id).await?;
    commit_caller(tx, &u, &h, false).await?;
    let committed = CommittedLibraryChange::new(id, value, true);
    Ok(committed)
}

pub(crate) async fn remove(
    context: SourceWriteContext<'_>,
    u: User,
    h: HeaderMap,
    id: Uuid,
    body: Expected,
) -> Result<CommittedLibraryChange> {
    let mut tx = context.db.begin().await?;
    lock_caller(&mut tx, &u, &h, false).await?;
    let lib = lock_manage(&mut tx, u.id, id, revision(&body.expected_revision)?).await?;
    if id == Uuid::from_u128(1) || lib.get::<String, _>("visibility") != "private" {
        return Err(err(StatusCode::CONFLICT, "library_shared_protected"));
    }
    if lib.get::<Option<Uuid>, _>("owner_id") != Some(u.id) {
        return Err(err(StatusCode::FORBIDDEN, "library_owner_required"));
    }
    sqlx::query("SELECT id FROM sources WHERE library_id=$1 ORDER BY id FOR UPDATE")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let managed_elsewhere: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sources WHERE library_id=$1 AND deleted_at IS NULL AND kind='agent')")
        .bind(id).fetch_one(&mut *tx).await?;
    if managed_elsewhere {
        // Device pairing has a separate lifecycle. Never revoke a device as
        // an implicit side effect of a library owner's configuration removal.
        return Err(err(StatusCode::CONFLICT, "library_managed_sources"));
    }
    require_idle_sources(&mut tx, id, None).await?;
    let empty = (context.encrypt)(&json!({}))?;
    sqlx::query("UPDATE sources SET config_encrypted=$2,deleted_at=clock_timestamp() WHERE library_id=$1 AND deleted_at IS NULL")
        .bind(id).bind(empty).execute(&mut *tx).await?;
    sqlx::query("UPDATE media_items SET available=false WHERE source_id IN(SELECT id FROM sources WHERE library_id=$1)")
        .bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM library_grants WHERE library_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE room_media_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE library_id=$1")
        .bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE private_libraries SET deleted_at=clock_timestamp(),revision=revision+1,permission_epoch=permission_epoch+1 WHERE id=$1")
        .bind(id).execute(&mut *tx).await?;
    audit(&mut tx, id, u.id, "library_deleted", None).await?;
    commit_caller(tx, &u, &h, false).await?;
    let committed = CommittedLibraryChange::new(id, json!({"id":id,"deleted":true}), true);
    Ok(committed)
}

pub(crate) async fn transfer(
    db: &PgPool,
    u: User,
    h: HeaderMap,
    id: Uuid,
    body: Transfer,
) -> Result<CommittedLibraryChange> {
    let mut tx = db.begin().await?;
    lock_caller(&mut tx, &u, &h, false).await?;
    let lib = lock_manage(&mut tx, u.id, id, revision(&body.expected_revision)?).await?;
    if lib.get::<Option<Uuid>, _>("owner_id") != Some(u.id) {
        return Err(err(StatusCode::FORBIDDEN, "library_owner_required"));
    }
    let target: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username=$1")
        .bind(body.username)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "user_not_found"))?;
    if target == u.id {
        return Err(err(StatusCode::BAD_REQUEST, "library_invalid"));
    }
    sqlx::query("UPDATE private_libraries SET owner_id=$2,revision=revision+1,permission_epoch=permission_epoch+1 WHERE id=$1").bind(id).bind(target).execute(&mut *tx).await?;
    // Ownership transfer is explicit: no implicit continuing grant to old owner.
    sqlx::query("DELETE FROM library_grants WHERE library_id=$1 AND user_id IN($2,$3)")
        .bind(id)
        .bind(target)
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
    audit(&mut tx, id, u.id, "ownership_transferred", Some(target)).await?;
    commit_caller(tx, &u, &h, false).await?;
    let committed = CommittedLibraryChange::new(
        id,
        json!({"id":id,"owner_id":target,"transferred":true}),
        true,
    );
    Ok(committed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_and_revisions_are_bounded() {
        assert!(name("  私人片库  ").is_ok());
        assert!(name("\n").is_err());
        assert!(name(&"a".repeat(101)).is_err());
        assert!(revision("1").is_ok());
        for value in ["0", "-1", "1.0", " 1", "9223372036854775807"] {
            assert!(revision(value).is_err());
        }
    }
}
