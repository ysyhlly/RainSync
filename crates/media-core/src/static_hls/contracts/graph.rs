//! Closed graph statements. Shape and equality do not authenticate scanner JSON
//! or establish that any decoder ran, reaped, or owns an immutable snapshot.
use super::input::{FrozenInput, OperationKind, SelectedAudioStatement};
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Resource {
    original_target_sha256: String,
    final_target_sha256: String,
    strong_etag: String,
    bytes: usize,
    sha256: String,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Init {
    bytes: usize,
    sha256: String,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Segment {
    index: usize,
    bytes: usize,
    sha256: String,
    track_ids: Vec<u32>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Closure {
    version: u8,
    manifest_sha256: String,
    manifest_bytes: usize,
    init: Object<Init>,
    segments: Vec<Object<Segment>>,
}
#[derive(Clone, Copy, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum TrackKind {
    Video,
    Audio,
}
impl<'de> Deserialize<'de> for TrackKind {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "video" => Ok(Self::Video),
            "audio" => Ok(Self::Audio),
            _ => Err(serde::de::Error::custom("unsupported track kind")),
        }
    }
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Track {
    track_id: u32,
    stream_index: u32,
    kind: TrackKind,
    time_base: String,
    packet_count: usize,
    decoded_frames: usize,
    raw_first_pts: i64,
    decoded_first_pts: i64,
    priming_samples: u32,
    tail_padding_samples: u32,
    raw_end_seconds: f64,
    end_seconds: f64,
    last_frame_pts: i64,
    codec_config_sha256: String,
}
// Explicit repeated fields preserve the existing flattened timeline wire shape
// while keeping deny_unknown_fields and duplicate checks at this object level.
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Timeline {
    version: u8,
    manifest_sha256: String,
    manifest_bytes: usize,
    init: Object<Init>,
    segments: Vec<Object<Segment>>,
    scope: String,
    source_origin_ms: u32,
    duration_ms: f64,
    media_sequence: u64,
    tracks: Vec<Object<Track>>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Root {
    graph_version: u8,
    parent_input_sha256: String,
    inventory: Vec<Object<Resource>>,
    closure: Object<Closure>,
    timeline: Object<Timeline>,
}

/// Immutable validated data, never a VerifiedCapture or source authorization.
/// Kept separate from the input hash and from process/path/elapsed evidence.
pub struct RootGraphStatement {
    root: Root,
    bytes: Vec<u8>,
    digest: String,
}
impl RootGraphStatement {
    pub fn parse_private_plaintext(bytes: &[u8]) -> Result<Self> {
        require(
            !bytes.is_empty() && bytes.len() <= MAX_ROOT_CIPHERTEXT_BYTES,
            ContractError::Bounds,
        )?;
        let mut raw: Object<Root> =
            serde_json::from_slice(bytes).map_err(|_| ContractError::Shape)?;
        let root = &mut raw.0;
        validate(root)?;
        let bytes = serde_json::to_vec(&root).map_err(|_| ContractError::Shape)?;
        require(
            bytes.len() <= MAX_ROOT_CIPHERTEXT_BYTES,
            ContractError::Bounds,
        )?;
        let digest = digest(b"rainsync-static-hls-root-v1\0", &bytes);
        Ok(Self {
            root: raw.0,
            bytes,
            digest,
        })
    }
    pub fn root_digest(&self) -> &str {
        &self.digest
    }
    pub fn private_storage_plaintext(&self) -> &[u8] {
        &self.bytes
    }
    pub fn parent_input_sha256(&self) -> &str {
        &self.root.parent_input_sha256
    }

    /// Timeline facts only; this does not transfer capture ownership or authority.
    pub fn source_origin_ms(&self) -> u32 {
        self.root.timeline.0.source_origin_ms
    }

    pub fn duration_ms(&self) -> f64 {
        self.root.timeline.0.duration_ms
    }
    pub fn selected_audio_statement(&self) -> SelectedAudioStatement {
        self.root
            .timeline
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Audio)
            .map_or(SelectedAudioStatement::None {}, |t| {
                SelectedAudioStatement::Single {
                    stream_index: t.stream_index,
                }
            })
    }
    pub fn require_parent_input(&self, input: &FrozenInput) -> Result<()> {
        require(
            input.kind() == OperationKind::Parent
                && self.root.parent_input_sha256 == input.input_sha256()
                && self.root.inventory[0].original_target_sha256 == input.target_sha256(),
            ContractError::Identity,
        )?;
        input.require_audio_statement(self.selected_audio_statement())
    }
    /// Bind a supplied child scan to its own target as well as the retained
    /// parent/root/audio statement. This does not authenticate the recapture.
    pub(super) fn require_child_scan_binding(&self, child: &FrozenInput) -> Result<()> {
        let root = child.child_root().ok_or(ContractError::Identity)?;
        require(
            root.parent_input_sha256 == self.root.parent_input_sha256
                && root.root_digest == self.digest
                && child.input_sha256() != root.parent_input_sha256
                && self.root.inventory[0].original_target_sha256 == child.target_sha256(),
            ContractError::Identity,
        )?;
        require(
            root.selected_audio == self.selected_audio_statement(),
            ContractError::Audio,
        )?;
        child.require_audio_statement(self.selected_audio_statement())
    }
    /// Recompute the complete recapture root using the retained parent's input
    /// digest. Bind the different child input separately; replacing the parent's
    /// digest with the child's digest is refused even for equal media bytes.
    pub fn require_child_recapture(&self, recapture: &Self, child: &FrozenInput) -> Result<()> {
        self.require_child_scan_binding(child)?;
        require(
            recapture.root.parent_input_sha256 == self.root.parent_input_sha256,
            ContractError::Identity,
        )?;
        require(
            self.bytes == recapture.bytes && self.digest == recapture.digest,
            ContractError::SourceChanged,
        )
    }
}

fn validate(root: &mut Root) -> Result<()> {
    use super::super::timeline::{
        MAX_INIT_BYTES, MAX_MANIFEST_BYTES, MAX_RECORDS, MAX_RESOURCE_BYTES, MAX_SEGMENTS,
        MAX_TOTAL_BYTES,
    };
    require(
        root.graph_version == GRAPH_VERSION
            && root.closure.version == 1
            && root.timeline.version == 1,
        ContractError::Version,
    )?;
    require(hash(&root.parent_input_sha256), ContractError::Identity)?;
    let closure = &root.closure;
    require(
        (1..=MAX_SEGMENTS).contains(&closure.segments.len())
            && (3..=66).contains(&root.inventory.len())
            && root.inventory.len() == closure.segments.len() + 2,
        ContractError::Bounds,
    )?;
    require(
        closure.manifest_bytes > 0
            && closure.manifest_bytes <= MAX_MANIFEST_BYTES
            && hash(&closure.manifest_sha256)
            && closure.init.bytes > 0
            && closure.init.bytes <= MAX_INIT_BYTES
            && hash(&closure.init.sha256),
        ContractError::Bounds,
    )?;
    let mut total = closure.manifest_bytes + closure.init.bytes;
    for (index, segment) in closure.segments.iter().enumerate() {
        require(
            segment.index == index
                && segment.bytes > 0
                && segment.bytes <= MAX_RESOURCE_BYTES
                && hash(&segment.sha256)
                && (1..=2).contains(&segment.track_ids.len())
                && segment.track_ids.iter().all(|id| *id > 0)
                && segment.track_ids.iter().collect::<BTreeSet<_>>().len()
                    == segment.track_ids.len(),
            ContractError::Bounds,
        )?;
        total = total
            .checked_add(segment.bytes)
            .ok_or(ContractError::Bounds)?;
    }
    require(total <= MAX_TOTAL_BYTES, ContractError::Bounds)?;
    for (index, resource) in root.inventory.iter().enumerate() {
        // Response ETags must survive the provider's HeaderValue::to_str path;
        // configured request-header values deliberately have different rules.
        let etag = http::HeaderValue::from_str(&resource.strong_etag)
            .map_err(|_| ContractError::Identity)?;
        etag.to_str().map_err(|_| ContractError::Identity)?;
        let (bytes, sha256) = match index {
            0 => (closure.manifest_bytes, &closure.manifest_sha256),
            1 => (closure.init.bytes, &closure.init.sha256),
            _ => (
                closure.segments[index - 2].bytes,
                &closure.segments[index - 2].sha256,
            ),
        };
        require(
            resource.bytes == bytes
                && resource.sha256 == *sha256
                && hash(&resource.original_target_sha256)
                && hash(&resource.final_target_sha256)
                && resource.strong_etag.len() >= 2
                && resource.strong_etag.len() <= 8192
                && resource.strong_etag.starts_with('"')
                && resource.strong_etag.ends_with('"')
                && resource.strong_etag.as_bytes()[1..resource.strong_etag.len() - 1]
                    .iter()
                    .all(|b| *b >= 0x21 && *b != b'"' && *b != 0x7f),
            ContractError::Identity,
        )?;
    }
    let timeline = &mut root.timeline;
    require(
        timeline.manifest_sha256 == closure.manifest_sha256
            && timeline.manifest_bytes == closure.manifest_bytes
            && timeline.init == closure.init
            && timeline.segments == closure.segments,
        ContractError::Identity,
    )?;
    require(
        timeline.scope == "bounded-zero-origin-avc-fmp4-prerequisite-only"
            && timeline.source_origin_ms == 0
            && timeline.duration_ms.is_finite()
            && timeline.duration_ms > 0.0
            && timeline.duration_ms <= 300_000.0
            && timeline.media_sequence <= MAX_SAFE_INTEGER
            && (1..=2).contains(&timeline.tracks.len()),
        ContractError::Bounds,
    )?;
    normalized_zero(&mut timeline.duration_ms);
    let mut ids = BTreeSet::new();
    let mut streams = BTreeSet::new();
    let mut records = 0usize;
    let mut video_end = None;
    let mut audio_end = None;
    for track in &mut timeline.tracks {
        require(
            track.track_id > 0
                && ids.insert(track.track_id)
                && streams.insert(track.stream_index)
                && track.packet_count > 0
                && track.decoded_frames > 0
                && track.packet_count <= MAX_RECORDS
                && track.decoded_frames <= MAX_RECORDS
                && hash(&track.codec_config_sha256),
            ContractError::Bounds,
        )?;
        records = records
            .checked_add(track.packet_count)
            .and_then(|n| n.checked_add(track.decoded_frames))
            .ok_or(ContractError::Bounds)?;
        let scale = track
            .time_base
            .strip_prefix("1/")
            .filter(|s| {
                !s.is_empty() && !s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit())
            })
            .and_then(|s| s.parse::<u32>().ok())
            .filter(|scale| *scale > 0 && *scale <= 1_000_000)
            .ok_or(ContractError::Bounds)?;
        require(
            [
                track.raw_first_pts,
                track.decoded_first_pts,
                track.last_frame_pts,
            ]
            .into_iter()
            .all(|n| n.unsigned_abs() <= MAX_SAFE_INTEGER)
                && track.decoded_first_pts == 0
                && track.last_frame_pts >= 0
                && track.raw_end_seconds.is_finite()
                && track.raw_end_seconds > 0.0
                && track.raw_end_seconds <= 300.0
                && track.end_seconds.is_finite()
                && track.end_seconds > 0.0
                && track.end_seconds <= 300.0 + 1024.0 / 48_000.0
                && track.tail_padding_samples < 1024,
            ContractError::Bounds,
        )?;
        normalized_zero(&mut track.raw_end_seconds);
        normalized_zero(&mut track.end_seconds);
        match track.kind {
            TrackKind::Video => {
                require(
                    video_end.is_none()
                        && track.raw_first_pts == 0
                        && track.priming_samples == 0
                        && track.tail_padding_samples == 0
                        && track.packet_count == track.decoded_frames
                        && track.raw_end_seconds == track.end_seconds,
                    ContractError::Bounds,
                )?;
                video_end = Some(track.end_seconds);
            }
            TrackKind::Audio => {
                // The complete scanner accepts either an explicitly skipped
                // priming packet or a fully decoded, validated edit preroll.
                // In the latter case the raw decoder count includes that frame;
                // decoded_first_pts still names the first presented sample.
                require(
                    audio_end.is_none()
                        && scale == 48_000
                        && matches!(track.priming_samples, 0 | 1024)
                        && track.raw_first_pts == -i64::from(track.priming_samples)
                        && (track.packet_count
                            == track.decoded_frames + usize::from(track.priming_samples > 0)
                            || (track.priming_samples == 1024
                                && track.packet_count == track.decoded_frames)),
                    ContractError::Audio,
                )?;
                let end = (track.last_frame_pts + 1024) as f64 / f64::from(scale);
                let raw_end = end - f64::from(track.tail_padding_samples) / f64::from(scale);
                require(
                    (end - track.end_seconds).abs() <= 0.000_001_1
                        && (raw_end - track.raw_end_seconds).abs() <= 0.000_001_1,
                    ContractError::Audio,
                )?;
                audio_end = Some((track.raw_end_seconds, track.end_seconds));
            }
        }
    }
    require(records <= MAX_RECORDS, ContractError::Bounds)?;
    let video_end = video_end.ok_or(ContractError::Bounds)?;
    require(
        (video_end * 1000.0 - timeline.duration_ms).abs() <= 0.001_1
            && closure
                .segments
                .iter()
                .all(|s| s.track_ids.iter().copied().collect::<BTreeSet<_>>() == ids),
        ContractError::Bounds,
    )?;
    if let Some((raw, end)) = audio_end {
        require(
            (raw - video_end).abs() <= 0.000_001_1
                && end >= video_end
                && end - video_end <= 1024.0 / 48_000.0 + 0.000_001,
            ContractError::Audio,
        )?;
    }
    Ok(())
}
