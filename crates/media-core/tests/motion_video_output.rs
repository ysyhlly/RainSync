//! Explicit, bounded, owned local FFmpeg evidence. This ignored test does not
//! start Server, Worker, PostgreSQL, NAS, sockets, or a browser.
#![cfg(target_os = "linux")]
use anyhow::{Context, Result, ensure};
use media_core::{capabilities, child_process, motion_video};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const PEAK_AND_HEADROOM: u64 = 64 * 1024 * 1024;

struct Fixture {
    root: PathBuf,
    next_command: usize,
}
impl Fixture {
    fn new() -> Result<Self> {
        use std::os::unix::fs::DirBuilderExt;
        let parent = std::env::var_os("RAINSYNC_MOTION_VIDEO_REPORT_DIR")
            .context("RAINSYNC_MOTION_VIDEO_REPORT_DIR is required for retained evidence")?;
        let root = PathBuf::from(parent).join(format!("motion-video-{}", uuid::Uuid::new_v4()));
        std::fs::DirBuilder::new().mode(0o700).create(&root)?;
        Ok(Self {
            root,
            next_command: 0,
        })
    }
    fn path(&self, relative: &str) -> String {
        self.root.join(relative).to_string_lossy().into_owned()
    }
    fn record(&self, relative: &str, value: &Value) -> Result<()> {
        std::fs::write(self.root.join(relative), serde_json::to_vec_pretty(value)?)?;
        Ok(())
    }
    fn disk_gate(&self) -> Result<Value> {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(self.root.as_os_str().as_bytes())?;
        let mut raw = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        ensure!(
            unsafe { libc::statvfs(path.as_ptr(), raw.as_mut_ptr()) } == 0,
            "owned fixture statvfs failed"
        );
        let raw = unsafe { raw.assume_init() };
        let total = raw
            .f_blocks
            .checked_mul(raw.f_frsize)
            .context("disk total overflow")?;
        let available = raw
            .f_bavail
            .checked_mul(raw.f_frsize)
            .context("disk available overflow")?;
        let minimum = total / 10 + PEAK_AND_HEADROOM;
        ensure!(
            available >= minimum,
            "fixture disk gate: {available} available, {minimum} required"
        );
        Ok(
            json!({"total_bytes":total,"available_bytes":available,"minimum_bytes":minimum,
            "peak_and_headroom_bytes":PEAK_AND_HEADROOM}),
        )
    }
    async fn command(&mut self, binary: &str, args: Vec<String>) -> Result<Vec<u8>> {
        ensure!(
            matches!(binary, "/usr/bin/ffmpeg" | "/usr/bin/ffprobe"),
            "unexpected fixture binary"
        );
        let disk = self.disk_gate()?;
        let id = self.next_command;
        self.next_command += 1;
        // Register the exact planned command in retained evidence before the
        // established capture owner admits the original OS child.
        self.record(
            &format!("command-{id:02}-registered.json"),
            &json!({
            "owner":"motion_video_output", "binary":binary,"argv":args,
            "deadline_seconds":30,"stdout_limit_bytes":4*1024*1024,"disk_gate":disk,
            "process_owner":"media_core::child_process::Scope/capture"}),
        )?;
        let mut command = tokio::process::Command::new(binary);
        media_core::input_policy::clean_environment(&mut command);
        command.args(&args).current_dir(&self.root);
        let result =
            child_process::capture(command, Duration::from_secs(30), 4 * 1024 * 1024).await;
        // capture's owner retains the original Child and waitpid on timeout,
        // cancellation, read errors and nonzero exits. Scope shutdown below
        // verifies reaping before any final test assertion.
        match result {
            Ok((status, bytes)) => {
                self.record(
                    &format!("command-{id:02}-completed.json"),
                    &json!({
                    "wait_receipt":true,"success":status.success(),"exit_code":status.code(),
                    "stdout_bytes":bytes.len(),"stdout_sha256":sha(&bytes)}),
                )?;
                ensure!(
                    status.success(),
                    "owned fixture command {id} exited {status}"
                );
                Ok(bytes)
            }
            Err(error) => {
                self.record(
                    &format!("command-{id:02}-completed.json"),
                    &json!({
                    "capture_error":error.to_string(),"scope_receipt_pending":true}),
                )?;
                Err(error.into())
            }
        }
    }
    async fn ffmpeg(&mut self, args: &[&str]) -> Result<Vec<u8>> {
        self.command(
            "/usr/bin/ffmpeg",
            args.iter().map(|v| (*v).into()).collect(),
        )
        .await
    }
    async fn probe(&mut self, path: &str) -> Result<Value> {
        let bytes = self
            .command(
                "/usr/bin/ffprobe",
                strings(&[
                    "-v",
                    "error",
                    "-show_format",
                    "-show_streams",
                    "-show_data",
                    "-of",
                    "json",
                    path,
                ]),
            )
            .await?;
        Ok(serde_json::from_slice(&bytes)?)
    }
}
fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|v| (*v).into()).collect()
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn file_hash(path: &Path) -> Result<String> {
    Ok(sha(&std::fs::read(path)?))
}

