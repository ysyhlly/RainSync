//! Handle-relative, unique attempt storage. Ordinary runtime writers cannot
//! obtain a writer after seal; all writable handles drain before that transition.
//! This is not protection against a malicious administrator or an unrelated
//! same-UID process intentionally chmod-ing or replacing private capture files.
//! Normal runtime writers only use unique, encapsulated attempts and cannot
//! obtain a writable API or retained descriptor after the sealing transition.
use super::CaptureOwnerIdentity;
use anyhow::{Result, ensure};
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};

#[cfg(target_os = "linux")]
use std::os::{
    fd::{AsRawFd, FromRawFd},
    unix::fs::MetadataExt,
};

pub(super) struct OwnedDirectory {
    #[cfg(target_os = "linux")]
    parent: std::sync::Arc<File>,
    pub(super) directory: std::sync::Arc<File>,
    name: String,
    identity: CaptureOwnerIdentity,
    files: Vec<String>,
    sealed: bool,
    budget: super::storage_budget::StorageBudget,
    pub(super) manifest_final_url: Option<String>,
    pub(super) read_targets: Vec<(String, String)>,
}
impl OwnedDirectory {
    pub(super) fn reserve_local_manifest(&mut self, bytes: usize) -> Result<()> {
        self.budget.reserve_local_manifest(bytes)
    }
    pub(super) fn before_write(&mut self, name: &str, bytes: usize) -> Result<()> {
        self.budget.before_write(name, bytes)
    }
    #[cfg(target_os = "linux")]
    pub(super) fn create(cache_root: &Path, identity: &CaptureOwnerIdentity) -> Result<Self> {
        identity.validate()?;
        let cache = open_dir(cache_root)?;
        let name = c("static-hls")?;
        let result = unsafe { libc::mkdirat(cache.as_raw_fd(), name.as_ptr(), 0o700) };
        ensure!(
            result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST),
            "static_hls_root_create"
        );
        let parent = open_at(&cache, "static-hls", libc::O_RDONLY | libc::O_DIRECTORY)?;
        let meta = parent.metadata()?;
        ensure!(
            meta.mode() & 0o077 == 0 && meta.uid() == unsafe { libc::geteuid() },
            "static_hls_root_permissions"
        );
        let owner = format!(
            "{}\n{}\n{}\n",
            identity.capture_id, identity.owner_id, identity.relative_key
        );
        let budget = super::storage_budget::StorageBudget::new(owner.len())?;
        let name = c(&identity.capture_id)?;
        ensure!(
            unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } == 0,
            "static_hls_attempt_exists_or_create_failed"
        );
        let directory = open_at(
            &parent,
            &identity.capture_id,
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        let mut owned = Self {
            parent: std::sync::Arc::new(parent),
            directory: std::sync::Arc::new(directory),
            name: identity.capture_id.clone(),
            identity: identity.clone(),
            files: vec![],
            sealed: false,
            budget,
            manifest_final_url: None,
            read_targets: Vec::new(),
        };
        owned.write_complete("owner", owner.as_bytes())?;
        Ok(owned)
    }
    #[cfg(not(target_os = "linux"))]
    pub(super) fn create(_: &Path, _: &CaptureOwnerIdentity) -> Result<Self> {
        anyhow::bail!("static_hls_linux_required")
    }

    pub(super) async fn read_scoped(&self, name: &str, maximum: usize) -> Result<Vec<u8>> {
        ensure!(
            safe_name(name) && self.files.iter().any(|v| v == name),
            "static_hls_unowned_file"
        );
        let directory = self.directory.clone();
        let name = name.to_owned();
        crate::child_process::blocking(move || {
            #[cfg(target_os = "linux")]
            let file = open_at(&directory, &name, libc::O_RDONLY)?;
            #[cfg(not(target_os = "linux"))]
            let file = File::open("unsupported-static-hls")?;
            let meta = file.metadata()?;
            ensure!(
                meta.is_file() && meta.len() > 0 && meta.len() <= maximum as u64,
                "static_hls_file_bound"
            );
            let mut bytes = Vec::with_capacity(meta.len() as usize);
            file.take(maximum as u64 + 1).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() == meta.len() as usize,
                "static_hls_file_changed"
            );
            Ok::<_, anyhow::Error>(bytes)
        })
        .await?
    }
    pub(super) async fn create_file_scoped(&mut self, name: &str) -> Result<File> {
        ensure!(
            !self.sealed && safe_name(name) && !self.files.iter().any(|v| v == name),
            "static_hls_writer_closed"
        );
        self.files.push(name.to_owned());
        let directory = self.directory.clone();
        let name = name.to_owned();
        crate::child_process::blocking(move || {
            #[cfg(target_os = "linux")]
            {
                open_at(
                    &directory,
                    &name,
                    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                )
            }
            #[cfg(not(target_os = "linux"))]
            {
                anyhow::bail!("static_hls_linux_required")
            }
        })
        .await?
    }
    pub(super) async fn seal_file_scoped(&self, name: &str) -> Result<()> {
        let directory = self.directory.clone();
        let name = name.to_owned();
        crate::child_process::blocking(move || {
            #[cfg(target_os = "linux")]
            {
                let file = open_at(&directory, &name, libc::O_RDONLY)?;
                ensure!(
                    unsafe { libc::fchmod(file.as_raw_fd(), 0o400) } == 0,
                    "static_hls_file_seal"
                );
                Ok(())
            }
            #[cfg(not(target_os = "linux"))]
            {
                anyhow::bail!("static_hls_linux_required")
            }
        })
        .await?
    }
    pub(super) async fn write_complete_scoped(&mut self, name: &str, bytes: Vec<u8>) -> Result<()> {
        self.before_write(name, bytes.len())?;
        let mut file = self.create_file_scoped(name).await?;
        crate::child_process::blocking(move || {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            Ok::<_, std::io::Error>(())
        })
        .await??;
        self.seal_file_scoped(name).await
    }
    pub(super) async fn seal_scoped(&mut self) -> Result<()> {
        // An owned, read-only clone exposes no writer API to any caller.
        self.sealed = true;
        let directory = self.directory.clone();
        crate::child_process::blocking(move || {
            directory.sync_all()?;
            #[cfg(target_os = "linux")]
            ensure!(
                unsafe { libc::fchmod(directory.as_raw_fd(), 0o500) } == 0,
                "static_hls_directory_seal"
            );
            Ok::<_, anyhow::Error>(())
        })
        .await?
    }
    #[cfg(target_os = "linux")]
    pub(super) fn create_file(&mut self, name: &str) -> Result<File> {
        ensure!(
            !self.sealed && safe_name(name) && !self.files.iter().any(|v| v == name),
            "static_hls_writer_closed"
        );
        let file = open_at(
            &self.directory,
            name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        self.files.push(name.to_owned());
        Ok(file)
    }
    #[cfg(not(target_os = "linux"))]
    pub(super) fn create_file(&mut self, _: &str) -> Result<File> {
        anyhow::bail!("static_hls_linux_required")
    }
    pub(super) fn write_complete(&mut self, name: &str, bytes: &[u8]) -> Result<()> {
        if name == "index.m3u8" {
            self.reserve_local_manifest(bytes.len())?;
        }
        self.before_write(name, bytes.len())?;
        let mut file = self.create_file(name)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        self.seal_file(name)
    }
    #[cfg(target_os = "linux")]
    pub(super) fn seal_file(&self, name: &str) -> Result<()> {
        let file = open_at(&self.directory, name, libc::O_RDONLY)?;
        ensure!(
            unsafe { libc::fchmod(file.as_raw_fd(), 0o400) } == 0,
            "static_hls_file_seal"
        );
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    pub(super) fn seal_file(&self, _: &str) -> Result<()> {
        anyhow::bail!("static_hls_linux_required")
    }
    pub(super) fn read(&self, name: &str, maximum: usize) -> Result<Vec<u8>> {
        ensure!(
            safe_name(name) && self.files.iter().any(|v| v == name),
            "static_hls_unowned_file"
        );
        #[cfg(target_os = "linux")]
        let file = open_at(&self.directory, name, libc::O_RDONLY)?;
        #[cfg(not(target_os = "linux"))]
        let file = File::open("unsupported-static-hls")?;
        let meta = file.metadata()?;
        ensure!(
            meta.is_file() && meta.len() > 0 && meta.len() <= maximum as u64,
            "static_hls_file_bound"
        );
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        file.take(maximum as u64 + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() == meta.len() as usize,
            "static_hls_file_changed"
        );
        Ok(bytes)
    }

    pub(super) fn read_sealed(&self, name: &str, maximum: usize) -> Result<Vec<u8>> {
        ensure!(self.sealed, "static_hls_unsealed_snapshot");
        #[cfg(target_os = "linux")]
        self.verify_owner()?;
        self.read(name, maximum)
    }
    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn seal(&mut self) -> Result<()> {
        self.verify_owner()?;
        ensure!(
            !self.sealed && self.files.iter().any(|v| v == "index.m3u8"),
            "static_hls_snapshot_state"
        );
        // Private transition: callers have no access to mutable directory/file
        // APIs, and all writes already finished before this method is reached.
        self.directory.sync_all()?;
        ensure!(
            unsafe { libc::fchmod(self.directory.as_raw_fd(), 0o500) } == 0,
            "static_hls_directory_seal"
        );
        self.sealed = true;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    fn verify_owner(&self) -> Result<()> {
        let named = open_at(&self.parent, &self.name, libc::O_RDONLY | libc::O_DIRECTORY)?;
        let a = named.metadata()?;
        let b = self.directory.metadata()?;
        ensure!(
            a.dev() == b.dev() && a.ino() == b.ino(),
            "static_hls_directory_owner_mismatch"
        );
        let expected = format!(
            "{}\n{}\n{}\n",
            self.identity.capture_id, self.identity.owner_id, self.identity.relative_key
        );
        ensure!(
            self.read("owner", 512)? == expected.as_bytes(),
            "static_hls_directory_owner_mismatch"
        );
        Ok(())
    }
    #[cfg(target_os = "linux")]
    pub(super) async fn decoder_fd_scoped(&self) -> Result<File> {
        ensure!(self.sealed, "static_hls_unsealed_snapshot");
        let parent = self.parent.clone();
        let directory = self.directory.clone();
        let name = self.name.clone();
        let identity = self.identity.clone();
        crate::child_process::blocking(move || {
            let named = open_at(&parent, &name, libc::O_RDONLY | libc::O_DIRECTORY)?;
            let a = named.metadata()?;
            let b = directory.metadata()?;
            ensure!(
                a.dev() == b.dev() && a.ino() == b.ino(),
                "static_hls_directory_owner_mismatch"
            );
            let expected = format!(
                "{}\n{}\n{}\n",
                identity.capture_id, identity.owner_id, identity.relative_key
            );
            let file = open_at(&directory, "owner", libc::O_RDONLY)?;
            let mut bytes = Vec::new();
            file.take(513).read_to_end(&mut bytes)?;
            ensure!(
                bytes == expected.as_bytes(),
                "static_hls_directory_owner_mismatch"
            );
            let fd = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
            ensure!(fd >= 0, "static_hls_snapshot_handle");
            Ok(unsafe { File::from_raw_fd(fd) })
        })
        .await?
    }
    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn decoder_fd(&self) -> Result<File> {
        ensure!(self.sealed, "static_hls_unsealed_snapshot");
        self.verify_owner()?;
        // Kept above stdio so child setup cannot overwrite this descriptor.
        let fd = unsafe { libc::fcntl(self.directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
        ensure!(fd >= 0, "static_hls_snapshot_handle");
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    #[cfg(target_os = "linux")]
    pub(super) fn remove_owned(&mut self) -> Result<()> {
        self.verify_owner()?;
        ensure!(
            unsafe { libc::fchmod(self.directory.as_raw_fd(), 0o700) } == 0,
            "static_hls_cleanup_permissions"
        );
        // An unexpected entry is not ours to remove. Refuse before changing
        // the ownership marker, leaving a useful unresolved ownership witness.
        let entries = std::fs::read_dir(format!("/proc/self/fd/{}", self.directory.as_raw_fd()))?
            .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<std::io::Result<std::collections::BTreeSet<_>>>()?;
        ensure!(
            entries.is_subset(&self.files.iter().cloned().collect()) && entries.contains("owner"),
            "static_hls_cleanup_unowned_entry"
        );
        // Unlink only server-created exact names; no recursive traversal, no
        // following symlinks, no deleting an unproven directory replacement.
        // Keep the marker until every other file is removed successfully.
        for name in self.files.iter().filter(|name| name.as_str() != "owner") {
            let name = c(name)?;
            let removed = unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) };
            ensure!(
                removed == 0
                    || std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT),
                "static_hls_cleanup_file"
            );
        }
        let named = open_at(&self.parent, &self.name, libc::O_RDONLY | libc::O_DIRECTORY)?;
        let a = named.metadata()?;
        let b = self.directory.metadata()?;
        ensure!(
            a.dev() == b.dev() && a.ino() == b.ino(),
            "static_hls_directory_owner_mismatch"
        );
        let marker = c("owner")?;
        ensure!(
            unsafe { libc::unlinkat(self.directory.as_raw_fd(), marker.as_ptr(), 0) } == 0,
            "static_hls_cleanup_marker"
        );
        let name = c(&self.name)?;
        ensure!(
            unsafe { libc::unlinkat(self.parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) }
                == 0,
            "static_hls_cleanup_directory"
        );
        self.files.clear();
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    pub(super) fn remove_owned(&mut self) -> Result<()> {
        anyhow::bail!("static_hls_linux_required")
    }
}
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 64
        && name
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"-_.".contains(&v))
        && name != "."
        && name != ".."
}
#[cfg(target_os = "linux")]
fn c(value: &str) -> Result<std::ffi::CString> {
    std::ffi::CString::new(value).map_err(|_| anyhow::anyhow!("static_hls_path"))
}
#[cfg(target_os = "linux")]
fn open_dir(path: &Path) -> Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    ensure!(file.metadata()?.is_dir(), "static_hls_cache_root");
    Ok(file)
}
#[cfg(target_os = "linux")]
fn open_at(directory: &File, name: &str, flags: i32) -> Result<File> {
    let name = c(name)?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            0o600,
        )
    };
    ensure!(fd >= 0, "static_hls_owned_file_open");
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    fn identity() -> CaptureOwnerIdentity {
        let id = uuid::Uuid::new_v4().to_string();
        CaptureOwnerIdentity {
            relative_key: format!("static-hls/{id}"),
            capture_id: id,
            owner_id: uuid::Uuid::new_v4().to_string(),
        }
    }
    #[test]
    fn sealed_writer_attempt_reuse_and_owner_replacement_are_refused() {
        let root = std::env::temp_dir().join(format!("hls-owned-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let id = identity();
        let mut dir = OwnedDirectory::create(&root, &id).unwrap();
        assert!(OwnedDirectory::create(&root, &id).is_err());
        assert!(dir.create_file("../bad").is_err());
        dir.write_complete("index.m3u8", b"#EXTM3U\n").unwrap();
        dir.seal().unwrap();
        assert!(dir.create_file("late.m4s").is_err());
        let at = root.join(&id.relative_key);
        let moved = root.join("static-hls/moved");
        std::fs::rename(&at, &moved).unwrap();
        std::fs::create_dir(&at).unwrap();
        assert!(dir.decoder_fd().is_err());
        assert!(dir.remove_owned().is_err());
        assert!(moved.join("index.m3u8").exists());
        std::fs::remove_dir(&at).unwrap();
        std::fs::rename(&moved, &at).unwrap();
        dir.remove_owned().unwrap();
        std::fs::remove_dir(root.join("static-hls")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn canceled_late_file_writer_is_drained_before_owned_deletion() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let root = std::env::temp_dir().join(format!("hls-late-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let id = identity();
        let mut directory = OwnedDirectory::create(&root, &id).unwrap();
        let mut file = directory.create_file("late.m4s").unwrap();
        let scope = crate::child_process::Scope::new();
        let (release, released) = std::sync::mpsc::channel();
        let (entered, mut began) = tokio::sync::watch::channel(false);
        let closed = std::sync::Arc::new(AtomicBool::new(false));
        let finished = closed.clone();
        let owned_scope = scope.clone();
        let waiter = tokio::spawn(async move {
            owned_scope
                .run(crate::child_process::blocking(move || {
                    entered.send_replace(true);
                    released
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    file.write_all(b"late owned bytes").unwrap();
                    file.sync_all().unwrap();
                    drop(file);
                    finished.store(true, Ordering::SeqCst);
                }))
                .await
        });
        while !*began.borrow_and_update() {
            began.changed().await.unwrap();
        }
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), scope.shutdown())
                .await
                .is_err()
        );
        assert!(!closed.load(Ordering::SeqCst));
        assert!(root.join(&id.relative_key).join("late.m4s").exists());
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), scope.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert!(closed.load(Ordering::SeqCst));
        assert_eq!(
            directory.read("late.m4s", 1024).unwrap(),
            b"late owned bytes"
        );
        directory.remove_owned().unwrap();
        assert!(!root.join(&id.relative_key).exists());
        std::fs::remove_dir(root.join("static-hls")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn unified_prewrite_budget_accepts_exact_disk_file_bytes_and_refuses_plus_one() {
        let root = std::env::temp_dir().join(format!("hls-budget-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let id = identity();
        let mut directory = OwnedDirectory::create(&root, &id).unwrap();
        // Both metadata files are preaccounted before the payload's first write.
        directory
            .write_complete("index.m3u8", b"#EXTM3U\n")
            .unwrap();
        let mut file = directory.create_file("boundary.m4s").unwrap();
        let buffer = vec![0x31u8; 65536];
        let exact = directory.budget.remaining();
        let mut written = 0;
        let mut peak = 0;
        while written < exact {
            let bytes = buffer.len().min(exact - written);
            directory.before_write("boundary.m4s", bytes).unwrap();
            file.write_all(&buffer[..bytes]).unwrap();
            written += bytes;
            let disk_file_bytes: u64 = std::fs::read_dir(root.join(&id.relative_key))
                .unwrap()
                .map(|entry| entry.unwrap().metadata().unwrap().len())
                .sum();
            peak = peak.max(disk_file_bytes);
            assert!(peak <= super::super::TOTAL_BYTES as u64);
        }
        file.sync_all().unwrap();
        assert_eq!(peak, super::super::TOTAL_BYTES as u64);
        assert!(directory.before_write("boundary.m4s", 1).is_err());
        assert!(directory.before_write("boundary.m4s", usize::MAX).is_err());
        assert_eq!(
            file.metadata().unwrap().len(),
            exact as u64,
            "a denied +1 is never written"
        );
        assert_eq!(directory.budget.remaining(), 0);
        drop(file);
        directory.remove_owned().unwrap();
        std::fs::remove_dir(root.join("static-hls")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
