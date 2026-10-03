use protocol::{Action, Command, PlaybackStatus, RoomState};
use room_core::diagnostics::{
    Envelope, Event, FORMAT_VERSION, LEGACY_FORMAT_VERSION, LEGACY_REDUCER_VERSION, Lifecycle,
    LifecycleState, LifecycleTransition, Operation, REDUCER_VERSION, ResolvedMedia, SafeCommand,
    Window, decode_envelope, decode_window, verify,
};
use uuid::Uuid;

fn state() -> RoomState {
    RoomState {
        room_id: Uuid::from_u128(1),
        revision: 4,
        media_id: Some(Uuid::from_u128(2)),
        media_generation: 3,
        playback_status: PlaybackStatus::Playing,
        anchor_position_ms: 500.0,
        anchor_server_time_ms: 100.0,
        playback_rate: 1.5,
        controller_user_id: Uuid::from_u128(3),
        duration_ms: Some(10_000.0),
        clock_epoch: Uuid::from_u128(4),
    }
}
fn life(state: LifecycleState, epoch: i64) -> Lifecycle {
    Lifecycle { state, epoch }
}
fn command(before: &RoomState, action: Action) -> SafeCommand {
    SafeCommand::from_command(&Command {
        protocol_version: protocol::VERSION,
        room_id: before.room_id,
        command_id: Uuid::from_u128(10 + u128::from(before.revision)),
        control_epoch: None,
        expected_revision: before.revision,
        media_generation: before.media_generation,
        action,
    })
}
fn event(
    before: &RoomState,
    after: RoomState,
    actor: Option<Uuid>,
    from: Lifecycle,
    to: Lifecycle,
    operation: Operation,
) -> Event {
    Event {
        revision: after.revision,
        recorded_at_ms: 1800000000000,
        after: Some(after),
        envelope: Some(Envelope {
            schema_version: FORMAT_VERSION,
            reducer_version: REDUCER_VERSION.into(),
            event_id: Uuid::from_u128(100 + u128::from(before.revision)),
            actor_id: actor,
            actor_is_admin: false,
            before: before.clone(),
            lifecycle_before: from,
            lifecycle_after: to,
            operation,
        }),
        unavailable: None,
    }
}
fn window(events: Vec<Event>) -> Window {
    let first = events.first().unwrap();
    let last = events.last().unwrap();
    Window {
        format_version: FORMAT_VERSION,
        reducer_version: REDUCER_VERSION.into(),
        room_id: state().room_id,
        captured_at_ms: 1800000000001,
        after_revision: first.revision - 1,
        retained_from_revision: Some(first.revision),
        snapshot: last.after.clone().unwrap(),
        lifecycle: last.envelope.as_ref().unwrap().lifecycle_after,
        events,
        truncated: false,
    }
}
fn media_event(end: bool) -> Event {
    let mut before = state();
    if end {
        before.anchor_position_ms = 10_000.0;
    }
    let selected = Uuid::from_u128(5);
    let action = if end {
        Action::EndMedia {
            position_ms: 10_000.0,
        }
    } else {
        Action::ChangeMedia { media_id: selected }
    };
    let mut after = before.clone();
    after.revision += 1;
    after.media_generation += 1;
    after.media_id = Some(selected);
    after.duration_ms = Some(20_000.0);
    after.anchor_position_ms = 0.0;
    after.anchor_server_time_ms = 300.0;
    let active = life(LifecycleState::Active, 0);
    event(
        &before,
        after,
        Some(before.controller_user_id),
        active,
        active,
        Operation::MediaControl {
            command: command(&before, action),
            server_time_ms: 300.0,
            resolved_media: ResolvedMedia {
                media_id: selected,
                duration_ms: Some(20_000.0),
            },
        },
    )
}

#[test]
fn resolved_media_inputs_replay_change_and_advancement_without_database_or_effects() {
    for end in [false, true] {
        let bundle = window(vec![media_event(end)]);
        let bytes = serde_json::to_vec(&bundle).unwrap();
        let decoded = decode_window(&bytes).unwrap();
        let report = verify(&decoded);
        assert_eq!(
            (
                report.verified_steps,
                report.checkpoint_steps,
                report.unverifiable_steps
            ),
            (1, 0, 0)
        );
        assert!(report.all_transitions_verified);
        assert!(report.final_state_digest.is_some());
    }
}

