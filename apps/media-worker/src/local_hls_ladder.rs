//! Dedicated local ladder runtime. Private muxer masters are never delivered.
//! Every advertised rung shares one current attempt and immutable qualified prefix.
use super::{
    App, cache, child_process, execution_failure, output_decode, outputs, process, source_version,
};
use anyhow::{Result, ensure};
use media_core::advanced_media::{Input, Inventory, OwnedLocalInput};
use media_core::hls_ladder::{
    AttemptIdentity, LadderRecipe, QualifiedRendition, RenditionId, qualify_ladder,
    qualify_rendition,
};
use persistence::{
    local_hls_ladder::{self as durable, RenditionSnapshot, Snapshot},
    media_jobs::Claim,
    media_outputs::FileProof,
};
use serde_json::Value;
use std::{path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Mutex, watch},
};
use uuid::Uuid;

#[derive(Debug)]
struct NotReady;
impl std::fmt::Display for NotReady {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("local_hls_ladder_not_ready")
    }
}
impl std::error::Error for NotReady {}

/// Child remains owned across cancellation of a monitor or finalization waiter.
#[derive(Default)]
struct Probe {
    child: Mutex<Option<child_process::Child>>,
}
impl Probe {
    async fn stop(&self) -> Result<()> {
        let mut slot = self.child.lock().await;
        if let Some(child) = slot.as_mut() {
            if child.try_wait()?.is_none() {
                child.kill().await?;
            }
            child.wait().await?;
        }
        *slot = None;
        Ok(())
    }
    async fn inspect(&self, init: &[u8], segment: &[u8]) -> Result<Value> {
        let mut slot = self.child.lock().await;
        ensure!(slot.is_none(), "local_hls_ladder_probe_busy");
        let mut command = tokio::process::Command::new("ffprobe");
        super::native_platform_transcode::clean_native_environment(&mut command);
        command
            .args(media_core::hls_ladder::first_fragment_probe_args())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        *slot = Some(child_process::spawn(command)?);
        let child = slot.as_mut().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let work = async {
            let feeding = async {
                stdin.write_all(init).await?;
                stdin.write_all(segment).await?;
                stdin.shutdown().await?;
                Ok::<_, anyhow::Error>(())
            };
            let reading = async {
                let mut bytes = Vec::new();
                stdout
                    .take(media_core::hls_ladder::MAX_PROBE_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
                    .await?;
                ensure!(
                    bytes.len() <= media_core::hls_ladder::MAX_PROBE_BYTES,
                    "local_hls_ladder_probe_bound"
                );
                Ok::<_, anyhow::Error>(bytes)
            };
            let (_, bytes) = tokio::try_join!(feeding, reading)?;
            ensure!(
                child.wait().await?.success(),
                "local_hls_ladder_probe_failed"
            );
            Ok::<_, anyhow::Error>(serde_json::from_slice(&bytes)?)
        };
        let result = tokio::time::timeout(Duration::from_secs(10), work).await;
        if child.try_wait()?.is_none() {
            child.kill().await?;
        }
        child.wait().await?;
        *slot = None;
        result.map_err(|_| anyhow::Error::new(process::LeaseInterrupted))?
    }
}
struct Rung {
    id: RenditionId,
    init: Vec<u8>,
    proofs: Vec<FileProof>,
    qualified: Option<QualifiedRendition>,
    decoder: output_decode::Gate,
    probe: Probe,
}
pub(crate) struct Builder {
    recipe: Arc<LadderRecipe>,
    identity: AttemptIdentity,
    directory: PathBuf,
    rungs: Vec<Rung>,
}
impl Builder {
    pub(crate) fn new(
        recipe: Arc<LadderRecipe>,
        identity: AttemptIdentity,
        directory: PathBuf,
    ) -> Self {
        Self {
            rungs: recipe
                .renditions()
                .iter()
                .map(|r| Rung {
                    id: r.id,
                    init: Vec::new(),
                    proofs: Vec::new(),
                    qualified: None,
                    decoder: Default::default(),
                    probe: Default::default(),
                })
                .collect(),
            recipe,
            identity,
            directory,
        }
    }
    pub(crate) async fn stop(&self) -> Result<()> {
        for rung in &self.rungs {
            rung.probe.stop().await?;
            rung.decoder.stop().await?;
        }
        Ok(())
    }
    pub(crate) async fn prepare(&mut self, complete: bool) -> Result<Snapshot> {
        for rung in &mut self.rungs {
            let directory = self.directory.join(rung.id.as_str());
            let text = read_playlist(directory.join("index.m3u8")).await?;
            let parsed = media_core::hls_ladder::parse_media_playlist(&text)?;
            if complete {
                ensure!(parsed.complete, "local_hls_ladder_endlist_required");
            }
            if rung.qualified.is_none() {
                let (init, init_proof) = read_resource(
                    directory.join("init.mp4"),
                    -1,
                    media_core::hls_ladder::MAX_INIT_BYTES,
                )
                .await?;
                let (fragment, first_proof) = read_resource(
                    directory.join("index0.m4s"),
                    0,
                    media_core::hls_ladder::MAX_FRAGMENT_BYTES,
                )
                .await?;
                let probe = rung.probe.inspect(&init, &fragment).await?;
                let qualified = qualify_rendition(
                    &self.recipe,
                    rung.id,
                    &self.identity,
                    &text,
                    &init,
                    &fragment,
                    &probe,
                )?;
                // Content/probe qualification alone is not an error-free decoder
                // receipt. This gate positively reaps a strict first decode.
                rung.decoder
                    .verify(directory.clone(), [init_proof.clone(), first_proof.clone()])
                    .await?;
                rung.decoder.stop().await?;
                rung.init = init;
                rung.proofs = vec![init_proof, first_proof];
                rung.qualified = Some(qualified);
            }
            let qualified = rung.qualified.as_mut().unwrap();
            qualified.refresh_playlist(&text)?;
            while qualified.qualified_segment_count() < parsed.segments.len() {
                let index = qualified.qualified_segment_count();
                let (bytes, proof) = read_resource(
                    directory.join(format!("index{index}.m4s")),
                    i32::try_from(index)?,
                    media_core::hls_ladder::MAX_FRAGMENT_BYTES,
                )
                .await?;
                qualified.append_fragment(&self.recipe, &rung.init, &bytes)?;
                rung.proofs.push(proof);
            }
            // Recheck startup custody on each publication. Full completion
            // additionally rehashes every prior immutable prefix; every GET
            // independently verifies its own committed proof.
            let proofs = if complete {
                rung.proofs.clone()
            } else {
                rung.proofs[..2].to_vec()
            };
            child_process::blocking(move || -> Result<()> {
                for proof in proofs {
                    let name = if proof.index == -1 {
                        "init.mp4".into()
                    } else {
                        format!("index{}.m4s", proof.index)
                    };
                    outputs::open_verified(&directory.join(name), &proof)?;
                }
                Ok(())
            })
            .await??;
        }
        let rungs = self
            .rungs
            .iter_mut()
            .map(|r| r.qualified.take().unwrap())
            .collect();
        let qualified = qualify_ladder(&self.recipe, &self.identity, rungs)?;
        let qualified_count = qualified.available_through() + 1;
        let master = qualified.master_text();
        let prefix = publication_prefix(qualified.common_playlist(), complete);
        for (rung, qualified) in self.rungs.iter_mut().zip(qualified.into_renditions()) {
            rung.qualified = Some(qualified);
        }
        let prefix = prefix?;
        let segment_count = i32::try_from(prefix.segments.len())?;
        ensure!(
            segment_count as usize <= qualified_count,
            "local_hls_ladder_incomplete"
        );
        let duration_us = i64::try_from(prefix.duration_us())?;
        let manifest = render_prefix(&prefix);
        let renditions = self
            .rungs
            .iter()
            .map(|r| RenditionSnapshot {
                id: r.id,
                manifest: manifest.clone(),
                files: r.proofs[..segment_count as usize + 1].to_vec(),
            })
            .collect();
        let snapshot = Snapshot {
            master,
            segment_count,
            duration_us,
            renditions,
        };
        snapshot.validate(complete)?;
        Ok(snapshot)
    }
}
/// A short final segment needs ENDLIST. Hold it private until a successful
/// encoder reap, rather than emitting an unaligned EVENT suffix or treating
/// an early muxer ENDLIST as final completion authority.
fn publication_prefix(
    common: &media_core::hls_ladder::MediaPlaylist,
    complete: bool,
) -> Result<media_core::hls_ladder::MediaPlaylist> {
    ensure!(!complete || common.complete, "local_hls_ladder_incomplete");
    let count = if complete {
        common.segments.len()
    } else {
        common
            .segments
            .iter()
            .take_while(|s| s.duration_us == 4_000_000)
            .count()
    };
    if count == 0 {
        return Err(NotReady.into());
    }
    Ok(media_core::hls_ladder::MediaPlaylist {
        segments: common.segments[..count].to_vec(),
        complete,
    })
}
fn render_prefix(prefix: &media_core::hls_ladder::MediaPlaylist) -> String {
    let mut text="#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI=\"init.mp4\"\n".to_owned();
    for segment in &prefix.segments {
        text.push_str(&format!(
            "#EXTINF:{}.{:06},\nindex{}.m4s\n",
            segment.duration_us / 1_000_000,
            segment.duration_us % 1_000_000,
            segment.index
        ));
    }
    if prefix.complete {
        text.push_str("#EXT-X-ENDLIST\n");
    }
    text
}

async fn read_playlist(path: PathBuf) -> Result<String> {
    child_process::blocking(move || {
        use std::io::Read;
        let meta = std::fs::symlink_metadata(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                anyhow::Error::new(NotReady)
            } else {
                e.into()
            }
        })?;
        ensure!(
            meta.is_file()
                && !meta.file_type().is_symlink()
                && meta.len() <= media_core::hls_ladder::MAX_MANIFEST_BYTES as u64,
            "local_hls_ladder_manifest_invalid"
        );
        let mut text = String::new();
        std::fs::File::open(&path)?
            .take(media_core::hls_ladder::MAX_MANIFEST_BYTES as u64 + 1)
            .read_to_string(&mut text)?;
        ensure!(
            text.len() <= media_core::hls_ladder::MAX_MANIFEST_BYTES,
            "local_hls_ladder_manifest_bound"
        );
        Ok(text)
    })
    .await?
}
async fn read_resource(path: PathBuf, index: i32, max: usize) -> Result<(Vec<u8>, FileProof)> {
    child_process::blocking(move || {
        use std::io::{Read, Seek};
        let mut file = outputs::open_media(&path).map_err(|e| {
            if e.downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            {
                anyhow::Error::new(NotReady)
            } else {
                e
            }
        })?;
        let (size_bytes, sha256) = outputs::hash_file(&mut file)?;
        ensure!(size_bytes <= max as i64, "local_hls_ladder_resource_bound");
        let mut bytes = Vec::with_capacity(size_bytes as usize);
        (&mut file).take(max as u64 + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() == size_bytes as usize,
            "output_changed_during_hash"
        );
        file.rewind()?;
        let after = outputs::hash_file(&mut file)?;
        ensure!(
            after == (size_bytes, sha256.clone()),
            "output_changed_during_hash"
        );
        Ok((
            bytes,
            FileProof {
                index,
                size_bytes,
                sha256,
            },
        ))
    })
    .await?
}
/// Create a new attempt only, never adopt a previous writer's directory.
pub(crate) fn prepare_directory(
    root: &std::path::Path,
    id: Uuid,
    attempt: i64,
    rungs: &[RenditionId],
) -> Result<PathBuf> {
    ensure!(
        attempt > 0 && !rungs.is_empty() && rungs.len() <= 3,
        "local_hls_ladder_attempt_boundary"
    );
    let root = root.canonicalize()?;
    let parent = root.join(id.to_string());
    match std::fs::create_dir(&parent) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(cache::write_error(error)),
    }
    let meta = std::fs::symlink_metadata(&parent)?;
    ensure!(
        meta.is_dir()
            && !meta.file_type().is_symlink()
            && parent.canonicalize()?.parent() == Some(root.as_path()),
        "local_hls_ladder_attempt_boundary"
    );
    let directory = parent.join(attempt.to_string());
    // An existing directory is missing original custody, not reusable work.
    std::fs::create_dir(&directory).map_err(cache::write_error)?;
    for rung in rungs {
        std::fs::create_dir(directory.join(rung.as_str())).map_err(cache::write_error)?;
    }
    Ok(directory)
}

