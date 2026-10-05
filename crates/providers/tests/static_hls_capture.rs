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
    proofs: Mutex<Vec<Arc<DisposalProof>>>,
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
            proofs: Mutex::new(vec![]),
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
    fn acknowledge_disposal(&self, proof: Arc<DisposalProof>) -> CaptureFuture<'_, ()> {
        Box::pin(async move {
            self.ack_calls.fetch_add(1, Ordering::SeqCst);
            anyhow::ensure!(
                proof.all_positive() && proof.identity() == &self.identity,
                "isolated_incomplete_cleanup"
            );
            self.proofs.lock().unwrap().push(proof.clone());
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
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-threads",
            "1",
            "-bf",
            "0",
            "-g",
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
    let mut command = tokio::process::Command::new("ffmpeg");
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
    let runtime = std::env::var_os("RAINSYNC_HLS_CAPTURE_ARTIFACT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.runtime"));
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
            "accepted":false,"production_fallback_enabled":false,"result":"verified", "evidence":captured.evidence()})
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
    assert_eq!(captured.evidence().inventory.len(), 4);
    assert!(captured.evidence().decoder.process_tree_reaped);
    assert_eq!(captured.evidence().timeline.source_origin_ms, 0);
    assert_eq!(captured.evidence().timeline.duration_ms, 2000.0);
    assert!(
        permit.receipts.lock().unwrap().is_empty(),
        "retained snapshot keeps admission/storage slot"
    );
    let serialized = serde_json::to_string_pretty(captured.evidence()).unwrap();
    assert!(!serialized.contains("private-fixture"));
    std::fs::write(root.join("positive-evidence.json"), &serialized).unwrap();
    // Exercise the consuming closed graph contract with the real scanner
    // inventory/timeline, not a second synthetic scan. Input authority is a
    // fixture hash only; this does not claim a production pending request.
    let measured: serde_json::Value = serde_json::from_str(&serialized).unwrap();
    let statement = serde_json::json!({
        "graph_version":1, "parent_input_sha256":"b".repeat(64),
        "inventory":measured["inventory"], "closure":measured["closure"],
        "timeline":measured["timeline"]
    });
    media_core::static_hls::contracts::graph::RootGraphStatement::parse_private_plaintext(
        &serde_json::to_vec(&statement).unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.join("measured-root-statement.json"),
        serde_json::to_vec_pretty(&statement).unwrap(),
    )
    .unwrap();
    let inventory = captured.evidence().inventory.clone();
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
async fn parent_read_get_head_range_and_unpolled_cancel_hold_original_owner() {
    let root = root();
    let (primary, cdn) = origins(fixture(&root, true, 25).await).await;
    let (permit, captured) = capture(&root, &primary, &cdn, None).await;
    let captured = captured.unwrap();
    let mut manifest = captured
        .read(ReadResource::Manifest, ReadMethod::Get, None)
        .await
        .unwrap();
    let mut text = Vec::new();
    while let Some(chunk) = manifest.chunk().await.unwrap() {
        text.extend(chunk);
    }
    let text = String::from_utf8(text).unwrap();
    assert!(
        text.contains("init.mp4") && text.contains("s000.m4s") && !text.contains("private-fixture")
    );
    drop(manifest);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let mut head = captured
        .read(ReadResource::Init, ReadMethod::Head, None)
        .await
        .unwrap();
    assert_eq!(
        head.content_length(),
        cdn.replies.lock().unwrap()["/init.mp4"].bytes.len()
    );
    assert!(head.chunk().await.unwrap().is_none());
    drop(head);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let original = cdn.replies.lock().unwrap()["/index0.m4s"].bytes.clone();
    let mut range = captured
        .read(
            ReadResource::Segment(0),
            ReadMethod::Get,
            Some(ReadRange::Inclusive { first: 0, last: 31 }),
        )
        .await
        .unwrap();
    assert!(range.is_partial());
    assert_eq!(range.content_length(), 32);
    assert_eq!(range.chunk().await.unwrap().unwrap(), original[..32]);
    assert!(range.chunk().await.unwrap().is_none());
    drop(range);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let mut suffix = captured
        .read(
            ReadResource::Segment(0),
            ReadMethod::Get,
            Some(ReadRange::Suffix(17)),
        )
        .await
        .unwrap();
    assert_eq!(
        suffix.chunk().await.unwrap().unwrap(),
        original[original.len() - 17..]
    );
    drop(suffix);
    tokio::time::sleep(Duration::from_millis(20)).await;
    // Conditional GET can yield 304 only because the original sealed bytes
    // remain available; the empty response is never used as a body digest.
    let previous = cdn.replies.lock().unwrap()["/index0.m4s"].clone();
    let mut not_modified = previous.clone();
    not_modified.status = 304;
    not_modified.bytes.clear();
    not_modified.length = Some(0);
    cdn.replies
        .lock()
        .unwrap()
        .insert("/index0.m4s".into(), not_modified);
    let mut lease = captured
        .read(
            ReadResource::Segment(0),
            ReadMethod::Get,
            Some(ReadRange::Inclusive { first: 0, last: 7 }),
        )
        .await
        .unwrap();
    assert_eq!(lease.chunk().await.unwrap().unwrap(), original[..8]);
    drop(lease);
    cdn.replies
        .lock()
        .unwrap()
        .insert("/index0.m4s".into(), previous);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let first = captured
        .read(ReadResource::Init, ReadMethod::Get, None)
        .await
        .unwrap();
    let mut second = captured
        .read(ReadResource::Segment(0), ReadMethod::Get, None)
        .await
        .unwrap();
    let before = primary.requests.lock().unwrap().len() + cdn.requests.lock().unwrap().len();
    assert!(
        captured
            .read(ReadResource::Manifest, ReadMethod::Get, None)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("static_hls_read_busy")
    );
    assert_eq!(
        before,
        primary.requests.lock().unwrap().len() + cdn.requests.lock().unwrap().len()
    );
    assert!(permit.receipts.lock().unwrap().is_empty());
    assert!(root.join(&permit.identity.relative_key).exists());
    // Both returned bodies stay unpolled. Cancellation must close them through
    // their original supervisors rather than wait for another downstream poll.
    captured.control().unwrap().cancel();
    captured.dispose().await.unwrap();
    assert!(second.chunk().await.is_err());
    drop(first);
    drop(second);
    assert_eq!(
        *permit.receipts.lock().unwrap(),
        vec![ProcessDisposition::Reaped]
    );
    assert!(!root.join(&permit.identity.relative_key).exists());
    assert!(
        primary
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|v| !v.to_ascii_lowercase().contains("if-match"))
    );
    assert!(
        cdn.requests
            .lock()
            .unwrap()
            .iter()
            .any(|v| v.to_ascii_lowercase().contains("if-match:"))
    );
    assert!(
        cdn.requests
            .lock()
            .unwrap()
            .iter()
            .all(|v| !v.contains("x-source-secret"))
    );
    std::fs::write(root.join("parent-read-positive.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "scope":"original-isolated-owner-read-lease", "get":true,"head_full_revalidation":true,
        "prefix_range_full_revalidation":true,"suffix_range":true,"retained_304":true,"max_readers":2,
        "unpolled_cancel_disposed":true,"conditional_validator_final_target_only":true,
        "public_hls_activated":false,"database_admission_proved":false
    })).unwrap()).unwrap();
    primary.close().await;
    cdn.close().await;
}

