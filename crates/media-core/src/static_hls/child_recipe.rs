//! Inactive candidate parameter construction for a scanned static-HLS child.
//!
//! This is not an admission, a child claim, or an encoder/input-lease API. The
//! candidate class is narrower than Stage A, and the retained native fixture
//! does not qualify every source or seek in it. Public activation stays off.
//! Serialized probe/catalog/client facts cannot construct `CandidateChildRecipe`:
//! its only constructor borrows an original, live `VerifiedCapture` and reads
//! its revalidated sealed manifest. That capture minted the source facts and
//! timeline from its complete structural/packet/decoded-frame scanner.
use super::{CaptureEvidence, ReadMethod, ReadResource, VerifiedCapture, timeline};
use anyhow::{Result, ensure};
use protocol::{AudioCapabilityConfiguration, VideoCapabilityConfiguration};
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::path::Path;
use std::time::Duration;
use tokio::time::Instant;

pub const CANDIDATE_NAME: &str = "static_hls_seq_trim_25mono_to_30stereo_v1";
pub const DEFAULT_ENABLED: bool = false;
pub const MAX_SOURCE_SECONDS: u64 = 14;
pub const MAX_SOURCE_SEGMENTS: usize = 14;
pub const MAX_ENCODE_TIME: Duration = Duration::from_secs(20);
pub const MAX_CPU_SECONDS: u64 = 20;
pub const MAX_OUTPUT_SECONDS: u64 = 20;
pub const MAX_OUTPUT_RESOURCE_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_OUTPUT_FILES: usize = 8;
pub const MAX_ADDRESS_SPACE_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_DIAGNOSTIC_PIPE_BYTES: usize = 64 * 1024;

/// A separate encode wall fence, bounded by the original preparation and root
/// deadlines. Capture completion cannot restart either original deadline.
/// The process owner must supervise this fence and positively reap on stop;
/// this value, a timeout, or dropping a waiter does not establish disposal.
pub struct ChildEncodeBudget {
    until: Instant,
}
impl ChildEncodeBudget {
    pub fn begin(preparation_until: Instant, root_until: Instant) -> Result<Self> {
        let now = Instant::now();
        Self::at(now, preparation_until, root_until)
    }

    fn at(now: Instant, preparation_until: Instant, root_until: Instant) -> Result<Self> {
        let until = (now + MAX_ENCODE_TIME)
            .min(preparation_until)
            .min(root_until);
        ensure!(until > now, "static_hls_child_encode_deadline");
        Ok(Self { until })
    }

    pub fn until(&self) -> Instant {
        self.until
    }

    pub fn remaining(&self) -> Result<Duration> {
        let remaining = self.until.saturating_duration_since(Instant::now());
        ensure!(!remaining.is_zero(), "static_hls_child_encode_deadline");
        Ok(remaining)
    }

    /// Later authority observations may only shorten the existing fence.
    pub fn shorten(&mut self, preparation_until: Instant, root_until: Instant) -> Result<()> {
        self.until = self.until.min(preparation_until).min(root_until);
        self.remaining()?;
        Ok(())
    }
}

#[derive(Debug, PartialEq)]
struct Parameters {
    video_index: u32,
    audio_index: u32,
    position_ms: f64,
    source_end_seconds: f64,
}

/// Nonserializable candidate observations tied to a live original capture.
/// This does not prove a same-Worker root comparison, a job claim, or an output
/// reservation. Those checks remain mandatory before acquiring an input lease
/// and before process spawn/output publication.
pub struct CandidateChildRecipe<'capture> {
    capture: &'capture VerifiedCapture,
    parameters: Parameters,
}
/// Private execution binding. Only an actual live original recipe can make it.
#[derive(PartialEq)]
pub(super) struct RecipeBinding {
    pub(super) source_pointer: usize,
    pub(super) source_identity: super::CaptureOwnerIdentity,
    pub(super) position_ms: f64,
    pub(super) source_end_seconds: f64,
    pub(super) video_index: u32,
    pub(super) audio_index: u32,
    pub(super) argv_sha256: String,
}
impl<'capture> CandidateChildRecipe<'capture> {
    pub async fn from_capture(
        capture: &'capture VerifiedCapture,
        position_ms: f64,
    ) -> Result<Self> {
        ensure!(cfg!(target_os = "linux"), "static_hls_linux_required");
        // Refuse invalid/out-of-source requests before acquiring a manifest
        // reader or performing any original-permit/transport I/O.
        let position_ms = checked_position(
            position_ms,
            capture.live_evidence()?.timeline.duration_ms / 1000.0,
        )?;
        let mut lease = capture
            .read(ReadResource::Manifest, ReadMethod::Get, None)
            .await?;
        ensure!(
            !lease.is_partial() && lease.total_bytes() <= super::MANIFEST_BYTES,
            "static_hls_child_manifest_bound"
        );
        let mut manifest = Vec::with_capacity(lease.total_bytes());
        while let Some(chunk) = lease.chunk().await? {
            ensure!(
                chunk.len() <= super::MANIFEST_BYTES.saturating_sub(manifest.len()),
                "static_hls_child_manifest_bound"
            );
            manifest.extend_from_slice(&chunk);
        }
        ensure!(
            manifest.len() == lease.total_bytes(),
            "static_hls_child_manifest_changed"
        );
        let parameters = qualify(capture.live_evidence()?, &manifest, position_ms)?;
        Ok(Self {
            capture,
            parameters,
        })
    }

