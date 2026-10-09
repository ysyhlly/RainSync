//! The complete ordinary single-output execution flow under its caller's Scope.
//! Input custody and publication keep their original local drop boundaries;
//! common physical-drain settlement remains with the calling attempt.
use crate::{
    attempts, cache, child_process, execution_failure, input_failure, native_platform_transcode,
    output_decode, output_publish, owned_http, process, readiness, source_version, task_dispatch,
};
use aes_gcm::Aes256Gcm;
use persistence::media_jobs::Claim;
use sqlx::PgPool;
use std::{future::Future, path::Path, pin::Pin, time::Duration};
use tokio::sync::watch;

/// Borrowed service ports only. Constructing this view performs no work and
/// creates no attempt, lease, deadline, process scope or output authority.
pub(crate) struct Services<'a> {
    pub(crate) db: &'a PgPool,
    pub(crate) cache: &'a Path,
    pub(crate) cipher: &'a Aes256Gcm,
    pub(crate) readiness: &'a readiness::Runtime,
    pub(crate) input_failures: &'a input_failure::Registry,
}

/// Keep the large execution frame on the heap at construction. This is the
/// same serially awaited flow; no task or resource owner is introduced here.
pub(crate) fn run<'a>(
    services: Services<'a>,
    claim: &'a Claim,
    stop: &'a mut watch::Receiver<bool>,
    output_decoder: &'a output_decode::Gate,
    writer_stopped: &'a mut bool,
) -> Pin<Box<impl Future<Output = anyhow::Result<()>> + 'a>> {
    Box::pin(execute(
        services,
        claim,
        stop,
        output_decoder,
        writer_stopped,
    ))
}

