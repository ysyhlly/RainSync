//! Request-only secret file custody. Logical truncation/unlink is not a claim
//! of physical storage erasure or an OS sandbox for the trusted extractor.
use super::*;
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) struct SecretFile {
    file: File,
    path: PathBuf,
    device: u64,
    inode: u64,
    disposed: bool,
}
impl SecretFile {
    pub(crate) fn create(private_dir: &Path, credential: &Credential) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
            let metadata =
                std::fs::symlink_metadata(private_dir).map_err(|_| Error::ProcessCleanupFailed)?;
            if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
                return Err(Error::InvalidConfiguration);
            }
            let path = private_dir.join("viewer-session.cookies");
            // create_new refuses existing files and symlinks; the directory was
            // atomically created 0700 by the process owner, never user-selected.
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .map_err(|_| Error::ProcessCleanupFailed)?;
            let metadata = file.metadata().map_err(|_| Error::ProcessCleanupFailed)?;
            let mut owned = Self {
                file,
                path,
                device: metadata.dev(),
                inode: metadata.ino(),
                disposed: false,
            };
            if owned
                .file
                .write_all(credential.expose_for_storage().as_bytes())
                .is_err()
                || owned.file.flush().is_err()
            {
                let _ = owned.dispose();
                return Err(Error::ProcessCleanupFailed);
            }
            Ok(owned)
        }
        #[cfg(not(unix))]
        {
            let _ = (private_dir, credential);
            Err(Error::ProviderUnavailable)
        }
    }
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn dispose(&mut self) -> Result<()> {
        if self.disposed {
            return Ok(());
        }
        // The retained FD identifies the original inode even if the trusted
        // process renamed the path. Never truncate a substituted path.
        self.file
            .set_len(0)
            .map_err(|_| Error::ProcessCleanupFailed)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            match std::fs::symlink_metadata(&self.path) {
                Ok(metadata)
                    if metadata.is_file()
                        && metadata.dev() == self.device
                        && metadata.ino() == self.inode =>
                {
                    std::fs::remove_file(&self.path).map_err(|_| Error::ProcessCleanupFailed)?
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(Error::ProcessCleanupFailed),
            }
        }
        #[cfg(not(unix))]
        return Err(Error::ProcessCleanupFailed);
        self.disposed = true;
        Ok(())
    }
}
impl Drop for SecretFile {
    fn drop(&mut self) {
        let _ = self.dispose();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::platform::youtube::process::ScratchDir;
    use std::os::unix::fs::PermissionsExt;
    fn credential() -> Credential {
        Credential::parse("# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsynthetic-session-only\n.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tsynthetic-login-only\n", 100).unwrap()
    }
    #[test]
    fn custody_is_private_and_removed_on_explicit_cleanup_and_early_drop() {
        let mut scratch = ScratchDir::create().unwrap();
        let mut secret = SecretFile::create(scratch.path(), &credential()).unwrap();
        let path = secret.path().to_owned();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("synthetic-session-only")
        );
        secret.dispose().unwrap();
        assert!(!path.exists());
        let secret = SecretFile::create(scratch.path(), &credential()).unwrap();
        drop(secret);
        assert!(!path.exists());
        scratch.dispose().unwrap();
    }
    #[test]
    fn replacing_path_cannot_truncate_an_unrelated_file_and_original_inode_is_cleared() {
        let mut scratch = ScratchDir::create().unwrap();
        let mut secret = SecretFile::create(scratch.path(), &credential()).unwrap();
        let renamed = scratch.path().join("moved.cookies");
        std::fs::rename(secret.path(), &renamed).unwrap();
        std::fs::write(secret.path(), b"unrelated").unwrap();
        assert!(secret.dispose().is_err());
        assert_eq!(std::fs::read(&renamed).unwrap(), b"");
        assert_eq!(std::fs::read(secret.path()).unwrap(), b"unrelated");
        drop(secret);
        scratch.dispose().unwrap();
    }
    #[test]
    fn no_existing_path_or_unprotected_directory_can_receive_credentials() {
        let mut scratch = ScratchDir::create().unwrap();
        let path = scratch.path().join("viewer-session.cookies");
        std::fs::write(&path, b"existing").unwrap();
        assert!(SecretFile::create(scratch.path(), &credential()).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::set_permissions(scratch.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(SecretFile::create(scratch.path(), &credential()).is_err());
        std::fs::set_permissions(scratch.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        scratch.dispose().unwrap();
    }
}
