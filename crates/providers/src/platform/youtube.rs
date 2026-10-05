//! Opt-in YouTube ordinary-VOD extraction, anonymous by default.
//!
//! The administrator supplies existing, trusted executables. No downloader,
//! updater, plugin, shared account cookie, arbitrary argument or shell is exposed.
//! Explicitly enabled viewer sessions use opaque request-private file custody.
//! This is a subprocess/process-tree boundary, NOT an OS, filesystem or network
//! sandbox. See `youtube/BOUNDARY.md` for the deployment and shutdown contract.

use reqwest::Url;
use serde::Deserialize;
use std::{fmt, path::PathBuf, sync::Arc, time::Duration};
use tokio::{sync::Semaphore, time::Instant};

mod account;
mod captions;
pub mod mp4;
pub mod playlist;
mod process;
pub mod webm;
pub use account::Credential;
#[cfg(test)]
mod tests;

const MAX_RESOURCE_BYTES: usize = 2048;
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 32 * 1024;
const MAX_EXTRACT_TIME: Duration = Duration::from_secs(30);
const MAX_CONCURRENT: usize = 2;
const MAX_DURATION_SECONDS: f64 = 7.0 * 24.0 * 60.0 * 60.0;
const MAX_URL_BYTES: usize = 16 * 1024;
const MAX_EXPIRY_SECONDS: u64 = 24 * 60 * 60;
const MAX_WIDTH: u32 = 8192;
const MAX_HEIGHT: u32 = 4320;
const MAX_FPS: f64 = 120.0;
const MAX_VIDEO_KBPS: f64 = 80_000.0;
const MAX_AUDIO_KBPS: f64 = 512.0;
pub(crate) const USER_AGENT: &str = "Mozilla/5.0 RainSync/0.1";
pub(crate) const REFERER: &str = "https://www.youtube.com/";

/// Stable, sanitized errors. No extractor text, command, URL or credentials.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    ProviderUnavailable,
    InvalidConfiguration,
    InvalidResource,
    Deadline,
    TooLarge,
    ExtractorFailed,
    InvalidResponse,
    Unsupported,
    Cancelled,
    ProcessCleanupFailed,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ProviderUnavailable => "provider_unavailable",
            Self::InvalidConfiguration => "youtube_invalid_configuration",
            Self::InvalidResource => "youtube_invalid_resource",
            Self::Deadline => "youtube_deadline",
            Self::TooLarge => "youtube_response_too_large",
            Self::ExtractorFailed => "youtube_extractor_failed",
            Self::InvalidResponse => "youtube_invalid_response",
            Self::Unsupported => "youtube_unsupported_vod",
            Self::Cancelled => "youtube_cancelled",
            Self::ProcessCleanupFailed => "youtube_process_cleanup_failed",
        })
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoRef {
    pub id: String,
}
impl VideoRef {
    pub fn canonical(&self) -> String {
        format!("https://www.youtube.com/watch?v={}", self.id)
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// IDs, full HTTPS watch URLs, youtu.be links and shorts URLs only. A small
/// bounded tracking whitelist is discarded; playlists, fragments, credentials,
/// escaped identities, ports, embeds and arbitrary redirect links are rejected.
pub fn parse_resource(input: &str) -> Result<VideoRef> {
    if input.is_empty()
        || input.len() > MAX_RESOURCE_BYTES
        || !input.is_ascii()
        || input
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control() || b == b'\\')
    {
        return Err(Error::InvalidResource);
    }
    if valid_id(input) {
        return Ok(VideoRef { id: input.into() });
    }
    let rest = input
        .strip_prefix("https://")
        .ok_or(Error::InvalidResource)?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let raw_authority = &rest[..authority_end];
    let raw_path = rest[authority_end..]
        .split(['?', '#'])
        .next()
        .unwrap_or_default();
    if raw_path.contains('%') || raw_path.split('/').any(|part| matches!(part, "." | "..")) {
        return Err(Error::InvalidResource);
    }
    if raw_authority.contains([':', '@', '%']) {
        return Err(Error::InvalidResource);
    }
    let url = Url::parse(input).map_err(|_| Error::InvalidResource)?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.path().contains('%')
    {
        return Err(Error::InvalidResource);
    }
    let youtube = matches!(
        url.host_str(),
        Some("youtube.com" | "www.youtube.com" | "m.youtube.com")
    );
    let watch = youtube && url.path() == "/watch";
    let path_id = if watch {
        None
    } else if youtube {
        Some(
            url.path()
                .strip_prefix("/shorts/")
                .ok_or(Error::InvalidResource)?,
        )
    } else if url.host_str() == Some("youtu.be") {
        Some(url.path().strip_prefix('/').ok_or(Error::InvalidResource)?)
    } else {
        return Err(Error::InvalidResource);
    };
    let mut id = path_id.map(|id| id.strip_suffix('/').unwrap_or(id).to_owned());
    let mut seen = std::collections::HashSet::new();
    if let Some(query) = url.query() {
        for pair in query.split('&') {
            let (key, value) = pair.split_once('=').ok_or(Error::InvalidResource)?;
            if !seen.insert(key) || value.is_empty() || value.len() > 128 {
                return Err(Error::InvalidResource);
            }
            match key {
                "v" if watch && valid_id(value) => id = Some(value.into()),
                "si" | "feature"
                    if value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) => {}
                "t" if value.len() <= 32
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_digit() || matches!(b, b'h' | b'm' | b's')) => {}
                _ => return Err(Error::InvalidResource),
            }
        }
    }
    let id = id.filter(|id| valid_id(id)).ok_or(Error::InvalidResource)?;
    Ok(VideoRef { id })
}

