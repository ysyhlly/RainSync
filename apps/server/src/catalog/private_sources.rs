//! Named private sources use cases; transaction ownership stays here.
use super::libraries::{name, revision};
use super::library_authority::*;
use super::source_rules as source_settings;
use super::*;
use crate::identity::{
    RequestContext,
    request::{self, admin},
};

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
    request: RequestContext<'_>,
    encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync),
    h: HeaderMap,
    id: Uuid,
    mut body: Source,
) -> Result<Value> {
    let db = request.db;
    require_enabled()?;
    let u = request::authenticate(request, &h, true, false).await?;
    let context = SourceWriteContext { db, encrypt };
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
    request: RequestContext<'_>,
    decrypt: &(dyn Fn(&str) -> anyhow::Result<Value> + Sync),
    h: HeaderMap,
    library: Uuid,
    source: Uuid,
) -> Result<Value> {
    let db = request.db;
    let u = request::authenticate(request, &h, false, false).await?;
    let context = SourceReadContext { db, decrypt };
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
    request: RequestContext<'_>,
    encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync),
    decrypt: &(dyn Fn(&str) -> anyhow::Result<Value> + Sync),
    h: HeaderMap,
    library: Uuid,
    source: Uuid,
    body: SourceChange,
) -> Result<Value> {
    let db = request.db;
    require_enabled()?;
    let u = request::authenticate(request, &h, true, false).await?;
    let context = SourceChangeContext {
        db,
        encrypt,
        decrypt,
    };
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
    Ok(committed.response(db).await)
}

pub(crate) async fn remove_source(
    request: RequestContext<'_>,
    encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync),
    h: HeaderMap,
    library: Uuid,
    source: Uuid,
    body: SourceExpected,
) -> Result<Value> {
    let db = request.db;
    let u = request::authenticate(request, &h, true, false).await?;
    let context = SourceWriteContext { db, encrypt };
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
    Ok(committed.response(db).await)
}

pub(crate) async fn attach_source(
    request: RequestContext<'_>,
    h: HeaderMap,
    id: Uuid,
    body: Attach,
) -> Result<Value> {
    let db = request.db;
    require_enabled()?;
    let u = request::authenticate(request, &h, true, false).await?;
    admin(&u)?;
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
    Ok(committed.response(db).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A closed, lazily constructed pool cannot acquire a connection. These
    // checks cover pre-database admission only, not live-session or lock races.
    async fn closed_pool() -> PgPool {
        let db = sqlx::postgres::PgPoolOptions::new()
            .min_connections(0)
            .connect_lazy("postgres://unused:unused@localhost/unused")
            .unwrap();
        db.close().await;
        db
    }

    fn assert_login_required(result: Result<Value>) {
        let failure = result.unwrap_err();
        assert_eq!(failure.0, StatusCode::UNAUTHORIZED);
        assert_eq!(failure.1, "login_required");
    }

    fn assert_gated_login_required(result: Result<Value>) {
        let failure = result.unwrap_err();
        let (status, reason) = if enabled() {
            (StatusCode::UNAUTHORIZED, "login_required")
        } else {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "private_libraries_disabled",
            )
        };
        assert_eq!(failure.0, status);
        assert_eq!(failure.1, reason);
    }

    #[tokio::test]
    async fn private_source_reads_and_removal_admit_before_database_or_cipher() {
        let db = closed_pool().await;
        let request = || RequestContext {
            db: &db,
            origin: "https://rainsync.example",
        };
        let encrypt = |_: &Value| -> anyhow::Result<String> {
            panic!("admission must reject before encryption")
        };
        let decrypt = |_: &str| -> anyhow::Result<Value> {
            panic!("admission must reject before decryption")
        };
        assert_login_required(
            source_detail(
                request(),
                &decrypt,
                HeaderMap::new(),
                Uuid::nil(),
                Uuid::nil(),
            )
            .await,
        );
        assert_login_required(
            remove_source(
                request(),
                &encrypt,
                HeaderMap::new(),
                Uuid::nil(),
                Uuid::nil(),
                SourceExpected {
                    expected_revision: "invalid".into(),
                    expected_library_revision: "invalid".into(),
                },
            )
            .await,
        );
    }

    #[tokio::test]
    async fn private_source_gated_writes_admit_before_business_validation_or_cipher() {
        let db = closed_pool().await;
        let request = || RequestContext {
            db: &db,
            origin: "https://rainsync.example",
        };
        let encrypt = |_: &Value| -> anyhow::Result<String> {
            panic!("admission must reject before encryption")
        };
        let decrypt = |_: &str| -> anyhow::Result<Value> {
            panic!("admission must reject before decryption")
        };
        assert_gated_login_required(
            add_source(
                request(),
                &encrypt,
                HeaderMap::new(),
                Uuid::nil(),
                Source {
                    name: "".into(),
                    kind: "invalid".into(),
                    config: serde_json::from_value(json!({})).unwrap(),
                },
            )
            .await,
        );
        assert_gated_login_required(
            update_source(
                request(),
                &encrypt,
                &decrypt,
                HeaderMap::new(),
                Uuid::nil(),
                Uuid::nil(),
                SourceChange {
                    expected_revision: "invalid".into(),
                    name: None,
                    config: None,
                },
            )
            .await,
        );
        assert_gated_login_required(
            attach_source(
                request(),
                HeaderMap::new(),
                Uuid::nil(),
                Attach {
                    source_id: Uuid::nil(),
                    expected_revision: "invalid".into(),
                },
            )
            .await,
        );
    }

    #[test]
    fn private_source_keeps_distinct_library_and_source_validation_contracts() {
        assert_eq!(revision("01").unwrap(), 1);
        assert_eq!(source_settings::revision("1").unwrap(), 1);
        assert_eq!(
            source_settings::revision("01").unwrap_err().1,
            "invalid_source"
        );
        for invalid in ["", "0", "-1", " 1", "1 ", "9223372036854775807"] {
            assert_eq!(revision(invalid).unwrap_err().1, "library_invalid");
            assert_eq!(
                source_settings::revision(invalid).unwrap_err().1,
                "invalid_source"
            );
        }
        assert_eq!(name(" ").unwrap_err().1, "library_invalid");
        assert_eq!(source_settings::name(" ").unwrap_err().1, "invalid_source");
        assert_eq!(name("  source  ").unwrap(), "source");
        assert_eq!(source_settings::name("  source  ").unwrap(), "source");
    }

    #[test]
    fn private_source_wire_dtos_still_reject_unknown_fields() {
        let source = json!({"name":"source","kind":"http","config":{}});
        let change = json!({"expected_revision":"1"});
        let expected = json!({"expected_revision":"1","expected_library_revision":"01"});
        let attach = json!({"source_id":Uuid::nil(),"expected_revision":"01"});
        assert!(serde_json::from_value::<Source>(source.clone()).is_ok());
        assert!(serde_json::from_value::<SourceChange>(change.clone()).is_ok());
        assert!(serde_json::from_value::<SourceExpected>(expected.clone()).is_ok());
        assert!(serde_json::from_value::<Attach>(attach.clone()).is_ok());
        let extra = |mut value: Value| {
            value["unexpected"] = json!(true);
            value
        };
        assert!(serde_json::from_value::<Source>(extra(source)).is_err());
        assert!(serde_json::from_value::<SourceChange>(extra(change)).is_err());
        assert!(serde_json::from_value::<SourceExpected>(extra(expected)).is_err());
        assert!(serde_json::from_value::<Attach>(extra(attach)).is_err());
        assert!(serde_json::from_value::<SourceChange>(json!({"expected_revision":1})).is_err());
    }
}
