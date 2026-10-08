use super::{Container, MediaPlaylist};
use crate::static_hls::timeline::{self, FiniteTrackMapping};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fmp4SegmentMapping {
    pub index: usize,
    pub discontinuity: bool,
    pub original_bytes: usize,
    pub original_sha256: String,
    pub normalized_bytes: usize,
    pub normalized_sha256: String,
    pub tracks: Vec<FiniteTrackMapping>,
}
pub struct Fmp4Normalizer {
    structure: timeline::Structure,
    ends: BTreeMap<u32, i64>,
    previous_video_shift: Option<i64>,
    pub mappings: Vec<Fmp4SegmentMapping>,
}
impl Fmp4Normalizer {
    pub fn new(playlist: &MediaPlaylist, init: &[u8]) -> Result<Self> {
        ensure!(
            playlist.container == Container::FragmentedMp4,
            "unsupported_finite_hls:fmp4_init_required"
        );
        let mut manifest = format!(
            "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:32\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:{}\n#EXT-X-MAP:URI=\"init.mp4\"\n",
            playlist.sequence
        );
        for (index, segment) in playlist.segments.iter().enumerate() {
            manifest.push_str(&format!(
                "#EXTINF:{:.6},\ns{index:03}.m4s\n",
                segment.duration
            ));
        }
        manifest.push_str("#EXT-X-ENDLIST\n");
        Ok(Self {
            structure: timeline::Structure::new(&manifest, init)?,
            ends: BTreeMap::new(),
            previous_video_shift: None,
            mappings: Vec::new(),
        })
    }
    /// The original bytes remain a distinct inventory. Only closed MP4 sample
    /// tables and a common exact-rational track-clock mapping are admitted.
    pub fn ingest(&mut self, bytes: &[u8], discontinuity: bool) -> Result<Vec<u8>> {
        let index = self.mappings.len();
        let (normalized, tracks, ends) = timeline::finite_fragment_rebase(
            bytes,
            &self.structure.tracks,
            &self.ends,
            discontinuity,
            self.previous_video_shift,
            index,
        )?;
        self.structure.ingest_fragment(&normalized, index)?;
        self.mappings.push(Fmp4SegmentMapping {
            index,
            discontinuity,
            original_bytes: bytes.len(),
            original_sha256: format!("{:x}", Sha256::digest(bytes)),
            normalized_bytes: normalized.len(),
            normalized_sha256: format!("{:x}", Sha256::digest(&normalized)),
            tracks,
        });
        let video = self
            .structure
            .tracks
            .iter()
            .find(|t| t.kind == timeline::TrackKind::Video)
            .unwrap();
        self.previous_video_shift = Some(
            self.mappings
                .last()
                .unwrap()
                .tracks
                .iter()
                .find(|t| t.track_id == video.id)
                .unwrap()
                .timestamp_offset_ticks,
        );
        self.ends = ends;
        Ok(normalized)
    }
    pub fn inspect_probe(&self, probe: &serde_json::Value) -> Result<timeline::TimelineProof> {
        let mut proof = self.structure.inspect_probe(probe)?;
        let video = proof
            .tracks
            .iter()
            .find(|t| t.kind == timeline::TrackKind::Video)
            .unwrap();
        let frames = probe["packets_and_frames"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("unsupported_finite_hls:fmp4_frames"))?;
        for mapping in &self.mappings {
            let clock = mapping
                .tracks
                .iter()
                .find(|t| t.track_id == video.track_id)
                .unwrap()
                .normalized_first_pts;
            ensure!(
                frames.iter().any(|f| f["type"] == "frame"
                    && f["stream_index"] == video.stream_index
                    && f["pts"] == clock
                    && f["key_frame"] == 1),
                "unsupported_finite_hls:fmp4_segment_independent_keyframe"
            );
        }
        proof.scope = "finite-normalized-zero-origin-avc-fmp4-v1".into();
        Ok(proof)
    }
}