/// Trusted server deployment configuration, never derived from an import DTO.
/// Constructors validate executable paths but do not execute/probe/download them.
#[derive(Clone, Default)]
pub struct Config {
    binary: Option<PathBuf>,
    deno: Option<PathBuf>,
    viewer_credentials: bool,
    live_enabled: bool,
}
impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("YoutubeConfig")
            .field("enabled", &self.binary.is_some())
            .field("js_runtime_configured", &self.deno.is_some())
            .field("viewer_credentials_enabled", &self.viewer_credentials)
            .finish()
    }
}
impl Config {
    pub fn disabled() -> Self {
        Self::default()
    }

    pub fn opt_in_absolute(binary: PathBuf) -> Result<Self> {
        Ok(Self {
            binary: Some(process::trusted_executable(binary)?),
            deno: None,
            viewer_credentials: false,
            live_enabled: false,
        })
    }

    /// Separate administrator opt-in; normal VOD configuration never enables live.
    pub fn with_live(mut self) -> Result<Self> {
        if self.binary.is_none() {
            return Err(Error::InvalidConfiguration);
        }
        self.live_enabled = true;
        Ok(self)
    }

    pub fn with_deno_absolute(mut self, deno: PathBuf) -> Result<Self> {
        if self.binary.is_none() {
            return Err(Error::InvalidConfiguration);
        }
        self.deno = Some(process::trusted_executable(deno)?);
        Ok(self)
    }
    /// Explicit administrator trust decision: this process is not an OS sandbox.
    pub fn with_viewer_credentials(mut self) -> Result<Self> {
        if self.binary.is_none() {
            return Err(Error::InvalidConfiguration);
        }
        self.viewer_credentials = true;
        Ok(self)
    }
}

/// Closed server policy chosen before extraction. It is never deserialized from
/// caller flags or an arbitrary selector; imports use PreferAdaptive by default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectionMode {
    PreferAdaptive,
    ProgressiveOnly,
    /// Private Worker-bound finite MP4 input; never native browser delivery.
    CompatibilityAdaptive,
}

/// Trusted closed application policy. No caller can provide extractor syntax.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum QualityLimit {
    #[default]
    Auto,
    P144,
    P240,
    P360,
    P480,
    P720,
    P1080,
    P1440,
    P2160,
    P4320,
}
impl QualityLimit {
    pub fn height(self) -> Option<u32> {
        match self {
            Self::Auto => None,
            Self::P144 => Some(144),
            Self::P240 => Some(240),
            Self::P360 => Some(360),
            Self::P480 => Some(480),
            Self::P720 => Some(720),
            Self::P1080 => Some(1080),
            Self::P1440 => Some(1440),
            Self::P2160 => Some(2160),
            Self::P4320 => Some(4320),
        }
    }
}

