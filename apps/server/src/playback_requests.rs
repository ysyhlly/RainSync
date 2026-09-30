use super::*;

pub struct Reservation {
    pub key: Uuid,
    pub session: Uuid,
    pub user: Uuid,
    pub room_id: Uuid,
    pub lifecycle_epoch: i64,
    pub viewer_id: Option<Uuid>,
    pub plan_generation: Option<u32>,
}

pub enum Start {
    Reserved(Reservation),
    Replay(Value),
}

/// Reserve before any upstream negotiation/probing. A short user-row lock also
/// serializes quota decisions across different keys without holding a database
/// connection while the media source is contacted.
pub async fn begin(app: &App, user: Uuid, body: &protocol::PlaybackRequest) -> Result<Start> {
    if !matches!(
        (body.viewer_id, body.plan_generation),
        (None, None) | (Some(_), Some(1..))
    ) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_plan_generation"));
    }
    let key = body.idempotency_key.unwrap_or_else(Uuid::new_v4);
    let mut canonical = body.clone();
    canonical.idempotency_key = None;
    canonical.mode = Some(body.mode.as_deref().unwrap_or("auto").into());
    let digest = hash(&serde_json::to_string(&canonical).map_err(anyhow::Error::from)?);
    let mut tx = app.db.begin().await?;
    // Room management, reservation and final publication share this first lock.
    let lifecycle_epoch = persistence::room_lifecycle::lock_active(&mut tx, body.room_id)
        .await
        .map_err(lifecycle_error)?;
    let member: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(body.room_id)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?;
    if member.is_none() {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    // Serialize quota decisions without blocking FK KEY SHARE locks taken by
    // an in-flight preparation inserting its playback session.
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
        .bind(user)
        .fetch_one(&mut *tx)
        .await?;
    let previous = sqlx::query("SELECT *,expires_at>clock_timestamp() AS retained,lease_until>clock_timestamp() AS live FROM playback_requests WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE")
        .bind(user).bind(key).fetch_optional(&mut *tx).await?;
    if let Some(row) = previous {
        if row.get::<Option<String>, _>("error_code").as_deref()
            == Some("playback_request_cancelled")
        {
            return Err(err(StatusCode::GONE, "playback_request_cancelled"));
        }
        if row.get::<String, _>("request_hash") != digest {
            return Err(err(StatusCode::CONFLICT, "playback_request_conflict"));
        }
        guard_generation(
            &mut tx,
            user,
            body.room_id,
            body.viewer_id,
            body.plan_generation,
        )
        .await?;
        match row.get::<String, _>("status").as_str() {
            "completed" => {
                if !persistence::source_account_policy::lock_session(&mut tx, row.get("session_id"))
                    .await?
                {
                    return Err(err(StatusCode::GONE, "playback_request_expired"));
                }
                let remaining: Option<i64> = sqlx::query_scalar("SELECT CEIL(EXTRACT(EPOCH FROM(p.expires_at-now())))::bigint FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id WHERE p.id=$1 AND p.user_id=$2 AND NOT p.stopped AND playback_source_allowed(p.media_id,p.resource) AND p.expires_at>clock_timestamp() AND (s.state->>'media_generation')::bigint=p.generation AND p.room_id=$3 AND p.lifecycle_epoch=$4 AND EXISTS(SELECT 1 FROM rooms r WHERE r.id=p.room_id AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch)")
                    .bind(row.get::<Uuid,_>("session_id")).bind(user).bind(body.room_id).bind(lifecycle_epoch).fetch_optional(&mut *tx).await?;
                let remaining =
                    remaining.ok_or_else(|| err(StatusCode::GONE, "playback_request_expired"))?;
                let mut plan = app.decrypt(&row.get::<String, _>("response_encrypted"))?;
                plan["expires_in_seconds"] = json!(remaining);
                playback_observations::refresh_plan(&mut tx, &mut plan).await?;
                sqlx::query("UPDATE playback_requests SET expires_at=GREATEST(expires_at,now()+interval '48 hours') WHERE user_id=$1 AND idempotency_key=$2")
                    .bind(user).bind(key).execute(&mut *tx).await?;
                tx.commit().await?;
                return Ok(Start::Replay(plan));
            }
            _ if !row.get::<bool, _>("retained") => {
                return Err(err(StatusCode::GONE, "playback_request_expired"));
            }
            "failed" => {
                let status = StatusCode::from_u16(row.get::<i16, _>("error_status") as u16)
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                let reason: String = row.get("error_code");
                if !protocol::ErrorCode::from_reason(&reason, status.as_u16()).retryable() {
                    return Err(err(status, &reason));
                }
            }
            _ if row.get::<bool, _>("live") && row.get::<Uuid, _>("owner_epoch") == app.epoch => {
                return Err(err(StatusCode::CONFLICT, "playback_request_in_progress"));
            }
            _ => {}
        }
        let old: Uuid = row.get("session_id");
        // Retire the previous grant before reclaiming its quota. A different
        // session UUID fences both late completion and late failure callbacks.
        sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
            .bind(old)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE media_jobs SET status='cancelled' WHERE session_id=$1 AND status IN('queued','running')").bind(old).execute(&mut *tx).await?;
        persistence::upstream_reservations::close(&mut tx, old, "playback_request_interrupted")
            .await?;
        sqlx::query("UPDATE playback_requests SET status='failed',error_status=409,error_code='playback_request_interrupted',response_encrypted=NULL WHERE user_id=$1 AND idempotency_key=$2")
            .bind(user).bind(key).execute(&mut *tx).await?;
        if row.get::<i32, _>("attempt") >= 3 {
            sqlx::query("UPDATE playback_requests SET error_code='playback_request_retry_exhausted' WHERE user_id=$1 AND idempotency_key=$2")
                .bind(user).bind(key).execute(&mut *tx).await?;
            tx.commit().await?;
            return Err(err(
                StatusCode::CONFLICT,
                "playback_request_retry_exhausted",
            ));
        }
    }
    // A viewer identity is only a correlation key within this authenticated
    // user and room. Admission, retirement and publication share the room lock.
    // Failed/cancelled requests never lower or remove this durable high-water.
    if let (Some(viewer), Some(generation)) = (body.viewer_id, body.plan_generation) {
        let current: Option<i64> = sqlx::query_scalar("SELECT plan_generation FROM playback_viewer_plans WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3 FOR UPDATE")
            .bind(user).bind(body.room_id).bind(viewer).fetch_optional(&mut *tx).await?;
        if current.is_none() {
            let viewers: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM playback_viewer_plans WHERE user_id=$1 AND room_id=$2",
            )
            .bind(user)
            .bind(body.room_id)
            .fetch_one(&mut *tx)
            .await?;
            // Never evict a high-water: doing so would allow a delayed old
            // intent to return. The user lock makes this admission cap atomic.
            if viewers >= 1024 {
                return Err(err(
                    StatusCode::TOO_MANY_REQUESTS,
                    "playback_viewer_limit_exceeded",
                ));
            }
        }
        let retry: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_requests WHERE user_id=$1 AND idempotency_key=$2 AND viewer_id=$3 AND plan_generation=$4)")
            .bind(user).bind(key).bind(viewer).bind(i64::from(generation)).fetch_one(&mut *tx).await?;
        if current.is_some_and(|current| {
            current > i64::from(generation) || (current == i64::from(generation) && !retry)
        }) {
            return Err(err(StatusCode::CONFLICT, "stale_playback_plan"));
        }
        let current_media: Value =
            sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
                .bind(body.room_id)
                .fetch_one(&mut *tx)
                .await?;
        if current_media["media_generation"].as_u64() != Some(u64::from(body.media_generation)) {
            return Err(err(StatusCode::CONFLICT, "stale_media"));
        }
        sqlx::query("INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,room_id,viewer_id) DO UPDATE SET plan_generation=EXCLUDED.plan_generation,updated_at=clock_timestamp()")
            .bind(user).bind(body.room_id).bind(viewer).bind(i64::from(generation)).execute(&mut *tx).await?;
        let obsolete: Vec<Uuid> = sqlx::query_scalar("SELECT session_id FROM playback_requests WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3 AND plan_generation<$4 AND status='pending' UNION SELECT id FROM playback_sessions WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3 AND plan_generation<$4 AND NOT stopped")
            .bind(user).bind(body.room_id).bind(viewer).bind(i64::from(generation)).fetch_all(&mut *tx).await?;
        for old in obsolete {
            sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
                .bind(old)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE media_jobs SET status='cancelled' WHERE session_id=$1 AND status IN('queued','running')")
                .bind(old).execute(&mut *tx).await?;
            sqlx::query("UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=409,error_code='stale_playback_plan',lease_until=clock_timestamp() WHERE session_id=$1")
                .bind(old).execute(&mut *tx).await?;
            persistence::upstream_reservations::close(&mut tx, old, "stale_playback_plan").await?;
        }
    }
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM (SELECT id FROM playback_sessions WHERE user_id=$1 AND NOT stopped AND expires_at>now() UNION SELECT session_id FROM playback_requests WHERE user_id=$1 AND status='pending' AND lease_until>now()) active")
        .bind(user).fetch_one(&mut *tx).await?;
    if active >= app.session_limit {
        // Keep stale-attempt cleanup even if other live sessions fill quota.
        // Do not publish a new high-water without its request identity. A
        // quota rejection must remain safely retryable with the same intent.
        if body.viewer_id.is_none() {
            tx.commit().await?;
        }
        return Err(err(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_playback_sessions",
        ));
    }
    let session = Uuid::new_v4();
    sqlx::query("INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,lifecycle_epoch,preparation_drained_at,viewer_id,plan_generation) VALUES($1,$2,$3,$4,$5,'pending',clock_timestamp()+interval '60 seconds',now()+interval '48 hours',$6,$7,NULL,$8,$9) ON CONFLICT(user_id,idempotency_key) DO UPDATE SET session_id=EXCLUDED.session_id,owner_epoch=EXCLUDED.owner_epoch,status='pending',response_encrypted=NULL,error_status=NULL,error_code=NULL,lease_until=EXCLUDED.lease_until,expires_at=EXCLUDED.expires_at,attempt=playback_requests.attempt+1,room_id=EXCLUDED.room_id,lifecycle_epoch=EXCLUDED.lifecycle_epoch,preparation_drained_at=NULL,viewer_id=EXCLUDED.viewer_id,plan_generation=EXCLUDED.plan_generation")
        .bind(user).bind(key).bind(digest).bind(session).bind(app.epoch).bind(body.room_id).bind(lifecycle_epoch).bind(body.viewer_id).bind(body.plan_generation.map(i64::from)).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO playback_preparations(session_id,room_id,lifecycle_epoch,owner_epoch) VALUES($1,$2,$3,$4)")
        .bind(session).bind(body.room_id).bind(lifecycle_epoch).bind(app.epoch).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Start::Reserved(Reservation {
        key,
        session,
        user,
        room_id: body.room_id,
        lifecycle_epoch,
        viewer_id: body.viewer_id,
        plan_generation: body.plan_generation,
    }))
}

