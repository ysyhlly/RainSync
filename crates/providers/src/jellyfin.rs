//! Jellyfin 10.11 PlaybackInfoDto and authenticated browsing adapter.
//! Reference: Jellyfin.Api/Controllers/MediaInfoController.cs at v10.11.0.
use super::{Item, PlaybackOptions, SourceConfig, upstream_common, upstream_headers};
use anyhow::Result;
use serde_json::Value;

pub fn playback_request(config: &SourceConfig, options: &PlaybackOptions) -> Result<Value> {
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
        upstream_headers("jellyfin", config, device_id)?,
    )
    .await
}

pub async fn list_items(config: &SourceConfig) -> Result<Vec<Item>> {
    upstream_common::list(
        config,
        upstream_headers("jellyfin", config, "rainsync-library-scan")?,
    )
    .await
}
