//! Versioned, closed self-generated software AVC/AAC HLS ladder.
//!
//! This is deliberately separate from static-HLS capture/child ownership and
//! the existing advanced single-rendition HDR/subtitle/hardware recipes. Pure
//! content qualification is not a custody, decoder-reap or publication permit.
//! Worker publication must retain the exact immutable resources, positively
//! reap a successful decoder, and fence the same attempt/source/plan identity.
mod manifest;
mod recipe;
mod validation;

pub use manifest::{
    MasterPlaylist, MasterVariant, MediaPlaylist, Segment, parse_master, parse_media_playlist,
};
pub use recipe::{LadderRecipe, Rendition, RenditionId, analyze};
pub use validation::{
    FirstFragmentFacts, QualifiedLadder, QualifiedRendition, qualify_ladder, qualify_rendition,
    validate_first_fragment, validate_fragment,
};

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

pub const RECIPE_VERSION: u8 = 1;
pub const MAX_RENDITIONS: usize = 3;
pub const SEGMENT_SECONDS: u32 = 4;
pub const FRAME_RATE: u32 = 30;
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
pub const MAX_SEGMENTS: usize = 20_000;
pub const MAX_INIT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_FRAGMENT_BYTES: usize = 16 * 1024 * 1024;
/// Selected packet/frame scalar records plus two bounded codec hex dumps.
/// Packet payload hex is excluded by first_fragment_probe_args().
pub const MAX_PROBE_BYTES: usize = 2 * 1024 * 1024;
/// Closed probe arguments for init+first-fragment bytes supplied on stdin.
/// -show_data is needed ONLY for stream codec extradata; packet=data is never
/// selected, avoiding multi-megabyte payload-to-hex diagnostic amplification.
pub fn first_fragment_probe_args() -> Vec<String> {
    ["-v", "error", "-protocol_whitelist", "pipe", "-f", "mp4", "-i", "pipe:0",
     "-show_streams", "-show_packets", "-show_frames", "-show_data", "-show_entries",
     "stream=index,codec_type,codec_name,codec_tag_string,width,height,pix_fmt,sample_aspect_ratio,r_frame_rate,has_b_frames,time_base,extradata,profile,channels,sample_rate,color_transfer,color_primaries,color_space,color_range:stream_side_data=side_data_type:packet=type,stream_index,pts,dts,size:frame=type,stream_index,pts,best_effort_timestamp,width,height,key_frame,nb_samples:packet_side_data=:frame_side_data=", "-of", "json"].into_iter().map(str::to_owned).collect()
}
pub const MAX_DURATION_MS: u64 = 24 * 60 * 60 * 1000;

/// Exact durable attempt fence. Data alone does not prove ownership/freshness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptIdentity {
    pub recipe_version: u8,
    pub attempt_id: String,
    pub source_generation: u64,
    pub plan_generation: u64,
}
impl AttemptIdentity {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.recipe_version == RECIPE_VERSION,
            "hls_ladder_version_unsupported"
        );
        ensure!(
            self.attempt_id.len() == 36
                && self.attempt_id.bytes().enumerate().all(|(i, b)| {
                    if [8, 13, 18, 23].contains(&i) {
                        b == b'-'
                    } else {
                        b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                    }
                }),
            "hls_ladder_attempt_identity_invalid"
        );
        Ok(())
    }
    pub fn relative_directory(&self) -> Result<String> {
        self.validate()?;
        Ok(format!("hls-ladder-v1/{}", self.attempt_id))
    }
}

/// Closed HTTP/file resource vocabulary, never an arbitrary relative path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resource {
    Master,
    Playlist(RenditionId),
    Init(RenditionId),
    Segment(RenditionId, usize),
}
impl Resource {
    pub fn parse(path: &str) -> Result<Self> {
        if path == "master.m3u8" {
            return Ok(Self::Master);
        }
        let (id, name) = path
            .split_once('/')
            .ok_or_else(|| anyhow::anyhow!("hls_ladder_resource_invalid"))?;
        let id = RenditionId::parse(id)?;
        match name {
            "index.m3u8" => Ok(Self::Playlist(id)),
            "init.mp4" => Ok(Self::Init(id)),
            _ => {
                let number = name
                    .strip_prefix("index")
                    .and_then(|s| s.strip_suffix(".m4s"))
                    .ok_or_else(|| anyhow::anyhow!("hls_ladder_resource_invalid"))?;
                let n = number
                    .parse::<usize>()
                    .map_err(|_| anyhow::anyhow!("hls_ladder_resource_invalid"))?;
                ensure!(
                    n < MAX_SEGMENTS && n.to_string() == number,
                    "hls_ladder_resource_invalid"
                );
                Ok(Self::Segment(id, n))
            }
        }
    }
    pub fn path(self) -> String {
        match self {
            Self::Master => "master.m3u8".into(),
            Self::Playlist(id) => format!("{}/index.m3u8", id.as_str()),
            Self::Init(id) => format!("{}/init.mp4", id.as_str()),
            Self::Segment(id, index) => format!("{}/index{index}.m4s", id.as_str()),
        }
    }
}

#[cfg(test)]
mod tests;
