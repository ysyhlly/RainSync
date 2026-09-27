//! Validate the local FFmpeg fMP4 layout, not arbitrary upstream playlists.
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

fn boxes(path: &Path, required: &[[u8; 4]]) -> Result<File> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "output_not_regular"
    );
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let mut position = 0u64;
    let mut found = Vec::new();
    let mut count = 0;
    while position < length {
        count += 1;
        ensure!(
            count <= 100_000 && length - position >= 8,
            "truncated_output_box"
        );
        let mut header = [0; 8];
        file.read_exact(&mut header)?;
        let size = u32::from_be_bytes(header[..4].try_into()?) as u64;
        let (size, header_size) = if size == 1 {
            let mut extended = [0; 8];
            file.read_exact(&mut extended)?;
            (u64::from_be_bytes(extended), 16)
        } else if size == 0 {
            (length - position, 8)
        } else {
            (size, 8)
        };
        ensure!(
            size >= header_size && size <= length - position,
            "truncated_output_box"
        );
        let kind: [u8; 4] = header[4..].try_into()?;
        if required.contains(&kind) {
            ensure!(size > header_size, "empty_output_box");
            found.push(kind);
        }
        position += size;
        file.seek(SeekFrom::Start(position))?;
    }
    ensure!(
        required.iter().all(|kind| found.contains(kind)),
        "missing_output_box"
    );
    file.rewind()?;
    Ok(file)
}

/// Temporary files and noncanonical names never form part of a local output.
pub fn media_path(name: &str) -> bool {
    name == "init.mp4"
        || name
            .strip_prefix("index")
            .and_then(|s| s.strip_suffix(".m4s"))
            .is_some_and(|s| s.parse::<usize>().is_ok_and(|n| n.to_string() == s))
}

/// Keep the checked handle for delivery, so a later rename cannot substitute
/// another file between validation and opening the HTTP body.
pub fn open_media(path: &Path) -> Result<File> {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    ensure!(media_path(name), "invalid_output_segment_path");
    let required = if name == "init.mp4" {
        [*b"ftyp", *b"moov"]
    } else {
        [*b"moof", *b"mdat"]
    };
    boxes(path, &required)
}

pub fn hash_file(file: &mut File) -> Result<(i64, String)> {
    let before = file.metadata()?;
    file.rewind()?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut size = 0u64;
    let mut input = (&mut *file).take(before.len().saturating_add(1));
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        size = size
            .checked_add(n as u64)
            .ok_or_else(|| anyhow::anyhow!("output_too_large"))?;
    }
    let after = file.metadata()?;
    ensure!(
        before.len() == size && after.len() == size && before.modified()? == after.modified()?,
        "output_changed_during_hash"
    );
    file.rewind()?;
    Ok((i64::try_from(size)?, hex::encode(hash.finalize())))
}

pub fn open_verified(path: &Path, proof: &persistence::media_outputs::FileProof) -> Result<File> {
    let mut file = open_media(path)?;
    let (size, sha256) = hash_file(&mut file)?;
    ensure!(
        size == proof.size_bytes && sha256 == proof.sha256,
        "output_digest_mismatch"
    );
    Ok(file)
}

#[derive(Default)]
pub struct Progress {
    segments: usize,
    prefix_sha256: [u8; 32],
}

impl Progress {
    /// FFmpeg renames completed segments into an attempt-specific directory.
    /// Validate only the newly advertised suffix. Every file GET still checks
    /// its own structure, including files previously accepted by this cache.
    pub fn check(&mut self, directory: &Path, text: &str) -> Result<()> {
        ensure!(readable_manifest(text), "invalid_output_manifest");
        let mut offset = 0;
        let mut segments = Vec::new();
        for line in text.split_inclusive('\n') {
            offset += line.len();
            let name = line.trim_end_matches(['\r', '\n']);
            if !name.is_empty() && !name.starts_with('#') {
                segments.push((name, offset));
            }
        }
        if self.segments > segments.len()
            || (self.segments > 0
                && Sha256::digest(&text.as_bytes()[..segments[self.segments - 1].1])[..]
                    != self.prefix_sha256)
        {
            self.segments = 0;
        }
        open_media(&directory.join("init.mp4"))?;
        for (name, _) in &segments[self.segments..] {
            open_media(&directory.join(name))?;
        }
        self.segments = segments.len();
        self.prefix_sha256 = Sha256::digest(&text.as_bytes()[..segments.last().unwrap().1]).into();
        Ok(())
    }
}

