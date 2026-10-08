//! Replaceable online-presence evidence, independent of room control revision.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PresenceMember {
    pub user_id: Uuid,
    #[schemars(range(min = 1))]
    pub connection_count: u32,
}

/// A full replacement, not a delta. Sequence gaps are valid. Compare sequences
/// only within this presence epoch and room; never use room control revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PresenceSnapshot {
    pub room_id: Uuid,
    pub presence_epoch: Uuid,
    pub presence_seq: u32,
    pub members: Vec<PresenceMember>,
}

pub const PRESENCE_VERSION: u8 = 1;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_round_trip_has_no_control_revision_or_client_status() {
        let snapshot = PresenceSnapshot {
            room_id: Uuid::new_v4(),
            presence_epoch: Uuid::new_v4(),
            presence_seq: 9,
            members: vec![PresenceMember {
                user_id: Uuid::new_v4(),
                connection_count: 2,
            }],
        };
        let value = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 4);
        assert!(value.get("revision").is_none());
        assert!(value.get("clock_epoch").is_none());
        assert_eq!(
            serde_json::from_value::<PresenceSnapshot>(value).unwrap(),
            snapshot
        );
    }
    #[test]
    fn snapshot_rejects_extra_authority_and_out_of_range_sequences() {
        let value = serde_json::json!({"room_id":Uuid::new_v4(),"presence_epoch":Uuid::new_v4(),"presence_seq":u64::from(u32::MAX)+1,"members":[]});
        assert!(serde_json::from_value::<PresenceSnapshot>(value).is_err());
        let value = serde_json::json!({"room_id":Uuid::new_v4(),"presence_epoch":Uuid::new_v4(),"presence_seq":1,"members":[],"revision":1});
        assert!(serde_json::from_value::<PresenceSnapshot>(value).is_err());
    }
}
