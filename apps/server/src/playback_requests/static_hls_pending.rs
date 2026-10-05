//! Server-only trusted input construction. There is no JSON endpoint or public
//! prepare caller. This storage slice does not perform source I/O or publish.
#![allow(dead_code)]
use super::*;
use media_core::static_hls::contracts::{
    PREPARATION_LIFETIME_MS, ROOT_LIFETIME_MS, input::FrozenInput,
};
use persistence::static_hls_pending::{CatalogSnapshot, Existing, Freeze, PreparedParentInput};
use providers::SourceConfig;

pub(crate) enum Frozen {
    New(Box<PreparedParentInput>),
    Existing(Existing),
}

/// The original Server preparation task consumes its newly frozen input.
/// Public negotiation/activation must precede this call; a qualification-ended
/// observation does not complete or authorize an ordinary native result.
pub(crate) async fn prepare_new_frozen(
    app: &App,
    prepared: &PreparedParentInput,
    cancelled: impl std::future::Future<Output = ()> + Send,
) -> Result<crate::static_hls_operation_client::ParentPreparation> {
    let cache = std::env::var("CACHE_ROOT").unwrap_or_else(|_| "/cache".into());
    let worker = std::env::var("WORKER_URL").unwrap_or_else(|_| "http://127.0.0.1:8081".into());
    let client = crate::static_hls_operation_client::Client::new(
        app.db.clone(),
        app.key.clone(),
        std::path::PathBuf::from(cache),
        &worker,
    )?;
    client
        .prepare_owned_parent(prepared.input(), cancelled)
        .await
        .map_err(|_| {
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "static_hls_operation_receipt_unknown",
            )
        })
}

/// Stored HTTP configuration and the resolved catalog target are the only
/// source of URLs, headers and policy. Identity comes from authenticated Server
/// context and DB observations; no client supplies an input or digest.
pub(crate) async fn build_and_freeze(
    app: &App,
    user: Uuid,
    body: &protocol::PlaybackRequest,
    login: &str,
    worker_startup: Uuid,
) -> Result<Frozen> {
    let key = body
        .idempotency_key
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "idempotency_key_required"))?;
    let viewer = body
        .viewer_id
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_plan_generation"))?;
    let generation = body
        .plan_generation
        .filter(|n| *n > 0)
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_plan_generation"))?;
    let mut canonical = body.clone();
    canonical.idempotency_key = None;
    canonical.mode = Some(body.mode.as_deref().unwrap_or("auto").into());
    let request_hash = hash(&serde_json::to_string(&canonical).map_err(anyhow::Error::from)?);
    if let Some(existing) =
        persistence::static_hls_pending::existing(&app.db, user, key, &request_hash, login).await?
    {
        return Ok(Frozen::Existing(existing));
    }
    // One original DB clock sample is rounded DOWN to complete milliseconds.
    // Construction/decryption/encryption happen before any authority locks.
    let row = sqlx::query("SELECT m.id AS media_id,m.source_id,m.resource,m.source_version,m.preview_generation,s.kind,s.config_encrypted,s.access_policy_revision,room.lifecycle_epoch,member.membership_epoch,floor(extract(epoch FROM login.expires_at)*1000)::bigint AS login_expires_ms,db.id AS database_id,floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS admitted_ms FROM rooms room JOIN room_snapshots snap ON snap.room_id=room.id JOIN media_items m ON m.id=(snap.state->>'media_id')::uuid JOIN sources s ON s.id=m.source_id JOIN room_members member ON member.room_id=room.id AND member.user_id=$2 JOIN sessions login ON login.user_id=$2 AND login.token_hash=$4 JOIN static_hls_database_binding db ON db.singleton WHERE room.id=$1 AND room.lifecycle='active' AND (snap.state->>'media_generation')::bigint=$3 AND m.available AND s.kind='http' AND playback_origin_allowed($2,$1,$4,member.membership_epoch)")
        .bind(body.room_id).bind(user).bind(i64::from(body.media_generation)).bind(login)
        .fetch_optional(&app.db).await?.ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    let catalog = CatalogSnapshot::from_row(&row);
    let config: SourceConfig = serde_json::from_value(app.decrypt(&catalog.config_encrypted)?)
        .map_err(|_| err(StatusCode::CONFLICT, "source_changed"))?;
    let now: i64 = row.get("admitted_ms");
    let now = u64::try_from(now).map_err(anyhow::Error::from)?;
    let login_expires_ms =
        u64::try_from(row.get::<i64, _>("login_expires_ms")).map_err(anyhow::Error::from)?;
    let (root_expires_ms, prepare_expires_ms) = original_deadlines(now, login_expires_ms)?;
    let source = source_statement(&catalog, &config)?;
    let raw = json!({
        "input_version":1,"graph_version":1,"reader_version":2,"recipe_version":1,"kind":"parent",
        "operation_id":Uuid::new_v4(),"session_id":Uuid::new_v4(),"request_owner_epoch":app.epoch,
        "request_sha256":request_hash,"user_id":user,"room_id":body.room_id,"auth_login_hash":login,
        "auth_membership_epoch":row.get::<Uuid,_>("membership_epoch"),"lifecycle_epoch":row.get::<i64,_>("lifecycle_epoch"),
        "media_id":catalog.media,"media_generation":body.media_generation,"viewer_id":viewer,"plan_generation":generation,
        "worker_instance":worker_startup,"database":row.get::<Uuid,_>("database_id"),
        "root_admitted_at_ms":now,"root_hard_expires_at_ms":root_expires_ms,
        "prepare_started_at_ms":now,"prepare_expires_at_ms":prepare_expires_ms,
        "position_ms":body.position_ms,"audio_intent":body.audio_index.map_or_else(||json!({"kind":"default"}),|index|json!({"kind":"stream","index":index})),
        "source":source
    });
    let frozen = FrozenInput::parse_private_plaintext(
        &serde_json::to_vec(&raw).map_err(anyhow::Error::from)?,
    )
    .map_err(anyhow::Error::from)?;
    let prepared = PreparedParentInput::seal(frozen, catalog, |plaintext| {
        let mut nonce = [0; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        Ok(
            crate::static_hls_input_cipher::seal_private_input_plaintext(
                &app.key, nonce, plaintext,
            )?,
        )
    })?;
    match persistence::static_hls_pending::freeze(&app.db, key, &prepared, app.session_limit)
        .await?
    {
        Freeze::Frozen => Ok(Frozen::New(Box::new(prepared))),
        Freeze::Existing(existing) => Ok(Frozen::Existing(existing)),
    }
}

