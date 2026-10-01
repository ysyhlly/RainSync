//! Additional restrictions negotiated only by new HTTP-file continuation users.
//! These rows confer no access by themselves; source and grant checks remain.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub version: u32,
    pub user_id: Uuid,
    pub room_id: Uuid,
    pub membership_epoch: Uuid,
    /// Hash of the existing authenticated login, never the original cookie.
    pub login_hash: String,
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

/// Caller holds the room/snapshot admission locks through commit. Lock member,
/// then login, before source or playback-session locks. Never hold over I/O.
pub async fn capture(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    room: Uuid,
    login_hash: &str,
) -> Result<Option<Context>> {
    if !valid_hash(login_hash) {
        return Ok(None);
    }
    let epoch: Option<Uuid> = sqlx::query_scalar(
        "SELECT membership_epoch FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(room)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(membership_epoch) = epoch else {
        return Ok(None);
    };
    let login: Option<String> = sqlx::query_scalar(
        "SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(login_hash)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?;
    if login.is_none() {
        return Ok(None);
    }
    let context = Context {
        version: 1,
        user_id: user,
        room_id: room,
        membership_epoch,
        login_hash: login_hash.into(),
    };
    // A transaction can wait on both rows. Evaluate wall-clock expiry only
    // after acquiring them, using the same gate as active Worker streams.
    let current: bool = sqlx::query_scalar("SELECT playback_http_file_context_allowed($1)")
        .bind(serde_json::to_value(&context)?)
        .fetch_one(&mut **tx)
        .await?;
    Ok(current.then_some(context))
}

pub async fn lock(tx: &mut Transaction<'_, Postgres>, context: &Context) -> Result<bool> {
    if context.version != 1 {
        return Ok(false);
    }
    Ok(
        capture(tx, context.user_id, context.room_id, &context.login_hash)
            .await?
            .as_ref()
            == Some(context),
    )
}

/// Missing is a legacy grant. Explicit null, malformed or unknown version is
/// denied and is never treated as absence of a negotiated restriction.
pub async fn lock_resource(tx: &mut Transaction<'_, Postgres>, resource: &Value) -> Result<bool> {
    let Some(value) = resource.get("http_file_context") else {
        return Ok(true);
    };
    let Ok(context) = serde_json::from_value::<Context>(value.clone()) else {
        return Ok(false);
    };
    lock(tx, &context).await
}

/// A valid restriction belonging to a different principal is still invalid
/// for this grant. Nullable legacy grant associations never match a context.
pub fn resource_scope_matches(resource: &Value, user: Option<Uuid>, room: Option<Uuid>) -> bool {
    let Some(value) = resource.get("http_file_context") else {
        return true;
    };
    serde_json::from_value::<Context>(value.clone())
        .is_ok_and(|c| Some(c.user_id) == user && Some(c.room_id) == room)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn context_hash_is_canonical_and_shape_is_closed() {
        assert!(valid_hash(&"a0".repeat(32)));
        for value in [
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            "g".repeat(64),
        ] {
            assert!(!valid_hash(&value));
        }
        let context = Context {
            version: 1,
            user_id: Uuid::nil(),
            room_id: Uuid::nil(),
            membership_epoch: Uuid::nil(),
            login_hash: "ab".repeat(32),
        };
        let mut value = serde_json::to_value(context).unwrap();
        value["source_url"] = serde_json::json!("untrusted");
        assert!(serde_json::from_value::<Context>(value).is_err());
    }

    #[test]
    fn valid_context_of_another_grant_is_not_authority() {
        let user = Uuid::from_u128(1);
        let room = Uuid::from_u128(2);
        let resource = serde_json::json!({"http_file_context": Context {
            version: 1, user_id: user, room_id: room,
            membership_epoch: Uuid::nil(), login_hash: "ab".repeat(32),
        }});
        assert!(resource_scope_matches(&resource, Some(user), Some(room)));
        assert!(!resource_scope_matches(&resource, Some(room), Some(room)));
        assert!(!resource_scope_matches(&resource, Some(user), Some(user)));
        assert!(!resource_scope_matches(&resource, None, Some(room)));
        assert!(!resource_scope_matches(
            &serde_json::json!({"http_file_context":null}),
            Some(user),
            Some(room)
        ));
        assert!(resource_scope_matches(&serde_json::json!({}), None, None));
    }
}
