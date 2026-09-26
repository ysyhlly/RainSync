use protocol::{Action, Command, PlaybackStatus, RoomState, VERSION};
use uuid::Uuid;

pub fn position(state: &RoomState, now: f64) -> f64 {
    let elapsed = if state.playback_status == PlaybackStatus::Playing {
        (now - state.anchor_server_time_ms).max(0.0) * state.playback_rate
    } else {
        0.0
    };
    (state.anchor_position_ms + elapsed)
        .max(0.0)
        .min(state.duration_ms.unwrap_or(f64::MAX))
}

pub fn reduce(
    state: &RoomState,
    command: &Command,
    actor: Uuid,
    admin: bool,
    now: f64,
) -> Result<RoomState, &'static str> {
    if command.protocol_version != VERSION {
        return Err("protocol_version");
    }
    if actor != state.controller_user_id && !admin {
        return Err("controller_required");
    }
    if command.room_id != state.room_id {
        return Err("wrong_room");
    }
    if command.expected_revision != state.revision {
        return Err("revision_conflict");
    }
    if command.media_generation != state.media_generation {
        return Err("stale_media");
    }
    if state.media_id.is_none() && !matches!(command.action, Action::ChangeMedia { .. }) {
        return Err("no_media");
    }
    let mut next = state.clone();
    next.anchor_position_ms = position(state, now);
    next.anchor_server_time_ms = now;
    match command.action {
        Action::Play => next.playback_status = PlaybackStatus::Playing,
        Action::Pause => next.playback_status = PlaybackStatus::Paused,
        Action::Seek { position_ms } => {
            if !position_ms.is_finite() || position_ms < 0.0 {
                return Err("invalid_position");
            }
            next.anchor_position_ms = position_ms.min(state.duration_ms.unwrap_or(f64::MAX));
        }
        Action::SetRate { rate } => {
            if !rate.is_finite() || !(0.25..=2.0).contains(&rate) {
                return Err("invalid_rate");
            }
            next.playback_rate = rate;
        }
        Action::ChangeMedia { media_id } => {
            next.media_id = Some(media_id);
            next.media_generation = next
                .media_generation
                .checked_add(1)
                .ok_or("generation_overflow")?;
            next.anchor_position_ms = 0.0;
            next.duration_ms = None;
            next.playback_status = PlaybackStatus::Paused;
        }
    }
    next.revision = next.revision.checked_add(1).ok_or("revision_overflow")?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (RoomState, Command) {
        let s = RoomState {
            room_id: Uuid::new_v4(),
            revision: 4,
            media_id: Some(Uuid::new_v4()),
            media_generation: 2,
            playback_status: PlaybackStatus::Playing,
            anchor_position_ms: 1000.0,
            anchor_server_time_ms: 100.0,
            playback_rate: 2.0,
            controller_user_id: Uuid::new_v4(),
            duration_ms: Some(10000.0),
            clock_epoch: Uuid::new_v4(),
        };
        let c = Command {
            protocol_version: VERSION,
            room_id: s.room_id,
            command_id: Uuid::new_v4(),
            control_epoch: None,
            expected_revision: 4,
            media_generation: 2,
            action: Action::Pause,
        };
        (s, c)
    }
    #[test]
    fn pause_preserves_elapsed_rate() {
        let (s, c) = fixture();
        let n = reduce(&s, &c, s.controller_user_id, false, 600.0).unwrap();
        assert_eq!(n.anchor_position_ms, 2000.0);
        assert_eq!(n.revision, 5);
    }
    #[test]
    fn permission_and_conflict() {
        let (s, mut c) = fixture();
        assert_eq!(
            reduce(&s, &c, Uuid::new_v4(), false, 600.0),
            Err("controller_required")
        );
        c.expected_revision = 3;
        assert_eq!(
            reduce(&s, &c, s.controller_user_id, false, 600.0),
            Err("revision_conflict")
        );
    }
    #[test]
    fn stale_generation_rejected() {
        let (s, mut c) = fixture();
        c.media_generation = 1;
        assert_eq!(
            reduce(&s, &c, s.controller_user_id, false, 0.0),
            Err("stale_media")
        );
    }
    #[test]
    fn clamps_and_rejects_nonfinite() {
        let (s, mut c) = fixture();
        assert_eq!(position(&s, 90000.0), 10000.0);
        c.action = Action::Seek {
            position_ms: f64::NAN,
        };
        assert!(reduce(&s, &c, s.controller_user_id, false, 0.0).is_err());
    }
}
