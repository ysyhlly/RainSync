//! Shared-source catalog mutations. Source identity and configuration lifetime
//! remain separate from selected playback transport and resource retirement.
use super::*;
use crate::admin_settings;
use providers::SourceConfig;

pub(crate) async fn list(db: &PgPool) -> Result<Value> {
    let rows = sqlx::query("SELECT s.id,s.name,s.kind,s.library_id,s.access_policy_revision,CASE WHEN s.kind NOT IN ('jellyfin','emby') THEN NULL ELSE jsonb_build_object('state',CASE WHEN a.state='allowed' AND a.valid_until<=clock_timestamp() THEN 'unknown' ELSE COALESCE(a.state,'unknown') END,'reason',CASE WHEN a.state='allowed' AND a.valid_until<=clock_timestamp() THEN 'upstream_policy_expired' ELSE COALESCE(a.reason,'upstream_policy_unknown') END) END AS account_policy FROM sources s LEFT JOIN source_account_policies a ON a.source_id=s.id AND a.source_revision=s.access_policy_revision WHERE s.deleted_at IS NULL ORDER BY s.name")
        .fetch_all(db)
        .await?;
    Ok(Value::Array(rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"kind":r.get::<String,_>("kind"),"library_id":r.get::<Uuid,_>("library_id"),"access_policy_revision":r.get::<i64,_>("access_policy_revision"),"account_policy":r.get::<Option<Value>,_>("account_policy")})).collect()))
}
#[derive(Deserialize)]
pub struct Source {
    name: String,
    kind: String,
    config: SourceConfig,
}
pub(crate) async fn add(context: SourceWriteContext<'_>, body: Source) -> Result<Value> {
    if !["local", "http", "jellyfin", "emby", "agent"].contains(&body.kind.as_str())
        || body.name.is_empty()
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_source"));
    }
    if !matches!(body.kind.as_str(), "http" | "jellyfin" | "emby")
        && body.config.access_policy.is_some()
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_source"));
    }
    if body.kind == "local" {
        let root = std::env::var("MEDIA_ROOT").unwrap_or("/media".into());
        let allowed = std::path::Path::new(&root)
            .canonicalize()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "media_root_unavailable"))?;
        let candidate = std::path::Path::new(&body.config.root)
            .canonicalize()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "source_root_unavailable"))?;
        if !candidate.starts_with(allowed) {
            return Err(err(StatusCode::FORBIDDEN, "outside_media_root"));
        }
    }
    if ["http", "jellyfin", "emby"].contains(&body.kind.as_str()) {
        providers::access_policy::SourceAccess::new(
            &body.config.url,
            body.config.access_policy.as_ref(),
        )
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source_url"))?;
    }
    providers::validate_source_headers(&body.config.headers)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    let id = Uuid::new_v4();
    let policy_revision = i64::from(body.config.access_policy.is_some());
    let encrypted = (context.encrypt)(&serde_json::to_value(&body.config).unwrap())?;
    sqlx::query("INSERT INTO sources(id,name,kind,config_encrypted,access_policy_revision) VALUES($1,$2,$3,$4,$5)")
        .bind(id)
        .bind(body.name)
        .bind(body.kind)
        .bind(encrypted)
        .bind(policy_revision)
        .execute(context.db)
        .await?;
    Ok(json!({"id":id}))
}
pub(crate) async fn remove(db: &PgPool, user: &User, h: &HeaderMap, id: Uuid) -> Result<Value> {
    let mut tx = db.begin().await?;
    let login = admin_settings::lock_admin(&mut tx, user, h, true).await?;
    let row = sqlx::query("SELECT kind,library_id FROM sources WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(row) = row else {
        // A lost successful response can be retried without recreating state.
        admin_settings::finish(tx, user, &login).await?;
        return Ok(json!({"ok":true,"id":id}));
    };
    if row.get::<Uuid, _>("library_id") != Uuid::from_u128(1)
        || !matches!(
            row.get::<String, _>("kind").as_str(),
            "local" | "http" | "jellyfin" | "emby"
        )
    {
        // Detaching a private item would erase its library permission scope.
        // Agent sources must remain bound to device revocation and indexing.
        return Err(err(StatusCode::CONFLICT, "source_managed_elsewhere"));
    }
    // Source admission holds FOR SHARE through publication. This source lock
    // orders removal after existing grants and prevents any new grant.
    let in_use: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN media_items m ON m.id=p.media_id WHERE m.source_id=$1 AND NOT p.stopped AND p.expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM upstream_reservations WHERE source_id=$1 AND state IN('preparing','active'))")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if in_use {
        return Err(err(StatusCode::CONFLICT, "source_in_use"));
    }
    // Keep media IDs referenced by room history, playlists and old sessions.
    // Availability and source generation fence previews and stale selections.
    sqlx::query("UPDATE media_items SET available=false,source_id=NULL WHERE source_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for table in [
        "s3_index_scan_seen",
        "s3_index_scan_cursors",
        "s3_index_scans",
    ] {
        sqlx::query(&format!("DELETE FROM {table} WHERE source_id=$1"))
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    // Scan and account-policy rows cascade; retained policy snapshots still
    // permit bounded cleanup of already closing upstream reservations.
    sqlx::query("DELETE FROM sources WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    admin_settings::finish(tx, user, &login).await?;
    Ok(json!({"ok":true,"id":id}))
}
