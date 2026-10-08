//! Live-edge/control rooms have no verified room-to-decoder time map. An
//! untrusted client cannot manufacture a frame-synchronization measurement.
use super::*;
use tokio::time::Duration;

const LIVE_SELECTION: &str = "SELECT EXISTS(SELECT 1 FROM room_snapshots s JOIN room_platform_media e ON e.room_id=s.room_id AND e.media_id::text=s.state->>'media_id' WHERE s.room_id=$1 AND e.resource_kind='live')";

fn sanitize(mut status: Value, live: bool) -> Value {
    if live && let Some(object) = status.as_object_mut() {
        object.remove("drift_ms");
    }
    status
}

pub(super) async fn prepare(app: &App, room: Uuid, status: Value) -> Option<Value> {
    // Classification comes from the currently selected immutable room entry,
    // never a client-supplied live flag or the null duration of ordinary VOD.
    // Unknown authority/classification drops the sample instead of inventing
    // a synchronization metric or sharing an unverified diagnostic claim.
    let live = tokio::time::timeout(
        Duration::from_secs(2),
        database_checks::boolean(&app.db, sqlx::query_scalar(LIVE_SELECTION).bind(room), 1500),
    )
    .await
    .ok()?
    .ok()?;
    Some(sanitize(status, live))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_status_keeps_buffering_and_phase_without_vod_drift() {
        let status = json!({"buffering":true,"phase":"buffering","drift_ms":0});
        let live = sanitize(status.clone(), true);
        assert_eq!(live, json!({"buffering":true,"phase":"buffering"}));
        assert_eq!(sanitize(status.clone(), false), status);
        assert_eq!(
            sanitize(json!({"buffering":false,"drift_ms":99999}), true),
            json!({"buffering":false})
        );
        assert_eq!(sanitize(Value::Null, true), Value::Null);
    }
}
