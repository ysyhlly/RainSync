//! Complete, original-owner child-output validation. Probe JSON, exit status,
//! an inventory, IDs and paths cannot manufacture this witness. Publication is
//! a separate consuming persistence operation; this module grants no playback.
use super::{
    CaptureOwnerIdentity,
    child_output_owner::{
        ChildOutputOwner, ChildOutputSnapshot, OutputIdentity, OutputPermit, OutputReaderGuard,
        PublishedOutputPermit,
    },
    child_recipe::{self, CandidateChildRecipe},
    scanner::DecoderEvidence,
    timeline::{self, TrackKind},
};
use anyhow::{Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    process::Stdio,
    sync::Arc,
};
use tokio::io::AsyncReadExt;

const VIDEO_FPS: u32 = 30;
const AUDIO_SCALE: u32 = 48_000;
const MAX_RECORDS: usize = 5000;
const PROBE_BYTES: usize = 4 * 1024 * 1024;

/// Observations only. Copying these cannot grant access or reconstruct custody.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputResourceHash {
    pub name: String,
    pub bytes: usize,
    pub sha256: String,
}

/// Real packet and decoded-frame observations, bound to the complete resources.
#[derive(Debug)]
pub struct ChildDecodedTimeline {
    pub video_frames: usize,
    pub video_time_base: String,
    pub video_end_seconds: f64,
    pub audio_packets: usize,
    pub audio_decoded_frames: usize,
    pub audio_priming_samples: u32,
    pub audio_tail_padding_samples: u32,
    pub audio_raw_end_samples: i64,
    pub audio_decoded_end_samples: i64,
    pub source_position_ms: f64,
    pub source_end_seconds: f64,
}

/// Opaque and nonserializable. Owns the SAME original output owner, all hashes
/// and real successful/reaped decoder evidence. It has no path/proof constructor,
/// Clone, Deserialize or Serialize implementation. A dropped witness requests
/// cleanup; independent custody remains until positive actual drain/removal.
pub struct ValidatedChildOutput {
    owner: ChildOutputOwner,
    source_identity: CaptureOwnerIdentity,
    resources: Vec<OutputResourceHash>,
    decoder: DecoderEvidence,
    decoded: ChildDecodedTimeline,
    manifest: Vec<u8>,
    source_evidence: Value,
    encoder_argv_sha256: String,
}
impl ValidatedChildOutput {
    pub fn identity(&self) -> &OutputIdentity {
        self.owner.identity()
    }
    pub fn source_identity(&self) -> &CaptureOwnerIdentity {
        &self.source_identity
    }
    pub fn resources(&self) -> &[OutputResourceHash] {
        &self.resources
    }
    pub fn decoder(&self) -> &DecoderEvidence {
        &self.decoder
    }
    pub fn decoded_timeline(&self) -> &ChildDecodedTimeline {
        &self.decoded
    }

    /// Persistence must repeat this immediately before publication. All resources,
    /// including the last unread segment, are read through the original pinned
    /// read-only inodes, fully rehashed, and fenced after the complete batch.
    pub async fn check(&self) -> Result<()> {
        let actual = snapshot(&self.owner, None).await?;
        ensure!(
            self.resources == hashes(actual.resources()),
            "static_hls_child_output_changed_after_validation"
        );
        self.check_local()
    }
    pub fn check_local(&self) -> Result<()> {
        self.owner.require_successful_encoder_reap()?;
        self.owner.readonly_live()
    }
    pub fn control(&self) -> super::child_output_owner::ChildOutputControl {
        self.owner.control()
    }
    pub fn require_original_permit(&self, permit: &Arc<dyn OutputPermit>) -> Result<()> {
        self.owner.require_original_permit(permit)
    }
    pub fn manifest(&self) -> &[u8] {
        &self.manifest
    }
    pub fn segment_count(&self) -> usize {
        self.resources.len().saturating_sub(2)
    }
    pub fn evidence_json(&self) -> Result<Value> {
        Ok(serde_json::json!({
            "version":1, "validation_kind":"complete_owned_child_v1",
            "source_identity":{"capture_id":self.source_identity.capture_id,"owner_id":self.source_identity.owner_id,"relative_key":self.source_identity.relative_key},
            "resources": self.resources.iter().map(|r| serde_json::json!({"name":r.name,"bytes":r.bytes,"sha256":r.sha256})).collect::<Vec<_>>(),
            "source_evidence":self.source_evidence, "encoder_argv_sha256":self.encoder_argv_sha256,
            "encoder_input_scope_reaped":true, "decoder":self.decoder,
            "requested_position_ms":self.decoded.source_position_ms,"source_end_seconds":self.decoded.source_end_seconds,
            "video_frames":self.decoded.video_frames,"video_time_base":self.decoded.video_time_base,"video_end_seconds":self.decoded.video_end_seconds,
            "audio_packets":self.decoded.audio_packets,"audio_decoded_frames":self.decoded.audio_decoded_frames,
            "audio_priming_samples":self.decoded.audio_priming_samples,"audio_tail_padding_samples":self.decoded.audio_tail_padding_samples,
            "audio_raw_end_samples":self.decoded.audio_raw_end_samples,"audio_decoded_end_samples":self.decoded.audio_decoded_end_samples
        }))
    }
    pub async fn begin_publication(&self) -> Result<()> {
        let actual = snapshot(&self.owner, None).await?;
        ensure!(
            self.resources == hashes(actual.resources()),
            "static_hls_child_output_changed_after_validation"
        );
        self.check_local()?;
        self.owner.begin_publication(actual)
    }
    pub async fn confirm_publication(&self, receipt: Arc<dyn PublishedOutputPermit>) -> Result<()> {
        let actual = snapshot(&self.owner, Some(&receipt)).await?;
        ensure!(
            self.resources == hashes(actual.resources()),
            "static_hls_child_output_changed_after_validation"
        );
        self.check_local()?;
        self.owner.confirm_publication(receipt, actual)
    }
    /// Consume the validated witness only after its SAME original owner has
    /// positively accepted the committed persistence receipt. No copy promotes.
    pub fn into_published(self) -> Result<PublishedChildOutput> {
        let receipt = self.owner.published_receipt()?;
        Ok(PublishedChildOutput {
            validated: self,
            receipt,
        })
    }
}

