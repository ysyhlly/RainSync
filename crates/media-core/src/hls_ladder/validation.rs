use super::{
    AttemptIdentity, FRAME_RATE, LadderRecipe, MAX_FRAGMENT_BYTES, MAX_INIT_BYTES, MAX_RENDITIONS,
    MasterPlaylist, MasterVariant, MediaPlaylist, RenditionId, parse_media_playlist,
};
use crate::static_hls::timeline::{Track, TrackKind};
use anyhow::{Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
#[derive(Debug, Clone)]
struct Sample {
    pts: i64,
    duration: u32,
    size: u32,
}
#[derive(Debug, Clone)]
struct TrackSamples {
    track: Track,
    samples: Vec<Sample>,
}
/// Content facts only. Never an owner, immutable-file or successful-reap proof.
#[derive(Debug)]
pub struct FirstFragmentFacts {
    pub index: usize,
    pub video_start_us: u64,
    pub init_sha256: String,
    pub fragment_sha256: String,
    pub fragment_bytes: usize,
    pub video_duration_us: u64,
    pub video_frames: usize,
    pub audio_first_pts: Option<i64>,
    pub audio_end_pts: Option<i64>,
    tracks: Vec<TrackSamples>,
}
struct BoxRef<'a> {
    kind: &'a [u8],
    data: &'a [u8],
    start: usize,
    end: usize,
}
fn boxes(data: &[u8]) -> Result<Vec<BoxRef<'_>>> {
    let (mut output, mut offset) = (Vec::new(), 0);
    while offset < data.len() {
        ensure!(
            data.len() - offset >= 8 && output.len() < 256,
            "hls_ladder_mp4_box_bound"
        );
        let size = word(data, offset)? as usize;
        ensure!(
            size >= 8 && size <= data.len() - offset,
            "hls_ladder_mp4_box_bound"
        );
        output.push(BoxRef {
            kind: &data[offset + 4..offset + 8],
            data: &data[offset + 8..offset + size],
            start: offset,
            end: offset + size,
        });
        offset += size;
    }
    Ok(output)
}
fn one<'a>(boxes: &[BoxRef<'a>], kind: &[u8]) -> Result<&'a [u8]> {
    let mut found = boxes.iter().filter(|b| b.kind == kind);
    let first = found
        .next()
        .ok_or_else(|| anyhow::anyhow!("hls_ladder_mp4_box_missing"))?;
    ensure!(found.next().is_none(), "hls_ladder_mp4_box_duplicate");
    Ok(first.data)
}
fn allowed(boxes: &[BoxRef<'_>], kinds: &[&[u8]]) -> Result<()> {
    ensure!(
        boxes.iter().all(|b| kinds.contains(&b.kind)),
        "hls_ladder_mp4_box_unsupported"
    );
    Ok(())
}
fn word(data: &[u8], offset: usize) -> Result<u32> {
    let slice = data
        .get(offset..offset.saturating_add(4))
        .ok_or_else(|| anyhow::anyhow!("hls_ladder_mp4_truncated"))?;
    Ok(u32::from_be_bytes(slice.try_into()?))
}
// Ordinary clear SDR outputs can carry a benign MP4 colr entry. The static
// capture prerequisite intentionally rejects that extension, so do not widen
// its proof grammar. Validate and remove only this known inert color metadata
// in a temporary parsing view; resource and codec hashes retain actual bytes.
fn inspectable_sdr_init(data: &[u8]) -> Result<Vec<u8>> {
    fn rebuild(data: &[u8], parent: &[u8]) -> Result<Vec<u8>> {
        let prefix = if parent == b"stsd" {
            8
        } else if parent == b"avc1" {
            78
        } else if parent == b"mp4a" {
            28
        } else {
            0
        };
        ensure!(data.len() >= prefix, "hls_ladder_init_truncated");
        let mut output = data[..prefix].to_vec();
        for boxed in boxes(&data[prefix..])? {
            if parent == b"avc1" && boxed.kind == b"colr" {
                let color = boxed.data;
                ensure!(
                    (color.len() == 11 && &color[..4] == b"nclx" && color[10] & 0x7f == 0)
                        || (color.len() == 10 && &color[..4] == b"nclc"),
                    "hls_ladder_sdr_color_entry_unsupported"
                );
                ensure!(
                    [4usize, 6, 8]
                        .iter()
                        .all(|offset| color[*offset] == 0 && matches!(color[*offset + 1], 1 | 2)),
                    "hls_ladder_sdr_color_entry_unsupported"
                );
                continue;
            }
            let child = if matches!(
                boxed.kind,
                b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"stsd" | b"avc1" | b"mp4a"
            ) {
                rebuild(boxed.data, boxed.kind)?
            } else {
                boxed.data.to_vec()
            };
            output.extend(((child.len() + 8) as u32).to_be_bytes());
            output.extend(boxed.kind);
            output.extend(child);
        }
        Ok(output)
    }
    rebuild(data, b"root")
}
fn integer(value: &Value) -> Result<i64> {
    value
        .as_i64()
        .ok_or_else(|| anyhow::anyhow!("hls_ladder_probe_integer"))
}
fn avc_sample(data: &[u8], first: bool) -> Result<()> {
    let (mut offset, mut nals, mut idr, mut ordinary) = (0, 0, false, false);
    while offset < data.len() {
        let size = word(data, offset)? as usize;
        offset += 4;
        ensure!(
            size > 0 && size <= data.len() - offset && nals < 512,
            "hls_ladder_avc_nal_bound"
        );
        let header = data[offset];
        ensure!(header & 0x80 == 0, "hls_ladder_avc_nal_invalid");
        match header & 31 {
            5 => idr = true,
            1 => ordinary = true,
            6 | 9 | 12 => {}
            // AVC1 parameter sets live in the pinned init. In-band replacement
            // and unknown slice/extension semantics require another version.
            _ => anyhow::bail!("hls_ladder_avc_nal_unsupported"),
        }
        offset += size;
        nals += 1;
    }
    ensure!(
        if first {
            idr && !ordinary
        } else {
            ordinary && !idr
        },
        "hls_ladder_idr_alignment"
    );
    Ok(())
}
/// Inspect the actual first fMP4 resource, including non-overlapping sample
/// ranges, closed AVC IDR, zero video origin, CFR and AAC clocks. Decode/reap
/// and immutable custody remain mandatory caller responsibilities.
pub fn validate_first_fragment(
    recipe: &LadderRecipe,
    id: RenditionId,
    init: &[u8],
    fragment: &[u8],
    duration_us: u64,
) -> Result<FirstFragmentFacts> {
    validate_fragment(recipe, id, init, fragment, 0, duration_us)
}

/// Content validation for one complete immutable suffix fragment.
pub fn validate_fragment(
    recipe: &LadderRecipe,
    id: RenditionId,
    init: &[u8],
    fragment: &[u8],
    index: usize,
    duration_us: u64,
) -> Result<FirstFragmentFacts> {
    let r = recipe.rendition(id)?;
    ensure!(index < super::MAX_SEGMENTS, "hls_ladder_fragment_index");
    ensure!(
        !init.is_empty()
            && init.len() <= MAX_INIT_BYTES
            && !fragment.is_empty()
            && fragment.len() <= MAX_FRAGMENT_BYTES
            && duration_us > 0
            && duration_us <= 4_000_000,
        "hls_ladder_resource_bound"
    );
    ensure!(
        fragment.len() as u64 * 8 * 1_000_000 <= u64::from(r.bandwidth) * duration_us,
        "hls_ladder_segment_bandwidth_exceeded"
    );
    let parsed_init = inspectable_sdr_init(init)?;
    let tracks = crate::static_hls::timeline::inspect_init(&parsed_init)?;
    ensure!(
        tracks.len() == 1 + usize::from(recipe.has_audio()),
        "hls_ladder_init_track_set"
    );
    let video = tracks.iter().find(|t| t.kind == TrackKind::Video).unwrap();
    ensure!(
        video.width == Some(r.width as u16)
            && video.height == Some(r.height as u16)
            && video.media_time == 0,
        "hls_ladder_init_geometry"
    );
    let top = boxes(fragment)?;
    allowed(&top, &[b"styp", b"sidx", b"moof", b"mdat"])?;
    let moof = top
        .iter()
        .find(|b| b.kind == b"moof")
        .ok_or_else(|| anyhow::anyhow!("hls_ladder_mp4_box_missing"))?;
    let mdat = top
        .iter()
        .find(|b| b.kind == b"mdat")
        .ok_or_else(|| anyhow::anyhow!("hls_ladder_mp4_box_missing"))?;
    one(&top, b"moof")?;
    one(&top, b"mdat")?;
    ensure!(mdat.start >= moof.end, "hls_ladder_payload_range");
    let children = boxes(moof.data)?;
    allowed(&children, &[b"mfhd", b"traf"])?;
    let mfhd = one(&children, b"mfhd")?;
    ensure!(
        mfhd.len() == 8 && word(mfhd, 0)? == 0 && word(mfhd, 4)? == index as u32 + 1,
        "hls_ladder_first_fragment_sequence"
    );
    let (mut seen, mut ranges, mut observed) = (BTreeSet::new(), Vec::new(), Vec::new());
    for traf in children.iter().filter(|b| b.kind == b"traf") {
        let children = boxes(traf.data)?;
        allowed(&children, &[b"tfhd", b"tfdt", b"trun"])?;
        let (tfhd, tfdt, trun) = (
            one(&children, b"tfhd")?,
            one(&children, b"tfdt")?,
            one(&children, b"trun")?,
        );
        ensure!(
            tfhd.len() == 20 && word(tfhd, 0)? == 0x20038,
            "hls_ladder_tfhd_unsupported"
        );
        let track_id = word(tfhd, 4)?;
        let track = tracks
            .iter()
            .find(|t| t.id == track_id)
            .ok_or_else(|| anyhow::anyhow!("hls_ladder_fragment_track_set"))?;
        ensure!(seen.insert(track_id), "hls_ladder_fragment_track_set");
        let (default_duration, default_size, default_flags) =
            (word(tfhd, 8)?, word(tfhd, 12)?, word(tfhd, 16)?);
        let base = match (tfdt.len(), word(tfdt, 0)?) {
            (8, 0) => u64::from(word(tfdt, 4)?),
            (12, 0x1000000) => (u64::from(word(tfdt, 4)?) << 32) | u64::from(word(tfdt, 8)?),
            _ => anyhow::bail!("hls_ladder_tfdt_unsupported"),
        };
        ensure!(
            base <= u64::from(track.scale) * 24 * 60 * 60 + 1024
                && (track.kind != TrackKind::Video
                    || base * 1_000_000 == index as u64 * 4_000_000 * u64::from(track.scale))
                && (index != 0 || base == 0),
            "hls_ladder_fragment_origin"
        );
        let (flags, count) = (word(trun, 0)?, word(trun, 4)? as usize);
        ensure!(
            count > 0
                && count <= 256
                && flags & !0x705 == 0
                && flags & 1 != 0
                && !(flags & 4 != 0 && flags & 0x400 != 0),
            "hls_ladder_trun_unsupported"
        );
        let offset = i64::from(word(trun, 8)? as i32) + moof.start as i64;
        ensure!(
            offset >= (mdat.start + 8) as i64 && offset <= mdat.end as i64,
            "hls_ladder_payload_range"
        );
        let mut cursor = offset as usize;
        let mut table = 12;
        let first_flags = if flags & 4 != 0 {
            let value = word(trun, table)?;
            table += 4;
            Some(value)
        } else {
            None
        };
        let (mut clock, mut samples) = (base as i64 - i64::from(track.media_time), Vec::new());
        for i in 0..count {
            let duration = if flags & 0x100 != 0 {
                let n = word(trun, table)?;
                table += 4;
                n
            } else {
                default_duration
            };
            let size = if flags & 0x200 != 0 {
                let n = word(trun, table)?;
                table += 4;
                n
            } else {
                default_size
            };
            let sample_flags = if flags & 0x400 != 0 {
                let n = word(trun, table)?;
                table += 4;
                n
            } else if i == 0 {
                first_flags.unwrap_or(default_flags)
            } else {
                default_flags
            };
            ensure!(
                duration > 0
                    && size > 0
                    && cursor
                        .checked_add(size as usize)
                        .is_some_and(|end| end <= mdat.end),
                "hls_ladder_sample_bound"
            );
            if track.kind == TrackKind::Video {
                ensure!(
                    u64::from(duration) * u64::from(FRAME_RATE) == u64::from(track.scale)
                        && (i != 0 || sample_flags & 0x10000 == 0),
                    "hls_ladder_video_clock"
                );
                avc_sample(&fragment[cursor..cursor + size as usize], i == 0)?;
            } else {
                ensure!(
                    duration <= 1024
                        && (duration == 1024 || i + 1 == count)
                        && track.scale == 48_000
                        && track.channels == Some(2),
                    "hls_ladder_audio_clock"
                );
            }
            samples.push(Sample {
                pts: clock,
                duration,
                size,
            });
            clock += i64::from(duration);
            cursor += size as usize;
        }
        ensure!(table == trun.len(), "hls_ladder_sample_table_length");
        ranges.push((offset as usize, cursor));
        observed.push(TrackSamples {
            track: track.clone(),
            samples,
        });
    }
    ensure!(seen.len() == tracks.len(), "hls_ladder_fragment_track_set");
    ranges.sort_unstable();
    let mut end = mdat.start + 8;
    for (first, next) in ranges {
        ensure!(first == end, "hls_ladder_payload_range");
        end = next;
    }
    ensure!(end == mdat.end, "hls_ladder_payload_range");
    let video = observed
        .iter()
        .find(|t| t.track.kind == TrackKind::Video)
        .unwrap();
    let ticks: u64 = video.samples.iter().map(|s| u64::from(s.duration)).sum();
    ensure!(
        (ticks * 1_000_000).abs_diff(duration_us * u64::from(video.track.scale))
            <= u64::from(video.track.scale),
        "hls_ladder_video_duration"
    );
    let audio = observed.iter().find(|t| t.track.kind == TrackKind::Audio);
    if let Some(audio) = audio {
        let last = audio.samples.last().unwrap();
        let audio_end = last.pts + i64::from(last.duration);
        ensure!(
            (audio_end * 1_000_000 - (index as i64 * 4_000_000 + duration_us as i64) * 48_000)
                .abs()
                <= 1024 * 1_000_000,
            "hls_ladder_audio_video_alignment"
        );
    }
    Ok(FirstFragmentFacts {
        index,
        video_start_us: index as u64 * 4_000_000,
        init_sha256: sha(init),
        fragment_sha256: sha(fragment),
        fragment_bytes: fragment.len(),
        video_duration_us: duration_us,
        video_frames: video.samples.len(),
        audio_first_pts: audio.map(|a| a.samples[0].pts),
        audio_end_pts: audio.map(|a| {
            let s = a.samples.last().unwrap();
            s.pts + i64::from(s.duration)
        }),
        tracks: observed,
    })
}
fn extradata(stream: &Value) -> Result<Vec<u8>> {
    let dump = stream["extradata"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("hls_ladder_probe_extradata"))?;
    ensure!(dump.len() <= 256 * 1024, "hls_ladder_probe_extradata");
    let mut bytes = Vec::new();
    for line in dump.lines().filter(|s| !s.trim().is_empty()) {
        let (_, hex) = line
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("hls_ladder_probe_extradata"))?;
        for word in hex
            .trim_start()
            .split("  ")
            .next()
            .unwrap()
            .split_whitespace()
        {
            ensure!(
                word.len() % 2 == 0 && word.is_ascii(),
                "hls_ladder_probe_extradata"
            );
            for offset in (0..word.len()).step_by(2) {
                bytes.push(u8::from_str_radix(&word[offset..offset + 2], 16)?);
            }
        }
    }
    ensure!(
        !bytes.is_empty() && bytes.len() <= 65536,
        "hls_ladder_probe_extradata"
    );
    Ok(bytes)
}
fn validate_probe(facts: &FirstFragmentFacts, probe: &Value) -> Result<()> {
    let streams = probe["streams"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("hls_ladder_probe_streams"))?;
    let records = probe["packets_and_frames"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("hls_ladder_probe_records"))?;
    ensure!(records.len() <= 2048, "hls_ladder_probe_records");
    let mut indices = BTreeSet::new();
    for observed in &facts.tracks {
        let kind = if observed.track.kind == TrackKind::Video {
            "video"
        } else {
            "audio"
        };
        let stream = streams
            .iter()
            .find(|s| s["codec_type"] == kind)
            .ok_or_else(|| anyhow::anyhow!("hls_ladder_probe_streams"))?;
        let index = integer(&stream["index"])?;
        ensure!(
            index >= 0
                && indices.insert(index)
                && stream["time_base"] == format!("1/{}", observed.track.scale)
                && sha(&extradata(stream)?) == observed.track.codec_config_sha256,
            "hls_ladder_probe_init_mismatch"
        );
        let selected: Vec<_> = records
            .iter()
            .filter(|r| r["stream_index"].as_i64() == Some(index))
            .collect();
        ensure!(
            selected
                .iter()
                .all(|r| matches!(r["type"].as_str(), Some("packet" | "frame"))),
            "hls_ladder_probe_records"
        );
        let packets: Vec<_> = selected.iter().filter(|r| r["type"] == "packet").collect();
        let frames: Vec<_> = selected.iter().filter(|r| r["type"] == "frame").collect();
        ensure!(
            packets.len() == observed.samples.len() && !frames.is_empty(),
            "hls_ladder_probe_incomplete"
        );
        for (packet, sample) in packets.iter().zip(&observed.samples) {
            ensure!(
                integer(&packet["pts"])? == sample.pts
                    && integer(&packet["dts"])? == sample.pts
                    && packet["size"]
                        .as_str()
                        .and_then(|s| s.parse::<u32>().ok())
                        .or_else(|| packet["size"].as_u64().and_then(|n| u32::try_from(n).ok()))
                        == Some(sample.size),
                "hls_ladder_probe_sample_mismatch"
            );
        }
        if observed.track.kind == TrackKind::Video {
            ensure!(
                frames.len() == observed.samples.len(),
                "hls_ladder_probe_incomplete"
            );
            for (i, (frame, sample)) in frames.iter().zip(&observed.samples).enumerate() {
                ensure!(
                    integer(&frame["pts"])? == sample.pts
                        && integer(&frame["best_effort_timestamp"])? == sample.pts
                        && frame["width"] == observed.track.width.unwrap()
                        && frame["height"] == observed.track.height.unwrap()
                        && (i != 0 || frame["key_frame"] == 1),
                    "hls_ladder_probe_frame_mismatch"
                );
            }
        } else {
            let decoded = if frames.len() == observed.samples.len() {
                observed.samples.as_slice()
            } else if observed.samples[0].pts == -1024 && frames.len() + 1 == observed.samples.len()
            {
                &observed.samples[1..]
            } else {
                anyhow::bail!("hls_ladder_probe_audio_incomplete")
            };
            for (frame, sample) in frames.iter().zip(decoded) {
                ensure!(
                    integer(&frame["pts"])? == sample.pts
                        && integer(&frame["best_effort_timestamp"])? == sample.pts
                        && frame["nb_samples"] == 1024,
                    "hls_ladder_probe_audio_frame_mismatch"
                );
            }
        }
    }
    ensure!(
        records.iter().all(|r| r["stream_index"]
            .as_i64()
            .is_some_and(|i| indices.contains(&i))),
        "hls_ladder_probe_extra_track"
    );
    Ok(())
}

