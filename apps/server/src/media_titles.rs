use super::*;
use crate::responses::ok_json;

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
        "cover": media_previews::cover(row)
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

pub async fn read(app: &App, viewer: Uuid, id: Uuid) -> Result<Value> {
    let row = sqlx::query(&format!("{SELECT} WHERE {BROWSE} AND m.id=$2"))
        .bind(viewer)
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "media_not_found"))?;
    Ok(media(&row))
}

pub async fn detail(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    Ok(ok_json(read(&app, user.id, id).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    title: Option<String>,
    expected_revision: String,
}

fn validate(value: Value) -> Result<(Option<String>, i64)> {
    // Option alone would also accept a missing field; require explicit null to clear.
    if value.get("title").is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "media_title_invalid"));
    }
    let change: Change = serde_json::from_value(value)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "media_title_invalid"))?;
    let revision = change.expected_revision;
    if revision.is_empty() || !revision.bytes().all(|v| v.is_ascii_digit()) {
        return Err(err(StatusCode::BAD_REQUEST, "media_title_invalid"));
    }
    let revision = revision
        .parse::<i64>()
        .ok()
        .filter(|v| *v < i64::MAX)
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "media_title_invalid"))?;
    let title = change
        .title
        .map(|v| {
            // Reject control characters before trimming, including trailing newlines.
            if v.chars()
                .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
            {
                return Err(err(StatusCode::BAD_REQUEST, "media_title_invalid"));
            }
            let v = v.trim().to_owned();
            if !(1..=200).contains(&v.chars().count()) {
                return Err(err(StatusCode::BAD_REQUEST, "media_title_invalid"));
            }
            Ok(v)
        })
        .transpose()?;
    Ok((title, revision))
}

pub async fn personal(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Response> {
    change(app, h, id, body, false).await
}
pub async fn shared(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Response> {
    change(app, h, id, body, true).await
}
async fn change(app: App, h: HeaderMap, id: Uuid, body: Value, shared: bool) -> Result<Response> {
    let user = auth(&app, &h, true).await?;
    if shared {
        admin(&user)?;
    }
    let (title, revision) = validate(body)?;
    let mut tx = app.db.begin().await?;
    let login = media_authorization::login_hash(&h)?;
    // Follow existing library writes: caller -> library -> source -> media.
    // Holding grant/library authority prevents revocation from committing in
    // the gap between a visibility check and a title write.
    let role: Option<bool> =
        sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 AND account_active(id) FOR SHARE")
            .bind(user.id)
            .fetch_optional(&mut *tx)
            .await?;
    if role.is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    if shared && role != Some(true) {
        return Err(err(StatusCode::FORBIDDEN, "admin_required"));
    }
    if !persistence::media_authorization::lock_login(&mut tx, user.id, &login).await? {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    let csrf: String =
        sqlx::query_scalar("SELECT csrf FROM sessions WHERE token_hash=$1 AND user_id=$2")
            .bind(&login)
            .bind(user.id)
            .fetch_one(&mut *tx)
            .await?;
    if h.get("x-csrf-token").and_then(|v| v.to_str().ok()) != Some(csrf.as_str()) {
        return Err(err(StatusCode::FORBIDDEN, "csrf_rejected"));
    }
    let scope = sqlx::query("SELECT s.id,s.library_id FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1")
        .bind(id).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::NOT_FOUND,"media_not_found"))?;
    let source: Uuid = scope.get("id");
    let library: Uuid = scope.get("library_id");
    sqlx::query("SELECT id FROM private_libraries WHERE id=$1 FOR SHARE")
        .bind(library)
        .fetch_optional(&mut *tx)
        .await?;
    sqlx::query("SELECT user_id FROM library_grants WHERE library_id=$1 AND user_id=$2 FOR SHARE")
        .bind(library)
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;
    let current: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(source)
    .bind(library)
    .fetch_optional(&mut *tx)
    .await?;
    if current.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "media_not_found"));
    }
    // Serialize first writes, source removal and existing updates on this media.
    let exists = sqlx::query(&format!("SELECT m.id FROM media_items m JOIN sources s ON s.id=m.source_id WHERE {VISIBLE} AND m.id=$1 AND library_media_allowed($2,m.id,'browse',NULL) FOR UPDATE OF m"))
        .bind(id).bind(user.id).fetch_optional(&mut *tx).await?.is_some();
    if !exists {
        return Err(err(StatusCode::NOT_FOUND, "media_not_found"));
    }
    if shared {
        let manage: bool = sqlx::query_scalar("SELECT library_allowed($1,s.library_id,'manage') FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$2").bind(user.id).bind(id).fetch_one(&mut *tx).await?;
        if !manage {
            return Err(err(StatusCode::NOT_FOUND, "media_not_found"));
        }
    }
    let changed = if shared {
        sqlx::query("UPDATE media_items SET shared_title=$2,shared_title_revision=shared_title_revision+1 WHERE id=$1 AND shared_title_revision=$3")
            .bind(id).bind(title).bind(revision).execute(&mut *tx).await?.rows_affected()
    } else {
        sqlx::query(
            "INSERT INTO media_user_titles(user_id,media_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(user.id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE media_user_titles SET title=$3,revision=revision+1 WHERE user_id=$1 AND media_id=$2 AND revision=$4")
            .bind(user.id).bind(id).bind(title).bind(revision).execute(&mut *tx).await?.rows_affected()
    };
    if changed != 1 {
        return Err(err(StatusCode::CONFLICT, "media_title_conflict"));
    }
    // Read the response while all permission locks are held. A post-commit
    // read could report 404 even though this mutation has already committed.
    let row = sqlx::query(&format!("{SELECT} WHERE {BROWSE} AND m.id=$2 AND s.id=$3"))
        .bind(user.id)
        .bind(id)
        .bind(source)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "media_not_found"))?;
    let response = media(&row);
    // Grant expiry can pass during any later statement, even with row locks.
    let admission = sqlx::query("SELECT playback_login_allowed($1,$2) AND account_active($1) AS login_live,library_media_allowed($1,$3,'browse',NULL) AS browse_live,(NOT $4::boolean OR library_allowed($1,$5,'manage')) AS manage_live")
        .bind(user.id).bind(&login).bind(id).bind(shared).bind(library).fetch_one(&mut *tx).await?;
    if !admission.get::<bool, _>("login_live") {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    if !admission.get::<bool, _>("browse_live") || !admission.get::<bool, _>("manage_live") {
        return Err(err(StatusCode::NOT_FOUND, "media_not_found"));
    }
    tx.commit().await?;
    Ok(ok_json(response))
}
