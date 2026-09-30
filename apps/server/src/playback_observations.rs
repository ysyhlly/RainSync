use super::*;
use persistence::playback_observations as observations;

pub struct Grant {
    pub row: sqlx::postgres::PgRow,
    state: Value,
}

/// Read ownership first, then acquire the room before the grant. Generation
/// changes, final publication and explicit stop use this same lock order.
pub async fn lock_grant(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    user: Uuid,
) -> Result<Option<Grant>> {
    let room: Option<Uuid> =
        sqlx::query_scalar("SELECT room_id FROM playback_sessions WHERE id=$1 AND user_id=$2")
            .bind(id)
            .bind(user)
            .fetch_optional(&mut **tx)
            .await?;
    let Some(room) = room else {
        return Ok(None);
    };
    let state: Option<Value> =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(room)
            .fetch_optional(&mut **tx)
            .await?;
    let Some(state) = state else {
        return Ok(None);
    };
    Ok(
        sqlx::query("SELECT * FROM playback_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE")
            .bind(id)
            .bind(user)
            .fetch_optional(&mut **tx)
            .await?
            .map(|row| Grant { row, state }),
    )
}

pub async fn accept(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    grant: &Grant,
    sample: &protocol::PlaybackObservation,
    stopping: bool,
) -> Result<protocol::PlaybackObservationReceipt> {
    let id: Uuid = grant.row.get("id");
    let user: Uuid = grant.row.get("user_id");
    let room: Uuid = grant.row.get("room_id");
    let generation: i64 = grant.row.get("generation");
    if generation != i64::from(sample.media_generation)
        || grant.state["media_generation"].as_u64() != Some(u64::from(sample.media_generation))
        || grant.state["media_id"].as_str()
            != Some(grant.row.get::<Uuid, _>("media_id").to_string().as_str())
    {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    if sqlx::query("SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE")
        .bind(room)
        .bind(user)
        .fetch_optional(&mut **tx)
        .await?
        .is_none()
    {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    let row = sqlx::query("SELECT * FROM playback_observations WHERE session_id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "observation_version_required"))?;
    // Evaluate expiry after every possibly contended lock, not before its wait.
    let live = sqlx::query("SELECT stopped,expires_at>clock_timestamp() AS unexpired FROM playback_sessions WHERE id=$1 AND user_id=$2")
        .bind(id).bind(user).fetch_one(&mut **tx).await?;
    let stopped: bool = live.get("stopped");
    if !live.get::<bool, _>("unexpired") || stopped && !stopping {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    let position = observations::original_position(
        sample,
        row.get("timeline_origin_ms"),
        row.get("duration_ms"),
    )
    .map_err(|reason| err(StatusCode::BAD_REQUEST, reason))?;
    let seq = row.get::<i64, _>("seq") as u64;
    if sample.seq < seq {
        return Err(err(StatusCode::CONFLICT, "observation_sequence_stale"));
    }
    if sample.seq == seq {
        let saved: protocol::PlaybackObservation =
            serde_json::from_value(row.get("payload")).map_err(anyhow::Error::from)?;
        if saved != *sample {
            return Err(err(StatusCode::CONFLICT, "observation_conflict"));
        }
        return Ok(protocol::PlaybackObservationReceipt {
            session_id: id,
            observation_seq: seq,
            has_played: row.get("has_played"),
        });
    }
    if stopped {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    if sample.event == protocol::PlaybackObservationEvent::Ended {
        let incomplete: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM media_jobs WHERE session_id=$1 AND status<>'succeeded')",
        )
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
        if incomplete {
            return Err(err(StatusCode::BAD_REQUEST, "observation_not_complete"));
        }
    }
    let payload = serde_json::to_value(sample).map_err(anyhow::Error::from)?;
    let has_played = row.get::<bool, _>("has_played") || sample.has_played;
    sqlx::query("UPDATE playback_observations SET seq=$2,payload=$3,position_ms=$4,has_played=$5,observed_at=clock_timestamp() WHERE session_id=$1")
        .bind(id).bind(sample.seq as i64).bind(payload).bind(position).bind(has_played)
        .execute(&mut **tx).await?;
    Ok(protocol::PlaybackObservationReceipt {
        session_id: id,
        observation_seq: sample.seq,
        has_played,
    })
}

pub async fn observe(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(sample): Json<protocol::PlaybackObservation>,
) -> Result<Json<protocol::PlaybackObservationReceipt>> {
    let user = auth(&app, &h, true).await?;
    let mut tx = app.db.begin().await?;
    let grant = lock_grant(&mut tx, id, user.id)
        .await?
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    let receipt = accept(&mut tx, &grant, &sample, false).await?;
    tx.commit().await?;
    // ACK means persisted, not that remote I/O succeeded. The independent
    // maintenance owner retries admission when reporting capacity is occupied.
    tokio::spawn(async move {
        if upstream::report(&app, id, "progress").await.is_err() {
            tracing::warn!(session=%id, "upstream observation report failed");
        }
    });
    Ok(Json(receipt))
}

/// Same-key replay must query the current sequence, never the encrypted seq=0
/// response saved during preparation. Legacy plans remain unnegotiated.
pub async fn refresh_plan(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    plan: &mut Value,
) -> Result<()> {
    if plan["observation_version"] != 1 {
        return Ok(());
    }
    let id: Uuid =
        serde_json::from_value(plan["session_id"].clone()).map_err(anyhow::Error::from)?;
    let receipt = observations::receipt(tx, id)
        .await?
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    plan["observation_seq"] = json!(receipt.observation_seq);
    Ok(())
}
