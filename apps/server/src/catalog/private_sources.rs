//! Named private sources use cases; transaction ownership stays here.
use super::libraries::{name, revision};
use super::library_authority::*;
use super::source_rules as source_settings;
use super::*;
use crate::identity::request::admin;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    name: String,
    kind: String,
    config: providers::SourceConfig,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceChange {
    expected_revision: String,
    name: Option<String>,
    config: Option<serde_json::Map<String, Value>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceExpected {
    expected_revision: String,
    expected_library_revision: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attach {
    source_id: Uuid,
    expected_revision: String,
}

fn manageable_scoped_source(row: &sqlx::postgres::PgRow) -> Result<()> {
    if !matches!(row.get::<String, _>("kind").as_str(), "http" | "s3") {
        return Err(err(StatusCode::CONFLICT, "source_managed_elsewhere"));
    }
    Ok(())
}

pub(crate) async fn add_source(
    context: SourceWriteContext<'_>,
    u: User,
    h: HeaderMap,
    id: Uuid,
    mut body: Source,
) -> Result<Value> {
    if !matches!(body.kind.as_str(), "http" | "s3") {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_source"));
    }
    let name = name(&body.name)?;
    if !u.admin && body.kind == "http" {
        if body.config.access_policy.is_some()
            || body.config.advanced_assets.is_some()
            || !body.config.root.is_empty()
            || !body.config.token.is_empty()
            || !body.config.user_id.is_empty()
            || !body.config.agent_id.is_empty()
        {
            return Err(err(StatusCode::FORBIDDEN, "admin_required"));
        }
        body.config.access_policy = Some(
            providers::access_policy::SourceAccessPolicy::public_origin(&body.config.url)
                .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source_url"))?,
        );
    }
    if body.kind == "s3" {
        // Credential environment bindings belong to the trusted operator. A
        // library owner cannot pick another owner's already-provisioned secret.
        admin(&u)?;
        providers::s3::validate_config(&body.config)
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    } else if body.config.s3.is_some() {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_source"));
    }
    providers::access_policy::SourceAccess::new(
        &body.config.url,
        body.config.access_policy.as_ref(),
    )
    .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source_url"))?;
    providers::validate_source_headers(&body.config.headers)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    let mut tx = context.db.begin().await?;
    lock_caller(&mut tx, &u, &h, u.admin).await?;
    let allowed:Option<Uuid>=sqlx::query_scalar("SELECT id FROM private_libraries WHERE id=$1 AND library_allowed($2,id,'manage') FOR UPDATE").bind(id).bind(u.id).fetch_optional(&mut *tx).await?;
    if allowed.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "library_not_found"));
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sources WHERE library_id=$1 AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if count >= 100 {
        return Err(err(StatusCode::CONFLICT, "library_source_limit"));
    }
    let source = Uuid::new_v4();
    let config =
        (context.encrypt)(&serde_json::to_value(body.config).map_err(anyhow::Error::from)?)?;
    sqlx::query(
        "INSERT INTO sources(id,name,kind,config_encrypted,library_id) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(source)
    .bind(name)
    .bind(body.kind)
    .bind(config)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    advance(&mut tx, id, false).await?;
    audit(&mut tx, id, u.id, "source_created", Some(source)).await?;
    require_current_permission(&mut tx, u.id, id, "manage").await?;
    commit_caller(tx, &u, &h, u.admin).await?;
    Ok(json!({"id":source,"library_id":id}))
}

pub(crate) async fn source_detail(
    context: SourceReadContext<'_>,
    u: User,
    h: HeaderMap,
    library: Uuid,
    source: Uuid,
) -> Result<Value> {
    let mut tx = context.db.begin().await?;
    lock_caller(&mut tx, &u, &h, false).await?;
    lock_source_library(&mut tx, u.id, library).await?;
    let row = sqlx::query(
        "SELECT * FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(source)
    .bind(library)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    manageable_scoped_source(&row)?;
    let config = source_settings::parse_config(&(context.decrypt)(
        &row.get::<String, _>("config_encrypted"),
    )?)?;
    let value = source_settings::safe_detail(&row, &config);
    require_current_permission(&mut tx, u.id, library, "manage").await?;
    commit_caller(tx, &u, &h, false).await?;
    Ok(value)
}

pub(crate) async fn update_source(
    context: SourceChangeContext<'_>,
    u: User,
    h: HeaderMap,
    library: Uuid,
    source: Uuid,
    body: SourceChange,
) -> Result<CommittedLibraryChange> {
    let expected = source_settings::revision(&body.expected_revision)?;
    let operator = u.admin && body.config.is_some();
    let mut tx = context.db.begin().await?;
    lock_caller(&mut tx, &u, &h, operator).await?;
    lock_source_library(&mut tx, u.id, library).await?;
    let row = sqlx::query(
        "SELECT * FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(source)
    .bind(library)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    manageable_scoped_source(&row)?;
    if row.get::<i64, _>("settings_revision") != expected {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    let kind: String = row.get("kind");
    let old_raw = (context.decrypt)(&row.get::<String, _>("config_encrypted"))?;
    let old = source_settings::parse_config(&old_raw)?;
    let mut raw = old_raw.clone();
    if let Some(patch) = &body.config {
        if !u.admin
            && (kind == "s3"
                || patch
                    .keys()
                    .any(|key| !matches!(key.as_str(), "url" | "headers")))
        {
            return Err(err(StatusCode::FORBIDDEN, "admin_required"));
        }
        raw = source_settings::merge_config(&kind, &old_raw, patch)?;
        if !u.admin && patch.contains_key("url") {
            let url = raw["url"]
                .as_str()
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
            let policy = providers::access_policy::SourceAccessPolicy::public_origin(url)
                .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source_url"))?;
            raw["access_policy"] = serde_json::to_value(policy).map_err(anyhow::Error::from)?;
        }
    }
    let next = source_settings::parse_config(&raw)?;
    if kind == "http" && old.url != next.url {
        let same_origin = providers::validate_url(&old.url)
            .ok()
            .zip(providers::validate_url(&next.url).ok())
            .is_some_and(|(old, next)| old.origin() == next.origin());
        let explicit_headers = body
            .config
            .as_ref()
            .is_some_and(|patch| patch.contains_key("headers"));
        if !same_origin
            && ((!old.headers.is_empty() && !explicit_headers)
                || !old.token.is_empty()
                || !old.user_id.is_empty())
        {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "source_credentials_origin_changed",
            ));
        }
    }
    let changed = serde_json::to_value(&old).map_err(anyhow::Error::from)?
        != serde_json::to_value(&next).map_err(anyhow::Error::from)?;
    let next_name = body
        .name
        .as_deref()
        .map(source_settings::name)
        .transpose()?
        .unwrap_or_else(|| row.get("name"));
    if changed {
        source_settings::validate_config(&kind, &next)?;
        if kind == "s3" {
            providers::s3::validate_config(&next)
                .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
        }
        if kind == "http" && next.url != old.url {
            let collision:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_items WHERE source_id=$1 AND resource=$2) AND EXISTS(SELECT 1 FROM media_items WHERE source_id=$1 AND resource=$3)")
                .bind(source).bind(&next.url).bind(&old.url).fetch_one(&mut *tx).await?;
            if collision {
                return Err(err(StatusCode::CONFLICT, "source_changed"));
            }
            sqlx::query("UPDATE media_items SET resource=$3,metadata='{}'::jsonb,duration_ms=NULL,source_version=NULL WHERE source_id=$1 AND resource=$2")
                .bind(source).bind(&old.url).bind(&next.url).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE media_items SET available=false WHERE source_id=$1")
            .bind(source)
            .execute(&mut *tx)
            .await?;
    }
    let encrypted = if changed {
        (context.encrypt)(&raw)?
    } else {
        row.get("config_encrypted")
    };
    let updated =
        sqlx::query("UPDATE sources SET name=$2,config_encrypted=$3 WHERE id=$1 RETURNING *")
            .bind(source)
            .bind(next_name)
            .bind(encrypted)
            .fetch_one(&mut *tx)
            .await?;
    let did_change = updated.get::<i64, _>("settings_revision") != expected;
    if did_change {
        advance(&mut tx, library, false).await?;
        audit(&mut tx, library, u.id, "source_updated", Some(source)).await?;
    }
    let mut value = source_settings::safe_detail(&updated, &next);
    value["config_changed"] = json!(changed);
    value["rescan_required"] = json!(changed);
    require_current_permission(&mut tx, u.id, library, "manage").await?;
    commit_caller(tx, &u, &h, operator).await?;
    let committed = CommittedLibraryChange::new(library, value, changed);
    Ok(committed)
}

pub(crate) async fn remove_source(
    context: SourceWriteContext<'_>,
    u: User,
    h: HeaderMap,
    library: Uuid,
    source: Uuid,
    body: SourceExpected,
) -> Result<CommittedLibraryChange> {
    let mut tx = context.db.begin().await?;
    lock_caller(&mut tx, &u, &h, false).await?;
    lock_manage(
        &mut tx,
        u.id,
        library,
        revision(&body.expected_library_revision)?,
    )
    .await?;
    let row = sqlx::query(
        "SELECT * FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(source)
    .bind(library)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    manageable_scoped_source(&row)?;
    if row.get::<i64, _>("settings_revision") != source_settings::revision(&body.expected_revision)?
    {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    require_idle_sources(&mut tx, library, Some(source)).await?;
    let empty = (context.encrypt)(&json!({}))?;
    sqlx::query("UPDATE sources SET config_encrypted=$2,deleted_at=clock_timestamp() WHERE id=$1")
        .bind(source)
        .bind(empty)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE media_items SET available=false WHERE source_id=$1")
        .bind(source)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE room_media_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE library_id=$1 AND media_id IN(SELECT id FROM media_items WHERE source_id=$2)")
        .bind(library).bind(source).execute(&mut *tx).await?;
    advance(&mut tx, library, false).await?;
    audit(&mut tx, library, u.id, "source_deleted", Some(source)).await?;
    require_current_permission(&mut tx, u.id, library, "manage").await?;
    commit_caller(tx, &u, &h, false).await?;
    let committed = CommittedLibraryChange::new(library, json!({"id":source,"deleted":true}), true);
    Ok(committed)
}

pub(crate) async fn attach_source(
    db: &PgPool,
    u: User,
    h: HeaderMap,
    id: Uuid,
    body: Attach,
) -> Result<CommittedLibraryChange> {
    let mut tx = db.begin().await?;
    lock_caller(&mut tx, &u, &h, true).await?;
    // This is an explicit audited operator action. Normal private catalog reads
    // remain unavailable to an administrator without a library grant.
    let previous: Uuid =
        sqlx::query_scalar("SELECT library_id FROM sources WHERE id=$1 AND deleted_at IS NULL")
            .bind(body.source_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    sqlx::query("SELECT id FROM private_libraries WHERE id IN($1,$2) AND deleted_at IS NULL ORDER BY id FOR UPDATE")
        .bind(id)
        .bind(previous)
        .execute(&mut *tx)
        .await?;
    let lib = sqlx::query("SELECT * FROM private_libraries WHERE id=$1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "library_not_found"))?;
    if lib.get::<i64, _>("revision") != revision(&body.expected_revision)? {
        return Err(err(StatusCode::CONFLICT, "library_conflict"));
    }
    let current: Uuid = sqlx::query_scalar(
        "SELECT library_id FROM sources WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(body.source_id)
    .fetch_one(&mut *tx)
    .await?;
    if current != previous {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    if previous == id {
        return Err(err(StatusCode::CONFLICT, "source_already_attached"));
    }
    sqlx::query("UPDATE sources SET library_id=$2 WHERE id=$1")
        .bind(body.source_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    advance(&mut tx, id, true).await?;
    advance(&mut tx, previous, true).await?;
    audit(
        &mut tx,
        id,
        u.id,
        "operator_source_attached",
        Some(body.source_id),
    )
    .await?;
    audit(
        &mut tx,
        previous,
        u.id,
        "operator_source_detached",
        Some(body.source_id),
    )
    .await?;
    commit_caller(tx, &u, &h, true).await?;
    let committed = CommittedLibraryChange::new(
        id,
        json!({"ok":true,"library_id":id,"source_id":body.source_id}),
        true,
    );
    Ok(committed)
}
