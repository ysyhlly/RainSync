//! HTTP adaptation for private libraries. Caller and room authority remain
//! transaction-local inside named catalog operations, never cached by adapters.
use super::*;
pub use catalog::libraries::{Create, Expected, Grant, IssuedSharesQuery, Rename, Transfer};
pub use catalog::library_authority::enabled;
pub(crate) use catalog::library_authority::retire_maintenance;
use catalog::library_authority::{lock_caller, require_current_permission, require_enabled};
pub use catalog::private_sources::{Attach, Source, SourceChange, SourceExpected};
pub use catalog::room_shares::{Share, UpdateShare};

// Playback callers keep this adapter until their own context migration.
pub async fn authorize_media(
    app: &App,
    user: Uuid,
    media: Uuid,
    action: &str,
    room: Option<Uuid>,
) -> Result<()> {
    catalog::library_authority::authorize_media(&app.db, user, media, action, room).await
}

pub async fn list(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    Ok(responses::ok_json(
        catalog::libraries::list(&app.db, u).await?,
    ))
}

pub async fn issued_shares(
    State(app): State<App>,
    h: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<IssuedSharesQuery>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    Ok(responses::ok_json(
        catalog::libraries::issued_shares(&app.db, u, query).await?,
    ))
}

pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Create>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let committed = catalog::libraries::create(&app.db, u, h, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn detail(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    Ok(responses::ok_json(
        catalog::libraries::detail(&app.db, u, id).await?,
    ))
}

pub async fn rename(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Rename>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let committed = catalog::libraries::rename(&app.db, u, h, id, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn grant(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Grant>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let committed = catalog::libraries::grant(&app.db, u, h, id, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn revoke(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, target)): Path<(Uuid, Uuid)>,
    Json(body): Json<Expected>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let committed = catalog::libraries::revoke(&app.db, u, h, id, target, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn remove(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Expected>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let context = catalog::SourceWriteContext {
        db: &app.db,
        encrypt: &|value| app.encrypt(value),
    };
    let committed = catalog::libraries::remove(context, u, h, id, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn transfer(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Transfer>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let committed = catalog::libraries::transfer(&app.db, u, h, id, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn share(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Share>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    Ok(responses::ok_json(
        catalog::room_shares::share(&app.db, u, h, id, body).await?,
    ))
}

pub async fn update_share(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, grant)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateShare>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let committed = catalog::room_shares::update_share(&app.db, u, h, id, grant, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn revoke_share(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, grant)): Path<(Uuid, Uuid)>,
    Json(body): Json<Expected>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let committed = catalog::room_shares::revoke_share(&app.db, u, h, id, grant, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn add_source(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Source>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let context = catalog::SourceWriteContext {
        db: &app.db,
        encrypt: &|value| app.encrypt(value),
    };
    Ok(responses::ok_json(
        catalog::private_sources::add_source(context, u, h, id, body).await?,
    ))
}

pub async fn source_detail(
    State(app): State<App>,
    h: HeaderMap,
    Path((library, source)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    let context = catalog::SourceReadContext {
        db: &app.db,
        decrypt: &|value| app.decrypt(value),
    };
    Ok(responses::ok_json(
        catalog::private_sources::source_detail(context, u, h, library, source).await?,
    ))
}

pub async fn update_source(
    State(app): State<App>,
    h: HeaderMap,
    Path((library, source)): Path<(Uuid, Uuid)>,
    Json(body): Json<SourceChange>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    let context = catalog::SourceChangeContext {
        db: &app.db,
        encrypt: &|value| app.encrypt(value),
        decrypt: &|value| app.decrypt(value),
    };
    let committed =
        catalog::private_sources::update_source(context, u, h, library, source, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn remove_source(
    State(app): State<App>,
    h: HeaderMap,
    Path((library, source)): Path<(Uuid, Uuid)>,
    Json(body): Json<SourceExpected>,
) -> Result<Response> {
    let u = auth(&app, &h, true).await?;
    let context = catalog::SourceWriteContext {
        db: &app.db,
        encrypt: &|value| app.encrypt(value),
    };
    let committed =
        catalog::private_sources::remove_source(context, u, h, library, source, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub async fn attach_source(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Attach>,
) -> Result<Response> {
    require_enabled()?;
    let u = auth(&app, &h, true).await?;
    admin(&u)?;
    let committed = catalog::private_sources::attach_source(&app.db, u, h, id, body).await?;
    Ok(responses::ok_json(committed.response(&app.db).await))
}

pub use catalog::media_reads::MediaQuery;
pub async fn media(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<MediaQuery>,
) -> Result<Response> {
    let u = auth(&app, &h, false).await?;
    Ok(responses::ok_json(
        catalog::media_reads::list_private(&app.db, u.id, id, q).await?,
    ))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct ScanRequest {
    #[serde(default)]
    restart: bool,
}
fn scan_value(row: &sqlx::postgres::PgRow) -> Value {
    json!({"scan_id":row.get::<Uuid,_>("scan_id"),"status":row.get::<String,_>("status"),"item_count":row.get::<i64,_>("item_count"),"page_count":row.get::<i64,_>("page_count"),"has_more":row.get::<Option<String>,_>("continuation_token").is_some(),"last_error":row.get::<Option<String>,_>("last_error")})
}
pub async fn scan_status(
    State(app): State<App>,
    h: HeaderMap,
    Path((lib, source)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL AND library_allowed($3,$2,'manage'))").bind(source).bind(lib).bind(user.id).fetch_one(&app.db).await?;
    if !allowed {
        return Err(err(StatusCode::NOT_FOUND, "source_not_found"));
    }
    let row = sqlx::query("SELECT * FROM s3_index_scans WHERE source_id=$1")
        .bind(source)
        .fetch_optional(&app.db)
        .await?;
    if row.is_none() {
        let http=sqlx::query("SELECT scan.generation,(SELECT count(*) FROM media_items m WHERE m.source_id=s.id AND m.available) AS item_count FROM sources s JOIN source_scans scan ON scan.source_id=s.id WHERE s.id=$1 AND s.kind='http'").bind(source).fetch_optional(&app.db).await?;
        if let Some(http) = http {
            return Ok(responses::ok_json(
                json!({"scan_id":http.get::<Uuid,_>("generation"),"status":"completed","item_count":http.get::<i64,_>("item_count"),"page_count":1,"has_more":false}),
            ));
        }
    }
    Ok(responses::ok_json(row.as_ref().map(scan_value).unwrap_or(
        json!({"status":"not_started","item_count":0,"page_count":0,"has_more":false}),
    )))
}
pub async fn scan(
    State(app): State<App>,
    h: HeaderMap,
    Path((lib, source)): Path<(Uuid, Uuid)>,
    Json(body): Json<ScanRequest>,
) -> Result<Response> {
    require_enabled()?;
    let user = auth(&app, &h, true).await?;
    let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL AND library_allowed($3,$2,'manage'))").bind(source).bind(lib).bind(user.id).fetch_one(&app.db).await?;
    if !allowed {
        return Err(err(StatusCode::NOT_FOUND, "source_not_found"));
    }
    Ok(responses::ok_json(
        scan_source_page_as(&app, source, body.restart, Some((user, h, lib))).await?,
    ))
}
/// One resumable, atomically checkpointed page. No detached scan can finish after
/// its source revision/cursor has changed. A failed page never removes old items.
pub async fn scan_source_page(app: &App, source: Uuid, restart: bool) -> Result<Value> {
    scan_source_page_as(app, source, restart, None).await
}
async fn lock_scan_caller(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    source: Uuid,
    caller: &Option<(User, HeaderMap, Uuid)>,
) -> Result<()> {
    if let Some((user, headers, library)) = caller {
        lock_caller(tx, user, headers, false).await?;
        let allowed:Option<Uuid>=sqlx::query_scalar("SELECT id FROM private_libraries WHERE id=$1 AND library_allowed($2,id,'manage') FOR SHARE").bind(library).bind(user.id).fetch_optional(&mut **tx).await?;
        let scope: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sources WHERE id=$1 AND library_id=$2 AND deleted_at IS NULL)",
        )
        .bind(source)
        .bind(library)
        .fetch_one(&mut **tx)
        .await?;
        if allowed.is_none() || !scope {
            return Err(err(StatusCode::NOT_FOUND, "source_not_found"));
        }
    }
    Ok(())
}
async fn commit_scan(
    mut tx: sqlx::Transaction<'_, sqlx::Postgres>,
    caller: &Option<(User, HeaderMap, Uuid)>,
) -> Result<()> {
    if let Some((user, headers, library)) = caller {
        lock_caller(&mut tx, user, headers, false).await?;
        require_current_permission(&mut tx, user.id, *library, "manage").await?;
    }
    tx.commit().await?;
    Ok(())
}
async fn lock_scan_page(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    source: Uuid,
    caller: &Option<(User, HeaderMap, Uuid)>,
    source_revision: i64,
    scan_id: Uuid,
    cursor: &Option<String>,
) -> Result<sqlx::postgres::PgRow> {
    lock_scan_caller(tx, source, caller).await?;
    let source_current: i64 = sqlx::query_scalar(
        "SELECT access_policy_revision FROM sources WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(source)
    .fetch_one(&mut **tx)
    .await?;
    let row = sqlx::query("SELECT * FROM s3_index_scans WHERE source_id=$1 FOR UPDATE")
        .bind(source)
        .fetch_one(&mut **tx)
        .await?;
    let generation: Uuid =
        sqlx::query_scalar("SELECT generation FROM source_scans WHERE source_id=$1 FOR UPDATE")
            .bind(source)
            .fetch_one(&mut **tx)
            .await?;
    if source_current != source_revision
        || row.get::<Uuid, _>("scan_id") != scan_id
        || generation != scan_id
        || row.get::<Option<String>, _>("continuation_token") != *cursor
        || row.get::<String, _>("status") == "completed"
    {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    Ok(row)
}
async fn scan_source_page_as(
    app: &App,
    source: Uuid,
    restart: bool,
    caller: Option<(User, HeaderMap, Uuid)>,
) -> Result<Value> {
    use futures_util::StreamExt;
    static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    let _slot = SLOTS
        .get_or_init(|| tokio::sync::Semaphore::new(2))
        .try_acquire()
        .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "source_scan_busy"))?;
    let mut tx = app.db.begin().await?;
    lock_scan_caller(&mut tx, source, &caller).await?;
    let source_row = sqlx::query(
        "SELECT kind,config_encrypted,access_policy_revision FROM sources WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(source)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    let kind = source_row.get::<String, _>("kind");
    if kind == "http" {
        let config: providers::SourceConfig =
            serde_json::from_value(app.decrypt(&source_row.get::<String, _>("config_encrypted"))?)
                .map_err(anyhow::Error::from)?;
        let scan = Uuid::new_v4();
        let items = providers::list_items("http", &config)
            .await
            .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_scan_failed"))?;
        for item in &items {
            let mut metadata = item.metadata.clone();
            metadata["preview_scan"] = json!(scan);
            sqlx::query("INSERT INTO media_items(id,source_id,title,resource,metadata) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_id,resource) DO UPDATE SET title=EXCLUDED.title,metadata=EXCLUDED.metadata,duration_ms=NULL,source_version=NULL,available=true").bind(Uuid::new_v4()).bind(source).bind(&item.title).bind(&item.resource).bind(metadata).execute(&mut *tx).await?;
        }
        let resources = items.iter().map(|i| i.resource.clone()).collect::<Vec<_>>();
        sqlx::query(
            "UPDATE media_items SET available=false WHERE source_id=$1 AND NOT(resource=ANY($2))",
        )
        .bind(source)
        .bind(resources)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO source_scans(source_id,generation) VALUES($1,$2) ON CONFLICT(source_id) DO UPDATE SET generation=EXCLUDED.generation").bind(source).bind(scan).execute(&mut *tx).await?;
        sqlx::query("UPDATE media_items SET library_source_generation=library_source_generation+1 WHERE source_id=$1 AND available").bind(source).execute(&mut *tx).await?;
        commit_scan(tx, &caller).await?;
        return Ok(
            json!({"scan_id":scan,"status":"completed","item_count":items.len(),"page_count":1,"has_more":false}),
        );
    }
    if kind != "s3" {
        return Err(err(StatusCode::BAD_REQUEST, "s3_source_required"));
    }
    let config: providers::SourceConfig =
        serde_json::from_value(app.decrypt(&source_row.get::<String, _>("config_encrypted"))?)
            .map_err(anyhow::Error::from)?;
    let source_revision = source_row.get::<i64, _>("access_policy_revision");
    let existing = sqlx::query("SELECT * FROM s3_index_scans WHERE source_id=$1 FOR UPDATE")
        .bind(source)
        .fetch_optional(&mut *tx)
        .await?;
    let reset = restart
        || existing
            .as_ref()
            .is_some_and(|r| r.get::<i64, _>("source_revision") != source_revision);
    if !reset
        && let Some(row) = &existing
        && row.get::<String, _>("status") == "completed"
    {
        let result = scan_value(row);
        commit_scan(tx, &caller).await?;
        return Ok(result);
    }
    let (scan_id, cursor) = if let Some(r) = existing.as_ref().filter(|_| !reset) {
        (
            r.get::<Uuid, _>("scan_id"),
            r.get::<Option<String>, _>("continuation_token"),
        )
    } else {
        let scan_id = Uuid::new_v4();
        sqlx::query("INSERT INTO s3_index_scans(source_id,scan_id,source_revision,status) VALUES($1,$2,$3,'running') ON CONFLICT(source_id) DO UPDATE SET scan_id=EXCLUDED.scan_id,source_revision=EXCLUDED.source_revision,status='running',continuation_token=NULL,item_count=0,page_count=0,started_at=clock_timestamp(),completed_at=NULL,last_error=NULL,updated_at=clock_timestamp()")
          .bind(source).bind(scan_id).bind(source_revision).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM s3_index_scan_seen WHERE source_id=$1")
            .bind(source)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM s3_index_scan_cursors WHERE source_id=$1")
            .bind(source)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO source_scans(source_id,generation) VALUES($1,$2) ON CONFLICT(source_id) DO UPDATE SET generation=EXCLUDED.generation").bind(source).bind(scan_id).execute(&mut *tx).await?;
        (scan_id, None)
    };
    commit_scan(tx, &caller).await?;
    let fetch = async {
        let page = providers::s3::list_page(&config, cursor.as_deref(), 100).await?;
        let next = page.next_continuation_token;
        anyhow::ensure!(next.is_none() || next != cursor, "s3_cursor_repeated");
        let objects = futures_util::stream::iter(
            page.objects
                .into_iter()
                .filter(|obj| {
                    std::path::Path::new(&obj.key)
                        .extension()
                        .and_then(|v| v.to_str())
                        .is_some_and(|v| {
                            matches!(
                                v.to_ascii_lowercase().as_str(),
                                "mp4" | "mkv" | "webm" | "mov" | "m4v"
                            )
                        })
                })
                .map(|obj| {
                    let config = &config;
                    async move {
                        let head = providers::s3::head_object(
                            config,
                            &obj.key,
                            obj.version_id.as_deref(),
                            obj.etag.as_deref(),
                        )
                        .await?;
                        anyhow::ensure!(
                            head.size == obj.size && head.etag == obj.etag,
                            "s3_index_identity_changed"
                        );
                        Ok::<_, anyhow::Error>(head)
                    }
                }),
        )
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
        let objects = objects.into_iter().collect::<anyhow::Result<Vec<_>>>()?;
        Ok::<_, anyhow::Error>((objects, next))
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), fetch).await;
    let (objects, next) = match result {
        Ok(Ok(value)) => value,
        _ => {
            // A failed fetch is still a checkpoint mutation. Reauthorize it
            // and bind every durable fence before publishing its status.
            let mut tx = app.db.begin().await?;
            lock_scan_page(&mut tx, source, &caller, source_revision, scan_id, &cursor).await?;
            sqlx::query("UPDATE s3_index_scans SET status='failed',last_error='s3_scan_failed',updated_at=clock_timestamp() WHERE source_id=$1")
                .bind(source).execute(&mut *tx).await?;
            commit_scan(tx, &caller).await?;
            return Err(err(StatusCode::BAD_GATEWAY, "s3_scan_failed"));
        }
    };
    let mut tx = app.db.begin().await?;
    let row = lock_scan_page(&mut tx, source, &caller, source_revision, scan_id, &cursor).await?;
    if row.get::<i64, _>("page_count") >= 10_000 {
        return Err(err(StatusCode::BAD_GATEWAY, "s3_scan_failed"));
    }
    if let Some(next) = &next {
        let repeated:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM s3_index_scan_cursors WHERE source_id=$1 AND scan_id=$2 AND cursor_sha256=$3)").bind(source).bind(scan_id).bind(hash(next)).fetch_one(&mut *tx).await?;
        if repeated {
            return Err(err(StatusCode::BAD_GATEWAY, "s3_scan_failed"));
        }
    }
    sqlx::query("INSERT INTO s3_index_scan_cursors(source_id,scan_id,cursor_sha256) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(source).bind(scan_id).bind(hash(cursor.as_deref().unwrap_or("<first-page>"))).execute(&mut *tx).await?;
    let bucket = &config
        .s3
        .as_ref()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_source"))?
        .bucket;
    for object in &objects {
        let title = std::path::Path::new(&object.key)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("S3 media")
            .chars()
            .take(200)
            .collect::<String>();
        let version = object.source_version(bucket);
        let identity = serde_json::to_value(object).map_err(anyhow::Error::from)?;
        sqlx::query("INSERT INTO media_items(id,source_id,title,resource,metadata,source_version,s3_object_identity) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_id,resource) DO UPDATE SET title=EXCLUDED.title,metadata=CASE WHEN media_items.source_version IS NOT DISTINCT FROM EXCLUDED.source_version THEN media_items.metadata||EXCLUDED.metadata ELSE EXCLUDED.metadata END,duration_ms=CASE WHEN media_items.source_version IS NOT DISTINCT FROM EXCLUDED.source_version THEN media_items.duration_ms ELSE NULL END,source_version=EXCLUDED.source_version,s3_object_identity=EXCLUDED.s3_object_identity,available=true")
        .bind(Uuid::new_v4()).bind(source).bind(title).bind(&object.key).bind(json!({"s3":identity,"source_version":version})).bind(version).bind(identity).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO s3_index_scan_seen(source_id,scan_id,resource) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(source).bind(scan_id).bind(&object.key).execute(&mut *tx).await?;
    }
    if next.is_none() {
        sqlx::query("UPDATE media_items m SET available=false WHERE source_id=$1 AND NOT EXISTS(SELECT 1 FROM s3_index_scan_seen seen WHERE seen.source_id=m.source_id AND seen.scan_id=$2 AND seen.resource=m.resource)").bind(source).bind(scan_id).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE s3_index_scans SET continuation_token=$3,status=CASE WHEN $3::text IS NULL THEN 'completed' ELSE 'running' END,item_count=(SELECT count(*) FROM s3_index_scan_seen WHERE source_id=$1 AND scan_id=$2),page_count=page_count+1,completed_at=CASE WHEN $3::text IS NULL THEN clock_timestamp() ELSE NULL END,last_error=NULL,updated_at=clock_timestamp() WHERE source_id=$1 AND scan_id=$2")
      .bind(source).bind(scan_id).bind(next).execute(&mut *tx).await?;
    let row = sqlx::query("SELECT * FROM s3_index_scans WHERE source_id=$1")
        .bind(source)
        .fetch_one(&mut *tx)
        .await?;
    commit_scan(tx, &caller).await?;
    Ok(scan_value(&row))
}
