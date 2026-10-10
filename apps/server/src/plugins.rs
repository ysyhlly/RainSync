//! A closed declarative plugin catalog, not a remote-code/ABI loader.
//! Two deterministic metadata extensions need only explicitly granted read access.
//! Version/config snapshots, CAS revisions and one-step rollback are persisted.
use crate::*;
const IDS: [&str; 2] = ["metadata.duration-badge", "metadata.title-label"];
const VERSIONS: [&str; 2] = ["1.0.0", "1.1.0"];
const PERMISSION: &str = "metadata:read";
fn valid_id(id: &str) -> bool {
    IDS.contains(&id)
}
fn digest(id: &str, version: &str) -> String {
    // Stable closed-catalog identities, seeded from the accepted LF source.
    // Stored historical digests remain provenance; these are not runtime grants.
    match (id, version) {
        ("metadata.duration-badge", "1.0.0") => {
            "e1a0375faf6224d349a4e34753cb316cc36c51784c3317730d301a526d572674"
        }
        ("metadata.duration-badge", "1.1.0") => {
            "68d99aa06af5314143bd35da49fc781ba0ddc0a5fc3b0812636b5774bea37532"
        }
        ("metadata.title-label", "1.0.0") => {
            "17328d7f21af07f28fd0a0596fb5174bec7c90cdb93d65b9d3ab52dae2a0ff63"
        }
        ("metadata.title-label", "1.1.0") => {
            "ac5972556afc0dd927683b49097336e9a42078755313591682e384e9d74a29bb"
        }
        _ => unreachable!("validated closed-catalog id and version"),
    }
    .to_owned()
}
fn config_valid(id: &str, version: &str, config: &Value, grants: &[String]) -> bool {
    if !valid_id(id) || !VERSIONS.contains(&version) || grants != [PERMISSION] {
        return false;
    }
    let Some(map) = config.as_object() else {
        return false;
    };
    if map.len() != 1 {
        return false;
    }
    match id{
 "metadata.duration-badge"=>matches!(config["format"].as_str(),Some("minutes"|"clock")),
 "metadata.title-label"=>config["label"].as_str().is_some_and(|s| !s.trim().is_empty()&&s.chars().count()<=40&&!s.chars().any(|c|c.is_control()||matches!(c,'\u{2028}'|'\u{2029}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'))),
 _=>false
 }
}
fn manifest(id: &str) -> Value {
    json!({"id":id,"name":if id==IDS[0]{"时长标签"}else{"影片说明标签"},"versions":VERSIONS.iter().map(|v|json!({"version":v,"artifact_digest":digest(id,v)})).collect::<Vec<_>>(),"api_major":1,"min_api_minor":0,"extension_points":["metadata"],"requested_permissions":[PERMISSION],"isolation":"closed_declarative","trusted_operator_catalog":true,"limits":{"max_return_bytes":4096,"max_extensions":2,"max_label_chars":100},"description":if id==IDS[0]{"根据真实媒体时长生成展示标签，不改写原媒体数据"}else{"为媒体信息增加管理员设置的纯文字说明，不执行代码"}})
}
fn installed(row: &sqlx::postgres::PgRow) -> Value {
    json!({"id":row.get::<String,_>("id"),"version":row.get::<String,_>("version"),"enabled":row.get::<bool,_>("enabled"),"config":row.get::<Value,_>("config"),"granted_permissions":row.get::<Value,_>("granted_permissions"),"revision":row.get::<i64,_>("revision").to_string(),"artifact_digest":row.get::<String,_>("artifact_digest"),"can_rollback":row.get::<Option<Value>,_>("previous_state").is_some()})
}
pub async fn catalog(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    let user = identity::request::authenticate(app.identity_context(), &h, false, false).await?;
    admin(&user)?;
    let rows = sqlx::query("SELECT * FROM rainsync_plugins ORDER BY id")
        .fetch_all(&app.db)
        .await?;
    Ok(responses::ok_json(
        json!({"api_major":1,"api_minor":0,"catalog":IDS.iter().map(|id|manifest(id)).collect::<Vec<_>>(),"installed":rows.iter().filter(|r| !r.get::<bool,_>("removed")).map(installed).collect::<Vec<_>>(),"configuration_revisions":rows.iter().map(|r|(r.get::<String,_>("id"),json!(r.get::<i64,_>("revision").to_string()))).collect::<serde_json::Map<String,Value>>(),"runtime_boundary":"仅运行编译进应用的封闭声明式扩展，无远程脚本、网络、文件、数据库或凭据权限"}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    version: String,
    enabled: bool,
    config: Value,
    granted_permissions: Vec<String>,
    expected_revision: String,
}
fn revision(value: &str) -> Result<i64> {
    value
        .parse::<i64>()
        .ok()
        .filter(|v| *v >= 0 && *v < i64::MAX && value.chars().all(|c| c.is_ascii_digit()))
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "plugin_revision_invalid"))
}
async fn admin_login(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    h: &HeaderMap,
    user: Uuid,
) -> Result<String> {
    let current_admin: bool = sqlx::query_scalar("SELECT admin FROM users WHERE id=$1 FOR SHARE")
        .bind(user)
        .fetch_one(&mut **tx)
        .await?;
    if !current_admin {
        return Err(err(StatusCode::FORBIDDEN, "admin_required"));
    }
    let login = hash(&cookie(h).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))?);
    let row=sqlx::query("SELECT csrf,expires_at>clock_timestamp() AS live FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR SHARE").bind(&login).bind(user).fetch_optional(&mut **tx).await?.ok_or_else(||err(StatusCode::UNAUTHORIZED,"session_expired"))?;
    if !row.get::<bool, _>("live") {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    if h.get("x-csrf-token").and_then(|v| v.to_str().ok())
        != Some(row.get::<String, _>("csrf").as_str())
    {
        return Err(err(StatusCode::FORBIDDEN, "csrf_rejected"));
    }
    Ok(login)
}
async fn commit(
    mut tx: sqlx::Transaction<'_, sqlx::Postgres>,
    login: &str,
    user: Uuid,
) -> Result<()> {
    let live:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())").bind(login).bind(user).fetch_one(&mut *tx).await?;
    if !live {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    tx.commit().await?;
    Ok(())
}
pub async fn configure(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Change>,
) -> Result<Response> {
    if !config_valid(&id, &body.version, &body.config, &body.granted_permissions) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "plugin_manifest_or_permissions_invalid",
        ));
    }
    let expected = revision(&body.expected_revision)?;
    let user = identity::request::authenticate(app.identity_context(), &h, true, false).await?;
    admin(&user)?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("rainsync:plugin:{id}"))
        .execute(&mut *tx)
        .await?;
    let previous = sqlx::query("SELECT * FROM rainsync_plugins WHERE id=$1 FOR UPDATE")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?;
    let actual = previous
        .as_ref()
        .map(|r| r.get::<i64, _>("revision"))
        .unwrap_or(0);
    if actual != expected {
        return Err(err(StatusCode::CONFLICT, "plugin_revision_conflict"));
    }
    let login = admin_login(&mut tx, &h, user.id).await?;
    if let Some(row) = &previous
        && !row.get::<bool, _>("removed")
        && row.get::<String, _>("version") == body.version
        && row.get::<bool, _>("enabled") == body.enabled
        && row.get::<Value, _>("config") == body.config
        && row.get::<Value, _>("granted_permissions") == json!(body.granted_permissions)
    {
        // Preserve the last meaningful rollback snapshot and CAS receipt.
        let result = installed(row);
        commit(tx, &login, user.id).await?;
        return Ok(responses::ok_json(result));
    }
    let action = if let Some(r) = &previous {
        if r.get::<bool, _>("removed") {
            "install"
        } else if r.get::<String, _>("version") != body.version {
            "upgrade"
        } else if r.get::<bool, _>("enabled") != body.enabled {
            if body.enabled { "enable" } else { "disable" }
        } else {
            "configure"
        }
    } else {
        "install"
    };
    let previous=previous.as_ref().filter(|r| !r.get::<bool,_>("removed")).map(|r|json!({"version":r.get::<String,_>("version"),"enabled":r.get::<bool,_>("enabled"),"config":r.get::<Value,_>("config"),"granted_permissions":r.get::<Value,_>("granted_permissions")}));
    let artifact = digest(&id, &body.version);
    sqlx::query("INSERT INTO rainsync_plugins(id,version,enabled,config,granted_permissions,revision,artifact_digest,previous_state,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET removed=false,version=EXCLUDED.version,enabled=EXCLUDED.enabled,config=EXCLUDED.config,granted_permissions=EXCLUDED.granted_permissions,revision=EXCLUDED.revision,artifact_digest=EXCLUDED.artifact_digest,previous_state=EXCLUDED.previous_state,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()")
 .bind(&id).bind(&body.version).bind(body.enabled).bind(body.config).bind(json!(body.granted_permissions)).bind(actual+1).bind(&artifact).bind(previous).bind(user.id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO rainsync_plugin_audit(id,plugin_id,actor_id,revision,action,artifact_digest) VALUES($1,$2,$3,$4,$5,$6)").bind(Uuid::new_v4()).bind(&id).bind(user.id).bind(actual+1).bind(action).bind(artifact).execute(&mut *tx).await?;
    let row = sqlx::query("SELECT * FROM rainsync_plugins WHERE id=$1")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    let result = installed(&row);
    commit(tx, &login, user.id).await?;
    Ok(responses::ok_json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rollback {
    expected_revision: String,
}
/// Remove operator configuration, not the compiled-in catalog entry. A bounded
/// tombstone preserves CAS across reinstall and keeps foreign-keyed audit facts.
pub async fn remove(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Rollback>,
) -> Result<Response> {
    if !valid_id(&id) {
        return Err(err(StatusCode::NOT_FOUND, "plugin_not_found"));
    }
    let expected = revision(&body.expected_revision)?;
    let user = identity::request::authenticate(app.identity_context(), &h, true, false).await?;
    admin(&user)?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("rainsync:plugin:{id}"))
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT * FROM rainsync_plugins WHERE id=$1 FOR UPDATE")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "plugin_not_found"))?;
    let actual: i64 = row.get("revision");
    if actual != expected {
        return Err(err(StatusCode::CONFLICT, "plugin_revision_conflict"));
    }
    let login = admin_login(&mut tx, &h, user.id).await?;
    // A repeated remove of the current tombstone is harmless and must not
    // manufacture additional audit events or revisions.
    let removed_revision = if row.get::<bool, _>("removed") {
        actual
    } else {
        sqlx::query("UPDATE rainsync_plugins SET removed=true,enabled=false,config='{}'::jsonb,granted_permissions='[]'::jsonb,previous_state=NULL,revision=$2,updated_by=$3,updated_at=clock_timestamp() WHERE id=$1")
            .bind(&id).bind(actual+1).bind(user.id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO rainsync_plugin_audit(id,plugin_id,actor_id,revision,action,artifact_digest) VALUES($1,$2,$3,$4,'remove',$5)")
            .bind(Uuid::new_v4()).bind(&id).bind(user.id).bind(actual+1).bind(row.get::<String,_>("artifact_digest")).execute(&mut *tx).await?;
        actual + 1
    };
    commit(tx, &login, user.id).await?;
    Ok(responses::ok_json(
        json!({"id":id,"removed":true,"revision":removed_revision.to_string()}),
    ))
}
pub async fn rollback(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Rollback>,
) -> Result<Response> {
    if !valid_id(&id) {
        return Err(err(StatusCode::NOT_FOUND, "plugin_not_found"));
    }
    let expected = revision(&body.expected_revision)?;
    let user = identity::request::authenticate(app.identity_context(), &h, true, false).await?;
    admin(&user)?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("rainsync:plugin:{id}"))
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT * FROM rainsync_plugins WHERE id=$1 FOR UPDATE")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "plugin_not_found"))?;
    let actual: i64 = row.get("revision");
    if actual != expected {
        return Err(err(StatusCode::CONFLICT, "plugin_revision_conflict"));
    }
    if row.get::<bool, _>("removed") {
        return Err(err(StatusCode::CONFLICT, "plugin_no_rollback"));
    }
    let prior: Value = row
        .get::<Option<Value>, _>("previous_state")
        .ok_or_else(|| err(StatusCode::CONFLICT, "plugin_no_rollback"))?;
    let version = prior["version"]
        .as_str()
        .ok_or_else(|| err(StatusCode::CONFLICT, "plugin_rollback_invalid"))?;
    let grants: Vec<String> = serde_json::from_value(prior["granted_permissions"].clone())
        .map_err(|_| err(StatusCode::CONFLICT, "plugin_rollback_invalid"))?;
    if !config_valid(&id, version, &prior["config"], &grants) || !prior["enabled"].is_boolean() {
        return Err(err(StatusCode::CONFLICT, "plugin_rollback_invalid"));
    }
    let login = admin_login(&mut tx, &h, user.id).await?;
    let artifact = digest(&id, version);
    sqlx::query("UPDATE rainsync_plugins SET version=$2,enabled=$3,config=$4,granted_permissions=$5,revision=$6,artifact_digest=$7,previous_state=NULL,updated_by=$8,updated_at=clock_timestamp() WHERE id=$1")
 .bind(&id).bind(version).bind(prior["enabled"].as_bool().unwrap()).bind(&prior["config"]).bind(json!(grants)).bind(actual+1).bind(&artifact).bind(user.id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO rainsync_plugin_audit(id,plugin_id,actor_id,revision,action,artifact_digest) VALUES($1,$2,$3,$4,'rollback',$5)").bind(Uuid::new_v4()).bind(&id).bind(user.id).bind(actual+1).bind(artifact).execute(&mut *tx).await?;
    let row = sqlx::query("SELECT * FROM rainsync_plugins WHERE id=$1")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    let result = installed(&row);
    commit(tx, &login, user.id).await?;
    Ok(responses::ok_json(result))
}
fn transform(id: &str, version: &str, config: &Value, media: &Value) -> Option<Value> {
    match id {
        "metadata.duration-badge" => {
            let duration = media["duration_ms"]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 604800000.0)?;
            let seconds = (duration / 1000.0).floor() as u64;
            let label = if config["format"] == "clock" {
                format!(
                    "{}:{:02}:{:02}",
                    seconds / 3600,
                    (seconds / 60) % 60,
                    seconds % 60
                )
            } else {
                format!("{} 分钟", (duration / 60000.0).ceil() as u64)
            };
            Some(json!({"kind":"duration","label":label,"extension_version":version}))
        }
        "metadata.title-label" => {
            let label = config["label"].as_str()?;
            Some(json!({"kind":"annotation","label":label,"extension_version":version}))
        }
        _ => None,
    }
}
pub async fn metadata(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let user = identity::request::authenticate(app.identity_context(), &h, false, false).await?;
    // Existing authoritative catalog visibility/ACL remains the only media grant.
    let media = media_titles::read(&app, user.id, id).await?;
    let rows=sqlx::query("SELECT id,version,config,granted_permissions,revision FROM rainsync_plugins WHERE enabled AND NOT removed ORDER BY id LIMIT 2").fetch_all(&app.db).await?;
    let mut output = Vec::new();
    for row in rows {
        let plugin: String = row.get("id");
        let version: String = row.get("version");
        let config: Value = row.get("config");
        let grants: Vec<String> =
            serde_json::from_value(row.get("granted_permissions")).map_err(anyhow::Error::from)?;
        if config_valid(&plugin, &version, &config, &grants)
            && let Some(mut item) = transform(&plugin, &version, &config, &media)
        {
            item["plugin_id"] = json!(plugin);
            item["revision"] = json!(row.get::<i64, _>("revision").to_string());
            output.push(item);
        }
    }
    // A late ACL/source change during the installed-plugin lookup cannot reuse
    // the first authorized metadata snapshot. There is no per-user metadata cache.
    let latest = media_titles::read(&app, user.id, id).await?;
    if latest != media {
        return Err(err(StatusCode::CONFLICT, "plugin_media_changed"));
    }
    Ok(responses::ok_json(
        json!({"media_id":id,"extensions":output,"api_major":1}),
    ))
}
pub async fn audit(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    let user = identity::request::authenticate(app.identity_context(), &h, false, false).await?;
    admin(&user)?;
    let rows=sqlx::query("SELECT id,plugin_id,revision,action,artifact_digest,floor(extract(epoch FROM created_at)*1000)::bigint AS at_ms FROM rainsync_plugin_audit ORDER BY created_at DESC,id DESC LIMIT 100").fetch_all(&app.db).await?;
    Ok(responses::ok_json(
        json!({"items":rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"plugin_id":r.get::<String,_>("plugin_id"),"revision":r.get::<i64,_>("revision").to_string(),"action":r.get::<String,_>("action"),"artifact_digest":r.get::<String,_>("artifact_digest"),"created_at":r.get::<i64,_>("at_ms")})).collect::<Vec<_>>()}),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_cannot_grant_code_network_secrets_or_incompatible_api() {
        for permission in [
            "network:*",
            "secrets:source_handle",
            "filesystem:*",
            "execute",
        ] {
            assert!(!config_valid(
                IDS[0],
                "1.0.0",
                &json!({"format":"clock"}),
                &[permission.into()]
            ));
        }
        assert!(!config_valid(
            IDS[0],
            "2.0.0",
            &json!({"format":"clock"}),
            &[PERMISSION.into()]
        ));
        assert!(!config_valid(
            "remote.script",
            "1.0.0",
            &json!({"url":"https://example.test"}),
            &[PERMISSION.into()]
        ));
        assert!(!config_valid(
            IDS[0],
            "1.0.0",
            &json!({"format":"clock","script":"eval"}),
            &[PERMISSION.into()]
        ));
    }
    #[test]
    fn metadata_is_pure_bounded_and_markup_is_only_text() {
        let output = transform(
            IDS[0],
            "1.0.0",
            &json!({"format":"clock"}),
            &json!({"duration_ms":3661000}),
        )
        .unwrap();
        assert_eq!(output["label"], "1:01:01");
        assert!(
            transform(
                IDS[0],
                "1.0.0",
                &json!({"format":"clock"}),
                &json!({"duration_ms":-1})
            )
            .is_none()
        );
        assert!(!config_valid(
            IDS[1],
            "1.0.0",
            &json!({"label":"x\n"}),
            &[PERMISSION.into()]
        ));
        assert!(config_valid(
            IDS[1],
            "1.0.0",
            &json!({"label":"<script>text</script>"}),
            &[PERMISSION.into()]
        ));
    }
}
