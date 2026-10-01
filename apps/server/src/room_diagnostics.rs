//! Administrator-requested, bounded, redacted exports. No playback side effects.
use super::*;
use axum::extract::Query;
use room_core::diagnostics::{
    Event, FORMAT_VERSION, MAX_BUNDLE_BYTES, MAX_ENVELOPE_BYTES, MAX_EVENTS, MAX_STATE_BYTES,
    REDUCER_VERSION, UnavailableReason, Window, decode_envelope, validate_state,
};
use sqlx::{Connection, Postgres, pool::PoolConnection};
use std::time::Duration;

static EXPORTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
const DEADLINE: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    #[serde(default)]
    after_revision: u32,
    #[serde(default = "default_limit")]
    limit: usize,
}
fn default_limit() -> usize {
    128
}

struct OwnedConnection {
    connection: PoolConnection<Postgres>,
    reusable: bool,
}
impl Drop for OwnedConnection {
    fn drop(&mut self) {
        if !self.reusable {
            self.connection.close_on_drop();
        }
    }
}

fn session_hash(headers: &HeaderMap) -> Option<String> {
    let mut bytes = 0usize;
    let mut token = None;
    for header in headers.get_all(header::COOKIE) {
        bytes = bytes.checked_add(header.as_bytes().len())?;
        if bytes > 8192 {
            return None;
        }
        for part in header.to_str().ok()?.split(';') {
            if let Some(value) = part.trim().strip_prefix("rainsync_session=") {
                if token.is_some()
                    || value.len() != 64
                    || !value.bytes().all(|v| v.is_ascii_hexdigit())
                {
                    return None;
                }
                token = Some(value);
            }
        }
    }
    Some(hash(token?))
}

fn state(value: Value) -> Option<protocol::RoomState> {
    // RoomState's ordinary protocol decoder is forward compatible; this private
    // diagnostic projection deliberately requires an exact safe field set.
    const FIELDS: &[&str] = &[
        "room_id",
        "revision",
        "media_id",
        "media_generation",
        "playback_status",
        "anchor_position_ms",
        "anchor_server_time_ms",
        "playback_rate",
        "controller_user_id",
        "duration_ms",
        "clock_epoch",
    ];
    let object = value.as_object()?;
    if object.len() != FIELDS.len() || !FIELDS.iter().all(|key| object.contains_key(*key)) {
        return None;
    }
    let state = serde_json::from_value(value).ok()?;
    validate_state(&state).ok()?;
    Some(state)
}

fn state_text(value: &Value) -> Option<protocol::RoomState> {
    state(serde_json::from_str(value.as_str()?).ok()?)
}

fn event(value: &Value) -> Result<Event> {
    let revision = value["revision"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(unavailable)?;
    let recorded_at_ms = value["recorded_at_ms"]
        .as_i64()
        .filter(|v| *v >= 0)
        .ok_or_else(unavailable)?;
    let after = state_text(&value["after"]);
    let mut envelope = None;
    let problem = if value["oversized"].as_bool() != Some(false) {
        Some(UnavailableReason::OversizedRow)
    } else if after.is_none() {
        Some(UnavailableReason::InvalidState)
    } else if value["legacy"].as_bool() == Some(true) {
        Some(UnavailableReason::Legacy)
    } else {
        match value["diagnostic"]
            .as_str()
            .ok_or("malformed_envelope")
            .and_then(|text| decode_envelope(text.as_bytes()))
        {
            Ok(decoded) => {
                envelope = Some(decoded);
                None
            }
            Err("unsupported_envelope_version" | "unsupported_command_version") => {
                Some(UnavailableReason::UnsupportedVersion)
            }
            Err(_) => Some(UnavailableReason::MalformedEnvelope),
        }
    };
    Ok(Event {
        revision,
        recorded_at_ms,
        after,
        envelope,
        unavailable: problem,
    })
}

fn unavailable() -> Error {
    err(StatusCode::SERVICE_UNAVAILABLE, "diagnostics_unavailable")
}

// A single statement gives room state, lifecycle and events one MVCC view.
// JSON byte guards apply inside SQL, before the application receives any row.
const SNAPSHOT: &str = r#"
WITH authentication AS MATERIALIZED (
 SELECT u.id,u.admin FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp()
), selected_room AS MATERIALIZED (
 SELECT r.id,r.lifecycle,r.lifecycle_epoch,
 CASE WHEN octet_length(s.state::text)<=$5 THEN s.state::text ELSE NULL END AS state
 FROM rooms r JOIN room_snapshots s ON s.room_id=r.id
 WHERE r.id=$2 AND EXISTS(SELECT 1 FROM authentication WHERE admin)
), selected_events AS MATERIALIZED (
 SELECT e.revision,floor(extract(epoch FROM e.created_at)*1000)::bigint AS recorded_at_ms,
 CASE WHEN octet_length(e.state::text)<=$5 THEN e.state::text ELSE NULL END AS after,
 CASE WHEN octet_length(e.diagnostic::text)<=$6 THEN e.diagnostic::text ELSE NULL END AS diagnostic,
 e.diagnostic IS NULL AS legacy,
 (octet_length(e.state::text)>$5 OR COALESCE(octet_length(e.diagnostic::text)>$6,false)) AS oversized
 FROM room_events e JOIN selected_room r ON r.id=e.room_id
 WHERE e.revision>$3 ORDER BY e.revision LIMIT $4
)
SELECT (SELECT admin FROM authentication) AS admin,
 (SELECT row_to_json(r) FROM selected_room r) AS room,
 (SELECT min(e.revision) FROM room_events e JOIN selected_room r ON r.id=e.room_id) AS retained,
 COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.revision) FROM selected_events e),'[]'::jsonb) AS events,
 floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS captured