/// Clone shares admission capacity. Each original deadline includes queue time.
#[derive(Clone)]
pub struct YoutubeResolver {
    config: Config,
    slots: Arc<Semaphore>,
}
impl fmt::Debug for YoutubeResolver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("YoutubeResolver")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}
impl YoutubeResolver {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            slots: Arc::new(Semaphore::new(MAX_CONCURRENT)),
        }
    }
    pub fn viewer_credentials_enabled(&self) -> bool {
        self.config.binary.is_some() && self.config.viewer_credentials
    }

    /// Bounded, metadata-only ordinary playlist preview. A supplied credential
    /// is used once under the same custody and process lifecycle as VOD; there
    /// is no anonymous retry, browser-cookie discovery or selected media fetch.
    pub async fn preview_playlist_with_credential(
        &self,
        reference: &playlist::PlaylistRef,
        credential: Option<&Credential>,
        deadline: Instant,
    ) -> Result<playlist::Preview> {
        if self.config.binary.is_none()
            || (credential.is_some() && !self.viewer_credentials_enabled())
        {
            return Err(Error::ProviderUnavailable);
        }
        let deadline = deadline.min(Instant::now() + MAX_EXTRACT_TIME);
        if deadline <= Instant::now() {
            return Err(Error::Deadline);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::InvalidResponse)?
            .as_secs();
        let credential = credential
            .map(|credential| Credential::parse(credential.expose_for_storage(), now))
            .transpose()?;
        let bytes = process::extract_playlist(
            &self.config,
            reference,
            credential.as_ref(),
            deadline,
            self.slots.clone(),
        )
        .await?;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        playlist::normalize_before_deadline(&bytes, reference, deadline)
    }

    /// Fresh bounded view of one explicit ordinary playlist page. YouTube
    /// provides no immutable whole-list revision here; this is not a snapshot.
    pub async fn preview_playlist_page(
        &self,
        reference: &playlist::PlaylistRef,
        page: playlist::Page,
        credential: Option<&Credential>,
        deadline: Instant,
    ) -> Result<playlist::PagePreview> {
        page.validate()?;
        if self.config.binary.is_none()
            || (credential.is_some() && !self.viewer_credentials_enabled())
        {
            return Err(Error::ProviderUnavailable);
        }
        let deadline = deadline.min(Instant::now() + MAX_EXTRACT_TIME);
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::InvalidResponse)?
            .as_secs();
        let credential = credential
            .map(|c| Credential::parse(c.expose_for_storage(), now))
            .transpose()?;
        let bytes = process::extract_playlist_page(
            &self.config,
            reference,
            page,
            credential.as_ref(),
            deadline,
            self.slots.clone(),
        )
        .await?;
        playlist::normalize_page_before_deadline(&bytes, reference, page, deadline)
    }

    /// Continuation proof commits the previous page's validated sentinel.
    /// It detects boundary reorder/removal, not unseen whole-list mutation.
    pub async fn preview_playlist_page_with_boundary(
        &self,
        reference: &playlist::PlaylistRef,
        page: playlist::Page,
        expected_boundary: Option<&str>,
        credential: Option<&Credential>,
        deadline: Instant,
    ) -> Result<playlist::PagePreview> {
        page.validate()?;
        if (page.page == 0 && expected_boundary.is_some())
            || (page.page > 0 && expected_boundary.is_none())
        {
            return Err(Error::InvalidResource);
        }
        if self.config.binary.is_none()
            || (credential.is_some() && !self.viewer_credentials_enabled())
        {
            return Err(Error::ProviderUnavailable);
        }
        let deadline = deadline.min(Instant::now() + MAX_EXTRACT_TIME);
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::InvalidResponse)?
            .as_secs();
        let credential = credential
            .map(|c| Credential::parse(c.expose_for_storage(), now))
            .transpose()?;
        let bytes = process::extract_playlist_page(
            &self.config,
            reference,
            page,
            credential.as_ref(),
            deadline,
            self.slots.clone(),
        )
        .await?;
        playlist::normalize_page_with_boundary(&bytes, reference, page, expected_boundary, deadline)
    }

    pub fn live_enabled(&self) -> bool {
        self.config.binary.is_some() && self.config.live_enabled
    }
    /// One closed clear-HLS live extraction. No script runtime, challenge,
    /// from-start recording, download or second account attempt is admitted.
    pub async fn resolve_live(
        &self,
        resource: &super::other_live::Resource,
        credential: Option<&Credential>,
        deadline: Instant,
    ) -> super::other_live::Result<super::other_live::Resolved> {
        use super::bilibili::Error as LiveError;
        let map = |e: Error| match e {
            Error::ProviderUnavailable | Error::InvalidConfiguration => {
                LiveError::Restricted("other_live_youtube_configured_extractor_required")
            }
            Error::InvalidResource => LiveError::InvalidResource,
            Error::Deadline => LiveError::Deadline,
            Error::TooLarge => LiveError::TooLarge,
            Error::ProcessCleanupFailed => {
                LiveError::Restricted("other_live_extractor_cleanup_required")
            }
            _ => LiveError::Restricted("other_live_user_handoff_required"),
        };
        if !self.live_enabled() || (credential.is_some() && !self.viewer_credentials_enabled()) {
            return Err(map(Error::ProviderUnavailable));
        }
        let super::other_live::Resource::YouTube { id } = resource else {
            return Err(LiveError::InvalidResource);
        };
        resource.validate()?;
        let reference = VideoRef { id: id.clone() };
        let deadline = deadline.min(Instant::now() + MAX_EXTRACT_TIME);
        if Instant::now() >= deadline {
            return Err(LiveError::Deadline);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| LiveError::Transport)?
            .as_secs();
        let credential = credential
            .map(|c| Credential::parse(c.expose_for_storage(), now))
            .transpose()
            .map_err(map)?;
        let bytes = process::extract_live(
            &self.config,
            &reference,
            credential.as_ref(),
            deadline,
            self.slots.clone(),
        )
        .await
        .map_err(map)?;
        if Instant::now() >= deadline {
            return Err(LiveError::Deadline);
        }
        super::other_live::parse_youtube_response(resource, &bytes, now)
    }

    /// Optional, anonymous caption discovery uses the same fixed simulated
    /// metadata boundary and shared admission slots. No downloader is started.
    pub async fn caption_catalog(
        &self,
        resource: &str,
        deadline: Instant,
    ) -> Result<Vec<super::text::SubtitleDescriptor>> {
        if self.config.binary.is_none() {
            return Err(Error::ProviderUnavailable);
        }
        let reference = parse_resource(resource)?;
        let deadline = deadline.min(Instant::now() + MAX_EXTRACT_TIME);
        if deadline <= Instant::now() {
            return Err(Error::Deadline);
        }
        let bytes = process::extract(
            &self.config,
            &reference,
            SelectionMode::PreferAdaptive,
            deadline,
            self.slots.clone(),
        )
        .await?;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        captions::parse(&bytes, &reference)
    }

    pub async fn caption_catalog_authenticated(
        &self,
        resource: &str,
        credential: &Credential,
        deadline: Instant,
    ) -> Result<Vec<super::text::SubtitleDescriptor>> {
        if !self.viewer_credentials_enabled() {
            return Err(Error::ProviderUnavailable);
        }
        let reference = parse_resource(resource)?;
        let deadline = deadline.min(Instant::now() + MAX_EXTRACT_TIME);
        if deadline <= Instant::now() {
            return Err(Error::Deadline);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::InvalidResponse)?
            .as_secs();
        let credential = Credential::parse(credential.expose_for_storage(), now)?;
        let bytes = process::extract_authenticated(
            &self.config,
            &reference,
            SelectionMode::PreferAdaptive,
            QualityLimit::Auto,
            &credential,
            deadline,
            self.slots.clone(),
        )
        .await?;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        captions::parse(&bytes, &reference)
    }

    pub async fn resolve(&self, resource: &str, deadline: Instant) -> Result<ResolvedVideo> {
        self.resolve_with_mode(resource, SelectionMode::PreferAdaptive, deadline)
            .await
    }

    pub async fn resolve_with_mode(
        &self,
        resource: &str,
        mode: SelectionMode,
        deadline: Instant,
    ) -> Result<ResolvedVideo> {
        self.resolve_with_quality(resource, mode, QualityLimit::Auto, deadline)
            .await
    }

    pub async fn resolve_with_quality(
        &self,
        resource: &str,
        mode: SelectionMode,
        quality: QualityLimit,
        deadline: Instant,
    ) -> Result<ResolvedVideo> {
        if self.config.binary.is_none() {
            return Err(Error::ProviderUnavailable);
        }
        let reference = parse_resource(resource)?;
        let deadline = deadline.min(Instant::now() + MAX_EXTRACT_TIME);
        if deadline <= Instant::now() {
            return Err(Error::Deadline);
        }
        let bytes = process::extract_with_quality(
            &self.config,
            &reference,
            mode,
            quality,
            deadline,
            self.slots.clone(),
        )
        .await?;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::InvalidResponse)?
            .as_secs();
        let resolved = normalize_json_before_deadline(&bytes, &reference, now, mode, deadline)?;
        validate_quality_limit(&resolved, quality)?;
        Ok(resolved)
    }

    /// One caller-owned session and one extraction attempt. No anonymous retry,
    /// browser extraction, shared administrator cookie or OAuth grant is used.
    pub async fn resolve_authenticated_with_quality(
        &self,
        resource: &str,
        mode: SelectionMode,
        quality: QualityLimit,
        credential: &Credential,
        deadline: Instant,
    ) -> Result<ResolvedVideo> {
        if !self.viewer_credentials_enabled() {
            return Err(Error::ProviderUnavailable);
        }
        let reference = parse_resource(resource)?;
        let deadline = deadline.min(Instant::now() + MAX_EXTRACT_TIME);
        if deadline <= Instant::now() {
            return Err(Error::Deadline);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::InvalidResponse)?
            .as_secs();
        // Revalidate expiry at the process boundary, not just at vault import.
        let credential = Credential::parse(credential.expose_for_storage(), now)?;
        let bytes = process::extract_authenticated(
            &self.config,
            &reference,
            mode,
            quality,
            &credential,
            deadline,
            self.slots.clone(),
        )
        .await?;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::InvalidResponse)?
            .as_secs();
        // Authentication does not relax media/header/DRM or visibility policy.
        let resolved = normalize_json_before_deadline(&bytes, &reference, now, mode, deadline)?;
        validate_quality_limit(&resolved, quality)?;
        Ok(resolved)
    }
}