/// The response contains playback bearer URLs, so persist it encrypted using
/// the same site key as source credentials. This runs in the session/job txn.
pub async fn complete(
    app: &App,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    reservation: &Reservation,
    plan: &Value,
) -> Result<()> {
    guard_generation(
        tx,
        reservation.user,
        reservation.room_id,
        reservation.viewer_id,
        reservation.plan_generation,
    )
    .await?;
    let response = app.encrypt(plan)?;
    let result = sqlx::query("UPDATE playback_requests SET status='completed',response_encrypted=$4 WHERE user_id=$1 AND idempotency_key=$2 AND owner_epoch=$3 AND session_id=$5 AND status='pending' AND lease_until>clock_timestamp()")
        .bind(reservation.user).bind(reservation.key).bind(app.epoch).bind(response).bind(reservation.session).execute(&mut **tx).await?;
    if result.rows_affected() != 1 {
        return Err(err(StatusCode::CONFLICT, "playback_request_interrupted"));
    }
    Ok(())
}

pub async fn guard(
    app: &App,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    reservation: &Reservation,
) -> Result<()> {
    let epoch = persistence::room_lifecycle::lock_active(tx, reservation.room_id)
        .await
        .map_err(lifecycle_error)?;
    if epoch != reservation.lifecycle_epoch {
        return Err(err(StatusCode::CONFLICT, "room_not_active"));
    }
    let member: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(reservation.room_id)
    .bind(reservation.user)
    .fetch_optional(&mut **tx)
    .await?;
    if member.is_none() {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    guard_generation(
        tx,
        reservation.user,
        reservation.room_id,
        reservation.viewer_id,
        reservation.plan_generation,
    )
    .await?;
    let valid = sqlx::query("SELECT session_id FROM playback_requests WHERE user_id=$1 AND idempotency_key=$2 AND session_id=$3 AND owner_epoch=$4 AND status='pending' AND lease_until>clock_timestamp() FOR UPDATE")
        .bind(reservation.user).bind(reservation.key).bind(reservation.session).bind(app.epoch).fetch_optional(&mut **tx).await?;
    if valid.is_none() {
        return Err(err(StatusCode::CONFLICT, "playback_request_interrupted"));
    }
    Ok(())
}

/// Never overwrite a successful transaction after a commit acknowledgement
/// was lost. A pending preparation grant is revoked when failure is recorded.
pub async fn fail(app: &App, reservation: &Reservation, error: &Error) -> Result<Option<Value>> {
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(reservation.room_id)
        .fetch_one(&mut *tx)
        .await?;
    // A superseded owner's late failure must not replay an old success or
    // disturb the successor. Its preparation receipt is still recorded later.
    guard_generation(
        &mut tx,
        reservation.user,
        reservation.room_id,
        reservation.viewer_id,
        reservation.plan_generation,
    )
    .await?;
    let row = sqlx::query("SELECT status,response_encrypted,session_id,attempt FROM playback_requests WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE")
        .bind(reservation.user).bind(reservation.key).fetch_one(&mut *tx).await?;
    if row.get::<Uuid, _>("session_id") != reservation.session {
        return Err(err(StatusCode::CONFLICT, "playback_request_interrupted"));
    }
    if row.get::<String, _>("status") == "completed" {
        if !persistence::source_account_policy::lock_session(&mut tx, reservation.session).await? {
            return Err(err(StatusCode::GONE, "invalid_playback_session"));
        }
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id WHERE p.id=$1 AND p.user_id=$2 AND NOT p.stopped AND playback_source_allowed(p.media_id,p.resource) AND p.expires_at>clock_timestamp() AND r.lifecycle='active' AND r.lifecycle_epoch=$3 AND p.lifecycle_epoch=r.lifecycle_epoch AND (s.state->>'media_generation')::bigint=p.generation AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id))")
            .bind(reservation.session).bind(reservation.user).bind(reservation.lifecycle_epoch).fetch_one(&mut *tx).await?;
        if !valid {
            return Err(err(StatusCode::GONE, "invalid_playback_session"));
        }
        let mut plan = app.decrypt(&row.get::<String, _>("response_encrypted"))?;
        playback_observations::refresh_plan(&mut tx, &mut plan).await?;
        return Ok(Some(plan));
    }
    let exhausted = row.get::<String, _>("status") == "pending"
        && row.get::<i32, _>("attempt") >= 3
        && protocol::ErrorCode::from_reason(&error.1, error.0.as_u16()).retryable();
    let recorded = if exhausted {
        err(StatusCode::CONFLICT, "playback_request_retry_exhausted")
    } else {
        err(error.0, &error.1)
    };
    sqlx::query("UPDATE playback_requests SET status='failed',error_status=$3,error_code=$4 WHERE user_id=$1 AND idempotency_key=$2 AND status='pending'")
        .bind(reservation.user).bind(reservation.key).bind(recorded.0.as_u16() as i16).bind(&recorded.1).execute(&mut *tx).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(reservation.session)
        .execute(&mut *tx)
        .await?;
    persistence::upstream_reservations::close(&mut tx, reservation.session, &recorded.1).await?;
    tx.commit().await?;
    if exhausted {
        return Err(recorded);
    }
    Ok(None)
}

