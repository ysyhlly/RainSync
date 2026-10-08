//! Explicit pages retain one caller/account snapshot through opaque continuations.
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};

const PURPOSE: &str = "platform_collection_continuation_v2";
const MAX_TOKEN: usize = 16 * 1024;
const MAX_LIFETIME_MS: i64 = 300_000;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Continuation {
    purpose: String,
    server_epoch: Uuid,
    user: Uuid,
    room: Uuid,
    login_hash: String,
    collection_key: String,
    credential_mode: protocol::NativePlatformCredentialMode,
    account_fingerprint: String,
    expires_at_ms: i64,
    page: imports::CollectionPageRequest,
}
fn changed() -> Error {
    err(StatusCode::CONFLICT, "platform_collection_changed")
}
fn decode(app: &App, token: &str) -> Result<Continuation> {
    if token.is_empty()
        || token.len() > MAX_TOKEN
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(changed());
    }
    let bytes = URL_SAFE_NO_PAD.decode(token).map_err(|_| changed())?;
    let ciphertext = std::str::from_utf8(&bytes).map_err(|_| changed())?;
    serde_json::from_value(app.decrypt(ciphertext).map_err(|_| changed())?).map_err(|_| changed())
}
fn encode(app: &App, continuation: &Continuation) -> Result<String> {
    let value = serde_json::to_value(continuation).map_err(anyhow::Error::from)?;
    let encrypted = app.encrypt(&value)?;
    let token = URL_SAFE_NO_PAD.encode(encrypted.as_bytes());
    if token.len() > MAX_TOKEN {
        return Err(changed());
    }
    Ok(token)
}
fn account_allowed(collection: &imports::Collection) -> bool {
    matches!(
        collection,
        imports::Collection::PgcSeason { .. } | imports::Collection::CourseSeason { .. }
    )
}
struct ContinuationContext<'a> {
    epoch: Uuid,
    user: Uuid,
    room: Uuid,
    login: &'a str,
    collection: &'a str,
    mode: protocol::NativePlatformCredentialMode,
    fingerprint: &'a str,
    now: i64,
}
fn matches_context(value: &Continuation, context: ContinuationContext<'_>) -> bool {
    let ContinuationContext {
        epoch,
        user,
        room,
        login,
        collection,
        mode,
        fingerprint,
        now,
    } = context;
    value.purpose == PURPOSE
        && value.server_epoch == epoch
        && value.user == user
        && value.room == room
        && value.login_hash == login
        && value.collection_key == collection
        && value.credential_mode == mode
        && value.account_fingerprint == fingerprint
        && value.expires_at_ms > now
        && value.expires_at_ms.saturating_sub(now) <= MAX_LIFETIME_MS
        && value.page.page > 0
        && value.page.page < 100
}

