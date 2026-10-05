//! Quality choices are finite height policy, scoped by normal authenticated
//! viewer/media generations. No extractor selector, format URL or account leaks.
use super::*;
use protocol::{NativePlatformMaxHeight as Height, NativePlatformProvider as Provider};

pub(super) fn requested(body: &protocol::PlaybackRequest) -> Height {
    body.native_platform
        .as_ref()
        .and_then(|intent| intent.quality.as_ref())
        .map_or(Height::Auto, |quality| quality.max_height)
}
pub(super) fn validate_shape(body: &protocol::PlaybackRequest) -> Result<()> {
    if body
        .native_platform
        .as_ref()
        .and_then(|intent| intent.quality.as_ref())
        .is_some_and(|quality| {
            quality.version != 1
                || !matches!(quality.provider, Provider::Bilibili | Provider::Youtube)
        })
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    Ok(())
}
pub(super) fn validate_target(
    body: &protocol::PlaybackRequest,
    provider: &str,
    media: Uuid,
) -> Result<()> {
    validate_shape(body)?;
    if body
        .native_platform
        .as_ref()
        .and_then(|intent| intent.quality.as_ref())
        .is_some_and(|quality| {
            quality.media_id != media || provider_id(quality.provider) != provider
        })
    {
        return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
    }
    Ok(())
}
fn provider_id(provider: Provider) -> &'static str {
    match provider {
        Provider::Bilibili => "bilibili",
        Provider::Douyin => "douyin",
        Provider::Tiktok => "tiktok",
        Provider::Youtube => "youtube",
    }
}
pub(super) fn youtube_limit(value: Height) -> providers::platform::youtube::QualityLimit {
    use providers::platform::youtube::QualityLimit as Limit;
    match value {
        Height::Auto => Limit::Auto,
        Height::P144 => Limit::P144,
        Height::P240 => Limit::P240,
        Height::P360 => Limit::P360,
        Height::P480 => Limit::P480,
        Height::P720 => Limit::P720,
        Height::P1080 => Limit::P1080,
        Height::P1440 => Limit::P1440,
        Height::P2160 => Limit::P2160,
        Height::P4320 => Limit::P4320,
    }
}
pub(super) fn binding(
    requested: Height,
    descriptor: &Descriptor,
    heights: Vec<u32>,
) -> Result<protocol::NativePlatformQualityBinding> {
    let selected = descriptor
        .tracks
        .iter()
        .find(|track| matches!(track.kind.as_str(), "video" | "muxed"))
        .and_then(|track| track.height)
        .ok_or_else(|| {
            err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "native_platform_descriptor_unsupported",
            )
        })?;
    if requested.limit().is_some_and(|limit| selected > limit) {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_descriptor_unsupported",
        ));
    }
    let mut options: Vec<protocol::NativePlatformQualityOption> = vec![];
    for height in heights.into_iter().chain(std::iter::once(selected)) {
        let Some(max_height) = Height::for_height(height) else {
            continue;
        };
        if let Some(option) = options
            .iter_mut()
            .find(|option| option.max_height == max_height)
        {
            option.height = option.height.max(height);
        } else {
            options.push(protocol::NativePlatformQualityOption { max_height, height });
        }
    }
    options.sort_by_key(|option| option.height);
    Ok(protocol::NativePlatformQualityBinding {
        version: 1,
        requested_max_height: requested,
        selected_height: selected,
        options,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quality_requires_exact_provider_media_and_closed_height_policy() {
        let mut body: protocol::PlaybackRequest = serde_json::from_value(json!({
            "room_id":Uuid::from_u128(1),"media_generation":7,"viewer_id":Uuid::from_u128(2),"plan_generation":3,
            "native_platform":{"version":1,"credential_mode":"anonymous","quality":{
                "version":1,"provider":"youtube","media_id":Uuid::from_u128(4),"max_height":"p720"}}
        })).unwrap();
        assert!(validate_target(&body, "youtube", Uuid::from_u128(4)).is_ok());
        assert!(validate_target(&body, "bilibili", Uuid::from_u128(4)).is_err());
        assert!(validate_target(&body, "youtube", Uuid::from_u128(5)).is_err());
        body.native_platform
            .as_mut()
            .unwrap()
            .quality
            .as_mut()
            .unwrap()
            .version = 2;
        assert!(validate_shape(&body).is_err());
        assert_eq!(youtube_limit(Height::P720).height(), Some(720));
    }
    #[test]
    fn quality_options_are_observed_deduplicated_buckets_with_truthful_selection() {
        let mut descriptor = descriptor::fixture();
        descriptor.tracks[0].height = Some(404);
        let quality = binding(
            Height::P480,
            &descriptor,
            vec![144, 404, 480, 720, 1080, 0, 9999],
        )
        .unwrap();
        assert_eq!(quality.selected_height, 404);
        assert_eq!(
            quality
                .options
                .iter()
                .map(|option| option.height)
                .collect::<Vec<_>>(),
            vec![144, 480, 720, 1080]
        );
        assert_eq!(quality.options[1].max_height, Height::P480);
        assert!(binding(Height::P360, &descriptor, vec![360]).is_err());
    }
}
