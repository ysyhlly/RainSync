use protocol::{
    Action, Command, NativePlatformLiveBinding, NativePlatformLiveSyncMode, PlaybackStatus,
    RoomState,
};
use uuid::Uuid;

fn fixture() -> (RoomState, Command) {
    let state = RoomState {
        room_id: Uuid::from_u128(1),
        revision: 2,
        media_id: Some(Uuid::from_u128(3)),
        media_generation: 4,
        playback_status: PlaybackStatus::Playing,
        anchor_position_ms: 0.0,
        anchor_server_time_ms: 100.0,
        playback_rate: 1.0,
        controller_user_id: Uuid::from_u128(5),
        duration_ms: None,
        clock_epoch: Uuid::from_u128(6),
        live: Some(NativePlatformLiveBinding {
            version: 1,
            broadcast_id: "12:34:1700000000".into(),
            sync_mode: NativePlatformLiveSyncMode::LiveEdgeControl,
        }),
    };
    let command = Command {
        live_version: Some(1),
        protocol_version: 1,
        room_id: state.room_id,
        command_id: Uuid::from_u128(7),
        control_epoch: None,
        expected_revision: state.revision,
        media_generation: state.media_generation,
        action: Action::Pause,
    };
    (state, command)
}

#[test]
fn live_clock_never_extrapolates_and_pause_resume_returns_to_edge() {
    let (state, mut command) = fixture();
    assert_eq!(room_core::position(&state, 1e12), 0.0);
    let paused =
        room_core::reduce(&state, &command, state.controller_user_id, false, 5000.0).unwrap();
    assert_eq!(paused.anchor_position_ms, 0.0);
    assert_eq!(paused.media_generation, state.media_generation);
    command.action = Action::Play;
    command.expected_revision = paused.revision;
    let playing =
        room_core::reduce(&paused, &command, state.controller_user_id, false, 90000.0).unwrap();
    assert_eq!(playing.anchor_position_ms, 0.0);
    assert_eq!(playing.playback_rate, 1.0);
    assert_eq!(playing.media_generation, state.media_generation);
}

#[test]
fn legacy_clients_seek_rate_and_auto_next_fail_closed() {
    let (state, mut command) = fixture();
    command.live_version = None;
    assert_eq!(
        room_core::reduce(&state, &command, state.controller_user_id, false, 200.0),
        Err("native_live_client_unsupported")
    );
    command.live_version = Some(1);
    for (action, error) in [
        (
            Action::Seek { position_ms: 0.0 },
            "native_live_seek_unsupported",
        ),
        (
            Action::SetRate { rate: 1.5 },
            "native_live_rate_unsupported",
        ),
        (
            Action::SetRate { rate: f64::NAN },
            "native_live_rate_unsupported",
        ),
        (
            Action::EndMedia {
                position_ms: 90000.0,
            },
            "native_live_end_unsupported",
        ),
    ] {
        command.action = action;
        assert_eq!(
            room_core::reduce(&state, &command, state.controller_user_id, false, 90000.0),
            Err(error)
        );
    }
    command.action = Action::SetRate { rate: 1.0 };
    assert_eq!(
        room_core::reduce(&state, &command, state.controller_user_id, false, 200.0)
            .unwrap()
            .playback_rate,
        1.0
    );
}

#[test]
fn stale_generations_and_media_switches_do_not_keep_live_mode() {
    let (state, mut command) = fixture();
    command.media_generation -= 1;
    assert_eq!(
        room_core::reduce(&state, &command, state.controller_user_id, false, 200.0),
        Err("stale_media")
    );
    command.media_generation = state.media_generation;
    command.action = Action::ChangeMedia {
        media_id: Uuid::from_u128(9),
    };
    let ordinary =
        room_core::reduce(&state, &command, state.controller_user_id, false, 200.0).unwrap();
    assert!(ordinary.live.is_none());
    assert_eq!(ordinary.media_generation, state.media_generation + 1);
    assert_eq!(ordinary.anchor_position_ms, 0.0);
}

#[test]
fn null_duration_vod_stays_seekable_and_legacy_hash_shape_is_unchanged() {
    let (mut state, mut command) = fixture();
    state.live = None;
    command.live_version = None;
    command.action = Action::Seek {
        position_ms: 5000.0,
    };
    assert_eq!(
        room_core::reduce(&state, &command, state.controller_user_id, false, 200.0)
            .unwrap()
            .anchor_position_ms,
        5000.0
    );
    let value = serde_json::to_value(command).unwrap();
    assert!(value.get("live_version").is_none());
    assert!(serde_json::to_value(state).unwrap().get("live").is_none());
}

#[test]
fn live_selection_and_control_diagnostics_replay_with_explicit_immutable_fact() {
    use room_core::diagnostics::{
        Envelope, Event, FORMAT_VERSION, Lifecycle, LifecycleState, Operation, REDUCER_VERSION,
        ResolvedMedia, SafeCommand, Window, decode_envelope, verify,
    };
    let (mut before, mut command) = fixture();
    let live = before.live.take().unwrap();
    before.duration_ms = Some(10_000.0);
    command.action = Action::ChangeMedia {
        media_id: Uuid::from_u128(9),
    };
    let mut after =
        room_core::reduce(&before, &command, before.controller_user_id, false, 200.0).unwrap();
    after.live = Some(live.clone());
    after.duration_ms = None;
    after.playback_rate = 1.0;
    let lifecycle = Lifecycle {
        state: LifecycleState::Active,
        epoch: 0,
    };
    let envelope = Envelope {
        schema_version: FORMAT_VERSION,
        reducer_version: REDUCER_VERSION.into(),
        event_id: Uuid::from_u128(10),
        actor_id: Some(before.controller_user_id),
        actor_is_admin: false,
        before: before.clone(),
        lifecycle_before: lifecycle,
        lifecycle_after: lifecycle,
        operation: Operation::MediaControl {
            command: SafeCommand::from_command(&command),
            server_time_ms: 200.0,
            resolved_media: ResolvedMedia {
                media_id: after.media_id.unwrap(),
                duration_ms: None,
                live: Some(live),
            },
        },
    };
    let envelope = decode_envelope(&serde_json::to_vec(&envelope).unwrap()).unwrap();
    let window = Window {
        format_version: FORMAT_VERSION,
        reducer_version: REDUCER_VERSION.into(),
        room_id: before.room_id,
        captured_at_ms: 200,
        after_revision: before.revision,
        retained_from_revision: Some(after.revision),
        snapshot: after.clone(),
        lifecycle,
        events: vec![Event {
            revision: after.revision,
            recorded_at_ms: 200,
            after: Some(after),
            envelope: Some(envelope),
            unavailable: None,
        }],
        truncated: false,
    };
    let report = verify(&window);
    assert!(
        report.continuous && report.reaches_snapshot && report.all_transitions_verified,
        "{report:?}"
    );
}
