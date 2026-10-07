pub mod advanced_media;
pub mod bounded_decode;
pub mod deployment_config;
pub mod distributed_compute;
pub mod finite_delivery;
pub mod finite_hls;
pub mod hls_ladder;
pub mod http_range;
pub mod input_policy;
pub mod job_health;
pub mod motion_video;
pub mod runtime_metrics;
pub mod static_hls;
pub mod static_hls_probe;
use anyhow::{Result, bail};
use std::path::{Path, PathBuf};
pub mod capabilities;
pub mod child_process;
pub mod file_version;
pub mod preview;
pub mod process_signal;
pub mod subtitles;

pub fn byte_range(value: Option<&str>, size: u64) -> Result<Option<(u64, u64)>> {
    let Some(value) = value else { return Ok(None) };
    if size == 0 {
        bail!("unsatisfiable_range")
    }
    let raw = value
        .strip_prefix("bytes=")
        .ok_or_else(|| anyhow::anyhow!("invalid_range"))?;
    if raw.contains(',') {
        bail!("multiple_ranges_unsupported")
    }
    let (a, b) = raw
        .split_once('-')
        .ok_or_else(|| anyhow::anyhow!("invalid_range"))?;
    let (start, end) = if a.is_empty() {
        let n = b.parse::<u64>()?;
        if n == 0 {
            bail!("invalid_range")
        };
        (size.saturating_sub(n), size - 1)
    } else {
        (
            a.parse::<u64>()?,
            if b.is_empty() {
                size - 1
            } else {
                b.parse::<u64>()?.min(size - 1)
            },
        )
    };
    if start >= size || start > end {
        bail!("unsatisfiable_range")
    };
    Ok(Some((start, end)))
}

pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let root = root.canonicalize()?;
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        bail!("invalid_path")
    }
    let full = root.join(relative).canonicalize()?;
    if !full.starts_with(&root) || !full.is_file() {
        bail!("outside_media_root")
    }
    Ok(full)
}

/// The deployment media root. Unit tests build fixtures under the system
/// temporary directory, so they default there when MEDIA_ROOT is unset.
fn allowed_media_root() -> PathBuf {
    if let Some(root) = std::env::var_os("MEDIA_ROOT") {
        return PathBuf::from(root);
    }
    #[cfg(any(test, feature = "test-media-root"))]
    {
        std::env::temp_dir()
    }
    #[cfg(not(any(test, feature = "test-media-root")))]
    {
        PathBuf::from("/media")
    }
}

/// Local Server/Worker sources must remain within the deployment's media root
/// at use time, even if a configured directory was replaced after admission.
pub fn local_media_root(root: &Path) -> Result<PathBuf> {
    let allowed = allowed_media_root();
    confined_root(root, Path::new(&allowed))
}

pub fn confined_root(root: &Path, allowed: &Path) -> Result<PathBuf> {
    let allowed = allowed.canonicalize()?;
    let root = root.canonicalize()?;
    anyhow::ensure!(root.starts_with(allowed), "outside_media_root");
    Ok(root)
}

pub fn safe_local_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let root = local_media_root(root)?;
    let full = safe_path(&root, relative)?;
    let allowed = allowed_media_root();
    anyhow::ensure!(
        full.starts_with(Path::new(&allowed).canonicalize()?),
        "outside_media_root"
    );
    Ok(full)
}

/// Validate the object actually opened, before any bytes are consumed. A path
/// check alone cannot fence replacement of an ancestor between stat and open.
pub fn open_local_file(root: &Path, relative: &str) -> Result<std::fs::File> {
    let source_root = local_media_root(root)?;
    let path = safe_local_path(root, relative)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Pin this object against mutation/removal while a child reads it.
        options.share_mode(windows::Win32::Storage::FileSystem::FILE_SHARE_READ.0);
    }
    let file = options.open(path)?;
    let allowed = allowed_media_root();
    let allowed = Path::new(&allowed).canonicalize()?;
    let actual = opened_file_path(&file)?;
    anyhow::ensure!(
        actual.starts_with(allowed)
            && actual.starts_with(source_root)
            && file.metadata()?.is_file(),
        "outside_media_root"
    );
    Ok(file)
}