#[test]
fn every_unrelated_after_state_change_fails_exact_reconstruction() {
    for end in [false, true] {
        for mutation in 0..9 {
            let mut e = media_event(end);
            let after = e.after.as_mut().unwrap();
            match mutation {
                0 => after.anchor_position_ms += 1.0,
                1 => after.anchor_server_time_ms += 1.0,
                2 => after.playback_rate = 2.0,
                3 => after.media_generation += 1,
                4 => after.controller_user_id = Uuid::from_u128(88),
                5 => after.duration_ms = None,
                6 => after.media_id = Some(Uuid::from_u128(88)),
                7 => after.clock_epoch = Uuid::from_u128(88),
                _ => after.playback_status = PlaybackStatus::Paused,
            }
            let report = verify(&window(vec![e]));
            assert!(!report.all_transitions_verified, "mutation {mutation}");
            assert_eq!(report.unverifiable_steps, 1);
        }
    }
}

#[test]
fn lifecycle_and_restart_chain_is_fully_reconstructed_from_minimal_inputs() {
    let start = state();
    let mut closing = start.clone();
    closing.revision += 1;
    closing.anchor_position_ms = 800.0;
    closing.anchor_server_time_ms = 300.0;
    closing.playback_status = PlaybackStatus::Paused;
    let active0 = life(LifecycleState::Active, 0);
    let closing1 = life(LifecycleState::Closing, 1);
    let mut events = vec![event(
        &start,
        closing.clone(),
        Some(start.controller_user_id),
        active0,
        closing1,
        Operation::Lifecycle {
            transition: LifecycleTransition::Closing,
            expected_revision: start.revision,
            server_time_ms: Some(300.0),
        },
    )];
    let mut closed = closing.clone();
    closed.revision += 1;
    let closed1 = life(LifecycleState::Closed, 1);
    events.push(event(
        &closing,
        closed.clone(),
        None,
        closing1,
        closed1,
        Operation::Lifecycle {
            transition: LifecycleTransition::Closed,
            expected_revision: closing.revision,
            server_time_ms: None,
        },
    ));
    let mut reopened = closed.clone();
    reopened.revision += 1;
    reopened.anchor_server_time_ms = 400.0;
    let active2 = life(LifecycleState::Active, 2);
    events.push(event(
        &closed,
        reopened.clone(),
        Some(start.controller_user_id),
        closed1,
        active2,
        Operation::Lifecycle {
            transition: LifecycleTransition::Reopened,
            expected_revision: closed.revision,
            server_time_ms: Some(400.0),
        },
    ));
    let mut restarted = reopened.clone();
    restarted.revision += 1;
    restarted.anchor_server_time_ms = 0.0;
    restarted.clock_epoch = Uuid::from_u128(9);
    events.push(event(
        &reopened,
        restarted,
        None,
        active2,
        active2,
        Operation::ServerRestart {
            clock_epoch: Uuid::from_u128(9),
        },
    ));
    let report = verify(&window(events.clone()));
    assert!(report.all_transitions_verified, "{report:?}");
    assert_eq!(report.verified_steps, 4);
    for index in 0..events.len() {
        let mut altered = events.clone();
        altered[index].after.as_mut().unwrap().anchor_position_ms += 1.0;
        assert!(!verify(&window(altered)).all_transitions_verified);
    }
    let mut archived = closed.clone();
    archived.revision += 1;
    archived.anchor_server_time_ms = 600.0;
    assert!(
        verify(&window(vec![event(
            &closed,
            archived,
            Some(start.controller_user_id),
            closed1,
            life(LifecycleState::Archived, 1),
            Operation::Lifecycle {
                transition: LifecycleTransition::Archived,
                expected_revision: closed.revision,
                server_time_ms: Some(600.0)
            }
        )]))
        .all_transitions_verified
    );
}

