//! Deterministic external-asset descriptions and lexical association policy.
//! Discovery and retained input custody remain in the assets module.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubtitleKind {
    Ass,
    Ssa,
    Pgs,
}

pub const HTTP_ASSET_SOURCE: &str = "http-source.mkv";
pub const EXTERNAL_ASS_INDEX: u32 = 100_002;
pub const EXTERNAL_SSA_INDEX: u32 = 100_003;
pub const EXTERNAL_PGS_INDEX: u32 = 100_004;
pub const MAX_SUBTITLE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_FONT_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetFile {
    pub resource: String,
    pub source_version: String,
    pub bytes: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubtitleAsset {
    pub index: u32,
    pub kind: SubtitleKind,
    pub file: AssetFile,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetCatalog {
    pub schema_version: u8,
    pub source_resource: String,
    pub source_version: String,
    pub subtitles: Vec<SubtitleAsset>,
    pub fonts: Vec<AssetFile>,
}
pub(super) fn relative(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains(['\\', '\0', '\r', '\n'])
        && !Path::new(value).is_absolute()
        && Path::new(value)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}
pub(super) fn font_directory(source: &str) -> PathBuf {
    let mut p = Path::new(source).with_extension("");
    let name = p.file_name().unwrap_or_default().to_string_lossy();
    p.set_file_name(format!("{name}.fonts"));
    p
}
pub(super) fn associated(source: &str, index: u32, kind: SubtitleKind) -> Option<String> {
    let ext = match (index, kind) {
        (EXTERNAL_ASS_INDEX, SubtitleKind::Ass) => "ass",
        (EXTERNAL_SSA_INDEX, SubtitleKind::Ssa) => "ssa",
        (EXTERNAL_PGS_INDEX, SubtitleKind::Pgs) => "sup",
        _ => return None,
    };
    Some(
        Path::new(source)
            .with_extension(ext)
            .to_string_lossy()
            .into(),
    )
}

pub(super) fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn http_version(value: &str) -> bool {
    value.strip_prefix("http-v1:").is_some_and(digest)
}

impl AssetCatalog {
    pub fn validate(&self, source: &str, version: &str) -> Result<()> {
        ensure!(
            matches!(self.schema_version, 1 | 2)
                && relative(source)
                && self.source_resource == source
                && self.source_version == version
                && if self.schema_version == 1 {
                    crate::file_version::valid_file_version(version)
                } else {
                    http_version(version) && source == HTTP_ASSET_SOURCE
                },
            "advanced_asset_source_binding_required"
        );
        ensure!(
            self.subtitles.len() <= 3 && self.fonts.len() <= 64,
            "advanced_asset_bound"
        );
        let mut seen = std::collections::BTreeSet::new();
        let mut total = 0u64;
        let mut file = |f: &AssetFile, max: u64| -> Result<()> {
            ensure!(
                relative(&f.resource)
                    && seen.insert(f.resource.clone())
                    && if self.schema_version == 1 {
                        crate::file_version::valid_file_version(&f.source_version)
                    } else {
                        http_version(&f.source_version)
                    }
                    && f.bytes > 0
                    && f.bytes <= max,
                "advanced_asset_invalid"
            );
            total = total
                .checked_add(f.bytes)
                .ok_or_else(|| anyhow::anyhow!("advanced_asset_bound"))?;
            Ok(())
        };
        for s in &self.subtitles {
            ensure!(
                associated(source, s.index, s.kind).as_deref() == Some(s.file.resource.as_str()),
                "advanced_asset_association_required"
            );
            file(&s.file, MAX_SUBTITLE_BYTES)?;
        }
        let dir = font_directory(source);
        for f in &self.fonts {
            let p = Path::new(&f.resource);
            ensure!(
                p.parent() == Some(dir.as_path())
                    && p.extension()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| matches!(
                            s.to_ascii_lowercase().as_str(),
                            "ttf" | "otf" | "ttc"
                        )),
                "advanced_font_association_required"
            );
            file(f, MAX_FONT_BYTES)?;
        }
        ensure!(total <= MAX_ASSET_BYTES, "advanced_asset_bound");
        Ok(())
    }
    pub fn bytes(&self) -> u64 {
        self.subtitles
            .iter()
            .map(|s| s.file.bytes)
            .chain(self.fonts.iter().map(|f| f.bytes))
            .sum()
    }
    pub fn fingerprint(&self) -> Result<String> {
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(self)?)))
    }
    pub fn selected(&self, index: u32) -> Result<&SubtitleAsset> {
        self.subtitles
            .iter()
            .find(|s| s.index == index)
            .ok_or_else(|| anyhow::anyhow!("invalid_subtitle_track"))
    }
}
