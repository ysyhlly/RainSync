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
                let parent = ancestor.parent().context("root has no parent")?;
                // A dangling symlink is not a not-yet-created directory. Check
                // its entry without a terminal slash or /. that would cause
                // symlink_metadata to follow it rather than inspect the link.
                match std::fs::symlink_metadata(parent.join(name)) {
                    Ok(_) => anyhow::bail!("root contains an unresolved symlink"),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => anyhow::bail!("root cannot be resolved; check directory access"),
                }
                tail.push(name.to_owned());
                ancestor = parent;
            }
            Err(_) => anyhow::bail!("root cannot be resolved; check directory access"),
        }
    }
}

pub fn distinct_roots(media: &Path, cache: &Path) -> Result<()> {
    let media = canonical_destination(media)?;
    let cache = canonical_destination(cache)?;
    // Path::starts_with compares components, so /data/media-cache remains a
    // valid sibling of /data/media. Neither root may own the other's tree:
    // cache eviction must never reach originals, or scanning reach outputs.
    ensure!(
        !media.starts_with(&cache) && !cache.starts_with(&media),
        "MEDIA_ROOT and CACHE_ROOT must not resolve to overlapping directories (equal, ancestor or descendant; including aliases/symlinks)"
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
            let media = env("MEDIA_ROOT");
            // Runtime local-source consumers use /media when it is omitted.
            // Keep the existing optional mount check, but never skip overlap
            // validation for the effective default root.
            distinct_roots(Path::new(media.as_deref().unwrap_or("/media")), &cache_root)?;
            if let Some(media) = media {
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

    struct RootFixture(PathBuf);

    impl RootFixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("rainsync-config-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn directory(&self, name: &str) -> PathBuf {
            let path = self.path(name);
            std::fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for RootFixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn assert_overlapping(media: &Path, cache: &Path) {
        let error = distinct_roots(media, cache).unwrap_err().to_string();
        assert!(error.contains("must not resolve to overlapping directories"));
        assert!(!error.contains("rainsync-config-"));
    }

    #[test]
    fn canonical_paths_reject_equal_and_nested_roots_before_creation() {
        let fixture = RootFixture::new();
        let media = fixture.directory("media");
        let nested = fixture.directory("media/existing/deep");
        assert_overlapping(&media, &media.join("."));
        assert_overlapping(&media, &nested);
        assert_overlapping(&nested, &media);
        let missing = media.join("new-cache/deep");
        assert_overlapping(&media, &missing);
        assert_overlapping(&missing, &media);
        assert_overlapping(&missing, &missing);
        assert!(!missing.exists());
    }

    #[test]
    fn canonical_paths_allow_disjoint_siblings_with_matching_string_prefixes() {
        let fixture = RootFixture::new();
        let media = fixture.directory("media");
        for sibling in ["cache", "media-cache", "media2", "..media"] {
            let path = fixture.directory(sibling);
            distinct_roots(&media, &path).unwrap();
            distinct_roots(&path, &media).unwrap();
        }
        let missing = fixture.path("media-new/cache");
        distinct_roots(&media, &missing).unwrap();
        distinct_roots(&fixture.path("new/media"), &fixture.path("new/cache")).unwrap();
        assert!(!missing.exists());
    }

    #[cfg(unix)]
    #[test]
    fn canonical_paths_resolve_symlinks_and_existing_parents_of_missing_tails() {
        let fixture = RootFixture::new();
        let media = fixture.directory("media");
        let nested = fixture.directory("media/existing");
        let alias = fixture.path("alias");
        std::os::unix::fs::symlink(&media, &alias).unwrap();
        assert_overlapping(&media, &alias);
        assert_overlapping(&media, &alias.join("existing"));
        assert_overlapping(&alias.join("existing"), &media);
        assert_overlapping(&alias, &nested);
        assert_overlapping(&media, &alias.join("not-created/deep"));
        assert_overlapping(&alias.join("not-created/deep"), &media);
        let parent_alias = fixture.path("parent-alias");
        std::os::unix::fs::symlink(&fixture.0, &parent_alias).unwrap();
        assert_overlapping(&media, &parent_alias.join("media/new-cache"));
        assert_overlapping(
            &parent_alias.join("cache/new-media"),
            &fixture.path("cache"),
        );
        distinct_roots(&media, &parent_alias.join("cache/new-cache")).unwrap();
        assert!(!alias.join("not-created").exists());
        assert!(!fixture.path("cache").exists());
        let deep_alias = fixture.path("deep-alias");
        std::os::unix::fs::symlink(&nested, &deep_alias).unwrap();
        assert_overlapping(&media, &deep_alias.join(".."));
        assert!(distinct_roots(&media, &fixture.path("missing/../media")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn canonical_paths_fail_closed_for_dangling_symlinks() {
        let fixture = RootFixture::new();
        let media = fixture.directory("media");
        let alias = fixture.path("dangling-alias");
        std::os::unix::fs::symlink(fixture.path("missing"), &alias).unwrap();
        assert!(distinct_roots(&media, &alias).is_err());
        assert!(distinct_roots(&media, &alias.join("cache")).is_err());
        assert!(distinct_roots(&media, &alias.join(".")).is_err());
        assert!(distinct_roots(&media, Path::new(&format!("{}/", alias.display()))).is_err());
    }

    #[test]
    fn server_and_worker_reject_overlapping_roots_without_touching_media() {
        let fixture = RootFixture::new();
        let cache = fixture.directory("cache");
        let media = fixture.directory(&format!("cache/{}", uuid::Uuid::new_v4()));
        let sentinel = media.join("original-media.sentinel");
        std::fs::write(&sentinel, b"owned disposable original-media fixture").unwrap();
        for role in [Role::Server, Role::Worker] {
            for (media, cache) in [(&media, &cache), (&cache, &media)] {
                let error = Settings::read(role, |name| match name {
                    "MEDIA_ROOT" => Some(media.to_str().unwrap().into()),
                    "CACHE_ROOT" => Some(cache.to_str().unwrap().into()),
                    "SOURCE_ENCRYPTION_KEY" => Some("checked-by-caller".into()),
                    _ => None,
                })
                .unwrap_err()
                .to_string();
                assert!(error.contains("must not resolve to overlapping directories"));
            }
        }
        assert_eq!(
            std::fs::read(&sentinel).unwrap(),
            b"owned disposable original-media fixture"
        );
    }

    #[test]
    fn server_and_worker_validate_default_media_root_too() {
        for role in [Role::Server, Role::Worker] {
            let error = Settings::read(role, |name| match name {
                "CACHE_ROOT" => Some("/media/cache".into()),
                "SOURCE_ENCRYPTION_KEY" => Some("checked-by-caller".into()),
                _ => None,
            })
            .unwrap_err()
            .to_string();
            assert!(error.contains("must not resolve to overlapping directories"));
        }
    }

    #[test]
    fn agent_receipt_recovery_keeps_its_existing_missing_media_contract() {
        let fixture = RootFixture::new();
        let missing = fixture.path("missing-media");
        Settings::read(Role::Agent, |name| match name {
            "SERVER_URL" => Some("http://localhost:8080".into()),
            "MEDIA_ROOT" | "CACHE_ROOT" => Some(missing.to_str().unwrap().into()),
            _ => None,
        })
        .unwrap();
        assert!(!missing.exists());
    }
}
