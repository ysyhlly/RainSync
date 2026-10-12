use crate::{PlaybackOptions, SourceConfig, UpstreamKind, emby, jellyfin, upstream_profiles};
use anyhow::Result;
use serde_json::Value;

/// PlaybackInfo can allocate a remote session. The caller retains reservation,
/// checkpoint, cancellation and publication ownership; this is not a probe.
pub struct UpstreamNegotiation<'a> {
    kind: UpstreamKind,
    config: &'a SourceConfig,
}

impl<'a> UpstreamNegotiation<'a> {
    pub fn new(kind: UpstreamKind, config: &'a SourceConfig) -> Self {
        Self { kind, config }
    }

    pub async fn plan(
        &self,
        item: &str,
        options: &PlaybackOptions,
        device_id: &str,
    ) -> Result<Value> {
        match self.kind {
            UpstreamKind::Jellyfin => {
                jellyfin::upstream_plan(self.config, item, options, device_id).await
            }
            UpstreamKind::Emby => emby::upstream_plan(self.config, item, options, device_id).await,
        }
    }

    pub async fn profile_plan(
        &self,
        item: &str,
        options: &PlaybackOptions,
        metadata: &upstream_profiles::UpstreamProfileMetadata,
        device_id: &str,
    ) -> Result<Value> {
        match self.kind {
            UpstreamKind::Jellyfin => {
                jellyfin::upstream_profile_plan(self.config, item, options, metadata, device_id)
                    .await
            }
            UpstreamKind::Emby => {
                emby::upstream_profile_plan(self.config, item, options, metadata, device_id).await
            }
        }
    }
}
