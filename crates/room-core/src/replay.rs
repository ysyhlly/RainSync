//! Pure control/ownership diagnostic replay. No authorization issuance, database,
//! chat, media preparation or provider operation can be called through this API.
//! The coordinator must wire and map a versioned durable event envelope before
//! this is used to diagnose complete live room histories.
use protocol::{Command, RoomState};
use uuid::Uuid;

pub const REDUCER_VERSION: &str = "room-core/0.1";

pub enum Operation<'a> {
    Control {
        command: &'a Command,
        actor_id: Uuid,
        actor_is_admin: bool,
        server_time_ms: f64,
    },
    TransferOwnership {
        expected_revision: u32,
        owner_id: Uuid,
    },
}

pub struct Step<'a> {
    pub operation: Operation<'a>,
    pub committed_state: &'a RoomState,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ReplayError {
    pub step_index: usize,
    pub reason: &'static str,
}

/// Replay supplied historical facts through the fixed pure reducer and compare
/// every result to its supplied committed post-state. Clock changes and lifecycle
/// transitions require a new checkpoint; unknown or incomplete facts fail closed.
/// This deliberately does not manufacture provider/duration/playlist facts that
/// the server adds around CHANGE_MEDIA and END_MEDIA.
pub fn replay(
    version: &str,
    checkpoint: &RoomState,
    steps: &[Step<'_>],
) -> Result<RoomState, ReplayError> {
    let error = |step_index, reason| ReplayError { step_index, reason };
    if version != REDUCER_VERSION {
        return Err(error(0, "unsupported_reducer_version"));
    }
    let mut state = checkpoint.clone();
    let mut last_time = checkpoint.anchor_server_time_ms;
    if !last_time.is_finite() || last_time < 0.0 {
        return Err(error(0, "invalid_checkpoint_time"));
    }
    for (index, step) in steps.iter().enumerate() {
        if step.committed_state.room_id != checkpoint.room_id {
            return Err(error(index, "wrong_room"));
        }
        if step.committed_state.clock_epoch != checkpoint.clock_epoch {
            return Err(error(index, "checkpoint_required"));
        }
        let next = match &step.operation {
            Operation::Control {
                command,
                actor_id,
                actor_is_admin,
                server_time_ms,
            } => {
                if !server_time_ms.is_finite() || *server_time_ms < last_time {
                    return Err(error(index, "invalid_event_time"));
                }
                last_time = *server_time_ms;
                crate::reduce(&state, command, *actor_id, *actor_is_admin, *server_time_ms)
                    .map_err(|reason| error(index, reason))?
            }
            Operation::TransferOwnership {
                expected_revision,
                owner_id,
            } => crate::transfer_controller(&state, *expected_revision, *owner_id)
                .map_err(|reason| error(index, reason))?,
        };
        if &next != step.committed_state {
            return Err(error(index, "committed_state_mismatch"));
        }
        state = next;
    }
    Ok(state)
}
