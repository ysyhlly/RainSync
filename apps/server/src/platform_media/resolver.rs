//! Provider-scoped resolution. Credentials and signed URLs stay server-only.
use super::{Deadline, Descriptor};
use crate::{Error, Result, err};
use axum::http::StatusCode;
use providers::platform::http::PlatformHttp;
use providers::platform::{short_video, youtube};

pub(crate) struct ResolvedProgressive {
    pub content_id: String,
    pub canonical_url: String,
    pub title: String,
    pub duration_seconds: f64,
    pub url: String,
    pub url_expires_at_ms: Option<i64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
}

pub(crate) async fn resolve_public_progressive(
    http: PlatformHttp,
    provider: &str,
    resource: &str,
    deadline: Deadline,
) -> Result<ResolvedProgressive> {
    resolve_progressive(http, provider, resource, None, deadline).await
}

/// A connected caller account is used exactly once. Resolution failures never
/// retry anonymously or borrow another viewer's credential.
pub(crate) async fn resolve_progressive(
    http: PlatformHttp,
    provider: &str,
    resource: &str,
    credential: Option<&short_video::Credential>,
    deadline: Deadline,
) -> Result<ResolvedProgressive> {
    validate_credential_provider(provider, credential)?;
    let resolved = match provider {
        "douyin" | "tiktok" => {
            let platform = if provider == "douyin" {
                short_video::Platform::Douyin
            } else {
                short_video::Platform::TikTok
            };
            let resolver = short_video::Resolver::new(http);
            let result = match credential {
                Some(credential) => {
                    resolver
                        .resolve_authenticated(platform, resource, credential, deadline)
                        .await
                }
                None => resolver.resolve(platform, resource, deadline).await,
            };
            let resolved =
                result.map_err(|error| short_video_error(error, credential.is_some()))?;
            if resolved.platform != platform {
                return Err(invalid_response());
            }
            ResolvedProgressive {
                content_id: resolved.content_id,
                canonical_url: resolved.canonical_url,
                title: resolved.title,
                duration_seconds: resolved.duration_seconds,
                url: resolved.media.as_str().into(),
                url_expires_at_ms: resolved
                    .media
                    .expires_at_ms
                    .map(|v| i64::try_from(v).map_err(|_| invalid_response()))
                    .transpose()?,
                width: resolved.width,
                height: resolved.height,
                video_codec: resolved.video_codec,
                audio_codec: resolved.audio_codec,
            }
        }
        _ => return Err(err(StatusCode::BAD_REQUEST, "native_platform_invalid")),
    };
    let (identity, canonical): (String, String) = match provider {
        "douyin" | "tiktok" => {
            let platform = if provider == "douyin" {
                short_video::Platform::Douyin
            } else {
                short_video::Platform::TikTok
            };
            let reference = short_video::parse_resource(platform, &resolved.canonical_url)
                .map_err(|_| invalid_response())?;
            (reference.id().into(), reference.canonical())
        }
        _ => return Err(invalid_response()),
    };
    if identity != resolved.content_id || canonical != resolved.canonical_url {
        return Err(invalid_response());
    }
    // Import also checks the closed media shape but never stores the URL. This
    // makes import-only availability unable to admit image/live/foreign-CDN data.
    Descriptor::from_progressive(provider, &resolved)?;
    Ok(resolved)
}
/// Shared import/preparation seam: account selection happens before resolution
/// and a supplied viewer credential is never retried anonymously.
pub(crate) async fn resolve_youtube_with_account(
    resolver: &youtube::YoutubeResolver,
    resource: &str,
    mode: youtube::SelectionMode,
    quality: youtube::QualityLimit,
    credential: Option<&youtube::Credential>,
    deadline: Deadline,
) -> Result<youtube::ResolvedVideo> {
    let requested = youtube::parse_resource(resource).map_err(youtube_error)?;
    let resolved = match credential {
        Some(credential) => {
            resolver
                .resolve_authenticated_with_quality(resource, mode, quality, credential, deadline)
                .await
        }
        None => {
            resolver
                .resolve_with_quality(resource, mode, quality, deadline)
                .await
        }
    }
    .map_err(youtube_error)?;
    validate_youtube_identity(&requested, &resolved)?;
    Ok(resolved)
}

