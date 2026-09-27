use super::*;

pub struct Reservation {
    pub key: Uuid,
    pub session: Uuid,
    pub user: Uuid,
}

pub enum Start {
    Reserved(Reservation),
    Replay(Value),
}

/// Reserve before any upstream negotiation/probing. A short user-row lock also
/// serializes quota decisions across different keys without holding a database
/// connection while the media source is contacted.
pub async fn begin(app: &App, user: Uuid, body: &protocol::PlaybackRequest) -> Result<Start> {
    let key = body.idempotency_key.unwrap_or_else(Uuid::new_v4);
    let mut canonical = body.clone();
    canonical.idempotency_key = None;
    canonical.mode = Some(body.mode.as_deref().unwrap_or("auto").into());
    let digest = hash(&serde_json::to_string(&canonical).map_err(anyhow::Error::from)?);
    let mut tx = app.db.begin().await?;
    // Serialize quota decisions without blocking FK KEY SHARE locks taken by
    // an in-flight preparation inserting its playback session.
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
        .bind(user)
        .fetch_one(&mut *tx)
        .await?;
    let previous = sqlx::query("SELECT *,expires_at>now() AS retained,lease_until>now() AS live FROM playback_requests WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE")
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
        match row.get::<String, _>("status").as_str() {
            "completed" => {
                let remaining: Option<i64> = sqlx::query_scalar("SELECT CEIL(EXTRACT(EPOCH FROM(p.expires_at-now())))::bigint FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id WHERE p.id=$1 AND p.user_id=$2 AND NOT p.stopped AND p.expires_at>now() AND (s.state->>'media_generation')::bigint=p.generation")
                    .bind(row.get::<Uuid,_>("session_id")).bind(user).fetch_optional(&mut *tx).await?;
                let remaining =
                    remaining.ok_or_else(|| err(StatusCode::GONE, "playback_request_expired"))?;
                let mut plan = app.decrypt(&row.get::<String, _>("response_encrypted"))?;
                plan["expires_in_seconds"] = json!(remaining);
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
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM (SELECT id FROM playback_sessions WHERE user_id=$1 AND NOT stopped AND expires_at>now() UNION SELECT session_id FROM playback_requests WHERE user_id=$1 AND status='pending' AND lease_until>now()) active")
        .bind(user).fetch_one(&mut *tx).await?;
    if active >= app.session_limit {
        // Keep stale-attempt cleanup even if other live sessions fill quota.
        tx.commit().await?;
        return Err(err(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_playback_sessions",
        ));
    }
    let session = Uuid::new_v4();
    sqlx::query("INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at) VALUES($1,$2,$3,$4,$5,'pending',now()+interval '60 seconds',now()+interval '48 hours') ON CONFLICT(user_id,idempotency_key) DO UPDATE SET session_id=EXCLUDED.session_id,owner_epoch=EXCLUDED.owner_epoch,status='pending',response_encrypted=NULL,error_status=NULL,error_code=NULL,lease_until=EXCLUDED.lease_until,expires_at=EXCLUDED.expires_at,attempt=playback_requests.attempt+1")
        .bind(user).bind(key).bind(digest).bind(session).bind(app.epoch).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Start::Reserved(Reservation { key, session, user }))
}

/// The response contains playback bearer URLs, so persist it encrypted using
/// the same site key as source credentials. This runs in the session/job txn.
pub async fn complete(
    app: &App,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    reservation: &Reservation,
    plan: &Value,
) -> Result<()> {
    let response = app.encrypt(plan)?;
    let result = sqlx::query("UPDATE playback_requests SET status='completed',response_encrypted=$4 WHERE user_id=$1 AND idempotency_key=$2 AND owner_epoch=$3 AND session_id=$5 AND status='pending' AND lease_until>now()")
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
    let valid = sqlx::query("SELECT session_id FROM playback_requests WHERE user_id=$1 AND idempotency_key=$2 AND session_id=$3 AND owner_epoch=$4 AND status='pending' AND lease_until>now() FOR UPDATE")
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
    let row = sqlx::query("SELECT status,response_encrypted,session_id,attempt FROM playback_requests WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE")
        .bind(reservation.user).bind(reservation.key).fetch_one(&mut *tx).await?;
    if row.get::<Uuid, _>("session_id") != reservation.session {
        return Err(err(StatusCode::CONFLICT, "playback_request_interrupted"));
    }
    if row.get::<String, _>("status") == "completed" {
        return Ok(Some(
            app.decrypt(&row.get::<String, _>("response_encrypted"))?,
        ));
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
    tx.commit().await?;
    if exhausted {
        return Err(recorded);
    }
    Ok(None)
}

/// A durable tombstone also fences POSTs that arrive after cancellation.
/// The same user lock as begin serializes cancel-before-reserve races.
pub async fn cancel(
    State(app): State<App>,
    h: HeaderMap,
    Path(key): Path<Uuid>,
) -> Result<Json<Value>> {
    let user = auth(&app, &h, true).await?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await?;
    let session: Uuid = sqlx::query_scalar("INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,error_status,error_code,lease_until,expires_at) VALUES($1,$2,'',$3,$4,'failed',410,'playback_request_cancelled',now(),now()+interval '48 hours') ON CONFLICT(user_id,idempotency_key) DO UPDATE SET status='failed',response_encrypted=NULL,error_status=410,error_code='playback_request_cancelled',lease_until=now(),expires_at=GREATEST(playback_requests.expires_at,now()+interval '48 hours') RETURNING session_id")
        .bind(user.id).bind(key).bind(Uuid::new_v4()).bind(app.epoch).fetch_one(&mut *tx).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(session)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE media_jobs SET status='cancelled' WHERE session_id=$1 AND status IN('queued','running')").bind(session).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
