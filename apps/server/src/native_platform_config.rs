//! Admin-owned executable configuration; never derived from an API request.
use providers::platform::youtube::{Config, YoutubeResolver};
use std::{ffi::OsStr, path::PathBuf};

fn other_live_flag(value: Option<&OsStr>) -> anyhow::Result<bool> {
    match value.and_then(OsStr::to_str) {
        None if value.is_none() => Ok(false),
        Some("0") => Ok(false),
        Some("1") => Ok(true),
        _ => anyhow::bail!("RAINSYNC_OTHER_LIVE_ENABLED must be 0 or 1"),
    }
}
pub(crate) fn configured_other_live() -> anyhow::Result<bool> {
    other_live_flag(std::env::var_os("RAINSYNC_OTHER_LIVE_ENABLED").as_deref())
}

fn viewer_cookie_flag(value: Option<&OsStr>) -> anyhow::Result<bool> {
    match value.and_then(OsStr::to_str) {
        None if value.is_none() => Ok(false),
        Some("0") => Ok(false),
        Some("1") => Ok(true),
        _ => anyhow::bail!("RAINSYNC_YTDLP_ALLOW_VIEWER_COOKIES must be 0 or 1"),
    }
}

pub(crate) fn configured_youtube() -> anyhow::Result<YoutubeResolver> {
    let binary = std::env::var_os("RAINSYNC_YTDLP_BIN");
    let deno = std::env::var_os("RAINSYNC_YTDLP_DENO_BIN");
    let viewer_cookie_config = std::env::var_os("RAINSYNC_YTDLP_ALLOW_VIEWER_COOKIES");
    let viewer_cookies = viewer_cookie_flag(viewer_cookie_config.as_deref())?;
    let Some(binary) = binary else {
        anyhow::ensure!(
            !viewer_cookies,
            "RAINSYNC_YTDLP_ALLOW_VIEWER_COOKIES=1 requires RAINSYNC_YTDLP_BIN"
        );
        anyhow::ensure!(
            deno.is_none(),
            "RAINSYNC_YTDLP_DENO_BIN requires RAINSYNC_YTDLP_BIN"
        );
        return Ok(YoutubeResolver::new(Config::disabled()));
    };
    let mut config = Config::opt_in_absolute(PathBuf::from(binary)).map_err(|_| {
        anyhow::anyhow!("RAINSYNC_YTDLP_BIN must identify a trusted, safe absolute executable")
    })?;
    if let Some(deno) = deno {
        config = config
            .with_deno_absolute(PathBuf::from(deno))
            .map_err(|_| {
                anyhow::anyhow!(
                    "RAINSYNC_YTDLP_DENO_BIN must identify a trusted, safe absolute Deno executable"
                )
            })?;
    }
    if viewer_cookies {
        config = config.with_viewer_credentials().map_err(|_| {
            anyhow::anyhow!("YouTube viewer credentials require an enabled trusted extractor")
        })?;
    }
    if configured_other_live()? {
        config = config
            .with_live()
            .map_err(|_| anyhow::anyhow!("YouTube live requires an enabled trusted extractor"))?;
    }
    Ok(YoutubeResolver::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn other_live_requires_closed_operator_opt_in() {
        assert!(!other_live_flag(None).unwrap());
        assert!(!other_live_flag(Some(OsStr::new("0"))).unwrap());
        assert!(other_live_flag(Some(OsStr::new("1"))).unwrap());
        for value in ["", "true", " 1", "2"] {
            assert!(other_live_flag(Some(OsStr::new(value))).is_err());
        }
    }
    #[test]
    fn credential_opt_in_is_explicit_and_closed() {
        assert!(!viewer_cookie_flag(None).unwrap());
        assert!(!viewer_cookie_flag(Some(OsStr::new("0"))).unwrap());
        assert!(viewer_cookie_flag(Some(OsStr::new("1"))).unwrap());
        for value in ["", "true", "yes", " 1", "1 ", "2"] {
            assert!(viewer_cookie_flag(Some(OsStr::new(value))).is_err());
        }
    }
}
