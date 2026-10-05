//! Opt-in native evidence for the inactive, original-owner core candidate.
//! Real FFmpeg bytes pass the complete capture scanner, original input/output
//! owners, recipe-bound encoding, and complete child-output decoder. Authority
//! adapters below are TEST FIXTURES ONLY: this proves neither durable admission,
//! database concurrency, Worker authority, nor public playback eligibility.
#![cfg(target_os = "linux")]

use anyhow::{Context, Result, ensure};
use media_core::{
    child_process,
    static_hls::{
        self, CaptureBody, CaptureFuture, CaptureOptions, CaptureOwnerIdentity, CapturePermit,
        CaptureTransport, DisposalProof, ProcessDisposition, ResourceIdentity, ResponseFacts,
        VerifiedCapture,
        child_output_owner::{ChildOutputOwner, OutputIdentity, OutputPermit},
        child_output_validation,
        child_recipe::{self, CandidateChildRecipe, ChildEncodeBudget},
    },
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{io::AsyncReadExt, time::Instant};

const SOURCE_SECONDS: u64 = 3;
const POSITION_MS: f64 = 1013.0;
const FRACTIONAL_POSITION_MS: f64 = 1013.5;
const SOURCE_URL: &str = "https://native-fixture.invalid/source/index.m3u8";

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Result<Self> {
        let parent = PathBuf::from(
            std::env::var_os("RAINSYNC_CHILD_CANDIDATE_REPORT_DIR")
                .context("RAINSYNC_CHILD_CANDIDATE_REPORT_DIR is required for retained evidence")?,
        );
        ensure!(
            parent.is_absolute() && parent.is_dir(),
            "fixture_report_parent"
        );
        let root = parent.join(format!("child-owned-candidate-{}", uuid::Uuid::new_v4()));
        std::fs::DirBuilder::new().mode(0o700).create(&root)?;
        for name in ["source", "capture", "output"] {
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(root.join(name))?;
        }
        Ok(Self { root })
    }

    fn record(&self, name: &str, value: &Value) -> Result<()> {
        std::fs::write(self.root.join(name), serde_json::to_vec_pretty(value)?)?;
        Ok(())
    }

    fn disk_gate(&self) -> Result<Value> {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(self.root.as_os_str().as_bytes())?;
        let mut raw = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        ensure!(
            unsafe { libc::statvfs(path.as_ptr(), raw.as_mut_ptr()) } == 0,
            "fixture_statvfs"
        );
        let raw = unsafe { raw.assume_init() };
        let total = raw
            .f_blocks
            .checked_mul(raw.f_frsize)
            .context("disk total overflow")?;
        let available = raw
            .f_bavail
            .checked_mul(raw.f_frsize)
            .context("disk free overflow")?;
        // This fixture's sources and retained reports are independent of the
        // core's input/output reservations. Leave the cache's 10% floor intact.
        let headroom = 64 * 1024 * 1024;
        let minimum =
            total / 10 + static_hls::TOTAL_BYTES as u64 + child_recipe::MAX_OUTPUT_BYTES + headroom;
        ensure!(
            available >= minimum,
            "fixture_disk_gate:{available}<{minimum}"
        );
        Ok(json!({"total_bytes":total,"available_bytes":available,"minimum_bytes":minimum}))
    }

    async fn generate_source(&self) -> Result<()> {
        let output = self.root.join("source/index.m3u8");
        let output = output.to_str().context("fixture UTF-8 output")?;
        let args = [
            "-hide_banner",
            "-v",
            "error",
            "-nostdin",
            "-n",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-max_alloc",
            "134217728",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=25:duration=3",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=3",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-threads:v",
            "1",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-bf",
            "0",
            "-g",
            "25",
            "-sc_threshold",
            "0",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ar",
            "48000",
            "-ac",
            "1",
            "-avoid_negative_ts",
            "disabled",
            "-t",
            "3",
            "-f",
            "hls",
            "-hls_time",
            "1",
            "-hls_segment_type",
            "fmp4",
            "-hls_playlist_type",
            "vod",
            "-hls_fmp4_init_filename",
            "init.mp4",
            output,
        ];
        let disk = self.disk_gate()?;
        self.record(
            "source-command-registered.json",
            &json!({
                "binary":"/usr/bin/ffmpeg","argv":&args[..],
                "argv_sha256":sha(&serde_json::to_vec(&args[..])?),
                "ffmpeg_sha256":sha(&std::fs::read("/usr/bin/ffmpeg")?),
                "ffprobe_sha256":sha(&std::fs::read("/usr/bin/ffprobe")?),
                "wall_seconds":20,"stdout_limit_bytes":65536,"disk_gate":disk,
                "process_owner":"media_core::child_process::Scope/capture",
                "scope":"finite synthetic file-only source generation"
            }),
        )?;
        let mut command = tokio::process::Command::new("/usr/bin/ffmpeg");
        media_core::input_policy::clean_environment(&mut command);
        command
            .args(args)
            .current_dir(&self.root)
            .env("OPENBLAS_NUM_THREADS", "1")
            .env("OMP_NUM_THREADS", "1");
        unsafe {
            command.pre_exec(|| {
                for (kind, maximum) in [
                    (libc::RLIMIT_AS, child_recipe::MAX_ADDRESS_SPACE_BYTES),
                    (libc::RLIMIT_CPU, child_recipe::MAX_CPU_SECONDS),
                    (libc::RLIMIT_FSIZE, child_recipe::MAX_OUTPUT_RESOURCE_BYTES),
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
        let scope = child_process::Scope::new();
        let result = scope
            .run(child_process::capture(
                command,
                Duration::from_secs(20),
                65536,
            ))
            .await;
        let drained = scope.shutdown().await;
        let completion = match &result {
            Ok((status, bytes)) => json!({
                "success":status.success(),"exit_code":status.code(),
                "stdout_bytes":bytes.len(),"stdout_sha256":sha(bytes),
                "actual_process_scope_drained":drained.is_ok()
            }),
            Err(error) => json!({"capture_error":error.to_string(),
                "actual_process_scope_drained":drained.is_ok()}),
        };
        self.record("source-command-completed.json", &completion)?;
        drained?;
        let (status, _) = result?;
        ensure!(status.success(), "fixture_source_encoding_failed:{status}");
        Ok(())
    }
}

// Explicit synthetic authority adapters. They cannot be used to infer a DB
// claim/reservation, source gateway authorization, or production activation.
struct FixtureCapturePermit {
    identity: CaptureOwnerIdentity,
    checks: AtomicUsize,
    disposal: Mutex<Option<Arc<DisposalProof>>>,
}
impl CapturePermit for FixtureCapturePermit {
    fn identity(&self) -> CaptureOwnerIdentity {
        self.identity.clone()
    }
    fn check(&self) -> CaptureFuture<'_, ()> {
        Box::pin(async {
            self.checks.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
    fn acknowledge_disposal(&self, proof: Arc<DisposalProof>) -> CaptureFuture<'_, ()> {
        Box::pin(async move {
            ensure!(
                proof.identity() == &self.identity && proof.all_positive(),
                "fixture_actual_disposal"
            );
            *self.disposal.lock().unwrap() = Some(proof);
            Ok(())
        })
    }
}

struct FixtureOutputPermit {
    identity: OutputIdentity,
    original_input: Arc<static_hls::EncoderInputLease>,
    checks: AtomicUsize,
    write_checks: AtomicUsize,
}
impl OutputPermit for FixtureOutputPermit {
    fn require_original_input(&self, input: &Arc<static_hls::EncoderInputLease>) -> Result<()> {
        ensure!(
            Arc::ptr_eq(&self.original_input, input),
            "fixture_original_input_required"
        );
        Ok(())
    }
    fn identity(&self) -> OutputIdentity {
        self.identity.clone()
    }
    fn check(&self) -> CaptureFuture<'_, ()> {
        Box::pin(async {
            self.checks.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
    fn check_write(&self) -> CaptureFuture<'_, ()> {
        Box::pin(async {
            self.write_checks.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}

struct FixtureBody {
    target: String,
    etag: String,
    bytes: Vec<u8>,
    offset: usize,
}
impl CaptureBody for FixtureBody {
    fn facts(&self) -> ResponseFacts {
        ResponseFacts {
            status: 200,
            final_url: self.target.clone(),
            strong_etag: Some(self.etag.clone()),
            content_length: Some(self.bytes.len() as u64),
            identity_encoding: true,
        }
    }
    fn chunk(&mut self) -> CaptureFuture<'_, Option<Vec<u8>>> {
        Box::pin(async {
            if self.offset == self.bytes.len() {
                return Ok(None);
            }
            let end = self.bytes.len().min(self.offset + 65536);
            let chunk = self.bytes[self.offset..end].to_vec();
            self.offset = end;
            Ok(Some(chunk))
        })
    }
}

// The `.invalid` URLs are map keys only. No socket, HTTP client, or external
// source is involved; the scanner receives the original generated media bytes.
struct FixtureTransport {
    resources: BTreeMap<String, Vec<u8>>,
    conditional_requests: Mutex<Vec<String>>,
}
impl FixtureTransport {
    fn from_directory(source: &Path) -> Result<Self> {
        let mut resources = BTreeMap::new();
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("fixture_source_name"))?;
            ensure!(
                entry.file_type()?.is_file() && !name.contains('/'),
                "fixture_source_file"
            );
            let bytes = std::fs::read(entry.path())?;
            ensure!(
                !bytes.is_empty() && bytes.len() <= static_hls::RESOURCE_BYTES,
                "fixture_source_bound"
            );
            resources.insert(
                format!("https://native-fixture.invalid/source/{name}"),
                bytes,
            );
        }
        Ok(Self {
            resources,
            conditional_requests: Mutex::new(Vec::new()),
        })
    }
    fn body(&self, target: &str) -> Result<Box<dyn CaptureBody>> {
        let bytes = self
            .resources
            .get(target)
            .context("fixture_unknown_resource")?
            .clone();
        let etag = format!("\"{}\"", sha(&bytes));
        Ok(Box::new(FixtureBody {
            target: target.to_owned(),
            etag,
            bytes,
            offset: 0,
        }))
    }
}
impl CaptureTransport for FixtureTransport {
    fn get<'a>(&'a self, target: &'a str) -> CaptureFuture<'a, Box<dyn CaptureBody>> {
        Box::pin(async move { self.body(target) })
    }
    fn conditional_get<'a>(
        &'a self,
        target: &'a str,
        identity: &'a ResourceIdentity,
    ) -> CaptureFuture<'a, Box<dyn CaptureBody>> {
        Box::pin(async move {
            let bytes = self
                .resources
                .get(target)
                .context("fixture_unknown_resource")?;
            let digest = sha(bytes);
            ensure!(
                identity.original_target_sha256 == sha(target.as_bytes())
                    && identity.final_target_sha256 == sha(target.as_bytes())
                    && identity.sha256 == digest
                    && identity.bytes == bytes.len()
                    && identity.strong_etag == format!("\"{digest}\""),
                "fixture_conditional_identity"
            );
            self.conditional_requests
                .lock()
                .unwrap()
                .push(target.to_owned());
            self.body(target)
        })
    }
}

async fn drain_diagnostic(mut pipe: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0u8; 4096];
        let count = pipe.read(&mut chunk).await?;
        if count == 0 {
            return Ok(bytes);
        }
        ensure!(
            count <= child_recipe::MAX_DIAGNOSTIC_PIPE_BYTES.saturating_sub(bytes.len()),
            "fixture_child_diagnostic_bound"
        );
        bytes.extend_from_slice(&chunk[..count]);
    }
}

async fn encode(
    output: &ChildOutputOwner,
    recipe: &CandidateChildRecipe<'_>,
    budget: &ChildEncodeBudget,
) -> Result<Value> {
    let mut child = recipe.spawn_owned(output, budget).await?;
    let stderr = child.stderr.take().context("fixture_child_stderr")?;
    let result = tokio::time::timeout_at(budget.until(), async {
        tokio::try_join!(drain_diagnostic(stderr), async {
            child.wait().await.map_err(anyhow::Error::from)
        })
    })
    .await;
    let (diagnostic, status) = match result {
        Ok(Ok(done)) => done,
        failure => {
            child
                .kill()
                .await
                .context("fixture_child_cleanup_unconfirmed")?;
            return match failure {
                Ok(Err(error)) => Err(error),
                Err(_) => Err(anyhow::anyhow!("fixture_child_encode_deadline")),
                Ok(Ok(_)) => unreachable!(),
            };
        }
    };
    ensure!(
        status.success() && diagnostic.is_empty(),
        "fixture_child_encode_failed:{status}:{}",
        String::from_utf8_lossy(&diagnostic)
    );
    Ok(
        json!({"success":true,"exit_code":status.code(),"stderr_bytes":diagnostic.len(),
        "stderr_sha256":sha(&diagnostic),"original_child_wait_observed":true}),
    )
}

async fn run_child(
    fixture: &Fixture,
    capture: &VerifiedCapture,
    position_ms: f64,
    report_prefix: &str,
) -> Result<Value> {
    let record = |name: &str, value: &Value| {
        let filename = if report_prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{report_prefix}-{name}")
        };
        fixture.record(&filename, value)
    };
    record(
        "child-phase.json",
        &json!({"phase":"candidate preparation"}),
    )?;
    let preparation_until = Instant::now() + child_recipe::MAX_ENCODE_TIME;
    let budget = ChildEncodeBudget::begin(preparation_until, preparation_until)?;
    let recipe = CandidateChildRecipe::from_capture(capture, position_ms).await?;
    ensure!(
        recipe.selected_video() == 0
            && recipe.selected_audio() == 1
            && recipe.source_end_seconds() == SOURCE_SECONDS as f64
            && recipe.position_ms().to_bits() == position_ms.to_bits(),
        "fixture_actual_source_recipe"
    );
    let input = Arc::new(capture.prepare_encoder_input(budget.until()).await?);
    let permit = Arc::new(FixtureOutputPermit {
        original_input: input.clone(),
        identity: OutputIdentity::new(
            uuid::Uuid::new_v4().to_string(),
            1,
            uuid::Uuid::new_v4().to_string(),
        )?,
        checks: AtomicUsize::new(0),
        write_checks: AtomicUsize::new(0),
    });
    let original_permit: Arc<dyn OutputPermit> = permit.clone();
    let output = ChildOutputOwner::prepare(original_permit.clone(), input, budget.until())?;
    let output_path = fixture
        .root
        .join("output")
        .join(output.identity().relative_key());
    let result = async {
        fixture.disk_gate()?;
        output.create_in(&fixture.root.join("output")).await?;
        record("child-command-registered.json", &json!({
            "candidate":child_recipe::CANDIDATE_NAME,"source_position_ms":position_ms,
            "source_end_seconds":recipe.source_end_seconds(),"selected_video":recipe.selected_video(),
            "selected_audio":recipe.selected_audio(),"recipe_source":"original VerifiedCapture",
            "input_owner":"original EncoderInputLease sealed directory descriptor",
            "output_owner":"original ChildOutputOwner fresh attempt descriptor",
            "synthetic_fixture_authority_only":true,"production_eligibility_proven":false,
            "wall_remaining_milliseconds":budget.remaining()?.as_millis(),
            "cpu_seconds":child_recipe::MAX_CPU_SECONDS,
            "address_space_bytes":child_recipe::MAX_ADDRESS_SPACE_BYTES,
            "per_file_bytes":child_recipe::MAX_OUTPUT_RESOURCE_BYTES,
            "aggregate_bytes":child_recipe::MAX_OUTPUT_BYTES
        }))?;
        let child = encode(&output, &recipe, &budget).await?;
        record("child-command-completed.json", &child)?;
        let validated = Box::pin(child_output_validation::validate(&output, &recipe)).await?;
        validated.check().await?;
        ensure!(validated.identity() == output.identity()
            && validated.source_identity() == capture.control()?.identity(), "fixture_original_validation_identity");
        let decoder = validated.decoder();
        ensure!(decoder.exit_code == 0 && decoder.stderr_bytes == 0 && decoder.stdout_bytes > 0
            && decoder.process_tree_reaped, "fixture_complete_decoder_required");
        ensure!(validated.evidence_json()?["requested_position_ms"].as_f64() == Some(position_ms),
            "fixture_exact_requested_position_evidence");
        let timeline = validated.decoded_timeline();
        ensure!(timeline.video_frames > 0 && timeline.audio_packets > 0 && timeline.audio_decoded_frames > 0
            && timeline.source_position_ms.to_bits() == position_ms.to_bits()
            && timeline.source_end_seconds == SOURCE_SECONDS as f64, "fixture_complete_decoded_timeline");
        let resources = validated.resources().iter().map(|resource| json!({
            "name":resource.name,"bytes":resource.bytes,"sha256":resource.sha256
        })).collect::<Vec<_>>();
        let positive = json!({
            "core_candidate_fixture_validated":true,"production_eligibility_proven":false,
            "candidate_default_enabled":child_recipe::DEFAULT_ENABLED,
            "decoder":decoder,"resources":resources,
            "decoded_timeline":{
                "video_frames":timeline.video_frames,"video_time_base":timeline.video_time_base,
                "video_end_seconds":timeline.video_end_seconds,"audio_packets":timeline.audio_packets,
                "audio_decoded_frames":timeline.audio_decoded_frames,
                "audio_priming_samples":timeline.audio_priming_samples,
                "audio_tail_padding_samples":timeline.audio_tail_padding_samples,
                "audio_raw_end_samples":timeline.audio_raw_end_samples,
                "audio_decoded_end_samples":timeline.audio_decoded_end_samples,
                "source_position_ms":timeline.source_position_ms,"source_end_seconds":timeline.source_end_seconds
            }
        });
        record("validated-child.json", &positive)?;

        // A second genuine recipe from the SAME capture still cannot relabel
        // bytes produced by either actual requested recipe as a 13ms trim.
        let wrong_recipe = CandidateChildRecipe::from_capture(capture, 13.0).await?;
        let trim_error = Box::pin(child_output_validation::validate(&output, &wrong_recipe)).await
            .err().context("fixture_wrong_trim_accepted")?;
        ensure!(trim_error.to_string().contains("recipe"), "fixture_wrong_trim_rejection:{trim_error}");

        // Even another request within the same FFmpeg microsecond tick cannot
        // replace the exact original scalar in this actual owner's binding.
        let nearby_position_ms = position_ms + 0.0000001;
        let nearby_recipe = CandidateChildRecipe::from_capture(capture, nearby_position_ms).await?;
        let nearby_error = Box::pin(child_output_validation::validate(&output, &nearby_recipe)).await
            .err().context("fixture_nearby_trim_accepted")?;
        ensure!(nearby_error.to_string().contains("recipe"),
            "fixture_nearby_trim_rejection:{nearby_error}");

        // Deliberate TEST-LOCAL corruption of the actual final output resource,
        // after positive complete validation. This ordinary path is never an
        // input to the validator and is not an ownership/custody constructor.
        let last = validated.resources().last().context("fixture_missing_final_segment")?;
        ensure!(last.name.starts_with('s') && last.name.ends_with(".m4s"), "fixture_final_segment_name");
        let path = output_path.join(&last.name);
        let mut bytes = std::fs::read(&path)?;
        ensure!(!bytes.is_empty() && sha(&bytes) == last.sha256, "fixture_retained_segment_identity");
        let index = bytes.len() - 1;
        bytes[index] ^= 1;
        std::fs::write(&path, bytes)?;
        let changed_error = validated.check().await.err().context("fixture_changed_last_segment_accepted")?;
        ensure!(changed_error.to_string().contains("changed_after_validation"),
            "fixture_changed_segment_rejection:{changed_error}");
        record("negative-controls.json", &json!({
            "wrong_trim_requested_ms":13,"actual_trim_ms":position_ms,
            "wrong_trim_rejection":trim_error.to_string(),
            "nearby_trim_requested_ms":nearby_position_ms,"nearby_trim_rejected":true,
            "nearby_trim_rejection":nearby_error.to_string(),
            "same_size_final_segment_mutation_rejected":true,
            "changed_segment_rejection":changed_error.to_string()
        }))?;
        drop(validated);
        Ok::<Value, anyhow::Error>(positive)
    }.await;

    // Drain and remove through the SAME original owner on both success/error.
    // A timeout or dropped future cannot substitute for this opaque receipt.
    let disposal = tokio::time::timeout(Duration::from_secs(10), output.close_and_dispose())
        .await
        .context("fixture_output_disposal_waiter_deadline")??;
    disposal.require_original_permit(&original_permit)?;
    ensure!(
        !output_path.exists() && disposal.directory_inode() > 0,
        "fixture_output_still_present"
    );
    record(
        "output-disposal.json",
        &json!({
            "process_disposition":format!("{:?}", disposal.process_disposition()),
            "directory_device":disposal.directory_device(),"directory_inode":disposal.directory_inode(),
            "exact_owned_output_removed":true,"original_permit_required":true,
            "fixture_current_checks":permit.checks.load(Ordering::SeqCst),
            "fixture_write_checks":permit.write_checks.load(Ordering::SeqCst)
        }),
    )?;
    if result.is_ok() {
        ensure!(
            disposal.process_disposition() == ProcessDisposition::Reaped,
            "fixture_output_encoder_not_reaped"
        );
    }
    result
}

#[tokio::test]
#[ignore = "bounded file-only native candidate; requires RAINSYNC_CHILD_CANDIDATE_REPORT_DIR and local FFmpeg"]
async fn original_capture_owned_encoding_and_complete_output_validation() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.record(
        "report.json",
        &json!({"status":"running",
        "scope":"inactive core candidate native fixture","production_eligibility_proven":false}),
    )?;
    if let Err(error) = fixture.generate_source().await {
        fixture.record(
            "report.json",
            &json!({"status":"failed","error":error.to_string(),
            "stage":"bounded synthetic source generation","production_eligibility_proven":false}),
        )?;
        return Err(error);
    }
    let transport = Arc::new(FixtureTransport::from_directory(
        &fixture.root.join("source"),
    )?);
    let capture_id = uuid::Uuid::new_v4().to_string();
    let permit = Arc::new(FixtureCapturePermit {
        identity: CaptureOwnerIdentity {
            relative_key: format!("static-hls/{capture_id}"),
            capture_id,
            owner_id: uuid::Uuid::new_v4().to_string(),
        },
        checks: AtomicUsize::new(0),
        disposal: Mutex::new(None),
    });
    let handle = static_hls::start_capture(
        permit.clone(),
        transport.clone(),
        CaptureOptions {
            cache_root: fixture.root.join("capture"),
            manifest_url: SOURCE_URL.to_owned(),
            selected_audio: Some(1),
            expected_inventory: None,
        },
    )?;
    let control = handle.control()?;
    let capture = match handle.wait().await {
        Ok(capture) => capture,
        Err(error) => {
            control.cancel();
            fixture.record(
                "report.json",
                &json!({"status":"failed","error":error.to_string(),
                "stage":"original capture scanner","production_eligibility_proven":false}),
            )?;
            return Err(error);
        }
    };
    // Retained source facts and decoder provenance are the ORIGINAL real
    // scanner's immutable observations. Nothing below constructs them from JSON.
    fixture.record(
        "source-capture-evidence.json",
        &serde_json::to_value(capture.evidence())?,
    )?;
    // Invalid scalars and the source-end boundary must return before any
    // manifest read, input revalidation, output creation or process admission.
    let checks_before = permit.checks.load(Ordering::SeqCst);
    let requests_before = transport.conditional_requests.lock().unwrap().len();
    for position_ms in [
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        -0.001,
        SOURCE_SECONDS as f64 * 1000.0,
        SOURCE_SECONDS as f64 * 1000.0 + 0.5,
        9_007_199_254_740_992.0,
    ] {
        let error = CandidateChildRecipe::from_capture(&capture, position_ms)
            .await
            .err()
            .context("fixture_invalid_position_accepted")?;
        ensure!(
            error.to_string() == "static_hls_child_position",
            "fixture_invalid_position_rejection:{error}"
        );
    }
    ensure!(
        permit.checks.load(Ordering::SeqCst) == checks_before
            && transport.conditional_requests.lock().unwrap().len() == requests_before
            && std::fs::read_dir(fixture.root.join("output"))?
                .next()
                .is_none(),
        "fixture_invalid_position_performed_io"
    );
    fixture.record("position-refusals.json", &json!({
        "nonfinite_rejected":true,"negative_rejected":true,"source_end_and_past_end_rejected":true,
        "unsafe_scalar_rejected":true,"refused_before_manifest_or_encoder_io":true,
        "original_permit_checks_unchanged":true,"conditional_requests_unchanged":true,
        "no_output_created":true
    }))?;

    // Keep the complete native chain off libtest's small default thread stack.
    // This pins the operation itself without changing a production limit or
    // disguising recursive work with a larger RUST_MIN_STACK setting.
    let result = async {
        for (position_ms, report_prefix) in
            [(POSITION_MS, ""), (FRACTIONAL_POSITION_MS, "fractional")]
        {
            let child = Box::pin(run_child(&fixture, &capture, position_ms, report_prefix));
            let layout_report = if report_prefix.is_empty() {
                "child-future-layout.json".to_owned()
            } else {
                format!("{report_prefix}-child-future-layout.json")
            };
            fixture.record(
                &layout_report,
                &json!({
                    "unboxed_bytes":std::mem::size_of_val(child.as_ref().get_ref()),
                    "fixture_operation_heap_pinned":true,"test_thread_stack_size_changed":false
                }),
            )?;
            child.await?;
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    let capture_path = fixture
        .root
        .join("capture")
        .join(&permit.identity.relative_key);
    capture.dispose().await?;
    ensure!(!capture_path.exists(), "fixture_capture_still_present");
    let actual_proof = permit
        .disposal
        .lock()
        .unwrap()
        .clone()
        .context("fixture_capture_proof_missing")?;
    ensure!(
        actual_proof.all_positive() && actual_proof.process_reaped(),
        "fixture_capture_drain_unconfirmed"
    );
    let requests = transport.conditional_requests.lock().unwrap().clone();
    if result.is_ok() {
        ensure!(
            transport
                .resources
                .keys()
                .all(|target| requests.contains(target)),
            "fixture_incomplete_input_revalidation"
        );
    }
    fixture.record("capture-disposal.json", &json!({
        "process_reaped":actual_proof.process_reaped(),"streams_closed":actual_proof.streams_closed(),
        "files_removed":actual_proof.files_removed(),"exact_owned_input_removed":true,
        "fixture_permit_checks":permit.checks.load(Ordering::SeqCst),
        "conditional_revalidation_requests":requests
    }))?;
    fixture.record("report.json", &json!({
        "status":if result.is_ok() {"passed"} else {"failed"},
        "error":result.as_ref().err().map(ToString::to_string),
        "scope":"inactive original-owner core candidate native fixture",
        "production_eligibility_proven":false,"database_concurrency_proven":false,
        "public_playback_grant_created":false,
        "original_capture_scanned":true,"original_input_removed_after_drain":true,
        "requested_positions_ms":[POSITION_MS,FRACTIONAL_POSITION_MS],
        "child_cases":[{"position_ms":POSITION_MS,"report_prefix":""},
            {"position_ms":FRACTIONAL_POSITION_MS,"report_prefix":"fractional-"}],
        "reports":["source-command-registered.json","source-command-completed.json",
            "source-capture-evidence.json","position-refusals.json",
            "child-command-registered.json","child-command-completed.json",
            "validated-child.json","negative-controls.json","output-disposal.json",
            "fractional-child-command-registered.json","fractional-child-command-completed.json",
            "fractional-validated-child.json","fractional-negative-controls.json","fractional-output-disposal.json",
            "capture-disposal.json"]
    }))?;
    result
}