    pub(super) fn execution_binding(&self, argv_sha256: String) -> Result<RecipeBinding> {
        self.capture.live_evidence()?;
        let source_identity = self.capture.control()?.identity().clone();
        Ok(RecipeBinding {
            source_pointer: self.capture as *const VerifiedCapture as usize,
            source_identity,
            position_ms: self.parameters.position_ms,
            source_end_seconds: self.parameters.source_end_seconds,
            video_index: self.parameters.video_index,
            audio_index: self.parameters.audio_index,
            argv_sha256,
        })
    }
    pub(super) fn source_evidence(&self) -> Result<&CaptureEvidence> {
        self.capture.live_evidence()
    }

    pub fn selected_audio(&self) -> u32 {
        self.parameters.audio_index
    }

    pub fn selected_video(&self) -> u32 {
        self.parameters.video_index
    }

    pub fn position_ms(&self) -> f64 {
        self.parameters.position_ms
    }

    pub fn source_end_seconds(&self) -> f64 {
        self.parameters.source_end_seconds
    }

    /// Local liveness only; the owner must also repeat its live database and
    /// same-Worker authority predicate before any encoder side effect.
    pub fn check(&self, budget: &ChildEncodeBudget) -> Result<()> {
        self.capture.live_evidence()?;
        budget.remaining()?;
        Ok(())
    }

    /// Parameter construction requires this capture's original managed input
    /// lease. The lease retains its sealed descriptor through process-tree
    /// reap; a caller-supplied path, descriptor or UUID cannot substitute.
    ///
    /// `output` must already have a fresh, attempt-owned output directory and
    /// independently admitted output-write reservation. The owner must enforce
    /// the wall fence, CPU/address-space/file-size/pipe bounds above, allow only
    /// index.m3u8[.tmp], init.mp4, s000..s004.m4s[.tmp], and check the eight-file
    /// and 32 MiB aggregate after reap. Argv alone cannot prove those bounds.
    #[cfg(target_os = "linux")]
    pub fn ffmpeg_args(
        &self,
        lease: &super::EncoderInputLease,
        output: &Path,
        budget: &ChildEncodeBudget,
    ) -> Result<Vec<String>> {
        self.check(budget)?;
        lease.with_directory(self.capture, |directory| {
            use std::os::fd::AsRawFd;
            arguments(&self.parameters, directory.as_raw_fd(), output)
        })
    }

    /// Build the closed recipe only inside the output owner's controlled
    /// spawn callback. Its input descriptor is supplied by the same original
    /// encoder lease, so this avoids reacquiring that lease's descriptor lock.
    /// The caller must drain the bounded diagnostic pipe and verify all output
    /// before claiming encoding success or publishing anything.
    #[cfg(target_os = "linux")]
    pub async fn spawn_owned(
        &self,
        output: &super::child_output_owner::ChildOutputOwner,
        budget: &ChildEncodeBudget,
    ) -> Result<crate::child_process::Child> {
        use std::{os::fd::AsRawFd, process::Stdio};
        self.check(budget)?;
        output
            .spawn_via_input(self.capture, |input, directory| {
                self.check(budget)?;
                let mut command = tokio::process::Command::new("ffmpeg");
                let args = arguments(&self.parameters, input.as_raw_fd(), directory)?;
                output.record_candidate_recipe(
                    self,
                    format!("{:x}", Sha256::digest(serde_json::to_vec(&args)?)),
                )?;
                command.args(args);
                command
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped());
                Ok(command)
            })
            .await
    }
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn close(a: f64, b: f64) -> bool {
    a.is_finite() && b.is_finite() && (a - b).abs() <= 0.000_001_1
}

