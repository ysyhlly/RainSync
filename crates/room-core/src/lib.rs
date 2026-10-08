pub mod diagnostics;
pub mod replay;

use protocol::{Action, Command, PlaybackStatus, RoomState, VERSION};
use uuid::Uuid;

pub fn position(state: &RoomState, now: f64) -> f64 {
    if state.live.is_some() {
        // An elapsed room clock is not a broadcast timeline.
        return 0.0;
    }
    let elapsed = if state.playback_status == PlaybackStatus::Playing {
        (now - state.anchor_server_time_ms).max(0.0) * state.playback_rate
    } else {
        0.0
    };
    protocol::bounded_position(state.anchor_position_ms + elapsed, state.duration_ms)
}

/// Room ownership changes do not change the current media activity or timeline.
/// The caller must check the durable owner and target membership in its transaction.
pub fn transfer_controller(
    state: &RoomState,
    expected_revision: u32,
    new_owner: Uuid,
) -> Result<RoomState, &'static str> {
    if expected_revision != state.revision {
        return Err("revision_conflict");
    }
    let mut next = state.clone();
    next.controller_user_id = new_owner;
    next.revision = next.revision.checked_add(1).ok_or("revision_overflow")?;
    Ok(next)
}

pub fn reduce(
    state: &RoomState,
    command: &Command,
    actor: Uuid,
    admin: bool,
    now: f64,
) -> Result<RoomState, &'static str> {
    reduce_with_permission(state, command, actor, admin, None, now)
}