pub(super) async fn preview(
    app: &App,
    headers: &HeaderMap,
    room: Uuid,
    user: Uuid,
    body: &PreviewRequest,
    input: (&str, Provider),
    deadline: Instant,
) -> Result<Response> {
    let (candidate, provider) = input;
    let collection = match imports::parse_collection(candidate, provider) {
        Ok(value) => value,
        Err(error) => {
            let input = imports::parse_input(candidate, Some(provider))
                .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_collection_invalid"))?;
            if provider != Provider::Bilibili || !matches!(&input, imports::Input::Short { .. }) {
                return Err(err(
                    StatusCode::BAD_REQUEST,
                    import_failure(error)["code"]
                        .as_str()
                        .unwrap_or("platform_collection_invalid"),
                ));
            }
            let reference = imports::resolve(&app.platform_http, input, deadline)
                .await
                .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_collection_invalid"))?;
            imports::parse_collection(&reference.url, provider)
                .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_collection_invalid"))?
        }
    };
    let mode = body
        .credential_mode
        .unwrap_or(protocol::NativePlatformCredentialMode::Anonymous);
    if (mode == protocol::NativePlatformCredentialMode::Anonymous && body.account_id.is_some())
        || (!account_allowed(&collection)
            && (mode != protocol::NativePlatformCredentialMode::Anonymous
                || body.account_id.is_some()))
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    let account = match mode {
        protocol::NativePlatformCredentialMode::Anonymous => {
            platform_accounts::FrozenAccount::anonymous_for_provider(user, provider.as_str())?
        }
        protocol::NativePlatformCredentialMode::OwnOrAnonymous => tokio::time::timeout_at(
            deadline,
            platform_accounts::load_for_provider_playback(app, user, provider.as_str()),
        )
        .await
        .map_err(|_| err(StatusCode::REQUEST_TIMEOUT, "platform_import_deadline"))??,
    };
    if body.account_id.is_some() && body.account_id != account.account_id() {
        return Err(changed());
    }
    let login = media_authorization::login_hash(headers)?;
    // The typed enum contains only validated public identity components. Hashing
    // its closed representation never places an upstream address in the token.
    let key = hash(&format!("{}:{collection:?}", provider.as_str()));
    let fingerprint = account.continuation_fingerprint();
    let mut before = rooms::controller(app, headers, room).await?;
    platform_accounts::guard_for_publish(&mut before, user, &account).await?;
    let now: i64 =
        sqlx::query_scalar("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&mut *before)
            .await?;
    let (page, expires) = if let Some(token) = body.continuation.as_deref() {
        let continued = decode(app, token)?;
        if !matches_context(
            &continued,
            ContinuationContext {
                epoch: app.epoch,
                user,
                room,
                login: &login,
                collection: &key,
                mode,
                fingerprint: &fingerprint,
                now,
            },
        ) {
            return Err(changed());
        }
        (continued.page, continued.expires_at_ms)
    } else {
        (
            imports::CollectionPageRequest::default(),
            now.saturating_add(MAX_LIFETIME_MS),
        )
    };
    let expires = account
        .credential_expires_at_ms()
        .map_or(expires, |value| expires.min(value));
    if expires <= now {
        return Err(changed());
    }
    rooms::commit_controller(before, headers).await?;
    let result = imports::preview_collection_page(
        &app.platform_http,
        &collection,
        &page,
        account.cookie(),
        deadline,
    )
    .await;
    let mut after = rooms::controller(app, headers, room).await?;
    platform_accounts::guard_for_publish(&mut after, user, &account).await?;
    let now: i64 =
        sqlx::query_scalar("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&mut *after)
            .await?;
    if now >= expires || Instant::now() >= deadline {
        return Err(changed());
    }
    rooms::commit_controller(after, headers).await?;
    match result {
        Ok(result) => {
            let next = result
                .next
                .map(|page| {
                    encode(
                        app,
                        &Continuation {
                            purpose: PURPOSE.into(),
                            server_epoch: app.epoch,
                            user,
                            room,
                            login_hash: login,
                            collection_key: key,
                            credential_mode: mode,
                            account_fingerprint: fingerprint,
                            expires_at_ms: expires,
                            page,
                        },
                    )
                })
                .transpose()?;
            Ok(responses::ok_json(json!({
                "items":result.items.iter().map(reference_dto).collect::<Vec<_>>(),
                "failures":[],"truncated":result.has_more,"limit":imports::MAX_ITEMS,
                "next":next,"omitted":result.omitted,
            })))
        }
        Err(error) => Ok(responses::ok_json(json!({
            "items":[],"failures":[{"index":0,"error":import_failure(error)}],
            "truncated":false,"limit":imports::MAX_ITEMS,"next":null,"omitted":0,
        }))),
    }
}

pub(super) async fn preview_youtube(
    app: &App,
    headers: &HeaderMap,
    room: Uuid,
    user: Uuid,
    body: &PreviewRequest,
    candidate: &str,
    deadline: Instant,
) -> Result<Response> {
    use providers::platform::youtube::playlist;
    let reference = playlist::parse_resource(candidate)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_collection_invalid"))?;
    let mode = preview_credential_mode(body, Some(Provider::YouTube))?;
    let account = match mode {
        protocol::NativePlatformCredentialMode::Anonymous => {
            platform_accounts::FrozenAccount::anonymous_for_provider(user, "youtube")?
        }
        protocol::NativePlatformCredentialMode::OwnOrAnonymous => tokio::time::timeout_at(
            deadline,
            platform_accounts::load_for_provider_playback(app, user, "youtube"),
        )
        .await
        .map_err(|_| err(StatusCode::REQUEST_TIMEOUT, "platform_import_deadline"))??,
    };
    if body.account_id.is_some() && body.account_id != account.account_id() {
        return Err(changed());
    }
    let login = media_authorization::login_hash(headers)?;
    let key = hash(&format!("youtube:{}", reference.canonical()));
    let fingerprint = account.continuation_fingerprint();
    let mut before = rooms::controller(app, headers, room).await?;
    platform_accounts::guard_for_publish(&mut before, user, &account).await?;
    let now: i64 =
        sqlx::query_scalar("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&mut *before)
            .await?;
    let (page, boundary, expires) = if let Some(token) = body.continuation.as_deref() {
        let continued = decode(app, token)?;
        if !matches_context(
            &continued,
            ContinuationContext {
                epoch: app.epoch,
                user,
                room,
                login: &login,
                collection: &key,
                mode,
                fingerprint: &fingerprint,
                now,
            },
        ) || continued.page.offset != 0
            || continued.page.cursor.is_some()
            || continued.page.snapshot.is_none()
        {
            return Err(changed());
        }
        (
            continued.page.page,
            continued.page.snapshot,
            continued.expires_at_ms,
        )
    } else {
        (0, None, now.saturating_add(MAX_LIFETIME_MS))
    };
    let expires = account
        .credential_expires_at_ms()
        .map_or(expires, |value| expires.min(value));
    if expires <= now {
        return Err(changed());
    }
    rooms::commit_controller(before, headers).await?;
    let result = app
        .youtube
        .preview_playlist_page_with_boundary(
            &reference,
            playlist::Page { page },
            boundary.as_deref(),
            account.youtube_cookie(),
            deadline,
        )
        .await;
    let mut after = rooms::controller(app, headers, room).await?;
    platform_accounts::guard_for_publish(&mut after, user, &account).await?;
    let now: i64 =
        sqlx::query_scalar("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&mut *after)
            .await?;
    if now >= expires || Instant::now() >= deadline {
        return Err(changed());
    }
    rooms::commit_controller(after, headers).await?;
    match result {
        Ok(result) => {
            if result.next.is_some() && result.boundary_hash.is_none() {
                return Err(changed());
            }
            let next = result
                .next
                .map(|page| {
                    encode(
                        app,
                        &Continuation {
                            purpose: PURPOSE.into(),
                            server_epoch: app.epoch,
                            user,
                            room,
                            login_hash: login,
                            collection_key: key,
                            credential_mode: mode,
                            account_fingerprint: fingerprint,
                            expires_at_ms: expires,
                            page: imports::CollectionPageRequest {
                                page: page.page,
                                snapshot: result.boundary_hash.clone(),
                                ..Default::default()
                            },
                        },
                    )
                })
                .transpose()?;
            let items = result
                .preview
                .items
                .into_iter()
                .map(|item| {
                    reference_dto(&imports::Reference {
                        provider: Provider::YouTube,
                        url: item.video.canonical(),
                        part: 1,
                        title: item.title,
                    })
                })
                .collect::<Vec<_>>();
            Ok(responses::ok_json(json!({"items":items,"failures":[],
                "truncated":result.preview.truncated,"limit":imports::MAX_ITEMS,"next":next,
                "omitted":result.preview.unavailable})))
        }
        Err(error) => Ok(responses::ok_json(json!({"items":[],
            "failures":[{"index":0,"error":youtube_preview_failure(error)}],
            "truncated":false,"limit":imports::MAX_ITEMS,"next":null,"omitted":0}))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn continuation_binds_every_authority_axis_and_original_expiry() {
        let user = Uuid::new_v4();
        let room = Uuid::new_v4();
        let epoch = Uuid::new_v4();
        let value = Continuation {
            purpose: PURPOSE.into(),
            server_epoch: epoch,
            user,
            room,
            login_hash: "login".into(),
            collection_key: "collection".into(),
            credential_mode: protocol::NativePlatformCredentialMode::OwnOrAnonymous,
            account_fingerprint: "account".into(),
            expires_at_ms: 2000,
            page: imports::CollectionPageRequest {
                page: 1,
                ..Default::default()
            },
        };
        let valid = |epoch, user, room, login, key, mode, fingerprint, now| {
            matches_context(
                &value,
                ContinuationContext {
                    epoch,
                    user,
                    room,
                    login,
                    collection: key,
                    mode,
                    fingerprint,
                    now,
                },
            )
        };
        let mode = protocol::NativePlatformCredentialMode::OwnOrAnonymous;
        assert!(valid(
            epoch,
            user,
            room,
            "login",
            "collection",
            mode,
            "account",
            1000
        ));
        assert!(!valid(
            Uuid::new_v4(),
            user,
            room,
            "login",
            "collection",
            mode,
            "account",
            1000
        ));
        assert!(!valid(
            epoch,
            Uuid::new_v4(),
            room,
            "login",
            "collection",
            mode,
            "account",
            1000
        ));
        assert!(!valid(
            epoch,
            user,
            Uuid::new_v4(),
            "login",
            "collection",
            mode,
            "account",
            1000
        ));
        assert!(!valid(
            epoch,
            user,
            room,
            "new-login",
            "collection",
            mode,
            "account",
            1000
        ));
        assert!(!valid(
            epoch, user, room, "login", "other", mode, "account", 1000
        ));
        assert!(!valid(
            epoch,
            user,
            room,
            "login",
            "collection",
            protocol::NativePlatformCredentialMode::Anonymous,
            "account",
            1000
        ));
        assert!(!valid(
            epoch,
            user,
            room,
            "login",
            "collection",
            mode,
            "new-revision",
            1000
        ));
        assert!(!valid(
            epoch,
            user,
            room,
            "login",
            "collection",
            mode,
            "account",
            2000
        ));
        assert!(!valid(
            epoch,
            user,
            room,
            "login",
            "collection",
            mode,
            "account",
            -MAX_LIFETIME_MS
        ));
        let mut raw = serde_json::to_value(&value).unwrap();
        raw["cookie"] = json!("forbidden");
        assert!(serde_json::from_value::<Continuation>(raw).is_err());
    }
}