/// Keep the frozen requested scalar, canonicalizing only signed zero. The
/// original scanner's source end is the bound; finite nonnegative positions
/// outside it are never admitted by the candidate recipe.
fn checked_position(position_ms: f64, source_end_seconds: f64) -> Result<f64> {
    ensure!(
        position_ms.is_finite()
            && position_ms >= 0.0
            && position_ms <= super::contracts::MAX_SAFE_INTEGER as f64
            && source_end_seconds.is_finite()
            && source_end_seconds > 0.0
            && source_end_seconds <= MAX_SOURCE_SECONDS as f64
            && position_ms < source_end_seconds * 1000.0,
        "static_hls_child_position"
    );
    Ok(if position_ms == 0.0 { 0.0 } else { position_ms })
}

/// FFmpeg's trim/atrim duration options use AV_TIME_BASE microsecond ticks.
/// Render one shared, ordinary decimal for trim and timestamp rebasing, rounded
/// to the nearest tick (within 0.500001 microseconds of the requested scalar,
/// including floating-point conversion error).
/// This is an argv representation only: the recipe/binding/decoded evidence
/// retain the original f64, and the unchanged one-sample/one-frame validation
/// bounds remain against that original request. No sub-sample exactness is
/// asserted. The candidate's 14-second source bound keeps this conversion safe.
#[cfg(target_os = "linux")]
fn ffmpeg_start(position_ms: f64) -> Result<String> {
    ensure!(
        position_ms.is_finite()
            && position_ms >= 0.0
            && position_ms < MAX_SOURCE_SECONDS as f64 * 1000.0,
        "static_hls_child_position"
    );
    let microseconds = (position_ms * 1000.0).round() as u64;
    ensure!(
        (microseconds as f64 / 1000.0 - position_ms).abs() <= 0.000_500_001,
        "static_hls_child_position_representation"
    );
    let mut decimal = format!(
        "{}.{:06}",
        microseconds / 1_000_000,
        microseconds % 1_000_000
    );
    // Preserve the original millisecond representation for integral requests.
    while decimal.ends_with('0') && decimal.len() - decimal.find('.').unwrap() - 1 > 3 {
        decimal.pop();
    }
    Ok(decimal)
}

