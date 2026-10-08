use super::{Inventory, RuntimeQualification};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncoderPreference {
    #[default]
    Software,
    PreferNvenc,
    PreferQsv,
    PreferVaapi,
}
impl EncoderPreference {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "software" => Ok(Self::Software),
            "prefer_nvenc" => Ok(Self::PreferNvenc),
            "prefer_qsv" => Ok(Self::PreferQsv),
            "prefer_vaapi" => Ok(Self::PreferVaapi),
            _ => anyhow::bail!("advanced_media_encoder_preference_invalid"),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
    Software,
    Nvenc,
    Qsv,
    Vaapi,
}
impl Backend {
    pub fn encoder(self) -> &'static str {
        match self {
            Self::Software => "libx264",
            Self::Nvenc => "h264_nvenc",
            Self::Qsv => "h264_qsv",
            Self::Vaapi => "h264_vaapi",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackReason {
    EncoderNotCompiled,
    DeviceNotObserved,
    UploadFilterNotCompiled,
}
#[derive(Debug, Clone, Serialize)]
pub struct EncoderSelection {
    backend: Backend,
    qualification: RuntimeQualification,
    fallback: Option<FallbackReason>,
    render_node: Option<String>,
}
impl EncoderSelection {
    pub fn backend(&self) -> Backend {
        self.backend
    }
    pub fn qualification(&self) -> RuntimeQualification {
        self.qualification
    }
    pub fn fallback(&self) -> Option<FallbackReason> {
        self.fallback
    }
    pub fn software_recipe() -> Self {
        Self {
            backend: Backend::Software,
            qualification: RuntimeQualification::Unvalidated,
            fallback: None,
            render_node: None,
        }
    }
    pub fn choose(preference: EncoderPreference, inventory: &Inventory) -> Result<Self> {
        ensure!(inventory.encoder("libx264"), "software_encoder_unavailable");
        let backend = match preference {
            EncoderPreference::Software => Backend::Software,
            EncoderPreference::PreferNvenc => Backend::Nvenc,
            EncoderPreference::PreferQsv => Backend::Qsv,
            EncoderPreference::PreferVaapi => Backend::Vaapi,
        };
        let render_node = match backend {
            Backend::Vaapi => inventory.devices.vaapi_render_node.clone(),
            Backend::Qsv => inventory.devices.qsv_render_node.clone(),
            _ => None,
        };
        let present = match backend {
            Backend::Software => true,
            Backend::Nvenc => inventory.devices.nvenc_device_present,
            _ => render_node.is_some(),
        };
        let fallback = if !inventory.encoder(backend.encoder()) {
            Some(FallbackReason::EncoderNotCompiled)
        } else if !present {
            Some(FallbackReason::DeviceNotObserved)
        } else if matches!(backend, Backend::Vaapi | Backend::Qsv) && !inventory.filter("hwupload")
        {
            Some(FallbackReason::UploadFilterNotCompiled)
        } else {
            None
        };
        Ok(Self {
            backend: if fallback.is_some() {
                Backend::Software
            } else {
                backend
            },
            qualification: RuntimeQualification::Unvalidated,
            fallback,
            render_node,
        })
    }
    pub(super) fn initial_args(&self) -> Result<Vec<String>> {
        let mut args = Vec::new();
        if matches!(self.backend, Backend::Vaapi | Backend::Qsv) {
            let node = self
                .render_node
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("hardware_device_unavailable"))?;
            ensure!(valid_render_node(node), "hardware_device_invalid");
            args.extend(["-init_hw_device".into(), format!("vaapi=rsva:{node}")]);
            if self.backend == Backend::Qsv {
                args.extend([
                    "-init_hw_device".into(),
                    "qsv=rsqsv@rsva".into(),
                    "-filter_hw_device".into(),
                    "rsqsv".into(),
                ]);
            } else {
                args.extend(["-filter_hw_device".into(), "rsva".into()]);
            }
        }
        Ok(args)
    }
    pub(super) fn upload_filter(&self) -> &'static str {
        match self.backend {
            Backend::Qsv | Backend::Vaapi => ",format=nv12,hwupload=extra_hw_frames=32",
            _ => "",
        }
    }
    pub(super) fn output_args(&self) -> Vec<String> {
        let mut args: Vec<String> = [
            "-c:v",
            self.backend.encoder(),
            "-profile:v",
            "high",
            "-level:v",
            "3.1",
            "-maxrate",
            "4M",
            "-bufsize",
            "8M",
            "-bf",
            "0",
            "-g",
            "120",
            "-r",
            "30",
            "-fps_mode",
            "cfr",
            "-force_key_frames",
            "expr:gte(t,n_forced*4)",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let specific = match self.backend {
            Backend::Software => vec![
                "-pix_fmt",
                "yuv420p",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-sc_threshold",
                "0",
                "-keyint_min",
                "120",
            ],
            Backend::Nvenc => vec![
                "-pix_fmt",
                "yuv420p",
                "-preset",
                "p4",
                "-rc",
                "vbr",
                "-b:v",
                "3500k",
                "-forced-idr",
                "1",
                "-no-scenecut",
                "1",
            ],
            Backend::Qsv => vec![
                "-preset",
                "veryfast",
                "-b:v",
                "3500k",
                "-forced_idr",
                "1",
                "-look_ahead",
                "0",
                "-idr_interval",
                "0",
            ],
            Backend::Vaapi => vec!["-b:v", "3500k", "-rc_mode", "VBR", "-idr_interval", "0"],
        };
        args.extend(specific.into_iter().map(String::from));
        args
    }
}
fn valid_render_node(node: &str) -> bool {
    node.strip_prefix("/dev/dri/renderD").is_some_and(|n| {
        n.parse::<u16>()
            .is_ok_and(|value| (128..=191).contains(&value) && value.to_string() == n)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::advanced_media::DeviceObservation;
    fn inventory(present: bool) -> Inventory {
        Inventory::from_reports(" V....D libx264 encoder\n V....D h264_nvenc encoder\n V....D h264_qsv encoder\n V....D h264_vaapi encoder", " ... hwupload V->V", "", "ffmpeg version fixture", DeviceObservation { nvenc_device_present:present, vaapi_render_node:present.then(|| "/dev/dri/renderD128".into()), qsv_render_node:None }).unwrap()
    }
    #[test]
    fn compiled_support_is_not_a_working_device_or_validation() {
        let absent =
            EncoderSelection::choose(EncoderPreference::PreferNvenc, &inventory(false)).unwrap();
        assert_eq!(absent.backend, Backend::Software);
        assert_eq!(absent.fallback, Some(FallbackReason::DeviceNotObserved));
        let observed =
            EncoderSelection::choose(EncoderPreference::PreferNvenc, &inventory(true)).unwrap();
        assert_eq!(observed.backend, Backend::Nvenc);
        assert_eq!(observed.qualification, RuntimeQualification::Unvalidated);
        let qsv = EncoderSelection::choose(EncoderPreference::PreferQsv, &inventory(true)).unwrap();
        assert_eq!(qsv.backend, Backend::Software);
        assert!(EncoderPreference::parse("h264_nvenc -filter_complex evil").is_err());
    }
}
