//! Opt-in, file-only fixture helper. Deliberately absent from production builds:
//! no public capture path, grant, continuation offer, or authority constructor.
use super::{CaptureOwnerIdentity, owned_directory::OwnedDirectory, scanner, timeline};
use anyhow::{Result, ensure};
use serde::Serialize;
use std::{
    io::Read,
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, sync::watch};

const CHILD_TIME: Duration = Duration::from_secs(20);
const CHILD_DURATION_SECONDS: f64 = 20.0;
const OUTPUT_RESOURCE_BYTES: u64 = 4 * 1024 * 1024;
const OUTPUT_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Copy)]
struct ChildBudget {
    wall: Duration,
}
impl ChildBudget {
    fn new(wall: Duration) -> Result<Self> {
        ensure!(!wall.is_zero() && wall <= CHILD_TIME, "child_budget");
        Ok(Self { wall })
    }
}
#[derive(Debug, Serialize, PartialEq)]
enum ChildOutcome {
    Completed,
    Canceled,
    Deadline,
    DecoderFailed,
    OutputBound,
}

struct ProvenSnapshot {
    directory: OwnedDirectory,
    proof: timeline::TimelineProof,
    probe: serde_json::Value,
    source_facts: serde_json::Value,
    decoder: scanner::DecoderEvidence,
    selected_audio: Option<u32>,
}

async fn input_bytes(path: PathBuf, maximum: usize) -> Result<Vec<u8>> {
    crate::child_process::blocking(move || {
        use std::os::unix::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?;
        let meta = file.metadata()?;
        ensure!(
            meta.is_file() && meta.len() > 0 && meta.len() <= maximum as u64,
            "fixture_input_bound"
        );
        let mut bytes = Vec::new();
        file.take(maximum as u64 + 1).read_to_end(&mut bytes)?;
        ensure!(bytes.len() == meta.len() as usize, "fixture_input_changed");
        Ok(bytes)
    })
    .await?
}

async fn capture_fixture(source: &Path, cache: &Path) -> Result<ProvenSnapshot> {
    let capture_id = uuid::Uuid::new_v4().to_string();
    let identity = CaptureOwnerIdentity {
        relative_key: format!("static-hls/{capture_id}"),
        capture_id,
        owner_id: uuid::Uuid::new_v4().to_string(),
    };
    let mut directory = OwnedDirectory::create(cache, &identity)?;
    let manifest = input_bytes(source.join("index.m3u8"), super::MANIFEST_BYTES).await?;
    let text = std::str::from_utf8(&manifest)?;
    let playlist = timeline::parse_playlist(text)?;
    let local_name = |value: &str| -> Result<()> {
        ensure!(
            Path::new(value).file_name().and_then(|s| s.to_str()) == Some(value)
                && value
                    .bytes()
                    .all(|v| v.is_ascii_alphanumeric() || b"-_.".contains(&v)),
            "fixture_local_basename_required"
        );
        Ok(())
    };
    local_name(&playlist.map)?;
    let init = input_bytes(source.join(&playlist.map), super::INIT_BYTES).await?;
    let mut structure = timeline::Structure::new(text, &init)?;
    let mut local = format!(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:32\n#EXT-X-MEDIA-SEQUENCE:{}\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI=\"init.mp4\"\n",
        playlist.sequence
    );
    for (i, segment) in playlist.segments.iter().enumerate() {
        local.push_str(&format!("#EXTINF:{:.6},\ns{i:03}.m4s\n", segment.duration));
    }
    local.push_str("#EXT-X-ENDLIST\n");
    directory.reserve_local_manifest(local.len())?;
    directory
        .write_complete_scoped("source.bin", manifest.clone())
        .await?;
    directory.write_complete_scoped("init.mp4", init).await?;
    for (i, segment) in playlist.segments.iter().enumerate() {
        local_name(&segment.uri)?;
        let bytes = input_bytes(source.join(&segment.uri), super::RESOURCE_BYTES).await?;
        structure.ingest_fragment(&bytes, i)?;
        directory
            .write_complete_scoped(&format!("s{i:03}.m4s"), bytes)
            .await?;
    }
    directory
        .write_complete_scoped("index.m3u8", local.into_bytes())
        .await?;
    directory.seal_scoped().await?;
    let (probe, decoder) = scanner::decode(&directory, &mut false).await?;
    let proof = structure.inspect_probe(&probe)?;
    // Track selection comes from the complete actual decode, never env/client
    // metadata. The admitted subset has at most one audio stream.
    let selected_audio = proof
        .tracks
        .iter()
        .find(|t| t.kind == timeline::TrackKind::Audio)
        .map(|t| t.stream_index);
    let source_facts = scanner::qualify_source(&probe, selected_audio)?;
    Ok(ProvenSnapshot {
        directory,
        proof,
        probe,
        source_facts,
        decoder,
        selected_audio,
    })
}

