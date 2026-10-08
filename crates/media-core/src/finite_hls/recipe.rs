//! Preserve the proved video origin when the established HLS recipe consumes a
//! normalized TS/MOV descriptor. This adds no input, demuxer or encoder branch.
use anyhow::{Result, ensure};
/// Common video/audio clock subtraction after bounded sequential decode keeps
/// source AAC offset/preroll semantics. Seek never guesses a TS format origin.
pub fn constrain_hls_recipe(
    args: &mut Vec<String>,
    origin_seconds: f64,
    start_seconds: f64,
    duration_seconds: f64,
    source_frame_rate: f64,
) -> Result<()> {
    ensure!(
        matches!(origin_seconds, 0.0 | 1.0)
            && matches!(source_frame_rate, 25.0 | 30.0)
            && start_seconds.is_finite()
            && start_seconds >= 0.0
            && start_seconds < duration_seconds
            && duration_seconds.is_finite()
            && duration_seconds > 0.0
            && duration_seconds <= super::MAX_SECONDS,
        "finite_hls_recipe_clock"
    );
    ensure!(
        args.iter().filter(|a| *a == "-i").count() == 1
            && args.iter().any(|a| a == "libx264")
            && args.iter().any(|a| a == "-hls_segment_type"),
        "finite_hls_existing_software_recipe_required"
    );
    if let Some(at) = args.iter().position(|a| a == "-ss") {
        ensure!(at + 1 < args.len(), "finite_hls_recipe_seek");
        args.drain(at..at + 2);
    }
    let input = args.iter().position(|a| a == "-i").unwrap();
    args.insert(input, "-copyts".into());
    let first = origin_seconds + start_seconds;
    let end = origin_seconds + duration_seconds;
    let filter = args
        .iter()
        .position(|a| a == "-vf")
        .ok_or_else(|| anyhow::anyhow!("finite_hls_recipe_video_filter"))?
        + 1;
    ensure!(filter < args.len(), "finite_hls_recipe_video_filter");
    args[filter] = format!(
        "trim=start={first:.9}:end={end:.9},setpts=PTS-{first:.9}/TB,{},fps=fps={source_frame_rate}:start_time=0:round=near",
        args[filter]
    );
    if let Some(at) = args.iter().position(|a| a == "-r") {
        ensure!(at + 1 < args.len(), "finite_hls_recipe_frame_rate");
        args[at + 1] = source_frame_rate.to_string();
    } else {
        let at = args
            .iter()
            .position(|a| a == "-fps_mode")
            .ok_or_else(|| anyhow::anyhow!("finite_hls_recipe_frame_rate"))?;
        args.splice(at..at, ["-r".into(), source_frame_rate.to_string()]);
    }
    ensure!(
        !args.iter().any(|a| a == "-af"),
        "finite_hls_recipe_audio_filter_conflict"
    );
    let audio = args
        .iter()
        .position(|a| a == "-c:a")
        .ok_or_else(|| anyhow::anyhow!("finite_hls_recipe_audio_encoder"))?;
    args.splice(
        audio..audio,
        [
            "-af".into(),
            format!("atrim=start={first:.9}:end={end:.9},asetpts=PTS-{first:.9}/TB"),
        ],
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_recipe_uses_proved_common_clock_and_never_input_seek() {
        let mut args = crate::hls_args("owned", "output", 0.5, true, None);
        constrain_hls_recipe(&mut args, 1.0, 0.5, 4.0, 30.0).unwrap();
        assert!(!args.iter().any(|a| a == "-ss"));
        assert!(args.iter().any(|a| a == "-copyts"));
        assert!(args.iter().any(|a| {
            a.starts_with("trim=start=1.500000000:end=5.000000000,setpts=PTS-1.500000000/TB,")
        }));
        assert!(
            args.iter()
                .any(|a| a == "atrim=start=1.500000000:end=5.000000000,asetpts=PTS-1.500000000/TB")
        );
        assert!(constrain_hls_recipe(&mut args, 2.0, 0.0, 4.0, 30.0).is_err());
    }
}
