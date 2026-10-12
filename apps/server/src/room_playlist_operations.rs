//! Complete viewer-read and controller-write playlist operations. The original
//! runtime owns delivery; only committed changes may request an invalidation.
use super::{commit_controller, controller_admission};
use crate::identity::{RequestContext, request};
use crate::{Result, err, media_titles};
use axum::http::{HeaderMap, StatusCode};
use protocol::RoomPermission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct Add {
    media_id: Uuid,
}

#[derive(Serialize)]
struct PlaylistItem {
    id: Uuid,
    media_id: Uuid,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<PlatformKind>,
    // Keep the existing catalog projection and its explicit nulls. Native
    // platform items deliberately retain their separate legacy cover shape.
    cover: Value,
}

#[derive(Serialize)]
enum PlatformKind {
    #[serde(rename = "native_platform")]
    Native,
}

impl PlaylistItem {
    fn catalog(id: Uuid, media_id: Uuid, title: String, mut cover: Value, room: Uuid) -> Self {
        if let Some(url) = cover["url"].as_str() {
            cover["url"] = json!(format!(
                "{url}{}room_id={room}",
                if url.contains('?') { "&" } else { "?" }
            ));
        }
        Self {
            id,
            media_id,
            title,
            kind: None,
            cover,
        }
    }

    fn platform(id: Uuid, media_id: Uuid, title: String) -> Self {
        Self {
            id,
            media_id,
            title,
            kind: Some(PlatformKind::Native),
            cover: json!({"state":"missing","revision":null,"url":null,"retry_after_ms":null}),
        }
    }
}

pub(crate) struct Playlist {
    items: Vec<PlaylistItem>,
}

impl Playlist {
    fn ordered(mut items: Vec<(i64, PlaylistItem)>) -> Self {
        items.sort_by_key(|(order, item)| (*order, item.id));
        Self {
            items: items.into_iter().map(|(_, item)| item).collect(),
        }
    }

    pub(crate) fn into_value(self) -> Value {
        json!(self.items)
    }
}

