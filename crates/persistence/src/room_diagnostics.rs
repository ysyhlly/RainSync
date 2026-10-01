//! Atomic diagnostic facts for the existing bounded room-event history.
//! Callers retain the room -> snapshot locks used by their state transition.
use anyhow::{Result, bail};
use protocol::RoomState;
use room_core::diagnostics::{
    Envelope, Event, FORMAT_VERSION, Lifecycle, LifecycleState, Operation, REDUCER_VERSION, Window,
    decode_envelope, validate_state, verify,
};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

pub fn lifecycle(state: &str, epoch: i64) -> Result<Lifecycle> {
    if epoch < 0 {
        bail!("invalid_diagnostic_lifecycle");
    }
    let state = match state {
        "active" => LifecycleState::Active,
        "closing" => LifecycleState::Closing,
        "closed" => LifecycleState::Closed,
        "archived" => LifecycleState::Archived,
        _ => bail!("invalid_diagnostic_lifecycle"),
    };
    Ok(Lifecycle { state, epoch })
}

pub fn envelope(
    event_id: Uuid,
    before: RoomState,
    actor: Option<(Uuid, bool)>,
    lifecycle_before: Lifecycle,
    lifecycle_after: Lifecycle,
    operation: Operation,
) -> Envelope {
    Envelope {
        schema_version: FORMAT_VERSION,
        reducer_version: REDUCER_VERSION.into(),
        event_id,
        actor_id: actor.map(|value| value.0),
        actor_is_admin: actor.is_some_and(|value| value.1),
        before,
        lifecycle_before,
        lifecycle_after,
        operation,
    }
}

pub async fn append(
    tx: &mut Transaction<'_, Postgres>,
    after: &RoomState,
    envelope: Envelope,
) -> Result<()> {
    validate_state(after).map_err(anyhow::Error::msg)?;
    let bytes = serde_json::to_vec(&envelope)?;
    let envelope = decode_envelope(&bytes).map_err(anyhow::Error::msg)?;
    let window = Window {
        format_version: FORMAT_VERSION,
        reducer_version: REDUCER_VERSION.into(),
        room_id: after.room_id,
        captured_at_ms: 0,
        after_revision: envelope.before.revision,
        retained_from_revision: Some(after.revision),
        snapshot: after.clone(),
        lifecycle: envelope.lifecycle_after,
        events: vec![Event {
            revision: after.revision,
            recorded_at_ms: 0,
            after: Some(after.clone()),
            envelope: Some(envelope),
            unavailable: None,
        }],
        truncated: false,
    };
    let report = verify(&window);
    if !report.continuous || !report.reaches_snapshot || report.unverifiable_steps != 0 {
        bail!("invalid_diagnostic_transition");
    }
    sqlx::query("INSERT INTO room_events(room_id,revision,state,diagnostic,created_at) VALUES($1,$2,$3,$4,clock_timestamp())")
        .bind(after.room_id)
        .bind(i64::from(after.revision))
        .bind(serde_json::to_value(after)?)
        .bind(serde_json::to_value(window.events[0].envelope.as_ref().unwrap())?)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Startup never infers elapsed playback across two monotonic clock epochs.
/// Keep its existing pause/reset semantics, with an explicit atomic checkpoint.
pub async fn reset_clock(pool: &PgPool, epoch: Uuid) -> Result<()> {
    let rooms: Vec<Uuid> = sqlx::query_scalar("SELECT room_id FROM room_snapshots")
        .fetch_all(pool)
        .await?;
    for room in rooms {
        let mut tx = pool.begin().await?;
        let row = sqlx::query(
            "SELECT lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE",
        )
        .bind(room)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else {
            continue;
        };
        let before: RoomState = serde_json::from_value(
            sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
                .bind(room)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        let mut state = before.clone();
        state.playback_status = protocol::PlaybackStatus::Paused;
        state.clock_epoch = epoch;
        state.anchor_server_time_ms = 0.0;
        state.revision = state
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("room_revision_exhausted"))?;
        let life = lifecycle(
            row.get::<String, _>("lifecycle").as_str(),
            row.get("lifecycle_epoch"),
        )?;
        let diagnostic = envelope(
            Uuid::new_v4(),
            before,
            None,
            life,
            life,
            Operation::Checkpoint {
                reason: room_core::diagnostics::CheckpointReason::ServerRestart,
                command: None,
            },
        );
        sqlx::query("UPDATE room_snapshots SET state=$2 WHERE room_id=$1")
            .bind(room)
            .bind(serde_json::to_value(&state)?)
            .execute(&mut *tx)
            .await?;
        append(&mut tx, &state, diagnostic).await?;
        tx.commit().await?;
    }
    Ok(())
}
