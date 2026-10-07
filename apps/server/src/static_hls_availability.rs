//! Authenticated availability of the explicit static-HLS client intent.
//! Runtime readiness never grants source/media admission or enables rollout.
use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    version: u8,
    room_id: Uuid,
    media_generation: u32,
}

#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub(crate) struct Availability {
    version: u8,
    available: bool,
    reason: &'static str,
}

fn availability(enabled: bool, http: bool, installed: bool) -> Availability {
    let reason = if !enabled {
        "operator_disabled"
    } else if !http {
        "source_unsupported"
    } else if !installed {
        "worker_unavailable"
    } else {
        "installed_runtime"
    };
    Availability {
        version: 1,
        available: reason == "installed_runtime",
        reason,
    }
}

pub(crate) fn operator_enabled() -> bool {
    std::env::var("STATIC_HLS_PARENT_PREPARE_ENABLED").is_ok_and(|value| value == "1")
}

pub(crate) async fn endpoint(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<Request>,
) -> Result<impl IntoResponse> {
    let user = auth_viewer(&app, &headers, true).await?;
    member(&app, &user, body.room_id).await?;
    if body.version != 1 || body.room_id.is_nil() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_static_hls_capability_request",
        ));
    }
    let login = cookie(&headers).map(|value| hash(&value));
    let snapshot = scope(&app, &body).await?;
    let enabled = operator_enabled();
    let http = snapshot.2 == "http";
    // Default-off and unsupported sources do not touch the Worker/cache probe.
    let gate = if enabled && http {
        static_hls_contract::supported_child_gate(&app)
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    // A delayed capability response cannot advertise the previous login, room,
    // lifecycle, media or source generation. This is still only availability:
    // prepare independently freezes and verifies its own complete authority.
    let current = auth_viewer(&app, &headers, true).await?;
    member(&app, &current, body.room_id).await?;
    if current.id != user.id
        || cookie(&headers).map(|value| hash(&value)) != login
        || scope(&app, &body).await? != snapshot
    {
        return Err(err(
            StatusCode::CONFLICT,
            "static_hls_capability_scope_changed",
        ));
    }
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(availability(
            enabled,
            http,
            gate.is_some_and(|gate| gate.is_current()),
        )),
    ))
}

async fn scope(app: &App, body: &Request) -> Result<(Uuid, i64, String, Uuid, i64, i64)> {
    let row = sqlx::query("SELECT m.id,room.lifecycle_epoch,s.kind,s.id AS source_id,s.access_policy_revision,m.preview_generation FROM rooms room JOIN room_snapshots snap ON snap.room_id=room.id JOIN media_items m ON m.id=(snap.state->>'media_id')::uuid JOIN sources s ON s.id=m.source_id WHERE room.id=$1 AND room.lifecycle='active' AND (snap.state->>'media_generation')::bigint=$2 AND m.available")
        .bind(body.room_id).bind(i64::from(body.media_generation)).fetch_optional(&app.db).await?
        .ok_or_else(|| err(StatusCode::CONFLICT, "stale_media"))?;
    Ok((
        row.get("id"),
        row.get("lifecycle_epoch"),
        row.get("kind"),
        row.get("source_id"),
        row.get("access_policy_revision"),
        row.get("preview_generation"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_operator_http_and_installed_runtime_offer() {
        for enabled in [false, true] {
            for http in [false, true] {
                for installed in [false, true] {
                    let result = availability(enabled, http, installed);
                    assert_eq!(result.available, enabled && http && installed);
                    assert_eq!(result.version, 1);
                }
            }
        }
    }
    #[test]
    fn unavailable_reasons_remain_truthful() {
        assert_eq!(availability(false, true, true).reason, "operator_disabled");
        assert_eq!(availability(true, false, true).reason, "source_unsupported");
        assert_eq!(availability(true, true, false).reason, "worker_unavailable");
    }
    #[test]
    fn capability_request_is_closed_and_versioned() {
        assert!(serde_json::from_str::<Request>(r#"{"version":1,"room_id":"00000000-0000-0000-0000-000000000001","media_generation":0,"enabled":true}"#).is_err());
    }
}
