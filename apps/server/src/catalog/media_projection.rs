//! Stateless viewer-specific media cards and explicit provider metadata.
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

// $1 is always the authenticated viewer, never an input user id.
pub const SELECT: &str = "SELECT m.id,COALESCE(u.title,m.shared_title,m.title) AS title,m.title AS original_title,m.shared_title,m.shared_title_revision,u.title AS personal_title,COALESCE(u.revision,0) AS personal_title_revision,m.duration_ms,s.kind,CASE WHEN s.kind IN ('jellyfin','emby') THEN jsonb_build_object('Type',m.metadata->'Type','IndexNumber',m.metadata->'IndexNumber','ParentIndexNumber',m.metadata->'ParentIndexNumber','SeriesName',m.metadata->'SeriesName') ELSE '{}'::jsonb END AS provider_metadata,p.status AS preview_status,p.result_revision AS preview_revision FROM media_items m JOIN sources s ON s.id=m.source_id LEFT JOIN media_user_titles u ON u.media_id=m.id AND u.user_id=$1 LEFT JOIN media_previews p ON p.media_id=m.id AND p.source_generation=m.preview_generation AND p.recipe_version=2 AND (s.kind IN ('local','agent') OR p.generated_at IS NULL OR p.generated_at>clock_timestamp()-interval '24 hours')";
pub const BROWSE: &str = "m.available AND (s.kind<>'agent' OR EXISTS(SELECT 1 FROM agents a WHERE a.id=s.id AND NOT a.revoked)) AND library_media_allowed($1,m.id,'browse',NULL)";
pub const VISIBLE: &str = "m.available AND (s.kind<>'agent' OR EXISTS(SELECT 1 FROM agents a WHERE a.id=s.id AND NOT a.revoked))";

pub fn media(row: &sqlx::postgres::PgRow) -> Value {
    let mut value = json!({
        "id": row.get::<Uuid,_>("id"), "title": row.get::<String,_>("title"),
        "original_title": row.get::<String,_>("original_title"),
        "shared_title": row.get::<Option<String>,_>("shared_title"),
        "shared_title_revision": row.get::<i64,_>("shared_title_revision").to_string(),
        "personal_title": row.get::<Option<String>,_>("personal_title"),
        "personal_title_revision": row.get::<i64,_>("personal_title_revision").to_string(),
        "duration_ms": row.get::<Option<f64>,_>("duration_ms"), "kind": row.get::<String,_>("kind"),
        "cover": cover(row)
    });
    if let Some(series) = row
        .try_get::<Value, _>("provider_metadata")
        .ok()
        .and_then(|metadata| series_metadata(&row.get::<String, _>("kind"), &metadata))
    {
        value["series"] = series;
    }
    value
}

fn series_metadata(kind: &str, metadata: &Value) -> Option<Value> {
    // Never infer episode labels from an item title, page position or folder
    // size. Only the explicit provider episode fields belong in this DTO.
    if !matches!(kind, "jellyfin" | "emby") || metadata["Type"] != "Episode" {
        return None;
    }
    let mut series = serde_json::Map::new();
    for (upstream, field) in [
        ("IndexNumber", "episode_number"),
        ("ParentIndexNumber", "season_number"),
    ] {
        if let Some(number) = metadata[upstream]
            .as_u64()
            .filter(|number| *number <= 10000)
        {
            series.insert(field.into(), json!(number));
        }
    }
    if let Some(title) = metadata["SeriesName"].as_str().filter(|title| {
        !title.trim().is_empty()
            && title.chars().count() <= 200
            && !title.chars().any(char::is_control)
    }) {
        series.insert("series_title".into(), json!(title));
    }
    (!series.is_empty()).then_some(Value::Object(series))
}

/// Internal success data; nullable fields remain present on the wire.
#[derive(Serialize)]
pub(crate) struct CoverView {
    status: String,
    revision: Option<Uuid>,
    url: Option<String>,
    retry_after_ms: Option<u32>,
}

impl CoverView {
    pub(super) fn new(id: Uuid, status: Option<String>, revision: Option<Uuid>) -> Self {
        let status = status.unwrap_or("missing".into());
        let url = if status == "ready" {
            revision.map(|value| format!("/api/v1/media/{id}/cover?revision={value}"))
        } else {
            None
        };
        let retry_after_ms = match status.as_str() {
            "queued" | "running" => Some(2000),
            "unavailable" => Some(60000),
            _ => None,
        };
        Self {
            status,
            revision,
            url,
            retry_after_ms,
        }
    }
}