fn child_args(
    input: &str,
    output: &Path,
    start: f64,
    audio: Option<u32>,
    sequential: bool,
    source_end: f64,
) -> Vec<String> {
    let mut args = crate::capabilities::negotiated_hls_args(
        input,
        output.join("index.m3u8").to_str().unwrap(),
        start,
        "transcode",
        audio,
    );
    // Test execution limits and explicit silent-source mapping are independent
    // of the generic recipe trial. Every source was already fully qualified.
    args.splice(
        0..0,
        [
            "-v",
            "error",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-max_alloc",
            "134217728",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            "hls,mov",
        ]
        .map(String::from),
    );
    let at = args.iter().position(|a| a == "-c:v").unwrap();
    args.splice(at..at, ["-threads", "1"].map(String::from));
    if audio.is_none() {
        let at = args.iter().rposition(|a| a == "-map").unwrap();
        args.splice(at..at + 2, ["-an".to_owned()]);
    }
    if sequential {
        if let Some(at) = args.iter().position(|a| a == "-ss") {
            args.drain(at..at + 2);
        }
        let at = args.iter().position(|a| a == "-i").unwrap();
        args.insert(at, "-copyts".into());
        let at = args.iter().position(|a| a == "-vf").unwrap() + 1;
        args[at] = format!(
            "trim=start={start}:end={source_end},setpts=PTS-{start}/TB,{},fps=fps=30:start_time=0:round=near",
            args[at]
        );
        if audio.is_some() {
            let at = args.iter().position(|a| a == "-c:a").unwrap();
            args.splice(
                at..at,
                [
                    "-af".into(),
                    format!("atrim=start={start}:end={source_end},asetpts=PTS-{start}/TB"),
                ],
            );
        }
    }
    // Fixed 20-second media window => at most five forced-four-second segments,
    // init, manifest and one temp file. RLIMIT_FSIZE bounds each to 4 MiB;
    // the fixture checks all eight allowed names and total 32 MiB after reap.
    let at = args.len() - 1;
    args.splice(
        at..at,
        [
            "-t".into(),
            CHILD_DURATION_SECONDS.to_string(),
            "-hls_segment_filename".into(),
            output.join("s%03d.m4s").to_str().unwrap().into(),
        ],
    );
    args
}

async fn pipe(mut pipe: impl tokio::io::AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let mut chunk = vec![0u8; 65536];
        let n = pipe.read(&mut chunk).await?;
        if n == 0 {
            return Ok(out);
        }
        ensure!(out.len() + n <= limit, "child_output_bound");
        out.extend_from_slice(&chunk[..n]);
    }
}

