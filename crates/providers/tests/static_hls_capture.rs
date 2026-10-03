//! Actual HTTP + FFmpeg Stage A fixture, with explicitly isolated owner permits.
//! This test does NOT claim database admission, restart recovery or public use.
#![cfg(target_os = "linux")]
use media_core::static_hls::*;
use providers::{SourceConfig, static_hls::RegisteredSource};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::watch,
};

static NEXT: AtomicUsize = AtomicUsize::new(1);
struct IsolatedPermit {
    identity: CaptureOwnerIdentity,
    revoked: AtomicBool,
    refuse_ack: AtomicBool,
    hang_ack: AtomicBool,
    ack_calls: AtomicUsize,
    receipts: Mutex<Vec<ProcessDisposition>>,
}
impl IsolatedPermit {
    fn new() -> Arc<Self> {
        let capture_id = format!(
            "00000000-0000-4000-8000-{:012x}",
            NEXT.fetch_add(1, Ordering::SeqCst)
        );
        Arc::new(Self {
            identity: CaptureOwnerIdentity {
                relative_key: format!("static-hls/{capture_id}"),
                capture_id,
                owner_id: "00000000-0000-4000-8000-000000000000".into(),
            },
            revoked: AtomicBool::new(false),
            refuse_ack: AtomicBool::new(false),
            hang_ack: AtomicBool::new(false),
            ack_calls: AtomicUsize::new(0),
            receipts: Mutex::new(vec![]),
        })
    }
}
impl CapturePermit for IsolatedPermit {
    fn identity(&self) -> CaptureOwnerIdentity {
        self.identity.clone()
    }
    fn check(&self) -> CaptureFuture<'_, ()> {
        Box::pin(async {
            anyhow::ensure!(
                !self.revoked.load(Ordering::SeqCst),
                "isolated_epoch_revoked"
            );
            Ok(())
        })
    }
    fn acknowledge_disposal(&self, proof: DisposalProof) -> CaptureFuture<'_, ()> {
        Box::pin(async move {
            self.ack_calls.fetch_add(1, Ordering::SeqCst);
            anyhow::ensure!(
                proof.all_positive() && proof.identity() == &self.identity,
                "isolated_incomplete_cleanup"
            );
            if self.hang_ack.load(Ordering::SeqCst) {
                return std::future::pending::<anyhow::Result<()>>().await;
            }
            anyhow::ensure!(
                !self.refuse_ack.load(Ordering::SeqCst),
                "isolated_unknown_ack"
            );
            self.receipts
                .lock()
                .unwrap()
                .push(proof.process_disposition());
            Ok(())
        })
    }
}
#[derive(Clone)]
struct Reply {
    status: u16,
    bytes: Vec<u8>,
    etag: Option<String>,
    length: Option<usize>,
    stall: bool,
    location: Option<String>,
}
impl Reply {
    fn bytes(bytes: Vec<u8>) -> Self {
        Self {
            status: 200,
            bytes,
            etag: Some("\"same-validator\"".into()),
            length: None,
            stall: false,
            location: None,
        }
    }
}
struct Origin {
    url: String,
    replies: Arc<Mutex<HashMap<String, Reply>>>,
    requests: Arc<Mutex<Vec<String>>>,
    stop: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl Origin {
    async fn start(replies: HashMap<String, Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let replies = Arc::new(Mutex::new(replies));
        let requests = Arc::new(Mutex::new(vec![]));
        let (stop, mut canceled) = watch::channel(false);
        let state = replies.clone();
        let observations = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let stream = tokio::select! { _ = canceled.changed() => break, accepted=listener.accept()=>accepted.unwrap().0 };
                let mut stream = stream;
                let mut request = Vec::new();
                loop {
                    let mut bytes = [0u8; 1024];
                    let count = tokio::select! { _ = canceled.changed() => return, read=stream.read(&mut bytes)=>read.unwrap_or(0) };
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&bytes[..count]);
                    if request.windows(4).any(|v| v == b"\r\n\r\n") || request.len() > 16384 {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&request).into_owned();
                let target = request
                    .lines()
                    .next()
                    .and_then(|v| v.split_whitespace().nth(1))
                    .unwrap_or("")
                    .split('?')
                    .next()
                    .unwrap_or("")
                    .to_owned();
                observations.lock().unwrap().push(request);
                let reply = state
                    .lock()
                    .unwrap()
                    .get(&target)
                    .cloned()
                    .unwrap_or(Reply {
                        status: 404,
                        ..Reply::bytes(vec![])
                    });
                let mut head = format!(
                    "HTTP/1.1 {} Fixture\r\nConnection: close\r\nContent-Length: {}\r\n",
                    reply.status,
                    reply.length.unwrap_or(reply.bytes.len())
                );
                if let Some(tag) = reply.etag {
                    head.push_str(&format!("ETag: {tag}\r\n"));
                }
                if let Some(location) = reply.location {
                    head.push_str(&format!("Location: {location}\r\n"));
                }
                head.push_str("\r\n");
                if stream.write_all(head.as_bytes()).await.is_err() {
                    continue;
                }
                if reply.stall {
                    let _ = stream
                        .write_all(&reply.bytes[..reply.bytes.len().min(16)])
                        .await;
                    // Observe real client disconnect and bounded fixture shutdown.
                    let mut byte = [0u8; 1];
                    tokio::select! { _=canceled.changed()=>return, _=stream.read(&mut byte)=>() };
                } else {
                    for chunk in reply.bytes.chunks(16384) {
                        if stream.write_all(chunk).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Self {
            url,
            replies,
            requests,
            stop,
            task: Some(task),
        }
    }
    async fn close(mut self) {
        self.stop.send_replace(true);
        self.task.take().unwrap().await.unwrap();
    }
}
impl Drop for Origin {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn fixture(root: &Path, audio: bool, fps: u32) -> HashMap<String, Reply> {
    fixture_shape(root, audio, fps, "128x72", 2).await
}
async fn fixture_shape(
    root: &Path,
    audio: bool,
    fps: u32,
    geometry: &str,
    seconds: u32,
) -> HashMap<String, Reply> {
    let source = root.join(format!("source-{audio}-{fps}"));
    std::fs::create_dir(&source).unwrap();
    let output = source.join("index.m3u8");
    let mut args = vec![
        "-v".into(),
        "error".into(),
        "-nostdin".into(),
        "-y".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!("testsrc2=size={geometry}:rate={fps}:duration={seconds}"),
    ];
    if audio {
        args.extend(
            [
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=2",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:a",
                "aac",
                "-ar",
                "48000",
                "-ac",
                "1",
            ]
            .map(str::to_owned),
        );
    } else {
        args.push("-an".into());
    }
    args.extend(
        [
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", "-bf", "0", "-g",
        ]
        .map(str::to_owned),
    );
    args.push(fps.to_string());
    args.extend(
        [
            "-sc_threshold",
            "0",
            "-avoid_negative_ts",
            "disabled",
            "-f",
            "hls",
            "-hls_time",
            "1",
            "-hls_segment_type",
            "fmp4",
            "-hls_playlist_type",
            "vod",
        ]
        .map(str::to_owned),
    );
    args.push(output.to_string_lossy().into_owned());
    let mut command = tokio::process::Command::new("/usr/bin/ffmpeg");
    command.args(&args);
    let (status, _) = media_core::child_process::capture(command, Duration::from_secs(10), 65536)
        .await
        .unwrap();
    assert!(status.success());
    std::fs::write(
        source.join("generation-argv.json"),
        serde_json::to_vec(&args).unwrap(),
    )
    .unwrap();
    std::fs::read_dir(&source)
        .unwrap()
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_str().unwrap();
            if name.ends_with(".json") {
                None
            } else {
                Some((
                    format!("/{name}"),
                    Reply::bytes(std::fs::read(path).unwrap()),
                ))
            }
        })
        .collect()
}
fn root() -> PathBuf {
    let runtime = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = runtime.join(format!(
        "native-static-hls-{}-{nonce}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir(&path).unwrap();
    path
}

fn config(primary: &Origin, cdn: &Origin) -> SourceConfig {
    serde_json::from_value(serde_json::json!({"url":primary.url,"headers":{"x-source-secret":"private-fixture"},"access_policy":{"schema_version":1,"origins":[
        {"origin":primary.url,"cidrs":["127.0.0.0/8"]},{"origin":cdn.url,"cidrs":["127.0.0.0/8"]}],"redirects":{"max_hops":2}}})).unwrap()
}
fn options(
    root: &Path,
    origin: &Origin,
    expected: Option<Vec<ResourceIdentity>>,
) -> CaptureOptions {
    CaptureOptions {
        cache_root: root.to_owned(),
        manifest_url: format!("{}/start?signature=private-fixture", origin.url),
        selected_audio: None,
        expected_inventory: expected,
    }
}
async fn capture(
    root: &Path,
    primary: &Origin,
    cdn: &Origin,
    expected: Option<Vec<ResourceIdentity>>,
) -> (Arc<IsolatedPermit>, anyhow::Result<VerifiedCapture>) {
    let permit = IsolatedPermit::new();
    let config = config(primary, cdn);
    let source = Arc::new(RegisteredSource::new(
        config.clone(),
        config.headers.clone(),
    ));
    let case = root.join(format!("attempt-{}", permit.identity.capture_id));
    std::fs::create_dir(&case).unwrap();
    let replies = cdn.replies.lock().unwrap().clone();
    let mut wire = Vec::new();
    for (name, response) in replies {
        let safe = name.trim_start_matches('/');
        assert!(!safe.contains('/') && !safe.contains(".."));
        std::fs::write(case.join(safe), &response.bytes).unwrap();
        wire.push(serde_json::json!({"resource": safe, "status": response.status,
            "etag": response.etag, "advertised_bytes": response.length.unwrap_or(response.bytes.len()),
            "actual_body_bytes": response.bytes.len(), "stalled_after": if response.stall {Some(16)}else{None},
            "location": response.location}));
    }
    std::fs::write(
        case.join("wire-representations.json"),
        serde_json::to_vec_pretty(&wire).unwrap(),
    )
    .unwrap();
    let result = start_capture(permit.clone(), source, options(root, primary, expected))
        .unwrap()
        .wait()
        .await;
    let verdict = match &result {
        Ok(captured) => {
            serde_json::json!({"scope":"isolated-owner-fixture-only","database_admission_proved":false,
            "accepted":false,"production_fallback_enabled":false,"result":"verified", "evidence":captured.evidence})
        }
        Err(error) => {
            serde_json::json!({"scope":"isolated-owner-fixture-only","database_admission_proved":false,
            "accepted":false,"production_fallback_enabled":false,"result":"refused","reason":error.to_string(),
            "process_dispositions":format!("{:?}",permit.receipts.lock().unwrap())})
        }
    };
    std::fs::write(
        case.join("result.json"),
        serde_json::to_vec_pretty(&verdict).unwrap(),
    )
    .unwrap();
    (permit, result)
}
async fn origins(replies: HashMap<String, Reply>) -> (Origin, Origin) {
    let cdn = Origin::start(replies).await;
    let primary = Origin::start(HashMap::from([(
        "/start".into(),
        Reply {
            status: 302,
            location: Some(format!(
                "{}/index.m3u8?order=1&signature=private-fixture",
                cdn.url
            )),
            ..Reply::bytes(vec![])
        },
    )]))
    .await;
    (primary, cdn)
}

#[tokio::test]
async fn actual_sealed_scan_and_complete_full_body_demand_revalidation() {
    let root = root();
    let (primary, cdn) = origins(fixture(&root, true, 25).await).await;
    let (permit, result) = capture(&root, &primary, &cdn, None).await;
    let captured = result.unwrap();
    assert_eq!(captured.evidence.inventory.len(), 4);
    assert!(captured.evidence.decoder.process_tree_reaped);
    assert_eq!(captured.evidence.timeline.source_origin_ms, 0);
    assert_eq!(captured.evidence.timeline.duration_ms, 2000.0);
    assert!(
        permit.receipts.lock().unwrap().is_empty(),
        "retained snapshot keeps admission/storage slot"
    );
    let serialized = serde_json::to_string_pretty(&captured.evidence).unwrap();
    assert!(!serialized.contains("private-fixture"));
    std::fs::write(root.join("positive-evidence.json"), &serialized).unwrap();
    let inventory = captured.evidence.inventory.clone();
    captured.dispose().await.unwrap();
    assert_eq!(
        *permit.receipts.lock().unwrap(),
        vec![ProcessDisposition::Reaped]
    );
    assert!(!root.join(&permit.identity.relative_key).exists());
    assert!(primary.requests.lock().unwrap().iter().all(|v| {
        v.to_ascii_lowercase()
            .contains("x-source-secret: private-fixture")
    }));
    assert!(
        cdn.requests
            .lock()
            .unwrap()
            .iter()
            .all(|v| !v.contains("x-source-secret")
                && !v.to_ascii_lowercase().contains("if-match")
                && !v.to_ascii_lowercase().contains("if-none-match"))
    );
    let (_, same) = capture(&root, &primary, &cdn, Some(inventory.clone())).await;
    same.unwrap().dispose().await.unwrap();
    // The final, previously unread future resource changes with the same ETag.
    let original = cdn
        .replies
        .lock()
        .unwrap()
        .get("/index1.m4s")
        .unwrap()
        .clone();
    {
        let mut replies = cdn.replies.lock().unwrap();
        if let Some(byte) = replies.get_mut("/index1.m4s").unwrap().bytes.last_mut() {
            *byte ^= 1;
        }
    }
    let (changed, result) = capture(&root, &primary, &cdn, Some(inventory.clone())).await;
    assert!(result.err().unwrap().to_string().contains("source_changed"));
    assert_eq!(
        *changed.receipts.lock().unwrap(),
        vec![ProcessDisposition::NeverStarted]
    );
    cdn.replies
        .lock()
        .unwrap()
        .insert("/index1.m4s".into(), original);
    // Redirect final query order/identity is part of the representation.
    primary
        .replies
        .lock()
        .unwrap()
        .get_mut("/start")
        .unwrap()
        .location = Some(format!(
        "{}/index.m3u8?signature=private-fixture&order=1",
        cdn.url
    ));
    let (_, changed) = capture(&root, &primary, &cdn, Some(inventory)).await;
    assert!(
        changed
            .err()
            .unwrap()
            .to_string()
            .contains("source_changed")
    );
    primary.close().await;
    cdn.close().await;
}

#[tokio::test]
async fn weak_missing_304_truncated_oversize_and_changed_init_fail_closed() {
    let root = root();
    let (primary, cdn) = origins(fixture(&root, false, 30).await).await;
    let (_, baseline) = capture(&root, &primary, &cdn, None).await;
    let baseline = baseline.unwrap();
    let inventory = baseline.evidence.inventory.clone();
    baseline.dispose().await.unwrap();
    let saved = cdn
        .replies
        .lock()
        .unwrap()
        .get("/init.mp4")
        .unwrap()
        .clone();
    for mode in ["weak", "missing", "304", "truncated", "oversize", "changed"] {
        let mut reply = saved.clone();
        match mode {
            "weak" => reply.etag = Some("W/\"same-validator\"".into()),
            "missing" => reply.etag = None,
            "304" => reply.status = 304,
            "truncated" => reply.length = Some(reply.bytes.len() + 1),
            "oversize" => reply.length = Some(INIT_BYTES + 1),
            "changed" => reply.bytes[0] ^= 1,
            _ => unreachable!(),
        }
        cdn.replies
            .lock()
            .unwrap()
            .insert("/init.mp4".into(), reply);
        let (permit, result) = capture(&root, &primary, &cdn, Some(inventory.clone())).await;
        assert!(result.is_err(), "{mode}");
        assert_eq!(
            *permit.receipts.lock().unwrap(),
            vec![ProcessDisposition::NeverStarted]
        );
        assert!(!root.join(&permit.identity.relative_key).exists());
    }
    primary.close().await;
    cdn.close().await;
}

#[tokio::test]
async fn stalled_body_epoch_cancellation_and_dropped_waiter_drain_before_receipt() {
    let root = root();
    let (primary, cdn) = origins(fixture(&root, false, 25).await).await;
    cdn.replies
        .lock()
        .unwrap()
        .get_mut("/init.mp4")
        .unwrap()
        .stall = true;
    for mode in ["epoch", "drop"] {
        let before = cdn.requests.lock().unwrap().len();
        let permit = IsolatedPermit::new();
        let config = config(&primary, &cdn);
        let handle = start_capture(
            permit.clone(),
            Arc::new(RegisteredSource::new(
                config.clone(),
                config.headers.clone(),
            )),
            options(&root, &primary, None),
        )
        .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while cdn.requests.lock().unwrap().len() < before + 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        if mode == "epoch" {
            permit.revoked.store(true, Ordering::SeqCst);
            assert!(handle.wait().await.is_err());
        } else {
            drop(handle);
        }
        tokio::time::timeout(Duration::from_secs(3), async {
            while permit.receipts.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            *permit.receipts.lock().unwrap(),
            vec![ProcessDisposition::NeverStarted]
        );
        assert!(!root.join(&permit.identity.relative_key).exists());
    }
    primary.close().await;
    cdn.close().await;
}

#[tokio::test]
async fn denied_redirect_and_unknown_manifest_tag_do_not_start_a_decoder() {
    let root = root();
    let (primary, cdn) = origins(fixture(&root, false, 25).await).await;
    let mut denied = config(&primary, &cdn);
    denied.access_policy.as_mut().unwrap().origins.truncate(1);
    let permit = IsolatedPermit::new();
    let result = start_capture(
        permit.clone(),
        Arc::new(RegisteredSource::new(
            denied.clone(),
            denied.headers.clone(),
        )),
        options(&root, &primary, None),
    )
    .unwrap()
    .wait()
    .await;
    assert!(result.is_err());
    assert!(cdn.requests.lock().unwrap().is_empty());
    assert_eq!(
        *permit.receipts.lock().unwrap(),
        vec![ProcessDisposition::NeverStarted]
    );
    {
        let mut replies = cdn.replies.lock().unwrap();
        let manifest = replies.get_mut("/index.m3u8").unwrap();
        let text = String::from_utf8(manifest.bytes.clone())
            .unwrap()
            .replace("#EXT-X-ENDLIST", "#EXT-X-DISCONTINUITY\n#EXT-X-ENDLIST");
        manifest.bytes = text.into_bytes();
    }
    let (permit, result) = capture(&root, &primary, &cdn, None).await;
    assert!(result.is_err());
    assert_eq!(
        *permit.receipts.lock().unwrap(),
        vec![ProcessDisposition::NeverStarted]
    );
    primary.close().await;
    cdn.close().await;
}

#[tokio::test]
async fn cleanup_failure_keeps_unresolved_ownership_and_never_deletes_an_unknown_entry() {
    use std::os::unix::fs::PermissionsExt;
    let root = root();
    let (primary, cdn) = origins(fixture(&root, false, 25).await).await;
    let (permit, captured) = capture(&root, &primary, &cdn, None).await;
    let captured = captured.unwrap();
    let directory = root.join(&permit.identity.relative_key);
    // Deliberately violate the no-malicious-same-UID-writer assumption in this
    // isolated fixture to prove cleanup cannot invent ownership of extra data.
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(directory.join("not-owned"), b"do not delete me").unwrap();
    assert!(captured.dispose().await.is_err());
    assert!(permit.receipts.lock().unwrap().is_empty());
    assert!(directory.join("not-owned").exists());
    assert!(directory.join("owner").exists());
    primary.close().await;
    cdn.close().await;
}

#[tokio::test]
async fn actual_active_ffprobe_epoch_revocation_reaps_before_positive_disposal() {
    let root = root();
    let (primary, cdn) = origins(fixture_shape(&root, false, 25, "1920x1080", 5).await).await;
    assert_eq!(
        media_core::child_process::owner_snapshot()
            .unwrap()
            .active_owners,
        0
    );
    let permit = IsolatedPermit::new();
    let config = config(&primary, &cdn);
    let handle = start_capture(
        permit.clone(),
        Arc::new(RegisteredSource::new(
            config.clone(),
            config.headers.clone(),
        )),
        options(&root, &primary, None),
    )
    .unwrap();
    let mut waiting = tokio::spawn(handle.wait());
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if media_core::child_process::owner_snapshot()
                .unwrap()
                .active_owners
                > 0
            {
                break;
            }
            tokio::select! {
                returned = &mut waiting => {
                    match returned.unwrap() {
                        Ok(_) => panic!("capture completed before active decoder observation"),
                        Err(error) => panic!("capture refused before decoder: {error}"),
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(1)) => (),
            }
        }
    })
    .await
    .unwrap();
    permit.revoked.store(true, Ordering::SeqCst);
    assert!(waiting.await.unwrap().is_err());
    assert_eq!(
        *permit.receipts.lock().unwrap(),
        vec![ProcessDisposition::Reaped]
    );
    assert_eq!(
        media_core::child_process::owner_snapshot()
            .unwrap()
            .active_owners,
        0
    );
    assert!(!root.join(&permit.identity.relative_key).exists());
    std::fs::write(root.join("active-decoder-cancellation.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "scope":"isolated-owner-fixture-only","accepted":false,"production_fallback_enabled":false,
        "observed_active_decoder":true,"process_disposition":"reaped","files_removed":true,"owner_receipts":1
    })).unwrap()).unwrap();
    primary.close().await;
    cdn.close().await;
}

#[tokio::test]
async fn unknown_acknowledgment_keeps_unresolved_state_after_files_are_removed() {
    let root = root();
    let (primary, cdn) = origins(fixture(&root, false, 25).await).await;
    let (permit, captured) = capture(&root, &primary, &cdn, None).await;
    let captured = captured.unwrap();
    permit.refuse_ack.store(true, Ordering::SeqCst);
    assert!(captured.dispose().await.is_err());
    assert_eq!(permit.ack_calls.load(Ordering::SeqCst), 1);
    assert!(permit.receipts.lock().unwrap().is_empty());
    assert!(!root.join(&permit.identity.relative_key).exists());
    std::fs::write(root.join("unknown-acknowledgment.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "scope":"isolated-owner-fixture-only","accepted":false,"production_fallback_enabled":false,
        "disposal_state":"unresolved","files_removed":true,"acknowledgment_attempts":1,"positive_acknowledgments":0
    })).unwrap()).unwrap();
    primary.close().await;
    cdn.close().await;
}