/// One published physical owner. Only consuming a validated witness after a
/// positively acknowledged SAME-permit COMMIT can construct this value. Arc of
/// this object may be held by the registry; metadata cannot reconstruct it.
pub struct PublishedChildOutput {
    validated: ValidatedChildOutput,
    receipt: Arc<dyn PublishedOutputPermit>,
}
impl PublishedChildOutput {
    pub fn identity(&self) -> &OutputIdentity {
        self.validated.identity()
    }
    pub fn source_identity(&self) -> &CaptureOwnerIdentity {
        self.validated.source_identity()
    }
    pub fn resources(&self) -> &[OutputResourceHash] {
        self.validated.resources()
    }
    pub fn control(&self) -> super::child_output_owner::ChildOutputControl {
        self.validated.control()
    }
    pub fn require_same_frozen_input(
        &self,
        input: &super::contracts::input::FrozenInput,
    ) -> Result<()> {
        self.receipt.require_same_frozen_input(input)
    }
    pub async fn check_read(&self) -> Result<()> {
        self.validated.owner.readonly_live()?;
        self.receipt.check_read().await?;
        self.validated.owner.readonly_live()
    }
    pub async fn read(
        &self,
        resource: super::ReadResource,
        method: super::ReadMethod,
        range: Option<super::ReadRange>,
    ) -> Result<ChildOutputReadLease> {
        self.check_read().await?;
        let guard = self.validated.owner.acquire_read_guard()?;
        let index = match resource {
            super::ReadResource::Manifest => 0,
            super::ReadResource::Init => 1,
            super::ReadResource::Segment(index) if index < 5 => index + 2,
            _ => anyhow::bail!("static_hls_child_output_resource_missing"),
        };
        let expected = self
            .validated
            .resources
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_resource_missing"))?;
        let bytes = self
            .validated
            .owner
            .read_after_reap(
                &expected.name,
                child_recipe::MAX_OUTPUT_RESOURCE_BYTES as usize,
            )
            .await?;
        ensure!(
            bytes.len() == expected.bytes && sha(&bytes) == expected.sha256,
            "static_hls_child_output_changed_after_publication"
        );
        self.check_read().await?;
        let total = bytes.len();
        let mut lease = ChildOutputReadLease {
            bytes,
            owner: self.validated.owner.retain_for_validation(),
            receipt: self.receipt.clone(),
            total,
            first: 0,
            next: 0,
            end: total,
            ranged: false,
            head: method == super::ReadMethod::Head,
            etag: format!("\"sha256-{}\"", expected.sha256),
            _guard: guard,
        };
        if method == super::ReadMethod::Get
            && let Some(range) = range
        {
            lease.select_range(range)?;
        }
        lease.check().await?;
        Ok(lease)
    }
}

/// Holds a real original-owner reader guard through HTTP body drop. The entire
/// resource was bounded, rehashed and copied before any range is exposed. Each
/// chunk repeats the current public-read predicate; stop/unknown ends the body.
pub struct ChildOutputReadLease {
    bytes: Vec<u8>,
    owner: ChildOutputOwner,
    receipt: Arc<dyn PublishedOutputPermit>,
    total: usize,
    first: usize,
    next: usize,
    end: usize,
    ranged: bool,
    head: bool,
    etag: String,
    // Last field: all actual buffers are dropped before positive guard release.
    _guard: OutputReaderGuard,
}
impl ChildOutputReadLease {
    pub fn total_bytes(&self) -> usize {
        self.total
    }
    pub fn content_length(&self) -> usize {
        self.end - self.first
    }
    pub fn first_byte(&self) -> usize {
        self.first
    }
    pub fn is_partial(&self) -> bool {
        self.ranged
    }
    pub fn strong_etag(&self) -> &str {
        &self.etag
    }
    pub async fn check(&self) -> Result<()> {
        self.owner.readonly_live()?;
        self.receipt.check_read().await?;
        self.owner.readonly_live()
    }
    pub fn select_range(&mut self, range: super::ReadRange) -> Result<()> {
        self.owner.readonly_live()?;
        ensure!(
            !self.head && self.next == 0 && !self.ranged,
            "static_hls_child_output_range_already_consumed"
        );
        let (first, end) = match range {
            super::ReadRange::From(first) if first < self.total => (first, self.total),
            super::ReadRange::Inclusive { first, last } if first <= last && first < self.total => {
                (first, last.min(self.total - 1) + 1)
            }
            super::ReadRange::Suffix(count) if count > 0 => {
                (self.total.saturating_sub(count), self.total)
            }
            _ => anyhow::bail!("static_hls_range_unsatisfiable"),
        };
        self.first = first;
        self.next = first;
        self.end = end;
        self.ranged = true;
        Ok(())
    }
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>> {
        self.check().await?;
        if self.head || self.next >= self.end {
            return Ok(None);
        }
        let end = (self.next + 65536).min(self.end);
        let chunk = self.bytes[self.next..end].to_vec();
        self.next = end;
        self.owner.readonly_live()?;
        Ok(Some(chunk))
    }
}

