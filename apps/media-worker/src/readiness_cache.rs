//! Read-only traversal plus a unique create-new probe under the owned cache.
//! No eviction, source access, DB mutation, or symlink traversal is permitted.
use std::{
    fs,
    io::{self, Read, Seek, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
struct ProbeFile(Option<PathBuf>);
impl Drop for ProbeFile {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

pub(super) fn check(
    root: &Path,
    max_bytes: u64,
    budget: Duration,
    max_entries: usize,
) -> io::Result<()> {
    let began = Instant::now();
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::other("cache root is not a directory"));
    }
    let root = root.canonicalize()?;
    let total = fs2::total_space(&root)?;
    if total == 0 || fs2::available_space(&root)? <= total / 10 || max_bytes == 0 {
        return Err(io::Error::other("cache capacity unavailable"));
    }
    let mut options = fs::OpenOptions::new();
    options.create_new(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let path = root.join(format!(".rainsync-ready-{}", uuid::Uuid::new_v4()));
    let mut file = options.open(&path)?;
    let mut cleanup = ProbeFile(Some(path));
    const CONTENT: &[u8] = b"rainsync readiness write/read probe\n";
    file.write_all(CONTENT)?;
    file.sync_data()?;
    file.rewind()?;
    let mut actual = [0u8; CONTENT.len()];
    file.read_exact(&mut actual)?;
    if actual != CONTENT {
        return Err(io::Error::other("cache probe did not round-trip"));
    }
    drop(file);
    fs::remove_file(cleanup.0.as_ref().expect("owned probe file"))?;
    cleanup.0 = None;
    drop(cleanup);

    let mut pending = vec![(root, 0usize)];
    let mut bytes = 0u64;
    let mut seen = 0usize;
    while let Some((path, depth)) = pending.pop() {
        if depth > 64 {
            return Err(io::Error::other("cache scan depth exceeded"));
        }
        for entry in fs::read_dir(path)? {
            seen += 1;
            if seen > max_entries || began.elapsed() > budget {
                return Err(io::Error::other("cache scan budget exceeded"));
            }
            let entry = entry?;
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(v) => v,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push((entry.path(), depth + 1));
            } else {
                bytes = bytes.saturating_add(metadata.len());
            }
            if bytes >= max_bytes {
                return Err(io::Error::other("cache quota exceeded"));
            }
        }
    }
    if began.elapsed() > budget {
        return Err(io::Error::other("cache probe budget exceeded"));
    }
    Ok(())
}
