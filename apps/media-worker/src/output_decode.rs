//! Decode the first immutable fMP4 fragment before publishing any playlist.
use crate::{
    child_process::{self, Child},
    outputs,
    process::LeaseInterrupted,
};
use anyhow::{Result, ensure};
use persistence::media_outputs::FileProof;
use std::{path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::Mutex,
};

#[derive(Debug)]
pub struct Rejected;
impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("first_segment_decode_failed")
    }
}
impl std::error::Error for Rejected {}

#[derive(Default)]
struct State {
    child: Option<Child>,
    verified: bool,
    advanced_recipe: Option<Arc<media_core::advanced_media::Recipe>>,
}

#[derive(Default)]
pub struct Gate {
    state: Mutex<State>,
}

fn qualification_command(program: &str) -> Command {
    let mut command = Command::new(program);
    // Qualification children need immutable media pipes, never the service's
    // database, encryption or administrator credentials. Apply the same policy
    // to every gate, including native compatibility and ordinary local output.
    media_core::input_policy::clean_environment(&mut command);
    command
}

async fn reap(state: &mut State) -> Result<()> {
    if let Some(child) = state.child.as_mut() {
        if child.try_wait()?.is_none() {
            child.kill().await?;
        }
        child.wait().await?;
    }
    state.child = None;
    Ok(())
}

async fn decoded_frames(stdout: impl tokio::io::AsyncRead + Unpin) -> Result<()> {
    let mut input = BufReader::new(stdout);
    let mut line = Vec::new();
    let mut bytes = 0usize;
    let mut frames = 0usize;
    loop {
        // Bound both an individual line and total diagnostic output.
        let available = input.fill_buf().await?;
        if available.is_empty() {
            break;
        }
        let n = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |n| n + 1);
        bytes += n;
        ensure!(
            bytes <= 2 * 1024 * 1024 && line.len() + n <= 4096,
            "decode_output_too_large"
        );
        line.extend_from_slice(&available[..n]);
        input.consume(n);
        if line.last() != Some(&b'\n') {
            continue;
        }
        let text = std::str::from_utf8(&line)?.trim();
        if !text.is_empty() && !text.starts_with('#') {
            let fields: Vec<_> = text.split(',').map(str::trim).collect();
            ensure!(
                fields.len() == 6
                    && fields[0].parse::<u32>().is_ok()
                    && fields[1..4].iter().all(|v| v.parse::<i64>().is_ok())
                    && fields[4].parse::<u64>().is_ok_and(|v| v > 0)
                    && fields[5].len() == 64
                    && fields[5].bytes().all(|b| b.is_ascii_hexdigit()),
                "invalid_decode_frame"
            );
            frames += 1;
        }
        line.clear();
    }
    ensure!(frames > 0 && line.is_empty(), "no_decoded_frames");
    Ok(())
}

