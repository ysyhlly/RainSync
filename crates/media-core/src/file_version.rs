//! Handle-based change detection, not a content hash or immutable snapshot.
use sha2::{Digest, Sha256};
use std::{fs::File, io};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub version: String,
    pub len: u64,
}

pub fn valid_file_version(value: &str) -> bool {
    value.strip_prefix("stat-v1:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}

pub fn snapshot_file(file: &File) -> io::Result<Snapshot> {
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    let mut hash = Sha256::new();
    hash.update(b"rainsync-file-stat-v1\0");
    hash.update(meta.len().to_le_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        hash.update(b"unix\0");
        hash.update(meta.dev().to_le_bytes());
        hash.update(meta.ino().to_le_bytes());
        hash.update(meta.mtime().to_le_bytes());
        hash.update(meta.mtime_nsec().to_le_bytes());
        hash.update(meta.ctime().to_le_bytes());
        hash.update(meta.ctime_nsec().to_le_bytes());
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                FILE_BASIC_INFO, FILE_ID_INFO, FileBasicInfo, FileIdInfo,
                GetFileInformationByHandleEx,
            },
        };
        let mut id = FILE_ID_INFO::default();
        let mut basic = FILE_BASIC_INFO::default();
        unsafe {
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileIdInfo,
                (&mut id as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
            .map_err(io::Error::other)?;
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
            .map_err(io::Error::other)?;
        }
        hash.update(b"windows\0");
        hash.update(id.VolumeSerialNumber.to_le_bytes());
        hash.update(id.FileId.Identifier);
        hash.update(basic.CreationTime.to_le_bytes());
        hash.update(basic.LastWriteTime.to_le_bytes());
        hash.update(basic.ChangeTime.to_le_bytes());
    }
    Ok(Snapshot {
        version: format!("stat-v1:{:x}", hash.finalize()),
        len: meta.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{self, FileTimes},
        io::Read,
    };

    #[test]
    fn file_identity_and_change_time_detect_replacement_and_same_size_edits() {
        let root = std::env::temp_dir().join(format!("rainsync-version-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("movie.mp4");
        fs::write(&path, b"original").unwrap();
        let mut held = File::open(&path).unwrap();
        let original_time = held.metadata().unwrap().modified().unwrap();
        let before = snapshot_file(&held).unwrap();
        assert!(valid_file_version(&before.version));
        let mut bytes = Vec::new();
        held.read_to_end(&mut bytes).unwrap();
        assert_eq!(
            snapshot_file(&held).unwrap(),
            before,
            "reading cannot change the version"
        );

        let replacement = root.join("replacement.mp4");
        fs::write(&replacement, b"replaced").unwrap();
        File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_times(FileTimes::new().set_modified(original_time))
            .unwrap();
        fs::rename(&replacement, &path).unwrap();
        let new = File::open(&path).unwrap();
        let replaced = snapshot_file(&new).unwrap();
        assert_ne!(
            before.version, replaced.version,
            "same size/mtime is not the same file"
        );

        std::thread::sleep(std::time::Duration::from_millis(10));
        fs::write(&path, b"rewritte").unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(FileTimes::new().set_modified(original_time))
            .unwrap();
        assert_ne!(
            snapshot_file(&new).unwrap().version,
            replaced.version,
            "in-place rewrite changes the version even with restored mtime"
        );
        drop(new);
        drop(held);
        fs::remove_dir_all(root).unwrap();
    }
}
