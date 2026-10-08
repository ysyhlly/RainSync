//! Native source ABR shares the bounded opaque ingress and owned ladder proofs.
use super::*;
use anyhow::{Result as AnyResult, ensure};
use media_core::advanced_media::{Input, Inventory, Request, WorkerGatewayInput};
use media_core::hls_ladder::{AttemptIdentity, LadderRecipe, Resource};
use persistence::{media_jobs::Claim, native_platform_ladder as durable};
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::sync::{Mutex, watch};
pub async fn run(
    app: &App,
    claim: &Claim,
    stop: &mut watch::Receiver<bool>,
    writer_stopped: &mut bool,
) -> AnyResult<()> {
    let spec = durable::validate_spec(&claim.spec)?;
    let input_failure = app.input_failures.register(claim.id);
    let mut builder = None;
    let mut encoder = None;
    let result=async {
        let (input,recipe,args,directory)=local_hls_ladder::finalize_fenced(app,claim,stop,async {
        cache::ensure_capacity(app).await?;cache::reserve_output(app,claim).await?;
        let (meta,input,second,_)=native_platform_transcode::source_metadata(claim,input_failure.token()).await?;
        let request=Request{schema_version:1,tone_map_hdr:media_core::advanced_media::classify_hdr(&meta["streams"][0])?.is_some(),subtitle_stream_index:None};
        let recipe=Arc::new(if request.tone_map_hdr || media_core::advanced_media::extended_source_proof(&meta["streams"][0])?.is_some() {LadderRecipe::from_advanced_probe(&meta,Some(1),spec.input.start_seconds,&request)?}else{LadderRecipe::from_probe(&meta,Some(1),spec.input.start_seconds)?});
        durable::verify_recipe(&claim.spec,&recipe)?;
        let root=app.cache.clone();let id=claim.id;let attempt=claim.attempt;
        let rungs=recipe.renditions().iter().map(|r|r.id).collect::<Vec<_>>();
        let directory=child_process::blocking(move||local_hls_ladder::prepare_directory(&root,id,attempt,&rungs)).await??;
        let inventory=Inventory::inspect().await?;
        let gateway=WorkerGatewayInput::native_platform(&input)?;
        let args=native_platform_transcode::constrain_input_args(recipe.ffmpeg_args(Input::WorkerGateway(&gateway),&directory,&inventory,false)?,&spec.input,second.as_deref())?;
        Ok::<_,anyhow::Error>((input,recipe,args,directory))
        }).await?;
        let identity=AttemptIdentity{recipe_version:1,attempt_id:Uuid::new_v4().to_string(),source_generation:u64::from(spec.source_generation),plan_generation:u64::from(spec.plan_generation)};
        builder=Some(Mutex::new(local_hls_ladder::Builder::new(recipe,identity,directory)));
        let until=app.readiness.check_lease(process::finalization_deadline(Duration::from_secs(3),process::confirmed_deadline(persistence::media_jobs::renew_remaining(&app.db,claim)))).await?.ok_or_else(||anyhow::Error::new(process::LeaseInterrupted))?;
        ensure!(!*stop.borrow() && until>tokio::time::Instant::now(),"lease_lost_before_spawn");
        let mut command=tokio::process::Command::new("ffmpeg");native_platform_transcode::clean_native_environment(&mut command);
        command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
        encoder=Some(child_process::spawn(command)?);*writer_stopped=false;
        let child=encoder.as_mut().unwrap();let diagnostics=child.stderr.take().unwrap();
        let work=process::supervise(child,stop,until,||async{app.readiness.check_lease(process::confirmed_deadline(persistence::media_jobs::renew_remaining(&app.db,claim))).await},async{tokio::select!{error=cache::monitor(app)=>error,error=local_hls_ladder::monitor(app,claim,builder.as_ref().unwrap())=>error}});
        let(result,_)=execution_failure::observe_with_input(work,diagnostics,&input).await;
        *writer_stopped=child.try_wait()?.is_some();result?;
        builder.as_ref().unwrap().lock().await.stop().await?;
        ensure!(*writer_stopped && !*stop.borrow(),"native_platform_ladder_encoder_reap_required");
        cache::check_output_capacity(app).await?;
        let snapshot=local_hls_ladder::finalize_fenced(app,claim,stop,builder.as_ref().unwrap().lock().await.prepare(true)).await?;
        ensure!((snapshot.duration_us as f64/1_000_000.0-(spec.input.duration_seconds-spec.input.start_seconds)).abs()<=0.100,"native_platform_ladder_truncated_output");
        builder.as_ref().unwrap().lock().await.stop().await?;
        ensure!(persistence::local_hls_ladder::publish(&app.db,claim,&snapshot,true).await?,process::LeaseInterrupted);
        Ok::<_,anyhow::Error>(())
    }.await;
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
    if result.is_err()
        && *writer_stopped
        && let Some(failure) = input_failure.failure()
    {
        return Err(failure.into());
    }
    result
}
/// Called only inside the native finite-delivery registry's attempt/ticket gate.
pub(crate) async fn output_response(
    app: &App,
    id: Uuid,
    attempt: i64,
    path: &str,
    headers: &HeaderMap,
    head: bool,
) -> Result<Response> {
    let resource = Resource::parse(path).map_err(failure)?;
    let snapshot = persistence::local_hls_ladder::read(&app.db, id)
        .await
        .map_err(failure)?
        .ok_or_else(|| failure("media_job_pending"))?;
    if snapshot.attempt != attempt {
        return Err((StatusCode::CONFLICT, "stale_media".into()));
    }
    let reader = cache_read::ReadGuard::acquire(&app.db, id, attempt)
        .await
        .map_err(failure)?;
    let text = match resource {
        Resource::Master => Some(snapshot.master.clone()),
        Resource::Playlist(rung) => Some(
            snapshot
                .renditions
                .iter()
                .find(|r| r.0 == rung)
                .ok_or_else(|| failure("unplanned_rendition"))?
                .1
                .clone(),
        ),
        _ => None,
    };
    if let Some(text) = text {
        return Ok((
            [
                (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                (header::CACHE_CONTROL, "private, no-store"),
            ],
            if head { String::new() } else { text },
        )
            .into_response());
    }
    let (rung, index) = match resource {
        Resource::Init(rung) => (rung, -1),
        Resource::Segment(rung, n) if n < snapshot.segment_count as usize => (rung, n as i32),
        _ => return Err((StatusCode::NOT_FOUND, "unpublished_output_segment".into())),
    };
    if !snapshot.renditions.iter().any(|r| r.0 == rung) {
        return Err((StatusCode::NOT_FOUND, "unplanned_rendition".into()));
    }
    let proof = persistence::local_hls_ladder::file_proof(&app.db, id, attempt, rung, index)
        .await
        .map_err(failure)?;
    let path = persistence::media_jobs::output_dir(&app.cache, id, attempt).join(resource.path());
    let opened = app
        .output_checks
        .open(path.clone(), Some(proof))
        .await
        .map_err(failure)?;
    file_delivery::response(&path, headers, head, Some(reader), Some(opened), None).await
}

#[cfg(test)]
mod advanced_source_tests {
    use super::*;
    #[test]
    fn sdr10_extended_sources_construct_the_closed_advanced_ladder_without_tonemapping() {
        for (codec, profile) in [("hevc", "Main 10"), ("av1", "Main"), ("vp9", "Profile 2")] {
            let meta = json!({"format":{"start_time":"0","duration":"10"},"streams":[{"index":0,"codec_type":"video","codec_name":codec,"profile":profile,"pix_fmt":"yuv420p10le","width":1920,"height":1080,"sample_aspect_ratio":"1:1","color_primaries":"bt709","color_transfer":"bt709","color_space":"bt709","color_range":"tv","avg_frame_rate":"30/1","r_frame_rate":"30/1","disposition":{"attached_pic":0}},{"index":1,"codec_type":"audio","codec_name":"aac"}]});
            let request = Request::default();
            assert!(
                media_core::advanced_media::extended_source_proof(&meta["streams"][0])
                    .unwrap()
                    .is_some()
            );
            let recipe = LadderRecipe::from_advanced_probe(&meta, Some(1), 0.0, &request).unwrap();
            assert!(!recipe.tone_mapped());
            assert_eq!(recipe.renditions().len(), 3);
        }
    }
}
