//! Actual capture + production pending transactions on this run's owned PG.
use super::*;
use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};
use media_core::static_hls::{CaptureOptions, DisposalState, ProcessDisposition};
use providers::{SourceConfig, static_hls::RegisteredSource};
use sqlx::Row;
use std::{collections::HashMap, path::Path};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::watch,
};

struct TestActivation;
impl persistence::static_hls::ActivationCheck for TestActivation {
    fn check(&self) -> media_core::static_hls::CaptureFuture<'_, ()> {
        // This object can only be made in the independently owned test driver.
        Box::pin(async { Ok(()) })
    }
}

struct Origin {
    url: String,
    requests: Arc<AtomicUsize>,
    stop: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl Origin {
    async fn start(files: HashMap<String, Vec<u8>>) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        let (stop, mut stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            loop {
                let mut stream = tokio::select! {
                    _ = stopped.changed() => return,
                    accepted = listener.accept() => match accepted { Ok((stream,_))=>stream, Err(_)=>return }
                };
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0u8; 1024];
                    let count = tokio::select! { _=stopped.changed()=>return, read=stream.read(&mut chunk)=>read.unwrap_or(0) };
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                    if bytes.windows(4).any(|v| v == b"\r\n\r\n") || bytes.len() > 16384 {
                        break;
                    }
                }
                observed.fetch_add(1, Ordering::SeqCst);
                let text = String::from_utf8_lossy(&bytes);
                let target = text
                    .lines()
                    .next()
                    .and_then(|v| v.split_whitespace().nth(1))
                    .unwrap_or("")
                    .split('?')
                    .next()
                    .unwrap_or("");
                let authorized = text
                    .to_ascii_lowercase()
                    .contains("x-native-fixture: owned-test-only\r\n");
                let body = authorized.then(|| files.get(target)).flatten();
                let status = if body.is_some() { 200 } else { 403 };
                let body = body.map(Vec::as_slice).unwrap_or(&[]);
                let head = format!(
                    "HTTP/1.1 {status} Fixture\r\nConnection: close\r\nContent-Length: {}\r\nETag: \"native-fixed-validator\"\r\n\r\n",
                    body.len()
                );
                if stream.write_all(head.as_bytes()).await.is_err() {
                    continue;
                }
                for chunk in body.chunks(16384) {
                    if stream.write_all(chunk).await.is_err() {
                        break;
                    }
                }
            }
        });
        Ok(Self {
            url,
            requests,
            stop,
            task: Some(task),
        })
    }
    async fn close(mut self) -> Result<()> {
        self.stop.send_replace(true);
        if let Some(task) = self.task.take() {
            task.await?;
        }
        Ok(())
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

async fn media(
    root: &Path,
    geometry: &str,
    seconds: u32,
    audio: bool,
) -> Result<HashMap<String, Vec<u8>>> {
    std::fs::create_dir(root)?;
    let output = root.join("index.m3u8");
    let mut args = vec![
        "-v".into(),
        "error".into(),
        "-nostdin".into(),
        "-y".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!("testsrc2=size={geometry}:rate=25:duration={seconds}"),
    ];
    if audio {
        args.extend(["-f", "lavfi", "-i"].map(str::to_owned));
        args.push(format!(
            "sine=frequency=440:sample_rate=48000:duration={seconds}"
        ));
        args.extend(
            [
                "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-ar", "48000", "-ac", "1",
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
            "25",
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
    let (status, _) =
        media_core::child_process::capture(command, Duration::from_secs(10), 65536).await?;
    ensure!(status.success(), "native fixture generation failed");
    std::fs::write(
        root.join("generation-argv.json"),
        serde_json::to_vec_pretty(&args)?,
    )?;
    let mut files = HashMap::new();
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        let name = path.file_name().unwrap().to_str().unwrap();
        if !name.ends_with(".json") {
            files.insert(format!("/{name}"), std::fs::read(path)?);
        }
    }
    Ok(files)
}

fn seal(cipher: &Aes256Gcm, bytes: &[u8]) -> Result<String> {
    let uuid = Uuid::new_v4();
    let nonce = &uuid.as_bytes()[..12];
    let encrypted = cipher
        .encrypt(nonce.into(), bytes)
        .map_err(|_| anyhow!("fixture seal failed"))?;
    Ok(STANDARD.encode([nonce, &encrypted].concat()))
}

async fn input(
    pool: &PgPool,
    origin: &Origin,
    cipher: &Aes256Gcm,
    startup: Uuid,
) -> Result<(Fixture, Value, PreparedParentInput, SourceConfig)> {
    let mut f = Fixture::create(pool).await?;
    f.worker = startup;
    let target = format!("{}/index.m3u8", origin.url);
    let config: SourceConfig = serde_json::from_value(
        json!({"url":format!("{}/",origin.url),"headers":{"x-native-fixture":"owned-test-only"},
        "access_policy":{"schema_version":1,"origins":[{"origin":origin.url,"cidrs":["127.0.0.0/8"]}],"redirects":{"max_hops":1}}}),
    )?;
    let encrypted = seal(cipher, &serde_json::to_vec(&config)?)?;
    sqlx::query("UPDATE sources SET config_encrypted=$2 WHERE id=$1")
        .bind(f.source)
        .bind(encrypted)
        .execute(pool)
        .await?;
    sqlx::query("UPDATE media_items SET resource=$2 WHERE id=$1")
        .bind(f.media)
        .bind(&target)
        .execute(pool)
        .await?;
    let mut value = f.value(pool, f.viewer, 1, 45_000).await?;
    value["source"]["configured_base_url"] = json!(format!("{}/", origin.url));
    value["source"]["canonical_target"] = json!(target);
    value["source"]["headers"] = json!([{"name":"x-native-fixture","value":"owned-test-only"}]);
    value["source"]["access_policy"] = json!({"schema_version":1,"origins":[{"origin":origin.url,"cidrs":["127.0.0.0/8"]}],"redirects":{"max_hops":1}});
    let generation: i64 =
        sqlx::query_scalar("SELECT preview_generation FROM media_items WHERE id=$1")
            .bind(f.media)
            .fetch_one(pool)
            .await?;
    value["source"]["media_source_generation"] = json!(generation);
    let source_revision: i64 =
        sqlx::query_scalar("SELECT access_policy_revision FROM sources WHERE id=$1")
            .bind(f.source)
            .fetch_one(pool)
            .await?;
    value["source"]["source_policy_revision"] = json!(source_revision);
    let prepared = PreparedParentInput::seal(
        FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value)?)?,
        f.catalog(pool).await?,
        |bytes| seal(cipher, bytes),
    )?;
    Ok((f, value, prepared, config))
}

async fn reserved(pool: &PgPool, capture: Uuid) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT COALESCE(sum(bytes),0)::bigint FROM cache_write_reservations WHERE job_id=$1 AND purpose='static_hls_capture'").bind(capture).fetch_one(pool).await?)
}
async fn disposed(pool: &PgPool, capture: Uuid) -> Result<Value> {
    Ok(sqlx::query_scalar("SELECT jsonb_build_object('state',state,'phase',publication_phase,'process_disposition',process_disposition,'all_positive',streams_closed_at IS NOT NULL AND process_closed_at IS NOT NULL AND files_removed_at IS NOT NULL AND disposed_at IS NOT NULL,'root_digest',root_digest,'inventory_encrypted',inventory_encrypted) FROM static_hls_captures WHERE id=$1").bind(capture).fetch_one(pool).await?)
}

