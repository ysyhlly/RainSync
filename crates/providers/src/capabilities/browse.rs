use crate::{
    Item, SourceConfig, SourceKind, UpstreamKind, emby, jellyfin, s3, upstream_common,
    upstream_headers, validate_url,
};
use anyhow::Result;
use serde_json::json;

#[derive(Clone, Copy)]
enum BrowseKind {
    Local,
    Http,
    Upstream(UpstreamKind),
    S3,
}

/// Catalog discovery for the providers that support it. Agent catalogs are
/// submitted through their own index protocol, so no browse capability exists.
/// This object holds configuration only, never a reusable source fence.
pub struct Browse<'a> {
    kind: BrowseKind,
    config: &'a SourceConfig,
}

impl<'a> Browse<'a> {
    pub fn new(kind: SourceKind, config: &'a SourceConfig) -> Option<Self> {
        let kind = match kind {
            SourceKind::Local => BrowseKind::Local,
            SourceKind::Http => BrowseKind::Http,
            SourceKind::Jellyfin => BrowseKind::Upstream(UpstreamKind::Jellyfin),
            SourceKind::Emby => BrowseKind::Upstream(UpstreamKind::Emby),
            SourceKind::S3 => BrowseKind::S3,
            SourceKind::Agent => return None,
        };
        Some(Self { kind, config })
    }

    pub async fn list(&self) -> Result<Vec<Item>> {
        let config = self.config;
        anyhow::ensure!(
            matches!(self.kind, BrowseKind::S3) || config.s3.is_none(),
            "s3_source_kind_mismatch"
        );
        match self.kind {
            BrowseKind::Local => {
                let root = media_core::local_media_root(std::path::Path::new(&config.root))?;
                tokio::task::spawn_blocking(move || {
                    let mut stack = vec![(
                        media_core::open_local_directory(&root, "")?,
                        std::path::PathBuf::new(),
                    )];
                    let mut items = vec![];
                    while let Some((directory, relative)) = stack.pop() {
                        let input =
                            media_core::local_process_input(&directory, &root.join(&relative))?;
                        for entry in std::fs::read_dir(input)? {
                            let entry = entry?;
                            let ty = entry.file_type()?;
                            let p = relative.join(entry.file_name());
                            if ty.is_symlink() {
                                continue;
                            };
                            if ty.is_dir() {
                                stack.push((
                                    media_core::open_local_directory(&root, &p.to_string_lossy())?,
                                    p,
                                ));
                                continue;
                            };
                            let ext = p
                                .extension()
                                .and_then(|x| x.to_str())
                                .unwrap_or("")
                                .to_lowercase();
                            if ["mp4", "mkv", "webm", "mov", "m4v"].contains(&ext.as_str()) {
                                items.push(Item {
                                    title: p.file_stem().unwrap().to_string_lossy().into(),
                                    resource: p.to_string_lossy().replace('\\', "/"),
                                    duration_ms: None,
                                    metadata: json!({}),
                                });
                            }
                        }
                    }
                    Ok(items)
                })
                .await?
            }
            BrowseKind::Http => {
                validate_url(&config.url)?;
                Ok(vec![Item {
                    title: "HTTP media".into(),
                    resource: config.url.clone(),
                    duration_ms: None,
                    metadata: json!({}),
                }])
            }
            BrowseKind::Upstream(UpstreamKind::Jellyfin) => jellyfin::list_items(config).await,
            BrowseKind::Upstream(UpstreamKind::Emby) => emby::list_items(config).await,
            BrowseKind::S3 => s3::list_items(config).await,
        }
    }

    /// Retain the current integrator-owned fence for each request/page. The
    /// fence future is reacquired by the existing bounded upstream scanner;
    /// it must not be hoisted out of that loop or cached in this capability.
    pub async fn list_guarded<G, F, Fut>(&self, mut guard: F) -> Result<Vec<Item>>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<G>>,
    {
        match self.kind {
            BrowseKind::Upstream(kind) => {
                upstream_common::list_guarded(
                    self.config,
                    upstream_headers(kind.as_str(), self.config, "rainsync-library-scan")?,
                    guard,
                )
                .await
            }
            _ => {
                let _guard = guard().await?;
                self.list().await
            }
        }
    }
}