async fn guard_generation(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    room: Uuid,
    viewer: Option<Uuid>,
    generation: Option<u32>,
) -> Result<()> {
    if let (Some(viewer), Some(generation)) = (viewer, generation) {
        let current: Option<i64> = sqlx::query_scalar("SELECT plan_generation FROM playback_viewer_plans WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3")
            .bind(user).bind(room).bind(viewer).fetch_optional(&mut **tx).await?;
        if current != Some(i64::from(generation)) {
            return Err(err(StatusCode::CONFLICT, "stale_playback_plan"));
        }
    }
    Ok(())
}

/// A durable tombstone also fences POSTs that arrive after cancellation.
/// The same user lock as begin serializes cancel-before-reserve races.
pub async fn cancel(
    State(app): State<App>,
    h: HeaderMap,
    Path(key): Path<Uuid>,
) -> Result<Json<Value>> {
    let user = auth(&app, &h, true).await?;
    // Resolve the room before taking the per-user quota lock. If a concurrent
    // reservation appeared in that gap, retry without ever inverting room→user.
    for _ in 0..4 {
        let mut tx = app.db.begin().await?;
        let room = cancellation_room(&mut tx, user.id, key).await?;
        if let Some(room) = room {
            sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
                .bind(room)
                .fetch_optional(&mut *tx)
                .await?;
            sqlx::query("SELECT room_id FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
                .bind(room)
                .fetch_optional(&mut *tx)
                .await?;
        }
        sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
            .bind(user.id)
            .fetch_one(&mut *tx)
            .await?;
        if cancellation_room(&mut tx, user.id, key).await? != room {
            tx.rollback().await?;
            continue;
        }
        let session: Uuid = sqlx::query_scalar("INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,error_status,error_code,lease_until,expires_at) VALUES($1,$2,'',$3,$4,'failed',410,'playback_request_cancelled',now(),now()+interval '48 hours') ON CONFLICT(user_id,idempotency_key) DO UPDATE SET status='failed',response_encrypted=NULL,error_status=410,error_code='playback_request_cancelled',lease_until=now(),expires_at=GREATEST(playback_requests.expires_at,now()+interval '48 hours') RETURNING session_id")
            .bind(user.id).bind(key).bind(Uuid::new_v4()).bind(app.epoch).fetch_one(&mut *tx).await?;
        sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
            .bind(session)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE media_jobs SET status='cancelled' WHERE session_id=$1 AND status IN('queued','running')")
            .bind(session).execute(&mut *tx).await?;
        persistence::upstream_reservations::close(&mut tx, session, "playback_request_cancelled")
            .await?;
        tx.commit().await?;
        return Ok(Json(json!({"ok":true})));
    }
    Err(err(StatusCode::CONFLICT, "playback_request_interrupted"))
}

async fn cancellation_room(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    key: Uuid,
) -> Result<Option<Uuid>> {
    Ok(sqlx::query_scalar::<_, Option<Uuid>>("SELECT COALESCE(r.room_id,p.room_id,u.room_id) FROM playback_requests r LEFT JOIN playback_sessions p ON p.id=r.session_id LEFT JOIN upstream_reservations u ON u.id=r.session_id WHERE r.user_id=$1 AND r.idempotency_key=$2")
        .bind(user).bind(key).fetch_optional(&mut **tx).await?.flatten())
}

/// Only the executor that has dropped its preparation and drained its scoped
/// subprocesses may acknowledge. Status failure/cancellation alone is not proof.
pub async fn drained(app: &App, reservation: &Reservation) -> Result<()> {
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE playback_preparations SET drained_at=COALESCE(drained_at,clock_timestamp()) WHERE session_id=$1 AND owner_epoch=$2")
        .bind(reservation.session).bind(app.epoch).execute(&mut *tx).await?;
    sqlx::query("UPDATE playback_requests SET preparation_drained_at=COALESCE(preparation_drained_at,clock_timestamp()) WHERE session_id=$1 AND owner_epoch=$2")
        .bind(reservation.session).bind(app.epoch).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

fn lifecycle_error(error: anyhow::Error) -> Error {
    match error.to_string().as_str() {
        "room_not_active" => err(StatusCode::CONFLICT, "room_not_active"),
        _ => error.into(),
    }
}
