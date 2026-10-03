use super::owned_directory::OwnedDirectory;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::process::Stdio;
use tokio::io::AsyncReadExt;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DecoderEvidence {
    pub executable_sha256: String,
    pub argv_sha256: String,
    pub manifest_sha256: String,
    pub stdout_sha256: String,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub exit_code: i32,
    pub process_tree_reaped: bool,
    pub address_space_bytes: u64,
}

#[cfg(target_os = "linux")]
pub(super) async fn decode(
    dir: &OwnedDirectory,
    process_started: &mut bool,
) -> Result<(serde_json::Value, DecoderEvidence)> {
    use std::os::fd::AsRawFd;
    let held = dir.decoder_fd_scoped().await?;
    let fd = held.as_raw_fd();
    let path = format!("/proc/self/fd/{fd}/index.m3u8");
    let args = [
        "-v",
        "error",
        "-threads",
        "1",
        "-max_alloc",
        "134217728",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "hls,mov",
        "-err_detect",
        "explode",
        "-show_packets",
        "-show_frames",
        "-show_streams",
        "-show_format",
        "-show_data",
        "-show_entries",
        "stream:format:frame=stream_index,media_type,pts,best_effort_timestamp,duration,pkt_duration,nb_samples,width,height:packet=stream_index,pts,dts,duration:packet_side_data=side_data_type,skip_samples,discard_padding",
        "-of",
        "json",
        &path,
    ];
    let executable = std::fs::canonicalize("/usr/bin/ffprobe")
        .map_err(|_| anyhow::anyhow!("static_hls_decoder_unavailable"))?;
    let hash_path = executable.clone();
    let executable_sha256 = crate::child_process::blocking(move || file_hash(&hash_path)).await??;
    let argv_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(&args)?));
    let manifest_sha256 = format!(
        "{:x}",
        Sha256::digest(dir.read_scoped("index.m3u8", super::MANIFEST_BYTES).await?)
    );
    let mut command = tokio::process::Command::new(&executable);
    crate::input_policy::clean_environment(&mut command);
    command
        .args(args)
        .env("OPENBLAS_NUM_THREADS", "1")
        .env("OMP_NUM_THREADS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Only async-signal-safe libc operations execute after fork. This descriptor
    // pins the sealed directory even if an ordinary parent path is renamed.
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            for (kind, maximum) in [
                (libc::RLIMIT_AS, 1024u64 * 1024 * 1024),
                (libc::RLIMIT_CPU, 35u64),
            ] {
                let limit = libc::rlimit {
                    rlim_cur: maximum,
                    rlim_max: maximum,
                };
                if libc::setrlimit(kind, &limit) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let (out, err, status) = capture_decoder(command, process_started).await?;
    drop(held);
    ensure!(
        status.success() && err.is_empty(),
        "static_hls_decoder_failed"
    );
    let probe =
        serde_json::from_slice(&out).map_err(|_| anyhow::anyhow!("static_hls_decoder_json"))?;
    Ok((
        probe,
        DecoderEvidence {
            executable_sha256,
            argv_sha256,
            manifest_sha256,
            stdout_sha256: format!("{:x}", Sha256::digest(&out)),
            stdout_bytes: out.len(),
            stderr_bytes: err.len(),
            exit_code: status.code().unwrap_or(-1),
            process_tree_reaped: true,
            address_space_bytes: 1024 * 1024 * 1024,
        },
    ))
}
#[cfg(not(target_os = "linux"))]
pub(super) async fn decode(
    _: &OwnedDirectory,
    _: &mut bool,
) -> Result<(serde_json::Value, DecoderEvidence)> {
    anyhow::bail!("static_hls_linux_required")
}
async fn capture_decoder(
    command: tokio::process::Command,
    process_started: &mut bool,
) -> Result<(Vec<u8>, Vec<u8>, std::process::ExitStatus)> {
    let mut child = crate::child_process::spawn(command)
        .map_err(|_| anyhow::anyhow!("static_hls_decoder_spawn"))?;
    *process_started = true;
    let stdout = child.stdout.take().expect("decoder stdout");
    let stderr = child.stderr.take().expect("decoder stderr");
    let result = tokio::try_join!(
        bounded_pipe(stdout, 16 * 1024 * 1024),
        bounded_pipe(stderr, 64 * 1024),
        async { child.wait().await.map_err(anyhow::Error::from) }
    );
    let (out, err, status) = match result {
        Ok(result) => result,
        Err(_) => {
            child
                .kill()
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_decoder_cleanup_unresolved"))?;
            anyhow::bail!("static_hls_decoder_output_or_process_failed");
        }
    };
    Ok((out, err, status))
}
async fn bounded_pipe(
    mut pipe: impl tokio::io::AsyncRead + Unpin,
    maximum: usize,
) -> Result<Vec<u8>> {
    let mut result = Vec::new();
    loop {
        let mut bytes = vec![0u8; 65536];
        let count = pipe.read(&mut bytes).await?;
        if count == 0 {
            return Ok(result);
        }
        ensure!(
            result.len() + count <= maximum,
            "static_hls_decoder_output_bound"
        );
        result.extend_from_slice(&bytes[..count]);
    }
}
fn file_hash(path: &std::path::Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Timeline success alone never classifies range or selected-audio eligibility.
/// Reuse the existing measured avcC/AAC and SDR/protected-track admission.
pub(super) fn qualify_source(
    probe: &serde_json::Value,
    selected_audio: Option<u32>,
) -> Result<serde_json::Value> {
    let video = crate::capabilities::validate_source(probe)?;
    ensure!(
        video["codec_name"] == "h264"
            && video["codec_tag_string"] == "avc1"
            && matches!(video["pix_fmt"].as_str(), Some("yuv420p" | "yuvj420p"))
            && video["bits_per_raw_sample"]
                .as_str()
                .is_none_or(|v| v == "8" || v == "0"),
        "static_hls_source_recipe"
    );
    let analysis = crate::capabilities::analyze(probe, selected_audio, 0.0)?;
    let measured = analysis
        .candidates
        .iter()
        .find(|v| v.id == "remux")
        .ok_or_else(|| anyhow::anyhow!("static_hls_source_configuration_unavailable"))?;
    ensure!(
        measured.video.width <= 1920
            && measured.video.height <= 1080
            && [25.0, 30.0].contains(&measured.video.framerate)
            && measured
                .audio
                .as_ref()
                .is_none_or(|v| v.samplerate == 48000 && matches!(v.channels.as_str(), "1" | "2")),
        "static_hls_source_recipe"
    );
    Ok(
        serde_json::json!({ "video": measured.video, "audio": measured.audio,
        "selected_audio": selected_audio, "protected_track_indicators": false,
        "color_transfer": video["color_transfer"], "pixel_format": video["pix_fmt"],
        "codec_tag": video["codec_tag_string"], "stage_a_only": true }),
    )
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stalled_and_oversized_processes_are_drained_by_the_capture_scope() {
        for mode in ["stall", "stdout", "stderr"] {
            let scope = crate::child_process::Scope::new();
            let mut command = tokio::process::Command::new("/bin/sh");
            command
                .arg("-c")
                .arg(match mode {
                    "stall" => "sleep 60 & wait",
                    "stdout" => "head -c 16777217 /dev/zero; sleep 60",
                    _ => "head -c 65537 /dev/zero >&2; sleep 60",
                })
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut launched = false;
            let result = scope
                .run(tokio::time::timeout(
                    std::time::Duration::from_millis(500),
                    capture_decoder(command, &mut launched),
                ))
                .await;
            assert!(launched);
            assert!(result.is_err() || result.unwrap().is_err());
            tokio::time::timeout(std::time::Duration::from_secs(3), scope.shutdown())
                .await
                .unwrap()
                .unwrap();
        }
    }
}
