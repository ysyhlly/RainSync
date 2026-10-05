//! Same-origin timeline comments, ephemeral reactions and audited moderation.
//! Activities fence room lifecycle, shared generation and catalog source identity.
use crate::*;
use axum::extract::Query;
use sqlx::{Postgres, Transaction};

const EMOJI: [&str; 6] = ["👏", "😂", "❤️", "😮", "🎉", "😢"];
struct Gate {
    state: protocol::RoomState,
    epoch: i64,
    owner: Uuid,
    active: bool,
    admin: bool,
    moderator: bool,
    login: String,
    user: Uuid,
}
async fn gate<'a>(
    app: &'a App,
    h: &HeaderMap,
    room: Uuid,
    write: bool,
    manage: bool,
    active: bool,
) -> Result<(Transaction<'a, Postgres>, Gate)> {
    let user = auth(app, h, write).await?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    let room_query = if write {
        "SELECT owner_id,lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE"
    } else {
        "SELECT owner_id,lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR SHARE"
    };
    let row = sqlx::query(room_query)
        .bind(room)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    if active && row.get::<String, _>("lifecycle") != "active" {
        return Err(err(StatusCode::CONFLICT, "room_not_active"));
    }
    let state: Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR SHARE")
            .bind(room)
            .fetch_one(&mut *tx)
            .await?;
    let membership = sqlx::query("SELECT chat_moderator,chat_muted_until>clock_timestamp() AS muted FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE")
        .bind(room).bind(user.id).fetch_optional(&mut *tx).await?;
    let current_admin: bool = sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 FOR SHARE")
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await?;
    let login = hash(&cookie(h).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))?);
    let session = sqlx::query("SELECT csrf,expires_at>clock_timestamp() AS live FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR SHARE")
        .bind(&login).bind(user.id).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::UNAUTHORIZED,"session_expired"))?;
    if !session.get::<bool, _>("live") {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    if write
        && h.get("x-csrf-token").and_then(|v| v.to_str().ok())
            != Some(session.get::<String, _>("csrf").as_str())
    {
        return Err(err(StatusCode::FORBIDDEN, "csrf_rejected"));
    }
    if membership.is_none() && !(manage && current_admin) {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    if write
        && !manage
        && membership
            .as_ref()
            .and_then(|r| r.get::<Option<bool>, _>("muted"))
            == Some(true)
    {
        return Err(err(StatusCode::FORBIDDEN, "chat_muted"));
    }
    let moderator = membership
        .as_ref()
        .is_some_and(|r| r.get::<bool, _>("chat_moderator"));
    let gate = Gate {
        state: serde_json::from_value(state).map_err(anyhow::Error::from)?,
        epoch: row.get("lifecycle_epoch"),
        owner: row.get("owner_id"),
        active: row.get::<String, _>("lifecycle") == "active",
        admin: current_admin,
        moderator,
        login,
        user: user.id,
    };
    Ok((tx, gate))
}
async fn commit(mut tx: Transaction<'_, Postgres>, gate: &Gate) -> Result<()> {
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())")
        .bind(&gate.login).bind(gate.user).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    tx.commit().await?;
    Ok(())
}
fn can_manage(g: &Gate) -> bool {
    g.admin || g.owner == g.user || g.moderator
}
pub(crate) async fn check_mute(
    tx: &mut Transaction<'_, Postgres>,
    room: Uuid,
    user: Uuid,
) -> std::result::Result<(), &'static str> {
    let muted:bool=sqlx::query_scalar("SELECT COALESCE(chat_muted_until>clock_timestamp(),false) FROM room_members WHERE room_id=$1 AND user_id=$2")
        .bind(room).bind(user).fetch_one(&mut **tx).await.map_err(|_|"database_error")?;
    if muted { Err("chat_muted") } else { Ok(()) }
}
async fn activity(tx: &mut Transaction<'_, Postgres>, g: &Gate) -> Result<Option<Value>> {
    let Some(media) = g.state.media_id else {
        return Ok(None);
    };
    if g.state.live.is_some() {
        return Ok(None);
    }; // Live has no seekable shared timeline.
    if !g.active {
        // Closing/closed rooms retain the last actual viewing activity. Merely
        // reading history must not fabricate a new inactive lifecycle activity.
        let row=sqlx::query("SELECT id,lifecycle_epoch,source_identity,versioned FROM room_media_activities WHERE room_id=$1 AND media_id=$2 AND media_generation=$3 ORDER BY created_at DESC,id DESC LIMIT 1")
            .bind(g.state.room_id).bind(media).bind(i64::from(g.state.media_generation)).fetch_optional(&mut **tx).await?;
        return Ok(row.map(|r|json!({"id":r.get::<Uuid,_>("id"),"media_id":media,"media_generation":g.state.media_generation,"lifecycle_epoch":r.get::<i64,_>("lifecycle_epoch"),"source_identity":r.get::<String,_>("source_identity"),"versioned":r.get::<bool,_>("versioned"),"duration_ms":g.state.duration_ms})));
    }
    let row=sqlx::query("SELECT source_id,resource,source_version,metadata,preview_generation FROM media_items WHERE id=$1 AND available FOR SHARE")
        .bind(media).fetch_optional(&mut **tx).await?.ok_or_else(||err(StatusCode::CONFLICT,"timeline_media_unavailable"))?;
    let version: Option<String> = row.get("source_version");
    let identity = hash(
        &json!([
            row.get::<Uuid, _>("source_id"),
            row.get::<String, _>("resource"),
            version,
            row.get::<i64, _>("preview_generation"),
            if version.is_none() {
                row.get::<Value, _>("metadata")
            } else {
                Value::Null
            }
        ])
        .to_string(),
    );
    let inserted:Option<Uuid>=sqlx::query_scalar("INSERT INTO room_media_activities(id,room_id,lifecycle_epoch,media_generation,media_id,source_identity,versioned) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(room_id,lifecycle_epoch,media_generation,media_id,source_identity) DO NOTHING RETURNING id")
        .bind(Uuid::new_v4()).bind(g.state.room_id).bind(g.epoch).bind(i64::from(g.state.media_generation)).bind(media).bind(&identity).bind(version.is_some()).fetch_optional(&mut **tx).await?;
    let id = if let Some(id) = inserted {
        id
    } else {
        sqlx::query_scalar::<_,Uuid>("SELECT id FROM room_media_activities WHERE room_id=$1 AND lifecycle_epoch=$2 AND media_generation=$3 AND media_id=$4 AND source_identity=$5")
        .bind(g.state.room_id).bind(g.epoch).bind(i64::from(g.state.media_generation)).bind(media).bind(&identity).fetch_one(&mut **tx).await?
    };
    Ok(Some(
        json!({"id":id,"media_id":media,"media_generation":g.state.media_generation,"lifecycle_epoch":g.epoch,"source_identity":identity,"versioned":version.is_some(),"duration_ms":g.state.duration_ms}),
    ))
}
fn position(g: &Gate, app: &App) -> Result<i64> {
    if g.state.playback_status == protocol::PlaybackStatus::Playing
        && g.state.clock_epoch != app.epoch
    {
        return Err(err(StatusCode::CONFLICT, "timeline_clock_stale"));
    }
    let at = room_core::position(&g.state, app.now());
    if !at.is_finite() {
        return Err(err(StatusCode::CONFLICT, "timeline_clock_stale"));
    }
    Ok(at.round().clamp(0.0, protocol::UNKNOWN_DURATION_LIMIT_MS) as i64)
}
pub async fn current(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
) -> Result<Response> {
    let (mut tx, g) = gate(&app, &h, room, false, false, false).await?;
    let current = activity(&mut tx, &g).await?;
    let at = position(&g, &app)?;
    commit(tx, &g).await?;
    Ok(media_titles::private_json(
        json!({"activity":current,"position_ms":at,"can_moderate":can_manage(&g),"can_assign_moderator":g.admin||g.owner==g.user,"emoji":EMOJI}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    activity_id: Uuid,
    before: Option<Uuid>,
    after: Option<Uuid>,
}
const MESSAGE_SELECT: &str = "SELECT c.id,c.user_id,CASE WHEN c.deleted_at IS NULL THEN c.body ELSE '' END AS body,c.media_activity_id,c.media_time_ms,c.anchor_source,c.deleted_at IS NOT NULL AS deleted,c.client_message_id,c.body_digest,u.username,COALESCE(p.display_name,u.username) AS display_name,floor(extract(epoch FROM c.created_at)*1000)::bigint AS created_at_ms FROM chat_messages c JOIN users u ON u.id=c.user_id LEFT JOIN user_profiles p ON p.user_id=u.id";
fn message(row: &sqlx::postgres::PgRow) -> Value {
    json!({"id":row.get::<Uuid,_>("id"),"user_id":row.get::<Uuid,_>("user_id"),"body":row.get::<String,_>("body"),"activity_id":row.get::<Uuid,_>("media_activity_id"),"media_time_ms":row.get::<i64,_>("media_time_ms"),"anchor_source":row.get::<String,_>("anchor_source"),"deleted":row.get::<bool,_>("deleted"),"username":row.get::<String,_>("username"),"display_name":row.get::<String,_>("display_name"),"created_at":row.get::<i64,_>("created_at_ms"),"client_message_id":row.get::<Option<Uuid>,_>("client_message_id")})
}
pub async fn messages(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    Query(page): Query<Page>,
) -> Result<Response> {
    if page.before.is_some() && page.after.is_some() {
        return Err(err(StatusCode::BAD_REQUEST, "timeline_cursor_invalid"));
    }
    let (mut tx, g) = gate(&app, &h, room, false, false, false).await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM room_media_activities WHERE id=$1 AND room_id=$2)",
    )
    .bind(page.activity_id)
    .bind(room)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(err(StatusCode::NOT_FOUND, "timeline_activity_not_found"));
    }
    let cursor = page.before.or(page.after);
    if let Some(id) = cursor {
        let found:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_messages WHERE id=$1 AND room_id=$2 AND media_activity_id=$3)").bind(id).bind(room).bind(page.activity_id).fetch_one(&mut *tx).await?;
        if !found {
            return Err(err(StatusCode::CONFLICT, "timeline_cursor_expired"));
        }
    }
    let comparison = if page.after.is_some() { ">" } else { "<" };
    let order = if page.after.is_some() { "ASC" } else { "DESC" };
    let query = format!(
        "{MESSAGE_SELECT} WHERE c.room_id=$1 AND c.media_activity_id=$2 AND ($3::uuid IS NULL OR (c.created_at,c.id) {comparison} (SELECT created_at,id FROM chat_messages WHERE id=$3 AND room_id=$1 AND media_activity_id=$2)) ORDER BY c.created_at {order},c.id {order} LIMIT 101"
    );
    let mut rows = sqlx::query(&query)
        .bind(room)
        .bind(page.activity_id)
        .bind(cursor)
        .fetch_all(&mut *tx)
        .await?;
    let more = rows.len() > 100;
    rows.truncate(100);
    if page.after.is_none() {
        rows.reverse();
    }
    let items: Vec<Value> = rows.iter().map(message).collect();
    commit(tx, &g).await?;
    Ok(media_titles::private_json(
        json!({"items":items,"next_before":if more&&page.after.is_none(){items.first().map(|v|v["id"].clone())}else{None},"next_after":if more&&page.after.is_some(){items.last().map(|v|v["id"].clone())}else{None}}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Comment {
    client_message_id: Uuid,
    body: String,
    activity_id: Uuid,
    anchor_source: String,
    media_time_ms: Option<i64>,
}
fn valid_text(s: &str, max: usize) -> bool {
    !s.trim().is_empty()
        && s.chars().count() <= max
        && !s.chars().any(|c| {
            c.is_control()
                || matches!(c,'\u{2028}'|'\u{2029}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
        })
}
fn validate_comment(c: &Comment) -> Result<()> {
    if !valid_text(&c.body, 2000)
        || !matches!(
            c.anchor_source.as_str(),
            "server_received" | "client_reported"
        )
        || (c.anchor_source == "server_received" && c.media_time_ms.is_some())
        || (c.anchor_source == "client_reported"
            && !c
                .media_time_ms
                .is_some_and(|n| (0..=604800000).contains(&n)))
    {
        return Err(err(StatusCode::BAD_REQUEST, "timeline_comment_invalid"));
    }
    Ok(())
}
pub async fn post(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    Json(c): Json<Comment>,
) -> Result<Response> {
    validate_comment(&c)?;
    let digest =
        hash(&json!([c.body, c.activity_id, c.anchor_source, c.media_time_ms]).to_string());
    let (mut tx, g) = gate(&app, &h, room, true, false, true).await?;
    // Replay is returned before checking a newer activity, but never after lost membership/login.
    let existing = sqlx::query(&format!(
        "{MESSAGE_SELECT} WHERE c.room_id=$1 AND c.user_id=$2 AND c.client_message_id=$3"
    ))
    .bind(room)
    .bind(g.user)
    .bind(c.client_message_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(row) = existing {
        if row.get::<Option<String>, _>("body_digest").as_deref() != Some(&digest) {
            return Err(err(StatusCode::CONFLICT, "timeline_message_conflict"));
        }
        let result = message(&row);
        commit(tx, &g).await?;
        return Ok(media_titles::private_json(
            json!({"message":result,"replayed":true}),
        ));
    }
    let now = activity(&mut tx, &g)
        .await?
        .ok_or_else(|| err(StatusCode::CONFLICT, "timeline_activity_unavailable"))?;
    if now["id"] != json!(c.activity_id) {
        return Err(err(StatusCode::CONFLICT, "timeline_activity_stale"));
    }
    let at = if c.anchor_source == "server_received" {
        position(&g, &app)?
    } else {
        c.media_time_ms.unwrap()
    };
    if g.state
        .duration_ms
        .is_some_and(|duration| !duration.is_finite() || at as f64 > duration)
    {
        return Err(err(StatusCode::BAD_REQUEST, "timeline_position_invalid"));
    }
    let recent:i64=sqlx::query_scalar("SELECT count(*) FROM chat_messages WHERE room_id=$1 AND user_id=$2 AND created_at>clock_timestamp()-interval '1 minute'").bind(room).bind(g.user).fetch_one(&mut *tx).await?;
    if recent >= 30 {
        return Err(Error(
            StatusCode::TOO_MANY_REQUESTS,
            "chat_rate_limited".into(),
            Some(2),
        ));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO chat_messages(id,room_id,user_id,body,client_message_id,media_activity_id,media_time_ms,anchor_source,body_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
        .bind(id).bind(room).bind(g.user).bind(&c.body).bind(c.client_message_id).bind(c.activity_id).bind(at).bind(&c.anchor_source).bind(digest).execute(&mut *tx).await?;
    let row = sqlx::query(&format!("{MESSAGE_SELECT} WHERE c.id=$1"))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let result = message(&row);
    commit(tx, &g).await?;
    let mut event = result.clone();
    event["type"] = json!("CHAT");
    rooms::broadcast_timeline(&app, room, event).await;
    Ok(media_titles::private_json(
        json!({"message":result,"replayed":false}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reaction {
    client_reaction_id: Uuid,
    activity_id: Uuid,
    emoji: String,
}
pub async fn react(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    Json(r): Json<Reaction>,
) -> Result<Response> {
    if !EMOJI.contains(&r.emoji.as_str()) {
        return Err(err(StatusCode::BAD_REQUEST, "reaction_invalid"));
    }
    let (mut tx, g) = gate(&app, &h, room, true, false, true).await?;
    let digest = hash(&json!([r.activity_id, r.emoji]).to_string());
    let old=sqlx::query("SELECT request_digest FROM room_reaction_receipts WHERE room_id=$1 AND user_id=$2 AND client_reaction_id=$3").bind(room).bind(g.user).bind(r.client_reaction_id).fetch_optional(&mut *tx).await?;
    if let Some(old) = old {
        if old.get::<String, _>("request_digest") != digest {
            return Err(err(StatusCode::CONFLICT, "reaction_conflict"));
        }
        commit(tx, &g).await?;
        return Ok(media_titles::private_json(json!({"replayed":true})));
    }
    let now = activity(&mut tx, &g)
        .await?
        .ok_or_else(|| err(StatusCode::CONFLICT, "timeline_activity_unavailable"))?;
    if now["id"] != json!(r.activity_id) {
        return Err(err(StatusCode::CONFLICT, "timeline_activity_stale"));
    }
    let updated=sqlx::query("UPDATE room_members SET reaction_tokens=LEAST(5,reaction_tokens+GREATEST(0,extract(epoch FROM clock_timestamp()-reaction_refilled_at))*2)-1,reaction_refilled_at=clock_timestamp() WHERE room_id=$1 AND user_id=$2 AND LEAST(5,reaction_tokens+GREATEST(0,extract(epoch FROM clock_timestamp()-reaction_refilled_at))*2)>=1")
        .bind(room).bind(g.user).execute(&mut *tx).await?.rows_affected();
    if updated != 1 {
        return Err(Error(
            StatusCode::TOO_MANY_REQUESTS,
            "reaction_rate_limited".into(),
            Some(1),
        ));
    }
    let id = Uuid::new_v4();
    let at = position(&g, &app)?;
    sqlx::query("INSERT INTO room_reaction_receipts(id,room_id,user_id,client_reaction_id,request_digest) VALUES($1,$2,$3,$4,$5)").bind(id).bind(room).bind(g.user).bind(r.client_reaction_id).bind(digest).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO room_reactions(id,room_id,user_id,activity_id,media_time_ms,emoji) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(room).bind(g.user).bind(r.activity_id).bind(at).bind(r.emoji).execute(&mut *tx).await?;
    commit(tx, &g).await?;
    Ok(media_titles::private_json(
        json!({"id":id,"replayed":false}),
    ))
}
pub async fn reactions(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    Query(page): Query<Page>,
) -> Result<Response> {
    if page.before.is_some() || page.after.is_some() {
        return Err(err(StatusCode::BAD_REQUEST, "timeline_cursor_invalid"));
    }
    let (mut tx, g) = gate(&app, &h, room, false, false, false).await?;
    let rows=sqlx::query("SELECT id,user_id,emoji,media_time_ms,floor(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM room_reactions WHERE room_id=$1 AND activity_id=$2 AND expires_at>clock_timestamp() ORDER BY expires_at,id LIMIT 200")
        .bind(room).bind(page.activity_id).fetch_all(&mut *tx).await?;
    let items:Vec<_>=rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"user_id":r.get::<Uuid,_>("user_id"),"emoji":r.get::<String,_>("emoji"),"media_time_ms":r.get::<i64,_>("media_time_ms"),"expires_at":r.get::<i64,_>("expires_ms")})).collect();
    let now: i64 =
        sqlx::query_scalar("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&mut *tx)
            .await?;
    commit(tx, &g).await?;
    Ok(media_titles::private_json(
        json!({"items":items,"server_now_ms":now}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Moderation {
    action: String,
    reason: String,
    target_user_id: Option<Uuid>,
    message_id: Option<Uuid>,
    minutes: Option<i64>,
    moderator: Option<bool>,
}
pub async fn moderate(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    Json(m): Json<Moderation>,
) -> Result<Response> {
    let shape = match m.action.as_str() {
        "delete" => {
            m.message_id.is_some()
                && m.target_user_id.is_none()
                && m.minutes.is_none()
                && m.moderator.is_none()
        }
        "mute" => {
            m.message_id.is_none()
                && m.target_user_id.is_some()
                && m.minutes.is_some()
                && m.moderator.is_none()
        }
        "unmute" | "remove" => {
            m.message_id.is_none()
                && m.target_user_id.is_some()
                && m.minutes.is_none()
                && m.moderator.is_none()
        }
        "moderator" => {
            m.message_id.is_none()
                && m.target_user_id.is_some()
                && m.minutes.is_none()
                && m.moderator.is_some()
        }
        _ => false,
    };
    if !shape || !valid_text(&m.reason, 200) {
        return Err(err(StatusCode::BAD_REQUEST, "chat_moderation_invalid"));
    }
    let (mut tx, g) = gate(&app, &h, room, true, true, false).await?;
    if !can_manage(&g) {
        return Err(err(StatusCode::FORBIDDEN, "chat_moderator_required"));
    }
    let mut deleted = None;
    if m.action == "delete" {
        let id = m
            .message_id
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, "chat_moderation_invalid"))?;
        let old = sqlx::query(
            "SELECT body,body_digest FROM chat_messages WHERE room_id=$1 AND id=$2 FOR UPDATE",
        )
        .bind(room)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "chat_message_not_found"))?;
        let digest = old
            .get::<Option<String>, _>("body_digest")
            .unwrap_or_else(|| hash(&old.get::<String, _>("body")));
        let changed=sqlx::query("UPDATE chat_messages SET deleted_at=COALESCE(deleted_at,clock_timestamp()),body='',body_digest=$3 WHERE room_id=$1 AND id=$2").bind(room).bind(id).bind(digest).execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            return Err(err(StatusCode::NOT_FOUND, "chat_message_not_found"));
        }
        deleted = Some(id);
    } else {
        let target = m
            .target_user_id
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, "chat_moderation_invalid"))?;
        if target == g.owner || target == g.state.controller_user_id || target == g.user {
            return Err(err(StatusCode::CONFLICT, "chat_target_protected"));
        }
        let target_row=sqlx::query("SELECT m.chat_moderator,u.admin FROM room_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 AND m.user_id=$2 FOR UPDATE OF m FOR SHARE OF u")
            .bind(room).bind(target).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::NOT_FOUND,"not_a_member"))?;
        if target_row.get::<bool, _>("admin")
            || (!g.admin && g.owner != g.user && target_row.get::<bool, _>("chat_moderator"))
        {
            return Err(err(StatusCode::FORBIDDEN, "chat_target_protected"));
        }
        match m.action.as_str() {
            "mute" => {
                let minutes = m
                    .minutes
                    .filter(|n| (1..=1440).contains(n))
                    .ok_or_else(|| err(StatusCode::BAD_REQUEST, "chat_moderation_invalid"))?;
                sqlx::query("UPDATE room_members SET chat_muted_until=clock_timestamp()+($3*interval '1 minute') WHERE room_id=$1 AND user_id=$2").bind(room).bind(target).bind(minutes as f64).execute(&mut *tx).await?;
            }
            "unmute" => {
                sqlx::query(
                    "UPDATE room_members SET chat_muted_until=NULL WHERE room_id=$1 AND user_id=$2",
                )
                .bind(room)
                .bind(target)
                .execute(&mut *tx)
                .await?;
            }
            "moderator" => {
                if !g.admin && g.owner != g.user {
                    return Err(err(StatusCode::FORBIDDEN, "forbidden"));
                }
                let value = m
                    .moderator
                    .ok_or_else(|| err(StatusCode::BAD_REQUEST, "chat_moderation_invalid"))?;
                sqlx::query(
                    "UPDATE room_members SET chat_moderator=$3 WHERE room_id=$1 AND user_id=$2",
                )
                .bind(room)
                .bind(target)
                .bind(value)
                .execute(&mut *tx)
                .await?;
            }
            "remove" => {
                sqlx::query("DELETE FROM room_members WHERE room_id=$1 AND user_id=$2")
                    .bind(room)
                    .bind(target)
                    .execute(&mut *tx)
                    .await?;
            }
            _ => unreachable!(),
        }
    }
    let audit = Uuid::new_v4();
    sqlx::query("INSERT INTO room_chat_audit(id,room_id,actor_id,target_user_id,message_id,action,reason) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(audit).bind(room).bind(g.user).bind(m.target_user_id).bind(m.message_id).bind(m.action).bind(m.reason).execute(&mut *tx).await?;
    commit(tx, &g).await?;
    if let Some(id) = deleted {
        rooms::broadcast_timeline(&app, room, json!({"type":"CHAT_DELETED","id":id})).await;
    }
    Ok(media_titles::private_json(json!({"audit_id":audit})))
}
pub async fn audit(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
) -> Result<Response> {
    let (mut tx, g) = gate(&app, &h, room, false, true, false).await?;
    if !can_manage(&g) {
        return Err(err(StatusCode::FORBIDDEN, "chat_moderator_required"));
    }
    let rows=sqlx::query("SELECT id,actor_id,target_user_id,message_id,action,reason,floor(extract(epoch FROM created_at)*1000)::bigint AS at_ms FROM room_chat_audit WHERE room_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100").bind(room).fetch_all(&mut *tx).await?;
    let items:Vec<_>=rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"actor_id":r.get::<Uuid,_>("actor_id"),"target_user_id":r.get::<Option<Uuid>,_>("target_user_id"),"message_id":r.get::<Option<Uuid>,_>("message_id"),"action":r.get::<String,_>("action"),"reason":r.get::<String,_>("reason"),"created_at":r.get::<i64,_>("at_ms")})).collect();
    commit(tx, &g).await?;
    Ok(media_titles::private_json(json!({"items":items})))
}

pub async fn activities(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
) -> Result<Response> {
    let (mut tx, g) = gate(&app, &h, room, false, false, false).await?;
    let rows=sqlx::query("SELECT id,media_id,media_generation,lifecycle_epoch,versioned,floor(extract(epoch FROM created_at)*1000)::bigint AS at_ms FROM room_media_activities WHERE room_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50").bind(room).fetch_all(&mut *tx).await?;
    let items:Vec<_>=rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"media_id":r.get::<Uuid,_>("media_id"),"media_generation":r.get::<i64,_>("media_generation"),"lifecycle_epoch":r.get::<i64,_>("lifecycle_epoch"),"versioned":r.get::<bool,_>("versioned"),"created_at":r.get::<i64,_>("at_ms")})).collect();
    commit(tx, &g).await?;
    Ok(media_titles::private_json(json!({"items":items})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn client_coordinates_and_text_are_bounded() {
        let mut c = Comment {
            client_message_id: Uuid::new_v4(),
            body: "hello".into(),
            activity_id: Uuid::new_v4(),
            anchor_source: "server_received".into(),
            media_time_ms: None,
        };
        assert!(validate_comment(&c).is_ok());
        c.media_time_ms = Some(1);
        assert!(validate_comment(&c).is_err());
        c.anchor_source = "client_reported".into();
        assert!(validate_comment(&c).is_ok());
        c.media_time_ms = Some(-1);
        assert!(validate_comment(&c).is_err());
        c.media_time_ms = Some(1);
        c.body = "\u{202e}text".into();
        assert!(validate_comment(&c).is_err());
    }
    #[test]
    fn emoji_is_closed_and_not_arbitrary_markup() {
        assert_eq!(EMOJI.len(), 6);
        assert!(!EMOJI.contains(&"<img onerror=alert(1)>"));
    }
}