/// Server-only selected playback. These descriptors deliberately do not
/// implement Serialize. Never copy signed URLs into a DTO, log or room event.
#[derive(Clone)]
pub struct ResolvedVideo {
    pub content_id: String,
    pub canonical_url: String,
    pub title: String,
    pub duration_seconds: f64,
    pub expires_at_unix_ms: Option<i64>,
    pub playback: Playback,
    /// Compatible heights actually observed in this bounded extraction. These
    /// are discovery metadata; each future selection is resolved/probed anew.
    pub available_heights: Vec<u32>,
}

/// A muxed fallback or exactly one complementary video/audio pair. Adaptive
/// metadata alone is not a DASH descriptor: playback must probe MP4 bytes.
#[derive(Clone)]
pub enum Playback {
    Progressive(ProgressivePlayback),
    Adaptive {
        video: AdaptiveVideo,
        audio: AdaptiveAudio,
    },
}

#[derive(Clone)]
pub struct ProgressivePlayback {
    pub url: String,
    pub expires_at_unix_ms: i64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub video_codec: String,
    pub audio_codec: String,
}

#[derive(Clone)]
pub struct AdaptiveVideo {
    pub container: media_core::advanced_media::PrivateInputContainer,
    pub url: String,
    pub expires_at_unix_ms: i64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: String,
    pub bitrate_bps: u64,
}

#[derive(Clone)]
pub struct AdaptiveAudio {
    pub url: String,
    pub expires_at_unix_ms: i64,
    pub sample_rate: u32,
    pub channels: u32,
    pub codec: String,
    pub bitrate_bps: u64,
}

impl Playback {
    pub fn dimensions(&self) -> (Option<u32>, Option<u32>) {
        match self {
            Self::Progressive(track) => (track.width, track.height),
            Self::Adaptive { video, .. } => (Some(video.width), Some(video.height)),
        }
    }

    fn expiry(&self) -> i64 {
        match self {
            Self::Progressive(track) => track.expires_at_unix_ms,
            Self::Adaptive { video, audio } => {
                video.expires_at_unix_ms.min(audio.expires_at_unix_ms)
            }
        }
    }
}

impl fmt::Debug for ResolvedVideo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("YoutubeResolvedVideo")
            .field("duration_seconds", &self.duration_seconds)
            .field("playback", &self.playback)
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for Playback {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Progressive(track) => f.debug_tuple("Progressive").field(track).finish(),
            Self::Adaptive { video, audio } => f
                .debug_struct("Adaptive")
                .field("video", video)
                .field("audio", audio)
                .finish(),
        }
    }
}
impl fmt::Debug for ProgressivePlayback {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProgressivePlayback")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .finish_non_exhaustive()
    }
}
impl fmt::Debug for AdaptiveVideo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AdaptiveVideo")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("fps", &self.fps)
            .field("bitrate_bps", &self.bitrate_bps)
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .finish_non_exhaustive()
    }
}
impl fmt::Debug for AdaptiveAudio {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AdaptiveAudio")
            .field("sample_rate", &self.sample_rate)
            .field("channels", &self.channels)
            .field("bitrate_bps", &self.bitrate_bps)
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .finish_non_exhaustive()
    }
}

