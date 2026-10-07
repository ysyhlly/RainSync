use anyhow::{Result, ensure};
use std::{
    fs::File,
    path::{Path, PathBuf},
};

/// The original open local file remains in custody through child reaping.
/// Linux decoder/filter paths refer to its inherited descriptor, so a rename
/// cannot redirect libass's second container open to another file.
#[derive(Debug)]
pub struct OwnedLocalInput {
    file: File,
    snapshot: crate::file_version::Snapshot,
    path: PathBuf,
    remove_on_drop: bool,
}
impl OwnedLocalInput {
    pub fn byte_len(&self) -> Result<u64> {
        Ok(self.file.metadata()?.len())
    }

    /// A container's RPU-present flag does not prove that the decoder receives
    /// dynamic metadata. Check real decoded frames on the retained descriptor
    /// before a Dolby SDR preparation can reinterpret profile-5 pixel values.
    pub async fn verify_dolby_vision_rpu(&self, meta: &serde_json::Value) -> Result<()> {
        let selected = crate::motion_video::select(meta)?;
        if super::DolbyVisionSource::from_stream(selected.stream)?.is_none() {
            return Ok(());
        }
        let index = selected.stream["index"]
            .as_u64()
            .filter(|index| *index <= u32::MAX.into())
            .ok_or_else(|| anyhow::anyhow!("dolby_vision_stream_index_required"))?;
        let mut command = tokio::process::Command::new("ffprobe");
        crate::input_policy::clean_environment(&mut command);
        command.args(crate::input_policy::args(false, false));
        command.args([
            "-v",
            "error",
            "-show_frames",
            "-read_intervals",
            "%+#2",
            "-select_streams",
            &index.to_string(),
            "-show_entries",
            "frame=side_data_list",
            "-of",
            "json",
            &self.decoder_path()?,
        ]);
        command
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        self.install(&mut command)?;
        let (status, bytes) = crate::child_process::capture(
            command,
            std::time::Duration::from_secs(30),
            2 * 1024 * 1024,
        )
        .await?;
        ensure!(status.success(), "dolby_vision_rpu_probe_failed");
        let frames: serde_json::Value = serde_json::from_slice(&bytes)?;
        ensure!(
            frames["frames"]
                .as_array()
                .is_some_and(|frames| !frames.is_empty()
                    && frames
                        .iter()
                        .all(
                            |frame| frame["side_data_list"].as_array().is_some_and(|rows| rows
                                .iter()
                                .any(|side| side["side_data_type"] == "Dolby Vision RPU Data"
                                    && rows
                                        .iter()
                                        .any(|side| side["side_data_type"]
                                            == "Dolby Vision Metadata")))
                        )),
            "dolby_vision_rpu_missing"
        );
        self.verify()
    }
    pub fn duplicate_file(&self) -> Result<File> {
        Ok(self.file.try_clone()?)
    }
    pub fn open(root: &Path, resource: &str, expected_version: &str) -> Result<Self> {
        ensure!(
            crate::file_version::valid_file_version(expected_version),
            "advanced_media_source_version_required"
        );
        let path = crate::safe_local_path(root, resource)?;
        let file = crate::open_local_file(root, resource)?;
        let snapshot = crate::file_version::snapshot_file(&file)?;
        ensure!(snapshot.version == expected_version, "source_changed");
        Ok(Self {
            file,
            snapshot,
            path,
            remove_on_drop: false,
        })
    }
    /// Only caller-created finite materializations may use this constructor.
    /// The file remains retained and is removed after its owning preparation
    /// and positively reaped decoder release it.
    pub fn materialized(file: File, path: PathBuf) -> Result<Self> {
        ensure!(
            path.is_absolute() && file.metadata()?.is_file(),
            "advanced_media_materialized_input_invalid"
        );
        let snapshot = crate::file_version::snapshot_file(&file)?;
        let owner = Self {
            file,
            snapshot,
            path,
            remove_on_drop: true,
        };
        owner.verify()?;
        Ok(owner)
    }
    /// A durable capture owner performs explicit positive file disposal after
    /// every borrowed descriptor drains. Drop alone must not release its budget.
    pub fn materialized_retained(file: File, path: PathBuf) -> Result<Self> {
        let mut owner = Self::materialized(file, path)?;
        owner.remove_on_drop = false;
        Ok(owner)
    }
    pub fn verify(&self) -> Result<()> {
        ensure!(
            crate::file_version::snapshot_file(&self.file)? == self.snapshot,
            "source_changed"
        );
        // Compare both retained handle and current path. Replacing the path is
        // source change even though decoding remains tied to the old inode.
        let current = File::open(&self.path)?;
        ensure!(
            crate::file_version::snapshot_file(&current)? == self.snapshot,
            "source_changed"
        );
        Ok(())
    }
    pub fn version(&self) -> &str {
        &self.snapshot.version
    }
    pub fn decoder_path(&self) -> Result<String> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            Ok(format!("/proc/self/fd/{}", self.file.as_raw_fd()))
        }
        #[cfg(not(target_os = "linux"))]
        self.path
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow::anyhow!("advanced_media_path_invalid"))
    }
    pub fn install(&self, command: &mut tokio::process::Command) -> Result<()> {
        self.verify()?;
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            let fd = self.file.as_raw_fd();
            ensure!(fd >= 3, "advanced_media_descriptor_invalid");
            // pre_exec performs only async-signal-safe fcntl operations. The
            // parent retains CLOEXEC; unrelated children cannot inherit input.
            unsafe {
                command.pre_exec(move || {
                    let flags = libc::fcntl(fd, libc::F_GETFD);
                    if flags == -1
                        || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) == -1
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        Ok(())
    }
}
impl Drop for OwnedLocalInput {
    fn drop(&mut self) {
        if self.remove_on_drop {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Only the existing loopback, job-bound Worker source gateway is accepted.
#[derive(Debug)]
pub struct WorkerGatewayInput(String);
impl WorkerGatewayInput {
    /// Purpose-separated native finite ingress. The legacy constructor stays
    /// unchanged, so a platform marker cannot become a generic source input.
    pub fn native_platform(value: &str) -> Result<Self> {
        let url = url::Url::parse(value)?;
        ensure!(
            url.scheme() == "http"
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
                && url.port().is_some()
                && url
                    .host_str()
                    .and_then(|h| h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().ok())
                    .is_some_and(|ip| ip.is_loopback()),
            "native_platform_gateway_invalid"
        );
        let uuid = |v: &str| {
            v.len() == 36
                && v.bytes().enumerate().all(|(i, b)| {
                    if [8, 13, 18, 23].contains(&i) {
                        b == b'-'
                    } else {
                        b.is_ascii_hexdigit()
                    }
                })
        };
        let p = url
            .path_segments()
            .ok_or_else(|| anyhow::anyhow!("native_platform_gateway_invalid"))?
            .collect::<Vec<_>>();
        ensure!(
            p.len() == 3
                && p[0] == "native-platform-input"
                && uuid(p[1])
                && matches!(p[2], "progressive" | "video" | "audio"),
            "native_platform_gateway_invalid"
        );
        let q = url.query_pairs().collect::<Vec<_>>();
        ensure!(
            q.len() == 4
                && ["ticket", "owner", "attempt", "execution"].iter().all(|n| q
                    .iter()
                    .filter(|(k, _)| k == n)
                    .count()
                    == 1),
            "native_platform_gateway_invalid"
        );
        for (k, v) in q {
            ensure!(
                match k.as_ref() {
                    "ticket" =>
                        v.len() == 64
                            && v.bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                    "owner" | "execution" => uuid(&v),
                    "attempt" => v.parse::<i64>().is_ok_and(|a| a > 0),
                    _ => false,
                },
                "native_platform_gateway_invalid"
            );
        }
        Ok(Self(value.into()))
    }
    /// Asset ingress is the same job/execution-scoped loopback source gateway,
    /// with only a finite numeric catalog ordinal in the path.
    pub fn asset(value: &str) -> Result<Self> {
        let mut url = url::Url::parse(value)?;
        let segments = url
            .path_segments()
            .ok_or_else(|| anyhow::anyhow!("advanced_media_gateway_invalid"))?
            .collect::<Vec<_>>();
        ensure!(
            segments.len() == 3
                && segments[2]
                    .strip_prefix("asset-")
                    .is_some_and(|v| !v.is_empty()
                        && v.bytes().all(|b| b.is_ascii_digit())
                        && v.parse::<u8>().is_ok_and(|v| v < 67)),
            "advanced_media_gateway_invalid"
        );
        let source = format!("/{}/{}/source", segments[0], segments[1]);
        url.set_path(&source);
        Self::new(url.as_str())?;
        Ok(Self(value.into()))
    }
    pub fn new(value: &str) -> Result<Self> {
        let url = url::Url::parse(value)?;
        ensure!(
            url.scheme() == "http"
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none(),
            "advanced_media_gateway_invalid"
        );
        let loopback = url
            .host_str()
            .and_then(|host| {
                host.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .ok()
            })
            .is_some_and(|ip| ip.is_loopback());
        ensure!(
            loopback && url.port().is_some(),
            "advanced_media_gateway_invalid"
        );
        let segments: Vec<_> = url
            .path_segments()
            .ok_or_else(|| anyhow::anyhow!("advanced_media_gateway_invalid"))?
            .collect();
        ensure!(
            segments.len() == 3
                && segments[0] == "media-delivery"
                && segments[2] == "source"
                && segments[1].len() == 36
                && segments[1]
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() || c == b'-'),
            "advanced_media_gateway_invalid"
        );
        let query: Vec<_> = url.query_pairs().collect();
        ensure!(
            query.len() == 2
                && query.iter().all(
                    |(name, value)| matches!(name.as_ref(), "token" | "execution")
                        && !value.is_empty()
                )
                && query.iter().filter(|(name, _)| name == "token").count() == 1
                && query.iter().filter(|(name, _)| name == "execution").count() == 1,
            "advanced_media_gateway_invalid"
        );
        Ok(Self(value.to_owned()))
    }
}
pub enum Input<'a> {
    OwnedLocal(&'a OwnedLocalInput),
    WorkerGateway(&'a WorkerGatewayInput),
}
impl Input<'_> {
    pub(crate) fn path(&self) -> Result<String> {
        match self {
            Self::OwnedLocal(local) => local.decoder_path(),
            Self::WorkerGateway(proxy) => Ok(proxy.0.clone()),
        }
    }
    pub(crate) fn network(&self) -> bool {
        matches!(self, Self::WorkerGateway(_))
    }
    pub(super) fn subtitle_descriptor(&self) -> Result<String> {
        ensure!(
            cfg!(target_os = "linux"),
            "subtitle_burn_in_platform_unsupported"
        );
        match self {
            Self::OwnedLocal(local) => local.decoder_path(),
            _ => anyhow::bail!("subtitle_burn_in_owned_input_required"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_input_retains_original_descriptor_but_detects_replacement() {
        let root =
            std::env::temp_dir().join(format!("advanced-media-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("source.mkv");
        std::fs::write(&path, b"original").unwrap();
        let version = crate::file_version::snapshot_file(&File::open(&path).unwrap())
            .unwrap()
            .version;
        let owner = OwnedLocalInput::open(&root, "source.mkv", &version).unwrap();
        owner.verify().unwrap();
        #[cfg(target_os = "linux")]
        assert_eq!(
            std::fs::read(owner.decoder_path().unwrap()).unwrap(),
            b"original"
        );
        #[cfg(windows)]
        {
            let error = std::fs::rename(&path, root.join("original.mkv")).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
            owner.verify().unwrap();
            drop(owner);
            std::fs::rename(&path, root.join("original.mkv")).unwrap();
        }
        #[cfg(not(windows))]
        {
            std::fs::rename(&path, root.join("original.mkv")).unwrap();
            std::fs::write(&path, b"replaced").unwrap();
            assert!(owner.verify().is_err());
            #[cfg(target_os = "linux")]
            assert_eq!(
                std::fs::read(owner.decoder_path().unwrap()).unwrap(),
                b"original"
            );
            drop(owner);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn arbitrary_network_or_filter_paths_cannot_become_inputs() {
        let id = "00000000-0000-0000-0000-000000000000";
        assert!(
            WorkerGatewayInput::new(&format!(
                "http://127.0.0.1:8081/media-delivery/{id}/source?token=x&execution=y"
            ))
            .is_ok()
        );
        for bad in [
            "https://evil.example/input",
            "http://127.0.0.1:8081/other?token=x&execution=y",
            "http://127.0.0.1:8081/media-delivery/x/source?token=x&execution=y",
            "file:/etc/passwd",
        ] {
            assert!(WorkerGatewayInput::new(bad).is_err());
        }
    }
    #[test]
    fn native_gateway_is_separate_and_loopback_attempt_bound() {
        let id = "00000000-0000-0000-0000-000000000000";
        let url = format!(
            "http://127.0.0.1:8081/native-platform-input/{id}/video?ticket={}&owner={id}&attempt=2&execution={id}",
            "a".repeat(64)
        );
        assert!(WorkerGatewayInput::native_platform(&url).is_ok());
        assert!(WorkerGatewayInput::new(&url).is_err());
        for bad in [
            url.replace("127.0.0.1", "192.0.2.1"),
            url.replace("attempt=2", "attempt=0"),
            format!("{url}&url=https://example.invalid/x"),
            url.replace("/video?", "/live?"),
            url.replace("owner=00000000", "owner=zzzzzzzz"),
        ] {
            assert!(WorkerGatewayInput::native_platform(&bad).is_err());
        }
    }
}
