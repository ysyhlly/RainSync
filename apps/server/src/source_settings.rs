//! In-place source settings. Omitted fields preserve encrypted state. Read
//! projections never include credential values, masks or signed URL queries.
use super::*;
use providers::SourceConfig;
use serde_json::Map;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    expected_revision: String,
    name: Option<String>,
    config: Option<Map<String, Value>>,
}
pub(crate) fn revision(value: &str) -> Result<i64> {
    let parsed = value
        .parse::<i64>()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    if parsed <= 0 || parsed == i64::MAX || parsed.to_string() != value {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_source"));
    }
    Ok(parsed)
}
pub(crate) fn name(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 100 || value.chars().any(char::is_control) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_source"));
    }
    Ok(value.into())
}
fn manageable(row: &sqlx::postgres::PgRow) -> Result<()> {
    if row.get::<Uuid, _>("library_id") != Uuid::from_u128(1)
        || !matches!(
            row.get::<String, _>("kind").as_str(),
            "local" | "http" | "jellyfin" | "emby"
        )
    {
        return Err(err(StatusCode::CONFLICT, "source_managed_elsewhere"));
    }
    Ok(())
}
pub(crate) fn safe_detail(row: &sqlx::postgres::PgRow, config: &SourceConfig) -> Value {
    let url_redacted = !config.url.is_empty()
        && providers::validate_url(&config.url)
            .map(|url| url.query().is_some() || url.fragment().is_some())
            .unwrap_or(true);
    let mut visible = json!({"root":config.root,"user_id":config.user_id,
        "advanced_assets":config.advanced_assets,"access_policy":config.access_policy,"s3":config.s3});
    if !url_redacted {
        visible["url"] = json!(config.url);
    }
    json!({"id":row.get::<Uuid,_>("id"),"name":row.get::<String,_>("name"),
        "kind":row.get::<String,_>("kind"),"library_id":row.get::<Uuid,_>("library_id"),
        "revision":row.get::<i64,_>("settings_revision").to_string(),
        "access_policy_revision":row.get::<i64,_>("access_policy_revision"),"config":visible,
        "credentials":{"token_configured":!config.token.is_empty(),"headers_configured":!config.headers.is_empty(),
            "header_names":config.headers.keys().collect::<Vec<_>>(),"url_configured":!config.url.is_empty(),"url_redacted":url_redacted}})
}
pub(crate) fn parse_config(raw: &Value) -> Result<SourceConfig> {
    serde_json::from_value(raw.clone()).map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))
}
pub(crate) fn merge_config(
    kind: &str,
    current: &Value,
    patch: &Map<String, Value>,
) -> Result<Value> {
    let mut next = current.clone();
    let object = next
        .as_object_mut()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    for (key, value) in patch {
        let allowed = match kind {
            "local" => key == "root",
            "http" => matches!(
                key.as_str(),
                "url" | "headers" | "advanced_assets" | "access_policy"
            ),
            "jellyfin" | "emby" => matches!(
                key.as_str(),
                "url" | "user_id" | "token" | "headers" | "access_policy"
            ),
            "s3" => matches!(key.as_str(), "url" | "s3" | "access_policy"),
            _ => false,
        };
        if !allowed
            || (value.is_null() && !matches!(key.as_str(), "advanced_assets" | "access_policy"))
        {
            return Err(err(StatusCode::BAD_REQUEST, "invalid_source"));
        }
        object.insert(key.clone(), value.clone());
    }
    parse_config(&next)?;
    Ok(next)
}
pub(crate) fn validate_config(kind: &str, config: &SourceConfig) -> Result<()> {
    if kind == "local" {
        let root = std::env::var("MEDIA_ROOT").unwrap_or("/media".into());
        let allowed = std::path::Path::new(&root)
            .canonicalize()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "media_root_unavailable"))?;
        let candidate = std::path::Path::new(&config.root)
            .canonicalize()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "source_root_unavailable"))?;
        if !candidate.starts_with(allowed) {
            return Err(err(StatusCode::FORBIDDEN, "outside_media_root"));
        }
    } else {
        providers::access_policy::SourceAccess::new(&config.url, config.access_policy.as_ref())
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source_url"))?;
    }
    providers::validate_source_headers(&config.headers)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    if let Some(assets) = &config.advanced_assets {
        assets
            .validate()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    }
    Ok(())
}
// Pin admin/login authority before source locks. Recheck expiry at commit.
async fn lock_admin(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: &User,
    h: &HeaderMap,
) -> Result<()> {
    let login = media_authorization::login_hash(h)?;
    let role: Option<bool> = sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM account_exits WHERE user_id=$1) FOR SHARE")
        .bind(user.id).fetch_optional(&mut **tx).await?;
    if role != Some(true) {
        return Err(err(StatusCode::FORBIDDEN, "admin_required"));
    }
    let live: Option<Uuid> = sqlx::query_scalar("SELECT user_id FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE")
        .bind(login).bind(user.id).fetch_optional(&mut **tx).await?;
    if live.is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    Ok(())
}
pub async fn get(State(app): State<App>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    admin(&user)?;
    let mut tx = app.db.begin().await?;
    lock_admin(&mut tx, &user, &h).await?;
    let row = sqlx::query("SELECT * FROM sources WHERE id=$1 FOR SHARE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    manageable(&row)?;
    let config = parse_config(&app.decrypt(&row.get::<String, _>("config_encrypted"))?)?;
    let value = safe_detail(&row, &config);
    tx.commit().await?;
    Ok(responses::ok_json(value))
}
pub async fn change(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Change>,
) -> Result<Response> {
    let user = auth(&app, &h, true).await?;
    admin(&user)?;
    let expected = revision(&body.expected_revision)?;
    let mut tx = app.db.begin().await?;
    lock_admin(&mut tx, &user, &h).await?;
    let row = sqlx::query("SELECT * FROM sources WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    manageable(&row)?;
    if row.get::<i64, _>("settings_revision") != expected {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    let kind: String = row.get("kind");
    let old_raw = app.decrypt(&row.get::<String, _>("config_encrypted"))?;
    let old = parse_config(&old_raw)?;
    let next_raw = match body.config {
        Some(patch) => merge_config(&kind, &old_raw, &patch)?,
        None => old_raw,
    };
    let next = parse_config(&next_raw)?;
    let config_changed = serde_json::to_value(&old).map_err(anyhow::Error::from)?
        != serde_json::to_value(&next).map_err(anyhow::Error::from)?;
    let next_name = body
        .name
        .as_deref()
        .map(name)
        .transpose()?
        .unwrap_or_else(|| row.get("name"));
    if config_changed {
        validate_config(&kind, &next)?;
        if kind == "http" && next.url != old.url {
            // HTTP sources index one URL. Move its existing media identity so
            // playlist/history/title references survive the connection edit.
            let collision: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_items WHERE source_id=$1 AND resource=$2) AND EXISTS(SELECT 1 FROM media_items WHERE source_id=$1 AND resource=$3)")
                .bind(id).bind(&next.url).bind(&old.url).fetch_one(&mut *tx).await?;
            if collision {
                return Err(err(StatusCode::CONFLICT, "source_changed"));
            }
            sqlx::query("UPDATE media_items SET resource=$3,metadata='{}'::jsonb,duration_ms=NULL,source_version=NULL WHERE source_id=$1 AND resource=$2")
                .bind(id).bind(&old.url).bind(&next.url).execute(&mut *tx).await?;
        } else if (kind == "local" && next.root != old.root)
            || (matches!(kind.as_str(), "jellyfin" | "emby")
                && (next.url != old.url || next.user_id != old.user_id))
        {
            // Old keys may mean different media at the new catalog. Require a
            // scan before reuse, retaining IDs and every relationship.
            sqlx::query("UPDATE media_items SET available=false WHERE source_id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }
    // Encryption is randomized: preserve ciphertext for semantic no-op saves.
    let encrypted = if config_changed {
        app.encrypt(&next_raw)?
    } else {
        row.get("config_encrypted")
    };
    let updated =
        sqlx::query("UPDATE sources SET name=$2,config_encrypted=$3 WHERE id=$1 RETURNING *")
            .bind(id)
            .bind(next_name)
            .bind(encrypted)
            .fetch_one(&mut *tx)
            .await?;
    let mut value = safe_detail(&updated, &next);
    value["config_changed"] = json!(config_changed);
    value["rescan_required"] = json!(config_changed);
    lock_admin(&mut tx, &user, &h).await?;
    tx.commit().await?;
    let committed = source_access::CommittedSourceChange::new(id, value, config_changed);
    Ok(responses::ok_json(committed.response(&app.db).await))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revision_and_name_are_bounded() {
        assert!(revision("1").is_ok());
        for value in ["0", "-1", "01", "+1", " 1", "9223372036854775807"] {
            assert!(revision(value).is_err());
        }
        assert_eq!(name("  Movies  ").unwrap(), "Movies");
        for value in ["", "  ", "line\nbreak"] {
            assert!(name(value).is_err());
        }
        assert!(name(&"片".repeat(101)).is_err());
    }
    #[test]
    fn omitted_credentials_and_unrelated_configuration_survive() {
        let current = json!({"url":"https://example.test","token":"secret","headers":{"Authorization":"secret"},"future_field":{"keep":true}});
        let patch = json!({"user_id":"new"});
        let merged = merge_config("emby", &current, patch.as_object().unwrap()).unwrap();
        for key in ["token", "headers", "future_field"] {
            assert_eq!(merged[key], current[key]);
        }
        let clear = json!({"token":"","headers":{}});
        let merged = merge_config("emby", &current, clear.as_object().unwrap()).unwrap();
        assert_eq!(merged["token"], "");
        assert_eq!(merged["headers"], json!({}));
    }
    #[test]
    fn optional_declarations_clear_but_wrong_kind_or_null_secrets_fail() {
        let current = json!({"url":"https://example.test","advanced_assets":{"schema_version":1,"subtitles":[],"fonts":[]}});
        let clear = json!({"advanced_assets":null});
        assert_eq!(
            merge_config("http", &current, clear.as_object().unwrap()).unwrap()["advanced_assets"],
            Value::Null
        );
        for (kind, patch) in [
            ("local", json!({"url":"https://example.test"})),
            ("http", json!({"token":"x"})),
            ("emby", json!({"token":null})),
            ("http", json!({"headers":null})),
            ("http", json!({"agent_id":"x"})),
        ] {
            assert!(merge_config(kind, &current, patch.as_object().unwrap()).is_err());
        }
    }
}
