//! Personal/shared title mutation with its original caller-first transaction.
use super::media_projection::{BROWSE, SELECT, VISIBLE, media};
use crate::{Result, err, identity, media_authorization};
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

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

pub async fn change(
    context: identity::RequestContext<'_>,
    h: HeaderMap,
    id: Uuid,
    body: Value,
    shared: bool,
) -> Result<Value> {
    let db = context.db;
    let user = identity::request::authenticate(context, &h, true, false).await?;
    if shared {
        identity::request::admin(&user)?;
    }
    let (title, revision) = validate(body)?;
    let mut tx = db.begin().await?;
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
    Ok(response)
}
