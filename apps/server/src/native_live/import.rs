use super::*;

pub(crate) fn dto(row: &PgRow) -> Value {
    let title: String = row.get("title");
    let identity = Identity::BilibiliLive {
        room_id: row
            .get::<Option<String>, _>("live_room_id")
            .unwrap_or_default(),
        uid: row.get::<Option<String>, _>("live_uid").unwrap_or_default(),
        broadcast_id: row
            .get::<Option<String>, _>("live_broadcast_id")
            .unwrap_or_default(),
    };
    json!({"id":row.get::<Uuid,_>("media_id"),"kind":"native_platform","title":title,"original_title":title,
        "shared_title":null,"shared_title_revision":"0","personal_title":null,"personal_title_revision":"0",
        "duration_ms":null,"cover":{"status":"missing","revision":null,"url":null,"retry_after_ms":null},
        "platform":{"version":3,"provider":"bilibili","content_id":identity.content_id(),"part":1,"resource":identity}})
}
fn validate(body: &native_platform::ImportRequest) -> Result<live::RoomRef> {
    if body.course_version.is_some()
        || body.provider != "bilibili"
        || body.live_version != Some(1)
        || body.part.is_some_and(|v| v != 1)
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_live_client_unsupported",
        ));
    }
    native_platform::import_credential_mode(body)?;
    live::parse_resource(&body.url).map_err(provider_error)
}
pub(crate) async fn import_one(
    app: &App,
    headers: &HeaderMap,
    room: Uuid,
    body: &native_platform::ImportRequest,
    frozen: Option<&platform_accounts::FrozenAccount>,
) -> Result<Value> {
    let reference = validate(body)?;
    let user = auth(app, headers, true).await?;
    let login = media_authorization::login_hash(headers)?;
    rooms::controller(app, headers, room)
        .await?
        .rollback()
        .await?;
    account_security::rate_limit(&app.db, "native-live-import", &user.id.to_string(), 12, 60)
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
                platform_accounts::FrozenAccount::anonymous(user.id)
            }
            protocol::NativePlatformCredentialMode::OwnOrAnonymous => {
                platform_accounts::load_for_provider_playback(app, user.id, "bilibili").await?
            }
        };
        &loaded
    };
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
    // An import verifies a clear supported live stream but discards the signed
    // URL. Each viewer later prepares their own frozen-account grant.
    let resolved = live::Client::new(app.platform_http, account.cookie().cloned())
        .resolve(
            &reference.canonical(),
            None,
            Instant::now() + Duration::from_secs(20),
        )
        .await
        .map_err(provider_error)?;
    let identity = Identity::from_metadata(&resolved.metadata);
    if !identity.validate() {
        return Err(err(
            StatusCode::BAD_GATEWAY,
            "native_platform_invalid_response",
        ));
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
        "Bilibili 直播"
    } else {
        title.trim()
    };
    let mut tx = rooms::controller(app, headers, room).await?;
    platform_accounts::guard_for_publish(&mut tx, user.id, account).await?;
    let existing:Option<Uuid>=sqlx::query_scalar("SELECT media_id FROM room_platform_media WHERE room_id=$1 AND provider='bilibili' AND content_id=$2 AND part=1 AND resource_kind='live'").bind(room).bind(identity.content_id()).fetch_optional(&mut *tx).await?;
    let media = if let Some(media) = existing {
        media
    } else {
        let media = Uuid::new_v4();
        sqlx::query("INSERT INTO media_items(id,source_id,title,resource,duration_ms,metadata,available) VALUES($1,NULL,'平台影片',$2,NULL,'{}',true)").bind(media).bind(format!("platform:{media}")).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO room_platform_media(media_id,room_id,provider,content_id,part,title,duration_ms,created_by,canonical_url,resource_kind,live_room_id,live_uid,live_broadcast_id) VALUES($1,$2,'bilibili',$3,1,$4,NULL,$5,$6,'live',$7,$8,$9)")
            .bind(media).bind(room).bind(identity.content_id()).bind(title).bind(user.id).bind(identity.canonical()).bind(identity.room_id()).bind(identity.uid()).bind(identity.broadcast_id()).execute(&mut *tx).await?;
        media
    };
    let row=sqlx::query("SELECT media_id,title,live_room_id,live_uid,live_broadcast_id FROM room_platform_media WHERE room_id=$1 AND media_id=$2 AND resource_kind='live'").bind(room).bind(media).fetch_one(&mut *tx).await?;
    let value = dto(&row);
    platform_accounts::guard_for_publish(&mut tx, user.id, account).await?;
    rooms::commit_controller(tx, headers).await?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn import_requires_explicit_live_client_and_exact_page_identity() {
        let value =
            json!({"provider":"bilibili","url":"https://live.bilibili.com/7","live_version":1});
        assert_eq!(
            validate(&serde_json::from_value(value.clone()).unwrap())
                .unwrap()
                .room_id,
            "7"
        );
        for (field, value) in [
            ("live_version", Value::Null),
            ("live_version", json!(2)),
            ("part", json!(2)),
            (
                "url",
                json!("https://live.bilibili.com/7?url=https://evil.invalid"),
            ),
            ("provider", json!("douyin")),
            ("account_id", json!(Uuid::from_u128(1))),
        ] {
            let mut changed =
                json!({"provider":"bilibili","url":"https://live.bilibili.com/7","live_version":1});
            changed[field] = value;
            assert!(
                validate(&serde_json::from_value(changed).unwrap()).is_err(),
                "{field}"
            );
        }
    }
}
