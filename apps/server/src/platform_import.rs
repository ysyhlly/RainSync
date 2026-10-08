//! Explicit bounded preview/selection. No preview mutates a room, starts media
//! playback, consults somebody else's account, or crawls an upstream feed.
use crate::*;
use providers::platform::imports::{self, Provider};
use std::collections::HashSet;
use tokio::time::{Duration, Instant};
mod pagination;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewRequest {
    input: String,
    provider: Option<String>,
    #[serde(default)]
    collection: bool,
    credential_mode: Option<protocol::NativePlatformCredentialMode>,
    account_id: Option<Uuid>,
    collection_version: Option<u32>,
    continuation: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchItem {
    key: String,
    provider: String,
    url: String,
    part: Option<u32>,
    credential_mode: Option<protocol::NativePlatformCredentialMode>,
    account_id: Option<Uuid>,
    live_version: Option<u32>,
    course_version: Option<u32>,
}
impl BatchItem {
    fn input(self) -> native_platform::ImportRequest {
        native_platform::ImportRequest {
            provider: self.provider,
            url: self.url,
            part: self.part,
            credential_mode: self.credential_mode,
            account_id: self.account_id,
            live_version: self.live_version,
            course_version: self.course_version,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchRequest {
    items: Vec<BatchItem>,
}

fn live_version_for(provider: &str, url: &str) -> Option<u32> {
    if provider == "bilibili" && providers::platform::bilibili::live::parse_resource(url).is_ok() {
        return Some(1);
    }
    providers::platform::other_live::Provider::parse(provider)
        .ok()
        .and_then(|p| providers::platform::other_live::parse_resource(p, url).ok())
        .map(|_| 2)
}
fn reference_dto(reference: &imports::Reference) -> Value {
    let mut value = json!({"key":hash(&reference.key()),"provider":reference.provider.as_str(),"url":reference.url,"part":reference.part,"title":reference.title});
    if let Some(version) = live_version_for(reference.provider.as_str(), &reference.url) {
        value["live_version"] = json!(version);
    }
    if providers::platform::bilibili::course::parse_resource(&reference.url).is_ok() {
        value["course_version"] = json!(1);
    }
    value
}
fn import_failure(error: providers::platform::bilibili::Error) -> Value {
    let code = match error {
        providers::platform::bilibili::Error::Restricted("platform_collection_unsupported") => {
            "platform_collection_unsupported"
        }
        providers::platform::bilibili::Error::Deadline => "platform_import_deadline",
        providers::platform::bilibili::Error::Transport
        | providers::platform::bilibili::Error::Status(_) => "platform_import_unavailable",
        providers::platform::bilibili::Error::Api(_) => "platform_import_platform_restricted",
        providers::platform::bilibili::Error::TooLarge => "platform_import_limit",
        _ => "platform_import_invalid",
    };
    json!({"code":code,"retryable":matches!(code,"platform_import_deadline"|"platform_import_unavailable")})
}

fn youtube_preview_failure(error: providers::platform::youtube::Error) -> Value {
    use providers::platform::youtube::Error;
    let code = match error {
        Error::ProviderUnavailable | Error::InvalidConfiguration => {
            "platform_collection_provider_unavailable"
        }
        Error::InvalidResource => "platform_collection_invalid",
        Error::Deadline => "platform_import_deadline",
        Error::TooLarge => "platform_import_limit",
        Error::Unsupported => "platform_collection_restricted",
        Error::Cancelled => "platform_import_cancelled",
        Error::ProcessCleanupFailed => "platform_collection_cleanup_failed",
        Error::InvalidResponse | Error::ExtractorFailed => "platform_import_unavailable",
    };
    json!({"code":code,"retryable":matches!(code,"platform_import_deadline"|"platform_import_unavailable")})
}
fn preview_credential_mode(
    body: &PreviewRequest,
    provider: Option<Provider>,
) -> Result<protocol::NativePlatformCredentialMode> {
    let mode = body
        .credential_mode
        .unwrap_or(protocol::NativePlatformCredentialMode::Anonymous);
    // Only YouTube's closed ordinary playlist boundary supports a caller-owned
    // account. Public short links and other collections never receive cookies.
    if (mode == protocol::NativePlatformCredentialMode::Anonymous && body.account_id.is_some())
        || ((!body.collection
            || (provider != Some(Provider::YouTube)
                && !(body.collection_version == Some(2) && provider == Some(Provider::Bilibili))))
            && (mode != protocol::NativePlatformCredentialMode::Anonymous
                || body.account_id.is_some()))
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    Ok(mode)
}
async fn preview_youtube_playlist(
    app: &App,
    h: &HeaderMap,
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
        .map_err(|_| err(StatusCode::GATEWAY_TIMEOUT, "platform_import_deadline"))??,
    };
    if body.account_id.is_some() && body.account_id != account.account_id() {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    let mut before = rooms::controller(app, h, room).await?;
    platform_accounts::guard_for_publish(&mut before, user, &account).await?;
    rooms::commit_controller(before, h).await?;
    // No room mutation, media extraction, database lock or anonymous fallback.
    let result = app
        .youtube
        .preview_playlist_with_credential(&reference, account.youtube_cookie(), deadline)
        .await;
    let mut after = rooms::controller(app, h, room).await?;
    platform_accounts::guard_for_publish(&mut after, user, &account).await?;
    rooms::commit_controller(after, h).await?;
    let (items, failures, truncated) = match result {
        Ok(result) => {
            let items = result
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
            let failures = if result.unavailable > 0 {
                vec![
                    json!({"index":0,"error":{"code":"platform_collection_items_unavailable","retryable":false}}),
                ]
            } else {
                Vec::new()
            };
            (items, failures, result.truncated)
        }
        Err(error) => (
            Vec::new(),
            vec![json!({"index":0,"error":youtube_preview_failure(error)})],
            false,
        ),
    };
    Ok(responses::ok_json(
        json!({"items":items,"failures":failures,"truncated":truncated,"limit":imports::MAX_ITEMS}),
    ))
}
pub async fn preview(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    Json(body): Json<PreviewRequest>,
) -> Result<Response> {
    if body.collection_version.is_some_and(|version| version != 2)
        || (body.collection_version.is_some() && !body.collection)
        || (body.continuation.is_some() && body.collection_version != Some(2))
    {
        return Err(err(StatusCode::BAD_REQUEST, "platform_collection_invalid"));
    }
    let selected = body
        .provider
        .as_deref()
        .map(Provider::parse)
        .transpose()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_import_invalid"))?;
    let candidates = imports::candidates(&body.input)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_import_limit"))?;
    if body.collection && candidates.len() != 1 {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "platform_collection_single_required",
        ));
    }
    let provider = candidates
        .first()
        .and_then(|candidate| imports::recognize(candidate))
        .or(selected);
    preview_credential_mode(&body, provider)?;
    let user = auth(&app, &h, true).await?;
    rooms::controller(&app, &h, room).await?.rollback().await?;
    let deadline = Instant::now() + Duration::from_secs(40);
    if body.collection && provider == Some(Provider::YouTube) {
        if body.collection_version == Some(2) {
            return pagination::preview_youtube(
                &app,
                &h,
                room,
                user.id,
                &body,
                &candidates[0],
                deadline,
            )
            .await;
        }
        return preview_youtube_playlist(&app, &h, room, user.id, &body, &candidates[0], deadline)
            .await;
    }
    if body.collection && body.collection_version == Some(2) {
        return pagination::preview(
            &app,
            &h,
            room,
            user.id,
            &body,
            (
                &candidates[0],
                provider
                    .ok_or_else(|| err(StatusCode::BAD_REQUEST, "platform_collection_invalid"))?,
            ),
            deadline,
        )
        .await;
    }
    let mut items = Vec::new();
    let mut failures = Vec::new();
    let mut seen = HashSet::new();
    let mut truncated = false;
    for (index, candidate) in candidates.iter().enumerate() {
        // Auto detection allows a mixed paste; the selected provider is only a
        // fallback for bare identifiers. The typed parser enforces each origin.
        let provider = imports::recognize(candidate).or(selected);
        let outcome = async {
            let provider = provider.ok_or(providers::platform::bilibili::Error::InvalidResource)?;
            if body.collection {
                let collection = match imports::parse_collection(candidate, provider) {
                    Ok(collection) => collection,
                    Err(error) if provider == Provider::Bilibili => {
                        if !matches!(
                            imports::parse_input(candidate, Some(provider)),
                            Ok(imports::Input::Short { .. })
                        ) {
                            return Err(error);
                        }
                        let input = imports::parse_input(candidate, Some(provider))?;
                        let reference =
                            imports::resolve(&app.platform_http, input, deadline).await?;
                        imports::parse_collection(&reference.url, provider)?
                    }
                    Err(error) => return Err(error),
                };
                if matches!(
                    collection,
                    imports::Collection::PgcSeason { .. }
                        | imports::Collection::CourseSeason { .. }
                        | imports::Collection::TikTokPlaylist { .. }
                        | imports::Collection::DouyinMix { .. }
                ) {
                    return Err(providers::platform::bilibili::Error::Restricted(
                        "platform_collection_unsupported",
                    ));
                }
                let result =
                    imports::preview_collection(&app.platform_http, &collection, deadline).await?;
                Ok((result.items, result.truncated))
            } else {
                let input = imports::parse_input(candidate, Some(provider))?;
                let mut reference = imports::resolve(&app.platform_http, input, deadline).await?;
                if let Ok(room) =
                    providers::platform::bilibili::live::parse_resource(&reference.url)
                {
                    let metadata =
                        providers::platform::bilibili::live::Client::new(app.platform_http, None)
                            .view(&room, deadline)
                            .await?;
                    reference.url = metadata.canonical();
                    reference.title = Some(metadata.title);
                }
                Ok((vec![reference], false))
            }
        }
        .await;
        match outcome {
            Ok((references, limited)) => {
                truncated |= limited;
                for reference in references {
                    if seen.insert(reference.key()) {
                        items.push(reference_dto(&reference));
                    }
                }
            }
            Err(error) => failures.push(json!({"index":index,"error":import_failure(error)})),
        }
    }
    // A preview cannot be published to a revoked owner or expired login.
    let tx = rooms::controller(&app, &h, room).await?;
    rooms::commit_controller(tx, &h).await?;
    Ok(responses::ok_json(
        json!({"items":items,"failures":failures,"truncated":truncated,"limit":imports::MAX_ITEMS}),
    ))
}
fn validate_batch(body: &BatchRequest) -> Result<()> {
    if body.items.is_empty() || body.items.len() > imports::MAX_ITEMS {
        return Err(err(StatusCode::BAD_REQUEST, "platform_import_limit"));
    }
    let mut keys = HashSet::new();
    for item in &body.items {
        if live_version_for(&item.provider, &item.url) != item.live_version {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "native_live_client_unsupported",
            ));
        }
        let course = providers::platform::bilibili::course::parse_resource(&item.url).is_ok();
        if (course && item.course_version != Some(1)) || (!course && item.course_version.is_some())
        {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "native_course_client_unsupported",
            ));
        }
        native_platform::import_credential_mode(&item.clone().input())?;
        if item.key.len() != 64
            || !item.key.bytes().all(|b| b.is_ascii_hexdigit())
            || !keys.insert(&item.key)
            || item.url.len() > 2048
        {
            return Err(err(StatusCode::BAD_REQUEST, "platform_import_invalid"));
        }
        // A selected batch uses only canonical video identities from preview.
        // It cannot restart collection expansion or shortlink discovery.
        let provider = Provider::parse(&item.provider)
            .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_import_invalid"))?;
        let reference = match imports::parse_input(&item.url, Some(provider))
            .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_import_invalid"))?
        {
            imports::Input::Video(reference) => reference,
            _ => {
                return Err(err(
                    StatusCode::BAD_REQUEST,
                    "platform_import_preview_required",
                ));
            }
        };
        if item.part.is_some_and(|part| part != reference.part)
            || item.url != reference.url
            || item.key != hash(&reference.key())
        {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "platform_import_selection_changed",
            ));
        }
    }
    Ok(())
}
fn stop_after(error: &Error) -> bool {
    error.0 == StatusCode::UNAUTHORIZED
        || error.0 == StatusCode::FORBIDDEN
        || matches!(
            error.1.as_str(),
            "platform_account_changed"
                | "session_expired"
                | "not_a_member"
                | "not_owner"
                | "room_closed"
        )
}
fn retryable(error: &Error) -> bool {
    error.0.is_server_error()
        || error.0 == StatusCode::TOO_MANY_REQUESTS
        || error.1 == "platform_account_changed"
}
// A batch can succeed at HTTP level while individual entries fail. Give each
// failure its own correlation ID and log only the closed protocol category.
fn outcome_failure(
    code: &str,
    retryable: bool,
    attempted: bool,
    status: Option<StatusCode>,
) -> Value {
    let request_id = Uuid::new_v4();
    let category = protocol::ErrorCode::from_reason(code, status.map_or(409, |s| s.as_u16()));
    tracing::warn!(%request_id, code = ?category, status = status.map(|s| s.as_u16()), attempted, "platform import item failed");
    let mut value =
        json!({"code":code,"retryable":retryable,"attempted":attempted,"request_id":request_id});
    if let Some(status) = status {
        value["status"] = json!(status.as_u16());
    }
    value
}
async fn collect_outcomes<F, Fut>(
    items: Vec<BatchItem>,
    deadline: Instant,
    mut import: F,
) -> (Vec<Value>, Option<String>)
where
    F: FnMut(BatchItem) -> Fut,
    Fut: std::future::Future<Output = Result<Value>>,
{
    let mut outcomes = Vec::new();
    let mut stop: Option<String> = None;
    for item in items {
        if stop.is_none() && Instant::now() >= deadline {
            stop = Some("platform_import_deadline".into());
        }
        if let Some(code) = &stop {
            outcomes.push(json!({"key":item.key,"error":outcome_failure(code,true,false,None)}));
            continue;
        }
        let key = item.key.clone();
        match tokio::time::timeout_at(deadline, import(item)).await {
            Ok(Ok(media)) => outcomes.push(json!({"key":key,"media":media})),
            Ok(Err(error)) => {
                let retry = retryable(&error);
                if stop_after(&error) {
                    stop = Some(error.1.clone());
                }
                outcomes.push(
                    json!({"key":key,"error":outcome_failure(&error.1,retry,true,Some(error.0))}),
                );
            }
            Err(_) => {
                stop = Some("platform_import_deadline".into());
                outcomes.push(json!({"key":key,"error":outcome_failure("platform_import_deadline",true,true,Some(StatusCode::GATEWAY_TIMEOUT))}));
            }
        }
    }
    (outcomes, stop)
}
pub async fn batch(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    Json(body): Json<BatchRequest>,
) -> Result<Response> {
    validate_batch(&body)?;
    if !app.other_live_enabled && body.items.iter().any(|item| item.live_version == Some(2)) {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_other_live_provider_unavailable",
        ));
    }
    let user = auth(&app, &h, true).await?;
    rooms::controller(&app, &h, room).await?.rollback().await?;
    let deadline = Instant::now() + Duration::from_secs(120);
    // Freeze each requested own-provider account exactly once for this batch.
    // Reconnect/revoke/revision/expiry changes stop subsequent credentialed work,
    // including anonymous fallback changing into a newly connected account.
    let mut accounts = HashMap::new();
    for item in &body.items {
        if item.credential_mode == Some(protocol::NativePlatformCredentialMode::OwnOrAnonymous)
            && !accounts.contains_key(&item.provider)
        {
            let account = tokio::time::timeout_at(
                deadline,
                platform_accounts::load_for_provider_playback(&app, user.id, &item.provider),
            )
            .await
            .map_err(|_| err(StatusCode::GATEWAY_TIMEOUT, "platform_import_deadline"))??;
            accounts.insert(item.provider.clone(), account);
        }
    }
    for item in &body.items {
        if item.account_id.is_some()
            && item.account_id
                != accounts
                    .get(&item.provider)
                    .and_then(|account| account.account_id())
        {
            return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
        }
    }
    let (outcomes, stop) = collect_outcomes(body.items, deadline, |item| {
        let frozen = if item.credential_mode
            == Some(protocol::NativePlatformCredentialMode::OwnOrAnonymous)
        {
            accounts.get(&item.provider)
        } else {
            None
        };
        native_platform::import_one_with_frozen(&app, &h, room, item.input(), frozen)
    })
    .await;
    // Prior mutations remain idempotent, but their private room metadata must
    // never be returned after controller/login revocation during a later item.
    let tx = rooms::controller(&app, &h, room).await?;
    rooms::commit_controller(tx, &h).await?;
    Ok(responses::ok_json(
        json!({"outcomes":outcomes,"stopped":stop}),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn item() -> Value {
        let r = match imports::parse_input("BV1xx411c7mD", Some(Provider::Bilibili)).unwrap() {
            imports::Input::Video(r) => r,
            _ => panic!(),
        };
        json!({"key":hash(&r.key()),"provider":"bilibili","url":r.url,"part":1})
    }
    #[test]
    fn collection_preview_credential_intent_is_provider_scoped_and_closed() {
        let request = |value| serde_json::from_value::<PreviewRequest>(value).unwrap();
        let anonymous =
            request(json!({"input":"PLBB231211A4F62143","provider":"youtube","collection":true}));
        assert_eq!(
            preview_credential_mode(&anonymous, Some(Provider::YouTube)).unwrap(),
            protocol::NativePlatformCredentialMode::Anonymous
        );
        let own = request(
            json!({"input":"PLBB231211A4F62143","provider":"youtube","collection":true,"credential_mode":"own_or_anonymous","account_id":Uuid::from_u128(2)}),
        );
        assert_eq!(
            preview_credential_mode(&own, Some(Provider::YouTube)).unwrap(),
            protocol::NativePlatformCredentialMode::OwnOrAnonymous
        );
        for provider in [
            None,
            Some(Provider::Bilibili),
            Some(Provider::TikTok),
            Some(Provider::Douyin),
        ] {
            assert!(preview_credential_mode(&own, provider).is_err());
        }
        let mut invalid = json!({"input":"PLBB231211A4F62143","provider":"youtube","collection":false,"credential_mode":"own_or_anonymous"});
        assert!(
            preview_credential_mode(&request(invalid.clone()), Some(Provider::YouTube)).is_err()
        );
        invalid["collection"] = json!(true);
        invalid["credential_mode"] = json!("anonymous");
        invalid["account_id"] = json!(Uuid::from_u128(2));
        assert!(preview_credential_mode(&request(invalid), Some(Provider::YouTube)).is_err());
        assert!(
            serde_json::from_value::<PreviewRequest>(
                json!({"input":"PLBB231211A4F62143","cookies":"never-admit"})
            )
            .is_err()
        );
        assert_eq!(
            youtube_preview_failure(providers::platform::youtube::Error::Unsupported)["code"],
            "platform_collection_restricted"
        );
        assert_eq!(
            youtube_preview_failure(providers::platform::youtube::Error::ProcessCleanupFailed)["retryable"],
            false
        );
    }
    #[test]
    fn youtube_selected_batch_never_restarts_playlist_discovery_or_exposes_metadata() {
        let reference = match imports::parse_input("dQw4w9WgXcQ", Some(Provider::YouTube)).unwrap()
        {
            imports::Input::Video(r) => r,
            _ => panic!(),
        };
        let dto = reference_dto(&reference);
        assert_eq!(dto["provider"], "youtube");
        assert_eq!(dto["part"], 1);
        let input = json!({"key":hash(&reference.key()),"provider":"youtube","url":reference.url,"part":1,"credential_mode":"anonymous"});
        assert!(
            validate_batch(&serde_json::from_value(json!({"items":[input.clone()]})).unwrap())
                .is_ok()
        );
        for url in [
            "https://www.youtube.com/playlist?list=PLBB231211A4F62143",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLBB231211A4F62143",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://evil.test/watch?v=dQw4w9WgXcQ",
        ] {
            let mut changed = input.clone();
            changed["url"] = json!(url);
            assert!(
                validate_batch(&serde_json::from_value(json!({"items":[changed]})).unwrap())
                    .is_err()
            );
        }
    }
    #[test]
    fn selection_is_bounded_exact_and_canonical() {
        let input = item();
        let body: BatchRequest = serde_json::from_value(json!({"items":[input.clone()]})).unwrap();
        validate_batch(&body).unwrap();
        let body: BatchRequest =
            serde_json::from_value(json!({"items":[input.clone(),input.clone()]})).unwrap();
        assert!(validate_batch(&body).is_err());
        let mut wrong = input.clone();
        wrong["part"] = json!(2);
        assert!(
            validate_batch(&serde_json::from_value(json!({"items":[wrong]})).unwrap()).is_err()
        );
        let mut wrong = input.clone();
        wrong["url"] = json!("https://b23.tv/ABC1234");
        assert!(
            validate_batch(&serde_json::from_value(json!({"items":[wrong]})).unwrap()).is_err()
        );
        let mut wrong = input;
        wrong["cookie"] = json!("synthetic-private-data");
        assert!(serde_json::from_value::<BatchRequest>(json!({"items":[wrong]})).is_err());
    }
    #[test]
    fn canonical_course_selection_requires_opt_in_and_never_restarts_discovery() {
        let reference =
            match imports::parse_input("course:ep9007199254740993", Some(Provider::Bilibili))
                .unwrap()
            {
                imports::Input::Video(reference) => reference,
                _ => panic!(),
            };
        let input = json!({"key":hash(&reference.key()),"provider":"bilibili","url":reference.url,"part":1,"course_version":1,"credential_mode":"own_or_anonymous","account_id":Uuid::from_u128(4)});
        let body: BatchRequest = serde_json::from_value(json!({"items":[input.clone()]})).unwrap();
        assert!(validate_batch(&body).is_ok());
        let dto = reference_dto(&reference);
        assert_eq!(dto["course_version"], 1);
        assert!(dto.get("live_version").is_none());
        for field in [
            "key",
            "provider",
            "url",
            "part",
            "course_version",
            "live_version",
        ] {
            let mut wrong = input.clone();
            wrong[field] = match field {
                "key" => json!("b".repeat(64)),
                "provider" => json!("youtube"),
                "url" => json!("https://www.bilibili.com/cheese/play/ep70"),
                "part" => json!(2),
                _ => json!(2),
            };
            assert!(
                validate_batch(&serde_json::from_value(json!({"items":[wrong]})).unwrap()).is_err()
            );
        }
        let mut wrong = input.clone();
        wrong.as_object_mut().unwrap().remove("course_version");
        assert!(
            validate_batch(&serde_json::from_value(json!({"items":[wrong]})).unwrap()).is_err()
        );
        for url in [
            "course:ep9007199254740993",
            "https://b23.tv/ABC1234",
            "https://www.bilibili.com/cheese/play/ss12345",
            "https://www.bilibili.com/cheese/play/ep9007199254740993?p=2",
        ] {
            let mut wrong = input.clone();
            wrong["url"] = json!(url);
            assert!(
                validate_batch(&serde_json::from_value(json!({"items":[wrong]})).unwrap()).is_err()
            );
        }
    }
    #[test]
    fn security_revocation_stops_batch() {
        for error in [
            err(StatusCode::FORBIDDEN, "not_owner"),
            err(StatusCode::UNAUTHORIZED, "session_expired"),
            err(StatusCode::CONFLICT, "platform_account_changed"),
        ] {
            assert!(stop_after(&error));
        }
        assert!(!stop_after(&err(
            StatusCode::BAD_GATEWAY,
            "native_platform_unavailable"
        )));
    }
    fn batch_items(count: usize) -> Vec<BatchItem> {
        (0..count)
            .map(|_| serde_json::from_value(item()).unwrap())
            .collect()
    }
    #[tokio::test]
    async fn partial_failure_preserves_order_and_successes() {
        let mut replies = std::collections::VecDeque::from([
            Ok(json!({"id":"first"})),
            Err(err(
                StatusCode::BAD_GATEWAY,
                "native_platform_resolve_failed",
            )),
            Ok(json!({"id":"third"})),
        ]);
        let (outcomes, stop) = collect_outcomes(
            batch_items(3),
            Instant::now() + Duration::from_secs(1),
            |_| std::future::ready(replies.pop_front().unwrap()),
        )
        .await;
        assert!(stop.is_none());
        assert_eq!(outcomes[0]["media"]["id"], "first");
        assert_eq!(outcomes[1]["error"]["retryable"], true);
        assert_eq!(
            outcomes[1]["error"]["code"],
            "native_platform_resolve_failed"
        );
        assert_eq!(outcomes[1]["error"]["status"], 502);
        assert!(Uuid::parse_str(outcomes[1]["error"]["request_id"].as_str().unwrap()).is_ok());
        assert_eq!(outcomes[2]["media"]["id"], "third");
    }
    #[tokio::test]
    async fn revocation_and_global_deadline_do_not_attempt_remaining_items() {
        let mut calls = 0;
        let (outcomes, stop) = collect_outcomes(
            batch_items(3),
            Instant::now() + Duration::from_secs(1),
            |_| {
                calls += 1;
                std::future::ready(Err(err(StatusCode::CONFLICT, "platform_account_changed")))
            },
        )
        .await;
        assert_eq!(calls, 1);
        assert_eq!(stop.as_deref(), Some("platform_account_changed"));
        assert_eq!(outcomes[1]["error"]["attempted"], false);
        assert!(outcomes[1]["error"].get("status").is_none());
        assert_ne!(
            outcomes[0]["error"]["request_id"],
            outcomes[1]["error"]["request_id"]
        );
        let (outcomes, stop) =
            collect_outcomes(batch_items(2), Instant::now(), |_| std::future::pending()).await;
        assert_eq!(stop.as_deref(), Some("platform_import_deadline"));
        assert_eq!(outcomes[0]["error"]["attempted"], false);
        assert_eq!(outcomes[1]["error"]["attempted"], false);
    }
}