async fn local_probe(local: &OwnedLocalInput) -> Result<Value> {
    let mut command = tokio::process::Command::new("ffprobe");
    media_core::input_policy::clean_environment(&mut command);
    command.args(media_core::input_policy::args(false, false));
    command
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(local.decoder_path()?);
    local.install(&mut command)?;
    let (status, bytes) =
        child_process::capture(command, Duration::from_secs(20), 8 * 1024 * 1024).await?;
    ensure!(status.success(), "local_hls_ladder_source_probe_failed");
    local.verify()?;
    Ok(serde_json::from_slice(&bytes)?)
}
pub(crate) async fn monitor(app: &App, claim: &Claim, builder: &Mutex<Builder>) -> anyhow::Error {
    let mut previous = 0;
    loop {
        let snapshot = match builder.lock().await.prepare(false).await {
            Ok(snapshot) => snapshot,
            Err(error) if error.is::<NotReady>() => {
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
            Err(error) => return error,
        };
        if snapshot.segment_count > previous {
            match tokio::time::timeout(
                Duration::from_secs(3),
                durable::publish(&app.db, claim, &snapshot, false),
            )
            .await
            {
                Ok(Ok(true)) => previous = snapshot.segment_count,
                Ok(Ok(false)) => return process::LeaseInterrupted.into(),
                Ok(Err(error)) if error.downcast_ref::<sqlx::Error>().is_none() => return error,
                _ => {
                    tracing::warn!("ladder publication unknown; retaining confirmed common prefix")
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Final validation may launch bounded per-rung probes after encoder exit.
/// Keep renewing the same authority, charging blocked queries to the prior
/// confirmed deadline. A stopped/expired attempt never publishes late proofs.
pub(crate) async fn finalize_fenced<T>(
    app: &App,
    claim: &Claim,
    stop: &mut watch::Receiver<bool>,
    work: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    let mut until = process::finalization_deadline(
        Duration::from_secs(3),
        process::confirmed_deadline(persistence::media_jobs::renew_remaining(&app.db, claim)),
    )
    .await?
    .ok_or_else(|| anyhow::Error::new(process::LeaseInterrupted))?;
    let mut next = tokio::time::Instant::now() + Duration::from_secs(4);
    tokio::pin!(work);
    loop {
        tokio::select! {
            biased;
            _=process::stopped(stop)=>anyhow::bail!("worker_shutdown"),
            _=tokio::time::sleep_until(until)=>return Err(process::LeaseInterrupted.into()),
            result=&mut work=>return result,
            _=tokio::time::sleep_until(next)=>{
                let renewal=tokio::select! {
                    biased;
                    _=process::stopped(stop)=>anyhow::bail!("worker_shutdown"),
                    _=tokio::time::sleep_until(until)=>return Err(process::LeaseInterrupted.into()),
                    result=tokio::time::timeout(Duration::from_secs(3),process::confirmed_deadline(persistence::media_jobs::renew_remaining(&app.db,claim)))=>result,
                };
                if tokio::time::Instant::now()>=until {return Err(process::LeaseInterrupted.into());}
                match renewal {Ok(Ok(Some(confirmed))) if confirmed>tokio::time::Instant::now()=>{until=confirmed;next=tokio::time::Instant::now()+Duration::from_secs(4)},Ok(Ok(_))=>return Err(process::LeaseInterrupted.into()),_=>next=tokio::time::Instant::now()+Duration::from_secs(1)}
            }
        }
    }
}

/// Runs inside the existing job Scope and writer-receipt lifecycle. Return only
/// after all retained decoder/probe children are positively stopped. A successful
/// final publication additionally requires a reaped successful encoder tree.
pub async fn run(
    app: &App,
    claim: &Claim,
    stop: &mut watch::Receiver<bool>,
    writer_stopped: &mut bool,
) -> Result<()> {
    durable::validate_spec(&claim.spec)?;
    ensure!(
        cfg!(target_os = "linux"),
        "local_hls_ladder_local_linux_required"
    );
    let mut builder = None;
    let mut encoder = None;
    let mut asset_custody: Option<Arc<media_core::advanced_media::OwnedAssets>> = None;
    let result=async {
        let (local,recipe,args,directory)=finalize_fenced(app,claim,stop,async {
        cache::ensure_capacity(app).await?;cache::reserve_output(app,claim).await?;
        source_version::verify(&claim.spec).await?;
        let root=PathBuf::from(claim.spec["root"].as_str().unwrap());
        let resource=claim.spec["resource"].as_str().unwrap().to_owned();
        let version=claim.spec["source_version"].as_str().unwrap().to_owned();
        let local=Arc::new(child_process::blocking(move ||OwnedLocalInput::open(&root,&resource,&version)).await??);
        let mut meta=local_probe(&local).await?;
        local.verify_dolby_vision_rpu(&meta).await?;
        if let Some(assets)=claim.spec.get("advanced_assets") {meta["advanced_assets"]=assets.clone();}
        let audio=claim.spec["audio_index"].as_u64().map(u32::try_from).transpose()?;
        let request=claim.spec.get("advanced_media").map(|v|serde_json::from_value::<media_core::advanced_media::Request>(v.clone())).transpose()?;
        let start=claim.spec["start_seconds"].as_f64().unwrap();
        let recipe=Arc::new(if let Some(request)=&request {LadderRecipe::from_advanced_probe(&meta,audio,start,request)?} else {LadderRecipe::from_probe(&meta,audio,start)?});
        durable::verify_recipe(&claim.spec,&recipe)?;
        let root=app.cache.clone();let id=claim.id;let attempt=claim.attempt;
        let rungs=recipe.renditions().iter().map(|r|r.id).collect::<Vec<_>>();
        let directory=child_process::blocking(move ||prepare_directory(&root,id,attempt,&rungs)).await??;
        let inventory=Inventory::inspect().await?;
        let external_index=recipe.external_subtitle_index();
        if external_index.is_some() || recipe.requires_external_fonts() {
            let catalog:media_core::advanced_media::AssetCatalog=serde_json::from_value(claim.spec["advanced_assets"].clone())?;
            let root=PathBuf::from(claim.spec["root"].as_str().unwrap());let fonts=directory.join("owned-fonts");
            asset_custody=Some(Arc::new(child_process::blocking(move||if let Some(index)=external_index {media_core::advanced_media::OwnedAssets::open(&root,&catalog,index,&fonts)}else{media_core::advanced_media::OwnedAssets::open_fonts(&root,&catalog,&fonts)}).await??));
        }
        let args=recipe.ffmpeg_args_with_assets(Input::OwnedLocal(&local),&directory,&inventory,false,asset_custody.as_deref())?;
        Ok::<_,anyhow::Error>((local,recipe,args,directory))
        }).await?;
        let identity=AttemptIdentity {recipe_version:1,attempt_id:Uuid::new_v4().to_string(),source_generation:claim.spec["source_generation"].as_u64().unwrap(),plan_generation:claim.spec["plan_generation"].as_u64().unwrap()};
        builder=Some(Mutex::new(Builder::new(recipe,identity,directory)));
        let until=app.readiness.check_lease(process::finalization_deadline(Duration::from_secs(3),process::confirmed_deadline(persistence::media_jobs::renew_remaining(&app.db,claim)))).await?.ok_or_else(||anyhow::Error::new(process::LeaseInterrupted))?;
        ensure!(!*stop.borrow() && until>tokio::time::Instant::now(),"lease_lost_before_spawn");
        let mut command=tokio::process::Command::new("ffmpeg");media_core::input_policy::clean_environment(&mut command);
        command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);local.install(&mut command)?;
        if let Some(assets)=&asset_custody {assets.install(&mut command)?;}
        encoder=Some(child_process::spawn(command)?);*writer_stopped=false;
        let child=encoder.as_mut().unwrap();let diagnostics=child.stderr.take().unwrap();
        let supervised=process::supervise(child,stop,until,||async {app.readiness.check_lease(process::confirmed_deadline(persistence::media_jobs::renew_remaining(&app.db,claim))).await},async {tokio::select! {error=source_version::monitor(&claim.spec)=>error,error=cache::monitor(app)=>error,error=monitor(app,claim,builder.as_ref().unwrap())=>error}});
        let (result,_)=execution_failure::observe_with_input(supervised,diagnostics,&local.decoder_path()?).await;
        *writer_stopped=child.try_wait()?.is_some();result?;
        // Encoder wait is positive; stopping an interrupted monitor also reaps
        // a probe/decoder it retained before the final full-prefix checks.
        builder.as_ref().unwrap().lock().await.stop().await?;
        ensure!(*writer_stopped && !*stop.borrow(),"local_hls_ladder_encoder_reap_required");
        cache::check_output_capacity(app).await?;local.verify()?;source_version::verify(&claim.spec).await?;
        let snapshot=finalize_fenced(app,claim,stop,builder.as_ref().unwrap().lock().await.prepare(true)).await?;
        ensure!((snapshot.duration_us as f64/1000.0-(claim.spec["duration_ms"].as_f64().unwrap()-claim.spec["start_seconds"].as_f64().unwrap()*1000.0)).abs()<=100.0,"local_hls_ladder_truncated_output");
        builder.as_ref().unwrap().lock().await.stop().await?;
        local.verify()?;source_version::verify(&claim.spec).await?;
        if let Some(assets)=&asset_custody {assets.verify()?;}
        ensure!(durable::publish(&app.db,claim,&snapshot,true).await?,process::LeaseInterrupted);
        Ok::<_,anyhow::Error>(())
    }.await;
    // Always reap before leaving the attempt to the parent's receipt/reservation
    // release. Cancellation never turns a database fence into an OS-exit proof.
    if let Some(child) = encoder.as_mut() {
        if child.try_wait()?.is_none() {
            child.kill().await?;
        }
        child.wait().await?;
        *writer_stopped = true;
    }
    if let Some(builder) = builder {
        builder.lock().await.stop().await?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn short_final_suffix_waits_for_encoder_completion_authority() {
        use media_core::hls_ladder::{MediaPlaylist, Segment};
        let all = MediaPlaylist {
            complete: true,
            segments: vec![
                Segment {
                    index: 0,
                    duration_us: 4_000_000,
                },
                Segment {
                    index: 1,
                    duration_us: 1_000_000,
                },
            ],
        };
        let running = publication_prefix(&all, false).unwrap();
        assert_eq!(running.segments.len(), 1);
        assert!(!running.complete);
        assert!(!render_prefix(&running).contains("ENDLIST"));
        let complete = publication_prefix(&all, true).unwrap();
        assert_eq!(complete.duration_us(), 5_000_000);
        assert!(render_prefix(&complete).contains("ENDLIST"));
        let short = MediaPlaylist {
            complete: true,
            segments: vec![Segment {
                index: 0,
                duration_us: 1_000_000,
            }],
        };
        assert!(
            publication_prefix(&short, false)
                .unwrap_err()
                .is::<NotReady>()
        );
        assert!(publication_prefix(&short, true).is_ok());
    }
    #[test]
    fn attempt_directories_are_new_and_never_follow_symlinks() {
        let root =
            std::env::temp_dir().join(format!("rainsync-ladder-directory-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let id = Uuid::new_v4();
        let first =
            prepare_directory(&root, id, 1, &[RenditionId::Low, RenditionId::Medium]).unwrap();
        assert!(first.join("low").is_dir());
        assert!(first.join("medium").is_dir());
        assert!(prepare_directory(&root, id, 1, &[RenditionId::Low]).is_err());
        let second = prepare_directory(&root, id, 2, &[RenditionId::Low]).unwrap();
        assert_ne!(first, second);
        assert!(prepare_directory(&root, id, 0, &[RenditionId::Low]).is_err());
        #[cfg(unix)]
        {
            let foreign = Uuid::new_v4();
            std::os::unix::fs::symlink(&second, root.join(foreign.to_string())).unwrap();
            assert!(prepare_directory(&root, foreign, 1, &[RenditionId::Low]).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn immutable_reads_refuse_mutation_symlinks_and_unbounded_bytes() {
        let root = std::env::temp_dir().join(format!("rainsync-ladder-proof-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let atom = |kind: &[u8; 4]| [9u32.to_be_bytes().as_slice(), kind.as_slice(), &[0]].concat();
        let init = [atom(b"ftyp"), atom(b"moov")].concat();
        let path = root.join("init.mp4");
        std::fs::write(&path, &init).unwrap();
        let (bytes, proof) = read_resource(path.clone(), -1, 32).await.unwrap();
        assert_eq!(bytes, init);
        assert!(read_resource(path.clone(), -1, 8).await.is_err());
        std::fs::write(
            &path,
            [
                atom(b"ftyp"),
                [9u32.to_be_bytes().as_slice(), b"moov", &[1]].concat(),
            ]
            .concat(),
        )
        .unwrap();
        assert!(outputs::open_verified(&path, &proof).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(
            read_resource(path.clone(), -1, 32)
                .await
                .unwrap_err()
                .is::<NotReady>()
        );
        #[cfg(unix)]
        {
            std::fs::write(root.join("foreign"), &init).unwrap();
            std::os::unix::fs::symlink(root.join("foreign"), &path).unwrap();
            assert!(read_resource(path, -1, 32).await.is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