/// Only serve a complete local EVENT playlist snapshot. A valid prefix ending
/// at a segment boundary is playable; an unfinished tag/duration/URI is not.
pub fn readable_manifest(text: &str) -> bool {
    if !text.ends_with('\n') || text.contains('\0') {
        return false;
    }
    let mut lines = text.lines();
    if lines.next() != Some("#EXTM3U") {
        return false;
    }
    let (mut init, mut pending, mut ended, mut segments) = (false, false, false, 0);
    for line in lines.filter(|line| !line.is_empty()) {
        if ended {
            return false;
        }
        if line == "#EXT-X-MAP:URI=\"init.mp4\"" {
            if init || pending || segments != 0 {
                return false;
            }
            init = true;
        } else if let Some(value) = line.strip_prefix("#EXTINF:") {
            if !init
                || pending
                || !value.ends_with(',')
                || !value
                    .trim_end_matches(',')
                    .parse::<f64>()
                    .is_ok_and(|n| n.is_finite() && n > 0.0)
            {
                return false;
            }
            pending = true;
        } else if line == "#EXT-X-ENDLIST" {
            if pending {
                return false;
            }
            ended = true;
        } else if line == "#EXT-X-MEDIA-SEQUENCE:0" || line == "#EXT-X-PLAYLIST-TYPE:EVENT" {
            if pending || segments != 0 {
                return false;
            }
        } else if let Some(value) = line
            .strip_prefix("#EXT-X-VERSION:")
            .or_else(|| line.strip_prefix("#EXT-X-TARGETDURATION:"))
        {
            if pending || segments != 0 || !value.parse::<u32>().is_ok_and(|n| n > 0) {
                return false;
            }
        } else {
            if !pending || line != format!("index{segments}.m4s") {
                return false;
            }
            pending = false;
            segments += 1;
        }
    }
    init && segments > 0 && !pending
}

pub async fn read_manifest(path: &Path) -> Result<String> {
    use tokio::io::AsyncReadExt;
    let mut text = String::new();
    tokio::fs::File::open(path)
        .await?
        .take(2 * 1024 * 1024 + 1)
        .read_to_string(&mut text)
        .await?;
    ensure!(text.len() <= 2 * 1024 * 1024, "output_manifest_too_large");
    Ok(text)
}

