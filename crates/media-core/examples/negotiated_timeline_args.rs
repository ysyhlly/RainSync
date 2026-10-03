//! Export negotiated production arguments and candidate eligibility for owned fixtures.
//! This helper does not grant routes or change the public playback schema.
fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(
        args.len() == 6,
        "input output mode metadata-json audio-index|none start-seconds"
    );
    let metadata: serde_json::Value = serde_json::from_str(&args[3])?;
    let audio = (args[4] != "none")
        .then(|| args[4].parse::<u32>())
        .transpose()?;
    let start: f64 = args[5].parse()?;
    anyhow::ensure!(start.is_finite() && start >= 0.0, "invalid start");
    let candidates = media_core::capabilities::candidates(&metadata, audio, start * 1000.0)?;
    let candidate = candidates
        .iter()
        .find(|c| c.delivery_mode == args[2] && c.transport == "hls");
    anyhow::ensure!(
        candidate.is_some(),
        "requested generated route not offered at this start"
    );
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "candidate": candidate,
            "candidates": candidates,
            "args": media_core::capabilities::negotiated_hls_args(&args[0], &args[1], start, &args[2], audio)
        }))?
    );
    Ok(())
}
