//! Only consenting members of the same immutable output may exchange WebRTC signals.
use super::*;
use axum::extract::Query;
pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/v1/rooms/{room}/compute/{job}/p2p", post(join))
        .route("/api/v1/room-p2p/{peer}", get(poll).delete(leave))
        .route("/api/v1/room-p2p/{peer}/signal", post(signal))
}
fn enabled() -> Result<()> {
    if std::env::var("RAINSYNC_P2P_ENABLED").as_deref() != Ok("1") {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, "p2p_disabled"));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Consent {
    acknowledge_peer_addresses: bool,
    confirm_current_network: bool,
    upload_allowed: bool,
}
pub async fn join(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, job)): Path<(Uuid, Uuid)>,
    Json(b): Json<Consent>,
) -> Result<Json<Value>> {
    join_scope(app, h, room, job, b, None).await
}
pub(super) async fn join_primary(
    app: App,
    h: HeaderMap,
    session: Uuid,
    b: Consent,
) -> Result<Json<Value>> {
    let (_, scope) = crate::distributed_playback::viewer(&app, &h, session).await?;
    join_scope(
        app,
        h,
        scope.get("room_id"),
        scope.get("job_id"),
        b,
        Some(session),
    )
    .await
}
async fn join_scope(
    app: App,
    h: HeaderMap,
    room: Uuid,
    job: Uuid,
    b: Consent,
    session: Option<Uuid>,
) -> Result<Json<Value>> {
    enabled()?;
    let user = auth(&app, &h, true).await?;
    if !b.acknowledge_peer_addresses || !b.confirm_current_network || !b.upload_allowed {
        return Err(err(StatusCode::BAD_REQUEST, "p2p_consent_required"));
    }
    let (_, generation) = crate::distributed_compute::viewer(&app, &h, room, job).await?;
    let login = crate::media_authorization::login_hash(&h)?;
    let id = Uuid::new_v4();
    let mut tx = app.db.begin().await?;
    persistence::room_lifecycle::lock_active(&mut tx, room)
        .await
        .map_err(crate::room_lifecycle::gate_error)?;
    sqlx::query("SELECT m.user_id FROM room_members m JOIN sessions login ON login.user_id=m.user_id AND login.token_hash=$3 JOIN room_snapshots snap ON snap.room_id=m.room_id WHERE m.room_id=$1 AND m.user_id=$2 FOR SHARE OF m,login,snap").bind(room).bind(user.id).bind(&login).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::GONE,"p2p_scope_changed"))?;
    sqlx::query("DELETE FROM room_p2p_signals WHERE expires_at<=clock_timestamp()")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM room_p2p_peers WHERE expires_at<=clock_timestamp() OR NOT room_p2p_peer_authorized(id)").execute(&mut *tx).await?;
    // One browser contribution per authenticated login/output; joining replaces its old connections.
    sqlx::query("DELETE FROM room_p2p_peers WHERE user_id=$1 AND login_hash=$2 AND job_id=$3")
        .bind(user.id)
        .bind(&login)
        .bind(job)
        .execute(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM room_p2p_peers WHERE room_id=$1 AND expires_at>clock_timestamp()",
    )
    .bind(room)
    .fetch_one(&mut *tx)
    .await?;
    if count >= 32 {
        return Err(err(
            StatusCode::TOO_MANY_REQUESTS,
            "p2p_room_peer_budget_exceeded",
        ));
    }
    let n=sqlx::query("INSERT INTO room_p2p_peers(id,room_id,user_id,job_id,output_generation,login_hash,membership_epoch,playback_session_id) SELECT $1,$2,$3,$4,$5,$6,m.membership_epoch,$7 FROM room_members m JOIN distributed_compute_jobs j ON j.id=$4 AND j.room_id=m.room_id AND j.status='ready' AND j.output_generation=$5 WHERE m.room_id=$2 AND m.user_id=$3 AND distributed_compute_authorized(j.id) AND playback_origin_allowed($3,$2,$6,m.membership_epoch) AND library_media_allowed($3,j.media_id,'play',$2) AND room_media_allowed($2,j.media_id) AND ($7::uuid IS NULL OR distributed_playback_session_authorized($7))").bind(id).bind(room).bind(user.id).bind(job).bind(generation).bind(login).bind(session).execute(&mut *tx).await?.rows_affected();
    if n != 1 {
        return Err(err(StatusCode::CONFLICT, "p2p_scope_changed"));
    }
    let peers:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM room_p2p_peers WHERE room_id=$1 AND job_id=$2 AND output_generation=$3 AND id<>$4 AND room_p2p_peer_authorized(id) AND (playback_session_id IS NULL)=($5::uuid IS NULL) ORDER BY id LIMIT 3").bind(room).bind(job).bind(generation).bind(id).bind(session).fetch_all(&mut *tx).await?;
    let authorization = peer_authorization(&mut tx, id, &peers).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"peer_id":id,"peers":peers,"authorization":authorization,"output_generation":generation,"ttl_ms":30000,"max_peers":3,"upload_bytes_per_second":250000,"chunk_bytes":16384}),
    ))
}
// An uploader may serve only peers in this short-lived, server-checked snapshot.
// Do not expose principals, login hashes, or another viewer's playback session.
// The request-start clock on the browser also bounds DB/network response delays.
const PEER_AUTHORIZATION_MS: i64 = 3000;
async fn peer_authorization(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    peer: Uuid,
    candidates: &[Uuid],
) -> Result<Value> {
    let scope = sqlx::query("SELECT p.room_id,p.job_id,p.output_generation,p.playback_session_id,LEAST($2,FLOOR(EXTRACT(EPOCH FROM (LEAST(p.expires_at,login.expires_at,j.expires_at,playback.expires_at)-clock_timestamp()))*1000)::bigint) AS lease_ms FROM room_p2p_peers p JOIN sessions login ON login.token_hash=p.login_hash AND login.user_id=p.user_id JOIN distributed_compute_jobs j ON j.id=p.job_id LEFT JOIN playback_sessions playback ON playback.id=p.playback_session_id WHERE p.id=$1 AND room_p2p_peer_authorized(p.id)")
        .bind(peer).bind(PEER_AUTHORIZATION_MS).fetch_optional(&mut **tx).await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "p2p_peer_expired"))?;
    let lease_ms: i64 = scope.get("lease_ms");
    if lease_ms <= 0 {
        return Err(err(StatusCode::NOT_FOUND, "p2p_peer_expired"));
    }
    // Only revalidate the caller's current connections and senders whose signals
    // it is receiving. This is not a new room-wide discovery/list-members API.
    let peers = sqlx::query("SELECT p.id,LEAST($3,FLOOR(EXTRACT(EPOCH FROM (LEAST(p.expires_at,login.expires_at,j.expires_at,playback.expires_at)-clock_timestamp()))*1000)::bigint) AS lease_ms FROM room_p2p_peers a JOIN room_p2p_peers p ON p.room_id=a.room_id AND p.job_id=a.job_id AND p.output_generation=a.output_generation AND (p.playback_session_id IS NULL)=(a.playback_session_id IS NULL) JOIN sessions login ON login.token_hash=p.login_hash AND login.user_id=p.user_id JOIN distributed_compute_jobs j ON j.id=p.job_id LEFT JOIN playback_sessions playback ON playback.id=p.playback_session_id WHERE a.id=$1 AND p.id=ANY($2) AND p.id<>a.id AND room_p2p_peer_authorized(a.id) AND room_p2p_peer_authorized(p.id) ORDER BY p.id LIMIT 31")
        .bind(peer).bind(candidates).bind(lease_ms).fetch_all(&mut **tx).await?;
    Ok(
        json!({"version":1,"peer_id":peer,"room_id":scope.get::<Uuid,_>("room_id"),"job_id":scope.get::<Uuid,_>("job_id"),"output_generation":scope.get::<Uuid,_>("output_generation"),"session_id":scope.get::<Option<Uuid>,_>("playback_session_id"),"lease_ms":lease_ms,"peers":peers.iter().filter(|p|p.get::<i64,_>("lease_ms")>0).map(|p|json!({"peer_id":p.get::<Uuid,_>("id"),"lease_ms":p.get::<i64,_>("lease_ms")})).collect::<Vec<_>>()}),
    )
}
async fn owner(app: &App, h: &HeaderMap, peer: Uuid, write: bool) -> Result<User> {
    enabled()?;
    let user = auth(app, h, write).await?;
    let login = crate::media_authorization::login_hash(h)?;
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM room_p2p_peers WHERE id=$1 AND user_id=$2 AND login_hash=$3 AND room_p2p_peer_authorized(id))").bind(peer).bind(user.id).bind(login).fetch_one(&app.db).await?;
    if !valid {
        return Err(err(StatusCode::NOT_FOUND, "p2p_peer_expired"));
    }
    Ok(user)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Signal {
    recipient: Uuid,
    kind: String,
    payload: Value,
}
pub async fn signal(
    State(app): State<App>,
    h: HeaderMap,
    Path(peer): Path<Uuid>,
    Json(b): Json<Signal>,
) -> Result<Json<Value>> {
    owner(&app, &h, peer, true).await?;
    if !matches!(b.kind.as_str(), "offer" | "answer" | "ice")
        || !b.payload.is_object()
        || b.payload.to_string().len() > 16384
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_p2p_signal"));
    }
    let mut tx = app.db.begin().await?;
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
#[derive(Deserialize)]
pub struct Cursor {
    #[serde(default)]
    after: i64,
    peers: Option<String>,
}
impl Cursor {
    fn connected_peers(&self) -> Result<Vec<Uuid>> {
        let Some(peers) = self.peers.as_deref().filter(|s| !s.is_empty()) else {
            return Ok(Vec::new());
        };
        if peers.len() > 3 * 36 + 2 {
            return Err(err(StatusCode::BAD_REQUEST, "invalid_p2p_signal"));
        }
        let ids = peers
            .split(',')
            .map(Uuid::parse_str)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_p2p_signal"))?;
        if ids.len() > 3 {
            return Err(err(StatusCode::BAD_REQUEST, "invalid_p2p_signal"));
        }
        Ok(ids)
    }
}
pub async fn poll(
    State(app): State<App>,
    h: HeaderMap,
    Path(peer): Path<Uuid>,
    Query(cursor): Query<Cursor>,
) -> Result<Json<Value>> {
    owner(&app, &h, peer, false).await?;
    let mut candidates = cursor.connected_peers()?;
    let mut tx = app.db.begin().await?;
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
pub async fn leave(
    State(app): State<App>,
    h: HeaderMap,
    Path(peer): Path<Uuid>,
) -> Result<Json<Value>> {
    let user = auth(&app, &h, true).await?;
    let login = crate::media_authorization::login_hash(&h)?;
    sqlx::query("DELETE FROM room_p2p_peers WHERE id=$1 AND user_id=$2 AND login_hash=$3")
        .bind(peer)
        .bind(user.id)
        .bind(login)
        .execute(&app.db)
        .await?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connected_peer_revalidation_is_bounded_and_uuid_only() {
        for peers in [None, Some(String::new())] {
            assert!(
                Cursor { after: 0, peers }
                    .connected_peers()
                    .unwrap()
                    .is_empty()
            );
        }
        let ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        let cursor = Cursor {
            after: 7,
            peers: Some(
                ids.iter()
                    .map(Uuid::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
            ),
        };
        assert_eq!(cursor.connected_peers().unwrap(), ids);
        for peers in [
            "not-a-peer".to_owned(),
            format!("{},", ids[0]),
            format!("{},{},{},{}", ids[0], ids[1], ids[2], Uuid::new_v4()),
        ] {
            assert!(
                Cursor {
                    after: 0,
                    peers: Some(peers)
                }
                .connected_peers()
                .is_err()
            );
        }
    }
}