#[tokio::test]
async fn parent_read_tail_mutation_and_stalled_revoke_are_not_partial_proofs() {
    let root = root();
    let (primary, cdn) = origins(fixture(&root, true, 25).await).await;
    let (permit, captured) = capture(&root, &primary, &cdn, None).await;
    let captured = captured.unwrap();
    *cdn.replies
        .lock()
        .unwrap()
        .get_mut("/index0.m4s")
        .unwrap()
        .bytes
        .last_mut()
        .unwrap() ^= 1;
    let changed = captured
        .read(
            ReadResource::Segment(0),
            ReadMethod::Get,
            Some(ReadRange::Inclusive { first: 0, last: 7 }),
        )
        .await
        .err()
        .unwrap();
    assert!(changed.to_string().contains("static_hls_source_changed"));
    captured.dispose().await.unwrap();
    assert_eq!(
        *permit.receipts.lock().unwrap(),
        vec![ProcessDisposition::Reaped]
    );
    primary.close().await;
    cdn.close().await;

    let stalled_root = root.join("stalled-read");
    std::fs::create_dir(&stalled_root).unwrap();
    let (primary, cdn) = origins(fixture(&stalled_root, true, 25).await).await;
    let (permit, captured) = capture(&stalled_root, &primary, &cdn, None).await;
    let captured = Arc::new(captured.unwrap());
    cdn.replies
        .lock()
        .unwrap()
        .get_mut("/index0.m4s")
        .unwrap()
        .stall = true;
    let before = cdn.requests.lock().unwrap().len();
    let read = captured.clone();
    let pending = tokio::spawn(async move {
        read.read(ReadResource::Segment(0), ReadMethod::Head, None)
            .await
    });
    let until = tokio::time::Instant::now() + Duration::from_secs(3);
    while cdn.requests.lock().unwrap().len() == before {
        assert!(tokio::time::Instant::now() < until);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(permit.receipts.lock().unwrap().is_empty());
    permit.revoked.store(true, Ordering::SeqCst);
    assert!(
        tokio::time::timeout(Duration::from_secs(3), pending)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    let owned =
        Arc::try_unwrap(captured).unwrap_or_else(|_| panic!("read waiter retained snapshot"));
    owned.dispose().await.unwrap();
    assert_eq!(
        *permit.receipts.lock().unwrap(),
        vec![ProcessDisposition::Reaped]
    );
    std::fs::write(root.join("parent-read-failure.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "scope":"original-isolated-owner-read-lease", "same_etag_tail_mutation_refused":true,
        "head_waits_complete_upstream_body":true,"revoked_stalled_stream_closed":true,
        "positive_original_disposal":true,"public_hls_activated":false,"database_admission_proved":false
    })).unwrap()).unwrap();
    primary.close().await;
    cdn.close().await;
}