async fn run_child(
    command: tokio::process::Command,
    budget: ChildBudget,
    stop: &mut watch::Receiver<bool>,
) -> Result<(ChildOutcome, Vec<u8>)> {
    let until = tokio::time::Instant::now() + budget.wall;
    if *stop.borrow() {
        return Ok((ChildOutcome::Canceled, vec![]));
    }
    let mut child = crate::child_process::spawn(command)?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let work = async {
        let (_, err, status) = tokio::try_join!(pipe(stdout, 65536), pipe(stderr, 65536), async {
            child.wait().await.map_err(anyhow::Error::from)
        })?;
        Ok::<_, anyhow::Error>((status, err))
    };
    let result = tokio::select! {
        biased;
        _ = stop.changed() => (ChildOutcome::Canceled, vec![]),
        _ = tokio::time::sleep_until(until) => (ChildOutcome::Deadline, vec![]),
        completed = work => match completed {
            _ if *stop.borrow() => (ChildOutcome::Canceled, vec![]),
            _ if tokio::time::Instant::now() >= until => (ChildOutcome::Deadline, vec![]),
            Ok((status, err)) if status.success() && err.is_empty() => (ChildOutcome::Completed, err),
            Ok((_, err)) => (ChildOutcome::DecoderFailed, err),
            Err(_) => (ChildOutcome::OutputBound, vec![]),
        }
    };
    // Dropping a waiter requests stop; independently owned Scope drains before
    // the fixture publishes a reaping observation or removes source custody.
    drop(child);
    Ok(result)
}

#[test]
fn child_budgets_are_separate_and_cannot_expand() {
    assert_eq!(super::CAPTURE_TIME, Duration::from_secs(35));
    assert_eq!(CHILD_TIME, Duration::from_secs(20));
    assert!(ChildBudget::new(Duration::ZERO).is_err());
    assert!(ChildBudget::new(Duration::from_secs(21)).is_err());
    assert!(ChildBudget::new(Duration::from_millis(1)).is_ok());
}