/// The scanner enumerates a retained directory object rather than reopening
/// its pathname after validation. Empty relative denotes the source root.
pub fn open_local_directory(root: &Path, relative: &str) -> Result<std::fs::File> {
    let source_root = local_media_root(root)?;
    let relative = Path::new(relative);
    anyhow::ensure!(
        !relative.is_absolute()
            && relative
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_))),
        "invalid_path"
    );
    let path = source_root.join(relative).canonicalize()?;
    anyhow::ensure!(path.starts_with(&source_root), "outside_media_root");
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ};
        options
            .share_mode(FILE_SHARE_READ.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0);
    }
    let directory = options.open(path)?;
    let actual = opened_file_path(&directory)?;
    let allowed = allowed_media_root();
    anyhow::ensure!(
        actual.starts_with(Path::new(&allowed).canonicalize()?)
            && actual.starts_with(source_root)
            && directory.metadata()?.is_dir(),
        "outside_media_root"
    );
    Ok(directory)
}

#[cfg(target_os = "linux")]
fn opened_file_path(file: &std::fs::File) -> Result<PathBuf> {
    use std::os::fd::AsRawFd;
    Ok(std::fs::read_link(format!(
        "/proc/self/fd/{}",
        file.as_raw_fd()
    ))?)
}

#[cfg(windows)]
fn opened_file_path(file: &std::fs::File) -> Result<PathBuf> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW},
    };
    let mut buffer = vec![0u16; 32768];
    let count = unsafe {
        GetFinalPathNameByHandleW(
            HANDLE(file.as_raw_handle()),
            &mut buffer,
            FILE_NAME_NORMALIZED,
        )
    };
    anyhow::ensure!(
        count > 0 && (count as usize) < buffer.len(),
        "local_file_path_unavailable"
    );
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..count as usize],
    )))
}

#[cfg(not(any(target_os = "linux", windows)))]
fn opened_file_path(_file: &std::fs::File) -> Result<PathBuf> {
    anyhow::bail!("local_file_handle_confinement_unsupported")
}

/// On Linux the child opens the retained original descriptor, so an ancestor
/// replacement cannot redirect FFprobe/FFmpeg to a different filesystem tree.
pub fn local_process_input(file: &std::fs::File, path: &Path) -> Result<String> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let _ = path;
        Ok(format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            file.as_raw_fd()
        ))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        Ok(opened_file_path(file)?.to_string_lossy().into_owned())
    }
}

