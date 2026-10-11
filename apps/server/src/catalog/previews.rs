//! Preview use cases preserve the original queue and image transaction owners.
use super::media_projection::{CoverView, cover};
use crate::identity::{RequestContext, request as identity_request};
use crate::{Result, err};
use axum::http::{HeaderMap, StatusCode};
use persistence::media_previews::{FRESH, VALID};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// Borrow only the queue limit, not the application or unrelated preview settings.
/// The value is read at enqueue, after authentication and visibility filtering.
pub(crate) struct QueueLimit<'a> {
    value: &'a i64,
}

impl<'a> QueueLimit<'a> {
    pub(crate) fn new(value: &'a i64) -> Self {
        Self { value }
    }

    fn get(&self) -> i64 {
        *self.value
    }
}

#[derive(Serialize)]
pub(crate) struct PreviewStates {
    items: Vec<PreviewItem>,
}

#[derive(Serialize)]
struct PreviewItem {
    media_id: Uuid,
    cover: CoverView,
}

/// A result of the original image transaction, not a continuing authority token.
pub struct ImageRead {
    row: sqlx::postgres::PgRow,
}
impl ImageRead {
    pub fn sha256(&self) -> String {
        self.row.get::<String, _>("image_sha256")
    }
    pub fn into_bytes(self) -> Vec<u8> {
        self.row.get::<Vec<u8>, _>("image")
    }
}

fn bounded(mut ids: Vec<Uuid>) -> Result<Vec<Uuid>> {
    ids.sort();
    ids.dedup();
    if ids.len() > 24 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    Ok(ids)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    media_ids: Vec<Uuid>,
}
#[derive(Deserialize)]
pub struct Query {
    #[serde(default)]
    ids: String,
}
pub async fn request(
    context: RequestContext<'_>,
    h: &HeaderMap,
    body: Request,
    queue_limit: QueueLimit<'_>,
) -> Result<PreviewStates> {
    let db = context.db;
    let viewer = identity_request::authenticate(context, h, true, false)
        .await?
        .id;
    let ids = bounded(body.media_ids)?;
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM media_items WHERE id=ANY($1) AND library_media_allowed($2,id,'browse',NULL)").bind(&ids).bind(viewer).fetch_all(db).await?;
    if !persistence::media_previews::enqueue(db, &ids, queue_limit.get()).await? {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "media_preview_queue_full",
        ));
    }
    states(db, viewer, &ids).await
}
pub async fn status(context: RequestContext<'_>, h: &HeaderMap, q: Query) -> Result<PreviewStates> {
    let db = context.db;
    let viewer = identity_request::authenticate(context, h, false, false)
        .await?
        .id;
    let ids = if q.ids.is_empty() {
        vec![]
    } else {
        q.ids
            .split(',')
            .map(Uuid::parse_str)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_request"))?
    };
    states(db, viewer, &bounded(ids)?).await
}
async fn states(db: &PgPool, user: Uuid, ids: &[Uuid]) -> Result<PreviewStates> {
    let rows=sqlx::query(&format!("SELECT m.id,p.status AS preview_status,p.result_revision AS preview_revision FROM media_items m JOIN sources s ON s.id=m.source_id LEFT JOIN media_previews p ON p.media_id=m.id AND {FRESH} WHERE m.id=ANY($1) AND {VALID} AND library_media_allowed($2,m.id,'browse',NULL)"))
        .bind(ids).bind(user).fetch_all(db).await?;
    Ok(PreviewStates {
        items: rows
            .iter()
            .map(|r| PreviewItem {
                media_id: r.get::<Uuid, _>("id"),
                cover: cover(r),
            })
            .collect(),
    })
}

#[derive(Deserialize)]
pub struct ImageQuery {
    revision: Uuid,
    room_id: Option<Uuid>,
}
pub async fn image(
    context: RequestContext<'_>,
    h: &HeaderMap,
    id: Uuid,
    q: ImageQuery,
) -> Result<ImageRead> {
    let db = context.db;
    let viewer = identity_request::authenticate(context, h, false, true)
        .await?
        .id;
    let mut tx = db.begin().await?;
    // Keep authorization valid through the read, including NAS revocation.
    let source: Option<Uuid> =
        sqlx::query_scalar("SELECT source_id FROM media_items WHERE id=$1 AND available AND library_media_allowed($2,id,CASE WHEN $3::uuid IS NULL THEN 'browse' ELSE 'play' END,$3)")
            .bind(id).bind(viewer).bind(q.room_id)
            .fetch_optional(&mut *tx)
            .await?;
    let source = source.ok_or_else(|| err(StatusCode::NOT_FOUND, "media_not_found"))?;
    sqlx::query("SELECT l.id FROM private_libraries l JOIN sources s ON s.library_id=l.id WHERE s.id=$1 FOR SHARE OF l")
        .bind(source).execute(&mut *tx).await?;
    sqlx::query("SELECT id FROM media_items WHERE id=$1 AND available FOR SHARE")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM agents WHERE id=$1 FOR SHARE")
        .bind(source)
        .execute(&mut *tx)
        .await?;
    let row=sqlx::query(&format!("SELECT p.image,p.image_sha256 FROM media_previews p JOIN media_items m ON m.id=p.media_id JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND library_media_allowed($3,m.id,CASE WHEN $4::uuid IS NULL THEN 'browse' ELSE 'play' END,$4) AND p.result_revision=$2 AND p.status='ready' AND {VALID} AND {FRESH}"))
        .bind(id).bind(q.revision).bind(viewer).bind(q.room_id).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::CONFLICT,"media_preview_stale"))?;
    // Throttle LRU writes; a read should not write for every revalidation.
    sqlx::query("UPDATE media_previews SET accessed_at=clock_timestamp() WHERE media_id=$1 AND accessed_at<clock_timestamp()-interval '1 minute'").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(ImageRead { row })
}

