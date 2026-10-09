//! Stateless viewer-specific media cards and explicit provider metadata.
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

pub fn cover(row: &sqlx::postgres::PgRow) -> Value {
    let status = row
        .get::<Option<String>, _>("preview_status")
        .unwrap_or("missing".into());
    let revision = row.get::<Option<Uuid>, _>("preview_revision");
    let id: Uuid = row.get("id");
    json!({"status":status,"revision":revision,"url":if status=="ready" {revision.map(|v|format!("/api/v1/media/{id}/cover?revision={v}"))}else{None},"retry_after_ms":match status.as_str(){"queued"|"running"=>Some(2000),"unavailable"=>Some(60000),_=>None}})
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
