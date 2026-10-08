use super::account::custody::SecretFile;
use super::{
    Config, Credential, Error, MAX_JSON_BYTES, MAX_STDERR_BYTES, QualityLimit, REFERER, Result,
    SelectionMode, USER_AGENT, VideoRef,
};
use media_core::child_process::{self, Child};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::{Semaphore, oneshot},
    time::Instant,
};

// '+' describes two selected formats only. --simulate is mandatory: no media
// downloader or FFmpeg merger is ever admitted by this metadata boundary.
pub(super) const FORMAT_SELECTOR: &str = concat!(
    "bestvideo[ext=mp4][protocol=https][vcodec^=avc1.][acodec=none]",
    "[width>0][width<=8192][height>0][height<=4320][fps>0][fps<=120][tbr>0][tbr<=80000]",
    "+bestaudio[ext=m4a][protocol=https][vcodec=none][acodec=mp4a.40.2]",
    "[asr>=8000][asr<=96000][audio_channels>=1][audio_channels<=2][tbr>0][tbr<=512]",
    "/best[ext=mp4][protocol=https][vcodec^=avc1.][acodec=mp4a.40.2]",
);
pub(super) const PROGRESSIVE_FORMAT_SELECTOR: &str =
    "best[ext=mp4][protocol=https][vcodec^=avc1.][acodec=mp4a.40.2]";

// Fixed compatibility selector. Decoder qualification remains a separate gate.
pub(super) const COMPATIBILITY_FORMAT_SELECTOR: &str = concat!(
    r"bestvideo[ext~='^(mp4|webm)$'][protocol=https][acodec=none][vcodec~='^(avc1\.|av01\.|vp09\.|vp9(\.2)?$|av1$|hvc1\.2\.|hev1\.2\.)']",
    "[width>0][width<=8192][height>0][height<=4320][fps>0][fps<=120][tbr>0][tbr<=80000]",
    "+bestaudio[ext=m4a][protocol=https][vcodec=none][acodec=mp4a.40.2]",
    "[asr>=8000][asr<=96000][audio_channels>=1][audio_channels<=2][tbr>0][tbr<=512]"
);
pub(super) fn format_selector(mode: SelectionMode, quality: QualityLimit) -> String {
    let selector = match mode {
        SelectionMode::PreferAdaptive => FORMAT_SELECTOR,
        SelectionMode::ProgressiveOnly => PROGRESSIVE_FORMAT_SELECTOR,
        SelectionMode::CompatibilityAdaptive => COMPATIBILITY_FORMAT_SELECTOR,
    };
    let Some(height) = quality.height() else {
        return selector.into();
    };
    // Both branches obey the ceiling; the fallback cannot escape it.
    let selector = selector.replace("[height<=4320]", &format!("[height<={height}]"));
    if mode == SelectionMode::CompatibilityAdaptive {
        return selector;
    }
    format!("{selector}[height>0][height<={height}]")
}

pub(super) fn trusted_executable(path: PathBuf) -> Result<PathBuf> {
    if !path.is_absolute() || path.as_os_str().is_empty() {
        return Err(Error::InvalidConfiguration);
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| Error::InvalidConfiguration)?;
    let metadata = std::fs::metadata(&canonical).map_err(|_| Error::InvalidConfiguration)?;
    if !metadata.is_file() {
        return Err(Error::InvalidConfiguration);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        if mode & 0o111 == 0 || mode & 0o022 != 0 {
            return Err(Error::InvalidConfiguration);
        }
    }
    // This initial adapter deliberately requires POSIX private directory modes.
    // Windows needs an audited private ACL setup before it can opt in.
    #[cfg(not(unix))]
    return Err(Error::ProviderUnavailable);
    #[cfg(unix)]
    Ok(canonical)
}