fn validate_youtube_identity(
    requested: &youtube::VideoRef,
    resolved: &youtube::ResolvedVideo,
) -> Result<()> {
    if resolved.content_id != requested.id
        || resolved.canonical_url != requested.canonical()
        || !resolved.duration_seconds.is_finite()
        || !(0.001..=604800.0).contains(&resolved.duration_seconds)
    {
        return Err(invalid_response());
    }
    Ok(())
}
pub(super) fn youtube_progressive(
    resolved: &youtube::ResolvedVideo,
    playback: &youtube::ProgressivePlayback,
) -> ResolvedProgressive {
    ResolvedProgressive {
        content_id: resolved.content_id.clone(),
        canonical_url: resolved.canonical_url.clone(),
        title: resolved.title.clone(),
        duration_seconds: resolved.duration_seconds,
        url: playback.url.clone(),
        url_expires_at_ms: Some(playback.expires_at_unix_ms),
        width: playback.width,
        height: playback.height,
        video_codec: Some(playback.video_codec.clone()),
        audio_codec: Some(playback.audio_codec.clone()),
    }
}

fn validate_credential_provider(
    provider: &str,
    credential: Option<&short_video::Credential>,
) -> Result<()> {
    if credential.is_some_and(|credential| credential.platform().id() != provider) {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    Ok(())
}
fn invalid_response() -> Error {
    err(StatusCode::BAD_GATEWAY, "native_platform_invalid_response")
}
fn youtube_error(error: youtube::Error) -> Error {
    match error {
        youtube::Error::ProviderUnavailable | youtube::Error::InvalidConfiguration => err(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_platform_provider_unavailable",
        ),
        youtube::Error::InvalidResource => err(StatusCode::BAD_REQUEST, "native_platform_invalid"),
        youtube::Error::Deadline => err(
            StatusCode::GATEWAY_TIMEOUT,
            "native_platform_resolve_timeout",
        ),
        youtube::Error::Unsupported => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_access_denied",
        ),
        youtube::Error::Cancelled => err(
            StatusCode::SERVICE_UNAVAILABLE,
            "playback_request_interrupted",
        ),
        _ => err(StatusCode::BAD_GATEWAY, "native_platform_resolve_failed"),
    }
}
fn short_video_error(error: short_video::Error, authenticated: bool) -> Error {
    // Provider errors stay bounded and no upstream text reaches the client.
    match error {
        short_video::Error::InvalidResource => {
            err(StatusCode::BAD_REQUEST, "native_platform_invalid")
        }
        short_video::Error::Deadline => err(
            StatusCode::GATEWAY_TIMEOUT,
            "native_platform_resolve_timeout",
        ),
        short_video::Error::Unsupported(short_video::Unsupported::Codec) => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_codec_unsupported",
        ),
        short_video::Error::Restricted(_)
        | short_video::Error::Unsupported(short_video::Unsupported::SigningRequired) => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            if authenticated {
                "native_platform_access_denied"
            } else {
                "native_platform_anonymous_unsupported"
            },
        ),
        short_video::Error::Unsupported(_)
        | short_video::Error::Api(_)
        | short_video::Error::Status(401 | 403 | 404) => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_access_denied",
        ),
        _ => err(StatusCode::BAD_GATEWAY, "native_platform_resolve_failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_provider_is_checked_before_any_upstream_call() {
        for platform in [short_video::Platform::Douyin, short_video::Platform::TikTok] {
            let credential =
                short_video::Credential::parse(platform, "sessionid=synthetic-private-session")
                    .unwrap();
            assert!(validate_credential_provider(platform.id(), Some(&credential)).is_ok());
            for provider in ["bilibili", "douyin", "tiktok", "youtube", "unknown"] {
                if provider != platform.id() {
                    let error =
                        validate_credential_provider(provider, Some(&credential)).unwrap_err();
                    assert_eq!(error.0, StatusCode::CONFLICT);
                    assert_eq!(error.1, "platform_account_changed");
                }
            }
        }
        for provider in ["douyin", "tiktok", "youtube"] {
            assert!(validate_credential_provider(provider, None).is_ok());
        }
    }

    #[test]
    fn provider_failure_keeps_mode_bounded_and_never_exposes_upstream_text() {
        for authenticated in [false, true] {
            for error in [
                short_video::Error::Restricted("synthetic-upstream-private-text"),
                short_video::Error::Unsupported(short_video::Unsupported::SigningRequired),
            ] {
                let error = short_video_error(error, authenticated);
                assert_eq!(error.0, StatusCode::UNPROCESSABLE_ENTITY);
                assert_eq!(
                    error.1,
                    if authenticated {
                        "native_platform_access_denied"
                    } else {
                        "native_platform_anonymous_unsupported"
                    }
                );
                assert!(!error.1.contains("synthetic-upstream-private-text"));
            }
        }
    }
}
