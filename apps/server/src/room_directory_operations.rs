//! Complete room directory reads and idempotent creation transaction.
use crate::identity::{RequestContext, request};
use crate::{Result, err, hash};
use axum::http::{HeaderMap, StatusCode};
use protocol::{PlaybackStatus, RoomState};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::time::Instant;
use uuid::Uuid;

pub(crate) async fn list(context: RequestContext<'_>, h: &HeaderMap) -> Result<Value> {
    let db = context.db;
    let u = request::authenticate(context, h, false, true).await?;
    let rows=sqlx::query("SELECT r.id,r.name,r.owner_id,r.lifecycle,r.lifecycle_epoch FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.user_id=$1 ORDER BY r.created_at DESC").bind(u.id).fetch_all(db).await?;
    Ok(Value::Array(rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"owner_id":r.get::<Uuid,_>("owner_id"),"lifecycle":r.get::<String,_>("lifecycle"),"lifecycle_epoch":r.get::<i64,_>("lifecycle_epoch")})).collect()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Name {
    pub name: String,
}

async fn creation_session_valid(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    session_hash: &str,
) -> Result<()> {
    // now() is fixed at transaction start and would accept a session that
    // expires while a concurrent creation holds the request-key lock.
    let valid: bool = sqlx::query_scalar("SELECT playback_login_allowed($2,$1)")
        .bind(session_hash)
        .bind(user)
        .fetch_one(&mut **tx)
        .await?;
    if !valid {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    Ok(())
}

pub(crate) async fn create(
    context: RequestContext<'_>,
    h: &HeaderMap,
    body: Name,
    start: Instant,
    clock_epoch: Uuid,
) -> Result<Value> {
    let db = context.db;
    let u = request::authenticate(context, h, true, false).await?;
    if body.name.trim().is_empty() || body.name.chars().count() > 120 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_name"));
    }
    let mut keys = h.get_all("idempotency-key").iter();
    let request_key = keys
        .next()
        .map(|value| {
            value
                .to_str()
                .ok()
                .filter(|key| {
                    !key.is_empty()
                        && key.len() <= 128
                        && key.bytes().all(|b| {
                            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-')
                        })
                })
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_idempotency_key"))
        })
        .transpose()?;
    if keys.next().is_some() {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_idempotency_key"));
    }
    let id = Uuid::new_v4();
    let mut tx = db.begin().await?;
    // Coordinate with account exit and hold the exact authenticated session
    // until commit; a prior auth check alone cannot authorize queued work.
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR SHARE")
        .bind(u.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "session_expired"))?;
    let session_hash =
        hash(&request::cookie(h).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))?);
    sqlx::query("SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND csrf=$3 AND expires_at>clock_timestamp() FOR SHARE")
        .bind(&session_hash)
        .bind(u.id)
        .bind(h.get("x-csrf-token").and_then(|v| v.to_str().ok()).unwrap_or_default())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "session_expired"))?;
    if let Some(key) = request_key {
        // PostgreSQL's unique-key conflict wait coordinates all Server nodes.
        // A losing INSERT sees the committed row in the following statement
        // (READ COMMITTED), rather than in the INSERT's earlier snapshot.
        let claimed = sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO room_creation_requests(user_id,request_key,name,room_id) VALUES($1,$2,$3,$4) ON CONFLICT (user_id,request_key) DO NOTHING RETURNING room_id",
        )
        .bind(u.id)
        .bind(key)
        .bind(&body.name)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        if claimed.is_none() {
            let result = sqlx::query(
                "SELECT name,room_id FROM room_creation_requests WHERE user_id=$1 AND request_key=$2",
            )
            .bind(u.id)
            .bind(key)
            .fetch_one(&mut *tx)
            .await?;
            if result.get::<String, _>("name") != body.name {
                return Err(err(StatusCode::CONFLICT, "idempotency_key_conflict"));
            }
            let original = result.get::<Uuid, _>("room_id");
            creation_session_valid(&mut tx, u.id, &session_hash).await?;
            tx.commit().await?;
            return Ok(json!({"id":original}));
        }
    }
    let state = RoomState {
        room_id: id,
        revision: 0,
        media_id: None,
        media_generation: 0,
        playback_status: PlaybackStatus::Paused,
        anchor_position_ms: 0.0,
        // Sample only after all principal, exact-login and request-key waits.
        // Passing the boot Instant keeps the original app.now() boundary.
        anchor_server_time_ms: start.elapsed().as_secs_f64() * 1000.0,
        playback_rate: 1.0,
        controller_user_id: u.id,
        duration_ms: None,
        live: None,
        clock_epoch,
    };
    sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,$2,$3)")
        .bind(id)
        .bind(body.name)
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2)")
        .bind(id)
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO room_snapshots VALUES($1,$2)")
        .bind(id)
        .bind(serde_json::to_value(state).unwrap())
        .execute(&mut *tx)
        .await?;
    creation_session_valid(&mut tx, u.id, &session_hash).await?;
    tx.commit().await?;
    Ok(json!({"id":id}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_name_preserves_raw_payload_and_denies_unknown_fields() {
        let name: crate::rooms::Name = serde_json::from_value(json!({"name":"  房间  "})).unwrap();
        let canonical: Name = name;
        assert_eq!(canonical.name, "  房间  ");
        assert!(
            serde_json::from_value::<Name>(json!({"name":"room","visibility":"public"})).is_err()
        );
        assert!(serde_json::from_value::<Name>(json!({"name":null})).is_err());
        assert!(serde_json::from_value::<Name>(json!({})).is_err());
    }
}