pub(super) struct ScratchDir {
    path: PathBuf,
    device: u64,
    inode: u64,
    disposed: bool,
    preserve: bool,
}
impl ScratchDir {
    pub(super) fn create() -> Result<Self> {
        #[cfg(unix)]
        {
            use std::{
                os::unix::fs::DirBuilderExt,
                sync::atomic::{AtomicU64, Ordering},
            };
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| Error::ProviderUnavailable)?
                .as_nanos();
            for _ in 0..8 {
                // Atomic 0700 creation: a preexisting file/symlink is never used.
                let path = std::env::temp_dir().join(format!(
                    "rainsync-youtube-{}-{time}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                let mut builder = std::fs::DirBuilder::new();
                builder.mode(0o700);
                match builder.create(&path) {
                    Ok(()) => {
                        use std::os::unix::fs::MetadataExt;
                        let metadata = std::fs::symlink_metadata(&path)
                            .map_err(|_| Error::ProcessCleanupFailed)?;
                        return Ok(Self {
                            path,
                            device: metadata.dev(),
                            inode: metadata.ino(),
                            disposed: false,
                            preserve: false,
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(_) => return Err(Error::ProviderUnavailable),
                }
            }
        }
        Err(Error::ProviderUnavailable)
    }
    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    fn still_owned(&self) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            std::fs::symlink_metadata(&self.path).is_ok_and(|metadata| {
                metadata.is_dir() && metadata.dev() == self.device && metadata.ino() == self.inode
            })
        }
        #[cfg(not(unix))]
        {
            let _ = (self.device, self.inode);
            false
        }
    }

    /// Called only after positive process-tree reap (or no successful spawn).
    /// Inspect at most 4096 entries / 16 levels without following symlinks, then
    /// remove only the originally-owned private root. Refuse any changed root.
    pub(super) fn dispose(&mut self) -> Result<()> {
        if self.disposed {
            return Ok(());
        }
        if !self.still_owned() {
            return Err(Error::ProcessCleanupFailed);
        }
        fn check(path: &Path, depth: usize, remaining: &mut usize) -> Result<()> {
            if depth > 16 {
                return Err(Error::ProcessCleanupFailed);
            }
            let entries = std::fs::read_dir(path).map_err(|_| Error::ProcessCleanupFailed)?;
            for entry in entries {
                if *remaining == 0 {
                    return Err(Error::ProcessCleanupFailed);
                }
                *remaining -= 1;
                let entry = entry.map_err(|_| Error::ProcessCleanupFailed)?;
                let metadata = std::fs::symlink_metadata(entry.path())
                    .map_err(|_| Error::ProcessCleanupFailed)?;
                if metadata.is_dir() {
                    check(&entry.path(), depth + 1, remaining)?;
                }
            }
            Ok(())
        }
        check(&self.path, 0, &mut 4096)?;
        if !self.still_owned() {
            return Err(Error::ProcessCleanupFailed);
        }
        std::fs::remove_dir_all(&self.path).map_err(|_| Error::ProcessCleanupFailed)?;
        self.disposed = true;
        Ok(())
    }
}
impl Drop for ScratchDir {
    fn drop(&mut self) {
        // Explicit disposal reports failures. Drop is only best-effort empty
        // directory fallback, never an unbounded silent recursive traversal.
        if !self.disposed && !self.preserve && self.still_owned() {
            let _ = std::fs::remove_dir(&self.path);
        }
    }
}

#[cfg(test)]
pub(super) fn command(
    config: &Config,
    reference: &VideoRef,
    mode: SelectionMode,
    cwd: &Path,
) -> Result<Command> {
    command_with_quality(config, reference, mode, QualityLimit::Auto, cwd)
}
#[cfg(test)]
pub(super) fn command_with_quality(
    config: &Config,
    reference: &VideoRef,
    mode: SelectionMode,
    quality: QualityLimit,
    cwd: &Path,
) -> Result<Command> {
    command_with_account(config, reference, mode, quality, cwd, None)
}
fn command_with_account(
    config: &Config,
    reference: &VideoRef,
    mode: SelectionMode,
    quality: QualityLimit,
    cwd: &Path,
    secret: Option<&SecretFile>,
) -> Result<Command> {
    let mut command = metadata_command(config, cwd, secret)?;
    command.args([
        "--no-playlist",
        "--use-extractors",
        "youtube",
        "--extractor-args",
        "youtube:skip=hls,dash,translated_subs",
        "--format",
        &format_selector(mode, quality),
    ]);
    if let Some(deno) = &config.deno {
        // The path is canonical trusted administrator config, never user input.
        let mut runtime = std::ffi::OsString::from("deno:");
        runtime.push(deno);
        command.arg("--js-runtimes").arg(runtime);
    }
    command.arg("--").arg(reference.canonical());
    Ok(command)
}

// Shared custody/environment boundary for both video and flat-playlist modes.
// Mode-specific extractor names, URLs and flags are closed in their builders.
fn metadata_command(config: &Config, cwd: &Path, secret: Option<&SecretFile>) -> Result<Command> {
    if secret.is_some() && !config.viewer_credentials {
        return Err(Error::ProviderUnavailable);
    }
    let binary = config.binary.as_ref().ok_or(Error::ProviderUnavailable)?;
    let mut command = Command::new(binary);
    command
        .env_clear()
        .env("PATH", "")
        .env("HOME", cwd)
        .env("XDG_CONFIG_HOME", cwd)
        .env("XDG_CACHE_HOME", cwd)
        .env("TMPDIR", cwd)
        .env("DENO_DIR", cwd.join("deno-cache"))
        .env("DENO_NO_UPDATE_CHECK", "1")
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONSAFEPATH", "1")
        .env("PYTHONUTF8", "1")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("NO_COLOR", "1")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Fixed argument vector. Neither this API nor Config accepts custom flags.
    command.args([
        "--ignore-config",
        "--no-config-locations",
        "--no-plugin-dirs",
        "--no-cache-dir",
        "--no-update",
        "--no-cookies-from-browser",
        "--no-js-runtimes",
        "--no-remote-components",
        "--simulate",
        "--dump-single-json",
        "--quiet",
        "--no-warnings",
        "--no-progress",
        "--no-mark-watched",
        "--no-check-formats",
        "--socket-timeout",
        "10",
        "--retries",
        "0",
        "--extractor-retries",
        "0",
        "--proxy",
        "",
        "--user-agent",
        USER_AGENT,
        "--referer",
        REFERER,
        "--add-headers",
        "Accept:*/*",
        "--add-headers",
        "Accept-Language:en-US,en;q=0.5",
        "--add-headers",
        "Accept-Encoding:identity",
    ]);
    if let Some(secret) = secret {
        // Only a server-owned request-private path enters argv. Cookie contents
        // never enter arguments, environment, headers or diagnostic output.
        command.arg("--cookies").arg(secret.path());
    } else {
        command.arg("--no-cookies");
    }
    Ok(command)
}

fn playlist_page_command(
    config: &Config,
    reference: &super::playlist::PlaylistRef,
    page: super::playlist::Page,
    cwd: &Path,
    secret: Option<&SecretFile>,
) -> Result<Command> {
    let mut command = metadata_command(config, cwd, secret)?;
    let range = page.range()?;
    command.args([
        "--yes-playlist",
        "--flat-playlist",
        "--lazy-playlist",
        "--playlist-items",
        &range,
        "--use-extractors",
        "youtube:tab,youtube:playlist",
        "--compat-options",
        "no-youtube-unavailable-videos,no-youtube-channel-redirect",
    ]);
    command.arg("--").arg(reference.canonical());
    Ok(command)
}

fn playlist_command(
    config: &Config,
    reference: &super::playlist::PlaylistRef,
    cwd: &Path,
    secret: Option<&SecretFile>,
) -> Result<Command> {
    let mut command = metadata_command(config, cwd, secret)?;
    // Flat + lazy enumeration cannot resolve child videos or eagerly crawl the
    // whole playlist. The one sentinel identifies truncation, never import.
    // https://github.com/yt-dlp/yt-dlp/blob/51bab8a0116f4d8004c315706d809782607d5847/README.md
    command.args([
        "--yes-playlist",
        "--flat-playlist",
        "--lazy-playlist",
        "--playlist-items",
        "1:21",
        "--use-extractors",
        "youtube:tab,youtube:playlist",
        "--compat-options",
        "no-youtube-unavailable-videos,no-youtube-channel-redirect",
    ]);
    command.arg("--").arg(reference.canonical());
    Ok(command)
}

pub(super) async fn extract_playlist_page(
    config: &Config,
    reference: &super::playlist::PlaylistRef,
    page: super::playlist::Page,
    credential: Option<&Credential>,
    deadline: Instant,
    slots: Arc<Semaphore>,
) -> Result<Vec<u8>> {
    page.validate()?;
    let permit = tokio::time::timeout_at(deadline, slots.acquire_owned())
        .await
        .map_err(|_| Error::Deadline)?
        .map_err(|_| Error::ProviderUnavailable)?;
    if Instant::now() >= deadline {
        return Err(Error::Deadline);
    }
    let scratch = ScratchDir::create()?;
    let secret = credential
        .map(|c| SecretFile::create(scratch.path(), c))
        .transpose()?;
    let command = playlist_page_command(config, reference, page, scratch.path(), secret.as_ref())?;
    supervise_extraction(command, scratch, secret, deadline, permit).await
}

pub(super) async fn extract_live(
    config: &Config,
    reference: &VideoRef,
    credential: Option<&Credential>,
    deadline: Instant,
    slots: Arc<Semaphore>,
) -> Result<Vec<u8>> {
    if !config.live_enabled {
        return Err(Error::ProviderUnavailable);
    }
    let permit = tokio::time::timeout_at(deadline, slots.acquire_owned())
        .await
        .map_err(|_| Error::Deadline)?
        .map_err(|_| Error::ProviderUnavailable)?;
    if Instant::now() >= deadline {
        return Err(Error::Deadline);
    }
    let scratch = ScratchDir::create()?;
    let secret = credential
        .map(|c| SecretFile::create(scratch.path(), c))
        .transpose()?;
    let mut command = metadata_command(config, scratch.path(), secret.as_ref())?;
    command.args([
        "--no-playlist",
        "--use-extractors",
        "youtube",
        "--extractor-args",
        "youtube:skip=dash,translated_subs;player_skip=js;fetch_pot=never",
        "--no-live-from-start",
        "--format",
        "best[protocol=m3u8_native][vcodec^=avc1.][acodec=mp4a.40.2][height<=1080]",
    ]);
    command.arg("--").arg(reference.canonical());
    // No Deno/remote component even when ordinary VOD enabled one separately.
    supervise_extraction(command, scratch, secret, deadline, permit).await
}

pub(super) async fn extract_playlist(
    config: &Config,
    reference: &super::playlist::PlaylistRef,
    credential: Option<&Credential>,
    deadline: Instant,
    slots: Arc<Semaphore>,
) -> Result<Vec<u8>> {
    let permit = tokio::time::timeout_at(deadline, slots.acquire_owned())
        .await
        .map_err(|_| Error::Deadline)?
        .map_err(|_| Error::ProviderUnavailable)?;
    if Instant::now() >= deadline {
        return Err(Error::Deadline);
    }
    let scratch = ScratchDir::create()?;
    let secret = credential
        .map(|credential| SecretFile::create(scratch.path(), credential))
        .transpose()?;
    let command = playlist_command(config, reference, scratch.path(), secret.as_ref())?;
    if Instant::now() >= deadline {
        return Err(Error::Deadline);
    }
    // Identical owned cancellation, cap, reap and private-cookie erasure path.
    supervise_extraction(command, scratch, secret, deadline, permit).await
}

pub(super) async fn extract(
    config: &Config,
    reference: &VideoRef,
    mode: SelectionMode,
    deadline: Instant,
    slots: Arc<Semaphore>,
) -> Result<Vec<u8>> {
    extract_with_quality(config, reference, mode, QualityLimit::Auto, deadline, slots).await
}
pub(super) async fn extract_with_quality(
    config: &Config,
    reference: &VideoRef,
    mode: SelectionMode,
    quality: QualityLimit,
    deadline: Instant,
    slots: Arc<Semaphore>,
) -> Result<Vec<u8>> {
    extract_with_account(config, reference, mode, quality, None, deadline, slots).await
}
pub(super) async fn extract_authenticated(
    config: &Config,
    reference: &VideoRef,
    mode: SelectionMode,
    quality: QualityLimit,
    credential: &Credential,
    deadline: Instant,
    slots: Arc<Semaphore>,
) -> Result<Vec<u8>> {
    if !config.viewer_credentials {
        return Err(Error::ProviderUnavailable);
    }
    extract_with_account(
        config,
        reference,
        mode,
        quality,
        Some(credential),
        deadline,
        slots,
    )
    .await
}
async fn extract_with_account(
    config: &Config,
    reference: &VideoRef,
    mode: SelectionMode,
    quality: QualityLimit,
    credential: Option<&Credential>,
    deadline: Instant,
    slots: Arc<Semaphore>,
) -> Result<Vec<u8>> {
    let permit = tokio::time::timeout_at(deadline, slots.acquire_owned())
        .await
        .map_err(|_| Error::Deadline)?
        .map_err(|_| Error::ProviderUnavailable)?;
    if Instant::now() >= deadline {
        return Err(Error::Deadline);
    }
    let scratch = ScratchDir::create()?;
    let secret = credential
        .map(|credential| SecretFile::create(scratch.path(), credential))
        .transpose()?;
    let command = command_with_account(
        config,
        reference,
        mode,
        quality,
        scratch.path(),
        secret.as_ref(),
    )?;
    if Instant::now() >= deadline {
        return Err(Error::Deadline);
    }
    supervise_extraction(command, scratch, secret, deadline, permit).await
}
async fn supervise_extraction(
    command: Command,
    mut scratch: ScratchDir,
    mut secret: Option<SecretFile>,
    deadline: Instant,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<Vec<u8>> {
    let (send, receive) = oneshot::channel();
    // Register the capture owner's completion in the caller's retained Scope
    // BEFORE admitting the process, then spawn under the inherited Scope.
    // Closing between these steps either drains both owners or rejects spawn.
    child_process::supervise(async move {
        let mut send = send;
        let mut result = if send.is_closed() {
            Err(Error::Cancelled)
        } else if Instant::now() >= deadline {
            Err(Error::Deadline)
        } else {
            match child_process::spawn(command) {
                Ok(child) => capture(child, deadline, &mut send).await,
                Err(_) => Err(Error::ProviderUnavailable),
            }
        };
        // Admission and private cwd remain owned until positive process-tree
        // reap, even after the public future/receiver has been dropped.
        let mut cleanup_failed = matches!(result, Err(Error::ProcessCleanupFailed));
        // Unknown process-tree cleanup cannot justify deleting its working dir.
        // Truncate the retained original secret inode even on failed tree reap;
        // keeping diagnostic cwd must not retain the viewer's cookie file.
        if secret
            .as_mut()
            .is_some_and(|secret| secret.dispose().is_err())
        {
            result = Err(Error::ProcessCleanupFailed);
            cleanup_failed = true;
        }
        drop(secret);
        if !cleanup_failed && scratch.dispose().is_err() {
            result = Err(Error::ProcessCleanupFailed);
            cleanup_failed = true;
        }
        // Failed/unknown disposal stays intact for diagnosis. In particular,
        // Drop must not remove even an empty cwd while tree reap is unknown.
        scratch.preserve = cleanup_failed;
        if cleanup_failed {
            permit.forget();
        } else {
            drop(permit);
        }
        drop(scratch);
        let _ = send.send(result);
        if cleanup_failed {
            // Checked owner receipts preserve this failure even when the public
            // waiter was cancelled, preventing a false successful Scope drain.
            Err(std::io::Error::other("youtube_process_cleanup_failed"))
        } else {
            Ok(())
        }
    })
    .map_err(|_| Error::ProviderUnavailable)?;
    receive.await.map_err(|_| Error::ProcessCleanupFailed)?
}

pub(super) async fn capture(
    mut child: Child,
    deadline: Instant,
    send: &mut oneshot::Sender<Result<Vec<u8>>>,
) -> Result<Vec<u8>> {
    let stdout = child.stdout.take().ok_or(Error::ExtractorFailed);
    let stderr = child.stderr.take().ok_or(Error::ExtractorFailed);
    let result = match (stdout, stderr) {
        (Ok(stdout), Ok(stderr)) => {
            tokio::select! {
                biased;
                _ = send.closed() => Err(Error::Cancelled),
                _ = tokio::time::sleep_until(deadline) => Err(Error::Deadline),
                result = async {
                    let (bytes, ()) = tokio::try_join!(read_stdout(stdout), discard_stderr(stderr))?;
                    let status = child.wait().await.map_err(|_| Error::ProcessCleanupFailed)?;
                    if status.success() { Ok(bytes) } else { Err(Error::ExtractorFailed) }
                } => result,
            }
        }
        _ => Err(Error::ExtractorFailed),
    };
    if result.is_err() {
        // Kill is an instruction followed by a real process-tree wait. Cleanup
        // is not cancelled at the extraction deadline and no reap is invented.
        child
            .kill()
            .await
            .map_err(|_| Error::ProcessCleanupFailed)?;
    }
    result
}

async fn read_stdout(mut stdout: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = stdout
            .read(&mut buffer)
            .await
            .map_err(|_| Error::ExtractorFailed)?;
        if read == 0 {
            return Ok(bytes);
        }
        if bytes.len().saturating_add(read) > MAX_JSON_BYTES {
            return Err(Error::TooLarge);
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
}

async fn discard_stderr(mut stderr: impl AsyncRead + Unpin) -> Result<()> {
    let mut count = 0usize;
    let mut buffer = [0u8; 1024];
    loop {
        let read = stderr
            .read(&mut buffer)
            .await
            .map_err(|_| Error::ExtractorFailed)?;
        if read == 0 {
            return Ok(());
        }
        count = count.saturating_add(read);
        // Diagnostic bytes are never retained or interpreted, even on failure.
        if count > MAX_STDERR_BYTES {
            return Err(Error::TooLarge);
        }
    }
}

#[cfg(all(test, unix))]
mod account_tests {
    use super::*;
    use std::time::Duration;

    fn credential() -> Credential {
        Credential::parse("# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsynthetic-session-only\n.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tsynthetic-login-only\n", 100).unwrap()
    }
    #[test]
    fn playlist_command_is_fixed_bounded_flat_metadata_with_same_private_custody() {
        let config = Config::opt_in_absolute(std::env::current_exe().unwrap())
            .unwrap()
            .with_viewer_credentials()
            .unwrap();
        let reference = super::super::playlist::parse_resource("PLBB231211A4F62143").unwrap();
        let mut scratch = ScratchDir::create().unwrap();
        let mut secret = SecretFile::create(scratch.path(), &credential()).unwrap();
        for cookies in [None, Some(&secret)] {
            let command = playlist_command(&config, &reference, scratch.path(), cookies).unwrap();
            let args = command
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            for flag in [
                "--simulate",
                "--dump-single-json",
                "--flat-playlist",
                "--lazy-playlist",
                "--ignore-config",
                "--no-plugin-dirs",
                "--no-update",
                "--no-cookies-from-browser",
                "--no-js-runtimes",
                "--no-remote-components",
                "--no-mark-watched",
            ] {
                assert!(args.contains(&flag.to_owned()), "{flag}");
            }
            assert!(args.windows(2).any(|p| p == ["--playlist-items", "1:21"]));
            assert!(
                args.windows(2)
                    .any(|p| p == ["--use-extractors", "youtube:tab,youtube:playlist"])
            );
            assert!(args.windows(2).any(|p| p
                == [
                    "--compat-options",
                    "no-youtube-unavailable-videos,no-youtube-channel-redirect"
                ]));
            assert_eq!(args.last(), Some(&reference.canonical()));
            assert_eq!(args[args.len() - 2], "--");
            assert_eq!(args.contains(&"--cookies".into()), cookies.is_some());
            assert_eq!(args.contains(&"--no-cookies".into()), cookies.is_none());
            for denied in [
                "--format",
                "--exec",
                "--write-info-json",
                "--write-subs",
                "--download-archive",
                "--no-playlist",
                "--extractor-args",
            ] {
                assert!(!args.contains(&denied.to_owned()), "{denied}");
            }
            assert!(!format!("{command:?}").contains("synthetic-session-only"));
        }
        let disabled = Config::opt_in_absolute(std::env::current_exe().unwrap()).unwrap();
        assert!(playlist_command(&disabled, &reference, scratch.path(), Some(&secret)).is_err());
        secret.dispose().unwrap();
        scratch.dispose().unwrap();
    }
    #[test]
    fn authenticated_command_has_only_private_path_and_never_secret_or_browser_flags() {
        let config = Config::opt_in_absolute(std::env::current_exe().unwrap())
            .unwrap()
            .with_viewer_credentials()
            .unwrap();
        let mut scratch = ScratchDir::create().unwrap();
        let mut secret = SecretFile::create(scratch.path(), &credential()).unwrap();
        let command = command_with_account(
            &config,
            &super::super::parse_resource("dQw4w9WgXcQ").unwrap(),
            SelectionMode::PreferAdaptive,
            QualityLimit::P720,
            scratch.path(),
            Some(&secret),
        )
        .unwrap();
        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.contains(&"--cookies".into()));
        assert!(!args.contains(&"--no-cookies".into()));
        assert!(args.contains(&"--no-cookies-from-browser".into()));
        assert!(args.contains(&"--simulate".into()));
        assert!(!args.join(" ").contains("synthetic-session-only"));
        assert!(!format!("{command:?}").contains("synthetic-session-only"));
        assert!(args.iter().any(|arg| arg.contains("[height<=720]")));
        let disabled = Config::opt_in_absolute(std::env::current_exe().unwrap()).unwrap();
        assert!(
            command_with_account(
                &disabled,
                &super::super::parse_resource("dQw4w9WgXcQ").unwrap(),
                SelectionMode::PreferAdaptive,
                QualityLimit::Auto,
                scratch.path(),
                Some(&secret)
            )
            .is_err()
        );
        secret.dispose().unwrap();
        scratch.dispose().unwrap();
    }

    /// Synthetic workspace-built Rust fixture only, never a provider/extractor.
    #[test]
    #[ignore]
    fn secret_fixture() {
        let Some(root) = std::env::var_os("RAINSYNC_ACCOUNT_FIXTURE_DIR") else {
            return;
        };
        let root = PathBuf::from(root);
        let file = std::fs::read_to_string(root.join("viewer-session.cookies")).unwrap();
        assert!(file.contains("synthetic-session-only"));
        std::fs::write(root.join("loaded"), b"loaded").unwrap();
        match std::env::var("RAINSYNC_ACCOUNT_FIXTURE_MODE").as_deref() {
            Ok("wait") => std::thread::sleep(Duration::from_secs(60)),
            Ok("fail") => std::process::exit(7),
            _ => {}
        }
    }

    #[tokio::test]
    async fn owned_supervisor_clears_secret_after_success_failure_deadline_and_cancellation() {
        for mode in ["done", "fail", "deadline", "cancel"] {
            let scope = child_process::Scope::new();
            let scratch = ScratchDir::create().unwrap();
            let root = scratch.path().to_owned();
            let secret = SecretFile::create(&root, &credential()).unwrap();
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .env_clear()
                .env("RAINSYNC_ACCOUNT_FIXTURE_DIR", &root)
                .env(
                    "RAINSYNC_ACCOUNT_FIXTURE_MODE",
                    if matches!(mode, "deadline" | "cancel") {
                        "wait"
                    } else {
                        mode
                    },
                )
                .args([
                    "--ignored",
                    "--exact",
                    "platform::youtube::process::account_tests::secret_fixture",
                    "--nocapture",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let slots = Arc::new(Semaphore::new(1));
            let permit = slots.clone().acquire_owned().await.unwrap();
            let deadline = Instant::now()
                + if mode == "deadline" {
                    Duration::from_millis(150)
                } else {
                    Duration::from_secs(5)
                };
            let owner_scope = scope.clone();
            let work = tokio::spawn(async move {
                owner_scope
                    .run(supervise_extraction(
                        command,
                        scratch,
                        Some(secret),
                        deadline,
                        permit,
                    ))
                    .await
            });
            if mode == "cancel" {
                tokio::time::timeout(Duration::from_secs(2), async {
                    while !root.join("loaded").exists() {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap();
                work.abort();
                let _ = work.await;
            } else {
                let result = work.await.unwrap();
                assert_eq!(result.is_ok(), mode == "done");
                if mode == "deadline" {
                    assert_eq!(result.unwrap_err(), Error::Deadline);
                }
            }
            scope.shutdown().await.unwrap();
            assert!(
                !root.exists(),
                "private session file and cwd removed after {mode}"
            );
            assert_eq!(slots.available_permits(), 1);
        }
    }
}
#[cfg(all(test, unix))]
mod explicit_page_tests {
    use super::*;
    #[test]
    fn page_command_remains_flat_lazy_no_plugins_no_download_or_caller_flags() {
        let config = Config::opt_in_absolute(std::env::current_exe().unwrap()).unwrap();
        let reference = super::super::playlist::parse_resource("PLBB231211A4F62143").unwrap();
        let command = playlist_page_command(
            &config,
            &reference,
            super::super::playlist::Page { page: 1 },
            std::path::Path::new("/tmp"),
            None,
        )
        .unwrap();
        let args = command
            .as_std()
            .get_args()
            .map(|a| a.to_str().unwrap())
            .collect::<Vec<_>>();
        for arg in [
            "--simulate",
            "--flat-playlist",
            "--lazy-playlist",
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-js-runtimes",
            "--no-remote-components",
            "21:41",
            "--no-cookies",
        ] {
            assert!(args.contains(&arg), "{arg}");
        }
        assert!(!args.contains(&"--cookies-from-browser"));
        assert!(!args.contains(&"--live-from-start"));
        assert_eq!(args.last().copied(), Some(reference.canonical().as_str()));
    }
}