fn original_deadlines(now: u64, login_expires_ms: u64) -> Result<(u64, u64)> {
    let deadline_error = || err(StatusCode::CONFLICT, "static_hls_contract_deadline");
    if login_expires_ms <= now {
        return Err(deadline_error());
    }
    let root = now
        .checked_add(ROOT_LIFETIME_MS)
        .ok_or_else(deadline_error)?
        .min(login_expires_ms);
    let preparation = now
        .checked_add(PREPARATION_LIFETIME_MS)
        .ok_or_else(deadline_error)?
        .min(root);
    Ok((root, preparation))
}

fn source_statement(catalog: &CatalogSnapshot, config: &SourceConfig) -> Result<Value> {
    // The frozen v1 source policy statement has no public-only bit. Never
    // project that constraint away and re-enable private-network reads.
    if config
        .access_policy
        .as_ref()
        .is_some_and(|policy| policy.public_only)
    {
        return Err(err(
            StatusCode::CONFLICT,
            "static_hls_native_transport_unavailable",
        ));
    }
    let access =
        providers::access_policy::SourceAccess::new(&config.url, config.access_policy.as_ref())
            .map_err(anyhow::Error::from)?;
    // This is catalog target resolution only. Graph verification separately
    // binds the source-produced root to this exact original target digest.
    let target = access
        .authorize_url(&catalog.resource)
        .map_err(anyhow::Error::from)?;
    let base = providers::validate_url(&config.url)?;
    let mut headers = std::collections::BTreeMap::new();
    for (name, value) in &config.headers {
        let previous = headers.insert(name.to_ascii_lowercase(), value.clone());
        if previous.is_some() {
            return Err(err(StatusCode::CONFLICT, "static_hls_contract_headers"));
        }
    }
    let headers: Vec<Value> = headers
        .into_iter()
        .map(|(name, value)| json!({"name":name,"value":value}))
        .collect();
    // Explicit nulls preserve the closed contract's required nullable fields.
    let policy = config.access_policy.as_ref().map_or(Value::Null, |p| {
        json!({
            "schema_version":p.schema_version,"origins":p.origins,
            "redirects":p.redirects.as_ref().map(|r|json!({"max_hops":r.max_hops}))
        })
    });
    Ok(
        json!({"kind":"http","source_id":catalog.source,"source_policy_revision":catalog.source_revision,
        "media_source_generation":catalog.source_generation,"configured_base_url":base.as_str(),
        "canonical_target":target.as_str(),"headers":headers,"access_policy":policy}),
    )
}

