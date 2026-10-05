//! Read one already-authorized local export. This executable has no I/O except
//! its bounded file read and JSON report on stdout; no application side effects.
use room_core::diagnostics::{MAX_BUNDLE_BYTES, decode_window, verify};
use std::io::Read;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let path = args
        .next()
        .ok_or("usage: verify_diagnostics <export.json>")?;
    if args.next().is_some() {
        return Err("expected exactly one export file".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take((MAX_BUNDLE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    let window = decode_window(&bytes)?;
    let report = verify(&window);
    println!("{}", serde_json::to_string_pretty(&report)?);
    if !report.continuous || !report.reaches_snapshot || report.unverifiable_steps != 0 {
        std::process::exit(1);
    }
    Ok(())
}
