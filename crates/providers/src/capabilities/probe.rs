use crate::{SourceConfig, UpstreamKind, upstream_common, upstream_headers, upstream_profiles};
use anyhow::Result;

/// Bounded read-only item discovery. This never calls PlaybackInfo or opens a
/// play session, and returned metadata does not confer publication authority.
pub struct UpstreamProbe<'a> {
    kind: UpstreamKind,
    config: &'a SourceConfig,
}

impl<'a> UpstreamProbe<'a> {
    pub fn new(kind: UpstreamKind, config: &'a SourceConfig) -> Self {
        Self { kind, config }
    }

    pub async fn audio_source(
        &self,
        item: &str,
        audio_index: u32,
        device_id: &str,
    ) -> Result<String> {
        upstream_common::audio_source(
            self.config,
            item,
            audio_index,
            upstream_headers(self.kind.as_str(), self.config, device_id)?,
        )
        .await
    }

    pub async fn profile_metadata(
        &self,
        item: &str,
        audio_index: Option<u32>,
        device_id: &str,
    ) -> Result<upstream_profiles::UpstreamProfileMetadata> {
        let headers = upstream_headers(self.kind.as_str(), self.config, device_id)
            .map_err(|_| anyhow::anyhow!("upstream_metadata_identity_invalid"))?;
        let value = upstream_common::item_metadata(self.config, item, &headers).await?;
        let metadata = upstream_profiles::normalize_metadata(&value, item, audio_index)?;
        upstream_profiles::validate_profile_metadata(self.kind.as_str(), &metadata)?;
        Ok(metadata)
    }
}