/// A borrowed owner permits installation of the original independent owner
/// before any await. The returned witness retains that exact owner internally.
/// No external JSON, client facts, boolean receipt or path is accepted.
#[cfg(target_os = "linux")]
pub async fn validate(
    output: &ChildOutputOwner,
    recipe: &CandidateChildRecipe<'_>,
) -> Result<ValidatedChildOutput> {
    // Validate actual recipe/source association BEFORE draining its input. A
    // different capture with equal JSON/IDs cannot substitute for that owner.
    let source_identity = output.require_candidate_recipe(recipe)?;
    let inventory = output.inspect_after_reap().await?;
    output.require_successful_encoder_reap()?;
    ensure!(
        (3..=7).contains(&inventory.len()),
        "static_hls_child_output_resource_set"
    );
    let actual = snapshot(output, None).await?;
    let resources = actual.resources();
    let expected = hashes(resources);
    let (manifest, init) = (&resources[0].1, &resources[1].1);
    let text = std::str::from_utf8(manifest)
        .map_err(|_| anyhow::anyhow!("static_hls_child_output_manifest_utf8"))?;
    let parsed = playlist(text)?;
    // The source parser's VOD spelling is adapted only in this parser input.
    // The actual EVENT bytes are retained and hashed unmodified for publication.
    let structural_text = text.replace("#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-PLAYLIST-TYPE:VOD");
    let mut structure = timeline::Structure::new(&structural_text, init)
        .map_err(|e| anyhow::anyhow!("static_hls_child_output_init_unsupported:{e}"))?;
    ensure!(
        structure.tracks.len() == 2,
        "static_hls_child_output_exact_tracks"
    );
    let video = structure
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Video)
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_video_required"))?;
    let audio = structure
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Audio)
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_audio_required"))?;
    ensure!(
        video.width == Some(1280)
            && video.height == Some(720)
            && video.media_time == 0
            && video.scale % VIDEO_FPS == 0
            && audio.channels == Some(2)
            && audio.scale == AUDIO_SCALE
            && matches!(audio.media_time, 0 | 1024),
        "static_hls_child_output_recipe_configuration"
    );
    let mut samples: BTreeMap<u32, Vec<Sample>> = structure
        .tracks
        .iter()
        .map(|t| (t.id, Vec::new()))
        .collect();
    for (index, (_, bytes)) in resources.iter().skip(2).enumerate() {
        structure
            .ingest_fragment(bytes, index)
            .map_err(|e| anyhow::anyhow!("static_hls_child_output_fragment_unsupported:{e}"))?;
        collect_samples(bytes, &structure.tracks, &mut samples)?;
    }
    structure.byte_identity()?; // Positive complete-fragment closure, not a timeline grant.
    let (probe, decoder) = output
        .validation_work(Box::pin(decode(output, &expected[0].sha256)))
        .await?;
    let decoded = inspect(&probe, &structure.tracks, &samples, &parsed, recipe)?;
    // Complete hashes are repeated after decoding; a same-size mutation is a
    // refusal. A successful decoder never replaces an unchanged-file check.
    let final_resources = snapshot(output, None).await?;
    ensure!(
        hashes(final_resources.resources()) == expected,
        "static_hls_child_output_changed_during_validation"
    );
    output.require_candidate_recipe(recipe)?;
    output.readonly_live()?;
    Ok(ValidatedChildOutput {
        owner: output.retain_for_validation(),
        source_identity,
        resources: expected,
        decoder,
        decoded,
        manifest: manifest.clone(),
        source_evidence: serde_json::to_value(recipe.source_evidence()?)?,
        encoder_argv_sha256: output.encoder_argv_sha256()?,
    })
}
#[cfg(not(target_os = "linux"))]
pub async fn validate(
    _: &ChildOutputOwner,
    _: &CandidateChildRecipe<'_>,
) -> Result<ValidatedChildOutput> {
    anyhow::bail!("static_hls_linux_required")
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hashes(resources: &[(String, Vec<u8>)]) -> Vec<OutputResourceHash> {
    resources
        .iter()
        .map(|(name, bytes)| OutputResourceHash {
            name: name.clone(),
            bytes: bytes.len(),
            sha256: sha(bytes),
        })
        .collect()
}
async fn snapshot(
    owner: &ChildOutputOwner,
    publication: Option<&Arc<dyn PublishedOutputPermit>>,
) -> Result<ChildOutputSnapshot> {
    let actual = owner.snapshot_after_reap(publication).await?;
    complete_snapshot_resources(actual.resources())?;
    owner.readonly_live()?;
    Ok(actual)
}

fn complete_snapshot_resources(resources: &[(String, Vec<u8>)]) -> Result<()> {
    let manifest = resources
        .first()
        .filter(|(name, _)| name == "index.m3u8")
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_complete_closed_names"))?;
    let text = std::str::from_utf8(&manifest.1)
        .map_err(|_| anyhow::anyhow!("static_hls_child_output_manifest_utf8"))?;
    let parsed = playlist(text)?;
    let names: Vec<_> = ["index.m3u8".to_owned(), "init.mp4".to_owned()]
        .into_iter()
        .chain(parsed.segments.iter().map(|s| s.uri.clone()))
        .collect();
    ensure!(
        resources.len() == names.len()
            && resources
                .iter()
                .zip(names)
                .all(|((name, _), expected)| *name == expected),
        "static_hls_child_output_complete_closed_names"
    );
    Ok(())
}

fn playlist(text: &str) -> Result<timeline::Playlist> {
    ensure!(
        text.len() <= super::MANIFEST_BYTES,
        "static_hls_child_output_manifest_bound"
    );
    // Finite EVENT is the actual recipe. No encryption, external URI, unknown
    // tag, discontinuity, byte range, extension or repeated resource is allowed.
    let normalized = text.replace("#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-PLAYLIST-TYPE:VOD");
    let parsed = timeline::parse_playlist(&normalized)
        .map_err(|e| anyhow::anyhow!("static_hls_child_output_manifest_unsupported:{e}"))?;
    ensure!(
        parsed.map == "init.mp4"
            && parsed.sequence == 0
            && (1..=5).contains(&parsed.segments.len())
            && parsed.seconds <= child_recipe::MAX_OUTPUT_SECONDS as f64
            && parsed
                .segments
                .iter()
                .enumerate()
                .all(|(i, s)| s.uri == format!("s{i:03}.m4s"))
            && parsed
                .segments
                .iter()
                .enumerate()
                .all(|(i, s)| s.duration <= 4.0 + 1.0 / f64::from(VIDEO_FPS)
                    && (i + 1 == parsed.segments.len() || (s.duration - 4.0).abs() < 0.0000011)),
        "static_hls_child_output_manifest_recipe"
    );
    Ok(parsed)
}

#[derive(Clone, Copy, Debug)]
struct Sample {
    pts: i64,
    duration: u32,
    size: u32,
    segment: usize,
}
// Full structural semantics, track sets and exact non-overlapping mdat ranges
// are checked by Structure::ingest_fragment above. This checked reader retains
// the exact actual sample clocks/sizes for comparison with every decoded record.
fn boxes(bytes: &[u8]) -> Result<Vec<(&[u8], &[u8])>> {
    let mut result = Vec::new();
    let mut offset = 0;
    while offset < bytes.len() {
        ensure!(
            bytes.len() - offset >= 8,
            "static_hls_child_output_box_truncated"
        );
        let size = word(bytes, offset)? as usize;
        ensure!(
            size >= 8 && size <= bytes.len() - offset && result.len() < 128,
            "static_hls_child_output_box_bound"
        );
        result.push((
            &bytes[offset + 4..offset + 8],
            &bytes[offset + 8..offset + size],
        ));
        offset += size;
    }
    Ok(result)
}
fn one<'a>(boxes: &[(&[u8], &'a [u8])], name: &[u8]) -> Result<&'a [u8]> {
    let mut selected = boxes.iter().filter(|(tag, _)| *tag == name);
    let value = selected
        .next()
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_box_missing"))?;
    ensure!(
        selected.next().is_none(),
        "static_hls_child_output_box_duplicate"
    );
    Ok(value.1)
}
fn word(bytes: &[u8], at: usize) -> Result<u32> {
    let slice = bytes
        .get(
            at..at
                .checked_add(4)
                .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_box_truncated"))?,
        )
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_box_truncated"))?;
    Ok(u32::from_be_bytes(slice.try_into()?))
}
fn collect_samples(
    bytes: &[u8],
    tracks: &[timeline::Track],
    samples: &mut BTreeMap<u32, Vec<Sample>>,
) -> Result<()> {
    let top = boxes(bytes)?;
    let moof = boxes(one(&top, b"moof")?)?;
    let segment = samples
        .values()
        .next()
        .and_then(|v| v.last())
        .map_or(0, |s| s.segment + 1);
    for (_, data) in moof.iter().filter(|(tag, _)| *tag == b"traf") {
        let children = boxes(data)?;
        let tfhd = one(&children, b"tfhd")?;
        let tfdt = one(&children, b"tfdt")?;
        let trun = one(&children, b"trun")?;
        let id = word(tfhd, 4)?;
        let track = tracks
            .iter()
            .find(|t| t.id == id)
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_unknown_track"))?;
        let mut clock = if word(tfdt, 0)? == 0 {
            u64::from(word(tfdt, 4)?)
        } else {
            (u64::from(word(tfdt, 4)?) << 32) | u64::from(word(tfdt, 8)?)
        };
        let flags = word(trun, 0)?;
        let count = word(trun, 4)? as usize;
        ensure!(
            count <= MAX_RECORDS / 2,
            "static_hls_child_output_sample_count"
        );
        let mut at = 12 + usize::from(flags & 4 != 0) * 4;
        let selected = samples
            .get_mut(&id)
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_unknown_track"))?;
        ensure!(
            count <= (MAX_RECORDS / 2).saturating_sub(selected.len()),
            "static_hls_child_output_sample_count"
        );
        for _ in 0..count {
            let duration = if flags & 0x100 != 0 {
                let n = word(trun, at)?;
                at += 4;
                n
            } else {
                word(tfhd, 8)?
            };
            let size = if flags & 0x200 != 0 {
                let n = word(trun, at)?;
                at += 4;
                n
            } else {
                word(tfhd, 12)?
            };
            ensure!(
                clock <= i64::MAX as u64,
                "static_hls_child_output_clock_bound"
            );
            selected.push(Sample {
                pts: clock as i64 - i64::from(track.media_time),
                duration,
                size,
                segment,
            });
            clock = clock
                .checked_add(u64::from(duration))
                .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_clock_bound"))?;
        }
        ensure!(at == trun.len(), "static_hls_child_output_sample_table");
    }
    Ok(())
}