pub fn cover(row: &sqlx::postgres::PgRow) -> CoverView {
    let status = row.get::<Option<String>, _>("preview_status");
    let revision = row.get::<Option<Uuid>, _>("preview_revision");
    let id: Uuid = row.get("id");
    CoverView::new(id, status, revision)
}

#[cfg(test)]
mod cover_tests {
    use super::*;

    #[test]
    fn missing_and_revisionless_ready_keep_explicit_null_fields() {
        for status in [None, Some("missing"), Some("ready")] {
            let cover = CoverView::new(Uuid::from_u128(1), status.map(str::to_owned), None);
            assert_eq!(
                serde_json::to_value(cover).unwrap(),
                json!({"status":status.unwrap_or("missing"),"revision":null,"url":null,"retry_after_ms":null})
            );
        }
    }

    #[test]
    fn queued_running_and_unavailable_keep_revision_and_retry_values() {
        let revision = Uuid::from_u128(2);
        for (status, retry_after_ms) in
            [("queued", 2000), ("running", 2000), ("unavailable", 60000)]
        {
            let cover = CoverView::new(Uuid::from_u128(1), Some(status.into()), Some(revision));
            assert_eq!(
                serde_json::to_value(cover).unwrap(),
                json!({"status":status,"revision":revision,"url":null,"retry_after_ms":retry_after_ms})
            );
        }
    }

    #[test]
    fn ready_keeps_exact_revision_url_and_null_retry() {
        let cover = CoverView::new(
            Uuid::from_u128(1),
            Some("ready".into()),
            Some(Uuid::from_u128(2)),
        );
        assert_eq!(
            serde_json::to_value(cover).unwrap(),
            json!({
                "status":"ready",
                "revision":"00000000-0000-0000-0000-000000000002",
                "url":"/api/v1/media/00000000-0000-0000-0000-000000000001/cover?revision=00000000-0000-0000-0000-000000000002",
                "retry_after_ms":null
            })
        );
    }

    #[test]
    fn unknown_status_and_nonready_revision_are_not_normalized() {
        let revision = Uuid::from_u128(2);
        for status in [
            None,
            Some("future-preview-state"),
            Some(""),
            Some("missing"),
        ] {
            let cover = CoverView::new(
                Uuid::from_u128(1),
                status.map(str::to_owned),
                Some(revision),
            );
            assert_eq!(
                serde_json::to_value(cover).unwrap(),
                json!({"status":status.unwrap_or("missing"),"revision":revision,"url":null,"retry_after_ms":null})
            );
        }
    }
}

#[cfg(test)]
mod series_tests {
    use super::*;
    #[test]
    fn explicit_episode_metadata_is_projected_without_provider_private_fields() {
        let metadata = json!({"Type":"Episode","IndexNumber":3,"ParentIndexNumber":2,"SeriesName":"真实系列",
            "ImageTags":{"Primary":"private-provider-image-tag"},"Url":"https://secret.invalid"});
        assert_eq!(
            series_metadata("jellyfin", &metadata),
            Some(json!({"episode_number":3,"season_number":2,"series_title":"真实系列"}))
        );
        assert_eq!(
            series_metadata("emby", &metadata),
            series_metadata("jellyfin", &metadata)
        );
        assert!(series_metadata("http", &metadata).is_none());
    }
    #[test]
    fn missing_or_invalid_episode_numbers_are_never_replaced_by_guesses() {
        for metadata in [
            json!({"Type":"Movie","IndexNumber":3}),
            json!({"Type":"Episode","Name":"S02E03"}),
            json!({"Type":"Episode","IndexNumber":"3","ParentIndexNumber":-1,"SeriesName":"bad\nname"}),
            json!({"Type":"Episode","IndexNumber":10001}),
        ] {
            assert!(series_metadata("jellyfin", &metadata).is_none());
        }
        assert_eq!(
            series_metadata(
                "jellyfin",
                &json!({"Type":"Episode","IndexNumber":0,"ParentIndexNumber":0})
            ),
            Some(json!({"episode_number":0,"season_number":0}))
        );
    }
}
