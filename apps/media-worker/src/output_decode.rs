//! Decode the first immutable fMP4 fragment before publishing any playlist.
use crate::{
    child_process::{self, Child},
    outputs,
    process::LeaseInterrupted,
};
use anyhow::{Result, ensure};
use persistence::media_outputs::FileProof;
use std::{path::PathBuf, process::Stdio, time::Duration};
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
}

#[derive(Default)]
pub struct Gate {
    state: Mutex<State>,
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
    /// The job owns this gate until cleanup. Cancelling this future leaves the
    /// child here, so the caller can explicitly kill/wait rather than orphan it.
    pub async fn verify(&self, directory: PathBuf, proofs: [FileProof; 2]) -> Result<()> {
        let mut state = self.state.lock().await;
        if state.verified {
            return Ok(());
        }
        reap(&mut state).await?;
        let work = async {
            let (init, segment) = media_core::child_process::blocking(move || {
                Ok::<_, anyhow::Error>((
                    outputs::open_verified(&directory.join("init.mp4"), &proofs[0])?,
                    outputs::open_verified(&directory.join("index0.m4s"), &proofs[1])?,
                ))
            })
            .await??;
            let mut command = Command::new("ffmpeg");
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
            let mut stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            let feeding = async move {
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
                Ok::<_, anyhow::Error>(())
            };
            tokio::try_join!(feeding, decoded_frames(stdout))?;
            ensure!(child.wait().await?.success(), "decode_failed");
            Ok::<_, anyhow::Error>(())
        };
        let result = tokio::time::timeout(Duration::from_secs(10), work).await;
        reap(&mut state).await?;
        match result {
            Ok(Ok(())) => {
                state.verified = true;
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