async fn execute(
    services: Services<'_>,
    claim: &Claim,
    stop: &mut watch::Receiver<bool>,
    output_decoder: &output_decode::Gate,
    writer_stopped: &mut bool,
) -> anyhow::Result<()> {
    let output_builder: output_publish::Shared = Default::default();
    let input_failure = services.input_failures.register(claim.id);
    // Advanced preparation can own bounded metadata children in this
    // scope. Cancellation is drained before the execution receipt;
    // encoder supervision must finish explicit kill/wait before release.
    let prepare = async {
        let task = task_dispatch::SingleOutput::decode(claim)?;
        let native = task.is_native();
        cache::ensure_capacity_at(services.db, services.cache).await?;
        cache::reserve_output_at(services.db, services.cache, claim).await?;
        let spec = &claim.spec;
        source_version::verify(spec).await?;
        let mut local_input = None;
        let input = match task.input() {
            task_dispatch::Input::NativeTrack(key) => {
                native_platform_transcode::source_url(claim, key, input_failure.token())?
            }
            task_dispatch::Input::Ticket(ticket) => {
                let ticket = crate::decrypt_with_key(services.cipher, ticket)?;
                let token = ticket["token"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid_input_ticket"))?;
                format!(
                    "{}&execution={}",
                    crate::source_url(claim.id, token)?,
                    input_failure.token()
                )
            }
            task_dispatch::Input::Local { root, resource } => {
                let path = media_core::safe_local_path(std::path::Path::new(root), resource)?;
                let file = media_core::open_local_file(std::path::Path::new(root), resource)?;
                let input = media_core::local_process_input(&file, &path)?;
                local_input = Some(file);
                input
            }
        };
        let dir = persistence::media_jobs::output_dir(services.cache, claim.id, claim.attempt);
        child_process::blocking({
            let dir = dir.clone();
            move || std::fs::create_dir_all(dir)
        })
        .await?
        .map_err(cache::write_error)?;
        // Use one absolute attempt directory for argument construction
        // and child cwd. Relative CACHE_ROOT must not be joined twice,
        // and FFmpeg's default fMP4 init belongs to this owned output.
        let dir = std::path::absolute(dir).map_err(cache::write_error)?;
        let audio_index = task.audio_index()?;
        let advanced = if native {
            Some(
                native_platform_transcode::prepare(
                    services.db,
                    claim,
                    &dir.join("index.m3u8"),
                    input_failure.token(),
                )
                .await?,
            )
        } else {
            attempts::advanced::prepare_scoped(
                services.db,
                claim,
                &input,
                &dir.join("index.m3u8"),
                audio_index,
            )
            .await?
        };
        let mut args = if let Some(advanced) = &advanced {
            advanced.args.clone()
        } else if let Some(mode) = task.negotiated_mode() {
            media_core::capabilities::negotiated_hls_args(
                &input,
                dir.join("index.m3u8").to_str().unwrap(),
                task.start_seconds(),
                mode,
                audio_index,
            )
        } else {
            media_core::hls_args(
                &input,
                dir.join("index.m3u8").to_str().unwrap(),
                task.start_seconds(),
                task.transcode(),
                audio_index,
            )
        };
        if advanced.is_none() {
            owned_http::constrain_finite_job(services.db, claim, &mut args).await?;
            media_core::input_policy::constrain(
                &mut args,
                input.starts_with("http://"),
                spec["source_kind"] == "http",
            );
        }
        let decoder_input = args
            .iter()
            .position(|argument| argument == "-i")
            .and_then(|at| args.get(at + 1))
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("decoder_input_missing"))?;
        let confirmation = services
            .readiness
            .check_lease(process::finalization_deadline(
                Duration::from_secs(3),
                process::confirmed_deadline(persistence::media_jobs::renew_remaining(
                    services.db,
                    claim,
                )),
            ))
            .await;
        let confirmed_until = confirmation?
            .filter(|until| *until > tokio::time::Instant::now())
            .ok_or_else(|| anyhow::anyhow!("lease_lost_before_spawn"))?;
        Ok::<_, anyhow::Error>((
            args,
            confirmed_until,
            decoder_input,
            advanced,
            local_input,
            dir,
        ))
    };
    let prepared = tokio::select! {
        biased;
        _ = process::stopped(stop) => Err(anyhow::anyhow!("worker_shutdown")),
        result = prepare => result,
    };
    let mut execution_stopped = true;
    let mut diagnostic_failure = None;
    let mut result = async {
            let (args, confirmed_until, input, advanced, _local_input, directory) = prepared?;
            anyhow::ensure!(!*stop.borrow(), "worker_shutdown");
            let mut command = tokio::process::Command::new("ffmpeg");
    media_core::input_policy::clean_environment(&mut command);
            if claim.spec["kind"]==persistence::native_platform_transcode::KIND {native_platform_transcode::clean_native_environment(&mut command);}
            command.current_dir(directory).args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
            if let Some(advanced) = &advanced {
                advanced.install(&mut command)?;
                output_decoder.configure_advanced(advanced.recipe.clone()).await?;
            }
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            anyhow::ensure!(confirmed_until > tokio::time::Instant::now(), "lease_lost_before_spawn");
            let mut child = child_process::spawn(command)?;
            let diagnostics = child.stderr.take().expect("piped encoder diagnostics");
            *writer_stopped = false;
            execution_stopped = false;
            let supervised = process::supervise(&mut child, stop, confirmed_until, || async {
                services.readiness.check_lease(process::confirmed_deadline(persistence::media_jobs::renew_remaining(services.db, claim))).await
            }, async {
                tokio::select! {
                    error = attempts::advanced::monitor_scope(services.db, claim, advanced.as_ref()) => error,
                    error = cache::monitor_at(services.db, services.cache) => error,
                    error = output_publish::monitor(services.db, claim, persistence::media_jobs::output_dir(services.cache, claim.id, claim.attempt), output_builder.clone(), output_decoder) => error,
                }
            });
            let (result, evidence) = execution_failure::observe_with_input(supervised, diagnostics, &input).await;
            diagnostic_failure = evidence;
            execution_stopped = child.try_wait()?.is_some();
            *writer_stopped = execution_stopped;
            if result.as_ref().is_err_and(|error| error.is::<process::EncodingFailed>())
                && advanced.as_ref().is_some_and(|prepared| prepared.backend() != media_core::advanced_media::Backend::Software) {
                tracing::warn!(backend=?advanced.as_ref().unwrap().backend(), "hardware encoder failed; attempt remains fenced and is not rewritten with software");
            }
            if result.is_ok() && let Some(prepared) = &advanced {
                prepared.verify()?;
                process::finalization_deadline(Duration::from_secs(10), prepared.verify_remote()).await?;
            }
            result
        }.await;
    if result
        .as_ref()
        .is_err_and(|e| e.is::<process::LeaseInterrupted>())
    {
        // Reaped child; leave the fenced lease to expire and be retried by the queue.
        return result;
    }
    if !*stop.borrow() && execution_stopped {
        match process::finalization_deadline(
            Duration::from_secs(3),
            cache::check_output_capacity_at(services.cache),
        )
        .await
        {
            Ok(()) => {}
            Err(error) if result.is_ok() && error.is::<process::LeaseInterrupted>() => {
                return Err(error);
            }
            Err(error) => {
                if result.is_ok()
                    || error
                        .downcast_ref::<persistence::media_jobs::JobFailure>()
                        .is_some()
                {
                    result = Err(error);
                }
            }
        }
    }
    if execution_stopped
        && !*stop.borrow()
        && let Some(failure) = input_failure.failure()
        && result.as_ref().err().is_none_or(|error| {
            error
                .downcast_ref::<persistence::media_jobs::JobFailure>()
                .is_none()
        })
    {
        // A truncated input may make FFmpeg exit successfully. A known
        // source transport failure must not publish that partial movie.
        result = Err(failure.into());
    }
    if execution_stopped
        && !*stop.borrow()
        && result
            .as_ref()
            .is_err_and(|error| error.is::<process::EncodingFailed>())
        && let Some(evidence) = diagnostic_failure
    {
        // Stderr can refine a known encoder exit only. Independent
        // input, source, capacity, cancellation and ownership evidence
        // always keeps precedence; no retry is inferred from text.
        use persistence::media_jobs::JobFailure;
        result = Err(match evidence {
            execution_failure::Kind::InputInvalid => JobFailure::InputInvalid,
            execution_failure::Kind::DecoderUnavailable => JobFailure::DecoderUnavailable,
            execution_failure::Kind::EncoderUnavailable => JobFailure::EncoderUnavailable,
        }
        .into());
    }
    let mut publication = None;
    if result.is_ok() && !*stop.borrow() {
        let directory =
            persistence::media_jobs::output_dir(services.cache, claim.id, claim.attempt);
        result = match process::finalization_deadline(Duration::from_secs(10), async {
            let proof =
                output_publish::prepare(output_builder.clone(), directory, true, output_decoder)
                    .await?;
            source_version::verify(&claim.spec).await?;
            attempts::advanced::verify_scope(services.db, claim).await?;
            if claim.spec["kind"] == persistence::native_platform_transcode::KIND {
                native_platform_transcode::validate_completed(&claim.spec, &proof)?;
            }
            Ok(proof)
        })
        .await
        {
            Ok(proof) => {
                publication = Some(proof);
                Ok(())
            }
            Err(error) => Err(error),
        };
    }
    if result
        .as_ref()
        .is_err_and(|e| e.is::<process::LeaseInterrupted>())
    {
        return result;
    }
    if *stop.borrow() && execution_stopped {
        tokio::time::timeout(
            Duration::from_secs(3),
            persistence::media_jobs::release(services.db, claim),
        )
        .await??;
    } else if !*stop.borrow() {
        if let Some(snapshot) = publication.as_ref() {
            tokio::time::timeout(
                Duration::from_secs(3),
                persistence::media_outputs::publish(services.db, claim, snapshot, true),
            )
            .await??;
        } else {
            tokio::time::timeout(
                Duration::from_secs(3),
                persistence::media_jobs::finish(
                    services.db,
                    claim,
                    result.as_ref().err().map(|error| {
                        error
                            .downcast_ref::<persistence::media_jobs::JobFailure>()
                            .copied()
                            .unwrap_or(persistence::media_jobs::JobFailure::ExecutionFailed)
                    }),
                    None,
                ),
            )
            .await??;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_keeps_the_single_output_execution_frame_on_the_heap() {
        fn execution_size<F>(
            _: impl Fn(
                Services<'static>,
                &'static Claim,
                &'static mut watch::Receiver<bool>,
                &'static output_decode::Gate,
                &'static mut bool,
            ) -> F,
        ) -> usize {
            std::mem::size_of::<F>()
        }
        fn attempt_size<F>(
            _: impl Fn(&'static crate::App, uuid::Uuid, &'static mut watch::Receiver<bool>) -> F,
        ) -> usize {
            std::mem::size_of::<F>()
        }
        fn coordinator_size<F>(_: impl Fn(crate::App, watch::Receiver<bool>) -> F) -> usize {
            std::mem::size_of::<F>()
        }
        let entry_bytes = execution_size(run);
        let execution_bytes = execution_size(execute);
        let attempt_bytes = attempt_size(crate::run_next_job);
        let coordinator_bytes = coordinator_size(crate::scheduler::run);
        println!(
            "single-output entry: {entry_bytes} bytes; execution: {execution_bytes} bytes; attempt: {attempt_bytes} bytes; coordinator: {coordinator_bytes} bytes"
        );
        assert_eq!(entry_bytes, std::mem::size_of::<usize>());
        assert!(coordinator_bytes <= 16 * 1024);
    }
}
