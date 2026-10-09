//! Named room shares use cases; transaction ownership stays here.
use super::libraries::{Expected, revision};
use super::library_authority::*;
use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Share {
    room_id: Uuid,
    media_id: Uuid,
    mode: String,
    expires_in_minutes: u32,
    expected_revision: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateShare {
    mode: String,
    expires_at: i64,
    expected_revision: String,
}

async fn preserve_current_room_shares(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    library: Uuid,
    previous_epoch: i64,
) -> Result<()> {
    // Only carry still-valid rows over the playback fence. A stale epoch,
    // changed source, expired grant, or revoked share must never be revived.
    sqlx::query("UPDATE room_media_grants g SET permission_epoch=$3 FROM media_items m JOIN sources s ON s.id=m.source_id WHERE g.library_id=$1 AND g.media_id=m.id AND s.library_id=$1 AND s.deleted_at IS NULL AND g.permission_epoch=$2 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.source_generation=m.library_source_generation AND m.available AND library_allowed(g.grantor_id,$1,'share_to_room')")
        .bind(library).bind(previous_epoch).bind(previous_epoch+1).execute(&mut **tx).await?;
    Ok(())
}

pub(crate) async fn share(
    db: &PgPool,
    u: User,
    h: HeaderMap,
    id: Uuid,
    body: Share,
) -> Result<Value> {
    if !matches!(body.mode.as_str(), "room_members" | "library_members")
        || !(1..=1440).contains(&body.expires_in_minutes)
    {
        return Err(err(StatusCode::BAD_REQUEST, "library_invalid"));
    }
    let mut tx = db.begin().await?;
    // Global ordering matches room playback: room, membership, library, source, media.
    let room: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM rooms WHERE id=$1 AND lifecycle='active' FOR SHARE")
            .bind(body.room_id)
            .fetch_optional(&mut *tx)
            .await?;
    if room.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "room_not_found"));
    }
    let member: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(body.room_id)
    .bind(u.id)
    .fetch_optional(&mut *tx)
    .await?;
    if member.is_none() {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    lock_caller(&mut tx, &u, &h, false).await?;
    let lib=sqlx::query("SELECT * FROM private_libraries WHERE id=$1 AND library_allowed($2,id,'share_to_room') FOR UPDATE").bind(id).bind(u.id).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::NOT_FOUND,"library_not_found"))?;
    if lib.get::<i64, _>("revision") != revision(&body.expected_revision)? {
        return Err(err(StatusCode::CONFLICT, "library_conflict"));
    }
    let source_generation:i64=sqlx::query_scalar("SELECT m.library_source_generation FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND s.library_id=$2 AND m.available AND library_media_allowed($3,m.id,'share_to_room',NULL) FOR SHARE OF m,s")
      .bind(body.media_id).bind(id).bind(u.id).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::NOT_FOUND,"media_not_found"))?;
    let grant = Uuid::new_v4();
    sqlx::query("INSERT INTO room_media_grants(id,library_id,media_id,source_generation,room_id,grantor_id,mode,permission_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+$9*interval '1 minute')")
      .bind(grant).bind(id).bind(body.media_id).bind(source_generation).bind(body.room_id).bind(u.id).bind(body.mode).bind(lib.get::<i64,_>("permission_epoch")).bind(i64::from(body.expires_in_minutes)).execute(&mut *tx).await?;
    advance(&mut tx, id, false).await?;
    audit(&mut tx, id, u.id, "room_media_shared", Some(grant)).await?;
    require_current_permission(&mut tx, u.id, id, "share_to_room").await?;
    commit_caller(tx, &u, &h, false).await?;
    Ok(json!({"id":grant,"library_id":id,"revision":(lib.get::<i64,_>("revision")+1).to_string()}))
}

