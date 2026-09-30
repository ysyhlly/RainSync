// Exercise the public replay module used by the integration baseline.
use room_core::{reduce, replay};

use protocol::{Action, Command, PlaybackStatus, RoomState, VERSION};
use replay::{Operation, REDUCER_VERSION, Step};
use uuid::Uuid;

fn fixture() -> RoomState {
    RoomState {
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
    }
}

fn command(state: &RoomState, action: Action) -> Command {
    Command {
        protocol_version: VERSION,
        room_id: state.room_id,
        command_id: Uuid::new_v4(),
        control_epoch: None,
        expected_revision: state.revision,
        media_generation: state.media_generation,
        action,
    }
}

fn step<'a>(command: &'a Command, state: &'a RoomState, actor: Uuid, now: f64) -> Step<'a> {
    Step {
        operation: Operation::Control {
            command,
            actor_id: actor,
            actor_is_admin: false,
            server_time_ms: now,
        },
        committed_state: state,
    }
}

#[test]
fn offline_control_and_transfer_match_the_complete_committed_end_state() {
    let checkpoint = fixture();
    let pause = command(&checkpoint, Action::Pause);
    let mut paused = checkpoint.clone();
    paused.revision = 5;
    paused.anchor_position_ms = 2000.0;
    paused.anchor_server_time_ms = 600.0;
    paused.playback_status = PlaybackStatus::Paused;
    let successor = Uuid::new_v4();
    let mut transferred = paused.clone();
    transferred.revision = 6;
    transferred.controller_user_id = successor;
    let seek = command(
        &transferred,
        Action::Seek {
            position_ms: 3500.0,
        },
    );
    let mut final_state = transferred.clone();
    final_state.revision = 7;
    final_state.anchor_position_ms = 3500.0;
    final_state.anchor_server_time_ms = 900.0;
    let steps = [
        Step {
            operation: Operation::Control {
                command: &pause,
                actor_id: checkpoint.controller_user_id,
                actor_is_admin: false,
                server_time_ms: 600.0,
            },
            committed_state: &paused,
        },
        Step {
            operation: Operation::TransferOwnership {
                expected_revision: 5,
                owner_id: successor,
            },
            committed_state: &transferred,
        },
        Step {
            operation: Operation::Control {
                command: &seek,
                actor_id: successor,
                actor_is_admin: false,
                server_time_ms: 900.0,
            },
            committed_state: &final_state,
        },
    ];
    assert_eq!(
        replay::replay(REDUCER_VERSION, &checkpoint, &steps).unwrap(),
        final_state
    );
    assert_eq!(
        checkpoint.revision, 4,
        "replay does not mutate its checkpoint"
    );
    assert_eq!(
        replay::replay("future-version", &checkpoint, &steps)
            .unwrap_err()
            .reason,
        "unsupported_reducer_version"
    );
}

#[test]
fn replay_rejects_missing_revisions_wrong_actor_tampering_and_unknown_clock() {
    let checkpoint = fixture();
    let mut pause = command(&checkpoint, Action::Pause);
    let expected = reduce(
        &checkpoint,
        &pause,
        checkpoint.controller_user_id,
        false,
        600.0,
    )
    .unwrap();
    pause.expected_revision += 1;
    assert_eq!(
        replay::replay(
            REDUCER_VERSION,
            &checkpoint,
            &[step(
                &pause,
                &expected,
                checkpoint.controller_user_id,
                600.0
            )]
        )
        .unwrap_err()
        .reason,
        "revision_conflict"
    );
    pause.expected_revision -= 1;
    assert_eq!(
        replay::replay(
            REDUCER_VERSION,
            &checkpoint,
            &[step(&pause, &expected, Uuid::new_v4(), 600.0)]
        )
        .unwrap_err()
        .reason,
        "controller_required"
    );
    let mut tampered = expected.clone();
    tampered.anchor_position_ms += 1.0;
    assert_eq!(
        replay::replay(
            REDUCER_VERSION,
            &checkpoint,
            &[step(
                &pause,
                &tampered,
                checkpoint.controller_user_id,
                600.0
            )]
        )
        .unwrap_err()
        .reason,
        "committed_state_mismatch"
    );
    tampered = expected.clone();
    tampered.clock_epoch = Uuid::new_v4();
    assert_eq!(
        replay::replay(
            REDUCER_VERSION,
            &checkpoint,
            &[step(
                &pause,
                &tampered,
                checkpoint.controller_user_id,
                600.0
            )]
        )
        .unwrap_err()
        .reason,
        "checkpoint_required"
    );
    assert_eq!(
        replay::replay(
            REDUCER_VERSION,
            &checkpoint,
            &[step(
                &pause,
                &expected,
                checkpoint.controller_user_id,
                f64::NAN
            )]
        )
        .unwrap_err()
        .reason,
        "invalid_event_time"
    );
}