"#;

async fn collect(
    app: &App,
    token_hash: String,
    room_id: Uuid,
    request: Request,
) -> Result<Vec<u8>> {
    if request.limit == 0 || request.limit > MAX_EVENTS {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let _permit = EXPORTS.try_acquire().map_err(|_| unavailable())?;
    tokio::time::timeout(DEADLINE, async {
        let mut owned = OwnedConnection { connection: app.db.acquire().await?, reusable: false };
        let mut tx = owned.connection.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY").execute(&mut *tx).await?;
        sqlx::query("SELECT set_config('statement_timeout','1200ms',true), set_config('lock_timeout','500ms',true)")
            .execute(&mut *tx).await?;
        let row = sqlx::query(SNAPSHOT)
            .bind(&token_hash).bind(room_id).bind(i64::from(request.after_revision))
            .bind((request.limit + 1) as i64).bind(MAX_STATE_BYTES as i32).bind(MAX_ENVELOPE_BYTES as i32)
            .fetch_one(&mut *tx).await?;
        match row.try_get::<Option<bool>,_>("admin")? {
            None => return Err(err(StatusCode::UNAUTHORIZED,"session_expired")),
            Some(false) => return Err(err(StatusCode::FORBIDDEN,"admin_required")),
            Some(true) => {}
        }
        let room = row.try_get::<Option<Value>,_>("room")?
            .ok_or_else(|| err(StatusCode::NOT_FOUND,"not_found"))?;
        let snapshot = state_text(&room["state"]).filter(|state| state.room_id==room_id)
            .ok_or_else(unavailable)?;
        if request.after_revision > snapshot.revision {
            return Err(err(StatusCode::BAD_REQUEST,"invalid_request"));
        }
        let lifecycle = persistence::room_diagnostics::lifecycle(
            room["lifecycle"].as_str().ok_or_else(unavailable)?,
            room["lifecycle_epoch"].as_i64().ok_or_else(unavailable)?,
        ).map_err(|_| unavailable())?;
        let raw = row.try_get::<Value,_>("events")?;
        let raw = raw.as_array().ok_or_else(unavailable)?;
        let events = raw.iter().take(request.limit).map(event).collect::<Result<Vec<_>>>()?;
        let retained = row.try_get::<Option<i64>,_>("retained")?
            .map(u32::try_from).transpose().map_err(|_| unavailable())?;
        let window = Window {
            format_version: FORMAT_VERSION, reducer_version: REDUCER_VERSION.into(), room_id,
            captured_at_ms: row.try_get("captured")?, after_revision: request.after_revision,
            retained_from_revision: retained, snapshot, lifecycle, events,
            truncated: raw.len() > request.limit,
        };
        let bytes = serde_json::to_vec(&window).map_err(|_| unavailable())?;
        if bytes.len() > MAX_BUNDLE_BYTES {
            return Err(err(StatusCode::PAYLOAD_TOO_LARGE,"diagnostics_window_too_large"));
        }
        // READ COMMITTED gives this statement a new snapshot after all waits
        // and buffer construction. The exact login cannot be rebound to a
        // replacement login. No transaction/connection survives the response.
        let admitted: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp() AND u.admin AND EXISTS(SELECT 1 FROM rooms WHERE id=$2))")
            .bind(&token_hash).bind(room_id).fetch_one(&mut *tx).await?;
        if !admitted { return Err(err(StatusCode::FORBIDDEN,"diagnostics_authority_changed")); }
        tx.rollback().await?;
        owned.reusable = true;
        Ok(bytes)
    }).await.map_err(|_| unavailable())?
        .map_err(|error: Error| if error.0.is_server_error() { unavailable() } else { error })
}

pub async fn export(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    Query(request): Query<Request>,
) -> Response {
    let result = match session_hash(&h) {
        Some(hash) => collect(&app, hash, room, request).await,
        None => Err(err(StatusCode::UNAUTHORIZED, "login_required")),
    };
    let mut response = match result {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "application/json"),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=\"rainsync-room-diagnostics.json\"",
                ),
            ],
            bytes,
        )
            .into_response(),
        Err(error) => error.into_response(),
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ambiguous_and_oversized_cookies_are_not_credentials() {
        let mut headers = HeaderMap::new();
        let token = "a".repeat(64);
        headers.insert(
            header::COOKIE,
            format!("rainsync_session={token}").parse().unwrap(),
        );
        assert_eq!(session_hash(&headers), Some(hash(&token)));
        headers.append(
            header::COOKIE,
            format!("rainsync_session={token}").parse().unwrap(),
        );
        assert!(session_hash(&headers).is_none());
        headers.clear();
        headers.insert(
            header::COOKIE,
            format!("padding={}; rainsync_session={token}", "a".repeat(8192))
                .parse()
                .unwrap(),
        );
        assert!(session_hash(&headers).is_none());
    }
}
