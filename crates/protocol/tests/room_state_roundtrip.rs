use protocol::{PlaybackStatus, RoomState};
use uuid::Uuid;

#[test]
fn room_state_json_preserves_authoritative_float_values() {
    for position in [32546.403021000006_f64, 51.248178375505404, 98713.698932] {
        let state = RoomState {
            room_id: Uuid::nil(),
            revision: 3,
            media_id: Some(Uuid::nil()),
            media_generation: 1,
            playback_status: PlaybackStatus::Paused,
            anchor_position_ms: position,
            anchor_server_time_ms: position,
            playback_rate: 1.0,
            controller_user_id: Uuid::nil(),
            duration_ms: Some(86400000.0),
            clock_epoch: Uuid::nil(),
        };
        let json = serde_json::to_vec(&state).unwrap();
        let wire: RoomState = serde_json::from_slice(&json).unwrap();
        assert_eq!(wire, state, "typed JSON roundtrip must preserve room state");

        // SQLx decodes PostgreSQL JSON into Value before snapshot() reads it.
        let stored: serde_json::Value = serde_json::from_slice(&json).unwrap();
        let snapshot: RoomState = serde_json::from_value(stored).unwrap();
        assert_eq!(
            snapshot, state,
            "persisted JSON roundtrip must preserve room state"
        );
        assert_eq!(snapshot.anchor_position_ms.to_bits(), position.to_bits());
        assert_eq!(snapshot.anchor_server_time_ms.to_bits(), position.to_bits());
    }
}
