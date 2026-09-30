//! Emby 4.10 PlaybackInfoRequest and authenticated browsing adapter.
//! Reference: dev.emby.media/reference/RestAPI/MediaInfoService/postItemsByIdPlaybackinfo.html.
use super::{Item, PlaybackOptions, SourceConfig, upstream_common, upstream_headers};
use anyhow::Result;
use serde_json::Value;

pub fn playback_request(config: &SourceConfig, options: &PlaybackOptions) -> Result<Value> {
    // Emby's documented PlaybackInfoRequest currently has the same body fields
    // used by this limited Web profile. Keep a distinct entry for future
    // version differences rather than selecting behavior by extension.
    upstream_common::playback_body(config, options)
}

pub async fn upstream_plan(
    config: &SourceConfig,
    item: &str,
    options: &PlaybackOptions,
    device_id: &str,
) -> Result<Value> {
    upstream_common::plan(
        config,
        item,
        playback_request(config, options)?,
        upstream_headers("emby", config, device_id)?,
    )
    .await
}

pub async fn list_items(config: &SourceConfig) -> Result<Vec<Item>> {
    upstream_common::list(
        config,
        upstream_headers("emby", config, "rainsync-library-scan")?,
    )
    .await
}
