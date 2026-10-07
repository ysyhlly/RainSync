//! Explicit self-service retirement. Shared history keeps an anonymous principal.
use crate::*;
use persistence::media_job_timing::{CancellationScope, cancel_jobs};

pub async fn preview(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    let rooms =
        sqlx::query("SELECT id,name,lifecycle FROM rooms WHERE owner_id=$1 ORDER BY created_at,id")
            .bind(user.id)
            .fetch_all(&app.db)
            .await?;
    let libraries =
        sqlx::query("SELECT id,name,revision FROM private_libraries WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY id")
            .bind(user.id)
            .fetch_all(&app.db)
            .await?;
    let last_admin: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND admin) AND NOT EXISTS(SELECT 1 FROM users u WHERE u.id<>$1 AND u.admin AND NOT EXISTS(SELECT 1 FROM account_exits e WHERE e.user_id=u.id))")
        .bind(user.id).fetch_one(&app.db).await?;
    Ok(media_titles::private_json(json!({
        "can_delete": rooms.is_empty() && libraries.is_empty() && !last_admin,
        "last_admin": last_admin,
        "rooms": rooms.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"lifecycle":r.get::<String,_>("lifecycle")})).collect::<Vec<_>>(),
        "libraries": libraries.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"revision":r.get::<i64,_>("revision")})).collect::<Vec<_>>()
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delete {
    password: String,
    confirmation: String,
}

