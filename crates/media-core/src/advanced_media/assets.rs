//! External subtitles/fonts are a finite source association, never a path or
//! fontsdir supplied by the browser or read from a subtitle's content.
use super::{
    OwnedLocalInput,
    asset_contract::{
        AssetCatalog, AssetFile, EXTERNAL_ASS_INDEX, EXTERNAL_PGS_INDEX, EXTERNAL_SSA_INDEX,
        MAX_FONT_BYTES, MAX_SUBTITLE_BYTES, SubtitleAsset, SubtitleKind, associated,
        font_directory, relative,
    },
};
use anyhow::{Result, ensure};
#[cfg(test)]
use std::fs::File;
use std::{
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
};
fn asset_path(root: &Path, resource: &str, directory: bool) -> Result<PathBuf> {
    ensure!(relative(resource), "advanced_asset_association_required");
    let root = crate::local_media_root(root)?;
    let mut at = root.clone();
    for component in Path::new(resource).components() {
        at.push(component);
        ensure!(
            !std::fs::symlink_metadata(&at)?.file_type().is_symlink(),
            "advanced_asset_symlink_unsupported"
        );
    }
    let path = at.canonicalize()?;
    ensure!(
        path.starts_with(&root)
            && if directory {
                path.is_dir()
            } else {
                path.is_file()
            },
        "advanced_asset_association_required"
    );
    Ok(path)
}
impl AssetCatalog {
    pub fn verify_files(&self, root: &Path) -> Result<()> {
        self.validate(&self.source_resource, &self.source_version)?;
        for f in self
            .subtitles
            .iter()
            .map(|s| &s.file)
            .chain(self.fonts.iter())
        {
            asset_path(root, &f.resource, false)?;
            let owner = OwnedLocalInput::open(root, &f.resource, &f.source_version)?;
            ensure!(owner.byte_len()? == f.bytes, "source_changed");
            owner.verify()?;
        }
        Ok(())
    }
    /// Scan only deterministic adjacent names and the immediate same-stem font
    /// directory. safe_path rejects escapes, including source-root symlinks.
    pub fn discover(root: &Path, source: &str, version: &str) -> Result<Self> {
        ensure!(relative(source), "advanced_asset_association_required");
        let observe = |resource: String, max: u64| -> Result<Option<AssetFile>> {
            let path = match asset_path(root, &resource, false) {
                Ok(p) => p,
                Err(_) => return Ok(None),
            };
            let _ = path;
            let f = crate::open_local_file(root, &resource)?;
            let snap = crate::file_version::snapshot_file(&f)?;
            let bytes = f.metadata()?.len();
            ensure!(bytes > 0 && bytes <= max, "advanced_asset_bound");
            Ok(Some(AssetFile {
                resource,
                source_version: snap.version,
                bytes,
            }))
        };
        let mut subtitles = Vec::new();
        for (index, kind) in [
            (EXTERNAL_ASS_INDEX, SubtitleKind::Ass),
            (EXTERNAL_SSA_INDEX, SubtitleKind::Ssa),
            (EXTERNAL_PGS_INDEX, SubtitleKind::Pgs),
        ] {
            if let Some(file) =
                observe(associated(source, index, kind).unwrap(), MAX_SUBTITLE_BYTES)?
            {
                asset_path(root, &file.resource, false)?;
                let mut reader = crate::open_local_file(root, &file.resource)?;
                let mut bytes = Vec::new();
                std::io::Read::by_ref(&mut reader)
                    .take(MAX_SUBTITLE_BYTES + 1)
                    .read_to_end(&mut bytes)?;
                if validate_subtitle_bytes(kind, &bytes).is_ok() {
                    subtitles.push(SubtitleAsset { index, kind, file });
                }
            }
        }
        let mut fonts = Vec::new();
        let relative_dir = font_directory(source);
        if let Ok(path) = asset_path(root, &relative_dir.to_string_lossy(), true) {
            let directory = crate::open_local_directory(root, &relative_dir.to_string_lossy())?;
            for entry in std::fs::read_dir(crate::local_process_input(&directory, &path)?)? {
                let entry = entry?;
                if !entry.file_type()?.is_file() {
                    continue;
                }
                let name = entry.file_name();
                let rel = relative_dir.join(name).to_string_lossy().into_owned();
                if Path::new(&rel)
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_none_or(|s| {
                        !matches!(s.to_ascii_lowercase().as_str(), "ttf" | "otf" | "ttc")
                    })
                {
                    continue;
                }
                ensure!(fonts.len() < 64, "advanced_asset_bound");
                if let Some(f) = observe(rel, MAX_FONT_BYTES)? {
                    asset_path(root, &f.resource, false)?;
                    let mut file = crate::open_local_file(root, &f.resource)?;
                    let mut magic = [0u8; 4];
                    if file.read_exact(&mut magic).is_ok()
                        && matches!(&magic, b"\x00\x01\x00\x00" | b"OTTO" | b"ttcf")
                    {
                        fonts.push(f);
                    }
                }
            }
        }
        fonts.sort_by(|a, b| a.resource.cmp(&b.resource));
        let catalog = Self {
            schema_version: 1,
            source_resource: source.into(),
            source_version: version.into(),
            subtitles,
            fonts,
        };
        catalog.validate(source, version)?;
        Ok(catalog)
    }
}
pub fn validate_subtitle_bytes(kind: SubtitleKind, bytes: &[u8]) -> Result<()> {
    ensure!(
        !bytes.is_empty() && bytes.len() as u64 <= MAX_SUBTITLE_BYTES,
        "advanced_asset_bound"
    );
    if matches!(kind, SubtitleKind::Ass | SubtitleKind::Ssa) {
        let text = std::str::from_utf8(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))?;
        ensure!(
            !text.contains('\0')
                && text.lines().any(|l| l.trim() == "[Script Info]")
                && text.lines().any(|l| l.trim() == "[Events]")
                && text.lines().any(|l| l.trim().starts_with("Format:"))
                && text.lines().all(|l| l.len() <= 65536),
            "advanced_subtitle_format_unsupported"
        );
    } else {
        let mut at = 0usize;
        let mut count = 0usize;
        let mut composition = false;
        let mut ended = false;
        while at < bytes.len() {
            let header = bytes
                .get(at..at + 13)
                .ok_or_else(|| anyhow::anyhow!("advanced_subtitle_format_unsupported"))?;
            ensure!(
                &header[..2] == b"PG" && matches!(header[10], 0x14 | 0x15 | 0x16 | 0x17 | 0x80),
                "advanced_subtitle_format_unsupported"
            );
            let length = u16::from_be_bytes([header[11], header[12]]) as usize;
            let payload = bytes
                .get(at + 13..at + 13 + length)
                .ok_or_else(|| anyhow::anyhow!("advanced_subtitle_format_unsupported"))?;
            match header[10] {
                0x14 => ensure!(
                    length >= 2 && (length - 2).is_multiple_of(5),
                    "advanced_subtitle_format_unsupported"
                ),
                0x15 => ensure!(length >= 4, "advanced_subtitle_format_unsupported"),
                0x16 => {
                    ensure!(
                        length >= 11
                            && (1..=16384).contains(&u16::from_be_bytes([payload[0], payload[1]]))
                            && (1..=16384).contains(&u16::from_be_bytes([payload[2], payload[3]]))
                            && matches!(payload[7], 0 | 0x40 | 0x80),
                        "advanced_subtitle_format_unsupported"
                    );
                    let mut pos = 11usize;
                    for _ in 0..payload[10] {
                        let row = payload.get(pos..pos + 8).ok_or_else(|| {
                            anyhow::anyhow!("advanced_subtitle_format_unsupported")
                        })?;
                        ensure!(row[3] & 0x3f == 0, "advanced_subtitle_format_unsupported");
                        pos += if row[3] & 0x80 != 0 { 16 } else { 8 };
                    }
                    ensure!(pos == length, "advanced_subtitle_format_unsupported");
                }
                0x17 => ensure!(
                    length >= 1 && length == 1 + 9 * payload[0] as usize,
                    "advanced_subtitle_format_unsupported"
                ),
                0x80 => ensure!(length == 0, "advanced_subtitle_format_unsupported"),
                _ => unreachable!(),
            }
            at = at
                .checked_add(13 + length)
                .ok_or_else(|| anyhow::anyhow!("advanced_asset_bound"))?;
            ensure!(at <= bytes.len(), "advanced_subtitle_format_unsupported");
            composition |= header[10] == 0x16;
            ended = header[10] == 0x80;
            count += 1;
            ensure!(count <= 262144, "advanced_asset_bound");
        }
        ensure!(composition && ended, "advanced_subtitle_format_unsupported");
    }
    Ok(())
}
/// The caller owns this object through positive decoder reaping. Retained
/// descriptors prevent path replacement; only verified source-associated font
/// bytes are copied into a private generated directory, with numeric filenames.
pub struct OwnedAssets {
    pub subtitle: std::sync::Arc<OwnedLocalInput>,
    fonts: Vec<std::sync::Arc<OwnedLocalInput>>,
    retained: Vec<std::sync::Arc<OwnedLocalInput>>,
    directory: PathBuf,
    fonts_only: bool,
}
impl OwnedAssets {
    pub fn open(root: &Path, catalog: &AssetCatalog, index: u32, directory: &Path) -> Result<Self> {
        Self::open_inner(root, catalog, Some(index), directory)
    }
    pub fn open_fonts(root: &Path, catalog: &AssetCatalog, directory: &Path) -> Result<Self> {
        Self::open_inner(root, catalog, None, directory)
    }
    pub fn fonts_only(&self) -> bool {
        self.fonts_only
    }
    fn open_inner(
        root: &Path,
        catalog: &AssetCatalog,
        index: Option<u32>,
        directory: &Path,
    ) -> Result<Self> {
        catalog.validate(&catalog.source_resource, &catalog.source_version)?;
        let subtitle = if let Some(index) = index {
            let selected = catalog.selected(index)?;
            asset_path(root, &selected.file.resource, false)?;
            let subtitle = OwnedLocalInput::open(
                root,
                &selected.file.resource,
                &selected.file.source_version,
            )?;
            ensure!(
                subtitle.byte_len()? == selected.file.bytes,
                "source_changed"
            );
            let mut reader = subtitle.duplicate_file()?;
            let mut bytes = Vec::with_capacity(selected.file.bytes as usize);
            std::io::Read::by_ref(&mut reader)
                .take(MAX_SUBTITLE_BYTES + 1)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() as u64 == selected.file.bytes, "source_changed");
            validate_subtitle_bytes(selected.kind, &bytes)?;
            subtitle
        } else {
            ensure!(!catalog.fonts.is_empty(), "advanced_font_custody_required");
            OwnedLocalInput::open(root, &catalog.source_resource, &catalog.source_version)?
        };
        ensure!(!directory.exists() && directory.is_absolute() && directory.to_str().is_some_and(|s|!s.contains(['\0','\r','\n','\'',':',',',';','[',']'])) ,"advanced_asset_directory_invalid");
        std::fs::create_dir(directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
        }
        let mut owner = Self {
            subtitle: std::sync::Arc::new(subtitle),
            fonts: Vec::new(),
            retained: Vec::new(),
            directory: directory.into(),
            fonts_only: index.is_none(),
        };
        for (i, asset) in catalog.fonts.iter().enumerate() {
            asset_path(root, &asset.resource, false)?;
            let input = OwnedLocalInput::open(root, &asset.resource, &asset.source_version)?;
            ensure!(input.byte_len()? == asset.bytes, "source_changed");
            let mut reader = input.duplicate_file()?;
            let mut magic = [0u8; 4];
            reader.read_exact(&mut magic)?;
            ensure!(
                matches!(&magic, b"\x00\x01\x00\x00" | b"OTTO" | b"ttcf"),
                "advanced_font_format_unsupported"
            );
            let mut out = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(owner.directory.join(format!(
                        "font-{i}.{}",
                        Path::new(&asset.resource)
                            .extension()
                            .unwrap()
                            .to_string_lossy()
                    )))?;
            out.write_all(&magic)?;
            let n = std::io::copy(&mut reader.take(MAX_FONT_BYTES), &mut out)? + 4;
            ensure!(n == asset.bytes, "source_changed");
            input.verify()?;
            owner.fonts.push(std::sync::Arc::new(input));
        }
        owner.verify()?;
        Ok(owner)
    }
    /// Materialized gateway bytes are already source-bound and fingerprinted.
    /// Keep every held file plus generated fonts through positive child reaping.
    pub fn from_materialized(
        catalog: &AssetCatalog,
        index: Option<u32>,
        source: std::sync::Arc<OwnedLocalInput>,
        held: Vec<std::sync::Arc<OwnedLocalInput>>,
        directory: &Path,
    ) -> Result<Self> {
        catalog.validate(&catalog.source_resource, &catalog.source_version)?;
        let files = catalog
            .subtitles
            .iter()
            .map(|s| &s.file)
            .chain(catalog.fonts.iter())
            .collect::<Vec<_>>();
        ensure!(files.len() == held.len(), "advanced_asset_custody_required");
        for (file, owner) in files.iter().zip(&held) {
            owner.verify()?;
            ensure!(owner.byte_len()? == file.bytes, "source_changed");
        }
        let subtitle = if let Some(index) = index {
            let position = catalog
                .subtitles
                .iter()
                .position(|s| s.index == index)
                .ok_or_else(|| anyhow::anyhow!("invalid_subtitle_track"))?;
            let selected = &catalog.subtitles[position];
            let mut reader = held[position].duplicate_file()?;
            reader.rewind()?;
            let mut bytes = Vec::new();
            reader
                .take(MAX_SUBTITLE_BYTES + 1)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() as u64 == selected.file.bytes, "source_changed");
            validate_subtitle_bytes(selected.kind, &bytes)?;
            held[position].clone()
        } else {
            ensure!(!catalog.fonts.is_empty(), "advanced_font_custody_required");
            source
        };
        ensure!(!directory.exists() && directory.is_absolute() && directory.to_str().is_some_and(|s|!s.contains(['\0','\r','\n','\'',':',',',';','[',']'])), "advanced_asset_directory_invalid");
        std::fs::create_dir(directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
        }
        let mut owner = Self {
            subtitle,
            fonts: Vec::new(),
            retained: held.clone(),
            directory: directory.into(),
            fonts_only: index.is_none(),
        };
        for (i, asset) in catalog.fonts.iter().enumerate() {
            let input = held[catalog.subtitles.len() + i].clone();
            let mut reader = input.duplicate_file()?;
            reader.rewind()?;
            let mut magic = [0u8; 4];
            reader.read_exact(&mut magic)?;
            ensure!(
                matches!(&magic, b"\x00\x01\x00\x00" | b"OTTO" | b"ttcf"),
                "advanced_font_format_unsupported"
            );
            let extension = Path::new(&asset.resource)
                .extension()
                .unwrap()
                .to_string_lossy()
                .to_ascii_lowercase();
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut out = options.open(owner.directory.join(format!("font-{i}.{extension}")))?;
            out.write_all(&magic)?;
            ensure!(
                std::io::copy(&mut reader.take(MAX_FONT_BYTES), &mut out)? + 4 == asset.bytes,
                "source_changed"
            );
            out.flush()?;
            input.verify()?;
            owner.fonts.push(input);
        }
        owner.verify()?;
        Ok(owner)
    }
    pub fn verify(&self) -> Result<()> {
        self.subtitle.verify()?;
        for f in self.fonts.iter().chain(self.retained.iter()) {
            f.verify()?;
        }
        Ok(())
    }
    pub fn install(&self, command: &mut tokio::process::Command) -> Result<()> {
        self.verify()?;
        self.subtitle.install(command)
    }
    pub fn fonts_directory(&self) -> Result<&str> {
        self.directory
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("advanced_asset_directory_invalid"))
    }
}
impl Drop for OwnedAssets {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn associations_cannot_escape_or_borrow_another_source() {
        let version = format!("stat-v1:{}", "a".repeat(64));
        let mut c = AssetCatalog {
            schema_version: 1,
            source_resource: "movies/a.mkv".into(),
            source_version: version.clone(),
            subtitles: vec![SubtitleAsset {
                index: EXTERNAL_ASS_INDEX,
                kind: SubtitleKind::Ass,
                file: AssetFile {
                    resource: "movies/a.ass".into(),
                    source_version: version.clone(),
                    bytes: 10,
                },
            }],
            fonts: vec![AssetFile {
                resource: "movies/a.fonts/body.ttf".into(),
                source_version: version.clone(),
                bytes: 100,
            }],
        };
        c.validate("movies/a.mkv", &version).unwrap();
        for bad in [
            "../secret.ass",
            "movies/b.ass",
            "https://example.invalid/a.ass",
            "/etc/passwd",
        ] {
            c.subtitles[0].file.resource = bad.into();
            assert!(c.validate("movies/a.mkv", &version).is_err());
        }
    }
}

