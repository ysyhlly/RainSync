//! Playlist resolution belongs to the same locked snapshot as final reduction.
use anyhow::{Result, bail};
use protocol::RoomState;
use room_core::diagnostics::ResolvedMedia;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

fn next_media(ids: &[Uuid], current: Option<Uuid>) -> Option<Uuid> {
    if ids.is_empty() {
        return current;
    }
    let index = ids.iter().position(|id| Some(*id) == current)?;
    ids.get((index + 1) % ids.len()).copied()
}

pub(super) async fn resolve_end(
    tx: &mut Transaction<'_, Postgres>,
    current: &RoomState,
) -> Result<ResolvedMedia> {
    if current.live.is_some() {
        bail!("native_live_end_unsupported");
    }
    let mut ids: Vec<Uuid> = sqlx::query_scalar("SELECT q.media_id FROM playlist_items q WHERE q.room_id=$1 AND room_media_allowed(q.room_id,q.media_id) ORDER BY q.sort_order,q.id")
        .bind(current.room_id).fetch_all(&mut **tx).await?;
    let mut seen = std::collections::HashSet::new();
    ids.retain(|id| seen.insert(*id));
    let media_id = next_media(&ids, current.media_id).ok_or_else(|| anyhow::anyhow!("no_media"))?;
    let row = sqlx::query("SELECT CASE WHEN m.source_id IS NULL THEN e.duration_ms ELSE m.duration_ms END AS duration_ms FROM media_items m LEFT JOIN room_platform_media e ON e.media_id=m.id AND e.room_id=$2 WHERE m.id=$1 AND room_media_allowed($2,m.id) FOR SHARE OF m")
        .bind(media_id).bind(current.room_id).fetch_optional(&mut **tx).await?
        .ok_or_else(|| anyhow::anyhow!("media_not_found"))?;
    Ok(ResolvedMedia {
        media_id,
        duration_ms: row.get("duration_ms"),
        live: crate::native_live::selected_binding(&mut **tx, current.room_id, media_id).await?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_playlist_repeats_current_media_without_inventing_one() {
        let a = Uuid::from_u128(1);
        assert_eq!(next_media(&[], None), None);
        assert_eq!(next_media(&[], Some(a)), Some(a));
    }

    #[test]
    fn populated_playlist_requires_a_current_anchor() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        assert_eq!(next_media(&[a, b], None), None);
        assert_eq!(next_media(&[b], Some(a)), None);
    }

    #[test]
    fn one_item_playlist_repeats_its_current_media() {
        let a = Uuid::from_u128(1);
        assert_eq!(next_media(&[a], Some(a)), Some(a));
    }

    #[test]
    fn next_item_follows_order_and_wraps_at_the_end() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        let c = Uuid::from_u128(3);
        assert_eq!(next_media(&[a, b], Some(a)), Some(b));
        assert_eq!(next_media(&[a, b], Some(b)), Some(a));
        assert_eq!(next_media(&[a, b, c], Some(a)), Some(b));
        assert_eq!(next_media(&[a, b, c], Some(b)), Some(c));
        assert_eq!(next_media(&[a, b, c], Some(c)), Some(a));
    }
}