/// Not serializable/deserializable. Qualifies content only; cannot grant read
/// access or substitute for original-attempt FileProof and decoder custody.
#[derive(Debug)]
pub struct QualifiedRendition {
    identity: AttemptIdentity,
    recipe_sha256: String,
    variant: MasterVariant,
    playlist: MediaPlaylist,
    playlist_sha256: String,
    fragments: Vec<FirstFragmentFacts>,
}
impl QualifiedRendition {
    pub fn identity(&self) -> &AttemptIdentity {
        &self.identity
    }
    pub fn id(&self) -> RenditionId {
        self.variant.id
    }
    pub fn playlist(&self) -> &MediaPlaylist {
        &self.playlist
    }
    pub fn playlist_sha256(&self) -> &str {
        &self.playlist_sha256
    }
    pub fn first_fragment(&self) -> &FirstFragmentFacts {
        &self.fragments[0]
    }
    pub fn qualified_segment_count(&self) -> usize {
        self.fragments.len()
    }
    /// Accept only append-only manifest progress, preserving every advertised
    /// duration and qualified resource. No ENDLIST retraction or rewrite.
    pub fn refresh_playlist(&mut self, text: &str) -> Result<()> {
        let next = parse_media_playlist(text)?;
        ensure!(
            next.segments.starts_with(&self.playlist.segments)
                && (!self.playlist.complete || next == self.playlist),
            "hls_ladder_playlist_rewrite"
        );
        self.playlist = next;
        self.playlist_sha256 = sha(text.as_bytes());
        Ok(())
    }
    /// Extend only with the next complete immutable resource from this SAME
    /// retained attempt. Caller must recheck inode/hash custody before serving.
    pub fn append_fragment(
        &mut self,
        recipe: &LadderRecipe,
        init: &[u8],
        fragment: &[u8],
    ) -> Result<()> {
        ensure!(
            self.recipe_sha256 == recipe.recipe_sha256(),
            "hls_ladder_mixed_generation"
        );
        let index = self.fragments.len();
        let segment = self
            .playlist
            .segments
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("hls_ladder_segment_not_advertised"))?;
        let facts = validate_fragment(
            recipe,
            self.id(),
            init,
            fragment,
            index,
            segment.duration_us,
        )?;
        let previous = self.fragments.last().unwrap();
        ensure!(
            facts.init_sha256 == previous.init_sha256
                && facts.audio_first_pts == previous.audio_end_pts,
            "hls_ladder_fragment_continuity"
        );
        self.fragments.push(facts);
        Ok(())
    }
}
pub fn qualify_rendition(
    recipe: &LadderRecipe,
    id: RenditionId,
    identity: &AttemptIdentity,
    playlist: &str,
    init: &[u8],
    fragment: &[u8],
    probe: &Value,
) -> Result<QualifiedRendition> {
    identity.validate()?;
    let r = recipe.rendition(id)?;
    let playlist_facts = parse_media_playlist(playlist)?;
    recipe.validate_output_probe(id, probe)?;
    let first = validate_first_fragment(
        recipe,
        id,
        init,
        fragment,
        playlist_facts.first_duration_us(),
    )?;
    validate_probe(&first, probe)?;
    Ok(QualifiedRendition {
        identity: identity.clone(),
        recipe_sha256: recipe.recipe_sha256().into(),
        variant: MasterVariant {
            id,
            bandwidth: r.bandwidth,
            width: r.width,
            height: r.height,
            codecs: r.codecs(),
        },
        playlist: playlist_facts,
        playlist_sha256: sha(playlist.as_bytes()),
        fragments: vec![first],
    })
}
#[derive(Debug)]
pub struct QualifiedLadder {
    identity: AttemptIdentity,
    renditions: Vec<QualifiedRendition>,
    common: MediaPlaylist,
}
impl QualifiedLadder {
    pub fn identity(&self) -> &AttemptIdentity {
        &self.identity
    }
    pub fn renditions(&self) -> &[QualifiedRendition] {
        &self.renditions
    }
    pub fn into_renditions(self) -> Vec<QualifiedRendition> {
        self.renditions
    }
    pub fn available_through(&self) -> usize {
        self.common.segments.len() - 1
    }
    pub fn common_playlist(&self) -> &MediaPlaylist {
        &self.common
    }
    /// Generated complete-prefix snapshot; never serve a rung's unchecked suffix.
    pub fn media_playlist_text(&self, id: RenditionId) -> Result<String> {
        ensure!(
            self.renditions.iter().any(|r| r.id() == id),
            "hls_ladder_rendition_not_planned"
        );
        let mut text = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI=\"init.mp4\"\n".to_owned();
        for segment in &self.common.segments {
            text.push_str(&format!(
                "#EXTINF:{}.{:06},\nindex{}.m4s\n",
                segment.duration_us / 1_000_000,
                segment.duration_us % 1_000_000,
                segment.index
            ));
        }
        if self.common.complete {
            text.push_str("#EXT-X-ENDLIST\n");
        }
        Ok(text)
    }
    pub fn master_text(&self) -> String {
        MasterPlaylist {
            variants: self.renditions.iter().map(|r| r.variant.clone()).collect(),
        }
        .render()
    }
}
/// All planned outputs must pass. No mixed attempts/source/plan generations,
/// source recipes, missing rendition or differing segment timelines is allowed.
pub fn qualify_ladder(
    recipe: &LadderRecipe,
    identity: &AttemptIdentity,
    mut renditions: Vec<QualifiedRendition>,
) -> Result<QualifiedLadder> {
    identity.validate()?;
    ensure!(
        !renditions.is_empty()
            && renditions.len() <= MAX_RENDITIONS
            && renditions.len() == recipe.renditions().len(),
        "hls_ladder_qualification_incomplete"
    );
    renditions.sort_unstable_by_key(|r| r.id());
    let common_count = renditions.iter().map(|r| r.fragments.len()).min().unwrap();
    let first = &renditions[0];
    let common_segments = first.playlist.segments[..common_count].to_vec();
    let complete = renditions
        .iter()
        .all(|r| r.playlist.complete && r.playlist.segments.len() == common_count);
    for (actual, planned) in renditions.iter().zip(recipe.renditions()) {
        ensure!(
            actual.id() == planned.id
                && actual.identity == *identity
                && actual.recipe_sha256 == recipe.recipe_sha256(),
            "hls_ladder_mixed_generation"
        );
        ensure!(
            actual.playlist.segments[..common_count] == common_segments,
            "hls_ladder_rendition_timeline_mismatch"
        );
        if actual.playlist.complete {
            ensure!(
                renditions
                    .iter()
                    .all(|r| r.playlist.segments.len() <= actual.playlist.segments.len()),
                "hls_ladder_rendition_end_mismatch"
            );
        }
        for (a, b) in actual.fragments[..common_count]
            .iter()
            .zip(&first.fragments[..common_count])
        {
            ensure!(
                a.video_start_us == b.video_start_us
                    && a.video_duration_us == b.video_duration_us
                    && a.video_frames == b.video_frames
                    && a.audio_first_pts == b.audio_first_pts
                    && a.audio_end_pts == b.audio_end_pts,
                "hls_ladder_rendition_timeline_mismatch"
            );
        }
    }
    Ok(QualifiedLadder {
        identity: identity.clone(),
        renditions,
        common: MediaPlaylist {
            segments: common_segments,
            complete,
        },
    })
}
