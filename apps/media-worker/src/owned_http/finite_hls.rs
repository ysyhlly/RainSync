//! Finite source capture adapter for the original owned-HTTP representation.
//! Source inventory and physical normalized-byte identities remain separate.
use super::*;
use media_core::finite_hls::{self as finite, Container, TimestampMap};
use serde::Serialize;

#[derive(Serialize)]
struct ResourceIdentity {
    original_target_sha256: String,
    final_target_sha256: String,
    strong_etag: String,
    bytes: usize,
    sha256: String,
}
struct Resource {
    bytes: Vec<u8>,
    final_url: url::Url,
    identity: ResourceIdentity,
}
async fn guarded<T>(
    app: &App,
    id: Uuid,
    until: tokio::time::Instant,
    retired: &watch::Receiver<bool>,
    work: impl std::future::Future<Output = anyhow::Result<T>>,
) -> anyhow::Result<T> {
    tokio::pin!(work);
    loop {
        ensure!(
            !*retired.borrow() && tokio::time::Instant::now() < until,
            "finite_hls_original_deadline"
        );
        tokio::select! {
            biased;
            _=tokio::time::sleep_until(until)=>anyhow::bail!("finite_hls_original_deadline"),
            result=&mut work=>return result,
            _=tokio::time::sleep(Duration::from_millis(250))=>allowed(app,id).await?,
        }
    }
}
struct SourceRead<'a> {
    app: &'a App,
    id: Uuid,
    config: &'a providers::SourceConfig,
    until: tokio::time::Instant,
    retired: &'a watch::Receiver<bool>,
}
async fn get(
    context: &SourceRead<'_>,
    target: &str,
    maximum: usize,
    total: &mut usize,
) -> anyhow::Result<Resource> {
    let SourceRead {
        app,
        id,
        config,
        until,
        retired,
    } = *context;
    allowed(app, id).await?;
    let response = guarded(app, id, until, retired, async {
        Ok(
            providers::source_media_request(config, target, reqwest::Method::GET, &config.headers)
                .await?
                .header(header::ACCEPT_ENCODING, "identity")
                .send()
                .await?,
        )
    })
    .await?;
    ensure!(
        response.status() == StatusCode::OK
            && !response.headers().contains_key(header::CONTENT_RANGE),
        "finite_hls_complete_response_required"
    );
    let metadata = http_identity::Metadata::read(response.status(), response.headers())?;
    let etag = metadata
        .etag
        .clone()
        .filter(|v| http_identity::strong_etag(v))
        .ok_or_else(|| anyhow::anyhow!("finite_hls_strong_etag_required"))?;
    let expected = metadata
        .size
        .filter(|n| *n > 0 && *n <= maximum as u64)
        .ok_or_else(|| anyhow::anyhow!("finite_hls_known_length_required"))?;
    ensure!(
        *total + expected as usize <= finite::MAX_TOTAL_BYTES,
        "finite_hls_total_read_bound"
    );
    let final_url = response.url().clone();
    let mut bytes = Vec::with_capacity(expected as usize);
    let mut stream = metric_stream::wrap(
        response.bytes_stream(),
        &app.metrics,
        Layer::UpstreamRead,
        Cache::NotHit,
    );
    while let Some(chunk) =
        guarded(app, id, until, retired, async { Ok(stream.next().await) }).await?
    {
        let chunk = chunk?;
        ensure!(
            chunk.len() <= finite::MAX_RESOURCE_BYTES
                && bytes.len() + chunk.len() <= expected as usize,
            "finite_hls_resource_bound"
        );
        *total += chunk.len();
        ensure!(
            *total <= finite::MAX_TOTAL_BYTES,
            "finite_hls_total_read_bound"
        );
        bytes.extend_from_slice(&chunk);
    }
    ensure!(bytes.len() == expected as usize, "finite_hls_truncated");
    allowed(app, id).await?;
    let identity = ResourceIdentity {
        original_target_sha256: hash(target),
        final_target_sha256: hash(final_url.as_str()),
        strong_etag: etag,
        bytes: bytes.len(),
        sha256: hex::encode(Sha256::digest(&bytes)),
    };
    Ok(Resource {
        bytes,
        final_url,
        identity,
    })
}
fn target(base: &url::Url, reference: &str) -> anyhow::Result<String> {
    let target = base.join(reference)?;
    ensure!(
        matches!(target.scheme(), "http" | "https")
            && target.username().is_empty()
            && target.password().is_none()
            && target.fragment().is_none(),
        "finite_hls_target_invalid"
    );
    Ok(target.into())
}
fn append_inventory(
    inventory: &mut Vec<ResourceIdentity>,
    identity: ResourceIdentity,
) -> anyhow::Result<()> {
    ensure!(
        !inventory.iter().any(
            |i| i.original_target_sha256 == identity.original_target_sha256
                || i.final_target_sha256 == identity.final_target_sha256
        ),
        "finite_hls_source_alias"
    );
    inventory.push(identity);
    Ok(())
}
async fn write(
    app: &App,
    id: Uuid,
    slot: &FilesSlot,
    until: tokio::time::Instant,
    retired: &watch::Receiver<bool>,
    bytes: &[u8],
) -> anyhow::Result<()> {
    let root = app.cache.clone();
    let headroom = guarded(app, id, until, retired, async {
        child_process::blocking(move || cache::reservation_headroom(&root)).await?
    })
    .await?;
    ensure!(headroom >= bytes.len() as u64, "owned_http_cache_full");
    for part in bytes.chunks(65536) {
        let slot = slot.clone();
        let part = part.to_vec();
        guarded(app, id, until, retired, async {
            child_process::blocking(move || -> anyhow::Result<()> {
                let mut held = slot.lock().unwrap();
                held.as_mut()
                    .and_then(|f| f.file.as_mut())
                    .ok_or_else(|| anyhow::anyhow!("owned_http_writer_missing"))?
                    .write_all(&part)
                    .map_err(cache::write_error)?;
                Ok(())
            })
            .await?
        })
        .await?;
    }
    Ok(())
}