/// Private validation of observations already minted by the live scanner. It
/// is deliberately not a public `CaptureEvidence`/JSON recipe constructor.
fn qualify(evidence: &CaptureEvidence, manifest: &[u8], position_ms: f64) -> Result<Parameters> {
    let proof = &evidence.timeline;
    let decoder = &evidence.decoder;
    ensure!(
        evidence.version == 1
            && evidence.closure == proof.closure
            && proof.closure.version == 1
            && proof.scope == "bounded-zero-origin-avc-fmp4-prerequisite-only"
            && proof.source_origin_ms == 0
            && decoder.exit_code == 0
            && decoder.stderr_bytes == 0
            && decoder.process_tree_reaped
            && decoder.stdout_bytes > 0
            && decoder.stdout_bytes <= timeline::MAX_DECODER_OUTPUT_BYTES
            && decoder.address_space_bytes == MAX_ADDRESS_SPACE_BYTES
            && evidence.elapsed_ms <= timeline::MAX_DECODE_MILLISECONDS
            && [
                &decoder.executable_sha256,
                &decoder.argv_sha256,
                &decoder.stdout_sha256
            ]
            .into_iter()
            .all(|value| hash(value))
            && decoder.manifest_sha256 == format!("{:x}", Sha256::digest(manifest)),
        "static_hls_child_scanner_evidence"
    );
    let playlist = timeline::parse_playlist(std::str::from_utf8(manifest)?)?;
    ensure!(
        (1..=MAX_SOURCE_SEGMENTS).contains(&playlist.segments.len())
            && playlist.map == "init.mp4"
            && playlist
                .segments
                .iter()
                .enumerate()
                .all(|(index, segment)| {
                    segment.duration == 1.0 && segment.uri == format!("s{index:03}.m4s")
                })
            && playlist.seconds <= MAX_SOURCE_SECONDS as f64
            && playlist.sequence == proof.media_sequence
            && proof.closure.segments.len() == playlist.segments.len()
            && proof.duration_ms == playlist.seconds * 1000.0
            && proof.tracks.len() == 2,
        "static_hls_child_candidate_scope"
    );

    let video = proof
        .tracks
        .iter()
        .find(|track| track.kind == timeline::TrackKind::Video)
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_video_required"))?;
    let audio = proof
        .tracks
        .iter()
        .find(|track| track.kind == timeline::TrackKind::Audio)
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_audio_required"))?;
    let scale = video
        .time_base
        .strip_prefix("1/")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|scale| *scale > 0 && *scale <= 1_000_000 && *scale % 25 == 0)
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_video_clock"))?;
    let frames = playlist.segments.len() * 25;
    ensure!(
        video.track_id > 0
            && audio.track_id > 0
            && video.track_id != audio.track_id
            && video.stream_index != audio.stream_index
            && video.packet_count == frames
            && video.decoded_frames == frames
            && video.raw_first_pts == 0
            && video.decoded_first_pts == 0
            && video.priming_samples == 0
            && video.tail_padding_samples == 0
            && video.last_frame_pts == (frames as i64 - 1) * i64::from(scale / 25)
            && video.end_seconds == frames as f64 / 25.0
            && video.raw_end_seconds == video.end_seconds
            && video.end_seconds == proof.duration_ms / 1000.0
            && hash(&video.codec_config_sha256)
            && hash(&audio.codec_config_sha256),
        "static_hls_child_video_clock"
    );
    ensure!(
        audio.time_base == "1/48000"
            && audio.decoded_first_pts == 0
            && matches!(audio.priming_samples, 0 | 1024)
            && audio.raw_first_pts == -i64::from(audio.priming_samples)
            && (1..=timeline::MAX_RECORDS).contains(&audio.packet_count)
            && (1..=timeline::MAX_RECORDS).contains(&audio.decoded_frames)
            && audio.tail_padding_samples < 1024
            && audio.last_frame_pts >= 0
            && audio.last_frame_pts <= 48_000 * MAX_SOURCE_SECONDS as i64
            && (audio.packet_count
                == audio.decoded_frames + usize::from(audio.priming_samples > 0)
                || (audio.priming_samples == 1024 && audio.packet_count == audio.decoded_frames))
            && close(audio.raw_end_seconds, video.end_seconds)
            && close(
                audio.end_seconds,
                (audio.last_frame_pts + 1024) as f64 / 48_000.0
            )
            && close(
                audio.raw_end_seconds,
                audio.end_seconds - f64::from(audio.tail_padding_samples) / 48_000.0
            )
            && audio.end_seconds >= video.end_seconds
            && audio.end_seconds - video.end_seconds <= 1024.0 / 48_000.0 + 0.000_001,
        "static_hls_child_audio_clock"
    );
    ensure!(
        video.packet_count + video.decoded_frames + audio.packet_count + audio.decoded_frames
            <= timeline::MAX_RECORDS
            && evidence.inventory.len() == proof.closure.segments.len() + 2
            && evidence.actual_bytes <= super::TOTAL_BYTES,
        "static_hls_child_closure_bound"
    );
    let mut actual_bytes = 0usize;
    for (index, resource) in evidence.inventory.iter().enumerate() {
        let (bytes, sha256, maximum) = match index {
            0 => (
                proof.closure.manifest_bytes,
                &proof.closure.manifest_sha256,
                super::MANIFEST_BYTES,
            ),
            1 => (
                proof.closure.init.bytes,
                &proof.closure.init.sha256,
                super::INIT_BYTES,
            ),
            _ => {
                let segment = &proof.closure.segments[index - 2];
                ensure!(
                    segment.index == index - 2
                        && segment.track_ids.len() == 2
                        && segment.track_ids.contains(&video.track_id)
                        && segment.track_ids.contains(&audio.track_id),
                    "static_hls_child_muxed_track_set"
                );
                (segment.bytes, &segment.sha256, super::RESOURCE_BYTES)
            }
        };
        ensure!(
            bytes > 0
                && bytes <= maximum
                && hash(sha256)
                && resource.bytes == bytes
                && resource.sha256 == *sha256
                && hash(&resource.original_target_sha256)
                && hash(&resource.final_target_sha256),
            "static_hls_child_closure_identity"
        );
        if let Some(projection) = &resource.projection {
            ensure!(
                index > 0
                    && projection.representation_bytes > 0
                    && projection.representation_bytes <= super::RESOURCE_BYTES
                    && projection
                        .offset
                        .checked_add(bytes)
                        .is_some_and(|end| end <= projection.representation_bytes)
                    && hash(&projection.representation_sha256),
                "static_hls_child_closure_identity"
            );
        }
        actual_bytes = actual_bytes
            .checked_add(
                resource
                    .projection
                    .as_ref()
                    .map_or(bytes, |p| p.representation_bytes),
            )
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_closure_bound"))?;
    }
    ensure!(
        actual_bytes == evidence.actual_bytes,
        "static_hls_child_closure_identity"
    );

    // This JSON is internal scanner output on the borrowed live capture, not
    // catalog/client metadata. Header/decoder agreement and SDR/protection
    // checks were performed by scanner::qualify_source and inspect_probe.
    let facts = &evidence.source_facts;
    let measured_video: VideoCapabilityConfiguration =
        serde_json::from_value(facts["video"].clone())?;
    let measured_audio: AudioCapabilityConfiguration =
        serde_json::from_value(facts["audio"].clone())?;
    ensure!(
        measured_video.width == 640
            && measured_video.height == 360
            && measured_video.framerate == 25.0
            && measured_audio.channels == "1"
            && measured_audio.samplerate == 48_000
            && measured_audio.content_type == "audio/mp4; codecs=\"mp4a.40.2\""
            && facts["selected_audio"].as_u64() == Some(u64::from(audio.stream_index))
            && facts["codec_tag"] == "avc1"
            && matches!(facts["pixel_format"].as_str(), Some("yuv420p" | "yuvj420p"))
            && facts["protected_track_indicators"] == false
            && facts["stage_a_only"] == true,
        "static_hls_child_candidate_scope"
    );
    let position_ms = checked_position(position_ms, video.end_seconds)?;
    Ok(Parameters {
        video_index: video.stream_index,
        audio_index: audio.stream_index,
        position_ms,
        source_end_seconds: video.end_seconds,
    })
}