/// Only these fields are ever materialized. Unknown extractor keys are skipped
/// by Serde, not copied into a Value/map, persisted or forwarded. In particular,
/// yt-dlp sanitize_info is JSON conversion and is NOT a secrets scrubber.
#[derive(Deserialize)]
struct Extracted {
    #[serde(rename = "_type")]
    kind: String,
    id: String,
    extractor_key: String,
    title: String,
    duration: f64,
    live_status: String,
    is_live: Option<bool>,
    was_live: Option<bool>,
    availability: Option<String>,
    age_limit: Option<u32>,
    webpage_url: Option<String>,
    ext: String,
    protocol: String,
    vcodec: String,
    acodec: String,
    url: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    asr: Option<u32>,
    audio_channels: Option<u32>,
    tbr: Option<f64>,
    vbr: Option<f64>,
    abr: Option<f64>,
    has_drm: Option<Drm>,
    #[serde(default)]
    http_headers: AllowedHeaders,
    entries: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    requested_formats: SelectedFormats,
    #[serde(default)]
    formats: AvailableFormats,
    fragments: Option<serde::de::IgnoredAny>,
    manifest_url: Option<serde::de::IgnoredAny>,
    fragment_base_url: Option<serde::de::IgnoredAny>,
    request_data: Option<serde::de::IgnoredAny>,
    cookies: Option<serde::de::IgnoredAny>,
    hls_aes: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    init_range: ForbiddenField,
    #[serde(default)]
    index_range: ForbiddenField,
    #[serde(default)]
    downloader_options: AllowedDownloaderOptions,
    #[serde(default)]
    impersonate: ForbiddenField,
}

#[derive(Default)]
struct AvailableFormats(Vec<AvailableFormat>);
impl<'de> Deserialize<'de> for AvailableFormats {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = AvailableFormats;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("bounded format metadata")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut formats = Vec::new();
                while let Some(format) = seq.next_element::<AvailableFormat>()? {
                    if formats.len() >= 128 {
                        return Err(serde::de::Error::custom("too many formats"));
                    }
                    formats.push(format);
                }
                Ok(AvailableFormats(formats))
            }
        }
        deserializer.deserialize_seq(Visitor)
    }
}
/// Only the shape needed for discovery is materialized. Unsupported entries
/// cannot become playback or rescue a rejected selected format.
#[derive(Deserialize)]
struct AvailableFormat {
    ext: Option<String>,
    protocol: Option<String>,
    vcodec: Option<String>,
    acodec: Option<String>,
    url: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    asr: Option<u32>,
    audio_channels: Option<u32>,
    tbr: Option<f64>,
    has_drm: Option<Drm>,
    #[serde(default)]
    http_headers: AllowedHeaders,
    #[serde(default)]
    fragments: ForbiddenField,
    #[serde(default)]
    manifest_url: ForbiddenField,
    #[serde(default)]
    request_data: ForbiddenField,
    #[serde(default)]
    cookies: ForbiddenField,
    #[serde(default)]
    hls_aes: ForbiddenField,
    #[serde(default)]
    impersonate: ForbiddenField,
}
impl AvailableFormat {
    fn clear_direct(&self, now: u64) -> bool {
        let _ = &self.http_headers;
        self.protocol.as_deref() == Some("https")
            && !self.has_drm.as_ref().is_some_and(Drm::denied)
            && !self.fragments.0
            && !self.manifest_url.0
            && !self.request_data.0
            && !self.cookies.0
            && !self.hls_aes.0
            && !self.impersonate.0
            && self
                .url
                .as_deref()
                .is_some_and(|url| validate_media_url(url, now).is_ok())
    }
    fn video_height(&self, adaptive: bool, now: u64) -> Option<u32> {
        if !self.clear_direct(now)
            || self.ext.as_deref() != Some("mp4")
            || !self.vcodec.as_deref().is_some_and(avc_codec)
            || self.acodec.as_deref() != Some(if adaptive { "none" } else { "mp4a.40.2" })
            || !bounded_dimensions(self.width, self.height)
            || self.width.is_none()
            || self.height.is_none()
            || !bounded_optional(self.fps, MAX_FPS)
            || (adaptive
                && (!self.fps.is_some_and(|fps| bounded_positive(fps, MAX_FPS))
                    || !self
                        .tbr
                        .is_some_and(|rate| bounded_positive(rate, MAX_VIDEO_KBPS))))
            || (!adaptive && !bounded_audio(self.asr, self.audio_channels))
        {
            return None;
        }
        self.height
    }
    fn compatible_audio(&self, now: u64) -> bool {
        self.clear_direct(now)
            && self.ext.as_deref() == Some("m4a")
            && self.vcodec.as_deref() == Some("none")
            && self.acodec.as_deref() == Some("mp4a.40.2")
            && self.width.is_none()
            && self.height.is_none()
            && self.fps.is_none()
            && self.asr.is_some()
            && self.audio_channels.is_some()
            && bounded_audio(self.asr, self.audio_channels)
            && self
                .tbr
                .is_some_and(|rate| bounded_positive(rate, MAX_AUDIO_KBPS))
    }
}

fn validate_quality_limit(resolved: &ResolvedVideo, quality: QualityLimit) -> Result<()> {
    if quality.height().is_some_and(|limit| {
        resolved
            .playback
            .dimensions()
            .1
            .is_none_or(|height| height > limit)
    }) {
        return Err(Error::Unsupported);
    }
    Ok(())
}

/// Presence matters: null, wrong types and any non-two-element selected shape
/// cannot be reinterpreted as a muxed fallback. Unknown fields remain skipped.
#[derive(Default)]
enum SelectedFormats {
    #[default]
    Absent,
    Pair(Box<[SelectedFormat; 2]>),
}
impl<'de> Deserialize<'de> for SelectedFormats {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        <[SelectedFormat; 2]>::deserialize(deserializer).map(|pair| Self::Pair(Box::new(pair)))
    }
}

