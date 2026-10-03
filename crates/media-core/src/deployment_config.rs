//! Fail-fast, secret-free deployment validation shared by all three services.
//! Reachability is checked by the post-start deployment gate, not by mutually
//! dependent services before they bind their listeners.
use anyhow::{Context, Result, ensure};
use std::path::{Path, PathBuf};
use url::Url;

#[derive(Clone, Copy)]
pub enum Role {
    Server,
    Worker,
    Agent,
}

#[derive(Debug)]
pub struct Settings {
    pub public_origin: String,
    pub media_origin: String,
    pub agent_data_origin: String,
    pub cache_root: PathBuf,
}

pub fn origin(name: &str, value: &str) -> Result<String> {
    let url = Url::parse(value).map_err(|_| anyhow::anyhow!("{name}: invalid HTTP(S) origin"))?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/"
            && !matches!(url.host_str(), Some("0.0.0.0" | "[::]")),
        "{name}: use a reachable HTTP(S) origin without credentials, path, query or fragment"
    );
    ensure!(
        url.port() != Some(0),
        "{name}: port zero is not a reachable endpoint"
    );
    Ok(url.origin().ascii_serialization())
}

// Canonicalize the existing prefix, including directory symlinks, without
// creating anything. This also compares a cache directory not created yet.
fn canonical_destination(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut ancestor = absolute.as_path();
    let mut tail = Vec::new();
    loop {
        match ancestor.canonicalize() {
            Ok(mut base) => {
                for component in tail.into_iter().rev() {
                    base.push(component);
                }
                return Ok(base);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = ancestor
                    .file_name()
                    .context("root must have an existing directory ancestor")?;
                ensure!(
                    name != ".." && name != ".",
                    "root contains unresolved path components"
                );
                tail.push(name.to_owned());
                ancestor = ancestor.parent().context("root has no parent")?;
            }
            Err(_) => anyhow::bail!("root cannot be resolved; check directory access"),
        }
    }
}

pub fn distinct_roots(media: &Path, cache: &Path) -> Result<()> {
    ensure!(
        canonical_destination(media)? != canonical_destination(cache)?,
        "CACHE_ROOT must not resolve to MEDIA_ROOT (including aliases/symlinks)"
    );
    Ok(())
}

impl Settings {
    pub fn from_env(role: Role) -> Result<Self> {
        Self::read(role, |name| std::env::var(name).ok())
    }
    pub fn read(role: Role, env: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let public = match role {
            Role::Agent => env("SERVER_URL").context("SERVER_URL is required")?,
            Role::Server => env("PUBLIC_ORIGIN").unwrap_or_else(|| "http://localhost:5173".into()),
            Role::Worker => env("PUBLIC_ORIGIN").unwrap_or_else(|| "http://localhost:8088".into()),
        };
        let public_origin = origin(
            if matches!(role, Role::Agent) {
                "SERVER_URL"
            } else {
                "PUBLIC_ORIGIN"
            },
            &public,
        )?;
        let media_origin = origin(
            "MEDIA_ORIGIN",
            &env("MEDIA_ORIGIN").unwrap_or_else(|| public_origin.clone()),
        )?;
        let agent_data_origin = origin(
            "AGENT_DATA_ORIGIN",
            &env("AGENT_DATA_ORIGIN").unwrap_or_else(|| public_origin.clone()),
        )?;
        // Browser playback plans remain same-origin. A second media origin
        // needs separately verified CORS/client support; never silently accept
        // a setting which the current delivery plan cannot honor.
        ensure!(
            media_origin == public_origin,
            "MEDIA_ORIGIN must equal the control origin; split-origin browser media is not supported"
        );
        // Agent data is a native-client path, not browser mixed content.
        // Preserve existing HTTP(S) split data topologies independently of
        // the control scheme; transport/TLS policy belongs to deployment.
        if let Some(worker) = env("WORKER_URL") {
            origin("WORKER_URL", &worker)?;
        }
        let cache_root = PathBuf::from(env("CACHE_ROOT").unwrap_or_else(|| "/cache".into()));
        // Agent receipt-only recovery must survive a missing media mount. Its
        // existing RootCheck remains the owner of media-path availability.
        if !matches!(role, Role::Agent) {
            if let Some(media) = env("MEDIA_ROOT") {
                distinct_roots(Path::new(&media), &cache_root)?;
                ensure!(
                    Path::new(&media).is_dir(),
                    "MEDIA_ROOT must be an accessible directory"
                );
            }
            ensure!(
                env("SOURCE_ENCRYPTION_KEY").is_some_and(|key| !key.is_empty()),
                "SOURCE_ENCRYPTION_KEY is required before startup"
            );
        }
        Ok(Self {
            public_origin,
            media_origin,
            agent_data_origin,
            cache_root,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_non_origins_without_echoing_secrets() {
        for value in [
            "https://user:secret@host",
            "https://host/media",
            "https://host?token=secret",
            "https://host#secret",
            "file:///tmp",
            "http://0.0.0.0:8080",
            "http://[::]:8080",
            "http://host:0",
        ] {
            let message = origin("PUBLIC_ORIGIN", value).unwrap_err().to_string();
            assert!(!message.contains("secret"));
        }
        assert_eq!(
            origin("PUBLIC_ORIGIN", "https://example.org:443/").unwrap(),
            "https://example.org"
        );
        assert_eq!(
            origin("PUBLIC_ORIGIN", "http://[::1]:8080").unwrap(),
            "http://[::1]:8080"
        );
    }
    #[test]
    fn rejects_missing_key_and_unsupported_media_origin() {
        let env = |name: &str| match name {
            "PUBLIC_ORIGIN" => Some("https://example.org".into()),
            "MEDIA_ORIGIN" => Some("http://example.org".into()),
            _ => None,
        };
        assert!(Settings::read(Role::Server, env).is_err());
        assert!(Settings::read(Role::Worker, |_| None).is_err());
        assert!(
            Settings::read(Role::Agent, |name| (name == "SERVER_URL")
                .then(|| "http://localhost:8080".into()))
            .is_ok()
        );
    }
    #[test]
    fn split_agent_data_origin_is_kept_separate_from_browser_media() {
        let settings = Settings::read(Role::Worker, |name| match name {
            "PUBLIC_ORIGIN" => Some("https://control.example.org".into()),
            "AGENT_DATA_ORIGIN" => Some("http://data.example.org".into()),
            "SOURCE_ENCRYPTION_KEY" => Some("checked-by-caller".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(settings.media_origin, "https://control.example.org");
        assert_eq!(settings.agent_data_origin, "http://data.example.org");
        assert!(
            Settings::read(Role::Server, |name| match name {
                "PUBLIC_ORIGIN" => Some("https://control.example.org".into()),
                "MEDIA_ORIGIN" => Some("https://media.example.org".into()),
                "SOURCE_ENCRYPTION_KEY" => Some("checked-by-caller".into()),
                _ => None,
            })
            .unwrap_err()
            .to_string()
            .contains("split-origin")
        );
    }

    #[test]
    fn canonical_paths_reject_equal_roots_before_creation() {
        let root = std::env::temp_dir().join(format!("rainsync-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        assert!(distinct_roots(&root, &root.join(".")).is_err());
        assert!(distinct_roots(&root, &root.join("new-cache")).is_ok());
        #[cfg(unix)]
        {
            let alias = root.with_extension("alias");
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            assert!(distinct_roots(&root, &alias).is_err());
            std::fs::remove_file(alias).unwrap();
        }
        std::fs::remove_dir(root).unwrap();
    }
}
