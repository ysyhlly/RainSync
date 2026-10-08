//! Explicit runtime evidence with generated media, private copied fonts, and
//! owned loopback gateway bytes. No account, external service or user media.
#![cfg(target_os = "linux")]
use super::{hold, hold_assets, verify_assets};
use anyhow::{Context, Result, ensure};
use axum::{
    Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::Response,
    routing::get,
};
use media_core::{advanced_media::*, child_process};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path as FilePath, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::io::AsyncReadExt;

struct Fixture {
    root: PathBuf,
    commands: usize,
}
impl Fixture {
    fn new() -> Result<Self> {
        let parent = PathBuf::from(
            std::env::var_os("RAINSYNC_ADVANCED_RUNTIME_REPORT_DIR")
                .context("RAINSYNC_ADVANCED_RUNTIME_REPORT_DIR required")?,
        );
        std::fs::create_dir_all(&parent)?;
        let root = parent.join(format!("remote-assets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        Ok(Self { root, commands: 0 })
    }
    fn record(&self, name: &str, value: &Value) -> Result<()> {
        std::fs::write(self.root.join(name), serde_json::to_vec_pretty(value)?)?;
        Ok(())
    }
    async fn command(
        &mut self,
        mut command: tokio::process::Command,
        label: &str,
        limit: usize,
    ) -> Result<Vec<u8>> {
        use std::process::Stdio;
        self.commands += 1;
        let n = self.commands;
        media_core::input_policy::clean_environment(&mut command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.record(&format!("command-{n:02}-started.json"),&json!({"label":label,"binary":command.as_std().get_program().to_string_lossy(),"args":command.as_std().get_args().map(|a|a.to_string_lossy().into_owned()).collect::<Vec<_>>()}))?;
        let mut child = child_process::spawn(command)?;
        let mut stdout = child.stdout.take().unwrap().take(limit as u64 + 1);
        let mut stderr = child.stderr.take().unwrap().take(1024 * 1024 + 1);
        let outcome = tokio::time::timeout(Duration::from_secs(45), async {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let (read, diagnostic, status) = tokio::join!(
                stdout.read_to_end(&mut out),
                stderr.read_to_end(&mut err),
                child.wait()
            );
            read?;
            diagnostic?;
            Ok::<_, std::io::Error>((status?, out, err))
        })
        .await;
        let (status, out, err) = match outcome {
            Ok(Ok(value)) => value,
            _ => {
                child.kill().await?;
                anyhow::bail!("bounded owned runtime command {label} failed or timed out");
            }
        };
        std::fs::write(self.root.join(format!("command-{n:02}-stderr.txt")), &err)?;
        self.record(&format!("command-{n:02}-completed.json"),&json!({"label":label,"exit":status.code(),"stdout_bytes":out.len(),"stderr_bytes":err.len(),"positive_reaping":child.try_wait()?.is_some()}))?;
        ensure!(
            out.len() <= limit && err.len() <= 1024 * 1024,
            "owned runtime diagnostics bound"
        );
        ensure!(
            status.success(),
            "runtime command {label} exited {status}; inspect command-{n:02}-stderr.txt"
        );
        Ok(out)
    }
    async fn ffmpeg(&mut self, label: &str, args: Vec<String>, limit: usize) -> Result<Vec<u8>> {
        let mut c = tokio::process::Command::new("/usr/bin/ffmpeg");
        c.args(args);
        self.command(c, label, limit).await
    }
    async fn probe(&mut self, path: &FilePath) -> Result<Value> {
        let mut c = tokio::process::Command::new("/usr/bin/ffprobe");
        c.args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-show_data",
            "-of",
            "json",
        ])
        .arg(path);
        Ok(serde_json::from_slice(
            &self.command(c, "actual ffprobe", 4 * 1024 * 1024).await?,
        )?)
    }
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| v.to_string()).collect()
}
#[derive(Clone)]
struct BytesGateway {
    session: uuid::Uuid,
    execution: uuid::Uuid,
    source: Arc<Vec<u8>>,
    files: Arc<Vec<Vec<u8>>>,
    revoked: Arc<AtomicBool>,
    changed: Arc<AtomicBool>,
    corrupt: Arc<AtomicBool>,
}
#[derive(Deserialize)]
struct GateQuery {
    token: String,
    execution: uuid::Uuid,
}
async fn gateway(
    State(g): State<BytesGateway>,
    Path((session, key)): Path<(uuid::Uuid, String)>,
    Query(q): Query<GateQuery>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    if session != g.session
        || q.execution != g.execution
        || q.token != "owned-fixture-token"
        || g.revoked.load(Ordering::SeqCst)
    {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::empty())
            .unwrap();
    }
    let (mut bytes, etag) = match key.as_str() {
        "source" => (g.source.as_ref().clone(), "\"source-1\""),
        "asset-0" => (g.files[0].clone(), "\"asset-0\""),
        "asset-1" => (g.files[1].clone(), "\"asset-1\""),
        _ => return Response::builder().status(404).body(Body::empty()).unwrap(),
    };
    if key == "asset-0" && g.changed.load(Ordering::SeqCst) {
        return Response::builder()
            .status(StatusCode::CONFLICT)
            .body(Body::empty())
            .unwrap();
    }
    if key == "asset-0" && g.corrupt.load(Ordering::SeqCst) {
        let middle = bytes.len() / 2;
        bytes[middle] ^= 1;
    }
    let length = bytes.len();
    let head = method == Method::HEAD;
    if !head
        && headers.get(header::RANGE).and_then(|h| h.to_str().ok())
            != Some(format!("bytes=0-{}", length - 1).as_str())
    {
        return Response::builder().status(416).body(Body::empty()).unwrap();
    }
    Response::builder()
        .status(if head { 200 } else { 206 })
        .header(header::CONTENT_LENGTH, length.to_string())
        .header(
            header::CONTENT_RANGE,
            format!("bytes 0-{}/{}", length - 1, length),
        )
        .header(header::ETAG, etag)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(if head {
            Body::empty()
        } else {
            Body::from(bytes)
        })
        .unwrap()
}
struct Gateway {
    state: BytesGateway,
    url: String,
    task: tokio::task::JoinHandle<()>,
    port: u16,
}
impl Gateway {
    async fn start(source: Vec<u8>, files: Vec<Vec<u8>>) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let state = BytesGateway {
            session: uuid::Uuid::new_v4(),
            execution: uuid::Uuid::new_v4(),
            source: Arc::new(source),
            files: Arc::new(files),
            revoked: Arc::new(AtomicBool::new(false)),
            changed: Arc::new(AtomicBool::new(false)),
            corrupt: Arc::new(AtomicBool::new(false)),
        };
        let url = format!(
            "http://127.0.0.1:{port}/media-delivery/{}/source?token=owned-fixture-token&execution={}",
            state.session, state.execution
        );
        let router = Router::new()
            .route("/media-delivery/{id}/{key}", get(gateway).head(gateway))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Ok(Self {
            state,
            url,
            task,
            port,
        })
    }
    async fn stop(self) -> Result<()> {
        let port = self.port;
        self.task.abort();
        let _ = self.task.await;
        ensure!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err(),
            "owned gateway port closure unconfirmed"
        );
        Ok(())
    }
}
fn subtitle(kind: SubtitleKind) -> Vec<u8> {
    match kind {
 SubtitleKind::Ass=>b"[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,RainSyncOwnedFixture,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.25,0:00:02.25,Default,,0,0,0,,OWNED ASS\n".to_vec(),
 SubtitleKind::Ssa=>b"[Script Info]\nScriptType: v4.00\nPlayResX: 320\nPlayResY: 180\n[V4 Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding\nStyle: Default,RainSyncOwnedFixture,24,16777215,65535,255,0,0,0,1,1,0,2,10,10,10,0,1\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:00.25,0:00:02.25,Default,,0,0,0,,OWNED SSA\n".to_vec(),
 SubtitleKind::Pgs=>{let mut out=Vec::new();let mut segment=|pts:u32,kind:u8,payload:&[u8]|{out.extend_from_slice(b"PG");out.extend_from_slice(&pts.to_be_bytes());out.extend_from_slice(&0u32.to_be_bytes());out.push(kind);out.extend_from_slice(&(payload.len()as u16).to_be_bytes());out.extend_from_slice(payload);};let mut pcs=vec![1,64,0,180,0x10,0,1,0x80,0,0,1];pcs.extend_from_slice(&[0,0,0,0,0,110,0,70]);segment(45000,0x16,&pcs);segment(45000,0x17,&[1,0,0,0,0,0,1,64,0,180]);segment(45000,0x14,&[0,0,0,16,128,128,0,1,235,128,128,255]);let mut rle=Vec::new();for _ in 0..30{rle.extend_from_slice(&[0,0xc0,100,1,0,0]);}let len=rle.len()+4;let mut ods=vec![0,0,0,0xc0,((len>>16)&255)as u8,((len>>8)&255)as u8,(len&255)as u8,0,100,0,30];ods.extend_from_slice(&rle);segment(45000,0x15,&ods);segment(45000,0x80,&[]);segment(135000,0x16,&[1,64,0,180,0x10,0,2,0,0,0,0]);segment(135000,0x80,&[]);out}
}
}
fn catalog(g: &Gateway, kind: SubtitleKind, font: &[u8]) -> Result<RemoteAssetCatalog> {
    let source = "http://owned-fixture.invalid/a.mkv";
    let pin = HttpSourcePin {
        etag: "\"source-1\"".into(),
        bytes: g.state.source.len() as u64,
    };
    let version = source_http_version(source, &pin)?;
    let ext = match kind {
        SubtitleKind::Ass => "ass",
        SubtitleKind::Ssa => "ssa",
        SubtitleKind::Pgs => "sup",
    };
    let text = &g.state.files[0];
    let subtitle = AssetFile {
        resource: format!("http-source.{ext}"),
        source_version: format!("http-v1:{}", asset_sha256(text)),
        bytes: text.len() as u64,
    };
    let fontfile = AssetFile {
        resource: "http-source.fonts/body.ttf".into(),
        source_version: format!("http-v1:{}", asset_sha256(font)),
        bytes: font.len() as u64,
    };
    let files = vec![
        HttpAssetPin {
            resource: subtitle.resource.clone(),
            etag: "\"asset-0\"".into(),
            bytes: subtitle.bytes,
            content_sha256: asset_sha256(text),
        },
        HttpAssetPin {
            resource: fontfile.resource.clone(),
            etag: "\"asset-1\"".into(),
            bytes: fontfile.bytes,
            content_sha256: asset_sha256(font),
        },
    ];
    let remote = RemoteAssetCatalog {
        schema_version: 1,
        source_kind: "http".into(),
        source_resource: source.into(),
        source_version: version.clone(),
        catalog: AssetCatalog {
            schema_version: 2,
            source_resource: HTTP_ASSET_SOURCE.into(),
            source_version: version,
            subtitles: vec![SubtitleAsset {
                index: RemoteAssetCatalog::subtitle_index(kind),
                kind,
                file: subtitle,
            }],
            fonts: vec![fontfile],
        },
        source_http: Some(pin),
        http_files: files,
    };
    remote.validate("http", source, None)?;
    Ok(remote)
}
async fn encode_kind(
    f: &mut Fixture,
    source: &[u8],
    font: &[u8],
    kind: SubtitleKind,
    inventory: &Inventory,
) -> Result<Value> {
    let label = format!("{kind:?}").to_ascii_lowercase();
    let attempt = f.root.join(&label);
    std::fs::create_dir(&attempt)?;
    let output = attempt.join("index.m3u8");
    let gateway = Gateway::start(source.to_vec(), vec![subtitle(kind), font.to_vec()]).await?;
    let remote = catalog(&gateway, kind, font)?;
    let held = hold(&gateway.url, source.len() as u64, &output).await?;
    let assets = hold_assets(
        &gateway.url,
        &remote,
        held.clone(),
        &output,
        Some(RemoteAssetCatalog::subtitle_index(kind)),
    )
    .await?;
    let metadata = f.probe(&attempt.join("held-source.bin")).await?;
    let mut meta = metadata.clone();
    meta["advanced_assets"] = serde_json::to_value(&remote.catalog)?;
    let request = Request {
        schema_version: 1,
        tone_map_hdr: false,
        subtitle_stream_index: Some(RemoteAssetCatalog::subtitle_index(kind)),
    };
    let recipe = Recipe::from_probe(
        &meta,
        None,
        0.1,
        &request,
        EncoderSelection::software_recipe(),
    )?;
    let mut command = tokio::process::Command::new("/usr/bin/ffmpeg");
    let mut actual_args = recipe.ffmpeg_args_with_assets(
        Input::OwnedLocal(&held),
        &output,
        inventory,
        false,
        Some(&assets),
    )?;
    actual_args.splice(
        0..0,
        args(&["-threads", "1", "-filter_complex_threads", "1"]),
    );
    command.args(actual_args);
    held.install(&mut command)?;
    assets.install(&mut command)?;
    f.command(
        command,
        &format!("{label} actual closed advanced encode"),
        1024 * 1024,
    )
    .await?;
    let encoder_log =
        std::fs::read_to_string(f.root.join(format!("command-{:02}-stderr.txt", f.commands)))?;
    let font_selected = kind == SubtitleKind::Pgs
        || encoder_log.lines().any(|line| {
            line.contains("fontselect:")
                && line.contains("RainSyncOwnedFixture")
                && line
                    .split("->")
                    .nth(1)
                    .is_some_and(|selected| selected.contains("RainSyncOwnedFixture"))
        });
    ensure!(
        font_selected,
        "actual libass did not select the uniquely named private font"
    );
    held.verify()?;
    assets.verify()?;
    verify_assets(&gateway.url, &remote).await?;
    ensure!(
        output.exists() && attempt.join("owned-fonts/font-0.ttf").exists(),
        "premature custody disposal"
    );
    let manifest = std::fs::read_to_string(&output)?;
    ensure!(
        manifest.contains("#EXT-X-ENDLIST"),
        "encoder EOF not complete"
    );
    let init = manifest
        .lines()
        .find_map(|line| {
            line.strip_prefix("#EXT-X-MAP:URI=\"")
                .and_then(|s| s.split('"').next())
        })
        .context("HLS init missing")?;
    let mut joined = std::fs::read(attempt.join(init))?;
    let mut fragments = 0;
    for line in manifest
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        joined.extend_from_slice(&std::fs::read(attempt.join(line))?);
        fragments += 1;
    }
    let complete = attempt.join("complete-output.mp4");
    std::fs::write(&complete, &joined)?;
    let observed = f.probe(&complete).await?;
    recipe.validate_output_probe(&observed)?;
    f.ffmpeg(
        &format!("{label} complete-output full decode"),
        {
            let mut a = args(&["-v", "error", "-xerror", "-nostdin", "-i"]);
            a.push(complete.to_string_lossy().into());
            a.extend(args(&["-map", "0", "-f", "null", "-"]));
            a
        },
        1024 * 1024,
    )
    .await?;
    let frame = f
        .ffmpeg(
            &format!("{label} pixel evidence"),
            {
                let mut a = args(&["-v", "error", "-xerror", "-nostdin", "-ss", "0.7", "-i"]);
                a.push(complete.to_string_lossy().into());
                a.extend(args(&[
                    "-map",
                    "0:v:0",
                    "-frames:v",
                    "1",
                    "-pix_fmt",
                    "gray",
                    "-f",
                    "rawvideo",
                    "pipe:1",
                ]));
                a
            },
            1280 * 720,
        )
        .await?;
    ensure!(frame.len() == 1280 * 720, "complete pixel frame required");
    let white = frame.iter().filter(|b| **b > 100).count();
    ensure!(white > 100, "subtitle pixels absent for {label}: {white}");
    std::fs::write(
        attempt.join("subtitle-frame.pgm"),
        [b"P5\n1280 720\n255\n".as_slice(), frame.as_slice()].concat(),
    )?;
    f.ffmpeg(
        &format!("{label} retained PNG pixel evidence"),
        {
            let mut command = args(&["-v", "error", "-nostdin", "-y", "-i"]);
            command.push(attempt.join("subtitle-frame.pgm").to_string_lossy().into());
            command.extend(args(&["-frames:v", "1", "-threads:v", "1"]));
            command.push(attempt.join("subtitle-frame.png").to_string_lossy().into());
            command
        },
        1024 * 1024,
    )
    .await?;
    gateway.state.changed.store(true, Ordering::SeqCst);
    ensure!(
        verify_assets(&gateway.url, &remote).await.is_err(),
        "changed original subtitle accepted"
    );
    gateway.state.changed.store(false, Ordering::SeqCst);
    gateway.state.revoked.store(true, Ordering::SeqCst);
    ensure!(
        verify_assets(&gateway.url, &remote).await.is_err(),
        "revoked gateway still accepted"
    );
    gateway.state.revoked.store(false, Ordering::SeqCst);
    // Pace a second real decoder so revocation is observed while it is live.
    let interrupted = f.root.join(format!("{label}-revoked"));
    std::fs::create_dir(&interrupted)?;
    let mut cancellation_args = recipe.ffmpeg_args_with_assets(
        Input::OwnedLocal(&held),
        &interrupted.join("index.m3u8"),
        inventory,
        false,
        Some(&assets),
    )?;
    let first_input = cancellation_args
        .iter()
        .position(|a| a == "-i")
        .context("closed recipe input missing")?;
    cancellation_args.insert(first_input, "-re".into());
    cancellation_args.splice(
        0..0,
        args(&["-threads", "1", "-filter_complex_threads", "1"]),
    );
    let mut command = tokio::process::Command::new("/usr/bin/ffmpeg");
    media_core::input_policy::clean_environment(&mut command);
    command
        .args(&cancellation_args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    held.install(&mut command)?;
    assets.install(&mut command)?;
    let mut child = child_process::spawn(command)?;
    ensure!(
        attempt.join("owned-fonts/font-0.ttf").exists(),
        "live child lost font custody"
    );
    let revoked = gateway.state.revoked.clone();
    let revoker = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        revoked.store(true, Ordering::SeqCst);
    });
    let (_stop, mut stop) = tokio::sync::watch::channel(false);
    let url = gateway.url.clone();
    let live_fonts = attempt.join("owned-fonts/font-0.ttf");
    let cancellation = crate::process::supervise(
        &mut child,
        &mut stop,
        tokio::time::Instant::now() + Duration::from_secs(10),
        || async { Ok(Some(tokio::time::Instant::now() + Duration::from_secs(10))) },
        async {
            loop {
                tokio::time::sleep(Duration::from_millis(40)).await;
                if let Err(error) = verify_assets(&url, &remote).await {
                    assert!(
                        live_fonts.exists(),
                        "font custody dropped before child cancellation"
                    );
                    return error;
                }
            }
        },
    )
    .await;
    revoker.await?;
    ensure!(
        cancellation.is_err() && child.try_wait()?.is_some(),
        "revoked running decoder was not positively killed/reaped"
    );
    drop(child);
    f.record(&format!("{label}-revocation.json"),&json!({"real_ffmpeg_decoder_started":true,"test_only_realtime_pacing":true,"revocation_observed_while_font_custody_present":true,"supervisor_returned_failure":true,"positive_child_reaping":true,"no_publication_invoked":true}))?;
    gateway.state.revoked.store(false, Ordering::SeqCst);
    let retained_files =
        attempt.join("held-asset-0.bin").exists() && attempt.join("held-asset-1.bin").exists();
    drop(assets);
    drop(held);
    ensure!(
        !attempt.join("owned-fonts").exists()
            && !attempt.join("held-source.bin").exists()
            && !attempt.join("held-asset-0.bin").exists()
            && !attempt.join("held-asset-1.bin").exists(),
        "custody disposal after reaping unconfirmed"
    );
    // A lying unchanged ETag cannot substitute different bytes for the frozen
    // content fingerprint. No decoder or fonts directory starts in this attempt.
    let bad = f.root.join(format!("{label}-corrupt"));
    std::fs::create_dir(&bad)?;
    gateway.state.corrupt.store(true, Ordering::SeqCst);
    let source_held = hold(&gateway.url, source.len() as u64, &bad.join("index.m3u8")).await?;
    ensure!(
        hold_assets(
            &gateway.url,
            &remote,
            source_held.clone(),
            &bad.join("index.m3u8"),
            Some(RemoteAssetCatalog::subtitle_index(kind))
        )
        .await
        .is_err(),
        "mutated asset fingerprint accepted"
    );
    drop(source_held);
    ensure!(
        !bad.join("held-asset-0.bin").exists()
            && !bad.join("owned-fonts").exists()
            && !bad.join("held-source.bin").exists(),
        "failed acquisition retained partial assets"
    );
    gateway.stop().await?;
    Ok(
        json!({"kind":label,"source_probe":metadata,"output_probe":observed,"remote_catalog_sha256":remote.fingerprint()?,"fragments":fragments,"source_sha256":asset_sha256(source),"font_sha256":asset_sha256(font),"private_unique_font_selected":(kind!=SubtitleKind::Pgs).then_some(font_selected),"output_sha256":asset_sha256(&joined),"white_pixels":white,"subtitle_pixels_observed":true,"complete_output_decode":true,"encoder_eof":true,"assets_retained_until_positive_encoder_reaping":retained_files,"changed_asset_refused":true,"revoked_gateway_refused":true,"revoked_running_decoder_positively_reaped":true,"lying_unchanged_etag_content_refused":true,"failed_partial_cleanup":true,"custody_disposal_verified":true,"gateway_port_closed":true}),
    )
}
async fn run(f: &mut Fixture) -> Result<Value> {
    let source = f.root.join("generated-source.mp4");
    let mut generate = args(&[
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
        "color=c=black:s=320x180:r=25:d=2.4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=2.4",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-bf",
        "0",
        "-threads:v",
        "1",
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-avoid_negative_ts",
        "make_zero",
        "-movflags",
        "+faststart",
        "-t",
        "2.4",
    ]);
    generate.push(source.to_string_lossy().into());
    f.ffmpeg("generate owned AVC/AAC source", generate, 1024 * 1024)
        .await?;
    let copied = f.root.join("fixture-font.ttf");
    let mut python = tokio::process::Command::new("python3");
    python.arg("-c").arg("from fontTools.ttLib import TTFont\nimport sys\nf=TTFont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')\nfor n in f['name'].names:\n if n.nameID in (1,4,6,16): n.string='RainSyncOwnedFixture'.encode(n.getEncoding())\nf.save(sys.argv[1])").arg(&copied);
    f.command(
        python,
        "copy and uniquely name system font into owned fixture",
        1024 * 1024,
    )
    .await?;
    let version = f
        .ffmpeg("actual FFmpeg version", args(&["-version"]), 1024 * 1024)
        .await?;
    f.record("runtime-version.json",&json!({"ffmpeg":String::from_utf8_lossy(&version),"font_library":"actual FFmpeg libass with uniquely named owned DejaVu Sans copy"}))?;
    let source = std::fs::read(&source)?;
    let font = std::fs::read(&copied)?;
    let inventory = Inventory::inspect().await?;
    let mut outputs = Vec::new();
    for kind in [SubtitleKind::Ass, SubtitleKind::Ssa, SubtitleKind::Pgs] {
        outputs.push(encode_kind(f, &source, &font, kind, &inventory).await?);
    }
    Ok(
        json!({"schema_version":1,"result":"passed","scope":"owned generated AVC/AAC + finite loopback gateway + descriptor-backed external ASS/SSA/PGS and uniquely named font custody","outputs":outputs,"limitations":["Gateway fixture enforces numeric/session/execution paths but does not invoke production PostgreSQL-backed HTTP handler or NAS control socket","PostgreSQL authorization/queue acceptance is separate","No provider account, user media, hardware encoder/GPU or browser acceptance"]}),
    )
}
#[tokio::test]
#[ignore = "Explicit owned FFmpeg/libass/font runtime evidence; requires RAINSYNC_ADVANCED_RUNTIME_REPORT_DIR"]
async fn finite_remote_ass_ssa_pgs_font_encode_decode_and_dispose() -> Result<()> {
    let mut f = Fixture::new()?;
    let scope = child_process::Scope::new();
    let result = scope.run(run(&mut f)).await;
    let drained = scope.shutdown().await;
    f.record("report.json",&match &result{Ok(report)=>{let mut report=report.clone();report["positive_scope_drain"]=json!(drained.is_ok());report},Err(error)=>json!({"result":"failed","error":error.to_string(),"positive_scope_drain":drained.is_ok(),"commands":f.commands})})?;
    drained?;
    result?;
    Ok(())
}