async fn run(f: &mut Fixture) -> Result<Value> {
    let film = f.path("film.mp4");
    f.ffmpeg(&[
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=640x360:r=25:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=48000:duration=1",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-map",
        "2:a:0",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-bf",
        "0",
        "-threads:v",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac:a",
        "2",
        "-ar:a",
        "48000",
        "-t",
        "1",
        &film,
    ])
    .await?;
    let cover = f.path("cover.jpg");
    f.ffmpeg(&[
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=320x320:d=1",
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-threads:v",
        "1",
        &cover,
    ])
    .await?;
    let input = f.path("input.mp4");
    f.ffmpeg(&[
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "1",
        "-i",
        &cover,
        "-i",
        &film,
        "-map",
        "1:a:0",
        "-map",
        "0:v:0",
        "-map",
        "1:v:0",
        "-map",
        "1:a:1",
        "-c",
        "copy",
        "-disposition:v:0",
        "attached_pic",
        "-disposition:v:1",
        "0",
        &input,
    ])
    .await?;
    let source = f.probe(&input).await?;
    f.record("source-probe.json", &source)?;
    let selected = capabilities::validate_motion_source(&source)?;
    let identity = selected.identity.clone();
    let rows = source["streams"].as_array().context("no source streams")?;
    ensure!(
        rows.iter().any(motion_video::is_attached_picture),
        "muxer did not preserve attached picture"
    );
    let audio_index = rows
        .iter()
        .filter(|row| row["codec_type"] == "audio")
        .nth(1)
        .and_then(|row| row["index"].as_u64())
        .and_then(|index| u32::try_from(index).ok())
        .context("second source audio index required")?;
    let candidate = capabilities::analyze_motion_source(&source, Some(audio_index), 0.0)?
        .candidates
        .into_iter()
        .find(|candidate| candidate.id == "transcode_720p")
        .context("transcode candidate missing")?;
    capabilities::require_current_motion_candidate(
        &source,
        &identity,
        &candidate,
        Some(audio_index),
        0.0,
    )?;
    ensure!(
        selected.stream["width"] == 640 && selected.stream["height"] == 360,
        "selected source is not the film"
    );
    let mut changed = source.clone();
    let changed_stream = changed["streams"]
        .as_array_mut()
        .context("streams missing")?
        .iter_mut()
        .find(|row| row["index"] == selected.stream["index"])
        .context("selected row missing")?;
    changed_stream["tags"]["rotate"] = json!(90);
    ensure!(
        capabilities::require_current_motion_candidate(
            &changed,
            &identity,
            &candidate,
            Some(audio_index),
            0.0
        )
        .is_err(),
        "changed selected source reused provenance"
    );
    std::fs::create_dir(f.root.join("output"))?;
    let output = f.path("output/index.m3u8");
    let mut args = capabilities::negotiated_hls_args_for_motion_source(
        &source,
        &input,
        &output,
        0.0,
        "transcode",
        Some(audio_index),
    )?;
    args.splice(
        0..0,
        strings(&["-v", "error", "-threads", "1", "-filter_threads", "1"]),
    );
    args.splice(
        args.len() - 1..args.len() - 1,
        strings(&["-threads:v", "1"]),
    );
    f.command("/usr/bin/ffmpeg", args).await?;
    let observed = f.probe(&output).await?;
    f.record("output-probe.json", &observed)?;
    let output_rows = observed["streams"]
        .as_array()
        .context("output streams missing")?;
    let video = output_rows
        .iter()
        .find(|row| row["codec_type"] == "video")
        .context("output video missing")?;
    ensure!(
        video["codec_name"] == "h264" && video["width"] == 1280 && video["height"] == 720,
        "output recipe geometry/codec mismatch"
    );
    let audio = output_rows
        .iter()
        .find(|row| row["codec_type"] == "audio")
        .context("output audio missing")?;
    ensure!(
        audio["codec_name"] == "aac" && audio["channels"] == 2 && audio["sample_rate"] == "48000",
        "output audio recipe mismatch"
    );
    let pixel = f
        .ffmpeg(&[
            "-v",
            "error",
            "-nostdin",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-i",
            &output,
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=1:1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .await?;
    ensure!(
        pixel.len() == 3 && pixel[2] > 150 && pixel[0] < 50 && pixel[1] < 50,
        "decoded output is not the known blue film: {pixel:?}"
    );
    let pcm = f
        .ffmpeg(&[
            "-v", "error", "-nostdin", "-threads", "1", "-i", &output, "-map", "0:a:0", "-t",
            "0.5", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1",
        ])
        .await?;
    ensure!(
        pcm.len() >= 40000 && pcm.len() % 2 == 0,
        "decoded audio too short"
    );
    let samples: Vec<_> = pcm
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    // Skip the codec's initial priming/attack; 880Hz must remain distinct from
    // the unselected 440Hz source after AAC decode/re-encode.
    let steady = &samples[2400..];
    let crossings = steady
        .windows(2)
        .filter(|pair| pair[0] <= 0 && pair[1] > 0)
        .count();
    let frequency = crossings as f64 * 48000.0 / steady.len() as f64;
    ensure!(
        (800.0..960.0).contains(&frequency),
        "wrong selected audio frequency: {frequency}"
    );
    // Reverse the actual complete ffprobe catalog while retaining its exact
    // source rows/indices. Default facts and actual mapping must stay with the
    // lowest audio index (440Hz), not the first JSON audio row (880Hz).
    let mut reordered = source.clone();
    reordered["streams"]
        .as_array_mut()
        .context("source streams missing")?
        .reverse();
    let default_audio_index = motion_video::selected_audio_index(&reordered, None)?
        .context("default absolute audio index required")?;
    let default_candidate = capabilities::analyze_motion_source(&reordered, None, 0.0)?
        .candidates
        .into_iter()
        .find(|candidate| candidate.id == "transcode_720p")
        .context("default transcode candidate missing")?;
    capabilities::require_current_motion_candidate(
        &source,
        &identity,
        &default_candidate,
        None,
        0.0,
    )?;
    std::fs::create_dir(f.root.join("default-output"))?;
    let default_output = f.path("default-output/index.m3u8");
    let mut default_args = capabilities::negotiated_hls_args_for_motion_source(
        &reordered,
        &input,
        &default_output,
        0.0,
        "transcode",
        None,
    )?;
    ensure!(
        default_args
            .windows(2)
            .any(|pair| pair[0] == "-map" && pair[1] == format!("0:{default_audio_index}")),
        "default recipe did not use its selected absolute audio index"
    );
    default_args.splice(
        0..0,
        strings(&["-v", "error", "-threads", "1", "-filter_threads", "1"]),
    );
    default_args.splice(
        default_args.len() - 1..default_args.len() - 1,
        strings(&["-threads:v", "1"]),
    );
    f.command("/usr/bin/ffmpeg", default_args).await?;
    let default_observed = f.probe(&default_output).await?;
    f.record("default-output-probe.json", &default_observed)?;
    let default_pcm = f
        .ffmpeg(&[
            "-v",
            "error",
            "-nostdin",
            "-threads",
            "1",
            "-i",
            &default_output,
            "-map",
            "0:a:0",
            "-t",
            "0.5",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "s16le",
            "pipe:1",
        ])
        .await?;
    ensure!(
        default_pcm.len() >= 40000 && default_pcm.len() % 2 == 0,
        "default decoded audio too short"
    );
    let default_samples: Vec<_> = default_pcm
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let default_steady = &default_samples[2400..];
    let default_crossings = default_steady
        .windows(2)
        .filter(|pair| pair[0] <= 0 && pair[1] > 0)
        .count();
    let default_frequency = default_crossings as f64 * 48000.0 / default_steady.len() as f64;
    ensure!(
        (380.0..500.0).contains(&default_frequency),
        "wrong default audio frequency: {default_frequency}"
    );
    let default_rows = default_observed["streams"]
        .as_array()
        .context("default output streams missing")?;
    let default_video = default_rows
        .iter()
        .find(|row| row["codec_type"] == "video")
        .context("default output video missing")?;
    let default_audio = default_rows
        .iter()
        .find(|row| row["codec_type"] == "audio")
        .context("default output audio missing")?;
    ensure!(
        default_video["codec_name"] == "h264"
            && default_video["width"] == 1280
            && default_video["height"] == 720
            && default_audio["codec_name"] == "aac"
            && default_audio["channels"] == 2
            && default_audio["sample_rate"] == "48000",
        "default output recipe mismatch"
    );
    let cover_first = rows
        .iter()
        .find(|row| row["codec_type"] == "video")
        .is_some_and(motion_video::is_attached_picture);
    let snapshot = media_core::file_version::snapshot_file(&std::fs::File::open(&input)?)?;
    let mut output_hashes = serde_json::Map::new();
    for row in std::fs::read_dir(f.root.join("output"))? {
        let row = row?;
        if row.file_type()?.is_file() {
            output_hashes.insert(
                row.file_name().to_string_lossy().into_owned(),
                json!(file_hash(&row.path())?),
            );
        }
    }
    let mut default_output_hashes = serde_json::Map::new();
    for row in std::fs::read_dir(f.root.join("default-output"))? {
        let row = row?;
        if row.file_type()?.is_file() {
            default_output_hashes.insert(
                row.file_name().to_string_lossy().into_owned(),
                json!(file_hash(&row.path())?),
            );
        }
    }
    Ok(
        json!({"schema_version":1,"fixture":"owned local blue film/red cover with440/880Hz audio",
        "source_sha256":file_hash(Path::new(&input))?,"source_stat_version":snapshot.version,
        "source_bytes":snapshot.len,"selected_identity":identity,"selected_audio_index":audio_index,
        "candidate":candidate,"actual_muxed_cover_first":cover_first,"decoded_rgb":pixel,
        "decoded_audio_frequency_hz":frequency,"decoded_audio_sha256":sha(&pcm),
        "output_hashes":output_hashes,
        "default_audio_evidence":{"requested_audio_index":null,"catalog_order":"reversed actual complete ffprobe rows",
            "resolved_absolute_audio_index":default_audio_index,"candidate":default_candidate,
            "decoded_audio_frequency_hz":default_frequency,"decoded_audio_sha256":sha(&default_pcm),
            "output_hashes":default_output_hashes},
        "ffmpeg_sha256":file_hash(Path::new("/usr/bin/ffmpeg"))?,
        "ffprobe_sha256":file_hash(Path::new("/usr/bin/ffprobe"))?,
        "implementation_hashes":{
            "motion_video.rs":sha(include_bytes!("../src/motion_video.rs")),
            "capabilities.rs":sha(include_bytes!("../src/capabilities.rs")),
            "lib.rs":sha(include_bytes!("../src/lib.rs")),
            "motion_video_output.rs":sha(include_bytes!("motion_video_output.rs"))},
        "evidence_boundary":if cover_first {"Actual muxed cover-first local codec/content/audio evidence; no production or mixed-version qualification"}
            else {"Muxer canonicalized cover last; actual absolute mapping/content/audio evidence only. Cover-first remains pure metadata evidence"}}),
    )
}

#[tokio::test]
#[ignore = "explicit bounded local FFmpeg window required; no services"]
async fn selected_motion_content_and_audio_survive_attached_cover() {
    let mut fixture = Fixture::new().expect("create owned evidence root");
    fixture.record("preflight.json", &json!({
        "owner":"motion_video_output","registered_before_any_child":true,
        "ffmpeg_sha256":file_hash(Path::new("/usr/bin/ffmpeg")).expect("hash approved ffmpeg"),
        "ffprobe_sha256":file_hash(Path::new("/usr/bin/ffprobe")).expect("hash approved ffprobe"),
        "implementation_hashes":{
            "motion_video.rs":sha(include_bytes!("../src/motion_video.rs")),
            "capabilities.rs":sha(include_bytes!("../src/capabilities.rs")),
            "lib.rs":sha(include_bytes!("../src/lib.rs")),
            "motion_video_output.rs":sha(include_bytes!("motion_video_output.rs"))},
        "process_owner":"media_core::child_process::Scope/capture",
        "deadline_seconds":30,"stdout_limit_bytes":4*1024*1024,
        "disk_gate":"available >= total/10 + 64MiB before every child",
        "selected_argv":"generated from validated actual ffprobe indices; each exact command journaled before its spawn"
    })).expect("retain source/tool preflight before any child");
    let scope = child_process::Scope::new();
    let result = scope.run(run(&mut fixture)).await;
    // Always collect positive original-child reaping receipts before inspecting
    // the test result, including every ordinary early error above. PID absence
    // or a zero owner count is never substituted for these receipts.
    let scope_cleanup = scope.shutdown().await;
    let global_cleanup = child_process::shutdown().await;
    let record = match &result {
        Ok(report) => report.clone(),
        Err(error) => json!({"fixture_error":format!("{error:#}")}),
    };
    let report = json!({"result":record,"process_cleanup":{
        "scope_shutdown_ok":scope_cleanup.is_ok(),"global_shutdown_ok":global_cleanup.is_ok(),
        "scope_error":scope_cleanup.as_ref().err().map(ToString::to_string),
        "global_error":global_cleanup.as_ref().err().map(ToString::to_string)}});
    let retained = fixture.record("report.json", &report);
    println!("retained owned evidence: {}", fixture.root.display());
    scope_cleanup.expect("positive scope reaping receipt");
    global_cleanup.expect("positive global reaping receipt");
    retained.expect("retain fixture report");
    result.expect("motion-video fixture result");
}