pub(super) async fn capture(
    app: &App,
    id: Uuid,
    resource: &Value,
    slot: FilesSlot,
    acquisition: Acquisition,
) -> anyhow::Result<Snapshot> {
    let Acquisition {
        began,
        until,
        retired,
        ..
    } = acquisition;
    ensure!(
        resource["http_finite_hls_version"] == 1
            && resource.get("http_owned_large_response_version").is_none(),
        "finite_hls_marker_invalid"
    );
    let acquisition_until = (began + CAPTURE_TIME).min(until);
    let target_url = resource["url"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("finite_hls_target_required"))?;
    let config = providers::resource_config(resource)?;
    let reads = SourceRead {
        app,
        id,
        config: &config,
        until: acquisition_until,
        retired: &retired,
    };
    let mut read_bytes = 0;
    let mut inventory = Vec::new();
    let root = get(
        &reads,
        target_url,
        finite::MAX_MANIFEST_BYTES,
        &mut read_bytes,
    )
    .await?;
    let text = std::str::from_utf8(&root.bytes)?;
    let selected = if text.lines().any(|l| l.starts_with("#EXT-X-STREAM-INF:")) {
        Some(finite::parse_master(text)?.selected()?.clone())
    } else {
        None
    };
    let mut media = root;
    if let Some(selection) = &selected {
        let selected_url = target(&media.final_url, &selection.uri)?;
        append_inventory(&mut inventory, media.identity)?;
        media = get(
            &reads,
            &selected_url,
            finite::MAX_MANIFEST_BYTES,
            &mut read_bytes,
        )
        .await?;
    }
    let playlist = finite::parse_media(std::str::from_utf8(&media.bytes)?)?;
    let base = media.final_url.clone();
    append_inventory(&mut inventory, media.identity)?;
    let mut fmp4 = None;
    let mut mapping = TimestampMap::default();
    let mut output_bytes = 0usize;
    let mut digest = Sha256::new();
    if playlist.container == Container::FragmentedMp4 {
        let init_url = target(&base, playlist.map.as_deref().expect("finite fmp4 map"))?;
        let init = get(&reads, &init_url, 2 * 1024 * 1024, &mut read_bytes).await?;
        fmp4 = Some(finite::Fmp4Normalizer::new(&playlist, &init.bytes)?);
        output_bytes += init.bytes.len();
        digest.update(&init.bytes);
        write(app, id, &slot, acquisition_until, &retired, &init.bytes).await?;
        append_inventory(&mut inventory, init.identity)?;
    }
    for segment in &playlist.segments {
        let url = target(&base, &segment.uri)?;
        let source = get(&reads, &url, finite::MAX_RESOURCE_BYTES, &mut read_bytes).await?;
        let normalized_bytes = if let Some(fmp4) = fmp4.as_mut() {
            fmp4.ingest(&source.bytes, segment.discontinuity)?
        } else {
            let decoded = guarded(
                app,
                id,
                acquisition_until,
                &retired,
                finite::decode_transport_stream(&source.bytes, segment.duration),
            )
            .await?;
            if let Some(selected) = &selected {
                ensure!(
                    decoded.width() == selected.width
                        && decoded.height() == selected.height
                        && decoded.frame_rate() == selected.frame_rate
                        && decoded.has_audio() == selected.has_audio,
                    "finite_hls_master_actual_mismatch"
                );
            }
            let normalized = finite::normalize_transport_stream(
                &source.bytes,
                &decoded,
                segment.discontinuity,
                &mut mapping,
            )?;
            let observed = guarded(
                app,
                id,
                acquisition_until,
                &retired,
                finite::decode_transport_stream(&normalized.bytes, segment.duration),
            )
            .await?;
            ensure!(
                observed.video_frames() == decoded.video_frames()
                    && observed.has_audio() == decoded.has_audio()
                    && observed.first_video_pts() == normalized.mapping.normalized_video_first_pts,
                "finite_hls_normalized_decode_mismatch"
            );
            normalized.bytes
        };
        append_inventory(&mut inventory, source.identity)?;
        output_bytes += normalized_bytes.len();
        ensure!(
            output_bytes <= finite::MAX_TOTAL_BYTES,
            "finite_hls_output_bound"
        );
        digest.update(&normalized_bytes);
        write(
            app,
            id,
            &slot,
            acquisition_until,
            &retired,
            &normalized_bytes,
        )
        .await?;
    }
    let original = slot.clone();
    let input = guarded(app, id, acquisition_until, &retired, async {
        child_process::blocking(move || -> anyhow::Result<Arc<OwnedLocalInput>> {
            let mut held = original.lock().unwrap();
            let files = held
                .as_mut()
                .ok_or_else(|| anyhow::anyhow!("owned_http_writer_missing"))?;
            files
                .file
                .as_mut()
                .unwrap()
                .sync_all()
                .map_err(cache::write_error)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&files.path, std::fs::Permissions::from_mode(0o400))?;
            }
            drop(files.file.take());
            let input = Arc::new(OwnedLocalInput::materialized_retained(
                std::fs::File::open(&files.path)?,
                files.path.clone(),
            )?);
            input.verify()?;
            files.source_version = Some(input.version().to_owned());
            Ok(input)
        })
        .await?
    })
    .await?;
    let sha256 = hex::encode(digest.finalize());
    let fmp4_proof = if let Some(fmp4) = &fmp4 {
        let observed = guarded(
            app,
            id,
            acquisition_until,
            &retired,
            finite::decode_fmp4_owned(&input),
        )
        .await?;
        let proof = fmp4.inspect_probe(&observed)?;
        let video = media_core::capabilities::validate_source(&observed)?;
        if let Some(selection) = &selected {
            ensure!(
                video["width"] == selection.width
                    && video["height"] == selection.height
                    && proof
                        .tracks
                        .iter()
                        .any(|t| t.kind == media_core::static_hls::timeline::TrackKind::Audio)
                        == selection.has_audio,
                "finite_hls_master_actual_mismatch"
            );
            let rate = video["avg_frame_rate"]
                .as_str()
                .and_then(|s| s.split_once('/'))
                .and_then(|(a, b)| Some(a.parse::<f64>().ok()? / b.parse::<f64>().ok()?));
            ensure!(
                rate == Some(selection.frame_rate),
                "finite_hls_master_actual_rate_mismatch"
            );
        }
        Some(proof)
    } else {
        None
    };
    let evidence = if let (Some(fmp4), Some(proof)) = (&fmp4, &fmp4_proof) {
        json!({"version":1,"scope":"finite_clear_fmp4_normalization_v1","source_inventory":inventory,"source_read_bytes":read_bytes,"media_sequence":playlist.sequence,"manifest_duration_ms":playlist.seconds*1000.0,"normalized_bytes":output_bytes,"normalized_sha256":sha256,"normalized_video_origin_ticks":0,"clock_scale":0,"segments":fmp4.mappings,"decoded_timeline":proof})
    } else {
        json!({"version":1,"scope":"finite_clear_ts_normalization_v1","source_inventory":inventory,"source_read_bytes":read_bytes,"media_sequence":playlist.sequence,"manifest_duration_ms":playlist.seconds*1000.0,"normalized_bytes":output_bytes,"normalized_sha256":sha256,"normalized_video_origin_ticks":90000,"clock_scale":90000,"segments":mapping.mappings})
    };
    ensure!(
        serde_json::to_vec(&evidence)?.len() <= 131072,
        "finite_hls_evidence_bound"
    );
    allowed(app, id).await?;
    Ok(Snapshot {
        input,
        bytes: output_bytes as u64,
        sha256,
        target_sha256: hash(target_url),
        until,
        acquisition_until,
        retired,
        finite_evidence: Some(evidence),
    })
}
