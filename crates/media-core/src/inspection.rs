//! Media inspection borrows retained input custody and existing process capture.
use crate::advanced_media::OwnedLocalInput;
use anyhow::{Result, ensure};

/// A container's RPU-present flag does not prove that the decoder receives
/// dynamic metadata. Check real decoded frames on the retained descriptor
/// before a Dolby SDR preparation can reinterpret profile-5 pixel values.
pub async fn verify_dolby_vision_rpu(
    input: &OwnedLocalInput,
    meta: &serde_json::Value,
) -> Result<()> {
    let selected = crate::motion_video::select(meta)?;
    if crate::advanced_media::DolbyVisionSource::from_stream(selected.stream)?.is_none() {
        return Ok(());
    }
    let index = selected.stream["index"]
        .as_u64()
        .filter(|index| *index <= u32::MAX.into())
        .ok_or_else(|| anyhow::anyhow!("dolby_vision_stream_index_required"))?;
    let mut command = tokio::process::Command::new("ffprobe");
    crate::input_policy::clean_environment(&mut command);
    command.args(crate::input_policy::args(false, false));
    command.args([
        "-v",
        "error",
        "-show_frames",
        "-read_intervals",
        "%+#2",
        "-select_streams",
        &index.to_string(),
        "-show_entries",
        "frame=side_data_list",
        "-of",
        "json",
        &input.decoder_path()?,
    ]);
    command
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    input.install(&mut command)?;
    let (status, bytes) =
        crate::child_process::capture(command, std::time::Duration::from_secs(30), 2 * 1024 * 1024)
            .await?;
    ensure!(status.success(), "dolby_vision_rpu_probe_failed");
    let frames: serde_json::Value = serde_json::from_slice(&bytes)?;
    ensure!(
        frames["frames"]
            .as_array()
            .is_some_and(|frames| !frames.is_empty()
                && frames
                    .iter()
                    .all(
                        |frame| frame["side_data_list"].as_array().is_some_and(|rows| rows
                            .iter()
                            .any(|side| {
                                side["side_data_type"] == "Dolby Vision RPU Data"
                                    && rows.iter().any(|side| {
                                        side["side_data_type"] == "Dolby Vision Metadata"
                                    })
                            }))
                    )),
        "dolby_vision_rpu_missing"
    );
    input.verify()
}

impl OwnedLocalInput {
    /// Compatibility entry point; prefer [`crate::inspection::verify_dolby_vision_rpu`].
    pub fn verify_dolby_vision_rpu(
        &self,
        meta: &serde_json::Value,
    ) -> impl std::future::Future<Output = Result<()>> {
        verify_dolby_vision_rpu(self, meta)
    }
}