#[tokio::test]
async fn never_resolving_disposal_ack_has_one_bounded_attempt_and_stays_unresolved() {
    let root = root();
    let (primary, cdn) = origins(fixture(&root, false, 25).await).await;
    let (permit, captured) = capture(&root, &primary, &cdn, None).await;
    let captured = captured.unwrap();
    permit.hang_ack.store(true, Ordering::SeqCst);
    let began = tokio::time::Instant::now();
    let result = tokio::time::timeout(
        DISPOSAL_ACK_TIMEOUT + Duration::from_secs(2),
        captured.dispose(),
    )
    .await
    .unwrap();
    assert!(result.is_err());
    assert!(began.elapsed() >= DISPOSAL_ACK_TIMEOUT);
    assert_eq!(permit.ack_calls.load(Ordering::SeqCst), 1);
    assert!(permit.receipts.lock().unwrap().is_empty());
    assert!(!root.join(&permit.identity.relative_key).exists());
    std::fs::write(root.join("never-resolving-acknowledgment.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "scope":"isolated-owner-fixture-only","accepted":false,"production_fallback_enabled":false,
        "disposal_state":"unresolved","files_removed":true,"acknowledgment_attempts":1,"positive_acknowledgments":0,
        "ack_deadline_ms":DISPOSAL_ACK_TIMEOUT.as_millis(),"elapsed_ms":began.elapsed().as_millis()
    })).unwrap()).unwrap();
    primary.close().await;
    cdn.close().await;
}