/// Public ordinary playback refuses a stored pending input before retry
/// retirement, upstream/job work, session replacement or viewer advancement.
/// Internal consuming path for the frozen original. Public publication remains
/// gated until the parent read/atomic publication and child recipe are ready.
#[allow(dead_code)]
pub(super) async fn operate(
    app: &App,
    prepared: &PreparedParentInput,
    action: media_core::static_hls::contracts::operation::Action,
) -> Result<media_core::static_hls::contracts::operation::OperationResponse> {
    let owner = app.preparations.admit().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "static_hls_operation_draining",
        )
    })?;
    let cache =
        std::path::PathBuf::from(std::env::var("CACHE_ROOT").unwrap_or_else(|_| "/cache".into()));
    let worker = std::env::var("WORKER_URL").unwrap_or_else(|_| "http://127.0.0.1:8081".into());
    let client = crate::static_hls_operation_client::Client::new(
        app.db.clone(),
        app.key.clone(),
        cache,
        &worker,
    )
    .map_err(|_| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "static_hls_operation_receipt_unknown",
        )
    })?;
    let result = tokio::select! {
        result = client.call(prepared.input(), action) => result,
        _ = owner.cancelled() => Err(anyhow::anyhow!("static_hls_operation_receipt_unknown")),
    };
    result.map_err(|_| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "static_hls_operation_receipt_unknown",
        )
    })
}

pub(super) fn refuse_existing(
    row: &sqlx::postgres::PgRow,
    digest: &str,
    login: &str,
) -> Result<(Uuid, Uuid)> {
    let result =
        persistence::static_hls_pending::existing_result(row, digest, login).map_err(|error| {
            match error.to_string().as_str() {
                "static_hls_exact_login_required" => {
                    err(StatusCode::GONE, "invalid_playback_session")
                }
                "playback_request_conflict" => {
                    err(StatusCode::CONFLICT, "playback_request_conflict")
                }
                _ => err(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "static_hls_operation_receipt_unknown",
                ),
            }
        })?;
    match result {
        Existing::PublishedParent | Existing::CompletedUnmarked => Ok((
            row.try_get("static_hls_operation_id")?,
            row.try_get("session_id")?,
        )),
        Existing::Legacy => Err(err(StatusCode::CONFLICT, "playback_request_conflict")),
        Existing::InProgress => Err(err(StatusCode::CONFLICT, "playback_request_in_progress")),
        Existing::Failed { status, code } => Err(err(
            StatusCode::from_u16(status as u16).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            &code,
        )),
        Existing::RetainedCustody => Err(err(StatusCode::GONE, "playback_request_expired")),
    }
}

/// Replay an ordinary grant only after qualification has positively ended.
/// The original request, session and root deadline are never replaced.
pub(super) async fn replay_unmarked(
    app: &App,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    row: &sqlx::postgres::PgRow,
) -> Result<Value> {
    let session: Uuid = row.try_get("session_id")?;
    let operation: Uuid = row.try_get("static_hls_operation_id")?;
    super::guard_generation(
        tx,
        row.try_get("user_id")?,
        row.try_get("room_id")?,
        row.try_get("viewer_id")?,
        row.try_get::<Option<i64>, _>("plan_generation")?
            .map(u32::try_from)
            .transpose()
            .map_err(anyhow::Error::from)?,
    )
    .await?;
    if !persistence::source_account_policy::lock_session(tx, session).await? {
        return Err(err(StatusCode::GONE, "playback_request_expired"));
    }
    let remaining: Option<i64> = sqlx::query_scalar("SELECT FLOOR(EXTRACT(EPOCH FROM(p.expires_at-clock_timestamp())))::bigint FROM playback_sessions p JOIN playback_requests r ON r.session_id=p.id JOIN rooms room ON room.id=p.room_id JOIN room_snapshots snap ON snap.room_id=room.id WHERE p.id=$1 AND r.static_hls_operation_id=$2 AND r.status='completed' AND r.static_hls_input_version=1 AND NOT p.stopped AND p.static_hls_capture_id IS NULL AND NOT(p.resource ?| ARRAY['static_hls_capture_id','static_hls_input']) AND p.expires_at=r.static_hls_root_expires_at AND p.expires_at>clock_timestamp() AND r.static_hls_root_expires_at>clock_timestamp() AND p.user_id=r.user_id AND p.room_id=r.room_id AND p.lifecycle_epoch=r.lifecycle_epoch AND p.viewer_id=r.viewer_id AND p.plan_generation=r.plan_generation AND p.auth_login_hash=r.auth_login_hash AND p.auth_membership_epoch=r.auth_membership_epoch AND room.lifecycle='active' AND room.lifecycle_epoch=p.lifecycle_epoch AND (snap.state->>'media_id')::uuid=p.media_id AND (snap.state->>'media_generation')::bigint=p.generation AND playback_source_allowed(p.media_id,p.resource,p.id) AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch) AND NOT EXISTS(SELECT 1 FROM static_hls_captures c WHERE c.session_id=$1 AND (c.id<>$2 OR c.publication_phase<>'pending_parent' OR c.state<>'disposed' OR c.streams_closed_at IS NULL OR c.process_closed_at IS NULL OR c.process_disposition IS NULL OR c.process_disposition NOT IN('never_started','reaped') OR c.files_removed_at IS NULL OR c.disposed_at IS NULL)) AND NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id IN($1,$2)) AND NOT EXISTS(SELECT 1 FROM media_jobs WHERE session_id=$1)")
        .bind(session).bind(operation).fetch_optional(&mut **tx).await?;
    let remaining = remaining
        .filter(|n| *n > 0)
        .ok_or_else(|| err(StatusCode::GONE, "playback_request_expired"))?;
    let mut plan = app.decrypt(&row.try_get::<String, _>("response_encrypted")?)?;
    plan["expires_in_seconds"] = json!(remaining);
    playback_observations::refresh_plan(tx, &mut plan).await?;
    playback_metrics::refresh(tx, &mut plan).await?;
    playback_plan::refresh(app, tx, row.try_get("user_id")?, session, &mut plan).await?;
    Ok(plan)
}

