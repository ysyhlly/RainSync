//! Stalled ffprobe replacement for isolated native shutdown tests only.
use std::{
    process::{Command, Stdio},
    time::Duration,
};

#[allow(clippy::zombie_processes)] // The service's process owner must reap this deliberate descendant.
fn main() -> anyhow::Result<()> {
    let root = std::path::PathBuf::from(
        std::env::var_os("RAINSYNC_NATIVE_PROBE")
            .ok_or_else(|| anyhow::anyhow!("isolated fixture directory required"))?,
    );
    if std::env::args().nth(1).as_deref() == Some("--leaf") {
        std::thread::sleep(Duration::from_secs(120));
        return Ok(());
    }
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--leaf")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut leaf = command.spawn()?;
    std::fs::write(
        root.join("pids.tmp"),
        serde_json::to_vec(&[std::process::id(), leaf.id()])?,
    )?;
    std::fs::rename(root.join("pids.tmp"), root.join("pids.json"))?;
    let _ = leaf.wait()?;
    Ok(())
}