#[tokio::test]
async fn publication_revalidates_complete_graph_and_retains_original_owner_until_revoked() {
    let root = root();
    let (primary, cdn) = origins(fixture(&root, true, 25).await).await;
    let (permit, captured) = capture(&root, &primary, &cdn, None).await;
    let captured = captured.unwrap();
    let before = cdn.requests.lock().unwrap().len();
    let publication = captured.prepare_publication().await.unwrap();
    publication.check().await.unwrap();
    assert_eq!(publication.identity(), permit.identity);
    let count = publication.live_evidence().unwrap().inventory.len();
    assert_eq!(count, captured.evidence().inventory.len());
    let revalidated: Vec<_> = cdn.requests.lock().unwrap()[before..]
        .iter()
        .map(|request| request.lines().next().unwrap().to_owned())
        .collect();
    assert_eq!(revalidated.len(), count);
    assert!(revalidated.iter().all(|line| line.starts_with("GET ")));
    let segment_paths: Vec<_> = cdn
        .replies
        .lock()
        .unwrap()
        .keys()
        .filter(|path| path.ends_with(".m4s"))
        .cloned()
        .collect();
    assert!(
        segment_paths.len() >= 2,
        "fixture must include an unread future segment"
    );
    for path in &segment_paths {
        assert!(revalidated.iter().any(|line| line.contains(path)));
    }
    // A publication witness occupies a real reader slot while the caller
    // prepares its transaction. It is not a detached UUID/digest statement.
    let parked = captured
        .read(ReadResource::Init, ReadMethod::Get, None)
        .await
        .unwrap();
    let before = cdn.requests.lock().unwrap().len();
    assert!(captured.prepare_publication().await.is_err());
    assert_eq!(before, cdn.requests.lock().unwrap().len());
    assert!(permit.receipts.lock().unwrap().is_empty());
    assert!(root.join(&permit.identity.relative_key).exists());
    captured.control().unwrap().cancel();
    captured.dispose().await.unwrap();
    assert!(publication.live_evidence().is_err());
    assert!(publication.check().await.is_err());
    drop(publication);
    drop(parked);
    assert_eq!(
        *permit.receipts.lock().unwrap(),
        vec![ProcessDisposition::Reaped]
    );
    assert!(!root.join(&permit.identity.relative_key).exists());
    primary.close().await;
    cdn.close().await;

    let changed_root = root.join("publication-tail-changed");
    std::fs::create_dir(&changed_root).unwrap();
    let (primary, cdn) = origins(fixture(&changed_root, true, 25).await).await;
    let (permit, captured) = capture(&changed_root, &primary, &cdn, None).await;
    let captured = captured.unwrap();
    let mut segment_paths: Vec<_> = cdn
        .replies
        .lock()
        .unwrap()
        .keys()
        .filter(|path| path.ends_with(".m4s"))
        .cloned()
        .collect();
    segment_paths.sort();
    let changed = segment_paths.last().unwrap();
    *cdn.replies
        .lock()
        .unwrap()
        .get_mut(changed)
        .unwrap()
        .bytes
        .last_mut()
        .unwrap() ^= 1;
    let refused = captured.prepare_publication().await.err().unwrap();
    assert!(refused.to_string().contains("static_hls_source_changed"));
    assert!(captured.live_evidence().is_err());
    captured.dispose().await.unwrap();
    assert_eq!(
        *permit.receipts.lock().unwrap(),
        vec![ProcessDisposition::Reaped]
    );
    primary.close().await;
    cdn.close().await;
    std::fs::write(root.join("publication-full-graph.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "scope":"original-isolated-owner-publication-prerequisite",
        "all_resources_conditional_full_get":true,"unread_future_tail_change_refused":true,
        "witness_holds_original_reader_slot":true,"unpolled_witness_revoked_before_disposal":true,
        "public_hls_activated":false,"atomic_publication_proved":false,"database_admission_proved":false
    })).unwrap()).unwrap();
}

