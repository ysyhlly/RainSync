//! Private, same-origin platform subtitles and original-site text-only danmaku.
//! Every request reuses the immutable media grant gate; IDs never become URLs.
//! No global catalog/cache, borrowed credentials, raw upstream body or comment
//! publication exists. Bounded protobuf windows retain original source time;
//! advanced programs remain bounded data for the isolated client interpreter.
use crate::*;
use axum::extract::Query;
use providers::platform::{
    bilibili::{course, pgc},
    short_video,
    text::{self, Availability, Catalog, SubtitleDescriptor, TextRequest},
    youtube,
};
use tokio::time::{Duration, Instant as Deadline};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenQuery {
    token: String,
}
enum Operation {
    Catalog,
    Subtitle(String),
    Danmaku(u64, u8),
}
pub async fn catalog(
    State(app): State<App>,
    headers: HeaderMap,
    Path(session): Path<Uuid>,
    Query(query): Query<TokenQuery>,
) -> Result<Response> {
    execute(app, headers, session, query.token, Operation::Catalog).await
}
pub async fn subtitle(
    State(app): State<App>,
    headers: HeaderMap,
    Path((session, id)): Path<(Uuid, String)>,
    Query(query): Query<TokenQuery>,
) -> Result<Response> {
    if !track_id(&id) {
        return Err(err(StatusCode::BAD_REQUEST, "native_platform_text_invalid"));
    }
    execute(app, headers, session, query.token, Operation::Subtitle(id)).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DanmakuQuery {
    token: String,
    #[serde(default)]
    at_ms: u64,
    #[serde(default = "legacy_rendering_version")]
    rendering_version: u8,
}
fn legacy_rendering_version() -> u8 {
    1
}
pub async fn danmaku(
    State(app): State<App>,
    headers: HeaderMap,
    Path(session): Path<Uuid>,
    Query(query): Query<DanmakuQuery>,
) -> Result<Response> {
    if query.at_ms > 604_800_000 || !matches!(query.rendering_version, 1..=3) {
        return Err(err(StatusCode::BAD_REQUEST, "native_platform_text_invalid"));
    }
    execute(
        app,
        headers,
        session,
        query.token,
        Operation::Danmaku(query.at_ms, query.rendering_version),
    )
    .await
}
fn track_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
async fn execute(
    app: App,
    headers: HeaderMap,
    session: Uuid,
    token: String,
    operation: Operation,
) -> Result<Response> {
    // HTTP cancellation cannot orphan an extractor owner. Shared registry and
    // scoped tree drain also make server shutdown include optional captions.
    let owner = app.preparations.admit().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "playback_request_interrupted",
        )
    })?;
    tokio::spawn(async move {
        let scope=media_core::child_process::Scope::new();
        let deadline=Deadline::now()+Duration::from_secs(35);
        let result=scope.run(async {tokio::select! {biased;
            _=owner.cancelled()=>Err(err(StatusCode::SERVICE_UNAVAILABLE,"playback_request_interrupted")),
            result=tokio::time::timeout_at(deadline,resolve(&app,&headers,session,&token,operation,deadline))=>result.unwrap_or_else(|_|Err(err(StatusCode::GATEWAY_TIMEOUT,"native_platform_text_timeout"))),
        }}).await;
        scope.shutdown().await.map_err(anyhow::Error::from)?;
        drop(owner);result
    }).await.map_err(anyhow::Error::from)?
}
async fn resolve(
    app: &App,
    headers: &HeaderMap,
    session: Uuid,
    token: &str,
    operation: Operation,
    deadline: Deadline,
) -> Result<Response> {
    let scope = platform_media::admit_text(app, headers, session, token).await?;
    let mut result = match operation {
        Operation::Catalog => {
            let catalog = discover(app, &scope, deadline).await?;
            let tracks: Vec<_> = catalog.tracks.into_iter().map(|d| d.track).collect();
            responses::ok_json(
                json!({"subtitle_tracks":tracks,"subtitles_status":catalog.status,"danmaku_status":if scope.entry.provider=="bilibili"{Availability::Available}else{Availability::Unsupported}}),
            )
        }
        Operation::Subtitle(id) => {
            let catalog = discover(app, &scope, deadline).await?;
            let descriptor = catalog
                .tracks
                .into_iter()
                .find(|d| d.track.id == id)
                .ok_or_else(|| {
                    err(
                        StatusCode::NOT_FOUND,
                        "native_platform_subtitle_unavailable",
                    )
                })?;
            // Revalidate the immutable account/media/viewer gate after discovery
            // and before requesting the catalog-owned caption address.
            platform_media::check_text(app, &scope).await?;
            let request = TextRequest::subtitle(&descriptor).map_err(text_error)?;
            let body = text::fetch(&app.platform_http, request, deadline)
                .await
                .map_err(text_error)?;
            let cues = text::subtitle_cues(descriptor.format, &body).map_err(text_error)?;
            let vtt = text::render_vtt(&cues).map_err(text_error)?;
            let mut response = Response::new(axum::body::Body::from(vtt));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                "text/vtt; charset=utf-8".parse().unwrap(),
            );
            private_headers(&mut response);
            response
        }
        Operation::Danmaku(at_ms, rendering_version) => {
            if scope.entry.provider != "bilibili" {
                return Err(err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "native_platform_danmaku_unsupported",
                ));
            }
            if at_ms >= scope.duration_ms {
                return Err(err(
                    StatusCode::BAD_REQUEST,
                    "native_platform_danmaku_time_invalid",
                ));
            }
            let cid = cid(&scope)?;
            let segment = u32::try_from(at_ms / 360_000 + 1).map_err(|_| {
                err(
                    StatusCode::BAD_REQUEST,
                    "native_platform_danmaku_time_invalid",
                )
            })?;
            let mut cues = Vec::new();
            // At most two packages, including previous cues that may still be
            // visible across a package edge. Never whole-film prefetch/cache.
            for index in segment.saturating_sub(1).max(1)..=segment {
                platform_media::check_text(app, &scope).await?;
                let bytes = text::fetch(
                    &app.platform_http,
                    TextRequest::bilibili_segment(cid, index).map_err(text_error)?,
                    deadline,
                )
                .await
                .map_err(text_error)?;
                cues.extend(text::parse_bilibili_segment(&bytes, index).map_err(text_error)?);
            }
            let mut warnings = Vec::new();
            if rendering_version == 3 {
                // BAS lives in metadata-owned special packs, not seg.so. No
                // account credentials or upstream URLs reach the browser.
                let from = u64::from(segment - 1)
                    .saturating_mul(360_000)
                    .saturating_sub(120_000);
                let to = (u64::from(segment) * 360_000).min(scope.duration_ms);
                // Optional artwork must leave time to return ordinary cues and
                // recheck the grant, even when its metadata/CDN stalls.
                let advanced_deadline = deadline
                    .checked_sub(Duration::from_secs(2))
                    .unwrap_or_else(Deadline::now)
                    .min(Deadline::now() + Duration::from_secs(8));
                platform_media::check_text(app, &scope).await?;
                match text::fetch(
                    &app.platform_http,
                    TextRequest::bilibili_danmaku_view(cid).map_err(text_error)?,
                    advanced_deadline,
                )
                .await
                .and_then(|bytes| {
                    text::parse_bilibili_view(&bytes, cid, &scope.entry.content_id, from, to)
                }) {
                    Ok(view) => {
                        cues.extend(view.cues);
                        for request in view.special_requests {
                            platform_media::check_text(app, &scope).await?;
                            match text::fetch(&app.platform_http, request, advanced_deadline)
                                .await
                                .and_then(|bytes| text::parse_bilibili_special(&bytes, from, to))
                            {
                                Ok(special) => cues.extend(special),
                                Err(_) => {
                                    warnings.push("部分高级弹幕数据包加载失败".to_owned());
                                    break;
                                }
                            }
                        }
                    }
                    Err(_) => warnings.push("高级及交互弹幕元数据暂不可用".to_owned()),
                }
            }
            let cues = text::bounded_danmaku(cues)
                .into_iter()
                .filter(|cue| cue.at_ms <= scope.duration_ms)
                .collect::<Vec<_>>();
            let mut cues = if rendering_version == 1 {
                text::legacy_danmaku(cues)
            } else {
                cues
            };
            if rendering_version == 2 {
                cues.retain(|c| c.program.is_none() && c.interaction.is_none());
            }
            if rendering_version == 3 {
                responses::ok_json(json!({"cues":cues,"snapshot":true,"warnings":warnings}))
            } else {
                responses::ok_json(json!({"cues":cues,"snapshot":true}))
            }
        }
    };
    platform_media::check_text(app, &scope).await?;
    private_headers(&mut result);
    Ok(result)
}
fn cid(scope: &platform_media::TextScope) -> Result<u64> {
    scope
        .entry
        .cid
        .and_then(|n| u64::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| err(StatusCode::CONFLICT, "native_platform_entry_changed"))
}
async fn discover(
    app: &App,
    scope: &platform_media::TextScope,
    deadline: Deadline,
) -> Result<Catalog> {
    platform_media::check_text(app, scope).await?;
    let catalog = match scope.entry.provider.as_str() {
        "bilibili" => {
            let cid = cid(scope)?;
            let (request, aid) = if let Some(identity) = scope.entry.identity() {
                let ep = identity
                    .ep_id()
                    .parse::<u64>()
                    .map_err(|_| err(StatusCode::CONFLICT, "native_platform_entry_changed"))?;
                let season = identity
                    .season_id()
                    .parse::<u64>()
                    .map_err(|_| err(StatusCode::CONFLICT, "native_platform_entry_changed"))?;
                let aid =
                    if identity.is_pgc() {
                        let metadata =
                            pgc::Client::new(app.platform_http, scope.account.cookie().cloned())
                                .view(
                                    &pgc::EpisodeRef {
                                        ep_id: identity.ep_id().into(),
                                    },
                                    deadline,
                                )
                                .await
                                .map_err(text_error)?;
                        if metadata.ep_id != identity.ep_id()
                            || metadata.cid != identity.cid()
                            || metadata.season_id != identity.season_id()
                        {
                            return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
                        }
                        metadata.aid.parse::<u64>().map_err(|_| {
                            err(StatusCode::BAD_GATEWAY, "native_platform_text_invalid")
                        })?
                    } else {
                        let metadata =
                            course::Client::new(app.platform_http, scope.account.cookie().cloned())
                                .view(
                                    &course::EpisodeRef {
                                        ep_id: identity.ep_id().into(),
                                    },
                                    deadline,
                                )
                                .await
                                .map_err(text_error)?;
                        if metadata.ep_id != identity.ep_id()
                            || metadata.cid != identity.cid()
                            || metadata.season_id != identity.season_id()
                            || Some(metadata.aid.as_str()) != identity.aid()
                        {
                            return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
                        }
                        metadata.aid.parse::<u64>().map_err(|_| {
                            err(StatusCode::BAD_GATEWAY, "native_platform_text_invalid")
                        })?
                    };
                platform_media::check_text(app, scope).await?;
                (
                    TextRequest::bilibili_episode_player(
                        aid,
                        cid,
                        identity.is_pgc().then_some((ep, season)),
                        scope.account.cookie(),
                    )
                    .map_err(text_error)?,
                    Some(aid),
                )
            } else {
                (
                    TextRequest::bilibili_player(
                        &scope.entry.content_id,
                        cid,
                        scope.account.cookie(),
                    )
                    .map_err(text_error)?,
                    None,
                )
            };
            let bytes = text::fetch(&app.platform_http, request, deadline)
                .await
                .map_err(text_error)?;
            if let Some(aid) = aid {
                text::parse_bilibili_episode_catalog(&bytes, aid, cid, &scope.entry.content_id)
                    .map_err(text_error)?
            } else {
                text::parse_bilibili_catalog(&bytes, &scope.entry.content_id, cid)
                    .map_err(text_error)?
            }
        }

        "youtube" => {
            let tracks = match scope.account.youtube_cookie() {
                Some(credential) => {
                    app.youtube
                        .caption_catalog_authenticated(
                            &scope.entry.resource(),
                            credential,
                            deadline,
                        )
                        .await
                }
                None if scope.account.account_id().is_some() => {
                    return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
                }
                None => {
                    app.youtube
                        .caption_catalog(&scope.entry.resource(), deadline)
                        .await
                }
            }
            .map_err(youtube_error)?;
            if tracks
                .iter()
                .any(|d| d.content_id != scope.entry.content_id)
            {
                return Err(err(StatusCode::BAD_GATEWAY, "native_platform_text_invalid"));
            }
            Catalog {
                status: if tracks.is_empty() {
                    Availability::None
                } else {
                    Availability::Available
                },
                tracks,
            }
        }
        "douyin" | "tiktok" => {
            let platform = if scope.entry.provider == "douyin" {
                short_video::Platform::Douyin
            } else {
                short_video::Platform::TikTok
            };
            let credential = scope.account.short_cookie();
            if scope.account.account_id().is_some() && credential.is_none() {
                return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
            }
            let catalog = short_video::Resolver::new(app.platform_http)
                .caption_catalog(platform, &scope.entry.resource(), credential, deadline)
                .await
                .map_err(short_text_error)?;
            if catalog
                .tracks
                .iter()
                .any(|d| d.content_id != scope.entry.content_id)
            {
                return Err(err(StatusCode::BAD_GATEWAY, "native_platform_text_invalid"));
            }
            catalog
        }
        _ => Catalog {
            tracks: Vec::<SubtitleDescriptor>::new(),
            status: Availability::Unsupported,
        },
    };
    platform_media::check_text(app, scope).await?;
    Ok(catalog)
}
fn private_headers(response: &mut Response) {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
}
fn text_error(error: providers::platform::bilibili::Error) -> Error {
    use providers::platform::bilibili::Error as E;
    match error {
        E::Deadline => err(StatusCode::GATEWAY_TIMEOUT, "native_platform_text_timeout"),
        E::Api(-101) | E::Status(401) => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_subtitle_login_required",
        ),
        E::Restricted(_) | E::Status(403 | 429) | E::Api(_) => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_text_unavailable",
        ),
        _ => err(StatusCode::BAD_GATEWAY, "native_platform_text_invalid"),
    }
}
fn short_text_error(error: short_video::Error) -> Error {
    match error {
        short_video::Error::Deadline => {
            err(StatusCode::GATEWAY_TIMEOUT, "native_platform_text_timeout")
        }
        short_video::Error::Restricted("login_required") | short_video::Error::Status(401) => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_subtitle_login_required",
        ),
        short_video::Error::Restricted("caption_identity_ambiguous") => err(
            StatusCode::NOT_FOUND,
            "native_platform_subtitle_unavailable",
        ),
        short_video::Error::Restricted("caption_metadata_unavailable") => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_caption_metadata_unavailable",
        ),
        short_video::Error::Restricted("caption_format_unsupported") => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_caption_format_unsupported",
        ),
        short_video::Error::Restricted("caption_origin_or_path_unsupported") => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_caption_origin_unsupported",
        ),
        short_video::Error::Unsupported(short_video::Unsupported::SigningRequired)
        | short_video::Error::Restricted("platform_challenge") => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_caption_signing_required",
        ),
        short_video::Error::Restricted(_)
        | short_video::Error::Unsupported(_)
        | short_video::Error::Api(_)
        | short_video::Error::Status(_) => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_text_unavailable",
        ),
        _ => err(StatusCode::BAD_GATEWAY, "native_platform_text_invalid"),
    }
}
fn youtube_error(error: youtube::Error) -> Error {
    match error {
        youtube::Error::ProviderUnavailable => err(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_platform_provider_unavailable",
        ),
        youtube::Error::Deadline => {
            err(StatusCode::GATEWAY_TIMEOUT, "native_platform_text_timeout")
        }
        youtube::Error::Unsupported => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_text_unavailable",
        ),
        _ => err(StatusCode::BAD_GATEWAY, "native_platform_text_invalid"),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn danmaku_advanced_rendering_is_explicit_and_legacy_default_is_retained() {
        let old: DanmakuQuery =
            serde_json::from_value(json!({"token":"fixture","at_ms":0})).unwrap();
        assert_eq!(old.rendering_version, 1);
        let new: DanmakuQuery =
            serde_json::from_value(json!({"token":"fixture","at_ms":0,"rendering_version":2}))
                .unwrap();
        assert_eq!(new.rendering_version, 2);
        assert!(
            serde_json::from_value::<DanmakuQuery>(
                json!({"token":"fixture","at_ms":0,"script":"remote"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<DanmakuQuery>(
                json!({"token":"fixture","at_ms":0,"rendering_version":"2"})
            )
            .is_err()
        );
    }
    #[test]
    fn subtitle_ids_cannot_be_paths_or_urls() {
        for id in ["b12", "ymen-US", "yazh-Hans"] {
            assert!(track_id(id))
        }
        for id in ["", "../x", "https://x", "x%2fy", "x?url=x", "x<script>"] {
            assert!(!track_id(id))
        }
    }
}
