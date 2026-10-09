//! Explicitly scoped libraries. Host administrators are trusted operators, but
//! normal catalog access still requires the same user/room grant as everyone else.
use super::*;
use sqlx::Connection;

pub fn enabled() -> bool {
    std::env::var("PRIVATE_LIBRARIES_ENABLED").is_ok_and(|v| v == "true")
}
fn require_enabled() -> Result<()> {
    if enabled() {
        Ok(())
    } else {
        Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "private_libraries_disabled",
        ))
    }
}
pub async fn authorize_media(
    app: &App,
    user: Uuid,
    media: Uuid,
    action: &str,
    room: Option<Uuid>,
) -> Result<()> {
    let ok: bool = sqlx::query_scalar("SELECT library_media_allowed($1,$2,$3,$4)")
        .bind(user)
        .bind(media)
        .bind(action)
        .bind(room)
        .fetch_one(&app.db)
        .await?;
    if ok {
        Ok(())
    } else {
        Err(err(StatusCode::NOT_FOUND, "media_not_found"))
    }
}
fn name(v: &str) -> Result<String> {
    let v = v.trim();
    if !(1..=100).contains(&v.chars().count()) || v.chars().any(|c| c.is_control()) {
        return Err(err(StatusCode::BAD_REQUEST, "library_invalid"));
    }
    Ok(v.to_owned())
}
fn revision(v: &str) -> Result<i64> {
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
const LIB_SELECT: &str = "SELECT l.*,library_allowed($1,l.id,'browse') AS browse,library_allowed($1,l.id,'play') AS play,library_allowed($1,l.id,'share_to_room') AS share_to_room,library_allowed($1,l.id,'manage') AS manage FROM private_libraries l";
pub async fn list(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    let rows=sqlx::query(&format!("{LIB_SELECT} WHERE library_allowed($1,l.id,'browse') OR library_allowed($1,l.id,'manage') ORDER BY l.name,l.id"))
        .bind(u.id).fetch_all(&app.db).await?;
    Ok(responses::ok_json(
        json!({"enabled":enabled(),"items":rows.iter().map(library_value).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
pub struct IssuedSharesQuery {
    after: Option<Uuid>,
}
pub async fn issued_shares(
    State(app): State<App>,
    h: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<IssuedSharesQuery>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    // Grantors can withdraw their own records after losing library access.
    // Return no source configuration, other grantors, or inaccessible titles.
    let rows = sqlx::query("SELECT g.id,g.library_id,g.media_id,g.room_id,g.mode,l.revision,CASE WHEN s.library_id=l.id AND s.deleted_at IS NULL AND library_allowed($1,l.id,'browse') THEN m.title ELSE NULL END AS title,floor(extract(epoch FROM g.expires_at)*1000)::bigint AS expiry,(g.permission_epoch=l.permission_epoch AND s.library_id=l.id AND s.deleted_at IS NULL AND g.source_generation=m.library_source_generation AND m.available AND g.expires_at>clock_timestamp() AND library_allowed($1,l.id,'share_to_room')) AS active FROM room_media_grants g JOIN private_libraries l ON l.id=g.library_id JOIN media_items m ON m.id=g.media_id JOIN sources s ON s.id=m.source_id WHERE g.grantor_id=$1 AND g.revoked_at IS NULL AND l.deleted_at IS NULL AND ($2::uuid IS NULL OR g.id>$2) ORDER BY g.id LIMIT 101")
        .bind(u.id).bind(query.after).fetch_all(&app.db).await?;
    let has_more = rows.len() > 100;
    let items = rows.iter().take(100).map(|r| json!({"id":r.get::<Uuid,_>("id"),"library_id":r.get::<Uuid,_>("library_id"),"revision":r.get::<i64,_>("revision").to_string(),"media_id":r.get::<Uuid,_>("media_id"),"room_id":r.get::<Uuid,_>("room_id"),"mode":r.get::<String,_>("mode"),"title":r.get::<Option<String>,_>("title"),"expires_at":r.get::<i64,_>("expiry"),"active":r.get::<bool,_>("active")})).collect::<Vec<_>>();
    Ok(responses::ok_json(
        json!({"items":items,"has_more":has_more}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    name: String,
}
pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Create>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let name = name(&body.name)?;
    let id = Uuid::new_v4();
    let mut tx = app.db.begin().await?;
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
    Ok(responses::ok_json(committed.response(&app.db).await))
}
pub async fn detail(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    let mut connection = app.db.acquire().await?;
    Ok(responses::ok_json(
        detail_value(&mut connection, u.id, id).await?,
    ))
}

// Reads may use an ordinary pooled connection. Mutation receipts use their
// existing transaction, before final expiry checks and confirmed commit.
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
async fn lock_manage(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    id: Uuid,
    expected: i64,
) -> Result<sqlx::postgres::PgRow> {
    let row=sqlx::query("SELECT l.* FROM private_libraries l WHERE l.id=$2 AND library_allowed($1,l.id,'manage') FOR UPDATE")
        .bind(user).bind(id).fetch_optional(&mut **tx).await?.ok_or_else(||err(StatusCode::NOT_FOUND,"library_not_found"))?;
    if row.get::<i64, _>("revision") != expected {
        return Err(err(StatusCode::CONFLICT, "library_conflict"));
    }
    Ok(row)
}
async fn lock_caller(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: &User,
    h: &HeaderMap,
    operator: bool,
) -> Result<()> {
    let login = media_authorization::login_hash(h)?;
    let admin: Option<bool> = sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 FOR SHARE")
        .bind(user.id)
        .fetch_optional(&mut **tx)
        .await?;
    if admin.is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    if operator && admin != Some(true) {
        return Err(err(StatusCode::FORBIDDEN, "admin_required"));
    }
    let live:Option<Uuid>=sqlx::query_scalar("SELECT user_id FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE").bind(login).bind(user.id).fetch_optional(&mut **tx).await?;
    if live.is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    Ok(())
}
async fn commit_caller(
    mut tx: sqlx::Transaction<'_, sqlx::Postgres>,
    user: &User,
    h: &HeaderMap,
    operator: bool,
) -> Result<()> {
    // Time may pass while waiting for a library/source lock. A locked login can
    // still expire, so check database time again immediately before commit.
    lock_caller(&mut tx, user, h, operator).await?;
    tx.commit().await?;
    Ok(())
}
async fn audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    lib: Uuid,
    actor: Uuid,
    action: &str,
    target: Option<Uuid>,
) -> Result<()> {
    sqlx::query("INSERT INTO library_permission_audit(library_id,actor_id,action,target_id,permission_epoch) SELECT id,$2,$3,$4,permission_epoch FROM private_libraries WHERE id=$1")
        .bind(lib).bind(actor).bind(action).bind(target).execute(&mut **tx).await?;
    Ok(())
}
async fn advance(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    lib: Uuid,
    permissions: bool,
) -> Result<()> {
    sqlx::query("UPDATE private_libraries SET revision=revision+1,permission_epoch=permission_epoch+CASE WHEN $2 THEN 1 ELSE 0 END WHERE id=$1")
        .bind(lib).bind(permissions).execute(&mut **tx).await?;
    Ok(())
}
/// Construct only after the original transaction confirms COMMIT. This receipt
/// carries the response captured under that transaction's authority, not a new
/// post-commit read or permission token. COMMIT errors still propagate.
struct CommittedLibraryChange {
    library: Uuid,
    value: Value,
    retirement_required: bool,
}
impl CommittedLibraryChange {
    fn new(library: Uuid, value: Value, retirement_required: bool) -> Self {
        Self {
            library,
            value,
            retirement_required,
        }
    }
    async fn response(self, db: &PgPool) -> Value {
        if self.retirement_required && retire(db).await.is_err() {
            // Existing epoch/source predicates fence use immediately; the
            // existing maintenance coordinator retries logical retirement.
            // This is not a physical resource-disposal receipt.
            tracing::warn!(library = %self.library, cleanup = "pending", "library change committed; retirement deferred to maintenance");
        }
        self.value
    }
}

pub(crate) async fn retire(db: &PgPool) -> Result<()> {
    // Preserve the eager path's original transaction and commit-observation order.
    let mut tx = db.begin().await?;
    let obs = retire_rows(&mut tx).await?.into_commit_observation();
    tx.commit().await?;
    obs.confirmed();
    Ok(())
}

// The same SQL operation serves eager retirement and bounded maintenance. It
// starts no process/network disposal and never owns a second transaction.
async fn retire_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
) -> Result<media_core::job_health::PendingJobHealth> {
    // Do not hold library locks while locking playback/jobs. Reader predicates
    // already reject old epochs; process-local cancellation observes stopped.
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE NOT stopped AND NOT playback_library_session_allowed(id)")
        .execute(&mut **tx).await?;
    Ok(persistence::media_job_timing::cancel_jobs(
        &mut **tx,
        persistence::media_job_timing::CancellationScope::StoppedSessions,
    )
    .await?)
}

// Follow upstream_policy's connection ownership: an interrupted or failed
// attempt discards its connection rather than returning uncertain SQL to the pool.
// Normal release is allowed only after the transaction confirms its commit.
struct RetirementConnection(Option<sqlx::pool::PoolConnection<sqlx::Postgres>>);
impl Drop for RetirementConnection {
    fn drop(&mut self) {
        if let Some(connection) = &mut self.0 {
            connection.close_on_drop();
        }
    }
}
impl RetirementConnection {
    fn release(&mut self) {
        drop(self.0.take());
    }
}

pub(crate) async fn retire_maintenance(db: &PgPool) -> Result<()> {
    // Include pool acquisition, transaction start and COMMIT in the overall
    // budget. A timeout is only an unfinished attempt, never disposal evidence.
    let attempt = async {
        let mut connection = RetirementConnection(Some(db.acquire().await?));
        let mut tx = connection
            .0
            .as_mut()
            .expect("retirement connection")
            .begin()
            .await?;
        // Same bounded SQL convention as room cleanup; only this background
        // attempt receives limits. The eager receipt path is unchanged.
        sqlx::query("SET LOCAL lock_timeout='2s'")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SET LOCAL statement_timeout='3s'")
            .execute(&mut *tx)
            .await?;
        let obs = retire_rows(&mut tx).await?.into_commit_observation();
        tx.commit().await?;
        obs.confirmed();
        connection.release();
        Ok::<(), Error>(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), attempt)
        .await
        .map_err(|_| anyhow::anyhow!("library_retirement_timeout"))?
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rename {
    name: String,
    expected_revision: String,
}
pub async fn rename(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Rename>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let name = name(&body.name)?;
    let mut tx = app.db.begin().await?;
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
    Ok(responses::ok_json(committed.response(&app.db).await))
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
pub async fn grant(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Grant>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    if !(1..=720).contains(&body.expires_in_hours)
        || !(body.browse || body.play || body.share_to_room || body.manage)
        || (body.share_to_room && !body.play)
    {
        return Err(err(StatusCode::BAD_REQUEST, "library_invalid"));
    }
    let mut tx = app.db.begin().await?;
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
    Ok(responses::ok_json(committed.response(&app.db).await))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expected {
    expected_revision: String,
}
pub async fn revoke(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, target)): Path<(Uuid, Uuid)>,
    Json(body): Json<Expected>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let mut tx = app.db.begin().await?;
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
    Ok(responses::ok_json(committed.response(&app.db).await))
}
/// Archive the scope rather than deleting rows referenced by audit, playback,
/// playlists and compute. No source is detached or reassigned to shared scope.
pub async fn remove(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Expected>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let mut tx = app.db.begin().await?;
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
    let empty = app.encrypt(&json!({}))?;
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
    Ok(responses::ok_json(committed.response(&app.db).await))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transfer {
    username: String,
    expected_revision: String,
}
pub async fn transfer(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Transfer>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let mut tx = app.db.begin().await?;
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
    Ok(responses::ok_json(committed.response(&app.db).await))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Share {
    room_id: Uuid,
    media_id: Uuid,
    mode: String,
    expires_in_minutes: u32,
    expected_revision: String,
}
pub async fn share(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Share>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    if !matches!(body.mode.as_str(), "room_members" | "library_members")
        || !(1..=1440).contains(&body.expires_in_minutes)
    {
        return Err(err(StatusCode::BAD_REQUEST, "library_invalid"));
    }
    let mut tx = app.db.begin().await?;
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
    Ok(responses::ok_json(
        json!({"id":grant,"library_id":id,"revision":(lib.get::<i64,_>("revision")+1).to_string()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateShare {
    mode: String,
    expires_at: i64,
    expected_revision: String,
}
pub async fn update_share(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, grant)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateShare>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    if !matches!(body.mode.as_str(), "room_members" | "library_members") || body.expires_at <= 0 {
        return Err(err(StatusCode::BAD_REQUEST, "library_invalid"));
    }
    let mut tx = app.db.begin().await?;
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
    Ok(responses::ok_json(committed.response(&app.db).await))
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
pub async fn revoke_share(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, grant)): Path<(Uuid, Uuid)>,
    Json(body): Json<Expected>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let mut tx = app.db.begin().await?;
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
    Ok(responses::ok_json(committed.response(&app.db).await))
}
#[derive(Deserialize)]
pub struct MediaQuery {
    after: Option<Uuid>,
    limit: Option<i64>,
    #[serde(default)]
    search: String,
}
pub async fn media(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<MediaQuery>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    let allowed: bool = sqlx::query_scalar("SELECT library_allowed($1,$2,'browse')")
        .bind(u.id)
        .bind(id)
        .fetch_one(&app.db)
        .await?;
    if !allowed {
        return Err(err(StatusCode::NOT_FOUND, "library_not_found"));
    }
    let rows=sqlx::query(&format!("{} WHERE {} AND s.library_id=$2 AND library_media_allowed($1,m.id,'browse',NULL) AND ($3::uuid IS NULL OR m.id>$3) AND strpos(lower(COALESCE(u.title,m.shared_title,m.title)),lower($4))>0 ORDER BY m.id LIMIT $5",media_titles::SELECT,media_titles::VISIBLE))
      .bind(u.id).bind(id).bind(q.after).bind(q.search).bind(q.limit.unwrap_or(100).clamp(1,200)).fetch_all(&app.db).await?;
    Ok(responses::ok_json(json!(
        rows.iter().map(media_titles::media).collect::<Vec<_>>()
    )))
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    name: String,
    kind: String,
    config: providers::SourceConfig,
}
pub async fn add_source(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(mut body): Json<Source>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    if !matches!(body.kind.as_str(), "http" | "s3") {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_source"));
    }
    let name = name(&body.name)?;
    if !u.admin && body.kind == "http" {
        if body.config.access_policy.is_some()
            || body.config.advanced_assets.is_some()
            || !body.config.root.is_empty()
            || !body.config.token.is_empty()
            || !body.config.user_id.is_empty()
            || !body.config.agent_id.is_empty()
        {
            return Err(err(StatusCode::FORBIDDEN, "admin_required"));
        }
        body.config.access_policy = Some(
            providers::access_policy::SourceAccessPolicy::public_origin(&body.config.url)
                .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source_url"))?,
        );
    }
    if body.kind == "s3" {
        // Credential environment bindings belong to the trusted operator. A
        // library owner cannot pick another owner's already-provisioned secret.
        admin(&u)?;
        providers::s3::validate_config(&body.config)
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    } else if body.config.s3.is_some() {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_source"));
    }
    providers::access_policy::SourceAccess::new(
        &body.config.url,
        body.config.access_policy.as_ref(),
    )
    .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source_url"))?;
    providers::validate_source_headers(&body.config.headers)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    let mut tx = app.db.begin().await?;
    lock_caller(&mut tx, &u, &h, u.admin).await?;
    let allowed:Option<Uuid>=sqlx::query_scalar("SELECT id FROM private_libraries WHERE id=$1 AND library_allowed($2,id,'manage') FOR UPDATE").bind(id).bind(u.id).fetch_optional(&mut *tx).await?;
    if allowed.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "library_not_found"));
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sources WHERE library_id=$1 AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if count >= 100 {
        return Err(err(StatusCode::CONFLICT, "library_source_limit"));
    }
    let source = Uuid::new_v4();
    let config = app.encrypt(&serde_json::to_value(body.config).map_err(anyhow::Error::from)?)?;
    sqlx::query(
        "INSERT INTO sources(id,name,kind,config_encrypted,library_id) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(source)
    .bind(name)
    .bind(body.kind)
    .bind(config)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    advance(&mut tx, id, false).await?;
    audit(&mut tx, id, u.id, "source_created", Some(source)).await?;
    require_current_permission(&mut tx, u.id, id, "manage").await?;
    commit_caller(tx, &u, &h, u.admin).await?;
    Ok(responses::ok_json(json!({"id":source,"library_id":id})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceChange {
    expected_revision: String,
    name: Option<String>,
    config: Option<serde_json::Map<String, Value>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceExpected {
    expected_revision: String,
    expected_library_revision: String,
}
async fn require_current_permission(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    library: Uuid,
    action: &str,
) -> Result<()> {
    // Row locks freeze configuration, not the wall-clock expiry of a grant.
    let allowed: bool = sqlx::query_scalar("SELECT library_allowed($1,$2,$3)")
        .bind(user)
        .bind(library)
        .bind(action)
        .fetch_one(&mut **tx)
        .await?;
    if !allowed {
        return Err(err(StatusCode::NOT_FOUND, "library_not_found"));
    }
    Ok(())
}
async fn lock_source_library(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    library: Uuid,
) -> Result<()> {
    let allowed: Option<Uuid> = sqlx::query_scalar("SELECT id FROM private_libraries WHERE id=$1 AND library_allowed($2,id,'manage') FOR UPDATE")
        .bind(library).bind(user).fetch_optional(&mut **tx).await?;
    if allowed.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "library_not_found"));
    }
    Ok(())
}
fn manageable_scoped_source(row: &sqlx::postgres::PgRow) -> Result<()> {
    if !matches!(row.get::<String, _>("kind").as_str(), "http" | "s3") {
        return Err(err(StatusCode::CONFLICT, "source_managed_elsewhere"));
    }
    Ok(())
}
pub async fn source_detail(
    State(app): State<App>,
    h: HeaderMap,
    Path((library, source)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    let mut tx = app.db.begin().await?;
    lock_caller(&mut tx, &u, &h, false).await?;
    lock_source_library(&mut tx, u.id, library).await?;
    let row = sqlx::query(
        "SELECT * FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(source)
    .bind(library)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    manageable_scoped_source(&row)?;
    let config =
        source_settings::parse_config(&app.decrypt(&row.get::<String, _>("config_encrypted"))?)?;
    let value = source_settings::safe_detail(&row, &config);
    require_current_permission(&mut tx, u.id, library, "manage").await?;
    commit_caller(tx, &u, &h, false).await?;
    Ok(responses::ok_json(value))
}
pub async fn update_source(
    State(app): State<App>,
    h: HeaderMap,
    Path((library, source)): Path<(Uuid, Uuid)>,
    Json(body): Json<SourceChange>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let expected = source_settings::revision(&body.expected_revision)?;
    let operator = u.admin && body.config.is_some();
    let mut tx = app.db.begin().await?;
    lock_caller(&mut tx, &u, &h, operator).await?;
    lock_source_library(&mut tx, u.id, library).await?;
    let row = sqlx::query(
        "SELECT * FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(source)
    .bind(library)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    manageable_scoped_source(&row)?;
    if row.get::<i64, _>("settings_revision") != expected {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    let kind: String = row.get("kind");
    let old_raw = app.decrypt(&row.get::<String, _>("config_encrypted"))?;
    let old = source_settings::parse_config(&old_raw)?;
    let mut raw = old_raw.clone();
    if let Some(patch) = &body.config {
        if !u.admin
            && (kind == "s3"
                || patch
                    .keys()
                    .any(|key| !matches!(key.as_str(), "url" | "headers")))
        {
            return Err(err(StatusCode::FORBIDDEN, "admin_required"));
        }
        raw = source_settings::merge_config(&kind, &old_raw, patch)?;
        if !u.admin && patch.contains_key("url") {
            let url = raw["url"]
                .as_str()
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
            let policy = providers::access_policy::SourceAccessPolicy::public_origin(url)
                .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source_url"))?;
            raw["access_policy"] = serde_json::to_value(policy).map_err(anyhow::Error::from)?;
        }
    }
    let next = source_settings::parse_config(&raw)?;
    if kind == "http" && old.url != next.url {
        let same_origin = providers::validate_url(&old.url)
            .ok()
            .zip(providers::validate_url(&next.url).ok())
            .is_some_and(|(old, next)| old.origin() == next.origin());
        let explicit_headers = body
            .config
            .as_ref()
            .is_some_and(|patch| patch.contains_key("headers"));
        if !same_origin
            && ((!old.headers.is_empty() && !explicit_headers)
                || !old.token.is_empty()
                || !old.user_id.is_empty())
        {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "source_credentials_origin_changed",
            ));
        }
    }
    let changed = serde_json::to_value(&old).map_err(anyhow::Error::from)?
        != serde_json::to_value(&next).map_err(anyhow::Error::from)?;
    let next_name = body
        .name
        .as_deref()
        .map(source_settings::name)
        .transpose()?
        .unwrap_or_else(|| row.get("name"));
    if changed {
        source_settings::validate_config(&kind, &next)?;
        if kind == "s3" {
            providers::s3::validate_config(&next)
                .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
        }
        if kind == "http" && next.url != old.url {
            let collision:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_items WHERE source_id=$1 AND resource=$2) AND EXISTS(SELECT 1 FROM media_items WHERE source_id=$1 AND resource=$3)")
                .bind(source).bind(&next.url).bind(&old.url).fetch_one(&mut *tx).await?;
            if collision {
                return Err(err(StatusCode::CONFLICT, "source_changed"));
            }
            sqlx::query("UPDATE media_items SET resource=$3,metadata='{}'::jsonb,duration_ms=NULL,source_version=NULL WHERE source_id=$1 AND resource=$2")
                .bind(source).bind(&old.url).bind(&next.url).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE media_items SET available=false WHERE source_id=$1")
            .bind(source)
            .execute(&mut *tx)
            .await?;
    }
    let encrypted = if changed {
        app.encrypt(&raw)?
    } else {
        row.get("config_encrypted")
    };
    let updated =
        sqlx::query("UPDATE sources SET name=$2,config_encrypted=$3 WHERE id=$1 RETURNING *")
            .bind(source)
            .bind(next_name)
            .bind(encrypted)
            .fetch_one(&mut *tx)
            .await?;
    let did_change = updated.get::<i64, _>("settings_revision") != expected;
    if did_change {
        advance(&mut tx, library, false).await?;
        audit(&mut tx, library, u.id, "source_updated", Some(source)).await?;
    }
    let mut value = source_settings::safe_detail(&updated, &next);
    value["config_changed"] = json!(changed);
    value["rescan_required"] = json!(changed);
    require_current_permission(&mut tx, u.id, library, "manage").await?;
    commit_caller(tx, &u, &h, operator).await?;
    let committed = CommittedLibraryChange::new(library, value, changed);
    Ok(responses::ok_json(committed.response(&app.db).await))
}
async fn require_idle_sources(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    library: Uuid,
    source: Option<Uuid>,
) -> Result<()> {
    // Source locks are already held. Preparation admission takes a source share
    // lock, so no new reader can enter between this check and tombstoning.
    let in_use: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN media_items m ON m.id=p.media_id JOIN sources s ON s.id=m.source_id WHERE s.library_id=$1 AND ($2::uuid IS NULL OR s.id=$2) AND NOT p.stopped AND p.expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM upstream_reservations r JOIN sources s ON s.id=r.source_id WHERE s.library_id=$1 AND ($2::uuid IS NULL OR s.id=$2) AND (r.state IN('preparing','active','closing') OR r.io_claim IS NOT NULL OR r.io_uncertain))")
        .bind(library).bind(source).fetch_one(&mut **tx).await?;
    if in_use {
        let unconfirmed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM upstream_reservations r JOIN sources s ON s.id=r.source_id WHERE s.library_id=$1 AND ($2::uuid IS NULL OR s.id=$2) AND r.state='cleanup_failed' AND (r.io_uncertain OR r.io_claim IS NOT NULL))")
            .bind(library).bind(source).fetch_one(&mut **tx).await?;
        return Err(err(
            StatusCode::CONFLICT,
            if unconfirmed {
                "source_cleanup_unconfirmed"
            } else {
                "source_in_use"
            },
        ));
    }
    Ok(())
}

pub async fn remove_source(
    State(app): State<App>,
    h: HeaderMap,
    Path((library, source)): Path<(Uuid, Uuid)>,
    Json(body): Json<SourceExpected>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let mut tx = app.db.begin().await?;
    lock_caller(&mut tx, &u, &h, false).await?;
    lock_manage(
        &mut tx,
        u.id,
        library,
        revision(&body.expected_library_revision)?,
    )
    .await?;
    let row = sqlx::query(
        "SELECT * FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(source)
    .bind(library)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    manageable_scoped_source(&row)?;
    if row.get::<i64, _>("settings_revision") != source_settings::revision(&body.expected_revision)?
    {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    require_idle_sources(&mut tx, library, Some(source)).await?;
    let empty = app.encrypt(&json!({}))?;
    sqlx::query("UPDATE sources SET config_encrypted=$2,deleted_at=clock_timestamp() WHERE id=$1")
        .bind(source)
        .bind(empty)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE media_items SET available=false WHERE source_id=$1")
        .bind(source)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE room_media_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE library_id=$1 AND media_id IN(SELECT id FROM media_items WHERE source_id=$2)")
        .bind(library).bind(source).execute(&mut *tx).await?;
    advance(&mut tx, library, false).await?;
    audit(&mut tx, library, u.id, "source_deleted", Some(source)).await?;
    require_current_permission(&mut tx, u.id, library, "manage").await?;
    commit_caller(tx, &u, &h, false).await?;
    let committed = CommittedLibraryChange::new(library, json!({"id":source,"deleted":true}), true);
    Ok(responses::ok_json(committed.response(&app.db).await))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attach {
    source_id: Uuid,
    expected_revision: String,
}
pub async fn attach_source(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Attach>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    admin(&u)?;
    let mut tx = app.db.begin().await?;
    lock_caller(&mut tx, &u, &h, true).await?;
    // This is an explicit audited operator action. Normal private catalog reads
    // remain unavailable to an administrator without a library grant.
    let previous: Uuid =
        sqlx::query_scalar("SELECT library_id FROM sources WHERE id=$1 AND deleted_at IS NULL")
            .bind(body.source_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    sqlx::query("SELECT id FROM private_libraries WHERE id IN($1,$2) AND deleted_at IS NULL ORDER BY id FOR UPDATE")
        .bind(id)
        .bind(previous)
        .execute(&mut *tx)
        .await?;
    let lib = sqlx::query("SELECT * FROM private_libraries WHERE id=$1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "library_not_found"))?;
    if lib.get::<i64, _>("revision") != revision(&body.expected_revision)? {
        return Err(err(StatusCode::CONFLICT, "library_conflict"));
    }
    let current: Uuid = sqlx::query_scalar(
        "SELECT library_id FROM sources WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(body.source_id)
    .fetch_one(&mut *tx)
    .await?;
    if current != previous {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    if previous == id {
        return Err(err(StatusCode::CONFLICT, "source_already_attached"));
    }
    sqlx::query("UPDATE sources SET library_id=$2 WHERE id=$1")
        .bind(body.source_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    advance(&mut tx, id, true).await?;
    advance(&mut tx, previous, true).await?;
    audit(
        &mut tx,
        id,
        u.id,
        "operator_source_attached",
        Some(body.source_id),
    )
    .await?;
    audit(
        &mut tx,
        previous,
        u.id,
        "operator_source_detached",
        Some(body.source_id),
    )
    .await?;
    commit_caller(tx, &u, &h, true).await?;
    let committed = CommittedLibraryChange::new(
        id,
        json!({"ok":true,"library_id":id,"source_id":body.source_id}),
        true,
    );
    Ok(responses::ok_json(committed.response(&app.db).await))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct ScanRequest {
    #[serde(default)]
    restart: bool,
}
fn scan_value(row: &sqlx::postgres::PgRow) -> Value {
    json!({"scan_id":row.get::<Uuid,_>("scan_id"),"status":row.get::<String,_>("status"),"item_count":row.get::<i64,_>("item_count"),"page_count":row.get::<i64,_>("page_count"),"has_more":row.get::<Option<String>,_>("continuation_token").is_some(),"last_error":row.get::<Option<String>,_>("last_error")})
}
pub async fn scan_status(
    State(app): State<App>,
    h: HeaderMap,
    Path((lib, source)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL AND library_allowed($3,$2,'manage'))").bind(source).bind(lib).bind(user.id).fetch_one(&app.db).await?;
    if !allowed {
        return Err(err(StatusCode::NOT_FOUND, "source_not_found"));
    }
    let row = sqlx::query("SELECT * FROM s3_index_scans WHERE source_id=$1")
        .bind(source)
        .fetch_optional(&app.db)
        .await?;
    if row.is_none() {
        let http=sqlx::query("SELECT scan.generation,(SELECT count(*) FROM media_items m WHERE m.source_id=s.id AND m.available) AS item_count FROM sources s JOIN source_scans scan ON scan.source_id=s.id WHERE s.id=$1 AND s.kind='http'").bind(source).fetch_optional(&app.db).await?;
        if let Some(http) = http {
            return Ok(responses::ok_json(
                json!({"scan_id":http.get::<Uuid,_>("generation"),"status":"completed","item_count":http.get::<i64,_>("item_count"),"page_count":1,"has_more":false}),
            ));
        }
    }
    Ok(responses::ok_json(row.as_ref().map(scan_value).unwrap_or(
        json!({"status":"not_started","item_count":0,"page_count":0,"has_more":false}),
    )))
}
pub async fn scan(
    State(app): State<App>,
    h: HeaderMap,
    Path((lib, source)): Path<(Uuid, Uuid)>,
    Json(body): Json<ScanRequest>,
) -> Result<Response> {
    require_enabled()?;
    let user = auth(&app, &h, true).await?;
    let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL AND library_allowed($3,$2,'manage'))").bind(source).bind(lib).bind(user.id).fetch_one(&app.db).await?;
    if !allowed {
        return Err(err(StatusCode::NOT_FOUND, "source_not_found"));
    }
    Ok(responses::ok_json(
        scan_source_page_as(&app, source, body.restart, Some((user, h, lib))).await?,
    ))
}
/// One resumable, atomically checkpointed page. No detached scan can finish after
/// its source revision/cursor has changed. A failed page never removes old items.
pub async fn scan_source_page(app: &App, source: Uuid, restart: bool) -> Result<Value> {
    scan_source_page_as(app, source, restart, None).await
}
async fn lock_scan_caller(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    source: Uuid,
    caller: &Option<(User, HeaderMap, Uuid)>,
) -> Result<()> {
    if let Some((user, headers, library)) = caller {
        lock_caller(tx, user, headers, false).await?;
        let allowed:Option<Uuid>=sqlx::query_scalar("SELECT id FROM private_libraries WHERE id=$1 AND library_allowed($2,id,'manage') FOR SHARE").bind(library).bind(user.id).fetch_optional(&mut **tx).await?;
        let scope: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL)",
        )
        .bind(source)
        .bind(library)
        .fetch_one(&mut **tx)
        .await?;
        if allowed.is_none() || !scope {
            return Err(err(StatusCode::NOT_FOUND, "source_not_found"));
        }
    }
    Ok(())
}
async fn commit_scan(
    mut tx: sqlx::Transaction<'_, sqlx::Postgres>,
    caller: &Option<(User, HeaderMap, Uuid)>,
) -> Result<()> {
    if let Some((user, headers, library)) = caller {
        lock_caller(&mut tx, user, headers, false).await?;
        require_current_permission(&mut tx, user.id, *library, "manage").await?;
    }
    tx.commit().await?;
    Ok(())
}
async fn lock_scan_page(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    source: Uuid,
    caller: &Option<(User, HeaderMap, Uuid)>,
    source_revision: i64,
    scan_id: Uuid,
    cursor: &Option<String>,
) -> Result<sqlx::postgres::PgRow> {
    lock_scan_caller(tx, source, caller).await?;
    let source_current: i64 = sqlx::query_scalar(
        "SELECT access_policy_revision FROM sources WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(source)
    .fetch_one(&mut **tx)
    .await?;
    let row = sqlx::query("SELECT * FROM s3_index_scans WHERE source_id=$1 FOR UPDATE")
        .bind(source)
        .fetch_one(&mut **tx)
        .await?;
    let generation: Uuid =
        sqlx::query_scalar("SELECT generation FROM source_scans WHERE source_id=$1 FOR UPDATE")
            .bind(source)
            .fetch_one(&mut **tx)
            .await?;
    if source_current != source_revision
        || row.get::<Uuid, _>("scan_id") != scan_id
        || generation != scan_id
        || row.get::<Option<String>, _>("continuation_token") != *cursor
        || row.get::<String, _>("status") == "completed"
    {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    Ok(row)
}
async fn scan_source_page_as(
    app: &App,
    source: Uuid,
    restart: bool,
    caller: Option<(User, HeaderMap, Uuid)>,
) -> Result<Value> {
    use futures_util::StreamExt;
    static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    let _slot = SLOTS
        .get_or_init(|| tokio::sync::Semaphore::new(2))
        .try_acquire()
        .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "source_scan_busy"))?;
    let mut tx = app.db.begin().await?;
    lock_scan_caller(&mut tx, source, &caller).await?;
    let source_row = sqlx::query(
        "SELECT kind,config_encrypted,access_policy_revision FROM sources WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(source)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    let kind = source_row.get::<String, _>("kind");
    if kind == "http" {
        let config: providers::SourceConfig =
            serde_json::from_value(app.decrypt(&source_row.get::<String, _>("config_encrypted"))?)
                .map_err(anyhow::Error::from)?;
        let scan = Uuid::new_v4();
        let items = providers::list_items("http", &config)
            .await
            .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_scan_failed"))?;
        for item in &items {
            let mut metadata = item.metadata.clone();
            metadata["preview_scan"] = json!(scan);
            sqlx::query("INSERT INTO media_items(id,source_id,title,resource,metadata) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_id,resource) DO UPDATE SET title=EXCLUDED.title,metadata=EXCLUDED.metadata,duration_ms=NULL,source_version=NULL,available=true").bind(Uuid::new_v4()).bind(source).bind(&item.title).bind(&item.resource).bind(metadata).execute(&mut *tx).await?;
        }
        let resources = items.iter().map(|i| i.resource.clone()).collect::<Vec<_>>();
        sqlx::query(
            "UPDATE media_items SET available=false WHERE source_id=$1 AND NOT(resource=ANY($2))",
        )
        .bind(source)
        .bind(resources)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO source_scans(source_id,generation) VALUES($1,$2) ON CONFLICT(source_id) DO UPDATE SET generation=EXCLUDED.generation").bind(source).bind(scan).execute(&mut *tx).await?;
        sqlx::query("UPDATE media_items SET library_source_generation=library_source_generation+1 WHERE source_id=$1 AND available").bind(source).execute(&mut *tx).await?;
        commit_scan(tx, &caller).await?;
        return Ok(
            json!({"scan_id":scan,"status":"completed","item_count":items.len(),"page_count":1,"has_more":false}),
        );
    }
    if kind != "s3" {
        return Err(err(StatusCode::BAD_REQUEST, "s3_source_required"));
    }
    let config: providers::SourceConfig =
        serde_json::from_value(app.decrypt(&source_row.get::<String, _>("config_encrypted"))?)
            .map_err(anyhow::Error::from)?;
    let source_revision = source_row.get::<i64, _>("access_policy_revision");
    let existing = sqlx::query("SELECT * FROM s3_index_scans WHERE source_id=$1 FOR UPDATE")
        .bind(source)
        .fetch_optional(&mut *tx)
        .await?;
    let reset = restart
        || existing
            .as_ref()
            .is_some_and(|r| r.get::<i64, _>("source_revision") != source_revision);
    if !reset
        && let Some(row) = &existing
        && row.get::<String, _>("status") == "completed"
    {
        let result = scan_value(row);
        commit_scan(tx, &caller).await?;
        return Ok(result);
    }
    let (scan_id, cursor) = if let Some(r) = existing.as_ref().filter(|_| !reset) {
        (
            r.get::<Uuid, _>("scan_id"),
            r.get::<Option<String>, _>("continuation_token"),
        )
    } else {
        let scan_id = Uuid::new_v4();
        sqlx::query("INSERT INTO s3_index_scans(source_id,scan_id,source_revision,status) VALUES($1,$2,$3,'running') ON CONFLICT(source_id) DO UPDATE SET scan_id=EXCLUDED.scan_id,source_revision=EXCLUDED.source_revision,status='running',continuation_token=NULL,item_count=0,page_count=0,started_at=clock_timestamp(),completed_at=NULL,last_error=NULL,updated_at=clock_timestamp()")
          .bind(source).bind(scan_id).bind(source_revision).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM s3_index_scan_seen WHERE source_id=$1")
            .bind(source)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM s3_index_scan_cursors WHERE source_id=$1")
            .bind(source)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO source_scans(source_id,generation) VALUES($1,$2) ON CONFLICT(source_id) DO UPDATE SET generation=EXCLUDED.generation").bind(source).bind(scan_id).execute(&mut *tx).await?;
        (scan_id, None)
    };
    commit_scan(tx, &caller).await?;
    let fetch = async {
        let page = providers::s3::list_page(&config, cursor.as_deref(), 100).await?;
        let next = page.next_continuation_token;
        anyhow::ensure!(next.is_none() || next != cursor, "s3_cursor_repeated");
        let objects = futures_util::stream::iter(
            page.objects
                .into_iter()
                .filter(|obj| {
                    std::path::Path::new(&obj.key)
                        .extension()
                        .and_then(|v| v.to_str())
                        .is_some_and(|v| {
                            matches!(
                                v.to_ascii_lowercase().as_str(),
                                "mp4" | "mkv" | "webm" | "mov" | "m4v"
                            )
                        })
                })
                .map(|obj| {
                    let config = &config;
                    async move {
                        let head = providers::s3::head_object(
                            config,
                            &obj.key,
                            obj.version_id.as_deref(),
                            obj.etag.as_deref(),
                        )
                        .await?;
                        anyhow::ensure!(
                            head.size == obj.size && head.etag == obj.etag,
                            "s3_index_identity_changed"
                        );
                        Ok::<_, anyhow::Error>(head)
                    }
                }),
        )
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
        let objects = objects.into_iter().collect::<anyhow::Result<Vec<_>>>()?;
        Ok::<_, anyhow::Error>((objects, next))
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), fetch).await;
    let (objects, next) = match result {
        Ok(Ok(value)) => value,
        _ => {
            // A failed fetch is still a checkpoint mutation. Reauthorize it
            // and bind every durable fence before publishing its status.
            let mut tx = app.db.begin().await?;
            lock_scan_page(&mut tx, source, &caller, source_revision, scan_id, &cursor).await?;
            sqlx::query("UPDATE s3_index_scans SET status='failed',last_error='s3_scan_failed',updated_at=clock_timestamp() WHERE source_id=$1")
                .bind(source).execute(&mut *tx).await?;
            commit_scan(tx, &caller).await?;
            return Err(err(StatusCode::BAD_GATEWAY, "s3_scan_failed"));
        }
    };
    let mut tx = app.db.begin().await?;
    let row = lock_scan_page(&mut tx, source, &caller, source_revision, scan_id, &cursor).await?;
    if row.get::<i64, _>("page_count") >= 10_000 {
        return Err(err(StatusCode::BAD_GATEWAY, "s3_scan_failed"));
    }
    if let Some(next) = &next {
        let repeated:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM s3_index_scan_cursors WHERE source_id=$1 AND scan_id=$2 AND cursor_sha256=$3)").bind(source).bind(scan_id).bind(hash(next)).fetch_one(&mut *tx).await?;
        if repeated {
            return Err(err(StatusCode::BAD_GATEWAY, "s3_scan_failed"));
        }
    }
    sqlx::query("INSERT INTO s3_index_scan_cursors(source_id,scan_id,cursor_sha256) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(source).bind(scan_id).bind(hash(cursor.as_deref().unwrap_or("<first-page>"))).execute(&mut *tx).await?;
    let bucket = &config
        .s3
        .as_ref()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_source"))?
        .bucket;
    for object in &objects {
        let title = std::path::Path::new(&object.key)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("S3 media")
            .chars()
            .take(200)
            .collect::<String>();
        let version = object.source_version(bucket);
        let identity = serde_json::to_value(object).map_err(anyhow::Error::from)?;
        sqlx::query("INSERT INTO media_items(id,source_id,title,resource,metadata,source_version,s3_object_identity) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_id,resource) DO UPDATE SET title=EXCLUDED.title,metadata=CASE WHEN media_items.source_version IS NOT DISTINCT FROM EXCLUDED.source_version THEN media_items.metadata||EXCLUDED.metadata ELSE EXCLUDED.metadata END,duration_ms=CASE WHEN media_items.source_version IS NOT DISTINCT FROM EXCLUDED.source_version THEN media_items.duration_ms ELSE NULL END,source_version=EXCLUDED.source_version,s3_object_identity=EXCLUDED.s3_object_identity,available=true")
        .bind(Uuid::new_v4()).bind(source).bind(title).bind(&object.key).bind(json!({"s3":identity,"source_version":version})).bind(version).bind(identity).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO s3_index_scan_seen(source_id,scan_id,resource) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(source).bind(scan_id).bind(&object.key).execute(&mut *tx).await?;
    }
    if next.is_none() {
        sqlx::query("UPDATE media_items m SET available=false WHERE source_id=$1 AND NOT EXISTS(SELECT 1 FROM s3_index_scan_seen seen WHERE seen.source_id=m.source_id AND seen.scan_id=$2 AND seen.resource=m.resource)").bind(source).bind(scan_id).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE s3_index_scans SET continuation_token=$3,status=CASE WHEN $3::text IS NULL THEN 'completed' ELSE 'running' END,item_count=(SELECT count(*) FROM s3_index_scan_seen WHERE source_id=$1 AND scan_id=$2),page_count=page_count+1,completed_at=CASE WHEN $3::text IS NULL THEN clock_timestamp() ELSE NULL END,last_error=NULL,updated_at=clock_timestamp() WHERE source_id=$1 AND scan_id=$2")
      .bind(source).bind(scan_id).bind(next).execute(&mut *tx).await?;
    let row = sqlx::query("SELECT * FROM s3_index_scans WHERE source_id=$1")
        .bind(source)
        .fetch_one(&mut *tx)
        .await?;
    commit_scan(tx, &caller).await?;
    Ok(scan_value(&row))
}