/// No-op replay and actual insertion share the original item response, but
/// only the latter calls for a runtime invalidation after final admission.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Addition {
    Existing(Uuid),
    Inserted(Uuid),
}
impl Addition {
    pub(crate) fn item(&self) -> Uuid {
        match self {
            Self::Existing(item) | Self::Inserted(item) => *item,
        }
    }
    pub(crate) fn changed(&self) -> bool {
        matches!(self, Self::Inserted(_))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Removal {
    Absent,
    Removed,
}
impl Removal {
    fn from_rows(removed: u64) -> Self {
        if removed > 0 {
            Self::Removed
        } else {
            Self::Absent
        }
    }
    pub(crate) fn changed(&self) -> bool {
        matches!(self, Self::Removed)
    }
}

pub(crate) async fn list(
    context: RequestContext<'_>,
    h: &HeaderMap,
    room: Uuid,
) -> Result<Playlist> {
    let db = context.db;
    let origin = context.origin;
    let viewer = request::authenticate(context, h, false, true).await?;
    request::member(db, &viewer, room).await?;
    let rows = sqlx::query(&format!("{} JOIN playlist_items q ON q.media_id=m.id WHERE {} AND q.room_id=$2 AND library_media_allowed($1,m.id,'play',$2) ORDER BY q.sort_order,q.id", media_titles::SELECT.replace("SELECT m.id,", "SELECT q.id AS playlist_id,q.sort_order AS queue_order,m.id,"), media_titles::VISIBLE))
        .bind(viewer.id).bind(room).fetch_all(db).await?;
    let mut items: Vec<(i64, PlaylistItem)> = rows
        .iter()
        .map(|row| {
            let media = media_titles::media(row);
            (
                row.get("queue_order"),
                PlaylistItem::catalog(
                    row.get("playlist_id"),
                    row.get("id"),
                    row.get("title"),
                    media["cover"].clone(),
                    room,
                ),
            )
        })
        .collect();
    let platform = sqlx::query("SELECT q.id,q.media_id,q.sort_order,e.title FROM playlist_items q JOIN room_platform_media e ON e.media_id=q.media_id AND e.room_id=q.room_id JOIN media_items m ON m.id=e.media_id WHERE q.room_id=$1 AND m.available AND m.source_id IS NULL AND library_media_allowed($2,m.id,'play',$1)")
        .bind(room).bind(viewer.id).fetch_all(db).await?;
    items.extend(platform.iter().map(|row| {
        (
            row.get("sort_order"),
            PlaylistItem::platform(row.get("id"), row.get("media_id"), row.get("title")),
        )
    }));
    let playlist = Playlist::ordered(items);
    // Both reads can wait. Their request-entry identity is never sufficient to
    // return a private projection after exact-login or membership invalidation.
    let current = request::authenticate(RequestContext { db, origin }, h, false, true).await?;
    request::member(db, &current, room).await?;
    Ok(playlist)
}

pub(crate) async fn add(
    context: RequestContext<'_>,
    h: &HeaderMap,
    room: Uuid,
    body: Add,
) -> Result<Addition> {
    let db = context.db;
    let origin = context.origin;
    let user = request::authenticate(context, h, true, false).await?;
    // Preserve the original separate controller request check and its member
    // read, then reuse its room -> snapshot -> member -> user -> exact-login locks.
    let controller = request::authenticate(RequestContext { db, origin }, h, true, false).await?;
    request::member(db, &controller, room).await?;
    let mut tx = controller_admission(db, controller, h, room, RoomPermission::Queue, true).await?;
    sqlx::query("SELECT id FROM media_items WHERE id=$1 FOR SHARE")
        .bind(body.media_id)
        .fetch_optional(&mut *tx)
        .await?;
    sqlx::query("SELECT media_id FROM room_platform_media WHERE media_id=$1 FOR SHARE")
        .bind(body.media_id)
        .fetch_optional(&mut *tx)
        .await?;
    let available: bool = sqlx::query_scalar(
        "SELECT room_media_allowed($1,$2) AND library_media_allowed($3,$2,'play',$1)",
    )
    .bind(room)
    .bind(body.media_id)
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await?;
    if !available {
        return Err(err(StatusCode::NOT_FOUND, "media_not_found"));
    }
    if let Some(item) = sqlx::query_scalar::<_, Uuid>("SELECT id FROM playlist_items WHERE room_id=$1 AND media_id=$2 ORDER BY sort_order,id LIMIT 1")
        .bind(room).bind(body.media_id).fetch_optional(&mut *tx).await? {
        commit_controller(tx, h).await?;
        return Ok(Addition::Existing(item));
    }
    let item = Uuid::new_v4();
    sqlx::query("INSERT INTO playlist_items SELECT $1,$2,$3,COALESCE(max(sort_order),0)+1 FROM playlist_items WHERE room_id=$2")
        .bind(item).bind(room).bind(body.media_id).execute(&mut *tx).await?;
    commit_controller(tx, h).await?;
    Ok(Addition::Inserted(item))
}

pub(crate) async fn remove(
    context: RequestContext<'_>,
    h: &HeaderMap,
    room: Uuid,
    item: Uuid,
) -> Result<Removal> {
    let db = context.db;
    let controller = request::authenticate(context, h, true, false).await?;
    request::member(db, &controller, room).await?;
    let mut tx = controller_admission(db, controller, h, room, RoomPermission::Queue, true).await?;
    let removed = sqlx::query("DELETE FROM playlist_items WHERE room_id=$1 AND id=$2")
        .bind(room)
        .bind(item)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    commit_controller(tx, h).await?;
    Ok(Removal::from_rows(removed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_media_order_uses_queue_order_then_item_uuid_without_deduplication() {
        let room = Uuid::from_u128(1);
        let media = Uuid::from_u128(2);
        let playlist = Playlist::ordered(vec![
            (
                i64::MAX,
                PlaylistItem::platform(Uuid::from_u128(4), media, "last".into()),
            ),
            (
                7,
                PlaylistItem::catalog(
                    Uuid::from_u128(3),
                    media,
                    "catalog".into(),
                    json!({"url":null}),
                    room,
                ),
            ),
            (
                7,
                PlaylistItem::platform(Uuid::from_u128(2), media, "platform".into()),
            ),
            (
                i64::MIN,
                PlaylistItem::catalog(
                    Uuid::from_u128(5),
                    media,
                    "first".into(),
                    json!({"url":null}),
                    room,
                ),
            ),
        ])
        .into_value();
        assert_eq!(
            playlist
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["title"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["first", "platform", "catalog", "last"]
        );
        assert_eq!(Playlist::ordered(vec![]).into_value(), json!([]));
    }

    #[test]
    fn catalog_covers_keep_all_fields_and_append_room_with_the_existing_query_separator() {
        let room = Uuid::from_u128(1);
        for (url, suffix) in [
            ("/cover", "?"),
            ("/cover?revision=x", "&"),
            ("/cover?", "&"),
        ] {
            let cover = json!({"status":"ready","revision":"x","url":url,"retry_after_ms":null});
            let item = PlaylistItem::catalog(
                Uuid::from_u128(2),
                Uuid::from_u128(3),
                "personal title".into(),
                cover.clone(),
                room,
            );
            let mut expected = cover;
            expected["url"] = json!(format!("{url}{suffix}room_id={room}"));
            assert_eq!(
                serde_json::to_value(item).unwrap(),
                json!({"id":Uuid::from_u128(2),"media_id":Uuid::from_u128(3),"title":"personal title","cover":expected})
            );
        }
        let cover = json!({"status":"queued","revision":null,"url":null,"retry_after_ms":2000});
        let item = PlaylistItem::catalog(room, room, "pending".into(), cover.clone(), room);
        assert_eq!(serde_json::to_value(item).unwrap()["cover"], cover);
    }

    #[test]
    fn platform_items_keep_legacy_kind_and_missing_cover_state() {
        let id = Uuid::from_u128(1);
        let media = Uuid::from_u128(2);
        assert_eq!(
            serde_json::to_value(PlaylistItem::platform(id, media, "native".into())).unwrap(),
            json!({"id":id,"media_id":media,"title":"native","kind":"native_platform","cover":{"state":"missing","revision":null,"url":null,"retry_after_ms":null}})
        );
    }

    #[test]
    fn committed_mutation_results_invalidate_only_actual_changes() {
        let item = Uuid::from_u128(1);
        for (outcome, changed) in [
            (Addition::Existing(item), false),
            (Addition::Inserted(item), true),
        ] {
            assert_eq!(outcome.item(), item);
            assert_eq!(outcome.changed(), changed);
        }
        for rows in [0, 1, 2, u64::MAX] {
            assert_eq!(Removal::from_rows(rows).changed(), rows > 0);
        }
    }

    #[test]
    fn add_dto_keeps_uuid_requirement_and_original_unknown_field_tolerance() {
        let id = Uuid::from_u128(1);
        let parsed: Add = serde_json::from_value(json!({"media_id":id,"future":true})).unwrap();
        assert_eq!(parsed.media_id, id);
        for value in [
            json!({}),
            json!({"media_id":null}),
            json!({"media_id":"bad"}),
        ] {
            assert!(serde_json::from_value::<Add>(value).is_err());
        }
    }
}