#[test]
fn new_operations_cannot_be_smuggled_under_legacy_or_future_versions() {
    let mut e = media_event(false);
    e.envelope.as_mut().unwrap().schema_version = LEGACY_FORMAT_VERSION;
    e.envelope.as_mut().unwrap().reducer_version = LEGACY_REDUCER_VERSION.into();
    assert!(decode_envelope(&serde_json::to_vec(e.envelope.as_ref().unwrap()).unwrap()).is_err());
    assert!(!verify(&window(vec![e])).all_transitions_verified);
    let mut bundle = window(vec![media_event(false)]);
    bundle.format_version = LEGACY_FORMAT_VERSION;
    bundle.reducer_version = LEGACY_REDUCER_VERSION.into();
    assert!(!verify(&bundle).all_transitions_verified);
    bundle.format_version = 3;
    bundle.reducer_version = "room-diagnostics/3".into();
    assert!(decode_window(&serde_json::to_vec(&bundle).unwrap()).is_err());
}

#[test]
fn media_inputs_are_not_inferred_from_matching_after_state_or_accepted_under_wrong_command() {
    for mutation in 0..5 {
        let mut e = media_event(false);
        let envelope = e.envelope.as_mut().unwrap();
        if let Operation::MediaControl {
            command,
            server_time_ms,
            resolved_media,
        } = &mut envelope.operation
        {
            match mutation {
                0 => resolved_media.media_id = Uuid::from_u128(99),
                1 => resolved_media.duration_ms = Some(-1.0),
                2 => *server_time_ms = 99.0,
                3 => command.action = room_core::diagnostics::SafeAction::Play,
                _ => envelope.actor_id = Some(Uuid::from_u128(99)),
            }
        }
        assert!(!verify(&window(vec![e])).all_transitions_verified);
    }
}

#[test]
fn old_checkpoints_keep_their_limited_meaning_in_legacy_and_mixed_windows() {
    let mut old = media_event(false);
    let envelope = old.envelope.as_mut().unwrap();
    let Operation::MediaControl { command, .. } = envelope.operation.clone() else {
        unreachable!()
    };
    envelope.schema_version = LEGACY_FORMAT_VERSION;
    envelope.reducer_version = LEGACY_REDUCER_VERSION.into();
    envelope.operation = Operation::Checkpoint {
        reason: room_core::diagnostics::CheckpointReason::MediaChanged,
        command: Some(command),
    };
    for legacy_window in [false, true] {
        let mut bundle = window(vec![old.clone()]);
        if legacy_window {
            bundle.format_version = LEGACY_FORMAT_VERSION;
            bundle.reducer_version = LEGACY_REDUCER_VERSION.into();
        }
        let report = verify(&decode_window(&serde_json::to_vec(&bundle).unwrap()).unwrap());
        assert!(report.continuous && report.reaches_snapshot);
        assert_eq!(report.checkpoint_steps, 1);
        assert!(!report.all_transitions_verified);
    }
}

#[test]
fn absent_resolution_facts_and_unknown_fields_are_not_silently_defaulted() {
    let e = media_event(false);
    let original = serde_json::to_value(e.envelope.as_ref().unwrap()).unwrap();
    for field in ["media_id", "duration_ms"] {
        let mut value = original.clone();
        value["operation"]["resolved_media"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(decode_envelope(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    let mut value = original;
    value["operation"]["resolved_media"]["url"] = serde_json::json!("https://secret.invalid");
    assert!(decode_envelope(&serde_json::to_vec(&value).unwrap()).is_err());
}

#[test]
fn frozen_v1_control_semantics_remain_readable_without_regenerating_expected_states() {
    // Literal golden inputs and post-states, not fixtures built by the current
    // reducer. Future reducer changes must version semantics rather than edit
    // historical state to make a new implementation agree with itself.
    let bytes = include_bytes!("fixtures/diagnostics-v1-golden.json");
    let window = decode_window(bytes).unwrap();
    let report = verify(&window);
    assert!(report.all_transitions_verified, "{report:?}");
    assert_eq!(report.verified_steps, 7);
    assert_eq!(window.snapshot.anchor_position_ms, 2300.0);
    assert_eq!(window.snapshot.anchor_server_time_ms, 900.0);
    assert_eq!(window.snapshot.playback_rate, 1.5);
    assert_eq!(window.snapshot.controller_user_id, Uuid::from_u128(4));
}