pub(super) async fn run(pool: &PgPool, checks: &mut Checks) -> Result<()> {
    let root = PathBuf::from(std::env::var("RAINSYNC_OWNED_TEST_NATIVE_ROOT")?);
    ensure!(
        root == Path::new("/tmp/rainsync-native-db"),
        "dedicated native artifact root required"
    );
    std::fs::create_dir(&root)?;
    checks.begin("native_pg_admission_and_real_scan_retain_the_exact_reserved_owner")?;
    let startup = Uuid::new_v4();
    let key = Sha256::digest(Uuid::new_v4().as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow!("fixture cipher"))?;
    let files = media(&root.join("source-positive"), "128x72", 2, true).await?;
    checks.scanner_started = true;
    checks.save(false, None)?;
    let origin = Origin::start(files).await?;
    let (f, v, p, config) = input(pool, &origin, &cipher, startup).await?;
    freeze(pool, Uuid::new_v4(), &p).await?;
    let stored_input: String = sqlx::query_scalar(
        "SELECT static_hls_input_encrypted FROM playback_requests WHERE session_id=$1",
    )
    .bind(id(&v, "session_id")?)
    .fetch_one(pool)
    .await?;
    let encoded = STANDARD.decode(stored_input)?;
    let clear = cipher
        .decrypt((&encoded[..12]).into(), &encoded[12..])
        .map_err(|_| anyhow!("input authentication failed"))?;
    let opened = FrozenInput::parse_private_plaintext(&clear)?;
    ensure!(opened.identity_statement().input_sha256 == p.input_sha256());
    let before = revision(pool).await?;
    let Admission::Acquired(permit) =
        pending::admit(pool, &p, Uuid::new_v4(), before, u64::MAX).await?
    else {
        anyhow::bail!("native capture admission refused");
    };
    let capture = id(&v, "operation_id")?;
    let relative_key = permit.identity().relative_key;
    let runtime = Arc::new(pending::PersistedPendingCapturePermit::new(
        pool.clone(),
        permit,
        Arc::new(TestActivation),
    ));
    let losing = Arc::new(LostAck {
        inner: runtime.clone(),
        calls: AtomicUsize::new(0),
        proof: Mutex::new(None),
    });
    let cache = root.join("cache-positive");
    std::fs::create_dir(&cache)?;
    let captured = media_core::static_hls::start_capture(
        losing.clone(),
        Arc::new(RegisteredSource::new(
            config.clone(),
            config.headers.clone(),
        )),
        CaptureOptions {
            cache_root: cache.clone(),
            manifest_url: v["source"]["canonical_target"].as_str().unwrap().into(),
            selected_audio: None,
            expected_inventory: None,
        },
    )?
    .wait()
    .await?;
    ensure!(
        captured.evidence().decoder.process_tree_reaped
            && captured.evidence().timeline.duration_ms == 2000.0
    );
    checks.scanner_started = true;
    ensure!(
        reserved(pool, capture).await? == CAPTURE_BYTES as i64
            && losing.calls.load(Ordering::SeqCst) == 0
    );
    std::fs::write(
        root.join("actual-capture.json"),
        serde_json::to_vec_pretty(captured.evidence())?,
    )?;
    checks.pass()?;

    checks
        .begin("native_complete_scanner_graph_commits_verified_inventory_without_a_public_grant")?;
    let measured = serde_json::to_value(captured.evidence())?;
    let root_value = json!({"graph_version":1,"parent_input_sha256":p.input_sha256(),"inventory":measured["inventory"],"closure":measured["closure"],"timeline":measured["timeline"]});
    let statement = RootGraphStatement::parse_private_plaintext(&serde_json::to_vec(&root_value)?)?;
    ensure!(
        runtime
            .verify_capture(&captured, |bytes| seal(&cipher, bytes))
            .await?
    );
    let row = disposed(pool, capture).await?;
    ensure!(
        row["state"] == "verified"
            && row["root_digest"] == statement.root_digest()
            && row["all_positive"] == false
    );
    let encrypted = STANDARD.decode(row["inventory_encrypted"].as_str().unwrap())?;
    let plaintext = cipher
        .decrypt((&encrypted[..12]).into(), &encrypted[12..])
        .map_err(|_| anyhow!("inventory authentication failed"))?;
    ensure!(
        RootGraphStatement::parse_private_plaintext(&plaintext)?.root_digest()
            == statement.root_digest()
    );
    ensure!(f.state(pool).await?["sessions"] == 0 && revision(pool).await? == before + 1);
    std::fs::write(
        root.join("measured-root.json"),
        serde_json::to_vec_pretty(&root_value)?,
    )?;
    checks.pass()?;

    checks.begin("native_original_full_graph_witness_commits_one_parent_and_encrypted_reply")?;
    let before_publication = origin.requests.load(Ordering::SeqCst);
    let witness = captured.prepare_publication().await?;
    ensure!(
        origin.requests.load(Ordering::SeqCst) - before_publication
            == captured.evidence().inventory.len()
    );
    let publication = pending::ParentPublication::prepare(
        p.input(),
        witness,
        |bytes| seal(&cipher, bytes),
        |bytes| seal(&cipher, bytes),
    )?;
    let reply = runtime
        .publish_parent(publication)
        .await?
        .context("original parent publication refused")?;
    let published = sqlx::query("SELECT c.publication_phase,c.published_resource,c.root_digest,p.delivery_token_hash,r.response_encrypted,r.status,p.expires_at=r.static_hls_root_expires_at AS original_root FROM static_hls_captures c JOIN playback_sessions p ON p.id=c.session_id JOIN playback_requests r ON r.session_id=c.session_id WHERE c.id=$1")
        .bind(capture).fetch_one(pool).await?;
    ensure!(
        published.get::<String, _>("publication_phase") == "published_parent"
            && published.get::<String, _>("status") == "completed"
            && published.get::<bool, _>("original_root")
            && published.get::<String, _>("root_digest") == statement.root_digest()
            && published.get::<String, _>("response_encrypted") == reply
            && reserved(pool, capture).await? == CAPTURE_BYTES as i64
            && revision(pool).await? == before + 1
    );
    let encrypted_reply = STANDARD.decode(&reply)?;
    let reply_clear = cipher
        .decrypt((&encrypted_reply[..12]).into(), &encrypted_reply[12..])
        .map_err(|_| anyhow!("published reply authentication failed"))?;
    let reply_value: Value = serde_json::from_slice(&reply_clear)?;
    ensure!(
        reply_value["session_id"] == id(&v, "session_id")?.to_string()
            && reply_value["static_hls_capture_id"] == capture.to_string()
    );
    let hash = format!(
        "{:x}",
        Sha256::digest(
            reply_value["delivery_token"]
                .as_str()
                .context("missing original token")?
                .as_bytes()
        )
    );
    ensure!(hash == published.get::<String, _>("delivery_token_hash"));
    checks.pass()?;

    checks.begin("native_published_reply_replays_without_reencryption_or_source_io")?;
    let observed_reads = origin.requests.load(Ordering::SeqCst);
    ensure!(
        runtime.replay_parent(&captured).await? == Some(reply.clone())
            && runtime.replay_parent(&captured).await? == Some(reply.clone())
            && origin.requests.load(Ordering::SeqCst) == observed_reads
    );
    checks.pass()?;

    checks.begin(
        "native_published_authority_survives_original_preparation_expiry_without_root_extension",
    )?;
    let remaining: f64 = sqlx::query_scalar("SELECT extract(epoch FROM static_hls_prepare_expires_at-clock_timestamp())::float8 FROM playback_requests WHERE session_id=$1")
        .bind(id(&v,"session_id")?).fetch_one(pool).await?;
    sleep(Duration::from_secs_f64(remaining.max(0.0) + 0.2)).await;
    <pending::PersistedPendingCapturePermit as media_core::static_hls::CapturePermit>::check(
        runtime.as_ref(),
    )
    .await?;
    let mut read = captured
        .read(
            media_core::static_hls::ReadResource::Init,
            media_core::static_hls::ReadMethod::Head,
            None,
        )
        .await?;
    ensure!(read.content_length() > 0 && read.chunk().await?.is_none());
    drop(read);
    ensure!(runtime.replay_parent(&captured).await? == Some(reply.clone()));
    std::fs::write(
        root.join("published-parent.json"),
        serde_json::to_vec_pretty(&json!({
            "capture":capture,"scope":"original-native-owner-parent-publication",
            "root_digest":statement.root_digest(),"encrypted_reply_sha256":format!("{:x}",Sha256::digest(reply.as_bytes())),
            "full_graph_revalidated":true,"immutable_replay_no_source_io":true,
            "survives_original_preparation_expiry":true,"root_deadline_not_extended":true,
            "public_hls_activated":false
        }))?,
    )?;
    runtime
        .cancel_parent(410, "static_hls_operation_cancelled")
        .await?;
    ensure!(
        sqlx::query_scalar::<_, bool>("SELECT stopped FROM playback_sessions WHERE id=$1")
            .bind(id(&v, "session_id")?)
            .fetch_one(pool)
            .await?
    );
    checks.pass()?;

    checks.begin("native_cancel_fences_sealed_verification_before_cipher_or_database_mutations")?;
    let control = captured.control()?;
    control.cancel();
    ensure!(
        runtime
            .verify_capture(&captured, |_| panic!("retired snapshot must not encrypt"))
            .await
            .is_err()
    );
    checks.pass()?;

    checks.begin("native_reaped_proof_survives_lost_real_database_ack_without_double_release")?;
    ensure!(captured.dispose().await.is_err());
    ensure!(
        control.disposal_state() == DisposalState::Unresolved && control.disposal_retry_available()
    );
    let released = disposed(pool, capture).await?;
    ensure!(
        released["all_positive"] == true
            && released["process_disposition"] == "reaped"
            && reserved(pool, capture).await? == 0
    );
    ensure!(!cache.join(relative_key).exists());
    let released_revision = revision(pool).await?;
    ensure!(released_revision == before + 2);
    let request_count = origin.requests.load(Ordering::SeqCst);
    ensure!(
        control.retry_disposal().await? == DisposalState::Disposed
            && control.retry_disposal().await? == DisposalState::Disposed
    );
    ensure!(losing.calls.load(Ordering::SeqCst) == 2 && revision(pool).await? == released_revision);
    ensure!(
        origin.requests.load(Ordering::SeqCst) == request_count
            && disposed(pool, capture).await? == released
    );
    {
        let original = losing.proof.lock().unwrap();
        let proof = original.as_ref().context("original proof missing")?;
        ensure!(proof.all_positive() && proof.process_disposition() == ProcessDisposition::Reaped);
    }
    checks.physical_disposal = true;
    std::fs::write(
        root.join("committed-disposal.json"),
        serde_json::to_vec_pretty(&json!({"capture":capture,"worker_startup":startup,
        "all_positive":true,"process_disposition":"reaped","original_proof_retained":true,"ack_calls":2,
        "reserved_bytes":0,"budget_revision":released_revision,"repeated_retry_mutations":0,"public_hls_activated":false}))?,
    )?;
    checks.pass()?;
    origin.close().await?;
    Ok(())
}
