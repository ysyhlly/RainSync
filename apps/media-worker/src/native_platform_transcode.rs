//! Purpose-separated finite native Worker. No signed URL or platform credential
//! is decoded here; FFmpeg/ffprobe can open only the owned loopback ingress.
use super::*;
use anyhow::{Result as AnyResult, ensure};
use media_core::advanced_media::{
    EncoderSelection, Input, Inventory, Recipe, Request, WorkerGatewayInput,
};
use persistence::{
    media_jobs::Claim,
    native_platform_transcode::{self as durable, Spec},
};
use std::{path::Path as FsPath, sync::Arc, time::Duration};

use media_core::finite_delivery as owned;
fn deliveries() -> Arc<owned::Registry> {
    static REGISTRY: std::sync::OnceLock<Arc<owned::Registry>> = std::sync::OnceLock::new();
    REGISTRY
        .get_or_init(|| Arc::new(Default::default()))
        .clone()
}
pub(crate) fn close_admission() {
    deliveries().close_admission();
}
pub(crate) async fn drain() -> anyhow::Result<()> {
    deliveries().drain().await
}
fn ingress_slot() -> Result<tokio::sync::OwnedSemaphorePermit> {
    static SLOTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "native_platform_input_busy".into(),
            )
        })
}
pub(crate) fn clean_native_environment(command: &mut tokio::process::Command) {
    media_core::input_policy::clean_environment(command);
    // The trusted decoder has only the opaque loopback capability. It does not
    // inherit database or encryption credentials used by the Worker service.
    for key in [
        "DATABASE_URL",
        "SOURCE_ENCRYPTION_KEY",
        "ADMIN_PASSWORD",
        "SERVER_INTERNAL_URL",
    ] {
        command.env_remove(key);
    }
}
pub fn source_url(claim: &Claim, key: &str, execution: Uuid) -> AnyResult<String> {
    let spec = durable::validate_input_spec(&claim.spec)?;
    let track = spec
        .tracks
        .iter()
        .find(|t| t.key == key)
        .ok_or_else(|| anyhow::anyhow!("native_platform_track_invalid"))?;
    let mut bind = std::env::var("WORKER_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8081".into())
        .parse::<std::net::SocketAddr>()?;
    // Decoder custody is always loopback even if the HTTP service is exposed.
    if bind.ip().is_unspecified() {
        bind.set_ip(if bind.is_ipv6() {
            std::net::Ipv6Addr::LOCALHOST.into()
        } else {
            std::net::Ipv4Addr::LOCALHOST.into()
        });
    }
    ensure!(
        bind.ip().is_loopback(),
        "native_platform_loopback_listener_required"
    );
    let url = format!(
        "http://{bind}/native-platform-input/{}/{}?ticket={}&owner={}&attempt={}&execution={execution}",
        claim.id, key, track.ticket, claim.owner, claim.attempt
    );
    WorkerGatewayInput::native_platform(&url)?;
    Ok(url)
}
async fn probe(
    input: &str,
    container: media_core::advanced_media::PrivateInputContainer,
) -> AnyResult<Value> {
    WorkerGatewayInput::native_platform(input)?;
    let mut command = tokio::process::Command::new("ffprobe");
    clean_native_environment(&mut command);
    command.args([
        "-v",
        "error",
        "-protocol_whitelist",
        "http,tcp",
        "-format_whitelist",
        container.demuxer(),
        "-f",
        container.demuxer(),
    ]);
    if container.is_mp4() {
        command.args(["-enable_drefs", "0", "-use_absolute_path", "0"]);
    }
    command.args(["-show_format", "-show_streams", "-of", "json", "-i", input]);
    let (status, bytes) =
        child_process::capture(command, Duration::from_secs(20), 2 * 1024 * 1024).await?;
    ensure!(status.success(), "native_platform_source_probe_failed");
    Ok(serde_json::from_slice(&bytes)?)
}
fn checked_metadata(meta: &Value, spec: &Spec, kind: &str) -> AnyResult<Vec<Value>> {
    let streams = meta["streams"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("native_platform_source_probe_invalid"))?;
    ensure!(streams.len() <= 8, "native_platform_source_probe_invalid");
    let duration = meta["format"]["duration"]
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .or_else(|| meta["format"]["duration"].as_f64())
        .ok_or_else(|| anyhow::anyhow!("native_platform_timeline_required"))?;
    let origin = meta["format"]["start_time"]
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .or_else(|| meta["format"]["start_time"].as_f64())
        .ok_or_else(|| anyhow::anyhow!("native_platform_origin_required"))?;
    ensure!(
        duration.is_finite()
            && (duration - spec.duration_seconds).abs() <= 2.0
            && origin.is_finite()
            && origin.abs() <= 0.250,
        "native_platform_timeline_changed"
    );
    ensure!(
        streams
            .iter()
            .all(|s| matches!(s["codec_type"].as_str(), Some("video" | "audio"))),
        "native_platform_extra_stream_unsupported"
    );
    for s in streams {
        ensure!(
            !matches!(s["codec_tag_string"].as_str(), Some("encv" | "enca"))
                && !s["side_data_list"]
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|row| row["side_data_type"]
                        .as_str()
                        .is_some_and(|v| v.contains("Encryption")))),
            "native_platform_protected_source_unsupported"
        );
    }
    let selected = streams
        .iter()
        .filter(|s| matches!(s["codec_type"].as_str(), Some("video" | "audio")))
        .cloned()
        .collect::<Vec<_>>();
    ensure!(
        selected
            .iter()
            .filter(|s| s["codec_type"] == "video")
            .count()
            == usize::from(kind != "audio")
            && selected
                .iter()
                .filter(|s| s["codec_type"] == "audio")
                .count()
                == usize::from(kind != "video"),
        "native_platform_track_shape_changed"
    );
    for s in &selected {
        if spec.source_webm.is_some() && s["codec_type"] == "audio" {
            let rate = s["sample_rate"]
                .as_u64()
                .or_else(|| s["sample_rate"].as_str()?.parse().ok());
            ensure!(
                s["codec_name"] == "aac"
                    && s["profile"] == "LC"
                    && rate.is_some_and(|n| (8000..=96000).contains(&n))
                    && s["channels"].as_u64().is_some_and(|n| (1..=2).contains(&n)),
                "native_platform_webm_aac_pair_required"
            );
        }
        if s["codec_type"] == "video"
            && let Some(expected) = &spec.source_video
        {
            expected.verify_probe(s)?;
        }
        if s["codec_type"] == "video"
            && let Some(expected) = &spec.source_webm
        {
            expected.verify_probe(s)?;
        }
        if matches!(s["codec_name"].as_str(), Some("hevc" | "av1" | "vp9")) {
            media_core::advanced_media::VideoSourceProof::from_stream(s)?;
        }
        if s["codec_name"] == "hevc" {
            ensure!(
                s["sample_aspect_ratio"] == "1:1"
                    && ((s["profile"] == "Main" && s["pix_fmt"] == "yuv420p")
                        || (s["profile"] == "Main 10" && s["pix_fmt"] == "yuv420p10le"))
                    && s["field_order"] == "progressive",
                "native_platform_hevc_probe_subset_required"
            );
        }
        ensure!(
            s["disposition"]["attached_pic"] != 1,
            "native_platform_track_shape_changed"
        );
        ensure!(
            match s["codec_type"].as_str() {
                Some("video") => matches!(
                    s["codec_name"].as_str(),
                    Some("h264" | "hevc" | "av1" | "vp9")
                ),
                Some("audio") => matches!(s["codec_name"].as_str(), Some("aac" | "opus" | "mp3")),
                _ => false,
            },
            "native_platform_codec_unsupported"
        );
        ensure!(
            !s["side_data_list"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v["side_data_type"]
                    .as_str()
                    .is_some_and(|t| t.contains("DOVI") || t.contains("Encryption")))),
            "native_platform_protected_or_dynamic_hdr_unsupported"
        );
    }
    Ok(selected)
}
pub(crate) async fn source_metadata(
    claim: &Claim,
    execution: Uuid,
) -> AnyResult<(Value, String, Option<String>, Spec)> {
    let spec = durable::validate_input_spec(&claim.spec)?;
    let input = source_url(claim, &spec.tracks[0].key, execution)?;
    let first = probe(&input, spec.tracks[0].container).await?;
    let mut streams = checked_metadata(&first, &spec, &spec.tracks[0].key)?;
    let second = if spec.tracks.len() == 2 {
        let audio = source_url(claim, "audio", execution)?;
        let meta = probe(&audio, spec.tracks[1].container).await?;
        streams.extend(checked_metadata(&meta, &spec, "audio")?);
        Some(audio)
    } else {
        None
    };
    // Require fixed stream ordinals, then map only the source-backed selected
    // tracks. No subtitle/attachment/external data reference is admitted.
    for (i, s) in streams.iter_mut().enumerate() {
        ensure!(
            s["index"].as_u64() == Some(if second.is_some() { 0 } else { i as u64 }),
            "native_platform_track_ordinal_unsupported"
        );
        s["index"] = json!(i);
    }
    ensure!(
        streams[0]["codec_type"] == "video" && streams[1]["codec_type"] == "audio",
        "native_platform_track_order_unsupported"
    );
    let meta =
        json!({"streams":streams,"format":{"duration":spec.duration_seconds,"start_time":0.0}});
    Ok((meta, input, second, spec))
}
async fn prepare_inner(
    claim: &Claim,
    output: &FsPath,
    execution: Uuid,
) -> AnyResult<advanced_media::Prepared> {
    let (meta, input, second, spec) = source_metadata(claim, execution).await?;
    let hdr = media_core::advanced_media::classify_hdr(&meta["streams"][0])?.is_some();
    let request = Request {
        schema_version: 1,
        tone_map_hdr: hdr,
        subtitle_stream_index: None,
    };
    let recipe = Arc::new(Recipe::from_probe(
        &meta,
        Some(1),
        spec.start_seconds,
        &request,
        EncoderSelection::software_recipe(),
    )?);
    ensure!(recipe.has_audio(), "native_platform_audio_required");
    let inventory = Inventory::inspect().await?;
    let args = constrained_args(
        &recipe,
        &spec,
        &input,
        second.as_deref(),
        output,
        &inventory,
    )?;
    Ok(advanced_media::Prepared::native_gateway(args, recipe))
}
fn constrained_args(
    recipe: &Recipe,
    spec: &Spec,
    input: &str,
    second: Option<&str>,
    output: &FsPath,
    inventory: &Inventory,
) -> AnyResult<Vec<String>> {
    let gateway = WorkerGatewayInput::native_platform(input)?;
    let args = recipe.ffmpeg_args(Input::WorkerGateway(&gateway), output, inventory, false)?;
    constrain_input_args(args, spec, second)
}
pub(crate) fn constrain_input_args(
    mut args: Vec<String>,
    spec: &Spec,
    second: Option<&str>,
) -> AnyResult<Vec<String>> {
    ensure!(
        second.is_some() == (spec.tracks.len() == 2),
        "native_platform_track_arity_invalid"
    );
    if let Some(second) = second {
        WorkerGatewayInput::native_platform(second)?;
    }
    // Restrict the native input to the finite MP4 demuxer with external data
    // references disabled. The generic advanced input policy stays unchanged.
    for v in &mut args {
        if v == "http,tcp,crypto" {
            *v = "http,tcp".into();
        }
    }
    let at = args
        .iter()
        .position(|v| v == "-i")
        .ok_or_else(|| anyhow::anyhow!("native_platform_input_missing"))?;
    // The container is sealed in the input spec. No auto-demuxer, chained
    // playlist, network references or caller-controlled format is admitted.
    let container = spec.tracks[0].container;
    for i in 0..at {
        if args[i] == "-format_whitelist" && i + 1 < at {
            args[i + 1] = container.demuxer().into();
        }
    }
    let mut first_args = vec!["-f".into(), container.demuxer().into()];
    if container.is_mp4() {
        first_args.extend(["-enable_drefs", "0", "-use_absolute_path", "0"].map(String::from));
    }
    args.splice(at..at, first_args);
    if let Some(second) = second {
        let at = args.iter().position(|v| v == "-i").unwrap() + 2;
        let mut second_args = Vec::new();
        if spec.start_seconds > 0.0 {
            second_args.extend(["-ss".into(), spec.start_seconds.to_string()]);
        }
        second_args.extend(
            [
                "-protocol_whitelist",
                "http,tcp",
                "-format_whitelist",
                "mov",
                "-f",
                "mov",
                "-enable_drefs",
                "0",
                "-use_absolute_path",
                "0",
                "-i",
            ]
            .map(String::from),
        );
        second_args.push(second.to_owned());
        args.splice(at..at, second_args);
        for value in &mut args {
            if value == "0:1" {
                *value = "1:0".into();
            }
        }
    }
    // Duration is bounded by original finite metadata and position, independent
    // of a decoder observing a malformed input that tries to run forever.
    let output_positions = args
        .iter()
        .enumerate()
        .filter(|(_, v)| v.ends_with("/index.m3u8"))
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    ensure!(
        !output_positions.is_empty(),
        "native_platform_output_missing"
    );
    for end in output_positions.into_iter().rev() {
        args.splice(
            end..end,
            [
                "-t".into(),
                (spec.duration_seconds - spec.start_seconds).to_string(),
            ],
        );
    }
    Ok(args)
}
/// Metadata/probe children are scoped by the queue owner. Renew the same lease
/// during preparation without ever reviving a deadline that already elapsed.
pub async fn prepare(
    app: &App,
    claim: &Claim,
    output: &FsPath,
    execution: Uuid,
) -> AnyResult<advanced_media::Prepared> {
    let mut until = process::finalization_deadline(
        Duration::from_secs(3),
        process::confirmed_deadline(persistence::media_jobs::renew_remaining(&app.db, claim)),
    )
    .await?
    .ok_or_else(|| anyhow::Error::new(process::LeaseInterrupted))?;
    let work = prepare_inner(claim, output, execution);
    tokio::pin!(work);
    let mut next = tokio::time::Instant::now() + Duration::from_secs(4);
    loop {
        tokio::select! {biased;_=tokio::time::sleep_until(until)=>return Err(process::LeaseInterrupted.into()),result=&mut work=>return result,
            _=tokio::time::sleep_until(next)=>{
                let renewal=tokio::select!{biased;_=tokio::time::sleep_until(until)=>return Err(process::LeaseInterrupted.into()),r=tokio::time::timeout(Duration::from_secs(3),process::confirmed_deadline(persistence::media_jobs::renew_remaining(&app.db,claim)))=>r};
                if tokio::time::Instant::now()>=until{return Err(process::LeaseInterrupted.into());}
                match renewal {Ok(Ok(Some(confirmed))) if confirmed>tokio::time::Instant::now()=>{until=confirmed;next=tokio::time::Instant::now()+Duration::from_secs(4)},Ok(Ok(_))=>return Err(process::LeaseInterrupted.into()),_=>next=tokio::time::Instant::now()+Duration::from_secs(1)}
            }
        }
    }
}
#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputQuery {
    ticket: String,
    owner: Uuid,
    attempt: i64,
    execution: Uuid,
}
async fn caller(
    app: &App,
    id: Uuid,
    ticket: &str,
    key: Option<&str>,
    attempt: i64,
    owner: Option<Uuid>,
) -> Result<String> {
    if !durable::ticket_valid(ticket) || attempt <= 0 {
        return Err((StatusCode::UNAUTHORIZED, "invalid_playback_session".into()));
    }
    let row=sqlx::query("SELECT j.spec,p.delivery_token_hash FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id WHERE j.id=$1 AND j.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1') AND j.attempt=$2 AND native_platform_transcode_session_allowed(p.id) AND (($3::uuid IS NULL AND (j.status='succeeded' OR (j.status='running' AND j.lease_until>clock_timestamp()))) OR (j.owner_id=$3 AND j.status='running' AND j.lease_until>clock_timestamp()))")
        .bind(id).bind(attempt).bind(owner).fetch_optional(&app.db).await.map_err(failure)?.ok_or((StatusCode::UNAUTHORIZED,"invalid_playback_session".into()))?;
    let spec = durable::validate_input_spec(&row.get("spec")).map_err(failure)?;
    let expected = if let Some(key) = key {
        spec.tracks
            .iter()
            .find(|t| t.key == key)
            .map(|t| t.ticket.as_str())
    } else {
        Some(spec.output_ticket.as_str())
    };
    if !expected.is_some_and(|v| hash(v) == hash(ticket)) {
        return Err((StatusCode::UNAUTHORIZED, "invalid_playback_session".into()));
    }
    Ok(row.get("delivery_token_hash"))
}
async fn delivery_evidence(
    app: &App,
    id: Uuid,
    ticket: &str,
    key: Option<&str>,
    attempt: i64,
    owner: Option<Uuid>,
) -> Result<owned::Evidence> {
    let token = caller(app, id, ticket, key, attempt, owner).await?;
    let row=sqlx::query("SELECT EXTRACT(epoch FROM(LEAST(p.expires_at,to_timestamp(n.deadline_ms::double precision/1000))-clock_timestamp()))::float8 AS grant_remaining,EXTRACT(epoch FROM(LEAST(CASE WHEN j.status='succeeded' THEN p.expires_at ELSE j.lease_until END,p.expires_at,to_timestamp(n.deadline_ms::double precision/1000))-clock_timestamp()))::float8 AS lease_remaining FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id JOIN native_platform_transcodes n ON n.session_id=p.id WHERE j.id=$1 AND j.attempt=$2 AND p.delivery_token_hash=$3 AND native_platform_transcode_session_allowed(p.id) AND (($4::uuid IS NULL AND (j.status='succeeded' OR (j.status='running' AND j.lease_until>clock_timestamp())) AND EXISTS(SELECT 1 FROM media_outputs o WHERE o.job_id=j.id AND o.attempt=j.attempt AND o.owner_id=j.owner_id AND o.validation_version=CASE WHEN j.logical_queue='native_platform_hls_ladder_v1' THEN 5 ELSE 3 END AND o.ready_segments>0 AND ((j.status='running' AND o.status='writing') OR (j.status='succeeded' AND o.status='published')))) OR (j.owner_id=$4 AND j.status='running' AND j.lease_until>clock_timestamp()))")
        .bind(id).bind(attempt).bind(token).bind(owner).fetch_optional(&app.db).await.map_err(failure)?.ok_or_else(||failure("native_platform_delivery_ended"))?;
    let grant: f64 = row.get("grant_remaining");
    let lease: f64 = row.get("lease_remaining");
    if !grant.is_finite() || !lease.is_finite() || grant <= 0.0 || lease <= 0.0 {
        return Err(failure("native_platform_delivery_ended"));
    }
    Ok(owned::Evidence {
        grant_remaining: Duration::try_from_secs_f64(grant).map_err(failure)?,
        lease_remaining: Duration::try_from_secs_f64(lease).map_err(failure)?,
    })
}
pub async fn input(
    State(app): State<App>,
    Path((id, key)): Path<(Uuid, String)>,
    Query(q): Query<InputQuery>,
    h: HeaderMap,
    method: axum::http::Method,
) -> Result<Response> {
    if !durable::ticket_valid(&q.ticket)
        || q.attempt <= 0
        || !matches!(key.as_str(), "progressive" | "video" | "audio")
    {
        return Err(failure("native_platform_delivery_ended"));
    }
    let inspected = app.clone();
    let query = q.clone();
    let track = key.clone();
    let check: owned::Checker = Arc::new(move || {
        let app = inspected.clone();
        let q = query.clone();
        let key = track.clone();
        Box::pin(async move {
            delivery_evidence(&app, id, &q.ticket, Some(&key), q.attempt, Some(q.owner))
                .await
                .map_err(|_| anyhow::anyhow!("native_platform_delivery_ended"))
        })
    });
    owned::serve(
        deliveries(),
        check,
        move || input_response(State(app), Path((id, key)), Query(q), h, method),
        Arc::new(|| failure("native_platform_delivery_ended")),
    )
    .await
}
async fn input_response(
    State(app): State<App>,
    Path((id, key)): Path<(Uuid, String)>,
    Query(q): Query<InputQuery>,
    h: HeaderMap,
    method: axum::http::Method,
) -> Result<Response> {
    let slot = ingress_slot()?;
    let token = caller(&app, id, &q.ticket, Some(&key), q.attempt, Some(q.owner)).await?;
    let row: Value = sqlx::query_scalar(
        "SELECT spec FROM media_jobs WHERE id=$1 AND logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1')",
    )
    .bind(id)
    .fetch_one(&app.db)
    .await
    .map_err(failure)?;
    let spec = durable::validate_input_spec(&row).map_err(failure)?;
    let total = spec
        .tracks
        .iter()
        .find(|t| t.key == key)
        .ok_or_else(|| failure("native_platform_track_invalid"))?
        .total_bytes;
    if h.get_all(header::RANGE).iter().count() > 1 {
        return Err(failure("native_platform_range_invalid"));
    }
    let raw = h
        .get(header::RANGE)
        .map(|v| v.to_str().map_err(failure))
        .transpose()?;
    let (start, end) = durable::requested_range(raw, total).map_err(failure)?;
    let partial = raw.is_some();
    let pool = app.db.clone();
    let registry = app.deliveries.clone();
    let cancelled = app.input_failures.observe(id, Some(q.execution));
    let observed = cancelled.clone();
    let attempt = q.attempt;
    let owner = q.owner;
    playback_access::protect_native_platform(
        move |_| async move {
            let body = if method == axum::http::Method::HEAD {
                Body::empty()
            } else {
                // The decoder sees a full finite representation, while every
                // Server operation remains an independently bounded 8MiB range.
                // This works with HTTP readers that don't implement request_size.
                let input = futures_util::stream::try_unfold(
                    (app.clone(), q, key, start, slot, observed),
                    move |(app, q, key, position, slot, observed)| async move {
                        if position > end {
                            return Ok::<_, std::io::Error>(None);
                        }
                        let stop = end.min(position.saturating_add(durable::MAX_RANGE_BYTES - 1));
                        let base = std::env::var("SERVER_INTERNAL_URL")
                            .unwrap_or_else(|_| "http://127.0.0.1:8080".into());
                        let response = app
                            .client
                            .get(format!(
                                "{}/api/v1/internal/native-platform-input/{id}/{key}",
                                base.trim_end_matches('/')
                            ))
                            .query(&[
                                ("ticket", q.ticket.clone()),
                                ("owner", q.owner.to_string()),
                                ("attempt", q.attempt.to_string()),
                            ])
                            .header(header::RANGE, format!("bytes={position}-{stop}"))
                            .timeout(Duration::from_secs(10))
                            .send()
                            .await
                            .map_err(|error| {
                                observed.network(&error);
                                std::io::Error::other("native_platform_input_ended")
                            })?;
                        if !response.status().is_success() {
                            if response.status() == StatusCode::CONFLICT {
                                observed.source_changed();
                            } else {
                                observed.status(response.status());
                            }
                            return Err(std::io::Error::other("native_platform_input_ended"));
                        }
                        if response.status() != StatusCode::PARTIAL_CONTENT
                            || response
                                .headers()
                                .get(header::CONTENT_RANGE)
                                .and_then(|v| v.to_str().ok())
                                != Some(format!("bytes {position}-{stop}/{total}").as_str())
                            || response.content_length() != Some(stop - position + 1)
                        {
                            observed.source_changed();
                            return Err(std::io::Error::other("native_platform_input_changed"));
                        }
                        let mut bytes = Vec::with_capacity((stop - position + 1) as usize);
                        let mut stream = response.bytes_stream();
                        while let Some(chunk) = stream.next().await {
                            let chunk = chunk.map_err(|error| {
                                observed.network(&error);
                                std::io::Error::other("native_platform_input_ended")
                            })?;
                            if bytes.len() as u64 + chunk.len() as u64 > stop - position + 1 {
                                return Err(std::io::Error::other("native_platform_input_bound"));
                            }
                            bytes.extend_from_slice(&chunk);
                        }
                        if bytes.len() as u64 != stop - position + 1 {
                            return Err(std::io::Error::other("native_platform_input_truncated"));
                        }
                        Ok(Some((
                            axum::body::Bytes::from(bytes),
                            (app, q, key, stop + 1, slot, observed),
                        )))
                    },
                );
                Body::from_stream(input)
            };
            let mut out = Response::new(body);
            *out.status_mut() = if partial {
                StatusCode::PARTIAL_CONTENT
            } else {
                StatusCode::OK
            };
            out.headers_mut().insert(
                header::CONTENT_LENGTH,
                (end - start + 1).to_string().parse().unwrap(),
            );
            out.headers_mut()
                .insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
            out.headers_mut()
                .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
            out.headers_mut()
                .insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
            if partial {
                out.headers_mut().insert(
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{total}").parse().unwrap(),
                );
            }
            Ok(out)
        },
        pool,
        id,
        token,
        registry,
        cancelled,
        attempt,
        Some(owner),
    )
    .await
}
#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputQuery {
    ticket: String,
    attempt: Option<i64>,
}
pub async fn output(
    State(app): State<App>,
    Path((id, path)): Path<(Uuid, String)>,
    Query(q): Query<OutputQuery>,
    h: HeaderMap,
    method: axum::http::Method,
) -> Result<Response> {
    if !durable::ticket_valid(&q.ticket) || !q.attempt.is_some_and(|a| a > 0) {
        return Err(failure("native_platform_delivery_ended"));
    }
    let inspected = app.clone();
    let query = q.clone();
    let check: owned::Checker = Arc::new(move || {
        let app = inspected.clone();
        let q = query.clone();
        Box::pin(async move {
            let attempt = q
                .attempt
                .ok_or_else(|| anyhow::anyhow!("native_platform_delivery_ended"))?;
            delivery_evidence(&app, id, &q.ticket, None, attempt, None)
                .await
                .map_err(|_| anyhow::anyhow!("native_platform_delivery_ended"))
        })
    });
    owned::serve(
        deliveries(),
        check,
        move || output_response(State(app), Path((id, path)), Query(q), h, method),
        Arc::new(|| failure("native_platform_delivery_ended")),
    )
    .await
}
async fn output_response(
    State(app): State<App>,
    Path((id, path)): Path<(Uuid, String)>,
    Query(q): Query<OutputQuery>,
    h: HeaderMap,
    method: axum::http::Method,
) -> Result<Response> {
    let attempt = if let Some(a) = q.attempt {
        a
    } else {
        sqlx::query_scalar("SELECT attempt FROM media_jobs WHERE id=$1 AND logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1')").bind(id).fetch_optional(&app.db).await.map_err(failure)?.ok_or((StatusCode::NOT_FOUND,"media_not_found".into()))?
    };
    let token = caller(&app, id, &q.ticket, None, attempt, None).await?;
    let ladder:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_jobs WHERE id=$1 AND logical_queue='native_platform_hls_ladder_v1')").bind(id).fetch_one(&app.db).await.map_err(failure)?;
    if ladder {
        let pool = app.db.clone();
        let registry = app.deliveries.clone();
        let cancelled = app.input_failures.observe(id, None);
        return playback_access::protect_native_platform(
            move |_| async move {
                super::native_platform_ladder::output_response(
                    &app,
                    id,
                    attempt,
                    &path,
                    &h,
                    method == axum::http::Method::HEAD,
                )
                .await
            },
            pool,
            id,
            token,
            registry,
            cancelled,
            attempt,
            None,
        )
        .await;
    }

    let pool = app.db.clone();
    let registry = app.deliveries.clone();
    let cancelled = app.input_failures.observe(id, None);
    playback_access::protect_native_platform(move |_|async move {
        let row=sqlx::query("SELECT j.status,(j.lease_until>clock_timestamp()) AS leased,o.status AS output_status,o.visible_manifest,o.manifest_sha256,o.ready_segments,o.validation_version FROM media_jobs j JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt AND o.owner_id=j.owner_id WHERE j.id=$1 AND j.attempt=$2 AND j.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1') AND native_platform_transcode_session_allowed(j.session_id)").bind(id).bind(attempt).fetch_optional(&app.db).await.map_err(failure)?.ok_or((StatusCode::SERVICE_UNAVAILABLE,"media_job_pending".into()))?;
        let text:Option<String>=row.get("visible_manifest");let Some(text)=text else{return Ok((StatusCode::ACCEPTED,"media_job_pending").into_response());};
        let status:String=row.get("status");
        ensure_output_status(&status,row.get("leased"),row.get("output_status")).map_err(failure)?;
        if row.get::<i32,_>("validation_version")!=3 || row.get::<i32,_>("ready_segments")<=0 || row.get::<Option<String>,_>("manifest_sha256").as_deref()!=Some(hash(&text).as_str()){return Err(failure("invalid_output_proof"));}
        let reader=cache_read::ReadGuard::acquire(&app.db,id,attempt).await.map_err(failure)?;
        if path=="index.m3u8"{return Ok(([(header::CONTENT_TYPE,"application/vnd.apple.mpegurl"),(header::CACHE_CONTROL,"private, no-store")],if method==axum::http::Method::HEAD{String::new()}else{text}).into_response());}
        let index=if path=="init.mp4"{-1}else {path.strip_prefix("index").and_then(|p|p.strip_suffix(".m4s")).and_then(|n|n.parse::<i32>().ok()).filter(|n|*n>=0 && path==format!("index{n}.m4s") && text.lines().any(|l|l==path)).ok_or((StatusCode::NOT_FOUND,"unpublished_output_segment".into()))?};
        let row=sqlx::query("SELECT size_bytes,sha256 FROM media_output_files WHERE job_id=$1 AND attempt=$2 AND segment_index=$3").bind(id).bind(attempt).bind(index).fetch_one(&app.db).await.map_err(failure)?;
        let proof=persistence::media_outputs::FileProof{index,size_bytes:row.get("size_bytes"),sha256:row.get("sha256")};
        let file=persistence::media_jobs::output_dir(&app.cache,id,attempt).join(path);let opened=app.output_checks.open(file.clone(),Some(proof)).await.map_err(failure)?;
        file_delivery::response(&file,&h,method==axum::http::Method::HEAD,Some(reader),Some(opened),None).await
    },pool,id,token,registry,cancelled,attempt,None).await
}
/// A successful encoder/decode result cannot turn early input EOF into a
/// completed movie. Final duration remains tied to the original finite grant.
pub(crate) fn validate_completed(
    spec: &Value,
    snapshot: &persistence::media_outputs::Snapshot,
) -> AnyResult<()> {
    let spec = durable::validate_spec(spec)?;
    let mut seconds = 0.0;
    let mut count = 0;
    for line in snapshot.manifest.lines() {
        if let Some(raw) = line
            .strip_prefix("#EXTINF:")
            .and_then(|v| v.split(',').next())
        {
            let n = raw.parse::<f64>()?;
            ensure!(
                n.is_finite() && n > 0.0 && n <= 30.0,
                "native_platform_output_duration_invalid"
            );
            seconds += n;
            count += 1;
        }
    }
    let expected = spec.duration_seconds - spec.start_seconds;
    ensure!(
        snapshot.manifest.ends_with("#EXT-X-ENDLIST\n")
            && count == snapshot.segment_count
            && seconds.is_finite()
            && seconds > 0.0
            && seconds >= expected - 2.0
            && seconds <= expected + 0.250,
        "native_platform_output_incomplete"
    );
    Ok(())
}
fn ensure_output_status(
    status: &str,
    leased: Option<bool>,
    output_status: String,
) -> AnyResult<()> {
    ensure!(
        (status == "running" && leased == Some(true) && output_status == "writing")
            || (status == "succeeded" && output_status == "published"),
        "native_platform_output_not_current"
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_probe_metadata_requires_exact_finite_tracks() {
        let s:Spec=serde_json::from_value(json!({"kind":durable::KIND,"recipe_version":1,"source_kind":"native_platform_private","negotiated_mode":"transcode","tracks":[{"key":"progressive","ticket":"a".repeat(64),"total_bytes":100,"strong_etag":"\"e\""}],"output_ticket":"b".repeat(64),"duration_seconds":10.0,"start_seconds":0.0,"deadline_ms":1,"estimated_output_bytes":100})).unwrap();
        let mut m = json!({"format":{"duration":"10.0","start_time":"0.0"},"streams":[{"index":0,"codec_type":"video","codec_name":"h264"},{"index":1,"codec_type":"audio","codec_name":"aac"}]});
        assert!(checked_metadata(&m, &s, "progressive").is_ok());
        m["format"]["duration"] = json!("13");
        assert!(checked_metadata(&m, &s, "progressive").is_err());
    }
    #[test]
    fn output_lifecycle_requires_current_writer_or_committed_publication() {
        assert!(ensure_output_status("running", Some(true), "writing".into()).is_ok());
        assert!(ensure_output_status("succeeded", None, "published".into()).is_ok());
        for (state, lease, out) in [
            ("running", Some(false), "writing"),
            ("running", Some(true), "published"),
            ("succeeded", None, "writing"),
            ("cancelled", None, "published"),
        ] {
            assert!(ensure_output_status(state, lease, out.into()).is_err());
        }
    }
    #[test]
    fn successful_early_eof_cannot_publish_a_completed_movie() {
        let value = json!({"kind":durable::KIND,"recipe_version":1,"source_kind":"native_platform_private","negotiated_mode":"transcode","tracks":[{"key":"progressive","ticket":"a".repeat(64),"total_bytes":100,"strong_etag":"\"e\""}],"output_ticket":"b".repeat(64),"duration_seconds":10.0,"start_seconds":0.0,"deadline_ms":1,"estimated_output_bytes":100});
        let mut snapshot=persistence::media_outputs::Snapshot{manifest:"#EXTM3U\n#EXTINF:4,\nindex0.m4s\n#EXTINF:4,\nindex1.m4s\n#EXTINF:2,\nindex2.m4s\n#EXT-X-ENDLIST\n".into(),segment_count:3,files:vec![]};
        assert!(validate_completed(&value, &snapshot).is_ok());
        snapshot.manifest = "#EXTM3U\n#EXTINF:4,\nindex0.m4s\n#EXT-X-ENDLIST\n".into();
        snapshot.segment_count = 1;
        assert!(validate_completed(&value, &snapshot).is_err());
    }
    #[test]
    fn split_recipe_keeps_two_loopback_inputs_and_only_fixed_audio_mapping() {
        use media_core::advanced_media::DeviceObservation;
        let id = Uuid::nil();
        let input = format!(
            "http://127.0.0.1:8081/native-platform-input/{id}/video?ticket={}&owner={id}&attempt=1&execution={id}",
            "a".repeat(64)
        );
        let audio = input
            .replace("/video?", "/audio?")
            .replace(&"a".repeat(64), &"c".repeat(64));
        let meta = json!({"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"pix_fmt":"yuv420p","color_transfer":"bt709","disposition":{"attached_pic":0}},{"index":1,"codec_type":"audio","codec_name":"aac"}],"format":{"start_time":0.0}});
        let recipe = Recipe::from_probe(
            &meta,
            Some(1),
            5.0,
            &Request::default(),
            EncoderSelection::software_recipe(),
        )
        .unwrap();
        let inventory = Inventory::from_reports(
            " V....D libx264 encoder\n A..... aac encoder",
            " ... null V->V\n ... scale V->V\n ... setsar V->V\n ... pad V->V\n ... format V->V",
            "",
            "ffmpeg version fixture",
            DeviceObservation {
                nvenc_device_present: false,
                vaapi_render_node: None,
                qsv_render_node: None,
            },
        )
        .unwrap();
        let spec=durable::validate_spec(&json!({"kind":durable::KIND,"recipe_version":1,"source_kind":"native_platform_private","negotiated_mode":"transcode","tracks":[{"key":"video","ticket":"a".repeat(64),"total_bytes":100,"strong_etag":"\"v\""},{"key":"audio","ticket":"c".repeat(64),"total_bytes":100,"strong_etag":"\"a\""}],"output_ticket":"b".repeat(64),"duration_seconds":20.0,"start_seconds":5.0,"deadline_ms":1,"estimated_output_bytes":100})).unwrap();
        let args = constrained_args(
            &recipe,
            &spec,
            &input,
            Some(&audio),
            FsPath::new("/fixture/1/index.m3u8"),
            &inventory,
        )
        .unwrap();
        assert_eq!(args.iter().filter(|v| *v == "-i").count(), 2);
        assert!(args.windows(2).any(|p| p == ["-map", "1:0"]));
        assert!(!args.iter().any(|v| v == "0:1"));
        assert_eq!(
            args.windows(2)
                .filter(|p| p[0] == "-protocol_whitelist" && p[1] == "http,tcp")
                .count(),
            2
        );
        assert!(args.windows(2).any(|p| p == ["-t", "15"]));
        assert!(
            constrained_args(
                &recipe,
                &spec,
                &input,
                Some("https://example.invalid/private"),
                FsPath::new("/fixture/1/index.m3u8"),
                &inventory
            )
            .is_err()
        );
    }
    #[test]
    fn native_decoder_does_not_inherit_service_secrets() {
        let mut command = tokio::process::Command::new("never-executed-fixture");
        clean_native_environment(&mut command);
        for key in [
            "DATABASE_URL",
            "SOURCE_ENCRYPTION_KEY",
            "ADMIN_PASSWORD",
            "SERVER_INTERNAL_URL",
        ] {
            assert!(
                command
                    .as_std()
                    .get_envs()
                    .any(|(name, value)| name == key && value.is_none())
            );
        }
    }
    #[test]
    fn full_original_inventory_and_hevc_sar_are_closed() {
        let spec=durable::validate_spec(&json!({"kind":durable::KIND,"recipe_version":1,"source_kind":"native_platform_private","negotiated_mode":"transcode","tracks":[{"key":"progressive","ticket":"a".repeat(64),"total_bytes":100,"strong_etag":"\"e\""}],"output_ticket":"b".repeat(64),"duration_seconds":10.0,"start_seconds":0.0,"deadline_ms":1,"estimated_output_bytes":100})).unwrap();
        let mut meta = json!({"format":{"duration":"10.0","start_time":"0.0"},"streams":[{"index":0,"codec_type":"video","codec_name":"hevc","sample_aspect_ratio":"1:1","profile":"Main","pix_fmt":"yuv420p","field_order":"progressive","width":1920,"height":1080,"color_transfer":"bt709","color_primaries":"bt709","color_space":"bt709","color_range":"tv"},{"index":1,"codec_type":"audio","codec_name":"aac"}]});
        assert!(checked_metadata(&meta, &spec, "progressive").is_ok());
        meta["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("sample_aspect_ratio");
        assert!(checked_metadata(&meta, &spec, "progressive").is_err());
        meta["streams"][0]["sample_aspect_ratio"] = json!("2:1");
        assert!(checked_metadata(&meta, &spec, "progressive").is_err());
        meta["streams"][0]["sample_aspect_ratio"] = json!("1:1");
        for (field, value) in [
            ("profile", "Main 10"),
            ("pix_fmt", "yuv420p10le"),
            ("field_order", "tt"),
        ] {
            let mut changed = meta.clone();
            changed["streams"][0][field] = json!(value);
            assert!(checked_metadata(&changed, &spec, "progressive").is_err());
            let mut missing = meta.clone();
            missing["streams"][0].as_object_mut().unwrap().remove(field);
            assert!(checked_metadata(&missing, &spec, "progressive").is_err());
        }
        meta["streams"]
            .as_array_mut()
            .unwrap()
            .push(json!({"index":2,"codec_type":"data","codec_tag_string":"encv"}));
        assert!(checked_metadata(&meta, &spec, "progressive").is_err());
    }
}