#[cfg(all(test, unix))]
mod confinement_tests {
    #[test]
    fn replacing_registered_root_with_symlink_cannot_escape_allowed_root() {
        let base = std::env::temp_dir().join(format!("root-fence-{}", uuid::Uuid::new_v4()));
        let allowed = base.join("media");
        let source = allowed.join("source");
        let outside = base.join("outside");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir(&outside).unwrap();
        assert!(super::confined_root(&source, &allowed).is_ok());
        std::fs::remove_dir(&source).unwrap();
        std::os::unix::fs::symlink(&outside, &source).unwrap();
        assert!(super::confined_root(&source, &allowed).is_err());
        std::fs::remove_file(&source).unwrap();
        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn scanner_directory_handle_survives_ancestor_swap_without_enumerating_outside() {
        use std::{fs, path::PathBuf, process::Command};
        if let Ok(base) = std::env::var("RAINSYNC_DIRECTORY_ROOT_CHILD_FIXTURE") {
            let base = PathBuf::from(base);
            let source = base.join("media/source");
            let directory = super::open_local_directory(&source, "").unwrap();
            let input = super::local_process_input(&directory, &source).unwrap();
            fs::rename(&source, base.join("media/retired")).unwrap();
            std::os::unix::fs::symlink(base.join("outside"), &source).unwrap();
            let names: Vec<_> = fs::read_dir(input)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            assert_eq!(names, [std::ffi::OsString::from("inside.mp4")]);
            assert!(super::open_local_directory(&source, "").is_err());
            let retired = base.join("media/retired");
            std::os::unix::fs::symlink(base.join("outside"), retired.join("child")).unwrap();
            assert!(super::open_local_directory(&retired, "child").is_err());
            fs::remove_file(&source).unwrap();
            fs::remove_file(retired.join("child")).unwrap();
            return;
        }
        let temp = std::env::temp_dir();
        let base = temp.join(format!("rainsync-directory-fence-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(base.join("media/source")).unwrap();
        fs::create_dir(base.join("outside")).unwrap();
        fs::write(base.join("media/source/inside.mp4"), b"inside").unwrap();
        fs::write(base.join("outside/outside.mp4"), b"outside").unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "confinement_tests::scanner_directory_handle_survives_ancestor_swap_without_enumerating_outside", "--nocapture"])
            .env("RAINSYNC_DIRECTORY_ROOT_CHILD_FIXTURE", &base).env("MEDIA_ROOT", base.join("media"))
            .output().unwrap();
        assert!(base.starts_with(temp));
        fs::remove_dir_all(base).unwrap();
        assert!(
            output.status.success(),
            "child scanner confinement fixture failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[cfg(all(test, windows))]
mod windows_confinement_tests {
    #[test]
    fn registered_root_junction_replacement_is_rejected() {
        use std::{fs, os::windows::process::CommandExt, path::PathBuf, process::Command};
        if let Ok(base) = std::env::var("RAINSYNC_LOCAL_ROOT_CHILD_FIXTURE") {
            let base = PathBuf::from(base);
            let source = base.join("media/source");
            let retired = base.join("media/retired");
            let outside = base.join("outside");
            let directory = super::open_local_directory(&source, "").unwrap();
            let directory_input = super::local_process_input(&directory, &source).unwrap();
            assert_eq!(fs::read_dir(directory_input).unwrap().count(), 1);
            drop(directory);
            let held = super::open_local_file(&source, "movie.mp4").unwrap();
            let input = super::local_process_input(&held, &source.join("movie.mp4")).unwrap();
            match fs::rename(&source, &retired) {
                Ok(()) => {
                    make_junction(&source, &outside);
                    assert_eq!(
                        fs::read(&input).unwrap(),
                        b"inside",
                        "retained process input was redirected by an ancestor swap"
                    );
                    assert!(super::open_local_file(&source, "movie.mp4").is_err());
                    fs::remove_dir(&source).unwrap();
                }
                Err(error) => {
                    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
                    assert_eq!(fs::read(&input).unwrap(), b"inside");
                    drop(held);
                    fs::rename(&source, &retired).unwrap();
                    make_junction(&source, &outside);
                    assert!(super::open_local_file(&source, "movie.mp4").is_err());
                    fs::remove_dir(&source).unwrap();
                    return;
                }
            }
            return;
        }
        let temp = std::env::temp_dir();
        let base = temp.join(format!("rainsync-root-fence-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(base.join("media/source")).unwrap();
        fs::create_dir(base.join("outside")).unwrap();
        fs::write(base.join("media/source/movie.mp4"), b"inside").unwrap();
        fs::write(base.join("outside/movie.mp4"), b"outside").unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "windows_confinement_tests::registered_root_junction_replacement_is_rejected",
                "--nocapture",
            ])
            .env("RAINSYNC_LOCAL_ROOT_CHILD_FIXTURE", &base)
            .env("MEDIA_ROOT", base.join("media"))
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(base.starts_with(temp));
        fs::remove_dir_all(base).unwrap();
        assert!(
            output.status.success(),
            "child confinement fixture failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn make_junction(path: &std::path::Path, target: &std::path::Path) {
        use std::{os::windows::process::CommandExt, process::Command};
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:RAINSYNC_FIXTURE_JUNCTION -Target $env:RAINSYNC_FIXTURE_TARGET -ErrorAction Stop | Out-Null"])
            .env("RAINSYNC_FIXTURE_JUNCTION", path).env("RAINSYNC_FIXTURE_TARGET", target)
            .creation_flags(0x08000000).output().unwrap();
        assert!(
            output.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

pub async fn probe(path: &str) -> Result<serde_json::Value> {
    probe_with_policy(path, false).await
}
pub async fn probe_with_policy(path: &str, rewritten_hls: bool) -> Result<serde_json::Value> {
    let mut command = tokio::process::Command::new("ffprobe");
    input_policy::clean_environment(&mut command);
    command.args(input_policy::args(
        path.starts_with("http://"),
        rewritten_hls,
    ));
    command.args([
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-show_data",
        "-of",
        "json",
        path,
    ]);
    let (status, bytes) =
        child_process::capture(command, std::time::Duration::from_secs(30), 8 * 1024 * 1024)
            .await?;
    if !status.success() {
        bail!("probe_failed")
    }
    Ok(serde_json::from_slice(&bytes)?)
}

/// Stream-copy HLS does not reliably preserve MP4 display matrices. Baking the
/// orientation into pixels requires decoding, even when H.264 is supported.
/// A material difference between nominal and average frame rate also takes the
/// conservative CFR route: stream-copy HLS can undercount VFR segment duration.
pub fn hls_needs_video_transform(meta: &serde_json::Value) -> bool {
    meta["streams"].as_array().is_some_and(|streams| {
        streams
            .iter()
            .filter(|s| s["codec_type"] == "video")
            .any(video_needs_transform)
    })
}

/// Transform facts apply only to the selected stream in the opt-in recipe.
pub fn video_needs_transform(video: &serde_json::Value) -> bool {
    let rotated = |value: &serde_json::Value| {
        value
            .as_f64()
            .or_else(|| value.as_str()?.parse().ok())
            .is_some_and(|rotation: f64| {
                !rotation.is_finite() || rotation.rem_euclid(360.0).abs() > 0.01
            })
    };
    let rate = |value: &serde_json::Value| -> Option<f64> {
        let (n, d) = value.as_str()?.split_once('/')?;
        let fps = n.parse::<f64>().ok()? / d.parse::<f64>().ok()?;
        (fps.is_finite() && fps > 0.0).then_some(fps)
    };
    rate(&video["r_frame_rate"])
        .zip(rate(&video["avg_frame_rate"]))
        .is_some_and(|(nominal, average)| (nominal / average - 1.0).abs() > 0.01)
        || rotated(&video["tags"]["rotate"])
        || video["side_data_list"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| row["side_data_type"] == "Display Matrix" && rotated(&row["rotation"]))
        })
}

/// Admission estimate, not a bitrate guarantee for CRF video. Disk usage is
/// still monitored while encoding. Unknown duration is budgeted by the Worker.
pub fn estimated_output_bytes(
    meta: &serde_json::Value,
    duration_ms: Option<f64>,
    start_ms: f64,
    transcode: bool,
) -> Option<u64> {
    let duration = duration_ms.filter(|n| n.is_finite() && *n >= 0.0)?;
    if !start_ms.is_finite() || start_ms < 0.0 {
        return None;
    }
    let source_rate = meta["format"]["bit_rate"]
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .or_else(|| meta["format"]["bit_rate"].as_f64())
        .filter(|n| n.is_finite() && *n > 0.0);
    let video_rate = if transcode {
        8_000_000.0
    } else {
        source_rate.unwrap_or(8_000_000.0)
    };
    Some(
        (((duration - start_ms).max(0.0) / 1000.0) * (video_rate + 192_000.0) / 8.0 * 1.15)
            .ceil()
            .max(65536.0) as u64,
    )
}

#[cfg(test)]
mod budget_tests {
    #[test]
    fn estimates_remaining_output_and_preserves_unknown_duration() {
        let meta = serde_json::json!({"format":{"bit_rate":"1000000"}});
        assert_eq!(
            super::estimated_output_bytes(&meta, Some(20000.0), 10000.0, false),
            Some(1713500)
        );
        assert_eq!(
            super::estimated_output_bytes(&meta, Some(20000.0), 10000.0, true),
            Some(11776000)
        );
        assert_eq!(super::estimated_output_bytes(&meta, None, 0.0, false), None);
        assert_eq!(
            super::estimated_output_bytes(&meta, Some(0.0), 0.0, false),
            Some(65536)
        );
        assert_eq!(
            super::estimated_output_bytes(&meta, Some(f64::NAN), 0.0, false),
            None
        );
    }
}

pub fn hls_args(
    input: &str,
    output: &str,
    start_seconds: f64,
    transcode: bool,
    audio_index: Option<u32>,
) -> Vec<String> {
    hls_args_for_video(
        input,
        output,
        start_seconds,
        transcode,
        motion_video::VideoMapping::LegacyFirstVideo,
        audio_index,
    )
}

/// Source-resolved opt-in recipe; its default audio uses the same canonical
/// selection as motion candidate facts. Existing hls_args behavior is retained.
pub fn hls_args_for_motion_source(
    meta: &serde_json::Value,
    input: &str,
    output: &str,
    start_seconds: f64,
    transcode: bool,
    audio_index: Option<u32>,
) -> Result<Vec<String>> {
    let video = capabilities::validate_motion_source(meta)?;
    let audio = motion_video::selected_audio_index(meta, audio_index)?;
    Ok(hls_args_for_video(
        input,
        output,
        start_seconds,
        transcode,
        video.identity.mapping,
        audio,
    ))
}

/// Explicit selected-video recipe; the compatibility wrapper retains old jobs
/// and fixture callers. Calling this does not establish Worker compatibility.
pub fn hls_args_for_video(
    input: &str,
    output: &str,
    start_seconds: f64,
    transcode: bool,
    video_mapping: motion_video::VideoMapping,
    audio_index: Option<u32>,
) -> Vec<String> {
    // Stream copy seeks to an earlier keyframe and cannot honor the plan's
    // requested timeline origin. Decode/discard preroll for nonzero starts.
    let transcode = transcode || start_seconds > 0.0;
    let mut a = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];
    // Seeking to zero needlessly resets the HLS demuxer; FFmpeg 5.1 can then
    // lose the fMP4 init/segment alignment. Opening normally preserves it.
    if start_seconds > 0.0 {
        a.extend(["-ss".into(), start_seconds.to_string()]);
    }
    a.extend([
        "-i".into(),
        input.into(),
        "-map".into(),
        video_mapping.ffmpeg_specifier(),
        "-map".into(),
        // API track indices are absolute stream indices, not audio ordinals.
        audio_index.map_or_else(|| "0:a:0?".into(), |index| format!("0:{index}")),
    ]);
    let extra = if transcode {
        vec![
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            // B-frame reorder and automatic negative-DTS shifting otherwise
            // move the first displayed frame away from zero in fMP4 HLS.
            "-bf",
            "0",
            "-fps_mode",
            "cfr",
            "-vf",
            "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-force_key_frames",
            "expr:gte(t,n_forced*4)",
            "-c:a",
            "aac",
        ]
    } else {
        vec!["-c:v", "copy", "-c:a", "aac"]
    };
    a.extend(extra.into_iter().map(String::from));
    a.extend(
        [
            "-avoid_negative_ts",
            "disabled",
            "-f",
            "hls",
            "-hls_time",
            "4",
            "-hls_segment_type",
            "fmp4",
            "-hls_playlist_type",
            "event",
            "-hls_flags",
            "temp_file",
        ]
        .into_iter()
        .map(String::from),
    );
    a.push(output.into());
    a
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges() {
        assert_eq!(byte_range(Some("bytes=-5"), 20).unwrap(), Some((15, 19)));
        assert_eq!(byte_range(Some("bytes=2-"), 20).unwrap(), Some((2, 19)));
        assert!(byte_range(Some("bytes=20-"), 20).is_err());
        assert!(byte_range(Some("bytes=0-2,4-8"), 20).is_err());
        assert!(byte_range(Some("bytes=0-"), 0).is_err());
    }
}

/// Conservative single-profile browser fallback. Unknown/HDR video is never silently tone-mapped.
pub fn compatible_mode(meta: &serde_json::Value, selected_audio: bool) -> Result<&'static str> {
    let video = capabilities::validate_source(meta)?;
    compatible_mode_for_video(meta, video, selected_audio)
}

/// Pure compatible-mode helper for the paired motion recipe. Direct still
/// requires one total source video, including attached pictures.
pub fn compatible_motion_mode(
    meta: &serde_json::Value,
    selected_audio: bool,
) -> Result<&'static str> {
    let selected = capabilities::validate_motion_source(meta)?;
    let video = selected.stream;
    if video_needs_transform(video)
        || !matches!(
            video["sample_aspect_ratio"].as_str(),
            None | Some("1:1" | "N/A")
        )
    {
        return Ok("transcode");
    }
    let mode = compatible_mode_for_video(meta, video, selected_audio)?;
    let streams = meta["streams"].as_array().expect("validated streams");
    if mode == "direct"
        && (streams
            .iter()
            .filter(|row| row["codec_type"] == "video")
            .count()
            != 1
            || streams
                .iter()
                .filter(|row| row["codec_type"] == "audio")
                .count()
                > 1)
    {
        return Ok("remux");
    }

    Ok(mode)
}

fn compatible_mode_for_video(
    meta: &serde_json::Value,
    video: &serde_json::Value,
    selected_audio: bool,
) -> Result<&'static str> {
    let streams = meta["streams"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("no_streams"))?;
    if video["codec_name"] != "h264"
        || !matches!(video["pix_fmt"].as_str(), Some("yuv420p" | "yuvj420p"))
    {
        return Ok("transcode");
    }
    let audio = streams.iter().find(|s| s["codec_type"] == "audio");
    let mp4 = meta["format"]["format_name"]
        .as_str()
        .is_some_and(|s| s.split(',').any(|v| matches!(v, "mp4" | "hls")));
    if selected_audio || !mp4 || audio.is_some_and(|a| a["codec_name"] != "aac") {
        Ok("remux")
    } else {
        Ok("direct")
    }
}
#[cfg(test)]
mod compatibility_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn inconsistent_frame_rates_take_the_conservative_cfr_route() {
        for (nominal, average, expected) in [
            ("24/1", "384/23", true),
            ("30000/1001", "30000/1001", false),
            ("24/1", "24000/1001", false),
            ("0/0", "24/1", false),
            ("24/1", "unknown", false),
        ] {
            let meta = json!({"streams":[{"codec_type":"video","r_frame_rate":nominal,"avg_frame_rate":average}]});
            assert_eq!(hls_needs_video_transform(&meta), expected);
        }
    }
    #[test]
    fn rotated_video_requires_pixels_to_be_transformed_for_hls() {
        for rotation in [90, -90, 180, 270] {
            let meta = json!({"streams":[{"codec_type":"video","side_data_list":[{"side_data_type":"Display Matrix","rotation":rotation}]}]});
            assert!(hls_needs_video_transform(&meta));
        }
        assert!(hls_needs_video_transform(
            &json!({"streams":[{"codec_type":"video","tags":{"rotate":"90"}}]})
        ));
        assert!(!hls_needs_video_transform(
            &json!({"streams":[{"codec_type":"video","tags":{"rotate":"360"}}]})
        ));
        assert!(!hls_needs_video_transform(
            &json!({"streams":[{"codec_type":"video"}]})
        ));
    }
    #[test]
    fn codec_pixel_format_container_and_hdr_are_distinguished() {
        let mut m = json!({"format":{"format_name":"mov,mp4"},"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p"},{"codec_type":"audio","codec_name":"aac"}]});
        assert_eq!(compatible_mode(&m, false).unwrap(), "direct");
        assert_eq!(compatible_mode(&m, true).unwrap(), "remux");
        m["streams"][0]["pix_fmt"] = json!("yuv420p10le");
        assert_eq!(
            compatible_mode(&m, false).unwrap_err().to_string(),
            "unclassified_video_range"
        );
        m["streams"][0]["color_transfer"] = json!("bt709");
        assert_eq!(compatible_mode(&m, false).unwrap(), "transcode");
        m["streams"][0]["color_transfer"] = json!("smpte2084");
        assert!(compatible_mode(&m, false).is_err());
    }
}