pub(crate) async fn replay_published(app: &App, operation: Uuid, session: Uuid) -> Result<Value> {
    let cache =
        std::path::PathBuf::from(std::env::var("CACHE_ROOT").unwrap_or_else(|_| "/cache".into()));
    let worker = std::env::var("WORKER_URL").unwrap_or_else(|_| "http://127.0.0.1:8081".into());
    let client = crate::static_hls_operation_client::Client::new(
        app.db.clone(),
        app.key.clone(),
        cache,
        &worker,
    )?;
    let plan = client
        .replay_published(operation, session)
        .await
        .map_err(|error| {
            if error.to_string() == "static_hls_parent_expired" {
                err(StatusCode::GONE, "playback_request_expired")
            } else {
                err(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "static_hls_operation_receipt_unknown",
                )
            }
        })?;
    let plan = crate::static_hls_child_public::advertise_parent_fallback(app, plan).await?;
    serde_json::to_value(plan)
        .map_err(anyhow::Error::from)
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use providers::SourceConfig;
    fn catalog() -> CatalogSnapshot {
        CatalogSnapshot {
            media: Uuid::from_u128(7),
            source: Uuid::from_u128(11),
            kind: "http".into(),
            config_encrypted: "synthetic".into(),
            resource: "https://source.example/selected.m3u8".into(),
            source_version: Some("v1".into()),
            source_revision: 1,
            source_generation: 1,
        }
    }
    fn config() -> SourceConfig {
        serde_json::from_value(
            json!({"url":"https://source.example/configured.m3u8","headers":{"X-Test":"one"}}),
        )
        .unwrap()
    }
    #[test]
    fn trusted_target_is_catalog_target_and_policy_nulls_are_explicit() {
        let statement = source_statement(&catalog(), &config()).unwrap();
        assert_eq!(
            statement["canonical_target"],
            "https://source.example/selected.m3u8"
        );
        assert_eq!(
            statement["configured_base_url"],
            "https://source.example/configured.m3u8"
        );
        assert_eq!(
            statement["headers"],
            json!([{"name":"x-test","value":"one"}])
        );
        assert!(statement["access_policy"].is_null());
    }
    #[test]
    fn ambiguous_configured_headers_and_unscoped_target_are_refused() {
        let mut config = config();
        config.headers.insert("x-test".into(), "two".into());
        assert!(source_statement(&catalog(), &config).is_err());
        let mut catalog = catalog();
        catalog.resource = "https://other.example/selected.m3u8".into();
        assert!(source_statement(&catalog, &self::config()).is_err());
    }
    #[test]
    fn public_only_constraint_is_rejected_instead_of_projected_away() {
        let mut config = config();
        config.access_policy =
            Some(providers::access_policy::SourceAccessPolicy::public_origin(&config.url).unwrap());
        assert!(source_statement(&catalog(), &config).is_err());
    }
    #[test]
    fn original_login_limit_caps_both_deadlines_without_extension() {
        assert_eq!(original_deadlines(1000, 2000).unwrap(), (2000, 2000));
        assert_eq!(original_deadlines(1000, 61_000).unwrap(), (61_000, 46_000));
        assert_eq!(
            original_deadlines(1000, 3_601_000).unwrap(),
            (1_801_000, 46_000)
        );
        assert!(original_deadlines(1000, 1000).is_err());
        assert!(original_deadlines(1000, 999).is_err());
        assert!(original_deadlines(u64::MAX - 1, u64::MAX).is_err());
    }
}
