//! Export the production FFmpeg argument builder for isolated media verification.
fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(
        (4..=6).contains(&args.len()),
        "input output remux|transcode metadata-json [audio-index|none] [start-seconds]"
    );
    let metadata: serde_json::Value = serde_json::from_str(&args[3])?;
    anyhow::ensure!(
        matches!(args[2].as_str(), "remux" | "transcode"),
        "invalid mode"
    );
    println!(
        "{}",
        serde_json::to_string(&media_core::hls_args(
            &args[0],
            &args[1],
            args.get(5).map(|s| s.parse()).transpose()?.unwrap_or(0.0),
            args[2] == "transcode" || media_core::hls_needs_video_transform(&metadata),
            args.get(4)
                .filter(|s| s.as_str() != "none")
                .map(|s| s.parse())
                .transpose()?
        ))?
    );
    Ok(())
}
