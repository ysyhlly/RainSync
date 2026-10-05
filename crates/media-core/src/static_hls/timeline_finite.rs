//! A separate finite-source v1 helper. It does not change either frozen parser
//! or its output grammar. Only tfdt/mfhd clocks move; elementary media, edits and
//! sample duration/configuration/composition remain unchanged.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FiniteTrackMapping {
    pub track_id: u32,
    pub clock_scale: u32,
    pub original_first_pts: i64,
    pub normalized_first_pts: i64,
    pub timestamp_offset_ticks: i64,
    pub samples: usize,
    pub duration_ticks: u64,
}
type RebasedFragment = (Vec<u8>, Vec<FiniteTrackMapping>, BTreeMap<u32, i64>);
pub(crate) fn finite_fragment_rebase(
    bytes: &[u8],
    tracks: &[Track],
    ends: &BTreeMap<u32, i64>,
    discontinuity: bool,
    previous_video_shift: Option<i64>,
    index: usize,
) -> Result<RebasedFragment> {
    let samples = fragment_samples(bytes, tracks, MAX_RECORDS / 2)?;
    let video = tracks.iter().find(|t| t.kind == TrackKind::Video).unwrap();
    let video_samples = &samples.iter().find(|(id, _)| *id == video.id).unwrap().1;
    let video_first = video_samples[0].pts;
    let expected_video = ends.get(&video.id).copied().unwrap_or(0);
    // Subsequent continuous segments keep the current physical clock. An
    // explicit boundary permits a common, exact-rational track clock offset.
    let delta = expected_video - video_first;
    check(
        index == 0 || discontinuity || Some(delta) == previous_video_shift,
        "finite_undeclared_clock_reset",
    )?;
    let mut mapping = Vec::new();
    let mut next = BTreeMap::new();
    let mut shifts = BTreeMap::new();
    for (id, track_samples) in &samples {
        let track = tracks.iter().find(|t| t.id == *id).unwrap();
        let scaled = i128::from(delta) * i128::from(track.scale);
        check(
            scaled % i128::from(video.scale) == 0,
            "finite_nonintegral_common_clock",
        )?;
        let shift = i64::try_from(scaled / i128::from(video.scale))
            .map_err(|_| anyhow::anyhow!("unsupported_static_hls_timeline:finite_clock_bound"))?;
        let first = track_samples[0].pts + shift;
        let expected = ends
            .get(id)
            .copied()
            .unwrap_or(-i64::from(track.media_time));
        check(first == expected, "finite_track_gap_overlap_or_offset")?;
        let duration = track_samples
            .iter()
            .map(|s| u64::from(s.duration))
            .sum::<u64>();
        let end = first + i64::try_from(duration)?;
        check(
            end >= 0 && end <= MAX_SAFE_INTEGER as i64,
            "finite_clock_bound",
        )?;
        next.insert(*id, end);
        shifts.insert(*id, shift);
        mapping.push(FiniteTrackMapping {
            track_id: *id,
            clock_scale: track.scale,
            original_first_pts: track_samples[0].pts,
            normalized_first_pts: first,
            timestamp_offset_ticks: shift,
            samples: track_samples.len(),
            duration_ticks: duration,
        });
    }
    let top = boxes(bytes)?;
    // SIDX is optional indexing metadata tied to the old clock. Removing it
    // keeps moof-relative media offsets unchanged and avoids a false index map.
    let mut normalized = Vec::with_capacity(bytes.len());
    for b in top.iter().filter(|b| b.kind != b"sidx") {
        normalized.extend_from_slice(&bytes[b.start..b.end]);
    }
    let top = boxes(&normalized)?;
    let moof = top.iter().find(|b| b.kind == b"moof").unwrap();
    let moof_start = moof.start + 8;
    let children = boxes(moof.data)?;
    let mfhd = children.iter().find(|b| b.kind == b"mfhd").unwrap();
    let sequence_at = moof_start + mfhd.start + 8 + 4;
    let mut edits = Vec::new();
    for traf in children.iter().filter(|b| b.kind == b"traf") {
        let grandchildren = boxes(traf.data)?;
        let tfhd = grandchildren.iter().find(|b| b.kind == b"tfhd").unwrap();
        let id = u32_at(tfhd.data, 4)?;
        let tfdt = grandchildren.iter().find(|b| b.kind == b"tfdt").unwrap();
        let raw = if tfdt.data[0] == 1 {
            u64_at(tfdt.data, 4)?
        } else {
            u64::from(u32_at(tfdt.data, 4)?)
        };
        let clock = i128::from(raw) + i128::from(shifts[&id]);
        check(
            clock >= 0
                && clock <= i128::from(MAX_SAFE_INTEGER)
                && (tfdt.data[0] == 1 || clock <= i128::from(u32::MAX)),
            "finite_tfdt_bound",
        )?;
        edits.push((
            moof_start + traf.start + 8 + tfdt.start + 8 + 4,
            tfdt.data[0],
            clock as u64,
        ));
    }
    normalized[sequence_at..sequence_at + 4].copy_from_slice(&(index as u32 + 1).to_be_bytes());
    for (at, version, clock) in edits {
        if version == 1 {
            normalized[at..at + 8].copy_from_slice(&clock.to_be_bytes());
        } else {
            normalized[at..at + 4].copy_from_slice(&(clock as u32).to_be_bytes());
        }
    }
    // Reparse the rewritten physical tables before exposing any mapping.
    let observed = fragment_samples(&normalized, tracks, MAX_RECORDS / 2)?;
    check(
        observed.iter().all(|(id, s)| {
            s[0].pts
                == mapping
                    .iter()
                    .find(|m| m.track_id == *id)
                    .unwrap()
                    .normalized_first_pts
        }),
        "finite_physical_clock_mismatch",
    )?;
    Ok((normalized, mapping, next))
}