#[tokio::test]
async fn not_modified_with_missing_retained_manifest_revokes_entire_capture() {
    use std::os::unix::fs::PermissionsExt;
    let root = root();
    let (primary, cdn) = origins(fixture(&root, true, 25).await).await;
    let (permit, captured) = capture(&root, &primary, &cdn, None).await;
    let captured = captured.unwrap();
    // The generated local index can still be intact, while the original source
    // manifest used to justify 304 no longer exists. That must revoke the root.
    let directory = root.join(&permit.identity.relative_key);
    let retained = directory.join("source.bin");
    assert!(retained.exists());
    // Production seals this fixture's owned directory to 0500. Temporarily
    // enable only owner-write for this intentional missing-file injection, then
    // restore the original seal before exercising revalidation or disposal.
    let sealed_permissions = std::fs::metadata(&directory).unwrap().permissions();
    assert_eq!(sealed_permissions.mode() & 0o777, 0o500);
    std::fs::set_permissions(
        &directory,
        std::fs::Permissions::from_mode(sealed_permissions.mode() | 0o200),
    )
    .unwrap();
    let removed = std::fs::remove_file(&retained);
    std::fs::set_permissions(&directory, sealed_permissions).unwrap();
    removed.unwrap();
    assert!(!retained.exists());
    {
        let mut replies = cdn.replies.lock().unwrap();
        let manifest = replies.get_mut("/index.m3u8").unwrap();
        manifest.status = 304;
        manifest.bytes.clear();
        manifest.length = Some(0);
    }
    assert!(captured.prepare_publication().await.is_err());
    assert!(captured.live_evidence().is_err());
    captured.dispose().await.unwrap();
    assert_eq!(
        *permit.receipts.lock().unwrap(),
        vec![ProcessDisposition::Reaped]
    );
    assert!(!root.join(&permit.identity.relative_key).exists());
    primary.close().await;
    cdn.close().await;
    std::fs::write(root.join("publication-304-retained-failure.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "scope":"original-isolated-owner-publication-prerequisite",
        "304_missing_retained_source_manifest_refused":true,"capture_revoked":true,
        "positive_original_disposal":true,"atomic_publication_proved":false,"public_hls_activated":false
    })).unwrap()).unwrap();
}

