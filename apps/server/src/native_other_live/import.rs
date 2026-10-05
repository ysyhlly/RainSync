use super::*;
pub(crate) fn dto(row: &PgRow) -> Value {
    let Ok(identity) = identity_from_row(row) else {
        return json!({"error":"native_platform_invalid_response"});
    };
    let title: String = row.get("title");
    json!({"id":row.get::<Uuid,_>("media_id"),"kind":"native_platform","title":title,"original_title":title,"shared_title":null,"shared_title_revision":"0","personal_title":null,"personal_title_revision":"0","duration_ms":null,"cover":{"status":"missing","revision":null,"url":null,"retry_after_ms":null},"platform":{"version":5,"provider":identity.provider_str(),"content_id":identity.content_id(),"part":1,"resource":identity}})
}
fn validate(body: &native_platform::ImportRequest) -> Result<live::Resource> {
    if body.course_version.is_some()
        || body.live_version != Some(2)
        || body.part.is_some_and(|v| v != 1)
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_live_client_unsupported",
        ));
    }
    native_platform::import_credential_mode(body)?;
    let provider = live::Provider::parse(&body.provider).map_err(provider_error)?;
    live::parse_resource(provider, &body.url).map_err(provider_error)
}
pub(crate) async fn import_one(
    app: &App,
    headers: &HeaderMap,
    room: Uuid,
    body: &native_platform::ImportRequest,
    frozen: Option<&platform_accounts::FrozenAccount>,
) -> Result<Value> {
    if !app.other_live_enabled {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_other_live_provider_unavailable",
        ));
    }
    let reference = validate(body)?;
    let user = auth(app, headers, true).await?;
    let login = media_authorization::login_hash(headers)?;
    rooms::controller(app, headers, room)
        .await?
        .rollback()
        .await?;
    account_security::rate_limit(
        &app.db,
        "native-other-live-import",
        &user.id.to_string(),
        12,
        60,
    )
    .await?;
    let mode = native_platform::import_credential_mode(body)?;
    let loaded;
    let account = if let Some(frozen) = frozen {
        if mode != protocol::NativePlatformCredentialMode::OwnOrAnonymous {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "native_platform_invalid_intent",
            ));
        }
        frozen
    } else {
        loaded = match mode {
            protocol::NativePlatformCredentialMode::Anonymous => {
                platform_accounts::FrozenAccount::anonymous_for_provider(user.id, &body.provider)?
            }
            protocol::NativePlatformCredentialMode::OwnOrAnonymous => {
                platform_accounts::load_for_provider_playback(app, user.id, &body.provider).await?
            }
        };
        &loaded
    };
    if account.provider_name() != body.provider {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    if body.account_id.is_some() && body.account_id != account.account_id() {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    let mut before = rooms::controller(app, headers, room).await?;
    platform_accounts::guard_for_publish(&mut before, user.id, account).await?;
    let allowed: bool = sqlx::query_scalar("SELECT playback_login_allowed($1,$2)")
        .bind(user.id)
        .bind(&login)
        .fetch_one(&mut *before)
        .await?;
    if !allowed {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    before.rollback().await?;
    let resolved = resolve(
        app,
        &reference,
        account,
        Instant::now() + Duration::from_secs(35),
    )
    .await?;
    resolved.validate().map_err(provider_error)?;
    let identity = Identity::from_metadata(&resolved.metadata);
    if !identity.validate() {
        return Err(invalid());
    }
    observe(app, &resolved.metadata).await?;
    let title: String = resolved
        .metadata
        .title
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{2028}' | '\u{2029}'))
        .take(200)
        .collect();
    let title = if title.trim().is_empty() {
        "平台直播"
    } else {
        title.trim()
    };
    let mut tx = rooms::controller(app, headers, room).await?;
    platform_accounts::guard_for_publish(&mut tx, user.id, account).await?;
    let existing:Option<Uuid>=sqlx::query_scalar("SELECT media_id FROM room_platform_media WHERE room_id=$1 AND provider=$2 AND content_id=$3 AND part=1 AND resource_kind='other_live'").bind(room).bind(identity.provider_str()).bind(identity.content_id()).fetch_optional(&mut *tx).await?;
    let media = if let Some(media) = existing {
        media
    } else {
        let media = Uuid::new_v4();
        sqlx::query("INSERT INTO media_items(id,source_id,title,resource,duration_ms,metadata,available) VALUES($1,NULL,'平台影片',$2,NULL,'{}',true)").bind(media).bind(format!("platform:{media}")).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO room_platform_media(media_id,room_id,provider,content_id,part,title,duration_ms,created_by,canonical_url,resource_kind,live_room_id,live_uid,live_broadcast_id,live_started_at,live_resource) VALUES($1,$2,$3,$4,1,$5,NULL,$6,$7,'other_live',$8,$9,$10,$11,$12)").bind(media).bind(room).bind(identity.provider_str()).bind(identity.content_id()).bind(title).bind(user.id).bind(identity.canonical()).bind(identity.room_id()).bind(identity.uid()).bind(identity.broadcast_id()).bind(i64::try_from(identity.started_at()).map_err(|_|invalid())?).bind(serde_json::to_value(&resolved.metadata.resource).map_err(anyhow::Error::from)?).execute(&mut *tx).await?;
        media
    };
    let row=sqlx::query("SELECT media_id,title,provider,live_room_id,live_uid,live_broadcast_id,live_started_at,live_resource,canonical_url FROM room_platform_media WHERE room_id=$1 AND media_id=$2 AND resource_kind='other_live'").bind(room).bind(media).fetch_one(&mut *tx).await?;
    let value = dto(&row);
    platform_accounts::guard_for_publish(&mut tx, user.id, account).await?;
    rooms::commit_controller(tx, headers).await?;
    Ok(value)
}