#[cfg(test)]
mod admission_tests {
    use super::*;

    async fn closed_pool() -> PgPool {
        // No connection is opened. Closing first also makes a misplaced SQL
        // operation fail immediately instead of ever reaching a socket.
        let db = sqlx::postgres::PgPoolOptions::new()
            .min_connections(0)
            .connect_lazy_with(sqlx::postgres::PgConnectOptions::new());
        db.close().await;
        assert!(db.is_closed());
        db
    }

    fn context(db: &PgPool) -> RequestContext<'_> {
        RequestContext {
            db,
            origin: "https://rainsync.example",
        }
    }

    fn login_required(error: crate::Error) {
        assert_eq!(error.0, StatusCode::UNAUTHORIZED);
        assert_eq!(error.1, "login_required");
    }

    #[tokio::test]
    async fn request_authenticates_before_distinct_id_validation_or_queue_access() {
        let db = closed_pool().await;
        let limit = 2;
        let error = request(
            context(&db),
            &HeaderMap::new(),
            Request {
                media_ids: (1..=25).map(Uuid::from_u128).collect(),
            },
            QueueLimit::new(&limit),
        )
        .await
        .err()
        .expect("missing session must fail admission");
        login_required(error);
    }

    #[tokio::test]
    async fn status_authenticates_before_parsing_ids_or_reading_states() {
        let db = closed_pool().await;
        let error = status(
            context(&db),
            &HeaderMap::new(),
            Query {
                ids: "not-a-uuid,".into(),
            },
        )
        .await
        .err()
        .expect("missing session must fail admission");
        login_required(error);
    }

    #[tokio::test]
    async fn image_authenticates_before_starting_its_original_transaction() {
        let db = closed_pool().await;
        let error = image(
            context(&db),
            &HeaderMap::new(),
            Uuid::from_u128(1),
            ImageQuery {
                revision: Uuid::from_u128(2),
                room_id: Some(Uuid::from_u128(3)),
            },
        )
        .await
        .err()
        .expect("missing session must fail admission");
        login_required(error);
    }

    #[test]
    fn queue_limit_borrows_only_the_supplied_field_without_snapshotting_it() {
        for configured in [1, 2, 128, 4096] {
            let limit = QueueLimit::new(&configured);
            assert!(std::ptr::eq(limit.value, &configured));
            assert_eq!(limit.get(), configured);
        }
    }

    #[test]
    fn request_bound_is_on_distinct_ids_and_preserves_empty_input() {
        assert!(bounded(vec![]).unwrap().is_empty());
        let ids: Vec<_> = (1..=24).map(Uuid::from_u128).collect();
        let duplicates = ids.iter().rev().chain(ids.iter()).copied().collect();
        assert_eq!(bounded(duplicates).unwrap(), ids);
        let error = bounded((1..=25).map(Uuid::from_u128).collect()).unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert_eq!(error.1, "invalid_request");
    }

    #[test]
    fn request_and_query_deserialization_keep_the_existing_extractor_contract() {
        use serde_json::{from_value, json};
        assert!(from_value::<Request>(json!({"media_ids":[]})).is_ok());
        for invalid in [
            json!({}),
            json!({"media_ids":["not-a-uuid"]}),
            json!({"media_ids":[],"unexpected":true}),
        ] {
            assert!(from_value::<Request>(invalid).is_err());
        }
        assert!(from_value::<Query>(json!({})).unwrap().ids.is_empty());
        let revision = Uuid::from_u128(1);
        let image = from_value::<ImageQuery>(json!({"revision":revision})).unwrap();
        assert_eq!(image.revision, revision);
        assert_eq!(image.room_id, None);
        assert!(from_value::<ImageQuery>(json!({})).is_err());
    }
}

#[cfg(test)]
mod state_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_states_serialize_to_an_empty_items_array() {
        assert_eq!(
            serde_json::to_value(PreviewStates { items: vec![] }).unwrap(),
            json!({"items":[]})
        );
    }

    #[test]
    fn state_serialization_keeps_fields_and_supplied_vector_order() {
        let first = Uuid::from_u128(2);
        let second = Uuid::from_u128(1);
        let revision = Uuid::from_u128(3);
        let states = PreviewStates {
            items: vec![
                PreviewItem {
                    media_id: first,
                    cover: CoverView::new(first, Some("queued".into()), Some(revision)),
                },
                PreviewItem {
                    media_id: second,
                    cover: CoverView::new(second, None, None),
                },
            ],
        };
        // This checks serialization order, not an ORDER BY guarantee for SQL.
        assert_eq!(
            serde_json::to_value(states).unwrap(),
            json!({"items":[
                {"media_id":first,"cover":{"status":"queued","revision":revision,"url":null,"retry_after_ms":2000}},
                {"media_id":second,"cover":{"status":"missing","revision":null,"url":null,"retry_after_ms":null}}
            ]})
        );
    }
}