pub async fn delete(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Delete>,
) -> Result<Response> {
    let user = auth(&app, &h, true).await?;
    if body.confirmation != "DELETE" || body.password.is_empty() || body.password.len() > 1024 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    account_security::rate_limit(&app.db, "account_exit", &user.id.to_string(), 5, 600).await?;
    let stored: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1")
        .bind(user.id)
        .fetch_one(&app.db)
        .await?;
    let expected = stored.clone();
    let permit = app
        .account_security
        .hashes
        .clone()
        .try_acquire_owned()
        .map_err(|_| account_security::limited(1))?;
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&stored).ok().is_some_and(|p| {
            Argon2::default()
                .verify_password(body.password.as_bytes(), &p)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if !valid {
        return Err(err(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }
    let login = media_authorization::login_hash(&h)?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    // Retain room -> snapshot -> memberships -> principal -> login ordering.
    // New ownership is checked again after the principal lock: creation may
    // have committed while this request waited for that lock.
    let room_ids: Vec<Uuid> = sqlx::query_scalar("SELECT r.id FROM rooms r WHERE r.owner_id=$1 OR EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=r.id AND m.user_id=$1) OR EXISTS(SELECT 1 FROM room_member_permissions p WHERE p.room_id=r.id AND p.granted_by=$1) OR EXISTS(SELECT 1 FROM invites i WHERE i.room_id=r.id AND i.created_by=$1) ORDER BY r.id FOR NO KEY UPDATE")
        .bind(user.id).fetch_all(&mut *tx).await?;
    sqlx::query(
        "SELECT room_id FROM room_snapshots WHERE room_id=ANY($1) ORDER BY room_id FOR UPDATE",
    )
    .bind(&room_ids)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query("SELECT room_id FROM room_members WHERE user_id=$1 ORDER BY room_id FOR UPDATE")
        .bind(user.id)
        .fetch_all(&mut *tx)
        .await?;
    // Serialize concurrent administrator exits so at least one remains active.
    let principals = sqlx::query(
        "SELECT id,admin,password_hash FROM users WHERE id=$1 OR admin ORDER BY id FOR UPDATE",
    )
    .bind(user.id)
    .fetch_all(&mut *tx)
    .await?;
    let current = principals
        .iter()
        .find(|r| r.get::<Uuid, _>("id") == user.id)
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "session_expired"))?;
    if current.get::<String, _>("password_hash") != expected {
        return Err(err(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }
    let csrf: Option<String>=sqlx::query_scalar("SELECT csrf FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE")
        .bind(&login).bind(user.id).fetch_optional(&mut *tx).await?;
    if csrf.is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    if h.get("x-csrf-token").and_then(|v| v.to_str().ok()) != csrf.as_deref() {
        return Err(err(StatusCode::FORBIDDEN, "csrf_rejected"));
    }
    let other_admin: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users u WHERE u.id<>$1 AND u.admin AND NOT EXISTS(SELECT 1 FROM account_exits e WHERE e.user_id=u.id))")
        .bind(user.id).fetch_one(&mut *tx).await?;
    if current.get::<bool, _>("admin") && !other_admin {
        return Err(err(StatusCode::CONFLICT, "account_last_admin"));
    }
    let owns: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rooms WHERE owner_id=$1) OR EXISTS(SELECT 1 FROM private_libraries WHERE owner_id=$1 AND deleted_at IS NULL)")
        .bind(user.id).fetch_one(&mut *tx).await?;
    if owns {
        return Err(err(StatusCode::CONFLICT, "account_ownership_required"));
    }

    let pending: Vec<Uuid>=sqlx::query_scalar("SELECT session_id FROM playback_requests WHERE user_id=$1 AND static_hls_input_version=1 ORDER BY session_id FOR UPDATE")
        .bind(user.id).fetch_all(&mut *tx).await?;
    for id in pending {
        persistence::static_hls_pending::terminalize_locked(&mut tx, id, 401, "session_expired")
            .await?;
    }
    sqlx::query("UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=401,error_code='session_expired' WHERE user_id=$1 AND static_hls_input_version IS NULL AND status IN('pending','completed')")
        .bind(user.id).execute(&mut *tx).await?;
    let sessions: Vec<Uuid> = sqlx::query_scalar(
        "UPDATE playback_sessions SET stopped=true WHERE user_id=$1 RETURNING id",
    )
    .bind(user.id)
    .fetch_all(&mut *tx)
    .await?;
    let mut observations = Vec::new();
    for session in sessions {
        observations.push(
            cancel_jobs(&mut *tx, CancellationScope::Session(session))
                .await?
                .into_commit_observation(),
        );
    }
    sqlx::query("UPDATE distributed_compute_jobs SET status='cancelled',error='session_expired',lease_until=NULL WHERE user_id=$1 AND status IN('queued','running','ready')").bind(user.id).execute(&mut *tx).await?;
    // Revoke credentials by revision, so an in-flight renewal cannot restore them.
    sqlx::query("DELETE FROM platform_login_requests WHERE user_id=$1")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM platform_oauth_requests WHERE user_id=$1")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE platform_accounts SET state='revoked',credential_encrypted=NULL,credential_expires_at=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND state<>'revoked'")
        .bind(user.id).execute(&mut *tx).await?;
    sqlx::query("UPDATE platform_oauth_accounts SET state='revoked',token_encrypted=NULL,auto_renew=false,consent_login_hash=NULL,renewal_state='disabled',operation_nonce=NULL,operation_expires_at=NULL,next_refresh_at=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1")
        .bind(user.id).execute(&mut *tx).await?;
    sqlx::query("UPDATE registration_invites i SET revoked_by=$1,revoked_at=clock_timestamp() FROM registration_invite_batches b WHERE i.batch_id=b.id AND b.created_by=$1 AND i.used_at IS NULL AND i.revoked_at IS NULL")
        .bind(user.id).execute(&mut *tx).await?;
    let clustered: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM control_cluster_activation)")
            .fetch_one(&mut *tx)
            .await?;
    if !clustered {
        sqlx::query("UPDATE invites SET revoked=true WHERE created_by=$1 OR invited_user_id=$1")
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE room_media_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE grantor_id=$1")
        .bind(user.id).execute(&mut *tx).await?;
    for query in [
        "DELETE FROM library_grants WHERE user_id=$1 OR created_by=$1",
        "DELETE FROM room_p2p_peers WHERE user_id=$1",
        "DELETE FROM room_reactions WHERE user_id=$1",
        "DELETE FROM control_epochs WHERE user_id=$1",
        "DELETE FROM user_avatars WHERE user_id=$1",
        "DELETE FROM avatar_operations WHERE user_id=$1",
        "DELETE FROM media_user_titles WHERE user_id=$1",
    ] {
        sqlx::query(query).bind(user.id).execute(&mut *tx).await?;
    }
    if !clustered {
        sqlx::query("DELETE FROM room_member_permissions WHERE user_id=$1 OR granted_by=$1")
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM room_members WHERE user_id=$1")
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
    }
    // '#' is excluded by registration rules, reserving this anonymous username.
    sqlx::query("UPDATE users SET username=$2,password_hash='!',admin=false WHERE id=$1")
        .bind(user.id)
        .bind(format!("#deleted-{}", user.id))
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO user_profiles(user_id,display_name) VALUES($1,'已注销用户') ON CONFLICT(user_id) DO UPDATE SET display_name=EXCLUDED.display_name")
        .bind(user.id).execute(&mut *tx).await?;
    let live: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())")
        .bind(&login).bind(user.id).fetch_one(&mut *tx).await?;
    if !live {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    sqlx::query("INSERT INTO account_exits(user_id) VALUES($1)")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    if clustered {
        sqlx::query("INSERT INTO account_exit_room_cleanup(room_id,user_id) SELECT r.id,$1 FROM rooms r WHERE EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=r.id AND m.user_id=$1) OR EXISTS(SELECT 1 FROM room_member_permissions p WHERE p.room_id=r.id AND (p.user_id=$1 OR p.granted_by=$1)) OR EXISTS(SELECT 1 FROM invites i WHERE i.room_id=r.id AND (i.created_by=$1 OR i.invited_user_id=$1)) ON CONFLICT DO NOTHING")
            .bind(user.id).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM sessions WHERE user_id=$1")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    for observation in observations {
        observation.confirmed();
    }
    Ok((
        [
            (
                header::SET_COOKIE,
                "rainsync_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Json(json!({"ok":true})),
    )
        .into_response())
}
