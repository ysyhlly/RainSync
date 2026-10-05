use anyhow::{Result, ensure};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, time::Duration};

/// Compilation, device visibility and validated execution are separate facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeQualification {
    Unvalidated,
    OutputValidated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceObservation {
    pub nvenc_device_present: bool,
    /// Constructed only from observed Linux character-device render nodes.
    pub vaapi_render_node: Option<String>,
    /// QSV requires an observed Intel node, not any arbitrary DRM adapter.
    pub qsv_render_node: Option<String>,
}
impl DeviceObservation {
    pub fn observe() -> Self {
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::FileTypeExt;
            let character = |path: &str| {
                std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_char_device())
            };
            let mut vaapi = None;
            let mut qsv = None;
            for n in 128..=191 {
                let node = format!("/dev/dri/renderD{n}");
                if !character(&node) {
                    continue;
                }
                if vaapi.is_none() {
                    vaapi = Some(node.clone());
                }
                if qsv.is_none()
                    && std::fs::read_to_string(format!("/sys/class/drm/renderD{n}/device/vendor"))
                        .is_ok_and(|v| v.trim() == "0x8086")
                {
                    qsv = Some(node);
                }
            }
            Self {
                nvenc_device_present: character("/dev/nvidiactl")
                    && (0..32).any(|n| character(&format!("/dev/nvidia{n}"))),
                vaapi_render_node: vaapi,
                qsv_render_node: qsv,
            }
        }
        #[cfg(not(target_os = "linux"))]
        Self {
            nvenc_device_present: false,
            vaapi_render_node: None,
            qsv_render_node: None,
        }
    }
}

/// Reports from the executable itself, not its filename or build assumptions.
#[derive(Debug, Clone, Serialize)]
pub struct Inventory {
    encoders: BTreeSet<String>,
    filters: BTreeSet<String>,
    decoders: BTreeSet<String>,
    pub build_report_sha256: String,
    pub devices: DeviceObservation,
}
impl Inventory {
    pub fn from_reports(
        encoders: &str,
        filters: &str,
        decoders: &str,
        version: &str,
        devices: DeviceObservation,
    ) -> Result<Self> {
        ensure!(
            [encoders, filters, decoders, version]
                .iter()
                .all(|s| s.len() <= 1024 * 1024),
            "advanced_media_inventory_too_large"
        );
        ensure!(
            version.starts_with("ffmpeg version "),
            "advanced_media_inventory_invalid"
        );
        let parse = |report: &str, width: usize| -> BTreeSet<String> {
            report
                .lines()
                .filter_map(|line| {
                    let mut fields = line.split_whitespace();
                    let flags = fields.next()?;
                    let name = fields.next()?;
                    (flags.len() == width
                        && flags.bytes().all(|b| b.is_ascii_uppercase() || b == b'.')
                        && name != "="
                        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
                    .then(|| name.to_owned())
                })
                .collect()
        };
        let mut digest = Sha256::new();
        for report in [version, encoders, filters, decoders] {
            digest.update((report.len() as u64).to_le_bytes());
            digest.update(report);
        }
        Ok(Self {
            encoders: parse(encoders, 6),
            filters: parse(filters, 3),
            decoders: parse(decoders, 6),
            build_report_sha256: format!("{:x}", digest.finalize()),
            devices,
        })
    }
    pub async fn inspect() -> Result<Self> {
        async fn report(option: &str) -> Result<String> {
            let mut command = tokio::process::Command::new("ffmpeg");
            crate::input_policy::clean_environment(&mut command);
            command
                .args(["-hide_banner", option])
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            let (status, bytes) =
                crate::child_process::capture(command, Duration::from_secs(5), 1024 * 1024).await?;
            ensure!(status.success(), "advanced_media_inventory_failed");
            Ok(String::from_utf8(bytes)?)
        }
        let version = report("-version").await?;
        let encoders = report("-encoders").await?;
        let filters = report("-filters").await?;
        let decoders = report("-decoders").await?;
        let devices =
            crate::child_process::blocking(
                || Ok::<_, std::io::Error>(DeviceObservation::observe()),
            )
            .await??;
        Self::from_reports(&encoders, &filters, &decoders, &version, devices)
    }
    pub fn encoder(&self, name: &str) -> bool {
        self.encoders.contains(name)
    }
    pub fn filter(&self, name: &str) -> bool {
        self.filters.contains(name)
    }
    pub fn decoder(&self, name: &str) -> bool {
        self.decoders.contains(name)
    }
    pub(super) fn require_filters(&self, filters: &[&str]) -> Result<()> {
        ensure!(
            filters.iter().all(|name| self.filter(name)),
            "advanced_media_filter_unavailable"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_names_and_descriptions_do_not_claim_compiled_support() {
        let no_devices = DeviceObservation {
            nvenc_device_present: false,
            vaapi_render_node: None,
            qsv_render_node: None,
        };
        let inventory = Inventory::from_reports(
            " V....D libx264 real encoder\n h264_nvenc in a description\n V..... = video",
            " ... scale V->V\n ... tonemap V->V",
            " S..... ass text",
            "ffmpeg version fixture",
            no_devices,
        )
        .unwrap();
        assert!(inventory.encoder("libx264"));
        assert!(!inventory.encoder("h264_nvenc"));
        assert!(inventory.filter("tonemap"));
        assert!(!inventory.filter("zscale"));
        assert!(inventory.decoder("ass"));
    }
}