#[tokio::test]
#[ignore = "file-only native helper, invoked by tests/static-hls-child-timeline-native.mjs"]
async fn sealed_hls_child_fixture() -> Result<()> {
    // Correlation only, not an authority token. The outer fixture persisted
    // responsibility and opened its receipt channel before this helper spawn.
    let outer_owner_id = std::env::var("RAINSYNC_HLS_FIXTURE_OWNER_ID")?;
    uuid::Uuid::parse_str(&outer_owner_id)?;
    let source = PathBuf::from(std::env::var("RAINSYNC_HLS_FIXTURE_SOURCE")?);
    let output = PathBuf::from(std::env::var("RAINSYNC_HLS_FIXTURE_OUTPUT")?);
    std::fs::create_dir(&output)?;
    let cache = output.join("capture");
    std::fs::create_dir(&cache)?;
    let child_output = output.join("child");
    std::fs::create_dir(&child_output)?;
    let start: f64 = std::env::var("RAINSYNC_HLS_FIXTURE_START")?.parse()?;
    ensure!(start.is_finite() && start >= 0.0, "fixture_start");
    let scope = crate::child_process::Scope::new();
    let capture_began = tokio::time::Instant::now();
    let snapshot = scope
        .run(tokio::time::timeout(
            super::CAPTURE_TIME,
            Box::pin(capture_fixture(&source, &cache)),
        ))
        .await??;
    let capture_elapsed_ms = capture_began.elapsed().as_millis();
    ensure!(
        start * 1000.0 < snapshot.proof.duration_ms,
        "fixture_start_outside_source"
    );
    let sequential = std::env::var("RAINSYNC_HLS_FIXTURE_RECIPE")? == "sequential";
    let held = snapshot.directory.decoder_fd_scoped().await?;
    let fd = held.as_raw_fd();
    let input = format!("/proc/self/fd/{fd}/index.m3u8");
    let args = child_args(
        &input,
        &child_output,
        start,
        snapshot.selected_audio,
        sequential,
        snapshot.proof.duration_ms / 1000.0,
    );
    let mut command = tokio::process::Command::new("/usr/bin/ffmpeg");
    crate::input_policy::clean_environment(&mut command);
    command
        .args(&args)
        .env("OPENBLAS_NUM_THREADS", "1")
        .env("OMP_NUM_THREADS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            for (kind, maximum) in [
                (libc::RLIMIT_AS, 1024 * 1024 * 1024),
                (libc::RLIMIT_CPU, 20),
                (libc::RLIMIT_FSIZE, OUTPUT_RESOURCE_BYTES),
            ] {
                let limit = libc::rlimit {
                    rlim_cur: maximum,
                    rlim_max: maximum,
                };
                if libc::setrlimit(kind, &limit) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let wall = std::env::var("RAINSYNC_HLS_FIXTURE_WALL_MS")
        .ok()
        .map(|v| v.parse::<u64>())
        .transpose()?
        .map(Duration::from_millis)
        .unwrap_or(CHILD_TIME);
    let budget = ChildBudget::new(wall)?;
    let (cancel, mut canceled) = watch::channel(false);
    let cancellation = std::env::var("RAINSYNC_HLS_FIXTURE_CANCEL_MS")
        .ok()
        .map(|v| v.parse::<u64>())
        .transpose()?;
    let cancel_task = cancellation.map(|ms| {
        let cancel = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            cancel.send_replace(true);
        })
    });
    let began = tokio::time::Instant::now();
    let (outcome, stderr) = scope
        .run(Box::pin(run_child(command, budget, &mut canceled)))
        .await?;
    if let Some(task) = cancel_task {
        task.abort();
    }
    scope.shutdown().await?;
    drop(held);
    let mut files = Vec::new();
    let mut total = 0;
    for entry in std::fs::read_dir(&child_output)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        ensure!(
            name == "index.m3u8"
                || name == "index.m3u8.tmp"
                || name == "init.mp4"
                || (0..5)
                    .any(|i| name == format!("s{i:03}.m4s") || name == format!("s{i:03}.m4s.tmp")),
            "child_unowned_output"
        );
        let metadata = entry.metadata()?;
        ensure!(
            metadata.is_file() && metadata.len() <= OUTPUT_RESOURCE_BYTES,
            "child_resource_bound"
        );
        total += metadata.len();
        files.push((name, metadata.len()));
    }
    ensure!(
        files.len() <= 8 && total <= OUTPUT_BYTES,
        "child_total_output_bound"
    );
    std::fs::write(
        output.join("source-probe.json"),
        serde_json::to_vec(&snapshot.probe)?,
    )?;
    std::fs::write(output.join("child.stderr"), stderr)?;
    let mut directory = snapshot.directory;
    directory.remove_owned()?;
    std::fs::write(
        output.join("native-report.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "scope":"file-only-sealed-HLS-child-fixture", "accepted":false, "release_ready":false,
            "outer_owner_id":outer_owner_id,
            "production_fallback_enabled":false, "source_proof":snapshot.proof,
            "source_facts":snapshot.source_facts, "source_decoder":snapshot.decoder,
            "selected_audio":snapshot.selected_audio, "args":args, "start_seconds":start,
            "recipe":if sequential {"sequential-presentation-trim"} else {"generic-input-seek"},
            "outcome":outcome, "elapsed_ms":began.elapsed().as_millis(),
            "capture_elapsed_ms":capture_elapsed_ms,
            "capture_wall_ms":super::CAPTURE_TIME.as_millis(), "child_wall_ms":budget.wall.as_millis(),
            "child_duration_seconds":CHILD_DURATION_SECONDS, "output_resource_bytes":OUTPUT_RESOURCE_BYTES,
            "output_budget_bytes":OUTPUT_BYTES, "actual_output_bytes":total, "output_files":files,
            "process_scope_reaped":true, "source_custody_removed_after_reap":true,
            "timeout_is_decoder_failure_authority":false
        }))?,
    )?;
    Ok(())
}
