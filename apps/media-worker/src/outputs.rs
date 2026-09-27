//! Validate the local FFmpeg fMP4 layout, not arbitrary upstream playlists.
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

fn boxes(path: &Path, required: &[[u8; 4]]) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "output_not_regular"
    );
    let length = metadata.len();
    let mut file = File::open(path)?;
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
    Ok(())
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
