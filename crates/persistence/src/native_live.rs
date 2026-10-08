//! Live semantics come exclusively from the room-private immutable media row.
use anyhow::{Result, bail};
use protocol::{NativePlatformLiveBinding, NativePlatformLiveSyncMode};
use sqlx::Row;
use uuid::Uuid;

pub async fn selected_binding<'e, E: sqlx::Executor<'e, Database = sqlx::Postgres>>(
    executor: E,
    room: Uuid,
    media: Uuid,
) -> Result<Option<NativePlatformLiveBinding>> {
    let row = sqlx::query("SELECT resource_kind,provider,canonical_url,live_started_at,live_resource,live_room_id,live_uid,live_broadcast_id,other_live_identity_valid(provider,live_room_id,live_uid,live_started_at,live_broadcast_id,canonical_url,live_resource) AS other_live_valid FROM room_platform_media WHERE room_id=$1 AND media_id=$2 FOR SHARE")
        .bind(room).bind(media).fetch_optional(executor).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.get::<String, _>("resource_kind") == "other_live" {
        if row.get::<Option<bool>, _>("other_live_valid") != Some(true) {
            bail!("native_live_state_changed");
        }
        let binding = NativePlatformLiveBinding {
            version: 2,
            broadcast_id: row
                .get::<Option<String>, _>("live_broadcast_id")
                .ok_or_else(|| anyhow::anyhow!("native_live_state_changed"))?,
            sync_mode: NativePlatformLiveSyncMode::LiveEdgeControl,
        };
        if !binding.valid() {
            bail!("native_live_state_changed");
        }
        return Ok(Some(binding));
    }
    if row.get::<String, _>("resource_kind") != "live" {
        return Ok(None);
    }
    let room_id: Option<String> = row.get("live_room_id");
    let uid: Option<String> = row.get("live_uid");
    let broadcast_id: Option<String> = row.get("live_broadcast_id");
    let (Some(room_id), Some(uid), Some(broadcast_id)) = (room_id, uid, broadcast_id) else {
        bail!("native_live_state_changed");
    };
    let binding = NativePlatformLiveBinding {
        version: 1,
        broadcast_id,
        sync_mode: NativePlatformLiveSyncMode::LiveEdgeControl,
    };
    if !binding.valid()
        || !binding
            .broadcast_id
            .starts_with(&format!("{room_id}:{uid}:"))
    {
        bail!("native_live_state_changed");
    }
    Ok(Some(binding))
}
