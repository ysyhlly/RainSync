use crate::*;
use axum::{
    body::{Body, to_bytes},
    extract::{Query, Request},
};

#[derive(Clone)]
struct Operation {
    id: Uuid,
    expected: Option<Uuid>,
}
fn operation(h: &HeaderMap) -> Result<Operation> {
    let id = h
        .get("x-avatar-operation-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_request"))?;
    let version = h
        .get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix('"'))
        .and_then(|v| v.strip_suffix('"'))
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_request"))?;
    let expected = if version == "none" {
        None
    } else {
        Some(
            version
                .parse()
                .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_request"))?,
        )
    };
    Ok(Operation { id, expected })
}
fn conflict() -> Error {
    err(StatusCode::CONFLICT, "avatar_version_conflict")
}
pub fn url(user: Uuid, version: Option<Uuid>, present: bool) -> Option<String> {
    if present {
        version.map(|v| format!("/api/v1/users/{user}/avatar?v={v}"))
    } else {
        None
    }
}
async fn metadata(app: &App, user: Uuid) -> Result<Response> {
    let value = profile::value(app, user).await?;
    Ok(responses::private_json(
        StatusCode::OK,
        json!({"avatar_url":value["avatar_url"],"avatar_version":value["avatar_version"]}),
    ))
}
fn matching(
    row: &sqlx::postgres::PgRow,
    key: &Operation,
    action: &str,
    request_hash: &str,
) -> Result<()> {
    if row.get::<Option<Uuid>, _>("expected_version") != key.expected
        || row.get::<String, _>("action") != action
        || row.get::<String, _>("request_hash") != request_hash
    {
        return Err(err(StatusCode::CONFLICT, "avatar_operation_conflict"));
    }
    Ok(())
}
async fn preflight(
    app: &App,
    user: Uuid,
    key: &Operation,
    action: &str,
    request_hash: &str,
) -> Result<bool> {
    if let Some(row)=sqlx::query("SELECT expected_version,action,request_hash FROM avatar_operations WHERE user_id=$1 AND operation_id=$2")
        .bind(user).bind(key.id).fetch_optional(&app.db).await? {matching(&row,key,action,request_hash)?;return Ok(true)}
    let version: Option<Uuid> =
        sqlx::query_scalar("SELECT version FROM user_avatars WHERE user_id=$1")
            .bind(user)
            .fetch_optional(&app.db)
            .await?;
    if version != key.expected {
        return Err(conflict());
    }
    Ok(false)
}
async fn commit(
    app: &App,
    user: Uuid,
    key: &Operation,
    action: &str,
    request_hash: &str,
    content: Option<Vec<u8>>,
) -> Result<()> {
    let mut tx = app.db.begin().await?;
    // A stable parent lock serializes the initial absent row and later tombstones.
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(user)
        .fetch_one(&mut *tx)
        .await?;
    if let Some(row)=sqlx::query("SELECT expected_version,action,request_hash FROM avatar_operations WHERE user_id=$1 AND operation_id=$2")
        .bind(user).bind(key.id).fetch_optional(&mut *tx).await? {matching(&row,key,action,request_hash)?;return Ok(())}
    let version: Option<Uuid> =
        sqlx::query_scalar("SELECT version FROM user_avatars WHERE user_id=$1")
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?;
    if version != key.expected {
        return Err(conflict());
    }
    sqlx::query("INSERT INTO avatar_operations(user_id,operation_id,expected_version,action,request_hash) VALUES($1,$2,$3,$4,$5)")
        .bind(user).bind(key.id).bind(key.expected).bind(action).bind(request_hash).execute(&mut *tx).await?;
    let content_type = content.as_ref().map(|_| "image/webp");
    sqlx::query("INSERT INTO user_avatars(user_id,version,content_type,content) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET version=EXCLUDED.version,content_type=EXCLUDED.content_type,content=EXCLUDED.content,updated_at=clock_timestamp()")
        .bind(user).bind(key.id).bind(content_type).bind(content.as_deref()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn upload(State(app): State<App>, request: Request) -> Result<Response> {
    let h = request.headers();
    let user = auth(&app, h, true).await?;
    let key = operation(h)?;
    if h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) != Some("image/png") {
        return Err(err(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
        ));
    }
    account_security::rate_limit(
        &app.db,
        "avatar-write",
        &user.id.to_string(),
        app.avatar_settings.writes_per_minute,
        60,
    )
    .await?;
    // Only this binary route reads a 2 MiB body; JSON APIs retain their 64 KiB extractor bound.
    let input = to_bytes(request.into_body(), avatar_image::INPUT_LIMIT)
        .await
        .map_err(|_| err(StatusCode::PAYLOAD_TOO_LARGE, "avatar_too_large"))?;
    avatar_image::check_png(&input)?;
    let request_hash = hex::encode(Sha256::digest(&input));
    if preflight(&app, user.id, &key, "upload", &request_hash).await? {
        return metadata(&app, user.id).await;
    }
    let content = avatar_image::encode(&app.avatar_settings, input.to_vec()).await?;
    commit(&app, user.id, &key, "upload", &request_hash, Some(content)).await?;
    metadata(&app, user.id).await
}
pub async fn remove(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    let user = auth(&app, &h, true).await?;
    let key = operation(&h)?;
    account_security::rate_limit(
        &app.db,
        "avatar-write",
        &user.id.to_string(),
        app.avatar_settings.writes_per_minute,
        60,
    )
    .await?;
    commit(&app, user.id, &key, "delete", &hash("avatar-delete"), None).await?;
    metadata(&app, user.id).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Version {
    v: Uuid,
}
pub async fn read(
    State(app): State<App>,
    h: HeaderMap,
    Path(user): Path<Uuid>,
    Query(version): Query<Version>,
) -> Result<Response> {
    let viewer = auth_viewer(&app, &h, false).await?;
    let allowed:bool=sqlx::query_scalar("SELECT guest_is_account($1) OR EXISTS(SELECT 1 FROM guest_principals g JOIN room_members m ON m.room_id=g.room_id WHERE g.user_id=$1 AND m.user_id=$2 AND guest_room_allowed($1,g.room_id))").bind(viewer.id).bind(user).fetch_one(&app.db).await?;
    if !allowed {
        return Err(err(StatusCode::NOT_FOUND, "not_found"));
    }
    let bytes: Vec<u8> = sqlx::query_scalar(
        "SELECT content FROM user_avatars WHERE user_id=$1 AND version=$2 AND content IS NOT NULL",
    )
    .bind(user)
    .bind(version.v)
    .fetch_optional(&app.db)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    let etag = format!("\"{}\"", version.v);
    let unchanged =
        h.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str());
    Ok(Response::builder()
        .status(if unchanged {
            StatusCode::NOT_MODIFIED
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, "image/webp")
        .header(header::CACHE_CONTROL, "private, no-cache")
        .header(header::ETAG, etag)
        .header("x-content-type-options", "nosniff")
        .body(if unchanged {
            Body::empty()
        } else {
            Body::from(bytes)
        })
        .unwrap())
}
