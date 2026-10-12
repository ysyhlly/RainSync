//! Decoded, point-in-time playback facts. These values confer no admission.
//!
//! The adapters still decrypt bindings, obtain current source facts and perform
//! every authoritative transaction check. In particular, matching a report now
//! does not prove source/login authority after a later wait.
use protocol::{AdvancedPlaybackRequest, LocalHlsLadderRequest, PlaybackCandidate};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// The existing encrypted capability payload, with its wire shape unchanged.
#[derive(Serialize, Deserialize)]
pub(crate) struct CandidateBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced_assets_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_hls_ladder: Option<LocalHlsLadderRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced_playback: Option<AdvancedPlaybackRequest>,
    pub purpose: String,
    pub user: Uuid,
    pub room: Uuid,
    pub generation: u32,
    pub lifecycle_epoch: i64,
    pub media: Uuid,
    pub source_version: String,
    pub audio_index: Option<u32>,
    pub expires: u64,
    pub candidates: Vec<PlaybackCandidate>,
}

/// Only the request fields participating in the existing report binding.
#[derive(Clone, Copy)]
pub(crate) struct CandidateScope<'a> {
    pub user: Uuid,
    pub room: Uuid,
    pub generation: u32,
    pub lifecycle_epoch: i64,
    pub media: Uuid,
    pub audio_index: Option<u32>,
    pub advanced_playback: Option<&'a AdvancedPlaybackRequest>,
    pub local_hls_ladder: Option<&'a LocalHlsLadderRequest>,
}

impl CandidateBinding {
    pub fn matches(&self, scope: CandidateScope<'_>, now: u64) -> bool {
        self.purpose == "actual_media_capabilities_v1"
            && self.user == scope.user
            && self.room == scope.room
            && self.generation == scope.generation
            && self.lifecycle_epoch == scope.lifecycle_epoch
            && self.media == scope.media
            && self.audio_index == scope.audio_index
            && self.advanced_playback.as_ref() == scope.advanced_playback
            && self.local_hls_ladder.as_ref() == scope.local_hls_ladder
            && self.expires >= now
    }
}

/// Candidates retain their server-issued order. A missing version is the
/// existing HTTP case; its authority is enforced outside the pure selector.
pub(crate) struct CandidateFacts {
    pub candidates: Vec<PlaybackCandidate>,
    pub source_version: Option<String>,
}

/// Storage identity is kept separate from playback transport. In particular,
/// S3 uses HTTP delivery without becoming eligible for finite-HLS admission.
#[derive(Clone, Copy)]
pub(crate) struct SourceFacts<'a> {
    pub storage_kind: &'a str,
    pub linux: bool,
}

/// The local recipe decodes/discards preroll at nonzero starts. A selected
/// stream-copy route cannot claim that exact origin or silently change codec.
pub fn local_timeline_origin(position_ms: f64, mode: &str) -> Option<f64> {
    (position_ms.is_finite()
        && position_ms >= 0.0
        && (mode == "transcode"
            || (matches!(mode, "remux" | "audio_transcode") && position_ms == 0.0)))
        .then_some(position_ms)
}

pub fn stream_index(stream: &Value) -> Option<u32> {
    stream["index"].as_u64().and_then(|v| u32::try_from(v).ok())
}

/// DefaultAudioStreamIndex is evidence only for the current, unambiguous source
/// and a unique Audio stream. Array order and item-list metadata are not proof.
pub fn upstream_audio(info: &Value, requested: Option<u32>, mode: &str) -> Option<u32> {
    let sources = info["MediaSources"].as_array()?;
    if sources.len() != 1 {
        return None;
    }
    let source = &sources[0];
    let source_id = source["Id"].as_str()?;
    if source_id.trim().is_empty()
        || source_id.len() > 512
        || source_id.chars().any(char::is_control)
    {
        return None;
    }
    let streams = source["MediaStreams"].as_array()?;
    if mode == "direct" && streams.iter().filter(|s| s["Type"] == "Audio").count() != 1 {
        return None;
    }
    let index = source["DefaultAudioStreamIndex"]
        .as_u64()
        .filter(|v| *v <= i32::MAX as u64)? as u32;
    if requested.is_some_and(|v| v != index) {
        return None;
    }
    (source["MediaStreams"]
        .as_array()?
        .iter()
        .filter(|s| s["Type"] == "Audio" && s["Index"].as_u64() == Some(u64::from(index)))
        .count()
        == 1)
        .then_some(index)
}

/// Generated local HLS explicitly maps 0:a:0 or the validated absolute index.
/// Progressive multi-audio files leave track selection to the media element.
pub fn mapped_audio(
    meta: &Value,
    requested: Option<u32>,
    mode: &str,
    current: bool,
) -> Option<u32> {
    if !current {
        return None;
    }
    let audio: Vec<_> = meta["streams"]
        .as_array()?
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .collect();
    if let Some(index) = requested {
        return (mode != "direct"
            && audio
                .iter()
                .filter(|s| stream_index(s) == Some(index))
                .count()
                == 1)
            .then_some(index);
    }
    if mode == "direct" && audio.len() != 1 {
        return None;
    }
    stream_index(audio.first()?)
}