pub fn validate(directory: &Path) -> Result<persistence::media_jobs::Publication> {
    let path = directory.join("index.m3u8");
    let metadata = std::fs::symlink_metadata(&path)?;
    ensure!(
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.len() <= 2 * 1024 * 1024,
        "invalid_output_manifest"
    );
    let mut text = String::new();
    File::open(path)?
        .take(2 * 1024 * 1024 + 1)
        .read_to_string(&mut text)?;
    ensure!(text.len() <= 2 * 1024 * 1024, "output_manifest_too_large");
    let mut lines = text.lines();
    ensure!(lines.next() == Some("#EXTM3U"), "invalid_output_manifest");
    let mut ended = false;
    let mut init = false;
    let mut duration = false;
    let mut segments = 0;
    for line in lines.filter(|line| !line.is_empty()) {
        ensure!(!ended, "output_after_endlist");
        if line == "#EXT-X-ENDLIST" {
            ensure!(!duration, "missing_output_segment");
            ended = true;
        } else if line == "#EXT-X-MAP:URI=\"init.mp4\"" {
            ensure!(!init && segments == 0, "invalid_output_map");
            boxes(&directory.join("init.mp4"), &[*b"ftyp", *b"moov"])?;
            init = true;
        } else if let Some(value) = line.strip_prefix("#EXTINF:") {
            ensure!(init && !duration, "invalid_output_duration");
            let value: f64 = value.split(',').next().unwrap_or("").parse()?;
            ensure!(value.is_finite() && value > 0.0, "invalid_output_duration");
            duration = true;
        } else if line.starts_with('#') {
            ensure!(
                line.starts_with("#EXT-X-VERSION:")
                    || line.starts_with("#EXT-X-TARGETDURATION:")
                    || line == "#EXT-X-MEDIA-SEQUENCE:0"
                    || line == "#EXT-X-PLAYLIST-TYPE:EVENT",
                "unsupported_local_output_tag"
            );
        } else {
            ensure!(
                duration && line == format!("index{segments}.m4s"),
                "invalid_output_segment_path"
            );
            boxes(&directory.join(line), &[*b"moof", *b"mdat"])?;
            duration = false;
            segments += 1;
        }
    }
    ensure!(
        ended && init && segments > 0 && !duration,
        "incomplete_output"
    );
    Ok(persistence::media_jobs::Publication {
        manifest_sha256: hex::encode(Sha256::digest(text.as_bytes())),
        segment_count: segments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_snapshots_require_ready_segments_and_recheck_rewritten_prefixes() {
        let root = std::env::temp_dir().join(format!("rainsync-output-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let first = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nindex0.m4s\n";
        let second = format!("{first}#EXTINF:4,\nindex1.m4s\n");
        let segment = [atom(b"moof"), atom(b"mdat")].concat();
        let mut progress = Progress::default();
        std::fs::write(
            root.join("init.mp4"),
            [atom(b"ftyp"), atom(b"moov")].concat(),
        )
        .unwrap();
        assert!(progress.check(&root, first).is_err());
        std::fs::write(root.join("index0.m4s"), &segment).unwrap();
        progress.check(&root, first).unwrap();
        std::fs::write(root.join("index1.m4s.tmp"), &segment).unwrap();
        assert!(progress.check(&root, &second).is_err());
        std::fs::rename(root.join("index1.m4s.tmp"), root.join("index1.m4s")).unwrap();
        progress.check(&root, &second).unwrap();
        // In-place damage after advertisement is caught at the file boundary.
        std::fs::write(root.join("index0.m4s"), &segment[..segment.len() - 1]).unwrap();
        assert!(open_media(&root.join("index0.m4s")).is_err());
        // A modified prefix cannot reuse previous readiness checks.
        assert!(
            progress
                .check(&root, &second.replace("#EXTINF:4,", "#EXTINF:3,"))
                .is_err()
        );
        std::fs::write(root.join("index0.m4s"), &segment).unwrap();
        progress.check(&root, first).unwrap();
        assert_eq!(progress.segments, 1);
        for name in [
            "index00.m4s",
            "index-1.m4s",
            "index0.m4s.tmp",
            "index.m3u8",
            "../init.mp4",
        ] {
            assert!(!media_path(name));
        }
        let mut handle = open_media(&root.join("index0.m4s")).unwrap();
        let mut bytes = Vec::new();
        handle.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, segment, "checked handle starts at byte zero");
        drop(handle);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn incomplete_playlist_snapshots_are_not_readable() {
        let full = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nindex0.m4s\n";
        assert!(readable_manifest(full));
        assert!(readable_manifest(&format!("{full}#EXT-X-ENDLIST\n")));
        // Every prefix before the complete first segment is a torn write.
        for end in 0..full.len() {
            assert!(!readable_manifest(&full[..end]), "prefix {end}");
        }
        for suffix in [
            "#EXTINF:4,\n",
            "#EXTINF:NaN,\nindex1.m4s\n",
            "#EXTINF:4,\nindex1.m4",
            "#EXTINF:4,\n../index1.m4s\n",
            "#EXT-X-ENDLIST\nindex1.m4s\n",
        ] {
            assert!(!readable_manifest(&format!("{full}{suffix}")));
        }
    }
    fn atom(kind: &[u8; 4]) -> Vec<u8> {
        [9u32.to_be_bytes().as_slice(), kind, &[0]].concat()
    }
    #[test]
    fn rejects_missing_truncated_escaped_and_unfinished_outputs() {
        let root = std::env::temp_dir().join(format!("rainsync-output-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let manifest =
            "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nindex0.m4s\n#EXT-X-ENDLIST\n";
        std::fs::write(root.join("index.m3u8"), manifest).unwrap();
        std::fs::write(
            root.join("init.mp4"),
            [atom(b"ftyp"), atom(b"moov")].concat(),
        )
        .unwrap();
        assert!(validate(&root).is_err());
        let segment = [atom(b"moof"), atom(b"mdat")].concat();
        std::fs::write(root.join("index0.m4s"), &segment).unwrap();
        validate(&root).unwrap();
        std::fs::write(root.join("index0.m4s"), &segment[..segment.len() - 1]).unwrap();
        assert!(validate(&root).is_err());
        std::fs::write(root.join("index0.m4s"), &segment).unwrap();
        for invalid in [
            manifest.replace("index0.m4s", "../index0.m4s"),
            manifest.replace("#EXT-X-ENDLIST\n", ""),
            manifest.replace("#EXTINF:4,", "#EXTINF:NaN,"),
            manifest.replace("init.mp4", "other.mp4"),
        ] {
            std::fs::write(root.join("index.m3u8"), invalid).unwrap();
            assert!(validate(&root).is_err());
        }
        let resolved = root.canonicalize().unwrap();
        assert_eq!(
            resolved.parent(),
            Some(std::env::temp_dir().canonicalize().unwrap().as_path())
        );
        assert_eq!(resolved.file_name(), root.file_name());
        std::fs::remove_dir_all(resolved).unwrap();
    }
}
