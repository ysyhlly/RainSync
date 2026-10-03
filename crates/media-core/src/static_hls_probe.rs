//! Internal 64-byte fresh shared-cache diagnostic, independent of capture data.
//! Descriptor-relative opens reject symlinks; cleanup requires the same opened
//! inode and exact nonce. A replaced entry is unknown and is never removed.
use anyhow::{Result, ensure};
use std::path::Path;

#[cfg(unix)]
mod platform {
    use super::*;
    use std::{
        ffi::CString,
        fs::{File, OpenOptions},
        io::{Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
    };
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct Identity {
        dev: u64,
        ino: u64,
    }
    fn identity(file: &File) -> Result<Identity> {
        let metadata = file.metadata()?;
        ensure!(metadata.is_file(), "static_hls_probe_file_invalid");
        Ok(Identity {
            dev: metadata.dev(),
            ino: metadata.ino(),
        })
    }
    fn root(path: &Path) -> Result<File> {
        let dir = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        ensure!(dir.metadata()?.is_dir(), "static_hls_probe_cache_invalid");
        Ok(dir)
    }
    fn name(challenge: &str) -> Result<CString> {
        ensure!(
            challenge.len() == 36
                && challenge.bytes().enumerate().all(|(index, byte)| {
                    if [8, 13, 18, 23].contains(&index) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                    }
                }),
            "static_hls_probe_challenge_invalid"
        );
        Ok(CString::new(format!(".static-hls-probe-{challenge}"))?)
    }
    fn open(dir: &File, name: &CString, flags: i32) -> Result<File> {
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    fn nonce(file: &mut File) -> Result<[u8; 64]> {
        ensure!(
            file.metadata()?.len() == 64,
            "static_hls_probe_nonce_invalid"
        );
        let mut bytes = [0; 64];
        file.read_exact(&mut bytes)?;
        let mut extra = [0; 1];
        ensure!(
            file.read(&mut extra)? == 0,
            "static_hls_probe_nonce_invalid"
        );
        Ok(bytes)
    }

    pub struct OwnedProbe {
        directory: File,
        name: CString,
        opened: File,
        identity: Identity,
        nonce: [u8; 64],
    }
    impl OwnedProbe {
        pub fn create(cache: &Path, challenge: &str, bytes: [u8; 64]) -> Result<Self> {
            let directory = root(cache)?;
            let name = name(challenge)?;
            let opened = open(
                &directory,
                &name,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            )?;
            let identity = identity(&opened)?;
            Ok(Self {
                directory,
                name,
                opened,
                identity,
                nonce: bytes,
            })
        }
        pub fn write_nonce(&mut self) -> Result<()> {
            self.opened.write_all(&self.nonce)?;
            self.opened.sync_all()?;
            Ok(())
        }
        pub fn remove_owned(self) -> Result<()> {
            ensure!(
                identity(&self.opened)? == self.identity,
                "static_hls_probe_cleanup_unknown"
            );
            let mut current = open(&self.directory, &self.name, libc::O_RDONLY)
                .map_err(|_| anyhow::anyhow!("static_hls_probe_cleanup_unknown"))?;
            ensure!(
                identity(&current)? == self.identity,
                "static_hls_probe_cleanup_unknown"
            );
            ensure!(
                nonce(&mut current)? == self.nonce,
                "static_hls_probe_cleanup_unknown"
            );
            // Recheck basename identity immediately before descriptor-relative
            // unlink. The trusted cache has no concurrent cooperating rename.
            let mut entry: libc::stat = unsafe { std::mem::zeroed() };
            let status = unsafe {
                libc::fstatat(
                    self.directory.as_raw_fd(),
                    self.name.as_ptr(),
                    &mut entry,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            ensure!(
                status == 0
                    && entry.st_dev as u64 == self.identity.dev
                    && entry.st_ino as u64 == self.identity.ino,
                "static_hls_probe_cleanup_unknown"
            );
            let removed =
                unsafe { libc::unlinkat(self.directory.as_raw_fd(), self.name.as_ptr(), 0) };
            ensure!(removed == 0, "static_hls_probe_cleanup_unknown");
            Ok(())
        }
    }
    pub fn read(cache: &Path, challenge: &str) -> Result<[u8; 64]> {
        let directory = root(cache)?;
        let name = name(challenge)?;
        let mut opened = open(&directory, &name, libc::O_RDONLY)?;
        let original = identity(&opened)?;
        let mut entry: libc::stat = unsafe { std::mem::zeroed() };
        let status = unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name.as_ptr(),
                &mut entry,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        ensure!(
            status == 0
                && entry.st_dev as u64 == original.dev
                && entry.st_ino as u64 == original.ino,
            "static_hls_probe_file_changed"
        );
        let bytes = nonce(&mut opened)?;
        ensure!(
            identity(&opened)? == original,
            "static_hls_probe_file_changed"
        );
        Ok(bytes)
    }
}
#[cfg(unix)]
pub use platform::{OwnedProbe, read};

#[cfg(not(unix))]
pub struct OwnedProbe;
#[cfg(not(unix))]
impl OwnedProbe {
    pub fn create(_: &Path, _: &str, _: [u8; 64]) -> Result<Self> {
        anyhow::bail!("static_hls_probe_unsupported")
    }
    pub fn write_nonce(&mut self) -> Result<()> {
        anyhow::bail!("static_hls_probe_unsupported")
    }
    pub fn remove_owned(self) -> Result<()> {
        anyhow::bail!("static_hls_probe_unsupported")
    }
}
#[cfg(not(unix))]
pub fn read(_: &Path, _: &str) -> Result<[u8; 64]> {
    anyhow::bail!("static_hls_probe_unsupported")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    fn root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("owned-hls-probe-{}", uuid_for_fixture()));
        std::fs::create_dir(&root).unwrap();
        root
    }
    fn uuid_for_fixture() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    #[test]
    fn exact_fresh_nonce_is_read_and_only_its_owner_removes_it() {
        let root = root();
        let id = uuid_for_fixture();
        let mut owned = OwnedProbe::create(&root, &id, [7; 64]).unwrap();
        owned.write_nonce().unwrap();
        assert_eq!(read(&root, &id).unwrap(), [7; 64]);
        owned.remove_owned().unwrap();
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn replaced_basename_is_preserved_and_cleanup_stays_unknown() {
        let root = root();
        let id = uuid_for_fixture();
        let path = root.join(format!(".static-hls-probe-{id}"));
        let mut owned = OwnedProbe::create(&root, &id, [7; 64]).unwrap();
        owned.write_nonce().unwrap();
        std::fs::rename(&path, root.join("original-owned")).unwrap();
        std::fs::write(&path, [9; 64]).unwrap();
        assert!(owned.remove_owned().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), [9; 64]);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn symlink_and_same_inode_nonce_mutation_are_never_accepted() {
        let root = root();
        let id = uuid_for_fixture();
        let path = root.join(format!(".static-hls-probe-{id}"));
        let mut owned = OwnedProbe::create(&root, &id, [7; 64]).unwrap();
        owned.write_nonce().unwrap();
        std::fs::write(&path, [8; 64]).unwrap();
        assert!(owned.remove_owned().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), [8; 64]);
        std::fs::remove_file(&path).unwrap();
        std::fs::write(root.join("foreign"), [3; 64]).unwrap();
        symlink(root.join("foreign"), &path).unwrap();
        assert!(read(&root, &id).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