impl Gate {
    /// Bind the expected fixed advanced recipe before the encoder starts. A
    /// live or verified gate cannot be relabeled to a different recipe.
    pub async fn configure_advanced(
        &self,
        recipe: Arc<media_core::advanced_media::Recipe>,
    ) -> Result<()> {
        let mut state = self.state.lock().await;
        ensure!(
            state.child.is_none() && !state.verified && state.advanced_recipe.is_none(),
            "advanced_media_output_gate_already_bound"
        );
        state.advanced_recipe = Some(recipe);
        Ok(())
    }
    /// The job owns this gate until cleanup. Cancelling this future leaves the
    /// child here, so the caller can explicitly kill/wait rather than orphan it.
    pub async fn verify(&self, directory: PathBuf, proofs: [FileProof; 2]) -> Result<()> {
        let mut state = self.state.lock().await;
        if state.verified {
            return Ok(());
        }
        reap(&mut state).await?;
        let work = async {
            if let Some(recipe) = state.advanced_recipe.clone() {
                let probe_directory = directory.clone();
                let probe_proofs = proofs.clone();
                let (init, segment) = media_core::child_process::blocking(move || {
                    Ok::<_, anyhow::Error>((
                        outputs::open_verified(
                            &probe_directory.join("init.mp4"),
                            &probe_proofs[0],
                        )?,
                        outputs::open_verified(
                            &probe_directory.join("index0.m4s"),
                            &probe_proofs[1],
                        )?,
                    ))
                })
                .await??;
                let mut command = qualification_command("ffprobe");
                command
                    .args([
                        "-v",
                        "error",
                        "-protocol_whitelist",
                        "pipe",
                        "-f",
                        "mp4",
                        "-i",
                        "pipe:0",
                        "-show_streams",
                        "-show_data",
                        "-of",
                        "json",
                    ])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .kill_on_drop(true);
                #[cfg(windows)]
                command.creation_flags(0x08000000);
                state.child = Some(child_process::spawn(command)?);
                let child = state.child.as_mut().unwrap();
                let stdin = child.stdin.take().unwrap();
                let stdout = child.stdout.take().unwrap();
                let (_, bytes) =
                    tokio::try_join!(feed_fragments(stdin, init, segment), async move {
                        use tokio::io::AsyncReadExt;
                        let mut bytes = Vec::new();
                        stdout
                            .take(2 * 1024 * 1024 + 1)
                            .read_to_end(&mut bytes)
                            .await?;
                        ensure!(
                            bytes.len() <= 2 * 1024 * 1024,
                            "advanced_media_output_probe_too_large"
                        );
                        Ok::<_, anyhow::Error>(bytes)
                    })?;
                ensure!(
                    child.wait().await?.success(),
                    "advanced_media_output_probe_failed"
                );
                recipe.validate_output_probe(&serde_json::from_slice(&bytes)?)?;
                reap(&mut state).await?;
            }
            let (init, segment) = media_core::child_process::blocking(move || {
                Ok::<_, anyhow::Error>((
                    outputs::open_verified(&directory.join("init.mp4"), &proofs[0])?,
                    outputs::open_verified(&directory.join("index0.m4s"), &proofs[1])?,
                ))
            })
            .await??;
            let mut command = qualification_command("ffmpeg");
            command
                .args([
                    "-v",
                    "error",
                    "-nostdin",
                    "-xerror",
                    "-err_detect",
                    "explode",
                    "-threads",
                    "1",
                    "-protocol_whitelist",
                    "pipe",
                    "-f",
                    "mp4",
                    "-i",
                    "pipe:0",
                    "-map",
                    "0:v?",
                    "-map",
                    "0:a?",
                    "-threads",
                    "1",
                    "-f",
                    "framehash",
                    "-hash",
                    "sha256",
                    "pipe:1",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            state.child = Some(child_process::spawn(command)?);
            let child = state.child.as_mut().unwrap();
            let stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            let feeding = feed_fragments(stdin, init, segment);
            tokio::try_join!(feeding, decoded_frames(stdout))?;
            ensure!(child.wait().await?.success(), "decode_failed");
            Ok::<_, anyhow::Error>(())
        };
        let result = tokio::time::timeout(Duration::from_secs(10), work).await;
        reap(&mut state).await?;
        match result {
            Ok(Ok(())) => {
                state.verified = true;
                if let Some(recipe) = &state.advanced_recipe {
                    tracing::info!(backend=?recipe.encoder().backend(), qualification=?media_core::advanced_media::RuntimeQualification::OutputValidated,
                        "actual advanced media output headers and immutable first fragment passed validation");
                }
                Ok(())
            }
            Ok(Err(_)) => Err(Rejected.into()),
            Err(_) => Err(LeaseInterrupted.into()),
        }
    }

    pub async fn stop(&self) -> Result<()> {
        reap(&mut *self.state.lock().await).await
    }
}

async fn feed_fragments(
    mut stdin: tokio::process::ChildStdin,
    init: std::fs::File,
    segment: std::fs::File,
) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    for mut file in [init, segment] {
        loop {
            let (returned, bytes) = media_core::child_process::blocking(move || {
                let mut bytes = vec![0; 65536];
                let count = std::io::Read::read(&mut file, &mut bytes)?;
                bytes.truncate(count);
                Ok::<_, std::io::Error>((file, bytes))
            })
            .await??;
            file = returned;
            if bytes.is_empty() {
                break;
            }
            stdin.write_all(&bytes).await?;
        }
    }
    drop(stdin);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn qualification_children_do_not_inherit_service_secrets() {
        for program in ["ffprobe", "ffmpeg"] {
            let command = qualification_command(program);
            assert_eq!(command.as_std().get_program(), program);
            for key in [
                "DATABASE_URL",
                "SOURCE_ENCRYPTION_KEY",
                "ADMIN_PASSWORD",
                "SERVER_INTERNAL_URL",
            ] {
                assert!(
                    command
                        .as_std()
                        .get_envs()
                        .any(|(name, value)| { name == key && value.is_none() })
                );
            }
        }
    }
    #[tokio::test]
    async fn headers_and_zero_frames_do_not_prove_decoding() {
        assert!(
            decoded_frames(b"#format: frame checksums\n".as_slice())
                .await
                .is_err()
        );
        assert!(decoded_frames(vec![b'x'; 65536].as_slice()).await.is_err());
        assert!(decoded_frames(b"progress=end\n".as_slice()).await.is_err());
        let frame = format!(
            "#format: frame checksums\n0, 0, 0, 1, 24, {}\n",
            "a".repeat(64)
        );
        decoded_frames(frame.as_bytes()).await.unwrap();
        assert!(
            decoded_frames(frame.replace(", 24,", ", 0,").as_bytes())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn advanced_gate_cannot_be_rebound_after_recipe_configuration() {
        let recipe = Arc::new(media_core::advanced_media::Recipe::from_probe(
            &serde_json::json!({"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1280,"height":720,"pix_fmt":"yuv420p","color_transfer":"bt709","disposition":{"attached_pic":0}}]}),
            None, 0.0, &media_core::advanced_media::Request::default(),
            media_core::advanced_media::EncoderSelection::software_recipe(),
        ).unwrap());
        let gate = Gate::default();
        gate.configure_advanced(recipe.clone()).await.unwrap();
        assert!(gate.configure_advanced(recipe).await.is_err());
        gate.stop().await.unwrap();
    }
}