#[cfg(test)]
mod content_tests {
    use super::*;

    fn isolated_asset_root() -> Option<PathBuf> {
        const CHILD_ROOT: &str = "RAINSYNC_ADVANCED_ASSETS_CHILD_ROOT";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            return Some(PathBuf::from(root).join("source"));
        }
        let temp = std::env::temp_dir();
        let root = temp.join(format!("rainsync-assets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "advanced_media::assets::content_tests::owned_assets_copy_only_bound_fonts_and_detect_replacement",
                "--nocapture",
            ])
            .env(CHILD_ROOT, &root)
            .env("MEDIA_ROOT", &root)
            .output();
        assert!(root.starts_with(temp));
        let cleanup = std::fs::remove_dir_all(root);
        let output = output.expect("isolated asset fixture process");
        assert!(
            output.status.success(),
            "isolated asset fixture failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
        cleanup.unwrap();
        None
    }

    #[test]
    fn format_checks_are_bounded_and_do_not_resolve_references() {
        assert!(validate_subtitle_bytes(SubtitleKind::Ass,b"[Script Info]\n[V4+ Styles]\nFormat: Name, Fontname\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n").is_ok());
        assert!(
            validate_subtitle_bytes(SubtitleKind::Ass, b"https://example.invalid/sub.ass").is_err()
        );
        assert!(validate_subtitle_bytes(SubtitleKind::Pgs, b"PG").is_err());
        let mut pgs = b"PG\0\0\0\0\0\0\0\0\x16\0\x0b\x07\x80\x04\x38\x10\0\0\x80\0\0\0".to_vec();
        pgs.extend_from_slice(b"PG\0\0\0\0\0\0\0\0\x80\0\0");
        assert!(validate_subtitle_bytes(SubtitleKind::Pgs, &pgs).is_ok());
        let mut bad = pgs.clone();
        bad[10] = 0x99;
        assert!(validate_subtitle_bytes(SubtitleKind::Pgs, &bad).is_err());
        pgs.pop();
        assert!(validate_subtitle_bytes(SubtitleKind::Pgs, &pgs).is_err());
    }
    #[test]
    fn owned_assets_copy_only_bound_fonts_and_detect_replacement() {
        if !cfg!(target_os = "linux") {
            return;
        }
        let Some(root) = isolated_asset_root() else {
            return;
        };
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a.mkv"), b"source fixture").unwrap();
        std::fs::write(
            root.join("a.ass"),
            b"[Script Info]\n[Events]\nFormat: Layer, Text\n",
        )
        .unwrap();
        std::fs::create_dir(root.join("a.fonts")).unwrap();
        std::fs::write(root.join("a.fonts/body.ttf"), b"\0\x01\0\0font fixture").unwrap();
        let version = crate::file_version::snapshot_file(&File::open(root.join("a.mkv")).unwrap())
            .unwrap()
            .version;
        let catalog = AssetCatalog::discover(&root, "a.mkv", &version).unwrap();
        assert_eq!(catalog.fonts.len(), 1);
        let assets = OwnedAssets::open(
            &root,
            &catalog,
            EXTERNAL_ASS_INDEX,
            &root.join("owned-fonts"),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(root.join("owned-fonts/font-0.ttf")).unwrap(),
            b"\0\x01\0\0font fixture"
        );
        std::fs::write(root.join("a.fonts/body.ttf"), b"changed").unwrap();
        assert!(assets.verify().is_err());
        drop(assets);
        assert!(!root.join("owned-fonts").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod remote_custody_tests {
    use super::*;
    use std::sync::Arc;
    fn held(path: &Path, bytes: &[u8]) -> Arc<OwnedLocalInput> {
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
        file.flush().unwrap();
        Arc::new(OwnedLocalInput::materialized(file, path.into()).unwrap())
    }
    #[test]
    fn materialized_asset_and_font_custody_lasts_until_last_owner_and_rejects_changes() {
        let root =
            std::env::temp_dir().join(format!("rainsync-remote-custody-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = held(&root.join("held-source.bin"), b"source fixture");
        let text = b"[Script Info]\n[Events]\nFormat: Layer, Text\n";
        let font = b"\0\x01\0\0font fixture";
        let subtitle = held(&root.join("held-asset-0.bin"), text);
        let font_owner = held(&root.join("held-asset-1.bin"), font);
        let version = format!("http-v1:{}", "a".repeat(64));
        let catalog = AssetCatalog {
            schema_version: 2,
            source_resource: "http-source.mkv".into(),
            source_version: version.clone(),
            subtitles: vec![SubtitleAsset {
                index: EXTERNAL_ASS_INDEX,
                kind: SubtitleKind::Ass,
                file: AssetFile {
                    resource: "http-source.ass".into(),
                    source_version: format!("http-v1:{}", super::super::asset_sha256(text)),
                    bytes: text.len() as u64,
                },
            }],
            fonts: vec![AssetFile {
                resource: "http-source.fonts/body.ttf".into(),
                source_version: format!("http-v1:{}", super::super::asset_sha256(font)),
                bytes: font.len() as u64,
            }],
        };
        let custody = Arc::new(
            OwnedAssets::from_materialized(
                &catalog,
                Some(EXTERNAL_ASS_INDEX),
                source.clone(),
                vec![subtitle.clone(), font_owner.clone()],
                &root.join("owned-fonts"),
            )
            .unwrap(),
        );
        assert_eq!(
            std::fs::read(root.join("owned-fonts/font-0.ttf")).unwrap(),
            font
        );
        let child_owner = custody.clone();
        drop(custody);
        drop(subtitle);
        drop(font_owner);
        assert!(root.join("owned-fonts/font-0.ttf").exists());
        assert!(root.join("held-asset-0.bin").exists());
        child_owner.verify().unwrap();
        std::fs::write(root.join("held-asset-1.bin"), b"changed").unwrap();
        assert!(child_owner.verify().is_err());
        drop(child_owner);
        assert!(!root.join("owned-fonts").exists());
        assert!(!root.join("held-asset-0.bin").exists());
        assert!(!root.join("held-asset-1.bin").exists());
        drop(source);
        assert!(!root.join("held-source.bin").exists());
        std::fs::remove_dir(root).unwrap();
    }
}