fn number(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}
fn equals(value: &Value, expected: i64) -> bool {
    number(value) == Some(expected)
}
fn extradata_hash(stream: &Value) -> Result<String> {
    let dump = stream["extradata"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_decoder_config_missing"))?;
    ensure!(
        dump.len() <= 65536 * 8,
        "static_hls_child_output_decoder_config_bound"
    );
    let mut bytes = Vec::new();
    for line in dump.lines().filter(|line| !line.trim().is_empty()) {
        let (offset, data) = line
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_decoder_config_dump"))?;
        ensure!(
            offset.len() == 8
                && offset.bytes().all(|b| b.is_ascii_hexdigit())
                && usize::from_str_radix(offset, 16).ok() == Some(bytes.len()),
            "static_hls_child_output_decoder_config_dump"
        );
        let hex = data.trim_start().split("  ").next().unwrap_or("");
        for group in hex.split_whitespace() {
            ensure!(
                group.len() % 2 == 0
                    && group.len() <= 4
                    && group.bytes().all(|b| b.is_ascii_hexdigit()),
                "static_hls_child_output_decoder_config_dump"
            );
            for at in (0..group.len()).step_by(2) {
                bytes.push(u8::from_str_radix(&group[at..at + 2], 16)?);
            }
        }
    }
    ensure!(
        equals(&stream["extradata_size"], bytes.len() as i64) && !bytes.is_empty(),
        "static_hls_child_output_decoder_config_size"
    );
    Ok(sha(&bytes))
}

fn inspect(
    probe: &Value,
    tracks: &[timeline::Track],
    samples: &BTreeMap<u32, Vec<Sample>>,
    playlist: &timeline::Playlist,
    recipe: &CandidateChildRecipe<'_>,
) -> Result<ChildDecodedTimeline> {
    let streams = probe["streams"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_decoder_streams"))?;
    let records = probe["packets_and_frames"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_decoder_records"))?;
    ensure!(
        streams.len() == 2 && !records.is_empty() && records.len() <= MAX_RECORDS,
        "static_hls_child_output_decoder_bound"
    );
    // Reuse measured protected-track/SDR/H.264/AAC-LC source qualification.
    let audio_index = streams
        .iter()
        .find(|s| s["codec_type"] == "audio")
        .and_then(|s| number(&s["index"]))
        .filter(|i| *i >= 0 && *i <= u32::MAX as i64)
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_decoder_audio"))?
        as u32;
    super::scanner::qualify_source(probe, Some(audio_index))
        .map_err(|e| anyhow::anyhow!("static_hls_child_output_decoder_configuration:{e}"))?;
    let mut indices = BTreeSet::new();
    let mut video_result = None;
    let mut audio_result = None;
    for track in tracks {
        let kind = if track.kind == TrackKind::Video {
            "video"
        } else {
            "audio"
        };
        let matching: Vec<_> = streams.iter().filter(|s| s["codec_type"] == kind).collect();
        ensure!(matching.len() == 1, "static_hls_child_output_exact_tracks");
        let stream = matching[0];
        let index = number(&stream["index"])
            .filter(|i| *i >= 0 && *i <= u32::MAX as i64)
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_decoder_track_identity"))?;
        ensure!(
            indices.insert(index)
                && stream["time_base"] == format!("1/{}", track.scale)
                && extradata_hash(stream)? == track.codec_config_sha256,
            "static_hls_child_output_decoder_track_identity"
        );
        if track.kind == TrackKind::Video {
            ensure!(
                stream["codec_name"] == "h264"
                    && stream["codec_tag_string"] == "avc1"
                    && stream["profile"] == "High"
                    && equals(&stream["level"], 31)
                    && stream["pix_fmt"] == "yuv420p"
                    && equals(&stream["has_b_frames"], 0)
                    && equals(&stream["width"], 1280)
                    && equals(&stream["height"], 720)
                    && stream["r_frame_rate"] == "30/1",
                "static_hls_child_output_video_configuration"
            );
        } else {
            ensure!(
                stream["codec_name"] == "aac"
                    && stream["profile"] == "LC"
                    && equals(&stream["sample_rate"], 48000)
                    && equals(&stream["channels"], 2)
                    && stream["channel_layout"] == "stereo",
                "static_hls_child_output_audio_configuration"
            );
        }
        let selected: Vec<_> = records
            .iter()
            .filter(|r| equals(&r["stream_index"], index))
            .collect();
        ensure!(
            selected
                .iter()
                .all(|r| matches!(r["type"].as_str(), Some("packet" | "frame"))),
            "static_hls_child_output_unknown_record"
        );
        let packets: Vec<_> = selected
            .iter()
            .copied()
            .filter(|r| r["type"] == "packet")
            .collect();
        let frames: Vec<_> = selected
            .iter()
            .copied()
            .filter(|r| r["type"] == "frame")
            .collect();
        let raw = samples
            .get(&track.id)
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_sample_missing"))?;
        ensure!(
            !raw.is_empty() && packets.len() == raw.len(),
            "static_hls_child_output_full_packet_decode_required"
        );
        let priming = if track.kind == TrackKind::Audio {
            track.media_time as u32
        } else {
            0
        };
        let mut decoded_preroll = false;
        for (i, (sample, packet)) in raw.iter().zip(&packets).enumerate() {
            ensure!(
                equals(&packet["pts"], sample.pts)
                    && equals(&packet["dts"], sample.pts)
                    && equals(&packet["size"], i64::from(sample.size)),
                "static_hls_child_output_packet_sample_mismatch"
            );
            if i > 0 {
                ensure!(
                    sample.pts == raw[i - 1].pts + i64::from(raw[i - 1].duration),
                    "static_hls_child_output_timestamp_gap_or_overlap"
                );
            }
            let sides = match packet.get("side_data_list") {
                None | Some(Value::Null) => &[][..],
                Some(v) => v
                    .as_array()
                    .map(Vec::as_slice)
                    .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_packet_sides"))?,
            };
            if i == 0 && priming == 1024 {
                decoded_preroll = sides.is_empty();
                ensure!(
                    sample.pts == -1024
                        && sample.duration == 1024
                        && (packet["duration"].is_null() || equals(&packet["duration"], 1024))
                        && (decoded_preroll
                            || (sides.len() == 1
                                && sides[0]["side_data_type"] == "Skip Samples"
                                && equals(&sides[0]["skip_samples"], 1024)
                                && equals(&sides[0]["discard_padding"], 0))),
                    "static_hls_child_output_aac_priming_unproven"
                );
            } else {
                ensure!(
                    sides.is_empty()
                        && equals(
                            &packet["duration"],
                            if track.kind == TrackKind::Audio {
                                1024
                            } else {
                                i64::from(sample.duration)
                            }
                        ),
                    "static_hls_child_output_unknown_packet_priming"
                );
            }
            if track.kind == TrackKind::Video {
                ensure!(
                    sample.duration == track.scale / VIDEO_FPS,
                    "static_hls_child_output_video_cfr"
                );
                if i == 0 || sample.segment != raw[i - 1].segment {
                    ensure!(
                        packet["flags"]
                            .as_str()
                            .is_some_and(|f| f.contains('K') && !f.contains('C')),
                        "static_hls_child_output_segment_keyframe_required"
                    );
                }
            } else {
                ensure!(
                    sample.duration == 1024
                        || (i + 1 == raw.len() && (1..1024).contains(&sample.duration)),
                    "static_hls_child_output_aac_duration_unproven"
                );
            }
        }
        let displayed = if priming > 0 {
            &raw[1..]
        } else {
            raw.as_slice()
        };
        let decoded = if decoded_preroll {
            raw.as_slice()
        } else {
            displayed
        };
        ensure!(
            !displayed.is_empty() && displayed[0].pts == 0 && frames.len() == decoded.len(),
            "static_hls_child_output_decoded_origin_or_count"
        );
        for (i, (frame, sample)) in frames.iter().zip(decoded).enumerate() {
            ensure!(
                frame["media_type"] == kind
                    && equals(&frame["pts"], sample.pts)
                    && equals(&frame["best_effort_timestamp"], sample.pts),
                "static_hls_child_output_decoded_clock"
            );
            let duration = frame
                .get("duration")
                .filter(|v| !v.is_null())
                .unwrap_or(&frame["pkt_duration"]);
            ensure!(
                equals(
                    duration,
                    if track.kind == TrackKind::Audio {
                        1024
                    } else {
                        i64::from(sample.duration)
                    }
                ) || (decoded_preroll && i == 0 && duration.is_null()),
                "static_hls_child_output_decoded_duration"
            );
            if track.kind == TrackKind::Audio {
                ensure!(
                    equals(&frame["nb_samples"], 1024)
                        && equals(&frame["channels"], 2)
                        && frame["channel_layout"] == "stereo",
                    "static_hls_child_output_decoded_samples_or_stereo"
                );
            } else {
                ensure!(
                    equals(&frame["width"], 1280) && equals(&frame["height"], 720),
                    "static_hls_child_output_decoded_geometry"
                );
            }
        }
        let last = displayed
            .last()
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_no_frames"))?;
        if track.kind == TrackKind::Video {
            video_result = Some((
                frames.len(),
                track.scale,
                last.pts + i64::from(last.duration),
            ));
        } else {
            audio_result = Some((
                packets.len(),
                frames.len(),
                priming,
                1024 - last.duration,
                last.pts + i64::from(last.duration),
                last.pts + 1024,
            ));
        }
    }
    ensure!(
        records
            .iter()
            .all(|r| number(&r["stream_index"]).is_some_and(|i| indices.contains(&i))),
        "static_hls_child_output_extra_decoder_track"
    );
    let (video_frames, video_scale, video_end) =
        video_result.ok_or_else(|| anyhow::anyhow!("static_hls_child_output_video_required"))?;
    let (audio_packets, audio_decoded_frames, priming, padding, audio_raw_end, audio_decoded_end) =
        audio_result.ok_or_else(|| anyhow::anyhow!("static_hls_child_output_audio_required"))?;
    let video_end_seconds = video_end as f64 / f64::from(video_scale);
    let requested_seconds = recipe.source_end_seconds() - recipe.position_ms() / 1000.0;
    ensure!(
        requested_seconds > 0.0
            && requested_seconds <= child_recipe::MAX_OUTPUT_SECONDS as f64
            && (video_end_seconds - playlist.seconds).abs() <= 0.0000011
            && (video_end_seconds - requested_seconds).abs()
                <= 1.0 / f64::from(VIDEO_FPS) + 0.00001
            && (audio_raw_end as f64 - requested_seconds * f64::from(AUDIO_SCALE)).abs()
                <= 1.000001
            && audio_decoded_end >= audio_raw_end
            && audio_decoded_end - audio_raw_end < 1024,
        "static_hls_child_output_requested_trim_mapping"
    );
    Ok(ChildDecodedTimeline {
        video_frames,
        video_time_base: format!("1/{video_scale}"),
        video_end_seconds,
        audio_packets,
        audio_decoded_frames,
        audio_priming_samples: priming,
        audio_tail_padding_samples: padding,
        audio_raw_end_samples: audio_raw_end,
        audio_decoded_end_samples: audio_decoded_end,
        source_position_ms: recipe.position_ms(),
        source_end_seconds: recipe.source_end_seconds(),
    })
}

#[cfg(target_os = "linux")]
async fn decode(
    output: &ChildOutputOwner,
    manifest_sha256: &str,
) -> Result<(Value, DecoderEvidence)> {
    use std::os::fd::AsRawFd;
    let executable = std::fs::canonicalize("/usr/bin/ffprobe")
        .map_err(|_| anyhow::anyhow!("static_hls_child_output_decoder_unavailable"))?;
    let path = executable.clone();
    let executable_sha256 = crate::child_process::blocking(move || {
        use std::io::Read;
        let file = std::fs::File::open(path)?;
        let meta = file.metadata()?;
        ensure!(
            meta.is_file() && meta.len() <= 64 * 1024 * 1024,
            "static_hls_child_output_decoder_executable_bound"
        );
        let mut bytes = Vec::new();
        file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 == meta.len(),
            "static_hls_child_output_decoder_executable_changed"
        );
        Ok::<_, anyhow::Error>(sha(&bytes))
    })
    .await??;
    let mut argv_sha256 = String::new();
    let mut child=output.spawn_readonly_validator(|fd| {
        let args=vec!["-v".to_owned(),"error".into(),"-threads".into(),"1".into(),"-max_alloc".into(),"134217728".into(),
            "-protocol_whitelist".into(),"file".into(),"-format_whitelist".into(),"hls,mov".into(),"-err_detect".into(),"explode".into(),
            "-show_packets".into(),"-show_frames".into(),"-show_streams".into(),"-show_format".into(),"-show_data".into(),"-show_entries".into(),
            "stream:format:frame=stream_index,media_type,pts,best_effort_timestamp,duration,pkt_duration,nb_samples,channels,channel_layout,width,height:packet=stream_index,pts,dts,duration,size,flags:packet_side_data=side_data_type,skip_samples,discard_padding".into(),
            "-of".into(),"json".into(),format!("/proc/self/fd/{}/index.m3u8",fd.as_raw_fd())];
        argv_sha256=sha(&serde_json::to_vec(&args)?);
        let mut command=tokio::process::Command::new(&executable);
        crate::input_policy::clean_environment(&mut command);
        command.args(args).env("OPENBLAS_NUM_THREADS","1").env("OMP_NUM_THREADS","1")
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        Ok(command)
    }).await?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_decoder_pipe"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_decoder_pipe"))?;
    let completed = tokio::try_join!(
        pipe(stdout, PROBE_BYTES),
        pipe(stderr, child_recipe::MAX_DIAGNOSTIC_PIPE_BYTES),
        async { child.wait().await.map_err(anyhow::Error::from) }
    );
    let (out, err, status) = match completed {
        Ok(value) => value,
        Err(_) => {
            child
                .kill()
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_child_output_validator_drain_unknown"))?;
            anyhow::bail!("static_hls_child_output_decoder_bound_or_process_failed");
        }
    };
    ensure!(
        status.success() && status.code() == Some(0) && err.is_empty(),
        "static_hls_child_output_decoder_failed"
    );
    let probe = serde_json::from_slice(&out)
        .map_err(|_| anyhow::anyhow!("static_hls_child_output_decoder_json"))?;
    Ok((
        probe,
        DecoderEvidence {
            executable_sha256,
            argv_sha256,
            manifest_sha256: manifest_sha256.to_owned(),
            stdout_sha256: sha(&out),
            stdout_bytes: out.len(),
            stderr_bytes: err.len(),
            exit_code: 0,
            process_tree_reaped: true,
            address_space_bytes: child_recipe::MAX_ADDRESS_SPACE_BYTES,
        },
    ))
}
async fn pipe(mut pipe: impl tokio::io::AsyncRead + Unpin, maximum: usize) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer = vec![0u8; 65536];
    loop {
        let n = pipe.read(&mut buffer).await?;
        if n == 0 {
            return Ok(out);
        };
        ensure!(
            n <= maximum.saturating_sub(out.len()),
            "static_hls_child_output_decoder_pipe_bound"
        );
        out.extend_from_slice(&buffer[..n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authority_values_cannot_be_cloned_or_serialized() {
        trait AmbiguousClone<A> {
            fn marker() {}
        }
        impl<T: ?Sized> AmbiguousClone<()> for T {}
        impl<T: Clone> AmbiguousClone<u8> for T {}
        trait AmbiguousSerialize<A> {
            fn marker() {}
        }
        impl<T: ?Sized> AmbiguousSerialize<()> for T {}
        impl<T: serde::Serialize> AmbiguousSerialize<u8> for T {}
        let _ = <ValidatedChildOutput as AmbiguousClone<_>>::marker;
        let _ = <ValidatedChildOutput as AmbiguousSerialize<_>>::marker;
        let _ = <PublishedChildOutput as AmbiguousClone<_>>::marker;
        let _ = <PublishedChildOutput as AmbiguousSerialize<_>>::marker;
        let _ = <ChildOutputReadLease as AmbiguousClone<_>>::marker;
        let _ = <ChildOutputReadLease as AmbiguousSerialize<_>>::marker;
    }

    fn manifest() -> String {
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.000000,\ns000.m4s\n#EXTINF:1.000000,\ns001.m4s\n#EXT-X-ENDLIST\n".to_owned()
    }
    #[test]
    fn manifest_is_complete_closed_and_finite() {
        assert_eq!(playlist(&manifest()).unwrap().segments.len(), 2);
        for (from, to) in [
            ("s001.m4s", "https://x.invalid/a"),
            ("s001.m4s", "s004.m4s"),
            ("s001.m4s", "s001.m4s?x=1"),
            ("init.mp4", "../init.mp4"),
            ("#EXT-X-ENDLIST\n", ""),
            ("MEDIA-SEQUENCE:0", "MEDIA-SEQUENCE:1"),
            ("#EXT-X-ENDLIST", "#EXT-X-KEY:METHOD=NONE\n#EXT-X-ENDLIST"),
            ("4.000000", "3.999998"),
        ] {
            assert!(
                playlist(&manifest().replace(from, to)).is_err(),
                "{from}->{to}"
            );
        }
    }
    #[test]
    fn batched_snapshot_is_exact_manifest_inventory_and_hashes_the_last_byte() {
        let resources = vec![
            ("index.m3u8".to_owned(), manifest().into_bytes()),
            ("init.mp4".to_owned(), vec![1; 32]),
            ("s000.m4s".to_owned(), vec![2; 65537]),
            ("s001.m4s".to_owned(), vec![3; 65537]),
        ];
        complete_snapshot_resources(&resources).unwrap();
        let expected = hashes(&resources);
        let mut changed = resources.clone();
        *changed.last_mut().unwrap().1.last_mut().unwrap() = 4;
        assert_ne!(
            hashes(&changed),
            expected,
            "the final unread segment's final byte is hashed"
        );
        for missing in 0..resources.len() {
            let mut changed = resources.clone();
            changed.remove(missing);
            assert!(complete_snapshot_resources(&changed).is_err());
        }
        let mut extra = resources.clone();
        extra.push(("s002.m4s".to_owned(), vec![5]));
        assert!(
            complete_snapshot_resources(&extra).is_err(),
            "unlisted segment cannot join the snapshot"
        );
        let mut reordered = resources.clone();
        reordered.swap(2, 3);
        assert!(complete_snapshot_resources(&reordered).is_err());
    }

    #[test]
    fn raw_clock_reader_fails_without_panics() {
        for bytes in [vec![], vec![0; 7], vec![0; 8], vec![255; 20]] {
            assert!(boxes(&bytes).is_err() || bytes.is_empty());
        }
        assert!(word(&[], usize::MAX).is_err());
    }
    #[test]
    fn ascii_dump_cannot_supply_codec_proof() {
        assert!(
            extradata_hash(
                &serde_json::json!({"extradata":"00000000: 12zz  hello","extradata_size":2})
            )
            .is_err()
        );
        assert_eq!(
            extradata_hash(
                &serde_json::json!({"extradata":"00000000: 1190  text","extradata_size":2})
            )
            .unwrap(),
            sha(&[0x11, 0x90])
        );
    }
}
