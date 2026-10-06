//! Closed ordinary-job media recipes. These are intentionally separate from
//! the deterministic, capture-owned static-HLS child recipe.
mod assets;
mod dolby_vision;
mod encoder;
mod hdr;
mod input;
mod inventory;
mod recipe;
mod remote_assets;
mod source_profile;
mod subtitle;
mod webm_source;

pub use assets::{
    AssetCatalog, AssetFile, EXTERNAL_ASS_INDEX, EXTERNAL_PGS_INDEX, EXTERNAL_SSA_INDEX,
    MAX_ASSET_BYTES, OwnedAssets, SubtitleAsset, validate_subtitle_bytes,
};
pub use dolby_vision::DolbyVisionSource;
pub use encoder::{Backend, EncoderPreference, EncoderSelection, FallbackReason};
pub use hdr::{HdrSource, classify_hdr};
pub use input::{Input, OwnedLocalInput, WorkerGatewayInput};
pub use inventory::{DeviceObservation, Inventory, RuntimeQualification};
pub use recipe::{Recipe, analyze};
pub use remote_assets::{
    HTTP_ASSET_SOURCE, HttpAssetAssociation, HttpAssetPin, HttpSourcePin, REMOTE_ASSET_KIND,
    REMOTE_ASSET_QUEUE, RemoteAssetCatalog, http_asset_url, sha256 as asset_sha256,
    source_http_version,
};
pub use source_profile::{VideoSourceExpectation, VideoSourceProof, extended_source_proof};
pub use subtitle::{SubtitleKind, SubtitleSelection, select_subtitle};
pub use webm_source::{PrivateInputContainer, WebmSourceExpectation};

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

/// A sealed Server job intent, never a user-provided FFmpeg argument/filter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema_version: u8,
    #[serde(default)]
    pub tone_map_hdr: bool,
    #[serde(default)]
    pub subtitle_stream_index: Option<u32>,
}
impl Default for Request {
    fn default() -> Self {
        Self {
            schema_version: 1,
            tone_map_hdr: false,
            subtitle_stream_index: None,
        }
    }
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == 1,
            "advanced_media_schema_unsupported"
        );
        Ok(())
    }
    pub fn requires_transform(&self) -> bool {
        self.tone_map_hdr || self.subtitle_stream_index.is_some()
    }
}

/// Metadata for a local advanced-transcode source. Unlike passthrough codec
/// analysis this does not dump font/codec extradata bytes: normal large CJK
/// font attachments must not exhaust the bounded JSON diagnostic channel.
/// The caller remains responsible for root/version ownership, as with the
/// existing generic probe; Worker execution uses the retained-descriptor probe.
pub async fn probe_metadata(path: &str) -> Result<serde_json::Value> {
    ensure!(
        std::path::Path::new(path).is_absolute() && !path.contains('\0'),
        "advanced_media_local_probe_required"
    );
    let mut command = tokio::process::Command::new("ffprobe");
    crate::input_policy::clean_environment(&mut command);
    command.args(crate::input_policy::args(false, false));
    command.args([
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        path,
    ]);
    command
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let (status, bytes) =
        crate::child_process::capture(command, std::time::Duration::from_secs(30), 8 * 1024 * 1024)
            .await?;
    ensure!(status.success(), "advanced_media_probe_failed");
    Ok(serde_json::from_slice(&bytes)?)
}

/// Metadata-only probe behind the existing authorized, loopback Worker gateway.
/// Unlike rewritten HTTP HLS, advanced input is a finite binary container.
pub async fn probe_gateway_metadata(path: &str) -> Result<serde_json::Value> {
    WorkerGatewayInput::new(path)?;
    let mut command = tokio::process::Command::new("ffprobe");
    crate::input_policy::clean_environment(&mut command);
    command.args(crate::input_policy::args(true, false));
    command.args([
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        "-i",
        path,
    ]);
    let (status, bytes) =
        crate::child_process::capture(command, std::time::Duration::from_secs(30), 8 * 1024 * 1024)
            .await?;
    ensure!(status.success(), "advanced_media_probe_failed");
    Ok(serde_json::from_slice(&bytes)?)
}
