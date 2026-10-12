//! Complete peer request operations; borrowed identity/database dependencies only.
use super::{Cursor, Signal, enabled, peer_authorization};
use crate::identity::RequestContext;
use crate::{Result, User, err, identity};
use axum::{
    Json,
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

async fn owner(
    context: &RequestContext<'_>,
    h: &HeaderMap,
    peer: Uuid,
    write: bool,
) -> Result<User> {
    enabled()?;
    let user = identity::request::authenticate(
        RequestContext {
            db: context.db,
            origin: context.origin,
        },
        h,
        write,
        false,
    )
    .await?;
    let login = crate::media_authorization::login_hash(h)?;
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM room_p2p_peers WHERE id=$1 AND user_id=$2 AND login_hash=$3 AND room_p2p_peer_authorized(id))").bind(peer).bind(user.id).bind(login).fetch_one(context.db).await?;
    if !valid {
        return Err(err(StatusCode::NOT_FOUND, "p2p_peer_expired"));
    }
    Ok(user)
}

pub(super) async fn signal(
    context: &RequestContext<'_>,
    h: HeaderMap,
    peer: Uuid,
    b: Signal,
) -> Result<Json<Value>> {
    owner(context, &h, peer, true).await?;
    if !matches!(b.kind.as_str(), "offer" | "answer" | "ice")
        || !b.payload.is_object()
        || b.payload.to_string().len() > 16384
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_p2p_signal"));
    }
    let mut tx = context.db.begin().await?;
    // Same room lock/order as join; serialize sender count and insertion.
    // This lookup is a hint. The original final INSERT rechecks authority.
    let room: Uuid = sqlx::query_scalar("SELECT room_id FROM room_p2p_peers WHERE id=$1")
        .bind(peer)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "p2p_peer_expired"))?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
        .bind(room)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "p2p_peer_expired"))?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM room_p2p_signals WHERE sender=$1 AND expires_at>clock_timestamp()",
    )
    .bind(peer)
    .fetch_one(&mut *tx)
    .await?;
    if count >= 64 {
        return Err(err(
            StatusCode::TOO_MANY_REQUESTS,
            "p2p_signal_budget_exceeded",
        ));
    }
    let n=sqlx::query("INSERT INTO room_p2p_signals(sender,recipient,kind,payload) SELECT a.id,b.id,$3,$4 FROM room_p2p_peers a JOIN room_p2p_peers b ON b.room_id=a.room_id AND b.job_id=a.job_id AND b.output_generation=a.output_generation AND (a.playback_session_id IS NULL)=(b.playback_session_id IS NULL) WHERE a.id=$1 AND b.id=$2 AND a.id<>b.id AND room_p2p_peer_authorized(a.id) AND room_p2p_peer_authorized(b.id)").bind(peer).bind(b.recipient).bind(b.kind).bind(b.payload).execute(&mut *tx).await?.rows_affected();
    if n != 1 {
        return Err(err(StatusCode::NOT_FOUND, "p2p_target_unavailable"));
    }
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

pub(super) async fn poll(
    context: &RequestContext<'_>,
    h: HeaderMap,
    peer: Uuid,
    cursor: Cursor,
) -> Result<Json<Value>> {
    let user = owner(context, &h, peer, false).await?;
    let login = crate::media_authorization::login_hash(&h)?;
    let mut candidates = cursor.connected_peers()?;
    let mut tx = context.db.begin().await?;
    // Acquire without authorization predicates: a row-lock wait may cross expiry.
    sqlx::query("SELECT id FROM room_p2p_peers WHERE id=$1 FOR UPDATE")
        .bind(peer)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "p2p_peer_expired"))?;
    // A separate statement observes the current clock and exact login after waiting.
    let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM room_p2p_peers WHERE id=$1 AND user_id=$2 AND login_hash=$3 AND expires_at>clock_timestamp() AND room_p2p_peer_authorized(id))")
        .bind(peer).bind(user.id).bind(&login).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(err(StatusCode::NOT_FOUND, "p2p_peer_expired"));
    }
    // Every renewal rechecks the old expiry first. Expired tickets cannot resurrect.
    let n=sqlx::query("UPDATE room_p2p_peers SET expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1 AND room_p2p_peer_authorized(id)").bind(peer).execute(&mut *tx).await?.rows_affected();
    if n != 1 {
        return Err(err(StatusCode::NOT_FOUND, "p2p_peer_expired"));
    }
    let rows=sqlx::query("SELECT sequence,sender,kind,payload FROM room_p2p_signals WHERE recipient=$1 AND sequence>$2 AND expires_at>clock_timestamp() AND room_p2p_peer_authorized(sender) ORDER BY sequence LIMIT 64").bind(peer).bind(cursor.after).fetch_all(&mut *tx).await?;
    let next = rows
        .last()
        .map(|r| r.get::<i64, _>("sequence"))
        .unwrap_or(cursor.after);
    sqlx::query("DELETE FROM room_p2p_signals WHERE recipient=$1 AND sequence<=$2")
        .bind(peer)
        .bind(next)
        .execute(&mut *tx)
        .await?;
    candidates.extend(rows.iter().map(|r| r.get::<Uuid, _>("sender")));
    let authorization = peer_authorization(&mut tx, peer, &candidates).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"cursor":next,"ttl_ms":30000,"authorization":authorization,"signals":rows.iter().map(|r|json!({"sender":r.get::<Uuid,_>("sender"),"kind":r.get::<String,_>("kind"),"payload":r.get::<Value,_>("payload")})).collect::<Vec<_>>()}),
    ))
}