pub(crate) async fn update_share(
    db: &PgPool,
    u: User,
    h: HeaderMap,
    id: Uuid,
    grant: Uuid,
    body: UpdateShare,
) -> Result<CommittedLibraryChange> {
    if !matches!(body.mode.as_str(), "room_members" | "library_members") || body.expires_at <= 0 {
        return Err(err(StatusCode::BAD_REQUEST, "library_invalid"));
    }
    let mut tx = db.begin().await?;
    // Read only a currently authorized target before taking locks in playback
    // order: room, membership, caller, library, source/media, then share.
    let room: Uuid = sqlx::query_scalar("SELECT g.room_id FROM room_media_grants g WHERE g.id=$1 AND g.library_id=$2 AND library_allowed($3,$2,'share_to_room') AND (g.grantor_id=$3 OR library_allowed($3,$2,'manage'))")
        .bind(grant).bind(id).bind(u.id).fetch_optional(&mut *tx).await?
        .ok_or_else(||err(StatusCode::NOT_FOUND,"library_not_found"))?;
    let active_room: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM rooms WHERE id=$1 AND lifecycle='active' FOR SHARE")
            .bind(room)
            .fetch_optional(&mut *tx)
            .await?;
    if active_room.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "room_not_found"));
    }
    let member: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(room)
    .bind(u.id)
    .fetch_optional(&mut *tx)
    .await?;
    if member.is_none() {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    lock_caller(&mut tx, &u, &h, false).await?;
    let lib = sqlx::query("SELECT * FROM private_libraries WHERE id=$1 AND library_allowed($2,id,'share_to_room') FOR UPDATE")
        .bind(id).bind(u.id).fetch_optional(&mut *tx).await?
        .ok_or_else(||err(StatusCode::NOT_FOUND,"library_not_found"))?;
    if lib.get::<i64, _>("revision") != revision(&body.expected_revision)? {
        return Err(err(StatusCode::CONFLICT, "library_conflict"));
    }
    let epoch = lib.get::<i64, _>("permission_epoch");
    let current = sqlx::query("SELECT g.id,floor(extract(epoch FROM g.expires_at)*1000)::bigint AS previous_expiry,(to_timestamp($5::double precision/1000)>clock_timestamp() AND to_timestamp($5::double precision/1000)<=g.created_at+interval '24 hours') AS expiry_valid FROM room_media_grants g JOIN media_items m ON m.id=g.media_id JOIN sources s ON s.id=m.source_id WHERE g.id=$1 AND g.library_id=$2 AND g.room_id=$6 AND s.library_id=$2 AND s.deleted_at IS NULL AND g.permission_epoch=$3 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.source_generation=m.library_source_generation AND m.available AND library_allowed(g.grantor_id,$2,'share_to_room') AND (g.grantor_id=$4 OR library_allowed($4,$2,'manage')) FOR SHARE OF m,s")
        .bind(grant).bind(id).bind(epoch).bind(u.id).bind(body.expires_at).bind(room)
        .fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::CONFLICT,"library_share_inactive"))?;
    if !current.get::<bool, _>("expiry_valid") {
        return Err(err(StatusCode::BAD_REQUEST, "library_share_expiry_invalid"));
    }
    sqlx::query("UPDATE room_media_grants SET mode=$3,expires_at=to_timestamp($4::double precision/1000) WHERE id=$1 AND library_id=$2")
        .bind(grant).bind(id).bind(body.mode).bind(body.expires_at).execute(&mut *tx).await?;
    advance(&mut tx, id, true).await?;
    // Fence previously issued playback without invalidating other current
    // shares, and never revive grants already stale at the old epoch.
    preserve_current_room_shares(&mut tx, id, epoch).await?;
    audit(&mut tx, id, u.id, "room_media_updated", Some(grant)).await?;
    require_current_permission(&mut tx, u.id, id, "share_to_room").await?;
    let still_live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM room_media_grants WHERE id=$1 AND library_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND to_timestamp($3::double precision/1000)>clock_timestamp() AND library_allowed(grantor_id,library_id,'share_to_room') AND (grantor_id=$4 OR library_allowed($4,library_id,'manage')))")
        .bind(grant).bind(id).bind(current.get::<i64,_>("previous_expiry")).bind(u.id).fetch_one(&mut *tx).await?;
    if !still_live {
        return Err(err(StatusCode::CONFLICT, "library_share_inactive"));
    }
    commit_caller(tx, &u, &h, false).await?;
    let committed = CommittedLibraryChange::new(
        id,
        json!({"id":grant,"revision":(lib.get::<i64, _>("revision")+1).to_string()}),
        true,
    );
    Ok(committed)
}

pub(crate) async fn revoke_share(
    db: &PgPool,
    u: User,
    h: HeaderMap,
    id: Uuid,
    grant: Uuid,
    body: Expected,
) -> Result<CommittedLibraryChange> {
    let mut tx = db.begin().await?;
    lock_caller(&mut tx, &u, &h, false).await?;
    let lib=sqlx::query("SELECT * FROM private_libraries WHERE id=$1 AND deleted_at IS NULL AND (library_allowed($2,id,'manage') OR EXISTS(SELECT 1 FROM room_media_grants g WHERE g.id=$3 AND g.library_id=$1 AND g.grantor_id=$2)) FOR UPDATE").bind(id).bind(u.id).bind(grant).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::NOT_FOUND,"library_not_found"))?;
    if lib.get::<i64, _>("revision") != revision(&body.expected_revision)? {
        return Err(err(StatusCode::CONFLICT, "library_conflict"));
    }
    let result=sqlx::query("UPDATE room_media_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND library_id=$2").bind(grant).bind(id).execute(&mut *tx).await?;
    if result.rows_affected() == 0 {
        return Err(err(StatusCode::NOT_FOUND, "library_not_found"));
    }
    advance(&mut tx, id, true).await?;
    preserve_current_room_shares(&mut tx, id, lib.get::<i64, _>("permission_epoch")).await?;
    audit(&mut tx, id, u.id, "room_media_revoked", Some(grant)).await?;
    // A grantor may always withdraw their own share, but another grantor's
    // share still requires management authority after any lock wait.
    let allowed: bool = sqlx::query_scalar("SELECT library_allowed($1,$2,'manage') OR EXISTS(SELECT 1 FROM room_media_grants WHERE id=$3 AND library_id=$2 AND grantor_id=$1)")
        .bind(u.id).bind(id).bind(grant).fetch_one(&mut *tx).await?;
    if !allowed {
        return Err(err(StatusCode::NOT_FOUND, "library_not_found"));
    }
    commit_caller(tx, &u, &h, false).await?;
    let committed = CommittedLibraryChange::new(id, json!({"ok":true}), true);
    Ok(committed)
}
