use super::*;

// $1 is always the authenticated viewer, never an input user id.
pub const SELECT: &str = "SELECT m.id,COALESCE(u.title,m.shared_title,m.title) AS title,m.title AS original_title,m.shared_title,m.shared_title_revision,u.title AS personal_title,COALESCE(u.revision,0) AS personal_title_revision,m.duration_ms,s.kind,p.status AS preview_status,p.result_revision AS preview_revision FROM media_items m JOIN sources s ON s.id=m.source_id LEFT JOIN media_user_titles u ON u.media_id=m.id AND u.user_id=$1 LEFT JOIN media_previews p ON p.media_id=m.id AND p.source_generation=m.preview_generation AND p.recipe_version=2 AND (s.kind IN ('local','agent') OR p.generated_at IS NULL OR p.generated_at>clock_timestamp()-interval '24 hours')";
pub const VISIBLE: &str = "m.available AND (s.kind<>'agent' OR EXISTS(SELECT 1 FROM agents a WHERE a.id=s.id AND NOT a.revoked))";

pub fn media(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<Uuid,_>("id"), "title": row.get::<String,_>("title"),
        "original_title": row.get::<String,_>("original_title"),
        "shared_title": row.get::<Option<String>,_>("shared_title"),
        "shared_title_revision": row.get::<i64,_>("shared_title_revision").to_string(),
        "personal_title": row.get::<Option<String>,_>("personal_title"),
        "personal_title_revision": row.get::<i64,_>("personal_title_revision").to_string(),
        "duration_ms": row.get::<Option<f64>,_>("duration_ms"), "kind": row.get::<String,_>("kind"),
        "cover": media_previews::cover(row)
    })
}

pub fn private_json(value: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

pub async fn read(app: &App, viewer: Uuid, id: Uuid) -> Result<Value> {
    let row = sqlx::query(&format!("{SELECT} WHERE {VISIBLE} AND m.id=$2"))
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
    Ok(private_json(read(&app, user.id, id).await?))
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
    // Serialize first writes, source removal and existing updates on this media.
    let exists = sqlx::query(&format!("SELECT m.id FROM media_items m JOIN sources s ON s.id=m.source_id WHERE {VISIBLE} AND m.id=$1 FOR UPDATE OF m"))
        .bind(id).fetch_optional(&mut *tx).await?.is_some();
    if !exists {
        return Err(err(StatusCode::NOT_FOUND, "media_not_found"));
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
    tx.commit().await?;
    Ok(private_json(read(&app, user.id, id).await?))
}
