//! Fault-injection executable, only launched by the owned avatar test fixture.
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};
fn main() -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"),
        "isolated fixture required"
    );
    let root = PathBuf::from(std::env::var("RAINSYNC_AVATAR_FIXTURE_DIR")?);
    let mode = std::env::var("RAINSYNC_AVATAR_FIXTURE_MODE").unwrap_or_default();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let input_index = args.iter().position(|a| a == "-i").unwrap_or(args.len());
    let encoding = args[..input_index].iter().any(|a| a == "rawvideo");
    let mut input = Vec::new();
    std::io::stdin()
        .take(3 * 1024 * 1024)
        .read_to_end(&mut input)?;
    let delayed = input
        .windows(b"fixture-delay".len())
        .any(|w| w == b"fixture-delay");
    if delayed || mode == "sleep" {
        std::fs::write(root.join("encoder.pid"), std::process::id().to_string())?;
        if mode == "sleep" {
            std::thread::sleep(Duration::from_secs(60));
        } else {
            for _ in 0..1000 {
                if root.join("encoder.release").exists() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    if encoding && mode == "fail-encode" {
        std::process::exit(1);
    }
    if encoding && mode == "oversize" {
        std::io::stdout().write_all(&vec![0u8; 300 * 1024])?;
        return Ok(());
    }
    let mut child = Command::new("ffmpeg")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    child.stdin.take().unwrap().write_all(&input)?;
    let output = child.wait_with_output()?;
    std::io::stdout().write_all(&output.stdout)?;
    std::process::exit(output.status.code().unwrap_or(1));
}
