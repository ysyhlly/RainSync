use std::io::{Read, Write};
fn main() -> anyhow::Result<()> {
    let origin: f64 = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("origin_ms required"))?
        .parse()?;
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(media_core::subtitles::MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    std::io::stdout().write_all(&media_core::subtitles::shift_webvtt(&bytes, origin)?)?;
    Ok(())
}