#[tokio::test]
async fn dropped_publication_waiter_keeps_stalled_graph_owned_until_original_cancel() {
    let root = root();
    let (primary, cdn) = origins(fixture(&root, true, 25).await).await;
    let (permit, captured) = capture(&root, &primary, &cdn, None).await;
    let captured = Arc::new(captured.unwrap());
    let last = {
        let mut replies = cdn.replies.lock().unwrap();
        let mut segments: Vec<_> = replies
            .keys()
            .filter(|path| path.ends_with(".m4s"))
            .cloned()
            .collect();
        segments.sort();
        let last = segments.pop().unwrap();
        replies.get_mut(&last).unwrap().stall = true;
        last
    };
    let before = cdn.requests.lock().unwrap().len();
    let waiter = captured.clone();
    let pending = tokio::spawn(async move { waiter.prepare_publication().await });
    let until = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if cdn.requests.lock().unwrap()[before..]
            .iter()
            .any(|request| request.lines().next().unwrap().contains(&last))
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < until,
            "last graph resource was not reached"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        !pending.is_finished(),
        "partial last body minted a publication witness"
    );
    pending.abort();
    assert!(pending.await.err().unwrap().is_cancelled());
    assert!(permit.receipts.lock().unwrap().is_empty());
    assert!(root.join(&permit.identity.relative_key).exists());
    // Dropping the waiter did not discharge its independent graph-read task.
    // The original stop/drain, rather than another downstream poll, closes it.
    captured.control().unwrap().cancel();
    let owned =
        Arc::try_unwrap(captured).unwrap_or_else(|_| panic!("publication waiter retained capture"));
    owned.dispose().await.unwrap();
    assert_eq!(
        *permit.receipts.lock().unwrap(),
        vec![ProcessDisposition::Reaped]
    );
    assert!(!root.join(&permit.identity.relative_key).exists());
    primary.close().await;
    cdn.close().await;
    std::fs::write(root.join("publication-dropped-waiter.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "scope":"original-isolated-owner-publication-prerequisite",
        "partial_last_resource_mints_no_witness":true,"dropped_waiter_does_not_discharge_owner":true,
        "original_cancel_drains_stalled_graph_before_positive_disposal":true,
        "atomic_publication_proved":false,"public_hls_activated":false
    })).unwrap()).unwrap();
}

#[tokio::test]
async fn weak_missing_304_truncated_oversize_and_changed_init_fail_closed() {
    let root = root();
    let (primary, cdn) = origins(fixture(&root, false, 30).await).await;
    let (_, baseline) = capture(&root, &primary, &cdn, None).await;
    let baseline = baseline.unwrap();
    let inventory = baseline.evidence().inventory.clone();
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

#[test]
fn actual_active_ffprobe_epoch_revocation_reaps_before_positive_disposal() {
    // The owner registry is process-global. Keep this lifecycle observation
    // isolated from the other captures running concurrently in this binary.
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "active_ffprobe_epoch_revocation_child",
            "--ignored",
            "--nocapture",
        ])
        .status()
        .unwrap();
    assert!(status.success());
}

#[tokio::test]
#[ignore = "owned subprocess helper for process-global owner observation"]
async fn active_ffprobe_epoch_revocation_child() {
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
    let control = captured.control().unwrap();
    permit.refuse_ack.store(true, Ordering::SeqCst);
    assert!(captured.dispose().await.is_err());
    assert_eq!(permit.ack_calls.load(Ordering::SeqCst), 1);
    assert!(permit.receipts.lock().unwrap().is_empty());
    assert!(!root.join(&permit.identity.relative_key).exists());
    std::fs::write(root.join("unknown-acknowledgment.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "scope":"isolated-owner-fixture-only","accepted":false,"production_fallback_enabled":false,
        "disposal_state":"unresolved","files_removed":true,"acknowledgment_attempts":1,"positive_acknowledgments":0
    })).unwrap()).unwrap();
    assert_eq!(control.disposal_state(), DisposalState::Unresolved);
    assert!(control.disposal_retry_available());
    let before = primary.requests.lock().unwrap().len() + cdn.requests.lock().unwrap().len();
    permit.refuse_ack.store(false, Ordering::SeqCst);
    assert_eq!(
        control.retry_disposal().await.unwrap(),
        DisposalState::Disposed
    );
    assert_eq!(
        control.retry_disposal().await.unwrap(),
        DisposalState::Disposed
    );
    assert_eq!(permit.ack_calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        *permit.receipts.lock().unwrap(),
        vec![ProcessDisposition::Reaped]
    );
    assert_eq!(
        primary.requests.lock().unwrap().len() + cdn.requests.lock().unwrap().len(),
        before
    );
    {
        let proofs = permit.proofs.lock().unwrap();
        assert_eq!(proofs.len(), 2);
        assert!(Arc::ptr_eq(&proofs[0], &proofs[1]));
    }
    std::fs::write(
        root.join("recovered-original-acknowledgment.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "scope":"isolated-owner-fixture-only","production_fallback_enabled":false,
            "disposal_state":"disposed","same_original_proof":true,"files_removed":true,
            "acknowledgment_attempts":2,"positive_acknowledgments":1,"new_source_requests":0,
            "process_disposition":"reaped"
        }))
        .unwrap(),
    )
    .unwrap();
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
