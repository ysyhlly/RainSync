//! Opt-in companion daemon. Reuses an already paired Agent credential; never pairs or grants itself compute.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{process::Command, sync::watch};
use uuid::Uuid;
#[derive(Clone)]
struct Node {
    http: reqwest::Client,
    server: String,
    token: String,
    connection: Uuid,
    root: PathBuf,
    output: PathBuf,
    ffmpeg: String,
    ffprobe: String,
    caps: Vec<String>,
}
#[derive(Debug, Deserialize, Clone)]
struct Job {
    id: Uuid,
    attempt: i32,
    output_generation: Uuid,
    lease_ms: u64,
    resource: String,
    source_version: String,
    content_sha256: String,
    source_bytes: u64,
    recipe: String,
    selected_video_index: u32,
    #[serde(deserialize_with = "required_audio_selection")]
    selected_audio_index: Option<u32>,
    output_budget_bytes: u64,
}
fn required_audio_selection<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<u32>, D::Error> {
    Option::<u32>::deserialize(d)
}
#[derive(Serialize, Deserialize, Clone)]
struct Fence {
    connection_id: Uuid,
    attempt: i32,
    output_generation: Uuid,
}
impl Node {
    async fn call(&self, path: &str, body: Option<Value>) -> Result<Value> {
        let request = self
            .http
            .request(
                if body.is_some() {
                    reqwest::Method::POST
                } else {
                    reqwest::Method::GET
                },
                format!("{}/api/v1{path}", self.server),
            )
            .bearer_auth(&self.token);
        let request = if let Some(value) = body {
            request.json(&value)
        } else {
            request
        };
        let reply = request.send().await?;
        ensure!(
            reply.status().is_success(),
            "compute_api_status:{}",
            reply.status()
        );
        Ok(reply.json().await?)
    }
    fn fence(&self, j: &Job) -> Fence {
        Fence {
            connection_id: self.connection,
            attempt: j.attempt,
            output_generation: j.output_generation,
        }
    }
    async fn heartbeat(&self) -> Result<usize> {
        let reply=self.call("/agent-compute/heartbeat",Some(json!({"connection_id":self.connection,"capabilities":self.caps,"self_test":{"version":1,"ffmpeg_sample":"passed","runtime_slots":1}}))).await?;
        Ok(reply["slots"].as_u64().unwrap_or(1).min(1) as usize)
    }
    async fn register_catalog(&self) -> Result<()> {
        let catalog = self.call("/agent-compute/catalog", None).await?;
        for item in catalog["items"].as_array().into_iter().flatten() {
            let resource = item["resource"]
                .as_str()
                .context("compute_catalog_resource")?
                .to_owned();
            let version = item["source_version"]
                .as_str()
                .context("compute_catalog_version")?
                .to_owned();
            let root = self.root.clone();
            let (sha, bytes) = tokio::task::spawn_blocking(move || {
                verify_source(&root, &resource, &version, None)
            })
            .await??;
            self.call("/agent-compute/catalog",Some(json!({"media_id":item["media_id"],"source_version":item["source_version"],"content_sha256":sha,"size_bytes":bytes}))).await?;
        }
        Ok(())
    }
    async fn verify_owned(&self, j: &Job, stop: &mut watch::Receiver<bool>) -> Result<()> {
        let before = tokio::time::Instant::now();
        let renewed = self
            .call(
                &format!("/agent-compute/jobs/{}/renew", j.id),
                Some(serde_json::to_value(self.fence(j))?),
            )
            .await?;
        let mut deadline =
            before + Duration::from_millis(renewed["lease_ms"].as_u64().unwrap_or(0).min(20000));
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let root = self.root.clone();
        let input = j.clone();
        let mut verify = tokio::task::spawn_blocking(move || {
            verify_source_cancellable(
                &root,
                &input.resource,
                &input.source_version,
                Some((&input.content_sha256, input.source_bytes)),
                &flag,
            )
        });
        let mut tick = tokio::time::interval(Duration::from_secs(4));
        tick.tick().await;
        let mut completed = false;
        let result=async {loop{tokio::select!{
            biased;
            _=stopped(stop)=>anyhow::bail!("compute_shutdown"),
            _=tokio::time::sleep_until(deadline)=>anyhow::bail!("compute_lease_lost"),
            verified=&mut verify=>{completed=true;verified??;return Ok::<(),anyhow::Error>(())},
            _=tick.tick()=>{
                let before=tokio::time::Instant::now();
                let renewal_path=format!("/agent-compute/jobs/{}/renew",j.id);
                let renewal=self.call(&renewal_path,Some(serde_json::to_value(self.fence(j))?));
                let reply=tokio::select!{
                    biased;
                    _=stopped(stop)=>anyhow::bail!("compute_shutdown"),
                    _=tokio::time::sleep_until(deadline)=>anyhow::bail!("compute_lease_lost"),
                    verified=&mut verify=>{completed=true;verified??;return Ok::<(),anyhow::Error>(())},
                    result=renewal=>result?,
                };
                ensure!(tokio::time::Instant::now()<deadline,"compute_lease_lost");
                deadline=before+Duration::from_millis(reply["lease_ms"].as_u64().unwrap_or(0).min(20000));
            }
        }}}.await;
        if !completed {
            cancelled.store(true, Ordering::SeqCst);
            let _ = verify.await;
        }
        result
    }
    /// Every encoder, FFprobe and full-decode child is supervised by the exact
    /// current attempt fence. Dropping a waiter does not discharge its owner.
    // Keep the exact job/stop/process owner and separate immutable capture
    // bounds visible at each call; none of these custody fields is optional.
    #[allow(clippy::too_many_arguments)]
    async fn owned_capture(
        &self,
        j: &Job,
        stop: &mut watch::Receiver<bool>,
        started: &AtomicBool,
        mut command: Command,
        max_bytes: usize,
        output: &Path,
        failure: &'static str,
    ) -> Result<Vec<u8>> {
        use tokio::io::AsyncReadExt;
        ensure!(!*stop.borrow(), "compute_shutdown");
        let before = tokio::time::Instant::now();
        let renewed = self
            .call(
                &format!("/agent-compute/jobs/{}/renew", j.id),
                Some(serde_json::to_value(self.fence(j))?),
            )
            .await?;
        let lease_ms = renewed["lease_ms"]
            .as_u64()
            .context("compute_lease_missing")?;
        ensure!((1..=20000).contains(&lease_ms), "compute_lease_invalid");
        let mut deadline = before + Duration::from_millis(lease_ms);
        ensure!(tokio::time::Instant::now() < deadline, "compute_lease_lost");
        media_core::input_policy::clean_environment(&mut command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = media_core::child_process::spawn(command)?;
        started.store(true, Ordering::SeqCst);
        let stdout = child.stdout.take().context("compute_process_stdout")?;
        let operation_deadline = tokio::time::Instant::now() + Duration::from_secs(1800);
        let process = {
            let collect = async {
                let mut bytes = Vec::new();
                let read = async {
                    stdout
                        .take((max_bytes as u64).saturating_add(1))
                        .read_to_end(&mut bytes)
                        .await?;
                    ensure!(bytes.len() <= max_bytes, "compute_probe_capture_limit");
                    Ok::<_, anyhow::Error>(())
                };
                let wait = async { Ok::<_, anyhow::Error>(child.wait().await?) };
                let (_, status) = tokio::try_join!(read, wait)?;
                ensure!(status.success(), "{failure}");
                Ok::<_, anyhow::Error>(bytes)
            };
            tokio::pin!(collect);
            let mut budget = tokio::time::interval(Duration::from_millis(250));
            let mut next_renewal = tokio::time::Instant::now() + Duration::from_secs(4);
            async {
                loop {
                    tokio::select! {
                        biased;
                        _ = stopped(stop) => anyhow::bail!("compute_shutdown"),
                        _ = tokio::time::sleep_until(deadline) => anyhow::bail!("compute_lease_lost"),
                        _ = tokio::time::sleep_until(operation_deadline) => anyhow::bail!("compute_process_deadline"),
                        result = &mut collect => return result,
                        _ = budget.tick() => ensure!(directory_bytes(output).await? <= j.output_budget_bytes, "compute_output_budget_exceeded"),
                        _ = tokio::time::sleep_until(next_renewal) => {
                            let before = tokio::time::Instant::now();
                            let renewal_path = format!("/agent-compute/jobs/{}/renew", j.id);
                            let renewal = self.call(&renewal_path, Some(serde_json::to_value(self.fence(j))?));
                            tokio::pin!(renewal);
                            let reply = loop { tokio::select! {
                                biased;
                                _ = stopped(stop) => anyhow::bail!("compute_shutdown"),
                                _ = tokio::time::sleep_until(deadline) => anyhow::bail!("compute_lease_lost"),
                                _ = tokio::time::sleep_until(operation_deadline) => anyhow::bail!("compute_process_deadline"),
                                result = &mut collect => return result,
                                _ = budget.tick() => ensure!(directory_bytes(output).await? <= j.output_budget_bytes, "compute_output_budget_exceeded"),
                                result = &mut renewal => break result?,
                            }};
                            ensure!(tokio::time::Instant::now() < deadline, "compute_lease_lost");
                            let lease_ms = reply["lease_ms"].as_u64().context("compute_lease_missing")?;
                            ensure!((1..=20000).contains(&lease_ms), "compute_lease_invalid");
                            deadline = before + Duration::from_millis(lease_ms);
                            next_renewal = tokio::time::Instant::now() + Duration::from_secs(4);
                        }
                    }
                }
            }.await
        };
        if process.is_err() {
            child.kill().await?;
        }
        process
    }
    async fn finish_owned(
        &self,
        j: &Job,
        stop: &mut watch::Receiver<bool>,
        body: Value,
    ) -> Result<()> {
        ensure!(!*stop.borrow(), "compute_shutdown");
        let before = tokio::time::Instant::now();
        let renewed = self
            .call(
                &format!("/agent-compute/jobs/{}/renew", j.id),
                Some(serde_json::to_value(self.fence(j))?),
            )
            .await?;
        let lease_ms = renewed["lease_ms"]
            .as_u64()
            .context("compute_lease_missing")?;
        ensure!((1..=20000).contains(&lease_ms), "compute_lease_invalid");
        let mut deadline = before + Duration::from_millis(lease_ms);
        ensure!(tokio::time::Instant::now() < deadline, "compute_lease_lost");
        // Independent Server probing/decoding may exceed the ordinary 3s API
        // timeout. The companion still renews only its exact live attempt.
        let finish = async {
            let response = self
                .http
                .post(format!(
                    "{}/api/v1/agent-compute/jobs/{}/finish",
                    self.server, j.id
                ))
                .bearer_auth(&self.token)
                .timeout(Duration::from_secs(31 * 60))
                .json(&body)
                .send()
                .await?;
            ensure!(
                response.status().is_success(),
                "compute_finish_failed:{}",
                response.status()
            );
            let _: Value = response.json().await?;
            Ok::<(), anyhow::Error>(())
        };
        tokio::pin!(finish);
        let mut next_renewal = tokio::time::Instant::now() + Duration::from_secs(4);
        loop {
            tokio::select! {
                biased;
                _ = stopped(stop) => anyhow::bail!("compute_shutdown"),
                _ = tokio::time::sleep_until(deadline) => anyhow::bail!("compute_lease_lost"),
                result = &mut finish => return result,
                _ = tokio::time::sleep_until(next_renewal) => {
                    let before = tokio::time::Instant::now();
                    let renewal_path = format!("/agent-compute/jobs/{}/renew", j.id);
                            let renewal = self.call(&renewal_path, Some(serde_json::to_value(self.fence(j))?));
                    let reply = tokio::select! {
                        biased;
                        _ = stopped(stop) => anyhow::bail!("compute_shutdown"),
                        _ = tokio::time::sleep_until(deadline) => anyhow::bail!("compute_lease_lost"),
                        result = &mut finish => return result,
                        result = renewal => result?,
                    };
                    ensure!(tokio::time::Instant::now() < deadline, "compute_lease_lost");
                    let lease_ms = reply["lease_ms"].as_u64().context("compute_lease_missing")?;
                    ensure!((1..=20000).contains(&lease_ms), "compute_lease_invalid");
                    deadline = before + Duration::from_millis(lease_ms);
                    next_renewal = tokio::time::Instant::now() + Duration::from_secs(4);
                }
            }
        }
    }
    async fn execute(
        &self,
        j: Job,
        mut stop: watch::Receiver<bool>,
        started: Arc<AtomicBool>,
    ) -> Result<()> {
        use media_core::distributed_compute as qualification;
        ensure!(
            j.lease_ms > 0
                && j.lease_ms <= 20000
                && j.source_bytes > 0
                && j.source_bytes <= 16 * 1024 * 1024 * 1024
                && j.output_budget_bytes > 0
                && j.output_budget_bytes <= 1024 * 1024 * 1024,
            "compute_job_bounds"
        );
        ensure!(
            matches!(j.recipe.as_str(), "remux_hls_v1" | "h264_480p_hls_v1"),
            "unsupported_structured_recipe"
        );
        let began = tokio::time::Instant::now();
        let source = source_path(&self.root, &j.resource)?;
        self.verify_owned(&j, &mut stop).await?;
        let out = self
            .output
            .join(j.id.to_string())
            .join(j.output_generation.to_string());
        tokio::fs::create_dir_all(&out).await?;
        let work = async {
            let source_meta_bytes = self.owned_capture(&j, &mut stop, &started,
                qualification::metadata_command(&self.ffprobe, &source, false), qualification::MAX_METADATA_BYTES, &out, "compute_source_probe_failed").await?;
            let source_meta: Value = serde_json::from_slice(&source_meta_bytes)?;
            qualification::validate_source_probe(&source_meta, j.selected_video_index, j.selected_audio_index, &j.recipe)?;
            let source_frames = self.owned_capture(&j, &mut stop, &started,
                qualification::frames_command(&self.ffprobe, &source, false), qualification::MAX_FRAME_BYTES, &out, "compute_source_frame_probe_failed").await?;
            let source_facts = qualification::qualify_source(&source_meta, &source_frames,
                j.selected_video_index, j.selected_audio_index, &j.recipe)?;
            drop(source_frames);
            let mut command = Command::new(&self.ffmpeg);
            command.args(["-v", "error", "-nostdin", "-y", "-xerror", "-err_detect", "explode", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-i"])
                .arg(&source).arg("-map").arg(format!("0:{}", j.selected_video_index));
            if let Some(index) = j.selected_audio_index { command.arg("-map").arg(format!("0:{index}")); }
            match j.recipe.as_str() {
                "remux_hls_v1" => { command.args(["-c", "copy"]); },
                "h264_480p_hls_v1" => { command.args(["-vf", qualification::H264_480P_VIDEO_FILTER, "-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-pix_fmt", "yuv420p", "-b:v", "1000k", "-maxrate", "1200k", "-bufsize", "2400k", "-g", "100", "-keyint_min", "100", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "96k"]); },
                _ => anyhow::bail!("unsupported_structured_recipe"),
            }
            command.args(["-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_playlist_type", "vod", "-hls_flags", "temp_file", "-hls_segment_filename"])
                .arg(out.join("segment%05d.ts")).arg(out.join("index.m3u8"));
            self.owned_capture(&j, &mut stop, &started, command, 4096, &out, "compute_ffmpeg_failed").await?;
            let mut entries = tokio::fs::read_dir(&out).await?;
            let mut names = BTreeSet::new();
            while let Some(entry) = entries.next_entry().await? {
                ensure!(entry.file_type().await?.is_file(), "unexpected_compute_output");
                let name = entry.file_name().into_string().map_err(|_| anyhow::anyhow!("invalid_compute_filename"))?;
                ensure!(names.insert(name), "duplicate_compute_filename");
            }
            let playlist = tokio::fs::read(out.join("index.m3u8")).await?;
            let segments = qualification::generated_segments(&playlist, &names)?;
            let manifest = out.join("index.m3u8");
            let output_meta_bytes = self.owned_capture(&j, &mut stop, &started,
                qualification::metadata_command(&self.ffprobe, &manifest, true), qualification::MAX_METADATA_BYTES, &out, "compute_output_probe_failed").await?;
            let output_meta: Value = serde_json::from_slice(&output_meta_bytes)?;
            let (output_video, output_audio) = qualification::output_selection(&output_meta, j.selected_audio_index.is_some())?;
            let output_frames = self.owned_capture(&j, &mut stop, &started,
                qualification::frames_command(&self.ffprobe, &manifest, true), qualification::MAX_FRAME_BYTES, &out, "compute_output_frame_probe_failed").await?;
            let output_facts = qualification::measured_media_facts(&output_meta, &output_frames, output_video, output_audio)?;
            drop(output_frames);
            self.owned_capture(&j, &mut stop, &started,
                qualification::decode_command(&self.ffmpeg, &manifest, output_video, output_audio), 4096, &out, "compute_output_full_decode_failed").await?;
            let mut elapsed = 0.0;
            let mut previous_end = None;
            for segment in segments {
                let path = out.join(&segment.filename);
                let bytes = self.owned_capture(&j, &mut stop, &started,
                    qualification::metadata_command(&self.ffprobe, &path, true), qualification::MAX_METADATA_BYTES, &out, "compute_segment_probe_failed").await?;
                let meta: Value = serde_json::from_slice(&bytes)?;
                let frames = self.owned_capture(&j, &mut stop, &started,
                    qualification::first_segment_frames_command(&self.ffprobe, &path, output_video), qualification::MAX_METADATA_BYTES, &out, "compute_segment_frame_probe_failed").await?;
                let timing = qualification::check_segment_probe(&meta, &frames, &output_facts, segment.duration_seconds, elapsed, previous_end)?;
                previous_end = Some(timing.end_seconds);
                elapsed += segment.duration_seconds;
            }
            qualification::check_segment_end(previous_end, &output_facts)?;
            // Re-establish the exact original bytes after all source consumption.
            self.verify_owned(&j, &mut stop).await?;
            let report = qualification::Qualification {
                schema_version: qualification::QUALIFICATION_VERSION, recipe: j.recipe.clone(),
                source_version: j.source_version.clone(), content_sha256: j.content_sha256.clone(),
                selected_video_index: j.selected_video_index, selected_audio_index: j.selected_audio_index,
                timeline_origin_seconds: source_facts.video.timeline.start_seconds,
                output_timestamp_offset_seconds: output_facts.video.timeline.start_seconds - source_facts.video.timeline.start_seconds,
                source: source_facts, output: output_facts, full_decode: true,
            };
            qualification::validate_qualification(&report)?;
            ensure!(directory_bytes(&out).await? <= j.output_budget_bytes, "compute_output_budget_exceeded");
            for name in names {
                ensure!(!*stop.borrow(), "compute_shutdown");
                self.call(&format!("/agent-compute/jobs/{}/renew", j.id), Some(serde_json::to_value(self.fence(&j))?)).await?;
                let bytes = tokio::fs::read(out.join(&name)).await?;
                ensure!(!bytes.is_empty() && bytes.len() <= 8388608, "compute_segment_bounds");
                let sha = hex::encode(Sha256::digest(&bytes));
                let response = self.http.post(format!("{}/api/v1/agent-compute/jobs/{}/files/{name}", self.server, j.id)).bearer_auth(&self.token)
                    .header("x-compute-connection", self.connection.to_string()).header("x-compute-attempt", j.attempt.to_string())
                    .header("x-compute-generation", j.output_generation.to_string()).header("x-content-sha256", sha).body(bytes).send().await?;
                ensure!(response.status().is_success(), "compute_upload_failed:{}", response.status());
            }
            let mut finish = serde_json::to_value(self.fence(&j))?;
            finish["qualification"] = serde_json::to_value(&report)?;
            self.finish_owned(&j, &mut stop, finish).await?;
            tracing::info!(job=%j.id, attempt=j.attempt, elapsed_ms=began.elapsed().as_millis(), "NAS-local measured output qualification published; playback not verified");
            Ok::<(), anyhow::Error>(())
        }.await;
        tokio::fs::remove_dir_all(&out).await?;
        work
    }
}
async fn stopped(stop: &mut watch::Receiver<bool>) {
    while !*stop.borrow_and_update() {
        if stop.changed().await.is_err() {
            return;
        }
    }
}
fn source_path(root: &Path, resource: &str) -> Result<PathBuf> {
    ensure!(
        !resource.is_empty()
            && !Path::new(resource).is_absolute()
            && Path::new(resource)
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_))),
        "compute_source_escape"
    );
    let path = root.join(resource).canonicalize()?;
    ensure!(path.starts_with(root), "compute_source_escape");
    Ok(path)
}
fn verify_source(
    root: &Path,
    resource: &str,
    version: &str,
    expected: Option<(&str, u64)>,
) -> Result<(String, u64)> {
    verify_source_cancellable(root, resource, version, expected, &AtomicBool::new(false))
}
fn verify_source_cancellable(
    root: &Path,
    resource: &str,
    version: &str,
    expected: Option<(&str, u64)>,
    cancelled: &AtomicBool,
) -> Result<(String, u64)> {
    use std::io::Read;
    let path = source_path(root, resource)?;
    let mut file = std::fs::File::open(&path)?;
    let before = media_core::file_version::snapshot_file(&file)?;
    ensure!(
        before.len > 0 && before.len <= 16 * 1024 * 1024 * 1024,
        "compute_source_size_limit"
    );
    ensure!(before.version == version, "compute_source_changed");
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        ensure!(!cancelled.load(Ordering::SeqCst), "compute_hash_cancelled");
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    let after = media_core::file_version::snapshot_file(&file)?;
    ensure!(
        before == after
            && media_core::file_version::snapshot_file(&std::fs::File::open(&path)?)? == before,
        "compute_source_changed"
    );
    let sha = hex::encode(digest.finalize());
    if let Some((hash, len)) = expected {
        ensure!(sha == hash && before.len == len, "compute_content_mismatch")
    };
    Ok((sha, before.len))
}
async fn directory_bytes(path: &Path) -> Result<u64> {
    let mut entries = tokio::fs::read_dir(path).await?;
    let mut bytes = 0;
    while let Some(file) = entries.next_entry().await? {
        let meta = file.metadata().await?;
        ensure!(meta.is_file(), "unexpected_compute_output");
        bytes += meta.len();
    }
    Ok(bytes)
}
async fn self_test(ffmpeg: &str, output: &Path) -> Result<Vec<String>> {
    let dir = output.join(format!("self-test-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await?;
    let mut c = Command::new(ffmpeg);
    c.args([
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=32x32:r=25:d=0.2",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "mpegts",
    ])
    .arg(dir.join("sample.ts"))
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    let mut child = media_core::child_process::spawn(c)?;
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait()).await;
    if status.is_err() {
        child.kill().await?;
    }
    let result = status.context("compute_self_test_timeout")??;
    let good = result.success()
        && tokio::fs::metadata(dir.join("sample.ts"))
            .await
            .is_ok_and(|m| m.len() > 0);
    tokio::fs::remove_dir_all(&dir).await?;
    ensure!(good, "compute_encoder_self_test_failed");
    Ok(vec!["remux_hls_v1".into(), "h264_480p_hls_v1".into()])
}
#[derive(Clone, Serialize, Deserialize)]
struct Receipt {
    job: Uuid,
    fence: Fence,
    server: String,
    process_disposition: Option<String>,
}
struct Journal {
    path: PathBuf,
    entries: BTreeMap<String, Receipt>,
}
impl Journal {
    async fn load(output: &Path) -> Result<Self> {
        let path = output.join(".compute-receipts.json");
        let entries = match tokio::fs::read(&path).await {
            Ok(bytes) => {
                ensure!(
                    bytes.len() <= 4 * 1024 * 1024,
                    "compute_receipt_journal_size"
                );
                serde_json::from_slice::<BTreeMap<String, Receipt>>(&bytes)?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e.into()),
        };
        ensure!(entries.len() <= 4096, "compute_receipt_journal_full");
        for receipt in entries.values() {
            if receipt.process_disposition.is_none() {
                tracing::error!(job=%receipt.job,attempt=receipt.fence.attempt,"previous compute attempt has unknown physical cleanup; preserving its room drain obligation")
            }
        }
        Ok(Self { path, entries })
    }
    async fn save(&self) -> Result<()> {
        use tokio::io::AsyncWriteExt;
        let parent = self.path.parent().context("compute_receipt_parent")?;
        let temp = parent.join(format!(".compute-receipts-{}.tmp", Uuid::new_v4()));
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .await?;
        }
        file.write_all(&serde_json::to_vec(&self.entries)?).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(temp, &self.path).await?;
        // Persist the directory entry too. A successful read later is not durable-write proof.
        let parent = parent.to_path_buf();
        tokio::task::spawn_blocking(move || std::fs::File::open(parent)?.sync_all()).await??;
        Ok(())
    }
    async fn begin(&mut self, n: &Node, j: &Job) -> Result<()> {
        ensure!(self.entries.len() < 4096, "compute_receipt_journal_full");
        self.entries.insert(
            format!("{}:{}", j.id, j.attempt),
            Receipt {
                job: j.id,
                fence: n.fence(j),
                server: n.server.clone(),
                process_disposition: None,
            },
        );
        self.save().await
    }
    async fn drained(&mut self, j: &Job, started: bool) -> Result<()> {
        let receipt = self
            .entries
            .get_mut(&format!("{}:{}", j.id, j.attempt))
            .context("compute_receipt_missing")?;
        receipt.process_disposition = Some(if started { "reaped" } else { "never_started" }.into());
        self.save().await
    }
    async fn flush(&mut self, n: &Node) -> Result<()> {
        let ready = self
            .entries
            .iter()
            .filter(|(_, r)| r.server == n.server && r.process_disposition.is_some())
            .map(|(id, r)| (id.clone(), r.clone()))
            .collect::<Vec<_>>();
        for (key, receipt) in ready {
            let mut body = serde_json::to_value(&receipt.fence)?;
            body["process_disposition"] = json!(receipt.process_disposition);
            match n
                .call(
                    &format!("/agent-compute/jobs/{}/reaped", receipt.job),
                    Some(body),
                )
                .await
            {
                Ok(_) => {
                    self.entries.remove(&key);
                    self.save().await?;
                }
                Err(e) => {
                    tracing::warn!(job=%receipt.job,attempt=receipt.fence.attempt,error=%e,"durable compute drain receipt awaits acknowledgement")
                }
            }
        }
        Ok(())
    }
}
async fn run() -> Result<()> {
    ensure!(
        cfg!(unix),
        "NAS compute companion currently supports verified Unix process/filesystem durability only"
    );
    ensure!(
        std::env::var("RAINSYNC_NAS_COMPUTE_ENABLED").as_deref() == Ok("1"),
        "NAS local compute requires explicit RAINSYNC_NAS_COMPUTE_ENABLED=1"
    );
    let server = std::env::var("SERVER_URL")?
        .trim_end_matches('/')
        .to_owned();
    let parsed = reqwest::Url::parse(&server)?;
    ensure!(
        parsed.scheme() == "https"
            || (parsed.scheme() == "http"
                && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1"))),
        "compute_server_requires_https_or_loopback"
    );
    let credential: Value =
        serde_json::from_slice(&tokio::fs::read(std::env::var("AGENT_CREDENTIAL_FILE")?).await?)?;
    let token = credential["token"]
        .as_str()
        .context("existing_agent_token_required")?
        .to_owned();
    let root = PathBuf::from(std::env::var("COMPUTE_MEDIA_ROOT")?).canonicalize()?;
    let output = PathBuf::from(std::env::var("COMPUTE_OUTPUT_ROOT")?);
    ensure!(
        output.is_absolute(),
        "compute_output_requires_absolute_path"
    );
    tokio::fs::create_dir_all(&output).await?;
    let output = output.canonicalize()?;
    ensure!(
        !output.starts_with(&root) && !root.starts_with(&output),
        "compute_output_must_be_separate_from_media_root"
    );
    let ffmpeg = std::env::var("FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
    let ffprobe = std::env::var("FFPROBE").unwrap_or_else(|_| {
        if Path::new(&ffmpeg).is_absolute() {
            Path::new(&ffmpeg)
                .with_file_name("ffprobe")
                .to_string_lossy()
                .into_owned()
        } else {
            "ffprobe".into()
        }
    });
    let mut n = Node {
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        server,
        token,
        connection: Uuid::new_v4(),
        root,
        output,
        ffmpeg,
        ffprobe,
        caps: Vec::new(),
    };
    let mut journal = Journal::load(&n.output).await?;
    journal.flush(&n).await?;
    ensure!(
        !journal
            .entries
            .values()
            .any(|r| r.process_disposition.is_none()),
        "compute_previous_attempt_drain_unconfirmed"
    );
    n.caps = self_test(&n.ffmpeg, &n.output).await?;
    n.heartbeat().await?;
    let (stop, shutdown) = watch::channel(false);
    let heartbeat = n.clone();
    let mut cancel = shutdown.clone();
    let hb = tokio::spawn(async move {
        loop {
            tokio::select! {_ = stopped(&mut cancel)=>break,_=tokio::time::sleep(Duration::from_secs(4))=>{if let Err(e)=heartbeat.heartbeat().await{tracing::warn!(error=%e,"compute heartbeat failed; job leases will fail closed")}}}
        }
    });
    let work = async {
        loop {
            if *shutdown.borrow() {
                break;
            }
            journal.flush(&n).await?;
            if let Err(e) = n.register_catalog().await {
                tracing::warn!(error=%e,"catalog registration failed; retrying while no job is owned");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
            let reply = match n
                .call(
                    "/agent-compute/claim",
                    Some(json!({"connection_id":n.connection})),
                )
                .await
            {
                Ok(reply) => reply,
                Err(e) => {
                    tracing::warn!(error=%e,"claim unavailable; retrying without an owned job");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            if !reply["job"].is_null() {
                let j: Job = serde_json::from_value(reply["job"].clone())?;
                journal.begin(&n, &j).await?;
                let started = Arc::new(AtomicBool::new(false));
                let scope = media_core::child_process::Scope::new();
                let execution = scope
                    .run(n.execute(j.clone(), shutdown.clone(), started.clone()))
                    .await;
                let process_reaped = match scope.shutdown().await {
                    Ok(()) => true,
                    Err(e) => {
                        tracing::error!(job=%j.id,error=%e,"compute process tree not positively reaped");
                        false
                    }
                };
                // A failed filesystem cleanup prevents acknowledgement; retain the obligation.
                let out = n
                    .output
                    .join(j.id.to_string())
                    .join(j.output_generation.to_string());
                let files_gone = if !process_reaped {
                    false
                } else {
                    match tokio::fs::remove_dir_all(&out).await {
                        Ok(()) => true,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                        Err(e) => {
                            tracing::error!(job=%j.id,error=%e,"compute attempt files not confirmed removed");
                            false
                        }
                    }
                };
                if files_gone && process_reaped {
                    journal.drained(&j, started.load(Ordering::SeqCst)).await?;
                    journal.flush(&n).await?;
                }
                if !files_gone || !process_reaped {
                    anyhow::bail!("compute_attempt_drain_unconfirmed")
                }
                if let Err(e) = execution {
                    tracing::warn!(job=%j.id,error=%e,"structured computation failed");
                    let _ = n
                        .call(
                            &format!("/agent-compute/jobs/{}/fail", j.id),
                            Some(serde_json::to_value(n.fence(&j))?),
                        )
                        .await;
                }
            } else {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    tokio::pin!(work);
    let result = tokio::select! {r=&mut work=>r,_=media_core::process_signal::wait()=>{stop.send_replace(true);work.await}};
    stop.send_replace(true);
    hb.await?;
    result
}
fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let owners = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()?;
    media_core::child_process::set_owner_runtime(owners.handle().clone())?;
    let app = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = app.block_on(run());
    drop(app);
    owners.block_on(media_core::child_process::shutdown())?;
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admitted_audio_selection_is_required_and_absolute() {
        let mut job = json!({"id":Uuid::new_v4(),"attempt":1,"output_generation":Uuid::new_v4(),"lease_ms":20000,"resource":"fixture.mp4","source_version":"version","content_sha256":"a".repeat(64),"source_bytes":1,"recipe":"remux_hls_v1","output_budget_bytes":1000,"selected_video_index":3});
        assert!(serde_json::from_value::<Job>(job.clone()).is_err());
        job["selected_audio_index"] = Value::Null;
        assert_eq!(
            serde_json::from_value::<Job>(job.clone())
                .unwrap()
                .selected_audio_index,
            None
        );
        job["selected_audio_index"] = json!(0);
        assert_eq!(
            serde_json::from_value::<Job>(job)
                .unwrap()
                .selected_audio_index,
            Some(0)
        );
    }
    #[test]
    fn path_scope() {
        let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.mp4"), b"owned").unwrap();
        assert!(source_path(&dir, "../a.mp4").is_err());
        assert!(source_path(&dir, "/a.mp4").is_err());
        let f = std::fs::File::open(dir.join("a.mp4")).unwrap();
        let v = media_core::file_version::snapshot_file(&f).unwrap();
        let (hash, len) = verify_source(&dir, "a.mp4", &v.version, None).unwrap();
        assert_eq!(len, 5);
        assert!(verify_source(&dir, "a.mp4", &v.version, Some((&hash, len))).is_ok());
        assert!(verify_source(&dir, "a.mp4", &v.version, Some((&"0".repeat(64), len))).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