#[derive(Default)]
struct ForbiddenField(bool);
impl<'de> Deserialize<'de> for ForbiddenField {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        serde::de::IgnoredAny::deserialize(deserializer)?;
        Ok(Self(true))
    }
}

/// Official direct YouTube formats carry this inert downloader hint even in
/// simulated metadata. Validate its exact source-defined shape, then discard
/// it: neither our playback transport nor a downloader receives any option.
#[derive(Default)]
struct AllowedDownloaderOptions;
impl<'de> Deserialize<'de> for AllowedDownloaderOptions {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = AllowedDownloaderOptions;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("fixed YouTube HTTP chunk hint")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut seen = false;
                while let Some((key, value)) = map.next_entry::<String, u64>()? {
                    if seen || key != "http_chunk_size" || value != 10 << 20 {
                        return Err(serde::de::Error::custom("invalid downloader hint"));
                    }
                    seen = true;
                }
                if !seen {
                    return Err(serde::de::Error::custom("missing downloader hint"));
                }
                Ok(AllowedDownloaderOptions)
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

#[derive(Deserialize)]
struct SelectedFormat {
    ext: String,
    protocol: String,
    vcodec: String,
    acodec: String,
    url: String,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    asr: Option<u32>,
    audio_channels: Option<u32>,
    tbr: Option<f64>,
    vbr: Option<f64>,
    abr: Option<f64>,
    duration: Option<f64>,
    has_drm: Option<Drm>,
    #[serde(default)]
    http_headers: AllowedHeaders,
    #[serde(default)]
    requested_formats: ForbiddenField,
    #[serde(default)]
    fragments: ForbiddenField,
    #[serde(default)]
    manifest_url: ForbiddenField,
    #[serde(default)]
    fragment_base_url: ForbiddenField,
    #[serde(default)]
    request_data: ForbiddenField,
    #[serde(default)]
    cookies: ForbiddenField,
    #[serde(default)]
    hls_aes: ForbiddenField,
    #[serde(default)]
    init_range: ForbiddenField,
    #[serde(default)]
    index_range: ForbiddenField,
    #[serde(default)]
    downloader_options: AllowedDownloaderOptions,
    #[serde(default)]
    impersonate: ForbiddenField,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Drm {
    Flag(bool),
    Indeterminate(String),
}
impl Drm {
    fn denied(&self) -> bool {
        match self {
            Self::Flag(value) => *value,
            Self::Indeterminate(value) => {
                let _ = value;
                true
            }
        }
    }
}

#[derive(Default)]
struct AllowedHeaders;
impl<'de> Deserialize<'de> for AllowedHeaders {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = AllowedHeaders;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("static anonymous headers")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut names = std::collections::HashSet::new();
                while let Some((name, value)) = map.next_entry::<String, String>()? {
                    if name.len() > 32 || value.len() > 128 || names.len() >= 6 {
                        return Err(serde::de::Error::custom("invalid anonymous headers"));
                    }
                    let name = name.to_ascii_lowercase();
                    if !names.insert(name.clone()) {
                        return Err(serde::de::Error::custom("duplicate anonymous header"));
                    }
                    let allowed = match name.as_str() {
                        "user-agent" => USER_AGENT,
                        "referer" => REFERER,
                        "accept" => "*/*",
                        "accept-language" => "en-US,en;q=0.5",
                        "accept-encoding" => "identity",
                        "sec-fetch-mode" => "navigate",
                        _ => return Err(serde::de::Error::custom("extra anonymous header")),
                    };
                    if value != allowed {
                        return Err(serde::de::Error::custom("non-static anonymous header"));
                    }
                }
                Ok(AllowedHeaders)
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

fn avc_codec(codec: &str) -> bool {
    codec
        .strip_prefix("avc1.")
        .is_some_and(|suffix| suffix.len() == 6 && suffix.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn bounded_positive(value: f64, maximum: f64) -> bool {
    value.is_finite() && value > 0.0 && value <= maximum
}

fn bounded_optional(value: Option<f64>, maximum: f64) -> bool {
    value.is_none_or(|value| bounded_positive(value, maximum))
}

fn bounded_dimensions(width: Option<u32>, height: Option<u32>) -> bool {
    width.is_none_or(|value| value > 0 && value <= MAX_WIDTH)
        && height.is_none_or(|value| value > 0 && value <= MAX_HEIGHT)
}

fn bounded_audio(sample_rate: Option<u32>, channels: Option<u32>) -> bool {
    sample_rate.is_none_or(|value| (8000..=96_000).contains(&value))
        && channels.is_none_or(|value| (1..=2).contains(&value))
}

fn normalize_json_before_deadline(
    bytes: &[u8],
    expected: &VideoRef,
    now_seconds: u64,
    mode: SelectionMode,
    deadline: Instant,
) -> Result<ResolvedVideo> {
    let result = normalize_json(bytes, expected, now_seconds, mode);
    // Synchronous JSON validation is part of the original absolute budget too.
    if Instant::now() >= deadline {
        Err(Error::Deadline)
    } else {
        result
    }
}

fn normalize_json(
    bytes: &[u8],
    expected: &VideoRef,
    now_seconds: u64,
    mode: SelectionMode,
) -> Result<ResolvedVideo> {
    if bytes.len() > MAX_JSON_BYTES {
        return Err(Error::TooLarge);
    }
    let data: Extracted = serde_json::from_slice(bytes).map_err(|_| Error::InvalidResponse)?;
    // The closed header validator retains no supplied header to forward.
    let _ = data.http_headers;
    let _ = data.downloader_options;
    if data.kind != "video" || data.extractor_key != "Youtube" || data.id != expected.id {
        return Err(Error::InvalidResponse);
    }
    if data
        .webpage_url
        .as_deref()
        .is_some_and(|url| parse_resource(url).ok().as_ref() != Some(expected))
    {
        return Err(Error::InvalidResponse);
    }
    if data.live_status != "not_live"
        || data.is_live == Some(true)
        || data.was_live == Some(true)
        || !matches!(data.availability.as_deref(), Some("public" | "unlisted"))
        || data.age_limit.is_some_and(|age| age != 0)
        || data.entries.is_some()
        || data.fragments.is_some()
        || data.manifest_url.is_some()
        || data.fragment_base_url.is_some()
        || data.request_data.is_some()
        || data.cookies.is_some()
        || data.hls_aes.is_some()
        || data.init_range.0
        || data.index_range.0
        || data.impersonate.0
        || data.has_drm.as_ref().is_some_and(Drm::denied)
    {
        return Err(Error::Unsupported);
    }
    if data.title.is_empty()
        || data.title.len() > 512
        || data.title.chars().any(char::is_control)
        || !bounded_positive(data.duration, MAX_DURATION_SECONDS)
        || !bounded_dimensions(data.width, data.height)
        || !bounded_optional(data.fps, MAX_FPS)
        || !bounded_audio(data.asr, data.audio_channels)
        || !bounded_optional(data.tbr, MAX_VIDEO_KBPS + MAX_AUDIO_KBPS)
        || !bounded_optional(data.vbr, MAX_VIDEO_KBPS)
        || !bounded_optional(data.abr, MAX_AUDIO_KBPS)
    {
        return Err(Error::InvalidResponse);
    }
    let playback = match &data.requested_formats {
        SelectedFormats::Absent if mode == SelectionMode::CompatibilityAdaptive => {
            return Err(Error::Unsupported);
        }
        SelectedFormats::Absent => {
            if data.ext != "mp4"
                || data.protocol != "https"
                || !avc_codec(&data.vcodec)
                || data.acodec != "mp4a.40.2"
            {
                return Err(Error::Unsupported);
            }
            let url = data.url.as_ref().ok_or(Error::InvalidResponse)?;
            Playback::Progressive(ProgressivePlayback {
                expires_at_unix_ms: validate_media_url(url, now_seconds)?,
                url: url.clone(),
                width: data.width,
                height: data.height,
                video_codec: data.vcodec.clone(),
                audio_codec: data.acodec.clone(),
            })
        }
        SelectedFormats::Pair(_) if mode == SelectionMode::ProgressiveOnly => {
            return Err(Error::Unsupported);
        }
        SelectedFormats::Pair(pair) => normalize_adaptive(&data, pair, now_seconds, mode)?,
    };
    let adaptive_available = mode == SelectionMode::PreferAdaptive
        && (matches!(playback, Playback::Adaptive { .. })
            || data
                .formats
                .0
                .iter()
                .any(|format| format.compatible_audio(now_seconds)));
    let mut available_heights: Vec<u32> = data
        .formats
        .0
        .iter()
        .filter_map(|format| {
            format.video_height(false, now_seconds).or_else(|| {
                adaptive_available
                    .then(|| format.video_height(true, now_seconds))
                    .flatten()
            })
        })
        .collect();
    if let Some(height) = playback.dimensions().1 {
        available_heights.push(height);
    }
    available_heights.sort_unstable();
    available_heights.dedup();
    Ok(ResolvedVideo {
        content_id: data.id,
        canonical_url: expected.canonical(),
        title: data.title,
        duration_seconds: data.duration,
        expires_at_unix_ms: Some(playback.expiry()),
        playback,
        available_heights,
    })
}

fn normalize_adaptive(
    data: &Extracted,
    pair: &[SelectedFormat; 2],
    now_seconds: u64,
    mode: SelectionMode,
) -> Result<Playback> {
    // yt-dlp's fixed '+' selector emits a synthetic merged-format summary.
    // It is metadata only, never a downloadable URL or an FFmpeg operation.
    if !(data.ext == "mp4" || mode == SelectionMode::CompatibilityAdaptive && data.ext == "mkv")
        || data.protocol != "https+https"
        || data.url.is_some()
    {
        return Err(Error::Unsupported);
    }
    let (video, audio) = match (&pair[0], &pair[1]) {
        (video, audio) if video.acodec == "none" && audio.vcodec == "none" => (video, audio),
        (audio, video) if video.acodec == "none" && audio.vcodec == "none" => (video, audio),
        _ => return Err(Error::Unsupported),
    };
    for track in pair {
        let _ = track.http_headers;
        let _ = track.downloader_options;
        if track.protocol != "https"
            || track.has_drm.as_ref().is_some_and(Drm::denied)
            || track.requested_formats.0
            || track.fragments.0
            || track.manifest_url.0
            || track.fragment_base_url.0
            || track.request_data.0
            || track.cookies.0
            || track.hls_aes.0
            || track.init_range.0
            || track.index_range.0
            || track.impersonate.0
        {
            return Err(Error::Unsupported);
        }
        // Official YouTube selected formats omit duration. If supplied it must
        // be a bounded, consistent VOD value; the byte probe checks real timing.
        if track.duration.is_some_and(|duration| {
            !bounded_positive(duration, MAX_DURATION_SECONDS)
                || (duration - data.duration).abs() > 2.0
        }) {
            return Err(Error::InvalidResponse);
        }
    }
    if !(video.ext == "mp4"
        && (avc_codec(&video.vcodec)
            || mode == SelectionMode::CompatibilityAdaptive
                && mp4::valid_clear_extended_codec_hint(&video.vcodec))
        || mode == SelectionMode::CompatibilityAdaptive
            && video.ext == "webm"
            && valid_webm_video_hint(&video.vcodec))
        || data.ext == "mkv" && video.ext != "webm"
        || audio.ext != "m4a"
        || audio.acodec != "mp4a.40.2"
        || data.vcodec != video.vcodec
        || data.acodec != audio.acodec
        || video.url == audio.url
    {
        return Err(Error::Unsupported);
    }
    let width = video.width.ok_or(Error::InvalidResponse)?;
    let height = video.height.ok_or(Error::InvalidResponse)?;
    let fps = video.fps.ok_or(Error::InvalidResponse)?;
    let sample_rate = audio.asr.ok_or(Error::InvalidResponse)?;
    let channels = audio.audio_channels.ok_or(Error::InvalidResponse)?;
    if !bounded_dimensions(Some(width), Some(height))
        || !bounded_positive(fps, MAX_FPS)
        || !bounded_audio(Some(sample_rate), Some(channels))
        || video.asr.is_some()
        || video.audio_channels.is_some()
        || audio.width.is_some()
        || audio.height.is_some()
        || audio.fps.is_some()
        || video.abr.is_some_and(|value| value != 0.0)
        || audio.vbr.is_some_and(|value| value != 0.0)
        || !bounded_optional(video.vbr, MAX_VIDEO_KBPS)
        || !bounded_optional(audio.abr, MAX_AUDIO_KBPS)
        || data.width.is_some_and(|value| value != width)
        || data.height.is_some_and(|value| value != height)
        || data.fps.is_some_and(|value| value != fps)
        || data.asr.is_some_and(|value| value != sample_rate)
        || data.audio_channels.is_some_and(|value| value != channels)
    {
        return Err(Error::InvalidResponse);
    }
    let bitrate = |value: Option<f64>, maximum| -> Result<u64> {
        let kbps = value.ok_or(Error::InvalidResponse)?;
        if !bounded_positive(kbps, maximum) {
            return Err(Error::InvalidResponse);
        }
        // Bounds make the float-to-int conversion finite, positive and small.
        Ok((kbps * 1000.0).ceil() as u64)
    };
    Ok(Playback::Adaptive {
        video: AdaptiveVideo {
            container: if video.ext == "webm" {
                media_core::advanced_media::PrivateInputContainer::Webm
            } else {
                media_core::advanced_media::PrivateInputContainer::Mp4
            },
            url: video.url.clone(),
            expires_at_unix_ms: validate_media_url(&video.url, now_seconds)?,
            width,
            height,
            fps,
            codec: video.vcodec.clone(),
            bitrate_bps: bitrate(video.tbr, MAX_VIDEO_KBPS)?,
        },
        audio: AdaptiveAudio {
            url: audio.url.clone(),
            expires_at_unix_ms: validate_media_url(&audio.url, now_seconds)?,
            sample_rate,
            channels,
            codec: audio.acodec.clone(),
            bitrate_bps: bitrate(audio.tbr, MAX_AUDIO_KBPS)?,
        },
    })
}

fn validate_media_url(raw: &str, now_seconds: u64) -> Result<i64> {
    if raw.len() > MAX_URL_BYTES
        || !raw.is_ascii()
        || raw
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace() || b == b'\\')
    {
        return Err(Error::InvalidResponse);
    }
    let rest = raw.strip_prefix("https://").ok_or(Error::InvalidResponse)?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let raw_path = rest[authority_end..]
        .split(['?', '#'])
        .next()
        .unwrap_or_default();
    if raw_path != "/videoplayback" {
        return Err(Error::InvalidResponse);
    }
    if authority.contains([':', '@', '%']) {
        return Err(Error::InvalidResponse);
    }
    let url =
        super::http::validate_media_url_for("youtube", raw).map_err(|_| Error::InvalidResponse)?;
    if url.path() != "/videoplayback" {
        return Err(Error::InvalidResponse);
    }
    let mut expires = None;
    for (key, value) in url.query_pairs() {
        match key.to_ascii_lowercase().as_str() {
            "pot" | "po_token" | "sabr" | "sabr_config" | "cookie" | "authorization"
            | "access_token" | "password" => return Err(Error::Unsupported),
            "expire" => {
                if key != "expire"
                    || expires.is_some()
                    || value.is_empty()
                    || value.len() > 20
                    || !value.bytes().all(|b| b.is_ascii_digit())
                {
                    return Err(Error::InvalidResponse);
                }
                expires = Some(value.parse::<u64>().map_err(|_| Error::InvalidResponse)?);
            }
            _ => {}
        }
    }
    let expires = expires.ok_or(Error::InvalidResponse)?;
    if expires < now_seconds.saturating_add(30)
        || expires > now_seconds.saturating_add(MAX_EXPIRY_SECONDS)
    {
        return Err(Error::InvalidResponse);
    }
    i64::try_from(expires)
        .ok()
        .and_then(|value| value.checked_mul(1000))
        .ok_or(Error::InvalidResponse)
}

/// Only VP9 Profile0/2 or AV1 Main metadata can request the byte/decoder proof.
pub fn valid_webm_video_hint(codec: &str) -> bool {
    matches!(codec, "vp9" | "vp9.2" | "av1")
        || (codec.starts_with("vp09.") || codec.starts_with("av01."))
            && mp4::valid_clear_extended_codec_hint(codec)
}