#[cfg(target_os = "linux")]
fn arguments(parameters: &Parameters, directory_fd: i32, output: &Path) -> Result<Vec<String>> {
    use std::path::Component;
    let output = output
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_path"))?;
    ensure!(
        directory_fd >= 0
            && Path::new(output).is_absolute()
            && output.len() <= 4096
            && Path::new(output).components().count() > 1
            && !output
                .bytes()
                .any(|byte| byte < 32 || byte == 127 || byte == b'%' || byte == b'\\')
            && Path::new(output)
                .components()
                .all(|component| matches!(component, Component::RootDir | Component::Normal(_))),
        "static_hls_child_output_path"
    );
    let start = ffmpeg_start(parameters.position_ms)?;
    let end = parameters.source_end_seconds.to_string();
    let video_filter = format!(
        "trim=start={start}:end={end},setpts=PTS-{start}/TB,{},fps=fps=30:start_time=0:round=near",
        crate::capabilities::OUTPUT_VIDEO_FILTER
    );
    // atrim selects actual samples on the verified 48 kHz source clock. Rebase
    // from its first retained integer PTS: dividing the decimal request by TB
    // can put an exact sample boundary slightly above that integer (1013.5 ms
    // becomes 48648.00000000001), truncating subsequent PTS to 1023/2047 and
    // manufacturing AAC timestamp gaps. STARTPTS subtraction keeps the actual
    // trimmed sample clock exact; full validation still compares the measured
    // output duration to the unchanged original requested f64 within one sample.
    let audio_filter = format!("atrim=start={start}:end={end},asetpts=PTS-STARTPTS");
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-n",
        "-v",
        "error",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-max_alloc",
        "134217728",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "hls,mov",
        "-err_detect",
        "explode",
        "-copyts",
        "-i",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    args.extend([
        format!("/proc/self/fd/{directory_fd}/index.m3u8"),
        "-map".into(),
        format!("0:{}", parameters.video_index),
        "-map".into(),
        format!("0:{}", parameters.audio_index),
    ]);
    args.extend(
        [
            "-threads:v",
            "1",
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            "-level:v",
            "3.1",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-maxrate",
            "4M",
            "-bufsize",
            "8M",
            "-bf",
            "0",
            "-r",
            "30",
            "-fps_mode",
            "cfr",
            "-vf",
        ]
        .into_iter()
        .map(String::from),
    );
    args.extend([
        video_filter,
        "-force_key_frames".into(),
        "expr:gte(t,n_forced*4)".into(),
        "-tag:v".into(),
        "avc1".into(),
        "-af".into(),
        audio_filter,
    ]);
    args.extend(
        [
            "-c:a",
            "aac",
            "-profile:a",
            "aac_low",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-b:a",
            "128k",
            "-avoid_negative_ts",
            "disabled",
            "-f",
            "hls",
            "-hls_time",
            "4",
            "-hls_segment_type",
            "fmp4",
            "-hls_playlist_type",
            "event",
            "-hls_flags",
            "temp_file",
            "-hls_fmp4_init_filename",
            "init.mp4",
            "-t",
        ]
        .into_iter()
        .map(String::from),
    );
    args.extend([
        MAX_OUTPUT_SECONDS.to_string(),
        "-hls_segment_filename".into(),
    ]);
    args.push(
        Path::new(output)
            .join("s%03d.m4s")
            .to_str()
            .expect("UTF-8 output")
            .into(),
    );
    args.push(
        Path::new(output)
            .join("index.m3u8")
            .to_str()
            .expect("UTF-8 output")
            .into(),
    );
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::super::{ResourceIdentity, scanner::DecoderEvidence};
    use super::*;
    use timeline::{
        ClosureIdentity, ResourceIdentity as ClosureResource, SegmentIdentity, TimelineProof,
        TrackKind, TrackSummary,
    };

    // Synthetic observations test rejection and parameter mechanics only. They
    // cannot construct a live VerifiedCapture or qualify a production source.
    fn observations() -> (CaptureEvidence, Vec<u8>) {
        let hash = "a".repeat(64);
        let manifest = b"#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:32\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:1.000000,\ns000.m4s\n#EXT-X-ENDLIST\n".to_vec();
        let closure = ClosureIdentity {
            version: 1,
            manifest_sha256: hash.clone(),
            manifest_bytes: 200,
            init: ClosureResource {
                bytes: 100,
                sha256: hash.clone(),
            },
            segments: vec![SegmentIdentity {
                index: 0,
                bytes: 1000,
                sha256: hash.clone(),
                track_ids: vec![1, 2],
            }],
        };
        let track = TrackSummary {
            track_id: 1,
            stream_index: 3,
            kind: TrackKind::Video,
            time_base: "1/12800".into(),
            packet_count: 25,
            decoded_frames: 25,
            raw_first_pts: 0,
            decoded_first_pts: 0,
            priming_samples: 0,
            tail_padding_samples: 0,
            raw_end_seconds: 1.0,
            end_seconds: 1.0,
            last_frame_pts: 24 * 512,
            codec_config_sha256: hash.clone(),
        };
        let audio = TrackSummary {
            track_id: 2,
            stream_index: 5,
            kind: TrackKind::Audio,
            time_base: "1/48000".into(),
            packet_count: 48,
            decoded_frames: 48,
            raw_first_pts: -1024,
            decoded_first_pts: 0,
            priming_samples: 1024,
            tail_padding_samples: 128,
            raw_end_seconds: 1.0,
            end_seconds: 48128.0 / 48000.0,
            last_frame_pts: 47104,
            codec_config_sha256: hash.clone(),
        };
        let inventory = [200, 100, 1000]
            .into_iter()
            .map(|bytes| ResourceIdentity {
                projection: None,
                original_target_sha256: hash.clone(),
                final_target_sha256: hash.clone(),
                strong_etag: "\"v1\"".into(),
                bytes,
                sha256: hash.clone(),
            })
            .collect();
        let evidence = CaptureEvidence {
            version: 1,
            inventory,
            closure: closure.clone(),
            timeline: TimelineProof {
                closure,
                scope: "bounded-zero-origin-avc-fmp4-prerequisite-only".into(),
                source_origin_ms: 0,
                duration_ms: 1000.0,
                media_sequence: 0,
                tracks: vec![track, audio],
            },
            source_facts: serde_json::json!({
                "video":{"content_type":"video/mp4; codecs=\"avc1.64001F\"", "width":640, "height":360, "bitrate":1000000, "framerate":25.0},
                "audio":{"content_type":"audio/mp4; codecs=\"mp4a.40.2\"", "channels":"1", "bitrate":128000, "samplerate":48000},
                "selected_audio":5, "codec_tag":"avc1", "pixel_format":"yuv420p", "protected_track_indicators":false, "stage_a_only":true
            }),
            decoder: DecoderEvidence {
                executable_sha256: hash.clone(),
                argv_sha256: hash.clone(),
                manifest_sha256: format!("{:x}", Sha256::digest(&manifest)),
                stdout_sha256: hash,
                stdout_bytes: 1000,
                stderr_bytes: 0,
                exit_code: 0,
                process_tree_reaped: true,
                address_space_bytes: MAX_ADDRESS_SPACE_BYTES,
            },
            actual_bytes: 1300,
            elapsed_ms: 1,
        };
        (evidence, manifest)
    }

    #[test]
    fn candidate_is_inactive_and_not_stage_a_broad_admission() {
        assert!(!std::hint::black_box(DEFAULT_ENABLED));
        let (evidence, manifest) = observations();
        assert_eq!(qualify(&evidence, &manifest, 13.0).unwrap().audio_index, 5);
        for mutation in [
            "stereo",
            "30fps",
            "geometry",
            "missing_audio",
            "selected_audio",
            "unreaped",
            "stderr",
            "clock",
            "muxed",
        ] {
            let mut evidence = evidence.clone();
            match mutation {
                "stereo" => evidence.source_facts["audio"]["channels"] = "2".into(),
                "30fps" => evidence.source_facts["video"]["framerate"] = 30.0.into(),
                "geometry" => evidence.source_facts["video"]["width"] = 1280.into(),
                "missing_audio" => {
                    evidence.timeline.tracks.pop();
                }
                "selected_audio" => evidence.source_facts["selected_audio"] = 1.into(),
                "unreaped" => evidence.decoder.process_tree_reaped = false,
                "stderr" => evidence.decoder.stderr_bytes = 1,
                "clock" => evidence.timeline.tracks[0].packet_count = 30,
                "muxed" => {
                    evidence.closure.segments[0].track_ids.pop();
                    evidence.timeline.closure = evidence.closure.clone();
                }
                _ => unreachable!(),
            }
            assert!(qualify(&evidence, &manifest, 13.0).is_err(), "{mutation}");
        }
        assert!(qualify(&evidence, &manifest, 1000.0).is_err());
        assert!(qualify(&evidence, &manifest, f64::MAX).is_err());
    }

    #[test]
    fn requested_scalar_stays_fractional_and_invalid_positions_are_refused() {
        let (evidence, manifest) = observations();
        for requested in [0.0, 13.5, 13.123456789, 999.9999] {
            let parameters = qualify(&evidence, &manifest, requested).unwrap();
            assert_eq!(parameters.position_ms.to_bits(), requested.to_bits());
        }
        assert_eq!(
            checked_position(-0.0, 1.0).unwrap().to_bits(),
            0.0f64.to_bits()
        );
        for rejected in [
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            -0.001,
            1000.0,
            1000.5,
            f64::MAX,
        ] {
            assert!(checked_position(rejected, 1.0).is_err(), "{rejected:?}");
            assert!(
                qualify(&evidence, &manifest, rejected).is_err(),
                "{rejected:?}"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fractional_argv_uses_bounded_microseconds_without_replacing_the_request() {
        let (evidence, manifest) = observations();
        let requested = 13.123456789;
        let parameters = qualify(&evidence, &manifest, requested).unwrap();
        let args = arguments(&parameters, 9, Path::new("/owned/attempt")).unwrap();
        let value =
            |name: &str| args[args.iter().position(|arg| arg == name).unwrap() + 1].as_str();
        assert!(value("-vf").starts_with("trim=start=0.013123:end=1,setpts=PTS-0.013123/TB,"));
        assert_eq!(
            value("-af"),
            "atrim=start=0.013123:end=1,asetpts=PTS-STARTPTS"
        );
        assert_eq!(parameters.position_ms.to_bits(), requested.to_bits());
        assert_eq!(ffmpeg_start(1013.0).unwrap(), "1.013");
        assert_eq!(ffmpeg_start(1013.5).unwrap(), "1.0135");
        let fractional = Parameters {
            position_ms: 1013.5,
            source_end_seconds: 3.0,
            video_index: 0,
            audio_index: 1,
        };
        let fractional_args = arguments(&fractional, 9, Path::new("/owned/attempt")).unwrap();
        let audio = fractional_args
            [fractional_args.iter().position(|arg| arg == "-af").unwrap() + 1]
            .as_str();
        assert_eq!(audio, "atrim=start=1.0135:end=3,asetpts=PTS-STARTPTS");
        assert_eq!(ffmpeg_start(-0.0).unwrap(), "0.000");
        // Distinct frozen requests can share an argv tick; they must still be
        // distinct original-owner recipe bindings, never rounded intents.
        let next = qualify(&evidence, &manifest, requested + 0.0000001).unwrap();
        assert_eq!(
            ffmpeg_start(next.position_ms).unwrap(),
            ffmpeg_start(requested).unwrap()
        );
        assert_ne!(next, parameters);
        let represented = ffmpeg_start(requested).unwrap().parse::<f64>().unwrap() * 1000.0;
        assert!((represented - requested).abs() <= 0.000_500_001);
    }

    #[test]
    fn sealed_manifest_identity_and_one_second_segments_are_required() {
        let (evidence, manifest) = observations();
        let changed = String::from_utf8(manifest)
            .unwrap()
            .replace("1.000000", "0.999999")
            .into_bytes();
        assert!(qualify(&evidence, &changed, 0.0).is_err());
        let mut matching_decoder = evidence;
        matching_decoder.decoder.manifest_sha256 = format!("{:x}", Sha256::digest(&changed));
        assert!(qualify(&matching_decoder, &changed, 0.0).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn sequential_args_have_exact_maps_absolute_trim_and_resampling() {
        let (evidence, manifest) = observations();
        let parameters = qualify(&evidence, &manifest, 13.0).unwrap();
        let args = arguments(&parameters, 9, Path::new("/owned/attempt")).unwrap();
        let value =
            |name: &str| args[args.iter().position(|arg| arg == name).unwrap() + 1].as_str();
        assert_eq!(value("-i"), "/proc/self/fd/9/index.m3u8");
        assert_eq!(value("-protocol_whitelist"), "file");
        assert_eq!(value("-format_whitelist"), "hls,mov");
        assert!(
            args.iter().position(|arg| arg == "-copyts").unwrap()
                < args.iter().position(|arg| arg == "-i").unwrap()
        );
        assert!(!args.iter().any(|arg| matches!(
            arg.as_str(),
            "-ss" | "-sseof" | "-seek_timestamp" | "-start_at_zero" | "-shortest"
        )));
        assert!(args.windows(2).any(|pair| pair == ["-map", "0:3"]));
        assert!(args.windows(2).any(|pair| pair == ["-map", "0:5"]));
        assert!(value("-vf").starts_with("trim=start=0.013:end=1,setpts=PTS-0.013/TB,"));
        assert!(value("-vf").ends_with("fps=fps=30:start_time=0:round=near"));
        assert_eq!(value("-af"), "atrim=start=0.013:end=1,asetpts=PTS-STARTPTS");
        assert_eq!(value("-ac"), "2");
        assert_eq!(value("-ar"), "48000");
        assert_eq!(value("-t"), "20");
        assert_eq!(value("-hls_segment_filename"), "/owned/attempt/s%03d.m4s");
        assert_eq!(args.last().unwrap(), "/owned/attempt/index.m3u8");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn caller_paths_cannot_be_urls_relative_paths_or_format_patterns() {
        let (evidence, manifest) = observations();
        let parameters = qualify(&evidence, &manifest, 0.0).unwrap();
        for output in [
            "https://example.invalid/x",
            "relative",
            "/owned/../other",
            "/owned/%d",
            "/owned/\n",
            "/owned/\\other",
        ] {
            assert!(
                arguments(&parameters, 9, Path::new(output)).is_err(),
                "{output:?}"
            );
        }
        assert!(arguments(&parameters, -1, Path::new("/owned/attempt")).is_err());
    }

    #[test]
    fn encode_deadlines_do_not_restart_preparation_or_expand() {
        let now = Instant::now();
        let budget = ChildEncodeBudget::at(
            now,
            now + Duration::from_secs(45),
            now + Duration::from_secs(1800),
        )
        .unwrap();
        assert_eq!(budget.until(), now + MAX_ENCODE_TIME);
        let mut budget = ChildEncodeBudget::at(
            now,
            now + Duration::from_secs(2),
            now + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(budget.until(), now + Duration::from_secs(1));
        budget
            .shorten(now + Duration::from_secs(30), now + Duration::from_secs(60))
            .unwrap();
        assert_eq!(budget.until(), now + Duration::from_secs(1));
        assert!(ChildEncodeBudget::at(now, now, now + Duration::from_secs(1)).is_err());
        assert!(ChildEncodeBudget::at(now, now + Duration::from_secs(1), now).is_err());
    }
}
