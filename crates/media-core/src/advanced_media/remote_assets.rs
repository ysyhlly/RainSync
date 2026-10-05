//! Source-owner-declared HTTP siblings and version-bound NAS associations.
use super::{
    AssetCatalog, EXTERNAL_ASS_INDEX, EXTERNAL_PGS_INDEX, EXTERNAL_SSA_INDEX, MAX_ASSET_BYTES,
    SubtitleKind,
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub const REMOTE_ASSET_KIND: &str = "remote_asset_transcode_v1";
pub const REMOTE_ASSET_QUEUE: &str = "remote_assets_v1";
pub const HTTP_ASSET_SOURCE: &str = "http-source.mkv";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HttpAssetAssociation {
    pub schema_version: u8,
    pub subtitles: Vec<SubtitleKind>,
    pub fonts: Vec<String>,
}
fn font_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && name.rsplit_once('.').is_some_and(|(_, ext)| {
            matches!(ext.to_ascii_lowercase().as_str(), "ttf" | "otf" | "ttc")
        })
}
impl HttpAssetAssociation {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == 1 && self.subtitles.len() <= 3 && self.fonts.len() <= 64,
            "advanced_asset_bound"
        );
        let mut seen = std::collections::BTreeSet::new();
        for kind in &self.subtitles {
            ensure!(seen.insert(format!("{kind:?}")), "advanced_asset_invalid");
        }
        seen.clear();
        for font in &self.fonts {
            ensure!(
                font_name(font) && seen.insert(font.clone()),
                "advanced_font_association_required"
            );
        }
        Ok(())
    }
    pub fn resources(&self) -> Result<Vec<(String, Option<SubtitleKind>)>> {
        self.validate()?;
        let mut files = Vec::new();
        for kind in &self.subtitles {
            let ext = match kind {
                SubtitleKind::Ass => "ass",
                SubtitleKind::Ssa => "ssa",
                SubtitleKind::Pgs => "sup",
            };
            files.push((format!("http-source.{ext}"), Some(*kind)));
        }
        for font in &self.fonts {
            files.push((format!("http-source.fonts/{font}"), None));
        }
        Ok(files)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HttpAssetPin {
    pub resource: String,
    pub etag: String,
    pub bytes: u64,
    pub content_sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HttpSourcePin {
    pub etag: String,
    pub bytes: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteAssetCatalog {
    pub schema_version: u8,
    pub source_kind: String,
    pub source_resource: String,
    pub source_version: String,
    pub catalog: AssetCatalog,
    pub source_http: Option<HttpSourcePin>,
    pub http_files: Vec<HttpAssetPin>,
}
pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn http_version(value: &str) -> bool {
    value.strip_prefix("http-v1:").is_some_and(digest)
}
pub fn strong_etag(value: &str) -> bool {
    value.len() >= 2
        && value.len() <= 1024
        && value.starts_with('"')
        && value.ends_with('"')
        && value.as_bytes()[1..value.len() - 1]
            .iter()
            .all(|b| *b == 0x21 || (0x23..=0x7e).contains(b) || *b >= 0x80)
}
pub fn source_http_version(resource: &str, pin: &HttpSourcePin) -> Result<String> {
    Ok(format!(
        "http-v1:{}",
        sha256(&serde_json::to_vec(&(resource, pin))?)
    ))
}
/// Only derive the declared adjacent extension or immediate same-stem fonts.
/// Queries remain byte-for-byte bound; credentials and encoded escapes fail.
pub fn http_asset_url(source: &str, resource: &str) -> Result<String> {
    let mut url = url::Url::parse(source)?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none(),
        "advanced_asset_association_required"
    );
    let path = url.path();
    let lower = path.to_ascii_lowercase();
    ensure!(
        !["%2f", "%5c", "%2e"].iter().any(|v| lower.contains(v)) && !path.contains(['\\', ';']),
        "advanced_asset_association_required"
    );
    let (directory, file) = path
        .rsplit_once('/')
        .ok_or_else(|| anyhow::anyhow!("advanced_asset_association_required"))?;
    let (stem, ext) = file
        .rsplit_once('.')
        .ok_or_else(|| anyhow::anyhow!("advanced_asset_association_required"))?;
    ensure!(
        !stem.is_empty()
            && matches!(
                ext.to_ascii_lowercase().as_str(),
                "mkv" | "mp4" | "mov" | "m4v" | "webm"
            ),
        "advanced_asset_association_required"
    );
    let suffix = if let Some(ext) = resource
        .strip_prefix("http-source.")
        .filter(|v| matches!(*v, "ass" | "ssa" | "sup"))
    {
        format!(".{ext}")
    } else if let Some(name) = resource
        .strip_prefix("http-source.fonts/")
        .filter(|v| font_name(v))
    {
        format!(".fonts/{name}")
    } else {
        anyhow::bail!("advanced_asset_association_required")
    };
    let next = format!("{directory}/{stem}{suffix}");
    url.set_path(&next);
    Ok(url.to_string())
}
impl RemoteAssetCatalog {
    pub fn validate(&self, kind: &str, resource: &str, version: Option<&str>) -> Result<()> {
        ensure!(
            self.schema_version == 1
                && self.source_kind == kind
                && self.source_resource == resource
                && matches!(kind, "http" | "agent"),
            "advanced_asset_source_binding_required"
        );
        self.catalog
            .validate(&self.catalog.source_resource, &self.catalog.source_version)?;
        ensure!(
            self.catalog.bytes() <= MAX_ASSET_BYTES,
            "advanced_asset_bound"
        );
        if kind == "agent" {
            ensure!(
                self.source_http.is_none()
                    && self.http_files.is_empty()
                    && version == Some(self.source_version.as_str())
                    && self.catalog.schema_version == 1
                    && self.catalog.source_resource == resource
                    && self.catalog.source_version == self.source_version,
                "advanced_asset_source_binding_required"
            );
        } else {
            let pin = self
                .source_http
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("source_version_required"))?;
            ensure!(
                version.is_none()
                    && strong_etag(&pin.etag)
                    && (1..=2147483648).contains(&pin.bytes)
                    && self.catalog.schema_version == 2
                    && self.catalog.source_resource == HTTP_ASSET_SOURCE
                    && self.source_version == source_http_version(resource, pin)?
                    && self.catalog.source_version == self.source_version,
                "advanced_asset_source_binding_required"
            );
            let files = self.files();
            ensure!(
                files.len() == self.http_files.len(),
                "advanced_asset_source_binding_required"
            );
            for (file, pin) in files.into_iter().zip(&self.http_files) {
                http_asset_url(resource, &file.resource)?;
                ensure!(
                    pin.resource == file.resource
                        && strong_etag(&pin.etag)
                        && pin.bytes == file.bytes
                        && digest(&pin.content_sha256)
                        && file.source_version == format!("http-v1:{}", pin.content_sha256),
                    "advanced_asset_source_binding_required"
                );
            }
        }
        Ok(())
    }
    pub fn files(&self) -> Vec<&super::AssetFile> {
        self.catalog
            .subtitles
            .iter()
            .map(|s| &s.file)
            .chain(self.catalog.fonts.iter())
            .collect()
    }
    pub fn fingerprint(&self) -> Result<String> {
        Ok(sha256(&serde_json::to_vec(self)?))
    }
    pub fn subtitle_index(kind: SubtitleKind) -> u32 {
        match kind {
            SubtitleKind::Ass => EXTERNAL_ASS_INDEX,
            SubtitleKind::Ssa => EXTERNAL_SSA_INDEX,
            SubtitleKind::Pgs => EXTERNAL_PGS_INDEX,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn associations_are_closed() {
        let c = HttpAssetAssociation {
            schema_version: 1,
            subtitles: vec![SubtitleKind::Ass, SubtitleKind::Pgs],
            fonts: vec!["body.ttf".into()],
        };
        assert_eq!(c.resources().unwrap().len(), 3);
        assert_eq!(
            http_asset_url(
                "https://media.test/movies/a.mkv?token=opaque",
                "http-source.ass"
            )
            .unwrap(),
            "https://media.test/movies/a.ass?token=opaque"
        );
        assert_eq!(
            http_asset_url(
                "https://media.test/movies/a.mkv",
                "http-source.fonts/body.ttf"
            )
            .unwrap(),
            "https://media.test/movies/a.fonts/body.ttf"
        );
        for bad in [
            "https://evil.test/a.ass",
            "../a.ass",
            "http-source.fonts/../body.ttf",
            "http-source.fonts/encoded%2f.ttf",
        ] {
            assert!(http_asset_url("https://media.test/a.mkv", bad).is_err());
        }
        let mut bad = c;
        bad.fonts = vec!["../borrowed.ttf".into()];
        assert!(bad.validate().is_err());
    }
    #[test]
    fn weak_etags_and_credential_urls_fail() {
        assert!(!strong_etag("W/\"a\""));
        assert!(!strong_etag("\"a\r\n\""));
        assert!(http_asset_url("https://user:secret@media.test/a.mkv", "http-source.ass").is_err());
        assert!(http_asset_url("https://media.test/a%2fm.mkv", "http-source.ass").is_err());
    }
}

#[cfg(test)]
mod binding_tests {
    use super::*;
    #[test]
    fn immutable_remote_binding_and_catalog_pin_cannot_be_borrowed() {
        let resource = "https://owned.test/m/a.mkv?opaque=1";
        let source_http = HttpSourcePin {
            etag: "\"source\"".into(),
            bytes: 100,
        };
        let version = source_http_version(resource, &source_http).unwrap();
        let digest = sha256(b"[Script Info]\n[Events]\nFormat: Layer, Text\n");
        let mut remote = RemoteAssetCatalog {
            schema_version: 1,
            source_kind: "http".into(),
            source_resource: resource.into(),
            source_version: version.clone(),
            catalog: AssetCatalog {
                schema_version: 2,
                source_resource: HTTP_ASSET_SOURCE.into(),
                source_version: version,
                subtitles: vec![super::super::SubtitleAsset {
                    index: EXTERNAL_ASS_INDEX,
                    kind: SubtitleKind::Ass,
                    file: super::super::AssetFile {
                        resource: "http-source.ass".into(),
                        source_version: format!("http-v1:{digest}"),
                        bytes: 40,
                    },
                }],
                fonts: vec![],
            },
            source_http: Some(source_http),
            http_files: vec![HttpAssetPin {
                resource: "http-source.ass".into(),
                etag: "\"asset\"".into(),
                bytes: 40,
                content_sha256: digest,
            }],
        };
        remote.validate("http", resource, None).unwrap();
        let original = remote.fingerprint().unwrap();
        assert!(
            remote
                .validate("http", "https://owned.test/m/b.mkv?opaque=1", None)
                .is_err()
        );
        assert!(remote.validate("agent", resource, None).is_err());
        remote.http_files[0].content_sha256 = "0".repeat(64);
        assert!(remote.validate("http", resource, None).is_err());
        assert_ne!(remote.fingerprint().unwrap(), original);
    }
}