/// `permission` is an exact action admitted by the caller's durable authority gate.
/// It is also retained in diagnostics so offline replay never labels a moderator admin.
pub fn reduce_with_permission(
    state: &RoomState,
    command: &Command,
    actor: Uuid,
    admin: bool,
    permission: Option<protocol::RoomPermission>,
    now: f64,
) -> Result<RoomState, &'static str> {
    if command.protocol_version != VERSION {
        return Err("protocol_version");
    }
    if actor != state.controller_user_id
        && !admin
        && permission != Some(protocol::RoomPermission::for_action(&command.action))
    {
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
    if state.live.is_some() {
        if command.live_version != Some(1) {
            return Err("native_live_client_unsupported");
        }
        match command.action {
            Action::Seek { .. } => return Err("native_live_seek_unsupported"),
            Action::SetRate { rate } if rate != 1.0 => return Err("native_live_rate_unsupported"),
            Action::EndMedia { .. } => return Err("native_live_end_unsupported"),
            _ => {}
        }
    }
    let mut next = state.clone();
    next.anchor_position_ms = position(state, now);
    next.anchor_server_time_ms = now;
    match command.action {
        Action::Play => {
            if state.live.is_none()
                && (state.playback_status == PlaybackStatus::Ended
                    || state.duration_ms.is_some_and(|d| position(state, now) >= d))
            {
                next.anchor_position_ms = 0.0;
                next.media_generation = next
                    .media_generation
                    .checked_add(1)
                    .ok_or("generation_overflow")?;
            }
            next.playback_status = PlaybackStatus::Playing;
        }
        Action::EndMedia { position_ms } => {
            if state.playback_status != PlaybackStatus::Playing
                || !position_ms.is_finite()
                || position_ms <= 0.0
                || state.duration_ms.is_some_and(|d| position_ms + 1500.0 < d)
                || position(state, now) + 1500.0 < position_ms
            {
                return Err("invalid_position");
            }
            next.anchor_position_ms = 0.0;
            next.media_generation = next
                .media_generation
                .checked_add(1)
                .ok_or("generation_overflow")?;
            next.playback_status = PlaybackStatus::Playing;
        }
        Action::Pause => next.playback_status = PlaybackStatus::Paused,
        Action::Seek { position_ms } => {
            if !position_ms.is_finite() || position_ms < 0.0 {
                return Err("invalid_position");
            }
            next.anchor_position_ms = protocol::bounded_position(position_ms, state.duration_ms);
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
            if state.live.is_some() {
                next.playback_rate = 1.0;
            }
            next.live = None;
            next.playback_status = PlaybackStatus::Playing;
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
            live: None,
            clock_epoch: Uuid::new_v4(),
        };
        let c = Command {
            protocol_version: VERSION,
            room_id: s.room_id,
            command_id: Uuid::new_v4(),
            live_version: None,
            control_epoch: None,
            expected_revision: 4,
            media_generation: 2,
            action: Action::Pause,
        };
        (s, c)
    }
    #[test]
    fn play_at_end_restarts_a_new_generation() {
        let (mut s, mut c) = fixture();
        s.anchor_position_ms = 10000.0;
        c.action = Action::Play;
        let n = reduce(&s, &c, s.controller_user_id, false, 100.0).unwrap();
        assert_eq!(n.anchor_position_ms, 0.0);
        assert_eq!(n.media_generation, s.media_generation + 1);
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
    fn a_delegated_action_never_authorizes_another_action() {
        let (state, mut command) = fixture();
        let moderator = Uuid::new_v4();
        assert!(
            reduce_with_permission(
                &state,
                &command,
                moderator,
                false,
                Some(protocol::RoomPermission::Pause),
                600.0
            )
            .is_ok()
        );
        for permission in [
            protocol::RoomPermission::Play,
            protocol::RoomPermission::Seek,
            protocol::RoomPermission::Queue,
            protocol::RoomPermission::Invite,
        ] {
            assert_eq!(
                reduce_with_permission(&state, &command, moderator, false, Some(permission), 600.0),
                Err("controller_required")
            );
        }
        command.action = Action::ChangeMedia {
            media_id: Uuid::new_v4(),
        };
        assert_eq!(
            reduce_with_permission(
                &state,
                &command,
                moderator,
                false,
                Some(protocol::RoomPermission::Pause),
                600.0
            ),
            Err("controller_required")
        );
        assert!(
            reduce_with_permission(
                &state,
                &command,
                moderator,
                false,
                Some(protocol::RoomPermission::ChangeMedia),
                600.0
            )
            .is_ok()
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
    fn unknown_duration_seek_is_bounded() {
        let (mut s, mut c) = fixture();
        s.duration_ms = None;
        c.action = Action::Seek {
            position_ms: f64::MAX,
        };
        assert_eq!(
            reduce(&s, &c, s.controller_user_id, false, 0.0)
                .unwrap()
                .anchor_position_ms,
            protocol::UNKNOWN_DURATION_LIMIT_MS
        );
        s.duration_ms = Some(1234.0);
        assert_eq!(
            reduce(&s, &c, s.controller_user_id, false, 0.0)
                .unwrap()
                .anchor_position_ms,
            1234.0
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

    #[test]
    fn ownership_transfer_preserves_media_and_playback_timeline() {
        let (state, _) = fixture();
        let next_owner = Uuid::new_v4();
        let mut expected = state.clone();
        expected.controller_user_id = next_owner;
        expected.revision += 1;
        assert_eq!(
            transfer_controller(&state, state.revision, next_owner),
            Ok(expected)
        );
        assert_eq!(
            transfer_controller(&state, state.revision - 1, next_owner),
            Err("revision_conflict")
        );
        let mut exhausted = state;
        exhausted.revision = u32::MAX;
        assert_eq!(
            transfer_controller(&exhausted, u32::MAX, next_owner),
            Err("revision_overflow")
        );
    }

    #[test]
    fn transferred_controller_rejects_former_owner_and_old_revision() {
        let (state, mut command) = fixture();
        let owner = Uuid::new_v4();
        let next = transfer_controller(&state, state.revision, owner).unwrap();
        assert_eq!(
            reduce(&next, &command, state.controller_user_id, false, 600.0),
            Err("controller_required")
        );
        assert_eq!(
            reduce(&next, &command, owner, false, 600.0),
            Err("revision_conflict")
        );
        command.expected_revision = next.revision;
        assert!(reduce(&next, &command, owner, false, 600.0).is_ok());
    }
}
