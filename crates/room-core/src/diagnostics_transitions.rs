//! Version-2 deterministic state projections. Resolved media and admitted
//! lifecycle facts are inputs, not independent proof of database authorization,
//! upstream truth or resource drainage. This module has no effectful handles.
use super::{Envelope, IssueCode, Lifecycle, LifecycleState, Operation, SafeAction};
use protocol::{PlaybackStatus, RoomState};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolvedMedia {
    pub media_id: Uuid,
    pub duration_ms: Option<f64>,
}

impl ResolvedMedia {
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if self.media_id.is_nil()
            || self
                .duration_ms
                .is_some_and(|duration| !duration.is_finite() || duration < 0.0)
        {
            return Err("invalid_state");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum LifecycleTransition {
    Closing,
    Closed,
    Reopened,
    Archived,
}

pub(super) fn apply(envelope: &Envelope) -> Result<(RoomState, Lifecycle), IssueCode> {
    let before = &envelope.before;
    let mut lifecycle = envelope.lifecycle_before;
    let mut next = before.clone();
    match &envelope.operation {
        Operation::MediaControl {
            command,
            server_time_ms,
            resolved_media,
        } => {
            if lifecycle.state != LifecycleState::Active {
                return Err(IssueCode::LifecycleMismatch);
            }
            let actor = envelope.actor_id.ok_or(IssueCode::ActorRequired)?;
            if *server_time_ms < before.anchor_server_time_ms {
                return Err(IssueCode::InvalidEventTime);
            }
            match command.action {
                SafeAction::ChangeMedia { media_id } if media_id == resolved_media.media_id => {}
                SafeAction::EndMedia { .. } => {}
                _ => return Err(IssueCode::InvalidCommand),
            }
            next = crate::reduce(
                before,
                &command.to_command(before.room_id),
                actor,
                envelope.actor_is_admin,
                *server_time_ms,
            )
            .map_err(|_| IssueCode::ReducerRejected)?;
            // These are the recorded result of live media/playlist resolution,
            // not values inferred from today's database or the after-state.
            next.media_id = Some(resolved_media.media_id);
            next.duration_ms = resolved_media.duration_ms;
        }
        Operation::Lifecycle {
            transition,
            expected_revision,
            server_time_ms,
        } => {
            if *expected_revision != before.revision {
                return Err(IssueCode::RevisionGap);
            }
            let (expected, target, increment_epoch) = match transition {
                LifecycleTransition::Closing => {
                    (LifecycleState::Active, LifecycleState::Closing, true)
                }
                LifecycleTransition::Closed => {
                    (LifecycleState::Closing, LifecycleState::Closed, false)
                }
                LifecycleTransition::Reopened => {
                    (LifecycleState::Closed, LifecycleState::Active, true)
                }
                LifecycleTransition::Archived => {
                    (LifecycleState::Closed, LifecycleState::Archived, false)
                }
            };
            if lifecycle.state != expected {
                return Err(IssueCode::LifecycleMismatch);
            }
            if *transition == LifecycleTransition::Closed {
                // A committed close is a state fact, never drainage evidence.
                // Only the live cleanup executor may decide to commit it.
                if envelope.actor_id.is_some()
                    || envelope.actor_is_admin
                    || server_time_ms.is_some()
                    || before.playback_status != PlaybackStatus::Paused
                {
                    return Err(IssueCode::InvalidCommand);
                }
            } else {
                let actor = envelope.actor_id.ok_or(IssueCode::ActorRequired)?;
                if actor != before.controller_user_id && !envelope.actor_is_admin {
                    return Err(IssueCode::ControllerRequired);
                }
                let time = server_time_ms.ok_or(IssueCode::InvalidEventTime)?;
                if time < before.anchor_server_time_ms {
                    return Err(IssueCode::InvalidEventTime);
                }
                if *transition == LifecycleTransition::Closing {
                    next.anchor_position_ms = crate::position(before, time);
                }
                next.playback_status = PlaybackStatus::Paused;
                next.anchor_server_time_ms = time;
            }
            next.revision = next.revision.checked_add(1).ok_or(IssueCode::RevisionGap)?;
            lifecycle.state = target;
            if increment_epoch {
                lifecycle.epoch = lifecycle
                    .epoch
                    .checked_add(1)
                    .ok_or(IssueCode::InvalidLifecycle)?;
            }
        }
        Operation::ServerRestart { clock_epoch } => {
            if envelope.actor_id.is_some()
                || envelope.actor_is_admin
                || clock_epoch.is_nil()
                || *clock_epoch == before.clock_epoch
            {
                return Err(IssueCode::InvalidCommand);
            }
            next.playback_status = PlaybackStatus::Paused;
            next.clock_epoch = *clock_epoch;
            next.anchor_server_time_ms = 0.0;
            next.revision = next.revision.checked_add(1).ok_or(IssueCode::RevisionGap)?;
        }
        _ => return Err(IssueCode::InvalidCommand),
    }
    super::validate_state(&next).map_err(|_| IssueCode::InvalidState)?;
    Ok((next, lifecycle))
}
